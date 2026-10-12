/**
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  KLINE_PLAN,
  TAB_LABEL,
  cacheNoteOf,
  createChartCache,
  fqFor,
  isKlineTab,
  rememberedTab,
  rememberFq,
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
  // E1：统一成「上次成功数据（MM-DD HH:mm）」，日期必须来自数据自己（K 线取最后一根）
  assert.match(
    cacheNoteOf({ kind: 'kline', tab: 'day', kline: klineOf(true), fromCache: true, fallback: true }),
    /^ · 上次成功数据（10-09）$/,
    '刷新失败时必须说明这是上次成功的数据、并带上它自己的时间（不能只写"本地缓存"）',
  )
})

test('周期记忆：抽屉关掉再打开保持同一周期', () => {
  assert.equal(rememberedTab(), 'trend', '默认分时')
  rememberTab('day')
  assert.equal(rememberedTab(), 'day')
  rememberTab('trend')
})

test('复权口径进缓存键：前复权与不复权是两份数据，切回来不重拉、也不互相顶替', async () => {
  const seen: Array<{ secid: string; tab: ChartTab; fqt: number }> = []
  const cache = createChartCache(async (secid, tab, fqt) => {
    seen.push({ secid, tab, fqt })
    return { kind: 'kline', tab: 'day', kline: { ...klineOf(), fqt } } as ChartPayload
  })
  const qfq = await cache.get('1.600519', 'day', 1)
  const bfq = await cache.get('1.600519', 'day', 0)
  assert.equal(seen.length, 2, '两种口径必须各发一次请求')
  assert.deepEqual(seen.map((s) => s.fqt), [1, 0])
  assert.equal((qfq as { kline: { fqt: number } }).kline.fqt, 1)
  assert.equal((bfq as { kline: { fqt: number } }).kline.fqt, 0)
  const again = await cache.get('1.600519', 'day', 1)
  assert.equal(seen.length, 2, '切回前复权必须命中缓存，不得再发请求')
  assert.equal(again?.fromCache, true)
  assert.equal(cache.peek('1.600519', 'day', 0) !== null, true, 'peek 按口径取值')
  assert.equal(cache.peek('1.600519', 'day', 2), null, '没请求过的口径不得命中')
})

test('复权口径只作用于 K 线：分时/五日不分键（切口径不该重拉当日分时）', async () => {
  let calls = 0
  const cache = createChartCache(async (_secid, _tab) => {
    calls += 1
    return { kind: 'trend', tab: 'trend', trend: trendOf() } as ChartPayload
  })
  await cache.get('1.600519', 'trend', 1)
  await cache.get('1.600519', 'trend', 0)
  assert.equal(calls, 1, '分时只有一条序列，两种口径必须共用缓存')
})

test('复权口径：指数/期货说明"不适用"在口径行里（脚注已按用户要求删除）', () => {
  // v0.55.0：K 线脚注整条删除（用户红框）⇒ 这里不再断言 `fqNoteOf`。
  // 复权口径仍在两处可见：口径行（`${mode} · klt … · ${fq} · 截至 …`，指数/期货为"不复权（该标的不适用）"）
  // 与页签行的复权段控（含"不适用"角标）。`（详情头为真实成交价）` 搬到 B/S 标记上，断言见下方那条。
  const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), './QuoteDrawer.tsx'), 'utf8')
  // 先去注释再断言：说明性注释里会**提到**被删的字面量，不去掉就会对注释做断言
  const drawer = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(drawer.includes("不复权（该标的不适用）"), '口径行必须说明指数/期货的复权不适用')
  assert.equal(drawer.includes('fqNoteOf'), false, 'K 线脚注已删：不许再调用 fqNoteOf')
  assert.equal(drawer.includes('MA5/10/30/60'), false, '脚注里的 MA 清单已删（图上图例已有）')
  assert.equal(drawer.includes('滚轮或拖动滑块缩放日期区间'), false, '脚注里的操作说明已删（控件自证）')
  assert.equal(drawer.includes('来自持仓流水'), false, '脚注里的 B/S 笔数已删（持仓页流水已有）')
})

test('复权记忆：按标的记住各自口径，新标的回到全局默认（前复权）', () => {
  assert.equal(fqFor('1.600519'), 1, '默认前复权')
  rememberFq('1.600519', 0)
  assert.equal(fqFor('1.600519'), 0, '同一标的记住上次选择')
  assert.equal(fqFor('0.300750'), 0, '新标的沿用上一次的全局选择')
  rememberFq('0.300750', 2)
  assert.equal(fqFor('1.600519'), 0, '另一只标的的选择不被覆盖')
  rememberFq('0.300750', 1)
})
