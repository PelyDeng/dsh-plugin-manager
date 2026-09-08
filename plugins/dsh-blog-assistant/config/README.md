# 运行配置

复制 `config.example.json` 为同目录 `config.json`，填写博客和图床的地址、账号、密码。
地址使用 HTTPS origin，不带后台路径。图床 `strategyId` 选择实际允许的存储策略。
`image.token` 可选，填写后优先使用该 Token，失效时明确报错，不回退到其他账号。

`models.text` / `models.vision` 可选，分别指定文字写作和图片资料的 `{provider, model}`。
模板使用 `blog-zhipu/glm-5.3` 和 `blog-zhipu/glm-5v-turbo`，通过官方 pi-ai 适配器接入智谱普通模型 API。
API Key 统一在 auth“模型设置 → 智谱 GLM”保存到官方 credentials，不填入此文件。
旧配置省略 models 时沿用宿主默认模型；继续含图片的历史对话时，仍需使用支持图片的模型。缺少 Key 时会报错，不会悄悄换用其他配置。

正式环境在站点设置指定 `instances.blog.runtimeConfig` 为
`plugins/dsh-blog-assistant/config/config.json`。管理器将该文件只读挂载，
插件从 `BLOG_CONFIG_PATH` 指定路径解析 JSON；该变量只传路径，不传密码。
不需要、也不读取另一份 env.conf 凭据。更改后通过管理器重启生效。

实际文件不提交 Git、不进插件包或镜像。Linux 建议目录 750、文件 640，
仅部署者和服务运行组可读。已有文件不得由模板覆盖。
`backup.allowedUserIds` 为 auth 稳定用户 ID；空数组禁止所有交互备份管理。
运行 Token、草稿和任务保存在 DSH home，不写回此配置。
