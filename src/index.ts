/**
 * 插件入口：**多行子组件**（core + 功能行）。
 *
 * 机制（见 `docs/DESIGN-SUBPLUGINS.md` §1）：同一个 package 可以出现在多条 Loader 行里，
 * 靠 `id` + `config.row` 区分；**每行的 host 半区是独立 fiber ⇒ `apply` 会被调用 N 次**
 * （N = 行数）。因此：
 *  ① 一次性副作用（`store.init()`、`rescue.start()`、采样循环、watch）必须**只跑一次** ——
 *     否则 6 行就是 6 个采样器并发写同一个 `rescue-log.json`；
 *  ② 内核实例走**模块级单例**并按 `provide('tradewatcher.core')` 暴露 ⇒ **功能行不许自己 new DataStore()**；
 *  ③ 功能行只注册自己那一段路由/工具（行未激活 ⇒ 三者都不注册，路由天然 404）。
 *
 * 老 profile（没有 `config.row`）⇒ row = `core` ⇒ 行为与拆分前**逐字一致**（core 兜住除日历外的一切）。
 */
import { makeTradeRoutes } from './host/routes.ts'
import { makeAgentTools, servicesOf } from './host/tools.ts'
import { DataStore, dataHome } from './host/store.ts'
import { CalendarStore } from './host/calendar.ts'
import { RescueMonitor } from './host/rescue.ts'
import { setQuoteFreshnessMs } from './host/em.ts'
import { log, type PluginContext, type PluginWebRoute } from './host/context.ts'

/** Plugin identity for the bundle-patch rows. */
export const name = 'dsh-tradewatcher'

/** Services required before mounting: webserver routes + web runtime trust. */
export const inject = ['webServer', 'webRuntime']

/** 行标识（配置里写 `config: { row: watchlist }`） */
export type RowId = 'core' | 'calendar' | 'watchlist' | 'portfolio' | 'market' | 'cloudmap'

/** 行 → 该行独占的路由前缀（core 注册**其余全部**；P2–P4 再把别的行兑现） */
const ROW_ROUTES: Record<Exclude<RowId, 'core'>, readonly string[]> = {
  calendar: ['/tradewatcher/calendar'],
  // watchlist 行（P4 复核后的准确清单）：只有自选页用的 `/watch`（GET+POST 同路径）。
  // ⚠ `/tradewatcher/trades` 移到 core：**详情抽屉**（core）在用它（QuoteDrawer.tsx:79）⇒ 跨行共享留 core；
  // ⚠ `/tradewatcher/ledger` 移到 portfolio 行：只有持仓页的流水弹窗用它。
  watchlist: ['/tradewatcher/watch'],
  // portfolio 行：持仓视图（GET+POST 同路径）+ 流水查询（持仓页的流水弹窗）
  portfolio: ['/tradewatcher/portfolio', '/tradewatcher/ledger'],
  // market 行**独占**（P3 查证后的准确清单，见 docs/AUDIT-IMPL14.md）：
  //   /tradewatcher/breadth     涨跌家数（大盘页；顶部行情条**不**用它 —— 已 grep 查证）
  //   /tradewatcher/board       板块/概念资金流
  //   /tradewatcher/industries  行业列表
  //   /tradewatcher/rescue      护盘信号
  //   /tradewatcher/anomaly     异动
  // ⚠ `/tradewatcher/industry`（单个 secid 的行业查询）**留 core**：详情抽屉（core）在用它，
  //   停用大盘不该把抽屉的行业行弄没。它不是 `/tradewatcher/industries` 的前缀（后者更长），
  //   前缀匹配天然分得开 —— 这条判断连同理由写进了报告。
  market: ['/tradewatcher/breadth', '/tradewatcher/board', '/tradewatcher/rescue', '/tradewatcher/anomaly', '/tradewatcher/industries'],
  cloudmap: [],
}

/** 行 → 该行独占的 agent 工具名（不含前缀） */
const ROW_TOOLS: Record<Exclude<RowId, 'core'>, readonly string[]> = {
  calendar: ['calendar', 'calendar_add'],
  watchlist: ['watchlist', 'group_rank'],
  portfolio: ['portfolio', 'ledger'],
  market: ['rescue'],
  cloudmap: [],
}

/**
 * **测试钩子**：一次性副作用的真实执行次数。
 * 幂等的证据就靠它（`apply` 调用 N 次，这两个计数必须还是 1）。
 */
export const __kernelStats = { inits: 0, starts: 0, applies: 0, rows: [] as string[], routeRegs: [] as string[] }

export interface CoreKernel {
  store: DataStore
  calendar: CalendarStore
  rescue: RescueMonitor
  /** 当前活跃行（`/tradewatcher/rows` 的数据源） */
  activeRows: Set<RowId>
  /** 一次性启动是否已完成（幂等标记） */
  started: boolean
}

const KERNEL_KEY = 'tradewatcher.core'
let kernel: CoreKernel | null = null

/** 行配置：`config.row`（第二参数或 `ctx.config`），缺省 `core` ⇒ 老 profile 行为不变 */
export function rowOf(config: unknown, ctxConfig?: unknown): RowId {
  const pick = (src: unknown): unknown => (typeof src === 'object' && src !== null ? (src as { row?: unknown }).row : undefined)
  const raw = pick(config) ?? pick(ctxConfig) ?? 'core'
  const row = typeof raw === 'string' ? raw.trim() : 'core'
  return (['core', 'calendar', 'watchlist', 'portfolio', 'market', 'cloudmap'] as const).includes(row as RowId)
    ? (row as RowId)
    : 'core'
}

