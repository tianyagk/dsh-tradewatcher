/**
 * 美股行情兜底（AUDIT-IMPL67）的红线断言。
 *
 * 背景（2026-10-17 本机实测，原始回包与判定见 docs/PROBE-US-QUOTES.md；实现说明见 docs/AUDIT-IMPL67.md）：
 *   · 自选里 `106.FRO`（Frontline，NYSE）与 `107.VIXY`（恐慌指数期货短期合约 ETF）此前**永远**显示「无行情源」：
 *     东财一挂就没人兜底 —— 腾讯 `tencentQuoteCode` 不认 `105/106/107`，新浪 `sinaSymbol` 是逐标静态表、没有美股。
 *   · 两家**都取得到**（`usFRO` 52.49 / `gb_fro` 52.49；`usVIXY` 17.73 / `gb_vixy` 17.73）⇒ 缺口是映射，不是数据源。
 *   · 但既有 parser 的字段下标是给 A股/港股写的：直接喂美股会**乘 10000 倍成交额**、**丢时间戳**、**ETF 市值写 0**。
 *
 * 本文件把四类"错值"逐一钉成**可失败的断言**（每条都配了反例：按错的做法实现就会红），
 * 外加"未知 ticker 不许回 0 / 空价"与"robotsGate 接入面不许扩到报价链"两条边界。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseTencentQuoteText,
  parseTencentStamp,
  parseTencentUsStamp,
  tencentCode,
  tencentQuoteCode,
  tencentUsStockQuoteCode,
} from './tencent.ts'
import { parseSinaGb, parseSinaHq, sinaSymbol } from './sina.ts'

/** 隔离：本文件要让 `em.ts` 用一份空的 HOME（不信本机 `~/.dsh` 的 last-known-good） */
const HOME = mkdtempSync(join(tmpdir(), 'tw-usquote-home-'))
process.env.DSH_HOME = HOME
if (!HOME.startsWith('/tmp')) throw new Error(`拒绝运行：DSH_HOME 必须在 /tmp 下（收到 ${HOME}）`)

