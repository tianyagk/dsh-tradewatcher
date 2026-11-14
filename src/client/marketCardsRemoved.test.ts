/**
 * v0.184.0：左列四卡按用户要求下线（涨跌趋势 / 成交量 / 两融 / 成交额分时）。
 * ① 四处标题不得再出现 ② 三套小格类名不得残留 ③ 两块保留卡必须在 ④ 不得留空容器。均带反例注入。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (f: string): string => readFileSync(join(HERE, f), 'utf8')
/** 去注释再断言（注释里会**提到**被删的标题） */
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const page = (): string => strip(read('MarketPage.tsx')) + '\n' + strip(read('distCardRender.tsx'))

test('① 页面与渲染层不再出现四个卡标题（出现任一 ⇒ 败）', () => {
  const src = page()
  for (const title of ['涨跌趋势', '成交量', '两融', '成交额分时']) {
    for (const kw of ["card('", "seg('"]) {
      assert.equal(src.includes(kw + title + "'"), false, `不得再出现卡标题「${title}」（${kw}）`)
    }
  }
  // 反例注入：把任一标题加回 ⇒ 必败
  const injected = src + "\ncard('两融', '', null)\n"
  assert.throws(() => assert.equal(injected.includes("card('两融'"), false, '反例上：标题残留'), /反例上/, '⚠ 反例注入必须失败')
})

test('② 不含 tw-mk-grid5 / grid4 / grid3 类名（残留 ⇒ 败）', () => {
  const src = page() + '\n' + read('styles.ts')
  for (const cls of ['tw-mk-grid5', 'tw-mk-grid4', 'tw-mk-grid3']) {
    assert.equal(src.includes(cls), false, `类名 ${cls} 必须删干净（标记与样式都不许留）`)
  }
  assert.throws(() => assert.equal(`${src}\n.tw-mk-grid5{display:grid}`.includes('tw-mk-grid5'), false, '反例上：类名残留'), /反例上/, '⚠ 反例注入必须失败')
})

test('③ 「涨跌分布」与「分钟成交额较昨日增减」仍在（删多了 ⇒ 败）', () => {
  const src = page()
  assert.equal(src.includes('涨跌分布'), true, '右列「涨跌分布」必须保留')
  assert.equal(src.includes('分钟成交额较昨日增减'), true, '「分钟成交额较昨日增减」必须保留')
  assert.equal(src.includes("'data-role': 'dist-bj'"), true, '分布卡头「北交所 未接入」标记必须保留')
  const gutted = src.split('涨跌分布').join('')
  assert.throws(() => assert.equal(gutted.includes('涨跌分布'), true, '反例上：删多了'), /反例上/, '⚠ 反例注入必须失败')
})

test('④ 无空容器：单列只有一层、两个 card 都有正文（空 div ⇒ 败）', () => {
  const raw = read('MarketPage.tsx')
  const src = strip(raw)
  assert.equal((src.match(/className: 'tw-mk-col'/g) ?? []).length, 1, '容器只允许一个单列')
  assert.equal((src.match(/card\('/g) ?? []).length, 2, '只允许两张卡（涨跌分布 / 分钟成交额较昨日增减）')
  assert.equal(src.includes('tw-mk-col tw-mk-col-l'), false)
  assert.equal(src.includes('tw-mk-col tw-mk-col-r'), false)
  assert.equal(/React\.createElement\('div', \{\s*\}\)/.test(src), false, '不许留空 props 的空 div')
  // 每张卡的第三个实参（body）都不能是 null
  for (const m of src.matchAll(/card\('([^']+)',/g)) {
    const after = src.slice(m.index ?? 0)
    const call = after.slice(0, after.indexOf('\n        card(') === -1 ? 400 : after.indexOf('\n        card('))
    assert.equal(/\bnull\)/.test(call.slice(-40)), false, `卡「${m[1]}」不许空 body`)
  }
  const withEmpty = `${src}\nReact.createElement('div', { className: 'tw-mk-col' }, null)`
  assert.throws(() => assert.equal((withEmpty.match(/className: 'tw-mk-col'/g) ?? []).length, 1, '反例上：多出空容器'), /反例上/, '⚠ 反例注入必须失败')
})
