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
import { payloadFingerprint, trendLkgPersistStep, trimTrendPayload, trendWriteDecision } from './em.ts'

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

test('③ 指纹文本不含 `ts`（含它 = 闸永远开着）：跨时间稳定 ⇒ 第二次不写；注入回 `text` ⇒ 必败', () => {
  const entries = [{ key: '1.600519|1', at: 1_700_000_000_000, trend: fakeTrend(40, 'z') }]
  const realNow = Date.now
  try {
    // 同一份 entries、两个不同的"现在"：落盘文本里的 ts 会变，指纹文本必须不变
    Date.now = () => 1_000_000
    const a = trimTrendPayload(entries, 1_000_000)
    Date.now = () => 9_000_000
    const b = trimTrendPayload(entries, 1_000_000)
    assert.notEqual(a.text, b.text, '落盘文本必须带 ts（这份文件是什么时候写的）')
    assert.ok(a.text.includes('"ts"'), '落盘文本里有 ts')
    assert.equal(a.stableText.includes('"ts"'), false, '⚠ 指纹文本不许含 ts（含了就会每次判"有变化"）')
    assert.equal(a.stableText, b.stableText, '同一份 entries ⇒ 指纹文本必须逐字节相同')
    // 判据：第二轮"内容未变 ⇒ 不写"
    const fp = payloadFingerprint(a.stableText)
    const write1 = trendWriteDecision({ dirty: true, now: 10_000_000, lastWrite: 0, payload: a.stableText, lastFingerprint: null })
    assert.equal(write1.write, true, '第一次：有变化 ⇒ 写')
    const write2 = trendWriteDecision({ dirty: true, now: 10_000_000, lastWrite: 0, payload: b.stableText, lastFingerprint: fp })
    assert.equal(write2.write, false, '第二轮：内容未变 ⇒ 不写（2.34MB 整份重写的闸）')
    assert.ok(write2.reason.includes('内容未变'), `原因要写清楚：${write2.reason}`)
    // 反例注入：拿带 ts 的 text 当指纹 ⇒ 第二轮仍然"有变化" ⇒ 上面那条必败
    const fpText = payloadFingerprint(a.text)
    const injected = trendWriteDecision({ dirty: true, now: 10_000_000, lastWrite: 0, payload: b.text, lastFingerprint: fpText })
    assert.equal(injected.write, true, '⚠ 反例（指纹用 text）必须仍然要写 —— 这正是修之前的行为')
  } finally {
    Date.now = realNow
  }
})

test('④ 落盘状态迁移：节流跳过必须**保留 dirty**（下一轮重试）；内容未变才清 dirty；先推进 lastWrite ⇒ 必败', () => {
  const payload = JSON.stringify([{ key: 'a|1', at: 1 }])
  const now = 10_000_000
  // ① 正常：dirty + 窗口外 + 新内容 ⇒ 写，并推进 lastWrite / 记指纹
  const written = trendLkgPersistStep({ dirty: true, lastWrite: 0, lastFingerprint: null }, payload, now)
  assert.equal(written.write, true)
  assert.deepEqual(written.next, { dirty: false, lastWrite: now, lastFingerprint: written.fingerprint })
  // ② 节流：dirty + 窗口内 ⇒ 不写，但 **dirty 必须保留**（丢掉它 = 这份兜底文件不再更新）
  const throttled = trendLkgPersistStep({ dirty: true, lastWrite: now - 1000, lastFingerprint: null }, payload, now)
  assert.equal(throttled.write, false)
  assert.equal(throttled.next.dirty, true, '⚠ 节流跳过不得丢掉 dirty（下一轮必须重试）')
  // ③ 内容未变 ⇒ 不写，且清 dirty（盘上已是最新）
  const same = trendLkgPersistStep({ dirty: true, lastWrite: now - 6000, lastFingerprint: written.fingerprint }, payload, now)
  assert.equal(same.write, false)
  assert.ok(same.reason.includes('内容未变'), `原因要写清楚：${same.reason}`)
  assert.equal(same.next.dirty, false, '内容未变 ⇒ 盘上已是最新，可以清 dirty')
  // ④ 反例注入：调用方先把 lastWrite 设成 now（v0.91.0 的第二个顺序 bug）⇒ 永远"窗口内" ⇒ 永远不写
  const broken = trendLkgPersistStep({ dirty: true, lastWrite: now, lastFingerprint: null }, payload, now)
  assert.equal(broken.write, false, '⚠ 反例（先推进 lastWrite）必须写不出去 —— 这就是 bug 的形状')
})
