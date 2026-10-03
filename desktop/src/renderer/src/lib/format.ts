import type { ArchivedNote } from '@shared/types'

export function wordCount(text: string): number {
  const words = text.trim().match(/\S+/g)
  return words ? words.length : 0
}

export function compact(value: number): string {
  if (value < 1000) return value.toLocaleString()
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${Math.round(value / 1000)}k`
}

function startOfDay(time: number): number {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function dayLabel(time: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(time)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const date = new Date(time)
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'long' })
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
}

export function timeLabel(time: number): string {
  return new Date(time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function longDate(time: number): string {
  const date = new Date(time)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) })
}

/** Roughly how long the dictation took to say, at a relaxed 150 words per minute. */
export function spoken(words: number): string {
  const seconds = Math.max(1, Math.round((words / 150) * 60))
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60 ? `${seconds % 60} s` : ''}`.trim()
}

export function languageName(code: string): string {
  if (!code) return ''
  try { return new Intl.DisplayNames(undefined, { type: 'language' }).of(code) ?? code } catch { return code }
}

export function groupByDay(notes: ArchivedNote[]): { label: string; notes: ArchivedNote[] }[] {
  const groups: { label: string; key: number; notes: ArchivedNote[] }[] = []
  for (const note of notes) {
    const key = startOfDay(note.created)
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.notes.push(note)
    else groups.push({ label: dayLabel(note.created), key, notes: [note] })
  }
  return groups
}

export function clock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`
}
