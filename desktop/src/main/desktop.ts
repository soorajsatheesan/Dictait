import { app, BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import type { Section } from '@shared/types'
import type { Coordinator } from './coordinator'
import { saveSettings } from './settings'


/** The main window: Notes, Graph, Vocabulary and Settings. Closing it keeps dictation running. */
export class DesktopWindow {
  private window: BrowserWindow | null = null
  private loaded = false
  private pendingSection: Section | null = null
  onPolicyChanged: () => void = () => {}

  constructor(private model: Coordinator, private preload: string, private rendererURL: string | undefined, private rendererDir: string) {}

  get isVisible(): boolean { return Boolean(this.window?.isVisible()) }
  get webContents(): Electron.WebContents | undefined { return this.window?.webContents }

  show(section?: Section): void {
    if (!this.window || this.window.isDestroyed()) this.create(section)
    else {
      if (section) {
        if (this.loaded) this.window.webContents.send('navigate', section)
        else this.pendingSection = section
      }
      this.model.refreshPermissions()
      if (this.loaded) this.window.webContents.send('archive:changed')
      if (this.window.isMinimized()) this.window.restore()
      // Move the existing window onto the user's current Space instead of jumping Spaces.
      this.window.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true })
      this.window.show()
      this.window.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true })
    }
    app.setActivationPolicy('regular')
    this.onPolicyChanged()
    app.focus({ steal: true })
  }

  private create(section?: Section): void {
    this.loaded = false
    this.pendingSection = null
    const saved = this.model.stored.windowBounds
    const onScreen = saved && screen.getAllDisplays().some(({ workArea: area }) =>
      saved.x < area.x + area.width - 80 && saved.x + saved.width > area.x + 80 && saved.y >= area.y - 10 && saved.y < area.y + area.height - 80)
    const window = new BrowserWindow({
      width: 1180, height: 780, minWidth: 940, minHeight: 620, ...(onScreen ? saved : {}),
      show: false, title: 'Dictait', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 22 },
      // Clear, so macOS vibrancy shows through the sidebar; the content paints its own ground.
      backgroundColor: '#00000000', vibrancy: 'sidebar', visualEffectState: 'followWindow',
      webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, spellcheck: true }
    })
    this.window = window
    window.once('ready-to-show', () => window.show())
    window.webContents.on('did-finish-load', () => {
      this.loaded = true
      if (this.pendingSection) {
        window.webContents.send('navigate', this.pendingSection)
        this.pendingSection = null
      }
    })
    // Refresh Microphone/Accessibility status as soon as the user returns from System Settings.
    window.on('focus', () => {
      this.model.refreshPermissions()
      if (this.loaded && !window.isDestroyed()) window.webContents.send('archive:changed')
    })
    window.on('close', () => {
      this.model.stored.windowBounds = window.getNormalBounds()
      saveSettings(this.model.stored)
    })
    window.on('closed', () => {
      this.model.stopMicrophoneTest()
      this.loaded = false
      this.pendingSection = null
      this.window = null
      app.setActivationPolicy('accessory')
      this.onPolicyChanged()
    })
    // Links in notes open in the user's browser, never inside Dictait.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    window.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(this.rendererURL ?? 'file:')) event.preventDefault()
    })
    const query = section ? { section } : undefined
    if (this.rendererURL) void window.loadURL(`${this.rendererURL}/index.html${section ? `?section=${section}` : ''}`)
    else void window.loadFile(join(this.rendererDir, 'index.html'), { query })
  }

  /** When Dictait itself is the active app, report whether one of its text fields has focus. */
  async focusedTextField(): Promise<boolean | null> {
    const focused = BrowserWindow.getFocusedWindow()
    if (!focused || focused !== this.window) return null
    try {
      return Boolean(await focused.webContents.executeJavaScript(
        "(() => { const e = document.activeElement; return !!e && (e.matches('input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea') || e.isContentEditable) })()"))
    } catch { return null }
  }

  refreshIfVisible(): void {
    if (this.isVisible && this.loaded) this.window?.webContents.send('archive:changed')
  }

  async practiceFocused(): Promise<boolean> {
    if (BrowserWindow.getFocusedWindow() !== this.window || !this.window) return false
    try {
      return Boolean(await this.window.webContents.executeJavaScript("document.activeElement?.matches('textarea[data-practice=true]') === true"))
    } catch { return false }
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, ...args)
  }

}
