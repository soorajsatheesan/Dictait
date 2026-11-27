const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const vm = require('node:vm')
const path = require('node:path')

const code = buildSync({
  entryPoints: [path.join(__dirname, '../src/main/coordinator.ts')], bundle: true,
  platform: 'node', format: 'cjs', write: false, external: ['electron'],
  alias: { '@shared': path.join(__dirname, '../src/shared') }
}).outputFiles[0].text

/** Files in memory: enough of node:fs for settings, personalization and kept recordings. */
function fakeFS(files, dirs, now, spawnWorker) {
  const missing = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  return {
    readFileSync: (file) => files.get(file) ?? '{}',
    writeFileSync: (file, value) => files.set(file, typeof value === 'string' ? value : Buffer.from(value)),
    mkdirSync: (dir) => { for (let path = dir; path && path !== '/'; path = path.slice(0, path.lastIndexOf('/'))) dirs.add(path) },
    readdirSync: (dir) => {
      const names = new Set([...files.keys(), ...dirs].filter((path) => path.startsWith(dir + '/')).map((path) => path.slice(dir.length + 1).split('/')[0]))
      if (!names.size && !dirs.has(dir)) throw missing(dir)
      return [...names]
    },
    rmSync: (target) => {
      for (const path of [...files.keys()]) if (path === target || path.startsWith(target + '/')) files.delete(path)
      for (const path of [...dirs]) if (path === target || path.startsWith(target + '/')) dirs.delete(path)
    },
    unlinkSync: (file) => { if (!files.delete(file)) throw missing(file) },
    statSync: (file) => { if (!files.has(file)) throw missing(file); return { size: files.get(file).length, mtimeMs: now() } },
    chmodSync() {},
    renameSync: (from, to) => { if (!files.has(from)) throw missing(from); files.set(to, files.get(from)); files.delete(from) },
    constants: { X_OK: 1 }, accessSync() {}, existsSync: (file) => Boolean(spawnWorker && file.endsWith('/worker.py')),
    openSync: () => 1, closeSync() {}
  }
}

function fixture(t, spawnWorker) {
  const timers = new Map()
  const files = new Map(), dirs = new Set(), sounds = []
  let now = 10_000, nextTimer = 0, pasteCount = 0, clipboardText = ''
  const electron = {
    app: { getVersion: () => 'test', getLoginItemSettings: () => ({}), getAppPath: () => path.join(__dirname, '..'), isPackaged: false },
    clipboard: { writeText(text) { clipboardText = text }, readText: () => clipboardText }, shell: { beep() {} },
    systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: () => true },
    globalShortcut: { register: () => true, isRegistered: () => false, unregister() {} }
  }
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports, process, Buffer, console,
    Date: class extends Date { static now() { return now } },
    setTimeout: (fn, delay) => { const timer = { unref() {} }; timers.set(timer, { fn, at: now + delay }); return timer },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, interval) => { const id = ++nextTimer; timers.set(id, { fn, at: now + interval, interval }); return id },
    clearInterval: (id) => timers.delete(id),
    require: (name) => {
      if (name === 'electron') return electron
      if (name === 'node:fs') return fakeFS(files, dirs, () => now, spawnWorker)
      if (name === 'node:child_process') return { spawn: (...args) => {
        if (spawnWorker && args[0].endsWith('/bin/python')) return spawnWorker(...args)
        sounds.push(args)
        return { on() {}, unref() {} }
      } }
      return require(name)
    }
  })
  const model = new module.exports.Coordinator()
  model.state.phase = 'ready'
  model.helper.inputs = async () => []
  model.helper.focus = async () => ({ app: 'test', appName: 'Test', editable: true, before: '', selected: '', window: '' })
  model.helper.deliver = async () => { pasteCount++; return 'pasted' }
  model.helper.replaceLast = async () => 'gone'
  model.worker.send = () => {}
  // Media changes in order: 'duck' | 'pause' when held, then the hold's action when released.
  const media = []
  model.helper.media = async (action) => { media.push(action); return { action: action === 'duck' ? 'restore' : 'resume', volume: 0.5 } }
  model.helper.releaseMedia = async (hold) => { media.push(hold.action); return true }
  const registrations = []
  model.helper.registerHotkeys = async (keys) => { registrations.push(keys); return Object.fromEntries(keys.map((key) => [key.name, true])) }
  let starts = 0, stops = 0
  model.recorder = { start: async () => { starts++ }, stop: async () => { stops++; return null }, cancel() {} }
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  const advance = (ms) => {
    const end = now + ms
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      const [id, timer] = due
      now = timer.at
      if (timer.interval) timer.at += timer.interval; else timers.delete(id)
      timer.fn()
    }
    now = end
  }
  t.after(() => { timers.clear() })
  return { model, flush, advance, files, sounds, electron, media, registrations, starts: () => starts, stops: () => stops, pasteCount: () => pasteCount }
}

