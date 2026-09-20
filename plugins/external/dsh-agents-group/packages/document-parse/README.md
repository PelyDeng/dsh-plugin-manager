# @dsh-agents-group/document-parse

把一份文件变成可读文字的工具集。

## 四件工具

| 工具 | 入口 | 产出 | 依赖 |
| --- | --- | --- | --- |
| 纯文本 | `parseTextDocument`（`./text`） | 按行 | 无 |
| PDF | `parsePdfDocument`（`./pdf`） | 按页（文本层） | `pdfjs-dist` |
| DOCX | `parseDocxDocument`（`./docx`） | 按段 | `yauzl` + `mammoth` |
| 图片 | `readImageDocument`（`./image`） | 一段文字 | 一个支持图片的模型（调用方注入） |

四者互相独立、可以单独导入，产出**同一种形状**（`ParsedDocument`），调用方不必分类型处理。

分成四个而不是一个"万能解析器"，是因为它们的代价与失败方式完全不同：纯文本零依赖、PDF/DOCX
要装库、图片要调模型花钱。混在一起，只想读 txt 的调用方也得为另外三条路买单。

还有一个分派器 `parseDocument({ name, bytes })`：按字节判定种类后转给对应工具，给"用户随手丢了
个文件进来"这种不知道是什么的场合用。它不做任何解析本身。

## 谁在用

- `plugins/external/dsh-butler-console`（牛马聊天群）：输入框上传附件时解析，结果进管家的
  提示词与派单简报。
- `plugins/external/dsh-agents-group`：各子 Agent 的聊天页面预期复用。

包名里的 `@dsh-agents-group/` 是**物理寄放位置**（私有共享包只能落在
`plugins/external/<项目>/packages/<包>` 这一层），不代表管家依赖了群组业务。真正的依赖方向是
"两边都依赖同一个共享包"。它被消费方在构建期内联，运行时的归档里不留 `workspace:` 依赖。

## 用法

```ts
import { parsePdfDocument, renderDocumentText, describeDocument } from '@dsh-agents-group/document-parse/pdf'

const parsed = await parsePdfDocument({ name, bytes }, { limits: { maxBytes: 16 * 1024 * 1024 } })
// { kind: 'pdf', unit: '页', units: [{ number, text }], totalUnits, characters, partial }

const { text, truncated } = renderDocumentText(parsed, 20000)
const scale = describeDocument(parsed)   // 「前 30 页，共 240 页，12480 字」
```

读图多一步——它要一个模型调用，由调用方注入：

```ts
import { readImageDocument } from '@dsh-agents-group/document-parse/image'

const parsed = await readImageDocument({ name, bytes, mediaType }, async ({ bytes, mediaType, prompt, signal }) => {
  // 这里是调用方自己的模型连接；本包不持有任何凭据或路由。
  return await callVisionModel({ bytes, mediaType, prompt, signal })
})
```

第三方依赖用**变量说明符**动态 `import()`，消费方要自己声明：

```json
{ "dependencies": { "mammoth": "1.12.2", "pdfjs-dist": "6.3.289", "yauzl": "3.4.0" } }
```

没装就报 `unavailable`，插件照常装载，不会因为缺一个可选依赖起不来。

## 失败分类

一律抛 `DocumentParseError`，按 `code` 分支：

| code | 含义 | 该怎么处置 |
| --- | --- | --- |
| `empty` | 一个字节都没有 | 400 |
| `too_large` | 超过 `maxBytes`，或归档展开后超限 | 413 |
| `unsupported` | 这类格式读不出文字 / 走错了工具 / 图片没给读图调用 | 保存原文件 + 告知用户 |
| `unavailable` | **依赖没装或模型调用失败**（不是文件的问题） | 503 或降级；这是部署问题 |
| `corrupt` | 文件结构不符合它的格式 | 400 |
| `encrypted` | 加密，或带宏（主动拒绝） | 400 |
| `no_text` | 格式对但没有文字（扫描件 PDF、纯色图片） | 保存原文件 + 提示先 OCR |
| `timeout` / `aborted` | 超时间预算 / 调用方中止 | 由调用方决定 |

`isDocumentParseError(value)` 在跨打包副本时也能认（不只看 `instanceof`）。

