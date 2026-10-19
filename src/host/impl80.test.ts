/**
 * 护盘「覆盖广度」（AUDIT-IMPL80）：**阶段一只记录 + 展示（附加分恒 0）** + **阶段二函数（默认关闭）**。
 *
 * 用户批准的规格（不得改口径）：
 *   ① 每条采样记录都算 coverage：触发 = 该通道**同刻度 z ≥ 2**（`sameSlotZ` 那套基线，不另造阈值）；
 *      族＝大盘(沪深300/上证50) / 中小盘(中证500/中证1000) / 成长(科创50/创业板)，族内任一触发即命中；
 *      `confirm1`＝沪深300 与宽基 ETF 的方向一致性（只用已有行情，零新增请求）；
 *      `confirm2`＝30 年国债 ETF 的反向读数（**只展示、永不进评分**；批次里没有 ⇒ null + 原因）。
 *   ② 阶段二：阶梯 1 族 0 / 2 族 3 / 3 族 6（且必须 M≥2 且 N≥3）+ confirm1（一致 2 / 强一致 4），
 *      合计上限 10，**加进 `raw`**（会改等级）；四因子权重合计 **0.717 不动、绝不重新归一化**；
 *      单一开关 `rescueCoverageEnabled`（默认 false）⇒ false 时附加分**恒 0**，字段照常落盘与展示。
 *
 * 每条用例都配了「反例注入」：把注入后的行为喂给**同一条判据**，判据必须抛错（证明它不是恒真）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RescueConfig } from '../shared/model.ts'

/**
 * ⚠ 必须在 import rescue.ts / em.ts / store.ts 的**动态导入之前**钉住 DSH_HOME：
 * 否则共享行情链会去读**真机**的 `~/.dsh/dsh-tradewatcher`（红线：不得读写用户的真实数据目录）。
 */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tw-impl80-home-'))

const RESCUE_SRC = readFileSync(new URL('./rescue.ts', import.meta.url), 'utf8')
const STORE_SRC = readFileSync(new URL('./store.ts', import.meta.url), 'utf8')

/** 判据"必须失败"的断言（反例注入的载体：注入后的行为喂给同一条判据必须抛错） */
function mustFail(run: () => void, why: string): void {
  assert.throws(run, undefined, why)
}

/** 取源码里某个声明到下一个顶层 `export` 之间的片段（静态扫描用） */
function bodyAfter(src: string, marker: string): string {
  const i = src.indexOf(marker)
  assert.ok(i >= 0, `源码里找不到 ${marker}`)
  const j = src.indexOf('\nexport ', i + marker.length)
  return src.slice(i, j < 0 ? undefined : j)
}

type Channel = {
  secid: string
  name: string
  index: string
  pct: number | null
  volumeZ: number | null
  scoring: boolean
}

/** 一条宽基通道（默认在评分池里） */
function ch(secid: string, name: string, index: string, volumeZ: number | null, pct: number | null, scoring = true): Channel {
  return { secid, name, index, pct, volumeZ, scoring }
}

const SIX = (z: number, pct: number | null): Channel[] => [
  ch('1.510300', '沪深300ETF华泰柏瑞', '沪深300', z, pct),
  ch('1.510050', '上证50ETF华夏', '上证50', z, pct),
  ch('1.510500', '中证500ETF南方', '中证500', z, pct),
  ch('1.512100', '中证1000ETF华夏', '中证1000', z, pct),
  ch('1.588000', '科创50ETF华夏', '科创50', z, pct),
  ch('0.159915', '创业板ETF易方达', '创业板指', z, pct),
]

/** 全组合（用于"恒 0 / 上限"这类必须穷举的判据） */
const CONFIRM1S = ['strong', 'same', 'mixed'] as const
function* allCases(): Generator<{ nEtf: number; nFamily: number; confirm1: (typeof CONFIRM1S)[number] }> {
  for (let nFamily = 0; nFamily <= 4; nFamily += 1) {
    for (let nEtf = 0; nEtf <= 8; nEtf += 1) {
      for (const confirm1 of CONFIRM1S) yield { nEtf, nFamily, confirm1 }
    }
  }
}

// ── ① 开关 false ⇒ 附加分恒 0 ───────────────────────────────────────────

/** 判据：开关 false 时，**任何**输入都必须得到 0（穷举全组合） */
function assertZeroWhenDisabled(bonus: (c: { nEtf: number; nFamily: number; confirm1: (typeof CONFIRM1S)[number] }, on: boolean) => number): void {
  for (const c of allCases()) {
    assert.equal(bonus(c, false), 0, `开关 false ⇒ 附加分必须恒 0（输入 ${JSON.stringify(c)}）`)
  }
}

test('① 开关 false ⇒ 附加分恒 0（穷举）；注入「false 也加分」必须让判据失败', async () => {
  const { rescueCoverageBonusOf } = await import('./rescue.ts')
  assertZeroWhenDisabled(rescueCoverageBonusOf)
  // 正向：开关 true 时同一份输入确实加满（证明上面那条不是"函数只会返回 0"）
  assert.equal(rescueCoverageBonusOf({ nEtf: 6, nFamily: 3, confirm1: 'strong' }, true), 10)
  // 注入：一个"忘了看开关"的实现（等价于阶段一被悄悄打开）
  const mutant = (c: { nEtf: number; nFamily: number; confirm1: (typeof CONFIRM1S)[number] }, _on: boolean): number =>
    rescueCoverageBonusOf(c, true)
  assert.equal(mutant({ nEtf: 6, nFamily: 3, confirm1: 'strong' }, false), 10, '前置：注入确实改了行为（false 也加分）')
  mustFail(() => assertZeroWhenDisabled(mutant), '⚠ 反例（开关 false 也加分）必须让判据失败')
})

// ── ② 权重合计 0.717、四因子逐项未变（严禁归一化） ─────────────────────────

const HIST_WEIGHTS = { volume: 0.239, pulse: 0.196, persistence: 0.13, divergence: 0.152 } as const

