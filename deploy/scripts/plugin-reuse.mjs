/** Reuse only archives bound to the active successful source deployment. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const require = createRequire(import.meta.url);
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const imagePattern = /^(?:sha256:[a-f0-9]{64}|\S+@sha256:[a-f0-9]{64})$/;
const refuse = reason => { throw new Error(`不能复用插件产物：${reason}。请执行不带 --rebuild-plugins 的全量构建。`); };

/** This pre-install guard deliberately has no kit or workspace dependency. */
export function assertSelectiveInstallSafe(root) {
  const directories = [root];
  for (const container of ['packages', 'plugins']) {
    const path = resolve(root, container);
    if (existsSync(path)) for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) refuse(`${container} 中存在符号链接，无法确认安装范围`);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') directories.push(resolve(path, entry.name));
    }
  }
  for (const directory of directories) {
    const path = resolve(directory, 'package.json');
    if (!existsSync(path)) continue;
    const manifest = json(path);
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
      if (manifest.scripts?.[hook]) refuse(`${manifest.name ?? 'workspace'} 声明了安装生命周期 ${hook}`);
    }
    if (manifest.pnpm?.pnpmfile || manifest.pnpm?.globalPnpmfile) refuse('存在自定义 pnpm hooks');
  }
  for (const name of ['.pnpmfile.cjs', '.pnpmfile.mjs']) if (existsSync(resolve(root, name))) refuse('存在自定义 pnpm hooks');
  for (const name of ['.npmrc', 'pnpm-workspace.yaml']) {
    const path = resolve(root, name);
    if (existsSync(path) && /^\s*(?:global[-_]?pnpmfile|pnpmfile)\s*[:=]/im.test(readFileSync(path, 'utf8'))) refuse('存在自定义 pnpm hooks 配置');
  }
}

