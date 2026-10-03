import { app, clipboard, globalShortcut, shell, systemPreferences } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_DICTATION_SECONDS, type AppState, type HistoryEntry, type Microphone, type Phase, type RecorderOptions,
  type Settings, type Suggestion, type Tones, type UpdateStatus, type VocabularyEntry, type WordResult
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
  editing: boolean
  appName: string
}

/** Holding Control–Space longer than this turns the press into push-to-talk. */
const HOLD_MS = 350
const SPACE = 49, KEY_V = 9

/** Which tone applies in which app, by bundle identifier. */
const toneApps: Record<keyof Tones, RegExp> = {
  messaging: /^(com\.apple\.MobileSMS|com\.tinyspeck\.slackmacgap|net\.whatsapp\.WhatsApp|desktop\.WhatsApp|com\.hnc\.Discord|ru\.keepcoder\.Telegram|org\.telegram\.desktop|com\.facebook\.archon|com\.microsoft\.teams2?|us\.zoom\.xos|com\.apple\.iChat)$/,
  email: /^(com\.apple\.mail|com\.microsoft\.Outlook|com\.readdle\.smartemail-Mac|com\.superhuman\.electron|it\.bloop\.airmail2|com\.mimestream\.Mimestream)$/,
  code: /^(com\.microsoft\.VSCode|com\.todesktop\.230313mzl4w4u92|com\.apple\.dt\.Xcode|com\.jetbrains\..*|com\.apple\.Terminal|com\.googlecode\.iterm2|dev\.warp\.Warp-Stable|com\.sublimetext\.4|dev\.zed\.Zed|com\.exafunction\.windsurf|com\.openai\.chat|com\.anthropic\.claudefordesktop)$/,
  docs: /^(com\.apple\.Notes|notion\.id|md\.obsidian|com\.microsoft\.Word|com\.apple\.iWork\.Pages|com\.apple\.TextEdit|net\.shinyfrog\.bear|com\.craft\.craft|com\.ulyssesapp\.mac)$/
}

export class Coordinator extends EventEmitter {
  stored: Stored = loadSettings()
  personal: Personalization = loadPersonal()
  state: AppState
  readonly live: LiveState = { live: '', note: '', holding: false, editing: false, appName: '' }
  recorder: RecorderBridge | null = null
  onToggleRequested: () => void = () => {}
  /** Answers whether Dictait's own window has a text field in focus, when it is the active app. */
  ownFocus: () => Promise<boolean | null> = async () => null
  readonly helper = new NativeHelper()
  private worker = new ModelWorker()
  private requestID: string | null = null
  private pendingAudio: string | null = null
  private watchdog: NodeJS.Timeout | null = null
  private ticker: NodeJS.Timeout | null = null
  private cleanupAvailable = false
  private lastToggle = 0
  private recordingToken = 0
  /** The worker session for the current recording; long dictations send pieces under it. */
  private session: string | null = null
  private pieces = 0
  private pieceFiles = new Set<string>()
  /** Where the user was when recording began: context, selection and app. */
  private target: FocusInfo | null = null
  private pressedAt = 0
  private pressStarted = false
  private holdTimer: NodeJS.Timeout | null = null
  private bluetoothTipShown = false

  constructor() {
    super()
    this.state = {
      phase: 'preparing', message: 'Loading your local models…', notice: '', recordingStartedAt: null,
      transcript: '', timing: '', detectedLanguage: this.stored.detectedLanguage,
      microphoneAllowed: false, accessibilityAllowed: false, shortcutRegistered: false,
      launchAtLogin: false, loginNeedsApproval: false, rememberedTerms: 0,
      settings: this.settings, vocabulary: this.personal.vocabulary, history: [], download: null, version: app.getVersion(),
      update: { phase: 'idle', version: '', notes: '', progress: 0, error: '', checkedAt: null }
    }
  }

  get settings(): Settings {
    const { backend, language, cleanup, autoPaste, smartFormatting, writingStyle, memoryMode, learnCorrections, appearance,
      useContext, voiceEdits, appTones, tones, microphone, setupDone, autoUpdate } = this.stored
    return { backend, language, cleanup, autoPaste, smartFormatting, writingStyle, memoryMode, learnCorrections, appearance,
      useContext, voiceEdits, appTones, tones: { ...tones }, microphone, setupDone, autoUpdate }
  }

  start(): void {
    this.helper.on('hotkey', (name: string, down: boolean) => this.hotkey(name, down))
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

  private store(patch: Partial<Stored>): void {
    Object.assign(this.stored, patch)
    saveSettings(this.stored)
  }

  setPhase(phase: Phase, message: string): void {
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
      remembered_terms: this.state.rememberedTerms, shortcut_registered: this.state.shortcutRegistered
    }
    try {
      mkdirSync(SUPPORT, { recursive: true })
      writeFileSync(join(SUPPORT, 'status.json'), JSON.stringify(values, null, 2))
    } catch { /* diagnostics are best effort */ }
  }

