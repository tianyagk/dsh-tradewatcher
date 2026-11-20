/**
 * 棱镜的**周期驱动**调度（v0.209.0 起；旧版是按 `settings.times` 的固定时点）。
 *
 * 运行时用 30 秒节拍（`unref`，`NODE_TEST_CONTEXT` 下不启动 —— 与 `AuctionSampler` 同款），
 * 每拍只判一件事：**现在该不该自动跑一轮决策**。
 *
 * 口径（唯一事实源是 `intervalDue`）：
 *   · 只在 A 股交易时段内触发：**09:30–11:30** 与 **13:00–15:00**（左闭右开）；
 *     午休（11:30–13:00）、开盘前、收盘后、非交易日**一律不触发**；
 *   · 交易日判定**复用 `tradingDayState()`**（周末 → 外部日历 → 内置假日表，一处实现），
 *     本文件不另写星期/假日判断；
 *   · 时段内且 `now − lastAutoAt ≥ intervalSec × 1000` ⇒ 触发一轮；
 *   · **每个时段开盘后的第一次立即触发**（09:30 / 13:00 各一次）：上次自动决策早于本时段开盘，
 *     就视为本时段还没跑过，第一拍直接跑（这就是午休跨过后的「最多补一次」——补的是午盘的
 *     开盘首轮，不按午休累计时长连发）；
 *   · `lastAutoAt` 是**上次自动决策的触发时刻**（毫秒）：跑完写盘（`PrismStore.markAutoFired`），
 *     进程重启后不会立刻重复触发（除非已超周期）。
 *
 * ⚠ **`settings.times` 不再参与自动调度**：本文件不读 `times`。该字段只保留给手动
 * 「重放今日」/ `{action:'run', slot}`（见 `prismRoutes.ts`）；两套触发不得同时跑。
 */
import { dayOf, hhmmOf, shanghaiDayStart } from './time.ts'
import { tradingDayState } from './rescue.ts'
import { PRISM_DEFAULT_INTERVAL_SEC, PRISM_INTERVAL_OPTIONS, type PrismSettings } from '../shared/prism.ts'
import type { PrismStore } from './prismStore.ts'

export const PRISM_TICK_MS = 30_000
/** 新闻增量节拍：15 分钟（只在交易日执行，与决策周期解耦） */
export const PRISM_NEWS_EVERY_MS = 15 * 60_000

/** A 股连续竞价时段（北京时间，左闭右开）：09:30–11:30 / 13:00–15:00 */
const AM_OPEN = '09:30'
const AM_CLOSE = '11:30'
const PM_OPEN = '13:00'
const PM_CLOSE = '15:00'
/** 找「下一个交易日开盘」的最长回看天数（足够跨过国庆/春节长假） */
const NEXT_OPEN_LOOKAHEAD_DAYS = 31

export type PrismSessionSegment = 'am' | 'pm'

export interface IntervalWindow {
  /** 是否交易日（**只由 `tradingDayState` 判定**） */
  trading: boolean
  /** 是否落在连续竞价时段内 */
  inWindow: boolean
  /** 当前时段：am / pm；不在时段内 ⇒ null */
  segment: PrismSessionSegment | null
}

/** 某日某时刻（北京时间）的 epoch ms；`day` 为 `YYYY-MM-DD` */
const atHhmm = (day: string, hhmm: string): number => Date.parse(`${day}T${hhmm}:00+08:00`)

/**
 * 纯函数：给定时刻属于哪个交易时段。
 *
 * 边界**左闭右开**：09:30 属于 am、11:30 不属于；13:00 属于 pm、15:00 不属于。
 * 非交易日（`tradingDayState().trading === false`）⇒ `inWindow=false, segment=null`。
 */
export function intervalWindowOf(ts: number): IntervalWindow {
  if (tradingDayState(ts).trading !== true) return { trading: false, inWindow: false, segment: null }
  const hhmm = hhmmOf(ts)
  if (hhmm >= AM_OPEN && hhmm < AM_CLOSE) return { trading: true, inWindow: true, segment: 'am' }
  if (hhmm >= PM_OPEN && hhmm < PM_CLOSE) return { trading: true, inWindow: true, segment: 'pm' }
  return { trading: true, inWindow: false, segment: null }
}

/** 当前时段的开盘时刻（epoch ms）；不在时段内 ⇒ null */
const segmentOpenOf = (ts: number, segment: PrismSessionSegment | null): number | null => {
  if (segment === null) return null
  return atHhmm(dayOf(ts), segment === 'am' ? AM_OPEN : PM_OPEN)
}

