/**
 * IMPL-81（护盘「覆盖广度」展示）的可检查判据。
 *
 * ⚠ IMPL-85（v0.113.0）已**移除**同一批交付里的「跨日信号收件箱」（用户判定无用）：本文件里
 * 只与收件箱相关的用例（原 ③④⑤⑥⑦）连同被测模块 `rescueInbox.ts` 一起删除；覆盖广度的用例
 * 原样保留，原 ⑧「字号阶梯 / 无动画 / 零新依赖」只把**被检查的类名与模块清单**收窄到
 * `rescueCoverage.ts` / `.tw-rescue-cov`（判据强度不变，仍带反例注入）。
 * 移除清单与注入读数见 `docs/AUDIT-IMPL85.md`；历史审计 `docs/AUDIT-IMPL81.md` 不改写。
 *
 * 仓库惯例：**真源码 + 纯函数 + 反例注入**（每条注入都必须让判据非空 / 断言抛错）。
 * 覆盖本模块剩余的四条硬要求：
 *   ① 主线短标记格式（`3 族 · 5/6`）且无长句；完整口径进悬停
 *   ② 字段缺失 ⇒ `—` + 原因（不许 0 顶替）
 *   ③ 读侧字段与宿主契约逐键一致
 *   ④ 字号阶梯 / 无动画（不闪烁）/ 零新依赖 / 不做推送
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  COVERAGE_ABSENT_REASON, COVERAGE_STAGE_NOTE, COVERAGE_STAGE_NOTE_ON, COVERAGE_Z_THRESHOLD,
  coverageBadgeOf, coverageMarkerOf, coverageMissingOf, latestCoverageOf,
} from './rescueCoverage.ts'
import type { RescueCoverage } from '../shared/model.ts'
import { TW_CSS } from './styles.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')
const panelSrc = (): string => read('RescuePanel.tsx')

// ══ ① 覆盖广度短标记：格式 + 无长句；口径进悬停 ═════════════════════════════

/** 判据（测试侧）：常驻短标记必须是 `N 族 · a/b` 或 `—`，且不许出现任何口径长句片段 */
function markerProblems(marker: string): string[] {
  const out: string[] = []
  if (marker !== '—' && !/^\d+ 族 · \d+\/\d+$|^\d+ 族 · —$|^— · \d+\/\d+$/.test(marker)) out.push(`格式不是「N 族 · a/b」：${marker}`)
  if (marker.length > 12) out.push(`常驻太长（${marker.length} 字）：${marker}`)
  for (const token of ['未计入', '评分', '口径', '阈值', 'z ≥', '，', '；', '族 =', '宿主']) {
    if (marker.includes(token)) out.push(`常驻里出现了口径长句片段「${token}」`)
  }
  if (/^\d+ 族 · 0\/0$/.test(marker)) out.push('分母 0 不成立，不许写 0/0')
  return out
}

/** 判据（测试侧）：源码里覆盖广度标记的**可见子节点只能是 `cov.marker`** */
function markerChildProblems(src: string): string[] {
  const out: string[] = []
  if (!src.includes("'data-role': 'rescue-coverage-badge'")) out.push('缺少 data-role 锚点（判据会退化成空跑）')
  if (!/\},\s*badge\.marker\)/.test(src)) out.push('常驻可见内容必须只有 badge.marker（口径不许上主线）')
  if (!src.includes('title: badge.title')) out.push('完整口径必须进 title')
  if (!src.includes("'aria-label': `覆盖广度 ${badge.marker}")) out.push('完整口径必须进 aria-label（键盘/读屏可达）')
  return out
}

