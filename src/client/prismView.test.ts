/**
 * 【棱镜】页的判据（源码 + 纯函数两层，与 `toolsPage.test.ts` / `impl83.test.ts` 同一手法）。
 *
 * 覆盖（每条都配反例注入 ⇒ 注入后判据必须非空）：
 *  ① 页签存在、标签「棱镜」、归属 `prism`、且在**最右**
 *  ② 六个块齐全；不可算必须给原因（写 0 / 无原因 ⇒ 必败）
 *  ③ 两句不可移除的文案（固定限定行 + 效度事实）必须常驻可见
 *  ④ 目标价必须带规则名且可复算（裸数字 ⇒ 必败）
 *  ⑤ 参数必须常驻可见（只进悬停 ⇒ 必败）
 *  ⑥ 切频率只改参数、不新增接口（多一条路由/子路径 ⇒ 必败）
 *  ⑨ Monte Carlo 假设必须全部上屏（截断 ⇒ 必败）
 *
 * ⑦（聚合）与 ⑧（Stoikov 保护）的实现在宿主侧，判据在 `src/host/prism.test.ts`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PRISM_DEFAULT_PARAMS,
  type PrismEdgeBlock,
  type PrismPayload,
} from '../shared/prism.ts'
import {
  DASH,
  actionOf,
  PRISM_BLOCK_TITLE,
  PRISM_PARAM_KEYS,
  assumptionsOnScreenProblems,
  barsLine,
  bookContractProblems,
  bookText,
  fmtBps,
  fmtNum,
  fmtP,
  fmtPct,
  fmtPrice,
  freqLine,
  freqParamOnlyProblems,
  inputNameProblems,
  mcAssumptionProblems,
  paramsVisibleProblems,
  prismParamRowText,
  prismParamRows,
  prismPayloadProblems,
  prismQueryOf,
  spreadStateText,
  stanceProblems,
  stoikovProtectionProblems,
  tabPositionProblems,
  targetProblems,
} from './prismView.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')

/** 剥注释（注释里会写反例说明，不能当成违规） */
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/**
 * 断言 ③（用户裁决 2026-10-21，反转）：**免责类字样必须为零**。
 *
 * 黑名单只存在于本测试文件（产品源码里一个都不留）；扫描前**剥注释**（注释里描述规则不算违规，
 * 但页面/回包/常量里出现 ⇒ 必败）。「胜率 / 准确率」一并扫（用户红线）。
 */
const FORBIDDEN_DISCLAIMER = ['不构成投资建议', '推演结果', '免责', '风险提示', '我方历史复核', '可证明的预测力', '本页信号基于简化模型'] as const

function disclaimerProblems(sources: ReadonlyArray<{ rel: string; text: string }>): string[] {
  const bad: string[] = []
  for (const { rel, text } of sources) {
    for (const phrase of FORBIDDEN_DISCLAIMER) {
      if (text.includes(phrase)) bad.push(`${rel} 出现免责类字样「${phrase}」`)
    }
    if (/胜率|准确率/.test(text)) bad.push(`${rel} 出现「胜率/准确率」字样（用户红线）`)
  }
  return bad
}

const INDEX = strip(read('index.tsx'))
const PAGE = strip(read('PrismPage.tsx'))
const VIEW_SRC = strip(read('prismView.ts'))
const SHARED_SRC = readFileSync(join(here, '..', 'shared', 'prism.ts'), 'utf8')
const HOST_SRC = readFileSync(join(here, '..', 'host', 'prism.ts'), 'utf8')
const API = strip(read('api.ts'))
const ROUTES = strip(readFileSync(join(here, '..', 'host', 'routes.ts'), 'utf8'))

/** 从 `src/client/index.tsx` 抽**真实的** tabs 字面量（不另抄一份） */
function tabsFromSource(src: string): Array<{ key: string; label: string; row: string }> {
  const start = src.indexOf('const tabs:')
  if (start < 0) return []
  const open = src.indexOf('[', start)
  const end = src.indexOf('\n  ]', open)
  if (open < 0 || end < 0) return []
  return [...src.slice(open, end).matchAll(/\{ key: '([a-z]+)', label: '([^']*)', full: '[^']*', row: '([a-z]+)' \}/g)].map((m) => ({
    key: m[1] as string,
    label: m[2] as string,
    row: m[3] as string,
  }))
}

const TABS = tabsFromSource(INDEX)

