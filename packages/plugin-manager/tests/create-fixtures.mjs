/** Create two inert bundles with colliding npm archive basenames for isolated deployment checks. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [root] = process.argv.slice(2);
if (!root) throw new Error('缺少隔离测试目录。');
mkdirSync(root, { recursive: true });
writeFileSync(resolve(root, 'package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@11.19.0' }) + '\n');
writeFileSync(resolve(root, 'pnpm-workspace.yaml'), "packages:\n  - 'plugins/*'\nnodeLinker: hoisted\n");
writeFileSync(resolve(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n  plugins/plugin-one: {}\n  plugins/plugin-two: {}\n");
for (const [id, name] of [['one', '@fixture/demo'], ['two', 'fixture-demo']]) {
  const directory = resolve(root, `plugins/plugin-${id}`);
  mkdirSync(directory, { recursive: true });
  const manifest = {
    name, version: '1.0.0', description: 'Isolated inert DSH bundle', type: 'module',
    main: './dist/index.mjs', files: ['dist', 'cordis.patch.yml', 'env.conf.example'],
    scripts: { build: 'node build.mjs', check: 'node --check build.mjs' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    deepseekPlugin: { schemaVersion: 3, id },
  };
  if (id === 'one') {
    manifest.deepseekPlugin.runtimeConfig = { variable: 'FIXTURE_ENV', template: 'env.conf.example', required: false };
    manifest.deepseekPlugin.development = { rootVariable: 'FIXTURE_ROOT', patch: 'dev.yml' };
  } else {
    manifest.deepseekPlugin.development = { rootVariable: 'FIXTURE_ROOT_TWO', patch: 'dev.yml' };
  }
  writeFileSync(resolve(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(resolve(directory, 'README.md'), 'Isolated fixture with no business behavior.\n');
  writeFileSync(resolve(directory, 'env.conf.example'), 'FIXTURE_ONLY=1\n');
  writeFileSync(resolve(directory, 'dev.yml'), '[]\n');
  writeFileSync(resolve(directory, 'cordis.patch.yml'), `- insert:\n    - id: fixture-${id}\n      name: '${name}'\n`);
  writeFileSync(resolve(directory, 'build.mjs'), "import {mkdirSync,writeFileSync} from 'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/index.mjs','export function apply() {}\\n');\n");
}
