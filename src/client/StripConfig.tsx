/**
 * 行情卡片配置窗（设计规格 `docs/DESIGN-STRIP-CONFIG.md` §1/§2）。
 *
 * 三条硬要求：
 *  ① **键盘必须能完成全部配置动作**：原生 `input[type=checkbox]` + `Tab/Shift+Tab` 在窗内循环、
 *     打开即聚焦首个控件、`Esc` 关闭（父组件把焦点还给齿轮）；拖动只是鼠标增强；
 *  ② **真做焦点陷阱**（`aria-modal="true"` 必须配得上）：不要"加了属性却不做陷阱"；
 *  ③ **拖动**：只有头 `.tw-cfg-h` 是把手，`setPointerCapture` + 视口 clamp `[8, vw−w−8]×[8, vh−h−8]`。
 *
 * 持久化：`prefs.stripCfg = { hidden: string[] }`（**存隐藏集合** ⇒ 老 profile 缺键=全可见，
 * 将来新增的卡片默认可见）。窗口位置**不落 prefs**（跨会话恢复一个飘在半空的窗口会出现在意外位置）。
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  SELECT_ALL_HIDDEN, invertHidden, selectedCount, toggleCardHidden, toggleGroupHidden, effectiveHidden,
  type StripRowLike,
} from './stripTone.ts'

export interface StripConfigProps {
  rows: readonly StripRowLike[]
  hidden: unknown
  onChange: (hidden: string[]) => void
  onClose: () => void
}

const MARGIN = 8
const WIDTH = 320

export function StripConfig(props: StripConfigProps): React.ReactElement {
  const { rows } = props
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const drag = useRef<{ dx: number; dy: number; w: number; h: number } | null>(null)
  const hidden = effectiveHidden(props.hidden, rows.flatMap((r) => r.items.map((i) => i.secid)))

  /** 首次挂载放在右上角附近（齿轮下方），并 clamp 进视口 */
  useLayoutEffect(() => {
    const el = ref.current
    const vw = window.innerWidth
    const w = Math.min(WIDTH, vw - MARGIN * 2)
    setPos({ left: Math.max(MARGIN, vw - w - 24), top: MARGIN * 4 })
    void el
  }, [])

  /** 打开即聚焦首个控件（焦点陷阱的入口） */
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const first = el.querySelector<HTMLElement>('input,button')
    first?.focus()
  }, [])

  const clamp = useCallback((left: number, top: number): { left: number; top: number } => {
    const el = ref.current
    const vw = window.innerWidth
    const vh = window.innerHeight
    const w = el?.offsetWidth ?? WIDTH
    const h = el?.offsetHeight ?? 320
    return {
      left: Math.min(Math.max(MARGIN, left), Math.max(MARGIN, vw - w - MARGIN)),
      top: Math.min(Math.max(MARGIN, top), Math.max(MARGIN, vh - h - MARGIN)),
    }
  }, [])

  /** 拖动：pointer capture + 位移；`resize` 后重新 clamp */
  useEffect(() => {
    const onResize = (): void => setPos((p) => (p === null ? p : clamp(p.left, p.top)))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clamp])

  const onPointerDown = (ev: React.PointerEvent): void => {
    const el = ref.current
    if (el === null || pos === null) return
    drag.current = { dx: ev.clientX - pos.left, dy: ev.clientY - pos.top, w: el.offsetWidth, h: el.offsetHeight }
    ;(ev.target as Element).setPointerCapture?.(ev.pointerId)
  }
  const onPointerMove = (ev: React.PointerEvent): void => {
    const d = drag.current
    if (d === null) return
    setPos(clamp(ev.clientX - d.dx, ev.clientY - d.dy))
  }
  const endDrag = (): void => {
    drag.current = null
  }

  /** 焦点陷阱：Tab 在窗内循环（首尾相接），并把焦点拉回被拖出窗外的情形 */
  const onKeyDown = (ev: React.KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.stopPropagation()
      props.onClose()
      return
    }
    if (ev.key !== 'Tab') return
    const el = ref.current
    if (el === null) return
    const items = [...el.querySelectorAll<HTMLElement>('input,button')].filter((n) => !n.hasAttribute('disabled'))
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (ev.shiftKey && (active === first || !el.contains(active))) {
      ev.preventDefault()
      last.focus()
    } else if (!ev.shiftKey && (active === last || !el.contains(active))) {
      ev.preventDefault()
      first.focus()
    }
  }

  const count = selectedCount(rows, hidden)
  const set = (next: string[]): void => props.onChange(next)
  const box = (label: string, checked: boolean, onToggle: () => void, key: string, title?: string): React.ReactElement =>
    React.createElement('label', { key, className: 'tw-cfg-item', title },
      React.createElement('input', { type: 'checkbox', checked, onChange: onToggle }),
      React.createElement('span', null, label),
    )

  return React.createElement('div', {
    ref,
    className: 'tw-cfg',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'tw-cfg-title',
    style: pos === null ? { visibility: 'hidden' } : { left: pos.left, top: pos.top, width: Math.min(WIDTH, window.innerWidth - MARGIN * 2) },
    onKeyDown,
  },
    React.createElement('div', {
      className: 'tw-cfg-h',
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onLostPointerCapture: endDrag,
    },
      React.createElement('span', { id: 'tw-cfg-title', className: 'tw-cfg-title' }, '行情卡片配置'),
      React.createElement('button', { className: 'tw-iconbtn', onClick: props.onClose, 'aria-label': '关闭配置', title: '关闭（Esc）' }, '×'),
    ),
    React.createElement('div', { className: 'tw-cfg-tools' },
      React.createElement('button', { className: 'tw-btn', onClick: () => set(SELECT_ALL_HIDDEN) }, '全选'),
      React.createElement('button', { className: 'tw-btn', onClick: () => set(invertHidden(rows, hidden)) }, '反选'),
      React.createElement('button', { className: 'tw-btn', onClick: () => set(SELECT_ALL_HIDDEN), title: '恢复默认＝全部显示（含将来新增的卡片）' }, '恢复默认'),
    ),
    ...rows.map((row) => {
      const on = row.items.filter((i) => !hidden.includes(i.secid)).length
      return React.createElement('div', { key: row.key, className: 'tw-cfg-group' },
        React.createElement('label', { className: 'tw-cfg-grouphead' },
          React.createElement('input', {
            type: 'checkbox', checked: on === row.items.length,
            ref: (el: HTMLInputElement | null) => { if (el !== null) el.indeterminate = on > 0 && on < row.items.length },
            onChange: () => set(toggleGroupHidden(rows, hidden, row.key, on !== row.items.length)),
          }),
          React.createElement('span', { className: 'tw-cfg-groupt' }, row.label),
          React.createElement('span', { className: 'tw-cfg-sub' }, `已选 ${on}/${row.items.length}`),
        ),
        React.createElement('div', { className: 'tw-cfg-items' },
          ...row.items.map((it) => box(it.name, !hidden.includes(it.secid), () => set(toggleCardHidden(rows, hidden, it.secid, hidden.includes(it.secid))), it.secid, it.secid)),
        ),
      )
    }),
    React.createElement('div', { className: 'tw-cfg-foot' },
      React.createElement('span', { className: 'tw-cfg-count', title: '已选张数 / 全部张数；顺序固定（不支持调序）' }, `已选 ${count.on}/${count.total}`),
      React.createElement('span', { className: 'tw-hint', style: { margin: 0 } }, '配置只影响本面板的行情卡片；顺序固定'),
    ),
  )
}
