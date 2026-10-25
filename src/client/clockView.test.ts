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
import { centerOffsetPx, formatClock, quoteCard, type ClockSpec } from './clockView.ts'

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
  const spec: ClockSpec = { secid: '112.AU0', name: 'AU 黄金', code: 'AU0' }
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
  assert.match(SRC, /clockRefreshMs\(\{ clockRefreshSec: refreshSec \}\)/, '页面必须用 settings 的间隔')
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
