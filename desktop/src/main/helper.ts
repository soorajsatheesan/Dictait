import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { paths, SUPPORT } from './paths'
import type { ModifierKey } from '@shared/shortcuts'
import type { Destination } from '@shared/types'

export interface FocusInfo {
  app: string
  appName: string
  editable: boolean | null
  before: string
  selected: string
  secure?: boolean
  /** The focused window's title, which tells a browser's Gmail from its ChatGPT. Never saved. */
  window: string
  /** Browser page URL when inside an AXWebArea, for URL-aware Power Modes. Never saved. */
  url?: string
  /** Active file/project path from AXDocument when inside an IDE/editor. Never saved. */
  document?: string
}

/** Delivery into the field that has focus when the text is ready. */
export type Delivery = 'pasted' | 'no-target' | 'untrusted' | 'failed'
/** Replacing the last insertion: done, edited since (so left alone), or no longer there. */
export type Replacement = 'replaced' | 'changed' | 'gone' | 'untrusted' | 'failed'

export interface InputDevice {
  name: string
  transport: 'builtin' | 'bluetooth' | 'usb' | 'virtual' | 'other'
  default: boolean
}

export type HotKeySpec = {
  name: string
  /** macOS virtual key code, e.g. 49 for Space. */
  code: number
  modifiers: ('control' | 'option' | 'shift' | 'command')[]
} | {
  name: string
  /** A modifier used on its own; the helper reports it like a chord's press and release. */
  modifierKey: ModifierKey
  holdMs: number
}

/** How to undo a media change: returned by the helper and sent back unchanged. */
export type MediaHold = Record<string, unknown>

/**
 * The persistent native companion (native/helper.swift): shortcuts with press and release,
 * the focused text field, ⌘V, and microphones. Restarts itself if it ever exits.
 */
