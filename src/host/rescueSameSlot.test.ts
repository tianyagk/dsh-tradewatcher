/**
 * **同刻度基线**（用户口径 v0.17.0 / AUDIT-IMPL59）：早盘不再静默。
 *
 * 背景：`timeCoefficient(0.4)` 是"早盘量能天然偏小"的**粗糙替代品** —— 它把等级线抬到
 * `35/0.4 = 87.5`、`55/0.4 = 137.5`，而四项权重上限只有 **71.7** ⇒ 早盘**数学上不可达**，真信号一起被压掉。
 * 修法：给量能因子建**同 5 分钟 slot 的近 20 日 (μ, σ)** 基线，量能按 `z` 归一；等级线保持 35/55；
 * 时点系数降级为**兜底**（基线不足时才用，且必须写明"本次用时点系数替代"，不得静默）。
 *
 * 两条合成用例是本批的验收核心：
 *   ① 早盘量能同刻度 `z ≥ 2` ⇒ **必须能出等级**（证明早盘不再静默）；
 *   ② 早盘量能正常（`z ≈ 0`）⇒ **不得出等级**（证明不是靠放宽门槛换来的）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))

test('① 同刻度 z 的判据：样本 < 20 日 / σ 不可用 ⇒ null（回落兜底，不写 0、不编 z）', async () => {
  const { sameSlotZ, SAME_SLOT_MIN_DAYS } = await import('./rescue.ts')
  assert.equal(SAME_SLOT_MIN_DAYS, 20)
  // 正常：z = (0.42 − 0.30) / 0.05 = 2.4
  assert.equal(sameSlotZ(0.42, 0.3, 0.05, 20), Math.min(5, (0.42 - 0.3) / 0.05))
  // 冷启动：天数不够 ⇒ null（**不写 0**）
  assert.equal(sameSlotZ(0.42, 0.3, 0.05, 19), null, '不足 20 日 ⇒ null')
  // σ 过小（样本各天几乎一样）⇒ 分不出高低 ⇒ null（否则会给出一个巨大的假 z）
  assert.equal(sameSlotZ(0.42, 0.3, 0.0001, 25), null, 'σ 过小 ⇒ null')
  // 取不到当前进度 / 基线缺失 ⇒ null
  assert.equal(sameSlotZ(null, 0.3, 0.05, 25), null)
  assert.equal(sameSlotZ(0.42, null, 0.05, 25), null)
  assert.equal(sameSlotZ(0.42, 0.3, null, 25), null)
  // 极端值夹在 ±5（避免一个离群日把分数顶穿）
  assert.equal(sameSlotZ(10, 0.3, 0.05, 25), 5)
})

test('② 合成用例：早盘（09:40，旧系数 0.4）量能同刻度 z ≥ 2 ⇒ **必须能出等级**（早盘不再静默）', async () => {
  const { scoreRescue, RESCUE_LEVEL_BASE } = await import('./rescue.ts')
  const early = {
    // 09:40 ⇒ 旧口径会套 0.4；这里仍然传 0.4，验证"有基线时系数不参与"
    timeCoef: 0.4,
    volumeZ: 2.2,
    volumeZDays: 20,
    // 早盘的其他读数：脉冲一般、持续性样本少（null）、指数小幅下跌（量价背离因子正常给分）
    timeAdjMult: 1.4, coreSuperVsAvg: 0.4, peripheralSuperVsAvg: null,
    pulseMult: 1.6, persistShare: null, retraceRatio: null, indexPct: -0.9,
    resonance: 2, coreResonance: 1, peripheralResonance: 1,
    f2Anchors: [0.5, 1, 2] as [number, number, number],
  }
  const r = scoreRescue(early as never)
  assert.equal(r.inSession, true)
  assert.ok(r.level >= 1, `早盘 z=2.2 必须能出等级（实得 L${r.level}，raw=${r.rawScore}，评分 ${r.score}）`)
  // 等级线仍然是 35/55（没有被系数抬高）——这是"不动等级线"的硬证据
  assert.deepEqual([...RESCUE_LEVEL_BASE], [35, 55], '等级线基准必须保持 35/55')
  assert.equal(r.levelLines.t1, 35, `早盘 + 基线可用 ⇒ 线就是 35（实得 ${r.levelLines.t1}）`)
  assert.equal(r.levelLines.t2, 55, `早盘 + 基线可用 ⇒ 线就是 55（实得 ${r.levelLines.t2}）`)
  assert.equal(r.timeCoef, 1, '基线可用 ⇒ 生效系数按 1 算（系数不参与）')
  // 归因里必须能读到"用了同刻度 z"，以及因子行显示 z 而不是旧倍数
  assert.ok(r.summary.includes('同刻度 z='), `归因要写明量能口径：${r.summary}`)
  assert.ok(r.summary.includes('时点系数不参与'), '归因要写明系数不参与')
  const vol = r.factors.find((f) => f.id === 'volume')
  assert.equal(vol?.actual.startsWith('z='), true, `量能因子的实测值要显示 z（实得 ${vol?.actual}）`)
  assert.ok((vol?.threshold ?? '').includes('同刻度'), `因子口径行要写清同刻度：${vol?.threshold}`)
})

test('③ 合成用例：早盘量能正常（z ≈ 0）⇒ **不得出等级**（不是靠放宽门槛换来的）', async () => {
  const { scoreRescue } = await import('./rescue.ts')
  const same = {
    timeCoef: 0.4, volumeZ: 0.1, volumeZDays: 20,
    timeAdjMult: 1.4, coreSuperVsAvg: 0.4, peripheralSuperVsAvg: null,
    pulseMult: 1.6, persistShare: null, retraceRatio: null, indexPct: -0.9,
    resonance: 2, coreResonance: 1, peripheralResonance: 1,
    f2Anchors: [0.5, 1, 2] as [number, number, number],
  }
  const r = scoreRescue(same as never)
  assert.equal(r.level, 0, `早盘量能正常 ⇒ 不得出等级（实得 L${r.level}，raw=${r.rawScore}）`)
  // 对照：同样的盘面只把 z 换成 2.2 ⇒ 必须出等级（证明差异来自量能刻度，不是门槛）
  const strong = scoreRescue({ ...same, volumeZ: 2.2 } as never)
  assert.ok(strong.level >= 1 && (strong.rawScore as number) > (r.rawScore as number), '同一盘面：z 高 ⇒ 分高且出等级')
})

test('④ 冷启动（基线不足）：**回落时点系数**且必须写明替代（不得静默）；等级线照旧被抬高', async () => {
  const { scoreRescue } = await import('./rescue.ts')
  const cold = {
    timeCoef: 0.4, volumeZ: null, volumeZDays: 6, // 只有 6 天 ⇒ 不够 20
    timeAdjMult: 2.2, coreSuperVsAvg: 0.4, peripheralSuperVsAvg: null,
    pulseMult: 2.2, persistShare: 0.2, retraceRatio: null, indexPct: -0.9,
    resonance: 2, coreResonance: 1, peripheralResonance: 1,
    f2Anchors: [0.5, 1, 2] as [number, number, number],
  }
  const r = scoreRescue(cold as never)
  assert.equal(r.timeCoef, 0.4, '基线不足 ⇒ 生效系数仍是时点系数（兜底）')
  assert.equal(r.levelLines.t1, 35 / 0.4, `基线不足 ⇒ 线照旧被系数抬高（实得 ${r.levelLines.t1}）`)
  assert.ok(r.summary.includes('同刻度基线不足'), `必须写明基线与天数：${r.summary}`)
  assert.ok(r.summary.includes('用时点系数'), '必须写明"本次用时点系数替代"（不得静默）')
  const vol = r.factors.find((f) => f.id === 'volume')
  assert.equal(vol?.actual.endsWith('x'), true, `基线不足 ⇒ 实测值显示旧倍数（实得 ${vol?.actual}）`)
  assert.ok((vol?.threshold ?? '').includes('基线不足'), `口径行要写明基线不足：${vol?.threshold}`)
})

test('⑤ 结构性：`sameSlotZ` 的判据只有一处实现；采样路径把 z 传进评分；等级线基准没被改过', async () => {
  const src = readFileSync(`${HERE}rescue.ts`, 'utf8')
  assert.equal(src.split('function sameSlotZ(').length - 1, 1, '同刻度 z 只许有一处实现')
  assert.ok(src.includes('volumeZ: maxVolumeZ'), '采样路径必须把同刻度 z 传进 scoreRescue')
  assert.ok(src.includes('volumeZ: maxVolumeZ,\n      volumeZDays: sameSlotDays'), '同时要传基线天数（归因要用）')
  assert.ok(/const coef = sameSlot \? 1 : coefInput/.test(src), '系数只允许在"基线不足"时参与（兜底）')
  assert.ok(src.includes('RESCUE_LEVEL_BASE = [35, 55]'), '等级线基准必须还是 35/55（未被改回缩放）')
  assert.ok(src.includes('progressSd'), 'σ 必须持久化（否则重启后基线又没了）')
})
