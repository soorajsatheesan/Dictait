const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const path = require('node:path')
const code = buildSync({ entryPoints: [path.join(__dirname, '../src/main/hud.ts')], bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['electron'], alias: { '@shared': path.join(__dirname, '../src/shared') } }).outputFiles[0].text

function fixture(t) {
  const ipcMain = new EventEmitter(), model = new EventEmitter(), timers = new Map(), sent = []
  let now = 10_000, next = 0
  const display = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { y: 24 } }
  const window = {
    webContents: { send: (...args) => sent.push(args) }, getBounds: () => ({ x: 0, y: 0 }), setBounds() {}, setAlwaysOnTop() {},
    setVisibleOnAllWorkspaces() {}, showInactive() {}, moveTop() {}, isDestroyed: () => false, isVisible: () => true, hide() {}, destroy() {}
  }
  model.state = { phase: 'recording', message: '', microphoneAllowed: true, recordingStartedAt: now }
  model.live = { live: '', note: '', holding: false, holdStartedAt: null, editing: false, destination: null, deliveredTo: null, microphone: '', micQuiet: false }
  model.helper = { activeWindow: async () => ({ bounds: null, destination: null }) }
  model.setDestination = () => {}
  model.setMicrophoneDevice = (device) => { model.live.microphone = device }
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports, Buffer, process,
    Date: class extends Date { static now() { return now } },
    setTimeout: (fn, delay) => { const id = ++next; timers.set(id, { fn, at: now + delay }); return id }, clearTimeout: (id) => timers.delete(id),
    setInterval: () => 9999, clearInterval() {},
    require: (name) => {
      if (name === 'electron') return { ipcMain, app: { isPackaged: false, getAppPath: () => __dirname },
        screen: { on() {}, getCursorScreenPoint: () => ({}), getDisplayNearestPoint: () => display, getDisplayMatching: () => display } }
      if (name === 'node:child_process') return { execFile: (_file, _args, _options, callback) => callback(null, '[]') }
      return require(name)
    }
  })
  const hud = new module.exports.RecordingHUD(model, '', undefined, '')
  hud.window = window; hud.ready = Promise.resolve()
  const advance = (ms) => { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn() } }
  t.after(() => { hud.destroy(); timers.clear() })
  return { hud, model, sent, ipcMain, window, advance, flush: async () => { for (let i = 0; i < 8; i++) await Promise.resolve() } }
}

test('fast results skip processing flashes and cannot reveal a stale spinner later', async (t) => {
  const f = fixture(t)
  f.hud.update()
  f.model.state.phase = 'transcribing'; f.hud.update()
  f.advance(60)
  f.model.state.phase = 'cleaning'; f.hud.update()
  f.advance(60)
  f.model.state.phase = 'ready'; f.model.state.message = 'Pasted.'; f.hud.update()
  f.advance(500)
  await f.flush()
  assert.equal(f.sent.filter(([channel, value]) => channel === 'hud' && value.kind === 'transcribing').length, 0)
  assert.equal(f.sent.filter(([channel, value]) => channel === 'hud').at(-1)[1].kind, 'done')
})

test('processing keeps one presentation across stages and explains a longer wait', (t) => {
  const f = fixture(t)
  f.model.state.phase = 'transcribing'; f.hud.update()
  f.advance(180)
  assert.equal(f.hud.content().kind, 'transcribing')
  f.advance(1200)
  f.model.state.phase = 'cleaning'; f.hud.update()
  assert.equal(f.hud.content().kind, 'transcribing')
  assert.match(f.hud.content().title, /Polishing/)
  f.advance(8000)
  assert.match(f.hud.content().detail, /Still working on this Mac/)
  assert.doesNotMatch(f.hud.content().detail, /%/)
})

test('copied-text recovery remains visible for 6.5 seconds and names both paste shortcuts', (t) => {
  const f = fixture(t)
  f.hud.update()
  f.model.state.phase = 'ready'; f.model.state.message = 'Copied. No text box is focused.'; f.hud.update()
  assert.match(f.hud.content().detail, /⌘V/)
  assert.match(f.hud.content().detail, /⌃⌥V/)
  f.advance(6499)
  assert.equal(f.hud.isVisible, true)
  f.advance(1)
  assert.equal(f.hud.isVisible, false)
})

