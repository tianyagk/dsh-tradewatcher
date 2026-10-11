/**
 */

import { PORT_SORT_KEYS, WATCH_SORT_KEYS, type PortSortKey, type SortState, type WatchSortKey } from '../shared/model.ts'

/** 键名与允许值属于 prefs 契约（shared/model.ts）；本模块只负责文案与比较语义 */
export { PORT_SORT_KEYS, WATCH_SORT_KEYS }
export type { PortSortKey, SortState, WatchSortKey }

export const WATCH_SORT_LABEL: Record<WatchSortKey, string> = {
  default: '默认',
  pct: '当日涨跌',
  mv: '总市值',
  amount: '成交额',
  chg: '涨跌额',
  alpha: '行业α',
}

export const PORT_SORT_LABEL: Record<PortSortKey, string> = {
  default: '默认',
  mv: '市值',
  pnl: '持仓盈亏',
  dayPnl: '当日盈亏',
  weight: '仓位占比',
  price: '现价',
  cost: '成本',
}

/** 排序说明（悬浮提示用）：口径必须写在界面上，避免"这个盈亏是摊薄还是均价" */
export const WATCH_SORT_HINT: Record<WatchSortKey, string> = {
  default: '按添加顺序（分组内自定义顺序）',
  pct: '按当日涨跌幅排序（行情来自东财/腾讯/新浪，无行情者排最后）',
  mv: '按总市值排序（东财 f20 / 腾讯总市值字段；无该字段的标的——如国际指数、商品、新浪备用源——排最后）',
  amount: '按当日成交额排序（东财/腾讯的成交额字段；备用源缺该字段时排最后）。成交额是当日资金规模，不是市值',
  chg: '按当日涨跌额排序（现价 − 昨收/昨结，与界面显示的「涨跌」是同一份数）',
  alpha: '按行业 α 排序（α = 个股涨跌幅 − 所属板块涨跌幅，与界面显示的 α 同一个数）；板块行情未取到或个股无行情时 α 不可算 → 排最后',
}

export const PORT_SORT_HINT: Record<PortSortKey, string> = {
  default: '按建仓顺序',
  mv: '按持仓市值（现价 × 数量）排序，行情暂缺者排最后',
  pnl: '按当前所选口径的盈亏排序（摊薄口径=持仓盈亏，均价口径=浮动盈亏）；行情暂缺者排最后',
  dayPnl: '按当日盈亏排序（隔夜持仓 + 日内买卖 − 费用，与券商 App 一致）；行情暂缺者排最后',
  weight: '按仓位占比排序（个股市值 ÷ 组合总市值，含全部未归档分组）；总市值为 0 时该键无效，保持原顺序',
  price: '按现价排序（行情暂缺者排最后）',
  cost: '按当前所选口径的成本排序（摊薄口径=摊薄成本 / 均价口径=买入均价）—— 与「成本」列显示的是同一个数',
}

  '名称列不做排序：本插件的排序契约是「数值比较」（无效值恒沉底、同值保持原顺序）；' +
  '中文名的顺序取决于运行环境的排序表（ICU），不同环境可能给出不同结果 —— 排错比不排更糟。' +
  '要回到自定义顺序请选「默认」'



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
  /** 当日成交额（元）；备用源不给该字段时为 null */
  amount: number | null
  /** 当日涨跌额 */
  chg: number | null
  /** 行业 α = 个股涨跌幅 − 板块涨跌幅（%）；任一侧缺失时为 null */
  alpha: number | null
}

/** 自选分组内排序（默认顺序 = 原样返回副本） */
export function sortWatch<T>(items: readonly T[], state: SortState<WatchSortKey>, inputOf: (item: T) => WatchSortInput): T[] {
  if (state.key === 'default') return [...items]
  const pick = (it: T): number | null => {
    const v = inputOf(it)
    switch (state.key) {
      case 'pct': return v.pct
      case 'mv': return v.totalMv
      case 'amount': return v.amount
      case 'chg': return v.chg
      case 'alpha': return v.alpha
      default: return null
    }
  }
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
  /** 现价；行情暂缺时为 null */
  price: number | null
  /** 当前口径成本（摊薄=摊薄成本，均价=买入均价）—— 必须与「成本」列显示的是同一个数 */
  cost: number | null
}

/** 持仓分组内排序（默认顺序 = 原样返回副本） */
export function sortPositions<T>(rows: readonly T[], state: SortState<PortSortKey>, inputOf: (row: T) => PortSortInput): T[] {
  if (state.key === 'default') return [...rows]
  const pick = (row: T): number | null => {
    const v = inputOf(row)
    switch (state.key) {
      case 'mv': return v.mv
      case 'pnl': return v.pnl
      case 'dayPnl': return v.dayPnl
      case 'weight': return v.weight
      case 'price': return v.price
      case 'cost': return v.cost
      default: return null
    }
  }
  return sortByNumber(rows, pick, state.desc)
}

/** 权重：实现上移到 `shared/model.ts`（宿主组合构成与客户端共用同一份口径） */
export { weightOf } from '../shared/model.ts'

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
