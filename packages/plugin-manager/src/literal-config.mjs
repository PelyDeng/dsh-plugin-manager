import { lstatSync, readFileSync } from 'node:fs';

/** Literal KEY=VALUE only: never execute shell expansion or expose a rejected value. */
export function parseLiteralConfig(text, allowed) {
  const result = {};
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match || !allowed.has(match[1])) throw new Error(`未知配置字段，行 ${index + 1}。`);
    const key = match[1];
    if (Object.hasOwn(result, key)) throw new Error(`重复配置字段 ${key}，行 ${index + 1}。`);
    let value = match[2].trim();
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { throw new Error(`配置引号格式错误，行 ${index + 1}。`); }
      if (typeof value !== 'string') throw new Error(`配置必须是字面量字符串，行 ${index + 1}。`);
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'") || value.length < 2) throw new Error(`配置引号格式错误，行 ${index + 1}。`);
      value = value.slice(1, -1);
    }
    if (/[\r\n\0]/u.test(value)) throw new Error(`配置包含控制字符，行 ${index + 1}。`);
    result[key] = value;
  }
  return result;
}

/** Read private inputs once; Windows permissions are not POSIX mode bits. */
export function readPrivateConfig(path) {
  const info = lstatSync(path);
  if (!info.isFile()) throw new Error('私有配置必须是普通文件，不能是符号链接。');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('私有配置权限必须为 0600。');
  return readFileSync(path);
}
