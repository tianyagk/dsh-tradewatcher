import { test } from 'node:test'
import assert from 'node:assert/strict'

/** task-77：盘中未完成 bar 不许被当成最终 bar（缓存版本 / partial / TTL 三重保护） */
import { isPartialBar, klineCacheAdoptionOf, klineCacheUsable, klineMissingReason, klineStaleNoteOf, KLINE_CACHE_V, PARTIAL_TTL_MS } from './em.ts'

test('task-77：09:33 抓到的当日 bar 判为未完成；收盘后抓到的同日 bar 判为最终', () => {
  const night = Date.parse('2026-10-09T22:30:00+08:00')
  const morning = Date.parse('2026-10-09T09:33:00+08:00')
  const afterClose = Date.parse('2026-10-09T15:30:00+08:00')
  assert.equal(isPartialBar('2026-10-09', morning), true, '盘中 09:33 ⇒ 未完成 bar')
  assert.equal(isPartialBar('2026-10-09', afterClose), false, '收盘后 ⇒ 最终 bar（可缓存）')
  assert.equal(isPartialBar('2026-10-09', night), false, '隔天夜里读到同日 bar ⇒ 已是最终')
  assert.equal(isPartialBar('2026-10-08', night), false, '不是当日的 bar ⇒ 与 partial 无关')
})

test('task-77：缓存可用性三闸（版本 / partial TTL）', () => {
  const now = Date.parse('2026-10-12T10:00:00+08:00')
  // ① 旧版本（v2 及以前可能冻着未完成 bar）⇒ 一律不采用
  const old = klineCacheUsable({ v: 2, partial: false, updatedAt: now - 1000 }, now)
  assert.equal(old.usable, false, 'v2 文件必须被忽略（含未完成 bar 的那份就在其中）')
  assert.ok((old.reason ?? '').includes('v2'), '理由要写清版本不符')
  // ② v3 + partial 且超 TTL ⇒ 必须回源
  const stale = klineCacheUsable({ v: KLINE_CACHE_V, partial: true, updatedAt: now - PARTIAL_TTL_MS - 1 }, now)
  assert.equal(stale.usable, false, '未完成 bar 超 TTL ⇒ 回源重取')
  assert.equal(stale.partial, true)
  // ③ v3 + partial 且在 TTL 内 ⇒ 可用（但仍标记 partial）
  const fresh = klineCacheUsable({ v: KLINE_CACHE_V, partial: true, updatedAt: now - 1000 }, now)
  assert.equal(fresh.usable, true)
  assert.equal(fresh.partial, true, 'TTL 内可用但仍要如实标 partial')
  // ④ v3 + 非 partial ⇒ 可用
  const final = klineCacheUsable({ v: KLINE_CACHE_V, partial: false, updatedAt: now - 86_400_000 }, now)
  assert.equal(final.usable, true)
  assert.equal(final.partial, false)
  // ⑤ 缺字段（更老的文件）⇒ 不采用
  assert.equal(klineCacheUsable({}, now).usable, false, '没有版本标记 ⇒ 不采用')
})

/**
 * v0.63.0（task-11）：**缓存被判"需要回源"时不许整段丢弃**。
 *
 * 用户报「筹码分布突然样本不足」的真因：缓存里 900+ 根已完成历史 + 最后一根未完成 bar，
 * 当未完成 bar 超过 60s TTL 且回源失败时，老实现把整段判为不可用 ⇒ 0 根 ⇒ 报样本不足。
 * 手里有历史却报缺数据 = 丢数据。
 */
const barOf = (i: number): { date: string; open: number; close: number; high: number; low: number; vol: number; pct: number } => ({
  date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
  open: 10 + i * 0.1, close: 10.1 + i * 0.1, high: 10.2 + i * 0.1, low: 9.9 + i * 0.1, vol: 1000 + i, pct: 0.5,
})
const barsOf = (n: number): ReturnType<typeof barOf>[] => Array.from({ length: n }, (_, i) => barOf(i))
/** 超 TTL 的未完成 bar 缓存（meta 部分；bars 单独传，与真实读取路径一致） */
const EXPIRED = (): Record<string, unknown> => ({
  v: KLINE_CACHE_V, partial: true, updatedAt: Date.now() - PARTIAL_TTL_MS - 60_000,
})

test('降级采纳①：v3 + 未完成 bar 超 TTL + 300 根历史 ⇒ 采用 299 根（丢最后一根），而不是 0 根', () => {
  const now = Date.now()
  const d = klineCacheAdoptionOf({ meta: EXPIRED(), bars: barsOf(300), now })
  assert.equal(d.adopt, true, '必须采用（老实现这里 adopt=false ⇒ 0 根 ⇒ 报样本不足）')
  assert.equal(d.dropLast, true, '不可信的最后一根要丢掉')
  assert.equal(d.usableBars, 299, '采用 299 根已完成 bar')
  assert.equal(d.fileBars, 300, '记账：文件里 300 根')
  assert.ok(d.refusedReason !== null && d.refusedReason.includes('TTL'), `拒绝原因要具体（实际 ${d.refusedReason}）`)
  assert.ok(d.degradedReason !== null && d.degradedReason.includes('降级采用'), '要留下降级采用的说明')
  // 反例注入：老实现=被拒就整段丢弃 ⇒ 这条断言必须失败
  const oldWay = { adopt: false, usableBars: 0, fileBars: 300 }
  assert.throws(
    () => assert.equal(oldWay.adopt, true, '反例上"必须采用"必须失败'),
    /反例上/,
    '⚠ 反例注入（改回整段丢弃）必须让"必须采用"这条断言失败',
  )
})

