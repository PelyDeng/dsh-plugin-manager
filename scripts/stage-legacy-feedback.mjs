/** Generate isolated Session V3 logs from legacy feedback; never publish into a live data root. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mergeLegacyFeedback } from '../packages/plugin-manager/src/session-snapshot.mjs';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--runtime', '--sessions', '--legacy', '--output'].includes(args[i]) && args[i + 1] && !options[args[i]], 'Supply --runtime --sessions --legacy --output once each.');
  options[args[i]] = resolve(args[i + 1]);
}
assert.equal(Object.keys(options).length, 4, 'All four explicit paths are required.');
const sourceRoot = options['--sessions'], output = options['--output'];
for (const [a, b] of [[sourceRoot, output], [output, sourceRoot]]) {
  const rel = relative(a, b); assert.ok(rel && (rel.startsWith('..') || isAbsolute(rel)), 'Input and output must be separate directories.');
}
assert.ok((await stat(options['--legacy'])).size <= 16 * 1024 * 1024, 'Legacy feedback file exceeds limit.');
const legacy = JSON.parse(await readFile(options['--legacy'], 'utf8'));
assert.ok(legacy.tables?.sessions && !Array.isArray(legacy.tables.sessions), 'Invalid legacy feedback storage.');
const rows = Object.entries(legacy.tables.sessions); assert.ok(rows.length <= 10000, 'Too many feedback sessions.');
const resolvers = [createRequire(join(options['--runtime'], 'package.json')), createRequire(join(options['--runtime'], 'node_modules/.pnpm/runtime-helper.cjs'))];
// 运行镜像根清单是 python 闭包（dsh-python-runtime-closure），不是宿主版本；宿主版本以镜像里的
// CLI 包 @deepseek-ai/dsh 为准。这样升级宿主不必改脚本，也不会放过把几个版本混装进同一个镜像。
const hostManifest = join(options['--runtime'], 'node_modules/@deepseek-ai/dsh/package.json');
assert.ok(existsSync(hostManifest), `运行镜像里缺少宿主清单：${hostManifest}`);
const hostVersion = JSON.parse(await readFile(hostManifest, 'utf8')).version;
const load = async name => {
  const pkg = '@deepseek-ai/' + name;
  const require = resolvers.find(r => { try { r.resolve(pkg); return true; } catch { return false; } });
  assert.ok(require, 'Missing official package: ' + pkg);
  const version = JSON.parse(await readFile(require.resolve(pkg + '/package.json'), 'utf8')).version;
  assert.equal(version, name === 'cordis' ? '4.0.2' : hostVersion, `${pkg} 的版本 ${version} 与运行镜像的宿主 ${hostVersion} 不一致。`);
  return import(pathToFileURL(require.resolve(pkg)));
};
const { Context } = await load('cordis'), persistence = await load('dsh-session-persistence-jsonl');
const { sessionFormatCatalog: catalog } = await load('dsh-session-format-catalog');
const { releasedV2SessionFormatCodec: v2, releasedV3SessionFormatCodec: v3 } = await load('dsh-session-format-v2-to-v3');
await mkdir(output, { mode: 0o700 });
const from = new Context(), to = new Context(), mappings = []; let items = 0;
try {
  await from.plugin(persistence.default, { root: sourceRoot, compression: 'zstd' });
  await to.plugin(persistence.default, { root: join(output, 'sessions'), compression: 'zstd' });
  for (const [id, row] of rows) {
    const handle = await from.sessionPersistence.open(id, 'read'); let snapshot;
    try { snapshot = { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events: (await handle.read()).events }; }
    finally { await handle.close(); }
    assert.equal(snapshot.header.id, id);
    const migrated = mergeLegacyFeedback(snapshot, row, { catalog, v2, v3 });
    const writer = await to.sessionPersistence.create(migrated.header, { inheritedEventCount: migrated.inheritedEventCount });
    try { await writer.append(migrated.events); await writer.flush(); assert.deepEqual((await writer.read()).events, migrated.events); }
    finally { await writer.close(); }
    mappings.push({ id, addedEvents: migrated.events.length - snapshot.events.length }); items += row.items.length;
  }
  await writeFile(join(output, 'report.json'), JSON.stringify({ schemaVersion: 1, sessions: rows.length, items, mappings }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ staged: true, sessions: rows.length, items }));
} finally { await to.fiber.dispose(); await from.fiber.dispose(); }
