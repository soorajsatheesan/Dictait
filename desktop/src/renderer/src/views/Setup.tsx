import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Check, Mic, RotateCw } from 'lucide-react'
import { shortcutKeys } from '@shared/shortcuts'
import type { AppState } from '@shared/types'
import { DotWave } from '../components/DotWave'
import { Keys, Mark } from '../components/ui'
import { smooth, snappy } from '../lib/motion'
import { api } from '../lib/store'

const gb = (bytes: number) => (bytes / 1e9).toFixed(2)
const steps = ['Welcome', 'Microphone', 'Paste', 'Voice model', 'Try it'] as const

/**
 * First run, one thing per screen. The voice model starts downloading the moment the app opens, so it
 * fills in behind the permission steps; its progress rides along at the bottom of every screen.
 */
export function SetupView({ state, onPractice }: { state: AppState; onPractice: () => void }) {
  // Previews can open a given step: ?section=setup&step=3
  const [step, setStep] = useState(() => api.preview ? Math.min(steps.length - 1, Number(new URLSearchParams(location.search).get('step')) || 0) : 0)
  const [direction, setDirection] = useState(1)
  const firstTranscript = useRef(state.transcript)
  const modelsReady = !['preparing', 'failed'].includes(state.phase)
  const keys = shortcutKeys(state.settings.shortcuts.dictate)
  const tried = modelsReady && Boolean(state.transcript) && state.transcript !== firstTranscript.current
  const finish = () => { void api.setSettings({ setupDone: true }) }
  const go = (next: number) => { setDirection(next > step ? 1 : -1); setStep(Math.max(0, Math.min(steps.length - 1, next))) }

  // A granted permission moves you on by itself, after a beat to see the tick.
  const granted = (step === 1 && state.microphoneAllowed) || (step === 2 && state.accessibilityAllowed)
  useEffect(() => {
    if (!granted) return
    const timer = window.setTimeout(() => go(step + 1), 900)
    return () => window.clearTimeout(timer)
  }, [granted]) // eslint-disable-line react-hooks/exhaustive-deps

  const primary: { label: string; run: () => void; disabled?: boolean } = (() => {
    switch (step) {
      case 0: return { label: 'Get started', run: () => go(1) }
      case 1: return state.microphoneAllowed ? { label: 'Continue', run: () => go(2) } : { label: 'Allow microphone', run: () => api.requestMicrophone() }
      case 2: return state.accessibilityAllowed ? { label: 'Continue', run: () => go(3) } : { label: 'Open System Settings', run: () => api.requestAccessibility() }
      case 3: return state.phase === 'failed' ? { label: 'Retry download', run: () => api.reloadModels() } : { label: modelsReady ? 'Continue' : 'Downloading…', run: () => go(4), disabled: !modelsReady }
      default: return { label: tried ? 'Start dictating' : 'Finish', run: finish }
    }
  })()

  return (
    <motion.div className="setup" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.25 } }}>
      
      <div className="setup-drag" />
      <header className="setup-top">
        <span className="setup-brand"><Mark size={18} chrome /><span>Dictait</span></span>
        <span className="setup-count">Step {step + 1} of {steps.length}</span>
        <button type="button" className="setup-skip" onClick={finish}>Skip setup</button>
      </header>
      <div className="setup-ticks" aria-hidden>
        {steps.map((name, index) => <span key={name} className={index < step ? 'done' : index === step ? 'now' : ''}><motion.i animate={{ scaleX: index <= step ? 1 : 0 }} transition={smooth} /></span>)}
      </div>

      <main className="setup-stage">
        <AnimatePresence mode="wait" custom={direction} initial={false}>
          <motion.section key={step} className="setup-page" custom={direction}
            initial={{ opacity: 0, x: direction * 28, filter: 'blur(6px)' }} animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, x: direction * -28, filter: 'blur(6px)', transition: { duration: 0.16 } }} transition={smooth}>
            {step === 0 && <Welcome keys={keys} />}
            {step === 1 && <Microphone allowed={state.microphoneAllowed} name={state.microphoneName} />}
            {step === 2 && <Paste allowed={state.accessibilityAllowed} />}
            {step === 3 && <Model state={state} ready={modelsReady} />}
            {step === 4 && <TryIt keys={keys} tried={tried} transcript={state.transcript} ready={modelsReady} onPractice={() => { finish(); onPractice() }} />}
          </motion.section>
        </AnimatePresence>
      </main>

      <footer className="setup-foot">
        <div className="setup-foot-left">
          {step > 0 && <button type="button" className="btn ghost" onClick={() => go(step - 1)}><ArrowLeft size={13} /> Back</button>}
          {step !== 3 && <ModelPill state={state} ready={modelsReady} onOpen={() => go(3)} />}
        </div>
        <div className="setup-foot-right">
          {step === 2 && !state.accessibilityAllowed && <button type="button" className="btn ghost" onClick={() => go(3)}>Skip for now</button>}
          <button type="button" className="btn primary big" disabled={primary.disabled} onClick={primary.run}>
            {primary.label}
          </button>
        </div>
      </footer>
    </motion.div>
  )
}

function Page({ title, lede, children }: { title: ReactNode; lede: ReactNode; children?: ReactNode }) {
  return (
    <>
      <h1 className="display setup-title">{title}</h1>
      <p className="setup-lede">{lede}</p>
      {children}
    </>
  )
}

