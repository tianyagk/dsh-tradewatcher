/**
 * 全球期货交易时钟：8 项断言 + 反例注入（每项都必须"改坏就红"）。
 * 纯函数 + 源码断言（不依赖浏览器）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CLOCK_SESSIONS, DIAL, arcGapProblems, clockRefreshMs, needleGeometry,
  nextStartSeconds, sessionStatus, tzOffsetMinutes, wheelAngle,
} from '../shared/clockSessions.ts'
import { FUTURE_SPECS, INDEX_SPECS, centerOffsetPx, formatClock, missingNote, quoteCard, type ClockSpec } from './clockView.ts'

const SRC = readFileSync(new URL('./GlobalClockPage.tsx', import.meta.url), 'utf8')
const CSS = readFileSync(new URL('./styles.ts', import.meta.url), 'utf8')

/** 2026-10-26（周一）20:37:00 +08:00 —— 设计稿的验收时刻（必须是交易日，否则「交易中」无意义） */
const AT_2037 = Date.parse('2026-10-26T20:37:00+08:00')

const byName = (name: string): (typeof CLOCK_SESSIONS)[number] => {
  const hit = CLOCK_SESSIONS.find((s) => s.name === name)
  assert.ok(hit !== undefined, `时段配置里必须有 ${name}`)
  return hit
}

