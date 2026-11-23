/**
 * 用户报的问题：招商轮船只剩 89 股（约 1 400 元）、却仍被判断「占总资产 24.9% 超 20% 单票上限」。
 *
 * 根因不是引擎的权重算法（引擎按 现价 × 股数 / 总资产 = 0.09%），而是**喂给模型的上下文把
 * 【真实账户持仓】（26 000 股）与【棱镜模拟持仓】（89 股）混在一起**，模型拿真实股数算了占比。
 *
 * 本文件钉三件事：
 *   ① 提示词分节必须写清「真实账户持仓 = 只读参考、不得用于算占比」；
 *   ② 账户快照必须给出**棱镜持仓明细**（股数/成本/现价/市值/权重），模型没有理由再去借真实持仓；
 *   ③ 持仓手工调整必须同时改 netCost（否则「成本 × 数量 ≠ 账面成本」继续制造假浮盈）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { accountSnapshotOf } from './prismRoutes.ts'
import { applyPositionOp } from './prismDeskWrite.ts'
import type { PrismAccount, PrismPosition } from '../shared/prism.ts'

const PIPELINE = readFileSync(new URL('./prismPipeline.ts', import.meta.url), 'utf8')

const pos = (over: Partial<PrismPosition> = {}): PrismPosition => ({ secid: '1.601872', name: '招商轮船', qty: 89, available: 89, cost: 19.39, netCost: 1725.71, ...over } as PrismPosition)
const acc = (): PrismAccount => ({ day: '2026-11-23', capital: 1_000_000, capitalLimit: 1_000_000, cash: 100_000, realized: 0, dayStartEquity: null, positions: [pos()] } as PrismAccount)

test('① 提示词：真实账户持仓标注「只读参考/禁止算占比」，并有「只认棱镜账户」强制规则', () => {
  assert.match(PIPELINE, /【真实账户持仓（只读参考 —— 禁止用于计算棱镜仓位\/权重）】/)
  assert.match(PIPELINE, /【强制·只认棱镜账户】/)
  assert.match(PIPELINE, /不得用它的股数\/成本计算占比/)
})

test('② 账户快照含棱镜持仓明细：股数 / 成本 / 现价 / 市值 / 权重', () => {
  const text = accountSnapshotOf(acc(), { '1.601872': 15.51 }, [], 0, Date.now())
  assert.match(text, /棱镜持仓明细（模拟盘，权重 = 市值 ÷ 总资产）：/)
  assert.match(text, /招商轮船（1\.601872）：89 股/)
  assert.match(text, /成本 19\.390/)
  assert.match(text, /现价 15\.510/)
  assert.match(text, /市值 1380\.39/)
  // 权重按棱镜账户算：1380.39 / (100000 + 1380.39) ≈ 1.36%
  assert.match(text, /权重 1\.36%/, text)
})

test('④ 持仓手工调整必须同步 netCost（成本 × 数量 = 账面成本）', () => {
  const r = applyPositionOp(acc(), { op: 'update', secid: '1.601872', shares: 100, cost: 19.39 }, 1000)
  assert.equal(r.ok, true)
  const p = (r as { account: PrismAccount }).account.positions[0]!
  assert.equal(p.cost, 19.39)
  assert.equal(p.netCost, 1939)
})

test('⑤ 卖出超过持仓必须抛错（不得把数量卖成负数）', async () => {
  const { applyFill } = await import('./prismAccount.ts')
  const order = { id: 'o', secid: '1.601872', name: '招商轮船', side: 'sell', price: 15.51, shares: 999, reason: 't', decidedAt: 1, day: '2026-11-23', status: 'filled', filledShares: 999, filledAt: 2, fillPrice: 15.51 }
  const fill = { orderId: 'o', secid: '1.601872', name: '招商轮船', side: 'sell', price: 15.51, shares: 999, amount: 999 * 15.51, fee: 5, at: 2, source: '1min' }
  assert.throws(() => applyFill(acc(), order as never, fill as never), /卖出超过持仓/)
})
