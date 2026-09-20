/**
 * 计划返工（拆分 v2 批 2）：逻辑步骤的重派次数预算与返工计划；子任务报告拼装。
 */

import type { SubtaskVerdict } from '../storage/types.ts'
import type { SubtaskState } from '../task-model.ts'
import { effectiveSubtasks } from './dispatch-brief.ts'
import { REPLAY_REJECTED_PREFIX, dispatchFailureDetail } from './verdict.ts'
import type { SettleTaskInput } from './verdict.ts'

/**
 * 同一个目标（`logicalId`）最多允许几条尝试。
 *
 * **D-3 的定案**：协调侧按 `logicalId` 数"已有尝试条数"设硬限，**不做 0.5 折算** —— 那次折算
 * 只影响运行时侧的内部记账（`definition.ts` 的 `maxSelfRetries` 注释），协调侧不引入第二个
 * 记账口径。计数一律**读时聚合**（设计 §5.4）：落成字段的话，每次重做新建一行都会把它归零
 * ⇒ 内环无界。
 */
export const MAX_ATTEMPTS_PER_LOGICAL = 2

/** {@link planReworkAttempts} 的结论：要追加哪些、哪些因为预算用尽而不追加。 */
export type ReworkAttemptPlan = {
  readonly appended: readonly {
    readonly id: string
    readonly goal: string
    readonly agentId: string
    /** 沿用原目标的标识：聚合按它算"这是同一个目标的第几条尝试"。 */
    readonly logicalId: string
    /** 被替代的那条尝试。`supersedes` 与派单时的 `reworkOf` **同源于它**。 */
    readonly supersedes: string
    readonly acceptance?: string | undefined
  }[]
  /** 预算用尽、不再追加的步骤 id（**如实说清**，不静默丢弃）。 */
  readonly exhausted: readonly string[]
}

/**
 * 从裁决结论算出"要追加哪些尝试"（设计 §5.4 第 2 步：有重做且预算允许 ⇒ 追加尝试、回调度）。
 *
 * **纯函数**：不读时钟、不碰存储、不调模型。追加的**动作**（写库 / 派单 / 回调度）在
 * `ButlerConsole#applyReworkAttempts` 里。这么拆是为了让"预算算得对不对""替代者换没换对"
 * 能被**直接测到**：把它埋在收尾里就只能靠"跑一整轮汇总"来验。
 *
 * ⚠️ **在这里纠正一句被误传了三批的话**（原文写在 `dispatchFailureDetail` 的注释附近）：
 * "汇总轮要模型驱动、那条路会让用例挂在超时上"。实测**不成立**，而且它是两件事被混成一件：
 *
 * - **`planTool.execute()` 不派单** —— 它只校验并登记计划，派单发生在 `turnBody` 的第二段。
 *   所以"派单抛错会让 `planTool.execute` 挂住"这个说法本身就不成立（它根本没有派单那一步）。
 * - **真正的原因是驱动轮数不够**：`settleTask` 在有观众时先置 `summarizing` 再跑 `summarize`，
 *   而 `summarize` 等的是模型（`followup` + `turn/end`）；`rework` 还会经
 *   `applyReworkAttempts` **再收尾一次**。只驱动一次就等不到终态，表现像"夹具坏了"。
 *
 * 可复用夹具见 `tests/helpers/butler-driver.ts`（文件头写了机制与"能/不能驱动什么"），
 * 端到端判据见 `tests/verdict-e2e.test.ts`（含 409 区分、rework 追加、预算用尽、口径进提示词）。
 */
