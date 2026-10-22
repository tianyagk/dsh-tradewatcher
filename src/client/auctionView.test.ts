/**
 * 【竞价】一行的展示判据：格式逐字、未开盘/不可用两种空态、抽屉里没有解释文字。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auctionText } from './auctionView.ts'
import type { AuctionInfo } from '../shared/model.ts'

const here = dirname(fileURLToPath(import.meta.url))
const drawerSrc = readFileSync(join(here, 'QuoteDrawer.tsx'), 'utf8')

const ok: AuctionInfo = {
  state: 'ok', price: 1331.88, volLots: 516, volSharePct: 1.54, premiumPct: 0.83, reason: null,
  series: [], seriesDay: null,
}

test('① 四项齐全且格式逐字：`1331.88 · 516.00 手 · 1.54% · +0.83%`', () => {
  assert.equal(auctionText(ok), '1331.88 · 516.00 手 · 1.54% · +0.83%')
  assert.equal(auctionText({ ...ok, price: 5.2 }), '5.20 · 516.00 手 · 1.54% · +0.83%', '价格固定 2 位小数')
  assert.equal(auctionText({ ...ok, volLots: 8 }), '1331.88 · 8.00 手 · 1.54% · +0.83%', '量固定 2 位小数')
  assert.equal(auctionText({ ...ok, premiumPct: -0.42 }), '1331.88 · 516.00 手 · 1.54% · -0.42%')
  assert.equal(auctionText({ ...ok, premiumPct: 0 }), '1331.88 · 516.00 手 · 1.54% · 0.00%')
  // 反例注入：少一项（去掉量比）⇒ 判据必须失败
  const withoutShare = '1331.88 · 516.00 手 · +0.83%'
  assert.notEqual(withoutShare, auctionText(ok))
  assert.throws(() => assert.equal(withoutShare, auctionText(ok), '反例'), /反例/, '⚠ 反例（少一项）必须失败')
})

test('② 未开盘 ⇒ `—`；不可用 ⇒ `—（原因）`（拿昨日顶替 / 写作 0 ⇒ 必败）', () => {
  const notOpen: AuctionInfo = {
    state: 'not-open', price: null, volLots: null, volSharePct: null, premiumPct: null, reason: null,
    series: [], seriesDay: null,
  }
  assert.equal(auctionText(notOpen), '—')
  const unavailable: AuctionInfo = {
    state: 'unavailable', price: null, volLots: null, volSharePct: null, premiumPct: null,
    reason: '腾讯 m1 取数失败', series: [], seriesDay: null,
  }
  assert.equal(auctionText(unavailable), '—（腾讯 m1 取数失败）')
  // 反例注入：未开盘却拿昨日数据（写成 0 或数字）⇒ 判据必须失败
  assert.throws(() => assert.equal(auctionText(notOpen), '1320.50 · 800.00 手 · 2.00% · +0.10%', '反例'), /反例/, '⚠ 反例（昨日顶替）必须失败')
  assert.throws(() => assert.equal(auctionText(notOpen), '0', '反例'), /反例/, '⚠ 反例（用 0 顶替）必须失败')
})

test('⑤ 抽屉里不得出现竞价解释文字（加一句口径 ⇒ 必败）；且该行不进悬停', () => {
  assert.ok(drawerSrc.includes("kv('竞价', auctionText(d.auction))"), '抽屉必须紧跟今开渲染竞价一行（无 title/悬停）')
  const forbidden = ['集合竞价', '竞价口径', '竞价说明', '竞价规则', '等于开盘价', '竞价是']
  const hits = forbidden.filter((w) => drawerSrc.includes(w))
  assert.deepEqual(hits, [], `抽屉里出现了竞价解释文字：${hits.join('、')}`)
  // 反例注入：加一句口径 ⇒ 判据必须非空
  const injected = `${drawerSrc}\n// 竞价说明：竞价价等于开盘价\n`
  const bad = forbidden.filter((w) => injected.includes(w))
  assert.ok(bad.length > 0, '⚠ 反例（加一句口径）必须被抓到')
  assert.throws(() => assert.deepEqual(bad, [], '反例'), /反例/, '⚠ 反例注入必须让断言失败')
})