/**
 * 下一个交易日的 09:30（epoch ms）。
 *
 * 从「今天 00:00」起逐日探测，只认 `tradingDayState` 的结论（不猜节假日）；
 * 同时要求时刻晚于 `ts`（今天已过 09:30 ⇒ 今天不算）。31 天都找不到 ⇒ null（不编时间）。
 */
const nextSessionOpenOf = (ts: number): number | null => {
  let dayStart = shanghaiDayStart(ts)
  for (let i = 0; i <= NEXT_OPEN_LOOKAHEAD_DAYS; i += 1) {
    const open = atHhmm(dayOf(dayStart), AM_OPEN)
    if (open > ts && tradingDayState(open).trading === true) return open
    dayStart += 86_400_000
  }
  return null
}

/**
 * 纯函数：合法决策周期（秒）。只认 `PRISM_INTERVAL_OPTIONS`；缺失/非法 ⇒ 600。
 * 与 `PrismStore` / 客户端下拉同一口径（三处同源，别各写一份）。
 */
const intervalSecOf = (settings: PrismSettings): number => {
  const v = settings.intervalSec
  return typeof v === 'number' && (PRISM_INTERVAL_OPTIONS as readonly number[]).includes(v) ? v : PRISM_DEFAULT_INTERVAL_SEC
}

export interface IntervalDue {
  /**
   * 本拍是否该自动跑一轮。
   * `nextEligibleAt`：最早可能再次到期的时刻（`due=true` ⇒ 当前时刻；算不出 ⇒ null）。
   * `reason`：只解释「为什么不触发」（due=true ⇒ null）。
   */
  due: boolean
  nextEligibleAt: number | null
  reason: string | null
}

/**
 * 纯函数：本拍该不该跑自动决策。
 *
 * 规则顺序（先窗口、后周期）：
 *  ① 非交易日 ⇒ false（原因取 `tradingDayState` 的 label/reason），`nextEligibleAt` = 下个交易日 09:30；
 *  ② 交易日但不在时段内 ⇒ false：开盘前 → 今天 09:30；午休 → 今天 13:00；收盘后 → 下个交易日 09:30；
 *  ③ 时段内：上次自动决策**早于本时段开盘**（或从未跑过）⇒ **立即触发**（09:30 / 13:00 的首次）；
 *  ④ 时段内且已跑过 ⇒ `now − lastAutoAt ≥ 周期` 才触发，否则给「还差 N 秒」。
 *
 * ⚠ 不看 `settings.times`（那是手动重放用的字段）：改它不会改变本函数的任何输出。
 */
export function intervalDue(settings: PrismSettings, now: number, lastAutoAt?: number | null): IntervalDue {
  const win = intervalWindowOf(now)
  if (!win.trading) {
    const state = tradingDayState(now)
    const label = state.label ?? (state.reason === 'weekend' ? '周末' : '非交易日')
    return { due: false, nextEligibleAt: nextSessionOpenOf(now), reason: label }
  }
  const hhmm = hhmmOf(now)
  if (!win.inWindow) {
    if (hhmm < AM_OPEN) return { due: false, nextEligibleAt: atHhmm(dayOf(now), AM_OPEN), reason: `未到开盘（${AM_OPEN}）` }
    if (hhmm < PM_OPEN) return { due: false, nextEligibleAt: atHhmm(dayOf(now), PM_OPEN), reason: `午休（${AM_CLOSE}–${PM_OPEN}）` }
    return { due: false, nextEligibleAt: nextSessionOpenOf(now), reason: `已收盘（${PM_CLOSE}）` }
  }
  // 第三参数显式传 null 表示「从未自动跑过」；undefined 则回落到 settings.lastAutoAt
  const last = lastAutoAt === undefined ? (settings.lastAutoAt ?? null) : lastAutoAt
  const lastMs = typeof last === 'number' && Number.isFinite(last) && last > 0 ? last : null
  const open = segmentOpenOf(now, win.segment)
  if (lastMs === null || (open !== null && lastMs < open)) {
    // 本时段开盘后的第一次：立即触发（午休跨过后最多补这一次，不按累计时长连发）
    return { due: true, nextEligibleAt: now, reason: null }
  }
  const intervalMs = intervalSecOf(settings) * 1000
  const elapsed = now - lastMs
  if (elapsed >= intervalMs) return { due: true, nextEligibleAt: now, reason: null }
  const remainSec = Math.ceil((intervalMs - elapsed) / 1000)
  return {
    due: false,
    nextEligibleAt: lastMs + intervalMs,
    reason: `距上次自动决策 ${Math.floor(elapsed / 1000)}s，还差 ${remainSec}s 到 ${intervalMs / 1000}s 周期`,
  }
}

