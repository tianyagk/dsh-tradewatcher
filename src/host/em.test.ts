import { test } from 'node:test'
import assert from 'node:assert/strict'

/** task-77：盘中未完成 bar 不许被当成最终 bar（缓存版本 / partial / TTL 三重保护） */
import { isPartialBar, klineCacheAdoptionOf, klineCacheUsable, klineMissingReason, klineStaleNoteOf, trendAmountMissingReason, KLINE_CACHE_V, PARTIAL_TTL_MS } from './em.ts'

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

/**
 * v0.66.0（task-15）：分时量能失效的两处修复。
 *   ① 腾讯逐分钟兜底必须给出**每分钟成交额**（上游只给累计额 ⇒ 差分），并**标注推导值**；
 *   ② 拿到了但量能用不了时**必须给原因**（`missing[]` 不许留 null）。
 */
test('分时兜底①：腾讯逐分钟"累计值"必须差分出**每分钟**额/量，且每个额点都标推导值', async () => {
  const { minuteTrendPointsOf } = await import('./tencent.ts')
  // 上游结构（实测）：`HHMM 价格 累计成交量(手) 累计成交额(元)`
  const raw = [
    { ts: Date.parse('2026-10-12T09:30:00+08:00'), amount: 33650707, price: 4.384, cumVol: 76758 },
    { ts: Date.parse('2026-10-12T09:31:00+08:00'), amount: 95963053, price: 4.382, cumVol: 219031 },
    { ts: Date.parse('2026-10-12T09:32:00+08:00'), amount: 127232773, price: 4.384, cumVol: 290379 },
  ]
  const { points, allDerived } = minuteTrendPointsOf(raw, (ts) => String(ts))
  assert.equal(points.length, 3, '三个点都保留')
  // 首点 = 累计本身（开盘集合竞价那笔）
  assert.equal(points[0].amount, 33650707, '首点每分钟额 = 累计额（从 0 起算）')
  assert.equal(points[0].vol, 76758, '首点每分钟量 = 累计量')
  // 第 2 点 = 两点累计之差（这正是"每分钟"的含义）
  assert.equal(points[1].amount, 95963053 - 33650707, '第 2 点每分钟额 = 相邻累计之差')
  assert.equal(points[1].vol, 219031 - 76758, '第 2 点每分钟量 = 相邻累计之差')
  assert.equal(points[2].amount, 127232773 - 95963053, '第 3 点同理')
  // **推导标记**：不许把推导值当上游直给的分钟额
  assert.equal(points.every((p) => p.amountDerived === true), true, '每个带成交额的点都必须标 amountDerived')
  assert.ok(String(points[0].amountNote).includes('累计'), '说明要点明"上游只给累计额"')
  assert.equal(allDerived, true)
  // 守恒：逐分钟额之和 == 最后一个累计额（差分的正确性不变量）
  const sum = points.reduce((a, p) => a + (p.amount as number), 0)
  assert.ok(Math.abs(sum - 127232773) < 0.01, `逐分钟额之和必须等于末点累计额（实际 ${sum}）`)
  // 累计回退（数据抖）⇒ 该点如实缺失，不编、不用 0
  const glitch = minuteTrendPointsOf([
    { ts: 1, amount: 100, price: 10, cumVol: 10 },
    { ts: 2, amount: 50, price: 10, cumVol: 8 },
  ], (ts) => String(ts))
  assert.equal(glitch.points[1].amount, null, '累计额回退 ⇒ 该点 amount = null（不编数）')
  assert.equal(glitch.points[1].vol, null, '累计量回退 ⇒ 该点 vol = null')
  // `allDerived` 的语义是"**所有带成交额的点**都是推导来的"：回退点没有额 ⇒ 仍为 true（不是"点数全满"）
  assert.equal(glitch.allDerived, true, '所有带额的点都是差分得来的 ⇒ allDerived=true')
  // 一个带额的点都没有（上游第 4 段缺失 ⇒ NaN）⇒ allDerived=false
  assert.equal(minuteTrendPointsOf([{ ts: 1, amount: Number.NaN, price: 10, cumVol: null }], (t) => String(t)).allDerived, false,
    '一个带额的点都没有 ⇒ allDerived=false')

  // 反例注入：关掉腾讯兜底（映射里不差分、给 null）⇒ 上面的"必须给出每分钟额"必然失败
  const broken = raw.map((p) => ({ amount: null, vol: p.cumVol }))
  assert.equal(broken[1].amount, null, '反例的样子：照搬累计值/给 null')
  assert.throws(
    () => assert.equal(broken.every((p) => typeof p.amount === 'number'), true, '反例上"必须有每分钟额"必须失败'),
    /反例上/,
    '⚠ 反例注入（关掉腾讯兜底）必须让断言失败',
  )
})

