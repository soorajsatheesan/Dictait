import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, CornerDownLeft, Pencil, Plus, Sparkles, Trash2, X } from 'lucide-react'
import type { Suggestion, VocabularyEntry } from '@shared/types'
import { EmptyState, Highlight, useToast } from '../components/ui'
import { gentle, smooth, snappy } from '../lib/motion'
import { api } from '../lib/store'

const LIMIT = 200

export function VocabularyView({ vocabulary, search }: { vocabulary: VocabularyEntry[]; search: string }) {
  const toast = useToast()
  const [word, setWord] = useState('')
  const [alias, setAlias] = useState('')
  const [editing, setEditing] = useState<VocabularyEntry | null>(null)
  const [error, setError] = useState('')
  const wordInput = useRef<HTMLInputElement>(null)
  const query = search.trim().toLocaleLowerCase()
  const words = useMemo(() => vocabulary.filter((entry) => !query || entry.word.toLocaleLowerCase().includes(query) || entry.alias.toLocaleLowerCase().includes(query)), [vocabulary, query])

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!word.trim()) { wordInput.current?.focus(); return }
    const result = await api.addWord(word, alias)
    if (!result.ok) { setError(result.feedback); return }
    // Renaming an entry replaces the old spelling.
    if (editing && editing.word.toLocaleLowerCase() !== word.trim().toLocaleLowerCase()) await api.removeWord(editing.id)
    setWord(''); setAlias(''); setEditing(null); setError('')
    toast(result.feedback)
    wordInput.current?.focus()
  }

  const edit = (entry: VocabularyEntry) => {
    setEditing(entry); setWord(entry.word); setAlias(entry.alias); setError('')
    requestAnimationFrame(() => { wordInput.current?.focus(); wordInput.current?.select() })
  }

  const remove = async (entry: VocabularyEntry) => {
    const index = vocabulary.findIndex((item) => item.id === entry.id)
    const result = await api.removeWord(entry.id)
    if (editing?.id === entry.id) { setEditing(null); setWord(''); setAlias('') }
    toast(result.feedback, result.ok ? { label: 'Undo', run: () => { void api.restoreWord(entry, index) } } : undefined)
  }

  const preview = word.trim()
  return (
    <div className="vocab scroll-area">
      <div className="vocab-inner">
        <form className="teach" onSubmit={submit}>
          <div className="teach-head">
            <div>
              <h3 className="display teach-title">{editing ? <>Editing <em>{editing.word}</em></> : 'Teach Dictait a word'}</h3>
              <p className="muted">Names, products and jargon. If it keeps mishearing one, tell it what it hears.</p>
            </div>
            <AnimatePresence>
              {editing && (
                <motion.button type="button" className="btn ghost" onClick={() => { setEditing(null); setWord(''); setAlias('') }}
                  initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={snappy}>
                  <X size={13} /> Cancel edit
                </motion.button>
              )}
            </AnimatePresence>
          </div>
          <div className="teach-fields">
            <label className="field">
              <span className="field-label">Often heard as <span className="faint">· optional</span></span>
              <input value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="queen" spellCheck={false} maxLength={100} />
            </label>
            <span className="teach-arrow" aria-hidden><ArrowRight size={16} strokeWidth={2} /></span>
            <label className="field primary">
              <span className="field-label">Write it as</span>
              <input ref={wordInput} value={word} onChange={(event) => { setWord(event.target.value); setError('') }} placeholder="Qwen" spellCheck={false} maxLength={100} autoFocus />
            </label>
            <button type="submit" className="btn primary teach-submit" disabled={!preview}>
              {editing ? 'Save' : 'Add word'} <CornerDownLeft size={13} strokeWidth={2.2} />
            </button>
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.p key={error ? 'error' : preview ? `p-${alias.trim() ? 'alias' : 'plain'}` : 'idle'} className={`teach-preview ${error ? 'error' : ''}`}
              initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={snappy}>
              {error ? error : preview
                ? alias.trim() ? <>When you say <q>{alias.trim()}</q>, Dictait writes <b>{preview}</b>.</> : <>Dictait will listen for <b>{preview}</b> and spell it exactly so.</>
                : 'Used from your very next dictation. Nothing leaves this Mac.'}
            </motion.p>
          </AnimatePresence>
        </form>

        <Suggestions vocabulary={vocabulary} />

        <div className="vocab-bar">
          <span className="eyebrow">Your words</span>
          <div className="meter" aria-label={`${vocabulary.length} of ${LIMIT} words`}>
            <motion.span className="meter-fill" animate={{ width: `${(vocabulary.length / LIMIT) * 100}%` }} transition={gentle} />
          </div>
          <span className="faint mono">{vocabulary.length} / {LIMIT}</span>
        </div>

        {words.length === 0 ? (
          <EmptyState compact title={query ? 'No words match.' : 'Your words, spelled your way.'}
            detail={query ? `Nothing like “${search.trim()}” in your vocabulary.` : 'Add the names and terms you say most. Dictait also learns terms from your notes on its own.'} />
        ) : (
          <motion.div className="word-grid" layout transition={smooth}>
            <AnimatePresence initial={false} mode="popLayout">
              {words.map((entry) => (
                <motion.div key={entry.id} layout className={`word-card ${editing?.id === entry.id ? 'editing' : ''}`} transition={smooth}
                  initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.14 } }}>
                  <div className="word-main">
                    <span className="word"><Highlight text={entry.word} query={search} /></span>
                    {entry.alias ? <span className="word-alias">heard as <q><Highlight text={entry.alias} query={search} /></q></span> : <span className="word-alias faint">exact spelling</span>}
                  </div>
                  <div className="word-actions">
                    <button type="button" className="icon-btn small" onClick={() => edit(entry)} aria-label={`Edit ${entry.word}`} title="Edit"><Pencil size={13} /></button>
                    <button type="button" className="icon-btn small danger" onClick={() => void remove(entry)} aria-label={`Remove ${entry.word}`} title="Remove"><Trash2 size={13} /></button>
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

/** Names fixed in your corrections and terms you keep saying, one click from your vocabulary. */
function Suggestions({ vocabulary }: { vocabulary: VocabularyEntry[] }) {
  const toast = useToast()
  const [items, setItems] = useState<Suggestion[]>([])
  useEffect(() => { void api.suggestions().then(setItems) }, [vocabulary])
  if (!items.length) return null
  const add = async (item: Suggestion) => {
    const result = await api.addWord(item.word, item.alias)
    toast(result.feedback)
  }
  const dismiss = async (item: Suggestion) => {
    setItems((list) => list.filter((entry) => entry !== item))
    await api.dismissSuggestion(item.word)
  }
  return (
    <section className="suggestions">
      <div className="suggestions-head"><Sparkles size={13} /> <span className="eyebrow">Suggested for you</span></div>
      <div className="suggestion-list">
        <AnimatePresence initial={false} mode="popLayout">
          {items.map((item) => (
            <motion.div key={item.word} layout className="suggestion" transition={smooth}
              initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.12 } }}>
              <div className="suggestion-text">
                <span className="word">{item.word}</span>
                <span className="word-alias">{item.alias ? <>heard as <q>{item.alias}</q> · </> : null}{item.reason}</span>
              </div>
              <button type="button" className="icon-btn small" onClick={() => void add(item)} aria-label={`Add ${item.word}`} title="Add to vocabulary"><Plus size={14} /></button>
              <button type="button" className="icon-btn small" onClick={() => void dismiss(item)} aria-label={`Dismiss ${item.word}`} title="Not now"><X size={13} /></button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </section>
  )
}
