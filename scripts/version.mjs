/** Synchronize the framework release unit; custom plugins keep their own versions. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const frameworkPackages = [
  'packages/plugin-manager/package.json',
  'packages/plugin-kit/package.json',
  'plugins/builtin/dsh-auth/package.json',
  'plugins/builtin/dsh-example/package.json',
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
  'plugins/builtin/dsh-example/knowledge/guide.md.tmpl',
  'deploy/DEPLOYMENT.md.tmpl',
  'deploy/STARTERS.md.tmpl',
  'plugins/builtin/dsh-example/examples/README.md.tmpl',
];

// Fixed public excerpts only. sync/check owns every rendered document; builds only consume it.
export const documentationFragments = {
  'author-tools': 'doc/plugin-development.md.tmpl',
  'author-pack': 'doc/plugin-development.md.tmpl',
  'author-page-test': 'doc/plugin-development.md.tmpl',
  'deployment-start': 'doc/first-deployment.md.tmpl',
  'deployment-update': 'doc/first-deployment.md.tmpl',
  'install-retry': 'deploy/README.md',
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

// 发版输入核验：tools/builtin-build 是发版交付物，其 frameworkVersion 必须与框架版本一起走
// （发行包没有子模块也要检查）。
function checkDeliveredInputs(root, read, framework) {
  if (!existsSync(resolve(root, 'tools/builtin-build/input.json'))) return [];
  return JSON.parse(read('tools/builtin-build/input.json')).frameworkVersion === framework ? []
    : ['tools/builtin-build/input.json 的 frameworkVersion 与框架版本不一致（发版输入须随发版提交一起更新）'];
}

// 宿主锚点核验：deepseek-harness/package.json 的版本是宿主侧唯一事实源，根 workspace 的
// 供应链豁免、兼容文档与私有仓说明都引用它。历史上升级宿主时漏改过这些锚点，这里在 check 时
// 集中比对，升级只需保证各锚点与子模块一致。发行包检出没有子模块，天然跳过。
function checkHostAnchors(root, read, framework) {
  if (!existsSync(resolve(root, 'deepseek-harness/package.json'))) return [];
  const host = JSON.parse(read('deepseek-harness/package.json')).version;
  const problems = [];
  const excludes = [...read('pnpm-workspace.yaml').matchAll(/'(@deepseek-ai\/[^']+)@([^']+)'/g)];
  const stale = excludes.filter(([, , versions]) => !versions.split(' || ').includes(host));
  if (stale.length) problems.push(`pnpm-workspace.yaml 的宿主豁免未包含 ${host}：${[...new Set(stale.map(([, name]) => name))].join('、')}`);
  const compatibility = existsSync(resolve(root, 'doc/host-compatibility.md')) ? read('doc/host-compatibility.md') : '';
  if (compatibility && !compatibility.includes(`\`${host}\``)) problems.push(`doc/host-compatibility.md 未提及宿主版本 ${host}`);
  if (existsSync(resolve(root, 'PRIVATE.md')) && !read('PRIVATE.md').includes(host)) problems.push(`PRIVATE.md 未提及宿主版本 ${host}`);
  try {
    const gitlink = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD:deepseek-harness'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (compatibility && /^[0-9a-f]{40}$/.test(gitlink) && !compatibility.includes(gitlink)) problems.push(`doc/host-compatibility.md 未提及子模块提交 ${gitlink.slice(0, 12)}`);
  } catch { /* 无 git 或未提交 gitlink 时跳过提交号比对 */ }
  return problems;
}

// —— 宿主 peer 版本批量写（QAa-债-3 短期项：host <版本> 子命令）——
// 宿主内部包没有稳定插件 API 门面，各 workspace 包以精确版本 pin 声明 @deepseek-ai/dsh-*
// optional peer；宿主升级时用本子命令一处改、处处写（package.json 的 peer/dev pin +
// 供应链豁免并集并列新版本），再以 check 兜底。deepseek-harness 子模块源码树不碰。
const hostVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;

