/**
 * 第一批（AGENT DESK 顶部状态条 + 左栏）对拍断言。
 *
 * 口径来源：`docs/PRISM-DESIGN-DIFF.md` §12 拍板（Q1–Q5）+ §13 第一批范围。
 * 判据不靠"看起来像"：格式/派生走纯函数单测，DOM/CSS 走源码对拍 + 反例注入。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CAP_MAX, CAP_MIN, CAP_STEP, CAP_TICKS, HELP_LINES, LIMIT_FALLBACK,
  codeOf, constraintPayloadOf, constraintVersionOf, constraintsDirtyOf,
  groupOf, moneyWanOf, pnlPctOf, pnlSumOf, pnlTextOf, pnlToneOf,
  runsBadgeOf, usageOf, wanOf, weightOf, weightTextOf,
} from './prismDesk.ts'

const PAGE = readFileSync(new URL('./PrismPage.tsx', import.meta.url), 'utf8')
const CSS = readFileSync(new URL('./styles.ts', import.meta.url), 'utf8')
const API = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')

/* ───────────── ① 金额 / 万元 / 盈亏格式 ───────────── */

test('① 千分位：真实 1,800,000 / 负数分组 / 缺失 —', () => {
  assert.equal(groupOf(1_800_000), '1,800,000')
  assert.equal(groupOf(-217_746), '-217,746')
  assert.equal(groupOf(null), '—')
  assert.equal(groupOf(Number.NaN), '—')
})

test('② 万元口径：124.0万 / ¥180.0万（不写 ¥—）', () => {
  assert.equal(wanOf(1_240_226), '124.0万')
  assert.equal(moneyWanOf(1_240_226), '¥124.0万')
  assert.equal(moneyWanOf(1_800_000), '¥180.0万')
  assert.equal(moneyWanOf(null), '—')
})

test('③ 已用额度：真实 1,240,226 / 1,800,000 ⇒ 68.9%，距上限 31.1pt', () => {
  const u = usageOf(1_800_000, 1_240_226)
  assert.equal(u.pctText, '68.9%')
  assert.equal(u.gapText, '31.1pt')
  assert.equal(u.noteText, '已用 68.9% · 距上限还有 31.1pt')
  assert.ok(u.ratio !== null && Math.abs(u.ratio - 0.689) < 0.001)
  assert.equal(u.exceeded, false)
})

test('④ 超限：文案转「超上限」且 exceeded（不写负数剩余）', () => {
  const u = usageOf(1_800_000, 1_900_000)
  assert.equal(u.exceeded, true)
  assert.equal(u.pctText, '105.6%')
  assert.match(u.noteText, /超上限 5\.6pt/)
  assert.doesNotMatch(u.noteText, /还有/)
})

test('⑤ 上限缺失 / 为 0 ⇒ 全 —（不拿默认值兜底）', () => {
  for (const u of [usageOf(null, 1_000), usageOf(0, 1_000), usageOf(1_800_000, null)]) {
    assert.equal(u.ratio, null)
    assert.equal(u.pctText, '—')
    assert.equal(u.gapText, '—')
    assert.equal(u.noteText, '—')
  }
})

test('⑥ 顶部 #N：只认 runsCount；无源 ⇒ #—（不写 #0）', () => {
  assert.equal(runsBadgeOf(20), '#20')
  assert.equal(runsBadgeOf(0), '#0')
  for (const v of [null, undefined, Number.NaN]) assert.equal(runsBadgeOf(v), '#—')
})

test('⑦ 权重分母 = 总资产（现金计入），缺分母 ⇒ null', () => {
  assert.ok(Math.abs((weightOf(1_240_226, 1_582_253.68) ?? 0) - 0.7838) < 0.001)
  assert.equal(weightOf(1_000, null), null)
  assert.equal(weightOf(1_000, 0), null)
  assert.equal(weightOf(null, 1_000), null)
  assert.equal(weightTextOf(0.2443), '24.4%')
  assert.equal(weightTextOf(null), '—')
})

test('⑧ 盈亏：整数元 + 符号 + 红涨绿跌分类', () => {
  assert.equal(pnlTextOf(-217_746), '-217,746')
  assert.equal(pnlTextOf(240), '+240')
  assert.equal(pnlTextOf(0), '0')
  assert.equal(pnlTextOf(null), '—')
  assert.equal(pnlToneOf(-1), 'down')
  assert.equal(pnlToneOf(1), 'up')
  assert.equal(pnlToneOf(0), 'flat')
  assert.equal(pnlToneOf(null), 'flat')
})

