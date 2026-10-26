import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  beijingDayOf, dayTableEmpty, dayTableTitle, todayBeijing, todayFillsOf, todayOrdersOf,
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
