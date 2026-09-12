/**
 * 在开发模式下打印群组的模块重载活动。
 *
 * 只在 `dev/dev-hmr.patch.yml` 生效时装载，属于开发期工具，不随发布归档交付。
 * 作用是把「哪个子包的改动被重载了」显示在控制台，方便确认 HMR 真的指到了你正在改的
 * 那份源码，而不是安装好的旧包。
 */
export function apply(ctx) {
  console.error('[agents-group-dev] HMR 观察器已启用')
  ctx.on('hmr/change', url => {
    console.error(`[agents-group-dev] 文件变化但未触发模块重载：${url}`)
  })
  ctx.on('hmr/reload', reloads => {
    console.error(`[agents-group-dev] 已重载 ${reloads.size} 个插件模块`)
  })
}
