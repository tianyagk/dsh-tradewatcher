/**
 * 浮层层级栈（P2-5）：**Esc 只关最上面一层**。
 *
 * 症状：`Modal` / `MoreMenu` / `QuoteDrawer` 各自在 `window` 上监听 `Escape` ⇒ 两层叠开时
 * 一次 Esc 全关（用户丢掉的是"我正填到一半的弹窗"）。这里用一个模块级栈记录挂载顺序，
 * 只有栈顶那一层响应 Esc；其余层在自己的 `isTop` 为 false 时直接忽略。
 *
 * 纯函数式（可单测）：不依赖 react、不读 DOM。
 */
export interface OverlayStack {
  /** 压入一层（返回该层的 id） */
  push: (id: string) => void
  /** 移除（关闭时调用；不存在也不报错 —— 卸载顺序不保证） */
  remove: (id: string) => void
  /** 栈顶 id（空栈 ⇒ null） */
  top: () => string | null
  /** 当前层数（断言用，也便于调试） */
  depth: () => number
  /** 是否是栈顶（决定这一层要不要处理 Esc） */
  isTop: (id: string) => boolean
}

export function createOverlayStack(): OverlayStack {
  const ids: string[] = []
  return {
    push: (id) => {
      // 同一 id 重复 push（热重载/重复挂载）⇒ 先去掉旧的，避免"自己叠自己"
      const at = ids.indexOf(id)
      if (at >= 0) ids.splice(at, 1)
      ids.push(id)
    },
    remove: (id) => {
      const at = ids.indexOf(id)
      if (at >= 0) ids.splice(at, 1)
    },
    top: () => (ids.length === 0 ? null : (ids[ids.length - 1] as string)),
    depth: () => ids.length,
    isTop: (id) => ids.length > 0 && ids[ids.length - 1] === id,
  }
}
