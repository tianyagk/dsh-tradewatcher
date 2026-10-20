/**
 * IMPL-87：复盘页联动持仓交易记录（**只读展示**）—— 结构性判据（纯函数 + 源码接线）。
 *
 * 为什么用两层（与 `impl83.test.ts` / `toolsPage.test.ts` 同一手法）：本仓库没有 DOM 测试环境
 * ⇒ 渲染只能查接线，规则必须下沉成纯函数（`fupanTrades.ts` / `tradeJump.ts`）。
 * 只有纯函数 ⇒ 页面可能根本没接线；只有源码字符串 ⇒ 规则写错也照样绿。
 *
 * 八条判据，**每条都配反例注入**（注入后判据必须非空 —— 否则这条断言是恒真的）：
 *  ① 月历标记：`●` 与 `▲n` 并存时形状正确、只用形状区分（**注入：用颜色区分 ⇒ 必败**）
 *  ② 读取失败不画三角（**注入：失败也画 `▲0` ⇒ 必败**）
 *  ③ 汇总行只有「买入 N 笔 · 卖出 M 笔」（**注入：加净额/净买入 ⇒ 必败**）
 *  ④ 当日盈亏不加来源标注（**注入：加「来自持仓核算」⇒ 必败**）
 *  ⑤ 盈亏缺失 ⇒ `未取到`（**注入：写 0 ⇒ 必败**）
 *  ⑥ `truncated` ⇒ 「另有 N 笔未显示」（**注入：静默截断 ⇒ 必败**）
 *  ⑦ 点击跳转 + 静态高亮 + 内存态（**注入：改 URL / 写偏好 ⇒ 必败**）
 *  ⑧ 本页不接隐身档（**注入：读取遮蔽开关 ⇒ 必败**）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FUPAN_MARK_NOTE, FUPAN_MARK_TRADE, FUPAN_TRADE_LEGEND, FUPAN_TRADE_ROW_LIMIT,
  dayMarksTextOf, dayPnlTextOf, daySummaryTextOf, monthTradeCountOf, moreTextOf, noteMarkOf, sideTextOf,
  tradeCountOf, tradeListFailTextOf, tradeListOf, tradeMarkOf, tradeRowTextsOf, tradesFailReasonOf,
  tradesFailTextOf,
} from './fupanTrades.ts'
import { requestTradeJump, subscribeTradeJump, takeTradeFocus } from './tradeJump.ts'
import { TW_CSS } from './styles.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')
/** 剥注释（只留代码与字符串）：注释里会写反例说明，不能当成违规 */
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const PAGE = strip(read('FupanPage.tsx'))
const TRADE_VIEW = strip(read('fupanTrades.ts'))
const JUMP = strip(read('tradeJump.ts'))
const INDEX = strip(read('index.tsx'))
const PORT = strip(read('PortfolioPage.tsx'))
const API = strip(read('api.ts'))

/** 客户端运行时源码（排除测试）——用于"这条 api 只被这一行消费"的判据 */
function clientSources(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(name) && !/\.test\.ts$/.test(name)) out.push({ rel: name, text: strip(readFileSync(p, 'utf8')) })
    }
  }
  walk(here)
  return out
}

// ── ① 月历标记：只用形状 ─────────────────────────────────────────────────

