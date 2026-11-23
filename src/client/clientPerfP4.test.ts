/**
 * AUDIT-CLIENT-PERF 客户端 P2 收尾（P2-11 / P2-13 限定版）的可检查判据。
 *
 * 方法沿用 `clientPerfP1/P2/P3.test.ts`：**真源码 + 纯函数 + 反例注入**。
 *   P2-11 `QuoteDrawer` render 体内联 `Date.now()` ⇒ 改成 `useNow(60_000)` 的 `now` 进依赖，
 *          并把五日档「滞后/覆盖」段拆成可注入 now 的纯函数（同一 now 两次渲染同文案，跨日必变）。
 *   P2-13 K 线游标每帧重算可见窗口极值 ⇒ 只把「可见切片 + 极值」useMemo 到 `[bars, s, e, mas]`；
 *          **不改**图表分层/覆盖层结构（视觉规格风险）。
 *
 * 注：P2-11 任务书写「滞后 1 天 → 2 天」，但 `shared/trendCaliber.ts` 的陈旧阈值是
 * 「近似工作日 ≥ 2」——自然日 1 天最多 1 个工作日，永远不会 stale，所以最早可见的滞后就是
 * 2 天。这里用同一路径的「2 天 → 3 天」验证"跨日文本必变"，不伪造 1 天档。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { fiveDayCaliberNote } from './chartNote.ts'
import { klineVisibleOf, type KlineMaLike } from './klineView.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')
/** 去注释（源码断言只认活代码：注释里提到某个词不算接线） */
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

/** React.useMemo 的依赖比较语义（Object.is，逐项）；只用于把"同输入引用不重算"做成行为断言 */
function createMemoCell(): { run: <T>(compute: () => T, deps: readonly unknown[]) => T; computes: () => number } {
  let deps: readonly unknown[] | null = null
  let value: unknown
  let computes = 0
  return {
    run<T>(compute: () => T, next: readonly unknown[]): T {
      const same = deps !== null && deps.length === next.length && deps.every((d, i) => Object.is(d, next[i]))
      if (!same) {
        deps = next
        value = compute()
        computes += 1
      }
      return value as T
    },
    computes: () => computes,
  }
}

// ══ P2-11 ① render 体不再内联 Date.now() ═════════════════════════════════════

test('P2-11 源码：QuoteDrawer 的 render 体没有 Date.now()（反例：注入后必须被抓到）', () => {
  const drawer = strip(read('QuoteDrawer.tsx'))
  const hasDateNow = (src: string): boolean => /Date\.now\s*\(/.test(src)
  assert.equal(hasDateNow(drawer), false, 'QuoteDrawer 内不许再出现 Date.now()（时间只从 useNow 进来）')
  // 先证明扫描器本身有效（否则上一条断言是假阴性）
  assert.equal(hasDateNow('const t = Date.now()'), true, '扫描器必须能识别对照样本里的 Date.now()')
  // 反例注入：把接线退回旧写法（render 体内联取当前时刻）
  const legacy = drawer.replace('const now = useNow(60_000)', 'const now = Date.now()')
  assert.equal(hasDateNow(legacy), true, '⚠ 反例（旧写法）必须被抓到')
  assert.throws(
    () => assert.equal(hasDateNow(legacy), false, '反例上：仍含 Date.now'),
    /反例上/,
    '⚠ 反例注入必须让断言失败',
  )
})

test('P2-11 接线：useNow(60_000) 的 now 作为 fiveDayCaliberNote 的输入并进 useMemo 依赖（反例：冻结常量）', () => {
  const drawer = strip(read('QuoteDrawer.tsx'))
  assert.match(drawer, /import \{ useNow \} from '\.\/useNow\.ts'/, '必须走共享 useNow')
  assert.match(drawer, /const now = useNow\(60_000\)/, '60s 时钟（页面停着也跨日）')
  assert.match(drawer, /fiveDayCaliberNote\(\{/, '五日段必须走纯函数')
  assert.match(drawer, /\n\s*now,/, 'now 必须作为参数传入（不是闭包里的隐式当前时刻）')
  const wired = (src: string): boolean =>
    /const now = useNow\(60_000\)/.test(src) && /[})], \[payload, now\]\)/.test(src)
  assert.equal(wired(drawer), true, 'now 必须在 useMemo 依赖里')
  // 反例：把 now 冻结成常量、并从依赖里删掉 ⇒ 跨日不重算
  const frozen = drawer
    .replace('const now = useNow(60_000)', 'const now = 0')
    .replace('[payload, now])', '[payload])')
  assert.equal(wired(frozen), false, '⚠ 反例（冻结 now）必须被判为未接线')
  assert.throws(
    () => assert.equal(wired(frozen), true, '反例上：冻结 now 仍被当成接线'),
    /反例上/,
    '⚠ 反例注入必须让断言失败',
  )
})

