/**
 * 列头排序（宽屏表格视图）。
 *
 * 与 `SortBar.tsx` 的分工：分段开关在窄侧栏里更省地方（保留、继续用），
 * 宽屏列表铺成多列后，"点列头排序"比"先找排序键再点"更贴表格直觉 —— 两者读写**同一份**
 * `watchSort` / `portSort` 偏好，因此不存在"两个控件各说一套"的可能。
 *
 * 三条硬约定（与 sort.ts 一致）：
 *  1. 只有**有数值来源**的列才可点（`column.key === null` 的列只是标签）——
 *     排错比不排更糟，界面上看不出来的假排序会让人不再信任这个表；
 *  2. 当前列显示 ▲/▼，并在 `columnheader` 上给 `aria-sort`（读屏软件据此播报方向）；
 *  3. 键盘可用：真正的 `<button>`，Enter/Space 天然触发，不留"只能鼠标点"的列头。
 */
import React from 'react'
import type { SortState } from '../shared/model.ts'
import { nextSortState, sortArrow, type SortColumn } from './sort.ts'

export function SortHeader<K extends string>(props: {
  columns: readonly SortColumn<K>[]
  state: SortState<K>
  onChange: (next: SortState<K>) => void
  /** 无障碍标签，如「自选列头排序」 */
  ariaLabel: string
}): React.ReactElement {
  const { columns, state, onChange, ariaLabel } = props
  return React.createElement(
    'div',
    { className: 'tw-sorthead', role: 'row', 'aria-label': ariaLabel },
    React.createElement('span', {
      className: 'tw-sorthead-cap',
      // 行是卡片式布局（不是真表格），所以这里写「排序」而不是「列头」：
      // 每一格都对应行内确实存在的字段，但数值不保证纵向对齐（列网格见 ROADMAP P1-1）
      title: '点字段名按该字段排序，再点切换升降序；「↺ 默认顺序」回到自定义顺序（窄屏用面板上的排序开关）',
    }, '排序'),
    // 宽屏下分段开关被 CSS 隐藏，因此这里必须留一个回「默认（自定义）顺序」的入口，
    // 否则宽屏用户点完列头就回不去了
    state.key === 'default'
      ? null
      : React.createElement('button', {
          type: 'button',
          className: 'tw-sorthead-reset',
          title: '回到自定义顺序（按添加/建仓顺序，不受行情变动影响）',
          onClick: () => onChange({ key: 'default' as K, desc: true }),
        }, '↺ 默认顺序'),
    ...columns.map((c) => {
      const key = c.key
      const on = key !== null && state.key === key
      const sort = key === null ? undefined : on ? (state.desc ? 'descending' : 'ascending') : 'none'
      return React.createElement(
        'div',
        {
          key: c.label,
          role: 'columnheader',
          'aria-sort': sort,
          className: 'tw-sorthead-cell',
          'data-on': on,
        },
        key === null
          ? React.createElement('span', { className: 'tw-sorthead-static', title: c.hint }, c.label)
          : React.createElement('button', {
              type: 'button',
              className: 'tw-sorthead-btn',
              'aria-label': `${c.label}：点击排序${on ? `（当前${state.desc ? '降序' : '升序'}，再次点击切换）` : ''}`,
              title: on
                ? `${c.hint}\n当前${state.desc ? '降序' : '升序'}，再次点击切换方向；「↺ 默认顺序」可回到自定义顺序`
                : c.hint,
              onClick: () => onChange(nextSortState(state, key)),
            }, `${c.label}${on ? ` ${sortArrow(state.desc)}` : ''}`),
      )
    }),
  )
}
