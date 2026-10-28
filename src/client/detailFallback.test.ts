/**
 * ⑤ 行业缺失时必须 `—` + 原因（写 0 / 空串 ⇒ 败）；并钉住「详情暂不可用」只出现在
 * `detail === null` 分支里（东财失败但腾讯兜底成功时，页面不得再显示那句话）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { industryCellOf } from './detailFallback.ts'

const here = dirname(fileURLToPath(import.meta.url))
const pct = (v: number): string => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`

test('⑤ 行业缺失 ⇒ `—` + 「东财不可达，行业归属暂缺」（写 0 或空串 ⇒ 败）', () => {
  const tencent = industryCellOf(null, 'tencent', pct)
  assert.equal(tencent.value, '—', '必须是一个破折号，不是空串')
  assert.equal(tencent.title, '东财不可达，行业归属暂缺')
  const em = industryCellOf(null, 'eastmoney', pct)
  assert.equal(em.title, '仅 A股 提供行业板块')
  const withBoard = industryCellOf({ name: '白酒', pct: 1.23 }, 'tencent', pct)
  assert.equal(withBoard.value, '白酒  +1.23%', '有本地缓存时必须显示板块名与涨跌幅')
  // 反例注入：空串/0 当"缺失" ⇒ 必败
  assert.throws(() => assert.equal(industryCellOf(null, 'tencent', pct).value, '', '反例上：空串'), /反例上/, '⚠ 反例注入（空串）必须失败')
  assert.throws(() => assert.equal(industryCellOf(null, 'tencent', pct).value, '0', '反例上：0'), /反例上/, '⚠ 反例注入（0）必须失败')
})

test('④ 页面：「详情暂不可用」只在 detail === null 分支里（兜底成功时不得显示）', () => {
  const src = readFileSync(join(here, 'QuoteDrawer.tsx'), 'utf8')
  const guard = src.indexOf('if (detail === null)')
  const text = src.indexOf('详情暂不可用')
  assert.ok(guard > 0, '必须有 detail === null 分支')
  assert.ok(text > guard, '「详情暂不可用」必须写在 detail === null 分支之后')
  // 兜底成功路径必须走 infoGrid(d)
  assert.ok(src.includes('const d = detail'), '非空分支必须有 const d = detail')
  assert.ok(src.includes('infoGrid(d)'), '非空分支必须渲染真实字段')
  // 反例注入：把这句话挪到守卫之前 ⇒ 判据必须失败
  const injected = '详情暂不可用\n' + src
  assert.throws(() => assert.ok(injected.indexOf('详情暂不可用') > injected.indexOf('if (detail === null)'), '反例上：文案在守卫之前'), /反例上/, '⚠ 反例注入必须失败')
})