test('① 页签：存在、标签「棱镜」、归属 prism、在最右（放到中间 ⇒ 必败）', () => {
  assert.equal(TABS.length, 8, `必须能抽出 8 个页签（锚点变了？实得 ${TABS.length}）`)
  assert.deepEqual(tabPositionProblems(TABS), [], '页签位置/标签/归属行不对')
  // 接线：index.tsx 真的 import 并渲染 PrismPage（不是"只存在于文件里"）
  assert.ok(/import \{ PrismPage \} from '\.\/PrismPage\.tsx'/.test(INDEX), 'index.tsx 必须 import PrismPage')
  assert.ok(/if \(key === 'prism'\) return React\.createElement\(PrismPage, \{ active: page === 'prism' \}\)/.test(INDEX), '保活容器必须渲染 PrismPage，并只在打开时取数')
  assert.ok(/KEEP_ALIVE: readonly PageKey\[\] = \['calendar', 'tools', 'fupan', 'prism'\]/.test(INDEX), '棱镜必须保活（参数沙盒不随切页丢失）')
  // 反例注入：把棱镜挪到中间（复盘之后、工具之前）⇒ 必败
  const middle = TABS.filter((t) => t.key !== 'prism')
  const prism = TABS.find((t) => t.key === 'prism') as { key: string; label: string; row: string }
  middle.splice(middle.findIndex((t) => t.key === 'tools'), 0, prism)
  assert.notDeepEqual(tabPositionProblems(middle), [], '⚠ 反例（棱镜放到中间）必须被抓到')
  assert.throws(
    () => assert.deepEqual(tabPositionProblems(middle), [], '反例上"棱镜在最右"必须失败'),
    /反例上/,
    '⚠ 反例注入（页签位置）必须让断言失败',
  )
})

test('③ 免责类字样必须为零（用户裁决：两句删除；加回任一处 ⇒ 必败）', () => {
  // 扫描面：页面 + 解释层 + 共享契约 + 宿主实现（四条都是"页面会显示什么"的直接来源）
  // 扫**剥注释后**的产品源码（注释里描述规则不算；页面/常量里出现才违规）
  const sources = [
    { rel: 'PrismPage.tsx', text: PAGE },
    { rel: 'prismView.ts', text: VIEW_SRC },
    { rel: 'shared/prism.ts', text: strip(SHARED_SRC) },
    { rel: 'host/prism.ts', text: strip(HOST_SRC) },
  ]
  // 两句（含出处引用）在**原始源码**里也必须彻底不见（注释也不许留）
  const raw = [PAGE, VIEW_SRC, SHARED_SRC, HOST_SRC].join('\n')
  for (const gone of ['推演结果，不构成投资建议', '本页信号基于简化模型；我方历史复核未发现该信号具备可证明的预测力', 'PRISM_QUALIFIER', 'PRISM_VALIDITY']) {
    assert.equal(raw.includes(gone), false, `源码里仍有被删除的文案/常量：${gone}`)
  }
  assert.deepEqual(disclaimerProblems(sources), [], `免责类字样必须为 0：${JSON.stringify(disclaimerProblems(sources))}`)
  // 被删除的两句（含出处引用）必须**彻底不在源码里**（不是隐藏、不是改名成常量）
  for (const gone of ['推演结果，不构成投资建议', '本页信号基于简化模型', '我方历史复核未发现', '可证明的预测力', 'PRISM_QUALIFIER', 'PRISM_VALIDITY']) {
    for (const { rel, text } of sources) assert.equal(text.includes(gone), false, `${rel} 里仍有被删除的文案/常量：${gone}`)
  }
  // 保留项（这些是数据事实/口径，不是免责）：模型口径一行、三态动作、目标价规则名、`模拟`
  assert.ok(PAGE.includes('PRISM_MODEL'), '模型口径一行必须保留（简化模型的说法不是免责）')
  assert.ok(PAGE.includes('actionOf(stance)'), '三态动作必须保留')
  assert.match(actionOf('看多'), /建议买入/)
  assert.match(actionOf('看空'), /建议卖出/)
  assert.equal(/买入|卖出|开仓/.test(actionOf('不下结论')), false, '「不下结论」必须不动作（不给方向）')
  assert.ok(PAGE.includes('f* × 分数系数'), 'Kelly 的「模拟值」口径必须保留')
  // 反例注入：加回任一类字样 ⇒ 判据必须非空
  const injections: Array<{ name: string; text: string; hit: RegExp }> = [
    { name: '加回「推演结果，不构成投资建议」', text: `${PAGE}\nconst bad = '推演结果，不构成投资建议'\n`, hit: /推演结果|不构成投资建议/ },
    { name: '加「免责声明」', text: `${PAGE}\nconst bad = '免责声明：本页仅供参考'\n`, hit: /免责/ },
    { name: '加「风险提示」', text: `${PAGE}\nconst bad = '风险提示：注意波动'\n`, hit: /风险提示/ },
    { name: '加「胜率 58%」', text: `${PAGE}\nconst bad = '胜率 58%'\n`, hit: /胜率/ },
    { name: '加「准确率」', text: `${PAGE}\nconst bad = '准确率 62%'\n`, hit: /准确率/ },
  ]
  for (const inj of injections) {
    const bad = disclaimerProblems([{ rel: 'PrismPage.tsx', text: inj.text }])
    assert.ok(bad.length > 0, `注入「${inj.name}」必须被抓到（一条都没报 ⇒ 判据恒真）`)
    assert.match(bad.join('／'), inj.hit, `注入「${inj.name}」报的原因应是预期的：${JSON.stringify(bad)}`)
  }
})

