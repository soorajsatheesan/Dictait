import { app, ipcMain, Menu, nativeTheme, session, shell, type MenuItemConstructorOptions } from 'electron'
import { uptime } from 'node:os'
import { join } from 'node:path'
import type { Appearance, Section, Settings, Tones, VocabularyEntry } from '@shared/types'
import { readArchive } from './archive'
import { Coordinator, openPrivacy } from './coordinator'
import { DesktopWindow } from './desktop'
import { NativeHelper } from './helper'
import { RecordingHUD } from './hud'
import { execFile, execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { openFolder, paths, SUPPORT } from './paths'
import { runPreview } from './preview'
import { StatusMenu } from './tray'
import { appBundle, Updater } from './updater'

// Chromium's own state stays in a subfolder, apart from notes and vocabulary.
app.setPath('userData', join(SUPPORT, 'Desktop'))
app.setName('Dictait')

const preload = join(__dirname, '../preload/index.js')
const rendererDir = join(__dirname, '../renderer')
const rendererURL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const previewIndex = process.argv.indexOf('--preview')
const checkIndex = process.argv.indexOf('--check-hotkeys')

if (checkIndex >= 0) {
  void app.whenReady().then(() => checkHotkeys())
} else if (previewIndex < 0 && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void app.whenReady().then(() => (previewIndex >= 0 ? runPreview(process.argv.slice(previewIndex + 1), { preload, rendererDir, rendererURL }) : launch()))
}

/**
 * Diagnostics: confirm that shortcut presses and releases reach the native helper, through the
 * same path as dictation. A separate process presses and holds Control–Option–Shift–K like a keyboard.
 * Run through Launch Services so the app's Accessibility permission applies:
 *   open -n -a Dictait --args --check-hotkeys /tmp/dictait-hotkeys.json
 */
async function checkHotkeys(): Promise<void> {
  const output = process.argv[checkIndex + 1] ?? join(SUPPORT, 'hotkey-check.json')
  const helper = new NativeHelper()
  const events: string[] = []
  helper.on('hotkey', (_name: string, down: boolean) => events.push(down ? 'down' : 'up'))
  helper.start()
  // Control–Option–Shift–K: an ordinary key, like Space. (Synthetic function keys never match.)
  const registered = await helper.registerHotkeys([{ name: 'test', code: 40, modifiers: ['control', 'option', 'shift'] }])
  await new Promise<void>((resolve) => execFile(paths.helper, ['post-key', '40', 'control', 'option', 'shift'], { timeout: 5000 }, () => resolve()))
  await new Promise((resolve) => setTimeout(resolve, 300))
  writeFileSync(output, JSON.stringify({ registered: registered.test === true, events }))
  helper.stop()
  app.quit()
}

function launch(): void {
  app.setActivationPolicy('accessory')
  const model = new Coordinator()
  const desktop = new DesktopWindow(model, preload, rendererURL, rendererDir)
  const hud = new RecordingHUD(model, preload, rendererURL, rendererDir)
  const status = new StatusMenu(model, desktop)
  model.recorder = hud
  model.ownFocus = () => desktop.focusedTextField()
  applyAppearance(model.stored.appearance)

  // Only the indicator may use the microphone, and only while recording.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === 'media' && contents.getURL().includes('hud.html'))
  })
  session.defaultSession.setPermissionCheckHandler((contents, permission) => permission === 'media' && Boolean(contents?.getURL().includes('hud.html')))

  model.on('state', (state) => desktop.send('state', state))
  model.on('level', (level: number) => { if (desktop.isVisible) desktop.send('level', level) })
  model.on('phase', () => { hud.update(); status.update() })
  model.on('archive', () => desktop.refreshIfVisible())
  model.on('settings', (patch: Partial<Settings>) => { if (patch.appearance) applyAppearance(patch.appearance) })
  model.onToggleRequested = () => hud.update(true)

  const updater = new Updater((patch) => model.setUpdate(patch), () => model.stored.autoUpdate)
  registerIPC(model, desktop, updater)
  configureMenu(desktop)
  void hud.prepare()
  clearQuarantine()
  model.start()
  updater.start()
  model.promptAccessibilityOnce()
  status.update()

  app.on('second-instance', () => desktop.show())
  app.on('activate', () => desktop.show())
  app.on('window-all-closed', () => { /* Keep dictation available from the menu bar. */ })
  // The recording panel never closes on its own, which would cancel a quit, so tear it down first.
  app.on('before-quit', () => { model.shutdown(); hud.destroy() })
  process.on('SIGTERM', () => app.quit())

  // Login launches stay in the background; opening the app shows its window.
  const login = app.getLoginItemSettings()
  const atLogin = login.wasOpenedAtLogin || process.argv.includes('--background') || (app.isPackaged && uptime() < 150)
  if (!atLogin) desktop.show()
}

function applyAppearance(appearance: Appearance): void {
  nativeTheme.themeSource = appearance
}

/**
 * A copy downloaded in a browser carries macOS's quarantine flag on every file inside it. Once the
 * person has chosen Open Anyway, clear it from the whole bundle, so the speech engine Dictait starts
 * next is not stopped by Gatekeeper and nobody needs Terminal.
 */
