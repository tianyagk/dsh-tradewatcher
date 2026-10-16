/**
 * 仓库纪律断言（v0.94.0，来源：`docs/REVIEW-6-ENGINEERING.md` §1.1 / §5.2）。
 *
 * 三条互相独立的防线，都配了"反例就能红"的判据：
 *  ① **导出面**：本批已收敛的 22 条不许再被 `export` 回来；3 条死代码不许复活；4 条测试钩子必须 `__` 前缀；
 *     并且——**全仓不许新增"零引用导出"**（基线 49 条是 v0.78.0 之前的历史欠账，已登记，清理另开一批）。
 *  ② **文档纪律**：历史审计文档必须带「历史快照」页眉（否则里面的行数/路由数/测试数会被当成现状）；
 *     `docs/DECISIONS.md` 头部只有一个 H1，且**必须**含"发版是原子动作"那条决策。
 *
 * 为什么要有它：这些都是"改一次就完事、下次照样犯"的形状 —— REVIEW-6 实测的漂移
 * （文档缺路由、测试副本与真表无相等断言、导出面无约束）没有一条是有人故意违反的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'lib' || name === '.git') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(p)
  }
  return out
}

const ALL = walk(join(ROOT, 'src'))
const SRC = ALL.filter((f) => !f.endsWith('.test.ts'))
const TESTS = ALL.filter((f) => f.endsWith('.test.ts'))
const read = (f: string): string => readFileSync(f, 'utf8')
const SRC_TEXT = new Map(SRC.map((f) => [f, read(f)]))
const TEST_TEXT = TESTS.map((f) => read(f)).join('\n')

/** 抽出一个文件里的导出名（含 `export { A, B }` 组） */
function exportsOf(text: string): string[] {
  const names: string[] = []
  for (const m of text.matchAll(/^export\s+(?:declare\s+)?(?:const|function|class|interface|type|enum|let)\s+([A-Za-z_$][\w$]*)/gm)) names.push(m[1])
  for (const m of text.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.split(' as ').pop()?.trim()
      if (name !== undefined && name !== '') names.push(name)
    }
  }
  return names
}

/**
 * 一条导出在三处的引用数：自身文件（除声明本身）/ 其它非测试文件 / 测试文件。
 *
 * 判据口径与 `docs/REVIEW-6-ENGINEERING.md` §1.1 一致 —— 只有**三处都为 0**才算"死导出"；
 * 只在自身文件里被用（`export` 多余但代码活着）是另一类问题，那批（A 组 22 条）已单独收敛，
 * 遗留部分不在本用例的判定范围内（否则基线会从 49 条胀到上百条，把规矩变成噪音）。
 */
