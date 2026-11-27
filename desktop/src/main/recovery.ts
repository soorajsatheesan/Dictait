import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { RecoveredRecording } from '@shared/types'
import { SUPPORT } from './paths'

/**
 * Audio is deleted once its words are delivered. A dictation that fails, times out or loses the
 * speech engine keeps its audio here instead, so it can be retried: at most 20 recordings, for at
 * most 7 days, readable only by this user. Each one is a folder of the pieces it was sent in.
 */
export const RECOVERY = join(SUPPORT, 'Recovery')
/** Audio of the dictation in progress. Anything still here at launch was interrupted. */
const PENDING = join(RECOVERY, 'pending')
const KEEP = 20
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const BYTES_PER_SECOND = 32_000
const ID = /^[A-Za-z0-9-]{1,64}$/

function privateFolder(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  try { chmodSync(path, 0o700) } catch { /* created with the right mode */ }
}

/** Seconds of 16 kHz mono 16-bit audio in this many bytes of WAV files, each with a 44-byte header. */
export function audioSeconds(bytes: number, files = 1): number {
  return Math.max(0, bytes - 44 * files) / BYTES_PER_SECOND
}

/** Writes one piece of the dictation in progress. Pieces sort in the order they were spoken. */
export function writePending(session: string, part: number | 'final', audio: Buffer): string {
  privateFolder(PENDING)
  const file = join(PENDING, `${session}-${part === 'final' ? 'final' : String(part).padStart(5, '0')}.wav`)
  writeFileSync(file, audio, { mode: 0o600 })
  return file
}

export function removeFiles(files: string[]): void {
  for (const file of files) { try { unlinkSync(file) } catch { /* already gone */ } }
}

function metaFile(id: string): string {
  return join(RECOVERY, id, 'recording.json')
}

function readMeta(id: string): RecoveredRecording | null {
  try {
    const value = JSON.parse(readFileSync(metaFile(id), 'utf8'))
    if (typeof value?.at !== 'number' || typeof value.seconds !== 'number') return null
    return { id, at: value.at, seconds: value.seconds, reason: String(value.reason ?? ''), translate: value.translate === true }
  } catch {
    return null
  }
}

function writeMeta(recording: RecoveredRecording): void {
  const { id, ...meta } = recording
  writeFileSync(metaFile(id), JSON.stringify(meta), { mode: 0o600 })
}

/** Keeps a failed dictation's audio under `id`; a recording kept before only gets the new reason. */
export function keepRecording(id: string, files: string[], meta: Omit<RecoveredRecording, 'id'>): RecoveredRecording | null {
  if (!ID.test(id)) return null
  const existing = readMeta(id)
  try {
    if (existing) {
      const updated = { ...existing, reason: meta.reason }
      writeMeta(updated)
      return updated
    }
    if (!files.length) return null
    const folder = join(RECOVERY, id)
    privateFolder(folder)
    files.forEach((file, index) => renameSync(file, join(folder, `${String(index).padStart(5, '0')}.wav`)))
    const recording = { id, ...meta }
    writeMeta(recording)
    prune()
    return recording
  } catch {
    return null
  }
}

/** The kept pieces, in the order they were spoken. */
export function recordingFiles(id: string): string[] {
  if (!ID.test(id)) return []
  try {
    return readdirSync(join(RECOVERY, id)).filter((name) => name.endsWith('.wav')).sort().map((name) => join(RECOVERY, id, name))
  } catch {
    return []
  }
}

export function deleteRecording(id: string): void {
  if (!ID.test(id) || id === 'pending') return
  try { rmSync(join(RECOVERY, id), { recursive: true, force: true }) } catch { /* already gone */ }
}

/** Kept recordings, newest first, after dropping any past the age and count limits. */
export function listRecordings(): RecoveredRecording[] {
  return prune()
}

function prune(): RecoveredRecording[] {
  let names: string[]
  try { names = readdirSync(RECOVERY) } catch { return [] }
  const now = Date.now()
  const kept: RecoveredRecording[] = []
  for (const name of names) {
    if (name === 'pending' || !ID.test(name)) continue
    const recording = readMeta(name)
    if (!recording || now - recording.at > MAX_AGE_MS || !recordingFiles(name).length) deleteRecording(name)
    else kept.push(recording)
  }
  kept.sort((a, b) => b.at - a.at)
  for (const old of kept.splice(KEEP)) deleteRecording(old.id)
  return kept
}

/** Audio left behind when Dictait quit or crashed mid-dictation becomes a kept recording. */
export function recoverInterrupted(): void {
  let names: string[]
  try { names = readdirSync(PENDING).filter((name) => name.endsWith('.wav')).sort() } catch { return }
  const sessions = new Map<string, string[]>()
  for (const name of names) {
    const session = basename(name, '.wav').replace(/-(?:\d{5}|final)$/, '')
    sessions.set(session, [...(sessions.get(session) ?? []), join(PENDING, name)])
  }
  for (const [session, files] of sessions) {
    let bytes = 0, at = Date.now()
    for (const file of files) {
      try { const info = statSync(file); bytes += info.size; at = Math.min(at, info.mtimeMs) } catch { /* counted as empty */ }
    }
    const seconds = audioSeconds(bytes, files.length)
    if (seconds < 0.5 || !keepRecording(session, files, { at, seconds, reason: 'Dictait closed before this dictation finished', translate: false })) {
      removeFiles(files)
    }
  }
}
