import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, Archive, ArchivedNote, ArchivedTerm, DictaitAPI } from '@shared/types'
import { createMock } from './mock'

const real = window.dictait
/** The Electron bridge, or a simulated one in previews and plain browsers. */
export const api: DictaitAPI = real && !real.preview ? real : createMock(real)

export function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null)
  useEffect(() => {
    let alive = true
    void api.getState().then((value) => { if (alive) setState(value) })
    const off = api.onState((value) => setState(value))
    return () => { alive = false; off() }
  }, [])
  return state
}

export interface ArchiveModel extends Archive {
  loaded: boolean
  termsById: Map<number, ArchivedTerm>
  notesById: Map<string, ArchivedNote>
  reload(): void
}

export function useArchive(): ArchiveModel {
  const [archive, setArchive] = useState<Archive & { loaded: boolean }>({ notes: [], terms: [], links: [], error: '', loaded: false })
  const loading = useRef(false)
  const queued = useRef(false)
  const reload = useCallback(() => {
    if (loading.current) { queued.current = true; return }
    loading.current = true
    void api.readArchive().then((value) => {
      setArchive({ ...value, loaded: true })
    }).catch(() => {
      setArchive((previous) => ({ ...previous, loaded: true, error: 'Could not read the local notes archive.' }))
    }).finally(() => {
      loading.current = false
      if (queued.current) { queued.current = false; reload() }
    })
  }, [])
  useEffect(() => {
    reload()
    return api.onArchiveChanged(reload)
  }, [reload])
  const termsById = useMemo(() => new Map(archive.terms.map((term) => [term.id, term])), [archive.terms])
  const notesById = useMemo(() => new Map(archive.notes.map((note) => [note.id, note])), [archive.notes])
  return { ...archive, termsById, notesById, reload }
}

/** Live microphone level, smoothed with a fast attack and slow release, read from a ref to avoid re-rendering. */
export function useLevelRef(active: boolean): React.RefObject<number> {
  const level = useRef(0)
  useEffect(() => {
    if (!active) { level.current = 0; return }
    return api.onLevel((value) => {
      const next = Math.max(0, Math.min(1, value))
      level.current = next > level.current ? next : level.current * 0.6 + next * 0.4
    })
  }, [active])
  return level
}

/** Seconds since a timestamp, ticking while it is set. */
export function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!startedAt) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [startedAt])
  return startedAt ? (now - startedAt) / 1000 : 0
}