// ── 真实回包（2026-10-17 抓取，逐字节保留）────────────────────────────────────────
/** 腾讯 `qt.gtimg.cn`：usFRO / usVIXY / usAAPL（美股 73 字段布局） */
const TX_US = `v_usFRO="200~Frontline Plc~FRO.N~52.49~52.54~53.63~3722974~0~0~52.17~100~0~0~0~0~0~0~0~0~52.50~100~0~0~0~0~0~0~0~0~~2026-10-16 16:04:53~-0.05~-0.10~54.19~52.38~USD~3722974~196988621~1.67~7.87~~30.88~~3.44~75.15370~116.85475~Frontline Plc~6.67~59.75~15.60~0~3.70~10.25~116.85475~211.36~-6.43~GP~53.84~24.94~-0.47~2.08~48.11~222622889~143177186~0.74~4.80~5.38~52.91~~~~~";
v_usVIXY="200~短期期货波动ETF-ProShares~VIXY.AM~17.73~16.40~16.12~15329796~0~0~17.80~10000~0~0~0~0~0~0~0~0~18.00~600~0~0~0~0~0~0~0~0~~2026-10-16 16:00:01~1.33~8.11~18.48~16.00~USD~15329796~270828663~~~~~~15.12~~~Proshares Vix Short-Term Futures Etf~~39.70~15.88~9400~~~~-30.85~8.77~GP-ETF~~~6.04~3.74~-18.60~~~6.28~~~17.67~~~~13566000~";
v_usAAPL="200~苹果~AAPL.OQ~343.46~342.00~346.09~59946368~0~0~342.62~40~0~0~0~0~0~0~0~0~342.86~40~0~0~0~0~0~0~0~0~~2026-10-16 16:00:02~1.46~0.43~347.82~340.46~USD~59946368~20621913459~0.41~39.39~~46.04~~2.15~50094.01495~50125.17063~Apple Inc.~8.72~348.15~242.76~0~46.62~0.31~50125.17063~26.68~2.03~GP~148.75~36.08~2.93~2.18~6.87~14594180000~14585108878~1.56~37.44~1.06~344.01~~~~~";
`
/** 腾讯 `qt.gtimg.cn`：A股对照（88 字段布局，成交额在 f[35] 的三连里） */
const TX_CN = `v_sh510300="1~沪深300ETF华泰柏瑞~510300~4.236~4.242~4.255~37995085~23586339~14408746~4.236~28915~4.235~46083~4.234~92786~4.233~30987~4.232~10324~4.237~120~4.238~162~4.239~526~4.240~2165~4.241~1458~~20261016161459~-0.006~-0.14~4.282~4.200~4.236/37995085/16092791436~37995085~1609279~13.31~~~4.282~4.200~1.93~1209.50~1209.50~0.00~4.666~3.818~3.44~204664~4.235~~~~~~1609279.1436~772.6040~18239~   A~ETF~-8.51~-3.40~~~~5.095~4.187~-6.18~-8.25~-10.88~28552987700~28552987700~95.85~-10.69~28552987700~-0.14~4.2420~-7.87~-0.19~4.2426~CNY~0~___D__F__N~4.242~-70289~";`
/** 新浪 `hq.sinajs.cn`：gb_fro / gb_vixy（美股 36 字段布局） */
const GB_US = `var hq_str_gb_fro="Frontline,52.4900,-0.10,2026-10-17 09:43:52,-0.0500,53.6300,54.1900,52.3800,59.7500,17.8900,3722974,4808716,11685475706,4.07,12.900000,0.00,0.00,0.00,0.00,222622894,20,52.1600,-0.63,-0.33,Oct 16 07:57PM EDT,Oct 16 04:00PM EDT,52.5400,136677,1,2026,197036261.0000,52.8362,51.9254,7179457.6545,52.4900,52.5500";\nvar hq_str_gb_vixy="短期期货恐慌指数ETF,17.7300,8.11,2026-10-17 09:46:40,1.3300,16.1200,18.4800,16.0000,39.7000,15.8750,15329796,2228482,240529647,0.00,--,0.00,0.00,0.00,0.00,13566252,0,17.8393,0.62,0.11,Oct 16 07:59PM EDT,Oct 16 04:00PM EDT,16.4000,36162,1,2026,270624597.0000,17.8700,17.5000,640364.7151,17.7900,16.3900";`

const US_KEY: Record<string, string> = { usFRO: '106.FRO', usVIXY: '107.VIXY', usAAPL: '105.AAPL' }
const parseUs = (payload: string) => parseTencentQuoteText(payload, (code) => US_KEY[code])

test('① 映射两态：105/106/107 命中 `us<TICKER>`，其它一律 null；且不污染 K 线链的 `tencentCode`', () => {
  assert.equal(tencentQuoteCode('106.FRO'), 'usFRO')
  assert.equal(tencentQuoteCode('107.VIXY'), 'usVIXY')
  assert.equal(tencentQuoteCode('105.AAPL'), 'usAAPL')
  // 小写 ticker 也要能认（用户可能直接粘 `106.fro`）
  assert.equal(tencentQuoteCode('106.fro'), 'usFRO')
  // 未命中：非美股前缀 / 空 ticker / 非法字符
  for (const miss of ['999.FRO', '100.N225', '105.', '106.600519?', '1.600519x']) {
    assert.equal(tencentUsStockQuoteCode(miss), null, `${miss} 不该被美股规则命中`)
  }
  // 回归：原有两档不受影响（A股/港股/国际指数）
  assert.equal(tencentQuoteCode('1.600519'), 'sh600519')
  assert.equal(tencentQuoteCode('116.00700'), 'hk00700')
  assert.equal(tencentQuoteCode('100.SPX'), 'us.INX')
  // ⚠ 护栏：`tencentCode`（mkline/五日分时/日线复用）**不得**含美股 —— 腾讯美股日线只回 1 根
  assert.equal(tencentCode('106.FRO'), null, 'tencentCode 不得包含美股（那条链只拿得到 1 根日线）')
  assert.equal(tencentCode('105.AAPL'), null)
})

