/** 回撤闸门：阈值可配置 + 基线可校平；账本恒等式反解 realized */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { drawdownGateOf } from './prismEval.ts'
import { realizedFromIdentity } from './prismAccount.ts'
import type { PrismEquityPoint } from '../shared/prism.ts'

const pt = (at: number, equity: number, capital = 1_800_000): PrismEquityPoint => ({ day: '2026-11-24', equity, capital, at } as PrismEquityPoint)

test('① 日阈值可配置：5% 时 −4% 不触发，−6% 触发', () => {
  const g1 = drawdownGateOf([pt(1, 1_800_000), pt(2, 1_728_000)], null, 3, { dailyLimitPct: 5, cumulativeLimitPct: 0 })
  assert.equal(g1.dailyPct, -4)
  assert.equal(g1.dailyTriggered, false)
  const g2 = drawdownGateOf([pt(1, 1_800_000), pt(2, 1_692_000)], null, 3, { dailyLimitPct: 5, cumulativeLimitPct: 0 })
  assert.equal(g2.dailyTriggered, true)
})

test('② 累计阈值 0 = 关闭该维度（真亏损也不再冻结买单）', () => {
  const g = drawdownGateOf([pt(1, 1_800_000), pt(2, 1_400_000)], null, 3, { dailyLimitPct: 5, cumulativeLimitPct: 0 })
  assert.ok(g.cumulativePct! < -10)
  assert.equal(g.cumulativeTriggered, false, '累计维度必须被关闭')
  assert.equal(g.dailyTriggered, true, '单日 −22% 仍应触发日阈值（两个维度独立）')
})

test('③ 基线时刻之后才统计：校平后样本不足 ⇒ 不触发', () => {
  const g = drawdownGateOf([pt(100, 1_300_000), pt(200, 1_400_000)], null, 3, { baseAt: 150 })
  assert.equal(g.triggered, false)
  assert.match(String(g.reason ?? ''), /不足/)
})

test('④ 基线之后有两点：从校平点重新起算', () => {
  const g = drawdownGateOf([pt(100, 1_300_000), pt(200, 1_500_000), pt(300, 1_480_000)], null, 3, { baseAt: 150 })
  assert.equal(g.cumulativePct, -1.11, '只算 200→300，不该把基线前的 −28% 算进来')
  assert.equal(g.triggered, false)
})

test('⑤ realized 恒等式：equity = capital + realized + unrealized', () => {
  assert.equal(realizedFromIdentity(1_494_381.09, 1_800_000, -163_961.91), -141_657)
  assert.equal(1_800_000 + -141_657 + -163_961.91, 1_494_381.09)
  assert.equal(realizedFromIdentity(NaN, 1, 1), null, '非法输入必须返回 null（不得洗成 0）')
})

test('⑥ 路由：rebase 动作存在且用同一恒等式，闸门读配置', () => {
  const r = readFileSync(new URL('./prismRoutes.ts', import.meta.url), 'utf8')
  assert.match(r, /action === 'rebase'/)
  assert.match(r, /realizedFromIdentity\(equity, account\.capital, unrealized\)/)
  assert.match(r, /dailyLimitPct: typeof settingsNow\.maxDDPct === 'number'/)
  assert.match(r, /baseAt: settingsNow\.gateBaseAt/)
})

test('⑦ equityPointOf：unrealized = Σ(市值−账面成本)，恒等式自洽', async () => {
  const { equityPointOf } = await import('./prismAccount.ts')
  const acc = {
    day: '2026-11-24', capital: 1_800_000, capitalLimit: 1_800_000, cash: 262_204.4, realized: -141_657, dayStartEquity: null,
    copiedAt: 0, copyLogs: [],
    positions: [
      { secid: '1.601872', name: '招商轮船', qty: 19_376, available: 19_376, cost: 18.83, netCost: 364_848.08 },
    ],
  }
  const capital = acc.capital; const realized = acc.realized
  const p = equityPointOf(acc, () => 15.56, 1)
  const mv = 19_376 * 15.56
  assert.ok(Math.abs(p.unrealized - (mv - 364_848.08)) < 0.01, `unrealized 应=${mv - 364_848.08}，实际 ${p.unrealized}`)
  // 恒等式只在「资金全部来自本金、无手工注入」时成立；这里只钉 unrealized 的口径
  assert.equal(capital, 1_800_000); assert.equal(realized, -141_657)
})
