/**
 * 解析器的**输入形态**：同一份数据，TEXT（旧库）与 JSONB（新库）必须给出**同一结论**。
 *
 * 背景：新库的 `artifacts` / `input_refs` / `member_return` / `verdict_evidence` / `observation`
 * 是 **JSONB**，pg 驱动直接返回数组/对象、**不是文本**；而插件自带的旧表是 TEXT。老实现一律
 * `JSON.parse(raw)`，拿到对象会抛 ⇒ 三种各不相同、全部静默或误导的后果：
 *
 * - `parseInputRefs` ⇒ `damaged` ⇒ 编排层**拒派**（而数据其实完全正常）；
 * - `parseArtifacts` ⇒ 返回 `[]` ⇒ **"有材料"变"没材料"**；
 * - `parseMemberReturn` ⇒ `undefined` ⇒ 自检、外部待办、协作原文**全丢**。
 *
 * 判据：**对每一对（JSON 文本, 等价的对象/数组）断言结果逐字相同**。
 * 变异（把 `typeof raw === 'string'` 那个分支去掉、退回一律 `JSON.parse`）⇒ 本文件里"对象"
 * 那一半必须红——这正是切库前必须先改解析的原因（交接文档 §35 的切库静默面）。
 */
import { describe, expect, it } from 'vitest'
import {
  parseArtifacts,
  parseDependsOn,
  parseDependsOnStrict,
  parseInputRefs,
  parseMemberReturn,
} from '../src/storage/parse.ts'

/** 一份合法的材料引用快照（`parseInputRefs` 的强校验会逐层核验到这条形状）。 */
const REF = {
  subtaskId: 's1',
  logicalId: 'g1',
  state: 'succeeded',
  text: '查完了',
  artifacts: [{ title: '园区概览', path: '/agents/closedoff', kind: 'report' }],
}

/** 一份合法的协作返回留存（自检四态 + 结构化外部待办）。 */
const MEMBER_RETURN = {
  protocol: 1,
  text: '在线 42 台',
  externalPending: { reason: '等发布' },
  selfCheck: { status: 'absent', detail: '缺省不等于通过' },
}

describe('解析器：TEXT（旧库）与 JSONB（新库）必须同结论', () => {
  it('parseInputRefs：数组输入与 JSON 文本同结论', () => {
    const fromText = parseInputRefs(JSON.stringify([REF]), true)
    const fromJsonb = parseInputRefs([REF], true)
    expect(fromJsonb).toEqual(fromText)
    expect(fromText.kind).toBe('fixed')
    expect(fromText.inputRefs).toHaveLength(1)
  })

  it('parseInputRefs：空值（空串 / null / undefined）与"没落过值"同结论', () => {
    for (const empty of ['', null, undefined]) {
      expect(parseInputRefs(empty, true)).toEqual({ kind: 'unfixed' })
      expect(parseInputRefs(empty, false)).toEqual({ kind: 'unknown' })
    }
  })

  it('parseMemberReturn：对象输入与 JSON 文本同结论（自检与外部待办都不能丢）', () => {
    const fromText = parseMemberReturn(JSON.stringify(MEMBER_RETURN))
    const fromJsonb = parseMemberReturn(MEMBER_RETURN)
    expect(fromJsonb).toEqual(fromText)
    expect(fromText?.selfCheck?.status).toBe('absent')
    expect(fromText?.externalPending?.reason).toBe('等发布')
  })

  it('parseMemberReturn：空值与非法形状都按"没有结论"处理，不补造', () => {
    for (const empty of ['', null, undefined]) expect(parseMemberReturn(empty)).toBeUndefined()
    expect(parseMemberReturn(42)).toBeUndefined()
    expect(parseMemberReturn({ protocol: 1 })).toBeUndefined()
  })

  it('parseArtifacts：数组输入与 JSON 文本同结论（不许"有材料"变"没材料"）', () => {
    const list = [{ title: '稿子', path: '/agents/blog', kind: 'draft' }]
    expect(parseArtifacts(list)).toEqual(parseArtifacts(JSON.stringify(list)))
    expect(parseArtifacts(list)).toHaveLength(1)
    for (const empty of ['', null, undefined]) expect(parseArtifacts(empty)).toEqual([])
  })

  it('parseDependsOn / parseDependsOnStrict：数组输入与 JSON 文本同结论', () => {
    const ids = ['g1', 'g2']
    expect(parseDependsOn(ids)).toEqual(parseDependsOn(JSON.stringify(ids)))
    expect(parseDependsOnStrict(ids)).toEqual(parseDependsOnStrict(JSON.stringify(ids)))
    expect(parseDependsOnStrict(ids)).toEqual({ kind: 'valid', items: ids })
    for (const empty of ['', null, undefined]) {
      expect(parseDependsOn(empty)).toEqual([])
      expect(parseDependsOnStrict(empty)).toEqual({ kind: 'valid', items: [] })
    }
  })

  it('损坏判定不因输入形态而变：两种形态下都是 damaged', () => {
    const badDepends = ['g1', 42]
    expect(parseDependsOnStrict(badDepends)).toEqual({ kind: 'damaged', items: [] })
    expect(parseDependsOnStrict(JSON.stringify(badDepends))).toEqual({ kind: 'damaged', items: [] })

    const badRef = [{ subtaskId: 's1' }]
    expect(parseInputRefs(badRef, true)).toEqual({ kind: 'damaged' })
    expect(parseInputRefs(JSON.stringify(badRef), true)).toEqual({ kind: 'damaged' })
  })
})
