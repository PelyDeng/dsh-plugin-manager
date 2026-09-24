/**
 * 模型选择器（旧 web/model-picker.js 的 React 展示面，状态在 stores/picker.ts）。
 *
 * 语义照旧：就绪前显示加载/错误；错误可就地重试；busy（回答进行中）时禁开；
 * 目录分组展示，默认项=「默认 · <默认模型名>」；选中即视为下一条消息生效。
 */
import { useEffect, useRef, useState } from 'react'
import { usePickerStore } from '../stores/picker.ts'
import type { ModelSelection } from '../lib/types.ts'
import type { ReactElement } from 'react'
import { Icon } from '@dsh-agents-group/web-common'

function sameModel(a: ModelSelection | null | undefined, b: ModelSelection | null | undefined): boolean {
  return a !== null && a !== undefined && b !== null && b !== undefined && a.provider === b.provider && a.model === b.model
}

function catalogName(catalog: ReturnType<typeof usePickerStore.getState>['catalog'], value: ModelSelection | null | undefined): string {
  const group = catalog?.groups.find(item => item.id === value?.provider)
  return group?.models.find(model => model.id === value?.model)?.name ?? value?.model ?? '未配置'
}

export function ModelPicker(): ReactElement {
  const catalog = usePickerStore(state => state.catalog)
  const ready = usePickerStore(state => state.ready)
  const busy = usePickerStore(state => state.busy)
  const errorText = usePickerStore(state => state.errorText)
  const selected = usePickerStore(state => state.selected)
  const contextId = usePickerStore(state => state.contextId)
  const refresh = usePickerStore(state => state.refresh)

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 点外部/Esc 收起（旧码 pointerdown + resize + scroll 全局监听的 React 等价，取最小集）。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const label = ready
    ? (selected !== null ? catalogName(catalog, selected) : `默认 · ${catalogName(catalog, catalog?.default ?? null)}`)
    : (errorText !== '' ? '模型加载失败' : '正在加载模型…')

  const groups = catalog?.groups
  const failures = catalog?.failures

  const choose = (value: ModelSelection | null): void => {
    usePickerStore.setState(value === null
      ? { selected: null, dirty: true }
      : { selected: value, dirty: true })
    setOpen(false)
  }

  return (
    <div className="co-picker" ref={rootRef}>
      <button
        type="button"
        className="co-picker-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="选择模型"
        title={errorText !== '' ? errorText : label}
        disabled={busy}
        onClick={() => {
          if (open) { setOpen(false); return }
          if (!ready) void refresh(contextId, false)
          setOpen(true)
        }}
      >
        <span>{label}</span>
        <Icon name="chevron_down" size={12} />
      </button>
      {open && (
        <div className="co-picker-menu" role="menu" aria-label="选择模型">
          <p className="co-picker-heading">选择模型</p>
          {!ready ? (
            <>
              <p className="co-picker-note">{errorText !== '' ? errorText : '正在加载…'}</p>
              <button
                type="button"
                role="menuitem"
                className="co-picker-option"
                onClick={() => { void refresh(contextId, false) }}
              >
                重新加载
              </button>
            </>
          ) : (
            <>
              <button type="button" role="menuitemradio" aria-checked={selected === null} className="co-picker-option" onClick={() => choose(null)}>
                <span>默认<small>{catalogName(catalog, catalog?.default ?? null)}</small></span>
                {selected === null && <Icon name="check" size={13} />}
              </button>
              {(groups ?? []).map(group => group.models.map(model => {
                const value: ModelSelection = { provider: group.id, model: model.id }
                const active = sameModel(value, selected)
                return (
                  <button type="button" role="menuitemradio" aria-checked={active} className="co-picker-option" key={`${group.id}/${model.id}`} onClick={() => choose(value)}>
                    <span>{model.name}{(groups ?? []).length > 1 ? <small>{group.name}</small> : undefined}</span>
                    {active && <Icon name="check" size={13} />}
                  </button>
                )
              }))}
              {(failures ?? []).length > 0 && (
                <p className="co-picker-note">部分服务商目录暂时不可用，可关闭后重新打开刷新。</p>
              )}
            </>
          )}
          <p className="co-picker-note">发送下一条消息时生效，并同步更新 Auth 默认模型。</p>
        </div>
      )}
    </div>
  )
}
