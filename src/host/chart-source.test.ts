/**
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detailMissingReason,
  klineCacheFileNames,
  klineMissingReason,
  noteUpstreamFailure,
  trendMissingReason,
  upstreamFailedRecently,
} from './em.ts'

test('分时缺失原因：东财不可达 + 无腾讯兜底 ⇒ transient（等东财恢复），不是 no-source', () => {
  const xau = trendMissingReason('122.XAU', { emDown: true })
  assert.equal(xau.what, '分时')
  assert.equal(xau.why, 'transient', '东财被限流时不能说"该标的没有分时"——那会让用户白白放弃等待')
  assert.ok(xau.note.includes('东财'), `说明里必须写清等待对象（实际：${xau.note}）`)
  assert.ok(xau.note.includes('腾讯'), '要说明为什么没有兜底源')
  assert.ok(!xau.note.includes('重试无用'), 'transient 不得说"重试无用"（那是反向指引）')
})

test('分时缺失原因：东财可达但没有该标的的数据 ⇒ no-source（重试无用）', () => {
  const r = trendMissingReason('999.NOPE', { emDown: false })
  assert.equal(r.why, 'no-source')
  assert.ok(r.note.includes('重试无用'))
  // A股（沪/深）有腾讯分钟线兜底，说明里的措辞要区分开
  const cn = trendMissingReason('1.600519', { emDown: true })
  assert.equal(cn.why, 'transient')
  assert.ok(cn.note.includes('腾讯分钟线'), `有兜底源的标的要提到兜底源（实际：${cn.note}）`)
})

test('日K / 详情缺失原因：同一口径，且点明该标的有哪些源', () => {
  // 商品/国际指数没有腾讯 K 线兜底（见 tencentSymbol 的覆盖）—— 说明里必须点出来
  const transient = klineMissingReason('101.HG00Y', 101, { emDown: true })
  assert.equal(transient.what, '日K')
  assert.equal(transient.why, 'transient')
  assert.ok(transient.note.includes('东财'))
  assert.ok(transient.note.includes('腾讯'), `要说明为什么没有兜底源（实际：${transient.note}）`)
  // A股有腾讯 K 线兜底，措辞要区分开
  const cn = klineMissingReason('1.600519', 101, { emDown: true })
  assert.equal(cn.why, 'transient')
  assert.ok(!cn.note.includes('不在腾讯的 K 线覆盖内'), 'A股在腾讯覆盖内，不能写成"没有兜底"')
  const noSource = klineMissingReason('101.HG00Y', 102, { emDown: false })
  assert.equal(noSource.what, '周K')
  assert.equal(noSource.why, 'no-source')
  const d = detailMissingReason({ emDown: false })
  assert.equal(d.what, '详情')
  assert.equal(d.why, 'no-source')
})

test('归因靠"本链路实际失败过"记账：不注入时也能判出 transient（而不是猜 no-source）', () => {
  // 之前只看"东财整体是否不可用"，而 trend/kline 的失败被吞在函数内部、熔断阈值又没到
  // ⇒ 明明上游挂了却判成"结构性缺失/重试无用"，方向完全错。现在由发起请求那层记账。
  assert.equal(upstreamFailedRecently('kline'), false)
  noteUpstreamFailure('kline')
  assert.equal(upstreamFailedRecently('kline'), true)
  const r = klineMissingReason('101.HG00Y', 101)
  assert.equal(r.why, 'transient', '刚失败过 ⇒ 必须判 transient（等上游恢复）')
  assert.ok(!r.note.includes('重试无用'))
  // 记账按链路隔离：trend 不受 kline 的记账影响
  assert.equal(upstreamFailedRecently('trend'), false)
})

test('K 线缓存文件名：fqt=0 才兜底复用老命名 <secid>_<klt>.json', () => {
  // 指数/期货被 normalizeFq 归一为 0 ⇒ 命中的正是老文件（100.HSI 实机确认命中）
  assert.deepEqual(klineCacheFileNames('100.HSI', 101, 0), ['100.HSI_101_0.json', '100.HSI_101.json'])
  assert.deepEqual(klineCacheFileNames('101.HG00Y', 101, 0), ['101.HG00Y_101_0.json', '101.HG00Y_101.json'])
  // 前复权/后复权是另一套价格序列，绝不能吃不复权缓存（会造成图上无解释的跳空）
  assert.deepEqual(klineCacheFileNames('1.600519', 101, 1), ['1.600519_101_1.json'])
  assert.deepEqual(klineCacheFileNames('1.600519', 102, 2), ['1.600519_102_2.json'])
})
