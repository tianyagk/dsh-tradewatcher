/**
 * 【竞价参考价曲线】展示判据：几何/区间文字/无点写 `—`/无坐标轴文字与网格。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUCTION_SPARK_HEIGHT,
  auctionSeriesText,
  auctionSparkGeometry,
  auctionSparkProblems,
  auctionSparkStats,
} from './auctionSeries.ts'
import type { AuctionPoint } from '../shared/model.ts'

const here = dirname(fileURLToPath(import.meta.url))
const sparkSrc = readFileSync(join(here, 'AuctionSpark.tsx'), 'utf8')
const drawerSrc = readFileSync(join(here, 'QuoteDrawer.tsx'), 'utf8')

const series: AuctionPoint[] = [
  { t: 0, ref: 1330.1, matched: 100 },
  { t: 10_000, ref: 1331.88, matched: 516 },
  { t: 20_000, ref: 1330.5, matched: 300 },
]

test('① 几何：一条折线 + 量柱，区间文字两个数', () => {
  const g = auctionSparkGeometry(series)
  assert.ok(g !== null)
  assert.equal(g.height, AUCTION_SPARK_HEIGHT)
  assert.ok(g.height <= 48)
  assert.match(g.line, /^M[\d.]+,[\d.]+( L[\d.]+,[\d.]+){2}$/)
  assert.equal(g.bars.length, series.length)
  assert.deepEqual(g.stats, { max: 1331.88, min: 1330.1 })
  assert.equal(auctionSeriesText(series), '1331.88 · 1330.10')
  assert.deepEqual(auctionSparkStats(series), { max: 1331.88, min: 1330.1 })
})

test('⑦ 无点 ⇒ `—`（写 0 或空串冒充 ⇒ 必败）', () => {
  assert.equal(auctionSparkGeometry([]), null)
  assert.equal(auctionSparkStats([]), null)
  assert.equal(auctionSeriesText([]), '—')
  // 反例注入：拿 0 顶替 ⇒ 判据必须失败
  assert.notEqual('0.00 · 0.00', auctionSeriesText([]))
  assert.throws(() => assert.equal('0.00 · 0.00', auctionSeriesText([]), '反例'), /反例/, '⚠ 反例（用 0 冒充）必须失败')
})

test('⑤ 曲线无坐标轴文字/网格/浮框，高度 ≤48；抽屉里挂在竞价行下方', () => {
  assert.deepEqual(auctionSparkProblems(sparkSrc), [], `迷你图源码判据必须通过：${JSON.stringify(auctionSparkProblems(sparkSrc))}`)
  assert.ok(drawerSrc.includes("'data-auction-series': '1'"), '抽屉必须有竞价曲线区')
  assert.ok(drawerSrc.includes('AuctionSpark'), '抽屉必须渲染迷你图')
  assert.ok(drawerSrc.includes('auctionSeriesText'), '行尾必须显示当日最高/最低参考价')
  // 反例注入：加一个 text 元素 ⇒ 判据必须非空
  const injected = `${sparkSrc}\nconst bad = React.createElement('text', null, '09:15')\n`
  assert.notDeepEqual(auctionSparkProblems(injected), [], '⚠ 反例（加文字）必须被抓到')
  assert.throws(() => assert.deepEqual(auctionSparkProblems(injected), [], '反例'), /反例/, '⚠ 反例注入必须失败')
})

test('单个点也能画（不崩），非法点被过滤', () => {
  const one = auctionSparkGeometry([{ t: 0, ref: 10, matched: 1 }])
  assert.ok(one !== null && one.bars.length === 1)
  const dirty = auctionSparkGeometry([
    { t: 0, ref: Number.NaN, matched: 1 },
    { t: 10, ref: 10, matched: 0 },
    { t: 20, ref: 11, matched: 5 },
  ])
  assert.equal(dirty?.bars.length, 1)
})
