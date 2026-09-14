<script setup lang="ts">
/**
 * GameUI 的外壳：Phaser 挂载点 + 任务本/连接提示叠层。会话在本组件挂载后组装
 * （需要真实的 DOM 挂载点），业务接线全部在 GameSession 内，这里只有界面意图转发。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useTaskBookStore } from './store'
import { GameSession } from './game-session'
import { taskStateLabel } from './task-projection'

const store = useTaskBookStore()
const host = ref<HTMLElement>()
let session: GameSession | undefined

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

onMounted(() => {
  session = new GameSession({ parent: host.value!, assetsBase })
  document.addEventListener('visibilitychange', onVisibility)
  void session.start()
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  session?.stop()
})
</script>

<template>
  <main class="shell" data-scene="office">
    <section ref="host" class="game" aria-label="牛马办公楼"></section>

    <header class="hud" aria-label="状态与入口">
      <span class="badge" :data-status="store.status">{{ statusText }}</span>
      <button v-if="!store.worldReady" class="badge" type="button" disabled>地图装载中…</button>
      <button class="book-toggle" type="button" @click="session?.openBook()">任务本</button>
    </header>

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

    <aside v-if="store.bookOpen" class="task-book" aria-label="任务本">
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
        <template v-if="store.task.taskId">
          <h2>{{ store.task.goal || '（目标待管家给出）' }}</h2>
          <p class="state">
            <span class="badge" :data-state="store.task.state">{{ taskStateLabel(store.task.state) }}</span>
            <span v-if="store.task.runState && store.task.runState !== 'idle'" class="run">本轮：{{ store.task.runState }}</span>
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
