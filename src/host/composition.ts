/**
 * 组合构成：权重 / 行业·市场分布 / 集中度（纯函数）。
 *
 * 三条口径：
 *  ① 权重 = 单条市值 ÷ 可计价总市值 × 100，可计价行合计恒为 100%±0.01；
 *     缺价的行不进分母（权重 `null`），并在 `unpriced` 里如实计数 —— 不许当 0 参与，否则总权重会缩水；
 *  ② 行业只用在本地已有数据（分组名＝主题/行业标签）：拿不到就是 `null`（界面显示 `—`），
 *     绝不按 secid 前缀猜行业（那会把"看起来合理"的错数发给用户）；
 *  ③ 市场按 secid 前缀做确定性映射（交易所/品种边界清晰，不属于猜测）。
 */
import { marketOf as sharedMarketOf, weightOf, type FqMode } from '../shared/model.ts'

export interface CompositionInput {
  id: string
  name: string
  secid: string
  market: string
  qty: number
  /**现价；缺失 ⇒ 不参与权重 */
  price: number | null
  /**本地已有的行业/主题标签（分组名）。没有就 null */
  groupName: string | null
}

export interface CompositionRow {
  id: string
  name: string
  secid: string
  market: string
  mv: number | null
  weightPct: number | null
  /**行业/主题：只来自本地分组名；拿不到是 null（界面写 —） */
  sector: string | null
}

export interface CompositionSlice {
  key: string
  weightPct: number
  count: number
}

export interface Composition {
  rows: CompositionRow[]
  /**可计价总市值 */
  totalMv: number
  /**缺价条数（未计入权重分母） */
  unpriced: number
  sectors: CompositionSlice[]
  markets: CompositionSlice[]
  concentration: {
    /**第一大权重（%） */
    top1: number
    /**前三大合计（%） */
    top3: number
    /**赫芬达尔指数（0–1，越大越集中） */
    hhi: number
    /**条数（可计价） */
    n: number
  }
}

/**
 * 市场标签：复用 `shared/model.ts` 的 `marketOf`（单一来源），只把枚举翻成中文标签。
 * 这是确定性映射（交易所/品种边界清晰），与"按代码猜行业"是两回事。
 */
const MARKET_LABEL: Record<string, string> = {
  cn: 'A股', hk: '港股', us: '美股', intl: '国际指数', futures: '期货/商品', unknown: '其它',
}

export function marketOf(secid: string): string {
  return MARKET_LABEL[sharedMarketOf(secid)] ?? '其它'
}

/**把调用方给的 market（可能是 shared 的枚举 `cn`/`hk`…）统一翻成中文标签；已是标签的原样返回 */
export function marketLabelOf(market: string): string {
  return MARKET_LABEL[market] ?? market
}

const sliceOf = (rows: readonly CompositionRow[], keyOf: (r: CompositionRow) => string | null): CompositionSlice[] => {
  const map = new Map<string, { weightPct: number; count: number }>()
  for (const r of rows) {
    const key = keyOf(r)
    if (key === null || r.weightPct === null) continue
    const cur = map.get(key) ?? { weightPct: 0, count: 0 }
    cur.weightPct += r.weightPct
    cur.count += 1
    map.set(key, cur)
  }
  return [...map.entries()]
    .map(([key, v]) => ({ key, weightPct: v.weightPct, count: v.count }))
    .sort((a, b) => b.weightPct - a.weightPct)
}

/**主入口 */
export function compositionOf(items: readonly CompositionInput[]): Composition {
  const priced = items.filter((it) => it.price !== null && Number.isFinite(it.price) && it.price !== null)
  const totalMv = priced.reduce((n, it) => n + it.qty * (it.price as number), 0)
  const rows: CompositionRow[] = items.map((it) => {
    const mv = it.price === null || !Number.isFinite(it.price) ? null : it.qty * it.price
    // 百分比（与 shared 的 `weightOf` 的分数不同单位，故此处单列一个换算）
    const weightPct = mv === null || totalMv <= 0 ? null : weightPctOf(mv, totalMv)
    return { id: it.id, name: it.name, secid: it.secid, market: marketLabelOf(it.market), mv, weightPct, sector: it.groupName }
  })
  const weights = rows.map((r) => r.weightPct).filter((w): w is number => w !== null).sort((a, b) => b - a)
  const n = weights.length
  const hhi = weights.reduce((s, w) => s + (w / 100) ** 2, 0)
  return {
    rows,
    totalMv,
    unpriced: items.length - priced.length,
    // 行业切片只统计有标签的行（拿不到的行进不了任何切片，也不编"未知"）
    sectors: sliceOf(rows, (r) => r.sector),
    markets: sliceOf(rows, (r) => r.market),
    concentration: {
      top1: n > 0 ? weights[0] : 0,
      top3: weights.slice(0, 3).reduce((s, w) => s + w, 0),
      hhi: Number(hhi.toFixed(4)),
      n,
    },
  }
}

/**权重（分数，0.25＝25%）：实现上移到 `shared/model.ts`，宿主与客户端共用同一份 */
export { weightOf } from '../shared/model.ts'

/**权重（百分比，25＝25%）：组合构成专用；与 `weightOf` 同源不同单位，别混用 */
export function weightPctOf(mv: number | null, totalMv: number): number | null {
  const fraction = weightOf(mv, totalMv)
  return fraction === null ? null : fraction * 100
}

/**前复权口径提示（位置/组合里凡涉及"跨期比较"的地方都该带上） */
export const FQ_NOTE: Record<FqMode, string> = {
  0: '不复权',
  1: '前复权',
  2: '后复权',
}
