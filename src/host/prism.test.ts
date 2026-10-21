/**
 * 【棱镜】宿主侧判据：聚合、Stoikov 保护、Monte Carlo、回包永远 200、缺数据给原因。
 *
 * 每条判据都配**反例注入**（把"不该发生的事"构造出来 ⇒ 判据必须非空）：
 *  ⑦ 10/30 分钟聚合（6 根 5 分钟 ⇒ 1 根 30 分钟；取错首/末 ⇒ 必败）
 *  ⑧ Stoikov 的 `T−t → 0` 保护（不夹回 s ⇒ 必败）
 *  ⑨ Monte Carlo 的假设/次数/可复现
 *  ⑩ 路由**永远 200**（缺数据抛错也 200；六块齐全 + 原因，不写 0）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PRISM_DEFAULT_PARAMS,
  PRISM_BLOCK_KEYS,
  PRISM_FALLBACK_SECID,
  prismMarketOf,
  resolvePairA,
  type PrismBook,
  type PrismParams,
} from '../shared/prism.ts'
import {
  aggregateBars,
  buildPrismPayload,
  emptyPrismPayload,
  freqNoteOf,
  mcBlock,
  midInputOf,
  parsePrismQuery,
  prismBucketOf,
  prismResponse,
  spreadBlock,
  stoikovBlock,
} from './prism.ts'
import {
  PRISM_US_KEEP_BARS,
  PRISM_US_TYPES,
  fetchFiveLevelBook,
  fetchFiveMinuteBars,
  fetchSinaUsBars,
  hkQuoteSymbol,
  parseSinaHkQuote,
  parseTencentDepthBook,
  parseUsMinuteText,
  sinaUsTicker,
  usMinuteUrl,
  type PrismBar,
  type PrismFeed,
} from './prismFeed.ts'
import {
  bookContractProblems,
  mcAssumptionProblems,
  prismPayloadProblems,
  stanceProblems,
  stoikovProtectionProblems,
  targetProblems,
} from '../client/prismView.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const hhmm = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

/** 一个交易日的 48 根 5 分钟 label（09:35..11:30、13:05..15:00；上游给的是**收盘时刻**） */
function sessionLabels(n: number, day = '2026-10-21'): string[] {
  const out: string[] = []
  for (let d = 0; out.length < n; d += 1) {
    const dayText = d === 0 ? day : `2026-10-${String(22 + d - 1).padStart(2, '0')}`
    for (let i = 0; i < 48 && out.length < n; i += 1) {
      const minutes = i < 24 ? 9 * 60 + 35 + 5 * i : 13 * 60 + 5 + 5 * (i - 24)
      out.push(`${dayText} ${hhmm(minutes)}`)
    }
  }
  return out
}

/** 造一段 5 分钟线（价格有趋势、量有波动 ⇒ Bayes 三个特征都算得出来） */
function mkBars(n: number, base = 100, seed0 = 7): PrismBar[] {
  let seed = seed0
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  let price = base
  return sessionLabels(n).map((label, i) => {
    const open = price
    const close = Math.max(1, price + (rnd() - 0.45) * base * 0.004)
    const high = Math.max(open, close) + rnd() * base * 0.002
    const low = Math.min(open, close) - rnd() * base * 0.002
    price = close
    return { t: i * 300_000, label, open, high, low, close, vol: 1000 + Math.round(rnd() * 5000) }
  })
}

const feedOf = (bars: PrismBar[], error: string | null = null): PrismFeed => ({ bars, source: error === null ? 'sina-5min' : null, volUnit: '股', error })

const bookOf = (microPrice: number | null): PrismBook => ({
  available: microPrice !== null,
  reason: microPrice === null ? '五档拿不到（测试用）' : null,
  source: microPrice === null ? null : '腾讯五档（量单位：手，可用 5 档）',
  levels: microPrice === null ? 0 : 5,
  bids: [],
  asks: [],
  microPrice,
  quoteMid: null,
  quoteSource: null,
  quoteAt: null,
})

/** 只有价的盘口（港股形态）：`available:false` + `microPrice:null` + `quoteMid` + source/at */
const quoteBook = (quoteMid: number | null, reason = '港股只有盘口价、没有可用的委托量'): PrismBook => ({
  available: false,
  reason,
  source: null,
  levels: 0,
  bids: [],
  asks: [],
  microPrice: null,
  quoteMid,
  quoteSource: quoteMid === null ? null : '盘口中点（1 档价） · 新浪港股盘口价（量不可用）',
  quoteAt: quoteMid === null ? null : 1_761_020_280_000,
})

const paramsOf = (patch: Partial<PrismParams> = {}): PrismParams => ({ ...PRISM_DEFAULT_PARAMS, pairA: '1.600519', pairB: '0.000001', ...patch })

const payloadOf = (bars: PrismBar[], params: PrismParams = paramsOf()) =>
  buildPrismPayload({
    params,
    feedA: feedOf(bars),
    // 配对 B 用另一段序列（同一个 base/seed 会让价差恒 0 ⇒ σ=0，那是"不可算"的正确形态）
    feedB: feedOf(mkBars(bars.length, 50, 11)),
    // 可算路径用"有量"的盘口（A/B 给不同 mid ⇒ 价差 mid = ln(2)，z 仍由收盘价算）
    bookA: bookOf(100),
    bookB: bookOf(50),
    asOf: 1_700_000_000_000,
    universe: [{ secid: '1.600519', name: '贵州茅台' }],
  })

/* ────────────────────────────── ⑦ 聚合 ────────────────────────────── */