test('④ Kelly / Stoikov 必须带「模拟」（删掉 ⇒ 必败）', () => {
  const simulated = (t: Record<string, string>): boolean => /模拟/.test(t['kelly'] ?? '') && /模拟/.test(t['stoikov'] ?? '')
  assert.equal(simulated(PRISM_BLOCK_TITLE), true, 'Kelly 与 Stoikov 的块标题都必须带「模拟」')
  assert.ok(PAGE.includes('模拟值（f* × 分数系数）'), 'Kelly 卡必须常驻「模拟值」口径（不是免责注解）')
  // 反例注入：把 Kelly 标题里的「模拟」删掉 ⇒ 判据必须失败
  const bare = { ...PRISM_BLOCK_TITLE, kelly: 'Kelly 仓位' }
  assert.equal(simulated(bare), false, '⚠ 反例（删掉「模拟」）必须能被判据抓住')
  assert.throws(() => assert.equal(simulated(bare), true, '反例上"必须带模拟"必须失败'), /反例上/, '⚠ 反例注入（删「模拟」）必须让断言失败')
  // 反例注入：Stoikov 标题同样
  assert.equal(simulated({ ...PRISM_BLOCK_TITLE, stoikov: 'Stoikov 保留价' }), false)
})

test('⑤ 参数常驻可见：每行都渲染「标签 值」，不许只进悬停（⇒ 必败）', () => {
  const rows = prismParamRows(PRISM_DEFAULT_PARAMS)
  assert.deepEqual(
    rows.map((r) => r.key).sort(),
    [...PRISM_PARAM_KEYS].sort(),
    '参数行的键集必须与 PrismParams 的键集一致（新增参数忘了给行 ⇒ 红）',
  )
  for (const row of rows) {
    const text = prismParamRowText(row)
    assert.ok(text.includes(row.value), `参数行必须显示当前值：${text}`)
    assert.ok(text.includes(row.label), `参数行必须显示参数名：${text}`)
  }
  assert.deepEqual(paramsVisibleProblems(PAGE), [], `参数可见性判据必须通过：${JSON.stringify(paramsVisibleProblems(PAGE))}`)
  // 页面为每个参数都渲染了一行（data-param 锚点 + 17 行参数）
  for (const key of PRISM_PARAM_KEYS) {
    assert.ok(PAGE.includes(`param('${key}'`), `参数 ${key} 必须有渲染行`)
  }
  // 反例注入 A：把值只放进悬停 ⇒ 必败
  const hover = PAGE.replace('React.createElement(ParamText, { row })', "React.createElement('span', { title: prismParamRowText(row) }, '')")
  assert.notEqual(hover, PAGE, '注入必须真的改到参数行')
  assert.notDeepEqual(paramsVisibleProblems(hover), [], '⚠ 反例（参数值只进悬停）必须被抓到')
  // 反例注入 B：参数行不再走 prismParamRowText ⇒ 必败
  const noText = PAGE.replace('prismParamRowText(props.row)', 'String(props.row.value)')
  assert.notDeepEqual(paramsVisibleProblems(noText), [], '⚠ 反例（参数值不显示）必须被抓到')
})

