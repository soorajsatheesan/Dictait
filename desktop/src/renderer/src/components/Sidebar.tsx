import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef } from 'react'
import { AlertTriangle, AudioLines, BookA, Cpu, Mic, NotebookText, RotateCw, Settings2, Waypoints, type LucideIcon } from 'lucide-react'
import type { AppState, Phase, Section } from '@shared/types'
import { clock } from '../lib/format'
import { gentle, snappy } from '../lib/motion'
import { api, useElapsed, useLevelRef } from '../lib/store'
import { Keys, Mark } from './ui'

const sections: { id: Section; label: string; icon: LucideIcon; key: string }[] = [
  { id: 'notes', label: 'Notes', icon: NotebookText, key: '1' },
  { id: 'graph', label: 'Graph', icon: Waypoints, key: '2' },
  { id: 'vocabulary', label: 'Vocabulary', icon: BookA, key: '3' },
  { id: 'settings', label: 'Settings', icon: Settings2, key: '4' }
]

const phaseCopy: Record<Phase, { title: string; tone: 'good' | 'live' | 'busy' | 'warn' }> = {
  preparing: { title: 'Warming up', tone: 'busy' },
  ready: { title: 'Ready', tone: 'good' },
  requestingMicrophone: { title: 'Waiting for microphone', tone: 'busy' },
  recording: { title: 'Listening', tone: 'live' },
  transcribing: { title: 'Transcribing', tone: 'busy' },
  cleaning: { title: 'Polishing', tone: 'busy' },
  failed: { title: 'Needs attention', tone: 'warn' }
}

export function Sidebar({ section, onNavigate, state, counts }: {
  section: Section; onNavigate: (section: Section) => void; state: AppState | null; counts: Partial<Record<Section, number>>
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-drag" />
      <div className="brand">
        <Mark size={22} />
        <span className="display brand-name">Dictait</span>
      </div>
      <nav className="nav" aria-label="Sections">
        {sections.map(({ id, label, icon: Icon, key }) => {
          const active = id === section
          return (
            <button key={id} type="button" className={`nav-item ${active ? 'active' : ''}`} onClick={() => onNavigate(id)} aria-current={active ? 'page' : undefined} title={`${label}  ⌘${key}`}>
              {active && <motion.span layoutId="nav-active" className="nav-active" transition={snappy} />}
              <Icon size={16} strokeWidth={active ? 2.2 : 1.9} className="nav-icon" />
              <span className="nav-label">{label}</span>
              {counts[id] !== undefined && <span className="nav-count mono">{counts[id]}</span>}
            </button>
          )
        })}
      </nav>
      <div className="sidebar-fill" />
      <AnimatePresence initial={false}>
        {state?.notice && (
          <motion.button key="notice" type="button" className="notice-card" onClick={() => onNavigate('settings')}
            initial={{ opacity: 0, y: 8, height: 0 }} animate={{ opacity: 1, y: 0, height: 'auto' }} exit={{ opacity: 0, y: 8, height: 0 }} transition={gentle}>
            <AlertTriangle size={14} strokeWidth={2.2} />
            <span>{state.notice}</span>
          </motion.button>
        )}
      </AnimatePresence>
      {state && <StatusLine state={state} />}
      {state && <RecordButton state={state} />}
    </aside>
  )
}

function StatusLine({ state }: { state: AppState }) {
  const copy = phaseCopy[state.phase]
  const model = state.settings.backend === 'whisper' ? 'Whisper Turbo' : 'Parakeet'
  return (
    <div className="status-line">
      <span className={`status-icon ${copy.tone}`} aria-hidden>
        {copy.tone === 'good' ? <Cpu size={13} strokeWidth={2.2} /> : copy.tone === 'live' ? <AudioLines size={13} strokeWidth={2.2} />
          : copy.tone === 'warn' ? <AlertTriangle size={13} strokeWidth={2.2} /> : <span className="status-spin" />}
      </span>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={copy.title} className="status-title" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={snappy}>
          {copy.title}
        </motion.span>
      </AnimatePresence>
      <span className="status-model">{model} · on-device</span>
    </div>
  )
}

function RecordButton({ state }: { state: AppState }) {
  const { phase } = state
  const recording = phase === 'recording'
  const busy = ['preparing', 'transcribing', 'cleaning', 'requestingMicrophone'].includes(phase)
  const elapsed = useElapsed(recording ? state.recordingStartedAt : null)

  if (phase === 'failed') {
    return (
      <button type="button" className="record record-retry" onClick={() => api.reloadModels()}>
        <RotateCw size={15} strokeWidth={2.2} />
        <span className="record-label">Retry models</span>
      </button>
    )
  }

  return (
    <div className="record-wrap">
      <motion.button type="button" className={`record ${recording ? 'recording' : ''} ${busy ? 'busy' : ''}`} disabled={busy}
        onClick={() => api.toggleRecording()} layout transition={snappy} aria-label={recording ? 'Finish dictation' : 'Start dictation'}>
        {busy && <span className="record-sweep" aria-hidden />}
        <span className="record-orb" aria-hidden>{recording ? <span className="record-stop" /> : <Mic size={15} strokeWidth={2.4} className="record-mic" />}</span>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={recording ? 'rec' : busy ? phase : 'idle'} className="record-label"
            initial={{ opacity: 0, y: 8, filter: 'blur(2px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, y: -8, filter: 'blur(2px)' }} transition={snappy}>
            {recording ? <>Finish <span className="record-time mono">{clock(elapsed)}</span></> : busy ? phaseCopy[phase].title + '…' : 'Dictate'}
          </motion.span>
        </AnimatePresence>
        <span className="record-right">
          {recording ? <LiveBars /> : <Keys keys={['⌃', 'Space']} small />}
        </span>
      </motion.button>
      <AnimatePresence initial={false}>
        {recording && (
          <motion.button key="cancel" type="button" className="record-cancel" onClick={() => api.cancelRecording()}
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={snappy}>
            Cancel <Keys keys={['esc']} small />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}

/** A small line of light driven by the live microphone level, drawn on canvas at display rate. */
function LiveBars() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const level = useLevelRef(true)
  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return
    const ratio = window.devicePixelRatio || 1
    element.width = 30 * ratio; element.height = 16 * ratio
    context.scale(ratio, ratio)
    let shown = 0
    let frame = 0
    const draw = (time: number) => {
      context.clearRect(0, 0, 30, 16)
      shown += (Math.min(1, level.current * 1.6) - shown) * 0.3
      const amplitude = 1 + shown * 6
      context.beginPath()
      for (let x = 0; x <= 30; x += 1) {
        const envelope = Math.sin((x / 30) * Math.PI)
        const y = 8 + envelope * amplitude * Math.sin(x * 0.55 - time / 90)
        if (x === 0) context.moveTo(x, y); else context.lineTo(x, y)
      }
      context.strokeStyle = '#fff'; context.lineWidth = 1.8; context.lineCap = 'round'; context.lineJoin = 'round'
      context.stroke()
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [level])
  return <canvas ref={canvas} className="live-bars" style={{ width: 30, height: 16 }} aria-hidden />
}
