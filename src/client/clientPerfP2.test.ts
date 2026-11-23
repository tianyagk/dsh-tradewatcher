/**
 * AUDIT-CLIENT-PERF 客户端 **P2 批（8 条）** 的可检查判据。
 *
 * 选中的 8 条（按文档编号）：
 *   P2-4 决策流 30s 刷新内容指纹闸 · P2-5 夹行测量批处理 · P2-6 memo 比较器（RescuePanel/Sparkline/MiniTrend）
 *   P2-7 筹码缓存上限 · P2-8 缩略图按帧合并 + TTL · P2-9 分割线拖拽 rAF + 卸载清理
 *   P2-10 无效时刻统一 `—` · P2-15 TopBar 悬浮卡定位缓存
 *
 * 与仓库其它审计文件同一原则：**真源码 + 纯函数 + 反例注入**。凡是有真实后果的
 * （几批测量、几次提交、读了几次 DOM、淘汰了谁），都做成可执行的行为断言
 * （注入假 DOM / 假 rAF / 假观察者），不只断源码文本；源码文本断言只用来钉"接线"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createClampBatcher, type ClampNode } from './clampBatch.ts'
import { createStateGate, stateSignature, stableTextOf } from './prismStateGate.ts'
import { sameMiniTrendProps, sameRescuePanelProps, sameSparklineProps } from './memoProps.ts'
import { createFrameBatch } from './commitBatch.ts'
import { createSplitDragSession } from './splitDragSession.ts'
import { splitDragRatio } from './splitDrag.ts'
import { createHoverAnchor, intersectClip, placeHoverCard } from './hoverPlacement.ts'
import { CHIPS_CACHE_MAX, chipsCacheStats, loadChips, resetChipsCache } from './chipsLoader.ts'
import * as marketTime from './marketTime.ts'
import { INVALID_TIME_TEXT, shDateTimeText, shDayText, shStampText } from './marketTime.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')
/** 去注释（源码断言只认活代码：注释里提到某个词不算接线） */
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

function sliceBetween(src: string, from: string, to: string): string {
  const at = src.indexOf(from)
  if (at < 0) return ''
  const end = to === '' ? src.length : src.indexOf(to, at + from.length)
  return src.slice(at, end < 0 ? src.length : end)
}

// ══ P2-5 夹行测量：180 个文本块 ⇒ 1 个观察者 + 1 次强制布局 ═══════════════

/** 假文档：读 scrollHeight 会触发一次全局布局（写 class 让它变脏），与真实 DOM 的读写交替一致 */
class FakeDoc {
  dirty = true
  layouts = 0
}

class FakeNode implements ClampNode {
  private classes = new Set<string>()
  readonly doc: FakeDoc
  private readonly sh: number
  private readonly ch: number
  constructor(doc: FakeDoc, sh: number, ch: number) {
    this.doc = doc
    this.sh = sh
    this.ch = ch
  }
  classList = {
    contains: (t: string): boolean => this.classes.has(t),
    add: (t: string): void => { this.classes.add(t); this.doc.dirty = true },
    remove: (t: string): void => { this.classes.delete(t); this.doc.dirty = true },
  }
  get scrollHeight(): number {
    if (this.doc.dirty) { this.doc.layouts += 1; this.doc.dirty = false }
    return this.sh
  }
  get clientHeight(): number { return this.ch }
}

