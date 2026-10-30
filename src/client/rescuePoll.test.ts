/**
 * P1：护盘轮询间隔必须对缺失/坏值收敛（`Math.max(10, undefined)` ⇒ NaN ⇒ 0ms 轮询）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { rescuePollSec } from './rescueView.ts'

const SRC = readFileSync(new URL('./RescuePanel.tsx', import.meta.url), 'utf8')

test('① 缺失/坏值一律 60s（落 NaN 或 0 ⇒ 必败）', () => {
  for (const bad of [undefined, null, Number.NaN, 'abc', {}, Number.POSITIVE_INFINITY]) {
    const sec = rescuePollSec(bad as unknown, true)
    assert.equal(sec, 60, `${String(bad)} 必须回落 60s（实得 ${sec}）`)
    assert.ok(Number.isFinite(sec) && sec > 0, '不许出现 NaN / 0')
  }
  // 反例注入：直接 Math.max(10, undefined) 必须判失败
  const injected = Math.max(10, undefined as unknown as number)
  assert.ok(Number.isNaN(injected), '注入旧写法必须得到 NaN ⇒ 判失败')
  assert.notEqual(injected, 60)
})

test('② 合法值收敛到 [30, 600]', () => {
  assert.equal(rescuePollSec(5, true), 30)
  assert.equal(rescuePollSec(9000, true), 600)
  assert.equal(rescuePollSec(10, true), 30)
  assert.equal(rescuePollSec(120, true), 120)
  assert.equal(rescuePollSec(600, true), 600)
  // 非交易时段固定 60s
  assert.equal(rescuePollSec(10, false), 60)
})

test('③ 源码不得再用 Math.max(10, …)（出现 ⇒ 必败）', () => {
  assert.doesNotMatch(SRC, /Math\.max\(10,/, '旧写法必须删除')
  assert.match(SRC, /rescuePollSec\(snapshot\?\.activeIntervalSec, snapshot\?\.trading === true\)/, '必须走收敛函数')
  // 反例注入
  const injected = SRC.replace('rescuePollSec(snapshot?.activeIntervalSec, snapshot?.trading === true)', 'Math.max(10, snapshot.activeIntervalSec)')
  assert.notEqual(injected, SRC)
  assert.match(injected, /Math\.max\(10,/, '注入旧写法必须判失败')
})
