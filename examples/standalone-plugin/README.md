<!-- Generated from examples/standalone-plugin/README.md.tmpl by scripts/version.mjs; edit the template. -->

# 独立 DSH Bundle 起步插件

先用原名跑通再修改。此例不需要 kit 或登录，只注册公开 `/independent-example/ready`；不创建 Agent，不模拟模型回答，也不应返回私密数据。

## 准备工具

<!-- Excerpt from doc/plugin-development.md.tmpl#author-tools; edit its source. -->
需要 Node.js `^22.19.0 || >=24`、pnpm `11.19.0` 和系统 tar。从同一框架 Release 取得 `dsh-plugin-manager-starters-0.16.3.zip`、`plugin-manager-0.16.3.tgz`；起步包的鉴权目录已带同版 kit；仅单独复制仓库示例或升级 kit 时另取 `plugin-kit-0.16.3.tgz`。核对随发行提供的 SHA-256，不假设这些包已发布到 npm registry。

起步 zip 内有 standalone-plugin、standalone-kit；选一个目录复制为自己的作者项目，不复制 node_modules、dist 或 .local。在作者项目以外创建独立工具目录 dsh-tools，在该工具目录安装实际 manager 归档：

```sh
pnpm init
pnpm add --ignore-workspace /absolute/path/plugin-manager-0.16.3.tgz
pnpm exec dsh-plugin-manager --version
```

将占位路径替换为实际绝对路径，含空格时加引号。以后 pnpm exec dsh-plugin-manager 都在这个工具目录执行，--root 明确指向作者项目。manager 不加入业务运行依赖；工具目录和作者项目各自保存锁文件。

在本作者目录执行 `pnpm install --ignore-workspace`，保存生成的 pnpm-lock.yaml。该例适用于框架 0.16.3 的打包与部署流程。

## 打包并请求

<!-- Excerpt from doc/plugin-development.md.tmpl#author-pack; edit its source. -->
在工具目录执行，将作者项目换成实际绝对路径：

```sh
pnpm exec dsh-plugin-manager list --root /absolute/path/my-plugin --package .
pnpm exec dsh-plugin-manager pack --root /absolute/path/my-plugin --package . --output .local/artifacts/release/v1
```

list 只读声明，不要求锁文件；pack 要求作者根的 pnpm-lock.yaml，冻结安装后各执行一次 build/check，再校验并打包，无需事先重复 check。输出必须是新目录或空目录，路径相对作者 root；再次发布用新目录 v2。日常可独立运行 check，它会先 build，完整业务测试另行运行。

交付整个输出目录，其中有 manifest.json 和所有摘要命名 tgz。部署者把目录放到 incoming/my-plugin 后执行框架 build，不手写清单。不使用 prepare/prepack/postpack 重复构建。运行依赖不得指向作者机器或 workspace；pack 成功不是宿主、登录、模型或业务验收成功。CLI 会在 pack 成功后输出这些下一步，交付时以整个目录为单位，不单独抽走 tgz。

在独立部署目录中把本次完整发布目录放入 incoming/independent-example，执行 build。访问 `http://127.0.0.1:7902/independent-example/ready`；端口改动时使用实际地址。预期 HTTP 200，响应为 `{"ready":true}`；必须验证实际端点，而非仅看到容器运行。

## 开始自己的业务

修改 package.json 的 name 与 deepseekPlugin.id、cordis.patch.yml 的包引用/条目、src/index.mjs 的插件名和路由，并同步 healthPath。包名用于 npm 安装，ID 用于选集与配置，路由对应实际 HTTP 地址；不要求所有字符串一律相同。

日常改代码 → pack 到新的输出目录 → 整体替换 incoming 对应目录 → build → 再次请求。保留其他应用目录。无需新增部署脚本或把本项目迁入框架仓库；独立作者仍通过官方 DSH profile 运行。
