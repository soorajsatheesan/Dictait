import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, RotateCw } from 'lucide-react'
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
      <div className="setup-grid" aria-hidden />
      <div className="setup-drag" />
      <header className="setup-top">
        <span className="setup-brand"><Mark size={18} /><span>Dictait</span></span>
        <span className="setup-count mono">{String(step + 1).padStart(2, '0')} / {String(steps.length).padStart(2, '0')}</span>
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
            {step === 0 && <Welcome />}
            {step === 1 && <Microphone allowed={state.microphoneAllowed} name={state.microphoneName} />}
            {step === 2 && <Paste allowed={state.accessibilityAllowed} />}
            {step === 3 && <Model state={state} ready={modelsReady} />}
            {step === 4 && <TryIt tried={tried} transcript={state.transcript} ready={modelsReady} onPractice={() => { finish(); onPractice() }} />}
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
            {primary.label}{!primary.disabled && step < 4 && (step === 0 || primary.label === 'Continue') && <ArrowRight size={14} />}
          </button>
        </div>
      </footer>
    </motion.div>
  )
}

function Page({ eyebrow, title, lede, children }: { eyebrow: string; title: ReactNode; lede: ReactNode; children?: ReactNode }) {
  return (
    <>
      <div className="eyebrow setup-eyebrow">{eyebrow}</div>
      <h1 className="display setup-title">{title}</h1>
      <p className="setup-lede">{lede}</p>
      {children}
    </>
  )
}

function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`setup-panel ${className}`}><i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" />{children}</div>
}

function Welcome() {
  return (
    <Page eyebrow="Private dictation for Mac" title={<>Speak.<br />It <span className="signal-word">types.</span></>}
      lede="Press a shortcut anywhere, talk, and clean text lands at your cursor. Speech recognition and cleanup run entirely on this Mac.">
      <Panel className="welcome-panel">
        <div className="mini-notch">
          <span className="rec-dot" />
          <DotWave width={200} height={24} />
          <span className="mono mini-time">0:04</span>
        </div>
        <div className="welcome-facts mono"><span>On device</span><span>No account</span><span>Works offline</span></div>
      </Panel>
    </Page>
  )
}

function Microphone({ allowed, name }: { allowed: boolean; name: string }) {
  return (
    <Page eyebrow="Microphone" title="Let Dictait hear you."
      lede="It only listens between your two presses of the shortcut. Audio is transcribed on this Mac and then deleted.">
      <Panel>
        <PermissionRow allowed={allowed} label="Microphone" detail={allowed ? name || 'Ready' : 'Choose Allow when macOS asks'} />
      </Panel>
    </Page>
  )
}

function Paste({ allowed }: { allowed: boolean }) {
  return (
    <Page eyebrow="Paste at cursor" title="Type where you’re working."
      lede={<>Accessibility lets Dictait paste into the app you were using. Turn <b>Dictait</b> on in the list, then come back. Without it, text is copied for you to paste.</>}>
      <Panel>
        <div className="caret-demo"><span>Ship the preview build on Friday</span><i className="caret" /></div>
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
    <Page eyebrow="Voice model" title={ready ? 'Ready on this Mac.' : failed ? 'Download paused.' : 'Getting your voice model.'}
      lede={failed ? state.message : ready ? 'Everything Dictait needs is installed. It works offline from now on.' : 'This happens once. It started when you opened Dictait, so it may already be most of the way there.'}>
      <Panel className="model-panel">
        <div className="model-readout">
          <span className={`dot-type model-percent ${ready ? 'ready' : ''}`}>{percent === null ? '··' : String(percent).padStart(2, '0')}<small>%</small></span>
          <span className="model-meta mono">
            <span>{download?.model ?? 'Speech + cleanup models'}</span>
            <span>{download ? `${gb(download.done)} / ${gb(download.total)} GB` : ready ? 'Installed' : failed ? 'Stopped' : 'Preparing'}</span>
          </span>
        </div>
        <div className={`model-track ${fraction === null && !failed ? 'indeterminate' : ''} ${failed ? 'failed' : ''}`}>
          <motion.span animate={{ scaleX: fraction ?? 0.25 }} transition={snappy} />
        </div>
        {failed && <button type="button" className="btn secondary" onClick={() => api.reloadModels()}><RotateCw size={13} /> Retry</button>}
      </Panel>
    </Page>
  )
}

function TryIt({ tried, transcript, ready, onPractice }: { tried: boolean; transcript: string; ready: boolean; onPractice: () => void }) {
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { field.current?.focus() }, [])
  return (
    <Page eyebrow="First dictation" title={tried ? 'That’s it.' : 'Try it now.'}
      lede={tried ? <>Dictait wrote “{transcript.slice(0, 90)}{transcript.length > 90 ? '…' : ''}”. Use the same shortcut in any app.</>
        : <>Press <Keys keys={['⌃', 'Space']} small />, say a sentence, then press it again. Your words land in the box below.</>}>
      <Panel className="try-panel">
        <textarea ref={field} className="try-field" placeholder={ready ? 'Your dictation appears here…' : 'Waiting for the voice model…'} spellCheck={false} />
      </Panel>
      <button type="button" className="setup-link" onClick={onPractice}>Or practise with guided lessons →</button>
    </Page>
  )
}

function PermissionRow({ allowed, label, detail }: { allowed: boolean; label: string; detail: string }) {
  return (
    <div className={`permission ${allowed ? 'ok' : ''}`}>
      <span className={`led ${allowed ? 'good' : 'busy'}`} />
      <span className="permission-label">{label}</span>
      <span className="permission-detail">{detail}</span>
      <span className="permission-state mono">{allowed ? 'Allowed' : 'Waiting'}</span>
    </div>
  )
}

function ModelPill({ state, ready, onOpen }: { state: AppState; ready: boolean; onOpen: () => void }) {
  const download = state.download
  const fraction = download && download.total ? Math.min(1, download.done / download.total) : null
  const failed = state.phase === 'failed'
  return (
    <button type="button" className={`model-pill mono ${ready ? 'ready' : ''} ${failed ? 'failed' : ''}`} onClick={onOpen} title="Voice model">
      <span className={`led ${ready ? 'good' : failed ? 'warn' : 'busy'}`} />
      {ready ? 'Model ready' : failed ? 'Model paused' : fraction !== null ? `Model ${Math.floor(fraction * 100)}%` : 'Model preparing'}
      {!ready && !failed && fraction !== null && <span className="model-pill-bar"><span style={{ transform: `scaleX(${fraction})` }} /></span>}
    </button>
  )
}
