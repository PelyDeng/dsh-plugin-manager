<!-- Generated from doc/versioning.md.tmpl by scripts/version.mjs; edit the template. -->

# 版本管理

公共框架当前版本为 **0.14.2**。根 `package.json` 的 `version` 是唯一版本源，manager、kit、auth、example 使用同一版本，作为一个单元构建、验证和发布。组件的 `package.json`、构建产物和文档中的当前版本都从这一源值同步。

定制插件、独立作者项目和官方 `deepseek-harness` 宿主不属于这个统一发布单元，保留各自的版本及兼容性要求。统一版本不代表第三方插件或任意宿主自动兼容，也不表示远程站点已经升级。

## 设置、同步与检查

在公共仓库根目录执行：

```sh
# 设置框架版本，同时同步公共组件与文档；下一次发布替换为目标版本
node scripts/version.mjs set 0.14.2

# 根版本已正确时，重新生成公共组件版本字段和文档
node scripts/version.mjs sync

# 只检查；版本或生成文档不一致时失败，不修改文件
node scripts/version.mjs check
```

功能大改升级次版本并归零补丁号，小改升级补丁号；未经明确里程碑要求不发布 `1.0.0` 及以上版本。设置版本后仍须执行所需构建、测试和交付验收；版本同步本身不等于发布。

## 文档怎么改

有相邻 `.md.tmpl` 的文档以模板为编辑源。模板使用版本占位符（`FRAMEWORK_VERSION`，左右各两个花括号）表示当前框架版本，执行 `sync` 后生成同路径的 `.md`；模板与生成结果都提交到 Git。生成文件顶部标明模板路径，不手改生成文件。

历史发布说明中的版本、某项功能首次提供的版本，以及 Node.js、pnpm、宿主和协议版本均保留原值，不替换为框架变量。没有当前版本数字的文档直接编辑 `.md`。

CI 只运行同步检查，发现差异时由维护者在本地运行 `sync` 并提交。发布标签使用 `v` 加根框架版本；发布步骤与附件核验见[发布说明](../.github/RELEASING.md)。