/** 判据：四因子权重**逐项**等于历史值，且合计恰好 0.717（归一化后的表必不满足） */
function assertWeightTable(table: Record<string, number>): void {
  assert.deepEqual(Object.keys(table).sort(), ['divergence', 'persistence', 'pulse', 'volume'], '因子集合必须是这四项')
  for (const [k, v] of Object.entries(HIST_WEIGHTS)) {
    assert.equal(table[k], v, `${k} 的权重必须保持 ${v}（实际 ${table[k]}）`)
  }
  const sum = Object.values(table).reduce((a, b) => a + b, 0)
  assert.equal(Math.round(sum * 1000) / 1000, 0.717, `四项合计必须 = 0.717（实际 ${sum}）`)
}

test('② 四因子权重合计仍 0.717、逐项未变；覆盖广度只做**加法**（注入：归一化 ⇒ 必败）', async () => {
  const { RESCUE_WEIGHTS, scoreRescue } = await import('./rescue.ts')
  assertWeightTable(RESCUE_WEIGHTS)
  // 出分路径上的因子权重必须与表同源（打开覆盖广度也一样）
  const scored = scoreRescue({
    timeAdjMult: 2.2, volumeZ: 2.6, volumeZDays: 30,
    coreSuperVsAvg: 0.6, peripheralSuperVsAvg: null, pulseMult: 2.2, persistShare: 0.2, retraceRatio: 0.2,
    indexPct: -1.2, resonance: 3, coreResonance: 1, peripheralResonance: 2,
    f2Anchors: [0.5, 1, 2] as [number, number, number], f2Source: 'calibrated', f1Anchors: undefined,
    timeCoef: 1, coverageEnabled: true,
    coverage: { nEtf: 6, nEtfWithData: 6, nFamily: 3, families: ['大盘', '中小盘', '成长'], confirm1: 'strong', confirm1N: 6, confirm2: null },
  } as never)
  assertWeightTable(Object.fromEntries(scored.factors.map((f) => [f.id, f.weight])) as Record<string, number>)
  assert.equal(scored.coverageBonus, 10, '前置：阶段二同输入应加 10 分')
  // 附加分是"相加"：raw = Σ w·f + bonus（不是乘、不是重新分配权重）
  const rawFactors = scored.factors.reduce((a, f) => a + f.weight * f.score, 0)
  assert.equal(Math.round((rawFactors + 10) * 100) / 100, Math.round((scored.rawScore as number) * 100) / 100, 'raw 必须 = Σ w·f + 附加分')
  // 源码级：权重表里不得出现除法（归一化的形状），raw 必须是 `rawFactors + coverageBonus`
  const start = RESCUE_SRC.indexOf('export const RESCUE_WEIGHTS = {')
  const table = RESCUE_SRC.slice(start, RESCUE_SRC.indexOf('} as const', start) + '} as const'.length)
  assert.ok(table.includes('volume: 0.239'), '前置：切片确实落在权重表上')
  assert.equal(table.includes('/'), false, '权重表里不许出现除法（那就是归一化）')
  assert.ok(RESCUE_SRC.includes('const raw = rawFactors + coverageBonus'), '覆盖广度附加分只能**相加**进 raw')
  // 注入：把四项归一化 ⇒ 同一判据必须失败
  const normalized = Object.fromEntries(Object.entries(HIST_WEIGHTS).map(([k, v]) => [k, v / 0.717]))
  mustFail(() => assertWeightTable(normalized), '⚠ 反例（归一化）必须让判据失败')
})

// ── ③ 阶梯与门槛 ──────────────────────────────────────────────────────

test('③ 阶梯与门槛：M=1⇒0；M=2,N=5⇒3；M=3,N=3⇒6；M=2,N=2⇒0（注入：阶梯错一档 ⇒ 必败）', async () => {
  const { rescueCoverageBonusOf } = await import('./rescue.ts')
  assert.equal(rescueCoverageBonusOf({ nEtf: 6, nFamily: 1, confirm1: 'strong' }, true), 0, 'M=1 ⇒ 0（单族不算覆盖广度）')
  assert.equal(rescueCoverageBonusOf({ nEtf: 5, nFamily: 2, confirm1: 'mixed' }, true), 3, 'M=2,N=5 ⇒ 3')
  assert.equal(rescueCoverageBonusOf({ nEtf: 3, nFamily: 3, confirm1: 'mixed' }, true), 6, 'M=3,N=3 ⇒ 6')
  assert.equal(rescueCoverageBonusOf({ nEtf: 2, nFamily: 2, confirm1: 'strong' }, true), 0, 'M=2,N=2 ⇒ 0（N≥3 是硬门槛）')
  assert.equal(rescueCoverageBonusOf({ nEtf: 3, nFamily: 2, confirm1: 'same' }, true), 5, 'M=2,N=3 + 一致 ⇒ 3+2')
  // 注入：把"2 族"错写成 6 分（阶梯错一档）
  const mutant = (c: { nEtf: number; nFamily: number; confirm1: (typeof CONFIRM1S)[number] }): number =>
    c.nEtf < 3 || c.nFamily < 2 ? 0 : (c.nFamily >= 2 ? 6 : 0) + ({ strong: 4, same: 2, mixed: 0 }[c.confirm1] ?? 0)
  assert.equal(mutant({ nEtf: 5, nFamily: 2, confirm1: 'mixed' }), 6, '前置：注入确实把 2 族算成 6 分')
  mustFail(
    () => assert.equal(mutant({ nEtf: 5, nFamily: 2, confirm1: 'mixed' }), rescueCoverageBonusOf({ nEtf: 5, nFamily: 2, confirm1: 'mixed' }, true), 'M=2 必须与真实现一致'),
    '⚠ 反例（阶梯错一档）必须让判据失败',
  )
})

// ── ④ confirm1 档位 + confirm2 永不加分 ─────────────────────────────────