## 种类判定：先看字节，再看扩展名

1. 字节里有容器特征（图片、`%PDF-`、zip）→ **以字节为准**，扩展名说了不算；
2. 字节没特征、扩展名是认识的文本类型 → 用扩展名给更细的种类（csv 与 markdown 的字节形态一样，
   只能靠名字区分）；
3. 都不认 → 按 UTF-8 试着解一次，解得开且没有 NUL 就当纯文本，否则 `binary`。

第 3 条是兜底不是猜测：它只说"这是一段文字"，不假装知道是 csv 还是日志。

## 图片为什么走视觉模型，不自己 OCR

| 方案 | 离线 | 依赖体积 | 中文/截图/表格 | 速度 |
| --- | --- | --- | --- | --- |
| **视觉模型（本包的做法）** | 要能连模型 | 0 | 最好，还能说清"图里是什么" | 一次调用 |
| `tesseract.js` | 可以 | core wasm + 中文训练数据要 vendor 进插件，15–25 MB | 只有逐字识别，混排一般 | 几秒到几十秒 |
| 原生 tesseract / PaddleOCR | 可以 | 容器里装系统二进制或 Python | 最好 | 快 |

第三行排除：插件不能自带系统二进制，跟"纯 JS、无原生构建"冲突。第二行的问题是**它只做 OCR**，
读不出"这张图是什么"，而截图、流程图、产品照片的价值往往全在后一半；体积和速度也谈不上"快速"。

另外：**当前对话模型本身支持图片时，根本不该调这个工具**——图片作为消息的一部分直接发给模型
就行。`readImageDocument` 服务的是"对话模型读不了图，但用户还是把图发过来了"这种情况。

## 为什么不起 worker

同类实现（`agents/blog/runtime/parse-document.mjs`）跑在 `worker_threads` 里，能限内存、能强杀。
这个包做不到：

- **打包形态**：本包被消费方 tsdown **内联**进 `dist/index.mjs`，worker 需要的那个 `.mjs` 资源
  文件不会跟着进去；
- **发布形态**：插件的归档只含它自己 `package.json` 里 `files` 列的路径。一个位于
  `plugins/external/dsh-agents-group/packages/` 的文件，没有任何办法进到别的插件的归档里。

所以解析在**调用方进程内**跑，保护手段是上限：单文件字节、归档展开总量、条目数、单元数、
字符数、PDF 页数，加一个协作式的时间预算（在单元之间检查，不打断已经在跑的那一次调用）。

**已知取舍**：DSH 是单进程，一个特别复杂的大文件会占住事件循环。调用方应把 `maxBytes` 调到
自己容忍的范围。将来若实测出现可感知卡顿，升级路径是"消费方在自己插件里放一个 worker 启动壳"
（壳文件属于插件自己的 `files`，能进归档），本包的对外接口不用改。

## 与 blog 那份实现的关系

两者并存，不是搬运关系：

- `agents/blog/runtime/parse-document.mjs` 面向"资料库"语义（版本、范围选择、冻结、worker 强杀）；
- 本包面向"这一次上传"（一次解析、给上限、如实标注 partial）。

本包的 `ParsedDocument` 形状与 blog 那份对齐（`units` / `totalUnits` / `unit` / `characters` / `partial`），
将来 blog 要合并时，页面与存储都不用改。

## DOCX 为什么要自己先走一遍压缩包

DOCX 就是个 zip，而 zip 的头部可以声称"展开后 100 字节"、实际吐出几个 GB（zip 炸弹），
`mammoth` 会老老实实解开它。所以 `parseDocxDocument` 先用 `yauzl` 逐个条目**真读**、按真实字节
累加，超限立刻停；顺带拒掉加密包与带宏的文档（带宏是主动不收，不是读不动），并核验
`word/document.xml` 存在——否则"这不是 DOCX"和"这个文档是空的"会被混成同一句话。

## 下一批

- `xlsx`：表格转文字是**有损**的（合并单元格、多 sheet、公式），做不好不如不做，先列出来。
- 扫描件 PDF 的 OCR：`DSH_OFFLINE` 下不能下模型，得靠视觉模型按页转图，成本另算。
