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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useTaskBookStore } from './store'
import { GameSession } from './game-session'
// 状态文案：投影的映射 + labels 里补的三个英文 token（dispatched/executing/succeeded）。
import { stateLabel as taskStateLabel } from './labels'
import { installViewportHeight } from './viewport'
// 受控 md 渲染（拷贝自 agents/web-common,那边是唯一权威）:原始记录弹窗按原格式渲染交回正文。
import { renderMarkdownInto } from './vendor/markdown.js'

const store = useTaskBookStore()
const shell = ref<HTMLElement>()
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

/** 轻提示自动消失（F2/A3）：每条 notice 展示 3.5s 后清空，不再驻留叠在新面板上。 */
let noticeTimer: ReturnType<typeof setTimeout> | undefined
watch(() => store.notice, text => {
  if (noticeTimer) clearTimeout(noticeTimer)
  if (text === '') return
  noticeTimer = setTimeout(() => { store.notice = '' }, 3500)
})

/** 员工卡正文默认收起（F3/A4）：流式草稿可能整屏长，点击展开/收起。 */
const expandedStaff = ref(new Set<string>())
const toggleStaff = (id: string) => {
  const next = new Set(expandedStaff.value)
  next.has(id) ? next.delete(id) : next.add(id)
  expandedStaff.value = next
}

/** 子任务正文/草稿默认限高（F3）：点击展开全文，再点收起；流式更新保持已选状态。 */
const expandedTexts = ref(new Set<string>())
const toggleText = (key: string) => {
  const next = new Set(expandedTexts.value)
  next.has(key) ? next.delete(key) : next.add(key)
  expandedTexts.value = next
}

/** 任务终态：completed/failed/cancelled 时不再展示「本轮： running」这类运行中态（F4）。 */
const roundFinished = computed(() => ['completed', 'failed', 'cancelled'].includes(store.task.state))

/** 头顶气泡定位（F2）：game-world 节流上报的视口坐标直写 DOM，不走 Vue 响应式。 */
const bubbleLayer = ref<HTMLElement>()
const applyActorScreens = (screens: readonly { id: string; x: number; y: number }[]) => {
  const layer = bubbleLayer.value
  if (!layer) return
  for (const screen of screens) {
    const el = layer.querySelector<HTMLElement>('[data-actor-id="' + screen.id + '"]')
    if (el) el.style.transform = 'translate(' + screen.x + 'px,' + screen.y + 'px)'
  }
}

/** 原始记录弹窗（F3）：该成员全部子任务的交回正文按 md 渲染;Esc/遮罩/按钮关闭。 */
const recordBody = ref<HTMLElement>()
watch(() => [store.recordModal, store.task.subtasks] as const, async ([modal]) => {
  if (!modal) return
  await nextTick()
  const container = recordBody.value
  if (!container) return
  container.innerHTML = ''
  const mine = store.task.subtasks.filter(s => s.agentId === modal.memberId)
  if (mine.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'record-empty'
    empty.textContent = '还没有交回的正文;派活后成员交回的内容会按原格式显示在这里。'
    container.appendChild(empty)
    return
  }
  for (const subtask of [...mine].reverse()) {
    const head = document.createElement('h3')
    head.className = 'record-goal'
    head.textContent = subtask.goal || subtask.displayName || subtask.id
    const state = document.createElement('span')
    state.className = 'record-state'
    state.textContent = taskStateLabel(subtask.state)
    head.appendChild(state)
    container.appendChild(head)
    const body = document.createElement('div')
    body.className = 'record-text'
    if (subtask.text) {
      try {
        renderMarkdownInto(body, subtask.text)
      } catch {
        body.textContent = subtask.text
      }
    } else {
      body.className += ' record-text-empty'
      body.textContent = '（这条子任务还没有交回正文）'
    }
    container.appendChild(body)
  }
})