test('⑦ 10/30 分钟聚合：6 根 5 分钟 ⇒ 1 根 30 分钟（OHLC 与量都对；取错首/末必败）', () => {
  const six: PrismBar[] = [
    { t: 0, label: '2026-10-21 09:35', open: 10, high: 11, low: 9.5, close: 10.5, vol: 100 },
    { t: 1, label: '2026-10-21 09:40', open: 10.5, high: 12, low: 10.2, close: 11, vol: 200 },
    { t: 2, label: '2026-10-21 09:45', open: 11, high: 11.4, low: 10.6, close: 10.8, vol: 300 },
    { t: 3, label: '2026-10-21 09:50', open: 10.8, high: 11.2, low: 10.4, close: 11.1, vol: 400 },
    { t: 4, label: '2026-10-21 09:55', open: 11.1, high: 11.3, low: 10.9, close: 11.2, vol: 500 },
    { t: 5, label: '2026-10-21 10:00', open: 11.2, high: 11.5, low: 11.0, close: 11.4, vol: 600 },
  ]
  const agg = aggregateBars(six, 30)
  assert.equal(agg.length, 1, '6 根 5 分钟必须聚成 1 根 30 分钟')
  const bar = agg[0] as PrismBar
  assert.equal(bar.open, 10, '开盘取**首根**的开盘价')
  assert.equal(bar.close, 11.4, '收盘取**末根**的收盘价')
  assert.equal(bar.high, 12, '最高取全组最大值')
  assert.equal(bar.low, 9.5, '最低取全组最小值')
  assert.equal(bar.vol, 2100, '量取全组之和（100+200+…+600）')
  assert.equal(bar.label, '2026-10-21 10:00', 'label 用末根的收盘时刻')
  assert.equal(bar.partial, false, '6 根齐 ⇒ 不是未收满')
  // 10 分钟：2 根 ⇒ 1 根
  const agg10 = aggregateBars(six.slice(0, 2), 10)
  assert.equal(agg10.length, 1)
  assert.equal(agg10[0]?.close, 11)
  assert.equal(agg10[0]?.vol, 300)
  // 5 分钟：原样（排序后）
  assert.deepEqual(aggregateBars([six[1] as PrismBar, six[0] as PrismBar], 5).map((b) => b.label), ['2026-10-21 09:35', '2026-10-21 09:40'])
  // 桶归属：收盘 10:00 的起点是 09:55 ⇒ 仍在 30 分钟的第 0 桶（用收盘时刻分桶会错到第 1 桶）
  assert.equal(prismBucketOf(six[5] as PrismBar, 30), '0', '09:55 起的 bar 必须落在 30 分钟第 0 桶')
  assert.equal(prismBucketOf(six[5] as PrismBar, 10), '2', '09:55 起 ⇒ 10 分钟第 2 桶')
  // 量缺失 ⇒ 整根 null（不拿已知部分冒充）
  const gap = aggregateBars([{ ...(six[0] as PrismBar), vol: null }, six[1] as PrismBar], 10)
  assert.equal(gap[0]?.vol, null, '组内有 bar 缺量 ⇒ 整根量记 null')
  // 反例注入：把"首根收盘/末根开盘"当开高低收 ⇒ 判据必须失败
  const broken = { open: (six[5] as PrismBar).open, close: (six[0] as PrismBar).close }
  assert.notDeepEqual(broken, { open: bar.open, close: bar.close }, '⚠ 反例（取错首/末）必须与正确口径不同')
  assert.throws(() => assert.equal(broken.open, 10, '反例上"开盘=首根开盘"必须失败'), /反例上/, '⚠ 反例注入必须让断言失败')
  // 频率口径文案
  assert.equal(freqNoteOf(30, false), '30 分钟（5 分钟聚合 6 根）')
  assert.equal(freqNoteOf(5, false), '5 分钟（原始档）')
})

/* ────────────────────────────── ⑧ Stoikov 保护 ────────────────────────────── */

test('⑧ Stoikov：T−t → 0 时保留价夹回 s 并标保护（不保护 ⇒ 必败）', () => {
  const bars = mkBars(120)
  const s = 100
  const zero = stoikovBlock(bars, paramsOf({ ttBars: 0, q: 1000, gamma: 1 }), s, '测试')
  assert.equal(zero.available, true, '有 σ² 与 s ⇒ 可算')
  assert.equal(zero.protected, true, 'T−t=0 必须触发保护')
  assert.equal(zero.reserve, s, 'T−t→0 时 r 必须等于 s')
  assert.match(String(zero.protectReason), /保护已生效/)
  assert.deepEqual(stoikovProtectionProblems(zero), [], '保护判据必须通过')
  // 正常窗口：r ≠ s（除非 q=0），且未保护
  const normal = stoikovBlock(bars, paramsOf({ ttBars: 12, q: 1, gamma: 0.1 }), s, '测试')
  assert.equal(normal.protected, false, '正常窗口不必触发保护')
  assert.notEqual(normal.reserve, s, 'q≠0 且 T−t 足够大 ⇒ 保留价应偏离 s')
  // 反例注入：不保护（照原公式给偏离值）⇒ 判据必须非空
  const unprotected = { ...zero, reserve: s - 5, protected: false, protectReason: null }
  assert.notDeepEqual(stoikovProtectionProblems(unprotected), [], '⚠ 反例（T−t=0 却不保护）必须被抓到')
  assert.throws(
    () => assert.deepEqual(stoikovProtectionProblems(unprotected), [], '反例上"保护必须生效"必须失败'),
    /反例上/,
    '⚠ 反例注入（不保护）必须让断言失败',
  )
  // 偏离 > 20%·s 也要被夹住
  const huge = stoikovBlock(bars, paramsOf({ ttBars: 50, q: 1000, gamma: 1 }), s, '测试')
  assert.equal(huge.protected, true, '偏离 > 20% 必须触发保护')
  assert.ok(Math.abs((huge.reserve as number) - s) <= 0.2 * s + 1e-9, '偏离必须被夹到 20% 以内')
})

