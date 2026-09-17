/**
 * 转发：内存版 `ConversationPort` 已**提升为运行时的正式实现**（`packages/runtime/src/storage/memory.ts`）。
 *
 * 保留这个文件只是为了让既有 import 路径不必改（本包 7 个测试 + closedoff 4 个测试）。
 * **新代码请直接从运行时导入**（`../../packages/runtime/src/storage/memory.ts`）。
 *
 * ⚠️ 它为什么从 `tests/` 挪进 `src/`：blog 的测试在**另一个包**（`agents/blog/tests/`，24 个文件 /
 * 192 条用例跑在 SQLite `:memory:` 上），索引库切到 PG 端口之后它们会**失去后端**；而 `storage/local.ts`
 * 是"移除围栏的本地镜像 + outbox"，**不是**可用的内存端口实现。跨包 import 另一个包的测试夹具不可行，
 * 所以它必须是运行时提供的实现。
 */
export * from '../../packages/runtime/src/storage/memory.ts'
