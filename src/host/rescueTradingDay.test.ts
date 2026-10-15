/**
 * 护盘信号：**交易日历**（周末 + 法定假日不采样/不出等级/不写当日分）与**早盘等级线**。
 *
 * 对应 docs/AUDIT-IMPL48.md：① 休市日断言 ② 假日当交易日的反例（由注入脚本证明）
 * ③ 早盘 vs 午后的等级判定必须不同 ④ 去掉缩放必败（注入证明）⑤ 已收盘定稿语义不变。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LedgerEntry } from '../shared/model.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'rescue-audit-'))
if (!ROOT.startsWith('/tmp')) throw new Error(`拒绝运行：实验目录必须在 /tmp 下（收到 ${ROOT}）`)
mkdirSync(ROOT, { recursive: true })
process.env.DSH_HOME = ROOT

const REAL_NOW = Date.now
const holiday = Date.parse('2026-10-06T10:00:00+08:00') // 国庆节（周二）
const weekend = Date.parse('2026-10-10T10:00:00+08:00') // 周六
const trading = Date.parse('2026-10-09T10:00:00+08:00') // 周五（国庆后首个交易日）
const afterClose = Date.parse('2026-10-09T16:00:00+08:00') // 交易日、已收盘

test('① 交易日判定：周末与法定假日都是非交易日（交易日反证同时成立）', async () => {
  const { tradingDayState, holidayOf, inTradingWindow, A_SHARE_HOLIDAYS } = await import('./rescue.ts')
  assert.equal(tradingDayState(holiday).trading, false)
  assert.equal(tradingDayState(holiday).reason, 'holiday')
  assert.equal(tradingDayState(holiday).label, '国庆节', '必须给出假期名（界面要如实写原因）')
  assert.equal(tradingDayState(weekend).reason, 'weekend')
  assert.equal(tradingDayState(weekend).label, null)
  assert.equal(tradingDayState(trading).trading, true, '反证：国庆后的周五必须是交易日（否则判据恒真）')
  assert.equal(inTradingWindow(holiday), false, '法定假日不在采样窗口')
  assert.equal(inTradingWindow(weekend), false)
  assert.equal(inTradingWindow(trading), true, '反证：交易日 10:00 在采样窗口内')
  // 表本身：7 个假期段、边界日命中（上交所 2026 公告：国庆 10/1–10/7，10/8 起开市）
  assert.equal(A_SHARE_HOLIDAYS.length, 7)
  assert.notEqual(holidayOf('2026-10-07'), null)
  assert.equal(holidayOf('2026-10-08'), null, '10/8 是交易日（国庆 10/7 结束）')
  assert.notEqual(holidayOf('2026-01-03'), null, '元旦 1/3 在表内（周末另判）')
  assert.equal(holidayOf('2026-01-05'), null, '1/5 起照常开市')
  assert.notEqual(holidayOf('2026-02-23'), null, '春节 2/23 在表内')
})

test('① 采样窗口：假日/周末的原因与「下次采样」必须跳过假日', async () => {
  const { samplingWindow } = await import('./rescue.ts')
  const opts = { enabled: true, intervalSec: 30, samples: 3 }
  const h = samplingWindow(holiday, opts)
  assert.equal(h.sampling, false)
  assert.equal(h.reason, 'holiday')
  const w = samplingWindow(weekend, opts)
  assert.equal(w.reason, 'weekend')
  // 10/6 假期内 ⇒ 下次采样必须是 10/8 的 09:25 之后（不能指回假期里的 10/7 09:25）
  assert.notEqual(h.nextAt, null)
  const nextDay = new Date((h.nextAt as number) + 8 * 3600_000).toISOString().slice(0, 10)
  assert.equal(nextDay, '2026-10-08', `下次采样必须落在 10/8（实际 ${nextDay}）`)
  // 交易日 10:00 在窗口内
  assert.equal(samplingWindow(trading, opts).sampling, true)
  // 交易日收盘后：仍是 'closed'（不是 holiday/weekend）
  assert.equal(samplingWindow(afterClose, opts).reason, 'closed')
})

test('① 非交易日：sampleNow 不采样、零上游请求、不出等级、不写当日分', async () => {
  const { RescueMonitor } = await import('./rescue.ts')
  Date.now = () => holiday
  let fetches = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    fetches += 1
    throw new Error('非交易日不该发任何上游请求')
  }) as typeof fetch
  try {
    const mon = new RescueMonitor(join(ROOT, 'hol'), { enabled: true, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [] })
    await mon.init()
    const snap = await mon.sampleNow()
    assert.equal(fetches, 0, `非交易日必须零上游请求（实际 ${fetches} 条）`)
    assert.equal(snap.trading, false)
    assert.equal(snap.level, null, '休市不得出等级（null，不是 0=平静）')
    assert.equal(snap.score, 0)
    assert.equal(snap.nonTrading?.reason, 'holiday')
    assert.equal(snap.nonTrading?.label, '国庆节')
    assert.match(snap.summary, /休市（非交易日）/, '归因必须写明休市')
    assert.match(snap.summary, /国庆节/, '归因必须写明是哪个假期')
    assert.equal(mon.scoreLogOf('2026-10-06').length, 0, '非交易日不得写当日分（旧实现会写出一条"平静"）')
  } finally {
    globalThis.fetch = realFetch
    Date.now = REAL_NOW
  }
})

test('⑤ 回归：交易日已收盘仍走「定稿」语义（不是休市）', async () => {
  const { RescueMonitor, tradingDayState, inTradingWindow } = await import('./rescue.ts')
  assert.equal(tradingDayState(afterClose).trading, true, '交易日 16:00 仍是交易日')
  assert.equal(inTradingWindow(afterClose), false, '但不在采样窗口（已收盘）')
  Date.now = () => afterClose
  try {
    const mon = new RescueMonitor(join(ROOT, 'closed'), { enabled: true, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [] })
    await mon.init()
    const snap = await mon.snapshot()
    assert.equal(snap.nonTrading ?? null, null, '已收盘的交易日不得被标成"非交易日"')
    assert.notEqual(snap.level, null, '已收盘的交易日仍要给等级（定稿口径），只有非交易日才为 null')
  } finally {
    Date.now = REAL_NOW
  }
})

// ───────────────────────── 早盘等级线 ─────────────────────────

test('③ 等级线随时点系数缩放：同一输入在早盘更保守、尾盘更敏感（且 09:35 与 14:00 判定不同）', async () => {
  const { levelLines, RESCUE_LEVEL_BASE, RESCUE_WEIGHT_SUM } = await import('./rescue.ts')
  const early = levelLines(0.4) // 09:35
  const late = levelLines(1.1) // 14:00
  assert.deepEqual([...RESCUE_LEVEL_BASE], [35, 55], '等级线基准 = 历史值 35/55（**不乘权重合计**，v0.15.0 决策 ②）')
  assert.equal(RESCUE_WEIGHT_SUM, 0.717, '权重合计仍是 0.717（四项、不归一）—— 但线**不**随之缩放')
  assert.ok(early.t1 > late.t1, '早盘的线更高（更保守）')
  assert.ok(early.t2 > late.t2)
  assert.equal(Number(early.t1.toFixed(4)), Number((35 / 0.4).toFixed(4)))
  assert.equal(Number(late.t1.toFixed(4)), Number((35 / 1.1).toFixed(4)))
  // 早盘的「疑似」线 > 四项权重上限（71.7）⇒ 满分也不可能上疑似（这正是"早盘不过早触发"的硬保证）
  const cap = RESCUE_WEIGHT_SUM * 100
  assert.ok(early.t2 > cap, `早盘疑似线必须 > 权重上限 ${cap.toFixed(1)}（实际 ${early.t2.toFixed(2)}）`)
  // 反证：尾盘的线必须**低于**基准线（同一份数据在午后更容易出等级 —— 缩放是单向的）
  assert.ok(late.t2 < RESCUE_LEVEL_BASE[1])
})

test('③ 同一份早盘数据：改前（不缩放）会出等级、改后（缩放）不出等级', async () => {
  const { scoreRescue } = await import('./rescue.ts')
  // 一份"看起来很强"的早盘输入：量能 5x（早盘集合竞价的典型形态）+ 超大单正流入
  const input = {
    timeAdjMult: 5.0, coreSuperVsAvg: 1.0, peripheralSuperVsAvg: null, pulseMult: 1.2, persistShare: 0.2,
    retraceRatio: 0.2, indexPct: -0.8, resonance: 4, coreResonance: 2, peripheralResonance: 2,
    timeCoef: 0.4, flowAvailable: true, coreWorstShare: 0.0,
    f2Anchors: [0.5, 1.0, 2.0] as [number, number, number], f2Source: 'calibrated' as const,
  }
  const early = scoreRescue(input as never)
  assert.ok(early.rawScore > 35, `前置：原始分要够高（实际 ${early.rawScore}）`)
  assert.equal(early.level, 0, `早盘（系数 0.4）不出等级：线 ${JSON.stringify(early.levelLines)}，原始分 ${early.rawScore}`)
  // 早盘的线（0.717 缩放后）也必须真的挡住它
  // 同一份数据在尾盘（系数 1.1）必须出等级 ⇒ "09:35 与 14:00 判定不同"
  const late = scoreRescue({ ...input, timeCoef: 1.1 } as never)
  assert.ok(late.level >= 1, `同一输入在尾盘必须出等级（实际 ${late.level}）`)
  assert.notEqual(late.level, early.level)
  // 与旧实现（分数 × 系数后比固定线）的一致性：只允许四舍五入级别的差异
  const oldLevel = early.score >= 75 ? 3 : early.score >= 55 ? 2 : early.score >= 35 ? 1 : 0
  assert.ok(Math.abs((oldLevel as number) - (early.level as number)) <= 1, '新旧口径的差异只允许在 ±1 档内')
})

test('③ 等级线是唯一的时点调整处：score 只是展示值，等级判据不含第二次缩放', async () => {
  const { scoreRescue } = await import('./rescue.ts')
  const base = {
    timeAdjMult: 3.0, coreSuperVsAvg: 1.0, peripheralSuperVsAvg: null, pulseMult: 1.0, persistShare: 0.2,
    retraceRatio: 0.2, indexPct: -0.8, resonance: 3, coreResonance: 1, peripheralResonance: 2,
    flowAvailable: true, coreWorstShare: 0.0,
    f2Anchors: [0.5, 1.0, 2.0] as [number, number, number], f2Source: 'calibrated' as const,
  }
  // 扫描系数：等级必须随系数**单调不减**（越靠近尾盘越容易出等级）
  let prev = -1
  for (const coef of [0.4, 0.7, 1.0, 1.1]) {
    const r = scoreRescue({ ...base, timeCoef: coef } as never)
    assert.ok((r.level as number) >= prev, `系数 ${coef} 的等级不得低于更早时点（单调性）`)
    prev = r.level as number
  }
})

test('⑤ 回归：已收盘定稿的「零回源」语义未被改动（休市判定只影响非交易日）', async () => {
  const { inTradingWindow, tradingDayState } = await import('./rescue.ts')
  // 交易日 15:20（收盘后）与 10:00（盘中）的窗口判定必须与改动前一致
  assert.equal(inTradingWindow(Date.parse('2026-10-09T15:20:00+08:00')), false)
  assert.equal(inTradingWindow(Date.parse('2026-10-09T10:00:00+08:00')), true)
  assert.equal(inTradingWindow(Date.parse('2026-10-09T11:40:00+08:00')), false, '午休')
  assert.equal(inTradingWindow(Date.parse('2026-10-09T12:58:00+08:00')), true)
  assert.equal(tradingDayState(Date.parse('2026-10-09T15:20:00+08:00')).trading, true)
})

// 让 tsc 不抱怨未使用的 import（本文件按需动态 import 各模块）
void (0 as unknown as LedgerEntry)
