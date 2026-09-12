/**
 * 博客工作台在群组里的适配层。
 *
 * 与 closedoff 的适配层同构：补上公共字段、把业务配置从群组级配置文件翻译成子包认识的
 * 形状、接出释放函数。业务代码全在 `agents/blog/` 里。
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config as BlogConfigSchema, mount, type PluginConfig } from '../../agents/blog/src/index.ts'
import type { AgentMount } from '../host.ts'
import { endpointsOf } from './registry.ts'

/**
 * 把群组配置里的 `blog` 小节写成一份临时 JSON 文件，交给子包原有的 loadSettings 读取。
 *
 * 为什么要绕这一步：blog 的业务配置（Typecho 地址、图床、备份、模型路由）本来由
 * `BLOG_CONFIG_PATH` 指向一份 JSON 文件，`loadSettings` 负责校验它。群组只能有一个
 * runtimeConfig，所以这份文件现在由群组配置的 `blog` 小节承载；在内存里翻译成子包
 * 期望的形状，校验规则就仍然只有一份实现。
 *
 * 返回 undefined 表示群组配置里没有 `blog` 小节，此时子包回落到旧来源。
 */
function materializeSettings(groupConfigPath: string | undefined): string | undefined {
  if (groupConfigPath === undefined || groupConfigPath === '') return undefined
  let raw: string
  try {
    // 同步读取：适配层在装载前就要决定交给子包的路径。
    raw = readFileSync(groupConfigPath, 'utf8')
  } catch {
    return undefined
  }
  let section: unknown
  try {
    section = (JSON.parse(raw) as Record<string, unknown>).blog
  } catch {
    return undefined
  }
  if (section === undefined || section === null || typeof section !== 'object') return undefined
  const file = join(mkdtempSync(join(tmpdir(), 'agents-group-blog-')), 'settings.json')
  writeFileSync(file, JSON.stringify(section))
  return file
}

/** 装载博客工作台。 */
export const mountBlog: AgentMount = async context => {
  const entryPath = endpointsOf(context.manifest, context.config.routePrefix, context.config.accessMode).entryPath
  const defaults = { ...(BlogConfigSchema.meta.default as PluginConfig) }
  const settingsPath = materializeSettings(context.groupConfigPath)
  const config: PluginConfig = {
    ...defaults,
    ...(context.agentConfig as Partial<PluginConfig>),
    routePrefix: entryPath,
    publicOrigin: context.config.publicOrigin,
    accessMode: 'authenticated',
    // 子包用 runtimeConfig 表示「业务配置文件在哪」；群组已把它翻译好。
    ...(settingsPath === undefined ? {} : { runtimeConfig: settingsPath }),
  }

  const instance = await mount({
    ctx: context.ctx,
    access: context.access,
    http: context.http,
    config,
    category: context.category,
    ...(context.groupConfigPath === undefined ? {} : { groupConfigPath: context.groupConfigPath }),
  })

  return { tools: instance.tools, participant: instance.participant, dispose: instance.dispose }
}
