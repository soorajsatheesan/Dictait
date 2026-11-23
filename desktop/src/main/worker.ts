import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { paths, SUPPORT } from './paths'

export type WorkerEvent = Record<string, unknown> & { event?: string }

/** Persistent local MLX worker speaking JSON lines over pipes. No network port. */
export class ModelWorker {
  onEvent: (event: WorkerEvent) => void = () => {}
  private process: ChildProcessWithoutNullStreams | null = null
  private exiting: Promise<void> = Promise.resolve()
  private log: number | null = null
  private generation = 0

  start(backend: string, cleanup: boolean): void {
    try { accessSync(paths.python, constants.X_OK) } catch {
      throw new Error('The speech engine is missing. Reinstall Dictait, or run install-macos.sh from the source.')
    }
    if (!existsSync(paths.worker)) throw new Error('The model worker is missing. Reinstall Dictait.')
    const token = ++this.generation
    const prior = this.stop()
    const launch = () => {
      if (token !== this.generation) return
      this.spawnWorker(backend, cleanup, token)
    }
    if (prior) void prior.then(launch)
    else launch()
  }

  private spawnWorker(backend: string, cleanup: boolean, token: number): void {
    mkdirSync(SUPPORT, { recursive: true })
    const logPath = join(SUPPORT, 'worker.log')
    // Bound logs across launches; audio and transcripts are never written here.
    try { if (statSync(logPath).size > 1_000_000) unlinkSync(logPath) } catch { /* no log yet */ }
    this.log = openSync(logPath, 'a')
    const child = spawn(paths.python, ['-B', '-u', paths.worker, '--backend', backend, ...(cleanup ? [] : ['--no-cleanup'])], {
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', TOKENIZERS_PARALLELISM: 'false', HF_HUB_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' },
      stdio: ['pipe', 'pipe', this.log]
    }) as unknown as ChildProcessWithoutNullStreams
    if (token !== this.generation) {
      child.stdin.end()
      child.kill('SIGTERM')
      return
    }
    this.process = child
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        try {
          const event = JSON.parse(line)
          if (this.process === child) this.onEvent(event)
        } catch { /* non-protocol output */ }
      }
    })
    child.on('exit', () => {
      if (this.process !== child) return
      this.process = null
      this.onEvent({ event: 'error', message: 'The model worker stopped. Click Retry to reload models.' })
    })
    child.on('error', (error) => {
      if (this.process !== child) return
      this.process = null
      this.onEvent({ event: 'error', message: `Could not start the model worker: ${error.message}` })
    })
  }

  send(request: Record<string, unknown>): void {
    const child = this.process
    if (!child || child.exitCode !== null || !child.stdin.writable) throw new Error('The model worker is unavailable. Click Retry.')
    child.stdin.write(JSON.stringify(request) + '\n')
  }

  stop(): Promise<void> | null {
    this.generation++
    const old = this.process
    this.process = null // Suppress intentional termination callbacks.
    if (this.log !== null) { try { closeSync(this.log) } catch { /* already closed */ } this.log = null }
    if (old && old.exitCode === null) {
      const done = new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(killer); resolve() }
        old.once('exit', finish)
        old.once('error', finish)
        // Ensure the old MLX process releases unified memory before a replacement starts.
        const killer = setTimeout(() => {
          if (old.exitCode === null) old.kill('SIGKILL')
          resolve()
        }, 2000)
        killer.unref()
      })
      old.stdin.end()
      old.kill('SIGTERM')
      this.exiting = done
      return done
    }
    return this.exiting
  }
}
