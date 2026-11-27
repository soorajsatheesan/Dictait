import { app, clipboard, globalShortcut, shell, systemPreferences } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HOLD_TO_TALK_MS, MAX_DICTATION_SECONDS, type AppState, type HistoryEntry, type Microphone, type Phase, type RecorderOptions,
  type CorrectionDraft, type Destination, type Settings, type Suggestion, type Tones, type UpdateStatus, type VocabularyEntry, type WordResult
} from '@shared/types'
import { readArchive } from './archive'
import { NativeHelper, type FocusInfo } from './helper'
import { loadPersonal, newID, savePersonal, type Personalization } from './personal'
import { SUPPORT } from './paths'
import { loadSettings, saveSettings, type Stored } from './settings'
import { ModelWorker, type WorkerEvent } from './worker'

/** Audio capture lives in the indicator's renderer; the coordinator only drives it. */
export interface RecorderBridge {
  start(options: RecorderOptions): Promise<void>
  stop(): Promise<Buffer | null>
  cancel(): void
}

/** What the island shows besides the phase. */
export interface LiveState {
  live: string
  note: string
  holding: boolean
  holdStartedAt: number | null
  editing: boolean
  appName: string
  destination: Destination | null
  deliveredTo: Destination | null
  microphone: string
  micQuiet: boolean
}

const SPACE = 49, KEY_V = 9, KEY_L = 37