test('initial warm-up starts the worker and rapid retries launch only the latest configuration', async (t) => {
  const children = []
  const f = fixture(t, (_python, args) => {
    const child = Object.assign(new EventEmitter(), {
      args, stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null,
      kill(signal) { this.signal = signal }
    })
    children.push(child)
    return child
  })
  f.model.worker.onEvent = (event) => f.model.handle(event)
  f.model.reloadModels()
  await f.flush()
  assert.equal(children.length, 1)
  children[0].stdout.write('{"event":"ready","cleanup":true}\n')
  assert.equal(f.model.state.phase, 'ready')

  f.model.reloadModels()
  f.model.stored.cleanup = false
  f.model.reloadModels()
  await f.flush()
  assert.equal(children.length, 1)
  assert.equal(children[0].signal, 'SIGTERM')
  children[0].exitCode = 0
  children[0].emit('exit')
  await f.flush()
  assert.equal(children.length, 2)
  assert.equal(children[1].args.at(-1), '--no-cleanup')
  assert.equal(f.model.state.phase, 'preparing')
  children[1].stdout.write('{"event":"ready","cleanup":false}\n')
  assert.equal(f.model.state.phase, 'ready')
})

test('an ordinary 600 ms press stays recording on release; the next tap stops', async (t) => {
  const f = fixture(t)
  f.model.hotkey('dictate', true)
  await f.flush()
  f.advance(600)
  f.model.hotkey('dictate', false)
  assert.equal(f.model.state.phase, 'recording')
  assert.equal(f.model.live.holding, false)
  assert.equal(f.model.live.holdStartedAt, null)
  f.model.hotkey('dictate', true)
  f.model.hotkey('dictate', false)
  await f.flush()
  assert.equal(f.starts(), 1)
  assert.equal(f.stops(), 1)
})

test('hold progress changes to release-to-finish only after 1.2 seconds', async (t) => {
  const f = fixture(t)
  f.model.hotkey('dictate', true)
  await f.flush()
  assert.equal(f.model.live.holdStartedAt, 10_000)
  f.advance(1199)
  assert.equal(f.model.live.holding, false)
  f.advance(1)
  assert.equal(f.model.live.holding, true)
  f.model.hotkey('dictate', false)
  await f.flush()
  assert.equal(f.stops(), 1)
  assert.equal(f.model.live.holdStartedAt, null)
})

test('auto-repeat cannot restart the hold timer or stop a latched recording', async (t) => {
  const f = fixture(t)
  f.model.hotkey('dictate', true)
  await f.flush()
  f.advance(600)
  f.model.hotkey('dictate', true)
  assert.equal(f.starts(), 1)
  assert.equal(f.stops(), 0)
  assert.equal(f.model.live.holdStartedAt, 10_000)
  f.model.hotkey('dictate', false)
  assert.equal(f.model.state.phase, 'recording')
})

test('recording context survives a stop shortcut focused elsewhere', async (t) => {
  const f = fixture(t)
  const target = { app: 'original', appName: 'Test', editable: true, before: '', selected: '', window: '' }
  f.model.hotkey('dictate', true, target)
  f.model.hotkey('dictate', false)
  await f.flush()
  f.advance(600)
  f.model.hotkey('dictate', true, { ...target, app: 'other-app' })
  f.model.hotkey('dictate', false)
  await f.flush()
  assert.equal(f.model.target.app, 'original')
})

test('completed dictation is delivered to current focus without a recording destination', async (t) => {
  const f = fixture(t)
  f.model.target = { app: 'original', appName: 'Original', editable: true, selected: '', before: '', window: '' }
  f.model.helper.focus = async () => ({ app: 'current', editable: true })
  let delivered
  f.model.helper.deliver = async (...args) => { delivered = args; return 'pasted' }
  f.model.state.phase = 'transcribing'
  f.model.requestID = 'finished'
  f.model.handle({ event: 'result', id: 'finished', text: 'finished dictation' })
  await f.flush()
  assert.deepEqual(delivered, ['finished dictation'])
  assert.equal(f.model.state.phase, 'ready')
  assert.equal(f.model.lastPasted.text, 'finished dictation')
})

