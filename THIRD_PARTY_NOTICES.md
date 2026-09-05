# 第三方来源

| 材料 | 来源与许可 |
| --- | --- |
| dsh-auth 的上游基础 | [taichuy/deepseek-harness-auth](https://github.com/taichuy/deepseek-harness-auth/tree/4464052fc1dcae45622cfcef6f9cbbbaaa6004a6)，Apache-2.0；改写后提供共享 WebServer、多用户和 SQLite 持久化，许可随插件交付 |
| 可选宿主子模块 | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，版本由 Git gitlink 锁定；适用其自身 LICENSE 与 NOTICE |
| npm 依赖 | 精确依赖见 `pnpm-lock.yaml`，各包保留自身许可证；分发安装闭包时一并保留相关声明 |

本仓库的 Apache-2.0 不替换第三方材料的原许可。宿主镜像从固定源码构建，包含的依赖与许可应随实际镜像版本核对。
