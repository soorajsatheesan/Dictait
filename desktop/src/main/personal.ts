import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CorrectionExample, Snippet, VocabularyEntry } from '@shared/types'
import { SUPPORT } from './paths'

/** Same file and shape as dictait-memory.sh, so both stay interchangeable. */
export interface Personalization {
  vocabulary: VocabularyEntry[]
  examples: CorrectionExample[]
  snippets: Snippet[]
}

const file = join(SUPPORT, 'personalization.json')

export function loadPersonal(): Personalization {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return {
      vocabulary: Array.isArray(value.vocabulary) ? value.vocabulary.map((entry: VocabularyEntry) => ({ ...entry, id: entry.id ?? randomUUID().toUpperCase() })) : [],
      examples: Array.isArray(value.examples) ? value.examples : [],
      snippets: Array.isArray(value.snippets) ? value.snippets
        .filter((entry: Partial<Snippet>) => entry && typeof entry.trigger === 'string' && typeof entry.content === 'string')
        .map((entry: Snippet) => ({ id: entry.id ?? randomUUID().toUpperCase(), trigger: entry.trigger, content: entry.content })) : []
    }
  } catch {
    return { vocabulary: [], examples: [], snippets: [] }
  }
}

export function savePersonal(value: Personalization): void {
  mkdirSync(SUPPORT, { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, file)
}

export function newID(): string {
  return randomUUID().toUpperCase()
}
