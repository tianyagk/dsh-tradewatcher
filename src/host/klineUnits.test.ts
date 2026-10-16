/**
 * 日线成交量**量纲归一**的断言（`src/host/klineUnits.ts`）。
 *
 * 每条断言都配一个**反例注入**（注释里写"注入 ⇒ 必败"）：把对应实现改坏，这条用例必须红。
 * 反例不是假设——它们全部来自 2026-10-16 的真实实测（见 `docs/AUDIT-IMPL65.md`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alignVolUnitWithQuote, findVolUnitBreak, isStarMarket, normalizeVolUnits, tencentVolToHands } from './klineUnits.ts'

/** 实测数字：腾讯科创板日线 = 股；同日快照 = 手（amount÷(vol×100) = price） */
const TENCNET_688035 = { qfqdayLast: 4_653_193, quoteVolHands: 46_532, price: 57.99, amount: 276_881_542 }
const TENCNET_688361 = { qfqdayLast: 7_448_573, quoteVolHands: 74_486 }
const TENCNET_510300 = { qfqdayLast: 37_995_085, quoteVolHands: 37_995_085 }
const TENCNET_600519 = { qfqdayLast: 38_502, quoteVolHands: 38_502 }

const bar = (date: string, vol: number | null, close = 10) => ({
  date, open: close, close, high: close, low: close, vol, pct: null as number | null,
})

/** 造一条"旧段 ×100、新段正常"的序列（真实故障形态：腾讯段 + 东财段被 mergeBars 拼在一起） */
function brokenSeries(older = 40, newer = 10): ReturnType<typeof bar>[] {
  const out: ReturnType<typeof bar>[] = []
  for (let i = 0; i < older; i += 1) out.push(bar(`2026-01-${String(i + 1).padStart(2, '0')}`, (50_000 + i * 100) * 100))
  for (let i = 0; i < newer; i += 1) out.push(bar(`2026-03-${String(i + 1).padStart(2, '0')}`, 50_000 + i * 100))
  return out
}

test('① 源归一：腾讯科创板日线 ÷100，其余市场一律不动（注入"全都 ÷100" ⇒ 必败）', () => {
  // 实测：688035 腾讯 4 653 193（股）↔ 快照 46 532（手）—— 恰好 ×100
  assert.equal(tencentVolToHands('1.688035', TENCNET_688035.qfqdayLast), 46_531.93, '科创板必须 ÷100')
  assert.equal(tencentVolToHands('1.688361', TENCNET_688361.qfqdayLast), 74_485.73, '科创板必须 ÷100（第二个标的）')
  // 实测：主板 / 创业板 / ETF 的腾讯 kline 与快照**逐位相同** ⇒ 一根都不许动
  assert.equal(tencentVolToHands('1.600519', TENCNET_600519.qfqdayLast), TENCNET_600519.qfqdayLast, '主板不许动')
  assert.equal(tencentVolToHands('0.300285', 546_857), 546_857, '创业板不许动')
  assert.equal(tencentVolToHands('1.510300', TENCNET_510300.qfqdayLast), TENCNET_510300.qfqdayLast, 'ETF 不许动')
  assert.equal(tencentVolToHands('116.00700', 12_345_600), 12_345_600, '港股不许动（走东财，不经此路）')
  // 缺失/零：**不许用 0 顶替**，也不许把 null 变成数
  assert.equal(tencentVolToHands('1.688035', null), null, 'null 必须保持 null')
  assert.equal(tencentVolToHands('1.688035', 0), 0, '0 保持 0')
  assert.equal(isStarMarket('1.688035'), true)
  assert.equal(isStarMarket('1.689001'), true, '科创板存托凭证同板块')
  assert.equal(isStarMarket('1.600519'), false)
})

test('② 段内断层：把旧段对齐到新段的量纲（注入"原样返回" ⇒ 必败）', () => {
  const input = brokenSeries()
  const r = normalizeVolUnits(input)
  assert.equal(r.fixed, true, '必须识别出断层（否则 100× 断层会被当成真实放量）')
  assert.ok(r.reason !== null && r.reason.includes('量纲断层'), '必须给出原因')
  assert.ok(r.reason !== null && r.reason.includes('只改 vol'), '原因里必须写明只改了 vol')
  // 归一后：断层消失
  assert.equal(findVolUnitBreak(r.bars), null, '归一之后不许再有 ≈100× 断层')
  // 新段（最新那段）必须是**基准**：值不变
  for (let i = 40; i < input.length; i += 1) {
    assert.equal(r.bars[i].vol, input[i].vol, `新段第 ${i} 根不许被改（它是基准）`)
  }
  // 旧段：恰好 ÷100（只改量纲，不插值、不四舍五入到别的数）
  for (let i = 0; i < 40; i += 1) {
    assert.equal(r.bars[i].vol, (input[i].vol as number) / 100, `旧段第 ${i} 根必须恰好 ÷100`)
  }
  assert.equal(r.dropped, 0, '可修时不许丢数据')
})

