/**
 * 美股日线 + 分时的接线断言（AUDIT-IMPL68）。
 *
 * 覆盖 Lead 指定的五类"必败"反例：
 *   ① 美股日线出数据且**条数与上游一致**（注入：删接线 ⇒ 必败）；顺带守住"腾讯那 2 根不采信"
 *   ② 分时不可得时**必须给原因**、不得用空数组冒充（注入：返回空数组 ⇒ 必败）
 *   ③ 不支持周期**禁用并给原因**（注入：允许点击 ⇒ 必败）
 *   ④ 复权口径缺失时筹码/位置**不给结论**（注入：照算 ⇒ 必败）
 *   ⑤ 美股时间戳按**美东**解析、`TZ` 无关
 *
 * 全部走桩 fetch（不联网）；`DSH_HOME` 指到临时目录，避免污染真实 home。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { usWallToEpoch, newYorkParts, lastUsCloseBoundary, inUsSession, isUsSettledOffline } from './time.ts'
import { parseTencentUsStamp } from './tencent.ts'
import { positionRefusal, US_NO_FQ_WHY, positionOfBars } from './position.ts'
import { tabUnavailableReason } from '../client/chartCache.ts'
import { caliberDeviates } from '../client/chipsView.ts'

/** 隔离：必须在 `em.ts` 首次加载之前钉住 DSH_HOME（K 线缓存、归档都会写这里） */
const HOME = mkdtempSync(join(tmpdir(), 'tw-uschart-home-'))
process.env.DSH_HOME = HOME
if (!HOME.startsWith('/tmp')) throw new Error(`拒绝运行：DSH_HOME 必须在 /tmp 下（收到 ${HOME}）`)

// ── 真实形状的回包（2026-10-17 抓包，字段与下标见 docs/AUDIT-IMPL68.md §3）────────
/** 新浪美股日线：7 根，最后一根就是 2026-10-16（52.49 / 额 197036000） */
const SINA_DAILY = `/*<script>location.href='//sina.com';</script>*/
x([{"d":"2026-10-08","o":"50.10","h":"50.90","l":"49.80","c":"50.50","v":"2000000","a":"101000000"},` +
  `{"d":"2026-10-09","o":"50.60","h":"51.40","l":"50.20","c":"51.00","v":"2100000","a":"107100000"},` +
  `{"d":"2026-10-12","o":"51.10","h":"52.00","l":"50.90","c":"51.80","v":"2200000","a":"113960000"},` +
  `{"d":"2026-10-13","o":"58.52","h":"59.75","l":"58.41","c":"59.04","v":"3354633","a":"198604000"},` +
  `{"d":"2026-10-14","o":"59.46","h":"59.46","l":"55.24","c":"56.27","v":"7207586","a":"406081000"},` +
  `{"d":"2026-10-15","o":"53.16","h":"55.26","l":"52.23","c":"52.54","v":"6337328","a":"337448000"},` +
  `{"d":"2026-10-16","o":"53.63","h":"54.19","l":"52.38","c":"52.49","v":"3722968","a":"197036000"}]);`
/** 新浪美股分钟：2 个交易日（10-15 三根 + 10-16 三根），最后一天三根 */
const SINA_MIN = `/*<script>location.href='//sina.com';</script>*/
x([{"d":"2026-10-15 15:50:00","o":"52.60","h":"52.60","l":"52.50","c":"52.54","v":"1000","a":"52540"},` +
  `{"d":"2026-10-16 09:31:00","o":"53.63","h":"53.80","l":"53.60","c":"53.77","v":"101596","a":"5449120"},` +
  `{"d":"2026-10-16 15:55:00","o":"52.52","h":"52.60","l":"52.49","c":"52.49","v":"87164","a":"4581070"},` +
  `{"d":"2026-10-16 16:00:00","o":"52.49","h":"52.56","l":"52.38","c":"52.46","v":"352714","a":"18502000"}]);`
/** 腾讯对美股日线的真实形状：只有 2 根（首日与今天）——**不许**被采信成"日线序列" */
const TENCENT_TWO_BARS = JSON.stringify({
  code: 0,
  data: { usFRO: { day: [['2011-06-02', '17.760', '17.760', '18.050', '17.630', '1701615.000'], ['2026-10-16', '53.63', '52.49', '54.19', '52.38', '3722974']] } },
})

