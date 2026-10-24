/**
 * 国际品种（`122.*`，伦敦金现 `122.XAU`）当日分时的**源与滞后**断言（AUDIT-INTL-MINUTE）。
 *
 * 症状（用户 2026-10-24 19:14 实测）：实时卡显示 `实时 · 来源 sina · 19:04`，而分时图标签写
 * 「截至 10-21 14:08」—— 分时链只有东财 `trends2` 一条源，东财对该标的不回数据时整条链落到
 * `trends-lkg` 的旧快照（10-21），却仍在图上当"当日分时"展示。
 *
 * 判据（每条都配反例注入）：
 *   ① 最后一点早于「现在 − 15 分钟」⇒ 回包带 `lagMinutes/lagReason`（不标 ⇒ 必败）
 *   ② 有可用当日源时，最后一点与现在差 ≤15 分钟（仍落旧链 ⇒ 必败）
 *   ③ 分时回包必含 `source` 与 `at`（缺 ⇒ 必败）
 *   ④ 无任何源可用 / 只有旧数据 ⇒ 明确原因，旧曲线不得冒充当日（冒充 ⇒ 必败）
 *
 * 隔离：`DSH_HOME` 指到临时目录；上游一律 `globalThis.fetch` 打桩（零真实请求）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tw-intlmin-home-'))

const em = await import('./em.ts')
const { breakerFor } = await import('./breaker.ts')
const { parseMarketStamp, dayOf } = await import('./time.ts')
const { parseSinaGlobalMin } = await import('./sina.ts')

const HOSTS = ['push2his.eastmoney.com', 'push2delay.eastmoney.com', 'push2.eastmoney.com', 'stock2.finance.sina.com.cn']

interface Stub { calls: string[]; restore: () => void }

/** 新浪「全球期货分时」的真实回包形状（表头 + 逐点；量/额恒 0 ⇒ 解析成 null） */
function globalPayload(rows: ReadonlyArray<readonly [string, number, number | null]>): string {
  const body = {
    minLine_1d: [
      ['2026-10-24', '4024.260', 'LIFFE', '', rows[0]?.[0].slice(11, 16) ?? '04:50', String(rows[0]?.[1] ?? 0), '0', '0', '0', rows[0]?.[0] ?? ''],
      ...rows.map(([stamp, price, avg]) => [stamp.slice(11, 16), String(price), '0', '0', avg === null ? '0' : String(avg), stamp]),
    ],
  }
  return `/*<script>location.href='//sina.com';</script>*/var t=(${JSON.stringify(body)});`
}

/** 三行 fixture：2026-10-24 04:50 / 04:51 / 04:53（北京时间），均价与价格一致 */
const ROWS: ReadonlyArray<readonly [string, number, number | null]> = [
  ['2026-10-24 04:50:00', 3993.1, 3993.1],
  ['2026-10-24 04:51:00', 3993.69, 3993.865],
  ['2026-10-24 04:53:00', 3996.8, 3996.8],
]
const LAST_T = parseMarketStamp('2026-10-24 04:53:00')

function stub(opts: { sina?: string | null } = {}): Stub {
  const real = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)
    calls.push(url)
    const host = new URL(url).host
    if (host === 'stock2.finance.sina.com.cn') {
      const body = opts.sina ?? globalPayload(ROWS)
      const buf = new TextEncoder().encode(body)
      return { ok: true, status: 200, arrayBuffer: async () => buf.buffer, text: async () => body, json: async () => JSON.parse(body) } as unknown as Response
    }
    throw new Error(`ECONNRESET (stub: ${host} 不可达)`)
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = real } }
}

function resetBreakers(): void {
  for (const h of HOSTS) breakerFor(h).recordSuccess()
}

// ══ ② + ③ 有可用当日源 ⇒ 最后一点贴近现在，且回包带 source/at ═══════════════════

