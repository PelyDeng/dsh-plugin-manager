# 资源分类

完整美术资料位于 `美术资源包/`，保留原制作工作区的目录结构，避免既有生成、校验和离线预览脚本失去相对关系。

## 最终交付

- `美术资源包/delivery/`：当前正式交付，包含角色、地图、UI、VFX、原生工程、预览页和校验清单。
- `美术资源包/dsh-niuma-boss-stage3-art.zip`：第三阶段完整交付压缩包。
- `美术资源包/delivery/index.html`：离线素材浏览器。
- `美术资源包/delivery/office-live/index.html`：办公楼活动预览。

## 制作过程

- `characters/`、`furniture/`、`maps/`、`office-tech/`、`street/`、`ui/`、`vfx/`：分类制作源与过程文件。
- `colored/`、`selected/`、`pixelorama/`：候选、获选结果和原生工程处理记录。
- `requests/`、`receipts/`：生成请求及回执，仅用于本机追溯，不作为运行时输入。
- `reviews/`、`package-validation/`：资源侧复核与封包校验。
- `references/`：制作参考资料。
- `scripts/`：美术生成、组装、预览和校验脚本。

整个 `美术资源包/` 已忽略 Git 提交。正式游戏构建只选取运行需要的素材，不把候选稿、回执、预览截图或原生编辑器工程打入插件安装包。
