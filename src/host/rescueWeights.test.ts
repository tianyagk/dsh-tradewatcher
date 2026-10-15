/**
 * 护盘模块：**权重口径（B-1）+ 连续评分（B-2）+ 交易时段闸门（A-1）** 的断言。
 *
 * 依据 `docs/AUDIT-IMPL54.md`（§批 A′+B 的测量与回放、§修正后的 B-1）：
 *   · F2「超大单强度」在宽基 ETF 上不可用（305 样本因子分 p90 = 1 / max = 15；原始输入 p90 = 0.01×20 日均额）
 *     ⇒ **剔除**，其余四项**保留原权重不归一**（合计 **0.717**）；
 *   · 等级线**保持历史值 35/55/75**（"线 × 0.717"与"权重归一"是同一条规则 ⇒ 会把等级整体上移 1 档，
 *     违反验收判据「等级天数分布差异 ≤ ±1 天/档」——见本文件 ③④ 两条用例）；
 *   · 连续评分 = `raw ÷ 权重合计 × 100`（0–100 可比）+ 近 20 日分位（样本 < 5 ⇒ null）；
 *   · 非交易时段不出等级（收盘后/午休/盘前），也不计入当日最高等级。
 *
 * 反例注入（由 `/tmp/rescue5/inject.py` 执行，每条都必须让本文件变红）：
 *   ①把 `superflow` 塞回权重表 ②把权重归一 ③打开 `LEVEL_LINE_FOLLOWS_WEIGHT_SUM` ④去掉交易时段闸门
 *   ⑤给 raw 加一个常数顶替 F2 分值 ⑥删掉"已剔除"归因标注。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = process.env.DSH_HOME ?? join('/tmp', 'rescue5-weights-home')

/** 改前的历史口径（五项、合计恰好 1.000）——用作"等效性"对拍的参照，**不参与实现** */
const HIST_WEIGHTS = { volume: 0.239, superflow: 0.283, pulse: 0.196, persistence: 0.13, divergence: 0.152 } as const
/** 历史等级线：基准 35/55/75 ÷ 时点系数（与实现同源的历史值） */
function histLevel(raw: number, coef: number): 0 | 1 | 2 | 3 {
  const t1 = 35 / coef
  const t2 = 55 / coef
  const t3 = 75 / coef
  return raw >= t3 ? 3 : raw >= t2 ? 2 : raw >= t1 ? 1 : 0
}

test('① 权重表：剔 F2 后四项合计恰好 = 0.717，且每项 > 0.05（**不归一**）', async () => {
  const { RESCUE_WEIGHTS, RESCUE_WEIGHT_SUM, scoreRescue } = await import('./rescue.ts')
  const entries = Object.entries(RESCUE_WEIGHTS)
  const sum = entries.reduce((a, [, w]) => a + w, 0)
  assert.equal(Math.round(sum * 1000) / 1000, 0.717, `四项合计必须 = 0.717（实际 ${sum}）`)
  assert.equal(RESCUE_WEIGHT_SUM, 0.717, 'RESCUE_WEIGHT_SUM 必须与权重表同源（= 0.717）')
  for (const [k, w] of entries) assert.ok(w > 0.05, `${k} 权重过低（${w}）⇒ 形同虚设`)
  assert.equal(entries.length, 4, '剔除 F2 与共振后应剩四项')
  assert.equal('resonance' in RESCUE_WEIGHTS, false, '共振权重必须已删除')
  assert.equal('superflow' in RESCUE_WEIGHTS, false, '⚠ F2（超大单强度）必须已删除（数据稀疏，不可用）')
  // 出分路径上的因子与权重必须与之同源、合计同样 = 0.717
  const r = scoreRescue({
    timeAdjMult: 1.5, coreSuperVsAvg: 0.6, peripheralSuperVsAvg: null, pulseMult: 1.0, persistShare: 0.1,
    retraceRatio: 0.2, indexPct: -0.5, resonance: 3, coreResonance: 1, peripheralResonance: 2,
    f2Anchors: [0.5, 1.0, 2.0], f2Source: 'calibrated', timeCoef: 1,
  } as never)
  const ids = r.factors.map((f) => f.id)
  assert.deepEqual(ids, ['volume', 'pulse', 'persistence', 'divergence'], `出分因子必须是这四项（实际 ${ids.join(',')}）`)
  assert.equal(ids.includes('resonance' as never), false, '出分列表里不得再有共振因子')
  assert.equal(ids.includes('superflow' as never), false, '出分列表里不得再有 F2')
  const wsum = r.factors.reduce((a, f) => a + f.weight, 0)
  assert.equal(Math.round(wsum * 1000) / 1000, 0.717, `出分因子权重合计必须 = 0.717（实际 ${wsum}）`)
})

