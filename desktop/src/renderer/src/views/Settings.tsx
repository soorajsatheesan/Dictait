import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { RotateCw } from 'lucide-react'
import { DEFAULT_SHORTCUTS, sameShortcut, shortcutKeys, shortcutName, type Shortcut } from '@shared/shortcuts'
import type { AppState, MediaMode, Microphone, Settings, Tones } from '@shared/types'
import { Keys, Segmented, Switch, useToast } from '../components/ui'
import { ShortcutField } from '../components/ShortcutField'
import { snappy } from '../lib/motion'
import { api } from '../lib/store'
import { MicrophoneTest } from '../components/MicrophoneTest'

export function SettingsView({ state, onPractice }: { state: AppState; onPractice: () => void }) {
  const toast = useToast()
  const { settings } = state
  const editable = ['ready', 'failed'].includes(state.phase)
  const set = (patch: Partial<Settings>) => { void api.setSettings(patch) }

  return (
    <div className="settings scroll-area">
      <div className="settings-inner">
        <Health state={state} />

        <Group title="Dictation">
          <DictateShortcutRow state={state} />
          <ChordRow title="Paste last dictation" action="pasteLast" value={settings.shortcuts.pasteLast}
            detail="Puts your latest dictation at the cursor again. Recent ones are in the menu bar too." />
          <ChordRow title="Review a correction" action="learnCorrection" value={settings.shortcuts.learnCorrection}
            detail={state.correctionShortcutRegistered ? 'Select your corrected dictation in any app and press this to review and save it.'
              : `${shortcutName(settings.shortcuts.learnCorrection)} is in use by another app. Choose a different one.`} />
          <Row title="Cancel a recording" detail="Throws the audio away. Nothing is transcribed or saved.">
            <Keys keys={['esc']} />
          </Row>
          <Row title="Recording sounds" detail="Soft cues when recording starts and finishes. Visual feedback is always shown.">
            <Switch label="Recording sounds" on={settings.feedbackSounds} onChange={(value) => set({ feedbackSounds: value })} />
          </Row>
          <Row title="While recording" detail={mediaDetail[settings.whileRecording]}>
            <Segmented label="While recording" value={settings.whileRecording} onChange={(value) => set({ whileRecording: value })}
              options={[{ value: 'keep', label: 'Keep playing' }, { value: 'duck', label: 'Lower volume' }, { value: 'pause', label: 'Pause media' }]} />
          </Row>
          <Row title="Try the controls" detail="Practise tap-to-record, hold-to-talk and voice editing inside Dictait.">
            <button type="button" className="btn secondary" onClick={onPractice}>Open Practice</button>
          </Row>
          <Row title="Paste into the focused app" detail="Otherwise your words wait on the clipboard for ⌘V.">
            <Switch label="Paste automatically" on={settings.autoPaste} onChange={(value) => set({ autoPaste: value })} />
          </Row>
          <Row title="Launch at login" detail={state.loginNeedsApproval ? 'macOS needs your approval in Login Items.' : 'Starts quietly in the menu bar.'}>
            {state.loginNeedsApproval && <button type="button" className="btn ghost" onClick={() => api.openLoginItems()}>Approve…</button>}
            <Switch label="Launch at login" on={state.launchAtLogin} onChange={(value) => void api.setLaunchAtLogin(value)} />
          </Row>
        </Group>

        <Group title="Speech" note={!editable ? 'Model choices unlock when Dictait is idle.' : undefined}>
          <div className="choice-cards" role="radiogroup" aria-label="Speech model">
            <Choice active={settings.backend === 'whisper'} disabled={!editable} onClick={() => set({ backend: 'whisper' })}
              title="Whisper Turbo" tag="Default" detail="Broad multilingual coverage, including Hindi." />
            <Choice active={settings.backend === 'parakeet'} disabled={!editable} onClick={() => set({ backend: 'parakeet' })}
              title="Parakeet" detail="Quick English and European languages. No Hindi." />
          </div>
          <MicrophoneRow value={settings.microphone} onChange={(value) => set({ microphone: value })} />
          <MicrophoneTest state={state} />
          <Row title="Language" detail="Choosing English skips detection and is a touch faster.">
            <Segmented label="Language" value={settings.language} disabled={!editable} onChange={(value) => set({ language: value })}
              options={[{ value: 'auto', label: 'Detect' }, { value: 'en', label: 'English' }, { value: 'hi', label: 'Hindi', disabled: settings.backend !== 'whisper', hint: 'Whisper only' }]} />
          </Row>
        </Group>

        <Group title="Writing">
          <Row title="Fix grammar and punctuation" detail="A local Qwen model removes fillers and tidies sentences, keeping your words.">
            <Switch label="Fix grammar" on={settings.cleanup} disabled={!editable} onChange={(value) => set({ cleanup: value })} />
          </Row>
          <Row title="Follow spoken instructions" detail={<>Say “make this into bullet points” or “format this as an email” at the start or end.</>}>
            <Switch label="Follow spoken instructions" on={settings.smartFormatting} onChange={(value) => set({ smartFormatting: value })} />
          </Row>
          <Row title="Use the text around your cursor" detail="Reads the sentence before your cursor so names, spelling and flow match. Never saved, never leaves this Mac.">
            <Switch label="Use text around the cursor" on={settings.useContext} onChange={(value) => set({ useContext: value })} />
          </Row>
          <Row title="Edit selected text by voice" detail={<>Select text, press <Keys keys={shortcutKeys(settings.shortcuts.dictate)} small /> and say “make this shorter” or “translate to Hindi”.</>}>
            <Switch label="Edit selected text by voice" on={settings.voiceEdits} onChange={(value) => set({ voiceEdits: value })} />
          </Row>
          <ToneRow on={settings.appTones} tones={settings.tones} onToggle={(value) => set({ appTones: value })} onTones={(tones) => set({ tones })} />
          <StyleField value={settings.writingStyle} onSave={(value) => set({ writingStyle: value })} />
        </Group>

        <Group title="Voice commands">
          <div className="commands">
            {[
              ['“Scratch that”', 'Removes the sentence you just said'],
              ['“No, at six”', 'Corrections keep only what you meant'],
              ['“New line” · “New paragraph”', 'Breaks the text where you say it'],
              ['“In bullet points” · “Number these”', 'At the start or end of what you say'],
              ['“Summarize this”', 'Keeps names, numbers and facts'],
              ['“Format this as an email”', 'Uses only what you said'],
              ['“Make this shorter” · “more formal”', 'Also “friendlier”; at the start or end'],
            ].map(([phrase, effect]) => (
              <div key={phrase} className="command"><span className="command-phrase">{phrase}</span><span className="command-effect">{effect}</span></div>
            ))}
          </div>
        </Group>

        <Group title="Memory">
          <div className="choice-cards three" role="radiogroup" aria-label="Remember">
            <Choice active={settings.memoryMode === 'notes'} onClick={() => set({ memoryMode: 'notes' })} title="Notes & connections" tag="Default" detail="Every dictation is searchable, linked by the terms in it." />
            <Choice active={settings.memoryMode === 'terms'} onClick={() => set({ memoryMode: 'terms' })} title="Terms only" detail="Learn names and topics; don’t keep the text." />
            <Choice active={settings.memoryMode === 'off'} onClick={() => set({ memoryMode: 'off' })} title="Off" detail="Nothing new is learned or used." />
          </div>
          <Row title="Learn from corrections" detail={state.correctionShortcutRegistered ? <>Select your corrected dictation and press <Keys keys={shortcutKeys(settings.shortcuts.learnCorrection)} small />. Review both versions before saving.</>
            : `${shortcutName(settings.shortcuts.learnCorrection)} is unavailable. Review from clipboard, or choose another shortcut under Dictation.`}>
            <button type="button" className="btn secondary" disabled={!state.transcript || !editable} onClick={() => void api.learnCorrection().then((feedback) => { if (!feedback.startsWith('Review')) toast(feedback) })}>Review from clipboard</button>
            <Switch label="Learn from corrections" on={settings.learnCorrections} onChange={(value) => set({ learnCorrections: value })} />
          </Row>
          <Row title="Your notes on disk" detail="Plain Markdown with a graph, ready for Obsidian.">
            <button type="button" className="btn secondary" onClick={() => api.openFolder('notes')}>Open folder</button>
          </Row>
        </Group>

        <Group title="Appearance">
          <Row title="Theme" detail="Follow macOS, or keep one look.">
            <Segmented label="Theme" value={settings.appearance} onChange={(value) => set({ appearance: value })}
              options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
          </Row>
        </Group>

        <Group title="Updates">
          <UpdateRow state={state} />
          <Row title="Check automatically" detail="Looks for new releases on GitHub now and then. Nothing installs until you choose Update.">
            <Switch label="Check for updates automatically" on={settings.autoUpdate} onChange={(value) => set({ autoUpdate: value })} />
          </Row>
        </Group>

        <p className="settings-foot faint">Dictait runs entirely on this Mac. Audio is deleted after transcription. No account, no cloud, no telemetry.</p>
      </div>
    </div>
  )
}

