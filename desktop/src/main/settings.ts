import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Settings } from '@shared/types'
import { SUPPORT } from './paths'

export interface Stored extends Settings {
  detectedLanguage: string
  configuredLogin: boolean
  promptedAccessibility: boolean
  dismissedSuggestions: string[]
  windowBounds?: { x: number; y: number; width: number; height: number }
}

const defaults: Stored = {
  backend: 'whisper', language: 'auto', cleanup: true, autoPaste: true, smartFormatting: true,
  writingStyle: 'Keep my natural tone and wording.', memoryMode: 'notes', learnCorrections: true,
  appearance: 'system', useContext: true, voiceEdits: true, appTones: true, microphone: 'auto',
  setupDone: false, autoUpdate: true,
  tones: {
    messaging: 'Casual and brief, like a chat message. No greeting or sign-off unless I say one.',
    email: 'Clear and friendly, in complete sentences and short paragraphs. Keep greetings and sign-offs I say.',
    code: 'Literal and precise. Keep technical terms, file names, commands and identifiers exactly as said. No filler.',
    docs: 'Well structured. Use paragraphs, or a list when the content is a list.'
  },
  detectedLanguage: '', configuredLogin: false, promptedAccessibility: false, dismissedSuggestions: []
}

const file = join(SUPPORT, 'settings.json')

/** One-time import of preferences written by the earlier native app (same bundle identifier). */
function legacyPreferences(): Partial<Stored> {
  try {
    const plist = execFileSync('/usr/bin/defaults', ['export', 'org.dictait.mac', '-'], { encoding: 'utf8', timeout: 2000 })
    const values: Record<string, unknown> = {}
    const pattern = /<key>([^<]+)<\/key>\s*(?:<string>([^<]*)<\/string>|<(true|false)\/>)/g
    for (const match of plist.matchAll(pattern)) {
      values[match[1]] = match[3] ? match[3] === 'true' : decode(match[2] ?? '')
    }
    const keys = Object.keys(defaults) as (keyof Stored)[]
    return Object.fromEntries(keys.filter((key) => key in values && typeof values[key] === typeof defaults[key]).map((key) => [key, values[key]]))
  } catch {
    return {}
  }
}

function decode(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

export function loadSettings(): Stored {
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    // Anyone upgrading from a version without the setup stage has already set Dictait up.
    if (stored.setupDone === undefined) stored.setupDone = true
    return { ...defaults, ...stored, tones: { ...defaults.tones, ...(stored.tones ?? {}) } }
  } catch {
    const legacy = legacyPreferences()
    const migrated = { ...defaults, ...legacy, setupDone: Object.keys(legacy).length > 0 }
    saveSettings(migrated)
    return migrated
  }
}

export function saveSettings(value: Stored): void {
  try {
    mkdirSync(SUPPORT, { recursive: true })
    const temporary = `${file}.tmp`
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    renameSync(temporary, file)
  } catch {
    // Settings are a convenience; failing to persist must not break dictation.
  }
}
