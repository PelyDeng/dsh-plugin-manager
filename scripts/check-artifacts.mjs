/** Exercise public archives and external source consumers without repository-relative imports. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPnpm } from '../packages/plugin-manager/src/run-plugin-task.mjs';
import { packagePlugins } from '../packages/plugin-manager/src/package-plugins.mjs';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh archives with spaces ')));
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const run = (args, cwd = temporary) => {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
try {
  for (const name of ['plugin-kit', 'plugin-manager']) {
    runPnpm(['pack', '--out', join(temporary, `${name}.tgz`)], join(root, 'packages', name));
  }
  const project = join(temporary, 'empty project'); mkdirSync(project);
  const consumer = join(temporary, 'consumer'); mkdirSync(consumer);
  json(join(consumer, 'package.json'), { private: true, type: 'module', packageManager: 'pnpm@11.19.0', dependencies: {
    '@dsh-plugin/plugin-manager': 'file:../plugin-manager.tgz', '@dsh-plugin/plugin-kit': 'file:../plugin-kit.tgz',
  } });
  const policy = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').replace(/packages:[\s\S]*?nodeLinker:/, 'packages: []\nautoInstallPeers: false\nnodeLinker:');
  writeFileSync(join(consumer, 'pnpm-workspace.yaml'), policy);
  runPnpm(['install', '--ignore-scripts'], consumer);
  assert.equal(existsSync(join(consumer, 'node_modules/@deepseek-ai/cordis')), false);
  assert.equal(existsSync(join(consumer, 'node_modules/@deepseek-ai/dsh-tools')), false);
  const cli = join(consumer, 'node_modules/@dsh-plugin/plugin-manager/dist/cli.mjs');
  const paths = JSON.parse(run([cli, 'paths', '--root', project]));
  assert.equal(paths.home, join(project, '.local/data/dsh-home'));
  assert.notEqual(spawnSync(process.execPath, [cli, 'paths'], { cwd: consumer }).status, 0);
  run(['--input-type=module', '-e', "import {isPluginPath} from '@dsh-plugin/plugin-kit/route-path'; if(!isPluginPath('/example')) throw Error('route leaf'); import('@dsh-plugin/plugin-manager');"], consumer);

  const kitConsumer = JSON.parse(readFileSync(join(consumer, 'package.json')));
  kitConsumer.devDependencies = { '@deepseek-ai/cordis': '4.0.2', typescript: '^6.0.3', '@types/node': '^22.20.0' };
  json(join(consumer, 'package.json'), kitConsumer);
  runPnpm(['install', '--ignore-scripts', '--no-frozen-lockfile'], consumer);
  writeFileSync(join(consumer, 'check.ts'), "import { actorKey, type Actor } from '@dsh-plugin/plugin-kit/access';\nconst actor: Actor = {namespace:'standalone',userId:'local'};\nactorKey(actor);\n");
  runPnpm(['exec', 'tsc', '--strict', '--noEmit', '--types', 'node', '--module', 'NodeNext', '--target', 'ES2022', 'check.ts'], consumer);
  assert.equal(existsSync(join(consumer, 'node_modules/@deepseek-ai/dsh-tools')), false);

  const externalAuth = join(temporary, 'external auth'); mkdirSync(externalAuth);
  for (const path of ['src', 'web', 'cordis.patch.yml', 'tsconfig.json', 'tsdown.config.ts']) cpSync(join(root, 'plugins/dsh-auth', path), join(externalAuth, path), { recursive: true });
  const authMetadata = JSON.parse(readFileSync(join(root, 'plugins/dsh-auth/package.json')));
  authMetadata.devDependencies['@dsh-plugin/plugin-kit'] = 'file:../plugin-kit.tgz';
  json(join(externalAuth, 'package.json'), authMetadata);
  writeFileSync(join(externalAuth, 'pnpm-workspace.yaml'), policy);
  runPnpm(['install', '--ignore-scripts'], externalAuth);
  runPnpm(['build'], externalAuth);
  runPnpm(['typecheck'], externalAuth);
  assert.equal(existsSync(join(externalAuth, 'node_modules/@deepseek-ai/dsh-tools')), false);

  const releasePath = join(temporary, 'release');
  packagePlugins(root, 'auth,example', releasePath);
  const original = JSON.parse(readFileSync(join(root, 'plugins/dsh-example/package.json')));
  const external = join(temporary, 'external example'); mkdirSync(external);
  for (const path of ['src', 'web', 'knowledge', 'cordis.patch.yml', 'tsconfig.json', 'tsdown.config.ts', 'tsdown.web.config.ts']) cpSync(join(root, 'plugins/dsh-example', path), join(external, path), { recursive: true });
  const metadata = { ...original, devDependencies: { ...original.devDependencies, '@dsh-plugin/plugin-kit': 'file:../plugin-kit.tgz' } };
  json(join(external, 'package.json'), metadata);
  writeFileSync(join(external, 'pnpm-workspace.yaml'), policy);
  runPnpm(['install', '--ignore-scripts'], external);
  runPnpm(['build'], external);
  runPnpm(['typecheck'], external);
  const plugins = JSON.parse(readFileSync(join(releasePath, 'manifest.json'))).plugins;
  const installed = JSON.parse(readFileSync(join(consumer, 'package.json')));
  for (const plugin of plugins) installed.dependencies[plugin.package] = `file:../release/${plugin.archive}`;
  Object.assign(installed.devDependencies, original.devDependencies);
  delete installed.devDependencies['@dsh-plugin/plugin-kit'];
  json(join(consumer, 'package.json'), installed);
  runPnpm(['install', '--ignore-scripts', '--no-frozen-lockfile'], consumer);
  writeFileSync(join(consumer, 'check.ts'), "import * as auth from 'dsh-auth';\nimport * as example from 'dsh-example';\nvoid auth.apply; void example.apply;\n");
  runPnpm(['exec', 'tsc', '--strict', '--noEmit', '--types', 'node', '--module', 'NodeNext', '--target', 'ES2022', 'check.ts'], consumer);
  run(['--input-type=module', '-e', "await import('dsh-auth'); await import('dsh-example');"], consumer);
  for (const plugin of plugins) {
    const manifest = JSON.parse(readFileSync(join(consumer, 'node_modules', plugin.package, 'package.json')));
    assert.ok(!Object.values(manifest.dependencies ?? {}).some(spec => /^(workspace:|file:|link:)/.test(spec)));
    assert.ok(existsSync(join(consumer, 'node_modules', plugin.package, 'web/index.html')));
  }
  run(['--input-type=module', '-e', `import { loadRelease } from '@dsh-plugin/plugin-manager'; const release=loadRelease(${JSON.stringify(join(releasePath, 'manifest.json'))}); if(release.plugins.length!==2) throw Error('release');`], consumer);
  console.log('Archive checks passed: host-free manager and route leaf, minimal access types, external example source, plugin JS/types/assets and source-free release validation.');
} finally {
  assert.equal(dirname(temporary), realpathSync.native(tmpdir()));
  rmSync(temporary, { recursive: true, force: true });
}
