/**
 * IMPL-81（护盘「覆盖广度」展示 + 跨日「信号收件箱」）的可检查判据。
 *
 * 仓库惯例：**真源码 + 纯函数 + 反例注入**（每条注入都必须让判据非空 / 断言抛错）。
 * 覆盖七条硬要求：
 *   ① 主线短标记格式（`3 族 · 5/6`）且无长句；完整口径进悬停
 *   ② 字段缺失 ⇒ `—` + 原因（不许 0 顶替）
 *   ③ 收件箱不含等级 0 / 资金异动（等级 1）
 *   ④ 排序：等级优先、同等级时间倒序
 *   ⑤ 合并：5 分钟内同等级并为一条 + 计数 + 得分取最大值
 *   ⑥ 已读写 prefs（不写 rescue-log）
 *   ⑦ 空态必须有「最近一次信号在 X 天前」+ 本期统计
 * 另加：跨文件字段同步、字号阶梯/无动画（不闪烁）、零新依赖。
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
import {
  INBOX_MERGE_MS, INBOX_MIN_LEVEL, INBOX_RETAIN_DAYS, dayDiffOf, inboxEntryTitleOf, inboxReadMapOf,
  inboxViewOf, markInboxRead, mergeInboxEvents, pruneInboxRead, shiftDayOf, sortInboxEntries,
} from './rescueInbox.ts'
import type { InboxEntry, InboxEvent } from './rescueInbox.ts'
import type { RescueCoverage } from '../shared/model.ts'
import { TW_CSS } from './styles.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')
const panelSrc = (): string => read('RescuePanel.tsx')
/** 剥注释（只留代码与字符串）：注释里会写"不许写 rescue-log"这类说明，不能当成违规 */
const stripComments = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** 构造一条收件箱事件（`+08:00` 写死 ⇒ 与运行时时区无关） */
function ev(day: string, hhmm: string, level: 0 | 1 | 2 | 3, score: number): InboxEvent {
  return { day, ts: Date.parse(`${day}T${hhmm}:00+08:00`), hhmm, level, score }
}

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

// ══ ③ 收件箱不含等级 0 / 资金异动 ══════════════════════════════════════════

/** 判据（测试侧）：收件箱里不许出现等级 < 2 的条目 */
function inboxLevelProblems(entries: readonly InboxEntry[]): string[] {
  return entries.filter((e) => e.level < 2).map((e) => `出现等级 ${e.level} 的条目：${e.id}`)
}

test('③ 收件箱只收「疑似护盘」及以上：等级 0（平静）与等级 1（资金异动，基率 100%）都不入箱', () => {
  assert.equal(INBOX_MIN_LEVEL, 2, '入箱门槛锁在 2（资金异动基率 100%，列出来等于噪音）')
  const events = [ev('2026-10-16', '10:00', 0, 20), ev('2026-10-16', '10:01', 1, 46), ev('2026-10-16', '10:02', 2, 61)]
  const view = inboxViewOf({ events, read: {}, today: '2026-10-17', coveredDays: 30 })
  assert.equal(view.entries.length, 1, '三条里只有等级 2 那条入箱')
  assert.deepEqual(inboxLevelProblems(view.entries), [])
  assert.equal(view.all.some((e) => e.level <= 1), false, '等级 0/1 不进收件箱（连统计也不含）')
  // 反例注入：把「资金异动」也列进去 ⇒ 判据必须非空
  const withLevelOne: InboxEntry[] = [
    ...view.entries,
    { id: '2026-10-16#1#0', day: '2026-10-16', level: 1, startTs: Date.parse('2026-10-16T10:01:00+08:00'), startHhmm: '10:01', endHhmm: '10:01', score: 46, count: 1 },
  ]
  assert.deepEqual(inboxLevelProblems(withLevelOne).length, 1)
  assert.throws(
    () => assert.deepEqual(inboxLevelProblems(withLevelOne), [], '反例上"不收资金异动"必须失败'),
    /反例上/,
    '⚠ 反例注入（把资金异动列入）必须让断言失败',
  )
})

// ══ ④ 排序：等级优先、同级时间倒序 ═════════════════════════════════════════

/** 判据（测试侧）：等级非升，同等级内开始时刻非升 */
function orderProblems(entries: readonly InboxEntry[]): string[] {
  const out: string[] = []
  for (let i = 1; i < entries.length; i += 1) {
    const a = entries[i - 1]
    const b = entries[i]
    if (b.level > a.level) out.push(`等级上升：${a.id} → ${b.id}`)
    else if (a.level === b.level && b.startTs > a.startTs) out.push(`同等级内时间上升：${a.id} → ${b.id}`)
  }
  return out
}

