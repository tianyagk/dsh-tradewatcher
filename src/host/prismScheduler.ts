/**
 * 棱镜的时点调度（批次 1）。
 *
 * 运行时用固定节拍（30s，`unref`，`NODE_TEST_CONTEXT` 下不启动 —— 与 `AuctionSampler` 同款），
 * 每次只判「今天有哪些时点刚过且没跑过」：
 *   · 非交易日（`tradingDayState`）不跑；
 *   · 只自动补 **10 分钟内**刚过的时点（更早的错过点不自动追，避免一次刷多轮 token）；
 *   · 已过时点由页面按钮手动补跑（只跑指定时点）。
 * 触发水位落 `prism-settings.json`（`PrismStore.markFired`）。
 */
import { hhmmOf, dayOf } from './time.ts'
import { tradingDayState } from './rescue.ts'
import type { PrismSettings } from '../shared/prism.ts'
import type { PrismStore } from './prismStore.ts'

export const PRISM_TICK_MS = 30_000
/** 自动追的宽限：超过 10 分钟视为「错过」，只允许手动补跑 */
export const PRISM_GRACE_MIN = 10
/** 新闻增量节拍：15 分钟（只在交易日、有节拍时执行） */
export const PRISM_NEWS_EVERY_MS = 15 * 60_000

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

export interface DueSlots {
  trading: boolean
  day: string
  due: string[]
  /** 非交易日/未到点/已跑过都为空；`reason` 只用于"为什么没跑"的可见提示 */
  reason: string | null
}

/** 纯函数：给定设置与时刻，算本轮应触发的时点 */
export function dueSlots(settings: PrismSettings, now: number): DueSlots {
  const day = dayOf(now)
  const state = tradingDayState(now)
  if (!state.trading) {
    return { trading: false, day, due: [], reason: state.label ?? (state.reason === 'weekend' ? '周末' : '非交易日') }
  }
  const hhmm = hhmmOf(now)
  const nowMin = minutesOf(hhmm)
  const fired = new Set(settings.lastFired[day] ?? [])
  const due = settings.times
    .filter((slot) => /^\d{2}:\d{2}$/.test(slot))
    .filter((slot) => !fired.has(slot))
    .filter((slot) => {
      const delta = nowMin - minutesOf(slot)
      return delta >= 0 && delta <= PRISM_GRACE_MIN
    })
    .sort()
  return { trading: true, day, due, reason: due.length === 0 ? '没有到点的时点' : null }
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
  private firing = false
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

  /** 一拍：非交易日/未到点直接返回；到点先落水位再触发（避免同一时点跑两次） */
  async tick(): Promise<DueSlots> {
    const now = (this.opts.now ?? Date.now)()
    const plan = dueSlots(this.store.settings(), now)
    if (!plan.trading) return plan
    // 新闻增量：15 分钟一次（与研判时点解耦；失败留痕在 status，不重试）
    if (this.opts.news !== undefined && now - this.lastNewsAt >= (this.opts.newsEveryMs ?? PRISM_NEWS_EVERY_MS)) {
      this.lastNewsAt = now
      void this.opts.news().catch(() => undefined)
    }
    if (this.opts.match !== undefined) void this.opts.match().catch(() => undefined)
    if (plan.due.length === 0 || this.firing) return plan
    this.firing = true
    try {
      for (const slot of plan.due) {
        await this.store.markFired(plan.day, slot)
        void this.opts.run(slot).catch(() => undefined)
      }
    } finally {
      this.firing = false
    }
    return plan
  }
}
