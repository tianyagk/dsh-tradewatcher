/**
 * AUDIT-IMPL84：**当日分时吐昨日数据**（真机复现）。
 *
 * 现象（同一标的 1.510300、同一时刻 2026-10-20 09:56）：
 *   · 当日分时 → 242 点、全部属于 **2026-10-19**（labelDay/sessionDay 都是 10-19，staleAt=10-19 17:38:11）
 *   · 五日分时 → 198 点、最后一点 **2026-10-20 10:00**
 * 即：两条链给出不同日期，且界面没有一句「非当日数据」。
 *
 * 根因三条（本文件逐条钉住）：
 *  ① **备用源集不一致**：当日链只有「东财 → 腾讯分钟」，五日链是「新浪 5 分钟 → 腾讯 5 分钟」。
 *     东财熔断 + 腾讯被 WAF 拦回 501 时，当日链只剩 LKG（昨日），五日链仍是当日。
 *  ② **缓存键不含交易日**：`trend:<secid>:<ndays>` 跨日命中 ⇒ 昨天的整场被当今天。
 *  ③ **定稿门控窗口太窄**：`inSession` 从 09:25 起算，09:15–09:25（集合竞价）里
 *     昨天的快照被判"已定稿"复用 5 分钟。
 *  诚实性兜底：非当日数据必须带 `nonSession{day,reason}`，界面第一句就写
 * 「非当日数据（YYYY-MM-DD）：<原因>」（客户端断言在 `client/chartNote.test.ts`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TrendData } from '../shared/model.ts'

// ⚠ 必须在**首次** dataHome() 之前隔离数据目录（em.ts 的 LKG 兜底库会落盘）
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tw-trend-nonsession-'))

const em = await import('./em.ts')
const time = await import('./time.ts')
const note = await import('../client/chartNote.ts')

const DAY_YESTERDAY = '2026-10-19' // 周一
const DAY_TODAY = '2026-10-20' // 周二
const DAY_NEXT = '2026-10-21' // 周三（跨日复用的反例用）
const BJ = (day: string, hhmm: string): number => Date.parse(`${day}T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}+08:00`)

/** 一天的分时（默认 09:30 起、每分钟一点） */
function trendOfDay(day: string, secid: string, startHhmm = '09:30', count = 5): TrendData {
  const [hh, mm] = startHhmm.split(':').map(Number)
  const start = Date.parse(`${day}T${startHhmm}:00+08:00`)
  return {
    secid,
    prePrice: 4.2,
    points: Array.from({ length: count }, (_, i) => {
      const ts = start + i * 60_000
      const t = new Date(ts)
      const label = `${day} ${String((hh + Math.floor((mm + i) / 60)) % 24).padStart(2, '0')}:${String((mm + i) % 60).padStart(2, '0')}`
      return { t, label, price: 4.2 + i * 0.01, avg: null, vol: 100, amount: null }
    }),
    last: 4.24,
  } as unknown as TrendData
}

/** 多日分时（五日链的当日结果）：最后一点 = 当日 10:00 */
function multiDayEnding(day: string, secid: string): TrendData {
  const days = ['2026-10-14', '2026-10-15', '2026-10-16', DAY_YESTERDAY, day]
  const points = days.flatMap((d, di) =>
    Array.from({ length: 3 }, (_, i) => ({
      t: BJ(d, `09:3${i}`),
      label: `${d} 09:3${i}`,
      price: 4.2 + di * 0.01 + i * 0.001,
      avg: null,
      vol: 100,
      amount: null,
    })),
  )
  // 最后一天补一个 10:00 的实时点（模拟"五日链拿到了当日 10:00"）
  points.push({ t: BJ(day, '10:00'), label: `${day} 10:00`, price: 4.25, avg: null, vol: 100, amount: null })
  return { secid, prePrice: null, points, last: 4.25 }
}

const dayOfLabel = (t: TrendData | null): string | null => {
  const last = t?.points[t?.points.length - 1]
  return last === undefined ? null : last.label.slice(0, 10)
}

