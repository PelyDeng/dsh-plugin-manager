<script setup lang="ts">
/**
 * GameUI 的外壳：Phaser 挂载点 + 任务本/连接提示叠层。会话在本组件挂载后组装
 * （需要真实的 DOM 挂载点），业务接线全部在 GameSession 内，这里只有界面意图转发：
 * 派活表单、等待成员的回复入口、停止本轮与结果展示都只是把意图交给会话。
 *
 * 人物对话（本切片）：员工气泡与名牌只显示**权威状态**（任务投影 + 表现命令），
 * 普通 NPC 打开作者预写对白面板。两个通路都没有自由输入框：不新增闲聊模型通道，
 * 也不给员工开搭话入口——要办的工作只经牛马大总管。
 *
 * 横竖屏：旋转不清空任何界面状态（位置与任务本开合都由会话/存储保存，旋转只改布局）；
 * 可见区域按 visualViewport 收缩，软键盘不遮挡输入框（真机未验证）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useTaskBookStore } from './store'
import { GameSession } from './game-session'
// 状态文案：投影的映射 + labels 里补的三个英文 token（dispatched/executing/succeeded）。
import { stateLabel as taskStateLabel } from './labels'
import { installViewportHeight } from './viewport'

const store = useTaskBookStore()
const host = ref<HTMLElement>()
const book = ref<HTMLElement>()
let session: GameSession | undefined
let detachViewport: (() => void) | undefined

const assetsBase = ((globalThis as { __NIUMA_BOSS_CONFIG__?: { routePrefix: string } }).__NIUMA_BOSS_CONFIG__?.routePrefix ?? '/niuma-boss') + '/generated/'

const statusText = computed(() => {
  switch (store.status) {
    case 'idle': return '未连接'
    case 'connecting': return '连接中'
    case 'ready': return store.statusDetail || '已连接'
    case 'offline': return store.statusDetail || '连接异常'
    case 'unauthorized': return '需要登录'
    case 'forbidden': return '没有访问权限'
    case 'incompatible': return '管家契约不兼容'
    case 'stopped': return '已断开'
    default: return store.status
  }
})

/** 当前是否有一轮可以停止：以管家给的权威运行状态为准，界面只做入口开关。 */
const roundStoppable = computed(() =>
  store.task.runState === 'running'
  || store.activeRun?.state === 'running'
  || ['queued', 'running', 'summarizing', 'waiting_user'].includes(store.task.state))

/**
 * 登录失效、无权限、契约不兼容时身份/接口已经不可信，写入口一律停用并给出可见原因
 * （再发写请求只会得到同一个拒绝，按「提示且不重试」处理）。断线（offline）不在此列：
 * 写请求走的是另一条连接，断流期间仍可能受理。
 */
const writeBlocked = computed(() => ['unauthorized', 'forbidden', 'incompatible'].includes(store.status))

/** 写入口禁用时的原因文案：不让用户对着不响应的输入框猜。 */
const writeBlockedReason = computed(() => {
  switch (store.status) {
    case 'unauthorized': return '需要登录后才能派活或回复，写入口已停用'
    case 'forbidden': return '没有访问权限，写入口已停用'
    case 'incompatible': return '管家接口版本不兼容，写入口已停用'
    default: return ''
  }
})

/**
 * 待重试提交的冻结正文摘要：pendingSubmit 存在期间草稿锁定、重试发送的是冻结
 * 正文而非输入框当前内容，摘要如实展示将要重发的那份，避免「显示新文本、发出旧正文」。
 */
const pendingSummary = computed(() => {
  const pending = store.pendingSubmit
  if (!pending) return ''
  const body = pending.kind === 'chat' ? pending.message : (pending.decideByAgent ? '让它自己拿主意' : pending.replyText)
  return body.length > 30 ? body.slice(0, 30) + '…' : body
})

const assignUsable = computed(() =>
  !store.submitting && !writeBlocked.value && store.pendingSubmit === null && store.assignDraft.trim() !== '')

const onAssign = () => { if (assignUsable.value) void session?.submitTask(store.assignDraft) }

const replyUsable = (subtaskId: string) =>
  !store.submitting && !writeBlocked.value && store.pendingSubmit === null && (store.replyDrafts[subtaskId] ?? '').trim() !== ''

const onReply = (subtaskId: string) => {
  if (replyUsable(subtaskId)) void session?.replySubtask(subtaskId, store.replyDrafts[subtaskId] ?? '')
}

const authHref = computed(() => {
  const path = session?.client.identity?.authPath ?? '/auth'
  return path + '?returnTo=' + encodeURIComponent(location.pathname)
})

