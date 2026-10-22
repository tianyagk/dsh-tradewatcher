/**
 * 棱镜页的展示口径与判据（纯函数；页面与测试共用）。
 * 字号只用 12 / 14（Material 低端子集）；不写免责文案；缺数据 `—` + 一句原因。
 */
import type { PrismAnalysis, PrismNewsStatus, PrismRun, PrismSettings } from '../shared/prism.ts'
import { shStampText } from './marketTime.ts'

export const PRISM_FONT = { body: 12, title: 14 } as const

export function newsStatusText(s: PrismNewsStatus | null | undefined): string {
  if (s === null || s === undefined) return '—（尚未取到新闻状态）'
  if (s.state === 'error') return `—（${s.reason ?? '新闻源不可用'}）`
  if (s.state === 'backfilling') return `回填中（已 ${s.pages} 页）`
  if (s.state === 'idle') return '—（尚未回填）'
  return `${s.items} 条 · 最近更新 ${s.fetchedAt === null ? '—' : shStampText(s.fetchedAt)}`
}

export function analysisText(a: PrismAnalysis): string {
  if (a.text !== null && a.text !== '') return a.text
  return `—（${a.error ?? '未取到'}）`
}

export function runSummaryText(run: PrismRun | null | undefined): string {
  if (run === null || run === undefined) return '—（还没有运行记录）'
  if (run.summary !== null && run.summary !== '') return run.summary
  return `—（${run.error ?? '汇总未产出'}）`
}

export function timesText(settings: PrismSettings | null | undefined): string {
  if (settings === null || settings === undefined || settings.times.length === 0) return '—（未设置时点）'
  return settings.times.join(' / ')
}

/** 时点合法性：HH:MM、去重、1..50 个（可增删、无上限到 50） */
export function timesProblems(times: readonly string[]): string[] {
  const bad: string[] = []
  if (times.length === 0) bad.push('至少保留一个时点')
  if (times.length > 50) bad.push('时点最多 50 个')
  if (new Set(times).size !== times.length) bad.push('时点不能重复')
  for (const t of times) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) bad.push(`非法时点：${t}`)
  return bad
}

/** 页面源码判据：不得有免责文案；字号只用 12/14 */
export function prismPageProblems(src: string): string[] {
  const bad: string[] = []
  for (const word of ['免责', '风险提示', '不构成投资建议', '仅供参考']) {
    if (src.includes(word)) bad.push(`出现免责类文案「${word}」`)
  }
  for (const m of src.matchAll(/fontSize:\s*([0-9]+(?:\.[0-9]+)?)/g)) {
    const size = Number(m[1])
    if (size !== 12 && size !== 14) bad.push(`字号 ${size} 不在 12/14 内`)
  }
  return bad
}

/** ripple 判据：关键帧只许 transform/opacity；ripple 元素固定尺寸（不得动 width/height） */
export function rippleCssProblems(css: string): string[] {
  const bad: string[] = []
  const block = /@keyframes\s+tw-ripple\s*\{([\s\S]*?)\}\s*\}/.exec(css)?.[1] ?? null
  if (block === null) {
    bad.push('缺少 tw-ripple 关键帧')
  } else {
    for (const prop of ['width', 'height', 'top', 'left', 'margin', 'padding']) {
      if (new RegExp(`(^|[;{\\s])${prop}\\s*:`).test(block)) bad.push(`关键帧里出现布局属性 ${prop}`)
    }
  }
  const el = /\.tw-prism-ripple\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  if (!/width:\s*100px/.test(el) || !/height:\s*100px/.test(el)) bad.push('ripple 必须是固定 100×100')
  if (!/transform:\s*scale\(/.test(block ?? '')) bad.push('ripple 必须用 transform: scale')
  return bad
}

/* ────────────────────────── 批次 4：模拟盘展示 ────────────────────────── */

import type { PrismEquityPoint, PrismOrder, PrismTradingState } from '../shared/prism.ts'

export const PRISM_MONEY = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const PRISM_SIGNED = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${PRISM_MONEY(n)}`

/** 四格：总资产/现金/当日盈亏/累计盈亏；缺数据带原因 */
export function topCardsOf(t: PrismTradingState | null, prices?: Readonly<Record<string, number | null>>): Array<{ key: string; label: string; value: string; hint: string | null }> {
  if (t === null) {
    return [
      { key: 'equity', label: '总资产', value: '—', hint: '尚未取到模拟盘账户' },
      { key: 'cash', label: '现金', value: '—', hint: null },
      { key: 'day', label: '当日盈亏', value: '—', hint: null },
      { key: 'total', label: '累计盈亏', value: '—', hint: null },
    ]
  }
  const a = t.account
  const px = prices ?? t.prices ?? {}
  const value = a.positions.reduce((sum, p) => sum + p.qty * (px[p.secid] ?? p.cost), 0)
  const equity = a.cash + value
  const total = equity - a.capitalLimit
  const day = a.dayStartEquity === null ? null : equity - a.dayStartEquity
  return [
    { key: 'equity', label: '总资产', value: PRISM_MONEY(equity), hint: `资金上限 ${PRISM_MONEY(a.capitalLimit)}` },
    { key: 'cash', label: '现金', value: PRISM_MONEY(a.cash), hint: null },
    { key: 'day', label: '当日盈亏', value: PRISM_SIGNED(day), hint: day === null ? '当日基准净值未取到' : null },
    { key: 'total', label: '累计盈亏', value: PRISM_SIGNED(total), hint: `已实现 ${PRISM_SIGNED(a.realized)}` },
  ]
}

export function orderStatusText(o: PrismOrder): string {
  if (o.status === 'pending') return '待成交'
  if (o.status === 'filled') return '已成交'
  if (o.status === 'cancelled') return `已撤销${o.cancelReason === undefined ? '' : `（${o.cancelReason}）`}`
  return `不可成交（${o.rejectReason ?? '未给原因'}）`
}

/** 迷你净值折线：只画线，不画坐标文字；不足两点 ⇒ null */
export function sparklineOf(points: readonly PrismEquityPoint[], width = 160, height = 36): string | null {
  if (points.length < 2) return null
  const values = points.map((p) => p.equity)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  return points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * width
      const y = height - ((p.equity - min) / span) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}