test('④ confirm1：一致 2 / 强一致 4；confirm2 永不加分（注入：② 加分 ⇒ 必败）', async () => {
  const { rescueCoverageBonusOf, scoreRescue } = await import('./rescue.ts')
  const base = { nEtf: 6, nFamily: 2 } as const
  assert.equal(rescueCoverageBonusOf({ ...base, confirm1: 'mixed' }, true), 3, '不一致 ⇒ 只拿阶梯 3')
  assert.equal(rescueCoverageBonusOf({ ...base, confirm1: 'same' }, true), 5, '一致 ⇒ 3+2')
  assert.equal(rescueCoverageBonusOf({ ...base, confirm1: 'strong' }, true), 7, '强一致 ⇒ 3+4')

  /**
   * 判据：只有**展示字段**不同（`confirm2` / `confirm1N` / `nEtfWithData` / `families`），
   * 三个评分字段与场景完全相同 ⇒ 附加分、连续评分与 raw 必须**一模一样**。
   * 这样"② 进评分""把 confirm1N 加进 raw"这类注入一定被抓到。
   */
  const baseInput = {
    timeAdjMult: 1.9, volumeZ: 2.6, volumeZDays: 30,
    coreSuperVsAvg: 0.6, peripheralSuperVsAvg: null, pulseMult: 2.1, persistShare: 0.2, retraceRatio: 0.2,
    indexPct: -1.1, resonance: 3, coreResonance: 1, peripheralResonance: 2,
    f2Anchors: [0.5, 1, 2] as [number, number, number], f2Source: 'calibrated', timeCoef: 1, coverageEnabled: true,
  }
  const cov = (over: Partial<{
    nEtf: number; nEtfWithData: number; nFamily: number; families: string[]
    confirm1: 'strong' | 'same' | 'mixed'; confirm1N: number; confirm2: number | null
  }> = {}) => ({
    nEtf: 6, nEtfWithData: 6, nFamily: 3, families: ['大盘', '中小盘', '成长'],
    confirm1: 'strong' as const, confirm1N: 6, confirm2: null as number | null, ...over,
  })
  const scoreWith = (coverage: ReturnType<typeof cov>) => scoreRescue({ ...baseInput, coverage } as never)
  const a = scoreWith(cov({ confirm2: 5 }))
  const b = scoreWith(cov({ confirm2: -9.5 }))
  const c = scoreWith(cov({ confirm2: null }))
  assert.equal(a.coverageBonus, b.coverageBonus, 'confirm2 不得影响附加分（①正 vs ②负）')
  assert.equal(a.coverageBonus, c.coverageBonus, 'confirm2 不得影响附加分（②缺失）')
  assert.equal(a.rawScore, b.rawScore, 'confirm2 不得进入 raw')
  assert.equal(a.rawScore, c.rawScore, 'confirm2 缺失也不得改变 raw')
  // 展示字段整体不进评分：confirm1N / nEtfWithData / families 全换掉，raw 必须不变
  const d1 = scoreWith(cov({ confirm1N: 6, nEtfWithData: 6, families: ['大盘', '中小盘', '成长'] }))
  const d2 = scoreWith(cov({ confirm1N: 1, nEtfWithData: 2, families: ['大盘'] }))
  assert.equal(d1.coverageBonus, d2.coverageBonus, '展示字段不得影响附加分')
  assert.equal(d1.rawScore, d2.rawScore, '展示字段不得进入 raw')
  assert.equal(d1.continuous, d2.continuous, '展示字段不得影响连续评分')
  // 注入 A：把 |confirm2| 加进附加分 ⇒ 判据必须失败
  const mutantBonus = (confirm2: number | null): number => rescueCoverageBonusOf({ nEtf: 6, nFamily: 3, confirm1: 'strong' }, true) + Math.abs(confirm2 ?? 0)
  assert.notEqual(mutantBonus(5), c.coverageBonus, '前置：注入确实改了附加分')
  mustFail(() => assert.equal(mutantBonus(5), mutantBonus(-9.5), 'confirm2 不得影响附加分'), '⚠ 反例（② 加分）必须让判据失败')
  // 注入 B：把 confirm1N（展示字段）混进附加分 ⇒ 判据必须失败
  const mutantRaw = (x: ReturnType<typeof cov>): number => rescueCoverageBonusOf(x, true) + x.confirm1N
  assert.notEqual(mutantRaw(cov({ confirm1N: 6 })), mutantRaw(cov({ confirm1N: 1 })), '前置：注入确实把 confirm1N 混进了分数')
  mustFail(
    () => assert.equal(mutantRaw(cov({ confirm1N: 6 })), mutantRaw(cov({ confirm1N: 1 })), '展示字段不得进入 raw'),
    '⚠ 反例（confirm1N 进 raw）必须让判据失败',
  )
})

// ── ⑤ 合计上限 10 ────────────────────────────────────────────────────

test('⑤ 合计上限 10：M=3 + 强一致 ⇒ 10（穷举全组合最大值也是 10，不得 11）', async () => {
  const { rescueCoverageBonusOf, RESCUE_COVERAGE_BONUS_MAX } = await import('./rescue.ts')
  assert.equal(RESCUE_COVERAGE_BONUS_MAX, 10)
  assert.equal(rescueCoverageBonusOf({ nEtf: 6, nFamily: 3, confirm1: 'strong' }, true), 10, 'M=3 + 强一致 = 6 + 4 = 10')
  let max = 0
  for (const c of allCases()) max = Math.max(max, rescueCoverageBonusOf(c, true))
  assert.equal(max, 10, `穷举最大附加分必须 = 10（实际 ${max}）`)
  // 注入：不给上限（额外把 confirm2 那 2 分也算进来）⇒ 12 > 10 ⇒ 同一判据失败
  const mutant = (): number => rescueCoverageBonusOf({ nEtf: 6, nFamily: 3, confirm1: 'strong' }, true) + 2
  mustFail(() => assert.ok(mutant() <= RESCUE_COVERAGE_BONUS_MAX, '附加分必须 ≤ 10'), '⚠ 反例（超上限）必须让判据失败')
})

