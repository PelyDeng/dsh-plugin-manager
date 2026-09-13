/** Reuse only archives bound to the active successful source deployment. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readSiteRecord } from '../../packages/plugin-manager/src/site-record.mjs';

const require = createRequire(import.meta.url);
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const imagePattern = /^(?:sha256:[a-f0-9]{64}|\S+@sha256:[a-f0-9]{64})$/;
const refuse = reason => {
  const error = new Error(`不能复用插件产物：${reason}。请执行不带 --rebuild-plugins 的全量构建。`);
  // 自动模式要把「为什么复用不了」原样报出去，而不是再解析一遍自己的提示文案。
  error.reuseReason = reason;
  throw error;
};
/** 判定拒绝时把「补哪些插件就能复用」一并给出：重建集由判定自己算，不该让运维猜。 */
const refuseSelection = (reasons, suggestion) => {
  throw new Error(`不能复用插件产物：${reasons.join('；')}。请改用 --rebuild-plugins "${suggestion}"（补进这些插件后其余产物仍可复用），或用 --rebuild-plugins auto 让判定自己补全。`);
};

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

/**
 * 仓库级共享构建输入：依赖解析与检出字节由这几份决定，每个插件的构建都读同一份。
 * 插件自己的目录与它声明的依赖之外，只有这些文件算「所有插件的输入」。
 */
const SHARED_INPUTS = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.gitattributes'];
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** 整棵树的「路径 → Git 对象号」：同一路径的内容变没变，比对对象号即可，不必读文件。 */
function trackedFiles(git, revision) {
  const files = new Map();
  for (const record of git(['ls-tree', '-r', '-z', revision]).split('\0')) {
    if (!record) continue;
    const separator = record.indexOf('\t');
    const [, type, object] = record.slice(0, separator).split(' ');
    if (type === 'blob') files.set(record.slice(separator + 1), object);
  }
  return files;
}

const directoryOf = path => {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '.' : path.slice(0, cut);
};

/**
 * 工作区包索引：包名 → 目录。
 *
 * 路径浅的优先：`packages/plugin-kit` 是工作区包，`plugins/x/fixtures/plugin-kit` 只是插件里
 * 的同名副本。反过来解析会把真实依赖漏出构建输入，那正是「复用了旧产物」最危险的方向。
 */
function workspacePackages(files, read) {
  const packages = new Map();
  const manifests = [...files.keys()].filter(path => path === 'package.json' || path.endsWith('/package.json'))
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
  for (const path of manifests) {
    let manifest;
    try { manifest = JSON.parse(read(path)); } catch { continue; }
    if (typeof manifest?.name !== 'string' || !manifest.name || packages.has(manifest.name)) continue;
    packages.set(manifest.name, { directory: directoryOf(path), path });
  }
  return packages;
}

const isSafeInput = value => typeof value === 'string' && /^[a-zA-Z0-9_.-][a-zA-Z0-9._/-]*$/u.test(value)
  && !value.split('/').some(part => part === '' || part === '.' || part === '..');

/**
 * 一个插件在一个提交上的构建输入。
 *
 * 构成：插件目录内的全部已跟踪文件，加上目录内各份清单声明、且能解析到本仓库的依赖目录
 * （含间接依赖），加上仓库级共享输入，再加上清单里 `deepseekPlugin.buildInputs` 显式声明的
 * 路径。`buildInputs` 缺席时返回 `declared: false`：声明以外的读取无法确认，调用方据此退回
 * 「除重建选集以外的变化都算它的输入」这一保守口径。
 */
function pluginInputs({ git, revision, files, packages, plugin, verifyLocalArchive }) {
  const read = path => git(['show', `${revision}:${path}`]);
  const inputs = new Map(), directories = new Set([plugin.directory]), queue = [plugin.directory];
  const add = (path, owner) => { if (!inputs.has(path)) inputs.set(path, owner); };
  const own = JSON.parse(read(`${plugin.directory}/package.json`));
  const declared = own?.deepseekPlugin?.buildInputs;
  // 声明形状不对就当成没声明：宁可退回保守口径，也不猜作者想说什么。
  const extras = Array.isArray(declared) && declared.every(isSafeInput) ? declared : undefined;
  for (const path of files.keys()) {
    if (path.startsWith(`${plugin.directory}/`)) add(path, 'self');
    for (const extra of extras ?? []) if (path === extra || path.startsWith(`${extra}/`)) add(path, `declared:${extra}`);
  }
  for (const path of SHARED_INPUTS) if (files.has(path)) add(path, 'shared');
  while (queue.length) {
    const directory = queue.shift();
    for (const [path, object] of files) {
      if (path !== 'package.json' && !path.endsWith('/package.json')) continue;
      if (directory !== '.' ? !path.startsWith(`${directory}/`) : path !== 'package.json') continue;
      if (!object) continue;
      const manifest = JSON.parse(read(path));
      for (const field of DEPENDENCY_FIELDS) {
        for (const [name, specifier] of Object.entries(manifest?.[field] ?? {})) {
          if (typeof specifier !== 'string') throw new Error(`${plugin.id} 的依赖声明无效`);
          if (specifier.startsWith('link:')) throw new Error(`${plugin.id} 含不能确认的 link: 构建依赖`);
          if (specifier.startsWith('file:')) { verifyLocalArchive(plugin, directoryOf(path), specifier); continue; }
          const dependency = packages.get(name);
          if (dependency) {
            if (directories.has(dependency.directory)) continue;
            directories.add(dependency.directory);
            queue.push(dependency.directory);
            for (const nested of files.keys()) if (nested.startsWith(`${dependency.directory}/`)) add(nested, `dependency:${name}`);
            continue;
          }
          if (specifier.startsWith('workspace:')) throw new Error(`${plugin.id} 含不能确认的 workspace 构建依赖 ${name}`);
        }
      }
    }
  }
  return { declared: extras !== undefined, inputs };
}

