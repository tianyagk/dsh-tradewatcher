/** 大盘页打磨（市场稿 4 类差异）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(HERE, p), 'utf8')

test('② 页面不含「口径说明：」', () => {
  assert.equal(read('RescuePanel.tsx').includes('口径说明：'), false)
  assert.equal(read('MarketPage.tsx').includes('口径说明：'), false)
})

test('⑥ 四类数据块各有一个「重试」按钮（缺 ⇒ 败）', () => {
  const page = read('MarketPage.tsx')
  assert.ok(page.includes("}, '重试')"), '缺少重试按钮')
  assert.ok(/const \[mkRetry, setMkRetry\]/.test(page), '缺少重试令牌')
  assert.ok(page.includes('setMkRetry((n) => n + 1)'), '按钮必须重新拉取')
})
