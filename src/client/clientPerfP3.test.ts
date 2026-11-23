/**
 * AUDIT-CLIENT-PERF 客户端 P2 收尾批（P2-3 / P2-12 / P2-14 / P2-16 限定四处）的可检查判据。
 *
 * 方法沿用 `clientPerfP1/P2.test.ts`：**真源码 + 纯函数 + 反例注入**。
 * 源码断言只钉"接线"（组件确实把派生交给 memo / 确实调了守卫函数）；
 * 有真实后果的部分（读了多少条、排了几次、跨日跟不跟随）都做成可执行的行为断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { fillMarksOf, type FillInput, type FillMark } from './prismDeskMid.ts'
import { accountViewOf, sparkOf, statusFactsOf } from './prismDeskSide.ts'
import { shToday } from './marketTime.ts'
import { fmtFixed, fmtFixedPct } from './format.ts'
import { sharePctOf, sortRowsByShare } from './marketBlocks.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')
/** 去注释（源码断言只认活代码：注释里提到某个词不算接线） */
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const PRISM = strip(read('PrismPage.tsx'))
const CALENDAR = strip(read('CalendarPage.tsx'))
const MARKET = strip(read('MarketPage.tsx'))
const CHIPS = strip(read('ChipsPanel.tsx'))
const PORTFOLIO = strip(read('PortfolioPage.tsx'))
const RESCUE = strip(read('RescuePanel.tsx'))

function sliceBetween(src: string, from: string, to: string): string {
  const at = src.indexOf(from)
  if (at < 0) return ''
  const end = to === '' ? src.length : src.indexOf(to, at + from.length)
  return src.slice(at, end < 0 ? src.length : end)
}

/** React.useMemo 的依赖比较语义（Object.is，逐项）；只用于把"同输入引用不重算"做成行为断言 */
function createMemoCell(): { run: <T>(compute: () => T, deps: readonly unknown[]) => T; computes: () => number } {
  let deps: readonly unknown[] | null = null
  let value: unknown
  let computes = 0
  return {
    run<T>(compute: () => T, next: readonly unknown[]): T {
      const same = deps !== null && deps.length === next.length && deps.every((d, i) => Object.is(d, next[i]))
      if (!same) {
        deps = next
        value = compute()
        computes += 1
      }
      return value as T
    },
    computes: () => computes,
  }
}

// ══ P2-3 ① fillMarksOf：倒序取末 2 条，读取量不随 fills 长度增长 ═════════════

test('P2-3 fillMarksOf：只读末尾即停（20k 与 200k 读取次数相同；反例：全量 filter+sort 读满 N）', () => {
  const make = (n: number): FillInput[] => Array.from({ length: n }, (_, i) => ({
    at: 1_700_000_000_000 + i,
    side: i % 2 === 0 ? 'buy' : 'sell',
    shares: 100 + i,
    price: 10 + i / 1000,
    secid: i === n - 1 || i === n - 2 ? '1.600519' : '1.000001',
  }))
  /** 只数数字下标的读取次数：filter/sort 会读满，倒序扫描只读末尾几条 */
  const counted = (rows: FillInput[]): { reads: number; hit: FillMark[]; order: string[] } => {
    let reads = 0
    const proxy = new Proxy(rows, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) reads += 1
        return Reflect.get(target, prop, receiver)
      },
    })
    // 顺序故意让「末 2 条」前面夹一条别的标的：倒序扫描要跳过 1 条，仍然只读 3 条
    proxy[rows.length - 3] = { ...proxy[rows.length - 3], secid: '1.000002' }
    const hit = fillMarksOf(proxy, '1.600519')
    return { reads, hit, order: hit.map((m) => `${m.at}`) }
  }
  const small = counted(make(20_000))
  const big = counted(make(200_000))
  assert.equal(small.reads, 3, '末 3 条内凑齐 2 条 ⇒ 只读 3 条')
  assert.equal(big.reads, 3, 'fills 放大 10 倍，读取次数不变（不随长度线性增长）')
  assert.equal(big.hit.length, 2, '只取末 2 条')
  assert.deepEqual(big.order, [String(1_700_000_000_000 + 199_998), String(1_700_000_000_000 + 199_999)], '仍按时间正序展示（最近的排最后）')

  // 反例：旧实现 filter 全量 + sort 全量 ⇒ 读取次数 = N，且比较次数随 N log N 增长
  const legacyReads = (rows: FillInput[]): number => {
    let reads = 0
    const proxy = new Proxy(rows, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) reads += 1
        return Reflect.get(target, prop, receiver)
      },
    })
    const own = proxy.filter((f) => f.secid === '1.600519')
    own.sort((a, b) => a.at - b.at)
    return reads
  }
  assert.equal(legacyReads(make(20_000)), 20_000, '⚠ 反例（全量 filter）确实读满 N')
  assert.throws(() => assert.equal(legacyReads(make(20_000)), 3), /3/, '⚠ 反例注入：全量实现不可能只读 3 条')
})