test('no focused text field copies once without waiting to paste when focus returns', async (t) => {
  const f = fixture(t)
  let editable = false
  f.model.helper.focus = async () => ({ editable })
  assert.equal(await f.model.deliver('test dictation'), 'no-target')
  editable = true
  f.advance(60_000)
  await f.flush()
  assert.equal(f.pasteCount(), 0)
})

test('automatic paste can still be disabled', async (t) => {
  const f = fixture(t)
  f.model.stored.autoPaste = false
  assert.equal(await f.model.deliver('test dictation'), 'copied')
  assert.equal(f.pasteCount(), 0)
})

test('a follow-up in a different field pastes there instead of restoring the original', async (t) => {
  const f = fixture(t)
  f.model.lastPasted = { text: 'original text', at: 10_000 }
  f.model.helper.replaceLast = async () => 'gone'
  await f.model.followUp('rewritten text', '')
  assert.equal(f.pasteCount(), 1)
  assert.equal(f.model.lastPasted.text, 'rewritten text')
  assert.match(f.model.state.message, /current cursor/)
})

test('a follow-up can replace unchanged text in the currently focused field', async (t) => {
  const f = fixture(t)
  f.model.lastPasted = { text: 'original text', at: 10_000 }
  f.model.helper.replaceLast = async () => 'replaced'
  await f.model.followUp('rewritten text', '')
  assert.equal(f.pasteCount(), 0)
  assert.equal(f.model.lastPasted.text, 'rewritten text')
})

test('follow-ups respect disabled automatic paste', async (t) => {
  const f = fixture(t)
  f.model.lastPasted = { text: 'original text', at: 10_000 }
  f.model.stored.autoPaste = false
  let replacements = 0
  f.model.helper.replaceLast = async () => { replacements++; return 'replaced' }
  await f.model.followUp('rewritten text', '')
  assert.equal(replacements, 0)
  assert.equal(f.pasteCount(), 0)
})

test('a quick stop waits for microphone startup, then closes it', async (t) => {
  const f = fixture(t)
  let opened
  f.model.recorder.start = () => new Promise((resolve) => { opened = resolve })
  f.model.hotkey('dictate', true)
  f.model.hotkey('dictate', false)
  await f.flush()
  f.advance(100)
  f.model.hotkey('dictate', true)
  f.model.hotkey('dictate', false)
  await f.flush()
  assert.equal(f.stops(), 0)
  opened()
  await f.flush()
  assert.equal(f.stops(), 1)
  assert.equal(f.model.state.phase, 'ready')
})

test('quiet-input warning waits six seconds, clears on speech, and never stops a pause', async (t) => {
  const f = fixture(t)
  f.model.hotkey('dictate', true); f.model.hotkey('dictate', false)
  await f.flush()
  f.advance(5999)
  assert.equal(f.model.live.micQuiet, false)
  f.advance(1)
  assert.equal(f.model.live.micQuiet, true)
  assert.equal(f.model.state.phase, 'recording')
  for (let i = 0; i < 3; i++) f.model.acceptLevel(.3)
  assert.equal(f.model.live.micQuiet, false)
  f.advance(20_000)
  assert.equal(f.model.live.micQuiet, false)
  assert.equal(f.stops(), 0)
  f.model.cancelRecording()
})

test('microphone test uses monitor mode, stops automatically, and never sends model work', async (t) => {
  const f = fixture(t)
  let options, cancelled = 0, work = 0
  f.model.recorder.start = async (value) => { options = value }
  f.model.recorder.cancel = () => { cancelled++ }
  f.model.worker.send = () => { work++ }
  assert.equal((await f.model.startMicrophoneTest()).ok, true)
  assert.equal(options.monitor, true)
  assert.equal(f.model.state.phase, 'ready')
  assert.equal(f.model.state.micTestActive, true)
  f.advance(15_000)
  assert.equal(f.model.state.micTestActive, false)
  assert.equal(cancelled, 1)
  assert.equal(work, 0)
})

test('starting dictation releases an active microphone test first', async (t) => {
  const f = fixture(t)
  const sequence = []
  f.model.recorder.start = async (options) => sequence.push(options.monitor ? 'monitor' : 'record')
  f.model.recorder.cancel = () => sequence.push('cancel')
  await f.model.startMicrophoneTest()
  f.model.toggleRecording()
  await f.flush()
  assert.deepEqual(sequence, ['monitor', 'cancel', 'record'])
  assert.equal(f.model.state.micTestActive, false)
  f.model.cancelRecording()
})

