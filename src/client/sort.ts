/**
 * 列表排序（自选 / 持仓）。纯函数，无 React 依赖，便于直接测。
 *
 * 两条容易踩的坑，都在这里一次性约定：
 *  1. **空值恒排最后**：无行情、无市值、无盈亏的条目不该因为"升序"跑到最前 ——
 *     让 `null` 混进数值比较是这类功能最常见的错误（`null` 参与减法会变成 0，
 *     出现在"涨幅最小"的位置）。因此无论升序降序，无效值一律沉底。
 *  2. **稳定且可预期**：同值条目保持原顺序（默认顺序 = 用户自己添加的顺序），
 *     排序不会在每次轮询后重新洗牌；非有限值（NaN/Infinity）按无效值处理。
 */

import { PORT_SORT_KEYS, WATCH_SORT_KEYS, type PortSortKey, type SortState, type WatchSortKey } from '../shared/model.ts'

/** 键名与允许值属于 prefs 契约（shared/model.ts）；本模块只负责文案与比较语义 */
export { PORT_SORT_KEYS, WATCH_SORT_KEYS }
export type { PortSortKey, SortState, WatchSortKey }

export const WATCH_SORT_LABEL: Record<WatchSortKey, string> = {
  default: '默认',
  pct: '当日涨跌',
  mv: '总市值',
}

export const PORT_SORT_LABEL: Record<PortSortKey, string> = {
  default: '默认',
  mv: '市值',
  pnl: '持仓盈亏',
  dayPnl: '当日盈亏',
  weight: '仓位占比',
}

/** 排序说明（悬浮提示用）：口径必须写在界面上，避免"这个盈亏是摊薄还是均价" */
export const WATCH_SORT_HINT: Record<WatchSortKey, string> = {
  default: '按添加顺序（分组内自定义顺序）',
  pct: '按当日涨跌幅排序（行情来自东财/腾讯/新浪，无行情者排最后）',
  mv: '按总市值排序（东财 f20 / 腾讯总市值字段；无该字段的标的——如国际指数、商品、新浪备用源——排最后）',
}

export const PORT_SORT_HINT: Record<PortSortKey, string> = {
  default: '按建仓顺序',
  mv: '按持仓市值（现价 × 数量）排序，行情暂缺者排最后',
  pnl: '按当前所选口径的盈亏排序（摊薄口径=持仓盈亏，均价口径=浮动盈亏）；行情暂缺者排最后',
  dayPnl: '按当日盈亏排序（隔夜持仓 + 日内买卖 − 费用，与券商 App 一致）；行情暂缺者排最后',
  weight: '按仓位占比排序（个股市值 ÷ 组合总市值，含全部未归档分组）；总市值为 0 时该键无效，保持原顺序',
}

/** 有限数值才算有效；NaN / Infinity / 缺失一律视为无效值 */
export function sortValue(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 按数值排序：无效值沉底，同值保持原顺序（稳定）。
 * @param pick 取排序值的函数（返回 null 表示无效值）
 */
export function sortByNumber<T>(rows: readonly T[], pick: (row: T) => number | null, desc: boolean): T[] {
  return rows
    .map((row, index) => ({ row, index, value: sortValue(pick(row)) }))
    .sort((a, b) => {
      const x = a.value
      const y = b.value
      if (x === null && y === null) return a.index - b.index
      if (x === null) return 1
      if (y === null) return -1
      if (x === y) return a.index - b.index
      return desc ? y - x : x - y
    })
    .map((e) => e.row)
}

export interface WatchSortInput {
  /** 当日涨跌幅（%） */
  pct: number | null
  /** 总市值（元） */
  totalMv: number | null
}

/** 自选分组内排序（默认顺序 = 原样返回副本） */
export function sortWatch<T>(items: readonly T[], state: SortState<WatchSortKey>, inputOf: (item: T) => WatchSortInput): T[] {
  if (state.key === 'default') return [...items]
  const pick = state.key === 'pct' ? (it: T): number | null => inputOf(it).pct : (it: T): number | null => inputOf(it).totalMv
  return sortByNumber(items, pick, state.desc)
}

export interface PortSortInput {
  /** 持仓市值 */
  mv: number
  /** 当前口径盈亏（摊薄=持仓盈亏，均价=浮动盈亏）；行情暂缺时为 null */
  pnl: number | null
  dayPnl: number
  /** 仓位占比（0–1），总市值为 0 时为 null */
  weight: number | null
}

/** 持仓分组内排序（默认顺序 = 原样返回副本） */
export function sortPositions<T>(rows: readonly T[], state: SortState<PortSortKey>, inputOf: (row: T) => PortSortInput): T[] {
  if (state.key === 'default') return [...rows]
  const pick = (row: T): number | null => {
    const v = inputOf(row)
    if (state.key === 'mv') return v.mv
    if (state.key === 'pnl') return v.pnl
    if (state.key === 'dayPnl') return v.dayPnl
    return v.weight
  }
  return sortByNumber(rows, pick, state.desc)
}

/** 仓位占比：分母为组合总市值；总市值 <= 0 时返回 null（避免除零得到 Infinity） */
export function weightOf(mv: number, grandTotalMv: number): number | null {
  if (!Number.isFinite(mv) || !Number.isFinite(grandTotalMv) || grandTotalMv <= 0) return null
  return mv / grandTotalMv
}

/**
 * 点击排序段控的行为：同键再点一次翻转方向，换键则用该键的默认方向。
 * 默认方向一律降序（涨幅/市值/盈亏/占比都是"大在前"更常看）。
 */
export function nextSortState<K extends string>(state: SortState<K>, key: K): SortState<K> {
  if (state.key === key) return { key, desc: !state.desc }
  return { key, desc: true }
}

/** 方向标记（↓ 降序 / ↑ 升序），供按钮文案与 aria-label 使用 */
export function sortArrow(desc: boolean): string {
  return desc ? '↓' : '↑'
}

/** 排序状态的宽松校验（prefs 来自明文文件，可能被人手改成任意值） */
export function normalizeSortState<K extends string>(raw: unknown, keys: readonly K[], fallback: SortState<K>): SortState<K> {
  if (raw === null || typeof raw !== 'object') return fallback
  const o = raw as { key?: unknown; desc?: unknown }
  const key = typeof o.key === 'string' && (keys as readonly string[]).includes(o.key) ? (o.key as K) : fallback.key
  const desc = typeof o.desc === 'boolean' ? o.desc : fallback.desc
  return { key, desc }
}
