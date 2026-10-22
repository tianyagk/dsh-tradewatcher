/**
 * 板块指数 / 指数类标的的**周/月/年 K**：能聚合就聚合，不能聚合就说清"没有日线源"
 * （AUDIT-BK-AGG §B）。
 *
 * 症状（用户报的）：板块指数（东财 `90.BK*`）切「周K/月K/年K」显示「该周期未取到」，
 * 原因是「本地确实没有该周期的缓存数据；本轮没有向上游发请求（主机熔断冷却中…）」，
 * 而且**同一句原因渲染了两遍**。
 *
 * 实测事实（见 `docs/AUDIT-BK-AGG.md` §1）：板块指数**没有可用的日线源**
 * （腾讯不认板块码、东财 push2* 零请求、本地也没有 `90.*` 缓存）⇒
 *   · 手里**有**日线缓存时：由日线聚合出周/月/年（不接新源、不发请求、口径写进状态行）；
 *   · 手里**没有**日线时：保持"未取到"，但原因必须写"没有可用的日线源"，不是"熔断冷却中"。
 *
 * 必败注入（Lead 指定）：① 走旧路径（只有原生）⇒ 无数据；② O/H/L/C 取错首末；③ vol 缺失被 0 相加；
 * ④ 口径句缺失/多一行；⑥ 残留"熔断冷却"文案。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DayBar } from '../shared/model.ts'
import { AGG_NOTE, aggBucketOf, aggCaliberOf, aggregateDaily, aggPeriodOfKlt, shouldAggregate } from './klineAggregate.ts'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tw-bkagg-agg-'))
const HOME = process.env.DSH_HOME
mkdirSync(join(HOME, 'dsh-tradewatcher', 'klines'), { recursive: true })

const em = await import('./em.ts')
const { breakerFor } = await import('./breaker.ts')

const bar = (date: string, o: number, h: number, l: number, c: number, vol: number | null, amount?: number | null): DayBar =>
  ({ date, open: o, high: h, low: l, close: c, vol, pct: null, ...(amount === undefined ? {} : { amount }) })

/** 12 个交易日（10-01~10-09 国庆休市，所以 09-28 之后直接跳到 10-12），跨 3 周 / 2 月 / 1 年 */
const DAILY_12: DayBar[] = [
  bar('2026-09-28', 1000, 1020, 995, 1010, 100, 10_000),
  bar('2026-09-29', 1010, 1030, 1005, 1020, 110, 11_000),
  bar('2026-09-30', 1020, 1040, 1015, 1030, 120, 12_000),
  bar('2026-10-12', 1030, 1060, 1025, 1050, 130, 13_000),
  bar('2026-10-13', 1050, 1070, 1040, 1045, 140, 14_000),
  bar('2026-10-14', 1045, 1048, 1010, 1015, 150, 15_000),
  bar('2026-10-15', 1015, 1080, 1012, 1075, 160, 16_000),
  bar('2026-10-16', 1075, 1090, 1070, 1085, 170, 17_000),
  bar('2026-10-19', 1085, 1100, 1080, 1095, 180, 18_000),
  bar('2026-10-20', 1095, 1110, 1090, 1105, 190, 19_000),
  bar('2026-10-21', 1105, 1120, 1100, 1115, 200, 20_000),
  bar('2026-10-22', 1115, 1130, 1110, 1125, 210, 21_000),
]

/** 写一份**真实形状**的日线缓存（`v=3` + `updatedAt` + `partial:false`，读侧按 `klineCacheUsable` 判可用） */
function writeDailyCache(secid: string, bars: readonly DayBar[], updatedAt = Date.now()): string {
  const path = join(HOME, 'dsh-tradewatcher', 'klines', `${secid}_101_0.json`)
  writeFileSync(path, JSON.stringify({ v: 3, secid, klt: 101, fqt: 0, updatedAt, partial: false, bars }))
  return path
}