const mediaDetail: Record<MediaMode, string> = {
  keep: 'Music and videos keep playing while you dictate.',
  duck: 'Turns the Mac’s volume down to a quarter while you dictate, then back to where it was.',
  pause: 'Pauses music and videos while you dictate, then resumes only what was playing.'
}

type Preset = 'controlSpace' | 'rightCommand' | 'rightOption' | 'fn'
const presets: Record<Preset, Shortcut> = {
  controlSpace: DEFAULT_SHORTCUTS.dictate,
  rightCommand: { kind: 'modifier', key: 'rightCommand' },
  rightOption: { kind: 'modifier', key: 'rightOption' },
  fn: { kind: 'modifier', key: 'fn' }
}

function presetOf(shortcut: Shortcut): Preset | 'custom' {
  return (Object.keys(presets) as Preset[]).find((preset) => sameShortcut(presets[preset], shortcut)) ?? 'custom'
}

function dictateDetail(shortcut: Shortcut): string {
  if (shortcut.kind === 'chord') return 'Tap to start and tap to finish. Hold for 1.2 seconds for hold-to-talk, then release to finish.'
  if (shortcut.key === 'fn') return 'Tap fn on its own to start and finish, or hold it to talk. In System Settings → Keyboard, set “Press fn key to” to “Do Nothing”.'
  return `Tap ${shortcutName(shortcut)} on its own to start and finish, or hold it to talk. Shortcuts that use it${shortcut.key === 'rightCommand' ? ', like ⌘C,' : ''} still work.`
}

