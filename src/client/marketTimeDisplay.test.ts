/**
 * R5 红线断言：「数据时刻」族必须按**北京时间**渲染，与浏览器时区无关。
 *
 * 为什么这些断言必须在 `TZ=UTC` 轮也通过（门禁脚本带 `TZ=UTC` 一轮）：
 * 旧实现的期望值是用**同一个** `toLocaleTimeString` 推导出来的 ⇒ 任何时区都过（把缺陷锁成契约），
 * 而同一 epoch 在 UTC 浏览器显示 `01:42:52`、纽约 `21:42:52`、悉尼 `12:42:52` —— 用户看到的
 * "数据时刻"与市场无关。这里全部改成**固定字面量**（北京墙上时间）。
 *
 * 另有 §R5-扫描：全仓 `toLocale*` / 本地 `getHours()` / `toISOString().slice(0,10)` 的静态排查，
 * 任何"没有 timeZone 的本地化调用"都必须为零（否则红线会以新面孔回来）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { badgeView } from './badgeView.ts'
import { quoteStateTitle } from './quoteState.ts'
import { fmtClock, fmtStamp } from './format.ts'
import { stamp as chartStamp } from './chartNote.ts'
import { shClockText, shDayText, shStampText, shToday } from './marketTime.ts'
import type { QuoteRow } from '../shared/model.ts'

/** 北京 2026-10-12 09:42:52（复核实测里那个 epoch：UTC 下会显示 01:42:52） */
const AT = Date.parse('2026-10-12T09:42:52+08:00')

const row = (at: number): QuoteRow => ({
  secid: '1.600519',
  code: '600519',
  name: '贵州茅台',
  price: 1278.25,
  chg: 15.25,
  pct: 1.21,
  prev: 1263,
  open: 1270,
  high: 1280,
  low: 1265,
  vol: 100,
  amount: 1e8,
  up: null,
  down: null,
  even: null,
  time: null,
  source: 'em',
  at,
})

test('R5-① 侧栏徽标标签：`数据 HH:mm:ss` 必须是北京时间（字面量断言，不是推导值）', () => {
  const v = badgeView(
    { indexPoint: 3000, indexName: '上证指数', dayPnlPct: -2.29, dayPnl: -2290, asOf: AT, settled: false },
    false,
  )
  assert.equal(v.stamp, '数据 09:42:52', `侧栏标签必须是北京 09:42:52（UTC 浏览器下旧实现给 01:42:52；实际 ${v.stamp}）`)
})

test('R5-② 行情卡 title：`数据时刻 HH:mm:ss` 必须是北京时间', () => {
  const title = quoteStateTitle('live', row(AT), 10)
  assert.ok(title.includes('数据时刻 09:42:52'), `行情卡 title 必须是北京 09:42:52（实际 ${title.split('\\n')[0]}）`)
})

test('R5-③ 共享格式化：fmtClock / fmtStamp / marketTime 三兄弟口径一致（固定北京时间）', () => {
  assert.equal(fmtClock(AT), '09:42:52')
  assert.equal(fmtStamp(AT), '10-12 09:42')
  assert.equal(shClockText(AT), '09:42:52')
  assert.equal(shStampText(AT), '10-12 09:42')
  assert.equal(shDayText(AT), '2026-10-12')
  // 北京日界的两个边（UTC 浏览器下最容易翻日）
  assert.equal(shDayText(Date.parse('2026-11-01T00:30:00+08:00')), '2026-11-01')
  assert.equal(shToday(Date.parse('2026-11-01T00:30:00+08:00')), '2026-11-01')
  assert.equal(shDayText(Date.parse('2026-10-31T23:30:00+08:00')), '2026-10-31')
})

test('R5-④ K 线脚注：`MM-DD HH:mm` 必须是北京时间（固定 epoch + 固定字面量）', () => {
  assert.equal(chartStamp(Date.parse('2026-10-09T09:05:00+08:00')), '10-09 09:05')
  assert.equal(chartStamp(AT), '10-12 09:42')
})

// ───────────────────────── §R5 全仓静态排查 ─────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if ((p.endsWith('.ts') || p.endsWith('.tsx')) && !p.endsWith('.test.ts')) out.push(p)
  }
  return out
}

