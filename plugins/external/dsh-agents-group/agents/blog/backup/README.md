# 固定备份执行器

执行器使用 Python 3.6+ 标准库和 systemd，运行在服务器上。它只接受已配置的博客、图床、DSH、MinIO 和 MySQL 组件，不接受来自 HTTP 的路径、命令或 SQL。

从 `config.example.json` 创建服务器私有配置文件，要求 root 所有、权限 `600`。`pluginConfig` 指向本插件真正的 `config/config.json`；执行器从这里读取 `backup.token` 和管理员 ID 名单。站点账号密码仍由博客插件读取，不复制到第二套环境变量中。

配置项为绝对路径：站点、插件运行目录、官方 `attachments/v1`、MinIO 数据目录、备份/恢复/状态目录、PHP 和需要随站点保留的 Nginx 文件。源目录与备份目录必须分离。数据库名称从对应 PHP 应用配置中读取；固定 MySQL 容器需提供 `MYSQL_ROOT_PASSWORD_FILE`，密码只在容器内读取，不放在命令行中。

聊天数据配置 `chat.sessionRoot`（官方 JSONL/zstd 在服务器上的根目录）与 `chat.cwd`（Session header 中的容器内工作目录）。会话目录与插件运行目录必须存在且互不包含。已有聊天数据但没有配置这些路径时，执行器拒绝生成不完整备份。评分和备注随会话日志保存；旧配置中的 `storageRoot` 不再使用。

离线 `chat-state.mjs` 只加载锁定的 DSH `0.1.5-alpha.2` 官方公开包，使用被备份 DSH 容器的不可变镜像 ID 启动一次性 Node 容器；即使原 DSH 已停止也可运行。原数据以只读挂载输入，唯一可写挂载是本次临时整理目录（staging），网络禁用；离线容器显式 UID 0 读取 root 私有备份，恢复发布时将聊天文件交还服务目录的 UID/GID。它不依赖原容器内的 `docker exec`，也不启动模型或业务宿主。

```sh
python3 /absolute/plugin/backup/install.py --config /absolute/private/executor.json
```

安装 `dsh-blog-backup-api.service`、`dsh-blog-backup-run.service`、`dsh-blog-backup-restore.service` 和 `dsh-blog-backup.timer`。默认北京时间 03:00，7 份日备份、4 份周备份；systemd Persistent timer 负责停机后的补跑。工作台调整计划后写入 systemd override，安装更新沿用已有计划。

写入者按原运行状态停止并验证：PHP-FPM、DSH 和 MinIO。数据库用 `mysqldump --lock-all-tables` 导出以覆盖 MyISAM；站点和对象在停写期间归档。完成或失败后恢复原先运行的服务，systemd 的 ExecStopPost 处理执行器异常退出。新任务先处理遗留恢复记录，操作锁避免并行。

归档带组件大小和 SHA-256 清单；归档链接限于内部相对路径，恢复前拒绝路径穿越、外部链接、特殊文件和超限展开。轮换只删除本执行器生成、通过校验且不在保留集合的完整备份；失败任务保留旧备份。

隔离恢复使用全新目录和数据库，原应用配置改名以阻断误连生产，不自动运行站点。生产恢复先生成保护备份，换入恢复文件并把博客连接到新的独立数据库，原数据库与旧目录保留。图床仅恢复指定策略的 images 记录及桶目录；现有用户、角色、相册和策略必须兼容，其他策略冲突时拒绝。官方附件按不可变引用补回，不清理或覆盖其他插件的数据。

`chat-state.tar.gz` 保存博客会话归属清单与官方 header、events、继承长度，评分、备注、版本和时间戳均保存在反馈事件中。逐会话通过官方 API 导出；每份最多 10,000 个会话、每会话 100,000 个事件和 64 MiB、总计 2 GiB，超限失败，不截断记录。恢复仅替换博客清单涉及的会话目录，其他插件和用户的会话保持原样。日志与 `blog.sqlite` 使用同一份恢复日志（journal）；失败时还原已替换或删除的目录，并撤出新建会话。旧备份缺少聊天组件而当前已有会话时拒绝恢复；auth 用户和权限不随博客恢复回退。

**归属清单来自哪张表，以及它的时间窗口**：索引库已经切到 PostgreSQL，会话行**不再写进 `blog.sqlite` 的 `conversations` 表**（那张旧表只读留存，不再更新）。离线容器网络禁用，读不到 PG，所以清单改从运行时的**本地镜像表** `conversation_mirror` 读——它是会话行的本地副本，带 `owner` 两列、`ready`、`deleted_at`/`removal_state` 与业务载荷，载荷里有恢复侧要核验的 `requestId`、`createdAt`、`sessionCreatedAt` / `openingAt`+`openingUntil`。**这个副本是"本实例启动收敛时读到的全量行"加上"之后它自己写过的行"，不是实时 PostgreSQL**：切换后新会话在镜像里出现的时机取决于运行时的启动收敛与写入路径。缺失 `conversation_mirror` 表（尚未被运行时建过）时清单为空，按"没有会话"处理；镜像行缺少 `requestId` / `createdAt` 时**拒绝**该条（归属不完整不许进备份）。

生产恢复在执行前通过 DSH 的内部 Token 接口重新验证原用户和备份管理权限。停写后若过程失败，恢复日志用于回滚目录和指定策略图片记录，之后再恢复服务。检查恢复失败与 `recoveryPending`，文件解压完成不代表网站已恢复可用。

SQL 导出不携带服务器级 GTID 状态，旧归档若包含 `GTID_PURGED` 会在创建恢复数据库前拒绝。正常备份要求引用的附件存在；恢复前的保护备份允许记录当前已缺失的附件，清单中的 `missingAttachments` 明确列出缺失项，以便从选定备份补回，同时保留其余当前状态。

此执行器针对当前单机 Typecho 1.2.1、Lsky Pro 2.1 与单节点 MinIO 部署。数据库存储过程、事件、其他对象存储拓扑和新增 Lsky 策略需要先补充对应的备份与恢复检查。仅同机保存不等于异机容灾。

会话快照 `schemaVersion` 为 2；恢复兼容 schemaVersion 1 的 V2/V3 日志及独立反馈行。转换复用管理器 `session-snapshot` 入口与官方 codec，先校验和迁移，再在隔离目录生成并复读原生日志；旧反馈的版本和时间戳保持不变。官方无法迁移的事件、会话归属或创建身份冲突、继承边界不一致会拒绝恢复。现存旧反馈文件需要在宿主升级时完成一次迁移，见框架 `doc/host-compatibility.md`。升级回退须使用停写后的完整数据备份和旧服务镜像。
