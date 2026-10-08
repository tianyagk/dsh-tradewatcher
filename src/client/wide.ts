/**
 * 宽窄布局的判定（纯函数，无 React 依赖）。
 *
 * 为什么要有这个模块：v0.30.0 的列头排序与分段开关此前是**两个都渲染、靠一条 CSS 隐藏其中一个**
 * （`.tw-root [data-wide-hide=1]{display:none !important}`）。实测出现了两者同时可见的情况 ——
 * 只要那条选择器链的任何一环失配（祖先类名、媒体查询、内联样式优先级），用户就会看到两套排序控件
 * 各说一套。**"靠 CSS 藏起来"不是互斥，只是看起来互斥**。
 *
 * 现在改为：由这里判定当前该用哪个控件，**只挂那一个**。于是"两个控件同时出现"在结构上不可能，
 * CSS 里那条隐藏规则退化为兜底（保留，但不再是唯一防线）。
 *
 * 断点值必须与 `styles.ts` 的多列网格（`.tw-wlist`/`.tw-poslist` 的 `columns:520px` 生效阈值）
 * 和列头样式保持一致 —— 不一致会出现"列头没挂但段控被藏"这种最坏情况。
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
