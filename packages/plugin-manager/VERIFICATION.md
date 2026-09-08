# 发布物验证记录

manager 0.3.3 在发布清单 1/2 顶层接受可选 `verification`。旧清单继续安装；旧管理器可能忽略该字段。插件声明仍为 schema 3，验证信息不写入 tgz，也不改变已测包的字节。

## 生成和交付

源码仓库可直接在根目录执行独立入口：

```sh
bash test-report.sh
# 使用已经构建的其他官方 CLI：
bash test-report.sh --cli /absolute/path/to/dsh/lib/bin.js
bash test-report.sh --help
```

该入口在 GitHub 和 Gitee 检出目录中行为一致，不更新 Git、不加载站点 env.conf、不执行部署。需要 Node.js `^22.19.0 || >=24`、框架锁定的 pnpm 和 tar。还需已构建的官方 DSH CLI；递归克隆只取得源码，不等于完成宿主构建。默认 CLI 缺失时，先按官方说明在 `deepseek-harness` 内使用其自身锁定的 pnpm 执行 `pnpm install --frozen-lockfile`、`pnpm run build`，或用 `--cli` 指定现有 CLI。脚本不会自动下载、更新或构建宿主。`--cli` 优先于已有 `DSH_TEST_CLI`，两者的相对路径均以框架仓库根目录为准。

Windows 不使用 Bash 时，在框架根执行 `node scripts/test-report.mjs --root .`，其余参数相同。根 `build.ps1` / `build.sh` 是源码部署入口，不替代这里的验证报告；macOS 构建部署流程尚无真机验收，不能由命令分支或归档测试推导为通过。

脚本先检查宿主可运行，再打包固定的 auth/example、执行下述宿主测试，全部成功才组合交付目录。每次新建 `.local/artifacts/test-report-<随机标识>/`，其中 `candidate/` 是被测归档、`report.json` 是报告、`delivery/` 是包含报告记录的交付清单和原样归档。任何阶段失败均非零退出，保留诊断，不继续后续步骤。测试数据独立保存在 `.local/data/acceptance/`，不清理已有运行数据。默认回环端口18951；占用时可设置 `EXAMPLE_TEST_PORT`，并行运行应使用不同端口。

范围是 auth/example 的真实宿主、归档消费与本地模型替身测试，不是所有业务插件、真实模型、浏览器或生产验收。开发者自己的插件需要自己的业务测试运行器。请交付本次 `delivery/`；随后运行部署构建入口重新打包的归档不自动继承本次报告。仅持有 manager tgz 的独立部署者使用下述 CLI/API，根脚本不包含在工具包中。

需要分别控制步骤时，使用同一流程的底层命令：

在框架根目录打包 auth/example，显式运行测试，再将报告附到新的发布目录：

```sh
pnpm package --plugins auth,example --output .local/artifacts/candidate
node plugins/dsh-example/tests/host-smoke.mjs .local/artifacts/candidate --report .local/artifacts/example-host-report.json
node packages/plugin-manager/src/cli.mjs compose-release --root . --manifest .local/artifacts/candidate/manifest.json --verification-report .local/artifacts/example-host-report.json --output .local/artifacts/delivery
```

测试入口需要已准备好的官方 CLI，默认 `deepseek-harness/apps/cli/lib/bin.js`，也可用 `DSH_TEST_CLI` 显式指定。它使用真实宿主和本地模型替身，不调用真实模型。每次使用新的报告路径和发布目录。`--verification-report` 可重复；普通 pack/deploy 不启动测试，不生成“已测宿主”结论。

部署者取得整个 delivery 目录。compose 校验输入记录及主包摘要，复制后再次核对 tgz；不重打包，不覆盖原发布物。补充报告需新建发布目录，不能原地修改已经进入部署/续跑流程的清单。`--previous` 只保留恢复需要的旧归档，不把旧包验收转移给新包。

