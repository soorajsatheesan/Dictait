// A simulated bridge for design previews: synthetic notes, no microphone, no models.
import { ACTION_NAMES, checkShortcut, DEFAULT_SHORTCUTS, sameShortcut, shortcutKeys, shortcutName, type ShortcutAction } from '@shared/shortcuts'
import { SNIPPET_CHARS, SNIPPET_LIMIT, type AppState, type Archive, type ArchivedLink, type ArchivedNote, type ArchivedTerm, type DictaitAPI, type HudKind, type HudState,
  type RecoveredRecording, type Section, type Snippet, type Suggestion, type VocabularyEntry } from '@shared/types'

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
  // Previews: ?empty=1 starts with nothing saved, ?phase=failed|preparing shows a broken or warming install,
  // ?ready=1 on setup shows the model installed.
  const params = new URLSearchParams(location.search)
  const empty = params.has('empty')
  let archive = empty ? { notes: [], terms: [], links: [], error: '' } : buildArchive(Date.now())
  let vocabulary: VocabularyEntry[] = [
    { id: 'v1', word: 'Dictait', alias: 'dictate' }, { id: 'v2', word: 'Qwen', alias: 'queen' }, { id: 'v3', word: 'MLX', alias: 'M L X' },
    { id: 'v4', word: 'Northwind', alias: '' }, { id: 'v5', word: 'Arjun', alias: 'Arjen' }, { id: 'v6', word: 'Parakeet', alias: '' }
  ]
  let snippets: Snippet[] = empty ? [] : [
    { id: 's1', trigger: 'my calendly', content: 'https://calendly.com/maya-rao/30min' },
    { id: 's2', trigger: 'standup template', content: 'Yesterday:\n- \nToday:\n- \nBlockers:\n- ' },
    { id: 's3', trigger: 'signature', content: 'Best,\nMaya Rao\nNorthwind · maya@northwind.dev' }
  ]
  let recovered: RecoveredRecording[] = empty ? [] : [
    { id: 'r1', at: Date.now() - 25 * 60_000, seconds: 132, reason: 'Transcription took too long', translate: false }
  ]
  // Previews: ?section=setup shows a fresh install mid-download; ?section=settings offers an update.
  const fresh = (params.get('section') === 'setup' && !params.has('ready')) || params.get('phase') === 'preparing'
  const failed = params.get('phase') === 'failed'
  const state: AppState = {
    phase: failed ? 'failed' : fresh ? 'preparing' : 'ready', message: failed ? 'The speech model could not load. Retry, or reinstall Dictait if it keeps failing.' : `${shortcutName(DEFAULT_SHORTCUTS.dictate)} to start. Press again to finish.`, notice: '', recordingStartedAt: null,
    transcript: 'Discuss Dictait with Maya tomorrow.', timing: '0.74 s total · 0.44 s transcription', detectedLanguage: 'en',
    microphoneAllowed: true, accessibilityAllowed: !fresh && !failed, shortcutRegistered: true, correctionShortcutRegistered: true, launchAtLogin: true, loginNeedsApproval: false,
    rememberedTerms: termList.length,
    settings: {
      backend: 'whisper', language: 'auto', cleanup: true, autoPaste: true, smartFormatting: true, writingStyle: 'Keep my natural tone and wording.',
      memoryMode: 'notes', learnCorrections: true, appearance: 'system', useContext: true, voiceEdits: true, appTones: true, microphone: 'auto',
      setupDone: params.get('section') !== 'setup', autoUpdate: true, feedbackSounds: true, shortcuts: { ...DEFAULT_SHORTCUTS }, whileRecording: 'keep',
      tones: {
        ai: 'Write it as a clear request to an AI assistant: the goal first, then details and constraints. Keep file names, code terms and commands exact.',
        messaging: 'Casual and brief, like a chat message. No greeting or sign-off unless I say one.',
        email: 'Clear and friendly, in complete sentences and short paragraphs. Keep greetings and sign-offs I say.',
        code: 'Literal and precise. Keep technical terms, file names, commands and identifiers exactly as said. No filler.',
        docs: 'Well structured. Use paragraphs, or a list when the content is a list.'
      }
    },
    vocabulary, snippets, recovered,
    history: [{ text: 'Discuss Dictait with Maya tomorrow.', at: Date.now() - 600_000, app: 'Slack' }],
    download: fresh ? { model: 'speech model', done: 1_120_000_000, total: 3_250_000_000 } : null,
    version: '0.7.0', correction: null, microphoneName: 'MacBook Air Microphone', micTestActive: false, practiceCompleted: [],
    update: { phase: 'available', version: '0.7.1', notes: 'Faster cleanup and a new island.', progress: 0, error: '', checkedAt: Date.now() - 60_000 }
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
  const key = () => shortcutName(state.settings.shortcuts.dictate)
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
      emit({ phase: 'ready', message: `Pasted. ${key()} to dictate again.`, transcript: body })
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
      emit({ phase: 'recording', message: `${key()} to finish. Escape to cancel.`, recordingStartedAt: Date.now() })
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
      emit({ phase: 'ready', message: `Recording cancelled. ${key()} to try again.`, recordingStartedAt: null })
    },
    setSettings: async (patch) => emit({ settings: { ...state.settings, ...patch } }),
    setLaunchAtLogin: async (enabled) => emit({ launchAtLogin: enabled }),
    openLoginItems: () => {},
    retryShortcut: () => emit({ shortcutRegistered: true }),
    setShortcut: async (action, value) => {
      const checked = checkShortcut(value, action === 'dictate')
      if ('error' in checked) return { ok: false, feedback: checked.error }
      const shortcuts = state.settings.shortcuts
      const clash = (Object.keys(shortcuts) as ShortcutAction[]).find((other) => other !== action && sameShortcut(shortcuts[other], checked.shortcut))
      if (clash) return { ok: false, feedback: `${shortcutName(checked.shortcut)} is already set for “${ACTION_NAMES[clash]}”.` }
      emit({ settings: { ...state.settings, shortcuts: { ...shortcuts, [action]: checked.shortcut } } })
      return { ok: true, feedback: '' }
    },
    captureShortcut: () => {},
    requestMicrophone: () => emit({ microphoneAllowed: true }),
    requestAccessibility: () => emit({ accessibilityAllowed: true }),
    checkForUpdates: async () => emit({ update: { ...state.update, phase: 'checking' } }),
    installUpdate: () => emit({ update: { ...state.update, phase: 'downloading', progress: 0.42 } }),
    reloadModels: () => {
      emit({ phase: 'preparing', message: 'Preparing local models.' })
      after(1600, () => emit({ phase: 'ready', message: `${key()} to start. Press again to finish.` }))
    },
    copyText: async (text) => { try { await navigator.clipboard.writeText(text) } catch { /* preview only */ } },
    learnCorrection: async () => {
      emit({ correction: { id: 'demo-correction', original: 'Ask queen to tidy the wording.', corrected: 'Ask Qwen to tidy the wording.' } })
      return 'Review the correction before saving it.'
    },
    previewCorrection: async () => {
      emit({ correction: { id: 'demo-correction', original: 'Ask queen to tidy the wording.', corrected: 'Ask Qwen to tidy the wording.' } })
      return { ok: true, feedback: 'Review the correction before saving it.' }
    },
    saveCorrection: async () => { emit({ correction: null, settings: { ...state.settings, learnCorrections: true } }); return { ok: true, feedback: 'Correction saved on this Mac.' } },
    dismissCorrection: () => emit({ correction: null }),
    startMicTest: async () => {
      emit({ micTestActive: true })
      window.clearInterval(levelTimer)
      levelTimer = window.setInterval(() => listeners.level.forEach((callback) => callback(0.2 + Math.random() * 0.4)), 50)
      after(15000, () => { if (state.micTestActive) { window.clearInterval(levelTimer); emit({ micTestActive: false }) } })
      return { ok: true, feedback: 'Speak to check the level. The test stops after 15 seconds.' }
    },
    stopMicTest: () => { if (state.micTestActive) { window.clearInterval(levelTimer); emit({ micTestActive: false }) } },
    addWord: async (word, alias, replaceId) => {
      const clean = word.trim()
      if (!clean) return { ok: false, feedback: 'Type the word the way you want it spelled.' }
      const target = replaceId ? vocabulary.find((entry) => entry.id === replaceId) : undefined
      const existing = vocabulary.find((entry) => entry.id !== target?.id && entry.word.toLowerCase() === clean.toLowerCase())
      if (target) {
        vocabulary = vocabulary
          .filter((entry) => entry.id !== existing?.id)
          .map((entry) => (entry.id === target.id ? { ...entry, word: clean, alias: alias.trim() } : entry))
        emit({ vocabulary })
        return { ok: true, feedback: `Updated “${clean}”.` }
      }
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
    saveSnippet: async (trigger, content, replaceId) => {
      const clean = trigger.trim().replace(/\s+/g, ' ')
      if (!clean) return { ok: false, feedback: 'Type the words you’ll say.' }
      if (!content.trim()) return { ok: false, feedback: 'Type the text Dictait should paste.' }
      if (content.length > SNIPPET_CHARS) return { ok: false, feedback: `Keep a snippet under ${SNIPPET_CHARS.toLocaleString('en-US')} characters.` }
      const key = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
      const existing = snippets.find((entry) => entry.id === replaceId) ?? snippets.find((entry) => key(entry.trigger) === key(clean))
      if (!existing && snippets.length >= SNIPPET_LIMIT) return { ok: false, feedback: `Dictait keeps up to ${SNIPPET_LIMIT} snippets.` }
      snippets = existing ? snippets.map((entry) => (entry === existing ? { ...entry, trigger: clean, content } : entry))
        : [...snippets, { id: `s${Date.now()}`, trigger: clean, content }]
      emit({ snippets })
      return { ok: true, feedback: existing ? `Updated “${clean}”.` : `Added “${clean}”. Say it in your next dictation.` }
    },
    removeSnippet: async (id) => {
      const entry = snippets.find((item) => item.id === id)
      snippets = snippets.filter((item) => item.id !== id)
      emit({ snippets })
      return { ok: true, feedback: entry ? `Removed “${entry.trigger}”.` : 'Snippet removed.' }
    },
    restoreSnippet: async (entry, index) => {
      snippets = [...snippets.slice(0, index), entry, ...snippets.slice(index)]
      emit({ snippets })
      return { ok: true, feedback: `Restored “${entry.trigger}”.` }
    },
    retryRecording: async (id) => {
      if (state.phase !== 'ready') return { ok: false, feedback: 'Finish the current dictation first, then retry.' }
      recovered = recovered.filter((item) => item.id !== id)
      emit({ recovered })
      finish()
      return { ok: true, feedback: 'Retrying your saved recording.' }
    },
    deleteRecording: async (id) => {
      recovered = recovered.filter((item) => item.id !== id)
      emit({ recovered })
      return { ok: true, feedback: 'Recording deleted.' }
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
    const copy = pinned === 'copied' ? ['Copied · ready to paste', `Focus a text box, then ⌘V · ${shortcutKeys(DEFAULT_SHORTCUTS.pasteLast).join('')} repeats the last dictation`] : step?.slice(1, 3)
    const timer = window.setTimeout(() => callback({
      visible: true, kind: pinned, title: String(copy?.[0] ?? 'Needs attention'), detail: String(copy?.[1] ?? 'The model worker stopped. Click Retry to reload models.'),
      startedAt: Date.now() - 12_000, screen, live: pinned === 'recording' && params.get('mode') !== 'translate' ? 'so the plan is to ship the preview build on Friday and then' : '', note: '',
      holding: params.get('mode') === 'hold', holdStartedAt: params.get('mode') === 'pending' ? Date.now() : null, editing: false,
      translating: params.get('mode') === 'translate',
      destination: { app: 'com.t3tools.t3code', appName: 'T3 Code', icon: '', editable: true }, microphone: 'MacBook Air Microphone', micQuiet: params.get('quiet') === '1',
      shortcut: shortcutKeys(DEFAULT_SHORTCUTS[params.get('mode') === 'translate' ? 'translate' : 'dictate']).join(' ')
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
    callback({ visible: kind !== null, kind: kind ?? last, title, detail, startedAt: kind === 'recording' ? Date.now() : null, screen, live: '', note: '', holding: false, holdStartedAt: null, editing: false, translating: false,
      destination: { app: 'com.t3tools.t3code', appName: 'T3 Code', icon: '', editable: true }, microphone: 'MacBook Air Microphone', micQuiet: false,
      shortcut: shortcutKeys(DEFAULT_SHORTCUTS.dictate).join(' ') })
    timer = window.setTimeout(next, duration)
  }
  timer = window.setTimeout(next, 500)
  return () => window.clearTimeout(timer)
}
