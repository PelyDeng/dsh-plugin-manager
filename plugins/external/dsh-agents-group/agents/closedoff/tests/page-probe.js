/**
 * 封闭化助手页面的结构探针，配合 `scripts/web-page-probe.mjs` 使用（见 page-layout.node.mjs）。
 *
 * 同时报告两种场景的事实：没有 conversationId 时的欢迎页，以及带上 conversationId 时
 * 恢复出来的对话（含工具卡片）。断言放在用例里，探针只负责把事实量出来。
 *
 * 双轨同测：React 轨的挂载点与欢迎页 class 与旧轨不同（#root / .co-welcome），一并量出；
 * 旧轨页面上这两个选择器不存在，恒为 false/null，不影响旧轨断言。
 */
const text = node => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
const inner = document.querySelector('#inner');
const cards = [...document.querySelectorAll('.mini-card')];
return {
  routePrefix: window.CLOSEDOFF_CONFIG?.routePrefix ?? null,
  hasShell: Boolean(document.querySelector('#messages') && document.querySelector('#input') && document.querySelector('#sendBtn')),
  statusText: text(document.querySelector('#statusText')),
  welcomeText: text(inner?.querySelector('.welcome')).slice(0, 40),
  welcomeChildren: inner ? inner.children.length : -1,
  userBubbles: document.querySelectorAll('.bubble.user, .msg.user').length,
  cardsBlocks: document.querySelectorAll('.cards-block').length,
  miniCards: cards.length,
  firstCardRows: cards[0] ? cards[0].querySelectorAll('.mc-row').length : 0,
  cardText: text(cards[0]).slice(0, 60),
  pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  reactMounted: (document.querySelector('#root')?.childElementCount ?? 0) > 0,
  reactWelcome: document.querySelector('.co-welcome') !== null,
};
