/** Long dictations are processed in pieces while you speak, so this can be generous. */
export const MAX_DICTATION_SECONDS = 30 * 60

export type Phase = 'preparing' | 'ready' | 'requestingMicrophone' | 'recording' | 'transcribing' | 'cleaning' | 'failed'
export type Section = 'notes' | 'graph' | 'vocabulary' | 'settings'
export type Appearance = 'system' | 'light' | 'dark'
export type MemoryMode = 'notes' | 'terms' | 'off'
export type Backend = 'whisper' | 'parakeet'
export type Language = 'auto' | 'en' | 'hi'

/** How Dictait writes in each kind of app. */
export interface Tones {
  messaging: string
  email: string
  code: string
  docs: string
}

export interface Settings {
  backend: Backend
  language: Language
  cleanup: boolean
  autoPaste: boolean
  smartFormatting: boolean
  writingStyle: string
  memoryMode: MemoryMode
  learnCorrections: boolean
  appearance: Appearance
  /** Read the text before the cursor as a hint for names, spelling and flow. */
  useContext: boolean
  /** Speak an instruction over selected text to rewrite it. */
  voiceEdits: boolean
  /** Adapt tone to the app you are dictating into. */
  appTones: boolean
  tones: Tones
  /** "auto" avoids Bluetooth headset mics, "system" follows macOS, or a device name. */
  microphone: string
  /** The first-run setup has been completed (or skipped). */
  setupDone: boolean
  /** Check GitHub for new releases and offer them. */
  autoUpdate: boolean
}

/** A first-run model download in progress. */
export interface Download {
  model: string
  done: number
  total: number
}

export type UpdatePhase = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'installing' | 'failed'

export interface UpdateStatus {
  phase: UpdatePhase
  /** The version on offer, when one is. */
  version: string
  notes: string
  /** 0 to 1 while downloading. */
  progress: number
  error: string
  checkedAt: number | null
}

export interface Microphone {
  name: string
  transport: 'builtin' | 'bluetooth' | 'usb' | 'virtual' | 'other'
  default: boolean
}

export interface HistoryEntry {
  text: string
  at: number
  app: string
}

export interface Suggestion {
  word: string
  alias: string
  reason: string
}

export interface VocabularyEntry {
  id: string
  word: string
  alias: string
  learned?: boolean
}

export interface CorrectionExample {
  id: string
  original: string
  corrected: string
}

export interface AppState {
  phase: Phase
  message: string
  notice: string
  recordingStartedAt: number | null
  transcript: string
  timing: string
  detectedLanguage: string
  microphoneAllowed: boolean
  accessibilityAllowed: boolean
  shortcutRegistered: boolean
  launchAtLogin: boolean
  loginNeedsApproval: boolean
  rememberedTerms: number
  settings: Settings
  vocabulary: VocabularyEntry[]
  history: HistoryEntry[]
  download: Download | null
  update: UpdateStatus
  version: string
}

export interface ArchivedNote {
  id: string
  body: string
  /** Milliseconds since the epoch. */
  created: number
  language: string
  terms: number[]
}

export interface ArchivedTerm {
  id: number
  name: string
  kind: string
  mentions: number
}

export interface ArchivedLink {
  source: number
  target: number
  weight: number
}

export interface Archive {
  notes: ArchivedNote[]
  terms: ArchivedTerm[]
  links: ArchivedLink[]
  error: string
}

export type HudKind =
  | 'recording' | 'microphone' | 'transcribing' | 'cleaning' | 'preparing'
  | 'done' | 'copied' | 'cancelled' | 'empty' | 'failed' | 'info'

export interface HudScreen {
  hasNotch: boolean
  notchWidth: number
  notchHeight: number
}

export interface HudState {
  visible: boolean
  kind: HudKind
  title: string
  detail: string
  startedAt: number | null
  screen: HudScreen
  /** Words recognised so far, while you are still speaking. */
  live: string
  /** A short tip shown under the waveform, such as which microphone is in use. */
  note: string
  /** The shortcut is being held: letting go finishes. */
  holding: boolean
  /** Rewriting the selected text rather than dictating. */
  editing: boolean
}

export type RecorderCommand = 'start' | 'stop' | 'cancel'
export interface RecorderOptions { device?: string | null }

export interface WordResult {
  ok: boolean
  feedback: string
}

export interface DictaitAPI {
  preview: boolean
  getState(): Promise<AppState>
  onState(callback: (state: AppState) => void): () => void
  onLevel(callback: (level: number) => void): () => void
  onArchiveChanged(callback: () => void): () => void
  onNavigate(callback: (section: Section) => void): () => void
  readArchive(): Promise<Archive>
  toggleRecording(): void
  cancelRecording(): void
  setSettings(patch: Partial<Settings>): Promise<void>
  setLaunchAtLogin(enabled: boolean): Promise<void>
  openLoginItems(): void
  retryShortcut(): void
  requestMicrophone(): void
  requestAccessibility(): void
  reloadModels(): void
  copyText(text: string): Promise<void>
  learnCorrection(): Promise<string>
  addWord(word: string, alias: string): Promise<WordResult>
  removeWord(id: string): Promise<WordResult>
  restoreWord(entry: VocabularyEntry, index: number): Promise<WordResult>
  openFolder(which: 'notes' | 'memory'): void
  microphones(): Promise<Microphone[]>
  suggestions(): Promise<Suggestion[]>
  dismissSuggestion(word: string): Promise<void>
  checkForUpdates(): Promise<void>
  installUpdate(): void
  // Recording indicator window
  onHud(callback: (state: HudState) => void): () => void
  hudHidden(): void
  onRecorder(callback: (command: RecorderCommand, options?: RecorderOptions) => void): () => void
  recorderStarted(): void
  recorderFailed(message: string): void
  recorderData(audio: ArrayBuffer | null): void
  recorderPiece(audio: ArrayBuffer, index: number): void
  recorderEnded(): void
  recorderLevel(level: number): void
}

declare global {
  interface Window {
    dictait?: DictaitAPI
  }
}
