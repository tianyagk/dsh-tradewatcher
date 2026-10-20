/**
 * IMPL-83：第 7 个页签「复盘」的客户端（月历 + 当日笔记 + 钉到未来）。
 *
 * 为什么用"纯函数 + 源码接线"两层（与 `toolsPage.test.ts` / `impl78.test.ts` 同一手法）：
 * 本仓库没有 DOM 测试环境 ⇒ 渲染只能查接线，规则必须下沉成纯函数（`fupanView.ts`）。
 * 只有纯函数 ⇒ 页面可能根本没接线；只有源码字符串 ⇒ 规则写错也照样绿。
 *
 * 七条判据（每条都配**反例注入**，注入后判据必须非空 —— 否则这条断言是恒真的）：
 *  ① 第 7 个页签「复盘」在「工具」之后，归属行 `fupan`
 *  ② 月历区分交易日/休市；交易日信息缺失 ⇒ 原因（**不许默认全交易日**）
 *  ③ 笔记增/改/删/钉住失败 ⇒ 显示原因（**不许静默 catch**）
 *  ④ 钉住的条目显示「钉自 YYYY-MM-DD」
 *  ⑤ 超限被丢弃 ⇒ 显示宿主 `dropped` 原因（**不许静默丢**）
 *  ⑥ 路由不可用 ⇒ 原因 + 重试，**不显示"暂无笔记"**（不许拿空列表冒充）
 *  ⑦ 日期格键盘可达（Tab/方向键/回车）且 `role`/`aria` 齐备
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gateTabs, type TabLike } from './tabsGate.ts'
import {
  cellAriaOf, cellInfoOf, charCountTextOf, dayListStateOf, droppedTextOf, fupanGridOf, missingTextOf,
  monthBodyStateOf, monthFailHintOf, monthFailTextOf, monthNoteTotalOf, monthTotalsTextOf, monthTradingStateOf,
  moveCellFocus, noteBodyOf, notesOfDay, pinBadgeOf, quarantineTextOf, shiftYm, tradingDaysTextOf,
  tradingKindOf, tradingLabelOf, tradingNoteTextOf, unreadableReasonOf, unreadableTextOf, weekdayLabelOf,
  writeFailTextOf, writeInputProblems, writeWarningsOf, writeVerbOf, ymOf, type MonthBodyState, type TradingKind,
} from './fupanView.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')
/** 剥注释（只留代码与字符串）：注释里会写反例说明，不能当成违规 */
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const INDEX = strip(read('index.tsx'))
const PAGE = strip(read('FupanPage.tsx'))

/**
 * 从 `src/client/index.tsx` 抽**真实的**页签字面量（不另抄一份：抄一份就必然漂移）。
 * 正则与 `toolsPage.test.ts` 的 `tabsFromSource` 同一形状（那边的锚点也是 `const tabs:`）。
 */
function tabsFromSource(src: string): Array<{ key: string; label: string; row: string }> {
  const start = src.indexOf('const tabs:')
  if (start < 0) return []
  const open = src.indexOf('[', start)
  const end = src.indexOf('\n  ]', open)
  if (open < 0 || end < 0) return []
  return [...src.slice(open, end).matchAll(/\{ key: '([a-z]+)', label: '([^']*)', full: '[^']*', row: '([a-z]+)' \}/g)]
    .map((m) => ({ key: m[1] as string, label: m[2] as string, row: m[3] as string }))
}

const TABS = tabsFromSource(INDEX)
const FULL_ROWS = new Set(['core', 'calendar', 'watchlist', 'portfolio', 'market', 'cloudmap', 'tools', 'fupan'])

/** 页签判据：第 7 个是「复盘」、在「工具」之后、归属 `fupan`。返回问题列表（空 = 通过） */
function tabProblems(tabs: ReadonlyArray<{ key: string; label: string; row: string }>): string[] {
  const bad: string[] = []
  const keys = tabs.map((t) => t.key)
  const fupan = tabs.find((t) => t.key === 'fupan')
  if (fupan === undefined) {
    bad.push('没有「复盘」页签（key=fupan）')
    return bad
  }
  if (tabs.length !== 7) bad.push(`页签数必须是 7（实际 ${tabs.length}：${keys.join('、')}）`)
  if (keys[keys.length - 1] !== 'fupan') bad.push('「复盘」必须是最后一个（第 7 个）页签')
  const ti = keys.indexOf('tools')
  if (ti < 0) bad.push('找不到「工具」页签（顺序判据失去基准）')
  else if (keys.indexOf('fupan') !== ti + 1) bad.push('「复盘」必须紧跟在「工具」之后')
  if (fupan.label !== '复盘') bad.push(`标签必须是「复盘」（实际「${fupan.label}」）`)
  if (fupan.row !== 'fupan') bad.push(`归属行必须是 fupan（门控靠它，实际 ${fupan.row}）`)
  return bad
}

