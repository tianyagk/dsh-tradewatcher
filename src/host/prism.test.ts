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
  type PrismBook,
  type PrismParams,
} from '../shared/prism.ts'
import {
  aggregateBars,
  buildPrismPayload,
  emptyPrismPayload,
  freqNoteOf,
  mcBlock,
  parsePrismQuery,
  prismBucketOf,
  prismResponse,
  stoikovBlock,
} from './prism.ts'
import type { PrismBar, PrismFeed } from './prismFeed.ts'
import {
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
})

const paramsOf = (patch: Partial<PrismParams> = {}): PrismParams => ({ ...PRISM_DEFAULT_PARAMS, pairA: '1.600519', pairB: '0.000001', ...patch })

const payloadOf = (bars: PrismBar[], params: PrismParams = paramsOf()) =>
  buildPrismPayload({
    params,
    feedA: feedOf(bars),
    // 配对 B 用另一段序列（同一个 base/seed 会让价差恒 0 ⇒ σ=0，那是"不可算"的正确形态）
    feedB: feedOf(mkBars(bars.length, 50, 11)),
    bookA: bookOf(null),
    bookB: bookOf(null),
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
  // 缺 pairA ⇒ 200 + 原因（不 400）
  const r2 = await prismResponse('', {})
  assert.equal(r2.status, 200)
  assert.match(String(r2.body.missing[0]), /pairA/)
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
