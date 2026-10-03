// A simulated bridge for design previews: synthetic notes, no microphone, no models.
import type { AppState, Archive, ArchivedLink, ArchivedNote, ArchivedTerm, DictaitAPI, HudKind, HudState, Section, Suggestion, VocabularyEntry } from '@shared/types'

const HOUR = 3_600_000
const DAY = 24 * HOUR

const termList: [string, string][] = [
  ['Dictait', 'project'], ['Maya', 'person'], ['Qwen', 'technical'], ['Whisper', 'technical'], ['TypeScript', 'technical'],
  ['Northwind', 'organization'], ['Launch plan', 'topic'], ['Arjun', 'person'], ['Privacy', 'topic'], ['MLX', 'technical'],
  ['Figma', 'technical'], ['Lisbon offsite', 'topic'], ['Onboarding', 'topic']
]

const noteList: [number, string, string[]][] = [
  [0.4 * HOUR, 'Discuss Dictait with Maya tomorrow. We want local transcription to feel immediate, with notes that are easy to find later.', ['Dictait', 'Maya']],
  [1.6 * HOUR, 'Qwen handles grammar cleanup in Dictait. Keep my natural tone and preserve project names, especially MLX and Whisper.', ['Qwen', 'Dictait', 'MLX', 'Whisper']],
  [3.1 * HOUR, 'Reminder for the launch plan:\n\n- Record the demo video on Thursday\n- Ask Arjun to review the README\n- Post the release notes once the build is signed', ['Launch plan', 'Arjun', 'Dictait']],
  [DAY + 2 * HOUR, 'Maya is reviewing the TypeScript project. Send her the implementation notes after the review, and copy Northwind on the summary.', ['Maya', 'TypeScript', 'Northwind']],
  [DAY + 5 * HOUR, 'Hey Arjun, thanks for the quick turnaround on the installer. Could you also check that the model download resumes if the network drops? Cheers.', ['Arjun']],
  [DAY + 7 * HOUR, 'The privacy story is simple: audio never leaves the Mac, the recording is deleted after transcription, and nothing phones home.', ['Privacy', 'Dictait']],
  [3 * DAY, 'Whisper Turbo runs in about half a second for short clips on the M5. Parakeet is a little faster for English but has no Hindi.', ['Whisper', 'MLX']],
  [3 * DAY + 3 * HOUR, 'Northwind wants a pilot for their support team in November. Maya will own the relationship; I will prepare the security questionnaire.', ['Northwind', 'Maya', 'Privacy']],
  [5 * DAY, 'Idea: the graph view could highlight terms that keep appearing together, so related projects surface on their own.', ['Dictait']],
  [9 * DAY, 'Book flights for the Lisbon offsite and check whether Arjun can join the Friday session.', ['Lisbon offsite', 'Arjun']],
  [12 * DAY, 'The Figma file for the new onboarding is ready. The island should feel like it grows out of the notch, then settles.', ['Figma', 'Onboarding', 'Dictait']]
]

function buildArchive(now: number): Archive {
  const ids = new Map(termList.map(([name], index) => [name, index + 1]))
  const notes: ArchivedNote[] = noteList.map(([ago, body, terms], index) => ({
    id: `demo-${index}`, body, created: now - ago, language: 'en', terms: terms.map((name) => ids.get(name)!)
  }))
  const mentions = new Map<number, number>()
  const pairs = new Map<string, number>()
  for (const note of notes) {
    for (const term of note.terms) mentions.set(term, (mentions.get(term) ?? 0) + 1)
    for (const a of note.terms) for (const b of note.terms) if (a < b) pairs.set(`${a}:${b}`, (pairs.get(`${a}:${b}`) ?? 0) + 1)
  }
  const terms: ArchivedTerm[] = termList.map(([name, kind], index) => ({ id: index + 1, name, kind, mentions: mentions.get(index + 1) ?? 1 }))
    .sort((a, b) => b.mentions - a.mentions)
  const links: ArchivedLink[] = [...pairs].map(([key, weight]) => {
    const [source, target] = key.split(':').map(Number)
    return { source, target, weight }
  })
  return { notes, terms, links, error: '' }
}