test('② 腾讯美股行：价/涨跌/开高低/量/额/市值逐项对得上原回包（反例：成交额乘 10000 ⇒ 红）', () => {
  const rows = parseUs(TX_US)
  const fro = rows['106.FRO']
  const vixy = rows['107.VIXY']
  assert.ok(fro !== undefined && vixy !== undefined, '两行都必须解析出来')
  // 价与涨跌（原回包 f[3]/f[4]/f[32]/f[33]/f[34]）
  assert.equal(fro.price, 52.49)
  assert.equal(fro.prev, 52.54)
  assert.equal(fro.pct, -0.1)
  assert.equal(fro.high, 54.19)
  assert.equal(fro.low, 52.38)
  assert.equal(fro.vol, 3722974)
  // 成交额：美股 f[37] **已经是美元**（与新浪 gb_fro 下标 30 = 197,036,261 同量级）
  assert.equal(fro.amount, 196988621, '美股成交额必须是原值（美元）')
  // 反例注入：若沿用 A股的 ×1e4，这里会是 1.96988621e12 ⇒ 下面两条必红
  assert.notEqual(fro.amount, 196988621 * 1e4, '反例：成交额乘 10000 的实现必须被抓住')
  assert.notEqual(fro.amount, 270828663 * 1e4, '反例：VIXY 同样不许被乘 10000')
  assert.equal(vixy.amount, 270828663)
  // 市值：腾讯 f44/f45 单位是亿元 ⇒ ×1e8。FRO 有值（与新浪 totalMv 11,685,475,706 吻合）
  assert.equal(fro.totalMv, 11685475000)
  assert.equal(fro.floatMv, 7515370000)
  // 股本：f71 只在美股取值（FRO 这行空 ⇒ null；VIXY 有 13,566,000 份，与新浪 13,566,252 同量级）
  assert.equal(fro.shares, null)
  assert.equal(vixy.shares, 13566000)
})

test('③ 空串不许变 0：美股 ETF 的 f44/f45 为空 ⇒ 市值必须是 null（反例：写成 0 ⇒ 红）', () => {
  const vixy = parseUs(TX_US)['107.VIXY']
  const spy = parseTencentQuoteText(
    mkTxRow('usSPY', { 1: 'x', 2: 'SPY.AM', 3: '763.25', 4: '771.79', 6: '100', 30: '2026-10-16 16:00:01', 32: '-1.11', 33: '773.25', 34: '760.64', 35: 'USD', 37: '49282866763', 71: '1066482000' }),
    (c) => (c === 'usSPY' ? '105.SPY' : undefined),
  )['105.SPY']
  assert.ok(spy !== undefined, 'SPY 行也要解析出来')
  assert.equal(spy.totalMv, null, 'SPY 的 f44/f45 同样为空 ⇒ 必须 null')
  assert.equal(spy.amount, 49282866763)
  assert.equal(spy.shares, 1066482000)
  assert.equal(vixy.totalMv, null, 'ETF 没有市值字段 ⇒ null（不是 0）')
  assert.equal(vixy.floatMv, null)
  assert.notEqual(vixy.totalMv, 0, '反例：把空串读成 0 的实现必须被抓住')
})

