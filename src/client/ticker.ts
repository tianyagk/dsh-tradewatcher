/**
 * 全仓**唯一**的报价主 tick（用户 2026-10-26）。60s 一次，订阅者注册回调；卸载必须退订。
 * 时钟页的 1 秒时钟不在这里（它是纯显示时钟，不请求行情）。
 */
export const TICK_MS = 60_000

type Fn = () => void
const subs = new Set<Fn>()
let timer: ReturnType<typeof setInterval> | null = null

/** 订阅主 tick；返回退订函数（幂等） */
export function subscribeTicker(fn: Fn): () => void {
  subs.add(fn)
  if (timer === null) timer = setInterval(() => { for (const f of [...subs]) f() }, TICK_MS)
  return () => {
    subs.delete(fn)
    if (subs.size === 0 && timer !== null) { clearInterval(timer); timer = null }
  }
}

/** 当前订阅数（测试用；0 = 主 tick 已停） */
export function __tickerSubs(): number { return subs.size }
/** 仅供测试：清空订阅与定时器 */
export function __resetTicker(): void { subs.clear(); if (timer !== null) { clearInterval(timer); timer = null } }
