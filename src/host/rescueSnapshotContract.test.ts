/**
 * 快照契约缺口（AUDIT-IMPL57 / 用户口径）：**连续评分的跨日分位**此前只在宿主算（`rescue.ts:693` 一带），
 * 没进 `shared/model.ts` 的 `RescueSnapshot` ⇒ 界面拿不到（客户端按规矩没有现算、也没有顶替，只在悬停写原因）。
 *
 * 这里锁三件事：
 *   ① 契约里有 `continuous` / `continuousPercentile` / `continuousPercentileN` / `continuousPercentileWhy`；
 *   ② 分位 == 宿主 `scorePercentile(快照里的连续评分, 日志里的跨日样本)`（**逐点一致**，同一份口径）；
 *   ③ 样本不足 ⇒ `null` + 原因（**不得 0 顶替**）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dayOf } from './time.ts'

const PINNED_NOW = Date.parse('2026-10-15T14:00:00+08:00')

/** 写一份带跨日样本的出分日志，再让 monitor 装载（与 rescuePersist.test.ts 同一套隔离写法） */
function seedLog(dir: string, now: number, continuous: number[]): void {
  mkdirSync(dir, { recursive: true })
  const days: Record<string, unknown> = {}
  // 跨日样本放在**昨天**（今天那条由 monitor 自己写；`recentContinuous` 会跳过今天）
  const prev = dayOf(now - 24 * 3600_000)
  days[prev] = {
    events: [],
    intraday: [],
    samples: continuous.length,
    gap: false,
    scoreLog: continuous.map((c, i) => ({
      ts: now - 24 * 3600_000 + i * 60_000,
      hhmm: `${prev} ${String(9 + Math.floor(i / 12)).padStart(2, '0')}:${String((i % 12) * 5).padStart(2, '0')}`,
      score: Math.round(c),
      rawScore: Math.round(c * 0.717 * 100) / 100,
      timeCoef: 1,
      continuous: c,
      inSession: true,
      engine: '0.16.0',
      factors: [],
    })),
  }
  writeFileSync(join(dir, 'rescue-log.json'), JSON.stringify({
    v: 1, days, lastSnapshot: null, baselines: {}, selfSamples: {}, progressCurve: null, progressDays: 0, updatedAt: 0,
  }))
}

test('① 快照映射（纯函数）：分位 == scorePercentile(连续评分, 跨日样本)（逐点一致）；样本不足 ⇒ null + 原因；采样路径必须用它', async () => {
  const { scoreRescue, scorePercentile, snapshotContractFields } = await import('./rescue.ts')
  const base = {
    timeAdjMult: 2.2, coreSuperVsAvg: 0.6, peripheralSuperVsAvg: null, pulseMult: 2.2, persistShare: 0.2,
    retraceRatio: 0.2, indexPct: -1.2, resonance: 2, coreResonance: 1, peripheralResonance: 1,
    f2Anchors: [0.5, 1, 2] as [number, number, number], timeCoef: 1.1,
  }
  const history = [12, 25, 38, 44, 51, 63, 70]
  const withHist = snapshotContractFields(scoreRescue({ ...base, recentContinuous: history } as never))
  const r = scoreRescue({ ...base, recentContinuous: history } as never)
  const expect = scorePercentile(r.continuous as number, history)
  assert.equal(withHist.continuousPercentile, expect === null ? null : Math.round(expect.pct * 10) / 10, '分位必须 == 用同一算法复算的结果')
  assert.equal(withHist.continuousPercentileN, history.length, '样本数 == 跨日样本条数')
  assert.equal(withHist.continuousPercentileWhy ?? null, null, '算得出来 ⇒ 原因为 null')
  // 样本不足 ⇒ null + 原因（**不得 0**）
  const few = snapshotContractFields(scoreRescue({ ...base, recentContinuous: [10, 20, 30] } as never))
  assert.equal(few.continuousPercentile, null, '样本不足 ⇒ null（0 会被读成"分位 0%"）')
  assert.equal(few.continuousPercentileN, 3, '样本数照实给')
  assert.ok((few.continuousPercentileWhy ?? '').includes('不足'), `原因要写样本不足：${few.continuousPercentileWhy}`)
  // 非交易时段 ⇒ 两个都 null + 原因
  const off = snapshotContractFields(scoreRescue({ ...base, inSession: false, recentContinuous: history } as never))
  assert.equal(off.continuous, null)
  assert.equal(off.continuousPercentile, null)
  assert.ok((off.continuousPercentileWhy ?? '').includes('非交易时段'), `非交易时段原因：${off.continuousPercentileWhy}`)
  // 采样路径**必须**用这个映射（否则字段可以悄悄丢回缺口）
  const src = readFileSync(new URL('./rescue.ts', import.meta.url), 'utf8')
  assert.ok(src.includes('...snapshotContractFields(scored)'), '采样路径必须展开 snapshotContractFields(scored)（唯一映射实现）')
})

