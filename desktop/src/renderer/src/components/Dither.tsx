import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'

/**
 * Dictait's print system: ink on paper, one bit deep. A tone field (0 = paper, 1 = solid ink) is
 * printed either as an ordered dither (a Bayer 8×8 screen of square cells) or as a halftone (a
 * rotated grid of round dots whose size carries the tone). It draws in the CSS `color` of the
 * canvas, at device pixel ratio, with no blur, and only redraws when its size, ink or value change.
 */

export interface FieldFrame {
  /** Box size in CSS pixels. */
  width: number
  height: number
  /** The `value` prop, eased when it changes. */
  value: number
  /** 0–1, stable per `seed`. */
  random: (slot: number) => number
  /** Ink is light on dark paper. Shading flips so light still comes from the top left. */
  dark: boolean
}
/** x and y run 0–1 across the box. Returns how much ink, 0–1. */
export type Field = (x: number, y: number, frame: FieldFrame) => number

const clamp = (value: number) => Math.max(0, Math.min(1, value))
const smooth = (edge0: number, edge1: number, x: number) => { const t = clamp((x - edge0) / (edge1 - edge0)); return t * t * (3 - 2 * t) }

/** Square coordinates centred on the box, in units of its shorter side. */
function centred(x: number, y: number, frame: FieldFrame): [number, number] {
  const unit = Math.min(frame.width, frame.height)
  return [(x - 0.5) * frame.width / unit, (y - 0.5) * frame.height / unit]
}

/** A ball lit from the top left. Returns -1 outside it, else its shade (1 = facing the light). */
function ball(u: number, v: number, radius: number): number {
  const d = Math.hypot(u, v) / radius
  if (d > 1) return -1
  const z = Math.sqrt(1 - d * d)
  const lambert = (-0.52 * u / radius - 0.58 * v / radius + 0.63 * z)
  return clamp(lambert)
}

/** How close to the ball's outline, 0–1, so the side away from the ink still has an edge. */
const rim = (u: number, v: number, radius: number) => 0.8 * smooth(0.9, 0.98, Math.hypot(u, v) / radius)

/** On dark paper the ink is the light; on light paper the ink is the shadow. */
const shade = (lit: number, frame: FieldFrame) => frame.dark ? 0.08 + 0.92 * Math.pow(lit, 1.2) : 0.08 + 0.92 * Math.pow(1 - lit, 1.4)

/** A shaded ball with a printed outline. */
const printedBall = (u: number, v: number, radius: number, frame: FieldFrame) => {
  const lit = ball(u, v, radius)
  return lit < 0 ? -1 : Math.max(shade(lit, frame), 0.45 * rim(u, v, radius))
}

