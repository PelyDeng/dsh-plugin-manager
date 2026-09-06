import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { presentBuild } from '../../../deploy/scripts/build-output.mjs';

function fixture(t, source, isTTY = false) {
  const root = mkdtempSync(resolve(tmpdir(), 'build-output-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = resolve(root, 'build.mjs');
  const module = new URL('../../../deploy/scripts/build-output.mjs', import.meta.url).href;
  writeFileSync(entry, `import { buildStep, buildMessage, buildProgress } from ${JSON.stringify(module)};\n${source}\n`);
  let text = '';
  return {
    root, entry, module,
    run: () => presentBuild(entry, [], { logDirectory: root, output: { isTTY, write: chunk => { text += chunk; } } }),
    text: () => text,
    log: () => { const path = resolve(root, readdirSync(root).find(name => name.endsWith('.log'))); return { path, text: readFileSync(path, 'utf8') }; },
  };
}

test('successful builds show stages and summary while retaining noisy tool output only in the log', async t => {
  const f = fixture(t, `
    import { spawnSync } from 'node:child_process';
    buildProgress(1, 5);
    buildStep('构建示例插件', () => spawnSync(process.execPath, ['-e', 'console.log("compiler-detail"); console.error("tool-warning")'], { stdio: 'inherit' }));
    buildProgress(2, 5);
    buildStep('准备镜像', () => {});
    buildProgress(5, 5);
    buildMessage('发布已完成\\n访问地址：https://example.test');
  `);
  assert.equal(await f.run(), 0);
  assert.match(f.text(), /正在构建示例插件\.\.\.[\s\S]*构建示例插件已完成/);
  assert.match(f.text(), /发布已完成\n访问地址：https:\/\/example.test/);
  assert.ok(f.text().includes('[====----------------]  20% 正在构建示例插件'));
  assert.ok(f.text().includes('[========------------]  40% 正在准备镜像'));
  assert.ok(f.text().endsWith('[====================] 100% 构建发布已完成\n'));
  assert.doesNotMatch(f.text(), /compiler-detail|tool-warning|DSH_BUILD_PROGRESS|\x1b|\r/);
  assert.match(f.log().text, /compiler-detail/);
  assert.match(f.log().text, /tool-warning/);
  if (process.platform !== 'win32') assert.equal(statSync(f.log().path).mode & 0o777, 0o600);
});

test('a failed step keeps its exit code, bounded diagnostic tail and full log without claiming success', async t => {
  const f = fixture(t, `
    try {
      buildProgress(2, 5);
      buildStep('构建失败示例', () => {
        for (let i = 0; i < 50; i++) console.log('detail-' + i);
        throw new Error('essential-error');
      });
    } catch (error) { console.log(error.message); process.exitCode = 7; }
  `);
  assert.equal(await f.run(), 7);
  assert.match(f.text(), /构建失败示例失败/);
  assert.match(f.text(), /退出码 7/);
  assert.match(f.text(), /essential-error/);
  assert.ok(f.text().includes('[========------------]  40% 构建失败示例失败'));
  assert.doesNotMatch(f.text(), /已完成|100%|detail-0\n/);
  assert.match(f.log().text, /detail-0\n/);
  assert.equal((f.text().match(/detail-\d+/g) ?? []).length, 11);
});

test('interactive bar fills to the reported percentage and animates without inventing progress while a tool runs', async t => {
  const f = fixture(t, `
    import { spawnSync } from 'node:child_process';
    buildProgress(2, 5);
    buildStep('构建插件', () => spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 1200)']));
  `, true);
  assert.equal(await f.run(), 0);
  assert.ok(f.text().includes('[========>-----------]  40% 正在构建插件\r'));
  assert.ok(f.text().includes('[========------------]  40% 正在构建插件\r'));
  const waiting = [...f.text().matchAll(/(\d+)% 正在构建插件/g)];
  assert.ok(waiting.length > 1);
  assert.ok(waiting.every(match => match[1] === '40'));
  assert.ok(f.text().includes('\x1b[2K[========------------]  40% 构建插件已完成\n'));
});

test('a late process failure never displays 100 percent even after all phases were reported complete', async t => {
  const f = fixture(t, `buildProgress(5, 5); console.error('late failure'); process.exitCode = 9;`);
  assert.equal(await f.run(), 9);
  assert.match(f.text(), /99% 构建发布失败/);
  assert.doesNotMatch(f.text(), /100%|构建发布已完成/);
});

test('termination reaches a synchronous tool and the presenter retains the signal exit code', { skip: process.platform === 'win32' }, async t => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const f = fixture(t, `
      import { spawnSync } from 'node:child_process';
      import { fileURLToPath } from 'node:url';
      buildStep('等待退出', () => spawnSync(process.execPath, ['-e',
        'process.on("${signal}", () => { require("node:fs").writeFileSync(process.argv[2], "stopped"); process.exit(0); }); process.kill(Number(process.argv[1]), "${signal}"); setInterval(() => {}, 1000);',
        String(process.ppid), fileURLToPath(new URL('./terminated', import.meta.url))
      ], { stdio: 'inherit' }));
    `);
    const runner = resolve(f.root, 'runner.mjs');
    writeFileSync(runner, `import { presentBuild } from ${JSON.stringify(f.module)};\nprocess.exitCode = await presentBuild(${JSON.stringify(f.entry)}, [], { logDirectory: ${JSON.stringify(f.root)} });\n`);
    const result = await new Promise(resolve => execFile(process.execPath, [runner], { timeout: 5000 }, (error, stdout) => resolve({ error, stdout })));
    assert.equal(result.error?.code, code);
    assert.equal(readFileSync(resolve(f.root, 'terminated'), 'utf8'), 'stopped');
    assert.ok(result.stdout.includes(`退出码 ${code}`));
  }
});