test('⑨ 行尾 title：成本 → 涨跌% （缺值不猜）', () => {
  assert.equal(pnlPctOf(30, 29.86), '+0.47%')
  assert.equal(pnlPctOf(29, 29.86), '-2.88%')
  assert.equal(pnlPctOf(null, 29.86), null)
  assert.equal(pnlPctOf(30, 0), null)
})

test('⑩ 浮盈合计：Σ pnl；任一行缺值 ⇒ —（不部分求和）', () => {
  assert.equal(pnlSumOf([{ pnl: -100 }, { pnl: 40 }]), -60)
  assert.equal(pnlSumOf([{ pnl: -100 }, { pnl: null }]), null)
  assert.equal(pnlSumOf([]), null)
})

test('⑪ 代码展示：去掉市场前缀，保留前导 0', () => {
  assert.equal(codeOf('1.600938'), '600938')
  assert.equal(codeOf('0.002739'), '002739')
  assert.equal(codeOf('600938'), '600938')
})

test('⑫ 约束版本无源 ⇒ —（不编号、不猜 v1）', () => {
  assert.equal(constraintVersionOf(null), '—')
  assert.equal(constraintVersionOf(undefined), '—')
  assert.equal(constraintVersionOf('1'), 'v1')
})

/* ───────────── ② 红线：默认值只做 placeholder ───────────── */

test('⑬ 默认值六项与设计稿一致（15 / 200000 / 85 / 8 / 5 / 15）', () => {
  assert.deepEqual(
    ['perStockPct', 'perOrderYuan', 'maxPosPct', 'stopLossPct', 'maxDDPct', 'minCashPct'].map((k) => LIMIT_FALLBACK[k]),
    ['15', '200000', '85', '8', '5', '15'],
  )
})

test('⑭ 默认值不进请求体：空草稿 + 宿主 null ⇒ 发 null（不是 15/85…）', () => {
  const keys = ['perStockPct', 'stopLossPct', 'perOrderYuan', 'maxPosPct', 'maxDDPct', 'minCashPct']
  const empty = Object.fromEntries(keys.map((k) => [k, '']))
  const nulls = Object.fromEntries(keys.map((k) => [k, null]))
  const r = constraintPayloadOf(empty, nulls, keys)
  assert.equal(r.ok, true)
  assert.deepEqual(r.values, nulls)
  for (const k of keys) assert.equal(r.values[k], null, `${k} 被默认值污染`)
})

test('⑮ 空草稿 + 宿主有值 ⇒ 原样保留（不覆盖已保存值）', () => {
  const keys = ['perStockPct']
  const r = constraintPayloadOf({ perStockPct: '' }, { perStockPct: 12.5 }, keys)
  assert.deepEqual(r.values, { perStockPct: 12.5 })
})

test('⑯ 草稿越界 ⇒ 字段级报错（不提交）', () => {
  const bad = constraintPayloadOf({ perStockPct: '-1' }, { perStockPct: null }, ['perStockPct'])
  assert.equal(bad.ok, false)
  assert.equal(bad.key, 'perStockPct')
  assert.equal(bad.error, '约束不能为负')
  const over = constraintPayloadOf({ maxDDPct: '101' }, { maxDDPct: null }, ['maxDDPct'])
  assert.equal(over.ok, false)
  assert.match(over.error ?? '', /不能超过 100/)
  const huge = constraintPayloadOf({ perOrderYuan: '10000000000' }, { perOrderYuan: null }, ['perOrderYuan'])
  assert.match(huge.error ?? '', /金额上限过大/)
})

test('⑰ dirty 检测：空草稿=未改；同值=未改；异值=改', () => {
  const keys = ['perStockPct']
  assert.equal(constraintsDirtyOf({ perStockPct: '' }, { perStockPct: null }, keys), false)
  assert.equal(constraintsDirtyOf({ perStockPct: '15' }, { perStockPct: 15 }, keys), false)
  assert.equal(constraintsDirtyOf({ perStockPct: '15' }, { perStockPct: null }, keys), true)
  assert.equal(constraintsDirtyOf({ perStockPct: '16' }, { perStockPct: 15 }, keys), true)
})

test('⑱ 滑杆 0–500 万 / step 0.1 万 / 五档刻度', () => {
  assert.equal(CAP_MIN, 0)
  assert.equal(CAP_MAX, 5_000_000)
  assert.equal(CAP_STEP, 100_000)
  assert.deepEqual([...CAP_TICKS], ['0', '100万', '200万', '300万', '500万'])
})