test('⑥ 切频率只改参数、不新增接口（多一条路由/子路径 ⇒ 必败）', () => {
  // 三个频率构造出来的 query 只差 freq=
  const base = { ...PRISM_DEFAULT_PARAMS, pairA: '1.600519', pairB: '0.000001' }
  const q5 = prismQueryOf({ ...base, freq: 5 })
  const q10 = prismQueryOf({ ...base, freq: 10 })
  const q30 = prismQueryOf({ ...base, freq: 30 })
  assert.equal(q5.replace('freq=5', ''), q10.replace('freq=10', ''), '5/10 分钟的 query 除 freq 外必须逐字相同')
  assert.equal(q10.replace('freq=10', ''), q30.replace('freq=30', ''), '10/30 分钟的 query 除 freq 外必须逐字相同')
  // 真表：prism 行只宣告一条路由
  const indexSrc = readFileSync(join(here, '..', 'index.ts'), 'utf8')
  const m = /\n  prism: \[([^\]]*)\]/.exec(indexSrc)
  assert.notEqual(m, null, 'src/index.ts 必须有 prism 行的路由表')
  const rowRoutes = [...String(m?.[1]).matchAll(/'([^']+)'/g)].map((x) => x[1] as string)
  const input = { rowRoutes, apiSrc: API, routesSrc: ROUTES, queryOf: (f: 5 | 10 | 30) => prismQueryOf({ ...base, freq: f }) }
  assert.deepEqual(freqParamOnlyProblems(input), [], `接线判据必须通过：${JSON.stringify(freqParamOnlyProblems(input))}`)
  // 反例注入 A：新开一条接口（多一条路由）⇒ 必败
  assert.notDeepEqual(freqParamOnlyProblems({ ...input, rowRoutes: [...rowRoutes, '/tradewatcher/prism/30'] }), [], '⚠ 反例（多一条路由）必须被抓到')
  // 反例注入 B：api.ts 里多一个子路径 ⇒ 必败
  assert.notDeepEqual(freqParamOnlyProblems({ ...input, apiSrc: `${API}\n// /tradewatcher/prism/5` }), [], '⚠ 反例（api 子路径）必须被抓到')
  // 反例注入 C：routes.ts 里多一条子路径路由 ⇒ 必败
  assert.notDeepEqual(freqParamOnlyProblems({ ...input, routesSrc: `${ROUTES}\npath: '/tradewatcher/prism/30'` }), [], '⚠ 反例（routes 子路径）必须被抓到')
})

test('⑨ Monte Carlo 假设全部上屏：逐条渲染（截断/摘要 ⇒ 必败）', () => {
  assert.deepEqual(assumptionsOnScreenProblems(PAGE), [], `MC 假设渲染判据必须通过：${JSON.stringify(assumptionsOnScreenProblems(PAGE))}`)
  // 页面明确按 assumptions 数组逐条渲染，并带可见标签
  assert.ok(PAGE.includes('blocks.mc.assumptions.map('), '可算分支必须逐条渲染假设')
  assert.ok(PAGE.includes('假设 '), '假设必须有可见标签')
  // 反例注入 A：只渲染前三条 ⇒ 必败
  const truncated = PAGE.replace('...blocks.mc.assumptions.map(', '...blocks.mc.assumptions.slice(0, 3).map(')
  assert.notEqual(truncated, PAGE, '注入必须真的改到渲染点')
  assert.notDeepEqual(assumptionsOnScreenProblems(truncated), [], '⚠ 反例（假设被截断）必须被抓到')
  // 反例注入 B：不再逐条渲染（改成一句汇总）⇒ 必败
  const summary = PAGE.replace('...blocks.mc.assumptions.map((a) => KV({ k: `假设 ${a.label}`, v: `${a.value}${a.unit === \'\' ? \'\' : a.unit} · ${a.source}` })),', '')
  assert.notDeepEqual(assumptionsOnScreenProblems(summary), [], '⚠ 反例（假设被摘要）必须被抓到')
})

