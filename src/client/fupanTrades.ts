/**
 * 复盘页「当日交易」的**纯逻辑**：月历标记、当日汇总、当日盈亏、逐笔行文本、截断披露。
 *
 * 为什么单独一层：本仓库没有 DOM 测试环境（见 `toolsPage.test.ts` 文件头），页面里的规则只有
 * 下沉成纯函数才可断言；`FupanPage.tsx` 只做接线与渲染。行为判据在 `impl87.test.ts`。
 *
 * 用户口径（每条都配了反例注入，见 `impl87.test.ts`）：
 *  ① 月历标记**只用形状**：笔记 = `●`，交易 = `▲` + 笔数（`▲3`），并存并排（`● ▲3`）；
 *    **不用颜色区分**（颜色留给涨跌）。
 *  ② 读取失败**不画三角**（用户决定：失败等同 0 笔）；没打开过的日子同样不画 ——
 *    笔数只有打开过才知道（宿主 `month` 回包不带笔数 ⇒ 按日惰性取数）。
 *  ③ 当日汇总行**只有买卖笔数**（`买入 N 笔 · 卖出 M 笔`）：不写净买入/净卖出，也不写净额。
 *  ④ 当日盈亏**只给数值**：不加来源标注、不加口径句；缺值 ⇒ `未取到`（**不写 0**）。
 *  ⑤ 超过 500 笔 ⇒ 前 500 + `另有 N 笔未显示`（不许静默截断）。
 *
 * ⚠ 本模块是**遮蔽开关的绝缘层**：所有数字走 `format.ts` 里**不受 `setMoneyMask` 影响**的出口
 * （`fmtPrice` / `fmtSigned` / `fmtClock`），也不读 `prefs.viewMode` ⇒ 本页数字永远明文。
 */
import type { FupanMonthPayload, FupanTradeDto, FupanTradesPayload } from './api.ts'
import { fmtClock, fmtPrice, fmtSigned } from './format.ts'

/** 逐笔列表一次最多渲染多少行（超出**如实披露**，与流水弹窗/搜索列表同一做法） */
export const FUPAN_TRADE_ROW_LIMIT = 500

/** 笔记标记（实心圆点） */
export const FUPAN_MARK_NOTE = '●'
/** 交易标记（实心三角 + 笔数） */
export const FUPAN_MARK_TRADE = '▲'

/** 月历下方那一行图例（唯一来源；顺序 = 显示顺序） */
export const FUPAN_TRADE_LEGEND: readonly { mark: string; label: string }[] = [
  { mark: FUPAN_MARK_NOTE, label: '笔记' },
  { mark: FUPAN_MARK_TRADE, label: '交易笔数' },
]

/** 有笔记才画圆点（条数本身不进格子，进读屏文本与月汇总） */
export function noteMarkOf(noteCount: number | null | undefined): string {
  return typeof noteCount === 'number' && Number.isFinite(noteCount) && noteCount > 0 ? FUPAN_MARK_NOTE : ''
}

/**
 * 交易标记：笔数 > 0 才画 `▲n`。
 *
 * `null` = **未取到**（没打开过这一天 / 回包没有 `trades[]`）或**读取失败** ⇒ 一律不画：
 * 用户已决定"失败等同 0 笔"。⚠ 不允许写成 `▲0` —— `▲0` 会被读成"这天有交易记录但笔数是 0"，
 * 那是假数据（反例注入见 `impl87.test.ts` ②）。
 */
export function tradeMarkOf(tradeCount: number | null | undefined): string {
  return typeof tradeCount === 'number' && Number.isFinite(tradeCount) && tradeCount > 0
    ? `${FUPAN_MARK_TRADE}${tradeCount}`
    : ''
}

/** 格子里的标记串：并存时**并排**（`● ▲3`）；都没有 ⇒ 空串（不占版面，不是"0"） */
export function dayMarksTextOf(input: { noteCount: number | null; tradeCount: number | null }): string {
  return [noteMarkOf(input.noteCount), tradeMarkOf(input.tradeCount)].filter((s) => s !== '').join(' ')
}

/**
 * 回包里的**该日交易笔数**（不受渲染截断影响）。`null` = 未取到 ⇒ 不画三角。
 *
 * 两种回包形状都认：宿主新契约给顶层 `total`；只有 `trades[]` 时用它的长度。
 * `readFailed === true` ⇒ `null`（读取失败，不是"0 笔"，本页按用户口径不画三角）。
 */
export function tradeCountOf(payload: FupanTradesPayload | null | undefined): number | null {
  if (payload === null || payload === undefined) return null
  if (payload.readFailed === true) return null
  if (typeof payload.total === 'number' && Number.isFinite(payload.total)) return payload.total
  return Array.isArray(payload.trades) ? payload.trades.length : null
}

/**
 * 宿主 `month` 回包里该日的交易笔数。
 *
 * 宿主**当前不带**这个字段（按日惰性取数）⇒ 返回 `null`；哪天带上了（`dates[].trades: number`）
 * 整月就能直接显示 `▲n`，界面不用改。⚠ 缺失一律 `null`，**不写 0**。
 */
