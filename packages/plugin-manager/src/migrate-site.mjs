/**
 * 一次性站点迁移（设计 6.2/6.3）：把旧 schema 2 受管状态与既有站点现场转换为新版 schema 3
 * managed 授权集合与稳定绑定。
 *
 * - 不带 `--apply` 只读预览：当前绑定、旧 STATE/pending、可导入的 managed 集合、非受管安装、
 *   原始可编辑配置路径、旧有效选集与全部 file: 引用；预览**不写任何文件**，配置缺失时退回既有
 *   旧 JSON，不靠初始化配置来“读现场”。
 * - `--apply --stopped-file <停写证据>` 才修改管理元数据。互斥分两层（设计 5.2）：站点锁挡住源码
 *   入口，profile 锁与安装（含容器内安装）共享。残留 LOCK 就是这把 profile 锁的文件，因此先按
 *   持有者证明复核、备份，再取锁；取锁、退役与显式解锁共用同一把 control 锁，退役期间不会有别的
 *   进程刚取得锁。现场事实在两级互斥都取得之后重新读取。之后顺序固定：
 *   方案摘要与旧记录副本先落受保护备份 → 保全 file: 引用 → 写绑定 → 补写目录标记 →
 *   原子写并复核 schema 3 → **确认之后**才把旧 pending/OWNER 移入备份 → 转换原配置 → 写完成标记。
 *   停写证据复用同步入口的唯一核验实现（字段 + 实查当前写入者；compose 声明还会核对本机引擎上
 *   有没有别的容器在写同一批持久目录），不接受仅填 stopped=true。
 * - `--rebind` 配合 `--apply`：先核对旧绑定与旧标记，再逐项核对新目标四个目录及其标记，最后写新绑定。
 * - `--archive-root <旧归档主机目录>`：旧活动记录缺失或损坏时，明确声明容器归档根在主机上的原位置，
 *   供挂载内 file: 引用的保全换算；不提供时按记录换算，换算不了就在写任何新元数据之前拒绝。
 * - 旧 source-release/result/active 记录保留原字节，只作诊断；旧活动记录损坏只影响映射线索。
 * - 中断重入（设计 6.3）：只有能证明属于**同一次且尚未完成**的转换（同 root/siteId/配置路径、
 *   授权集合一致、计划没有完成标记）时，才补齐缺标记、恢复已确认的旧选集，并且只补建计划里记为
 *   「本次才创建」的目录；已完成转换、授权集合被改、标记属于其他站点等情况一律按正常路径拒绝。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LOCK, OWNER, PENDING, STATE, atomicJSON, canonical, hash, readOptional, within } from './state.mjs';
import { SITE_MARK, assertBindingMatches, assertSiteMarks, readBinding, siteMarkerRoots, writeMarks } from './site-binding.mjs';
import { resolveDeployment } from './config.mjs';
import { containerPaths } from './compose.mjs';
import { loadSite } from './site-config.mjs';
import { alive, verifyStoppedEvidence } from './process.mjs';
import { acquireSourceLock } from './site-lock.mjs';
import { withLockControl } from './lock.mjs';
import { acquireLock, managedFile } from './installation.mjs';
import { ensurePrivateDirectory, writePrivateFile } from './private-files.mjs';

/** 旧状态只读读取：schema 3 视为已迁移；schema 2 提取 plugins/candidates；其余报错。 */
function legacyState(deployment) {
  const path = join(deployment.profileRoot, STATE);
  if (!existsSync(path)) return { kind: 'missing' };
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (state.schemaVersion === 3) return { kind: 'current', state };
  if (state.schemaVersion === 2 && Array.isArray(state.plugins)) return { kind: 'legacy', state };
  throw new Error('旧受管状态格式无法识别；保留现场。');
}

/** 从旧 STATE.plugins 与 pending.touched 并集导入 id/package 映射，不读 pending.desired。 */
function collectManaged(legacy, pending) {
  const managed = new Map();
  for (const entry of [...(legacy?.state?.plugins ?? []), ...(pending?.touched ?? [])]) {
    if (entry && typeof entry.id === 'string' && typeof entry.package === 'string' && !managed.has(entry.package)) managed.set(entry.package, { id: entry.id, package: entry.package });
  }
  return [...managed.values()];
}

/**
 * 当前运行容器的挂载声明：容器地址到主机路径只能按 destination→source 换算。
 *
 * 旧活动记录只作**辅助线索**（设计 6.2）：损坏或无指向时退回「没有映射」，由引用保全环节列出
 * 无法换算的具体引用并给出补救入口，而不是让一条旧记录阻断整个迁移。
 */
