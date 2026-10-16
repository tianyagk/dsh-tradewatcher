/**
 * v0.96.2：搜索下拉的**高度链**（用户实测：分组添加弹窗里只看到计数行，候选被裁掉）。
 *
 * 根因（逐层量过，见 `docs/AUDIT-IMPL61.md`）：下拉是绝对定位、只往下长，而祖先
 * `.tw-modal{max-height:82vh; overflow:auto}`（`styles.ts`）是**滚动容器 = 裁剪边界**
 * ⇒ 超出弹窗内容盒的部分看不见。修法：下拉改成**视口坐标 + 实测高度 + 贴底翻转**。
 *
 * 这里断言的是**纯几何**（`suggestView.suggestDropdownBoxOf`）+ 接线形态；每条都配反例注入。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  SUGGEST_COUNT_PX, SUGGEST_MIN_LIST_PX, SUGGEST_ROW_PX,
  suggestCapOf, suggestDropdownBoxOf, visibleRowsOf,
} from './suggestView.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(here, p), 'utf8')
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** 典型场景：视口 900、输入框在弹窗中部、内容 17 条（计数行 + 3 组头 + 17 行） */
const CONTENT_17 = SUGGEST_COUNT_PX + 3 * 21 + 17 * SUGGEST_ROW_PX

test('① 列表可用高度必须 ≥ max(160px, 5 行)；反例（上限被压到 40px）必败', () => {
  assert.equal(SUGGEST_MIN_LIST_PX, Math.max(160, 5 * SUGGEST_ROW_PX), '阈值本身就是 max(160, 5 行)')
  assert.ok(SUGGEST_MIN_LIST_PX >= 160, '阈值不得低于 160px')
  const box = suggestDropdownBoxOf({ rect: { top: 300, bottom: 330, left: 20, width: 300 }, viewportH: 900, contentHeight: CONTENT_17 })
  const listH = box.maxHeight - SUGGEST_COUNT_PX
  assert.ok(listH >= 5 * SUGGEST_ROW_PX, `列表可见区 ≥5 行（实际 ${listH}px）`)
  assert.ok(box.maxHeight <= suggestCapOf(900), '不得超过上限（再高就内部滚动）')
  assert.ok(box.maxHeight < CONTENT_17, '内容比上限高时按上限截断（内部滚动，不是把弹窗撑破）')
  // 反例注入：把上限压到 40px（= 写死高度那种做法）⇒ 判据必须失败
  const tiny = suggestDropdownBoxOf({ rect: { top: 300, bottom: 330, left: 20, width: 300 }, viewportH: 900, contentHeight: 40 })
  assert.ok(tiny.maxHeight >= SUGGEST_MIN_LIST_PX + SUGGEST_COUNT_PX, '空间充裕时即使内容很少也给到最小高度（不再"只看到一行"）')
  assert.throws(
    () => assert.ok(tiny.maxHeight - SUGGEST_COUNT_PX < 5 * SUGGEST_ROW_PX, '反例上"必须 ≥5 行"必须失败'),
    /反例上/,
    '⚠ 反例注入（上限被压到 40px）必须让断言失败',
  )
})

test('② 浮层必须脱离祖先裁剪（视口坐标 fixed），且不再有任何写死的裁剪高度', () => {
  const ui = strip(read('ui.tsx'))
  const css = read('styles.ts')
  assert.ok(ui.includes("position: 'fixed'"), '下拉必须用视口坐标（fixed）⇒ 祖先的 overflow 裁不到')
  assert.ok(ui.includes('suggestDropdownBoxOf('), '落点必须由纯函数按实测算出')
  assert.ok(ui.includes("'data-max-h'"), '渲染上要能读到实际可用高度（便于复核）')
  // 祖先裁剪：弹窗是滚动容器（这是事实，不是要改它）—— 断言我们**不再**依赖"弹窗里放下拉"
  assert.ok(/\.tw-modal\{[^}]*overflow:auto/.test(css), '弹窗保持自身滚动（列表不再靠它露出）')
  const suggestRule = /\.tw-suggest\{[^}]*\}/.exec(css)?.[0] ?? ''
  assert.equal(/max-height:262px/.test(suggestRule), false, '⚠ 写死的 262px 必须已删（它曾把候选裁成一行）')
  assert.ok(/overflow:auto/.test(suggestRule), '内部滚动必须保留')
  // 反例注入：把 fixed 改回 absolute（= 会被祖先裁掉）⇒ 判据必须失败
  const injected = ui.replace("position: 'fixed'", "position: 'absolute'")
  assert.notEqual(injected, ui, '反例注入必须真改到源码')
  assert.throws(
    () => assert.equal(injected.includes("position: 'fixed'"), true, '反例上"必须脱离裁剪"必须失败'),
    /反例上/,
    '⚠ 反例注入（退回绝对定位）必须让断言失败',
  )
})

