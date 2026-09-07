# 发布公共 GitHub Release

公共仓库的 [Release 工作流](../.github/workflows/release.yml) 在维护者推送稳定版本标签 `vX.Y.Z` 时执行。普通 main 推送只运行检查，不发布版本，不更新服务器，也不发布 npm 包。工作流只在 `PelyDeng/dsh-plugin-manager` 运行；Gitee 集成仓库不作为公共发布源。

## 准备与触发

1. 在公共仓库更新组件版本和锁文件；框架标签对应 manager 版本，各组件可以独立版本化。
2. 新建 `doc/releases/vX.Y.Z.md`，写清变化、安装入口、兼容的宿主提交和实际验证边界。归档不包含宿主、模型凭据或运行数据。
3. 完成相关验证，提交并推送公共 main，确认该提交的 Check 工作流通过。
4. 从这个已核验的公共提交创建带说明的标签并推送，例如本次版本：

```sh
git tag -a v0.3.2 -m "DSH Plugin Manager v0.3.2" <已核验的公共提交号>
git push origin refs/tags/v0.3.2
```

将占位符替换为完整提交号。不要给不同代码重复使用同一版本，也不要移动已发布的标签。私有插件更新仍按私有集成流程处理。

## 工作流做什么

构建任务先核验标签与 manager 版本相同、版本说明存在，再执行冻结安装、构建、检查、行为测试、独立归档消费检查和仓库检查。官方宿主子模块不下载，真实宿主和模型验收由维护者另行执行，不能从工作流成功推导出来。

打包复用现有管理器，只选择公共 auth/example，生成无源码目录字段的 schema 2 清单。发布内容为 manager tgz、kit tgz、公共应用 ZIP，以及三个文件的 `SHA256SUMS.txt`。ZIP 内附版本说明。工作流不收集任意 `.local` 文件，只上传专用输出目录。

构建任务保持仓库只读权限。独立发布任务取得这些构建产物、再次核对校验值，使用 GitHub 临时令牌及 `contents: write` 创建 Release；不向本地导出令牌，不需要个人访问令牌。Release 正文来自该标签内的版本说明。

## 核验与失败处理

发布后核对标签实际提交、Release 是否公开、四个附件是否齐全，下载附件并核对校验值；再按交付说明验证所需消费方式。工具包名称不代表已经发布到 npm，GitHub 自动生成的 Source code ZIP 也不包含子模块源码。

工作流失败时先查看失败步骤和外部 Release 状态。构建失败可以对同一运行重试；如果已经创建 Release 或上传部分附件，先检查现有内容，不能盲目覆盖或重新移动标签。流程不自动删除既有 Release，也不使用 `--clobber` 覆盖附件。

GitHub CLI 发布参数见[官方文档](https://cli.github.com/manual/gh_release_create)。
