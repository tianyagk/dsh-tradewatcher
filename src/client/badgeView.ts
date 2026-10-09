/**
 * 侧栏徽标的文案（纯函数，无 React 依赖）。
 *
 * 为什么单独成模块：这段文字会**直接拼在侧栏的插件名后面**当悬停提示，宽度很窄 ——
 * 一句话长了就被宿主截断成"…"（实测踩过：`盯盘·持仓当日盈亏 +0.07%（+795.00 元…`），
 * 既啰嗦又读不出完整信息。按「开发原则」（README「开发」节第 1、2、6 条）：
 * **悬停提示只留一行、只写"影响什么 + 数据时刻"**，金额这类细节留在面板里（面板宽度够）。
 *
 * 同时区分两种"零"：`dayPnlPct === null` 是**没有持仓行情**（不可算），`0` 是真的零 ——
 * 前者必须写原因，不能显示 `0.00%`。
 */

export interface BadgeState {
  text: string
  /** 徽标颜色键：rescue 等级 / 上涨 / 下跌 / 平静 */
  tone: 'rescue' | 'up' | 'down' | 'flat'
  /** 悬停提示：**只留一行**，拼在侧栏插件名之后 */
  detail: string
}

/** 徽标取值需要的最小字段集（结构类型，便于测试构造，不依赖 api 模块） */
export interface BadgeInput {
  level: number
  levelLabel: string | null
  indexPoint: number | null
  indexName: string | null
  /** 持仓当日盈亏率；`null` = 没有持仓行情（不可算） */
  dayPnlPct: number | null
  dayPnl: number
  asOf: number | null
  settled: boolean
}

/** 悬停提示的长度上限（超出会被宿主截断成"…"，等于没写） */
export const BADGE_DETAIL_MAX = 32

function tail(asOfText: string, settled: boolean): string {
  return ` · 数据 ${asOfText}${settled ? ' · 已收盘' : ''}`
}

export function badgeView(b: BadgeInput, masked: boolean): BadgeState {
  const asOfText = b.asOf === null ? '—' : new Date(b.asOf).toLocaleTimeString('zh-CN', { hour12: false })
  // 护盘 ≥ 疑似护盘（level ≥ 2）优先：那是"今天市场有事"的信号，比个人盈亏更该被看到
  if (b.level >= 2) {
    return { text: '护', tone: 'rescue', detail: `护盘信号：${b.levelLabel ?? '—'}${tail(asOfText, b.settled)}` }
  }
  if (masked) {
    const point = b.indexPoint === null ? null : Math.round(b.indexPoint)
    return {
      text: point === null ? '••' : String(point).slice(0, 4),
      tone: 'flat',
      detail: `隐身视图 · 点位 ${point ?? '—'}${tail(asOfText, b.settled)}`,
    }
  }
  if (b.dayPnlPct === null) {
    // 不可算：给短原因，绝不写 0.00%（那是另一条信息）
    return { text: '', tone: 'flat', detail: '当日盈亏 —（无持仓行情）' }
  }
  if (b.dayPnlPct === 0) {
    return { text: '0.0', tone: 'flat', detail: `当日盈亏 0.00%${tail(asOfText, b.settled)}` }
  }
  const pct = b.dayPnlPct
  const sign = pct > 0 ? '+' : '-'
  const mag = Math.abs(pct)
  return {
    text: `${sign}${mag >= 10 ? '10+' : mag.toFixed(1)}`,
    tone: pct > 0 ? 'up' : 'down',
    detail: `当日盈亏 ${sign}${mag.toFixed(2)}%${tail(asOfText, b.settled)}`,
  }
}
