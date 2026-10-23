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

test('①b 缺昨收只影响溢价那一项：前三个数照给、溢价位给 `—`（整行退化 ⇒ 必败）', () => {
  const partial: AuctionInfo = { ...ok, premiumPct: null }
  assert.equal(auctionText(partial), '1331.88 · 516.00 手 · 1.54% · —', '缺昨收 ⇒ 只缺溢价（不把三个已算出的数一起丢掉）')
  // 反例注入：旧写法（任一 null ⇒ 整行 `—`）⇒ 判据必败
  assert.throws(
    () => assert.equal(auctionText(partial), '—', '反例上：整行退化必须对不上'),
    /反例上/,
    '⚠ 反例注入（整行退化）必须失败',
  )
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
  // 竞价行只在 `auctionRow` 一处渲染（单一来源），值来自"独立出口那份" `a`
  assert.ok(drawerSrc.includes("kv('竞价', auctionText(a))"), '竞价行必须由 `auctionRow` 单一渲染（无 title/悬停）')
  assert.ok(drawerSrc.includes('auctionRow(a)'), '头部网格必须调用 `auctionRow`（而不是各处自己拼一行）')
  const forbidden = ['集合竞价', '竞价口径', '竞价说明', '竞价规则', '等于开盘价', '竞价是']
  const hits = forbidden.filter((w) => drawerSrc.includes(w))
  assert.deepEqual(hits, [], `抽屉里出现了竞价解释文字：${hits.join('、')}`)
  // 反例注入：加一句口径 ⇒ 判据必须非空
  const injected = `${drawerSrc}\n// 竞价说明：竞价价等于开盘价\n`
  const bad = forbidden.filter((w) => injected.includes(w))
  assert.ok(bad.length > 0, '⚠ 反例（加一句口径）必须被抓到')
  assert.throws(() => assert.deepEqual(bad, [], '反例'), /反例/, '⚠ 反例注入必须让断言失败')
})

test('④ 详情不可用时，竞价行与曲线仍渲染（注入：只认 detail.ok ⇒ 必败）', () => {
  /**
   * 判据：`detail === null` 的两个分支（`infoErr` / `infoNote`）都必须渲染 `infoGrid(null)`（竞价行在里面）
   * 与 `auctionSpark(auction)`（曲线）。整个网格只有一处渲染函数，插值 `d === null ? '—'` 只作用于
   * 东财字段，不作用于竞价 —— 所以"东财挂了 ⇒ 竞价也没了"这条老链路在结构上不再可能。
   */
  const at = drawerSrc.indexOf('const headerRows = ')
  assert.ok(at > 0, '必须能定位 headerRows')
  const branch = drawerSrc.slice(at, drawerSrc.indexOf('const chartBody = ', at))
  const nullBranch = branch.slice(branch.indexOf('if (detail === null)'), branch.indexOf('const d = detail'))
  assert.ok(nullBranch.includes('infoGrid(null)'), '详情为 null 时必须渲染网格（竞价行在其中，其余 —）')
  assert.ok(nullBranch.includes('auctionSpark(auction)'), '详情为 null 时必须渲染竞价曲线')
  assert.ok((nullBranch.match(/infoGrid\(null\)/g) ?? []).length >= 2, '骨架前/两种失败态都要有竞价（不许只剩骨架）')
  // 反例注入：把这三处收进 `detail !== null`（老写法）⇒ 判据必须失败
  const legacy = branch.replace(/infoGrid\(null\)/g, '').replace(/auctionSpark\(auction\)/g, '')
  assert.throws(
    () => assert.ok(legacy.includes('infoGrid(null)'), '反例上：只认 detail.ok 时竞价不会渲染'),
    /反例上/,
    '⚠ 反例注入（只认 detail.ok）必须失败',
  )
})
