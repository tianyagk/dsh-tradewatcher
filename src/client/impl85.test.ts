/**
 * IMPL-85：移除护盘「跨日信号收件箱」的**结构性判据**（客户端 + 全仓运行时源码 + 构建产物）。
 *
 * 为什么用"全仓扫描"而不是只钉着 `RescuePanel.tsx` 看：v0.110.0 的收件箱横跨五处
 * （面板区块 / `rescueInbox.ts` / `PortPrefs.rescueInboxRead` / `store.ts` 归一与写分支 / `.tw-*` 样式），
 * 只删界面会留下"回了 200 但值不落盘"这类半成品。扫描覆盖面 = `src` 下**非测试**的
 * `.ts`/`.tsx` + `lib/index.js` + `lib/client.js`。
 *
 * ⚠ 测试文件被排除在扫描之外（**不是放宽**）：`src/host/impl85.test.ts` 必须能拼出旧键名，
 * 才能模拟"删不掉的老 prefs.json / 老客户端 patch"这条宽容性判据；运行时源码里则一个字都不许留。
 * ⚠ 产物半边怎么算：`lib/` 被 `.gitignore` 忽略，且 `npm run check` 的 `build` 排在 `test` 之后
 * ⇒ 产物**存在就必须干净**，不存在则只扫源码（没有产物就没有可残留的字节；已在代码里写死这条规则）。
 *
 * 三条判据各配反例注入（塞回/删掉 ⇒ 必须失败）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { TW_CSS } from './styles.ts'

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = join(here, '..')
const repoRoot = join(srcRoot, '..')
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')

/** 递归收集 `src` 下的运行时源码（排除 `*.test.ts`，理由见文件头） */
function runtimeSources(dir = srcRoot): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name)
    if (name.isDirectory()) out.push(...runtimeSources(full))
    else if (/\.tsx?$/.test(name.name) && !/\.test\.ts$/.test(name.name)) out.push(full)
  }
  return out
}

interface Scanned {
  path: string
  text: string
}

/**
 * 收件箱的特征串：任一出现即视为"移除不完整"。
 * 前四条是用户点名要扫的；后四条是它的实现痕迹（模块名 / 常量前缀 / 两个样式类 / 空态锚点）。
 */
const INBOX_TOKENS = [
  '收件箱',
  '最近一次信号在',
  '只列疑似护盘及以上',
  'rescueInboxRead',
  'rescueInbox',
  'INBOX_',
  'tw-rescue-inbox',
  'rescue-inbox-empty',
]

/** 判据（测试侧）：扫描集合里命中的特征串（空 = 干净） */
function inboxTracesIn(files: readonly Scanned[]): string[] {
  const hits: string[] = []
  for (const f of files) {
    for (const token of INBOX_TOKENS) {
      if (f.text.includes(token)) hits.push(`${f.path} 出现「${token}」`)
    }
  }
  return hits
}

function scanTargets(): { files: Scanned[]; artifacts: string[] } {
  const files: Scanned[] = runtimeSources().map((p) => ({ path: p, text: readFileSync(p, 'utf8') }))
  const artifacts: string[] = []
  for (const rel of ['lib/index.js', 'lib/client.js']) {
    const full = join(repoRoot, rel)
    if (existsSync(full)) {
      artifacts.push(rel)
      files.push({ path: rel, text: readFileSync(full, 'utf8') })
    }
  }
  return { files, artifacts }
}

