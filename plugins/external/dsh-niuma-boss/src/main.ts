/**
 * 组装入口：只创建 Vue 应用与 Pinia，挂载界面。会话、管家客户端与 Phaser 场景
 * 的接线在 GameSession 内，业务规则不进这个文件。
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css'

createApp(App).use(createPinia()).mount('#app')
