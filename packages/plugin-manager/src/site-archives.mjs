/** Fixed incoming discovery and portable candidate composition; no author code is imported. */
import { cpSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { loadReleaseInputs } from './release.mjs';
import { composeReleases } from './compose-release.mjs';
import { createPublicBuildView } from './public-build-view.mjs';
import { ensurePinnedPnpm } from './pnpm.mjs';
import { buildMessage, buildStep } from './site-output.mjs';
import { fileHash, readSiteJson, toolTreeIdentity } from './site-record.mjs';

function regularWithin(root, path, directory = false) {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('输入路径越界。');
  for (let at = path; ; at = dirname(at)) {
    if (lstatSync(at).isSymbolicLink()) throw new Error(`输入不能是符号链接或目录联接：${at}`);
    if (at === root) break;
  }
  if (directory ? !lstatSync(path).isDirectory() : !lstatSync(path).isFile()) throw new Error(`输入不是${directory ? '目录' : '普通文件'}：${path}`);
}

export function discoverArchives(root) {
  const incoming = resolve(root, 'incoming');
  if (!existsSync(incoming)) return [];
  regularWithin(incoming, incoming, true);
  const releases = [], owners = new Map();
  for (const entry of readdirSync(incoming, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (entry.name === 'README.md' || entry.name.startsWith('.')) continue;
    const directory = resolve(incoming, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`请放入完整发布目录（manifest.json 与其全部 tgz）：${directory}`);
    regularWithin(incoming, directory, true);
    const path = resolve(directory, 'manifest.json');
    if (!existsSync(path)) throw new Error(`发布目录缺少 manifest.json：${directory}`);
    regularWithin(incoming, path);
    const raw = readSiteJson(path);
    if (!Array.isArray(raw.plugins)) throw new Error(`发布清单 plugins 无效：${path}`);
    for (const plugin of raw.plugins) {
      if (typeof plugin.archive !== 'string') throw new Error('发布清单 archive 无效。');
      regularWithin(directory, resolve(directory, plugin.archive));
    }
    const release = loadReleaseInputs(path);
    for (const plugin of release.plugins) for (const field of ['id', 'package']) {
      const key = `${field}:${plugin[field]}`;
      if (owners.has(key)) throw new Error(`重复插件 ${plugin[field]}：${owners.get(key)} 与 ${directory}。请仅保留一个完整发布目录。`);
      owners.set(key, directory);
    }
    releases.push(release);
  }
  return releases;
}

export function validateRuntimeIndex(index) {
  const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key));
  if (!exact(index, ['schemaVersion', 'frameworkVersion', 'manager', 'runtimes']) || index.schemaVersion !== 1 || typeof index.frameworkVersion !== 'string'
    || !exact(index.manager, ['version', 'sha256']) || index.manager.version !== index.frameworkVersion || !/^[a-f0-9]{64}$/.test(index.manager.sha256)
    || !Array.isArray(index.runtimes) || !index.runtimes.length) throw new Error('framework-runtime.json 发行信息无效。');
  const platforms = new Set();
  for (const runtime of index.runtimes) {
    if (!exact(runtime, ['platform', 'image', 'hostCommit']) || !/^linux\/(amd64|arm64)$/.test(runtime.platform) || platforms.has(runtime.platform)
      || !/^\S+@sha256:[a-f0-9]{64}$/.test(runtime.image) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(runtime.hostCommit)) throw new Error('发行运行镜像身份无效或平台重复。');
    platforms.add(runtime.platform);
  }
  return index;
}

/**
 * 在只含公开输入的构建视图里构建**全部内置插件**（设计 2.8、5.3 第 2 步）。
 *
 * 材料来源：发行包把公开源码与公开构建输入放在 `source/` 与 `tools/builtin-build/`；源码检出直接
 * 用检出自身（含 external 的私有树会得到显式诊断）。依赖装在视图内，站点侧源码树不被安装。
 * 构建固定全量：`DSH_PLUGINS` 是运行选集，只决定部署哪些包。
 */
