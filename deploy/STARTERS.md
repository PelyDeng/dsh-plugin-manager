<!-- Generated from deploy/STARTERS.md.tmpl by scripts/version.mjs; edit the template. -->

# DSH Plugin Manager 0.16.1 作者起步包

选择一个目录复制为自己的项目：

| 目录 | 用途 |
| --- | --- |
| standalone-plugin | 无 kit、无认证的公开就绪端点 |
| standalone-kit | 内嵌 kit，复用登录与应用授权，返回可信账号身份 |

两个目录都带完整源码和 README，可独立复制。鉴权目录中的 vendor/plugin-kit.tgz 是匹配版本的公开构建依赖，已用相对 file 引用；它会内嵌到最终运行产物，部署端不需要作者的 vendor 路径。

<!-- Excerpt from doc/plugin-development.md.tmpl#author-tools; edit its source. -->
需要 Node.js `^22.19.0 || >=24`、pnpm `11.19.0` 和系统 tar。从同一框架 Release 取得 `dsh-plugin-manager-starters-0.16.1.zip`、`plugin-manager-0.16.1.tgz`；起步包的鉴权目录已带同版 kit；仅单独复制仓库示例或升级 kit 时另取 `plugin-kit-0.16.1.tgz`。核对随发行提供的 SHA-256，不假设这些包已发布到 npm registry。

起步 zip 内有 standalone-plugin、standalone-kit；选一个目录复制为自己的作者项目，不复制 node_modules、dist 或 .local。在作者项目以外创建独立工具目录 dsh-tools，在该工具目录安装实际 manager 归档：

```sh
pnpm init
pnpm add --ignore-workspace /absolute/path/plugin-manager-0.16.1.tgz
pnpm exec dsh-plugin-manager --version
```

将占位路径替换为实际绝对路径，含空格时加引号。以后 pnpm exec dsh-plugin-manager 都在这个工具目录执行，--root 明确指向作者项目。manager 不加入业务运行依赖；工具目录和作者项目各自保存锁文件。

从 Release 起步包复制后，在所选作者目录执行 `pnpm install --ignore-workspace`，保存生成的锁文件，然后按该目录 README 打包并运行一次。先用原名验证成功，再按改名表接入自己的业务。

<!-- Excerpt from doc/plugin-development.md.tmpl#author-pack; edit its source. -->
在工具目录执行，将作者项目换成实际绝对路径：

```sh
pnpm exec dsh-plugin-manager list --root /absolute/path/my-plugin --package .
pnpm exec dsh-plugin-manager pack --root /absolute/path/my-plugin --package . --output .local/artifacts/release/v1
```

list 只读声明，不要求锁文件；pack 要求作者根的 pnpm-lock.yaml，冻结安装后各执行一次 build/check，再校验并打包，无需事先重复 check。输出必须是新目录或空目录，路径相对作者 root；再次发布用新目录 v2。日常可独立运行 check，它会先 build，完整业务测试另行运行。

交付整个输出目录，其中有 manifest.json 和所有摘要命名 tgz。部署者把目录放到 incoming/my-plugin 后执行框架 build，不手写清单。不使用 prepare/prepack/postpack 重复构建。运行依赖不得指向作者机器或 workspace；pack 成功不是宿主、登录、模型或业务验收成功。

新建 DSH 插件从以上目录开始；已有 Node 项目需要符合 Cordis 插件入口与构建契约；非 Node 服务继续独立运行，可由 DSH 插件调用接口，不是把任意应用压成 tgz 就能托管。

固定版本[作者指南](https://github.com/PelyDeng/dsh-plugin-manager/blob/v0.16.1/doc/plugin-development.md)和[插件配置规范](https://github.com/PelyDeng/dsh-plugin-manager/blob/v0.16.1/doc/plugin-configuration.md)提供详细说明。正常操作无需读内部状态机或下载整个框架源码。
