/**
 * 「成本未录入」的断言（P1-10）。
 *
 * 缺陷形态：新建持仓后用「调整」录了数量、没填成本 → `avgCost = 0` →
 * 浮动盈亏 = (现价 − 0) × 数量 = **整个市值**（凭空多出一整笔盈利），并一起污染分组与总额。
 * 约定：区分"未录入"与"真的是 0 成本"（判据 `avgCost<=0 && qty>0 && turnover===0`），
 * 未录入时**市值照算**、盈亏与盈亏率给 `null`（界面显示 `—`），并在工具/界面里说清"未计入合计"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LedgerEntry, PortGroup, PortItem, PositionRow, QuoteRow } from '../shared/model.ts'
import { realizedUnknownNote, realizedUnknownQtyOf, realizedUnknownRows } from '../shared/model.ts'
import { assemblePortfolio, derivePosition } from './portfolio.ts'

const pos: PortItem = { id: 'p1', groupId: 'g1', secid: '1.600519', name: '贵州茅台', createdAt: 1 }
const group: PortGroup = { id: 'g1', name: '长期', order: 1 }

const quote = (price: number, prev = price): QuoteRow => ({
  secid: '1.600519', code: '600519', name: '贵州茅台', price, chg: price - prev, pct: 1, prev,
  open: null, high: null, low: null, vol: null, amount: null, up: null, down: null, even: null, time: null,
})

let seq = 0
const adjust = (qty: number, price?: number, ts?: number): LedgerEntry => ({ id: `e${++seq}`, ts: ts ?? seq, actor: 'web', verb: 'adjust', posId: 'p1', qty, ...(price === undefined ? {} : { price }) })
const buy = (qty: number, price: number, ts?: number): LedgerEntry => ({ id: `e${++seq}`, ts: ts ?? seq, actor: 'web', verb: 'buy', posId: 'p1', qty, price })
const sell = (qty: number, price: number, ts?: number): LedgerEntry => ({ id: `e${++seq}`, ts: ts ?? seq, actor: 'web', verb: 'sell', posId: 'p1', qty, price })

const DAY = 86_400_000

test('成本未录入：市值照算，盈亏与盈亏率一律为 null（不得等于全部市值）', () => {
  // 新建持仓 → 调整到 100 股、留空成本（宿主写入的 price 是 0）
  const row = derivePosition([adjust(100, 0)], pos, quote(12.5), Date.now() - DAY)
  assert.equal(row.qty, 100)
  assert.equal(row.costUnknown, true, '必须标记为"成本未录入"')
  assert.equal(row.mv, 1250, '市值照算（与成本无关）')
  assert.equal(row.floatPnl, null, '浮动盈亏不得是 (12.5−0)×100 = 1250 —— 那是把全部市值当盈利')
  assert.equal(row.dilutedPnl, null, '摊薄口径同样不得用 0 当成本')
  assert.equal(row.floatPnlPct, null)
  assert.equal(row.dilutedPnlPct, null)
})

test('真的买卖过就不算"未录入"：买入后成本正常参与计算', () => {
  const row = derivePosition([buy(100, 10)], pos, quote(12.5), Date.now() - DAY)
  assert.equal(row.costUnknown, false)
  assert.equal(row.avgCost, 10)
  assert.equal(row.floatPnl, 250)
  assert.equal(row.floatPnlPct, 25)
})

test('用「调整」显式补上成本后，"未录入"标记消失', () => {
  const row = derivePosition([adjust(100, 0), adjust(100, 8)], pos, quote(12.5), Date.now() - DAY)
  assert.equal(row.costUnknown, false)
  assert.equal(row.avgCost, 8)
  assert.equal(row.floatPnl, 450)
})

test('数值为整数/小数与备注无关：qty=0 的空仓不算"未录入"，也不产生盈亏', () => {
  const row = derivePosition([adjust(0, 0)], pos, quote(12.5), Date.now() - DAY)
  assert.equal(row.qty, 0)
  assert.equal(row.costUnknown, false, '空仓没有"成本未知"的问题（盈亏本来就是 0）')
  assert.equal(row.floatPnl, 0)
})

test('成本未录入的持仓不计入分组与总额的盈亏，但市值计入', () => {
  const items: PortItem[] = [pos, { id: 'p2', groupId: 'g1', secid: '0.300750', name: '宁德时代', createdAt: 2 }]
  const entries: LedgerEntry[] = [
    adjust(100, 0),                                                    // p1：成本未录入
    { id: 'e3', ts: 3, actor: 'web', verb: 'buy', posId: 'p2', qty: 10, price: 100 }, // p2：成本已知
  ]
  const quotes: Record<string, QuoteRow> = {
    '1.600519': quote(12.5),
    '0.300750': { ...quote(110), secid: '0.300750', code: '300750', name: '宁德时代' },
  }
  const { view } = assemblePortfolio([group], items, entries, quotes)
  const p1 = view.positions.find((p) => p.posId === 'p1')!
  const p2 = view.positions.find((p) => p.posId === 'p2')!
  assert.equal(p1.costUnknown, true)
  assert.equal(p2.costUnknown, false)
  assert.equal(view.grand.totalMv, 1250 + 1100, '市值照算（两只都计入）')
  assert.equal(view.grand.floatPnl, 100, '盈亏只含成本已知的那只（10×(110−100)=100）')
  assert.equal(view.grand.dilutedPnl, 100)
  assert.equal(view.groups[0].floatPnl, 100)
})

// ── D1（验收残留缺陷）：卖出不得解除"未录入成本"的守卫 ──────────────────────

test('D1 正向：adjust(100,0) 后卖出 → 守卫不解除（浮盈/摊薄盈亏/已实现都不得是 0 成本算出来的数）', () => {
  // 验收员的复现路径：新建持仓 → 「调整」只填数量 → 卖出（界面上的正常操作）
  const row = derivePosition([adjust(100, 0), sell(50, 12.5)], pos, quote(12.5, 12.5), Date.now() - DAY)
  assert.equal(row.qty, 50)
  assert.equal(row.turnover, 625, '卖出确实产生成交额（这正是旧判据 self-解除 的原因）')
  assert.equal(row.costUnknown, true, '发生过卖出也必须仍是"成本未录入"')
  assert.equal(row.floatPnl, null, '不得是 625（剩余 50 股的全额市值）')
  assert.equal(row.dilutedPnl, null, '不得是 1250（市值的两倍）')
  assert.equal(row.realized, null, '不得是 625（把 0 成本买入当成事实算出来的已实现）')
  assert.equal(row.dilutedPnlPct, null)
  assert.equal(row.floatPnlPct, null)
})

test('D1 边界：全部卖出后 qty=0，已实现同样不得按 0 成本给数', () => {
  const row = derivePosition([adjust(100, 0), sell(100, 12.5)], pos, quote(12.5, 12.5), Date.now() - DAY)
  assert.equal(row.qty, 0)
  assert.equal(row.realized, null, '全部清仓后 realized 仍是按 0 成本算出来的 1250 —— 必须给 null')
  assert.equal(row.costUnknown, true, '账面上有内容（已实现 ≠ 0）时仍标注"成本未录入"')
  // 真的什么都没有的空仓不算"未录入"
  assert.equal(derivePosition([adjust(0, 0)], pos, quote(12.5), Date.now() - DAY).costUnknown, false)
})

test('D1 反向（别把正常路径一起关掉）：真买入过 → 卖出照常算已实现', () => {
  const row = derivePosition([buy(100, 10), sell(50, 12)], pos, quote(12.5, 12.5), Date.now() - DAY)
  assert.equal(row.costUnknown, false)
  assert.equal(row.realized, 100, '(12 − 10) × 50 = 100')
  assert.equal(row.qty, 50)
  assert.equal(row.floatPnl, 125, '(12.5 − 10) × 50')
})

test('D1 边界：补上成本（adjust 带 price）⇒ 整仓守卫解除、浮盈恢复计算', () => {
  const row = derivePosition([adjust(100, 0), sell(50, 12.5), adjust(100, 9.5)], pos, quote(12.5, 12.5), Date.now() - DAY)
  assert.equal(row.costUnknown, false, '出现带成本的流水后整仓不再"未录入"')
  assert.equal(row.avgCost, 9.5)
  assert.equal(row.floatPnl, 300, '(12.5 − 9.5) × 100 —— 浮盈只依赖当前持仓与当前成本')
  // 但**历史**上那笔卖出是在成本未知时应用的：它的已实现不可算（D1b）
  assert.equal(row.realizedUnknownQty, 50)
  assert.equal(row.realized, null, '不得是 625：真实应为 (12.5 − 9.5) × 50 = 150，而重放算不出来')
})

// ── D1b：成本未知期间发生的卖出（逐笔判定，不用持仓级粘性 null）────────────────

test('D1b 正向：成本未知期间的卖出，在补录成本后仍不得被算成一个数（不得是 625）', () => {
  // adjust(100,0) → sell(50,12.5) → 再补成本 9.5（ts 晚于卖出）
  const row = derivePosition([adjust(100, 0), sell(50, 12.5), adjust(100, 9.5)], pos, quote(12.5, 12.5), Date.now() - DAY)
  assert.equal(row.realized, null, '不得是 625 —— 那是按 avgCost=0 应用的卖出')
  assert.equal(row.realizedUnknownQty, 50, '必须记下"成本未知期间卖出的股数"')
  assert.equal(row.costUnknown, false, '账面上已有成本流水 ⇒ 整仓不再是"未录入"（别退化成粘性 null）')
  assert.equal(row.floatPnl, 300, '(12.5 − 9.5) × 100；浮盈按 task-6 的行为恢复计算')
  assert.equal(row.dilutedPnl, 300)
})

test('D1b 关键好处：补录的成本流水 ts 早于卖出 ⇒ 重放算对 150（不是一律 —）', () => {
  // 三笔同一本账，但成本流水的 ts 早于卖出，且数组顺序被打乱 —— 走 assemblePortfolio 的
  // (ts,id) 排序重放：那笔卖出应用时成本已知 ⇒ 150，不需要任何特殊处理
  const entries = [sell(50, 12.5, 30), adjust(100, 0, 10), adjust(100, 9.5, 20)]
  const { view } = assemblePortfolio([group], [pos], entries, { '1.600519': quote(12.5, 12.5) })
  const row = view.positions[0]
  assert.equal(row.realized, 150, '(12.5 − 9.5) × 50 —— 能算对的就必须算对')
  assert.equal(row.realizedUnknownQty, 0, '没有任何一笔是在成本未知时卖出的')
  assert.equal(row.costUnknown, false)
})

test('D1b 回归：纯正常路径不被误伤（买入后卖出照常算已实现）', () => {
  const row = derivePosition([buy(100, 10), sell(50, 12)], pos, quote(12.5, 12.5), Date.now() - DAY)
  assert.equal(row.realizedUnknownQty, 0)
  assert.equal(row.realized, 100, '(12 − 10) × 50')
  assert.equal(row.costUnknown, false)
  // 没有任何卖出的持仓更不该被标记
  assert.equal(derivePosition([buy(100, 10)], pos, quote(12.5), Date.now() - DAY).realizedUnknownQty, 0)
})

test('D1b 文案：存在"成本未知期间卖出"时必须点明"成本录入前卖出"，不能只给一个 —', () => {
  const note = realizedUnknownNote(50)
  assert.ok(note.includes('成本录入前卖出'), `说明必须写清成因（实际：${note}）`)
  assert.ok(note.includes('50'), '必须带上股数')
  assert.ok(!note.includes('**'), '不得出现 Markdown 星号（P0-4 的同类泄漏）')
  // 整仓未录入（没有卖出）时给的是另一句，不误报
  const row = derivePosition([adjust(100, 0)], pos, quote(12.5), Date.now() - DAY)
  assert.equal(row.realizedUnknownQty, 0)
  assert.equal(row.realized, null, '整仓未录入时已实现同样是 null（由 costUnknown 覆盖）')
})

// ── N1：面板级提示必须与行内/工具用同一份判定（不自己重算一套）────────────────

test('N1 面板级提示：1 只 D1b + 1 只正常 ⇒ 只数/股数由同一份判定给出，与行内事实一致', () => {
  const posB: PortItem = { id: 'p2', groupId: 'g1', secid: '0.300750', name: '宁德时代', createdAt: 2 }
  const qB: QuoteRow = { ...quote(110, 100), secid: '0.300750', code: '300750', name: '宁德时代' }
  const mk = (posId: string, verb: 'buy' | 'sell' | 'adjust', qty: number, price?: number, ts = 1): LedgerEntry => ({ id: `${posId}-${verb}-${ts}`, ts, actor: 'web', verb, posId, qty, ...(price === undefined ? {} : { price }) })
  // A：成本未知期间卖出 50 股、之后补了成本（D1b：realizedUnknownQty>0 但 costUnknown=false，走"已实现"提示）；B：正常
  const rows: PositionRow[] = [
    derivePosition(
      [mk('p1', 'adjust', 100, 0, 1), mk('p1', 'sell', 50, 12.5, 2), mk('p1', 'adjust', 100, 9.5, 3)],
      pos, quote(12.5, 12.5), Date.now() - DAY,
    ),
    derivePosition([mk('p2', 'buy', 100, 100, 1)], posB, qB, Date.now() - DAY),
  ]
  // 前提自检：这一行必须是 D1b（补了成本 ⇒ 不再"成本未录入"，但已实现仍不可算）
  assert.equal(rows[0].costUnknown, false, '补了成本 ⇒ 整仓不再是"成本未录入"')
  assert.equal(rows[0].realizedUnknownQty, 50)
  // 行内事实（derivePosition 自己给的判定）
  const rowLevel = rows.filter((r) => r.realized === null && r.costUnknown !== true).map((r) => r.name)
  // 面板级/工具侧走的是共用函数
  const picked = realizedUnknownRows(rows)
  assert.deepEqual(picked.map((r) => r.name), rowLevel, '面板级只数必须与行内判定给出同一批行')
  assert.deepEqual(picked.map((r) => r.name), ['贵州茅台'])
  assert.equal(realizedUnknownQtyOf(picked), 50, '股数与判定同源（不是面板自己 reduce 出来的另一套）')
  assert.equal(rows[0].realized, null)
  assert.equal(rows[1].realized, 0, '正常持仓的已实现照常给数（买入后没卖过 → 0）')
})

test('N1 分区不重不漏：两个提示合起来恰好覆盖所有 realized === null 的行', () => {
  // C 同时满足两个条件：已经在「成本未录入」提示里报过 → 不重复计（否则用户会看到同一只被数两次）
  const rows = [
    { name: 'A', costUnknown: false, realizedUnknownQty: 50, realized: null as number | null },
    { name: 'B', costUnknown: false, realizedUnknownQty: 0, realized: 300 },
    { name: 'C', costUnknown: true, realizedUnknownQty: 40, realized: null },
    { name: 'D', costUnknown: true, realizedUnknownQty: 0, realized: null },
  ]
  assert.deepEqual(realizedUnknownRows(rows).map((r) => r.name), ['A'])
  assert.equal(realizedUnknownQtyOf(realizedUnknownRows(rows)), 50)
  const covered = new Set([
    ...realizedUnknownRows(rows).map((r) => r.name),
    ...rows.filter((r) => r.costUnknown === true).map((r) => r.name),
  ])
  const missing = rows.filter((r) => r.realized === null).map((r) => r.name)
  assert.deepEqual([...covered].sort(), [...missing].sort(), '不漏：每个 realized 为 — 的行都在两个提示之一里')
  // 不重：C 同时满足两个条件，但只在「成本未录入」提示里出现一次（A 走"已实现"提示）
  assert.equal(covered.size, 3, '不重：A + C + D 各出现一次，B 不该被任何提示覆盖')
  assert.ok(!realizedUnknownRows(rows).some((r) => r.name === 'C'))
})