export function monthTradeCountOf(month: FupanMonthPayload | null | undefined, date: string): number | null {
  const day = Array.isArray(month?.dates) ? month?.dates.find((d) => d?.date === date) : undefined
  const n = day?.trades
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** 笔数文字：缺字段 ⇒ `未取到`（不写 0） */
function countTextOf(n: number | undefined | null): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${n} 笔` : '未取到'
}

/**
 * 当日汇总行：**只有买卖笔数**。
 *
 * 两种回包形状都认（`{buys,sells}` / `{buy:{count},sell:{count}}`）；缺字段 ⇒ `未取到`。
 * ⚠ 不许出现"净买入/净卖出/净额"：用户明确不做净额（反例注入见 `impl87.test.ts` ③）。
 */
export function daySummaryTextOf(summary: FupanTradesPayload['summary']): string {
  const buys = typeof summary?.buys === 'number' ? summary.buys : summary?.buy?.count
  const sells = typeof summary?.sells === 'number' ? summary.sells : summary?.sell?.count
  return `买入 ${countTextOf(buys)} · 卖出 ${countTextOf(sells)}`
}

/**
 * 当日盈亏：**只给数值**。
 *
 * 用户明确不做：不加来源标注（「来自持仓核算」）、不加口径句 —— 缺值就 `未取到`，
 * 绝不写 0（0 会被读成"当天不赚不亏"）。格式化走 `fmtSigned`（**不受遮蔽开关影响**）。
 */
export function dayPnlTextOf(dayPnl: number | null | undefined): string {
  if (typeof dayPnl !== 'number' || !Number.isFinite(dayPnl)) return '未取到'
  return fmtSigned(dayPnl)
}

const SIDE_LABEL: Record<string, string> = { buy: '买', sell: '卖', adjust: '调整' }

/**
 * 买卖方向：`side` 认 `buy|sell|adjust`；宿主若只给中文 `direction` 就用它；
 * 其它取值**原样显示**（不猜、不吞），完全缺失 ⇒ `未取到`。
 */
export function sideTextOf(trade: Pick<FupanTradeDto, 'side' | 'direction'>): string {
  const side = typeof trade.side === 'string' ? trade.side : ''
  if (side !== '') return SIDE_LABEL[side] ?? side
  const direction = typeof trade.direction === 'string' ? trade.direction : ''
  return direction !== '' ? direction : '未取到'
}

export interface TradeRowTexts {
  /** React key（流水 id 缺失时用序号兜底） */
  key: string
  /** 台账流水 id（缺失 ⇒ 空串：能跳流水但无法高亮那一行） */
  ledgerId: string
  time: string
  name: string
  side: string
  qty: string
  price: string
  fee: string
  /** 读屏文本（一整行的完整句子；因为可见文本是窄列，读屏不能只读零散数字） */
  aria: string
}

/** 逐笔一行的可见文本（时间 / 名称 / 买卖 / 数量 / 价格 / 费用）；缺字段 ⇒ `未取到`，不写 0 */
export function tradeRowTextsOf(trade: FupanTradeDto, index: number): TradeRowTexts {
  const ledgerId = typeof trade.ledgerId === 'string' ? trade.ledgerId : ''
  const time = typeof trade.time === 'string' && trade.time !== ''
    ? trade.time
    : typeof trade.ts === 'number' && Number.isFinite(trade.ts) ? fmtClock(trade.ts) : '未取到'
  const name = typeof trade.name === 'string' && trade.name !== '' ? trade.name : '未取到'
  const side = sideTextOf(trade)
  const qty = typeof trade.qty === 'number' && Number.isFinite(trade.qty) ? `${trade.qty} 份` : '未取到'
  const price = typeof trade.price === 'number' && Number.isFinite(trade.price) ? `@ ${fmtPrice(trade.price)}` : '未取到'
  const fee = typeof trade.fee === 'number' && Number.isFinite(trade.fee) ? `费 ${trade.fee.toFixed(2)}` : '未取到'
  return {
    key: ledgerId !== '' ? ledgerId : `#${index}`,
    ledgerId,
    time,
    name,
    side,
    qty,
    price,
    fee,
    aria: `${time} ${name} ${side} ${qty} ${price} ${fee}`,
  }
}

export interface TradeListView {
  /** 实际渲染的行（最多 `FUPAN_TRADE_ROW_LIMIT` 行） */
  rows: FupanTradeDto[]
  /** 未显示的行数（0 = 没截断） */
  more: number
}

/**
 * 逐笔列表：前 500 + 剩余笔数。`null` = 回包**没有 `trades[]`**（明细未取到 ——
 * 不许画成"这一天没有交易"，那是把"没读到"说成"没有"）。
 */
export function tradeListOf(payload: FupanTradesPayload | null | undefined): TradeListView | null {
  if (payload === null || payload === undefined || !Array.isArray(payload.trades)) return null
  const all = payload.trades
  const rows = all.slice(0, FUPAN_TRADE_ROW_LIMIT)
  const hostTotal = typeof payload.total === 'number' && Number.isFinite(payload.total)
    ? payload.total
    : typeof payload.truncated?.total === 'number' && Number.isFinite(payload.truncated.total)
      ? payload.truncated.total
      : all.length
  return { rows, more: Math.max(0, hostTotal - rows.length) }
}

/** 截断披露：`另有 N 笔未显示`；没截断 ⇒ `null`（不占版面） */
export function moreTextOf(more: number): string | null {
  return Number.isFinite(more) && more > 0 ? `另有 ${Math.round(more)} 笔未显示` : null
}

/** 整份交易回包取不到（路由失败 / `readFailed`）时的一句话 —— **不是**"这一天没有交易" */
export function tradesFailTextOf(): string {
  return '交易记录未取到'
}

/** 回包没有 `trades[]`（只有汇总）⇒ 明细未取到（同样不许画成空列表） */
export function tradeListFailTextOf(): string {
  return '交易明细未取到'
}

/** 失败原因（进 `title`：短句留在界面上，完整原因悬停可读） */
export function tradesFailReasonOf(payload: FupanTradesPayload | null | undefined): string | null {
  const raw = payload?.readFailedReason
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  return null
}
