# 智能体群组（dsh-agents-group）

DSH 生态里的智能体群组。多个业务智能体合在一个插件项目里统一分包管理，共享一份公共
组件包；但**每个智能体仍然各自是一条独立条目**，有自己的页面地址、授权开关和会话管理。

这样做的目的：不再为每个新智能体单独维护一个插件项目，同时不牺牲「谁能访问哪个智能体」
这条权限边界。

> 当前状态：**P0 骨架**。群组本身、探针、子包机制与失败隔离已就绪，业务智能体尚未迁入
> （`src/agents/registry.ts` 的清单还是空的）。迁移按实施计划 P1/P2 进行。

## 目录结构

```
plugins/dsh-agents-group/
├── package.json             # 群组的 DSH 声明（包 id = agents-group）
├── cordis.patch.yml         # Bundle 默认配置
├── dev/dev-hmr.patch.yml    # 开发期热重载（群组级统一开发根）
├── config/group.example.json# 业务配置模板；实际文件用 AGENTS_GROUP_CONFIG 指向
├── scripts/hmr-observer.mjs # 开发期工具，不随归档交付
├── src/
│   ├── index.ts             # 群组装配：登记自身条目、装载各 Agent、挂探针
│   ├── host.ts              # 装载与失败隔离、就绪判定
│   ├── config.ts            # 群组 Config Schema
│   └── agents/
│       ├── registry.ts      # ★ Agent 静态清单与端点推导
│       ├── closedoff.ts     # P1：封闭化的装载适配层
│       └── blog.ts          # P2：博客的装载适配层
├── agents/                  # ★ 各 Agent 的实体，独立 pnpm 子包
│   ├── closedoff/           # @dsh-agents-group/closedoff
│   └── blog/                # @dsh-agents-group/blog
├── packages/common/         # ★ 群组内部共享组件包，构建期内联
└── tests/
```

## 两条必须理解的约定

### 1. 路径、权限、id 由同一处推导

每个 Agent 的三样东西不允许各处手写，否则会出现「授权了但页面进不去」或「会话管理找不到
provider」这类难查的问题。它们统一由 `endpointsOf()` 从 id 推导：

| 用途 | 形式 | 例子 |
| --- | --- | --- |
| 目录条目 id / 授权标识 / 会话管理 key | `<id>` | `closedoff` |
| 页面地址 | `<群组前缀>/<id>` | `/agents/closedoff` |
| 权限标识 | `<id>:access` | `closedoff:access` |

**目录条目 id 在整个 DSH 里必须唯一。** 所以迁移期新旧插件不能同时启用 —— 都注册
`closedoff` 会直接 `插件重复登记`，站点起不来。迁移是「关旧的、开新的」切换式。

### 2. `AGENT_MANIFESTS` 是唯一的名单

`src/agents/registry.ts` 里那份静态数组就是群组认识的全部 Agent。新增一个 Agent 只需要
在这里加一条，**管家（dsh-butler-console）那边不用改** —— 管家按「一个 Agent 一个执行
入口」工作，两条条目天然被识别成两个成员。

用静态清单而不是扫描目录：构建产物要可树摇、类型要可检查、装载顺序要确定，动态扫描在
打包后不可靠。

## 新增一个 Agent 的步骤

1. 建子包 `agents/<id>/`，包名 `@dsh-agents-group/<id>`，**不要声明 `deepseekPlugin`**
   （声明了就会变成独立插件）。
2. 在 `src/agents/registry.ts` 的 `AGENT_MANIFESTS` 加一条。
3. 写适配层 `src/agents/<id>.ts`，导出 `mount(context)`：
   用 `context.access` 做访问校验、`context.http` 注册路由、`registerPlugin()` 登记目录条目、
   `registerConversations()` 注册会话管理 provider。**id、路径、权限都从
   `endpointsOf()` 取，不要手写。**
4. 在 `src/index.ts` 的 `loadAgent()` 里加一个 `case`。
5. 跑 `pnpm install`（写入 workspace 锁）、`pnpm check --plugins "agents-group"`、`pnpm test`。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `accessMode` | `authenticated` | `standalone` 仅用于本机调试 |
| `publicOrigin` | 空 | 认证模式必填，HTTP(S) origin，不带路径 |
| `routePrefix` | `/agents` | 群组根前缀；各 Agent 是它的子路径 |
| `authRecheckMs` | 1000 | 认证复核间隔 |
| `agents.<id>.enabled` | true | 是否装载该 Agent |
| `agents.<id>.models.allow / .deny` | 空 | 模型白名单，留空＝不过滤 |

业务凭据走群组级 `runtimeConfig` 文件（`AGENTS_GROUP_CONFIG` 指向），不进 Git、不进镜像。

### 关于模型白名单这个代价

宿主的模型目录是**全局扁平的**，没有 scope 机制：provider 一旦注册，全进程可见。所以
「只让某个 Agent 看到某些模型」只能在群组侧过滤，白名单由**我们自己维护**，宿主新增
provider 时不会自动生效。

## 探针

| 地址 | 含义 |
| --- | --- |
| `GET /agents/health` | 群组进程存活 |
| `GET /agents/ready` | 群组就绪；正文列出每个 Agent 的状态 |

**只要有一个 Agent 就绪就返回 200。** 如果任一 Agent 配置错就让整组 503，会把「某一个
Agent 挂了」升级成「全部不可用」，运维上更难判断。一个都没起来才算不就绪。

## 开发模式

群组只有一个 `development.rootVariable`（管理器要求变量名全局唯一），所以用同一个开发根
覆盖全部 Agent：`AGENTS_GROUP_DEV_ROOT`。`dev/dev-hmr.patch.yml` 里列出各子包的 `dist`，
改哪个、重建哪个，对应模块就会重载，不用重启服务。

## 本地命令

```sh
pnpm install                              # 首次或新增子包后，写入 workspace 锁
pnpm list:plugins                         # 应看到 agents-group 一行
pnpm check --plugins "agents-group"
pnpm test --filter dsh-agents-group
```

纳入源码部署选集时，在私有 `.local/env.conf` 的 `DSH_PLUGINS` 里加入 `agents-group`
（不要改公开的根 `env.conf`）。发版到服务器需要用户明确要求后才执行。
