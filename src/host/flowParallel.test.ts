/**
 * P2-8（`docs/AUDIT-HOST-PERF.md`）：五市场构建从**串行**改为 **3 路并发**。
 *
 * 旧实现：`for (const def of FLOW_MARKETS) { aum → chart → momentum 各自 await }` ⇒
 * 冷启动 5 市场 × 3 次上游等待全部排队（3–6 s）。新实现：`mapLimit(FLOW_MARKETS, 3, …)`，
 * 每个市场内部仍是 aum → chart → momentum 串行（三次独立等待）。
 *
 * 判据（用注入延迟 100ms 模拟上游，不碰真网络）：
 *   ① 串行基线（同一个 `buildMarketRaw` 逐市场 await）= 15 次等待 ≥1500ms；
 *      并发版 <900ms，且输出与串行 **deepEqual**（顺序也逐字一致 = FLOW_MARKETS 顺序）；
 *   ② 同时在飞的「市场」≤3（限流生效），但确实 >1（不是假并发）；
 *   ③ 某市场失败不影响其它：失败市场落进自己的 `missing`，其它市场照常有值。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMarketRaw, FLOW_MARKETS, FLOW_MARKET_CONCURRENCY, marketRaws, type FlowMarketKey, type MarketRaw, type MarketRawDeps } from './globalFlow.ts'

const DELAY_MS = 100
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const SERIES = [
  { date: '2026-10-01', close: 100 },
  { date: '2026-10-02', close: 101 },
]

/** 注入延迟的取数端口；同时记录「多少次等待」「同时在飞的峰值」 */
function slowDeps(delayMs: number): { deps: MarketRawDeps; stats: { waits: number; maxInflight: number } } {
  const stats = { waits: 0, maxInflight: 0 }
  let inflight = 0
  const enter = async (): Promise<void> => {
    stats.waits += 1
    inflight += 1
    stats.maxInflight = Math.max(stats.maxInflight, inflight)
    try {
      await sleep(delayMs)
    } finally {
      inflight -= 1
    }
  }
  const deps: MarketRawDeps = {
    rateOf: async () => 7,
    aumOf: async () => {
      await enter()
      return { aumNative: 1_000_000_000, aumNote: null, aumAsOf: 1 }
    },
    seriesOf: async () => {
      await enter()
      return { points: SERIES.map((p) => ({ ...p })), missing: null }
    },
  }
  return { deps, stats }
}

test('P2-8①：5 市场 × 3 次等待 ⇒ 并发墙钟 <900ms（串行基线 ≥1500ms），输出 deepEqual', async () => {
  const { deps, stats } = slowDeps(DELAY_MS)
  const rates = { usdCny: 7, usdHkd: 7 }

  // 串行基线：同一个 buildMarketRaw 逐市场 await（= 旧实现的骨架）
  const serial: MarketRaw[] = []
  const tSerial = performance.now()
  for (const def of FLOW_MARKETS) serial.push(await buildMarketRaw(def, rates, deps))
  const serialMs = performance.now() - tSerial
  assert.equal(stats.waits, FLOW_MARKETS.length * 3, '5 市场 × 3 次等待 = 15')
  assert.ok(serialMs >= 1500, `串行基线必须 ≥1500ms（实测 ${serialMs.toFixed(1)}ms）`)

  // 并发版：同样的 deps（缓存无、等待全真跑）
  const tParallel = performance.now()
  const { markets } = await marketRaws(deps)
  const parallelMs = performance.now() - tParallel
  assert.ok(parallelMs < 900, `并发墙钟必须 <900ms（实测 ${parallelMs.toFixed(1)}ms）`)
  assert.deepEqual(markets, serial, '并发输出必须与串行逐字一致（含 FLOW_MARKETS 顺序）')
  assert.deepEqual(markets.map((m) => m.key), FLOW_MARKETS.map((d) => d.key), '顺序 = FLOW_MARKETS')
  assert.equal(FLOW_MARKET_CONCURRENCY, 3)

  // 反例注入：把"3 路"退回"1 路"（= 串行）⇒ 判据必须失败
  const serialLikeMs = serialMs
  assert.throws(() => assert.ok(serialLikeMs < 900, '反例'), /反例/, '⚠ 反例（串行墙钟）必须失败')
})

test('P2-8②：限流 3 路生效（同时在飞的市场 ≤3，且确实 >1）', async () => {
  const { deps, stats } = slowDeps(20)
  const { markets } = await marketRaws(deps)
  assert.equal(markets.length, FLOW_MARKETS.length)
  assert.ok(stats.maxInflight <= FLOW_MARKET_CONCURRENCY, `同时在飞的等待数必须 ≤3（实测 ${stats.maxInflight}）`)
  assert.ok(stats.maxInflight > 1, `必须真的是并发（实测峰值 ${stats.maxInflight}）`)
})

test('P2-8③：某市场失败不连坐其它市场（失败只落进自己的 missing）', async () => {
  const deps: MarketRawDeps = {
    rateOf: async () => 7,
    aumOf: async (def) => {
      if (def.key === 'us') throw new Error('注入：美国规模取数失败')
      return { aumNative: 1_000_000_000, aumNote: null, aumAsOf: 1 }
    },
    seriesOf: async (key: FlowMarketKey) => {
      if (key === 'jp') throw new Error('注入：日本日线取数失败')
      return { points: SERIES.map((p) => ({ ...p })), missing: null }
    },
  }
  const { markets } = await marketRaws(deps)
  assert.deepEqual(markets.map((m) => m.key), ['cn', 'hk', 'us', 'jp', 'kr'], '顺序仍按 FLOW_MARKETS')

  const us = markets.find((m) => m.key === 'us')
  assert.equal(us?.aumNative, null, '美国规模必须为 null（不编数）')
  assert.ok(us?.missing.some((x) => x.what.includes('美国规模') && x.why === 'transient'), '美国行必须带原因')

  const jp = markets.find((m) => m.key === 'jp')
  assert.equal(jp?.aumNative, 1_000_000_000, '日本规模照常取到')
  assert.equal(jp?.chart, null, '日本日线失败 ⇒ null（不用 0 顶替）')
  assert.ok(jp?.missing.some((x) => x.what.includes('日本') && x.why === 'transient'), '日本行必须带原因')

  for (const key of ['cn', 'hk', 'kr'] as const) {
    const row = markets.find((m) => m.key === key)
    assert.equal(row?.aumNative, 1_000_000_000, `${key} 不受影响（规模照常）`)
    assert.equal(row?.chart?.length, SERIES.length, `${key} 不受影响（日线照常）`)
    assert.deepEqual(row?.missing, [], `${key} 没有 missing`)
  }
})
