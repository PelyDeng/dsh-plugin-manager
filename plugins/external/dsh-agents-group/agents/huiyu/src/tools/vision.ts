/**
 * 识图工具：描述、抽取、对比。
 *
 * ## 这三个工具为什么不自调视觉模型
 *
 * 宿主的工具结果支持**图片内容块**：工具返回 `{ type: 'image', attachment }` 之后，这张图会
 * 随结果进入模型的下一轮上下文，模型**自己就看到了**。所以工具要做的是"把图取出来交给这一轮"，
 * 而不是"再开一次模型调用问它图里有什么"。
 *
 * 自调模型有三处更差：多一次计费、多一层要维护的模型选择与脱敏、而且**看不到原始提问的上下文**
 * （用户问的是"这个报表哪里不对"，工具那一次调用拿不到这句话）。
 *
 * ## 那三个工具的差别在哪
 *
 * 在**任务指引**：工具结果里的那段文字告诉模型"这一轮要看图的什么"。三个指引对应三种使用场景，
 * 也正是模型在选工具时看到的描述。所以它们的价值不是"多做了一件事"，而是**提高召回**：
 * 只有 `huiyu_describe` 时，模型要自己推理出"用户想看发票 = 我要仔细读图上文字"，
 * 中间容易走偏；有了专用工具的说明，它直接选对。
 */

import type { HuiyuToolContext, ToolSpec } from './context.ts'
import { invalid, optionalString, requiredString, requiredStringArray } from './context.ts'
import { attachmentsOf, readImageBytes } from '../media/attachments.ts'
import type { ImageRef } from '../media/attachments.ts'

/** 一个工具：定义 + 实现。 */
export interface HuiyuTool {
  readonly spec: ToolSpec
  readonly run: (args: Record<string, unknown>, execution: { readonly signal: AbortSignal }) => Promise<readonly unknown[]>
}

/** 图片的元信息行，让模型知道它拿到的这张图有多大、有多少字节。 */
function describeRef(ref: Pick<ImageRef, 'width' | 'height' | 'bytes'>): string {
  return `${ref.width}×${ref.height}，${Math.round(ref.bytes / 1024)} KB`
}

/**
 * 读一张图并收成"交给模型看"的结果。
 *
 * 文字在前、图片在后：模型先读到"这一轮要干什么"，再看到图。反过来会让它在还不知道任务时
 * 就开始描述画面，而那正是泛泛而谈的来源。
 */
async function openImage(
  context: HuiyuToolContext,
  attachmentId: string,
  guidance: string,
  signal: AbortSignal,
): Promise<readonly unknown[]> {
  const service = attachmentsOf(context.ctx)
  const { ref } = await readImageBytes(service, attachmentId, signal)
  return [
    { type: 'text', text: `${guidance}\n\n（图片：${describeRef(ref)}，附件 ${ref.attachmentId}）` },
    { type: 'image', attachment: ref },
  ]
}

/**
 * 造三个识图工具。
 *
 * @param context 工具运行所需的装配（由子包在注册时闭包进来）
 */
export function createVisionTools(context: HuiyuToolContext): readonly HuiyuTool[] {
  return [
    {
      spec: {
        name: 'huiyu_describe',
        displayName: '描述图片',
        description: '看懂一张图片里有什么。用户问“这张图是什么”“图里有什么”“帮我看看这张照片”时用它。'
          + '返回图片本身与一个看图任务，你据此给出描述。适合需要理解画面内容、场景、物体、人物、风格的场合。',
        parameters: {
          type: 'object',
          properties: {
            attachmentId: { type: 'string', description: '图片的附件标识。来自用户上传的图片或此前生成图片的记录。' },
            question: { type: 'string', description: '用户关于这张图的具体问题。填写后，描述会围绕这个问题展开，而不是泛泛而谈。' },
          },
          required: ['attachmentId'],
        },
      },
      run: async (args, execution) => {
        const attachmentId = requiredString(args, 'attachmentId', 200)
        const question = optionalString(args, 'question', 1000)
        const guidance = question === undefined
          ? '看图后描述画面内容：主体、场景、可见文字、整体风格。说明清楚但不啰嗦。'
          : `看图后回答用户的问题：“${question}”。先直接回答，再补充必要的画面细节。`
        return openImage(context, attachmentId, guidance, execution.signal)
      },
    },
    {
      spec: {
        name: 'huiyu_extract',
        displayName: '抽取图片信息',
        description: '从图片里读出结构化信息，例如表格、发票、报表、截图里的文字与数字。'
          + '用户想“把这张表转成文字”“这张发票金额是多少”“截图里的报错是什么”时用它。'
          + '需要逐字准确读取图中文字时优先用它，而不是 huiyu_describe。',
        parameters: {
          type: 'object',
          properties: {
            attachmentId: { type: 'string', description: '图片的附件标识。' },
            fields: { type: 'string', description: '要抽取哪些字段，逗号分隔，例如“金额,日期,发票号”。留空则按图片内容自动判断该抽什么。' },
          },
          required: ['attachmentId'],
        },
      },
      run: async (args, execution) => {
        const attachmentId = requiredString(args, 'attachmentId', 200)
        const fields = optionalString(args, 'fields', 500)
        const guidance = fields === undefined
          ? '逐字读出图中的文字与数字，按内容组织成结构化结果（表格就还原成表格）。只写图上真实存在的内容，看不清的地方明确标注，不要凭常识补全。'
          : `从图中抽取这些字段：${fields}。逐字读取，图上没有的字段明确写“未找到”，不要推测。`
        return openImage(context, attachmentId, guidance, execution.signal)
      },
    },
    {
      spec: {
        name: 'huiyu_compare',
        displayName: '对比多张图片',
        description: '对比两张及以上图片的差异。用户说“这两版设计稿差在哪”“哪个版本多了一个按钮”“前后有什么变化”时用它。'
          + '至少两张，最多四张。',
        parameters: {
          type: 'object',
          properties: {
            attachmentIds: { type: 'array', items: { type: 'string' }, description: '要对比的图片附件标识，按对比顺序给出，2 到 4 张。' },
            focus: { type: 'string', description: '希望重点关注哪方面的差异，例如“布局”“配色”“文字内容”。留空则全面对比。' },
          },
          required: ['attachmentIds'],
        },
      },
      run: async (args, execution) => {
        const ids = requiredStringArray(args, 'attachmentIds', 4, 200)
        if (ids.length < 2) throw invalid('对比至少需要两张图片')
        const focus = optionalString(args, 'focus', 500)
        const service = attachmentsOf(context.ctx)
        const refs: ImageRef[] = []
        for (const id of ids) {
          const { ref } = await readImageBytes(service, id, execution.signal)
          refs.push(ref)
        }
        const guidance = focus === undefined
          ? `依次看这 ${refs.length} 张图片，指出它们的差异：增删了什么、改动了什么、哪些地方一致。按“相同 / 不同”分组说明。`
          : `依次看这 ${refs.length} 张图片，重点对比「${focus}」方面的差异，其余方面只在明显不同时提一句。`
        return [
          { type: 'text', text: `${guidance}\n\n图片按给出顺序排列：${refs.map((ref, index) => `#${index + 1} ${describeRef(ref)}`).join('；')}` },
          ...refs.map(ref => ({ type: 'image', attachment: ref })),
        ]
      },
    },
  ]
}
