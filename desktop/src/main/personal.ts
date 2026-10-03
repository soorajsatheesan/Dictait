import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CorrectionExample, VocabularyEntry } from '@shared/types'
import { SUPPORT } from './paths'

/** Same file and shape as dictait-memory.sh, so both stay interchangeable. */
export interface Personalization {
  vocabulary: VocabularyEntry[]
  examples: CorrectionExample[]
}

const file = join(SUPPORT, 'personalization.json')

export function loadPersonal(): Personalization {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return {
      vocabulary: Array.isArray(value.vocabulary) ? value.vocabulary.map((entry: VocabularyEntry) => ({ ...entry, id: entry.id ?? randomUUID().toUpperCase() })) : [],
      examples: Array.isArray(value.examples) ? value.examples : []
    }
  } catch {
    return { vocabulary: [], examples: [] }
  }
}

export function savePersonal(value: Personalization): void {
  mkdirSync(SUPPORT, { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, file)
}

export function newID(): string {
  return randomUUID().toUpperCase()
}
