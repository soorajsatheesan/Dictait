const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const path = require('node:path')
const vm = require('node:vm')

const code = buildSync({
  entryPoints: [path.join(__dirname, '../src/shared/shortcuts.ts')], bundle: true, platform: 'node', format: 'cjs', write: false
}).outputFiles[0].text
const bundle = { exports: {} }
vm.runInNewContext(code, { module: bundle, exports: bundle.exports })
const shortcuts = bundle.exports
const plain = (value) => JSON.parse(JSON.stringify(value))

test('shortcuts read the same in keycaps, sentences and menu accelerators', () => {
  const { dictate, pasteLast } = shortcuts.DEFAULT_SHORTCUTS
  assert.deepEqual(plain(shortcuts.shortcutKeys(dictate)), ['⌃', 'Space'])
  assert.equal(shortcuts.shortcutName(pasteLast), 'Control–Option–V')
  assert.equal(shortcuts.shortcutAccelerator(pasteLast), 'Control+Alt+V')
  const rightCommand = { kind: 'modifier', key: 'rightCommand' }
  assert.deepEqual(plain(shortcuts.shortcutKeys(rightCommand)), ['Right ⌘'])
  assert.equal(shortcuts.shortcutName(rightCommand), 'Right Command')
  assert.equal(shortcuts.shortcutAccelerator(rightCommand), null)
  // Modifiers always read in macOS order, however they were recorded.
  assert.equal(shortcuts.shortcutName({ kind: 'chord', code: 2, modifiers: ['command', 'shift', 'control'] }), 'Control–Shift–Command–D')
})

test('only shortcuts that leave typing and everyday ⌘ shortcuts alone are accepted', () => {
  const check = (value, allowModifier = true) => plain(shortcuts.checkShortcut(value, allowModifier))
  assert.ok(check({ kind: 'chord', code: 2, modifiers: ['control', 'option'] }).shortcut)
  assert.ok(check({ kind: 'chord', code: 2, modifiers: ['command', 'shift'] }).shortcut)
  assert.ok(check({ kind: 'chord', code: 96, modifiers: [] }).shortcut, 'F5 on its own')
  assert.ok(check({ kind: 'chord', code: 2, modifiers: ['command'] }).error, '⌘D belongs to apps')
  assert.ok(check({ kind: 'chord', code: 14, modifiers: ['option'] }).error, '⌥E types an accent')
  assert.ok(check({ kind: 'chord', code: 2, modifiers: [] }).error)
  assert.ok(check({ kind: 'chord', code: 123, modifiers: [] }).error, 'a bare arrow key')
  assert.ok(check({ kind: 'chord', code: 53, modifiers: ['control'] }).error, 'Escape cancels recordings')
  assert.ok(check({ kind: 'modifier', key: 'fn' }).shortcut)
  assert.ok(check({ kind: 'modifier', key: 'fn' }, false).error)
  assert.ok(check({ kind: 'modifier', key: 'leftShift' }).error)
  assert.deepEqual(check({ kind: 'chord', code: 9, modifiers: ['option', 'control', 'bogus'] }).shortcut.modifiers, ['control', 'option'])
})

test('stored shortcuts fall back to the defaults piece by piece', () => {
  const result = plain(shortcuts.normalizeShortcuts({ dictate: { kind: 'modifier', key: 'rightOption' }, pasteLast: { kind: 'modifier', key: 'fn' } }))
  assert.deepEqual(result.dictate, { kind: 'modifier', key: 'rightOption' })
  assert.deepEqual(result.pasteLast, plain(shortcuts.DEFAULT_SHORTCUTS.pasteLast))
  assert.deepEqual(plain(shortcuts.normalizeShortcuts(undefined)), plain(shortcuts.DEFAULT_SHORTCUTS))
  assert.equal(shortcuts.keyForDomCode('KeyV').code, 9)
  assert.equal(shortcuts.keyForDomCode('Space').code, 49)
})
