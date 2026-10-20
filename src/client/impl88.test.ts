/**
 * IMPL-88：复盘页**常驻文案精简**（用户口径「简洁有效：可标记可不标记的一律不标」）。
 *
 * 为什么用"纯函数 + 源码接线"两层（与 `impl83.test.ts` / `impl87.test.ts` 同一手法）：
 * 本仓库没有 DOM 测试环境 ⇒ "这段文案还在不在页面上"只能查接线；"空态是否真的只剩一行短句"
 * "失败与 dropped 文案是否还在"则同时查纯函数与页面接线。
 * 只有纯函数 ⇒ 页面可能还在渲染旧文案；只有源码字符串 ⇒ 短句写空也照样绿。
 *
 * 四条判据（每条配反例注入，注入后判据必须非空 —— 否则这条断言是恒真的）：
 *  ① 五段常驻文案不再出现（注入任一条塞回 ⇒ 必败）
 *  ② 图例 `title`/`aria-label` 仍含「法定调休」（注入删掉 ⇒ 必败）
 *  ③ 空态仍各留一行短句（注入连空态也删 ⇒ 必败）
 *  ④ 失败态与 `dropped` 文案仍在（注入删掉 ⇒ 必败）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TRADING_CALIBER_HINT, emptyDayTextOf, emptyMonthTextOf, writeFailTextOf, writeWarningsOf } from './fupanView.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')
/** 剥注释（只留代码与字符串）：注释里会写反例说明，不能当成违规 */
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const PAGE = strip(read('FupanPage.tsx'))

/** 客户端运行时源码（排除测试）：常驻文案不许在任何一个文件里复活 */
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

// ── ① 五段常驻文案：删掉就不许回来 ─────────────────────────────────────

/**
 * 被删文案的**特征串**。缺一条都算回退（`法定调休` 只在 `FupanPage.tsx` 里禁：
 * 它允许作为图例的悬停/读屏披露出现在 `fupanView.ts`，见 ②）。
 */
const REMOVED_IN_ANY_FILE = ['local:fupan.json', '点月历里任意一天', '在下方写一条并点', '上限由宿主把关'] as const

/** 判据：扫描集合里是否还有被删文案（空 = 干净） */
function removedCopyProblems(files: ReadonlyArray<{ rel: string; text: string }>): string[] {
  const bad: string[] = []
  for (const f of files) {
    for (const token of REMOVED_IN_ANY_FILE) {
      if (f.text.includes(token)) bad.push(`${f.rel} 仍有被删的常驻文案「${token}」`)
    }
    // ② 交易日口径长段：页面不许再渲染（连"未知原因"也不常驻）
    if (f.rel === 'FupanPage.tsx') {
      if (f.text.includes('法定调休')) bad.push('FupanPage.tsx 仍有交易日口径长段（法定调休）')
      if (f.text.includes('tradingNoteTextOf(')) bad.push('FupanPage.tsx 仍在渲染交易日口径长段（tradingNoteTextOf）')
      // ① 数据时刻后的源串：页面不许再拼 month.source
      if (f.text.includes('month.source') || f.text.includes('数据口径（由宿主给出）')) bad.push('FupanPage.tsx 仍在渲染数据源串（month.source）')
      if (f.text.includes('data-state')) bad.push('FupanPage.tsx 仍有交易日口径行的 data-state')
    }
  }
  return bad
}

test('① 五段常驻文案不再出现（塞回任一条 ⇒ 必败）', () => {
  assert.deepEqual(removedCopyProblems(clientSources()), [], '仍有被删的常驻文案')
  // 反例注入：四条"任何文件都不许有"的特征串，各塞回一次
  for (const token of REMOVED_IN_ANY_FILE) {
    const injected = [...clientSources(), { rel: 'FupanPage.tsx', text: `const x = '${token}'\n` }]
    assert.notDeepEqual(removedCopyProblems(injected), [], `⚠ 反例（塞回「${token}」）必须被抓住`)
  }
  // 反例注入：页面重新渲染交易日口径长段 / 数据源串 ⇒ 判据必须失败
  for (const injected of [
    `${PAGE}\nconst t = tradingNoteTextOf(month)\n`,
    `${PAGE}\nconst s = month.source\n`,
    `${PAGE}\nconst w = '法定调休'\n`,
  ]) {
    assert.notDeepEqual(removedCopyProblems([{ rel: 'FupanPage.tsx', text: injected }]), [], `⚠ 反例（${injected.slice(PAGE.length + 1).trim()}）必须被抓住`)
  }
  assert.throws(
    () => assert.deepEqual(removedCopyProblems([{ rel: 'FupanPage.tsx', text: `${PAGE}\nconst x = '上限由宿主把关'\n` }]), [], '反例上"常驻文案不许回来"必须失败'),
    /反例上/,
    '⚠ 反例注入（塞回底部上限说明）必须让断言失败',
  )
})

