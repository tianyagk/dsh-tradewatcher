/**
 * 周期性"现在"（用于重算行情卡片的 `now - at` 新鲜度）。
 *
 * 单独一个文件而不是放在 quoteState.ts 里：那个模块是**纯函数**（可被 node:test 直接
 * 导入、不依赖 React），而本文件需要 React。混在一起会让纯逻辑的测试必须装 React。
 */
import { useEffect, useState } from 'react'

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), Math.max(1000, intervalMs))
    return () => window.clearInterval(t)
  }, [intervalMs])
  return now
}
