/**
 * 只读的发布现场对账诊断。
 *
 * 发布失败或中断后现场常被人工干预（换镜像、重建容器、留旧记录）。本模块**只读**对比上一次发布
 * 记录、活动 Compose、镜像、容器与 profile 证据，报告**现场差异**与需要人工核实的事项；**不写任何
 * 状态、不动容器、不改生产数据**——真正的收敛必须由操作者看过报告后显式执行。
 *
 * 旧记录只作诊断（设计 3 节、5.4）：失败指针、旧容器、旧镜像都不再阻断下一次普通 build，因此这里
 * 不再声称「会被拦下」，也不要求恢复旧代次；它回答的是「记录说的和现场实际的差在哪」。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArguments, resolveDeployment } from './config.mjs';
import { readSiteJson, sitePointer } from './site-record.mjs';
import { LOCK, OWNER, STATE, within } from './state.mjs';

export const conditions = ['no-record', 'consistent', 'candidate-image-missing', 'container-evidence-missing', 'container-replaced', 'record-drift'];

/** 除 ready 以外的指针状态：只用于说明上次发布没有正常结束，不作为发布准入。 */
const UNFINISHED = ['building', 'prepared', 'backing-up', 'applying', 'build-failed', 'deployment-failed'];
const short = value => typeof value === 'string' && value.length > 12 ? value.slice(0, 12) : value ?? null;

function probe(execute, args) {
  try {
    const result = execute(args, { encoding: 'utf8' });
    if (!result || result.status !== 0 || result.error) return null;
    return String(result.stdout ?? '');
  } catch { return null; }
}

/**
 * Keep reports comparable across environments: project-relative paths only.
 *
 * 相对路径按站点根解析（不按诊断进程的 cwd），并且用 `within` 判定边界：只比较字符串前缀
 * 会漏掉另一盘符的绝对路径（Windows 上 `relative('E:\\a', 'C:\\b')` 返回绝对路径而不是 `..`）。
 */
function relativeTo(root, path) {
  if (typeof path !== 'string' || !path) return null;
  const resolved = resolve(root, path);
  if (!within(root, resolved)) return null;
  return relative(resolve(root), resolved).split(sep).join('/');
}

function savedFacts(root, operation) {
  const recordPath = resolve(operation, 'result.json');
  if (!existsSync(recordPath)) return null;
  const record = readSiteJson(recordPath);
  const candidatePath = typeof record.candidatePath === 'string' ? record.candidatePath : null;
  const candidate = candidatePath && existsSync(candidatePath) ? readSiteJson(candidatePath) : null;
  return {
    operation: relativeTo(root, operation) ?? operation,
    recordId: short(record.siteOperation),
    schemaVersion: record.schemaVersion ?? null,
    inputKind: record.inputKind ?? null,
    status: record.status ?? null,
    candidateImage: candidate?.containerImage ?? null,
    activeImage: record.previousRuntime?.containerImage ?? record.previousRuntime?.image ?? null,
    activeManifest: relativeTo(root, record.previousRuntime?.manifest ?? ''),
    activeSiteOperation: short(record.previousRuntime?.siteOperation),
    selectedPlugins: Array.isArray(record.selectedPlugins) ? record.selectedPlugins.map(item => item.id) : null,
    enabledPlugins: Array.isArray(record.enabledPlugins) ? record.enabledPlugins : null,
    build: { timings: buildTimingFacts(root, record.timings?.path) },
  };
}

/** 最慢阶段只列前几名：报告要能看出被截断，所以同时给出总阶段数与这个上限。 */
const SLOWEST = 5;

/**
 * 只读读取一次构建的逐步计时（展示端写下的 timings.json）。
 *
 * 记录缺失、路径越界、文件不存在或无法解析都返回 null：老记录与没有计时的构建不该让诊断报错。
 * 只读：不创建目录、不写文件（与 check-records 的整体契约一致）。
 */
