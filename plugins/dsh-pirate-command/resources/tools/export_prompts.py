# -*- coding: utf-8 -*-
"""从图像、音频各自的规范正文导出提示词；不调用生成服务，也不删除文件。"""
from pathlib import Path
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "prompts/当前美术素材规范与提示词.md"
AUDIO_SOURCE = ROOT / "prompts/当前音频素材规范与提示词.md"
text = SOURCE.read_text(encoding="utf-8") + "\n" + AUDIO_SOURCE.read_text(encoding="utf-8")
matches = re.findall(r"<!-- (asset|prompt): ([a-z0-9-]+) -->\s*```text\s*\n(.*?)\n```", text, re.S)


def write_text(path, content):
    with path.open("w", encoding="utf-8", newline="\n") as file:
        file.write(content)
assets = {key: body.strip() for kind, key, body in matches if kind == "asset"}
shared = {key: body.strip() for kind, key, body in matches if kind == "prompt"}
if len(assets) != sum(kind == "asset" for kind, _, _ in matches):
    raise ValueError("重复 asset ID")

CATEGORIES = {
    "ships": "pearl-layout-reference pearl-hull-deck pearl-front-rail pearl-mast-fore pearl-mast-main pearl-mast-aft rival-ship rival-foreground rival-damage-stages cannon-recoil deck-props figurehead-states".split(),
    "characters": [f"{person}-{action}" for person in ("jack", "barbossa", "elizabeth") for action in ("turnaround", "walk", "gestures", "tasks")] + ["monkey-actions", "enemy-crew"],
    "environment": "env-ocean-day env-ocean-storm env-ocean-moon water-displacement sea-foam-cycle fog-ribbons weather-lightning weather-rain".split(),
    "effects": "cannonball muzzle-flash cannon-smoke water-splash wood-impact hull-damage deck-fire battle-explosion magic-pulse".split(),
    "ui": "task-tokens compass-parts parchment-panels speech-bubble-parts".split(),
    "audio": "audio-ambient-sea audio-ambient-details audio-battle-cues audio-token-cues audio-scene-music audio-character-reactions".split(),
}
classified = [key for group in CATEGORIES.values() for key in group]
if len(classified) != len(set(classified)) or set(classified) != set(assets):
    raise ValueError(f"分类与正文不一致: {set(classified) ^ set(assets)}")

opaque = {"env-ocean-day", "env-ocean-storm", "env-ocean-moon", "water-displacement"}
chroma = {"cannon-smoke", "water-splash"}
non_generative = {"jack-turnaround", "jack-walk", "jack-gestures", "jack-tasks", "pearl-layout-reference", "rival-ship"}
reference_only = {"pearl-layout-reference", "rival-ship"}
processing = {
    "pearl-hull-deck", "pearl-front-rail", "pearl-mast-fore", "pearl-mast-main", "pearl-mast-aft",
    "rival-foreground", "rival-damage-stages",
    "barbossa-turnaround", "barbossa-walk", "barbossa-gestures", "barbossa-tasks",
    "elizabeth-walk", "elizabeth-gestures", "elizabeth-tasks", "monkey-actions", "enemy-crew",
    "water-displacement", "sea-foam-cycle", "fog-ribbons", "cannonball", "muzzle-flash",
    "wood-impact", "battle-explosion", "magic-pulse", "parchment-panels", "speech-bubble-parts",
    "audio-ambient-sea", "audio-ambient-details", "audio-battle-cues", "audio-token-cues",
    "audio-scene-music", "audio-character-reactions",
}
walk_poses = [
    "Walking in place, left foot forward contact and right foot behind, appropriate counter-swing of the free arms.",
    "Walking in place, left leg supports the body while the right leg passes underneath the hips.",
    "Walking in place, right foot forward contact and left foot behind, opposite limb arrangement to the left-foot contact frame.",
    "Walking in place, right leg supports the body while the left leg passes underneath the hips.",
]
gestures = [
    "Stationary friendly conversation, a small explanatory hand gesture, feet planted, no written speech bubble.",
    "idle gentle breathing", "alert and attentive", "waiting patiently", "stopped with a calm neutral posture",
]
placeholder_values = {
    "deck-props": {"[PROP]": ["chart table with blank map", "ship wheel on pedestal", "closed wooden barrel", "coiled rope", "small wooden crate", "handheld telescope", "paper and quill with ink pot", "small stack of iron cannonballs", "small ship lantern"]},
    "barbossa-walk": {"[DIRECTION]": ["SW"], "[WALK POSE]": walk_poses},
    "barbossa-gestures": {"[DIRECTION]": ["SW"], "[GESTURE]": gestures},
    "barbossa-tasks": {"[DIRECTION]": ["SW"], "[TASK POSE]": ["looking through a handheld telescope", "presenting one rolled parchment", "a small satisfied nod", "a brief disappointed reaction"]},
    "elizabeth-turnaround": {"[DIRECTION]": ["SW", "NW", "NE", "SE"]},
    "elizabeth-walk": {"[DIRECTION]": ["SW", "NW", "NE", "SE"], "[WALK POSE]": walk_poses},
    "elizabeth-gestures": {"[DIRECTION]": ["SW", "NW", "NE", "SE"], "[GESTURE]": gestures},
    "elizabeth-tasks": {"[DIRECTION]": ["SW", "NW", "NE", "SE"], "[TASK POSE]": ["writing on a held paper with a quill", "offering one small manuscript bottle", "a pleased completion gesture", "a thoughtful disappointed reaction"]},
    "enemy-crew": {"[CREW VARIANT]": ["red bandanna", "beige bandanna", "dark-brown tricorne without a plume"], "[POSE]": ["idle", "tricorne command", "beige brace"]},
    "task-tokens": {"[TOKEN]": ["silver coin with an apple emblem", "silver coin with a feather emblem", "rolled parchment with a restrained orange ribbon", "small manuscript bottle with a subtle purple glint"]},
    "compass-parts": {"[PART]": ["base", "needle", "lid", "damaged-base", "broken-tip", "broken-stem"]},
    "speech-bubble-parts": {"[TAIL]": ["right tail", "center tail", "no tail"]},
    "audio-ambient-details": {"[CUE]": ["wood_creak", "distant_gull"]},
    "audio-battle-cues": {"[CUE]": ["horn", "drum", "cannon", "impact", "splash"]},
    "audio-token-cues": {"[CUE]": ["coin", "paper", "bottle", "sword", "hourglass"]},
    "audio-scene-music": {"[CUE]": ["idle_sailing", "dispatch", "working", "aggregation", "victory_musicbox", "failure_low_clarinet", "waiting_neutral", "partial_neutral"]},
    "audio-character-reactions": {"[CUE]": ["monkey_alarm", "captain_sigh"]},
}
rows = []
for category, keys in CATEGORIES.items():
    folder = ROOT / "prompts" / category
    folder.mkdir(exist_ok=True)
    for key in keys:
        # UI、特效、海天和数据纹理使用各自正文；停用模板和像素提取任务不添加生成风格前缀。
        use_style = category in ("ships", "characters") and key not in non_generative and key != "rival-foreground"
        sections = ([shared["style-prefix"]] if use_style else []) + [assets[key]]
        if category != "audio" and key not in opaque and key not in non_generative:
            sections.append(shared["chroma-suffix" if key in chroma else "alpha-suffix"])
        content = "\n\n".join(sections) + "\n"
        target = folder / f"{key}.txt"
        write_text(target, content)
        found_placeholders = sorted(set(re.findall(r"\[[A-Z][A-Z ]*\]", content)))
        status = "inactive" if key in non_generative and key not in reference_only else "reference" if key in reference_only else "processing" if key in processing else "active"
        allowed = {name: placeholder_values[key][name] for name in found_placeholders if key in placeholder_values and name in placeholder_values[key]}
        rows.append({"id": key, "category": category, "file": target.relative_to(ROOT / "prompts").as_posix(), "status": status, "placeholders": found_placeholders, "allowedValues": allowed, "sha256": hashlib.sha256(content.encode()).hexdigest()})

