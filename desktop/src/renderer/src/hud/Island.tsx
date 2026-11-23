import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, AppWindow, ClipboardCheck, Mic, MicOff, Sparkles, X } from 'lucide-react'
import { HOLD_TO_TALK_MS, MAX_DICTATION_SECONDS, type HudKind, type HudState } from '@shared/types'
import { clock } from '../lib/format'
import { island, snappy } from '../lib/motion'
import { api } from '../lib/store'
import { Recorder } from './recorder'

/** Width and content height of the island for each state; the notch adds its own height on top. */
const shapes: Record<HudKind, { width: number; height: number }> = {
  recording: { width: 400, height: 46 }, microphone: { width: 320, height: 56 }, transcribing: { width: 400, height: 56 },
  cleaning: { width: 400, height: 56 }, preparing: { width: 320, height: 56 }, done: { width: 400, height: 56 },
  copied: { width: 400, height: 70 }, cancelled: { width: 240, height: 46 }, empty: { width: 320, height: 56 },
  failed: { width: 380, height: 66 }, info: { width: 280, height: 52 }
}

interface Sample { time: number; level: number }

export function Island() {
  const [hud, setHud] = useState<HudState | null>(null)
  const [hint, setHint] = useState(false)
  const samples = useRef<Sample[]>([])
  const visible = useRef(false)

  useEffect(() => api.onHud((next) => { visible.current = next.visible; setHud(next) }), [])

  // The recorder lives here so audio and its level never cross a process boundary per frame.
  useEffect(() => {
    const recorder = new Recorder()
    let lastSent = 0
    recorder.onLevel = (level) => {
      const now = performance.now()
      samples.current.push({ time: now, level })
      if (samples.current.length > 240) samples.current.splice(0, samples.current.length - 240)
      if (now - lastSent > 45) { lastSent = now; api.recorderLevel(level) }
    }
    recorder.onEnded = () => api.recorderEnded()
    recorder.onPiece = (audio, index) => api.recorderPiece(audio, index)
    const off = api.onRecorder(async (command, options) => {
      if (command === 'start') {
        samples.current = []
        try { await recorder.start(options?.device, options?.monitor); api.recorderStarted(recorder.deviceName, options?.requestId) }
        catch (error) { api.recorderFailed((error as Error).message, options?.requestId) }
      } else if (command === 'stop') {
        try { api.recorderData((await recorder.stop()).audio, options?.requestId) } catch { api.recorderData(null, options?.requestId) }
      } else {
        recorder.cancel()
      }
    })
    return () => { off(); recorder.cancel() }
  }, [])

  // Previews have no microphone: simulate a voice.
  useEffect(() => {
    if (!api.preview || hud?.kind !== 'recording' || !hud.visible) return
    let frame = 0
    const tick = () => {
      const t = performance.now() / 1000
      const voice = 0.5 + 0.28 * Math.sin(t * 5.3) * Math.sin(t * 1.7) + 0.18 * Math.sin(t * 13.1)
      samples.current.push({ time: performance.now(), level: hud.micQuiet ? 0 : Math.max(0.04, Math.min(1, voice + (Math.random() - 0.5) * 0.2)) })
      if (samples.current.length > 240) samples.current.shift()
      frame = window.setTimeout(tick, 32)
    }
    tick()
    return () => window.clearTimeout(frame)
  }, [hud?.kind, hud?.visible, hud?.micQuiet])

  // Hints and tips show briefly at the start of each recording, then the island tucks them away.
  useEffect(() => {
    if (hud?.kind !== 'recording' || !hud.visible) { setHint(false); return }
    setHint(true)
    const timer = window.setTimeout(() => setHint(false), 4000)
    return () => window.clearTimeout(timer)
  }, [hud?.kind, hud?.visible, hud?.startedAt])

  if (!hud) return null
  const { screen } = hud
  const top = screen.hasNotch ? screen.notchHeight : 0
  const shape = shapes[hud.kind] ?? shapes.info
  const open = hud.visible
  const line = hud.kind === 'recording' ? subline(hud, hint) : null
  const active = ['recording', 'transcribing', 'cleaning'].includes(hud.kind)
  const words = hud.kind === 'recording' && !hud.micQuiet ? hud.live || (hint ? hud.note : '') : ''
  const extra = (line ? 22 : 0) + (active ? 26 : 0) + (hud.kind === 'recording' && hud.micQuiet ? 30 : words ? 22 : 0)
  const height = open ? top + shape.height + extra : screen.hasNotch ? top : 0
  const width = open ? Math.max(shape.width, screen.notchWidth + 120) : screen.hasNotch ? screen.notchWidth : 120
  const radius = open ? Math.min(24, (shape.height + extra) / 2) : 10

  return (
    <div className="stage">
      <motion.div className={`island ${screen.hasNotch ? 'notched' : 'flat'} ${open ? 'open' : 'closed'}`}
        initial={{ width: screen.hasNotch ? screen.notchWidth : 120, height: screen.hasNotch ? top : 0, opacity: 0 }}
        animate={{ width, height, opacity: open ? 1 : 0, borderBottomLeftRadius: radius, borderBottomRightRadius: radius }}
        transition={{ ...island, opacity: open ? { duration: 0.1 } : { delay: 0.26, duration: 0.16 } }}
        onAnimationComplete={() => { if (!visible.current) api.hudHidden() }}>
        <div className="island-clip" role="status" aria-live="polite" aria-atomic="true" style={{ borderBottomLeftRadius: radius, borderBottomRightRadius: radius, ['--notch' as string]: `${top}px` }}>
          <AnimatePresence mode="popLayout" initial={false}>
            {open && (
              <motion.div key={hud.kind} className="island-content" style={{ paddingTop: top }}
                initial={{ opacity: 0, scale: 0.92, filter: 'blur(6px)' }}
                animate={{ opacity: 1, scale: 1, filter: 'blur(0px)', transition: { ...snappy, delay: 0.06 } }}
                exit={{ opacity: 0, scale: 0.96, filter: 'blur(4px)', transition: { duration: 0.12 } }}>
                <Content hud={hud} samples={samples} line={line} height={shape.height} />
                {words && <div className={`island-sub ${hud.live ? 'live' : 'note'}`}>{hud.live ? <LiveText text={words} /> : words}</div>}
                {hud.kind === 'recording' && hud.micQuiet && <div className="island-mic-warning"><MicOff size={12} /><span>Can’t hear you · {hud.microphone || 'Check your microphone'}</span></div>}
                {active && <DestinationLine hud={hud} />}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  )
}

type Line = { kind: 'holding' | 'holdPending' | 'editing' | 'hint' }

/** The one line under the waveform, by priority. */
function subline(hud: HudState, early: boolean): Line | null {
  if (hud.holding) return { kind: 'holding' }
  if (hud.holdStartedAt !== null) return { kind: 'holdPending' }
  if (hud.editing && early) return { kind: 'editing' }
  return { kind: 'hint' }
}

function Content({ hud, samples, line, height }: { hud: HudState; samples: React.RefObject<Sample[]>; line: Line | null; height: number }) {
  if (hud.kind === 'recording') {
    return (
      <div className="island-recording">
        <div className="island-row" style={{ height }}>
          <LiveMark editing={hud.editing} />
          <Waveform samples={samples} />
          <Timer startedAt={hud.startedAt} />
        </div>
        <AnimatePresence mode="popLayout" initial={false}>
          {line && (
            <motion.div key={line.kind} className={`island-sub ${line.kind}`} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }} transition={snappy}>
              {line.kind === 'holdPending' ? <><HoldProgress startedAt={hud.holdStartedAt!} /><span>Keep holding for hold-to-talk</span></>
                    : line.kind === 'holding' ? <><span className="hold-active-dot" />Release <kbd>⌃ Space</kbd> to finish</>
                    : line.kind === 'editing' ? <>Editing selection · tap <kbd>⌃ Space</kbd> to finish</>
                      : <><span>Tap <kbd>⌃ Space</kbd> to finish</span><span className="sep" /><kbd>esc</kbd> cancel</>}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    )
  }
  const icons: Partial<Record<HudKind, ReactNode>> = {
    transcribing: <Spinner />, preparing: <Spinner />, cleaning: <Sparkles size={16} />,
    done: <Check />, copied: <ClipboardCheck size={16} />, cancelled: <X size={16} strokeWidth={2.4} />,
    empty: <MicOff size={16} />, failed: <AlertTriangle size={16} />, microphone: <Mic size={16} />
  }
  const shimmer = ['transcribing', 'cleaning', 'preparing'].includes(hud.kind)
  return (
    <div className={`island-row kind-${hud.kind}`} style={{ height }}>
      <span className="island-icon">{icons[hud.kind] ?? <Spinner />}</span>
      <span className="island-text">
        <span className={`island-title ${shimmer ? 'shimmer' : ''}`}>{hud.title}</span>
        {hud.detail && <span className="island-detail">{hud.detail}</span>}
      </span>
    </div>
  )
}

function DestinationLine({ hud }: { hud: HudState }) {
  const destination = hud.destination
  return <div className="island-destination">
    {destination?.icon ? <img src={destination.icon} width={14} height={14} alt="" /> : <AppWindow size={13} aria-hidden />}
    <span>{destination?.appName ? `${destination.editable === false ? 'No text box in' : 'Current app:'} ${destination.appName}` : 'Text goes to your focused field'}</span>
  </div>
}

function HoldProgress({ startedAt }: { startedAt: number }) {
  const bar = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const animation = bar.current?.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
      { duration: HOLD_TO_TALK_MS, easing: 'linear', fill: 'forwards' })
    if (animation) animation.currentTime = Math.max(0, Date.now() - startedAt)
    return () => animation?.cancel()
  }, [startedAt])
  return <span className="hold-progress" aria-hidden="true"><span ref={bar} /></span>
}

