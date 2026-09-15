import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { canonical, within } from './state.mjs';

export const executeDocker = (args, options = {}) => execFileSync('docker', args, { windowsHide: true, ...options });

/** Resolve one local Linux engine before any site mutation; callers retain its endpoint. */
export function inspectDocker(execute = executeDocker) {
  const capture = args => String(execute(args, { encoding: 'utf8' })).trim();
  const endpoint = process.env.DOCKER_HOST || JSON.parse(capture(['context', 'inspect', ...(process.env.DOCKER_CONTEXT ? [process.env.DOCKER_CONTEXT] : []), '--format', '{{json .Endpoints.docker.Host}}']));
  if (typeof endpoint !== 'string' || !/^(?:unix:\/\/\/[^\0\r\n]+|npipe:\/\/\/\/\.\/pipe\/[^\0\r\n]+)$/u.test(endpoint)) throw new Error('构建部署仅支持本机 Docker unix/npipe endpoint，不能使用远端 Docker。');
  const info = JSON.parse(capture(['--host', endpoint, 'info', '--format', '{{json .}}']));
  if (info.OSType !== 'linux' || typeof info.ID !== 'string' || !info.ID) throw new Error('构建部署需要可识别的本机 Linux Docker 引擎。');
  const architecture = ({ x86_64: 'amd64', aarch64: 'arm64', amd64: 'amd64', arm64: 'arm64' })[info.Architecture];
  if (!architecture) throw new Error('Docker 引擎架构必须是 amd64 或 arm64。');
  capture(['--host', endpoint, 'compose', 'version']);
  // Native Windows/macOS clients need VM-compatible networking and mount proofs, regardless of vendor.
  const desktop = ['win32', 'darwin'].includes(process.platform) || /docker desktop/i.test(info.OperatingSystem ?? '') || (info.Labels ?? []).some(value => value.startsWith('com.docker.desktop.'));
  return { endpoint, id: info.ID, desktop, architecture };
}

export function ensureDockerIdentity(expected, actual) {
  if (expected && ['endpoint', 'id', 'desktop', 'architecture'].some(key => expected[key] !== actual[key])) throw new Error('Docker 引擎或 endpoint 已改变，保留原部署现场，不得继续恢复。');
}

export const dockerArguments = (runtime, args) => ['--host', runtime.endpoint, ...args];