function Panel({ children, className = '', style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return <div className={`setup-panel ${className}`} style={style}>{children}</div>
}

function Welcome({ keys }: { keys: string[] }) {
  return (
    <Page title="Welcome to Dictait"
      lede={<>Press <Keys keys={keys} small /> in any app, say what you want to write, and press it again. The text appears at your cursor. Your voice is processed on this Mac and never uploaded.</>}>
      <Panel className="welcome-panel ribbed">
        <div className="mini-notch">
          <Mic size={14} strokeWidth={2.2} className="rec-mic" />
          <DotWave width={200} height={24} />
          <span className="mini-time">0:04</span>
        </div>
      </Panel>
    </Page>
  )
}

function Microphone({ allowed, name }: { allowed: boolean; name: string }) {
  return (
    <Page title="Allow the microphone"
      lede="Dictait only listens between your two presses of the shortcut. The recording is deleted once it has been transcribed.">
      <Panel>
        <PermissionRow allowed={allowed} label="Microphone" detail={allowed ? name || 'Ready' : 'Choose Allow when macOS asks'} />
      </Panel>
    </Page>
  )
}

function Paste({ allowed }: { allowed: boolean }) {
  return (
    <Page title="Allow pasting"
      lede={<>Accessibility access lets Dictait type into the app you were using. In System Settings, turn on <b>Dictait</b>, then come back here. Without it, your text is copied and you paste it yourself.</>}>
      <Panel>
        <PermissionRow allowed={allowed} label="Accessibility" detail={allowed ? 'Paste at cursor is on' : 'System Settings › Privacy & Security'} />
      </Panel>
    </Page>
  )
}

function Model({ state, ready }: { state: AppState; ready: boolean }) {
  const download = state.download
  const failed = state.phase === 'failed'
  const fraction = ready ? 1 : download && download.total ? Math.min(1, download.done / download.total) : null
  const percent = fraction === null ? null : Math.floor(fraction * 100)
  return (
    <Page title={ready ? 'Voice model installed' : failed ? 'The download stopped' : 'Downloading the voice model'}
      lede={failed ? state.message : ready ? 'Dictait has everything it needs and works offline from now on.' : 'This happens once. It began when you opened Dictait, so it may be nearly done.'}>
      <Panel className="model-panel frost" style={{ '--frost': String(failed ? 0.15 : fraction ?? 0.08) } as React.CSSProperties}>
        <div className="model-readout">
          <span className="model-name">{download ? download.model.replace(/^./, (c) => c.toUpperCase()) : 'Speech and cleanup models'}</span>
          <span className="model-meta">{download ? `${gb(download.done)} of ${gb(download.total)} GB` : ready ? 'Installed' : failed ? 'Stopped' : 'Preparing'}{percent !== null && !ready ? ` · ${percent}%` : ''}</span>
        </div>
        <div className={`model-track ${fraction === null && !failed ? 'indeterminate' : ''} ${failed ? 'failed' : ''}`}>
          <motion.span animate={{ scaleX: fraction ?? 0.25 }} transition={snappy} />
        </div>
        {failed && <button type="button" className="btn secondary" onClick={() => api.reloadModels()}><RotateCw size={13} /> Retry</button>}
      </Panel>
    </Page>
  )
}

function TryIt({ keys, tried, transcript, ready, onPractice }: { keys: string[]; tried: boolean; transcript: string; ready: boolean; onPractice: () => void }) {
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { field.current?.focus() }, [])
  return (
    <Page title={tried ? 'You’re all set' : 'Try a dictation'}
      lede={tried ? <>Dictait wrote “{transcript.slice(0, 90)}{transcript.length > 90 ? '…' : ''}”. The same shortcut works in every app.</>
        : <>Press <Keys keys={keys} small />, say a sentence, then press it again. Your words land in the box below.</>}>
      <Panel className="try-panel">
        <textarea ref={field} className="try-field" data-practice="true" placeholder={ready ? 'Your dictation appears here…' : 'Waiting for the voice model…'} spellCheck={false} />
      </Panel>
      <button type="button" className="setup-link" onClick={onPractice}>Practise with guided lessons instead</button>
    </Page>
  )
}

function PermissionRow({ allowed, label, detail }: { allowed: boolean; label: string; detail: string }) {
  return (
    <div className={`permission ${allowed ? 'ok' : ''}`}>
      <span className="permission-label">{label}</span>
      <span className="permission-detail">{detail}</span>
      <span className="permission-state">{allowed ? <><Check size={13} strokeWidth={2.4} /> Allowed</> : 'Not allowed yet'}</span>
    </div>
  )
}

function ModelPill({ state, ready, onOpen }: { state: AppState; ready: boolean; onOpen: () => void }) {
  const download = state.download
  const fraction = download && download.total ? Math.min(1, download.done / download.total) : null
  const failed = state.phase === 'failed'
  return (
    <button type="button" className={`model-pill ${ready ? 'ready' : ''} ${failed ? 'failed' : ''}`} onClick={onOpen} title="Voice model">
      {ready ? 'Voice model ready' : failed ? 'Voice model download stopped' : fraction !== null ? `Voice model ${Math.floor(fraction * 100)}%` : 'Preparing voice model'}
      {!ready && !failed && fraction !== null && <span className="model-pill-bar"><span style={{ transform: `scaleX(${fraction})` }} /></span>}
    </button>
  )
}
