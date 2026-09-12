/** Check the public source tree, local documentation links and package declarations. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublicFrameworkConfig } from '../packages/plugin-manager/src/framework-config.mjs';
import { frameworkVersion } from './version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
frameworkVersion(root);
// Repository rules apply even to force-added files; personal Git excludes are not project policy.
const ignoredTracked = execFileSync('git', ['ls-files', '--cached', '--ignored', '--exclude-per-directory=.gitignore', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
assert.equal(ignoredTracked.length, 0, `Ignored files tracked by Git:\n${ignoredTracked.join('\n')}`);
const deleted = new Set(execFileSync('git', ['ls-files', '--deleted', '-z'], { cwd: root, encoding: 'utf8' }).split('\0'));
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(name => name && !deleted.has(name));
const vendorArchives = new Set();
// 声明来源包括插件自身的清单，以及插件内嵌套子包的清单（例如群组插件的 agents/* 与
// packages/*）。子包同样可能携带 vendor 归档，只扫顶层会把它误判为未声明。
const manifestPattern = /^plugins\/[^/]+\/(?:[^/]+\/)*package\.json$/;
for (const name of files.filter(name => manifestPattern.test(name))) {
  const manifest = JSON.parse(readFileSync(resolve(root, name), 'utf8'));
  for (const spec of Object.values(manifest.devDependencies ?? {})) {
    if (typeof spec === 'string' && /^file:(?:\.\/)?vendor\/[a-zA-Z0-9._-]+\.tgz$/.test(spec)) {
      vendorArchives.add(resolve(root, dirname(name), spec.slice(5)));
    }
  }
}
let checked = 0;
for (const name of new Set(files)) {
  if (name === 'deepseek-harness') continue;
  const path = resolve(root, name);
  assert.ok(name === 'env.conf' || !name.split('/').some(part => ['.local', 'data', 'deploy-artifacts', 'node_modules', 'dist', 'env.conf', '.env'].includes(part)), `Non-source file: ${name}`);
  assert.ok(!name.endsWith('.tgz') || vendorArchives.has(path), `Undeclared vendor archive in Git: ${name}`);
  assert.ok(existsSync(path) && lstatSync(path).isFile(), `Expected regular source file: ${name}`);
  if (name === 'env.conf') {
    assertPublicFrameworkConfig(readFileSync(path, 'utf8'));
  }
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
    assert.ok(typeof manifest.license === 'string' && manifest.license.length, `Missing license declaration: ${name}`);
    if (manifest.license === 'UNLICENSED') assert.equal(manifest.private, true, `Unlicensed package must be private: ${name}`);
    assert.ok(existsSync(resolve(dirname(path), 'LICENSE')), `Missing license: ${name}`);
    assert.ok(existsSync(resolve(dirname(path), 'README.md')), `Missing README: ${name}`);
  }
  checked++;
}
console.log(`Checked ${checked} public source files and local documentation links.`);
