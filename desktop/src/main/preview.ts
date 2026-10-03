import { app, BrowserWindow, nativeTheme } from 'electron'
import { writeFileSync } from 'node:fs'
import type { HudKind, HudState } from '@shared/types'
import { HUD_SIZE } from './hud'

interface Locations { preload: string; rendererDir: string; rendererURL: string | undefined }

const hudCopy: Record<HudKind, [string, string]> = {
  recording: ['Listening', ''], microphone: ['Allow microphone', 'Choose Allow in the prompt'],
  transcribing: ['Transcribing', 'On this Mac'], cleaning: ['Polishing', 'Grammar & flow'], preparing: ['Warming up', 'Loading local models'],
  done: ['Pasted', ''], copied: ['Copied', 'Press ⌘V to paste'], cancelled: ['Cancelled', ''],
  empty: ['Didn’t catch that', 'Try again a little closer'], failed: ['Needs attention', 'The model worker stopped. Click Retry to reload models.'], info: ['Ready', '']
}

/**
 * Diagnostics: render a screen with synthetic notes, without starting models or shortcuts.
 * Usage: Dictait --preview notes|graph|vocabulary|settings|hud:<kind> output.png [light|dark] [notch|flat|scroll=<px>]
 */
export async function runPreview(args: string[], where: Locations): Promise<void> {
  const [target = 'notes', output = 'preview.png', theme = 'light', shape = 'notch'] = args
  nativeTheme.themeSource = theme === 'dark' ? 'dark' : 'light'
  const hud = target.startsWith('hud:')
  const window = new BrowserWindow({
    ...(hud ? HUD_SIZE : { width: 1180, height: 780 }), show: false, frame: !hud, transparent: hud,
    titleBarStyle: hud ? undefined : 'hiddenInset', trafficLightPosition: { x: 20, y: 22 },
    backgroundColor: hud ? '#00000000' : theme === 'dark' ? '#0E0F11' : '#F6F6F7',
    webPreferences: { preload: where.preload, sandbox: true, contextIsolation: true, additionalArguments: ['--dictait-preview'] }
  })
  const page = hud ? 'hud.html' : 'index.html'
  const query: Record<string, string> = hud ? { backdrop: theme } : { section: target }
  const loaded = new Promise<void>((resolve) => window.webContents.once('did-finish-load', () => resolve()))
  if (where.rendererURL) await window.loadURL(`${where.rendererURL}/${page}?${new URLSearchParams(query)}`)
  else await window.loadFile(`${where.rendererDir}/${page}`, { query })
  await loaded
  if (hud) {
    const kind = target.slice(4) as HudKind
    const [title, detail] = hudCopy[kind] ?? hudCopy.info
    const state: HudState = {
      visible: true, kind, title, detail, startedAt: Date.now() - 12_000, holding: false, editing: false,
      note: '', live: kind === 'recording' ? 'so the plan is to ship the preview build on Friday and then' : '',
      screen: shape === 'flat' ? { hasNotch: false, notchWidth: 0, notchHeight: 0 } : { hasNotch: true, notchWidth: 179, notchHeight: 32 }
    }
    window.webContents.send('hud', state)
  }
  await new Promise((resolve) => setTimeout(resolve, hud ? 2600 : 1600))
  const scroll = /^scroll=(\d+)$/.exec(shape)
  if (scroll) {
    await window.webContents.executeJavaScript(`document.querySelector('.scroll-area')?.scrollTo(0, ${Number(scroll[1])})`)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  const image = await window.webContents.capturePage()
  writeFileSync(output, image.toPNG())
  console.log(`Rendered ${target} (${theme}) to ${output}`)
  window.destroy()
  app.quit()
}
