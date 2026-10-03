import { BrowserWindow, ipcMain, screen, type Display } from 'electron'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { HudKind, HudScreen, HudState, RecorderCommand, RecorderOptions } from '@shared/types'
import type { Coordinator, RecorderBridge } from './coordinator'
import { paths } from './paths'

/** Transparent canvas the island morphs inside; it never takes clicks or focus. */
export const HUD_SIZE = { width: 520, height: 180 }

interface NativeScreen { x: number; y: number; width: number; height: number; notchWidth: number; notchHeight: number; menuBarHeight: number }

/**
 * The recording indicator: a black island that grows out of the camera notch
 * (or the top edge on displays without one). It must never move the text cursor.
 */
export class RecordingHUD implements RecorderBridge {
  private window: BrowserWindow | null = null
  private ready: Promise<void> | null = null
  private dismissal: NodeJS.Timeout | null = null
  private retract: NodeJS.Timeout | null = null
  private visible = false
  private screens: NativeScreen[] = []
  private state: HudState = {
    visible: false, kind: 'info', title: '', detail: '', startedAt: null, screen: { hasNotch: false, notchWidth: 0, notchHeight: 0 },
    live: '', note: '', holding: false, editing: false
  }
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()

  constructor(private model: Coordinator, private preload: string, private rendererURL: string | undefined, private rendererDir: string) {
    ipcMain.on('hud:hidden', (event) => {
      if (event.sender !== this.window?.webContents || this.visible) return
      this.window?.hide()
    })
    // Live words, tips and the hold state change while the phase stays the same.
    model.on('live', () => { if (this.visible) this.send() })
    ipcMain.on('recorder:started', (event) => this.settle(event.sender, 'start', null))
    ipcMain.on('recorder:failed', (event, message: string) => this.settle(event.sender, 'start', new Error(String(message))))
    ipcMain.on('recorder:data', (event, audio: ArrayBuffer | null) => this.settle(event.sender, 'stop', audio ? Buffer.from(audio) : null))
    ipcMain.on('recorder:piece', (event, audio: ArrayBuffer, index: number) => {
      if (event.sender === this.window?.webContents && audio) this.model.piece(Buffer.from(audio), Number(index) || 0)
    })
    ipcMain.on('recorder:ended', (event) => { if (event.sender === this.window?.webContents) this.model.microphoneEnded() })
    ipcMain.on('recorder:level', (event, level: number) => {
      if (event.sender === this.window?.webContents && Number.isFinite(level)) this.model.emit('level', level)
    })
    const refresh = () => this.loadScreens()
    screen.on('display-added', refresh)
    screen.on('display-removed', refresh)
    screen.on('display-metrics-changed', refresh)
    this.loadScreens()
  }

