/** Keyboard shortcuts: what is stored, how it is checked, and how it reads on screen. */

export type ShortcutModifier = 'control' | 'option' | 'shift' | 'command'
/** A modifier pressed on its own: tap to start and finish, hold to talk. */
export type ModifierKey = 'rightCommand' | 'rightOption' | 'fn'
export type ShortcutAction = 'dictate' | 'pasteLast' | 'learnCorrection'

export type Shortcut =
  /** Modifiers plus one key; `code` is the macOS virtual key code (49 is Space). */
  | { kind: 'chord'; code: number; modifiers: ShortcutModifier[] }
  | { kind: 'modifier'; key: ModifierKey }

export type Shortcuts = Record<ShortcutAction, Shortcut>

export const DEFAULT_SHORTCUTS: Shortcuts = {
  dictate: { kind: 'chord', code: 49, modifiers: ['control'] },
  pasteLast: { kind: 'chord', code: 9, modifiers: ['control', 'option'] },
  learnCorrection: { kind: 'chord', code: 37, modifiers: ['control', 'option'] }
}

export const ACTION_NAMES: Record<ShortcutAction, string> = {
  dictate: 'Start and finish', pasteLast: 'Paste last dictation', learnCorrection: 'Review a correction'
}

/** macOS order: ⌃ ⌥ ⇧ ⌘. */
export const MODIFIERS: { name: ShortcutModifier; glyph: string; word: string; accelerator: string }[] = [
  { name: 'control', glyph: '⌃', word: 'Control', accelerator: 'Control' },
  { name: 'option', glyph: '⌥', word: 'Option', accelerator: 'Alt' },
  { name: 'shift', glyph: '⇧', word: 'Shift', accelerator: 'Shift' },
  { name: 'command', glyph: '⌘', word: 'Command', accelerator: 'Command' }
]

const MODIFIER_KEYS: Record<ModifierKey, { keys: string[]; name: string }> = {
  rightCommand: { keys: ['Right ⌘'], name: 'Right Command' },
  rightOption: { keys: ['Right ⌥'], name: 'Right Option' },
  fn: { keys: ['fn'], name: 'fn' }
}

interface KeyInfo {
  /** macOS virtual key code (positional, ANSI layout). */
  code: number
  /** KeyboardEvent.code in the renderer. */
  dom: string
  label: string
  /** Electron accelerator key, for the fallback when the native helper is unavailable. */
  accelerator: string
  /** Typing keys need a modifier that does not type characters. */
  typing: boolean
}

const key = (code: number, dom: string, label: string, accelerator = label, typing = true): KeyInfo => ({ code, dom, label, accelerator, typing })
const letters: [string, number][] = [['A', 0], ['S', 1], ['D', 2], ['F', 3], ['H', 4], ['G', 5], ['Z', 6], ['X', 7], ['C', 8], ['V', 9], ['B', 11], ['Q', 12],
  ['W', 13], ['E', 14], ['R', 15], ['Y', 16], ['T', 17], ['O', 31], ['U', 32], ['I', 34], ['P', 35], ['L', 37], ['J', 38], ['K', 40], ['N', 45], ['M', 46]]
const digits: [string, number][] = [['1', 18], ['2', 19], ['3', 20], ['4', 21], ['6', 22], ['5', 23], ['9', 25], ['7', 26], ['8', 28], ['0', 29]]
const functionKeys: [number, number][] = [[1, 122], [2, 120], [3, 99], [4, 118], [5, 96], [6, 97], [7, 98], [8, 100], [9, 101], [10, 109], [11, 103],
  [12, 111], [13, 105], [14, 107], [15, 113], [16, 106], [17, 64], [18, 79], [19, 80], [20, 90]]

export const KEYS: KeyInfo[] = [
  ...letters.map(([letter, code]) => key(code, `Key${letter}`, letter)),
  ...digits.map(([digit, code]) => key(code, `Digit${digit}`, digit)),
  key(24, 'Equal', '='), key(27, 'Minus', '-'), key(30, 'BracketRight', ']'), key(33, 'BracketLeft', '['), key(39, 'Quote', '\'', '\''),
  key(41, 'Semicolon', ';'), key(42, 'Backslash', '\\'), key(43, 'Comma', ','), key(44, 'Slash', '/'), key(47, 'Period', '.'), key(50, 'Backquote', '`'),
  key(49, 'Space', 'Space'), key(48, 'Tab', 'Tab'), key(36, 'Enter', 'Return', 'Return'), key(51, 'Backspace', 'Delete', 'Backspace'),
  key(117, 'Delete', '⌦', 'Delete', false), key(115, 'Home', 'Home', 'Home', false), key(119, 'End', 'End', 'End', false),
  key(116, 'PageUp', 'Page Up', 'PageUp', false), key(121, 'PageDown', 'Page Down', 'PageDown', false),
  key(123, 'ArrowLeft', '←', 'Left', false), key(124, 'ArrowRight', '→', 'Right', false), key(125, 'ArrowDown', '↓', 'Down', false), key(126, 'ArrowUp', '↑', 'Up', false),
  ...functionKeys.map(([number, code]) => key(code, `F${number}`, `F${number}`, `F${number}`, false))
]

