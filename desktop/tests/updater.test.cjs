const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const path = require('node:path')

const code = buildSync({
  entryPoints: [path.join(__dirname, '../src/main/updater.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron']
}).outputFiles[0].text

function load() {
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports, process, Buffer, console, setTimeout, setInterval,
    require: (name) => name === 'electron' ? { app: { getVersion: () => '0.6.6', isPackaged: true, quit() {} }, net: { fetch: async () => ({ ok: false, status: 500 }) } } : require(name)
  })
  return module.exports
}

test('isNewer handles semver and treats prereleases as older than stable', () => {
  const { isNewer } = load()
  assert.equal(isNewer('0.10.0', '0.9.3'), true)
  assert.equal(isNewer('0.7.0', '0.7.0-beta.1'), true)
  assert.equal(isNewer('0.7.0-beta.1', '0.7.0'), false)
  assert.equal(isNewer('0.7.0-beta.2', '0.7.0-beta.1'), true)
  assert.equal(isNewer('0.6.6', '0.6.6'), false)
})