独立测试运行器可从 `@dsh-plugin-manager/plugin-manager/verification` 导入 `verificationSubjects`、`verificationIdentity`、`writeVerificationReport`。在实际断言阶段记录最终归档与参与组合，全部断言和清理完成后才写报告。失败、跳过和中断不能留下本次 passed；写报告失败也必须非零退出。写入采用同目录临时文件及独占原子创建，输出文件必须不存在。

## 记录格式

清单中 `verification = { schemaVersion: 1, builds: [], runs: [] }`。输入报告为 `{ schemaVersion: 1, runs: [] }`，不含 builds 或 reportSha256。compose 对输入报告的原始字节计算 SHA-256，填入每条 run 的 reportSha256。原报告留在维护者验收目录，不随包自动复制；摘要不能替代原报告全文或数字签名。

| 记录 | 字段 |
|---|---|
| build | pluginId、archiveSha256、nodeVersion、packageManagerVersion，可选 lockSha256 |
| run | pluginId、archiveSha256、subjects、scenarioId、suiteId、finishedAt、outcome、scope、source、host、platform；可选 suiteRevision，导入后含 reportSha256 |
| subjects | 实际被测受管插件的 `{ pluginId, archiveSha256 }` 数组，包含主对象，ID 不重复 |
| host | kind 为 unknown/source/distribution；可选 version、identitySource（detected/declared）；source 可有 commit、dirty，distribution 可有 digest |
| platform | os、architecture、nodeVersion |

outcome 为 passed/failed/skipped。scope 为 archive-consumption、real-host、model-double、real-model、container、browser 或 production，一条仅表达一种范围。source 为 runner/maintainer，两者都是提供方声明，不是可信签名等级。suiteRevision 为实际套件入口字节的 SHA-256，不代表其完整依赖闭包。finishedAt 需要有效日期和时区。

单个输入报告最多 1 MiB；清单验证对象最多 4 MiB，builds 256 条、runs 1024 条、每项 subjects 128 个。拒绝未知字段、非法摘要/日期、超限、重复冲突和不属于本清单主归档的记录。记录不容纳运行配置、凭据、任意日志或命令行。

历史 subjects 不改写：A+B1 测试不能在组合 A+B2 后变成当前组合通过；分别测 A、B 不能合成 A+B 的验证。按主归档、subjects、scenario、suite/revision、scope、host/platform、source 分组，仅在同组选择最新完成记录。同组同时间结果矛盾则拒绝导入。最新 skipped 不表示历史失败已修复。

## 安装提示

提示输出到 stderr，CLI stdout JSON 保持可解析；synchronize 结果包含结构化 verification。未启用的主插件不参与判断，历史 subjects 保留。无包变动时也返回提示；development/link 的可变源码不能沿用 tgz 验收作为通过证明。

| 状态 | 含义 |
|---|---|
| unverified | 没有宿主记录、最新跳过，或当前为可变源码 |
| partial-match | 仅部分字段匹配，来源、场景等无法充分核对 |
| different-target | 已知宿主或平台字段不同 |
| different-context | 受管插件组合不同 |
| record-match | 提供方记录的可比较目标、组合和场景匹配；不表示当前机器已测 |
| reported-failure | 此组最新记录失败；同时列出目标匹配情况 |

普通安装不能推断第三方 suite 的 scenarioId，通常显示场景未核对；不会据此宣称完整匹配。源码 commit 需探测执行入口所属仓库；环境变量 SHA 不成为实测事实。编译 JS 与源码 commit 的对应关系未证实时按声明处理。容器不能核验自身镜像摘要时保持 partial/unknown，不读取 Docker socket。

所有结果都是建议，不增加版本不同或报告失败即阻断的门槛；原有完整性、依赖、环境变化/rebuild 和恢复约束仍有效。报告格式非法属于输入错误，会在安装变更前拒绝。验证信息不进入 desiredHash，不因补充记录触发重装。容器提示发生在旧容器停止后、新容器内安装插件前；不承诺整个容器更新开始前已有提示。

模型替身、真实模型、容器、浏览器、生产分别验收。健康探针不能证明业务问答可用，版本号相同不能保证所有接口或传递依赖一致。
