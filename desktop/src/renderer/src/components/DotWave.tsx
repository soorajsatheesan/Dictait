import { useEffect, useRef } from 'react'

/**
 * A decorative dot-matrix voice readout, the same language as the notch card. It speaks in bursts
 * with pauses between, and draws in the current text colour.
 */
export function DotWave({ width = 220, height = 24, rows = 7, pitch = 4 }: { width?: number; height?: number; rows?: number; pitch?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return
    const ratio = window.devicePixelRatio || 2
    element.width = width * ratio; element.height = height * ratio
    context.scale(ratio, ratio)
    const columns = Math.floor(width / pitch)
    const top = (height - (rows - 1) * pitch) / 2
    const color = getComputedStyle(element).color
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let frame = 0
    const voice = (t: number) => {
      const phrase = Math.max(0, Math.sin(t * 0.9)) // speaking, then a pause
      return phrase * (0.45 + 0.3 * Math.sin(t * 5.3) * Math.sin(t * 1.7) + 0.2 * Math.sin(t * 13.1))
    }
    const draw = (time: number) => {
      context.clearRect(0, 0, width, height)
      const now = time / 1000
      for (let c = 0; c < columns; c++) {
        const level = Math.max(0, Math.min(1, voice(now - (columns - c) * 0.046)))
        const reach = level * (rows / 2)
        const fade = Math.min(1, 0.1 + (c / columns) * 1.3)
        for (let r = 0; r < rows; r++) {
          const distance = Math.abs(r - (rows - 1) / 2)
          const lit = distance <= reach - 0.15
          context.globalAlpha = lit ? fade * (1 - distance * 0.1) : distance === 0 ? 0.3 * fade : 0.1
          context.fillStyle = color
          context.beginPath()
          context.arc(c * pitch + pitch / 2, top + r * pitch, lit ? 1.45 : 1.3, 0, Math.PI * 2)
          context.fill()
        }
      }
      context.globalAlpha = 1
      if (!still) frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [width, height, rows, pitch])
  return <canvas ref={canvas} className="dot-wave" style={{ width, height }} aria-hidden />
}
