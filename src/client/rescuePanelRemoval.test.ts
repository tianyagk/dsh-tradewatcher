import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TW_CSS } from './styles.ts'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, './RescuePanel.tsx'), 'utf8')

const forbidden = [
  '备用源',
  '评分 26/100',
  '已剔除「超大单强度」因子',
  '阈值来源 自建分位',
  '阈值来源',
]

test('① 备用源面板文字全部删除（加回任一行 ⇒ 败）', () => {
  for (const text of forbidden) {
    assert.equal(page.includes(text), false, `源码残留：${text}`)
    const injected = `${page}\nconst bad = '${text}'`
    assert.throws(() => assert.equal(injected.includes(text), false, `注入：${text}`), /注入/)
  }
  // 渲染入口也必须消失：唯一节点 className + snapshot.summary 都不得再出现
  assert.equal(page.includes('tw-rescue-summary'), false)
  assert.equal(page.includes('snapshot.summary'), false)
  const injected = page.replace('snapshot?.calendarStatus', "React.createElement('div', { className: 'tw-rescue-summary' }, snapshot.summary),\n    snapshot?.calendarStatus")
  assert.notEqual(injected, page)
  assert.throws(() => assert.equal(injected.includes('tw-rescue-summary'), false, '注入：节点'), /注入/)
})

test('② 删后无空容器/边框/占位（只清空文字 ⇒ 败）', () => {
  assert.equal(/\.tw-rescue-summary\{/.test(TW_CSS), false)
  assert.equal(page.includes('React.createElement(\'div\', { className: \'tw-rescue-summary\''), false)
  const injected = page.replace('snapshot?.calendarStatus', "React.createElement('div', { className: 'tw-rescue-summary' }),\n    snapshot?.calendarStatus")
  assert.notEqual(injected, page)
  assert.throws(() => assert.equal(injected.includes('tw-rescue-summary'), false, '注入：空盒'), /注入/)
})

test('③ 标题行与通道卡仍在（连带删掉 ⇒ 败）', () => {
  for (const kept of ['护盘信号', '立即采样', '收起', '设置', '导出', 'tw-rescue-cards', 'tw-rescue-card', '共振']) {
    assert.ok(page.includes(kept), `不得连带删除：${kept}`)
  }
  const injected = page.replaceAll('护盘信号', '已删除')
  assert.notEqual(injected, page)
  assert.equal(injected.includes('护盘信号'), false)
  assert.throws(() => assert.equal(injected.includes('护盘信号'), true, '注入：删标题'), /注入/)
})

test('④ 不靠 min-height 撑空间：相邻块间距仍为既有 6px', () => {
  const root = /\.tw-rescue\{([^}]*)\}/.exec(TW_CSS)?.[1] ?? ''
  assert.match(root, /gap:6px/)
  assert.doesNotMatch(root, /min-height/)
  const injected = TW_CSS.replace('.tw-rescue{display:flex;flex-direction:column;gap:6px}', '.tw-rescue{display:flex;flex-direction:column;gap:6px;min-height:80px}')
  assert.notEqual(injected, TW_CSS)
  const injectedRoot = /\.tw-rescue\{([^}]*)\}/.exec(injected)?.[1] ?? ''
  assert.match(injectedRoot, /min-height/)
  assert.throws(() => assert.doesNotMatch(injectedRoot, /min-height/), /min-height/)
})