const byCode = new Map(KEYS.map((info) => [info.code, info]))
const byDom = new Map(KEYS.map((info) => [info.dom, info]))

export function keyForDomCode(dom: string): KeyInfo | undefined {
  return byDom.get(dom)
}

function ordered(modifiers: ShortcutModifier[]): typeof MODIFIERS {
  return MODIFIERS.filter((modifier) => modifiers.includes(modifier.name))
}

/** Keycaps for the Keys component: ['⌃', 'Space'] or ['Right ⌘']. */
export function shortcutKeys(shortcut: Shortcut): string[] {
  if (shortcut.kind === 'modifier') return MODIFIER_KEYS[shortcut.key]?.keys ?? ['?']
  return [...ordered(shortcut.modifiers).map((modifier) => modifier.glyph), byCode.get(shortcut.code)?.label ?? `Key ${shortcut.code}`]
}

/** For sentences: “Control–Space”, “Control–Option–V”, “Right Command”. */
export function shortcutName(shortcut: Shortcut): string {
  if (shortcut.kind === 'modifier') return MODIFIER_KEYS[shortcut.key]?.name ?? 'the shortcut'
  return [...ordered(shortcut.modifiers).map((modifier) => modifier.word), byCode.get(shortcut.code)?.label ?? `Key ${shortcut.code}`].join('–')
}

/** Electron accelerator, or null for single-modifier triggers, which Electron cannot express. */
export function shortcutAccelerator(shortcut: Shortcut): string | null {
  if (shortcut.kind === 'modifier') return null
  const info = byCode.get(shortcut.code)
  return info ? [...ordered(shortcut.modifiers).map((modifier) => modifier.accelerator), info.accelerator].join('+') : null
}

export function sameShortcut(a: Shortcut, b: Shortcut): boolean {
  if (a.kind === 'modifier') return b.kind === 'modifier' && a.key === b.key
  if (b.kind === 'modifier') return false
  return a.code === b.code && a.modifiers.length === b.modifiers.length && a.modifiers.every((modifier) => b.modifiers.includes(modifier))
}

/**
 * A clean shortcut from untrusted input, or a reason it cannot be used. Typing keys need Control,
 * or Command with another modifier, so letters, ⌥-accents and everyday ⌘ shortcuts keep working.
 */
export function checkShortcut(value: unknown, allowModifierKey: boolean): { shortcut: Shortcut } | { error: string } {
  if (!value || typeof value !== 'object') return { error: 'That shortcut can’t be used.' }
  const raw = value as Record<string, unknown>
  if (raw.kind === 'modifier') {
    if (!allowModifierKey) return { error: 'This shortcut needs a key with modifiers, such as ⌃⌥V.' }
    return typeof raw.key === 'string' && raw.key in MODIFIER_KEYS ? { shortcut: { kind: 'modifier', key: raw.key as ModifierKey } } : { error: 'That key can’t be used.' }
  }
  if (raw.kind !== 'chord' || typeof raw.code !== 'number' || !Array.isArray(raw.modifiers)) return { error: 'That shortcut can’t be used.' }
  const info = byCode.get(raw.code)
  if (!info) return { error: 'That key can’t be used in a shortcut.' }
  const modifiers = MODIFIERS.map((modifier) => modifier.name).filter((name) => (raw.modifiers as unknown[]).includes(name))
  const has = (name: ShortcutModifier) => modifiers.includes(name)
  if (info.typing && !has('control') && !(has('command') && modifiers.length > 1)) {
    return { error: has('command') ? 'Add Control, Option or Shift. Command with one key is taken by apps.' : 'Add Control, or Command with another modifier, so typing still works.' }
  }
  if (!info.typing && !/^F\d+$/.test(info.label) && modifiers.length === 0) return { error: 'Add a modifier such as Control or Option.' }
  return { shortcut: { kind: 'chord', code: info.code, modifiers } }
}

/** Fill gaps in stored shortcuts (older settings files have none). */
export function normalizeShortcuts(value: unknown): Shortcuts {
  const stored = value && typeof value === 'object' ? value as Partial<Record<ShortcutAction, unknown>> : {}
  const result = { ...DEFAULT_SHORTCUTS }
  for (const action of Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]) {
    const checked = checkShortcut(stored[action], action === 'dictate')
    if ('shortcut' in checked) result[action] = checked.shortcut
  }
  return result
}
