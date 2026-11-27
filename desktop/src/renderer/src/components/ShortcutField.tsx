import { useEffect, useRef, useState } from 'react'
import { keyForDomCode, MODIFIERS, shortcutKeys, shortcutName, type Shortcut } from '@shared/shortcuts'
import type { WordResult } from '@shared/types'
import { api } from '../lib/store'
import { Keys } from './ui'

/**
 * Shows a shortcut; click it, then press the new one. Escape or clicking away cancels. Dictait's own
 * shortcuts are paused meanwhile, so pressing the current one records it instead of starting a dictation.
 */
export function ShortcutField({ value, label, onRecord, autoStart = false, onDone }: {
  value: Shortcut | null
  label: string
  onRecord: (shortcut: Shortcut) => Promise<WordResult>
  autoStart?: boolean
  /** The outcome, or null when cancelled. */
  onDone?: (result: WordResult | null) => void
}) {
  const [recording, setRecording] = useState(autoStart)
  const [held, setHeld] = useState<string[]>([])
  const button = useRef<HTMLButtonElement>(null)
  const settled = useRef(false)
  const latest = useRef({ onRecord, onDone })
  latest.current = { onRecord, onDone }

  useEffect(() => {
    if (!recording) return
    settled.current = false
    api.captureShortcut(true)
    button.current?.focus()
    const stop = (result: WordResult | null) => {
      settled.current = true
      setRecording(false)
      setHeld([])
      latest.current.onDone?.(result)
    }
    const onKey = (event: KeyboardEvent) => {
      if (settled.current) return
      event.preventDefault()
      event.stopPropagation()
      const modifiers = MODIFIERS.filter(({ name }) => ({ control: event.ctrlKey, option: event.altKey, shift: event.shiftKey, command: event.metaKey })[name])
      if (event.type === 'keydown' && event.code === 'Escape') { api.captureShortcut(false); stop(null); return }
      const info = keyForDomCode(event.code)
      // Modifiers on their own: show them while the user builds the combination.
      if (event.type === 'keyup' || !info) { setHeld(modifiers.map(({ glyph }) => glyph)); return }
      settled.current = true
      void latest.current.onRecord({ kind: 'chord', code: info.code, modifiers: modifiers.map(({ name }) => name) })
        .catch((): WordResult => ({ ok: false, feedback: 'Could not save that shortcut. Try again.' }))
        .then((result) => {
          // A refused shortcut leaves Dictait's shortcuts paused; a saved one has already turned them back on.
          if (!result.ok) api.captureShortcut(false)
          stop(result)
        })
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
      if (!settled.current) api.captureShortcut(false)
    }
  }, [recording])

  const cancel = () => {
    if (!recording || settled.current) return
    settled.current = true
    api.captureShortcut(false)
    setRecording(false)
    setHeld([])
    latest.current.onDone?.(null)
  }

  return (
    <button ref={button} type="button" className={`btn secondary shortcut-field ${recording ? 'recording' : ''}`}
      aria-label={recording ? `${label}: press the new shortcut, or Escape to cancel` : `${label}: ${value ? shortcutName(value) : 'not set'}. Click to change.`}
      title={recording ? 'Press the new shortcut. Escape cancels.' : 'Click to change'}
      onClick={() => { if (!recording) setRecording(true) }} onBlur={cancel}>
      {recording ? held.length ? <Keys keys={held} small /> : 'Type shortcut'
        : value ? <Keys keys={shortcutKeys(value)} small /> : 'Record shortcut…'}
    </button>
  )
}