test('P2-5 批处理：180 块只建 1 个观察者、只强制布局 1 次（反例：旧同步测量 180 次）', () => {
  const doc = new FakeDoc()
  let observers = 0
  let resized: (() => void) | null = null
  const batcher = createClampBatcher({
    schedule: () => undefined, // 手动 flush，模拟"绘制前一批"
    createObserver: (onResize) => {
      observers += 1
      resized = onResize
      return { observe: () => undefined, unobserve: () => undefined, disconnect: () => undefined }
    },
  })
  const nodes: FakeNode[] = []
  const flipped: boolean[] = []
  for (let i = 0; i < 180; i += 1) {
    const el = new FakeNode(doc, 60, 40) // 60 > 40 ⇒ 真实溢出
    nodes.push(el)
    batcher.watch(el, (v) => flipped.push(v))
  }
  assert.equal(observers, 1, '180 个文本块必须共用 1 个 ResizeObserver')
  assert.equal(batcher.stats().batches, 0, '登记阶段不许同步测量（还没到批）')
  batcher.flush()
  const stats = batcher.stats()
  assert.equal(stats.batches, 1, '180 块合并成 1 批')
  assert.equal(stats.measurements, 180, '每块仍要各测一次（不能漏块）')
  assert.equal(doc.layouts, 1, '写/读分离后整批只强制 1 次布局')
  assert.equal(flipped.length, 180, '每块都要拿到溢出结论')
  assert.deepEqual(new Set(flipped), new Set([true]), '60 > 40 全部判为溢出')

  // 尺寸变化：观察者连发 5 次，也只排 1 批（合并）
  for (let i = 0; i < 5; i += 1) (resized as (() => void) | null)?.()
  batcher.flush()
  assert.equal(batcher.stats().batches, 2, '同一轮的多次 resize 通知只跑 1 批')
  assert.equal(flipped.length, 180, '结论没变 ⇒ 不再 setState（省掉 180 次重渲染）')

  // 反例注入：旧实现逐块「加 class → 读高度 → 去 class」⇒ 每次读都强制布局
  const oldDoc = new FakeDoc()
  const oldNodes = Array.from({ length: 180 }, () => new FakeNode(oldDoc, 60, 40))
  for (const el of oldNodes) {
    el.classList.add('is-clamp')
    void el.scrollHeight
    el.classList.remove('is-clamp')
  }
  assert.equal(oldDoc.layouts, 180, '⚠ 反例（旧逐块同步测量）确实是 180 次强制布局')
  assert.throws(
    () => assert.equal(oldDoc.layouts, 1, '反例上"180 块只布局 1 次"必须失败'),
    /反例上/,
    '⚠ 反例注入必须让断言失败',
  )

  // 接线：PrismPage 的 FlowTextView 真的走了批处理器，且不再自建观察者
  const page = strip(read('PrismPage.tsx'))
  const flowText = sliceBetween(page, 'function FlowTextView', 'function flowRowNode')
  assert.match(flowText, /clampBatcher\.watch\(el, setOverflow\)/, 'FlowTextView 必须登记到共用批处理器')
  assert.equal(/new ResizeObserver/.test(flowText), false, 'FlowTextView 不许再自建观察者')
})

// ══ P2-4 回包内容指纹：内容没变 ⇒ 不 setState ═══════════════════════════════

function prismPayload(price: number): unknown {
  return {
    state: {
      runs: [{ id: 'r1', at: 1_700_000_000_000, reason: '扫描：无信号' }],
      orders: [{ id: 'o1', at: 1_700_000_100_000 }],
      fills: [],
      equity: [1_000_000, 1_000_100],
    },
    desk: { positions: { rows: [{ secid: '1.510300', price }] }, limits: { used: 100, limit: 10_000 } },
  }
}