/** 标记判据：形状正确、并存并排、`0` 不画、不夹带颜色语义。返回问题清单（空 = 通过） */
function markProblems(marksOf: (i: { noteCount: number | null; tradeCount: number | null }) => string): string[] {
  const bad: string[] = []
  const both = marksOf({ noteCount: 2, tradeCount: 3 })
  if (both !== `${FUPAN_MARK_NOTE} ${FUPAN_MARK_TRADE}3`) bad.push(`笔记+交易并存时必须是「● ▲3」（实际「${both}」）`)
  if (marksOf({ noteCount: 2, tradeCount: null }) !== FUPAN_MARK_NOTE) bad.push('只有笔记时必须只画 ●')
  if (marksOf({ noteCount: null, tradeCount: 3 }) !== `${FUPAN_MARK_TRADE}3`) bad.push('只有交易时必须只画 ▲3')
  if (marksOf({ noteCount: 0, tradeCount: 0 }) !== '') bad.push('都没有时必须空（不许画空壳标记）')
  if (marksOf({ noteCount: null, tradeCount: 0 }) !== '') bad.push('0 笔交易不许画三角（▲0 会读成"有记录但为 0"）')
  if (marksOf({ noteCount: null, tradeCount: null }) !== '') bad.push('未知/失败不许画标记')
  for (const out of [both, marksOf({ noteCount: 1, tradeCount: 1 })]) {
    if (/#[0-9a-f]{3,6}|rgb\(|--tw-up|--tw-down|tw-up|tw-down/i.test(out)) bad.push(`标记串里不许带颜色（实际「${out}」）`)
  }
  return bad
}

/** 标记渲染节点判据：那个 span 上不许挂颜色（颜色留给涨跌）。返回问题清单 */
function markNodeProblems(src: string): string[] {
  const line = src.split('\n').find((l) => l.includes("className: 'tw-fp-marks'"))
  if (line === undefined) return ['月历格子里没有渲染标记的节点（className: tw-fp-marks）']
  const bad: string[] = []
  if (/color|--tw-up|--tw-down|dirClass|data-tone/i.test(line)) bad.push(`标记节点上挂了颜色/涨跌语义：${line.trim()}`)
  return bad
}

test('① 月历标记：● 与 ▲n 并存并排、只用形状（用颜色区分 ⇒ 必败）', () => {
  assert.deepEqual(markProblems(dayMarksTextOf), [], '标记形状不合规')
  // 形状本身就是契约：图例与格子共用同一份常量（不另抄一份字面量）
  assert.equal(FUPAN_MARK_NOTE, '●')
  assert.equal(FUPAN_MARK_TRADE, '▲')
  assert.equal(noteMarkOf(0), '', '0 条笔记不画')
  assert.equal(tradeMarkOf(0), '', '0 笔交易不画')
  assert.equal(tradeMarkOf(3), '▲3')
  // 图例：一行，两项（笔记 / 交易笔数），与格子用的是同一对形状
  assert.equal(FUPAN_TRADE_LEGEND.map((x) => `${x.mark} ${x.label}`).join('　'), '● 笔记　▲ 交易笔数')
  // 页面接线：格子里的标记走纯函数，且渲染节点不带颜色
  assert.ok(/dayMarksTextOf\(\{ noteCount: ci\.count, tradeCount: ci\.trades \}\)/.test(PAGE), '格子的标记必须走 dayMarksTextOf（单一来源）')
  assert.deepEqual(markNodeProblems(PAGE), [], '标记节点挂了颜色')
  assert.ok(/FUPAN_TRADE_LEGEND\.map\(/.test(PAGE), '月历下方必须渲染那一行图例')
  // 反例注入 A：用颜色区分（只上色、不出形状）⇒ 判据必须失败
  const colorOnly = (): string => ''
  assert.notDeepEqual(markProblems(colorOnly), [], '⚠ 反例（用颜色区分、不出形状）必须被抓住')
  assert.throws(
    () => assert.deepEqual(markProblems(colorOnly), [], '反例上"必须用形状区分"必须失败'),
    /反例上/,
    '⚠ 反例注入（用颜色区分）必须让断言失败',
  )
  // 反例注入 B：把颜色挂回标记节点 ⇒ 源码判据必须失败
  const colored = PAGE.replace("className: 'tw-fp-marks', 'aria-hidden': 'true'", "className: 'tw-fp-marks', 'aria-hidden': 'true', style: { color: 'var(--tw-up)' }")
  assert.notEqual(colored, PAGE, '反例注入必须真改到源码')
  assert.notDeepEqual(markNodeProblems(colored), [], '⚠ 反例（标记上色）必须被抓住')
})

// ── ② 读取失败不画三角 ───────────────────────────────────────────────────

test('② 读取失败不画三角（失败也画 ▲0 ⇒ 必败）', () => {
  // readFailed ⇒ 笔数按"未取到"处理（用户决定：失败等同 0 笔，但**不许**画 ▲0）
  assert.equal(tradeCountOf({ readFailed: true, trades: [{}, {}], total: 2 }), null, 'readFailed ⇒ 笔数未知')
  assert.equal(dayMarksTextOf({ noteCount: null, tradeCount: tradeCountOf({ readFailed: true, total: 2 }) }), '', '读取失败不画三角')
  // 回包没有 trades[] / 没有 total ⇒ 同样是"未取到"
  assert.equal(tradeCountOf({ summary: { buys: 1 } }), null)
  assert.equal(tradeCountOf(null), null)
  // 正常回包：顶层 total（不受渲染截断影响）优先，其次 trades[] 长度
  assert.equal(tradeCountOf({ trades: [{}, {}, {}], total: 520 }), 520)
  assert.equal(tradeCountOf({ trades: [{}, {}, {}] }), 3)
  // 页面：失败与"未取到"都不画三角（走同一个 tradeCountIn，失败分支不并进笔数）
  assert.ok(/readFailed === true \? 'failed' : 'ok'/.test(PAGE), '日面板必须把 readFailed 当失败处理')
  assert.ok(/cached === undefined \|\| cached\.kind === 'failed' \? null : tradeCountOf\(cached\.payload\)/.test(PAGE), '失败/未取到时笔数必须是 null（不画三角）')
  // 反例注入：失败画 ▲0 ⇒ 判据必须失败
  const failDrawsZero = (i: { noteCount: number | null; tradeCount: number | null }): string =>
    [noteMarkOf(i.noteCount), `${FUPAN_MARK_TRADE}${i.tradeCount ?? 0}`].filter((s) => s !== '').join(' ')
  assert.equal(failDrawsZero({ noteCount: null, tradeCount: null }), '▲0', '⚠ 反例构造失败：失败应当被画成 ▲0')
  assert.notDeepEqual(markProblems(failDrawsZero), [], '⚠ 反例（失败画 ▲0）必须被抓住')
  assert.throws(
    () => assert.deepEqual(markProblems(failDrawsZero), [], '反例上"失败不许画三角"必须失败'),
    /反例上/,
    '⚠ 反例注入（▲0）必须让断言失败',
  )
})

// ── ③ 汇总行只有买卖笔数 ─────────────────────────────────────────────────

/** 汇总判据：只有「买入 N 笔 · 卖出 M 笔」，任何净额口径都不许出现 */
function summaryProblems(summaryOf: (s: { buys?: number; sells?: number; buy?: { count?: number }; sell?: { count?: number } } | null | undefined) => string): string[] {
  const bad: string[] = []
  const out = summaryOf({ buys: 3, sells: 2 })
  if (out !== '买入 3 笔 · 卖出 2 笔') bad.push(`汇总行形状必须是「买入 3 笔 · 卖出 2 笔」（实际「${out}」）`)
  if (/净买入|净卖出|净额|净流入|净流出/.test(out)) bad.push(`汇总行不许出现净额口径（实际「${out}」）`)
  const miss = summaryOf(null)
  if (miss !== '买入 未取到 · 卖出 未取到') bad.push(`缺字段必须写「未取到」（实际「${miss}」）`)
  if (/\b0\b/.test(miss)) bad.push('缺字段不许写 0')
  return bad
}

test('③ 汇总行只有「买入 N 笔 · 卖出 M 笔」（加净额/净买入 ⇒ 必败）', () => {
  assert.deepEqual(summaryProblems(daySummaryTextOf), [], '汇总行不合规')
  // 两种回包形状都认（宿主最终口径是 buy/sell 子对象）
  assert.equal(daySummaryTextOf({ buy: { count: 4 }, sell: { count: 1 } }), '买入 4 笔 · 卖出 1 笔')
  assert.equal(daySummaryTextOf({ buys: 0, sells: 0 }), '买入 0 笔 · 卖出 0 笔', '真的 0 笔才写 0')
  // 页面：汇总行走纯函数（页面里一个字都不许自己拼净额）
  assert.ok(/daySummaryTextOf\(tradePayload\?\.summary\)/.test(PAGE), '汇总行必须走 daySummaryTextOf')
  assert.equal(/净买入|净卖出|净额/.test(PAGE), false, '页面不许出现净额口径')
  // 反例注入：加净买入 ⇒ 判据必须失败
  const withNet = (s: { buys?: number; sells?: number } | null | undefined): string => `${daySummaryTextOf(s)} · 净买入 1 笔`
  assert.notDeepEqual(summaryProblems(withNet), [], '⚠ 反例（加净买入）必须被抓住')
  assert.throws(
    () => assert.deepEqual(summaryProblems(withNet), [], '反例上"只有买卖笔数"必须失败'),
    /反例上/,
    '⚠ 反例注入（净额）必须让断言失败',
  )
})

// ── ④⑤ 当日盈亏：只给数值 / 缺值不许写 0 ───────────────────────────────

/** 盈亏判据：只给数值、不带来源标注、缺值 ⇒ 未取到（不写 0） */
function pnlProblems(pnlOf: (v: number | null | undefined) => string): string[] {
  const bad: string[] = []
  const out = pnlOf(1234.5)
  if (out !== '+1234.50') bad.push(`数值必须直接显示（期望「+1234.50」，实际「${out}」）`)
  if (/来自|核算|记账|来源|口径|持仓|流水/.test(out)) bad.push(`不许加来源标注/口径句（实际「${out}」）`)
  if (pnlOf(-8) !== '-8.00') bad.push('负值必须带符号直接显示')
  for (const missing of [null, undefined]) {
    if (pnlOf(missing) !== '未取到') bad.push(`缺值必须写「未取到」（实际「${pnlOf(missing)}」）`)
  }
  return bad
}

test('④ 当日盈亏不加来源标注（加「来自持仓核算」⇒ 必败）', () => {
  assert.deepEqual(pnlProblems(dayPnlTextOf), [], '盈亏文案不合规')
  assert.ok(/dayPnlTextOf\(tradePayload\?\.dayPnl\)/.test(PAGE), '盈亏必须走 dayPnlTextOf')
  // 反例注入：加来源标注 ⇒ 判据必须失败
  const annotated = (v: number | null | undefined): string => `${dayPnlTextOf(v)}（来自持仓核算）`
  assert.notDeepEqual(pnlProblems(annotated), [], '⚠ 反例（加来源标注）必须被抓住')
  assert.throws(
    () => assert.deepEqual(pnlProblems(annotated), [], '反例上"不加来源标注"必须失败'),
    /反例上/,
    '⚠ 反例注入（来源标注）必须让断言失败',
  )
})

test('⑤ 盈亏缺失 ⇒ 未取到（写 0 ⇒ 必败）', () => {
  assert.equal(dayPnlTextOf(null), '未取到')
  assert.equal(dayPnlTextOf(undefined), '未取到')
  assert.equal(dayPnlTextOf(Number.NaN), '未取到')
  assert.equal(dayPnlTextOf(0), '0.00', '真的是 0 才写 0（与"未取到"分开）')
  // 反例注入：缺值写 0 ⇒ 判据必须失败
  const zero = (v: number | null | undefined): string => (v === null || v === undefined ? '0' : dayPnlTextOf(v))
  assert.notDeepEqual(pnlProblems(zero), [], '⚠ 反例（缺值写 0）必须被抓住')
  assert.throws(
    () => assert.deepEqual(pnlProblems(zero), [], '反例上"缺值必须写未取到"必须失败'),
    /反例上/,
    '⚠ 反例注入（写 0）必须让断言失败',
  )
})

// ── ⑥ 截断披露 ─────────────────────────────────────────────────────────

/** 截断判据：超过 500 笔必须显示"另有 N 笔未显示"，不许静默截断 */
function truncationProblems(listOf: typeof tradeListOf): string[] {
  const bad: string[] = []
  const many = Array.from({ length: 520 }, (_, i) => ({ ledgerId: `l${i}` }))
  const list = listOf({ trades: many, total: 520 })
  if (list === null) return ['有 trades[] 时不该返回 null']
  if (list.rows.length !== FUPAN_TRADE_ROW_LIMIT) bad.push(`最多渲染 ${FUPAN_TRADE_ROW_LIMIT} 行（实际 ${list.rows.length}）`)
  if (list.more !== 20) bad.push(`未显示笔数必须是 20（实际 ${list.more}）`)
  if (moreTextOf(list.more) !== '另有 20 笔未显示') bad.push(`必须显示「另有 20 笔未显示」（实际「${moreTextOf(list.more)}」）`)
  // 宿主自己截断（只给 500 条但 total=800）⇒ 也要如实算出来
  const hostCut = listOf({ trades: many.slice(0, 500), total: 800, truncated: { shown: 500, total: 800 } })
  if (hostCut === null || hostCut.more !== 300) bad.push(`宿主已截断时必须补出 300 笔（实际 ${hostCut?.more}）`)
  // 没有 trades[] ⇒ 明细未取到（null），不许画成空列表
  if (listOf({ summary: { buys: 1 } }) !== null) bad.push('没有 trades[] 时必须返回 null（明细未取到）')
  return bad
}

test('⑥ truncated ⇒ 显示「另有 N 笔未显示」（静默截断 ⇒ 必败）', () => {
  assert.deepEqual(truncationProblems(tradeListOf), [], '截断披露不合规')
  assert.equal(moreTextOf(0), null, '没截断不占版面')
  assert.equal(FUPAN_TRADE_ROW_LIMIT, 500, '上限写死 500（与宿主对齐）')
  assert.equal(tradeListFailTextOf(), '交易明细未取到', '没有 trades[] 时给"未取到"，不是"没有交易"')
  // 页面：截断提示必须渲染
  assert.ok(/moreTextOf\(tradeList\.more\)/.test(PAGE), '页面必须算 more')
  assert.ok(/tradeMoreText === null/.test(PAGE) && /tw-fp-meta' \}, tradeMoreText\)/.test(PAGE), '页面必须渲染截断提示')
  // 反例注入：静默截断（more 恒为 0）⇒ 判据必须失败
  const silent: typeof tradeListOf = (p) => {
    const rows = (p?.trades ?? []).slice(0, FUPAN_TRADE_ROW_LIMIT)
    return { rows, more: 0 }
  }
  assert.notDeepEqual(truncationProblems(silent), [], '⚠ 反例（静默截断）必须被抓住')
  assert.throws(
    () => assert.deepEqual(truncationProblems(silent), [], '反例上"超 500 必须披露"必须失败'),
    /反例上/,
    '⚠ 反例注入（静默截断）必须让断言失败',
  )
})

// ── ⑦ 跳转 + 静态高亮 + 内存态 ──────────────────────────────────────────

/** 跳转模块的**禁止面**：URL / 路由 / 存储 / 偏好 / 网络都不许碰（状态只在内存） */
const JUMP_FORBIDDEN = ['location', 'history.', 'pushState', 'replaceState', 'URLSearchParams', 'localStorage', 'sessionStorage', 'document.cookie', 'setPrefs', 'api.', 'fetch(', 'XMLHttpRequest']

function jumpProblems(src: string): string[] {
  const bad: string[] = []
  for (const token of JUMP_FORBIDDEN) if (src.includes(token)) bad.push(`跳转模块出现了「${token}」（状态只许在内存）`)
  return bad
}

/** 高亮判据：必须有底色条、且不带动效（这条选择器下的**每一条**规则都要看 —— 后写的能覆盖前面的） */
function highlightProblems(css: string): string[] {
  const bodies = [...css.matchAll(/\.tw-wrow\[data-focus=true\]\{([^}]*)\}/g)].map((m) => m[1] as string)
  if (bodies.length === 0) return ['流水行缺少静态高亮规则（.tw-wrow[data-focus=true]）']
  const bad: string[] = []
  if (!/background:/.test(bodies[0] as string)) bad.push('高亮必须靠底色条（background）')
  for (const body of bodies) if (/animation|transition/.test(body)) bad.push('高亮不许带动效（不闪烁）')
  return bad
}

test('⑦ 点击跳转 + 静态高亮 + 内存态（改 URL / 写偏好 ⇒ 必败）', () => {
  // 行为：请求 → 通知 → 消费一次即清空（切页后回来不会再弹一次）
  assert.equal(takeTradeFocus(), null, '初始状态必须是空的（模块级不残留）')
  let notified = 0
  const off = subscribeTradeJump(() => { notified += 1 })
  requestTradeJump({ ledgerId: 'l1', day: '2026-10-20' })
  assert.equal(notified, 1, '请求必须通知订阅者（切页的唯一触发点）')
  off()
  requestTradeJump({ ledgerId: 'l2', day: '2026-10-21' })
  assert.equal(notified, 1, '退订后不该再收到')
  assert.deepEqual(takeTradeFocus(), { ledgerId: 'l2', day: '2026-10-21' })
  assert.equal(takeTradeFocus(), null, '只读一次（切页后回来不会又弹一次流水）')
  // 源码：跳转模块不碰 URL / 存储 / 偏好 / 网络
  assert.deepEqual(jumpProblems(JUMP), [], '跳转模块碰了不该碰的东西')
  // 接线：点某笔发请求 → 容器切页 → 持仓页消费并开流水 + 高亮
  assert.ok(/requestTradeJump\(\{ ledgerId: row\.ledgerId, day: selected \}\)/.test(PAGE), '点某笔必须发一次内存跳转请求')
  assert.ok(/type: 'button',\s*\n\s*className: 'tw-fp-trade'/.test(PAGE), '逐笔行必须是原生 button（键盘可达）')
  assert.ok(/subscribeTradeJump\(\(\) => goPage\('portfolio'\)\)/.test(INDEX), '页签容器必须订阅并切到持仓页')
  assert.ok(/takeTradeFocus\(\)/.test(PORT), '持仓页必须在挂载时把高亮目标取走')
  assert.ok(/focusId: jumpFocus\?\.ledgerId \?\? null/.test(PORT), '高亮目标必须来自内存态（不来自 URL/偏好）')
  assert.ok(/openLedger\(\{ mode: 'all', id: '', title: '交易流水' \}\)/.test(PORT), '跳过来必须直接开「交易流水」（不筛分组/持仓）')
  assert.ok(/'data-focus': focused \? 'true' : undefined/.test(PORT), '命中的那一笔必须加静态标记')
  assert.deepEqual(highlightProblems(TW_CSS), [], '高亮样式不合规')
  // 反例注入 A：跳转模块改 URL ⇒ 判据必须失败
  for (const injected of [
    `${JUMP}\nwindow.history.pushState({}, '', '/portfolio')\n`,
    `${JUMP}\nwindow.location.hash = 'portfolio'\n`,
    `${JUMP}\nlocalStorage.setItem('tw.portfolio.focus', 'l1')\n`,
    `${JUMP}\napi.setPrefs({ ledgerFocus: 'l1' })\n`,
  ]) {
    assert.notEqual(injected, JUMP)
    assert.notDeepEqual(jumpProblems(injected), [], `⚠ 反例（${injected.slice(JUMP.length).trim()}）必须被抓住`)
  }
  assert.throws(
    () => assert.deepEqual(jumpProblems(`${JUMP}\nwindow.history.pushState({}, '', '/portfolio')\n`), [], '反例上"只许内存态"必须失败'),
    /反例上/,
    '⚠ 反例注入（改 URL）必须让断言失败',
  )
  // 反例注入 B：高亮带动效（闪烁）⇒ 判据必须失败
  assert.notDeepEqual(highlightProblems(`${TW_CSS}\n.tw-wrow[data-focus=true]{animation:tw-breathe 1s infinite}`), [], '⚠ 反例（高亮闪烁）必须被抓住')
})

test('⑦b 逐笔行文本：时间/名称/买卖/数量/价格/费用齐备；缺字段写「未取到」不写 0', () => {
  const full = tradeRowTextsOf({
    ledgerId: 'l9', ts: Date.parse('2026-10-20T09:31:05+08:00'), time: '09:31',
    name: '贵州茅台', side: 'buy', qty: 100, price: 1680.5, fee: 5,
  }, 0)
  assert.deepEqual(
    [full.time, full.name, full.side, full.qty, full.price, full.fee],
    ['09:31', '贵州茅台', '买', '100 份', '@ 1680.50', '费 5.00'],
  )
  assert.equal(full.ledgerId, 'l9')
  assert.ok(full.aria.includes('贵州茅台') && full.aria.includes('买') && full.aria.includes('费 5.00'), '读屏文本必须是一整行')
  // `side` 缺失时用中文 `direction`；两者都缺失 ⇒ 未取到
  assert.equal(sideTextOf({ side: 'adjust' }), '调整')
  assert.equal(sideTextOf({ side: 'sell', direction: '卖' }), '卖')
  assert.equal(sideTextOf({ direction: '调整' }), '调整')
  assert.equal(sideTextOf({ side: null }), '未取到')
  assert.equal(sideTextOf({ side: 'transfer' }), 'transfer', '未知取值原样显示（不猜）')
  // 价格/费用/数量缺失（宿主允许 null）⇒ 未取到，不写 0
  const bare = tradeRowTextsOf({ ledgerId: 'l1', ts: Date.parse('2026-10-20T14:02:00+08:00'), name: '甲', side: 'sell', qty: null, price: null, fee: null }, 3)
  assert.deepEqual([bare.qty, bare.price, bare.fee], ['未取到', '未取到', '未取到'])
  assert.equal(bare.time, '14:02:00', '没有 time 文本时用 ts 按北京时间格式化（不是浏览器时区）')
  assert.equal(bare.side, '卖')
  // 流水 id 缺失 ⇒ key 用序号兜底（仍可跳，只是无法高亮）
  const noId = tradeRowTextsOf({ name: '乙' }, 7)
  assert.equal(noId.ledgerId, '')
  assert.equal(noId.key, '#7')
  // 失败/未取到的一句话（不是"这一天没有交易"）
  assert.equal(tradesFailTextOf(), '交易记录未取到')
  assert.equal(tradesFailReasonOf({ readFailed: true, readFailedReason: 'EACCES: permission denied' }), 'EACCES: permission denied')
  assert.equal(tradesFailReasonOf({ readFailed: true }), null)
})

// ── ⑧ 不接隐身档 ───────────────────────────────────────────────────────

/** 隐身档判据：本页不读遮蔽开关，也不走会被遮蔽的金额格式化出口 */
const MASK_TOKENS = ['viewMode', 'incognito', 'moneyMask', 'MoneyMasked', 'setMoneyMask', '遮蔽', '已隐藏', 'fmtMoneySigned(', 'fmtAmt(', 'fmtRaw(']

function incognitoProblems(files: ReadonlyArray<{ rel: string; text: string }>): string[] {
  const bad: string[] = []
  for (const f of files) {
    for (const token of MASK_TOKENS) if (f.text.includes(token)) bad.push(`${f.rel} 出现了「${token}」（本页永远明文，不接隐身档）`)
  }
  return bad
}

test('⑧ 本页不接隐身档（读取遮蔽开关 / 用被遮蔽的金额出口 ⇒ 必败）', () => {
  assert.deepEqual(incognitoProblems([
    { rel: 'FupanPage.tsx', text: PAGE },
    { rel: 'fupanTrades.ts', text: TRADE_VIEW },
    { rel: 'tradeJump.ts', text: JUMP },
  ]), [], '复盘交易侧碰到隐身档了')
  // 反例注入 A：读取遮蔽开关 ⇒ 判据必须失败
  const readsMask = `${PAGE}\nconst hidden = prefs.viewMode === 'incognito'\n`
  assert.notDeepEqual(incognitoProblems([{ rel: 'FupanPage.tsx', text: readsMask }]), [], '⚠ 反例（读遮蔽开关）必须被抓住')
  assert.throws(
    () => assert.deepEqual(incognitoProblems([{ rel: 'FupanPage.tsx', text: readsMask }]), [], '反例上"不接隐身档"必须失败'),
    /反例上/,
    '⚠ 反例注入（读遮蔽开关）必须让断言失败',
  )
  // 反例注入 B：改用会被遮蔽的金额出口（等于间接接上隐身档）⇒ 判据必须失败
  const masked = `${TRADE_VIEW}\nconst money = fmtMoneySigned(dayPnl)\n`
  assert.notDeepEqual(incognitoProblems([{ rel: 'fupanTrades.ts', text: masked }]), [], '⚠ 反例（被遮蔽的金额出口）必须被抓住')
})

// ── 线缆与归属 ─────────────────────────────────────────────────────────

test('线缆：api.fupanTrades 只有一条路由字面量，且只被复盘页消费（行归属唯一）', () => {
  const at = API.indexOf('fupanTrades(')
  assert.ok(at >= 0, 'api.ts 必须提供 fupanTrades')
  // 只取这一个方法的方法体（到下一个方法之前）：切太宽会把邻居的路由也算进来
  const body = API.slice(at, API.indexOf('\n  },', at))
  const routes = [...body.matchAll(/['"`](\/tradewatcher\/[^'"`?\s]*)/g)].map((m) => m[1] as string)
  assert.deepEqual(routes, ['/tradewatcher/fupan/trades'], `函数体里只许这一条路由字面量（实际 ${JSON.stringify(routes)}）`)
  assert.ok(/day=\$\{encodeURIComponent\(day\)\}/.test(body), 'day 必须做 URL 编码')
  // 消费方唯一：只有 FupanPage.tsx（行归属按调用点推导，见 rowOwnership.test.ts）
  const consumers = clientSources().filter((f) => f.text.includes('api.fupanTrades(')).map((f) => f.rel)
  assert.deepEqual(consumers, ['FupanPage.tsx'], `api.fupanTrades 只许被复盘页消费（实际 ${consumers.join('、') || '无'}）`)
  // 反例注入：在别处调用 ⇒ 判据必须失败
  const elsewhere = [...clientSources().map((f) => ({ ...f })), { rel: 'TopBar.tsx', text: 'const x = api.fupanTrades(day)' }]
  assert.notDeepEqual(
    elsewhere.filter((f) => f.text.includes('api.fupanTrades(')).map((f) => f.rel),
    ['FupanPage.tsx'],
    '⚠ 反例（别处也有消费者）必须被抓住',
  )
})

test('接线：按日惰性取数（打开某日才取）+ 月历带笔数就优先用它 + 失败给一句话', () => {
  // 惰性：只在"这一天还没有缓存"时取一次；换日期才取新的一天
  assert.ok(/api\.fupanTrades\(selected\)/.test(PAGE), '必须按选中日取数')
  assert.ok(/if \(tradesByDay\[selected\] !== undefined\) return/.test(PAGE), '已有缓存就不再取（按日惰性）')
  assert.ok(/setTradesByDay\(\(prev\) => \(\{ \.\.\.prev, \[selected\]: \{ kind: 'ok', payload: r \} \}\)\)/.test(PAGE), '取到后必须落进缓存')
  // 月历：宿主哪天带上 dates[].trades 就优先用它（当前不带 ⇒ 走按日缓存）
  const month = { dates: [{ date: '2026-10-20', count: 1, hasPinned: false, trading: true, trades: 4 }, { date: '2026-10-21', count: 0, trading: true }] }
  assert.equal(monthTradeCountOf(month, '2026-10-20'), 4, '宿主带上是笔数就用它')
  assert.equal(monthTradeCountOf(month, '2026-10-21'), null, '没带 ⇒ null（不写 0）')
  assert.equal(monthTradeCountOf(month, '2026-10-22'), null, '回包里没有这一天 ⇒ null')
  assert.equal(monthTradeCountOf(null, '2026-10-20'), null)
  assert.ok(/monthTradeCountOf\(month, date\)/.test(PAGE), '月历必须优先读宿主给的笔数')
  // 失败：一句话 + 完整原因进 title（不是"这一天没有交易"）
  assert.ok(/tradesFailTextOf\(\)/.test(PAGE), '整份回包取不到时必须给一句话')
  assert.ok(/title: tradeFailReason \?\? undefined/.test(PAGE), '完整原因进 title')
  assert.ok(/tradeList === null/.test(PAGE) && /tradeListFailTextOf\(\)/.test(PAGE), '只有汇总没有明细时也必须说"未取到"')
  // 反例注入：把惰性去掉（每次都取）⇒ 断言必须失败
  const eager = PAGE.replace("if (tradesByDay[selected] !== undefined) return", "if (false) return")
  assert.notEqual(eager, PAGE)
  assert.equal(/if \(tradesByDay\[selected\] !== undefined\) return/.test(eager), false, '⚠ 反例（去掉缓存判断）确实改了源码')
})
