/**
 * 全球期货交易时钟：视图层纯函数（卡片模型 / 时区选项 / 圆心自检）。
 * 所有"缺数据"都必须落到 `—` + 原因，**不许 0 或旧值占位**。
 */
import type { QuoteRow } from '../shared/model.ts'

export interface ClockSpec { secid: string; name: string; code: string }

/** 主要指数 6 条（与设计稿一致；secid 由宿主报价层解析） */
export const INDEX_SPECS: readonly ClockSpec[] = [
  { secid: '1.000001', name: '上证指数', code: '000001' },
  { secid: '1.399001', name: '深证成指', code: '399001' },
  { secid: '1.399006', name: '创业板指', code: '399006' },
  { secid: '1.000300', name: '沪深 300', code: '000300' },
  { secid: '1.000905', name: '中证 500', code: '000905' },
  { secid: '1.000852', name: '中证 1000', code: '000852' },
]

/** 期货自选 5 条（主连；东财优先、失败切新浪） */
export const FUTURE_SPECS: readonly ClockSpec[] = [
  { secid: '112.AU0', name: 'AU 黄金', code: 'AU0' },
  { secid: '112.AG0', name: 'AG 白银', code: 'AG0' },
  { secid: '112.CU0', name: 'CU 铜', code: 'CU0' },
  { secid: '112.LC0', name: 'LC 碳酸锂', code: 'LC0' },
  { secid: '101.GC00Y', name: 'GC 黄金', code: 'GC00Y' },
]

const SOURCE_LABEL: Record<string, string> = { em: '东财', sina: '新浪', tencent: '腾讯' }

export interface ClockCard {
  name: string
  code: string
  /** 有价 = 千分位数字；无价 = `—` */
  value: string
  /** 涨跌幅（已带符号）；无值 = `—` */
  pct: string
  source: string
  /** 数据时刻 `HH:MM:SS`；无值 = `—` */
  at: string
  status: 'ok' | 'missing'
  /** 无数据时的原因（有数据 = null） */
  reason: string | null
}

function two(n: number): string { return n < 10 ? `0${n}` : String(n) }

export function formatClock(ms: number, offsetMin: number): string {
  const d = new Date(ms + offsetMin * 60_000)
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`
}

export function formatStamp(ms: number, offsetMin: number): string {
  const d = new Date(ms + offsetMin * 60_000)
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`
}

export function formatPrice(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function formatPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

/**
 * 一张卡：有价 → 数值 + 涨跌 + 来源/时刻；无价 → `—` + 原因（`missing` 里点名 ⇒ 东财熔断，
 * 否则"源未给价"）。**任何情况下都不写 0 或旧值。**
 */
export function quoteCard(spec: ClockSpec, row: QuoteRow | undefined, missing: readonly string[]): ClockCard {
  const hasPrice = row !== undefined && row.price !== null && Number.isFinite(row.price)
  if (!hasPrice) {
    return {
      name: spec.name,
      code: spec.code,
      value: '—',
      pct: '—',
      source: '东财',
      at: '—',
      status: 'missing',
      reason: missing.includes(spec.secid) ? '东财熔断，仅东财一个源' : '源未给价',
    }
  }
  const atMs = row.at ?? row.time
  return {
    name: spec.name,
    code: spec.code,
    value: formatPrice(row.price as number),
    pct: row.pct === null ? '—' : formatPct(row.pct),
    source: SOURCE_LABEL[row.source ?? 'em'] ?? String(row.source),
    at: atMs === null || atMs === undefined ? '—' : formatStamp(atMs, 480),
    status: 'ok',
    reason: null,
  }
}

/** 时区下拉：默认北京；「本地」按浏览器时区；其余是常用市场时区 */
export interface ZoneOption { key: string; label: string; tz: string | null }

export const ZONE_OPTIONS: readonly ZoneOption[] = [
  { key: 'bj', label: '北京 UTC+8', tz: 'Asia/Shanghai' },
  { key: 'local', label: '本地', tz: null },
  { key: 'ny', label: '纽约', tz: 'America/New_York' },
  { key: 'ldn', label: '伦敦', tz: 'Europe/London' },
  { key: 'tyo', label: '东京', tz: 'Asia/Tokyo' },
  { key: 'sgp', label: '新加坡', tz: 'Asia/Singapore' },
  { key: 'hkg', label: '香港', tz: 'Asia/Hong_Kong' },
  { key: 'dxb', label: '迪拜', tz: 'Asia/Dubai' },
  { key: 'ber', label: '柏林', tz: 'Europe/Berlin' },
]

/** 显示时区的偏移（分钟）：本地 ⇒ 浏览器时区；其它 ⇒ `Intl` */
export function zoneOffsetOf(option: ZoneOption, atMs: number): number {
  const tz = option.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(atMs))
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0')
  return Math.round((Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) - Math.floor(atMs / 1000) * 1000) / 60_000)
}

/**
 * 圆心文字自检：只看"页面自己的 CSS 有没有引入偏移"。
 * 合格 = 覆盖层 `inset:0 + display:grid + place-items:center`、三行 18px、无 top/margin 偏移。
 * 返回 `{dx, dy}`（应为 0）；注入 `margin-top:24px` ⇒ dy=12（grid 居中吃一半外边距）⇒ 判失败。
 */
export function centerOffsetPx(css: string): { dx: number; dy: number; problems: string[] } {
  const problems: string[] = []
  const block = (sel: string): string => {
    const re = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g')
    let out = ''
    for (const m of css.matchAll(re)) out += `${m[1] ?? ''};`
    return out
  }
  const layer = block('.tw-clock-center')
  const text = block('.tw-clock-text')
  const rows = block('.tw-clock-text>div')
  if (!/inset:\s*0/.test(layer)) problems.push('.tw-clock-center 必须 inset:0（不得用 top/left 手写偏移）')
  if (!/display:\s*grid/.test(layer) || !/place-items:\s*center/.test(layer)) problems.push('.tw-clock-center 必须 grid + place-items:center')
  if (/(^|;)\s*(top|left)\s*:/.test(layer)) problems.push('.tw-clock-center 不得写 top/left')
  if (!/height:\s*18px/.test(rows) || !/line-height:\s*18px/.test(rows)) problems.push('三行必须固定 18px 行高')
  const marginTop = /margin-top:\s*(-?[0-9.]+)px/.exec(text) ?? /margin-top:\s*(-?[0-9.]+)px/.exec(rows)
  const dy = marginTop === null ? 0 : Number(marginTop[1]) / 2
  if (dy !== 0) problems.push(`文字块有 margin-top，垂直偏移 ${dy}px`)
  return { dx: 0, dy, problems }
}
