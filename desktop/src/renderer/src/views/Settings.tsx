import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Accessibility, AppWindow, AudioLines, Brain, ClipboardCheck, ClipboardPaste, Download, FolderOpen, Keyboard, Languages, Mic, Monitor,
  Moon, PenLine, Power, RefreshCcw, RotateCw, Sparkles, Sun, TextCursorInput, Wand2, type LucideIcon
} from 'lucide-react'
import type { AppState, Microphone, Settings, Tones } from '@shared/types'
import { Keys, Segmented, Switch, useToast } from '../components/ui'
import { snappy } from '../lib/motion'
import { api } from '../lib/store'

export function SettingsView({ state }: { state: AppState }) {
  const toast = useToast()
  const { settings } = state
  const editable = ['ready', 'failed'].includes(state.phase)
  const set = (patch: Partial<Settings>) => { void api.setSettings(patch) }

  return (
    <div className="settings scroll-area">
      <div className="settings-inner">
        <Health state={state} />

        <Group title="Dictation">
          <Row icon={Keyboard} title="Start and finish" detail={state.shortcutRegistered ? 'Tap to start and tap to finish, or hold while you talk and let go.' : 'Another app or macOS is using Control–Space.'}>
            {state.shortcutRegistered ? <Keys keys={['⌃', 'Space']} /> : <button type="button" className="btn secondary" onClick={() => api.retryShortcut()}><RotateCw size={13} /> Retry</button>}
          </Row>
          <Row icon={ClipboardPaste} title="Paste last dictation" detail="Puts your latest dictation at the cursor again. Recent ones are in the menu bar too.">
            <Keys keys={['⌃', '⌥', 'V']} />
          </Row>
          <Row icon={AudioLines} title="Cancel a recording" detail="Throws the audio away. Nothing is transcribed or saved.">
            <Keys keys={['esc']} />
          </Row>
          <Row icon={ClipboardCheck} title="Paste into the focused app" detail="Otherwise your words wait on the clipboard for ⌘V.">
            <Switch label="Paste automatically" on={settings.autoPaste} onChange={(value) => set({ autoPaste: value })} />
          </Row>
          <Row icon={Power} title="Launch at login" detail={state.loginNeedsApproval ? 'macOS needs your approval in Login Items.' : 'Starts quietly in the menu bar.'}>
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
          <Row icon={Languages} title="Language" detail="Choosing English skips detection and is a touch faster.">
            <Segmented label="Language" value={settings.language} disabled={!editable} onChange={(value) => set({ language: value })}
              options={[{ value: 'auto', label: 'Detect' }, { value: 'en', label: 'English' }, { value: 'hi', label: 'Hindi', disabled: settings.backend !== 'whisper', hint: 'Whisper only' }]} />
          </Row>
        </Group>

        <Group title="Writing">
          <Row icon={Sparkles} title="Fix grammar and punctuation" detail="A local Qwen model removes fillers and tidies sentences, keeping your words.">
            <Switch label="Fix grammar" on={settings.cleanup} disabled={!editable} onChange={(value) => set({ cleanup: value })} />
          </Row>
          <Row icon={Wand2} title="Follow spoken instructions" detail={<>Say “make this into bullet points” or “format this as an email” at the start or end.</>}>
            <Switch label="Follow spoken instructions" on={settings.smartFormatting} onChange={(value) => set({ smartFormatting: value })} />
          </Row>
          <Row icon={TextCursorInput} title="Use the text around your cursor" detail="Reads the sentence before your cursor so names, spelling and flow match. Never saved, never leaves this Mac.">
            <Switch label="Use text around the cursor" on={settings.useContext} onChange={(value) => set({ useContext: value })} />
          </Row>
          <Row icon={PenLine} title="Edit selected text by voice" detail={<>Select text, press <Keys keys={['⌃', 'Space']} small /> and say “make this shorter” or “translate to Hindi”.</>}>
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
          <Row icon={Brain} title="Learn from corrections" detail="Fix a pasted dictation, copy it, then teach Dictait the difference.">
            <button type="button" className="btn secondary" disabled={!state.transcript} onClick={() => void api.learnCorrection().then((feedback) => toast(feedback))}>Learn from clipboard</button>
            <Switch label="Learn from corrections" on={settings.learnCorrections} onChange={(value) => set({ learnCorrections: value })} />
          </Row>
          <Row icon={FolderOpen} title="Your notes on disk" detail="Plain Markdown with a graph, ready for Obsidian.">
            <button type="button" className="btn secondary" onClick={() => api.openFolder('notes')}>Open folder</button>
          </Row>
        </Group>

        <Group title="Appearance">
          <Row icon={settings.appearance === 'dark' ? Moon : settings.appearance === 'light' ? Sun : Monitor} title="Theme" detail="Follow macOS, or keep one look.">
            <Segmented label="Theme" value={settings.appearance} onChange={(value) => set({ appearance: value })}
              options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
          </Row>
        </Group>

        <Group title="Updates">
          <UpdateRow state={state} />
          <Row icon={RefreshCcw} title="Check automatically" detail="Looks for new releases on GitHub now and then. Nothing installs until you choose Update.">
            <Switch label="Check for updates automatically" on={settings.autoUpdate} onChange={(value) => set({ autoUpdate: value })} />
          </Row>
        </Group>

        <p className="settings-foot faint">Dictait runs entirely on this Mac. Audio is deleted after transcription. No account, no cloud, no telemetry.</p>
      </div>
    </div>
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
    <Row icon={Download} title={`Dictait ${version}`} detail={detail}>
      {update.phase === 'available' && <button type="button" className="btn primary" onClick={() => api.installUpdate()}>Update now</button>}
      {update.phase === 'downloading' && <span className="update-meter" aria-hidden><span style={{ transform: `scaleX(${Math.max(0.02, update.progress)})` }} /></span>}
      {['idle', 'current', 'failed'].includes(update.phase) && <button type="button" className="btn secondary" onClick={() => void api.checkForUpdates()}>Check now</button>}
    </Row>
  )
}