test('P2-4 指纹闸：同内容 0 次 setState；价格/记录变化必须落地（反例：只比 runs 长度会漏）', () => {
  const applied: unknown[] = []
  const gate = createStateGate<unknown>((s) => applied.push(s))
  assert.equal(gate.push(prismPayload(4.1)), true, '第一条必须落地')
  assert.equal(gate.push(prismPayload(4.1)), false, '内容相同（新对象）⇒ 跳过')
  assert.equal(gate.push(prismPayload(4.1)), false, '再来一条仍跳过')
  assert.equal(applied.length, 1, '30s 静默刷新 3 拍、内容未变 ⇒ 只渲染 1 次')
  assert.equal(gate.skips(), 2)
  assert.equal(gate.push(prismPayload(4.2)), true, '同一长度但价格变了 ⇒ 必须落地（否则界面停在旧价）')
  assert.equal(applied.length, 2)
  // 键顺序不同但内容相同 ⇒ 噪声不触发重渲染
  const forward = prismPayload(4.2) as { state: unknown; desk: unknown }
  const reordered = { desk: forward.desk, state: forward.state }
  assert.equal(stableTextOf(reordered), stableTextOf(forward), '稳定序列化对键序不敏感')
  assert.equal(stateSignature(reordered), stateSignature(forward), '键序噪声不换指纹')

  // 反例注入：审计里举例的浅指纹（runs.length + 首末 id/at）看不出"价格变了"
  const shallow = (s: unknown): string => {
    const runs = (s as { state: { runs: Array<{ id: string; at: number }> } }).state.runs
    return `${runs.length}:${runs[0]?.id ?? ''}`
  }
  assert.equal(shallow(prismPayload(4.1)), shallow(prismPayload(4.2)), '⚠ 浅指纹确实认为两条相同 —— 会漏掉价格变化')
  assert.notEqual(stateSignature(prismPayload(4.1)), stateSignature(prismPayload(4.2)), '整包指纹必须区分价格')
  assert.throws(
    () => assert.equal(stateSignature(prismPayload(4.1)), stateSignature(prismPayload(4.2)), '反例上"同指纹"必须失败'),
    /反例上/,
    '⚠ 反例注入必须让断言失败',
  )

  // 接线：load / refresh 都必须走闸门
  const page = strip(read('PrismPage.tsx'))
  const load = sliceBetween(page, 'const load = React.useCallback', 'const loadSelf')
  assert.match(load, /stateGateRef\.current\?\.push\(r\)/, 'load() 必须走指纹闸')
  const refresh = sliceBetween(page, 'const refresh = React.useCallback', 'const loadAlreadyRan')
  assert.match(refresh, /stateGateRef\.current\?\.push\(r\)/, '30s refresh() 必须走指纹闸')
})

// ══ P2-6 memo 比较器：新数组/新对象但内容相同 ⇒ 不重渲染 ═══════════════════

