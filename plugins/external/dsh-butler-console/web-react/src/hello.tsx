// 构建验证载体（批 0 实测项④）：被 app.tsx 以显式 `.tsx` 扩展名导入——仓库 NodeNext
// 纪律定型显式扩展名，oxc/rolldown 构建链同样解析（无扩展名形态也实测通过，见验收记录）。

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