/** Valid 44-byte 16 kHz mono 16-bit PCM WAV with 0 samples, used to finalize an already-chunked session. */
function emptyWAV(): Buffer {
  const buffer = Buffer.alloc(44)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(16_000, 24)
  buffer.writeUInt32LE(32_000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(0, 40)
  return buffer
}

/** Which tone applies in which app, by bundle identifier. */
const toneApps: Record<keyof Tones, RegExp> = {
  ai: /^(com\.openai\.chat|com\.openai\.codex|com\.anthropic\.claudefordesktop|com\.t3tools\.t3code|com\.google\.GeminiMacOS|ai\.perplexity\.mac)$/,
  messaging: /^(com\.apple\.MobileSMS|com\.tinyspeck\.slackmacgap|net\.whatsapp\.WhatsApp|desktop\.WhatsApp|com\.hnc\.Discord|ru\.keepcoder\.Telegram|org\.telegram\.desktop|com\.facebook\.archon|com\.microsoft\.teams2?|us\.zoom\.xos|com\.apple\.iChat)$/,
  email: /^(com\.apple\.mail|com\.microsoft\.Outlook|com\.readdle\.smartemail-Mac|com\.superhuman\.electron|it\.bloop\.airmail2|com\.mimestream\.Mimestream)$/,
  code: /^(com\.microsoft\.VSCode|com\.todesktop\.230313mzl4w4u92|com\.apple\.dt\.Xcode|com\.jetbrains\..*|com\.apple\.Terminal|com\.googlecode\.iterm2|dev\.warp\.Warp-Stable|com\.sublimetext\.4|dev\.zed\.Zed|com\.exafunction\.windsurf|com\.mitchellh\.ghostty)$/,
  docs: /^(com\.apple\.Notes|notion\.id|md\.obsidian|com\.microsoft\.Word|com\.apple\.iWork\.Pages|com\.apple\.TextEdit|net\.shinyfrog\.bear|com\.craft\.craft|com\.ulyssesapp\.mac)$/
}

/** In a browser the tab decides, by its window title. */
const browsers = /^(com\.apple\.Safari|com\.google\.Chrome|com\.brave\.Browser|company\.thebrowser\.(Browser|dia)|org\.mozilla\.firefox|com\.microsoft\.edgemac|com\.operasoftware\.Opera|com\.vivaldi\.Vivaldi|ai\.perplexity\.comet)$/
const tabTitles: [keyof Tones, RegExp][] = [
  ['ai', /\b(ChatGPT|Claude|Gemini|Perplexity|Codex|T3 Chat|Grok|Copilot)\b/i],
  ['email', /\b(Gmail|Outlook|Proton Mail|Fastmail|Superhuman|Hey\.com)\b|\bInbox\b/i],
  ['messaging', /\b(Slack|WhatsApp|Discord|Messenger|Telegram|Microsoft Teams)\b/i],
  ['docs', /\b(Google Docs|Notion|Confluence|Coda|Dropbox Paper|Quip)\b/i]
]
/** A terminal running an AI coding agent: Claude Code marks its title with ✳. */
const agentTitles = /✳|\b(claude|codex|gemini|aider|opencode)\b/i

/** The kind of app the text is going into, for its tone and how Dictait writes there. */
export function appKind(bundle: string, title = ''): keyof Tones | '' {
  if (browsers.test(bundle)) return tabTitles.find(([, pattern]) => pattern.test(title))?.[0] ?? ''
  for (const [kind, pattern] of Object.entries(toneApps) as [keyof Tones, RegExp][]) {
    if (pattern.test(bundle)) return kind === 'code' && agentTitles.test(title) ? 'ai' : kind
  }
  return ''
}

/** "Hey, make that shorter" works on the last dictation for this long after it was pasted. */
const FOLLOW_UP_MS = 2 * 60 * 1000

export class Coordinator extends EventEmitter {
  stored: Stored = loadSettings()
  personal: Personalization = loadPersonal()
  state: AppState
  readonly live: LiveState = { live: '', note: '', holding: false, holdStartedAt: null, editing: false, appName: '',
    destination: null, deliveredTo: null, microphone: '', micQuiet: false }
  recorder: RecorderBridge | null = null
  onToggleRequested: () => void = () => {}
  onCorrectionRequested: () => void = () => {}
  onNotice: (title: string, detail: string) => void = () => {}
  /** Answers whether Dictait's own window has a text field in focus, when it is the active app. */
  ownFocus: () => Promise<boolean | null> = async () => null
  ownPractice: () => Promise<boolean> = async () => false
  readonly helper = new NativeHelper()
  private worker = new ModelWorker()
  private requestID: string | null = null
  private pendingAudio: string | null = null
  private watchdog: NodeJS.Timeout | null = null
  private ticker: NodeJS.Timeout | null = null
  private cleanupAvailable = false
  private lastToggle = 0
  private recordingToken = 0
  private deliveryToken = 0
  /** The worker session for the current recording; long dictations send pieces under it. */
  private session: string | null = null
  private pieces = 0
  private pieceFiles = new Set<string>()
  /** Recording-time context, selection and tone; delivery always uses the current focus. */
  private target: FocusInfo | null = null
  private targetReady: Promise<void> = Promise.resolve()
  private recorderStarting: Promise<void> = Promise.resolve()
  private pressedAt = 0
  private pressStarted = false
  private holdTimer: NodeJS.Timeout | null = null
  private bluetoothTipShown = false
  private practicing = false
  private audibleFrames = 0
  private micTestTimer: NodeJS.Timeout | null = null
  private micTestToken = 0
  private recordingWasHold = false
  /** The last dictation pasted where it started, for spoken follow-ups. */
  private lastPasted: { text: string; at: number } | null = null

  constructor() {
    super()
    this.state = {
      phase: 'preparing', message: 'Loading your local models…', notice: '', recordingStartedAt: null,
      transcript: '', timing: '', detectedLanguage: this.stored.detectedLanguage,
      microphoneAllowed: false, accessibilityAllowed: false, shortcutRegistered: false, correctionShortcutRegistered: false,
      launchAtLogin: false, loginNeedsApproval: false, rememberedTerms: 0,
      settings: this.settings, vocabulary: this.personal.vocabulary, history: [], download: null, version: app.getVersion(),
      update: { phase: 'idle', version: '', notes: '', progress: 0, error: '', checkedAt: null },
      correction: null, microphoneName: '', micTestActive: false, practiceCompleted: []
    }
  }

  get settings(): Settings {
    const { backend, language, cleanup, autoPaste, smartFormatting, writingStyle, memoryMode, learnCorrections, appearance,
      useContext, voiceEdits, appTones, tones, microphone, setupDone, autoUpdate, feedbackSounds } = this.stored
    return { backend, language, cleanup, autoPaste, smartFormatting, writingStyle, memoryMode, learnCorrections, appearance,
      useContext, voiceEdits, appTones, tones: { ...tones }, microphone, setupDone, autoUpdate, feedbackSounds }
  }

  start(): void {
    this.helper.on('hotkey', (name: string, down: boolean, focus: FocusInfo | null, at: number) => this.hotkey(name, down, focus, at))
    this.helper.on('disconnected', () => {
      this.pressedAt = 0
      this.pressStarted = false
      if (this.holdTimer) clearTimeout(this.holdTimer)
      this.setLive({ holding: false, holdStartedAt: null })
    })
    this.helper.on('hotkeys-registered', (registered: Record<string, boolean>) => this.applyHotkeyStatus(registered))
    this.helper.start()
    void this.registerShortcut()
    this.refreshPermissions()
    // Only a packaged app registers itself; a development build must not become a login item.
    if (app.isPackaged && !this.stored.configuredLogin) {
      this.setLaunchAtLogin(true)
      if (this.state.launchAtLogin || this.state.loginNeedsApproval) this.store({ configuredLogin: true })
    }
    this.worker.onEvent = (event) => this.handle(event)
    this.reloadModels()
  }

  /** Surface a short HUD notification from non-window triggers (tray or failed shortcut). */
  notify(title: string, detail: string): void {
    this.onNotice(title, detail)
  }

  /** The updater reports here, so the window and the menu show the same status. */
  setUpdate(patch: Partial<UpdateStatus>): void {
    this.update({ update: { ...this.state.update, ...patch } })
  }

  private update(patch: Partial<AppState>): void {
    Object.assign(this.state, patch)
    this.emit('state', this.state)
  }

  private setLive(patch: Partial<LiveState>): void {
    Object.assign(this.live, patch)
    this.emit('live')
  }

  setDestination(destination: Destination | null): void {
    const previous = this.live.destination
    if (previous?.app === destination?.app && previous?.appName === destination?.appName && previous?.editable === destination?.editable && previous?.icon === destination?.icon) return
    this.setLive({ destination })
  }

  private store(patch: Partial<Stored>): void {
    Object.assign(this.stored, patch)
    saveSettings(this.stored)
  }

  setPhase(phase: Phase, message: string): void {
    if (phase !== 'recording' && globalShortcut.isRegistered('Escape')) globalShortcut.unregister('Escape')
    this.state.phase = phase
    this.state.message = message
    this.writeDiagnostics()
    this.emit('state', this.state)
    this.emit('phase')
  }

  private writeDiagnostics(): void {
    // Local troubleshooting only: never include audio, dictated text or app destinations.
    const values = {
      accessibility_allowed: this.state.accessibilityAllowed, backend: this.stored.backend, cleanup_ready: this.cleanupAvailable,
      launch_at_login: this.state.launchAtLogin, login_needs_approval: this.state.loginNeedsApproval,
      memory_mode: this.stored.memoryMode, microphone_allowed: this.state.microphoneAllowed, phase: this.state.phase,
      remembered_terms: this.state.rememberedTerms, shortcut_registered: this.state.shortcutRegistered,
      correction_shortcut_registered: this.state.correctionShortcutRegistered, microphone_test_active: this.state.micTestActive
    }
    try {
      mkdirSync(SUPPORT, { recursive: true })
      writeFileSync(join(SUPPORT, 'status.json'), JSON.stringify(values, null, 2))
    } catch { /* diagnostics are best effort */ }
  }

  // MARK: Shortcuts

  /** Control–Space (tap or hold) and Control–Option–V, through the native helper; Electron as a fallback. */
  async registerShortcut(): Promise<void> {
    for (const accelerator of ['Control+Space', 'Control+Alt+V', 'Control+Alt+L']) {
      if (globalShortcut.isRegistered(accelerator)) globalShortcut.unregister(accelerator)
    }
    const registered = await this.helper.registerHotkeys([
      { name: 'dictate', code: SPACE, modifiers: ['control'] },
      { name: 'pasteLast', code: KEY_V, modifiers: ['control', 'option'] },
      { name: 'learnCorrection', code: KEY_L, modifiers: ['control', 'option'] }
    ])
    // If the native helper is unavailable (empty reply) or missed a shortcut, register Electron fallbacks.
    if (!('dictate' in registered)) globalShortcut.register('Control+Space', () => this.toggleRecording())
    if (!registered.pasteLast && !('pasteLast' in registered)) globalShortcut.register('Control+Alt+V', () => void this.pasteLast())
    if (!registered.learnCorrection && !('learnCorrection' in registered)) globalShortcut.register('Control+Alt+L', () => void this.previewCorrection(null, true))
    this.applyHotkeyStatus(registered)
  }

  private applyHotkeyStatus(registered: Record<string, boolean>): void {
    const ok = registered.dictate === true || globalShortcut.isRegistered('Control+Space')
    let notice = this.state.notice
    if (!ok) notice = 'Control–Space is in use. In Keyboard → Keyboard Shortcuts → Input Sources, disable or change that shortcut, then click Retry shortcut.'
    else if (notice.startsWith('Control–Space is in use')) notice = ''
    this.update({ shortcutRegistered: ok, notice, correctionShortcutRegistered: registered.learnCorrection === true || globalShortcut.isRegistered('Control+Alt+L') })
    this.writeDiagnostics()
  }

  /** Tap to start, tap to finish; or hold while talking and let go to finish. */
  private hotkey(name: string, down: boolean, focus: FocusInfo | null = null, at = Date.now()): void {
    if (name === 'pasteLast') { if (down) void this.pasteLast(); return }
    if (name === 'learnCorrection') { if (down) void this.previewCorrection(focus, true); return }
    if (name !== 'dictate') return
    if (down) {
      // Ignore key auto-repeat until release; recover if a missed key-up left pressedAt stale while idle.
      if (this.pressedAt && !(this.state.phase === 'ready' && at - this.pressedAt > 15_000)) return
      this.pressedAt = at
      this.pressStarted = false
      this.onToggleRequested()
      if (this.state.phase === 'recording') { void this.stopRecording(); return }
      if (this.state.phase !== 'ready') return
      this.pressStarted = true
      this.toggleRecording(true, focus)
      this.setLive({ holdStartedAt: this.pressedAt })
      if (this.holdTimer) clearTimeout(this.holdTimer)
      this.holdTimer = setTimeout(() => {
        if (this.pressStarted && this.state.phase === 'recording') { this.recordingWasHold = true; this.setLive({ holding: true }) }
      }, Math.max(0, HOLD_TO_TALK_MS - (Date.now() - this.pressedAt)))
      return
    }
    if (this.holdTimer) clearTimeout(this.holdTimer)
    const held = this.pressedAt > 0 && at - this.pressedAt >= HOLD_TO_TALK_MS
    if (this.pressStarted && held) this.recordingWasHold = true
    this.pressedAt = 0
    if (this.pressStarted && held && this.state.phase === 'recording') void this.stopRecording()
    this.pressStarted = false
    this.setLive({ holding: false, holdStartedAt: null })
  }

  reloadModels(): void {
    if (['recording', 'transcribing', 'cleaning', 'requestingMicrophone'].includes(this.state.phase)) return
    this.deliveryToken++
    this.clearWatchdog()
    this.setPhase('preparing', 'Preparing local models. The first download can take a few minutes.')
    try {
      this.worker.start(this.stored.backend, this.stored.cleanup)
    } catch (error) {
      this.setPhase('failed', (error as Error).message)
    }
  }

  /** From the menu, the window or the shortcut. `fromHotkey` skips the repeat guard (the helper debounces). */
  toggleRecording(fromHotkey = false, focus: FocusInfo | null = null): void {
    // Key auto-repeat and double clicks must not start and stop in the same breath.
    const now = Date.now()
    if (!fromHotkey && now - this.lastToggle < 250) return
    this.lastToggle = now
    if (!fromHotkey) this.onToggleRequested()
    if (this.state.phase === 'recording') { void this.stopRecording(); return }
    if (this.state.phase !== 'ready') return
    this.personal = loadPersonal()
    this.update({ notice: '', vocabulary: this.personal.vocabulary })
    this.refreshPermissions()
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'not-determined') {
      this.setPhase('requestingMicrophone', 'Choose Allow in the microphone prompt, then speak.')
      void systemPreferences.askForMediaAccess('microphone').then((granted) => {
        this.update({ microphoneAllowed: granted })
        if (granted) void this.beginRecording(focus)
        else this.setPhase('ready', 'Enable Dictait in System Settings → Privacy & Security → Microphone.')
      }).catch(() => {
        this.setPhase('ready', 'Could not request microphone permission. Allow Dictait in Privacy & Security → Microphone.')
      })
    } else if (status === 'granted') {
      void this.beginRecording(focus)
    } else {
      this.setPhase('ready', 'Enable Dictait in System Settings → Privacy & Security → Microphone.')
      this.requestMicrophone()
    }
  }

  // MARK: Recording

  private async beginRecording(captured: FocusInfo | null = null): Promise<void> {
    this.stopMicrophoneTest()
    const token = ++this.recordingToken
    const startedAt = Date.now()
    this.session = randomUUID()
    this.pieces = 0
    this.target = null
    this.practicing = false
    this.audibleFrames = 0
    this.recordingWasHold = false
    // Capture before showing the panel. Native shortcut events already carry their snapshot.
    const focus = captured ? Promise.resolve(captured) : this.helper.focus()
    this.targetReady = this.inspectTarget(focus, token)
    this.setLive({ live: '', note: '', holding: false, holdStartedAt: null, editing: false, appName: '',
      deliveredTo: null, microphone: '', micQuiet: false })
    this.state.recordingStartedAt = startedAt
    this.setPhase('recording', 'Control–Space to finish. Escape to cancel.')
    globalShortcut.register('Escape', () => this.cancelRecording())
    if (this.stored.feedbackSounds) playSound('Tink')
    // Look at where the user is while the microphone opens; neither waits for the other.
    try {
      if (!this.recorder) throw new Error('The recorder is not ready yet.')
      this.recorderStarting = (async () => {
        const device = await this.chooseMicrophone()
        if (token !== this.recordingToken) return
        await this.recorder!.start({ device })
      })()
      await this.recorderStarting
    } catch (error) {
      if (token !== this.recordingToken || this.state.phase !== 'recording') return
      this.endRecordingSession()
      this.setPhase('ready', (error as Error).message || 'Could not start the microphone. Check your input device in System Settings → Sound.')
      shell.beep()
      return
    }
    await this.targetReady
    if (token !== this.recordingToken || this.state.phase !== 'recording') return
    this.ticker = setInterval(() => {
      if (Date.now() - startedAt >= 6000 && this.audibleFrames < 3 && !this.live.micQuiet) this.setLive({ micQuiet: true })
      if (Date.now() - startedAt >= MAX_DICTATION_SECONDS * 1000) void this.stopRecording()
    }, 250)
  }

  /** Context before the cursor, the selection (for voice edits) and the app (for tone). */
  private async inspectTarget(focus: Promise<FocusInfo | null>, token: number): Promise<void> {
    const [target, practicing] = await Promise.all([focus, this.ownPractice()])
    if (token !== this.recordingToken) return
    this.practicing = practicing
    if (!target || token !== this.recordingToken) return
    this.target = target
    const editing = this.stored.voiceEdits && target.editable === true && !target.secure && target.selected.trim().length > 0
    this.setLive({ editing, appName: target.appName })
  }

  /** "auto" keeps Bluetooth headsets in high-quality playback by using another microphone. */
  private async chooseMicrophone(): Promise<string | null> {
    const choice = this.stored.microphone
    if (choice === 'system') {
      const devices = await this.helper.inputs()
      const current = devices.find((device) => device.default)
      if (current?.transport === 'bluetooth' && !this.bluetoothTipShown) {
        this.bluetoothTipShown = true
        this.setLive({ note: `${current.name} records in lower quality over Bluetooth` })
      }
      return null
    }
    const devices = await this.helper.inputs()
    if (choice !== 'auto') return devices.some((device) => device.name === choice) ? choice : null
    const current = devices.find((device) => device.default)
    if (current?.transport !== 'bluetooth') return null
    const better = devices.find((device) => device.transport === 'builtin') ?? devices.find((device) => device.transport === 'usb')
    if (!better) return null
    this.setLive({ note: `Using ${better.name} so ${current.name} keeps full sound` })
    return better.name
  }

  async microphones(): Promise<Microphone[]> {
    return (await this.helper.inputs()).filter((device) => device.transport !== 'virtual' || device.default)
  }

  setMicrophoneDevice(name: string): void {
    const microphone = name.slice(0, 200) || 'macOS default microphone'
    this.update({ microphoneName: microphone })
    this.setLive({ microphone })
  }

  acceptLevel(level: number): void {
    const value = Math.max(0, Math.min(1, level))
    if (this.state.phase === 'recording' && value >= 0.15) {
      this.audibleFrames++
      if (this.audibleFrames >= 3 && this.live.micQuiet) this.setLive({ micQuiet: false })
    }
    this.emit('level', value)
  }

  /** A short, level-only check: the recorder never buffers or transcribes test audio. */
  async startMicrophoneTest(): Promise<WordResult> {
    if (this.state.phase !== 'ready' || this.state.micTestActive || !this.recorder) return { ok: false, feedback: 'Finish your current dictation before testing the microphone.' }
    if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      this.requestMicrophone()
      return { ok: false, feedback: 'Allow microphone access, then try the mic test again.' }
    }
    const token = ++this.micTestToken
    this.update({ micTestActive: true })
    this.writeDiagnostics()
    try {
      this.recorderStarting = (async () => {
        const device = await this.chooseMicrophone()
        if (token !== this.micTestToken) return
        await this.recorder!.start({ device, monitor: true })
      })()
      await this.recorderStarting
      if (token === this.micTestToken) {
        this.micTestTimer = setTimeout(() => this.stopMicrophoneTest(), 15_000)
      }
      return { ok: token === this.micTestToken, feedback: token === this.micTestToken ? 'Speak to check the level. The test stops after 15 seconds.' : 'Microphone test stopped.' }
    } catch (error) {
      if (token !== this.micTestToken) return { ok: false, feedback: 'Microphone test stopped.' }
      this.stopMicrophoneTest()
      return { ok: false, feedback: (error as Error).message }
    }
  }

  stopMicrophoneTest(): void {
    if (!this.state.micTestActive) return
    this.micTestToken++
    if (this.micTestTimer) clearTimeout(this.micTestTimer)
    this.micTestTimer = null
    this.recorder?.cancel()
    this.update({ micTestActive: false })
    this.writeDiagnostics()
    this.emit('level', 0)
  }

  private endRecordingSession(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    if (this.holdTimer) clearTimeout(this.holdTimer)
    if (globalShortcut.isRegistered('Escape')) globalShortcut.unregister('Escape')
    this.state.recordingStartedAt = null
    this.pressStarted = false
    this.setLive({ holding: false, holdStartedAt: null, micQuiet: false })
    this.emit('level', 0)
  }

  cancelRecording(): void {
    if (this.state.phase !== 'recording') return
    this.recordingToken++
    this.endRecordingSession()
    this.recorder?.cancel()
    this.discardSession()
    this.deletePendingAudio()
    this.setPhase('ready', 'Recording cancelled. Control–Space to try again.')
  }

  private discardSession(): void {
    if (this.session && this.pieces) { try { this.worker.send({ command: 'discard', id: this.session }) } catch { /* worker gone */ } }
    this.session = null
    this.pieces = 0
  }

  /** A finished piece of speech, cut at a pause: transcribe it now, while the user keeps talking. */
  piece(audio: Buffer, index: number): void {
    if (!this.session || audio.length <= 44) return
    const file = join(tmpdir(), `dictait-${randomUUID()}.wav`)
    try {
      writeFileSync(file, audio, { mode: 0o600 })
      this.pieceFiles.add(file)
      this.worker.send({ command: 'chunk', id: this.session, index, path: file, ...this.requestOptions() })
      this.pieces++
    } catch (error) {
      this.update({ notice: `Part of a dictation could not be processed: ${(error as Error).message}` })
    }
  }

  private requestOptions(): Record<string, unknown> {
    const { language, cleanup, memoryMode, smartFormatting, writingStyle, learnCorrections, useContext } = this.stored
    const target = this.target
    const kind = target && this.stored.appTones ? appKind(target.app, target.window) : ''
    const tone = kind ? this.stored.tones[kind] : ''
    const style = [writingStyle.slice(0, 300), tone && `In ${target?.appName}: ${tone}`].filter(Boolean).join('\n')
    const last = this.lastPasted && Date.now() - this.lastPasted.at < FOLLOW_UP_MS ? this.lastPasted.text : ''
    return {
      language, cleanup: cleanup && this.cleanupAvailable,
      vocabulary: this.personal.vocabulary.map(({ word, alias }) => ({ word, alias })),
      memory: this.practicing ? 'off' : memoryMode, smart_formatting: smartFormatting, writing_style: style,
      examples: learnCorrections ? this.personal.examples.map(({ original, corrected }) => ({ original, corrected })) : [],
      // Text before the cursor never leaves this Mac and is never saved.
      context: useContext && target?.editable && !target.secure ? target.before.slice(-500) : '',
      selection: this.live.editing && target ? target.selected.slice(0, 6000) : '',
      app_kind: kind,
      // Only for "hey, make that shorter"; never saved.
      previous_output: this.practicing ? '' : last.slice(0, 6000)
    }
  }

  /** The input device vanished mid-recording. */
  microphoneEnded(): void {
    if (this.state.micTestActive) {
      this.stopMicrophoneTest()
      this.update({ notice: 'The microphone disconnected. Choose another input and test again.' })
      return
    }
    if (this.state.phase !== 'recording') return
    this.cancelRecording()
    this.update({ notice: 'The microphone disconnected. Check your input device and try again.' })
  }

  private async stopRecording(): Promise<void> {
    if (this.state.phase !== 'recording') return
    this.endRecordingSession()
    this.setPhase('transcribing', this.live.editing ? 'Understanding your instruction…' : 'Turning speech into text on this Mac…')
    // A quick second tap can arrive while the microphone or focus snapshot is opening.
    try { await this.recorderStarting } catch { /* stop reports no audio below */ }
    await this.targetReady
    this.recordingToken++
    let audio: Buffer | null = null
    try { audio = (await this.recorder?.stop()) ?? null } catch { audio = null }
    if (this.stored.feedbackSounds) playSound('Pop')
    // Pieces cut during the stop flush have arrived by now; IPC keeps its order.
    const id = this.session ?? randomUUID(), pieces = this.pieces
    this.session = null
    this.pieces = 0
    // If the final tail failed/timed out after earlier pieces already streamed, still finalize those pieces!
    if (!audio && pieces > 0) {
      audio = emptyWAV()
    }
    if (!audio || (audio.length <= 44 && !pieces)) {
      this.deletePendingAudio()
      this.setPhase('ready', 'No audio recorded. Try again.')
      return
    }
    const file = join(tmpdir(), `dictait-${randomUUID()}.wav`)
    try { writeFileSync(file, audio, { mode: 0o600 }) } catch (error) {
      if (pieces) { try { this.worker.send({ command: 'discard', id }) } catch { /* worker gone */ } }
      this.deletePendingAudio()
      this.setPhase('failed', `Could not save the recording: ${(error as Error).message}`)
      return
    }
    this.pendingAudio = file
    this.requestID = id
    try {
      this.worker.send({ command: 'transcribe', id, path: file, ...this.requestOptions() })
      this.watchdog = setTimeout(() => {
        if (this.requestID !== id) return
        this.deletePendingAudio()
        this.requestID = null
        this.worker.stop()
        this.setPhase('failed', 'Transcription took too long. Click Retry to reload the models.')
      }, 180_000)
    } catch (error) {
      this.deletePendingAudio()
      this.requestID = null
      this.setPhase('failed', (error as Error).message)
    }
  }

  private handle(event: WorkerEvent): void {
    switch (event.event) {
      case 'status':
        this.update({ message: typeof event.message === 'string' ? event.message : this.state.message })
        break
      case 'download':
        // First launch: the models arriving, byte by byte.
        if (typeof event.done === 'number' && typeof event.total === 'number') {
          this.update({ download: { model: String(event.model ?? 'models'), done: event.done, total: event.total } })
        }
        break
      case 'ready': {
        this.cleanupAvailable = Boolean(event.cleanup)
        const memory = event.memory as { terms?: number } | undefined
        this.update({ notice: typeof event.warning === 'string' ? event.warning : this.state.notice, rememberedTerms: memory?.terms ?? 0, download: null })
        this.setPhase('ready', 'Control–Space to start. Press again to finish.')
        break
      }
      case 'partial':
        // Words so far, while still speaking (or finishing).
        if ((event.id === this.session || event.id === this.requestID) && typeof event.text === 'string') this.setLive({ live: event.text })
        break
      case 'transcribed':
        if (event.id !== this.requestID) return
        if (typeof event.raw === 'string' && event.raw) this.setLive({ live: event.raw.slice(-400) })
        if (this.stored.cleanup && this.cleanupAvailable && event.raw) {
          this.setPhase('cleaning', this.live.editing ? 'Rewriting your selection…' : 'Organizing your words…')
        }
        break
      case 'result': {
        if (event.id !== this.requestID) return
        this.clearWatchdog()
        this.requestID = null
        this.deletePendingAudio()
        const text = typeof event.text === 'string' ? event.text : ''
        const edit = event.mode === 'edit'
        const warning = typeof event.warning === 'string' ? event.warning : ''
        if (event.mode === 'followup') { void this.followUp(text, warning); return }
        if (!text) {
          this.setPhase('ready', edit ? `Selection unchanged. ${warning}`.trim()
            : 'No speech detected. Move closer to the microphone and try again.')
          return
        }
        const followed = Number(event.instructions ?? 0)
        const detected = typeof event.language === 'string' && event.language ? event.language : this.state.detectedLanguage
        if (detected !== this.stored.detectedLanguage) this.store({ detectedLanguage: detected })
        const total = Number(event.total_ms ?? 0) / 1000, stt = Number(event.stt_ms ?? 0) / 1000
        this.update({
          transcript: text, detectedLanguage: detected, history: this.historyAfter(text),
          timing: `${total.toFixed(2)} s total · ${stt.toFixed(2)} s transcription`,
          notice: warning
        })
        if (this.practicing) {
          const lesson: AppState['practiceCompleted'][number] = edit ? 'edit' : this.recordingWasHold ? 'hold' : 'tap'
          this.update({ practiceCompleted: [...new Set([...this.state.practiceCompleted, lesson])] })
        }
        const delivery = ++this.deliveryToken
        void this.deliver(text).then((outcome) => {
          if (delivery !== this.deliveryToken || this.state.phase === 'failed') return
          if (this.stored.autoPaste && !this.state.accessibilityAllowed) {
            this.update({ notice: 'Enable Dictait in Privacy & Security → Accessibility to paste automatically. Your text is on the clipboard.' })
          }
          const done = edit ? 'Replaced.' : followed ? `Pasted, following your instruction${followed > 1 ? 's' : ''}.` : 'Pasted.'
          this.setPhase('ready', outcome === 'pasted' ? `${done} Control–Space to dictate again.`
            : outcome === 'no-target' ? 'Copied. No text box is focused, so press Command–V where you want it.'
              : 'Copied. Press Command–V to paste.')
          this.emit('archive')
        }).catch(async () => {
          if (delivery !== this.deliveryToken || this.state.phase === 'failed') return
          try { await this.copyText(text) } catch { /* clipboard unavailable */ }
          this.setPhase('ready', 'Copied. Press Command–V to paste.')
          this.emit('archive')
        })
        break
      }
      case 'error':
        if (typeof event.id === 'string' && event.id !== this.requestID) return
        this.deliveryToken++
        this.clearWatchdog()
        this.requestID = null
        if (this.state.phase === 'recording') { this.recordingToken++; this.endRecordingSession(); this.recorder?.cancel(); this.discardSession() }
        this.deletePendingAudio()
        this.setPhase('failed', typeof event.message === 'string' ? event.message : 'Something went wrong. Click Retry.')
        shell.beep()
        break
      case 'memory':
        this.update({ rememberedTerms: typeof event.terms === 'number' ? event.terms : this.state.rememberedTerms })
        this.writeDiagnostics()
        this.emit('archive')
        break
      case 'chunk':
        if (typeof event.error === 'string') this.update({ notice: `Part of a dictation could not be transcribed: ${event.error}` })
        break
      case 'memory_warning':
        this.update({ notice: typeof event.message === 'string' ? event.message : 'Could not update local memory.' })
        break
    }
  }

  // MARK: Delivery

  private historyAfter(text: string): HistoryEntry[] {
    if (!text.trim()) return this.state.history
    return [{ text, at: Date.now(), app: this.target?.appName ?? '' }, ...this.state.history].slice(0, 10)
  }

  async copyText(text = this.state.transcript): Promise<void> {
    if (text) await clipboard.writeText(text)
  }

  async deliver(text: string, explicit = false): Promise<'pasted' | 'copied' | 'no-target'> {
    this.lastPasted = null
    this.setLive({ deliveredTo: null })
    if (!this.stored.autoPaste && !explicit) {
      await this.copyText(text)
      return 'copied'
    }
    const trusted = systemPreferences.isTrustedAccessibilityClient(false)
    this.update({ accessibilityAllowed: trusted })
    if (!trusted) {
      await this.copyText(text)
      return 'copied'
    }
    // Nothing to type into: leave the words on the clipboard instead of pasting into thin air.
    if ((await this.focusTarget()) === 'none') {
      await this.copyText(text)
      return 'no-target'
    }
    // Let the native helper snapshot the clipboard, write `text`, paste, and restore the user's
    // prior clipboard after verified delivery. If delivery fails, fall back to keeping it copied.
    const outcome = await this.helper.deliver(text)
    if (outcome === 'pasted') {
      this.lastPasted = { text, at: Date.now() }
      this.setLive({ deliveredTo: this.helper.lastDeliveryDestination ?? null })
      return 'pasted'
    }
    await this.copyText(text)
    return outcome === 'no-target' ? 'no-target' : 'copied'
  }

  private deliveryStale(token: number): boolean {
    return token !== this.deliveryToken || this.state.phase === 'failed'
  }

  /** "Hey, make that shorter": the last dictation, rewritten in place if it is untouched. */
  private async followUp(text: string, warning: string): Promise<void> {
    const delivery = ++this.deliveryToken
    this.setLive({ deliveredTo: null })
    const last = this.lastPasted
    if (!text || !last) {
      this.setPhase('ready', warning || 'Nothing recent to apply that to. Dictate the text and the instruction together.')
      return
    }
    this.update({ transcript: text, notice: '', history: this.historyAfter(text) })
    try {
      const outcome = this.stored.autoPaste && systemPreferences.isTrustedAccessibilityClient(false)
        ? await this.helper.replaceLast(last.text, text) : 'untrusted'
      if (this.deliveryStale(delivery)) return
      if (outcome === 'replaced') {
        this.lastPasted = { text, at: Date.now() }
        this.setLive({ deliveredTo: this.helper.lastDeliveryDestination ?? null })
      }
      if (outcome === 'gone') {
        const delivered = await this.deliver(text)
        if (this.deliveryStale(delivery)) return
        this.setPhase('ready', delivered === 'pasted' ? 'Pasted at your current cursor. Control–Space to dictate again.'
          : 'Copied the new version. Press Command–V where you want it.')
        this.emit('archive')
        return
      }
      if (outcome !== 'replaced') await this.copyText(text)
      this.setPhase('ready', outcome === 'replaced' ? 'Updated your last dictation. Control–Space to dictate again.'
        : outcome === 'changed' ? 'That text has changed since, so the new version is on the clipboard. Press Command–V to use it.'
          : 'Copied the new version. Press Command–V where you want it.')
      this.emit('archive')
    } catch {
      if (this.deliveryStale(delivery)) return
      try { await this.copyText(text) } catch { /* clipboard unavailable */ }
      this.setPhase('ready', 'Copied the new version. Press Command–V where you want it.')
      this.emit('archive')
    }
  }

  /** 'none' only when we are confident no editable text has focus; unknown cases still paste. */
  private async focusTarget(): Promise<'text' | 'none' | 'unknown'> {
    const own = await this.ownFocus()
    if (own !== null) return own ? 'text' : 'none'
    const focus = await this.helper.focus()
    return focus?.editable === true ? 'text' : focus?.editable === false ? 'none' : 'unknown'
  }

  /** Control–Option–V or the menu: put a recent dictation where the cursor is. */
  async pasteLast(index = 0): Promise<void> {
    if (this.state.phase !== 'ready') return
    const entry = this.state.history[index]
    if (!entry) { shell.beep(); return }
    const outcome = await this.deliver(entry.text, true)
    if (outcome !== 'pasted') this.update({ notice: 'Copied your dictation. Press Command–V where you want it.' })
    this.setPhase('ready', outcome === 'pasted' ? 'Pasted. Your last dictation is at your current cursor.' : 'Copied. Focus a text box, then press Command–V.')
    this.onToggleRequested()
  }

  // MARK: Permissions and settings

  refreshPermissions(): void {
    const login = app.getLoginItemSettings()
    this.update({
      microphoneAllowed: systemPreferences.getMediaAccessStatus('microphone') === 'granted',
      accessibilityAllowed: systemPreferences.isTrustedAccessibilityClient(false),
      launchAtLogin: login.status ? login.status === 'enabled' : login.openAtLogin,
      loginNeedsApproval: login.status === 'requires-approval'
    })
    this.writeDiagnostics()
  }

  requestMicrophone(): void {
    if (systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') {
      void systemPreferences.askForMediaAccess('microphone').then(() => this.refreshPermissions())
    } else {
      openPrivacy('Privacy_Microphone')
    }
  }

  requestAccessibility(): void {
    const trusted = systemPreferences.isTrustedAccessibilityClient(true)
    this.update({ accessibilityAllowed: trusted })
    if (!trusted) openPrivacy('Privacy_Accessibility')
  }

  promptAccessibilityOnce(): void {
    // macOS alone can grant this permission. Prompt once.
    if (this.stored.autoPaste && !systemPreferences.isTrustedAccessibilityClient(false) && !this.stored.promptedAccessibility) {
      this.store({ promptedAccessibility: true })
      systemPreferences.isTrustedAccessibilityClient(true)
    }
  }

  setLaunchAtLogin(enabled: boolean): void {
    try {
      app.setLoginItemSettings({ openAtLogin: enabled })
      this.store({ configuredLogin: true })
    } catch (error) {
      this.update({ notice: `Could not change launch at login: ${(error as Error).message}` })
    }
    this.refreshPermissions()
  }

  setSettings(patch: Partial<Settings>): void {
    const reload = (patch.backend !== undefined && patch.backend !== this.stored.backend) ||
      (patch.cleanup !== undefined && patch.cleanup !== this.stored.cleanup)
    if (patch.writingStyle !== undefined) patch.writingStyle = patch.writingStyle.slice(0, 300)
    if (patch.tones) patch.tones = { ...this.stored.tones, ...patch.tones }
    if (patch.backend === 'parakeet' && this.stored.language === 'hi') patch.language = 'auto'
    this.store(patch)
    this.update({ settings: this.settings })
    this.emit('settings', patch)
    if (patch.autoPaste && !systemPreferences.isTrustedAccessibilityClient(false)) this.requestAccessibility()
    if (reload) this.reloadModels()
  }

  // MARK: Learning

  /** Clipboard learning also goes through review; nothing is stored until confirmation. */
  async learnCorrectionFromClipboard(): Promise<string> {
    const corrected = (await clipboard.readText()).trim()
    return this.openCorrectionPreview(corrected, false).feedback
  }

  /** Select corrected text in any app and press Control–Option–L. */
  async previewCorrection(captured: FocusInfo | null = null, fromShortcut = false): Promise<WordResult> {
    if (this.state.phase !== 'ready') {
      const feedback = 'Finish dictating before reviewing a correction.'
      if (fromShortcut) { this.onNotice('Finish dictating first', feedback); shell.beep() }
      return { ok: false, feedback }
    }
    const focus = captured ?? await this.helper.focus()
    const corrected = focus && !focus.secure ? focus.selected.trim() : ''
    return this.openCorrectionPreview(corrected, fromShortcut)
  }

  private openCorrectionPreview(corrected: string, fromShortcut: boolean): WordResult {
    const fail = (message: string): WordResult => {
      this.update({ notice: message })
      if (fromShortcut) { this.onNotice('Nothing to review', message); shell.beep() }
      return { ok: false, feedback: message }
    }
    if (this.state.phase !== 'ready') return fail('Finish dictating before reviewing a correction.')
    if (!this.state.transcript) return fail('Dictate a sentence first, then select your corrected version and press Control–Option–L.')
    if (!corrected) return fail('Select your corrected dictation and press Control–Option–L, or copy it and use Review from clipboard in Settings.')
    if (corrected === this.state.transcript.trim()) return fail('Nothing changed, so there is nothing to learn.')
    if (corrected.length > 1000) return fail('Review a shorter correction, up to 1,000 characters.')
    this.stopMicrophoneTest()
    this.update({ correction: { id: newID(), original: this.state.transcript.slice(0, 1000), corrected }, notice: '' })
    this.onCorrectionRequested()
    return { ok: true, feedback: 'Review the correction before saving it.' }
  }

  saveCorrection(value: unknown): WordResult {
    const draft = value as Partial<CorrectionDraft> | null
    if (!draft || draft.id !== this.state.correction?.id || typeof draft.original !== 'string' || typeof draft.corrected !== 'string') {
      return { ok: false, feedback: 'This correction has expired. Select the corrected text and try again.' }
    }
    const original = draft.original.trim(), corrected = draft.corrected.trim()
    if (!original || !corrected || original.length > 1000 || corrected.length > 1000) return { ok: false, feedback: 'Use between 1 and 1,000 characters in each version.' }
    if (original === corrected) return { ok: false, feedback: 'The two versions are identical.' }
    const personal = loadPersonal()
    personal.examples = [...personal.examples.filter((entry) => entry.original !== original || entry.corrected !== corrected), { id: newID(), original, corrected }].slice(-10)
    try { savePersonal(personal) } catch { return { ok: false, feedback: 'Could not save this correction. Try again.' } }
    this.personal = personal
    if (!this.stored.learnCorrections) this.setSettings({ learnCorrections: true })
    this.update({ correction: null, notice: '' })
    return { ok: true, feedback: 'Correction saved on this Mac. Future grammar cleanup will use it.' }
  }

  dismissCorrection(): void {
    this.update({ correction: null })
  }

  /**
   * Words worth adding to the vocabulary: names fixed in saved corrections (with what was
   * heard instead), and names and terms that keep coming up in notes.
   */
  async suggestions(): Promise<Suggestion[]> {
    const known = new Set(this.personal.vocabulary.flatMap((entry) => [entry.word.toLowerCase(), entry.alias.toLowerCase()]))
    const dismissed = new Set(this.stored.dismissedSuggestions)
    const seen = new Set<string>()
    const result: Suggestion[] = []
    const offer = (word: string, alias: string, reason: string) => {
      const key = word.toLowerCase()
      if (!word || known.has(key) || dismissed.has(key) || seen.has(key)) return
      seen.add(key)
      result.push({ word, alias, reason })
    }
    for (const example of this.personal.examples.slice().reverse()) {
      for (const [heard, written] of changedWords(example.original, example.corrected)) offer(written, heard, 'From your correction')
    }
    try {
      const archive = await readArchive()
      for (const term of archive.terms) {
        if (term.mentions >= 2 && ['person', 'project', 'organization', 'technical'].includes(term.kind)) {
          offer(term.name, '', `Said ${term.mentions} times`)
        }
      }
    } catch { /* suggestions are optional */ }
    return result.slice(0, 8)
  }

  dismissSuggestion(word: string): void {
    this.store({ dismissedSuggestions: [...new Set([...this.stored.dismissedSuggestions, word.toLowerCase()])].slice(-500) })
  }

  addWord(rawWord: string, rawAlias: string, replaceId?: string): WordResult {
    const word = rawWord.trim(), alias = rawAlias.trim()
    if (!word) return { ok: false, feedback: 'Type the word the way you want it spelled.' }
    if (word.length > 100 || alias.length > 100) return { ok: false, feedback: 'Keep each term under 100 characters.' }
    const personal = loadPersonal()
    const target = replaceId ? personal.vocabulary.find((entry) => entry.id === replaceId) : undefined
    const duplicate = personal.vocabulary.find((entry) => entry.id !== target?.id && entry.word.localeCompare(word, undefined, { sensitivity: 'accent' }) === 0)
    if (target) {
      target.word = word
      target.alias = alias
      if (duplicate) personal.vocabulary = personal.vocabulary.filter((entry) => entry.id !== duplicate.id)
      return this.savePersonalWords(personal, `Updated “${word}”.`)
    }
    if (duplicate) {
      duplicate.word = word
      duplicate.alias = alias
      return this.savePersonalWords(personal, `Updated “${word}”.`)
    }
    if (personal.vocabulary.length >= 200) return { ok: false, feedback: 'Your vocabulary supports 200 personal terms.' }
    personal.vocabulary.push({ id: newID(), word, alias, learned: false })
    return this.savePersonalWords(personal, `Added “${word}”. Used from your next dictation.`)
  }

  removeWord(id: string): WordResult {
    const personal = loadPersonal()
    const entry = personal.vocabulary.find((item) => item.id === id)
    personal.vocabulary = personal.vocabulary.filter((item) => item.id !== id)
    return this.savePersonalWords(personal, entry ? `Removed “${entry.word}”.` : 'Term removed.')
  }

  restoreWord(entry: VocabularyEntry, index: number): WordResult {
    const word = entry.word.trim(), alias = entry.alias.trim()
    if (!word || word.length > 100 || alias.length > 100) return { ok: false, feedback: 'Keep each term under 100 characters.' }
    const personal = loadPersonal()
    if (personal.vocabulary.some((item) => item.id === entry.id)) return { ok: true, feedback: '' }
    if (personal.vocabulary.length >= 200) return { ok: false, feedback: 'Your vocabulary supports 200 personal terms.' }
    const clean: VocabularyEntry = { id: entry.id || newID(), word, alias, learned: Boolean(entry.learned) }
    personal.vocabulary.splice(Math.max(0, Math.min(index, personal.vocabulary.length)), 0, clean)
    return this.savePersonalWords(personal, `Restored “${clean.word}”.`)
  }

  private savePersonalWords(personal: Personalization, feedback: string): WordResult {
    try {
      savePersonal(personal)
      this.personal = personal
      this.update({ vocabulary: personal.vocabulary })
      return { ok: true, feedback }
    } catch (error) {
      return { ok: false, feedback: `Could not save your vocabulary: ${(error as Error).message}` }
    }
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
  }

  private deletePendingAudio(): void {
    for (const file of [this.pendingAudio, ...this.pieceFiles]) {
      if (file) { try { unlinkSync(file) } catch { /* already removed by the worker */ } }
    }
    this.pendingAudio = null
    this.pieceFiles.clear()
  }

  shutdown(): void {
    this.deliveryToken++
    this.stopMicrophoneTest()
    this.clearWatchdog()
    this.recordingToken++
    this.endRecordingSession()
    this.recorder?.cancel()
    this.deletePendingAudio()
    globalShortcut.unregisterAll()
    this.helper.stop()
    this.worker.stop()
  }
}

