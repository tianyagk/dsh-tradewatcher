/**
 * 插件入口：**多行子组件**（core + 功能行）。
 *
 * 机制（见 `docs/DESIGN-SUBPLUGINS.md` §1）：同一个 package 可以出现在多条 Loader 行里，
 * 靠 `id` + `config.row` 区分；**每行的 host 半区是独立 fiber ⇒ `apply` 会被调用 N 次**
 * （N = 行数）。因此：
 *  ① 一次性副作用（`store.init()`、`rescue.start()`、采样循环、watch）必须**只跑一次** ——
 *     否则 7 行就是 7 个采样器并发写同一个 `rescue-log.json`；
 *  ② 内核实例走**模块级单例**并按 `provide('tradewatcher.core')` 暴露 ⇒ **功能行不许自己 new DataStore()**；
 *  ③ 功能行只注册自己那一段路由/工具（行未激活 ⇒ 三者都不注册，路由天然 404）。
 *
 * 老 profile（无 `config.row`）⇒ row = **`all`（全量；不是 `core`）** ⇒ 与拆分前逐字一致（**全部**路由/工具都注册）；显式 `row: core` 才是"只要内核那一段" —— 缺省给 `core` 会把自选/持仓/大盘/日历的路由一起 404（v0.45.1 实测踩到）。口径见 `rowOf`（本文件 :104-111）。
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
export type RowId = 'core' | 'calendar' | 'watchlist' | 'portfolio' | 'market' | 'cloudmap' | 'tools'

/** 行 → 该行独占的路由前缀（core 注册**其余全部**；P2–P4 再把别的行兑现） */
const ROW_ROUTES: Record<Exclude<RowId, 'core'>, readonly string[]> = {
  calendar: ['/tradewatcher/calendar'],
  // watchlist 行（P4 复核后的准确清单）：只有自选页用的 `/watch`（GET+POST 同路径）。
  // ⚠ `/tradewatcher/trades` 移到 core：**详情抽屉**（core）在用它（QuoteDrawer.tsx:79）⇒ 跨行共享留 core；
  // ⚠ `/tradewatcher/ledger` 移到 portfolio 行：只有持仓页的流水弹窗用它。
  watchlist: ['/tradewatcher/watch', '/tradewatcher/industries', '/tradewatcher/anomaly'],
  // portfolio 行：持仓视图（GET+POST 同路径）+ 流水查询（持仓页的流水弹窗）
  portfolio: ['/tradewatcher/portfolio', '/tradewatcher/ledger'],
  // market 行**独占**（P3 初判 + task-60 按实测调用方重定 + **v0.62.0 再定 board**，见 docs/DESIGN-SUBPLUGINS.md §2.1）：
  //   /tradewatcher/breadth     涨跌家数（只有大盘页用 —— 已 grep 查证）
  //   /tradewatcher/rescue      护盘信号（只有大盘页/护盘面板用）
  //   /tradewatcher/board       板块行情（只有 MarketPage.tsx:84 用 —— 见下）
  // ⚠ 判据：**按实测调用方定归属；被 ≥2 个行消费 ⇒ core；单一消费方 ⇒ 该行**。据此调整了四条：
  //   · /tradewatcher/board      **v0.62.0**：云图页的内建热力视图下线后，唯一调用方只剩 MarketPage.tsx:84
  //                              ⇒ 由 core 改归 **market**（此前因"大盘行 + 云图行两行消费"留在 core）
  //   · /tradewatcher/industries 只有 WatchlistPage.tsx:89 用 ⇒ 归 **watchlist**
  //   · /tradewatcher/anomaly    调用链 alerts.ts:69 ← 只被 WatchlistPage 引用 ⇒ 归 **watchlist**
  //   · /tradewatcher/industry   （单 secid 行业查询）详情抽屉（core）在用 ⇒ 留 core
  market: ['/tradewatcher/breadth', '/tradewatcher/rescue', '/tradewatcher/board'],
  cloudmap: [],
  /**
   * tools 行（工具箱：工具目录 + 工具详情）—— **本轮不独占任何 host 路由** ⇒ 空数组。
   *
   * 归属判据（`docs/DESIGN-SUBPLUGINS.md` §2.2）：**被 ≥2 个行消费 ⇒ core；单一消费方 ⇒ 该行**。
   * 工具箱本身只**消费**已有的接口（工具详情第一批要的持仓/行情数据全部由 core 与 portfolio 行提供，
   * 那两个消费方之外还有别的调用方 ⇒ 留在原行），因此它没有"只被它一个人用"的路由可以拿走：
   *   · 若下一批新增了**只被工具箱用**的路由（例如工具的专用聚合接口）⇒ 按同一判据写进本数组；
   *   · 若某个新接口同时被别的页用（≥2 个行消费）⇒ 它必须留 core，不许塞进这里。
   * 「本行可以没有 host 路由」与 cloudmap 行同款：客户端半区照常贡献 activeRows ⇒ 页签门控照常工作。
   */
  tools: [],
}

