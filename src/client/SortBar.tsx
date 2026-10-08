/**
 * 排序段控（自选 / 持仓共用）。
 *
 * 交互约定：点未选中的键 → 切到该键的默认方向（降序）；点已选中的键 → 翻转方向。
 * 方向标记直接画在按钮上（↓/↑），不留"当前到底是升序还是降序"的悬念。
 * 「默认」是自定义顺序，方向对它没有意义，因此不显示箭头。
 *
 * 宽屏（≥1080px）改用列头排序（SortHeader.tsx）。两者的互斥**由调用方决定挂哪一个**
 * （`useWideLayout()`，见 client/useWide.ts）：宽屏不挂段控、窄屏不挂列头。
 *
 * 为什么不靠 CSS 隐藏：v0.30.0 曾把两个控件都渲染、用 `[data-wide-hide=1]` 藏掉其中一个，
 * 实测出现过两者同时可见（选择器链任一环失配就漏）。**"藏起来"不是互斥**。
 * 两者读写同一份 `watchSort`/`portSort`，列头里另有「↺ 默认顺序」，因此收起段控不丢操作。
 *
 * 注意：**不再保留 CSS 兜底**（v0.30.1 删掉了 `wideHidden`/`data-wide-hide`）——
 * 一个"从来没拦住过"的兜底只会让人以为有两层防线，而真正的防线是"不挂"。
 * 想恢复宽屏段控就改 `useWideLayout` 的消费处，别再加一层隐藏规则。
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
