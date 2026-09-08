/** Verify the Agent receives the shipped knowledge on create and resume, not model quality. */
import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fixture } from './fixture.mjs'

test('setup FAQ remains readable with application authorization when the model is unavailable', async () => {
  const f = await fixture({ mode: 'authenticated', beforeCreate() { throw new Error('model unavailable') } })
  try {
    const page = await f.request('')
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('配置或更换 API 密钥')
    const faq = await f.request('/guide.md')
    expect(faq.status).toBe(200)
    const text = await faq.text()
    expect(text).toContain('dsh web authentication required')
    expect(text).toContain('bash deploy/scripts/set-api-key.sh --config .local/deployment.json')
    expect(text).toContain('写入官方存储时默认无需重启')
    expect(text).toMatch(/SHA-256\s*指纹/)
    expect(text).toContain('文件为准，只注入官方DSH子进程，网页只读')
    expect(text).toContain('留空不添加覆盖、不删除官方凭据、不清除继承环境密钥')
    expect(f.handles).toHaveLength(0)
    expect((await f.request('/guide.md', undefined, '')).status).not.toBe(200)
  } finally { await f.close() }
})

test('package knowledge and source instructions reach new and resumed Agents with only bounded readers', async () => {
  const pages = ['guide.md', 'prompts.md'].map(file => readFileSync(new URL('../knowledge/' + file, import.meta.url), 'utf8'))
  const text = pages.join('\n\n')
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32 * 1024)
  const revision = createHash('sha256').update(text).digest('hex').slice(0, 12)
  const f = await fixture({ mode: 'standalone', systemPrompt: '请优先给出 PowerShell 示例。' })
  try {
    const identity = await (await f.request('/identity')).json()
    expect(identity.knowledgeRevision).toBe(revision)
    const first = await f.request('/chat', { message: '独立仓库如何接入？' })
    const id = f.handles[0].id
    await first.body.cancel()
    await expect.poll(() => f.handles[0].disposed).toBe(true)
    const resumed = await f.request('/chat', { message: '第二个应用呢？', conversationId: id })
    for (const handle of f.handles) {
      expect(handle.sections.find(s => s.name === 'example:knowledge').text).toBe(`知识摘要 ${revision}\n\n${text}`)
      expect(handle.sections.find(s => s.name === 'example:developer').text).toContain('不能编造命令')
      expect(handle.sections.find(s => s.name === 'example:persona').text).toBe('请优先给出 PowerShell 示例。')
      const language = handle.sections.find(s => s.name === 'example:language')
      expect(language.text).toContain('reasoning_content')
      expect(language.text).toContain('不要先用英文分析')
      expect(language.order).toBeGreaterThan(Math.max(...handle.sections.filter(s => s.name !== language.name).map(s => s.order)))
      expect(handle.contexts.find(c => c.name === language.name).text).toContain('当前交互界面的语言是简体中文')
      expect(handle.allowed).toEqual(['example_search_framework', 'example_read_framework'])
      expect(handle.sections.find(s => s.name === 'example:framework').text).toContain('example_search_framework')
    }
    expect(f.handles).toHaveLength(2)
    await resumed.body.cancel()
  } finally { await f.close() }
})

