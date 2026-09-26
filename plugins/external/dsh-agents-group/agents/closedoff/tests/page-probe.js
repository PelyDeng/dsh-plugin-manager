/**
 * 封闭化助手页面的结构探针，配合 `scripts/web-page-probe.mjs` 使用（见 page-layout.node.mjs）。
 *
 * 报告 React 页面的事实量：挂载状态（#root 子节点）、注入的宿主配置（routePrefix）、
 * 横向溢出与欢迎页（.co-welcome）进出。断言放在用例里，探针只负责把事实量出来。
 */
return {
  routePrefix: window.CLOSEDOFF_CONFIG?.routePrefix ?? null,
  pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  reactMounted: (document.querySelector('#root')?.childElementCount ?? 0) > 0,
  reactWelcome: document.querySelector('.co-welcome') !== null,
};