/** Find how much of `text` is newly appended, even when `text` is a 400-char sliding window. */
function splitAppended(prev: string, next: string): [string, string] {
  if (!prev || prev === next) return [next, '']
  if (next.startsWith(prev)) return [prev, next.slice(prev.length)]
  // Sliding window: find the longest suffix of `prev` that matches a prefix of `next`.
  const maxOverlap = Math.min(prev.length, next.length)
  for (let len = maxOverlap; len >= 12; len--) {
    if (next.startsWith(prev.slice(prev.length - len))) {
      return [next.slice(0, len), next.slice(len)]
    }
  }
  return [next, '']
}

/** The newest words, right-aligned; what was just added fades in. */
function LiveText({ text }: { text: string }) {
  const [shown, setShown] = useState<{ text: string; stable: string; added: string; seq: number }>({ text, stable: text, added: '', seq: 0 })
  if (shown.text !== text) {
    const [stable, added] = splitAppended(shown.text, text)
    setShown({ text, stable, added, seq: added ? shown.seq + 1 : shown.seq })
  }
  return (
    <span className="live-text">
      <span className="live-inner">
        {shown.stable.slice(-160)}
        {shown.added && (
          <motion.span key={shown.seq} initial={{ opacity: 0, filter: 'blur(3px)' }} animate={{ opacity: 1, filter: 'blur(0px)' }} transition={{ duration: 0.35 }}>
            {shown.added}
          </motion.span>
        )}
      </span>
    </span>
  )
}