function activeMounts(root, artifacts) {
  const activeFile = resolve(root, artifacts, 'active-compose.json');
  if (!existsSync(activeFile)) return [];
  let active;
  try { active = JSON.parse(readFileSync(activeFile, 'utf8')); }
  catch { console.warn(`旧活动记录无法解析，按没有挂载映射处理：${activeFile}`); return []; }
  if (!active?.path || !existsSync(active.path)) return [];
  let compose;
  try { compose = JSON.parse(readFileSync(active.path, 'utf8')); }
  catch { console.warn(`旧 Compose 文件无法解析，按没有挂载映射处理：${active.path}`); return []; }
  return (compose?.services?.dsh?.volumes ?? []).filter(volume => typeof volume?.target === 'string' && typeof volume?.source === 'string');
}

/**
 * 把 profile 里的 file: 引用解析为主机路径。
 *
 * 官方 CLI 在容器内安装，写进 profile 的是**容器地址**（归档根固定挂载到 /opt/plugin-packages），
 * 当成主机绝对路径会得到不存在的路径。因此先按当前运行容器的挂载映射换算（destination→source），
 * 再退回「相对 profileRoot 解析」，最后按是否落在挂载来源内区分挂载内/挂载外。
 */
function referenceTarget(spec, profileRoot, mounts) {
  const value = spec.slice('file:'.length);
  if (isAbsolute(value)) {
    const absolute = resolve(value);
    for (const mount of mounts) {
      const destination = resolve(mount.target), source = resolve(mount.source);
      if (absolute === destination || absolute.startsWith(`${destination}${sep}`)) {
        const host = resolve(source, relative(destination, absolute));
        return { host, rel: relative(source, host).split(sep).join('/') };
      }
      if (absolute === source || absolute.startsWith(`${source}${sep}`)) return { host: absolute, rel: relative(source, absolute).split(sep).join('/') };
    }
    return { host: absolute };
  }
  const host = canonical(resolve(profileRoot, value));
  for (const mount of mounts) {
    const source = canonical(mount.source);
    if (within(source, host)) return { host, rel: relative(source, host).split(sep).join('/') };
  }
  return { host };
}

/**
 * 只读规划 file: 引用的保全（设计 6.2 最后一段）：解析、分类、核验可达与目标内容冲突，不复制。
 * 挂载内引用保留完整相对路径，不取 basename；挂载外引用只要求原地址可达。
 *
 * `archiveRoot` 是操作者明确声明的旧归档位置：容器归档根固定挂在 /opt/plugin-packages，
 * 旧记录缺失或损坏时按它换算，不再要求恢复一条已不可读的旧记录。
 */
function planFileReferences(root, deployment, artifacts, archiveRoot) {
  const manifest = readOptional(join(deployment.profileRoot, 'package.json'));
  const cacheRoot = resolve(root, artifacts, 'plugin-packages');
  const mounts = activeMounts(root, artifacts);
  if (archiveRoot !== undefined) {
    const directory = resolve(root, archiveRoot);
    if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error(`--archive-root 必须是存在的目录：${directory}`);
    mounts.unshift({ source: directory, target: '/opt/plugin-packages' });
  }
  const plan = [];
  for (const [name, spec] of Object.entries(manifest?.dependencies ?? {})) {
    if (typeof spec !== 'string' || !spec.startsWith('file:')) continue;
    const target = referenceTarget(spec, deployment.profileRoot, mounts);
    if (target.rel !== undefined) {
      if (!existsSync(target.host)) throw new Error(`挂载内旧归档引用不可达：${name} ${spec}（主机路径 ${target.host}）；提供原归档后再迁移。`);
      const cachePath = resolve(cacheRoot, target.rel);
      if (existsSync(cachePath) && hash(readFileSync(cachePath)) !== hash(readFileSync(target.host))) throw new Error(`缓存目标已存在且内容不同：${cachePath}；请先处理该文件再迁移。`);
      plan.push({ package: name, spec, kind: 'mounted', cached: `plugin-packages/${target.rel}`, from: target.host, cachePath, copy: !existsSync(cachePath) });
    } else {
      if (!existsSync(target.host)) throw new Error(`挂载外 file: 引用不可达：${name} ${spec}；提供原归档、用 --archive-root 指明旧归档位置，或先做明确的路径迁移。`);
      plan.push({ package: name, spec, kind: 'external', kept: target.host });
    }
  }
  return { cacheRoot, plan };
}

