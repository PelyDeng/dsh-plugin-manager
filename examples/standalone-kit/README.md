<!-- Generated from examples/standalone-kit/README.md.tmpl by scripts/version.mjs; edit the template. -->

# 独立鉴权接入示例

复制到自己的仓库，取得维护者提供的 plugin-kit 0.14.1 tgz 与 plugin-manager 0.14.1。该目录故意不引用未发布的 registry 包；先把实际 kit 归档加入开发依赖，生成自己的锁文件：

```sh
pnpm add --ignore-workspace --save-dev <kit-tgz绝对路径>
dsh-plugin-manager pack --root <本包绝对路径> --package . --output .local/release
```

kit 内嵌到 dist，作者机器上的 kit tgz 不进入运行依赖。示例端点 `/independent-access-example/identity` 只返回已鉴权的账号标识，不提供聊天或业务数据库。新增数据查询时必须用该身份检查数据归属；不要接受模型或浏览器自行声明的用户身份。

默认要求认证。受管部署候选清单必须同时包含一个 auth provider 和本 consumer，并配置 publicOrigin。已经安装在 profile 中但未出现在候选清单的 auth 不满足此要求。通过 `dsh-plugin-manager compose-release --root <交付根> --output <新目录> --manifest <auth清单> --manifest <本应用清单>` 生成完整候选集合，再按 manager 包内 DELIVERY.md 部署。

独立演示可通过本插件实例 plugin.json 设置 `accessMode: standalone`，按受控部署流程重新应用；这时返回的是共享本地身份。直接走官方 Bundle 时，使用自己的 patch 提供 accessMode/publicOrigin，不能依靠管理器实例配置自动生效。静态构建通过不代表鉴权已经验收。

日常开发可单独执行 `dsh-plugin-manager check --root <本包绝对路径> --package .`；直接交付时只需 pack。
