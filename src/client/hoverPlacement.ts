/**
 * TopBar 悬浮卡的定位计算（AUDIT-CLIENT-PERF P2-15）。
 *
 * 症状：`applyPos()` 在**每次 mousemove** 都重新遍历全部 overflow 祖先、逐个
 * `getComputedStyle` + `getBoundingClientRect`，再写 `style.left/top`（读写交替）。
 * 面板嵌 10+ 层时单次约 1ms，悬浮卡打开期间鼠标一动就是一次强制样式/布局计算。
 *
 * 修法：**裁剪区与宿主矩形在悬浮卡打开时算一次**（内容尺寸变化时刷新），移动时只做
 * 加减法与夹紧，然后写 `left/top`。`placeHoverCard` 是纯几何（翻转 + 夹紧），可单测。
 *
 * 工具函数都放在这里（不 import React），`TopBar` 只负责取值与写 style。
 */

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface HoverPoint {
  left: number
  top: number
}

/** 视口 ∩ 所有 overflow 祖先（宽/高 <= 0 的矩形视为没有裁剪力，与旧实现一致） */
export function intersectClip(viewport: Rect, rects: readonly Rect[]): Rect {
  let cl = viewport.left
  let ct = viewport.top
  let cr = viewport.right
  let cb = viewport.bottom
  for (const r of rects) {
    if (r.right > r.left && r.bottom > r.top) {
      cl = Math.max(cl, r.left)
      ct = Math.max(ct, r.top)
      cr = Math.min(cr, r.right)
      cb = Math.min(cb, r.bottom)
    }
  }
  return { left: cl, top: ct, right: cr, bottom: cb }
}

/**
 * 悬浮卡落点（相对宿主左上角）：默认在光标右下；右侧放不下翻到左侧、下方放不下翻到上方，
 * 最后夹紧到裁剪区内。常量与旧实现逐字一致（14/12/18/12/8），只是不再每次读 DOM。
 */
export function placeHoverCard(x: number, y: number, host: Rect, clip: Rect, width: number, height: number): HoverPoint {
  let left = x + 14
  if (left + width + 8 > clip.right) left = x - width - 12
  left = Math.min(Math.max(clip.left + 8, left), Math.max(clip.left + 8, clip.right - width - 8))
  let top = y + 18
  if (top + height + 8 > clip.bottom) top = y - height - 12
  top = Math.min(Math.max(clip.top + 8, top), Math.max(clip.top + 8, clip.bottom - height - 8))
  return { left: left - host.left, top: top - host.top }
}

export interface HoverAnchorDeps {
  readHost: () => Rect
  readClip: () => Rect
  /** 悬浮卡高度（`Math.max(offsetHeight, 240)` 由调用方给） */
  readHeight: () => number
}

export interface HoverAnchor {
  /** 重新采样宿主矩形 / 裁剪区 / 卡片高度（打开、内容尺寸变化时调用） */
  refresh: () => void
  place: (x: number, y: number, width: number) => HoverPoint
  /** 每个采样源被真正读了几次（断言用：移动 20 次也只该读 1 次） */
  reads: () => { host: number; clip: number; height: number }
}

/**
 * 缓存型定位器：`place()` 只用缓存值做算术；缓存缺失（悬浮卡刚打开、effect 还没跑）
 * 时惰性采样一次。这样「移动」路径上没有任何 `getComputedStyle`/`getBoundingClientRect`。
 */
export function createHoverAnchor(deps: HoverAnchorDeps): HoverAnchor {
  let host: Rect | null = null
  let clip: Rect | null = null
  let height = 240
  const reads = { host: 0, clip: 0, height: 0 }
  const refresh = (): void => {
    host = deps.readHost()
    clip = deps.readClip()
    height = Math.max(deps.readHeight(), 240)
    reads.host += 1
    reads.clip += 1
    reads.height += 1
  }
  return {
    refresh,
    place(x, y, width) {
      if (host === null || clip === null) refresh()
      return placeHoverCard(x, y, host as Rect, clip as Rect, width, height)
    },
    reads: () => ({ ...reads }),
  }
}