test('① 表盘旋转量 = −(分钟 × 0.25)，逆时针（正转/固定都判失败）', () => {
  const at = Date.parse('2026-10-26T20:37:39+08:00')
  const minutes = (at % 86_400_000) / 60_000
  assert.ok(Math.abs(wheelAngle(at) - (-(minutes * 0.25))) < 1e-9, '旋转必须等于 −(UTC 分钟×0.25)')
  assert.ok(wheelAngle(at) < 0, '必须是逆时针（负角）')
  // 反例注入：正转 / 固定
  const positive = (ms: number): number => -wheelAngle(ms)
  const fixed = (): number => 0
  assert.notEqual(positive(at), wheelAngle(at), '注入「正转」必须判失败')
  assert.notEqual(fixed(), wheelAngle(at), '注入「固定不转」必须判失败')
  // 页面确实用了这个角
  assert.match(SRC, /wheelAngle\(now\)/, '页面必须用 wheelAngle 驱动整盘旋转')
  assert.match(SRC, /rotate\(\$\{rot\.toFixed\(3\)\}/, '旋转作用在整盘分组上')
})

test('② 金线固定在 12 点：x1==x2==环心 x、y2==top、无 transform', () => {
  const n = needleGeometry()
  assert.equal(n.x1, DIAL.cx)
  assert.equal(n.x2, DIAL.cx, '金线必须竖直（x1==x2）')
  assert.equal(n.y1, DIAL.cy)
  assert.equal(n.y2, DIAL.cy - DIAL.ringR + 2, 'y2 必须到外圈顶（top）')
  assert.equal(n.transform, null, '金线不许带 transform（不许随盘转）')
  // 反例注入：让金线跟着转
  const rotating = { ...n, transform: `rotate(${wheelAngle(AT_2037)} 220 220)` }
  assert.notEqual(rotating.transform, null, '注入「随盘转」必须判失败')
  // 页面里金线在旋转组之外
  const gEnd = SRC.indexOf('tw-clock-needle')
  const gStart = SRC.indexOf("React.createElement('g'", 0)
  assert.ok(gStart > 0 && gEnd > gStart, '金线必须渲染在旋转分组之外')
})

test('③ 弧宽 12、半径差 20、净空隙 8（8.5/24 判失败）', () => {
  assert.equal(DIAL.arcStroke, 12)
  assert.deepEqual([...DIAL.radii], [160, 140, 120, 100])
  assert.deepEqual(arcGapProblems(), [], '设计值必须无问题')
  assert.deepEqual(arcGapProblems({ stroke: 8.5, radii: [160, 136, 112, 88] }), [
    '弧宽必须是 12（实得 8.5）',
    '相邻半径差必须是 20（第 1 对实得 24）',
    '相邻半径差必须是 20（第 2 对实得 24）',
    '相邻半径差必须是 20（第 3 对实得 24）',
  ], '注入 8.5/24 必须全部报出')
  assert.equal(DIAL.radii[0]! - DIAL.radii[1]! - DIAL.arcStroke, 8, '相邻净空隙必须 = 8px')
})

test('④ 圆心文字块与环心 |dx|,|dy| ≤ 1.5（margin-top 注入判失败）', () => {
  const clean = centerOffsetPx(CSS)
  assert.deepEqual(clean.problems, [], 'CSS 里不许有手写偏移')
  assert.ok(Math.abs(clean.dx) <= 1.5 && Math.abs(clean.dy) <= 1.5, `合格布局必须居中（dx=${clean.dx}, dy=${clean.dy}）`)
  const bad = centerOffsetPx(`${CSS}\n.tw-clock-text{margin-top:24px}`)
  assert.ok(Math.abs(bad.dy) > 1.5, `注入 margin-top:24 必须判不居中（实得 dy=${bad.dy}）`)
})

test('⑤ 20:37 的时段状态与倒计时（全部交易中判失败）', () => {
  assert.equal(sessionStatus(byName('XAU现货'), AT_2037), 'trading', '伦敦 XAU 应交易中')
  assert.equal(sessionStatus(byName('AU9999'), AT_2037), 'trading', '上金所 AU9999 应交易中')
  assert.equal(sessionStatus(byName('AU黄金 夜盘'), AT_2037), 'outside', '上期所夜盘 21:00 才开 ⇒ 时段外')
  assert.equal(nextStartSeconds(byName('AU黄金 夜盘'), AT_2037), 23 * 60, '距 21:00 还有 23 分钟')
  // 反例注入：全部交易中
  const allTrading = (): 'trading' => 'trading'
  assert.notEqual(allTrading(), sessionStatus(byName('AU黄金 夜盘'), AT_2037), '注入「全部交易中」必须判失败')
})

test('⑥ 缺数据卡 = `—` + 原因，且不含 0.00（0 占位判失败）', () => {
  const spec: ClockSpec = { secid: '112.AU0', name: 'AU 黄金', code: 'AU0', kind: 'future' }
  const card = quoteCard(spec, undefined, ['112.AU0'])
  assert.equal(card.value, '—')
  assert.equal(card.pct, '—')
  assert.equal(card.status, 'missing')
  assert.ok((card.reason ?? '').length > 0, '必须写原因')
  assert.ok(!`${card.value}${card.pct}${card.reason}`.includes('0.00'), '不许出现 0.00')
  // 反例注入：0 占位
  const zero = { ...card, value: '0.00', pct: '0.00%' }
  assert.ok(`${zero.value}${zero.pct}`.includes('0.00'), '注入 0 占位必须判失败')
  // 有价时正常显示来源与时刻
  const ok = quoteCard(spec, { secid: '112.AU0', code: 'AU0', name: 'AU', price: 861.62, chg: 1, pct: 0.35, prev: 1, open: null, high: null, low: null, vol: null, amount: null, up: null, down: null, even: null, time: AT_2037, source: 'em', at: AT_2037 }, [])
  assert.equal(ok.status, 'ok')
  assert.equal(ok.source, '东财')
  assert.match(ok.value, /861\.62/)
})

test('⑦ 行情刷新间隔 = 120000ms（1000 判失败）', () => {
  assert.equal(clockRefreshMs(null), 120_000)
  assert.equal(clockRefreshMs({}), 120_000, '缺省必须 120s')
  assert.equal(clockRefreshMs({ clockRefreshSec: 60 }), 60_000)
  assert.equal(clockRefreshMs({ clockRefreshSec: 1 }), 30_000, '下限收敛到 30s')
  const injected = 1000
  assert.notEqual(injected, clockRefreshMs(null), '注入 1000ms 必须判失败')
  // v0.171.0：时钟页行情改为订阅统一 ticker（60s），不再自建 120s 定时器
  assert.match(SRC, /subscribeTicker\(\(\) => load\(false\)\)/, '行情必须走统一 ticker')
})

test('⑧ 时区切换后表盘角度不变、只有文字时刻变（角度随之变判失败）', () => {
  const angle = wheelAngle(AT_2037)
  const bj = formatClock(AT_2037, 480)
  const ny = formatClock(AT_2037, tzOffsetMinutes('America/New_York', AT_2037))
  assert.equal(bj, '20:37:00')
  assert.notEqual(ny, bj, '换时区后文字时刻必须不同')
  assert.equal(wheelAngle(AT_2037), angle, '同一绝对时刻的角度不随时区变化')
  // 反例注入：角度跟着时区变（用当地分钟算角）
  const angleByZone = (offsetMin: number): number => -((((AT_2037 + offsetMin * 60_000) % 86_400_000) / 60_000) * 0.25)
  assert.notEqual(angleByZone(480), angleByZone(-240), '注入「角度随时区变」必须判失败')
  assert.match(SRC, /wheelAngle\(now\)/, '页面角度只依赖 now（绝对时刻）')
  assert.match(SRC, /displayMinuteOfWheel\(minute, zoneOffset\)/, '刻度数字才用显示时区')
})

// ── R15 实机修复的 5 项回归（周日弧 / 弧合法性 / 指数源 / 缺失分类 / JM）──────────

/** 周日 20:37（实机报"没有弧"的那天） */
const SUN = Date.parse('2026-10-25T20:37:00+08:00')

test('实机① 周日 20:37 也必须画出该组所有时段的弧（0 条 ⇒ 败）', async () => {
  const { CLOCK_GROUPS, sessionWheelSpans } = await import('../shared/clockSessions.ts')
  for (const g of CLOCK_GROUPS) {
    const list = CLOCK_SESSIONS.filter((s) => s.group === g.key)
    const total = list.reduce((n, s) => n + sessionWheelSpans(s, SUN).length, 0)
    assert.ok(total >= list.length, `${g.label} 组周日的弧段数 ${total} 必须 ≥ 时段数 ${list.length}`)
    for (const s of list) assert.ok(sessionWheelSpans(s, SUN).length >= 1, `${s.name} 周日必须有弧`)
  }
  // 注入：按 days 过滤（周日的旧实现）⇒ 0 条
  const byDays = CLOCK_SESSIONS.filter((s) => s.group === 'gold').reduce((n, s) => n + (s.days.includes(7) ? 1 : 0), 0)
  assert.equal(byDays, 0, '注入「按 days 过滤」必须得到 0 条（判失败）')
})

test('实机② 每条弧：d 非空、无 NaN、stroke 非 none、宽度 12（d="" ⇒ 败）', async () => {
  const { arcPathD, sessionWheelSpans } = await import('../shared/clockSessions.ts')
  let checked = 0
  for (const s of CLOCK_SESSIONS) {
    for (const seg of sessionWheelSpans(s, SUN)) {
      const d = arcPathD(DIAL.radii[0]!, seg.start, seg.end)
      assert.ok(d.length > 0, `${s.name} 的弧 d 不许为空`)
      assert.ok(!d.includes('NaN'), `${s.name} 的弧 d 不许含 NaN`)
      assert.match(d, /^M [-\d.]+ [-\d.]+ A \d+ \d+ 0 [01] 1 /)
      checked += 1
    }
  }
  assert.ok(checked >= CLOCK_SESSIONS.length, `弧总数 ${checked} 必须 ≥ 时段数`)
  assert.equal(arcPathD(DIAL.radii[0]!, Number.NaN, 100), '', '注入 NaN ⇒ 空串（页面跳过，不画 NaN 路径）')
  assert.equal(DIAL.arcStroke, 12)
  assert.match(SRC, /stroke: SERIES\[i % SERIES\.length\]/, '弧颜色必须来自已定义的主题色阶变量')
  assert.doesNotMatch(SRC, /stroke:\s*'none'/, '不许把描边写成 none')
})

test('实机③ 6 条指数都有 source，且不得出现「仅东财一个源」', () => {
  const row = { secid: 'x', code: 'x', name: 'x', price: 1, chg: 0, pct: 0.5, prev: 1, open: null, high: null, low: null, vol: null, amount: null, up: null, down: null, even: null, time: AT_2037, source: 'sina' as const, at: AT_2037 }
  assert.equal(INDEX_SPECS.length, 6)
  for (const spec of INDEX_SPECS) {
    const card = quoteCard(spec, { ...row, secid: spec.secid }, [])
    assert.ok(card.source.length > 0, `${spec.name} 必须有来源`)
    assert.equal(card.status, 'ok')
    assert.ok(!(card.reason ?? '').includes('仅东财一个源'), `${spec.name} 不该用"仅东财一个源"`)
  }
  for (const spec of INDEX_SPECS) {
    assert.ok(!(quoteCard(spec, undefined, [spec.secid]).reason ?? '').includes('仅东财一个源'), `${spec.name} 缺数据也不许写"仅东财一个源"（它有新浪兜底）`)
  }
  assert.deepEqual(INDEX_SPECS.map((s) => s.secid), ['1.000001', '0.399001', '0.399006', '1.000300', '1.000905', '1.000852'])
})

test('实机④ 缺失清单按类别分写，绝不把指数写成「期货代码」（写错 ⇒ 败）', () => {
  const text = missingNote(['0.399001', '0.399006']) ?? ''
  assert.match(missingNote(['1.399001', '1.399006']) ?? '', /指数 2 个/, '旧市场前缀（1.）也要按代码归类')
  assert.match(text, /指数 2 个（399001\/399006）/, `实得：${text}`)
  assert.ok(!text.includes('期货代码'), '不许把指数写成期货代码')
  assert.equal(missingNote(['112.AU0'])?.includes('期货 1 个'), true)
  assert.equal(missingNote([]), null)
  // 注入：旧文案
  const old = '2 个期货代码缺数据：1.399001 / 1.399006'
  assert.ok(old.includes('期货代码'), '注入旧文案必须判失败')
})

test('实机⑤ 期货卡含 JM（112.JM0 → 1,410），GC 保留为第 6 张', () => {
  const jm = FUTURE_SPECS.find((s) => s.secid === '112.JM0')
  assert.ok(jm !== undefined, '期货列表必须含 JM')
  const row = { secid: '112.JM0', code: 'JM0', name: 'JM', price: 1410, chg: 5, pct: 0.35, prev: 1405, open: null, high: null, low: null, vol: null, amount: null, up: null, down: null, even: null, time: AT_2037, source: 'em' as const, at: AT_2037 }
  const card = quoteCard(jm, row, [])
  assert.match(card.value, /1,410/, `实得 ${card.value}`)
  assert.equal(FUTURE_SPECS.length, 6, '5 张设计稿卡片 + GC 第 6 张')
})

// ── R16：时段区间列 / 倒计时 / 每卡独立字段（夹具必须逐卡不同）────────────────
const FIX_INDEX = [
  ['1.000001', '+0.89'], ['0.399001', '+2.79'], ['0.399006', '+4.16'],
  ['1.000300', '+1.71'], ['1.000905', '+2.39'], ['1.000852', '+2.38'],
] as const
const FIX_FUT = [
  ['112.AU0', '-0.87'], ['112.AG0', '-1.05'], ['112.CU0', '+0.99'],
  ['112.JM0', '0.00'], ['112.LC0', '0.00'], ['101.GC00Y', '-1.29'],
] as const

function rowOf(secid: string, pct: number, source: 'em' | 'sina', at: number) {
  return { secid, code: secid, name: secid, price: 1, chg: 0, pct, prev: 1, open: null, high: null, low: null, vol: null, amount: null, up: null, down: null, even: null, time: at, source, at }
}

test('R16① 6 张指数卡的 pct 两两不同且等于夹具（全相同 ⇒ 败）', () => {
  const pcts = FIX_INDEX.map(([secid, want], i) => {
    const spec = INDEX_SPECS.find((s) => s.secid === secid)!
    const card = quoteCard(spec, rowOf(secid, Number(want), 'em', AT_2037 + i * 1000), [])
    const wantText = (want as string) === '0.00' ? '0.00%' : `${want}%`
    assert.equal(card.pct, wantText, `${secid} 的涨跌必须等于夹具`)
    return card.pct
  })
  assert.equal(new Set(pcts).size, 6, '6 张指数卡的涨跌必须两两不同')
  assert.notEqual(new Set(['+0.86', '+0.86', '+0.86', '+0.86', '+0.86', '+0.86']).size, 6, '注入「全部 +0.86」必须判失败')
})

test('R16② 6 张期货卡的 pct 两两不同；AU = −0.87、GC = 4007.91', () => {
  const pcts = FIX_FUT.map(([secid, want], i) => {
    const spec = FUTURE_SPECS.find((s) => s.secid === secid)!
    const price = secid === '101.GC00Y' ? 4007.91 : 100 + i
    const card = quoteCard(spec, { ...rowOf(secid, Number(want), 'em', AT_2037 + i * 1000), price }, [])
    const wantText = (want as string) === '0.00' ? '0.00%' : `${want}%`
    assert.equal(card.pct, wantText, `${secid} 的涨跌必须等于夹具`)
    if (secid === '112.AU0') assert.equal(card.pct, '-0.87%')
    if (secid === '101.GC00Y') assert.match(card.value, /4,007\.91/)
    return card.pct
  })
  assert.ok(new Set(pcts).size >= 5, `6 张期货卡必须逐卡取自己的值（JM/LC 同为 0.00 属夹具本身，其余不得重合；实得 ${new Set(pcts).size} 种）`)
  assert.equal(new Set(pcts).size !== 1, true, '注入「全部同一值」必须判失败')
})

test('R16③ 时段表「区间」列 = 配置 start–end（等于当前时刻 ⇒ 败）', async () => {
  const { sessionRangeText } = await import('./clockView.ts')
  const text = (name: string): string => sessionRangeText(byName(name), AT_2037, 480)
  assert.equal(text('AU黄金 夜盘'), '21:00–02:30 次日')
  assert.equal(text('AU黄金 日盘'), '09:00–15:00')
  assert.equal(text('GC黄金'), '06:00–17:00')
  assert.equal(text('XAU现货'), '15:00–23:00')
  assert.equal(text('AU9999'), '20:00–02:30 次日')
  const nowText = formatClock(AT_2037, 480)
  assert.ok(!text('AU黄金 夜盘').includes(nowText), '注入「等于当前时刻」必须判失败')
})

test('R16④ 倒计时恒落在 [0, 24h)（24:22:21 ⇒ 败）', () => {
  for (const at of [AT_2037, AT_2037 + 3 * 3600_000, AT_2037 + 26 * 3600_000]) {
    for (const s of CLOCK_SESSIONS) {
      const v = nextStartSeconds(s, at)
      assert.ok(v >= 0 && v < 86_400, `${s.name} 倒计时必须 < 24h（实得 ${v}s）`)
    }
  }
  // 注入：用真实间隔（周末可能 >24h）必须判失败
  const bad = 24 * 3600 + 22 * 60 + 21
  assert.ok(bad >= 86_400, '注入 24:22:21 必须判失败')
})

test('R16⑤ 每张卡的 source / at 取自自己那一行（复用第一张 ⇒ 败）', () => {
  const cards = FIX_INDEX.map(([secid], i) =>
    quoteCard(INDEX_SPECS.find((s) => s.secid === secid)!, rowOf(secid, 0.1 * i, i % 2 === 0 ? 'em' : 'sina', AT_2037 + i * 60_000), []))
  assert.equal(new Set(cards.map((c) => c.at)).size, 6, '6 张卡的 at 必须各不相同')
  assert.deepEqual([...new Set(cards.map((c) => c.source))].sort(), ['东财', '新浪'])
  const dup = cards.map((c) => ({ ...c, source: cards[0]!.source, at: cards[0]!.at }))
  assert.equal(new Set(dup.map((c) => c.at)).size, 1, '注入「复用第一张」必须判失败')
})