test('P2-3 fillMarksOf：limit=0 / 无匹配 / 非法数值的既有语义不变', () => {
  const fills: FillInput[] = [
    { at: 3, side: 'buy', shares: 1, price: 10, secid: 'A' },
    { at: 4, side: 'sell', shares: 2, price: Number.NaN, secid: 'A' },
    { at: 5, side: 'buy', shares: 3, price: 11, secid: 'B' },
    { at: 6, side: 'sell', shares: 4, price: 12, secid: 'A' },
  ]
  assert.deepEqual(fillMarksOf(fills, 'A', 0), [], 'limit=0 ⇒ 不扫、不返回')
  assert.deepEqual(fillMarksOf(fills, 'C'), [], '没有该标的成交 ⇒ 空数组')
  const marks = fillMarksOf(fills, 'A')
  assert.equal(marks.length, 2, 'NaN price 的那笔被跳过，仍能取到 2 条有效记录')
  assert.deepEqual(marks.map((m) => m.at), [3, 6], '跳过非法记录后按时间正序')
})

// ══ P2-3 ② sparkOf / accountViewOf / statusFactsOf：useMemo 且依赖正确 ═══════

function prismMemoProblems(src: string): string[] {
  const bad: string[] = []
  const marks = sliceBetween(src, 'const marks =', 'const ai =')
  if (!marks.includes('React.useMemo(')) bad.push('marks 没有 useMemo')
  if (!marks.includes('[fills, picked]')) bad.push('marks 依赖不是 [fills, picked]')

  const spark = sliceBetween(src, 'const spark =', 'const [sparkRef')
  if (!spark.includes('React.useMemo(() => sparkOf(state?.state.equity ?? []), [state?.state.equity])')) {
    bad.push('spark 没有 useMemo([state?.state.equity])')
  }

  const acct = sliceBetween(src, 'const acctView =', 'const acctCard')
  if (!acct.includes('React.useMemo(() => accountViewOf({')) bad.push('acctView 没有 useMemo')
  if (!acct.includes('}), [state, capital])')) bad.push('acctView 依赖不是 [state, capital]')

  const status = sliceBetween(src, 'const statusFacts =', 'const statusItem')
  if (!status.includes('React.useMemo(() => statusFactsOf({')) bad.push('statusFacts 没有 useMemo')
  if (!status.includes('blockedTodayOf(')) bad.push('statusFacts 里没有 blockedTodayOf（可能被挪出 memo）')
  if (!status.includes('}), [state, settings, intervalSec, acct?.day])')) bad.push('statusFacts 依赖不完整')
  return bad
}

test('P2-3 接线：四处派生都在 useMemo 内且依赖逐项正确（反例：漏依赖必须被抓住）', () => {
  assert.deepEqual(prismMemoProblems(PRISM), [], '真源码必须零问题')
  const missingDep = PRISM.replace('[fills, picked]', '[fills]')
  assert.notEqual(missingDep, PRISM, '反例注入必须真改到源码')
  assert.notDeepEqual(prismMemoProblems(missingDep), [], '⚠ 反例（marks 漏 picked 依赖）必须被抓住')
  const noStatusMemo = PRISM.replace('const statusFacts = React.useMemo(() => statusFactsOf({', 'const statusFacts = statusFactsOf({')
  assert.notEqual(noStatusMemo, PRISM, '反例注入必须真改到源码')
  assert.notDeepEqual(prismMemoProblems(noStatusMemo), [], '⚠ 反例（statusFacts 退回每次渲染重算）必须被抓住')
})