/* ────────────────────────────── ⑨ Monte Carlo ────────────────────────────── */

test('⑨ Monte Carlo：≥1 万次、四条假设、可复现、破产概率与 MDD 分位是有限数', () => {
  const params = paramsOf({ mcRuns: 5, mcFill: 0.75, mcPErr: 0.05 })
  const a = mcBlock(0.55, 30, 20, params, 1.2)
  assert.equal(a.available, true)
  assert.equal(a.runs, 10_000, '次数低于 1 万必须被夹到 1 万（需求：≥1 万次）')
  assert.equal(a.samples, 10_000)
  assert.equal(a.assumptions.length, 4, '四条假设必须齐全')
  assert.deepEqual(a.assumptions.map((x) => x.key), ['fill', 'slip', 'latency', 'pErr'])
  assert.deepEqual(mcAssumptionProblems(a), [], '假设判据必须通过')
  assert.ok(Number.isFinite(a.mddP50) && Number.isFinite(a.mddP95), 'MDD 分位必须是有限数')
  assert.ok((a.ruinProb as number) >= 0 && (a.ruinProb as number) <= 1, '破产概率必须在 0..1')
  assert.equal(a.equity.length, 24, '中位路径取 24 个检查点')
  // 固定种子 ⇒ 两次结果逐字相同（页面不会因为刷新而"跳"）
  const b = mcBlock(0.55, 30, 20, params, 1.2)
  assert.deepEqual(b.equity, a.equity, '同一组参数必须得到同一条路径（固定种子）')
  assert.equal(b.ruinProb, a.ruinProb)
  // 反例注入：删掉一条假设 ⇒ 判据必须非空
  const dropped = { ...a, assumptions: a.assumptions.slice(0, 3) }
  assert.notDeepEqual(mcAssumptionProblems(dropped), [], '⚠ 反例（少一条假设）必须被抓到')
  // p 不可算 ⇒ 不可算 + 原因（不跑一个"看起来正常"的模拟）
  const noP = mcBlock(null, 30, 20, params, 1.2)
  assert.equal(noP.available, false)
  assert.match(String(noP.reason), /p 不可算/)
  assert.equal(noP.mddP50, null, '不可算时不许给 0')
})

/* ────────────────────────────── ② 回包：六块 + 原因 ────────────────────────────── */

test('② 回包六块齐全：可算块 samples>0、不可算块给原因、数值全是有限数', () => {
  const bars = mkBars(200)
  const payload = payloadOf(bars)
  assert.deepEqual(prismPayloadProblems(payload), [], `回包判据必须通过：${JSON.stringify(prismPayloadProblems(payload))}`)
  assert.equal(Object.keys(payload.blocks).length, 6)
  assert.equal(payload.blocks.bayes.available, true, '200 根 ⇒ Bayes 可算')
  assert.ok((payload.blocks.bayes.p as number) > 0 && (payload.blocks.bayes.p as number) < 1, 'p 必须落在 (0,1)')
  assert.equal(payload.blocks.edge.available, true, '200 根 ⇒ Edge 可算')
  assert.equal(payload.blocks.spread.available, true, '配对 A/B 都是同一段 ⇒ z 可算')
  assert.equal(payload.blocks.stoikov.available, true)
  assert.equal(payload.blocks.kelly.available, true)
  assert.equal(payload.blocks.mc.available, true)
  // 反例注入 A：可算却 samples=0（"写 0 冒充"的形态）⇒ 必败
  const zeroSamples = { ...payload, blocks: { ...payload.blocks, bayes: { ...payload.blocks.bayes, samples: 0 } } }
  assert.notDeepEqual(prismPayloadProblems(zeroSamples), [], '⚠ 反例（可算但 samples=0）必须被抓到')
  // 反例注入 B：不可算却没有原因 ⇒ 必败
  const noReason = { ...payload, blocks: { ...payload.blocks, mc: { ...payload.blocks.mc, available: false, reason: null } } }
  assert.notDeepEqual(prismPayloadProblems(noReason), [], '⚠ 反例（不可算且无原因）必须被抓到')
  // 反例注入 C：把 None 换成 NaN ⇒ 必败
  const nan = { ...payload, blocks: { ...payload.blocks, edge: { ...payload.blocks.edge, evBps: Number.NaN } } }
  assert.notDeepEqual(prismPayloadProblems(nan), [], '⚠ 反例（NaN）必须被抓到')
})

