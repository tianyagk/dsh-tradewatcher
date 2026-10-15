/**
 * v0.91.1（产品迭代批）：护盘参照 + 可发现性 + 间距收敛的**成品断言**。
 *
 * 三项都锚在真源码上（读文件 → 断言），每条都配反例注入（把改动撤回去 ⇒ 必须失败）。
 * 字号阶梯与整份 CSS 的扫描在 `uiuxDiscipline.test.ts`（本轮已从 2 个文件扩到全客户端）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(here, p), 'utf8')
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ── ② 护盘面板参照 ───────────────────────────────────────────────────────

test('② 护盘总分带"与最近相比"的参照，且峰值算法**只有一处**（不许两算）', () => {
  const src = strip(read('RescuePanel.tsx'))
  assert.ok(src.includes('当日峰'), '总分旁必须有可见参照（当日峰值）')
  assert.ok(/\$\{snapshot\.score\}\/100 · 当日峰/.test(src), '参照要跟在分数后面（紧凑一行）')
  // 峰值：一处声明 + 两处使用（总分参照、"最高评分"那行）
  const uses = src.split('peakToday').length - 1
  assert.ok(uses >= 3, `峰值必须同源复用（声明 + ≥2 处使用；实际 ${uses} 次）`)
  assert.equal(/const peak = snapshot\.intraday\.reduce/.test(src), false, '旧的第二处峰值算法必须已删')
  /**
   * 诚实性（**AUDIT-IMPL57 更新**）：跨日分位此前不在契约里 ⇒ 当时要求"写明为什么没有"；
   * 现在契约已补上（`continuousPercentile` / `continuousPercentileN` / `continuousPercentileWhy`）⇒
   * 面板改成**读契约**显示「分位 X%（N=…）」，缺数据时用契约里的原因文案；**仍然不许客户端现算**。
   */
  for (const field of ['continuousPercentile', 'continuousPercentileN', 'continuousPercentileWhy']) {
    assert.ok(src.includes(field), `面板必须读契约字段 ${field}（分位由宿主算、界面只显示）`)
  }
  assert.equal(/scorePercentile/.test(src), false, '客户端**不许**自己算分位（宿主算了才显示）')
  assert.ok(/分位 \$\{/.test(src) || src.includes('分位 $'), '可见部分要带「分位 …」短标记')
  // 反例注入：拿掉可见参照 ⇒ 判据必须失败
  // 反例注入：去掉**可见那行**里的参照（词在别的句子/注释里也有 ⇒ 判据必须认"可见形态"而不是裸词）
  const visible = /\$\{snapshot\.score\}\/100 · 当日峰/
  const injected = src.replace(' · 当日峰 ', ' · ')
  assert.notEqual(injected, src, '反例注入必须真改到源码')
  assert.equal(visible.test(injected), false, '⚠ 反例（无可见参照）必须能被可见形态的判据抓住')
  assert.throws(
    () => assert.equal(visible.test(injected), true, '反例上"必须有可见参照"必须失败'),
    /反例上/,
    '⚠ 反例注入（去掉"与最近相比"的参照）必须让断言失败',
  )
})

test('② 因子贡献列带满分基准（每行 x/权重×100，合计 x/100）', () => {
  const src = strip(read('RescuePanel.tsx'))
  assert.ok(src.includes("'贡献/满分'"), '列头必须写明满分口径')
  assert.ok(src.includes('满分 ${Math.round(f.weight * 100)}（权重 × 100）'), '每行悬停要给满分算法')
  assert.ok(/\$\{\(c \?\? 0\)\.toFixed\(1\)\}\/\$\{Math\.round\(f\.weight \* 100\)\}/.test(src), '每行要显示 x/满分')
  assert.ok(/\$\{sum\.toFixed\(1\)\}\/100/.test(src), '合计行要给 /100')
  // 反例注入：撤掉满分（只留裸贡献值）⇒ 判据必须失败
  // 反例注入：只把**单元格里**的 `/满分` 去掉（满分字样在列头/title 里还有 ⇒ 判据必须认单元格形态）
  const cellForm = /\$\{\(c \?\? 0\)\.toFixed\(1\)\}\/\$\{Math\.round\(f\.weight \* 100\)\}/
  const injected = src.replace('/${Math.round(f.weight * 100)}`', '`')
  assert.notEqual(injected, src, '反例注入必须真改到源码')
  assert.equal(cellForm.test(injected), false, '⚠ 反例（单元格没有满分）必须能被抓住')
  assert.throws(
    () => assert.equal(cellForm.test(injected), true, '反例上"单元格必须有满分"必须失败'),
    /反例上/,
    '⚠ 反例注入（贡献列不给满分）必须让断言失败',
  )
})

// ── ③ 可发现性 ──────────────────────────────────────────────────────────