test('③b A股/港股的量纲不受影响：f[35] 三连的成交额原样用，f[37]（万元）仍 ×1e4（反例：为了美股把 A股也改掉 ⇒ 红）', () => {
  // 真实 A股回包：f[35] = "4.236/37995085/16092791436" ⇒ 成交额 16,092,791,436 元；f[45] = 1209.50 亿
  const cn = parseTencentQuoteText(TX_CN, (c) => (c === 'sh510300' ? '1.510300' : undefined))['1.510300']
  assert.ok(cn !== undefined, 'A股对照行必须解析出来')
  assert.equal(cn.amount, 16092791436)
  assert.equal(cn.totalMv, 120950000000)
  // 合成：A股行的 f[35] 不是三连（无币种/无斜杠）⇒ 走 f[37] ×1e4 的老口径，必须仍是 12345 万元 = 1.2345 亿
  const cnNoTri = parseTencentQuoteText(
    mkTxRow('sh600000', { 1: 'x', 3: '10', 4: '10', 30: '20261016150000', 32: '0', 35: '10.00', 37: '12345' }),
    (c) => (c === 'sh600000' ? '1.600000' : undefined),
  )['1.600000']
  assert.equal(cnNoTri.amount, 12345 * 1e4, 'A股 f[37] 是万元 ⇒ 必须 ×1e4（这条防"为了美股把 A股 也改了"）')
  assert.notEqual(cnNoTri.amount, 12345)
  // 港股时刻仍是 14 位纯数字口径
  assert.equal(cnNoTri.ts, parseTencentStamp('20261016150000'))
})

test('④ 时间戳：美东墙上时间 ⇒ 正确 UTC 瞬时，且与宿主时区无关（反例：按东八区解释 ⇒ 红）', () => {
  // 实测：usFRO 的 f[30] = "2026-10-16 16:04:53"（美东，EDT=−4）⇒ 20:04:53Z
  assert.equal(parseTencentUsStamp('2026-10-16 16:04:53'), 1792181093000)
  // 判别性输入：ET 收盘 16:00 ⇒ 20:00Z。若把 ET 当东八区（或当 UTC），会分别得到 08:00Z / 16:00Z ⇒ 下面必红
  assert.equal(parseTencentUsStamp('2026-10-16 16:00:01'), Date.UTC(2026, 9, 16, 20, 0, 1))
  assert.notEqual(parseTencentUsStamp('2026-10-16 16:00:01'), Date.UTC(2026, 9, 16, 8, 0, 1), '反例：把美东当东八区（−12h 口径）必须失败')
  assert.notEqual(parseTencentUsStamp('2026-10-16 16:00:01'), Date.UTC(2026, 9, 16, 16, 0, 1), '反例：把美东当 UTC 必须失败')
  // DST：1 月是 EST(−5) ⇒ 16:00 ET = 21:00Z；7 月是 EDT(−4) ⇒ 12:00 ET = 16:00Z
  assert.equal(parseTencentUsStamp('2026-01-15 16:00:00'), Date.UTC(2026, 0, 15, 21, 0, 0), '冬令时必须按 EST(−5) 换算')
  assert.equal(parseTencentUsStamp('2026-07-01 12:00:00'), Date.UTC(2026, 6, 1, 16, 0, 0), '夏令时必须按 EDT(−4) 换算')
  // 解析不了就给 null，不许拿别的时间凑
  assert.equal(parseTencentUsStamp('2026-10-16T16:00:01Z'), null)
  assert.equal(parseTencentUsStamp('16:00:01'), null)
  assert.equal(parseTencentUsStamp(''), null)
  // ⚠ 老解析器保持原样：它对美股这种 `-` 分隔的写法仍返回 null（证明没给它加"按本机时区解析"的分支）
  assert.equal(parseTencentStamp('2026-10-16 16:00:01'), null)
  // 行级：解析出来的 ts 就是上面那个瞬时（该断言在 TZ=UTC 与 TZ=Asia/Shanghai 两轮里都必须一致）
  assert.equal(parseUs(TX_US)['106.FRO'].ts, 1792181093000)
})