  /** Create the renderer early so the microphone opens instantly on the first shortcut. */
  prepare(): Promise<void> {
    if (this.ready) return this.ready
    const window = new BrowserWindow({
      ...HUD_SIZE, show: false, type: 'panel', frame: false, transparent: true, backgroundColor: '#00000000',
      hasShadow: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      focusable: false, skipTaskbar: true, roundedCorners: false, alwaysOnTop: true, title: 'Dictait recording indicator',
      webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, backgroundThrottling: false, spellcheck: false }
    })
    window.setIgnoreMouseEvents(true)
    window.setAlwaysOnTop(true, 'screen-saver')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    window.setContentProtection(false)
    this.window = window
    this.ready = new Promise((resolve) => {
      window.webContents.once('did-finish-load', () => { this.send(); resolve() })
    })
    if (this.rendererURL) void window.loadURL(`${this.rendererURL}/hud.html`)
    else void window.loadFile(join(this.rendererDir, 'hud.html'))
    return this.ready
  }

  get isVisible(): boolean { return this.visible }

  update(requested = false): void {
    if (this.dismissal) clearTimeout(this.dismissal)
    this.dismissal = null
    const { phase } = this.model.state
    switch (phase) {
      case 'recording': case 'requestingMicrophone': case 'transcribing': case 'cleaning':
        this.show()
        break
      case 'preparing':
        if (requested || this.visible) this.show()
        break
      case 'ready': case 'failed': {
        if (!requested && !this.visible) return
        this.show()
        const { kind } = this.content()
        const lingering = kind === 'failed' || kind === 'empty' || !this.model.state.microphoneAllowed
        this.dismissal = setTimeout(() => this.hide(), lingering ? 5000 : 1400)
        break
      }
    }
  }

  private content(): { kind: HudKind; title: string; detail: string } {
    const { phase, message } = this.model.state
    switch (phase) {
      case 'recording': return { kind: 'recording', title: this.model.live.editing ? 'Editing selection' : 'Listening', detail: '' }
      case 'requestingMicrophone': return { kind: 'microphone', title: 'Allow microphone', detail: 'Choose Allow in the prompt' }
      case 'transcribing': return { kind: 'transcribing', title: 'Transcribing', detail: 'On this Mac' }
      case 'cleaning':
        if (this.model.live.editing) return { kind: 'cleaning', title: 'Rewriting', detail: 'Your selection' }
        return { kind: 'cleaning', title: 'Polishing', detail: this.model.live.appName ? `For ${this.model.live.appName}` : 'Grammar & flow' }
      case 'preparing': return { kind: 'preparing', title: 'Warming up', detail: 'Loading local models' }
      case 'failed': return { kind: 'failed', title: 'Needs attention', detail: message }
      case 'ready':
        if (message.startsWith('Pasted.')) return { kind: 'done', title: 'Pasted', detail: '' }
        if (message.startsWith('Replaced.')) return { kind: 'done', title: 'Rewritten', detail: '' }
        if (message.startsWith('Selection unchanged')) return { kind: 'empty', title: 'Selection unchanged', detail: message.replace(/^Selection unchanged\.?\s*/, '') || 'Try the instruction again' }
        if (message.startsWith('Copied.')) return { kind: 'copied', title: 'Copied', detail: message.includes('No text box') ? 'No text box in focus · ⌘V to paste' : 'Press ⌘V to paste' }
        if (message.startsWith('Recording cancelled.')) return { kind: 'cancelled', title: 'Cancelled', detail: '' }
        if (message.startsWith('No speech') || message.startsWith('No audio')) return { kind: 'empty', title: 'Didn’t catch that', detail: 'Try again a little closer' }
        if (message.startsWith('Enable Dictait')) return { kind: 'failed', title: 'Microphone is off', detail: 'Allow it in Privacy & Security' }
        return { kind: 'info', title: 'Ready', detail: message }
    }
  }

  private show(): void {
    const window = this.window
    if (!window) { void this.prepare().then(() => this.show()); return }
    if (this.retract) { clearTimeout(this.retract); this.retract = null }
    if (!this.visible) {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      this.state.screen = this.describe(display)
      const { bounds } = display
      window.setBounds({ x: Math.round(bounds.x + (bounds.width - HUD_SIZE.width) / 2), y: bounds.y, ...HUD_SIZE })
      // No focus or activation changes: paste stays in the user's app.
      window.showInactive()
    }
    this.visible = true
    this.send()
  }

  hide(): void {
    if (this.dismissal) clearTimeout(this.dismissal)
    this.dismissal = null
    if (!this.visible) return
    this.visible = false
    this.send() // The renderer retracts the island, then reports hud:hidden.
    // Safety net if the retract animation never reports back.
    this.retract = setTimeout(() => { if (!this.visible) this.window?.hide() }, 1500)
  }

  private send(): void {
    if (!this.window || this.window.isDestroyed()) return
    const content = this.content()
    const { live, note, holding, editing } = this.model.live
    this.state = { ...this.state, ...content, visible: this.visible, startedAt: this.model.state.recordingStartedAt, live, note, holding, editing }
    this.window.webContents.send('hud', this.state)
  }

  private loadScreens(): void {
    execFile(paths.helper, ['screens'], { timeout: 2000 }, (error, stdout) => {
      if (error) return
      try { this.screens = JSON.parse(stdout) } catch { /* keep the previous geometry */ }
    })
  }

  private describe(display: Display): HudScreen {
    const { bounds } = display
    const native = this.screens.find((item) => Math.abs(item.x - bounds.x) < 2 && Math.abs(item.width - bounds.width) < 2 && Math.abs(item.height - bounds.height) < 2)
    if (native && native.notchWidth > 0) return { hasNotch: true, notchWidth: native.notchWidth, notchHeight: native.notchHeight }
    // Without the helper, a tall menu bar on the built-in display implies a notch.
    const menuBar = display.workArea.y - bounds.y
    if (!native && display.internal && menuBar >= 32) return { hasNotch: true, notchWidth: 185, notchHeight: menuBar }
    return { hasNotch: false, notchWidth: 0, notchHeight: 0 }
  }

  // RecorderBridge: capture runs in the indicator's renderer with Web Audio.
  private command(command: RecorderCommand, options?: RecorderOptions): void {
    this.window?.webContents.send('recorder', command, options)
  }

  private request<T>(key: string, command: RecorderCommand, timeout: number, options?: RecorderOptions): Promise<T> {
    this.pending.get(key)?.reject(new Error('Superseded.'))
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(key); reject(new Error('The microphone did not respond. Try again.')) }, timeout)
      this.pending.set(key, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.command(command, options)
    })
  }

  private settle(sender: Electron.WebContents, key: string, value: unknown): void {
    if (sender !== this.window?.webContents) return
    const pending = this.pending.get(key)
    if (!pending) return
    this.pending.delete(key)
    clearTimeout(pending.timer)
    if (value instanceof Error) pending.reject(value)
    else pending.resolve(value)
  }

  async start(options: RecorderOptions): Promise<void> {
    await this.prepare()
    await this.request<void>('start', 'start', 5000, options)
  }

  async stop(): Promise<Buffer | null> {
    if (!this.window) return null
    return this.request<Buffer | null>('stop', 'stop', 5000)
  }

  cancel(): void {
    const pending = this.pending.get('start')
    if (pending) { clearTimeout(pending.timer); this.pending.delete('start'); pending.reject(new Error('Cancelled.')) }
    this.command('cancel')
  }

  destroy(): void {
    if (this.dismissal) clearTimeout(this.dismissal)
    this.window?.destroy()
    this.window = null
  }
}
