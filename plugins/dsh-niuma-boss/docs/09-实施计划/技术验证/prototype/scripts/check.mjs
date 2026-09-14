import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { compileMap, delivery, generated } from './prepare-assets.mjs'
import { Pathfinder, stepPosition } from '../src/navigation.ts'
import { ButlerClient } from '../src/butler-client.ts'
import { startServer } from './server.mjs'

const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const checks = []
const check = (name, evidence) => { checks.push({ name, evidence }); console.log('PASS ' + name) }
const [tmj, layout, tsj, runtime, assetReport] = await Promise.all([
  ...['office.tmj', 'office.layout.json', 'world.tsj'].map(name => readJson(resolve(delivery, 'maps', name))),
  readJson(resolve(generated, 'office.runtime.json')), readJson(resolve(generated, 'asset-report.json')),
])
compileMap(tmj, layout, tsj)
for (const mutate of [
  copy => copy.width++,
  copy => { copy.layers.find(l => l.name === 'collision').data[0] = 0 },
  copy => { copy.layers.find(l => l.type === 'objectgroup').objects[0].x++ },
]) { const bad = structuredClone(tmj); mutate(bad); assert.throws(() => compileMap(bad, layout, tsj)) }
check('真实双源地图与不一致拒绝', { draws: runtime.draws.length, blocked: runtime.collision.filter(Boolean).length, negativeCases: 3 })

let frameCount = 0
for (const atlas of assetReport.atlases) {
  const data = await readJson(resolve(generated, atlas.name + '.json'))
  const expected = atlas.name === 'office' ? new Map(runtime.draws.map(d => [d.frame, null]))
    : atlas.name === 'vfx' ? new Map(runtime.effects.flat().map(f => [f, [16, 16]]))
    : new Map(runtime.characters.find(c => c.id === atlas.name).clips.flatMap(c => c.frames).map(f => [f.path, f.size]))
  for (const texture of data.textures) {
    const png = await readFile(resolve(generated, texture.image))
    assert.equal(png.readUInt32BE(16), texture.size.w)
    assert.equal(png.readUInt32BE(20), texture.size.h)
    assert(texture.size.w <= 2048 && texture.size.h <= 2048)
    for (const frame of texture.frames) {
      assert(expected.has(frame.filename))
      const size = expected.get(frame.filename)
      if (size) assert.deepEqual([frame.sourceSize.w, frame.sourceSize.h], size)
      assert(!frame.rotated && !frame.trimmed)
      assert(frame.frame.x + frame.frame.w <= texture.size.w && frame.frame.y + frame.frame.h <= texture.size.h)
      expected.delete(frame.filename)
      frameCount++
    }
  }
  assert.equal(expected.size, 0)
}
check('图集完整性与2048上限', { atlases: assetReport.atlases.length, frames: frameCount, characterFrames: assetReport.atlases.filter(a => !['office', 'vfx'].includes(a.name)).reduce((n, a) => n + a.frames, 0) })
assert.equal(runtime.draws.length, tmj.width * tmj.height + layout.objects.filter(o => !o.preview_only).length)
if (process.argv.includes('--assets-only')) {
  await mkdir('../evidence', { recursive: true })
  await writeFile('../evidence/asset-checks.json', JSON.stringify({ generatedAt: new Date().toISOString(), checks, previewObjectsExcluded: layout.objects.filter(o => o.preview_only).length }, null, 2))
  process.exit(0)
}

const grid = Array.from({ length: runtime.height }, (_, y) => runtime.collision.slice(y * runtime.width, (y + 1) * runtime.width))
const finder = new Pathfinder(grid)
async function solve(finder, from, to) {
  let done = false, result
  const promise = finder.find(from, to).then(value => { result = value; done = true })
  for (let frame = 0; !done && frame < 100; frame++) { finder.tick(); await delay(0) }
  assert(done, '搜索必须有界')
  await promise
  return result
}
let longest = 0
for (const [x, y] of [runtime.spawn, [6, 6], [13, 6], [5, 14], [13, 14], [21, 14], [18, 5], [24, 5], [19, 27], [38, 24]]) {
  const path = await solve(finder, { x: runtime.spawn[0], y: runtime.spawn[1] }, { x, y })
  assert(path?.length, '目标无路径 ' + x + ',' + y)
  longest = Math.max(longest, path.length)
  for (let i = 0; i < path.length; i++) {
    assert(finder.walkable(path[i].x, path[i].y))
    if (i) assert.equal(Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y), 1)
  }
}
assert.equal(await solve(finder, { x: 0, y: 0 }, { x: 6, y: 6 }), null)
const stale = finder.find({ x: 34, y: 26 }, { x: 6, y: 6 })
finder.cancel()
assert.equal(await stale, null)
const large = Array.from({ length: 100 }, (_, y) => Array.from({ length: 100 }, (_, x) => x === 50 ? 1 : 0))
const capped = new Pathfinder(large)
assert.equal(await solve(capped, { x: 1, y: 1 }, { x: 98, y: 98 }), null)
assert.equal(capped.iterations, 4096)
assert(capped.limited)
const stopped = stepPosition({ x: 16, y: 16 }, { x: 112, y: 16 }, 96, (x, y) => y === 0 && x !== 1 && x >= 0 && x < 4)
assert(stopped.x < 32)
check('四向寻路、取消、4096上限与连续碰撞', { officePaths: 10, longest, officeMaxTickMs: finder.maxFrameMs, cappedMaxTickMs: capped.maxFrameMs, note: 'Node调用耗时，不能代替浏览器单帧/移动设备实测' })