test('② 输入不足：频率降到 30 仍不够 ⇒ 六块都不可算 + 三档尝试足迹（不编数）', () => {
  const short = mkBars(20)
  const payload = payloadOf(short)
  assert.deepEqual(prismPayloadProblems(payload), [], `短样本回包也必须形状完整：${JSON.stringify(prismPayloadProblems(payload))}`)
  assert.equal(payload.downgrade === null, false, '样本不足必须留下降频足迹')
  assert.deepEqual(payload.downgrade?.attempts.map((a) => a.freq), [5, 10, 30], '先降频的顺序固定 5 → 10 → 30')
  assert.equal(payload.blocks.bayes.available, false)
  assert.ok((payload.blocks.bayes.reason ?? '').length > 0, '不可算必须给一句原因')
  // 空 feed（上游失败）⇒ 原因就是上游给的那句
  const failed = buildPrismPayload({ params: paramsOf(), feedA: feedOf([], '新浪 5 分钟失败（HTTP 403）'), feedB: null, bookA: bookOf(null), bookB: null })
  assert.equal(failed.blocks.bayes.available, false)
  assert.match(String(failed.bars.reason), /新浪 5 分钟失败/)
  assert.deepEqual(prismPayloadProblems(failed), [], '失败回包也必须形状完整')
})

test('⑪ 结论三态：EV 不达阈值 ⇒ 必须「不下结论」（硬给方向 ⇒ 必败）', () => {
  const bars = mkBars(200)
  const payload = payloadOf(bars)
  const edge = payload.blocks.edge
  assert.deepEqual(stanceProblems(edge), [], '真实回包的结论必须与 EV/阈值一致')
  assert.equal(['看多', '看空', '不下结论'].includes(edge.stance), true)
  // 把阈值抬到极高 ⇒ 必须变成不下结论
  const high = payloadOf(bars, paramsOf({ evMinBps: 199 }))
  assert.equal(high.blocks.edge.stance, '不下结论', 'EV 不可能超过 199bps ⇒ 必须不下结论')
  assert.equal(high.blocks.edge.targets.length, 0, '不下结论时不给目标价')
  // 反例注入：EV 低于阈值却硬给「看多」⇒ 必须被抓到
  const forced = { ...edge, evBps: -10, thresholdBps: 0, p: 0.9, stance: '看多' as const }
  assert.notDeepEqual(stanceProblems(forced), [], '⚠ 反例（EV 不达标仍给方向）必须被抓到')
  assert.throws(
    () => assert.deepEqual(stanceProblems(forced), [], '反例上"EV 不达标必须不下结论"必须失败'),
    /反例上/,
    '⚠ 反例注入（硬给方向）必须让断言失败',
  )
})

test('④ 目标价：必须带规则名且能由输入复算（裸数字 ⇒ 必败）', () => {
  const payload = payloadOf(mkBars(200), paramsOf({ evMinBps: -1000, tgtK: 2 }))
  const edge = payload.blocks.edge
  assert.equal(edge.stance === '不下结论', false, '把阈值放到极低 ⇒ 应有方向（用于验证目标价）')
  assert.ok(edge.targets.length >= 2, '有方向时目标价至少两条（ATR×k / 历史 P95）')
  assert.deepEqual(targetProblems(edge), [], `目标价判据必须通过：${JSON.stringify(targetProblems(edge))}`)
  for (const t of edge.targets) {
    assert.notEqual(t.ruleLabel, '', '每条目标价都必须带规则名')
    assert.ok(Object.keys(t.inputs).length > 0, '每条目标价都必须带全部输入（可复算）')
  }
  // 反例注入 A：拆掉规则名 ⇒ 必败
  const bare = { ...edge, targets: edge.targets.map((t) => ({ ...t, rule: '', ruleLabel: '' })) }
  assert.notDeepEqual(targetProblems(bare), [], '⚠ 反例（裸数字）必须被抓到')
  // 反例注入 B：把值改成不符合规则的手写数 ⇒ 必败
  const fake = { ...edge, targets: edge.targets.map((t) => ({ ...t, value: (t.value as number) + 1 })) }
  assert.notDeepEqual(targetProblems(fake), [], '⚠ 反例（值与规则不符）必须被抓到')
})

/* ────────────────────────────── ⑩ 路由永远 200 ────────────────────────────── */

const routeText = readFileSync(join(ROOT, 'host/routes.ts'), 'utf8')

test('⑩ 回包永远 200：缺参数/上游抛错/空回包都是 200 + 六块 + 原因', async () => {
  const throwing = {
    loadBars: async () => {
      throw new Error('boom')
    },
    loadBook: async () => {
      throw new Error('boom')
    },
    now: () => 1,
  }
  const r1 = await prismResponse('pairA=1.600519&pairB=0.000001', throwing)
  assert.equal(r1.status, 200, '上游抛错也必须 200')
  assert.deepEqual(Object.keys(r1.body.blocks).length, 6, '六块必须齐全')
  assert.deepEqual(prismPayloadProblems(r1.body), [], `抛错回包也必须形状完整：${JSON.stringify(prismPayloadProblems(r1.body))}`)
  assert.equal(r1.body.blocks.bayes.available, false)
  assert.match(String(r1.body.blocks.bayes.reason), /异常|失败|不可算/)
  // 缺 pairA ⇒ 解析成默认 A股（回退）后仍是 200；六块给"无源"原因
  const r2 = await prismResponse('', {
    loadBars: async () => ({ bars: [], source: null, volUnit: null, error: '测试无源' }),
    loadBook: async () => bookOf(null),
    now: () => 1,
  })
  assert.equal(r2.status, 200)
  assert.equal(r2.body.params.pairA, PRISM_FALLBACK_SECID, '未指定标的 ⇒ 默认 A股')
  assert.match(String(r2.body.fallback?.reason), /默认 A股/)
  assert.match(String(r2.body.missing[0]), /测试无源/)
  // 空回包：六块都在、每块都有原因、没有任何 0 冒充
  const empty = emptyPrismPayload(PRISM_DEFAULT_PARAMS, '测试原因')
  assert.deepEqual(prismPayloadProblems(empty), [])
  assert.equal(empty.blocks.edge.evBps, null, '不可算的 EV 必须是 null（不是 0）')
  assert.equal(empty.bars.n, 0)
  // 路由注册与归属（源码锚点）
  assert.equal(routeText.includes("path: '/tradewatcher/prism'"), true, 'routes.ts 必须注册 /tradewatcher/prism')
  assert.equal(routeText.includes("path: '/tradewatcher/prism/"), false, '不许出现 prism 子路径（新开接口）')
  assert.equal(routeText.includes('needGate(req, res)'), true, '沿用既有围栏（唯一非 200 来源是鉴权）')
})