// ── ⑥ 不新增上游请求 ──────────────────────────────────────────────────

/** 判据：覆盖广度构造器是**纯函数**（无 fetch / await / http），且采样路径只用本拍已有数据 */
function assertNoUpstreamInCoverage(src: string): void {
  const body = bodyAfter(src, 'export function buildRescueCoverage(')
  for (const banned of ['fetch(', 'await ', 'http://', 'https://', 'XMLHttpRequest']) {
    assert.equal(body.includes(banned), false, `覆盖广度构造器里不许出现 ${banned}（它只能用本拍已有数据）`)
  }
  assert.ok(src.includes('const coverageBuilt = buildRescueCoverage({'), '采样路径必须调用它')
  assert.ok(src.includes('channels: etfs.map((e) => ({'), '输入必须来自本拍 etfs（同一批行情）')
  assert.ok(src.includes('scoring: scoring.has(e.secid)'), '自定义通道必须被排除在族/触发计数之外')
}

test('⑥ 不新增上游请求：构造器是纯函数、输入来自本拍行情；注入「为 coverage 发一次 fetch」⇒ 必败', async () => {
  const { buildRescueCoverage } = await import('./rescue.ts')
  assertNoUpstreamInCoverage(RESCUE_SRC)
  // 运行时：它是同步纯函数（返回对象而不是 Promise），并且同输入同输出
  const built = buildRescueCoverage({ indexPct: -1.1, channels: SIX(2.5, -1.4) })
  assert.equal(built instanceof Promise, false, '覆盖广度构造器必须是同步纯函数（异步就意味着可能在取数）')
  assert.deepEqual(buildRescueCoverage({ indexPct: -1.1, channels: SIX(2.5, -1.4) }).coverage, built.coverage, '同输入同输出')
  // 注入：给构造器加一行 fetch
  const doctored = RESCUE_SRC.replace(
    'export function buildRescueCoverage(input: RescueCoverageBuildInput): RescueCoverageBuildResult {',
    'export function buildRescueCoverage(input: RescueCoverageBuildInput): RescueCoverageBuildResult {\n  void fetch("https://example.com/511090")',
  )
  assert.notEqual(doctored, RESCUE_SRC, '前置：注入真的插进去了')
  mustFail(() => assertNoUpstreamInCoverage(doctored), '⚠ 反例（为 coverage 发 fetch）必须让判据失败')
})

// ── ⑦ 族归类逐通道正确 ────────────────────────────────────────────────

test('⑦ 族归类逐通道正确（注入：把科创50 划进大盘 ⇒ 必败）', async () => {
  const { RESCUE_COVERAGE_FAMILY_OF_INDEX, RESCUE_COVERAGE_FAMILY_LABEL } = await import('../shared/model.ts')
  const { buildRescueCoverage } = await import('./rescue.ts')
  const expect: Array<[string, string]> = [
    ['沪深300', '大盘'], ['上证50', '大盘'],
    ['中证500', '中小盘'], ['中证1000', '中小盘'],
    ['科创50', '成长'], ['创业板指', '成长'],
  ]
  for (const [index, label] of expect) {
    const family = RESCUE_COVERAGE_FAMILY_OF_INDEX[index]
    assert.ok(family !== undefined, `${index} 必须在三族映射里（漏了会让它凭空不进任何族）`)
    assert.equal(RESCUE_COVERAGE_FAMILY_LABEL[family], label, `${index} 必须归入「${label}」`)
  }
  // 只有科创50 触发 ⇒ 只命中「成长」一族（不得算进大盘）
  const growthOnly = buildRescueCoverage({
    indexPct: -1.0,
    channels: [
      ch('1.510300', '沪深300ETF', '沪深300', 0.5, -1.0),
      ch('1.588000', '科创50ETF', '科创50', 2.5, -1.2),
    ],
  }).coverage
  assert.deepEqual(growthOnly.families, ['成长'], `科创50 只能命中成长（实得 ${JSON.stringify(growthOnly.families)}）`)
  assert.equal(growthOnly.nFamily, 1)
  assert.equal(growthOnly.nEtf, 1)
  // 大盘 + 中小盘 触发、成长不触发 ⇒ 两族
  const two = buildRescueCoverage({
    indexPct: -1.0,
    channels: [
      ch('1.510300', '沪深300ETF', '沪深300', 2.5, -1.0),
      ch('1.510500', '中证500ETF', '中证500', 2.1, -1.1),
      ch('1.588000', '科创50ETF', '科创50', 1.0, -1.2),
    ],
  }).coverage
  assert.deepEqual(two.families, ['大盘', '中小盘'], '族名必须按固定顺序，且不包含未触发的成长')
  // 注入：把科创50 划进大盘 ⇒ 上面那条判据必须失败
  const mutantMap: Record<string, string> = { ...RESCUE_COVERAGE_FAMILY_OF_INDEX, 科创50: 'large' }
  mustFail(() => assert.equal(RESCUE_COVERAGE_FAMILY_LABEL[mutantMap['科创50'] as 'large'], '成长', '科创50 必须归成长'), '⚠ 反例（科创50→大盘）必须让判据失败')
})

// ── confirm2：30 年国债 ETF 反向读数（只展示） ──────────────────────────

