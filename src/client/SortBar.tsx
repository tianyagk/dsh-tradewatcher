/**
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
    {
      className: 'tw-sortbar',
      style: { display: 'flex', alignItems: 'center', gap: 6 },
    },
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