test('参数解析：非法值回落默认（不 400）、频率只认 5/10/30、次数夹到 ≥1 万', () => {
  const q = new URLSearchParams('freq=7&prior=9&mcRuns=100&zN=1&zTh=9&gamma=-2&q=99999&ttBars=-5&pairB=&kellyFrac=0&mcFill=5')
  const p = parsePrismQuery(q)
  assert.equal(p.freq, 5, '非法频率回落默认 5')
  assert.equal(p.prior, 0.8, '先验夹到 0.8')
  assert.equal(p.mcRuns, 10_000, 'MC 次数夹到 ≥ 1 万')
  assert.equal(p.zN, 10, 'zN 夹到 ≥ 10')
  assert.equal(p.zTh, 5, 'z 阈值夹到 ≤ 5')
  assert.equal(p.gamma, 0, 'γ 夹到 ≥ 0')
  assert.equal(p.q, 1000, '模拟库存夹到 ≤ 1000')
  assert.equal(p.ttBars, 0, 'T−t 夹到 ≥ 0')
  assert.equal(p.pairB, null, '空 pairB ⇒ null（不是空串）')
  assert.equal(p.kellyFrac, 0.05, 'Kelly 分数夹到 ≥ 0.05')
  assert.equal(p.mcFill, 1, '成交率夹到 ≤ 1')
  assert.equal(parsePrismQuery(new URLSearchParams('freq=30')).freq, 30)
  assert.equal(parsePrismQuery(new URLSearchParams('freq=10')).freq, 10)
})

test('六个块的键名固定（页面/断言共用一份顺序）', () => {
  assert.deepEqual([...PRISM_BLOCK_KEYS], ['bayes', 'edge', 'spread', 'stoikov', 'kelly', 'mc'])
})


/* ────────────────────────────── 新增：美股分钟 / 港股只有价 ────────────────────────────── */

/**
 * 造一份新浪美股分钟 JSONP 回包（**北京时间与美东无关**：这里直接按 ET 墙上时间生成）。
 * 1023 根、每根 5 分钟（不模拟午休；解析与截尾都不依赖会话结构）。
 */
function usFixture(n: number): string {
  const rows: Array<Record<string, string>> = []
  const start = Date.UTC(2026, 9, 1, 13, 35) // 2026-10-01 09:35 EDT = 13:35Z
  for (let i = 0; i < n; i += 1) {
    const utc = start + i * 300_000
    const et = new Date(utc - 4 * 3_600_000).toISOString() // EDT = UTC−4
    const d = `${et.slice(0, 10)} ${et.slice(11, 19)}`
    const px = (100 + i / 1000).toFixed(4)
    rows.push({ d, o: px, h: px, l: px, c: px, v: '1000', a: '100000' })
  }
  return `/*<script>location.href='//sina.com';</script>*/\nx(${JSON.stringify(rows)})`
}

test('① 美股分钟：5/1/30 各 ≥240 根，符号必须是小写 ticker（gb_ 前缀 ⇒ 必败）', async () => {
  const fixture = usFixture(1023)
  const seen: string[] = []
  const fetchText = async (url: string): Promise<string> => {
    seen.push(url)
    return fixture
  }
  assert.deepEqual([...PRISM_US_TYPES], [1, 5, 30], '美股分钟粒度就是 1/5/30 三档')
  for (const type of PRISM_US_TYPES) {
    const feed = await fetchSinaUsBars(type === 1 ? '105.AAPL' : type === 5 ? '106.FRO' : '107.MSFT', type, { fetchText })
    assert.ok(feed.bars.length >= 240, `type=${type} 必须 ≥240 根（实得 ${feed.bars.length}）`)
    assert.equal(feed.volUnit, '股', '美股分钟的量单位是股')
    assert.equal(feed.source, 'sina-us-min')
    assert.equal(feed.error, null)
  }
  assert.equal(seen.length, 3)
  assert.equal(seen.every((u) => /symbol=(aapl|fro|msft)&type=(1|5|30)/.test(u)), true, `URL 必须是裸 ticker：${seen.join(' / ')}`)
  // 反例注入：改回 gb_ 前缀（旧命名空间）⇒ 判据必须失败
  assert.equal(sinaUsTicker('105.AAPL'), 'aapl')
  const brokenUrl = usMinuteUrl('gb_aapl', 5)
  assert.match(brokenUrl, /symbol=gb_aapl/, '旧命名空间会拼出 gb_ 前缀（那正是错的那一版）')
  assert.throws(
    () => assert.equal(/symbol=gb_|[?&]symbol=us[A-Z]/.test(brokenUrl), false, '反例'),
    /反例/,
    '⚠ 反例注入（gb_ 前缀）必须让断言失败',
  )
  assert.equal(sinaUsTicker('1.600519'), null, '非美股 secid 必须返回 null')
})