// 按 pnpm-workspace.yaml 的 packages 模式展开 workspace 包清单；模式形如
// 'plugins/external/*/agents/*'，通配段展开目录、最后一段 * 是包目录层。
// 子模块与 tests fixture 不在任何模式内，天然不进清单。
function workspaceManifests(root, patterns) {
  const manifests = new Set();
  for (const pattern of patterns) {
    const segments = pattern.split('/');
    if (segments.pop() !== '*') throw new Error(`不支持的 workspace 模式（结尾必须是 *）：${pattern}`);
    let parents = [''];
    for (const segment of segments) {
      const next = [];
      for (const dir of parents) {
        for (const entry of readdirSync(resolve(root, dir || '.'), { withFileTypes: true })) {
          if (entry.isDirectory() && (segment === '*' || entry.name === segment)) {
            next.push(dir ? `${dir}/${entry.name}` : entry.name);
          }
        }
      }
      parents = next;
    }
    // parents 是 * 包目录层的父目录；每个直接子目录含 package.json 即一个 workspace 包。
    for (const dir of parents) {
      for (const entry of readdirSync(resolve(root, dir || '.'), { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(resolve(root, dir, entry.name, 'package.json'))) {
          manifests.add(`${dir ? `${dir}/` : ''}${entry.name}/package.json`);
        }
      }
    }
  }
  return [...manifests].sort();
}

export function hostPeerVersions(root, { version, dryRun = false } = {}) {
  if (!hostVersionPattern.test(version)) {
    throw new Error(`宿主版本必须是 X.Y.Z 或 X.Y.Z-预发布，收到：${JSON.stringify(version)}`);
  }
  const read = name => readFileSync(resolve(root, name), 'utf8').replace(/\r\n/g, '\n');
  const yamlName = 'pnpm-workspace.yaml';
  const yamlText = read(yamlName);
  // 只取 packages: 块内的清单模式（豁免清单行同样是两空格缩进的 - '...'，不能混入）。
  const yamlLines = yamlText.split('\n');
  const start = yamlLines.indexOf('packages:');
  if (start < 0) throw new Error(`pnpm-workspace.yaml 缺少 packages 块`);
  const patterns = [];
  for (let index = start + 1; index < yamlLines.length; index += 1) {
    const line = yamlLines[index];
    if (line !== '' && !line.startsWith(' ')) break;
    const match = line.match(/^ {2}- '([^']+)'$/);
    if (match) patterns.push(match[1]);
  }
  const planned = new Map();
  const lines = [];
  let pins = 0, pinsDone = 0, excludes = 0, excludesDone = 0;
  // 依赖字段里的精确 pin 文本级重写（保引号保缩进，diff 只含版本字符串）；
  // ^/~ 区间、workspace: 协议与已等于目标值的条目原样保留。
  for (const name of workspaceManifests(root, patterns)) {
    const rewritten = read(name).replace(/("@deepseek-ai\/dsh-[a-z0-9.-]+":\s*")([^"]+)(")/g, (whole, head, old) => {
      if (!hostVersionPattern.test(old)) return whole;
      if (old === version) {
        pinsDone += 1;
        return whole;
      }
      const pkg = head.replace(/^"/, '').replace(/":\s*"$/, '');
      lines.push(`  ${name}  ${pkg}: ${old} → ${version}`);
      pins += 1;
      return `${head}${version}"`;
    });
    if (rewritten !== read(name)) planned.set(name, rewritten);
  }
  // 豁免清单是「并集」语义：追加目标版本、保留历史版本（minimumReleaseAge 冷静期
  // 需要旧版本仍在清单里），引号风格与缩进逐行保留。
  const yamlRewritten = yamlText.replace(/^(\s*-\s*)(['"])(@deepseek-ai\/[^'"]+)@([^'"]+)\2$/gm, (whole, lead, quote, pkg, versions) => {
    if (versions.split(' || ').includes(version)) {
      excludesDone += 1;
      return whole;
    }
    lines.push(`  ${yamlName}  ${pkg} 豁免并列 ${version}`);
    excludes += 1;
    return `${lead}${quote}${pkg}@${versions} || ${version}${quote}`;
  });
  if (yamlRewritten !== yamlText) planned.set(yamlName, yamlRewritten);
  const changed = [...planned].filter(([name, content]) => read(name) !== content);
  if (!dryRun) for (const [name, content] of changed) writeFileSync(resolve(root, name), content);
  // 子模块版本是宿主侧唯一事实源（check 的 checkHostAnchors 据此核验豁免清单），
  // 目标版本与它不一致时只提示不阻断：演练与分步升级都允许先跑 host。
  const hostManifest = 'deepseek-harness/package.json';
  const note = existsSync(resolve(root, hostManifest)) && JSON.parse(read(hostManifest)).version !== version
    ? `提示：deepseek-harness 子模块当前版本 ${JSON.parse(read(hostManifest)).version}，与目标 ${version} 不一致；正常升级流程应先升级子模块再运行 host。`
    : '';
  return { version, dryRun, files: planned.size, pins, pinsDone, excludes, excludesDone, lines, note };
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
  if (mode === 'check') {
    const problems = [...changed.length ? [`框架版本或文档未同步：\n${changed.map(([name]) => `  ${name}`).join('\n')}\n请运行 node scripts/version.mjs sync 并提交结果。`] : [], ...checkHostAnchors(root, read, target), ...checkDeliveredInputs(root, read, target)];
    if (problems.length) throw new Error(problems.join('\n'));
  }
  if (mode !== 'check') for (const [name, content] of changed) writeFileSync(resolve(root, name), content);
  return { version: target, changed: changed.map(([name]) => name) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const positional = args.filter(argument => argument !== '--dry-run');
    const [mode = 'check', version, ...extra] = positional;
    if (extra.length) throw new Error('用法：node scripts/version.mjs check | sync | set X.Y.Z | host <版本> [--dry-run]');
    const root = fileURLToPath(new URL('../', import.meta.url));
    if (mode === 'host') {
      if (!version) throw new Error('用法：node scripts/version.mjs host <版本> [--dry-run]');
      const result = hostPeerVersions(root, { version, dryRun });
      const summary = `扫描 peer/dev 精确 pin 共 ${result.pins + result.pinsDone} 处、豁免行共 ${result.excludes + result.excludesDone} 行；`
        + `${result.dryRun ? '待改' : '已改'} ${result.pins + result.excludes} 处（pin ${result.pins}、豁免并列 ${result.excludes}），涉及 ${result.files} 个文件${result.dryRun ? '；dry-run 未写入' : ''}。`;
      console.log([`宿主 ${result.version}：`, ...result.lines, result.note, summary].filter(part => part !== '').join('\n'));
    } else {
      if (dryRun) throw new Error('--dry-run 只用于 host 子命令。');
      const result = frameworkVersion(root, { mode, version });
      console.log(`框架 ${result.version}：${mode === 'check' ? '版本与文档校验通过' : `同步 ${result.changed.length} 个文件`}。`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
