/**
 * R4 红线断言：上游"市场时钟"字符串必须按**北京时间**解析，展示也必须固定北京时间。
 *
 * 为什么本文件必须在 `TZ=UTC` 下也通过：门禁脚本带 `TZ=UTC` 一轮（见 package.json 的 test），
 * 而这条红线的病灶恰恰是"无偏移的 `Date.parse` 按宿主时区解释" —— 在 UTC 宿主上，
 * 北京 09:31 会被读成 09:31Z = 北京 17:31（复核实测：分时刻度变 17:30–23:00、
 * 护盘采样回填环整批"未来"点、`inTradingWindow` 命中 0/330）。
 *
 * 反例注入（退回宿主时区解析）⇒ 本文件在 `TZ=UTC` 轮必失败（见 docs/FIX-2-TIMEZONE.md）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hhmmOf, parseMarketStamp, shClockText, shDateTimeText, shStampText } from './time.ts'

/** 北京时间的字面量（带显式偏移 ⇒ 与运行环境时区无关） */
const BJ = (s: string): number => Date.parse(s)

test('R4-A 市场时钟字符串一律按 +08:00 解析（与宿主时区无关）', () => {
  const expect = BJ('2026-10-12T09:31:00+08:00')
  assert.equal(parseMarketStamp('2026-10-12 09:31'), expect, '上游 trends2/fflow 的 "YYYY-MM-DD HH:mm"')
  assert.equal(parseMarketStamp('2026-10-12 09:31:00'), expect, '带秒的写法')
  assert.equal(parseMarketStamp('2026-10-12T09:31'), expect, 'T 分隔')
  assert.equal(parseMarketStamp('202610120931'), expect, '紧凑 "YYYYMMDDHHmm"')
  // 已带明确偏移 ⇒ 原样认，绝不重复加 8 小时
  assert.equal(parseMarketStamp('2026-10-12T09:31:00Z'), Date.parse('2026-10-12T09:31:00Z'))
  assert.equal(parseMarketStamp('2026-10-12T09:31:00+08:00'), expect)
  assert.ok(Number.isNaN(parseMarketStamp('')), '空串 ⇒ NaN（不是"现在"）')
  assert.ok(Number.isNaN(parseMarketStamp('不是时间')), '垃圾 ⇒ NaN')
  // 关键反例：解析结果**不随宿主时区变化**（同一进程里两个等价写法必须完全相等）
  assert.equal(parseMarketStamp('2026-10-12 09:31') - parseMarketStamp('2026-10-12T09:31:00+08:00'), 0)
})

test('R4-B 展示层固定北京时间（数据时刻/日志/工具回包都用它）', () => {
  const ts = BJ('2026-10-12T09:42:52+08:00')
  assert.equal(shClockText(ts), '09:42:52')
  assert.equal(shStampText(ts), '10-12 09:42')
  assert.equal(shDateTimeText(ts), '2026-10-12 09:42:52')
  assert.equal(hhmmOf(ts), '09:42')
  // 跨日边界的北京口径（UTC 宿主下最容易错的地方）
  assert.equal(shDateTimeText(BJ('2026-11-01T00:30:00+08:00')), '2026-11-01 00:30:00')
  assert.equal(shDateTimeText(BJ('2026-10-31T23:30:00+08:00')), '2026-10-31 23:30:00')
})

test('R4-C 腾讯分时兜底：09:31 的点必须是北京 09:31，且落在交易日窗口内', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        data: { sh600519: { data: { date: '20261012', data: ['0931 11.10 100 2000', '0932 11.20 200 4100'] } } },
      }),
      text: async () => '{}',
    }) as unknown as Response) as typeof fetch
  try {
    const { fetchTencentMinutes } = await import('./tencent.ts')
    const { inTradingWindow } = await import('./rescue.ts')
    const pts = await fetchTencentMinutes('1.600519')
    assert.equal(pts.length, 2, `两个点都要解析出来（实际 ${pts.length}）`)
    assert.equal(hhmmOf(pts[0].ts), '09:31', '旧实现（无偏移 Date.parse）在 TZ=UTC 下这里会是 17:31')
    assert.equal(hhmmOf(pts[1].ts), '09:32')
    assert.equal(inTradingWindow(pts[0].ts), true, '北京盘中点必须命中交易日窗口（旧实现整批 0 命中）')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('R4-D 护盘分时序列：trends2 + fflow 的时间戳必须是北京时刻，整批命中采样窗口', async () => {
  // 上一个用例把 tencent 的载荷回给了东财主机 ⇒ 主机熔断器可能已被记账；这里先清零（用例之间不互相污染）
  const { breakerFor } = await import('./breaker.ts')
  for (const host of ['push2delay.eastmoney.com', 'push2.eastmoney.com', 'push2his.eastmoney.com']) breakerFor(host).recordSuccess()
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    const url = String(typeof input === 'string' ? input : (input as { url?: string })?.url ?? '')
    const isFlow = url.includes('fflow')
    const body = isFlow
      ? { data: { klines: ['2026-10-12 09:31,100,0,0,0,200', '2026-10-12 09:32,150,0,0,0,260'] } }
      : { data: { trends: ['2026-10-12 09:31,11.1,0,0,0,0,2000', '2026-10-12 09:32,11.2,0,0,0,0,4100'] } }
    // ⚠ 东财那条链走 `res.text()` + JSON.parse（`fetchFromHost`）—— 只给 `json()` 会让每次尝试都抛错
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
  }) as typeof fetch
  try {
    const { fetchMinuteSeries, inTradingWindow } = await import('./rescue.ts')
    const points = await fetchMinuteSeries('1.600519')
    assert.equal(points.length, 2, `两条时间戳必须能对齐（实际 ${points.length}）`)
    assert.deepEqual(points.map((p) => hhmmOf(p.ts)), ['09:31', '09:32'], '时间戳是北京墙上时间')
    assert.equal(points.every((p) => inTradingWindow(p.ts)), true, '整批点都必须落在采样窗口内（旧实现 0/N）')
    // 上游每分钟给的是**该分钟成交额**，这里出口是**当日累计**（2000 + 4100 = 6100）—— 口径不变
    assert.equal(points[1].amount, 6100, '当日累计成交额口径不变（每分钟差分后累加）')
  } finally {
    globalThis.fetch = realFetch
  }
})