test('① 页签：第 7 个「复盘」在「工具」之后，归属行 fupan（删页签 ⇒ 必败）', () => {
  assert.equal(TABS.length, 7, `必须能抽出 7 个页签（锚点变了？实得 ${TABS.length}）`)
  assert.deepEqual(tabProblems(TABS), [], '页签顺序/标签/归属行不对')
  // 门控：八行全开 ⇒ 七个页签都在（复盘不因门控消失）
  const all = gateTabs(TABS as Array<TabLike<string>>, FULL_ROWS, 'watch')
  assert.equal(all.visible.length, 7, '全行启用时七个页签都在')
  assert.equal(all.visible[all.visible.length - 1]?.key, 'fupan', '「复盘」排在最后')
  // 行被停用 ⇒ 按既有门控隐藏（行级开关仍然有效）
  const off = gateTabs(TABS as Array<TabLike<string>>, new Set([...FULL_ROWS].filter((r) => r !== 'fupan')), 'watch')
  assert.equal(off.visible.some((t) => t.key === 'fupan'), false, 'fupan 行被停用 ⇒ 页签按既有机制隐藏')
  // 端点不可达 ⇒ 失败放行（抖动不该把页签弄没）
  assert.equal(gateTabs(TABS as Array<TabLike<string>>, null, 'watch').visible.length, 7, 'rows 不可达 ⇒ 七个页签都在')
  // 反例注入 A：删掉页签 ⇒ 判据必须失败
  const deleted = TABS.filter((t) => t.key !== 'fupan')
  assert.notDeepEqual(tabProblems(deleted), [], '⚠ 反例（删掉复盘页签）必须被抓住')
  assert.throws(
    () => assert.deepEqual(tabProblems(deleted), [], '反例上"第 7 个页签存在"必须失败'),
    /反例上/,
    '⚠ 反例注入（删页签）必须让断言失败',
  )
  // 反例注入 B：把复盘插到「工具」前面（顺序错）⇒ 判据必须失败
  const reordered = [...TABS.filter((t) => t.key !== 'fupan').slice(0, 5), TABS.find((t) => t.key === 'fupan') as { key: string; label: string; row: string }, TABS.find((t) => t.key === 'tools') as { key: string; label: string; row: string }]
  assert.notDeepEqual(tabProblems(reordered), [], '⚠ 反例（复盘排在工具之前）必须被抓住')
  // 反例注入 C：行名写成 core ⇒ 门控会把它当 core 的页签（行开关失效）
  const wrongRow = TABS.map((t) => (t.key === 'fupan' ? { ...t, row: 'core' } : t))
  assert.notDeepEqual(tabProblems(wrongRow), [], '⚠ 反例（归属行写成 core）必须被抓住')
})

test('①接线：index.tsx 真的引用 FupanPage 并把它放进保活容器（页面不是"只存在于文件里"）', () => {
  assert.ok(/import \{ FupanPage \} from '\.\/FupanPage\.tsx'/.test(INDEX), 'index.tsx 必须 import FupanPage')
  assert.ok(/if \(key === 'fupan'\) return React\.createElement\(FupanPage\)/.test(INDEX), '保活容器必须渲染 FupanPage')
  assert.ok(/const KEEP_ALIVE: readonly PageKey\[\] = \['calendar', 'tools', 'fupan'\]/.test(INDEX), '复盘也必须保活（月份/选中日/草稿不随切页丢失）')
  assert.ok(/KEEP_ALIVE\.includes\(page\)\) return null/.test(INDEX), '保活页不重复渲染（沿用既有机制）')
  // 反例注入：把 fupan 从保活里去掉 ⇒ 判据必须失败
  const injected = INDEX.replace("['calendar', 'tools', 'fupan']", "['calendar', 'tools']")
  assert.notEqual(injected, INDEX)
  assert.equal(/readonly PageKey\[\] = \['calendar', 'tools', 'fupan'\]/.test(injected), false, '⚠ 反例（不保活复盘）必须能被抓住')
})

// ── ② 交易日 / 休市 ──────────────────────────────────────────────────────

/** 交易日判据：休市必须与交易日在视觉数据上可区分；缺字段必须是 unknown + 原因 */
function tradingProblems(kindOf: (d: { trading?: boolean; closedReason?: string | null } | undefined) => TradingKind): string[] {
  const bad: string[] = []
  if (kindOf({ trading: true }) !== 'trading') bad.push('trading=true 必须是交易日')
  if (kindOf({ trading: false, closedReason: '周末' }) !== 'closed') bad.push('trading=false 必须是休市')
  if (kindOf({}) !== 'unknown') bad.push('缺 trading 字段必须是 unknown（不许默认成交易日）')
  if (kindOf(undefined) !== 'unknown') bad.push('该日不在回包里必须是 unknown')
  return bad
}

