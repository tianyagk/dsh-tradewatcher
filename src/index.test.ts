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
  // **关键**：core 行 apply 两次（同一行重复装载），其余功能行各一次 ——
  // 只 apply"不同行各一次"时，`started` 守卫根本不需要就会被满足（验证员 V-2：那种断言不敏感）。
  apply(a.ctx)
  apply(a.ctx)
  for (const row of ['calendar', 'cloudmap', 'market', 'watchlist', 'portfolio']) apply(a.ctx, { row })
  await new Promise((r) => setTimeout(r, 50)) // 等 store.init() 落定
  assert.equal(__kernelStats.applies, 7, 'apply 共七次（core 两次 + 五个功能行各一次）')
  assert.equal(__kernelStats.inits, 1, 'store.init() 只跑一次')
  assert.equal(__kernelStats.starts, 1, 'rescue.start() 只跑一次（采样器只有一个）')
  // 幂等的范围就是"一次性副作用"：init/start 各一次、采样器一个。
  // （同一 row id 出现两条行属于配置错误：那种情况下路由会按 fiber 各自注册 —— Cordis 对重复 service 本身会报冲突）
  assert.ok(__kernelStats.routeRegs.includes('/tradewatcher/rows'), 'rows 端点必须已注册')
  // 采样器处于运行态（私有字段，测试里读一下；只有一个由 starts=1 保证）
  assert.equal((coreKernel()?.rescue as unknown as { running?: boolean }).running === true, true)
  stopMonitor()
})

test('向后兼容：无 config ⇒ row=all（全量，与拆分前逐字一致）', () => {
  assert.equal(rowOf(undefined, undefined), 'all', '缺省是全量（不是 core！否则功能行路由会 404）')
  assert.equal(rowOf({}, {}), 'all')
  assert.equal(rowOf({ row: 'calendar' }), 'calendar')
  assert.equal(rowOf({ row: 'nonsense' }), 'all', '认不出的行退回全量（宁可多给，不可少给）')
  assert.equal(name, 'dsh-tradewatcher')
})

test('calendar 行：只注册日历那一段；core 行不含日历（行未激活 ⇒ 路由天然 404）', async () => {
  setKernel(null)
  const core = fakeCtx()
  apply(core.ctx, { row: 'core' }) // core
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
  apply(core.ctx, { row: 'core' })
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
  // manifest 已回退为**单行**（六行形态在本机装载失败：同包多活跃 Loader 源 + 本包带客户端半区
  // 会触发 dsh-client-modules 的 composition error ⇒ 全部路由 404，用户端表现为"插件服务异常"）。
  // 这里锁住"只有一个 id: tradewatcher、且不带 config"（带 config 就会退化成只有 core 一段）。
  const ids = [...text.matchAll(/- id: ([a-z0-9-]+)/g)].map((m) => m[1])
  assert.deepEqual(ids, ['tradewatcher'], '只装一行（老 profile 的 id），不带 config ⇒ 全量注册')
  const rows = [...text.matchAll(/config: \{ row: ([a-z]+) \}/g)].map((m) => m[1])
  assert.deepEqual(rows, [], 'manifest 不许带 config.row（否则缺省全量语义被绕过，功能行路由会 404）')
  // task-60 的行级精确 + 数量守恒（防"大写/数字被正则截断"逃检）
  const idLines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- id:'))
  assert.deepEqual(idLines, ['- id: tradewatcher'], 'id 行必须完整且唯一（截断/新增/多行都会失败）')
  assert.equal(idLines.length, ids.length, '抓到的 id 数必须等于 - id: 行数（守恒）')
  assert.equal(text.includes('disabled: true'), false, 'manifest 不该自己禁用行（要关由 profile 层覆盖）')
})

test('P3：market 行只注册独占前缀；/tradewatcher/industry 留在 core（详情抽屉要用）', () => {
  setKernel(null)
  const core = fakeCtx()
  apply(core.ctx, { row: 'core' })
  const market = fakeCtx()
  apply(market.ctx, { row: 'market' })
  // market 独占的五个前缀都在该行；core 里一个都不许有
  // task-60 重定后 market 只剩两条（/board 移回 core、/industries 与 /anomaly 改归 watchlist）
  const owned = ['/tradewatcher/breadth', '/tradewatcher/rescue']
  for (const p of owned) {
    assert.equal(market.routes.includes(p), true, `market 行应注册 ${p}`)
    assert.equal(core.routes.includes(p), false, `core 不该再注册 ${p}（否则关不掉大盘）`)
  }
  // 跨行共享：/tradewatcher/industry 是详情抽屉（core）用的 ⇒ 必须留 core
  assert.equal(core.routes.includes('/tradewatcher/industry'), true, '/tradewatcher/industry 必须留 core')
  // task-60：/board 被大盘+云图两行消费 ⇒ core；/industries 与 /anomaly 只有自选页用 ⇒ watchlist 行
  assert.equal(core.routes.includes('/tradewatcher/board'), true, '/tradewatcher/board 归 core（两行消费）')
  assert.equal(market.routes.includes('/tradewatcher/industry'), false, '它不属于 market（抽屉会因此坏掉）')
  // 工具：rescue 归 market；group_rank 属于自选（P4 再动）⇒ 本轮仍在 core 的兜底里
  assert.ok(market.tools.includes('tradewatcher_rescue'), 'market 行提供 rescue 工具')
  assert.equal(core.tools.includes('tradewatcher_rescue'), false, 'core 不再提供 rescue')
  // group_rank 的数据来源是自选分组 ⇒ 归属 watchlist 行（P1 的表），P3 **不动它**
  assert.equal(core.tools.includes('tradewatcher_group_rank'), false, '它不属于 core（在 watchlist 行）')
  assert.equal(market.tools.includes('tradewatcher_group_rank'), false, '也不属于 market')
  stopMonitor()
})

