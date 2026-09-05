import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectHostSource, officialHostUrl } from '../../../integrations/docker/host-source.mjs';

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('pinned official source accepts Git worktrees and refuses drift, dirty input and a different origin', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh source '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init');
  git(root, 'config', 'user.name', 'fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  const host = join(root, 'deepseek-harness');
  mkdirSync(host);
  git(host, 'init');
  git(host, 'config', 'user.name', 'fixture');
  git(host, 'config', 'user.email', 'fixture@example.invalid');
  git(host, 'remote', 'add', 'origin', officialHostUrl);
  writeFileSync(join(host, 'package.json'), JSON.stringify({ version: '1.0.0', packageManager: 'pnpm@11.7.0' }));
  git(host, 'add', 'package.json');
  git(host, 'commit', '-m', 'fixture');
  const commit = git(host, 'rev-parse', 'HEAD');
  writeFileSync(join(root, '.gitmodules'), `[submodule "deepseek-harness"]\n path = deepseek-harness\n url = ${officialHostUrl}\n`);
  git(root, 'add', '.gitmodules');
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${commit},deepseek-harness`);
  git(root, 'commit', '-m', 'pin');
  git(root, 'submodule', 'absorbgitdirs');
  assert.equal(inspectHostSource(root).commit, commit);
  writeFileSync(join(host, 'untracked.txt'), 'not build input');
  assert.throws(() => inspectHostSource(root), /worktree has changes/u);
  rmSync(join(host, 'untracked.txt'));
  git(host, 'remote', 'set-url', 'origin', 'https://example.invalid/fork.git');
  assert.throws(() => inspectHostSource(root), /official HTTPS/u);
  git(host, 'remote', 'set-url', 'origin', officialHostUrl);
  git(host, 'commit', '--allow-empty', '-m', 'drift');
  assert.throws(() => inspectHostSource(root), /differs from the parent gitlink/u);
});

test('an empty submodule directory cannot be mistaken for its parent worktree', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh absent '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init');
  mkdirSync(join(root, 'deepseek-harness'));
  assert.throws(() => inspectHostSource(root), /not an initialized/u);
});
