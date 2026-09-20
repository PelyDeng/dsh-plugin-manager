/**
 * 页面常量（拆分设计 v2 批 1a）：配色、头像清单、状态文案、轨道标记、开场话题与存储键。
 * 纯数据、零依赖（依赖图最底层）。
 */
/** 成员配色：按 agentId 稳定取色，所以同一个插件每次都是同一个颜色。 */
export const PALETTE = ['#4d96ff', '#2ec4a6', '#ff6b57', '#9b5de5', '#ffb703', '#e8709a']

/**
 * 默认涂鸦头像：已知插件映射到 web/media/avatars/ 下的生成素材；上传过头像的用户看不到它们。
 * 没有映射的成员退回首字配色圆，页面不因为多接了一个插件就缺图。
 */
export const DEFAULT_AVATAR_FILES = new Map([
  ['butler', 'avatar-butler.png'],
  ['blog', 'avatar-blog.png'],
  ['closedoff', 'avatar-closedoff.png'],
  ['__boss__', 'avatar-boss.png'],
])

/** 内置头像清单：预生成的 15 个涂鸦形象，设置页里一键换上。 */
export const BUILTIN_AVATARS = [
  { file: 'builtin-01.png', label: '柴犬' },
  { file: 'builtin-02.png', label: '猫咪' },
  { file: 'builtin-03.png', label: '熊猫' },
  { file: 'builtin-04.png', label: '兔子' },
  { file: 'builtin-05.png', label: '青蛙' },
  { file: 'builtin-06.png', label: '小鸡' },
  { file: 'builtin-07.png', label: '猫头鹰' },
  { file: 'builtin-08.png', label: '机器人' },
  { file: 'builtin-09.png', label: '云朵' },
  { file: 'builtin-10.png', label: '太阳' },
  { file: 'builtin-11.png', label: '咖啡' },
  { file: 'builtin-12.png', label: '书本' },
  { file: 'builtin-13.png', label: '信封' },
  { file: 'builtin-14.png', label: '蜗牛' },
  { file: 'builtin-15.png', label: '草莓' },
]

export const STATE_TEXT = {
  queued: '排队中',
  dispatched: '已收到',
  running: '在干活',
  waiting_user: '等你回话',
  external_pending: '待外部处理',
  partial: '部分完成',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已停止',
  summarizing: '在写总结',
  completed: '已完成',
}

/** 协同链路：页面上的每一步都能追到一次真实事件。 */
export const RAIL_STEPS = [
  { key: 'ask', label: '提需求' },
  { key: 'parse', label: '听懂' },
  { key: 'dispatch', label: '分派' },
  { key: 'work', label: '执行' },
  { key: 'sum', label: '汇总' },
]

/** 链路徽章里的小图标：纯静态标记，不含任何用户数据。 */
export const SVG_NS = 'http://www.w3.org/2000/svg'

export const RAIL_ICON_PATHS = {
  ask: '<path d="M2.5 6.8 9 3.4 9 12.6 2.5 9.4 Z" fill="currentColor"/><path d="M11 6.1 C 12.4 6.7, 12.4 9.3, 11 9.9 M4.6 9.9 5.3 13.2 7.1 12.8 6.4 10.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  parse: '<path d="M3 4.6 C 3 3.4, 3.9 2.6, 5 2.6 L 11 2.6 C 12.1 2.6, 13 3.4, 13 4.6 L 13 8.4 C 13 9.5, 12.1 10.4, 11 10.4 L 8.4 10.4 6 12.6 6.1 10.4 L 5 10.4 C 3.9 10.4, 3 9.5, 3 8.4 Z" fill="currentColor"/>',
  dispatch: '<rect x="4.2" y="3.2" width="7.6" height="10" rx="1.4" fill="currentColor"/><rect x="6" y="1.8" width="4" height="2.8" rx="1" fill="currentColor"/><path d="M6 7 10 7 M6 9.4 9.2 9.4" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/>',
  work: '<circle cx="8" cy="8" r="3" fill="currentColor"/><path d="M8 1.8 8 3.4 M8 12.6 8 14.2 M1.8 8 3.4 8 M12.6 8 14.2 8 M3.6 3.6 4.7 4.7 M11.3 11.3 12.4 12.4 M12.4 3.6 11.3 4.7 M4.7 11.3 3.6 12.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  sum: '<path d="M3.5 8.6 6.6 11.6 12.6 4.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
}

/** 静态涂鸦小件（都是固定标记，不含用户数据），集中一处方便核对。 */
export const DOODLE_PATHS = {
  /** 使用者头像：简笔人脸 + 领带。 */
  bossFace: '<circle cx="12" cy="8.6" r="4.4" fill="#fff" stroke="#3d3630" stroke-width="1.6"/><path d="M10.4 8.2 10.4 8.3 M13.6 8.2 13.6 8.3" stroke="#3d3630" stroke-width="1.8" stroke-linecap="round"/><path d="M10.6 10.4 C 11.4 11, 12.6 11, 13.4 10.4" fill="none" stroke="#3d3630" stroke-width="1.2" stroke-linecap="round"/><path d="M5.2 20.4 C 6.6 16.8, 9 15.2, 12 15.2 C 15 15.2, 17.4 16.8, 18.8 20.4 Z" fill="#fff" stroke="#3d3630" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 15.4 10.9 16.9 12 19.2 13.1 16.9 Z" fill="#ff6b57" stroke="#3d3630" stroke-width="1"/>',
  /** 链路条之间的歪箭头。 */
  railArrow: '<path d="M1.5 6.5 C 6 5.4, 11 5.7, 20.5 6.2 M16.5 2.6 C 18.2 4, 19.7 5.2, 21.8 6.2 C 19.8 7.2, 18.2 8.4, 16.6 10" fill="none" stroke="#b9ad9c" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
}

/** 开场示例话题：只写群里真有人能接的活，免得用户照着问了却没人接。 */
/** 快捷问答：撕条上写短标签，点击把完整话填进输入框——撕一条拿去用。 */
export const SUGGESTIONS = [
  { label: '园区介绍', text: '整理一篇园区封闭化管理介绍，再给点博客发布建议' },
  { label: '查通行情况', text: '查一下园区最近的通行情况，顺便说说异常' },
  { label: '归拢周报', text: '把这周的零散材料归拢成一篇周报' },
  { label: '博客选题', text: '给我的博客挑三个可写的选题' },
  { label: '盯通报', text: '盯着园区通报，有异常随时叫我' },
  { label: '捋今日跟进', text: '帮我捋一遍今天该跟进没跟进的事' },
]

export const MOTTO_KEY = 'butler.motto'
export const DEFAULT_MOTTO = '没关系，牛再来！换个姿势再来！'
/** 上次用过的会话。刷新后要拿它去问「这一轮还在跑吗」。 */
export const CONVERSATION_KEY = 'butler.conversationId'

/**
 * 流式正文逐帧重渲的字符上限（设计 v2 §4.3）：模型正文没有服务端上限（maxMessageChars
 * 只约束用户输入），超长输出放弃逐帧 Markdown 重渲、降级为纯文本追加，终态照常排版。
 */
export const STREAM_RICH_LIMIT = 12000
