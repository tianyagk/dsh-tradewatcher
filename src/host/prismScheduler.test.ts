/**
 * 棱镜自动决策的**周期轮询**调度（v0.209.0）：交易时段 / 周期 / 午休补一次 / 持久化 / times 不再触发。
 *
 * 判据全部落在三个纯函数上（`intervalWindowOf` / `intervalDue` / `intervalSlotOf`）＋
 * 一个真实 `PrismStore` 的 `PrismScheduler.tick()`。每个「必须不触发」的断言都是反例注入：
 * 把边界写成 `<=`、把午休累计时长当周期、把 `times` 当触发源，都会让对应用例变红。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrismScheduler, intervalDue, intervalSlotOf, intervalWindowOf, type PrismTickPlan } from './prismScheduler.ts'
import { PrismStore } from './prismStore.ts'
import { dayOf, parseMarketStamp } from './time.ts'
import type { PrismSettings } from '../shared/prism.ts'

const at = (label: string): number => parseMarketStamp(label) as number
const settings = (patch: Partial<PrismSettings> = {}): PrismSettings => ({
  times: ['09:35', '11:20', '13:10', '14:40'],
  intervalSec: 600,
  lastFired: {},
  ...patch,
})
const hhmm = (minuteOfDay: number): string => `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`

test('① 交易时段边界：09:30 开、11:30 关、13:00 开、15:00 关（左闭右开）', () => {
  const day = '2026-10-22'
  const cases: Array<[string, boolean, 'am' | 'pm' | null]> = [
    ['09:29', false, null],
    ['09:30', true, 'am'],
    ['11:29', true, 'am'],
    ['11:30', false, null],
    ['12:59', false, null],
    ['13:00', true, 'pm'],
    ['14:59', true, 'pm'],
    ['15:00', false, null],
  ]
  for (const [t, inWindow, segment] of cases) {
    const w = intervalWindowOf(at(`${day} ${t}:00`))
    assert.equal(w.trading, true, `${t} 是交易日`)
    assert.equal(w.inWindow, inWindow, `${t} 的 inWindow`)
    assert.equal(w.segment, segment, `${t} 的 segment`)
  }
  // 反例注入：把上界写成 `<=` 的实现会把 11:30 / 15:00 判成仍在时段
  assert.equal(intervalWindowOf(at(`${day} 11:30:00`)).inWindow, false, '11:30 必须已收盘（<= 会错）')
  assert.equal(intervalWindowOf(at(`${day} 15:00:00`)).inWindow, false, '15:00 必须已收盘（<= 会错）')
})

test('② 非交易日（周末）一律不在时段内，且 intervalDue 不触发并指向下个交易日 09:30', () => {
  const sat = at('2026-10-24 10:00:00')
  const w = intervalWindowOf(sat)
  assert.equal(w.trading, false)
  assert.equal(w.inWindow, false)
  assert.equal(w.segment, null)
  const plan = intervalDue(settings(), sat, null)
  assert.equal(plan.due, false)
  assert.equal(plan.reason, '周末')
  assert.equal(plan.nextEligibleAt, at('2026-10-26 09:30:00'), '下一个交易日（周一）开盘')
})

test('③ intervalDue 边界：09:29 / 09:30 / 11:29 / 11:30 / 12:59 / 13:00 / 14:59 / 15:00 / 15:01', () => {
  const day = '2026-10-22'
  const beforeOpen = intervalDue(settings(), at(`${day} 09:29:00`), at(`${day} 09:20:00`))
  assert.equal(beforeOpen.due, false, '09:29 不触发')
  assert.equal(beforeOpen.nextEligibleAt, at(`${day} 09:30:00`))
  assert.match(String(beforeOpen.reason), /09:30/)

  const open = intervalDue(settings(), at(`${day} 09:30:00`), null)
  assert.equal(open.due, true, '09:30 开盘首拍立即触发')
  assert.equal(open.nextEligibleAt, at(`${day} 09:30:00`), 'due ⇒ nextEligibleAt 就是当前时刻')

  assert.equal(intervalDue(settings(), at(`${day} 11:29:00`), at(`${day} 11:19:00`)).due, true, '11:29 已到周期 ⇒ 触发')

  const lunch = intervalDue(settings(), at(`${day} 11:30:00`), at(`${day} 11:29:00`))
  assert.equal(lunch.due, false, '11:30 后不触发（午休）')
  assert.equal(lunch.nextEligibleAt, at(`${day} 13:00:00`))

  const lunchLate = intervalDue(settings(), at(`${day} 12:59:00`), at(`${day} 11:29:00`))
  assert.equal(lunchLate.due, false, '12:59 不触发（午休）')
  assert.equal(lunchLate.nextEligibleAt, at(`${day} 13:00:00`))

  const pmOpen = intervalDue(settings(), at(`${day} 13:00:00`), at(`${day} 11:29:00`))
  assert.equal(pmOpen.due, true, '13:00 午盘开盘立即触发（跨午休最多补这一次）')
  assert.equal(pmOpen.nextEligibleAt, at(`${day} 13:00:00`))

  assert.equal(intervalDue(settings(), at(`${day} 14:59:00`), at(`${day} 14:49:00`)).due, true, '14:59 已到周期 ⇒ 触发')

  const close = intervalDue(settings(), at(`${day} 15:00:00`), at(`${day} 14:59:00`))
  assert.equal(close.due, false, '15:00 后不触发')
  assert.match(String(close.reason), /已收盘/)
  assert.equal(close.nextEligibleAt, at('2026-10-23 09:30:00'), '收盘后指向下个交易日 09:30')

  const afterClose = intervalDue(settings(), at(`${day} 15:01:00`), at(`${day} 14:59:00`))
  assert.equal(afterClose.due, false, '15:01 不触发')
  assert.equal(afterClose.nextEligibleAt, at('2026-10-23 09:30:00'))
})

test('④ 600s 周期：599s 不触发、600s 触发、601s 触发（> 写成 >= 或 < 都会被抓）', () => {
  const last = at('2026-10-22 09:30:00')
  assert.equal(intervalDue(settings({ intervalSec: 600 }), at('2026-10-22 09:39:59'), last).due, false, '599s 不触发')
  assert.equal(intervalDue(settings({ intervalSec: 600 }), at('2026-10-22 09:39:59'), last).nextEligibleAt, at('2026-10-22 09:40:00'))
  assert.equal(intervalDue(settings({ intervalSec: 600 }), at('2026-10-22 09:40:00'), last).due, true, '600s 触发')
  assert.equal(intervalDue(settings({ intervalSec: 600 }), at('2026-10-22 09:40:01'), last).due, true, '601s 触发')
})

test('⑤ 切换 300 / 1800 / 3600 各一条；旧档 900 回落 600', () => {
  const last = at('2026-10-22 09:30:00')
  assert.equal(intervalDue(settings({ intervalSec: 300 }), at('2026-10-22 09:35:00'), last).due, true, '300s ⇒ 5 分钟就触发')
  assert.equal(intervalDue(settings({ intervalSec: 300 }), at('2026-10-22 09:34:59'), last).due, false)
  assert.equal(intervalDue(settings({ intervalSec: 1800 }), at('2026-10-22 09:59:59'), last).due, false, '1800s ⇒ 29:59 不触发')
  assert.equal(intervalDue(settings({ intervalSec: 1800 }), at('2026-10-22 10:00:00'), last).due, true)
  assert.equal(intervalDue(settings({ intervalSec: 3600 }), at('2026-10-22 10:29:59'), last).due, false, '3600s ⇒ 59:59 不触发')
  assert.equal(intervalDue(settings({ intervalSec: 3600 }), at('2026-10-22 10:30:00'), last).due, true)
  // 反例注入：900 已从档位表移除 ⇒ 按默认 600 判，不得出现「600s 不触发」的旧行为
  assert.equal(intervalDue(settings({ intervalSec: 900 }), at('2026-10-22 09:40:00'), last).due, true, '非法 900 ⇒ 回落 600')
  assert.equal(intervalDue(settings({ intervalSec: 900 }), at('2026-10-22 09:39:59'), last).due, false)
})

test('⑥ 午休：11:29 触发后 13:00 只补一次，不得连发两次；11:30–12:59 全程不触发', () => {
  const s = settings({ intervalSec: 600 })
  // 11:29 刚跑过（水位 11:29）
  const last = at('2026-10-22 11:29:00')
  for (let m = 11 * 60 + 30; m < 13 * 60; m += 1) {
    const plan = intervalDue(s, at(`2026-10-22 ${hhmm(m)}:00`), last)
    assert.equal(plan.due, false, `${hhmm(m)} 午休不得触发（按累计时长会错）`)
  }
  // 反例注入：12:00 距 11:29 已 31 分钟 ≥ 600s，天真实现会 due
  assert.equal(intervalDue(s, at('2026-10-22 12:00:00'), last).due, false, '午休累计时长不得当周期')
  // 13:00 补一次
  assert.equal(intervalDue(s, at('2026-10-22 13:00:00'), last).due, true, '午盘开盘补一次')
  // 补跑后写水位 13:00：同一分钟/下一拍不得再发
  const afterCatchUp = at('2026-10-22 13:00:00')
  assert.equal(intervalDue(s, at('2026-10-22 13:00:20'), afterCatchUp).due, false, '补跑后 20s 不得再发')
  assert.equal(intervalDue(s, at('2026-10-22 13:00:30'), afterCatchUp).due, false, '补跑后 30s 不得再发')
  assert.equal(intervalDue(s, at('2026-10-22 13:09:59'), afterCatchUp).due, false)
  assert.equal(intervalDue(s, at('2026-10-22 13:10:00'), afterCatchUp).due, true, '下一轮按 600s 周期')
})

test('⑦ 持久化：markAutoFired 写盘后重启读回一致；旧文件缺字段 ⇒ 首次可触发', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-interval-persist-'))
  try {
    const store = new PrismStore(dir)
    await store.init()
    const firedAt = at('2026-10-22 09:30:00')
    await store.markAutoFired(firedAt)
    const again = new PrismStore(dir)
    await again.init()
    assert.equal(again.settings().lastAutoAt, firedAt, 'lastAutoAt 必须跨重启保留')
    assert.equal(intervalDue(again.settings(), at('2026-10-22 09:39:59'), again.settings().lastAutoAt ?? null).due, false, '重启后 599s 不重复触发')
    assert.equal(intervalDue(again.settings(), at('2026-10-22 09:40:00'), again.settings().lastAutoAt ?? null).due, true, '超过周期后照常触发')

    // 旧文件（v0.208 之前没有 lastAutoAt）
    await writeFile(join(dir, 'prism-settings.json'), JSON.stringify({ v: 1, times: ['09:35'], intervalSec: 600, lastFired: {} }), 'utf8')
    const old = new PrismStore(dir)
    await old.init()
    assert.equal(old.settings().lastAutoAt, undefined, '缺字段 ⇒ undefined（不编 0）')
    assert.equal(intervalDue(old.settings(), at('2026-10-22 09:30:00'), old.settings().lastAutoAt ?? null).due, true, '首次可触发')

    // 坏值不得透传
    await writeFile(join(dir, 'prism-settings.json'), JSON.stringify({ v: 1, times: ['09:35'], lastAutoAt: 'x', lastFired: {} }), 'utf8')
    const bad = new PrismStore(dir)
    await bad.init()
    assert.equal(bad.settings().lastAutoAt, undefined, '非法 lastAutoAt ⇒ undefined')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('⑧ 回归：times 不再自动触发（改 times 不改变 intervalDue 的任何输出）', () => {
  const last = at('2026-10-22 09:30:00')
  // 若仍按 times 触发：09:35 恰好命中 times=09:35 ⇒ 会跑；周期实现必须不跑（只过了 300s）
  const withTimes = intervalDue(settings({ times: ['09:35'] }), at('2026-10-22 09:35:00'), last)
  assert.equal(withTimes.due, false, 'times=09:35 不得在 09:35 触发（距上次仅 300s < 600s）')
  // 同一时刻，times 为空/换成任意值 ⇒ 输出完全一致（证明它根本不参与判定）
  const noTimes = intervalDue(settings({ times: [] }), at('2026-10-22 09:35:00'), last)
  assert.deepEqual(noTimes, withTimes, 'times 不参与 intervalDue')
  for (const t of ['09:30', '09:40', '11:29', '13:00', '14:59']) {
    assert.deepEqual(
      intervalDue(settings({ times: ['09:35', '09:40', '13:00'] }), at(`2026-10-22 ${t}:00`), last),
      intervalDue(settings({ times: [] }), at(`2026-10-22 ${t}:00`), last),
      `${t}：times 不同但判定必须相同`,
    )
  }
})

test('⑨ intervalSlotOf：run 的 slot 标签取当前 HH:MM', () => {
  assert.equal(intervalSlotOf(at('2026-10-22 09:30:59')), '09:30')
  assert.equal(intervalSlotOf(at('2026-10-22 11:29:00')), '11:29')
  assert.equal(intervalSlotOf(at('2026-10-22 13:00:00')), '13:00')
  assert.equal(intervalSlotOf(at('2026-10-22 14:59:59')), '14:59')
})

interface Harness {
  store: PrismStore
  scheduler: PrismScheduler
  calls: string[]
  tick: () => Promise<PrismTickPlan>
}

const harnessOf = async (dir: string, clock: { now: number }, seed?: (store: PrismStore) => Promise<void>): Promise<Harness> => {
  const store = new PrismStore(dir)
  await store.init()
  if (seed !== undefined) await seed(store)
  const calls: string[] = []
  const scheduler = new PrismScheduler(store, {
    now: () => clock.now,
    run: async (slot) => {
      calls.push(slot)
      return { ok: true }
    },
  })
  return { store, scheduler, calls, tick: () => scheduler.tick() }
}

test('⑩ 调度器：09:30 首拍触发一次、同分钟不重复、下一轮按周期；11:30 与周末不触发', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-interval-tick-'))
  try {
    const clock = { now: at('2026-10-22 09:30:00') }
    const h = await harnessOf(dir, clock)
    const first = await h.tick()
    assert.equal(first.due, true, '09:30 首拍触发')
    assert.equal(first.slot, '09:30', 'slot 取当前 HH:MM')
    await h.scheduler.whenIdle()
    assert.deepEqual(h.calls, ['09:30'], '只触发一次')
    assert.equal(h.store.settings().lastAutoAt, clock.now, '跑完写盘 lastAutoAt')

    clock.now = at('2026-10-22 09:30:20')
    const second = await h.tick()
    assert.equal(second.due, false, '同一分钟内不得重复')
    assert.deepEqual(h.calls, ['09:30'])

    clock.now = at('2026-10-22 09:40:00')
    const third = await h.tick()
    assert.equal(third.due, true, '距上次 600s ⇒ 触发')
    assert.equal(third.slot, '09:40')
    await h.scheduler.whenIdle()

    clock.now = at('2026-10-22 11:30:00')
    const lunch = await h.tick()
    assert.equal(lunch.due, false, '11:30 不触发')
    assert.equal(lunch.inWindow, false)
    assert.deepEqual(h.calls, ['09:30', '09:40'])

    clock.now = at('2026-10-24 10:00:00')
    const weekend = await h.tick()
    assert.equal(weekend.due, false, '周末不触发')
    assert.equal(weekend.trading, false)
    assert.deepEqual(h.calls, ['09:30', '09:40'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('⑪ 调度器：午休后 13:00 只补一次；进程重启后不立刻重复触发（除非已超周期）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-interval-restart-'))
  try {
    const clock = { now: at('2026-10-22 11:29:00') }
    const h = await harnessOf(dir, clock)
    // 11:29 的自动决策已跑过
    await h.store.markAutoFired(clock.now)
    clock.now = at('2026-10-22 13:00:00')
    const catchUp = await h.tick()
    assert.equal(catchUp.due, true, '午盘开盘补一次')
    assert.equal(catchUp.slot, '13:00')
    await h.scheduler.whenIdle()
    assert.deepEqual(h.calls, ['13:00'])
    clock.now = at('2026-10-22 13:00:30')
    const again = await h.tick()
    assert.equal(again.due, false, '补跑后 30s 不得再发（最多补一次）')
    assert.deepEqual(h.calls, ['13:00'])

    // 进程重启：新 store + 新 scheduler，读回 lastAutoAt=13:00
    const restarted = await harnessOf(dir, clock)
    clock.now = at('2026-10-22 13:09:59')
    assert.equal((await restarted.tick()).due, false, '重启后 599s 不立刻重复触发')
    assert.deepEqual(restarted.calls, [])
    clock.now = at('2026-10-22 13:10:00')
    assert.equal((await restarted.tick()).due, true, '超过周期后照常触发')
    await restarted.scheduler.whenIdle()
    assert.deepEqual(restarted.calls, ['13:10'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('⑪b 调度器：上一轮还在跑时第二拍不得再发（占位守卫，避免午休补跑连发两次）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-interval-inflight-'))
  try {
    const clock = { now: at('2026-10-22 13:00:00') }
    const store = new PrismStore(dir)
    await store.init()
    await store.markAutoFired(at('2026-10-22 11:29:00'))
    let calls = 0
    let finish: (() => void) | null = null
    const scheduler = new PrismScheduler(store, {
      now: () => clock.now,
      run: async () => {
        calls += 1
        await new Promise<void>((resolve) => { finish = resolve })
      },
    })
    const first = await scheduler.tick()
    assert.equal(first.due, true, '13:00 补一次')
    clock.now = at('2026-10-22 13:00:30')
    const second = await scheduler.tick()
    assert.equal(second.due, false, '跑的期间第二拍不得再发')
    assert.match(String(second.reason), /尚未跑完/)
    assert.equal(calls, 1, 'run 只被调用一次')
    const done = finish as unknown as (() => void) | null
    done?.()
    await scheduler.whenIdle()
    assert.equal(store.settings().lastAutoAt, at('2026-10-22 13:00:00'), '跑完写盘（触发时刻，不是完成时刻）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('⑫ 调度器：times=09:35 且水位=09:30，在 09:35 拍不得因 times 触发', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-interval-times-'))
  try {
    const clock = { now: at('2026-10-22 09:35:00') }
    const h = await harnessOf(dir, clock, async (store) => {
      await store.saveSchedule({ times: ['09:35'], intervalSec: 600 })
      await store.markAutoFired(at('2026-10-22 09:30:00'))
    })
    const tick = await h.tick()
    assert.equal(tick.due, false, 'times 不再自动触发')
    assert.equal(tick.slot, null)
    await h.scheduler.whenIdle()
    assert.deepEqual(h.calls, [], 'run 一次都没调')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('⑬ 调度器：非交易日拍不调用 run（交易日判定复用 tradingDayState）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-interval-weekend-'))
  try {
    const clock = { now: at('2026-10-25 10:00:00') } // 周日
    const h = await harnessOf(dir, clock)
    const tick = await h.tick()
    assert.equal(tick.trading, false)
    assert.equal(tick.due, false)
    assert.equal(dayOf(clock.now), '2026-10-25')
    assert.deepEqual(h.calls, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('⑭ 顺带动作同步抛错不得打断本拍（match/news 熔断时仍要按周期触发）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-interval-sideboom-'))
  try {
    const clock = { now: at('2026-10-22 09:30:00') }
    const store = new PrismStore(dir)
    await store.init()
    const calls: string[] = []
    const scheduler = new PrismScheduler(store, {
      now: () => clock.now,
      run: async (slot) => { calls.push(slot); return { ok: true } },
      // 事故形态：行情源熔断时 matchTick / incrementalNews 同步 throw ⇒ tick 被拒 ⇒ 整拍失效
      match: () => { throw new Error('match boom') },
      news: () => { throw new Error('news boom') },
    })
    const plan = await scheduler.tick()
    assert.equal(plan.due, true, '顺带动作抛错时本拍仍必须触发')
    assert.deepEqual(calls, ['09:30'], 'run 必须被调用一次')
    await scheduler.whenIdle()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
