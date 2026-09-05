/** Store a DeepSeek API key in the selected DSH home without restarting services. */
import { randomUUID } from 'node:crypto';
import { chmodSync, chownSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDataSelection, parseArguments, resolveDeployment } from './deployment.mjs';

/** Read a single key from stdin; interactive input uses raw mode and is never echoed. */
export async function readApiKey(input = process.stdin, output = process.stderr) {
  if (!input.isTTY) {
    const chunks = []; let size = 0;
    try {
      for await (const chunk of input) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 4096) throw new Error('密钥输入过长，未修改配置。');
        chunks.push(buffer);
      }
      return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/u, '');
    } finally { for (const chunk of chunks) chunk.fill(0); }
  }
  if (typeof input.setRawMode !== 'function') throw new Error('此终端无法隐藏输入，请使用安全的 stdin 管道。');
  output.write('请输入 DeepSeek API 密钥（输入不显示）：');
  const wasRaw = input.isRaw;
  input.setRawMode(true); input.resume();
  return await new Promise((resolveKey, reject) => {
    let key = '';
    const finish = error => {
      input.off('data', onData); input.off('end', onEnd); input.off('error', finish);
      input.setRawMode(Boolean(wasRaw)); input.pause(); output.write('\n');
      if (error) reject(error); else resolveKey(key);
      key = '';
    };
    const onEnd = () => finish(new Error('输入已结束，未修改配置。'));
    const onData = data => {
      for (const character of data.toString('utf8')) {
        if (character === '\u0003' || character === '\u0004') { finish(new Error('已取消，未修改配置。')); return; }
        if (character === '\r' || character === '\n') { finish(); return; }
        if (character === '\u007f' || character === '\b') key = key.slice(0, -1);
        else key += character;
        if (key.length > 4096) { finish(new Error('密钥输入过长，未修改配置。')); return; }
      }
    };
    input.on('data', onData); input.once('end', onEnd); input.once('error', finish);
  });
}

/** Atomically replace only DEEPSEEK_API_KEY; other settings and existing ownership remain. */
export function storeApiKey(deployment, key, userHome = homedir()) {
  checkDataSelection(deployment, userHome);
  if (typeof key !== 'string' || key.length > 4096 || !/^sk-[A-Za-z0-9_-]+$/u.test(key)) throw new Error('API 密钥格式无效，未修改配置。');
  const destination = join(deployment.home, '.env');
  const existing = lstatSync(destination, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) throw new Error('.env 必须为普通文件，拒绝替换符号链接。');
  const source = existing ? readFileSync(destination, 'utf8') : '';
  const content = source.split(/\r?\n/u).filter(line => !/^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=/u.test(line));
  while (content.at(-1) === '') content.pop();
  const value = `${content.length ? `${content.join('\n')}\n` : ''}DEEPSEEK_API_KEY=${key}\n`;
  mkdirSync(deployment.home, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, value); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    if (process.platform !== 'win32') {
      if (existing && (existing.uid !== process.getuid() || existing.gid !== process.getgid())) chownSync(temporary, existing.uid, existing.gid);
      chmodSync(temporary, 0o600);
    }
    renameSync(temporary, destination);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
  return destination;
}

/** Use the deployment path rules and accept secrets exclusively through stdin. */
export async function main(args = process.argv.slice(2)) {
  let options;
  try { options = parseArguments(['set-api-key', ...args]); }
  catch { throw new Error('参数无效；密钥只能经 stdin 输入，不能放入命令参数。'); }
  const allowed = new Set(['action', 'root', 'config', 'home', 'data-root', 'profile', 'help']);
  if (Object.keys(options).some(key => !allowed.has(key))) throw new Error('只接受 --root、--config、--home、--data-root 和 --profile；密钥必须经 stdin 输入。');
  if (options.help) { console.log('set-api-key.sh [--config path] [--home path] [--data-root path] [--profile name]'); return; }
  let deployment;
  try { deployment = resolveDeployment(options); }
  catch { throw new Error('无法解析部署配置或路径，请先通过 deployment.mjs paths 核对配置。'); }
  checkDataSelection(deployment);
  const key = await readApiKey();
  const destination = storeApiKey(deployment, key);
  console.log(`API 密钥已写入 ${destination}。未重启服务；请由原服务管理者受控重启。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
