/**
 * 页面共享单例（拆分设计 v2 批 1a）：el（DOM 句柄）、state（会话状态）、historyState
 * （历史翻页簿记）与本地会话记忆。可变共享靠 ES 模块的 live binding：只改属性、
 * 不重新赋值，各域 import 到的是同一个对象。
 */

import { CONVERSATION_KEY } from './config.js'
export const el = {
  thread: document.getElementById('thread'),
  rail: document.getElementById('rail'),
  composer: document.getElementById('composer'),
  input: document.getElementById('message-input'),
  send: document.getElementById('send-button'),
  at: document.getElementById('at-button'),
  /** 回形针（选文件）、链接（把远处的文件取回来）与它们共用的附件条。 */
  attachButton: document.getElementById('attach-button'),
  attachLinkButton: document.getElementById('attach-link-button'),
  attachInput: document.getElementById('attach-input'),
  attachStrip: document.getElementById('attach-strip'),
  attachItems: document.getElementById('attach-items'),
  attachUrl: document.getElementById('attach-url'),
  attachUrlInput: document.getElementById('attach-url-input'),
  attachUrlCancel: document.getElementById('attach-url-cancel'),
  stop: document.getElementById('stop-button'),
  hint: document.getElementById('composer-hint'),
  count: document.getElementById('composer-count'),
  chatList: document.getElementById('chat-list'),
  chatSearch: document.getElementById('chat-search'),
  crewFaces: document.getElementById('crew-faces'),
  crewLine: document.getElementById('crew-line'),
  crewNote: document.getElementById('crew-note'),
  groupSub: document.getElementById('group-sub'),
  memberList: document.getElementById('member-list'),
  settingsButton: document.getElementById('settings-button'),
  settingsBack: document.getElementById('settings-back'),
  settings: document.getElementById('settings'),
  settingsMembers: document.getElementById('settings-members'),
  metrics: document.getElementById('metrics'),
  failureList: document.getElementById('failure-list'),
  motto: document.getElementById('motto'),
  identity: document.getElementById('identity'),
  topStatus: document.getElementById('top-status'),
  newChat: document.getElementById('new-chat'),
  sidebarToggle: document.getElementById('sidebar-toggle'),
  drawerToggle: document.getElementById('drawer-toggle'),
  backdrop: document.getElementById('drawer-backdrop'),
  jumpLatest: document.getElementById('jump-latest'),
  srStatus: document.getElementById('sr-status'),
  leftPanel: document.getElementById('left-panel'),
  rightPanel: document.getElementById('drawer'),
  settingsTitle: document.getElementById('settings-title'),
  settingsLive: document.getElementById('settings-live-note'),
  /** @ 提及选择器浮层（在 composer 里，静态骨架见 index.html）。 */
  mentionPop: document.getElementById('mention-pop'),
  mentionItems: document.getElementById('mention-items'),
}

export const state = {
  conversationId: null,
  members: [],
  /** agentId → 头像版本号，用于破缓存。 */
  avatarStamps: new Map(),
  streaming: false,
  abort: null,
  /** 视图代次：所有会话切换入口共用，异步回包先核对它，旧响应不许写进新视图。 */
  viewToken: 0,
  /** 发送时预渲染、等服务端回放确认的那条用户消息；失败时用它恢复草稿。 */
  pendingUser: null,
  /**
   * 待发附件（输入框上方那一条）。
   *
   * 每项的形态：`{ key, name, size, phase, message, item }`。
   * - `key` 是页面自己的身份（上传中还没有服务端 id）；
   * - `phase` 是 `uploading` / `ready` / `failed`；
   * - `item` 是服务端回来的那条记录（含 id），上传中为 `null`。
   *
   * 只活在内存里会有一个后果：刷新页面后附件条没了，但文件其实还在服务端等着——所以打开会话
   * 时用 `/attachments/list` 重建一次。
   */
  attachments: [],
  /** 本轮事件消费进度：seq 用于断线重订的游标，taskId 用于 reset 后取快照。 */
  lastSeq: 0,
  lastRunTaskId: '',
  /** 本轮受理的 runId：重订时的预期对象（S06 不混轮次）。 */
  lastRunId: '',
  /** 上一条落定的大总管正文：汇总卡与之相同时不再重复整段（S12）。 */
  lastChatText: '',
  /** 子任务 id → 该成员当前的气泡与状态节点，供流式增量原地更新。 */
  bubbles: new Map(),
  /** 大总管正在流式发言的那条气泡；落定的 `chat` 收它。 */
  butlerSpeech: null,
  /**
   * 大总管这一轮的思考快照（覆盖语义）。
   *
   * 思考通常先于正文到达，所以它先存在这里；等气泡真的出现（第一段增量或落定正文）再挂上去，
   * 换尝试（`chat_reset`）或开新一轮时清空。
   */
  butlerThinking: '',
  /**
   * 本次「已调度成员」面板：成员的真实在查什么、交回了什么，都收在这里。
   *
   * `null` 表示这一轮没分派（大总管自己答的）。新一轮开始时整体重建，见 `mountDispatch`。
   */
  dispatch: null,
  /** 子任务 id → 等待中的提问卡，收到回复后移除。 */
  asks: new Map(),
  taskId: null,
  /** 当前任务的链路状态。 */
  rail: { parse: 'idle', dispatch: 'idle', work: 'idle', sum: 'idle' },
  settingsOpen: false,
  /** 滚动跟随（I11）：用户上滚或选字时暂停，「回到最新」恢复；跟随判断在 DOM 增长前做。 */
  following: true,
  selecting: false,
}

/**
 * 历史阅读的翻页状态（I10）：会话 id + 两个游标（对话正文 seq、任务 offset）。
 * 「加载更早记录」时核对会话与视图代次，旧回包不写进新会话（I09）。
 */
export const historyState = {
  conversationId: null,
  transcriptBefore: null,
  taskOffset: null,
  loading: false,
  /** 已加载的历史条目（全局时间序，带节点引用）：翻页去重与定位插入的依据（复核 1）。 */
  entries: [],
}

export function newConversationId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map(v => v.toString(16).padStart(2, '0')).join('')
  return `butler-web-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function rememberConversation(id) {
  try { localStorage.setItem(CONVERSATION_KEY, id) } catch { /* 隐私模式下忽略。 */ }
}

export function recallConversation() {
  try { return localStorage.getItem(CONVERSATION_KEY) } catch { return null /* 隐私模式下当作没有。 */ }
}
