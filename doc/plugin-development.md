# 插件作者接入

本框架支持独立 pnpm 单包与内部 `plugins/*` 批量开发，复用单包读取、任务执行、归档和部署实现。接口与参数见随版本交付的 [manager README](../packages/plugin-manager/README.md)，交付者步骤见 [DELIVERY](../packages/plugin-manager/DELIVERY.md)。

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