export function planReworkAttempts(input: {
  readonly decided: readonly {
    readonly subtaskId: string
    readonly verdict: SubtaskVerdict
    readonly requested: 'accept' | 'rework' | 'replace'
    readonly newAgentId?: string | undefined
  }[]
  readonly subtasks: SettleTaskInput['subtasks']
  /**
   * **全部历史尝试**（未去重，含被替代掉的旧尝试）：预算统计必须用它。
   *
   * ⚠️ 缺省退回 `subtasks` 只为兼容既有调用，**真实调用点必须传它** —— 理由见下面统计处那段注释。
   */
  readonly allSubtasks?: readonly { readonly id: string; readonly logicalId?: string | undefined }[] | undefined
  /** 库里已有的子任务条数：新尝试的 id 从它往后编号（与补充轮同一套 `s${n}` 约定）。 */
  readonly baseCount: number
  readonly limit?: number | undefined
}): ReworkAttemptPlan {
  const limit = input.limit ?? MAX_ATTEMPTS_PER_LOGICAL
  // **读时聚合**：每个目标（`logicalId`，缺省退回 `id`）现在已经有几条尝试。
  //
  // ⚠️ **必须统计全部历史，不能统计有效尝试**：`effectiveSubtasks()` 会把被替代的旧尝试剔除，
  // 于是"同一个目标已经有 2 条尝试"在有效集合里只剩 1 条 ⇒ `used` 恒为 1 ⇒ **预算永不耗尽**，
  // 每一轮裁决都追加一次；同时 `s${baseCount + …}` 的基数也被去重缩小，追加出来的 id 会与
  // 历史撞车。设计 §5.4 第 798 行专门警告过"落字段会因重做新建行而每轮归零 ⇒ 内环无界"——
  // 这里是**去重导致的同一种归零**，形态不同、后果相同。
  // 实测（`tests/verdict-e2e.test.ts` 的"预算用尽"用例）：连续裁 `rework` 会撞
  // `UNIQUE constraint failed: subtasks.task_id, subtasks.id` 并让整轮中断。
  const attempts = new Map<string, number>()
  for (const item of input.allSubtasks ?? input.subtasks) {
    const key = item.logicalId === undefined || item.logicalId === '' ? item.id : item.logicalId
    attempts.set(key, (attempts.get(key) ?? 0) + 1)
  }
  const appended: ReworkAttemptPlan['appended'][number][] = []
  const exhausted: string[] = []
  for (const decision of input.decided) {
    // 只认**已经落地的结论**：`accept` / `unverified` 都不追加（降级出来的 `unverified` 不是重做）。
    if (decision.verdict !== 'rework' && decision.verdict !== 'replace') continue
    const target = input.subtasks.find(item => item.id === decision.subtaskId)
    if (target === undefined) continue
    const key = target.logicalId === undefined || target.logicalId === '' ? target.id : target.logicalId
    const used = attempts.get(key) ?? 0
    if (used >= limit) { exhausted.push(decision.subtaskId); continue }
    attempts.set(key, used + 1)
    // `replace` 换人、`rework` 沿用原成员；替代者在 `readVerdictDecision` 里已经预检过可调度。
    const agentId = decision.verdict === 'replace' ? (decision.newAgentId ?? target.agentId) : target.agentId
    appended.push({
      id: `s${input.baseCount + appended.length + 1}`,
      goal: target.goal,
      agentId,
      logicalId: key,
      supersedes: target.id,
      // 口径沿用原步的那一份：重做的是同一件事，换一份口径等于换了个目标。
      ...(target.acceptance === undefined || target.acceptance === ''
        ? {}
        : { acceptance: target.acceptance }),
    })
  }
  return { appended, exhausted }
}

/**
 * 从落库的子任务记录重建交给汇总的材料。 *
 * 补话之后要重新汇总，而那时派活阶段的 `reports` 早已不在内存里（进程可能都换过一次），
 * 所以按同一种口径从库里重建：成功取结果正文，失败与取消带上原因，还没答复的带上已交回的
 * 材料和待答事项。
 */
export function reportOf(subtask: {
  readonly state: SubtaskState
  readonly agentId: string
  readonly result: string
  readonly error: string
}): string {
  switch (subtask.state) {
    case 'succeeded': return subtask.result
    // 失败也把已经交回的材料带上。超时就是一个例子：成员把候选稿交回来了，只是用户一直
    // 没回话 —— 只说「失败：超时」会让人以为材料也丢了。
    case 'failed': {
      /**
       * 重启重放被拒**不是**活没干好：那一轮此前已经交付过，运行时只是拒绝再跑一遍。
       * 渲染成"失败"会让老板以为成员出了问题，所以这里换一句说明（判据 D-1）。
       */
      if (subtask.error.startsWith(REPLAY_REJECTED_PREFIX)) {
        return subtask.result === ''
          ? `【${subtask.agentId}】${subtask.error}`
          : `【${subtask.agentId}】${subtask.error}；已交回的材料：${subtask.result}`
      }
      return subtask.result === ''
        ? `【${subtask.agentId}】失败：${subtask.error}`
        : `【${subtask.agentId}】失败：${subtask.error}；已交回的材料：${subtask.result}`
    }
    case 'cancelled': return `【${subtask.agentId}】${subtask.error === '' ? '已停止' : subtask.error}`
    case 'external_pending': return `【${subtask.agentId}】材料已交回，还有事在别处等着办：${subtask.result}`
    default: return `【${subtask.agentId}】交回材料，还等着答复：${subtask.result}`
  }
}

