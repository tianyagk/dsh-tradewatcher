/**
 * v0.187.0：大盘页只剩「汪汪队跟踪」一张卡（涨跌分布 / 分钟成交额较昨日增减也已下线）。
 * ① 只剩 1 张卡 ② 两个标题 0 处 ③ 汪汪队跟踪仍在 ④ 不再请求 dist=1。均带反例注入。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (f: string): string => readFileSync(join(HERE, f), 'utf8')
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const page = (): string => strip(read('MarketPage.tsx'))

test('① 页面只剩 1 张卡（多于 1 ⇒ 败）', () => {
  const src = page()
  const cards = (src.match(/card\('/g) ?? []).length
  assert.equal(cards, 1, `只允许 1 张卡（实际 ${cards}）`)
  assert.throws(() => assert.equal(cards + 1, 1, '反例上：多一张卡'), /反例上/, '⚠ 反例注入必须失败')
})

test('② 两个标题 0 处（出现 ⇒ 败）', () => {
  const src = page()
  for (const title of ['涨跌分布', '分钟成交额较昨日增减']) {
    assert.equal(src.includes(title), false, `不得再出现「${title}」`)
  }
  assert.throws(() => assert.equal(`${src}\ncard('涨跌分布', '', null)`.includes('涨跌分布'), false, '反例上：标题残留'), /反例上/, '⚠ 反例注入必须失败')
})

test('③ 汪汪队跟踪仍在（删多 ⇒ 败）', () => {
  const src = page()
  assert.equal(src.includes("card('汪汪队跟踪'"), true, '汪汪队跟踪卡必须保留')
  assert.equal(/\bdistCardRender\b/.test(src), false, 'distCardRender 引用必须清零')
  assert.equal(/\btw-mk-single\b/.test(src), false, 'tw-mk-single 必须清零')
  assert.throws(() => assert.equal(src.split('汪汪队跟踪').join('').includes('汪汪队跟踪'), true, '反例上：删多了'), /反例上/, '⚠ 反例注入必须失败')
})

test('④ 不再请求 dist=1（仍请求 ⇒ 败）', () => {
  const src = read('MarketPage.tsx')
  assert.equal(src.includes('dist: true'), false, '不许再请求直方图数据')
  assert.equal(/breadth\(\{\s*dist/.test(src), false, 'breadth 调用不得再带 dist 参数')
  // 宿主路由仍在（只下线界面，不删接口）
  const routes = read('../host/routes.ts')
  assert.ok(routes.includes("/tradewatcher/breadth"), '宿主 /breadth 路由必须保留')
  assert.throws(() => assert.equal(`${src}\napi.breadth({ dist: true })`.includes('dist: true'), false, '反例上：仍请求 dist=1'), /反例上/, '⚠ 反例注入必须失败')
})