function Timer({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(timer)
  }, [])
  const seconds = startedAt ? (now - startedAt) / 1000 : 0
  return <span className={`island-time ${seconds >= MAX_DICTATION_SECONDS - 30 ? 'late' : ''}`}>{clock(seconds)}</span>
}

function Spinner() {
  return <span className="spinner" aria-hidden><span /></span>
}

function Check() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" className="check-draw" aria-hidden>
      <circle cx="10" cy="10" r="9" className="check-circle" />
      <path d="M6 10.4l2.6 2.6L14.2 7.4" className="check-path" />
    </svg>
  )
}

/** The Dictait mark in the logo's gradient, glowing while it listens. */
function LiveMark({ editing }: { editing: boolean }) {
  return (
    <svg className={`live-mark ${editing ? 'editing' : ''}`} viewBox="24 21 57 66" aria-hidden>
      <defs>
        <linearGradient id="live-mark" x1="0.15" y1="0" x2="0.85" y2="1"><stop offset="0" stopColor="#FF9456" /><stop offset="1" stopColor="#FF4A2E" /></linearGradient>
      </defs>
      <path fill="url(#live-mark)" fillRule="evenodd" d="M26 31 C26 26.6 29.6 23 34 23 H50 A27 27 0 0 1 50 77 H40 L29.5 85.2 C28 86.4 26 85.3 26 83.4 Z M41 35 H55 A2.5 2.5 0 0 1 55 40 H50.5 V60 H55 A2.5 2.5 0 0 1 55 65 H41 A2.5 2.5 0 0 1 41 60 H45.5 V40 H41 A2.5 2.5 0 0 1 41 35 Z" />
    </svg>
  )
}

