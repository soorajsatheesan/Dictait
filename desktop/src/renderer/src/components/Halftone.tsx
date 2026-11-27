import { useEffect, useRef, type ReactNode } from 'react'

/** A stable seed for any id, so the same note always prints the same pattern. */
function seed(id: string): number {
  let hash = 2166136261
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619) >>> 0
  return hash
}

/**
 * A halftone print: a rotated grid of ink dots whose size carries the tone. Each id gets its own
 * two soft light sources, so every note's cover is a different print of the same press.
 */
export function Halftone({ id, className = '', children }: { id: string; className?: string; children?: ReactNode }) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const element = canvas.current, box = host.current
    const context = element?.getContext('2d')
    if (!element || !box || !context) return
    const hash = seed(id)
    const unit = (shift: number) => ((hash >>> shift) & 0xff) / 255
    const a = { x: 0.55 + unit(0) * 0.4, y: 0.2 + unit(8) * 0.9, r: 0.32 + unit(16) * 0.22 }
    const b = { x: 0.35 + unit(4) * 0.5, y: 0.7 + unit(12) * 0.6, r: 0.18 + unit(20) * 0.16 }
    const angle = (unit(24) * 30 + 30) * Math.PI / 180
    const draw = () => {
      const width = box.clientWidth, height = box.clientHeight, ratio = window.devicePixelRatio || 2
      element.width = width * ratio; element.height = height * ratio
      element.style.width = `${width}px`; element.style.height = `${height}px`
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)
      context.fillStyle = getComputedStyle(element).color
      const pitch = 6.5, max = pitch * 0.56
      const cos = Math.cos(angle), sin = Math.sin(angle)
      const reach = Math.hypot(width, height)
      // Walk a rotated grid that covers the box, like a screen laid at an angle.
      for (let u = -reach; u < reach; u += pitch) {
        for (let v = -reach; v < reach; v += pitch) {
          const x = width / 2 + u * cos - v * sin, y = height / 2 + u * sin + v * cos
          if (x < -pitch || y < -pitch || x > width + pitch || y > height + pitch) continue
          const nx = x / width, ny = y / height * (height / width)
          const da = Math.hypot(nx - a.x, ny - a.y * (height / width)) / a.r
          const db = Math.hypot(nx - b.x, ny - b.y * (height / width)) / b.r
          const tone = Math.min(1, Math.exp(-da * da) + 0.7 * Math.exp(-db * db))
          const radius = max * Math.sqrt(tone)
          if (radius < 0.35) continue
          context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill()
        }
      }
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(box)
    return () => observer.disconnect()
  }, [id])
  return (
    <div ref={host} className={`halftone ${className}`}>
      <canvas ref={canvas} className="halftone-ink" aria-hidden />
      {children}
    </div>
  )
}
