/** Secret input and deployment selection; native runtime acceptance is opt-in. */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const managerBase = process.env.DSH_TEST_MANAGER_DIST ? pathToFileURL(resolve(process.env.DSH_TEST_MANAGER_DIST) + '/') : new URL('../src/', import.meta.url);
const { credentialContainer, readApiKey, storeApiKey } = await import(new URL('set-api-key.mjs', managerBase));
const { resolveDeployment } = await import(new URL('deployment.mjs', managerBase));
const command = process.env.DSH_TEST_MANAGER_DIST ? [fileURLToPath(new URL('cli.mjs', managerBase)), 'set-api-key'] : [fileURLToPath(new URL('set-api-key.mjs', managerBase))];

const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync.native(mkdtempSync(resolve(tmpdir(), 'dsh api key '))); directories.push(root); return root;
}

test('invalid input does not create a home or overwrite legacy dotenv', async () => {
  const root = fixture(); const deployment = resolveDeployment({ root, home: 'data/custom home' }, {});
  await assert.rejects(storeApiKey(deployment, 'sk-valid\nINJECTED=value'), /格式无效/u);
  assert.equal(existsSync(deployment.home), false);
});

test('file-owned DeepSeek keys reject the native writer before touching credential storage', async () => {
  const root = fixture();
  const config = join(root, 'env.conf');
  writeFileSync(config, 'DEEPSEEK_API_KEY=sk-file-owner\n', { mode: 0o600 });
  const deployment = resolveDeployment({ root, config }, {});
  await assert.rejects(storeApiKey(deployment, 'sk-new-value'), /配置文件管理.*只读/);
  assert.equal(existsSync(deployment.home), false);
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

test('CLI rejects key arguments without echo and does not fall back to a dotenv writer', () => {
  const root = fixture();
  const refused = spawnSync(process.execPath, [...command, 'sk-argv-secret'], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0); assert.ok(!`${refused.stdout}${refused.stderr}`.includes('sk-argv-secret'));
  const missing = spawnSync(process.execPath, [...command, '--root', root, '--home', 'data/my home'], { cwd: tmpdir(), input: 'sk-fixture-stdin\n', encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.ok(!`${missing.stdout}${missing.stderr}`.includes('sk-fixture-stdin'));
  assert.equal(existsSync(resolve(root, 'data/my home/.env')), false);
});

test('Compose target must be running and bind the selected home; ambiguous selections fail closed', () => {
  const root = fixture(); const deployment = resolveDeployment({ root, home: 'data/home' }, {});
  mkdirSync(deployment.artifacts, { recursive: true }); mkdirSync(deployment.home, { recursive: true });
  const compose = join(root, 'compose.json'); writeFileSync(compose, '{}');
  writeFileSync(join(deployment.artifacts, 'active-compose.json'), JSON.stringify({ project: 'dsh-plugins', path: compose }));
  const id = 'a'.repeat(64);
  const container = { Config: { Env: ['DSH_HOME=/data/home'] }, State: { Running: true }, Mounts: [{ Type: 'bind', Source: join(root, 'data'), Destination: '/data', RW: true }] };
  const execute = (_command, args) => ({ status: 0, stdout: args[0] === 'compose' ? id : JSON.stringify([container]) });
  assert.equal(credentialContainer(deployment, execute), id);
  container.State.Running = false;
  assert.throws(() => credentialContainer(deployment, execute), /未修改密钥/u);
  container.State.Running = true; container.Config.Env = ['DSH_HOME=/data/other'];
  assert.throws(() => credentialContainer(deployment, execute), /未修改密钥/u);
  assert.throws(() => credentialContainer(deployment, () => ({ status: 0, stdout: `${id}\n${id}` })), /未修改密钥/u);
});

test('native host hot-reloads CLI writes and shares the same document with the page helper', { skip: !process.env.DSH_TEST_CLI_JS }, async () => {
  const root = fixture(), entry = resolve(process.env.DSH_TEST_CLI_JS);
  const deployment = resolveDeployment({ root, home: 'data/home', 'dsh-cli-js': entry }, {});
  mkdirSync(deployment.home, { recursive: true });
  const dotenv = '# retained fallback\nDEEPSEEK_API_KEY=sk-old-env\nOTHER=value\n';
  writeFileSync(join(deployment.home, '.env'), dotenv);
  const require = createRequire(realpathSync(entry));
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const { LocalCredentialProvider } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-credentials-local')).href);
  const { setDeepSeekKey, deepSeekKeyStatus } = await import('@dsh-plugin-manager/plugin-kit/deepseek-key');
  const ctx = new Context(), fiber = ctx.plugin(LocalCredentialProvider, { dshHome: deployment.home });
  await fiber;
  try {
    const provider = ctx.get('credentials');
    await provider.set('OTHER_REF', 'unrelated-fixture');
    await setDeepSeekKey(provider, 'sk-page-fixture');
    const child = spawnSync(process.execPath, [...command, '--root', root, '--home', 'data/home', '--dsh-cli-js', entry], { input: 'sk-cli-fixture\n', encoding: 'utf8', cwd: tmpdir(), timeout: 30000 });
    assert.equal(child.status, 0, child.stderr);
    assert.ok(!`${child.stdout}${child.stderr}`.includes('sk-cli-fixture'));
    const deadline = Date.now() + 10000;
    while ((await provider.resolve('DEEPSEEK_API_KEY'))?.value !== 'sk-cli-fixture' && Date.now() < deadline) await new Promise(done => setTimeout(done, 50));
    assert.equal((await provider.resolve('DEEPSEEK_API_KEY')).value, 'sk-cli-fixture');
    assert.equal((await provider.resolve('OTHER_REF')).value, 'unrelated-fixture');
    assert.equal(readFileSync(join(deployment.home, '.env'), 'utf8'), dotenv);
    assert.equal((await deepSeekKeyStatus(provider)).configured, true);
    const readonly = spawnSync(process.execPath, [...command, '--root', root, '--home', 'data/home', '--dsh-cli-js', entry], { input: 'sk-refused\n', encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: 'sk-external-fixture' }, timeout: 30000 });
    assert.notEqual(readonly.status, 0);
    assert.ok(!`${readonly.stdout}${readonly.stderr}`.includes('sk-'));
    assert.equal((await provider.resolve('DEEPSEEK_API_KEY')).value, 'sk-cli-fixture');
  } finally { await fiber.dispose(); }
});

test('native credentials make both file overrides read-only and preserve official values after blank fallback', { skip: !process.env.DSH_TEST_CLI_JS }, () => {
  const root = fixture(), entry = resolve(process.env.DSH_TEST_CLI_JS);
  const config = join(root, 'env.conf');
  mkdirSync(join(root, 'data/home'), { recursive: true });
  const child = `
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    import { createHash } from 'node:crypto';
    import { realpathSync } from 'node:fs';
    const require = createRequire(realpathSync(process.argv[1]));
    const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
    const { LocalCredentialProvider } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-credentials-local')).href);
    const ctx = new Context(), fiber = ctx.plugin(LocalCredentialProvider, { dshHome: process.argv[2], watch: false });
    await fiber;
    try {
      const provider = ctx.get('credentials');
      if (process.argv[3] === 'seed') {
        await provider.set('DEEPSEEK_API_KEY', 'sk-official-retained');
        await provider.set('ZHIPU_API_KEY', 'official.zhipu.retained');
      }
      const result = {};
      for (const key of ['DEEPSEEK_API_KEY', 'ZHIPU_API_KEY']) {
        const info = await provider.describe(key), value = await provider.resolve(key);
        let rejected = false;
        if (!info.writable) { try { await provider.set(key, 'sk-refused'); } catch { rejected = true; } }
        result[key] = { writable: info.writable, rejected, hash: createHash('sha256').update(value.value).digest('hex') };
      }
      console.log(JSON.stringify(result));
    } finally { await fiber.dispose(); }
  `;
  const inherited = { ...process.env };
  delete inherited.DEEPSEEK_API_KEY; delete inherited.ZHIPU_API_KEY;
  const run = (env, mode = 'inspect') => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', child, entry, join(root, 'data/home'), mode], { env: { ...inherited, ...env }, cwd: tmpdir(), encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  };
  const original = run({}, 'seed');
  const stored = readFileSync(join(root, 'data/home/.credentials.yaml'));
  // The same projection reader used by the supervisor is exercised from the installed archive.
  return import(new URL('framework-credentials.mjs', managerBase)).then(({ prepareFrameworkCredentials, frameworkCredentialEnvironment }) => {
    writeFileSync(config, 'DSH_HOME=data/home\nDEEPSEEK_API_KEY=sk-file-override\nZHIPU_API_KEY=file.zhipu.override\n', { mode: 0o600 });
    let deployment = resolveDeployment({ root, config }, {});
    prepareFrameworkCredentials(deployment);
    const overridden = run(frameworkCredentialEnvironment(deployment));
    for (const key of Object.keys(overridden)) {
      assert.equal(overridden[key].writable, false);
      assert.equal(overridden[key].rejected, true);
      assert.notEqual(overridden[key].hash, original[key].hash);
    }
    assert.deepEqual(readFileSync(join(root, 'data/home/.credentials.yaml')), stored);
    writeFileSync(config, 'DSH_HOME=data/home\nDEEPSEEK_API_KEY=\nZHIPU_API_KEY=\n');
    deployment = resolveDeployment({ root, config }, {});
    prepareFrameworkCredentials(deployment);
    assert.deepEqual(run(frameworkCredentialEnvironment(deployment)), original);
  });
});