test('practice bypasses memory and last-output follow-ups without changing preferences', async (t) => {
  const f = fixture(t)
  f.model.ownPractice = async () => true
  f.model.lastPasted = { text: 'real earlier dictation', at: 10_000 }
  f.model.hotkey('dictate', true); f.model.hotkey('dictate', false)
  await f.flush()
  const options = f.model.requestOptions()
  assert.equal(options.memory, 'off')
  assert.equal(options.previous_output, '')
  assert.equal(f.model.stored.memoryMode, 'notes')
  f.model.cancelRecording()
})

test('sound preference mutes start and finish cues', async (t) => {
  const f = fixture(t)
  f.model.stored.feedbackSounds = false
  f.model.hotkey('dictate', true); f.model.hotkey('dictate', false)
  await f.flush()
  f.advance(600)
  f.model.hotkey('dictate', true); f.model.hotkey('dictate', false)
  await f.flush()
  assert.equal(f.sounds.length, 0)
})

test('correction shortcut previews a selection and saves only after confirmation', async (t) => {
  const f = fixture(t)
  f.model.state.transcript = 'Ask queen to fix the wording.'
  let opened = 0
  f.model.onCorrectionRequested = () => { opened++ }
  const result = await f.model.previewCorrection({ selected: 'Ask Qwen to fix the wording.', secure: false })
  assert.equal(result.ok, true)
  assert.equal(opened, 1)
  assert.equal(f.files.size, 0)
  assert.equal(f.model.personal.examples.length, 0)
  assert.equal(f.model.saveCorrection({ ...f.model.state.correction, id: 'stale' }).ok, false)
  const draft = f.model.state.correction
  assert.equal(f.model.saveCorrection(draft).ok, true)
  assert.equal(f.model.personal.examples.length, 1)
  assert.equal(f.model.personal.examples[0].corrected, 'Ask Qwen to fix the wording.')
  assert.equal(f.model.state.correction, null)
})

test('secure selections cannot become correction drafts; dismissal stores nothing', async (t) => {
  const f = fixture(t)
  f.model.state.transcript = 'Original'
  assert.equal((await f.model.previewCorrection({ selected: 'Secret', secure: true })).ok, false)
  assert.equal(f.model.state.correction, null)
  await f.model.previewCorrection({ selected: 'Corrected', secure: false })
  f.model.dismissCorrection()
  assert.equal(f.files.size, 0)
  assert.equal(f.model.state.correction, null)
})

test('confirmed paste identity comes from delivery, not the app used to start recording', async (t) => {
  const f = fixture(t)
  f.model.target = { appName: 'Original' }
  f.model.live.destination = { appName: 'Other app' }
  f.model.helper.lastDeliveryDestination = { app: 'raycast', appName: 'Raycast', icon: '', editable: true }
  assert.equal(await f.model.deliver('hello'), 'pasted')
  assert.equal(f.model.live.deliveredTo.appName, 'Raycast')
  f.model.stored.autoPaste = false
  await f.model.deliver('copy only')
  assert.equal(f.model.live.deliveredTo, null)
})

test('explicit paste-last works when automatic paste is disabled', async (t) => {
  const f = fixture(t)
  f.model.stored.autoPaste = false
  f.model.state.history = [{ text: 'Recovered words', at: 9000, app: 'Original' }]
  await f.model.pasteLast()
  assert.equal(f.pasteCount(), 1)
  assert.match(f.model.state.message, /^Pasted\./)
})

test('history keeps full formatting and skips whitespace-only dictations', async (t) => {
  const f = fixture(t)
  const text = '\n1. Call Maya.\n2. Send the file.\n\n'
  f.model.requestID = 'normal'
  f.model.handle({ event: 'result', id: 'normal', text })
  await f.flush()
  assert.equal(f.model.state.history[0].text, text)

  f.model.requestID = 'break'
  f.model.handle({ event: 'result', id: 'break', text: '\n\n' })
  await f.flush()
  assert.deepEqual(Array.from(f.model.state.history, (entry) => entry.text), [text])
})

