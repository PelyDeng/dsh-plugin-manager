# 开发约定

公共库位于 `packages/*`，业务插件位于 `plugins/*`。依赖方向和公开接口见 [doc/architecture.md](doc/architecture.md)。

- 修改前检查工作区，只提交任务文件。不得引入凭据、运行数据或生成产物；私有插件声明的 vendor 构建输入归档允许版本管理。
- 公共框架先在 GitHub 仓库修改、提交和推送，再从 upstream 合并；定制插件只提交 Gitee。仓库与许可范围见 [PRIVATE.md](PRIVATE.md)。
- 私有更新入口为根 `build.sh`、`build.ps1` 和 `private-deploy/`，通过公共 sourceRelease 在同一源码锁内快进 Gitee 的集成版本，再由新进程构建；GitHub 合并在私有集成库处理。保持公共 `deploy/*` 及公共部署文档与 upstream 一致，持有旧 flock 时不得再次调用公共 shell 入口。
- 版本规则：大功能新增或修改升级次版本并将补丁号归零（如 `0.4.1 → 0.5.0`）；小功能更新、优化或修复升级补丁号（如 `0.4.1 → 0.4.2`）。公共框架作为一个发布单元，根 `package.json` 的 `version` 是唯一版本源；manager、kit、auth、example 同步使用该版本，不再分别升级。通过 `node scripts/version.mjs set <版本>` 设置并同步，提交前执行 `node scripts/version.mjs check`。定制插件与独立作者项目保留自己的版本；官方宿主版本不随框架同步。未经用户明确指定不得发布 `1.0.0` 及以上里程碑版本。
- kit 不依赖管理器；管理器读取插件声明与归档，不导入业务源码。插件通过包名导入 kit，宿主运行实现保持外部依赖。
- 业务应用只通过官方 `dsh` profile 启动，管理器负责安装和运维。
- 项目路径由显式 root 解析，独立包不能从安装目录或 cwd 推测项目根。仓库入口仅转发参数。
- `.local/data`、`.local/artifacts` 及备份不得由 clean 删除。已有目录必须显式沿用或按停写、备份、复制、校验流程迁移，保留原源。
- 状态、锁和恢复规则只有一个实现；停写证据与锁分别核验，保护非受管依赖和用户 patch。
- 官方 `deepseek-harness` 子模块保持独立依赖树和锁定版本。普通构建不修改或下载宿主源码。
- 按变更执行构建、类型、行为测试和独立归档消费检查。真实宿主、模型替身、容器、浏览器和生产验证分别记录，不将跳过报告为通过。
- 含当前框架版本的文档以相邻 `.md.tmpl` 为编辑源，使用 `{{FRAMEWORK_VERSION}}`；运行 `node scripts/version.mjs sync` 更新已提交的 `.md`。历史版本与功能起始版本不替换。CI 只校验同步状态，不改写文件；完整规则见 [doc/versioning.md](doc/versioning.md)。
- 文档和注释描述当前行为、必要约束和使用方式，删除过时路径、讨论过程及重复说明。设计文档、开发计划、评审与验收记录等过程材料存放在 `.local/{项目名}/docs/{文档类型}/`，按“设计、计划、评审、验收”等类型分类，文件使用 `YYYYMMDD-HHmmss-中文文档名称.md` 命名，不提交 Git；个人博客和推广材料放在仓库外。`doc/` 只保留当前项目资料。提交前运行 `git diff --cached --check`。
- 要注意的是，本次使用的需要基于DSH插件生态来做，官方如果存在可复用的插件尽量不要自己造轮子
