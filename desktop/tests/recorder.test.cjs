const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const path = require('node:path')
const code = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/src/hud/recorder.ts')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text

function fixture() {
  let stopped = 0, node
  const track = { label: 'Test microphone', stop: () => { stopped++ }, addEventListener() {} }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
  class AudioContext {
    state = 'running'
    sampleRate = 16000
    audioWorklet = { addModule: async () => {} }
    destination = {}
    createMediaStreamSource() { return { connect() {} } }
    createGain() { return { gain: { value: 1 }, connect() {} } }
    close() { this.state = 'closed'; return Promise.resolve() }
  }
  class AudioWorkletNode {
    constructor() {
      node = this
      this.port = { onmessage: null, postMessage: () => this.port.onmessage?.({ data: { flushed: true } }) }
    }
    connect(target) { return target }
    disconnect() {}
  }
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, URL, AudioContext, AudioWorkletNode,
    navigator: { mediaDevices: { getUserMedia: async () => stream } }, document: { baseURI: 'https://dictait.local/' }, window: { setTimeout, clearTimeout } })
  const recorder = new module.exports.Recorder()
  return { recorder, stopped: () => stopped, message: () => node.port.onmessage, samples: () => ({ data: { samples: new Float32Array(64000), rms: .1 } }) }
}

test('mic monitoring reports levels without retaining audio or producing model chunks', async () => {
  const f = fixture()
  let levels = 0, pieces = 0
  f.recorder.onLevel = () => { levels++ }
  f.recorder.onPiece = () => { pieces++ }
  await f.recorder.start(null, true)
  for (let i = 0; i < 10; i++) f.message()(f.samples())
  assert.equal(levels, 10)
  assert.equal(pieces, 0)
  assert.equal(f.recorder.chunks.length, 0)
  assert.equal(f.recorder.deviceName, 'Test microphone')
  assert.equal((await f.recorder.stop()).audio, null)
  assert.equal(f.stopped(), 1)
})

test('queued messages from a cancelled recorder cannot reach the next recording', async () => {
  const f = fixture()
  await f.recorder.start()
  const staleMessage = f.message()
  f.recorder.cancel()
  await f.recorder.start()
  let levels = 0
  f.recorder.onLevel = () => { levels++ }
  staleMessage(f.samples())
  assert.equal(levels, 0)
  assert.equal(f.recorder.chunks.length, 0)
  f.message()(f.samples())
  assert.equal(levels, 1)
  f.recorder.cancel()
})

test('resample upsamples 8 kHz audio smoothly without zero-stuffing', () => {
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports })
  const input = new Float32Array([0.2, 0.4, 0.6, 0.8])
  const out = module.exports.resample(input, 8000, 16000)
  assert.equal(out.length, 8)
  for (let i = 0; i < out.length; i++) {
    assert.ok(out[i] >= 0.19 && out[i] <= 0.81, `unexpected sample ${out[i]} at ${i}`)
  }
})
