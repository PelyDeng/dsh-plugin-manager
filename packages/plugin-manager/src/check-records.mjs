/**
 * 只读的发布记录对账诊断。
 *
 * 发布失败后现场常被人工干预（换镜像、重建容器、留旧记录），高层 `--resume`/`--recover`
 * 会按契约拒绝继续，而拒绝原因分散在指针、失败候选、活动 Compose、容器与 profile 里。
 * 本模块只读这些来源，判定属于哪一类漂移并给出对账计划；**不写任何状态、不动容器、
 * 不改生产数据**——真正的收敛必须由操作者看过计划后显式执行。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArguments, resolveDeployment } from './config.mjs';
import { readSiteJson, sitePointer } from './site-record.mjs';
import { LOCK, OWNER, PENDING, STATE } from './state.mjs';

export const conditions = ['no-record', 'consistent', 'candidate-image-missing', 'container-evidence-missing', 'container-replaced', 'record-drift'];

const UNFINISHED = ['prepared', 'backing-up', 'applying', 'deployment-failed'];
const short = value => typeof value === 'string' && value.length > 12 ? value.slice(0, 12) : value ?? null;

function probe(execute, args) {
  try {
    const result = execute(args, { encoding: 'utf8' });
    if (!result || result.status !== 0 || result.error) return null;
    return String(result.stdout ?? '');
  } catch { return null; }
}

/** Keep reports comparable across environments: project-relative paths only. */
function relativeTo(root, path) {
  if (typeof path !== 'string' || !path) return null;
  const value = relative(resolve(root), resolve(path)).split(sep).join('/');
  return value.startsWith('..') ? null : value;
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
    stopComplete: record.stopComplete ?? null,
    candidateImage: candidate?.containerImage ?? null,
    activeImage: record.previousRuntime?.containerImage ?? record.previousRuntime?.image ?? null,
    activeManifest: relativeTo(root, record.previousRuntime?.manifest ?? ''),
    activeSiteOperation: short(record.previousRuntime?.siteOperation),
    selectedPlugins: Array.isArray(record.selectedPlugins) ? record.selectedPlugins.map(item => item.id) : null,
    enabledPlugins: Array.isArray(record.enabledPlugins) ? record.enabledPlugins : null,
    previousStateHash: short(record.previousStateHash),
  };
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
    pluginSource: deployment.config.pluginSource ?? null,
    hostImage: deployment.config.hostImage ?? null,
    records: { lock: existsSync(resolve(profileRoot, LOCK)), owner: existsSync(resolve(profileRoot, OWNER)),
      state: existsSync(resolve(profileRoot, STATE)), pending: existsSync(resolve(profileRoot, PENDING)) },
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
  if (!containers.length) return [...conditions, saved.stopComplete ? 'record-drift' : 'container-evidence-missing'];
  // 有容器却没有一个属于记录声明的这一代：镜像身份比对必然失败，属"现有容器被替换"。
  if (activeImage && !containers.some(container => container.configImage === activeImage)) conditions.push('container-replaced');
  if (!conditions.length && containers.every(container => container.running)) conditions.push('record-drift');
  return conditions.length ? conditions : ['consistent'];
}

const remedies = {
  'no-record': ['没有可对账的发布记录；按正常流程发布即可，无需对账。'],
  consistent: ['记录与现场一致：无需对账，按正常流程发布或续跑。'],
  'candidate-image-missing': [
    '失败候选或活动记录声明的镜像已不在本机：不能续跑，也不能靠删锁或改指针恢复。',
    '从可核验来源重新提供同一摘要的镜像，或显式开始一次新发布以生成新候选。',
    '新候选若依赖镜像默认启动行为，应在恢复产物中显式写出必要参数，不依赖隐式回退。',
  ],
  'container-evidence-missing': [
    '记录声明的旧容器已不存在，恢复所需的服务身份证据缺失。',
    '确认该服务当前由哪个容器承担，并核对该容器的镜像与服务标签。',
    '由操作者在显式对账事务中确认接受新容器身份；旧记录保持不可变，以继承关系表达新状态。',
  ],
  'container-replaced': [
    '现存容器与记录中的旧容器不是同一代，镜像身份比对必然失败——这是当前版本有意保留的保护。',
    '不要用弱化镜像校验的开关绕过归属证明；改为执行显式对账事务。',
    '对账前先核对容器的 home、profile、挂载与受管状态是否仍指向同一份持久数据。',
  ],
  'record-drift': [
    '指针、失败候选、活动 Compose 与容器记录指向不同代次，需要逐项核对后再收敛。',
    '先确认哪一代对应正在提供服务的容器；其余各代只作证据保留，不改写。',
  ],
};

function buildBlockers(record, conditions) {
  const blockers = [];
  if (!record.pointer.present) blockers.push('站点发布指针缺失或不合法，无法核对操作归属。');
  if (record.pointer.needsResume) blockers.push(`站点记录停在 ${record.pointer.status}：正常发布会先被未完成操作拦下。`);
  if (record.candidate.present === false) blockers.push('失败候选镜像不存在，无法按原候选续跑。');
  if (record.active.image && record.active.present === false) blockers.push('活动 Compose 声明的镜像不存在：容器一旦重建就没有可用镜像。');
  if (record.active.image && !record.active.command) blockers.push('活动 Compose 未显式声明启动参数：启动依赖镜像默认行为，恢复产物应写明必要参数。');
  if (conditions.includes('container-replaced')) blockers.push('现存容器与记录中的旧容器不是同一代，镜像身份比对必然失败。');
  if (record.deployment.records.lock) blockers.push('profile 存在安装锁：先按恢复文档核实锁主再继续。');
  if (record.deployment.records.pending) blockers.push('profile 存在未完成安装操作，恢复入口会要求原清单与配置。');
  for (const archive of record.deployment.pinnedArchives) if (!archive.present) blockers.push(`profile 钉住的归档不可达：${archive.package}。`);
  return blockers;
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
    pointer: { present: pointer !== null, status: pointer?.status ?? null, needsResume: pointer ? UNFINISHED.includes(pointer.status) : false, operation: relativeTo(root, operation ?? ''), error: pointerError },
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
    blockers: buildBlockers(record, conditions),
    plan: conditions.flatMap(condition => remedies[condition]),
    notice: '只读诊断：未写入任何状态、未改动容器与生产数据；实际收敛必须由操作者显式执行。',
  };
}

/** CLI entry: same project inputs as check-compose, with the same read-only contract. */
export function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('check-records：只读核对发布记录、活动 Compose、镜像与容器，判定漂移类别并给出对账计划。\n用法：check-records --root <站点目录> --config <env.conf|deployment.json> [--artifacts <目录>] [--compose-project <名称>]');
    return;
  }
  console.log(JSON.stringify(checkRecords(resolveDeployment(parseArguments(args), {})), null, 2));
}
