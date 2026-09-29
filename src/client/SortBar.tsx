/**
 * 排序段控（自选 / 持仓共用）。
 *
 * 交互约定：点未选中的键 → 切到该键的默认方向（降序）；点已选中的键 → 翻转方向。
 * 方向标记直接画在按钮上（↓/↑），不留"当前到底是升序还是降序"的悬念。
 * 「默认」是自定义顺序，方向对它没有意义，因此不显示箭头。
 */
import React from 'react'
import type { SortState } from '../shared/model.ts'
import { nextSortState, sortArrow } from './sort.ts'

export function SortBar<K extends string>(props: {
  keys: readonly K[]
  labels: Record<K, string>
  hints: Record<K, string>
  state: SortState<K>
  onChange: (next: SortState<K>) => void
  /** 无障碍标签，如「自选排序」 */
  ariaLabel: string
}): React.ReactElement {
  const { keys, labels, hints, state, onChange, ariaLabel } = props
  return React.createElement(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: 6 } },
    React.createElement('span', { className: 'tw-muted', style: { fontSize: 10.5 } }, '排序'),
    React.createElement(
      'div',
      { className: 'tw-seg', role: 'group', 'aria-label': ariaLabel },
      keys.map((k) => {
        const on = state.key === k
        const arrow = on && k !== 'default' ? ` ${sortArrow(state.desc)}` : ''
        return React.createElement(
          'button',
          {
            key: k,
            'data-on': on,
            title: on && k !== 'default'
              ? `${hints[k]}（当前${state.desc ? '降序' : '升序'}，再次点击切换方向）`
              : hints[k],
            'aria-pressed': on,
            onClick: () => onChange(nextSortState(state, k)),
          },
          `${labels[k]}${arrow}`,
        )
      }),
    ),
  )
}
