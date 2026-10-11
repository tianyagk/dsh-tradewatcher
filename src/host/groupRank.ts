/**
 * 分组一屏排序 + 分档统计 + 文本分位（P1-5 / P2-1 / P2-3）—— 纯函数部分。
 *
 * 三条纪律：
 *  ① 缺失沉底：算不出指标的条目排在最后（既有约定），并在行里写 `—` + 原因，不参与药丸计数；
 *  ② 药丸各档之和 = 总数（含"未取到"一档），断言锁住；
 *  ③ 文本分位 只用我们能算出来的东西：分位＝近 30 日涨跌幅在窗口内的分位；
 *     变化量＝与前一日的分位差；新高/新低＝窗口内比较。任何一项算不出来就不写那一段。
 */
import type { DailyBarLite } from '../shared/model.ts'

export type RankBucket = '极冷' | '偏冷' | '中性' | '偏热' | '极热' | '上涨' | '平盘' | '下跌' | '未取到'

export interface RankRowInput {
  secid: string
  name: string
  /**指标值（涨跌幅% / 区间位置% / 温度分位%）；缺失 null */
  value: number | null
  /**该行的短标签（如 接近低点 / 适中 / +1.23%）；缺失时给 null */
  label: string | null
  /**缺原因（缺失时的说明） */
  why?: string | null
}

export interface RankRow extends RankRowInput {
  bucket: RankBucket
  /**一句话状态（文本分位等；没有可写的就不给） */
  note: string | null
}

export interface RankResult {
  rows: RankRow[]
  /**统计药丸：各档计数，之和 = 行数 */
  pills: Array<{ bucket: RankBucket; count: number }>
  /**分档汇总一行（如「3 只接近低点 / 1 只区间内」） */
  bucketLine: string
  total: number
}

/**默认分档：按指标值（0–100 分位口径）落档；缺失 ⇒ 未取到 */
export function bucketOf(value: number | null): RankBucket {
  if (value === null) return '未取到'
  if (value < 10) return '极冷'
  if (value < 30) return '偏冷'
  if (value < 70) return '中性'
  if (value < 90) return '偏热'
  return '极热'
}

/**分档顺序（药丸按此顺序展示，便于扫读） */
const ORDER: RankBucket[] = ['极冷', '偏冷', '中性', '偏热', '极热', '上涨', '平盘', '下跌', '未取到']

/**
 * 涨跌幅口径的分档（与分位口径不能混用：实测把 +3.14% 这类涨幅塞进 0–100 的分位桶里，
 * 全部会落进「极冷」——那是静默错答）。涨跌幅只有三档：上涨 / 平盘 / 下跌。
 */
export function returnBucketOf(value: number | null): RankBucket {
  if (value === null) return '未取到'
  if (value > 0.0001) return '上涨'
  if (value < -0.0001) return '下跌'
  return '平盘'
}

/**
 * 主入口：排序（默认按 bucket 从冷到热，缺失沉底）+ 药丸 + 分档行。
 * 传 `notes` 可给每行补一句"文本分位"（由 `textPercentile` 生成）。
 */
export function rankOf(
  rows: readonly RankRowInput[],
  notes: Readonly<Record<string, string>> = {},
  /**分档函数：分位口径用 `bucketOf`（默认），涨跌幅口径必须传 `returnBucketOf` */
  bucket: (value: number | null) => RankBucket = bucketOf,
): RankResult {
  const withBucket: RankRow[] = rows.map((r) => ({
    ...r,
    bucket: bucket(r.value),
    note: notes[r.secid] ?? null,
  }))
  const sorted = withBucket.slice().sort((a, b) => {
    if (a.bucket === '未取到' && b.bucket !== '未取到') return 1
    if (b.bucket === '未取到' && a.bucket !== '未取到') return -1
    if (a.value === null || b.value === null) return 0
    return b.value - a.value
  })
  const counts = new Map<RankBucket, number>(ORDER.map((b) => [b, 0]))
  for (const r of sorted) counts.set(r.bucket, (counts.get(r.bucket) ?? 0) + 1)
  const pills = ORDER.map((bucket) => ({ bucket, count: counts.get(bucket) ?? 0 })).filter((p) => p.count > 0)
  const sum = pills.reduce((n, p) => n + p.count, 0)
  // 分档行：用"只数 + 档名"，缺失那档写成「未取到 N 只」
  const parts = pills.filter((p) => p.bucket !== '未取到').map((p) => `${p.count} 只${p.bucket}`)
  const miss = counts.get('未取到') ?? 0
  return {
    rows: sorted,
    pills,
    bucketLine: [...parts, ...(miss > 0 ? [`未取到 ${miss} 只`] : [])].join(' / ') || '—',
    total: sum,
  }
}

export interface TextPercentile {
  /**近 N 日分位（%） */
  pct: number
  /**与前一日的分位差（百分点）；算不出 ⇒ null */
  delta: number | null
  /**窗口内新高/新低（同一天既不是新高也不是新低） */
  extreme: 'high' | 'low' | null
  /**文本：近 30 日分位 82%（↑12，8 日新高）—— 每一段都只在能算出来时才写 */
  text: string
}

/**
 * 文本分位（P2-3）：把"图上看得见、文本看不见"的分位说清楚。
 * 口径：用近 `window` 根日线的收盘涨跌幅序列，取最后一根的涨跌幅在窗口内的分位；
 * 分位变化＝与"上一根在各自窗口内的分位"之差；新高/新低＝最后一根收盘是否窗口内最高/最低。
 */
export function textPercentile(bars: readonly DailyBarLite[], window = 30): TextPercentile | null {
  if (bars.length < 3) return null
  const returns: number[] = []
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1].close
    const cur = bars[i].close
    if (prev > 0) returns.push((cur / prev - 1) * 100)
  }
  if (returns.length < 2) return null
  const pctAt = (upTo: number): number => {
    const from = Math.max(0, upTo - window + 1)
    const slice = returns.slice(from, upTo + 1)
    const last = returns[upTo]
    if (slice.length === 0) return 0
    return (slice.filter((x) => x <= last).length / slice.length) * 100
  }
  const lastIdx = returns.length - 1
  const pct = pctAt(lastIdx)
  const prevPct = lastIdx - 1 >= 0 ? pctAt(lastIdx - 1) : null
  const delta = prevPct === null ? null : Number((pct - prevPct).toFixed(1))
  const win = bars.slice(-window)
  const lastClose = bars[bars.length - 1].close
  const hi = Math.max(...win.map((b) => b.close))
  const lo = Math.min(...win.map((b) => b.close))
  const extreme: TextPercentile['extreme'] = lastClose >= hi && win.length >= 2 ? 'high' : lastClose <= lo && win.length >= 2 ? 'low' : null
  const parts = [`近 ${Math.min(window, returns.length)} 日分位 ${pct.toFixed(0)}%`]
  const inner: string[] = []
  if (delta !== null && Math.abs(delta) >= 1) inner.push(`${delta > 0 ? '↑' : '↓'}${Math.abs(delta).toFixed(0)}`)
  if (extreme === 'high') inner.push(`${win.length} 日新高`)
  if (extreme === 'low') inner.push(`${win.length} 日新低`)
  return { pct, delta, extreme, text: inner.length > 0 ? `${parts[0]}（${inner.join('，')}）` : parts[0] }
}
