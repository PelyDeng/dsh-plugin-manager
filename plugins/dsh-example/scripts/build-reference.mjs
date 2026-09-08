/** Snapshot explicitly selected public framework sources, never the deployer's runtime files. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const directories = ['packages/plugin-manager', 'packages/plugin-kit', 'plugins/dsh-auth', 'plugins/dsh-example', 'scripts', 'deploy', 'integrations', 'examples', 'doc', '.github'];
const ignored = new Set(['node_modules', 'dist', 'lib', '.local', '.git', 'coverage', 'assets', 'vendor']);
const extensions = new Set(['.ts', '.mts', '.mjs', '.js', '.md', '.sh', '.ps1', '.html', '.css', '.yml', '.yaml', '.Dockerfile', '.example', '.template']);
const metadata = new Set(['package.json', 'tsconfig.json', 'site.defaults.json', 'Dockerfile']);

export function buildReference(root, output) {
  root = resolve(root);
  if (JSON.parse(readFileSync(join(root, 'package.json'))).name !== 'dsh-plugin-manager-workspace') throw new Error('源码索引需要显式指定框架 workspace 根目录。');
  const files = [];
  function visit(path) {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const relative = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('公开源码索引不接受符号链接。');
      if (entry.isDirectory()) visit(relative);
      else if (extensions.has(extname(entry.name)) || metadata.has(entry.name)) {
        files.push({ path: relative, text: readFileSync(join(root, relative), 'utf8') });
      }
    }
  }
  for (const path of directories) if (existsSync(join(root, path))) {
    const parts = path.split('/');
    for (let count = 1; count <= parts.length; count++) if (lstatSync(join(root, ...parts.slice(0, count))).isSymbolicLink()) throw new Error('公开源码索引不接受符号链接。');
    visit(path);
  }
  for (const path of ['README.md', 'README.en.md', 'package.json', 'pnpm-workspace.yaml', 'env.conf', 'build.sh', 'build.ps1', 'test-report.sh']) if (existsSync(join(root, path))) {
    if (lstatSync(join(root, path)).isSymbolicLink()) throw new Error('公开源码索引不接受符号链接。');
    const text = readFileSync(join(root, path), 'utf8');
    if (path === 'env.conf' && text.split(/\r?\n/u).map(line => line.trim()).some(line => line && !line.startsWith('#') && !/^[A-Z][A-Z0-9_]*=$/u.test(line))) throw new Error('公开env.conf只能包含空值，不能将真实配置加入源码索引。');
    files.push({ path, text });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const revision = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 12);
  const value = { schemaVersion: 1, revision, files };
  if (files.length > 1500 || Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024 || files.some(file => file.text.split('\n').some(line => line.length > 19000))) throw new Error('公共源码索引超过交付上限，不能截断。');
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(value));
  return { revision, files: files.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--root') throw new Error('用法：build-reference.mjs --root <框架根目录>');
  const output = fileURLToPath(new URL('../dist/framework-reference.json', import.meta.url));
  console.log(JSON.stringify(buildReference(process.argv[3], output)));
}