test('P4：五行（calendar/cloudmap/market/watchlist/portfolio）关闭时三处都不在', async () => {
  const { gateTabs } = await import('./client/tabsGate.ts')
  const TABS = [
    { key: 'watch' as const, label: '自选', full: '自选', row: 'watchlist' },
    { key: 'portfolio' as const, label: '持仓', full: '持仓', row: 'portfolio' },
    { key: 'market' as const, label: '大盘', full: '大盘', row: 'market' },
    { key: 'cloud' as const, label: '云图', full: '云图', row: 'cloudmap' },
    { key: 'calendar' as const, label: '日历', full: '日历', row: 'calendar' },
  ]
  // 每个功能行关闭一次的期望：该行的 tab 消失，其余照常（core 与其它行不受影响）
  for (const row of ['calendar', 'cloudmap', 'market', 'watchlist', 'portfolio'] as const) {
    setKernel(null)
    const core = fakeCtx()
    apply(core.ctx, { row: 'core' })
    const rows = new Set([...coreKernel()!.activeRows]) // 只 apply core ⇒ 只有 core 活跃
    const g = gateTabs(TABS, rows, 'watch')
    assert.equal(g.visible.some((t) => t.row === row), false, `关闭 ${row} ⇒ 它的 tab 不该出现`)
    // 该行的独占路由一个都不在 core 的注册表里（未注册 = 404）
    for (const p of ROW_ROUTES_FOR_TEST[row]) {
      assert.equal(core.routes.includes(p), false, `core 不该注册 ${p}（${row} 行独占）`)
    }
    for (const t of ROW_TOOLS_FOR_TEST[row]) {
      assert.equal(core.tools.includes(`tradewatcher_${t}`), false, `core 不该提供 ${t}（${row} 行独占）`)
    }
    stopMonitor()
  }
  // 回落：当前页是自选/持仓时被停用 ⇒ 必须回落到别的可用 tab
  const off = gateTabs(TABS, new Set(['core', 'portfolio', 'market', 'cloudmap', 'calendar']), 'watch')
  assert.equal(off.fallback, 'portfolio', '自选被停用 ⇒ 回落到首个可用（持仓）')
  const off2 = gateTabs(TABS, new Set(['core', 'watchlist', 'market', 'cloudmap', 'calendar']), 'portfolio')
  assert.equal(off2.fallback, 'watch', '持仓被停用 ⇒ 回落到自选')
})

/** 与 src/index.ts 的 ROW_ROUTES/ROW_TOOLS 同步的测试副本（搬迁一行就要同步改这里 + patch 断言） */
const ROW_ROUTES_FOR_TEST: Record<string, readonly string[]> = {
  calendar: ['/tradewatcher/calendar'],
  cloudmap: [],
  market: ['/tradewatcher/breadth', '/tradewatcher/rescue'],
  watchlist: ['/tradewatcher/watch', '/tradewatcher/industries', '/tradewatcher/anomaly'],
  portfolio: ['/tradewatcher/portfolio', '/tradewatcher/ledger'],
}
const ROW_TOOLS_FOR_TEST: Record<string, readonly string[]> = {
  calendar: ['calendar', 'calendar_add'],
  cloudmap: [],
  market: ['rescue'],
  watchlist: ['watchlist', 'group_rank'],
  portfolio: ['portfolio', 'ledger'],
}

