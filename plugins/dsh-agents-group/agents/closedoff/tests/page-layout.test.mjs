/**
 * 封闭化助手页面的回归：真的把页面跑起来（静态服务 + 桩接口 + 注入宿主配置 + 无头 Chromium），
 * 断言壳起来了、欢迎语渲染了、各宽度都不横向溢出。
 *
 * 页面脚本是构建产物（`web/assets` 由 `pnpm build` 生成），所以这里在产物缺失时**明确跳过**并
 * 说明原因，不假装通过；先 `pnpm build` 再跑就能覆盖到。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { probePage } from '../../../../../scripts/web-page-probe.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const pluginRoot = fileURLToPath(new URL('..', import.meta.url));

test('the closedoff page boots with injected config and keeps its shell at every width', async t => {
  const assets = `${pluginRoot}web/assets`;
  if (!existsSync(`${assets}/app.js`)) {
    t.diagnostic(`跳过：页面产物不存在（先运行 pnpm --filter @dsh-agents-group/closedoff run build），当前缺少 ${assets}/app.js`);
    return;
  }
  const result = await probePage({
    root: pluginRoot, prefix: '/closedoff-qa',
    mount: [`/closedoff-qa/assets=${assets}`],
    replace: [`__WEB_CONFIG__=${here}page-config.json`],
    stub: `${here}page-stub.json`, probe: `${here}page-probe.js`,
    widths: '1280,860,640', settle: '1500',
  });
  if (result.skipped) {
    t.diagnostic(`跳过：${result.reason}`);
    return;
  }
  for (const { width, value } of result.results) {
    assert.equal(value.error, undefined, `视口 ${width}: ${value.error}`);
    assert.equal(value.routePrefix, '/closedoff-qa', `视口 ${width} 注入的宿主配置没生效`);
    assert.equal(value.hasShell, true, `视口 ${width} 页面壳没有渲染`);
    assert.ok(value.welcomeChildren > 0 && value.welcomeText.length > 0, `视口 ${width} 欢迎语没有渲染：${value.welcomeText}`);
    assert.equal(value.pageOverflow, false, `视口 ${width} 出现横向溢出`);
  }
});