test('platform entry and configuration questions receive current knowledge plus readable source evidence', async () => {
  const f = await fixture({ mode: 'standalone' })
  let response
  try {
    response = await f.request('/chat', { message: 'Windows、macOS、Linux 怎样运行 build？env.conf 哪些默认值已填？已有配置会被覆盖吗？' })
    const handle = f.handles[0]
    const knowledge = handle.sections.find(section => section.name === 'example:knowledge').text
    for (const fact of ['build.ps1', 'build.sh', 'DSH_IMAGE_PLATFORM=linux/amd64', '已有配置不覆盖', '手工复制公共模板不探测平台', '同 Docker 网络是信任边界', 'macOS 尚未完成真实 Docker 部署验收']) expect(knowledge).toContain(fact)
    const execution = { agent: handle.agent, signal: new AbortController().signal }
    const search = f.tools.get('example_search_framework'), read = f.tools.get('example_read_framework')
    for (const [path, expected] of [
      ['deploy/build.ps1', /scripts\/release\.mjs/],
      ['deploy/build.sh', /scripts\/release\.mjs/],
      ['env.conf', /DSH_PORT=7902/],
      ['deploy/scripts/site.mjs', /process\.getuid/],
      ['doc/framework-configuration.md', /已有.*不覆盖/],
      ['doc/first-deployment.md', /TCP 转发/],
    ]) {
      let found, offset = 0
      do {
        const page = JSON.parse(await search.execute({ query: path, offset }, execution))
        found = page.results.find(result => result.path === path)
        offset = page.nextOffset
      } while (!found && offset !== null)
      expect(found, `source search must find ${path}`).toBeDefined()
      let content = '', startLine = 1
      do {
        const page = JSON.parse(await read.execute({ path, startLine, lines: 100 }, execution))
        content += page.content + '\n'; startLine = page.nextLine
      } while (startLine !== null)
      expect(content, path).toMatch(expected)
      if (path === 'env.conf') {
        expect(content).toContain('DSH_CONTAINER_UID=1000')
        expect(content).toMatch(/DSH_IMAGE_PLATFORM="?linux\/amd64"?/)
        expect(content).toMatch(/DEEPSEEK_API_KEY=\s*(?:\n|$)/)
      }
    }
  } finally { await response?.body.cancel(); await f.close() }
})

test('selective rebuild questions reach the Agent with deployment and reuse boundaries', async () => {
  const f = await fixture({ mode: 'standalone' })
  let response
  try {
    response = await f.request('/chat', { message: '只改 C 能只构建 C 吗？也能指定 C、D，其他旧包自动复用吗？' })
    const knowledge = f.handles[0].sections.find(section => section.name === 'example:knowledge').text
    for (const fact of ['pnpm build --plugins c', 'pnpm package --plugins c,d', './build.sh --rebuild-plugins c', '.\\build.ps1 --rebuild-plugins c', '省略参数全量构建', '共享已跟踪文件', '传递关系校验', '不得靠安装钩子重建', 'prepared 后失败只用 `--resume`', '不是热更新']) expect(knowledge).toContain(fact)
    for (const fact of ['源码模式要求与基线一致的干净检出', '镜像模式核验同一摘要和旧成功记录的宿主提交', '不要求宿主源码存在', '最终镜像标签仍须一致']) expect(knowledge).toContain(fact)
    const faq = await f.request('/guide.md')
    expect(faq.status).toBe(200)
    expect(await faq.text()).toContain('新清单仍完整')
  } finally { await response?.body.cancel(); await f.close() }
})

test('current model, version and CI questions have source evidence in the shipped Agent tools', async () => {
  const f = await fixture({ mode: 'standalone' })
  let response
  try {
    response = await f.request('/chat', { message: '默认模型如何恢复？统一版本在哪配置，为什么会有六项或八项检查？' })
    const handle = f.handles[0]
    const knowledge = handle.sections.find(section => section.name === 'example:knowledge').text
    for (const fact of ['pending ?? lastUsed', '唯一版本源', '共六组检查', 'build/publish', 'doc/releases/', '读取或投影失败拒绝恢复']) expect(knowledge).toContain(fact)
    const execution = { agent: handle.agent, signal: new AbortController().signal }
    const search = f.tools.get('example_search_framework'), read = f.tools.get('example_read_framework')
    for (const [path, expected] of [
      ['packages/plugin-kit/src/models.ts', /state\.pending \?\? state\.lastUsed/],
      ['plugins/dsh-auth/src/models.ts', /saveSelection/],
      ['scripts/version.mjs', /versionTemplates/],
      ['.github/workflows/check.yml', /os: \[ubuntu-latest, windows-latest, macos-latest\]/],
      ['.github/workflows/release.yml', /tags: \['v\*'\]/],
      ['doc/versioning.md.tmpl', /\{\{FRAMEWORK_VERSION\}\}/],
    ]) {
      const hits = JSON.parse(await search.execute({ query: path }, execution))
      expect(hits.results.some(hit => hit.path === path), path).toBe(true)
      let content = '', startLine = 1
      do {
        const page = JSON.parse(await read.execute({ path, startLine, lines: 100 }, execution))
        expect(page.content).toMatch(/^\d+:/)
        content += page.content + '\n'; startLine = page.nextLine
      } while (startLine !== null)
      expect(content, path).toMatch(expected)
    }
  } finally { await response?.body.cancel(); await f.close() }
})