test('① 覆盖短标记 `3 族 · 5/6`：短、无长句；三族归属 / z≥2 / 两档确认读数 / 阶段状态全在悬停', () => {
  const cov: RescueCoverage = {
    nEtf: 5, nEtfWithData: 6, nFamily: 3, families: ['大盘', '中小盘', '成长'],
    confirm1: 'strong', confirm1N: 5, confirm2: -0.42,
  }
  const badge = coverageBadgeOf({ coverage: cov, why: [], enabled: false })
  assert.equal(badge.marker, '3 族 · 5/6', '短标记 = 族数 ·（同向通道 / 有读数通道）')
  assert.deepEqual(markerProblems(badge.marker), [], '主线短标记必须干净')
  assert.equal(badge.missing, null, '数据完整时不该报缺失')
  // 悬停逐项（一条都不许丢）
  assert.ok(badge.title.includes('大盘、中小盘、成长'), '悬停要给三族归属')
  assert.ok(badge.title.includes(`z ≥ ${COVERAGE_Z_THRESHOLD}`), '悬停要写 z ≥ 2 的阈值')
  assert.ok(badge.title.includes('同向通道 5 条'), '悬停要给 confirm1 的读数')
  assert.ok(badge.title.includes('-0.42'), '悬停要给 confirm2 的读数')
  assert.ok(badge.title.includes('覆盖广度当前未计入评分（阶段一）'), '悬停必须说明阶段一未计入评分')
  assert.equal(badge.title.includes(COVERAGE_STAGE_NOTE_ON), false, '阶段一不许说"已计入评分"')
  // 真实源码：常驻只渲染 marker
  assert.deepEqual(markerChildProblems(panelSrc()), [])
  // 反例注入 A：把整段口径塞进常驻 ⇒ 判据必须非空
  assert.notDeepEqual(markerProblems(badge.title), [], '⚠ 整段口径当常驻必须被抓到')
  assert.throws(
    () => assert.deepEqual(markerProblems(badge.title), [], '反例上"主线无长句"必须失败'),
    /反例上/,
    '⚠ 反例注入（口径上主线）必须让断言失败',
  )
  // 反例注入 B：源码里把可见子节点换成 badge.title ⇒ 判据必须非空
  const src = panelSrc()
  const injected = src.replace(/\},\s*badge\.marker\)/, '}, badge.title)')
  assert.notEqual(injected, src, '⚠ 注入点必须存在（否则这条断言是空跑）')
  assert.notDeepEqual(markerChildProblems(injected), [], '⚠ 常驻渲染 title 必须被抓到')
  assert.throws(
    () => assert.deepEqual(markerChildProblems(injected), [], '反例上"常驻只有短标记"必须失败'),
    /反例上/,
    '⚠ 反例注入（源码级）必须让断言失败',
  )
  // 开关打开（阶段二）时说真话：不再声称"未计入评分"
  const on = coverageBadgeOf({ coverage: cov, why: [], enabled: true })
  assert.ok(on.title.includes(COVERAGE_STAGE_NOTE_ON))
  assert.equal(on.title.includes(COVERAGE_STAGE_NOTE), false, '阶段二不许继续说"未计入评分"')
})

