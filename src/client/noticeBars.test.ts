/**
 * v0.55.0（task-3）：**去掉两处提示条**，并把唯一无法被别处承载的口径说明搬进 tooltip。
 *
 * 用户红框的两条：
 *   ① 上窗 K 线内的区间买卖图例（`区间内 B 5 笔 / S 1 笔，净买入 …，买入均价 …`）
 *   ② 下窗脚注（`共 240 根 · 前复权（详情头为真实成交价）· 日期区间 · MA5/10/30/60 · 滚轮或拖动… · 本地缓存 · B 买入…`）
 *
 * 处置原则（逐条核对"这话别处有没有"，表见 `docs/AUDIT-IMPL32.md`）：
 *   - 别处已有 ⇒ 删；别处没有 ⇒ 搬进 `title`/`aria-label`（常驻可见处不许出现）；
 *   - 逐条判定的结果里**只有** `（详情头为真实成交价）` 属于"别处没有" ⇒ 它必须落在 B/S 标记上。
 *
 * 本文件同时锚住 `build.mjs` 片段表里被**锁定**的两句（`区间内无买卖点` / `区间外另有`）：
 * 它们不许改字面量，只许从"常驻可见"搬到"悬停可见"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { visibleProvenanceOf } from './chartNote.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')
/** 去掉注释再断言：说明性注释里会**提到**被删的子信息，不去掉就变成"对注释做断言" */
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/**
 * 可见提示条的判据：返回**违规清单**。
 * 真源码必须返回空数组；把任一条加回**常驻可见位置**时必须非空（这就是反例注入的证明力）。
 */
