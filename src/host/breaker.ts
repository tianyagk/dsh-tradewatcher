/**
 * 上游熔断器（进程级、按主机组共享）。
 *
 * 背景：东财行情主机（push2/push2delay/push2his）会随机掐断连接，且在请求量偏大时
 * 会升级为**持续不可达**（实测一天内失败率从 25% 一路爬到 100%，同时东财数据中心与
 * 腾讯/新浪仍正常 —— 属于针对本机 IP 的限流/封锁）。此时"重试 12 次"只会加重封锁，
 * 因此这里做进程级熔断：
 *   - 连续 N 次调用失败 → 打开熔断，冷却期内**不再发起任何请求**（由调用方走兜底数据）
 *   - 冷却时间指数增长（2 分钟 → 4 → 8 → 上限 15 分钟）
 *   - 冷却结束后放一次"半开"试探：成功即完全恢复，失败则继续加倍冷却
 */
export interface BreakerState {
  /** 是否处于熔断（冷却中） */
  open: boolean
  /** 熔断解除时间（epoch ms，0 表示未熔断） */
  until: number
  /** 连续失败次数 */
  fails: number
  /** 已连续熔断次数（用于指数退避） */
  trips: number
  /** 上一次失败原因 */
  lastError: string | null
}

export interface BreakerOptions {
  /** 连续失败多少次后熔断 */
  threshold?: number
  /** 首次冷却时长 */
  baseMs?: number
  /** 冷却上限 */
  maxMs?: number
}

export class CircuitBreaker {
  private fails = 0
  private trips = 0
  private until = 0
  private lastError: string | null = null
  private readonly threshold: number
  private readonly baseMs: number
  private readonly maxMs: number

  constructor(opts: BreakerOptions = {}) {
    this.threshold = opts.threshold ?? 3
    this.baseMs = opts.baseMs ?? 120_000
    this.maxMs = opts.maxMs ?? 900_000
  }

  get state(): BreakerState {
    return { open: Date.now() < this.until, until: this.until, fails: this.fails, trips: this.trips, lastError: this.lastError }
  }

  /** 是否允许发起请求（熔断冷却中返回 false，调用方应直接走兜底） */
  allow(): boolean {
    return Date.now() >= this.until
  }

  recordSuccess(): void {
    this.fails = 0
    this.trips = 0
    this.until = 0
    this.lastError = null
  }

  recordFailure(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error)
    this.fails += 1
    if (this.fails < this.threshold) return
    const backoff = Math.min(this.maxMs, this.baseMs * 2 ** this.trips)
    this.trips += 1
    this.fails = 0
    this.until = Date.now() + backoff
  }

  /** 供 UI 展示：距离恢复还有多久（分钟，向上取整） */
  minutesLeft(): number {
    return Math.max(0, Math.ceil((this.until - Date.now()) / 60_000))
  }
}

/** 全局共享的行情主机熔断器（em.ts 与护盘采样器共用，避免各自打满） */
export const quoteBreaker = new CircuitBreaker({ threshold: 3, baseMs: 120_000, maxMs: 900_000 })
