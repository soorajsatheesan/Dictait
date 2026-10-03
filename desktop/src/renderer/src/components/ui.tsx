import { AnimatePresence, motion } from 'motion/react'
import { createContext, forwardRef, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import { snappy, smooth } from '../lib/motion'

/** Dictait's mark: a speech-bubble D with a text caret cut through it. */
export function Mark({ size = 22 }: { size?: number }) {
  const gradient = useId()
  return (
    <svg className="mark" width={size * 0.86} height={size} viewBox="24 21 57 66" aria-hidden>
      <defs>
        <linearGradient id={gradient} x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor="#FF9456" />
          <stop offset="1" stopColor="#FF4A2E" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradient})`}
        fillRule="evenodd"
        d="M26 31 C26 26.6 29.6 23 34 23 H50 A27 27 0 0 1 50 77 H40 L29.5 85.2 C28 86.4 26 85.3 26 83.4 Z M41 35 H55 A2.5 2.5 0 0 1 55 40 H50.5 V60 H55 A2.5 2.5 0 0 1 55 65 H41 A2.5 2.5 0 0 1 41 60 H45.5 V40 H41 A2.5 2.5 0 0 1 41 35 Z"
      />
    </svg>
  )
}

export function Keys({ keys, small = false }: { keys: string[]; small?: boolean }) {
  return (
    <span className={`keys ${small ? 'small' : ''}`}>
      {keys.map((key) => <kbd key={key} className="keycap">{key}</kbd>)}
    </span>
  )
}

export function Switch({ on, onChange, disabled = false, label }: { on: boolean; onChange: (value: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <motion.span className="switch-knob" layout transition={snappy} />
    </button>
  )
}

export interface Option<T extends string> { value: T; label: ReactNode; disabled?: boolean; hint?: string }

export function Segmented<T extends string>({ value, options, onChange, disabled = false, label }: {
  value: T; options: Option<T>[]; onChange: (value: T) => void; disabled?: boolean; label: string
}) {
  const id = useId()
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const active = option.value === value
        return (
          <button key={option.value} type="button" role="radio" aria-checked={active} title={option.hint}
            disabled={disabled || option.disabled} className={`segment ${active ? 'active' : ''}`} onClick={() => onChange(option.value)}>
            {active && <motion.span layoutId={`segment-${id}`} className="segment-thumb" transition={snappy} />}
            <span className="segment-label">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export function TermChip({ name, color, onClick, meta }: { name: string; color: string; onClick?: () => void; meta?: string }) {
  return (
    <button type="button" className="term-chip" style={{ '--kind': color } as React.CSSProperties} onClick={onClick} disabled={!onClick}>
      <span className="term-dot" />
      <span>{name}</span>
      {meta && <span className="term-meta">{meta}</span>}
    </button>
  )
}

export const SearchField = forwardRef<HTMLInputElement, { value: string; onChange: (value: string) => void; placeholder: string }>(
  function SearchField({ value, onChange, placeholder }, ref) {
    const [focused, setFocused] = useState(false)
    return (
      <label className={`search ${focused ? 'focused' : ''}`}>
        <Search size={14} strokeWidth={2.2} className="search-icon" />
        <input ref={ref} value={value} placeholder={placeholder} spellCheck={false}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') { onChange(''); (event.target as HTMLInputElement).blur() } }} />
        <AnimatePresence initial={false}>
          {value ? (
            <motion.button key="clear" type="button" className="search-clear" aria-label="Clear search" onClick={() => onChange('')}
              initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }} transition={snappy}>
              <X size={11} strokeWidth={2.6} />
            </motion.button>
          ) : !focused && (
            <motion.span key="hint" className="search-hint" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={snappy}>
              <Keys keys={['⌘', 'F']} small />
            </motion.span>
          )}
        </AnimatePresence>
      </label>
    )
  }
)

export function EmptyState({ title, detail, children, compact = false }: { title: string; detail: ReactNode; children?: ReactNode; compact?: boolean }) {
  return (
    <motion.div className={`empty ${compact ? 'compact' : ''}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={smooth}>
      {!compact && (
        <div className="empty-art" aria-hidden>
          <Mark size={56} />
        </div>
      )}
      <h3 className="display empty-title">{title}</h3>
      <p className="empty-detail">{detail}</p>
      {children && <div className="empty-actions">{children}</div>}
    </motion.div>
  )
}

/** Inline highlight of a search query inside text. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim()
  if (!needle) return <>{text}</>
  const lower = text.toLocaleLowerCase(), target = needle.toLocaleLowerCase()
  const parts: ReactNode[] = []
  let start = 0, index = lower.indexOf(target)
  while (index >= 0 && parts.length < 40) {
    if (index > start) parts.push(text.slice(start, index))
    parts.push(<mark key={index}>{text.slice(index, index + needle.length)}</mark>)
    start = index + needle.length
    index = lower.indexOf(target, start)
  }
  parts.push(text.slice(start))
  return <>{parts}</>
}

// Toasts: one at a time, bottom of the content area, with an optional action such as Undo.
interface Toast { id: number; message: string; action?: { label: string; run: () => void } }
const ToastContext = createContext<(message: string, action?: Toast['action']) => void>(() => {})

export function useToast() {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const show = useCallback((message: string, action?: Toast['action']) => {
    window.clearTimeout(timer.current)
    setToast({ id: Date.now(), message, action })
    timer.current = window.setTimeout(() => setToast(null), action ? 5200 : 2600)
  }, [])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-layer" aria-live="polite">
        <AnimatePresence>
          {toast && (
            <motion.div key={toast.id} className="toast" initial={{ opacity: 0, y: 14, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.14 } }} transition={smooth}>
              <span>{toast.message}</span>
              {toast.action && (
                <button type="button" className="toast-action" onClick={() => { toast.action?.run(); setToast(null) }}>{toast.action.label}</button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}