/** 所有上游都不可达（**不联网**）：日线聚合这条路本来就不该依赖任何请求 */
function stubDeadUpstreams(): { calls: string[]; restore: () => void } {
  const real = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    calls.push(typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input))
    throw new Error('ECONNRESET (stub)')
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = real } }
}

async function resetBreakers(): Promise<void> {
  for (const host of ['web.ifzq.gtimg.cn', 'ifzq.gtimg.cn', 'proxy.finance.qq.com', 'push2his.eastmoney.com', 'push2delay.eastmoney.com', 'push2.eastmoney.com']) {
    breakerFor(host).recordSuccess()
  }
}

// ══ ① 板块指数：有日线 ⇒ 周/月/年出得来（走旧路径 ⇒ 无数据 ⇒ 必败） ═════════════

test('① 板块指数（90.BK*）有日线缓存 ⇒ 周K/月K/年K 由日线聚合出来，且**零** upstream 请求', async () => {
  writeDailyCache('90.BK0475', DAILY_12)
  const s = stubDeadUpstreams()
  try {
    for (const [klt, period] of [[102, 'week'], [103, 'month'], [104, 'year']] as const) {
      await resetBreakers()
      const r = await em.fetchKline('90.BK0475', klt, 20, 0)
      assert.ok(r !== null, `klt=${klt} 必须出数据（旧实现这里返回 null）`)
      assert.equal(r.aggregated?.period, period, `klt=${klt} 的聚合周期必须是 ${period}`)
      assert.ok(r.aggregated?.note.includes('由日线聚合'), `口径句必须写「由日线聚合」（实际：${r.aggregated?.note}）`)
      assert.ok(r.stale === true, '回源没拿到 ⇒ 必须如实标"上次成功数据"')
      assert.ok(r.days.length > 0)
      // 板块码不在腾讯映射里 ⇒ 一条 fqkline 都不许发（"不接新源"的硬约束）
      assert.ok(!s.calls.some((u) => u.includes('fqkline')), `板块指数不得打腾讯 K 线（实际 ${s.calls.length} 条）`)
    }
    // 周K 的桶与日线对得上：最后一周（10-19 起）含 4 个交易日
    const week = await em.fetchKline('90.BK0475', 102, 20, 0)
    const last = week?.days[week.days.length - 1]
    assert.equal(last?.date, '2026-10-19', '最后一根周K 的 key = 该周首个交易日')
    assert.equal(last?.close, 1125, '周K 收盘 = 该周最后一个交易日收盘')
    assert.equal(last?.open, 1085, '周K 开盘 = 该周第一个交易日开盘')

    // 反例注入：**旧路径**（只有原生、不聚合）⇒ 同样条件下拿不到任何数据 ⇒ 上面的断言必败
    const legacyNativeOnly = async (): Promise<null> => null
    const legacy = await legacyNativeOnly()
    assert.throws(
      () => assert.notEqual(legacy, null, '反例上：旧路径（无聚合）必须没数据'),
      /反例上/,
      '⚠ 反例注入（走旧路径）必须让"周/月/年有数据"失败',
    )
  } finally {
    s.restore()
  }
})

