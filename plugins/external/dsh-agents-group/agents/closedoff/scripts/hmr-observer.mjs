/** Print module-HMR activity while the development overlay is active. */
export function apply(ctx) {
  console.error('[closedoff-dev] HMR observer active')
  ctx.on('hmr/change', url => console.error('[closedoff-dev] changed without module reload:', url))
  ctx.on('hmr/reload', reloads => console.error(`[closedoff-dev] reloaded ${reloads.size} plugin module(s)`))
}