function Health({ state }: { state: AppState }) {
  const checks = [
    { label: 'Microphone', ok: state.microphoneAllowed, fix: () => api.requestMicrophone(), icon: Mic },
    { label: 'Auto-paste', ok: state.accessibilityAllowed || !state.settings.autoPaste, fix: () => api.requestAccessibility(), icon: Accessibility },
    { label: 'Shortcut', ok: state.shortcutRegistered, fix: () => api.retryShortcut(), icon: Keyboard }
  ]
  const failed = state.phase === 'failed'
  const preparing = state.phase === 'preparing'
  const allSet = checks.every((check) => check.ok) && !failed && !preparing
  const title = failed ? 'Dictait needs attention' : preparing ? 'Warming up your models' : allSet ? 'All set. Talk anywhere.' : 'Almost there'
  return (
    <section className={`health ${failed ? 'failed' : allSet ? 'ok' : ''}`}>
      <div className="health-main">
        <div className="health-orb" aria-hidden><span /></div>
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
        {checks.map(({ label, ok, fix, icon: Icon }) => (
          <div key={label} className={`check ${ok ? 'ok' : 'needed'}`}>
            <Icon size={14} strokeWidth={2} />
            <span>{label}</span>
            {ok ? <span className="check-state">On</span> : <button type="button" className="check-fix" onClick={fix}>Allow…</button>}
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

function Row({ icon: Icon, title, detail, children }: { icon: LucideIcon; title: string; detail: ReactNode; children: ReactNode }) {
  return (
    <div className="row">
      <span className="row-icon"><Icon size={15} strokeWidth={1.9} /></span>
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
  useEffect(() => { void api.microphones().then(setDevices) }, [])
  const current = devices.find((device) => device.default)
  const detail = value === 'auto'
    ? current?.transport === 'bluetooth' ? `Using the built-in mic, so ${current.name} keeps full sound quality.` : 'Avoids Bluetooth headset mics, which lower audio quality.'
    : value === 'system' ? `Follows macOS${current ? `: ${current.name}` : ''}.` : 'Always this microphone, when connected.'
  return (
    <Row icon={Mic} title="Microphone" detail={detail}>
      <select className="select" value={value} onChange={(event) => onChange(event.target.value)} aria-label="Microphone">
        <option value="auto">Automatic</option>
        <option value="system">macOS default</option>
        {devices.length > 0 && <option disabled>──────────</option>}
        {devices.map((device) => <option key={device.name} value={device.name}>{device.name}{device.transport === 'bluetooth' ? ' (Bluetooth)' : ''}</option>)}
        {!['auto', 'system'].includes(value) && !devices.some((device) => device.name === value) && <option value={value}>{value} (not connected)</option>}
      </select>
    </Row>
  )
}

const toneLabels: [keyof Tones, string, string][] = [
  ['messaging', 'Messages & chat', 'Messages, Slack, WhatsApp, Discord, Teams'],
  ['email', 'Email', 'Mail, Outlook, Spark, Superhuman'],
  ['code', 'Code & AI', 'VS Code, Cursor, Xcode, Terminal, ChatGPT, Claude'],
  ['docs', 'Notes & docs', 'Notes, Notion, Obsidian, Word, Pages']
]

/** Per-app tone: one sentence per kind of app, applied when you dictate there. */
function ToneRow({ on, tones, onToggle, onTones }: { on: boolean; tones: Tones; onToggle: (value: boolean) => void; onTones: (tones: Tones) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Row icon={AppWindow} title="Match the app you’re in" detail="Casual in chat, polished in email, literal in code. Edit how each sounds.">
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

/** Writing style saves as you pause typing, and on blur. */
function StyleField({ value, onSave }: { value: string; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState(value)
  const [saved, setSaved] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setDraft(value) }, [value])
  const commit = (next: string) => {
    window.clearTimeout(timer.current)
    if (next !== value) { onSave(next); setSaved(true); window.setTimeout(() => setSaved(false), 1400) }
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
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => commit(next), 700)
        }} />
      <div className="style-count faint mono">{draft.length} / 300</div>
    </div>
  )
}