test('⑧ confirm2：批次含 30 年国债 ETF ⇒ 反向读数；不含 ⇒ null + 原因（注入：缺数据写 0 ⇒ 必败）', async () => {
  const { buildRescueCoverage } = await import('./rescue.ts')
  const bond = (pct: number | null, name = '30年国债ETF鹏扬', secid = '1.511090', scoring = false): Channel =>
    ch(secid, name, '自定义', null, pct, scoring)
  // ① 批次里有（自定义通道）⇒ 反向读数 = −涨跌幅（债涨 ⇒ 负数）
  const withBond = buildRescueCoverage({ indexPct: -1.0, channels: [...SIX(0.4, -1.0), bond(-1.26)] })
  assert.equal(withBond.coverage.confirm2, 1.26, '债跌 1.26% ⇒ 反向读数 +1.26（风偏回升）')
  assert.deepEqual(withBond.why, [], '拿到了就不该有缺失原因')
  const bondUp = buildRescueCoverage({ indexPct: -1.0, channels: [...SIX(0.4, -1.0), bond(0.8)] })
  assert.equal(bondUp.coverage.confirm2, -0.8, '债涨 0.8% ⇒ 反向读数 −0.8（避险）')
  // 名称兜底（secid 不同、名字含「30年国债」也算）
  assert.equal(buildRescueCoverage({ indexPct: null, channels: [bond(-0.5, '30年国债ETF博时', '1.511999')] }).coverage.confirm2, 0.5)
  // ② 批次里没有 ⇒ **null** + 原因（不写 0、也不为它单独取数）
  const noBond = buildRescueCoverage({ indexPct: -1.0, channels: SIX(0.4, -1.0) })
  assert.equal(noBond.coverage.confirm2, null, '未取到必须是 null（0 会被读成"债不动"）')
  assert.ok(noBond.why.some((w) => w.includes('30 年国债')), `必须给出未取到的原因：${noBond.why.join('｜')}`)
  // ③ 在批次里但涨跌幅缺失 ⇒ 仍然是 null + 原因
  const bondNoPct = buildRescueCoverage({ indexPct: -1.0, channels: [...SIX(0.4, -1.0), bond(null)] })
  assert.equal(bondNoPct.coverage.confirm2, null)
  assert.ok(bondNoPct.why.some((w) => w.includes('没有涨跌幅读数')), '缺涨跌幅也要给原因')
  // 注入：缺数据写 0 ⇒ 同一条判据必须失败
  const mutant = (c: { confirm2: number | null }) => c.confirm2 ?? 0
  mustFail(() => assert.equal(mutant(noBond.coverage), null, '缺数据必须是 null'), '⚠ 反例（缺数据写 0）必须让判据失败')
})

// ── confirm1 三档（数据缺失 ⇒ mixed + 原因） ─────────────────────────────

test('⑨ confirm1：全同向 ⇒ strong；多数同向 ⇒ same；背离/缺失 ⇒ mixed（+原因）', async () => {
  const { buildRescueCoverage } = await import('./rescue.ts')
  const states = (channels: Channel[], indexPct: number | null) => buildRescueCoverage({ indexPct, channels })
  // 6/6 同向（指数跌、ETF 全跌）
  assert.equal(states(SIX(0.4, -1.2), -1.0).coverage.confirm1, 'strong')
  // 5 同向 1 反向 ⇒ 一致（不是强一致）
  const fiveUp = SIX(0.4, -1.2).map((c, i) => (i === 5 ? { ...c, pct: 0.3 } : c))
  const five = states(fiveUp, -0.8)
  assert.equal(five.coverage.confirm1, 'same', '5/6 同向 ⇒ same')
  assert.equal(five.coverage.confirm1N, 5, '同向数必须如实给 5')
  // 3 同向 3 反向 ⇒ 不一致
  const split = SIX(0.4, -1.2).map((c, i) => (i < 3 ? c : { ...c, pct: 0.5 }))
  assert.equal(states(split, -0.8).coverage.confirm1, 'mixed', '3:3 平分 ⇒ mixed')
  // 指数读数缺失 ⇒ mixed + 原因（0 分，绝不抬高）
  const noIndex = states(SIX(0.4, -1.2), null)
  assert.equal(noIndex.coverage.confirm1, 'mixed')
  assert.ok(noIndex.why.some((w) => w.includes('沪深300 涨跌幅未取到')), `缺指数读数要给原因：${noIndex.why.join('｜')}`)
  // 指数 0.00%（无方向）⇒ mixed + 原因
  const flatIndex = states(SIX(0.4, 0), 0)
  assert.equal(flatIndex.coverage.confirm1, 'mixed')
  assert.ok(flatIndex.why.some((w) => w.includes('0.00%')), '无方向要给原因')
})

// ── ⑩ 采样路径端到端：落盘 + 快照 + 开关状态 + 附加分恒 0 ─────────────────

const NOW = Date.parse('2026-10-16T14:00:00+08:00')
const ETFS = [
  ['1.510300', '510300', '沪深300ETF', 3.9],
  ['1.510050', '510050', '上证50ETF', 2.85],
  ['1.510500', '510500', '中证500ETF', 6.1],
  ['1.512100', '512100', '中证1000ETF', 2.4],
  ['1.588000', '588000', '科创50ETF', 1.05],
  ['0.159915', '159915', '创业板ETF', 2.2],
] as const

/** 带同刻度基线（σ=0.02、126 天）的标定 ⇒ 六通道 z 都能算出来（本拍 z 会被夹到 5） */
function seededLog(): string {
  const curve = new Array(49).fill(0).map((_, i) => Math.min(1, i / 48))
  // σ 必须**大于** μ 的 5%（`sameSlotZ` 的"σ 过小"守卫）：μ = 0.75 ⇒ 门槛 0.0375，取 0.2 才不会被判成"分不出高低"
  const sd = new Array(49).fill(0.2)
  const baselines: Record<string, { avgAmt20: number; day: string; source: string }> = {}
  for (const [secid] of ETFS) baselines[secid] = { avgAmt20: 1e8, day: '2026-10-15', source: 'em' }
  return JSON.stringify({
    v: 1, days: {}, lastSnapshot: null, baselines, selfSamples: {},
    progressCurve: curve, progressSd: sd, progressDays: 126, updatedAt: 0,
  })
}

