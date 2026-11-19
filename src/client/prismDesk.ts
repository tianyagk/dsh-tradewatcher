/**
 * 棱镜 · AGENT DESK（第一批）展示纯函数：
 * 顶部状态条 + 左栏（资产上限 / 持仓明细）用到的格式化与派生。
 *
 * 三条红线写在这里，页面只做渲染：
 * 1. 约束六格的**设计稿默认值只做 placeholder**（`LIMIT_FALLBACK`），任何计算函数都拿不到它；
 * 2. 顶部 `#N` 只认 `desk.performance.runsCount`，无源给 `—`（不写 0）；
 * 3. 权重分母只认 `desk.overview.totalAssets`（宿主口径），缺则 —。
 */

/** 资产上限滑杆：0–500 万，step 0.1 万（设计稿 step 0.5 只适用整数百万，真实 180 万落不了位） */
export const CAP_MIN = 0
export const CAP_MAX = 5_000_000
export const CAP_STEP = 100_000
export const CAP_TICKS: ReadonlyArray<string> = ['0', '100万', '200万', '300万', '500万']

/**
 * 六格设计稿默认值（顺序与设计稿一致）。
 * **只允许**出现在 input 的 placeholder / 灰字里；`usageOf` 等计算函数签名里没有 settings，
 * 从结构上保证「默认值不参与计算」不是靠自觉。
 */
export const LIMIT_FALLBACK: Readonly<Record<string, string>> = {
  perStockPct: '15',
  perOrderYuan: '200000',
  maxPosPct: '85',
  stopLossPct: '8',
  maxDDPct: '5',
  minCashPct: '15',
}

/** 顶部 ? 浮层：3 行以内（谁能设约束 / 谁执行 / 只读范围），每行 ≤20 字 */
export const HELP_LINES: ReadonlyArray<string> = [
  '约束仅人类可设，Agent 不可改',
  '选股分析挂单由 Agent 执行',
  '本页只读回读，不代下单',
]

/** 千分位（整数元）；null/NaN ⇒ `—`，绝不输出 NaN */
export function groupOf(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  const n = Math.round(v)
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 万元（默认 1 位小数）：1240226 ⇒ `124.0万`；null ⇒ `—` */
export function wanOf(v: number | null | undefined, digits = 1): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  return `${(v / 1e4).toFixed(digits)}万`
}

/** 带 ¥ 的万元：1240226 ⇒ `¥124.0万`；null ⇒ `—`（不写 ¥—） */
export function moneyWanOf(v: number | null | undefined, digits = 1): string {
  const t = wanOf(v, digits)
  return t === '—' ? '—' : `¥${t}`
}

/** 盈亏（整数元 + 符号）：-217746 ⇒ `-217,746`；0 ⇒ `0`；null ⇒ `—` */
export function pnlTextOf(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  const n = Math.round(v)
  const sign = n > 0 ? '+' : ''
  return `${sign}${groupOf(n)}`
}

/** 涨跌色：>0 ⇒ up（红涨），<0 ⇒ down（绿跌），0/null ⇒ flat */
export function pnlToneOf(v: number | null | undefined): 'up' | 'down' | 'flat' {
  if (typeof v !== 'number' || !Number.isFinite(v) || v === 0) return 'flat'
  return v > 0 ? 'up' : 'down'
}