/** 当前内核（测试与自检读它；功能行走 `ctx.get('tradewatcher.core')`） */
export function coreKernel(): CoreKernel | null {
  return kernel
}

/** 内核对外的服务名（功能行用 `ctx.get` 拿；测试里也可注入） */
export function setKernel(value: CoreKernel | null): void {
  kernel = value
}

/**
 * core 行：建内核（**模块级单例 + 幂等**）、启动一次性副作用、注册 core 路由/工具与活跃行端点。
 * 无论 `apply` 被调用几次，`store.init()` 与 `rescue.start()` 都只跑一次。
 */
function applyCore(ctx: PluginContext): void {
  const first = kernel === null
  if (first) {
    kernel = { store: new DataStore(), calendar: new CalendarStore(), rescue: new RescueMonitor(), activeRows: new Set<RowId>(['core']), started: false }
  }
  const k = kernel as CoreKernel
  ctx.provide?.(KERNEL_KEY, k)
  let disposed = false

  if (!k.started) {
    k.started = true
    __kernelStats.inits += 1
    void k.store.init().then(() => {
      if (disposed) {
        log('plugin unloaded before store init finished — rescue monitor not started')
        return
      }
      log('store ready at', dataHome())
      setQuoteFreshnessMs(k.store.getPrefs().refreshSec * 1000)
      k.rescue.setConfig(k.store.getPrefs().rescue)
      // 采样器只允许一个：`started` 守卫 + 这个计数用于断言
      __kernelStats.starts += 1
      k.rescue.start()
      log('rescue monitor started', `interval ${k.store.getPrefs().rescue.intervalSec}s / tail ${k.store.getPrefs().rescue.tailIntervalSec}s`)
    }).catch((error) => {
      log('store init failed:', String(error))
    })
  } else {
    log('core row already started — skipping store.init/rescue.start (多行装载时 apply 会被调用 N 次)')
  }

  ctx.effect(() => {
    const { routes: all } = makeTradeRoutes(k.store, ctx.webRuntime.trustedHosts, k.calendar, k.rescue, undefined, undefined, () => [...k.activeRows])
    // core 注册**除功能行独占前缀之外**的全部路由（老 profile 只有 core ⇒ 与拆分前逐字一致）
    const owned = Object.values(ROW_ROUTES).flat()
    const mine = all.filter((r) => !owned.some((p) => r.path.startsWith(p)))
    const disposers = mine.map((route: PluginWebRoute) => {
      try {
        __kernelStats.routeRegs.push(route.path)
        return ctx.webServer.register(route)
      } catch (error) {
        log('route register failed:', route.path, String(error))
        return () => undefined
      }
    })
    return () => {
      disposed = true
      k.rescue.stop()
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* already disposed */
        }
      }
    }
  }, 'dsh-tradewatcher: core routes')

  ctx.effect(() => {
    const { tools, systemPrompt } = servicesOf(ctx)
    if (tools === undefined) {
      log('tools service absent — agent tools not registered (UI routes still active)')
      return
    }
    const owned = Object.values(ROW_TOOLS).flat()
    const { registerTools } = makeAgentTools(k.store, k.calendar, k.rescue, undefined, { exclude: owned })
    return registerTools(tools, systemPrompt)
  }, 'dsh-tradewatcher: core agent tools')
}

/** 功能行：只注册自己那一段；内核从 core 行拿（**不许自己 new DataStore**） */
function applyFeatureRow(ctx: PluginContext, row: Exclude<RowId, 'core'>): void {
  const k = (ctx.get(KERNEL_KEY) as CoreKernel | undefined) ?? kernel
  if (k === null || k === undefined) {
    log(`row「${row}」找不到 tradewatcher.core —— 未注册任何路由/工具（core 行必须先装载或同进程先 apply）`)
    return
  }
  k.activeRows.add(row)
  const prefixes = ROW_ROUTES[row]
  const tools = ROW_TOOLS[row]
  ctx.effect(() => {
    const { routes: all } = makeTradeRoutes(k.store, ctx.webRuntime.trustedHosts, k.calendar, k.rescue, undefined, undefined, () => [...k.activeRows])
    const mine = all.filter((r) => prefixes.some((p) => r.path.startsWith(p)))
    const disposers = mine.map((route: PluginWebRoute) => {
      try {
        __kernelStats.routeRegs.push(route.path)
        return ctx.webServer.register(route)
      } catch (error) {
        log('route register failed:', route.path, String(error))
        return () => undefined
      }
    })
    return () => {
      k.activeRows.delete(row)
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* already disposed */
        }
      }
    }
  }, `dsh-tradewatcher: ${row} routes`)
  if (tools.length === 0) return
  ctx.effect(() => {
    const { tools: runtime, systemPrompt } = servicesOf(ctx)
    if (runtime === undefined) return
    const { registerTools } = makeAgentTools(k.store, k.calendar, k.rescue, undefined, { only: tools })
    return registerTools(runtime, systemPrompt)
  }, `dsh-tradewatcher: ${row} agent tools`)
}

export function apply(ctx: PluginContext, config?: unknown): void {
  const row = rowOf(config, ctx.config)
  __kernelStats.applies += 1
  __kernelStats.rows.push(row)
  ctx.effect(() => {
    log(`row「${row}」mounted`)
    return () => log(`row「${row}」unmounted`)
  }, `dsh-tradewatcher: row ${row}`)
  if (row === 'core') applyCore(ctx)
  else applyFeatureRow(ctx, row)
}
