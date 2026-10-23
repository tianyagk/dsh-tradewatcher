import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TW_CSS } from './styles.ts'
import { compositionItems, decisionRows, equityLegendItems } from './prismView.ts'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, './PrismPage.tsx'), 'utf8')
const series = ['#1', '#2', '#3', '#4', '#5', '#6'] as const
const pos = (n: number) => Array.from({ length: n }, (_, i) => ({ secid: `s${i}`, name: `标的${i}`, qty: 1, cost: 10 }))
const prices = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`s${i}`, 10]))

test('① 净值卡只有一个数据图例（再列持仓 ⇒ 败）', () => {
  assert.deepEqual(equityLegendItems(), ['总资产'])
  assert.ok(page.includes("equityLegend[0]"))
  assert.ok(page.includes('netMode'))
  const injected = page.replace("equityLegend[0]", "'标的 A'")
  assert.notEqual(injected, page)
  assert.throws(() => assert.equal(injected.includes('标的 A'), false, '注入：再列持仓'), /注入/)
})

test('② 持仓构成图例 = min(持仓数,6)：3→3、6→6、7→6（写死 4 ⇒ 败）', () => {
  assert.equal(compositionItems(pos(3), prices, 1000, series).length, 3)
  assert.equal(compositionItems(pos(6), prices, 1000, series).length, 6)
  const seven = compositionItems(pos(7), prices, 1000, series)
  assert.equal(seven.length, 6)
  assert.equal(seven[5]?.name, '其他')
  assert.throws(() => assert.equal(seven.length, 4, '注入：写死 4'), /注入/)
})

test('③ 净值卡与持仓构成不在同一卡片（合并回一卡 ⇒ 败）', () => {
  const tableCard = page.indexOf('tw-prism-tablecard')
  const composition = page.indexOf('tw-prism-composition')
  const equity = page.indexOf('tw-prism-equitycard')
  assert.ok(tableCard >= 0 && composition > tableCard && equity > composition, '构成必须在持仓卡内、净值卡之前')
  const equityChunk = page.slice(equity)
  assert.equal(equityChunk.includes('tw-prism-composition'), false, '净值卡不得再嵌构成条')
  const injected = page.replace('tw-prism-equitycard', 'tw-prism-equitycard tw-prism-composition-merged')
  assert.notEqual(injected, page)
  assert.throws(() => assert.equal(page.slice(page.indexOf('tw-prism-equitycard')).includes('tw-prism-composition'), true, '注入：合并'), /注入/)
})

test('时点按钮无 emoji（⏱/✕ 恢复 ⇒ 败）', () => {
  assert.equal(/[⏱⏰⏳✕]/.test(page), false)
  const injected = `${page}\nconst bad = '⏱ ✕'`
  assert.throws(() => assert.equal(/[⏱⏰⏳✕]/.test(injected), false, '注入：emoji'), /注入/)
})

test('④ 四格次要说明右对齐（margin-left:auto）', () => {
  const sub = /\.tw-prism-sub\{([^}]*)\}/.exec(TW_CSS)?.[1] ?? ''
  assert.match(sub, /margin-left:auto/)
  assert.match(sub, /text-align:right/)
  const injected = TW_CSS.replace('.tw-prism-sub{color:var(--tw-muted);font-size:12px;line-height:1.3;margin-left:auto;align-self:flex-end;text-align:right}', '.tw-prism-sub{color:var(--tw-muted);font-size:12px;line-height:1.3}')
  assert.doesNotMatch(injected, /\.tw-prism-sub\{[^}]*margin-left:auto/)
})

test('limits 为 null 时页面保持 —（模型没给，非解析失败）', () => {
  const rows = decisionRows({ limits: { singlePct: null, totalPct: null }, orders: [], cancel: [], rejects: [] })
  assert.equal(rows[0]?.value, '—')
  assert.equal(rows[1]?.value, '—')
})

test('交易账户统一：trading.account 空时落回 state.account（cash/positions 一致）', async () => {
  const { normalizeTradingState } = await import('./prismView.ts')
  const account = { day: '2026-10-23', capitalLimit: 1500000, cash: 1.12, realized: 0, dayStartEquity: 1, positions: [{ secid: '1.588170', name: '半导体', qty: 500000, available: 500000, cost: 0.89 }], copiedAt: 1, copyLogs: [] }
  const state = { account, orders: [], fills: [], equity: [], decision: null } as unknown as import('../shared/prism.ts').PrismState
  const t = normalizeTradingState({
    state,
    trading: { account: { ...account, cash: 0, positions: [] }, orders: [], fills: [], equity: [], decision: null },
  })
  assert.equal(t?.account.cash, 1.12)
  assert.equal(t?.account.positions.length, 1)
})

test('决策卡显示 note / limits.note（空则 —）', () => {
  const rows = decisionRows({ note: '风险优先，暂不新增订单', limits: { singlePct: 20, totalPct: 50, note: '按总资产 20%' }, orders: [], cancel: [], rejects: [] })
  assert.equal(rows.find((r) => r.key === '决策理由')?.value, '风险优先，暂不新增订单')
  assert.equal(rows.find((r) => r.key === '仓位上限依据')?.value, '按总资产 20%')
  const empty = decisionRows({ note: '', limits: { singlePct: null, totalPct: null, note: null }, orders: [], cancel: [], rejects: [] })
  assert.equal(empty.find((r) => r.key === '决策理由')?.value, '—')
  assert.equal(empty.find((r) => r.key === '仓位上限依据')?.value, '—')
})

test('单票上限：可买额度不足一手 ⇒ —（可买额度不足一手）；充足 ⇒ 百分比', async () => {
  const { singleLimitText } = await import('./prismView.ts')
  assert.equal(singleLimitText(0.00009, 1.12, 4.06), '—（可买额度不足一手）')
  assert.equal(singleLimitText(0.00009, 100000, 4.06), '0.00009%')
  assert.equal(singleLimitText(20, 1.12, 4.06), '—（可买额度不足一手）')
  const rows = decisionRows({ note: '不买：无钱；不卖：未破位', limits: { singlePct: 0.00009, totalPct: null, note: '1.12 ÷ 总资产' }, orders: [], cancel: [], rejects: [] }, { cash: 1.12, minPrice: 4.06 })
  assert.equal(rows.find((r) => r.key === '单票上限')?.value, '—（可买额度不足一手）')
  assert.equal(rows.find((r) => r.key === '仓位上限依据')?.value, '1.12 ÷ 总资产')
})

test('已跑标签移到标题行右侧，不挤占分段行', () => {
  const head = page.slice(page.indexOf('tw-prism-head'), page.indexOf('tw-prism-body'))
  assert.match(head, /tw-prism-notice/)
  assert.match(TW_CSS, /\.tw-prism-notice\{[^}]*margin-left:auto/)
  const injected = page.replace('{notice !== null ? <span className="tw-prism-notice tw-prism-muted">{notice}</span> : null}', '{notice !== null ? <span className="tw-prism-muted">{notice}</span> : null}')
  assert.notEqual(injected, page)
  assert.doesNotMatch(injected.slice(injected.indexOf('tw-prism-head'), injected.indexOf('tw-prism-body')), /tw-prism-notice/)
})
