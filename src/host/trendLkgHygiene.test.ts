/**
 * `trends-lkg.json` 的数据卫生（REVIEW-4-RISK §P2）：真机实测 **5.19MB / 111 条 / 无上限 / 每 5 秒整份重写**。
 *
 * 两道闸各有一个**纯函数**做判据（可测、可注入）：
 *   · `trimTrendPayload` —— 体积上限：超限按 `at` 新 → 旧保留，压到上限的 80%；
 *   · `trendWriteDecision` —— 要不要落盘：不 dirty / 节流窗口内 / **内容指纹未变** ⇒ 不写。
 * 断言目标不是"函数存在"，而是"超大输入会被裁"与"内容没变时不写"（删掉任一条都会红）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { payloadFingerprint, trimTrendPayload, trendWriteDecision } from './em.ts'

/** 造一条体积可控的假分时 */
function fakeTrend(points: number, pad: string): { points: Array<[number, number]>; pad: string } {
  return { points: Array.from({ length: points }, (_, i) => [1_700_000_000_000 + i * 60_000, 100 + (i % 7)] as [number, number]), pad }
}

test('① 体积上限：超大输入必须被裁到上限内，且保留的是**最新的**条目', () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({ key: `1.00000${i}|1`, at: 1_700_000_000_000 + i * 1000, trend: fakeTrend(50, 'x'.repeat(200_000)) }))
  const before = JSON.stringify({ ts: 0, entries }).length
  const out = trimTrendPayload(entries, 1_000_000)
  const after = JSON.parse(out.text) as { entries: Array<{ key: string; at: number }> }
  assert.equal(before > 1_000_000, true, `夹具本身要超限（实得 ${(before / 1024).toFixed(0)}KB）`)
  assert.equal(out.text.length <= 1_000_000, true, `裁剪后必须 ≤ 上限（实得 ${(out.text.length / 1024).toFixed(0)}KB）`)
  assert.equal(out.dropped.length > 0, true, '必须报出被裁掉的条目（调用方要同步清内存）')
  const keptAts = after.entries.map((e) => e.at)
  assert.deepEqual([...keptAts].sort((a, b) => a - b), keptAts.slice().sort((a, b) => a - b), '保留顺序按 at 新→旧')
  assert.equal(keptAts.includes(1_700_000_000_000 + 11 * 1000), true, '最新的一条必须在保留集合里')
  // 未超限 ⇒ 原样返回（不许白白重排）
  const small = [{ key: 'a|1', at: 1, trend: fakeTrend(3, 'y') }]
  assert.equal(trimTrendPayload(small, 1_000_000).dropped.length, 0, '没超限就不裁')
})

test('② 有变化 ⇒ 写；节流窗口内 ⇒ 不写；**内容未变 ⇒ 不写**（写放大的闸）', () => {
  const payload = JSON.stringify({ ts: 1, entries: [{ key: 'a|1', at: 1 }] })
  const fp = payloadFingerprint(payload)
  const base = { now: 10_000_000, lastWrite: 0, payload }
  assert.deepEqual(trendWriteDecision({ ...base, dirty: true, lastFingerprint: null }), { write: true, fingerprint: fp, reason: '有变化' })
  assert.equal(trendWriteDecision({ ...base, dirty: false, lastFingerprint: null }).write, false, '不 dirty ⇒ 不写')
  assert.equal(trendWriteDecision({ ...base, dirty: true, lastFingerprint: null, lastWrite: base.now - 1000 }).write, false, '节流窗口内 ⇒ 不写')
  const same = trendWriteDecision({ ...base, dirty: true, lastFingerprint: fp })
  assert.equal(same.write, false, '⚠ 内容指纹一致 ⇒ 必须跳过整份重写（否则就是 5MB × 每 5 秒的写放大）')
  assert.ok(same.reason.includes('内容未变'), `原因要写清楚：${same.reason}`)
  // 指纹判别性：内容一变，指纹必须变（否则"跳过"会把真变化吞掉）
  assert.notEqual(payloadFingerprint(payload.replace('at":1', 'at":2')), fp, '内容变了指纹必须变')
})
