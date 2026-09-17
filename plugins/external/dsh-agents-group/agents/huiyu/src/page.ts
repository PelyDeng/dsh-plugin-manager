/**
 * 绘语的页面。
 *
 * ## 为什么是一个说明页而不是对话界面
 *
 * 绘语的真实入口是**牛马大总管的派活**与官方控制台的对话，两者都已有各自的界面与历史管理。
 * 再做一个对话界面等于把"会话列表、分支、反馈"这套机制复制一份，而那是运行时与控制台已经
 * 实现过的（也是本项目明确要避免的重复）。
 *
 * 所以这个页面的职责只有三件：确认成员在册、说明它能做什么、给出正确的使用入口。
 *
 * ## 服务端渲染而不是打包静态资源
 *
 * 页面内容是固定的，没有需要交互的状态。为它建一套 `web/` 资源 + 拷贝脚本 + 资源路由，
 * 换来的是"改一行文案要动四个文件"。等这个页面真的需要交互时再拆出去。
 *
 * 样式沿用群组内其他成员页面的观感（中性色、卡片、系统字体），不引外部资源——页面在离线
 * 部署里也要能正常显示。
 */

import type { HuiyuEnvironment } from './env.ts'

/** 一次渲染所需的运行状态。 */
export interface PageState {
  /** 未就绪的原因；就绪时为 undefined。 */
  readonly unavailable?: string
  /** 已生效的配置；未配置时为 undefined。它只用于展示**非敏感**信息。 */
  readonly environment?: HuiyuEnvironment
}

/** HTML 转义。页面里出现的所有动态值都要过它——未就绪原因来自配置解析，属于外部输入。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 可用的工具清单，按用途分组展示。 */
const TOOL_GROUPS: readonly { readonly title: string; readonly tools: readonly { readonly name: string; readonly about: string }[] }[] = [
  {
    title: '看懂图片',
    tools: [
      { name: 'huiyu_describe', about: '描述图里有什么' },
      { name: 'huiyu_extract', about: '抽取表格、发票、截图里的文字与数字' },
      { name: 'huiyu_compare', about: '对比多张图的差异' },
    ],
  },
  {
    title: '画出图片',
    tools: [
      { name: 'huiyu_draw', about: '按文字描述生成图片' },
      { name: 'huiyu_cover', about: '生成文章头图（横幅）' },
      { name: 'huiyu_illustrate', about: '给文章段落配图' },
    ],
  },
  {
    title: '素材',
    tools: [
      { name: 'huiyu_library', about: '翻看此前生成过的图片' },
      { name: 'huiyu_upload', about: '把上传的图登记进素材库' },
    ],
  },
]

/**
 * 渲染页面。
 *
 * @param state 运行状态；未就绪时页面顶部如实显示原因，而不是假装正常
 * @returns 完整的 HTML 文档
 */
export function renderPage(state: PageState): string {
  const ready = state.unavailable === undefined
  const status = ready
    ? '<p class="status ok">已就绪</p>'
    : `<p class="status bad">暂不可用：${escapeHtml(state.unavailable as string)}</p>`

  // 只展示非敏感项：地址、桶名、模型名。密钥一律不出现。
  const facts: string[] = []
  if (state.environment !== undefined) {
    facts.push(`对象存储：<code>${escapeHtml(state.environment.minio.bucket)}</code> 桶`)
    facts.push(`图片访问前缀：<code>${escapeHtml(state.environment.minio.publicBaseUrl)}</code>`)
    facts.push(`生图模型：<code>${escapeHtml(state.environment.image.model)}</code>`)
  }

  const groups = TOOL_GROUPS.map(group => `
      <section>
        <h3>${escapeHtml(group.title)}</h3>
        <ul>
          ${group.tools.map(tool => `<li><code>${escapeHtml(tool.name)}</code><span>${escapeHtml(tool.about)}</span></li>`).join('\n          ')}
        </ul>
      </section>`).join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>绘语（图片智能体）</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 20px 56px; font: 15px/1.7 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #1f2328; background: #f6f7f9; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { margin: 0 0 4px; font-size: 24px; }
  h2 { margin: 32px 0 12px; font-size: 16px; }
  h3 { margin: 0 0 8px; font-size: 14px; color: #57606a; font-weight: 600; }
  .lead { margin: 0 0 16px; color: #57606a; }
  .card { background: #fff; border: 1px solid #d8dee4; border-radius: 10px; padding: 18px 20px; margin-bottom: 16px; }
  .status { margin: 0 0 16px; padding: 8px 12px; border-radius: 8px; font-size: 14px; }
  .status.ok { background: #dafbe1; color: #116329; }
  .status.bad { background: #fff1e5; color: #9a3412; }
  ul { margin: 0; padding: 0; list-style: none; }
  li { display: flex; gap: 10px; padding: 5px 0; align-items: baseline; }
  code { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #eff1f3; padding: 1px 6px; border-radius: 5px; white-space: nowrap; }
  li span { color: #57606a; font-size: 14px; }
  .facts { margin: 0; padding: 0; list-style: none; }
  .facts li { display: block; padding: 3px 0; color: #57606a; font-size: 14px; }
  a { color: #0969da; }
  footer { margin-top: 32px; color: #8c959f; font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>绘语</h1>
  <p class="lead">图片智能体：看懂图片，也画得出图片。</p>
  ${status}

  <div class="card">
    <h2 style="margin-top:0">怎么用它</h2>
    <p style="margin:0">绘语由牛马大总管派活，也可以在官方控制台的对话里直接使用。本页只说明能力，不承载对话——会话列表、分支与反馈由控制台统一管理。</p>
  </div>

  ${facts.length === 0 ? '' : `<div class="card"><h2 style="margin-top:0">运行信息</h2><ul class="facts">${facts.map(fact => `<li>${fact}</li>`).join('')}</ul></div>`}

  <h2>能做什么</h2>
  ${groups}

  <footer>绘语（huiyu）· 智能体群组成员</footer>
</main>
</body>
</html>
`
}
