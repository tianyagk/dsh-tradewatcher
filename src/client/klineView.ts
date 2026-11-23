/**
 * K 线可见窗口的切片与极值（P2-13 纯函数）。
 *
 * 拆分动机：`KlineChart` 的游标（鼠标每帧移动）只改 `cursor` state；窗口 `[s, e)` 与
 * `bars/mas` 没变时，可见切片与 high/low 极值不必每帧重算（240 根 × 3 列 + 4 条均线）。
 * 组件里用 `useMemo(() => klineVisibleOf(bars, s, e, mas), [bars, s, e, mas])` 接住；
 * 这里保持与旧实现**完全相同的取值口径**（`Math.max(...visHigh, ...maVisible)`，不插值、不改窗口）。
 */
export interface KlineBarLike {
  high: number
  low: number
}

export interface KlineMaLike {
  values: ReadonlyArray<number | null>
}

export interface KlineVisible<T extends KlineBarLike> {
  /** `bars.slice(s, e)`（成交量等次要面板复用同一份，避免二次切片） */
  bars: T[]
  /** 可见柱 + 可见均线点的最大值（窗口空时为 -Infinity，与旧实现一致） */
  hi: number
  /** 可见柱 + 可见均线点的最小值（窗口空时为 Infinity，与旧实现一致） */
  lo: number
}

export function klineVisibleOf<T extends KlineBarLike>(
  bars: readonly T[],
  s: number,
  e: number,
  mas: ReadonlyArray<KlineMaLike>,
): KlineVisible<T> {
  const visBars = bars.slice(s, e)
  const visHigh = visBars.map((b) => b.high)
  const visLow = visBars.map((b) => b.low)
  const maVisible: number[] = []
  for (const ser of mas) {
    for (let i = s; i < e; i += 1) {
      const v = ser.values[i]
      // 与旧实现同一个过滤条件（`!== null`）：未算出的均线点不参与极值
      if (v !== null) maVisible.push(v as number)
    }
  }
  return {
    bars: visBars,
    hi: Math.max(...visHigh, ...maVisible),
    lo: Math.min(...visLow, ...maVisible),
  }
}