/** 行 → 该行独占的 agent 工具名（不含前缀） */
const ROW_TOOLS: Record<Exclude<RowId, 'core'>, readonly string[]> = {
  calendar: ['calendar', 'calendar_add'],
  watchlist: ['watchlist', 'group_rank'],
  portfolio: ['portfolio', 'ledger'],
  market: ['rescue'],
  cloudmap: [],
  // tools 行：本批不带 agent 工具（工具目录/详情是纯 UI）。下一批若加"工具"类 agent 工具 ⇒ 写进本数组
  tools: [],
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

/**
 * 安全读取可选的 `ctx` 属性。
 *
 * ⚠ 真宿主的 `ctx` 是 Cordis 的 Proxy：**访问未 inject 的属性会直接抛**
 * （`cannot get property "config" without inject`），所以 `?.` 救不了 —— 必须 try/catch。
 * 这是 v0.45.3 实测踩到的：插件 fiber 直接 failed，用户端表现为"插件服务异常"。
 */
function ctxSafe<T = unknown>(ctx: unknown, key: string): T | undefined {
  try {
    return (ctx as Record<string, unknown> | null | undefined)?.[key] as T | undefined
  } catch {
    return undefined
  }
}

const KERNEL_KEY = 'tradewatcher.core'
let kernel: CoreKernel | null = null

/**
 * 行配置：`config.row`（第二参数或 `ctx.config`）。
 *
 * **缺省 = `all`（全量）** —— 老 profile 只装一行、不带 config，必须与拆分前逐字一致：
 * 那时所有路由/工具都在，缺省给 `core` 会把自选/持仓/大盘/日历的路由一起 404（v0.45.1 实测踩到，
 * 用户端直接表现为"插件服务异常"）。
 * 显式 `row: core` 才是"只要内核那一段"；认不出的值一律回退 `all`（宁可多给，不可少给）。
 */
export function rowOf(config: unknown, ctxConfig?: unknown): RowId | 'all' {
  const pick = (src: unknown): unknown => (typeof src === 'object' && src !== null ? (src as { row?: unknown }).row : undefined)
  const raw = pick(config) ?? pick(ctxConfig) ?? 'all'
  const row = typeof raw === 'string' ? raw.trim() : 'all'
  return (['core', 'calendar', 'watchlist', 'portfolio', 'market', 'cloudmap', 'tools'] as const).includes(row as RowId)
    ? (row as RowId)
    : 'all'
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
function applyCore(ctx: PluginContext, full = false): void {
  const first = kernel === null
  if (first) {
    kernel = { store: new DataStore(), calendar: new CalendarStore(), rescue: new RescueMonitor(), activeRows: new Set<RowId>(['core']), started: false }
  }
  const k = kernel as CoreKernel
  const provide = ctxSafe<(name: string, value: unknown) => void>(ctx, 'provide')
  if (typeof provide === 'function') {
    try {
      provide.call(ctx, KERNEL_KEY, k)
    } catch {
      /* 宿主没有 provide（或该名字不被接受）⇒ 功能行走模块级 kernel 兜底 */
    }
  }
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
    const owned = full ? [] : Object.values(ROW_ROUTES).flat()
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
    const owned = full ? [] : Object.values(ROW_TOOLS).flat()
    const { registerTools } = makeAgentTools(k.store, k.calendar, k.rescue, undefined, { exclude: owned })
    return registerTools(tools, systemPrompt)
  }, 'dsh-tradewatcher: core agent tools')
}

/** 功能行：只注册自己那一段；内核从 core 行拿（**不许自己 new DataStore**） */
function applyFeatureRow(ctx: PluginContext, row: Exclude<RowId, 'core'>): void {
  const get = ctxSafe<(name: string) => unknown>(ctx, 'get')
  let fromCtx: unknown
  try {
    fromCtx = typeof get === 'function' ? get.call(ctx, KERNEL_KEY) : undefined
  } catch {
    fromCtx = undefined
  }
  const k = (fromCtx as CoreKernel | undefined) ?? kernel
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
  // 只读第二参数：真宿主读 `ctx.config` 会抛（未 inject 的属性访问即抛），v0.45.3 实测
  const row = rowOf(config, ctxSafe(ctx, 'config'))
  __kernelStats.applies += 1
  __kernelStats.rows.push(row)
  ctx.effect(() => {
    log(`row「${row}」mounted`)
    return () => log(`row「${row}」unmounted`)
  }, `dsh-tradewatcher: row ${row}`)
  if (row === 'all') {
    // 老单行装载：全量注册（与拆分前逐字一致），并把六个功能行都标为活跃 ⇒ 客户端 gate 显示全部 tab
    applyCore(ctx, true)
    const k = kernel as CoreKernel | null
    if (k !== null) for (const r of ['calendar', 'watchlist', 'portfolio', 'market', 'cloudmap', 'tools'] as const) k.activeRows.add(r)
  } else if (row === 'core') applyCore(ctx)
  else applyFeatureRow(ctx, row)
}