test('③ 视图模式有**可见**控件（不再是只靠 Alt+M），且切换逻辑只有一处实现', () => {
  const top = strip(read('TopBar.tsx'))
  const idx = strip(read('index.tsx'))
  // 可见控件：按钮文字里带档位（不是只有一个图标）
  assert.ok(/`视图·\$\{/.test(top), '行情条上必须有可见的「视图·<档位>」控件')
  assert.ok(top.includes('快捷键 Alt+M'), '控件悬停要写出快捷键（鼠标与键盘两条路都要能发现）')
  // 唯一实现：index.tsx 的 cycleViewMode 同时供快捷键与控件用
  assert.ok(idx.includes('const cycleViewMode = useCallback'), '切换逻辑必须抽成唯一实现')
  assert.ok(/onCycleViewMode: cycleViewMode/.test(idx), '控件必须复用同一个实现（不许第二份）')
  assert.ok(/cycleViewMode\(\)/.test(idx), '快捷键也必须走同一个实现')
  assert.equal(/const next = VIEW_MODES\[/.test(idx), true, '档位循环仍在（同一处）')
  assert.equal((idx.match(/const next = VIEW_MODES\[/g) ?? []).length, 1, '档位循环只允许一份')
  // 反例注入：把可见控件删掉（退回"只有快捷键"）⇒ 判据必须失败
  const injected = top.replace(/`视图·\$\{/, '`X${')
  assert.notEqual(injected, top, '反例注入必须真改到源码')
  assert.equal(/`视图·\$\{/.test(injected), false, '⚠ 反例（无可见控件）必须能被抓住')
  assert.throws(
    () => assert.equal(/`视图·\$\{/.test(injected), true, '反例上"必须有可见控件"必须失败'),
    /反例上/,
    '⚠ 反例注入（退回只有快捷键）必须让断言失败',
  )
})

test('③ 三个页面有空态：大盘/日历用 EmptyHint，云图用带原因与重试的占位', () => {
  const market = strip(read('MarketPage.tsx'))
  const cal = strip(read('CalendarPage.tsx'))
  const cloud = strip(read('CloudMap.tsx'))
  assert.ok(market.includes('EmptyHint') && market.includes('Object.keys(quotes).length === 0'),
    '大盘页：行情引擎还没出数时要有空态')
  assert.ok(cal.includes('EmptyHint') && cal.includes('当天没有事件记录'), '日历页：当天无事件要有空态')
  // 云图已有"超时占位 + 域名 + 重试"，不重复造第二套空态
  assert.ok(cloud.includes('tw-placeholder') && cloud.includes('重试'), '云图：失败占位必须带原因与重试')
  // 空态**不许**吞掉"未取到 + 原因"的语义
  assert.ok(market.includes('未取到'), '大盘页的缺失提示仍在（空态不是替代品）')
  // 反例注入：把日历空态退回一句裸文案 ⇒ 判据必须失败
  const injected = cal.replace('React.createElement(EmptyHint, null,', "React.createElement('div', null,")
  assert.notEqual(injected, cal, '反例注入必须真改到源码')
  assert.throws(
    () => assert.equal(injected.includes('React.createElement(EmptyHint, null'), true, '反例上"必须用统一空态"必须失败'),
    /反例上/,
    '⚠ 反例注入（退回裸文案）必须让断言失败',
  )
})

test('③ 工具目录只有 1~2 个工具时有一句如实说明（不是占位数据）', () => {
  const src = strip(read('ToolsPage.tsx'))
  assert.ok(src.includes("'data-role': 'tool-catalog-sparse'"), '稀疏目录必须有一行如实说明')
  assert.ok(/TOOL_ENTRIES\.length <= 2/.test(src), '判据挂在真实工具数上')
  assert.ok(src.includes('每接入一个工具'), '文案要说明"会随工具增加变长"')
  // 反例注入：删掉说明 ⇒ 判据必须失败
  const injected = src.replace("'data-role': 'tool-catalog-sparse'", "'data-role': 'x'")
  assert.notEqual(injected, src, '反例注入必须真改到源码')
  assert.throws(
    () => assert.equal(injected.includes("'data-role': 'tool-catalog-sparse'"), true, '反例上"必须有说明"必须失败'),
    /反例上/,
    '⚠ 反例注入（删掉说明）必须让断言失败',
  )
})

// ── ① 间距：三处越格已收敛（CSS 里承载几何的 3/5px 是显式例外）────────────

test('① TSX 间距：三处越格（3/5px）已收敛到 4px；CSS 的几何例外保持不动', () => {
  const files = ['ToolsPage.tsx', 'CalendarPage.tsx', 'RescuePanel.tsx', 'WatchlistPage.tsx', 'PortfolioPage.tsx', 'MarketPage.tsx']
  for (const f of files) {
    const src = strip(read(f))
    for (const bad of ['gap: 5', 'gap: 3', 'marginRight: 3', 'marginLeft: 3', 'marginTop: 3', 'padding: 3']) {
      assert.equal(src.includes(bad), false, `${f} 里不该再有越格间距：${bad}`)
    }
  }
  // CSS 侧的显式例外：`.tw-zoom` 的 gap 被几何断言（splitDrag.test.ts）当预算常量用 ⇒ 保持 5px
  const css = read('styles.ts')
  assert.ok(/\.tw-zoom\{[^}]*gap:5px/.test(css), '`.tw-zoom` gap:5px 是**承载几何**的显式例外（改它要同步改 CHART_CONTROLS_PX）')
  const split = read('splitDrag.test.ts')
  assert.ok(split.includes("assert.equal(zoomGap, 5, '缩放轴内间隙 5px')"), '这条例外的依据就是那条几何断言')
})
