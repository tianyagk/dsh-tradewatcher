/**
 * 上游熔断器（进程级、按主机组共享）。
 *
 * 背景：东财行情主机（push2/push2delay/push2his）会随机掐断连接，且在请求量偏大时
 * 会升级为**持续不可达**（实测一天内失败率从 25% 一路爬到 100%，同时东财数据中心与
 * 腾讯/新浪仍正常 —— 属于针对本机 IP 的限流/封锁）。此时"重试 12 次"只会加重封锁，
 * 因此这里做进程级熔断：
 *   - 连续 N 次**调用**失败 → 打开熔断，冷却期内**不再发起任何请求**（由调用方走兜底数据）
 *   - 冷却时间指数增长（2 分钟 → 4 → 8 → 上限 15 分钟）
 *   - 冷却结束后放"半开"试探：**同一时刻只放行一个探针**（claimProbe），
 *     成功即完全恢复，失败则继续加倍冷却
 *
 * 失败记账按**实际失败的主机**：调用方须把本次调用中从未成功过的每台主机各自记一次，
 * 不能笼统记到主机列表最后一项（那会误熔健康主机）。
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
  /** 半开期是否已有探针在飞（避免冷却结束瞬间多请求同时试探） */
  private probing = false
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

  /** 是否允许发起请求（纯判定，无副作用：熔断冷却中返回 false，调用方应直接走兜底） */
  allow(): boolean {
    return Date.now() >= this.until
  }

  /** 是否处于半开期（曾熔断、冷却已到、等待探针验证） */
  get inHalfOpen(): boolean {
    return this.trips > 0 && Date.now() >= this.until
  }

  /**
   * 领取半开探针名额。非半开态恒为 true；半开期只放行一个调用，
   * 其余调用快速失败走兜底 —— 否则冷却一结束，所有并发请求会同时打向刚被封锁的主机。
   * 领取方必须在结束时调用 releaseProbe()（成功/失败记账也会释放）。
   */
  claimProbe(): boolean {
    if (!this.inHalfOpen) return true
    if (this.probing) return false
    this.probing = true
    return true
  }

  releaseProbe(): void {
    this.probing = false
  }

  recordSuccess(): void {
    this.fails = 0
    this.trips = 0
    this.until = 0
    this.lastError = null
    this.probing = false
  }

  recordFailure(error: unknown): void {
    this.probing = false
    this.lastError = error instanceof Error ? error.message : String(error)
    // 半开探针失败：说明主机仍未恢复，必须**立即重熔并延长冷却**。
    // 否则 fails 已被归零、未达阈值就直接返回，until 停在过去时 → allow() 变 true，
    // 主机立刻重新可探（真实节奏下每 2.5s 一次），正是熔断要避免的"重试加重封锁"。
    const wasHalfOpen = this.trips > 0 && Date.now() >= this.until
    this.fails += 1
    if (!wasHalfOpen && this.fails < this.threshold) return
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

/**
 * 按主机维护熔断器。
 *
 * 教训：最初所有东财请求共用**一个**熔断器，结果行情主机（push2 系列）被限流时，
 * 搜索（searchapi.eastmoney.com）被一起拦下 —— 而它当时完全正常，
 * 表现为"自选/持仓搜不出任何标的"。限流是按主机/接口的，熔断也必须按主机隔离。
 */
const breakers = new Map<string, CircuitBreaker>()

export function breakerFor(host: string): CircuitBreaker {
  let b = breakers.get(host)
  if (b === undefined) {
    b = new CircuitBreaker({ threshold: 3, baseMs: 120_000, maxMs: 900_000 })
    breakers.set(host, b)
  }
  return b
}

/** 某组主机整体是否可用（全部处于熔断冷却时才判定为不可用） */
export function hostsAllowed(hosts: readonly string[]): string[] {
  return hosts.filter((h) => breakerFor(h).allow())
}

/**
 * 该组主机中**最早**的恢复时间（分钟），供 UI 提示。
 *
 * 取最小值而非最大值：冷却中的主机各自独立，最早恢复的那台一到点就允许重新请求
 * （半开探针），此时上游已经"可试"了。此前取 `Math.max` 会把提示写成"最晚那台的
 * 剩余时间"——例如 push2delay 还剩 14 分钟、push2 还剩 1 分钟，界面却显示
 * "约 14 分钟后自动重试"，与实际可以重试的时刻差了十几分钟。
 */
export function minutesToRecover(hosts: readonly string[]): number {
  const open = hosts.map((h) => breakerFor(h)).filter((b) => !b.allow())
  if (open.length === 0) return 0
  return Math.min(...open.map((b) => b.minutesLeft()))
}

/** 该组主机中**最晚**的恢复时间（分钟）：全部恢复才代表整组彻底可用 */
export function minutesToFullyRecover(hosts: readonly string[]): number {
  const open = hosts.map((h) => breakerFor(h)).filter((b) => !b.allow())
  if (open.length === 0) return 0
  return Math.max(...open.map((b) => b.minutesLeft()))
}

export interface BreakerHostStatus {
  host: string
  open: boolean
  until: number
  trips: number
  fails: number
  minutesLeft: number
  lastError: string | null
}

export interface BreakerSummary {
  /** 任一主机熔断中 */
  open: boolean
  /** 全部主机都熔断中（此时才会真正快速失败，无可用上游） */
  allOpen: boolean
  /** 熔断中的主机数 */
  openHosts: number
  /** 参与统计的主机数 */
  hosts: number
  /** 最早恢复（分钟）：到点即可重新尝试 */
  minutesLeft: number
  /** 全部恢复（分钟） */
  allMinutesLeft: number
  /** 最近一次失败原因（取最新熔断的那台） */
  lastError: string | null
  /** 逐主机明细（UI 展开用） */
  detail: BreakerHostStatus[]
}

/**
 * 熔断状态聚合。
 *
 * 此前界面只展示单台 push2delay 的熔断状态：push2his/push2 同时被限流时，
 * 横幅却可能显示"正常"，用户看到的是"数据缺但不报警"；反过来 push2delay 单独熔断时
 * 又会让界面以为**整组**不可用。真实语义是"按主机各自独立"，因此聚合时把逐主机明细
 * 一起给出，并区分「最早可重试」与「全部恢复」。
 */
export function breakerSummary(hosts: readonly string[]): BreakerSummary {
  const detail: BreakerHostStatus[] = []
  let openHosts = 0
  let lastError: string | null = null
  let latestTrip = -1
  // 去重：调用方常把"行情主机 + 历史主机"拼在一起，两组本身有重叠
  // （push2delay/push2 同时服务两条链路），不去重会把同一台主机报成两台
  const unique = [...new Set(hosts)]
  for (const host of unique) {
    const b = breakerFor(host)
    const state = b.state
    const open = !b.allow()
    if (open) openHosts += 1
    // 最近熔断的那台最能代表当前故障原因
    if (state.lastError !== null && state.until > latestTrip) {
      latestTrip = state.until
      lastError = state.lastError
    }
    detail.push({
      host,
      open,
      until: state.until,
      trips: state.trips,
      fails: state.fails,
      minutesLeft: b.minutesLeft(),
      lastError: state.lastError,
    })
  }
  return {
    open: openHosts > 0,
    allOpen: unique.length > 0 && openHosts === unique.length,
    openHosts,
    hosts: unique.length,
    minutesLeft: minutesToRecover(unique),
    allMinutesLeft: minutesToFullyRecover(unique),
    lastError,
    detail,
  }
}

// 注：曾导出过 `quoteBreaker`（单台 push2delay 的熔断器别名），行情中继与护盘采样器都拿它
// 当"行情整体闸门"用 —— 这正是"按主机隔离"要避免的语义，两处都已改为按主机/整组判定，
// 该别名随之删除（保留别名只会让同一个 bug 再长回来）。搜索/数据中心各自独立熔断。