test('② 恒 0 / 恒满因子不得存在（本机日志；无日志则跳过并说明）', async () => {
  const path = join(homedir(), '.dsh', 'dsh-tradewatcher', 'rescue-log.json')
  let log: { days?: Record<string, { scoreLog?: Array<{ factors?: Array<{ id: string; score: number }> }> }> }
  try {
    log = JSON.parse(readFileSync(path, 'utf8')) as typeof log
  } catch {
    console.log('[skip] 本机没有 rescue-log.json（CI/隔离环境）⇒ 该项只在有真实样本的机器上验证')
    return
  }
  const seen = new Map<string, number>()
  const nonzero = new Map<string, number>()
  const full = new Map<string, number>()
  for (const day of Object.values(log.days ?? {})) {
    for (const s of day.scoreLog ?? []) {
      for (const f of s.factors ?? []) {
        seen.set(f.id, (seen.get(f.id) ?? 0) + 1)
        if (f.score > 0) nonzero.set(f.id, (nonzero.get(f.id) ?? 0) + 1)
        if (f.score >= 100) full.set(f.id, (full.get(f.id) ?? 0) + 1)
      }
    }
  }
  assert.ok(seen.size > 0, '历史样本里必须能看到因子（否则判据无效）')
  // 只查**当前仍在评分里**的因子：历史上已删除的因子留在旧日志里属正常留痕
  const { RESCUE_WEIGHTS } = await import('./rescue.ts')
  const live = new Set(Object.keys(RESCUE_WEIGHTS))
  const dead = [...seen.entries()]
    .filter(([id, n]) => live.has(id) && (nonzero.get(id) ?? 0) === 0 && n >= 20)
    .map(([id, n]) => `${id}（${n} 个样本全 0）`)
  assert.deepEqual(dead, [], `这些因子只占权重、从不贡献，必须删除或修数据通路：${dead.join('、')}`)
  // 恒满同样没用：一个"永远满分"的因子没有区分度（阈值取 90% 满分；实测最高 volume 43.9%）
  const saturated = [...seen.entries()]
    .filter(([id, n]) => live.has(id) && n >= 20 && (full.get(id) ?? 0) / n >= 0.9)
    .map(([id, n]) => `${id}（${((full.get(id) ?? 0) / n * 100).toFixed(1)}% 样本满分）`)
  assert.deepEqual(saturated, [], `这些因子几乎恒为满分、没有区分度：${saturated.join('、')}`)
})

test('③ 等级集两级 + 线固定 35/55（**不随权重合计缩放**）+ **任何被声明的等级必须可达**', async () => {
  const { ruleLevel, RESCUE_WEIGHTS, RESCUE_WEIGHT_SUM, RESCUE_LEVEL_BASE, RESCUE_LEVELS } = await import('./rescue.ts')
  // 声明面：只有三级状态、两个信号档（资金异动 / 疑似护盘），**强护盘已删除**
  assert.deepEqual([...RESCUE_LEVELS], [0, 1, 2], '声明给用户的等级集必须是 0/1/2（强护盘已删除）')
  assert.deepEqual([...RESCUE_LEVEL_BASE], [35, 55], '等级线 = 历史值 35/55（不乘 0.717 ⇒ 与改前逐日一致的唯一形式）')
  assert.equal(RESCUE_LEVEL_BASE.length, RESCUE_LEVELS.length - 1, '线的条数必须 = 信号档数（没有第 3 条线）')
  assert.equal(RESCUE_WEIGHT_SUM, 0.717)
  assert.equal(Object.keys(RESCUE_WEIGHTS).length, 4)
  // ⚠ 结构性断言（Lead 要求）：**任何被声明的等级，其线必须 ≤ 可达上限**
  const cap = RESCUE_WEIGHT_SUM * 100 // 四项全满时的 raw 上限 = 71.7
  RESCUE_LEVELS.filter((l) => l >= 1).forEach((level, i) => {
    const line = RESCUE_LEVEL_BASE[i]
    assert.ok(line <= cap, `等级 ${level} 的线 ${line} 超过可达上限 ${cap.toFixed(1)} ⇒ 这个等级够不着，必须删除或删线`)
  })
  // 顶档必须真的能到：四项全满 ⇒ 声明集里的最高档
  assert.equal(ruleLevel(cap, 1), 2, '四项全满 ⇒ 最高声明档（疑似护盘）')
  assert.equal(ruleLevel(0, 1), 0, '全 0 ⇒ 平静')
  assert.equal(ruleLevel(cap + 100, 1), 2, '再高的 raw 也不会冒出未声明的档（没有 L3 线）')
  // 逐点单调（防比较方向写反）+ 与历史口径**逐点一致**（f2 = 0 情形）
  let prev = 0
  for (let raw = 0; raw <= cap + 30; raw += 0.25) {
    const lv = ruleLevel(raw, 1)
    assert.ok(lv >= prev, `规则等级必须随 raw 单调不减（raw=${raw}：${prev} → ${lv}）`)
    prev = lv
    assert.equal(lv, histLevel(raw, 1) > 2 ? 2 : histLevel(raw, 1), `raw=${raw} 时必须与历史口径一致（且封顶在声明集的最高档）`)
  }
  // 反证：把 L3 线 75 塞回去 ⇒ 可达性判据必须失败（这条断言不是恒真）
  const declaredWithL3 = [35, 55, 75]
  const unreachable = declaredWithL3.filter((line) => line > cap)
  assert.deepEqual(unreachable, [75], '反证：75 这条线超出上限 71.7 ⇒ 若声明了三级，可达性判据必然红（这正是删除强护盘的依据）')
})