test('P2-11 行为：同一 now 两次调用逐字相同；注入跨日 now ⇒ 滞后天数 +1（反例：冻结时间不跨日）', () => {
  const base = {
    tab: '5d',
    points: [{ label: '2026-09-28 15:00' }],
    coverage: { have: ['09-28'], limit: 5, missing: ['09-29'] },
    snapshotAt: '09-28 15:00',
    now: Date.parse('2026-09-30T12:00:00+08:00'),
  }
  const a = fiveDayCaliberNote(base)
  // 两个独立对象、同一 now：结果必须逐字相同（StrictMode 双渲染一致）
  const b = fiveDayCaliberNote({
    ...base,
    points: base.points.map((p) => ({ ...p })),
    coverage: { ...base.coverage, have: [...base.coverage.have], missing: [...base.coverage.missing] },
  })
  assert.equal(a, b, '同一 now 的两次渲染必须给出同一文案')
  assert.ok(a.includes('数据滞后 2 天'), `now=09-30 时最新数据 09-28 ⇒ 滞后 2 天（实际：${a}）`)
  assert.ok(a.includes('仅 1 天可画'), '覆盖段仍要照旧给出')
  const nextNow = Date.parse('2026-10-01T12:00:00+08:00')
  const next = fiveDayCaliberNote({ ...base, now: nextNow })
  assert.ok(next.includes('数据滞后 3 天'), `now 跨日 ⇒ 滞后 3 天（实际：${next}）`)
  assert.notEqual(next, a, '跨日必须改变文案（页面停着也要自己更新）')
  // 反例：忽略注入的 now（冻结在第一次的时间）⇒ 跨日仍是旧文案
  const frozen = (): string => fiveDayCaliberNote({ ...base, now: base.now })
  assert.equal(frozen(), a, '⚠ 反例：冻结 now 时跨日不更新')
  assert.throws(
    () => assert.ok(frozen().includes('数据滞后 3 天'), '反例上：冻结 now 仍显示 3 天'),
    /反例上/,
    '⚠ 反例注入必须让断言失败',
  )
})

test('P2-11 边界：非五日档不产生该段；五日单天无 coverage 仍给结构性说明（不编滞后）', () => {
  const at = Date.parse('2026-09-30T12:00:00+08:00')
  assert.equal(fiveDayCaliberNote({ tab: 'trend', points: [], coverage: undefined, snapshotAt: null, now: at }), '')
  assert.equal(fiveDayCaliberNote({ tab: '101', points: [], coverage: undefined, snapshotAt: null, now: at }), '')
  assert.equal(
    fiveDayCaliberNote({ tab: '5d', points: [{ label: '2026-09-28 15:00' }], coverage: undefined, snapshotAt: null, now: at }),
    ' · 仅 1 天可画（该市场无多日源）',
    '单天且没有 coverage ⇒ 只说来源限制，不给滞后',
  )
  assert.equal(
    fiveDayCaliberNote({
      tab: '5d',
      points: [{ label: '2026-09-28 15:00' }, { label: '2026-09-29 15:00' }],
      coverage: undefined,
      snapshotAt: null,
      now: at,
    }),
    '',
    '多天且没有 coverage ⇒ 不额外占位',
  )
})

// ══ P2-13 ② 可见窗口极值只随 [bars, s, e, mas] 重算 ═════════════════════════

function makeBars(n: number): Array<{ date: string; open: number; close: number; high: number; low: number; vol: number | null }> {
  return Array.from({ length: n }, (_, i) => ({
    date: `d${i}`,
    open: 10 + i,
    close: 10.5 + i,
    high: 100 + i,
    low: 50 - i,
    vol: 1000 + i,
  }))
}

test('P2-13 计数注入：同一窗口 5 次游标移动只算 1 次极值；s/e 变化再算 1 次（反例：旧实现 5 次）', () => {
  const bars = makeBars(240)
  const mas: KlineMaLike[] = [{ values: Array.from({ length: 240 }, (_, i) => (i === 15 ? 500 : i === 20 ? -100 : null)) }]
  const cell = createMemoCell()
  let computes = 0
  // 游标移动 = 同一 s/e/bars/mas 引用下重新渲染 5 次
  for (let i = 0; i < 5; i += 1) {
    cell.run(() => {
      computes += 1
      return klineVisibleOf(bars, 10, 30, mas)
    }, [bars, 10, 30, mas])
  }
  assert.equal(computes, 1, '同一窗口 5 次游标移动，极值计算函数只能调用 1 次')
  assert.equal(cell.computes(), 1, 'memo cell 只提交 1 次')
  // 窗口变化（s/e 变）⇒ 必须重算 1 次（总共 2 次）
  cell.run(() => {
    computes += 1
    return klineVisibleOf(bars, 0, 10, mas)
  }, [bars, 0, 10, mas])
  assert.equal(computes, 2, '窗口变化必须重新计算 1 次')
  assert.equal(cell.computes(), 2, 'memo cell 总提交 2 次')
  // 反例注入：旧实现（render 体里每帧直接调）⇒ 5 次移动 = 5 次计算
  let legacyComputes = 0
  for (let i = 0; i < 5; i += 1) {
    legacyComputes += 1
    void klineVisibleOf(bars, 10, 30, mas)
  }
  assert.equal(legacyComputes, 5, '⚠ 反例：未 memo 的旧实现确实调用 5 次')
  assert.throws(
    () => assert.equal(legacyComputes, 1, '反例上：旧实现不可能只算 1 次'),
    /反例上/,
    '⚠ 反例注入必须让断言失败',
  )
})

