/**
 * REVIEW-7-HOST D1–D5 的回归断言（`docs/AUDIT-IMPL72.md`）。
 *
 * 这五条的共同点是：**775 条全绿时它们全都没被锁住**（评审把建议修法逐字注入后测试仍全绿）。
 * 所以本文件的判据不是"实现现在返回什么"，而是"**实现退回到旧行为时必须红**"——
 * 每一组都同时喂**旧行为的输入**，要求判据给出 false。
 *
 * 上游一律打桩（`globalThis.fetch`），断言不依赖真实网络。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DayBar } from '../shared/model.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'host')

/** 隔离：`/chips` 会读盘上缓存与 LKG ⇒ 必须在任何路由调用之前钉住 HOME */
const HOME = mkdtempSync(join(tmpdir(), 'tw-fix7-home-'))
process.env.DSH_HOME = HOME
if (!HOME.startsWith('/tmp')) throw new Error(`拒绝运行：DSH_HOME 必须在 /tmp 下（收到 ${HOME}）`)

import { alignVolUnitWithQuote, VOL_UNIT_FACTOR } from './klineUnits.ts'
import { parseSinaUsDaily } from './sina.ts'
import { __resetRobotsCache } from './robotsGate.ts'
import { HEARTBEAT_HUNG_FACTOR, staleReason, type LockSnapshot } from './lock.ts'
import { aggregateUsDaily } from './usAggregate.ts'
import { DataStore } from './store.ts'
import { CalendarStore } from './calendar.ts'
import { makeTradeRoutes } from './routes.ts'
import * as extras from './marketExtras.ts'
import { breakerFor } from './breaker.ts'

const days = (n: number, from = 1): string[] => Array.from({ length: n }, (_, i) => `2026-03-${String(from + i).padStart(2, '0')}`)

// ─────────────────────────── 打桩 ─────────────────────────────────────────

const realFetch = globalThis.fetch

function restoreNet(): void {
  globalThis.fetch = realFetch
}

