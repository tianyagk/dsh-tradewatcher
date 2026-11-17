/**
 * 【涨跌分布】模块的纯视图逻辑（不 import react ⇒ 能在 node 里直接断言）。
 *
 * 参考版（Arkvol）结构：左列三段紧凑内联行（涨跌趋势 / 成交量 / 两融走势）+ 右列两块
 * （柱状直方图带纵轴与网格线 / 双序列日内折线）。这里只放"能算的那部分"：
 * 直方图的纵轴刻度与网格线位置（写在纯函数里，便于把"必须有纵轴"断言死）。
 */

import type { AmountForecastWire, MarginCrossWire, MarginReadingWire } from './api.ts'

/** 亿元 → 显示串（保留 2 位截断，不四舍五入成假精度） */
export function fmtYi(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—'
  return `${v.toFixed(2)} 亿`
}

export function forecastCellOf(f: AmountForecastWire, amountText: string): { value: string; cls: string; note: string } {
  const cal = `口径：${f.caliber.curve}；样本 ${f.caliber.samples} 天；标定生成于 ${f.caliber.generatedAt}。${f.caliber.note}`
  const band = f.band === null || !Number.isFinite(f.band.low) || !Number.isFinite(f.band.high) ? '' : `；区间 ${(f.band.low / 1e8).toFixed(0)}~${(f.band.high / 1e8).toFixed(0)} 亿`
  const progress = f.progress === null || !Number.isFinite(f.progress) ? '' : `；已过时段占比 ${(f.progress * 100).toFixed(1)}%`
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
  const mismatch = m.mismatch ? `两源不一致（融资余额相对差 ${Number.isFinite(m.diffPct) ? `${((m.diffPct as number) * 100).toFixed(1)}%` : '未知'}）：深交所是深市口径、东财是沪深汇总，差异属口径 + 更新时点 ⇒ 两个读数都列出，不取其一` : m.note
  const days = [m.szse?.day, m.em?.day].filter((d): d is string => typeof d === 'string')
  return {
    value: m.mismatch ? `${head} 两源不一致` : head,
    note: `${mismatch}${days.length === 0 ? '' : `；数据日 ${[...new Set(days)].join(' / ')}`}`,
  }
}