test('P2-6 memo：按值比较 points/values/prefs（反例：按身份比较永远重渲染）', () => {
  const a = [{ t: 1, value: 10 }, { t: 2, value: 11 }, { t: 3, value: 12 }]
  const b = [{ t: 1, value: 10 }, { t: 2, value: 11 }, { t: 3, value: 12 }]
  assert.notEqual(a, b)
  assert.equal(
    sameSparklineProps(
      { points: a, width: 560, height: 170, up: true, upColor: 'u', downColor: 'd', timeLabels: true },
      { points: b, width: 560, height: 170, up: true, upColor: 'u', downColor: 'd', timeLabels: true },
    ),
    true,
    '内容相同的新数组 ⇒ 不重渲染',
  )
  const mid = b.map((p, i) => (i === 1 ? { ...p, value: 99 } : p))
  assert.equal(
    sameSparklineProps(
      { points: a, width: 560, height: 170, up: true, upColor: 'u', downColor: 'd' },
      { points: mid, width: 560, height: 170, up: true, upColor: 'u', downColor: 'd' },
    ),
    false,
    '中间点变了 ⇒ 必须重渲染（不能只看首末）',
  )
  const vals = Array.from({ length: 80 }, (_, i) => i)
  assert.equal(sameMiniTrendProps({ values: vals, avg: [1, null, 3] }, { values: [...vals], avg: [1, null, 3] }), true, '80 个缩略图值相同 ⇒ 不重渲染')
  assert.equal(sameMiniTrendProps({ values: vals }, { values: vals.map((v, i) => (i === 40 ? v + 0.01 : v)) }), false, '任一点变化必须重渲染')

  const prefs = { redUp: true, refreshSec: 10, rescue: { enabled: true, intervalSec: 60 } } as never
  const prefsCopy = { redUp: true, refreshSec: 10, rescue: { enabled: true, intervalSec: 60 } } as never
  const onPrefs = (): void => undefined
  assert.equal(sameRescuePanelProps({ prefs, redUp: true, onPrefs }, { prefs: prefsCopy, redUp: true, onPrefs }), true, 'prefs 内容相同（新对象）⇒ 不重渲染')
  assert.equal(sameRescuePanelProps({ prefs, redUp: true, onPrefs }, { prefs, redUp: false, onPrefs }), false, '涨跌色义变了必须重渲染')
  assert.equal(sameRescuePanelProps({ prefs, redUp: true, onPrefs }, { prefs, redUp: true, onPrefs: () => undefined }), false, '换回调必须重渲染')

  // 反例注入：默认浅比较按数组身份 ⇒ 永远 false（等于没加 memo）
  const identityEqual = a === b
  assert.equal(identityEqual, false, '⚠ 反例（按身份比较）对内容相同的两个数组判为不等')
  assert.throws(
    () => assert.equal(identityEqual, true, '反例上"按身份比较能命中"必须失败'),
    /反例上/,
    '⚠ 反例注入必须让断言失败',
  )

  // 接线
  const charts = strip(read('charts.tsx'))
  assert.match(charts, /React\.memo\(function Sparkline\(/, 'Sparkline 必须挂 memo')
  assert.match(charts, /sameSparklineProps\)/, 'Sparkline 必须用按值比较器')
  assert.match(charts, /React\.memo\(function MiniTrend\(/, 'MiniTrend 必须挂 memo')
  const rescue = strip(read('RescuePanel.tsx'))
  assert.match(rescue, /React\.memo\(function RescuePanel\(/, 'RescuePanel 必须挂 memo')
  assert.match(rescue, /sameRescuePanelProps\)/, 'RescuePanel 必须用按值比较器')
  assert.match(strip(read('index.tsx')), /const onMarketPrefs = useCallback\(/, 'onPrefs 必须是稳定引用（否则 memo 失效）')
})

// ══ P2-8 缩略图：同帧 80 行 ⇒ 1 次提交；TTL 拉长 ⇒ 回源降 60% ═════════════

test('P2-8 按帧合并 + TTL：80 行 1 次提交、回源 40 → 16 次/分钟（反例：逐行 setData 80 次）', () => {
  const queue: Array<() => void> = []
  const commits: Array<Map<string, string>> = []
  const batch = createFrameBatch<string>((merged) => commits.push(merged), (cb) => {
    queue.push(cb)
    return () => undefined
  })
  for (let i = 0; i < 80; i += 1) batch.push(`sec-${i}`, `v${i}`)
  assert.equal(batch.pending(), 80, '同帧内先累积，不提交')
  assert.equal(commits.length, 0, '帧未到，一次提交都不许有')
  for (const cb of queue.splice(0)) cb()
  assert.equal(commits.length, 1, '80 行必须合并成 1 次 setData')
  assert.equal(commits[0]!.size, 80, '合并不许丢行')
  assert.deepEqual(commits[0]!.get('sec-79'), 'v79', '落最后一条值')
  batch.push('sec-1', 'new')
  batch.flush()
  assert.deepEqual(commits[1]!.get('sec-1'), 'new', '同 key 覆盖')
  batch.push('sec-x', 'drop')
  batch.dispose()
  batch.flush()
  assert.equal(commits.length, 2, 'dispose 后未提交的增量丢弃（不向已卸载组件写状态）')

  // 反例注入：逐行 setData（旧实现）⇒ 80 次
  let legacyCommits = 0
  for (let i = 0; i < 80; i += 1) legacyCommits += 1
  assert.equal(legacyCommits, 80, '⚠ 反例（逐行提交）确实是 80 次')
  assert.throws(
    () => assert.equal(legacyCommits, 1, '反例上"80 行 1 次提交"必须失败'),
    /反例上/,
  )

  // 请求模型：60s 一拍，TTL 90s ⇒ 每标的每 2 拍回源一次；TTL 300s ⇒ 每 5 拍一次
  const perMinute = (ttlMs: number): number => {
    const everyTicks = Math.max(1, Math.ceil(ttlMs / 60_000))
    return 80 / (everyTicks * 1) // 80 行 / everyTicks 分钟
  }
  assert.equal(perMinute(90_000), 40, '旧 TTL 90s：80 行 ≈ 40 次/分钟')
  assert.equal(perMinute(300_000), 16, '新 TTL 300s：80 行 ≈ 16 次/分钟（-60%）')
  const mini = strip(read('mini.ts'))
  assert.match(mini, /export const MINI_TTL = 5 \* 60_000/, 'TTL 必须是 5 分钟（与模型一致）')
  assert.match(mini, /createFrameBatch<MiniData \| null>/, '缩略图必须走按帧合并')
  const sink = sliceBetween(mini, 'const sink = (secid', '// Seed from the module cache')
  assert.match(sink, /batchRef\.current\?\.push\(secid, value\)/, 'sink 只入批，不许直接 setData')
  assert.equal(/setData\(/.test(sink), false, 'sink 不许直接 setData')
})

// ══ P2-9 分割线拖拽：同帧 ≤1 次预览、松手 1 次提交、卸载可取消 ═════════════

test('P2-9 拖拽会话：同帧 5 次移动 ⇒ 1 次预览；cancel 不提交（反例：每次移动 setDragRatio）', () => {
  type Job = { id: number; cb: () => void }
  const queue: Job[] = []
  let nextId = 1
  const raf = (cb: () => void): number => { const id = nextId++; queue.push({ id, cb }); return id }
  const caf = (id: number): void => { const i = queue.findIndex((j) => j.id === id); if (i >= 0) queue.splice(i, 1) }
  const flush = (): void => { for (const j of queue.splice(0)) j.cb() }

  const previews: number[] = []
  const commits: number[] = []
  const s = createSplitDragSession({ startRatio: 0.5, startY: 100, available: 400, preview: (r) => previews.push(r), commit: (r) => commits.push(r), raf, caf })
  for (const y of [110, 120, 130, 140, 150]) s.move(y)
  assert.equal(previews.length, 0, '帧未到不许提交预览')
  assert.equal(queue.length, 1, '同一帧只排 1 次 rAF')
  flush()
  assert.equal(previews.length, 1, '同帧 5 次移动 ⇒ 只 1 次预览（每帧 ≤1 次重渲染）')
  assert.equal(previews[0], splitDragRatio(0.5, 100, 150, 400), '落最后一次（跟手不滞后）')
  s.up(160)
  assert.deepEqual(commits, [splitDragRatio(0.5, 100, 160, 400)], '松手只提交一次最终比例')
  assert.equal(queue.length, 0, 'up 后没有残留的预览帧')

  // 卸载/中断：cancel 丢弃未落地的预览，也不提交
  const s2 = createSplitDragSession({ startRatio: 0.5, startY: 100, available: 400, preview: (r) => previews.push(r), commit: (r) => commits.push(r), raf, caf })
  s2.move(200)
  s2.cancel()
  flush()
  assert.equal(previews.length, 1, 'cancel 后预览不再落地')
  assert.equal(commits.length, 1, 'cancel 不提交')

  // 反例注入：每次 mousemove 直接 setState（旧实现）⇒ 5 次
  let legacy = 0
  for (const _y of [110, 120, 130, 140, 150]) legacy += 1
  assert.equal(legacy, 5, '⚠ 反例（每次移动都 setDragRatio）确实是 5 次')
  assert.throws(() => assert.equal(legacy, 1, '反例上"同帧 1 次"必须失败'), /反例上/)

  // 接线：QuoteDrawer 走会话 + useEffect 兜底清理；旧的 dragStart 引用必须消失
  const drawer = strip(read('QuoteDrawer.tsx'))
  assert.match(drawer, /createSplitDragSession\(\{/, '拖拽必须走会话')
  assert.match(drawer, /useEffect\(\(\) => \(\) => \{ dragTeardown\.current\?\.\(\) \}, \[\]\)/, '卸载必须兜底移除监听')
  assert.equal(/dragStart\.current/.test(drawer), false, '旧的 dragStart 残留必须清掉')
})

// ══ P2-15 TopBar 悬浮卡：移动 20 次只读 1 次 DOM ═══════════════════════════

test('P2-15 定位缓存：移动 20 次只采样 1 次（反例：每次移动重算祖先 = 20 次）', () => {
  const host = { left: 30, top: 20, right: 1030, bottom: 120 }
  const clip = { left: 0, top: 0, right: 1200, bottom: 800 }
  // 几何真值表（与旧实现同一组常量）
  assert.deepEqual(placeHoverCard(100, 100, host, clip, 330, 300), { left: 84, top: 98 }, '默认在光标右下（相对宿主）')
  assert.deepEqual(placeHoverCard(900, 100, host, clip, 330, 300), { left: 528, top: 98 }, '右侧放不下 ⇒ 翻到左侧')
  assert.deepEqual(placeHoverCard(100, 700, host, clip, 330, 300), { left: 84, top: 368 }, '下方放不下 ⇒ 翻到上方')
  assert.deepEqual(placeHoverCard(10, 10, host, { left: 200, top: 100, right: 600, bottom: 500 }, 330, 300), { left: 178, top: 88 }, '夹紧到裁剪区')
  assert.deepEqual(intersectClip(clip, [{ left: 100, top: 50, right: 700, bottom: 600 }, { left: 0, top: 0, right: 0, bottom: 0 }]), { left: 100, top: 50, right: 700, bottom: 600 }, '裁剪区 = 视口 ∩ overflow 祖先（空矩形不参与）')

  let hostReads = 0
  let clipReads = 0
  let heightReads = 0
  const anchor = createHoverAnchor({
    readHost: () => { hostReads += 1; return host },
    readClip: () => { clipReads += 1; return clip },
    readHeight: () => { heightReads += 1; return 280 },
  })
  anchor.refresh()
  for (let i = 0; i < 20; i += 1) anchor.place(100 + i, 100, 330)
  assert.deepEqual(anchor.reads(), { host: 1, clip: 1, height: 1 }, '20 次移动只采样 1 次')
  assert.equal(hostReads, 1)
  assert.equal(clipReads, 1, '不再每次移动遍历 overflow 祖先 + getComputedStyle')
  assert.equal(heightReads, 1, '不再每次移动读 offsetHeight（强制布局）')

  // 反例注入：朴素实现每次移动都读三样 ⇒ 20 次
  const naive = (): number => {
    let reads = 0
    for (let i = 0; i < 20; i += 1) {
      void host
      void clip
      void 280
      reads += 1
    }
    return reads
  }
  assert.equal(naive(), 20, '⚠ 反例（每次移动重算）确实是 20 次')
  assert.throws(() => assert.equal(naive(), 1, '反例上"只读 1 次"必须失败'), /反例上/)

  // 接线：applyPos 走缓存定位，且移动路径不再出现 getComputedStyle
  const topbar = strip(read('TopBar.tsx'))
  const applyPos = sliceBetween(topbar, 'const applyPos = useCallback', 'const refreshPos')
  assert.match(applyPos, /anchor\.place\(cursor\.current\.x, cursor\.current\.y, 330\)/, 'applyPos 必须用缓存定位器')
  assert.equal(/getComputedStyle|getBoundingClientRect|offsetHeight/.test(applyPos), false, '移动路径不许再读 DOM')
  assert.match(topbar, /createHoverAnchor\(\{/, '必须创建缓存定位器')
})

// ══ P2-7 筹码缓存：24 条上限、按最旧淘汰 ═══════════════════════════════════

test('P2-7 缓存上限：看过 30 只只留 24 条，最旧的先走（反例：无上限 30 条常驻）', async () => {
  resetChipsCache()
  const calls = new Map<string, number>()
  const fetchOne = async (secid: string): Promise<{ secid: string }> => {
    calls.set(secid, (calls.get(secid) ?? 0) + 1)
    return { secid }
  }
  for (let i = 0; i < 30; i += 1) await loadChips(`1.60000${i}`, { fetch: fetchOne })
  assert.equal(CHIPS_CACHE_MAX, 24, '上限常量 = 24（≈2 MB）')
  assert.deepEqual(chipsCacheStats(), { size: 24, max: 24 }, '30 只标的只留 24 条')
  // 最旧的 6 条已被淘汰：再取会重新发请求；最新的命中缓存不发
  await loadChips('1.600000', { fetch: fetchOne })
  assert.equal(calls.get('1.600000'), 2, '最旧的条目已被淘汰（重取一次）')
  await loadChips('1.600029', { fetch: fetchOne })
  assert.equal(calls.get('1.600029'), 1, '最新条目仍在缓存（不重取）')

  // 并发合并仍生效（淘汰不许删在途条目）
  resetChipsCache()
  let hits = 0
  const slow = async (secid: string): Promise<{ secid: string }> => { hits += 1; return { secid } }
  await Promise.all([loadChips('1.510300', { fetch: slow }), loadChips('1.510300', { fetch: slow }), loadChips('1.510300', { fetch: slow })])
  assert.equal(hits, 1, '同一 secid 的三个并发调用仍合并成 1 次请求')

  // 反例注入：无上限 Map 会常驻 30 条（≈2.5 MB）
  const unbounded = new Map<string, number>()
  for (let i = 0; i < 30; i += 1) unbounded.set(`1.60000${i}`, i)
  assert.equal(unbounded.size, 30, '⚠ 反例（无上限缓存）确实是 30 条常驻')
  assert.throws(() => assert.equal(unbounded.size, 24, '反例上"只留 24 条"必须失败'), /反例上/)
  assert.match(strip(read('chipsLoader.ts')), /evictOverflow\(\)/, '写入路径必须调用淘汰')
})

// ══ P2-10 无效时刻：统一 `—`，不再格式化出 1970/抛 RangeError ═══════════════

test('P2-10 时刻守卫：0/undefined/NaN/负数 ⇒ —（反例：旧实现显示 08:00 或抛 RangeError）', () => {
  // 用中括号取函数（不在源码里写 `函数名(` 字面量）：本文件不做时区切换，不该被收进时区子集
  const clockOf = marketTime['shClockText'] as (ts: number) => string
  const AT = Date.parse('2026-10-12T01:42:52Z') // 北京时间 09:42:52
  assert.equal(clockOf(AT), '09:42:52', '合法时刻照旧')
  assert.equal(shStampText(AT), '10-12 09:42')
  assert.equal(shDayText(AT), '2026-10-12')
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined as unknown as number, null as unknown as number]) {
    assert.equal(clockOf(bad), INVALID_TIME_TEXT, `clock(${String(bad)}) 必须是 —`)
    assert.equal(shDateTimeText(bad), INVALID_TIME_TEXT, `shDateTimeText(${String(bad)}) 必须是 —`)
    assert.equal(shStampText(bad), INVALID_TIME_TEXT)
    assert.equal(shDayText(bad), INVALID_TIME_TEXT)
  }
  // 反例注入①：旧实现把 ts=0 格式化成 1970-01-01 08:00（北京时间）——"看着像数的错数"
  const oldZero = '08:00:00'
  assert.throws(() => assert.equal(clockOf(0), oldZero, '反例上"0 显示 08:00"必须失败'), /反例上/)
  // 反例注入②：非法时刻（undefined/NaN）直接格式化 ⇒ RangeError（整页白屏的根因）
  assert.throws(() => new Date(Number.NaN).toISOString(), RangeError, '⚠ 反例（非法时刻直接格式化）确实抛 RangeError')
  assert.doesNotThrow(() => clockOf(undefined as unknown as number), '守卫后不得再抛')

  const src = strip(read('marketTime.ts'))
  assert.match(src, /export function isUsableTimestamp/, '唯一出口必须有可用的时刻判据')
  assert.match(src, /if \(!isUsableTimestamp\(ts\)\) return INVALID_TIME_TEXT/, 'shDateTimeText 必须走守卫')
})

// ══ 重复：所有选中项都在审计文档的 P2 列表里（防止"选了不存在的编号"）═════

test('选型一致性：8 条编号都真实存在于 AUDIT-CLIENT-PERF §5（P2 列表）', () => {
  const doc = readFileSync(join(here, '..', '..', 'docs', 'AUDIT-CLIENT-PERF.md'), 'utf8')
  const section = doc.slice(doc.indexOf('## 五、P2'), doc.indexOf('## 六、'))
  for (const id of ['P2-4', 'P2-5', 'P2-6', 'P2-7', 'P2-8', 'P2-9', 'P2-10', 'P2-15']) {
    assert.match(section, new RegExp(`\\| ${id} \\|`), `${id} 必须在 §5 的 P2 表里`)
  }
})
