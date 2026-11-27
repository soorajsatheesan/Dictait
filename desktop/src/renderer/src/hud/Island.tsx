import { AnimatePresence, motion } from 'motion/react'
import { Mic } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { HOLD_TO_TALK_MS, MAX_DICTATION_SECONDS, type HudKind, type HudState } from '@shared/types'
import { clock } from '../lib/format'
import { island, snappy } from '../lib/motion'
import { api } from '../lib/store'
import { Recorder } from './recorder'

/**
 * Width of the island for each state. The content is one row, plus one context line while recording
 * or when there is a detail to read; the notch adds its own height on top.
 */
const widths: Record<HudKind, number> = {
  recording: 360, microphone: 340, transcribing: 340, cleaning: 340, preparing: 320, done: 340,
  copied: 380, cancelled: 220, empty: 320, failed: 380, info: 300
}
const ROW = 40
const LINE = 22
const RADIUS = 18

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

  // Hints and tips show briefly at the start of each recording, then the line hands over to context.
  useEffect(() => {
    if (hud?.kind !== 'recording' || !hud.visible) { setHint(false); return }
    setHint(true)
    const timer = window.setTimeout(() => setHint(false), 4000)
    return () => window.clearTimeout(timer)
  }, [hud?.kind, hud?.visible, hud?.startedAt])

  if (!hud) return null
  const { screen } = hud
  const top = screen.hasNotch ? screen.notchHeight : 0
  const open = hud.visible
  const recording = hud.kind === 'recording'
  const line = recording ? subline(hud, hint) : null
  const hasDetail = !recording && Boolean(hud.detail)
  const content = ROW + (recording || hasDetail ? LINE : 0) + (hasDetail && hud.detail.length > 46 ? 14 : 0)
  const height = open ? top + content : screen.hasNotch ? top : 0
  const width = open ? Math.max(widths[hud.kind] ?? widths.info, screen.notchWidth + 120) : screen.hasNotch ? screen.notchWidth : 120
  const radius = open ? RADIUS : 10

  return (
    <div className="stage">
      <motion.div className={`island ${screen.hasNotch ? 'notched' : 'flat'} ${open ? 'open' : 'closed'}`}
        initial={{ width: screen.hasNotch ? screen.notchWidth : 120, height: screen.hasNotch ? top : 0, opacity: 0 }}
        animate={{ width, height, opacity: open ? 1 : 0, borderBottomLeftRadius: radius, borderBottomRightRadius: radius }}
        transition={{ ...island, opacity: open ? { duration: 0.1 } : { delay: 0.26, duration: 0.16 } }}
        onAnimationComplete={() => { if (!visible.current) api.hudHidden() }}>
        <div className="island-clip" role="status" aria-live="polite" aria-atomic="true" style={{ borderBottomLeftRadius: radius, borderBottomRightRadius: radius }}>
          {open && hud.kind === 'done' && <span key={hud.title} className="island-prism" aria-hidden />}
          <AnimatePresence mode="popLayout" initial={false}>
            {open && (
              <motion.div key={recording ? 'recording' : 'status'} className="island-content" style={{ paddingTop: top }}
                initial={{ opacity: 0, scale: 0.94, filter: 'blur(6px)' }}
                animate={{ opacity: 1, scale: 1, filter: 'blur(0px)', transition: { ...snappy, delay: 0.06 } }}
                exit={{ opacity: 0, scale: 0.97, filter: 'blur(4px)', transition: { duration: 0.12 } }}>
                {recording ? <Recording hud={hud} samples={samples} line={line!} /> : <Status hud={hud} />}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  )
}

type Line = { kind: 'holding' | 'holdPending' | 'quiet' | 'editing' | 'live' | 'note' | 'hint' | 'destination'; text?: string }

/** The one line under the waveform, by priority. */
function subline(hud: HudState, early: boolean): Line {
  if (hud.holding) return { kind: 'holding' }
  if (hud.holdStartedAt !== null) return { kind: 'holdPending' }
  if (hud.micQuiet) return { kind: 'quiet' }
  if (hud.live) return { kind: 'live', text: hud.live }
  if (hud.editing && early) return { kind: 'editing' }
  if (early && hud.note) return { kind: 'note', text: hud.note }
  if (early) return { kind: 'hint' }
  return { kind: 'destination' }
}

function Recording({ hud, samples, line }: { hud: HudState; samples: React.RefObject<Sample[]>; line: Line }) {
  // Live words get the whole line; otherwise the destination sits at its right edge.
  const showDestination = line.kind !== 'live' && line.kind !== 'destination'
  return (
    <div className="island-recording">
      <div className="island-row" style={{ height: ROW }}>
        <Mic size={14} strokeWidth={2.2} className={`rec-mic ${hud.editing ? 'editing' : ''}`} aria-hidden />
        <DotMatrix samples={samples} />
        <Timer startedAt={hud.startedAt} />
      </div>
      <div className="island-line" style={{ height: LINE }}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={line.kind} className={`line-main ${line.kind}`} initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 3, transition: { duration: 0.1 } }} transition={snappy}>
            <LineContent hud={hud} line={line} />
          </motion.span>
        </AnimatePresence>
        {showDestination && <Destination hud={hud} compact />}
      </div>
    </div>
  )
}

function LineContent({ hud, line }: { hud: HudState; line: Line }) {
  switch (line.kind) {
    case 'holdPending': return <><HoldProgress startedAt={hud.holdStartedAt!} /><span>Keep holding to talk</span></>
    case 'holding': return <><span className="hold-dot" />Release <kbd>⌃ Space</kbd> to finish</>
    case 'quiet': return <span className="ellipsis">Can’t hear you · {hud.microphone || 'check your microphone'}</span>
    case 'live': return <LiveText text={line.text!} />
    case 'editing': return <>Editing selection · <kbd>⌃ Space</kbd> to finish</>
    case 'note': return <span className="ellipsis">{line.text}</span>
    case 'hint': return <><kbd>⌃ Space</kbd> finish <kbd>esc</kbd> cancel</>
    case 'destination': return <Destination hud={hud} />
  }
}

