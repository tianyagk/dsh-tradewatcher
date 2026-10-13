/**
 * 挂载计数（诊断"切页签是否导致重挂载"）。
 *
 * 为什么要有它：上一轮只证明了"请求数 = 1"，但用户看到的仍是"整块刷新"。
 * 请求数不能证明**组件身份**没变 —— 组件被卸载重挂时请求可能命中缓存（看起来没请求），
 * 而内部状态（滑杆位置、折叠状态）已经清零。所以这里同时数**挂载次数**。
 *
 * 读法（浏览器控制台）：`__twMounts()` ⇒ `{ drawer: 1, chips: 1 }`
 * 切 6 次页签后这两个数都应该**保持 1**（不重挂）；若变大，说明有 key/条件渲染把组件重建了。
 */
export interface MountCounts {
  drawer: number
  chips: number
}

const counts: MountCounts = { drawer: 0, chips: 0 }

export function countMount(which: keyof MountCounts): void {
  counts[which] += 1
}

export function mountCounts(): MountCounts {
  return { ...counts }
}

// 挂到全局便于装机后人工复核（无副作用：仅赋值一个函数）
declare const window: { __twMounts?: () => MountCounts } | undefined
if (typeof window !== 'undefined') window.__twMounts = mountCounts
