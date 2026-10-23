/**
 * 单主机请求的**统一熔断出口**（H1，docs/REVIEW-2-CORRECTNESS.md）。
 *
 * 背景：`em.ts` 的 `fetchAny`（东财多主机）早就接进了熔断器，但**四个文件里的 14 处裸 `fetch(`**
 * （新浪/腾讯/日历/护盘原语）既不 `allow()` 也不 `recordFailure()` ⇒
 *   - 单台挂起时每次都付满超时（实测：腾讯 K 线首选源挂起 ⇒ 每次 `/kline` 9 秒，且第二次仍是 9 秒）；
 *   - `breakerSummary()`（routes 的降级横幅）看不见它们 ⇒ 降级**不可观测**。
 *
 * 用法：把**一次主机请求**（含它的解析）包进来：
 * ```ts
 * const res = await withHostBreaker('qt.gtimg.cn', () => fetch(url, init))
 * ```
 * 语义：
 *   - 冷却中/半开已有探针 ⇒ 抛 `UpstreamCoolingError`（**不发请求**，调用方据此走兜底或如实报"冷却中"）；
 *   - 成功 ⇒ `recordSuccess()`；抛错 ⇒ `recordFailure()`（阈值/退避由 breaker.ts 管）；
 *   - `finally` 必 `releaseProbe()`（半开探针不会泄漏）。
 */
import { breakerFor } from './breaker.ts'
import { noteHostFailure, noteHostProbe, noteHostSkipped, noteHostSuccess } from './degrade.ts'

/** 主机正在熔断冷却/半开探测中（这一轮**没有**发出上游请求） */
export class UpstreamCoolingError extends Error {
  readonly host: string
  readonly reason: string

  constructor(host: string, reason = '熔断冷却中') {
    super(`${host} ${reason}：本轮未发出上游请求（稍后自动重试）`)
    this.name = 'UpstreamCoolingError'
    this.host = host
    this.reason = reason
  }
}

/** 把一次主机请求（含解析）纳入 per-host 熔断记账 */
export async function withHostBreaker<T>(host: string, run: () => Promise<T>): Promise<T> {
  const breaker = breakerFor(host)
  if (!breaker.allow()) {
    // 「本轮没发请求」与「请求失败」是两件事：健康簿分开记（见 degrade.noteHostSkipped）
    noteHostSkipped(host, '熔断冷却中')
    throw new UpstreamCoolingError(host, '熔断冷却中')
  }
  if (!breaker.claimProbe()) {
    noteHostSkipped(host, '半开探测中（已有探针在跑）')
    throw new UpstreamCoolingError(host, '半开探测中（已有探针在跑）')
  }
  // ② 熔断周期里必须留痕的三条状态转换之一（探测）；重复探测由签名抑制折叠
  if (breaker.inHalfOpen) noteHostProbe(host)
  try {
    const out = await run()
    /**
     * ⚠ HTTP 非 2xx 也算失败：多数调用方是在**包装之外**写 `if (!res.ok) throw`，
     * 若这里只看"没抛异常"就 `recordSuccess()`，那 5xx/503 永远不进账（实测：包了熔断器
     * 但 `fails` 仍是 0 —— 等于没包）。这里按响应状态记账，调用方随后照旧抛错。
     */
    const res = out as { ok?: unknown; status?: unknown } | null
    if (res !== null && typeof res === 'object' && typeof res.ok === 'boolean' && res.ok === false) {
      const failure = new Error(`HTTP ${String(res.status ?? '?')} from ${host}`)
      breaker.recordFailure(failure)
      noteHostFailure(host, failure)
      throw failure
    }
    breaker.recordSuccess()
    noteHostSuccess(host)
    return out
  } catch (error) {
    // 已在上面记过账的 HTTP 失败不要重复计数（recordFailure 会累加 fails/trips）
    if (!(error instanceof Error) || !/^HTTP \d+ from /.test(error.message)) {
      breaker.recordFailure(error)
      noteHostFailure(host, error)
    }
    throw error
  } finally {
    breaker.releaseProbe()
  }
}

/** 首选的 host 列表里挑一个"愿意接活"的主机（供"同主机多域名"的调用方用） */
export function isCooling(host: string): boolean {
  return !breakerFor(host).allow()
}
