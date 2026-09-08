import { chownSync, existsSync, openSync, closeSync, fsyncSync, linkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateModelKey } from '@dsh-plugin-manager/plugin-kit/model-key';
import { readPrivateConfig } from './literal-config.mjs';
import { canonical, within, PENDING, readOptional } from './state.mjs';
import { ensurePrivateDirectory, writePrivateFile } from './private-files.mjs';

const inputs = new WeakMap();
const keys = { DEEPSEEK_API_KEY: 'deepseek', ZHIPU_API_KEY: 'zhipu' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const containerCredentialsPath = '/run/dsh-framework-credentials.json';

/** Keep source secrets out of serializable deployment objects and logs. */
export function rememberFrameworkInput(deployment, input) { inputs.set(deployment, input); }
export function frameworkInput(deployment) { return inputs.get(deployment); }

function validate(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some(key => !Object.hasOwn(keys, key))) throw new Error('框架凭据投影字段无效。');
  for (const [key, value] of Object.entries(values)) validateModelKey(keys[key], value);
  return values;
}

/** Existing projection bytes, not current source preferences, define a resumed operation. */
export function frameworkCredentialEnvironment(deployment) {
  const spec = deployment.config.frameworkCredentials;
  if (!spec) return {};
  if (typeof spec !== 'object' || Array.isArray(spec) || Object.keys(spec).some(key => !['file', 'sha256'].includes(key))
    || typeof spec.file !== 'string' || !/^[a-f0-9]{64}$/u.test(spec.sha256)) throw new Error('框架凭据投影标识无效。');
  const bytes = readPrivateConfig(resolve(deployment.root, spec.file));
  if (digest(bytes) !== spec.sha256) throw new Error('框架凭据投影摘要不符；保留原输入，不得以新密钥恢复旧部署。');
  let values;
  try { values = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('框架凭据投影格式无效。'); }
  return validate(values);
}

/** Materialize only the two model secrets; registry credentials never reach the host. */
export function prepareFrameworkCredentials(deployment, owner) {
  const input = inputs.get(deployment);
  if (!input) { frameworkCredentialEnvironment(deployment); return; }
  if (digest(readPrivateConfig(deployment.configPath)) !== input.sha256) throw new Error('框架配置在读取后发生变化；请重新执行，不能混用输入。');
  const credentials = validate(input.credentials);
  const bytes = Object.keys(credentials).length ? Buffer.from(JSON.stringify(credentials) + '\n') : undefined;
  const sha256 = bytes && digest(bytes);
  const pending = deployment.options.resume && readOptional(join(deployment.profileRoot, PENDING));
  if (pending) {
    const original = pending.desired?.configurations?.$framework;
    if (original?.sha256 !== sha256) throw new Error('恢复需要原框架凭据配置；不能替换或清除待恢复操作的密钥。');
    if (original) {
      // Shared pending state records the container target; only Compose may translate it.
      const file = owner && original.file === containerCredentialsPath
        ? join(deployment.root, '.local', 'secrets', 'framework-credentials', `${sha256}.json`)
        : original.file;
      deployment.config.frameworkCredentials = { ...original, file };
    }
    frameworkCredentialEnvironment(deployment);
    return;
  }
  if (!bytes) return;
  const directory = join(deployment.root, '.local', 'secrets', 'framework-credentials');
  if (!within(deployment.root, canonical(directory))) throw new Error('框架私有配置目录不能通过联接跳转到项目外。');
  if (owner && ![owner.uid, owner.gid].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('凭据挂载需要非root容器UID/GID。');
  ensurePrivateDirectory(directory);
  const file = join(directory, `${sha256}.json`);
  if (!existsSync(file)) {
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    let fd;
    try {
      writePrivateFile(temporary, bytes, { flag: 'wx' });
      fd = openSync(temporary, 'r+');
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      if (owner && process.platform !== 'win32' && process.getuid?.() === 0) chownSync(temporary, owner.uid, owner.gid);
      try { linkSync(temporary, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  deployment.config.frameworkCredentials = { file, sha256 };
  frameworkCredentialEnvironment(deployment);
}