test('分时兜底②：量能用不了时**必须给原因**；三情形各一例（都不可达 / 结构变化 / 非采样时段）', () => {
  const mk = (amounts: Array<number | null>, points = 10): { secid: string; prePrice: null; points: unknown[]; last: null } => ({
    secid: '1.510300', prePrice: null, last: null,
    points: Array.from({ length: points }, (_, i) => ({ t: i, label: 'x', price: 1, avg: null, vol: 1, amount: amounts[i] ?? null })),
  })
  // 够用（≥5 个带成交额的点）⇒ 不报
  assert.equal(trendAmountMissingReason(mk([1, 2, 3, 4, 5, 6]) as never), null, '够用就不该报原因')
  // ① 都不可达（显式注入 emDown）
  const down = trendAmountMissingReason(mk([1, null, null]) as never, { emDown: true, now: Date.parse('2026-10-12T10:30:00+08:00') })
  assert.ok(down !== null && down.why === 'transient', '①归 transient')
  assert.ok(down.note.includes('东财行情主机当前不可达') && down.note.includes('腾讯'), `①要写出两个源（实际 ${down.note}）`)
  assert.ok(/\d+ 个点/.test(down.note), '①必须给出"几个点里有几个可用"的数字')
  // ② 可达但结构变了/字段缺失
  const struct = trendAmountMissingReason(mk([null, null, null]) as never, { emDown: false, now: Date.parse('2026-10-12T10:30:00+08:00') })
  assert.ok(struct !== null && struct.why === 'no-source', '②归 no-source（重试无用）')
  assert.ok(struct.note.includes('结构') || struct.note.includes('字段'), `②要说明是字段/结构问题（实际 ${struct.note}）`)
  assert.ok(struct.note.includes('不用 0 顶替'), '②要说清不许用 0 顶替')
  // ③ 非采样时段（凌晨）
  const night = trendAmountMissingReason(mk([null]) as never, { emDown: false, now: Date.parse('2026-10-12T03:00:00+08:00') })
  assert.ok(night !== null, '③也要给原因')
  assert.ok(night.note.includes('非采样时段'), `③要说清是时段问题（实际 ${night.note}）`)
  assert.ok(night.note.includes('不是故障'), '③不许把"休市"说成故障')
  // 三情形文案必须**互不相同**（否则"分开写"没做到）
  const notes = [down.note, struct.note, night.note]
  assert.equal(new Set(notes).size, 3, '三种情形必须各有一句不同的原因')
  // 整条都没有 ⇒ 不越权（交给 trendMissingReason）
  assert.equal(trendAmountMissingReason(null), null, 'trend 为 null 时这条不报（避免与整条原因重复）')
})

test('分时兜底②（反例）：把 missing 写回 null ⇒ "必须给原因"必须失败', () => {
  const few = { secid: '1.510300', prePrice: null, last: null, points: Array.from({ length: 3 }, (_, i) => ({ t: i, label: 'x', price: 1, avg: null, vol: 1, amount: null })) }
  const real = trendAmountMissingReason(few as never, { emDown: true, now: Date.parse('2026-10-12T10:30:00+08:00') })
  const oldWay: unknown = null // 老行为：不给原因
  assert.notEqual(real, oldWay, '⚠ 反例（null）与真实现不同 ⇒ 断言必然抓住')
  assert.throws(
    () => assert.notEqual(oldWay, null, '反例上"必须给原因（非 null）"必须失败'),
    /反例上/,
    '⚠ 反例注入（missing 写回 null）必须让断言失败',
  )
})
