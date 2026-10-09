/**
 * 断点一致性的可执行断言。
 *
 * 背景：宽屏有两个"必须一起生效"的东西 —— 多列网格（`.tw-wlist`/`.tw-poslist` 的 `columns:520px`）
 * 与列头排序（`.tw-sorthead`）。它们各写一个 `@media (min-width:1080px)`，
 * 且在客户端由 `WIDE_MIN_PX` 决定**挂哪个排序控件**。
 * 三处只要有一处漂了，后果不是"稍微难看"，而是：
 *   - 列头显示了、多列没生效 → 名次错乱（按列读变成按行读）；
 *   - JS 判定为宽、CSS 判定为窄 → 排序入口消失或列头挤成一团。
 * 因此把"必须一致"从注释升级成断言 —— 注释拦不住改代码的人。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STYLE_ID, TW_CSS, cssInjectAction } from './styles.ts'
import { WIDE_MIN_PX } from './wide.ts'

test('CSS 里的宽屏断点全部等于 WIDE_MIN_PX（两处 min-width + 一处组头）', () => {
  const found = [...TW_CSS.matchAll(/@media \(min-width:(\d+)px\)/g)].map((m) => Number(m[1]))
  assert.ok(found.length >= 3, `宽屏断点应至少 3 处（多列/列头/组头），实际 ${found.length}`)
  const bad = found.filter((px) => px !== WIDE_MIN_PX)
  assert.deepEqual(bad, [], `以下断点与 WIDE_MIN_PX(${WIDE_MIN_PX}) 不一致：${bad.join(', ')}`)
})

test('互斥只有一个机制：CSS 里不得再出现"隐藏某个排序控件"的规则', () => {
  // v0.30.1 删除了 [data-wide-hide=1]{display:none}：它单独承担互斥时实测两个控件同时出现。
  // 断言匹配的是**规则形状**而不是字符串 —— 注释里解释这段历史是允许的（也该解释），
  // 但只要有人重新写回一条"用 display:none 藏排序控件"的规则，这里就必须失败。
  // 必须先剥掉 /* */ 注释：这段历史说明本身就长得像一条规则（[data-wide-hide=1]{display:none}），
  // 不剥就会把"解释为什么删掉"误判成"又加回来了"。
  const css = TW_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const ruleLike = /\[data-wide-hide[^{]*\{[^}]*display\s*:\s*none/.test(css)
  assert.ok(!ruleLike, 'CSS 里又出现了隐藏式互斥；互斥应由 useWideLayout() 决定只挂一个')
})


test('样式注入：内容变了必须替换（否则热重载后新 DOM 配旧 CSS，界面会变成没样式的纯文本）', () => {
  // 实测踩到过：客户端插件热重载（不刷新页面）时，文档里那份 <style> 还是上一版的，
  // 旧规则里没有新类名 ⇒ 新版大盘页整块失去样式，被误判为"新布局不如旧版"。
  assert.equal(cssInjectAction(null, 'A'), 'append', '文档里没有样式表 ⇒ 注入')
  assert.equal(cssInjectAction('A', 'A'), 'skip', '内容一致 ⇒ 不重复注入')
  assert.equal(cssInjectAction('A', 'B'), 'replace', '内容变了 ⇒ 必须替换，不能沿用旧的')
  assert.equal(cssInjectAction('', 'A'), 'replace', '空样式表也按"内容不同"处理')
})

test('STYLE_ID 稳定（换 id 会让旧样式表留下来与新样式表并存）', () => {
  assert.equal(typeof STYLE_ID, 'string')
  assert.ok(STYLE_ID.length > 0)
  assert.ok(TW_CSS.length > 1000, '样式表内容不应为空')
})