test('⑤ 未知 ticker：上游不回行 ⇒ 解析结果里没有它（不许回 0 价 / 不许拿别的品种顶替）', () => {
  const rows = parseTencentQuoteText(TX_US, (code) => (code === 'usZZZZNOTREAL' ? '105.ZZZZ' : undefined))
  assert.deepEqual(rows, {}, '回包里没有这一行 ⇒ 不得产出任何行')
  // 上游给了行但价格是 0 ⇒ 解析层如实保留 0（不编造价格）；随后由转换层按"无有效价"丢弃
  const zero = parseTencentQuoteText(
    mkTxRow('usZERO', { 1: 'Zero', 2: 'ZERO.N', 3: '0', 30: '2026-10-16 16:00:00', 32: '0', 35: 'USD' }),
    (c) => (c === 'usZERO' ? '105.ZERO' : undefined),
  )
  assert.equal(zero['105.ZERO']?.price, 0, '解析层不编造价格（0 就是 0）')
  // 另一条更狠的反例：新浪对**不存在的美股代码**会回一行"全零空壳"（价格给 1.0000，其余全 0）
  // 实测抓包（2026-10-17）：`var hq_str_gb_zzzz="ZZZZ,1.0000,0.00,2026-05-28 09:30:13,0.0000,…,0.0000"`
  const placeholder = parseSinaHq('var hq_str_gb_zzzz="ZZZZ,1.0000,0.00,2026-05-28 09:30:13,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0,0,0,0.00,--,0.00,0.00,0.00,0.00,0,0,0.0000,0.00,0.00,,Oct 16 09:10AM EDT,0.0000,0,1,2026,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000";')
  assert.deepEqual(placeholder, {}, '占位行必须被丢弃（否则界面会把"没有这只票"显示成 1.00 / 0.00%）')
  assert.deepEqual(parseSinaGb('var hq_str_gb_zzzz="ZZZZ,1.0000,0.00,2026-05-28 09:30:13,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0,0,0,0.00,--,0.00,0.00,0.00,0.00,0,0,0.0000,0.00,0.00,,Oct 16 09:10AM EDT,0.0000,0,1,2026,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000";'), {}, 'parseSinaGb 同样必须丢弃占位行')
  // 对照：真实行不会被误杀（停牌股仍有昨收 ⇒ 保留）
  const halted = parseSinaHq('var hq_str_gb_halt="Halt,10.0000,0.00,2026-10-17 09:00:00,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0,0,0,0.00,--,0.00,0.00,0.00,0.00,0,0,0.0000,0.00,0.00,,Oct 16 04:00PM EDT,9.9000,0,1,2026,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000";')
  assert.equal(halted['gb_halt']?.price, 10, '有昨收的停牌行不得被误杀')
})

