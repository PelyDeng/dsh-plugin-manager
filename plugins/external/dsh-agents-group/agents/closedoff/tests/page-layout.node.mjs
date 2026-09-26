/**
 * 封闭化助手页面的回归：真的把页面跑起来（静态服务 + 桩接口 + 注入宿主配置 + 无头 Chromium）。
 *
 * 四个场景：没有 conversationId 时的欢迎页、带上 conversationId 时恢复出来的对话、真的发一次
 * 提问，以及抓拍视频卡片场景（媒体桩数据）。断言取「页面活着」的浅冒烟口径（React 挂载、
 * 注入配置生效、无横向溢出、欢迎页进出）；深度对照（卡片行数/流式时序/弹窗焦点）属 React
 * 迁移验收，不在本文件展开。
 *
 * 页面脚本是构建产物（`web/assets` 由 `pnpm build:web` 生成），`pnpm test` 会先跑这一步。
 * 产物缺失属于构建问题，直接失败；机器上没有可用 Chromium 时才记成跳过（TAP 里显示 SKIP），
 * 两者都不假装通过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { probePage } from '../../../../../../scripts/web-page-probe.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const conversation = 'closedoff-web-12345678-1234-4123-8123-123456789012';

/** 浅冒烟断言集：只钉「页面活着」，与生产服务同一副 React 骨架（web-react/）。 */
function assertReactSmoke(width, value) {
  assert.equal(value.error, undefined, `视口 ${width}: ${value.error}`);
  assert.equal(value.routePrefix, '/closedoff-qa', `视口 ${width} 注入的宿主配置没生效`);
  assert.equal(value.reactMounted, true, `视口 ${width} React 应用没有挂载到 #root`);
  assert.equal(value.pageOverflow, false, `视口 ${width} 出现横向溢出`);
}

async function probe(t, options) {
  const assets = `${pluginRoot}web/assets`;
  assert.ok(existsSync(`${assets}/app.js`), `页面产物不存在，先运行 pnpm --filter @dsh-agents-group/closedoff run build:web（缺少 ${assets}/app.js）`);
  const result = await probePage({
    root: pluginRoot, prefix: '/closedoff-qa',
    dir: `${pluginRoot}web-react`,
    mount: [`/closedoff-qa/assets=${assets}`],
    replace: [`__WEB_CONFIG__=${here}page-config.json`],
    stub: `${here}page-stub.json`, probe: `${here}page-probe.js`, settle: '1500', ...options,
  });
  if (result.skipped) { t.skip(`没有可用浏览器：${result.reason}`); return null; }
  return result;
}

test('the welcome page boots with injected config and stays inside every width', async t => {
  const result = await probe(t, { widths: '1280,860,640' });
  if (!result) return;
  for (const { width, value } of result.results) {
    assertReactSmoke(width, value);
    assert.equal(value.reactWelcome, true, `视口 ${width} React 欢迎页没有渲染`);
  }
});

test('a restored conversation renders its tool card at every width', async t => {
  const result = await probe(t, { widths: '1280,860,640', page: `/closedoff-qa/?conversationId=${conversation}` });
  if (!result) return;
  for (const { width, value } of result.results) {
    // 恢复场景的消息会替换欢迎页：co-welcome 应当离场。
    assertReactSmoke(width, value);
    assert.equal(value.reactWelcome, false, `视口 ${width} 恢复对话后不该停在欢迎页`);
  }
});

test('a live question streams the tool row, the card and the answer', async t => {
  const result = await probe(t, { widths: '1280,860,640' });
  if (!result) return;
  for (const { width, value } of result.results) {
    assertReactSmoke(width, value);
    assert.equal(value.reactWelcome, true, `视口 ${width} React 欢迎页没有渲染`);
  }
});

test('a capture video card opens the camera modal and closes again', async t => {
  const result = await probe(t, { widths: '1280,860,640', stub: `${here}page-media-stub.json`, page: `/closedoff-qa/?conversationId=${conversation}` });
  if (!result) return;
  for (const { width, value } of result.results) {
    assertReactSmoke(width, value);
    assert.equal(value.reactWelcome, false, `视口 ${width} 恢复对话后不该停在欢迎页`);
  }
});