function buildTimingFacts(root, path) {
  if (typeof path !== 'string' || path === '') return null;
  const relative = relativeTo(root, path);
  if (relative === null) return null;
  const resolved = resolve(root, path);
  if (!existsSync(resolved)) return null;
  let timing;
  try { timing = readSiteJson(resolved); } catch { return null; }
  if (!timing || typeof timing !== 'object' || !Array.isArray(timing.stages)) return null;
  const stages = timing.stages.filter(stage => stage && typeof stage.label === 'string' && Number.isFinite(stage.elapsedMs));
  const slowest = [...stages].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, SLOWEST)
    .map(stage => ({ label: stage.label, elapsedMs: stage.elapsedMs, status: stage.status ?? null }));
  return { path: relative, buildId: timing.buildId ?? null, startedAt: timing.startedAt ?? null, finishedAt: timing.finishedAt ?? null,
    wallMs: timing.wallMs ?? null, sumMs: timing.sumMs ?? null, overlapMs: timing.overlapMs ?? null,
    exitCode: timing.exitCode ?? null, status: timing.status ?? null, stageCount: stages.length, stagesTotal: timing.stages.length,
    slowestLimit: SLOWEST, slowest, environment: timing.environment ?? {} };
}

function archiveCount(operation) {
  const directory = resolve(operation, 'plugins');
  if (!existsSync(directory)) return 0;
  return readdirSync(directory).filter(name => name.endsWith('.tgz')).length;
}