function referenceCounts(name: string, ownFile: string): { own: number; external: number; inTests: number } {
  const pat = new RegExp(`\\b${name}\\b`, 'g')
  const ownText = SRC_TEXT.get(ownFile) as string
  const ownHits = (ownText.match(pat) ?? []).length
  const declaredInOwn = new RegExp(`^export\\s+(?:declare\\s+)?(?:const|function|class|interface|type|enum|let)\\s+${name}\\b`, 'm').test(ownText)
  const own = Math.max(0, ownHits - (declaredInOwn ? 1 : 0))
  let external = 0
  for (const [f, text] of SRC_TEXT) {
    if (f === ownFile) continue
    external += (text.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length
  }
  const inTests = (TEST_TEXT.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length
  return { own, external, inTests }
}

/**
 * **历史欠账基线**（v0.78.0 之前就存在的"零引用导出"，共 49 条；REVIEW-6 §1.1 登记）。
 *
 * 规则不是"清空它"，而是**不许变长**：新增一条零引用导出 ⇒ 红。
 * 想动这份清单的另一半（把这 49 条清掉）是另一批的事，别在本文件里顺手改。
 */
const LEGACY_UNREFERENCED: readonly string[] = [
  'TrendCaliberInput', 'TrendCaliber', 'MissingWhy', 'MISSING_STATE_LABEL', 'MISSING_STATE_ADVICE',
  'Z_95', 'Interval', 'StripConfigProps', 'TrendReadoutArgs', 'KlineReadoutArgs', 'ChartCache',
  'ChartFrame', 'WatchSortInput', 'PortSortInput', 'ChipsPanelProps', 'NoteIconProps', 'CnSessionState',
  'QuoteStateInput', 'ChipsRowsLayout', 'ChipsColumns', 'MASS_THRESHOLD', 'ChipAxis', 'ToneBadgeView',
  'SplitHeights', 'KlineHeights', 'ChartGeom', 'BulkPasteProps', 'QuoteEngine', 'SparklineProps',
  'TabGate', 'MenuItem', 'EnginePageLike', 'rateSummary', 'DayTradeResult', 'FlowMarketDef',
  'FLOW_SNAPSHOT_KEEP_DAYS', 'ReplayResult', 'TencentQuote', 'ChipBar', 'ChipOptions', 'BreakerSummary',
  'AnomalyJudgement', 'AnomalyInput', 'PERIPHERAL_FLOW_DISCOUNT', 'RescueFactorInput', 'ShanghaiParts',
  'Composition', 'isCooling', 'fileKey',
]

test('① 导出面：本批收敛掉的 22 条不许再被 export 回来', () => {
  const deExported: Array<[string, string]> = [
    ['src/client/toolDetailTheme.ts', 'TypeSpec'], ['src/client/toolDetailTheme.ts', 'GlassSlots'],
    ['src/client/toolDetailTheme.ts', 'keyframeBlock'], ['src/client/toolFacts.ts', 'FactTopic'],
    ['src/client/tools/globalFlowView.ts', 'StressVerdict'], ['src/client/api.ts', 'MarketExtras'],
    ['src/host/marketExtras.ts', 'Push2Probe'], ['src/host/marketExtras.ts', 'DayOverDay'],
    ['src/host/marketExtras.ts', 'LimitCounts'], ['src/host/marketExtras.ts', 'MarginCross'],
    ['src/host/marketExtras.ts', 'progressCurveSamples'], ['src/host/rescue.ts', 'TradingDayState'],
    ['src/shared/model.ts', 'TradingCalendarInfo'], ['src/host/tradingCalendar.ts', 'CalendarValidation'],
    ['src/host/tradingCalendar.ts', 'validateTradingCalendar'], ['src/host/tradingCalendar.ts', 'tradingCalendarPath'],
    ['src/host/tradingCalendar.ts', 'TRADING_CALENDAR_FILE'], ['src/host/globalFlow.ts', 'FLOW_MACRO_KEEP_DAYS'],
    ['src/host/globalFlow.ts', 'FlowPreferenceParts'], ['src/host/globalFlow.ts', 'mergedMacroHistory'],
    ['src/host/globalFlow.ts', 'trimMacroDays'], ['src/host/robotsGate.ts', 'ROBOTS_TTL_MS'],
  ]
  assert.equal(deExported.length, 22, '清单必须锁在 22 条（REVIEW-6 §1.1 A 组）')
  for (const [file, name] of deExported) {
    const text = read(join(ROOT, file))
    assert.equal(new RegExp(`^export\\s+(?:declare\\s+)?(?:const|function|class|interface|type|enum|let)\\s+${name}\\b`, 'm').test(text), false, `${file} 的 ${name} 不该再被 export（本批已确认外部零引用）`)
    // 反例注入：把它 export 回来 ⇒ 这条判据必须失败
    assert.equal(new RegExp(`^export\\s+(?:const|function|class|interface|type|enum|let)\\s+${name}\\b`, 'm').test(`export const ${name} = 1\n`), true, `⚠ 反例（export 回来）必须能被判据抓到：${name}`)
  }
})

test('② 导出面：3 条死代码不许复活（原声明与标识符都不得再出现）', () => {
  const removed: Array<[string, string]> = [
    ['src/client/api.ts', 'LimitCountsWire'],
    ['src/host/globalFlow.ts', 'macroHistory'],
    ['src/host/globalFlow.ts', 'macroReadFailures'],
  ]
  for (const [file, name] of removed) {
    const text = read(join(ROOT, file))
    assert.equal(new RegExp(`\\b${name}\\b`).test(text), false, `${file} 里不该再有 ${name}（外部引用 0 / 同文件用量 0 ⇒ 死代码）`)
  }
})

test('③ 导出面：4 条测试钩子必须 `__` 前缀（且旧名不再存在）', () => {
  const hooks: Array<[string, string]> = [
    ['src/host/tradingCalendar.ts', '__resetTradingCalendarCache'],
    ['src/host/marketExtras.ts', '__resetPush2Availability'],
    ['src/host/marketExtras.ts', '__resetExtrasCache'],
    ['src/host/marketExtras.ts', '__push2Availability'],
  ]
  const allSrc = SRC.map((f) => read(f)).join('\n')
  for (const [file, name] of hooks) {
    const text = read(join(ROOT, file))
    assert.equal(new RegExp(`^export\\s+function\\s+${name}\\b`, 'm').test(text), true, `${file} 必须导出 ${name}（测试钩子统一 __ 前缀）`)
    // 旧名（去掉 __ 后）不许在同一文件里再作为声明出现
    const old = name.replace(/^__/, '')
    assert.equal(new RegExp(`^export\\s+function\\s+${old}\\b`, 'm').test(text), false, `${file} 的旧名 ${old} 必须已改名`)
    assert.equal(new RegExp(`\\b${old}\\b`).test(allSrc), false, `全仓不该再有旧名 ${old} 的引用`)
  }
})

test('④ 导出面：不许新增"零引用导出"（基线 49 条是历史欠账，只许减不许增）', () => {
  const baseline = new Set(LEGACY_UNREFERENCED)
  assert.equal(baseline.size, 49, `基线必须锁在 49 条（实得 ${baseline.size}）`)
  const violations: string[] = []
  for (const f of SRC) {
    for (const name of exportsOf(SRC_TEXT.get(f) as string)) {
      const { own, external, inTests } = referenceCounts(name, f)
      if (own === 0 && external === 0 && inTests === 0 && !baseline.has(name)) {
        violations.push(`${relative(ROOT, f)}: ${name}`)
      }
    }
  }
  assert.deepEqual(violations, [], `新增了零引用导出（要么用起来，要么别导出）：\n${violations.join('\n')}`)
  // 反例注入：判据对"虚构的新导出"必须非空（证明扫描不是恒真）
  const fake = 'JustAddedButUnused'
  const scanned = SRC_TEXT.get(join(ROOT, 'src/host/robotsGate.ts')) as string
  const withFake = scanned + `\nexport const ${fake} = 1\n`
  const fakeHits = exportsOf(withFake).filter((n) => n === fake)
  assert.deepEqual(fakeHits, [fake], '⚠ 反例：新加的导出必须被扫描器看到（否则这条断言是空跑）')
  assert.equal(baseline.has(fake), false, '⚠ 反例：新导出不在基线里 ⇒ 上一条 violations 会非空')
})

test('⑤ 文档纪律：历史审计文档必须带「历史快照」页眉', () => {
  const audits = ['AUDIT-IMPL35', 'AUDIT-IMPL45', 'AUDIT-IMPL46', 'AUDIT-IMPL47', 'AUDIT-HY4-1']
  for (const name of audits) {
    const text = read(join(ROOT, 'docs', `${name}.md`))
    assert.equal(text.startsWith('> **历史快照**'), true, `docs/${name}.md 必须以「历史快照」页眉开头（否则里面的行数/路由数会被当成现状）`)
    assert.equal(text.includes('不代表现状'), true, `docs/${name}.md 的页眉必须写明"不代表现状"`)
  }
})

test('⑥ 文档纪律：DECISIONS 头部唯一 H1，且含「发版是原子动作」决策', () => {
  const text = read(join(ROOT, 'docs/DECISIONS.md'))
  // "头部"= 前 8 个非空行；只允许"文档 H1 + `# 决策：…` 条目标题"这两种 H1。
  // ⚠ 判据刻意**不依赖行号**：原先的写法是"取到第一个后续 `# ` 之前"，于是"在头部插一行 H1"反而让它提前收口、
  //   判据照样绿（反例注入实测踩到）。按"允许哪两种 H1"判才拦得住重复页眉。
  const headLines = text.split('\n').filter((l) => l.trim() !== '').slice(0, 8)
  const h1 = headLines.filter((l) => /^#\s/.test(l))
  assert.equal(h1.length >= 1, true, '头部必须有文档 H1')
  assert.equal(h1[0].includes('决策与历史过程'), true, '第一行 H1 必须是"决策与历史过程"')
  for (const extra of h1.slice(1)) {
    assert.equal(extra.startsWith('# 决策：'), true, `头部出现多余的 H1（只允许"# 决策：…"条目标题）：${extra}`)
  }
  assert.equal(text.includes('发版必须是**原子动作**'), true, 'DECISIONS 必须记录"发版是原子动作"这条决策')
  assert.equal(text.includes('确认产物里真的含新版本号'), true, '该决策必须写明"确认产物含新版本号"这一步')
  assert.equal(text.includes('__TW_VERSION__'), true, '该决策必须指向 build.mjs 的版本注入校验')
})
