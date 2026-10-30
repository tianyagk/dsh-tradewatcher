import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  beijingDayOf, dayTableEmpty, dayTableTitle, mergedFillsOf, todayBeijing, todayFillsOf, todayOrdersOf,
} from './prismView.ts'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, './PrismPage.tsx'), 'utf8')

const order = (id: string, day: string, at: number) => ({ id, day, decidedAt: at })
const fill = (id: string, at: number) => ({ id, at })

test('① 挂单：3 昨日 + 2 今日 ⇒ 只显示 2 行；标题 今日 2 笔', () => {
  const orders = [
    order('y1', '2026-10-25', Date.parse('2026-10-25T10:00:00+08:00')),
    order('y2', '2026-10-25', Date.parse('2026-10-25T11:00:00+08:00')),
    order('y3', '2026-10-25', Date.parse('2026-10-25T12:00:00+08:00')),
    order('t1', '2026-10-26', Date.parse('2026-10-26T09:00:00+08:00')),
    order('t2', '2026-10-26', Date.parse('2026-10-26T10:00:00+08:00')),
  ]
  const copy = JSON.parse(JSON.stringify(orders))
  const today = todayOrdersOf(orders, '2026-10-26')
  assert.equal(today.length, 2)
  assert.deepEqual(orders, copy, '过滤不得修改/删除原数组')
  assert.equal(dayTableTitle('orders', today.length), '挂单（今日 2 笔）')
  assert.throws(() => assert.equal(todayOrdersOf(orders, '2026-10-25').length, 2, '注入：显示 5 行'), /注入/)
})

test('② 成交同理：昨日 3 笔不显示，今日 2 笔', () => {
  const fills = [
    fill('y1', Date.parse('2026-10-25T10:00:00+08:00')),
    fill('y2', Date.parse('2026-10-25T11:00:00+08:00')),
    fill('y3', Date.parse('2026-10-25T12:00:00+08:00')),
    fill('t1', Date.parse('2026-10-26T09:00:00+08:00')),
    fill('t2', Date.parse('2026-10-26T10:00:00+08:00')),
  ]
  const today = todayFillsOf(fills, '2026-10-26')
  assert.equal(today.length, 2)
  assert.equal(dayTableTitle('fills', today.length), '成交（今日 2 笔）')
  assert.throws(() => assert.equal(todayFillsOf(fills, '2026-10-25').length, 2, '注入：显示昨日'), /注入/)
})

test('③ 北京时间跨零点：23:59 当天、00:01 次日；按 UTC 日 ⇒ 必败', () => {
  const night = Date.parse('2026-10-25T23:59:00+08:00')
  const morning = Date.parse('2026-10-26T00:01:00+08:00')
  assert.equal(beijingDayOf(night), '2026-10-25')
  assert.equal(beijingDayOf(morning), '2026-10-26')
  assert.equal(todayBeijing(night), '2026-10-25')
  const utcDay = new Date(morning).toISOString().slice(0, 10)
  assert.notEqual(utcDay, beijingDayOf(morning), '按 UTC 日会算成前一天')
  assert.throws(() => assert.equal(utcDay, beijingDayOf(morning), '注入：UTC 日'), /注入/)
})

test('④ 空态固定文案；页面不用「暂无数据/共 N 历史」', () => {
  assert.equal(dayTableEmpty('orders'), '—（今日无挂单）')
  assert.equal(dayTableEmpty('fills'), '—（今日无成交）')
  assert.equal(page.includes('暂无数据'), false)
  assert.equal(/共\s*\d+\s*笔历史/.test(page), false)
  assert.ok(page.includes('dayTableEmpty(\'orders\')') && page.includes('dayTableEmpty(\'fills\')'))
})

test('⑤ 客户端只过滤不删除：无 prism-orders 写入，源数组不变', () => {
  assert.equal(page.includes('prism-orders'), false)
  assert.equal(page.includes('.splice('), false)
  assert.ok(page.includes('todayOrdersOf') && page.includes('todayFillsOf'))
  const src = [order('y', '2026-10-25', 1), order('t', '2026-10-26', 2)]
  todayOrdersOf(src, '2026-10-26')
  assert.equal(src.length, 2)
})

test('26 笔同 bar 同价 ⇒ 成交表合并 1 行，数量/费用合计；磁盘明细不变', () => {
  const at = Date.parse('2026-10-26T11:16:00+08:00')
  const raw = Array.from({ length: 26 }, () => ({
    secid: '1.600000', name: '测试', side: 'buy' as const, price: 0.7, shares: 5062, fee: 8.6, at, source: '1min' as const,
  }))
  const merged = mergedFillsOf(raw)
  assert.equal(merged.length, 1)
  assert.equal(merged[0]?.shares, 26 * 5062)
  assert.equal(merged[0]?.fee, 223.6)
  assert.equal(raw.length, 26, '合并只在渲染层，原始明细不删')
})

/* ── 把最脆弱的「源码含标识符」断言升级为**行为断言**（AUDIT-TESTS-1030）：
 *    原 `page.includes('todayOrdersOf')` 只证明字符串在文件里；改名/换实现都不影响对错。
 *    这里补的是它真正想保证的事：**今日表只显示今天的行，且不许按天删数据**。 */
test('⑥ 【行为】todayOrdersOf：只留当日；无 day 字段时按 decidedAt 的北京日归属（按 UTC 日 ⇒ 败）', () => {
  const rows = [
    { id: 'a', day: '2026-10-25', decidedAt: 0 },
    { id: 'b', day: '2026-10-26', decidedAt: 0 },
    { id: 'c', day: '', decidedAt: Date.parse('2026-10-26T00:30:00+08:00') }, // 北京 10-26 00:30 = UTC 10-25 16:30
    { id: 'd', day: '', decidedAt: Date.parse('2026-10-25T23:30:00+08:00') },
  ]
  const today = todayOrdersOf(rows, '2026-10-26')
  assert.deepEqual(today.map((r) => r.id), ['b', 'c'], 'day 为空时必须用北京时间的 decidedAt 判日（用 UTC 会把 c 漏掉、把 d 算进来）')
  assert.equal(rows.length, 4, '过滤不得改动源数组（客户端只过滤、不删除）')
  assert.deepEqual(todayFillsOf([{ at: Date.parse('2026-10-26T00:30:00+08:00') }, { at: Date.parse('2026-10-25T23:30:00+08:00') }], '2026-10-26').length, 1)
  assert.equal(beijingDayOf(Date.parse('2026-10-26T00:30:00+08:00')), '2026-10-26', '辅助函数口径自证')
  // 反例注入：按 UTC 日切（toISOString().slice(0,10)）⇒ 00:30 北京会被算到前一天
  const utcDay = new Date(Date.parse('2026-10-26T00:30:00+08:00')).toISOString().slice(0, 10)
  assert.equal(utcDay, '2026-10-25', '反例：UTC 切法确实会错一天')
  assert.throws(() => assert.equal(today.map((r) => r.id).length, 1, '反例上：按 UTC 日过滤'), /反例上/, '⚠ 反例注入必须失败')
})
