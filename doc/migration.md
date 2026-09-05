# 数据与产物迁移

新环境使用 `.local/data/` 与 `.local/artifacts/`。已有环境可显式选择原路径，迁移工具不会自动搬动数据、修改配置、启动服务或删除原源。

分别预览数据与发布产物：

```sh
node deploy/scripts/migrate-data.mjs --source data --target .local/data --backup /external/backup/data
node deploy/scripts/migrate-artifacts.mjs --source deploy-artifacts --target .local/artifacts --backup /external/backup/artifacts
```

预览检查路径、目录内容、空间需求与可复制性。源、目标和备份必须是真实路径且互不包含，目标和备份须为空。仓库内备份可放 `.local/backups/`，不能放发布目录。绝对链接、外部链接、pnpm 安装定位文件、原生依赖、未完成管理或镜像操作会阻止迁移；保持源完整，由原管理者准备可迁移副本并在目标重建安装。

应用时增加 `--apply --stopped-file <json>`。证据必须在 15 分钟内，绑定源与目标，覆盖全部写入者：数据包括 DSH、插件和数据库写入进程；产物包括构建、打包、推送与恢复任务。

```json
{
  "schemaVersion": 1,
  "source": "data",
  "target": ".local/data",
  "manager": "your-service-manager",
  "instanceId": "your-instance",
  "allWritersStopped": true,
  "stoppedAt": "填写实际 UTC 停写时间",
  "pids": []
}
```

工具先备份，再复制目标，核对清单、内容、链接和权限，Windows 同时复制与校验 ACL。源始终保留，失败时保留记录和已产生的副本。数据库停写后应连同 WAL 等关联文件复制，不能只挑主数据库文件。

复制成功后，显式更新部署配置和挂载路径，再验证原账号、历史、工作文件与插件配置。tgz、清单和历史操作记录保持原字节；旧记录中的绝对路径不批量替换。涉及旧路径或镜像 ID 的 resume/recover 继续使用原目录和匹配环境，目录副本不自动成为可恢复操作。

目标开始写入后，回退需要再次停写、保存新增数据并确认处理方式。不能直接切回旧副本丢弃新会话。原源和备份由维护者明确清理；普通 clean 保留所有运行数据和恢复产物。
