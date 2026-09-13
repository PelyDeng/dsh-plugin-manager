/**
 * 封闭化助手页面的回归：真的把页面跑起来（静态服务 + 桩接口 + 注入宿主配置 + 无头 Chromium）。
 *
 * 两个场景：没有 conversationId 时的欢迎页，以及带上 conversationId 时恢复出来的对话 ——
 * 后者会走到工具卡片渲染（`.cards-block` / `.mini-card` / `.mc-row`），这也是后续拆分
 * app.js 卡片层时的安全网。
 *
 * 页面脚本是构建产物（`web/assets` 由 `pnpm build:web` 生成），`pnpm test` 会先跑这一步。
 * 产物缺失属于构建问题，直接失败；机器上没有可用 Chromium 时才记成跳过（TAP 里显示 SKIP），
 * 两者都不假装通过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { probePage } from '../../../../../scripts/web-page-probe.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const conversation = 'closedoff-web-12345678-1234-4123-8123-123456789012';

async function probe(t, options) {
  const assets = `${pluginRoot}web/assets`;
  assert.ok(existsSync(`${assets}/app.js`), `页面产物不存在，先运行 pnpm --filter @dsh-agents-group/closedoff run build:web（缺少 ${assets}/app.js）`);
  const result = await probePage({
    root: pluginRoot, prefix: '/closedoff-qa', mount: [`/closedoff-qa/assets=${assets}`],
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
    assert.equal(value.error, undefined, `视口 ${width}: ${value.error}`);
    assert.equal(value.routePrefix, '/closedoff-qa', `视口 ${width} 注入的宿主配置没生效`);
    assert.equal(value.hasShell, true, `视口 ${width} 页面壳没有渲染`);
    assert.ok(value.welcomeText.length > 0, `视口 ${width} 欢迎语没有渲染`);
    assert.equal(value.cardsBlocks, 0, `视口 ${width} 没有对话时不该出现卡片`);
    assert.equal(value.pageOverflow, false, `视口 ${width} 出现横向溢出`);
  }
});

test('a restored conversation renders its tool card at every width', async t => {
  const result = await probe(t, { widths: '1280,860,640', page: `/closedoff-qa/?conversationId=${conversation}` });
  if (!result) return;
  for (const { width, value } of result.results) {
    assert.equal(value.error, undefined, `视口 ${width}: ${value.error}`);
    assert.equal(value.welcomeText, '', `视口 ${width} 恢复对话时不该再显示欢迎页`);
    assert.equal(value.cardsBlocks, 1, `视口 ${width} 工具卡片块没有渲染`);
    assert.equal(value.miniCards, 1, `视口 ${width} 卡片没有渲染`);
    assert.equal(value.firstCardRows, 3, `视口 ${width} 卡片字段行数不对：${value.cardText}`);
    assert.ok(value.cardText.includes('预警等级') && value.cardText.includes('某化工企业'), `视口 ${width} 卡片内容不对：${value.cardText}`);
    assert.equal(value.pageOverflow, false, `视口 ${width} 出现横向溢出`);
  }
});