  // MARK: Shortcuts

  /** Control–Space (tap or hold) and Control–Option–V, through the native helper; Electron as a fallback. */
  async registerShortcut(): Promise<void> {
    if (globalShortcut.isRegistered('Control+Space')) globalShortcut.unregister('Control+Space')
    const registered = await this.helper.registerHotkeys([
      { name: 'dictate', code: SPACE, modifiers: ['control'] },
      { name: 'pasteLast', code: KEY_V, modifiers: ['control', 'option'] }
    ])
    let ok = registered.dictate === true
    if (!ok && !('dictate' in registered)) {
      // No helper: tapping still works, holding does not.
      ok = globalShortcut.register('Control+Space', () => this.toggleRecording())
      if (!globalShortcut.isRegistered('Control+Alt+V')) globalShortcut.register('Control+Alt+V', () => void this.pasteLast())
    }
    let notice = this.state.notice
    if (!ok) notice = 'Control–Space is in use. In Keyboard → Keyboard Shortcuts → Input Sources, disable or change that shortcut, then click Retry shortcut.'
    else if (notice.startsWith('Control–Space is in use')) notice = ''
    this.update({ shortcutRegistered: ok, notice })
    this.writeDiagnostics()
  }

  /** Tap to start, tap to finish; or hold while talking and let go to finish. */
  private hotkey(name: string, down: boolean): void {
    if (name === 'pasteLast') { if (down) void this.pasteLast(); return }
    if (name !== 'dictate') return
    if (down) {
      this.pressedAt = Date.now()
      this.pressStarted = false
      this.onToggleRequested()
      if (this.state.phase === 'recording') { void this.stopRecording(); return }
      if (this.state.phase !== 'ready') return
      this.pressStarted = true
      this.toggleRecording(true)
      if (this.holdTimer) clearTimeout(this.holdTimer)
      this.holdTimer = setTimeout(() => {
        if (this.pressStarted && this.state.phase === 'recording') this.setLive({ holding: true })
      }, HOLD_MS)
      return
    }
    if (this.holdTimer) clearTimeout(this.holdTimer)
    const held = Date.now() - this.pressedAt >= HOLD_MS
    if (this.pressStarted && held && this.state.phase === 'recording') void this.stopRecording()
    this.pressStarted = false
    if (this.live.holding) this.setLive({ holding: false })
  }

  reloadModels(): void {
    if (['recording', 'transcribing', 'cleaning', 'requestingMicrophone'].includes(this.state.phase)) return
    this.clearWatchdog()
    this.setPhase('preparing', 'Preparing local models. The first download can take a few minutes.')
    try {
      this.worker.start(this.stored.backend, this.stored.cleanup)
    } catch (error) {
      this.setPhase('failed', (error as Error).message)
    }
  }