const formatTime = (value: number): string => {
  if (!value) return ''
  const date = new Date(value)
  return `${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const onVisibility = () => { document.hidden ? session?.onHidden() : session?.onVisible() }

/** 唯一生效的就近提示：点击等价于按交互键（interaction_rules.yaml#hotkey 的同一条动作）。 */
const onPrompt = () => { session?.interactKey() }

/** 软键盘弹出时把输入框滚进可见区；真机未验证，只保证有焦点就把目标带进视野。 */
const onFocusIn = (event: FocusEvent) => {
  const target = event.target as HTMLElement | null
  target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
}

onMounted(() => {
  session = new GameSession({ parent: host.value!, assetsBase })
  detachViewport = installViewportHeight(window, document)
  document.addEventListener('visibilitychange', onVisibility)
  void session.start()
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  detachViewport?.()
  session?.stop()
})
</script>

<template>
  <main class="shell" :data-scene="store.worldMap">
    <section ref="host" class="game" aria-label="牛马办公楼"></section>

    <header class="hud" aria-label="状态与入口">
      <span class="badge" :data-status="store.status">{{ statusText }}</span>
      <span class="badge" data-map>{{ store.worldMap === 'office' ? '办公楼' : store.worldMap === 'street' ? '商业街' : store.worldMap === 'cafe' ? '咖啡店' : store.worldMap }}</span>
      <button v-if="!store.worldReady" class="badge" type="button" disabled>地图装载中…</button>
      <button class="book-toggle" type="button" @click="session?.openBook()">任务本</button>
    </header>

    <!-- 就近提示：同一时刻只有一个（interaction_rules.yaml#principles.single-prompt）；
         触发器都写着 requires.input_open: false，任务本开着时不渲染（会话已同步置空，这里再挡一次）。 -->
    <button
      v-if="store.prompt && !store.bookOpen" class="prompt" type="button" :data-prompt="store.prompt.id"
      :data-kind="store.prompt.kind" @click="onPrompt"
    >{{ store.prompt.label }}</button>

    <!-- 员工表现：只显示权威状态与权威正文气泡，不自造内容。 -->
    <section v-if="store.staff.length > 0" class="staff" aria-label="员工状态">
      <article v-for="member in store.staff" :key="member.id" :data-staff="member.id" :data-action="member.action">
        <header>
          <strong>{{ member.label }}</strong>
          <span class="state">{{ member.stateLabel }}</span>
          <span class="action">{{ member.actionLabel }}</span>
        </header>
        <p v-if="member.bubble" class="bubble">{{ member.bubble }}</p>
      </article>
    </section>

    <!-- 对白面板：普通 NPC 播放作者预写台词；员工只给名牌与真实状态，都没有自由输入。 -->
    <aside v-if="store.dialogue" class="dialogue" :data-dialogue="store.dialogue.kind" role="dialog" :aria-label="store.dialogue.title">
      <header>
        <strong>{{ store.dialogue.title }}</strong>
        <span v-if="store.dialogue.role" class="role">{{ store.dialogue.role }}</span>
        <button type="button" @click="session?.closeDialogue()">关闭</button>
      </header>
      <p class="state" :data-mode="store.dialogue.mode">{{ store.dialogue.stateLabel }}</p>
      <ul v-if="store.dialogue.lines.length > 0" class="lines">
        <li v-for="(line, index) in store.dialogue.lines" :key="index">{{ line }}</li>
      </ul>
      <p class="detail">{{ store.dialogue.detail }}</p>
    </aside>

    <p v-if="store.notice" class="toast" role="status" @click="store.notice = ''">{{ store.notice }}</p>

    <div v-if="store.status === 'unauthorized'" class="banner" role="alert">
      需要登录后才能查看任务。<a :href="authHref">前往登录</a>
    </div>
    <div v-else-if="store.status === 'forbidden'" class="banner" role="alert">
      {{ store.statusDetail || '没有访问权限' }}；地图移动不受影响。
    </div>
    <div v-else-if="store.status === 'incompatible'" class="banner" role="alert">
      管家接口版本不兼容，请更新游戏或管家后再试；地图移动不受影响。
    </div>

    <aside v-if="store.bookOpen" ref="book" class="task-book" aria-label="任务本" @focusin="onFocusIn">
      <header>
        <strong>任务本</strong>
        <button type="button" @click="session?.closeBook()">关闭</button>
        <button v-if="store.status === 'offline'" type="button" @click="session?.retry()">重试</button>
      </header>

      <nav class="conversations" aria-label="管家会话">
        <button
          v-for="conversation in store.conversations" :key="conversation.id" type="button"
          :class="{ active: conversation.id === store.selectedId }"
          @click="session?.selectConversation(conversation.id)"
        >
          <span class="title">{{ conversation.title || '未命名会话' }}</span>
          <span class="meta">{{ conversation.taskCount }} 个任务 · {{ formatTime(conversation.updatedAt) }}</span>
        </button>
        <p v-if="store.conversations.length === 0" class="empty">还没有管家会话</p>
      </nav>

      <section class="task" aria-label="当前任务">
        <form class="assign" @submit.prevent="onAssign">
          <label for="assign-goal">派活</label>
          <textarea
            id="assign-goal" v-model="store.assignDraft" rows="2"
            placeholder="要派什么活？一句话说清目标；与管家入口共享同一份任务"
            :disabled="store.submitting || store.pendingSubmit !== null || writeBlocked"
          ></textarea>
          <div class="assign-actions">
            <button type="submit" :disabled="!assignUsable">{{ store.submitting ? '提交中…' : '派活' }}</button>
            <button
              v-if="store.pendingSubmit" type="button" class="retry-submit"
              :disabled="store.submitting || writeBlocked" @click="session?.retrySubmit()"
            >重试提交</button>
          </div>
          <p v-if="writeBlockedReason" class="write-blocked" role="status" data-write-blocked>{{ writeBlockedReason }}</p>
          <p v-if="store.pendingSubmit" class="pending-hint" role="status">
            上次提交结果不明，输入区已锁定；重试将原样发送冻结内容「{{ pendingSummary }}」（管家按 requestId
            幂等，不会执行两次）。重试成功或被明确拒绝后恢复编辑。
          </p>
        </form>

        <template v-if="store.task.taskId">
          <h2>{{ store.task.goal || '（目标待管家给出）' }}</h2>
          <p class="state">
            <span class="badge" :data-state="store.task.state">{{ taskStateLabel(store.task.state) }}</span>
            <span v-if="store.task.runState && store.task.runState !== 'idle'" class="run">本轮：{{ store.task.runState }}</span>
            <button
              v-if="roundStoppable" type="button" class="stop"
              :disabled="store.submitting || writeBlocked" @click="session?.stopRound()"
            >停止本轮</button>
          </p>
          <p v-if="store.task.butlerText" class="butler">{{ store.task.butlerText }}</p>
          <ul class="subtasks">
            <li v-for="subtask in store.task.subtasks" :key="subtask.id" :data-state="subtask.state">
              <header>
                <strong>{{ subtask.displayName || subtask.id }}</strong>
                <span>{{ taskStateLabel(subtask.state) }}</span>
              </header>
              <p v-if="subtask.goal" class="goal">{{ subtask.goal }}</p>
              <p v-if="subtask.note" class="note">{{ subtask.note }}</p>
              <p v-if="subtask.uncertain" class="uncertain" role="status">此处正文与已落库内容的关系无法确认，可能重复</p>
              <p v-if="subtask.pending" class="pending">待办：{{ subtask.pending.reason }}</p>
              <details v-if="subtask.thinking">
                <summary>思考中…</summary>
                <pre>{{ subtask.thinking }}</pre>
              </details>
              <p v-if="subtask.text" class="text">{{ subtask.text }}</p>
              <form v-if="subtask.state === 'waiting_user'" class="reply" @submit.prevent="onReply(subtask.id)">
                <input
                  v-model="store.replyDrafts[subtask.id]" type="text"
                  placeholder="回一句话，这位成员继续干"
                  :disabled="store.submitting || store.pendingSubmit !== null || writeBlocked"
                >
                <button type="submit" :disabled="!replyUsable(subtask.id)">回复</button>
                <button
                  type="button" :disabled="store.submitting || writeBlocked"
                  @click="session?.replySubtask(subtask.id, '', true)"
                >让它自己拿主意</button>
              </form>
            </li>
          </ul>
          <p v-if="store.task.incomplete" class="incomplete" role="status">
            本轮更早的事件已滚出日志窗口，正文可能不完整；本轮结束后会自动按权威快照补取。
          </p>
          <p v-if="store.task.summary" class="summary">{{ store.task.summary }}</p>
          <p v-if="store.task.error" class="error" role="alert">{{ store.task.error }}</p>
        </template>
        <p v-else class="empty">{{ store.statusDetail || '这个会话还没有任务' }}</p>
      </section>

      <section class="history" aria-label="运行历史">
        <h3>运行历史</h3>
        <ul>
          <li v-for="item in store.history" :key="item.id" :data-state="item.state">
            <span class="goal">{{ item.goal || item.id }}</span>
            <span class="badge" :data-state="item.state">{{ taskStateLabel(item.state) }}</span>
          </li>
        </ul>
      </section>
    </aside>
  </main>
</template>