test('stopRecording preserves streamed pieces when recorder.stop returns null', async (t) => {
  const f = fixture(t)
  const sent = []
  f.model.worker.send = (msg) => sent.push(msg)
  f.model.hotkey('dictate', true); f.model.hotkey('dictate', false)
  await f.flush()
  f.model.piece(Buffer.alloc(100), 0)
  f.model.recorder.stop = async () => null
  f.model.hotkey('dictate', true); f.model.hotkey('dictate', false)
  await f.flush()
  assert.equal(sent.some((m) => m.command === 'transcribe'), true)
  assert.equal(sent.some((m) => m.command === 'discard'), false)
})

test('deliver failure never leaves coordinator wedged in transcribing', async (t) => {
  const f = fixture(t)
  f.model.helper.deliver = async () => { throw new Error('helper crashed') }
  f.model.state.phase = 'transcribing'
  f.model.requestID = 'req1'
  f.model.handle({ event: 'result', id: 'req1', text: 'saved words' })
  await f.flush()
  assert.equal(f.model.state.phase, 'ready')
  assert.match(f.model.state.message, /^Copied\./)
})

test('vocabulary rename works in place even at the 200-word limit and restoreWord enforces cap', async (t) => {
  const f = fixture(t)
  for (let i = 0; i < 200; i++) {
    assert.equal(f.model.addWord(`Term${i}`, '').ok, true)
  }
  assert.equal(f.model.addWord('Term200', '').ok, false)
  const first = f.model.personal.vocabulary[0]
  const renamed = f.model.addWord('RenamedTerm', 'alias', first.id)
  assert.equal(renamed.ok, true)
  assert.equal(f.model.personal.vocabulary[0].word, 'RenamedTerm')
  assert.equal(f.model.personal.vocabulary.length, 200)
  assert.equal(f.model.restoreWord({ id: 'extra', word: 'Extra', alias: '' }, 0).ok, false)
})

test('failed correction shortcut notifies visibly', async (t) => {
  const f = fixture(t)
  const notices = []
  f.model.onNotice = (title, detail) => notices.push({ title, detail })
  const res = await f.model.previewCorrection({ selected: '', secure: false }, true)
  assert.equal(res.ok, false)
  assert.equal(notices.length, 1)
})

test('media is left alone by default', async (t) => {
  const f = fixture(t)
  f.model.hotkey('dictate', true); f.model.hotkey('dictate', false)
  await f.flush()
  f.model.cancelRecording()
  await f.flush()
  assert.deepEqual(f.media, [])
})

test('lowered volume comes back when a dictation finishes', async (t) => {
  const f = fixture(t)
  f.model.stored.whileRecording = 'duck'
  f.model.hotkey('dictate', true); f.model.hotkey('dictate', false)
  await f.flush()
  assert.deepEqual(f.media, ['duck'])
  f.advance(600)
  f.model.hotkey('dictate', true); f.model.hotkey('dictate', false)
  await f.flush()
  assert.deepEqual(f.media, ['duck', 'restore'])
})

test('paused media resumes on cancel, microphone failure and worker errors', async (t) => {
  const f = fixture(t)
  f.model.stored.whileRecording = 'pause'
  f.model.toggleRecording()
  await f.flush()
  f.model.cancelRecording()
  await f.flush()
  assert.deepEqual(f.media, ['pause', 'resume'])

  f.model.recorder.start = async () => { throw new Error('No microphone') }
  f.advance(300)
  f.model.toggleRecording()
  await f.flush()
  assert.equal(f.model.state.phase, 'ready')
  assert.deepEqual(f.media.slice(2), ['pause', 'resume'])

  f.model.recorder.start = async () => {}
  f.advance(300)
  f.model.toggleRecording()
  await f.flush()
  f.model.handle({ event: 'error', message: 'Worker stopped' })
  await f.flush()
  assert.equal(f.model.state.phase, 'failed')
  assert.deepEqual(f.media.slice(4), ['pause', 'resume'])
})

test('a quick second recording waits for the first volume restore', async (t) => {
  const f = fixture(t)
  f.model.stored.whileRecording = 'duck'
  let answer
  f.model.helper.media = (action) => { f.media.push(action); return new Promise((resolve) => { answer = resolve }) }
  f.model.toggleRecording()
  await f.flush()
  f.model.cancelRecording()
  f.advance(300)
  f.model.toggleRecording()
  await f.flush()
  // The second duck must not read the lowered volume as the level to restore.
  assert.deepEqual(f.media, ['duck'])
  answer({ action: 'restore', volume: 0.5 })
  await f.flush()
  assert.deepEqual(f.media, ['duck', 'restore', 'duck'])
  f.model.cancelRecording()
})