function clearQuarantine(): void {
  if (!app.isPackaged) return
  const bundle = appBundle()
  try { execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', bundle], { stdio: 'ignore' }) } catch { return }
  try { execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', bundle], { stdio: 'ignore', timeout: 30_000 }) } catch { /* read-only location */ }
}

function registerIPC(model: Coordinator, desktop: DesktopWindow, updater: Updater): void {
  ipcMain.handle('state:get', () => model.state)
  ipcMain.handle('archive:read', () => readArchive())
  ipcMain.on('recording:toggle', () => model.toggleRecording())
  ipcMain.on('recording:cancel', () => model.cancelRecording())
  ipcMain.handle('settings:set', (_event, patch: Partial<Settings>) => model.setSettings(sanitize(patch)))
  ipcMain.handle('login:set', (_event, enabled: boolean) => model.setLaunchAtLogin(Boolean(enabled)))
  ipcMain.on('login:open', () => void shell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension'))
  ipcMain.on('shortcut:retry', () => void model.registerShortcut())
  ipcMain.on('permission:microphone', () => model.requestMicrophone())
  ipcMain.on('permission:accessibility', () => model.requestAccessibility())
  ipcMain.on('permission:open', (_event, anchor: string) => openPrivacy(String(anchor)))
  ipcMain.on('models:reload', () => model.reloadModels())
  ipcMain.handle('clipboard:copy', (_event, text: string) => model.copyText(String(text)))
  ipcMain.handle('correction:learn', () => model.learnCorrectionFromClipboard())
  ipcMain.handle('vocabulary:add', (_event, word: string, alias: string) => model.addWord(String(word ?? ''), String(alias ?? '')))
  ipcMain.handle('vocabulary:remove', (_event, id: string) => model.removeWord(String(id)))
  ipcMain.handle('vocabulary:restore', (_event, entry: VocabularyEntry, index: number) =>
    model.restoreWord({ id: String(entry.id), word: String(entry.word), alias: String(entry.alias ?? ''), learned: Boolean(entry.learned) }, Number(index) || 0))
  ipcMain.on('folder:open', (_event, which: 'notes' | 'memory') => openFolder(which === 'notes' ? 'notes' : 'memory'))
  ipcMain.handle('microphones:list', () => model.microphones())
  ipcMain.handle('vocabulary:suggestions', () => model.suggestions())
  ipcMain.handle('vocabulary:dismiss', (_event, word: string) => model.dismissSuggestion(String(word).slice(0, 100)))
  ipcMain.on('window:show', (_event, section?: Section) => desktop.show(section))
  ipcMain.handle('update:check', () => updater.check(false))
  ipcMain.on('update:install', () => void updater.install())
}

/** Accept only known settings with the right types from the renderer. */
function sanitize(patch: Partial<Settings>): Partial<Settings> {
  const clean: Partial<Settings> = {}
  const pick = <K extends keyof Settings>(key: K, valid: (value: unknown) => boolean) => {
    if (key in patch && valid(patch[key])) clean[key] = patch[key] as Settings[K]
  }
  const oneOf = (...values: string[]) => (value: unknown) => values.includes(value as string)
  const flag = (value: unknown) => typeof value === 'boolean'
  pick('backend', oneOf('whisper', 'parakeet'))
  pick('language', oneOf('auto', 'en', 'hi'))
  pick('memoryMode', oneOf('notes', 'terms', 'off'))
  pick('appearance', oneOf('system', 'light', 'dark'))
  pick('cleanup', flag); pick('autoPaste', flag); pick('smartFormatting', flag); pick('learnCorrections', flag)
  pick('setupDone', flag); pick('autoUpdate', flag)
  pick('useContext', flag); pick('voiceEdits', flag); pick('appTones', flag)
  pick('writingStyle', (value) => typeof value === 'string')
  pick('microphone', (value) => typeof value === 'string' && value.length <= 200)
  if (patch.tones && typeof patch.tones === 'object') {
    const tones: Partial<Tones> = {}
    for (const key of ['messaging', 'email', 'code', 'docs'] as const) {
      const value = (patch.tones as Partial<Tones>)[key]
      if (typeof value === 'string') tones[key] = value.slice(0, 300)
    }
    clean.tones = tones as Tones
  }
  return clean
}

function configureMenu(desktop: DesktopWindow): void {
  const go = (section: Section, accelerator: string): MenuItemConstructorOptions =>
    ({ label: section[0].toUpperCase() + section.slice(1), accelerator, click: () => desktop.show(section) })
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Dictait', submenu: [
        { role: 'about', label: 'About Dictait' },
        { type: 'separator' },
        { label: 'Open Dictait', accelerator: 'Cmd+O', click: () => desktop.show() },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => desktop.show('settings') },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit Dictait', accelerator: 'Cmd+Q', click: () => app.quit() }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View', submenu: [
        go('notes', 'Cmd+1'), go('graph', 'Cmd+2'), go('vocabulary', 'Cmd+3'), go('settings', 'Cmd+4'),
        { type: 'separator' },
        ...(app.isPackaged ? [] : [{ role: 'reload' } as const, { role: 'toggleDevTools' } as const, { type: 'separator' } as const]),
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
