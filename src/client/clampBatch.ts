/**
 * 决策流文本块（`FlowTextView`）的「是否超过 3 行」测量批处理（AUDIT-CLIENT-PERF P2-5）。
 *
 * 旧实现（审计原文）：**每个文本块一个 `ResizeObserver` + 一次 `useLayoutEffect` 里的同步测量**
 * （加 `is-clamp` → 读 `scrollHeight` → 去 `is-clamp`）。60 条 × 3 段 ⇒ 最多 180 个观察者、
 * 180 次强制布局，而且「写 class → 读高度」交替进行，每次读都要重新布局一遍。
 *
 * 现在两件事一起做：
 *   ① **一个** `ResizeObserver` 观察所有文本块（观察者数量 180 → 1）；
 *   ② 测量合并成**一批**：先给所有待测块加 class（写阶段），再统一读 `scrollHeight`（读阶段），
 *      最后统一去 class（写阶段）—— 一次强制布局覆盖整批（180 → 1），
 *      并把结果相同的 `setOverflow` 调用省掉（不触发无意义的重渲染）。
 *
 * 为什么用微任务而不是 rAF：`useLayoutEffect` 里登记后，微任务在**浏览器绘制之前**执行，
 * 于是首帧仍然是「已经夹好 3 行」的样子 —— 不会出现一帧未夹行的长文（视觉规格不变）。
 *
 * 纯逻辑（可注入 observer/scheduler）放在这里，React 组件只负责 `watch/unwatch`。
 */

/** 测量只需要这三样（用结构类型而不是 `HTMLElement`，node:test 里可以喂假节点） */
export interface ClampNode {
  classList: {
    contains: (token: string) => boolean
    add: (token: string) => void
    remove: (token: string) => void
  }
  scrollHeight: number
  clientHeight: number
}

export interface ClampObserver {
  observe: (el: ClampNode) => void
  unobserve: (el: ClampNode) => void
  disconnect: () => void
}

export interface ClampBatchDeps {
  /** 调度一次批测量（默认 `queueMicrotask`：绘制前跑完） */
  schedule?: (cb: () => void) => void
  /** 共用的观察者工厂（默认懒建一个 `ResizeObserver`；返回 null = 环境不支持） */
  createObserver?: (onResize: () => void) => ClampObserver | null
  /** 补测调度（默认下一帧；测试可同步）—— 供"隐藏时测不到"的块在排版完成后重测 */
  nextFrame?: (cb: () => void) => void
}

export interface ClampBatchStats {
  /** 创建过几个观察者（生产应为 1；卸载全部后重建会 +1） */
  observers: number
  /** 跑过几批（每批最多一次强制布局） */
  batches: number
  /** 累计测量过几个元素（批内逐个读 scrollHeight） */
  measurements: number
}

export interface ClampBatcher {
  /** 登记一个文本块；返回取消登记（组件卸载/文本变化时调用） */
  watch: (el: ClampNode, onOverflow: (overflow: boolean) => void) => () => void
  /** 立即跑一批（测试用；生产由 scheduler/观察者触发） */
  flush: () => void
  stats: () => ClampBatchStats
}

/**
 * 展开态下**不得**把 overflow 改回 false。
 *
 * 事故形态（用户报「展开闪烁」）：点「展开」→ 文本撑开 → ResizeObserver 触发 → 批测量在未夹行状态下量到
 * `scrollHeight === clientHeight` ⇒ 判定"不溢出" ⇒ `setOverflow(false)` ⇒ 「收起」按钮消失、卡片跳一下，
 * 下一次渲染又按 overflow 决定夹行 —— 看起来就是闪一下。
 *
 * 口径：`open === true` 时保持上一次的 overflow（按钮与全文都在）；收起后由下一次测量重新决定。
 */
export function clampOverflowApply(open: boolean, measured: boolean, prev: boolean): boolean {
  return open ? prev : measured
}

/** 视觉层夹行的 class（与 `styles.ts` 的 `.tw-ad-verdict .vt .v.is-clamp` 同名） */
const CLAMP_CLASS = 'is-clamp'

/**
 * 判定「真实溢出 3 行」：必须在**未夹行**状态下量，所以调用方负责临时加/去 class。
 * `+1` 是亚像素容差（与旧实现一致，不改判据）。
 */
export function clampOverflowOf(el: Pick<ClampNode, 'scrollHeight' | 'clientHeight'>): boolean {
  return el.scrollHeight > el.clientHeight + 1
}

