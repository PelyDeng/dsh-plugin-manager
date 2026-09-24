/**
 * 结果分组与卡片（旧 web/cards.js renderCards 的 React 数据驱动重写）。
 *
 * 结构化结果按业务主题分组（GROUP_ORDER 即排序），同组内保持 callId 到达顺序；
 * 每个查询一个 cards-block（头 + 卡片网格）。车辆概览组出数据后，其余组里以
 * 车牌为主键的卡片标题被抑制（旧 hasOverview 口径，避免同屏重复车牌大标题）。
 */
import { groupLabel, groupRank, toolLabel } from '../lib/labels.ts'
import type { ReactElement } from 'react'
import type { CardsPayload } from '../lib/types.ts'

const VEHICLE_TITLE_KEYS = ['carNum', 'carNumb', 'vehicleNo']

type CardItem = CardsPayload['cards'][number]

function countText(payload: CardsPayload): string {
  if (payload.state === 'loading') return '查询中'
  if (payload.state === 'error') return '查询失败'
  return `共 ${payload.count} 条`
}

function emptyText(state: string): string {
  if (state === 'loading') return '正在查询…'
  if (state === 'error') return '本次查询失败，可稍后重试'
  if (state === 'empty') return '本次查询未发现记录'
  return '已返回数据，暂无适合卡片展示的字段'
}

function FieldList({ fields }: { fields: CardItem['fields'] }): ReactElement {
  return (
    <dl className="co-fields">
      {fields.map((field, index) => (
        <div className="co-field-row" key={`${field.k}-${index}`}>
          <dt>{field.k}</dt>
          <dd className={field.tone === '' ? undefined : `co-tone-${field.tone}`}>{field.v}</dd>
        </div>
      ))}
    </dl>
  )
}

function MiniCard({ card, suppressTitle }: { card: CardItem; suppressTitle: boolean }): ReactElement {
  return (
    <article className="co-mini-card">
      {!suppressTitle && card.title !== '' && <h4 className="co-mini-card-title">{card.title}</h4>}
      <FieldList fields={card.fields} />
    </article>
  )
}

function SummaryCard({ card }: { card: CardItem }): ReactElement {
  const isMetric = (k: string): boolean => /次数|数量|总数|黑名单/.test(k)
  const attributes = card.fields.filter(field => !isMetric(field.k))
  const metrics = card.fields.filter(field => isMetric(field.k))
  return (
    <article className="co-summary-card">
      <h4 className="co-summary-title">{card.title}</h4>
      {attributes.length > 0 && (
        <dl className="co-summary-attributes">
          {attributes.map((field, index) => (
            <div className="co-summary-attribute" key={`${field.k}-${index}`}>
              <dt>{field.k}</dt>
              <dd className={field.tone === '' ? undefined : `co-tone-${field.tone}`}>{field.v}</dd>
            </div>
          ))}
        </dl>
      )}
      {metrics.length > 0 && (
        <dl className="co-summary-metrics">
          {metrics.map((field, index) => (
            <div className="co-summary-metric" key={`${field.k}-${index}`}>
              <dt>{field.k}</dt>
              <dd>{field.v}</dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  )
}

function CardsBlock({ payload, hasOverview }: { payload: CardsPayload; hasOverview: boolean }): ReactElement {
  return (
    <div className="co-cards-block">
      <div className="co-cards-head">
        <span>{payload.sourceLabel || toolLabel(payload.tool)}</span>
        <span className="co-cards-count">{countText(payload)}</span>
        {payload.note !== '' && <span className="co-cards-note">· {payload.note}</span>}
      </div>
      <div className="co-cards-grid">
        {payload.state !== 'data' || payload.cards.length === 0
          ? <div className="co-cards-empty">{emptyText(payload.state)}</div>
          : payload.cards.map((card, index) => (
            <MiniCard
              key={index}
              card={card}
              suppressTitle={hasOverview && payload.group !== 'overview'
                && card.titleKey !== undefined && VEHICLE_TITLE_KEYS.includes(card.titleKey)}
            />
          ))}
      </div>
    </div>
  )
}

function SummaryBlock({ payload }: { payload: CardsPayload }): ReactElement {
  return (
    <div className="co-cards-block">
      <div className="co-cards-head">
        <span>{payload.sourceLabel || toolLabel(payload.tool)}</span>
        <span className="co-cards-count">{countText(payload)}</span>
        {payload.note !== '' && <span className="co-cards-note">· {payload.note}</span>}
      </div>
      <div className="co-cards-grid">
        {payload.state !== 'data' || payload.cards.length === 0
          ? <div className="co-cards-empty">{emptyText(payload.state)}</div>
          : payload.cards.map((card, index) => <SummaryCard key={index} card={card} />)}
      </div>
    </div>
  )
}

export function ResultSections({ cards }: { cards: Record<string, CardsPayload> }): ReactElement | null {
  const payloads = Object.values(cards)
  if (payloads.length === 0) return null
  const hasOverview = payloads.some(payload => payload.group === 'overview' && payload.state === 'data')

  // 分组聚合：组间按 GROUP_ORDER，组内保持 callId 到达顺序。
  const groups = new Map<string, CardsPayload[]>()
  for (const payload of payloads) {
    const key = payload.group || 'other'
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [payload])
    else bucket.push(payload)
  }
  const ordered = [...groups.entries()].sort(([left], [right]) => groupRank(left) - groupRank(right))

  return (
    <div className="co-results">
      {ordered.map(([group, items]) => {
        const allEmpty = items.length > 0 && items.every(payload => payload.state === 'empty')
        return (
          <section className={`co-result-section co-result-section--${group}`} key={group}>
            <h3 className="co-result-section-title">{groupLabel(group)}{allEmpty ? ' · 无记录' : ''}</h3>
            <div className="co-result-section-body">
              {items.map((payload, index) => payload.variant === 'summary'
                ? <SummaryBlock key={index} payload={payload} />
                : <CardsBlock key={index} payload={payload} hasOverview={hasOverview} />)}
            </div>
          </section>
        )
      })}
    </div>
  )
}