/** 挂载内引用按完整相对路径复制进本次缓存根。 */
function applyFileReferences(refs) {
  for (const item of refs.plan) if (item.copy) {
    mkdirSync(dirname(item.cachePath), { recursive: true });
    cpSync(item.from, item.cachePath);
    if (hash(readFileSync(item.cachePath)) !== hash(readFileSync(item.from))) throw new Error(`缓存复制后摘要不一致：${item.cached}。`);
  }
}

/** 现场事实只读读取：预览与应用共用，任何一步都不写站点状态。 */
function readSiteFacts(root, config) {
  const { site, sitePath, source } = loadSite(root, config, { legacy: true, initialize: false });
  const deployment = resolveDeployment({ root, config: sitePath }, {}, { allowRemovedFields: true });
  const binding = readBinding(root);
  const state = existsSync(join(deployment.profileRoot, STATE)) ? legacyState(deployment) : { kind: 'missing' };
  const pending = readOptional(join(deployment.profileRoot, PENDING));
  const managed = state.kind === 'current' ? state.state.managed : collectManaged(state.kind === 'legacy' ? state : null, pending);
  const raw = sitePath.endsWith('.conf') ? null : readOptional(sitePath);
  const candidates = state.kind === 'legacy' && Array.isArray(state.state.candidates) ? state.state.candidates : undefined;
  return { site, sitePath, source, deployment, binding, state, pending, managed, candidates,
    explicitSelection: sitePath.endsWith('.conf') ? Object.hasOwn(source?.config ?? {}, 'plugins') : Object.hasOwn(raw ?? {}, 'plugins'),
    legacyMode: source?.removed?.DSH_PLUGIN_SOURCE ?? raw?.pluginSource ?? null };
}

/**
 * 中断中的同一次转换（设计 6.3）：只有能证明「这个计划就是当前这次转换、而且它还没结束」时，
 * 才允许补齐标记、恢复旧选集。
 *
 * 判据是三条一起成立：同一 canonical root 与 siteId、同一份原始配置路径、计划记录的授权集合与当前
 * 元数据一致，并且计划尚未写入完成标记。任何一条不符都不算同次转换——换了 managed、换了配置路径或
 * 已经完成的转换都走正常路径（缺标记就拒绝），不会被当成重入而自动修补。
 */
function priorPlan(root, facts, deployment) {
  const directory = resolve(root, '.local/artifacts/migration-backups');
  if (!existsSync(directory)) return null;
  const binding = facts.binding;
  const plans = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = resolve(directory, entry.name, 'plan.json');
    if (!existsSync(file)) continue;
    let plan;
    try { plan = JSON.parse(readFileSync(file, 'utf8')); }
    catch { continue; /* 损坏的计划副本不是本次转换的证据。 */ }
    if (plan && plan.root === root && plan.siteId === binding.siteId) plans.push(plan);
  }
  // 只认**最近一次**该转换的计划：它是唯一能代表「这次转换进行到哪」的记录。更早的计划即使没有
  // 完成标记，也不能在后来已经完成的转换上重新打开补写权限。
  const newest = plans.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (!newest || newest.completedAt !== undefined) return null;
  if (newest.sitePath !== facts.sitePath || newest.profile !== deployment.profile) return null;
  if (JSON.stringify(newest.managed ?? []) !== JSON.stringify(facts.managed)) return null;
  return newest;
}

/**
 * 存量站点没有显式选区时，旧有效候选必须能还原；不能拿本次 managed 猜测（设计 6.2 第 7 步）。
 *
 * 中断重跑时旧的 schema 2 记录已经被移入备份，候选只能从同次转换的迁移计划里恢复（设计 6.3）；
 * schema 3 已是本次转换的产物且没有计划时，不再要求候选记录。
 */
function requiredSelection(facts, plan) {
  if (facts.explicitSelection) return undefined;
  if (Array.isArray(plan?.selection)) return plan.selection;
  if (facts.state.kind === 'current') return undefined;
  if (Array.isArray(facts.candidates)) return facts.candidates;
  throw new Error('无法还原旧有效候选集合（旧状态没有 candidates 记录）；请先在站点配置里显式设置 DSH_PLUGINS，再重试迁移；不会猜测选集。');
}