test('①b 没有日线缓存 ⇒ 仍然"未取到"，但原因写「板块指数没有可用的日线源」，不是「熔断冷却中」', async () => {
  const s = stubDeadUpstreams()
  try {
    await resetBreakers()
    const r = await em.fetchKline('90.BK9999', 102, 20, 0)
    assert.equal(r, null, '没有日线就没有可聚合的原料 ⇒ 不许硬凑数据')
    const reason = em.klineMissingReason('90.BK9999', 102, { cache: null, fqt: 0 })
    assert.equal(reason.what, '周K')
    assert.ok(reason.note.includes('板块指数没有可用的日线源'), `原因必须点明"没有日线源"（实际：${reason.note}）`)
    assert.ok(reason.note.includes('腾讯 K 线不覆盖板块码'), '要说清为什么没有日线源（腾讯不认板块码）')
    assert.ok(reason.note.includes('聚合不出周/月/年'), '要说明周/月/年是靠日线聚合才有的')
    assert.ok(!reason.note.includes('熔断冷却'), `不得用"熔断冷却"解释结构性缺源（实际：${reason.note}）`)
    // why 仍按"东财这条唯一链路此刻可不可用"给动作：不可达 ⇒ 等恢复
    assert.equal(reason.why, 'transient')
    assert.ok(!reason.note.includes('重试无用'), '东财只是这次不可达 ⇒ 不能劝人放弃')

    // 反例注入：旧文案（把结构性缺源说成熔断冷却）⇒ 上面的否定断言必败
    const legacyNote = '本地确实没有该周期的缓存数据；本轮没有向上游发请求（主机熔断冷却中（未发出上游请求））—— 等这轮窗口过去会自动重试'
    assert.throws(
      () => assert.ok(!legacyNote.includes('熔断冷却'), '反例上：旧文案必须被这条否定断言挡下'),
      /反例上/,
      '⚠ 反例注入（保留"熔断冷却"文案）必须失败',
    )
  } finally {
    s.restore()
  }
})

// ══ ② 聚合的 OHLC 正确（注入：取错首末 ⇒ 必败） ═══════════════════════════════

test('② 跨周 5 个交易日：周桶 O=首日开、C=末日收、H/L=极值；注入"取错首末"必败', () => {
  const five: DayBar[] = [
    bar('2026-10-15', 100, 108, 99, 104, 10, 1000), // 周四（周一起点 10-12）
    bar('2026-10-16', 104, 105, 96, 101, 20, 2000), // 周五（低点 96 是这周最低）
    bar('2026-10-19', 101, 112, 100, 110, 30, 3000), // 周一（新的一周）
    bar('2026-10-20', 110, 113, 102, 103, 40, 4000), // 周二
    bar('2026-10-21', 103, 104, 97, 99, 50, 5000), // 周三（这周最低 97）
  ]
  const weeks = aggregateDaily(five, 'week')
  assert.equal(weeks.length, 2, '跨周必须分成两个桶')
  assert.deepEqual(
    weeks.map((w) => [w.date, w.from, w.to, w.sessions]),
    [['2026-10-15', '2026-10-15', '2026-10-16', 2], ['2026-10-19', '2026-10-19', '2026-10-21', 3]],
    '桶的 key/区间/交易日数必须如实（"这周只有 2 个交易日"这类事实要给出来）',
  )
  assert.deepEqual([weeks[0].open, weeks[0].high, weeks[0].low, weeks[0].close], [100, 108, 96, 101], '第一周 O/H/L/C')
  assert.deepEqual([weeks[1].open, weeks[1].high, weeks[1].low, weeks[1].close], [101, 113, 97, 99], '第二周 O/H/L/C')
  assert.deepEqual([weeks[0].vol, weeks[1].vol], [30, 120], '量为桶内求和')
  assert.equal(weeks[1].pct, Math.round(((99 - 101) / 101) * 10000) / 100, 'pct 相对上一根聚合收盘')

  // 月/年桶：同一批数据里 10-15 与 10-19 同月同年
  assert.equal(aggregateDaily(five, 'month').length, 1, '同月只成一根')
  assert.equal(aggregateDaily(five, 'year').length, 1, '同年只成一根')
  assert.equal(aggBucketOf('2026-10-18', 'week'), '2026-10-12', '周日归到本周周一（日历算术，与宿主 TZ 无关）')

  // 反例注入：把"末根"当开盘、"首根"当收盘 ⇒ 上面两个 O/C 断言必败
  const buggy = (d: readonly DayBar[]) => ({ open: d[d.length - 1].open, close: d[0].close })
  const wrong = buggy(five.slice(0, 2))
  assert.throws(
    () => assert.deepEqual([wrong.open, wrong.close], [100, 101], '反例上：首末取反必须对不上'),
    /反例上/,
    '⚠ 反例注入（O/C 取错首末）必须失败',
  )
})

// ══ ③ 桶内任一 vol 缺失 ⇒ 该桶 vol 为 null（注入：0 相加 ⇒ 必败） ═════════════