test('② 有可用当日源时最后一点距现在 ≤15 分钟（注入：仍走旧链 ⇒ 必败）；③ 回包必含 source 与 at', async () => {
  resetBreakers()
  const now = LAST_T + 2 * 60_000 // 取数时刻比最后一点晚 2 分钟
  const s = stub()
  try {
    const t = await em.fetchTrend('122.XAG', 1, { now })
    assert.ok(t !== null, '有源可用时必须给序列')
    assert.equal(t.source, 'sina-global-min', '来源必须是新浪全球期货分时（东财对该标的不回数据）')
    const last = t.points[t.points.length - 1] as { t: number; label: string; price: number }
    assert.equal(last.t, LAST_T)
    assert.equal(last.label, '2026-10-24 04:53')
    assert.equal(last.price, 3996.8)
    const behindMin = Math.round((now - last.t) / 60_000)
    assert.ok(behindMin <= 15, `最后一点与现在的差必须 ≤15 分钟（实际 ${behindMin}）`)
    // ③ 出处字段
    assert.equal(typeof t.source, 'string')
    assert.equal(typeof t.at, 'number', '回包必须有本次取数时刻 at')
    assert.equal(t.at, now)
    assert.equal(t.lagMinutes, undefined, '不滞后时不得给 lagMinutes（否则每张图都挂着"滞后"）')
    // 量/额如实为 null（上游不提供）
    assert.equal(t.points[0]?.vol, null)
    assert.equal(t.points[0]?.amount, null)
    // 反例注入：仍走"只有东财 trends2"的旧链 ⇒ 最后一点会是 10-21（≈4000 分钟前）⇒ ②必败
    const legacyBehindMin = Math.round((now - parseMarketStamp('2026-10-21 14:08:00')) / 60_000)
    assert.ok(legacyBehindMin > 15, '前置：旧链最后一点确实远离现在')
    assert.throws(
      () => assert.ok(legacyBehindMin <= 15, '反例上：旧链不可能 ≤15 分钟'),
      /反例上/,
      '⚠ 反例注入（仍走旧链）必须失败',
    )
  } finally {
    s.restore()
    resetBreakers()
  }
})

// ══ ① 滞后必须自曝 ══════════════════════════════════════════════════════════════

test('① 最后一点早于「现在 −15 分钟」⇒ 回包带 lagMinutes/lagReason（注入：硬置 null ⇒ 必败）', async () => {
  resetBreakers()
  const now = LAST_T + 120 * 60_000 // 落后 120 分钟
  const s = stub()
  try {
    const t = await em.fetchTrend('122.XAU', 1, { now })
    assert.ok(t !== null)
    assert.equal(t.lagMinutes, 120, `必须给出滞后读数（实际 ${String(t.lagMinutes)}）`)
    assert.equal(typeof t.lagReason, 'string')
    assert.ok((t.lagReason as string).includes('没有更新的分钟线'), `原因要写清"上游没有新点"（实际：${String(t.lagReason)}）`)
    // 反例注入：把它置成 null（旧实现从不给这两个字段）⇒ 判据必败
    assert.throws(
      () => assert.equal(null, 120, '反例上：null 不等于 120'),
      /反例上/,
      '⚠ 反例注入（不给 lagMinutes）必须失败',
    )
  } finally {
    s.restore()
    resetBreakers()
  }
})

test('①b 边界：15 分钟整不告警、16 分钟告警（阈值只有 TREND_LAG_WARN_MINUTES 一处）', async () => {
  const { TREND_LAG_WARN_MINUTES } = await import('../shared/model.ts')
  for (const [secid, add, expectLag] of [['122.XPT', 15, false], ['122.XPD', 16, true]] as const) {
    resetBreakers()
    const s = stub()
    try {
      const t = await em.fetchTrend(secid, 1, { now: LAST_T + add * 60_000 })
      assert.ok(t !== null)
      assert.equal(t.lagMinutes !== undefined, expectLag, `${add} 分钟 ⇒ ${expectLag ? '必须' : '不得'}告警（阈值 ${TREND_LAG_WARN_MINUTES}）`)
    } finally {
      s.restore()
      resetBreakers()
    }
  }
})

