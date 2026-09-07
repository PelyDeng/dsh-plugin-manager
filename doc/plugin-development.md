# 插件作者接入

本框架支持独立 pnpm 单包与内部 `plugins/*` 批量开发，复用单包读取、任务执行、归档和部署实现。接口与参数见随版本交付的 [manager README](../packages/plugin-manager/README.md)，交付者步骤见 [DELIVERY](../packages/plugin-manager/DELIVERY.md)。

第一次接入请先走[图文手册](getting-started.md)，其中包含源码取得工具、实际目录和第二应用交付。下面说明作者修改点。

## 准备工具

维护者在本仓库安装冻结依赖后构建工具包，输出目录预先创建：

```sh
pnpm --filter @dsh-plugin/plugin-manager build
pnpm --filter @dsh-plugin/plugin-manager pack --out /absolute/output/plugin-manager-0.3.0.tgz
pnpm --filter @dsh-plugin/plugin-kit build
pnpm --filter @dsh-plugin/plugin-kit pack --out /absolute/output/plugin-kit-0.1.0.tgz
```

提供工具版本和 SHA-256；本地 tgz 不代表已经发布到公共 registry。作者安装 manager 即可交付无 kit 的插件，统一身份按需安装 kit。源码构建与运行不要求修改 DSH 本体。

## 两种示例

| 示例 | 验证能力 |
| --- | --- |
| [standalone-plugin](../examples/standalone-plugin/README.md) | 不依赖 kit，官方 Bundle 与受管 release 均可加载 |
| [standalone-kit](../examples/standalone-kit/README.md) | 独立消费 kit tgz，复用登录及应用授权，返回当前账号身份 |

将示例复制到自己的仓库，修改包名、插件 ID、Bundle 和路由，执行作者根的 `pnpm install --ignore-workspace` 并保存锁文件。通过 manager 的 `--root <作者根> --package .` 执行 list/build/check/pack。只需交付时直接 pack，无需先运行重复的 build/check。

build/check 由作者声明，完成产物和必需启动检查，不复制框架登录、密码、授权或部署实现。完整业务测试保留独立 test。插件声明与配置字段集中见[配置规范](plugin-configuration.md)；业务字段校验归应用所有，错误应标明应用 ID 与字段名，不能输出凭据。

发布包可脱离源码部署。作者提供归档、清单、公开配置模板、包内 README、已验证宿主版本、就绪地址和业务查询方法；销售接口、数据范围、Agent 工具和图表属于应用代码。kit 的可信身份不能替代业务数据授权。

内部流程不传 `--package`，继续使用 `plugins/*`、`--plugins` 选集和批量任务。内部清单 1 保留 development/link；外部单包与组合清单 2 只支持 release，不支持外部 workspace 自动发现或 link/HMR。

## 复制完整问答应用到独立仓库

复制 `plugins/dsh-example` 中的源码、web、knowledge、examples、Bundle、README/LICENSE、package.json、tsconfig 与 tsdown 配置；不复制 node_modules、dist、数据库和 .local。选择一个未加入原框架 workspace 的新包根。

1. 在作者 package.json 删除 `@dsh-plugin/plugin-kit` 的 `workspace:*` 开发依赖，再在作者根执行 `pnpm add --ignore-workspace --save-dev <kit-tgz绝对路径>`。保留 tsdown 内嵌 kit，宿主依赖保持 peer。
2. 删除 scripts.clean 的原仓库相对入口，或换成只清理本包构建目录的实现。不要把数据目录加入清理命令。
3. `tests/config-examples.test.mjs` 含框架管理器集成检查，`tests/host-smoke.mjs` 使用框架相对宿主和归档路径；这两份留在框架，不复制到独立应用测试。其余 chat/history/knowledge 测试和 fixture 可作为应用自己的回归基础。
4. 修改包名、ID、Bundle、页面/探针、权限、配置 entryId、会话前缀/正则、提示词段名、知识、页面文案和测试；仅验证原 example 独立构建时可先保留名称，但不能与原包在同一候选中重复安装。
5. 知识输入只读取包内 knowledge，不依赖原框架目录；改成其他业务应替换 src/knowledge.ts 中开发者职责及两份知识。部署的 config.systemPrompt 仅为补充。
6. 在作者根执行 `pnpm build`、`pnpm check` 和 `pnpm test`，保存 pnpm-lock.yaml。在工具目录执行 `pnpm exec dsh-plugin pack --root <作者包根> --package . --output <新发布目录>`。只交付无需事先重复 build/check。

部署者只取得整个发布目录及说明。确认 tgz 包含知识、页面、配置模板和入口；作者源码目录不参与 release。kit 更新需每个消费应用更新内嵌版本后重新交付，不能只升级管理器。