/**
 * 昨日 17:38:11 写入的 LKG（与真机 `trends-lkg.d/1.510300%7C1.json` 的 `at` 同形）。
 * 每个用例用**自己的 secid**（内存缓存/LKG 都是按 secid 键的，共用会互相污染）。
 */
{
  const dir = join(process.env.DSH_HOME as string, 'dsh-tradewatcher')
  mkdirSync(dir, { recursive: true })
  const seeded = ['1.519901', '1.519902', '1.519903', '1.519904', '1.519905', '1.519906', '1.519907']
  const entries = seeded.flatMap((secid) => [
    { key: `${secid}|1`, at: BJ(DAY_YESTERDAY, '17:38:11').valueOf(), trend: trendOfDay(DAY_YESTERDAY, secid) },
    { key: `${secid}|5`, at: BJ(DAY_YESTERDAY, '17:38:11').valueOf(), trend: multiDayEnding(DAY_YESTERDAY, secid) },
  ])
  // 另有一份**今天 15:06** 写入的定稿快照（⑤(b) 的正例：同日定稿必须仍可复用）
  entries.push({ key: '1.519908|1', at: BJ(DAY_TODAY, '15:06:00').valueOf(), trend: trendOfDay(DAY_TODAY, '1.519908') })
  writeFileSync(join(dir, 'trends-lkg.json'), JSON.stringify({ ts: BJ(DAY_YESTERDAY, '17:38:11'), entries }), 'utf8')
}

// ───────────────────────── 断言 1：交易时段内，当日分时的最后一点必须是当日 ─────────────────────────

test('① 交易时段内：当日分时的最后一点 == 当日（跨交易日不得复用内存缓存）', async () => {
  const secid = '1.519901'
  const calls: string[] = []
  const now = BJ(DAY_TODAY, '10:00')
  const got = await em.fetchTrend(secid, 1, {
    now,
    archive: false,
    upstream: async () => {
      calls.push('upstream')
      return trendOfDay(DAY_TODAY, secid)
    },
  })
  assert.equal(dayOfLabel(got), DAY_TODAY, '交易时段内当日分时必须是今天的序列')
  assert.equal(got?.sessionDay, undefined, '当日数据不需要"非当日"标注')
  assert.equal(got?.nonSession, undefined)
  assert.equal(got?.stale, undefined, '实时数据不得标 stale')

  // 同一 secid、第二天同一时刻：旧的"无日期键"会命中昨天的缓存（60s TTL 内），新的必须 miss
  const before = calls.length
  const next = await em.fetchTrend(secid, 1, {
    now: BJ(DAY_NEXT, '10:00'),
    archive: false,
    upstream: async () => {
      calls.push('upstream')
      return trendOfDay(DAY_NEXT, secid)
    },
  })
  assert.equal(calls.length, before + 1, '跨交易日必须重新回源（不得命中前一天的内存缓存）')
  assert.equal(dayOfLabel(next), DAY_NEXT)

  // 缓存键本身：带交易日 ⇒ 昨天的键与今天不同
  assert.notEqual(
    em.trendCacheKey(secid, 1, BJ(DAY_YESTERDAY, '15:00')),
    em.trendCacheKey(secid, 1, BJ(DAY_TODAY, '10:00')),
    '缓存键必须含交易日',
  )
})

/** 反例注入（必败）：把缓存键的日期去掉 ⇒ 昨日条目会在今天被命中 ⇒ 上一条断言必败 */
test('① 反例：缓存键去掉交易日 ⇒ "最后一点是当日"必败', () => {
  const secid = '1.519901'
  const todayNow = BJ(DAY_TODAY, '10:00')
  const yesterdayPayload = trendOfDay(DAY_YESTERDAY, secid)
  // 修复前的键：`trend:<secid>:<ndays>`（只有 secid 与档位）
  const oldKey = `trend:${secid}:1`
  const oldCache = new Map<string, TrendData>([[oldKey, yesterdayPayload]])
  const served = oldCache.get(oldKey)
  assert.notEqual(served, undefined, '旧键在跨日后仍然命中（这就是真机现象）')
  assert.equal(dayOfLabel(served ?? null), DAY_YESTERDAY, '旧键吐出来的正是昨天那一场')
  assert.throws(
    () => assert.equal(dayOfLabel(served ?? null), DAY_TODAY, '当日分时必须是今天的序列'),
    /2026-10-19/,
    '⚠ 反例（键不含日期）必须让"当日分时是今天的"断言失败（实际吐的是 2026-10-19）',
  )
  // 新键在跨日后必然 miss
  assert.equal(oldCache.get(em.trendCacheKey(secid, 1, todayNow)), undefined, '新键（含交易日）跨日必然 miss')
})

// ───────────────── 断言 2：同一时刻，当日分时的数据时刻不得早于五日分时 ─────────────────

