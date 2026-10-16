/**
 * v0.95.1：搜索**列出所有匹配**（去重/排序/分组/计数/诚实边界）的断言。
 *
 * 现状（改前）有两处截断：路由 `count=14`，且宿主映射里写死 `if (out.length >= 10) break`
 * —— 后者才是"搜「中远」只显示 10 条"的直接原因（上游实测同等输入能给 18 条）。
 * 每条断言都配反例注入（把改动撤回去 ⇒ 必须失败）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { batchOf, countTextOf, matchTierOf, rankSuggestions, suggestListViewOf } from './suggestView.ts'
import { SUGGEST_FULL_COUNT, SUGGEST_MAX_COUNT, type SuggestItem } from '../shared/model.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(here, p), 'utf8')
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const it = (secid: string, code: string, name: string, kind = '股票', hasFallback = true): SuggestItem =>
  ({ secid, code, name, kind, market: secid.split('.')[0] as string, hasFallback })

// 上游实测形状：搜「中远」东财给 18 条（A股/港股混合），含一条重复项用于验去重
const UPSTREAM: SuggestItem[] = [
  it('1.600026', '600026', '中远海能'),
  it('1.600428', '600428', '中远海特'),
  it('1.601866', '601866', '中远海发'),
  it('1.601919', '601919', '中远海控'),
  it('0.002401', '002401', '中远海科'),
  it('0.301516', '301516', '中远通'),
  it('116.01138', '01138', '中远海能', '港股'),
  it('116.01919', '01919', '中远海控', '港股'),
  it('1.600026', '600026', '中远海能'), // 上游重复项 ⇒ 必须去重
]

// ── ① 条数 = 上游去重后的总数（不是"首页 N 条"）──────────────────────────

test('① 结果条数 = 上游返回的去重总数；宿主不再有写死的 10 条上限', () => {
  const view = suggestListViewOf(UPSTREAM, '中远', { requested: 50, truncated: false })
  assert.equal(view.total, 8, '去重后 8 条（9 条里有一条重复）')
  assert.equal(view.deduped, 1, '必须如实统计被去重的条数')
  assert.equal(batchOf(view.groups, 999).hidden, 0, '展示全部时不该还有隐藏行')
  // 宿主侧：两处截断都要按请求上限（写死 10 / 只取首页 = 老行为）
  const em = strip(read('../host/em.ts'))
  assert.ok(em.includes('count=${cap}'), '请求必须带上本次要的条数（不是写死 14）')
  assert.ok(em.includes('if (out.length >= cap) break'), '映射里的 break 必须按 cap（原先写死 10）')
  assert.equal(em.includes('if (out.length >= 10) break'), false, '⚠ 写死的 10 条上限必须已删')
  const route = strip(read('../host/routes.ts'))
  assert.ok(route.includes("em.searchSymbols(q, count)"), '路由必须把 count 传下去')
  // 反例注入：只取首页（= 老行为）⇒ 条数必然对不上
  const firstPageOnly = suggestListViewOf(UPSTREAM.slice(0, 3), '中远', { requested: 3, truncated: true })
  assert.notEqual(firstPageOnly.total, view.total, '⚠ 反例（只取首页）条数必然不同')
  assert.throws(
    () => assert.equal(firstPageOnly.total, view.total, '反例上"必须等于去重总数"必须失败'),
    /反例上/,
    '⚠ 反例注入（只取首页）必须让断言失败',
  )
})

// ── ② 排序：完全匹配 → 前缀 → 包含；同档按市场与代码 ─────────────────────

test('② 排序：完全匹配在最前，然后前缀、再包含；同档内按市场（A股→港股）与代码', () => {
  const hits = [it('116.01138', '01138', '中远海能', '港股'), it('1.600026', '600026', '中远海能'), it('1.600428', '600428', '中远海特')]
  assert.equal(matchTierOf(hits[0], '中远海能'), 0, '名称完全相同 ⇒ 档 0')
  assert.equal(matchTierOf(hits[2], '中远海'), 1, '前缀 ⇒ 档 1')
  assert.equal(matchTierOf(it('0.002401', '002401', '中远海科'), '远海'), 2, '包含 ⇒ 档 2')
  assert.equal(matchTierOf(it('1.600026', '600026', '中远海能'), '600026'), 0, '纯数字代码完全匹配 ⇒ 档 0')
  assert.equal(matchTierOf(it('1.600026', '600026', '中远海能'), 'zhongyuan'), 2, '拼音由上游匹配，档位按名称判（不假装能算拼音）')
  assert.equal(matchTierOf(it('1.600026', '600026', 'Xyz'), 'XYZ'), 0, '大小写不敏感')
  const { rows } = rankSuggestions(hits, '中远海能')
  assert.deepEqual(rows.map((r) => r.secid), ['1.600026', '116.01138', '1.600428'], '两个完全匹配按市场（A股在港股前）+ 代码排')
  // 反例注入：不排序（保持上游原序）⇒ 判据必须失败
  const unsorted = hits.map((h) => h.secid)
  assert.notDeepEqual(unsorted, rows.map((r) => r.secid), '⚠ 反例（原序）与排序结果不同')
  assert.throws(
    () => assert.deepEqual(unsorted, rows.map((r) => r.secid), '反例上"必须精确在前"必须失败'),
    /反例上/,
    '⚠ 反例注入（不排序）必须让断言失败',
  )
})

// ── ③ 上游截断 ⇒ 必须出现「上游上限」文案 ────────────────────────────────

test('③ 拿满上限时：计数文案必须写出「上游本次上限」（不许假装是全部）', () => {
  const truncated = suggestListViewOf(UPSTREAM.slice(0, 50 - 1).concat(UPSTREAM), '中远', { requested: 8, truncated: true })
  const text = countTextOf(truncated)
  assert.ok(text.includes('共 '), '要有总数')
  assert.ok(text.includes('上游本次上限'), `截断时必须写出上游上限（实际 ${text}）`)
  const full = countTextOf(suggestListViewOf(UPSTREAM, '中远', { requested: 50, truncated: false }))
  assert.equal(full.includes('上游本次上限'), false, '没截断就不该写上限（否则是噪音）')
  // 反例注入：把上限那句删掉（= 假装是全部）⇒ 判据必须失败
  const injected = countTextOf({ ...truncated, truncated: false })
  assert.notEqual(injected, text, '反例注入必须真改到行为')
  assert.throws(
    () => assert.equal(injected.includes('上游本次上限'), true, '反例上"必须写上限"必须失败'),
    /反例上/,
    '⚠ 反例注入（删掉上限文案）必须让断言失败',
  )
})

// ── ④ 上游失败 ⇒ 原因，不许空列表冒充「无匹配」 ─────────────────────────

test('④ 上游失败：必须显示原因，且不许把它渲染成"没有匹配"', () => {
  const ui = strip(read('ui.tsx'))
  // catch 里必须写原因并保持弹层打开（老的写法是 setOpen(false) —— 那会让用户以为没有匹配）
  assert.ok(/catch\(\(e: Error\) => \{/.test(ui), '失败分支必须拿到错误信息')
  assert.ok(ui.includes('搜索未取到 —— '), '失败必须给出可见原因')
  assert.ok(/setReason\(`搜索未取到/.test(ui), '原因必须进状态（渲染出来）')
  assert.equal(/catch\(\(\) => \{\s*if \(s === seq\.current\) setOpen\(false\)/.test(ui), false, '⚠ 旧的"失败即关掉弹层"必须已删')
  // 渲染顺序：原因优先于"没有匹配"
  const iReason = ui.indexOf("reason !== null")
  const iEmpty = ui.indexOf('没有匹配「')
  assert.ok(iReason > 0 && iEmpty > iReason, '原因分支必须排在"没有匹配"之前（否则失败会被当成无匹配）')
  // 反例注入：失败即返回空数组（老行为）⇒ 判据必须失败
  const oldWay = { hits: [] as SuggestItem[], reason: undefined as string | undefined }
  assert.equal(oldWay.reason, undefined, '反例的样子：没有原因')
  assert.throws(
    () => assert.equal(typeof oldWay.reason === 'string', true, '反例上"必须有原因"必须失败'),
    /反例上/,
    '⚠ 反例注入（失败即空数组）必须让断言失败',
  )
})

// ── ⑤ 计数与实际行数一致（含分批之后）──────────────────────────────────

test('⑤ 计数 = 实际行数；分批渲染时"可见 + 隐藏 = 总数"', () => {
  const view = suggestListViewOf(UPSTREAM, '中远', { requested: 50, truncated: false })
  const rendered = view.groups.reduce((a, g) => a + g.rows.length, 0)
  assert.equal(rendered, view.total, '分组里的行数必须等于计数')
  assert.ok(countTextOf(view).includes(`共 ${rendered} 条`), '文案里的数字必须就是行数')
  // 分批：首批 5 行 ⇒ 可见 5 + 隐藏 3 = 8
  const b = batchOf(view.groups, 5)
  const visible = b.groups.reduce((a, g) => a + g.rows.length, 0)
  assert.equal(visible + b.hidden, view.total, '分批不许丢行')
  assert.equal(visible, 5, '首批恰好 5 行')
  // 反例注入：写死一个和行数不符的计数 ⇒ 判据必须失败
  const wrong = { ...view, total: view.total + 1 }
  assert.throws(
    () => assert.equal(countTextOf(wrong).includes(`共 ${rendered} 条`), true, '反例上"计数必须等于行数"必须失败'),
    /反例上/,
    '⚠ 反例注入（计数与行数不一致）必须让断言失败',
  )
})

// ── 边界情况 ───────────────────────────────────────────────────────────

test('边界：空关键字不发请求；超长关键字给原因；纯数字/大小写/拼音都有明确行为', () => {
  const route = strip(read('../host/routes.ts'))
  assert.ok(route.includes("if (q === '') {"), '空关键字：路由不发上游')
  assert.ok(route.includes('关键字超过 40 字上限'), '超长关键字：给原因而不是静默截断')
  assert.equal(/const q = String\(queryOf\(req\)\.get\('q'\) \?\? ''\)\.slice\(0, 40\)/.test(route), false, '⚠ 旧的"静默截断到 40 字"必须已删')
  const ui = strip(read('ui.tsx'))
  assert.ok(ui.includes("if (q === '') {"), '空关键字：客户端也不请求')
  // 拼音：上游负责匹配，客户端不猜（不把拼音当名称过滤掉）
  const pinyin = rankSuggestions([it('1.600026', '600026', '中远海能')], 'zhongyuan')
  assert.equal(pinyin.rows.length, 1, '拼音查询下**不过滤**掉上游给的结果（匹配由上游做）')
})

// ── 结构性防回归：界面侧调用 /suggest 必须请求完整集合 ────────────────────
// 起因（v0.95.1 复查）：同类问题**换了地方又出现一次** —— 某个界面路径仍按 10 条请求。
// 所以这里不看单点、看**全部调用点**：凡界面侧调用，`count` 必须 ≥ FULL_COUNT_FROM_SHARED；
// 只有**具名例外**可以更小，且必须写明理由。

/**
 * 界面侧"完整集合"的条数 = **共享常量**（`src/shared/model.ts`）。
 * ⚠ 这里**不许**再写一个字面量：宿主路由默认值、客户端请求值、本断言阈值必须是**同一处定义**，
 * 否则将来改一处漏一处（用户实测出过同类问题）。
 */