/** The voice as a ribbon of light: a mirrored, smoothed trace that glides left and swells with the level. */
function Waveform({ samples }: { samples: React.RefObject<Sample[]> }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return
    const width = 196, height = 30, ratio = window.devicePixelRatio || 2
    element.width = width * ratio; element.height = height * ratio
    context.scale(ratio, ratio)
    const speed = 4 / 32 // px per ms
    const fill = context.createLinearGradient(0, 0, width, 0)
    fill.addColorStop(0, 'rgba(255,148,86,0)'); fill.addColorStop(0.35, 'rgba(255,148,86,0.38)'); fill.addColorStop(1, 'rgba(255,74,46,0.5)')
    const edge = context.createLinearGradient(0, 0, width, 0)
    edge.addColorStop(0, 'rgba(255,148,86,0)'); edge.addColorStop(0.3, '#FF9456'); edge.addColorStop(1, '#FF4A2E')
    let frame = 0
    const draw = () => {
      const now = performance.now()
      context.clearRect(0, 0, width, height)
      const list = samples.current ?? []
      // Points every 4 px from the right edge back in time; quiet reads as a calm, breathing line.
      const points: number[] = []
      for (let x = width, i = list.length - 1; x >= -4; x -= 4) {
        const at = now - (width - x) / speed
        while (i > 0 && list[i].time > at) i--
        const sample = list[i]
        const level = sample && Math.abs(sample.time - at) < 120 ? sample.level : 0
        const breath = 0.06 + 0.03 * Math.sin(now / 420 + x / 18)
        points.push(Math.max(breath, Math.pow(level, 1.1)) * (height / 2 - 2))
      }
      // Two passes of a three-point average: a ribbon, not a seismograph.
      for (let pass = 0; pass < 2; pass++) {
        for (let k = 1; k < points.length - 1; k++) points[k] = (points[k - 1] + points[k] * 2 + points[k + 1]) / 4
      }
      const half = height / 2
      const trace = (sign: number) => {
        context.moveTo(width, half - sign * points[0])
        for (let k = 1; k < points.length; k++) {
          const x0 = width - (k - 1) * 4, x1 = width - k * 4
          context.quadraticCurveTo(x0, half - sign * points[k - 1], (x0 + x1) / 2, half - sign * (points[k - 1] + points[k]) / 2)
        }
      }
      context.beginPath(); trace(1)
      for (let k = points.length - 1; k >= 0; k--) context.lineTo(width - k * 4, half + points[k])
      context.closePath()
      context.fillStyle = fill; context.fill()
      context.lineWidth = 1.6; context.strokeStyle = edge; context.lineJoin = 'round'
      context.beginPath(); trace(1); context.stroke()
      context.beginPath(); trace(-1); context.stroke()
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [samples])
  return <canvas ref={canvas} className="waveform" style={{ width: 196, height: 30 }} aria-hidden />
}
