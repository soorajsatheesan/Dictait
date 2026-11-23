// Disposable local editors for the macOS focus integration check. Never sends text anywhere.
const { app, BrowserWindow } = require('electron')
const readline = require('node:readline')
app.setName('Dictait focus fixture')
const windows = []
const html = '<title>Dictait focus test</title><style>body{padding:32px;font:16px system-ui}textarea,[contenteditable]{display:block;width:90%;height:70px;margin:16px 0;border:1px solid #999}</style><h1>Dictait focus test</h1><textarea aria-label="Message"></textarea><textarea aria-label="Message"></textarea><div contenteditable="true" role="textbox" aria-label="Message"></div><button>Test button</button><script>document.addEventListener("paste",e=>{if(!["current field","current window","current app","current thread","clipboard only","fresh field","follow-up"].includes(e.clipboardData.getData("text")))e.preventDefault()})</script>'
const fields = 'Array.from(document.querySelectorAll("textarea,[contenteditable]"))'
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
app.whenReady().then(async () => {
  for (let i = 0; i < 2; i++) {
    const window = new BrowserWindow({ width: 700, height: 540, x: 120 + i * 80, y: 120 + i * 70, show: false })
    // Keep physical typing out of this disposable editor, while allowing AX editing actions.
    window.webContents.on('before-input-event', (event, input) => {
      if (!(input.meta && input.key.toLowerCase() === 'v')) event.preventDefault()
    })
    windows.push(window)
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  }
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    const request = JSON.parse(line)
    try {
      const window = windows[request.window || 0]
      let result = null
      if (request.cmd === 'focus') {
        window.show(); window.focus(); app.focus({ steal: true })
        await window.webContents.executeJavaScript(`{ const e = ${fields}[${request.field || 0}]; e.focus(); if(e.setSelectionRange) e.setSelectionRange(${request.start || 0},${request.end || 0}); }`)
        result = { focused: window.isFocused(), domFocus: await window.webContents.executeJavaScript('document.hasFocus()'), pid: process.pid }
      } else if (request.cmd === 'focus-button') {
        window.show(); window.focus(); app.focus({ steal: true })
        await window.webContents.executeJavaScript('document.querySelector("button").focus()')
      } else if (request.cmd === 'values') {
        result = await window.webContents.executeJavaScript(`${fields}.map(e => e.value ?? e.textContent)`)
      } else if (request.cmd === 'title') {
        await window.webContents.executeJavaScript(`document.title = ${JSON.stringify(request.title)}`)
      } else if (request.cmd === 'remove') {
        await window.webContents.executeJavaScript(`${fields}[${request.field || 0}].remove()`)
      } else if (request.cmd === 'clear') {
        await window.webContents.executeJavaScript(`${fields}.forEach(e => { if('value' in e) e.value=''; else e.textContent='' })`)
      } else if (request.cmd === 'quit') { app.quit() }
      send({ id: request.id, result })
    } catch (error) { send({ id: request.id, error: error.message }) }
  })
  send({ ready: true })
})
