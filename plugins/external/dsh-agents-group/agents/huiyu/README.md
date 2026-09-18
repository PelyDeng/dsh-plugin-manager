# 绘语（huiyu）

图片智能体：看懂图片，也画得出图片。它是 `dsh-agents-group` 群组的成员之一，入口
`/agents/huiyu`，权限标识 `huiyu:access`。

**本子包没有独立的插件声明与发布入口**：目录条目、页面前缀与授权标识都由群组推导，
构建与打包通过 `--plugins agents-group` 完成。改动业务实现时不要引入独立的 `deepseekPlugin` 声明。

## 它能做什么

八个工具，按用途分三组。工具名统一 `huiyu_` 前缀，分类标签由群组从清单注入。

### 看懂图片

| 工具 | 什么时候用 |
| --- | --- |
| `huiyu_describe` | 用户问"这张图是什么""图里有什么" |
| `huiyu_extract` | 要逐字读图上的文字与数字：表格、发票、报表、截图 |
| `huiyu_compare` | 对比两张及以上图片的差异（2～4 张） |

### 画出图片

| 工具 | 什么时候用 |
| --- | --- |
| `huiyu_draw` | 通用出图，按文字描述生成 |
| `huiyu_cover` | 文章头图／封面图，横幅尺寸固定 |
| `huiyu_illustrate` | 给文章段落批量配图，返回建议插入位置 |

后两个用 `huiyu_draw` 加参数也能实现，单独开出来是为了**召回**：工具的召回靠描述文案，
"用户需要文章头图时用它"比让模型自己推理出"头图＝横幅图加提示词"可靠得多。
规矩是**只有参数组合固定、场景明确时才开专用工具**，否则一律用通用工具加参数。

### 素材

| 工具 | 什么时候用 |
| --- | --- |
| `huiyu_library` | 用户说"上次那张""再要一张差不多的"——生图要花钱，能翻出来就别重画 |
| `huiyu_upload` | 把用户上传的图登记进素材库，便于以后复用 |

## 识图为什么不自调视觉模型

宿主的工具结果支持**图片内容块**：工具返回 `{ type: 'image', attachment }` 之后，这张图会随结果
进入模型的下一轮上下文，**模型自己就看到了**。所以三个识图工具做的是"把图取出来交给这一轮"
并各自附上任务指引，而不是再开一次模型调用。

自调模型有三处更差：多一次计费、多一层要维护的模型选择与脱敏、而且**看不到用户的原始提问**
（用户问的是"这个报表哪里不对"，工具那一次调用拿不到这句话）。

## 图片在系统里怎么流动

| 场景 | 存放 | 访问方式 | 鉴权 |
| --- | --- | --- | --- |
| 生成图 | MinIO 专用桶 `huiyu` | `<HUIYU_PUBLIC_BASE_URL>/huiyu/<对象键>` 直链 | 无（公开可读） |
| 用户上传图 | 宿主附件存储 | `/agents/huiyu/images/<attachmentId>` | `huiyu:access` |

**用户上传的图不进 MinIO**：那是用户私有素材，进公开桶会造成数据泄露。所以读图路由要求鉴权，
并且把"不可读"与"无权访问"统一收成 404——区分它们等于给调用方一个探测他人附件的接口。

生成图落盘后**立刻丢弃字节**，对话里只留地址。base64 留在上下文里会被反复读、反复计费，
还会撑爆上下文。

## 生图渠道

生图走 `src/image/` 的 provider 接缝。宿主 `llm` 服务的模态枚举只有 `text` 与 `image`，
**且都是输入模态**——它没有"产出图片"这个概念，所以这层必须自建。

新增一家生图 API 时**只改 `src/image/index.ts` 的注册表一行**（外加它自己的实现文件）：
每家适配器自述 kind、展示名、"缺什么算不可用"和构造函数，注册表只按 kind 查表，
**没有 `if (kind === '某家')`**。

| kind | 协议 |
| --- | --- |
| `ciyuan-images` | 异步任务制：创建 → 轮询 → 下载（本站实际使用） |
| `openai-images` | 同步响应，`response_format: b64_json` |
| `ark-images` | 与 OpenAI 兼容族同协议，端点为火山方舟；**尚未真机验证** |