test('④ 排序：等级优先，同等级内时间倒序（不是纯时间倒序）', () => {
  const events = [
    ev('2026-10-15', '10:00', 2, 60),
    ev('2026-10-16', '09:40', 3, 80), // 等级 3 实盘不再产生，但排序函数必须对任意等级成立
    ev('2026-10-16', '14:00', 2, 62),
    ev('2026-10-15', '14:30', 2, 58),
  ]
  const sorted = sortInboxEntries(mergeInboxEvents(events))
  assert.deepEqual(
    sorted.map((e) => `${e.level}@${e.day} ${e.startHhmm}`),
    ['3@2026-10-16 09:40', '2@2026-10-16 14:00', '2@2026-10-15 14:30', '2@2026-10-15 10:00'],
    '高等级在前；同等级内时间倒序',
  )
  assert.deepEqual(orderProblems(sorted), [])
  // 反例注入：纯时间倒序 ⇒ 等级优先被破坏
  const timeOnly = [...sorted].sort((a, b) => b.startTs - a.startTs)
  assert.notDeepEqual(orderProblems(timeOnly), [], '⚠ 纯时间倒序必须被抓到')
  assert.throws(
    () => assert.deepEqual(orderProblems(timeOnly), [], '反例上"等级优先"必须失败'),
    /反例上/,
    '⚠ 反例注入（纯时间倒序）必须让断言失败',
  )
})

// ══ ⑤ 合并：5 分钟内同等级、计数正确、得分取最大 ═════════════════════════════

test('⑤ 合并：同等级 5 分钟内一条 + 计数正确 + 得分取窗口内**最大**（不是最新）', () => {
  assert.equal(INBOX_MERGE_MS, 5 * 60 * 1000)
  const start = Date.parse('2026-10-16T14:30:00+08:00')
  const events: InboxEvent[] = [
    { day: '2026-10-16', ts: start, hhmm: '14:30', level: 2, score: 60 },
    { day: '2026-10-16', ts: start + 2 * 60 * 1000, hhmm: '14:32', level: 2, score: 72 },
    { day: '2026-10-16', ts: start + 4 * 60 * 1000, hhmm: '14:34', level: 2, score: 55 }, // 最新一条分数最低
    { day: '2026-10-16', ts: start + 5 * 60 * 1000, hhmm: '14:35', level: 2, score: 61 }, // 正好 5 分钟 ⇒ 仍合并
    { day: '2026-10-16', ts: start + 6 * 60 * 1000, hhmm: '14:36', level: 2, score: 66 }, // 超出窗口 ⇒ 新的一条
    { day: '2026-10-16', ts: start + 60 * 1000, hhmm: '14:31', level: 3, score: 90 },     // 同刻不同等级 ⇒ 不合并
  ]
  const merged = mergeInboxEvents(events)
  assert.equal(merged.length, 3, '两条窗口 + 一条不同等级')
  const first = merged.find((e) => e.level === 2 && e.startHhmm === '14:30')
  assert.notEqual(first, undefined, '14:30 那个窗口必须存在')
  assert.equal((first as InboxEntry).count, 4, '14:30–14:35 共 4 条（含正好 5 分钟那条；中间的等级 3 不切断它）')
  assert.equal((first as InboxEntry).endHhmm, '14:35')
  assert.equal((first as InboxEntry).score, 72, '得分 = 窗口内最大值（取最新会得到 61 ⇒ 被回落拉低）')
  const second = merged.find((e) => e.level === 2 && e.startHhmm === '14:36')
  assert.equal((second as InboxEntry).score, 66)
  assert.equal((second as InboxEntry).count, 1)
  assert.equal(merged.filter((e) => e.level === 3).length, 1, '同等级才合并：等级 3 单独一条')
  // 悬停说明必须交代"取最高不是最新"
  assert.ok(inboxEntryTitleOf(first).includes('窗口内最高 72'))
  // 反例注入 A：得分取最新 ⇒ 61 ≠ 72
  const latest = { ...first, score: 61 }
  const scoreProblems = (e: InboxEntry, want: number): string[] => (e.score === want ? [] : [`得分 ${e.score} ≠ 窗口内最高 ${want}`])
  assert.deepEqual(scoreProblems(first, 72), [])
  assert.notDeepEqual(scoreProblems(latest, 72), [], '⚠ 取最新必须被抓到')
  assert.throws(() => assert.deepEqual(scoreProblems(latest, 72), [], '反例上"取最大"必须失败'), /反例上/)
  // 反例注入 B：不合并（一条事件一个条目）⇒ 条数与计数都不对
  const unmerged = events.map<InboxEntry>((e) => ({
    id: `${e.day}#${e.level}#${e.ts}`, day: e.day, level: e.level, startTs: e.ts,
    startHhmm: e.hhmm ?? '', endHhmm: e.hhmm ?? '', score: e.score, count: 1,
  }))
  assert.equal(unmerged.length, 6)
  assert.notEqual(unmerged.length, merged.length, '⚠ 不合并必须被抓到（条数不同）')
  assert.throws(() => assert.equal(unmerged.length, 3, '反例上"合并后 3 条"必须失败'), /反例上/)
})