export class NativeHelper extends EventEmitter {
  lastDeliveryDestination: Destination | null = null
  private child: ChildProcessWithoutNullStreams | null = null
  private log: number | null = null
  private next = 1
  private pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; timer: NodeJS.Timeout }>()
  private hotkeys: HotKeySpec[] = []
  private stopped = false
  private restarts = 0

  start(): void {
    if (this.child || this.stopped) return
    let child: ChildProcessWithoutNullStreams
    try {
      let stderr: number | 'ignore' = 'ignore'
      try {
        mkdirSync(SUPPORT, { recursive: true })
        const logPath = join(SUPPORT, 'helper.log')
        try { if (statSync(logPath).size > 512_000) unlinkSync(logPath) } catch { /* no log yet */ }
        if (this.log !== null) { try { closeSync(this.log) } catch { /* ignore */ } }
        this.log = openSync(logPath, 'a')
        stderr = this.log
      } catch { stderr = 'ignore' }
      child = spawn(paths.helper, ['serve'], { stdio: ['pipe', 'pipe', stderr] }) as unknown as ChildProcessWithoutNullStreams
    } catch {
      return
    }
    this.child = child
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        try { this.receive(JSON.parse(line)) } catch { /* not protocol output */ }
      }
    })
    child.on('error', () => this.exited(child))
    child.on('exit', () => this.exited(child))
    if (this.hotkeys.length) void this.registerHotkeys(this.hotkeys).then((registered) => this.emit('hotkeys-registered', registered))
  }

  private exited(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return
    this.child = null
    for (const [, waiter] of this.pending) { clearTimeout(waiter.timer); waiter.resolve({}) }
    this.pending.clear()
    this.emit('disconnected')
    if (this.stopped || this.restarts > 20) return
    this.restarts++
    setTimeout(() => this.start(), Math.min(5000, 300 * this.restarts)).unref()
  }

  private receive(message: Record<string, unknown>): void {
    if (message.event === 'hotkey') {
      // A lone modifier that turned out to be part of a shortcut such as ⌘C.
      if (message.state === 'cancel') { this.emit('hotkey-cancel', String(message.name)); return }
      this.emit('hotkey', String(message.name), message.state === 'down', parseFocus(message.focus),
        typeof message.at === 'number' ? message.at : Date.now())
      return
    }
    const waiter = this.pending.get(Number(message.id))
    if (!waiter) return
    this.pending.delete(Number(message.id))
    clearTimeout(waiter.timer)
    waiter.resolve(message)
  }

  /** Resolves with the reply, or an empty object if the helper is unavailable or slow. */
  request(cmd: string, extra: Record<string, unknown> = {}, timeout = 1000): Promise<Record<string, unknown>> {
    this.start()
    const child = this.child
    if (!child || !child.stdin.writable) return Promise.resolve({})
    const id = this.next++
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({}) }, timeout)
      this.pending.set(id, { resolve, timer })
      child.stdin.write(JSON.stringify({ id, cmd, ...extra }) + '\n')
    })
  }

  async registerHotkeys(keys: HotKeySpec[]): Promise<Record<string, boolean>> {
    this.hotkeys = keys
    const reply = await this.request('hotkeys', { keys }, 2000)
    return (reply.registered as Record<string, boolean>) ?? {}
  }

  /** Context for recognition and voice edits; it does not set a delivery destination. */
  async focus(): Promise<FocusInfo | null> {
    return parseFocus(await this.request('focus', {}, 2500))
  }

  /** Inserts into the current focus without activating apps or restoring an earlier cursor. */
  async deliver(text: string): Promise<Delivery> {
    const reply = await this.request('deliver', { text }, 4000)
    this.lastDeliveryDestination = parseDestination(reply.destination)
    const outcome = reply.outcome
    return typeof outcome === 'string' ? outcome as Delivery : 'failed'
  }

  async activeWindow(): Promise<{ bounds: { x: number; y: number; width: number; height: number } | null; destination: Destination | null }> {
    const reply = await this.request('active-window')
    const bounds = reply.bounds as Record<string, number> | undefined
    return {
      bounds: bounds && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key]))
        ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null,
      destination: parseDestination(reply.destination)
    }
  }

  /** Swaps Dictait's last insertion, still reading `expected`, for the clipboard. */
  async replaceLast(expected: string, text: string): Promise<Replacement> {
    const reply = await this.request('replace-last', { expected, text }, 8000)
    this.lastDeliveryDestination = parseDestination(reply.destination)
    const outcome = reply.outcome
    return typeof outcome === 'string' ? outcome as Replacement : 'gone'
  }

  async inputs(): Promise<InputDevice[]> {
    const reply = await this.request('inputs', {}, 1500)
    return Array.isArray(reply.devices) ? (reply.devices as InputDevice[]) : []
  }

  /** Lowers the volume or pauses media; resolves with how to undo it, or null if nothing changed. */
  async media(action: 'duck' | 'pause'): Promise<MediaHold | null> {
    const reply = await this.request('media', { action }, action === 'pause' ? 4000 : 2000)
    return reply.ok === true && reply.hold && typeof reply.hold === 'object' ? reply.hold as MediaHold : null
  }

  async releaseMedia(hold: MediaHold): Promise<boolean> {
    return (await this.request('media', hold, 3000)).ok === true
  }

  /** While quitting, when the serving helper is about to stop. */
  releaseMediaNow(hold: MediaHold): void {
    try { execFileSync(paths.helper, ['media', JSON.stringify(hold)], { timeout: 3000, stdio: 'ignore' }) } catch { /* best effort */ }
  }

  stop(): void {
    this.stopped = true
    this.child?.stdin.end()
    this.child?.kill()
    this.child = null
  }
}

function parseDestination(value: unknown): Destination | null {
  if (!value || typeof value !== 'object') return null
  const info = value as Record<string, unknown>
  if (typeof info.appName !== 'string' || !info.appName) return null
  return { app: String(info.app ?? ''), appName: info.appName, icon: typeof info.icon === 'string' ? info.icon : '',
    editable: typeof info.editable === 'boolean' ? info.editable : null }
}

function parseFocus(value: unknown): FocusInfo | null {
  if (!value || typeof value !== 'object' || !('app' in value)) return null
  const reply = value as Record<string, unknown>
  return {
    app: String(reply.app ?? ''), appName: String(reply.appName ?? ''),
    editable: typeof reply.editable === 'boolean' ? reply.editable : null,
    before: String(reply.before ?? ''), selected: String(reply.selected ?? ''), secure: Boolean(reply.secure),
    window: String(reply.window ?? '')
  }
}
