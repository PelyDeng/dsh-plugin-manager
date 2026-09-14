import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
const source = await readFile(new URL('./host-readonly-probe.js', import.meta.url), 'utf8')
const identity = { mode: 'authenticated', key: 'DO_NOT_OUTPUT_IDENTITY', routePrefix: '/fixture', contractVersion: 1 }
const id = 'butler-web-01234567-89ab-4def-8123-456789abcdef'
const success = [identity, { items: [{ id, title: 'DO_NOT_OUTPUT_TITLE' }] }, { run: { seq: 7, runId: 'DO_NOT_OUTPUT_RUN' } }]
for (const [name, origin, data, status, expected, count] of [
  ['success', 'https://dsh.pelycloud.com', success, 200, 'passed', 3],
  ['wrong-origin', 'https://example.com', success, 200, 'failed', 0],
  ['unauthorized', 'https://dsh.pelycloud.com', success, 401, 'failed', 1],
  ['invalid-prefix', 'https://dsh.pelycloud.com', [{ ...identity, routePrefix: '//example.com' }], 200, 'failed', 1],
  ['empty', 'https://dsh.pelycloud.com', [identity, { items: [] }], 200, 'partial', 2],
  ['invalid-id', 'https://dsh.pelycloud.com', [identity, { items: [{ id: '../other' }] }], 200, 'failed', 2],
  ['invalid-probe', 'https://dsh.pelycloud.com', [identity, success[1], {}], 200, 'failed', 3],
]) {
  const calls = []; let output
  await runInNewContext(source, { location: { origin }, AbortSignal, console: { log: value => { output = value } }, fetch: async (path, options) => {
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error')
    assert(path.startsWith('/') && !path.startsWith('//'))
    calls.push(path)
    return { status, json: async () => data[calls.length - 1] }
  } })
  assert.equal(calls.length, count, name)
  assert.equal(JSON.parse(output).result, expected, name)
  assert(!output.includes('DO_NOT_OUTPUT') && !output.includes(id), name + ': sensitive output')
}
console.log('PASS: 7 local probe cases; production requests=0; identifiers/content excluded')
