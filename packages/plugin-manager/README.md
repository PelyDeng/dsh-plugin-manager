# @dsh-plugin-manager/plugin-manager

DSH 应用接入与交付管理 CLI。独立包和内部 `plugins/*` 共用 build → check → pack，通过官方 DSH CLI 安装 Bundle、配置并受控启停。kit 和基础认证可选；管理声明不会自动保护业务路由。

## 安装与作者操作

需要 Node.js `^22.19.0 || >=24`、pnpm `11.19.0` 和系统 `tar`。在工具目录执行 `pnpm add --ignore-workspace /path/to/plugin-manager-0.3.1.tgz`，随后使用 `pnpm exec dsh-plugin-manager`。包名不表示已发布到公共 registry。本 README 随工具版本交付。

每个项目操作要求 `--root`；相对配置、home 和产物路径相对这个根解析。独立作者包根需有 package.json：有效 name/version、main、files、README、scripts.build/check、官方 dsh.bundle.patch，以及 `deepseekPlugin: { "schemaVersion": 3, "id": "my-plugin" }`。页面、探针、权限、认证与 kit 均不强制要求。构建产物可以由 build 生成。

部署和迁移输出使用规范化的完整路径，包括 Windows 8.3 短目录名。迁移仍拒绝通过符号链接或目录联接指定源、目标和备份。

在作者根执行 `pnpm install --ignore-workspace` 并保存 pnpm-lock.yaml，随后在工具目录调用：

```sh
pnpm exec dsh-plugin-manager list --root /path/to/author-project --package .
pnpm exec dsh-plugin-manager pack --root /path/to/author-project --package . --output .local/artifacts/release
```

`--package` 仅支持 `.`，与 `--plugins` 互斥。list 不执行脚本、不要求锁文件；build/check 使用作者已安装的依赖；pack 冻结安装根锁文件，忽略父 workspace，依次执行一次 build 和 check 后打包。check 本身先执行 build。直接 pack 无需预先 build/check；不使用 prepare/prepack/postpack 重复构建。检查限于声明、交付与启动条件，不注入业务测试。

独立包产出清单 2，包含内容摘要命名的 tgz，不携带作者源码目录。额外核对归档时执行 `pnpm exec dsh-plugin-manager verify-package --root <作者根> --package . --archive <tgz>`，不重新构建。Windows 归档校验通过文件句柄读取，支持中文目录且不依赖 tar 的路径编码。

## 部署现成归档

完整部署、普通账号授权和更新步骤见随包发布的 [DELIVERY.md](DELIVERY.md)。组合命令：

```sh
pnpm exec dsh-plugin-manager compose-release --root /path/to/site --output releases/site-v1 --manifest incoming/auth/manifest.json --manifest incoming/app/manifest.json
```

更新使用新输出目录并加 `--previous <现用清单>` 保留旧归档；新候选只来自 manifest 输入。完整站点部署显式 `--plugins all`，避免旧配置过滤新增应用。

运行端无需作者源码、Git 或 plugins 目录。启动、健康检查与停止使用 DELIVERY 中的实例配置命令。

清单 2 不支持 development；请求在修改实例前拒绝。内部清单 1 继续支持 release 和原有 development/link。未声明 healthPath 的插件显示 not-provided，不表示业务就绪。依赖安装仍可能需要网络。

支持 configuration 的插件使用 `<DSH home>/plugins/<id>/plugin.json`，例如 `{"schemaVersion":1,"enabled":true,"accessMode":"standalone","config":{}}`。accessMode 仅适用于认证消费者；authenticated 需要合法站点 publicOrigin 和候选清单中唯一、已启用的认证提供者。使用 compose-release 显式组合业务应用与认证插件。认证模式修改需配置加受控重启。

Docker 实例通过 `apply-compose --root <项目根> --config <deployment.json>` 应用配置，接受不可变本机镜像 ID 或 registry 摘要，`--resume` 恢复原操作。`migrate-data` / `migrate-artifacts` 默认仅预览。完整命令参数见 `pnpm exec dsh-plugin-manager --help`；部署细节与示例见[仓库开发分支文档](https://github.com/PelyDeng/dsh-plugin-manager/tree/main/doc)，该链接可能领先于已安装版本。

## 内部批量开发与 API

省略 `--package` 时保留根锁文件及 `plugins/*` 扫描，支持 `--plugins auth,example`、默认选集、all/none。内部 kit 工作区准备和批量操作保持原行为。

包根导出部署函数，`/catalog` 导出 `readPlugin`、发现与选集，`/packaging` 导出打包函数。管理器只读取声明与归档，不导入业务源码。
