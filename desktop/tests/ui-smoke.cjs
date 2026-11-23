// Source-only UI check. Run `npm run web` separately, then `electron tests/ui-smoke.cjs`.
// Uses a hidden window and simulated bridge; never opens a mic or loads voice models.
const { app, BrowserWindow, nativeTheme } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const origin = process.env.DICTAIT_UI_TEST_URL || 'http://127.0.0.1:5199'
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dictait-ui-test-'))
const screenshots = path.join(os.tmpdir(), 'dictait-ux-review')
fs.mkdirSync(screenshots, { recursive: true })
app.setPath('userData', temporary)
app.disableHardwareAcceleration()
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const windows = []
const errors = []
async function run() {
  app.setActivationPolicy('prohibited')
  nativeTheme.themeSource = 'light'
  const window = new BrowserWindow({ width: 1180, height: 780, frame: false, show: false, webPreferences: { backgroundThrottling: false } })
  windows.push(window)
  window.webContents.on('console-message', (details) => { if (details.level === 'error') errors.push(details.message) })
  const evaluate = (code) => window.webContents.executeJavaScript(code, true)
  const waitFor = async (condition) => {
    for (let i = 0; i < 100; i++) { if (await evaluate(condition)) return; await delay(50) }
    throw new Error(`Timed out: ${condition}`)
  }
  const click = async (selector) => { await evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`); await delay(150) }
  const navigate = async (name) => {
    await evaluate(`Array.from(document.querySelectorAll('.nav-item')).find(e => e.textContent.includes(${JSON.stringify(name)})).click()`)
    await waitFor(`document.querySelector('h1')?.textContent === ${JSON.stringify(name)}`)
    await delay(350)
  }
  const capture = async (name) => {
    const image = await window.webContents.capturePage()
    fs.writeFileSync(path.join(screenshots, name + '.png'), image.toPNG())
  }
  await window.loadURL(origin + '/?section=practice')
  await waitFor("!!document.querySelector('#practice-editor')")
  assert.equal(await evaluate("document.activeElement.id"), 'practice-editor')
  await capture('practice-light')
  await evaluate(`{ const e=document.querySelector('#practice-editor'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Keep this practice sentence.'); e.dispatchEvent(new Event('input',{bubbles:true})); }`)
  await click('#lesson-edit')
  assert.equal(await evaluate("document.querySelector('#practice-editor').value"), 'Keep this practice sentence.')
  assert.equal(await evaluate("{ const e=document.querySelector('#practice-editor'); e.selectionEnd-e.selectionStart===e.value.length }"), true)
  await evaluate("document.querySelector('#lesson-edit').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))")
  await waitFor("document.activeElement.id === 'lesson-hold'")
  assert.equal(await evaluate("document.querySelector('#lesson-hold').getAttribute('aria-selected')"), 'true')
  await navigate('Settings')
  assert.equal(await evaluate("!!document.querySelector('[aria-label=\"Recording sounds\"]')"), true)
  await evaluate("Array.from(document.querySelectorAll('button')).find(e=>e.textContent.includes('Test mic')).click()")
  await waitFor("document.querySelector('[role=meter]')?.getAttribute('aria-valuenow') > 0")
  await capture('settings-mic-test')
  await navigate('Practice')
  assert.equal(await evaluate("(async()=> (await (await import('/src/lib/store.ts')).api.getState()).micTestActive)()"), false)
  await evaluate("(async()=> { const {api}=await import('/src/lib/store.ts'); await api.learnCorrection(); })()")
  await waitFor("!!document.querySelector('dialog[open]')")
  assert.match(await evaluate("document.querySelector('dialog').textContent"), /Heard this/)
  assert.match(await evaluate("document.querySelector('dialog').textContent"), /You meant this/)
  await capture('correction-light')
  nativeTheme.themeSource = 'dark'
  await delay(200)
  await capture('correction-dark')
  await evaluate("document.querySelector('dialog').dispatchEvent(new Event('cancel',{cancelable:true}))")
  await waitFor("!document.querySelector('dialog')")
  await evaluate("(async()=> { const {api}=await import('/src/lib/store.ts'); await api.learnCorrection(); })()")
  await waitFor("!!document.querySelector('dialog[open]')")
  await click('dialog .btn.primary')
  await waitFor("!document.querySelector('dialog')")
  window.setSize(940, 620)
  await delay(200)
  await capture('practice-dark-compact')
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true)

  for (const [name, query, expected] of [
    ['island-toggle', 'kind=recording', 'Tap'],
    ['island-hold', 'kind=recording&mode=hold', 'Release'],
    ['island-quiet', 'kind=recording&quiet=1', 'Can’t hear you'],
    ['island-copied', 'kind=copied', '⌃⌥V']
  ]) {
    window.setSize(520, 180)
    await window.loadURL(origin + '/hud.html?' + query)
    await waitFor("document.querySelector('.island-content')?.textContent.includes(" + JSON.stringify(expected) + ")")
    await delay(800)
    const rect = await evaluate("{ const r=document.querySelector('.island-content').getBoundingClientRect(); ({bottom:r.bottom,height:r.height,viewport:innerHeight}) }")
    assert.ok(rect.bottom <= rect.viewport, `${name} is clipped: ${JSON.stringify(rect)}`)
    if (query.includes('kind=recording')) assert.match(await evaluate("document.body.textContent"), /T3 Code/)
    await capture(name)
  }
  assert.deepEqual(errors, [])
  console.log('UI checks passed: practice selection, mic-test cleanup, correction review/save/cancel, light/dark, compact layout and four island states.')
  console.log('Review screenshots: ' + screenshots)
}
const finish = (code) => {
  for (const window of windows) if (!window.isDestroyed()) window.destroy()
  fs.rmSync(temporary, { recursive: true, force: true })
  app.exit(code)
}
app.whenReady().then(run).then(() => finish(0)).catch((error) => { console.error(error); finish(1) })