test('② 同一时刻：当日分时的数据时刻不得早于五日分时（两条链同源优先序）', async () => {
  const secid = '1.519902'
  const now = BJ(DAY_TODAY, '10:05')

  // 五日链：注入多日源（覆盖到当日 10:00）
  const five = await em.fetchTrend(secid, 5, {
    now,
    archive: false,
    upstream: async () => multiDayEnding(DAY_TODAY, secid),
  })
  assert.equal(dayOfLabel(five), DAY_TODAY, '五日链最后一天必须是当日')

  // 当日链：东财不可达；备用链第一源（新浪）也挂，第二源（腾讯）给当日 —— 必须用当日，不许吃昨日 LKG
  let secondCalled = 0
  const one = await em.fetchTrend(secid, 1, {
    now,
    archive: false,
    upstream: async () => {
      throw new Error('selftest: 东财 trends2 熔断')
    },
    minuteSources: [
      { key: 'sina-minute', label: '新浪分钟', fetch: async () => null },
      {
        key: 'tencent-minute',
        label: '腾讯分钟',
        fetch: async () => {
          secondCalled += 1
          return trendOfDay(DAY_TODAY, secid, '09:30', 30)
        },
      },
    ],
  })
  assert.equal(secondCalled, 1, '备用链必须逐个源尝试（第一源挂了要接着试第二源）')
  assert.equal(dayOfLabel(one), DAY_TODAY, '当日链拿到当日数据时不许回落到昨日 LKG')
  assert.equal(one?.sessionDay, undefined, '当日数据不标非当日')

  // 核心断言：同一时刻两条链的"数据日期"必须一致
  const dayOfOne = dayOfLabel(one)
  const dayOfFive = dayOfLabel(five)
  assert.equal(dayOfOne, dayOfFive, '同一时刻两条链不得给出不同日期')

  // 源集合一致（同源优先序的结构性保证）：当日链与五日链的**提供者顺序**必须相同
  const providerOrder = (keys: readonly string[]): string[] => keys.map((k) => k.split('-')[0])
  assert.deepEqual(
    providerOrder(em.minuteFallbackSources().map((s) => s.key)),
    providerOrder(em.multiDayMinuteSources()),
    '当日链与五日链必须同源同序（新浪 → 腾讯）',
  )
})

/** 反例注入（必败）：当日链只问一个源（修复前的实现）⇒ 回落昨日 LKG ⇒ 上一条断言必败 */
test('② 反例：备用链只剩一个源（腾讯）⇒ "两条链同日"必败', async () => {
  const secid = '1.519903'
  const now = BJ(DAY_TODAY, '10:05')
  const five = await em.fetchTrend(secid, 5, { now, archive: false, upstream: async () => multiDayEnding(DAY_TODAY, secid) })
  const one = await em.fetchTrend(secid, 1, {
    now,
    archive: false,
    upstream: async () => {
      throw new Error('selftest: 东财 trends2 熔断')
    },
    // 修复前：只有腾讯一家（本机实测被 WAF 拦回 501 页 ⇒ 直接掉到 LKG）
    minuteSources: [{ key: 'tencent-minute', label: '腾讯分钟', fetch: async () => null }],
  })
  assert.equal(dayOfLabel(one), DAY_YESTERDAY, '反例现场：当日链只能吃昨日兜底')
  assert.throws(
    () => assert.equal(dayOfLabel(one), dayOfLabel(five)),
    /2026-10-19|2026-10-20/,
    '⚠ 反例（备用链只有一个源）必须让"两条链同日"断言失败',
  )
})

// ───────────────────────── 断言 3：非当日数据必须带「非当日」+ 原因 ─────────────────────────

test('③ 非当日数据必须带 day + reason（界面据此写「非当日数据（YYYY-MM-DD）：原因」）', async () => {
  const secid = '1.519904'
  const now = BJ(DAY_TODAY, '10:05')
  const got = await em.fetchTrend(secid, 1, {
    now,
    archive: false,
    upstream: async () => {
      throw new Error('selftest: 东财 trends2 熔断')
    },
    minuteSources: [
      { key: 'sina-minute', label: '新浪分钟', fetch: async () => null },
      { key: 'tencent-minute', label: '腾讯分钟', fetch: async () => null },
    ],
  })
  assert.ok(got !== null, '有 LKG 时必须给出数据（不是 null）')
  assert.equal(got.sessionDay, DAY_YESTERDAY, '非当日必须给出数据所属交易日')
  assert.equal(got.nonSession?.day, DAY_YESTERDAY)
  assert.equal(typeof got.nonSession?.reason, 'string')
  assert.ok((got.nonSession?.reason ?? '').length > 0, '非当日必须给原因（不能只给日期）')
  assert.match(got.nonSession?.detail ?? '', /东财 trends2/, '完整原因要点名是哪条链没取到')
  assert.equal(got.stale, true, 'LKG 兜底必须标 stale')
  assert.equal(typeof got.asOf, 'number', '必须给数据观测时刻（与响应时刻分开）')

  // 客户端那句必须是「非当日数据（YYYY-MM-DD）：原因」（全年份 + 原因）
  const line = note.cacheNoteOf({ kind: 'trend', trend: got })
  assert.ok(line.startsWith(` · 非当日数据（${DAY_YESTERDAY}）`), `脚注第一句必须是非当日（实际：${line}）`)
  assert.ok(line.includes(got.nonSession?.reason ?? '<none>'), '原因必须常驻可见')
})

