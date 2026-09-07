/** Fixed model credential references; the official host owns persistence. */
import { createHash } from 'node:crypto';
export class ModelKeyError extends Error {}
function reference(kind) {
  if (kind === 'deepseek') return 'DEEPSEEK_API_KEY';
  if (kind === 'zhipu') return 'ZHIPU_API_KEY';
  throw new ModelKeyError('不支持的模型服务商。');
}
export function validateModelKey(kind, key) {
  reference(kind);
  if (typeof key !== 'string' || key.length > 4096 || !/^[!-~]+$/u.test(key)) throw new ModelKeyError('API 密钥格式无效，请输入不含空格或换行的完整密钥。');
  if (kind === 'deepseek' && !/^sk-[A-Za-z0-9_-]+$/u.test(key)) throw new ModelKeyError('API 密钥格式无效，请输入以 sk- 开头的完整密钥。');
}
/** Only presence and a one-way fingerprint leave the credential boundary. */
export async function modelKeyStatus(provider, kind) {
  const ref = reference(kind);
  if (!provider || !['describe', 'resolve', 'set'].every(method => typeof provider[method] === 'function')) return { supported: false, configured: false, writable: false, source: null, fingerprint: null };
  try {
    const info = await provider.describe(ref);
    const resolved = await provider.resolve(ref);
    const value = resolved?.value;
    const configured = typeof value === 'string' && value.length > 0;
    return {
      supported: true, configured, writable: info.writable === true,
      source: ['env', 'file', 'project-env', 'user-env'].includes(resolved?.source) ? resolved.source : null,
      fingerprint: configured ? `SHA-256:${createHash('sha256').update(value).digest('hex')}` : null,
    };
  } catch { throw new ModelKeyError('无法读取官方凭据状态，请检查凭据服务及存储权限。'); }
}
export async function setModelKey(provider, kind, key, authorize = () => {}) {
  validateModelKey(kind, key);
  const status = await modelKeyStatus(provider, kind);
  if (!status.supported) throw new ModelKeyError('当前宿主未提供官方凭据服务。');
  if (!status.writable) throw new ModelKeyError('密钥由外部环境提供，当前为只读；请先由服务管理者移除环境覆盖。');
  authorize();
  try { await provider.set(reference(kind), key); }
  catch { throw new ModelKeyError('密钥保存失败，请检查官方凭据服务、文件权限或环境覆盖。'); }
  return modelKeyStatus(provider, kind);
}
