/** Exercise public archives and external source consumers without repository-relative imports. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPnpm } from '../packages/plugin-manager/src/run-plugin-task.mjs';
import { packagePlugins } from '../packages/plugin-manager/src/package-plugins.mjs';
import { spawnSync } from 'node:child_process';
import { frameworkVersion } from './version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = frameworkVersion(root);
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
    '@dsh-plugin-manager/plugin-manager': 'file:../plugin-manager.tgz', '@dsh-plugin-manager/plugin-kit': 'file:../plugin-kit.tgz',
  } });
  const policy = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').replace(/packages:[\s\S]*?nodeLinker:/, 'packages: []\nautoInstallPeers: false\nnodeLinker:');
  writeFileSync(join(consumer, 'pnpm-workspace.yaml'), policy);
  runPnpm(['install', '--ignore-scripts'], consumer);
  for (const name of ['plugin-kit', 'plugin-manager']) {
    assert.equal(JSON.parse(readFileSync(join(consumer, 'node_modules/@dsh-plugin-manager', name, 'package.json'))).version, version);
  }
  assert.equal(existsSync(join(consumer, 'node_modules/@deepseek-ai/cordis')), false);
  run(['--input-type=module', '-e', "import {restoreSessionSnapshot,mergeLegacyFeedback} from '@dsh-plugin-manager/plugin-manager/session-snapshot'; if(typeof restoreSessionSnapshot!=='function'||typeof mergeLegacyFeedback!=='function') throw Error('snapshot export');"], consumer);
  assert.equal(existsSync(join(consumer, 'node_modules/@deepseek-ai/dsh-tools')), false);
  const cli = join(consumer, 'node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs');
  assert.equal(run([cli, '--version']).trim(), version);
  const paths = JSON.parse(run([cli, 'paths', '--root', project]));
  assert.equal(paths.home, join(project, '.local/data/dsh-home'));
  assert.notEqual(spawnSync(process.execPath, [cli, 'paths'], { cwd: consumer }).status, 0);
  run(['--input-type=module', '-e', "import {isPluginPath} from '@dsh-plugin-manager/plugin-kit/route-path'; if(!isPluginPath('/example')) throw Error('route leaf'); import('@dsh-plugin-manager/plugin-manager');"], consumer);
  run(['--input-type=module', '-e', "import {deepSeekKeyStatus,setDeepSeekKey} from '@dsh-plugin-manager/plugin-kit/deepseek-key'; const status=await deepSeekKeyStatus(); if(status.supported || status.fingerprint) throw Error('credential leaf');"], consumer);
  assert.match(run([cli, 'set-api-key', '--help']), /无需重启/u);

  const kitConsumer = JSON.parse(readFileSync(join(consumer, 'package.json')));
  kitConsumer.devDependencies = { '@deepseek-ai/cordis': '4.0.2', typescript: '^6.0.3', '@types/node': '^22.20.0' };
  json(join(consumer, 'package.json'), kitConsumer);
  runPnpm(['install', '--ignore-scripts', '--no-frozen-lockfile'], consumer);
  writeFileSync(join(consumer, 'check.ts'), "import { actorKey, type Actor } from '@dsh-plugin-manager/plugin-kit/access';\nimport { conversationQuery, type ConversationQuery } from '@dsh-plugin-manager/plugin-kit/conversations';\nconst actor: Actor = {namespace:'standalone',userId:'local'};\nactorKey(actor);\nconst query: ConversationQuery = conversationQuery(new URLSearchParams());\nvoid query;\n");
  runPnpm(['exec', 'tsc', '--strict', '--noEmit', '--types', 'node', '--module', 'NodeNext', '--target', 'ES2022', 'check.ts'], consumer);
  writeFileSync(join(consumer, 'models.ts'), "import { conversationModel, defaultConversationModel, type ConversationModel } from '@dsh-plugin-manager/plugin-kit/models';\nvoid conversationModel; void defaultConversationModel; const model: ConversationModel={provider:'test',model:'test'}; void model;\n");
  runPnpm(['exec', 'tsc', '--strict', '--noEmit', '--types', 'node', '--module', 'NodeNext', '--target', 'ES2022', 'models.ts'], consumer);
  assert.equal(existsSync(join(consumer, 'node_modules/@deepseek-ai/dsh-tools')), false);

  run(['--input-type=module', '-e', "import {conversationQuery} from '@dsh-plugin-manager/plugin-kit/conversations'; if(conversationQuery(new URLSearchParams()).limit!==30) throw Error('conversation leaf');"], consumer);

  const externalAuth = join(temporary, 'external auth'); mkdirSync(externalAuth);
  for (const path of ['src', 'web', 'cordis.patch.yml', 'tsconfig.json', 'tsdown.config.ts']) cpSync(join(root, 'plugins/dsh-auth', path), join(externalAuth, path), { recursive: true });
  const authMetadata = JSON.parse(readFileSync(join(root, 'plugins/dsh-auth/package.json')));
  authMetadata.devDependencies['@dsh-plugin-manager/plugin-kit'] = 'file:../plugin-kit.tgz';
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
  for (const path of ['src', 'web', 'knowledge', 'scripts', 'cordis.patch.yml', 'tsconfig.json', 'tsdown.config.ts', 'tsdown.web.config.ts']) cpSync(join(root, 'plugins/dsh-example', path), join(external, path), { recursive: true });
  const metadata = { ...original, devDependencies: { ...original.devDependencies, '@dsh-plugin-manager/plugin-kit': 'file:../plugin-kit.tgz' } };
  // Independent authors supply the framework root explicitly, never relative to their checkout.
  delete metadata.devDependencies['dsh-auth'];
  metadata.scripts = { ...original.scripts, build: 'tsdown && tsdown --config tsdown.web.config.ts' };
  json(join(external, 'package.json'), metadata);
  writeFileSync(join(external, 'pnpm-workspace.yaml'), policy);
  runPnpm(['install', '--ignore-scripts'], external);
  runPnpm(['build'], external);
  const invalidReference = spawnSync(process.execPath, [join(external, 'scripts/build-reference.mjs'), '--root'], { cwd: external, encoding: 'utf8' });
  assert.notEqual(invalidReference.status, 0);
  assert.match(invalidReference.stderr, /用法：build-reference\.mjs/u);
  assert.doesNotMatch(invalidReference.stderr, /ERR_MODULE_NOT_FOUND/);
  run([join(external, 'scripts/build-reference.mjs'), '--root', root], external);
  const reference = JSON.parse(readFileSync(join(external, 'dist/framework-reference.json')));
  assert.ok(reference.files.some(file => file.path === '.github/workflows/check.yml'));
  assert.ok(reference.files.some(file => file.path === 'packages/plugin-kit/src/route-path.d.mts'));
  runPnpm(['typecheck'], external);
  const plugins = JSON.parse(readFileSync(join(releasePath, 'manifest.json'))).plugins;
  const installed = JSON.parse(readFileSync(join(consumer, 'package.json')));
  for (const plugin of plugins) installed.dependencies[plugin.package] = `file:../release/${plugin.archive}`;
  Object.assign(installed.devDependencies, original.devDependencies);
  delete installed.devDependencies['@dsh-plugin-manager/plugin-kit'];
  delete installed.devDependencies['dsh-auth'];
  json(join(consumer, 'package.json'), installed);
  runPnpm(['install', '--ignore-scripts', '--no-frozen-lockfile'], consumer);
  writeFileSync(join(consumer, 'check.ts'), "import * as auth from 'dsh-auth';\nimport * as example from 'dsh-example';\nvoid auth.apply; void example.apply;\n");
  runPnpm(['exec', 'tsc', '--strict', '--noEmit', '--types', 'node', '--module', 'NodeNext', '--target', 'ES2022', 'check.ts'], consumer);
  run(['--input-type=module', '-e', "await import('dsh-auth'); await import('dsh-example');"], consumer);
  for (const plugin of plugins) {
    const manifest = JSON.parse(readFileSync(join(consumer, 'node_modules', plugin.package, 'package.json')));
    assert.equal(plugin.version, version);
    assert.equal(manifest.version, version);
    assert.ok(!Object.values(manifest.dependencies ?? {}).some(spec => /^(workspace:|file:|link:)/.test(spec)));
    assert.ok(existsSync(join(consumer, 'node_modules', plugin.package, 'web/index.html')));
  }
  run(['--input-type=module', '-e', `import { loadRelease } from '@dsh-plugin-manager/plugin-manager'; const release=loadRelease(${JSON.stringify(join(releasePath, 'manifest.json'))}); if(release.plugins.length!==2) throw Error('release');`], consumer);
  console.log('Archive checks passed: host-free manager and route leaf, minimal access/conversation types, external auth/example source, plugin JS/types/assets and source-free release validation.');
} finally {
  assert.equal(dirname(temporary), realpathSync.native(tmpdir()));
  rmSync(temporary, { recursive: true, force: true });
}
