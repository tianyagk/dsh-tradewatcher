/**
 * rAF 合并（P2-10）：同一帧内的多次更新只落**最后一次**。
 *
 * 症状（评审 §P2-10，推断）：K 线/分时的 `onMouseMove` 直接 `setCursor(...)` ⇒ 每次
 * mousemove 都会把整张 SVG（240 根柱 + 均线 + MACD + 游标）全量重渲染；窗口拉满时可能掉帧。
 * 修法：把"要渲染的游标"按帧合并（每帧最多一次 setState），**不改变几何与交互语义**。
 *
 * `raf/caf` 可注入（node 里用假调度器单测），生产走全局 `requestAnimationFrame`。
 */
export interface RafCoalescer<T> {
  /** 记下最新值；本帧还没排程就排一次 */
  push: (value: T) => void
  /** 取消未落地的这一帧（卸载/鼠标离开时用，避免向已卸载组件 setState） */
  cancel: () => void
  /** 是否还有未落地的更新（断言用） */
  pending: () => boolean
}

export function createRafCoalescer<T>(
  apply: (value: T) => void,
  raf: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  caf: (id: number) => void = (id) => cancelAnimationFrame(id),
): RafCoalescer<T> {
  let pendingId: number | null = null
  let latest: { value: T } | null = null
  const flush = (): void => {
    pendingId = null
    const v = latest
    latest = null
    if (v !== null) apply(v.value)
  }
  return {
    push: (value) => {
      latest = { value }
      if (pendingId === null) pendingId = raf(flush)
    },
    cancel: () => {
      if (pendingId !== null) caf(pendingId)
      pendingId = null
      latest = null
    },
    pending: () => pendingId !== null,
  }
}