/** 键盘直达:Esc 逐层关(记录弹窗→对白面板);对白打开时按方向键 = 想离开,自动收起面板(轮1 P1)。 */
const onRecordKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    if (store.recordModal) session?.closeRecord()
    else if (store.dialogue) session?.closeDialogue()
    return
  }
  if (store.dialogue && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(event.code)) {
    session?.closeDialogue()
  }
}

/** 软键盘弹出时把输入框滚进可见区；真机未验证，只保证有焦点就把目标带进视野。 */
const onFocusIn = (event: FocusEvent) => {
  const target = event.target as HTMLElement | null
  target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
}

onMounted(() => {
  session = new GameSession({ parent: host.value!, stageHost: shell.value, assetsBase, onActorScreens: applyActorScreens })
  detachViewport = installViewportHeight(window, document)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('keydown', onRecordKeydown)
  void session.start()
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('keydown', onRecordKeydown)
  if (noticeTimer) clearTimeout(noticeTimer)
  detachViewport?.()
  session?.stop()
})
</script>

<template>
  <main ref="shell" class="shell" :data-scene="store.worldMap">
    <section ref="host" class="game" aria-label="牛马办公楼"></section>

    <!-- 装载期中央提示：首屏与切图空档都不留空白画面（G3）。 -->
    <div v-if="!store.worldReady" class="stage-loading" role="status">地图装载中…</div>

    <!-- 头顶气泡层（F2/F4）：定位由 game-world 节流直写 transform;点击员工气泡出原始记录弹窗,
         点击 NPC 台词气泡开完整对白面板。层本身不拦截地图点击,气泡自身可点。 -->
    <div ref="bubbleLayer" class="bubble-layer" aria-live="polite">
      <button
        v-for="member in store.staff" :key="'b-' + member.id" type="button"
        class="bubble staff-bubble" :data-actor-id="member.id"
        :title="'点击查看 ' + member.label + ' 的原始记录'"
        @click.stop="session?.openRecord(member.id, member.label)"
      >
        <span class="bubble-head">{{ member.label }} · {{ member.stateLabel }}</span>
        <span class="bubble-line">{{ member.bubble || member.actionLabel }}</span>
      </button>
      <button
        v-if="store.npcAutoBubble" type="button"
        class="bubble npc-bubble" :data-actor-id="store.npcAutoBubble.id"
        :title="'点击打开 ' + store.npcAutoBubble.label + ' 的完整对话'"
        @click.stop="session?.openNpcDialogue(store.npcAutoBubble.id)"
      >
        <span class="bubble-head">{{ store.npcAutoBubble.label }}<i v-if="store.npcAutoBubble.hasMore"> · E 看全部</i></span>
        <span class="bubble-line">{{ store.npcAutoBubble.line }}</span>
      </button>
    </div>

    <!-- 原始记录弹窗（F3）：成员交回正文按受控 md 渲染,支持 Esc/遮罩/按钮关闭。 -->
    <div v-if="store.recordModal" class="record-modal" role="dialog" :aria-label="store.recordModal.label + ' 的原始记录'" @click.self="session?.closeRecord()">
      <section class="record-panel">
        <header>
          <strong>{{ store.recordModal.label }} · 原始记录</strong>
          <button type="button" @click="session?.closeRecord()">关闭</button>
        </header>
        <div ref="recordBody" class="record-md"></div>
      </section>
    </div>

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
        <!-- 正文气泡已上角色头顶(F2),卡片只留状态行;点击头顶气泡看原始记录。 -->
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
            <!-- 任务已到终态时不再展示运行中态（F4）：「已完成 本轮： running」是状态矛盾。 -->
            <span v-if="store.task.runState && store.task.runState !== 'idle' && !roundFinished" class="run">本轮：{{ store.task.runState }}</span>
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
              <p
                v-if="subtask.text" class="text" :data-expanded="expandedTexts.has(subtask.id) ? 'true' : 'false'"
                @click="toggleText(subtask.id)"
              >{{ subtask.text }}</p>
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
