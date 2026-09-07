/** Portable publisher evidence. Matching records never certify the running application. */
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digestPattern, fail, hash, idPattern } from './state.mjs';

export const verificationScopes = ['archive-consumption', 'real-host', 'model-double', 'real-model', 'container', 'browser', 'production'];
const mib = 1024 * 1024;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;
const version = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/;
const check = (condition, field) => { if (!condition) fail(`验证记录无效：${field}。`); };
const text = (value, pattern, field) => check(typeof value === 'string' && value.length <= 128 && pattern.test(value), field);
function object(value, fields, required, label) {
  check(value && typeof value === 'object' && !Array.isArray(value), label);
  check(Object.keys(value).every(key => fields.includes(key)) && required.every(key => Object.hasOwn(value, key)), label);
}
function array(value, max, label) { check(Array.isArray(value) && value.length <= max, label); }
function subject(value) {
  object(value, ['pluginId', 'archiveSha256'], ['pluginId', 'archiveSha256'], 'subject');
  text(value.pluginId, idPattern, 'pluginId'); text(value.archiveSha256, digestPattern, 'archiveSha256');
}
const primaryKey = value => `${value.pluginId}:${value.archiveSha256}`;
export const verificationSubjects = plugins => plugins.map(({ id, sha256 }) => ({ pluginId: id, archiveSha256: sha256 })).sort((a, b) => a.pluginId.localeCompare(b.pluginId));
const canonical = value => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  return value;
}
const subjectsKey = values => canonical([...values].sort((a, b) => a.pluginId.localeCompare(b.pluginId)));
function hostIdentity(value) {
  object(value, ['kind', 'version', 'commit', 'dirty', 'digest', 'identitySource'], ['kind'], 'host');
  check(['unknown', 'source', 'distribution'].includes(value.kind), 'host.kind');
  if (value.version !== undefined) text(value.version, version, 'host.version');
  if (value.identitySource !== undefined) check(['detected', 'declared'].includes(value.identitySource), 'host.identitySource');
  if (value.commit !== undefined) { check(value.kind === 'source', 'host.commit'); text(value.commit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, 'host.commit'); }
  if (value.dirty !== undefined) check(value.kind === 'source' && typeof value.dirty === 'boolean', 'host.dirty');
  if (value.digest !== undefined) { check(value.kind === 'distribution', 'host.digest'); text(value.digest, /^sha256:[a-f0-9]{64}$/, 'host.digest'); }
}
function runRecord(run, report) {
  const fields = ['pluginId', 'archiveSha256', 'subjects', 'scenarioId', 'suiteId', 'suiteRevision', 'finishedAt', 'outcome', 'scope', 'source', 'host', 'platform'];
  if (!report) fields.push('reportSha256');
  object(run, fields, fields.filter(field => field !== 'suiteRevision'), 'run');
  subject({ pluginId: run.pluginId, archiveSha256: run.archiveSha256 });
  array(run.subjects, 128, 'subjects'); run.subjects.forEach(subject);
  check(run.subjects.some(item => primaryKey(item) === primaryKey(run)), 'subjects.primary');
  check(new Set(run.subjects.map(item => item.pluginId)).size === run.subjects.length, 'subjects.duplicate');
  for (const field of ['suiteId', 'scenarioId']) text(run[field], identifier, field);
  if (run.suiteRevision !== undefined) text(run.suiteRevision, digestPattern, 'suiteRevision');
  if (!report) text(run.reportSha256, digestPattern, 'reportSha256');
  check(typeof run.finishedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(run.finishedAt) && Number.isFinite(Date.parse(run.finishedAt)), 'finishedAt');
  check(new Date(`${run.finishedAt.slice(0, 10)}T00:00:00Z`).toISOString().startsWith(run.finishedAt.slice(0, 10)), 'finishedAt.calendar');
  check(['passed', 'failed', 'skipped'].includes(run.outcome), 'outcome');
  check(verificationScopes.includes(run.scope), 'scope');
  check(['runner', 'maintainer'].includes(run.source), 'source'); hostIdentity(run.host);
  object(run.platform, ['os', 'architecture', 'nodeVersion'], ['os', 'architecture', 'nodeVersion'], 'platform');
  text(run.platform.os, identifier, 'platform.os'); text(run.platform.architecture, identifier, 'platform.architecture');
  text(run.platform.nodeVersion, version, 'platform.nodeVersion');
}
function groupKey(run) {
  const { finishedAt, outcome, reportSha256, subjects, ...identity } = run;
  return canonical({ ...identity, subjects: JSON.parse(subjectsKey(subjects)) });
}
function mergeRuns(runs) {
  const found = new Map();
  for (const run of runs) {
    const key = `${groupKey(run)}:${Date.parse(run.finishedAt)}`;
    const previous = found.get(key);
    check(!previous || previous.outcome === run.outcome, '同组同时间结果冲突');
    // Equivalent report formatting cannot choose a different result or make order significant.
    if (!previous || run.reportSha256 < previous.reportSha256) found.set(key, { ...run, subjects: JSON.parse(subjectsKey(run.subjects)), finishedAt: new Date(run.finishedAt).toISOString() });
  }
  return [...found.values()].sort((a, b) => canonical(a).localeCompare(canonical(b)));
}

