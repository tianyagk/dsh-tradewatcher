/**
 * 外部交易日历文件（用户每月手工更新一次，**不进仓库**）：
 * 覆盖判定 / 优先级 / 校验与隔离 / 退回内置时的可见告警。
 *
 * 对应 docs/AUDIT-IMPL49.md 的断言 ①–④（⑤ 由注入脚本证明，日志 /tmp/tradingcal-audit/inject/）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = mkdtempSync(join(tmpdir(), 'tradingcal-'))
if (!BASE.startsWith('/tmp')) throw new Error(`拒绝运行：实验目录必须在 /tmp 下（收到 ${BASE}）`)

/** 每个用例一个干净的 HOME（模块按 mtime+size 缓存，必须显式 reset） */
async function freshEnv(content: string | null, name: string): Promise<{ dir: string; cal: typeof import('./tradingCalendar.ts') }> {
  const dir = join(BASE, name)
  mkdirSync(join(dir, 'dsh-tradewatcher'), { recursive: true })
  process.env.DSH_HOME = dir
  const path = join(dir, 'dsh-tradewatcher', 'trading-calendar.json')
  if (content !== null) writeFileSync(path, content, 'utf8')
  const cal = await import('./tradingCalendar.ts')
  cal.__resetTradingCalendarCache()
  await cal.loadTradingCalendar({ quarantineBroken: true })
  return { dir, cal }
}

const NOW = Date.parse('2026-10-14T10:00:00+08:00') // 当月 = 2026-10（周三，非内置假日）

const validFile = JSON.stringify({
  v: 1,
  source: '上交所 2026 年部分节假日休市安排（上证公告〔2025〕45号）',
  updatedAt: '2026-10-08',
  months: {
    '2026-10': ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-14'],
    '2026-11': [],
  },
}, null, 2)

