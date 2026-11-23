/**
 * 棱镜静默刷新的放行判据（AUDIT-CLIENT-PERF P1-1）。
 *
 * 症状：棱镜是**保活页**（`index.tsx` 的 `KEEP_ALIVE`），切到自选/持仓后仍在每 30s 拉一次
 * `/tradewatcher/prism`；旧的守卫只判 `document.visibilityState === 'hidden'`，而宿主切页签是
 * `display:none` —— 文档一直是 visible，守卫形同虚设。`PrismPage` 收了 `active` 却全文没用。
 *
 * 修法：放行条件收成一条纯函数（`active === true` **且** 文档未隐藏），定时器每拍只问它一次；
 * 未激活时**根本不建 interval**（在 `PrismPage` 的 effect 里），切回由 `activate()` 立即补刷一次。
 *
 * 纯函数 + 可注入 `refresh` ⇒ node:test 能用假 api 数调用次数（不用装 DOM）。
 */

export interface PrismRefreshGate {
  /** 本页是否"当前页"：父级 `active`；父级不传时由"页面容器在视口内"推出 */
  active: boolean
  /** 整页是否被切到后台（`document.visibilityState === 'hidden'`） */
  documentHidden: boolean
}

/** 现在能不能刷：**本页是当前页** 且 文档可见。任一不满足就不发请求。 */
export function prismRefreshAllowed(gate: PrismRefreshGate): boolean {
  return gate.active === true && gate.documentHidden !== true
}

export interface PrismRefresher {
  /** 定时器每拍：放行才发；返回本次是否真的发了请求（断言与排障用） */
  tick: () => boolean
  /** 激活 / 文档重新可见时调用：同样先判放行，放行则立刻刷一次 */
  activate: () => boolean
}

/**
 * 定时器驱动（很薄的壳）：把"该不该刷"与"怎么刷"分开，`PrismPage` 的 effect 只负责建/清定时器。
 * `refresh` 是注入的（测试里是计数的假 api）。
 */
export function createPrismRefresher(input: {
  read: () => PrismRefreshGate
  refresh: () => void
}): PrismRefresher {
  const once = (): boolean => {
    if (!prismRefreshAllowed(input.read())) return false
    input.refresh()
    return true
  }
  return { tick: once, activate: once }
}
