// Interactive macOS check: npm run helper && node --test tests/native-focus.test.cjs
// Opens disposable Electron editors, exercises real AX focus and paste, then closes them.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const path = require('node:path')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function peer(file, args) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'ignore'] })
  let next = 0, ready
  const pending = new Map()
  const started = new Promise((resolve) => { ready = resolve })
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let reply
    try { reply = JSON.parse(line) } catch { return }
    if (reply.ready) ready()
    const waiter = pending.get(reply.id)
    if (!waiter) return
    pending.delete(reply.id); clearTimeout(waiter.timer)
    if (reply.error) waiter.reject(new Error(reply.error)); else waiter.resolve(reply)
  })
  return {
    child, started,
    request: (cmd, extra = {}) => new Promise((resolve, reject) => {
      const id = ++next
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${cmd} timed out`)) }, 12_000)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ id, cmd, ...extra }) + '\n')
    }),
    close: () => { child.stdin.end(); child.kill(); for (const { timer } of pending.values()) clearTimeout(timer) }
  }
}

test('native delivery follows the current field, window and application', { skip: process.platform !== 'darwin', timeout: 60_000 }, async (t) => {
  const helper = peer(path.join(__dirname, '../build/bin/dictait-helper'), ['serve'])
  const editor = peer(require('electron'), [path.join(__dirname, 'focus-fixture.cjs')])
  const other = peer(require('electron'), [path.join(__dirname, 'focus-fixture.cjs')])
  t.after(() => { helper.close(); editor.close(); other.close() })
  await Promise.all([editor.started, other.started])
  const focus = async (app, window, field) => { await app.request('focus', { window, field }); await delay(200) }
  const values = async (window = 0, app = editor) => (await app.request('values', { window })).result
  const deliver = async (text) => {
    const current = await helper.request('focus')
    assert.equal(current.app, 'com.github.Electron', 'Focus left the disposable test editors')
    return helper.request('deliver', { text })
  }

  await focus(editor, 0, 0)
  await delay(2300) // Electron's native accessibility activation debounce.
  await focus(editor, 0, 0)
  const context = await helper.request('focus')
  assert.equal(context.editable, true)
  assert.equal('anchor' in context, false)
  const currentApp = await helper.request('active-window')
  assert.equal(currentApp.destination.app, 'com.github.Electron')
  assert.equal(currentApp.destination.editable, true)
  assert.ok(currentApp.bounds.width > 0)
  await focus(editor, 0, 1)
  const pasted = await deliver('current field')
  assert.equal(pasted.outcome, 'pasted')
  assert.equal(pasted.destination.app, 'com.github.Electron')
  await delay(200)
  assert.deepEqual(await values(), ['', 'current field', ''])

  // Follow-ups cannot bring the old field back into focus.
  await focus(editor, 0, 0)
  assert.equal((await helper.request('replace-last', { expected: 'current field', text: 'follow-up' })).outcome, 'gone')
  assert.deepEqual(await values(), ['', 'current field', ''])

  await editor.request('clear')
  await focus(editor, 0, 0)
  await helper.request('focus')
  await focus(editor, 1, 0)
  assert.equal((await deliver('current window')).outcome, 'pasted')
  await delay(200)
  assert.deepEqual(await values(0), ['', '', ''])
  assert.deepEqual(await values(1), ['current window', '', ''])

  await editor.request('clear', { window: 1 })
  await focus(editor, 0, 2)
  await helper.request('focus')
  await focus(other, 0, 0)
  assert.equal((await deliver('current app')).outcome, 'pasted')
  await delay(200)
  assert.deepEqual(await values(), ['', '', ''])
  assert.deepEqual(await values(0, other), ['current app', '', ''])

  await focus(editor, 0, 0)
  await helper.request('focus')
  await editor.request('title', { title: 'Another conversation' })
  await focus(editor, 0, 1)
  assert.equal((await deliver('current thread')).outcome, 'pasted')
  await delay(200)
  assert.deepEqual(await values(), ['', 'current thread', ''])
  await focus(editor, 0, 0)
  await delay(700)
  assert.deepEqual(await values(), ['', 'current thread', ''])

  // An unavailable text field copies only; returning to an old field cannot trigger a paste.
  await editor.request('clear')
  await editor.request('focus-button')
  await delay(200)
  assert.equal((await deliver('clipboard only')).outcome, 'no-target')
  await focus(editor, 0, 0)
  await delay(700)
  assert.deepEqual(await values(), ['', '', ''])

  await helper.request('focus')
  await editor.request('remove', { field: 0 })
  await focus(editor, 0, 0)
  assert.equal((await deliver('fresh field')).outcome, 'pasted')
  assert.deepEqual(await values(), ['fresh field', ''])
})