/** (现价 / 成本 − 1) × 100：行尾 title 用；任一缺失 ⇒ null（不猜） */
export function pnlPctOf(price: number | null | undefined, cost: number | null | undefined): string | null {
  if (typeof price !== 'number' || typeof cost !== 'number' || !Number.isFinite(price) || !Number.isFinite(cost) || cost <= 0) return null
  const pct = (price / cost - 1) * 100
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`
}

export interface UsageView {
  /** 已用 / 上限（0–1）；上限为 0 或任一缺失 ⇒ null */
  ratio: number | null
  /** `¥124.0万` / `—` */
  usedText: string
  /** `¥180.0万` / `—` */
  limitText: string
  /** `68.9%` / `—` */
  pctText: string
  /** `31.1pt`（距 100% 上限还剩多少个百分点）/ `—` */
  gapText: string
  exceeded: boolean
  /** `已用 68.9% · 距上限还有 31.1pt` */
  noteText: string
}

/**
 * 已用额度：只用「已用市值 / 资产上限」两个真实数，**不接受任何约束默认值**。
 * 超限 ⇒ exceeded（进度条转危险色、文案不写负数剩余）。
 */
export function usageOf(limit: number | null | undefined, used: number | null | undefined): UsageView {
  const hasLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0
  const hasUsed = typeof used === 'number' && Number.isFinite(used)
  const usedText = moneyWanOf(hasUsed ? used : null)
  const limitText = moneyWanOf(hasLimit ? limit : null)
  if (!hasLimit || !hasUsed) {
    return { ratio: null, usedText, limitText, pctText: '—', gapText: '—', exceeded: false, noteText: '—' }
  }
  const ratio = used / limit
  const pct = ratio * 100
  const exceeded = used > limit
  const pctText = `${pct.toFixed(1)}%`
  const gapText = `${Math.max(0, 100 - pct).toFixed(1)}pt`
  const noteText = exceeded ? `已用 ${pctText} · 超上限 ${(pct - 100).toFixed(1)}pt` : `已用 ${pctText} · 距上限还有 ${gapText}`
  return { ratio, usedText, limitText, pctText, gapText, exceeded, noteText }
}

/** 顶部 `RUNNING #N`：runsCount 非负整数才写；其余（undefined/null/NaN）⇒ `#—` */
export function runsBadgeOf(runsCount: number | null | undefined): string {
  return typeof runsCount === 'number' && Number.isFinite(runsCount) && runsCount >= 0 ? `#${Math.trunc(runsCount)}` : '#—'
}

/** `1.600938` ⇒ `600938`（展示用；不改写回包） */
export function codeOf(secid: string): string {
  const i = secid.indexOf('.')
  return i < 0 ? secid : secid.slice(i + 1)
}

/**
 * 权重：**分母只认 `desk.overview.totalAssets`**（宿主同一口径）。
 * 不用 Σ 持仓市值当分母（现金会让占比偏大），也不做 0/1 兜底。
 */
export function weightOf(marketValue: number | null | undefined, totalAssets: number | null | undefined): number | null {
  if (typeof marketValue !== 'number' || !Number.isFinite(marketValue)) return null
  if (typeof totalAssets !== 'number' || !Number.isFinite(totalAssets) || totalAssets <= 0) return null
  return marketValue / totalAssets
}

/** 权重百分比：0.2443 ⇒ `24.4%`；null ⇒ `—` */
export function weightTextOf(w: number | null | undefined): string {
  if (typeof w !== 'number' || !Number.isFinite(w)) return '—'
  return `${(w * 100).toFixed(1)}%`
}

/** 浮盈合计：任一行缺 pnl ⇒ `—`（不做「部分求和」冒充全量） */
export function pnlSumOf(rows: ReadonlyArray<{ pnl: number | null }>): number | null {
  if (rows.length === 0) return null
  let sum = 0
  for (const r of rows) {
    if (typeof r.pnl !== 'number' || !Number.isFinite(r.pnl)) return null
    sum += r.pnl
  }
  return sum
}

/** 约束版本：宿主无字段 ⇒ `—`（title 说明），不编号 */
export function constraintVersionOf(version: string | number | null | undefined): string {
  if (version === null || version === undefined || version === '') return '—'
  return `v${String(version).replace(/^v/i, '')}`
}

/** 草稿六格 → 请求体：空 ⇒ 保留宿主原值（null 就发 null，绝不把 placeholder 默认值写进存档） */
export interface ConstraintPayload {
  ok: boolean
  values: Record<string, number | null>
  /** 校验失败时的字段与原因（ok=true 时忽略） */
  key?: string
  error?: string
}

export function constraintPayloadOf(
  draft: Record<string, string>,
  saved: Record<string, number | null | undefined>,
  keys: ReadonlyArray<string>,
): ConstraintPayload {
  const values: Record<string, number | null> = {}
  for (const key of keys) {
    const raw = (draft[key] ?? '').trim()
    if (raw === '') {
      const v = saved[key]
      values[key] = typeof v === 'number' && Number.isFinite(v) ? v : null
      continue
    }
    const n = Number(raw)
    if (!Number.isFinite(n)) return { ok: false, values, key, error: '约束必须是数字' }
    if (n < 0) return { ok: false, values, key, error: '约束不能为负' }
    if (key === 'perOrderYuan') {
      if (n > 1e9) return { ok: false, values, key, error: '单笔金额上限过大' }
    } else if (n > 100) {
      return { ok: false, values, key, error: '百分比约束不能超过 100' }
    }
    values[key] = n
  }
  return { ok: true, values }
}

/** 草稿 vs 生效值：任一格与宿主值不同 ⇒ dirty（空草稿 = 未改） */
export function constraintsDirtyOf(
  draft: Record<string, string>,
  saved: Record<string, number | null | undefined>,
  keys: ReadonlyArray<string>,
): boolean {
  return keys.some((key) => {
    const raw = (draft[key] ?? '').trim()
    if (raw === '') return false
    const n = Number(raw)
    if (!Number.isFinite(n)) return true
    const v = saved[key]
    const savedNum = typeof v === 'number' && Number.isFinite(v) ? v : null
    return savedNum === null || Math.round(n * 100) !== Math.round(savedNum * 100)
  })
}
