/**
 * 分时兜底顺序的断言（P0）：`上游 → 活的备用源（腾讯分钟线）→ 本地 LKG`。
 *
 * 缺陷形态（装机实测）：早上 09:38，1.510300 / 1.000001 还显示 **10-08 的整场**（昨天），
 * 而 1.600519 是 10-09 的实时分钟线 —— 差别只在"有没有昨日 LKG"：有 LKG 的标的被
 * 过期的 LKG 挡住，根本不试活的备用源。判据必须是**数据是不是今天的**，不是"有没有 LKG"。
 *
 * 三条断言（都可构造）：
 *  ① 上游抛错 + 有昨日 LKG + 备用源可用 ⇒ 必须返回**备用源的当日数据**，且没有 staleAt；
 *  ② 上游抛错 + 有昨日 LKG + 备用源也失败 ⇒ 回 LKG，且**带 sessionDay**（等于 LKG 那天）；
 *  ③ 休市定稿 ⇒ 仍复用本地（不许被这次改动破坏），且**不去打上游/备用源**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TrendData } from '../shared/model.ts'
import { fetchTrend, pickTrendFallback, trendSessionDay } from './em.ts'

const DAY_YESTERDAY = '2026-10-08'
const DAY_TODAY = '2026-10-09'

const trendOf = (day: string, n = 5): TrendData => ({
  secid: 'x',
  prePrice: null,
  points: Array.from({ length: n }, (_, i) => ({
    t: Date.parse(`${day}T09:3${i}:00+08:00`),
    label: `${day} 09:3${i}`,
    price: 1 + i * 0.01,
    avg: null,
    vol: null,
  })),
  last: 1,
})

test('纯决策：上游没有数据时，先用活的备用源，绝不能被过期的 LKG 挡住', () => {
  const backup = trendOf(DAY_TODAY)
  const lkg = trendOf(DAY_YESTERDAY)
  const picked = pickTrendFallback({ upstream: null, backup, lkg, today: DAY_TODAY })
  assert.equal(picked.from, 'backup')
  assert.equal(picked.data, backup)
  assert.equal(picked.sessionDay, DAY_TODAY)
  assert.equal(picked.expired, false, '备用源就是今天的')
})

test('纯决策：上游与备用源都没有 ⇒ 才吃 LKG，并把它的交易日交出来（跨日即过期）', () => {
  const lkg = trendOf(DAY_YESTERDAY)
  const picked = pickTrendFallback({ upstream: null, backup: null, lkg, today: DAY_TODAY })
  assert.equal(picked.from, 'lkg')
  assert.equal(picked.sessionDay, DAY_YESTERDAY)
  assert.equal(picked.expired, true, '昨日数据必须被标成过期（界面要写清是哪天的）')
  assert.equal(picked.data, lkg)
  // 上游有数据时永远优先
  const up = trendOf(DAY_TODAY)
  assert.equal(pickTrendFallback({ upstream: up, backup: lkg, lkg, today: DAY_TODAY }).from, 'upstream')
  // 点数不足 2 的序列不算数（与既有口径一致）
  const one: TrendData = { ...trendOf(DAY_TODAY, 1) }
  assert.equal(pickTrendFallback({ upstream: one, backup: null, lkg: null, today: DAY_TODAY }).from, 'none')
})

test('trendSessionDay：交易日取自序列最后一个点的 label', () => {
  assert.equal(trendSessionDay(trendOf(DAY_YESTERDAY)), DAY_YESTERDAY)
  assert.equal(trendSessionDay(null), null)
  assert.equal(trendSessionDay({ ...trendOf(DAY_TODAY), points: [] }), null)
})

/**
 * 一次性把三个场景的 LKG 种进同一个临时 DSH_HOME。
 *
 * `loadTrendLkg()` 是**进程级 memo**（只读一次文件），所以不能一个用例写一份 ——
 * 那样第二个用例读到的还是第一份。
 */