test('①b 快照端到端：采样路径产出的快照带这四个字段（走 sampleNow）', async () => {
  // ⚠ 必须走**采样路径**（`sampleNow`）：只调 `snapshot()` 会走"尚未采样"分支，
  // 那条分支也补了契约字段 ⇒ 把采样映射删掉照样绿（注入 C1 逃逸过一次，这里补上）
  const dir = mkdtempSync(join(tmpdir(), 'tw-pctl-'))
  const samples = [12, 25, 38, 44, 51, 63, 70]
  seedLog(dir, PINNED_NOW, samples)
  const realNow = Date.now
  Date.now = () => PINNED_NOW
  try {
    const { RescueMonitor, scorePercentile } = await import('./rescue.ts')
    const mon = new RescueMonitor(dir, { enabled: true, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [] })
    await mon.init()
    // 上游全部失败不影响契约断言：这条测的是"快照字段从哪来"，不是"取数成功"
    const realFetch = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(new Error('offline (contract test)'))) as typeof fetch
    let snap
    try {
      snap = await mon.sampleNow()
    } finally {
      globalThis.fetch = realFetch
    }
    // ① 字段存在 + 类型正确（缺字段与"值为 null"必须能区分：前者是契约缺口）
    assert.equal('continuousPercentile' in snap, true, '快照必须有 continuousPercentile（契约缺口就是这条）')
    assert.equal('continuousPercentileN' in snap, true, '快照必须有 continuousPercentileN')
    assert.equal('continuousPercentileWhy' in snap, true, '快照必须有 continuousPercentileWhy')
    assert.equal(typeof snap.continuousPercentileN, 'number', '样本数必须是数字')
    // ② 逐点一致：拿快照里的连续评分 + 日志里的跨日样本，用宿主的同一个函数复算
    const recovered = mon.scoreLogOf(dayOf(PINNED_NOW - 24 * 3600_000))
      .map((e) => (e as { continuous?: unknown }).continuous)
      .filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
    assert.deepEqual(recovered, samples, '前置：跨日样本要能从日志里读回来（历史来源）')
    if (typeof snap.continuous === 'number') {
      const expect = scorePercentile(snap.continuous, recovered)
      assert.equal(snap.continuousPercentile, expect === null ? null : Math.round(expect.pct * 10) / 10, '快照分位必须 == 用同一算法复算的结果')
      assert.equal(snap.continuousPercentileN, recovered.length, '样本数必须 == 跨日样本条数')
      assert.equal(snap.continuousPercentileWhy ?? null, null, '算得出来 ⇒ 原因为 null')
    } else {
      // 冷启动：连续评分为 null 时，分位必须也是 null + 原因（不许 0）
      assert.equal(snap.continuousPercentile, null, '没有连续评分 ⇒ 分位必须 null')
      assert.ok((snap.continuousPercentileWhy ?? '').length > 0, '必须给原因')
    }
  } finally {
    Date.now = realNow
  }
})

test('② 冷启动：没有跨日样本 ⇒ 分位 null + 原因（**不得 0 顶替**）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-pctl-cold-'))
  mkdirSync(dir, { recursive: true })
  const realNow = Date.now
  Date.now = () => PINNED_NOW
  try {
    const { RescueMonitor } = await import('./rescue.ts')
    const mon = new RescueMonitor(dir, { enabled: true, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [] })
    await mon.init()
    // 上游全部失败不影响契约断言：这条测的是"快照字段从哪来"，不是"取数成功"
    const realFetch = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(new Error('offline (contract test)'))) as typeof fetch
    let snap
    try {
      snap = await mon.sampleNow()
    } finally {
      globalThis.fetch = realFetch
    }
    assert.equal(snap.continuousPercentile ?? null, null, '冷启动没有分位 ⇒ null（0 会被读成"分位 0%"）')
    assert.equal(snap.continuousPercentileN ?? 0, 0, '样本数 0')
    assert.ok((snap.continuousPercentileWhy ?? '').length > 0, `必须给原因：${snap.continuousPercentileWhy}`)
  } finally {
    Date.now = realNow
  }
})
