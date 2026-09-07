# 数据与产物迁移

新环境使用 `.local/data/` 与 `.local/artifacts/`。已有环境可显式选择原路径，迁移工具不会自动搬动数据、修改配置、启动服务或删除原源。

分别预览数据与发布产物：

```sh
node deploy/scripts/migrate-data.mjs --source data --target .local/data --backup /external/backup/data
node deploy/scripts/migrate-artifacts.mjs --source deploy-artifacts --target .local/artifacts --backup /external/backup/artifacts
```

预览检查路径、目录内容、空间需求与可复制性。源、目标和备份必须是真实路径且互不包含，目标和备份须为空。仓库内备份可放 `.local/backups/`，不能放发布目录。绝对链接、外部链接、pnpm 安装定位文件、原生依赖、未完成管理或镜像操作会阻止迁移；保持源完整，由原管理者准备可迁移副本并在目标重建安装。

Windows 的 8.3 短目录名按完整路径解析；源、目标、备份及其祖先目录中的符号链接或目录联接仍会阻止迁移。

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

工具先备份，再复制目标，核对清单、内容、链接和权限，Windows 同时复制与校验 ACL。ACL 比较仅忽略系统写入的 DACL 自动继承完成标记，仍核对所有者、组、权限条目和继承保护设置。源始终保留，失败时保留记录和已产生的副本。数据库停写后应连同 WAL 等关联文件复制，不能只挑主数据库文件。

复制成功后，显式更新部署配置和挂载路径，再验证原账号、历史、工作文件与插件配置。tgz、清单和历史操作记录保持原字节；旧记录中的绝对路径不批量替换。涉及旧路径或镜像 ID 的 resume/recover 继续使用原目录和匹配环境，目录副本不自动成为可恢复操作。

目标开始写入后，回退需要再次停写、保存新增数据并确认处理方式。不能直接切回旧副本丢弃新会话。原源和备份由维护者明确清理；普通 clean 保留所有运行数据和恢复产物。

## 已安装的容器 profile

完整安装目录包含 pnpm 定位文件，不能直接交给上述通用复制工具。由容器管理者停写并完整备份、复制和校验后，先核验 Node 版本、ABI、平台、libc 与挂载路径；有旧受管标记而无新版状态时，保留已安装文件，通过 `adopt --plugins <明确的 ID 列表>` 接管，再同步新归档。

pnpm 报 `ERR_PNPM_UNEXPECTED_STORE` 时，`--rebuild` 不会迁移既有 store 记录。停止目标副本的宿主，使用官方 CLI 的 `plugin --profile <profile> install --offline --store-dir <目标 store> --cache-dir <目标 cache> --config.force=true` 重装安装目录；全部依赖必须已在离线闭包中，业务数据和原备份保持完整。随后按原清单恢复管理器 pending，不能删除状态来绕过恢复检查。

容器在同步期间被终止可能留下锁。主机网络容器可能共享 hostname，但 PID 属于不同命名空间；不能据此推断原进程已退出。先核验原容器状态与所有重叠的可写数据挂载，保存停写证据及原锁，再处理遗留锁。改名备份后，旧容器仍记录原 bind 路径，回退必须恢复该路径或明确重建挂载。

采用统一配置时，数据迁移成功后修改私有 `.local/env.conf` 中的相应路径。旧JSON导入仅转换配置格式，不搬迁数据；保留原恢复记录及其绝对路径，不能用修改配置替代停写、备份、复制与校验。
