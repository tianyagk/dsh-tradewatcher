/**
 * ETF 分单资金流兜底（新浪 `MoneyFlow.ssi_ssfx_flzjtj`）——东财 `f66`（超大单净额）不可达时用。
 *
 * 字段（实测 `daima=sh510300`）：
 *   `r0_in` / `r0_out` = 超大单买入/卖出金额（**元**）⇒ 超大单净额 = `r0_in − r0_out`；
 *   `r1/r2/r3` 是大/中/小单；`netamount` 是**全部单**净额（不是超大单，别混用）。
 *
 * 只做一件事：给出「超大单净额（元）」与「占成交额」，都缺则 null，**绝不用 0 顶替**。
 */
import { fetchTextHost } from './hostFetch.ts'

const SINA_HOST = 'vip.stock.finance.sina.com.cn'
const TTL_MS = 60_000

/** secid（`1.510300`）→ 新浪代码（`sh510300`）；非沪深 ⇒ null */
export function sinaSymbolOf(secid: string): string | null {
  const m = /^([01])\.(\d{6})$/.exec(secid)
  if (m === null) return null
  return `${m[1] === '1' ? 'sh' : 'sz'}${m[2]}`
}

/** 解析超大单净额（元）：`r0_in − r0_out`；两个字段缺一 ⇒ null */
export function parseSinaSuperNet(text: string): number | null {
  const inM = /"r0_in":"([0-9.]+)"/.exec(text)
  const outM = /"r0_out":"([0-9.]+)"/.exec(text)
  if (inM === null || outM === null) return null
  const a = Number(inM[1])
  const b = Number(outM[1])
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return a - b
}

const cache = new Map<string, { at: number; net: number | null }>()

/** 拉超大单净额（元）；60s 缓存；失败缓存 null（不抛） */
export async function fetchSinaSuperNet(secid: string, now: number = Date.now()): Promise<number | null> {
  const sym = sinaSymbolOf(secid)
  if (sym === null) return null
  const hit = cache.get(secid)
  if (hit !== undefined && now - hit.at < TTL_MS) return hit.net
  try {
    const text = await fetchTextHost(
      SINA_HOST,
      `https://${SINA_HOST}/quotes_service/api/json_v2.php/MoneyFlow.ssi_ssfx_flzjtj?daima=${encodeURIComponent(sym)}`,
      { referer: 'https://finance.sina.com.cn/' },
    )
    const net = parseSinaSuperNet(text)
    cache.set(secid, { at: now, net })
    return net
  } catch {
    cache.set(secid, { at: now, net: null })
    return null
  }
}

/** 占成交额 = 超大单净额 ÷ 当日成交额；两者都有且成交额 >0 才算 */
export function superShareOf(net: number | null, amount: number | null): number | null {
  if (net === null || amount === null || !(amount > 0)) return null
  return net / amount
}
