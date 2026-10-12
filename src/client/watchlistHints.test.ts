/**
 * v0.69.1（task-16）：自选页红框里的两行常驻提示已删 —— 事实不许丢，但降级信息降到悬停层。
 *
 * 红框内容：
 *   ① `板块涨跌与 α 本次未取到 · 17:38:06 · 上游暂时不可用（熔断中，约 11 分钟后自动重试）`
 *   ② `YTD 缺 1 项`
 * 逐条判定：② 行内已显示 `YTD —`（事实可见）⇒ 直接删；① 受影响的行级控件（「板块 —」「α —」）
 * 原来只写"见上方一行"⇒ 那行删掉后会**悬空** ⇒ 原因改挂到这两格的 `title` 与 `aria-label`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { indReasonOf } from './watchlistView.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (): string => readFileSync(join(here, 'WatchlistPage.tsx'), 'utf8')

/** 判据：返回**违规清单**（真源码必须为空；反例必须非空） */
function permanentHintViolations(src: string): string[] {
  const bad: string[] = []
  // ① 面板级「板块涨跌与 α」常驻行：渲染守卫与可见文本都不许再有
  if (/indState\.status === 'error'/.test(src)) bad.push('板块面板级常驻行的渲染守卫仍在')
  if (/}, `板块涨跌与 α 本次未取到 · /.test(src)) bad.push('板块面板级常驻文案仍在渲染位置')
  // ② 「YTD 缺 N 项」整块（含它专用的三个变量）
  if (/\}, `YTD 缺 \$\{/.test(src)) bad.push('「YTD 缺 N 项」仍在渲染')
  for (const v of ['ytdMissingCount', 'ytdSummary', 'ytdRows']) {
    if (src.includes(v)) bad.push(`已删块的专用变量仍在：${v}`)
  }
  // ③ 悬空指路：那行删了，"见上方一行"就成了死引用
  for (const ptr of ['见上方「板块涨跌与 α」一行', '见左侧「板块 —」的说明']) {
    if (src.includes(ptr)) bad.push(`悬空指路仍在：${ptr}`)
  }
  return bad
}

test('① 两行常驻提示整块已删（不留空容器、不留悬空指路、不留专用变量）', () => {
  const src = read()
  assert.deepEqual(permanentHintViolations(src), [], `两行必须删干净（实际 ${JSON.stringify(permanentHintViolations(src))}）`)
  // 删的是"那两行"，不是把整页的缺失提示都删了：其它缺失态该在的还在
  assert.ok(src.includes('YTD 单次上限'), 'YTD 上限那行（另一件事）不受影响')
  assert.ok(src.includes('ytd.error !== null'), 'YTD 整条失败那行（另一件事）不受影响')
  assert.ok(src.includes("'板块 —'"), '行内缺失仍是「板块 —」（事实在格上可见）')
  // 反例注入：把面板级那行加回常驻 ⇒ 判据必须非空
  const injected = src.replace('export function WatchlistPage(props: {',
    "export function WatchlistPage(props: {\n  d: 1,")
    .replace('  return React.createElement(', "  const reintroduced = indState.status === 'error' ? React.createElement('div', null, `板块涨跌与 α 本次未取到 · ${indState.at}`) : null\n  return React.createElement(")
  assert.notEqual(injected, src, '反例注入必须真改到源码')
  assert.notDeepEqual(permanentHintViolations(injected), [], '⚠ 反例（长句加回常驻）必须被判据抓住')
  assert.throws(
    () => assert.deepEqual(permanentHintViolations(injected), [], '反例上"两行必须删干净"必须失败'),
    /反例上/,
    '⚠ 反例注入（长句加回常驻位置）必须让断言失败',
  )
})

test('② 降级事实仍可达：原因挂在「板块 —」「α —」的 title **与** aria-label 上', () => {
  const src = read()
  // 纯函数：上游状态、失败时刻、"会不会自动重试"三件事实都在
  const ts = Date.parse('2026-10-12T17:38:06+08:00')
  const s1 = indReasonOf({ at: ts, error: '上游暂时不可用（熔断中，约 11 分钟后自动重试）' })
  assert.ok(s1.includes('板块涨跌与 α 本次未取到'), '要说明是什么没取到')
  assert.ok(s1.includes('熔断中') && s1.includes('11 分钟'), `要带上游状态与重试时间（实际 ${s1}）`)
  assert.ok(/17:38:06/.test(s1), `要带失败时刻，且**一律北京时间**（TZ=UTC 下也得是 17:38:06，实际 ${s1}）`)
  assert.ok(s1.includes('自动重试'), '要说明会自己重试（不必用户做什么）')
  assert.equal(indReasonOf({ at: null, error: null }).includes('时刻未知'), true, '没有时刻时如实写"时刻未知"')
  assert.equal(indReasonOf({ at: null, error: null }).includes('上游不可用'), true, '没有原因时给通用词（不留空）')
  // 接线：两格 × (title + aria-label) = 4 处
  const hits = src.match(/\$\{indReasonOf\(indState\)\}/g) ?? []
  assert.equal(hits.length, 4, `原因必须同时出现在两格的 title 与 aria-label（实际 ${hits.length} 处）`)
  assert.ok(/title: `板块当日涨幅未取到 —— \$\{indReasonOf\(indState\)\}`/.test(src), '板块格的 title 要带原因')
  assert.ok(/'aria-label': `板块当日涨幅未取到 —— \$\{indReasonOf\(indState\)\}`/.test(src), '板块格的 aria-label 要带原因')
  // 反例注入：把「板块 —」那格的 title/aria 去掉（= 只剩一格 —，原因无处可读）⇒ 判据必须失败
  const injected = src.replace("                                title: `板块当日涨幅未取到 —— ${indReasonOf(indState)}`,\n", '')
  assert.notEqual(injected, src, '反例注入必须真改到源码')
  assert.equal((injected.match(/\$\{indReasonOf\(indState\)\}/g) ?? []).length, 3, '⚠ 反例（少一处）必须能被数出来')
  assert.throws(
    () => assert.equal((injected.match(/\$\{indReasonOf\(indState\)\}/g) ?? []).length, 4, '反例上"四处都要有"必须失败'),
    /反例上/,
    '⚠ 反例注入（原因不可达）必须让断言失败',
  )
})
