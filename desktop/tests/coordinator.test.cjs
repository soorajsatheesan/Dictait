const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const path = require('node:path')

const code = buildSync({
  entryPoints: [path.join(__dirname, '../src/main/coordinator.ts')], bundle: true,
  platform: 'node', format: 'cjs', write: false, external: ['electron'],
  alias: { '@shared': path.join(__dirname, '../src/shared') }
}).outputFiles[0].text

function fixture(t) {
  const timers = new Map()
  const files = new Map(), sounds = []
  let now = 10_000, nextTimer = 0, pasteCount = 0, clipboardText = ''
  const electron = {
    app: { getVersion: () => 'test', getLoginItemSettings: () => ({}), isPackaged: false },
    clipboard: { writeText(text) { clipboardText = text }, readText: () => clipboardText }, shell: { beep() {} },
    systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: () => true },
    globalShortcut: { register: () => true, isRegistered: () => false, unregister() {} }
  }
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports, process, Buffer, console,
    Date: class extends Date { static now() { return now } },
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, interval) => { const id = ++nextTimer; timers.set(id, { fn, at: now + interval, interval }); return id },
    clearInterval: (id) => timers.delete(id),
    require: (name) => {
      if (name === 'electron') return electron
      if (name === 'node:fs') return { readFileSync: (file) => files.get(file) ?? '{}', writeFileSync: (file, value) => files.set(file, String(value)), mkdirSync() {}, existsSync: () => false,
        renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from) } }
      if (name === 'node:child_process') return { spawn: (...args) => { sounds.push(args); return { on() {}, unref() {} } } }
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
  return { model, flush, advance, files, sounds, electron, starts: () => starts, stops: () => stops, pasteCount: () => pasteCount }
}

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
