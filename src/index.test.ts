/**
 * 多行装载下的 apply 幂等 + 按行分工（task-52 验收）。
 *
 * 为什么必须有这篇：同一 package 出现在 N 条 Loader 行里 ⇒ `apply` 被调用 N 次。
 * 一旦 `store.init()`/`rescue.start()` 还在无条件执行，就是 N 个采样器并发写同一个 `rescue-log.json`。
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginContext, PluginWebRoute } from './host/context.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 六行 manifest 的**唯一解析器**（task-6）：剥掉注释行后按
 * `- id:` / `name:` / `config: { row: … }` **三段式**匹配。
 *
 * 严格点是刻意的：`config: { row: … }` 缺失的行**匹配不上** ⇒ "数量守恒"的断言会红
 * （少了 config 的行在运行时回退成 `all`，会把五段功能路又注册一遍 ⇒ 必须被抓到）。
 */
function parseRowsFromText(raw: string): Array<{ id: string; name: string; row: string }> {
  const text = raw.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
  return [...text.matchAll(/- id: (tradewatcher-[a-z0-9]+)\n\s*name: '([^']+)'\n\s*config: \{ row: ([a-z]+) \}/g)].map((m) => ({ id: m[1], name: m[2], row: m[3] }))
}

/** `- id:` 行原文（剥注释后），供"行级精确 + 数量守恒"用 */
function idLinesOf(raw: string): string[] {
  return raw
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- id:'))
}

