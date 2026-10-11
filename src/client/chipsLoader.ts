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

/** 测试/换标的时清空（模块级缓存，进程内单例） */
export function resetChipsCache(): void {
  cache.clear()
}

export function invalidateChips(secid?: string): void {
  if (secid === undefined) cache.clear()
  else cache.delete(secid)
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
      return value
    })
    .catch((e: unknown) => {
      entry.inflight = null
      cache.set(secid, entry)
      throw e
    })
  entry.inflight = p
  cache.set(secid, entry)
  return p as Promise<T>
}
