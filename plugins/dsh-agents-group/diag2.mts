import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountClosedoff } from './src/agents/closedoff.ts'
import { Config as ClosedoffConfig } from './agents/closedoff/src/config.ts'

const dir = mkdtempSync(join(tmpdir(), 'diag2-'))
const cfg = join(dir, 'group.json')
writeFileSync(cfg, JSON.stringify({ closedoff: {
  CLOSEDOFF_BASE_URL: 'https://gateway.test/',
  CLOSEDOFF_OPEN_CLIENT_ID: 'open-id', CLOSEDOFF_OPEN_CLIENT_SECRET: 'open-secret',
  CLOSEDOFF_APP_CODE: 'app-code', CLOSEDOFF_APP_CLIENT_ID: 'app-id',
  CLOSEDOFF_APP_CLIENT_SECRET: 'app-secret', CLOSEDOFF_USERNAME: 'tester',
} }))

const routes = []
const ctx = {
  effect: f => { const d = f(); return () => {} },
  on: () => () => {},
  get: () => undefined,
  root: { emit: () => {} },
  webServer: { register: r => { routes.push(r.path); return () => {} } },
  llm: { resolveModelInfo: async () => undefined, resolveCallConfig: async v => v },
  agents: { list: () => [], get: () => undefined },
  tools: { register: () => () => {}, restrict: () => () => {} },
}
const access = { mode: 'standalone', ready() {}, assert() {}, resolve: () => ({ namespace: 'standalone', userId: 'local' }) }
const http = { register: r => { routes.push(r.path); return () => {} }, registerPublic: r => { routes.push(r.path); return () => {} } }

try {
  await mountClosedoff({ ctx, access, http, config: ClosedoffConfig({}), agentConfig: {}, groupConfigPath: cfg })
  console.log('OK routes:', routes.length, routes.slice(0,3))
} catch (e) {
  console.log('FAILED:', e.message)
  console.log((e.stack ?? '').split('\n').slice(0,8).join('\n'))
}