/** Validate against the full original release; historical collaborating subjects may differ. */
export function validateVerification(value, plugins) {
  if (value === undefined) return undefined;
  check(Buffer.byteLength(JSON.stringify(value)) <= 4 * mib, 'verification size');
  object(value, ['schemaVersion', 'builds', 'runs'], ['schemaVersion', 'builds', 'runs'], 'verification');
  check(value.schemaVersion === 1, 'verification.schemaVersion'); array(value.builds, 256, 'builds'); array(value.runs, 1024, 'runs');
  const owned = new Set(verificationSubjects(plugins).map(primaryKey));
  const builds = new Map();
  for (const build of value.builds) {
    object(build, ['pluginId', 'archiveSha256', 'nodeVersion', 'packageManagerVersion', 'lockSha256'], ['pluginId', 'archiveSha256', 'nodeVersion', 'packageManagerVersion'], 'build');
    subject({ pluginId: build.pluginId, archiveSha256: build.archiveSha256 });
    for (const field of ['nodeVersion', 'packageManagerVersion']) text(build[field], version, field);
    if (build.lockSha256 !== undefined) text(build.lockSha256, digestPattern, 'lockSha256');
    check(owned.has(primaryKey(build)), 'build 归档归属');
    const previous = builds.get(primaryKey(build));
    check(!previous || canonical(previous) === canonical(build), 'build 冲突'); builds.set(primaryKey(build), build);
  }
  for (const run of value.runs) { runRecord(run, false); check(owned.has(primaryKey(run)), 'run 归档归属'); }
  return { schemaVersion: 1, builds: [...builds.values()].sort((a, b) => primaryKey(a).localeCompare(primaryKey(b))), runs: mergeRuns(value.runs) };
}

/** Selection changes the active primary objects, never the original test subjects. */
export function selectVerification(value, plugins) {
  if (!value) return undefined;
  const active = new Set(verificationSubjects(plugins).map(primaryKey));
  return { schemaVersion: 1, builds: value.builds.filter(item => active.has(primaryKey(item))), runs: value.runs.filter(item => active.has(primaryKey(item))) };
}

function readReportBytes(path) {
  const fd = openSync(path, 'r'), buffer = Buffer.alloc(mib + 1); let length = 0;
  try {
    while (length < buffer.length) { const size = readSync(fd, buffer, length, buffer.length - length, null); if (!size) break; length += size; }
  } finally { closeSync(fd); }
  check(length <= mib, 'report size'); return buffer.subarray(0, length);
}
function validateReport(report) {
  object(report, ['schemaVersion', 'runs'], ['schemaVersion', 'runs'], 'report');
  check(report.schemaVersion === 1, 'report.schemaVersion'); array(report.runs, 1024, 'report.runs');
  report.runs.forEach(run => runRecord(run, true));
}
export function mergeVerification(values, reportPaths, plugins) {
  const combined = { schemaVersion: 1, builds: [], runs: [] };
  for (const value of values.filter(Boolean)) { combined.builds.push(...value.builds); combined.runs.push(...value.runs); }
  for (const path of reportPaths) {
    const bytes = readReportBytes(path); let report;
    try { report = JSON.parse(bytes.toString('utf8')); } catch { fail('验证报告不是有效 JSON。'); }
    validateReport(report);
    combined.runs.push(...report.runs.map(run => ({ ...run, reportSha256: hash(bytes) })));
  }
  return validateVerification(combined, plugins);
}

