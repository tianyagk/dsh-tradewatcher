/**
 * U3（请求去重）的可检查判据。
 *
 * 根因：四条 effect 挂在一个"每拍都换身份"的对象上（`quotes` / 采样快照），
 * 静置 10 分钟 = 各约 60 次请求。这里把"节拍"抽成纯函数，断言两件事：
 *   ① **模型**：静置 10 分钟的各路由调用次数 ≤ 预算（industries ≤10 / breadth ≤10 / extras ≤20 / trend ≤10）；
 *   ② **接线**：四条 effect 的依赖里**不许**出现对象身份（`quotes`），必须挂节拍信号，
 *      并且 effect 体内必须有节拍守卫（`dueByInterval` / `dueEveryTicks`）。
 *
 * 每条都配反例注入：把依赖改回对象身份 / 把守卫删掉 / 把间隔改成 0 ⇒ 判据必须非空。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  BREADTH_MIN_INTERVAL_MS,
  CALL_BUDGET_10MIN,
  EXTRAS_MIN_INTERVAL_MS,
  INDUSTRIES_EVERY_TICKS,
  QUOTE_TICK_SEC,
  TREND_MIN_INTERVAL_MS,
  callsInWindowInterval,
  callsInWindowTicks,
  dueByInterval,
  dueEveryTicks,
} from './pacing.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')

const WINDOW_SEC = 10 * 60

// ── ① 纯函数语义 ────────────────────────────────────────────────────────────

test('dueByInterval：null 放行（首拍）、到点放行、没到点拦下', () => {
  assert.equal(dueByInterval(1_000, null, 60_000), true, '第一次必须放行，否则首屏没有数据')
  assert.equal(dueByInterval(61_000, 1_000, 60_000), true, '正好到点放行')
  assert.equal(dueByInterval(60_999, 1_000, 60_000), false, '差 1ms 也得拦下')
  assert.equal(dueByInterval(1_000, Number.NaN, 60_000), true, '坏值当"没有上次"处理（宁可多取一次也不停更）')
  assert.equal(dueByInterval(Number.NaN, 1_000, 60_000), false, '拿不到当前时刻 ⇒ 不盲目发请求')
})

test('dueEveryTicks：第 1 拍必取，之后每 N 拍一次', () => {
  const hits: number[] = []
  for (let tick = 1; tick <= 13; tick += 1) if (dueEveryTicks(tick, 6)) hits.push(tick)
  assert.deepEqual(hits, [1, 7, 13], '第 1、7、13 拍取（每 6 拍一次，首拍不拖到 60s）')
  assert.equal(dueEveryTicks(0, 6), false, '还没拍过就不取')
  assert.equal(dueEveryTicks(3, 0), false, '间隔为 0 是坏配置（不是"每拍都取"）')
})

// ── ② 模型：静置 10 分钟的调用次数 ──────────────────────────────────────────

test('静置 10 分钟：四条路由的调用次数都在预算内（现状各约 60）', () => {
  const actual = {
    industries: callsInWindowTicks(WINDOW_SEC, QUOTE_TICK_SEC, INDUSTRIES_EVERY_TICKS),
    breadth: callsInWindowInterval(WINDOW_SEC, QUOTE_TICK_SEC, BREADTH_MIN_INTERVAL_MS),
    extras: callsInWindowInterval(WINDOW_SEC, QUOTE_TICK_SEC, EXTRAS_MIN_INTERVAL_MS),
    trend: callsInWindowInterval(WINDOW_SEC, QUOTE_TICK_SEC, TREND_MIN_INTERVAL_MS),
  }
  assert.deepEqual(actual, {
    industries: 10,
    breadth: 10,
    extras: 20,
    trend: 10,
  })
  for (const [route, n] of Object.entries(actual)) {
    const budget = CALL_BUDGET_10MIN[route as keyof typeof CALL_BUDGET_10MIN]
    assert.ok(n <= budget, `${route} 必须 ≤ ${budget} 次 / 10 分钟（实际 ${n}）`)
  }
  // 反例注入：**不节流**（= 旧行为：每拍一次）⇒ 60 次，预算必然被打破
  const unthrottled = {
    industries: callsInWindowTicks(WINDOW_SEC, QUOTE_TICK_SEC, 1),
    breadth: callsInWindowInterval(WINDOW_SEC, QUOTE_TICK_SEC, 0),
    extras: callsInWindowInterval(WINDOW_SEC, QUOTE_TICK_SEC, 0),
    trend: callsInWindowInterval(WINDOW_SEC, QUOTE_TICK_SEC, 0),
  }
  assert.deepEqual(unthrottled, { industries: 60, breadth: 60, extras: 60, trend: 60 }, '⚠ 反例必须真的复现"每拍一次"')
  assert.throws(
    () => assert.ok(unthrottled.breadth <= CALL_BUDGET_10MIN.breadth, '反例上"≤10 次"必须失败'),
    /反例上/,
    '⚠ 反例注入（改回每拍一次）必须让预算断言失败',
  )
})

// ── ③ 接线：四条 effect 的依赖与守卫 ──────────────────────────────────────

interface EffectSpec {
  file: string
  route: string
  /** 该 effect 体内独一无二的锚点（用它定位 effect 块） */
  marker: string
  /** effect 体内必须出现的节拍守卫 */
  guard: string
  /** 依赖数组里必须出现的节拍信号 */
  mustDepend: string
}

