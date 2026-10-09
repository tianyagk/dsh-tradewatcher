/**
 * 宽窄布局 hook（唯一职责：订阅断点，把判定交给纯函数 `layoutModeOf`）。
 *
 * 用 `matchMedia` 而不是自己听 resize：浏览器只在该查询跨过阈值时回调，不必每次 resize 都 setState。
 * 拿不到 `matchMedia`（老环境/测试）时按**窄**处理 —— 窄布局用的是始终可用的段控，失败方向安全。
 */
import { useEffect, useState } from 'react'
import { WIDE_MEDIA_QUERY, pickSortEntry, type SortEntry } from './wide.ts'

function queryNow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(WIDE_MEDIA_QUERY).matches
}

export function useWideLayout(): boolean {
  const [wide, setWide] = useState<boolean>(() => queryNow())

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(WIDE_MEDIA_QUERY)
    const apply = (): void => setWide(mq.matches)
    apply()
    // Safari < 14 只有 addListener/removeListener，两个入口都接上（可用性优先）
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
    mq.addListener(apply)
    return () => mq.removeListener(apply)
  }, [])

  return wide
}

/**
 * 排序入口（P1-4）：宽屏先量一次列头是否**真的可见**（`display !== 'none'`），再决定挂哪个。
 *
 * 量不到（文档里没有列头 / 拿不到计算样式）时按"用段控"处理 —— 段控始终可用，
 * 于是"排序功能整块消失"在结构上不可能。
 */
export function useSortEntry(wide: boolean): SortEntry {
  const [headerVisible, setHeaderVisible] = useState<boolean | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    const read = (): void => {
      const el = document.querySelector('.tw-sorthead')
      if (el === null) {
        setHeaderVisible(null)
        return
      }
      const style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(el) : null
      setHeaderVisible(style === null ? null : style.display !== 'none')
    }
    read()
    window.addEventListener('resize', read)
    return () => window.removeEventListener('resize', read)
  }, [wide])

  return pickSortEntry({ wide, headerVisible })
}
