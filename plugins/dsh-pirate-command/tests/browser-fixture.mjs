/** 仅用于浏览器验收：内存身份、本地模型和业务替身，无真实业务调用。 */
import { setTimeout as delay } from 'node:timers/promises'
import { fixture } from './fixture.mjs'

const workMs = Number(process.env.PIRATE_BROWSER_WORK_MS ?? 2200)
if (!Number.isFinite(workMs) || workMs < 100 || workMs > 20000) throw new Error('PIRATE_BROWSER_WORK_MS must be between 100 and 20000')
const f = await fixture({ browserLogin: true, timeoutMs: 60000,
  providers: ['closedoff', 'blog'].map(id => ({ id, async run(request) {
    request.onProgress({ kind: 'status', text: '本地验收夹具正在处理', conversationId: id + '-browser' })
    await delay(workMs, undefined, { signal: request.signal })
    return { status: id === 'blog' ? 'waiting' : 'completed', conversationId: id + '-browser',
      text: id === 'closedoff' ? '自造数据：两条示例记录；没有查询真实园区。' : '本地候选稿已准备；没有保存或发布真实文章。' }
  } })),
  model: async ({ assign, message, publishTopic }) => {
    if (message.content[0].text.includes('现在等谁')) return '等待你在原插件处理候选。此处是本地验收夹具。'
    await publishTopic(['自造数据', '博客候选'])
    const first = JSON.parse(await assign([{ crew: 'closedoff', message: '查询自造数据并汇总' }]))
    await assign([{ crew: 'blog', message: '按以下自造资料整理：' + first[0].text }])
    return '已完成本地夹具中的查询与整理，等待候选处理。'
  },
})
console.log(JSON.stringify({ scope: 'browser-with-model-and-business-doubles', url: f.origin + '/fixture-login' }))
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await f.close(); process.exit(0) })
