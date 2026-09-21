// 构建验证载体（批 0 实测项④）：被 app.tsx 以无扩展名 `./hello` 导入，
// 验证 tsdown/oxc 的无扩展名 import 能解析到 .tsx。

interface HelloProps {
  config: Record<string, unknown> | null
}

export function Hello({ config }: HelloProps) {
  const configText = config === null
    ? '（mock 下无 __BUTLER_CONFIG__，属预期之外——mock 服务需注入）'
    : Object.entries(config).map(([key, value]) => `${key}=${String(value)}`).join(' · ')
  return (
    <div className="bt-hello paper">
      <h1 className="bt-hello__title">牛马台账 · React 19</h1>
      <p className="bt-hello__note">
        批 0 技术验证页：tsdown/oxc 构建 → mock 服务 → 浏览器渲染 三链路绿。
      </p>
      <p className="bt-hello__config bt-hello__config--mono">{configText}</p>
    </div>
  )
}
