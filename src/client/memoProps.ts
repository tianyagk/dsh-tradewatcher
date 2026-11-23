/**
 * `React.memo` 的比较器（AUDIT-CLIENT-PERF P2-6）。
 *
 * 背景：全仓 0 处 `React.memo`。父级任何一个 state（10s 行情拍、60s 时钟、页签切换）
 * 都会把整棵子树重建一遍 —— 1049 行的 `RescuePanel`、80 个自选缩略图 `MiniTrend`、
 * 若干 `Sparkline` 都在这条路径上。
 *
 * 为什么需要**自定义比较器**而不是默认浅比较：
 *   · `points` / `values` / `avg` 这类数组每次父级渲染都会**新分配**（`map`/`slice` 的产物），
 *     浅比较永远 false ⇒ 默认 `React.memo` 等于没加；
 *   · `prefs` 也可能因为 `prefs ?? DEFAULT_PREFS` 这类写法换掉对象身份，而内容一致。
 * 因此这里按**值**比较（数组逐项、prefs 稳定序列化），只有内容真的变了才重渲染。
 *
 * 纯函数（不 import React），node:test 可直接断言，也方便反例注入。
 */
import type { SparkMarker, SparkPoint, SparklineProps } from './charts.tsx'
import type { PortPrefs } from '../shared/model.ts'
import { stableTextOf } from './prismStateGate.ts'

/** 数字数组逐项相等（`Object.is`：NaN 与 NaN 视为相同，避免 NaN 让 memo 永久失效） */
export function sameNumberList(a?: readonly number[] | null, b?: readonly number[] | null): boolean {
  if (a === b) return true
  if (a === undefined || a === null || b === undefined || b === null) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (!Object.is(a[i], b[i])) return false
  }
  return true
}

/** 均价线可能含 null（缺值就不画那条线）：null 也要按位置比 */
export function sameNullableNumberList(a?: readonly (number | null)[] | null, b?: readonly (number | null)[] | null): boolean {
  if (a === b) return true
  if (a === undefined || a === null || b === undefined || b === null) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (!Object.is(a[i], b[i])) return false
  }
  return true
}

export function sameSparkPoints(a: readonly SparkPoint[], b: readonly SparkPoint[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!
    const y = b[i]!
    if (x.t !== y.t || !Object.is(x.value, y.value) || x.label !== y.label) return false
  }
  return true
}

export function sameSparkMarkers(a?: readonly SparkMarker[], b?: readonly SparkMarker[]): boolean {
  if (a === b) return true
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    const x = left[i]!
    const y = right[i]!
    if (x.t !== y.t || !Object.is(x.value, y.value) || x.kind !== y.kind || x.title !== y.title) return false
  }
  return true
}

/** `Sparkline` 的比较器：所有参与绘制的字段都比一遍（颜色/宽高/基准线/标记） */
export function sameSparklineProps(a: SparklineProps, b: SparklineProps): boolean {
  return a.width === b.width
    && a.height === b.height
    && a.up === b.up
    && a.upColor === b.upColor
    && a.downColor === b.downColor
    && a.timeLabels === b.timeLabels
    && (a.baseline ?? null) === (b.baseline ?? null)
    && sameSparkPoints(a.points, b.points)
    && sameSparkMarkers(a.markers, b.markers)
}

/** `MiniTrend` 的 props（charts.tsx 里是内联类型；这里列出参与绘制的字段） */
export interface MiniTrendMemoProps {
  values: readonly number[]
  width?: number
  height?: number
  up?: boolean | null
  redUp?: boolean
  avg?: readonly (number | null)[]
}

export function sameMiniTrendProps(a: MiniTrendMemoProps, b: MiniTrendMemoProps): boolean {
  return (a.width ?? 64) === (b.width ?? 64)
    && (a.height ?? 24) === (b.height ?? 24)
    && (a.up ?? null) === (b.up ?? null)
    && (a.redUp ?? true) === (b.redUp ?? true)
    && sameNumberList(a.values, b.values)
    && sameNullableNumberList(a.avg ?? null, b.avg ?? null)
}

/** `RescuePanel` 的 props（大盘页 B3 用；`onPrefs` 只做透传，身份稳定后按 `===` 比） */
export interface RescuePanelMemoProps {
  prefs: PortPrefs
  redUp: boolean
  onPrefs?: (p: PortPrefs) => void
}

/** prefs 内容相等（先比身份：绝大多数渲染走这条零成本路径） */
export function samePrefs(a: PortPrefs, b: PortPrefs): boolean {
  if (a === b) return true
  if (a === undefined || a === null || b === undefined || b === null) return false
  return stableTextOf(a) === stableTextOf(b)
}

/**
 * `RescuePanel` 的比较器：`prefs` 按内容、`redUp` 与 `onPrefs` 按值。
 * `onPrefs` 在 `index.tsx` 已用 `useCallback` 稳定（否则每次父级渲染都是新函数 ⇒ memo 失效）。
 */
export function sameRescuePanelProps(a: RescuePanelMemoProps, b: RescuePanelMemoProps): boolean {
  return a.redUp === b.redUp && a.onPrefs === b.onPrefs && samePrefs(a.prefs, b.prefs)
}