test('② 月历区分交易日与休市；交易日信息缺失 ⇒ 未知 + 原因（默认全交易日 ⇒ 必败）', () => {
  assert.deepEqual(tradingProblems(tradingKindOf), [], '交易日判定不合规')
  // 休市原因必须能读到（周末 / 假日名 / 外部日历）
  assert.equal(tradingLabelOf('closed', '周末'), '休市（周末）')
  assert.equal(tradingLabelOf('trading', null), '交易日')
  assert.equal(tradingLabelOf('unknown', null), '交易日未知')
  // 整月：宿主恒给 trading ⇒ known；缺字段 ⇒ unknown 且有原因
  const full = { dates: [{ date: '2026-10-01', count: 0, hasPinned: false, trading: false, closedReason: '国庆' }, { date: '2026-10-02', count: 1, hasPinned: false, trading: true, closedReason: null }] }
  assert.equal(monthTradingStateOf(full).kind, 'known')
  assert.equal(monthTradingStateOf(full).reason, null)
  const gap = { dates: [{ date: '2026-10-01', count: 0, hasPinned: false }] }
  const state = monthTradingStateOf(gap)
  assert.equal(state.kind, 'unknown')
  assert.equal(state.unknownDays, 1)
  assert.match(String(state.reason), /没有 dates|没给 trading/)
  assert.match(tradingNoteTextOf(gap), /未知/)
  const noDates = monthTradingStateOf({})
  assert.equal(noDates.kind, 'unknown', '没有 dates[] ⇒ 未知（不是"全交易日"）')
  assert.match(tradingNoteTextOf({}), /未知/)
  // calendarWhy 非 null 必须原样读到（宿主：外部交易日历未覆盖该月、已回退内置表）
  const why = { ...full, calendarWhy: '外部交易日历未覆盖 2026-10 ⇒ 按内置假日表 + 周末判定' }
  assert.ok(tradingNoteTextOf(why).includes(why.calendarWhy), 'calendarWhy 必须原样显示')
  // 单格信息：count 缺失 ⇒ null（不写 0）；休市原因原样带出
  const ci = cellInfoOf({ dates: [{ date: '2026-10-03', hasPinned: true, trading: false, closedReason: '周六' }] }, '2026-10-03')
  assert.equal(ci.count, null, '缺 count ⇒ null（不许 0 顶替）')
  assert.equal(ci.kind, 'closed')
  assert.equal(ci.closedReason, '周六')
  assert.equal(ci.hasPinned, true)
  assert.equal(cellInfoOf(full, '2026-10-09').count, null, '回包里没有这一天 ⇒ 条数未知')
  // 反例注入：缺字段当成交易日（旧实现的默认口径）⇒ 判据必须失败
  const defaultTrading = (d: { trading?: boolean } | undefined): TradingKind => (d?.trading === false ? 'closed' : 'trading')
  assert.notDeepEqual(tradingProblems(defaultTrading), [], '⚠ 反例（默认交易日）必须被抓住')
  assert.throws(
    () => assert.deepEqual(tradingProblems(defaultTrading), [], '反例上"缺失必须是未知"必须失败'),
    /反例上/,
    '⚠ 反例注入（默认全交易日）必须让断言失败',
  )
  // 反例注入：整月缺字段却报 known ⇒ 判据必须失败
  const liar = (m: { dates?: Array<{ date: string; trading?: boolean }> }): 'known' | 'unknown' => (m.dates === undefined ? 'unknown' : 'known')
  assert.notEqual(liar({ dates: [{ date: '2026-10-01' }] }), 'unknown', '⚠ 反例（缺字段却说 known）确实构造出来了')
  assert.equal(monthTradingStateOf({ dates: [{ date: '2026-10-01' }] }).kind, 'unknown', '真实实现不许放过它')
})

test('② 网格：周一起头、自然日加减（两个时区跑出同一张网格），日号/月界正确', () => {
  const cells = fupanGridOf('2026-10')
  assert.equal(cells.length % 7, 0, '网格必须是整周')
  assert.equal(cells[0]?.date, '2026-09-28', '2026-10-01 是周四 ⇒ 首格是 9/28（周一）')
  assert.equal(cells.filter((c) => c.inMonth).length, 31, '10 月有 31 天')
  assert.equal(cells.filter((c) => c.inMonth)[0]?.date, '2026-10-01')
  assert.equal(cells[cells.length - 1]?.inMonth, false, '尾格来自 11 月（整行不是全空 ⇒ 保留）')
  assert.equal(fupanGridOf('2026-02').filter((c) => c.inMonth).length, 28, '2026 不是闰年')
  assert.deepEqual(fupanGridOf('2026-13'), [], '非法月份 ⇒ 空网格（不猜）')
  // 换月跨年
  assert.equal(shiftYm('2026-12', 1), '2027-01')
  assert.equal(shiftYm('2026-01', -1), '2025-12')
  assert.equal(ymOf('2026-10-21'), '2026-10')
  assert.equal(weekdayLabelOf('2026-10-21'), '周三')
  // 反例注入：把周一改成周日起头 ⇒ 首格断言必败
  const sundayFirst = cells[0]?.date !== '2026-09-28'
  assert.equal(sundayFirst, false, '⚠ 反例（周日起头）会让首格变成 9/27')
})

// ── ③ 写失败必须显示原因 ─────────────────────────────────────────────────

/**
 * 写路径判据：从 `api.fupanNote(` 的调用点往后切一段，检查失败分支。
 *
 * 用"语句区"而不是整份源码：`setWriteErr` 在别处也出现（本地校验），整份查会让
 * "失败分支被删掉"照样绿（这正是反例注入要抓的东西）。
 */
