# 牛马-老板（dsh-niuma-boss）

像素风职场游戏入口：老板走进办公楼、与员工和场景交互，并在任务本里查看同一个登录用户在牛马大总管（`dsh-butler-console`）里的权威任务状态。

## 职责边界

- 管家是任务、历史、正文和业务结果的唯一权威。本插件**不建数据库、不代理管家接口**：浏览器直接同源调用管家的只读接口（`identity`、`conversations`、`history`、`task`、`events` SSE），任务终态只来自权威快照与 `summary` 事件。
- 游戏后端只提供自己的页面、静态资源（`/niuma-boss/assets`、`/niuma-boss/generated`）与健康探针（`/health`、`/ready`）。
- 页面与资源要求登录并持有 `niuma-boss:access` 权限；未登录打开页面会重定向到登录页并带回跳地址。任务操作仍走管家自己的身份与权限校验，游戏不代替用户或提升权限。
- Phaser 保存高频游戏状态（人物坐标、镜头、动画），不逐帧同步到 Vue/Pinia；Pinia 只保存任务投影、会话列表、连接状态与界面开合。

## 构建与验证

```bash
pnpm prepare-assets   # 双源编译 office 地图并打包纹理图集到 public/generated/
pnpm build            # prepare-assets + 类型检查 + Vite 页面产物（web/）+ tsdown 服务端入口（dist/）
pnpm check            # 类型检查 + 单元测试
pnpm test:browser     # 本地回环 + Chromium/Edge 无头浏览器验收（结果写 .artifacts/）
```

- 运行资源编译读取本插件 `docs/04-资源/美术资源包/delivery/`，双源不一致时构建失败；只有 office 布局许可的角色进入运行时。
- `scripts/local-verify.mjs` 启动本地回环验证服务（真实 kit 路由 + 管家契约桩），供本地浏览器验收使用；不进入发布包。
- `scripts/browser-check.mjs` 跑端到端用例，并额外产出：`<engine>-browser-check.har`（请求/响应元数据，不嵌正文）、检查产物 JSON 里的设备与环境记录（浏览器版本、UA、视口、DPR、GPU 渲染器、机器摘要）、以及重场景帧预算采样（办公楼全量名册 + 角色动画 + 持续管家事件流，桌面 ≥600 帧、移动视口 ≥300 帧；同屏最多 10 人，全量名册 11 位，boss 与咖啡店 1 位不同时渲染；本管线无粒子/补间 VFX 层，环境特效按 0 记录）。截图与 JSON 都在 `.artifacts/`，仅供人工复核，不进包。
- 应用通过官方 `dsh` profile 启动，由管理器安装运维；本插件自身不提供生产启动方式。

## 部署配置

`cordis.patch.yml` 声明默认配置，管理器部署时整体覆盖：`accessMode`（默认 `authenticated`）、`publicOrigin`（认证模式必填）、`routePrefix`（默认 `/niuma-boss`）。前端静态资源与运行时 JSON 随 `routePrefix` 一并改写。

### 作者打包与站点接入

本插件是外部作者插件：**站点不构建它的源码**，只消费打好的归档。

```bash
# 作者侧（本仓库工作区）：构建、打包、内容寻址
pnpm package --external --plugins "niuma-boss" --output .local/dsh-plugin-storage/tmp/prod-release-game
# 交付前自检（只读，退出码 0 表示合规）
node packages/plugin-manager/dist/cli.mjs verify-release --release .local/dsh-plugin-storage/tmp/prod-release-game
```

产出目录里只有 `manifest.json` 和按内容哈希命名的 `niuma-boss-<sha256>.tgz`。把这个目录整体放进站点的 `incoming/`，由站点自己的安装流程（源码发版或产物部署）读取并安装；站点下载/构建的是归档而不是本目录源码。

运行时不依赖 CDN，也不依赖 `node_modules`：

- 页面依赖（Phaser、Vue、Pinia、EasyStar）在构建时打进 `web/assets/`，地图与角色图集是包内的 PNG/JSON；浏览器只向**同源**地址取资源与调管家接口，没有任何外部域名请求。
- 服务端入口 `dist/index.mjs` 只有插件自己的路由，`@deepseek-ai/schemastery` 是包内声明依赖、kit 与宿主由官方 profile 提供。
- 归档里没有凭据、没有美术工程源（`.tmj/.aseprite/.psd/.pxo` 等）与预览图，只有运行资源。