test('P2-13 正确性：切片边界与极值口径不变（含均线点、窗口外点不参与）', () => {
  const bars = makeBars(240)
  const mas: KlineMaLike[] = [{ values: Array.from({ length: 240 }, (_, i) => (i === 15 ? 500 : i === 20 ? -100 : null)) }]
  const v = klineVisibleOf(bars, 10, 30, mas)
  assert.equal(v.bars.length, 20, '可见切片长度 = e - s')
  assert.equal(v.bars[0].date, 'd10', '切片从 s 开始')
  assert.equal(v.bars[19].date, 'd29', '切片到 e-1 结束')
  assert.equal(v.hi, 500, '均线可见点参与极值（500）')
  assert.equal(v.lo, -100, '均线可见点参与极值（-100）')
  const earlier = klineVisibleOf(bars, 0, 10, mas)
  assert.equal(earlier.hi, 109, '窗口外的高点/均线点不得参与')
  assert.equal(earlier.lo, 41, '窗口外的低点不得参与')
  assert.notEqual(earlier.hi, v.hi, '窗口变化 ⇒ 极值确实变化（不是缓存错值）')
})

test('P2-13 接线：kline.tsx 用 useMemo([bars, s, e, mas]) 接住切片/极值；旧内联代码消失（反例：去掉 memo）', () => {
  const kline = strip(read('kline.tsx'))
  const at = kline.indexOf('export function KlineChart')
  assert.ok(at > 0, '必须能找到 KlineChart')
  const body = kline.slice(at)
  const expected = 'useMemo(() => klineVisibleOf(bars, s, e, mas), [bars, s, e, mas])'
  assert.ok(body.includes(expected), `极值/切片必须走 ${expected}`)
  assert.equal(/Math\.max\(\.\.\.visHigh/.test(body), false, '旧的内联 Math.max(...visHigh) 必须消失')
  assert.equal(/bars\.slice\(s, e\)\.map\(\(b\) => b\.vol\)/.test(body), false, '成交量面板必须复用 memo 切片')
  const hasMemo = (src: string): boolean => src.includes(expected)
  assert.equal(hasMemo(body), true)
  const unwrapped = body.replace(expected, '(() => klineVisibleOf(bars, s, e, mas))')
  assert.equal(hasMemo(unwrapped), false, '⚠ 反例（去掉 useMemo）必须被识别')
  assert.throws(
    () => assert.equal(hasMemo(unwrapped), true, '反例上：已去掉 useMemo'),
    /反例上/,
    '⚠ 反例注入必须让断言失败',
  )
})

test('P2-13 视觉快照：KlineChart 关键 class 集合与覆盖层顺序不变（反例：删 tw-kline 必败）', () => {
  const kline = strip(read('kline.tsx'))
  const body = kline.slice(kline.indexOf('export function KlineChart'))
  const classes = [...new Set([...body.matchAll(/className: '([^']+)'/g)].map((m) => m[1]))].sort()
  assert.deepEqual(classes, [
    'tw-btn',
    'tw-kline',
    'tw-ma-legend',
    'tw-muted',
    'tw-sr',
    'tw-zoom',
    'tw-zoom-bar',
    'tw-zoom-h',
    'tw-zoom-sel',
    'tw-zoom-track',
  ], '关键 class 是视觉规格快照：删/改任何一个都必须让断言失败')
  // 分层顺序：成交量 → MACD → 十字光标（光标最后画 ⇒ 压在最上层）
  const volAt = body.indexOf('children.push(...volumePane(')
  const macdAt = body.indexOf('children.push(...macdPane(')
  const cursorAt = body.indexOf("key: 'cursor'")
  assert.ok(volAt > 0 && macdAt > volAt && cursorAt > macdAt, '分层/覆盖层顺序必须保持不变')
  // 反例：删掉外层 tw-kline（或光标层）必须被同一扫描器抓住
  const broken = body.replace("className: 'tw-kline'", "className: 'tw-kline-x'")
  const hasClass = (src: string, cls: string): boolean => src.includes(`className: '${cls}'`)
  assert.equal(hasClass(broken, 'tw-kline'), false, '⚠ 反例（删外层 class）必须被识别')
  assert.throws(
    () => assert.ok(hasClass(broken, 'tw-kline'), '反例上：tw-kline 已不存在'),
    /反例上/,
    '⚠ 反例注入必须让断言失败',
  )
})