test('⑲ ? 浮层 ≤3 行、每行 ≤20 字（谁能设 / 谁执行 / 只读）', () => {
  assert.ok(HELP_LINES.length <= 3)
  for (const l of HELP_LINES) assert.ok(l.length <= 20, `${l} 超 20 字`)
  assert.match(HELP_LINES[0] ?? '', /约束/)
  assert.match(HELP_LINES[2] ?? '', /只读/)
})

/* ───────────── ③ 顶部状态条（源码对拍） ───────────── */

test('⑳ 顶条 56px + 底部渐变色线', () => {
  assert.match(CSS, /\.tw-ad-top\{[^}]*height:56px/)
  assert.match(CSS, /\.tw-ad-top::after\{[^}]*linear-gradient/)
})

test('㉑ 标识三件套：AGENT DESK + AUTONOMOUS + 副标题', () => {
  assert.ok(PAGE.includes("'AGENT DESK'"))
  assert.ok(PAGE.includes("'AUTONOMOUS'"))
  assert.ok(PAGE.includes('自主交易代理 · 人类只设边界'))
  assert.match(CSS, /\.tw-ad-title\{[^}]*font-size:14px/)
})

test('㉒ RUNNING #N 用真实 runsCount（无源 —）', () => {
  assert.match(PAGE, /'RUNNING'/)
  assert.match(PAGE, /runsBadgeOf\(runsCount\)/)
  assert.match(PAGE, /const runsCount = desk\?\.performance\?\.runsCount \?\? null/)
})

test('㉓ 北京时间：useNow(1000) + shClockText（不读本机 getHours）', () => {
  assert.match(PAGE, /useNow\(1000\)/)
  assert.match(PAGE, /shClockText\(now\)/)
  assert.ok(!/getHours\(\)/.test(PAGE))
})

test('㉔ ⏸ 禁用 + 精确 title（Q4）', () => {
  assert.match(PAGE, /disabled: true,[\s\S]{0,120}title: '宿主未提供暂停接口'/)
  assert.match(PAGE, /'aria-label': '暂停（宿主未提供接口）'/)
})

test('㉕ ? 浮层由 HELP_LINES 渲染（≤3 行）', () => {
  assert.match(PAGE, /\.\.\.HELP_LINES\.map/)
  assert.match(PAGE, /role: 'tooltip'/)
})

/* ───────────── ④ 左栏：资产上限卡 ───────────── */

test('㉖ HUMAN 徽标 + 约束 —（版本无源）', () => {
  assert.match(PAGE, /'tw-ad-auth is-human'/)
  assert.ok(PAGE.includes('`约束 ${constraintVersionOf(null)}`'))
  assert.match(PAGE, /title: '宿主未提供约束版本号'/)
})

test('㉗ 金额 19px + ¥ 15px + CNY 单位', () => {
  assert.match(CSS, /\.tw-ad-cap-input input\{[^}]*font-size:19px/)
  assert.match(CSS, /\.tw-ad-cur\{[^}]*font-size:15px/)
  assert.ok(PAGE.includes("'CNY'"))
})

test('㉘ 金额输入失焦/回车提交 action:capital（不新增路由）', () => {
  assert.match(PAGE, /onBlur: commitCapital/)
  assert.match(PAGE, /if \(e\.key === 'Enter'\) commitCapital\(\)/)
  assert.match(PAGE, /api\.prismCapital\(Math\.round\(n\)\)/)
  assert.match(API, /action: 'capital'/)
})

