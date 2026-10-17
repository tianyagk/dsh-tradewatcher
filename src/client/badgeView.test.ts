/**
 * 侧栏徽标的断言。
 *
 * ⚠⚠ **改这个文件里的形状断言 = 显式声明"这是有意的"**。⚠⚠
 *
 * 徽标内容**只有当日涨跌幅**（`±x.x%` / `0.0%` / 不可算时为空；隐身档为点位）。它**不许**
 * 再被第二种语义顶掉 —— 2026-10-16 用户报告侧栏徽标从 `-2.3%` 变成「护」，而用户
 * **没有要求过**这个改动（追因见 `docs/AUDIT-IMPL64.md`：`036b1a3` v0.25.0 的等级优先分支
 * + 当日等级到「疑似护盘」）。
 *
 * 这些断言是**反例必败**的：把徽标改成「护」或任何非涨跌幅文本，本文件立刻红（见 §4 注入）。
 * 若你确实要让徽标承载护盘等级，必须**另立入口**并经用户/Lead 同意（`badgeView.ts` 文件头写出了理由），
 * 而不是把这里的判据放松。
 *
 * 另锁两条**用户明确抱怨过**的规则（README「开发」节的开发原则 1/2/6）：
 * 悬停提示会被拼在侧栏插件名后面，长了就被宿主截断成 `…` ——
 * 实测踩到过 `盯盘·持仓当日盈亏 +0.07%（+795.00 元…`（金额那截永远读不到）。
 *
 * **侧栏标签恒为「盯盘」**（用户 2026-10-16 明确要求，见 ⑥/⑦）：文本**恰为** `盯盘`，
 * 不许带 `· 数据 HH:mm:ss`、也不许带 `· 已收盘`；这两类信息在**悬停 `title`**（= `detail`）与面板里
 * —— 所以这条断言反转的是"标签要不要带后缀"，**不是**"要不要保留数据时刻"。
 * ⚠ 与形状断言一样：把后缀加回标签 = 必须显式改这两条断言。
 */
import { test } from 'node:test'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { BADGE_DETAIL_MAX, badgeView, type BadgeInput, type BadgeState } from './badgeView.ts'
import { badgeToneColor } from './theme.ts'
const require = createRequire(import.meta.url)

const base: BadgeInput = {
  indexPoint: 3963,
  dayPnlPct: 0.07, asOf: Date.parse('2026-10-09T15:00:00+08:00'), settled: false,
}

/** 徽标**唯一允许的形状**（非隐身档）：带符号一位小数、`10+` 省略档、真零、或不可算时的空 */
const BADGE_TEXT_ALLOWED = /^(?:[+-](?:\d+\.\d|10\+)%|0\.0%|)$/
/** 隐身档允许的形状：点位（≤4 位）或"没有点位"的占位 */
const BADGE_TEXT_ALLOWED_MASKED = /^(?:••|\d{1,4})$/
/** 「护」以及"任何非涨跌幅的中文/字样"都不许出现（用户报告的那个字就是它） */
const BADGE_TEXT_FORBIDDEN = /护|护盘|等级|疑似/

/** 判据（返回违规清单；空数组 = 合格）。实现与注入用例**共用同一份**判据，避免两处口径 */
function violationsOf(v: { text: string; detail: string }, masked: boolean): string[] {
  const bad: string[] = []
  const allowed = masked ? BADGE_TEXT_ALLOWED_MASKED : BADGE_TEXT_ALLOWED
  if (!allowed.test(v.text)) bad.push(`徽标文字不是涨跌幅（或点位）形状：${JSON.stringify(v.text)}`)
  if (BADGE_TEXT_FORBIDDEN.test(v.text)) bad.push(`徽标里出现了护盘/等级字样：${JSON.stringify(v.text)}`)
  if (v.detail.length > BADGE_DETAIL_MAX) bad.push(`悬停提示超长（${v.detail.length} > ${BADGE_DETAIL_MAX}），会被宿主截断`)
  if (v.detail.includes('\n')) bad.push('悬停提示必须是一行')
  return bad
}

// ── ① 徽标形状与档位 ───────────────────────────────────────────────────────

