/**
 * 思考区（旧 chat-ui.js thinking + thinking-translation.js 面板的 React 化）。
 *
 * 展示语义逐条对齐旧码（updateThinking + render）：
 * - needsChineseTranslation 不命中：正文显示原文（旧 updateThinking(details, text)）。
 * - 命中且无 sourceId（live 推理流）：正文显示占位「正在生成思考，稍后整理中文译文…」，
 *   不发起请求（旧 watch 的 binding 无 entry 分支）。
 * - 命中且有 sourceId、正文已生成（done）：发起/复用译文请求，正文显示译文或
 *   「正在整理中文译文…」，失败给「重试译文」；原文折叠可查（qa-thinking-original）。
 * - 「中文译文」徽章只在译文就绪时出现；note 行与译文用量（details 折叠）同旧码。
 */
import { useEffect, useMemo } from 'react'
import { formatMs } from '../../lib/labels.ts'
import {
  needsChineseTranslation as textNeedsTranslation,
  translationKeyOf,
  useTranslationStore,
} from '../../lib/thinking-translation.ts'
import type { ReactElement } from 'react'
import { DshIcon } from '../DshIcon.tsx'

/** 思考预览行（旧 reasoningLine：最后一行非空占位；流式期在 summary 上）。 */
export function reasoningPreviewLine(text: string): string {
  const lines = String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(line => line !== '' && line !== '正在生成…')
  return lines.at(-1) ?? '正在生成…'
}

const LOADING_LIVE = '正在生成思考，稍后整理中文译文…'
const LOADING_SAVED = '正在整理中文译文…'
const FAILED_TEXT = '中文译文暂不可用；可以重试或查看原文。'
const NOTE_PENDING = '中文译文单独生成，不影响正文回答。'

export function ThinkingBlock({ text, running, defaultOpen = false, conversationId, sourceId, done = true }: {
  text: string
  /** 流式进行中（旧 updateThinking 的 running：点状动画）。 */
  running: boolean
  defaultOpen?: boolean
  /** 译文整理上下文：conversationId + sourceId（已保存思考的定位）+ done。 */
  conversationId?: string | undefined
  sourceId?: string | undefined
  done?: boolean
}): ReactElement {
  const watch = useTranslationStore(state => state.watch)
  const retry = useTranslationStore(state => state.retry)
  const entries = useTranslationStore(state => state.entries)
  const canTranslate = conversationId !== undefined && conversationId !== ''
  const key = useMemo(() => (canTranslate ? translationKeyOf(conversationId ?? '', sourceId, text) : ''), [canTranslate, conversationId, sourceId, text])

  // 上报观察（旧 watch）：键变化（流式文本增长/来源定位出现）时重新评估。
  useEffect(() => {
    if (!canTranslate || text === '') return
    watch({ text, conversationId: conversationId ?? '', ...(sourceId === undefined ? {} : { sourceId }), done })
  }, [canTranslate, watch, text, conversationId, sourceId, done])

  const entry = canTranslate && key !== '' ? entries[key] : undefined
  const translated = entry?.state === 'done' && entry.result?.status === 'translated'
  // 正文文案（旧 render 的 copy 选择链）。不需要整理时显示原文。
  const needs = canTranslate ? textNeedsTranslation(text) : false
  let bodyText = text
  if (needs) {
    if (translated) bodyText = entry?.result?.text ?? ''
    else if (entry?.state === 'failed') bodyText = FAILED_TEXT
    else if (sourceId !== undefined) bodyText = LOADING_SAVED
    else if (!done) bodyText = LOADING_LIVE
    else bodyText = LOADING_SAVED
  }

  const note = translated
    ? `上方为中文译文，模型原文保持不变。${entry?.result?.partial === true ? '原文已中断，仅翻译已保存部分。' : ''}`
    : entry?.state === 'failed'
      ? entry.error
      : NOTE_PENDING

  return (
    <details className={`blg-thinking${running ? ' blg-thinking--running' : ''}`} open={defaultOpen} data-thinking-key={key || undefined}>
      <summary>
        <DshIcon name="think" size={14} />
        <span className="blg-thinking-title">思考</span>
        {translated && <span className="blg-translation-badge">中文译文</span>}
        <span className="blg-thinking-preview">{needs ? (translated || entry?.state === 'failed' || !running ? reasoningPreviewLine(bodyText) : '中文译文整理中…') : reasoningPreviewLine(text)}</span>
      </summary>
      <div className="blg-thinking-body">{bodyText}</div>
      {needs && (
        <div className="blg-translation-panel">
          <p className="blg-translation-note">{note}</p>
          {entry?.state === 'failed' && sourceId !== undefined && (
            <button type="button" className="btn btn--tiny" onClick={() => retry(key)}>重试译文</button>
          )}
          <details className="blg-thinking-original">
            <summary>查看模型原文</summary>
            <pre>{text}</pre>
          </details>
          {translated && entry?.result !== null && entry?.result !== undefined && (
            <details className="blg-meta blg-translation-usage">
              <summary aria-label="译文用量" title="译文用量">
                <DshIcon name="database" size={14} />
                <span>译文用量</span>
              </summary>
              <div className="blg-meta-body">
                <strong>译文用量</strong>
                <dl>
                  <TranslationUsageRows entry={entry} />
                </dl>
              </div>
            </details>
          )}
        </div>
      )}
    </details>
  )
}

function TranslationUsageRows({ entry }: { entry: { result: { provider?: string | undefined; model?: string | undefined; usage?: Record<string, number> | null | undefined; elapsedMs?: number | undefined; createdAt?: number | undefined } | null } }): ReactElement {
  const result = entry.result
  const usage = result?.usage ?? null
  const pick = (key: string): string => usage !== null && usage[key] !== undefined ? Number(usage[key]).toLocaleString() : '未提供'
  return (
    <>
      <span><dt>翻译模型</dt><dd>{result?.provider !== undefined ? `${result.provider} / ${result.model ?? ''}` : '未提供'}</dd></span>
      <span><dt>未缓存输入</dt><dd>{pick('inputTokens')}</dd></span>
      <span><dt>缓存读取</dt><dd>{pick('cacheReadTokens')}</dd></span>
      <span><dt>缓存写入</dt><dd>{pick('cacheWriteTokens')}</dd></span>
      <span><dt>输出</dt><dd>{pick('outputTokens')}</dd></span>
      <span><dt>其中思考</dt><dd>{pick('reasoningTokens')}</dd></span>
      <span><dt>合计</dt><dd>{pick('totalTokens')}</dd></span>
      <span><dt>用时</dt><dd>{formatMs(result?.elapsedMs)}</dd></span>
      <span><dt>译文生成于</dt><dd>{result?.createdAt !== undefined ? new Date(result.createdAt).toLocaleString('zh-CN') : '未提供'}</dd></span>
    </>
  )
}