test('② 美股 d 是 ET 收盘时刻（按 UTC 解 ⇒ 偏 4–5 小时，必败）', () => {
  const bars = parseUsMinuteText('x([{"d":"2026-10-21 16:00:00","o":"1","h":"1","l":"1","c":"1","v":"1","a":"1"}])')
  assert.equal(bars.length, 1)
  // 2026-10-21 16:00 EDT = 20:00Z
  assert.equal(bars[0]?.t, Date.UTC(2026, 9, 21, 20, 0, 0), '必须按美东墙上时间收敛到 UTC')
  const utcParsed = Date.parse('2026-10-21T16:00:00Z')
  assert.equal(utcParsed, Date.UTC(2026, 9, 21, 16, 0, 0))
  assert.notEqual(bars[0]?.t, utcParsed, '按 UTC 解会偏 4 小时 ⇒ 判据必须能区分')
  assert.throws(
    () => assert.equal(utcParsed, bars[0]?.t, '反例'),
    /反例/,
    '⚠ 反例注入（按 UTC 解）必须让断言失败',
  )
})

test('③ 上游 1023 根 ⇒ 本地 slice(-240)（不截 ⇒ 必败）', async () => {
  const fixture = usFixture(1023)
  const all = parseUsMinuteText(fixture)
  assert.equal(all.length, 1023, '解析层必须保留上游全部根（截尾是取数层的事）')
  const feed = await fetchSinaUsBars('105.AAPL', 5, { fetchText: async () => fixture })
  assert.equal(feed.bars.length, PRISM_US_KEEP_BARS, `取数层只留最近 ${PRISM_US_KEEP_BARS} 根`)
  assert.equal(feed.bars[feed.bars.length - 1]?.label, all[all.length - 1]?.label, '留下的是**最新**的 240 根')
  // 反例注入：不截尾 ⇒ 长度是 1023，断言必须失败
  assert.throws(
    () => assert.equal(all.length, PRISM_US_KEEP_BARS, '反例'),
    /反例/,
    '⚠ 反例注入（不截尾）必须让断言失败',
  )
})

test('④ 港股只有价：available:false、microPrice=null、quoteMid 有值且带 source/at（塞进 microPrice ⇒ 必败）', async () => {
  const hkText = 'var hq_str_rt_hk00700="TENCENT,腾讯控股,412.000,410.400,413.400,400.000,401.000,-9.400,-2.290,401.000,401.200,0,0,0.000,0.000,0.000,400.000,2026/10/21,13:38:00,30|3,N|Y|Y,0.000|0.000|0.000,0|||0.000|0.000|0.000, |0,Y";'
  const q = parseSinaHkQuote(hkText)
  assert.equal(q.bid, 401)
  assert.equal(q.ask, 401.2)
  assert.equal(q.at, Date.parse('2026-10-21T05:38:00Z') + 0, '2026-10-21 13:38 北京/香港 = 05:38Z')
  const book = await fetchFiveLevelBook('116.00700', { fetchText: async (url) => {
    assert.match(url, /rt_hk00700/, '港股只走新浪价对（腾讯盘口弃用）')
    return hkText
  } })
  assert.equal(book.available, false)
  assert.equal(book.levels, 0)
  assert.equal(book.microPrice, null, 'available:false 时**不得**携带 microPrice')
  assert.equal(book.quoteMid, 401.1, '(买一+卖一)/2')
  assert.ok((book.quoteSource ?? '').length > 0, 'quoteMid 必须带来源')
  assert.equal(book.quoteAt, Date.parse('2026-10-21T05:38:00Z'))
  assert.deepEqual(bookContractProblems(book), [])
  // 反例注入：把 mid 塞进 microPrice ⇒ 契约判据必须非空
  const mixed = { ...book, microPrice: book.quoteMid }
  assert.notDeepEqual(bookContractProblems(mixed), [], '⚠ 反例（mid 塞进 microPrice）必须被抓到')
  assert.throws(
    () => assert.deepEqual(bookContractProblems(mixed), [], '反例上"契约"必须失败'),
    /反例上/,
    '⚠ 反例注入（混用两种形态）必须让断言失败',
  )
})

test('⑤ mid/s 输入优先 micro-price，其次盘口中点；两者都没有才给原因（跳过 quoteMid ⇒ 必败）', () => {
  const micro = bookOf(100)
  const quote = quoteBook(50)
  assert.deepEqual(midInputOf(micro), { value: 100, label: 'micro-price（5 档）' })
  assert.deepEqual(midInputOf(quote), { value: 50, label: '盘口中点（1 档价）' })
  // 两个都有（非法构造）⇒ micro 优先
  const both = { ...micro, quoteMid: 99, quoteSource: 'x', quoteAt: 1 }
  assert.equal(midInputOf(both).label, 'micro-price（5 档）')
  // 反例注入：直接跳过 quoteMid ⇒ 空值（判据必须失败）
  const skipQuote = (b: PrismBook) => (b.microPrice !== null ? { value: b.microPrice, label: 'micro-price（5 档）' } : { value: null, label: null })
  assert.equal(skipQuote(quote).value, null, '⚠ 反例（跳过 quoteMid）会丢掉港股唯一可用的输入')
  assert.throws(() => assert.equal(skipQuote(quote).value, 50, '反例'), /反例/, '⚠ 反例注入（跳过 quoteMid）必须让断言失败')

  const bars = mkBars(200)
  const barsB = mkBars(200, 50, 11)
  const spread = spreadBlock(bars, barsB, paramsOf(), micro, quote)
  assert.equal(spread.midSource, 'A micro-price（5 档） / B 盘口中点（1 档价）', '混合输入必须逐标的写清')
  assert.notEqual(spread.mid, null)
  // Stoikov：A 只有价 ⇒ s = quoteMid，输入名必须写出来
  const payload = buildPrismPayload({
    params: paramsOf(), feedA: feedOf(bars), feedB: feedOf(barsB), bookA: quote, bookB: quote, asOf: 1,
  })
  assert.equal(payload.blocks.stoikov.s, 50)
  assert.equal(payload.blocks.stoikov.sSource, '盘口中点（1 档价）', 's 的输入名必须如实')
  assert.equal(payload.blocks.spread.midSource, '盘口中点（1 档价）')
  // 两者都没有 ⇒ 给原因（不拿收盘价凑）
  const none = quoteBook(null, '盘口拿不到（测试用）')
  const payload2 = buildPrismPayload({
    params: paramsOf(), feedA: feedOf(bars), feedB: feedOf(barsB), bookA: none, bookB: none, asOf: 1,
  })
  assert.equal(payload2.blocks.stoikov.available, false)
  assert.match(String(payload2.blocks.stoikov.reason), /micro-price|盘口中点/)
  assert.equal(payload2.blocks.spread.mid, null)
  assert.match(String(payload2.blocks.spread.midReason), /盘口/)
})

