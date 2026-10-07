/**
 * 图表客户端缓存的回归测试。
 *
 * 存在的理由：用户反馈"每次都拉取全量历史数据"。宿主侧已有落盘缓存与增量拉取，
 * 但客户端此前每开一次抽屉/每划过一次卡片就发一次 HTTP。这组断言把三件事锁住：
 *   1) 命中缓存 = 零请求（这是"优化拉取逻辑"的可验证定义）；
 *   2) 同键并发只发一个请求（悬浮卡与抽屉同时要同一份数据）；
 *   3) 失败不把图变空 —— 保留上次成功值并标 fallback，让界面如实说明。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  KLINE_PLAN,
  TAB_LABEL,
  cacheNoteOf,
  createChartCache,
  isKlineTab,
  rememberedTab,
  rememberTab,
  type ChartPayload,
  type ChartTab,
} from './chartCache.ts'
import type { KlineData, TrendData } from '../shared/model.ts'

const trendOf = (cached?: boolean): TrendData => ({
  secid: '1.600519',
  prePrice: 100,
  points: [
    { t: 1, price: 101, vol: 1, avg: 100.5, label: '2026-10-09 09:31' },
    { t: 2, price: 102, vol: 1, avg: 101, label: '2026-10-09 09:32' },
  ],
  last: 102,
  ...(cached === true ? { cached: true } : {}),
})

const klineOf = (cached?: boolean): KlineData => ({
  secid: '1.600519',
  days: [{ date: '2026-10-09', open: 1, close: 2, high: 3, low: 0.5, vol: 10, pct: 100 }],
  ...(cached === true ? { cached: true } : {}),
})

/** 假时钟：只替换 Date.now，测完恢复（避免把真实时间流逝写进断言） */
async function withFakeNow(run: (advance: (ms: number) => void) => Promise<void> | void): Promise<void> {
  const real = Date.now
  let now = 1_800_000_000_000
  Date.now = () => now
  try {
    await run((ms: number) => {
      now += ms
    })
  } finally {
    Date.now = real
  }
}

test('命中缓存即零请求，且标记来自缓存', async () => {
  let calls = 0
  const cache = createChartCache(async () => {
    calls += 1
    return { kind: 'trend', tab: 'trend', trend: trendOf() } as ChartPayload
  })
  const first = await cache.get('1.600519', 'trend')
  const second = await cache.get('1.600519', 'trend')
  assert.equal(calls, 1, '第二次必须命中缓存，不发请求')
  assert.equal(first?.fromCache, undefined, '首次是真实请求')
  assert.equal(second?.fromCache, true, '第二次必须标注来自缓存')
  assert.equal(cache.stats().requests, 1)
  assert.equal(cache.peek('1.600519', 'trend') !== null, true, 'peek 应命中（切周期先出图用）')
  assert.equal(cache.peek('1.600519', 'day'), null, '未请求过的周期 peek 必须为 null')
})

test('同键并发合并成一个请求', async () => {
  let calls = 0
  let release: ((v: ChartPayload | null) => void) | null = null
  const cache = createChartCache(
    () =>
      new Promise<ChartPayload | null>((resolve) => {
        calls += 1
        release = resolve
      }),
  )
  const a = cache.get('1.600519', 'day')
  const b = cache.get('1.600519', 'day')
  assert.equal(calls, 1, '两个并发调用只允许发一个请求')
  assert.equal(cache.stats().inflight, 1)
  release?.({ kind: 'kline', tab: 'day', kline: klineOf() })
  const [ra, rb] = await Promise.all([a, b])
  assert.equal((ra as { kind: string }).kind, 'kline')
  assert.equal(rb, ra, '两个调用共享同一个 promise 结果')
  assert.equal(cache.stats().inflight, 0, '完成后不得残留 inflight')
  assert.equal(calls, 1)
})