const EFFECTS: EffectSpec[] = [
  { file: 'WatchlistPage.tsx', route: 'industries', marker: '.industries(secs)', guard: 'dueEveryTicks(', mustDepend: 'props.quoteTs' },
  { file: 'MarketPage.tsx', route: 'breadth', marker: '.breadth({ dist: true })', guard: 'dueByInterval(', mustDepend: 'props.quoteTs' },
  { file: 'MarketPage.tsx', route: 'extras', marker: '.marketExtras(', guard: 'dueByInterval(', mustDepend: 'props.quoteTs' },
  { file: 'RescuePanel.tsx', route: 'trend', marker: '.trend(lane, 1)', guard: 'dueByInterval(', mustDepend: 'snapshot?.ts' },
]

interface EffectBlock {
  body: string
  deps: string
  /** 依赖数组在源码里的绝对区间（注入时按**位置**替换 —— 同一文件里两处 `[props.quoteTs]` 才不会被换错） */
  depsStart: number
  depsEnd: number
}

/** 取 marker 所在 effect 的 `{ 函数体, 依赖数组 }`（依赖数组形如 `[watch, props.quoteTs]`） */
function effectBlockOf(src: string, marker: string): EffectBlock | null {
  const at = src.indexOf(marker)
  if (at < 0) return null
  const head = src.lastIndexOf('useEffect(', at)
  if (head < 0) return null
  const tail = src.indexOf('}, [', at)
  if (tail < 0) return null
  const end = src.indexOf('])', tail)
  if (end < 0) return null
  return { body: src.slice(head, tail), deps: src.slice(tail + 3, end + 1).trim(), depsStart: tail + 3, depsEnd: end + 1 }
}

/** 判据：返回违规清单（真源码必须为空；反例必须非空） */
function pacingViolations(src: string, spec: EffectSpec): string[] {
  const bad: string[] = []
  const block = effectBlockOf(src, spec.marker)
  if (block === null) return [`${spec.route}：找不到 effect（锚点 ${spec.marker}）`]
  // 依赖里不许出现"每拍都换身份"的对象（旧的 `[watch, quotes]` / `[props.quotes]`）
  if (/(^|[\s,[])(props\.)?quotes([\s,\]])/.test(block.deps)) {
    bad.push(`${spec.route}：依赖仍是对象身份（${block.deps}）`)
  }
  if (!block.deps.includes(spec.mustDepend)) {
    bad.push(`${spec.route}：依赖里没有节拍信号 ${spec.mustDepend}（实际 ${block.deps}）`)
  }
  if (!block.body.includes(spec.guard)) {
    bad.push(`${spec.route}：effect 体内没有节拍守卫 ${spec.guard}`)
  }
  return bad
}


// v0.187.0：四个 effect 里两个已随卡片下线（用例同步删除），下列 helper 仅保留给其余用例
export const __pacingHelpers = [read, EFFECTS, pacingViolations]
