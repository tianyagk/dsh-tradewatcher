import { shClockText } from './marketTime.ts'
/**
 * 侧栏徽标的文案（纯函数，无 React 依赖）。
 *
 * ## 口径（用户要求，2026-10-16 定）
 *
 * 徽标**只**表示「持仓当日涨跌幅」：短标记 `-2.3%`、带符号、按 `prefs.redUp` 着色
 * （着色在 `theme.ts` 的 `badgeToneColor`）；取不到时给原因、**绝不写 0 冒充**。
 *
 * ## ⚠ 侧栏**标签**恒为「盯盘」（用户 2026-10-16 明确要求：不要后缀）
 *
 * 侧栏条目的标签文本**只有** `盯盘` 两个字 —— 不带 `· 数据 HH:mm:ss`、也不带 `· 已收盘`。
 * 这两类信息**没有丢**，它们的落点：
 *   · 侧栏条目的**悬停 `title`** = 本模块的 `detail`（`当日盈亏 -2.3% · 数据 15:05:56 · 已收盘`）；
 *   · **面板内**本来就有（页面级数据时刻、护盘面板的收盘状态、`来源/降级` 行）。
 * ⇒ 本模块**不再产出**任何"标签专用"的字符串（`BadgeState` 里没有 `stamp` 这种字段），
 *   所以标签不可能被"顺手"加回后缀（结构性防线，与下面删掉 `level` 同一思路）。
 *
 * ## ⚠ 这里**不得**再出现「护」或任何护盘等级文案
 *
 * `level` / `levelLabel` 已从入参里删掉（见 `BadgeInput`）—— 入参里没有等级，
 * 就**不可能**再写出一条"等级优先"的分支，这是结构性的防线，不只是一句注释约定。
 *
 * 为什么删（追因证据见 `docs/AUDIT-IMPL64.md`）：
 *   · `036b1a3`（v0.25.0）引入徽标时带了一条**等级优先分支**：护盘 ≥「疑似护盘」就显示「护」，
 *     **顶掉**当日涨跌幅。用户 2026-10-16 报告"昨天是 `-2.3%`、今天是一个「护」字"，
 *     并明确表示**没有要求过**这个改动。
 *   · 徽标只有 18px、最多 4 个字形。同一个位置承载两种语义（我的盈亏 / 市场的护盘）时，
 *     用户既分不清这个字是"我的"还是"市场的"，也分不清它为什么会变 —— 而"会自己变的角标"
 *     比"没有角标"更糟。
 *   · 护盘等级本来就有自己的位置（护盘面板 + `tradewatcher_rescue` 工具）。要把它放回侧栏
 *     必须**另立入口**并先经用户/Lead 同意，不得占用这个徽标位。
 *
 * ## 文案与长度
 *
 * `detail` 会**直接拼在侧栏的插件名后面**当悬停提示，宽度很窄 ——
 * 一句话长了就被宿主截断成"…"（实测踩过：`盯盘·持仓当日盈亏 +0.07%（+795.00 元…`），
 * 既啰嗦又读不出完整信息。按「开发原则」（README「开发」节第 1、2、6 条）：
 * **悬停提示只留一行、只写"影响什么 + 数据时刻"**，金额这类细节留在面板里（面板宽度够）。
 *
 * 同时区分两种"零"：`dayPnlPct === null` 是**没有持仓行情**（不可算），`0` 是真的零 ——
 * 前者必须写原因，不能显示 `0.00%`。
 */

export interface BadgeState {
  text: string
  /**
   * 徽标颜色键：上涨 / 下跌 / 平静。
   *
   * **没有 `rescue`**：护盘等级不再进徽标（见文件头）；留着这个色键等于给"往徽标里塞护盘"
   * 留一条现成的通道。
   */
  tone: 'up' | 'down' | 'flat'
  /**
   * 悬停提示（`title`）：**只留一行**，当日盈亏 + `· 数据 HH:mm:ss[ · 已收盘]`。
   *
   * 注意这里是**侧栏条目唯一的**数据时刻/收盘状态出口（标签恒为「盯盘」，见文件头）；
   * 长度上限 `BADGE_DETAIL_MAX` 就是为它设的。
   */
  detail: string
}

/**
 * 徽标取值需要的最小字段集（结构类型，便于测试构造，不依赖 api 模块）。
 *
 * 曾经的 `level` / `levelLabel`（护盘等级）随「护」分支一起删除（2026-10-16，见文件头）。
 * `GET /tradewatcher/badge` 的回包**仍然**带这两个字段（宿主契约不变、别的消费方要用），
 * 多出来的字段在这里被忽略 —— 客户端不读它，就画不出它。
 */
export interface BadgeInput {
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

/**
 * 徽标视图。
 *
 * 分档顺序（**只有这些**，没有等级分支）：隐身视图 → 不可算 → 零 → 带符号涨跌幅。
 * 顺序本身是契约：`masked` 必须在盈亏之前（隐身档不许出现盈亏数字），
 * `null`（不可算）必须在 `0` 之前（否则"算不出"会被说成"今天没赚没亏"）。
 */
export function badgeView(b: BadgeInput, masked: boolean): BadgeState {
  // R5：数据时刻固定北京时间（旧实现按浏览器时区渲染：UTC 下显示 01:42 而非 09:42）
  const asOfText = b.asOf === null ? '—' : shClockText(b.asOf)
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
    return { text: '0.0%', tone: 'flat', detail: `当日盈亏 0.0%${tail(asOfText, b.settled)}` }
  }
  const pct = b.dayPnlPct
  const sign = pct > 0 ? '+' : '-'
  const mag = Math.abs(pct)
  return {
    // 徽标与 tooltip **同口径同舍入**（一位小数 + %）：徽标 `-2.3%`、tooltip 也 `-2.3%`
    text: `${sign}${mag >= 10 ? '10+' : mag.toFixed(1)}%`,
    tone: pct > 0 ? 'up' : 'down',
    detail: `当日盈亏 ${sign}${mag >= 10 ? '10+' : mag.toFixed(1)}%${tail(asOfText, b.settled)}`,
  }
}
