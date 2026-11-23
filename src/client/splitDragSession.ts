/**
 * 抽屉分割线的拖拽会话（AUDIT-CLIENT-PERF P2-9）。
 *
 * 症状：`QuoteDrawer` 的分割线每次 `mousemove` 都 `setDragRatio` —— 整抽屉
 * （240 根 K 线 + 筹码 SVG + 账单）跟着重渲染；`window` 上的 move/up 监听只在 `mouseup`
 * 里移除，**拖拽过程中组件卸载**（切标的/关抽屉）会把闭包与监听留在 `window` 上（一次性泄漏）。
 *
 * 这里把「拖拽期间只挪线」的语义收进一个可注入 rAF 的会话对象：
 *   · 同一帧内多次移动 ⇒ 最多 1 次预览提交，落**最后一次**（不改变跟手观感）；
 *   · `up` ⇒ 取消未落地的预览、用最终坐标提交一次；
 *   · `cancel` ⇒ 丢弃预览、不提交（卸载/中断用）。
 *
 * 监听器的注册/移除仍在组件里（它依赖 `window`），但 cleanup 由 `useEffect` 兜底。
 */
import { createRafCoalescer } from './rafThrottle.ts'
import { splitDragRatio } from './splitDrag.ts'

export interface SplitDragSessionDeps {
  startRatio: number
  startY: number
  /** 可用高度（px）；<=0 时比例不变（与 `splitDragRatio` 同一口径） */
  available: number
  /** 拖拽中的预览（只挪线，不重建图表） */
  preview: (ratio: number) => void
  /** 松手提交（重建图表一次） */
  commit: (ratio: number) => void
  raf?: (cb: () => void) => number
  caf?: (id: number) => void
}

export interface SplitDragSession {
  move: (y: number) => void
  up: (y: number) => void
  cancel: () => void
  /** 已提交的预览次数（断言用） */
  previews: () => number
}

export function createSplitDragSession(deps: SplitDragSessionDeps): SplitDragSession {
  let previews = 0
  const coalescer = createRafCoalescer<number>((ratio) => {
    previews += 1
    deps.preview(ratio)
  }, deps.raf, deps.caf)
  const ratioAt = (y: number): number => splitDragRatio(deps.startRatio, deps.startY, y, deps.available)
  return {
    move(y) {
      coalescer.push(ratioAt(y))
    },
    up(y) {
      // 未落地的预览作废：松手只提交一次最终值（否则会先闪一下旧预览再重绘）
      coalescer.cancel()
      deps.commit(ratioAt(y))
    },
    cancel() {
      coalescer.cancel()
    },
    previews: () => previews,
  }
}
