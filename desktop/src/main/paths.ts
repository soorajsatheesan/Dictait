import { app, shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Shared with the Python worker and dictait-memory.sh; contains personal data. */
export const SUPPORT = join(homedir(), 'Library', 'Application Support', 'Dictait')
export const NOTES = join(SUPPORT, 'Notes')

function resource(...parts: string[]): string {
  return app.isPackaged ? join(process.resourcesPath, ...parts) : join(app.getAppPath(), ...parts)
}

export const paths = {
  /** The Python bundled into downloadable builds, or the runtime install-macos.sh creates. */
  get python() {
    const bundled = resource('python', 'bin', 'python3')
    return app.isPackaged && existsSync(bundled) ? bundled : join(SUPPORT, 'runtime', 'bin', 'python')
  },
  get worker() {
    return app.isPackaged ? join(process.resourcesPath, 'backend', 'worker.py') : join(app.getAppPath(), '..', 'macos', 'backend', 'worker.py')
  },
  get helper() { return app.isPackaged ? resource('bin', 'dictait-helper') : resource('build', 'bin', 'dictait-helper') },
  tray(name: string) { return app.isPackaged ? resource('tray', name) : resource('resources', 'tray', name) }
}

export function openFolder(which: 'notes' | 'memory'): void {
  const folder = which === 'notes' ? NOTES : SUPPORT
  try { mkdirSync(folder, { recursive: true }) } catch { /* openPath reports the problem */ }
  void shell.openPath(folder)
}
