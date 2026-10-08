/**
 * 排序段控（自选 / 持仓共用）。
 *
 * 交互约定：点未选中的键 → 切到该键的默认方向（降序）；点已选中的键 → 翻转方向。
 * 方向标记直接画在按钮上（↓/↑），不留"当前到底是升序还是降序"的悬念。
 * 「默认」是自定义顺序，方向对它没有意义，因此不显示箭头。
 *
 * 宽屏（≥1500px）下这条段控由 CSS 隐藏、改用列头排序（SortHeader.tsx）——
 * 两者读写同一份 `watchSort`/`portSort`，列头里也留了「↺ 默认顺序」入口，
 * 因此在宽屏收起段控不会丢掉任何一步操作。
 *
 * 注意隐藏条件：由**调用方显式传 `wideHidden`**（而不是 CSS 无条件下隐藏），
 * 且只在同一页确实渲染了 SortHeader 时才传 —— 单向失败：忘记传只会"两个入口都在"
 * （多一个入口无害），绝不会出现"宽屏下一个排序入口都没有"。
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
  /** 该页在宽屏另有列头排序入口时传 true（见上方注释：这是唯一的隐藏条件） */
  wideHidden?: boolean
}): React.ReactElement {
  const { keys, labels, hints, state, onChange, ariaLabel } = props
  return React.createElement(
    'div',
    {
      className: 'tw-sortbar',
      'data-wide-hide': props.wideHidden === true ? '1' : undefined,
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
