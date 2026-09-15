/**
 * 稳定站点绑定：服务目标与数据位置的一次性事实来源（设计 5.1）。
 *
 * `.local/site-binding.json` 只记录「这个站点用哪些持久目录与哪个 profile/compose 项目」，
 * 不存镜像、容器 ID、Docker engine ID 或发布状态。每个独立持久目录根放一个 `.dsh-site-id`
 * 标记（内容为 siteId，不含凭据），用于拒绝把另一站点的数据误当成当前站点。绑定损坏不能从
 * 失败 deployment.json 重新生成：普通发布报错并指向显式迁移。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { atomicJSON, canonical } from './state.mjs';

export const BINDING = '.local/site-binding.json';
export const SITE_MARK = '.dsh-site-id';

const fields = ['schemaVersion', 'siteId', 'root', 'dataRoot', 'home', 'workspace', 'authUrlFile', 'artifacts', 'profile', 'composeProject'];
const pathFields = ['root', 'dataRoot', 'home', 'workspace', 'authUrlFile', 'artifacts', 'profile', 'composeProject'];

/** 读取并校验绑定文件；不存在返回 null，格式无效直接报错。 */
export function readBinding(root) {
  const path = resolve(root, BINDING);
  if (!existsSync(path)) return null;
  const binding = JSON.parse(readFileSync(path, 'utf8'));
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) || binding.schemaVersion !== 1
    || typeof binding.siteId !== 'string' || !binding.siteId.trim() || Object.keys(binding).some(key => !fields.includes(key))) throw new Error('站点绑定文件格式无效。');
  for (const field of pathFields) {
    if (typeof binding[field] !== 'string' || !binding[field].trim()) throw new Error(`站点绑定字段 ${field} 无效。`);
  }
  return binding;
}

/** 绑定值与本次解析值必须一致；不一致时在任何安装写入之前失败。 */
export function assertBindingMatches(root, resolvedSite, composeProject) {
  const binding = readBinding(root);
  if (!binding) return null;
  const expected = { root: canonical(root), dataRoot: resolvedSite.dataRoot, home: resolvedSite.home, workspace: resolvedSite.workspace,
    authUrlFile: resolvedSite.authUrlFile, artifacts: resolvedSite.artifacts, profile: resolvedSite.profile, composeProject };
  for (const field of pathFields) {
    if (binding[field] !== expected[field]) throw new Error(`站点绑定 ${field} 与本次解析不一致（绑定为 ${binding[field]}）；恢复原路径或使用显式迁移，不会自动改写绑定。`);
  }
  return binding;
}

/** 独立持久目录根（嵌套目录沿用父目录，不重复）；目录重叠时去重。 */
export function siteMarkerRoots(directories) {
  const roots = [...new Set(directories)];
  return roots.filter(directory => !roots.some(other => other !== directory && directory.startsWith(`${other}${sep}`)));
}

/** 单个目录必须带本站点标记：缺失或属于其他站点都拒绝。 */
export function assertMarked(directory, siteId) {
  const mark = resolve(directory, SITE_MARK);
  if (!existsSync(mark)) throw new Error(`持久目录缺少站点标记 ${SITE_MARK}：${directory}；请使用显式迁移导入，不会自动补建标记。`);
  if (readFileSync(mark, 'utf8').trim() !== siteId) throw new Error(`持久目录 ${directory} 的站点标记属于其他站点；拒绝写入。`);
}

/**
 * 本次部署的站点身份（设计 2.6、5.1）：容器内由本次部署配置提供，宿主路径由稳定绑定提供。
 *
 * 只做「取身份 + 两者一致」这一件事，是否允许缺身份由调用方决定：写授权集合的路径必须拒绝缺身份，
 * 只读诊断可以在没有绑定时继续。不在这里兜底生成身份，避免把一个站点的授权悄悄带到另一个站点。
 */
export function resolveSiteIdentity(root, configSiteId) {
  const binding = existsSync(resolve(root, BINDING)) ? readBinding(root) : null;
  if (binding && configSiteId !== undefined && binding.siteId !== configSiteId) throw new Error('部署配置的 siteId 与站点绑定不一致；拒绝继续。');
  return configSiteId ?? binding?.siteId;
}

/**
 * 已存在的持久目录根必须带同一 siteId 的标记；缺失或属于其他站点都拒绝写入。嵌套目录沿用父标记。
 *
 * 绑定的每个目录都必须真的存在（设计 5.1：已有绑定后原目录或标记缺失都在安装写入之前失败）。
 * workspace 里可能有用户文件，不能当作可再生目录补建。承载状态的 home 即使嵌套在 dataRoot 下也
 * 单独核对存在性。
 *
 * `requireData: false` 只给 rebind 核对旧绑定用：物理搬迁后旧位置可能已经不在了，新目标才是严格
 * 核对对象。`allowMissingMarks` 与 `allowMissingDirectories` 只给迁移重入用，而且必须由「同次转换
 * 的迁移计划」证明：前者允许补写标签，后者只允许补建**本次转换本来就要创建**的目录（计划里已记录
 * 当时不存在的那些），原本存在的目录缺失仍然拒绝。
 */
export function assertSiteMarks(binding, { requireData = true, allowMissingMarks = false, allowMissingDirectories } = {}) {
  if (requireData) for (const directory of [binding.dataRoot, binding.home, binding.workspace, binding.artifacts]) {
    if (!existsSync(directory) && !allowMissingDirectories?.has(directory)) throw new Error(`持久目录缺失：${directory}；不自动补建空目录来掩盖数据丢失，请核实存储或走显式迁移。`);
  }
  for (const directory of siteMarkerRoots([binding.dataRoot, binding.home, binding.workspace, binding.artifacts])) {
    if (!existsSync(directory)) continue;
    if (allowMissingMarks && !existsSync(resolve(directory, SITE_MARK))) continue;
    assertMarked(directory, binding.siteId);
  }
  return binding;
}

/**
 * 为真正空的新站点创建绑定与目录标记。调用方必须先确认没有旧数据、旧状态、容器或其他站点
 * 标记；本函数不做数据守卫，只写绑定与标记。嵌套目录沿用父标记，不重复写。
 */
export function initializeBinding(root, { dataRoot, home, workspace, authUrlFile, artifacts, profile, composeProject }, siteId) {
  const binding = { schemaVersion: 1, siteId, root: canonical(root), dataRoot, home, workspace, authUrlFile, artifacts, profile, composeProject };
  atomicJSON(resolve(root, BINDING), binding);
  writeMarks(binding);
  return binding;
}

/**
 * 幂等写标记：迁移在绑定之后补写，可与首次初始化共用同一实现。
 *
 * 目录与标记分开处理：每个持久目录都要真的存在（嵌套的 home/workspace 不能因为标记沿用父目录
 * 就被跳过），标记只写去重后的独立根。
 */
export function writeMarks({ dataRoot, home, workspace, artifacts, siteId }) {
  for (const directory of [dataRoot, home, workspace, artifacts]) mkdirSync(directory, { recursive: true });
  for (const directory of siteMarkerRoots([dataRoot, home, workspace, artifacts])) writeFileSync(resolve(directory, SITE_MARK), `${siteId}\n`);
}
