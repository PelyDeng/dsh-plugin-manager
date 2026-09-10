/** Synchronize the framework release unit; custom plugins keep their own versions. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const frameworkPackages = [
  'packages/plugin-manager/package.json',
  'packages/plugin-kit/package.json',
  'plugins/dsh-auth/package.json',
  'plugins/dsh-example/package.json',
];
export const versionTemplates = [
  'packages/plugin-manager/README.md.tmpl',
  'packages/plugin-manager/DELIVERY.md.tmpl',
  'packages/plugin-kit/README.md.tmpl',
  'doc/getting-started.md.tmpl',
  'doc/first-deployment.md.tmpl',
  'doc/plugin-development.md.tmpl',
  'doc/versioning.md.tmpl',
  'examples/standalone-kit/README.md.tmpl',
  'examples/standalone-plugin/README.md.tmpl',
  'plugins/dsh-example/knowledge/guide.md.tmpl',
  'deploy/DEPLOYMENT.md.tmpl',
  'deploy/STARTERS.md.tmpl',
  'plugins/dsh-example/examples/README.md.tmpl',
];

// Fixed public excerpts only. sync/check owns every rendered document; builds only consume it.
export const documentationFragments = {
  'author-tools': 'doc/plugin-development.md.tmpl',
  'author-pack': 'doc/plugin-development.md.tmpl',
  'deployment-start': 'doc/first-deployment.md.tmpl',
  'deployment-update': 'doc/first-deployment.md.tmpl',
  'site-recovery': 'deploy/README.md',
  'source-rebuild': 'deploy/README.md',
  'model-credentials': 'doc/framework-configuration.md',
  'platform-defaults': 'doc/framework-configuration.md',
  'first-login': 'doc/getting-started.md.tmpl',
  'root-auth': 'doc/FAQ.md',
};

function composeDocumentation(source, read, template) {
  return source.replace(/<!-- include:([^\s]+) -->/g, (_marker, id) => {
    if (!Object.hasOwn(documentationFragments, id)) throw new Error(`未知文档片段 ${id}：${template}`);
    const path = documentationFragments[id];
    const text = read(path), start = `<!-- excerpt:${id} -->`, end = `<!-- /excerpt:${id} -->`;
    const from = text.indexOf(start), to = text.indexOf(end);
    if (from < 0 || to < from || text.indexOf(start, from + start.length) >= 0 || text.indexOf(end, to + end.length) >= 0) {
      throw new Error(`缺失或重复文档片段 ${id}：${path}`);
    }
    const body = text.slice(from + start.length, to).trim();
    if (!body || body.includes('<!-- include:')) throw new Error(`文档片段为空或包含嵌套引用：${path}#${id}`);
    return `<!-- Excerpt from ${path}#${id}; edit its source. -->\n${body}`;
  });
}

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function validateVersion(value) {
  if (typeof value !== 'string' || !stableVersion.test(value)) {
    throw new Error(`框架版本必须是稳定版本 X.Y.Z，收到：${JSON.stringify(value)}`);
  }
  return value;
}
function isOlder(version, previous) {
  const left = version.split('.').map(BigInt), right = previous.split('.').map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return false;
}

export function frameworkVersion(root, { mode = 'check', version } = {}) {
  if (!['check', 'sync', 'set'].includes(mode) || (mode !== 'set' && version !== undefined)) {
    throw new Error('用法：node scripts/version.mjs check | sync | set X.Y.Z');
  }
  const read = name => readFileSync(resolve(root, name), 'utf8').replace(/\r\n/g, '\n');
  const workspace = JSON.parse(read('package.json'));
  const current = validateVersion(workspace.version);
  const target = validateVersion(mode === 'set' ? version : current);
  if (mode === 'set' && isOlder(target, current)) throw new Error('框架版本不能倒退。');
  const planned = new Map();
  if (mode === 'set') planned.set('package.json', JSON.stringify({ ...workspace, version: target }, null, 2) + '\n');
  for (const name of frameworkPackages) {
    const manifest = JSON.parse(read(name));
    validateVersion(manifest.version);
    if (mode !== 'check' && isOlder(target, manifest.version)) {
      throw new Error(`框架版本 ${target} 低于 ${name} 的 ${manifest.version}。`);
    }
    planned.set(name, JSON.stringify({ ...manifest, version: target }, null, 2) + '\n');
  }
  for (const template of versionTemplates) {
    const source = read(template);
    if (!source.includes('{{FRAMEWORK_VERSION}}')) throw new Error(`模板缺少 {{FRAMEWORK_VERSION}}：${template}`);
    const rendered = composeDocumentation(source, read, template).replaceAll('{{FRAMEWORK_VERSION}}', target);
    const unknown = rendered.match(/\{\{[A-Z][A-Z0-9_]*\}\}/);
    if (unknown) throw new Error(`未知版本模板变量 ${unknown[0]}：${template}`);
    planned.set(template.slice(0, -5), `<!-- Generated from ${template} by scripts/version.mjs; edit the template. -->\n\n${rendered.trimEnd()}\n`);
  }
  // Read and validate every input before writing anything, including on set.
  const changed = [...planned].filter(([name, content]) => !existsSync(resolve(root, name)) || read(name) !== content);
  if (mode === 'check' && changed.length) {
    throw new Error(`框架版本或文档未同步：\n${changed.map(([name]) => `  ${name}`).join('\n')}\n请运行 node scripts/version.mjs sync 并提交结果。`);
  }
  if (mode !== 'check') for (const [name, content] of changed) writeFileSync(resolve(root, name), content);
  return { version: target, changed: changed.map(([name]) => name) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode = 'check', version, ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error('用法：node scripts/version.mjs check | sync | set X.Y.Z');
    const result = frameworkVersion(fileURLToPath(new URL('../', import.meta.url)), { mode, version });
    console.log(`框架 ${result.version}：${mode === 'check' ? '版本与文档校验通过' : `同步 ${result.changed.length} 个文件`}。`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