test('⑥ 沪深回归：腾讯五档仍是 5 档 micro-price，且 quoteMid 必须为 null', () => {
  const fields = [
    '1', '贵州茅台', '600519', '1313.29', '1331.88', '1331.88', '15674', '7486', '8188',
    '1312.61', '2', '1312.60', '2', '1312.58', '34', '1312.54', '1', '1312.50', '5',
    '1313.28', '6', '1313.29', '2', '1313.81', '2', '1313.83', '2', '1313.85', '1', '',
    '20261021125708',
  ]
  const book = parseTencentDepthBook(`v_sh600519="${fields.join('~')}"`)
  assert.equal(book.available, true)
  assert.equal(book.levels, 5)
  assert.notEqual(book.microPrice, null)
  assert.equal(book.quoteMid, null, '有量形态不许同时带 quoteMid')
  assert.deepEqual(bookContractProblems(book), [])
  assert.equal(midInputOf(book).label, 'micro-price（5 档）')
  // 指数形态（价量全 0）⇒ 不可用 + 原因，不编 0
  const zeros = [...fields]
  for (let i = 9; i <= 28; i += 1) zeros[i] = '0.00'
  const index = parseTencentDepthBook(`v_sh000001="${zeros.join('~')}"`)
  assert.equal(index.available, false)
  assert.equal(index.microPrice, null)
  assert.match(String(index.reason), /买一\/卖一数量/)
})


/* ────────────────────────────── 默认标的 / 回退 / 原因按市场分列 ────────────────────────────── */

test('① 默认标的是 A股（自选首个 A股 → 1.600519），首屏至少四块有数值（默认港股 ⇒ 必败）', async () => {
  const universe = [{ secid: '116.00148', name: '港股测试' }, { secid: '1.601118', name: '中国建筑' }]
  const loader = async (secid: string): Promise<PrismFeed> =>
    secid.startsWith('116.')
      ? { bars: [], source: null, volUnit: null, error: '港股无分钟线源（需授权行情）' }
      : feedOf(mkBars(60))
  const r = await prismResponse('', { loadBars: loader, loadBook: async () => bookOf(100), now: () => 1 }, universe)
  assert.equal(r.body.params.pairA, '1.601118', '默认必须取自选里第一个 A股（不是港股）')
  const available = (['bayes', 'edge', 'spread', 'stoikov', 'kelly', 'mc'] as const).filter((k) => r.body.blocks[k].available)
  assert.ok(available.length >= 4, `首屏至少四块有数值（实得 ${available.length}：${available.join(',')}）`)
  // 自选里没有 A股 ⇒ 兜底 1.600519
  const r2 = await prismResponse('', { loadBars: loader, loadBook: async () => bookOf(100), now: () => 1 }, [{ secid: '116.00148', name: '港股测试' }])
  assert.equal(r2.body.params.pairA, PRISM_FALLBACK_SECID)
  // 反例注入：还原"默认直接用自选首项（港股）+ 不回退"的旧行为 ⇒ 六块全空
  const brokenDefault = (u: Array<{ secid: string }>): string => u[0]?.secid ?? PRISM_FALLBACK_SECID
  assert.equal(brokenDefault(universe), '116.00148')
  const badPayload = buildPrismPayload({
    params: { ...PRISM_DEFAULT_PARAMS, pairA: brokenDefault(universe) },
    feedA: { bars: [], source: null, volUnit: null, error: '港股无分钟线源（需授权行情）' },
    feedB: null,
    bookA: bookOf(null),
    bookB: null,
    asOf: 1,
  })
  const badAvailable = (['bayes', 'edge', 'spread', 'stoikov', 'kelly', 'mc'] as const).filter((k) => badPayload.blocks[k].available)
  assert.ok(badAvailable.length < 4, `⚠ 反例（默认港股、不回退）必须让"至少四块"失败（实得 ${badAvailable.length}）`)
  assert.throws(() => assert.ok(badAvailable.length >= 4, '反例'), /反例/)
})

