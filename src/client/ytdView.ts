/**
 * 客户端侧 YTD 展示逻辑（纯函数，无 React 依赖，便于直接测）。
 *
 * 口径文案**只有一处**（`shared/model.ts` 的 `YTD_CALIBER`）：界面 tooltip 与 agent 工具
 * 引用的是同一句 —— 两处各写一套迟早会对不上。
 *
 * 两条硬约定：
 *  - 取不到就显示 `—` + 原因（**不用 0 顶替**：0 会被读成"没涨没跌"）；
 *  - 指数/期货按原始价格算，tooltip 必须说明"该标的不适用复权"（否则会被当成"前复权出问题了"）。
 */
import { FQ_LABEL, YTD_CALIBER, type YtdRow } from '../shared/model.ts'
import { fmtPct } from './format.ts'

/** 显示文本：不可算时 `—` */
export function ytdText(row: YtdRow | undefined): string {
  if (row === undefined || row.ytd === null) return '—'
  return fmtPct(row.ytd)
}

/** 悬浮提示：口径 + 基准 + 实际生效的复权口径；不可算时给原因 */
export function ytdTooltip(name: string, row: YtdRow | undefined, loaded: boolean): string {
  const head = `${name} 标的的年初至今（YTD）\n口径：${YTD_CALIBER}`
  if (row === undefined) {
    return `${head}\n本轮没有该标的的结果：${loaded ? '路由未返回它' : '尚未取到，下一轮行情刷新后自动重试'}`
  }
  if (row.ytd === null || row.baseClose === null) {
    return `${head}\n本轮不可算：${row.why ?? '原因未给出（视为缺失，不显示 0）'}`
  }
  const parts: string[] = []
  const listing = row.baseKind === 'listing'
  parts.push(`基准 ${row.baseDate} 收盘 ${row.baseClose.toFixed(3)}${listing ? '（该标的本年内上市：基准是「上市首日」，因此这个数读作"上市首日至今"，不是"年初至今" —— 按年初读会高估）' : '（本年内第一个交易日）'}`)
  parts.push(`现价 ${row.price === null ? '—' : row.price.toFixed(3)}`)
  parts.push(row.fqSupported
    ? `复权口径：${FQ_LABEL[row.fq]}（复权口径由宿主回包决定，不是界面请求值）`
    : '该标的不适用复权（指数是点位、期货是合约价，没有除权除息），按原始价格计算')
  return `${head}\n${parts.join('\n')}`
}

/** 页面级的缺失摘要：只说"有几项没算出来 + 第一条原因"，避免把每条都刷一遍 */
export function ytdMissingSummary(rows: readonly YtdRow[]): string | null {
  const missing = rows.filter((r) => r.ytd === null)
  if (missing.length === 0) return null
  return `${missing.length} 项本次算不出 YTD（显示 —，不用 0 顶替）：${missing[0].why ?? '原因未给出'}`
}