### 尺寸是"请求"，不是"结果"

工具接受 `square` / `landscape` / `portrait` / `banner` 或 `1024x1024` 这样的尺寸，但那只是
**向渠道提出的请求**。2026-09-18 在正式渠道上量过：

| 请求 | 实际交付 |
| --- | --- |
| `1024x1024` | `1536x1024` |
| `1536x1024` | `1536x1024` |
| `1536x864` | `1536x1024` |
| `1536x864`（线上那张头图，提示词不同） | `2048x768` |

结论：**这家渠道不按请求出图**，同一请求还可能给出不同比例。所以：

- 记录里的 `width`/`height` 与工具交回的文案，一律取自**交付的字节**（`media/size.ts` 的
  `deliveredSize` 读 PNG `IHDR` / JPEG `SOFn` / WebP `VP8X`）；
- 请求值留在记录的 `size` 里，渠道没照做时另写一行 `deliveredSize` 留痕；
- 认不出容器格式时**不写尺寸**——宁可不说，不能拿请求值冒充结果；
- 文案在两者不一致时会写明"渠道未按请求的 … 出图"，避免模型对用户承诺一个并不存在的比例。

## 配置

私有配置在**群组统一的那份 `env.conf`**（`plugins/external/dsh-agents-group/env.conf`），
本子包只认 `HUIYU_` 前缀的键。不给子包另建 `env.conf`。

```ini
# MinIO 对象存储：生图结果存放
HUIYU_MINIO_ENDPOINT=http://127.0.0.1:3101
HUIYU_MINIO_BUCKET=huiyu
HUIYU_MINIO_REGION=us-east-1
HUIYU_MINIO_ACCESS_KEY=***
HUIYU_MINIO_SECRET_KEY=***
# 外网访问前缀，与桶名拼成完整地址；必须是 img. 域而不是控制台域
HUIYU_PUBLIC_BASE_URL=https://img.pelycloud.com

# 生图 provider
HUIYU_IMAGE_PROVIDER=ciyuan-images
HUIYU_IMAGE_BASE_URL=https://img.ciyuan.fast
HUIYU_IMAGE_MODEL=gpt-image-2
```

**生图密钥不在这里**：它走 DSH 的凭据系统（`CIYUAN_API_KEY`），在模型设置界面维护，
装配时由 `ctx.credentials` 取出后注入 provider。这样它可轮换、不进私有库。
`HUIYU_IMAGE_API_KEY` 只为独立的开发环境保留——那里没有凭据服务。

两处地址**不要混**：`HUIYU_MINIO_ENDPOINT` 是内网 S3 端点（上传用），
`HUIYU_PUBLIC_BASE_URL` 是外网访问前缀（给用户看的地址）。从 endpoint 推导对外地址会把
`127.0.0.1:3101` 泄漏进对话。

`HUIYU_PUBLIC_BASE_URL` 必须是 `img.pelycloud.com`，不能用 `minio.pelycloud.com`——后者是
**控制台**，任何路径都返回它自己的页面（状态码 200、Content-Type 也像图片），拼出来的地址
在浏览器里"能打开但不显示图片"。

## 存储

图片本体在 MinIO，业务记录在群组单库、表按 `huiyu_` 前缀平铺（`huiyu_images`）。
版本行统一在 `dsh_schema_versions` 的 `huiyu` 行。

**运行期只核验不建表**：缺表报稳定码并指出该执行哪个脚本，不在启动时静默 `CREATE TABLE`。
新库由 `private-deploy/db/0001_init.sql` 一次建全；已建过库的站点用
`private-deploy/db/0002_huiyu.sql`（幂等补丁）补。

记录里同时存 `url` 与 `bucket`/`objectKey`：前者供排查直接看，后者在换域名后仍能拼出正确地址。
记录还含 `sessionId`/`messageId`——生成的图片**不进备份**，图丢了靠这两个字段定位回原会话重新生成。