/** 迁移前的现场核对：数据与安装层必须在场，不接受把缺失目录补成空目录。 */
function assertMigrationFacts(facts, { rebind }) {
  const { deployment, state, binding } = facts;
  if (!existsSync(deployment.profileRoot)) throw new Error(`目标 profile 不存在：${deployment.profileRoot}；没有可迁移的现场。`);
  for (const directory of [deployment.dataRoot, deployment.home]) {
    if (!existsSync(directory)) throw new Error(`迁移要求既有持久目录在场：${directory}；请核实存储，不自动补建空目录来掩盖数据丢失。`);
  }
  if (state.kind === 'current') {
    const siteId = state.state.siteId;
    if (siteId !== undefined && binding && siteId !== binding.siteId) throw new Error(`既有 schema 3 状态的 siteId（${siteId}）与站点绑定（${binding.siteId}）不一致；保留现场并人工核实。`);
  }
  if (!rebind && !binding) for (const directory of [deployment.dataRoot, deployment.home, deployment.workspace, deployment.artifacts]) {
    const mark = resolve(directory, SITE_MARK);
    if (existsSync(mark)) throw new Error(`持久目录 ${directory} 已带站点标记但没有绑定；拒绝把来源不明的数据当作本站点迁移，请人工核实后清理标记或恢复绑定。`);
  }
  // 残留记录：本机仍在运行的持锁进程说明写入者没退出，保留现场（设计 5.2、6.2 第 3 步）。
  let lock;
  try { lock = readOptional(join(deployment.profileRoot, LOCK)); }
  catch (error) { throw new Error(`profile 锁记录无法解析（${error.message}）；保留现场并人工核实后再迁移。`); }
  if (lock && lock.host === hostname() && Number.isSafeInteger(lock.pid) && alive(lock.pid)) throw new Error(`profile 锁仍由本机进程 ${lock.pid} 持有；确认写入者退出后再迁移。`);
  return facts;
}

/** --rebind 的目标目录必须是已迁移的数据：四个目录逐项存在，标记按独立根去重核对（设计 5.1、6.3）。 */
function assertRebindTargets(next) {
  // 嵌套的 workspace 也要单独核对存在性：只看去重后的标记根会让「复制 dataRoot 时漏掉内部
  // workspace」被补成一个空目录，而那正是要拒绝的数据丢失。
  for (const directory of [next.dataRoot, next.home, next.workspace, next.artifacts]) {
    if (!existsSync(directory)) throw new Error(`--rebind 目标目录不存在：${directory}；请先完成数据复制再更新绑定。`);
  }
  for (const directory of siteMarkerRoots([next.dataRoot, next.home, next.workspace, next.artifacts])) {
    const mark = resolve(directory, SITE_MARK);
    if (!existsSync(mark) || readFileSync(mark, 'utf8').trim() !== next.siteId) throw new Error(`--rebind 目标目录缺少本站点标记（${SITE_MARK}）：${directory}；拒绝把其他站点或空目录当作目标。`);
  }
}

/**
 * 残留 profile 锁的必要字段：缺一个都无法证明持有者是谁、是否已退出。
 *
 * 与写入方（lock.mjs 的 acquireFileLock）的字段一致：pid 正整数、host 与 token 非空、createdAt
 * 可解析。字段缺失或损坏一律拒绝——缺 PID 不能当成已退出。
 */
function assertLockRecord(record, path) {
  const ok = record && typeof record === 'object' && !Array.isArray(record)
    && Number.isSafeInteger(record.pid) && record.pid > 0
    && typeof record.host === 'string' && record.host.trim() !== ''
    && typeof record.token === 'string' && record.token !== ''
    && Number.isFinite(Date.parse(record.createdAt));
  if (!ok) throw new Error(`残留 profile 锁记录不完整或已损坏（需要 pid/host/token/createdAt）：${path}；保留现场并人工核实，不按已退出处理。`);
  return record;
}

/**
 * 运行记录（OWNER）的必要字段：按写入方（supervisor.mjs）的真实格式核对 pid/host/token/home/profile/port。
 *
 * OWNER 不是互斥锁，写入方也不写 createdAt；createdAt 与持有者证明无关，因此不作为旧 OWNER 的硬门槛
 * ——否则 supervisor 异常退出留下的、格式完全合法的记录会被判成损坏而阻断迁移。
 */
function assertOwnerRecord(record, path) {
  const ok = record && typeof record === 'object' && !Array.isArray(record)
    && Number.isSafeInteger(record.pid) && record.pid > 0
    && typeof record.host === 'string' && record.host.trim() !== ''
    && typeof record.token === 'string' && record.token !== ''
    && typeof record.home === 'string' && record.home !== ''
    && typeof record.profile === 'string' && record.profile !== ''
    && Number.isSafeInteger(record.port) && record.port > 0;
  if (!ok) throw new Error(`运行记录不完整或已损坏（需要 pid/host/token/home/profile/port）：${path}；保留现场并人工核实，不按已退出处理。`);
  return record;
}