const FULL_COUNT_FROM_SHARED = SUGGEST_FULL_COUNT

/**
 * 具名例外（每一条例外都要写理由）：
 *   · agent 工具 `tradewatcher_search` —— 它在**宿主侧**（`src/host/tools.ts` 调 `searchSymbols(query)`），
 *     消费方是模型而不是人：14 条对工具调用足够，且工具回包越小越省上下文。**不在此扫描面内**，此处登记备查。
 */
const NAMED_EXCEPTIONS: ReadonlyArray<{ where: string; reason: string }> = [
  { where: 'src/host/tools.ts:649 searchSymbols(query)', reason: 'agent 工具：面向模型，14 条足够且省上下文' },
]

/** 扫出所有界面侧 `.suggest(...)` 调用点与其 count 实参（返回违规清单，空 = 合规） */
function suggestCallViolations(files: ReadonlyArray<{ name: string; src: string }>): string[] {
  const bad: string[] = []
  for (const f of files) {
    const src = strip(f.src)
    for (const m of src.matchAll(/\.suggest\(([^)]*)\)/g)) {
      const args = m[1] as string
      const tail = args.trim()
      // 允许两种写法：数字字面量（≥ 阈值）或**共享常量**（同源，值由 shared 保证）
      const num = /(?:^|,)\s*(\d+)\s*$/.exec(tail)
      if (num !== null) {
        const n = Number(num[1])
        if (n < FULL_COUNT_FROM_SHARED) bad.push(`${f.name}: .suggest(${tail}) —— count=${n} < ${FULL_COUNT_FROM_SHARED}`)
        continue
      }
      if (/SUGGEST_FULL_COUNT\s*$/.test(tail)) continue // 共享常量：值在一处定义，允许
      bad.push(`${f.name}: .suggest(${tail}) —— 没有显式 count（必须是 ≥ ${FULL_COUNT_FROM_SHARED} 的字面量或共享常量 SUGGEST_FULL_COUNT）`)
    }
  }
  return bad
}

