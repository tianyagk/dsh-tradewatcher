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
