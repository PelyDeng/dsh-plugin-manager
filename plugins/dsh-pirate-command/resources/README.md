# 黑珍珠号资源入口

本目录集中保存黑珍珠号 Agent 指挥台的素材与提示词。项目做什么、角色分工、视觉要求、开发规则及新资源采纳归档规则，统一读插件根目录的 [AGENTS.md](../AGENTS.md)。

本目录位于私有 Gitee 插件内，是当前唯一制作入口。公共框架中的旧插件与原型工作目录已迁入私有归档；旧路径只在历史记录中保留，不再作为制作或运行入口。

资源导航、清单、变更记录和 prompts/ 当前提示词随插件进入 Git；sources/、processed/、previews/、	ools/ 和 rchive/ 中的大体积原始图、候选、运行产物和历史归档默认仅保存在本机。

## 从哪里开始

| 需要了解的内容 | 入口 |
| --- | --- |
| 项目说明与协作要求 | [AGENTS.md](../AGENTS.md) |
| 当前有哪些素材、哪些仍缺 | [资源清单](资源清单.md) |
| 提示词状态与取值 | [分类索引](prompts/README.md)与 [index.json](prompts/index.json)：53 项提示词含 `status`、`allowedValues` 和 `referenceSets`；`inactive/reference` 不提交生成，`processing` 只按索引绑定的当前母版、姿态或成品参考制作；本地资源工作区运行 `node resources/tools/audit_prompts.mjs` 会同时校验参考图存在，干净源码检出则只校验提示词合同与索引 |
| 美术生成工具边界 | GLM-5.3 是文本模型；GLM-5V-Turbo 可看图输出文字评审，不能生成最终 PNG。当前低空海雾 v01 已用词元.fast 异步接口的 `gpt-image-2` 生成并后处理；密钥、Authorization 和临时下载 URL 不进入资源记录。后续仍需参考图、蒙版、同画布编辑和真实 alpha/色键校验 |
| 最小美术资源链路 | [低空海雾 v01](资源清单.md)：一次 `gpt-image-2` 生成、透明后处理、三雾条运行时挂载、减少动态静止与聚焦测试已打通，[浏览器记录](previews/scene/2026-09-11T20-36-57-251Z-fog-ribbons-v01/result.json)通过；`0.1.1` 归档清单见[本地发布目录](../../../.local/dsh-pirate-command/host-integration/preparations/20260912-043802-pirate-fog-min/manifest.json)。这是最小链路验收，不代表完整美术或音频完成 |
| 最近安装包与验证范围 | [195731 四包归档与安装](../../../.local/dsh-pirate-command/host-integration/preparations/20260911-195731-mobile-scene-joint/installed-verification.json)：Pirate `4d250d3c`（DjOeAn9k/BflD）+ 固定 Auth `9fdce84f`、Blog `edbd3ae4`、Closedoff `f377f818`，615 个安装文件逐字节一致，并已通过[五视口浏览器验收](../../../.local/dsh-pirate-command/docs/验收/20260911-200229-DjOeAn9k新包安装与窄屏场景浏览器验收.md)；旧 Ch619 包保留[封闭化真实协作](../../../.local/dsh-pirate-command/docs/验收/20260911-123507-封闭化真实协作与新包页面验收.md)与[双业务联合只读](../../../.local/dsh-pirate-command/docs/验收/20260911-195219-双业务真实联合只读与原页面验收.md)证据 |
| 最新窄屏构建验收 | `index-DjOeAn9k.js` 已进入 `4d250d3c` 新包并通过[安装与五视口浏览器验收](../../../.local/dsh-pirate-command/docs/验收/20260911-200229-DjOeAn9k新包安装与窄屏场景浏览器验收.md)：竖屏按完整船体填宽并保留首尾桅顶、颠簸船底余量，横屏保留原缩放定位；几何边界由 46 项场景聚焦测试、安装字节与运行由 85 项浏览器检查分别证明 |
| 当前包本地任务流 | [80 项浏览器检查](../../../.local/dsh-pirate-command/docs/验收/20260911-204500-DjOeAn9k当前包本地任务流浏览器验收.md)已在 `4d250d3c` 包内完成模型选择、双业务替身派单、waiting/completed 混合、成果链接、追问不重派、键盘罗盘、面板开合、岗位切换、历史恢复、模型刷新、长错误滚动、桌面和窄屏控件可达、减少动态、音效开启与新协作清理；真实模型/业务仍另有边界 |
| 当前包恢复浏览器验收 | [68 项恢复检查](../../../.local/dsh-pirate-command/docs/验收/20260911-211500-DjOeAn9k当前包68项恢复浏览器验收.md)：ACK 丢失、原请求重试、断线重连、宿主重启 interrupted、显式继续、401/403/404 与有界路由重试均在 `4d250d3c` 包内通过；身份/模型/业务仍为本地替身 |
| 当前包真实只读联合 | [DjOeAn9k 双业务真实只读验收](../../../.local/dsh-pirate-command/docs/验收/20260911-214000-DjOeAn9k当前包双业务真实只读联合验收.md)：6 次真实模型、1 次博客 ranking、3 次封闭化网关请求，业务写入 0；39 项技术检查与父语义复核通过 | 不覆盖博客写入/发布、封闭化其他工具、完整海战或全部素材 |
| 当前包博客确认发布链 | [47 项本地替身浏览器检查](../../../.local/dsh-pirate-command/docs/验收/20260911-215500-DjOeAn9k当前包博客发布确认本地替身验收.md)：候选、原生确认、一次本地发布、刷新恢复与原 Agent 读回通过；真实模型/业务请求 0 | 不证明真实 Typecho 写入、公网文章发布或生产副作用 |
| 真实 Typecho 写入回滚 | [18 项真实写入验收](../../../.local/dsh-pirate-command/docs/验收/20260911-223000-DjOeAn9k真实Typecho写入发布回滚验收.md)：10 次桥接调用完成空稿、标记正文、发布、公开页读取与删除；模型请求 0，未注册外联 0 | 桥接回执、服务器日志或缓存可能留痕；不覆盖 SEO、邮件、feed、评论、附件或管理写入 |
| 当前本地前端与验证边界 | 先看[资源清单的接入与验证范围](资源清单.md#当前接入与验证范围)，分别列出本地场景、官方宿主安装包及真实业务证据；版本与限制在该处维护 |
| 最近的访问清理与原插件会话修复 | [模型目录拒权清理](../../../.local/dsh-pirate-command/docs/验收/20260911-074839-模型目录拒绝访问清理验收.md)、[两原插件会话深链同步](../../../.local/dsh-pirate-command/docs/验收/20260911-074339-原插件会话深链同步修复.md)及[原会话提前入口](../../../.local/dsh-pirate-command/docs/验收/20260911-083251-原会话提前回跳与停止后保留验收.md)已进入旧 085923 并保留在[当前组合](../../../.local/dsh-pirate-command/host-integration/preparations/20260911-123404/combination-final-summary.json)；旧专项不计为本次重新验收 |
| 最近一次真实博客只读验收 | [修正后两页复验](../../../.local/dsh-pirate-command/docs/验收/20260911-065354-博客统计修正真实两页复验.md)：新博客 0c9c 包，6 次真实模型、2 次元数据查询；原工具及两个 Agent 均正确区分本次保存稿计数 0 与关联标记。船长有一条不适用于满页结果的分页提醒，保留为措辞限制；写入、封闭化和完整业务终验未通过该专项 |
| 最近一次封闭化真实只读验证 | [123507 原 Agent 字典协作与页面验收](../../../.local/dsh-pirate-command/docs/验收/20260911-123507-封闭化真实协作与新包页面验收.md)：26 项整体技术检查、5 次真实模型和 3 次网关请求通过，原 Agent 与船长保留本次 34 条字典范围；其他业务、原 Closedoff 页面及完整美术不在本次范围 |
| 伊丽莎白后续动作的参考图 | [四向空手站姿制作母版](sources/characters/elizabeth-directions-v01/README.md)，已选定比例与方向；当前页面仍使用原持纸动作 |
| 巴博萨后续动作的参考图 | [SW 空手无猴子站姿制作母版](sources/characters/barbossa-standing-v01/README.md)，已选定单一方向；当前页面仍使用原持苹果和带猴子的动作 |
| 敌方船员动作参考 | [三名站姿及固定站位](tools/adoption/enemy-crew-standing-layout-v02.json)，以及[发令和护耳固定体尺合成](previews/ships/enemy-upper-body-actions-v01/ship-idle-action-400x300-dark-light.png)。从各自母版衍生，每次只做一个姿态；装填与完整循环仍缺，当前状态见资源清单 |
| 空敌船与后续遮挡层的制作基准 | [空船去混 v02 制作母版](tools/adoption/enemy-empty-production-master-v02.json)与[实际几何校准](tools/processing/enemy-geometry-v02/calibration.json)，1448×1086、运行 512×384；已连同三名独立船员及窄前景接入。原尺寸细边限制保留，后续变体保持同画布同原点 |
| 独立猴子后续动作的参考图 | [SW 中立坐姿制作母版](tools/adoption/monkey-standing-master-v01.json)与[单张报警关键帧](tools/adoption/monkey-alarm-keyframe-v01.json)均已采纳，同用 0.12 缩放对照巴博萨 128px；已有 sit＋alarm，尾摆、报警过渡／恢复、投掷与运行时接入仍缺 |
| 伊丽莎白动作候选的缺帧与重做要求 | [NE / NW 独立动作复核](tools/processing/elizabeth-actions-review-v01/README.md)，两方向均未通过完整循环，先核对左右腿关键帧 |
| SW 行走的左右侧与接触姿态 | [已修正的四帧几何引导](references/characters/sw-walk-pose-guide-v01/README.md)，蓝色人体左侧较近、红色人体右侧较远；只约束肢体姿态，不代替角色母版 |
| SW 四姿态的连续检查 | [可暂停、逐帧和切换明暗底的预览](previews/characters/elizabeth-sw-guided-cycle-v01/walk-cycle.html)与[使用说明及复核结论](tools/processing/elizabeth-sw-guided-cycle-v01/README.md)；支撑腿已交替，但 03 下肢体尺和 01/03 通过姿态仍不一致，未进入运行时 |
| SW 母版变形诊断 | [16 帧小步预览](previews/characters/elizabeth-sw-mesh-raster-v01/walk-cycle.html)与[纹理修复对照](previews/characters/elizabeth-sw-mesh-raster-v01/renderer-comparison-phase00-dark-light.png)：支持暂停、逐帧、明暗底和相对地面。当前运行图未替换；旧切片断口、网格斜纹与新栅格结果分别见[资源清单](资源清单.md#sw-行走诊断) |
| SW 小步与真实导航速度的差异 | [甲板采样分析](previews/characters/elizabeth-sw-deck-diagnostic-v01/2026-09-10T21-43-04-197Z/contact-analysis.json)复现固定周期滑步；距离驱动步频过快，[大步幅候选](previews/characters/elizabeth-sw-stride-study-v01/contact-body-about-128-dark-light.png)又出现深蹲与靴筒折叠，均未采纳。按[动作交接](../../../.local/dsh-pirate-command/docs/验收/20260911-060656-SW甲板滑步诊断与动作交接.md)重做关键姿态，不能直接把这批 16 帧当作运行成品 |
| 新绘制的 SW 左前接触姿态 | [单帧来源与制作说明](sources/characters/elizabeth-sw-contact-v02/README.md)及[小尺寸明暗对照](previews/characters/elizabeth-sw-contact-v02/standing-contact-v03-body-about-128-dark-light.png)。从站姿和结构参考编辑，保持统一体尺；这是单张候选，后足接地和完整循环待验证，未替换运行图 |
| SW 右前接触的相位与体尺诊断 | [失败原因与下次制作入口](sources/characters/elizabeth-sw-right-contact-v01/README.md)：初稿重复左步，纠正稿相位正确但头脸肩胸比例不匹配；两张原图按字节归档，未去底或接入。先保持头部、躯干一致，再制作相反腿链 |
| 从左步编辑与固定躯干拼接的失败归档 | [一次编辑的来源](sources/characters/elizabeth-sw-right-from-left-v01/README.md)仍出现肩胸比例差异；[单次合成](tools/processing/elizabeth-sw-right-composite-v01/report.json)有明显关节缺口和断臂观感。两批 15 张 PNG 已按原字节移至[失败归档](archive/20260911-sw-right-edit-composite-rejected-v01/README.md)，原脚本只校验归档后退出；不作为右步或动作母版继续制作 |
| 母版、画布、方向、透明度与动作要求 | [当前美术素材规范与提示词](prompts/当前美术素材规范与提示词.md) |
| 声音文件、循环与音频制作要求 | [当前音频素材规范与提示词](prompts/当前音频素材规范与提示词.md) |
| 角色动作制作前先读 | [本轮交付约束修正](archive/20260911-character-prompt-handoff-contract-v01/result.json)：Jack 模板因缺母版停用；全身不裁切且允许自然遮挡；行走按当前船坐标 54/105 单位/秒和固定体尺验收。规范与全部分类 TXT 已同步，未改变运行素材 |
| 直接复制单项提示词 | [分类索引](prompts/README.md)，图区与音频区分别列出 |
| 当前构图 | [主船 v02 朝向与贴底合成](previews/ships/pearl-yaw-v02/layout/after.png)、[风格参考](references/战斗构图.png)、[用户布局草图](references/用户草图.png)；实际接入状态见资源清单 |
| 新增船首像与罗盘部件 | [船首像及实际眼光对照](previews/ships/figurehead-v01/figurehead-A-eye-actual-size-comparison.png)、[罗盘部件处理记录](tools/processing/compass-states-v01/README.md)；具体制作要求见美术规范第 8.3、8.8 节 |
| 失败场景的火焰循环 | [四帧明暗底](previews/effects/deck-fire-cycle-v01/deck-fire-cycle-contact-v01.png)、[实景验收](previews/scene/2026-09-10T09-44-30-048Z-fire-cycle/result.json)与[采用记录](tools/adoption/deck-fire-cycle-v01.json)；固定基部，历史不补播，减少动态隐藏 |
| 炮弹命中与落水的位置 | [接触区记录](tools/adoption/projectile-contact-v01.json)保留船壳命中与船边海面的分区；新水花按实际基盘中心定位，旧单帧原点只用于历史裁片 |
| 炮烟与落水四相位 | [炮烟 v03 的 96px 明暗底](previews/effects/cannon-smoke-cycle-v03/contact-96-dark-light.png)与[水花 v02 的 96px 明暗底](previews/effects/water-splash-cycle-v02/water-splash-contact-96-v02.png)，已[采纳到本地](tools/adoption/shot-effects-sequence-v01.json)，固定画布、单次播放；[54 条第二轮浏览器检查](previews/scene/2026-09-10T11-56-32-603Z-shot-effects-sequence/result.json)通过，四相位与四炮位实看完成。局部人物/桅杆遮挡、RGB 色键估计及细边限制见[当前清单](资源清单.md) |
| 炮烟与人物、桅杆的前后关系 | [每炮独立深度层](tools/adoption/muzzle-depth-v01.json)保持世界位置与 96px 大小，当前[四炮实景](previews/scene/2026-09-10T13-22-46-910Z-shot-effects-sequence/result.json)已通过局部复核。前端已进入 21:46 新海盗归档；真实博客记录不代替烟水实景验收，旧包的四包页面记录保留其固定构建范围 |
| 固定四包的页面主动操作 | [38 项浏览器操作验收](../../../.local/dsh-pirate-command/docs/验收/20260910-212901-固定四包浏览器主动操作验收.md)覆盖发送、模型切换、补充、停止、历史和窄屏发送；使用本地模型与业务替身，固定入口为 `index-BrqTmnWi.js`，不覆盖其后的炮烟层级改动 |
| 哪些新图或方向被采纳、替代了什么 | [资源变更记录](资源变更记录.md) |
| 文件属性与整理证据 | [文件检查](tools/asset-inventory.json)、[迁移记录](tools/migration-map.json) |

## 分类目录

| 目录 | 内容 |
| --- | --- |
| `prompts/` | 当前规范、分类提示词与导出索引 |
| `references/` | 当前构图和布局参考 |
| `sources/` | 工具返回的原始素材 |
| `processed/` | 去底、裁切、对齐后的候选素材 |
| `previews/` | 明暗底、实际显示比例、逐帧或合成检查图；`audio/` 保存试听和波形检查 |
| `tools/` | 素材处理、导出和检查工具及记录 |
| `archive/` | 旧稿、失败候选、旧提示词及来源记录 |

素材按 `ships`（船与火炮）、`characters`（角色）、`environment`（海天）、`effects`（特效）、`ui`（界面装饰）、`audio`（声音）分类。音频源码合成检查与实际音频文件交付分开记录；实际数量、试听入口与验收状态只在资源清单维护。

并行制作结束后，若只增加源图、候选和参考图，可在插件根运行 `python resources/tools/rebuild_asset_inventory.py --resources-root resources --local-assets-root web/public/assets --metadata-only` 更新库存。工具核对运行图片未变并保留旧验收范围；运行时发生变化时不能用这个模式沿用证据。换图的完整清点会保留独立音频证据，但不会把旧前端身份当作新验收，须显式记录新构建及范围。

船首像及眼光是独立图片，罗盘盖子、损坏盘和断针与底盘共用坐标；原始制作记录保留其当时的候选状态，当前采纳与验收以资源清单为准。船帆公开主题由应用动态排版，不是需要生成的任务文字图片，也不增加图像模板数量。

## 旧工作区说明

旧原型目录已迁到私有仓库 `.local/dsh-pirate-command/archive/20260909-public-boundary/public-local/`，其中 `art-assets`、`art-processing` 兼容链接指向本目录的 `archive/legacy-20260909/`。公共仓库中的原目录已不存在。

旧 `image2-assets/` 工作目录现位于本目录的 `archive/20260909-public-boundary/image2-assets/`，保留生成回执；较早的提示词与已返回图片快照位于 `archive/legacy-image2/`。归档或快照不代表原任务结束或素材验收通过。当前制作使用上面的规范与分类索引。