test('① 徽标文字只有涨跌幅/点位两种形状（护盘等级一律不许进徽标）', () => {
  const cases: Array<[BadgeInput, boolean]> = [
    [base, false],
    [{ ...base, dayPnlPct: -2.35 }, false],
    [{ ...base, dayPnlPct: 0 }, false],
    [{ ...base, dayPnlPct: null }, false],
    [{ ...base, dayPnlPct: 12.3 }, false],
    [{ ...base, settled: true }, false],
    [{ ...base, indexPoint: null }, true],
    [{ ...base, dayPnlPct: null, indexPoint: 3000 }, true],
  ]
  for (const [input, masked] of cases) {
    const v = badgeView(input, masked)
    assert.deepEqual(violationsOf(v, masked), [], `输入 ${JSON.stringify(input)} / masked=${masked}`)
  }
})

test('② 徽标文字与配色档位不变（短标记 + 一位小数 + `10+` 省略档）', () => {
  assert.equal(badgeView({ ...base, dayPnlPct: 1.23 }, false).text, '+1.2%')
  assert.equal(badgeView({ ...base, dayPnlPct: -2.29 }, false).text, '-2.3%', '用户看到的那个形状就是它')
  assert.equal(badgeView({ ...base, dayPnlPct: -0.07 }, false).tone, 'down')
  assert.equal(badgeView({ ...base, dayPnlPct: 0 }, false).tone, 'flat')
  assert.equal(badgeView({ ...base, dayPnlPct: 12.3 }, false).text, '+10+%')  // ≥10% 仍用 10+ 省略，但补 % 以标明量纲
})

test('③ 缺失与零必须分开：null 给原因、0 才是 0.0%（不许写 0 冒充）', () => {
  const none = badgeView({ ...base, dayPnlPct: null }, false)
  assert.equal(none.text, '', '不可算 ⇒ 徽标为空（不是 0、也不是别的字）')
  assert.equal(none.detail, '当日盈亏 —（无持仓行情）')
  assert.ok(badgeView({ ...base, dayPnlPct: 0 }, false).detail.startsWith('当日盈亏 0.0%'))  // task-80：舍入统一到一位小数
})

test('④ 反例注入：徽标改成「护」或任何非涨跌幅文本 ⇒ 判据必败', () => {
  const good = badgeView({ ...base, dayPnlPct: -2.29 }, false)
  assert.deepEqual(violationsOf(good, false), [], '先证明判据在正例上是绿的（否则下面的 throws 是空跑）')
  // 注入 1：用户报告的那个形态 —— 整个文字换成「护」
  const injected = { ...good, text: '护' }
  assert.throws(
    () => assert.deepEqual(violationsOf(injected, false), [], '徽标内容必须是涨跌幅'),
    /徽标内容必须是涨跌幅/,
    '⚠ 反例注入（徽标写成「护」）必须让断言失败',
  )
  // 注入 2：换成任何别的字（等级词、点位数、空字符串都不能冒充涨跌幅）
  for (const text of ['疑似护盘', 'L2', '3963', '—']) {
    assert.ok(violationsOf({ ...good, text }, false).length > 0, `⚠ 非涨跌幅文本必须被抓住：${JSON.stringify(text)}`)
  }
})

// ── ② 源码层面的"不许再分叉"（结构性防线，不只是注释约定）──────────────────

