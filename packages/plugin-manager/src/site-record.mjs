/** Site routing and saved-operation identities. Keep this module usable before installation. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';

export const siteStatuses = ['building', 'build-failed', 'ready', 'prepared', 'backing-up', 'applying', 'deployment-failed'];
export const needsSiteResume = status => ['prepared', 'backing-up', 'applying', 'deployment-failed'].includes(status);
export const fileHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export const readSiteJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
export const sitePointer = root => resolve(root, '.local/source-release.json');
const inside = (root, path) => { const rel = relative(resolve(root), resolve(path)); return rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); };

/** Saved execution must stay in the actual operation, including junction resolution. */
export function siteFileWithin(root, path) {
  if (!inside(root, path) || !inside(realpathSync(root), realpathSync(path))) throw new Error(`Saved operation path escapes its owner: ${path}`);
  return path;
}
function operationWithin(root, operation) {
  const artifacts = resolve(root, '.local/artifacts');
  siteFileWithin(root, artifacts);
  siteFileWithin(artifacts, operation);
  if (!lstatSync(operation).isDirectory() || lstatSync(operation).isSymbolicLink()) throw new Error('Saved operation must be a real directory.');
}

export function siteArguments(args) {
  const options = {}, copy = [...args];
  while (copy.length) {
    const flag = copy.shift(), key = flag?.slice(2);
    if (!flag?.startsWith('--') || Object.hasOwn(options, key)) throw new Error(`Unknown or duplicate argument: ${flag}. Use --help.`);
    if (['resume', 'recover', 'data-compatible', 'skip-plugin-check', 'verify-plugin-check', 'help'].includes(key)) options[key] = true;
    else if (['root', 'config', 'rebuild-plugins'].includes(key) && copy[0] && !copy[0].startsWith('--')) options[key] = copy.shift();
    else throw new Error(`Unknown or missing argument: ${flag}. Use --help.`);
  }
  if (options['rebuild-plugins']) {
    const ids = options['rebuild-plugins'].split(',');
    if (ids.some(id => !/^[a-z][a-z0-9-]*$/.test(id) || ['all', 'none', 'dsh-console'].includes(id)) || new Set(ids).size !== ids.length) throw new Error('Invalid --rebuild-plugins argument: use distinct plugin IDs separated by commas.');
  }
  if ([options.resume, options.recover, options['rebuild-plugins']].filter(Boolean).length > 1) throw new Error('--resume、--recover 与 --rebuild-plugins 不能同时使用。');
  if (Boolean(options.recover) !== Boolean(options['data-compatible'])) throw new Error('--recover 必须与 --data-compatible 一起使用。');
  return options;
}

export function readSitePointer(root) {
  const path = sitePointer(root);
  if (!existsSync(path)) return null;
  siteFileWithin(root, path);
  const value = readSiteJson(path);
  if (!value || typeof value.operation !== 'string' || !inside(resolve(root, '.local/artifacts'), value.operation) || !siteStatuses.includes(value.status)) throw new Error('发布记录无效：操作位置或状态不合法。');
  operationWithin(root, value.operation);
  return value;
}

/** Schema 2 remains source evidence; never invent the missing snapshot of an old operation. */
export function readSiteRecord(root, operation, { status } = {}) {
  if (typeof operation !== 'string' || !inside(resolve(root, '.local/artifacts'), operation)) throw new Error('Invalid saved operation location.');
  operationWithin(root, operation);
  siteFileWithin(operation, resolve(operation, 'result.json'));
  const record = readSiteJson(resolve(operation, 'result.json'));
  if (![2, 3].includes(record.schemaVersion) || resolve(record.operation) !== resolve(operation) || !siteStatuses.includes(record.status) || (status && record.status !== status)) throw new Error('Saved site record version, status or identity is invalid.');
  if (record.schemaVersion === 3 && !['source', 'archives'].includes(record.inputKind)) throw new Error('Saved site inputKind is invalid.');
  return record;
}

/** Hash a self-contained installed tool tree, including link destinations and file bytes. */
export function toolTreeIdentity(root) {
  root = realpathSync(root);
  const entries = [];
  function visit(path) {
    const info = lstatSync(path), name = relative(root, path).split(sep).join('/');
    if (info.isSymbolicLink()) {
      const target = realpathSync(path);
      if (target !== root && !inside(root, target)) throw new Error(`工具执行树含外部链接：${name}`);
      entries.push([name, 'link', relative(root, target).split(sep).join('/')]);
    } else if (info.isDirectory()) for (const item of readdirSync(path).sort()) visit(resolve(path, item));
    else if (info.isFile()) entries.push([name, fileHash(path)]);
    else throw new Error(`工具执行树含非常规文件：${name}`);
  }
  visit(root);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export function verifySavedTooling(record) {
  const toolRoot = record.toolRoot ?? resolve(record.operation, 'tooling');
  const cli = resolve(toolRoot, 'node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs');
  if (record.schemaVersion === 3) {
    for (const path of [toolRoot, record.managerArchive, cli, resolve(dirname(cli), 'site-release.mjs')]) siteFileWithin(record.operation, path);
  }
  if (fileHash(record.managerArchive) !== record.managerHash) throw new Error('Saved manager archive changed.');
  if (!existsSync(cli)) throw new Error('Saved manager execution tree is missing; restore the original tree.');
  if (record.schemaVersion === 3 && (!record.toolHash || toolTreeIdentity(toolRoot) !== record.toolHash)) throw new Error('Saved execution tree changed; restore the original tree.');
  return { toolRoot, cli, worker: resolve(dirname(cli), 'site-release.mjs') };
}
