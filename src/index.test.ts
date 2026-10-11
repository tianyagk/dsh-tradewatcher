/**
 * 多行装载下的 apply 幂等 + 按行分工（task-52 验收）。
 *
 * 为什么必须有这篇：同一 package 出现在 N 条 Loader 行里 ⇒ `apply` 被调用 N 次。
 * 一旦 `store.init()`/`rescue.start()` 还在无条件执行，就是 N 个采样器并发写同一个 `rescue-log.json`。
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext, PluginWebRoute } from './host/context.ts'

// 隔离数据目录：**绝不能在测试里碰用户的 ~/.dsh**（store.init 会读写真实文件）
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tw-rows-'))
const { apply, name, rowOf, setKernel, coreKernel, __kernelStats } = await import('./index.ts')
type CoreKernel = NonNullable<ReturnType<typeof coreKernel>>

/** 每个用例结束都停掉采样循环（否则 node:test 不会退出） */
function stopMonitor(): void {
  coreKernel()?.rescue.stop()
}

// 兜底收尾：任何用例漏掉 stopMonitor 也不让采样器把测试进程拖住
after(() => {
  stopMonitor()
  setTimeout(() => process.exit(0), 10).unref()
})

interface FakeCtx {
  ctx: PluginContext
  routes: string[]
  tools: string[]
  effects: Array<() => void>
}

function fakeCtx(kernel?: CoreKernel): FakeCtx {
  const routes: string[] = []
  const tools: string[] = []
  const effects: Array<() => void> = []
  const ctx = {
    webServer: {
      register(route: PluginWebRoute) {
        routes.push(route.path)
        return () => undefined
      },
    },
    webRuntime: { trustedHosts: [] },
    effect(fn: () => void | (() => void)) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
    },
    get: (n: string) => (n === 'tradewatcher.core' ? kernel : n === 'tools' ? { register: (d: { name: string }) => { tools.push(d.name); return () => undefined } } : undefined),
    provide: () => undefined,
  } as unknown as PluginContext
  return { ctx, routes, tools, effects }
}

test('apply 幂等：同进程 apply 三次，一次性副作用只跑一次', async () => {
  setKernel(null)
  __kernelStats.inits = 0
  __kernelStats.starts = 0
  __kernelStats.applies = 0
  __kernelStats.rows.length = 0
  __kernelStats.routeRegs.length = 0
  const a = fakeCtx()
  apply(a.ctx)
  apply(a.ctx)
  apply(a.ctx)
  await new Promise((r) => setTimeout(r, 50)) // 等 store.init() 落定
  assert.equal(__kernelStats.applies, 3, 'apply 确实被调了三次')
  assert.equal(__kernelStats.inits, 1, 'store.init() 只跑一次')
  assert.equal(__kernelStats.starts, 1, 'rescue.start() 只跑一次（采样器只有一个）')
  // 幂等的范围就是"一次性副作用"：init/start 各一次、采样器一个。
  // （同一 row id 出现两条行属于配置错误：那种情况下路由会按 fiber 各自注册 —— Cordis 对重复 service 本身会报冲突）
  assert.ok(__kernelStats.routeRegs.includes('/tradewatcher/rows'), 'rows 端点必须已注册')
  // 采样器处于运行态（私有字段，测试里读一下；只有一个由 starts=1 保证）
  assert.equal((coreKernel()?.rescue as unknown as { running?: boolean }).running === true, true)
  stopMonitor()
})

test('向后兼容：无 config ⇒ row=core，且 core 兜住除功能行之外的全部路由', () => {
  assert.equal(rowOf(undefined, undefined), 'core', '缺省就是 core')
  assert.equal(rowOf({}, {}), 'core')
  assert.equal(rowOf({ row: 'calendar' }), 'calendar')
  assert.equal(rowOf({ row: 'nonsense' }), 'core', '认不出的行退回 core（不猜）')
  assert.equal(name, 'dsh-tradewatcher')
})

test('calendar 行：只注册日历那一段；core 行不含日历（行未激活 ⇒ 路由天然 404）', async () => {
  setKernel(null)
  const core = fakeCtx()
  apply(core.ctx) // core
  const cal = fakeCtx()
  apply(cal.ctx, { row: 'calendar' })
  await new Promise((r) => setTimeout(r, 50))
  const calRoutes = cal.routes.filter((p) => p.startsWith('/tradewatcher/calendar'))
  assert.ok(calRoutes.length > 0, `calendar 行应注册日历路由（实际 ${JSON.stringify(cal.routes)}）`)
  assert.equal(cal.routes.every((p) => p.startsWith('/tradewatcher/calendar')), true, 'calendar 行不许注册别的路由')
  assert.equal(core.routes.some((p) => p.startsWith('/tradewatcher/calendar')), false, 'core 不许注册日历路由（否则关不掉）')
  assert.ok(core.routes.includes('/tradewatcher/rows'), 'rows 端点由 core 持有（永远可用）')
  assert.ok(core.tools.includes('tradewatcher_position'), 'core 保留核心工具')
  assert.equal(core.tools.includes('tradewatcher_calendar'), false, 'core 不含日历工具')
  assert.ok(cal.tools.includes('tradewatcher_calendar'), 'calendar 行注册日历工具')
  stopMonitor()
})

test('功能行找不到 core ⇒ 拒绝注册（而不是自己 new DataStore 互踩）', () => {
  setKernel(null)
  const orphan = fakeCtx(undefined)
  apply(orphan.ctx, { row: 'calendar' })
  assert.deepEqual(orphan.routes, [], '拿不到内核 ⇒ 一个路由都不注册')
  assert.deepEqual(orphan.tools, [])
})

