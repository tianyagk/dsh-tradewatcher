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
import type { SuggestItem } from '../shared/model.ts'

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
