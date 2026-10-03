import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Waypoints } from 'lucide-react'
import type { ArchivedNote } from '@shared/types'
import { EmptyState, Highlight, Keys, TermChip } from '../components/ui'
import { dayLabel, groupByDay, languageName, longDate, spoken, timeLabel, wordCount } from '../lib/format'
import { kindOf } from '../lib/kinds'
import { smooth, snappy } from '../lib/motion'
import { api, type ArchiveModel } from '../lib/store'

function filterNotes(notes: ArchivedNote[], search: string): ArchivedNote[] {
  const query = search.trim().toLocaleLowerCase()
  return query ? notes.filter((note) => note.body.toLocaleLowerCase().includes(query)) : notes
}

export function NotesView({ archive, search, selected, onSelect, onOpenTerm, onShowInGraph }: {
  archive: ArchiveModel; search: string; selected: string | null; onSelect: (id: string) => void
  onOpenTerm: (id: number) => void; onShowInGraph: (id: string) => void
}) {
  const notes = useMemo(() => filterNotes(archive.notes, search), [archive.notes, search])
  const groups = useMemo(() => groupByDay(notes), [notes])
  const current = notes.find((note) => note.id === selected) ?? notes[0]
  const list = useRef<HTMLDivElement>(null)

  // Arrow keys move through the list unless the user is typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key) || (event.target as HTMLElement).closest('input, textarea')) return
      const index = notes.findIndex((note) => note.id === current?.id)
      const next = notes[Math.max(0, Math.min(notes.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]
      if (!next) return
      event.preventDefault()
      onSelect(next.id)
      list.current?.querySelector(`[data-note="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [notes, current, onSelect])

  if (archive.loaded && archive.notes.length === 0) {
    return (
      <EmptyState title="Say something worth keeping." detail={<>Click into any text box, press <Keys keys={['⌃', 'Space']} small /> and talk. Press it again and your words land right there, and here, searchable forever.</>} />
    )
  }

  return (
    <div className="notes">
      <motion.div className="note-list" ref={list} layoutScroll role="listbox" aria-label="Dictations">
        {groups.map((group) => (
          <section key={group.label} className="note-group">
            <h3 className="eyebrow note-group-label">{group.label}</h3>
            {group.notes.map((note) => (
              <NoteRow key={note.id} note={note} active={note.id === current?.id} search={search} archive={archive} onSelect={() => onSelect(note.id)} />
            ))}
          </section>
        ))}
        {notes.length === 0 && (
          <div className="note-list-empty">
            <p className="muted">Nothing matches “{search.trim()}”.</p>
          </div>
        )}
      </motion.div>
      <div className="note-pane">
        <AnimatePresence mode="popLayout" initial={false}>
          {current && (
            <motion.div key={current.id} className="note-pane-inner" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.08 } }} transition={smooth}>
              <NoteDetail note={current} archive={archive} search={search} onOpenTerm={onOpenTerm} onShowInGraph={onShowInGraph} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

function NoteRow({ note, active, search, archive, onSelect }: { note: ArchivedNote; active: boolean; search: string; archive: ArchiveModel; onSelect: () => void }) {
  const terms = note.terms.map((id) => archive.termsById.get(id)).filter(Boolean)
  return (
    <button type="button" role="option" aria-selected={active} data-note={note.id} className={`note-row ${active ? 'active' : ''}`} onClick={onSelect}>
      {active && <motion.span layoutId="note-active" className="note-active" transition={snappy} />}
      <span className="note-row-meta">
        <span>{timeLabel(note.created)}</span>
        <span className="note-row-words">{wordCount(note.body)} words</span>
      </span>
      <span className="note-row-body"><Highlight text={note.body.replace(/\n\s*\n/g, '\n')} query={search} /></span>
      {terms.length > 0 && (
        <span className="note-row-terms">
          {terms.slice(0, 3).map((term) => (
            <span key={term!.id} className="mini-term"><i style={{ background: kindOf(term!.kind).color }} />{term!.name}</span>
          ))}
          {terms.length > 3 && <span className="mini-term more">+{terms.length - 3}</span>}
        </span>
      )}
    </button>
  )
}

export function NoteDetail({ note, archive, search = '', onOpenTerm, onShowInGraph, onOpenInNotes, compact = false }: {
  note: ArchivedNote; archive: ArchiveModel; search?: string; onOpenTerm: (id: number) => void
  onShowInGraph?: (id: string) => void; onOpenInNotes?: (id: string) => void; compact?: boolean
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])
  const words = wordCount(note.body)
  const terms = note.terms.map((id) => archive.termsById.get(id)).filter((term) => term !== undefined)
  return (
    <article className={`note-detail ${compact ? 'compact' : ''}`}>
      <header className="note-detail-head">
        <div>
          <div className="eyebrow">{dayLabel(note.created)} · {timeLabel(note.created)}</div>
          {!compact && <div className="note-detail-date display">{longDate(note.created)}</div>}
        </div>
        <div className="note-actions">
          {onShowInGraph && (
            <button type="button" className="btn ghost" onClick={() => onShowInGraph(note.id)} title="Show in graph">
              <Waypoints size={14} strokeWidth={2} /> Graph
            </button>
          )}
          {onOpenInNotes && (
            <button type="button" className="btn ghost" onClick={() => onOpenInNotes(note.id)}>Open in Notes</button>
          )}
          <button type="button" className={`btn ${copied ? 'success' : 'secondary'}`} onClick={() => { void api.copyText(note.body); setCopied(true) }}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={copied ? 'done' : 'copy'} className="btn-swap" initial={{ opacity: 0, scale: 0.7 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.7 }} transition={snappy}>
                {copied ? <Check size={14} strokeWidth={2.6} /> : <Copy size={14} strokeWidth={2} />}
              </motion.span>
            </AnimatePresence>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </header>
      <div className="note-body selectable"><Highlight text={note.body} query={search} /></div>
      <footer className="note-detail-foot">
        <div className="note-facts">
          <span><b>{words}</b> words</span>
          <span>~{spoken(words)} spoken</span>
          {note.language && <span>{languageName(note.language)}</span>}
        </div>
        {terms.length > 0 && (
          <div className="note-connections">
            <div className="eyebrow">Connections</div>
            <div className="chips">
              {terms.map((term) => <TermChip key={term.id} name={term.name} color={kindOf(term.kind).color} onClick={() => onOpenTerm(term.id)} />)}
            </div>
          </div>
        )}
      </footer>
    </article>
  )
}
