/**
 * 筹码取数的**按 secid 缓存 + 同请求合并**（切成独立模块是为了能断言"切页签不刷新"）。
 *
 * 三条纪律：
 *  ① **筹码只随 `secid` 变**：页签/复权/图表重试计数都不是它的输入（用户点名的问题就是切页签会重取）；
 *  ② 同一 secid 的并发请求合并成一次（避免抽屉重挂载时打两次）；
 *  ③ 缓存有 TTL（默认 60s）⇒ 需要新鲜数据时由调用方 `invalidate` 后重取。
 */
export interface ChipsLoadDeps {
  /** 真正的取数（注入便于断言计数） */
  fetch: (secid: string) => Promise<unknown>
  now?: () => number
  ttlMs?: number
}

interface Entry {
  at: number
  inflight: Promise<unknown> | null
  value: unknown | null
}

const cache = new Map<string, Entry>()

/**
 * 缓存条目上限（AUDIT-CLIENT-PERF P2-7）。
 *
 * 旧实现无上限、无淘汰：看过 N 只标的就常驻 N × 84 KB（`api.ts:7` 注明单包 84 KB），
 * 50 只 ≈ 4 MB，SPA 会话内不释放。24 条 ≈ 2 MB 封顶，按最后成功时刻淘汰最旧的**已完成**条目
 * （在途请求不淘汰：删了会让同一 secid 的并发调用合并失效）。
 */
export const CHIPS_CACHE_MAX = 24

/** 超过上限时按 `at` 淘汰最旧的已完成条目（在途条目保留） */
function evictOverflow(): void {
  if (cache.size <= CHIPS_CACHE_MAX) return
  const done = [...cache.entries()]
    .filter(([, e]) => e.inflight === null)
    .sort((a, b) => a[1].at - b[1].at)
  for (const [key] of done) {
    if (cache.size <= CHIPS_CACHE_MAX) break
    cache.delete(key)
  }
}

/** 测试/排障用：当前缓存规模 */
export function chipsCacheStats(): { size: number; max: number } {
  return { size: cache.size, max: CHIPS_CACHE_MAX }
}

/** 测试/换标的时清空（模块级缓存，进程内单例） */
export function resetChipsCache(): void {
  cache.clear()
}

/**
 * 取筹码：命中缓存（TTL 内）直接返回；同一 secid 的并发调用合并；否则发一次请求。
 * **入参只有 secid** —— 这条本身就是"切页签不刷新"的结构保证。
 */
export async function loadChips<T = unknown>(secid: string, deps: ChipsLoadDeps): Promise<T> {
  const now = deps.now ?? Date.now
  const ttl = deps.ttlMs ?? 60_000
  const hit = cache.get(secid)
  if (hit !== undefined) {
    if (hit.inflight !== null) return hit.inflight as Promise<T>
    if (now() - hit.at < ttl) return hit.value as T
  }
  const entry: Entry = hit ?? { at: 0, inflight: null, value: null }
  const p = deps
    .fetch(secid)
    .then((value) => {
      entry.inflight = null
      entry.at = now()
      entry.value = value
      cache.set(secid, entry)
      evictOverflow()
      return value
    })
    .catch((e: unknown) => {
      entry.inflight = null
      cache.set(secid, entry)
      evictOverflow()
      throw e
    })
  entry.inflight = p
  cache.set(secid, entry)
  evictOverflow()
  return p as Promise<T>
}
