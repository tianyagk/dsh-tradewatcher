/**
 * 大盘页 V1 的结构与口径断言（market-v1.html A 单列）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DIST_BUCKETS, MINUTE_BARS, breadthCellsOf, minuteDeltaOf, missingCellText } from './marketBlocks.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(HERE, p), 'utf8')
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

test('① 护盘无展开/缩回控件且全部区块常驻（出现折叠 ⇒ 败）', () => {
  const src = strip(read('RescuePanel.tsx'))
  assert.equal(src.includes('收起'), false, '仍有「收起」控件')
  assert.equal(src.includes('展开'), false, '仍有「展开」控件')
  assert.equal(/const expanded = true/.test(src), true, 'expanded 必须恒 true')
  for (const marker of ['tw-rescue-cards', 'tw-rescue-split', 'tw-sub-h']) assert.equal(src.includes(marker), true, `缺少常驻区块 ${marker}`)
  // 反例注入：改回条件展开 ⇒ 必败
  const legacy = src.replace('const expanded = true', 'const expanded = level >= 2')
  assert.throws(() => assert.equal(/const expanded = true/.test(legacy), true, '反例上：条件展开'), /反例上/, '⚠ 反例注入必须失败')
})

test('② 六张 ETF 卡同一容器 6 等分（<1100 三列 / <700 两列）', () => {
  const css = read('styles.ts')
  assert.equal(/\.tw-rescue-cards\{display:grid;grid-template-columns:repeat\(6,minmax\(0,1fr\)\);gap:6px\}/.test(css), true, '六卡必须同一容器 6 等分')
  assert.equal(/@media \(max-width:1100px\)\{\.tw-rescue-cards\{grid-template-columns:repeat\(3/.test(css), true, '<1100 三列')
  assert.equal(/@media \(max-width:700px\)\{\.tw-rescue-cards\{grid-template-columns:repeat\(2/.test(css), true, '<700 两列')
  const panel = strip(read('RescuePanel.tsx'))
  assert.equal(/className: 'tw-rescue-cards'/.test(panel), true, '六卡容器类缺失')
  // 反例注入：auto-fit（会分两行）⇒ 必败
  const legacy = css.replaceAll('repeat(6,minmax(0,1fr))', 'repeat(auto-fit,minmax(232px,1fr))')
  assert.throws(() => assert.equal(/repeat\(6,minmax\(0,1fr\)\)/.test(legacy), true, '反例上：分两行'), /反例上/, '⚠ 反例注入必须失败')
})

test('③ 因子明细与分时量能左右并排（上下堆叠 ⇒ 败）', () => {
  const css = read('styles.ts')
  assert.equal(/\.tw-rescue-split\{display:grid;grid-template-columns:1fr 1fr/.test(css), true, '左右并排容器缺失')
  const panel = strip(read('RescuePanel.tsx'))
  assert.equal(/className: 'tw-rescue-split'/.test(panel), true, '并排容器未使用')
})

test('④ 小格 22px / padding 8 / 圆角 8（改回 28/12/10 ⇒ 败）', () => {
  const css = read('styles.ts')
  assert.equal(/\.tw-mk-v\{font-size:22px/.test(css), true, '数值字号必须 22px')
  assert.equal(/\.tw-mk-cell\{padding:8px;border-radius:8px/.test(css), true, '小格 padding 8 / 圆角 8')
  assert.equal(/\.tw-mk-card\{[^}]*border-radius:10px[^}]*padding:12px/.test(css), true, '卡片圆角 10 / padding 12')
  assert.equal(/\.tw-mk-bar\{width:3px/.test(css), true, '卡头 3px 主色竖条')
})

test('⑤ 分钟柱数 = 240（48 根 ⇒ 败）', () => {
  assert.equal(MINUTE_BARS, 240)
  const page = read('MarketPage.tsx')
  assert.equal(page.includes('MINUTE_BARS'), true, '页面必须用 240 常量')
  const flat = Array.from({ length: 240 }, () => ({ amount: 1 }))
  assert.equal(minuteDeltaOf(flat, flat).bars?.length, 240)
  const short = Array.from({ length: 48 }, () => ({ amount: 1 }))
  assert.equal(minuteDeltaOf(short, short).bars, null, '48 根必须判为不足（不画 48 根假柱）')
})

test('⑥ 涨跌分布 11 档且柱顶有家数（缺档 ⇒ 败）', () => {
  assert.equal(DIST_BUCKETS, 11)
  const page = read('MarketPage.tsx')
  assert.equal(page.includes("repeat(11,1fr)") || read('styles.ts').includes('repeat(11,1fr)'), true, '11 列布局缺失')
  assert.equal(page.includes('tw-mk-dist-n'), true, '柱顶家数缺失')
  assert.equal(/distCounts\.length !== DIST_BUCKETS/.test(page), true, '档数不符必须走缺数据分支')
})

test('⑦ 缺数据格显示 —（原因）且不含 0.00（0 占位 ⇒ 败）', () => {
  assert.equal(missingCellText('无昨日快照'), '—（无昨日快照）')
  assert.equal(missingCellText(null), '—（未取到）')
  assert.equal(missingCellText('x').includes('0.00'), false)
  const cells = breadthCellsOf({ up: 100, even: 20, down: 80, limitUp: null, limitDown: null })
  assert.equal(cells[3].value, null, '缺值必须是 null（不是 0）')
  assert.equal(cells[0].pct, 50)
})

test('⑧ 页面不含 ⚠ 与免责文案', () => {
  for (const f of ['MarketPage.tsx', 'marketBlocks.ts']) {
    const src = strip(read(f))
    assert.equal(src.includes('⚠'), false, `${f} 含 ⚠`)
    for (const word of ['免责', '风险提示', '仅供参考', '不构成投资建议']) assert.equal(src.includes(word), false, `${f} 含「${word}」`)
  }
})