type Route = { daily?: string; min?: string; tencent?: string }
/** 把 fetch 换成按 URL 分流的桩；未登记的 URL 一律失败（模拟东财不可达） */
async function withStubs(route: Route, run: () => Promise<unknown>): Promise<unknown> {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    if (url.includes('US_MinKService.getDailyK')) {
      if (route.daily === undefined) throw new Error('offline(daily)')
      return new Response(route.daily, { status: 200 })
    }
    if (url.includes('US_MinKService.getMinK')) {
      if (route.min === undefined) throw new Error('offline(min)')
      return new Response(route.min, { status: 200 })
    }
    if (url.includes('fqkline')) return new Response(route.tencent ?? '{"code":0,"data":{}}', { status: 200 })
    throw new Error('offline (us chart test)')
  }) as typeof fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = real
  }
}

test('① 美股日K：条数与上游一致、不复权、量纲说明齐；腾讯那 2 根"首尾"不许被采信（注入：删接线 ⇒ 必败）', async () => {
  const em = await import('./em.ts')
  const k = await withStubs({ daily: SINA_DAILY, tencent: TENCENT_TWO_BARS }, () => em.fetchKline('106.FRO', 101, 7, 1)) as {
    days: Array<{ date: string; close: number; vol: number | null }>
    fqt: number
    fqSupported: boolean
    unitNote?: string
    staleReason?: string
  } | null
  assert.ok(k !== null, '日K 必须取到（接线被删 ⇒ 这里是 null ⇒ 必败）')
  // 条数与上游一致：夹具就是 7 根；少一根多一根都说明映射/截断错了
  assert.equal(k.days.length, 7, `条数必须与上游一致（实得 ${k.days.length}）`)
  assert.equal(k.days[6].date, '2026-10-16')
  assert.equal(k.days[6].close, 52.49)
  // 反例：腾讯对美股只回 2 根（2011-06-02 / 2026-10-16）—— 被采信的话这里会是 2
  assert.notEqual(k.days.length, 2, '⚠ 腾讯的 2 根"首尾"绝不能被当成日线序列')
  // 不复权：上游只给原始价（AAPL 拆股日 499.23→129.04 未被调整）
  assert.equal(k.fqt, 0, '美股只有不复权口径')
  assert.equal(k.fqSupported, false, '复权不可得 ⇒ fqSupported=false（界面据此禁用开关并说明原因）')
  assert.ok(String(k.unitNote ?? '').includes('股'), `成交量量纲必须标注为「股」（实得 ${String(k.unitNote)}）`)
})

test('①b 日K 取不到时：新浪可达但没这一行 ⇒ no-source；上游故障 ⇒ transient（两种都要有原因）', async () => {
  const em = await import('./em.ts')
  const empty = await withStubs({ daily: '/*x*/x([]);' }, () => em.fetchKline('105.ZZZZ', 101, 7, 0))
  assert.equal(empty, null, '空回包 ⇒ 不给空图（null + 原因）')
  const why = em.klineMissingReason('105.ZZZZ', 101)
  assert.ok(why.note.length > 0, '必须给原因')
  assert.ok(why.note.includes('新浪'), `美股日线的原因必须点明新浪这条上游（实得 ${why.note}）`)
  // 换一个本文件没请求过的美股（klineAttempts 里没有它 ⇒ 才会走到"上游故障"那支，
  // 否则 120s 内的新鲜记录会先判成 no-source —— 那本身是正确行为，只是不适合这条用例）
  const transient = em.klineMissingReason('105.TLT', 101, { emDown: true })
  assert.equal(transient.why, 'transient')
  assert.ok(transient.note.includes('新浪'), `故障时也要说清是哪条上游（实得 ${transient.note}）`)
})

test('② 分时：出真序列（美东标签 + 口径齐全）；空回包 ⇒ null + 原因，**不许**用空数组冒充', async () => {
  const em = await import('./em.ts')
  const t = await withStubs({ min: SINA_MIN }, () => em.fetchTrend('106.FRO', 1)) as {
    points: Array<{ t: number; label: string; price: number; amount?: number | null }>
    prePrice: number | null
    timeZone?: string
    caliber?: string
  } | null
  assert.ok(t !== null, '分时必须有序列（注入：返回空数组不抛 ⇒ 下面两条会红）')
  assert.equal(t.points.length, 3, `当日 3 根（实得 ${t.points.length}）`)
  assert.equal(t.points[0].label, '2026-10-16 09:31', '标签是**美东**墙上时间，不换算成北京')
  assert.equal(t.points[0].t, usWallToEpoch('2026-10-16 09:31:00'), 'epoch 必须由美东时间换算而来')
  assert.equal(t.timeZone, 'America/New_York', '时区必须随数据一起回（界面据此标注）')
  assert.ok(String(t.caliber ?? '').includes('新浪'), '口径必须写来源')
  assert.ok(String(t.caliber ?? '').includes('美东'), '口径必须写时区')
  assert.equal(t.prePrice, 52.54, '昨收取前一交易日最后一根（10-15 收盘 52.54）')

  // 反例注入：上游给"可达但空"的回包 ⇒ 必须是 null + 原因，不能是 points: []
  // （换一个标的：同一标的 60s 内有内存缓存与 LKG，会掩盖"空回包"这条路径）
  const empty = await withStubs({ min: '/*x*/x([]);' }, () => em.fetchTrend('107.VIXY', 1))
  assert.equal(empty, null, '空回包不许变成 points: []（那会让界面画一张空图、且没有原因）')
  const why = em.trendMissingReason('107.VIXY', { emDown: false })
  assert.ok(why.note.length > 0)
  assert.ok(why.note.includes('新浪'), `原因必须点明新浪（实得 ${why.note}）`)
  assert.equal(/该标的没有分时/.test(why.note), false, '不许说"该标的没有分时"')
})