/**
 * Word pairs a correction changed where the new word looks like a name or term,
 * e.g. ("queen", "Qwen") from "ask queen" → "ask Qwen".
 */
export function changedWords(original: string, corrected: string): [string, string][] {
  const a = original.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) ?? []
  const b = corrected.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) ?? []
  // Longest common subsequence, then pair up the single-word replacements between matches.
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i].toLowerCase() === b[j].toLowerCase() ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const pairs: [string, string][] = []
  let i = 0, j = 0, gapA: string[] = [], gapB: string[] = []
  const flush = () => {
    if (gapB.length === 1 && gapA.length >= 1 && gapA.length <= 3 && /[A-Z0-9]/.test(gapB[0])) pairs.push([gapA.join(' '), gapB[0].replace(/[.]$/, '')])
    gapA = []; gapB = []
  }
  while (i < a.length && j < b.length) {
    if (a[i].toLowerCase() === b[j].toLowerCase()) { flush(); i++; j++ }
    else if (table[i + 1][j] >= table[i][j + 1]) gapA.push(a[i++])
    else gapB.push(b[j++])
  }
  gapA.push(...a.slice(i)); gapB.push(...b.slice(j)); flush()
  return pairs
}

export function openPrivacy(anchor: string): void {
  void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`)
}

function playSound(name: string): void {
  spawn('/usr/bin/afplay', ['-v', '0.6', `/System/Library/Sounds/${name}.aiff`], { stdio: 'ignore' }).unref()
}
