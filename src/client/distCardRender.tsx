/**
 * 【涨跌分布】柱状图的**渲染层**（唯一实现，两处布局共用）。
 *
 * 口径与几何都在 `distCard.ts`（纯函数，可断言）；这里只摆 DOM：
 *   · 9 个柱（`data-role="dist-bar"`）宽度均分、间距 6px、高度按 counts 归一；
 *   · 柱顶家数（`dist-count`，绝对定位在柱顶）+ 柱下档名（`dist-label`）**逐柱一一对应**；
 *   · 左侧 Y 轴 ≥3 档（`dist-ytick`）+ 水平网格（`dist-gridline`）。
 *
 * 布局分三层，互不重叠：① 柱顶家数行（预留 `DIST_COUNT_H`）② 柱区（`DIST_BAR_H`）③ 档名行。
 * 「北交所 未接入」**不在这个组件里**（属卡头右侧，由调用方放进 `card(...)` 的 hint）——
 * 放进柱区会压住档名，有断言钉住（`distCard.test.ts` ④）。
 */
import React from 'react'
import { DIST_BAR_H, DIST_BAR_GAP_PX, DIST_PLOT_H, distBarsOf, distYTicksOf } from './distCard.ts'
import { distToneOf } from './breadthView.ts'
import { distBarPctOf } from './distView.ts'

const toneColorOf = (label: string): string => {
  const tone = distToneOf(label)
  return tone === 'up' ? 'var(--tw-up)' : tone === 'down' ? 'var(--tw-down)' : 'var(--tw-muted)'
}

export interface DistBarsBodyProps {
  counts: readonly number[]
  labels: readonly string[]
  /** 口径不一致等提示（原样展示，不吞）；null ⇒ 不渲染 */
  warn?: string | null
  /** 由调用方指定的纵轴上界（`distAxisOf` 的"取整上界"）；缺省用数据最大值 */
  axisMax?: number
}

export function DistBarsBody(props: DistBarsBodyProps): React.ReactElement {
  const bars = distBarsOf(props.counts, props.labels)
  const ticks = distYTicksOf(props.counts, props.axisMax)
  const top = Math.max(1, ...ticks)
  const muted = { color: 'var(--tw-muted)' } as const
  return React.createElement(
    'div',
    { 'data-role': 'dist-body', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
    React.createElement(
      'div',
      { style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
      // Y 轴（≥3 档）：与柱区同高、同基线
      React.createElement(
        'div',
        {
          'data-role': 'dist-axis',
          className: 'tw-dist-axis',
          style: { position: 'relative', width: 40, flex: '0 0 40px', height: DIST_BAR_H, marginTop: DIST_PLOT_H - DIST_BAR_H },
        },
        ...ticks.map((t) =>
          React.createElement(
            'span',
            {
              key: `y${t}`,
              'data-role': 'dist-ytick',
              style: { position: 'absolute', right: 4, bottom: `${distBarPctOf(t, top)}%`, transform: 'translateY(50%)', fontSize: 12, ...muted, fontVariantNumeric: 'tabular-nums' },
            },
            String(t),
          ),
        ),
      ),
      // 柱区 + 档名
      React.createElement(
        'div',
        { style: { flex: 1, minWidth: 0, marginTop: DIST_PLOT_H - DIST_BAR_H } },
        React.createElement(
          'div',
          { 'data-role': 'dist-plot', style: { position: 'relative', height: DIST_BAR_H } },
          // 网格（只铺柱区，不铺家数行）
          React.createElement(
            'div',
            { 'data-role': 'dist-grid', className: 'tw-dist-grid', style: { position: 'absolute', left: 0, right: 0, top: 0, height: DIST_BAR_H } },
            ...ticks.map((t) =>
              React.createElement('span', {
                key: `g${t}`,
                'data-role': 'dist-gridline',
                style: { position: 'absolute', left: 0, right: 0, bottom: `${distBarPctOf(t, top)}%`, borderTop: '1px solid var(--tw-border)' },
              }),
            ),
          ),
          // 9 个柱（柱顶家数绝对定位在柱顶上方，不撑高、不与卡头打架）
          React.createElement(
            'div',
            { 'data-role': 'dist-bars', style: { position: 'relative', display: 'flex', alignItems: 'flex-end', gap: DIST_BAR_GAP_PX, height: DIST_BAR_H } },
            ...bars.map((b) =>
              React.createElement(
                'div',
                {
                  key: b.label,
                  'data-role': 'dist-bar-col',
                  style: { position: 'relative', flex: '1 1 0', minWidth: 0, height: '100%', display: 'flex', alignItems: 'flex-end' },
                },
                React.createElement(
                  'span',
                  {
                    'data-role': 'dist-count',
                    style: {
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      bottom: b.heightPx + 2,
                      textAlign: 'center',
                      fontSize: 12,
                      lineHeight: `${DIST_PLOT_H - DIST_BAR_H}px`,
                      fontVariantNumeric: 'tabular-nums',
                    },
                  },
                  b.count === null ? '—' : String(b.count),
                ),
                React.createElement('i', {
                  'data-role': 'dist-bar',
                  'data-h': String(b.heightPx),
                  style: {
                    display: 'block',
                    width: '100%',
                    height: `${b.heightPx}px`,
                    background: toneColorOf(b.label),
                    borderRadius: '2px 2px 0 0',
                  },
                }),
              ),
            ),
          ),
        ),
        // 档名行（与柱同宽同序）
        React.createElement(
          'div',
          { 'data-role': 'dist-labels', style: { display: 'flex', gap: DIST_BAR_GAP_PX, marginTop: 2 } },
          ...bars.map((b) =>
            React.createElement(
              'span',
              {
                key: b.label,
                'data-role': 'dist-label',
                style: { flex: '1 1 0', minWidth: 0, textAlign: 'center', fontSize: 12, ...muted, whiteSpace: 'nowrap' },
              },
              b.label,
            ),
          ),
        ),
      ),
    ),
    props.warn === undefined || props.warn === null
      ? null
      : React.createElement('div', { 'data-role': 'dist-warn', className: 'tw-hint tw-dim', style: { fontSize: 12, ...muted } }, props.warn),
  )
}