test('① 收件箱已整块移除：模块不存在、运行时源码与构建产物零命中（注入：塞回任一串 ⇒ 必败）', () => {
  // 模块本体必须已删除（否则"删界面留管道"会从这里漏过去）
  assert.equal(existsSync(join(here, 'rescueInbox.ts')), false, 'src/client/rescueInbox.ts 必须已删除')

  const { files, artifacts } = scanTargets()
  // 判据不许空跑：扫描集合得真的覆盖到关键文件
  assert.ok(files.length >= 100, `扫描集合太小（${files.length} 个文件），判据可能空跑`)
  const names = files.map((f) => f.path)
  for (const must of ['RescuePanel.tsx', 'styles.ts']) {
    assert.ok(names.some((n) => n.endsWith(must)), `扫描集合必须包含 ${must}`)
  }
  assert.ok(names.some((n) => n.endsWith('host/store.ts')), '扫描集合必须包含宿主 store.ts')
  assert.ok(names.some((n) => n.endsWith('shared/model.ts')), '扫描集合必须包含共享 model.ts')
  /**
   * 产物半边：`lib/` 被 `.gitignore` 忽略、且 `npm run check` 的 `build` 排在 `test` **之后**
   * ⇒ 全新检出时产物可能还不存在（那时没有可残留的字节，只扫源码）。
   * 但产物**存在就必须干净** —— 这里不许为"旧产物里的残留"开后门。
   */
  if (artifacts.length === 0) {
    assert.equal(existsSync(join(repoRoot, 'lib')), false, 'lib/ 一个产物都没有才算"无产物可扫"；有目录没文件是坏构建状态')
  } else {
    assert.ok(artifacts.includes('lib/client.js'), `产物扫描必须覆盖 lib/client.js（实扫：${artifacts.join(', ')}）`)
    assert.ok(artifacts.includes('lib/index.js'), `产物扫描必须覆盖 lib/index.js（实扫：${artifacts.join(', ')}）`)
  }

  // 主判据
  assert.deepEqual(inboxTracesIn(files), [], '源码/产物里不许再出现收件箱的任何特征串')

  // 反例注入 A：逐条塞回一个合成文件 ⇒ 判据必须非空
  for (const token of INBOX_TOKENS) {
    const doctored: Scanned[] = [{ path: '（注入）', text: `const s = '${token}'` }]
    assert.notDeepEqual(inboxTracesIn(doctored), [], `⚠ 回填「${token}」必须被抓到`)
    assert.throws(
      () => assert.deepEqual(inboxTracesIn(doctored), [], `反例上「${token}」必须失败`),
      /反例上/,
      `⚠ 反例注入（回填 ${token}）必须让断言失败`,
    )
  }
  // 反例注入 B：塞回**真实**文件里（不是合成串）⇒ 判据同样必须非空
  const panel: Scanned = { path: 'RescuePanel.tsx', text: read('RescuePanel.tsx') }
  const store: Scanned = { path: 'store.ts', text: readFileSync(join(srcRoot, 'host', 'store.ts'), 'utf8') }
  const backPanel: Scanned = { path: panel.path, text: `${panel.text}\n// ${INBOX_TOKENS[0]}\n` }
  const backStore: Scanned = { path: store.path, text: `${store.text}\nconst x = patch.${INBOX_TOKENS[3]}\n` }
  assert.notEqual(backPanel.text, panel.text, '⚠ 注入点必须存在')
  assert.notEqual(backStore.text, store.text, '⚠ 注入点必须存在')
  assert.notDeepEqual(inboxTracesIn([backPanel, backStore]), [], '⚠ 真实文件回填必须被抓到')
})

/** 判据（测试侧）：今日信号时间线的四段实现缺一不可 */
function timelineProblems(panelSrc: string, css: string): string[] {
  const out: string[] = []
  if (!panelSrc.includes('今日信号时间线（${snapshot.today.length}）')) out.push('缺少「今日信号时间线（N）」标题')
  if (!panelSrc.includes('snapshot.today.map(')) out.push('缺少 snapshot.today 的渲染循环')
  if (!panelSrc.includes("className: 'tw-rescue-timeline'")) out.push('缺少时间线容器类名')
  if (!panelSrc.includes('e.hhmm')) out.push('时间线每行必须带时刻')
  if (!css.includes('.tw-rescue-timeline{')) out.push('样式里缺少 .tw-rescue-timeline')
  return out
}

