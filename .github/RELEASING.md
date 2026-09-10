# 发布公共 GitHub Release

公共仓库的 [Release 工作流](workflows/release.yml) 在维护者推送稳定版本标签 `vX.Y.Z` 时执行。只有用户明确要求发版时才选择版本和推送发布标签。普通 main 推送只运行检查，不发布版本，不更新服务器，也不发布 npm 包。工作流只在 `PelyDeng/dsh-plugin-manager` 运行；Gitee 集成仓库不作为公共发布源。

## 准备与触发

1. 按[版本管理](../doc/versioning.md)选择下一框架版本，通过 `node scripts/version.mjs set <版本>` 更新根版本并同步 manager、kit、auth、example 和文档。四个组件属于同一公共发布单元，不再独立升版。
2. 当前版本文档修改相邻 `.md.tmpl`，使用 `{{FRAMEWORK_VERSION}}`；执行 `node scripts/version.mjs sync`，把模板与生成的 `.md` 一起提交。历史版本说明和功能起始版本保持原值。
3. 新建 `doc/releases/vX.Y.Z.md`，写清变化、安装入口、兼容的宿主提交和实际验证过的内容和未验证项。归档不包含宿主、模型凭据或运行数据。
4. 执行 `node scripts/version.mjs check` 及相关验证，提交并推送公共 main，确认该提交的 Check 工作流通过。CI 只检查版本与文档是否同步，不替维护者改写文件。
5. 从这个已核验的公共提交创建带说明的标签并推送。先检出该提交，再读取根版本：

```sh
version=$(node -p "require('./package.json').version")
git tag -a "v$version" -m "发布公共框架 v$version" <已核验的公共提交号>
git push origin "refs/tags/v$version"
```

将占位符替换为完整提交号。标签必须对应根 `package.json` 的版本。不要给不同代码重复使用同一版本，也不要移动已发布的标签。定制插件与独立作者项目保持自己的版本，按各自的集成与交付流程更新。

## 工作流做什么

`runtime` 任务核验标签与统一版本，递归检出锁定的官方宿主源码，构建宿主层并装入本次唯一的 manager 归档，再向 GHCR 推送镜像。发布使用不可变摘要，并实际检查匿名拉取；首次 GHCR 包若仍为私有，需在 GitHub 包设置中改为公开后重试，不能交付只有发布账号能拉取的运行镜像。

`build` 任务复用 runtime 产出的同一 manager 归档，核验版本说明、冻结依赖、公共组件及生成文档，再执行检查、行为测试、独立安装包验证和仓库检查。仅打包公共 auth/example，生成无源码目录字段的 schema 2 清单。交付五个产物：manager tgz、kit tgz、public-apps ZIP、deployment ZIP、starters ZIP，另附覆盖五个产物的 `SHA256SUMS.txt`。部署包包含同一管理器、可选 auth 和固定镜像信息，起步包包含独立作者示例及相应 kit；public-apps ZIP 附版本说明。工作流只上传专用输出目录，不收集任意 `.local` 文件。

源码读取保持 `contents: read`；只有 runtime 任务授予 `packages: write` 以发布镜像。独立 `publish` 任务取得已构建附件、再次核对校验值，使用 GitHub 临时令牌及 `contents: write` 创建 Release；不向本地导出令牌，不需要个人访问令牌。Release 正文来自该标签内的版本说明。镜像构建、匿名拉取和归档检查不替代真实模型、浏览器或生产验收。

## 核验与失败处理

发布后核对标签实际提交、Release 是否公开、五个产物与摘要文件是否齐全，下载附件并核对校验值；确认部署包记录的镜像摘要可匿名拉取，再按交付说明验证所需的安装和使用方式。工具包名称不代表已经发布到 npm，GitHub 自动生成的 Source code ZIP 也不包含子模块源码。

工作流失败时先查看失败步骤和外部 Release 状态。构建失败可以对同一运行重试；如果已经创建 Release 或上传部分附件，先检查现有内容，不能盲目覆盖或重新移动标签。流程不自动删除既有 Release，也不使用 `--clobber` 覆盖附件。

GitHub CLI 发布参数见[官方文档](https://cli.github.com/manual/gh_release_create)。
