# 第四阶段技术验证夹具

本目录是一次性技术验证源码，不是第五阶段正式游戏插件。仅在本地运行，版本 0.0.0 只标识夹具。

在当前目录运行：

```powershell
pnpm install --ignore-workspace --frozen-lockfile
pnpm build
pnpm check:validation
pnpm pack:check
pnpm serve
```

访问 http://127.0.0.1:4178/niuma-boss。首次加载办公楼、老板和 Vue UI；点击按钮再加载其余 10 人与 48 个动画特效。方向键或 WASD 移动，点击地面四向寻路。输入框获得焦点或处于 composition 期间锁定游戏输入。

浏览器检查使用已安装的 Playwright 1.62.1（本次来自工作区运行依赖），将其 node_modules 目录放入 VALIDATION_NODE_MODULES。运行 `node scripts/browser-check.mjs edge` 或 `chromium`；系统 Edge 直接使用 channel，其余可用 VALIDATION_BROWSER_EXECUTABLE 指定已有匹配的浏览器二进制。新下载的浏览器设置 PLAYWRIGHT_BROWSERS_PATH 指向本目录 .browser-cache。当前移动适配范围为 Android 手机和平板；iOS、iPadOS及所有平台的Safari均不纳入本次适配或验收，不提供专用验证入口。

浏览器结果、截图和不含正文的本地 HAR 在相邻 evidence；真实输入法候选窗、实体手机 GPU 和已有登录 Cookie 不在无头模拟结果中。只重验受改动影响的部分；资源过滤变动可使用 `node --experimental-transform-types scripts/check.mjs --assets-only`。

输入仅来自 `docs/04-资源/美术资源包/delivery/`。地图编译读取 office.tmj、world.tsj 和 office.layout.json；图集保留全部角色动作及逐帧脚点。生成物在 public/generated 与 dist，不含美术截图、原生工程或配置凭据。

验证服务器只绑定回环地址，并使用伪造身份和本地管家桩。浏览器调用不会访问真实管家；写重试测试仅由 Node 检查脚本发起。kit 静态路由通过替身 Access 检查行为。真实宿主鉴权和生产部署不属于这些通过项。

根工作区已有的 tsdown 与 plugin-kit 用于验证封包，管家 web/stream.js 用于 SSE 解析；前端锁定依赖记录在本目录 pnpm-lock.yaml。夹具不会被根 plugins/* 扫描成正式插件。所有正式实现必须按第五阶段计划重新接入。