/** Synchronous lazy loading lets bootstrap import the install guard before kit exists. */
export function preparePluginReuse({ root, previous, active, site, revision, hostCommit, buildEnvironment, rebuilt, git }) {
  const { discoverPlugins } = require('../../packages/plugin-manager/src/plugins.mjs');
  const { loadRelease, selectRelease } = require('../../packages/plugin-manager/src/release.mjs');
  const { within } = require('../../packages/plugin-manager/src/state.mjs');
  const sources = discoverPlugins(root), selected = new Set(rebuilt);
  if (!Array.isArray(rebuilt) || !rebuilt.length || selected.size !== rebuilt.length || rebuilt.some(id => !site.plugins.includes(id) || !sources.some(p => p.id === id))) refuse('重建选集无效');
  const reused = site.plugins.filter(id => !selected.has(id));
  assertSelectiveInstallSafe(root);
  if (!reused.length) return { release: { schemaVersion: 2, plugins: [] }, sourceRecord: null, builtFrom: [] };
  try {
    if (!previous?.manifest || !active?.path) refuse('没有当前活动部署');
    const manifest = resolve(root, previous.manifest), operation = dirname(dirname(manifest));
    if (!within(resolve(root, '.local/artifacts'), operation) || operation === resolve(root, '.local/artifacts')) refuse('活动发布路径越界');
    const sourceRecord = resolve(operation, 'result.json'), record = json(sourceRecord);
    if (record.schemaVersion !== 2 || record.status !== 'ready' || resolve(record.operation) !== operation || resolve(record.manifest) !== manifest || record.manifestHash !== hash(manifest)) refuse('活动发布记录或清单身份不匹配');
    if (typeof record.candidatePath !== 'string' || !within(operation, record.candidatePath) || record.candidateHash !== hash(record.candidatePath) || !isDeepStrictEqual(json(record.candidatePath), previous)) refuse('活动部署配置与成功发布不匹配');
    const compose = json(active.path);
    if (!within(resolve(root, site.artifacts), active.path) || active.project !== previous.composeProject || compose.services?.dsh?.image !== record.image || record.image !== previous.containerImage) refuse('活动 Compose 与成功发布镜像不匹配');
    const mounts = compose.services.dsh.volumes?.filter(mount => mount.target === '/opt/plugin-packages');
    if (mounts?.length !== 1 || mounts[0].type !== 'bind' || mounts[0].read_only !== true || resolve(mounts[0].source) !== dirname(manifest) || compose.services.dsh.environment?.PLUGIN_MANIFEST_FILE !== '/opt/plugin-packages/manifest.json') refuse('活动 Compose 的插件清单挂载不匹配');
    if (!commitPattern.test(record.revision) || !commitPattern.test(revision) || !commitPattern.test(record.hostCommit)) refuse('缺少源码或宿主镜像身份');
    if (!record.buildEnvironment || !['nodeVersion', 'platform', 'architecture', 'packageManager'].every(key => typeof record.buildEnvironment[key] === 'string' && record.buildEnvironment[key]) || !isDeepStrictEqual(record.buildEnvironment, buildEnvironment)) refuse('构建环境缺失或变化');
    if (site.hostImage != null) {
      // An explicit immutable image is the host input; an unused checkout is not its provenance.
      if (typeof site.hostImage !== 'string' || !imagePattern.test(site.hostImage) || buildEnvironment.hostImage !== site.hostImage) refuse('显式宿主镜像不是同一不可变引用');
    } else {
      if (record.hostCommit !== hostCommit || record.hostSourceClean !== true || record.hostSourceCommit !== hostCommit) refuse('缺少或改变了源码及宿主身份');
      const host = resolve(root, 'deepseek-harness');
      if (!existsSync(resolve(host, '.git')) || git(['-C', host, 'rev-parse', 'HEAD']) !== hostCommit || git(['-C', host, 'status', '--porcelain', '--untracked-files=normal'])) refuse('宿主源码缺失、变化或未提交');
    }
    git(['cat-file', '-e', `${record.revision}^{commit}`]);
    const changes = git(['diff', '--name-only', '-z', '--no-renames', record.revision, revision, '--']).split('\0').filter(Boolean);
    const rebuiltSources = sources.filter(p => selected.has(p.id));
    for (const path of changes) if (!rebuiltSources.some(p => path.startsWith(`${p.directory}/`))) refuse(`重建选集之外的输入发生变化：${path}`);
    const changedIds = new Set(rebuiltSources.filter(p => changes.some(path => path.startsWith(`${p.directory}/`))).map(p => p.id));

    // Dependency declarations are the supported contract; arbitrary script reads are not inferred.
    const byName = new Map(sources.map(p => [p.package, p]));
    for (const plugin of sources) {
      const path = `${plugin.directory}/package.json`;
      if (git(['ls-tree', '--name-only', record.revision, '--', path])) byName.set(JSON.parse(git(['show', `${record.revision}:${path}`])).name, plugin);
    }
    for (const id of reused) {
      const visited = new Set();
      const visit = plugin => {
        if (visited.has(plugin.id)) return;
        visited.add(plugin.id);
        if (changedIds.has(plugin.id)) refuse(`${id} 依赖本次变化的插件 ${plugin.id}，请一起重建`);
        for (const at of [record.revision, revision]) {
          const pkg = JSON.parse(git(['show', `${at}:${plugin.directory}/package.json`]));
          for (const dependencies of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies, pkg.peerDependencies]) {
            for (const [name, specifier] of Object.entries(dependencies ?? {})) {
              if (typeof specifier !== 'string') refuse(`${id} 的依赖声明无效`);
              if (/^(?:file|link):/.test(specifier)) refuse(`${id} 含不能确认的 file/link 构建依赖`);
              const dependency = byName.get(name);
              if (dependency) visit(dependency);
              else if (specifier.startsWith('workspace:') && name !== '@dsh-plugin-manager/plugin-kit') refuse(`${id} 含不能确认的 workspace 构建依赖 ${name}`);
            }
          }
        }
      };
      const plugin = sources.find(p => p.id === id);
      if (!plugin) refuse(`目标插件 ${id} 缺少源码声明`);
      visit(plugin);
    }
    const old = loadRelease(manifest), release = selectRelease(old, reused);
    if (!Array.isArray(record.pluginBuilds) || record.pluginBuilds.length !== old.plugins.length || new Set(record.pluginBuilds.map(p => p.id)).size !== record.pluginBuilds.length) refuse('缺少完整插件构建来源');
    for (const plugin of old.plugins) {
      const origin = record.pluginBuilds.find(p => p.id === plugin.id);
      if (!origin || origin.sha256 !== plugin.sha256 || !commitPattern.test(origin.builtFromRevision)) refuse(`${plugin.id} 的构建来源不匹配`);
    }
    for (const plugin of release.plugins) {
      const { directory, ...source } = sources.find(p => p.id === plugin.id);
      // JSON normalization removes absent optional properties from the source declaration.
      const expected = JSON.parse(JSON.stringify(source));
      const { archive, archivePath, sha256, directory: _directory, ...packed } = plugin;
      if (!isDeepStrictEqual(packed, expected)) refuse(`${plugin.id} 的源码声明与旧归档不一致`);
    }
    return { release, previousRelease: old, sourceRecord, hostCommit: record.hostCommit, builtFrom: record.pluginBuilds.filter(p => reused.includes(p.id)).map(p => ({ ...p })) };
  } catch (error) {
    if (error.message.startsWith('不能复用插件产物：')) throw error;
    refuse(`旧发布或构建输入无法核验（${error.message}）`);
  }
}
