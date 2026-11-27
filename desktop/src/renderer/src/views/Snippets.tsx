import { AnimatePresence, motion } from 'motion/react'
import { useMemo, useRef, useState } from 'react'
import { CornerDownLeft, Pencil, Trash2, X } from 'lucide-react'
import { SNIPPET_CHARS, SNIPPET_LIMIT, TRIGGER_CHARS, type Snippet } from '@shared/types'
import { EmptyState, Highlight, useToast } from '../components/ui'
import { gentle, smooth, snappy } from '../lib/motion'
import { api } from '../lib/store'

/** One-word triggers would fire on everyday speech, so inside a sentence they need “insert” first. */
function sayLine(trigger: string): string {
  const words = trigger.match(/[\p{L}\p{N}]+/gu) ?? []
  return words.length > 1 ? `Say “${trigger}”` : `Say “insert ${trigger}”`
}

export function SnippetsView({ snippets, search }: { snippets: Snippet[]; search: string }) {
  const toast = useToast()
  const [trigger, setTrigger] = useState('')
  const [content, setContent] = useState('')
  const [editing, setEditing] = useState<Snippet | null>(null)
  const [error, setError] = useState('')
  const triggerInput = useRef<HTMLInputElement>(null)
  const query = search.trim().toLocaleLowerCase()
  const shown = useMemo(() => snippets.filter((entry) => !query || entry.trigger.toLocaleLowerCase().includes(query)
    || entry.content.toLocaleLowerCase().includes(query)), [snippets, query])

  const reset = () => { setEditing(null); setTrigger(''); setContent(''); setError('') }

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!trigger.trim()) { triggerInput.current?.focus(); return }
    const result = await api.saveSnippet(trigger, content, editing?.id)
    if (!result.ok) { setError(result.feedback); return }
    reset()
    toast(result.feedback)
    triggerInput.current?.focus()
  }

  const edit = (entry: Snippet) => {
    setEditing(entry); setTrigger(entry.trigger); setContent(entry.content); setError('')
    requestAnimationFrame(() => { triggerInput.current?.focus(); triggerInput.current?.select() })
  }

  const remove = async (entry: Snippet) => {
    const index = snippets.findIndex((item) => item.id === entry.id)
    const result = await api.removeSnippet(entry.id)
    if (editing?.id === entry.id) reset()
    toast(result.feedback, result.ok ? { label: 'Undo', run: () => { void api.restoreSnippet(entry, index) } } : undefined)
  }

  const said = trigger.trim()
  return (
    <div className="vocab scroll-area">
      <div className="vocab-inner">
        <form className="teach" onSubmit={submit}>
          <div className="teach-head">
            <div>
              <h3 className="display teach-title">{editing ? <>Editing <em>{editing.trigger}</em></> : 'Save a snippet'}</h3>
              <p className="muted">Links, addresses and templates you’d rather not dictate. Dictait pastes them exactly as saved.</p>
            </div>
            <AnimatePresence>
              {editing && (
                <motion.button type="button" className="btn ghost" onClick={reset}
                  initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={snappy}>
                  <X size={13} /> Cancel edit
                </motion.button>
              )}
            </AnimatePresence>
          </div>
          <div className="snippet-fields">
            <label className="field">
              <span className="field-label">When you say</span>
              <input ref={triggerInput} value={trigger} onChange={(event) => { setTrigger(event.target.value); setError('') }}
                placeholder="my calendly" spellCheck={false} maxLength={TRIGGER_CHARS} autoFocus />
            </label>
            <label className="field">
              <span className="field-label">Dictait pastes</span>
              <textarea value={content} rows={4} maxLength={SNIPPET_CHARS} placeholder="https://calendly.com/your-name/30min"
                onChange={(event) => { setContent(event.target.value); setError('') }}
                onKeyDown={(event) => { if (event.key === 'Enter' && event.metaKey) { event.preventDefault(); void submit() } }} />
            </label>
          </div>
          <div className="snippet-foot">
            <AnimatePresence mode="wait" initial={false}>
              <motion.p key={error ? 'error' : said ? 'said' : 'idle'} className={`teach-preview ${error ? 'error' : ''}`}
                initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={snappy}>
                {error ? error : said
                  ? <>On its own, “{said}” pastes the snippet. Inside a sentence, {sayLine(said).replace(/^Say/, 'say')}.</>
                  : 'No cleanup touches a snippet, and nothing leaves this Mac.'}
              </motion.p>
            </AnimatePresence>
            <span className="snippet-count">{content.length.toLocaleString()} / {SNIPPET_CHARS.toLocaleString()}</span>
            <button type="submit" className="btn primary teach-submit" disabled={!said || !content.trim()}>
              {editing ? 'Save' : 'Add snippet'} <CornerDownLeft size={13} strokeWidth={2.2} />
            </button>
          </div>
        </form>

        <div className="vocab-bar">
          <span className="eyebrow">Your snippets</span>
          <div className="meter" aria-label={`${snippets.length} of ${SNIPPET_LIMIT} snippets`}>
            <motion.span className="meter-fill" animate={{ width: `${(snippets.length / SNIPPET_LIMIT) * 100}%` }} transition={gentle} />
          </div>
          <span className="faint">{snippets.length} / {SNIPPET_LIMIT}</span>
        </div>

        {shown.length === 0 ? (
          <EmptyState compact title={query ? 'No snippets match.' : 'Nothing saved yet'}
            detail={query ? `Nothing like “${search.trim()}” in your snippets.`
              : <>For example, save “my calendly” as your booking link. Then say “insert my calendly” and the link appears, spelled right every time.</>} />
        ) : (
          <motion.div className="snippet-list" layout transition={smooth}>
            <AnimatePresence initial={false} mode="popLayout">
              {shown.map((entry) => (
                <motion.div key={entry.id} layout className={`word-card snippet-card ${editing?.id === entry.id ? 'editing' : ''}`} transition={smooth}
                  initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.14 } }}>
                  <div className="word-main">
                    <span className="word"><Highlight text={entry.trigger} query={search} /></span>
                    <span className="word-alias">{sayLine(entry.trigger)}</span>
                    <span className="snippet-content"><Highlight text={entry.content} query={search} /></span>
                  </div>
                  <div className="word-actions">
                    <button type="button" className="icon-btn small" onClick={() => edit(entry)} aria-label={`Edit ${entry.trigger}`} title="Edit"><Pencil size={13} /></button>
                    <button type="button" className="icon-btn small danger" onClick={() => void remove(entry)} aria-label={`Remove ${entry.trigger}`} title="Remove"><Trash2 size={13} /></button>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </div>
    </div>
  )
}
