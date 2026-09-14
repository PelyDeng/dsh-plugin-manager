<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useConnectionStore } from './store'
import { ButlerClient } from './butler-client'
import { metrics, startGame } from './game'

const canvasHost = ref<HTMLElement>()
const composing = ref(false), focused = ref(false), text = ref('中文输入验证'), npc = ref('')
const store = useConnectionStore()
const gameMetrics = reactive({ ...metrics })
const orientation = ref(innerWidth >= innerHeight ? '横屏' : '竖屏')
const inputLocked = computed(() => composing.value || focused.value)
let client: ButlerClient
let game: ReturnType<typeof startGame> | undefined
let timer = 0
const onResize = () => { orientation.value = innerWidth >= innerHeight ? '横屏' : '竖屏' }
const onNpc = (event: Event) => { npc.value = (event as CustomEvent<string>).detail }
const connect = async () => {
  client = new ButlerClient(location.origin, '/butler', () => Object.assign(store, client.state))
  try { await client.start(); void client.observe() } catch (error) { store.connection = String(error) }
}
const visibility = () => {
  if (document.hidden) { client?.stop(); game?.scene.pause('office-validation') }
  else { game?.scene.resume('office-validation'); void connect() }
}
onMounted(() => {
  game = startGame(canvasHost.value!, () => inputLocked.value)
  addEventListener('resize', onResize)
  addEventListener('validation-npc', onNpc)
  document.addEventListener('visibilitychange', visibility)
  void connect()
  timer = window.setInterval(() => Object.assign(gameMetrics, metrics), 250)
})
onBeforeUnmount(() => { client?.stop(); game?.destroy(true); clearInterval(timer); removeEventListener('resize', onResize); removeEventListener('validation-npc', onNpc); document.removeEventListener('visibilitychange', visibility) })
</script>

<template>
  <main :class="['shell', orientation === '竖屏' && 'portrait']" data-testid="validation-root">
    <section ref="canvasHost" class="game" aria-label="Phaser 办公楼验证场景"></section>
    <section class="hud" aria-label="Vue DOM 验证叠层">
      <header><strong>牛马-老板技术验证</strong><span data-testid="orientation">{{ orientation }}</span></header>
      <div class="metrics">
        <span>连接：{{ store.connection }}</span><span>seq {{ store.sequence }}</span><span>reset {{ store.resets }}</span>
        <span>{{ gameMetrics.fps.toFixed(1) }} FPS · p95 {{ gameMetrics.frameP95Ms.toFixed(1) }}ms</span><span>寻路峰值 {{ gameMetrics.pathMaxFrameMs.toFixed(2) }}ms</span>
        <span>{{ gameMetrics.characters }} 人 · {{ gameMetrics.effects }} 特效</span>
      </div>
      <label>中文输入
        <input v-model="text" data-testid="ime-input" @focus="focused = true" @blur="focused = false" @compositionstart="composing = true" @compositionend="composing = false">
      </label>
      <output data-testid="input-state">{{ inputLocked ? '游戏键盘已锁定' : '游戏键盘可用' }} · {{ text }}</output>
      <button @click="game?.events.emit('validation-stress')">加载 11 人与 48 个动画特效</button>
      <p v-if="npc" aria-live="polite">{{ npc }}：此处仅验证点击命中，预写对白接入留待第五阶段。</p>
      <p v-if="gameMetrics.error" role="alert">{{ gameMetrics.error }}</p>
      <details><summary>验证指标</summary><pre data-testid="protocol">{{ JSON.stringify({ ...store.$state, ...gameMetrics }, null, 2) }}</pre></details>
    </section>
  </main>
</template>