test('②b 五日：新浪 5 分钟是真多日源（不是本地拼接）；不足两天时如实退回', async () => {
  const em = await import('./em.ts')
  const FIVE = '/*x*/x([' +
    ['2026-10-14 09:35:00', '2026-10-14 16:00:00', '2026-10-15 09:35:00', '2026-10-15 16:00:00', '2026-10-16 09:35:00', '2026-10-16 16:00:00']
      .map((d, i) => `{"d":"${d}","o":"50","h":"51","l":"49","c":"${50 + i}","v":"1000","a":"50000"}`).join(',') + ']);'
  const t = await withStubs({ min: FIVE }, () => em.fetchTrend('106.FRO', 5)) as { points: Array<{ label: string }>; source?: string } | null
  assert.ok(t !== null)
  const days = [...new Set(t.points.map((p) => p.label.slice(0, 10)))]
  assert.deepEqual(days, ['2026-10-14', '2026-10-15', '2026-10-16'], '五日必须是**真实多日**（三天都在）')
  assert.equal(t.source, undefined, '真实多日源不标 local-stitch（那是本地归档拼接的标记）')
})

test('③ 周期：美股只禁 周/月/年，且界面确实禁用（注入：允许点击 ⇒ 必败）', async () => {
  const tabs = ['trend', '5d', 'day', 'week', 'month', 'year'] as const
  const blocked = tabs.filter((t) => tabUnavailableReason('106.FRO', t) !== null)
  assert.deepEqual(blocked, ['week', 'month', 'year'], `美股只允许 分时/五日/日K（实得被禁 ${JSON.stringify(blocked)}）`)
  // 反例：判据一旦被删（任何 tab 都返回 null），上面那条 deepEqual 立刻红；
  // 这里再钉住"原因必须说清上游"，避免有人把理由改成一句空话
  assert.ok(String(tabUnavailableReason('106.FRO', 'week')).includes('日线'), '原因要说清"上游只有日线"')
  assert.equal(tabUnavailableReason('106.FRO', 'week') === null, false, '⚠ 返回 null 就是"允许点击"')
  // 非美股不受影响（回归）
  for (const t of tabs) assert.equal(tabUnavailableReason('1.600519', t), null, `A股 ${t} 不该被禁`)
  assert.equal(tabUnavailableReason('116.00700', 'week'), null)
  // 界面接线：按钮必须真的 disabled（不是点了才报错）
  const { readFileSync } = await import('node:fs')
  const drawer = readFileSync(new URL('../client/QuoteDrawer.tsx', import.meta.url), 'utf8')
  assert.ok(drawer.includes('tabUnavailableReason(secid, t)'), '抽屉必须按标的算禁用档')
  assert.ok(drawer.includes('disabled: off'), '禁用档必须落到按钮的 disabled（点了不会有任何事）')
  assert.ok(drawer.includes("'aria-disabled'"), '禁用档必须对读屏可见')
  // 宿主管线也要挡住：klt≠101 直接 null + no-source 原因（否则点了才报错）
  const em = await import('./em.ts')
  assert.equal(await em.fetchKline('106.FRO', 102, 10, 1), null)
  const why = em.klineMissingReason('106.FRO', 102)
  assert.equal(why.why, 'no-source')
  assert.ok(why.note.includes('不提供'))
})

