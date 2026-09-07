/** Shared default DeepSeek credential operations; persistence belongs to the official host. */
import { createHash } from 'node:crypto';

export const DEEPSEEK_KEY_REF = 'DEEPSEEK_API_KEY';
export class DeepSeekKeyError extends Error {}

function available(provider) {
  return provider && ['describe', 'resolve', 'set'].every(method => typeof provider[method] === 'function');
}

export function validateDeepSeekKey(key) {
  if (typeof key !== 'string' || key.length > 4096 || !/^sk-[A-Za-z0-9_-]+$/u.test(key)) {
    throw new DeepSeekKeyError('API 密钥格式无效，请输入以 sk- 开头的完整密钥。');
  }
}

/** Return only a one-way fingerprint, never an existing secret or provider diagnostics. */
export async function deepSeekKeyStatus(provider) {
  if (!available(provider)) return { supported: false, configured: false, writable: false, source: null, fingerprint: null };
  try {
    const info = await provider.describe(DEEPSEEK_KEY_REF);
    const resolved = await provider.resolve(DEEPSEEK_KEY_REF);
    const value = resolved?.value;
    const configured = typeof value === 'string' && value.length > 0;
    return {
      supported: true, configured, writable: info.writable === true,
      source: ['env', 'file', 'project-env', 'user-env'].includes(resolved?.source) ? resolved.source : null,
      fingerprint: configured ? `SHA-256:${createHash('sha256').update(value).digest('hex')}` : null,
    };
  } catch { throw new DeepSeekKeyError('无法读取官方凭据状态，请检查凭据服务及存储权限。'); }
}

/** Both the admin page and CLI use the host's locked, atomic credential writer. */
export async function setDeepSeekKey(provider, key, authorize = () => {}) {
  validateDeepSeekKey(key);
  const status = await deepSeekKeyStatus(provider);
  if (!status.supported) throw new DeepSeekKeyError('当前宿主未提供官方凭据服务。');
  if (!status.writable) throw new DeepSeekKeyError('密钥由外部环境提供，当前为只读；请先由服务管理者移除环境覆盖。');
  authorize();
  try { await provider.set(DEEPSEEK_KEY_REF, key); }
  catch { throw new DeepSeekKeyError('密钥保存失败，请检查官方凭据服务、文件权限或环境覆盖。'); }
  return deepSeekKeyStatus(provider);
}
