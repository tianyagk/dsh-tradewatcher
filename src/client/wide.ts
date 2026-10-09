/**
 * 断点值必须与 `styles.ts` 的多列网格（`.tw-wlist`/`.tw-poslist` 的 `columns:520px` 生效阈值）
 */
export const WIDE_MIN_PX = 1080

/** 与断点同源，避免两处各写一个数字 */
export const WIDE_MEDIA_QUERY = `(min-width:${WIDE_MIN_PX}px)`

/** 是否属于宽布局。非有限值一律按窄处理（窄布局用的是**始终可用**的段控，失败方向安全） */
export function isWideWidth(width: number | null | undefined): boolean {
  return typeof width === 'number' && Number.isFinite(width) && width >= WIDE_MIN_PX
}

export type LayoutMode = 'wide' | 'narrow'

/** 布局档位：判定不出宽度时返回 `narrow`（= 保留段控，任何情况下都有一个排序入口） */
export function layoutModeOf(width: number | null | undefined): LayoutMode {
  return isWideWidth(width) ? 'wide' : 'narrow'
}

