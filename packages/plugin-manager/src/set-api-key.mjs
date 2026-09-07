/** Store a DeepSeek API key in the selected DSH home without restarting services. */
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { setDeepSeekKey, validateDeepSeekKey } from '@dsh-plugin-manager/plugin-kit/deepseek-key';
import { checkDataSelection, parseArguments, resolveDeployment } from './deployment.mjs';
import { hostCLI } from './process.mjs';
import { canonical } from './state.mjs';

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

/** Select the active Compose service only when its DSH home is this deployment's home. */
export function credentialContainer(deployment, execute = spawnSync) {
  const path = join(deployment.artifacts, 'active-compose.json');
  if (!existsSync(path)) return undefined;
  try {
    const active = JSON.parse(readFileSync(path, 'utf8'));
    if (active.project !== (deployment.config.composeProject ?? 'dsh-plugins') || !/^[a-z0-9][a-z0-9_-]*$/u.test(active.project) || !existsSync(active.path)) throw new Error();
    const selected = execute('docker', ['compose', '-p', active.project, '-f', active.path, 'ps', '-q', 'dsh'], { encoding: 'utf8' });
    const id = selected.stdout?.trim();
    if (selected.status !== 0 || !/^[a-f0-9]{12,64}$/u.test(id ?? '')) throw new Error();
    const inspected = execute('docker', ['inspect', id], { encoding: 'utf8' });
    if (inspected.status !== 0) throw new Error();
    const [container] = JSON.parse(inspected.stdout);
    const home = container.Config.Env.find(value => value.startsWith('DSH_HOME='))?.slice(9);
    const mount = container.Mounts.filter(item => item.Type === 'bind' && (home === item.Destination || home?.startsWith(`${item.Destination}/`)))
      .sort((a, b) => b.Destination.length - a.Destination.length)[0];
    if (!container.State.Running || !mount?.RW || canonical(resolve(mount.Source, posix.relative(mount.Destination, home))) !== canonical(deployment.home)) throw new Error();
    return id;
  } catch { throw new Error('无法确认本项目正在运行的 Compose 容器及 DSH home；未修改密钥，请核对部署配置。'); }
}

/** Use the already-installed host's native writer, including its cross-process lock. */
export async function storeApiKey(deployment, key) {
  validateDeepSeekKey(key);
  checkDataSelection(deployment);
  const home = statSync(deployment.home, { throwIfNoEntry: false });
  if (!home?.isDirectory()) throw new Error('请先安装并启动宿主，再配置 API 密钥。');
  const file = lstatSync(join(deployment.home, '.credentials.yaml'), { throwIfNoEntry: false });
  if (file && !file.isFile()) throw new Error('凭据路径必须为普通文件。');
  if (process.platform !== 'win32' && [home, file].filter(Boolean).some(info => info.uid !== process.getuid())) {
    throw new Error('请以 DSH 数据所有者运行脚本；Compose 部署请在项目目录使用根脚本自动进入容器。');
  }
  let ctx, fiber;
  try {
    const cli = hostCLI(deployment);
    const entry = cli.prefix.at(-1);
    if (!entry || !existsSync(entry)) throw new Error();
    const require = createRequire(realpathSync(entry));
    const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
    const { LocalCredentialProvider, CREDENTIALS_FILENAME } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-credentials-local')).href);
    if (CREDENTIALS_FILENAME !== '.credentials.yaml') throw new Error();
    ctx = new Context();
    fiber = ctx.plugin(LocalCredentialProvider, { dshHome: deployment.home, watch: false });
    await fiber;
    return await setDeepSeekKey(ctx.get('credentials'), key);
  } catch {
    throw new Error('无法更新官方凭据：请核对已安装的 DSH CLI、凭据文件权限及外部环境覆盖。');
  } finally { if (fiber) await fiber.dispose(); }
}

/** Use the deployment path rules and accept secrets exclusively through stdin. */
export async function main(args = process.argv.slice(2)) {
  let options;
  try { options = parseArguments(['set-api-key', ...args]); }
  catch { throw new Error('参数无效；密钥只能经 stdin 输入，不能放入命令参数。'); }
  const allowed = new Set(['action', 'root', 'config', 'home', 'data-root', 'profile', 'dsh-cli-js', 'help']);
  if (Object.keys(options).some(key => !allowed.has(key))) throw new Error('只接受部署路径、profile 和 --dsh-cli-js 参数；密钥必须经 stdin 输入。');
  if (options.help) { console.log('set-api-key --root <project> [--config path] [--home path] [--data-root path] [--profile name] [--dsh-cli-js path]\n服务器源码部署：bash deploy/scripts/set-api-key.sh --config .local/deployment.json\n隐藏输入，复用官方 .credentials.yaml 存储；默认宿主自动热更新，无需重启。也可在 /auth 的模型设置中更换。'); return; }
  let deployment;
  try { deployment = resolveDeployment(options); }
  catch { throw new Error('无法解析部署配置或路径，请先通过 deployment.mjs paths 核对配置。'); }
  checkDataSelection(deployment);
  const container = credentialContainer(deployment);
  const key = await readApiKey();
  validateDeepSeekKey(key);
  if (container) {
    const result = spawnSync('docker', ['exec', '-i', container, 'node', '/opt/plugin-manager/node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs', 'set-api-key', '--root', '/opt/plugin-project', '--config', '/run/dsh-deployment.json'], { input: key, encoding: 'utf8', timeout: 60000 });
    if (result.status !== 0) throw new Error('容器内更新失败，请检查运行镜像是否已更新、数据权限及外部环境覆盖。');
  } else await storeApiKey(deployment, key);
  console.log('API 密钥已保存到官方凭据存储。默认宿主自动热更新，无需重启；后续请求使用新密钥。');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