test('③ 修正不改价格/日期（注入"顺手改 OHLC" ⇒ 必败）', () => {
  const input = brokenSeries()
  // 给价格加上可辨识的值，任何一处被改都会被抓到
  input.forEach((b, i) => {
    b.open = 10 + i / 1000
    b.high = 11 + i / 1000
    b.low = 9 + i / 1000
    b.close = 10.5 + i / 1000
    b.pct = 1.23
  })
  const r = normalizeVolUnits(input)
  assert.equal(r.bars.length, input.length, '根数不许变')
  for (let i = 0; i < input.length; i += 1) {
    assert.equal(r.bars[i].date, input[i].date, `第 ${i} 根日期不许动`)
    assert.equal(r.bars[i].open, input[i].open, `第 ${i} 根 open 不许动`)
    assert.equal(r.bars[i].high, input[i].high, `第 ${i} 根 high 不许动`)
    assert.equal(r.bars[i].low, input[i].low, `第 ${i} 根 low 不许动`)
    assert.equal(r.bars[i].close, input[i].close, `第 ${i} 根 close 不许动`)
    assert.equal(r.bars[i].pct, input[i].pct, `第 ${i} 根 pct 不许动`)
  }
})

test('④ 不可修 ⇒ 丢段**必须**带原因（注入"静默丢段" ⇒ 必败）', () => {
  // 新段只有 2 根可用（< MIN_REF = 3）⇒ 无法确定量纲基准
  const input = brokenSeries(40, 2)
  const r = normalizeVolUnits(input)
  assert.equal(r.fixed, true)
  assert.ok(r.dropped > 0, `这种情况必须丢段（实际 dropped=${r.dropped}）`)
  assert.ok(typeof r.reason === 'string' && r.reason.trim() !== '', '丢段**必须**给出原因（静默丢 = 必败）')
  assert.ok(r.reason !== null && r.reason.includes('丢弃'), '原因里必须写明丢了什么')
  assert.equal(r.bars.length + r.dropped, input.length, '丢的根数必须与结果对得上')
  // 留下来的只能是**新段**（被丢掉的是较早那段）
  assert.equal(r.bars[0].vol, input[input.length - 2].vol)
})

test('⑤ 不得写 0 顶替（注入"置 0 / NaN" ⇒ 必败）', () => {
  const input = brokenSeries()
  input[3].vol = null // 缺失值必须保持缺失，不许被填成 0
  const r = normalizeVolUnits(input)
  for (const b of r.bars) {
    assert.ok(b.vol === null || (Number.isFinite(b.vol) && b.vol > 0), `vol 不许出现 0/NaN/负数（实际 ${String(b.vol)}）`)
  }
  assert.equal(r.bars[3].vol, null, '缺失就是缺失（不许 0 顶替）')
})

test('⑥ 绝对量纲：同日报价（手）是外部参照（注入"少比一道" ⇒ 必败）', () => {
  // 整个序列都被放大 100×（段内一致 ⇒ 段内归一查不出来），只有报价能抓出来
  const inflated = [bar('2026-10-15', 4_516_679), bar('2026-10-16', 4_653_193)]
  const r = alignVolUnitWithQuote(inflated, { date: '2026-10-16', vol: TENCNET_688035.quoteVolHands })
  assert.equal(r.fixed, true, '与同日报价差 ~100× ⇒ 必须归一')
  assert.equal(r.bars[1].vol, 46_531.93, '必须恰好 ÷100')
  assert.ok(r.reason !== null && r.reason.includes('只改 vol'))
  // 一致的序列不许动（主板/ETF 的真实形态）
  const ok = [bar('2026-10-16', TENCNET_510300.quoteVolHands)]
  const r2 = alignVolUnitWithQuote(ok, { date: '2026-10-16', vol: TENCNET_510300.quoteVolHands })
  assert.equal(r2.fixed, false, '一致就不许动')
  assert.equal(r2.reason, null)
  // 盘中快照（缓存 bar 小于当日全量）属正常，不许误判
  const partial = [bar('2026-10-16', 28_389)]
  assert.equal(alignVolUnitWithQuote(partial, { date: '2026-10-16', vol: 46_532 }).fixed, false, '盘中 bar 比全量小是正常的')
  // 参照缺失 ⇒ 什么都不做、也不写 0
  assert.equal(alignVolUnitWithQuote(inflated, { date: '2026-10-16', vol: null }).fixed, false)
  assert.equal(alignVolUnitWithQuote(inflated, { date: '2026-09-01', vol: 1 }).fixed, false, '参照日不在序列里 ⇒ 不猜')
})

