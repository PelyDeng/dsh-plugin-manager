# @dsh-agents-group/runtime

牛马生态的 **Agent 运行时**。机制的实现只有这一份：会话、投影、参与者、提示词、工具、交接都在
这里；业务子包（`agents/closedoff`、`agents/blog`）只写一份 `AgentDefinition` 声明 —— 人设、
工具、输出钩子、结果投影。何时调、按什么顺序调、失败了怎么办、按什么节奏发布，都由运行时代管，
业务不重复实现。

本包是群组内部的私有包（`private: true`，不对外发布），通过 workspace 引用，由群组打包器在
构建期**内联**进群组产物。

## 硬约束：永远内联，不得独立构建

**本包不产出自己的 `dist`，也不得改成独立构建、独立发布的包。** 它只以 TypeScript 源码形式被
引用（`main` / `types` / `exports` 都指向 `src/index.ts`），由群组的 `tsdown` 内联进产物。

理由在 `src/resources.ts`：`pluginRootOf()` 拿**调用方的 `import.meta.url`** 当起点向上找插件根，
判据是「该目录下同时存在 `package.json` 与 `agents/`」。

- **内联时成立**：调用点属于群组产物（开发形态 `<插件根>/agents/<id>/src/`，发布形态
  `<插件根>/dist/`），向上走必然命中群组插件根 —— 这正是 `resources.ts` 里那张两种布局对照表
  的前提。
- **独立构建就破坏这个不变量**：调用点会落进本包自己的产物与包边界，起点不再是群组产物树；
  向上要么命中错误的目录（本包自己的包根下没有 `agents/`），要么直接抛出
  「找不到插件根」。这种失效只在**装载期**暴露，而单测跑的是源码，看不出来。

同一条约束原先只写在 `packages/common/package.json` 的 `build` 脚本消息里
（`common 由群组产物内联，无需单独构建`）。这里把它写进 README，因为它是**契约级**约束，
不是某个脚本的实现细节：谁把本包改成独立构建，坏掉的是资源定位，不是构建本身。

推论，消费方要注意：**本包没有声明文件**。需要**类型**的消费方按源码相对路径引入
（`../packages/runtime/src/contract.ts`），与群组 `src/host.ts` 现有做法一致 —— 打包器生成声明时
按包名找不到 `.d.ts`，会把类型当成「没有这个导出」直接报错；需要**运行时值**的
（`agentResource` 等）按包名引入即可，它们会被内联进产物。

## 与 `@dsh-agents-group/common` 的关系

本包是机制与契约的唯一落点：

| 能力 | 原位置 | 现位置 |
| --- | --- | --- |
| 协作契约（`AgentParticipant` 等） | `common/src/participant.ts`（**已删除**） | `src/contract.ts` |
| 未就绪占位参与者 | 三个子包各写一份（**已合并**） | `src/unavailable.ts` |
| 用户可读的错误整理 | `common/src/index.ts` | `src/errors.ts` |
| 子包资源定位 | `common/src/agent-resources.ts` | `src/resources.ts` |
| 通用天气工具 | `common/src/weather.ts` | **留在 common** |

common 现在只保留 `weather.ts` 与 `agent-resources.ts`：不要再往 common 加协作相关的声明或能力。
两份协作契约（common 的旧拷贝 vs 本包）已于 2026-09-18 归一——旧那份缺 `listActions` /
`applyAction`，用它的子包**看不见**自己已经实现的能力，编译期全绿而判据写不出来。

## 目录

```
src/
├── index.ts       # 对外入口；目前只导出已迁入的三个模块
├── contract.ts    # 协作契约：身份、消息、进度、结果
├── errors.ts      # visibleErrorMessage
└── resources.ts   # agentResource / agentResourcePath
```

核心机制（definition / conversation / prompt / tools / projection / participant / handoff）
由主线随后加入 `src/`，并在 `index.ts` 里追加导出。`index.ts` 不预先发明这些模块的导出。

## 本地命令

```sh
# 首次或新增包后，在仓库根写入 workspace 锁
pnpm install

cd plugins/external/dsh-agents-group/packages/runtime
pnpm typecheck     # tsc --noEmit
```

本包不单独构建：`pnpm build` 只打印一行说明。要验证改动对内联产物的影响，构建群组
（`pnpm --filter dsh-agents-group run build`）或直接跑群组的 `pnpm typecheck`。