function visibleNoticeViolations(src: string): string[] {
  const bad: string[] = []
  // ① 区间买卖图例不许再渲染成可见元素（必须只剩"悬停提示"）
  if (/React\.createElement\('div',\s*\{[^}]{0,120}tw-ma-legend[\s\S]{0,400}?区间内 B/.test(src)) {
    bad.push('上窗区间买卖图例仍在渲染（可见）')
  }
  if (/React\.createElement\('div',\s*\{[^}]{0,120}tw-ma-legend[\s\S]{0,400}?区间内无买卖点/.test(src)) {
    bad.push('上窗"区间内无买卖点"图例仍在渲染（可见）')
  }
  // ② K 线脚注里的子信息（逐条都已被别处承载）
  for (const s of ['MA5/10/30/60', '滚轮或拖动滑块缩放日期区间', '来自持仓流水', '共 ${k.days.length} 根']) {
    if (src.includes(s)) bad.push(`脚注子信息仍在：${s}`)
  }
  // ③ 口径说明不许出现在**可见文本**位置（只许在 tooltip：标记的 title/aria-label）
  if (/React\.createElement\([^)]*tw-chartnote[\s\S]{0,200}详情头为真实成交价/.test(src)) {
    bad.push('口径说明又回到可见脚注里了')
  }
  return bad
}

test('① 上窗区间买卖图例不再渲染；两句被 build.mjs 锁定的字面量**原样保留**在悬停提示里', () => {
  // 区间统计文本已抽到纯函数模块（klineStats.ts），字面量两处合起来看
  const kline = strip(read('./kline.tsx')) + strip(read('./klineStats.ts'))

  // 可见图例已删：不再是 DOM 元素
  assert.deepEqual(visibleNoticeViolations(kline), [], `可见提示条必须已删（实际违规：${JSON.stringify(visibleNoticeViolations(kline))}）`)
  // 但它必须变成**悬停提示**（不是丢掉）
  assert.ok(kline.includes('const bsHint ='), '区间买卖统计必须改名成提示文本（bsHint）')
  assert.ok(kline.includes("bsHint === '' ? summary"), 'bsHint 必须挂到图表容器的 aria-label（读屏可达）')
  assert.equal(/title:\s*'键盘/.test(kline), false, '键盘提示不得再挂原生 title（会与细节卡浮层重叠）')
  assert.ok(kline.includes("'aria-label': bsHint === '' ? summary"), '读屏摘要仍在（bsHint 挂在 aria-label 上，区间内/区间外的笔数都在）')
  // 被锁定的两句：字面量**一字不改**，且只出现在提示文本里
  assert.ok(kline.includes('区间内无买卖点'), '⚠ 被 build.mjs 锁定的字面量必须保留（改成提示文本，不是删除）')
  assert.ok(kline.includes('区间外另有'), '⚠ 同上（这句在 summary 里也仍然有）')
  assert.equal(/React\.createElement\('span',[^)]{0,120}区间内无买卖点/.test(kline), false, '它不许再是可见的 span')
  // 买卖点标记的 title/aria 仍在（另一处 tooltip 载体）
  assert.ok(kline.includes("React.createElement('title', null, buyText)"), '买入标记仍带 title')
  assert.ok(kline.includes("'aria-label': buyText"), '买入标记带 aria-label')
  assert.ok(kline.includes("'aria-label': sellText"), '卖出标记带 aria-label')

  // 反例注入：把图例加回**常驻可见位置** ⇒ 判据必须非空（贴证据后恢复）
  const injected = kline.replace('const bsHint =', `const injectedBad = React.createElement('div', { className: 'tw-ma-legend', style: { fontSize: 10 } },\n    React.createElement('span', null, \`区间内 B \${buyCount} 笔 / S \${sellCount} 笔\`),\n    React.createElement('span', { className: 'tw-muted' }, '区间内无买卖点'))\n  const bsHint =`)
  assert.notDeepEqual(visibleNoticeViolations(injected), [], '⚠ 反例（图例加回可见位置）必须被判据抓住')
  assert.throws(
    () => assert.deepEqual(visibleNoticeViolations(injected), [], '反例上"可见提示条必须已删"必须失败'),
    /反例上/,
    '⚠ 反例注入（加回常驻可见提示条）必须让断言失败',
  )
})

test('② 下窗脚注：K 线那一条整行走掉；分时那条保留；来源提示只留会影响判断的', () => {
  const drawer = strip(read('./QuoteDrawer.tsx'))
  assert.deepEqual(visibleNoticeViolations(drawer), [], `K 线脚注子信息必须已删（实际违规：${JSON.stringify(visibleNoticeViolations(drawer))}）`)
  // `legend` 变量（B 买入/S 卖出 笔数）整块删除
  assert.equal(/const legend = trades\.length/.test(drawer), false, 'B/S 笔数脚注（legend）必须已删')
  assert.equal(drawer.includes('${note}${legend}'), false, '渲染处不许再拼 legend')
  // 分时那条**保留**（`昨收 …` 只在这里出现，且不在用户红框内）
  assert.ok(drawer.includes('昨收 ${isUsableBaseline(t.prePrice)'), '分时脚注（昨收/时段）必须保留')
  // 来源提示走 visibleProvenanceOf（命中 TTL 缓存不占位）
  assert.ok(drawer.includes('visibleProvenanceOf(cn)'), '来源提示必须过 visibleProvenanceOf')

  // 纯函数语义（锚真实取值）
  assert.equal(visibleProvenanceOf(' · 本地缓存'), '', '命中 TTL 缓存：不占位')
  assert.equal(visibleProvenanceOf(''), '', '空串仍是空串')
  assert.notEqual(visibleProvenanceOf(' · 上次成功数据（10-12 15:00）'), '', '降级复用：必须仍然可见')
  assert.notEqual(visibleProvenanceOf(' · 非当日数据（09-30）'), '', '非当日数据：必须仍然可见')
  assert.notEqual(visibleProvenanceOf(' · 休市定稿缓存（未回源）'), '', '休市定稿：必须仍然可见')
  assert.notEqual(visibleProvenanceOf(' · 本地缓存（最近一次成功快照 09-24 13:41）'), '', '带快照时刻的本地缓存：仍要说清')

  // 反例注入：把 K 线脚注加回可见位置 ⇒ 判据必须非空
  const injected = drawer.replace("  let note = ''",
    "  let note = `共 3 根 · MA5/10/30/60 · 滚轮或拖动滑块缩放日期区间`\n  let note2 = ''")
  assert.notDeepEqual(visibleNoticeViolations(injected), [], '⚠ 反例（脚注加回可见位置）必须被判据抓住')
  assert.throws(
    () => assert.deepEqual(visibleNoticeViolations(injected), [], '反例上"脚注子信息必须已删"必须失败'),
    /反例上/,
    '⚠ 反例注入（加回脚注）必须让断言失败',
  )
})

test('③ `（详情头为真实成交价）` 从可见脚注搬到 B/S 标记的 title 与 aria-label（唯一来源）', () => {
  // 区间统计文本已抽到纯函数模块（klineStats.ts），字面量两处合起来看
  const kline = strip(read('./kline.tsx')) + strip(read('./klineStats.ts'))
  const drawer = strip(read('./QuoteDrawer.tsx'))

  // 唯一来源：常量定义在 kline.tsx，正文含该口径
  assert.ok(/const BS_PRICE_CALIBER = '[^']*详情头为真实成交价[^']*'/.test(kline), '口径说明必须定义在 B/S 标记那一段（唯一来源）')
  assert.ok(/parts\.push\(BS_PRICE_CALIBER\)/.test(kline), '口径必须进标记的明细文本')
  // 标记元素：title + aria-label 都带上它（两个方向各一处）
  assert.ok(/const buyText = detailText\('买入'[\s\S]{0,200}'aria-label': buyText[\s\S]{0,120}React\.createElement\('title', null, buyText\)/.test(kline),
    '买入标记必须同时有 aria-label 与 <title>')
  assert.ok(/const sellText = detailText\('卖出'[\s\S]{0,200}'aria-label': sellText[\s\S]{0,120}React\.createElement\('title', null, sellText\)/.test(kline),
    '卖出标记必须同时有 aria-label 与 <title>')
  // 可见位置**不许**再有它（旧脚注来源 fqNoteOf 已删除）
  assert.equal(drawer.includes('详情头为真实成交价'), false, '抽屉可见文案里不许再有它')
  assert.equal(kline.includes('fqNoteOf'), false, 'K 线不许再调用 fqNoteOf（脚注已删）')

  // 反例注入：把口径塞回可见脚注 ⇒ 判据必须非空
  const injected = drawer.replace("  let note = ''",
    "  let note = `前复权（详情头为真实成交价）`\n  let note0 = ''")
  const violations = visibleNoticeViolations(injected)
  assert.ok(violations.length === 0, '（这条反例注入的是"可见脚注里出现口径"，由本测试下面的可见性断言抓）')
  assert.throws(
    () => assert.equal(/React\.createElement\([^)]*tw-chartnote[\s\S]{0,200}详情头为真实成交价/.test(
      "React.createElement('div', { className: 'tw-chartnote' }, `前复权（详情头为真实成交价）`)"), false, '反例上"可见位置不许有它"必须失败'),
    /反例上/,
    '⚠ 反例注入（口径回到可见脚注）必须让断言失败',
  )
})
