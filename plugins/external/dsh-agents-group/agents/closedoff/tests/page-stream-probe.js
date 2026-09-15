/**
 * 封闭化页面的「真的发一次提问」探针，配合 `scripts/web-page-probe.mjs` 使用。
 *
 * 前两个场景覆盖首屏与恢复对话，这一条覆盖**流式对话**：输入问题 → 点发送 → 桩接口按真实
 * 协议回一段 SSE（`conversation`／`thinking_snapshot`／`tool_start`／`cards`／`tool_end`／
 * `delta`／`done`）→ 等回答收完，把这一路上渲染出来的工具行与卡片量下来。
 *
 * 它守的是 app.js 流式分支里的调用点（工具行、缓存写入、卡片刷新、收尾），这是页面里
 * 唯一没有别的手段能覆盖的一段；搬动卡片层前后都应该跑它。
 */
const text = node => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const $ = selector => document.querySelector(selector);
const status = () => text($('#statusText'));

async function waitFor(check, tries = 80, every = 100) {
  for (let i = 0; i < tries; i++) {
    let value;
    try { value = check(); } catch { value = null; }
    if (value) return value;
    await sleep(every);
  }
  return null;
}

const ready = await waitFor(() => status() === '智能体就绪');
const input = $('#input');
input.value = '查一下今天的预警报警';
input.dispatchEvent(new Event('input', { bubbles: true }));
$('#sendBtn').click();

// 回答收完的标志：状态回到就绪、卡片已渲染、按钮从「停止」恢复。
const finished = await waitFor(() => status() === '智能体就绪' && document.querySelectorAll('.mini-card').length > 0 && !$('#sendBtn').classList.contains('stop'));
await sleep(200);

const chips = [...document.querySelectorAll('.tool-chip')];
const cards = [...document.querySelectorAll('.mini-card')];
const assistant = document.querySelector('.msg.assistant .bubble');
return {
  ready: Boolean(ready),
  finished: Boolean(finished),
  statusText: status(),
  userBubbles: document.querySelectorAll('.msg.user, .bubble.user').length,
  welcomeText: text(document.querySelector('#inner .welcome')).slice(0, 20),
  askText: text(document.querySelector('.msg.user .bubble')).slice(0, 30),
  toolChips: chips.length,
  chipLabel: text(chips[0]?.querySelector('.tool-label')),
  chipStatus: text(chips[0]?.querySelector('.tool-status')),
  chipChrono: text(chips[0]?.querySelector('.tool-chrono')),
  thinkingText: text(document.querySelector('.reasoning-preview')),
  cardsBlocks: document.querySelectorAll('.cards-block').length,
  sectionTitles: [...document.querySelectorAll('.result-section-title')].map(text),
  cardsHead: text(document.querySelector('.cards-head')).slice(0, 40),
  miniCards: cards.length,
  firstCardRows: cards[0] ? cards[0].querySelectorAll('.mc-row').length : 0,
  cardText: text(cards[0]).slice(0, 60),
  answerText: text(assistant?.querySelector('.md')).slice(0, 60),
  actionsHidden: assistant?.querySelector('.assistant-actions')?.hidden ?? null,
  pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
};