// ── ② 图例：口径披露搬进 title/aria-label ─────────────────────────────

/** 判据：图例必须可悬停、可 Tab、可被读屏读到那条口径 */
function legendProblems(pageSrc: string, hint: string): string[] {
  const bad: string[] = []
  if (!hint.includes('法定调休')) bad.push('口径常量必须写明「法定调休可能被判成交易日」')
  if (!hint.includes('临时休市')) bad.push('口径常量必须写明「临时休市」')
  if (!/title: TRADING_CALIBER_HINT/.test(pageSrc)) bad.push('图例的 title 必须挂口径常量（悬停可读）')
  if (!/'aria-label': `图例：交易日、休市、交易日未知。\$\{TRADING_CALIBER_HINT\}`/.test(pageSrc)) {
    bad.push('图例的 aria-label 必须含口径常量（读屏也要读到）')
  }
  if (!/role: 'note',\s*\n\s*tabIndex: 0,\s*\n\s*title: TRADING_CALIBER_HINT/.test(pageSrc)) {
    bad.push('图例必须可聚焦（Tab 到才能被读屏读到那条口径）')
  }
  return bad
}

test('② 图例 title/aria-label 仍含「法定调休」（删掉 ⇒ 必败）', () => {
  assert.deepEqual(legendProblems(PAGE, TRADING_CALIBER_HINT), [], '图例口径披露不合规')
  assert.ok(TRADING_CALIBER_HINT.includes('法定调休/临时休市可能被判成交易日'), `口径常量必须原样保留这句：${TRADING_CALIBER_HINT}`)
  // 反例注入 A：删掉 title ⇒ 悬停读不到
  const noTitle = PAGE.replace('      title: TRADING_CALIBER_HINT,\n', '')
  assert.notEqual(noTitle, PAGE, '反例注入必须真改到源码')
  assert.notDeepEqual(legendProblems(noTitle, TRADING_CALIBER_HINT), [], '⚠ 反例（删掉 title）必须被抓住')
  // 反例注入 B：删掉 aria-label ⇒ 读屏读不到
  const noAria = PAGE.replace(/      'aria-label': `图例：[^`]*`,\n/, '')
  assert.notEqual(noAria, PAGE, '反例注入必须真改到源码')
  assert.notDeepEqual(legendProblems(noAria, TRADING_CALIBER_HINT), [], '⚠ 反例（删掉 aria-label）必须被抓住')
  // 反例注入 C：口径常量被改成不含"法定调休"的泛泛之谈 ⇒ 判据必须失败
  assert.notDeepEqual(legendProblems(PAGE, '交易日与休市按宿主交易日历判定'), [], '⚠ 反例（口径常量丢了披露内容）必须被抓住')
  assert.throws(
    () => assert.deepEqual(legendProblems(noTitle, TRADING_CALIBER_HINT), [], '反例上"口径必须可悬停读到"必须失败'),
    /反例上/,
    '⚠ 反例注入（删掉 title）必须让断言失败',
  )
})

// ── ③ 空态：各留一行短句 ───────────────────────────────────────────────

/** 判据：空态只有一行短句（不许再跟说明句），且页面真的渲染它 */
function emptyStateProblems(pageSrc: string, month: { title: string }, day: { title: string }): string[] {
  const bad: string[] = []
  if (month.title !== '本月暂无笔记') bad.push(`月历空态短句必须是「本月暂无笔记」（实际「${month.title}」）`)
  if (day.title !== '这一天还没有笔记') bad.push(`右栏空态短句必须是「这一天还没有笔记」（实际「${day.title}」）`)
  if ('hint' in month || 'hint' in day) bad.push('空态不许再带说明句（只留一行短句）')
  if (!/emptyMonthTextOf\(\)\.title/.test(pageSrc)) bad.push('月历空态必须仍在页面上渲染那一行短句')
  if (!/emptyDayTextOf\(\)\.title/.test(pageSrc)) bad.push('右栏空态必须仍在页面上渲染那一行短句')
  return bad
}

test('③ 空态仍有一行短句（连空态一起删 ⇒ 必败）', () => {
  assert.deepEqual(emptyStateProblems(PAGE, emptyMonthTextOf(), emptyDayTextOf()), [], '空态文案不合规')
  // 反例注入 A：短句被写空 ⇒ 判据必须失败
  assert.notDeepEqual(emptyStateProblems(PAGE, { title: '' }, { title: '' }), [], '⚠ 反例（空态写空）必须被抓住')
  // 反例注入 B：仍带说明句（hint 回来了）⇒ 判据必须失败
  assert.notDeepEqual(emptyStateProblems(PAGE, { title: '本月暂无笔记', hint: '点月历里任意一天' } as unknown as { title: string }, emptyDayTextOf()), [], '⚠ 反例（说明句回来）必须被抓住')
  // 反例注入 C：把空态分支整段删掉（只剩网格）⇒ 判据必须失败
  const noEmpty = PAGE.replace("? React.createElement(EmptyHint, null,\n                  React.createElement('span', { style: { fontWeight: 600, display: 'block' } }, emptyMonthTextOf().title),\n                )", ': null')
  assert.notEqual(noEmpty, PAGE, '反例注入必须真改到源码')
  assert.notDeepEqual(emptyStateProblems(noEmpty, emptyMonthTextOf(), emptyDayTextOf()), [], '⚠ 反例（连空态也删）必须被抓住')
  assert.throws(
    () => assert.deepEqual(emptyStateProblems(noEmpty, emptyMonthTextOf(), emptyDayTextOf()), [], '反例上"空态必须留一行短句"必须失败'),
    /反例上/,
    '⚠ 反例注入（删掉空态）必须让断言失败',
  )
})

// ── ④ 失败态与 dropped 文案：不动 ──────────────────────────────────────

/** 判据：失败态（原因 + 重试）与 dropped 披露都必须还在页面上 */
function failCopyProblems(pageSrc: string): string[] {
  const bad: string[] = []
  for (const token of ['monthFailTextOf(', 'monthFailHintOf()', 'writeFailTextOf(', "role: 'alert'", 'ErrorNote']) {
    if (!pageSrc.includes(token)) bad.push(`失败态文案/结构缺失：${token}`)
  }
  for (const token of ['writeWarningsOf(r)', 'warnings.map(']) {
    if (!pageSrc.includes(token)) bad.push(`dropped 披露缺失：${token}`)
  }
  return bad
}

test('④ 失败态与 dropped 文案仍在（删掉 ⇒ 必败）', () => {
  assert.deepEqual(failCopyProblems(PAGE), [], '失败态/dropped 文案被删了')
  // 纯函数侧：文案本身仍给原因（行为不变，删掉的只是常驻说明段）
  assert.match(writeFailTextOf('create', new Error('HTTP 400：正文超限')), /新增失败.*HTTP 400/)
  const warnings = writeWarningsOf({ ok: true, dropped: { count: 2, reasons: ['条数已达上限 2000 条'] } })
  assert.equal(warnings.length, 1, 'dropped 必须仍有一条披露')
  assert.ok((warnings[0] as string).includes('丢弃了 2 条'), 'dropped 文案必须写清丢了几条')
  // 反例注入：删掉写失败原因 / 删掉 dropped 披露 ⇒ 判据必须失败
  for (const injected of [
    PAGE.replace('setWriteErr(writeFailTextOf(input.op, e))', 'undefined'),
    PAGE.replace('setWarnings(writeWarningsOf(r))', 'undefined'),
    PAGE.replace('monthFailHintOf()', "''"),
  ]) {
    assert.notEqual(injected, PAGE, '反例注入必须真改到源码')
    assert.notDeepEqual(failCopyProblems(injected), [], '⚠ 反例（删掉失败/dropped 文案）必须被抓住')
  }
  assert.throws(
    () => assert.deepEqual(failCopyProblems(PAGE.replace('setWarnings(writeWarningsOf(r))', 'undefined')), [], '反例上"dropped 披露必须在"必须失败'),
    /反例上/,
    '⚠ 反例注入（删掉 dropped 披露）必须让断言失败',
  )
})
