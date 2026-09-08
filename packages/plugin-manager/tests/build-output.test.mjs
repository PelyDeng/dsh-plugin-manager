import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { presentBuild } from '../../../deploy/scripts/build-output.mjs';

function fixture(t, source, isTTY = false, columns = 100) {
  const root = mkdtempSync(resolve(tmpdir(), 'build-output-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = resolve(root, 'build.mjs');
  const module = new URL('../../../deploy/scripts/build-output.mjs', import.meta.url).href;
  writeFileSync(entry, `import { buildStep, buildMessage } from ${JSON.stringify(module)};\n${source}\n`);
  let text = '';
  return {
    root, entry, module,
    run: () => presentBuild(entry, [], { logDirectory: root, output: { isTTY, columns, write: chunk => { text += chunk; } } }),
    text: () => text,
    log: () => { const path = resolve(root, readdirSync(root).find(name => name.startsWith('build-')), 'build.log'); return { path, text: readFileSync(path, 'utf8') }; },
  };
}

test('successful builds show stages and summary while retaining noisy tool output only in the log', async t => {
  const f = fixture(t, `
    import { spawnSync } from 'node:child_process';
    buildStep('构建示例插件', () => spawnSync(process.execPath, ['-e', 'console.log("compiler-detail"); console.error("tool-warning")'], { stdio: 'inherit' }));
    buildStep('准备镜像', () => {});
    buildMessage('发布已完成\\n访问地址：https://example.test');
  `);
  assert.equal(await f.run(), 0);
  assert.match(f.text(), /正在构建示例插件[\s\S]*构建示例插件已完成/);
  assert.match(f.text(), /发布已完成\n访问地址：https:\/\/example.test/);
  for (const label of ['构建示例插件', '准备镜像']) {
    assert.ok(f.text().includes(`正在${label} [--------------------]   0%`));
    assert.ok(f.text().includes(`${label}已完成 [====================] 100%`));
    assert.match(f.text(), new RegExp(`${label}已完成[^\\n]+耗时 \\d+:\\d{2}:\\d{2}\\.\\d\\n`));
  }
  assert.ok(f.text().endsWith('发布已完成\n访问地址：https://example.test\n'));
  assert.doesNotMatch(f.text(), /估算|compiler-detail|tool-warning|DSH_BUILD_PROGRESS|\x1b|\r/);
  assert.match(f.log().text, /compiler-detail/);
  assert.match(f.log().text, /tool-warning/);
  if (process.platform !== 'win32') assert.equal(statSync(f.log().path).mode & 0o777, 0o600);
});

test('a failed step keeps its exit code, bounded diagnostic tail and full log without claiming success', async t => {
  const f = fixture(t, `
    try {
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
  assert.match(f.text(), /构建失败示例失败 \[[^\]]+\]\s+\d+%/);
  assert.doesNotMatch(f.text(), /已完成|100%|detail-0\n/);
  assert.match(f.log().text, /detail-0\n/);
  assert.equal((f.text().match(/detail-\d+/g) ?? []).length, 11);
});

test('each interactive step starts at zero, estimates waiting progress and smoothly fills after success including fast steps', async t => {
  const f = fixture(t, `
    import { spawnSync } from 'node:child_process';
    buildStep('构建插件', () => spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 1200)']));
    buildStep('检查配置', () => {});
  `, true);
  assert.equal(await f.run(), 0);
  for (const label of ['构建插件', '检查配置']) {
    const frames = [...f.text().matchAll(new RegExp(`正在${label} \\[([^\\]]+)\\]\\s+(\\d+)%`, 'g'))];
    const percents = frames.map(match => Number(match[2]));
    assert.equal(percents[0], 0);
    assert.ok(percents.length >= 9);
    assert.ok(percents.some(value => value > 0 && value < 100));
    if (label === '构建插件') assert.ok(percents.some(value => value > 0 && value < 10));
    assert.ok(percents.every((value, i) => value < 100 && (i === 0 || value >= percents[i - 1])));
    assert.ok(frames.every(match => (match[1].match(/=/g) ?? []).length === Math.floor(Number(match[2]) / 5)));
    assert.match(f.text(), new RegExp(`${label}已完成 \\[====================\\] 100% +耗时 \\d+:\\d{2}:\\d{2}\\.\\d\\n`));
  }
  assert.ok(f.text().indexOf('构建插件已完成') < f.text().indexOf('正在检查配置'));
});

test('long elapsed durations fit narrow terminals and an abrupt worker exit retains elapsed time', async t => {
  const f = fixture(t, `
    console.log('DSH_BUILD_PROGRESS ' + JSON.stringify({ type: 'start', label: '检查很长的部署配置步骤' }));
    console.log('DSH_BUILD_PROGRESS ' + JSON.stringify({ type: 'done', label: '检查很长的部署配置步骤', elapsedMs: 3661234 }));
    buildStep('异常退出', () => process.exit(8));
  `, true, 40);
  assert.equal(await f.run(), 8);
  assert.match(f.text(), /耗时 01:01:01\.2\n/);
  assert.match(f.text(), /耗时 00:00:00\.\d\n/);
  for (const line of f.text().split(/\r|\n/).filter(line => line.includes('耗时'))) {
    const visible = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    assert.equal([...visible].reduce((sum, char) => sum + (/[\p{Script=Han}（）]/u.test(char) ? 2 : 1), 0), 39);
  }
});

test('elapsed time advances while the synchronous worker is busy and freezes at its measured duration', async t => {
  const f = fixture(t, `
    buildStep('处理发布产物', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100));
    buildStep('快速检查', () => {});
    try { buildStep('失败检查', () => { throw new Error('expected'); }); } catch {}
  `, true);
  assert.equal(await f.run(), 0);
  const frames = [...f.text().matchAll(/正在处理发布产物 [^\r\n]*耗时 (\d+:\d{2}:\d{2}\.\d)/g)];
  assert.ok(new Set(frames.map(match => match[1])).size >= 3, 'busy worker must show advancing elapsed time');
  const events = f.log().text.split('\n').filter(line => line.startsWith('DSH_BUILD_PROGRESS ')).map(line => JSON.parse(line.slice(19)));
  for (const event of events.filter(event => ['done', 'failed'].includes(event.type))) {
    assert.ok(Number.isFinite(event.elapsedMs));
    const expected = `00:00:${String(Math.floor(event.elapsedMs / 1000)).padStart(2, '0')}.${Math.floor(event.elapsedMs / 100) % 10}`;
    const line = f.text().split(/\r|\n/).find(line => line.includes(`${event.label}${event.type === 'done' ? '已完成' : '失败'}`));
    assert.ok(line?.endsWith(`耗时 ${expected}`), 'final time must exclude presentation animation and queue delay');
    const visible = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    assert.equal([...visible].reduce((sum, char) => sum + (/[\p{Script=Han}（）]/u.test(char) ? 2 : 1), 0), 99, 'duration ends at the right terminal margin');
  }
});

test('a failure outside a step does not reuse the previous successful step percentage', async t => {
  const f = fixture(t, `buildStep('准备工具', () => {}); console.error('late failure'); process.exitCode = 9;`);
  assert.equal(await f.run(), 9);
  assert.match(f.text(), /准备工具已完成 \[====================\] 100%/);
  assert.match(f.text(), /构建发布失败（退出码 9）\n/);
  assert.doesNotMatch(f.text(), /构建发布已完成/);
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
