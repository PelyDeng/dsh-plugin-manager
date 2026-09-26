import { defineStore } from 'pinia'
import type { ButlerStatus, HistoryItem } from './butler-client.ts'
import type { DialogueView, Prompt } from './interaction.ts'
import type { StaffDialogueView } from './performance.ts'
import { emptyTaskView, type ConversationSummary, type RunInfo, type TaskView } from './task-projection.ts'

/**
 * 一次待重试的提交：正文与 `requestId` 在生成时冻结，响应未知后的手动重试
 * 逐字复用同一份——管家按「同 owner + 同类型 + 同 requestId」幂等，保证是同一次提交。
 */
export interface PendingSubmit {
  readonly kind: 'chat' | 'reply'
  readonly conversationId: string
  readonly requestId: string
  /** chat 的目标文本。 */
  readonly message: string
  /** reply 的定位与内容。 */
  readonly taskId: string
  readonly subtaskId: string
  readonly replyText: string
  readonly decideByAgent: boolean
}

/**
 * 任务本与连接状态的界面共享状态。只放业务/界面事件级别的数据：
 * 任务投影、会话列表、连接状态与弹层开合。人物逐帧坐标永远不进这里。
 */
export const useTaskBookStore = defineStore('task-book', {
  state: () => ({
    /** 管家链路状态；任务本顶部的连接提示据此渲染。 */
    status: 'idle' as ButlerStatus,
    statusDetail: '',
    /** Phaser 出生地图是否渲染完成。 */
    worldReady: false,
    /** 老板当前所在地图 id（office/street/cafe），供界面标注与诊断。 */
    worldMap: 'office',
    conversations: [] as ConversationSummary[],
    selectedId: '',
    task: emptyTaskView() as TaskView,
    history: [] as HistoryItem[],
    activeRun: null as RunInfo | null,
    /** 轻提示：资源错误、角色点击、写链路结果等；正式对白弹层属后续切片。 */
    notice: '',
    /** 面板打开期间被挂起的环境提示（走近一点等）；关闭弹层后补显一次。显示计时在 App 层。 */
    pendingNotice: '',
    /** 任务本开合；打开时暂停键盘移动，竖屏下为全屏弹层。 */
    bookOpen: false,
    /** 派活表单草稿；受理成立后清空，失败与结果不明时保留以便重试。 */
    assignDraft: '',
    /** 各子任务的回复草稿（按 subtaskId）；受理成立后清空对应项。 */
    replyDrafts: {} as Record<string, string>,
    /** 有写请求在途；写入口据此禁用，避免并发提交。 */
    submitting: false,
    /**
     * 已请求停止本轮、还没收到权威终态：界面按「正在收尾」提示并隐藏派活入口。
     * 这是界面请求状态，不是业务状态——真的停下以管家事件或下一次 probe 为准。
     */
    stopRequested: false,
    /** 响应未知、可原样重试的提交；其余失败（403/409 等）不留待重试。 */
    pendingSubmit: null as PendingSubmit | null,
    /** 员工当前的对话气泡与权威状态文案；只读展示（动作文案由它一并给出）。 */
    staff: [] as StaffDialogueView[],
    /** 就近范围内的唯一交互提示（interaction_rules.yaml 的全序优先级）。 */
    prompt: null as Prompt | null,
    /** 对白面板（普通 NPC 预写对白）或员工名牌；两者都没有自由输入。 */
    dialogue: null as DialogueView | null,
  }),
  getters: {
    selectedConversation: state => state.conversations.find(c => c.id === state.selectedId) ?? null,
  },
})