function parseManifestRows(): Array<{ id: string; name: string; row: string }> {
  return parseRowsFromText(readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8'))
}

/** 六行的期望集合（id ↔ config.row 一一对应；顺序即 manifest 顺序） */
const EXPECTED_ROWS: ReadonlyArray<{ id: string; row: string }> = [
  { id: 'tradewatcher-core', row: 'core' },
  { id: 'tradewatcher-calendar', row: 'calendar' },
  { id: 'tradewatcher-watchlist', row: 'watchlist' },
  { id: 'tradewatcher-portfolio', row: 'portfolio' },
  { id: 'tradewatcher-market', row: 'market' },
  { id: 'tradewatcher-cloudmap', row: 'cloudmap' },
]

/** manifest 里**不许**被 core 注册的路径（功能行独占；core 注册了就等于关不掉该行） */
const FUNCTION_OWNED_PATHS = [
  '/tradewatcher/calendar',
  '/tradewatcher/watch',
  '/tradewatcher/industries',
  '/tradewatcher/anomaly',
  '/tradewatcher/portfolio',
  '/tradewatcher/ledger',
  '/tradewatcher/breadth',
  '/tradewatcher/rescue',
  // v0.62.0：云图页不再消费 /board ⇒ 它现在是 market 行独占（core 必须交出去）
  '/tradewatcher/board',
] as const

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

test('task-6：六行 manifest —— id ↔ config.row 一一对应，且与代码的行集合一致（防漂移）', () => {
  const raw = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  // 注释里也会出现 `- id: …`（说明文字）⇒ 先剥掉注释行再抓
  const text = raw.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
  const rows = parseManifestRows()
  // ⓪ 汇总检查（同一份检查在下面的注入用例里必须非空 ⇒ 断言非恒真）
  const failReal = checkManifest(raw)
  assert.deepEqual(failReal, [], `真实 manifest 必须通过全部六行检查（失败项：${failReal.join(' ／ ')}）`)
  // ① id ↔ config.row 一一对应（顺序也锁住：core 必须在第一行 —— 它先提供内核服务）
  assert.deepEqual(
    rows.map((r) => ({ id: r.id, row: r.row })),
    EXPECTED_ROWS.map((r) => ({ id: r.id, row: r.row })),
    '六行必须齐、顺序不变、每行的 config.row 与自己 id 的后缀对应',
  )
  // 六行仍指向**同一个 npm 包**（只是五行用了本包的 /rows/<row> 子路径来让标题可区分，见 task-8）；
  // 不许出现别的包名（那才是"拆成六个包"）
  const names = [...new Set(rows.map((r) => r.name))]
  for (const n of names) assert.equal(n === BARE_PKG || n.startsWith(`${BARE_PKG}/rows/`), true, `行名必须属于本包（裸名或其 /rows 子路径），实得 ${n}`)
  // ② 数量守恒：解析结果数 == `- id:` 行数（漏 config / 多一行都会红）
  const idLines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- id:'))
  assert.equal(rows.length, idLines.length, `解析到的行数必须等于 - id: 行数（${rows.length} vs ${idLines.length}）`)
  // ③ 行级精确：整行必须是 `- id: tradewatcher-<小写+数字>`，不许有被正则截断的尾巴
  for (const line of idLines) assert.match(line, /^- id: tradewatcher-[a-z0-9]+$/, `id 行有截断/大写残留：${line}`)
  assert.equal(idLines.length, new Set(idLines).size, 'id 不许重复（重复 id 会让 Loader 启动即崩）')
  // ④ manifest 里的 row 值必须被**代码里的 rowOf 认**（锚真实实现：认不出就静默回退 all ⇒ 关不掉还多注册一遍）
  for (const { row } of EXPECTED_ROWS) assert.equal(rowOf({ row }), row, `rowOf 必须认识 ${row}（否则该行回退成 all）`)
  assert.equal(text.includes('disabled: true'), false, 'manifest 自己不许禁用行（要关由 profile 层按 id 覆盖）')
})

test('P3：market 行只注册独占前缀；/tradewatcher/industry 留在 core（详情抽屉要用）', () => {
  setKernel(null)
  const core = fakeCtx()
  apply(core.ctx, { row: 'core' })
  const market = fakeCtx()
  apply(market.ctx, { row: 'market' })
  // market 独占的前缀都在该行；core 里一个都不许有
  // task-60 重定：/industries 与 /anomaly 改归 watchlist；**v0.62.0**：内建热力视图下线后 /board 移回 market
  const owned = ['/tradewatcher/breadth', '/tradewatcher/rescue', '/tradewatcher/board']
  for (const p of owned) {
    assert.equal(market.routes.includes(p), true, `market 行应注册 ${p}`)
    assert.equal(core.routes.includes(p), false, `core 不该再注册 ${p}（否则关不掉大盘）`)
  }
  // 跨行共享：/tradewatcher/industry 是详情抽屉（core）用的 ⇒ 必须留 core
  assert.equal(core.routes.includes('/tradewatcher/industry'), true, '/tradewatcher/industry 必须留 core')
  // v0.62.0：/board 现在只有市场页用 ⇒ 归 market 行（此前是"大盘+云图两行消费"才留 core）
  assert.equal(core.routes.includes('/tradewatcher/board'), false, '/tradewatcher/board 不该留在 core（云图不再用它）')
  assert.equal(market.routes.includes('/tradewatcher/board'), true, '/tradewatcher/board 必须由 market 行注册')
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
  market: ['/tradewatcher/breadth', '/tradewatcher/rescue', '/tradewatcher/board'],
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

test('归属按**实测调用方所在行**（board=market / industries=watchlist / anomaly=watchlist）', () => {
  // 判据：被 ≥2 个行消费 ⇒ core；单一消费方 ⇒ 该行。调用方映射（self-verified）：
  //   /tradewatcher/board      **只有** MarketPage.tsx:84（market 行）—— v0.62.0 内建热力视图下线后，
  //                            云图页那个调用方（已随视图一并删除）不再存在 ⇒ 单一消费方 ⇒ market
  //   /tradewatcher/industries 只有 WatchlistPage.tsx:89（watchlist 行）
  //   /tradewatcher/anomaly    alerts.ts:69 ← 只被 WatchlistPage 引用（watchlist 行）
  const OWNER_BY_CALLERS: Record<string, string> = {
    '/tradewatcher/board': 'market',
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

/** 本包的**裸包名**：必须恰好出现在一行（core）上，否则浏览器半区不注册（见 checkManifest 的注释与 AUDIT-IMPL36） */
const BARE_PKG = 'dsh-tradewatcher'

/** 把一个 manifest 文本跑完整套"六行"检查，返回**失败原因**列表（空 = 通过）。
 *  同一份检查既跑真实文件（必须空）、也跑下面每个注入（必须非空）⇒ 断言**非恒真**。 */
function checkManifest(raw: string): string[] {
  const fail: string[] = []
  const rows = parseRowsFromText(raw)
  const ids = idLinesOf(raw)
  if (rows.length !== ids.length) fail.push(`数量不守恒：解析到 ${rows.length} 行 vs - id: ${ids.length} 行（有行漏了 config: { row: … }）`)
  const want = EXPECTED_ROWS.map((r) => `${r.id}=${r.row}`).join(' | ')
  const got = rows.map((r) => `${r.id}=${r.row}`).join(' | ')
  if (want !== got) fail.push(`id↔row 不匹配：期望 ${want}；实得 ${got}`)
  if (rows.some((r) => r.name !== BARE_PKG && !r.name.startsWith(`${BARE_PKG}/rows/`))) fail.push('有行的 name 既不是裸包名也不是本包的 /rows/<row> 子路径')
  // **裸包名必须恰好一行、且必须在 core 上** —— 这条是「浏览器半区还在不在」的判据（task-8）：
  // dsh-client-modules 只把裸包名当成 client source（`exactPackageSpecifier` 对含 `/` 的非 scoped
  // specifier 返回 undefined，lib/index.js:82-88 配合 :746-747 的 `return void 0`）⇒
  // **六行全给子路径 ⇒ 浏览器半区整体不注册**（实测：`window.__DSH_BOOT__` 里 `dsh-tradewatcher` 出现 0 次，
  // 而宿主路由照样 200 ⇒ 静默失败）。详见 docs/AUDIT-IMPL36.md。
  const bare = rows.filter((r) => r.name === BARE_PKG)
  if (bare.length !== 1) fail.push(`必须恰好一行用裸包名 ${BARE_PKG}（实测 ${bare.length} 行）⇒ 否则浏览器半区不注册`)
  else if (bare[0].row !== 'core') fail.push(`裸包名必须留在 core 行上（实测在 ${bare[0].row} 行）`)
  // 其余功能行必须是自己的子路径（标题由它决定，见 task-8 的 locale 元数据）
  for (const r of rows) {
    if (r.row === 'core') continue
    if (r.name !== `${BARE_PKG}/rows/${r.row}`) fail.push(`功能行 ${r.row} 的 name 应为 ${BARE_PKG}/rows/${r.row}（实得 ${r.name}）`)
  }
  for (const line of ids) if (!/^- id: tradewatcher-[a-z0-9]+$/.test(line)) fail.push(`id 行不合法（截断/大写/多余字符）：${line}`)
  if (new Set(ids).size !== ids.length) fail.push('id 有重复（Loader 启动即崩）')
  for (const r of rows) if (rowOf({ row: r.row }) !== r.row) fail.push(`代码里的 rowOf 不认 ${r.row}（该行会静默回退成 all）`)
  return fail
}

test('task-6/8：八种注入各让"六行检查"非空（改名/大写/数字后缀/漏 config/row 拼错/裸包名不变量三种）—— 证明断言非恒真', () => {
  const raw = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  // 注入只改**正文**（剥注释后的文本）：本文件的注释里也写着 `tradewatcher-portfolio` 这类字样，
  // 直接在原文上 replace 会改到注释 ⇒ 被剥掉 ⇒ 注入静默失效（这本身就是个假阴性陷阱，记在这里）。
  const body = raw.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
  const failBase = checkManifest(body)
  assert.deepEqual(failBase, [], `基准（未注入）必须通过 —— 否则下面的注入证明无效（失败项：${failBase.join(' ／ ')}）`)
  const injections: Array<{ name: string; mutate: (s: string) => string; hit: RegExp }> = [
    { name: '改名（小写后缀拼错）', mutate: (s) => s.replace('- id: tradewatcher-portfolio\n', '- id: tradewatcher-portfoliox\n'), hit: /id↔row 不匹配/ },
    { name: '大写残留（正则截断的经典逃检）', mutate: (s) => s.replace('- id: tradewatcher-portfolio\n', '- id: tradewatcher-Portfolio\n'), hit: /id 行不合法|数量不守恒/ },
    { name: '数字后缀（旧 [a-z]+ 正则会把 market2 截成 market）', mutate: (s) => s.replace('- id: tradewatcher-market\n', '- id: tradewatcher-market2\n'), hit: /id↔row 不匹配/ },
    { name: '漏掉 config（该行会静默回退成 all，把别的行那几段又注册一遍）', mutate: (s) => s.replace('      config: { row: market }\n', ''), hit: /数量不守恒/ },
    { name: 'row 值拼错（认不出的 row 静默回退 all）', mutate: (s) => s.replace('config: { row: market }', 'config: { row: marketx }'), hit: /id↔row 不匹配|rowOf 不认/ },
    // task-8：把 core 也换成子路径 ⇒ **浏览器半区会整体消失**（实测 0 次），断言必须抓到
    { name: '六行全给子路径（core 也换掉 ⇒ 浏览器半区不注册）', mutate: (s) => s.replace("      name: 'dsh-tradewatcher'\n", "      name: 'dsh-tradewatcher/rows/core'\n"), hit: /必须恰好一行用裸包名|裸包名必须留在 core/ },
    // task-8：两行抢裸包名 ⇒ 同样要抓到（多了也不行）
    { name: '两行抢裸包名', mutate: (s) => s.replace("      name: 'dsh-tradewatcher/rows/cloudmap'\n", "      name: 'dsh-tradewatcher'\n"), hit: /必须恰好一行用裸包名/ },
    // task-8：功能行悄悄退回裸包名 ⇒ 标题又会全都一样
    { name: '功能行退回裸包名（标题将不可区分）', mutate: (s) => s.replace("      name: 'dsh-tradewatcher/rows/market'\n", "      name: 'dsh-tradewatcher'\n"), hit: /必须恰好一行用裸包名|的 name 应为/ },
  ]
  for (const { name, mutate, hit } of injections) {
    const mutated = mutate(body)
    assert.notEqual(mutated, body, `注入「${name}」必须真的改到了正文（否则这条证明无效）`)
    const fail = checkManifest(mutated)
    assert.ok(fail.length > 0, `注入「${name}」必须被抓到（实际一条都没报 ⇒ 断言恒真）`)
    assert.match(fail.join(' ／ '), hit, `注入「${name}」报的原因应是预期的：${JSON.stringify(fail)}`)
  }
  // 注入 A 的具体逃检路径：`portfolioX` 用旧正则 [a-z]+ 会截成 `portfolio` ⇒ 数量与列表都不变
  const oldRe = /- id: (tradewatcher-[a-z]+)/g
  assert.deepEqual([..."- id: tradewatcher-portfolioX\n".matchAll(oldRe)].map((m) => m[1]), ['tradewatcher-portfolio'], '旧正则确实会截断成合法 id ⇒ 必须靠行级精确才抓得住')
  const newRe = /- id: (tradewatcher-[a-z0-9]+)/g
  assert.deepEqual([..."- id: tradewatcher-portfolioX\n".matchAll(newRe)].map((m) => m[1]), ['tradewatcher-portfolio'], '新正则也截断（X 不在 [a-z0-9] 里）⇒ 由 `id 行不合法` 那条兜住')
})

/**
 * 等**别的**用例遗留的 `store.init()` promise 全部落定。
 *
 * 为什么必须等：`__kernelStats.starts` 是在 `store.init().then(...)` 的**异步链**里 +1 的，
 * 而前面几个用例 `setKernel(null)` 之后没有 dispose 掉旧内核（假 ctx 不 dispose）⇒
 * 它们的 init 会在后面的用例窗口里陆续落定，把全局计数抬高（实测：不等就直接读到 9）。
 * 不先排空就断言 `starts === 1`，等于在断言"别的用例的异步尾巴不落在我这儿"——那是**恒假/恒真**的赌博。
 */
async function drainForeignStarts(): Promise<void> {
  let last = __kernelStats.starts
  let stable = 0
  for (let i = 0; i < 80 && stable < 3; i++) {
    await new Promise((r) => setTimeout(r, 20))
    if (__kernelStats.starts === last) stable += 1
    else {
      stable = 0
      last = __kernelStats.starts
    }
  }
  assert.ok(stable >= 3, `前置内核的 store.init() 迟迟不落定（starts=${__kernelStats.starts}）—— 测试环境异常，别把不稳定当通过`)
}

test('task-6：六行装载（manifest 驱动）—— 幂等各 1 次、每行只注册自己那段、跨行零重复、并集 == 老单行', async () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 50))
  /**
   * 等到条件成立（有界）。
   *
   * ⚠ 为什么需要它：`store.init()` 是**真异步**（在临时 DSH_HOME 上做文件 IO），它落定要多久
   * 取决于机器负载 —— 原来用"固定睡 50ms 就当 init 落定"，在慢机器/满负载下会**假失败**
   * （`starts` 还是 0 就断言 == 1）。本仓库自己的原则是"别把不稳定当通过"，故改成等条件；
   * 有界（超时即退出）⇒ 真的没落定时断言照样失败，不会把失败等成通过。
   */
  const waitFor = async (cond: () => boolean, ms = 5000): Promise<void> => {
    const t0 = Date.now()
    while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20))
  }
  await drainForeignStarts()
  setKernel(null)
  __kernelStats.inits = 0
  __kernelStats.starts = 0
  __kernelStats.applies = 0
  __kernelStats.rows.length = 0
  __kernelStats.routeRegs.length = 0

  // —— ① 幂等：core 行 apply 两次（同一行出现两条 fiber）+ 五个功能行各一次 = 真实六行装载 ——
  const twice = fakeCtx()
  apply(twice.ctx, { row: 'core' })
  apply(twice.ctx, { row: 'core' })
  for (const { row } of EXPECTED_ROWS.filter((r) => r.row !== 'core')) {
    const c = fakeCtx()
    apply(c.ctx, { row })
  }
  // 等 init 真的落定（不是"睡够 50ms 就算落定"）
  await waitFor(() => __kernelStats.starts === 1)
  assert.equal(__kernelStats.applies, 7, 'apply 共七次（core 两次 + 五个功能行各一次）')
  assert.equal(__kernelStats.inits, 1, 'store.init() 只跑一次（六个 fiber 共用一个内核）')
  assert.equal(__kernelStats.starts, 1, 'rescue.start() 只跑一次（采样器只能有一个）')
  assert.equal((coreKernel()?.rescue as unknown as { running?: boolean }).running, true, '采样器处于运行态')

  // —— ② 分工：manifest 声明的那六行，每行一条 fiber，一条不多一条不少 ——
  const coreCtx = fakeCtx()
  apply(coreCtx.ctx, { row: 'core' })
  const perRow: Array<[string, FakeCtx]> = [['core', coreCtx]]
  for (const { row } of EXPECTED_ROWS.filter((r) => r.row !== 'core')) {
    const c = fakeCtx()
    apply(c.ctx, { row })
    perRow.push([row, c])
  }
  await tick()
  assert.equal(__kernelStats.inits, 1, '再注册一轮也不许重跑 store.init()')
  assert.equal(__kernelStats.starts, 1, '再注册一轮也不许再起采样器')
  // 这一处是"不许再涨"，睡一小会儿即足够（涨了就是 bug，不该靠等待掩盖）

  const byRow = new Map(perRow)
  // —— ② 跨行零重复（**先查这个**：它是最根本的不变量，隔离性由它 + 每行前缀表共同保证）——
  // 同一路径/工具被两行各注册一次 ⇒ 关掉一行会连带弄坏另一行（这正是"可单独开关"的失败模式）。
  const owner = new Map<string, string>()
  const dupes: string[] = []
  const toolOwner = new Map<string, string>()
  const toolDupes: string[] = []
  for (const [row, c] of perRow) {
    for (const p of c.routes) {
      const prev = owner.get(p)
      if (prev === undefined) owner.set(p, row)
      else dupes.push(`${p} ← ${prev} 与 ${row}`)
    }
    for (const t of c.tools) {
      const prev = toolOwner.get(t)
      if (prev === undefined) toolOwner.set(t, row)
      else toolDupes.push(`${t} ← ${prev} 与 ${row}`)
    }
  }
  assert.deepEqual(dupes, [], '同一路径被两行各注册一次 ⇒ 关掉一行会连带弄坏另一行')
  assert.deepEqual(toolDupes, [], '同一工具被两行各注册一次')

  // —— ③ 分工：每一行只注册自己前缀下的路由/工具 ——
  for (const { row } of EXPECTED_ROWS.filter((r) => r.row !== 'core')) {
    const c = byRow.get(row) as FakeCtx
    const ownedRoutes = ROW_ROUTES_FOR_TEST[row]
    const ownedTools = ROW_TOOLS_FOR_TEST[row].map((t) => `tradewatcher_${t}`)
    if (ownedRoutes.length === 0) {
      assert.deepEqual(c.routes, [], `${row} 行不该注册 host 路由（它只贡献 activeRows）`)
      assert.deepEqual(c.tools, [], `${row} 行不该注册 agent 工具`)
      continue
    }
    assert.ok(c.routes.length > 0, `${row} 行应注册路由（实际 ${JSON.stringify(c.routes)}）`)
    for (const p of c.routes) assert.equal(ownedRoutes.some((x) => p.startsWith(x)), true, `${row} 行不该注册 ${p}`)
    for (const p of ownedRoutes) assert.equal(c.routes.includes(p), true, `${row} 行应注册 ${p}`)
    for (const t of c.tools) assert.equal(ownedTools.includes(t), true, `${row} 行不该注册工具 ${t}`)
    for (const t of ownedTools) assert.equal(c.tools.includes(t), true, `${row} 行应注册工具 ${t}`)
  }
  // core 逐条给出"确实不含功能行独占路径"的证据（关掉一行的前提是 core 不兜着它）
  for (const p of FUNCTION_OWNED_PATHS) {
    assert.equal(coreCtx.routes.includes(p), false, `core 不许注册 ${p}（否则那一行关不掉）`)
    assert.equal(coreCtx.routes.some((x) => x.startsWith(p)), false, `core 不许注册 ${p} 前缀下的任何路径`)
  }
  for (const t of ['tradewatcher_calendar', 'tradewatcher_calendar_add', 'tradewatcher_watchlist', 'tradewatcher_group_rank', 'tradewatcher_portfolio', 'tradewatcher_ledger', 'tradewatcher_rescue']) {
    assert.equal(coreCtx.tools.includes(t), false, `core 不许提供 ${t}（归功能行）`)
  }
  // core 必须保住的东西（被 ≥2 行消费 / 内核自己持有）
  // ⚠ v0.62.0：`/tradewatcher/board` 已从本清单移除 —— 它不再被跨行消费，改由 market 行注册
  // （若还留在这里，就会与 ROW_ROUTES 的 market 归属**同时成立**，等于两个地方都兜着它）
  for (const p of ['/tradewatcher/health', '/tradewatcher/rows', '/tradewatcher/industry', '/tradewatcher/trades', '/tradewatcher/chips']) {
    assert.equal(coreCtx.routes.includes(p), true, `${p} 必须留在 core（共享消费者 / 内核持有）`)
  }
  assert.equal(coreCtx.routes.includes('/tradewatcher/board'), false, '/tradewatcher/board 不再由 core 兜底')

  // —— ④ 六行的并集必须与老的单行全量**逐字一致**（不多、不少）——
  // 这是"用户重启 dsh web 后不掉功能"的判据，也是回退成单行不会丢东西的判据。
  const all = fakeCtx()
  apply(all.ctx) // 无 config ⇒ row=all（向后兼容路径，老 profile 靠它）
  await tick()
  assert.equal(all.routes.length, new Set(all.routes).size, '单行全量自己不许有重复路径')
  assert.deepEqual([...new Set(all.routes)].sort(), [...owner.keys()].sort(), '六行注册的路径并集 == 单行全量注册的路径集合')
  assert.deepEqual([...new Set(all.tools)].sort(), [...toolOwner.keys()].sort(), '六行的工具并集 == 单行全量的工具集合')
  stopMonitor()
})

test('真宿主 ctx 是 Proxy：访问未 inject 的属性会抛 —— apply 不许因此 failed', () => {
  // 复现 v0.45.2 的事故：真 Cordis ctx 读 `ctx.config` 抛 `cannot get property "config" without inject`，
  // 而我们的假 ctx 是普通对象 ⇒ 漏检。这里用 Proxy 造出同样的行为。
  setKernel(null)
  const routes: string[] = []
  const target: Record<string, unknown> = {
    effect: (fn: () => unknown) => {
      const d = fn()
      return () => {
        if (typeof d === 'function') (d as () => void)()
      }
    },
    webServer: { register: (r: { path: string }) => {
      routes.push(r.path)
      return () => undefined
    } },
    webRuntime: { trustedHosts: [] },
  }
  const ctx = new Proxy(target, {
    get(t, k) {
      if (typeof k === 'string' && k in t) return t[k]
      throw new Error(`cannot get property "${String(k)}" without inject`)
    },
    has: () => true,
  })
  assert.doesNotThrow(() => apply(ctx as never), 'apply 不许抛（否则整行 fiber failed、插件整体不可用）')
  // 缺省 = 全量 ⇒ 各功能行的路由都必须注册上（这正是用户看到"插件服务异常"时缺的东西）
  for (const path of ['/tradewatcher/health', '/tradewatcher/rows', '/tradewatcher/calendar', '/tradewatcher/watch', '/tradewatcher/ledger', '/tradewatcher/breadth', '/tradewatcher/chips']) {
    assert.equal(routes.includes(path), true, `${path} 必须注册（row=all）`)
  }
  assert.equal(coreKernel()?.started, true, '内核仍应启动')
})

/**
 * 标题允许的字符集：**可打印 ASCII + 分隔符 `·`（U+00B7）**。
 *
 * ⚠ 任务卡里写的是严格 `^[\x20-\x7E]+$`，但**同一张卡给的示例标题 `Tradewatcher · Core` 自带 `·`** ——
 * 严格 ASCII 断言会把卡里的示例判红。这里按这条要求的**本意**实现（用户要的是"标题用英文"，
 * 即标题不得含中文），把 `·` 显式列进允许集；真要严格 ASCII，把分隔符换成 `: ` 即可（见 AUDIT-IMPL36 §8）。
 */
const TITLE_OK = /^[\x20-\x7E·]+$/
/** CJK 及其标点/全角字符：标题里一个都不许有（描述里允许且 zh 必须含） */
const CJK_RE = /[\u3400-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/
/**
 * 标题的**命名不变量**（task-12）：`dsh-tradewatcher` 或 `dsh-tradewatcher-<小写单词>`。
 *
 * 用户口径：插件名（头部）显示 `dsh-tradewatcher`，组件名显示 `dsh-tradewatcher-*`。
 * core 行的 specifier 是**裸包名**（`dsh-client-modules` 只认它，见 checkManifest 的注释）⇒
 * 头部（`packageText` 取 `pkg.meta.title`，`dsh-plugin-manager` 的 bundles 构造）与
 * core 行（`packages.metaOf(row.name)`，`declaredRows`）**解析的是同一个 specifier**
 * ⇒ 两者**必然同值**：core 行标题只能是 `dsh-tradewatcher`（= 插件名），不可能写成 `dsh-tradewatcher-core`。
 */
const TITLE_NAME_OK = /^dsh-tradewatcher(-[a-z]+)?$/

interface LocaleEntry { dir: string; lang: 'en' | 'zh'; title: string; description: string }

/**
 * 一份 locale 元数据的完整检查，返回**失败原因**（空 = 通过）。
 * 同一份检查既跑真实文件（必须空）、也跑下面的注入（必须非空）⇒ 断言**非恒真**。
 */
function localeMetaViolations(entries: readonly LocaleEntry[]): string[] {
  const fail: string[] = []
  for (const e of entries) {
    const where = `${e.dir}/${e.lang}.json`
    if (e.title.trim() === '') fail.push(`${where} 的 title 为空`)
    if (!TITLE_OK.test(e.title)) fail.push(`${where} 的 title 含非允许字符（只允许可打印 ASCII 与 ·）：${e.title}`)
    if (CJK_RE.test(e.title)) fail.push(`${where} 的 title 含 CJK —— 标题必须是英文：${e.title}`)
    if (!TITLE_NAME_OK.test(e.title)) fail.push(`${where} 的 title 不符合命名不变量 ^dsh-tradewatcher(-[a-z]+)?$：${e.title}`)
    if (e.description.trim() === '') fail.push(`${where} 的 description 为空`)
    if (e.lang === 'zh' && !CJK_RE.test(e.description)) fail.push(`${where} 的 description 必须含中文（中文解释只留在描述行）：${e.description}`)
    if (e.lang === 'en' && CJK_RE.test(e.description)) fail.push(`${where} 的 description 应是英文：${e.description}`)
  }
  return fail
}

test('task-8/9：六行标题各自可区分 + 标题必须英文（两语都是）、中文只留在 zh 描述行', () => {
  const rows = parseRowsFromText(readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8'))
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string; exports: Record<string, unknown>; files: string[] }
  // ① `readPluginMeta` 的入口是 `<specifier>/locale/en.json`（@deepseek-ai/dsh-app-boot 的 readPluginMeta）⇒
  //    en.json 必须存在（否则整个 locale 目录都不会被读），且 exports 必须把它暴露出去。
  const entries: LocaleEntry[] = []
  const titles = new Map<string, string>()
  for (const r of rows) {
    const dir = r.row === 'core' ? 'locale' : `locale/rows/${r.row}`
    for (const lang of ['en', 'zh'] as const) {
      const raw = JSON.parse(readFileSync(join(ROOT, dir, `${lang}.json`), 'utf8')) as { meta?: { title?: string; description?: string } }
      assert.equal(typeof raw.meta?.title, 'string', `${dir}/${lang}.json 必须有 meta.title`)
      assert.equal(typeof raw.meta?.description, 'string', `${dir}/${lang}.json 必须有 meta.description`)
      entries.push({ dir, lang, title: raw.meta?.title ?? '', description: raw.meta?.description ?? '' })
    }
    // exports 必须让 `<specifier>/locale/*.json` 可解析（Node 的 exports 门禁：没映射就 ERR_PACKAGE_PATH_NOT_EXPORTED）
    const pattern = r.row === 'core' ? './locale/*' : `./rows/${r.row}/locale/*`
    assert.equal(pattern in pkg.exports, true, `package.json 缺少 exports["${pattern}"]（locale 资源解析不到）`)
    assert.equal(r.row === 'core' ? './rows/core' in pkg.exports : `./rows/${r.row}` in pkg.exports, r.row !== 'core', `core 行必须留在裸包名上（不给自己开子路径）`)
    titles.set(r.row, entries[entries.length - 1].title) // zh 是最后读的一个 ⇒ 中文环境实际取到的那个
  }
  // ② 真实文件必须全过（标题英文、zh 描述含中文、en 描述英文）
  const fail = localeMetaViolations(entries)
  assert.deepEqual(fail, [], `locale 元数据检查未通过（失败项：${fail.join(' ／ ')}）`)
  // ③ **zh 的 title 也必须是英文** —— 解析是 `text.zh ?? text.en`，中文环境取的是 zh 键（最容易漏的一条）
  for (const e of entries) assert.equal(CJK_RE.test(e.title), false, `${e.dir}/${e.lang}.json 的 title 必须是英文`)
  // ④ 六行标题**互不相同**；其中 **core 的标题 = 插件名**（两者同一个 specifier，见 TITLE_NAME_OK 的注释）
  assert.equal(titles.size, rows.length, '六行都要有自己的标题')
  assert.equal(new Set(titles.values()).size, rows.length, `六行标题必须互不相同（实得 ${JSON.stringify([...titles.values()])}）`)
  assert.equal(titles.get('core'), pkg.name, `core 行标题必须等于包名（头部显示的就是它）：${titles.get('core')} vs ${pkg.name}`)
  for (const row of ['calendar', 'watchlist', 'portfolio', 'market', 'cloudmap']) {
    assert.equal(titles.get(row), `${pkg.name}-${row}`, `${row} 行标题应是 <包名>-<row>：${titles.get(row)}`)
  }
  // ⑤ 发布清单要带上 locale（否则打包后标题解析不到）
  assert.equal(pkg.files.includes('locale'), true, 'package.json 的 files 必须包含 locale')
})

test('task-9：三种注入各让 locale 检查非空（title 写回中文 / zh 描述失去中文 / title 混入全角）—— 证明断言非恒真', () => {
  const rows = parseRowsFromText(readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8'))
  const real: LocaleEntry[] = []
  for (const r of rows) {
    const dir = r.row === 'core' ? 'locale' : `locale/rows/${r.row}`
    for (const lang of ['en', 'zh'] as const) {
      const raw = JSON.parse(readFileSync(join(ROOT, dir, `${lang}.json`), 'utf8')) as { meta?: { title?: string; description?: string } }
      real.push({ dir, lang, title: raw.meta?.title ?? '', description: raw.meta?.description ?? '' })
    }
  }
  assert.deepEqual(localeMetaViolations(real), [], '基准（未注入）必须通过 —— 否则下面的注入证明无效')
  const injections: Array<{ name: string; mutate: (e: LocaleEntry[]) => LocaleEntry[]; hit: RegExp }> = [
    { name: 'title 写回中文（用户当初的诉求就是不要这个）', mutate: (e) => e.map((x) => (x.dir === 'locale/rows/cloudmap' && x.lang === 'zh' ? { ...x, title: '盯盘 · 云图' } : x)), hit: /title 含 CJK/ },
    { name: 'zh 描述失去中文（中文解释没地方放了）', mutate: (e) => e.map((x) => (x.lang === 'zh' && x.dir === 'locale' ? { ...x, description: 'quotes and charts' } : x)), hit: /必须含中文/ },
    { name: 'title 混入全角括号（不是 CJK 字，但也不是 ASCII）', mutate: (e) => e.map((x) => (x.dir === 'locale' && x.lang === 'en' ? { ...x, title: 'Tradewatcher（Core）' } : x)), hit: /非允许字符|含 CJK/ },
    // task-12：改回"英文友好名" —— 它既不含 CJK 也不含非法字符，**只有命名不变量抓得住**
    { name: 'title 改回英文友好名（task-12 要防的回归）', mutate: (e) => e.map((x) => (x.dir === 'locale/rows/calendar' && x.lang === 'zh' ? { ...x, title: 'Tradewatcher · Calendar' } : x)), hit: /命名不变量/ },
  ]
  for (const { name, mutate, hit } of injections) {
    const mutated = mutate(real)
    assert.notDeepEqual(mutated, real, `注入「${name}」必须真的改到了数据（否则这条证明无效）`)
    const fail = localeMetaViolations(mutated)
    assert.ok(fail.length > 0, `注入「${name}」必须被抓到（实际一条都没报 ⇒ 断言恒真）`)
    assert.match(fail.join(' ／ '), hit, `注入「${name}」报的原因应是预期的：${JSON.stringify(fail)}`)
  }
})

/**
 * v0.62.0（task-10）：`/board` 的归属 —— **锚真实源码**，并对注入的反例必须**非空**。
 *
 * 判据（设计文档 §2.2）：被 ≥2 个行消费 ⇒ core；单一消费方 ⇒ 该行。
 * `cloudmap` 行的内建热力视图下线后，`/board` 只剩 `MarketPage.tsx:84` 一个调用方 ⇒ 归 `market`。
 * 本函数从 `src/index.ts` 源码里**取出**各行的路由清单（不另抄一份），因此"改回去"必被抓。
 */
function boardOwnershipProblems(src: string): string[] {
  const bad: string[] = []
  const routesOf = (row: string): string[] | null => {
    const m = new RegExp(`\\n  ${row}: \\[([^\\]]*)\\]`).exec(src)
    if (m === null) return null
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  }
  const market = routesOf('market')
  const cloudmap = routesOf('cloudmap')
  const watchlist = routesOf('watchlist')
  const portfolio = routesOf('portfolio')
  if (market === null || cloudmap === null || watchlist === null || portfolio === null) {
    return ['未能从 src/index.ts 抽出各行路由清单（锚点变了？）']
  }
  if (!market.includes('/tradewatcher/board')) bad.push('/tradewatcher/board 必须由 market 行独占（单一消费方）')
  for (const [row, list] of [['cloudmap', cloudmap], ['watchlist', watchlist], ['portfolio', portfolio]] as Array<[string, string[]]>) {
    if (list.includes('/tradewatcher/board')) bad.push(`/tradewatcher/board 不该出现在 ${row} 行`)
  }
  return bad
}

test('v0.62.0：/board 归 market 行（不在 core、也不在别的行）；反例注入必须失败', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8')
  assert.deepEqual(boardOwnershipProblems(src), [], '真实源码：/board 必须只由 market 行持有')
  // 反例 ①：把 /board 从 market 撤掉 ⇒ 等于"回 core"（core 是"没人认领才兜底"的那一行）⇒ 必须非空
  const backToCore = src.replace(
    "market: ['/tradewatcher/breadth', '/tradewatcher/rescue', '/tradewatcher/board']",
    "market: ['/tradewatcher/breadth', '/tradewatcher/rescue']",
  )
  const p1 = boardOwnershipProblems(backToCore)
  assert.notDeepEqual(p1, [], '⚠ 反例（/board 改回 core 的形态）必须被判据抓住')
  assert.throws(() => assert.deepEqual(p1, [], '反例上"必须只由 market 持有"必须失败'), /反例上/,
    '⚠ 反例注入（改回 core）必须让断言失败')
  // 反例 ②：把 /board 塞回 cloudmap 行（旧归属的形态）⇒ 必须非空
  const backToCloudmap = src.replace("cloudmap: [],", "cloudmap: ['/tradewatcher/board'],")
  assert.notDeepEqual(boardOwnershipProblems(backToCloudmap), [], '⚠ 反例（塞回云图行）必须被判据抓住')
})

test('v0.62.0：关闭 market 行 ⇒ /board 走 404（core 不再兜底），云图页不受影响', () => {
  setKernel(null)
  // 只 apply core（= 用户的"只开 core"配置）⇒ /board 没有归属行 ⇒ 不注册 ⇒ 404
  const onlyCore = fakeCtx()
  apply(onlyCore.ctx, { row: 'core' })
  assert.equal(onlyCore.routes.includes('/tradewatcher/board'), false, '只开 core 时 /board 不注册 ⇒ 404')
  // 开 market（云图行仍关着）⇒ /board 由 market 提供；云图没有 host 路由，故与它无关
  const withMarket = fakeCtx()
  apply(withMarket.ctx, { row: 'core' })
  apply(withMarket.ctx, { row: 'market' })
  assert.equal(withMarket.routes.includes('/tradewatcher/board'), true, '开 market ⇒ /board 可用')
  const withCloudmapOnly = fakeCtx()
  apply(withCloudmapOnly.ctx, { row: 'core' })
  apply(withCloudmapOnly.ctx, { row: 'cloudmap' })
  assert.equal(withCloudmapOnly.routes.includes('/tradewatcher/board'), false,
    '只开云图行 ⇒ /board 仍不注册（云图页不再消费它）')
  // 云图行的路由前缀表本来就是空数组 ⇒ 关/开它都不影响第三方 iframe（纯客户端）
  assert.deepEqual(ROW_ROUTES_FOR_TEST.cloudmap, [], '云图行没有 host 路由（第三方 iframe 是纯客户端）')
  stopMonitor()
})
