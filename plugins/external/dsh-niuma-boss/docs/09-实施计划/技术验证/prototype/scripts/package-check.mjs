import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, readdir, mkdir, mkdtemp, writeFile, stat } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { main as verify } from '../../../../../../../packages/plugin-manager/src/verify-package.mjs'
import { startServer } from './server.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const archive = resolve(root, '.artifacts', manifest.name + '-' + manifest.version + '.tgz')
verify(['--root', root, '--package', '.', '--archive', archive])
const unpacked = await mkdtemp(resolve(root, '.artifacts/install-'))
const extracted = spawnSync('tar', ['-xzf', archive, '-C', unpacked], { encoding: 'utf8' })
assert.equal(extracted.status, 0, extracted.stderr)
const bundleRoot = resolve(unpacked, 'package/dist')
const packed = await import(pathToFileURL(resolve(bundleRoot, 'index.mjs')).href)
assert.equal(typeof packed.apply, 'function')
const fixture = await startServer({ staticRoot: bundleRoot, installRoutes: packed.installValidationRoutes })
try {
  assert.equal((await fetch(fixture.origin + '/niuma-boss')).status, 200)
  assert.equal((await fetch(fixture.origin + '/niuma-boss/generated/office.runtime.json')).status, 200)
  assert.equal((await fetch(fixture.origin + '/niuma-boss/ready')).status, 200)
  assert.equal((await fetch(fixture.origin + '/niuma-boss/health')).status, 200)
} finally { await fixture.close() }
const unavailable = await startServer({ staticRoot: bundleRoot, installRoutes: packed.installValidationRoutes, readyFails: true })
try {
  assert.equal((await fetch(unavailable.origin + '/niuma-boss/ready')).status, 503)
  assert.equal((await fetch(unavailable.origin + '/niuma-boss/health')).status, 200)
} finally { await unavailable.close() }

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(e => e.isDirectory() ? walk(join(directory, e.name)) : join(directory, e.name)))
  return nested.flat()
}
const files = await Promise.all((await walk(resolve(root, 'dist'))).map(async path => {
  const content = await readFile(path)
  return { path: relative(resolve(root, 'dist'), path).replaceAll('\\', '/'), bytes: content.length, gzipBytes: gzipSync(content).length, sha256: createHash('sha256').update(content).digest('hex') }
}))
const initial = files.filter(f => f.path === 'index.html' || f.path.startsWith('assets/') || ['office.runtime.json', 'office.json', 'office.png', 'boss.json', 'boss.png'].some(name => f.path === 'generated/' + name))
const deferred = files.filter(f => f.path.startsWith('generated/') && !initial.includes(f) && f.path !== 'generated/asset-report.json')
const total = rows => ({ files: rows.length, bytes: rows.reduce((n, f) => n + f.bytes, 0), gzipBytes: rows.reduce((n, f) => n + f.gzipBytes, 0) })
const report = {
  generatedAt: new Date().toISOString(), node: process.version,
  archive: { bytes: (await stat(archive)).size, sha256: createHash('sha256').update(await readFile(archive)).digest('hex') },
  verification: '管理器 verify-package 通过；临时目录独立导入归档入口，页面/地图/ready/health各200；依赖故障时ready503而health200；不是官方宿主安装验收',
  initial: total(initial), deferred: total(deferred), files,
  sizeMethod: 'Node zlib.gzipSync 默认级别逐文件相加；本地服务器未启用压缩，数值为离线压缩体积，网络传输另测',
  firstLoadMethod: '由构建产物与加载代码计算，包含8个静态请求；另有身份/会话/probe/快照/SSE请求；实际浏览器HAR未测',
}
await mkdir(resolve(root, '../evidence'), { recursive: true })
await writeFile(resolve(root, '../evidence/package-check.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ archive: report.archive, initial: report.initial, deferred: report.deferred }))