test('nothing is resumed when nothing was paused', async (t) => {
  const f = fixture(t)
  f.model.stored.whileRecording = 'pause'
  f.model.helper.media = async (action) => { f.media.push(action); return null }
  f.model.toggleRecording()
  await f.flush()
  f.model.cancelRecording()
  await f.flush()
  assert.deepEqual(f.media, ['pause'])
})

test('a single-modifier trigger registers with the helper and names itself in messages', async (t) => {
  const f = fixture(t)
  const result = await f.model.setShortcut('dictate', { kind: 'modifier', key: 'rightCommand' })
  assert.equal(result.ok, true)
  const spec = f.registrations.at(-1).find((key) => key.name === 'dictate')
  assert.deepEqual({ ...spec }, { name: 'dictate', modifierKey: 'rightCommand', holdMs: 1200 })
  assert.equal(f.model.state.settings.shortcuts.dictate.key, 'rightCommand')
  f.model.hotkey('dictate', true); f.model.hotkey('dictate', false)
  await f.flush()
  assert.match(f.model.state.message, /^Right Command to finish/)
  f.model.cancelRecording()
})

test('a modifier that became ⌘-something cancels the recording it started', async (t) => {
  const f = fixture(t)
  f.model.hotkey('dictate', true)
  await f.flush()
  assert.equal(f.model.state.phase, 'recording')
  f.model.hotkeyCancelled('dictate')
  assert.equal(f.model.state.phase, 'ready')
  assert.equal(f.model.live.holdStartedAt, null)
  // A cancel after a press that stopped a recording leaves the result alone.
  f.model.hotkey('dictate', true); f.model.hotkey('dictate', false)
  await f.flush()
  f.advance(600)
  f.model.hotkey('dictate', true)
  await f.flush()
  f.model.hotkeyCancelled('dictate')
  assert.equal(f.model.state.phase, 'ready')
  assert.equal(f.stops(), 1)
})

test('shortcut changes refuse clashes, unusable chords and chords another app owns', async (t) => {
  const f = fixture(t)
  const clash = await f.model.setShortcut('dictate', { kind: 'chord', code: 9, modifiers: ['option', 'control'] })
  assert.equal(clash.ok, false)
  assert.match(clash.feedback, /Paste last dictation/)
  assert.equal((await f.model.setShortcut('dictate', { kind: 'chord', code: 2, modifiers: ['option'] })).ok, false)
  assert.equal((await f.model.setShortcut('pasteLast', { kind: 'modifier', key: 'fn' })).ok, false)

  f.model.helper.registerHotkeys = async (keys) => {
    f.registrations.push(keys)
    return Object.fromEntries(keys.map((key) => [key.name, !(key.name === 'dictate' && key.code === 2)]))
  }
  const taken = await f.model.setShortcut('dictate', { kind: 'chord', code: 2, modifiers: ['control', 'option'] })
  assert.equal(taken.ok, false)
  assert.match(taken.feedback, /Control–Option–D is already used/)
  assert.deepEqual({ ...f.model.stored.shortcuts.dictate, modifiers: [...f.model.stored.shortcuts.dictate.modifiers] },
    { kind: 'chord', code: 49, modifiers: ['control'] })
  assert.equal(f.model.state.shortcutRegistered, true)

  const moved = await f.model.setShortcut('learnCorrection', { kind: 'chord', code: 37, modifiers: ['command', 'shift'] })
  assert.equal(moved.ok, true)
  assert.deepEqual([...f.model.stored.shortcuts.learnCorrection.modifiers], ['shift', 'command'])
})

test('recording a new shortcut pauses the current ones until it is saved or cancelled', async (t) => {
  const f = fixture(t)
  await f.model.registerShortcut()
  f.model.captureShortcut(true)
  await f.flush()
  assert.equal(f.registrations.at(-1).length, 0)
  // A retry while capturing must not turn them back on.
  await f.model.registerShortcut()
  assert.equal(f.registrations.at(-1).length, 0)
  f.model.captureShortcut(false)
  await f.flush()
  assert.equal(f.registrations.at(-1).length, 6)
  f.model.captureShortcut(true)
  f.advance(30_000)
  await f.flush()
  assert.equal(f.registrations.at(-1).length, 6)
})


