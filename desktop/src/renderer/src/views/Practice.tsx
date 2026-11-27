import { useEffect, useRef, useState } from 'react'
import { Check, Mic, RotateCcw, Square } from 'lucide-react'
import { shortcutKeys, shortcutName } from '@shared/shortcuts'
import type { AppState } from '@shared/types'
import { Keys } from '../components/ui'
import { api } from '../lib/store'

const lessons = [
  { id: 'tap', title: 'Tap to record', instruction: (key: string) => `Tap ${key}, say a sentence, then tap it again to finish.`, example: 'Try: “Remind me to review the design tomorrow.”' },
  { id: 'hold', title: 'Hold to talk', instruction: (key: string) => `Hold ${key} for at least 1.2 seconds. Watch the rail fill, speak, then release to finish.`, example: 'The island changes to “Release to finish” when hold-to-talk is ready.' },
  { id: 'edit', title: 'Edit by voice', instruction: (key: string) => `Select the sentence below, tap ${key} and say “make this shorter”. Tap again to finish.`, example: 'Your selection is rewritten using your instruction.' }
] as const
type Lesson = typeof lessons[number]['id']
const sample = 'I wanted to let you know that I will be available to meet tomorrow afternoon to discuss the design.'

export function PracticeView({ state }: { state: AppState }) {
  const [lesson, setLesson] = useState<Lesson>('tap')
  const [text, setText] = useState('')
  const [selected, setSelected] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const pendingSelect = useRef<{ focusEditor: boolean } | null>(null)
  const recording = state.phase === 'recording'
  const busy = state.phase !== 'ready' && !recording
  const current = lessons.find((item) => item.id === lesson)!
  const { shortcuts } = state.settings
  useEffect(() => { field.current?.focus() }, [])
  useEffect(() => {
    const pending = pendingSelect.current
    if (!pending || lesson !== 'edit' || !field.current || !text) return
    pendingSelect.current = null
    if (pending.focusEditor) field.current.focus()
    field.current.setSelectionRange(0, field.current.value.length)
    setSelected(field.current.selectionStart !== field.current.selectionEnd)
  }, [lesson, text])
  const choose = (next: Lesson, focusEditor = true) => {
    setLesson(next)
    if (next === 'edit') {
      pendingSelect.current = { focusEditor }
      if (!text.trim()) setText(sample)
      else {
        requestAnimationFrame(() => {
          if (pendingSelect.current && field.current) {
            pendingSelect.current = null
            if (focusEditor) field.current.focus()
            field.current.setSelectionRange(0, field.current.value.length)
            setSelected(field.current.selectionStart !== field.current.selectionEnd)
          }
          if (!focusEditor) document.getElementById(`lesson-${next}`)?.focus()
        })
      }
      if (!focusEditor) requestAnimationFrame(() => document.getElementById(`lesson-${next}`)?.focus())
      return
    }
    pendingSelect.current = null
    requestAnimationFrame(() => {
      if (focusEditor) field.current?.focus()
      else document.getElementById(`lesson-${next}`)?.focus()
    })
  }
  return <div className="practice scroll-area"><div className="practice-inner">
    <div className="practice-lessons" role="tablist" aria-label="Dictation practice">
      {lessons.map((item) => <button key={item.id} type="button" role="tab" aria-selected={lesson === item.id} aria-controls="practice-panel" id={`lesson-${item.id}`}
        tabIndex={lesson === item.id ? 0 : -1} onKeyDown={(event) => {
          const index = lessons.findIndex((entry) => entry.id === lesson)
          const next = event.key === 'ArrowRight' ? (index + 1) % lessons.length : event.key === 'ArrowLeft' ? (index + lessons.length - 1) % lessons.length : event.key === 'Home' ? 0 : event.key === 'End' ? lessons.length - 1 : -1
          if (next >= 0) { event.preventDefault(); choose(lessons[next].id, false) }
        }}
        className={`practice-lesson ${lesson === item.id ? 'active' : ''}`} disabled={state.phase !== 'ready'} onClick={() => choose(item.id)}>
        <span className={`practice-check ${state.practiceCompleted.includes(item.id) ? 'complete' : ''}`}>{state.practiceCompleted.includes(item.id) ? <Check size={12} /> : lessons.indexOf(item) + 1}</span>{item.title}
      </button>)}
    </div>
    <section id="practice-panel" role="tabpanel" aria-labelledby={`lesson-${lesson}`}>
      <h2>{current.title}</h2><p className="practice-instruction">{current.instruction(shortcutName(shortcuts.dictate))}</p><p className="practice-example">{current.example}</p>
      {lesson === 'edit' && !state.settings.voiceEdits && <div className="practice-enable">Voice editing is turned off. <button type="button" className="btn ghost" onClick={() => void api.setSettings({ voiceEdits: true })}>Enable voice editing</button></div>}
      <label className="practice-label" htmlFor="practice-editor">Your practice text<span>{lesson === 'edit' && selected ? 'Selection ready for voice editing' : 'Click here, then use the shortcut'}</span></label>
      <textarea id="practice-editor" data-practice="true" ref={field} value={text} onChange={(event) => setText(event.target.value)}
        onSelect={() => setSelected(Boolean(field.current && field.current.selectionStart !== field.current.selectionEnd))}
        className="practice-editor" placeholder="Your words will appear here…" aria-describedby="practice-privacy" />
      <div className="practice-toolbar">
        <button type="button" className={`btn ${recording ? 'secondary' : 'primary'}`} disabled={busy} onMouseDown={(event) => event.preventDefault()}
          onClick={() => { field.current?.focus(); api.toggleRecording() }}>
          {recording ? <Square size={12} /> : <Mic size={14} />}{recording ? 'Finish dictation' : 'Try dictation'}<Keys keys={shortcutKeys(shortcuts.dictate)} small />
        </button>
        <button type="button" className="btn ghost" disabled={state.phase !== 'ready' || !text} onClick={() => { setText(''); field.current?.focus() }}><RotateCcw size={13} />Clear text</button>
        {recording && <button type="button" className="btn ghost" onClick={() => api.cancelRecording()}>Cancel <Keys keys={['esc']} small /></button>}
      </div>
      <div className="practice-feedback" role="status">{recording ? 'Listening. Follow the control shown in the island.' : busy ? state.message
        : state.practiceCompleted.includes(lesson) ? <><Check size={14} />{current.title} completed. Try another lesson or keep practising.</>
          : lesson === 'edit' && !selected ? 'Select some text to tell Dictait what to rewrite.' : 'Ready when you are.'}</div>
      {!state.settings.autoPaste && <p className="practice-note">Automatic paste is off. After dictating, focus the practice box and press ⌘V to insert your words.</p>}
      <p id="practice-privacy" className="practice-note">Practice dictations aren’t saved to Notes or memory. The text box clears when you leave. Your last dictation is still available with <Keys keys={shortcutKeys(shortcuts.pasteLast)} small />.</p>
    </section>
  </div></div>
}
