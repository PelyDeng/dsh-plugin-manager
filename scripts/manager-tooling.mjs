/** Build only the manager closure; authors' plugin sources never enter this workspace. */
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { commandSpec, normalizeEnvironment } from '../packages/plugin-manager/src/process.mjs';

const isolated = ['--config.node-linker=isolated', '--config.dedupe-peer-dependents=false'];
export const managerToolInputs = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'packages/plugin-kit', 'packages/plugin-manager'];

function command(bin, args, options) {
  const cli = commandSpec(bin, options);
  const result = spawnSync(cli.command, [...cli.prefix, ...args], { windowsHide: true, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Object.assign(new Error(`管理器工具准备失败：${bin} ${args[0]} (${result.status ?? result.signal})`), { signal: result.signal });
  return result.stdout?.trim() ?? '';
}

/** Shared by the disposable local workspace and the Docker manager-builder stage. */
export function buildManagerArchive({ root, archive, execute = command, env = normalizeEnvironment(process.env) }) {
  if (!root || !archive) throw new Error('Manager tooling requires explicit root and archive paths.');
  root = resolve(root); archive = resolve(archive);
  if (existsSync(archive)) throw new Error(`管理器归档已存在，请使用新的输出位置：${archive}`);
  mkdirSync(dirname(archive), { recursive: true });
  const run = args => execute('pnpm', [...isolated, ...args], { cwd: root, env });
  run(['--filter', 'dsh-plugin-manager-workspace', '--filter', '@dsh-plugin-manager/plugin-manager...', 'install', '--frozen-lockfile']);
  for (const name of ['plugin-kit', 'plugin-manager']) run(['--filter', `@dsh-plugin-manager/${name}`, 'build']);
  run(['--filter', '@dsh-plugin-manager/plugin-manager', 'pack', '--out', archive]);
  if (!existsSync(archive)) throw new Error('管理器构建未生成归档。');
  return archive;
}

/** Source builds and release packaging install the same verified, relocatable archive. */
export function installManagerArchive({ archive, output, version, execute = command, env = normalizeEnvironment(process.env) }) {
  if (!archive || !output || !version) throw new Error('Manager installation requires archive, output and version.');
  archive = resolve(archive); output = resolve(output);
  if (!lstatSync(archive).isFile() || lstatSync(archive).isSymbolicLink()) throw new Error('Manager archive must be a regular file.');
  mkdirSync(output, { recursive: true });
  const installedArchive = resolve(output, 'plugin-manager.tgz');
  if (readdirSync(output).some(name => name !== 'plugin-manager.tgz') || (existsSync(installedArchive) && installedArchive !== archive)) throw new Error(`工具输出目录必须为空：${output}`);
  const bytes = readFileSync(archive);
  if (installedArchive !== archive) copyFileSync(archive, installedArchive);
  // npm otherwise walks to a parent package and can modify the source workspace.
  writeFileSync(resolve(output, 'package.json'), '{"private":true,"type":"module"}\n', { flag: 'wx' });
  execute('npm', ['install', '--prefix', output, '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--bin-links=false', './plugin-manager.tgz'], { cwd: output, env });
  const packageRoot = resolve(output, 'node_modules/@dsh-plugin-manager/plugin-manager');
  const cli = resolve(packageRoot, 'dist/cli.mjs');
  const metadata = JSON.parse(readFileSync(resolve(packageRoot, 'package.json')));
  if (metadata.name !== '@dsh-plugin-manager/plugin-manager' || metadata.version !== version || !existsSync(cli)) throw new Error('管理器归档名称、版本或入口不匹配。');
  const actual = execute(process.execPath, [cli, '--version'], { cwd: output, env, stdio: 'pipe', encoding: 'utf8' });
  if (actual.trim() !== version || !readFileSync(installedArchive).equals(bytes) || !readFileSync(archive).equals(bytes)) throw new Error('已安装工具版本或归档内容不一致。');
  execute(process.execPath, [cli, 'paths', '--root', resolve(output, 'verification-project')], { cwd: output, env, stdio: 'pipe', encoding: 'utf8' });
  return { archive: installedArchive, sha256: createHash('sha256').update(bytes).digest('hex'), cli, toolRoot: output };
}

/** A real installation produces the same self-contained tooling layout as the deployment zip. */
export function prepareManagerTooling({ root, output, execute = command, env = normalizeEnvironment(process.env) }) {
  if (!root || !output) throw new Error('Manager tooling requires explicit root and output paths.');
  root = resolve(root); output = resolve(output);
  if (existsSync(output) && readdirSync(output).length) throw new Error(`工具输出目录必须为空：${output}`);
  mkdirSync(output, { recursive: true });
  const parent = realpathSync(tmpdir());
  const source = realpathSync(mkdtempSync(resolve(parent, 'dsh-manager-source-')));
  const archive = resolve(output, 'plugin-manager.tgz');
  try {
    for (const input of managerToolInputs) cpSync(resolve(root, input), resolve(source, input), {
      recursive: true,
      filter: path => {
        if (['node_modules', 'dist', 'coverage', '.git', '.local'].includes(path.split(/[\\/]/u).at(-1))) return false;
        if (lstatSync(path).isSymbolicLink()) throw new Error(`管理器源码输入不能是链接：${path}`);
        return true;
      },
    });
    buildManagerArchive({ root: source, archive, execute, env });
    const version = JSON.parse(readFileSync(resolve(root, 'packages/plugin-manager/package.json'))).version;
    return installManagerArchive({ archive, output, version, execute, env });
  } finally {
    if (dirname(source) !== parent || !source.startsWith(resolve(parent, 'dsh-manager-source-'))) throw new Error('Unsafe temporary tooling cleanup path.');
    rmSync(source, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), values = {};
    while (args.length) {
      const flag = args.shift();
      if (!['--root', '--archive', '--output'].includes(flag) || values[flag] || !args[0] || args[0].startsWith('--')) throw new Error('用法：manager-tooling.mjs --root <源码根> (--archive <tgz> | --output <工具目录>)');
      values[flag] = args.shift();
    }
    if (!values['--root'] || Boolean(values['--archive']) === Boolean(values['--output'])) throw new Error('必须明确源码根，并选择 archive 或 output。');
    if (values['--archive']) buildManagerArchive({ root: values['--root'], archive: values['--archive'] });
    else prepareManagerTooling({ root: values['--root'], output: values['--output'] });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