/** A recorded dictation with one piece and a final tail, waiting for the worker. */
async function dictate(f, { translate = false } = {}) {
  const sent = []
  f.model.worker.send = (message) => sent.push(message)
  f.model.hotkey(translate ? 'translate' : 'dictate', true); f.model.hotkey(translate ? 'translate' : 'dictate', false)
  await f.flush()
  f.model.piece(Buffer.alloc(32_044), 0)
  f.model.recorder.stop = async () => Buffer.alloc(16_044)
  f.advance(600)
  f.model.hotkey(translate ? 'translate' : 'dictate', true); f.model.hotkey(translate ? 'translate' : 'dictate', false)
  await f.flush()
  return { sent, request: sent.find((message) => message.command === 'transcribe') }
}

const wavs = (f) => [...f.files.keys()].filter((file) => file.endsWith('.wav'))

test('a dictation whose words come back deletes its audio', async (t) => {
  const f = fixture(t)
  const { request } = await dictate(f)
  assert.equal(wavs(f).length, 2)
  assert.ok(wavs(f).every((file) => file.includes('/Dictait/Recovery/pending/')))
  f.model.handle({ event: 'result', id: request.id, text: 'Hello there.' })
  await f.flush()
  assert.deepEqual(wavs(f), [])
  assert.deepEqual(Array.from(f.model.state.recovered), [])
})

test('a failed dictation keeps its audio privately and says how to retry it', async (t) => {
  const f = fixture(t)
  const { request } = await dictate(f)
  f.model.handle({ event: 'error', id: request.id, message: 'Expected mono 16 kHz audio.' })
  assert.equal(f.model.state.phase, 'failed')
  assert.match(f.model.state.message, /^Expected mono 16 kHz audio\. The recording is saved; ⌃⌥R retries it\.$/)
  const [kept] = f.model.state.recovered
  assert.equal(kept.reason, 'Expected mono 16 kHz audio')
  assert.equal(kept.seconds, 1.5)
  assert.deepEqual(wavs(f).map((file) => file.split('/Recovery/')[1]), [`${kept.id}/00000.wav`, `${kept.id}/00001.wav`])
})

test('a timed-out or crashed worker keeps the recording too', async (t) => {
  const f = fixture(t)
  let stopped = 0
  f.model.worker.stop = () => { stopped++ }
  await dictate(f)
  f.advance(181_000)
  assert.equal(stopped, 1)
  assert.equal(f.model.state.phase, 'failed')
  assert.match(f.model.state.message, /^Transcription took too long\. The recording is saved/)
  assert.equal(f.model.state.recovered.length, 1)

  const g = fixture(t)
  await dictate(g)
  g.model.handle({ event: 'error', message: 'The model worker stopped. Click Retry to reload models.' })
  assert.match(g.model.state.message, /^The model worker stopped\. The recording is saved/)
  assert.equal(g.model.state.recovered.length, 1)
})

test('retrying a kept recording sends its pieces again, delivers the words and deletes it', async (t) => {
  const f = fixture(t)
  const { request } = await dictate(f, { translate: true })
  f.model.handle({ event: 'error', id: request.id, message: 'Out of memory.' })
  const [kept] = f.model.state.recovered
  assert.equal(kept.translate, true)
  f.model.state.phase = 'ready'
  const sent = []
  f.model.worker.send = (message) => sent.push(message)
  assert.equal((await f.model.retryRecording()).ok, true)
  assert.deepEqual(sent.map((message) => [message.command, message.path.split('/Recovery/')[1], message.task]),
    [['chunk', `${kept.id}/00000.wav`, 'translate'], ['transcribe', `${kept.id}/00001.wav`, 'translate']])
  assert.equal(f.model.state.phase, 'transcribing')
  f.model.handle({ event: 'result', id: sent[1].id, text: 'I will be there by six.' })
  await f.flush()
  assert.equal(f.pasteCount(), 1)
  assert.match(f.model.state.message, /^Pasted\./)
  assert.deepEqual(Array.from(f.model.state.recovered), [])
  assert.deepEqual(wavs(f), [])
})

test('a retry that fails again keeps one recording; a stopped engine reloads first', async (t) => {
  const f = fixture(t)
  const { request } = await dictate(f)
  f.model.handle({ event: 'error', id: request.id, message: 'First failure.' })
  f.model.state.phase = 'ready'
  const sent = []
  f.model.worker.send = (message) => sent.push(message)
  await f.model.retryRecording()
  f.model.handle({ event: 'error', id: sent.at(-1).id, message: 'Second failure.' })
  assert.equal(f.model.state.recovered.length, 1)
  assert.equal(f.model.state.recovered[0].reason, 'Second failure')
  let reloads = 0
  f.model.reloadModels = () => { reloads++ }
  assert.equal((await f.model.retryRecording()).ok, true)
  assert.equal(reloads, 1)
  f.model.handle({ event: 'ready', cleanup: true })
  await f.flush()
  assert.equal(f.model.state.phase, 'transcribing')
  assert.equal(f.model.removeRecording(f.model.state.recovered[0].id).ok, false)
})