/**
 * 退役残留 profile 锁（设计 5.2）：迁移要与安装共享同一把 profile 锁，而残留记录就是这把锁的文件，
 * 所以必须先证明持有者已退出、原字节备份，再取锁。
 *
 * 证明只有两种成立：
 * - 记录属于本机且进程已退出（同一 PID 命名空间，可直接核实）；
 * - 记录来自容器命名空间（主机名不是本机）：只有停写证据声明 compose、并且本机引擎上已没有任何
 *   运行中容器写这些持久目录时才算证明——锁的持有者必然是一个正在写该 profile 的容器。
 * 其余来源不明的记录一律拒绝，并给出「确认原容器已停后把记录移出 profile 目录」的人工步骤：
 * 不能仅凭另一个进程的停写证据退役来源不明的锁。
 *
 * 抢占窗口由 control 锁关闭：取锁、退役、显式解锁共用同一把 control 锁（lock.mjs），因此
 * 「读一遍确认是旧记录」与「把它移走」之间不会插进另一个进程新建的锁。
 */
function retireResidualLock(deployment, backup, { containerProven }) {
  const path = join(deployment.profileRoot, LOCK);
  if (!existsSync(path)) return false;
  return withLockControl(path, () => {
    if (!existsSync(path)) return false; // 竞争者在拿 control 锁之前刚释放。
    const before = readFileSync(path);
    const record = assertLockRecord(JSON.parse(before.toString('utf8')), path);
    const local = record.host === hostname();
    if (local && alive(record.pid)) throw new Error(`profile 锁仍由本机进程 ${record.pid} 持有；确认写入者退出后再迁移。`);
    if (!local && !containerProven) throw new Error(`残留 profile 锁来自其他主机/容器（${record.host}），本机无法核实持有者是否退出：请确认原容器已停止后，把 ${path} 移出 profile 目录（保留副本）再重试迁移。`);
    renameSync(path, resolve(backup, LOCK));
    console.log(`残留 profile 锁已备份并退役：${resolve(backup, LOCK)}`);
    return true;
  });
}

/**
 * 运行记录（OWNER）是否指向本次迁移目标（设计 5.2：运行所有者身份包含 home/profile）。
 *
 * 字段完整还不够：一份属于别的 home/profile 的记录不能因为「本机 PID 已退出」就被退役。判定分三种现场：
 * - 宿主命名空间写下的记录：home 直接与本次目标逐字比较（canonical）；
 * - 容器命名空间写下的记录：先按**旧挂载映射**换算回宿主路径（与 file: 引用保全同一份证据），
 *   没有映射时按 compose 的容器内路径推导（`containerPaths`，与渲染挂载同源）比较。
 * 两者都不成立就是目标不符，保留现场。
 */
export function ownerTargetMatches(record, deployment, mounts = []) {
  const target = canonical(deployment.home);
  if (canonical(record.home) === target) return true;
  for (const mount of mounts) {
    if (typeof mount.source !== 'string' || typeof mount.target !== 'string') continue;
    // 与 file: 引用的挂载换算同一套写法：两侧都按同一解析器归一，再按 destination 求相对路径。
    const destination = resolve(mount.target), source = resolve(mount.source), home = resolve(String(record.home));
    if (home !== destination && !home.startsWith(`${destination}${sep}`)) continue;
    if (canonical(resolve(source, relative(destination, home))) === target) return true;
  }
  return record.home === containerPaths(deployment).home;
}

/**
 * 旧运行记录（OWNER）的处置判据与残留锁一致：字段完整、目标一致、本机且进程已退出可以直接搬走，
 * 容器来源必须由 compose 停写证据 + 引擎无重叠写入者证明；搬走前复核字节，避免搬走另一个进程刚写
 * 的新记录。
 */