test('㉙ 六格顺序 = 设计稿（单票 / 单笔 / 总仓位 / 止损 / 回撤 / 现金）', () => {
  const block = PAGE.slice(PAGE.indexOf('const LIMITS = ['), PAGE.indexOf('] as const'))
  const order = [...block.matchAll(/\['(\w+)'/g)].map((m) => m[1])
  assert.deepEqual(order, ['perStockPct', 'perOrderYuan', 'maxPosPct', 'stopLossPct', 'maxDDPct', 'minCashPct'])
})

test('㉚ 六格默认值只走 placeholder + title="默认值，未保存"', () => {
  assert.match(PAGE, /placeholder: LIMIT_FALLBACK\[key\]/)
  assert.match(PAGE, /title: isDefault \? '默认值，未保存' : undefined/)
  assert.match(PAGE, /'data-default': isDefault \? '1' : undefined/)
  assert.ok(PAGE.includes("title: isDefault ? '默认值，未保存'"))
})

test('㉛ 默认值不参与计算：usageOf 只收 capital/used，页面无 ?? 15 / ?? 85', () => {
  assert.match(PAGE, /const usage = usageOf\(capital, used\)/)
  assert.ok(!/\?\? 15\b/.test(PAGE), '不得用 15 当已保存值')
  assert.ok(!/\?\? 85\b/.test(PAGE), '不得用 85 当已保存值')
  assert.ok(!/MAX\(0, 85/.test(PAGE))
})

test('㉜ 已用额度：¥x / ¥y + 进度条 + 百分比行', () => {
  assert.ok(PAGE.includes("'已用额度'"))
  assert.match(PAGE, /usage\.usedText\} \/ \$\{usage\.limitText/)
  assert.match(PAGE, /usage\.noteText/)
  assert.match(CSS, /\.tw-ad-usage-row \.v\{[^}]*font-size:12px/)
})

test('㉝ 进度条只用 transform（scaleX），无 transition:width', () => {
  assert.match(PAGE, /transform: `scaleX\(\$\{/)
  assert.match(CSS, /\.tw-ad-bar i\{[^}]*transform-origin:left center;transition:transform/)
  assert.ok(!/transition:width/.test(CSS), '动效纪律：不得过渡 width')
})

test('㉞ 85% 刻度只在 maxPosPct 是已保存值时才画', () => {
  assert.match(PAGE, /const maxPosSaved = savedLimits\.maxPosPct/)
  assert.match(PAGE, /maxPosSaved === null\s*\n?\s*\? null/)
  assert.match(PAGE, /title: `最大总仓位刻度 \$\{maxPosSaved\}%（已保存值）`/)
})

test('㉟ 按钮 dirty 态：约束未变更（disabled）/ 应用约束 → 下发 Agent', () => {
  assert.ok(PAGE.includes("'约束未变更'"))
  assert.ok(PAGE.includes('应用约束 → 下发 Agent'))
  assert.match(PAGE, /disabled: !dirty \|\| saving/)
  assert.match(PAGE, /const consDirty = constraintsDirtyOf\(cons, savedLimits, LIMIT_KEYS\)/)
})

/* ───────────── ⑤ 左栏：持仓明细卡 ───────────── */

test('㊱ 5+1 列 grid：标的 1fr + 四个数值列 + 行尾 ⋯（392 左栏内可读）', () => {
  assert.match(CSS, /\.tw-ad-pos-head,\.tw-ad-pos-row\{[^}]*grid-template-columns:minmax\(0,1fr\) 48px 50px 38px 50px 20px/)
  assert.match(CSS, /\.tw-ad-board\{[^}]*grid-template-columns:392px minmax\(0,1fr\) 374px/)
  for (const h of ['标的', '持股数', '成本价', '权重', '盈亏']) assert.ok(PAGE.includes(`'${h}'`), h)
})

test('㊲ 行高 34 / 表头 24（设计稿）', () => {
  assert.match(CSS, /\.tw-ad-pos-row\{[^}]*height:34px/)
  assert.match(CSS, /\.tw-ad-pos-head\{[^}]*height:24px/)
})

test('㊳ 标的：名称 + 代码 + 行业 —（title 说明无源）', () => {
  assert.match(PAGE, /codeOf\(p\.secid\)/)
  assert.match(PAGE, /'行业：宿主无单票行业字段'/)
  assert.match(PAGE, /className: 'tw-ad-ind'[^}]*title:/)
})

test('㊴ 权重/盈亏来自回包：weightOf(marketValue,totalAssets) + pnlTextOf(row.pnl)', () => {
  assert.match(PAGE, /const totalAssets = desk\?\.overview\?\.totalAssets \?\? null/)
  assert.match(PAGE, /weightOf\(r\.marketValue \?\? null, totalAssets\)/)
  assert.match(PAGE, /weightTextOf\(p\.weight\)/)
  assert.match(PAGE, /pnlTextOf\(p\.pnl\)/)
  assert.ok(!/qty \* price/.test(PAGE), '不得前端自算市值')
})

test('㊵ 行尾 ⋯ 菜单收「编辑 / 移除」，移除仍二次确认', () => {
  assert.ok(PAGE.includes("'⋯'"))
  assert.ok(PAGE.includes("'编辑'"))
  assert.ok(PAGE.includes("'移除'"))
  assert.match(PAGE, /title: '移除持仓'/)
  assert.match(PAGE, /'确认移除该持仓？'/)
})

test('㊶ 卡底：＋ 添加持仓 + 浮盈 Σ pnl（真实合计）', () => {
  assert.ok(PAGE.includes('＋ 添加持仓'))
  assert.match(PAGE, /const floatSum = pnlSumOf\(posRows\)/)
  assert.ok(PAGE.includes("'浮盈 '"))
  assert.match(PAGE, /pnlTextOf\(floatSum\)/)
})

test('㊷ 行内编辑保留（编辑 → 保存/取消 → update 请求体）', () => {
  assert.match(PAGE, /setEditDraft\(\{ shares: String\(p\.qty\), cost: String\(p\.cost\) \}\)/)
  assert.match(PAGE, /api\.prismPosition\(\{ op: 'update', secid: editSecid, shares: Number\(editDraft\.shares\), cost: Number\(editDraft\.cost\) \}\)/)
})

/* ───────────── ⑥ 令牌 / 动效 / 边界 ───────────── */

test('㊸ 深色 12 令牌 1:1 + 人类区竖条', () => {
  for (const v of ['#070a0f', '#0f141c', '#131a25', '#1c2532', '#2b3748', '#e8eef7', '#98a7bc', '#5d6a7d', '#ff4d5e', '#00c88a', '#5b8cff', '#f0a93b']) {
    assert.ok(CSS.includes(v), `缺 ${v}`)
  }
  assert.match(CSS, /\.tw-ad-col-human \.tw-ad-card::before\{[^}]*linear-gradient\(180deg,transparent,rgba\(240,169,59,\.75\),transparent\)/)
})

test('㊹ 左栏字号 ≥12（顶条/卡片逐条扫描；tab 计数 11px 为唯一例外）', () => {
  const css = CSS.replace(/\.tw-ad-fchip \.cn\{[^}]*\}/g, '')
  const sizes = [...css.matchAll(/\.tw-ad-[^{]+\{[^}]*font-size:(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]))
  assert.ok(sizes.length > 10, `扫描到的 tw-ad 字号太少：${sizes.length}`)
  assert.deepEqual(sizes.filter((n) => n < 12), [])
})

test('㊺ 动效只有 transform/opacity（无 height/left/width 过渡）', () => {
  const start = CSS.indexOf('/* ── 顶部状态条（56px）── */')
  const end = CSS.indexOf('.tw-dw-body', start)
  assert.ok(start > 0 && end > start, '找不到 AGENT DESK 样式段')
  const block = CSS.slice(start, end)
  for (const bad of ['transition:width', 'transition:height', 'transition:left', 'transition:background']) {
    assert.ok(!block.includes(bad), `违反动效纪律：${bad}`)
  }
  assert.match(CSS, /@keyframes twAdPing\{[^}]*transform:scale/)
})

test('㊻ 不新增路由 / 不新增依赖：页面只打既有棱镜接口与既有 trend/kline', () => {
  const calls = [...new Set([...PAGE.matchAll(/api\.(\w+)\(/g)].map((m) => m[1]))].sort()
  // 第二批起按拍板 Q2 复用既有 /tradewatcher/trend、/tradewatcher/kline（只读、无新路由）
  // v0.206.x：决策周期下拉复用既有 POST /tradewatcher/prism（action:'settings'），不是新路由
  for (const c of calls) assert.ok(['prismState', 'prismSelftest', 'detail', 'prismPosition', 'prismCapital', 'prismConstraints', 'prismSetInterval', 'prismRun', 'prismCash', 'trend', 'kline'].includes(c as string), `新增了接口调用 ${c}`)
  assert.ok(!/prismTrend|prismKline|fetch\(/.test(PAGE), '不得新增 prismTrend/prismKline 之类的新路由封装')
  // 决策周期走的仍是同一条路由 + 同一个 action
  const intervalBlock = API.slice(API.indexOf('prismSetInterval'), API.indexOf('prismSetIndustryLimits'))
  assert.match(intervalBlock, /\/tradewatcher\/prism/)
  assert.match(intervalBlock, /action: 'settings'/)
  assert.match(intervalBlock, /intervalSec/)
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { dependencies?: Record<string, string> }
  assert.deepEqual(pkg.dependencies ?? {}, {}, '不得新增运行时依赖')
})

test('㊼ 顶部 #N 与底部浮盈的「无源」路径都写 —（不写 0）', () => {
  assert.match(PAGE, /runsBadgeOf\(runsCount\)/)
  assert.match(PAGE, /floatSum === null \? '存在缺现价的持仓，浮盈合计不可算'/)
  assert.match(PAGE, /pnlTextOf\(floatSum\)/)
})

test('㊽ 反例注入：把默认值写进 usageOf 视图必被 ⑤ 抓到', () => {
  const injected = usageOf(85 as unknown as number, 1_240_226)
  assert.notEqual(injected.pctText, '68.9%')
  assert.equal(usageOf(1_800_000, 1_240_226).pctText, '68.9%')
})
