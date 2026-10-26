/**
 * 统一报价轮询（用户 2026-10-26）：全仓**只有一个**行情定时器。
 *
 * · 时段闸门 `shouldPollQuotes`（午休/盘后/非交易日不请求）；
 * · `dedupeSecids` + `pollableSecids`（熔断 open 时跳过纯东财）；
 * · `/health` 的 `breaker.open` **每 60 秒最多读一次**（`breakerOpenCached`）。
 */
import { api } from './api.ts'
import { QUOTE_POLL_MS, dedupeSecids, pollableSecids, shouldPollQuotes } from '../shared/pollGate.ts'

let cache: { at: number; open: boolean } | null = null

/** 熔断是否全开（60s 内复用；读失败按"未知"= 不跳过，避免误伤） */
export async function breakerOpenCached(now = Date.now(), ttlMs = 60_000): Promise<boolean> {
  if (cache !== null && now - cache.at < ttlMs) return cache.open
  try {
    const h = await api.health()
    const open = h.breaker?.open === true
    cache = { at: now, open }
    return open
  } catch {
    cache = { at: now, open: false }
    return false
  }
}

/** 仅供测试：清掉熔断缓存 */
export function __resetBreakerCache(): void {
  cache = null
}

export interface PollPlan {
  /** 本轮真正要请求的 secid */
  ids: string[]
  /** 为什么这一轮不请求（null = 要请求） */
  skipReason: string | null
}

/**
 * 一轮报价的"该请求谁"：时段 → 去重 → 熔断过滤。
 * `hasFallback` 由调用方注入（`hasQuoteFallback` 是宿主能力表，客户端用同表的映射判定）。
 */
export async function planQuotePoll(
  secids: readonly string[],
  hasFallback: (secid: string) => boolean,
  now = Date.now(),
): Promise<PollPlan> {
  if (!shouldPollQuotes(now)) return { ids: [], skipReason: '非连续竞价时段（午休/盘后/非交易日）' }
  const deduped = dedupeSecids(secids)
  const open = await breakerOpenCached(now)
  const ids = pollableSecids(deduped, { open }, hasFallback)
  return { ids, skipReason: ids.length === 0 ? '本轮无可轮询标的（熔断或空集合）' : null }
}

export { QUOTE_POLL_MS }