/** 打桩上游：只回答一次采样真正需要的三类请求，并记录全部 URL */
function stub(withBond: boolean): { calls: string[]; restore: () => void } {
  const calls: string[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    const url = String(typeof input === 'string' ? input : (input as { url?: string })?.url ?? '')
    calls.push(url)
    const json = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response
    if (url.includes('ulist.np/get')) {
      const diff: Array<Record<string, unknown>> = [
        { f12: '000300', f13: 1, f14: '沪深300', f2: 3900, f3: -1.2, f6: 4.2e11, f62: -1e9, f66: -5e8 },
        ...ETFS.map(([secid, code, name, px], i) => ({
          f12: code, f13: Number(secid.split('.')[0]), f14: name, f2: px, f3: -1.5, f6: 5e8, f8: 1.2, f10: 1.1,
          f62: 2e7 + i * 1e6, f66: 1e7 + i * 5e5, f15: px + 0.02, f16: px - 0.03, f17: px - 0.01, f18: px + 0.05, f124: 1,
        })),
        // 自定义通道：30 年国债 ETF（只有 withBond 时才在行情批次里）
        ...(withBond
          ? [{ f12: '511090', f13: 1, f14: '30年国债ETF鹏扬', f2: 118.2, f3: -1.26, f6: 2e7, f8: 1.0, f10: 1.0, f62: 0, f66: 0, f15: 118, f16: 118.3, f17: 117.9, f18: 118.4, f124: 1 }]
          : []),
      ]
      return json({ rc: 0, data: { diff } })
    }
    if (url.includes('appstock/app/minute/query')) {
      const code = /code=([a-z]{2}\d{6})/.exec(url)?.[1] ?? 'sh510300'
      const rows = ['0930 3.9 1000 1000000', '0931 3.9 2000 3000000', '1400 3.9 200000 500000000']
      return json({ code: 0, msg: '', data: { [code]: { data: { data: rows } } } })
    }
    // 通道既有管线（分时/资金流/日线）：给空结果即可 —— 别让它们 503（会把熔断器点亮，影响后续用例）
    if (url.includes('stock/trends2/get')) return json({ rc: 0, data: { trends: [] } })
    if (url.includes('fflow/kline/get')) return json({ rc: 0, data: { klines: [] } })
    if (url.includes('appstock/app/fqkline/get')) return json({ code: 0, data: {} })
    if (url.includes('kline/get')) return json({ rc: 0, data: { klines: [] } })
    return { ok: false, status: 503, json: async () => ({}), text: async () => 'down' } as unknown as Response
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = real } }
}

async function resetBreakers(): Promise<void> {
  const { breakerFor } = await import('./breaker.ts')
  for (const host of [
    'push2delay.eastmoney.com', 'push2.eastmoney.com', 'push2his.eastmoney.com', 'qt.gtimg.cn',
    'web.ifzq.gtimg.cn', 'quotes.sina.cn', 'hq.sinajs.cn', 'finance.sina.com.cn', 'data-api.ecb.europa.eu',
  ]) breakerFor(host).recordSuccess()
}

interface SampleRun {
  snap: Awaited<ReturnType<import('./rescue.ts').RescueMonitor['sampleNow']>>
  monitor: InstanceType<typeof import('./rescue.ts').RescueMonitor>
  dir: string
  calls: string[]
}

