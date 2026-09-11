# 分类提示词

先读 [美术规范](当前美术素材规范与提示词.md)、[音频规范](当前音频素材规范与提示词.md) 和 [项目资源入口](../README.md)。本目录 TXT 从两类各自的规范正文导出，不另行维护设计；修改规范后，在插件根目录运行 `python resources/tools/export_prompts.py` 更新。脚本不调用任何生成接口。

`index.json` 的 `status` 含义：`active` 表示当前合同可制作但生成结果仍需验收；`processing` 表示素材/动作仍在补齐或复核流程；`reference` 表示已采纳母版状态说明，不要提交生成；`inactive` 表示缺少批准前置条件。

每个 TXT 本身就是完整复制用提示词，不再手工拼接共同前缀或交付后缀；船只与角色已包含共同风格前缀，环境、特效和 UI 的正文自带适用风格、机位或背景要求。海天不套透明背景，UI 和数据纹理不套船体透视。audio 类只输出声音正文，不添加图像风格或 alpha 后缀。含方括号的项目需先按 `index.json` 的 `allowedValues` 填入一个具体动作、方向、物件或声音，不能保留占位符或自造值；`status` 为 `inactive` 或 `reference` 的 TXT 不要提交生成。`referenceSets` 按路径和用途绑定当前母版、姿态或成品参考，`appliesTo` 说明仅在该占位符取值时适用。

炮烟 `cannon-smoke` 和水花 `water-splash` 默认带 [色键候选后缀](shared/chroma-suffix.txt)，与当前采纳的制作流程一致；输出仍需去底和实景复核。其他透明素材默认带 [透明后缀](shared/alpha-suffix.txt)；若工具不能真实导出 alpha，用 [色键候选后缀](shared/chroma-suffix.txt) 完整替换 TXT 末段。两类后缀不能并列放在同一次请求中，色键图也不能当作最终透明成品。

当前优先级以 [资源清单](../资源清单.md) 为准：主船 v02 与敌船去混 v02 已采纳，`pearl-layout-reference`、`rival-ship` 和四个 Jack TXT 只是状态说明，不要提交生成；优先补 Jack 母版、可自然行走的角色方向和同画布遮挡层。

| 分类 | 素材提示词 | 使用前填写 |
| --- | --- | --- |
| ships | [pearl-layout-reference](ships/pearl-layout-reference.txt) | 按正文附参考图 |
| ships | [pearl-hull-deck](ships/pearl-hull-deck.txt) | 按正文附参考图 |
| ships | [pearl-front-rail](ships/pearl-front-rail.txt) | 按正文附参考图 |
| ships | [pearl-mast-fore](ships/pearl-mast-fore.txt) | 按正文附参考图 |
| ships | [pearl-mast-main](ships/pearl-mast-main.txt) | 按正文附参考图 |
| ships | [pearl-mast-aft](ships/pearl-mast-aft.txt) | 按正文附参考图 |
| ships | [rival-ship](ships/rival-ship.txt) | 按正文附参考图 |
| ships | [rival-foreground](ships/rival-foreground.txt) | 按正文附参考图 |
| ships | [rival-damage-stages](ships/rival-damage-stages.txt) | 按正文附参考图 |
| ships | [cannon-recoil](ships/cannon-recoil.txt) | 按正文附参考图 |
| ships | [deck-props](ships/deck-props.txt) | [PROP] |
| ships | [figurehead-states](ships/figurehead-states.txt) | 按正文附参考图 |
| characters | [jack-turnaround](characters/jack-turnaround.txt) | 按正文附参考图 |
| characters | [jack-walk](characters/jack-walk.txt) | 按正文附参考图 |
| characters | [jack-gestures](characters/jack-gestures.txt) | 按正文附参考图 |
| characters | [jack-tasks](characters/jack-tasks.txt) | 按正文附参考图 |
| characters | [barbossa-turnaround](characters/barbossa-turnaround.txt) | 按正文附参考图 |
| characters | [barbossa-walk](characters/barbossa-walk.txt) | [DIRECTION], [WALK POSE] |
| characters | [barbossa-gestures](characters/barbossa-gestures.txt) | [DIRECTION], [GESTURE] |
| characters | [barbossa-tasks](characters/barbossa-tasks.txt) | [DIRECTION], [TASK POSE] |
| characters | [elizabeth-turnaround](characters/elizabeth-turnaround.txt) | [DIRECTION] |
| characters | [elizabeth-walk](characters/elizabeth-walk.txt) | [DIRECTION], [WALK POSE] |
| characters | [elizabeth-gestures](characters/elizabeth-gestures.txt) | [DIRECTION], [GESTURE] |
| characters | [elizabeth-tasks](characters/elizabeth-tasks.txt) | [DIRECTION], [TASK POSE] |
| characters | [monkey-actions](characters/monkey-actions.txt) | 按正文附参考图 |
| characters | [enemy-crew](characters/enemy-crew.txt) | [CREW VARIANT], [POSE] |
| environment | [env-ocean-day](environment/env-ocean-day.txt) | 按正文附参考图 |
| environment | [env-ocean-storm](environment/env-ocean-storm.txt) | 按正文附参考图 |
| environment | [env-ocean-moon](environment/env-ocean-moon.txt) | 按正文附参考图 |
| environment | [water-displacement](environment/water-displacement.txt) | 按正文附参考图 |
| environment | [sea-foam-cycle](environment/sea-foam-cycle.txt) | 按正文附参考图 |
| environment | [fog-ribbons](environment/fog-ribbons.txt) | 按正文附参考图 |
| environment | [weather-lightning](environment/weather-lightning.txt) | 按正文附参考图 |
| environment | [weather-rain](environment/weather-rain.txt) | 按正文附参考图 |
| effects | [cannonball](effects/cannonball.txt) | 按正文附参考图 |
| effects | [muzzle-flash](effects/muzzle-flash.txt) | 按正文附参考图 |
| effects | [cannon-smoke](effects/cannon-smoke.txt) | 按正文附参考图 |
| effects | [water-splash](effects/water-splash.txt) | 按正文附参考图 |
| effects | [wood-impact](effects/wood-impact.txt) | 按正文附参考图 |
| effects | [hull-damage](effects/hull-damage.txt) | 按正文附参考图 |
| effects | [deck-fire](effects/deck-fire.txt) | 按正文附参考图 |
| effects | [battle-explosion](effects/battle-explosion.txt) | 按正文附参考图 |
| effects | [magic-pulse](effects/magic-pulse.txt) | 按正文附参考图 |
| ui | [task-tokens](ui/task-tokens.txt) | [TOKEN] |
| ui | [compass-parts](ui/compass-parts.txt) | [PART] |
| ui | [parchment-panels](ui/parchment-panels.txt) | 按正文附参考图 |
| ui | [speech-bubble-parts](ui/speech-bubble-parts.txt) | [TAIL] |
| audio | [audio-ambient-sea](audio/audio-ambient-sea.txt) | 按正文附参考图 |
| audio | [audio-ambient-details](audio/audio-ambient-details.txt) | [CUE] |
| audio | [audio-battle-cues](audio/audio-battle-cues.txt) | [CUE] |
| audio | [audio-token-cues](audio/audio-token-cues.txt) | [CUE] |
| audio | [audio-scene-music](audio/audio-scene-music.txt) | [CUE] |
| audio | [audio-character-reactions](audio/audio-character-reactions.txt) | [CUE] |
