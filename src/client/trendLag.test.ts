/**
 * 分时**滞后**的界面断言（AUDIT-INTL-MINUTE ①）：`122.XAU` 的实时价来自新浪 `hf_XAU`（当刻），
 * 而分钟线停在很久以前时，口径行必须自曝 `数据滞后 X 小时（分钟源 / 报价源 / 原因）`，
 * **不得**只写「截至 10-21 14:08」让人读成当日分时。
 *
 * 判据在宿主（`TREND_LAG_WARN_MINUTES` + 市场时段）；这里只锁**渲染**与**接线**两件事。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trendLagNote } from './chartNote.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

test('① 有 lagMinutes ⇒ 口径行出现「数据滞后 X 小时」+ 分钟源 + 报价源 + 原因（不标 ⇒ 必败）', () => {
  const text = trendLagNote(
    { lagMinutes: 868, lagReason: '上游此刻没有更新的分钟线（本次取数成功）', source: 'sina-global-min' },
    'sina',
  )
  assert.ok(text.includes('数据滞后'), `必须出现「数据滞后」（实际：${text}）`)
  assert.ok(text.includes('14.5 小时'), `868 分钟要写成 14.5 小时（实际：${text}）`)
  assert.ok(text.includes('分钟源：新浪全球期货分钟'), '必须标分钟源')
  assert.ok(text.includes('报价源：新浪'), '实时价与分时不同来源时必须同时标出（同一提供方也要写清）')
  assert.ok(text.includes('原因：上游此刻没有更新的分钟线'), '必须给原因')
  // 反例注入：旧口径行（只有「截至 …」）⇒ 判据必败
  const legacy = '分时 · 不复权（分时序列无除权概念） · 截至 10-21 14:08'
  assert.throws(
    () => assert.ok(legacy.includes('数据滞后'), '反例上：旧口径行不含「数据滞后」'),
    /反例上/,
    '⚠ 反例注入（旧口径行）必须失败',
  )
})

test('①b 不滞后 ⇒ 一个字都不加；阈值边界由宿主给（客户端不自己算）', () => {
  assert.equal(trendLagNote({ source: 'sina-global-min' }, 'sina'), '')
  assert.equal(trendLagNote({ lagMinutes: 0 }, 'sina'), '')
  assert.equal(trendLagNote({ lagMinutes: undefined }, 'sina'), '')
  // 反例注入：无条件渲染 ⇒ 空输入下必败
  assert.throws(
    () => assert.equal(trendLagNote({ lagMinutes: 0 }), ' · 数据滞后 0 小时', '反例上：0 分钟不该渲染'),
    /反例上/,
    '⚠ 反例注入（无条件渲染）必须失败',
  )
})

test('①c 分钟数/小时数格式：<60 分钟写"分钟"，≥60 写小时并保留一位小数', () => {
  assert.ok(trendLagNote({ lagMinutes: 45 })?.includes('45 分钟'))
  assert.ok(trendLagNote({ lagMinutes: 60 })?.includes('1 小时'))
  assert.ok(trendLagNote({ lagMinutes: 90 })?.includes('1.5 小时'))
  assert.ok(trendLagNote({ lagMinutes: 300 })?.includes('5 小时'))
  // 缺 source ⇒ 不编名字，用 — 占位
  assert.ok(trendLagNote({ lagMinutes: 45 })?.includes('分钟源：—'))
})

test('①d 接线：抽屉把 lag 段接进分时口径行，并由宿主组件传入实时价来源（删掉 ⇒ 必败）', () => {
  const drawer = readFileSync(join(HERE, 'QuoteDrawer.tsx'), 'utf8')
  const index = readFileSync(join(HERE, 'index.tsx'), 'utf8')
  const hasNote = /return base \+ trendLagNote\(t, props\.quoteSource\)/.test(drawer)
  const hasProp = /quoteSource: engine\.quotes\[detail\.secid\]\?\.source \?\? null/.test(index)
  assert.equal(hasNote, true, '口径行必须把 trendLagNote 拼在「截至 …」之后（同一行，不新增第二行）')
  assert.equal(hasProp, true, '宿主必须把实时价来源传给抽屉（否则无法标"报价源"）')
  // 反例注入：把 lag 段从口径行里删掉（旧写法）⇒ 判据必败
  const legacy = drawer.replace(' + trendLagNote(t, props.quoteSource)', '')
  assert.throws(
    () => assert.equal(/trendLagNote\(t, props\.quoteSource\)/.test(legacy), true, '反例上：已删掉'),
    /反例上/,
    '⚠ 反例注入（删掉 lag 段）必须失败',
  )
})