/** Probe the final mount view as the configured container user without starting DSH. */
export function checkDockerMounts(service, execute) {
  const checks = service.volumes.map(mount => ({ path: mount.target, directory: statSync(mount.source).isDirectory(), writable: !mount.read_only }));
  for (const key of ['PLUGIN_MANIFEST_FILE', 'DEPLOYMENT_CONFIG']) if (service.environment?.[key]) checks.push({ path: service.environment[key], directory: false, writable: false });
  const script = `const fs=require('node:fs'),path=require('node:path');for(const item of JSON.parse(process.argv[1])){if(item.directory){fs.accessSync(item.path,fs.constants.R_OK|fs.constants.X_OK);fs.readdirSync(item.path);if(item.writable){const p=path.join(item.path,'.dsh-access-'+require('node:crypto').randomUUID());try{fs.writeFileSync(p,'probe',{flag:'wx'});}finally{fs.rmSync(p,{force:true});}}}else{const fd=fs.openSync(item.path,item.writable?'r+':'r');fs.closeSync(fd);}}`;
  const args = ['run', '--rm', '--pull', 'never', '--network', 'none', '--user', service.user, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true'];
  for (const mount of service.volumes) {
    if ([mount.source, mount.target].some(value => /[,\r\n]/u.test(value))) throw new Error('Docker 挂载路径不能包含逗号或换行。');
    args.push('--mount', `type=bind,source=${mount.source},target=${mount.target}${mount.read_only ? ',readonly' : ''}`);
  }
  execute([...args, '--entrypoint', 'node', service.image, '-e', script, JSON.stringify(checks)], { stdio: 'pipe' });
}

const hashFileScript = `const fs=require('node:fs'),hash=require('node:crypto').createHash('sha256'),fd=fs.openSync(process.argv[1],'r'),buffer=Buffer.alloc(1048576);try{for(let n;(n=fs.readSync(fd,buffer,0,buffer.length,null));)hash.update(buffer.subarray(0,n));}finally{fs.closeSync(fd);}process.stdout.write(hash.digest('hex'));`;

function hashFile(path) {
  const hash = createHash('sha256'), fd = openSync(path, 'r'), buffer = Buffer.alloc(1048576);
  try { for (let n; (n = readSync(fd, buffer, 0, buffer.length, null));) hash.update(buffer.subarray(0, n)); }
  finally { closeSync(fd); }
  return hash.digest('hex');
}

/**
 * 同一目录的候选路径空间（设计 3 节、5.1）。
 *
 * Docker Desktop 上 `docker inspect` 的 `Mounts[].Source` 可能给主机写法（`C:\data`），也可能给
 * VM 写法（`/run/desktop/mnt/host/c/data`）。用主机写法去比较 VM 写法会得出「不属于本站点」或
 * 「没有重叠写入者」两种相反的错误结论，所以比较必须发生在**同一个路径空间**里。
 */
export function locationForms(path) {
  const text = String(path ?? '');
  if (/^\/run\/desktop\/mnt\/host\//u.test(text)) return [{ space: 'vm', path: text.replace(/\/+$/u, '') }];
  const host = canonical(text);
  const forms = [{ space: 'host', path: host }];
  const drive = /^([a-zA-Z]):[\\/](.*)$/u.exec(host);
  if (drive) forms.push({ space: 'vm', path: `/run/desktop/mnt/host/${drive[1].toLowerCase()}/${drive[2].replace(/\\/gu, '/')}`.replace(/\/+$/u, '') });
  return forms;
}

/** `inner` 与 `outer` 相同，或位于 `outer` 之内；只在同一路径空间内比较。 */
export function sameOrWithinLocation(outer, inner) {
  for (const a of locationForms(outer)) for (const b of locationForms(inner)) {
    if (a.space !== b.space) continue;
    if (a.space === 'host') { if (b.path === a.path || within(a.path, b.path)) return true; }
    else if (b.path === a.path || b.path.startsWith(`${a.path}/`)) return true;
  }
  return false;
}

function proveMountedSource(source, target, container, image, execute) {
  const probe = (script, path) => String(execute(['run', '--rm', '--pull', 'never', '--network', 'none', '--volumes-from', `${container.Id}:ro`, '--entrypoint', 'node', image, '-e', script, path], { encoding: 'utf8' }));
  if (statSync(source).isFile()) {
    const hash = hashFile(source);
    return probe(hashFileScript, target) === hash && hashFile(source) === hash;
  }
  if (!statSync(source).isDirectory()) return false;
  const filename = `.dsh-mount-${randomUUID()}`, challenge = randomUUID(), path = join(source, filename);
  writeFileSync(path, challenge, { flag: 'wx', mode: 0o644 });
  try {
    return probe('process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))', posix.join(target, filename)) === challenge;
  } finally { rmSync(path, { force: true }); }
}

/** Prove the stopped container's original mounts reach this exact host home. */
export function proveDockerHome(deployment, container, image, execute) {
  if (container.State?.Running !== false || container.State?.Restarting !== false || !/^[a-f0-9]{12,64}$/u.test(container.Id ?? '')) return false;
  const home = (container.Config?.Env ?? []).find(value => value.startsWith('DSH_HOME='))?.slice(9);
  if (!home || !posix.isAbsolute(home)) return false;
  return proveMountedSource(deployment.home, home, container, image, execute);
}

/**
 * 按 Compose 项目实时查询当前容器：停止目标与挂载证明的唯一来源（设计 3、5.3）。
 * 不读旧记录、旧镜像或容器代次；返回的项目容器包含已停与运行中的全部实例。
 */
export function composeContainers(execute, runtime, composeProject) {
  const run = args => String(execute(args, { encoding: 'utf8' })).trim();
  const ids = value => value.split(/\s+/).filter(id => /^[a-f0-9]{12,64}$/u.test(id));
  const filter = `label=com.docker.compose.project=${composeProject}`;
  return { running: ids(run(['ps', '-q', '--filter', filter])), all: ids(run(['ps', '-a', '-q', '--filter', filter])) };
}

/**
 * 当前服务的停止与挂载证明（设计 3、5.1、5.3）。
 *
 * 零容器是合法已停现场：没有容器时不需要（也无法）证明挂载，直接通过——不要求旧容器存在，
 * 也不比较镜像或容器代次。有容器时只核验当前安全事实：已停、服务身份是 dsh、profile 与 home
 * 通过**实际挂载映射**对应本次绑定，且可写持久挂载都落在绑定的持久目录内。
 *
 * `image` 是本次部署已经核验过的运行镜像：Desktop 的路径证明要起一个一次性容器，只能用本次镜像，
 * 不能再用旧容器的 `Config.Image`（旧标签可能已被删除，那会把证明变成对旧代次的准入依赖）。
 */
export function assertStoppedBinding(containerIds, binding, execute, runtime, image) {
  if (!containerIds.length) return [];
  const containers = JSON.parse(String(execute(['inspect', ...containerIds], { encoding: 'utf8' })));
  if (!Array.isArray(containers) || containers.length !== containerIds.length
    || containerIds.some(id => containers.filter(container => container.Id?.startsWith(id)).length !== 1)) throw new Error('当前容器身份不完整，拒绝部署。');
  const directories = [binding.dataRoot, binding.home, binding.workspace, binding.artifacts].map(canonical);
  const home = canonical(binding.home);
  if (runtime.desktop && typeof image !== 'string') throw new Error('Desktop 挂载证明需要本次已核验的运行镜像；不再使用旧容器的镜像。');
  for (const container of containers) {
    if (container.State?.Running !== false || container.State?.Restarting !== false) throw new Error('当前服务未完全停止，拒绝部署。');
    if (container.Config?.Labels?.['com.docker.compose.service'] !== 'dsh') throw new Error('当前容器不是本站点的 dsh 服务，拒绝部署。');
    const variables = Object.fromEntries((container.Config?.Env ?? []).map(value => { const index = value.indexOf('='); return [value.slice(0, index), value.slice(index + 1)]; }));
    const containerHome = variables.DSH_HOME;
    if (!containerHome || variables.DSH_PROFILE !== binding.profile) throw new Error('当前容器 profile 与站点绑定不一致，拒绝部署。');
    const mount = (container.Mounts ?? []).filter(item => item.Type === 'bind' && (containerHome === item.Destination || containerHome.startsWith(`${item.Destination}/`)))
      .sort((a, b) => b.Destination.length - a.Destination.length)[0];
    if (!mount || typeof mount.Source !== 'string') throw new Error('当前容器没有对应 home 的持久挂载，拒绝部署。');
    // Desktop 的路径同一性用探针证明；本机 Linux 直接按挂载映射把容器内 home 换算回主机路径。
    const same = runtime.desktop
      ? proveMountedSource(home, containerHome, container, image, execute)
      : canonical(resolve(mount.Source, posix.relative(mount.Destination, containerHome))) === home;
    if (!same) throw new Error('当前容器挂载的数据目录与站点绑定不一致，拒绝部署。');
    for (const item of container.Mounts ?? []) {
      if (item.Type !== 'bind' || !item.RW || String(item.Destination ?? '').startsWith('/run/')) continue;
      // 路径空间可能不同（Desktop 的 VM 写法），比较前先归一；否则会误判为「不属于站点绑定」。
      if (!directories.some(directory => sameOrWithinLocation(directory, item.Source ?? ''))) throw new Error(`当前容器的可写挂载不属于站点绑定：${item.Source}；拒绝部署。`);
    }
  }
  return containers;
}

/**
 * 本机引擎上还有谁在写同一批持久目录（设计 5.1、6.2）。
 *
 * 查询只覆盖本项目是不够的：零容器只是「本项目没有容器」，不代表没有别的容器（旧副本、手工起的
 * 实例、另一个 Compose 项目）正在写同一份数据。这里按**运行中**容器逐个核对可写绑定挂载与站点
 * 四个持久目录是否重叠，任一重叠就拒绝部署。已停止的容器不算写入者。
 */
export function assertNoOverlappingWriters(binding, execute, runtime) {
  const running = String(execute(['ps', '-q'], { encoding: 'utf8' })).trim().split(/\s+/).filter(id => /^[a-f0-9]{12,64}$/u.test(id));
  if (!running.length) return [];
  const containers = JSON.parse(String(execute(['inspect', ...running], { encoding: 'utf8' })));
  const directories = [binding.dataRoot, binding.home, binding.workspace, binding.artifacts];
  for (const container of containers) {
    if (container.State?.Running === false) continue;
    for (const item of container.Mounts ?? []) {
      if (item.Type !== 'bind' || !item.RW) continue;
      // 双向重叠都算写入者；比较在同一路径空间内进行（Desktop 会给 VM 写法）。
      if (directories.some(directory => sameOrWithinLocation(directory, item.Source ?? '') || sameOrWithinLocation(item.Source ?? '', directory))) {
        throw new Error(`容器 ${String(container.Id ?? '').slice(0, 12)} 正在写入站点持久目录：${item.Source}；先停止该写入者再部署。`);
      }
    }
  }
  return containers;
}
