/**
 * auth 目录页的排版回归：真的把页面跑起来，在三个视口宽度下量一遍。
 *
 * 插件页是浏览器原生模块，vitest/jsdom 覆盖不到布局；这条用例用 `scripts/web-page-probe.mjs`
 * 起静态服务 + 桩接口 + 无头 Chromium，把「一行最多三张、同一行不参差、说明两行封顶、
 * 不横向溢出」变成可重复的断言。没有可用 Chromium 时用例记成跳过（TAP 里显示 SKIP），
 * 不把跳过当成通过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { probePage } from '../../../../scripts/web-page-probe.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const pluginRoot = fileURLToPath(new URL('..', import.meta.url));

test('auth catalog page keeps its grid rules at every breakpoint', async t => {
  const result = await probePage({
    root: pluginRoot, prefix: '/auth',
    stub: `${here}page-stub.json`, probe: `${here}page-probe.js`,
    widths: '1150,860,640', settle: '1200',
  });
  if (result.skipped) {
    t.skip(`没有可用浏览器：${result.reason}`);
    return;
  }
  const byWidth = new Map(result.results.map(entry => [entry.width, entry.value]));
  for (const [width, value] of byWidth) {
    assert.equal(value.error, undefined, `视口 ${width}: ${value.error}`);
    assert.equal(value.pageOverflow, false, `视口 ${width} 出现横向溢出`);
    const rows = value.sections.flatMap(section => section.rows);
    assert.ok(rows.length > 0, `视口 ${width} 没有量到任何卡片行：桩数据或页面渲染出了问题`);
    for (const row of rows) {
      assert.ok(row.cards >= 1 && row.cards <= 3, `视口 ${width} 出现 ${row.cards} 张一行`);
      assert.equal(row.headSpread, 0, `视口 ${width} 同一行卡片头部错位`);
      assert.equal(row.footSpread, 0, `视口 ${width} 同一行卡片页脚错位`);
      assert.equal(row.overflow, false, `视口 ${width} 卡片内容横向溢出`);
      for (const lines of row.descriptionLines) assert.ok(lines <= 2, `视口 ${width} 说明渲染了 ${lines} 行（应为两行封顶）`);
    }
  }
  // 最宽处必须真的排满三张：否则「最多三张」这条约束可能只是没被数据触发。
  assert.ok(byWidth.get(1150).sections.some(section => section.rows.some(row => row.cards === 3)), '宽视口没有出现三张一行');
  // 最窄处回落成单列。
  assert.ok(byWidth.get(640).sections.flatMap(section => section.rows).every(row => row.cards === 1), '窄视口应回落成单列');
});
