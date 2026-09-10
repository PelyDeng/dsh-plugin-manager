/** Fixed incoming discovery and portable candidate composition; no author code is imported. */
import { cpSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { loadRelease, selectRelease } from './release.mjs';
import { composeReleases } from './compose-release.mjs';
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
    const release = loadRelease(path);
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

export function prepareArchives(context, releases) {
  const { root, operation, site, runtime, record, previous, inspect, probe, step, capture, adapter } = context;
  const toolRoot = resolve(operation, 'tooling');
  let tools;
  if (adapter?.prepareTools) tools = adapter.prepareTools(context);
  else {
    const source = resolve(process.env.DSH_SITE_TOOL_ROOT ?? resolve(root, 'tools')), expected = toolTreeIdentity(source);
    // Keep relative tool links relocatable; the JS traversal also avoids Node 22's Windows Unicode native-copy crash.
    cpSync(source, toolRoot, { recursive: true, dereference: false, verbatimSymlinks: true, filter: () => true });
    if (toolTreeIdentity(toolRoot) !== expected) throw new Error('工具执行树复制不一致。');
    tools = { toolRoot, archive: resolve(toolRoot, 'plugin-manager.tgz'), cli: resolve(toolRoot, 'node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs') };
    tools.sha256 = fileHash(tools.archive);
  }
  const manager = readSiteJson(resolve(tools.toolRoot, 'node_modules/@dsh-plugin-manager/plugin-manager/package.json')).version;
  const indexPath = resolve(root, 'framework-runtime.json');
  const index = existsSync(indexPath) ? validateRuntimeIndex(readSiteJson(indexPath)) : undefined;
  if (index && (index.manager.version !== manager || index.manager.sha256 !== tools.sha256)) throw new Error('发行信息与 manager 工具归档不一致，请完整更新框架部署包。');
  const selected = index?.runtimes.find(item => item.platform === `linux/${runtime.architecture}`);
  const image = site.containerImage ?? selected?.image;
  if (!image) throw new Error(`未提供 linux/${runtime.architecture} 的已验证运行镜像；请取得对应部署包或显式配置 DSH_CONTAINER_IMAGE。`);
  if (!/^(?:sha256:[a-f0-9]{64}|\S+@sha256:[a-f0-9]{64})$/.test(image)) throw new Error('完整运行镜像必须使用不可变 ID 或 digest。');
  console.log(`目标运行镜像：${image}`);
  if (probe('docker', ['image', 'inspect', image]) === null) {
    if (image.startsWith('sha256:')) throw new Error('本地固定镜像不存在；请恢复该镜像或配置仓库 digest。');
    step('拉取固定运行镜像', 'docker', ['pull', image]);
  }
  const info = inspect(image), hostCommit = info.Config?.Labels?.['org.opencontainers.image.revision'];
  if (info.Config?.Labels?.['com.dsh-plugin-manager.manager.sha256'] !== tools.sha256) throw new Error('运行镜像内 manager 归档摘要与本次工具不符。');
  if (info.Os !== 'linux' || info.Architecture !== runtime.architecture || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hostCommit)
    || (!site.containerImage && hostCommit !== selected.hostCommit)) throw new Error('运行镜像 OS、架构或宿主提交与发行信息不符。');
  if (JSON.stringify(info.Config?.Entrypoint) !== JSON.stringify(['node', '/opt/plugin-manager/node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs', 'container-start', '--root', '/opt/plugin-project'])) throw new Error('完整运行镜像未提供受支持的站点容器入口。');
  if (capture('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-p', 'require("/opt/plugin-manager/node_modules/@dsh-plugin-manager/plugin-manager/package.json").version']) !== manager) throw new Error('运行镜像内 manager 版本不符。');
  const manifest = resolve(operation, 'plugins/manifest.json');
  const combined = { schemaVersion: 2, plugins: releases.flatMap(release => release.plugins) };
  const selection = selectRelease(combined, site.plugins);
  const wanted = new Set(selection.plugins.map(p => p.id));
  composeReleases(releases.map(release => selectRelease(release, release.plugins.filter(p => wanted.has(p.id)).map(p => p.id))), dirname(manifest), previous?.manifest ? loadRelease(resolve(root, previous.manifest)) : undefined);
  Object.assign(record, { hostCommit, managerArchive: tools.archive, managerHash: tools.sha256, toolRoot: tools.toolRoot,
    ...(index ? { runtimeIndexHash: fileHash(indexPath), frameworkVersion: index.frameworkVersion } : {}) });
  return { ...tools, manager, manifest, image };
}
