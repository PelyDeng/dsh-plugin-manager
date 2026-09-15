# 使用 game-design MCP 辅助策划

`@chantezy/mcp-game-design` 在本机以 `game-design` 注册，固定版本为 `1.0.10`。它是开发时的策划辅助工具，不进入游戏运行依赖，也不属于业务员工的工具。

## 能做什么

工具读取随包工作流，由调用它的 AI 执行策划。包使用 MIT 许可证，没有独立模型服务；撰写仍沿用当前 AI 的额度或计费。来源见[项目源码](https://github.com/chantezy/game-skills)、[许可证](https://github.com/chantezy/game-skills/blob/main/LICENSE)与[npm 包](https://www.npmjs.com/package/@chantezy/mcp-game-design)。

1.0.10 提供 `list_skills`、`get_skill`、`get_reference` 三个工具，11 个技能正文可读。当前安装包没有附加参考文件，`dev-bridge-spec` 实测不存在；不能把接口名称当成资料已齐备的证明。

## 配置与核验

本机安装在用户目录 `.codex/mcp/game-design/1.0.10`，用 Node 的绝对路径启动包内 `dist/index.js`。在另一台 Windows 电脑可按下面方式配置：

```powershell
$gameMcpRoot = Join-Path $env:USERPROFILE '.codex/mcp/game-design/1.0.10'
npm install --prefix $gameMcpRoot --ignore-scripts --no-audit --no-fund --save-exact '@chantezy/mcp-game-design@1.0.10' --registry=https://registry.npmjs.org
$gameMcpEntry = Join-Path $gameMcpRoot 'node_modules/@chantezy/mcp-game-design/dist/index.js'
codex mcp add game-design -- (Get-Command node.exe).Source $gameMcpEntry
codex mcp get game-design --json
```

升级时重新核对流程和资料，不把 `latest` 的变化当成本项目新需求。应用尚未刷新工具列表时，按[官方 MCP 说明](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)检查连接状态。

接入核验已完成配置、标准 MCP 握手、工具列表及全部技能读取。当时通过 SDK 的 stdio MCP 客户端实际调用，没有把配置成功写成桌面列表已热刷新。原始调用记录在 `docs/08-工具与研究/MCP评估记录/source/calls.jsonl`。

## 在本项目中使用

先列技能，再按需要读取模块与 `game-full-workflow`。已确认的类型、平台、职责、状态和权限直接作为输入；不因模板建议重新发明玩法。项目自己的 Schema、原生工具和验收证据负责核验结果。

第二阶段的流程对照稿保存在 `docs/08-工具与研究/MCP策划过程/20260912-235301-MCP第二阶段全流程/`。正式规则维护在[玩法总览](../../../02-产品设计/02-机制/game_design.md)及其机制契约，不另立第二套 GDD；当前阶段进度见[设计总入口](../../../02-产品设计/README.md)，美术素材见[第三阶段交付](../../../02-产品设计/03-美术/README.md)。

当前策划输入为 office—street—cafe 三张地图，office 正在进行白色简约科技风、非对称布局翻新，包含开发部 9 工位及老板室、洽谈、卫生间、HR、行政前台与必要陈设。三名特殊NPC（业务员工）全在 dev，协议仍为 staff；四名正式普通职员进入 roster，与旧 examples 并存，无业务或模型工具。其素材、四向坐姿、8 帧性格动作和职责附近可见自主走动预览是本轮交付，不能由工具模板推迟。旧三图评审仅作翻新前基线，真实 DSH 业务接入另验；原始需求和历史流程材料保留原文。

模板中的战斗、经济、等级成长、通用引擎框架等不属于当前需求。NPC 的活动域由具体地图与规则确定，不套默认半径。文档、静态校验、游戏原型、模型授权和生产验证分别记录，不能互相替代。
