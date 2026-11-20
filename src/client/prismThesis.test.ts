/**
 * v0.211.0：个股「AI 研判」卡 —— 宿主 `holdings[].thesis` → 展示层断言（含反例注入）。
 *
 * 口径：`thesis` 只来自宿主（最新委托理由 / 提到该股的组合研判首句）；
 * 置信度宿主无字段 ⇒ 恒 `—` + title「宿主无置信度字段」；无源 ⇒ `—（该股暂无研判）`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { THESIS_CONF_TITLE, THESIS_NONE, thesisViewOf } from './prismDeskMid.ts'

const PAGE = readFileSync(new URL('./PrismPage.tsx', import.meta.url), 'utf8')
const MID = readFileSync(new URL('./prismDeskMid.ts', import.meta.url), 'utf8')
const CSS = readFileSync(new URL('./styles.ts', import.meta.url), 'utf8')

/** 实测：工商银行 2026-11-20 14:30:26（北京时间） */
const AT = 1_795_156_226_684
const TEXT = '红利端补位第二批，今日+0.44%逆势收红验证对冲价值；与长债共同把低波端补至约9.98%，银行板块暴露仍仅约1.4%'

test('① thesis=null ⇒ `—（该股暂无研判）`，不是含糊的「无研判」', () => {
  const v = thesisViewOf(null)
  assert.equal(v.text, '—（该股暂无研判）')
  assert.equal(v.has, false)
  assert.equal(v.source, null)
  assert.equal(v.at, null)
  assert.equal(v.title, null)
})

test('② thesis=undefined（旧回包缺字段）⇒ 同样按无研判处理，不抛错', () => {
  const v = thesisViewOf(undefined)
  assert.equal(v.text, THESIS_NONE)
  assert.equal(v.has, false)
})

test('③ 有值 ⇒ 正文原样 + 来源「委托理由」+ 北京时间 MM-DD HH:MM', () => {
  const v = thesisViewOf({ text: TEXT, at: AT, kind: 'order' })
  assert.equal(v.text, TEXT)
  assert.equal(v.source, '委托理由')
  assert.equal(v.at, '11-20 14:30')
  assert.equal(v.has, true)
})

test('④ run-note ⇒ 来源标签「本轮组合研判」', () => {
  const v = thesisViewOf({ text: '工商银行低波补位完成，银行板块暴露仍约1.4%。', at: Date.parse('2026-11-20T14:50:26+08:00'), kind: 'run-note' })
  assert.equal(v.source, '本轮组合研判')
  assert.equal(v.at, '11-20 14:50')
})

test('⑤ 置信度恒 `—` 且 title 固定「宿主无置信度字段」（有值 / 无值都一样）', () => {
  for (const src of [null, { text: TEXT, at: AT, kind: 'order' as const }]) {
    const v = thesisViewOf(src)
    assert.equal(v.confidence, '—')
    assert.equal(v.confidenceTitle, THESIS_CONF_TITLE)
    assert.equal(THESIS_CONF_TITLE, '宿主无置信度字段')
    assert.throws(() => assert.equal(v.confidence, '0.68', '反例上：编造置信度'), /反例上/, '⚠ 反例注入必须失败')
  }
})

test('⑥ 长文本不截断：text 与 title 都是全文（折叠只在视觉层）', () => {
  const long = `${TEXT}；同时说明：本段用于验证不会被 slice/substring 截短，DOM 里必须保留完整字符串。`
  const v = thesisViewOf({ text: long, at: AT, kind: 'order' })
  assert.equal(v.text, long)
  assert.equal(v.title, long)
  assert.ok(v.text.length > 60)
})

test('⑦ 空字符串 / 纯空白 ≠ 研判 ⇒ 走无研判分支（不渲染空白卡）', () => {
  assert.equal(thesisViewOf({ text: '', at: AT, kind: 'order' }).has, false)
  assert.equal(thesisViewOf({ text: '   ', at: AT, kind: 'order' }).has, false)
})

test('⑧ 未知 kind ⇒ 正文仍展示，但来源标签为 null（不猜来源）', () => {
  const v = thesisViewOf({ text: TEXT, at: AT, kind: 'whatever' })
  assert.equal(v.has, true)
  assert.equal(v.source, null)
})

test('⑨ 缺 at ⇒ at=null（页面写 `—` + title 原因，不拿 now 冒充）', () => {
  const v = thesisViewOf({ text: TEXT, kind: 'run-note' })
  assert.equal(v.has, true)
  assert.equal(v.at, null)
  assert.match(PAGE, /ai\.at === null \? '宿主未给出该条研判的时刻'/)
})

test('⑩ 页面：AI 卡从 selHold.thesis 取数，不再读 latestRun/verdict', () => {
  assert.match(PAGE, /const ai = thesisViewOf\(selHold\?\.thesis \?\? null\)/)
  assert.ok(!PAGE.includes('aiVerdictOf'), '旧函数必须移除')
  assert.ok(!PAGE.includes('—（无研判）'), '旧含糊文案必须移除')
  assert.ok(!PAGE.includes('latestRun as unknown as'), '不再拿 run 长文冒充个股研判')
})

test('⑪ 页面：渲染正文 + 来源/时间标签 + 置信度 title', () => {
  assert.match(PAGE, /React\.createElement\(FlowTextView, \{ text: ai\.text, label: '个股研判' \}\)/)
  assert.match(PAGE, /'data-role': 'ad-thesis'/)
  assert.match(PAGE, /className: 'side'/)
  assert.match(PAGE, /'data-role': 'ad-thesis-src'/)
  assert.match(PAGE, /ai\.source \?\? '来源未标注'/)
  assert.match(PAGE, /ai\.confidenceTitle/)
  assert.match(PAGE, /title: ai\.confidenceTitle/)
})

test('⑫ FlowTextView：title 永远给全文，展开只切 is-clamp（视觉 ≤3 行）', () => {
  assert.match(PAGE, /className: `v\$\{!open && overflow \? ' is-clamp' : ''\}`, title: text/)
  assert.match(CSS, /\.tw-ad-verdict \.vt \.v\.is-clamp\{[^}]*-webkit-line-clamp:3/)
  assert.match(CSS, /\.tw-ad-verdict \.vt \.v\.is-clamp\{[^}]*overflow:hidden/)
  assert.match(CSS, /\.tw-ad-verdict \.side \.src\{[^}]*font-size:12px/)
})

test('⑬ 反例注入：无研判时若文案写成「—（无研判）」⇒ 必败', () => {
  assert.throws(() => assert.equal(thesisViewOf(null).text, '—（无研判）', '反例上：含糊文案'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑭ 代码里没有 confidence 数值来源（宿主无字段 ⇒ 不得出现 toFixed 置信度）', () => {
  const block = MID.slice(MID.indexOf('export function thesisViewOf'), MID.indexOf('export type DeskFlowKind'))
  assert.ok(block.length > 200, '切片必须命中 thesisViewOf 实现')
  assert.match(block, /confidence: '—'/)
  assert.ok(!block.includes('toFixed'), '置信度不得来自任何计算')
})