test('cancelling deletes the audio, and late piece errors from it are ignored', async (t) => {
  const f = fixture(t)
  f.model.hotkey('dictate', true); f.model.hotkey('dictate', false)
  await f.flush()
  const session = f.model.session
  f.model.piece(Buffer.alloc(32_044), 0)
  f.model.cancelRecording()
  assert.deepEqual(wavs(f), [])
  f.model.handle({ event: 'chunk', id: session, index: 0, words: 0, error: 'No such file' })
  assert.equal(f.model.state.notice, '')
  assert.deepEqual(Array.from(f.model.state.recovered), [])
})

test('the translate shortcut records a translation and says so', async (t) => {
  const f = fixture(t)
  f.model.hotkey('translate', true); f.model.hotkey('translate', false)
  await f.flush()
  assert.equal(f.model.state.phase, 'recording')
  assert.equal(f.model.live.translating, true)
  assert.match(f.model.state.message, /^Control–Shift–Space to finish/)
  assert.equal(f.model.requestOptions().task, 'translate')
  f.model.cancelRecording()
  f.advance(300)
  f.model.hotkey('dictate', true); f.model.hotkey('dictate', false)
  await f.flush()
  assert.equal(f.model.live.translating, false)
  assert.equal(f.model.requestOptions().task, 'transcribe')
  f.model.cancelRecording()
})

test('"hey, undo that" removes the last paste only while it is untouched', async (t) => {
  const f = fixture(t)
  const calls = []
  f.model.helper.replaceLast = async (...args) => { calls.push(args); return 'replaced' }
  f.model.lastPasted = { text: ' Sent the invoice.', at: 10_000 }
  f.model.requestID = 'undo'
  f.model.handle({ event: 'result', id: 'undo', text: '', mode: 'undo' })
  await f.flush()
  assert.deepEqual(calls, [[' Sent the invoice.', '']])
  assert.equal(f.model.state.message, 'Removed your last dictation.')
  assert.equal(f.model.lastPasted, null)
  await f.model.undoLast(true)
  assert.match(f.model.state.message, /^Nothing to undo/)
  assert.equal(calls.length, 1)

  f.model.lastPasted = { text: 'Edited since', at: 10_000 }
  f.model.helper.replaceLast = async () => 'changed'
  await f.model.undoLast(true)
  assert.match(f.model.state.message, /edited since/)
  assert.equal(f.model.lastPasted.text, 'Edited since')
})

test('snippets are validated, updated by trigger and bounded', async (t) => {
  const f = fixture(t)
  assert.equal(f.model.saveSnippet('my calendly', 'https://calendly.com/maya').ok, true)
  assert.equal(f.model.saveSnippet('My  Calendly!', 'https://calendly.com/maya/30min').ok, true)
  assert.deepEqual(JSON.parse(JSON.stringify(f.model.state.snippets.map((entry) => [entry.trigger, entry.content]))), [['My Calendly!', 'https://calendly.com/maya/30min']])
  assert.equal(f.model.saveSnippet('hey there', 'x').ok, false)
  assert.equal(f.model.saveSnippet('...', 'x').ok, false)
  assert.equal(f.model.saveSnippet('sig', '   ').ok, false)
  assert.equal(f.model.saveSnippet('long', 'x'.repeat(2001)).ok, false)
  for (let i = 1; i < 100; i++) assert.equal(f.model.saveSnippet(`snippet ${i}`, 'text').ok, true)
  assert.equal(f.model.saveSnippet('one more', 'text').ok, false)
  const first = f.model.state.snippets[0]
  assert.equal(f.model.removeSnippet(first.id).ok, true)
  assert.equal(f.model.restoreSnippet(first, 0).ok, true)
  assert.equal(f.model.state.snippets[0].id, first.id)
  f.model.hotkey('dictate', true); f.model.hotkey('dictate', false)
  await f.flush()
  assert.equal(f.model.requestOptions().snippets.length, 100)
  f.model.cancelRecording()
})
