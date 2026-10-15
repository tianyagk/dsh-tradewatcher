/**
 * `data-idle` 的订阅半区（有 react 依赖，**测试不导入本文件**）。
 *
 * 纯判定在 `idle.ts`（可被 node:test 导入）；这里只做"订阅 document 可见性"这一件事。
 */
import { useEffect, useState } from 'react'
import { documentHiddenNow, panelIdle } from './idle.ts'

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
