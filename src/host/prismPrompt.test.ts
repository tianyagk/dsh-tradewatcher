import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPrismAnalysis, ACCOUNT_PROMPT_FIELDS, decisionProblems, type PrismInputs } from './prismPipeline.ts'
import { accountSnapshotOf } from './prismRoutes.ts'
import { PrismStore } from './prismStore.ts'

const account = {
  day: '2026-10-23', capitalLimit: 1_500_000, cash: 1.12, realized: 0, dayStartEquity: 1_259_360,
  positions: [
    { secid: '1.588170', name: '科创半导体ETF', qty: 500_000, available: 500_000, cost: 0.89 },
    { secid: '1.518880', name: '黄金ETF', qty: 5_000, available: 5_000, cost: 8.89 },
  ],
  copiedAt: 1, copyLogs: [],
}
const prices = { '1.588170': 0.89, '1.518880': 8.89 }
const snapshot = accountSnapshotOf(account, prices, [{ orderId: 'o1', secid: '1.588170', name: 'x', side: 'buy', price: 1, shares: 1, amount: 1, fee: 0, at: Date.now(), source: '1min' }], 2, Date.now())
const inputs: PrismInputs = { positions: '科创半导体ETF 500000 股', quotes: '行情', account: snapshot, news: [], skeleton: '骨架' }

test('账户快照 7 项齐全（少一项 ⇒ 败）', () => {
  for (const field of ACCOUNT_PROMPT_FIELDS) assert.ok(snapshot.includes(field), `缺 ${field}`)
  assert.match(snapshot, /总资产：\d+\.\d{2} 元/)
  assert.match(snapshot, /现金：1\.12 元/)
  assert.match(snapshot, /持仓市值：\d+\.\d{2} 元/)
  assert.match(snapshot, /当前仓位占比：\d+\.\d{2}%/)
  assert.match(snapshot, /可买额度：1\.12 元/)
  assert.match(snapshot, /当日已成交笔数：1 笔/)
  assert.match(snapshot, /未成交挂单：2 笔/)
  const injected = snapshot.replace('现金：', '')
  assert.ok(ACCOUNT_PROMPT_FIELDS.filter((f) => !injected.includes(f)).length > 0)
  assert.throws(() => assert.equal(ACCOUNT_PROMPT_FIELDS.every((f) => injected.includes(f)), true, '注入：少一项'), /注入/)
})

test('捕获的 5 个请求体都含账户快照；汇总要求 note，limits 不为 null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-prompt-'))
  try {
    const store = new PrismStore(dir)
    await store.init()
    const seen: string[] = []
    let calls = 0
    const llm = {
      stream: (opts: { messages: Array<{ content: unknown }> }) => {
        calls += 1
        const raw = opts.messages[0]?.content
        seen.push(Array.isArray(raw) ? raw.map((b) => (b as { text?: string }).text ?? '').join('') : String(raw))
        const text = calls <= 4
          ? `分报告${calls}`
          : '汇总\n```json\n{"note":"风险优先，暂不新增订单","limits":{"singlePct":20,"totalPct":50,"note":"按总资产 20%"},"orders":[],"cancel":[]}\n```'
        return (async function* () { yield { type: 'text-delta', text } })()
      },
    }
    const get = (name: string): unknown => name === 'llm' ? llm : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined
    const run = await runPrismAnalysis(store, '09:35', inputs, { get, now: () => Date.parse('2026-10-23T09:35:18+08:00') })
    assert.equal(seen.length, 5)
    for (const text of seen) for (const field of ACCOUNT_PROMPT_FIELDS) assert.ok(text.includes(field), `请求体缺 ${field}`)
    assert.match(seen[4] ?? '', /"note"/)
    assert.equal(run.decision?.limits.singlePct, 20)
    assert.equal(run.decision?.limits.totalPct, 50)
    assert.equal(run.decision?.note, '风险优先，暂不新增订单')
    assert.deepEqual(decisionProblems(run.decision), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('orders=[] 且 note 空 ⇒ 决策自检必败', () => {
  assert.deepEqual(decisionProblems({ limits: { singlePct: 20, totalPct: 50, note: 'x' }, note: '理由', orders: [], cancel: [], rejects: [], parseError: null }), [])
  const bad = decisionProblems({ limits: { singlePct: 20, totalPct: 50, note: 'x' }, note: '', orders: [], cancel: [], rejects: [], parseError: null })
  assert.ok(bad.some((x) => x.includes('note')))
})


test('API 同一份账户：state.account 与 trading.account 由同一个 tradingWithDecision 展开', () => {
  const routes = readFileSync(join(process.cwd(), 'src/host/prismRoutes.ts'), 'utf8')
  assert.match(routes, /const tradingWithDecision = \{ \.\.\.trading, decision: latestDecision \}/)
  assert.match(routes, /state: \{ \.\.\.stateOf\(store, deps\.get\), \.\.\.tradingWithDecision, modelCatalog \}/)
  assert.match(routes, /trading: tradingWithDecision/)
})
