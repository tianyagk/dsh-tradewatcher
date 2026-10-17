/**
 * 请求节拍（U3）：用**节拍信号**决定"这一拍要不要发请求"，而不是挂在一个每次刷新都会换身份的
 * 对象上（`quotes` / `snapshot`）。
 *
 * 根因：`useEffect(..., [quotes])` 依赖的是**对象身份** ⇒ 每一拍行情（默认 10s）都重发
 * `industries`（全自选）、`breadth?dist=1`（自注"多扫 ~56 页"）、`market-extras`、`trend`。
 * 静置 10 分钟 = 各约 60 次；宿主侧虽然有缓存，但请求数、上游压力与限流风险都 ×6。
 *
 * 这里只放**纯函数与常量**（可被断言），界面只负责"到点才发"：
 *   - `dueByInterval`：时间间隔下限（breadth 60s / extras 30s / 护盘分时 60s）
 *   - `dueEveryTicks`：每 N 拍一次（industries 每 6 拍 ≈ 60s @10s）
 *
 * 副作用是"数据最多旧一个间隔"——这条**必须**写进对应格子的 `title`（诚实性要求），
 * 见 `MarketPage` / `WatchlistPage` / `RescuePanel` 里各处 `title` 的说明。
 */

/** 行情引擎的默认节拍（prefs.refreshSec 的默认值）：只用于"10 分钟窗口里有几拍"的模型 */
export const QUOTE_TICK_SEC = 10

/** 板块/行业（全自选一次）：每 6 拍刷新一次（≈60s @10s 一拍） */
export const INDUSTRIES_EVERY_TICKS = 6

/** 涨跌家数分布（`breadth?dist=1`，宿主缓存也是 60s）：最小间隔 60s */
export const BREADTH_MIN_INTERVAL_MS = 60_000

/** 附加行情（两融/涨跌停/全天预测）：最小间隔 30s */
export const EXTRAS_MIN_INTERVAL_MS = 30_000

/** 护盘面板的分时量能图：最小间隔 60s（原来每采样一拍就重取） */
export const TREND_MIN_INTERVAL_MS = 60_000

/**
 * 静置 10 分钟的调用预算（断言用）。与 `docs/REVIEW-8-CLIENT-UX.md` §U7 的阈值一致：
 * 现状（每拍一次）各约 60 次。
 */
export const CALL_BUDGET_10MIN = {
  industries: 10,
  breadth: 10,
  extras: 20,
  trend: 10,
} as const

/** 时间间隔到点了吗（`lastAt === null` ⇒ 第一次，放行） */
export function dueByInterval(now: number, lastAt: number | null, minMs: number): boolean {
  if (lastAt === null || !Number.isFinite(lastAt)) return true
  if (!Number.isFinite(now)) return false
  return now - lastAt >= minMs
}

/**
 * 第 N 拍该取吗：**第 1 拍必取**（首屏立刻有数据），之后每 `every` 拍取一次。
 * `tickCount` 是"本 effect 跑过几拍"（每次行情刷新 +1），不是时间戳。
 */
export function dueEveryTicks(tickCount: number, every: number): boolean {
  if (!Number.isFinite(tickCount) || tickCount <= 0 || !Number.isFinite(every) || every <= 0) return false
  return tickCount === 1 || (tickCount - 1) % every === 0
}

/** 一拍 = `tickSec` 秒，窗口 `windowSec` 秒内共有几拍（不含窗口右端） */
function ticksInWindow(windowSec: number, tickSec: number): number {
  if (!(windowSec > 0) || !(tickSec > 0)) return 0
  return Math.round(windowSec / tickSec)
}

/** 模型：时间间隔节流下，一个窗口里最多发几次（第 1 拍算 1 次） */
export function callsInWindowInterval(windowSec: number, tickSec: number, minMs: number): number {
  const ticks = ticksInWindow(windowSec, tickSec)
  if (ticks <= 0) return 0
  if (!(minMs > 0)) return ticks // 不节流 = 每拍一次（旧行为）
  const step = Math.max(1, Math.ceil(minMs / (tickSec * 1000)))
  return 1 + Math.floor((ticks - 1) / step)
}

/** 模型："每 N 拍"下，一个窗口里最多发几次（第 1 拍算 1 次） */
export function callsInWindowTicks(windowSec: number, tickSec: number, every: number): number {
  const ticks = ticksInWindow(windowSec, tickSec)
  if (ticks <= 0) return 0
  if (!(every > 0)) return ticks
  return 1 + Math.floor((ticks - 1) / every)
}
