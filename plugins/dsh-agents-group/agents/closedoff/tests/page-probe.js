/**
 * 封闭化助手页面的结构探针，配合 `scripts/web-page-probe.mjs` 使用：
 *
 *   node scripts/web-page-probe.mjs --root plugins/dsh-agents-group/agents/closedoff \
 *     --prefix /closedoff-qa --mount /closedoff-qa/assets=plugins/dsh-agents-group/agents/closedoff/web/assets \
 *     --replace __WEB_CONFIG__=plugins/dsh-agents-group/agents/closedoff/tests/page-config.json \
 *     --stub plugins/dsh-agents-group/agents/closedoff/tests/page-stub.json \
 *     --probe plugins/dsh-agents-group/agents/closedoff/tests/page-probe.js
 *
 * 页面壳由宿主注入配置后才可用（`__WEB_CONFIG__` → routePrefix 与地图配置），三份夹具
 * 分别负责配置、接口桩与这份探针。探针只断言「壳起来了、欢迎语在、没有横向溢出」这类
 * 稳定事实，不锁具体文案，免得每改一句话都要改用例。
 */
const text = node => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
const inner = document.querySelector('#inner');
const welcome = inner?.querySelector('.bubble') ?? inner?.firstElementChild ?? null;
return {
  routePrefix: window.CLOSEDOFF_CONFIG?.routePrefix ?? null,
  hasShell: Boolean(document.querySelector('#messages') && document.querySelector('#input') && document.querySelector('#sendBtn')),
  statusText: text(document.querySelector('#statusText')),
  welcomeText: text(welcome).slice(0, 40),
  welcomeChildren: inner ? inner.children.length : -1,
  historyButton: Boolean(document.querySelector('#historyBtn')),
  pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
};