test('⑦ 真实业态回归：科创板两条序列归一后与快照口径一致（amount÷(vol×100)≈price）', () => {
  const { qfqdayLast, quoteVolHands, price, amount } = TENCNET_688035
  // 快照自身的自洽（手）：amount ÷ (vol×100) = price
  assert.ok(Math.abs(amount / (quoteVolHands * 100) - price) / price < 0.03, '快照是手口径')
  // 腾讯原始值（股）归一后必须落在手口径上
  const hands = tencentVolToHands('1.688035', qfqdayLast) as number
  assert.ok(Math.abs(hands / quoteVolHands - 1) < 0.01, `归一后必须与快照同量级（实际 ${hands} vs ${quoteVolHands}）`)
  // 归一后的隐含成交额 ≈ 快照 amount（同一天、同一份成交）
  const implied = hands * 100 * price
  assert.ok(Math.abs(implied / amount - 1) < 0.05, `隐含成交额必须回到快照量级（${implied.toFixed(0)} vs ${amount}）`)
  // **lead 给的判据原式**：amount ÷ (vol × 100) 必须回到 price（容差按"快照价是最后一笔价、不是均价"取 5%）。
  // 未归一时这条式子给出 59.5×100 = 5951 ⇒ 必败。
  const judged = amount / (hands * 100)
  assert.ok(Math.abs(judged / price - 1) < 0.05, `amount÷(vol×100) 必须 ≈ price（实际 ${judged.toFixed(3)} vs ${price}）`)
  const rawJudged = amount / (qfqdayLast * 100)
  assert.ok(rawJudged < price / 50, `拿未归一的 vol 代入就会偏离两个数量级（实际 ${rawJudged.toFixed(4)}）`)
})

test('⑧ 端到端：读缓存即归一 + 走锁落盘 + 不伪造 updatedAt（注入"只读内存不落盘"只影响 durability 断言）', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { fetchKline } = await import('./em.ts')
  const home = mkdtempSync(join(tmpdir(), 'tw-units-e2e-'))
  const prevHome = process.env.DSH_HOME
  const prevFetch = globalThis.fetch
  // 上游一律失败（不碰网络）；钉住时钟到收盘后 ⇒ 缓存被判"定稿免回源"，一次请求都不发
  const realNow = Date.now
  const FAKE_NOW = Date.parse('2026-10-16T20:30:00+08:00')
  Date.now = () => FAKE_NOW
  process.env.DSH_HOME = home
  globalThis.fetch = (() => Promise.reject(new Error('offline (test)'))) as typeof fetch
  try {
    const secid = '1.688035'
    const dir = join(home, 'dsh-tradewatcher', 'klines')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${secid}_101_1.json`)
    const bars = brokenSeries(40, 10)
    const ORIG_UPDATED = FAKE_NOW - 3 * 86_400_000
    writeFileSync(file, JSON.stringify({ v: 3, secid, klt: 101, fqt: 1, updatedAt: ORIG_UPDATED, partial: false, bars }))
    const k = await fetchKline(secid, 101, 50, 1)
    assert.ok(k !== null, '有缓存就必须给数据')
    const days = (k as NonNullable<typeof k>).days
    assert.equal(findVolUnitBreak(days), null, '读出来的序列不许再有 100× 断层')
    assert.ok(typeof k?.unitNote === 'string' && k.unitNote.includes('量纲断层'), '必须带上如实标注')
    assert.ok(k?.staleReason !== undefined && k.staleReason.includes('量纲断层'), 'staleReason 也要能看到（界面已有的槽位）')
    // 价格不许动
    assert.equal(days[0].close, bars[0].close, '价格不被量纲修正碰到')
    // 落盘：文件里也已经是归一后的值（走的是锁内的读-合并-写）
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { bars: typeof bars; updatedAt: number }
    assert.equal(findVolUnitBreak(onDisk.bars), null, '磁盘上也不许再有断层')
    assert.equal(onDisk.bars[0].vol, (bars[0].vol as number) / 100, '磁盘上的旧段必须已归一')
    assert.equal(onDisk.updatedAt, ORIG_UPDATED, '⚠ 不许伪造新鲜度：updatedAt 必须保持原值')
    assert.equal(onDisk.bars[0].close, bars[0].close, '磁盘上的价格不许动')
  } finally {
    Date.now = realNow
    globalThis.fetch = prevFetch
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('⑨ 量纲错了就一定会顶到 cap：用实测数字证明"这不是小误差"（注入"不归一" ⇒ 必败）', () => {
  // 实测：1.688035 缓存旧段中位 2 945 442（腾讯=股）、floatMv = 8.248e9、close ≈ 59
  const rawVol = 2_945_442
  const close = 59.15
  const floatMv = 8.248e9
  /** chips 的换手率口径（`src/host/chips.ts:363-369`）：t = vol×100×close ÷ floatMv，cap = 0.25 */
  const turnoverOf = (vol: number): number => Math.min(0.25, Math.max(0, (vol * 100 * close) / floatMv))
  const saturating = turnoverOf(rawVol)
  assert.equal(saturating, 0.25, '不归一时隐含换手率 >100% ⇒ 天天顶到 25% cap（旧筹码每天被清 37.5%）')
  const hands = tencentVolToHands('1.688035', rawVol) as number
  const fixed = turnoverOf(hands)
  assert.ok(fixed > 0.005 && fixed < 0.2, `归一后必须落在合理换手率区间（实际 ${(fixed * 100).toFixed(2)}%）`)
  assert.ok(Math.abs(fixed / (rawVol * close / floatMv) - 1) < 1e-6, '归一后 = 真实换手率（不再被 cap 截断）')
})
