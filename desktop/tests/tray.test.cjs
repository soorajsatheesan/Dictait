const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { buildSync } = require('esbuild')
const path = require('node:path')
const vm = require('node:vm')

const code = buildSync({
  entryPoints: [path.join(__dirname, '../src/main/tray.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', './archive']
}).outputFiles[0].text

function trayFixture(model, readRecentSavedDictations = async () => []) {
  let tray, showMenu
  class Tray extends EventEmitter {
    constructor() { super(); tray = this }
    setImage() {}
    setToolTip() {}
    popUpContextMenu(menu) { showMenu(menu) }
  }
  const electron = {
    app: { isPackaged: false, getAppPath: () => path.join(__dirname, '..') },
    Menu: { buildFromTemplate: (items) => items },
    nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
    Tray
  }
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: (name) => {
      if (name === 'electron') return electron
      if (name === './archive') return { readRecentSavedDictations }
      return require(name)
    }
  })
  new module.exports.StatusMenu(model, { show() { assert.fail('Copy must not open the window') } })
  return {
    open() {
      return new Promise((resolve) => {
        showMenu = resolve
        tray.emit('click')
      })
    }
  }
}

test('menu-bar copy shows the latest two previews and copies the selected full text', async () => {
  const latest = '\n1. Check the microphone.\n2. Send the full dictation to the right document.\n\n'
  const previous = 'Send the latest draft tomorrow.'
  const copied = []
  const history = [latest, '\n', previous, 'Older entry'].map((text) => ({ text, at: 1, app: 'Notes' }))
  const model = {
    state: { phase: 'ready', message: 'Ready', history },
    stored: {},
    refreshPermissions() {},
    async copyText(text) { copied.push(text) },
    notify() {},
    pasteLast() { assert.fail('Copy must not paste') }
  }
  const template = await trayFixture(model).open()
  const choices = template.filter((item) => item.label?.startsWith('Copy “'))
  assert.equal(choices.length, 2)
  assert.match(choices[0].label, /^Copy “1\. Check the microphone\. 2\./)
  assert.match(choices[0].label, /…”$/)
  assert.equal(choices[1].label, `Copy “${previous}”`)
  assert.ok(template.some((item) => item.label === 'Paste last dictation'))

  history.unshift({ text: 'A newer dictation', at: 2, app: 'Notes' })
  choices[1].click()
  choices[0].click()
  assert.deepEqual(copied, [previous, latest])
})

test('the menu fills empty slots with saved dictations while Notes is enabled', async () => {
  const entry = (text) => ({ text, at: 1, app: '' })
  const model = {
    state: { phase: 'ready', message: 'Ready', history: [] },
    stored: { memoryMode: 'notes' },
    refreshPermissions() {}
  }
  let reads = 0
  const tray = trayFixture(model, async () => { reads++; return [entry('Saved today'), entry('Saved yesterday')] })
  const labels = (items) => Array.from(items).map((item) => item.label).filter((label) => label?.startsWith('Copy “'))
  assert.deepEqual(labels(await tray.open()), ['Copy “Saved today”', 'Copy “Saved yesterday”'])
  model.state.history.push(entry('Current dictation'))
  assert.deepEqual(labels(await tray.open()), ['Copy “Current dictation”', 'Copy “Saved today”'])
  model.stored.memoryMode = 'off'
  assert.deepEqual(labels(await tray.open()), ['Copy “Current dictation”'])
  assert.equal(reads, 2)
})
