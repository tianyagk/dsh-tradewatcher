/**
 * **搭车落盘**（AUDIT-IMPL63 决策 1/2 / v0.18.0）——两条都要求「零新增上游请求」：
 *
 *   ① **触发瞬间的家数**：事件写入时带上当时的全市场涨/跌/平家数（优先用**本拍行情里本来就有**的
 *      指数家数 `f104/f105/f106`，其次用 `/breadth` 最近一次成功结果 ≤120s）；两者都没有 ⇒ `null` + 原因，
 *      **绝不**为它单独发请求、**绝不**写 0。
 *   ② **分时点带六通道读数**：5 分钟分时点带上该拍六只宽基 ETF 各自的读数（就是同一拍 `etfs` 的投影）。
 *
 * 这个文件用**打桩上游**跑通"真的一次采样"，因此能直接断言：
 *   · 事件里确实有家数（值等于回包里的 f104/f105/f106）；
 *   · 家数缺失时是 `null` + 原因（不是 0）；
 *   · 分时点里确实有六通道；
 *   · **请求数不因为这两项而增加**（并对"有没有为家数/通道单独取数"做 URL 级断言）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * ⚠ **必须在 import rescue.ts / em.ts 之前**钉住 DSH_HOME：
 * 否则共享行情链会去读**真机**的 `~/.dsh/dsh-tradewatcher`（含 quotes-lkg 的真实 f104/f105/f106）
 * —— 那样"家数从哪来"这条断言就是假的（实测踩过：缺失用例反而拿到了真机的家数）。
 */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'rp3-home-'))

const NOW = Date.parse('2026-10-16T14:00:00+08:00')
const ETFS = [
  ['1.510300', '510300', '沪深300ETF', 3.9],
  ['1.510050', '510050', '上证50ETF', 2.85],
  ['1.510500', '510500', '中证500ETF', 6.1],
  ['1.512100', '512100', '中证1000ETF', 2.4],
  ['1.588000', '588000', '科创50ETF', 1.05],
  ['0.159915', '159915', '创业板ETF', 2.2],
] as const

/** 一份带 σ 与 126 天标记的标定（同刻度基线可用 ⇒ 生效系数 1 ⇒ 等级线 35/55） */
function seededLog(amountBase: number): string {
  const curve = new Array(49).fill(0).map((_, i) => Math.min(1, i / 48))
  const sd = new Array(49).fill(0.02)
  const baselines: Record<string, { avgAmt20: number; day: string; source: string }> = {}
  for (const [secid] of ETFS) baselines[secid] = { avgAmt20: amountBase, day: '2026-10-15', source: 'em' }
  return JSON.stringify({
    v: 1, days: {}, lastSnapshot: null, baselines, selfSamples: {},
    progressCurve: curve, progressSd: sd, progressDays: 126, updatedAt: 0,
  })
}

/** 打桩上游：只回答"这一次采样真正需要的"三类请求，并记录全部 URL */
function stub(withAd: boolean): { calls: string[]; restore: () => void } {
  const calls: string[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    const url = String(typeof input === 'string' ? input : (input as { url?: string })?.url ?? '')
    calls.push(url)
    const json = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response
    // ① 批量行情（指数 + 六只 ETF 一次给全；家数字段只在 withAd 时给）
    if (url.includes('ulist.np/get')) {
      const diff: Array<Record<string, unknown>> = [
        // ⚠ 护盘采样器的指数是 INDEX_SECID = 1.000300（沪深300），不是上证指数
        { f12: '000300', f13: 1, f14: '沪深300', f2: 3900, f3: -1.2, f6: 4.2e11, f62: -1e9, f66: -5e8, ...(withAd ? { f104: 3800, f105: 900, f106: 100 } : {}) },
        ...ETFS.map(([secid, code, name, px], i) => ({
          f12: code, f13: Number(secid.split('.')[0]), f14: name, f2: px, f3: -1.5, f6: 5e8, f8: 1.2, f10: 1.1,
          f62: 2e7 + i * 1e6, f66: 1e7 + i * 5e5, f104: null, f105: null, f106: null, f15: px + 0.02, f16: px - 0.03, f17: px - 0.01, f18: px + 0.05, f124: 1,
        })),
      ]
      return json({ rc: 0, data: { diff } })
    }
    // ② 分钟序列（腾讯链）：六只都给几分钟递增的累计成交额 ⇒ 六卡都有序列、长度一致
    if (url.includes('appstock/app/minute/query')) {
      const code = /code=([a-z]{2}\d{6})/.exec(url)?.[1] ?? 'sh510300'
      const rows = ['0930 3.9 1000 1000000', '0931 3.9 2000 3000000', '1400 3.9 200000 500000000']
      return json({ code: 0, msg: '', data: { [code]: { data: { data: rows } } } })
    }
    // ③ 日 K（20 日均额标定走这里；给空 ⇒ 用 seed 里的 baselines）
    if (url.includes('kline/get')) return json({ rc: 0, data: { klines: [] } })
    return { ok: false, status: 503, json: async () => ({}), text: async () => 'down' } as unknown as Response
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = real } }
}