/** 一个假装"东财可达、腾讯不可达"的上游（只覆盖本文件用到的两条 URL） */
function stubEm(fields: Record<string, unknown>): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(typeof input === 'string' ? input : ((input as { url?: string })?.url ?? ''))
    if (/eastmoney\.com/.test(url)) {
      if (url.includes('/robots.txt')) return new Response('', { status: 404 })
      return new Response(JSON.stringify({ data: { diff: [fields] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new TypeError('fetch failed') // 腾讯/新浪一律不可达 ⇒ 走东财兜底
  }) as typeof fetch
}

// ─────────────────────────── D1 ───────────────────────────────────────────

const bar = (date: string, vol: number | null, close = 50) =>
  ({ date, open: close, close, high: close, low: close, vol, pct: null as number | null })

test('D1-a 量纲判据：只有 ≈100× 才动手；60× 必须「无法判定且不改数」（注入旧 band ⇒ 必败）', () => {
  /**
   * 旧行为：`ratio ∉ [1/20, 20]` 就无条件 ×/÷100 ⇒ 60× 也照乘（归一到手之后变成 0.6×，更远）。
   * 新增判据：`|log10(ratio/100)| ≤ 0.1`（或反向）才动手。
   */
  const judgement = (r: ReturnType<typeof alignVolUnitWithQuote>): 'fixed' | 'noop-clear' | 'noop-unsure' => {
    if (r.fixed) return 'fixed'
    return r.reason === null ? 'noop-clear' : 'noop-unsure'
  }

  // ① 60×：判不了，且**一根都不许动**
  const sixty = [bar('2026-10-15', 2_000_000), bar('2026-10-16', 2_000_000)]
  const r60 = alignVolUnitWithQuote(sixty, { date: '2026-10-16', vol: 33_333 })
  assert.equal(judgement(r60), 'noop-unsure', `60× 必须判「无法判定」（实际 ${judgement(r60)}，reason=${String(r60.reason)}）`)
  // v0.159.0：用户要求页面不再出现「判不了/只报数」⇒ 宿主文案改成等价表述（语义不变）
  assert.match(String(r60.reason), /无法判定/, '原因里必须写明无法判定')
  assert.match(String(r60.reason), /不改数/, '原因里必须写明「不改数」')
  assert.equal(r60.bars[1].vol, 2_000_000, '判不了时最后一根的量**不许**被改（注入旧 band ⇒ 这里会变成 20000）')
  // ⚠ 反例注入：旧实现的算式（任何 >20 的比值都 ÷100）必须被判据拒绝
  const oldFactor = 2_000_000 / 33_333 > 20 ? 1 / VOL_UNIT_FACTOR : VOL_UNIT_FACTOR
  assert.equal(Math.round(2_000_000 * oldFactor), 20_000, '⚠ 旧行为确实会把 2000000 改成 20000 —— 本判据必须拒绝它')

  // ② 100×：必须动手（真正的手/股之差）
  const hundred = [bar('2026-10-15', 4_653_193), bar('2026-10-16', 4_653_193)]
  const r100 = alignVolUnitWithQuote(hundred, { date: '2026-10-16', vol: 46_532 })
  assert.equal(judgement(r100), 'fixed', '100× 必须归一')
  assert.equal(r100.bars[1].vol, 46_531.93)

  // ③ 容差边界：79× 与 126× 都不算"100 倍"
  assert.equal(alignVolUnitWithQuote([bar('d', 79_000)], { date: 'd', vol: 1_000 }).fixed, false, '79× 不算（log10(79) 离 2 超过 0.1）')
  assert.equal(alignVolUnitWithQuote([bar('d', 126_000)], { date: 'd', vol: 1_000 }).fixed, false, '126× 不算')
  assert.equal(alignVolUnitWithQuote([bar('d', 90_000)], { date: 'd', vol: 1_000 }).fixed, true, '90× 在容差内 ⇒ 归一')

  // ④ 同口径（≈1×）仍然是"无需处理"，且不给 reason（既有行为不许退化）
  const same = [bar('2026-10-16', 46_532)]
  const rSame = alignVolUnitWithQuote(same, { date: '2026-10-16', vol: 46_532 })
  assert.equal(judgement(rSame), 'noop-clear', '同口径不许报「无法判定」，也不许改数')

  // ⑤ 反向（缓存比手还小 100×）仍要 ×100
  const tiny = [bar('2026-10-16', 465)]
  const rTiny = alignVolUnitWithQuote(tiny, { date: '2026-10-16', vol: 46_532 })
  assert.equal(rTiny.fixed, true, '≈0.01× 必须 ×100')
  assert.equal(rTiny.bars[0].vol, 46_500)
})

test('D1-b 参照日必须来自**报价自己的交易日**：日线停在昨天 ⇒ 一律不判（注入旧写法 ⇒ 必败）', async () => {
  /**
   * 旧写法 `{ date: lastFq1.date, vol: quote.vol }` 让 `findIndex` 必然命中最后一根，
   * "必须同一天"退化成恒真式。这里用**盘缓存停在昨天 + 报价是今天**复现真实场景
   * （东财限流时 `fetchKline` 返回旧 bar 并 `stale:true`）。
   */
  const secid = '1.688035'
  const FAKE_NOW = Date.parse('2026-10-16T20:30:00+08:00')
  const realNow = Date.now
  Date.now = () => FAKE_NOW
  const QUOTE_TIME = Date.parse('2026-10-16T10:00:00+08:00') // 报价属于 10-16
  // 日线最后一根是 **10-15**（昨天），且整段被放大 100×（段内一致 ⇒ 段内归一查不出来）
  const bars = days(45).map((date) => ({ date, open: 50, close: 50, high: 51, low: 49, vol: 4_653_193, pct: null }))
  const kdir = join(HOME, 'dsh-tradewatcher', 'klines')
  mkdirSync(kdir, { recursive: true })
  const file = join(kdir, `${secid}_101_1.json`)
  writeFileSync(file, JSON.stringify({ v: 3, secid, klt: 101, fqt: 1, updatedAt: Date.parse('2026-10-15T15:30:00+08:00'), partial: false, bars }))
  stubEm({ f2: 57.99, f3: 1, f4: 0.1, f5: 46_532, f12: '688035', f13: '1', f14: 'TEST', f18: 57.9, f124: Math.round(QUOTE_TIME / 1000), f20: 1e10, f21: 5e9 })
  try {
    const dir = mkdtempSync(join(tmpdir(), 'tw-fix7-'))
    const store = new DataStore(dir)
    await store.init()
    const routes = makeTradeRoutes(store, [], new CalendarStore(dir)).routes
    const route = routes.find((r) => r.path === '/tradewatcher/chips')
    assert.ok(route !== undefined)
    const body = await new Promise<Record<string, unknown>>((resolve) => {
      const req = { url: `/tradewatcher/chips?secid=${secid}&days=45`, method: 'GET', headers: { host: '127.0.0.1:3080' }, async *[Symbol.asyncIterator]() {} } as unknown as IncomingMessage
      const res = { writeHead() {}, end: (p: string) => resolve(p === '' ? {} : (JSON.parse(p) as Record<string, unknown>)) } as unknown as ServerResponse
      ;(route as unknown as { handler: (q: IncomingMessage, s: ServerResponse) => void }).handler(req, res)
    })
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { bars: Array<{ vol: number | null }> }
    const unitNote = String(body.unitNote ?? '')
    const missing = (body.missing ?? []) as Array<{ what: string; note: string }>
    /**
     * 判据：**报价与日线不在同一天 ⇒ 量纲判定必须一次都不发生**。
     * 直接看结果 —— 盘上最后一根的量必须还是 4 653 193（旧实现会把它除以 100）。
     */
    const unitGuardAbsent = (): boolean =>
      onDisk.bars[onDisk.bars.length - 1]?.vol === 4_653_193
      && !unitNote.includes('归一到「手」')
      && !missing.some((m) => m.what.includes('成交量量纲'))
    assert.equal(unitGuardAbsent(), true, `日线停昨天、报价是今天 ⇒ 不许做量纲归一（盘上=${String(onDisk.bars[onDisk.bars.length - 1]?.vol)} unitNote=${unitNote.slice(0, 120)}）`)
    // ⚠ 反例注入：旧写法（date 取日线自己最后一根）在同一份数据上**必须**触发 ÷100
    const oldRef = { date: bars[bars.length - 1].date, vol: 46_532 }
    const oldGuard = alignVolUnitWithQuote(bars, oldRef)
    assert.equal(oldGuard.fixed, true, '⚠ 旧写法（date=日线最后一根）必然命中并 ÷100 —— 本判据必须拒绝它')
    assert.equal(oldGuard.bars[oldGuard.bars.length - 1].vol, 46_531.93, '⚠ 旧写法把 4 653 193 改成 46 531.93（小 100 倍）')
    // 反向确认：**同一天**时报价参照仍然照常生效（不许把闸门焊死）
    const sameDay = alignVolUnitWithQuote(bars, { date: bars[bars.length - 1].date, vol: 46_532 })
    assert.equal(sameDay.fixed, true, '同一天的参照必须仍然生效（否则这道闸门等于被关掉）')
  } finally {
    Date.now = realNow
    restoreNet()
  }
})

// ─────────────────────────── D2 ───────────────────────────────────────────

test('D2 美股日线：`v:""` / `v:"0"` 必须是 null，不是 0（注入旧写法 ⇒ 必败）', () => {
  const payload = (rows: Array<Record<string, unknown>>): string => `/*<script>*/x([${rows.map((r) => JSON.stringify(r)).join(',')}]);`
  const parsed = parseSinaUsDaily(payload([
    { d: '2026-10-13', o: 1, h: 2, l: 0.5, c: 1.5, v: '', a: '' },      // 空串
    { d: '2026-10-14', o: 1, h: 2, l: 0.5, c: 1.6, v: '0', a: '0' },     // 上游给 "0"
    { d: '2026-10-15', o: 1, h: 2, l: 0.5, c: 1.7 },                     // 字段缺失
    { d: '2026-10-16', o: 1, h: 2, l: 0.5, c: 1.8, v: '12345', a: '130000' },
  ]))
  assert.equal(parsed.length, 4, '四行都必须保留（缺量不是缺 bar）')
  assert.equal(parsed[0].vol, null, '空串 ⇒ null（`Number("")` = 0 ⇒ 旧写法会写成 0）')
  assert.equal(parsed[1].vol, null, '上游给 "0" ⇒ null（不得读成零成交）')
  assert.equal(parsed[2].vol, null, '字段缺失 ⇒ null')
  assert.equal(parsed[3].vol, 12_345, '正常值原样')
  assert.equal(parsed[0].amount, null, '成交额同样不给 0')

  // ⚠ 反例注入：旧写法 `num(it.v) ?? 0` 在这三行上给出 0
  const oldWay = (v: unknown): number => (v === undefined ? 0 : Number(v))
  assert.equal(oldWay(''), 0, '⚠ `Number("")` 就是 0 —— 这正是被修的写法')
  assert.equal(oldWay(undefined), 0)

  // 端到端契约：null 一路传到聚合根（「任一日缺失 ⇒ 该根 vol 记 null」）
  const week = aggregateUsDaily(parsed as unknown as DayBar[], 'week')
  assert.equal(week.length, 1, '2026-10-13..16 是同一自然周')
  assert.equal(week[0].vol, null, '一周里有一天缺量 ⇒ 该周 vol 必须是 null（不许把缺的当 0 加总）')
  assert.ok(week[0].amount === null || week[0].amount === 130_000, '成交额同理不得 0 顶替')
})

// ─────────────────────────── D3 ───────────────────────────────────────────

test('D3 宏观门禁：marketExtras 的宏观取数点必须走 gatedFetch（注入裸 fetch ⇒ 必败）', () => {
  const text = readFileSync(join(SRC, 'marketExtras.ts'), 'utf8')
  const MACRO = text.slice(text.indexOf('export async function usdIndexCross'), text.indexOf('// ── 5. 全天成交额预测'))
  assert.ok(MACRO.length > 500, '宏观块切片必须非空（否则本判据恒真）')

  /** 结构检查：宏观块里不许有**裸** fetch（不是字符串包含，按调用点判） */
  const bareFetches = MACRO.split('\n')
    .map((line, i) => ({ line: line.trim(), no: i + 1 }))
    .filter((x) => /(?<![\w.])fetch\(/.test(x.line))
  assert.deepEqual(bareFetches, [], `宏观块里只许走 gatedFetch，不许有裸 fetch：\n${JSON.stringify(bareFetches)}`)
  // ⚠ 反例注入：把一条改回裸 fetch ⇒ 判据必须抓到
  const injected = MACRO.replace('gatedSinaBody(', 'fetch(')
  assert.notEqual(injected, MACRO, '注入必须真的改到了文本')
  assert.ok(/(?<![\w.])fetch\(/.test(injected), '⚠ 注入裸 fetch 后判据必须能命中')

  /**
   * 每条宏观 URL 主机都必须由门禁取数。
   * `gatedJson` 的实参就是 URL 字面量；`gatedSinaBody` 的实参是 symbol，
   * 主机在它自己的函数体里 ⇒ 那条要单独扫。
   */
  const GATED_CALL = /gatedJson\(([^\n]*)/g
  const gatedText = [...MACRO.matchAll(GATED_CALL)].map((m) => m[1]).join('\n')
  for (const host of ['push2delay.eastmoney.com', 'push2his.eastmoney.com']) {
    assert.match(gatedText, new RegExp(host.replace(/\./g, '\\.')), `宏观主机 ${host} 必须由 gatedJson 取数`)
  }
  const SINA_HELPER = text.slice(text.indexOf('async function gatedSinaBody'), text.indexOf('async function gatedSinaBody') + 900)
  assert.match(SINA_HELPER, /https:\/\/hq\.sinajs\.cn\//, 'gatedSinaBody 必须直连 hq.sinajs.cn')
  assert.match(SINA_HELPER, /gatedFetch\(/, 'gatedSinaBody 必须走 gatedFetch（否则 hq.sinajs.cn 又是一扇裸门）')
  // 两个新浪宏观 symbol 也必须都在门禁调用里（换别的符号 = 换了条链路）
  for (const symbol of ['DINIW', 'globalbd_us10yt']) {
    assert.ok(MACRO.includes(`gatedSinaBody('${symbol}')`), `新浪宏观 symbol ${symbol} 必须走 gatedSinaBody（实得 ${MACRO.slice(0, 160)}）`)
  }

  /**
   * 豁免清单：A股市场统计（涨停池 / 两融）明确划出宏观圈。
   * 判据双向：① 这三个主机**不得**出现在门禁调用里（它们不该占宏观预算）；
   *          ② 它们**必须**仍在（否则等于把功能删了）；③ 豁免清单不得含任何宏观主机。
   */
  const EXEMPT = ['push2ex.eastmoney.com', 'www.szse.cn', 'datacenter-web.eastmoney.com']
  const MACRO_HOSTS = ['hq.sinajs.cn', 'push2delay.eastmoney.com', 'push2his.eastmoney.com', 'home.treasury.gov', 'data-api.ecb.europa.eu']
  for (const host of EXEMPT) {
    assert.ok(text.includes(host), `豁免主机 ${host} 必须仍在（不是把功能删掉）`)
    assert.equal(MACRO_HOSTS.includes(host), false, `${host} 属市场统计，不许被登记成宏观主机`)
    assert.equal(gatedText.includes(host), false, `豁免主机 ${host} 不该占宏观预算（实得 gated 实参里出现了它）`)
  }
  // 豁免主机仍必须走熔断出口（记账 + 冷却期零请求）—— 不许出现"既不过门禁也不过熔断"的裸请求
  const emitter = /withHostBreaker\(/.test(text)
  assert.equal(emitter, true, '豁免主机的取数仍必须经过 withHostBreaker')
})

test('D3-b robotsGate 的接入面：宏观链两份（globalFlow + marketExtras），报价链仍然零接入', () => {
  const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')
  const files = ['globalFlow.ts', 'marketExtras.ts', 'em.ts', 'tencent.ts', 'sina.ts']
  const importers = files.filter((f) => /from '\.\/robotsGate\.ts'/.test(read(f))).sort()
  assert.deepEqual(importers, ['globalFlow.ts', 'marketExtras.ts'], `robotsGate 接入面必须恰好是宏观两份（实得 ${JSON.stringify(importers)}）`)
  // ⚠ 反例注入（两个方向）
  assert.equal(importers.includes('em.ts'), false, '⚠ 报价链不许接 robotsGate（docs/DECISIONS.md 的显式豁免）')
  assert.notDeepEqual(importers, ['globalFlow.ts'], '⚠ 只留 globalFlow 就回到"宏观有第二扇门"的老状态 —— 判据必须拒绝它')
})

// ─────────────────────────── D4 ───────────────────────────────────────────

test('D4-a 两融：上游给空串 ⇒ null，不是 0 亿元（注入旧 `Number("")` ⇒ 必败）', async () => {
  __resetRobotsCache()
  extras.__resetMacroBudget()
  const realNow = Date.now
  Date.now = () => Date.parse('2026-10-16T20:30:00+08:00')
  globalThis.fetch = (async (input: unknown) => {
    const url = String(typeof input === 'string' ? input : ((input as { url?: string })?.url ?? ''))
    if (url.includes('robots.txt')) return new Response('', { status: 404 })
    if (url.includes('www.szse.cn')) {
      return new Response(JSON.stringify([{ data: [{ jrrzye: '', jrrzmr: '', jrrjye: '' }] }]), { status: 200 })
    }
    return new Response(JSON.stringify({ result: { data: [{ DIM_DATE: '2026-10-15 00:00:00', RZYE: '', RZMRE: '', RQYE: '' }] } }), { status: 200 })
  }) as typeof fetch
  try {
    const cross = await extras.marginCross('2026-10-16')
    const zero = (v: number | null): boolean => v === 0
    assert.equal(cross.szse?.marginBalance, null, `深交所空串 ⇒ null（实际 ${String(cross.szse?.marginBalance)}）`)
    assert.equal(cross.szse?.marginBuy, null)
    assert.equal(cross.szse?.shortBalance, null)
    assert.equal(cross.em?.marginBalance, null, `东财空串 ⇒ null（实际 ${String(cross.em?.marginBalance)}）`)
    assert.equal(zero(cross.em?.marginBalance ?? null), false, '不许出现 0 亿元')
    // ⚠ 反例注入：旧 `numOf`（`Number('')`）会给出 0
    assert.equal(Number(''), 0, '⚠ 旧写法用 Number 会给出 0 —— 本判据必须拒绝它')
    // 正常值仍然要能读出来（不许为了修 0 顶替把正常路径也弄坏）
    globalThis.fetch = (async (input: unknown) => {
      const url = String(typeof input === 'string' ? input : ((input as { url?: string })?.url ?? ''))
      if (url.includes('robots.txt')) return new Response('', { status: 404 })
      if (url.includes('www.szse.cn')) return new Response(JSON.stringify([{ data: [{ jrrzye: '19,234.5', jrrzmr: '1,000', jrrjye: '12.3' }] }]), { status: 200 })
      return new Response(JSON.stringify({ result: { data: [{ DIM_DATE: '2026-10-15 00:00:00', RZYE: 1_920_000_000_000, RZMRE: 100_000_000, RQYE: 1_230_000_000 }] } }), { status: 200 })
    }) as typeof fetch
    const ok = await extras.marginCross('2026-10-16')
    assert.equal(ok.szse?.marginBalance, 19_234.5, '带千分位的正常值必须照常解析')
    assert.equal(ok.em?.marginBalance, 19_200, '元 → 亿元 的换算不许变')
  } finally {
    Date.now = realNow
    restoreNet()
  }
})

test('D4-b 美债 10Y 历史：缺值行必须**丢掉并给原因**，不许写成 0（注入 `?? 0` ⇒ 必败）', async () => {
  __resetRobotsCache()
  extras.__resetMacroBudget()
  globalThis.fetch = (async (input: unknown) => {
    const url = String(typeof input === 'string' ? input : ((input as { url?: string })?.url ?? ''))
    if (url.includes('robots.txt')) return new Response('', { status: 404 })
    return new Response(JSON.stringify({ data: { klines: ['2026-10-15,4.121', '2026-10-16,', '2026-10-17,—'] } }), { status: 200 })
  }) as typeof fetch
  try {
    const hist = await extras.us10yHistory(10)
    const values = hist.points.map((p) => p.value)
    const noZero = (vs: number[]): boolean => vs.every((v) => v !== 0)
    assert.deepEqual(hist.points.map((p) => p.day), ['2026-10-15'], `只有一行有值（实得 ${JSON.stringify(hist.points)}）`)
    assert.equal(noZero(values), true, '收益率 0.000% 是编出来的数 ⇒ 判据必须拒绝')
    assert.equal(hist.missing.length > 0, true, '丢掉的点必须进 missing（有原因、可诊断）')
    assert.match(hist.missing[0].note, /不用 0 顶替/)
    // ⚠ 反例注入：旧写法 `numOf(v) ?? 0` 会给出 [4.121, 0, 0]
    const oldPoints = ['2026-10-15,4.121', '2026-10-16,', '2026-10-17,—'].map((k) => {
      const [day, v] = k.split(',')
      const n = v === '' || v === '—' ? Number.NaN : Number(v)
      return { day: day ?? '', value: Number.isFinite(n) ? n : 0 }
    })
    assert.deepEqual(oldPoints.map((p) => p.value), [4.121, 0, 0], '⚠ 旧写法确实产出两个 0 —— 本判据必须拒绝它')
    assert.equal(noZero(oldPoints.map((p) => p.value)), false, '⚠ 反例注入必须被判据判为不合格')
  } finally {
    restoreNet()
  }
})

// ─────────────────────────── D5 ───────────────────────────────────────────

test('D5 文件锁：持有者**还活着**时否决回收（注入旧判据 ⇒ 必败）', () => {
  const staleMs = 10_000
  const snap = (ageMs: number, alive: boolean | null): LockSnapshot => ({
    lockPath: '/tmp/x.lock',
    holder: alive === null ? null : { pid: 4242, token: 't', at: 0, host: 'h', target: 'x' } as LockSnapshot['holder'],
    mtimeMs: 0,
    ageMs,
    pidAlive: alive,
  })
  /**
   * 判据：`pidAlive === true` ⇒ 只有心跳断供超过 `HEARTBEAT_HUNG_FACTOR × staleMs` 才可回收。
   * 旧实现只看 `ageMs > staleMs` ⇒ 10.1 s 就判"可回收"，把"卡住的写者"当成"死了的写者"。
   */
  const wouldReclaim = (s: LockSnapshot): boolean => staleReason(s, staleMs) !== null
  assert.equal(wouldReclaim(snap(staleMs + 6, true)), false, '活着 + 刚过 staleMs ⇒ 必须否决回收（这正是丢更新的入口）')
  assert.equal(wouldReclaim(snap(staleMs * 2, true)), false, '活着 + 2×staleMs ⇒ 仍然否决（一次长 GC 不该被当成挂死）')
  assert.equal(wouldReclaim(snap(staleMs * HEARTBEAT_HUNG_FACTOR + 6, true)), true, '活着 + 超过 3×staleMs ⇒ 判为挂死，可以回收')
  // 进程确实不在了 ⇒ 仍然按宽限回收（不许为了 D5 把这条也堵死）
  assert.equal(wouldReclaim(snap(staleMs + 6, false)), true, '进程不存在 ⇒ 照旧回收')
  assert.equal(wouldReclaim(snap(500, false)), false, '进程刚没、还没过宽限 ⇒ 先等（既有行为）')
  // 内容不可解析（pidAlive=null）⇒ 只能靠 mtime，保持原样
  assert.equal(wouldReclaim(snap(staleMs + 6, null)), true, '内容不可解析 ⇒ 按 mtime 回收（无法判活）')
  // 未到 staleMs ⇒ 一律不回收
  assert.equal(wouldReclaim(snap(1_000, true)), false)
  assert.equal(wouldReclaim(snap(1_000, false)), false)

  // ⚠ 反例注入：旧判据（只看 ageMs）在同一组输入上会给出 true
  const oldWay = (s: LockSnapshot): boolean => s.ageMs > staleMs
  assert.equal(oldWay(snap(staleMs + 6, true)), true, '⚠ 旧判据确实会回收活着的持有者 —— 本判据必须拒绝它')
  assert.equal(wouldReclaim(snap(staleMs + 6, true)), false, '⚠ 新旧判据在这一格上必须相反')
  // 系数本身不许被悄悄改小（改小等于把 D5 修回去）
  assert.ok(HEARTBEAT_HUNG_FACTOR >= 3, `挂死判定系数必须 ≥ 3（实得 ${HEARTBEAT_HUNG_FACTOR}）`)
})

// 保持 `breakerFor` 被引用（本文件里用于复位熔断状态，避免上游打桩崩掉的用例互相影响）
test('D0 前置：本文件结束前把熔断器复位（不影响其它文件）', () => {
  for (const host of ['push2delay.eastmoney.com', 'push2.eastmoney.com', 'push2his.eastmoney.com', 'qt.gtimg.cn', 'hq.sinajs.cn', 'www.szse.cn', 'datacenter-web.eastmoney.com']) {
    breakerFor(host).recordSuccess()
  }
  assert.equal(relative(ROOT, SRC), 'host')
})
