/**
 * 竞价参考价迷你图：一条 `ref` 折线 + 下部 `matched` 细柱。
 * **没有坐标轴文字、没有网格、没有浮框**（height ≤ 48；空序列由调用方显示 `—`）。
 */
import React from 'react'
import type { AuctionPoint } from '../shared/model.ts'
import { AUCTION_SPARK_HEIGHT, AUCTION_SPARK_WIDTH, auctionSparkGeometry } from './auctionSeries.ts'

export function AuctionSpark(props: { series: readonly AuctionPoint[]; width?: number; height?: number }): React.ReactElement {
  const width = props.width ?? AUCTION_SPARK_WIDTH
  const height = Math.min(48, props.height ?? AUCTION_SPARK_HEIGHT)
  const g = auctionSparkGeometry(props.series, width, height)
  if (g === null) return React.createElement('span', { className: 'tw-muted', style: { fontSize: 12 } }, '—')
  return React.createElement(
    'svg',
    { width: g.width, height: g.height, viewBox: `0 0 ${g.width} ${g.height}`, 'aria-hidden': true, style: { display: 'block' } },
    ...g.bars.map((b, i) =>
      React.createElement('rect', {
        key: `bar-${i}`, x: b.x, y: b.y, width: b.w, height: b.h,
        style: { fill: 'var(--tw-muted)', opacity: 0.45 },
      }),
    ),
    React.createElement('path', {
      d: g.line, fill: 'none', stroke: 'var(--tw-accent)', strokeWidth: 1.2,
      strokeLinejoin: 'round', strokeLinecap: 'round',
    }),
  )
}