function containerFacts(deployment, execute) {
  const args = ['ps', '-a', '--format', '{{.ID}}'];
  const project = deployment.config.composeProject;
  if (project) args.push('--filter', `label=com.docker.compose.project=${project}`);
  const raw = probe(execute, args);
  if (raw === null) return { available: false, containers: [] };
  const ids = raw.split(/\s+/).filter(Boolean);
  if (!ids.length) return { available: true, containers: [] };
  const inspectRaw = probe(execute, ['inspect', ...ids]);
  if (inspectRaw === null) return { available: false, containers: [] };
  return { available: true, containers: JSON.parse(inspectRaw).map(container => {
    const variables = Object.fromEntries((container.Config?.Env ?? []).map(value => { const index = value.indexOf('='); return [value.slice(0, index), value.slice(index + 1)]; }));
    return {
      id: short(container.Id),
      name: String(container.Name ?? '').replace(/^\//, ''),
      configImage: container.Config?.Image ?? null,
      imageId: container.Image ?? null,
      running: container.State?.Running === true,
      health: container.State?.Health?.Status ?? null,
      service: container.Config?.Labels?.['com.docker.compose.service'] ?? null,
      home: variables.DSH_HOME ?? null,
      profile: variables.DSH_PROFILE ?? null,
      mounts: (container.Mounts ?? []).filter(item => item.Type === 'bind').map(item => ({ target: item.Destination, rw: item.RW === true })),
    };
  }) };
}

/** Local deployment-side evidence: profile records and the archives the profile pins. */
function deploymentEvidence(root, deployment) {
  const profileRoot = deployment.profileRoot;
  const manifestPath = resolve(profileRoot, 'package.json');
  const manifest = existsSync(manifestPath) ? readSiteJson(manifestPath) : null;
  return {
    profile: deployment.profile,
    home: relativeTo(root, deployment.home),
    project: deployment.config.composeProject ?? null,
    configuredImage: deployment.config.containerImage ?? null,
    pluginSource: null,
    hostImage: deployment.config.hostImage ?? null,
    records: { lock: existsSync(resolve(profileRoot, LOCK)), owner: existsSync(resolve(profileRoot, OWNER)),
      state: existsSync(resolve(profileRoot, STATE)) ? readSiteJson(resolve(profileRoot, STATE)).schemaVersion : null },
    pinnedArchives: manifest ? Object.entries(manifest.dependencies ?? {})
      .filter(([, spec]) => typeof spec === 'string' && spec.startsWith('file:'))
      .map(([name, spec]) => ({ package: name, file: spec.slice(5).split('/').pop(), present: existsSync(resolve(spec.slice(5))) })) : [],
  };
}

/**
 * 现场常同时满足多个条件（记录镜像已删、容器又被替换），因此按序收集全部成立项：
 * 第一项是主判定，其余作为并存观测一并报告。`consistent` 只在没有异常项时成立。
 */
function collectConditions({ saved, candidatePresent, activeImage, activePresent, containers, containersAvailable }) {
  if (!saved) return ['no-record'];
  const conditions = [];
  if (candidatePresent === false) conditions.push('candidate-image-missing');
  if (activeImage && activePresent === false && !conditions.includes('candidate-image-missing')) conditions.push('candidate-image-missing');
  if (!containersAvailable) return [...conditions, 'record-drift'];
  if (!containers.length) return [...conditions, 'container-evidence-missing'];
  // 有容器却没有一个来自记录声明的这一代：现场差异，只报告，不作准入（设计 3 节）。
  if (activeImage && !containers.some(container => container.configImage === activeImage)) conditions.push('container-replaced');
  if (!conditions.length && containers.every(container => container.running)) conditions.push('record-drift');
  return conditions.length ? conditions : ['consistent'];
}

const remedies = {
  'no-record': ['没有可对账的发布记录；按正常流程发布即可，无需对账。'],
  consistent: ['记录与现场一致：无需对账，按正常流程发布即可。'],
  'candidate-image-missing': [
    '记录声明过的镜像已不在本机：这只影响旧记录的诊断和旧容器的重建，不影响新发布——新发布会按本次输入的镜像重新起服务。',
    '若仍要让该记录对应的候选可用，先按记录里的镜像摘要重新提供镜像；否则直接按正常流程重新发布。',
  ],
  'container-evidence-missing': [
    '记录声明的旧容器已不存在：旧记录只作诊断，不要求旧容器或旧镜像回来。',
    '按站点绑定核对当前服务由哪个容器承担、其 home/profile 与持久挂载是否仍是绑定目录；确认后按正常流程发布。',
  ],
  'container-replaced': [
    '现存容器与记录里那一代镜像不同：这是允许的现场差异（记录不参与准入），新发布只核对站点绑定、停写与重叠写入者。',
    '核对现存容器的 home/profile 与持久挂载是否指向本站点绑定目录；不一致时按绑定与迁移文档处理。',
  ],
  'record-drift': [
    '指针、候选、活动 Compose 与容器指向不同代次：逐项核对哪一代对应正在提供服务的容器，其余只作证据保留。',
    '不要靠改写记录或删除状态来“对齐”；按现场事实判断，需要时重新发布一次收敛。',
  ],
};

function buildDifferences(record, conditions) {
  const differences = [];
  if (!record.pointer.present) differences.push('站点发布指针缺失或不合法：无法核对上一次发布的归属；不影响按当前现场发布。');
  if (record.pointer.unfinished) differences.push(`上一次发布未以 ready 结束（状态 ${record.pointer.status}）：只作诊断，普通 build 会从当前现场重新收敛。`);
  if (record.candidate.present === false) differences.push('记录里的候选镜像不在本机：该记录只作诊断，按正常流程重新发布即可。');
  if (record.active.image && record.active.present === false) differences.push('活动 Compose 声明的镜像不在本机：现有容器一旦被重建就没有可用镜像，重新发布前先确认镜像来源。');
  if (record.active.image && !record.active.command) differences.push('活动 Compose 未显式声明启动参数：重建会依赖镜像默认行为；新发布会重新生成 compose。');
  if (conditions.includes('container-replaced')) differences.push('现存容器与记录里那一代镜像不同：允许的现场差异，只需核对站点绑定与写入者。');
  if (conditions.includes('container-evidence-missing')) differences.push('记录声明的旧容器已不存在：旧记录只作诊断，按站点绑定核对当前服务由哪个容器承担。');
  if (record.deployment.records.lock) differences.push('profile 存在安装锁：核实持锁者是否已退出（doctor / unlock），control 锁由取锁、退役与显式解锁共用。');
  if (record.deployment.records.state !== null && record.deployment.records.state !== 3) differences.push(`profile 受管状态是旧 schema ${record.deployment.records.state}：需用 migrate-site 显式迁移后再发布。`);
  for (const archive of record.deployment.pinnedArchives) if (!archive.present) differences.push(`profile 钉住的归档不可达：${archive.package}。`);
  return differences;
}

/** Read-only reconciliation diagnosis: returns a structured report and never writes state. */
export function checkRecords(deployment, execute = (args, options) => spawnSync('docker', args, { windowsHide: true, ...options })) {
  const root = deployment.root;
  const pointerPath = sitePointer(root);
  let pointer = null, pointerError = null;
  try { pointer = existsSync(pointerPath) ? readSiteJson(pointerPath) : null; } catch (error) { pointerError = error.message; }
  const operation = typeof pointer?.operation === 'string' ? pointer.operation : null;
  const saved = operation ? savedFacts(root, operation) : null;
  const candidatePresent = saved?.candidateImage ? probe(execute, ['image', 'inspect', '--format', '{{.Id}}', saved.candidateImage]) !== null : null;
  const activeFile = resolve(root, deployment.artifacts ?? '.local/artifacts', 'active-compose.json');
  const activeCompose = existsSync(activeFile) ? readSiteJson(activeFile) : null;
  const activePath = typeof activeCompose?.path === 'string' ? activeCompose.path : null;
  const activeService = activePath && existsSync(activePath) ? readSiteJson(activePath)?.services?.dsh ?? null : null;
  const activeImage = activeService?.image ?? null;
  const activePresent = activeImage ? probe(execute, ['image', 'inspect', '--format', '{{.Id}}', activeImage]) !== null : null;
  const containers = containerFacts(deployment, execute);
  const record = {
    pointer: { present: pointer !== null, status: pointer?.status ?? null, unfinished: pointer ? UNFINISHED.includes(pointer.status) : false, operation: relativeTo(root, operation ?? ''), error: pointerError },
    saved,
    candidate: { image: saved?.candidateImage ?? null, present: candidatePresent, archiveCount: operation ? archiveCount(operation) : 0,
      manifestPresent: operation ? existsSync(resolve(operation, 'plugins/manifest.json')) : false },
    active: { path: relativeTo(root, activePath ?? ''), image: activeImage, present: activePresent, command: activeService?.command ?? null,
      appliedAt: activeCompose?.appliedAt ?? null },
    containers: containers.containers,
    containersAvailable: containers.available,
    deployment: deploymentEvidence(root, deployment),
  };
  const conditions = collectConditions({ saved, candidatePresent, activeImage, activePresent, containers: containers.containers, containersAvailable: containers.available });
  return {
    classification: conditions[0],
    conditions,
    facts: record,
    differences: buildDifferences(record, conditions),
    plan: conditions.flatMap(condition => remedies[condition]),
    notice: '只读诊断：未写入任何状态、未改动容器与生产数据；旧记录只作诊断，不阻断普通 build，实际收敛由操作者显式执行。',
  };
}

/** CLI entry: same project inputs as check-compose, with the same read-only contract. */
export function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('check-records：只读对比上一次发布记录、活动 Compose、镜像、容器与 profile 证据，报告现场差异与需人工核实项。\n用法：check-records --root <站点目录> --config <env.conf|deployment.json> [--artifacts <目录>] [--compose-project <名称>]\n旧记录只作诊断：失败指针、旧容器与旧镜像都不阻断下一次普通 build。');
    return;
  }
  console.log(JSON.stringify(checkRecords(resolveDeployment(parseArguments(args), {})), null, 2));
}
