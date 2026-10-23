import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TW_CSS } from './styles.ts'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, './PrismPage.tsx'), 'utf8')
const leftStart = page.indexOf('tw-prism-left')
const leftEnd = page.indexOf('tw-prism-sep', leftStart)
const left = page.slice(leftStart, leftEnd)

const orderOk = (src: string): boolean => {
  const seg = src.indexOf('tw-prism-seg')
  const cards = src.indexOf('tw-prism-cards')
  return seg >= 0 && cards >= 0 && seg < cards
}

test('分段在左栏第一块、四格之前（放回四格之后 ⇒ 败）', () => {
  assert.equal(orderOk(left), true)
  assert.match(TW_CSS, /\.tw-prism-left>\.tw-prism-seg\{order:1\}/)
  assert.match(TW_CSS, /\.tw-prism-left>\.tw-prism-cards\{order:2\}/)
  assert.match(TW_CSS, /\.tw-prism-left>\.tw-prism-toolbar\{order:3\}/)
  const wrong = '<div class="tw-prism-cards"></div><div class="tw-prism-seg"></div>'
  assert.equal(orderOk(wrong), false)
  assert.throws(() => assert.equal(orderOk(wrong), true, '注入：放回四格之后'), /注入/)
})

test('四格数值 28px 且不低于展示级 15px（34px ⇒ 败）', () => {
  const block = /\.tw-prism-v\{([^}]*)\}/.exec(TW_CSS)?.[1] ?? ''
  const px = Number(/font:600 (\d+)px/.exec(block)?.[1] ?? NaN)
  assert.equal(px, 28)
  assert.ok(px >= 15, `展示级字号应 ≥15（实得 ${px}）`)
  const injected = TW_CSS.replace('font:600 28px', 'font:600 34px')
  assert.notEqual(injected, TW_CSS)
  assert.throws(() => assert.equal(/font:600 (\d+)px/.exec(injected)?.[1], '28', '注入：34px'), /注入/)
})

const tableStart = page.indexOf('<table className="tw-prism-table">')
const tableEnd = page.indexOf('</table>', tableStart)
const table = page.slice(tableStart, tableEnd)
const headers = [...table.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) => m[1]?.replace(/<[^>]+>/g, '') ?? '')
const rowStart = table.indexOf('<tr key={p.secid}>')
const rowEnd = table.indexOf('</tr>', rowStart)
const row = table.slice(rowStart, rowEnd)

test('持仓表代码/名称相邻，8 列表头与 8 格数据一致（合并/少一格 ⇒ 败）', () => {
  assert.deepEqual(headers, ['代码', '名称', '数量', '摊薄成本', '现价', '市值', '仓位占比', '浮盈'])
  assert.equal((row.match(/<td\b/g) ?? []).length, headers.length)
  assert.ok(row.includes('tw-prism-code tw-prism-mono') && row.includes('tw-prism-name'))
  assert.match(TW_CSS, /\.tw-prism-name\{[^}]*text-overflow:ellipsis/)
  const merged = table.replace('<th>名称</th>', '')
  assert.notEqual(merged, table)
  assert.throws(() => assert.deepEqual([...merged.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) => m[1]), headers, '注入：合并列'), /合并列/)
  const dropped = row.replace(/<td className="tw-prism-name">[^<]*<\/td>/, '')
  assert.notEqual(dropped, row)
  assert.throws(() => assert.equal((dropped.match(/<td\b/g) ?? []).length, headers.length, '注入：少一格'), /少一格/)
})
