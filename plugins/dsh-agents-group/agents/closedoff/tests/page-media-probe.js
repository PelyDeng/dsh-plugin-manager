/**
 * 抓拍视频卡片 → 摄像头弹窗的探针，配合 `scripts/web-page-probe.mjs` 使用。
 *
 * 桩里这次查询除报警卡片外还返回一段 `media`（车辆抓拍视频），页面因此渲染出「查看抓拍视频」
 * 按钮；点它会走 `trajectory.showGroup({ captureMode: true, ... })` 打开弹窗。**这条路径不需要
 * Cesium**：弹窗是纯 DOM，所以能在这里真跑一遍，给「把弹窗拆成独立模块」当安全网。
 *
 * 量三组事实：卡片上的按钮、点开弹窗后的标题/统计/信息行、关闭后的状态。
 */
const text = node => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const $ = selector => document.querySelector(selector);

async function waitFor(check, tries = 80, every = 100) {
  for (let i = 0; i < tries; i++) {
    let value;
    try { value = check(); } catch { value = null; }
    if (value) return value;
    await sleep(every);
  }
  return null;
}

const ready = await waitFor(() => text($('#statusText')) === '智能体就绪');
$('#input').value = '查一下今天的预警报警';
$('#input').dispatchEvent(new Event('input', { bubbles: true }));
$('#sendBtn').click();
// 按卡片正文定位按钮：`.track-3d-btn` 在页面别处（三维查看）也有，直接选第一个会点错。
const captureCard = await waitFor(() => [...document.querySelectorAll('.mini-card')].find(card => text(card).includes('抓拍片段')));
const button = captureCard ? captureCard.querySelector('button') : null;
await waitFor(() => !$('#sendBtn').classList.contains('stop'));
await sleep(150);

const cards = [...document.querySelectorAll('.mini-card')];
const before = {
  ready: Boolean(ready),
  hasButton: Boolean(button),
  buttonText: text(button),
  cardsBlocks: document.querySelectorAll('.cards-block').length,
  miniCards: cards.length,
  sectionTitles: [...document.querySelectorAll('.result-section-title')].map(text),
  captureCardText: text(captureCard).slice(0, 40),
};

button.click();
await sleep(300);
const overlay = $('#cameraModal');
const infoRows = [...document.querySelectorAll('#cameraInfo .camera-info-row')].map(row => text(row));
const open = {
  visible: overlay.style.display !== 'none',
  captureMode: overlay.classList.contains('capture-mode'),
  title: text($('#cameraModalTitle')),
  stats: text($('#cameraStats')),
  selectedName: text($('#cameraSelectedName')),
  infoRows: infoRows.length,
  infoText: infoRows.join(' | ').slice(0, 120),
  focused: document.activeElement?.id ?? '',
  pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
};

$('#cameraModalClose').click();
await sleep(150);
const closed = { visible: $('#cameraModal').style.display !== 'none', pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };

return { ...before, open, closed, statusText: text($('#statusText')) };
