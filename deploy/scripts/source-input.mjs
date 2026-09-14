/** Repository-only preparation. The manager owns all site state, application and recovery. */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { buildHostImage, withRegistryAuthentication, validateImageConfig } from '../../integrations/docker/host-image.mjs';
import { prepareManagerTooling } from '../../scripts/manager-tooling.mjs';
import { prepareWorkspaceDependencies } from './bootstrap.mjs';
import { assertSelectiveInstallSafe, preparePluginReuse } from './plugin-reuse.mjs';
import { resolveToolingReuse } from './tooling-reuse.mjs';
import { composeReleases } from '../../packages/plugin-manager/src/compose-release.mjs';
import { loadRelease } from '../../packages/plugin-manager/src/release.mjs';
import { buildMessage, buildStep } from '../../packages/plugin-manager/src/site-output.mjs';
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
      const reuse = context.source.toolingReuse;
      buildMessage(reuse ? '管理器工具：复用活动部署的归档（构建输入未变化）' : `管理器工具：重新构建（${context.source.toolingReason}）`);
      const tools = tooling({ root: context.root, output, execute: context.execute, env: context.env, ...(reuse ? { archive: reuse.archive } : {}) });
      // 归档在核验与安装之间被换掉时，装出来的摘要就对不上；以实际安装内容为准再核一次。
      if (reuse && tools.sha256 !== reuse.sha256) throw new Error('复用的管理器归档与核验摘要不一致；请重试发布。');
      return tools;
    },
    inspect(context) {
      const { root, capture, site, runtime, rebuildPlugins, previous, active } = context;
      const git = args => capture('git', args), host = resolve(root, 'deepseek-harness');
      if (git(['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all'])) throw new Error('Commit source changes before release; the checkout must be clean.');
      const revision = git(['rev-parse', 'HEAD']);
      const hostCommit = existsSync(resolve(host, '.git')) ? git(['-C', host, 'rev-parse', 'HEAD']) : undefined;
      const buildEnvironment = { nodeVersion: process.versions.node, platform: process.platform, architecture: process.arch,
        packageManager: readSiteJson(resolve(root, 'package.json')).packageManager, targetArchitecture: runtime.architecture, hostImage: site.hostImage ?? null };
      // `--rebuild-plugins auto` 把重建集交给判定自己算：拿不到可靠基线时它退回整套重建，
      // 所以打包选集一律以判定交回的集合为准，而不是运维写下的那一串。
      const auto = rebuildPlugins === 'auto';
      const requested = rebuildPlugins === undefined || auto ? site.plugins : rebuildPlugins.split(',');
      if (rebuildPlugins !== undefined) assertSelectiveInstallSafe(root);
      const selection = rebuildPlugins === undefined ? null : preparePluginReuse({ root, previous, active, site, revision, hostCommit, buildEnvironment, ...(auto ? { auto: true } : { rebuilt: requested }), git });
      const rebuilt = selection?.rebuilt ?? requested;
      if (selection?.reuseUnavailable) buildMessage(`按需复用不可用（${selection.reuseUnavailable}），本次重建全部插件`);
      const tooling_ = resolveToolingReuse({ root, git, revision, previous, active });
      context.source = { git, host, rebuilt, reuse: selection?.release.plugins.length ? selection : null, toolingReuse: tooling_.reuse, toolingReason: tooling_.reason };
      return { revision, hostCommit, hostSourceCommit: hostCommit, hostSourceClean: Boolean(hostCommit) && git(['-C', host, 'status', '--porcelain', '--untracked-files=normal']) === '', buildEnvironment,
        managerInputs: tooling_.inputs,
        ...(context.source.reuse ? { rebuilt, reused: context.source.reuse.builtFrom.map(p => p.id), reuseSource: context.source.reuse.sourceRecord } : {}) };
    },
    prepare(context) {
      const { root, site, operation, record, env, execute, run, step, capture, probe, inspect, previous, sourceInput, skipPluginCheck } = context;
      const { git, host, rebuilt, reuse } = context.source;
      if (sourceInput) validateImageConfig(sourceInput.image);
      prepareWorkspaceDependencies(root, env, execute);
      const tools = buildStep('准备管理器工具', () => this.prepareTools(context));
      Object.assign(record, { managerArchive: tools.archive, managerHash: tools.sha256, toolRoot: tools.toolRoot });
      // 插件检查是开发期门禁：CI 已对同一提交跑过，部署时再对每个插件重复一次 pnpm typecheck
      // 只是把发布拖长（实测 5 个插件约 56 秒）。跳过它不改变产物，只改变谁来担这道校验。
      run(process.execPath, ['scripts/package-plugins.mjs', '--plugins', rebuilt.join(',') || 'none', '--output', resolve(operation, 'fresh'), ...(skipPluginCheck ? ['--skip-plugin-check'] : [])]);
      const fresh = buildStep('加载并核验发布清单', () => loadRelease(resolve(operation, 'fresh/manifest.json')));
      if (fresh.plugins.length !== rebuilt.length || fresh.plugins.some(p => !rebuilt.includes(p.id))) throw new Error('Built plugin archives differ from the requested selection.');
      const old = previous?.manifest ? buildStep('加载并核验发布清单', () => loadRelease(resolve(root, previous.manifest))) : undefined;
      const manifest = resolve(operation, 'plugins/manifest.json');
      buildStep('组装发布清单与归档', () => composeReleases(reuse ? [reuse.release, fresh] : [fresh], dirname(manifest), old));
      record.pluginBuilds = readSiteJson(manifest).plugins.map(plugin => reuse?.builtFrom.find(p => p.id === plugin.id) ?? { id: plugin.id, sha256: plugin.sha256, builtFromRevision: record.revision });
      let baseReference = site.hostImage ?? previous?.containerImage, base;
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
      if (reuse && ((!site.hostImage && !record.hostSourceClean) || record.hostCommit !== reuse.hostCommit)) throw new Error('Host source or image changed during selective build; service has not been stopped.');
      return { manifest, image: reference, manager, ...tools };
    },
  };
}
