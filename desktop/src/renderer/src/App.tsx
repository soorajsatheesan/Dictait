import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { DEFAULT_SHORTCUTS, shortcutKeys } from '@shared/shortcuts'
import type { Section } from '@shared/types'
import { Sidebar } from './components/Sidebar'
import { SearchField, ToastProvider } from './components/ui'
import { compact, wordCount } from './lib/format'
import { smooth } from './lib/motion'
import { api, useAppState, useArchive } from './lib/store'
import { GraphView, visibleGraphSlice } from './views/Graph'
import { NotesView } from './views/Notes'
import { SettingsView } from './views/Settings'
import { VocabularyView } from './views/Vocabulary'
import { SetupView } from './views/Setup'
import { PracticeView } from './views/Practice'
import { CorrectionReview } from './components/CorrectionReview'

const titles: Record<Section, string> = { notes: 'Notes', graph: 'Graph', vocabulary: 'Vocabulary', settings: 'Settings', practice: 'Practice' }
const placeholders: Partial<Record<Section, string>> = { notes: 'Search your dictations', graph: 'Find a term or note', vocabulary: 'Find a word' }
const order: Section[] = ['notes', 'graph', 'vocabulary', 'settings', 'practice']

function initialSection(): Section {
  const value = new URLSearchParams(location.search).get('section')?.toLowerCase()
  return order.includes(value as Section) ? (value as Section) : 'notes'
}

export function App() {
  const state = useAppState()
  const archive = useArchive()
  const [section, setSection] = useState<Section>(initialSection)
  const [search, setSearch] = useState('')
  const [selectedNote, setSelectedNote] = useState<string | null>(null)
  const [selectedTerm, setSelectedTerm] = useState<number | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)

  const go = useCallback((next: Section) => { setSection(next); setSearch('') }, [])
  useEffect(() => api.onNavigate(go), [go])

  // ⌘F focuses search. ⌘1–5 come from the app menu; previews handle them here. Ignore while a modal overlay is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open], .setup')) return
      if (event.metaKey && event.key.toLowerCase() === 'f') { event.preventDefault(); searchInput.current?.focus(); searchInput.current?.select() }
      if (api.preview && event.metaKey && /^[1-5]$/.test(event.key)) { event.preventDefault(); go(order[Number(event.key) - 1]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go])

  const graphSummary = useMemo(() => {
    const { terms } = visibleGraphSlice(archive)
    const termIDs = new Set(terms.map((term) => term.id))
    const links = archive.links.filter((link) => termIDs.has(link.source) && termIDs.has(link.target)).length
    return { terms, links }
  }, [archive])

  // A graph opened from the menu starts on the busiest term visible in the graph.
  useEffect(() => {
    if (section === 'graph' && selectedTerm === null && !selectedNote && graphSummary.terms.length) setSelectedTerm(graphSummary.terms[0].id)
  }, [section, graphSummary.terms]) // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => {
    const words = archive.notes.reduce((total, note) => total + wordCount(note.body), 0)
    const weekAgo = Date.now() - 7 * 86_400_000
    const week = archive.notes.filter((note) => note.created >= weekAgo).reduce((total, note) => total + wordCount(note.body), 0)
    return { words, week }
  }, [archive.notes])

  const subtitle = (() => {
    switch (section) {
      case 'notes': return archive.notes.length ? `${archive.notes.length.toLocaleString()} dictations · ${compact(stats.words)} words · ${compact(stats.week)} this week` : 'Everything you dictate, kept on this Mac.'
      case 'graph': return `${graphSummary.terms.length.toLocaleString()} terms · ${graphSummary.links.toLocaleString()} connections`
      case 'vocabulary': return state ? `${state.vocabulary.length} personal ${state.vocabulary.length === 1 ? 'word' : 'words'} · ${state.rememberedTerms} learned` : ''
      case 'settings': return 'Private by design. Everything runs on this Mac.'
      case 'practice': return 'Get comfortable with dictation, one sentence at a time.'
    }
  })()

  const openTerm = (id: number) => { setSelectedTerm(id); setSelectedNote(null); go('graph') }
  const showInGraph = (id: string) => { setSelectedNote(id); setSelectedTerm(null); go('graph') }
  const openInNotes = (id: string) => { setSelectedNote(id); go('notes') }

  return (
    <MotionConfig reducedMotion="user">
      <ToastProvider>
        <div className="app">
          <Sidebar section={section} onNavigate={go} state={state}
            counts={{ notes: archive.loaded ? archive.notes.length : undefined, vocabulary: state?.vocabulary.length }} />
          <main className="content">
            <header className="header">
              <div className="header-titles">
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.div key={section} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8, transition: { duration: 0.1 } }} transition={smooth}>
                    <h1 className="display header-title">{titles[section]}</h1>
                    <p className="header-subtitle">{subtitle}</p>
                  </motion.div>
                </AnimatePresence>
              </div>
              <div className="header-actions">
                {placeholders[section] && <SearchField ref={searchInput} value={search} onChange={setSearch} placeholder={placeholders[section]!} />}
                {section !== 'settings' && section !== 'practice' && (
                  <button type="button" className="icon-btn" onClick={archive.reload} aria-label="Refresh" title="Refresh local notes"><RefreshCw size={14} strokeWidth={2} /></button>
                )}
              </div>
            </header>
            {archive.error && section !== 'settings' && section !== 'vocabulary' && section !== 'practice' && <div className="banner">{archive.error}</div>}
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={section} className="view" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.09 } }} transition={smooth}>
                {section === 'notes' && (
                  <NotesView shortcut={shortcutKeys(state?.settings.shortcuts.dictate ?? DEFAULT_SHORTCUTS.dictate)} archive={archive} search={search} selected={selectedNote} onSelect={setSelectedNote} onOpenTerm={openTerm} onShowInGraph={showInGraph} />
                )}
                {section === 'graph' && (
                  <GraphView archive={archive} search={search} selectedTerm={selectedTerm} selectedNote={selectedNote}
                    onSelectTerm={setSelectedTerm} onSelectNote={setSelectedNote} onOpenInNotes={openInNotes} />
                )}
                {section === 'vocabulary' && state && <VocabularyView vocabulary={state.vocabulary} search={search} />}
                {section === 'settings' && state && <SettingsView state={state} onPractice={() => go('practice')} />}
                {section === 'practice' && state && <PracticeView state={state} />}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
        <AnimatePresence>{state && !state.settings.setupDone && <SetupView key="setup" state={state} onPractice={() => go('practice')} />}</AnimatePresence>
        {state?.correction && <CorrectionReview key={state.correction.id} draft={state.correction} learning={state.settings.learnCorrections} />}
      </ToastProvider>
    </MotionConfig>
  )
}
