/**
 * `data-idle` 的订阅半区（有 react 依赖，**测试不导入本文件**）。
 *
 * 纯判定在 `idle.ts`（可被 node:test 导入）；这里只做"订阅 document 可见性"这一件事。
 */
import { useEffect, useState } from 'react'
import { documentHiddenNow, panelIdle, panelVisibleOf } from './idle.ts'

/** 订阅页面可见性 ⇒ 是否闲置（不改数据、不触发取数，只让 CSS 停掉动画） */
export function usePageIdle(visible: boolean): boolean {
  const [hidden, setHidden] = useState<boolean>(() => documentHiddenNow())
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const on = (): void => setHidden(documentHiddenNow())
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return panelIdle(visible, hidden)
}

/**
 * 面板真实可见性订阅（P2-4）：文档可见性 + 面板根节点与视口是否相交。
 *
 * 为什么需要它：宿主把面板藏起来时是 `display:none`（组件仍挂着），`document.hidden` 为 false
 * ⇒ 旧的 `visible = true` 常量让行情照打（每 10s）。`IntersectionObserver` 对 `display:none`
 * 的元素会报告 `isIntersecting: false`，正好是需要的信号；观察器不可用时**失败放行**。
 */
export function usePanelVisible(ref: { current: HTMLElement | null }): boolean {
  const [docHidden, setDocHidden] = useState<boolean>(() => documentHiddenNow())
  const [intersecting, setIntersecting] = useState<boolean | null>(null)
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const on = (): void => setDocHidden(documentHiddenNow())
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  useEffect(() => {
    const el = ref.current
    if (el === null || typeof IntersectionObserver === 'undefined') return undefined
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1]
      if (last !== undefined) setIntersecting(last.isIntersecting)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [ref])
  return panelVisibleOf({ documentHidden: docHidden, intersecting })
}