test('P2-3 行为：同一份回包引用 ⇒ spark/account/status 只算 1 次；换引用 ⇒ 再算 1 次', () => {
  const equity = [{ day: '2026-11-20', equity: 100, realized: 0 }, { day: '2026-11-21', equity: 101, realized: 0 }]
  const state = { state: { equity, orders: [], runs: [], settings: { intervalSec: 600 }, account: { day: '2026-11-21', dayStartEquity: 100 } } }
  const desk = { overview: { totalAssets: 102, cash: 2, positionPct: 98 }, positions: { rows: [{ secid: 'A', name: 'A', qty: 1, cost: 1, marketValue: 100, pnl: 1 }] } }
  const settings = state.state.settings
  const acct = state.state.account

  const sparkCell = createMemoCell()
  const accountCell = createMemoCell()
  const statusCell = createMemoCell()
  let sparkRuns = 0
  let accountRuns = 0
  let statusRuns = 0
  const render = (s: typeof state): { spark: ReturnType<typeof sparkOf>; acct: ReturnType<typeof accountViewOf>; status: ReturnType<typeof statusFactsOf> } => ({
    spark: sparkCell.run(() => { sparkRuns += 1; return sparkOf(s.state.equity) }, [s.state.equity]),
    acct: accountCell.run(() => {
      accountRuns += 1
      return accountViewOf({
        totalAssets: desk.overview.totalAssets, capitalLimit: 100, dayStartEquity: acct.dayStartEquity,
        cash: desk.overview.cash, positionPct: desk.overview.positionPct, rows: desk.positions.rows, equity: s.state.equity, day: acct.day,
      })
    }, [s, 100]),
    status: statusCell.run(() => {
      statusRuns += 1
      return statusFactsOf({
        feed: null, model: null, modelProvider: null, temperature: null, times: settings.intervalSec === 600 ? [] : ['09:35'],
        intervalSec: settings.intervalSec, constraintVersion: null, blockedToday: null,
      })
    }, [s, settings, settings.intervalSec, acct.day]),
  })

  const first = render(state)
  const second = render(state)
  assert.equal(sparkRuns, 1, '同 equity 引用 ⇒ sparkOf 不重算')
  assert.equal(accountRuns, 1, '同 state 引用 ⇒ accountViewOf 不重算')
  assert.equal(statusRuns, 1, '同 state/settings 引用 ⇒ statusFactsOf/blockedTodayOf 不重算')
  assert.equal(first.spark, second.spark, 'memo 返回同一对象引用')
  assert.equal(first.acct, second.acct, 'memo 返回同一对象引用')
  assert.equal(first.status, second.status, 'memo 返回同一数组引用')

  const nextState = { state: { ...state.state, equity: [...equity], settings: { ...settings }, account: { ...acct } } }
  render(nextState)
  assert.equal(sparkRuns, 2, 'equity 换引用 ⇒ 必须重算')
  assert.equal(accountRuns, 2, 'state 换引用 ⇒ 必须重算')
  assert.equal(statusRuns, 2, 'state/settings 换引用 ⇒ 必须重算')

  // 反例：没有 memo 时同一输入渲染两次就计算两次
  let legacy = 0
  const legacyRender = (): void => { legacy += 1; sparkOf(equity) }
  legacyRender(); legacyRender()
  assert.equal(legacy, 2, '⚠ 反例（无 memo）确实重算 2 次')
  assert.throws(() => assert.equal(legacy, 1), /1/, '⚠ 反例注入：无 memo 不可能同输入只算 1 次')
})

// ══ P2-12 CalendarPage：跨零点「今天」跟随 60s 时钟 ═════════════════════════

function calendarTodayProblems(src: string): string[] {
  const bad: string[] = []
  const head = sliceBetween(src, 'export function CalendarPage(', 'const start = useMemo')
  if (!head.includes('const now = useNow(60_000)')) bad.push('没有 60s 时钟（useNow(60_000)）')
  if (!head.includes('const today = shToday(now)')) bad.push('today 不是由 now 派生')
  if (/const today = shToday\(\)/.test(head)) bad.push('today 仍被冻结在首次渲染')
  if (!sliceBetween(src, 'const upcoming = useMemo', 'const mutate').includes('[visible, today]')) bad.push('upcoming 未依赖 today')
  if (!src.includes('const isToday = c.date === today')) bad.push('is-today 没有用响应式 today')
  return bad
}

