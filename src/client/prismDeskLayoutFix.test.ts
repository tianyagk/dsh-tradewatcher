/**
 * v0.206.x 三个 UI/功能问题的回归断言：
 *   ① 左栏（人类列）可纵向滚动，持仓列表吃满剩余高度、footer 常驻；
 *   ② 右栏「持仓 / 挂单」两个 tab 有间距与点击区，374px 栏宽不换行；
 *   ③ 底条「决策周期」是 300/600/900/1200 的 <select>，默认 600s（仅展示，不改触发时点）。
 *
 * 只做静态对拍（仓库无 React 运行时）：CSS 解析数字 + 页面源码字符串；
 * 不写任何"看起来像"的演示值。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { intervalSecOf, statusFactsOf, INTERVAL_OPTIONS } from './prismDeskSide.ts'
import { PRISM_DEFAULT_INTERVAL_SEC } from '../shared/prism.ts'

const PAGE = readFileSync(new URL('./PrismPage.tsx', import.meta.url), 'utf8')
const CSS = readFileSync(new URL('./styles.ts', import.meta.url), 'utf8')

const blockOf = (selector: string): string => {
  const at = CSS.indexOf(`${selector}{`)
  assert.ok(at >= 0, `找不到样式块 ${selector}`)
  const end = CSS.indexOf('}', at)
  return CSS.slice(at, end + 1)
}

test('① 左栏：列允许纵向滚动，持仓卡吃满剩余高度，列表内部滚动、footer 常驻', () => {
  const col = blockOf('.tw-ad-col')
  assert.match(col, /overflow-y:auto/, '列必须可纵向滚动（overflow-y:auto）')
  assert.ok(!/overflow:hidden/.test(col), '不得再用 overflow:hidden 裁掉持仓卡底部')
  const card = blockOf('.tw-ad-pos-card')
  assert.match(card, /flex:1 1 auto/)
  assert.match(card, /min-height:0/)
  const list = blockOf('.tw-ad-pos-list')
  assert.match(list, /flex:1 1 auto/)
  assert.match(list, /min-height:0/)
  assert.match(list, /overflow:auto/)
  assert.ok(!/max-height:46vh/.test(list), '桌面端不得再用 46vh 死高（8 行在 1700×1200 要能看到）')
  const foot = blockOf('.tw-ad-pos-foot')
  assert.match(foot, /flex:0 0 auto/, 'footer 不得被列表挤掉')
  // footer 在 JSX 里位于 posList 之后（同级），不在滚动容器内部
  const listAt = PAGE.indexOf('posList,')
  const footAt = PAGE.indexOf("'data-role': 'ad-pos-foot'")
  assert.ok(listAt > 0 && footAt > listAt, '「＋ 添加持仓 / 浮盈合计」必须在列表之后同级渲染')
  assert.match(PAGE, /className: 'tw-ad-card tw-ad-pos-card'/)
})

test('② 右栏 tab：gap ≥6px、每 tab padding ≥4px 10px 且不换行，374px 栏宽放得下', () => {
  const tabs = blockOf('.tw-ad-ptabs')
  const gap = Number(/gap:(\d+)px/.exec(tabs)?.[1])
  assert.ok(gap >= 6, `tab gap 必须 ≥6px（实际 ${gap}px）`)
  assert.match(tabs, /flex-wrap:nowrap/)
  const tab = blockOf('.tw-ad-pt')
  const pad = /padding:(\d+)px (\d+)px/.exec(tab)
  assert.ok(pad !== null, 'tab 必须有 padding')
  assert.ok(Number(pad[1]) >= 4 && Number(pad[2]) >= 10, `tab padding 必须 ≥4px 10px（实际 ${pad[0]}）`)
  const minW = Number(/min-width:(\d+)px/.exec(tab)?.[1])
  assert.ok(minW >= 64, `tab 最小宽度必须存在且合理（实际 ${minW}px）`)
  assert.match(tab, /white-space:nowrap/)
  assert.match(blockOf('.tw-ad-pt.on'), /inset 0 -2px 0 var\(--tw-accent\)/, '选中态必须有底线（不只靠颜色）')
  // 374px 栏宽：卡片左右各 1px 边框 + head 左右各 10px 内边距
  const inner = 374 - 2 - 20
  assert.ok(minW * 2 + gap + 2 * 2 + 2 <= inner, `两个 tab + gap 必须 ≤ ${inner}px（tab ${minW}×2 + gap ${gap}）`)
})

test('③ intervalSec 默认 600：缺失 / 非法值一律回 600，合法值原样返回', () => {
  assert.equal(PRISM_DEFAULT_INTERVAL_SEC, 600)
  assert.deepEqual([...INTERVAL_OPTIONS], [300, 600, 900, 1200])
  assert.equal(intervalSecOf(null), 600, '未保存（无 settings）⇒ 600s')
  assert.equal(intervalSecOf({}), 600, '旧宿主无 intervalSec ⇒ 600s')
  assert.equal(intervalSecOf({ intervalSec: undefined }), 600)
  assert.equal(intervalSecOf({ intervalSec: 700 }), 600, '非法值不得透传')
  assert.equal(intervalSecOf({ intervalSec: 600.5 }), 600)
  for (const s of INTERVAL_OPTIONS) assert.equal(intervalSecOf({ intervalSec: s }), s)
})

test('④ 底条 story：传 intervalSec 显示 600s；不传仍保持旧的 times 时点列表（兼容）', () => {
  const base = {
    feed: null, model: null, modelProvider: null, temperature: null,
    times: ['09:35', '11:20', '13:10', '14:40'], constraintVersion: null, blockedToday: null,
  }
  assert.equal(statusFactsOf(base)[3].value, '09:35 · 11:20 · 13:10 · 14:40', '旧路径不变')
  assert.equal(statusFactsOf({ ...base, intervalSec: 600 })[3].value, '600s')
  assert.equal(statusFactsOf({ ...base, intervalSec: 1200 })[3].value, '1200s')
  assert.equal(statusFactsOf({ ...base, intervalSec: 700 })[3].value, '600s', '非法回包值不得回显成 700s')
  assert.match(statusFactsOf({ ...base, intervalSec: 600 })[3].title ?? '', /仅展示/)
})

test('⑤ 页面：底条渲染 <select>（300/600/900/1200），默认 600，修改后提交并刷新', () => {
  assert.match(PAGE, /'data-role': 'ad-interval'/)
  assert.match(PAGE, /React\.createElement\('select'/)
  assert.match(PAGE, /INTERVAL_OPTIONS\.map/)
  assert.match(PAGE, /\$\{s\}s/)
  assert.match(PAGE, /const \[intervalSec, setIntervalSec\] = React\.useState<number>\(PRISM_DEFAULT_INTERVAL_SEC\)/)
  assert.match(PAGE, /api\.prismSetInterval\(next\)/)
  assert.match(PAGE, /if \(r\.ok\) \{ load\(\); return \}/, '保存成功后必须重新拉回包')
  assert.match(CSS, /\.tw-ad-sb-select\{[^}]*height:22px/)
})