function residualRecords(deployment, { containerProven, mounts }) {
  const movable = [];
  for (const name of [PENDING, OWNER]) {
    const path = join(deployment.profileRoot, name);
    if (!existsSync(path)) continue;
    if (name === OWNER) {
      let record;
      try { record = JSON.parse(readFileSync(path, 'utf8')); }
      catch { throw new Error(`运行记录无法解析，保留现场：${path}；请人工核实后再迁移。`); }
      assertOwnerRecord(record, path);
      if (record.profile !== deployment.profile) throw new Error(`运行记录的目标 profile（${record.profile}）与本次迁移（${deployment.profile}）不一致：${path}；保留现场并人工核实。`);
      if (!ownerTargetMatches(record, deployment, mounts)) throw new Error(`运行记录的目标 home（${record.home}）与本次迁移（${deployment.home}）不一致：${path}；保留现场并人工核实。`);
      const local = record.host === hostname();
      if (local && alive(record.pid)) throw new Error(`运行记录仍由本机进程 ${record.pid} 持有；确认写入者退出后再迁移。`);
      if (!local && !containerProven) throw new Error(`运行记录来自其他主机/容器（${record.host}），本机无法核实持有者是否退出：请确认原容器已停止后，把 ${path} 移出 profile 目录（保留副本）再重试迁移。`);
    }
    movable.push({ name, path, bytes: readFileSync(path) });
  }
  return movable;
}

/** 转换原配置：删掉已移除的旧模式字段，必要时把旧有效候选写成显式选集。其余字节原样保留。 */
function convertSiteConfig(sitePath, { selection }) {
  const original = readFileSync(sitePath, 'utf8');
  let text;
  if (sitePath.endsWith('.conf')) {
    const lines = original.split('\n'), kept = [];
    let wroteSelection = false;
    for (const line of lines) {
      const key = /^\s*([A-Z][A-Z0-9_]*)\s*=/u.exec(line)?.[1];
      if (key === 'DSH_PLUGIN_SOURCE') continue;
      if (key === 'DSH_PLUGINS' && selection !== undefined) { kept.push(`DSH_PLUGINS=${JSON.stringify(selection)}`); wroteSelection = true; continue; }
      kept.push(line);
    }
    if (selection !== undefined && !wroteSelection) {
      if (kept.length && kept.at(-1) !== '') kept.push('');
      kept.push(`DSH_PLUGINS=${JSON.stringify(selection)}`);
    }
    text = kept.join('\n');
  } else {
    const value = JSON.parse(original);
    delete value.pluginSource;
    if (selection !== undefined) value.plugins = selection;
    text = `${JSON.stringify(value, null, 2)}\n`;
  }
  if (text === original) return false;
  const temporary = `${sitePath}.migrate.tmp`;
  writePrivateFile(temporary, text);
  renameSync(temporary, sitePath);
  return true;
}

export function migrateSitePreview(root, { config, archiveRoot } = {}) {
  root = canonical(root);
  const facts = readSiteFacts(root, config);
  const manifest = readOptional(join(facts.deployment.profileRoot, 'package.json'));
  const managedNames = new Set(facts.managed.map(entry => entry.package));
  const nonManaged = Object.entries(manifest?.dependencies ?? {}).filter(([name]) => !managedNames.has(name)).map(([name, spec]) => ({ package: name, spec }));
  const refs = planFileReferences(root, facts.deployment, facts.binding?.artifacts ?? facts.deployment.artifacts, archiveRoot);
  const plan = facts.binding ? priorPlan(root, facts, facts.deployment) : null;
  return {
    root, sitePath: facts.sitePath, binding: facts.binding ? { siteId: facts.binding.siteId } : null,
    legacyMode: facts.legacyMode,
    state: facts.state.kind === 'legacy' ? { schemaVersion: 2, plugins: facts.state.state.plugins.map(({ id, package: name }) => ({ id, package: name })) } : facts.state.kind === 'current' ? { schemaVersion: 3, managed: facts.state.state.managed } : null,
    pending: facts.pending ? { operationId: facts.pending.operationId } : null,
    managed: facts.managed, nonManaged, explicitSelection: facts.explicitSelection, candidates: facts.candidates ?? null,
    // 同次转换已确认过的选集：中断重跑时 apply 会据此补写，预览必须显示同一份值。
    selection: Array.isArray(plan?.selection) ? plan.selection : null,
    fileRefs: refs.plan.map(({ package: name, spec, kind, cached, kept }) => ({ package: name, spec, kind, ...(cached ? { cached } : {}), ...(kept ? { kept } : {}) })),
    plan: facts.binding ? ['绑定已存在，apply 只导入 managed 并写 schema 3 状态'] : ['创建站点绑定与目录标记', '导入 managed 授权集合', '写 schema 3 状态并备份旧记录'],
  };
}

