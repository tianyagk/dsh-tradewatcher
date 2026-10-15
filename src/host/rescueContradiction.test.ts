/**
 * P6 内部矛盾检测（docs/AUDIT-IMPL54.md 批 A 第 2 项）。
 *
 * 口径：量能同时点倍数 ≥ 标定 P90（`RESCUE_CALIBRATION.f1.high` = 1.57x）**且**超大单读数 ≤ 0
 * ⇒ 输出矛盾标记与原因；**不改分数、不改等级**（红线：不得用代理指标升级信号）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_HOME = process.env.DSH_HOME ?? '/tmp/rescue3-contra-home'

const base = {
  coreSuperVsAvg: 1.0, peripheralSuperVsAvg: null, pulseMult: 1.0, persistShare: 0.2, retraceRatio: 0.2,
  indexPct: -0.8, resonance: 3, coreResonance: 2, peripheralResonance: 2,
  f2Anchors: [0.5, 1.0, 2.0] as [number, number, number], f2Source: 'calibrated' as const, timeCoef: 1,
}

test('P6：量增但超大单 ≤ 0 ⇒ 有矛盾标记 + 原因；分数与等级不受影响', async () => {
  const { scoreRescue } = await import('./rescue.ts')
  const { RESCUE_CALIBRATION } = await import('./rescue-thresholds.ts')
  const contra = scoreRescue({ ...base, timeAdjMult: RESCUE_CALIBRATION.f1.high + 0.5, coreSuperVsAvg: -0.2 } as never)
  assert.notEqual(contra.contradiction, null, '必须给出矛盾标记')
  assert.match(String(contra.contradiction), /拆单|算法单|被动成交/, '原因要写清可解释的几种可能')
  assert.match(contra.summary, /内部矛盾/, '摘要里必须能看到（归因展示）')
  // 不改分数/等级：证明分数**只**由 rawScore × 时点系数 决定（标记不参与），且 rawScore == Σ 权重×因子分
  const recomputed = Math.max(0, Math.min(100, Math.round(contra.rawScore * contra.timeCoef)))
  assert.equal(contra.score, recomputed, '分数必须只是 rawScore × coef 的函数（矛盾标记不得参与）')
  const wsum = contra.factors.reduce((a, f) => a + f.weight * f.score, 0)
  assert.equal(Math.round(wsum * 100) / 100, Math.round(contra.rawScore * 100) / 100, 'rawScore 必须等于 Σ 权重×因子分')
  const lines = (contra as { levelLines: { t1: number; t2: number } }).levelLines
  // 等级集两级（v0.15.0）：只有 35 / 55 两条线，最高到「疑似护盘」(2)
  const expectedLevel = contra.rawScore >= lines.t2 ? 2 : contra.rawScore >= lines.t1 ? 1 : 0
  // 等级还要过防误报封顶（只降不升）⇒ 断言"不低于按线算出的等级"即可证明标记没有升级作用
  assert.ok((contra.level as number) <= expectedLevel, '等级不得因矛盾标记而升高（红线）')
  const noContra = scoreRescue({ ...base, timeAdjMult: RESCUE_CALIBRATION.f1.high + 0.5, coreSuperVsAvg: 0.2 } as never)
  assert.equal(noContra.contradiction, null, '超大单为正 ⇒ 不构成矛盾')
  // 量能没到 P90 ⇒ 不构成矛盾（阈值来自标定，不是拍脑袋）
  const small = scoreRescue({ ...base, timeAdjMult: 1.0, coreSuperVsAvg: -0.2 } as never)
  assert.equal(small.contradiction, null, '未显著放量时不该报矛盾')
  // 超大单读数缺失 ⇒ 不报（缺数据不能当 0 判）
  const missing = scoreRescue({ ...base, timeAdjMult: 3.0, coreSuperVsAvg: null, peripheralSuperVsAvg: null } as never)
  assert.equal(missing.contradiction, null, '超大单读数缺失 ⇒ 不给矛盾结论（未取到 ≠ 0）')
})