test('② 原因按市场分列：港股/指数/商品各说各的（写成"腾讯 5 分钟回空" ⇒ 必败）', async () => {
  const cases: Array<[string, string]> = [
    ['116.00700', '港股无分钟线源（需授权行情）'],
    ['116.00148', '港股无分钟线源（需授权行情）'],
    ['100.KOSPI200', '指数无分钟线'],
    ['101.CL00Y', '该品种无 5 分钟源'],
  ]
  for (const [secid, want] of cases) {
    const feed = await fetchFiveMinuteBars(secid)
    assert.equal(feed.bars.length, 0)
    assert.equal(feed.error, want, `${secid} 的原因必须是「${want}」（实得「${String(feed.error)}」）`)
    assert.notEqual(feed.error, '腾讯 5 分钟回空')
  }
  assert.equal(prismMarketOf('116.00148'), 'hk')
  assert.equal(prismMarketOf('1.600519'), 'a')
  // 美股：只有真失败时才说"美股分钟线取数失败"
  const usFail = await fetchSinaUsBars('105.TSLA', 5, { fetchText: async () => { throw new Error('boom') } })
  assert.match(String(usFail.error), /^美股分钟线取数失败/)
  // 反例注入：把港股原因写成旧文案 ⇒ 判据必须失败
  assert.throws(
    () => assert.equal('腾讯 5 分钟回空', '港股无分钟线源（需授权行情）', '反例'),
    /反例/,
    '⚠ 反例注入（笼统原因）必须让断言失败',
  )
})

test('③ A 无 bar ⇒ 自动回退到有源标的并继续算；payload 写实际标的（回退但不更新显示 ⇒ 必败）', async () => {
  const loader = async (secid: string): Promise<PrismFeed> =>
    secid === PRISM_FALLBACK_SECID
      ? feedOf(mkBars(200))
      : { bars: [], source: null, volUnit: null, error: '港股无分钟线源（需授权行情）' }
  const r = await prismResponse('pairA=116.00148&pairB=1.601118', { loadBars: loader, loadBook: async () => bookOf(100), now: () => 1 })
  assert.equal(r.body.params.pairA, PRISM_FALLBACK_SECID, 'A 无 bar ⇒ 回退到兜底 A股')
  assert.equal(r.body.fallback?.requested, '116.00148')
  assert.equal(r.body.fallback?.actual, PRISM_FALLBACK_SECID)
  assert.match(String(r.body.fallback?.reason), /回退/)
  assert.equal(r.body.blocks.bayes.available, true, '回退后必须继续算（不是六块全空）')
  // 反例注入：回退发生了但 params 仍写请求值 ⇒ "参数框显示实际标的"失败
  const notSynced = { ...r.body, params: { ...r.body.params, pairA: '116.00148' } }
  assert.notEqual(notSynced.params.pairA, notSynced.fallback?.actual)
  assert.throws(() => assert.equal(notSynced.params.pairA, notSynced.fallback?.actual, '反例'), /反例/)
})

test('④ 配对 B 无 bar：只影响 Spread（其余五块仍有值）；整页清空 ⇒ 必败', async () => {
  const loader = async (secid: string): Promise<PrismFeed> =>
    secid === '1.601118'
      ? { bars: [], source: null, volUnit: null, error: '沪深分钟线取数失败（测试）' }
      : feedOf(mkBars(200))
  const r = await prismResponse('pairA=1.600519&pairB=1.601118', { loadBars: loader, loadBook: async () => bookOf(100), now: () => 1 })
  assert.equal(r.body.blocks.spread.available, false, 'B 无 bar ⇒ Spread 不可算')
  assert.match(String(r.body.blocks.spread.reason), /配对 B/)
  for (const key of ['bayes', 'edge', 'stoikov', 'kelly', 'mc'] as const) {
    assert.equal(r.body.blocks[key].available, true, `${key} 不能因为配对 B 无 bar 而变空`)
  }
  // 反例注入：把 A 也当无 bar（整页清空）⇒ 五块不再有值
  const cleared = await prismResponse('pairA=1.600519&pairB=1.601118', {
    loadBars: async () => ({ bars: [], source: null, volUnit: null, error: 'x' }),
    loadBook: async () => bookOf(null),
    now: () => 1,
  })
  assert.ok((['bayes', 'edge', 'stoikov', 'kelly', 'mc'] as const).some((k) => !cleared.body.blocks[k].available), '⚠ 反例（整页清空）必须被抓到')
})

test('⑤ secid 解析：116.00148 与 116.00700 必须是不同标的（截断成同值 ⇒ 必败）', () => {
  assert.equal(hkQuoteSymbol('116.00148'), 'rt_hk00148')
  assert.equal(hkQuoteSymbol('116.00700'), 'rt_hk00700')
  assert.notEqual(hkQuoteSymbol('116.00148'), hkQuoteSymbol('116.00700'))
  assert.equal(prismMarketOf('116.00148'), prismMarketOf('116.00700'), '同属港股，但代码不同')
  // 默认解析也不许把两者混用
  assert.equal(resolvePairA('116.00148', []).secid, PRISM_FALLBACK_SECID)
  assert.equal(resolvePairA('116.00700', []).secid, PRISM_FALLBACK_SECID)
  // 反例注入：截断成同值（两者首字符都是 0 ⇒ 00000）⇒ 判据必须失败
  const broken = (secid: string): string => `rt_hk${(secid.split('.')[1] ?? '').slice(0, 1).padStart(5, '0')}`
  assert.equal(broken('116.00148'), broken('116.00700'))
  assert.throws(() => assert.notEqual(broken('116.00148'), broken('116.00700'), '反例'), /反例/, '⚠ 反例注入（截断成同值）必须让断言失败')
})