import { defineTool } from '@deepseek-ai/dsh-tools'
import { clip } from './text.ts'
import { requireAcceptance } from './acceptance.ts'
import type { PlannedSubtask, Turn } from './domain.ts'
import { isTerminal } from '../task-model.ts'
import type { AgentCard } from '../agents.ts'

/**
 * `butler_plan` 工具的工厂（批 3 从 ButlerConsole.planTool 上提，行为不变）。
 *
 * 用工具交回计划，而不是从自然语言里解析 JSON：模型要么给出结构化计划，要么就
 * 只是普通回答，宿主不会把一段看起来像 JSON 的正文误当成计划。
 */

export function makePlanTool(input: {
  readonly name: string
  readonly sessionId: string
  readonly turns: ReadonlyMap<string, Turn>
  readonly dispatchableAgents: () => readonly AgentCard[]
  readonly maxSubtasks: number
 }) {
    return defineTool({
      name: input.name,
      description: '把这一次的任务拆解交回宿主。只在确实需要把任务派给子 Agent 时调用；不需要调度的普通问答不要调用。',
      parameters: {
        reply: { type: 'string', required: true, description: '给用户看的说明：你如何理解目标，以及打算怎么做。' },
        acceptance: { type: 'string', description: '这一次任务的验收口径：交回什么才算完成。写清产出物的种类、数量或必须包含的要点（例如「一条已发布版本的链接」「一份含全部字段的统计表」「一张图片：可访问的地址与尺寸，画面与关键词对应」）。不要写「完成即可」「没问题」这类没有信息量的话——那种口径等于没有，会被拒绝。确实要不到可核验的产出物（例如只是问一句话）就不要传这个参数。' },
        note: { type: 'string', description: '拆解依据的补充说明，可以留空。' },
        subtasks: {
          type: 'array',
          required: true,
          description: '按执行先后排列的子任务。每个子任务都是可以被独立交给一个子 Agent 完成的一句话目标。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              goal: { type: 'string', required: true, description: '交给子 Agent 的完整目标，要自带必要上下文，不要用“同上”“继续”这类指代。**用途、场景和规格以老大的原话为准**：老大没说的使用场景（如“配在文章里”“给博客用”）、尺寸、比例、风格，不要替他补写——目标只转述老大要的产出本身。' },
              acceptance: { type: 'string', description: '这一步自己的验收口径：交回什么才算完成。各步的产出物不同，所以要分别写（例如「一份 800 字以上的候选稿」「一条已发布版本的链接」「一张图片：可访问的地址与尺寸」）。**不填就是这一步没有口径**——它不沿用上面的任务级口径，所以需要核验的步骤必须自己写出来。确实没有可核验产出物时不要填。' },
              agentId: { type: 'string', required: true, description: '目标 Agent 的 id，只能从本轮可调度的 Agent 列表中选择。' },
              reason: { type: 'string', description: '为什么把这个子任务派给这个 Agent。' },
              logicalId: { type: 'string', description: '同一个目标重做时沿用原来的目标标识（例如 g1）。新目标不要填，管家会分配。' },
              supersedes: { type: 'string', description: '替代哪一条尝试：填它原来的子任务 id（s1、s2…）。只在这个新尝试取代同一个目标的旧尝试时才填；旧尝试必须已经结束。' },
              dependsOn: {
                type: 'array',
                items: { type: 'string' },
                description: '前置的目标标识（例如 g1）。补充/替代某一步的新尝试会自动继承原步骤的前置，不必重写、丢了也不会断料。派这一步之前逐个核验：前置还没结束（含等人回话、等人在卡片上确认）就留在队列里等，不判失败；前置失败、取消或被替代才不派，并如实记下缺失的前提。不填表示没有前置。只能引用这一轮里已经存在的目标，或者本次计划中排在它前面的目标。**彼此独立的步骤不要互相依赖**：删掉五篇不同的文章、给五篇文章各配一张图，都是五件独立的事，应该并列成五个没有 dependsOn 的步骤，而不是串成一条链 —— 串起来之后，第一件卡住（例如等你确认），后面每一件都动不了。',
              },
              requiresExternalAction: {
                type: 'boolean',
                description: '这一步是否真的需要外部动作（在原页面采用、确认、发布）已经办完。默认 false：前置交了材料就可以拿材料继续干。当前置带着「外部待办」时这条才起作用 —— 填 true 表示这一步要的是已经办完的结果（例如「报道一下已经发布的版本」），材料本身不够用；不填表示材料够用（例如「拿候选稿写个摘要」）。填 true 时，前置还在等外部动作的期间这一步会**排队等着**（不会判失败），办完之后自动接上。',
              },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { accepted: { type: 'boolean', required: true }, subtasks: { type: 'integer', required: true } },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.accepted ? `已接受 ${value.subtasks} 个子任务，开始调度。` : '计划未被接受。',
        }],
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted()
        const turn = input.turns.get(input.sessionId)
        if (turn === undefined || turn.done) throw new Error('这一轮已经结束，计划未被接受')
        // 补充轮**不接受**顶层验收口径：口径描述的是"这个任务要交回什么"，而补充轮追加的是同一
        // 任务里的新活。让它改写任务级口径，会让已经派出去的那些步失去依据；静默丢弃更糟——
        // 模型以为自己改了口径，实际没有。所以当场拒绝，并把它该写在哪告诉它。
        if (turn.context !== undefined && typeof args.acceptance === 'string' && args.acceptance.trim() !== '') {
          throw new Error('补充轮不能声明任务级验收口径（顶层 acceptance 不会被使用）。请把口径分别写在这次新增的每一条子任务上。')
        }
        const available = new Set(input.dispatchableAgents().map(card => card.id))
        const subtasks: PlannedSubtask[] = []
        // 前置只能指向这一轮里已有的目标，或者本次计划中排在它前面的目标 —— 这样依赖天然
        // 无环，也天然有序，不必再跑一遍环检测。
        const known = new Set<string>((turn.context?.subtasks ?? []).map(item => item.logicalId))
        /**
         * 新目标的标识**在这里就分配**，不留给存储层。
         *
         * 因为同一个计划里后面的项要能依赖前面的项：如果标识要等落库时才知道，校验这一步
         * 就看不见它，`dependsOn` 里的 `g1` 会被当成「不存在」。分配规则与存储层一致 ——
         * 从现有最大值往后排。
         */
        let nextLogical = (turn.context?.subtasks ?? [])
          .map(item => Number.parseInt(item.logicalId.replace(/^g/u, ''), 10))
          .filter(value => Number.isSafeInteger(value))
          .reduce((max, value) => Math.max(max, value), 0)
        for (const item of args.subtasks as readonly {
          goal?: unknown
          acceptance?: unknown
          agentId?: unknown
          reason?: unknown
          logicalId?: unknown
          supersedes?: unknown
          dependsOn?: unknown
          requiresExternalAction?: unknown
        }[]) {
          const goal = typeof item.goal === 'string' ? clip(item.goal, 2000) : ''
          const agentId = typeof item.agentId === 'string' ? item.agentId.trim() : ''
          if (goal === '') throw new Error('子任务缺少目标')
          if (!available.has(agentId)) {
            throw new Error(`Agent ${agentId === '' ? '（空）' : agentId} 不能接收子任务。本轮可调度的是：${[...available].join('、') || '（没有）'}`)
          }
          // 口径当场校验：太笼统就报错让模型改，不静默丢——丢掉的话核验阶段拿不到任何依据。
          const acceptance = requireAcceptance(item.acceptance, `子任务「${clip(goal, 20)}」`)
          let logicalId = typeof item.logicalId === 'string' ? item.logicalId.trim() : ''
          const supersedes = typeof item.supersedes === 'string' ? item.supersedes.trim() : ''
          /** 补充尝试（supersedes）从原步骤继承的依赖，见赋值处的说明。 */
          let inheritedDependsOn: readonly string[] = []
          if (supersedes !== '') {
            const attempts = turn.context?.subtasks
            if (attempts === undefined) throw new Error('这一轮还没有可以替代的旧尝试，不要填 supersedes')
            const target = attempts.find(candidate => candidate.id === supersedes)
            if (target === undefined) throw new Error(`要替代的子任务 ${supersedes} 不在这一轮里`)
            if (!isTerminal(target.state)) {
              throw new Error(`子任务 ${supersedes} 还没有结束（${target.state}），不能替代它`)
            }
            // 替代必须是同一个目标的新尝试：换个目标就该用新的标识，否则两条不相干的活会
            // 被算成一条，聚合时互相顶掉。
            if (logicalId !== '' && logicalId !== target.logicalId) {
              throw new Error(`子任务 ${supersedes} 属于目标 ${target.logicalId}，不能改成 ${logicalId}；要换目标请用新的标识并去掉 supersedes`)
            }
            logicalId = target.logicalId
            /**
             * 补充尝试**继承原步骤的依赖**。2026-09-21 线上实测：模型重派时漏写
             * `dependsOn`，新尝试收不到上游材料，下游只能反过来问老板要数据——
             * 「上一轮明明拿到了」的东西凭空消失。原步骤的依赖是这一步的事实需求，
             * 重做并不改变它。真要解除依赖，换一个新的目标标识重新拆，别替代原步骤。
             */
            inheritedDependsOn = target.dependsOn === undefined ? [] : [...target.dependsOn]
          } else if (logicalId === '') {
            // 新目标：**在这里就分配标识**，不留给存储层。同一个计划里后面的项要能依赖前面的项，
            // 而依赖校验就发生在下面几行 —— 标识要等落库时才知道的话，`dependsOn` 里的 `g1`
            // 会被当成「不存在」。分配规则与存储层一致：从现有最大值往后排。
            do { nextLogical += 1 } while (known.has(`g${nextLogical}`))
            logicalId = `g${nextLogical}`
          }
          const dependsOn = Array.isArray(item.dependsOn)
            ? [...new Set([
              ...item.dependsOn
                .filter((value): value is string => typeof value === 'string')
                .map(value => value.trim())
                .filter(value => value !== ''),
              // 补充尝试继承的原步骤依赖并进来（说明见赋值处）。
              ...inheritedDependsOn,
            ])]
            : [...inheritedDependsOn]
          // 先查自依赖：它看起来像「引用了一个还不存在的目标」，报错会指向错误的方向。
          if (logicalId !== '' && dependsOn.includes(logicalId)) throw new Error('不能把自己当作前置')
          for (const dependency of dependsOn) {
            if (!known.has(dependency)) {
              throw new Error(`前置目标 ${dependency} 不在这一轮里；只能引用已有的目标，或本次计划中排在它前面的目标`)
            }
          }
          subtasks.push({
            goal, agentId, reason: clip(typeof item.reason === 'string' ? item.reason : '', 300),
            ...(acceptance === '' ? {} : { acceptance }),
            ...(logicalId === '' ? {} : { logicalId }),
            ...(supersedes === '' ? {} : { supersedes }),
            ...(dependsOn.length === 0 ? {} : { dependsOn }),
            // 只在真的声明了 true 时才带上：没声明按「材料够用」算，与加这个字段之前一致。
            ...(item.requiresExternalAction === true ? { requiresExternalAction: true } : {}),
          })
          if (logicalId !== '') known.add(logicalId)
        }
        if (subtasks.length === 0) throw new Error('计划里至少要有一个子任务')
        if (subtasks.length > input.maxSubtasks) throw new Error(`一次最多派发 ${input.maxSubtasks} 个子任务`)
        // 同一次计划里同一个目标只能有一条有效尝试：两条会互相替代，聚合时谁也不算数。
        const claimed = new Set<string>()
        for (const subtask of subtasks) {
          if (subtask.logicalId === undefined) continue
          if (claimed.has(subtask.logicalId)) throw new Error(`计划里目标 ${subtask.logicalId} 出现了不止一次，请合成一条`)
          claimed.add(subtask.logicalId)
        }
        turn.plans.push({
          reply: clip(args.reply, 4000),
          note: clip(args.note ?? '', 1000),
          acceptance: requireAcceptance(args.acceptance, '这次任务'),
          subtasks,
        })
        return { accepted: true, subtasks: subtasks.length }
      },
    })}