// ══ ⑥ 已读写 prefs（不写 rescue-log）═════════════════════════════════════════

const READ_AT = Date.parse('2026-10-17T09:00:00+08:00')

/** 取面板里某个 `const name = (…) => { … }` 的函数体（用于只扫描"已读"这条写路径） */
function fnBlockOf(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = (`)
  if (at < 0) return ''
  const end = src.indexOf('\n  }\n', at)
  return end < 0 ? src.slice(at) : src.slice(at, end + 4)
}

/** 判据（测试侧）：已读只能走偏好接口，绝不许碰行情日志 */
function readWriteProblems(block: string): string[] {
  const out: string[] = []
  if (!/api\s*\.\s*setPrefs\(/.test(block)) out.push('已读必须写偏好（api.setPrefs）')
  for (const bad of ['rescue-log', 'ledger', 'mutateWatch', 'mutatePortfolio', 'localStorage']) {
    if (block.includes(bad)) out.push(`已读路径出现了 ${bad}（阅读偏好不是行情记录）`)
  }
  return out
}

test('⑥ 已读状态存 prefs：未读筛选生效、窗口外裁剪；面板只写 setPrefs（不写 rescue-log）', () => {
  // 纯函数：标记已读 ⇒ 收件箱里消失，但统计还在（"已读"不是"没发生过"）
  const events = [ev('2026-10-16', '14:30', 2, 61), ev('2026-10-16', '14:34', 2, 66), ev('2026-10-18', '10:00', 2, 59)]
  const before = inboxViewOf({ events, read: {}, today: '2026-10-19', coveredDays: 30 })
  assert.equal(before.unread, 2)
  const read = markInboxRead({}, [before.entries[0].id], READ_AT)
  assert.equal(read[before.entries[0].id], READ_AT, '已读记的是"什么时候看的"（epoch ms）')
  const after = inboxViewOf({ events, read, today: '2026-10-19', coveredDays: 30 })
  assert.equal(after.unread, 1, '读过的那条从收件箱消失')
  assert.equal(after.total, before.total, '已读不改统计总量（"我看过"≠"没发生"）')
  assert.equal(after.all.some((e) => e.id === before.entries[0].id), true, '已读条目仍在 all 里（统计与"最近一次"要用）')
  // 读侧宽容归一：坏 prefs 不许崩、不许把坏值当已读
  assert.deepEqual(inboxReadMapOf(null), {})
  assert.deepEqual(inboxReadMapOf({ a: 1, b: 'x', c: Number.NaN, ' ': 3 }), { a: 1 })
  // 窗口外裁剪：31 天前的 key 必须被裁掉（避免 prefs 无限长）
  const old = '2026-09-01#2#1'
  const kept = '2026-10-18#2#2'
  assert.deepEqual(pruneInboxRead({ [old]: 1, [kept]: 2 }, '2026-10-19'), { [kept]: 2 })
  // 源码：已读写偏好、且这条路径里没有日志写入
  const markRead = fnBlockOf(panelSrc(), 'markRead')
  assert.notEqual(markRead, '', '面板必须有 markRead 函数（判据不许空跑）')
  assert.ok(markRead.includes('rescueInboxRead'), '必须写 `rescueInboxRead` 这个偏好键')
  assert.deepEqual(readWriteProblems(markRead), [])
  // 面板**代码**里不许出现 rescue-log（注释里说明"不写 rescue-log"是允许的，那是文档）
  assert.equal(stripComments(panelSrc()).includes('rescue-log'), false, '客户端代码不许碰 rescue-log（日志是宿主的）')
  // 反例注入：把 setPrefs 换成写日志/写别的接口 ⇒ 判据必须非空
  const injected = markRead
    .replace(/api\s*\.\s*setPrefs\(/, "api.mutateWatch('/tradewatcher/rescue-log', ")
    .replace('rescueInboxRead: next', 'body: next')
  assert.notEqual(injected, markRead, '⚠ 注入点必须存在')
  assert.notDeepEqual(readWriteProblems(injected), [], '⚠ 写 rescue-log 必须被抓到')
  assert.throws(
    () => assert.deepEqual(readWriteProblems(injected), [], '反例上"已读只写 prefs"必须失败'),
    /反例上/,
    '⚠ 反例注入（写 rescue-log）必须让断言失败',
  )
  // 宿主未接受该偏好时不许假装成功：面板必须有一条如实说明
  assert.ok(panelSrc().includes('已读状态本次未存盘（宿主未接受该偏好）'), '未存盘必须如实告知')
})

// ══ ⑦ 空态：最近一次信号在 X 天前 + 本期统计 ═══════════════════════════════

/**
 * 判据（测试侧）：历史还在路上时**不许报空态**（会先说"最近一次信号在 30 天前以外"，是假否定）。
 * 「取数中」分支必须存在，且排在空态元素**之前**。
 */
function inboxPendingGuardProblems(src: string): string[] {
  const out: string[] = []
  const pending = src.indexOf('inboxPending > 0')
  const empty = src.indexOf("'data-role': 'rescue-inbox-empty'")
  if (pending < 0) out.push('缺少"取数中"分支（inboxPending）')
  if (empty < 0) out.push('缺少空态分支（rescue-inbox-empty）')
  if (pending >= 0 && empty >= 0 && pending > empty) out.push('"取数中"分支必须排在空态之前')
  return out
}

/** 判据（测试侧）：空态不许只有"无信号" */
function emptyTextProblems(text: string): string[] {
  const out: string[] = []
  if (!text.startsWith('最近一次信号在')) out.push('缺少「最近一次信号在 …」这句（只有"无信号"会被读成系统坏了）')
  if (!/本期（\d+ 天）/.test(text)) out.push('缺少本期统计')
  if (text.trim() === '无信号' || text.trim() === '暂无信号') out.push('只写了"无信号"')
  return out
}

test('⑦ 空态：最近一次信号在 X 天前 + 本期统计（全部已读 / 完全没有信号两种都说清）', () => {
  const today = '2026-10-19'
  const events = [ev('2026-10-16', '14:30', 2, 61), ev('2026-10-16', '14:34', 2, 66)]
  const first = inboxViewOf({ events, read: {}, today, coveredDays: 30 })
  const read = Object.fromEntries(first.entries.map((e) => [e.id, READ_AT]))
  const allRead = inboxViewOf({ events, read, today, coveredDays: 30 })
  assert.equal(allRead.entries.length, 0, '全部已读 ⇒ 收件箱为空')
  assert.ok(allRead.emptyText.startsWith('最近一次信号在'), allRead.emptyText)
  assert.ok(allRead.emptyText.includes('3 天前'), `要写清几天前：${allRead.emptyText}`)
  assert.ok(allRead.emptyText.includes('本期（30 天）'), `要带本期统计：${allRead.emptyText}`)
  assert.ok(allRead.emptyText.includes('最高 疑似护盘'), '统计里给最高等级')
  assert.deepEqual(emptyTextProblems(allRead.emptyText), [])
  // 完全没有信号：也不许只写"无信号"，且"自采样起只有 N 天"与"30 天窗口"必须分开说
  const none = inboxViewOf({ events: [], read: {}, today, coveredDays: 8 })
  assert.ok(none.emptyText.startsWith('最近一次信号在'), none.emptyText)
  assert.ok(none.emptyText.includes('自采样起只有 8 天日志'), `天数不足时要说清窗口：${none.emptyText}`)
  assert.ok(none.emptyText.includes('0 天有信号'), '统计照给 0（这是真的 0，不是缺失）')
  assert.deepEqual(emptyTextProblems(none.emptyText), [])
  // 旧日志里只有等级 3（该项已从等级集删除）⇒ 统计用短名，不把"已删除，不再出现"塞进统计句
  const lv3 = inboxViewOf({ events: [ev('2026-10-16', '10:00', 3, 90)], read: {}, today, coveredDays: 30 })
  assert.ok(lv3.statsText.includes('最高 强护盘（历史）'), lv3.statsText)
  const full = inboxViewOf({ events: [], read: {}, today, coveredDays: INBOX_RETAIN_DAYS })
  assert.ok(full.emptyText.includes(`窗口只回溯 ${INBOX_RETAIN_DAYS} 天`), '满窗口时说明只回溯 30 天（更早没查）')
  // 保留窗口：31 天前的信号必须被裁掉（"保留 30 天"）
  const stale = inboxViewOf({ events: [ev(shiftDayOf(today, -31), '10:00', 2, 70)], read: {}, today, coveredDays: 30 })
  assert.equal(stale.total, 0, '超过 30 天的信号不入箱')
  assert.equal(dayDiffOf('2026-10-19', '2026-10-16'), 3)
  assert.equal(dayDiffOf('bad', '2026-10-16'), null, '非法日期 ⇒ null（不返回 0 顶替）')
  // 面板真的渲染了这句（否则上面全是纯函数自说自话）
  assert.ok(panelSrc().includes("'data-role': 'rescue-inbox-empty'"), '空态容器必须存在')
  assert.ok(panelSrc().includes('inbox.emptyText'), '空态必须渲染唯一实现的整句')
  // 取数中不许报空态：历史还在路上时说"最近一次信号在 30 天前以外"是假否定
  assert.deepEqual(inboxPendingGuardProblems(panelSrc()), [])
  const noGuard = panelSrc().split('inboxPending > 0').join('false')
  assert.notEqual(noGuard, panelSrc(), '⚠ 注入点必须存在')
  assert.notDeepEqual(inboxPendingGuardProblems(noGuard), [], '⚠ 去掉"取数中"守卫必须被抓到')
  assert.throws(
    () => assert.deepEqual(inboxPendingGuardProblems(noGuard), [], '反例上"取数中守卫"必须失败'),
    /反例上/,
    '⚠ 反例注入（去掉取数中守卫）必须让断言失败',
  )
  // 反例注入：只写"无信号" ⇒ 判据必须非空
  assert.notDeepEqual(emptyTextProblems('无信号'), [], '⚠ 只写"无信号"必须被抓到')
  assert.throws(
    () => assert.deepEqual(emptyTextProblems('无信号'), [], '反例上"空态必须给最近一次"必须失败'),
    /反例上/,
    '⚠ 反例注入（只写无信号）必须让断言失败',
  )
})

// ══ ⑧ 纪律：字号阶梯 / 无动画（不闪烁）/ 零新依赖 ═══════════════════════════

test('⑧ 收件箱与短标记：字号在 12/12.5/13/13.5/14 阶梯内、无 animation（不闪烁）、零新依赖', () => {
  const css = TW_CSS.replace(/\s+/g, '')
  const ladder = [12, 12.5, 13, 13.5, 14]
  for (const cls of ['.tw-rescue-cov{', '.tw-rescue-inbox{', '.tw-rescue-inbox-row{']) {
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
  // 零新依赖：两个新模块只许 import 相对路径 / 共享契约
  for (const f of ['rescueCoverage.ts', 'rescueInbox.ts']) {
    const src = read(f)
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1]
      assert.ok(spec.startsWith('./') || spec.startsWith('../shared/'), `${f} 引入了可疑依赖：${spec}`)
    }
  }
  // 悬停口径全文 vs 可见短句：两者分开（可见那行不许变成整段）
  const p2 = panelSrc()
  const caliberProblems = (src: string): string[] => {
    const out: string[] = []
    if (!/title: INBOX_CALIBER/.test(src)) out.push('悬停必须挂口径全文（INBOX_CALIBER）')
    if (!/shortReason\(INBOX_SHORT_HINT/.test(src)) out.push('可见那行必须是短句（INBOX_SHORT_HINT）')
    return out
  }
  assert.deepEqual(caliberProblems(p2), [])
  const thinTitle = p2.split('title: INBOX_CALIBER').join('title: INBOX_SHORT_HINT')
  assert.notEqual(thinTitle, p2, '⚠ 注入点必须存在')
  assert.notDeepEqual(caliberProblems(thinTitle), [], '⚠ 悬停只剩短句必须被抓到')
  assert.throws(
    () => assert.deepEqual(caliberProblems(thinTitle), [], '反例上"悬停给全文"必须失败'),
    /反例上/,
    '⚠ 反例注入（悬停只挂短句）必须让断言失败',
  )
  // 不做推送/红点
  const panel = panelSrc()
  assert.equal(/new\s+Notification\b/.test(panel), false, '不做系统推送')
  assert.equal(/Notification\.requestPermission/.test(panel), false, '不申请通知权限')
})