/** A preset (Control–Space or a single modifier key) or a shortcut the user records. */
function DictateShortcutRow({ state }: { state: AppState }) {
  const shortcut = state.settings.shortcuts.dictate
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState('')
  const preset = presetOf(shortcut)
  const choose = (value: Preset | 'custom') => {
    setError('')
    if (value === 'custom') { setRecording(true); return }
    void api.setShortcut('dictate', presets[value]).then((result) => { if (!result.ok) setError(result.feedback) })
  }
  const watching = shortcut.kind === 'modifier'
  const detail = error ? <span className="row-error">{error}</span>
    : recording ? 'Press the keys you want to use, including at least Control, or Command with another modifier. Escape cancels.'
      : !state.shortcutRegistered ? <span className="row-error">{watching ? `Dictait needs Accessibility permission to watch ${shortcutName(shortcut)}.`
        : sameShortcut(shortcut, DEFAULT_SHORTCUTS.dictate) ? 'Another app or macOS is using Control–Space. Choose another shortcut, or turn off Control–Space for input sources in Keyboard settings.'
          : `Another app or macOS is using ${shortcutName(shortcut)}. Choose another shortcut.`}</span>
        : dictateDetail(shortcut)
  return (
    <Row title="Start and finish" detail={detail}>
      {!state.shortcutRegistered && !recording && (watching
        ? <button type="button" className="btn ghost" onClick={() => api.requestAccessibility()}>Allow…</button>
        : <button type="button" className="btn ghost" onClick={() => api.retryShortcut()}><RotateCw size={13} /> Retry</button>)}
      {(preset === 'custom' || recording) && (
        <ShortcutField key={recording ? 'recording' : 'idle'} label="Start and finish" value={preset === 'custom' ? shortcut : null} autoStart={recording}
          onRecord={(next) => api.setShortcut('dictate', next)}
          onDone={(result) => { setRecording(false); setError(result && !result.ok ? result.feedback : '') }} />
      )}
      <select className="select" aria-label="Dictation shortcut" value={recording ? 'custom' : preset} onChange={(event) => choose(event.target.value as Preset | 'custom')}>
        <option value="controlSpace">Control–Space</option>
        <option value="rightCommand">Right Command</option>
        <option value="rightOption">Right Option</option>
        <option value="fn">fn key</option>
        <option value="custom">{preset === 'custom' ? 'Custom' : 'Custom…'}</option>
      </select>
    </Row>
  )
}

