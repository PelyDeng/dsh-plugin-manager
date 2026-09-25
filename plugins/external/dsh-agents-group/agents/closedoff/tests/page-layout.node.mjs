/**
 * 封闭化助手页面的回归：真的把页面跑起来（静态服务 + 桩接口 + 注入宿主配置 + 无头 Chromium）。
 *
 * 四个场景：没有 conversationId 时的欢迎页、带上 conversationId 时恢复出来的对话、**真的发一次
 * 提问**走完整条流式分支（工具行 → 卡片 → 回答 → 收尾），以及**抓拍视频卡片点开摄像头弹窗**
 * （弹窗是纯 DOM，不需要 Cesium，因此这条也是拆 trajectory.js 弹窗层时的安全网）。
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
// 产品轨判定与 src/web.ts、copy-web-assets.mjs 同一条 existsSync 口径：dist/web/app.js
// 只由 React 构建链产出。骨架（web-react vs web）与 web/assets 的落位都按这一开关走，
// 这里据它选页面骨架与断言集，探针 harness 与产品服务才不会各跑各的轨。
const reactTrack = existsSync(`${pluginRoot}dist/web/app.js`);

/** React 轨浅冒烟：深度对照（卡片行数/流式时序/弹窗焦点）属 React 迁移验收，这里只钉「页面活着」。 */
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
    // 骨架跟产品轨走：React 轨服务 web-react（含 #root 挂载点），旧轨照旧默认 web/。
    ...(reactTrack ? { dir: `${pluginRoot}web-react` } : {}),
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
    if (reactTrack) {
      // React 轨只断言 co-welcome 在场（深度对照属 React 迁移验收）。
      assertReactSmoke(width, value);
      assert.equal(value.reactWelcome, true, `视口 ${width} React 欢迎页没有渲染`);
      continue;
    }
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
    if (reactTrack) {
      // 恢复场景的消息会替换欢迎页：co-welcome 应当离场。
      assertReactSmoke(width, value);
      assert.equal(value.reactWelcome, false, `视口 ${width} 恢复对话后不该停在欢迎页`);
      continue;
    }
    assert.equal(value.error, undefined, `视口 ${width}: ${value.error}`);
    assert.equal(value.welcomeText, '', `视口 ${width} 恢复对话时不该再显示欢迎页`);
    assert.equal(value.cardsBlocks, 1, `视口 ${width} 工具卡片块没有渲染`);
    assert.equal(value.miniCards, 1, `视口 ${width} 卡片没有渲染`);
    assert.equal(value.firstCardRows, 3, `视口 ${width} 卡片字段行数不对：${value.cardText}`);
    assert.ok(value.cardText.includes('预警等级') && value.cardText.includes('某化工企业'), `视口 ${width} 卡片内容不对：${value.cardText}`);
    assert.equal(value.pageOverflow, false, `视口 ${width} 出现横向溢出`);
  }
});

test('a live question streams the tool row, the card and the answer', async t => {
  const result = await probe(t, reactTrack
    // React 轨没有流式量测探针：浅冒烟（欢迎页在场即可），深度流式对照属 React 迁移验收。
    ? { widths: '1280,860,640' }
    : { widths: '1280,860,640', probe: `${here}page-stream-probe.js`, settle: '1200', budget: '8000' });
  if (!result) return;
  for (const { width, value } of result.results) {
    if (reactTrack) {
      assertReactSmoke(width, value);
      assert.equal(value.reactWelcome, true, `视口 ${width} React 欢迎页没有渲染`);
      continue;
    }
    assert.equal(value.error, undefined, `视口 ${width}: ${value.error}`);
    assert.equal(value.ready, true, `视口 ${width} 页面没有进入就绪状态：${value.statusText}`);
    assert.equal(value.finished, true, `视口 ${width} 回答没有收完（状态停在「${value.statusText}」）`);
    assert.equal(value.userBubbles, 1, `视口 ${width} 提问没有渲染出来`);
    assert.ok(value.askText.includes('预警报警'), `视口 ${width} 提问内容不对：${value.askText}`);
    assert.equal(value.toolChips, 1, `视口 ${width} 工具行没有渲染`);
    assert.ok(value.chipLabel.includes('预警'), `视口 ${width} 工具中文名不对：${value.chipLabel}`);
    assert.equal(value.chipStatus, '已完成', `视口 ${width} 工具行状态不对：${value.chipStatus}`);
    assert.ok(value.chipChrono.startsWith('·'), `视口 ${width} 工具行没有显示耗时：${value.chipChrono}`);
    assert.ok(value.thinkingText.includes('过滤'), `视口 ${width} 思考过程没有渲染：${value.thinkingText}`);
    assert.equal(value.cardsBlocks, 1, `视口 ${width} 卡片块没有渲染`);
    assert.deepEqual(value.sectionTitles, ['风险'], `视口 ${width} 结果分组不对：${value.sectionTitles}`);
    assert.equal(value.miniCards, 1, `视口 ${width} 卡片没有渲染`);
    assert.equal(value.firstCardRows, 3, `视口 ${width} 卡片字段行数不对：${value.cardText}`);
    assert.ok(value.cardText.includes('预警等级') && value.cardText.includes('某化工企业'), `视口 ${width} 卡片内容不对：${value.cardText}`);
    assert.ok(value.answerText.includes('1 条报警'), `视口 ${width} 回答正文不对：${value.answerText}`);
    assert.equal(value.actionsHidden, false, `视口 ${width} 回答操作没有出现`);
    assert.equal(value.pageOverflow, false, `视口 ${width} 出现横向溢出`);
  }
});

