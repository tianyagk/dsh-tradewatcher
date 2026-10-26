/** 两图坐标系 + 左列紧凑 + 右列自适应（用户 2026-10-26）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { X_TICKS, gridYsOf, yTicksOf } from './marketBlocks.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(HERE, p), 'utf8')

test('① 两图各 ≥3 网格线与 ≥3 个 Y 刻度；空态仍有坐标系（无轴 ⇒ 败）', () => {
  assert.equal(X_TICKS.length, 7)
  assert.equal(X_TICKS[0], '09:30')
  assert.equal(X_TICKS[6], '14:36')
  assert.ok(yTicksOf(0, 100, 4).length >= 3)
  assert.equal(gridYsOf(0, 100, 6, 150, 4).length, 4)
  const page = read('MarketPage.tsx')
  assert.ok(/aria-label': '成交额累计'/.test(page))
  assert.ok(/aria-label': '分钟成交额增减坐标系'/.test(page))
  // 两张图都渲染 grid（`gy${i}`）与 Y 刻度（`yt${i}`）
  assert.equal((page.match(/key: `gy\$\{i\}`/g) ?? []).length >= 2, true, '两图都要画网格线')
  assert.equal((page.match(/key: `yt\$\{i\}`/g) ?? []).length >= 2, true, '两图都要画 Y 刻度')
  // 空态：原因画在图内（text 居中），不再另起一行
  assert.ok(/key: 'why', x: W \/ 2, y: \(TOP \+ BOT\) \/ 2, textAnchor: 'middle'/.test(page), '空态原因必须在图内居中')
})

test('② 左列三卡紧凑：padding 10、gap 12、无 min-height（写死高度 ⇒ 败）', () => {
  const css = read('styles.ts')
  assert.ok(/\.tw-mk-col-l \.tw-mk-card\{padding:10px\}/.test(css))
  assert.ok(/\.tw-mk-grid2\{display:grid;grid-template-columns:1fr 1fr;gap:12px\}/.test(css))
  assert.ok(/\.tw-mk-card\{[^}]*min-height:0/.test(css), '卡片不得有 min-height')
  assert.ok(/\.tw-mk-l\{font-size:12px;color:var\(--tw-muted\);margin-top:0\}/.test(css), '标签行距收紧 2px')
})

test('③ 右列两卡高度自适应（撑满 ⇒ 败）', () => {
  const css = read('styles.ts')
  assert.ok(/\.tw-mk-col-r \.tw-mk-card\{height:auto;min-height:0\}/.test(css))
  assert.ok(/\.tw-mk-col-r \.tw-mk-empty\{max-height:220px\}/.test(css))
  const page = read('MarketPage.tsx')
  assert.ok(page.includes("tw-mk-col tw-mk-col-l") && page.includes("tw-mk-col tw-mk-col-r"))
})
