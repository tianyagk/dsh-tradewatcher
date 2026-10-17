/**
 * 队列第 1 项（宿主红线）的回归断言 —— `docs/AUDIT-IMPL74.md`。
 *
 * 两条红线：
 *   ① A股年K（`resampleYearly`）把**缺失月量按 0 求和**，且 `date` 被覆盖成年末月、
 *      首根 `pct` 拿年内开盘价冒充同比；
 *   ② `chips` 的 `lastBar.vol ?? 0` 把「缺失」编码成「零成交」，类型又把 0 写死成合法值。
 *
 * 每条判据都配**反例注入**：把实现改回旧写法，这条必须红（不是"这次跑对了"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DayBar } from '../shared/model.ts'

/** 隔离：`fetchKline` 会读盘上缓存 ⇒ 必须在任何取数之前钉住 HOME */
const HOME = mkdtempSync(join(tmpdir(), 'tw-impl74-home-'))
process.env.DSH_HOME = HOME
if (!HOME.startsWith('/tmp')) throw new Error(`拒绝运行：DSH_HOME 必须在 /tmp 下（收到 ${HOME}）`)

import { fetchKline, resampleYearly } from './em.ts'
import { chipSeriesOf, lastBarMetaOf, type ChipBar } from './chips.ts'

const monthBar = (date: string, vol: number | null, close = 10, extra: Partial<DayBar> = {}): DayBar => ({
  date, open: close - 1, close, high: close + 1, low: close - 2, vol, pct: null, ...extra,
})

// ─────────────────────────── ① 缺月量不得 0 相加 ───────────────────────────

test('① 年K 量：任一月 vol 缺失 ⇒ 该年 vol 为 null（注入 0 相加 ⇒ 必败）', () => {
  const monthly: DayBar[] = [
    monthBar('2026-01-30', 100),
    monthBar('2026-02-27', null), // ← 上游这个月没给量
    monthBar('2026-03-31', 300),
    // 2025 年：三个月都齐
    monthBar('2025-01-31', 10),
    monthBar('2025-02-28', 20),
    monthBar('2025-03-31', 30),
  ].sort((a, b) => a.date.localeCompare(b.date))
  const years = resampleYearly(monthly)
  assert.equal(years.length, 2)
  const y2026 = years.find((b) => b.date.startsWith('2026'))
  const y2025 = years.find((b) => b.date.startsWith('2025'))
  assert.ok(y2026 !== undefined && y2025 !== undefined)
  const noZero = (bars: DayBar[]): boolean => bars.every((b) => b.vol === null || b.vol > 0)
  assert.equal(y2026.vol, null, `缺一个月 ⇒ 该年 vol 必须是 null（实际 ${String(y2026.vol)}）`)
  assert.equal(y2025.vol, 60, '三个月都齐 ⇒ 求和（10+20+30）')
  assert.equal(noZero(years), true, '年K 里不许出现 0 量（缺失不得编码成 0）')
  // ⚠ 反例注入：旧写法 `(cur.vol ?? 0) + (b.vol ?? 0)` 会给出 400 —— **一个看起来完全正常的数字**
  const oldSum = [100, null, 300].reduce<number>((a, b) => a + (b ?? 0), 0)
  assert.equal(oldSum, 400, '⚠ 旧写法确实把缺失当 0 相加（400）')
  assert.notEqual(y2026.vol, oldSum, '⚠ 新实现不得给出旧写法的 400')
  /** 判据：**缺失必须表现为 null**，不能表现为任何数字 */
  const acceptsAsNumber = (v: number | null): boolean => typeof v === 'number'
  assert.equal(acceptsAsNumber(oldSum), true, '⚠ 旧结果"看起来是个正常数字"，最容易被当成真值 —— 判据必须拒绝它')
  assert.equal(acceptsAsNumber(y2026.vol), false, '新实现必须拒绝"用数字表示缺失"')
})

test('①b 年K 成交额：同样的 null 传播（任一月缺失 ⇒ null；完全没有这一列 ⇒ 不给该字段）', () => {
  // 有 amount 列且缺一个月
  const withAmount = resampleYearly([
    monthBar('2026-01-30', 100, 10, { amount: 1000 }),
    monthBar('2026-02-27', 200, 10, { amount: null }),
  ])
  assert.equal(withAmount[0].amount, null, '有这一列但缺一个月 ⇒ 该年 amount 为 null')
  // 完全没有 amount 列（A股月K 的真实形态）
  const without = resampleYearly([monthBar('2026-01-30', 100), monthBar('2026-02-27', 200)])
  assert.equal('amount' in without[0], false, 'A股月K 不带成交额 ⇒ 不许凭空造一个 0')
})

// ─────────────────────── ② 年K 的 date 与 barOpen ────────────────────────────

