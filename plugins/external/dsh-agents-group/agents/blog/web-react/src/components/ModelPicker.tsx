/**
 * 模型选择器（旧 web/model-picker.js 的展示面；状态面在 composer store 的
 * usePickerStore）。语义照旧：菜单打开时重拉目录；dirty 才随请求提交；
 * 发送中禁用。
 */
import { useEffect, useRef, useState } from 'react'
import { DshIcon } from './DshIcon.tsx'
import { usePickerStore } from '../stores/composer.ts'
import type { ModelSelection } from '../lib/types.ts'

function same(a: ModelSelection | null | undefined, b: ModelSelection | null | undefined): boolean {
  return a?.provider === b?.provider && a?.model === b?.model
}

export function ModelPicker(): React.ReactElement {
  const catalog = usePickerStore(state => state.catalog)
  const ready = usePickerStore(state => state.ready)
  const busy = usePickerStore(state => state.busy)
  const errorText = usePickerStore(state => state.errorText)
  const selected = usePickerStore(state => state.selected)
  const dirty = usePickerStore(state => state.dirty)
  const contextId = usePickerStore(state => state.contextId)
  const refresh = usePickerStore(state => state.refresh)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const modelName = (value: ModelSelection | null | undefined): string =>
    catalog?.groups.find(group => group.id === value?.provider)?.models.find(model => model.id === value?.model)?.name
    ?? value?.model ?? '未配置'

  const label = ready
    ? (selected !== null ? modelName(selected) : `默认 · ${modelName(catalog?.default ?? null)}`)
    : (errorText !== '' ? '模型加载失败' : '正在加载模型…')

  // 点外部关闭（旧 pointerdown 监听）。
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const choose = (value: ModelSelection | null): void => {
    // 旧码 choose：只置选中与 dirty 并关闭；不重拉目录。
    usePickerStore.setState({ selected: value, dirty: true })
    setOpen(false)
  }

  return (
    <div className="blg-model-picker" ref={rootRef}>
      <button
        type="button"
        className="blg-model-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="选择模型"
        title={errorText !== '' ? errorText : label}
        disabled={busy}
        onClick={() => {
          if (open) { setOpen(false); return }
          setOpen(true)
          void refresh(contextId, false)
        }}
      >
        <span className="blg-model-label">{label}</span>
        <DshIcon name="chevron_down" size={14} />
      </button>
      {open && (
        <div className="blg-model-menu" role="menu" aria-label="选择模型">
          <div className="blg-model-heading">选择模型</div>
          {!ready ? (
            <>
              <div className="blg-model-note">{errorText !== '' ? errorText : '正在加载…'}</div>
              <button
                type="button"
                role="menuitem"
                className="blg-model-option"
                onClick={() => { void refresh(contextId, false) }}
              >
                重新加载
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={selected === null}
                className="blg-model-option"
                onClick={() => choose(null)}
              >
                <span>默认<small>{modelName(catalog?.default ?? null)}</small></span>
                {selected === null && <DshIcon name="check" size={14} />}
              </button>
              {catalog?.groups.map(group => group.models.map(model => {
                const value: ModelSelection = { provider: group.id, model: model.id }
                const active = same(value, selected)
                return (
                  <button
                    key={`${group.id}/${model.id}`}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    className="blg-model-option"
                    onClick={() => choose(value)}
                  >
                    <span>{model.name}{catalog.groups.length > 1 && <small>{group.name}</small>}</span>
                    {active && <DshIcon name="check" size={14} />}
                  </button>
                )
              }))}
              {selected !== null && !catalog?.groups.some(group => group.id === selected.provider && group.models.some(model => model.id === selected.model)) && (
                <div className="blg-model-note">原模型已不在目录中，请重新选择。</div>
              )}
              {(catalog?.failures.length ?? 0) > 0 && (
                <div className="blg-model-note">部分服务商目录暂时不可用，可关闭后重新打开刷新。</div>
              )}
            </>
          )}
          <div className="blg-model-note">发送下一条消息时生效，并同步更新 Auth 默认模型。</div>
        </div>
      )}
    </div>
  )
}