export function buildBuiltinPlugins(context) {
  const { root, operation, env, execute, run } = context;
  const sourceRoot = existsSync(resolve(root, 'source/plugins/builtin')) ? resolve(root, 'source') : root;
  const inputs = resolve(root, 'tools/builtin-build');
  const view = buildStep('准备公开构建视图', () => createPublicBuildView({ root: sourceRoot, output: resolve(operation, 'build-view'), ...(existsSync(inputs) ? { inputs } : {}) }));
  buildMessage(`公开构建视图：收录 ${view.included.length} 个顶层项，importer ${view.importers.length} 个`);
  // 固定版本的 pnpm 按**材料根**的根清单准备：视图清单是复制来的，不能作为权威来源。
  ensurePinnedPnpm(sourceRoot, env, execute);
  // 依赖必须**先**装进视图：入口脚本静态导入视图里的 `packages/plugin-manager/src/plugins.mjs`，
  // 它需要视图内已链接好的 `@dsh-plugin-manager/plugin-kit`；视图里没有 node_modules 时脚本连加载
  // 都过不去（ERR_MODULE_NOT_FOUND），也就轮不到入口自己去安装。装完入口内的安装是一次空跑。
  buildStep('安装项目依赖', () => run('pnpm', ['install', '--frozen-lockfile'], { cwd: view.root }));
  const output = resolve(operation, 'fresh');
  // 入口脚本取视图内那一份：`source/` 只是材料目录，装了依赖的视图才是本次构建的工作区。
  buildStep('构建全部内置插件', () => run(process.execPath, [resolve(view.root, 'scripts/package-plugins.mjs'), '--plugins', 'all', '--output', output, '--workspace-root', view.root]));
  return buildStep('加载内置发布清单', () => loadReleaseInputs(resolve(output, 'manifest.json')));
}

/**
 * 把内置构建结果与 incoming 外部归档合并成唯一候选，并复制进本次安装缓存（设计 2.8、4.2）。
 * 全部内置与全部 incoming 都进入候选；运行选集在部署阶段生效，不在准备阶段丢包。
 */
export function composeCandidate(context, builtin, incoming) {
  // 内置插件由本次构建产出；incoming 里出现同一个 id 时在**停旧之前**就报出两个来源，
  // 不要等组合清单给出「id 重复」这种不指明出处的失败。
  const builtinIds = new Map(builtin.plugins.map(plugin => [plugin.id, plugin.package]));
  for (const release of incoming) for (const plugin of release.plugins) {
    if (builtinIds.has(plugin.id)) throw new Error(`插件 id 与内置构建重复：${plugin.id}（内置 ${builtinIds.get(plugin.id)} 与 ${dirname(release.path)}）。内置插件已由本次构建产出，请从 incoming 移除该发布目录。`);
  }
  const manifest = resolve(context.operation, 'plugins/manifest.json');
  const composed = composeReleases([builtin, ...incoming], dirname(manifest), undefined, [], { cacheRoot: context.cacheRoot });
  // 只回传清单**路径**与缓存清单名：调用方按路径重新加载，避免与 composeReleases 返回的清单对象混淆。
  return { manifest, cacheManifest: composed.cacheManifest };
}

/** 发行包自带的工具树：相对发行包的 tools/ 原样复制并核验身份。 */
function shippedTools(root, operation) {
  const toolRoot = resolve(operation, 'tooling');
  const source = resolve(process.env.DSH_SITE_TOOL_ROOT ?? resolve(root, 'tools')), expected = toolTreeIdentity(source);
  // Keep relative tool links relocatable; the JS traversal also avoids Node 22's Windows Unicode native-copy crash.
  cpSync(source, toolRoot, { recursive: true, dereference: false, verbatimSymlinks: true, filter: () => true });
  if (toolTreeIdentity(toolRoot) !== expected) throw new Error('工具执行树复制不一致。');
  const tools = { toolRoot, archive: resolve(toolRoot, 'plugin-manager.tgz'), cli: resolve(toolRoot, 'node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs') };
  tools.sha256 = fileHash(tools.archive);
  return tools;
}

