/**
 * 复用上一次成功发布的管理器工具归档。
 *
 * 管理器归档只由 `managerToolInputs` 里的已跟踪文件决定（见 `scripts/manager-tooling.mjs`），
 * 而构建它实测要 18.6 秒：pnpm 装上管理器闭包、构建 kit 与 manager、再打包。输入没变时这份
 * 归档与重新构建的产物内容相同，所以按摘要复用可以直接省掉这段等待。
 *
 * 复用必须可核验，缺一不可：
 *
 * 1. 存在上一次 **ready** 的发布记录，且记录里写明输入哈希与归档摘要；
 * 2. 当前提交的 `managerToolInputs` 哈希与记录一致；
 * 3. 记录里的归档仍在磁盘上，且 sha256 与记录一致（内容寻址，不信任路径）。
 *
 * 任何一条不成立都返回 `null`，调用方照常全量构建；判定失败不是错误，只是没有可复用的基线。
 * 这里不复用工具树本身（只复用归档再安装一次）：这样新操作的 `toolRoot` 仍在自己目录内，
 * 不依赖旧操作目录继续存在。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { managerToolInputsHash } from '../../scripts/manager-tooling.mjs';
import { readSitePointer, readSiteRecord } from '../../packages/plugin-manager/src/site-record.mjs';

const reason = message => ({ reuse: null, reason: message });
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');

/** 判定能否复用上次成功发布的管理器归档；返回 `{ inputs, reuse, reason }`，`inputs` 始终是当前提交的哈希。 */
export function resolveToolingReuse({ root, git, revision }) {
  const inputs = managerToolInputsHash(git, revision);
  const decide = message => ({ inputs, reuse: null, reason: message });
  let pointer;
  // 指针本身可能指向已被移动或删除的操作目录：判定失败退回全量构建，不在这里抛错。
  try { pointer = readSitePointer(root); }
  catch (error) { return decide(`上一次发布记录不可用（${error.message}）`); }
  if (!pointer) return decide('没有上一次发布记录');
  let record;
  try { record = readSiteRecord(root, pointer.operation, { status: 'ready' }); }
  catch (error) { return decide(`上一次发布记录不可用（${error.message}）`); }
  const { managerArchive, managerHash, managerInputs } = record;
  if (typeof managerHash !== 'string' || !/^[a-f0-9]{64}$/u.test(managerHash) || typeof managerArchive !== 'string') return decide('上一次发布记录缺少管理器归档身份');
  // 这条记录早于「输入哈希」这个字段时也走重新构建，并如实说明原因。
  if (typeof managerInputs !== 'string' || !/^[a-f0-9]{64}$/u.test(managerInputs)) return decide('上一次发布记录没有记下管理器输入哈希');
  if (managerInputs !== inputs) return decide('管理器构建输入已变化');
  if (!existsSync(managerArchive) || !statSync(managerArchive).isFile()) return decide('上一次发布的管理器归档已不存在');
  if (digest(managerArchive) !== managerHash) return decide('上一次发布的管理器归档与记录摘要不一致');
  return { inputs, reuse: { archive: resolve(managerArchive), sha256: managerHash }, reason: '管理器构建输入未变化，复用上一次成功发布的归档' };
}