test('② 年K 的 date 取「年内首个月K」而不是年末月（注入改回覆盖 ⇒ 必败）', () => {
  const monthly = [
    monthBar('2026-01-30', 100),
    monthBar('2026-06-30', 200),
    monthBar('2026-10-08', 300), // 当年最后一个月
  ]
  const [y] = resampleYearly(monthly)
  assert.equal(y.date, '2026-01-30', `年K 的 date 必须是年内首个月K（实际 ${y.date}）`)
  /* 判据写成"必须是该年桶内第一根输入的日期"，而不是硬编码字符串：换一份数据仍然成立 */
  const firstOfYear = monthly.filter((b) => b.date.startsWith('2026'))[0]
  assert.equal(y.date, firstOfYear.date, '必须等于桶内第一根输入的日期')
  assert.notEqual(y.date, monthly[monthly.length - 1].date, '不许等于年末月的日期')
  // ⚠ 反例注入：旧写法 `cur.date = b.date` 让 date 变成年末月
  const oldDate = monthly[monthly.length - 1].date
  assert.equal(oldDate, '2026-10-08', '⚠ 旧写法给出的是年末月日期 —— 本判据必须拒绝它')
  assert.notEqual(y.date, oldDate, '⚠ 新旧必须不同')
})

test('②b 端到端：A股年K 在盘中 `barOpen === true`（注入"按日期比" ⇒ 必败）', async () => {
  const secid = '1.601398'
  // 北京 2026-10-16（周五）10:30 —— 盘中
  const original = Date.now
  const NOW = Date.parse('2026-10-16T10:30:00+08:00')
  Date.now = () => NOW
  const dir = join(HOME, 'dsh-tradewatcher', 'klines')
  mkdirSync(dir, { recursive: true })
  // 月K 缓存：2025 全年 + 2026 年到 10 月（含缺 vol 的一个月）
  const bars: DayBar[] = []
  for (const [y, months] of [[2025, 12], [2026, 10]] as const) {
    for (let m = 1; m <= months; m += 1) {
      const mm = String(m).padStart(2, '0')
      bars.push(monthBar(`${y}-${mm}-28`, y === 2026 && m === 5 ? null : 1000 + m, 10 + m * 0.1))
    }
  }
  writeFileSync(join(dir, `${secid}_103_1.json`), JSON.stringify({ v: 3, secid, klt: 103, fqt: 1, updatedAt: NOW - 3_600_000, partial: false, bars }))
  // 上游全挂（盘中必须真的尝试回源，但拿不到新数据 ⇒ 用缓存）
  const realFetch = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new Error('fetch failed'))) as typeof fetch
  try {
    const k = await fetchKline(secid, 104, 6, 1)
    assert.ok(k !== null, '有缓存就必须给出来')
    const yearBars = k.days
    const last = yearBars[yearBars.length - 1]
    /**
     * 判据：本年那根年K 必须被判"仍在走"。
     * 它是序列最后一根、日期落在本年 ⇒ 盘中 `barOpen` 必须 true。
     * 旧实现 `date` 是年末月 ⇒ `lastDate === today` 永远不成立 ⇒ 永远 false。
     */
    const markedOpen = (payload: { barOpen?: boolean }): boolean => payload.barOpen === true
    assert.equal(last.date.slice(0, 4), '2026', '最后一根应当是本年那根')
    assert.equal(markedOpen(k), true, `盘中本年那根年K 必须标 barOpen（实际 barOpen=${String(k.barOpen)}）`)
    // ⚠ 反例注入：按**日期**相等判（旧口径）在同一份数据上必然 false
    const oldVerdict = last.date === '2026-10-16'
    assert.equal(oldVerdict, false, '⚠ 旧口径（date === 今天）对年K 永远为 false —— 判据必须拒绝它')
    // 本年那根的量必须因"5 月缺量"而 null（顺带守住 ① 在真实链路里生效）
    assert.equal(last.vol, null, '本年有一个月缺量 ⇒ 该年 vol 必须 null')
    // 2025 那根（量齐）必须有值
    const y2025 = yearBars.find((b) => b.date.startsWith('2025'))
    assert.ok(y2025 !== undefined && typeof y2025.vol === 'number' && y2025.vol > 0, '2025 年量齐 ⇒ 必须有值')
  } finally {
    globalThis.fetch = realFetch
    Date.now = original
  }
})

// ─────────────────────── ③ 首根 pct 不得冒充同比 ─────────────────────────────

test('③ 首根年K 的 pct 必须是 null（注入"用 open 当基数" ⇒ 必败）', () => {
  const monthly = [
    monthBar('2025-01-31', 10, 10),
    monthBar('2025-12-31', 10, 20),
    monthBar('2026-01-30', 10, 30),
    monthBar('2026-12-31', 10, 40),
  ]
  const years = resampleYearly(monthly)
  assert.equal(years.length, 2)
  assert.equal(years[0].pct, null, `首根没有上一年收盘 ⇒ pct 必须是 null（实际 ${String(years[0].pct)}）`)
  // 第二根是**同比**：相对上一年收盘（20 → 40 ⇒ +100%）
  assert.equal(years[1].pct, 100, `第二根必须是同比（20→40 ⇒ +100%，实际 ${String(years[1].pct)}）`)
  // ⚠ 反例注入：旧写法 `base = prevClose ?? bar.open` 在首根给出"年内涨幅"
  const oldPct = (years[0].close - years[0].open) / years[0].open * 100
  assert.ok(Number.isFinite(oldPct) && oldPct > 0, `⚠ 旧写法给出 ${oldPct.toFixed(1)}%（年内涨幅冒充同比）`)
  assert.notEqual(years[0].pct, Math.round(oldPct * 100) / 100, '⚠ 新旧必须不同（旧的是年内涨幅，不是同比）')
})