/** 发行包声明的运行镜像核对：摘要标签、平台、宿主提交、容器入口与 manager 版本。 */
function verifyPublishedImage(context, { image, tools, manager, selected }) {
  const { site, runtime, inspect, probe, step, capture } = context;
  if (!/^(?:sha256:[a-f0-9]{64}|\S+@sha256:[a-f0-9]{64})$/.test(image)) throw new Error('完整运行镜像必须使用不可变 ID 或 digest。');
  console.log(`目标运行镜像：${image}`);
  if (probe('docker', ['image', 'inspect', image]) === null) {
    if (image.startsWith('sha256:')) throw new Error('本地固定镜像不存在；请恢复该镜像或配置仓库 digest。');
    step('拉取固定运行镜像', 'docker', ['pull', image]);
  }
  const info = inspect(image), hostCommit = info.Config?.Labels?.['org.opencontainers.image.revision'];
  if (info.Config?.Labels?.['com.dsh-plugin-manager.manager.sha256'] !== tools.sha256) throw new Error('运行镜像内 manager 归档摘要与本次工具不符。');
  if (info.Os !== 'linux' || info.Architecture !== runtime.architecture || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hostCommit ?? '')) throw new Error('运行镜像 OS、架构或宿主提交与发行信息不符。');
  if (!site.containerImage && selected && hostCommit !== selected.hostCommit) throw new Error('运行镜像宿主提交与发行信息不符。');
  if (JSON.stringify(info.Config?.Entrypoint) !== JSON.stringify(['node', '/opt/plugin-manager/node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs', 'container-start', '--root', '/opt/plugin-project'])) throw new Error('完整运行镜像未提供受支持的站点容器入口。');
  if (capture('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-p', 'require("/opt/plugin-manager/node_modules/@dsh-plugin-manager/plugin-manager/package.json").version']) !== manager) throw new Error('运行镜像内 manager 版本不符。');
  return hostCommit;
}

/**
 * 唯一部署准备（设计 5.3 第 2 步）：工具 → 运行镜像 → 内置构建 → 外部归档 → 唯一候选。
 *
 * 材料能力由入口提供，部署流程只有一条：源码检出给 `adapter.prepareTools`/`prepareImage`，
 * 发行包用自带的 `tools/` 与 `framework-runtime.json` 运行镜像。准备之后（停旧、候选容器内安装
 * 启动、验证）完全同一条路径，没有第二套部署模式。
 */
export function prepareDeployment(context) {
  const { root, operation, site, runtime, record, adapter } = context;
  const tools = buildStep('准备管理器工具', () => (adapter?.prepareTools ? adapter.prepareTools(context) : shippedTools(root, operation)));
  Object.assign(record, { managerArchive: tools.archive, managerHash: tools.sha256, toolRoot: tools.toolRoot });
  // 管理器版本：发行包的工具树里装的是完整包；源码检出构建出的工具树可能只保存入口，
  // 这时以检出自身的包清单为准。
  const managerFile = resolve(tools.toolRoot, 'node_modules/@dsh-plugin-manager/plugin-manager/package.json');
  const manager = existsSync(managerFile) ? readSiteJson(managerFile).version : readSiteJson(resolve(root, 'packages/plugin-manager/package.json')).version;
  const indexPath = resolve(root, 'framework-runtime.json');
  const index = existsSync(indexPath) ? validateRuntimeIndex(readSiteJson(indexPath)) : undefined;
  if (index && (index.manager.version !== manager || index.manager.sha256 !== tools.sha256)) throw new Error('发行信息与 manager 工具归档不一致，请完整更新框架部署包。');
  const selected = index?.runtimes.find(item => item.platform === `linux/${runtime.architecture}`);
  let image = site.containerImage ?? selected?.image, hostCommit;
  if (image) hostCommit = verifyPublishedImage(context, { image, tools, manager, selected });
  else {
    if (!adapter?.prepareImage) throw new Error(`未提供 linux/${runtime.architecture} 的已验证运行镜像；请取得对应部署包或显式配置 DSH_CONTAINER_IMAGE。`);
    // 过渡：源码检出还没有发行镜像时按官方源码构建一次；构建方自行核验标签与版本，
    // record.hostCommit 也在那里写入。
    image = buildStep('构建运行镜像', () => adapter.prepareImage(context, tools));
    hostCommit = record.hostCommit;
  }
  const builtin = buildStep('构建内置插件', () => buildBuiltinPlugins(context));
  const incoming = buildStep('读取 incoming 外部归档', () => discoverArchives(root));
  const composed = buildStep('组装发布清单与归档', () => composeCandidate(context, builtin, incoming));
  record.pluginBuilds = builtin.plugins.map(plugin => ({ id: plugin.id, sha256: plugin.sha256, builtFromRevision: record.revision }));
  record.externalPlugins = incoming.flatMap(item => item.plugins.map(plugin => plugin.id));
  Object.assign(record, { hostCommit, ...(index ? { runtimeIndexHash: fileHash(indexPath), frameworkVersion: index.frameworkVersion } : {}) });
  return { ...tools, manager, manifest: composed.manifest, image, cacheManifest: composed.cacheManifest };
}