/**
 * 去注释：源码判据只看**代码**。
 *
 * 为什么必须有这一步：`badgeView.ts` 的注释里**必须**能写明"`level`/`levelLabel` 为什么被删掉了"，
 * 把注释算进去就等于禁止注释提到那个词 —— 后续维护者会被迫把历史删掉（信息反而丢了）。
 * 这与 `toolsPage.test.ts` 里踩过的同一个坑一致。
 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

test('⑤ 源码：badgeView 不许再读护盘等级，涨跌幅短标记必须是唯一产出', () => {
  const { readFileSync } = require('node:fs') as { readFileSync: (p: string, enc: string) => string }
  const { fileURLToPath } = require('node:url') as { fileURLToPath: (u: string) => string }
  const { dirname, join } = require('node:path') as { dirname: (p: string) => string; join: (...p: string[]) => string }
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), './badgeView.ts'), 'utf8')
  const code = stripComments(src)
  const judge = (text: string): boolean => /b\.level|levelLabel|text: '护'/.test(text)
  assert.equal(judge(code), false, 'badgeView 不许再引用 level/levelLabel，也不许有 `text: \'护\'` 这条分支')
  assert.ok(judge(src), '⚠ 判据必须真能命中"注释里提到过 levelLabel"这件事（证明去注释这一步是必要的、不是空跑）')
  assert.ok(/text: `\$\{sign\}\$\{mag >= 10 \? '10\+' : mag\.toFixed\(1\)\}%`/.test(code), '涨跌幅短标记必须仍是唯一产出（形状：±x.x% / ±10+%）')
  assert.ok(code.includes('dayPnlPct === null'), '不可算那一档必须还在（否则"算不出"会被 0 顶替）')
  // 注入 1：把等级优先分支塞回来 ⇒ 必败
  const back = code.replace('if (masked) {', "if (b.level >= 2) {\n    return { text: '护', tone: 'flat', detail: '护盘信号', stamp: '' }\n  }\n  if (masked) {")
  assert.notEqual(back, code, '反例注入必须真改到源码')
  assert.throws(
    () => assert.equal(judge(back), false, '源码里不许有等级分支'),
    /源码里不许有等级分支/,
    '⚠ 反例注入（等级优先分支回来）必须让断言失败',
  )
  // 注入 2：把涨跌幅换成「护」⇒ 必败
  const swapped = code.replace(/text: `\$\{sign\}.*?%`,/, "text: '护',")
  assert.notEqual(swapped, code, '反例注入必须真改到涨跌幅那一行')
  assert.throws(
    () => assert.equal(/text: `\$\{sign\}.*?%`,/.test(swapped), true, '徽标产出的形状必须是涨跌幅'),
    /徽标产出的形状必须是涨跌幅/,
    '⚠ 反例注入（徽标改成「护」）必须让断言失败',
  )
})

/**
 * ⑥ 侧栏**标签**恒为「盯盘」（用户 2026-10-16 明确要求：**不要后缀**）。
 *
 * 改前的形态是 `盯盘 · 数据 15:05:56 · 已收盘` ⇒ 用户要求只保留 `盯盘`。
 * 数据时刻与「已收盘」没有丢：悬停 `title`（= `detail`）里仍在，面板内本来也有（见 ⑦）。
 *
 * ⚠ 这条断言与 ⑦ 是**成对反转**的（上一批恰好相反）：谁要把后缀加回标签，必须显式改这里。
 */
test('⑥ 源码：侧栏标签必须是常量「盯盘」，不许再做任何字符串插值（后缀 = 不许回来）', () => {
  const { readFileSync } = require('node:fs') as { readFileSync: (p: string, enc: string) => string }
  const { fileURLToPath } = require('node:url') as { fileURLToPath: (u: string) => string }
  const { dirname, join } = require('node:path') as { dirname: (p: string) => string; join: (...p: string[]) => string }
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), './index.tsx'), 'utf8')
  const code = stripComments(src)
  assert.ok(code.includes("label: () => '盯盘'"), '真实接线必须是常量「盯盘」')
  // 判据：`label: () => …` 那一行的**表达式里不许有模板插值 / 拼接**（那就是后缀）
  const labelExpr = /label: \(\) => ([^,\n]*)/.exec(code)?.[1] ?? ''
  assert.equal(labelExpr, "'盯盘'", `标签表达式必须恰是 '盯盘'（实际 ${labelExpr}）`)
  const judge = (text: string): boolean => /label: \(\) => [^,\n]*\$\{/.test(text)
  assert.equal(judge(code), false, '标签表达式里不许出现 `${…}`（数据时刻/已收盘都算后缀）')
  // 反例注入 1：把时间戳后缀加回去 ⇒ 必败
  const withStamp = code.replace("label: () => '盯盘'", 'label: () => `盯盘 · 数据 ${badgeState.stamp}`')
  assert.notEqual(withStamp, code, '反例注入必须真改到源码')
  assert.throws(
    () => assert.equal(judge(withStamp), false, '标签里不许有后缀'),
    /标签里不许有后缀/,
    '⚠ 反例注入（`· 数据 HH:mm:ss` 加回标签）必须让断言失败',
  )
  // 反例注入 2：只加「已收盘」后缀（常量拼接也算）⇒ 必败
  const withSettled = code.replace("label: () => '盯盘'", "label: () => `盯盘 · 已收盘`")
  assert.throws(
    () => assert.equal(/label: \(\) => ([^,\n]*)/.exec(withSettled)?.[1], "'盯盘'", '标签表达式必须恰是 \'盯盘\''),
    /标签表达式必须恰是/,
    '⚠ 反例注入（`· 已收盘` 加回标签）必须让断言失败',
  )
  // 反例注入 3：标签接回 detail（那是最容易"顺手"的写法：detail 里就带着数据时刻）⇒ 必败
  const withDetail = code.replace("label: () => '盯盘'", 'label: () => `盯盘 · ${badgeState.detail}`')
  assert.throws(
    () => assert.equal(judge(withDetail), false, '标签里不许有后缀'),
    /标签里不许有后缀/,
    '⚠ 反例注入（标签接回 detail）必须让断言失败',
  )
})

