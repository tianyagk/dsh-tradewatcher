/**
 * 国际指数兜底源的红线断言（AUDIT-IMPL44）：
 *
 * 背景（全部是 2026-10-12 本机实测，见 docs/AUDIT-IMPL44.md）：
 *   - 新浪 `int_*` 族是**陈旧快照且没有时间戳**：
 *     `int_sp500` 6643.70 vs 腾讯 `us.INX` 7811.54（低 15.0%）；
 *     `int_dji` 46247.29 vs 腾讯 `us.DJI` 51654.95（低 10.5%）；
 *     `int_nasdaq` 22484.07 vs 腾讯 `us.NDX` 30883.15（低 27.2%）。
 *   - 现网 `quotes-lkg.json` 里 `100.SPX = 6643.7`（source=sina）就是这条链路落进去的错值。
 *   - `usSPX` / `us.SPX` **不存在**（腾讯回 `pv_none_match`）⇒ 标普 500 必须写 `us.INX`。
 *
 * 本文件把三件事钉住：① 国际指数**不再**落到新浪；② 腾讯代码正确（含 `us.INX`）；
 * ③ 已落盘的错值在载入 last-known-good 时**按内容特征作废**并留痕（不许静默沿用）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TW_ALL_SECIDS } from '../shared/model.ts'
import { parseSinaHq, sinaSymbol } from './sina.ts'
import { tencentCode, tencentIndexCode, tencentQuoteCode } from './tencent.ts'

/** 隔离：本文件要让 `em.ts` 载入一份**构造的** quotes-lkg.json ⇒ 必须在首次取数之前钉住 DSH_HOME */
const HOME = mkdtempSync(join(tmpdir(), 'tw-sinaindex-home-'))
process.env.DSH_HOME = HOME
if (!HOME.startsWith('/tmp')) throw new Error(`拒绝运行：DSH_HOME 必须在 /tmp 下（收到 ${HOME}）`)

test('① 国际指数不再落到新浪：`100.*` 整族没有新浪映射，连手工构造的 int_* 也解析不出来', () => {
  const indexes = TW_ALL_SECIDS.filter((s) => s.startsWith('100.'))
  assert.ok(indexes.length >= 8, `预设里应有足够多的国际指数用于断言（实际 ${indexes.length}）`)
  for (const s of indexes) {
    assert.equal(sinaSymbol(s), null, `${s} 不得再有新浪兜底（int_* 是陈旧快照 + 无时间戳）`)
  }
  // 解析层也堵死：即便上游/别处塞了 int_*，也不产出可用行情
  const parsed = parseSinaHq('var hq_str_int_dji="道琼斯,46247.29,299.97,0.65";\nvar hq_str_nf_RB0="螺纹钢连续,150000,3110.000,3122.000,3096.000,3105.000,3105.000,3106.000,3108.000";')
  assert.equal(parsed.int_dji, undefined, 'int_* 行必须被忽略')
  assert.equal(parsed.nf_RB0?.price, 3108, 'nf_*（有真时间戳）不受影响')
})

test('② 腾讯代码正确：标普必须 us.INX（usSPX 不存在），道指/纳指/恒生各自对上', () => {
  assert.equal(tencentIndexCode('100.SPX'), 'us.INX', '⚠ 标普 500 的腾讯代码是 us.INX；usSPX/us.SPX 都不存在（实测 pv_none_match）')
  assert.equal(tencentIndexCode('100.DJI'), 'us.DJI')
  assert.equal(tencentIndexCode('100.NDX'), 'us.NDX')
  assert.equal(tencentIndexCode('100.HSI'), 'hkHSI')
  // 大小写无关（库里存过 100.spx 这种写法）
  assert.equal(tencentIndexCode('100.spx'), 'us.INX')
  // 腾讯没覆盖的如实返回 null（不得编代码）
  for (const s of ['100.N225', '100.FTSE', '100.GDAXI', '100.KOSPI200', '100.SX5E', '100.FCHI']) {
    assert.equal(tencentIndexCode(s), null, `${s} 腾讯没有覆盖 ⇒ 必须返回 null（宁可 —，不给错源）`)
  }
  // 快照用的合并查表：A股/港股仍走原表，国际指数走新表
  assert.equal(tencentQuoteCode('1.600519'), 'sh600519')
  assert.equal(tencentQuoteCode('116.00700'), 'hk00700')
  assert.equal(tencentQuoteCode('100.SPX'), 'us.INX')
  // 五日分时那条链（mkline）**不得**拿到国际指数：mkline 对 us.INX 返回 param error（实测）
  assert.equal(tencentCode('100.SPX'), null, 'tencentCode（mkline/五日分时用）不得包含国际指数')
})

