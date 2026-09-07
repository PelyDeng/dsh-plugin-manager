import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessVerification, mergeVerification, printVerification, selectVerification, validateVerification, verificationSubjects, writeVerificationReport } from '../src/verification.mjs';
import { verificationIdentity } from '../src/process.mjs';
import { hash } from '../src/state.mjs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const a = { id: 'example', sha256: 'a'.repeat(64) }, b = { id: 'auth', sha256: 'b'.repeat(64) };
const target = { host: { kind: 'source', version: '0.1.3-alpha.1', commit: 'c'.repeat(40), dirty: false, identitySource: 'detected' },
  platform: { os: 'linux', architecture: 'x64', nodeVersion: '24.1.0' }, scenarioIds: ['example-authenticated'] };
const run = changes => ({ pluginId: a.id, archiveSha256: a.sha256, subjects: verificationSubjects([a, b]), scenarioId: 'example-authenticated',
  suiteId: 'example-host', suiteRevision: 'd'.repeat(64), finishedAt: '2026-09-07T00:00:00.000Z', outcome: 'passed', scope: 'model-double', source: 'runner',
  host: structuredClone(target.host), platform: target.platform, reportSha256: 'e'.repeat(64), ...changes });
const value = runs => ({ schemaVersion: 1, builds: [], runs });
const assess = (runs, plugins = [a, b], overrides = {}, mode) => assessVerification({ plugins, verification: validateVerification(value(runs), [a, b]) }, { ...target, ...overrides }, mode)[0];
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-verification-'));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}

test('archive-bound combination and scenario cannot be promoted to a different deployment', () => {
  assert.equal(assess([run()]).records[0].status, 'record-match');
  assert.equal(assess([run()], [a, { ...b, sha256: 'f'.repeat(64) }]).records[0].status, 'different-context');
  assert.equal(assess([run()], [a]).records[0].status, 'different-context');
  assert.equal(assess([run({ subjects: verificationSubjects([a]) })]).records[0].status, 'different-context');
  assert.equal(assess([run()], [a, b], { scenarioIds: [] }).records[0].status, 'partial-match');
  assert.equal(assess([run()], [a, b], {}, 'development').records[0].status, 'unverified');
  const filtered = selectVerification(value([run()]), [a]);
  assert.equal(filtered.runs[0].subjects.length, 2);
  assert.doesNotThrow(() => validateVerification(filtered, [a]));
});

test('equal versions do not conceal dirty, declared, missing or different provenance', () => {
  for (const host of [{ kind: 'unknown', version: target.host.version }, { ...target.host, dirty: true }, { ...target.host, identitySource: 'declared' }]) {
    assert.equal(assess([run()], [a, b], { host }).records[0].status, 'partial-match');
  }
  assert.equal(assess([run()], [a, b], { host: { ...target.host, commit: 'f'.repeat(40) } }).records[0].status, 'different-target');
  assert.equal(assess([run()], [a, b], { platform: { ...target.platform, os: 'win32' } }).records[0].status, 'different-target');
  assert.equal(assess([run({ host: { kind: 'distribution', version: target.host.version, digest: 'sha256:' + 'a'.repeat(64), identitySource: 'declared' } })], [a, b], {
    host: { kind: 'distribution', version: target.host.version, digest: 'sha256:' + 'a'.repeat(64), identitySource: 'declared' },
  }).records[0].status, 'partial-match');
});

test('latest results remain separated by scope, suite revision, target and source', () => {
  const failed = run({ outcome: 'failed', finishedAt: '2026-09-07T01:00:00Z' });
  const skipped = run({ outcome: 'skipped', finishedAt: '2026-09-07T02:00:00Z' });
  const reports = [run(), failed, skipped, run({ scope: 'browser', outcome: 'failed' }), run({ source: 'maintainer' }), run({ suiteRevision: 'f'.repeat(64) })];
  const records = assess(reports).records;
  assert.equal(records.length, 4);
  assert.equal(records.find(record => record.outcome === 'skipped').priorFailure, true);
  assert.equal(records.find(record => record.scope === 'browser').status, 'reported-failure');
  assert.equal(assess([run(), failed]).records[0].status, 'reported-failure');
  assert.throws(() => validateVerification(value([run(), run({ outcome: 'failed' })]), [a, b]), /冲突/);
  const left = validateVerification(value([run(), run({ reportSha256: 'a'.repeat(64) })]), [a, b]);
  const right = validateVerification(value([run({ reportSha256: 'a'.repeat(64) }), run()]), [a, b]);
  assert.deepEqual(left, right);
});