/** 纯函数：run 的 slot 标签 —— 当前 `HH:MM`（北京时间） */
export function intervalSlotOf(now: number): string {
  return hhmmOf(now)
}

export interface PrismTickPlan {
  /** 是否交易日（`tradingDayState`） */
  trading: boolean
  /** 是否落在 09:30–11:30 / 13:00–15:00 */
  inWindow: boolean
  /** 北京日期 `YYYY-MM-DD` */
  day: string
  /** 本拍是否真的触发了一轮自动决策 */
  due: boolean
  /** 本轮 run 的 slot 标签（`HH:MM`）；未触发 ⇒ null */
  slot: string | null
  nextEligibleAt: number | null
  reason: string | null
}

export interface PrismSchedulerOptions {
  tickMs?: number
  now?: () => number
  /** 触发一轮研判（由调用方注入，内部已做并发/失败隔离） */
  run: (slot: string) => Promise<unknown>
  /** 新闻增量（可选；测试不传 ⇒ 不联网） */
  news?: () => Promise<unknown>
  newsEveryMs?: number
  /** 30 秒撮合（可选；测试不传 ⇒ 不联网不跑引擎） */
  match?: () => Promise<unknown>
}

export class PrismScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  /** 自动决策在跑：挡住同一进程内的重复触发（跑完写盘后才放开） */
  private autoInFlight = false
  private inflight: Promise<void> | null = null
  private lastNewsAt = 0
  private readonly store: PrismStore
  private readonly opts: PrismSchedulerOptions

  constructor(store: PrismStore, opts: PrismSchedulerOptions) {
    this.store = store
    this.opts = opts
  }

  get isRunning(): boolean {
    return this.running
  }

  /** 等当前自动决策跑完（测试 / 停用前收口；没有在跑 ⇒ 立即返回） */
  async whenIdle(): Promise<void> {
    await (this.inflight ?? Promise.resolve())
  }

  start(): void {
    if (this.running) return
    if (process.env.NODE_TEST_CONTEXT !== undefined) return
    this.running = true
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined)
    }, this.opts.tickMs ?? PRISM_TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    this.running = false
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * 一拍：非交易日 / 不在时段 / 未到周期都直接返回；到点则**先占位**再触发，
   * 跑完（成功或失败）把 `lastAutoAt` 写盘 —— 失败也写，避免每个 30 秒节拍重试造成风暴。
   */
  async tick(): Promise<PrismTickPlan> {
    const now = (this.opts.now ?? Date.now)()
    const settings = this.store.settings()
    const win = intervalWindowOf(now)
    const plan = intervalDue(settings, now, settings.lastAutoAt ?? null)
    const out: PrismTickPlan = {
      trading: win.trading,
      inWindow: win.inWindow,
      day: dayOf(now),
      due: false,
      slot: null,
      nextEligibleAt: plan.nextEligibleAt,
      reason: plan.reason,
    }
    if (!win.trading) return out
    // 新闻增量：交易日 15 分钟一次（与决策周期解耦；失败留痕在 status，不重试）
    // 新闻/撮合都是「顺带」动作：**同步抛错也不许打断本拍**。
    // 事故形态：matchTick / incrementalNews 在行情源熔断时同步 throw ⇒ tick reject ⇒ 周期调度整拍失效（实测 09:54 之后不再触发）。
    if (this.opts.news !== undefined && now - this.lastNewsAt >= (this.opts.newsEveryMs ?? PRISM_NEWS_EVERY_MS)) {
      this.lastNewsAt = now
      try { void Promise.resolve(this.opts.news()).catch(() => undefined) } catch { /* 顺带动作失败不影响调度 */ }
    }
    if (this.opts.match !== undefined) {
      try { void Promise.resolve(this.opts.match()).catch(() => undefined) } catch { /* 同上 */ }
    }
    if (!plan.due) return out
    if (this.autoInFlight) {
      out.reason = '上一轮自动决策尚未跑完'
      return out
    }
    const slot = intervalSlotOf(now)
    this.autoInFlight = true
    const task = (async (): Promise<void> => {
      try {
        await this.opts.run(slot)
      } catch {
        /* 单轮失败不抛出（下一周期再跑），但水位照写 */
      } finally {
        await this.store.markAutoFired(now).catch(() => undefined)
      }
    })()
    this.inflight = task.finally(() => {
      this.autoInFlight = false
      this.inflight = null
    })
    void this.inflight
    out.due = true
    out.slot = slot
    out.reason = null
    return out
  }
}
