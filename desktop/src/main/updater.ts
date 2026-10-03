import { app, net } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, createWriteStream, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { UpdateStatus } from '@shared/types'

const run = promisify(execFile)

/** Where releases are published. Each release carries the Mac disk image and SHA256SUMS.txt. */
export const REPOSITORY = 'soorajsatheesan/Dictait'
const LATEST = `https://api.github.com/repos/${REPOSITORY}/releases/latest`
const HOURS = 3_600_000

interface Release { version: string; notes: string; dmg: string; name: string; size: number; sums: string | null }

/** True when version a is newer than b ("0.10.0" > "0.9.3"). */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  const x = parse(a), y = parse(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return false
}

/** The running app's bundle: …/Dictait.app/Contents/MacOS/Dictait → …/Dictait.app */
export function appBundle(): string {
  return dirname(dirname(dirname(process.execPath)))
}

/**
 * Updates from GitHub Releases. Checks quietly after launch and every few hours; downloads the new
 * disk image only when asked, verifies it against the release's checksums, stages the new app beside
 * the old one, and swaps them once Dictait has quit. Settings, notes, models and macOS permissions
 * are untouched: they live outside the app, and the new build keeps the same code identity.
 */
export class Updater {
  private release: Release | null = null
  private busy = false

  constructor(private report: (patch: Partial<UpdateStatus>) => void, private enabled: () => boolean) {}

  start(): void {
    setTimeout(() => void this.check(true), 15_000).unref()
    setInterval(() => void this.check(true), 6 * HOURS).unref()
  }

  async check(quiet = false): Promise<void> {
    if (this.busy || (quiet && !this.enabled())) return
    if (!quiet) this.report({ phase: 'checking', error: '' })
    try {
      const response = await net.fetch(LATEST, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Dictait/${app.getVersion()}` } })
      if (response.status === 404) { this.report({ phase: 'current', checkedAt: Date.now(), version: '' }); return }
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
      const json = await response.json() as { tag_name?: string; body?: string; assets?: { name: string; browser_download_url: string; size: number }[] }
      const version = String(json.tag_name ?? '').replace(/^v/, '')
      const dmg = json.assets?.find((asset) => /-mac-arm64\.dmg$/.test(asset.name))
      const sums = json.assets?.find((asset) => asset.name === 'SHA256SUMS.txt')
      if (!version || !dmg || !isNewer(version, app.getVersion())) {
        this.release = null
        this.report({ phase: 'current', checkedAt: Date.now(), version: '' })
        return
      }
      this.release = { version, notes: String(json.body ?? '').slice(0, 4000), dmg: dmg.browser_download_url, name: dmg.name, size: dmg.size, sums: sums?.browser_download_url ?? null }
      this.report({ phase: 'available', version, notes: this.release.notes, checkedAt: Date.now(), error: '' })
    } catch (error) {
      // A quiet check that fails (offline, rate-limited) stays quiet.
      if (!quiet) this.report({ phase: 'failed', error: `Couldn’t check for updates: ${(error as Error).message}` })
    }
  }

  async install(): Promise<void> {
    const release = this.release
    if (!release || this.busy) return
    if (!app.isPackaged) { this.report({ phase: 'failed', error: 'Updates install into the packaged app, not a development build.' }); return }
    const bundle = appBundle()
    try { accessSync(dirname(bundle), constants.W_OK) } catch {
      this.report({ phase: 'failed', error: `Dictait can’t write to ${dirname(bundle)}. Download it from the website instead.` })
      return
    }
    this.busy = true
    const work = mkdtempSync(join(tmpdir(), 'dictait-update-'))
    const image = join(work, release.name)
    const volume = join(work, 'volume')
    const staged = join(dirname(bundle), '.Dictait-update.app')
    try {
      this.report({ phase: 'downloading', progress: 0, error: '' })
      const digest = await this.download(release.dmg, image, release.size)
      if (release.sums) {
        const sums = await (await net.fetch(release.sums)).text()
        const expected = sums.split('\n').find((line) => line.trim().endsWith(release.name))?.split(/\s+/)[0]
        if (!expected || expected !== digest) throw new Error('the download doesn’t match its published checksum')
      }
      this.report({ phase: 'installing', progress: 1 })
      await run('/usr/bin/hdiutil', ['attach', image, '-nobrowse', '-readonly', '-mountpoint', volume, '-quiet'])
      try {
        rmSync(staged, { recursive: true, force: true })
        await run('/usr/bin/ditto', [join(volume, 'Dictait.app'), staged])
      } finally {
        await run('/usr/bin/hdiutil', ['detach', volume, '-quiet']).catch(() => {})
      }
      await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', staged]).catch(() => {})
      // Swap once this process has exited, then reopen. If the swap fails, the old app is put back.
      const script = [
        `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done`,
        `old="${bundle}.previous"`,
        `rm -rf "$old"`,
        `if mv "${bundle}" "$old" && mv "${staged}" "${bundle}"; then rm -rf "$old"; else [ -d "$old" ] && mv "$old" "${bundle}"; fi`,
        `rm -rf "${work}"`,
        `open "${bundle}"`
      ].join('\n')
      spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' }).unref()
      app.quit()
    } catch (error) {
      rmSync(staged, { recursive: true, force: true })
      rmSync(work, { recursive: true, force: true })
      this.busy = false
      this.report({ phase: 'failed', error: `The update didn’t install: ${(error as Error).message}. Your current version is unchanged.` })
    }
  }

  /** Streams the file to disk, reporting progress, and returns its SHA-256. */
  private async download(url: string, path: string, size: number): Promise<string> {
    const response = await net.fetch(url)
    if (!response.ok || !response.body) throw new Error(`the download failed (${response.status})`)
    const hash = createHash('sha256')
    const file = createWriteStream(path)
    const total = Number(response.headers.get('content-length')) || size || 1
    let received = 0, reported = 0
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      if (!file.write(value)) await new Promise<void>((resolve) => file.once('drain', () => resolve()))
      received += value.byteLength
      if (received - reported > total / 100) { reported = received; this.report({ progress: Math.min(1, received / total) }) }
    }
    await new Promise<void>((resolve, reject) => file.end((error?: Error | null) => (error ? reject(error) : resolve())))
    return hash.digest('hex')
  }
}