  /** From the menu, the window or the shortcut. `fromHotkey` skips the repeat guard (the helper debounces). */
  toggleRecording(fromHotkey = false): void {
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
        if (granted) void this.beginRecording()
        else this.setPhase('ready', 'Enable Dictait in System Settings → Privacy & Security → Microphone.')
      })
    } else if (status === 'granted') {
      void this.beginRecording()
    } else {
      this.setPhase('ready', 'Enable Dictait in System Settings → Privacy & Security → Microphone.')
      this.requestMicrophone()
    }
  }

  // MARK: Recording

  private async beginRecording(): Promise<void> {
    const token = ++this.recordingToken
    const startedAt = Date.now()
    this.session = randomUUID()
    this.pieces = 0
    this.target = null
    this.setLive({ live: '', note: '', holding: false, editing: false, appName: '' })
    this.state.recordingStartedAt = startedAt
    this.setPhase('recording', 'Control–Space to finish. Escape to cancel.')
    globalShortcut.register('Escape', () => this.cancelRecording())
    playSound('Tink')
    // Look at where the user is while the microphone opens; neither waits for the other.
    const looking = this.inspectTarget()
    try {
      if (!this.recorder) throw new Error('The recorder is not ready yet.')
      const device = await this.chooseMicrophone()
      await this.recorder.start({ device })
    } catch (error) {
      if (token !== this.recordingToken || this.state.phase !== 'recording') return
      this.endRecordingSession()
      this.setPhase('ready', (error as Error).message || 'Could not start the microphone. Check your input device in System Settings → Sound.')
      shell.beep()
      return
    }
    await looking
    if (token !== this.recordingToken || this.state.phase !== 'recording') return
    this.ticker = setInterval(() => {
      if (Date.now() - startedAt >= MAX_DICTATION_SECONDS * 1000) void this.stopRecording()
    }, 250)
  }

  /** Context before the cursor, the selection (for voice edits) and the app (for tone). */
  private async inspectTarget(): Promise<void> {
    const own = await this.ownFocus()
    const target = own !== null
      ? { app: 'org.dictait.mac', appName: 'Dictait', editable: own, before: '', selected: '' }
      : await this.helper.focus()
    if (!target || this.state.phase !== 'recording') return
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

  private endRecordingSession(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    if (this.holdTimer) clearTimeout(this.holdTimer)
    if (globalShortcut.isRegistered('Escape')) globalShortcut.unregister('Escape')
    this.state.recordingStartedAt = null
    this.pressStarted = false
    if (this.live.holding) this.setLive({ holding: false })
    this.emit('level', 0)
  }

  cancelRecording(): void {
    if (this.state.phase !== 'recording') return
    this.recordingToken++
    this.endRecordingSession()
    this.recorder?.cancel()
    this.discardSession()
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

  private toneFor(bundle: string): string {
    if (!this.stored.appTones || !bundle) return ''
    for (const [kind, pattern] of Object.entries(toneApps) as [keyof Tones, RegExp][]) {
      if (pattern.test(bundle)) return this.stored.tones[kind]
    }
    return ''
  }

  private requestOptions(): Record<string, unknown> {
    const { language, cleanup, memoryMode, smartFormatting, writingStyle, learnCorrections, useContext } = this.stored
    const target = this.target
    const tone = target ? this.toneFor(target.app) : ''
    const style = [writingStyle.slice(0, 300), tone && `In ${target?.appName}: ${tone}`].filter(Boolean).join('\n')
    return {
      language, cleanup: cleanup && this.cleanupAvailable,
      vocabulary: this.personal.vocabulary.map(({ word, alias }) => ({ word, alias })),
      memory: memoryMode, smart_formatting: smartFormatting, writing_style: style,
      examples: learnCorrections ? this.personal.examples.map(({ original, corrected }) => ({ original, corrected })) : [],
      // Text before the cursor never leaves this Mac and is never saved.
      context: useContext && target?.editable && !target.secure ? target.before.slice(-500) : '',
      selection: this.live.editing && target ? target.selected.slice(0, 6000) : ''
    }
  }

  /** The input device vanished mid-recording. */
  microphoneEnded(): void {
    if (this.state.phase !== 'recording') return
    this.cancelRecording()
    this.update({ notice: 'The microphone disconnected. Check your input device and try again.' })
  }

  private async stopRecording(): Promise<void> {
    if (this.state.phase !== 'recording') return
    this.recordingToken++
    this.endRecordingSession()
    this.setPhase('transcribing', this.live.editing ? 'Understanding your instruction…' : 'Turning speech into text on this Mac…')
    let audio: Buffer | null = null
    try { audio = (await this.recorder?.stop()) ?? null } catch { audio = null }
    // Pieces cut during the stop flush have arrived by now; IPC keeps its order.
    const id = this.session ?? randomUUID(), pieces = this.pieces
    this.session = null
    this.pieces = 0
    if (!audio || (audio.length <= 44 && !pieces)) {
      if (pieces) { try { this.worker.send({ command: 'discard', id }) } catch { /* worker gone */ } }
      this.setPhase('ready', 'No audio recorded. Try again.')
      return
    }
    const file = join(tmpdir(), `dictait-${randomUUID()}.wav`)
    try { writeFileSync(file, audio, { mode: 0o600 }) } catch (error) {
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
        this.pieceFiles.clear()
        const text = typeof event.text === 'string' ? event.text : ''
        const edit = event.mode === 'edit'
        if (!text) {
          this.setPhase('ready', edit ? `Selection unchanged. ${typeof event.warning === 'string' ? event.warning : ''}`.trim()
            : 'No speech detected. Move closer to the microphone and try again.')
          return
        }
        const detected = typeof event.language === 'string' && event.language ? event.language : this.state.detectedLanguage
        if (detected !== this.stored.detectedLanguage) this.store({ detectedLanguage: detected })
        const total = Number(event.total_ms ?? 0) / 1000, stt = Number(event.stt_ms ?? 0) / 1000
        const history: HistoryEntry[] = [{ text: text.trim(), at: Date.now(), app: this.target?.appName ?? '' }, ...this.state.history].slice(0, 10)
        this.update({
          transcript: text, detectedLanguage: detected, history,
          timing: `${total.toFixed(2)} s total · ${stt.toFixed(2)} s transcription`,
          notice: typeof event.warning === 'string' ? event.warning : ''
        })
        void this.deliver(text).then((outcome) => {
          if (this.stored.autoPaste && !this.state.accessibilityAllowed) {
            this.update({ notice: 'Enable Dictait in Privacy & Security → Accessibility to paste automatically. Your text is on the clipboard.' })
          }
          this.setPhase('ready', outcome === 'pasted' ? (edit ? 'Replaced. Control–Space to dictate again.' : 'Pasted. Control–Space to dictate again.')
            : outcome === 'no-target' ? 'Copied. No text box was in focus, so press Command–V where you want it.'
              : 'Copied. Press Command–V to paste.')
          this.emit('archive')
        })
        break
      }
      case 'error':
        if (typeof event.id === 'string' && event.id !== this.requestID) return
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

  async copyText(text = this.state.transcript): Promise<void> {
    if (text) await clipboard.writeText(text)
  }

  async deliver(text: string): Promise<'pasted' | 'copied' | 'no-target'> {
    // The clipboard must hold the text before Command–V reaches the focused app.
    await this.copyText(text)
    if (!this.stored.autoPaste) return 'copied'
    const trusted = systemPreferences.isTrustedAccessibilityClient(false)
    this.update({ accessibilityAllowed: trusted })
    if (!trusted) return 'copied'
    // Nothing to type into: leave the words on the clipboard instead of pasting into thin air.
    if ((await this.focusTarget()) === 'none') return 'no-target'
    return (await this.helper.paste()) ? 'pasted' : 'copied'
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
    const entry = this.state.history[index]
    if (!entry) { shell.beep(); return }
    const outcome = await this.deliver(entry.text)
    if (outcome !== 'pasted') this.update({ notice: 'Copied your dictation. Press Command–V where you want it.' })
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

  /** Learn from the user's corrected copy of the last dictation. */
  async learnCorrectionFromClipboard(): Promise<string> {
    const corrected = (await clipboard.readText()).trim()
    if (!corrected || !this.state.transcript) return 'Copy your corrected text first.'
    let feedback = 'Nothing changed, so there was nothing to learn.'
    if (this.stored.learnCorrections && corrected !== this.state.transcript) {
      // Saved examples teach usage in context; no global grammar substitutions.
      this.personal = loadPersonal()
      this.personal.examples = [...this.personal.examples, { id: newID(), original: this.state.transcript.slice(0, 240), corrected: corrected.slice(0, 240) }].slice(-10)
      try { savePersonal(this.personal); feedback = 'Correction saved on this Mac. Future cleanup will use it.' }
      catch (error) { feedback = `Could not save your correction: ${(error as Error).message}` }
      this.update({ notice: feedback })
    } else if (!this.stored.learnCorrections) {
      feedback = 'Turn on “Learn from corrections” to save examples.'
    }
    this.update({ transcript: corrected })
    await this.copyText(corrected)
    return feedback
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

  addWord(rawWord: string, rawAlias: string): WordResult {
    const word = rawWord.trim(), alias = rawAlias.trim()
    if (!word) return { ok: false, feedback: 'Type the word the way you want it spelled.' }
    if (word.length > 100 || alias.length > 100) return { ok: false, feedback: 'Keep each term under 100 characters.' }
    const personal = loadPersonal()
    const existing = personal.vocabulary.find((entry) => entry.word.localeCompare(word, undefined, { sensitivity: 'accent' }) === 0)
    if (existing) { existing.word = word; existing.alias = alias }
    else {
      if (personal.vocabulary.length >= 200) return { ok: false, feedback: 'Your vocabulary supports 200 personal terms.' }
      personal.vocabulary.push({ id: newID(), word, alias, learned: false })
    }
    return this.savePersonalWords(personal, existing ? `Updated “${word}”.` : `Added “${word}”. Used from your next dictation.`)
  }

  removeWord(id: string): WordResult {
    const personal = loadPersonal()
    const entry = personal.vocabulary.find((item) => item.id === id)
    personal.vocabulary = personal.vocabulary.filter((item) => item.id !== id)
    return this.savePersonalWords(personal, entry ? `Removed “${entry.word}”.` : 'Term removed.')
  }

  restoreWord(entry: VocabularyEntry, index: number): WordResult {
    const personal = loadPersonal()
    if (personal.vocabulary.some((item) => item.id === entry.id)) return { ok: true, feedback: '' }
    personal.vocabulary.splice(Math.max(0, Math.min(index, personal.vocabulary.length)), 0, entry)
    return this.savePersonalWords(personal, `Restored “${entry.word}”.`)
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
  }

  shutdown(): void {
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