export const presets = {
  /** A plain lit ball. */
  sphere: (x, y, f) => Math.max(0, printedBall(...centred(x, y, f), 0.44, f)),
  /** A dim ball with a voice running through its middle, like the notch's waveform held in glass. */
  voice: (x, y, f) => {
    const [u, v] = centred(x, y, f)
    const lit = ball(u, v, 0.44)
    if (lit < 0) return 0
    const reach = 0.035 + 0.17 * Math.abs(Math.sin(u * 17 + 0.6) * Math.sin(u * 6.3 + 1.2)) * Math.exp(-u * u * 7)
    const voiced = Math.abs(v) < reach ? 1 : 0
    const body = 0.1 + 0.3 * (f.dark ? lit : 1 - lit)
    return voiced ? 0.95 : Math.max(body, 0.5 * rim(u, v, 0.44))
  },
  /** Three bodies joined by threads: the graph before it has anything in it. */
  orbit: (x, y, f) => {
    const [u, v] = centred(x, y, f)
    const bodies: [number, number, number][] = [[-0.12, 0.06, 0.24], [0.26, -0.24, 0.12], [0.3, 0.3, 0.08]]
    let tone = 0
    for (const [cx, cy, r] of bodies) tone = Math.max(tone, printedBall(u - cx, v - cy, r, f))
    if (tone > 0) return tone
    for (const [cx, cy] of bodies.slice(1)) {
      const [ax, ay] = [bodies[0][0], bodies[0][1]]
      const dx = cx - ax, dy = cy - ay
      const t = clamp(((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy))
      if (Math.hypot(u - ax - t * dx, v - ay - t * dy) < 0.012) return 0.55
    }
    return 0
  },
  /** Ink rising from the bottom to `value`, denser with depth, with a dithered surface. */
  rise: (x, y, f) => {
    const surface = 1 - (0.03 + f.value * 0.97) + 0.012 * Math.sin(x * 9 + f.random(0) * 6) * (f.value < 1 ? 1 : 0)
    const depth = y - surface
    if (depth < 0) return 0.24 * smooth(-0.12, 0, depth)
    return 0.24 + 0.26 * clamp(depth / Math.max(0.2, 1 - surface))
  },
  /** Status: a ball that fills from the bottom while Dictait warms up. */
  filling: (x, y, f) => {
    const [u, v] = centred(x, y, f)
    const tone = printedBall(u, v, 0.44, f)
    if (tone < 0) return 0
    // Above the level only the ball's outline is printed, faintly.
    return v >= 0.44 - f.value * 0.88 ? tone : Math.hypot(u, v) > 0.36 ? 0.22 : 0
  },
  /** Status: the ball split along a crack, its halves pushed apart. */
  cracked: (x, y, f) => {
    const [u, v] = centred(x, y, f)
    const nx = Math.cos(0.95), ny = -Math.sin(0.95)
    const side = u * nx + v * ny
    if (Math.abs(side) < 0.07) return 0
    const push = Math.sign(side) * 0.06
    return Math.max(0, printedBall(u - nx * push, v - ny * push, 0.42, f))
  },
  /** Note covers: two soft lights placed by the seed, so every note prints differently. */
  cover: (x, y, f) => {
    const aspect = f.height / f.width
    const a = { x: 0.55 + f.random(0) * 0.4, y: 0.2 + f.random(1) * 0.9, r: 0.32 + f.random(2) * 0.22 }
    const b = { x: 0.35 + f.random(3) * 0.5, y: 0.7 + f.random(4) * 0.6, r: 0.18 + f.random(5) * 0.16 }
    const da = Math.hypot(x - a.x, (y - a.y) * aspect) / a.r
    const db = Math.hypot(x - b.x, (y - b.y) * aspect) / b.r
    return Math.min(1, Math.exp(-da * da) + 0.7 * Math.exp(-db * db))
  }
} satisfies Record<string, Field>

export type Preset = keyof typeof presets

/** A stable 32-bit hash for any id. */
function hash(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0
  return h
}

/** The classic recursive Bayer matrix, as thresholds in (0, 1). */
const BAYER = (() => {
  let matrix = [[0]]
  while (matrix.length < 8) {
    const n = matrix.length
    const next: number[][] = Array.from({ length: n * 2 }, () => [])
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const m = matrix[y][x] * 4
      next[y][x] = m; next[y][x + n] = m + 2; next[y + n][x] = m + 3; next[y + n][x + n] = m + 1
    }
    matrix = next
  }
  return matrix.map((row) => row.map((value) => (value + 0.5) / 64))
})()