test('降级采纳②：根数不足下限 ⇒ 如实不采用（不许硬凑）；TTL 内/正常缓存行为不变', () => {
  const now = Date.now()
  const few = klineCacheAdoptionOf({ meta: EXPIRED(), bars: barsOf(5), now })
  assert.equal(few.adopt, false, '丢掉最后一根后只剩 4 根 < 10 ⇒ 不采用（样本不足照实说）')
  assert.equal(few.usableBars, 4)
  const fresh = klineCacheAdoptionOf({ meta: { ...EXPIRED(), updatedAt: now - 1000 }, bars: barsOf(300), now })
  assert.equal(fresh.adopt, true)
  assert.equal(fresh.dropLast, false, 'TTL 内 ⇒ 最后一根照用（正常路径不变）')
  assert.equal(fresh.usableBars, 300)
  assert.equal(fresh.refusedReason, null, '没被拒 ⇒ 没有拒绝原因')
  const finalBars = klineCacheAdoptionOf({ meta: { v: KLINE_CACHE_V, partial: false, updatedAt: now - 86_400_000 }, bars: barsOf(300), now })
  assert.equal(finalBars.adopt, true)
  assert.equal(finalBars.dropLast, false, '已完成的旧缓存（partial=false）不受 TTL 影响：一根都不丢')
  assert.equal(finalBars.usableBars, 300)
})

test('降级采纳③：旧 schema（v2）也走"丢最后一根后用其余"（同一类丢数据），根数不足则不采用', () => {
  const now = Date.now()
  const d = klineCacheAdoptionOf({ meta: { v: 2, partial: false, updatedAt: now - 1000 }, bars: barsOf(300), now })
  assert.equal(d.adopt, true, 'v2 有 300 根 ⇒ 不许还返回 0 根')
  assert.equal(d.dropLast, true, 'v2 的最后一根可能是冻住的未完成 bar ⇒ 丢掉（红线：不与最终 bar 混用）')
  assert.equal(d.usableBars, 299)
  assert.ok((d.refusedReason ?? '').includes('schema'), `理由要说明是版本问题（实际 ${d.refusedReason}）`)
  const tiny = klineCacheAdoptionOf({ meta: { v: 2, partial: false, updatedAt: now - 1000 }, bars: barsOf(9), now })
  assert.equal(tiny.adopt, false, '9 根丢 1 根 = 8 < 10 ⇒ 不采用')
})

test('降级说明：只在"用了被拒缓存 且 回源没拿到新数据"时给；正常/定稿都不给', () => {
  const degraded = '未完成 bar 已超过 60s TTL ⇒ 回源重取；…降级采用（不回源成功也照用）'
  const n1 = klineStaleNoteOf({ settled: false, stale: true, degradedReason: degraded, droppedLast: true, usableBars: 299 })
  assert.ok(n1 !== null, '降级 + 回源失败 ⇒ 必须给说明')
  assert.ok(n1.includes('299') && n1.includes('已完成 bar'), `要点明用的是多少根已完成 bar（实际 ${n1}）`)
  assert.ok(n1.includes('未完成'), '要点明最后一根未完成（用户要能看到原因）')
  assert.equal(klineStaleNoteOf({ settled: false, stale: false, degradedReason: degraded, droppedLast: true, usableBars: 299 }), null,
    '回源成功 ⇒ 用新数据、不标 stale、不给说明（行为不变）')
  assert.equal(klineStaleNoteOf({ settled: true, stale: false, degradedReason: degraded, droppedLast: true, usableBars: 299 }), null,
    '休市定稿免回源 ⇒ 不是降级，不给说明')
  assert.equal(klineStaleNoteOf({ settled: false, stale: true, degradedReason: null, droppedLast: false, usableBars: 299 }), null,
    '正常缓存 + 回源失败（非降级）⇒ 不套用这句')
})

test('note 三情形必须区分：无缓存 / 缓存被判不可用（写具体原因）/ 回源失败', () => {
  const down = { emDown: true }
  // ① 从未有缓存
  const none = klineMissingReason('1.600519', 101, { ...down, cache: null })
  assert.ok(none.note.includes('本地确实没有该周期的缓存数据'), `①要直说没有缓存（实际 ${none.note}）`)
  assert.equal(none.note.includes('被判不可用'), false, '①不许说"被判不可用"')
  // ② 有缓存但被判不可用 —— 必须写出**具体原因**，且不许再说"本地没有该周期的缓存"
  const refused = klineMissingReason('1.600519', 101, {
    ...down,
    cache: { exists: true, fileBars: 4, usableBars: 0, refusedReason: '未完成 bar 已超过 60s TTL ⇒ 回源重取', degraded: false, minBars: 10 },
  })
  assert.ok(refused.note.includes('本地有该周期的缓存') && refused.note.includes('被判不可用'), `②要说清"有但不可用"（实际 ${refused.note}）`)
  assert.ok(refused.note.includes('60s TTL'), '②必须带**具体原因**（不是一句话概括）')
  assert.equal(refused.note.includes('本地没有该周期的缓存'), false, '⚠ 那句与事实不符的话不许再出现（要么"确实没有"，要么"有但不可用"）')
  assert.equal(refused.note.includes('本地确实没有'), false, '②不许说"确实没有"')
  // ③ 回源失败（可辨认）
  assert.ok(none.note.includes('东财行情主机当前不可达'), '③要有回源失败的说明')
  assert.equal(none.why, 'transient', '③归因为 transient（等恢复）')
  const noSource = klineMissingReason('1.600519', 101, { emDown: false, cache: null })
  assert.ok(noSource.note.includes('都可达但没有返回'), '可达但没数据 ⇒ 另一句（no-source）')
  assert.equal(noSource.why, 'no-source')
})