function ChordRow({ title, action, value, detail }: { title: string; action: 'pasteLast' | 'learnCorrection'; value: Shortcut; detail: string }) {
  const [error, setError] = useState('')
  return (
    <Row title={title} detail={error ? <span className="row-error">{error}</span> : detail}>
      <ShortcutField label={title} value={value} onRecord={(next) => api.setShortcut(action, next)}
        onDone={(result) => setError(result && !result.ok ? result.feedback : '')} />
    </Row>
  )
}

function UpdateRow({ state }: { state: AppState }) {
  const { update, version } = state
  const checked = update.checkedAt ? ` Checked ${new Date(update.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''
  const detail = {
    idle: `You have version ${version}.`,
    checking: 'Checking GitHub for a new release…',
    current: `You have the latest version.${checked}`,
    available: `Version ${update.version} is ready.${update.notes ? ` ${update.notes.split('\n').find((line) => line.trim())?.replace(/^[#*\s-]+/, '') ?? ''}` : ''}`,
    downloading: `Downloading version ${update.version}… ${Math.round(update.progress * 100)}%`,
    installing: 'Installing. Dictait will reopen in a moment.',
    failed: update.error
  }[update.phase]
  return (
    <Row title={`Dictait ${version}`} detail={detail}>
      {update.phase === 'available' && <button type="button" className="btn primary" onClick={() => api.installUpdate()}>Update now</button>}
      {update.phase === 'downloading' && <span className="update-meter" aria-hidden><span style={{ transform: `scaleX(${Math.max(0.02, update.progress)})` }} /></span>}
      {['idle', 'current', 'failed'].includes(update.phase) && <button type="button" className="btn secondary" onClick={() => void api.checkForUpdates()}>Check now</button>}
    </Row>
  )
}

function Health({ state }: { state: AppState }) {
  const autoPasteOff = !state.settings.autoPaste
  const checks = [
    { label: 'Microphone', ok: state.microphoneAllowed, muted: false, stateText: 'On', actionLabel: 'Allow…', fix: () => api.requestMicrophone() },
    { label: 'Auto-paste', ok: state.accessibilityAllowed || autoPasteOff, muted: autoPasteOff, stateText: autoPasteOff ? 'Off' : 'On', actionLabel: 'Allow…', fix: () => api.requestAccessibility() },
    { label: 'Shortcut', ok: state.shortcutRegistered, muted: false, stateText: 'On', actionLabel: 'Retry', fix: () => api.retryShortcut() }
  ]
  const failed = state.phase === 'failed'
  const preparing = state.phase === 'preparing'
  const allSet = checks.every((check) => check.ok) && !failed && !preparing
  const title = failed ? 'Dictait needs attention' : preparing ? 'Warming up your models' : allSet ? 'Ready' : 'Almost there'
  return (
    <section className={`health leak ${failed ? 'failed' : allSet ? 'ok' : 'pending'}`}>
      <div className="health-main">
        <div className="health-text">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.h2 key={title} className="display health-title" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={snappy}>{title}</motion.h2>
          </AnimatePresence>
          <p className="muted health-message">{state.message}{state.timing && state.phase === 'ready' ? ` Last dictation: ${state.timing}.` : ''}</p>
          {state.notice && <p className="health-notice">{state.notice}</p>}
        </div>
        {failed && <button type="button" className="btn primary" onClick={() => api.reloadModels()}><RotateCw size={13} /> Retry models</button>}
      </div>
      <div className="health-checks">
        {checks.map(({ label, ok, muted, stateText, actionLabel, fix }) => (
          <div key={label} className={`check ${ok ? (muted ? '' : 'ok') : 'needed'}`}>
            <span>{label}</span>
            {ok ? <span className="check-state">{stateText}</span> : <button type="button" className="check-fix" onClick={fix}>{actionLabel}</button>}
          </div>
        ))}
      </div>
    </section>
  )
}

function Group({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="group">
      <div className="group-head">
        <h3 className="eyebrow">{title}</h3>
        {note && <span className="group-note faint">{note}</span>}
      </div>
      <div className="group-body">{children}</div>
    </section>
  )
}

function Row({ title, detail, children }: { title: string; detail: ReactNode; children: ReactNode }) {
  return (
    <div className="row">
      <div className="row-text">
        <div className="row-title">{title}</div>
        <div className="row-detail">{detail}</div>
      </div>
      <div className="row-control">{children}</div>
    </div>
  )
}

function Choice({ active, title, detail, tag, onClick, disabled = false }: { active: boolean; title: string; detail: string; tag?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" role="radio" aria-checked={active} disabled={disabled} className={`choice ${active ? 'active' : ''}`} onClick={onClick}>
      <span className="choice-radio">{active && <motion.span className="choice-radio-dot" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={snappy} />}</span>
      <span className="choice-title">{title}{tag && <span className="choice-tag">{tag}</span>}</span>
      <span className="choice-detail">{detail}</span>
    </button>
  )
}

/** "Automatic" avoids Bluetooth headset microphones, which drop the headset to low-quality sound. */
function MicrophoneRow({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [devices, setDevices] = useState<Microphone[]>([])
  useEffect(() => {
    let alive = true
    const refresh = () => { void api.microphones().then((next) => { if (alive) setDevices(next) }) }
    refresh()
    navigator.mediaDevices?.addEventListener('devicechange', refresh)
    return () => { alive = false; navigator.mediaDevices?.removeEventListener('devicechange', refresh) }
  }, [])
  const current = devices.find((device) => device.default)
  const alternative = devices.find((device) => device.transport === 'builtin') ?? devices.find((device) => device.transport === 'usb')
  const detail = value === 'auto'
    ? current?.transport === 'bluetooth' && alternative ? `Uses ${alternative.name}, so ${current.name} keeps full sound quality.` : 'Avoids Bluetooth headset mics when another input is available.'
    : value === 'system' ? `Follows macOS${current ? `: ${current.name}` : ''}.` : 'Always this microphone, when connected.'
  return (
    <Row title="Microphone" detail={detail}>
      <select className="select" value={value} onChange={(event) => { api.stopMicTest(); onChange(event.target.value) }} aria-label="Microphone">
        <option value="auto">Automatic</option>
        <option value="system">macOS default</option>
        {devices.length > 0 && <option disabled>──────────</option>}
        {devices.map((device, index) => <option key={`${device.name}-${index}`} value={device.name}>{device.name}{device.transport === 'bluetooth' ? ' (Bluetooth)' : ''}</option>)}
        {!['auto', 'system'].includes(value) && !devices.some((device) => device.name === value) && <option value={value}>{value} (not connected)</option>}
      </select>
    </Row>
  )
}

const toneLabels: [keyof Tones, string, string][] = [
  ['ai', 'AI assistants', 'ChatGPT, Codex, Claude, Claude Code, Gemini'],
  ['messaging', 'Messages & chat', 'Messages, Slack, WhatsApp, Discord, Teams'],
  ['email', 'Email', 'Mail, Outlook, Spark, Superhuman'],
  ['code', 'Code', 'VS Code, Cursor, Xcode, Zed, Terminal, Ghostty'],
  ['docs', 'Notes & docs', 'Notes, Notion, Obsidian, Word, Pages']
]

/** Per-app tone: one sentence per kind of app, applied when you dictate there. */
function ToneRow({ on, tones, onToggle, onTones }: { on: boolean; tones: Tones; onToggle: (value: boolean) => void; onTones: (tones: Tones) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Row title="Match the app you’re in" detail="Clear requests for AI assistants, casual in chat, polished in email, literal in code. Edit how each sounds.">
        <button type="button" className="btn ghost" onClick={() => setOpen(!open)}>{open ? 'Done' : 'Customize'}</button>
        <Switch label="Match the app" on={on} onChange={onToggle} />
      </Row>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="tones" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={snappy}>
            {toneLabels.map(([key, label, apps]) => (
              <label key={key} className="tone">
                <span className="tone-label">{label}<span className="faint"> · {apps}</span></span>
                <ToneInput value={tones[key]} onSave={(value) => onTones({ ...tones, [key]: value })} />
              </label>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

function ToneInput({ value, onSave }: { value: string; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return <input value={draft} maxLength={300} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== value) onSave(draft) }}
    onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur() }} />
}

/** Writing style saves as you pause typing, on blur, and before unmount. */
function StyleField({ value, onSave }: { value: string; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState(value)
  const [saved, setSaved] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const savedTimer = useRef<number | undefined>(undefined)
  const focused = useRef(false)
  const latestDraft = useRef(value)
  const latestValue = useRef(value)
  const latestSave = useRef(onSave)
  latestValue.current = value
  latestSave.current = onSave
  useEffect(() => {
    if (!focused.current) { setDraft(value); latestDraft.current = value }
  }, [value])
  useEffect(() => () => {
    window.clearTimeout(timer.current)
    window.clearTimeout(savedTimer.current)
    if (latestDraft.current !== latestValue.current) latestSave.current(latestDraft.current)
  }, [])
  const commit = (next: string) => {
    window.clearTimeout(timer.current)
    if (next !== latestValue.current) {
      latestValue.current = next
      latestSave.current(next)
      setSaved(true)
      window.clearTimeout(savedTimer.current)
      savedTimer.current = window.setTimeout(() => setSaved(false), 1400)
    }
  }
  return (
    <div className="style-field">
      <div className="style-head">
        <div>
          <div className="row-title">Your writing style</div>
          <div className="row-detail">Plain words. Applied to every cleanup, with your saved corrections.</div>
        </div>
        <AnimatePresence>{saved && <motion.span className="saved-pill" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={snappy}>Saved</motion.span>}</AnimatePresence>
      </div>
      <textarea value={draft} maxLength={300} rows={2} placeholder="e.g. Keep my casual tone; use short sentences."
        onFocus={() => { focused.current = true }}
        onBlur={() => { focused.current = false; commit(draft) }}
        onChange={(event) => {
          const next = event.target.value
          setDraft(next)
          latestDraft.current = next
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => commit(next), 700)
        }} />
      <div className="style-count faint mono">{draft.length} / 300</div>
    </div>
  )
}