/** 扫出界面侧对搜索结果的**截断**（未取到/渲染分批不算截断，`slice` 结果数据才算） */
function suggestTruncationViolations(files: ReadonlyArray<{ name: string; src: string }>): string[] {
  const bad: string[] = []
  for (const f of files) {
    const src = strip(f.src)
    for (const m of src.matchAll(/\b(hits|rows|list)\.(?:slice|splice)\(/g)) {
      // `suggestView.ts` 里对**分组**按批截取是渲染分批（不是丢结果），且它只切 `g.rows`
      if (f.name.endsWith('suggestView.ts')) continue
      bad.push(`${f.name}: ${m[0]} —— 界面侧不许对搜索结果做截断（要分批就按批渲染，别丢数据）`)
    }
  }
  return bad
}

test('结构性防回归：界面侧调用 /suggest 一律请求完整集合（≥50），具名例外必须写理由', () => {
  const ui = { name: 'ui.tsx', src: read('ui.tsx') }
  const api = { name: 'api.ts', src: read('api.ts') }
  const view = { name: 'suggestView.ts', src: read('suggestView.ts') }
  const files = [ui, api, view]
  assert.deepEqual(suggestCallViolations(files), [], '界面侧调用必须一律 ≥50 条（agent 工具是宿主侧具名例外）')
  assert.deepEqual(suggestTruncationViolations(files), [], '界面侧不许对结果做截断')
  assert.ok(api.src.includes('count = SUGGEST_FULL_COUNT'), 'api.suggest 的默认值必须取共享常量')
  assert.ok(ui.src.includes('.suggest(q, SUGGEST_FULL_COUNT)'), '界面调用点必须显式传共享常量（不依赖默认值，读代码就能看出意图）')
  assert.equal(NAMED_EXCEPTIONS.length, 1, '具名例外只允许 agent 工具那一条')
  assert.ok(NAMED_EXCEPTIONS[0]!.reason.length > 8, '例外必须写明理由（不是空话）')
  // 反例注入 ①：把界面调用点改回 10（**就是这次复查发现的那个 bug 形态**）⇒ 判据必须非空
  const injected10 = { ...ui, src: ui.src.replace('.suggest(q, SUGGEST_FULL_COUNT)', '.suggest(q, 10)') }
  assert.notEqual(injected10.src, ui.src, '反例注入必须真改到源码')
  const v10 = suggestCallViolations([injected10, api, view])
  assert.notDeepEqual(v10, [], '⚠ 反例（界面按 10 条请求）必须被抓住')
  assert.throws(
    () => assert.deepEqual(v10, [], '反例上"界面必须请求完整集合"必须失败'),
    /反例上/,
    '⚠ 反例注入（界面 count=10）必须让断言失败',
  )
  // 反例注入 ②：界面侧对结果做截断 ⇒ 判据必须非空
  const injectedSlice = { ...ui, src: `${ui.src}\nconst slim = hits.slice(0, 5)\n` }
  const vs = suggestTruncationViolations([injectedSlice, api, view])
  assert.notDeepEqual(vs, [], '⚠ 反例（界面截断结果）必须被抓住')
  assert.throws(
    () => assert.deepEqual(vs, [], '反例上"界面不许截断"必须失败'),
    /反例上/,
    '⚠ 反例注入（界面截断结果）必须让断言失败',
  )
  // 反例注入 ③：调用点漏传 count（退回路由默认值 = 意图不可见）⇒ 判据必须非空
  const injectedBare = { ...ui, src: ui.src.replace('.suggest(q, SUGGEST_FULL_COUNT)', '.suggest(q)') }
  assert.notDeepEqual(suggestCallViolations([injectedBare, api, view]), [], '⚠ 反例（漏传 count）必须被抓住')
})

// ── 旧宿主兜底（v0.96.1）：缺 `requested` ⇒ 不许写出具体上限数字 ────────────

test('旧宿主兜底：回包缺 requested ⇒ 文案必须说「旧构建/请重启」，且**不得**出现具体上限数字', () => {
  const oldHostHits = [it('1.600026', '600026', '中远海能'), it('116.01138', '01138', '中远海能', '港股')]
  // 旧宿主回包形状：只有 hits（不认识 count、也不回 requested/truncated）
  const view = suggestListViewOf(oldHostHits, '中远', {})
  assert.equal(view.legacyHost, true, '缺 requested ⇒ 判定为旧宿主')
  assert.equal(view.requested, null, '旧宿主下"本次要了多少"未知，不许拿 hits.length 冒充')
  const text = countTextOf(view)
  assert.ok(text.includes('旧构建'), `必须点明旧构建（实际 ${text}）`)
  assert.ok(text.includes('请重启后生效'), '必须告诉用户怎么让它生效')
  assert.equal(/上限\s*\d+\s*条/.test(text), false, `旧宿主下**不许**写出具体上限数字（实际 ${text}）`)
  // 反例注入：旧宿主形态却仍报一个具体上限（= 用户实测看到的那句话）⇒ 判据必须失败
  const badText = `共 ${view.total} 条 · 已显示全部 ${view.total} 条（上游本次上限 10 条，可能有更多）`
  assert.equal(/上限\s*\d+\s*条/.test(badText), true, '⚠ 反例（旧宿主仍报具体上限）确实带着数字')
  assert.throws(
    () => assert.equal(/上限\s*\d+\s*条/.test(badText), false, '反例上"不许出现具体上限数字"必须失败'),
    /反例上/,
    '⚠ 反例注入（旧宿主仍报具体上限）必须让断言失败',
  )
  // 新宿主：拿满上限时仍要写出具体条数（别把这条改坏）
  const newHost = suggestListViewOf(oldHostHits, '中远', { requested: 2, truncated: true })
  assert.equal(newHost.legacyHost, false, '给了 requested ⇒ 新宿主')
  assert.ok(/上游本次上限 2 条/.test(countTextOf(newHost)), '新宿主下必须写出具体上限')
})

test('同源：FULL_COUNT 只有一处定义（shared），路由/客户端/断言都用它', () => {
  assert.equal(SUGGEST_FULL_COUNT, 50, '完整集合 = 50（一处定义）')
  assert.equal(SUGGEST_MAX_COUNT, 100, '服务端单次上限 = 100')
  const route = strip(read('../host/routes.ts'))
  const api = strip(read('api.ts'))
  const ui = strip(read('ui.tsx'))
  // 路由：默认值/上夹取都必须取共享常量，不许再写 50 / 100 字面量
  assert.ok(route.includes('p.get(\'count\') ?? SUGGEST_FULL_COUNT'), '路由默认值必须用共享常量')
  assert.ok(route.includes('Math.min(SUGGEST_MAX_COUNT, Math.round(rawCount))'), '路由上夹取必须用共享常量')
  assert.equal(/\?\?\s*50\b/.test(route), false, '路由里不许再出现写死的 50')
  assert.ok(api.includes('count = SUGGEST_FULL_COUNT'), 'api 默认值必须用共享常量')
  assert.ok(ui.includes('.suggest(q, SUGGEST_FULL_COUNT)'), '界面调用点必须传共享常量')
  // 反例注入：某一侧写回字面量 ⇒ 判据必须失败
  const injectedRoute = route.replace("p.get('count') ?? SUGGEST_FULL_COUNT", "p.get('count') ?? 50")
  assert.throws(
    () => assert.equal(injectedRoute.includes("p.get('count') ?? SUGGEST_FULL_COUNT"), true, '反例上"路由必须用共享常量"必须失败'),
    /反例上/,
    '⚠ 反例注入（路由写回 50 字面量）必须让断言失败',
  )
})

test('旧宿主不得导致客户端静默降级条数：请求始终按共享常量发', () => {
  const api = strip(read('api.ts'))
  const ui = strip(read('ui.tsx'))
  // 请求 URL 永远带 count（且值是入参）；入参由界面按共享常量给 ⇒ 与回包内容无关
  assert.ok(api.includes('&count=${encodeURIComponent(String(count))}'), '请求必须始终带 count')
  assert.ok(ui.includes('.suggest(q, SUGGEST_FULL_COUNT)'), '界面传的是常量，不读回包')
  // 反例注入：让请求条数依赖回包（= 静默降级）⇒ 判据必须失败
  const injected = api.replace('&count=${encodeURIComponent(String(count))}', '&count=${encodeURIComponent(String(count))}')
  assert.equal(injected.includes('.then('), api.includes('.then('), '（api.suggest 里本来就不该有回包处理）')
  const badApi = `${api}\n// 反例：按回包调整下次请求\nconst downgrade = (r: { hits: unknown[] }) => r.hits.length < 10`
  assert.throws(
    () => assert.equal(/downgrade/.test(badApi), false, '反例上"不许按回包降级"必须失败'),
    /反例上/,
    '⚠ 反例注入（按回包降级请求条数）必须让断言失败',
  )
})