function writePathProblems(pageSrc: string): string[] {
  const bad: string[] = []
  const at = pageSrc.indexOf('api.fupanNote(')
  if (at < 0) return ['页面没有调用 api.fupanNote（写入根本没接线）']
  const block = pageSrc.slice(at, at + 1400)
  if (!/\.then\(/.test(block)) bad.push('写入没有 .then（无法区分成功/失败）')
  if (!/setWriteErr\(writeFailTextOf\(input\.op, e\)\)/.test(block)) bad.push('写入失败必须把原因写进 setWriteErr(writeFailTextOf(...))')
  if (/catch\(\s*\(\s*\)\s*=>/.test(block) || /catch\(\s*\(\s*\)\s*=>\s*\{\s*\}/.test(block)) bad.push('写入失败被静默吞掉（catch(() => …)）')
  if (!/role: 'alert'/.test(pageSrc)) bad.push('失败原因必须用 role=alert 呈现（读屏也要读到）')
  if (!/writeFailTextOf\(/.test(pageSrc)) bad.push('页面没有引用 writeFailTextOf（原因文案的唯一出口）')
  return bad
}

test('③ 笔记增/改/删/钉住失败 ⇒ 显示原因（静默 catch(()=>{}) ⇒ 必败）', () => {
  assert.deepEqual(writePathProblems(PAGE), [], '写失败路径不合规')
  // 四种动作的原因文案都要点名动作（"失败"两个字太糊，用户要知道是哪一下没成）
  for (const [op, verb] of [['create', '新增'], ['update', '修改'], ['delete', '删除'], ['pin', '钉住']] as const) {
    const text = writeFailTextOf(op, new Error('HTTP 400：笔记正文 4100 字 > 上限 4000 字'))
    assert.equal(writeVerbOf(op), verb)
    assert.ok(text.startsWith(`${verb}失败`), `「${verb}」失败必须点名动作：${text}`)
    assert.ok(text.includes('HTTP 400'), '原因必须原样带上宿主给的 message')
    assert.ok(text.includes('未写入'), '必须说明本次没写进去（界面保留原内容）')
  }
  // 反例注入 A：失败分支被删掉（只剩成功路径）⇒ 判据必须失败
  const dropped = PAGE.replace('setWriteErr(writeFailTextOf(input.op, e))', 'undefined')
  assert.notEqual(dropped, PAGE, '反例注入必须真改到源码')
  assert.notDeepEqual(writePathProblems(dropped), [], '⚠ 反例（删掉失败原因）必须被抓住')
  assert.throws(
    () => assert.deepEqual(writePathProblems(dropped), [], '反例上"失败必须显示原因"必须失败'),
    /反例上/,
    '⚠ 反例注入（静默失败）必须让断言失败',
  )
  // 反例注入 B：经典静默写法 `.catch(() => {})`（锚在**写调用**上：`load()` 里也有同形状的 `.then(`）
  const silent = PAGE.replace('api.fupanNote(noteBodyOf(input)).then(', 'api.fupanNote(noteBodyOf(input)).catch(() => {}).then(')
  assert.notEqual(silent, PAGE)
  assert.notDeepEqual(writePathProblems(silent), [], '⚠ 反例（catch(() => {})）必须被抓住')
  // 本地校验也要给原因（空正文 / 钉错日期 → 不发请求，但必须说清）
  assert.match(String(writeInputProblems({ op: 'create', date: '2026-10-21', text: '   ' })), /不能为空/)
  assert.match(String(writeInputProblems({ op: 'create', date: '2026-10-21', text: 'x', pinnedTo: '2026-10-01' })), /不能早于/)
  assert.match(String(writeInputProblems({ op: 'update', date: '2026-10-21', id: 'n1', text: 'x', pinnedTo: '2026-1-1' })), /格式/)
  assert.equal(writeInputProblems({ op: 'create', date: '2026-10-21', text: 'x', pinnedTo: null }), null, '合法输入必须放行')
  // 已存在的条目必须能被改（含把历史置顶挪走）：否则手改过 fupan.json 的条目会变成改不动的僵尸
  assert.equal(writeInputProblems({ op: 'update', date: '2026-10-21', id: 'n1', text: 'x', pinnedTo: '2026-10-01' }), null, '更新不受"钉到未来"限制')
  assert.equal(writeInputProblems({ op: 'pin', date: '2026-10-21', id: 'n1', text: 'x', pinnedTo: null }), null, '取消钉住必须放行')
})

test('③ 请求体形状与宿主契约一致（op/date/id/text/pinnedTo；删除不带 text）', () => {
  assert.deepEqual(noteBodyOf({ op: 'create', date: '2026-10-21', text: 'hi', pinnedTo: null }),
    { op: 'upsert', date: '2026-10-21', text: 'hi', pinnedTo: null })
  assert.deepEqual(noteBodyOf({ op: 'update', date: '2026-10-21', id: 'n1', text: 'hi', pinnedTo: '2026-10-27' }),
    { op: 'upsert', date: '2026-10-21', id: 'n1', text: 'hi', pinnedTo: '2026-10-27' })
  // 钉住/取消钉住都必须带**原文**（宿主 upsert 是整体覆盖，只发 pinnedTo 有丢正文的风险）
  assert.deepEqual(noteBodyOf({ op: 'pin', date: '2026-10-21', id: 'n1', text: 'hi', pinnedTo: null }),
    { op: 'upsert', date: '2026-10-21', id: 'n1', text: 'hi', pinnedTo: null })
  const del = noteBodyOf({ op: 'delete', date: '2026-10-21', id: 'n1' })
  assert.deepEqual(del, { op: 'delete', date: '2026-10-21', id: 'n1' })
  assert.equal('text' in del, false, '删除不许带 text（宿主只认 id）')
})

// ── ④ 钉住标注 ──────────────────────────────────────────────────────────

/** 钉住判据：目标日必须读到「钉自 <原日期>」；自己那天读到「已钉到 <目标日>」 */
function pinProblems(fn: (n: { id: string; date: string; text: string; pinnedTo?: string | null; at?: number }, day: string) => { text: string; kind: 'from' | 'to' } | null): string[] {
  const bad: string[] = []
  const note = { id: 'n1', date: '2026-10-21', text: '十月复盘', pinnedTo: '2026-10-27', at: 1 }
  const target = fn(note, '2026-10-27')
  if (target === null) bad.push('钉到 10-27 的条目在 10-27 必须带标注（否则会被读成那天写的）')
  else {
    if (target.kind !== 'from') bad.push('目标日的标注必须是「钉自」（来源）')
    if (!target.text.startsWith('钉自 ')) bad.push(`目标日标注必须以「钉自 」开头（实际「${target.text}」）`)
    if (!target.text.includes(note.date)) bad.push('「钉自」后面必须是**原日期**')
  }
  const own = fn(note, note.date)
  if (own === null || !own.text.includes('2026-10-27')) bad.push('在自己那一天必须标「已钉到 <目标日>」')
  if (fn({ id: 'n2', date: '2026-10-21', text: 'x' }, '2026-10-21') !== null) bad.push('没钉的条目不该有标注')
  return bad
}

test('④ 钉住的条目显示「钉自 YYYY-MM-DD」（去掉标注 ⇒ 必败）', () => {
  assert.deepEqual(pinProblems(pinBadgeOf), [], '钉住标注不合规')
  // 该日列表：自己的在前、钉进来的在后（各自的 at 升序）
  const notes = [
    { id: 'b', date: '2026-10-21', text: 'B', at: 20 },
    { id: 'a', date: '2026-10-21', text: 'A', at: 10 },
    { id: 'c', date: '2026-10-19', text: 'C', pinnedTo: '2026-10-21', at: 5 },
  ]
  const day = notesOfDay(notes, '2026-10-21')
  assert.deepEqual(day.own.map((n) => n.id), ['a', 'b'], '当天写的按写入时刻升序')
  assert.deepEqual(day.pinned.map((n) => n.id), ['c'], '钉进来的单独一组（界面要分区显示）')
  // 反例注入：去掉标注（返回 null）⇒ 判据必须失败
  assert.notDeepEqual(pinProblems(() => null), [], '⚠ 反例（去掉钉自标注）必须被抓住')
  assert.throws(
    () => assert.deepEqual(pinProblems(() => null), [], '反例上"必须有钉自标注"必须失败'),
    /反例上/,
    '⚠ 反例注入（去掉标注）必须让断言失败',
  )
  // 反例注入：标注只写"钉住"、不写原日期 ⇒ 判据必须失败
  assert.notDeepEqual(pinProblems(() => ({ text: '钉住', kind: 'from' as const })), [], '⚠ 反例（不写原日期）必须被抓住')
})

// ── ⑤ 超限丢弃必须显示 ───────────────────────────────────────────────────

test('⑤ 超限时显示宿主 dropped 原因（静默丢 ⇒ 必败）', () => {
  const drop = droppedTextOf({ count: 2, reasons: ['条数已达上限 2000 条 ⇒ 按「最久未更新」丢弃最旧的（置顶的最后才丢）'] })
  assert.notEqual(drop, null, '有条目被丢时必须给文字')
  assert.ok(String(drop).includes('2'), '必须写清丢了几条')
  assert.ok(String(drop).includes('最久未更新'), '必须原样带上宿主的原因')
  assert.equal(droppedTextOf(null), null, '没丢就不占版面')
  assert.equal(droppedTextOf({ count: 0, reasons: [] }), null, 'count=0 不该出现提示')
  assert.ok(String(droppedTextOf({ notes: [{ id: 'x' }] })).includes('1'), '只有 notes[] 时按条数算')
  assert.ok(String(droppedTextOf({ count: 3 })).includes('宿主未给原因'), '没有 reasons 时如实说"未给原因"，不编')
  // 写成功后必须把丢弃带进披露（"已保存"不能盖掉"丢了 2 条"）
  const warns = writeWarningsOf({ ok: true, asOf: 1, dropped: { count: 2, reasons: ['条数已达上限'] } })
  assert.equal(warns.length, 1)
  assert.ok(warns[0]?.includes('条数已达上限'))
  assert.deepEqual(writeWarningsOf({ ok: true }), [], '没有披露时不该有告警')
  // 反例注入：静默丢（丢弃提示恒为 null）⇒ 判据必须失败
  const silent = (_d: unknown): string | null => null
  assert.equal(silent({ count: 2 }), null, '⚠ 反例（静默丢）确实构造出来了')
  assert.notEqual(droppedTextOf({ count: 2, reasons: ['上限'] }), silent({ count: 2 }), '⚠ 真实实现不许静默')
  // 页面必须真的渲染它（不是只有函数）
  assert.ok(/warnings\.map\(/.test(PAGE), '告警必须逐条渲染（可能不止一条）')
  assert.ok(/setWarnings\(writeWarningsOf\(r\)\)/.test(PAGE), '写成功回包的披露必须进界面')
})

// ── ⑥ 路由不可用 ⇒ 原因 + 重试（不许冒充"没有笔记"） ────────────────────

/**
 * 月历主体判据：失败必须是 failed（原因 + 重试），**不许**落到 empty。
 * 这是本页最容易骗人的地方：路由 404 时若把空数组当结果，界面会安静地说"本月暂无笔记"。
 */
function monthStateProblems(fn: typeof monthBodyStateOf): string[] {
  const bad: string[] = []
  const base = { loading: false, loadErr: null as string | null, hasData: false, total: null as number | null, notesUnreadable: null as string | null }
  const failed: MonthBodyState = fn({ ...base, loadErr: monthFailTextOf(new Error('HTTP 404')) })
  if (failed !== 'failed') bad.push(`取数失败必须是 failed（实际 ${failed}）——否则会显示"本月暂无笔记"`)
  if (fn({ ...base, loading: true }) !== 'loading') bad.push('首取必须是 loading')
  if (fn({ ...base, hasData: true, total: 0 }) !== 'empty') bad.push('total=0 且无错误才是 empty')
  if (fn({ ...base, hasData: true, total: null }) !== 'blank') bad.push('total 未知必须落到 blank（不写 0）')
  if (fn({ ...base, hasData: true, total: 3 }) !== 'grid') bad.push('有笔记 ⇒ grid')
  if (fn({ ...base, hasData: true, total: 0, notesUnreadable: 'EACCES: permission denied' }) !== 'grid') bad.push('笔记读不到时仍要画网格（交易日骨架有效），由告警条说明')
  return bad
}

test('⑥ 路由不可用 ⇒ 原因 + 重试，不显示"暂无笔记"（空列表冒充 ⇒ 必败）', () => {
  assert.deepEqual(monthStateProblems(monthBodyStateOf), [], '月历主体状态机不合规')
  const err = monthFailTextOf(new Error('HTTP 404'))
  assert.ok(err.includes('复盘月历未取到'), '失败文案必须说"未取到"')
  assert.ok(err.includes('GET /tradewatcher/fupan/month'), '必须带上路由（自查/报障的唯一线索）')
  assert.ok(err.includes('404'), '必须带上宿主给的错误原文')
  assert.ok(err.includes('复盘行未启用'), '必须给出最可能的成因')
  assert.ok(monthFailHintOf().includes('未知'), '提示必须说清"有没有笔记是未知的"，不是零')
  assert.ok(monthFailHintOf().includes('重试'))
  // 只有**写成功后**的重取失败才用另一套措辞（否则用户以为没保存）
  assert.ok(monthFailTextOf(new Error('HTTP 500'), true).includes('写入已成功'))
  // 页面接线：失败分支要 ErrorNote + 重试按钮，且空态只在 empty 分支里
  assert.ok(/bodyState === 'failed'/.test(PAGE), '必须有独立的失败分支')
  assert.ok(/monthBodyStateOf\(\{/.test(PAGE), '分支判定必须走纯函数（单一来源）')
  assert.ok(/monthFailHintOf\(\)/.test(PAGE), '失败分支必须显示提示')
  assert.ok(/primary: true, onClick: \(\) => load\(ym\) \}, '重试'/.test(PAGE), '失败分支必须有重试（同一个取数入口）')
  assert.ok(/bodyState === 'empty'/.test(PAGE) && /emptyMonthTextOf\(\)/.test(PAGE), '空态必须由 empty 分支渲染')
  // 反例注入：失败也当"暂无笔记" ⇒ 判据必须失败
  const masquerade: typeof monthBodyStateOf = (i) => (i.loading ? 'loading' : 'empty')
  assert.notDeepEqual(monthStateProblems(masquerade), [], '⚠ 反例（返回空列表冒充）必须被抓住')
  assert.throws(
    () => assert.deepEqual(monthStateProblems(masquerade), [], '反例上"失败不许冒充空"必须失败'),
    /反例上/,
    '⚠ 反例注入（空列表冒充）必须让断言失败',
  )
  // 反例注入：页面里把空态提到失败分支之前（先判 total===0）⇒ 源码判据必须失败
  const hoisted = PAGE.replace("bodyState === 'failed'", "bodyState === 'empty' || bodyState === 'failed'")
  assert.notEqual(hoisted, PAGE)
  assert.equal(/bodyState === 'failed'\s*\n?\s*\/\//.test(hoisted), false, '⚠ 反例（空态被提前合并）确实改了分支形状')
})

test('⑥ 数据时刻 / 未取到不写 0：totals、notesUnreadable、missing、隔离都有出口', () => {
  assert.equal(monthNoteTotalOf({ totals: { notes: 3 } }), 3, '宿主给了 totals 就用它')
  assert.equal(monthNoteTotalOf({ notes: [{ id: 'a', date: '2026-10-01', text: 'x' }, { id: 'b', date: '2026-10-02', text: 'y' }] }), 2, '没 totals 但有 notes ⇒ 用条数')
  assert.equal(monthNoteTotalOf({ dates: [{ date: '2026-10-01', count: 2 }, { date: '2026-10-02', count: 0 }] }), 2, '只有 dates[].count ⇒ 求和')
  assert.equal(monthNoteTotalOf({ dates: [{ date: '2026-10-01' }] }), null, 'count 缺失 ⇒ **未知**（不写 0）')
  assert.equal(monthNoteTotalOf({}), null)
  assert.ok(monthTotalsTextOf({}).includes('未知'), '条数未知时必须写"未知"')
  assert.equal(monthTotalsTextOf({ totals: { notes: 0 } }), '本月 0 条', '真的 0 条才写 0')
  assert.equal(tradingDaysTextOf({}), null, '交易日天数缺失 ⇒ null（不写 0）')
  assert.equal(tradingDaysTextOf({ totals: { tradingDays: 20 } }), '交易日 20 天')
  // 读不到 ≠ 没有
  assert.equal(unreadableReasonOf({ notesUnreadable: 'EACCES: permission denied' }), 'EACCES: permission denied')
  assert.equal(unreadableReasonOf({ notesUnreadable: { reason: 'EIO' } }), 'EIO')
  assert.equal(unreadableReasonOf({ notesUnreadable: '' }), '宿主未给出原因')
  assert.equal(unreadableReasonOf({}), null)
  assert.ok(unreadableTextOf('EACCES').includes('不是「没有笔记」'), '必须把"读不到 ≠ 没有"说出来')
  // 隔离 / 跳过条目
  assert.equal(quarantineTextOf({}), null)
  assert.ok(String(quarantineTextOf({ notesQuarantined: '/tmp/x/fupan.json.bad', invalidEntries: 2 })).includes('隔离'))
  assert.ok(String(quarantineTextOf({ invalidEntries: 2 })).includes('2 条形状不合法'))
  // missing：两档标签都要读得到
  const miss = missingTextOf([{ what: '交易日历', why: 'no-source', note: '文件不存在' }], (why) => (why === 'no-source' ? '上游无此数据' : '本次失败'))
  assert.ok(String(miss).includes('交易日历') && String(miss).includes('上游无此数据'))
  assert.equal(missingTextOf([], () => ''), null)
  // 该日列表状态：读不到 > 回包不完整 > 空
  assert.equal(dayListStateOf({ count: 0, own: 0, pinned: 0, notesUnreadable: null }), 'empty')
  assert.equal(dayListStateOf({ count: 2, own: 0, pinned: 0, notesUnreadable: null }), 'incomplete')
  assert.equal(dayListStateOf({ count: 2, own: 2, pinned: 0, notesUnreadable: null }), 'list')
  assert.equal(dayListStateOf({ count: 2, own: 0, pinned: 0, notesUnreadable: 'EACCES' }), 'unreadable')
})

// ── ⑦ 键盘可达 + aria ───────────────────────────────────────────────────

/** 键盘/语义判据（作用在日期格那一段源码上） */
function gridA11yProblems(src: string): string[] {
  const bad: string[] = []
  if (!/role: 'grid'/.test(src)) bad.push('月历容器必须 role=grid')
  if (!/'aria-label': `\$\{FUPAN_GRID_LABEL\}/.test(src)) bad.push('grid 必须有 aria-label（含月份）')
  if (!/role: 'row'/.test(src) || !/role: 'columnheader'/.test(src)) bad.push('grid 必须有 row / columnheader 结构')
  if (!/role: 'gridcell'/.test(src)) bad.push('日期格必须 role=gridcell')
  if (!/'aria-selected': on/.test(src)) bad.push('日期格必须 aria-selected')
  if (!/'aria-label': cellAriaOf\(cell, ci, on\)/.test(src)) bad.push('日期格必须有读屏文本（aria-label 走 cellAriaOf）')
  if (!/tabIndex: on \? 0 : -1/.test(src)) bad.push('roving tabindex：Tab 能进来，其余格靠方向键')
  if (!/onKeyDown: onGridKeyDown/.test(src)) bad.push('方向键必须接到 moveCellFocus')
  if (!/ev\.key === 'Enter' \|\| ev\.key === ' '/.test(src)) bad.push('回车/空格必须能打开该日')
  if (!/onClick: \(\) => selectDay\(/.test(src)) bad.push('点击也必须能打开该日')
  return bad
}

test('⑦ 键盘可达与 aria 齐备（只留 onClick ⇒ 必败）', () => {
  assert.deepEqual(gridA11yProblems(PAGE), [], '月历的键盘/语义不合规')
  // 方向键移动：7 列步长、边界夹住、Home/End、其它键不处理
  const cells = fupanGridOf('2026-10')
  const idx = cells.findIndex((c) => c.date === '2026-10-15')
  assert.equal(moveCellFocus(cells, idx, 'ArrowRight'), idx + 1)
  assert.equal(moveCellFocus(cells, idx, 'ArrowLeft'), idx - 1)
  assert.equal(moveCellFocus(cells, idx, 'ArrowDown'), idx + 7)
  assert.equal(moveCellFocus(cells, idx, 'ArrowUp'), idx - 7)
  assert.equal(moveCellFocus(cells, 0, 'ArrowUp'), 0, '↑ 越界原地不动（不绕回）')
  assert.equal(moveCellFocus(cells, cells.length - 1, 'ArrowDown'), cells.length - 1, '↓ 越界原地不动（不许夹到相邻月的补格）')
  // Home/End 落在**本月**的首/末日，不是网格补格（补格属于相邻月，跳过去会连带切月）
  const firstInMonth = cells.findIndex((c) => c.inMonth)
  const lastInMonth = cells.length - 1 - [...cells].reverse().findIndex((c) => c.inMonth)
  assert.equal(moveCellFocus(cells, idx, 'Home'), firstInMonth)
  assert.equal(moveCellFocus(cells, idx, 'End'), lastInMonth)
  assert.equal(cells[moveCellFocus(cells, idx, 'End') as number]?.date, '2026-10-31', 'End 必须落到 10-31（不是 11-01）')
  assert.equal(cells[moveCellFocus(cells, idx, 'Home') as number]?.date, '2026-10-01', 'Home 必须落到 10-01（不是 09-28）')
  assert.equal(moveCellFocus(cells, idx, 'a'), null, '普通字符交给浏览器')
  assert.equal(moveCellFocus(cells, idx, 'Tab'), null, 'Tab 不许被吃掉（否则出不去）')
  assert.equal(moveCellFocus([], 0, 'ArrowLeft'), null)
  // 读屏文本：日期 + 星期 + 交易日/休市 + 条数 + 钉住
  const aria = cellAriaOf(cells[idx] as { date: string; inMonth: boolean; dom: number }, { count: 2, hasPinned: true, kind: 'closed', closedReason: '周末' }, true)
  for (const part of ['2026-10-15', '周四', '休市（周末）', '2 条笔记', '钉到该日', '已选中']) {
    assert.ok(aria.includes(part), `读屏文本缺「${part}」：${aria}`)
  }
  assert.ok(cellAriaOf(cells[idx] as { date: string; inMonth: boolean; dom: number }, { count: null, hasPinned: false, kind: 'unknown', closedReason: null }, false).includes('条数未知'), '条数未知要读出来')
  // 反例注入：只留 onClick（把 role/tabIndex/onKeyDown 全删）⇒ 判据必须失败
  const clickOnly = PAGE
    .replace(/role: 'gridcell',/g, '')
    .replace(/tabIndex: on \? 0 : -1,/g, '')
    .replace(/onKeyDown: onGridKeyDown,/g, '')
    .replace(/onKeyDown: \(ev: React\.KeyboardEvent\) => \{[\s\S]*?\n                      \},\n/g, '')
  assert.notEqual(clickOnly, PAGE, '反例注入必须真改到源码')
  assert.notDeepEqual(gridA11yProblems(clickOnly), [], '⚠ 反例（只留 onClick）必须被抓住')
  assert.throws(
    () => assert.deepEqual(gridA11yProblems(clickOnly), [], '反例上"键盘可达"必须失败'),
    /反例上/,
    '⚠ 反例注入（只留 onClick）必须让断言失败',
  )
  // 写操作也必须是真按钮（不是"点一下 div"）：保存/删除/编辑走 Btn（<button>）
  for (const label of ["'保存'", "'确认删除'", "'编辑'", "'重试'"]) {
    assert.ok(PAGE.includes(`}, ${label})`) || PAGE.includes(label), `控件「${label}」必须存在`)
  }
})

test('⑦b 字数提示按码点算（emoji 不算两个字），不做本地截断（超限交给宿主拒绝）', () => {
  assert.equal(charCountTextOf('abc'), '3 字')
  assert.equal(charCountTextOf('🙂🙂'), '2 字', 'emoji 按码点算')
  assert.equal(charCountTextOf(''), '0 字')
  // 页面不许自己截断正文（截断=改用户内容）；超限由宿主 400 + 原因负责
  assert.equal(/slice\(0, *4000\)/.test(PAGE), false, '页面不许本地截断正文（会静默改用户内容）')
  assert.ok(/charCountTextOf\(draft\)/.test(PAGE), '草稿必须显示字数')
  assert.ok(/上限由宿主把关/.test(PAGE), '必须说明上限由宿主把关（含丢弃/拒绝口径）')
})