/**
 * 允许清单（每条都要写清理由；**只允许这两种**，新出现的一律让扫描失败）：
 *  - `shared/trendStitch.ts` 的 `msToDay`：只做 `YYYY-MM-DD` 字符串的往返（UTC 午夜 ⇄ 日期串），
 *    不把任何"时刻"换算成自然日 ⇒ 与市场时区无关（该文件里 `dayMs`/`isWeekday` 同源）。
 *  - `host/klineLock.child.ts`：测试子进程，`toISOString` 只用来造夹具文件名/日期（非展示口径）。
 */
const ALLOW_UTC_DAY = new Set(['shared/trendStitch.ts:37'])
const ALLOW_PREFIX = ['host/klineLock.child.ts', 'host/rescuePersist.child.ts']

test('R5-⑤ 全仓扫描：不得再有"按本机/浏览器时区"的时间调用（红线回归防线）', () => {
  const files = walk(SRC)
  assert.ok(files.length > 40, `扫描范围应覆盖整个 src（实际 ${files.length} 个文件）`)
  const badLocal = new Map<string, string[]>() // 本地化调用没带 timeZone
  const badUtcDay = new Map<string, string[]>() // toISOString 当日界用
  const badGetter = new Map<string, string[]>() // 本地 getHours/getMinutes/getSeconds
  for (const f of files) {
    const rel = f.slice(SRC.length + 1)
    const src = readFileSync(f, 'utf8')
    // 先剥注释（含跨行块注释）——注释里出现这些词是给人看的，不算泄漏
    let inBlock = false
    const lines = src.split('\n').map((raw) => {
      let l = ''
      let rest = raw
      while (rest !== '') {
        if (inBlock) {
          const end = rest.indexOf('*/')
          if (end < 0) { rest = ''; break }
          rest = rest.slice(end + 2)
          inBlock = false
        } else {
          const start = rest.indexOf('/*')
          if (start < 0) { l += rest; rest = ''; break }
          l += rest.slice(0, start)
          rest = rest.slice(start + 2)
          inBlock = true
        }
      }
      return l.replace(/(^|[^:])\/\/.*$/, '$1')
    })
    lines.forEach((l, i) => {
      // 只有**时间**类本地化才算：`toLocaleTimeString`/`toLocaleDateString` 一定是；
      // `toLocaleString` 要看它是不是落在 Date 上/带时间选项（数字千分位 `n.toLocaleString('en-US')` 不算）
      const isTimeLocale =
        /toLocale(?:Time|Date)String\(/.test(l) ||
        (/toLocaleString\(/.test(l) && /(Date\(|hour12|hour:|minute:|second:|month:|day:|year:)/.test(l)) ||
        (/toLocaleString\(/.test(l) && /Date\(/.test(lines[i + 1] ?? ''))
      if (isTimeLocale) {
        // 允许：显式带 timeZone 的调用（当前只有 watchlistView 一处）
        if (!/timeZone:/.test(l)) {
          const k = `${rel}:${i + 1}`
          if (!badLocal.has(rel)) badLocal.set(rel, [])
          badLocal.get(rel)?.push(k)
        }
      }
      if (/toISOString\(\)\.slice\(0, 10\)/.test(l)) {
        const key = `${rel}:${i + 1}`
        if (!ALLOW_UTC_DAY.has(key) && !ALLOW_PREFIX.some((p) => rel.startsWith(p))) {
          if (!badUtcDay.has(rel)) badUtcDay.set(rel, [])
          badUtcDay.get(rel)?.push(key)
        }
      }
      if (/\.get(?:Hours|Minutes|Seconds)\(\)/.test(l)) {
        if (!badGetter.has(rel)) badGetter.set(rel, [])
        badGetter.get(rel)?.push(`${rel}:${i + 1}`)
      }
    })
  }
  assert.deepEqual(
    [...badLocal].map(([f, l]) => `${f} → ${l.join(',')}`),
    [],
    '不得有无 timeZone 的 toLocale* 调用（"数据时刻"族一律走 marketTime.ts 的固定北京出口）',
  )
  assert.deepEqual(
    [...badUtcDay.values()].map((l) => l.join(',')),
    [],
    '不得用 toISOString() 当日界（UTC 日期 ≠ 北京自然日；要用 shToday/shDayText）',
  )
  assert.deepEqual(
    [...badGetter].map(([f, l]) => `${f} → ${l.join(',')}`),
    [],
    '不得再用本地 getHours/getMinutes/getSeconds 渲染市场时间（用 fmtClock/shClockText）',
  )
})