/** 反例注入（必败）：去掉非当日标注 ⇒ 界面那句话就没了 ⇒ 上一条断言必败 */
test('③ 反例：去掉 nonSession/sessionDay ⇒ 「非当日」标注消失 ⇒ 断言必败', async () => {
  const secid = '1.519905'
  const now = BJ(DAY_TODAY, '10:05')
  const got = await em.fetchTrend(secid, 1, {
    now,
    archive: false,
    upstream: async () => {
      throw new Error('selftest: 东财 trends2 熔断')
    },
    minuteSources: [{ key: 'tencent-minute', label: '腾讯分钟', fetch: async () => null }],
  })
  // 反例：把这两个字段摘掉（= 修复前的回包形状）
  const stripped: TrendData = { ...(got as TrendData) }
  delete stripped.nonSession
  delete stripped.sessionDay
  const oldLine = note.cacheNoteOf({ kind: 'trend', trend: stripped })
  assert.equal(oldLine.startsWith(' · 非当日数据'), false, `修复前的回包不会出现"非当日"（实际：${oldLine}）`)
  assert.throws(
    () => assert.ok(oldLine.startsWith(` · 非当日数据（${DAY_YESTERDAY}）`), '非当日必须常驻'),
    /非当日必须常驻/,
    '⚠ 反例（回包不带 nonSession/sessionDay）必须让"非当日必须常驻"断言失败',
  )
})

// ───────────────────────── 断言 4：交易时段内不得判「定稿」 ─────────────────────────

test('④ 交易窗口（09:15–15:05，含集合竞价/午休/收盘瞬时）内不得判定稿；非交易时段才可免回源', () => {
  const atYesterday = BJ(DAY_YESTERDAY, '17:38:11')
  // 交易窗口内：一律不判"已定稿"（旧实现 09:15–09:25 会判成定稿，从而复用昨天的图）
  for (const hhmm of ['09:15', '09:16', '09:20', '09:25', '10:00', '11:30', '12:30', '14:59', '15:00', '15:04']) {
    assert.equal(
      time.isSettledOffline(atYesterday, BJ(DAY_TODAY, hhmm)),
      false,
      `${hhmm} 在交易窗口内，不得判定稿（否则会复用昨天的快照）`,
    )
  }
  // 非交易时段：照旧可以免回源（这条不许被上面的改动破坏）
  assert.equal(time.isSettledOffline(BJ(DAY_TODAY, '15:06'), BJ(DAY_TODAY, '20:00')), true, '收盘后：纯本地定稿')
  assert.equal(time.isSettledOffline(BJ(DAY_YESTERDAY, '17:38:11'), BJ(DAY_YESTERDAY, '20:00')), true, '昨晚的序列今晚仍是定稿')
  assert.equal(time.isSettledOffline(0, BJ(DAY_YESTERDAY, '20:00')), false, '没有快照不成立')

  // 端到端：09:20（集合竞价）不许走"定稿复用"，必须回源
  const secid = '1.519906'
  let upstreamCalls = 0
  return em
    .fetchTrend(secid, 1, {
      now: BJ(DAY_TODAY, '09:20'),
      archive: false,
      upstream: async () => {
        upstreamCalls += 1
        return trendOfDay(DAY_TODAY, secid, '09:15', 3)
      },
    })
    .then((got) => {
      assert.equal(upstreamCalls, 1, '集合竞价期间必须回源（不得拿昨天的"定稿"顶上）')
      assert.equal(dayOfLabel(got), DAY_TODAY, '集合竞价期间拿到的就是当日')
    })
})

