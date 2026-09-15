import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const persona = readFileSync(fileURLToPath(new URL('../persona.txt', import.meta.url)), 'utf8')

describe('closed-off assistant persona', () => {
  it('limits query reuse to one user question instead of the whole conversation', () => {
    expect(persona).toContain('同一条用户问题所启动的当前回答回合内')
    expect(persona).toContain('当前回合已有成功结果时直接复用')
    expect(persona).not.toContain('复用本会话中已查询到的结果')
    expect(persona).toContain('用户发送新的问题时，即使内容与历史问题相同，也必须重新查询')
  })

  it('keeps the final answer concise while narrowing cached positions to current-state questions', () => {
    expect(persona).toContain('页面展示的思考过程必须使用中文')
    expect(persona).toContain('查询规划、工具选择、异常判断和结果分析')
    expect(persona).toContain('内部确定所需查询后直接调用')
    expect(persona).toContain('最终回答只写影响业务判断的结论、异常、风险和建议')
    expect(persona).toContain('不复述卡片字段')
    expect(persona).toContain('不输出完整身份证号、手机号、媒体地址或内部标识')
    expect(persona).toContain('最终回答不要重复输出该标题')
    expect(persona).toContain('正文最多 5 个短要点')
    expect(persona).toContain('跨模块矛盾、异常风险、数据缺口和下一步处置建议')
    expect(persona).toContain('不要因“最近/历史/所有信息”自动调用')
    expect(persona).toContain('返回的是缓存最新位置')
  })

  it('defines the complete vehicle query set without repeating modules', () => {
    expect(persona).toContain('车辆综合查询、白名单、黑名单、车辆出入记录、车辆轨迹、车辆轨迹视频、预警报警和电子运单')
    expect(persona).toContain('电子运单返回预约 ID 时，再调用一次预约详情')
    expect(persona).toContain('优先并行调用不互相依赖的查询')
    expect(persona).toContain('不要回答“如需轨迹请另行告知”')
  })
})
