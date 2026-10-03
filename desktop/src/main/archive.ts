import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Archive, ArchivedNote } from '@shared/types'
import { SUPPORT } from './paths'

// Everyday words that older versions learned as "terms" (Let, So, First); hidden, never deleted.
const COMMON = new Set(`a about actually add after again ah all also am an and any are as ask at back bad be because been before being
both but by call can check clean close come could day did do does done dude each eight even every fine first five for four from get
give go going good got great had has have he hello her here hey hi him his how i if in is it its just keep know last let like look
made make many maybe me more most much my need new next nice nine no not now number of off ok okay old on one only or other our out
over please point put read really right run said same say second see send set seven she should show six so some start still stop
such sure take tell ten test than thank thanks that the their them then there these they thing think third this those three
through to today tomorrow too try turn two um uh up us use very want was we well were what when where which who why will with
would write yeah yes yesterday yet you your monday tuesday wednesday thursday friday saturday sunday`.split(/\s+/))

let dictionary: Set<string> | null = null

/** Lowercase English words from macOS's own word list (proper nouns there are capitalized). */
function words(): Set<string> {
  if (!dictionary) {
    try { dictionary = new Set(readFileSync('/usr/share/dict/words', 'utf8').split('\n').filter((word) => /^[a-z]/.test(word))) }
    catch { dictionary = new Set() }
  }
  return dictionary
}

/** Same rule as the worker: a guessed term must read like a name, not a capitalized ordinary word. */
function nameLike(term: string): boolean {
  const parts = term.toLowerCase().match(/[a-z0-9']+/g) ?? []
  if (parts.every((word) => COMMON.has(word))) return false
  const ordinary = (word: string) => COMMON.has(word) || words().has(word)
  if (parts.length === 1) return !ordinary(parts[0])
  return !parts.some((word) => COMMON.has(word)) || parts.some((word) => !ordinary(word))
}

/** Reads the worker's SQLite archive directly and read-only. No HTTP service or browser process. */
export async function readArchive(): Promise<Archive> {
  const path = join(SUPPORT, 'memory.sqlite3')
  if (!existsSync(path)) return { notes: [], terms: [], links: [], error: '' }
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(path, { readOnly: true, timeout: 1000 })
    try {
      const noteTerms = new Map<string, number[]>()
      for (const row of database.prepare('SELECT note_id, term_id FROM note_terms').all() as { note_id: string; term_id: number }[]) {
        const list = noteTerms.get(row.note_id) ?? []
        list.push(Number(row.term_id))
        noteTerms.set(row.note_id, list)
      }
      const notes: ArchivedNote[] = (database.prepare('SELECT id, body, created, language FROM notes ORDER BY created DESC').all() as
        { id: string; body: string; created: number; language: string | null }[])
        .map((row) => ({ id: row.id, body: row.body, created: Number(row.created) * 1000, language: row.language ?? '', terms: noteTerms.get(row.id) ?? [] }))
      const terms = (database.prepare('SELECT id, term, kind, uses FROM terms ORDER BY uses DESC, last_used DESC').all() as
        { id: number; term: string; kind: string; uses: number }[])
        .filter((row) => row.kind !== 'term' || nameLike(row.term))
        .map((row) => ({ id: Number(row.id), name: row.term, kind: row.kind, mentions: Number(row.uses) }))
      const kept = new Set(terms.map((term) => term.id))
      const links = (database.prepare('SELECT source, target, weight FROM links').all() as { source: number; target: number; weight: number }[])
        .map((row) => ({ source: Number(row.source), target: Number(row.target), weight: Number(row.weight) }))
        .filter((link) => kept.has(link.source) && kept.has(link.target))
      for (const note of notes) note.terms = note.terms.filter((id) => kept.has(id))
      return { notes, terms, links, error: '' }
    } finally {
      database.close()
    }
  } catch {
    return { notes: [], terms: [], links: [], error: 'The notes archive is not ready yet. It will refresh after the models load.' }
  }
}