interface Entry {
  el: ClampNode
  onChange: (overflow: boolean) => void
  /** 上一次上报的值（null = 还没测过） */
  last: boolean | null
}

export function createClampBatcher(deps: ClampBatchDeps = {}): ClampBatcher {
  const entries = new Map<ClampNode, Entry>()
  const dirty = new Set<Entry>()
  const schedule = deps.schedule ?? ((cb: () => void): void => { queueMicrotask(cb) })
  let observer: ClampObserver | null = null
  let scheduled = false
  let retryScheduled = false
  const stats: ClampBatchStats = { observers: 0, batches: 0, measurements: 0 }

  const flush = (): void => {
    scheduled = false
    stats.batches += 1
    // 已卸载的块（cleanup 早于本批）不测
    const batch = [...dirty].filter((e) => entries.get(e.el) === e)
    dirty.clear()
    if (batch.length === 0) return
    const added: Entry[] = []
    // 写阶段①：一次性给整批加 class（不读，不会触发布局）
    for (const e of batch) {
      if (!e.el.classList.contains(CLAMP_CLASS)) {
        e.el.classList.add(CLAMP_CLASS)
        added.push(e)
      }
    }
    // 读阶段：所有写已落地，整批只强制一次布局
    // `null` = 这一块此刻没有布局（`display:none` 的保活页 / 刚挂载还没排版）⇒ **不上报**，
    // 否则会把"0 高"当成"不溢出"，等页面真正显示时按钮已经不出现了（实机复现：切到棱镜后无「展开」）。
    let deferred = false
    const results: Array<boolean | null> = []
    for (const e of batch) {
      stats.measurements += 1
      results.push(e.el.clientHeight <= 0 ? null : clampOverflowOf(e.el))
    }
    // 写阶段②：还原 class
    for (const e of added) e.el.classList.remove(CLAMP_CLASS)
    // 上报（值没变就不 setState：省掉无意义的重渲染）
    for (let i = 0; i < batch.length; i += 1) {
      const e = batch[i]!
      const next = results[i]
      if (next === null || next === undefined) { dirty.add(e); deferred = true; continue }
      if (e.last === next) continue
      e.last = next
      e.onChange(next)
    }
    // 有块此刻没有布局（隐藏页/刚挂载）：下一帧补测一次，不能等 ResizeObserver（它可能不再触发）
    if (deferred && !retryScheduled) {
      retryScheduled = true
      const run = (): void => { retryScheduled = false; scheduleFlush() }
      const nextFrame = deps.nextFrame ?? ((cb: () => void): void => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => cb())
        else setTimeout(cb, 16)
      })
      nextFrame(run)
    }
  }

  const scheduleFlush = (): void => {
    if (scheduled) return
    scheduled = true
    schedule(flush)
  }

  const markAll = (): void => {
    for (const e of entries.values()) dirty.add(e)
    scheduleFlush()
  }

  const ensureObserver = (): ClampObserver | null => {
    if (observer !== null) return observer
    const factory = deps.createObserver ?? ((onResize: () => void): ClampObserver | null => {
      if (typeof ResizeObserver === 'undefined') return null
      const ro = new ResizeObserver(() => { onResize() })
      return {
        observe: (el) => { ro.observe(el as unknown as Element) },
        unobserve: (el) => { ro.unobserve(el as unknown as Element) },
        disconnect: () => { ro.disconnect() },
      }
    })
    observer = factory(markAll)
    if (observer !== null) stats.observers += 1
    return observer
  }

  return {
    watch(el, onOverflow) {
      const entry: Entry = { el, onChange: onOverflow, last: null }
      entries.set(el, entry)
      dirty.add(entry)
      ensureObserver()?.observe(el)
      scheduleFlush()
      return () => {
        // 同一个 el 可能已被新一次 effect 重新登记（文本变化）：只清自己这一条
        if (entries.get(el) !== entry) return
        entries.delete(el)
        dirty.delete(entry)
        observer?.unobserve(el)
        if (entries.size === 0) {
          observer?.disconnect()
          observer = null
        }
      }
    },
    flush,
    stats: () => ({ ...stats }),
  }
}

/**
 * 生产用单例：整页（含多个 `FlowTextView` 与其它夹行块）共用**一个**观察者。
 * 页面卸载后最后一个 `watch` 的 cleanup 会 disconnect；下次进入棱镜时按需重建。
 */
export const clampBatcher = createClampBatcher()