export function createMock(real?: DictaitAPI): DictaitAPI {
  let archive = buildArchive(Date.now())
  let vocabulary: VocabularyEntry[] = [
    { id: 'v1', word: 'Dictait', alias: 'dictate' }, { id: 'v2', word: 'Qwen', alias: 'queen' }, { id: 'v3', word: 'MLX', alias: 'M L X' },
    { id: 'v4', word: 'Northwind', alias: '' }, { id: 'v5', word: 'Arjun', alias: 'Arjen' }, { id: 'v6', word: 'Parakeet', alias: '' }
  ]
  // Previews: ?section=setup shows a fresh install mid-download; ?section=settings offers an update.
  const fresh = new URLSearchParams(location.search).get('section') === 'setup'
  const state: AppState = {
    phase: fresh ? 'preparing' : 'ready', message: 'Control–Space to start. Press again to finish.', notice: '', recordingStartedAt: null,
    transcript: 'Discuss Dictait with Maya tomorrow.', timing: '0.74 s total · 0.44 s transcription', detectedLanguage: 'en',
    microphoneAllowed: true, accessibilityAllowed: !fresh, shortcutRegistered: true, launchAtLogin: true, loginNeedsApproval: false,
    rememberedTerms: termList.length,
    settings: {
      backend: 'whisper', language: 'auto', cleanup: true, autoPaste: true, smartFormatting: true, writingStyle: 'Keep my natural tone and wording.',
      memoryMode: 'notes', learnCorrections: true, appearance: 'system', useContext: true, voiceEdits: true, appTones: true, microphone: 'auto',
      setupDone: !fresh, autoUpdate: true,
      tones: {
        messaging: 'Casual and brief, like a chat message. No greeting or sign-off unless I say one.',
        email: 'Clear and friendly, in complete sentences and short paragraphs. Keep greetings and sign-offs I say.',
        code: 'Literal and precise. Keep technical terms, file names, commands and identifiers exactly as said. No filler.',
        docs: 'Well structured. Use paragraphs, or a list when the content is a list.'
      }
    },
    vocabulary,
    history: [{ text: 'Discuss Dictait with Maya tomorrow.', at: Date.now() - 600_000, app: 'Slack' }],
    download: fresh ? { model: 'speech model', done: 1_120_000_000, total: 3_250_000_000 } : null,
    version: '0.5.0',
    update: { phase: 'available', version: '0.5.1', notes: 'Faster cleanup and a new island.', progress: 0, error: '', checkedAt: Date.now() - 60_000 }
  }
  let suggestions: Suggestion[] = [
    { word: 'Lisbon', alias: 'lisbin', reason: 'From your correction' }, { word: 'Onboarding', alias: '', reason: 'Said 3 times' },
    { word: 'TypeScript', alias: '', reason: 'Said 2 times' }
  ]
  const listeners = { state: new Set<(state: AppState) => void>(), level: new Set<(level: number) => void>(), archive: new Set<() => void>(), navigate: new Set<(section: Section) => void>() }
  const emit = (patch: Partial<AppState>) => {
    Object.assign(state, patch)
    listeners.state.forEach((callback) => callback({ ...state }))
  }
  let levelTimer: number | undefined
  const timers: number[] = []
  const after = (ms: number, run: () => void) => { timers.push(window.setTimeout(run, ms)) }
  const on = <T,>(set: Set<T>, callback: T) => { set.add(callback); return () => { set.delete(callback) } }

  const finish = () => {
    window.clearInterval(levelTimer)
    listeners.level.forEach((callback) => callback(0))
    emit({ phase: 'transcribing', message: 'Turning speech into text on this Mac…', recordingStartedAt: null })
    after(900, () => emit({ phase: 'cleaning', message: 'Organizing your words…' }))
    after(1700, () => {
      const body = 'Quick follow-up for Maya: the island animation feels right now. Let us ship the preview build on Friday.'
      archive = { ...archive, notes: [{ id: `demo-${Date.now()}`, body, created: Date.now(), language: 'en', terms: [2] }, ...archive.notes] }
      emit({ phase: 'ready', message: 'Pasted. Control–Space to dictate again.', transcript: body })
      listeners.archive.forEach((callback) => callback())
    })
  }

  return {
    preview: true,
    getState: async () => ({ ...state }),
    onState: (callback) => on(listeners.state, callback),
    onLevel: (callback) => on(listeners.level, callback),
    onArchiveChanged: (callback) => on(listeners.archive, callback),
    onNavigate: (callback) => on(listeners.navigate, callback),
    readArchive: async () => archive,
    toggleRecording: () => {
      if (state.phase === 'recording') { finish(); return }
      if (state.phase !== 'ready') return
      emit({ phase: 'recording', message: 'Control–Space to finish. Escape to cancel.', recordingStartedAt: Date.now() })
      let t = 0
      levelTimer = window.setInterval(() => {
        t += 0.05
        const level = Math.max(0, 0.35 + 0.3 * Math.sin(t * 7) * Math.sin(t * 2.3) + (Math.random() - 0.5) * 0.25)
        listeners.level.forEach((callback) => callback(level))
      }, 50)
    },
    cancelRecording: () => {
      if (state.phase !== 'recording') return
      window.clearInterval(levelTimer)
      emit({ phase: 'ready', message: 'Recording cancelled. Control–Space to try again.', recordingStartedAt: null })
    },
    setSettings: async (patch) => emit({ settings: { ...state.settings, ...patch } }),
    setLaunchAtLogin: async (enabled) => emit({ launchAtLogin: enabled }),
    openLoginItems: () => {},
    retryShortcut: () => emit({ shortcutRegistered: true }),
    requestMicrophone: () => emit({ microphoneAllowed: true }),
    requestAccessibility: () => emit({ accessibilityAllowed: true }),
    checkForUpdates: async () => emit({ update: { ...state.update, phase: 'checking' } }),
    installUpdate: () => emit({ update: { ...state.update, phase: 'downloading', progress: 0.42 } }),
    reloadModels: () => {
      emit({ phase: 'preparing', message: 'Preparing local models.' })
      after(1600, () => emit({ phase: 'ready', message: 'Control–Space to start. Press again to finish.' }))
    },
    copyText: async (text) => { try { await navigator.clipboard.writeText(text) } catch { /* preview only */ } },
    learnCorrection: async () => 'Correction saved on this Mac. Future cleanup will use it.',
    addWord: async (word, alias) => {
      const clean = word.trim()
      if (!clean) return { ok: false, feedback: 'Type the word the way you want it spelled.' }
      const existing = vocabulary.find((entry) => entry.word.toLowerCase() === clean.toLowerCase())
      vocabulary = existing ? vocabulary.map((entry) => (entry === existing ? { ...entry, word: clean, alias: alias.trim() } : entry))
        : [...vocabulary, { id: `v${Date.now()}`, word: clean, alias: alias.trim() }]
      emit({ vocabulary })
      return { ok: true, feedback: existing ? `Updated “${clean}”.` : `Added “${clean}”. Used from your next dictation.` }
    },
    removeWord: async (id) => {
      const entry = vocabulary.find((item) => item.id === id)
      vocabulary = vocabulary.filter((item) => item.id !== id)
      emit({ vocabulary })
      return { ok: true, feedback: entry ? `Removed “${entry.word}”.` : 'Term removed.' }
    },
    restoreWord: async (entry, index) => {
      vocabulary = [...vocabulary.slice(0, index), entry, ...vocabulary.slice(index)]
      emit({ vocabulary })
      return { ok: true, feedback: `Restored “${entry.word}”.` }
    },
    openFolder: () => {},
    microphones: async () => [{ name: 'MacBook Air Microphone', transport: 'builtin', default: false }, { name: 'AirPods Pro', transport: 'bluetooth', default: true }],
    suggestions: async () => suggestions.filter((item) => !vocabulary.some((entry) => entry.word.toLowerCase() === item.word.toLowerCase())),
    dismissSuggestion: async (word) => { suggestions = suggestions.filter((item) => item.word !== word) },
    onHud: (callback) => real?.onHud(callback) ?? demoHud(callback),
    hudHidden: () => real?.hudHidden(),
    onRecorder: (callback) => real?.onRecorder(callback) ?? (() => {}),
    recorderStarted: () => {}, recorderFailed: () => {}, recorderData: () => {}, recorderPiece: () => {}, recorderEnded: () => {}, recorderLevel: () => {}
  }
}