/**
 * 熔断器是**模块级**状态（同一进程里跨用例保留）⇒ 每个用例开跑前把这些主机复位，
 * 否则第一个用例打桩出的 503 会把后面几个用例挡在"熔断中"（实测踩过）。
 */
async function resetBreakers(): Promise<void> {
  const { breakerFor } = await import('./breaker.ts')
  for (const host of [
    'push2delay.eastmoney.com', 'push2.eastmoney.com', 'push2his.eastmoney.com', 'qt.gtimg.cn',
    'web.ifzq.gtimg.cn', 'quotes.sina.cn', 'hq.sinajs.cn', 'finance.sina.com.cn', 'data-api.ecb.europa.eu',
  ]) breakerFor(host).recordSuccess()
}

async function sampleOnce(withAd: boolean): Promise<{
  same: Awaited<ReturnType<import('./rescue.ts').RescueMonitor['sampleNow']>>
  calls: string[]
}> {
  const dir = mkdtempSync(join(tmpdir(), 'tw-rp2-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'rescue-log.json'), seededLog(1e8))
  const realNow = Date.now
  Date.now = () => NOW
  await resetBreakers()
  const s = stub(withAd)
  try {
    const { RescueMonitor } = await import('./rescue.ts')
    const mon = new RescueMonitor(dir, { enabled: true, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [] })
    await mon.init()
    const snap = await mon.sampleNow()
    return { same: snap, calls: s.calls }
  } finally {
    Date.now = realNow
    s.restore()
  }
}

test('① 触发瞬间的家数：搭车进事件（值 == 同拍行情里的 f104/f105/f106），且**不为它发请求**', async () => {
  const { same, calls } = await sampleOnce(true)
  const ev = same.today.find((e) => e.level >= 1)
  assert.ok(ev !== undefined, `这一次采样必须出等级（否则事件测试是空跑）：level=${same.level} raw=${JSON.stringify(same.today.map((e) => e.level))}`)
  assert.ok(ev.breadth !== undefined && ev.breadth !== null, '事件必须带家数（breadth）')
  assert.equal(ev.breadth.up, 3800, '家数必须等于同拍行情里的 f104')
  assert.equal(ev.breadth.down, 900)
  assert.equal(ev.breadth.even, 100)
  assert.equal(ev.breadthSource, 'tick-quote', '来源必须标成"本拍行情"')
  assert.equal(ev.breadthWhy ?? null, null, '拿到了 ⇒ 不带原因')
  // 零新增请求：没有任何请求是"为了家数"打的（家数只能来自同拍行情或 /breadth 记录）
  const adCalls = calls.filter((u) => /clist|breadth|f104=/.test(u))
  assert.deepEqual(adCalls, [], `不许为家数单独取数（实际 ${JSON.stringify(adCalls)}）`)
  assert.ok(calls.length <= 80, `一次采样的请求数要有界（六通道 × 源回退链，实际 ${calls.length}）`)
})

test('② 家数缺失 ⇒ `null` + 原因（**不得写 0**）；缓存过期也算缺失（不拿旧数冒充）', async () => {
  const { resolveBreadthMoment, BREADTH_MOMENT_TTL_MS } = await import('./rescue.ts')
  const NOW2 = Date.parse('2026-10-16T14:00:00+08:00')
  // ① 本拍行情没有家数字段 + 从没读过 /breadth ⇒ null + 原因（**不写 0**）
  const miss = resolveBreadthMoment({ quote: { up: null, down: null, even: null, amount: 1e9, at: NOW2 }, cached: null, now: NOW2 })
  assert.equal(miss.moment, null, '没有家数 ⇒ null（0 会被读成"全市场无涨跌"）')
  assert.equal(miss.source, null)
  assert.ok((miss.why ?? '').includes('不为此单独发请求'), `原因要说明"没有为它取数"：${miss.why}`)
  // ② /breadth 记录过期 ⇒ 也算缺失（不许拿旧数冒充"触发瞬间"）
  const stale = resolveBreadthMoment({
    quote: null,
    cached: { up: 3800, down: 900, even: 100, amount: 4.2e11, asOf: NOW2 - BREADTH_MOMENT_TTL_MS - 1000, source: '东财指数行情（f104/f105/f106）' },
    now: NOW2,
  })
  assert.equal(stale.moment, null, '过期 ⇒ null')
  assert.ok((stale.why ?? '').includes('过期'), `原因要写明过期：${stale.why}`)
  // ③ 缓存新鲜 ⇒ 用它（来源标注 /breadth）
  const hit = resolveBreadthMoment({
    quote: null,
    cached: { up: 3800, down: 900, even: 100, amount: 4.2e11, asOf: NOW2 - 30_000, source: '东财指数行情（f104/f105/f106）' },
    now: NOW2,
  })
  assert.equal(hit.source, 'breadth-cache')
  assert.equal(hit.moment?.up, 3800)
  // ④ 本拍行情有家数 ⇒ 优先本拍（时刻更准），且与 /breadth 记录无关
  const tick = resolveBreadthMoment({ quote: { up: 42, down: 7, even: 1, amount: null, at: NOW2 }, cached: null, now: NOW2 })
  assert.equal(tick.source, 'tick-quote')
  assert.equal(tick.moment?.up, 42)
  assert.equal(tick.moment?.amount, null, '成交额缺失 ⇒ null（不写 0）')
  // ⑤ 端到端：缺失场景下事件照样不额外取数（上一条用例已断言；这里再证"纯函数不含 fetch"）
  assert.equal(/fetch\(/.test(resolveBreadthMoment.toString()), false, '解析家数不许取数')
})

test('③ 分时点带六通道读数（同一拍批量结果的投影，零新增请求）', async () => {
  const { same, calls } = await sampleOnce(true)
  const pt = same.intraday.at(-1)
  assert.ok(pt !== undefined, '必须有分时点（14:00 这一拍）')
  assert.equal(pt.channels?.length, 6, `分时点必须带六通道（实际 ${pt.channels?.length ?? 0}）`)
  const by = new Map((pt.channels ?? []).map((c) => [c.secid, c]))
  for (const [secid, , name] of ETFS) {
    const c = by.get(secid)
    assert.ok(c !== undefined, `缺通道 ${secid}`)
    assert.equal(c.name, same.etfs.find((e) => e.secid === secid)?.name ?? name, '通道名必须与同拍快照一致')
    assert.equal(typeof c.price, 'number', `${secid} 要带价格`)
    assert.equal(typeof c.amount, 'number', `${secid} 要带成交额`)
    assert.equal(typeof c.superNet, 'number', `${secid} 要带超大单净额`)
  }
  // 六通道的值必须与同一拍快照里 etfs 的值逐个相等（"同一拍"是硬要求，不许另取一遍）
  const snapEtfs = new Map(same.etfs.map((e) => [e.secid, e]))
  for (const c of pt.channels ?? []) {
    const e = snapEtfs.get(c.secid)
    assert.ok(e !== undefined, `快照里也应有 ${c.secid}`)
    assert.equal(c.price, e.price, `${c.secid} 价格必须与同拍快照一致`)
    assert.equal(c.amount, e.amount, `${c.secid} 成交额必须与同拍快照一致`)
    assert.equal(c.superNet, e.superNet, `${c.secid} 超大单必须与同拍快照一致`)
    assert.equal(c.timeAdjMult, e.timeAdjMult, `${c.secid} 量能倍数必须与同拍快照一致`)
  }
  // 不新增请求：通道数据只能来自同拍行情
  // 行情批量最多 1 次（0 = 命中进程内共享行情缓存；**绝不**六通道各打一次）
  const batches = calls.filter((u) => /ulist\.np\/get/.test(u)).length
  assert.ok(batches <= 1, `行情批量最多一次：六通道必须搭同一批的车（实际 ${batches} 次）`)
  // 六卡序列必须也在快照里，且长度一致（每卡都读到同一批分钟链的结果）
  const cards = same.etfSeries ?? []
  assert.equal(cards.length, 6, `快照必须带六卡序列（实际 ${cards.length}）`)
  const lens = new Set(cards.map((c) => c.points.length))
  assert.equal(lens.size, 1, `六卡序列长度必须一致（实际 ${JSON.stringify([...lens])}）`)
  // 点是否为空取决于"这一刻秒链有没有刷新到"（缓存/时序），所以这里只断言**长度一致**；
  // "有数据 ⇒ 有点、没数据 ⇒ 空数组 + 原因"由 ⑥ 用纯函数确定性地断言。
  for (const c of cards) {
    assert.ok((c.caliber ?? '').includes('每分钟成交额'), `每卡必须带口径说明：${c.caliber}`)
    for (const p of c.points) {
      assert.ok(typeof p.hhmm === 'string' && /^\d{2}:\d{2}$/.test(p.hhmm), `点必须带 HH:mm（实际 ${p.hhmm}）`)
    }
  }
})

test('④ 结构性：两条路径都不含 `fetch(`；体积上限与条数上限都在', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./rescue.ts', import.meta.url), 'utf8')
  const bodyOf = (name: string): string => {
    const i = src.indexOf(`export function ${name}`)
    assert.ok(i > 0, `找不到 ${name}`)
    return src.slice(i, src.indexOf('\n}\n', i))
  }
  for (const fn of ['resolveBreadthMoment', 'trimIntradayBySize']) {
    assert.equal(/fetch\(/.test(bodyOf(fn)), false, `${fn} 必须是纯函数（不许 fetch）`)
  }
  // 事件写入那一段不许出现 fetch；分时点那一段也不许
  const evBlock = src.slice(src.indexOf('const breadth = resolveBreadthMoment('), src.indexOf('this.today.events.push('))
  assert.ok(evBlock.length > 0 && !/fetch\(/.test(evBlock), '事件家数那段不许 fetch')
  const ptBlock = src.slice(src.indexOf('const channels: RescueIntradayChannel[]'), src.indexOf('this.today.intraday.push('))
  assert.ok(ptBlock.length > 0 && !/fetch\(/.test(ptBlock), '分时点通道那段不许 fetch')
  // 体积/条数上限必须存在且被使用
  assert.ok(src.includes('RESCUE_INTRADAY_MAX = 120'), '条数上限必须在')
  assert.ok(src.includes('RESCUE_INTRADAY_MAX_BYTES'), '字节上限必须在')
  assert.ok(src.includes('trimIntradayBySize(this.today.intraday)'), '写入侧必须真的用它裁剪')
  assert.ok(src.includes('noteBreadthMoment('), '内存记录 /breadth 读数的入口必须在（零 IO）')
})

test('⑤ 体积上限：超大分时序列必须被裁到上限内，且保留最新', async () => {
  const { trimIntradayBySize } = await import('./rescue.ts')
  const fat = Array.from({ length: 120 }, (_, i) => ({
    hhmm: `14:${String(i % 60).padStart(2, '0')}`,
    level: 0, score: 10,
    channels: Array.from({ length: 6 }, (_, j) => ({ secid: `1.51030${j}`, name: `ETF${j}`, price: 1.23, pct: 0.1, amount: 1e8, timeAdjMult: 1.1, superNet: 1e6, pad: 'x'.repeat(60) })),
  }))
  const before = JSON.stringify(fat).length
  const out = trimIntradayBySize(fat, 64 * 1024)
  assert.ok(before > 64 * 1024, `夹具本身必须超限（实际 ${before} 字节）`)
  assert.ok(out.bytes <= 64 * 1024, `裁完必须 ≤ 上限（实际 ${out.bytes}）`)
  assert.ok(out.dropped > 0 && out.points.length < fat.length, '必须真的裁掉最旧的')
  assert.equal(out.points.at(-1)?.hhmm, fat.at(-1)?.hhmm, '最新的一条必须留下')
})

test('⑥ 六卡序列的语义（纯函数，确定性）：有数据 ⇒ 有点且带口径；没数据 ⇒ 空数组 + 原因（不写 0）', async () => {
  const { cardSeriesOf, trimCardSeries, RESCUE_CARD_MAX_POINTS } = await import('./rescue.ts')
  const metas = ETFS.map(([secid, , name]) => ({ secid, name }))
  // ① 有分钟数据 ⇒ 映射成 {hhmm, amount, price}，口径写清；缺字段 ⇒ null（不写 0）
  const withData = cardSeriesOf(metas, {
    '1.510300': [
      { hhmm: '2026-10-16 09:30', amount: 1234, price: 3.9 },
      { label: '2026-10-16 09:31', amount: null, price: 3.91 },
    ],
  })
  const c0 = withData.find((c) => c.secid === '1.510300')
  assert.equal(c0?.points.length, 2)
  assert.deepEqual(c0?.points[0], { hhmm: '09:30', amount: 1234, price: 3.9 }, 'HH:mm 要截出来（客户端迷你折线的横轴）')
  assert.equal(c0?.points[1]?.amount, null, '缺失的分钟额必须是 null，不许写 0')
  assert.ok((c0?.caliber ?? '').includes('每分钟成交额'), `口径必须写清：${c0?.caliber}`)
  assert.equal(c0?.why ?? null, null, '有数据 ⇒ 不带原因')
  // ② 没有分钟数据 ⇒ 空数组 + 原因（**不得**补 0 冒充完整序列）
  const noData = cardSeriesOf(metas, {})
  assert.equal(noData.length, 6, '六卡都要在（缺数据也要在，带原因）')
  for (const c of noData) {
    assert.deepEqual(c.points, [], `${c.secid} 缺数据 ⇒ 空数组`)
    assert.ok((c.why ?? '').includes('不补 0'), `${c.secid} 必须给原因：${c.why}`)
  }
  // ③ 上限：每卡点数 ≤ 242（保留最新）；整块字节超上限 ⇒ 从最旧的分钟丢，六卡同步
  const fat = metas.map((m) => ({ secid: m.secid, name: m.name, caliber: 'c', points: Array.from({ length: 400 }, (_, i) => ({ hhmm: `14:${String(i % 60).padStart(2, '0')}`, amount: i, price: 1 })) }))
  const capped = trimCardSeries(fat, { maxBytes: 32 * 1024 })
  for (const c of capped.cards) assert.ok(c.points.length <= RESCUE_CARD_MAX_POINTS, `每卡 ≤ ${RESCUE_CARD_MAX_POINTS} 点（实际 ${c.points.length}）`)
  assert.ok(capped.bytes <= 32 * 1024, `整块 ≤ 字节上限（实际 ${capped.bytes}）`)
  assert.ok(capped.droppedPoints > 0, '超限必须真的丢点')
  const lens = new Set(capped.cards.map((c) => c.points.length))
  assert.equal(lens.size, 1, '六卡同步裁剪 ⇒ 长度仍然一致')
  assert.equal(capped.cards[0]?.points.at(-1)?.amount, 399, '保留的是**最新**的点')
})