const fixture = await startServer()
const client = new ButlerClient(fixture.origin, '/butler')
try {
  const page = await fetch(fixture.origin + '/niuma-boss')
  assert.equal(page.status, 200)
  assert((await page.text()).includes('/niuma-boss/assets/'))
  assert.equal((await fetch(fixture.origin + '/niuma-boss/ready')).status, 200)
  assert.equal((await fetch(fixture.origin + '/niuma-boss', { redirect: 'manual', headers: { 'x-validation-deny': 'unauthorized' } })).status, 303)
  assert.equal((await fetch(fixture.origin + '/niuma-boss/generated/office.json', { headers: { 'x-validation-deny': 'forbidden' } })).status, 403)
  assert.equal((await fetch(fixture.origin + '/niuma-boss/generated/%2e%2e%2f%2e%2e%2fpackage.json')).status, 404)
  assert.equal((await fetch(fixture.origin + '/niuma-boss/generated/office.json')).headers.get('content-type'), 'application/json')
  check('kit静态页面、资源、健康、访问拒绝与路径边界', { checks: 6, auth: '替身Access，不是真实Cookie' })

  await client.start()
  const writesBefore = fixture.counts.requests
  for (const path of ['/chat', '/reply', '/supplement']) {
    const payload = { requestId: crypto.randomUUID(), text: '仅本地验证', validation: { drop: true } }
    const pending = client.write(path, payload)
    payload.text = '调用后修改不得影响重试正文'
    await pending
    const records = fixture.counts.writes.slice(-2)
    assert.equal(records.length, 2)
    assert.deepEqual(records[0], records[1])
  }
  assert.equal(fixture.counts.requests - writesBefore, 6)
  assert.equal(fixture.counts.executions, 3)
  const errors = [
    ...[401, 403, 409, 422, 500, 502, 503, 504].map(status => ({ status })),
    { status: 409, code: 'version_conflict' }, { status: 200, code: 'run_result_unknown' },
  ]
  for (const validation of errors) {
    const before = fixture.counts.requests, snapshots = fixture.counts.snapshots
    await assert.rejects(() => client.write('/chat', { requestId: crypto.randomUUID(), validation }))
    assert.equal(fixture.counts.requests, before + 1)
    assert(fixture.counts.snapshots > snapshots)
  }
  const beforeStop = fixture.counts.requests
  await assert.rejects(() => client.write('/stop', { requestId: crypto.randomUUID(), validation: { drop: true } }))
  assert.equal(fixture.counts.requests, beforeStop + 1)
  check('未知响应原ID原正文重试及确定错误禁止重试', { writes: 3, rejectedCases: errors.length, stopRequests: 1 })

  const observing = client.observe()
  const started = Date.now()
  while (client.state.sequence < 8 && Date.now() - started < 26000) await delay(100)
  assert.deepEqual(client.state.reconnects, [1000, 2000, 5000, 10000])
  assert.equal(client.state.resets, 1)
  assert(fixture.counts.subscriptions.includes(7), 'reset后必须用事件seq续传')
  assert(client.state.sequence >= 8)
  const before = fixture.counts.subscriptions.length
  client.stop()
  await observing
  await delay(100)
  assert.equal(fixture.counts.subscriptions.length, before)
  check('真实HTTP/SSE桩断线退避、reset与释放', { reconnects: client.state.reconnects, afters: fixture.counts.subscriptions, resets: client.state.resets, elapsedMs: Date.now() - started })
} finally { client.stop(); await fixture.close() }
const denied = await startServer({ streamStatus: 403 })
const deniedClient = new ButlerClient(denied.origin, '/butler')
try {
  await deniedClient.start()
  await deniedClient.observe()
  assert.equal(denied.counts.subscriptions.length, 1)
  assert.equal(deniedClient.state.reconnects.length, 0)
  check('SSE权限拒绝停止重连', { status: 403, requests: 1 })
} finally { deniedClient.stop(); await denied.close() }
await mkdir('../evidence', { recursive: true })
await writeFile('../evidence/node-checks.json', JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, checks, browser: '未测' }, null, 2))
console.log('PASS total=' + checks.length)
