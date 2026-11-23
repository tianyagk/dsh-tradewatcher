/**
 * 一帧一次的提交批处理（AUDIT-CLIENT-PERF P2-8）。
 *
 * 症状：`useMiniTrends` 用 4 并发池逐行拉缩略图，每拿到一行就 `setData` 一次
 * （最多 80 行 ⇒ 最多 80 次状态提交 / 80 次整页重渲染，而全仓没有 memo 边界）。
 *
 * 修法：行结果先塞进一个 `Map`，同一帧内只提交**一次**（`setData` 里合并全部增量）。
 * 语义不变（同 key 后者覆盖前者），只是把 N 次提交压成 1 次。
 *
 * 调度器可注入：生产走 `requestAnimationFrame`（掉帧时自然合并更多），
 * node:test 用假调度器断言「同帧 80 行 ⇒ 1 次 apply」。
 */

export interface FrameBatch<T> {
  /** 记一条增量（同 key 覆盖）；本帧还没排程就排一次 */
  push: (key: string, value: T) => void
  /** 立即提交（测试用；生产由调度器触发） */
  flush: () => void
  /** 丢弃未提交的增量（卸载时用，避免向已卸载组件写状态） */
  dispose: () => void
  /** 还没提交的条数（断言用） */
  pending: () => number
}

/** 调度器返回"取消本次调度"的函数（拿不到可取消句柄时返回空函数） */
export type FrameSchedule = (cb: () => void) => () => void

const defaultSchedule: FrameSchedule = (cb) => {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(cb)
    return () => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
    }
  }
  queueMicrotask(cb)
  return () => undefined
}

export function createFrameBatch<T>(
  apply: (merged: Map<string, T>) => void,
  schedule: FrameSchedule = defaultSchedule,
): FrameBatch<T> {
  let pending = new Map<string, T>()
  let cancelScheduled: (() => void) | null = null
  let scheduled = false

  const cancelPending = (): void => {
    if (scheduled && cancelScheduled !== null) cancelScheduled()
    cancelScheduled = null
    scheduled = false
  }

  const flush = (): void => {
    scheduled = false
    cancelScheduled = null
    if (pending.size === 0) return
    const merged = pending
    pending = new Map()
    apply(merged)
  }

  return {
    push(key, value) {
      pending.set(key, value)
      if (scheduled) return
      scheduled = true
      cancelScheduled = schedule(flush)
    },
    flush,
    dispose() {
      pending = new Map()
      cancelPending()
    },
    pending: () => pending.size,
  }
}
