/** Repository-only preparation. The manager owns all site state, application and recovery. */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildHostImage, withRegistryAuthentication, validateImageConfig } from '../../integrations/docker/host-image.mjs';
import { prepareManagerTooling } from '../../scripts/manager-tooling.mjs';
import { buildMessage } from '../../packages/plugin-manager/src/site-output.mjs';
import { fileHash, readSiteJson } from '../../packages/plugin-manager/src/site-record.mjs';
import { formatLayerReport, layerReport } from './layer-count.mjs';

export function validateBase(reference, info) {
  if (typeof reference !== 'string' || !/^(?:sha256:[a-f0-9]{64}|\S+@sha256:[a-f0-9]{64})$/.test(reference)) throw new Error('Host image must be an immutable image ID or registry digest.');
  if (info.Os !== 'linux') throw new Error('Source deployment requires a Linux host image.');
  return info.Id;
}

export function sourceAdapter({ buildHost = buildHostImage, tooling = prepareManagerTooling } = {}) {
  return {
    prepareTools(context) {
      const output = resolve(context.operation, 'tooling');
      buildMessage('管理器工具：按本次输入重新构建');
      return tooling({ root: context.root, output, execute: context.execute, env: context.env });
    },
    inspect(context) {
      const { root, capture, site, runtime, previous, active } = context;
      const git = args => capture('git', args), host = resolve(root, 'deepseek-harness');
      if (git(['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all'])) throw new Error('Commit source changes before release; the checkout must be clean.');
      const revision = git(['rev-parse', 'HEAD']);
      const hostCommit = existsSync(resolve(host, '.git')) ? git(['-C', host, 'rev-parse', 'HEAD']) : undefined;
      const buildEnvironment = { nodeVersion: process.versions.node, platform: process.platform, architecture: process.arch,
        packageManager: readSiteJson(resolve(root, 'package.json')).packageManager, targetArchitecture: runtime.architecture, hostImage: site.hostImage ?? null };
      // 内置构建固定全量：系统只构建 builtin，外部产物来自 incoming，不再按旧成功记录复用源码产物。
      // 管理器工具每次按本次输入重新构建，不复用旧 ready 的归档。
      context.source = { git, host };
      return { revision, hostCommit, hostSourceCommit: hostCommit, hostSourceClean: Boolean(hostCommit) && git(['-C', host, 'status', '--porcelain', '--untracked-files=normal']) === '', buildEnvironment };
    },
    /**
     * 源码检出特有的运行镜像准备（过渡能力）：设计 2.8 要求完整运行镜像由框架发行流程完成，
     * 因此正常发行包用 `framework-runtime.json` 指向的镜像；只有源码检出还没有发行镜像时，
     * 才按本机官方源码构建一次——不以上一次的运行镜像为基底叠加（设计 3 节）。
     */
    prepareImage(context, tools) {
      const { root, site, operation, record, run, step, capture, probe, inspect, sourceInput } = context;
      const { git, host } = context.source;
      if (sourceInput) validateImageConfig(sourceInput.image);
      let baseReference = site.hostImage, base;
      if (baseReference) {
        if (!/^(?:sha256:[a-f0-9]{64}|\S+@sha256:[a-f0-9]{64})$/.test(baseReference)) throw new Error('Host image must be immutable.');
        if (probe('docker', ['image', 'inspect', baseReference]) === null) {
          if (baseReference.startsWith('sha256:')) baseReference = null;
          else step('拉取宿主镜像', 'docker', ['pull', baseReference]);
        }
        if (baseReference) {
          base = inspect(baseReference);
          if (!site.hostImage && record.hostSourceCommit && base.Config?.Labels?.['org.opencontainers.image.revision'] !== record.hostSourceCommit) baseReference = null;
        }
      }
      if (!baseReference) {
        if (!existsSync(resolve(host, '.git'))) throw new Error('The checkout is incomplete: supply deepseek-harness source before deployment. build.sh does not download official source.');
        const built = buildHost({ root, ...(sourceInput ? { configValues: sourceInput.image } : site.hostImageConfig ? { config: site.hostImageConfig } : {}) });
        baseReference = built.imageId; base = inspect(baseReference); record.hostBuild = built.resultFile;
      }
      validateBase(baseReference, base);
      // 层数只报数不改行为：阈值要按本机实际驱动与层预算校准，先拿到真实数字。
      const engineInfo = probe('docker', ['version', '--format', '{{.Server.Version}}'])?.stdout?.trim() ?? null;
      const driver = probe('docker', ['info', '--format', '{{.Driver}}'])?.stdout?.trim() ?? null;
      const baseTag = `dsh-local/source-base:${base.Id.slice(7)}`;
      run('docker', ['tag', base.Id, baseTag]);
      const imageContext = resolve(operation, 'image'); mkdirSync(imageContext);
      copyFileSync(tools.archive, resolve(imageContext, 'plugin-manager.tgz'));
      copyFileSync(resolve(root, 'integrations/docker/manager-update.Dockerfile'), resolve(imageContext, 'Dockerfile'));
      const image = `dsh-local/source:${record.revision.slice(0, 12)}-${tools.sha256.slice(0, 12)}`;
      step('构建部署镜像', 'docker', ['build', '--network', 'none', '--build-arg', `RUNTIME_IMAGE=${baseTag}`, '--build-arg', `MANAGER_SHA256=${tools.sha256}`, '--build-arg', `FRAMEWORK_REVISION=${record.revision}`, '--tag', image, imageContext]);
      if (inspect(baseTag).Id !== base.Id) throw new Error('The base image changed during construction.');
      const info = inspect(image); validateBase(info.Id, info);
      const baseCount = layerReport(base, { driver, engine: engineInfo }).layers;
      const imageCount = layerReport(info, { driver, engine: engineInfo, base: baseCount }).layers;
      record.layers = { base: baseCount, image: imageCount, added: baseCount === null || imageCount === null ? null : imageCount - baseCount, driver, engine: engineInfo };
      buildMessage(`镜像层数：${formatLayerReport({ base: { layers: baseCount }, image: { layers: imageCount, added: record.layers.added }, driver, engine: engineInfo })}`);
      if (info.Config?.Labels?.['com.dsh-plugin-manager.manager.sha256'] !== tools.sha256) throw new Error('Built manager archive differs from saved tooling.');
      record.hostCommit = info.Config?.Labels?.['org.opencontainers.image.revision'];
      const manager = readSiteJson(resolve(root, 'packages/plugin-manager/package.json')).version;
      if (capture('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'node', info.Id, '-p', 'require("/opt/plugin-manager/node_modules/@dsh-plugin-manager/plugin-manager/package.json").version']) !== manager) throw new Error('Built manager version differs from source.');
      let reference = info.Id;
      if (site.publishImage) {
        const tag = `${site.publishImage}:source-${record.revision.slice(0, 12)}-${tools.sha256.slice(0, 12)}`;
        run('docker', ['tag', info.Id, tag]);
        const publish = flags => step('推送部署镜像', 'docker', [...flags, 'push', tag]);
        if (sourceInput) withRegistryAuthentication(sourceInput.image, site.publishImage, publish, (bin, args, settings) => ({ status: 0, stdout: run(bin, args, { stdio: 'pipe', ...settings }) }));
        else publish([]);
        reference = inspect(tag).RepoDigests?.find(value => value.startsWith(`${site.publishImage}@sha256:`));
        if (!reference) throw new Error('The published image has no matching digest.');
      }
      if (git(['rev-parse', 'HEAD']) !== record.revision || git(['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all']) || fileHash(context.sitePath) !== record.siteHash) throw new Error('Source or site preferences changed during the build; service has not been stopped.');
      const unchanged = Boolean(record.hostSourceCommit) && git(['-C', host, 'rev-parse', 'HEAD']) === record.hostSourceCommit && git(['-C', host, 'status', '--porcelain', '--untracked-files=normal']) === '';
      record.hostSourceClean = record.hostSourceClean && unchanged;
      // 只回传运行镜像引用：工具、内置构建、候选合并与验证都在唯一的部署准备里完成。
      return reference;
    },
  };
}