## 离线资源与再生成

包内 `web/generated/` 是运行所需的全部生成物：

| 文件 | 内容 |
| --- | --- |
| `office.runtime.json`、`street.runtime.json`、`cafe.runtime.json` | 精简运行时地图：尺寸、32×32 碰撞、区域/工位/入口/脚点、本图角色与图集清单 |
| `office.json`+`office.png`、`street.json`+`street.png`、`cafe.json`+`cafe.png` | 三张地图的图块集（Phaser 3 图集格式） |
| `boss.json`+`boss.png`、`office-npcs.json`+`office-npcs.png`、`office-walk.json`+`office-walk.png`、`cafe-npcs.json`+`cafe-npcs.png` | 老板、办公楼 NPC、办公楼走帧、咖啡店 NPC 的角色图集 |
| `asset-report.json` | 本次编译摘要（出生地图、各地图人数、图集帧数与尺寸、座位与自主活动域），供核对，不参与渲染 |

再生成方式：`pnpm prepare-assets`（`pnpm build` 的第一步）。它读取 Tiled 工程与已验收的布局 JSON 双源，任一处不一致就直接失败，不会静默选边；生成后可用 `asset-report.json` 与源码 JSON 对照帧数、尺寸和人物名单。图集单边不超过 2048，角色使用逐帧脚点、不旋转不裁边；走帧图集在玩家首次操作后才由页面按需加载，不在首屏里。

## 探针与操作

| 路由 | 说明 |
| --- | --- |
| `/niuma-boss` | 游戏页面；要求登录且持有 `niuma-boss:access`，未登录重定向到登录页并带回跳地址 |
| `/niuma-boss/assets/`、`/niuma-boss/generated/` | 页面产物与运行资源，同样要求登录与权限；方法不是 GET 一律 405 |
| `/niuma-boss/health` | 公开、无身份要求：插件已装载就返回 200 `{"ok":true}` |
| `/niuma-boss/ready` | 公开：访问检查就绪返回 200；依赖不可用返回 503 |

几个操作口径：

- 探针只说明插件自身的服务状态，不代表登录授权与业务可用；验证部署要看**登录后的页面与一次实际业务请求**。
- 地图移动、任务本读取和历史都要求登录身份，任务写入仍由管家做最终校验；游戏不代替用户或提升权限。
- 管家不可用时页面按实际情况降级：地图与普通 NPC 的预写对白照常可用，写入口给出可见原因，`/events` 断开后按 1/2/5/10 秒退避重连并从最后序号续订。
- 竖屏为精简布局（次要 HUD 隐藏、任务本与对话用全屏弹层）；`routePrefix` 改动后页面注入前缀会一起改写，不需要另改构建产物。

## 当前范围

桌面为非 Safari 浏览器（键鼠），移动为 Android 手机和平板（点击移动，横屏为主）；iOS、iPadOS 与所有平台的 Safari 不在适配与验收范围内。已实现的是办公楼、商业街、咖啡店三图往返（碰撞、入口防连跳、按用户恢复位置）、任务本与派活/回复/停止/待外部处理展示、人物表现与权威状态映射，以及断流/限流/权限失效下的恢复与提示。普通 NPC 只播放作者预写对白，员工不接闲聊模型通道；游戏不复制管家的调度、锁或数据库。

## 未测项

以下项目**没有**验证通过记录，不能按已通过对待：

- **真机**：Android 手机/平板的 GPU、物理旋转、软键盘遮挡与发热都未在实体设备上验证。移动端帧预算数字来自 390×844 视口模拟（DPR 1，非真机）。
- **真实输入法**：桌面中文输入法的候选窗与组合事件只做了事件层模拟（组词中方向键不带动人物、输入框聚焦后按键不移动），真实输入法本身未测。
- **Firefox**：本阶段基线与验收只覆盖 Windows Playwright 无头的 Chromium 与 Edge，Firefox 未测，也不承诺兼容。
- **真实宿主链路**：隔离的本地官方宿主环境（本机 mock 模型、合成测试账号）只验证了装包、字节一致与 health/ready 就绪，**登录授权与业务请求未执行**；生产站点上的登录授权、业务 POST 的 Origin 保护、真实事件流、真实模型以及游戏与管家双入口链路仍未执行。
- **生产部署**：本插件尚未在任何生产站点启用，发版需要单独授权。