/** 变化路径属于插件的哪一类输入：只影响提示怎么写。 */
function inputReason(owner) {
  if (owner === 'self') return '自身发生变化';
  if (owner === 'shared') return '依赖的共享构建输入（依赖解析或检出字节）发生变化';
  if (owner?.startsWith('dependency:')) return `依赖的 ${owner.slice('dependency:'.length)} 发生变化`;
  if (owner?.startsWith('declared:')) return `声明的构建输入 ${owner.slice('declared:'.length)} 发生变化`;
  return '构建输入发生变化';
}

/**
 * 复用活动部署的插件归档。
 *
 * `rebuilt` 是运维点名的重建集；`auto` 是它的替代形态：由判定自己算——先假定全部复用，把
 * 「按输入判定不能复用」的插件逐轮补进选集，直到没有插件被拒。依赖目录本身就在消费者的输入
 * 闭包里，所以影响传播不需要另做图分析，补进被判定的那一个即可。判定拿不到可靠基线（没有活动
 * 部署、宿主或记录对不上、声明无法核验）时不报错，直接整套重建：那本来就是不带参数时的路径，
 * 而复用只是省时间，不能因为省不了就把发布挡住。
 */
export function preparePluginReuse({ root, previous, active, site, revision, hostCommit, buildEnvironment, rebuilt, git, auto = false }) {
  // Synchronous lazy loading lets bootstrap import the install guard before kit exists.
  const { discoverPlugins } = require('../../packages/plugin-manager/src/plugins.mjs');
  const { loadRelease, selectRelease } = require('../../packages/plugin-manager/src/release.mjs');
  const { within } = require('../../packages/plugin-manager/src/state.mjs');
  const sources = discoverPlugins(root);
  /** 整套重建：清单里没有可复用归档，与不带 --rebuild-plugins 的结果一致。 */
  const full = reason => ({ release: { schemaVersion: 2, plugins: [] }, sourceRecord: null, builtFrom: [], rebuilt: [...site.plugins], ...(reason ? { reuseUnavailable: reason } : {}) });
  if (auto) {
    if (rebuilt !== undefined && (!Array.isArray(rebuilt) || rebuilt.length)) refuse('自动重建集不能与点名的插件列表同时使用');
  } else if (!Array.isArray(rebuilt) || !rebuilt.length || new Set(rebuilt).size !== rebuilt.length || rebuilt.some(id => !site.plugins.includes(id) || !sources.some(p => p.id === id))) refuse('重建选集无效');
  assertSelectiveInstallSafe(root);
  if (!auto && site.plugins.every(id => rebuilt.includes(id))) return full();
  try {
    if (!previous?.manifest || !active?.path) refuse('没有当前活动部署');
    const manifest = resolve(root, previous.manifest), operation = dirname(dirname(manifest));
    if (!within(resolve(root, '.local/artifacts'), operation) || operation === resolve(root, '.local/artifacts')) refuse('活动发布路径越界');
    const sourceRecord = resolve(operation, 'result.json'), record = readSiteRecord(root, operation, { status: 'ready' });
    if (record.inputKind === 'archives') refuse('归档部署没有源码复用基线，请先全量构建');
    if (resolve(record.manifest) !== manifest || record.manifestHash !== hash(manifest)) refuse('活动发布记录或清单身份不匹配');
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

    const checkedArchives = new Set();
    function verifyLocalArchive(plugin, base, specifier) {
      const local = specifier.slice(5).replace(/^\.\//, '');
      const directory = resolve(root, plugin.directory), archive = resolve(root, base, local);
      if (!/\.(?:tgz|tar\.gz)$/.test(local) || /[%?#]/.test(local) || isAbsolute(local) || /^[A-Za-z]:/.test(local) || local.split(/[\\/]/).some(part => !part || part === '.' || part === '..') || !within(directory, archive)) refuse(`${plugin.id} 的 file: 依赖必须是插件目录内的普通归档`);
      for (let path = archive; path !== directory; path = dirname(path)) {
        if (!existsSync(path) || lstatSync(path).isSymbolicLink()) refuse(`${plugin.id} 的 file: 归档缺失或包含符号链接`);
      }
      if (!lstatSync(archive).isFile()) refuse(`${plugin.id} 的 file: 依赖不是普通归档文件`);
      const path = relative(root, archive).split(sep).join('/');
      if (checkedArchives.has(path)) return;
      for (const at of [record.revision, revision]) {
        if (!/^100(?:644|755) blob /.test(git(['ls-tree', at, '--', path]))) refuse(`${plugin.id} 的 file: 归档必须在两次发布源码中均为已跟踪普通文件`);
      }
      const before = git(['rev-parse', `${record.revision}:${path}`]), after = git(['rev-parse', `${revision}:${path}`]);
      if (before !== after || after !== git(['hash-object', '--no-filters', '--', archive])) refuse(`${plugin.id} 的 file: 归档内容与已跟踪构建输入不一致`);
      checkedArchives.add(path);
    }

    // Dependency declarations are the supported contract; arbitrary script reads are not inferred,
    // so a plugin that does not declare its extra inputs keeps the conservative verdict.
    const trees = { [record.revision]: trackedFiles(git, record.revision), [revision]: trackedFiles(git, revision) };
    const packages = Object.fromEntries(Object.entries(trees).map(([at, files]) => [at, workspacePackages(files, path => git(['show', `${at}:${path}`]))]));
    const changed = [...new Set([...trees[record.revision].keys(), ...trees[revision].keys()])]
      .filter(path => trees[record.revision].get(path) !== trees[revision].get(path)).sort();

    // 输入闭包与重建集无关，按插件算一次就够：自动模式要反复问同一个插件。
    const inputStates = new Map();
    const inputState = plugin => {
      if (!inputStates.has(plugin.id)) {
        const inputs = new Map();
        let declared = true;
        for (const at of [record.revision, revision]) {
          const state = pluginInputs({ git, revision: at, files: trees[at], packages: packages[at], plugin, verifyLocalArchive });
          declared = declared && state.declared;
          // 并集：任一提交上算它的输入，就按输入对待。
          for (const [path, owner] of state.inputs) if (!inputs.has(path)) inputs.set(path, owner);
        }
        inputStates.set(plugin.id, { inputs, declared });
      }
      return inputStates.get(plugin.id);
    };
    /** 在给定重建集下这个插件能否复用：能复用返回 null，否则返回原因。 */
    const reuseVerdict = (plugin, selectedIds) => {
      const { inputs, declared } = inputState(plugin);
      const rebuiltDirectories = sources.filter(p => selectedIds.has(p.id)).map(p => `${p.directory}/`);
      for (const path of changed) {
        const owner = inputs.get(path);
        if (owner) return `${plugin.id} ${inputReason(owner)}：${path}`;
        // 没声明构建输入的插件，读取范围无法确认：重建选集之外的任何变化都按它的输入对待。
        if (!declared && !rebuiltDirectories.some(directory => path.startsWith(directory))) return `${plugin.id} 未声明 deepseekPlugin.buildInputs，重建选集之外的变化无法确认与它无关：${path}`;
      }
      return null;
    };
    const missingSource = id => sources.some(p => p.id === id) ? null : `目标插件 ${id} 缺少源码声明`;
    const selected = new Set(auto ? [] : rebuilt);
    if (auto) {
      for (;;) {
        const reusedIds = site.plugins.filter(id => !selected.has(id));
        const blocking = [];
        for (const id of reusedIds) {
          const missing = missingSource(id);
          if (missing) refuse(missing);
          const reason = reuseVerdict(sources.find(p => p.id === id), selected);
          if (reason) blocking.push(id);
        }
        if (!blocking.length) break;
        for (const id of blocking) selected.add(id);
      }
    } else {
      const blockingIds = new Set(), blockingReasons = [];
      for (const id of site.plugins.filter(id => !selected.has(id))) {
        const missing = missingSource(id);
        if (missing) refuse(missing);
        const reason = reuseVerdict(sources.find(p => p.id === id), selected);
        if (reason) { blockingIds.add(id); blockingReasons.push(reason); }
      }
      // 一次把话说完：告诉运维补哪几个插件就能继续复用，而不是让他失败一次补一个。
      if (blockingIds.size) refuseSelection(blockingReasons, site.plugins.filter(id => selected.has(id) || blockingIds.has(id)).join(','));
    }
    const reused = site.plugins.filter(id => !selected.has(id));
    if (!reused.length) return full();
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
    return { release, previousRelease: old, sourceRecord, hostCommit: record.hostCommit, builtFrom: record.pluginBuilds.filter(p => reused.includes(p.id)).map(p => ({ ...p })), rebuilt: [...selected] };
  } catch (error) {
    if (error.message.startsWith('不能复用插件产物：')) {
      // 自动模式不因为「判不了」挡住发布：退回整套重建，本身就是不带参数的路径。
      if (auto) return full(error.reuseReason ?? error.message);
      throw error;
    }
    if (auto) return full(`旧发布或构建输入无法核验（${error.message}）`);
    refuse(`旧发布或构建输入无法核验（${error.message}）`);
  }
}