folder = ROOT / "prompts/shared"
folder.mkdir(exist_ok=True)
for key, body in shared.items():
    write_text(folder / f"{key}.txt", body + "\n")
manifest = {"source": SOURCE.name, "sourceSha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(), "audioSource": AUDIO_SOURCE.name, "audioSourceSha256": hashlib.sha256(AUDIO_SOURCE.read_bytes()).hexdigest(), "count": len(rows), "imageCount": len(rows)-len(CATEGORIES["audio"]), "audioCount": len(CATEGORIES["audio"]), "generatedBy": "../tools/export_prompts.py", "assets": rows}
write_text(ROOT / "prompts/index.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

intro = """# 分类提示词

先读 [美术规范](当前美术素材规范与提示词.md)、[音频规范](当前音频素材规范与提示词.md) 和 [项目资源入口](../README.md)。本目录 TXT 从两类各自的规范正文导出，不另行维护设计；修改规范后，在插件根目录运行 `python resources/tools/export_prompts.py` 更新。脚本不调用任何生成接口。

`index.json` 的 `status` 含义：`active` 表示当前合同可制作但生成结果仍需验收；`processing` 表示素材/动作仍在补齐或复核流程；`reference` 表示已采纳母版状态说明，不要提交生成；`inactive` 表示缺少批准前置条件。

每个 TXT 本身就是完整复制用提示词，不再手工拼接共同前缀或交付后缀；船只与角色已包含共同风格前缀，环境、特效和 UI 的正文自带适用风格、机位或背景要求。海天不套透明背景，UI 和数据纹理不套船体透视。audio 类只输出声音正文，不添加图像风格或 alpha 后缀。含方括号的项目需先按 `index.json` 的 `allowedValues` 填入一个具体动作、方向、物件或声音，不能保留占位符或自造值；`status` 为 `inactive` 或 `reference` 的 TXT 不要提交生成。

炮烟 `cannon-smoke` 和水花 `water-splash` 默认带 [色键候选后缀](shared/chroma-suffix.txt)，与当前采纳的制作流程一致；输出仍需去底和实景复核。其他透明素材默认带 [透明后缀](shared/alpha-suffix.txt)；若工具不能真实导出 alpha，用 [色键候选后缀](shared/chroma-suffix.txt) 完整替换 TXT 末段。两类后缀不能并列放在同一次请求中，色键图也不能当作最终透明成品。

当前优先级以 [资源清单](../资源清单.md) 为准：主船 v02 与敌船去混 v02 已采纳，`pearl-layout-reference`、`rival-ship` 和四个 Jack TXT 只是状态说明，不要提交生成；优先补 Jack 母版、可自然行走的角色方向和同画布遮挡层。

| 分类 | 素材提示词 | 使用前填写 |
| --- | --- | --- |
"""
table = "\n".join(f"| {r['category']} | [{r['id']}]({r['file']}) | {', '.join(r['placeholders']) or '按正文附参考图'} |" for r in rows)
write_text(ROOT / "prompts/README.md", intro + table + "\n")
print(json.dumps({"exported": len(rows), "categories": {k: len(v) for k, v in CATEGORIES.items()}, "shared": len(shared)}, ensure_ascii=False))