export function Dither({ preset, field, value = 1, seed = '', mode = 'bayer', cell, angle, className = '', style, label, children }: {
  preset?: Preset
  /** A custom field; keep it stable (module level or memoised), or it redraws every render. */
  field?: Field
  value?: number
  seed?: string
  /** `bayer` prints square cells; `halftone` prints round dots on a rotated screen; `matrix` prints
   * separate dots on a square grid, like the notch's waveform. */
  mode?: 'bayer' | 'halftone' | 'matrix'
  /** Cell size (bayer) or screen pitch (halftone) in CSS pixels. */
  cell?: number
  /** Screen angle in degrees for halftone; defaults to one chosen by the seed. */
  angle?: number
  className?: string
  style?: CSSProperties
  /** Accessible description; without one the print is decorative. */
  label?: string
  children?: ReactNode
}) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const shown = useRef(value)
  const redraw = useRef<(next: number) => void>(() => {})
  const shape = field ?? presets[preset ?? 'sphere']

  useEffect(() => {
    const element = canvas.current, box = host.current
    const context = element?.getContext('2d')
    if (!element || !box || !context) return
    const h = hash(seed)
    const random = (slot: number) => (Math.imul(h ^ (slot * 0x9E3779B1), 0x85EBCA6B) >>> 0) / 4294967296
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')

    const draw = (current: number) => {
      const width = box.clientWidth, height = box.clientHeight
      if (!width || !height) return
      const ratio = window.devicePixelRatio || 2
      const deviceWidth = Math.round(width * ratio), deviceHeight = Math.round(height * ratio)
      if (element.width !== deviceWidth || element.height !== deviceHeight) {
        element.width = deviceWidth; element.height = deviceHeight
        element.style.width = `${width}px`; element.style.height = `${height}px`
      }
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.clearRect(0, 0, deviceWidth, deviceHeight)
      context.fillStyle = getComputedStyle(element).color
      const frame: FieldFrame = { width, height, value: current, random, dark: scheme.matches }

      if (mode !== 'bayer') {
        const matrix = mode === 'matrix'
        const pitch = (cell ?? (matrix ? 4 : 6.5)) * ratio, max = pitch * (matrix ? 0.4 : 0.56)
        const turn = ((matrix ? 0 : angle ?? random(6) * 30 + 30) * Math.PI) / 180
        const cos = Math.cos(turn), sin = Math.sin(turn)
        const reach = Math.hypot(deviceWidth, deviceHeight) / 2 + pitch
        context.beginPath()
        for (let a = -reach; a < reach; a += pitch) {
          for (let b = -reach; b < reach; b += pitch) {
            const x = deviceWidth / 2 + a * cos - b * sin, y = deviceHeight / 2 + a * sin + b * cos
            if (x < -pitch || y < -pitch || x > deviceWidth + pitch || y > deviceHeight + pitch) continue
            const radius = max * Math.sqrt(clamp(shape(x / deviceWidth, y / deviceHeight, frame)))
            if (radius < 0.35 * ratio) continue
            context.moveTo(x + radius, y)
            context.arc(x, y, radius, 0, Math.PI * 2)
          }
        }
        context.fill()
        return
      }

      // Whole device pixels per cell, so every edge is crisp.
      const size = Math.max(1, Math.round((cell ?? 2) * ratio))
      const columns = Math.ceil(deviceWidth / size), rows = Math.ceil(deviceHeight / size)
      for (let row = 0; row < rows; row++) {
        const thresholds = BAYER[row & 7]
        const y = (row + 0.5) * size / deviceHeight
        for (let column = 0; column < columns; column++) {
          const tone = shape((column + 0.5) * size / deviceWidth, y, frame)
          if (tone > thresholds[column & 7]) context.fillRect(column * size, row * size, size, size)
        }
      }
    }

    redraw.current = draw
    draw(shown.current)
    const repaint = () => draw(shown.current)
    const observer = new ResizeObserver(repaint)
    observer.observe(box)
    scheme.addEventListener('change', repaint)
    return () => { observer.disconnect(); scheme.removeEventListener('change', repaint) }
  }, [shape, seed, mode, cell, angle])

  // A changed value eases in over a few frames, then the print is still again.
  useEffect(() => {
    const from = shown.current
    if (from === value) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { shown.current = value; redraw.current(value); return }
    const start = performance.now(), duration = 650
    let frame = 0
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      shown.current = from + (value - from) * (1 - Math.pow(1 - t, 3))
      redraw.current(shown.current)
      if (t < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [value])

  return (
    <div ref={host} className={`dither ${className}`} style={style} role={label ? 'img' : undefined} aria-label={label}>
      <canvas ref={canvas} className="dither-ink" aria-hidden />
      {children}
    </div>
  )
}
