import { canonical, fail, within } from './state.mjs';
import { relative, resolve } from 'node:path';
import { cpSync, existsSync, statSync } from 'node:fs';
/** Copy read-only offline inputs into separate writable pnpm store and metadata cache directories. */
export function prepareOfflineDependencies(deployment) {
  const copies = [];
  for (const [field, targetField, name] of [['offlineStore', 'store', 'store'], ['offlineCache', 'cache', 'cache']]) if (deployment[field]) {
    if (!deployment[targetField]) fail(`离线 ${name} 来源需要独立可写 --${name}-dir。`);
    const source = canonical(resolve(deployment.root, deployment[field]));
    const target = canonical(resolve(deployment.root, deployment[targetField]));
    if (!existsSync(source) || !statSync(source).isDirectory()) fail(`离线 ${name} 来源不存在。`);
    copies.push({ source, target, name });
  }
  for (const { target } of copies) for (const { source } of copies) if (within(source, target) || within(target, source)) fail('离线来源与可写目标不能重叠。');
  for (const { source, target, name } of copies) cpSync(source, target, {
    recursive: true, force: name === 'cache', errorOnExist: false,
    // pnpm project links identify installations on the warming host, not offline package contents.
    // Existing lockfile verification records include local installations and must survive metadata refreshes.
    filter: (path, destination) => name === 'store'
      ? !/^v\d+[\\/]projects(?:[\\/]|$)/.test(relative(source, path))
      : relative(source, path) !== 'lockfile-verified.jsonl' || !existsSync(destination),
  });
}
