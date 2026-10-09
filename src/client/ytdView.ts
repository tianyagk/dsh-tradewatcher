/**
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
export function ytdTooltip(
  name: string,
  row: YtdRow | undefined,
  loaded: boolean,
  /** 回包的降级信息（来源 / 是否旧基准）；不给就不写这一行 */
  prov?: { stale?: boolean; source?: string },
): string {
  const head = `${name} 标的的年初至今（YTD）\n口径：${YTD_CALIBER}${
    prov === undefined
      ? ''
      : `\n来源：${prov.source ?? 'em'}${prov.stale === true ? '（本次是上次成功的结果，基准按日缓存 + 失败冷却期间不会重取）' : ''}`
  }`
  if (row === undefined) {
    return `${head}\n本轮没有该标的的结果：${loaded ? '路由未取到它' : '尚未取到，下一轮行情刷新后自动重试'}`
  }
  if (row.ytd === null || row.baseClose === null) {
    return `${head}\n本轮不可算：${row.why ?? '原因未给出（视为缺失，不显示 0）'}`
  }
  const parts: string[] = []
  const listing = row.baseKind === 'listing'
  parts.push(`基准 ${row.baseDate} 收盘 ${row.baseClose.toFixed(3)}${listing ? '（本年内上市，基准为上市首日）' : '（本年内第一个交易日）'}`)
  parts.push(`现价 ${row.price === null ? '—' : row.price.toFixed(3)}`)
  parts.push(row.fqSupported
    ? `复权口径：${FQ_LABEL[row.fq]}（复权口径由宿主回包决定，不是界面请求值）`
    : '该标的不适用复权（指数是点位、期货是合约价，没有除权除息），按原始价格计算')
  return `${head}\n${parts.join('\n')}`
}

/**
 * 页面级的缺失摘要：一行 —— 数量 + 第一条原因。
 *
 * 不在正文里重复两件事：① "YTD"（渲染处的前缀已写）；② "显示 —、不用 0 顶替"（这是全页统一的缺失约定，
 * 每轮刷新都印一遍只会把面板挤满，它属于 tooltip）。正文只回答"影响几条、为什么"。
 */
export function ytdMissingSummary(rows: readonly YtdRow[]): string | null {
  const missing = rows.filter((r) => r.ytd === null)
  if (missing.length === 0) return null
  return `${missing.length} 项缺数据：${missing[0].why ?? '原因未给出'}`
}
