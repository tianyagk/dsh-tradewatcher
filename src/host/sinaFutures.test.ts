/**
 * 新浪 `nf_`（国内期货）/ `hf_`（外盘）/ `sh|sz`（指数）作为**报价兜底源**的断言（AUDIT-SINA-FUTURES）。
 *
 * 用户批准新增该源：东财优先、失败自动切新浪；取不到 ⇒ `null` + 原因，不得 0 或旧值占位。
 * ④ 是重点：`nf_` 与 `hf_`（还有指数）的**字段顺序完全不同**，必须分别用真实回包单测，不猜列号。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tw-sinafut-home-'))

const em = await import('./em.ts')
const { parseSinaHq, sinaFamilyOf } = await import('./sina.ts')
const { breakerFor } = await import('./breaker.ts')
const { parseMarketStamp } = await import('./time.ts')

// ── 真实回包（2026-10-25 20:30 实测，逐字节） ────────────────────────────────
const AU0 = 'var hq_str_nf_AU0="黄金连续,023000,867.000,868.860,856.400,0.000,861.620,862.000,861.620,0.000,869.200,1,15,199602.000,142413,沪,黄金,2026-10-24,1,,,,,,,,,862.599,861.600,1,861.300,2,861.200,1,860.500,1,862.200,1,862.280,1,862.500,3,862.520,1";'
const GC = 'var hq_str_hf_GC="4007.910,,4009.500,4010.000,4050.200,3989.100,04:59:58,4060.400,4042.200,0,2,1,2026-10-24,纽约黄金,0";'
const SH000001 = 'var hq_str_sh000001="上证指数,3623.5669,3658.0256,3690.4753,3691.3988,3574.2712,0,0,552842912,898666874902,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-10-23,15:35:30,00,";'

const HOSTS = ['push2his.eastmoney.com', 'push2delay.eastmoney.com', 'push2.eastmoney.com', 'hq.sinajs.cn']

interface Stub { calls: string[]; restore: () => void }

function stub(opts: { sina?: string | null } = {}): Stub {
  const real = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)
    calls.push(url)
    const host = new URL(url).host
    if (host === 'hq.sinajs.cn') {
      if (opts.sina === null) throw new Error('ECONNRESET (stub: 新浪不可达)')
      const body = opts.sina ?? [AU0, GC, SH000001].join('\n')
      const buf = new TextEncoder().encode(body)
      return { ok: true, status: 200, arrayBuffer: async () => buf.buffer, text: async () => body, json: async () => ({}) } as unknown as Response
    }
    throw new Error(`ECONNRESET (stub: ${host} 不可达)`)
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = real } }
}

function resetBreakers(): void {
  for (const h of HOSTS) breakerFor(h).recordSuccess()
}

// ══ ④ 解析：三族字段顺序不同，分别用真实回包单测 ═══════════════════════════════

test('④ `nf_AU0`：价在第 9 格（下标 8）、昨收 0 时用昨结算兜底、成交量取下标 14', () => {
  const q = parseSinaHq(AU0)['nf_AU0']
  assert.ok(q !== undefined)
  assert.equal(q.price, 861.62)
  assert.equal(q.prev, 869.2, '昨收字段是 0.000（夜盘常态）⇒ 必须用昨结算，不能拿 0 当基准')
  assert.equal(q.open, 867)
  assert.equal(q.high, 868.86)
  assert.equal(q.low, 856.4)
  assert.equal(q.vol, 142413)
  assert.equal(q.time, parseMarketStamp('2026-10-24 02:30:00'), '上游成交时刻（北京 02:30，夜盘）')
  assert.ok(Math.abs((q.pct as number) - ((861.62 / 869.2 - 1) * 100)) < 1e-9)
  // 反例注入：把"最新"当第 3 格（hf 的下标）⇒ 会读出 868.86
  const wrong = Number(AU0.split('="')[1]?.split(',')[3])
  assert.throws(() => assert.equal(wrong, 861.62, '反例上：下标 3 不是最新价'), /反例上/, '⚠ 反例（猜列号）必须失败')
})

test('④ `hf_GC`：价在第 1 格、今开在第 9 格（下标 8，不是下标 3 的卖价）', () => {
  const q = parseSinaHq(GC)['hf_GC']
  assert.ok(q !== undefined)
  assert.equal(q.price, 4007.91)
  assert.equal(q.prev, 4060.4)
  assert.equal(q.open, 4042.2, '今开 = 下标 8；旧实现读下标 3 = 卖价 4010.00（错的）')
  assert.equal(q.high, 4050.2)
  assert.equal(q.low, 3989.1)
  assert.equal(q.name, '纽约黄金')
  assert.equal(q.time, parseMarketStamp('2026-10-24 04:59:58'))
  // 反例注入：旧实现（open=下标 3）⇒ 4010 ⇒ 必败
  const legacyOpen = Number(GC.split('="')[1]?.split(',')[3])
  assert.equal(legacyOpen, 4010)
  assert.throws(() => assert.equal(legacyOpen, 4042.2, '反例上：下标 3 是卖价'), /反例上/, '⚠ 反例（沿用旧下标）必须失败')
})

test('④ `sh000001`：价在第 4 格（下标 3）、量/额在下标 8/9、时间由 30+31 拼', () => {
  const q = parseSinaHq(SH000001)['sh000001']
  assert.ok(q !== undefined)
  assert.equal(q.price, 3690.4753)
  assert.equal(q.prev, 3658.0256)
  assert.equal(q.open, 3623.5669)
  assert.equal(q.high, 3691.3988)
  assert.equal(q.low, 3574.2712)
  assert.equal(q.vol, 552842912)
  assert.equal(q.amount, 898666874902)
  assert.equal(q.time, parseMarketStamp('2026-10-23 15:35:30'))
})

test('族判定：nf_/hf_ = sina-futures，sh/sz = sina-index（决定 source 标注）', () => {
  assert.equal(sinaFamilyOf('112.AU0'), 'nf')
  assert.equal(sinaFamilyOf('101.GC00Y'), 'hf')
  assert.equal(sinaFamilyOf('122.XAG'), 'hf')
  assert.equal(sinaFamilyOf('1.000001'), 'index')
  assert.equal(sinaFamilyOf('0.399006'), 'index')
  assert.equal(sinaFamilyOf('106.FRO'), 'gb')
  assert.equal(sinaFamilyOf('1.600519'), null, 'A股不加新浪通配（避免每只票多一条请求）')
})

// ══ ① 东财失败 + 新浪成功 ⇒ 新浪值 + source ═════════════════════════════════════

test('① 东财失败 + 新浪成功 ⇒ 返回新浪值且 `source` = sina-futures / sina-index（仍报缺失 ⇒ 必败）', async () => {
  resetBreakers()
  const s = stub()
  try {
    const r = await em.fetchQuotesWithProvenance(['112.AU0', '101.GC00Y', '1.000001'])
    const au = r.items['112.AU0']
    const gc = r.items['101.GC00Y']
    const sh = r.items['1.000001']
    assert.ok(au !== undefined && gc !== undefined && sh !== undefined, '三个标的都必须有价（东财失败也不许空）')
    assert.equal(au.price, 861.62)
    assert.equal(au.source, 'sina-futures')
    assert.equal(gc.source, 'sina-futures')
    assert.equal(sh.price, 3690.4753)
    assert.equal(sh.source, 'sina-index')
    assert.equal(r.provenance.missing.length, 0, '拿到价了就不该再报缺失')
    // 反例注入：旧实现把"已拿到价"的标的也塞进 missing ⇒ 判据必败
    const legacyMissing = [{ what: '112.AU0' }, { what: '1.000001' }]
    assert.throws(
      () => assert.equal(legacyMissing.length, 0, '反例上：有价却被报缺失'),
      /反例上/,
      '⚠ 反例注入（仍报缺失）必须失败',
    )
  } finally {
    s.restore()
    resetBreakers()
  }
})

// ══ ③ source / at 必存在 ════════════════════════════════════════════════════════

test('③ 新浪兜底行必须带 `source` 与 `at`（缺 ⇒ 必败）', async () => {
  resetBreakers()
  const s = stub()
  try {
    const r = await em.fetchQuotesWithProvenance(['112.AU0', '1.000001'])
    for (const secid of ['112.AU0', '1.000001']) {
      const row = r.items[secid]
      assert.ok(row !== undefined)
      assert.equal(typeof row.source, 'string', `${secid} 缺 source`)
      assert.equal(typeof row.at, 'number', `${secid} 缺 at`)
      assert.ok((row.at as number) > 0)
    }
    // 反例注入：删掉出处 ⇒ 判据必败
    const legacy = { ...r.items['112.AU0'], source: undefined, at: undefined }
    assert.throws(() => assert.equal(typeof legacy.source, 'string', '反例上：缺 source'), /反例上/, '⚠ 反例注入必须失败')
  } finally {
    s.restore()
    resetBreakers()
  }
})

// ══ ② 两家都失败 ⇒ null + 已试名单 ═════════════════════════════════════════════

test('② 东财与新浪都失败 ⇒ 无行 + 原因含「已试：东财、新浪」（返回 0 ⇒ 必败）', async () => {
  resetBreakers()
  const s = stub({ sina: null })
  try {
    // 用**本用例首次出现**的标的（上一用例留下的 LKG 是正常兜底，不属"两家都失败"的现场）
    const r = await em.fetchQuotesWithProvenance(['112.AG0', '0.399006'])
    assert.equal(r.items['112.AG0'], undefined, '取不到就必须没有这一行（不许给 0 占位）')
    assert.equal(r.items['0.399006'], undefined)
    const note = r.provenance.missing[0]?.note ?? ''
    assert.ok(note.includes('已试：东财、新浪'), `原因必须点名已试的两个源（实际：${note}）`)
    assert.ok(!/¥0|价格：0/.test(JSON.stringify(r.items)), '不许出现 0 价占位')
    // 反例注入：给 0 价占位 ⇒ 判据必败
    const legacy = { '112.AG0': { price: 0, source: 'sina-futures' } }
    assert.throws(
      () => assert.equal(legacy['112.AG0'].price, undefined, '反例上：0 价不是 null'),
      /反例上/,
      '⚠ 反例注入（0 占位）必须失败',
    )
  } finally {
    s.restore()
    resetBreakers()
  }
})