export function migrateSiteApply(root, { config, stoppedFile, rebind = false, archiveRoot } = {}) {
  root = canonical(root);
  if (!stoppedFile) throw new Error('--apply 需要 --stopped-file 停写证据。');
  // 先解析目标路径：profile 锁要按解析结果定位；现场事实在两级互斥都取得之后重新读取。
  let facts = readSiteFacts(root, config);
  // 站点锁挡住源码入口；profile 锁与安装（含容器内安装）共享同一把（设计 5.2），
  // 否则一次直接 synchronize 就能和迁移同时写授权、绑定与安装层。
  const releaseSite = acquireSourceLock(root, '站点正在构建或同步；迁移必须在互斥下修改绑定与受管授权。');
  let releaseProfile;
  try {
    assertMigrationFacts(facts, { rebind });
    // 本次转换开始前就不存在的持久目录：只有这些才允许在重入时补建。必须在建立备份目录**之前**
    // 记录——备份目录本身就会把 artifacts 根创建出来，之后再看就永远看不到它原本不存在。
    const createdDirectories = new Set([facts.deployment.dataRoot, facts.deployment.home, facts.deployment.workspace, facts.deployment.artifacts].filter(directory => !existsSync(directory)));
    // 停写证据复用同步入口的唯一实现：字段语义 + 实查当前写入者；compose 声明还会核对本机引擎上
    // 是否有别的容器仍在写同一批持久目录（设计 5.1、6.2）。这份证据也是退役容器来源锁的前提。
    const evidence = verifyStoppedEvidence(stoppedFile, facts.deployment);
    const containerProven = evidence.manager === 'compose';
    // 备份目录先建立：残留锁的原字节与方案摘要都落在这里，之后才动现场（设计 6.3）。
    const backup = resolve(ensurePrivateDirectory(resolve(root, '.local/artifacts/migration-backups')), randomUUID());
    ensurePrivateDirectory(backup);
    const retiredLock = retireResidualLock(facts.deployment, backup, { containerProven });
    releaseProfile = acquireLock(facts.deployment.profileRoot);
    // 取锁后重读事实：选集、pending 与旧活动记录都以互斥内的现场为准（设计 6.2）。
    facts = readSiteFacts(root, config);
    const { deployment, sitePath, site } = facts;
    // 仅当能证明这就是同一次未完成的转换时，才允许补标记、恢复旧选集、补建本次要创建的目录。
    const plan = facts.binding ? priorPlan(root, facts, deployment) : null;
    const pending = residualRecords(deployment, { containerProven, mounts: activeMounts(root, facts.binding?.artifacts ?? deployment.artifacts) });
    const composeProject = site.composeProject ?? 'dsh-plugins';
    let binding = facts.binding, next;
    if (binding && !rebind) {
      assertBindingMatches(root, deployment, composeProject);
      // 补标记只对同次未完成转换开放；补建目录也只允许计划里记录为「本次才创建」的那些，
      // 原本存在的目录缺失仍然拒绝。属于其他站点的标记始终拒绝。
      assertSiteMarks(binding, { allowMissingMarks: plan !== null, ...(plan ? { allowMissingDirectories: new Set(plan.createdDirectories ?? []) } : {}) });
      next = binding;
    } else if (binding) {
      // rebind：旧位置可能已经搬走，只核对仍在场的旧标记；严格核对移到新目标上。
      assertSiteMarks(binding, { requireData: false });
      next = { ...binding, root, dataRoot: deployment.dataRoot, home: deployment.home, workspace: deployment.workspace,
        authUrlFile: deployment.authUrlFile, artifacts: deployment.artifacts, profile: deployment.profile, composeProject };
      assertRebindTargets(next);
    } else {
      next = { schemaVersion: 1, siteId: `site-${randomUUID()}`, root, dataRoot: deployment.dataRoot, home: deployment.home,
        workspace: deployment.workspace, authUrlFile: deployment.authUrlFile, artifacts: deployment.artifacts, profile: deployment.profile, composeProject };
    }
    const selection = requiredSelection(facts, plan);
    const refs = planFileReferences(root, deployment, facts.binding?.artifacts ?? deployment.artifacts, archiveRoot);
    // 1) 方案摘要与旧记录副本先落受保护目录，原文件此时不动（设计 6.3：执行前打印并写入）。
    const planPath = resolve(backup, 'plan.json');
    const residuals = pending.map(item => item.name);
    writeFileSync(planPath, `${JSON.stringify({ createdAt: new Date().toISOString(), root, sitePath, profile: deployment.profile, siteId: next.siteId, rebind, retiredLock, resumed: plan !== null,
      legacyMode: facts.legacyMode, managed: facts.managed, explicitSelection: facts.explicitSelection, candidates: facts.candidates ?? null,
      selection: selection ?? null, archiveRoot: archiveRoot ?? null, createdDirectories: [...createdDirectories], fileRefs: refs.plan, residuals }, null, 2)}\n`, { mode: 0o600 });
    for (const [name, path] of [['profile-state.json', join(deployment.profileRoot, STATE)], [`site-config${extname(sitePath)}`, sitePath],
      ...residuals.map(item => [item, join(deployment.profileRoot, item)])]) if (existsSync(path)) cpSync(path, resolve(backup, name));
    console.log(`迁移备份：${backup}`);
    console.log(`迁移计划：站点 ${next.siteId}；导入 managed ${facts.managed.length} 项；file: 引用 ${refs.plan.length} 项；旧记录 ${[...(retiredLock ? [LOCK] : []), ...residuals].join(', ') || '无'}${plan ? '（同次转换重入）' : ''}`);
    // 2) 先保全 file: 引用：切换挂载前完成，失败时尚未写任何新元数据。
    applyFileReferences(refs);
    // 3) 写绑定，再幂等补写标记；绑定在前保证中断后可重入（重跑补标记即可）。
    if (!binding || rebind) atomicJSON(resolve(root, '.local/site-binding.json'), next);
    writeMarks(next);
    binding = readBinding(root);
    // 4) 原子写 schema 3 并复核；确认之后才移走旧记录。构造走授权集合的唯一实现（设计 2.6）。
    atomicJSON(join(deployment.profileRoot, STATE), managedFile(deployment, facts.managed));
    const written = legacyState(deployment);
    if (written.kind !== 'current' || written.state.siteId !== binding.siteId
      || JSON.stringify(written.state.managed) !== JSON.stringify(facts.managed)) throw new Error('迁移写入的 schema 3 状态复核不一致；保留现场。');
    const moved = [];
    for (const item of pending) {
      // 搬走前复核字节：搬走的必须是核验过的那一份，不能是另一个进程刚写的新记录。
      if (!readFileSync(item.path).equals(item.bytes)) throw new Error(`复核期间运行记录已变化，保留现场：${item.path}；重新运行迁移。`);
      renameSync(item.path, resolve(backup, item.name));
      moved.push(item.name);
    }
    // 5) 转换原配置：去掉已移除字段（预览列出的旧模式），必要时显式化旧候选选集。
    const converted = convertSiteConfig(sitePath, { selection });
    // 迁移成功后的配置必须能被正常入口直接解析：不允许留下已移除字段。
    if (sitePath.endsWith('.conf')) loadSite(root, sitePath, { legacy: false, initialize: false });
    // 完成标记写在做完所有转换之后：中断（未写完成标记）才允许重入补写，
    // 已完成的转换再跑就是普通路径，不会被当成重入去修补后来损坏的现场（设计 6.3）。
    const completed = { ...JSON.parse(readFileSync(planPath, 'utf8')), completedAt: new Date().toISOString(), moved, converted };
    writeFileSync(planPath, `${JSON.stringify(completed, null, 2)}\n`, { mode: 0o600 });
    return { status: 'migrated', binding, managed: facts.managed, selection: selection ?? null, backup, moved, retiredLock, converted, fileRefs: refs.plan.length, siteId: binding.siteId };
  } finally {
    releaseProfile?.();
    releaseSite();
  }
}