test('⑥b 结构：徽标状态里**没有**"标签专用"字段（stamp 已删 ⇒ 后缀无处可取）', () => {
  const v = badgeView(base, false)
  assert.deepEqual(Object.keys(v).sort(), ['detail', 'text', 'tone'], '徽标状态只有 text/tone/detail 三个字段')
  // 反例注入：给状态加回一个 stamp 字段 ⇒ 判据必败（证明这条不是空跑）
  const injected = { ...v, stamp: '数据 15:05:56 · 已收盘' }
  assert.throws(
    () => assert.deepEqual(Object.keys(injected).sort(), ['detail', 'text', 'tone'], '徽标状态不该再有 stamp'),
    /徽标状态不该再有 stamp/,
    '⚠ 反例注入（stamp 字段回来）必须让断言失败',
  )
})

// ── ③ 标签、tooltip、同口径同舍入 ───────────────────────────────────────────

/** task-80 反转：标签恒为「盯盘」；数据时刻与「已收盘」搬到悬停 title（信息不丢） */
test('⑦ 标签恰为「盯盘」（不含 数据/已收盘/`·` 分隔后缀），信息落在悬停 title 里', () => {
  // ⚠ 断言必须锚在**真实接线**上：读 index.tsx 里真正的 label 表达式，而不是自己拼一个
  const { readFileSync } = require('node:fs') as { readFileSync: (p: string, enc: string) => string }
  const { fileURLToPath } = require('node:url') as { fileURLToPath: (u: string) => string }
  const { dirname, join } = require('node:path') as { dirname: (p: string) => string; join: (...p: string[]) => string }
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), './index.tsx'), 'utf8')
  // 判据 1：`label` 是常量「盯盘」——不许再接 stamp / detail（两者都会带出后缀）
  assert.ok(src.includes("label: () => '盯盘'"), '真实接线必须是常量「盯盘」')
  assert.equal(/label: \(\) => \(badgeState\./.test(src), false, '标签不许再接任何 badgeState 字段（那就是后缀）')
  // 判据 2：**实际渲染的标签文本**恰为「盯盘」
  const label = (): string => '盯盘'
  const text = label()
  assert.equal(text, '盯盘', `侧栏标签必须恰为「盯盘」（实际 ${JSON.stringify(text)}）`)
  for (const forbidden of ['数据', '已收盘', '·', '%', '当日盈亏']) {
    assert.equal(text.includes(forbidden), false, `标签里不许出现 ${JSON.stringify(forbidden)}`)
  }
  // 判据 3：**信息没丢** —— 数据时刻与「已收盘」必须在悬停 title（= detail）里
  // ⚠ 期望值**必须**写死字面量（R5）：用同一个 toLocaleTimeString 推导 ⇒ 任何时区都过，
  // 等于把"数据时刻按浏览器时区渲染"这个缺陷锁成契约（UTC 浏览器下它接受 01:42:52）。
  const v = badgeView({ indexPoint: 3000, dayPnlPct: -2.29, asOf: Date.parse('2026-10-12T09:42:52+08:00'), settled: false }, false)
  assert.ok(v.detail.includes('· 数据 09:42:52'), `悬停里必须有北京数据时刻（实际 ${v.detail}）`)
  assert.equal(v.detail, '当日盈亏 -2.3% · 数据 09:42:52', `悬停形状（实际 ${v.detail}）`)
  assert.ok(badgeView({ ...base, settled: true }, false).detail.includes('· 已收盘'), '已收盘状态必须在悬停里（不许因为标签去掉后缀就把信息丢掉）')
  // 判据 4：徽标（紧凑、带色那一处）不变
  assert.equal(v.text, '-2.3%', '徽标直接给百分比，便于比较')
  assert.equal(v.tone, 'down', '徽标仍带色（下跌）')
})

test('⑧ task-80：徽标与 tooltip 同口径同舍入（同一输入）', () => {
  const cases: Array<[number, string]> = [[-2.29, '-2.3%'], [2.349, '+2.3%'], [0, '0.0%'], [12.5, '+10+%']]
  for (const [pct, expect] of cases) {
    const v = badgeView({ indexPoint: null, dayPnlPct: pct, asOf: null, settled: false }, false)
    assert.equal(v.text, expect, `徽标（输入 ${pct}）`)
    // tooltip 里的百分比必须与徽标**同一个舍入结果**（去掉尾部的 · 数据 … 部分后逐字比对）
    const inDetail = /当日盈亏 ([+-]?[\d.]+\+?%)/.exec(v.detail)?.[1] ?? ''
    assert.equal(inDetail, v.text, `tooltip 里的百分比必须与徽标一致（detail=${v.detail}）`)
  }
  // 「不可算」时徽标为空、tooltip 给原因（不是 0）
  const none = badgeView({ indexPoint: null, dayPnlPct: null, asOf: null, settled: false }, false)
  assert.equal(none.text, '')
  assert.ok(none.detail.includes('当日盈亏 —'), none.detail)
})

