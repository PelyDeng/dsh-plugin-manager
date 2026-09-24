/**
 * 群组二期批 0 hello 页（临时验证面，批 1 工作台骨架落地后删除）。
 *
 * 验证五件事：React 挂载、Icon（Lucide 内联）、RichText（受控渲染飞地）、
 * textures 材质基元（纸感卡 + 胶带 + 贴纸）、overrides 的墨线虚线焦点环
 * （按钮 Tab 聚焦可见）与手账 token/字体落位。
 */
import { announce, Icon, RichText } from '@dsh-agents-group/web-common'
import { useState } from 'react'

const SAMPLE_MARKDOWN = [
  '这是 **RichText 受控渲染**的样张：',
  '',
  '- 粗体与`行内代码`只进白名单标签',
  '- 群组基元层（web-common）已随构建内联',
  '',
  '```js',
  'const hello = "封闭化管理智能助手"',
  '```',
].join('\n')

export function App() {
  const [flashed, setFlashed] = useState(false)
  return (
    <main className="bt-page">
      {/* 纸感卡：textures 基元（paper 墨线勾边 + 胶带按角），批 1 工作台沿用同族材质。 */}
      <section className="paper" style={{ padding: '28px 32px', maxWidth: 560 }}>
        <span className="bt-tape" style={{ top: -10, left: 28, width: 76, transform: 'rotate(-5deg)' }} aria-hidden="true" />
        <h1 style={{ margin: '0 0 6px', fontFamily: 'var(--bt-hand)', fontSize: 28, fontWeight: 700 }}>
          <Icon name="check" size={22} /> 封闭化管理智能助手 · React hello
        </h1>
        <p className="section-title" style={{ fontSize: 16, marginBottom: 14 }}>材质基元已解构定型</p>
        <RichText text={SAMPLE_MARKDOWN} variant="ask" />
        <p style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            className="btn btn--amber"
            onClick={() => {
              setFlashed(true)
              announce('基元层按钮已点击')
              window.setTimeout(() => setFlashed(false), 1200)
            }}
          >
            <Icon name="sparkles" size={14} /> 点我验证焦点环
          </button>
          {flashed && <span className="sticker">操作已送达 ✓</span>}
        </p>
      </section>
      {/* announce() 的读屏播报区：容器常驻（live region 节点不卸载）。 */}
      <div id="sr-status" className="visually-hidden" role="status" aria-live="polite" />
    </main>
  )
}