test('task-60：归属按**实测调用方所在行**（board=core / industries=watchlist / anomaly=watchlist）', () => {
  // 判据：被 ≥2 个行消费 ⇒ core；单一消费方 ⇒ 该行。调用方映射（self-verified）：
  //   /tradewatcher/board      MarketPage.tsx:84（market 行）+ IndustryHeatmap.tsx:30（只被 CloudMap.tsx:125 渲染 = cloudmap 行）
  //   /tradewatcher/industries 只有 WatchlistPage.tsx:89（watchlist 行）
  //   /tradewatcher/anomaly    alerts.ts:69 ← 只被 WatchlistPage 引用（watchlist 行）
  const OWNER_BY_CALLERS: Record<string, string> = {
    '/tradewatcher/board': 'core',
    '/tradewatcher/industries': 'watchlist',
    '/tradewatcher/anomaly': 'watchlist',
  }
  setKernel(null)
  const core = fakeCtx()
  apply(core.ctx, { row: 'core' })
  const rows: Record<string, { routes: string[] }> = {}
  for (const row of ['watchlist', 'portfolio', 'market', 'calendar', 'cloudmap']) {
    const c = fakeCtx()
    apply(c.ctx, { row })
    rows[row] = { routes: c.routes }
  }
  for (const [path, owner] of Object.entries(OWNER_BY_CALLERS)) {
    if (owner === 'core') {
      assert.equal(core.routes.includes(path), true, `${path} 应归 core（被 ≥2 个行消费）`)
      for (const [row, v] of Object.entries(rows)) {
        assert.equal(v.routes.includes(path), false, `${path} 不该出现在 ${row} 行（否则关掉 ${row} 会把别的页弄坏）`)
      }
    } else {
      assert.equal(rows[owner].routes.includes(path), true, `${path} 应归 ${owner}（单一消费方）`)
      assert.equal(core.routes.includes(path), false, `${path} 不该留在 core（否则 ${owner} 关不掉）`)
    }
  }
  // 关闭 market ⇒ 这三条仍在（分别由 core / watchlist 提供）
  stopMonitor()
})

test('task-60：patch id 正则放宽 + 行级精确 + 数量守恒（两种注入都抓得住）', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const raw = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const text = raw.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
  // ① 正则放宽到 [a-z0-9-]+（数字行 market2 不再逃过）
  const ID_RE = /- id: (tradewatcher(?:-[a-z0-9-]+)?)/g
  const ids = [...text.matchAll(ID_RE)].map((m) => m[1])
  // ② 数量守恒：抓到的 id 数 == patch 里 `- id:` 行数
  const idLines = text.split('\n').filter((l) => l.includes('- id:')).length
  assert.equal(ids.length, idLines, `抓到的 id 数必须等于 - id: 行数（${ids.length} vs ${idLines}）`)
  // ③ 行级精确：整行必须是 `- id: tradewatcher-<小写+数字+连字符>`，**不许有被正则截断的尾巴**
  //   （这条专门抓 `tradewatcher-portfolioX`：旧正则 [a-z]+ 会截成 tradewatcher-portfolio ⇒ 数量与列表都不变 ⇒ 逃过检测）
  for (const line of text.split('\n')) {
    if (!line.includes('- id:')) continue
    assert.match(line.trim(), /^- id: tradewatcher(?:-[a-z0-9-]+)?$/, `id 行有截断残留：${line.trim()}`)
  }
  // manifest 已回退为单行（六行形态装载失败：同包多活跃 Loader 源 + 带客户端半区 ⇒ composition error）
  assert.deepEqual(ids, ['tradewatcher'], '当前只装一行（legacy id），不带 config ⇒ 全量注册')
})

test('task-60：两种注入的模拟（各证明一次断言会失败）', () => {
  const ID_RE = /- id: (tradewatcher-[a-z0-9-]+)/g
  const base = "- id: tradewatcher-portfolio\n- id: tradewatcher-market\n"
  const baseIds = [...base.matchAll(ID_RE)].map((m) => m[1])
  // 注入 A：`portfolioX` —— 正则截断成 tradewatcher-portfolio ⇒ 数量/列表都不变 ⇒ **必须靠行级精确才抓得住**
  const a = "- id: tradewatcher-portfolioX\n- id: tradewatcher-market\n"
  assert.deepEqual([...a.matchAll(ID_RE)].map((m) => m[1]), baseIds, '截断后数量与列表都没变（换行级检查前确实逃过）')
  const badLines = a.split('\n').filter((l) => l.includes('- id:') && !/^- id: tradewatcher-[a-z0-9-]+$/.test(l.trim()))
  assert.equal(badLines.length, 1, '行级精确能抓到 portfolioX')
  // 注入 B：`market2` —— 数字在字符类里 ⇒ 被抓成一个新 id ⇒ 列表不等 ⇒ 抓得住
  const b = "- id: tradewatcher-portfolio\n- id: tradewatcher-market2\n"
  const bIds = [...b.matchAll(ID_RE)].map((m) => m[1])
  assert.deepEqual(bIds, ['tradewatcher-portfolio', 'tradewatcher-market2'], 'market2 被完整抓到')
  assert.notDeepEqual(bIds, baseIds, '列表不同 ⇒ 断言会失败')
})
