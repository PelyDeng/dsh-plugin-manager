# vendor：私有视频播放器构建输入

`hy-media-video-player-0.0.37.tgz` 是封闭化助手轨迹视图用的实时视频播放器（jessibuca 解码器 + Vue 封装）。

## 为什么随包交付

`@hy-media/video-player` **不在公共 npm registry 上**（`npm view @hy-media/video-player` 返回 404），也没有可引用的 Git 地址，所以 `package.json` 用 `file:vendor/hy-media-video-player-0.0.37.tgz` 声明它。按仓库根 `AGENTS.md`，私有插件声明的 vendor 构建输入归档允许纳入版本管理；这也是它唯一的分发方式。

## 怎么被用到

只在**构建期**用：`scripts/copy-web-assets.mjs` 把包内 `lib/` 拷进 `web/assets/video-player`，页面从 `/assets/video-player/...` 加载（`web/trajectory.js`）。`vendor/` 不在 `files` 里，不会随插件归档发布；最终产物里带的是拷出去的那份资源。

## 更新步骤

1. 放入新的归档并**按版本命名**（例如 `hy-media-video-player-0.0.38.tgz`）；文件名里的版本要与包内 `package.json` 的版本一致。
2. 同时改 `package.json` 的 `file:` 说明符，并确认页面里的资源查询串（`trajectory.js` 中的 `?v=`）同步更新。
3. 归档必须是**已纳入 Git 的普通文件**：按需复用的判定会核对旧新提交的 blob 与磁盘字节一致，并在归档或其父目录是符号链接时拒绝复用（未跟踪、目录形式、跨目录同样拒绝）。
4. 改动后跑一次 `pnpm --filter @dsh-agents-group/closedoff run build`，确认 `web/assets/video-player` 生成正确。

删除本目录会让 `closedoff` 无法构建，也会让「按需复用」失去可核验的构建输入。
