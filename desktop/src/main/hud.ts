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
  private rendererReady: (() => void) | null = null
  private tracking: NodeJS.Timeout | null = null
  private positioning = false
  private dismissal: NodeJS.Timeout | null = null
  private retract: NodeJS.Timeout | null = null
  private visible = false
  private processingAt: number | null = null
  private reveal: NodeJS.Timeout | null = null
  private nextRequest = 0
  private screens: NativeScreen[] = []
  private custom: { kind: HudKind; title: string; detail: string } | null = null
  private state: HudState = {
    visible: false, kind: 'info', title: '', detail: '', startedAt: null, screen: { hasNotch: false, notchWidth: 0, notchHeight: 0 },
    live: '', note: '', holding: false, holdStartedAt: null, editing: false, destination: null, microphone: '', micQuiet: false
  }
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; requestId: number }>()
  private cleanups: (() => void)[] = []

  constructor(private model: Coordinator, private preload: string, private rendererURL: string | undefined, private rendererDir: string) {
    const onIpc = (channel: string, listener: (...args: any[]) => void) => {
      ipcMain.on(channel, listener)
      this.cleanups.push(() => ipcMain.removeListener?.(channel, listener))
    }
    onIpc('hud:ready', (event: Electron.IpcMainEvent) => {
      if (event.sender !== this.window?.webContents) return
      this.send()
      this.rendererReady?.()
      this.rendererReady = null
    })
    onIpc('hud:hidden', (event: Electron.IpcMainEvent) => {
      if (event.sender !== this.window?.webContents || this.visible) return
      if (this.retract) { clearTimeout(this.retract); this.retract = null }
      this.window?.hide()
    })
    // Live words, tips and the hold state change while the phase stays the same.
    const onLive = () => { if (this.visible && !this.custom) this.send() }
    model.on('live', onLive)
    this.cleanups.push(() => model.removeListener?.('live', onLive))
    onIpc('recorder:started', (event: Electron.IpcMainEvent, device: string, requestId: number) => {
      if (event.sender !== this.window?.webContents) return
      if (this.settle(event.sender, 'start', null, requestId)) this.model.setMicrophoneDevice(typeof device === 'string' ? device : '')
    })
    onIpc('recorder:failed', (event: Electron.IpcMainEvent, message: string, requestId: number) => this.settle(event.sender, 'start', new Error(String(message)), requestId))
    onIpc('recorder:data', (event: Electron.IpcMainEvent, audio: ArrayBuffer | null, requestId: number) => this.settle(event.sender, 'stop', audio ? Buffer.from(audio) : null, requestId))
    onIpc('recorder:piece', (event: Electron.IpcMainEvent, audio: ArrayBuffer, index: number) => {
      if (event.sender === this.window?.webContents && audio) this.model.piece(Buffer.from(audio), Number(index) || 0)
    })
    onIpc('recorder:ended', (event: Electron.IpcMainEvent) => { if (event.sender === this.window?.webContents) this.model.microphoneEnded() })
    onIpc('recorder:level', (event: Electron.IpcMainEvent, level: number) => {
      if (event.sender === this.window?.webContents && Number.isFinite(level)) this.model.acceptLevel(level)
    })
    const refresh = () => this.loadScreens()
    screen.on('display-added', refresh)
    screen.on('display-removed', refresh)
    screen.on('display-metrics-changed', refresh)
    this.cleanups.push(
      () => screen.removeListener?.('display-added', refresh),
      () => screen.removeListener?.('display-removed', refresh),
      () => screen.removeListener?.('display-metrics-changed', refresh)
    )
    this.loadScreens()
  }

  /** Create the renderer early so the microphone opens instantly on the first shortcut. */
  prepare(): Promise<void> {
    if (this.ready) return this.ready
    const window = new BrowserWindow({
      ...HUD_SIZE, show: false, type: 'panel', frame: false, transparent: true, backgroundColor: '#00000000',
      hasShadow: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      focusable: false, skipTaskbar: true, hiddenInMissionControl: true, roundedCorners: false, alwaysOnTop: true, title: 'Dictait recording indicator',
      webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, backgroundThrottling: false, spellcheck: false }
    })
    window.setIgnoreMouseEvents(true)
    window.setAlwaysOnTop(true, 'screen-saver', 1)
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    window.setContentProtection(false)
    this.window = window
    // Wait for the React subscriber, rather than losing the first state before it mounts.
    this.ready = new Promise((resolve) => { this.rendererReady = resolve })
    if (this.rendererURL) void window.loadURL(`${this.rendererURL}/hud.html`)
    else void window.loadFile(join(this.rendererDir, 'hud.html'))
    return this.ready
  }

  /** Re-assert cross-Space / fullscreen-auxiliary behavior after activation-policy changes. */
  reapplyWorkspacePolicy(): void {
    const window = this.window
    if (!window || window.isDestroyed()) return
    window.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true })
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    window.setAlwaysOnTop(true, 'screen-saver', 1)
  }

  get isVisible(): boolean { return this.visible }

  /** Show a brief standalone message in the island (e.g., shortcut feedback when window is closed). */
  notify(title: string, detail: string, kind: HudKind = 'info', duration = 3500): void {
    if (['recording', 'transcribing', 'cleaning', 'requestingMicrophone'].includes(this.model.state.phase)) return
    if (this.dismissal) clearTimeout(this.dismissal)
    this.custom = { kind, title, detail }
    this.show()
    this.dismissal = setTimeout(() => { this.custom = null; this.hide() }, duration)
  }

  update(requested = false): void {
    this.custom = null
    if (this.dismissal) clearTimeout(this.dismissal)
    this.dismissal = null
    const { phase } = this.model.state
    if (phase === 'transcribing' || phase === 'cleaning') {
      if (this.processingAt === null) this.processingAt = Date.now()
      if (this.reveal) clearTimeout(this.reveal)
      const remaining = 180 - (Date.now() - this.processingAt)
      if (remaining > 0) this.reveal = setTimeout(() => { this.reveal = null; this.show() }, remaining)
      else this.show()
      return
    }
    this.processingAt = null
    if (this.reveal) { clearTimeout(this.reveal); this.reveal = null }
    switch (phase) {
      case 'recording': case 'requestingMicrophone':
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
        this.dismissal = setTimeout(() => this.hide(), kind === 'copied' ? 6500 : lingering ? 6000 : 2000)
        break
      }
    }
  }

  private content(): { kind: HudKind; title: string; detail: string } {
    if (this.custom) return this.custom
    const { phase, message } = this.model.state
    switch (phase) {
      case 'recording': return { kind: 'recording', title: this.model.live.editing ? 'Editing selection' : 'Listening', detail: '' }
      case 'requestingMicrophone': return { kind: 'microphone', title: 'Allow microphone', detail: 'Choose Allow in the prompt' }
      case 'transcribing': case 'cleaning': {
        const elapsed = Math.floor((Date.now() - (this.processingAt ?? Date.now())) / 1000)
        return { kind: 'transcribing', title: elapsed < 1 ? 'Finishing your dictation' : phase === 'cleaning'
          ? this.model.live.editing ? 'Rewriting your selection' : 'Polishing your words' : 'Turning speech into text',
          detail: elapsed >= 8 ? `Still working on this Mac · ${elapsed}s` : 'On this Mac' }
      }
      case 'preparing': return { kind: 'preparing', title: 'Warming up', detail: 'Loading local models' }
      case 'failed': return { kind: 'failed', title: 'Needs attention', detail: message }
      case 'ready':
        if (/^(Pasted[., ]|Replaced\.|Updated your last dictation\.)/.test(message)) {
          const app = this.model.live.deliveredTo?.appName
          return { kind: 'done', title: app ? `${message.startsWith('Replaced') || message.startsWith('Updated') ? 'Rewritten in' : 'Pasted into'} ${app}` : 'Paste sent',
            detail: '⌃⌥V pastes your last dictation again' }
        }
        if (message.startsWith('Selection unchanged')) return { kind: 'empty', title: 'Selection unchanged', detail: message.replace(/^Selection unchanged\.?\s*/, '') || 'Try the instruction again' }
        if (message.startsWith('Copied') || message.includes('new version is on the clipboard')) return {
          kind: 'copied', title: 'Copied · ready to paste', detail: 'Focus a text box, then ⌘V · ⌃⌥V repeats the last dictation'
        }
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
      // Detach from any previous Space if a retract animation had not yet called hide().
      if (window.isVisible()) window.hide()
      // Cycle collection behavior so macOS joins the active Space/fullscreen Space reliably
      // even after activation-policy transitions by the main window.
      window.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true })
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
      window.setAlwaysOnTop(true, 'screen-saver', 1)
      this.place(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()))
      // Show without activating or calling moveTop(), which can pull Space ownership on macOS.
      window.showInactive()
    }
    this.visible = true
    if (!this.tracking) this.tracking = setInterval(() => void this.followFocus(), 400)
    void this.followFocus()
    this.send()
  }

  private place(display: Display): void {
    this.state.screen = this.describe(display)
    const { bounds } = display
    const next = { x: Math.round(bounds.x + (bounds.width - HUD_SIZE.width) / 2), y: Math.round(bounds.y), ...HUD_SIZE }
    const previous = this.window?.getBounds()
    if (!previous || previous.x !== next.x || previous.y !== next.y) this.window?.setBounds(next)
  }

  private async followFocus(): Promise<void> {
    if (this.positioning || !this.visible) return
    this.positioning = true
    try {
      const { bounds, destination } = await this.model.helper.activeWindow()
      if (!this.visible) return
      if (bounds) {
        const rect = { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) }
        if (rect.width > 0 && rect.height > 0) this.place(screen.getDisplayMatching(rect))
      } else {
        this.place(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()))
      }
      if (['recording', 'transcribing', 'cleaning'].includes(this.model.state.phase)) this.model.setDestination(destination)
      if (this.window && !this.window.isDestroyed() && !this.window.isVisible()) {
        this.window.showInactive()
      }
      this.send()
    } catch {
      // Never leak unhandled rejections if display metrics or helper replies transiently fail.
    } finally {
      this.positioning = false
    }
  }

  hide(): void {
    if (this.dismissal) clearTimeout(this.dismissal)
    this.dismissal = null
    if (!this.visible) return
    this.visible = false
    if (this.tracking) clearInterval(this.tracking)
    this.tracking = null
    this.send() // The renderer retracts the island, then reports hud:hidden.
    // Safety net if the retract animation never reports back.
    this.retract = setTimeout(() => { if (!this.visible) this.window?.hide() }, 1500)
  }

  private send(): void {
    if (!this.window || this.window.isDestroyed()) return
    if (this.processingAt !== null && Date.now() - this.processingAt < 180 && this.visible) return
    const content = this.content()
    const { live, note, holding, holdStartedAt, editing, microphone, micQuiet, destination, deliveredTo } = this.model.live
    this.state = { ...this.state, ...content, visible: this.visible, startedAt: this.model.state.recordingStartedAt, live, note, holding, holdStartedAt, editing,
      microphone, micQuiet, destination: this.model.state.phase === 'ready' ? deliveredTo : destination }
    this.window.webContents.send('hud', this.state)
  }

  private loadScreens(): void {
    execFile(paths.helper, ['screens'], { timeout: 2000 }, (error, stdout) => {
      if (error) return
      try {
        this.screens = JSON.parse(stdout)
        if (this.visible) {
          this.place(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()))
          this.send()
        }
      } catch { /* keep the previous geometry */ }
    })
  }

  private describe(display: Display): HudScreen {
    const { bounds } = display
    const native = this.screens.find((item) =>
      Math.abs(item.x - bounds.x) < 2 && Math.abs(item.y - bounds.y) < 2 &&
      Math.abs(item.width - bounds.width) < 2 && Math.abs(item.height - bounds.height) < 2)
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
    const previous = this.pending.get(key)
    if (previous) { clearTimeout(previous.timer); previous.reject(new Error('Superseded.')) }
    const requestId = ++this.nextRequest
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(key); reject(new Error('The microphone did not respond. Try again.')) }, timeout)
      this.pending.set(key, { resolve: resolve as (value: unknown) => void, reject, timer, requestId })
      this.command(command, { ...options, requestId })
    })
  }

  private settle(sender: Electron.WebContents, key: string, value: unknown, requestId: number): boolean {
    if (sender !== this.window?.webContents) return false
    const pending = this.pending.get(key)
    if (!pending || pending.requestId !== requestId) return false
    this.pending.delete(key)
    clearTimeout(pending.timer)
    if (value instanceof Error) pending.reject(value)
    else pending.resolve(value)
    return true
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
    if (this.reveal) clearTimeout(this.reveal)
    if (this.dismissal) clearTimeout(this.dismissal)
    if (this.retract) clearTimeout(this.retract)
    if (this.tracking) clearInterval(this.tracking)
    for (const [, waiter] of this.pending) { clearTimeout(waiter.timer); waiter.reject(new Error('Destroyed.')) }
    this.pending.clear()
    for (const off of this.cleanups) off()
    this.cleanups = []
    this.window?.destroy()
    this.window = null
  }
}
