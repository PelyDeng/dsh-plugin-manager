/**
 * 复用上一次成功发布的管理器工具归档。
 *
 * 管理器归档只由 `managerToolInputs` 里的已跟踪文件决定（见 `scripts/manager-tooling.mjs`），
 * 而构建它实测要 18.6 秒：pnpm 装上管理器闭包、构建 kit 与 manager、再打包。输入没变时这份
 * 归档与重新构建的产物内容相同，所以按摘要复用可以直接省掉这段等待。
 *
 * 基线取**当前活动部署**的记录，与插件复用同一口径：`source-release.json` 指向的是最近一次
 * 操作，可能正是失败的那一次，不能当作成功基线。
 *
 * 复用必须可核验，缺一不可：
 *
 * 1. 活动部署的发布记录状态为 ready，且写明输入哈希与归档摘要；
 * 2. 当前提交的 `managerToolInputs` 哈希与记录一致；
 * 3. 记录里的归档仍在磁盘上，且 sha256 与记录一致（内容寻址，不信任路径）。
 *
 * 任何一条不成立都返回 `null`，调用方照常全量构建；判定失败不是错误，只是没有可复用的基线。
 * 这里不复用工具树本身（只复用归档再安装一次）：这样新操作的 `toolRoot` 仍在自己目录内，
 * 不依赖旧操作目录继续存在。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { managerToolInputsHash } from '../../scripts/manager-tooling.mjs';
import { readSiteRecord } from '../../packages/plugin-manager/src/site-record.mjs';
import { within } from '../../packages/plugin-manager/src/state.mjs';

const reason = message => ({ reuse: null, reason: message });
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');

/** 判定能否复用活动部署的管理器归档；返回 `{ inputs, reuse, reason }`，`inputs` 始终是当前提交的哈希。 */
export function resolveToolingReuse({ root, git, revision, previous, active }) {
  const inputs = managerToolInputsHash(git, revision);
  const decide = message => ({ inputs, reuse: null, reason: message });
  if (!previous?.manifest || !active?.path) return decide('没有当前活动部署');
  const manifest = resolve(root, previous.manifest), operation = dirname(dirname(manifest));
  const artifacts = resolve(root, '.local/artifacts');
  if (!within(artifacts, operation) || operation === artifacts) return decide('活动发布路径越界');
  let record;
  try { record = readSiteRecord(root, operation, { status: 'ready' }); }
  catch (error) { return decide(`活动发布记录不可用（${error.message}）`); }
  const { managerArchive, managerHash, managerInputs } = record;
  if (typeof managerHash !== 'string' || !/^[a-f0-9]{64}$/u.test(managerHash) || typeof managerArchive !== 'string') return decide('活动发布记录缺少管理器归档身份');
  // 这条记录早于「输入哈希」这个字段时也走重新构建，并如实说明原因。
  if (typeof managerInputs !== 'string' || !/^[a-f0-9]{64}$/u.test(managerInputs)) return decide('活动发布记录没有记下管理器输入哈希');
  if (managerInputs !== inputs) return decide('管理器构建输入已变化');
  if (!existsSync(managerArchive) || !statSync(managerArchive).isFile()) return decide('活动部署的管理器归档已不存在');
  if (digest(managerArchive) !== managerHash) return decide('活动部署的管理器归档与记录摘要不一致');
  return { inputs, reuse: { archive: resolve(managerArchive), sha256: managerHash }, reason: '管理器构建输入未变化，复用活动部署的归档' };
}
