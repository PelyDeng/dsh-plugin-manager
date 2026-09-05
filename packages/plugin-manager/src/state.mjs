import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
export const nativeTar = join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? '/', 'System32', 'tar.exe');

/** Windows drive-letter paths must reach bsdtar, not Git Bash's remote-archive parser. */
export const tarCommand = process.platform === 'win32' && existsSync(nativeTar) ? nativeTar : 'tar';

export const STATE = '.deepseek-plugin-state.json';

export const PENDING = '.deepseek-plugin-pending.json';

export const LOCK = '.deepseek-plugin-lock';

export const OWNER = '.deepseek-plugin-owner.json';

export const STOPPED = '.deepseek-plugin-stopped.json';

export const synchronizedStopped = new WeakSet();

export const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export const idPattern = /^[a-z][a-z0-9-]*$/;

export const reservedVariables = new Set('PATH HOME USER USERNAME USERPROFILE PWD OLDPWD IFS ENV SHELL SHELLOPTS CDPATH TMP TEMP TMPDIR COMSPEC PATHEXT SYSTEMROOT WINDIR UID EUID PPID LANG LC_ALL MANIFEST_FILE CATALOG_FILE AUTH_URL_FILE PUBLIC_URL PROFILE_DIR MANAGED_FILE STATE_FILE PACKAGE_DIR VERIFY_BIN NODE_BIN'.split(' '));

export const environmentName = name => typeof name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(name) && !/^(DSH_|PLUGIN_|PNPM_|NPM_|NODE_|COREPACK_|BASH|LD_|DYLD_|GIT_|DOCKER_|COMPOSE_|REGISTRY_)/.test(name) && !reservedVariables.has(name);

export const digestPattern = /^[a-f0-9]{64}$/;

export const fail = message => { throw new Error(message); };

export const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

export const hash = value => createHash('sha256').update(value).digest('hex');

export const same = isDeepStrictEqual;

export const readOptional = path => existsSync(path) ? json(path) : null;

/** Resolve existing ancestors too, so directory aliases share locks and exclusions. */
export function canonical(path) {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync.native(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(canonical(parent), relative(parent, absolute));
}

export function within(root, path) {
  const rel = relative(canonical(root), canonical(path));
  return !rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** Atomically replace a private state file; no credentials belong in state. */
export function atomicJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function privateFile(path, value, direct = false) {
  mkdirSync(dirname(path), { recursive: true });
  if (direct) {
    if (process.platform !== 'win32' && existsSync(path)) chmodSync(path, 0o600);
    writeFileSync(path, value, { mode: 0o600 }); return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, path);
}