export function main(args = process.argv.slice(2)) {
  const options = { apply: false, rebind: false };
  for (let index = 0; index < args.length; index += 1) {
    if (['--apply', '--rebind'].includes(args[index])) options[args[index].slice(2)] = true;
    else if (['--root', '--config', '--stopped-file', '--archive-root'].includes(args[index]) && args[index + 1] && !args[index + 1].startsWith('--')) {
      // `--stopped-file` 映射到导出 API 的 stoppedFile：CLI 名与参数名不一致会让 apply 永远拿不到证据。
      options[args[index] === '--stopped-file' ? 'stoppedFile' : args[index] === '--archive-root' ? 'archiveRoot' : args[index].slice(2)] = args[++index];
    } else throw new Error(`未知参数：${args[index]}。用法：migrate-site --root <站点根> [--config <env.conf>] [--archive-root <旧归档主机目录>] [--apply --stopped-file <停写证据>] [--rebind]`);
  }
  if (!options.root) throw new Error('migrate-site 需要 --root。');
  if (options.rebind && !options.apply) throw new Error('--rebind 必须与 --apply 一起使用。');
  const result = options.apply ? migrateSiteApply(options.root, options) : migrateSitePreview(options.root, options);
  console.log(JSON.stringify(result, null, 2));
}