test('② 今日信号时间线仍在（保留项）：标题/循环/样式齐全，`?day=` 历史回看链路仍在（注入：删掉 ⇒ 必败）', () => {
  const panelSrc = read('RescuePanel.tsx')
  assert.deepEqual(timelineProblems(panelSrc, TW_CSS), [])
  // `?day=` 历史回看（收件箱曾复用它，但回看本身保留）
  const apiSrc = read('api.ts')
  assert.ok(apiSrc.includes('rescueDay(day: string)'), '客户端必须仍能按天取历史（rescueDay）')
  assert.ok(apiSrc.includes('/tradewatcher/rescue?day='), '`?day=` 查询参数必须保留')
  assert.ok(panelSrc.includes('const openHistory = (day: string)'), '历史回看入口必须仍在')
  assert.ok(panelSrc.includes('历史回看（${data?.history.length ?? 0} 天'), '历史回看区块必须仍在')
  // 反例注入：把时间线整段删掉 ⇒ 同一判据必须非空
  const removedTimeline = panelSrc
    .split('今日信号时间线（${snapshot.today.length}）').join('')
    .split("className: 'tw-rescue-timeline'").join('')
    .split('snapshot.today.map(').join('')
  assert.notEqual(removedTimeline, panelSrc, '⚠ 注入点必须存在')
  assert.notDeepEqual(timelineProblems(removedTimeline, TW_CSS), [], '⚠ 连带删掉时间线必须被抓到')
  assert.throws(
    () => assert.deepEqual(timelineProblems(removedTimeline, TW_CSS), [], '反例上"时间线仍在"必须失败'),
    /反例上/,
    '⚠ 反例注入（删掉时间线）必须让断言失败',
  )
  // 注入：样式被删同样必须被抓到
  assert.notDeepEqual(timelineProblems(panelSrc, TW_CSS.replace('.tw-rescue-timeline{', '.tw-x{')), [], '⚠ 样式缺失必须被抓到')
})

/** 判据（测试侧）：覆盖广度徽标（与收件箱无关的保留项）四件套 */
function coverageProblems(panelSrc: string, css: string): string[] {
  const out: string[] = []
  if (!panelSrc.includes("'data-role': 'rescue-coverage-badge'")) out.push('缺少覆盖广度徽标的 data-role 锚点')
  if (!panelSrc.includes('function CoverageMark(')) out.push('缺少 CoverageMark 组件')
  if (!panelSrc.includes("className: 'tw-badge tw-rescue-cov'")) out.push('缺少覆盖广度样式类')
  if (!css.includes('.tw-rescue-cov{')) out.push('样式里缺少 .tw-rescue-cov')
  if (!panelSrc.includes('tabIndex: 0')) out.push('徽标必须键盘可达')
  return out
}

test('③ 覆盖广度徽标与悬停仍在（保留项）：组件/锚点/样式齐全（注入：删掉 ⇒ 必败）', () => {
  const panelSrc = read('RescuePanel.tsx')
  assert.deepEqual(coverageProblems(panelSrc, TW_CSS), [])
  assert.equal(existsSync(join(here, 'rescueCoverage.ts')), true, 'rescueCoverage.ts 必须保留（与收件箱无关）')
  // 反例注入：把徽标删掉 ⇒ 同一判据必须非空
  const removed = panelSrc
    .split("'data-role': 'rescue-coverage-badge'").join('')
    .split('function CoverageMark(').join('')
  assert.notEqual(removed, panelSrc, '⚠ 注入点必须存在')
  assert.notDeepEqual(coverageProblems(removed, TW_CSS), [], '⚠ 删掉覆盖广度徽标必须被抓到')
  assert.throws(
    () => assert.deepEqual(coverageProblems(removed, TW_CSS), [], '反例上"徽标仍在"必须失败'),
    /反例上/,
    '⚠ 反例注入（删掉徽标）必须让断言失败',
  )
})

test('④ 护盘面板其余保留项不随收件箱一起消失：等级/连续评分分位/当日峰/口径入口/抽样条', () => {
  const panelSrc = read('RescuePanel.tsx')
  const anchors: Array<[string, string]> = [
    ['RESCUE_LEVEL_LABEL', '等级文案'],
    ['continuousPercentile', '连续评分的近 20 日分位'],
    ['当日峰 ${peakToday', '当日抽样峰值'],
    ["'data-role': 'rescue-caliber'", '口径与边界悬停入口'],
    ['今日 5 分钟抽样（${snapshot.intraday.length}）', '当日 5 分钟抽样'],
    ['tw-rescue-history', '护盘历史回看列表'],
  ]
  for (const [token, what] of anchors) {
    assert.ok(panelSrc.includes(token), `保留项缺失：${what}（${token}）`)
  }
  // 注入：删掉任一保留锚点 ⇒ 上面的检查必须失败（证明它不是恒真）
  for (const [token, what] of anchors) {
    const doctored = panelSrc.split(token).join('')
    assert.notEqual(doctored, panelSrc, `⚠ 注入点必须存在：${what}`)
    assert.throws(
      () => assert.ok(doctored.includes(token), `反例上"${what}仍在"必须失败`),
      /反例上/,
      `⚠ 反例注入（删掉 ${what}）必须让断言失败`,
    )
  }
})