test('② 回包判据在页面侧也生效：六块 + 原因（写 0 ⇒ 必败）', () => {
  const edge: PrismEdgeBlock = {
    available: true, reason: null, samples: 30, p: 0.55, avgWinBps: 30, avgLossBps: 20,
    feeBps: 2, slipBps: 3, latencyPenaltyBps: 1, costBps: 6, evBps: 8, thresholdBps: 0,
    stance: '看多', stanceWhy: 'ok',
    targets: [{ rule: 'atr-k', ruleLabel: 'ATR×2', value: 101, reason: null, inputs: { close: 100, atr: 0.5, k: 2, dir: 1 } }],
  }
  assert.deepEqual(stanceProblems(edge), [], 'EV>阈值且 p≥0.5 ⇒ 看多')
  assert.deepEqual(targetProblems(edge), [], '目标价可复算（100 + 1×2×0.5 = 101）')
  // 反例：EV 不达标却看多 ⇒ 必败
  assert.notDeepEqual(stanceProblems({ ...edge, evBps: -1 }), [], '⚠ 反例（EV 不达标仍看多）必须被抓到')
  // 反例：裸数字目标价 ⇒ 必败
  assert.notDeepEqual(targetProblems({ ...edge, targets: [{ ...(edge.targets[0] as (typeof edge.targets)[number]), rule: '', ruleLabel: '' }] }), [], '⚠ 反例（裸数字）必须被抓到')
  // 反例：值与规则不符 ⇒ 必败
  assert.notDeepEqual(targetProblems({ ...edge, targets: [{ ...(edge.targets[0] as (typeof edge.targets)[number]), value: 102 }] }), [], '⚠ 反例（值不可复算）必须被抓到')
})

test('展示：缺失一律 `—`（不写 0）、越阈只描述位置、五档如实交代', () => {
  assert.equal(fmtNum(null, 2), DASH)
  assert.equal(fmtPrice(null), DASH)
  assert.equal(fmtBps(null), DASH)
  assert.equal(fmtPct(null), DASH)
  assert.equal(fmtP(null), DASH)
  assert.equal(fmtNum(Number.NaN, 2), DASH, 'NaN 也要显示 —（不许渲染成 NaN）')
  assert.equal(fmtBps(12.345), '12.35bps')
  assert.equal(fmtP(0.6234), '0.623')
  const spread = {
    available: true, reason: null, samples: 60, pairB: '0.000001', n: 60, z: 2.4, mu: 0, sigma: 1,
    threshold: 2, beyond: 'upper' as const, mid: 0.001, midSource: 'micro-price（5 档）',
    midReason: null, book: bookOfTest(),
  }
  assert.match(spreadStateText(spread), /越上阈/)
  assert.equal(spreadStateText({ ...spread, beyond: null }), '未越阈（|z| ≤ 2）')
  assert.match(bookText(spread.book), /5 档/)
  assert.match(bookText({ ...spread.book, available: false, reason: '腾讯五档失败（HTTP 403）' }), /五档失败/)
  // 回包级：`barsLine` / `freqLine` 不编数
  assert.equal(barsLine(null), DASH)
  assert.equal(freqLine(null), DASH)
})

function bookOfTest() {
  return {
    available: true, reason: null, source: '腾讯五档（量单位：手，可用 5 档）', levels: 5,
    bids: [], asks: [], microPrice: 100, quoteMid: null, quoteSource: null, quoteAt: null,
  }
}

/** 形状完整的最小 payload（只用于演示判据接线，不参与计算） */
function payloadOf(edge: PrismEdgeBlock): PrismPayload {
  const base = { available: false, reason: '测试', samples: 0 }
  return {
    asOf: 1,
    freq: 5,
    freqNote: '5 分钟（原始档）',
    downgrade: null,
    params: { ...PRISM_DEFAULT_PARAMS, pairA: '1.600519' },
    symbols: { a: '1.600519', b: null },
    universe: [],
    bars: { n: 0, from: null, to: null, lastPartial: false, source: null, reason: '测试' },
    blocks: {
      bayes: { ...base, prior: 0.5, p: null, series: [], features: { volZ: null, pos: null, streak: null } },
      edge,
      spread: {
        ...base, pairB: null, n: 0, z: null, mu: null, sigma: null, threshold: 2, beyond: null,
        mid: null, midSource: DASH, midReason: '测试', book: bookOfTest(),
      },
      stoikov: { ...base, s: null, sSource: DASH, gamma: 0, sigmaSq: null, q: 0, ttBars: 0, reserve: null, protected: false, protectReason: null },
      kelly: { ...base, p: null, b: null, fStar: null, fScaled: null, frac: 0.5 },
      mc: {
        ...base, runs: 0, trades: 0,
        assumptions: [
          { key: 'fill', label: '成交率', value: 0.75, unit: '', source: '页面参数' },
          { key: 'slip', label: '滑点', value: 3, unit: 'bps', source: '页面参数' },
          { key: 'latency', label: '延迟', value: 300, unit: 'ms', source: '页面参数' },
          { key: 'pErr', label: 'p 误差', value: 0.05, unit: '±', source: '页面参数' },
        ],
        mddP50: null, mddP95: null, ruinProb: null, equity: [],
      },
    },
    missing: ['bayes：测试'],
  }
}

