/**
 * dsh-tradewatcher — host half.
 *
 * One dual-face bundle row (`tradewatcher` / `dsh-tradewatcher`):
 *  - node half (this file): quote relay + tradewatcher file store +
 *    /tradewatcher/* routes + read-only agent tools + prompt guidance;
 *  - browser half (src/client): registers the 「盯盘」 sidebar tab through
 *    ctx.betterSidebar and talks to this half over same-origin fetch.
 */
import { makeTradeRoutes } from './host/routes.ts'
import { makeAgentTools, servicesOf } from './host/tools.ts'
import { DataStore, dataHome } from './host/store.ts'
import { CalendarStore } from './host/calendar.ts'
import { RescueMonitor } from './host/rescue.ts'
import { log, type PluginContext, type PluginWebRoute } from './host/context.ts'

/** Plugin identity for the bundle-patch row. */
export const name = 'dsh-tradewatcher'

/** Services required before mounting: webserver routes + web runtime trust. */
export const inject = ['webServer', 'webRuntime']

export function apply(ctx: PluginContext): void {
  const store = new DataStore()
  const calendar = new CalendarStore()
  // 护盘监测：交易时段常驻采样（30s / 尾盘 15s），配置随 prefs 同步
  const rescue = new RescueMonitor()
  void store.init().then(() => {
    log('store ready at', dataHome())
    rescue.setConfig(store.getPrefs().rescue)
    rescue.start()
    log('rescue monitor started', `interval ${store.getPrefs().rescue.intervalSec}s / tail ${store.getPrefs().rescue.tailIntervalSec}s`)
  }).catch((error) => {
    log('store init failed:', String(error))
  })

  ctx.effect(() => {
    const { routes } = makeTradeRoutes(store, ctx.webRuntime.trustedHosts, calendar, rescue)
    const disposers = routes.map((route: PluginWebRoute) => {
      try {
        return ctx.webServer.register(route)
      } catch (error) {
        log('route register failed:', route.path, String(error))
        return () => undefined
      }
    })
    return () => {
      rescue.stop()
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* already disposed */
        }
      }
    }
  }, 'dsh-tradewatcher: routes')

  ctx.effect(() => {
    const { tools, systemPrompt } = servicesOf(ctx)
    if (tools === undefined) {
      log('tools service absent — agent tools not registered (UI routes still active)')
      return
    }
    const { registerTools } = makeAgentTools(store, calendar, rescue)
    return registerTools(tools, systemPrompt)
  }, 'dsh-tradewatcher: agent tools')
}