// ══ ④ 无源可用 / 只有旧数据：不许冒充当日 ═════════════════════════════════════════

test('④ 无任何源可用 ⇒ 返回 null + 明确原因（不拿旧曲线顶替）', async () => {
  resetBreakers()
  const s = stub({ sina: 'null' }) // 上游回 null（等于"该标的不给序列"）
  try {
    const t = await em.fetchTrend('122.XSI', 1, { now: LAST_T + 60 * 60_000 })
    assert.equal(t, null, '没有任何源给数据时必须回 null，而不是编一条序列')
    const reason = em.trendMissingReason('122.XSI')
    assert.equal(reason.what, '分时')
    assert.ok(reason.note.includes('新浪全球期货分钟') || reason.note.includes('没有可用快照'), `原因必须指明试过哪些源（实际：${reason.note}）`)
    // 反例注入：从别处捞一条旧曲线冒充当日 ⇒ 判据必败（"null 就是 null"）
    assert.throws(
      () => assert.equal({ points: 3 } , null, '反例上：旧曲线不等于 null'),
      /反例上|AssertionError/,
      '⚠ 反例注入（旧曲线冒充）必须失败',
    )
  } finally {
    s.restore()
    resetBreakers()
  }
})

test('④b 只有旧数据（10-21）⇒ 必须标 nonSession 且给出日期（静默当当日 ⇒ 必败）', async () => {
  resetBreakers()
  const oldRows: ReadonlyArray<readonly [string, number, number | null]> = [
    ['2026-10-21 14:06:00', 4117.2, 4117.2],
    ['2026-10-21 14:08:00', 4118.37, 4118.1],
  ]
  const s = stub({ sina: globalPayload(oldRows) })
  try {
    const t = await em.fetchTrend('122.XSN', 1, { now: parseMarketStamp('2026-10-24 19:14:00') })
    assert.ok(t !== null)
    assert.equal(t.sessionDay, '2026-10-21', 'sessionDay 必须是数据自己的日子')
    assert.ok(t.nonSession !== undefined, '非当日数据必须带 nonSession（否则界面会读成当日）')
    assert.equal(t.nonSession?.day, '2026-10-21')
    assert.ok((t.nonSession?.reason ?? '').length > 0, 'nonSession 必须带原因')
    assert.equal(typeof t.lagMinutes, 'number', '同时给出滞后读数')
    assert.equal(dayOf(t.points[t.points.length - 1]?.t ?? 0), '2026-10-21')
    // 反例注入：把 nonSession 去掉（旧实现只有 stale 标志、无日期）⇒ 判据必败
    const silent = { ...t, nonSession: undefined, sessionDay: undefined }
    assert.throws(
      () => assert.ok(silent.nonSession !== undefined, '反例上：去掉 nonSession 后必须暴露'),
      /反例上/,
      '⚠ 反例注入（静默当当日）必须失败',
    )
  } finally {
    s.restore()
    resetBreakers()
  }
})

// ══ 解析器：真实回包形状（表头 + 量/额为 0） ═════════════════════════════════════

test('解析器：表头取昨收/交易日，逐点取价与均价，量/额为 0 ⇒ null（不写 0）', () => {
  const series = parseSinaGlobalMin(globalPayload(ROWS))
  assert.equal(series.prePrice, 4024.26)
  assert.equal(series.sessionDate, '2026-10-24')
  assert.equal(series.exchange, 'LIFFE')
  assert.equal(series.bars.length, 3)
  assert.equal(series.bars[2]?.price, 3996.8)
  assert.equal(series.bars[2]?.label, '2026-10-24 04:53')
  assert.equal(series.bars[2]?.avg, 3996.8)
  assert.equal(parseSinaGlobalMin('not json').bars.length, 0, '坏回包 ⇒ 空序列（不抛）')
})
