# 固定备份执行器

执行器使用 Python 3.6+ 标准库和 systemd，运行在服务器上。它只接受已配置的博客、图床、DSH、MinIO 和 MySQL 组件，不接受来自 HTTP 的路径、命令或 SQL。

从 `config.example.json` 创建服务器私有配置文件，要求 root 所有、权限 `600`。`pluginConfig` 指向本插件真正的 `config/config.json`；执行器从这里读取 `backup.token` 和管理员 ID 名单。站点账号密码仍由博客插件读取，不复制到第二套环境变量中。

配置项为绝对路径：站点、插件运行目录、官方 `attachments/v1`、MinIO 数据目录、备份/恢复/状态目录、PHP 和需要随站点保留的 Nginx 文件。源目录与备份目录必须分离。数据库名称从对应 PHP 应用配置中读取；固定 MySQL 容器需提供 `MYSQL_ROOT_PASSWORD_FILE`，密码只在容器内读取，不放在命令行中。

```sh
python3 /absolute/plugin/backup/install.py --config /absolute/private/executor.json
```

安装 `dsh-blog-backup-api.service`、`dsh-blog-backup-run.service`、`dsh-blog-backup-restore.service` 和 `dsh-blog-backup.timer`。默认北京时间 03:00，7 份日备份、4 份周备份；systemd Persistent timer 负责停机后的补跑。工作台调整计划后写入 systemd override，安装更新沿用已有计划。

写入者按原运行状态停止并验证：PHP-FPM、DSH 和 MinIO。数据库用 `mysqldump --lock-all-tables` 导出以覆盖 MyISAM；站点和对象在停写期间归档。完成或失败后恢复原先运行的服务，systemd 的 ExecStopPost 处理执行器异常退出。新任务先处理遗留恢复记录，操作锁避免并行。

归档带组件大小和 SHA-256 清单；归档链接限于内部相对路径，恢复前拒绝路径穿越、外部链接、特殊文件和超限展开。轮换只删除本执行器生成、通过校验且不在保留集合的完整备份；失败任务保留旧备份。

隔离恢复使用全新目录和数据库，原应用配置改名以阻断误连生产，不自动运行站点。生产恢复先生成保护备份，换入恢复文件并把博客连接到新的独立数据库，原数据库与旧目录保留。图床仅恢复指定策略的 images 记录及桶目录；现有用户、角色、相册和策略必须兼容，其他策略冲突时拒绝。官方附件按不可变引用补回，不清理或覆盖其他插件的数据。

生产恢复在执行前通过 DSH 的内部 Token 接口重新验证原用户和备份管理权限。停写后若过程失败，恢复日志用于回滚目录和指定策略图片记录，之后再恢复服务。检查恢复失败与 `recoveryPending`，不能将文件已解压等同网站已经恢复。

此执行器针对当前单机 Typecho 1.2.1、Lsky Pro 2.1 与单节点 MinIO 部署。数据库存储过程、事件、其他对象存储拓扑和新增 Lsky 策略需要先扩展一致性及恢复验证。仅同机保存不等于异机容灾。
