/**
 * 详情头的**纯展示逻辑**（不 import react ⇒ 可在 node 里断言）。
 *
 * 只解决一件事：「所属板块」在**东财不可达、用腾讯兜底**时怎么显示。
 * 腾讯单票行情不含行业归属 ⇒ 只能 `—` + 一句原因（**不许空字符串、更不许 0**）。
 */

export type DetailSource = 'eastmoney' | 'tencent'

export interface IndustryCell {
  /** 展示值：有板块 ⇒ `名称 [涨跌%]`；没有 ⇒ `—`（不是 ''，也不是 0） */
  value: string
  /** 悬停说明（缺的时候必须写清"为什么缺"） */
  title: string
  /** 板块涨跌幅（有才用于上色） */
  pct: number | null
}

export function industryCellOf(
  board: { name: string; pct: number | null } | null,
  source: DetailSource | null,
  fmtPct: (v: number) => string,
): IndustryCell {
  if (board !== null) {
    return {
      value: board.pct === null ? board.name : `${board.name}  ${fmtPct(board.pct)}`,
      title: '行业板块及当日涨跌幅',
      pct: board.pct,
    }
  }
  return {
    value: '—',
    title: source === 'tencent' ? '东财不可达，行业归属暂缺' : '仅 A股 提供行业板块',
    pct: null,
  }
}

/* ───────────────────────── 成交量显示（v0.181.0） ───────────────────────── */

/** 股 → 「亿股 / 万股 / 股」（阈值与标签必须自洽：≥1e8 才允许写"亿股"） */
export function volLabelOfShares(shares: number): string {
  if (shares >= 1e8) return `${(shares / 1e8).toFixed(2)} 亿股`
  if (shares >= 1e4) return `${(shares / 1e4).toFixed(1)} 万股`
  return `${Math.round(shares)} 股`
}

export interface VolumeCell {
  value: string
  title: string
}

/**
 * 详情头「成交量」：显示值 + 单位自洽；`成交量 × 均价` 与成交额差 >5% ⇒ `—` + 「量纲不一致」。
 * 不传 fmtBig（保持纯函数）：股数直接按亿/万格式化。
 */
export function volumeCellOf(volShares: number | null, amount: number | null, price: number | null): VolumeCell {
  if (volShares === null || !(volShares > 0)) return { value: '—', title: '成交量未取到' }
  if (amount !== null && price !== null && amount > 0 && price > 0) {
    const err = Math.abs(volShares * price - amount) / amount * 100
    if (err > 5) {
      return { value: '—', title: `量纲不一致：成交量×均价 与成交额相差 ${err.toFixed(1)}%（不显示错值）` }
    }
  }
  return { value: volLabelOfShares(volShares), title: '成交量（股；按成交额与均价校验过）' }
}