test('disabled primary objects cannot contaminate active results; their subjects remain historical facts', () => {
  const reports = value([run(), run({ pluginId: b.id, archiveSha256: b.sha256, outcome: 'failed' })]);
  const active = assessVerification({ plugins: [a], verification: reports }, target);
  assert.equal(active.length, 1); assert.equal(active[0].records[0].status, 'different-context');
  assert.equal(assessVerification({ plugins: [a, b], verification: reports }, target)[1].records[0].status, 'reported-failure');
  assert.deepEqual(assessVerification({ plugins: [], verification: reports }, target), []);
  assert.deepEqual(assessVerification({ plugins: [a] }, target)[0], { pluginId: a.id, builds: [], records: [], status: 'unverified' });
});

test('invalid reports reject before publication without reflecting arbitrary content', t => {
  const root = directory(t), path = join(root, 'report.json');
  for (const change of [{ secret: 'do-not-echo' }, { archiveSha256: 'wrong' }, { scope: 'everything' }, { finishedAt: '2026-09-07' },
    { pluginId: 'not-present' }, { subjects: [] }, { subjects: [verificationSubjects([a])[0], verificationSubjects([a])[0]] }]) {
    assert.throws(() => validateVerification(value([run(change)]), [a, b]), error => !error.message.includes('do-not-echo'));
  }
  writeFileSync(path, ' '.repeat(1024 * 1024 + 1));
  assert.throws(() => mergeVerification([], [path], [a, b]), /size/);
  writeFileSync(path, '{invalid do-not-echo');
  assert.throws(() => mergeVerification([], [path], [a, b]), error => !error.message.includes('do-not-echo'));
  assert.throws(() => validateVerification({ ...value([]), runs: Array(1025).fill(run()) }, [a, b]), /runs/);
});

test('report digest binds original bytes, import preserves declared source, output never replaces old evidence', t => {
  const root = directory(t), path = join(root, '报告.json');
  const { reportSha256, ...input } = run({ source: 'maintainer' });
  writeVerificationReport(path, [input]);
  const bytes = readFileSync(path), imported = mergeVerification([], [path], [a, b]);
  assert.equal(imported.runs[0].reportSha256, hash(bytes));
  assert.equal(imported.runs[0].source, 'maintainer');
  assert.throws(() => writeVerificationReport(path, [input]), /已存在/);
  assert.deepEqual(readFileSync(path), bytes);
  assert.throws(() => writeVerificationReport(join(root, 'bad.json'), [run()]), /run/);
  writeFileSync(path, JSON.stringify(JSON.parse(bytes)));
  assert.notEqual(mergeVerification([], [path], [a, b]).runs[0].reportSha256, imported.runs[0].reportSha256);
  let printed = ''; printVerification(assessVerification({ plugins: [a, b], verification: imported }, target), text => { printed += text; });
  assert.match(printed, /model-double/); assert.doesNotMatch(printed, /real-model/);
  assert.match(printed, /0\.1\.3-alpha\.1/); assert.match(printed, /当前目标=/);
  assert.match(printed, /被测组合=auth@/);
});

test('identity probe cannot turn an injected source SHA into an observed host', t => {
  const root = directory(t), path = join(root, 'cli.mjs');
  writeFileSync(path, 'console.log("0.1.3-alpha.1")');
  const previous = process.env.DSH_HOST_SOURCE_SHA;
  process.env.DSH_HOST_SOURCE_SHA = 'a'.repeat(40);
  t.after(() => { if (previous === undefined) delete process.env.DSH_HOST_SOURCE_SHA; else process.env.DSH_HOST_SOURCE_SHA = previous; });
  const identity = verificationIdentity({ command: process.execPath, prefix: [path], cwd: root }, { home: root });
  assert.deepEqual(identity.host, { kind: 'unknown', version: '0.1.3-alpha.1' });
  const unavailable = verificationIdentity({ command: join(root, 'absent'), prefix: [], cwd: root }, { home: root });
  assert.equal(unavailable.host.kind, 'unknown'); assert.equal(unavailable.host.commit, undefined);
});

test('temporary housekeeping cannot report failure after a report has been published', t => {
  const root = directory(t), path = join(root, 'published.json');
  const { reportSha256, ...input } = run();
  const original = fs.rmSync;
  fs.rmSync = () => { throw new Error('Temporary unlink unavailable'); };
  syncBuiltinESMExports();
  try { assert.doesNotThrow(() => writeVerificationReport(path, [input])); }
  finally { fs.rmSync = original; syncBuiltinESMExports(); }
  assert.deepEqual(JSON.parse(readFileSync(path)), { schemaVersion: 1, runs: [input] });
});