function Status({ hud }: { hud: HudState }) {
  const processing = ['transcribing', 'cleaning', 'preparing'].includes(hud.kind)
  return (
    <div className={`island-status kind-${hud.kind}`}>
      <div className="island-row" style={{ height: ROW }}>
        <span className="status-glyph">{processing ? <ScanMatrix /> : <Glyph kind={hud.kind} />}</span>
        <span className={`island-title ${processing ? 'shimmer' : ''}`}>{hud.title}</span>
        {processing && <Destination hud={hud} compact />}
      </div>
      {hud.detail && <div className="island-detail">{hud.detail}</div>}
    </div>
  )
}

function Destination({ hud, compact = false }: { hud: HudState; compact?: boolean }) {
  const destination = hud.destination
  if (compact && !destination?.appName) return null
  const blocked = destination?.editable === false
  return (
    <span className={`destination ${compact ? 'compact' : ''} ${blocked ? 'blocked' : ''}`}>
      {destination?.icon ? <img src={destination.icon} width={12} height={12} alt="" /> : <span className="destination-arrow">→</span>}
      <span className="ellipsis">{destination?.appName ? (blocked ? `No text box in ${destination.appName}` : destination.appName) : 'Your focused text field'}</span>
    </span>
  )
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

/** Status glyphs drawn on the same 5×5 dot grid as the waveform; the lit dots arrive in order. */
const glyphs: Partial<Record<HudKind, string[]>> = {
  done: ['.....', '....#', '...#.', '#.#..', '.#...'],
  copied: ['####.', '#..#.', '#.###', '###.#', '..###'],
  cancelled: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  empty: ['.....', '.....', '#####', '.....', '.....'],
  failed: ['..#..', '..#..', '..#..', '.....', '..#..'],
  microphone: ['.###.', '.###.', '.###.', '#.#.#', '..#..'],
  info: ['..#..', '.....', '..#..', '..#..', '..#..']
}

function Glyph({ kind }: { kind: HudKind }) {
  const pattern = glyphs[kind] ?? glyphs.info!
  let order = 0
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" className="glyph" aria-hidden>
      {pattern.flatMap((row, y) => [...row].map((cell, x) => {
        const lit = cell === '#'
        return <circle key={`${x}-${y}`} cx={2.5 + x * 3} cy={2.5 + y * 3} r={lit ? 1.25 : 1.05} className={lit ? 'lit' : 'off'}
          style={lit ? { animationDelay: `${(order++) * 28}ms` } : undefined} />
      }))}
    </svg>
  )
}

/** Processing: a band of light sweeping across a small dot grid. */
function ScanMatrix() {
  return (
    <svg width="23" height="17" viewBox="0 0 23 17" className="scan-matrix" aria-hidden>
      {Array.from({ length: 7 }, (_, x) => Array.from({ length: 5 }, (_, y) => (
        <circle key={`${x}-${y}`} cx={2.5 + x * 3} cy={2.5 + y * 3} r={1.05} style={{ animationDelay: `${x * 90 + Math.abs(y - 2) * 45}ms` }} />
      )))}
    </svg>
  )
}

/**
 * The voice as a dot-matrix readout: columns of dots scroll left with time and light up from the
 * centre with the level. Silence leaves a single, breathing centre row.
 */
function DotMatrix({ samples }: { samples: React.RefObject<Sample[]> }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return
    const width = 220, height = 24, ratio = window.devicePixelRatio || 2
    const pitch = 4, rows = 7, dot = 1.3
    element.width = width * ratio; element.height = height * ratio
    context.scale(ratio, ratio)
    const columns = Math.floor(width / pitch)
    const top = (height - (rows - 1) * pitch) / 2
    const speed = pitch / 46 // one column every ~46 ms
    const shown = new Float32Array(columns)
    let frame = 0
    const draw = () => {
      const now = performance.now()
      context.clearRect(0, 0, width, height)
      const list = samples.current ?? []
      for (let c = columns - 1, i = list.length - 1; c >= 0; c--) {
        const x = c * pitch + pitch / 2
        const at = now - (width - x) / speed
        while (i > 0 && list[i].time > at) i--
        const sample = list[i]
        const level = sample && Math.abs(sample.time - at) < 120 ? sample.level : 0
        // Ease each column toward its level so the readout settles rather than flickers.
        shown[c] += (Math.min(1, Math.pow(level, 0.9) * 1.25) - shown[c]) * 0.35
        const reach = shown[c] * (rows / 2)
        const fade = Math.min(1, 0.12 + (c / columns) * 1.25)
        for (let r = 0; r < rows; r++) {
          const distance = Math.abs(r - (rows - 1) / 2)
          const lit = distance <= reach - 0.15
          const centre = distance === 0
          const breath = centre ? 0.32 + 0.14 * Math.sin(now / 380 - c / 5) : 0
          const alpha = lit ? fade * (1 - distance * 0.1) : Math.max(breath * fade, 0.09)
          context.globalAlpha = alpha
          context.fillStyle = '#fff'
          context.beginPath()
          context.arc(x, top + r * pitch, lit ? dot + 0.15 : dot, 0, Math.PI * 2)
          context.fill()
        }
      }
      context.globalAlpha = 1
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [samples])
  return <canvas ref={canvas} className="dot-matrix" style={{ width: 220, height: 24 }} aria-hidden />
}
