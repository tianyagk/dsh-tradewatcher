/**
 * 切页签时的图表帧决策（纯函数）。
 *
 * 用户两次反馈"切页签整个侧栏在刷新"：根因是切页签会把 payload 清空 ⇒ 图表区换成整块骨架。
 * 现在的规则：
 *  - **首帧**（还没有任何上一张图）⇒ 允许骨架；
 *  - **切到新页签但旧图还在** ⇒ 继续渲染旧图（最后一帧）+ 叠一层半透明加载态 ⇒ 不闪、不跳；
 *  - 新数据到了（`payloadTab === tab`）⇒ 正常渲染、无叠加。
 */
export type ChartFrameState = 'fresh' | 'stale' | 'first'

export interface ChartFrame {
  state: ChartFrameState
  /** 是否绘制"上一张图 + 加载态"（旧图仍在，不是骨架） */
  overlay: boolean
  /** 是否只能给骨架（首帧 / 真的没有旧图） */
  skeleton: boolean
}

export function chartFrameOf(input: { hasPayload: boolean; payloadTab: string; tab: string }): ChartFrame {
  if (!input.hasPayload) return { state: 'first', overlay: false, skeleton: true }
  if (input.payloadTab !== input.tab) return { state: 'stale', overlay: true, skeleton: false }
  return { state: 'fresh', overlay: false, skeleton: false }
}