test('① 文件覆盖当月且正确 ⇒ 用它（含"内置表没有的日期"）', async () => {
  const { cal } = await freshEnv(validFile, 'ok')
  const st = cal.externalCalendarStatus()
  assert.notEqual(st, null)
  assert.equal(st?.source, 'external', '覆盖当月 ⇒ 生效来源是外部文件')
  assert.equal(st?.coveredThisMonth, true)
  assert.equal(st?.warning, null, '覆盖当月不得有告警')
  assert.deepEqual(st?.closuresThisMonth, ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-14'])
  assert.equal(cal.monthCoveredByFile('2026-10'), true)
  assert.equal(cal.externalClosureOf('2026-10-14'), true, '文件里写的工作日休市必须生效（内置表没有它）')
  assert.equal(cal.externalClosureOf('2026-10-15'), false)
  // 空数组的月份也算"已覆盖"（缺键才是未覆盖）
  assert.equal(cal.monthCoveredByFile('2026-11'), true)
  assert.equal(cal.monthCoveredByFile('2026-12'), false)
})

test('④ 优先级：外部文件与内置表冲突时以文件为准（两个方向都测）', async () => {
  // 方向一：文件把内置表认为**交易日**的 10-09 标成休市 ⇒ 必须休市
  const conflictA = JSON.stringify({ v: 1, months: { '2026-10': ['2026-10-09'] } })
  const a = await freshEnv(conflictA, 'conflict-a')
  const { tradingDayState, samplingWindow } = await import('./rescue.ts')
  const ts = Date.parse('2026-10-09T10:00:00+08:00')
  assert.equal(a.cal.externalClosureOf('2026-10-09'), true)
  assert.equal(tradingDayState(ts).trading, false, '文件说是休市 ⇒ 就是休市（覆盖内置表的"交易日"结论）')
  assert.equal(tradingDayState(ts).label, '外部日历（手工维护）')
  assert.equal(samplingWindow(ts, { enabled: true, intervalSec: 30, samples: 0 }).reason, 'holiday')
  // 方向二：文件覆盖当月但**没写**内置表里的 10-06 ⇒ 以文件为准 ⇒ 视作交易日
  const conflictB = JSON.stringify({ v: 1, months: { '2026-10': [] } })
  const b = await freshEnv(conflictB, 'conflict-b')
  const builtinHoliday = Date.parse('2026-10-06T10:00:00+08:00')
  assert.equal(b.cal.monthCoveredByFile('2026-10'), true)
  assert.equal(tradingDayState(builtinHoliday).trading, true, '覆盖当月 ⇒ 内置表不参与（用户可以用"不写"纠正过期的内置条目）')
})

test('② 文件未覆盖当月 ⇒ 退回内置表 + 告警可见（不许静默）', async () => {
  const notCovered = JSON.stringify({ v: 1, months: { '2026-09': ['2026-09-25'] } })
  const { cal } = await freshEnv(notCovered, 'uncovered')
  const st = cal.externalCalendarStatus()
  assert.equal(st?.fileExists, true, '文件确实存在（只是没覆盖本月）')
  assert.equal(st?.coveredThisMonth, false)
  assert.equal(st?.source, 'builtin', '未覆盖 ⇒ 生效来源必须如实写"内置表"')
  assert.match(String(st?.warning), /未更新到本月/, '告警文案必须说明未更新到本月')
  assert.match(String(st?.warning), /2026-10/, '告警必须点名缺哪个月')
  // 退回内置后，内置表的国庆仍生效
  const { tradingDayState } = await import('./rescue.ts')
  const hol = Date.parse('2026-10-06T10:00:00+08:00')
  assert.equal(tradingDayState(hol).trading, false)
  assert.equal(tradingDayState(hol).label, '国庆节', '退回内置 ⇒ 假期名来自内置表')
})

test('② 告警必须出现在快照与 agent 工具输出里（可见位置）', async () => {
  const notCovered = JSON.stringify({ v: 1, months: { '2026-09': [] } })
  const { dir } = await freshEnv(notCovered, 'visible')
  const { RescueMonitor } = await import('./rescue.ts')
  const realNow = Date.now
  Date.now = () => NOW
  try {
    const mon = new RescueMonitor(join(dir, 'hol'), { enabled: true, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [] })
    await mon.init()
    const snap = mon.snapshot()
    assert.equal(snap.calendarStatus?.coveredThisMonth, false)
    assert.match(String(snap.calendarStatus?.warning), /未更新到本月/)
    assert.match(snap.summary, /⚠/, '快照归因必须带上告警（面板直接显示 summary）')
    assert.match(snap.summary, /未更新到本月/)
  } finally {
    Date.now = realNow
  }
})

test('③ 文件不合法（重复/跨月/坏 JSON/版本不认识）⇒ 隔离留痕 + 退回内置', async () => {
  const cases: Array<[string, string, RegExp]> = [
    ['dup', JSON.stringify({ v: 1, months: { '2026-10': ['2026-10-06', '2026-10-06'] } }), /重复/],
    ['wrong-month', JSON.stringify({ v: 1, months: { '2026-10': ['2026-09-30'] } }), /不在它所属的月份/],
    ['bad-json', '{ "v": 1, "months": { "2026-10": [ "2026-10-06" ', /JSON 解析失败/],
    ['bad-version', JSON.stringify({ v: 2, months: { '2026-10': [] } }), /v 必须是 1/],
    ['bad-date', JSON.stringify({ v: 1, months: { '2026-10': ['2026/10/06'] } }), /非法日期/],
  ]
  const { tradingDayState } = await import('./rescue.ts')
  for (const [name, content, pattern] of cases) {
    const { dir, cal } = await freshEnv(content, `bad-${name}`)
    const st = cal.externalCalendarStatus()
    assert.equal(st?.source, 'builtin', `${name}：必须退回内置表`)
    assert.notEqual(st?.invalid, null, `${name}：必须留痕（invalid 非空）`)
    assert.match(String(st?.invalid?.reason), pattern, `${name}：原因要指名问题`)
    const q = st?.invalid?.quarantinePath ?? null
    assert.notEqual(q, null, `${name}：必须给出隔离去向`)
    assert.equal(existsSync(String(q)), true, `${name}：隔离文件必须真的存在`)
    assert.equal(existsSync(`${String(q)}.reason.txt`), true, `${name}：隔离必须留下 .reason.txt`)
    assert.equal(readdirSync(join(dir, 'dsh-tradewatcher')).some((f) => f.includes('.invalid-')), true)
    // 退回后内置表仍然生效（不是"空表"）
    assert.equal(tradingDayState(Date.parse('2026-10-06T10:00:00+08:00')).trading, false, `${name}：退回内置表后国庆仍应休市`)
    assert.equal(tradingDayState(Date.parse('2026-10-06T10:00:00+08:00')).label, '国庆节')
  }
})

test('③ 周末条目：不计入、不隔离，但如实报数', async () => {
  const withWeekend = JSON.stringify({ v: 1, months: { '2026-10': ['2026-10-03', '2026-10-04', '2026-10-06'] } })
  const { cal } = await freshEnv(withWeekend, 'weekend-entries')
  const st = cal.externalCalendarStatus()
  assert.equal(st?.invalid, null, '周末条目无害 ⇒ 不该隔离')
  assert.equal(st?.ignoredWeekends, 2, '10-03/10-04 是周末 ⇒ 计 2 条')
  assert.deepEqual(st?.closuresThisMonth, ['2026-10-06'])
})

test('② 文件不存在 ⇒ 不是"损坏"，也不误报（退回内置、告警为 null）', async () => {
  const { cal } = await freshEnv(null, 'missing')
  const st = cal.externalCalendarStatus()
  assert.equal(st?.fileExists, false)
  assert.equal(st?.source, 'builtin')
  assert.equal(st?.warning, null, '没有文件不算"未更新"（首次使用不该报错）')
  assert.equal(st?.invalid, null)
})

test('⑤ 只读校验入口：报告给出文件路径、覆盖情况与未来 10 天判定', async () => {
  const { cal } = await freshEnv(validFile, 'cli')
  const { tradingDayState } = await import('./rescue.ts')
  const rep = await cal.calendarCheckReport(NOW, tradingDayState)
  assert.equal(rep.path, join(BASE, 'cli', 'dsh-tradewatcher', 'trading-calendar.json'))
  assert.equal(rep.status.coveredThisMonth, true)
  assert.equal(rep.upcoming.length, 10)
  assert.equal(rep.upcoming[0]?.day, '2026-10-14')
  assert.equal(rep.upcoming[0]?.trading, false, '文件里 10-14 是休市（外部日历）')
  assert.match(String(rep.upcoming[0]?.reason), /外部日历/)
})