test('④ 复权缺失 ⇒ 筹码/位置不给结论（注入：照算 ⇒ 必败）', async () => {
  const em = await import('./em.ts')
  // 宿主认定：美股没有复权口径（不是"不适用"，是"上游没给"）
  assert.equal(em.fqSupported('106.FRO'), false)
  assert.equal(em.normalizeFq('106.FRO', 1), 0, '请求前复权也必须被收敛成 0（不许把原始价当前复权）')
  // 位置：必须给出"不提供"的理由，而不是一个算出来的百分比
  assert.equal(positionRefusal('106.FRO'), US_NO_FQ_WHY)
  assert.equal(positionRefusal('107.VIXY'), US_NO_FQ_WHY)
  assert.equal(positionRefusal('1.600519'), null, 'A股不受影响')
  assert.equal(positionRefusal('100.SPX'), null, '指数仍按原始价格算（它本来就没有除权概念）')
  // 反例：假若照算 —— 跨拆股的窗口会算出一个"看着正常"的百分比，这正是我们不许发生的事
  const splitBars = [
    { date: '2026-08-28', open: 499, close: 499, high: 500, low: 498, vol: 1, pct: null },
    { date: '2026-08-31', open: 129, close: 129, high: 130, low: 128, vol: 1, pct: null },
    { date: '2026-10-16', open: 52, close: 52, high: 53, low: 51, vol: 1, pct: null },
  ]
  const wouldBe = positionOfBars('106.FRO', splitBars, 52, { fq: 0, fqSupported: true })
  assert.notEqual(wouldBe.posPct, null, '反例：若不拦，拆股窗口照样能算出一个百分比（所以必须由 positionRefusal 拦）')
  assert.equal(positionRefusal('106.FRO') !== null, true, '⚠ 拦住它的就是这条判据：改成 null 就变成"照算"')
  // 筹码：不支持时的文案必须点明美股是"上游只给未复权价"（不是"不适用"）
  const chipsWhy = caliberDeviates({ decay: 'turnover', decayReason: null, fqSupported: false, why: null, samples: 0, window: 45 })
  assert.ok(String(chipsWhy).includes('美股'), `筹码不提供的文案要能对上美股（实得 ${String(chipsWhy)}）`)
})

test('⑤ 时区：美股时间戳按美东解析，且与宿主 TZ 无关', () => {
  // 判别性输入：ET 收盘 16:00（EDT=−4）⇒ 20:00Z
  assert.equal(usWallToEpoch('2026-10-16 16:00:01'), 1792180801000)
  assert.notEqual(usWallToEpoch('2026-10-16 16:00:01'), Date.UTC(2026, 9, 16, 8, 0, 1), '按东八区解释 ⇒ 红')
  assert.notEqual(usWallToEpoch('2026-10-16 16:00:01'), Date.UTC(2026, 9, 16, 16, 0, 1), '按 UTC 解释 ⇒ 红')
  // DST 两端
  assert.equal(usWallToEpoch('2026-01-15 16:00:00'), Date.UTC(2026, 0, 15, 21, 0, 0), 'EST(−5)')
  assert.equal(usWallToEpoch('2026-07-01 12:00:00'), Date.UTC(2026, 6, 1, 16, 0, 0), 'EDT(−4)')
  // 解析不了就给 null（不猜）
  assert.equal(usWallToEpoch('16:00'), null)
  // 腾讯美股时间戳走同一套换算（上批的 parseTencentUsStamp 已下沉到 time.ts）
  assert.equal(parseTencentUsStamp('2026-10-16 16:04:53'), usWallToEpoch('2026-10-16 16:04:53'))
  // 纽约日历/时段：同一瞬时在纽约是 16:00（收盘）而不是北京 04:00
  assert.equal(newYorkParts(1792180801000).hhmm, '16:00')
  assert.equal(newYorkParts(1792180801000).day, '2026-10-16')
  // 定稿边界按纽约收盘（16:05 ET）；周六的"上一交易日"是周五
  assert.equal(lastUsCloseBoundary(Date.parse('2026-10-17T10:00:00+08:00')), Date.parse('2026-10-16T20:05:00Z'))
  assert.equal(inUsSession(Date.parse('2026-10-16T15:00:00Z')), true, '北京 23:00 = 美东 11:00 ⇒ 盘中（别拿北京时段判美股）')
  assert.equal(inUsSession(Date.parse('2026-10-16T21:00:00Z')), false, '美东 17:00 ⇒ 已收盘')
})

test('⑤b 美股"已定稿"按纽约收盘算，不按北京 15:05（跨零点口径错位会让日线整夜不回源）', () => {
  // 收盘后 17:00 ET（= 次日北京 05:00）：最近一次纽约收盘边界是当天 16:05 ET
  const afterClose = Date.parse('2026-10-16T21:00:00Z')
  assert.equal(isUsSettledOffline(Date.parse('2026-10-16T20:05:00Z'), afterClose), true, '过了纽约 16:05 ⇒ 定稿')
  assert.equal(isUsSettledOffline(Date.parse('2026-10-16T20:00:00Z'), afterClose), false, '16:00 ET 整还没到 16:05')
  // 盘中（美东 11:00）永远不定稿 —— 这正是"用北京 15:05 判美股"会整夜不回源的那个 bug
  assert.equal(isUsSettledOffline(Date.parse('2026-10-16T20:05:00Z'), Date.parse('2026-10-16T15:00:00Z')), false)
})
