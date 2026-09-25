/**
 * 模型选择器（旧 web/model-picker.js 的 React 展示面，状态在 stores/picker.ts）。
 *
 * 语义照旧：就绪前显示加载/错误；错误可就地重试；busy（回答进行中）时禁开；
 * 目录分组展示，默认项=「默认 · <默认模型名>」；选中即视为下一条消息生效。
 *
 * 打开即后台刷新目录（旧 trigger.onclick：先渲染现目录再 refresh(contextId,false)，
 * 完成后原位重渲染）；选中模型已不在目录时菜单尾部给「原模型已不在目录中」提示
 * （旧 render 同款 note）。
 *
 * 键盘（旧 menu.onkeydown）：Escape 关闭并回焦按钮；↑/↓ 循环移动、Home/End 跳首尾；
 * Tab 关闭。打开时聚焦当前选中项（无选中取首项）。与 blog 批 2c ModelPicker 同款。
 */
import { useEffect, useId, useRef, useState } from 'react'
import { usePickerStore } from '../stores/picker.ts'
import type { ModelSelection } from '../lib/types.ts'
import type { ReactElement } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
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
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  // 打开时聚焦选中项（无选中取首项；旧 trigger.onclick 同款）。
  useEffect(() => {
    if (!open) return
    const menu = rootRef.current?.querySelector('[role="menu"]')
    const target = menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu?.querySelector<HTMLButtonElement>('button')
    target?.focus()
  }, [open, ready])

  // 点外部收起（旧码 pointerdown 全局监听的 React 等价）。
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
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

  /** 菜单键盘导航（旧 menu.onkeydown 逐键对齐）。 */
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
      return
    }
    if (event.key === 'Tab') { setOpen(false); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const rows = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menu"] button') ?? [])]
    if (rows.length === 0) return
    event.preventDefault()
    const index = rows.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? rows.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
    rows[next]?.focus()
  }

  return (
    <div className="co-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="co-picker-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="选择模型"
        title={errorText !== '' ? errorText : label}
        disabled={busy}
        onClick={() => {
          if (open) { setOpen(false); return }
          setOpen(true)
          // 每次打开后台刷新目录（旧 trigger.onclick：refresh(contextId,false) 不重置选中）。
          void refresh(contextId, false)
        }}
      >
        <span>{label}</span>
        <Icon name="chevron_down" size={12} />
      </button>
      {open && (
        <div className="co-picker-menu" role="menu" id={menuId} aria-label="选择模型" onKeyDown={onMenuKeyDown}>
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
              {selected !== null && !catalog?.groups.some(group => group.id === selected.provider && group.models.some(model => model.id === selected.model)) && (
                <p className="co-picker-note">原模型已不在目录中，请重新选择。</p>
              )}
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
