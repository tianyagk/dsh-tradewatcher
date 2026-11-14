/** 两图坐标系 + 左列紧凑 + 右列自适应（用户 2026-10-26）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(HERE, p), 'utf8')

test('③ 单列铺满：`.tw-mk-single` 一列，旧的左右列类已删（残留 ⇒ 败）', () => {
  const css = read('styles.ts')
  assert.ok(/\.tw-mk-single\{display:grid;grid-template-columns:1fr;gap:12px\}/.test(css), '必须单列铺满')
  assert.equal(/\.tw-mk-col-[lr]/.test(css), false, '左右列专属样式必须删干净')
  const page = read('MarketPage.tsx')
  assert.equal(page.includes('tw-mk-col tw-mk-col-l'), false)
  assert.equal(page.includes('tw-mk-col tw-mk-col-r'), false)
})
