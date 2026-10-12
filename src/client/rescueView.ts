/**
 * 【护盘信号】的纯视图逻辑（不 import react ⇒ 能在 node 里直接断言）。
 */

/**
 * 【护盘信号】熔断/备用源提示的**紧凑形式**（task-14 ③）。
 *
 * 用户要求：那条长句（`东财行情主机 3/3 台熔断 · 最早约 1 分钟可重试（全部恢复 14 分钟）—— 当前快照已由腾讯备用源兜底：…`）
 * 不再常驻；**但降级事实不许丢** ⇒ 常驻只留一个紧凑标记（如「备用源」），完整原因进 `title`/`aria-label`。
 *
 * 返回三段：`marker`（常驻可见，≤6 字）、`reason`（完整那句，进 title/aria）、`tone`（是否备用源降级）。
 */
export function breakerBadgeOf(input: {
  openHosts: number
  hosts: number
  allOpen: boolean
  minutesLeft: number
  allMinutesLeft: number
  closed: boolean
  flowSource: string | null | undefined
  stale: boolean
  fallback: unknown
}): { marker: string; reason: string; fromAlt: boolean } {
  const fromAlt = input.flowSource === 'tencent'
  const head = input.closed
    ? `东财行情主机 ${input.openHosts}/${input.hosts} 台熔断${input.allOpen ? '（全部）' : ''} · 下次开盘自动重试`
    : `东财行情主机 ${input.openHosts}/${input.hosts} 台熔断 · 最早约 ${input.minutesLeft} 分钟可重试${
        input.allMinutesLeft > input.minutesLeft ? `（全部恢复 ${input.allMinutesLeft} 分钟）` : ''
      }`
  const impact = fromAlt
    ? '当前快照已由腾讯备用源兜底：价格、量能、脉冲、背离可用；超大单强度与持续性无法计算（该源无分单资金流）'
    : input.stale === true || input.fallback !== undefined
      ? '当前显示上次成功采样/当日复盘数据'
      // 来源未知时（例如客户端已刷新、宿主未重启）不猜测取自哪个源，只陈述可核对的事实
      : '当前快照取自最近一次成功采样（数据时刻见上方「数据」）'
  // 常驻可见只留最短的标记：能一眼看出"现在是降级在跑"，细节全在 title/aria
  const marker = fromAlt ? '备用源' : `熔断 ${input.openHosts}/${input.hosts}`
  return { marker, reason: `${head} —— ${impact}`, fromAlt }
}