test('P2-12 接线：today = shToday(useNow(60_000))，upcoming / is-today 都吃它（反例：固定初值）', () => {
  assert.deepEqual(calendarTodayProblems(CALENDAR), [], '真源码必须零问题')
  const frozen = CALENDAR.replace('const now = useNow(60_000)\n  const today = shToday(now)', 'const today = shToday()')
  assert.notEqual(frozen, CALENDAR, '反例注入必须真改到源码')
  assert.notDeepEqual(calendarTodayProblems(frozen), [], '⚠ 反例（初值固定）必须被抓住')
  const noDep = CALENDAR.replace('[visible, today]', '[visible]')
  assert.notEqual(noDep, CALENDAR, '反例注入必须真改到源码')
  assert.notDeepEqual(calendarTodayProblems(noDep), [], '⚠ 反例（upcoming 漏 today 依赖）必须被抓住')
})

test('P2-12 行为：注入 now 23:59 → 次日 00:01，today / is-today / upcoming 跟随变化', () => {
  const d1 = Date.parse('2026-11-23T23:59:00+08:00')
  const d2 = Date.parse('2026-11-24T00:01:00+08:00')
  assert.equal(shToday(d1), '2026-11-23', '23:59 仍属 11-23')
  assert.equal(shToday(d2), '2026-11-24', '00:01 已属 11-24')
  const liveToday = (now: number): string => shToday(now)
  assert.notEqual(liveToday(d1), liveToday(d2), '60s 时钟下一拍 today 必须变化')

  const isToday = (date: string, now: number): boolean => date === shToday(now)
  assert.equal(isToday('2026-11-23', d1), true)
  assert.equal(isToday('2026-11-23', d2), false, '跨日后 11-23 不再高亮')
  assert.equal(isToday('2026-11-24', d2), true, '跨日后 11-24 变成今天')

  const events = [{ date: '2026-11-23' }, { date: '2026-11-24' }, { date: '2026-11-25' }]
  const upcoming = (now: number): string[] => events.filter((e) => e.date >= shToday(now)).map((e) => e.date)
  assert.deepEqual(upcoming(d1), ['2026-11-23', '2026-11-24', '2026-11-25'])
  assert.deepEqual(upcoming(d2), ['2026-11-24', '2026-11-25'], '「即将到来」跨日后不再包含昨天')

  // 反例：初值固定（旧实现）⇒ 00:01 仍看到 11-23
  let frozen: string | null = null
  const frozenToday = (now: number): string => (frozen ??= shToday(now))
  assert.equal(frozenToday(d1), '2026-11-23')
  assert.equal(frozenToday(d2), '2026-11-23', '⚠ 反例（初值固定）确实停在昨天')
  assert.throws(() => assert.notEqual(frozenToday(d2), '2026-11-23'), '⚠ 反例注入：固定初值必须被抓住')
})

// ══ P2-14 MarketPage.viewRows：useMemo([rows,moneySort,sort,scope]) + key=r.code ══

function marketViewProblems(src: string): string[] {
  const bad: string[] = []
  const body = sliceBetween(src, 'const viewRows =', 'const [pick')
  if (!body.includes('useMemo(')) bad.push('viewRows 没有 useMemo')
  if (!body.includes('[rows, moneySort, sort, scope]')) bad.push('viewRows 依赖不完整')
  if (!body.includes('sortRowsByShare(rows)')) bad.push('viewRows 没有走纯排序函数')
  if (/\[\.\.\.rows\]\.sort/.test(body)) bad.push('render 体里仍有 [...rows].sort')
  if (!src.includes('key: r.code')) bad.push('表格行 key 不是 r.code')
  if (/key: `\$\{r\.code\}-\$\{i\}`/.test(src)) bad.push('表格行 key 仍含索引 i')
  return bad
}

test('P2-14 接线：viewRows 进 useMemo 且 key 用 r.code（反例：漏 scope 依赖 / key 带索引）', () => {
  assert.deepEqual(marketViewProblems(MARKET), [], '真源码必须零问题')
  assert.equal(MARKET.includes('key: r.code'), true, 'key 已是 r.code（确认）')
  assert.equal(MARKET.includes('key: `${r.code}-${i}`'), false, '不存在带索引的旧 key')
  const missingScope = MARKET.replace('[rows, moneySort, sort, scope]', '[rows, moneySort, sort]')
  assert.notEqual(missingScope, MARKET, '反例注入必须真改到源码')
  assert.notDeepEqual(marketViewProblems(missingScope), [], '⚠ 反例（漏 scope 依赖）必须被抓住')
  const badKey = MARKET.replace('key: r.code,', 'key: `${r.code}-${i}`,')
  assert.notEqual(badKey, MARKET, '反例注入必须真改到源码')
  assert.notDeepEqual(marketViewProblems(badKey), [], '⚠ 反例（key 带索引）必须被抓住')
})

