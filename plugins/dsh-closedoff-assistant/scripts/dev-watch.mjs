import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { watch } from 'node:fs'
import { copyFile, readFile, utimes } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'dist/index.mjs')
const webRoot = resolve(root, 'web')
const pnpm = process.env.npm_execpath
if (pnpm === undefined) throw new Error('run this watcher through `pnpm dev`')

async function digest() {
  return createHash('sha256').update(await readFile(output)).digest('hex')
}

async function touchOutput() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const now = new Date()
      await utimes(output, now, now)
      console.error('[closedoff-dev] notified DSH HMR')
      return
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await delay(100)
    }
  }
  throw new Error('dist/index.mjs was not rebuilt within 10 seconds')
}

let lastDigest = await digest()
let webTimer
const dirtyWebSources = new Set()
let sourceGeneration = 0
const sourceWatcher = watch(resolve(root, 'src'), { recursive: true }, () => {
  const generation = ++sourceGeneration
  const previousDigest = lastDigest
  void (async () => {
    for (let attempt = 0; attempt < 100 && generation === sourceGeneration; attempt++) {
      await delay(100)
      let nextDigest
      try {
        nextDigest = await digest()
      } catch (error) {
        if (error?.code !== 'ENOENT') console.error(error)
        continue
      }
      if (nextDigest === previousDigest) continue
      lastDigest = nextDigest
      await touchOutput()
      return
    }
  })().catch(console.error)
})
const webWatcher = watch(webRoot, (_event, filename) => {
  const source = String(filename).toLowerCase()
  if (!['index.html', 'app.css', 'trajectory.js', 'app.js'].includes(source)) return
  dirtyWebSources.add(source)
  clearTimeout(webTimer)
  webTimer = setTimeout(() => void (async () => {
    const sources = Array.from(dirtyWebSources)
    dirtyWebSources.clear()
    for (const dirtySource of sources) {
      if (dirtySource !== 'index.html') {
        await copyFile(resolve(webRoot, dirtySource), resolve(webRoot, 'assets', dirtySource))
      }
    }
    await touchOutput()
  })().catch(console.error), 150)
})

const child = spawn(process.execPath, [pnpm, 'exec', 'tsdown', 'src/index.ts', '--format', 'esm', '--dts', '--watch'], {
  cwd: root,
  stdio: 'inherit',
})

let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  clearTimeout(webTimer)
  sourceWatcher.close()
  webWatcher.close()
}

child.once('error', (error) => {
  cleanup()
  console.error(error)
  process.exitCode = 1
})
child.once('exit', (code) => {
  cleanup()
  process.exitCode = code ?? 1
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    cleanup()
    if (!child.killed) child.kill(signal)
  })
}