test('the island names the shortcuts the user chose', (t) => {
  const f = fixture(t)
  f.model.stored = { shortcuts: {
    dictate: { kind: 'modifier', key: 'rightOption' },
    pasteLast: { kind: 'chord', code: 9, modifiers: ['shift', 'command'] },
    learnCorrection: { kind: 'chord', code: 37, modifiers: ['control', 'option'] }
  } }
  f.hud.update()
  assert.equal(f.sent.filter(([channel]) => channel === 'hud').at(-1)[1].shortcut, 'Right ⌥')
  f.model.state.phase = 'ready'; f.model.state.message = 'Copied. No text box is focused.'; f.hud.update()
  assert.match(f.hud.content().detail, /⇧⌘V repeats/)
})

test('success names only the verified receiving app and freezes that identity', (t) => {
  const f = fixture(t)
  f.model.state.phase = 'ready'; f.model.state.message = 'Pasted.'
  f.model.live.destination = { appName: 'T3 Code' }
  assert.equal(f.hud.content().title, 'Paste sent')
  f.model.live.deliveredTo = { appName: 'Raycast' }
  assert.equal(f.hud.content().title, 'Pasted into Raycast')
  f.model.live.destination = { appName: 'Finder' }
  assert.equal(f.hud.content().title, 'Pasted into Raycast')
})

test('late microphone-test replies cannot settle a new recording request', async (t) => {
  const f = fixture(t)
  const first = f.hud.start({ monitor: true }).catch((error) => error.message)
  await f.flush()
  const firstID = f.sent.filter(([channel]) => channel === 'recorder').at(-1)[2].requestId
  f.hud.cancel()
  assert.equal(await first, 'Cancelled.')
  let started = false
  const second = f.hud.start({}).then(() => { started = true })
  await f.flush()
  const secondID = f.sent.filter(([channel, command]) => channel === 'recorder' && command === 'start').at(-1)[2].requestId
  f.ipcMain.emit('recorder:failed', { sender: f.window.webContents }, 'Cancelled.', firstID)
  await f.flush()
  assert.equal(started, false)
  f.ipcMain.emit('recorder:started', { sender: f.window.webContents }, 'Built-in microphone', secondID)
  await second
  assert.equal(started, true)
  assert.equal(f.model.live.microphone, 'Built-in microphone')
})

test('followFocus rounds fractional bounds, handles errors safely, and matches vertically stacked displays by y', async (t) => {
  const f = fixture(t)
  let matchedRect = null
  const topDisplay = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { y: 38 }, internal: true }
  const bottomDisplay = { bounds: { x: 0, y: 900, width: 1440, height: 900 }, workArea: { y: 924 }, internal: false }
  f.hud.screens = [
    { x: 0, y: 0, width: 1440, height: 900, notchWidth: 180, notchHeight: 38, menuBarHeight: 38 },
    { x: 0, y: 900, width: 1440, height: 900, notchWidth: 0, notchHeight: 0, menuBarHeight: 24 }
  ]
  assert.equal(f.hud.describe(topDisplay).hasNotch, true)
  assert.equal(f.hud.describe(bottomDisplay).hasNotch, false)

  f.model.helper.activeWindow = async () => ({ bounds: { x: 10.6, y: 20.4, width: 800.7, height: 600.2 }, destination: { app: 'a', appName: 'App', icon: '', editable: true } })
  const origPlace = f.hud.place.bind(f.hud)
  f.hud.place = (d) => { matchedRect = d; origPlace(d) }
  f.hud.update()
  await f.flush()
  assert.ok(matchedRect)

  // Helper failures inside followFocus must never leak unhandled rejections or wedge positioning.
  f.model.helper.activeWindow = async () => { throw new Error('helper busy') }
  await f.hud.followFocus()
  assert.equal(f.hud.positioning, false)
})

test('show detaches a stale visible window and cycles all-workspaces behavior across Spaces', async (t) => {
  const f = fixture(t)
  const calls = []
  f.window.hide = () => calls.push('hide')
  f.window.setVisibleOnAllWorkspaces = (v) => calls.push(`ws:${v}`)
  f.window.showInactive = () => calls.push('showInactive')
  f.window.moveTop = () => calls.push('moveTop')
  f.hud.update()
  assert.deepEqual(calls.slice(0, 4), ['hide', 'ws:false', 'ws:true', 'showInactive'])
  assert.equal(calls.includes('moveTop'), false)
})

test('destroy removes IPC listeners and rejects pending recorder requests', async (t) => {
  const f = fixture(t)
  const before = f.ipcMain.listenerCount('hud:ready')
  assert.equal(before, 1)
  const pending = f.hud.start({}).catch((err) => err.message)
  await f.flush()
  f.hud.destroy()
  assert.equal(await pending, 'Destroyed.')
  assert.equal(f.ipcMain.listenerCount('hud:ready'), 0)
})