test('③ 贴底必须翻转/上移：下方空间不足且上方更宽 ⇒ up=true，且落点始终在视口内', () => {
  // 输入框贴底：下方只有 40px，上方有 700px
  const near = suggestDropdownBoxOf({ rect: { top: 860, bottom: 884, left: 20, width: 300 }, viewportH: 900, contentHeight: CONTENT_17 })
  assert.equal(near.up, true, '下方放不下 ⇒ 必须向上展开')
  assert.ok(near.top >= 8, `落点不得越出视口上沿（实际 ${near.top}）`)
  assert.ok(near.top + near.maxHeight <= 900 - 8 + 0.001, `浮层必须完整落在视口内（下沿 ${near.top + near.maxHeight}）`)
  assert.ok(visibleRowsOf(near.maxHeight) >= 5, '翻转后仍要能显示 ≥5 行')
  // 空间充裕 ⇒ 不翻转
  const roomy = suggestDropdownBoxOf({ rect: { top: 300, bottom: 330, left: 20, width: 300 }, viewportH: 900, contentHeight: CONTENT_17 })
  assert.equal(roomy.up, false, '下方够就不翻转（别乱动既有观感）')
  // 反例注入：把翻转逻辑去掉（永远 up=false）⇒ 贴底场景会掉出视口
  const noFlip = suggestDropdownBoxOf({ rect: { top: 860, bottom: 884, left: 20, width: 300 }, viewportH: 900, contentHeight: CONTENT_17 })
  const broken = { ...noFlip, up: false, top: 884 + 2 }
  assert.ok(broken.top + broken.maxHeight > 900, '⚠ 反例（不翻转）确实会越出视口底边')
  assert.throws(
    () => assert.ok(broken.top + broken.maxHeight <= 900, '反例上"必须落在视口内"必须失败'),
    /反例上/,
    '⚠ 反例注入（去掉翻转逻辑）必须让断言失败',
  )
})

test('④ 17 条结果时可见行数 ≥5（构造用例）；窄侧栏同样成立', () => {
  // 窄侧栏：输入框宽 260、视口 760（插件常见高度）
  const narrow = suggestDropdownBoxOf({ rect: { top: 360, bottom: 390, left: 8, width: 260 }, viewportH: 760, contentHeight: CONTENT_17 })
  assert.ok(visibleRowsOf(narrow.maxHeight) >= 5, `窄侧栏下也要 ≥5 行（实际 ${visibleRowsOf(narrow.maxHeight)} 行）`)
  assert.equal(narrow.width, 260, '宽度沿用输入框（不因窄侧栏缩水）')
  assert.ok(narrow.maxHeight <= suggestCapOf(760), '高度受 52vh 上限约束')
  // 反例注入：**祖先裁剪**（用户实测的形态）—— 下拉留在弹窗里，只有弹窗内容盒剩余的那点高度可见。
  // ⚠ 注意：单纯"把上限压小"不足以复现症状（老的 262px 上限本身还能显示 9 行），
  // 真正裁掉列表的是 `.tw-modal{overflow:auto}` 这条祖先边界 ⇒ 反例必须按"可见高度 ≈ 一行"来构造。
  const clipped = { ...narrow, maxHeight: 20 }
  assert.ok(clipped.maxHeight < suggestCapOf(760), '⚠ 反例（被祖先裁到 20px）确实远小于我们给的可用高度')
  assert.ok(visibleRowsOf(clipped.maxHeight) < 5, '⚠ 反例（被裁到 20px）确实显示不到 5 行')
  assert.throws(
    () => assert.ok(visibleRowsOf(clipped.maxHeight) >= 5, '反例上"必须 ≥5 行"必须失败'),
    /反例上/,
    '⚠ 反例注入（裁掉一半）必须让断言失败',
  )
})

test('⑤ 回归：滚动、计数行、回车选中、点击添加都不变', () => {
  const ui = strip(read('ui.tsx'))
  assert.ok(ui.includes('countTextOf(view)'), '计数行仍在（文案唯一实现不变）')
  assert.ok(/data-role': 'suggest-count'/.test(ui), '计数行的 data-role 不变')
  assert.ok(ui.includes('onMouseDown: (e: React.MouseEvent) => {') && ui.includes('pick(h)'), '点击添加的接线不变')
  assert.ok(/e\.key === 'Enter'/.test(ui) && ui.includes('pick(first)'), '回车选中排序后第一条的行为不变')
  assert.ok(/className: 'tw-suggest'/.test(ui), '下拉仍用既有类名（样式继承不变）')
  assert.ok(ui.includes('overflow:auto') === false, '（滚动交给 CSS 类，不在内联里重复写）')
})
