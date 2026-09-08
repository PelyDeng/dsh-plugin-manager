import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ensurePrivateDirectory, writePrivateFile } from '../src/private-files.mjs';

test('private file publication preserves exclusive creation and protects Windows ACL before content', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-private-中文 空格-'));
  t.after(() => { assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const directory = ensurePrivateDirectory(join(root, 'private')), path = join(root, 'secret.conf');
  writePrivateFile(path, 'first', { flag: 'wx' });
  assert.throws(() => writePrivateFile(path, 'second', { flag: 'wx' }), /exist|EEXIST/);
  assert.equal(readFileSync(path, 'utf8'), 'first');
  writePrivateFile(path, 'replacement'); assert.equal(readFileSync(path, 'utf8'), 'replacement');
  if (process.platform === 'win32') {
    const script = '$a=[System.IO.File]::GetAccessControl($env:DSH_TEST_PRIVATE_FILE); $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {$_.IdentityReference.Value}';
    const sids = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, DSH_TEST_PRIVATE_FILE: path }, encoding: 'utf8', windowsHide: true });
    assert.doesNotMatch(sids, /S-1-1-0\b|S-1-5-11\b|S-1-5-32-545\b/);
    assert.match(sids, /S-1-5-18\b/);
  } else assert.equal(statSync(directory).mode & 0o777, 0o700);
  const outside = join(root, 'outside'); mkdirSync(outside);
  const alias = join(root, 'alias'); symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => ensurePrivateDirectory(join(alias, 'escape')), /目录联接/);
  assert.equal(existsSync(join(outside, 'escape')), false);
});
