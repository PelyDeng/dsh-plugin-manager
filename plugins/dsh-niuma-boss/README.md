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
- 应用通过官方 `dsh` profile 启动，由管理器安装运维；本插件自身不提供生产启动方式。

## 部署配置

`cordis.patch.yml` 声明默认配置，管理器部署时整体覆盖：`accessMode`（默认 `authenticated`）、`publicOrigin`（认证模式必填）、`routePrefix`（默认 `/niuma-boss`）。前端静态资源与运行时 JSON 随 `routePrefix` 一并改写。

## 当前范围

首版桌面范围为非 Safari 浏览器（键鼠），移动范围为 Android 手机和平板（点击移动，横屏为主）。本切片只实现进入 office、人物移动、任务本与管家任务的只读订阅；派活、回复、补充、停止等写入口与街道/咖啡馆地图属后续切片。