test('③ 已落盘的错值：载入 last-known-good 时作废 + 留痕，且不阻挡其它标的的兜底', async () => {
  const dir = join(HOME, 'dsh-tradewatcher')
  mkdirSync(dir, { recursive: true })
  // 构造一份"事故现场"文件：两个错误的国际指数（新浪 int_*）、一个东财时代的国际指数（无 source）、一只正常股票
  writeFileSync(join(dir, 'quotes-lkg.json'), JSON.stringify({
    ts: Date.now(),
    rows: [
      { secid: '100.SPX', code: 'SPX', name: '标普指数', price: 6643.7, pct: 0.59, prev: null, open: null, high: null, low: null, vol: null, amount: null, up: null, down: null, even: null, time: null, source: 'sina', at: Date.now() - 60_000 },
      { secid: '100.N225', code: 'N225', name: '日经指数', price: 44946.64, pct: -0.9, prev: null, open: null, high: null, low: null, vol: null, amount: null, up: null, down: null, even: null, time: null, source: 'sina', at: Date.now() - 60_000 },
      { secid: '100.FCHI', code: 'FCHI', name: '法国CAC40', price: 7803.33, pct: 0.95, prev: null, open: null, high: null, low: null, vol: null, amount: null, up: null, down: null, even: null, time: null, at: Date.now() - 60_000 },
      { secid: '1.600519', code: '600519', name: '贵州茅台', price: 1278.25, pct: 1.2, prev: 1263, open: 1270, high: 1280, low: 1265, vol: 100, amount: 1e8, up: null, down: null, even: null, time: null, totalMv: null, floatMv: null, source: 'em', at: Date.now() - 60_000 },
    ],
  }))
  const em = await import('./em.ts')
  // 上游全挂：这样能拿到的值只可能来自 last-known-good
  const realFetch = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new Error('offline (test)'))) as typeof fetch
  try {
    const got = await em.fetchQuotesDetailed(['100.SPX', '100.N225', '100.FCHI', '1.600519'])
    assert.equal(got.items['100.SPX'], undefined, '作废后的 100.SPX 不得再被当作"最后成功值"端出来')
    assert.equal(got.items['100.N225'], undefined, '作废后的 100.N225 同上')
    assert.ok(got.missing.includes('100.SPX') && got.missing.includes('100.N225'), `作废的行要如实进 missing（实际 ${JSON.stringify(got.missing)}）`)
    // 其它标的的兜底不受影响
    assert.equal(got.items['100.FCHI']?.price, 7803.33, '东财时代的国际指数（无 source）不该被误伤')
    assert.equal(got.items['100.FCHI']?.source, 'lkg')
    assert.equal(got.items['1.600519']?.price, 1278.25, '正常标的的兜底不受影响')
    // 留痕：进程内可见 + 文件里可查
    const purged = em.lastGoodPurged()
    assert.ok(purged.some((p) => p.secid === '100.SPX' && p.price === 6643.7), `必须记录作废了哪个值（实际 ${JSON.stringify(purged)}）`)
    assert.ok(String(purged.find((p) => p.secid === '100.SPX')?.reason ?? '').includes('int_*'), '作废原因必须点明来源（int_*）')
    // 落盘：文件里不得再有 100.SPX 行，且写入 purged 留痕（v2 = 该族停用后的 schema）
    await new Promise((r) => setTimeout(r, 300)) // 等 fire-and-forget 的原子写落地
    const after = JSON.parse(readFileSync(join(dir, 'quotes-lkg.json'), 'utf8')) as { v?: number; rows: Array<{ secid: string }>; purged?: Array<{ secid: string }> }
    assert.equal(after.rows.some((r) => r.secid === '100.SPX'), false, '落盘文件里不得再留着 100.SPX 的错值')
    assert.equal(after.rows.some((r) => r.secid === '100.N225'), false, '落盘文件里不得再留着 100.N225 的错值')
    assert.equal(after.v, 2, '落盘 schema 必须标 v2（国际指数不再接受新浪 int_* 值）')
    assert.ok((after.purged ?? []).some((p) => p.secid === '100.SPX'), '作废必须留痕在文件里（purged）')
  } finally {
    globalThis.fetch = realFetch
  }
})
