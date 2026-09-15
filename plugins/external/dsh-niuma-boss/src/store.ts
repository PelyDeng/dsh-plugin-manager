import { defineStore } from 'pinia'
import type { ButlerStatus, HistoryItem } from './butler-client.ts'
import { emptyTaskView, type ConversationSummary, type RunInfo, type TaskView } from './task-projection.ts'

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
    conversations: [] as ConversationSummary[],
    selectedId: '',
    task: emptyTaskView() as TaskView,
    history: [] as HistoryItem[],
    activeRun: null as RunInfo | null,
    /** 轻提示：资源错误、角色点击等；正式对白弹层属后续切片。 */
    notice: '',
    /** 任务本开合；打开时暂停键盘移动，竖屏下为全屏弹层。 */
    bookOpen: false,
  }),
  getters: {
    selectedConversation: state => state.conversations.find(c => c.id === state.selectedId) ?? null,
  },
})
