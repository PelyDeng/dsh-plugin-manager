/** 页面常量（自 web/modules/config.js 按需迁移，批 1 只带 React 侧消费的子集）。 */

/** 成员配色：按 agentId 稳定取色，同一个成员每次都是同一个颜色。 */
export const PALETTE = ['#4d96ff', '#2ec4a6', '#ff6b57', '#9b5de5', '#ffb703', '#e8709a']

/** 默认涂鸦头像：已知插件映射到 web/media/avatars/ 下的生成素材（资产路径不变，方案 §6.1）。 */
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

export const MOTTO_KEY = 'butler.motto'
export const DEFAULT_MOTTO = '没关系，牛再来！换个姿势再来！'
/** 上次用过的会话。刷新后要拿它去问「这一轮还在跑吗」。 */

/**
 * 流式正文逐帧重渲的字符上限（与旧前端同值）：超长输出放弃逐帧 Markdown 重渲、
 * 降级为纯文本追加，终态照常排版。分级判断在调用方（方案 §3.4）。
 */
export const STREAM_RICH_LIMIT = 12000

/** 开场示例话题（撕条）：点击把完整话填进输入框。 */
export const SUGGESTIONS = [
  { label: '园区介绍', text: '整理一篇园区封闭化管理介绍，再给点博客发布建议' },
  { label: '查通行情况', text: '查一下园区最近的通行情况，顺便说说异常' },
  { label: '归拢周报', text: '把这周的零散材料归拢成一篇周报' },
  { label: '博客选题', text: '给我的博客挑三个可写的选题' },
  { label: '盯通报', text: '盯着园区通报，有异常随时叫我' },
  { label: '捋今日跟进', text: '帮我捋一遍今天该跟进没跟进的事' },
]
