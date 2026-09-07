/** Updating a key follows the deployment home selection and never starts a service. */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { readApiKey, storeApiKey } from '../src/set-api-key.mjs';
import { resolveDeployment } from '../src/deployment.mjs';

const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync.native(mkdtempSync(resolve(tmpdir(), 'dsh api key '))); directories.push(root); return root;
}

test('explicit home replaces duplicate key assignments atomically and retains other variables', () => {
  const root = fixture(); const deployment = resolveDeployment({ root, home: 'data/custom home' }, {});
  mkdirSync(deployment.home, { recursive: true });
  writeFileSync(resolve(deployment.home, '.env'), '# models\r\nDEEPSEEK_BASE_URL=https://example.invalid\r\nexport DEEPSEEK_API_KEY=sk-old\r\nOTHER_KEY=unchanged\r\nDEEPSEEK_API_KEY=sk-duplicate\r\n');
  const path = storeApiKey(deployment, 'sk-fixture-new', resolve(root, 'fake user'));
  assert.equal(path, resolve(root, 'data/custom home/.env'));
  assert.equal(readFileSync(path, 'utf8'), '# models\nDEEPSEEK_BASE_URL=https://example.invalid\nOTHER_KEY=unchanged\nDEEPSEEK_API_KEY=sk-fixture-new\n');
  assert.deepEqual(readdirSync(deployment.home), ['.env']);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('legacy data ambiguity and invalid input do not create a new home or replace a key', () => {
  const root = fixture(); const user = resolve(root, 'fake-user'); mkdirSync(resolve(user, '.dsh'), { recursive: true });
  const deployment = resolveDeployment({ root }, {});
  assert.throws(() => storeApiKey(deployment, 'sk-fixture', user), /旧目录/u);
  assert.equal(existsSync(deployment.home), false);
  const explicit = resolveDeployment({ root, home: 'data/selected' }, {});
  assert.throws(() => storeApiKey(explicit, 'sk-valid\nINJECTED=value', user), /格式无效/u);
  assert.equal(existsSync(explicit.home), false);
});

test('interactive input remains hidden, supports backspace and restores terminal raw mode', async () => {
  const input = new PassThrough(); const output = new PassThrough(); const rendered = [];
  input.isTTY = true; input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  output.on('data', value => rendered.push(value.toString()));
  const pending = readApiKey(input, output);
  input.write('sk-fixtureX\u007f\r');
  assert.equal(await pending, 'sk-fixture');
  assert.equal(input.isRaw, false);
  assert.ok(!rendered.join('').includes('sk-fixture'));
});

test('CLI reads stdin, uses root-relative home from unrelated cwd, and rejects key arguments without echo', () => {
  const root = fixture(); const script = fileURLToPath(new URL('../src/set-api-key.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--root', root, '--home', 'data/my home'], { cwd: tmpdir(), input: 'sk-fixture-stdin\n', encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(resolve(root, 'data/my home/.env'), 'utf8'), 'DEEPSEEK_API_KEY=sk-fixture-stdin\n');
  assert.ok(!`${result.stdout}${result.stderr}`.includes('sk-fixture-stdin'));
  assert.match(result.stdout, /未重启服务/u);
  const refused = spawnSync(process.execPath, [script, 'sk-argv-secret'], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0); assert.ok(!`${refused.stdout}${refused.stderr}`.includes('sk-argv-secret'));
});
