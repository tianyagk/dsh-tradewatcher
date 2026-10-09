/**
 * 大盘页布局与密度的**纯逻辑**（不 import react）。
 *
 * 依据 `docs/DESIGN-DASHBOARD.md`：空旷的根因不是元素少，而是"每个数值占 52–60px 的两行卡"
 * 加"6 列表格被 width:100% 摊到 2100px"。这里放三件可断言的事：
 *  1. `boardSpans()` —— 12 栏网格的档位（断点只有 1080，与 `WIDE_MIN_PX` 同源）；
 *  2. `breadthMetrics()` —— 家数缺失时**塌成一格**（R4：空值不占位），但真 0 不能被当成缺失；
 *  3. `percentileBar()` —— 分布条（空样本必须给 `{ok:false}`，**绝不返回全 0 数组**）。
 */

/** 板块在 12 栏网格里的占位（`≥1080` 档；窄屏由 CSS 退回单列，不在这里判断） */
export interface BoardSpans {
  single: boolean
  b1: number
  b2: number
  b3: number
  b4: number
  b5: number
}

/** 与 `wide.ts` 的 `WIDE_MIN_PX` 同一个数（此处只用于"档位是否切换"的断言与文档） */
export const BOARD_WIDE_MIN_PX = 1080

/** 12 栏档位（`<1080` 全单列）。1440 与 2142 同档 —— 断言里锁着这一点。 */
export function boardSpans(width: number): BoardSpans {
  if (!Number.isFinite(width) || width < BOARD_WIDE_MIN_PX) {
    return { single: true, b1: 12, b2: 12, b3: 12, b4: 12, b5: 12 }
  }
  return { single: false, b1: 5, b2: 7, b3: 12, b4: 7, b5: 5 }
}

/** 单行指标条的条目：`value === null` ⇒ 显示 `—`（缺失，不带数字） */
export interface MetricItem {
  key: string
  label: string
  /** 显示值；null 表示不可得（渲染成 `—`，绝不是 0） */
  value: string | null
  /** 方向（用于红绿）：1 涨 / -1 跌 / null 中性 */
  dir: number | null
  /** 不可得时的原因（人话）；可得时为 null */
  reason: string | null
  /** 悬停补充（例如"自行统计 + 统计完成时刻"）；可选 */
  title?: string
}

/**
 * 家数三格：**缺失 ⇒ 只出 1 项**（`涨跌家数 —`，宽=三格），原因在该行尾出现一次；
 * 可得 ⇒ 出 3 项（上涨/下跌/平盘）。
 *
 * 真 0 与缺失必须分得开：`up/down/even` 真是 0 时照样出 3 项、显示 `0`；
 * 只有 `countsOk === false`（`breadthCells` 的判据，勿自算）才是缺失。
 */
export function breadthMetrics(args: {
  countsOk: boolean
  up: number | null
  down: number | null
  even: number | null
  reason: string | null
}): MetricItem[] {
  if (!args.countsOk || args.up === null || args.down === null || args.even === null) {
    return [{ key: 'counts', label: '涨跌家数', value: null, dir: null, reason: args.reason ?? '原因未给出' }]
  }
  return [
    { key: 'up', label: '上涨', value: String(args.up), dir: 1, reason: null },
    { key: 'down', label: '下跌', value: String(args.down), dir: -1, reason: null },
    { key: 'even', label: '平盘', value: String(args.even), dir: null, reason: null },
  ]
}

/** 一条成交额指标（缺失时 value 为 null，独立判定，不跟着家数一起塌） */
export function amountMetric(key: string, label: string, amount: number | null): MetricItem {
  return {
    key,
    label,
    value: amount === null || !Number.isFinite(amount) ? null : String(amount),
    dir: null,
    reason: amount === null ? '本轮行情未给出该市场成交额' : null,
  }
}

/**
 * 可见原因**压缩**：取原文的第一段（`；`/`。` 之前）并截到 `max` 字，超出加 `…`。
 * 只截断不编造 —— 完整原文仍然在 `title`/`aria-label` 里。
 */
export function shortReason(text: string, max = 48): string {
  const head = text.split(/[；;]/)[0] ?? text
  const cut = head.length > max ? `${head.slice(0, max)}…` : head
  return cut.replace(/[。，,]$/, '')
}

export interface PercentileBar {
  ok: boolean
  /** 不可得的原因（`ok=false` 时非空）；返回时**绝不**是全 0 数组 */
  reason: string | null
  /** 升序、长度 ≤ 60 的历史值（用于画竖条） */
  bars: number[]
  /** 当前值在 `[min,max]` 里的位置（0–1）；不可得时为 null */
  at: number | null
}

/**
 * 历史分布条的数据准备：`samples` = `/tradewatcher/breadth` 的 `percentile.samples`（历史每日上涨占比）。
 *
 * 口径提示：这是**近 N 日"每日上涨占比"的分布**，不是当日涨跌分档直方图（后者当前数据源拿不到）。
 * 空样本 / 当前值不可得 ⇒ `{ok:false}`；**不返回全 0 数组**（全 0 会被画成一条有内容的条）。
 */
export function percentileBar(samples: readonly number[], value: number | null, limit = 60): PercentileBar {
  const clean = samples.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (clean.length === 0) return { ok: false, reason: '尚无历史快照（收盘后每交易日记一条）', bars: [], at: null }
  if (value === null || !Number.isFinite(value)) return { ok: false, reason: '当前上涨占比不可得', bars: [], at: null }
  const bars = clean.slice(-Math.max(1, Math.round(limit)))
  const min = bars[0]
  const max = bars[bars.length - 1]
  const at = max === min ? 0.5 : Math.min(1, Math.max(0, (value - min) / (max - min)))
  return { ok: true, reason: null, bars, at }
}