test('a capture video card opens the camera modal and closes again', async t => {
  const result = await probe(t, reactTrack
    // React 轨没有弹窗量测探针：浅冒烟（恢复对话不炸、欢迎页离场），深度弹窗对照属 React 迁移验收。
    ? { widths: '1280,860,640', stub: `${here}page-media-stub.json`, page: `/closedoff-qa/?conversationId=${conversation}` }
    : { widths: '1280,860,640', stub: `${here}page-media-stub.json`, probe: `${here}page-media-probe.js`, settle: '1200', budget: '8000' });
  if (!result) return;
  for (const { width, value } of result.results) {
    if (reactTrack) {
      assertReactSmoke(width, value);
      assert.equal(value.reactWelcome, false, `视口 ${width} 恢复对话后不该停在欢迎页`);
      continue;
    }
    assert.equal(value.error, undefined, `视口 ${width}: ${value.error}`);
    assert.equal(value.ready, true, `视口 ${width} 页面没有进入就绪状态`);
    assert.equal(value.hasButton, true, `视口 ${width} 抓拍卡片上没有按钮：${value.captureCardText}`);
    assert.equal(value.buttonText, '查看抓拍视频', `视口 ${width} 按钮文案不对：${value.buttonText}`);
    assert.deepEqual(value.sectionTitles, ['轨迹与设备', '风险'], `视口 ${width} 结果分组不对：${value.sectionTitles}`);
    assert.equal(value.miniCards, 2, `视口 ${width} 卡片数不对：${value.miniCards}`);
    // 点开弹窗：抓拍模式、标题、选中的片段与四行信息都来自桩数据。
    assert.equal(value.open.visible, true, `视口 ${width} 摄像头弹窗没有打开`);
    assert.equal(value.open.captureMode, true, `视口 ${width} 弹窗没有进入抓拍模式`);
    assert.equal(value.open.title, '车辆抓拍视频', `视口 ${width} 弹窗标题不对：${value.open.title}`);
    assert.equal(value.open.selectedName, '抓拍片段', `视口 ${width} 选中的片段不对：${value.open.selectedName}`);
    assert.equal(value.open.infoRows, 4, `视口 ${width} 信息行数不对：${value.open.infoText}`);
    assert.ok(value.open.infoText.includes('CAM-9') && value.open.infoText.includes('00:00:12'), `视口 ${width} 信息内容不对：${value.open.infoText}`);
    assert.ok(value.open.infoText.includes('媒体地址已隐藏'), `视口 ${width} 抓拍片段的媒体地址不该直接显示：${value.open.infoText}`);
    assert.equal(value.open.focused, 'cameraModalClose', `视口 ${width} 打开弹窗后焦点没有落到关闭按钮`);
    assert.equal(value.open.pageOverflow, false, `视口 ${width} 弹窗打开时出现横向溢出`);
    // 关闭后回到页面上，不留遮罩。
    assert.equal(value.closed.visible, false, `视口 ${width} 弹窗没有关闭`);
    assert.equal(value.closed.pageOverflow, false, `视口 ${width} 关闭后出现横向溢出`);
    assert.equal(value.statusText, '智能体就绪', `视口 ${width} 关闭弹窗后状态不对：${value.statusText}`);
  }
});