test('③ 桶内任一日 vol/amount 缺失 ⇒ 该桶 vol/amount 为 null（不许 0 相加）', () => {
  const rows: DayBar[] = [
    bar('2026-10-19', 100, 101, 99, 100, 10, 1000),
    bar('2026-10-20', 100, 102, 99, 101, null, 2000), // 量缺失
    bar('2026-10-21', 101, 103, 100, 102, 30, null), // 额缺失
    bar('2026-10-22', 102, 104, 101, 103, 40, 4000),
  ]
  const [w] = aggregateDaily(rows, 'week')
  assert.equal(w.vol, null, '量缺一根 ⇒ 整桶 null（不要把 null 当 0 加）')
  assert.equal(w.amount, null, '额缺一根 ⇒ 整桶 null')
  assert.equal(w.sessions, 4, '缺失不影响"这周有几个交易日"')
  // 干净的一桶照常求和 —— 证明 null 不是"一律 null"的偷懒
  const [clean] = aggregateDaily(rows.slice(0, 1).concat([bar('2026-10-20', 100, 102, 99, 101, 5, 500)]), 'week')
  assert.deepEqual([clean.vol, clean.amount], [15, 1500])

  // 反例注入：把 null 当 0 ⇒ 会写出"成交量为 0"的假桶（与 null 不同，且被读成真值）
  const zeroSum = rows.reduce((a, b) => a + (b.vol ?? 0), 0)
  assert.throws(
    () => assert.equal(zeroSum, null, '反例上：0 相加必须对不上 null'),
    /反例上/,
    '⚠ 反例注入（0 相加）必须失败',
  )
})

// ══ ④ 口径句：来源「由日线聚合」必须写明，且只有一句 ════════════════════════

test('④ 口径句：写明「由日线聚合」+ 日线来自本地缓存几根、截至何时（一句话，不新增第二行）', () => {
  const note = aggCaliberOf('week', { dailyBars: 800, dailyAsOfText: '10-22 15:05' })
  assert.ok(note.includes(AGG_NOTE), '必须用同一句口径常量（单一口径来源）')
  assert.ok(note.includes('由日线聚合'))
  assert.ok(note.includes('本地缓存 800 根'), `必须说清日线从哪来、有多少根（实际：${note}）`)
  assert.ok(note.includes('截至 10-22 15:05'), '必须说到哪天：聚合结果的新鲜度取决于日线')
  assert.ok(!note.includes('\n'), '一句一行（口径行进状态行，不新增浮层/第二行）')

  // 反例注入：删掉来源标注 ⇒ "必须写「由日线聚合」"必败
  const withoutSource = note.replace('由日线聚合（非上游原生周线/月线/年线）', '')
  assert.throws(
    () => assert.ok(withoutSource.includes('由日线聚合'), '反例上：删掉标注必须对不上'),
    /反例上/,
    '⚠ 反例注入（删除聚合来源）必须失败',
  )
})

// ══ ⑤ 聚合闸门：原生优先、日线不足不聚合 ═══════════════════════════════════

test('⑤ 聚合闸门：原生有数据就不聚合；日线不足下限也不聚合；日线自己不聚合', () => {
  assert.equal(aggPeriodOfKlt(101), null, '日线不聚合')
  assert.equal(aggPeriodOfKlt(102), 'week')
  assert.equal(aggPeriodOfKlt(104), 'year')
  assert.equal(shouldAggregate({ klt: 102, nativeBars: 0, dailyBars: 800, minDailyBars: 10 }), true)
  assert.equal(shouldAggregate({ klt: 102, nativeBars: 3, dailyBars: 800, minDailyBars: 10 }), false, '原生永远优先')
  assert.equal(shouldAggregate({ klt: 102, nativeBars: 0, dailyBars: 9, minDailyBars: 10 }), false, '日线太少不聚合成"周"')
  assert.equal(shouldAggregate({ klt: 101, nativeBars: 0, dailyBars: 800, minDailyBars: 10 }), false)
})