/** 在回调里临时替换 Array.prototype.sort，统计「排了几次 / 比较器叫了几次」 */
function withSortCounter<T>(fn: () => T): { value: T; sorts: number; comparisons: number } {
  const orig = Array.prototype.sort
  let sorts = 0
  let comparisons = 0
  Array.prototype.sort = function (compareFn?: (a: unknown, b: unknown) => number): unknown[] {
    sorts += 1
    if (typeof compareFn === 'function') {
      return orig.call(this, (a: unknown, b: unknown) => { comparisons += 1; return compareFn(a, b) })
    }
    return orig.call(this)
  } as typeof Array.prototype.sort
  try {
    return { value: fn(), sorts, comparisons }
  } finally {
    Array.prototype.sort = orig
  }
}

test('P2-14 行为：同一份 rows 不重复排序（比较器 0 次；反例：裸 render 体排 2 次）', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    code: `BK${i}`, name: `板块${i}`, pct: i, chg: i, price: null, up: null, down: null, leader: null,
    leaderPct: null, money: (i % 7 === 0 ? null : 1_000_000 - i * 10_000), vol: null, amount: 10_000_000,
  }))
  const cell = createMemoCell()
  const first = withSortCounter(() => cell.run(() => sortRowsByShare(rows), [rows, 'share', 'money', 'industry']))
  assert.equal(first.sorts, 1, '首次渲染排 1 次')
  assert.ok(first.comparisons > 0, '首次渲染比较器确实被调用')
  const sorted = first.value
  assert.equal(sorted.length, 40)
  assert.deepEqual(sorted.map((r) => r.code).slice(0, 2), ['BK1', 'BK2'], '按净占比降序（同额时金额小的占比高）')
  assert.equal(sorted[sorted.length - 1].money, null, '缺失净额的行沉底')

  const second = withSortCounter(() => cell.run(() => sortRowsByShare(rows), [rows, 'share', 'money', 'industry']))
  assert.equal(second.sorts, 0, '同 rows / 同口径 ⇒ 不再排序')
  assert.equal(second.comparisons, 0, '同 rows / 同口径 ⇒ 比较器 0 次调用')
  assert.equal(second.value, sorted, '同输入返回同一数组引用')

  const changed = withSortCounter(() => cell.run(() => sortRowsByShare([...rows]), [[...rows], 'share', 'money', 'industry']))
  assert.equal(changed.sorts, 1, 'rows 换引用 ⇒ 必须重排 1 次')

  const naive = withSortCounter(() => { sortRowsByShare(rows); sortRowsByShare(rows) })
  assert.equal(naive.sorts, 2, '⚠ 反例（无 memo，render 体直接排）确实排 2 次')
  assert.throws(() => assert.equal(naive.sorts, 0), /0/, '⚠ 反例注入：无 memo 不可能 0 次排序')
})

test('P2-14 排序语义：NaN/Infinity 占比不参与排序、不污染结果', () => {
  assert.equal(sharePctOf({ money: Number.NaN, amount: 100 }), null, 'NaN 净额 ⇒ null')
  assert.equal(sharePctOf({ money: 100, amount: Number.POSITIVE_INFINITY }), null, 'Infinity 成交额 ⇒ null')
  assert.equal(sharePctOf({ money: 100, amount: 0 }), null, '成交额 0 ⇒ null（不拿 0 顶替）')
  assert.equal(sharePctOf({ money: 50, amount: 100 }), 50, '正常值算 50%')
})

// ══ P2-16（限定四处）：NaN / Infinity ⇒ —，裸 toFixed 反例必须被抓住 ═══════

test('P2-16 数值出口：fmtFixed / fmtFixedPct 对 NaN、±Infinity、null 一律 —（反例：裸 toFixed 输出 NaN）', () => {
  for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(fmtFixed(v), '—', `${String(v)} 不得落屏`)
    assert.equal(fmtFixedPct(v), '—', `${String(v)} 不得落屏（百分比）`)
  }
  assert.equal(fmtFixed(null), '—')
  assert.equal(fmtFixed(undefined), '—')
  assert.equal(fmtFixedPct(null), '—')
  assert.equal(fmtFixed(1.234), '1.23', '有限值照常两位小数')
  assert.equal(fmtFixedPct(1.234), '1.23%', '有限值照常百分比')
  // 反例：裸 toFixed
  assert.equal((Number.NaN).toFixed(2), 'NaN', '⚠ 反例（裸 toFixed）确实是 NaN')
  assert.equal((Number.POSITIVE_INFINITY).toFixed(2), 'Infinity', '⚠ 反例（裸 toFixed）确实是 Infinity')
  assert.throws(() => assert.equal((Number.NaN).toFixed(2), '—'), /—/, '⚠ 反例注入：裸 toFixed 不可能输出 —')
})