/** In a plain browser, cycle the island through its states. ?kind=recording pins one. */
function demoHud(callback: (state: HudState) => void): () => void {
  const params = new URLSearchParams(location.search)
  const flat = params.get('screen') === 'flat'
  const screen = flat ? { hasNotch: false, notchWidth: 0, notchHeight: 0 } : { hasNotch: true, notchWidth: 179, notchHeight: 32 }
  // A null kind retracts the island for the given time.
  const steps: [HudKind | null, string, string, number][] = [
    ['recording', 'Listening', '', 5200], ['transcribing', 'Transcribing', 'On this Mac', 1300], ['cleaning', 'Polishing', 'Grammar & flow', 1100],
    ['done', 'Pasted', '', 1500], [null, '', '', 1600], ['recording', 'Listening', '', 2600], ['cancelled', 'Cancelled', '', 1200], [null, '', '', 1600]
  ]
  const pinned = params.get('kind') as HudKind | null
  if (pinned) {
    const step = steps.find(([kind]) => kind === pinned)
    const timer = window.setTimeout(() => callback({
      visible: true, kind: pinned, title: step?.[1] ?? 'Needs attention', detail: step?.[2] ?? 'The model worker stopped. Click Retry to reload models.',
      startedAt: Date.now() - 12_000, screen, live: pinned === 'recording' ? 'so the plan is to ship the preview build on Friday and then' : '', note: '', holding: false, editing: false
    }), 300)
    return () => window.clearTimeout(timer)
  }
  let index = 0
  let timer = 0
  let last: HudKind = 'info'
  const next = () => {
    const [kind, title, detail, duration] = steps[index % steps.length]
    index++
    if (kind) last = kind
    callback({ visible: kind !== null, kind: kind ?? last, title, detail, startedAt: kind === 'recording' ? Date.now() : null, screen, live: '', note: '', holding: false, editing: false })
    timer = window.setTimeout(next, duration)
  }
  timer = window.setTimeout(next, 500)
  return () => window.clearTimeout(timer)
}