test('①b 读侧字段与宿主 `RescueCoverage` 契约逐键一致（改一处不改另一处 ⇒ 红）', () => {
  const model = readFileSync(join(here, '..', 'shared', 'model.ts'), 'utf8')
  const m = /export interface RescueCoverage \{([\s\S]*?)\n\}/.exec(model)
  assert.notEqual(m, null, '宿主必须定义 `RescueCoverage`（阶段一契约）')
  const keys = [...(m as RegExpExecArray)[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((x) => x[1])
  assert.deepEqual(
    keys,
    ['nEtf', 'nEtfWithData', 'nFamily', 'families', 'confirm1', 'confirm1N', 'confirm2'],
    '客户端读的七个键必须与宿主契约同名同序',
  )
  // 快照/事件上的落点也必须还在（客户端读的是这两处）
  for (const field of ['coverage?: RescueCoverage | null', 'coverageWhy?: string[]', 'coverageEnabled?: boolean']) {
    assert.ok(model.includes(field), `${field} 必须仍在快照契约里`)
  }
})

// ══ ② 字段缺失 ⇒ `—` + 原因（不许 0 顶替）═══════════════════════════════════

/**
 * 判据（测试侧）：`absent = true` 表示"宿主根本没给这块字段"的情形 ——
 * 那时短标记必须是 `—` 且必须带原因；任何一个数字（尤其 0）都等于把未知当已知。
 */
function missingReasonProblems(badge: { marker: string; missing: string | null }, absent: boolean): string[] {
  const out: string[] = []
  if (!absent) return out
  if (badge.missing === null) out.push('整块缺失却没有原因（被 0 顶替了）')
  if (badge.marker !== '—') out.push(`整块缺失时短标记必须是 —，实际是「${badge.marker}」（用 0 冒充读数）`)
  return out
}

test('② 覆盖广度缺失 ⇒ `—` + 原因；部分缺失只影响那半段；分母 0 不写 0/0', () => {
  // 整块缺失（老宿主 / 本会话还没采样）
  const absent = coverageBadgeOf({ coverage: null, why: [], enabled: false })
  assert.equal(absent.marker, '—')
  assert.equal(absent.missing, COVERAGE_ABSENT_REASON)
  assert.ok(absent.title.includes(COVERAGE_ABSENT_REASON), '悬停里也要给原因')
  assert.deepEqual(missingReasonProblems(absent, true), [])
  // 部分缺失：confirm1N 没取到 ⇒ 后半段 `—`，前半段照常，原因点名该字段
  const partial = coverageBadgeOf({
    coverage: { nEtf: 4, nEtfWithData: 6, nFamily: 2, families: ['大盘', '成长'], confirm1: 'same', confirm2: null },
    why: ['30 年国债 ETF 未取到（本次行情批次里没有它）'],
    enabled: false,
  })
  assert.equal(partial.marker, '2 族 · —')
  assert.ok((partial.missing ?? '').includes('confirm1N'), `缺失原因要点名字段：${partial.missing}`)
  assert.ok((partial.missing ?? '').includes('30 年国债 ETF'), '宿主 coverageWhy 的原因要原样带上')
  // 分母 0 是合法数据态（基线不足）⇒ 显示 `—` 并说明，不写 `0/0`
  const zeroData = coverageBadgeOf({
    coverage: { nEtf: 0, nEtfWithData: 0, nFamily: 0, families: [], confirm1: 'mixed', confirm1N: 0, confirm2: null },
    why: [],
    enabled: false,
  })
  assert.equal(zeroData.marker, '0 族 · —', '分母 0 ⇒ 那半段 —（不是 0/0）')
  assert.ok((zeroData.missing ?? '').includes('分母不成立'))
  // `—` 的两半都不许用 0 冒充"读数"
  assert.equal(coverageMarkerOf(null), '—')
  assert.notEqual(coverageMarkerOf(null), '0 族 · 0/0')
  // 反例注入：缺失时用 0 顶替（marker 变成 0 族 · 0/6 且没有原因）⇒ 判据必须非空
  const fabricated = { marker: '0 族 · 0/6', missing: null }
  assert.notDeepEqual(missingReasonProblems(fabricated, true), [], '⚠ 用 0 顶替必须被抓到')
  assert.throws(
    () => assert.deepEqual(missingReasonProblems(fabricated, true), [], '反例上"缺失必须带原因"必须失败'),
    /反例上/,
    '⚠ 反例注入（写 0）必须让断言失败',
  )
  // 快照级取值：优先 snapshot.coverage，老宿主退回最新事件
  const fromTop = latestCoverageOf({ coverage: { nFamily: 1 } as RescueCoverage, coverageWhy: [], today: [] })
  assert.equal(fromTop.coverage?.nFamily, 1)
  const fromEvent = latestCoverageOf({ coverage: null, today: [{ coverage: { nFamily: 2 } as RescueCoverage, coverageWhy: ['x'] }, null] })
  assert.equal(fromEvent.coverage?.nFamily, 2, '老宿主没有 snapshot.coverage 时退回最新事件')
  assert.deepEqual(fromEvent.why, ['x'])
  assert.deepEqual(coverageMissingOf(null), [COVERAGE_ABSENT_REASON])
})

// ══ ⑧ 纪律：字号阶梯 / 无动画（不闪烁）/ 零新依赖 / 不做推送 ═════════════════

test('⑧ 覆盖短标记：字号在 12/12.5/13/13.5/14 阶梯内、无 animation（不闪烁）、零新依赖', () => {
  const css = TW_CSS.replace(/\s+/g, '')
  const ladder = [12, 12.5, 13, 13.5, 14]
  for (const cls of ['.tw-rescue-cov{']) {
    const at = css.indexOf(cls)
    assert.ok(at >= 0, `样式里必须有 ${cls}`)
    const block = css.slice(at, css.indexOf('}', at) + 1)
    for (const m of block.matchAll(/font-size:([\d.]+)px/g)) {
      assert.ok(ladder.includes(Number(m[1])), `${cls} 的字号 ${m[1]}px 不在阶梯内`)
    }
    assert.equal(/animation/.test(block), false, `${cls} 不许有 animation（不做闪烁）`)
    assert.equal(/transition/.test(block), false, `${cls} 不许有 transition（静态列表）`)
    // 间距必须是 1px 整数刻度
    for (const m of block.matchAll(/(?:gap|padding|margin|max-height):([^;}]+)/g)) {
      for (const part of m[1].split(/[\s,]+/)) {
        const px = /^(-?\d+(?:\.\d+)?)px$/.exec(part)
        if (px) assert.ok(Number.isInteger(Number(px[1])), `${cls} 的间距必须落在 1px 刻度：${part}`)
      }
    }
  }
  // 判据不许空跑：注入一个不在阶梯内 / 带 animation 的块 ⇒ 同一判据必须失败
  const ladderProblems = (block: string): string[] => {
    const out: string[] = []
    for (const m of block.matchAll(/font-size:([\d.]+)px/g)) {
      if (!ladder.includes(Number(m[1]))) out.push(`字号 ${m[1]}px 不在阶梯内`)
    }
    if (/animation/.test(block)) out.push('出现 animation')
    return out
  }
  assert.deepEqual(ladderProblems('.x{font-size:12px}'), [])
  assert.notDeepEqual(ladderProblems('.x{font-size:11px}'), [], '⚠ 阶梯外字号必须被抓到')
  assert.notDeepEqual(ladderProblems('.x{font-size:12px;animation:blink 1s}'), [], '⚠ animation 必须被抓到')
  // 零新依赖：覆盖广度模块只许 import 相对路径 / 共享契约
  for (const f of ['rescueCoverage.ts']) {
    const src = read(f)
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1]
      assert.ok(spec.startsWith('./') || spec.startsWith('../shared/'), `${f} 引入了可疑依赖：${spec}`)
    }
  }
  // 不做推送/红点
  const panel = panelSrc()
  assert.equal(/new\s+Notification\b/.test(panel), false, '不做系统推送')
  assert.equal(/Notification\.requestPermission/.test(panel), false, '不申请通知权限')
})