const LKG_AT_YESTERDAY_CLOSE = Date.parse(`${DAY_YESTERDAY}T16:00:00+08:00`)
const LKG_AT_TODAY_CLOSE = Date.parse(`${DAY_TODAY}T16:00:00+08:00`)
{
  const home = mkdtempSync(join(tmpdir(), 'tw-fb-'))
  process.env.DSH_HOME = home
  const dir = join(home, 'dsh-tradewatcher')
  mkdirSync(dir, { recursive: true })
  const entries = [
    { key: '1.510300|1', at: LKG_AT_YESTERDAY_CLOSE, trend: trendOf(DAY_YESTERDAY) },
    { key: '1.000001|1', at: LKG_AT_YESTERDAY_CLOSE, trend: trendOf(DAY_YESTERDAY) },
    { key: '1.512660|1', at: LKG_AT_TODAY_CLOSE, trend: trendOf(DAY_TODAY) },
  ]
  writeFileSync(join(dir, 'trends-lkg.json'), JSON.stringify({ ts: LKG_AT_TODAY_CLOSE, entries }), 'utf8')
}

test('① 上游抛错 + 有昨日 LKG + 备用源可用 ⇒ 返回备用源的当日数据（staleAt 为空）', async () => {
  const secid = '1.510300'
  const backup = { ...trendOf(DAY_TODAY), secid }
  let backupCalls = 0
  const got = await fetchTrend(secid, 1, {
    // 上午盘中（非定稿）
    now: Date.parse(`${DAY_TODAY}T09:38:00+08:00`),
    upstream: async () => { throw new Error('selftest: 东财不可达') },
    fallbackSource: async () => { backupCalls += 1; return backup },
  })
  assert.equal(backupCalls, 1, '备用源必须被尝试（这正是被 LKG 挡掉的那一步）')
  assert.ok(got !== null)
  assert.equal(got.points[0].label.slice(0, 10), DAY_TODAY, '必须返回今天的数据，而不是昨天的 LKG')
  assert.equal(got.staleAt, undefined, '实时备用源不算"上次成功数据"')
  assert.equal(got.sessionDay, undefined, '当日数据不需要额外标注交易日')
})

test('② 上游抛错 + 有昨日 LKG + 备用源也失败 ⇒ 回 LKG，且带 sessionDay（等于 LKG 那天）', async () => {
  const secid = '1.000001'
  const got = await fetchTrend(secid, 1, {
    now: Date.parse(`${DAY_TODAY}T09:38:00+08:00`),
    upstream: async () => { throw new Error('selftest: 东财不可达') },
    fallbackSource: async () => null,
  })
  assert.ok(got !== null)
  assert.equal(got.points[0].label.slice(0, 10), DAY_YESTERDAY, '只能回上次成功的那份')
  assert.equal(got.sessionDay, DAY_YESTERDAY, '回包必须带上"这是哪天的"（界面据此写日期）')
  assert.equal(typeof got.staleAt, 'number', 'LKG 必须标 staleAt')
})

test('③ 休市定稿 ⇒ 仍复用本地，且不去打上游/备用源（不许被这次改动破坏）', async () => {
  const secid = '1.512660'
  // 周六中午：非交易时段；LKG 快照晚于最近一次收盘（周五 15:00）⇒ 定稿
  const now = Date.parse('2026-10-10T12:00:00+08:00')
  let upstreamCalls = 0
  let backupCalls = 0
  const got = await fetchTrend(secid, 1, {
    now,
    upstream: async () => { upstreamCalls += 1; return trendOf(DAY_TODAY) },
    fallbackSource: async () => { backupCalls += 1; return null },
  })
  assert.ok(got !== null)
  assert.equal(got.cached, true, '定稿复用本地并如实标注')
  assert.equal(upstreamCalls, 0, '定稿期不回源')
  assert.equal(backupCalls, 0, '定稿期也不打备用源')
})