/** 反例注入（必败）：门控恢复成旧口径（`inSession` 从 09:25 起算）⇒ 09:20 会被判定稿 ⇒ 必败 */
test('④ 反例：门控用旧窗口（09:25 起）⇒ 09:20 判成定稿 ⇒ 断言必败', () => {
  const atYesterday = BJ(DAY_YESTERDAY, '17:38:11')
  const now = BJ(DAY_TODAY, '09:20')
  // 修复前的判据（逐字等价于旧 isSettledOffline）
  const oldSettledOffline = (cacheUpdatedAt: number, ts: number): boolean =>
    !time.inSession(ts) && Number.isFinite(cacheUpdatedAt) && cacheUpdatedAt > 0 && cacheUpdatedAt >= time.lastCloseBoundary(ts)
  assert.equal(time.inSession(now), false, '旧 inSession 在 09:20 认为"还没开盘"（正是漏判的来源）')
  assert.equal(oldSettledOffline(atYesterday, now), true, '修复前：09:20 会把昨天的快照判成"已定稿"')
  assert.throws(
    () => assert.equal(oldSettledOffline(atYesterday, now), false, '交易窗口内不得判定稿'),
    /交易窗口内不得判定稿/,
    '⚠ 反例（旧窗口）必须让"交易时段内不得判定稿"断言失败',
  )
  // 新实现同一时刻为 false
  assert.equal(time.isSettledOffline(atYesterday, now), false)
})

// ───────────────────────── 断言 5：缓存跨日不复用（含 LKG 定稿复用） ─────────────────────────

test('⑤ 缓存跨日不复用：昨天的快照不得当今天的「定稿」；同一天的定稿仍复用', async () => {
  // (a) 昨天 17:38 的快照，今天 20:00（收盘后）——**不是**今天的定稿 ⇒ 必须回源
  const secid = '1.519907'
  const calls: string[] = []
  const got = await em.fetchTrend(secid, 1, {
    now: BJ(DAY_TODAY, '20:00'),
    archive: false,
    upstream: async () => {
      calls.push('upstream')
      return trendOfDay(DAY_TODAY, secid, '09:30', 3)
    },
  })
  assert.equal(calls.length, 1, '跨日后不得把昨天的快照当"今天的定稿"复用（必须回源）')
  assert.equal(dayOfLabel(got), DAY_TODAY)
  assert.equal(got?.cached, undefined, '这不是"休市定稿复用"')

  // (b) 同一份快照若写于**今天收盘之后**（15:06），20:00 就该复用（此路不许被改坏）
  const secid2 = '1.519908'
  let upstreamCalls = 0
  const settled = await em.fetchTrend(secid2, 1, {
    now: BJ(DAY_TODAY, '20:00'),
    archive: false,
    upstream: async () => {
      upstreamCalls += 1
      return trendOfDay(DAY_TODAY, secid2, '09:30', 3)
    },
  })
  assert.equal(upstreamCalls, 0, '今天的序列在收盘后已定稿 ⇒ 0 回源')
  assert.equal(settled?.cached, true, '定稿复用必须如实标注 cached')
  assert.equal(dayOfLabel(settled), DAY_TODAY)

  // (c) 纯判据：同一份"今天 15:06"的快照，第二天 10:00 不再是定稿
  assert.equal(time.isSettledOffline(BJ(DAY_TODAY, '15:06'), BJ(DAY_TODAY, '20:00')), true)
  assert.equal(time.isSettledOffline(BJ(DAY_TODAY, '15:06'), BJ(DAY_NEXT, '10:00')), false, '跨日后不许复用')
})

/** 反例注入（必败）：把"跨日"当同一天（旧键/旧门控）⇒ 命中昨天 ⇒ 断言必败 */
test('⑤ 反例：键与门控都不看日期 ⇒ 跨日仍命中 ⇒ 必败', () => {
  const secid = '1.519905'
  const oldKey = `trend:${secid}:1`
  const memo = new Map<string, TrendData>([[oldKey, trendOfDay(DAY_YESTERDAY, secid)]])
  const hitYesterday = memo.get(oldKey)
  assert.notEqual(hitYesterday, undefined)
  assert.throws(
    () => assert.equal(dayOfLabel(hitYesterday ?? null), DAY_TODAY, '跨日不得复用'),
    /2026-10-19|2026-10-20/,
    '⚠ 反例（键不含日期）必须让"跨日不复用"断言失败',
  )
  // 新键：不命中
  assert.equal(memo.get(em.trendCacheKey(secid, 1, BJ(DAY_TODAY, '10:00'))), undefined)
})