test('上游失败保留上次成功值（fallback），首次失败则抛出', async () => {
  await withFakeNow(async (advance) => {
    let fail = false
    let calls = 0
    const cache = createChartCache(async () => {
      calls += 1
      if (fail) throw new Error('fetch failed')
      return { kind: 'trend', tab: 'trend', trend: trendOf() } as ChartPayload
    })
    {
      const ok = await cache.get('1.600519', 'trend')
      assert.equal(ok !== null, true)
      advance(31_000) // 越过盘中 TTL(30s)
      fail = true
      const again = await cache.get('1.600519', 'trend')
      assert.equal(calls, 2, '过期后应重新请求')
      assert.equal(again !== null, true, '失败时不得把图变空')
      assert.equal(again?.fallback, true, '必须标注为上次成功数据')
      assert.equal(again?.fromCache, true)
      // 失败保底 TTL 只有 20s：过了就该再试一次
      advance(21_000)
      await cache.get('1.600519', 'trend')
      assert.equal(calls, 3, '保底 TTL 到期后必须重试')

      const cold = createChartCache(async () => {
        throw new Error('fetch failed')
      })
      await assert.rejects(() => cold.get('1.000001', 'day'), /fetch failed/, '无旧值时必须抛出，交给界面显示重试')
    }
  })
})

test('休市定稿（宿主 cached=true）给更长 TTL：收盘后反复开关面板零请求', async () => {
  await withFakeNow(async (advance) => {
    let calls = 0
    const cache = createChartCache(async (_secid: string, tab: ChartTab) => {
      calls += 1
      return tab === 'trend'
        ? ({ kind: 'trend', tab: 'trend', trend: trendOf(true) } as ChartPayload)
        : ({ kind: 'kline', tab: 'day', kline: klineOf(true) } as ChartPayload)
    })
    {
      await cache.get('1.600519', 'trend') // t0：定稿分时 TTL 5min
      await cache.get('1.600519', 'day') //   t0：定稿日K TTL 60min
      assert.equal(calls, 2)
      advance(4 * 60_000) // t0+4min
      await cache.get('1.600519', 'trend')
      assert.equal(calls, 2, '定稿分时 4 分钟内不得回源')
      advance(26 * 60_000) // t0+30min
      await cache.get('1.600519', 'day')
      assert.equal(calls, 2, '定稿日K 1 小时内不得回源')
      advance(31 * 60_000) // t0+61min：越过 60 分钟
      await cache.get('1.600519', 'day')
      assert.equal(calls, 3, '越过定稿 TTL 后必须重新校验一次')
    }
  })
})

test('clear 后回到冷启动状态', async () => {
  let calls = 0
  const cache = createChartCache(async () => {
    calls += 1
    return { kind: 'trend', tab: 'trend', trend: trendOf() } as ChartPayload
  })
  await cache.get('1.600519', 'trend')
  cache.clear()
  assert.equal(cache.peek('1.600519', 'trend'), null)
  assert.equal(cache.stats().entries, 0)
  await cache.get('1.600519', 'trend')
  assert.equal(calls, 2)
})

test('请求计划与文案：日K 仍是 240 根、周期标签齐全', () => {
  assert.equal(KLINE_PLAN.day.klt, 101)
  assert.equal(KLINE_PLAN.day.lmt, 240, '日K 首次仍取 240 根（增量由宿主负责）')
  assert.deepEqual(Object.values(TAB_LABEL), ['分时', '五日', '日K', '周K', '月K', '年K'])
  assert.equal(isKlineTab('day'), true)
  assert.equal(isKlineTab('5d'), false)
})

test('脚注标注诚实：缓存 / 定稿 / 失败回退三种措辞互不混淆', () => {
  assert.equal(cacheNoteOf(null), '')
  assert.equal(
    cacheNoteOf({ kind: 'trend', tab: 'trend', trend: trendOf(), fromCache: true }),
    ' · 本地缓存',
  )
  assert.equal(
    cacheNoteOf({ kind: 'kline', tab: 'day', kline: klineOf(true) }),
    ' · 休市定稿缓存（未回源）',
  )
  assert.equal(
    cacheNoteOf({ kind: 'kline', tab: 'day', kline: klineOf(true), fromCache: true, fallback: true }),
    ' · 显示上次成功数据（本次刷新失败）',
    '刷新失败时必须优先说明这点，不能只写"本地缓存"',
  )
})

test('周期记忆：抽屉关掉再打开保持同一周期', () => {
  assert.equal(rememberedTab(), 'trend', '默认分时')
  rememberTab('day')
  assert.equal(rememberedTab(), 'day')
  rememberTab('trend')
})
