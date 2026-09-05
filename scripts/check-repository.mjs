/** Check the public source tree, local documentation links and package declarations. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
let checked = 0;
for (const name of new Set(files)) {
  if (name === 'deepseek-harness') continue;
  const path = resolve(root, name);
  assert.ok(!name.split('/').some(part => ['.local', 'data', 'deploy-artifacts', 'node_modules', 'dist', 'env.conf', '.env'].includes(part)), `Non-source file: ${name}`);
  assert.ok(!name.endsWith('.tgz'), `Archive in Git: ${name}`);
  assert.ok(existsSync(path) && lstatSync(path).isFile(), `Expected regular source file: ${name}`);
  if (!/\.(?:md|mjs|js|ts|json|ya?ml|sh|ps1)$/.test(name)) continue;
  const content = readFileSync(path, 'utf8');
  assert.ok(content.endsWith('\n') && !content.endsWith('\n\n'), `Expected one final newline: ${name}`);
  if (name.endsWith('.md')) {
    const prose = content.replace(/```[\s\S]*?```/g, '');
    for (const match of prose.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z]+:|^\/\//i.test(target)) continue;
      assert.ok(existsSync(resolve(dirname(path), decodeURIComponent(target))), `Broken link in ${name}: ${target}`);
    }
  }
  if (/^(packages|plugins)\/[^/]+\/package.json$/.test(name)) {
    const manifest = JSON.parse(content);
    assert.equal(manifest.license, 'Apache-2.0', `License: ${name}`);
    assert.ok(existsSync(resolve(dirname(path), 'LICENSE')), `Missing license: ${name}`);
    assert.ok(existsSync(resolve(dirname(path), 'README.md')), `Missing README: ${name}`);
  }
  checked++;
}
console.log(`Checked ${checked} public source files and local documentation links.`);
