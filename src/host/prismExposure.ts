/** 持仓行业暴露（只读聚合；行业来自既有 f127，宽基按目录去重；未穿透/现金独立） */
import type { PrismExposure, PrismExposureRow } from '../shared/prism.ts'
import { RESCUE_COVERAGE_FAMILY_LABEL, RESCUE_COVERAGE_FAMILY_OF_INDEX, RESCUE_ETF_CATALOG } from '../shared/model.ts'

export type ExposureRow = PrismExposureRow
export type ExposureView = PrismExposure

const round2 = (n: number): number => Math.round(n * 100) / 100
const wideFamily = new Map<string, '大盘' | '中小盘' | '成长'>()
for (const x of RESCUE_ETF_CATALOG) {
  const key = RESCUE_COVERAGE_FAMILY_OF_INDEX[x.index]
  if (key !== undefined) wideFamily.set(x.secid, RESCUE_COVERAGE_FAMILY_LABEL[key] as '大盘' | '中小盘' | '成长')
}
const wide = new Set(wideFamily.keys())

export function industryExposureOf(
  account: { cash: number; positions: ReadonlyArray<{ secid: string; name: string; qty: number; cost: number }> },
  prices: Readonly<Record<string, number | null>>,
  industries: Readonly<Record<string, { name: string } | null>>,
  limits: Readonly<Record<string, number>> = {},
): ExposureView {
  const totalPos = account.positions.reduce((sum, p) => sum + p.qty * (prices[p.secid] ?? p.cost), 0)
  const total = account.cash + totalPos
  if (!(total > 0)) return { rows: [], classifiedPct: 0, unclassifiedPct: 0, unpenetratedPct: 0, cashPct: 0, total: 0 }
  const byName = new Map<string, { value: number; kind: Exclude<ExposureRow['kind'], 'cash'>; families: Set<'大盘' | '中小盘' | '成长'> }>()
  for (const p of account.positions) {
    const value = p.qty * (prices[p.secid] ?? p.cost)
    const isWide = wide.has(p.secid)
    const name = isWide ? '宽基 ETF' : (industries[p.secid]?.name ?? '未穿透')
    const kind: ExposureRow['kind'] = isWide ? 'wide' : name === '未穿透' ? 'unpenetrated' : 'industry'
    const cur = byName.get(name) ?? { value: 0, kind, families: new Set<'大盘' | '中小盘' | '成长'>() }
    cur.value += value
    if (isWide) cur.families.add(wideFamily.get(p.secid) as '大盘' | '中小盘' | '成长')
    byName.set(name, cur)
  }
  const rows: ExposureRow[] = [...byName.entries()].map(([name, v]) => {
    const weight = round2((v.value / total) * 100)
    const limitPct = v.kind === 'industry' ? (limits[name] ?? null) : v.kind === 'wide' ? (limits['宽基 ETF'] ?? null) : null
    const status: ExposureRow['status'] = v.kind === 'unpenetrated' ? '待穿透' : limitPct !== null && weight > limitPct ? '超限' : '正常'
    const family: ExposureRow['family'] = v.families.size === 0 ? null : v.families.size === 1 ? ([...v.families][0] as '大盘' | '中小盘' | '成长') : '混合'
    return { name, value: round2(v.value), weight, kind: v.kind, family, limitPct, status }
  }).sort((a, b) => b.value - a.value)
  const cashPct = round2(100 - rows.reduce((s, r) => s + r.weight, 0))
  rows.push({ name: '现金', value: round2(account.cash), weight: cashPct, kind: 'cash', limitPct: null, status: '可用' })
  const unpenetratedPct = round2(rows.filter((r) => r.kind === 'unpenetrated').reduce((s, r) => s + r.weight, 0))
  const classifiedPct = round2(rows.filter((r) => r.kind === 'industry' || r.kind === 'wide').reduce((s, r) => s + r.weight, 0))
  return {
    rows,
    classifiedPct,
    unclassifiedPct: round2(100 - classifiedPct),
    unpenetratedPct,
    cashPct,
    total: round2(total),
  }
}