test('⑥ 新浪 gb_*：映射是规则不是静态表；量/额/市值/成交时刻齐全，且与腾讯交叉一致', () => {
  assert.equal(sinaSymbol('106.FRO'), 'gb_fro')
  assert.equal(sinaSymbol('107.VIXY'), 'gb_vixy')
  assert.equal(sinaSymbol('105.AAPL'), 'gb_aapl')
  assert.equal(sinaSymbol('106.fro'), 'gb_fro', '大小写无关')
  // 未命中：非美股前缀 / 空 ticker
  assert.equal(sinaSymbol('999.FRO'), null)
  assert.equal(sinaSymbol('105.'), null)
  // 既有静态表不受影响（期货/商品仍是逐标的登记）
  assert.equal(sinaSymbol('113.rbm'), 'nf_RB0')
  assert.equal(sinaSymbol('122.XAU'), 'hf_XAU')
  assert.equal(sinaSymbol('100.SPX'), null, '国际指数仍不走新浪 int_*')

  const gb = parseSinaHq(GB_US)
  const fro = gb['gb_fro']
  const vixy = gb['gb_vixy']
  assert.ok(fro !== undefined && vixy !== undefined, '两行 gb_ 都要解析出来')
  assert.equal(fro.price, 52.49)
  assert.equal(fro.pct, -0.1)
  assert.equal(fro.prev, 52.54)
  assert.equal(fro.open, 53.63)
  assert.equal(fro.high, 54.19)
  assert.equal(fro.low, 52.38)
  assert.equal(fro.vol, 3722974)
  assert.equal(fro.amount, 197036261)
  assert.equal(fro.totalMv, 11685475706)
  assert.equal(fro.shares, 222622894)
  // 成交时刻：`Oct 16 07:57PM EDT` ⇒ 23:57Z（EDT = UTC−4）
  assert.equal(fro.time, Date.UTC(2026, 9, 16, 23, 57, 0))
  assert.equal(vixy.price, 17.73)
  assert.equal(vixy.totalMv, 240529647)
  // 交叉校验：price × shares == totalMv（容差 0.01%）
  for (const q of [fro, vixy]) {
    assert.ok(q.price > 0 && q.shares !== null && q.totalMv !== null)
    const drift = Math.abs(q.price * q.shares - q.totalMv) / q.totalMv
    assert.ok(drift < 1e-4, `price×shares 必须与总市值一致（drift ${drift}）`)
  }
  // 与腾讯逐项一致（同一时刻的两个源）：价与涨跌幅必须完全相同
  const tx = parseUs(TX_US)
  assert.equal(tx['106.FRO'].price, fro.price)
  assert.equal(tx['106.FRO'].pct, fro.pct)
  assert.equal(tx['107.VIXY'].price, vixy.price)
  assert.equal(tx['107.VIXY'].pct, vixy.pct)
  // 成交额两源差 < 0.5%（快照时刻不同，不必逐位相等）
  assert.ok(Math.abs(tx['106.FRO'].amount! - fro.amount!) / fro.amount! < 0.005, '成交额两源必须同量级')
  // `parseSinaGb` 是既有函数（globalFlow 的规模原语在用），扩字段后必须向后兼容
  const legacy = parseSinaGb(GB_US)['gb_fro']
  assert.equal(legacy.totalMv, 11685475706)
  assert.equal(legacy.shares, 222622894)
  assert.equal(legacy.time, '2026-10-17 09:43:52', '老字段（下发时刻文本）语义不变')
})

test('⑦ 端到端：东财挂 + 腾讯不回行 ⇒ 新浪补齐，行里 vol/amount/time/totalMv 不再是 null', async () => {
  const em = await import('./em.ts')
  const detail = await withStubs({ tencent: '', sina: GB_US }, () => em.fetchQuotesDetailed(['106.FRO', '107.VIXY'])) as {
    items: Record<string, { source?: string; price: number | null; vol: number | null; amount: number | null; totalMv?: number | null; time: number | null }>
    missing: string[]
  }
  const fro = detail.items['106.FRO']
  const vixy = detail.items['107.VIXY']
  assert.ok(fro !== undefined && vixy !== undefined, `两个标的都必须有行（实际 ${JSON.stringify(Object.keys(detail.items))}）`)
  assert.equal(fro.source, 'sina')
  assert.equal(fro.price, 52.49)
  assert.equal(fro.vol, 3722974, '新浪兜底必须带上成交量（此前一律 null）')
  assert.equal(fro.amount, 197036261, '新浪兜底必须带上成交额')
  assert.equal(fro.totalMv, 11685475706, '新浪兜底必须带上总市值')
  assert.equal(fro.time, Date.UTC(2026, 9, 16, 23, 57, 0), '新浪兜底必须带上成交时刻（epoch ms）')
  assert.equal(vixy.source, 'sina')
  assert.equal(vixy.amount, 270624597)
  assert.deepEqual(detail.missing, [], '两源之一给出价格 ⇒ 不得进 missing')
})

test('⑧ 文案：有兜底却两源都没给价 ⇒ 「东财与备用源」+ transient（不是"没有备用源映射"）', async () => {
  const em = await import('./em.ts')
  const got = await withStubs({ tencent: '', sina: GB_US }, () => em.fetchQuotesWithProvenance(['105.ZZZZ'])) as {
    provenance: { missing: Array<{ what: string; why: string; note: string }> }
  }
  const miss = got.provenance.missing.find((m) => m.what === '105.ZZZZ')
  assert.ok(miss !== undefined, `缺失必须如实进 missing（实际 ${JSON.stringify(got.provenance.missing)}）`)
  assert.equal(miss.why, 'transient')
  assert.ok(miss.note.includes('东财与备用源'), `文案必须点明两边都没给（实际：${miss.note}）`)
  assert.equal(miss.note.includes('没有腾讯/新浪备用源映射'), false, '美股已有映射 ⇒ 不许再报"没有备用源映射"')
})