async function sampleOnce(opts: { coverageEnabled: boolean; withBond?: boolean }): Promise<SampleRun> {
  const dir = mkdtempSync(join(tmpdir(), 'tw-impl80-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'rescue-log.json'), seededLog())
  const realNow = Date.now
  Date.now = () => NOW
  await resetBreakers()
  const s = stub(opts.withBond === true)
  try {
    const { RescueMonitor } = await import('./rescue.ts')
    const config: RescueConfig = {
      enabled: true, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [],
      ...(opts.withBond === true ? { custom: [{ secid: '1.511090', name: '30年国债ETF鹏扬', index: '国债' }] } : {}),
      rescueCoverageEnabled: opts.coverageEnabled,
    }
    const mon = new RescueMonitor(dir, config)
    await mon.init()
    const snap = await mon.sampleNow()
    return { snap, monitor: mon, dir, calls: s.calls }
  } finally {
    Date.now = realNow
    s.restore()
  }
}

test('⑩ 采样路径：coverage 进快照/事件/出分日志；开关 false ⇒ 附加分 0，true ⇒ 加 10 进 raw（因子权重不变）', async () => {
  const off = await sampleOnce({ coverageEnabled: false })
  const cov = off.snap.coverage
  assert.ok(cov !== null && cov !== undefined, '快照必须带 coverage（阶段一：只记录 + 展示）')
  assert.deepEqual(
    Object.keys(cov as object).sort(),
    ['confirm1', 'confirm1N', 'confirm2', 'families', 'nEtf', 'nEtfWithData', 'nFamily'],
    'coverage 的字段集合就是与客户端对齐的那 7 个（不得多也不得少）',
  )
  assert.equal(off.snap.coverageEnabled, false, '开关状态必须能被快照带出')
  assert.equal(cov?.nEtf, 6, '六通道 z 都被夹到 5 ⇒ 全部触发')
  assert.equal(cov?.nEtfWithData, 6, '有读数的通道数 = 6（分母）')
  assert.equal(cov?.nFamily, 3, '三族全部命中')
  assert.deepEqual(cov?.families, ['大盘', '中小盘', '成长'], '族名按固定顺序')
  assert.equal(cov?.confirm1, 'strong', '指数与六只 ETF 全部同向（跌）⇒ 强一致')
  assert.equal(cov?.confirm2, null, '默认池没有 30 年国债 ETF ⇒ null（不写 0）')
  assert.ok((off.snap.coverageWhy ?? []).some((w) => w.includes('30 年国债')), '未取到必须给原因')
  // 事件也带 coverage（跨日回看读的是它）
  const ev = off.snap.today.find((e) => e.level >= 1)
  assert.ok(ev !== undefined, '前置：这一次采样要出等级（否则事件断言是空跑）')
  assert.deepEqual(ev.coverage, cov, '事件里的 coverage 必须与本拍快照一致')

  // 出分日志：每条记录都带 coverage / coverageWhy / coverageBonus（与日志同寿命）
  const day = (await import('./time.ts')).dayOf(NOW)
  const log = off.monitor.scoreLogOf(day) as Array<Record<string, unknown>>
  assert.ok(log.length > 0, '前置：必须有出分日志')
  for (const entry of log) {
    assert.ok('coverage' in entry, '每条出分记录都必须有 coverage（阶段一：照常落盘）')
    assert.ok('coverageWhy' in entry, '缺失原因也要落盘')
    assert.equal(entry.coverageBonus, 0, '开关 false ⇒ 附加分恒 0（落盘读数）')
  }
  // 覆盖广度不另设保留规则：它就在 scoreLog 里（跟着 60 天/240 条裁剪走）
  const logBlocks = bodyAfter(RESCUE_SRC, 'interface DayLog {') + bodyAfter(RESCUE_SRC, 'interface LogFile {')
  assert.equal(logBlocks.includes('coverage'), false, 'DayLog/LogFile 不得新增 coverage 存储（必须挂在 scoreLog 记录上，与日志同寿命）')

  // 开关打开：同一份行情 ⇒ 附加分 10（6+4），raw 恰好 +10，因子权重与因子分完全不变
  const on = await sampleOnce({ coverageEnabled: true })
  assert.equal(on.snap.coverageEnabled, true)
  assert.deepEqual(on.snap.coverage, cov, '开关只影响加分，不影响读数')
  const onLog = on.monitor.scoreLogOf(day) as Array<{ coverageBonus: number; rawScore: number; factors: Array<{ id: string; weight: number; score: number }> }>
  const offLog = log as unknown as typeof onLog
  assert.equal(onLog[0].coverageBonus, 10, '阶段二：M=3 + 强一致 = 6 + 4 = 10')
  assert.equal(offLog[0].coverageBonus, 0, '阶段一：恒 0')
  assert.equal(
    Math.round(((onLog[0].rawScore as number) - (offLog[0].rawScore as number)) * 100) / 100,
    10,
    '附加分必须原样加进 raw（差值恰好 10）',
  )
  assert.deepEqual(onLog[0].factors.map((f) => [f.id, f.weight, f.score]), offLog[0].factors.map((f) => [f.id, f.weight, f.score]), '四因子的权重与因子分不得因开关而变（严禁重新归一化）')
  const onWeights = onLog[0].factors.reduce((a, f) => a + f.weight, 0)
  assert.equal(Math.round(onWeights * 1000) / 1000, 0.717, `因子权重合计仍必须是 0.717（实际 ${onWeights}）`)

  // 批次里有 30 年国债 ETF（自定义通道）⇒ confirm2 有值；且**不为它单独发请求**
  const bondRun = await sampleOnce({ coverageEnabled: false, withBond: true })
  assert.equal(bondRun.snap.coverage?.confirm2, 1.26, '债跌 1.26% ⇒ 反向读数 +1.26')
  assert.deepEqual(bondRun.snap.coverage?.families, ['大盘', '中小盘', '成长'], '自定义通道不得混进族归类')
  assert.equal(bondRun.snap.coverage?.nEtfWithData, 6, '自定义通道不得进入触发分母')
  // 「零新增请求」的运行时证据（一）：**通道池里没有它时，一次采样里没有任何指向它的请求**
  const offBondUrls = off.calls.filter((u) => /511090|511130/.test(u))
  assert.deepEqual(offBondUrls, [], `30 年国债 ETF 不在通道池时绝不请求它（coverage 不会偷偷取数）：${JSON.stringify(offBondUrls)}`)
  // 「零新增请求」的运行时证据（二）：它在池里时（用户配成自定义通道），请求**全部来自既有通道管线**
  // （行情批量 / 分时 / 资金流 / 日线），没有任何 coverage 专用端点
  const bondUrls = bondRun.calls.filter((u) => /511090/.test(u))
  assert.ok(bondUrls.length > 0, '前置：自定义通道本身有既有取数（否则这条断言是空跑）')
  const foreign = bondUrls.filter((u) => !/ulist\.np\/get|trends2\/get|fflow\/kline\/get|kline\/get|appstock\/app\/minute\/query|fqkline\/get/.test(u))
  assert.deepEqual(foreign, [], `国债通道的请求必须全部来自既有管线（不许有 coverage 专用路径）：${JSON.stringify(foreign)}`)
})

// ── ⑪ prefs：rescueInboxRead 白名单 + 宽容归一 + 上界 ────────────────────

async function prefsHarness(): Promise<{
  call: (url: string, init?: { method?: string; body?: string }) => Promise<{ code: number; body: Record<string, unknown> }>
  store: InstanceType<typeof import('./store.ts').DataStore>
  monitor: InstanceType<typeof import('./rescue.ts').RescueMonitor>
  close: () => void
}> {
  const { DataStore } = await import('./store.ts')
  const { CalendarStore } = await import('./calendar.ts')
  const { RescueMonitor } = await import('./rescue.ts')
  const { makeTradeRoutes } = await import('./routes.ts')
  const dir = mkdtempSync(join(tmpdir(), 'tw-impl80-prefs-'))
  const store = new DataStore(dir)
  await store.init()
  const monitor = new RescueMonitor(dir, { enabled: false, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [] })
  const routes = makeTradeRoutes(store, [], new CalendarStore(dir), monitor).routes
  const find = (path: string) => {
    const route = routes.find((r) => r.path === path)
    assert.ok(route !== undefined, `未找到路由 ${path}`)
    return route as unknown as { handler: (req: IncomingMessage, res: ServerResponse) => void }
  }
  const call = (url: string, init: { method?: string; body?: string } = {}) =>
    new Promise<{ code: number; body: Record<string, unknown> }>((resolve) => {
      const body = init.body
      const req = {
        url,
        method: init.method ?? 'GET',
        headers: { host: '127.0.0.1:3080', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        async *[Symbol.asyncIterator]() {
          if (body !== undefined) yield Buffer.from(body)
        },
      } as unknown as IncomingMessage
      let code = 0
      const res = {
        writeHead(c: number) { code = c },
        end(payload: string) { resolve({ code, body: payload === '' ? {} : (JSON.parse(payload) as Record<string, unknown>) }) },
      } as unknown as ServerResponse
      find('/tradewatcher/prefs').handler(req, res)
    })
  return { call, store, monitor, close: () => undefined }
}

test('⑪ prefs：rescueInboxRead 写入后 GET /prefs 原样读回；非白名单键被丢弃（注入：删分支 ⇒ 必败）', async () => {
  const h = await prefsHarness()
  try {
    // 前置（这条就是"删掉白名单分支"的等价注入）：未登记键会被**静默丢弃**
    const dropped = await h.call('/tradewatcher/prefs', { method: 'POST', body: JSON.stringify({ patch: { notARealPref: 123 } }) })
    assert.equal(dropped.code, 200)
    assert.equal('notARealPref' in (dropped.body.prefs as object), false, '前置：未登记键确实会被静默丢弃（删分支的注入就是这个形状）')

    // 源码级：白名单分支必须真的在（否则就是"回 200 但值不落盘"）
    assert.ok(STORE_SRC.includes('if (patch.rescueInboxRead !== undefined) this.prefs.rescueInboxRead = normalizeRescueInboxRead(patch.rescueInboxRead)'), 'applyPrefsPatch 必须有 rescueInboxRead 分支')
    const written = await h.call('/tradewatcher/prefs', {
      method: 'POST',
      body: JSON.stringify({ patch: { rescueInboxRead: { '1016-1425': 1760000000000, '1017-0935': 1760000300000 } } }),
    })
    assert.equal(written.code, 200)
    const read = await h.call('/tradewatcher/prefs')
    assert.deepEqual(
      (read.body.prefs as { rescueInboxRead?: Record<string, number> }).rescueInboxRead,
      { '1016-1425': 1760000000000, '1017-0935': 1760000300000 },
      '写入后 GET 必须原样读回（回 200 但值不落盘 = 白名单缺分支）',
    )
  } finally {
    h.close()
  }
})

test('⑫ prefs：非法值被宽容丢弃且不 500；键数超上界按最旧裁剪（注入：强转 / 不裁 ⇒ 必败）', async () => {
  const { normalizeRescueInboxRead, RESCUE_INBOX_READ_MAX } = await import('./store.ts')
  // 非对象 ⇒ {}（不抛错）
  assert.deepEqual(normalizeRescueInboxRead('nope'), {})
  assert.deepEqual(normalizeRescueInboxRead(null), {})
  assert.deepEqual(normalizeRescueInboxRead([1, 2]), {})
  // 值非有限数 / 空键 / 超长键 ⇒ 丢弃
  const mixed = normalizeRescueInboxRead({ a: 1, b: '2', c: NaN, d: Infinity, '': 4, e: 5 })
  assert.deepEqual(mixed, { a: 1, e: 5 }, `只保留有限数值的合法键（实得 ${JSON.stringify(mixed)}）`)
  // 键数上界：保留最新的 RESCUE_INBOX_READ_MAX 条
  const big: Record<string, number> = {}
  for (let i = 0; i < RESCUE_INBOX_READ_MAX + 500; i += 1) big[`k${i}`] = i
  const capped = normalizeRescueInboxRead(big)
  assert.equal(Object.keys(capped).length, RESCUE_INBOX_READ_MAX, `键数必须被裁到 ${RESCUE_INBOX_READ_MAX}`)
  assert.equal(capped.k0, undefined, '最旧的（时间戳最小）必须被丢掉')
  assert.equal(capped[`k${RESCUE_INBOX_READ_MAX + 499}`], RESCUE_INBOX_READ_MAX + 499, '最新的必须留下')
  // HTTP：非法输入不得 500
  const h = await prefsHarness()
  try {
    const bad = await h.call('/tradewatcher/prefs', { method: 'POST', body: JSON.stringify({ patch: { rescueInboxRead: 'not-an-object' } }) })
    assert.equal(bad.code, 200, '非对象不得 500（宽容归一）')
    assert.deepEqual((bad.body.prefs as { rescueInboxRead?: unknown }).rescueInboxRead, {}, '非对象 ⇒ {}')
  } finally {
    h.close()
  }
  // 注入：强转（不做归一）会把 '2' / NaN 带进运行时 ⇒ 同一判据必须失败
  const mutant = (raw: unknown) => raw as Record<string, number>
  mustFail(() => assert.deepEqual(mutant({ b: '2', c: NaN }), { a: 1, e: 5 }), '⚠ 反例（强转）必须让判据失败')
  // 注入：不裁剪 ⇒ 键数超过上界
  mustFail(() => assert.equal(Object.keys(mutant(big)).length, RESCUE_INBOX_READ_MAX), '⚠ 反例（不裁剪）必须让判据失败')
})

test('⑬ prefs 装载：手改坏值不阻断启动（rescueInboxRead 非对象 ⇒ {}；开关坏值 ⇒ false）', async () => {
  const { DataStore } = await import('./store.ts')
  const dir = mkdtempSync(join(tmpdir(), 'tw-impl80-load-'))
  writeFileSync(join(dir, 'prefs.json'), JSON.stringify({
    theme: 'dark',
    rescue: { enabled: true, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [], rescueCoverageEnabled: 'yes' },
    rescueInboxRead: 'broken',
  }), 'utf8')
  const store = new DataStore(dir)
  await store.init()
  const prefs = store.getPrefs()
  assert.deepEqual(prefs.rescueInboxRead, {}, '坏值被归一到 {}（不是原样带进界面）')
  assert.equal(prefs.rescue.rescueCoverageEnabled, false, '开关坏值一律当 false（阶段一：绝不因为手改而悄悄加分）')
  // 开关的合法值可以落盘并被快照带出
  const mon = new (await import('./rescue.ts')).RescueMonitor(dir, prefs.rescue as never)
  await mon.init()
  assert.equal(mon.getConfig().rescueCoverageEnabled, false)
  mon.setConfig({ rescueCoverageEnabled: true })
  assert.equal(mon.getConfig().rescueCoverageEnabled, true)
})
