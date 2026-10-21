/**
 * 【竞价】一行的展示文本（详情抽屉头部）。
 *
 * 格式固定（用户裁决）：`1331.88 · 516.00 手 · 1.54% · +0.83%`
 *   · 价格 2 位小数、量 2 位小数（手）、量比 2 位小数（%）、溢价带符号 2 位小数（%）；
 *   · 不写口径、不写解释、不进悬停；未开盘只给 `—`，不可用给 `—（原因）`。
 */
import type { AuctionInfo } from '../shared/model.ts'
import { fmtSigned } from './format.ts'

export function auctionText(a: AuctionInfo | null | undefined): string {
  if (a === null || a === undefined) return '—'
  if (a.state !== 'ok' || a.price === null || a.volLots === null || a.volSharePct === null || a.premiumPct === null) {
    const reason = a.state === 'unavailable' && a.reason !== null && a.reason !== '' ? `（${a.reason}）` : ''
    return `—${reason}`
  }
  return `${a.price.toFixed(2)} · ${a.volLots.toFixed(2)} 手 · ${a.volSharePct.toFixed(2)}% · ${fmtSigned(a.premiumPct)}%`
}