test('② 回包判据：六块齐全/不可算给原因/MC 四条假设（反例注入必败）', () => {
  const base = payloadOf({
    available: false, reason: '没有样本', samples: 0, p: null, avgWinBps: null, avgLossBps: null,
    feeBps: 0, slipBps: 0, latencyPenaltyBps: null, costBps: null, evBps: null, thresholdBps: 0,
    stance: '不下结论', stanceWhy: '没有样本', targets: [],
  })
  assert.deepEqual(prismPayloadProblems(base), [], `形状完整的空回包必须通过：${JSON.stringify(prismPayloadProblems(base))}`)
  assert.notDeepEqual(prismPayloadProblems({ ...base, missing: [] , blocks: { ...base.blocks, mc: { ...base.blocks.mc, assumptions: [] } } }), [], '⚠ 反例（MC 假设缺失）必须被抓到')
  // Stoikov 保护判据（源码层以外的纯函数版；宿主侧的完整判据见 host/prism.test.ts）
  assert.deepEqual(
    stoikovProtectionProblems({ available: true, reason: null, samples: 30, s: 100, sSource: '测试', gamma: 0.1, sigmaSq: 1, q: 10, ttBars: 0, reserve: 100, protected: true, protectReason: 'T−t 0 根 < 0.5 根 ⇒ 保护已生效' }),
    [],
  )
  assert.notDeepEqual(
    stoikovProtectionProblems({ available: true, reason: null, samples: 30, s: 100, sSource: '测试', gamma: 0.1, sigmaSq: 1, q: 10, ttBars: 0, reserve: 90, protected: false, protectReason: null }),
    [],
    '⚠ 反例（T−t=0 不保护）必须被抓到',
  )
  // MC 假设判据（纯函数层）
  assert.notDeepEqual(mcAssumptionProblems({ available: false, reason: 'x', samples: 0, runs: 0, trades: 0, assumptions: [], mddP50: null, mddP95: null, ruinProb: null, equity: [] }), [], '⚠ 反例（0 条假设）必须被抓到')
})

test('⑥ 输入名必须上屏：s / mid 标出 micro-price 还是盘口中点（删掉 ⇒ 必败）', () => {
  assert.deepEqual(inputNameProblems(PAGE), [], `输入名判据必须通过：${JSON.stringify(inputNameProblems(PAGE))}`)
  // 页面确实把 sSource / midSource 拼进可见文本
  assert.ok(PAGE.includes('`s：${blocks.stoikov.sSource}`'), 'Stoikov 卡必须显示 `s：…`')
  assert.ok(PAGE.includes('`mid：${blocks.spread.midSource}`'), 'Spread 卡必须显示 `mid：…`')
  // 反例注入 A：删掉 s 的输入名 ⇒ 必败
  const noS = PAGE.replace('`s：${blocks.stoikov.sSource}`', "'s'")
  assert.notEqual(noS, PAGE, '注入必须真的改到源码')
  assert.notDeepEqual(inputNameProblems(noS), [], '⚠ 反例（删掉 s 输入名）必须被抓到')
  // 反例注入 B：删掉 mid 的输入名 ⇒ 必败
  const noMid = PAGE.replace('`mid：${blocks.spread.midSource}`', "'mid'")
  assert.notDeepEqual(inputNameProblems(noMid), [], '⚠ 反例（删掉 mid 输入名）必须被抓到')
  // 盘口契约（页面侧同一份判据）：只有价形态不得携带 microPrice
  const quoteOnly = {
    available: false, reason: '港股只有盘口价', source: null, levels: 0, bids: [], asks: [],
    microPrice: null, quoteMid: 401.1, quoteSource: '盘口中点（1 档价） · 新浪港股盘口价', quoteAt: 1,
  }
  assert.deepEqual(bookContractProblems(quoteOnly), [])
  assert.notDeepEqual(bookContractProblems({ ...quoteOnly, microPrice: 401.1 }), [], '⚠ 反例（mid 塞进 microPrice）必须被抓到')
})