function toFixedGuardProblems(src: { market: string; chips: string; portfolio: string; rescue: string }): string[] {
  const bad: string[] = []
  if (!src.market.includes('fmtFixedPct(r.turnover)')) bad.push('MarketPage 换手率未走 fmtFixedPct')
  if (src.market.includes('r.turnover.toFixed(')) bad.push('MarketPage 换手率仍有裸 toFixed')
  if (!src.chips.includes('const money = (v: number | null): string => fmtFixed(v)')) bad.push('ChipsPanel money 未走 fmtFixed')
  if (!src.chips.includes("(v === null ? '未取到' : fmtFixedPct(v))")) bad.push('ChipsPanel pct 未走 fmtFixedPct')
  if (src.chips.includes('v.toFixed(2)')) bad.push('ChipsPanel 仍有裸 toFixed')
  if (!src.portfolio.includes("fmtFixedPct(props.weight * 100)")) bad.push('PortfolioPage 占比未走 fmtFixedPct')
  if (src.portfolio.includes("(props.weight * 100).toFixed(")) bad.push('PortfolioPage 占比仍有裸 toFixed')
  const threshold = sliceBetween(src.rescue, 'function ThresholdBar(', 'function ScoreBar(')
  if (!threshold.includes('Number.isFinite(props.value)')) bad.push('RescuePanel 量能 title 没有 Number.isFinite 守卫')
  if (!threshold.includes('const volText =')) bad.push('RescuePanel 量能 title 没有单独的 volText')
  if (threshold.includes("${props.value.toFixed(2)}x`}")) bad.push('RescuePanel 量能 title 仍在插值里裸 toFixed')
  return bad
}

test('P2-16 接线：四处裸 toFixed 都换成有限性守卫（反例：任一处退回裸写法必须被抓住）', () => {
  assert.deepEqual(toFixedGuardProblems({ market: MARKET, chips: CHIPS, portfolio: PORTFOLIO, rescue: RESCUE }), [], '真源码必须零问题')
  const marketBad = { market: MARKET.replace('fmtFixedPct(r.turnover)', 'r.turnover.toFixed(2) + "%"'), chips: CHIPS, portfolio: PORTFOLIO, rescue: RESCUE }
  assert.notEqual(marketBad.market, MARKET, '反例注入必须真改到源码')
  assert.notDeepEqual(toFixedGuardProblems(marketBad), [], '⚠ 反例（MarketPage 退回裸 toFixed）必须被抓住')
  const chipsBad = { market: MARKET, chips: CHIPS.replace("const money = (v: number | null): string => fmtFixed(v)", "const money = (v: number | null): string => (v === null ? '—' : v.toFixed(2))"), portfolio: PORTFOLIO, rescue: RESCUE }
  assert.notEqual(chipsBad.chips, CHIPS, '反例注入必须真改到源码')
  assert.notDeepEqual(toFixedGuardProblems(chipsBad), [], '⚠ 反例（ChipsPanel 退回裸 toFixed）必须被抓住')
  const portfolioBad = { market: MARKET, chips: CHIPS, portfolio: PORTFOLIO.replace("fmtFixedPct(props.weight * 100)", "(props.weight * 100).toFixed(2) + '%'"), rescue: RESCUE }
  assert.notEqual(portfolioBad.portfolio, PORTFOLIO, '反例注入必须真改到源码')
  assert.notDeepEqual(toFixedGuardProblems(portfolioBad), [], '⚠ 反例（PortfolioPage 退回裸 toFixed）必须被抓住')
  const rescueBad = { market: MARKET, chips: CHIPS, portfolio: PORTFOLIO, rescue: RESCUE.replace('const volText = typeof props.value === \'number\' && Number.isFinite(props.value)\n    ? `${props.value.toFixed(2)}x`\n    : props.value === null ? \'未取到\' : \'—\'', '') }
  assert.notDeepEqual(toFixedGuardProblems(rescueBad), [], '⚠ 反例（RescuePanel 去掉守卫）必须被抓住')
})
