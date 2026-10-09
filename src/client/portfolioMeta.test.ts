/**
 * 值列已经是 `0.00`，这些派生说明行只会误导。这里锁住"什么时候必须有话、什么时候必须没有"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { availableLockNote, feeShareNote, lockedQty, ytdBaseNote } from './portfolioMeta.ts'

test('M1 可用数量：可用=持仓时**不出现**（今日买入 0 份那句话是假话）', () => {
  assert.equal(availableLockNote(1000, 1000), null)
  assert.equal(availableLockNote(100, 100), null, 'T+1 但今日没买入 ⇒ 没有"不可卖"这回事')
  assert.equal(availableLockNote(0, 0), null)
  assert.equal(lockedQty(1000, 1000), 0)
})

test('M1 可用数量：确实有不可卖部分时给一句短的（≤14 字，不含口径）', () => {
  const note = availableLockNote(1000, 800)
  assert.equal(note, '今日买入 200 份不可卖')
  assert.ok(note !== null && note.length <= 14, `必须短（实际 ${note?.length} 字）`)
  assert.ok(!(note ?? '').includes('T+1'), '口径进 title，不占正文')
  // 小数数量也照实算
  assert.equal(availableLockNote(100.5, 100), '今日买入 0.5 份不可卖')
})

test('M4 费用占比：未录费用（fees=0）时整条不出；有费用才给占比', () => {
  assert.equal(feeShareNote(0, null), null, '未录费用：值列已有 0.00，不再加一行说明')
  assert.equal(feeShareNote(0, 0.5), null, '费用为 0 时任何占比都没意义')
  assert.equal(feeShareNote(1234, null), null, '占比算不出来就不给（不写"不可算"这句）')
  assert.equal(feeShareNote(1234, 0.0213), '占成交额 0.021%')
  assert.equal(feeShareNote(1234, 0), '占成交额 0.000%', '有费用但占比真的为 0 时照实说')
})

test('M2 YTD 基准：常态基准不常显（进 tooltip），年内上市的"上市首日"必须出现', () => {
  assert.equal(ytdBaseNote('2026-01-02', 'normal'), null, '常态基准（年初）不占位')
  assert.equal(ytdBaseNote('2026-01-02', undefined), null)
  assert.equal(ytdBaseNote(null, 'listing'), null, '没有日期时不给（原因在 tooltip 里）')
  const listing = ytdBaseNote('2026-06-30', 'listing')
  assert.equal(listing, '上市首日 2026-06-30')
  assert.ok((listing ?? '').includes('上市首日'), '年内上市必须写明"上市首日"，否则会被读成"年初至今"而高估')
})
