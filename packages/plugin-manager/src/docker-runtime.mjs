import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, posix } from 'node:path';
import { canonical } from './state.mjs';

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

/** Prove every old backup source against stopped containers, before creating a backup. */
export function assertStoppedCompose(compose, containerIds, image, execute, runtime) {
  const service = compose?.services?.dsh;
  if (!service || !Array.isArray(service.volumes) || !Array.isArray(containerIds) || !containerIds.length || new Set(containerIds).size !== containerIds.length || containerIds.some(id => !/^[a-f0-9]{12,64}$/u.test(id))) throw new Error('缺少可核验的旧容器身份，拒绝备份。');
  const inspect = () => {
    const containers = JSON.parse(String(execute(['inspect', ...containerIds], { encoding: 'utf8' })));
    if (!Array.isArray(containers) || containers.length !== containerIds.length || containerIds.some(id => containers.filter(container => container.Id?.startsWith(id)).length !== 1)) throw new Error('旧容器身份不完整，拒绝备份。');
    for (const container of containers) {
      if (container.State?.Running !== false || container.State?.Restarting !== false || container.Config?.Image !== service.image || container.Config?.Labels?.['com.docker.compose.service'] !== 'dsh') throw new Error('旧容器未完全停止或镜像/服务身份不匹配，拒绝备份。');
      for (const key of ['DSH_HOME', 'DSH_PROFILE']) if (!service.environment?.[key] || !container.Config.Env?.includes(`${key}=${service.environment[key]}`)) throw new Error('旧容器 home/profile 不匹配，拒绝备份。');
    }
    return containers;
  };
  const containers = inspect();
  const volumes = service.volumes.filter(volume => !volume.read_only || volume.target?.startsWith('/run/'));
  if (!volumes.length) throw new Error('旧容器没有持久挂载，拒绝备份。');
  for (const container of containers) for (const volume of volumes) {
    const mount = container.Mounts?.find(item => item.Type === 'bind' && item.Destination === volume.target);
    if (volume.type !== 'bind' || typeof volume.source !== 'string' || !mount || mount.RW !== !Boolean(volume.read_only)) throw new Error('旧容器持久挂载声明不匹配，拒绝备份。');
    const source = canonical(volume.source);
    if (runtime.desktop ? !proveMountedSource(source, volume.target, container, image, execute) : canonical(mount.Source) !== source) throw new Error('旧容器持久挂载来源不匹配，拒绝备份。');
  }
  inspect();
}
