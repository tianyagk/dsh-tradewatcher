/**
 * 【涨跌分布】模块的纯视图逻辑（不 import react ⇒ 能在 node 里直接断言）。
 *
 * 参考版（Arkvol）结构：左列三段紧凑内联行（涨跌趋势 / 成交量 / 两融走势）+ 右列两块
 * （柱状直方图带纵轴与网格线 / 双序列日内折线）。这里只放"能算的那部分"：
 * 直方图的纵轴刻度与网格线位置（写在纯函数里，便于把"必须有纵轴"断言死）。
 */

/**
 * 直方图纵轴：值域按**数据取整**（"nice" 步长：1/2/5 × 10ⁿ），返回 4 条网格线（含 0 与上界）。
 *
 * 为什么取整：参考版的纵轴是整洁刻度（如 0 / 500 / 1000 / 1500）；直接用最大值当上界会得到
 * "上界 = 1234" 这种刻度，读数困难。取整只影响**轴的标注与网格**，不动柱高所依据的原始计数。
 */
export function distAxisOf(counts: readonly number[]): { max: number; ticks: number[] } {
  const peak = Math.max(0, ...counts.map((c) => (Number.isFinite(c) && c > 0 ? c : 0)))
  if (peak === 0) return { max: 1, ticks: [0, 1] }
  const step = niceStep(peak / 3)
  const max = Math.ceil(peak / step) * step
  const ticks: number[] = []
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(Math.round(v))
  return { max, ticks }
}

/** 取 1/2/5 × 10ⁿ 里 ≥ raw 的最小步长（"nice number" 惯例） */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1
  const exp = Math.floor(Math.log10(raw))
  const base = Math.pow(10, exp)
  const norm = raw / base
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return mult * base
}

/** 柱高百分比：按**轴的上界**归一（不是按峰值）——否则柱顶会贴着顶点、与网格线对不上 */
export function distBarPctOf(count: number, axisMax: number): number {
  if (!(axisMax > 0)) return 0
  const pct = (Math.max(0, count) / axisMax) * 100
  return Math.min(100, Math.round(pct * 100) / 100)
}

// ── 附加行情（`/tradewatcher/market-extras`，v0.81.2）的**纯视图换算** ──────────
// 三件事：涨停/跌停（含样本）、预测全天（口径必须随值走）、两融（双源不一致时必须两个都显示）。

import type { AmountForecastWire, LimitCountSideWire, MarginCrossWire, MarginReadingWire } from './api.ts'

/** 亿元 → 显示串（保留 2 位截断，不四舍五入成假精度） */
export function fmtYi(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—'
  return `${v.toFixed(2)} 亿`
}

/** 涨停/跌停项的悬停说明：口径 + 来源 + 时刻 + 样本（可展开核对，最多 5 只） */
export function limitNoteOf(side: LimitCountSideWire | null, caliber: string, kind: '涨停' | '跌停'): string {
  const head = `${kind}家数（${kind}池接口）`
  if (side === null) return `${head}本次未取到 —— 上游没给池数据（不用 0 顶替）`
  const t = new Date(side.at).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
  const sample = side.sample
  const list = sample.length === 0
    ? '（本次没有样本行）'
    : `；池内前 ${sample.length} 只：${sample.map((r) => `${r.name}${r.pct === null ? '' : ` ${r.pct > 0 ? '+' : ''}${r.pct}%`}`).join(' / ')}`
  return `${head}：${caliber}；来源 ${side.source}；时刻 ${t}${list}`
}

/**
 * 「预测全天」这一格：**只在盘中给值**，收盘后回落实际值，其余时段/缺数据一律「未取到」+ 原因。
 * 口径（标定曲线、样本天数、生成时间、区间）**必须随值一起给**（进悬停，不铺正文）。
 */
export function forecastCellOf(f: AmountForecastWire, amountText: string): { value: string; cls: string; note: string } {
  const cal = `口径：${f.caliber.curve}；样本 ${f.caliber.samples} 天；标定生成于 ${f.caliber.generatedAt}。${f.caliber.note}`
  const band = f.band === null ? '' : `；区间 ${(f.band.low / 1e8).toFixed(0)}~${(f.band.high / 1e8).toFixed(0)} 亿`
  const progress = f.progress === null ? '' : `；已过时段占比 ${(f.progress * 100).toFixed(1)}%`
  if (f.phase === 'closed') {
    // 收盘后：实际值就是全天值 ⇒ 不给预测（避免"预测"被当成第二份数据）
    return {
      value: f.actual === null ? '未取到' : amountText,
      cls: f.actual === null ? 'tw-dim' : '',
      note: f.actual === null
        ? `收盘后应回落全天实际值，但本次实际值也没取到 —— 不用 0 顶替。${cal}`
        : `收盘后回落的是实际全天成交额（不再给预测）。${cal}`,
    }
  }
  if (f.phase === 'intraday' && f.forecast !== null) {
    return {
      value: amountText,
      cls: 'tw-dim',
      note: `盘中的预测值（非实际值）：当前累计成交额 ÷ 标定进度${progress}${band}。${cal}`,
    }
  }
  const why = f.phase === 'pre'
    ? '开盘前没有累计成交额可外推（09:30 起才给）'
    : f.phase === 'non-trading'
      ? '非交易日不预测'
      : f.missing[0]?.note ?? '本次没取到预测所需的数据'
  return { value: '未取到', cls: 'tw-dim', note: `预测全天未取到 —— ${why}；不用 0 顶替。${cal}` }
}

/**
 * 两融两个读数 → 图例行的值。**两源不一致时两个都显示**（绝不只显示一个掩盖差异）。
 * `pick` 取哪一个字段（融资余额 / 融资买入额）。
 */
export function marginRowOf(
  m: MarginCrossWire,
  pick: (r: MarginReadingWire) => number | null,
): { value: string; note: string } {
  const szse = m.szse === null ? null : pick(m.szse)
  const em = m.em === null ? null : pick(m.em)
  const parts: string[] = []
  if (szse !== null) parts.push(`深所 ${fmtYi(szse)}`)
  if (em !== null) parts.push(`东财 ${fmtYi(em)}`)
  const head = parts.length === 0
    ? '未取到'
    : parts.join(' / ')
  const mismatch = m.mismatch ? `⚠ 两源不一致（融资余额相对差 ${m.diffPct === null ? '未知' : `${(m.diffPct * 100).toFixed(1)}%`}）：深交所是深市口径、东财是沪深汇总，差异属口径 + 更新时点 ⇒ 两个读数都列出，不取其一` : m.note
  const days = [m.szse?.day, m.em?.day].filter((d): d is string => typeof d === 'string')
  return {
    value: mismatch.startsWith('⚠') ? `${head} ⚠不一致` : head,
    note: `${mismatch}${days.length === 0 ? '' : `；数据日 ${[...new Set(days)].join(' / ')}`}`,
  }
}
