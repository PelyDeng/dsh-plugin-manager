# 私有插件仓库

本仓库的 `origin` 为 `git@gitee.com:dengpeilin/dsh-plugin.git`。公共框架来自 `upstream`：`git@github.com:PelyDeng/dsh-plugin.git`。两者通过 Git 合并更新，未配置持续镜像。

公共框架改动在 `dsh-plugin` 工作区完成、验证并推送 GitHub，然后在本仓库执行 `git fetch upstream` 和 `git merge upstream/main`。客户插件只在本仓库开发并推送 Gitee；`upstream` 的推送地址禁用。

`plugins/dsh-closedoff-assistant` 是私有定制插件，其 `vendor/` 包含构建播放器所需的版本化归档。该目录不受根 Apache-2.0 许可授权，适用插件 [LICENSE](plugins/dsh-closedoff-assistant/LICENSE)。第三方资源保持各自许可。不得将该目录或包含它的提交推送公共仓库。

运行配置放在 `.local/data/dsh-home/plugins/closedoff/env.conf`，从插件模板创建；模型凭据、真实业务配置及运行数据不进入 Git。发布包放在 `.local/artifacts/`。

```sh
pnpm install --frozen-lockfile
pnpm check --plugins auth,closedoff,example
pnpm package --plugins auth,closedoff --output .local/artifacts/release/plugins
```

宿主子模块锁定 DSH `0.1.3-alpha.1`，以 Git gitlink 为准。升级公共框架时单独审查宿主版本变化；最终构建、插件归档和部署验收均以本仓库提交为依据。
