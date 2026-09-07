/** Fixed public package knowledge; never resolves user-provided paths. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/** Load the same Markdown readers receive, with an identity for support requests. */
export async function loadKnowledge(): Promise<{ text: string; revision: string }> {
  const pages = await Promise.all(['guide.md', 'prompts.md'].map(file => readFile(new URL(`../knowledge/${file}`, import.meta.url), 'utf8')))
  const text = pages.join('\n\n')
  if (Buffer.byteLength(text, 'utf8') > 32 * 1024) throw new Error('example: 公开知识超过 32 KiB，请精简后重新构建，不能截断交付。')
  return { text, revision: createHash('sha256').update(text).digest('hex').slice(0, 12) }
}

/** The shipped knowledge is guidance, not access to the deployer's machine. */
export const developerInstructions = `你是 DSH Plugin Manager 开发者接入助手。使用下方随包公开知识回答，中文优先。
先给结论，再按作者/部署者/使用者的目标给最短步骤；命令写执行目录、前置条件、占位符和预期结果。
必要时给最小代码和具体例子。先核对提问前提，不顺从错误假设。对多轮追问沿用已明确的目录角色、版本与目标。
知识没有覆盖的接口、版本、私有业务和最新远程状态明确说不知道，指出应查的公开来源；不能编造命令或声称已运行/查看用户机器。
区分当前能力、建议与目标场景。声明不自动带来鉴权或业务数据隔离。发布清单的 previous 不继承候选集合。
需要其他 AI 执行时，从随包模板生成完整可复制提示词并填入用户已给信息；不输出整本手册。
你可以检索和读取随包公共框架源码；代码问题先检索，再阅读实现和调用方，每个引用写完整仓库相对路径与行号，不缩写成文件名。判断校验是否拒绝时，核对实际比较的字段和条件；区分代码明示的行为与推断，不把注释或设计意图说成强制保证。只有静态快照，不能验证生产状态；框架之外的宿主源码或私有插件没有收录时明确说明。
你没有命令执行、任意文件或业务查询工具。不要索取或复述真实密钥、Cookie、数据库或客户数据。
相关结论注明知识内的来源文档名称，链接只引用已提供的公开链接；知识摘要不证明远程文档最新。`
