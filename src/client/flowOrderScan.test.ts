/** 决策流顺序：一次 run 内必须是「分析 → 决策(SCAN) → 风控」，不能看起来先决策后分析 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { flowEntriesOf } from './prismDeskMid.ts'

const run = {
  slot: '21:23', startedAt: 1000, finishedAt: 82_000,
  summary: '总判断：减仓。',
  decision: { orders: [], cancel: [], rejects: [], note: '不买：满仓；不卖：无信号', limits: { singlePct: 20, totalPct: 100 } },
  analyses: [
    { key: 'a', label: '技术面', text: '观察：中证1000 走弱。\n推理：量能不足。\n结论：等放量。', error: null },
    { key: 'b', label: '信息面', text: '观察：无重大新闻。\n推理：中性。\n结论：维持。', error: null },
  ],
}

test('① 同一 run：ANALYZE 排在 SCAN 之前，SCAN 时间戳 = finishedAt', () => {
  const list = flowEntriesOf({ runs: [run as never], orders: [] })
  const iScan = list.findIndex((e) => e.kind === 'SCAN')
  const iAnalyze = list.findIndex((e) => e.kind === 'ANALYZE')
  assert.ok(iScan > iAnalyze, `SCAN 必须在分析之后，实际 SCAN@${iScan} ANALYZE@${iAnalyze}`)
  assert.equal(list[iScan]?.at, run.finishedAt)
})

test('② 反例：把 SCAN 放回 startedAt ⇒ 它会排到分析前面（旧行为）', () => {
  // 旧实现的排序效果模型化：startedAt(1000) < finishedAt(82000) ⇒ 降序时 SCAN 落到最底，读起来像"先决策"
  const ats = [{ kind: 'ANALYZE', at: 82_000 }, { kind: 'SCAN', at: 1000 }]
  ats.sort((a, b) => b.at - a.at)
  assert.equal(ats[ats.length - 1]?.kind, 'SCAN', '旧时间戳下 SCAN 会被排到最后（时间上早于分析）')
})
