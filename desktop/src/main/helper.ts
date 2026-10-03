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
}

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

  async focus(): Promise<FocusInfo | null> {
    const reply = await this.request('focus', {}, 800)
    if (!('app' in reply)) return null
    return {
      app: String(reply.app ?? ''), appName: String(reply.appName ?? ''),
      editable: typeof reply.editable === 'boolean' ? reply.editable : null,
      before: String(reply.before ?? ''), selected: String(reply.selected ?? ''), secure: Boolean(reply.secure)
    }
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