test('④ 回放口径：改后与改前**逐日一致**（唯一允许的差异来自 F2 偶发 0–4 分）', async () => {
  const { scoreRescue, ruleLevel, RESCUE_WEIGHT_SUM } = await import('./rescue.ts')
  // 真实量级的因子输入网格铺满 8 个"伪日"
  const grid: Array<{ timeAdjMult: number; pulseMult: number; persistShare: number | null; indexPct: number; coef: number }> = []
  for (const timeAdjMult of [0.6, 1.1, 1.6, 2.2]) {
    for (const pulseMult of [0.4, 1.2, 2.2, 4.5]) {
      for (const indexPct of [0.4, -0.4, -1.3]) {
        for (const coef of [0.7, 1, 1.1]) grid.push({ timeAdjMult, pulseMult, persistShare: 0.12, indexPct, coef })
      }
    }
  }
  const perDay = 8
  const chunk = Math.ceil(grid.length / perDay)
  const before: number[] = []
  const after: number[] = []
  const changed: string[] = []
  for (let d = 0; d < perDay; d += 1) {
    let mxBefore = 0
    let mxAfter = 0
    for (const g of grid.slice(d * chunk, (d + 1) * chunk)) {
      const r = scoreRescue({
        timeAdjMult: g.timeAdjMult, coreSuperVsAvg: null, peripheralSuperVsAvg: null, pulseMult: g.pulseMult,
        persistShare: g.persistShare, retraceRatio: 0.2, indexPct: g.indexPct, resonance: 1,
        coreResonance: 1, peripheralResonance: 0, timeCoef: g.coef, f2Anchors: [0.5, 1, 2],
      } as never)
      const raw = r.rawScore ?? 0
      // 改前：五项口径（F2 = 0 —— 历史 p90 = 0 的常态）+ 历史线 35/55/75（Σw = 1 时代）
      const hist = Math.min(2, histLevel(raw, g.coef))
      mxBefore = Math.max(mxBefore, hist)
      mxAfter = Math.max(mxAfter, ruleLevel(raw, g.coef))
      if (hist !== ruleLevel(raw, g.coef)) changed.push(`coef=${g.coef} raw=${raw}`)
    }
    before.push(mxBefore)
    after.push(mxAfter)
  }
  const histSum = Object.values(HIST_WEIGHTS).reduce((a, b) => a + b, 0)
  assert.equal(Math.round(histSum * 1000) / 1000, 1, '历史参照口径必须合计 1.000（否则对拍无意义）')
  assert.equal(Math.round(RESCUE_WEIGHT_SUM * 1000) / 1000, 0.717)
  // 逐日一致（f2 = 0 ⇒ raw_new = raw_old ⇒ 判据必须完全相同）
  assert.deepEqual(after, before, `改后必须与改前逐日一致（差异样本：${changed.slice(0, 3).join(' / ')}）`)
})

test('⑤ 交易时段闸门：非交易时段不出等级、coef/raw/continuous/percentile 全为 null + 原因', async () => {
  const { inTradingSession, scoreRescue } = await import('./rescue.ts')
  const cases: Array<[string, boolean]> = [
    ['09:29', false], ['09:30', true], ['10:29', true], ['11:30', true], ['11:31', false],
    ['12:59', false], ['13:00', true], ['14:59', true], ['15:00', true], ['15:01', false],
    ['16:49', false], ['21:56', false], ['22:30', false], ['', false],
  ]
  for (const [hhmm, want] of cases) assert.equal(inTradingSession(hhmm), want, `${hhmm} 的时段判定必须是 ${want}`)
  const base = {
    timeAdjMult: 2.2, coreSuperVsAvg: 0.6, peripheralSuperVsAvg: null, pulseMult: 2.2, persistShare: 0.2,
    retraceRatio: 0.2, indexPct: -1.2, resonance: 2, coreResonance: 1, peripheralResonance: 1,
    f2Anchors: [0.5, 1, 2] as [number, number, number], timeCoef: 1.1,
  }
  const off = scoreRescue({ ...base, inSession: false } as never)
  assert.equal(off.level, 0, '非交易时段不出等级')
  assert.equal(off.inSession, false)
  assert.equal(off.timeCoef, null, '时点系数必须置空（不是 0：0 会被读成"系数为 0 的读数"）')
  assert.equal(off.rawScore, null, 'rawScore 必须置空（不是 0）')
  assert.equal(off.continuous, null, '连续评分必须置空')
  assert.equal(off.percentile, null, '分位必须置空')
  assert.equal(off.summary.includes('非交易时段'), true, `归因必须写明「非交易时段」：${off.summary}`)
  // 反证：同一批输入在交易时段内**必须**出等级（否则闸门判据恒真）
  const on = scoreRescue({ ...base, inSession: true, recentContinuous: [] } as never)
  assert.equal(on.inSession, true)
  assert.ok(on.level >= 1, `反证：交易时段内这组强输入必须出等级（实际 ${on.level}）`)
  assert.equal(typeof on.rawScore, 'number')
})

