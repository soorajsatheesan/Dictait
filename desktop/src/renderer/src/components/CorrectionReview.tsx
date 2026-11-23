import { useEffect, useRef, useState } from 'react'
import { ArrowDown, X } from 'lucide-react'
import type { CorrectionDraft } from '@shared/types'
import { api } from '../lib/store'
import { useToast } from './ui'

export function CorrectionReview({ draft, learning }: { draft: CorrectionDraft; learning: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [original, setOriginal] = useState(draft.original)
  const [corrected, setCorrected] = useState(draft.corrected)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const toast = useToast()
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
    return () => { if (element?.open) element.close() }
  }, [])
  const save = async () => {
    setSaving(true); setError('')
    try {
      const result = await api.saveCorrection({ id: draft.id, original, corrected })
      if (result.ok) toast(result.feedback)
      else setError(result.feedback)
    } catch { setError('Could not save this correction. Try again.') }
    finally { setSaving(false) }
  }
  return <dialog ref={dialog} className="correction-review" aria-labelledby="correction-title" aria-describedby="correction-help"
    onCancel={(event) => { event.preventDefault(); if (!saving) api.dismissCorrection() }}>
    <div className="correction-review-head"><h2 id="correction-title">Teach Dictait a correction</h2>
      <button type="button" className="icon-btn" disabled={saving} aria-label="Close correction review" onClick={() => api.dismissCorrection()}><X size={16} /></button></div>
    <p id="correction-help">Review what changed. Keep just the sentence or phrase you want Dictait to learn.</p>
    <label className="correction-field">Heard this<textarea value={original} maxLength={1000} onChange={(event) => setOriginal(event.target.value)} rows={3} /></label>
    <ArrowDown className="correction-arrow" size={16} aria-hidden />
    <label className="correction-field">You meant this<textarea autoFocus value={corrected} maxLength={1000} onChange={(event) => setCorrected(event.target.value)} rows={3} /></label>
    <p className="correction-help">Saved only on this Mac. Used during future grammar cleanup.{!learning && ' Saving also turns on “Learn from corrections”.'}</p>
    {error && <p className="correction-error" role="alert">{error}</p>}
    <div className="correction-actions"><button type="button" className="btn secondary" disabled={saving} onClick={() => api.dismissCorrection()}>Cancel</button>
      <button type="button" className="btn primary" disabled={saving || !original.trim() || !corrected.trim() || original.trim() === corrected.trim()} onClick={() => void save()}>
        {saving ? 'Saving…' : learning ? 'Save correction' : 'Save & enable learning'}</button></div>
  </dialog>
}
