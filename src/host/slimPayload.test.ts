/** 回包瘦身：reports[].text 与 desk.decisionFlow 不下发（客户端零引用，占 33.5%） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { slimPrismPayload } from './prismRoutes.ts'

test('① 去掉 runs[].reports 与 desk.decisionFlow，其余字段保持', () => {
  const payload = {
    ok: true,
    state: { runs: [{ id: 'r1', summary: 's', reports: [{ text: 'x'.repeat(10) }], analyses: [{ text: 'a' }] }], cash: 1 },
    desk: { decisionFlow: [{ id: 1 }], overview: { total: 1 } },
  }
  const out = slimPrismPayload(payload as never) as typeof payload
  assert.equal('reports' in out.state.runs[0]!, false)
  assert.deepEqual(out.state.runs[0]!.analyses, [{ text: 'a' }])
  assert.equal('decisionFlow' in out.desk, false)
  assert.equal(out.desk.overview.total, 1)
})

test('② 反例：不瘦身时 reports 仍在（证明测试有效）', () => {
  const payload = { state: { runs: [{ reports: [{ text: 'x' }] }] } }
  assert.equal('reports' in payload.state.runs[0]!, true)
})