test('⑨ robotsGate 接入面：恰好是宏观/归档链（新增报价链接入 ⇒ 必败；删掉宏观链接入 ⇒ 必败）', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
  const scanned: Array<[string, string]> = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if ((name.endsWith('.ts') || name.endsWith('.tsx')) && !name.endsWith('.test.ts')) scanned.push([relative(SRC, p), readFileSync(p, 'utf8')])
    }
  }
  walk(SRC)
  const ROBOTS = /from '[^']*robotsGate\.ts'/
  const detect = (files: Array<[string, string]>): string[] => files.filter(([, text]) => ROBOTS.test(text)).map(([f]) => f).sort()
  /**
   * 宏观/归档链 = **两份**：`globalFlow`（宏观四源）与 `marketExtras`（美元指数/美债 10Y
   * 及其历史，与 globalFlow 同一主机同一路径）。报价链（`em/tencent/sina`）的显式豁免见
   * `docs/DECISIONS.md`。
   *
   * ⚠ REVIEW-7 D3：本判据只证明「**谁 import 了 robotsGate**」，证明不了「宏观取数点都过了门禁」。
   * 真正的取数点级判据在 `fix7Host.test.ts` 的 D3（结构扫描：宏观块里不许有裸 `fetch(`）。
   * 两条一起才完整 —— 这条负责"接线面不许再扩散"，那条负责"接线之后真的走门禁"。
   */
  const MACRO_IMPORTERS = ['host/globalFlow.ts', 'host/marketExtras.ts']
  assert.deepEqual(detect(scanned), MACRO_IMPORTERS, `robotsGate 的接入面变了：${JSON.stringify(detect(scanned))}`)
  // 反例注入（三个方向都要能红）
  assert.deepEqual(detect([...scanned, ['host/em.ts', "import { gatedFetch } from './robotsGate.ts'"]]), ['host/em.ts', ...MACRO_IMPORTERS], '反例：报价链接入 robotsGate ⇒ 判据必须抓到')
  const withoutMacro = scanned.map(([f, t]) => [f, MACRO_IMPORTERS.includes(f) ? t.replace(ROBOTS, '') : t] as [string, string])
  assert.deepEqual(detect(withoutMacro), [], '反例：把宏观链接入删掉 ⇒ 判据必须抓到（接入面变空也算变了）')
  const onlyGlobalFlow = scanned.map(([f, t]) => [f, f === 'host/marketExtras.ts' ? t.replace(ROBOTS, '') : t] as [string, string])
  assert.deepEqual(detect(onlyGlobalFlow), ['host/globalFlow.ts'], '反例：只留 globalFlow ⇒ 回到"宏观有第二扇门"的旧状态，判据必须抓到')
})

/** 按"字段下标 → 值"构造一行腾讯回包（数组长度固定 75，够覆盖美股 73 字段布局） */
function mkTxRow(code: string, fields: Record<number, string>): string {
  const f: string[] = new Array(75).fill('0')
  for (const [i, v] of Object.entries(fields)) f[Number(i)] = v
  return `v_${code}="${f.join('~')}";`
}

/** 把 fetch 换成"只有指定源回包"的桩：东财一律失败，腾讯/新浪按参数回文本 */
async function withStubs(payloads: { tencent: string; sina: string }, run: () => Promise<unknown>): Promise<unknown> {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    if (url.includes('qt.gtimg.cn')) return new Response(payloads.tencent, { status: 200 })
    if (url.includes('hq.sinajs.cn')) return new Response(payloads.sina, { status: 200 })
    throw new Error('offline (us quote test)')
  }) as typeof fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = realFetch
  }
}