test('⑥ 连续评分 = raw ÷ 权重合计（0–100），分位样本不足如实给 null；归因里可见', async () => {
  const { scoreRescue, scorePercentile, RESCUE_WEIGHT_SUM } = await import('./rescue.ts')
  const strong = scoreRescue({
    timeAdjMult: 3, coreSuperVsAvg: 0.8, peripheralSuperVsAvg: null, pulseMult: 5, persistShare: 0.4,
    retraceRatio: 0.1, indexPct: -2, resonance: 2, coreResonance: 1, peripheralResonance: 1,
    f2Anchors: [0.5, 1, 2], timeCoef: 1,
  } as never)
  const raw = strong.rawScore as number
  assert.equal(Math.round(((strong.continuous as number) * RESCUE_WEIGHT_SUM) * 1000) / 1000, Math.round(raw * 1000) / 1000, '连续评分必须 = raw ÷ 权重合计（raw 单位是"分×权重"，上限 = 0.717 × 100）')
  assert.ok((strong.continuous as number) <= 100 + 1e-9, '连续评分上限 100')
  assert.equal(strong.summary.includes('连续评分'), true, `归因必须给出连续评分：${strong.summary}`)
  // 分位：样本不足 ⇒ null（不编）；够了 ⇒ 0–100
  assert.equal(scorePercentile(50, [1, 2, 3, 4]), null, '样本 < 5 ⇒ null（不编）')
  assert.deepEqual(scorePercentile(3, [1, 2, 3, 4, 5]), { pct: 60, n: 5 })
  assert.deepEqual(scorePercentile(0, [1, 2, 3, 4, 5]), { pct: 0, n: 5 })
  assert.deepEqual(scorePercentile(9, [1, 2, 3, 4, 5]), { pct: 100, n: 5 })
  const withHist = scoreRescue({
    timeAdjMult: 1.5, coreSuperVsAvg: 0.6, peripheralSuperVsAvg: null, pulseMult: 1.0, persistShare: 0.1,
    retraceRatio: 0.2, indexPct: -0.5, resonance: 1, coreResonance: 1, peripheralResonance: 0,
    f2Anchors: [0.5, 1, 2], timeCoef: 1, recentContinuous: [10, 20, 30, 40, 50, 60, 70],
  } as never)
  assert.equal(typeof withHist.percentile, 'number', '给了近 20 日样本 ⇒ 分位必须算出来')
  assert.equal(withHist.summary.includes('分位'), true, `归因必须给出分位：${withHist.summary}`)
})

test('⑦ F2 被剔除是**如实标注**：归因写明原因，且它的读数不再影响任何分数（无常数顶替）', async () => {
  const { scoreRescue } = await import('./rescue.ts')
  const base = {
    timeAdjMult: 1.6, pulseMult: 1.5, persistShare: 0.12, retraceRatio: 0.2, indexPct: -0.8,
    resonance: 1, coreResonance: 1, peripheralResonance: 0, f2Anchors: [0.5, 1, 2] as [number, number, number], timeCoef: 1,
  }
  const noFlow = scoreRescue({ ...base, coreSuperVsAvg: null, peripheralSuperVsAvg: null } as never)
  const bigFlow = scoreRescue({ ...base, coreSuperVsAvg: 1.4, peripheralSuperVsAvg: 1.4 } as never)
  assert.equal(noFlow.rawScore, bigFlow.rawScore, '⚠ F2 的读数变化**不得**改变 raw（既不加分也不留常数底分）')
  assert.equal(noFlow.level, bigFlow.level, 'F2 读数不得改变等级（它已不在判据里）')
  for (const must of ['已剔除', '超大单强度', '分单数据稀疏']) {
    assert.equal(bigFlow.summary.includes(must), true, `归因必须写清「${must}」：${bigFlow.summary}`)
  }
})