test('⑨ 金额不进悬停提示（那截永远被截断，细节留在面板里）', () => {
  const v = badgeView({ ...base, dayPnlPct: 0.07 }, false)
  assert.ok(!v.detail.includes('元'), `不该出现金额：${v.detail}`)
  assert.ok(!v.detail.includes('持仓'), `不该重复"持仓"这类可从上下文得知的词：${v.detail}`)
})

// ── ④ 徽标底色跟随 prefs.redUp ─────────────────────────────────────────────

test('⑩ 徽标底色：涨跌两档跟随 redUp，中性档不受影响（色义画反是"最难发现的不一致"）', () => {
  assert.equal(badgeToneColor('up', true), '#ff5f6d', '红涨（默认）')
  assert.equal(badgeToneColor('down', true), '#27a644', '绿跌（默认）')
  assert.equal(badgeToneColor('up', false), '#27a644', 'redUp=false ⇒ 绿涨')
  assert.equal(badgeToneColor('down', false), '#ff5f6d', 'redUp=false ⇒ 红跌')
  assert.equal(badgeToneColor('flat', true), badgeToneColor('flat', false), '平静档与色义无关')
  assert.notEqual(badgeToneColor('up', true), badgeToneColor('up', false), '⚠ 反例：两个色义下同一档必须不同色（否则等于没接 redUp）')
  // 护盘橙不许再出现在**色板里**（它只会把等级文案引回这个 18px 的位置）
  const { readFileSync } = require('node:fs') as { readFileSync: (p: string, enc: string) => string }
  const { fileURLToPath } = require('node:url') as { fileURLToPath: (u: string) => string }
  const { dirname, join } = require('node:path') as { dirname: (p: string) => string; join: (...p: string[]) => string }
  const theme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), './theme.ts'), 'utf8')
  // 判据看**键值位置**（注释里允许写明"这一档已删除"，否则文档与断言会互相打架）
  assert.equal(/rescue:\s*'/.test(theme), false, '徽标色板里不该再有 rescue 档')
  assert.equal(/:\s*'#d97706'/.test(theme), false, '徽标色板里不该再把护盘橙用作某个档的色值')
})

/** 类型层面也钉一下：BadgeState 的 tone 不许悄悄长出 rescue 档 */
test('⑪ 徽标档位只有 up/down/flat（类型 + 运行时都只有这三个）', () => {
  const seen = new Set<string>()
  for (const pct of [1, -1, 0, null]) {
    seen.add(badgeView({ ...base, dayPnlPct: pct }, false).tone)
    seen.add(badgeView({ ...base, dayPnlPct: pct }, true).tone)
  }
  assert.deepEqual([...seen].sort(), ['down', 'flat', 'up'])
  const tones: Array<BadgeState['tone']> = ['up', 'down', 'flat']
  assert.equal(tones.length, 3)
})

/**
 * ⑫ **用户报告的那个场景本身**：宿主回包带着 `level: 2 / levelLabel: '疑似护盘'` 时，
 * 徽标必须仍然显示当日涨跌幅（改前它显示「护」）。
 *
 * 回包字段是实测抓下来的（2026-10-16 14:39：`{"level":2,"levelLabel":"疑似护盘","dayPnl":-34189,"dayPnlPct":-2.33,…}`）；
 * 用**变量**传进去 ⇒ 结构类型允许带多余字段，正好模拟真实调用点（`api.badge()` 的回包）。
 */
test('⑫ 回归：宿主报「疑似护盘」时，徽标仍是当日涨跌幅（不是「护」）', () => {
  const fromApi = {
    indexPoint: 4134.25, dayPnlPct: -2.33,
    asOf: Date.parse('2026-10-16T14:39:00+08:00'), settled: false,
    // 宿主契约里仍有的两个字段（客户端不再消费）
    level: 2, levelLabel: '疑似护盘',
  }
  const v = badgeView(fromApi, false)
  assert.equal(v.text, '-2.3%', '徽标必须显示当日涨跌幅（用户看到的 `-2.3%`），不是「护」')
  assert.equal(v.tone, 'down')
  assert.deepEqual(violationsOf(v, false), [])
})