test('P2：cloudmap 行启用 ⇒ rows 含 cloudmap，gate 含云图 tab；停用 ⇒ 不含', async () => {
  const { gateTabs } = await import('./client/tabsGate.ts')
  const TABS = [
    { key: 'cloud' as const, label: '云图', full: '大盘云图', row: 'cloudmap' },
    { key: 'calendar' as const, label: '日历', full: '财经日历', row: 'calendar' },
  ]
  setKernel(null)
  const core = fakeCtx()
  apply(core.ctx)
  // 只 apply core ⇒ rows 只有 core ⇒ 云图 tab 不在 gate 结果里
  const off = gateTabs(TABS, new Set([...coreKernel()!.activeRows, 'calendar']), 'calendar')
  assert.deepEqual(off.visible.map((t) => t.key), ['calendar'], '关闭 cloudmap ⇒ 云图 tab 不出现（日历不受影响）')
  assert.equal(core.routes.some((p) => p.includes('cloud')), false, '云图没有 host 路由 ⇒ 无兜底注册可言（前缀表里它是空数组）')
  // 开启 cloudmap 行 ⇒ activeRows 含 cloudmap ⇒ gate 里出现云图 tab
  const cloud = fakeCtx()
  apply(cloud.ctx, { row: 'cloudmap' })
  assert.equal(coreKernel()?.activeRows.has('cloudmap'), true, '开启后 rows 应含 cloudmap')
  const on = gateTabs(TABS, new Set([...coreKernel()!.activeRows, 'calendar']), 'calendar')
  assert.deepEqual(on.visible.map((t) => t.key), ['cloud', 'calendar'], '开启后云图 tab 出现')
  assert.equal(cloud.routes.length, 0, 'cloudmap 行本身不注册路由（它是纯客户端 iframe）')
  stopMonitor()
})

test('P2：cordis.patch.yml 与代码的行集合一致（防漂移）', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const raw = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  // 注释里也会出现 `- id: …`（说明文字）⇒ 先剥掉注释行再抓
  const text = raw.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
  const ids = [...text.matchAll(/- id: (tradewatcher-[a-z]+)/g)].map((m) => m[1])
  assert.deepEqual(ids, [
    'tradewatcher-core', 'tradewatcher-calendar', 'tradewatcher-cloudmap', 'tradewatcher-market',
    'tradewatcher-watchlist', 'tradewatcher-portfolio',
  ], '六行齐全且顺序固定')
  // 每行都带 config.row，且与 id 对应
  const blocks = text.split('- id: ').slice(1)
  for (const [i, id] of ids.entries()) {
    const row = id.replace('tradewatcher-', '')
    assert.ok(blocks[i].includes(`config: { row: ${row} }`), `${id} 的 config.row 必须是 ${row}`)
  }
  // 已搬迁的三行必须启用；未搬迁的三行必须 disabled（否则会显示成"已启用"却没有门控）
  // P3：**六行全部启用**。watchlist/portfolio 的路由前缀在 P1 就进了 ROW_ROUTES ⇒
  // 留成 disabled 会让 core 已经排除、行又不提供 ⇒ 真把功能弄坏（tab 也会被 gate 隐藏）。
  const shouldEnable = [
    'tradewatcher-core', 'tradewatcher-calendar', 'tradewatcher-cloudmap',
    'tradewatcher-market', 'tradewatcher-watchlist', 'tradewatcher-portfolio',
  ]
  const shouldDisable: string[] = []
  for (const [i, id] of ids.entries()) {
    const isDisabled = blocks[i].includes('disabled: true')
    assert.equal(isDisabled, shouldDisable.includes(id), `${id} 的 enabled/disabled 与搬迁进度不符`)
  }
  assert.equal(shouldEnable.length + shouldDisable.length, ids.length)
})

test('P3：market 行只注册独占前缀；/tradewatcher/industry 留在 core（详情抽屉要用）', () => {
  setKernel(null)
  const core = fakeCtx()
  apply(core.ctx)
  const market = fakeCtx()
  apply(market.ctx, { row: 'market' })
  // market 独占的五个前缀都在该行；core 里一个都不许有
  const owned = ['/tradewatcher/breadth', '/tradewatcher/board', '/tradewatcher/rescue', '/tradewatcher/anomaly', '/tradewatcher/industries']
  for (const p of owned) {
    assert.equal(market.routes.includes(p), true, `market 行应注册 ${p}`)
    assert.equal(core.routes.includes(p), false, `core 不该再注册 ${p}（否则关不掉大盘）`)
  }
  // 跨行共享：/tradewatcher/industry 是详情抽屉（core）用的 ⇒ 必须留 core
  assert.equal(core.routes.includes('/tradewatcher/industry'), true, '/tradewatcher/industry 必须留 core')
  assert.equal(market.routes.includes('/tradewatcher/industry'), false, '它不属于 market（抽屉会因此坏掉）')
  // 工具：rescue 归 market；group_rank 属于自选（P4 再动）⇒ 本轮仍在 core 的兜底里
  assert.ok(market.tools.includes('tradewatcher_rescue'), 'market 行提供 rescue 工具')
  assert.equal(core.tools.includes('tradewatcher_rescue'), false, 'core 不再提供 rescue')
  // group_rank 的数据来源是自选分组 ⇒ 归属 watchlist 行（P1 的表），P3 **不动它**
  assert.equal(core.tools.includes('tradewatcher_group_rank'), false, '它不属于 core（在 watchlist 行）')
  assert.equal(market.tools.includes('tradewatcher_group_rank'), false, '也不属于 market')
  stopMonitor()
})