test('③b 年K 必须回带涨跌幅口径（`pctNote`），否则 null 会被读成"那一年平盘"', async () => {
  const secid = '1.601398'
  const original = Date.now
  const NOW = Date.parse('2026-10-16T10:30:00+08:00')
  Date.now = () => NOW
  // 复用 ②b 写下的月K 缓存（同一份数据，不额外造）
  const realFetch = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new Error('fetch failed'))) as typeof fetch
  try {
    const k = await fetchKline(secid, 104, 6, 1)
    assert.ok(k !== null)
    assert.equal(typeof k.pctNote, 'string', '年K 必须带 pctNote 口径句')
    assert.match(String(k.pctNote), /同比/, '口径句必须写明是"同比"')
    assert.match(String(k.pctNote), /首根/, '口径句必须说明首根为什么是空的')
    assert.equal(k.days[0].pct, null, '首根 pct 必须是 null（口径句说的就是这件事）')
    // 日K 不带这句话（不许给非年K 加噪音）
    const daily = await fetchKline(secid, 101, 5, 1)
    if (daily !== null) assert.equal(daily.pctNote, undefined, '非年K 不许带 pctNote')
  } finally {
    globalThis.fetch = realFetch
    Date.now = original
  }
})

// ─────────────────────── ④ chips lastBar：缺失 ≠ 真 0 ───────────────────────

test('④ chips lastBar：缺失 ⇒ vol:null + 原因；真 0 ⇒ vol:0 + zeroVolume（注入合并 ⇒ 必败）', () => {
  const bar = (date: string, vol: number | null, close = 10): ChipBar => ({ date, close, vol })
  /** 判据：两种情形必须**可区分**，且都不许出现"看起来未取到却写着 0" */
  const distinguishable = (meta: { vol: number | null; volReason: string | null; zeroVolume: boolean }): boolean =>
    (meta.vol === null && meta.volReason !== null && meta.zeroVolume === false)
    || (meta.vol === 0 && meta.volReason === null && meta.zeroVolume === true)

  // 缺失
  const missing = lastBarMetaOf(bar('2026-10-16', null), '2026-10-16')
  assert.equal(missing.vol, null, '缺失必须是 null（旧写法 `?? 0` 会写成 0）')
  assert.equal(typeof missing.volReason, 'string', '缺失必须带原因')
  assert.equal(missing.zeroVolume, false, '缺失不是"真 0"')
  assert.equal(distinguishable(missing), true)

  // 真 0（实测港股有 3 根这样的 bar）
  const realZero = lastBarMetaOf(bar('2026-10-16', 0), '2026-10-16')
  assert.equal(realZero.vol, 0, '上游真的给 0 ⇒ 保持 0（不许改成 null）')
  assert.equal(realZero.volReason, null, '真 0 不是缺失 ⇒ 不该有"缺失"原因')
  assert.equal(realZero.zeroVolume, true, '真 0 必须带标记')
  assert.equal(distinguishable(realZero), true)

  // 正常值
  const normal = lastBarMetaOf(bar('2026-10-16', 12345), '2026-10-16')
  assert.equal(normal.vol, 12_345)
  assert.equal(normal.volReason, null)
  assert.equal(normal.zeroVolume, false)

  // ⚠ 反例注入：旧写法 `vol ?? 0` 让"缺失"与"真 0"变成同一个值
  const oldWay = (v: number | null): number => v ?? 0
  assert.equal(oldWay(null), 0, '⚠ 旧写法把缺失写成 0')
  assert.equal(oldWay(0), 0, '⚠ 旧写法下真 0 也是 0 ⇒ 两者不可区分')
  assert.equal(oldWay(null) === oldWay(0), true, '⚠ 旧写法下两种情形完全合并 —— 本判据必须拒绝它')
})

test('④b 端到端：`chipSeriesOf` 的 lastBar 沿用同一判定（不是两套口径）', () => {
  const withMissing = chipSeriesOf([{ date: '2026-10-15', close: 10, vol: 100 }, { date: '2026-10-16', close: 10, vol: null }], { window: 10, display: 2 })
  assert.equal(withMissing.lastBar?.vol, null, '最后一根缺量 ⇒ lastBar.vol 是 null')
  assert.equal(typeof withMissing.lastBar?.volReason, 'string')
  const withZero = chipSeriesOf([{ date: '2026-10-16', close: 10, vol: 0 }], { window: 10, display: 2 })
  assert.equal(withZero.lastBar?.vol, 0, '最后一根真 0 ⇒ lastBar.vol 是 0')
  assert.equal(withZero.lastBar?.zeroVolume, true)
  assert.notEqual(withMissing.lastBar?.vol, withZero.lastBar?.vol, '两种情形在回包里必须不同')
})