/** Call only after assertions and cleanup finish; never overwrite a previous run. */
export function writeVerificationReport(path, runs) {
  const report = { schemaVersion: 1, runs }; validateReport(report);
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`); check(bytes.length <= mib, 'report size');
  check(!existsSync(path), '报告输出已存在'); mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    // Atomic create, unlike rename which can overwrite a report created concurrently.
    linkSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

const strongIdentity = host => host.identitySource === 'detected' && (host.kind === 'source' ? !!host.commit && host.dirty === false : host.kind === 'distribution' && !!host.digest);
function compareTarget(run, target, activeSubjects) {
  const differences = [];
  for (const field of ['version', 'commit', 'digest']) if (run.host[field] !== undefined && target.host[field] !== undefined && run.host[field] !== target.host[field]) differences.push(`host.${field}`);
  if (run.host.kind !== 'unknown' && target.host.kind !== 'unknown' && run.host.kind !== target.host.kind) differences.push('host.kind');
  for (const field of ['os', 'architecture', 'nodeVersion']) if (run.platform[field] !== target.platform[field]) differences.push(`platform.${field}`);
  if (differences.length) return { status: 'different-target', differences };
  if (subjectsKey(run.subjects) !== subjectsKey(activeSubjects)) return { status: 'different-context', differences: ['subjects'] };
  const missing = [];
  if (!strongIdentity(run.host) || !strongIdentity(target.host)) missing.push('host.provenance');
  if (!run.host.version || !target.host.version) missing.push('host.version');
  if (!run.suiteRevision) missing.push('suiteRevision');
  // An arbitrary suite scenario cannot be inferred from package IDs or configuration names.
  if (!target.scenarioIds?.includes(run.scenarioId)) missing.push('scenarioId');
  return missing.length ? { status: 'partial-match', missing } : { status: 'record-match' };
}

/** Advisory only; caller retains all existing installation and recovery gates. */
export function assessVerification(release, target, mode = 'release') {
  const value = selectVerification(release.verification, release.plugins);
  const subjects = verificationSubjects(release.plugins);
  return release.plugins.map(plugin => {
    const builds = value?.builds.filter(item => item.pluginId === plugin.id) ?? [];
    const latest = new Map();
    for (const run of value?.runs.filter(item => item.pluginId === plugin.id) ?? []) {
      const key = groupKey(run), previous = latest.get(key);
      if (!previous || Date.parse(run.finishedAt) > Date.parse(previous.finishedAt)) latest.set(key, run);
    }
    const records = [...latest.values()].map(run => {
      const match = mode === 'development' ? { status: 'unverified', missing: ['mutable-source'] } : compareTarget(run, target, subjects);
      const priorFailure = value.runs.some(old => groupKey(old) === groupKey(run) && old.outcome === 'failed' && Date.parse(old.finishedAt) < Date.parse(run.finishedAt));
      return { ...run, ...match, ...(run.outcome === 'failed' ? { status: 'reported-failure', targetStatus: match.status } : {}),
        ...(run.outcome === 'skipped' ? { status: 'unverified', targetStatus: match.status, priorFailure } : {}) };
    });
    return { pluginId: plugin.id, builds, records, ...(records.length ? { target: { host: target.host, platform: target.platform } } : { status: 'unverified' }) };
  });
}

export function printVerification(results, write = text => process.stderr.write(text)) {
  for (const result of results) {
    if (!result.records.length) write(`[verification] ${result.pluginId}: unverified（无随包宿主验证记录）\n`);
    for (const build of result.builds) write(`[verification] ${result.pluginId}: build Node=${build.nodeVersion}, pnpm=${build.packageManagerVersion}${build.lockSha256 ? `, lock=${build.lockSha256}` : ''}\n`);
    for (const record of result.records) {
      write(`[verification] ${result.pluginId}: ${record.status}; ${record.scope}/${record.scenarioId}: ${record.outcome}; source=${record.source}${record.targetStatus ? `; target=${record.targetStatus}` : ''}; 提供方记录，不代表当前环境已测试\n`);
      write(`  已测宿主=${JSON.stringify(record.host)}; 平台=${JSON.stringify(record.platform)}; 时间=${record.finishedAt}\n`);
      write(`  当前目标=${JSON.stringify(result.target)}; 差异=${(record.differences ?? []).join(',') || '无已知差异'}; 未核对=${(record.missing ?? []).join(',') || '无'}\n`);
      write(`  被测组合=${record.subjects.map(item => `${item.pluginId}@${item.archiveSha256}`).join(',')}${record.priorFailure ? '; 此组存在历史失败，最新跳过不表示修复' : ''}\n`);
    }
  }
}

export { verificationIdentity } from './process.mjs';
