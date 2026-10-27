/**
 * 【涨跌分布】的**纯几何**（不 import react ⇒ 能在 node 里直接断言）。
 *
 * 为什么单独一层：上一版把柱高写成 `(n/max)*70` 的 px 内联值，`i` 又是行内元素、没有宽度 ⇒
 * 截图里只剩数字没有柱子。这里把"多高、多少档、Y 轴几档"全部算成数据，渲染层只负责摆位置：
 *   · 高度按 **counts 最大值归一**（最高柱 = 满格）；
 *   · Y 轴固定给 **3 档**（0 / 中值 / 最大），并据此画水平网格；
 *   · 柱宽均分、柱间 6px（`DIST_BAR_GAP_PX`）。
 */

/** 柱间距（px）——需求写死 6px */
export const DIST_BAR_GAP_PX = 6
/** 柱区可用高度（px）：柱子最高就是这个数（柱顶家数另占一行，见 `DIST_COUNT_H`） */
export const DIST_BAR_H = 80
/** 柱顶家数那一行的高度（px）—— 从柱区上方预留，避免最高柱的数字压到卡头 */
export const DIST_COUNT_H = 16
/** 整块图的高度 = 柱区 + 家数行 */
export const DIST_PLOT_H = DIST_BAR_H + DIST_COUNT_H

export interface DistBar {
  label: string
  /** 该档计数；`null` = 上游没给这一档（界面显示 `—`，不写 0） */
  count: number | null
  /** 占最高柱的百分比（最高柱 = 100） */
  heightPct: number
  /** 实际像素高度（0 只 ⇒ 0；>0 ⇒ 至少 2px，避免"有数但看不见"） */
  heightPx: number
}

/** 9 个柱的几何：高度按最大值归一（不是按总和，也不是固定 70px） */
export function distBarsOf(counts: readonly number[], labels: readonly string[], plotH = DIST_BAR_H): DistBar[] {
  const n = Math.max(counts.length, labels.length)
  const max = Math.max(1, ...counts.map((c) => (Number.isFinite(c) && c > 0 ? c : 0)))
  const out: DistBar[] = []
  for (let i = 0; i < n; i += 1) {
    const raw = counts[i]
    const count = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
    const heightPct = count === null || count <= 0 ? 0 : (count / max) * 100
    out.push({
      label: labels[i] ?? String(i),
      count,
      heightPct,
      heightPx: count === null || count <= 0 ? 0 : Math.max(2, Math.round((heightPct / 100) * plotH)),
    })
  }
  return out
}

/** Y 轴刻度：0 / 中值 / 最大（去重后不足 3 档时补到 3 档，保证"≥3 档 + 网格"）；`axisMax` 由调用方给上界时按它算 */
export function distYTicksOf(counts: readonly number[], axisMax?: number): number[] {
  const max = typeof axisMax === 'number' && Number.isFinite(axisMax) && axisMax > 0
    ? axisMax
    : Math.max(0, ...counts.map((c) => (Number.isFinite(c) && c > 0 ? c : 0)))
  if (max <= 0) return [0, 1, 2]
  const mid = Math.round(max / 2)
  const ticks = [0, mid, max].filter((v, i, arr) => arr.indexOf(v) === i).sort((a, b) => a - b)
  if (ticks.length >= 3) return ticks
  // max=1 这类极小值：中值会等于 0 或 max，补一个 1 凑够 3 档
  const filled = [...new Set([0, ...ticks, max + 1])].sort((a, b) => a - b)
  return filled.slice(0, Math.max(3, ticks.length))
}

/** 9 档合计（不含停牌） */
export function distSumOf(counts: readonly number[] | null | undefined): number | null {
  if (counts === null || counts === undefined || counts.length === 0) return null
  return counts.reduce((a, c) => a + (Number.isFinite(c) ? c : 0), 0)
}

export interface DistConsistency {
  /** 5 格里的 up+flat+down（缺任一 ⇒ null） */
  upFlatDown: number | null
  /** 9 档合计（不含停牌） */
  binsSum: number | null
  ok: boolean
  /** 不一致时的**人话**（两个数都写出来；一致时为 null） */
  text: string | null
}

/**
 * 数据一致性：`up + flat + down` 必须等于分布 9 档合计（不含停牌）。
 * 不一致不掩盖：返回 `ok:false` + 同时含两个数的文案，页面标 `warn`、title 也写这两个数。
 */
export function distConsistencyOf(input: {
  up: number | null | undefined
  flat: number | null | undefined
  down: number | null | undefined
  counts: readonly number[] | null | undefined
}): DistConsistency {
  const { up, flat, down } = input
  const upFlatDown =
    typeof up === 'number' && typeof flat === 'number' && typeof down === 'number' ? up + flat + down : null
  const binsSum = distSumOf(input.counts)
  const ok = upFlatDown !== null && binsSum !== null && upFlatDown === binsSum
  return {
    upFlatDown,
    binsSum,
    ok,
    text: ok || upFlatDown === null || binsSum === null ? null : `口径不一致：5 格合计 ${upFlatDown} / 分布合计 ${binsSum}`,
  }
}

/** 左侧「涨跌趋势」5 格的取值：**先取分布回包的同源五数**，缺了才退回旧链（current / 涨跌停接口） */
export function trendCellsOf(
  dist: { up?: number | null; flat?: number | null; down?: number | null; limitUp?: number | null; limitDown?: number | null } | null | undefined,
  current: { up?: number | null; even?: number | null; down?: number | null } | null | undefined,
  limits: { up?: { count: number | null } | null; down?: { count: number | null } | null } | null | undefined,
): Array<number | null> {
  const pick = (...vals: Array<number | null | undefined>): number | null => {
    for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v
    return null
  }
  return [
    pick(dist?.up, current?.up),
    pick(dist?.flat, current?.even),
    pick(dist?.down, current?.down),
    pick(dist?.limitUp, limits?.up?.count),
    pick(dist?.limitDown, limits?.down?.count),
  ]
}
