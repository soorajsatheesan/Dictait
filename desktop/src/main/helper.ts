import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { paths } from './paths'

export interface FocusInfo {
  app: string
  appName: string
  editable: boolean | null
  before: string
  selected: string
  secure?: boolean
  /** The focused window's title, which tells a browser's Gmail from its ChatGPT. Never saved. */
  window: string
}

/**
 * Where pasted text went: where the dictation started, or why it could not go there.
 * 'waiting': that place is not on screen (another conversation, a closed window), so the helper
 * pastes it when the user goes back. 'moved': no text box was known, and the user left the window.
 */
export type Delivery = 'pasted' | 'waiting' | 'moved' | 'no-target' | 'gone' | 'no-anchor' | 'untrusted' | 'failed'
/** Replacing the last insertion: done, edited since (so left alone), or no longer there. */
export type Replacement = 'replaced' | 'changed' | 'gone' | 'untrusted' | 'failed'

export interface InputDevice {
  name: string
  transport: 'builtin' | 'bluetooth' | 'usb' | 'virtual' | 'other'
  default: boolean
}

export interface HotKeySpec {
  name: string
  /** macOS virtual key code, e.g. 49 for Space. */
  code: number
  modifiers: ('control' | 'option' | 'shift' | 'command')[]
}

/**
 * The persistent native companion (native/helper.swift): shortcuts with press and release,
 * the focused text field, ⌘V, and microphones. Restarts itself if it ever exits.
 */
export class NativeHelper extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private next = 1
  private pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; timer: NodeJS.Timeout }>()
  private hotkeys: HotKeySpec[] = []
  private stopped = false
  private restarts = 0

  start(): void {
    if (this.child || this.stopped) return
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(paths.helper, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'] }) as unknown as ChildProcessWithoutNullStreams
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
    if (this.hotkeys.length) void this.registerHotkeys(this.hotkeys)
  }

  private exited(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return
    this.child = null
    for (const [, waiter] of this.pending) { clearTimeout(waiter.timer); waiter.resolve({}) }
    this.pending.clear()
    if (this.stopped || this.restarts > 20) return
    this.restarts++
    setTimeout(() => this.start(), Math.min(5000, 300 * this.restarts)).unref()
  }

  private receive(message: Record<string, unknown>): void {
    if (message.event === 'hotkey') {
      this.emit('hotkey', String(message.name), message.state === 'down')
      return
    }
    if (message.event === 'delivered') {
      this.emit('delivered', String(message.text ?? ''), message.outcome === 'pasted')
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

  /** With `anchor`, the helper remembers this text field as where the coming dictation goes. */
  async focus(anchor = false): Promise<FocusInfo | null> {
    const reply = await this.request('focus', { anchor }, 800)
    if (!('app' in reply)) return null
    return {
      app: String(reply.app ?? ''), appName: String(reply.appName ?? ''),
      editable: typeof reply.editable === 'boolean' ? reply.editable : null,
      before: String(reply.before ?? ''), selected: String(reply.selected ?? ''), secure: Boolean(reply.secure),
      window: String(reply.window ?? '')
    }
  }

  forget(): void {
    void this.request('forget')
  }

  /**
   * Pastes the text where the dictation started, going back there if focus has moved. A slow
   * or missing reply is 'failed', never a paste wherever the cursor happens to be.
   */
  async deliver(text: string): Promise<Delivery> {
    const outcome = (await this.request('deliver', { text }, 10000)).outcome
    return typeof outcome === 'string' ? outcome as Delivery : 'failed'
  }

  /** Swaps Dictait's last insertion, still reading `expected`, for the clipboard. */
  async replaceLast(expected: string, text: string): Promise<Replacement> {
    const outcome = (await this.request('replace-last', { expected, text }, 8000)).outcome
    return typeof outcome === 'string' ? outcome as Replacement : 'gone'
  }

  async paste(): Promise<boolean> {
    return (await this.request('paste', {}, 2000)).ok === true
  }

  async inputs(): Promise<InputDevice[]> {
    const reply = await this.request('inputs', {}, 1500)
    return Array.isArray(reply.devices) ? (reply.devices as InputDevice[]) : []
  }

  stop(): void {
    this.stopped = true
    this.child?.stdin.end()
    this.child?.kill()
    this.child = null
  }
}
