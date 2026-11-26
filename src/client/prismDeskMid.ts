/**
 * 棱镜 · AGENT DESK（第二批：中栏）展示纯函数：
 * 个股详情（行情头 / 九项口径 / 成交标记 / AI 研判）+ 决策流（由 `state.runs`、`state.orders`
 * 与 `desk.holdingAnalyses` 派生）。
 *
 * 三条红线（页面只做渲染，判断都在这里）：
 * 1. **有源才出数**：决策流复审置信度 / token 用量宿主没有字段 ⇒ 字段为 `null`，界面不渲染该 chip（不写 `0`、不写 `—` 占位）。
 *    例外：个股 AI 研判卡的置信度**固定显示 `—`**，并用 `title="宿主无置信度字段"` 说明这是宿主缺字段（不编数）。
 * 2. **七个 tab 的计数逐条来自同一份 entries**：被拦截的委托同属「挂单」与「风控」两个视图（事件本来就是两件事），
 *    「全部」= 去重后的条数，不做简单相加；「持仓」每条 = 一个持仓标的（HOLD，v0.212.0）。
 * 3. **时间一律倒序**（同一时刻按 seq 稳定排序），最新的决策排在最上面；时间列统一 `MM-DD HH:MM`（北京时间）。
 */
import { shClockText, shDateTimeText, shStampText } from './marketTime.ts'

export type Tone = 'up' | 'down' | 'flat'

const finite = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/** 涨跌色：>0 ⇒ up（红涨），<0 ⇒ down（绿跌），0/缺失 ⇒ flat */
export function quoteToneOf(v: number | null | undefined): Tone {
  const n = finite(v)
  if (n === null || n === 0) return 'flat'
  return n > 0 ? 'up' : 'down'
}

/** 两位小数；缺失 ⇒ `—`（绝不输出 NaN） */
export function num2(v: number | null | undefined): string {
  const n = finite(v)
  return n === null ? '—' : n.toFixed(2)
}

/** 带符号两位小数：+0.24 / -0.31 / 0.00 */
export function signed2(v: number | null | undefined): string {
  const n = finite(v)
  if (n === null) return '—'
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`
}

/** 百分比（两位，带符号）：+0.81% / -1.20% */
export function pct2(v: number | null | undefined): string {
  const n = finite(v)
  if (n === null) return '—'
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`
}

/** 千分位（整数）；缺失 ⇒ `—` */
export function groupInt(v: number | null | undefined): string {
  const n = finite(v)
  if (n === null) return '—'
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 成交额：≥1 亿 ⇒ `12.34亿`；≥1 万 ⇒ `3,400.00万`；其余原值；缺失 ⇒ `—` */
export function amountTextOf(v: number | null | undefined): string {
  const n = finite(v)
  if (n === null) return '—'
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(2)}万`
  return groupInt(n)
}

/** 振幅 =（最高 − 最低）/ 昨收 × 100；任一缺失或昨收 ≤0 ⇒ null（不猜） */
export function amplitudeOf(high: number | null | undefined, low: number | null | undefined, prev: number | null | undefined): number | null {
  const h = finite(high)
  const l = finite(low)
  const p = finite(prev)
  if (h === null || l === null || p === null || p <= 0 || h < l) return null
  return ((h - l) / p) * 100
}

/* ────────────────────────── 个股详情 ────────────────────────── */

export interface QuoteFacts {
  price: number | null
  prev: number | null
  pct: number | null
  open: number | null
  high: number | null
  low: number | null
  amount: number | null
  turnover: number | null
  volumeRatio: number | null
}

export interface QuoteHead {
  /** 26px 现价 `29.86` */
  priceText: string
  /** 涨跌额 `+0.24` */
  chgText: string
  /** 涨跌幅 `+0.81%` */
  pctText: string
  tone: Tone
  /** 现价 / 昨收缺失时给一句可读原因（title） */
  title: string
}

/** 行情头：现价 + 涨跌额 + 涨跌幅（涨跌幅缺失时由 现价/昨收 现算；两者都没有 ⇒ `—`） */
export function quoteHeadOf(q: QuoteFacts): QuoteHead {
  const price = finite(q.price)
  const prev = finite(q.prev)
  const chg = price !== null && prev !== null ? price - prev : null
  const pct = finite(q.pct) ?? (price !== null && prev !== null && prev > 0 ? (price / prev - 1) * 100 : null)
  const missing: string[] = []
  if (price === null) missing.push('现价')
  if (prev === null) missing.push('昨收')
  return {
    priceText: price === null ? '—' : price.toFixed(2),
    chgText: signed2(chg),
    pctText: pct2(pct),
    tone: quoteToneOf(pct),
    title: missing.length === 0 ? '现价 / 昨收来自详情快照' : `缺${missing.join('、')}，涨跌不可算`,
  }
}

export interface StatCell {
  key: string
  label: string
  value: string
  /** 第一行（昨收…持仓）/ 第二行（成交额…振幅） */
  row: 'a' | 'b'
  title?: string
}

/**
 * 九项口径（设计稿两行）：`昨收 今开 最高 最低 持仓` ｜ `成交额 换手率 量比 振幅`。
 * 持仓来自 `desk.positions.rows[].qty`；振幅由最高/最低/昨收派生（真实算式，非编数）。
 */
export function statCellsOf(q: QuoteFacts, qty: number | null | undefined): StatCell[] {
  const amp = amplitudeOf(q.high, q.low, q.prev)
  const qtyN = finite(qty)
  return [
    { key: 'prev', label: '昨收', value: num2(q.prev), row: 'a' },
    { key: 'open', label: '今开', value: num2(q.open), row: 'a' },
    { key: 'high', label: '最高', value: num2(q.high), row: 'a' },
    { key: 'low', label: '最低', value: num2(q.low), row: 'a' },
    { key: 'qty', label: '持仓', value: qtyN === null ? '—' : groupInt(qtyN), row: 'a', title: qtyN === null ? '该标的已不在持仓明细里' : '持股数（desk.positions.rows）' },
    { key: 'amount', label: '成交额', value: amountTextOf(q.amount), row: 'b' },
    { key: 'turnover', label: '换手率', value: q.turnover === null ? '—' : `${q.turnover.toFixed(2)}%`, row: 'b', title: q.turnover === null ? '宿主该标的换手率无源' : '换手率（详情快照）' },
    { key: 'volumeRatio', label: '量比', value: num2(q.volumeRatio), row: 'b', title: q.volumeRatio === null ? '宿主该标的量比无源' : '量比（详情快照）' },
    { key: 'amplitude', label: '振幅', value: amp === null ? '—' : `${amp.toFixed(2)}%`, row: 'b', title: amp === null ? '缺最高/最低/昨收，振幅不可算' : '（最高 − 最低）/ 昨收' },
  ]
}

export interface FillInput { at: number; side: 'buy' | 'sell'; shares: number; price: number; secid: string }
export interface FillMark { id: string; side: 'buy' | 'sell'; text: string; at: number }

/**
 * 成交标记：`B 11:14 买入 2,000 @29.86`（设计稿原文格式）。
 * 取该标的**最近** `limit` 笔（按时间正序展示）；一笔都没有 ⇒ 返回空数组，界面整行不渲染。
 *
 * AUDIT-CLIENT-PERF P2-3：旧实现 `filter` 全量 + `sort` 全量，只为拿末尾 2 条 —— 每次 tick
 * O(n log n)。宿主 `fills` 落盘/回包都按 `at` 升序（`prismAccount.ts` 的 `mergeFills` 排序），
 * 因此这里**从末尾倒着扫**，凑够 `limit` 条立刻停：耗时只与"末尾连续不匹配的条数"有关，
 * 与 fills 总长度无关。返回仍按时间正序（最近的排最后），展示顺序不变。
 */
export function fillMarksOf(fills: readonly FillInput[], secid: string, limit = 2): FillMark[] {
  if (!(limit > 0)) return []
  const tail: FillInput[] = []
  for (let i = fills.length - 1; i >= 0 && tail.length < limit; i -= 1) {
    const f = fills[i]
    if (f.secid !== secid || finite(f.at) === null || finite(f.price) === null) continue
    tail.push(f)
  }
  tail.reverse()
  return tail.map((f) => ({
    id: `${f.at}-${f.side}-${f.shares}-${f.price}`,
    side: f.side,
    at: f.at,
    text: `${f.side === 'buy' ? 'B' : 'S'} ${shClockText(f.at).slice(0, 5)} ${f.side === 'buy' ? '买入' : '卖出'} ${groupInt(f.shares)} @${f.price.toFixed(2)}`,
  }))
}

/** 无源文案：说清「这只股票没有」，不是含糊的「无研判」 */
export const THESIS_NONE = '—（该股暂无研判）'
/** 置信度恒 `—` 的 title：宿主确实没有这个字段，不编数 */
export const THESIS_CONF_TITLE = '宿主无置信度字段'

export type ThesisSourceLabel = '委托理由' | '本轮组合研判'

/** 宿主 `desk.holdings[].thesis` 的线上形状（只读；缺字段按 null 处理） */
export interface ThesisWire {
  text?: unknown
  at?: unknown
  kind?: unknown
}

export interface ThesisView {
  /** 研判原文；无源 ⇒ `—（该股暂无研判）` */
  text: string
  has: boolean
  /** 右下角来源标签；无源 / 未知 kind ⇒ null */
  source: ThesisSourceLabel | null
  /** 北京时间 `MM-DD HH:MM`；无源或缺时刻 ⇒ null（界面写 `—` + title 原因） */
  at: string | null
  /** 完整原文（`title` 悬浮用）；无源 ⇒ null */
  title: string | null
  /** 宿主无置信度字段 ⇒ 恒 `—` */
  confidence: '—'
  /** 置信度 `—` 的解释（`title`） */
  confidenceTitle: string
}

/**
 * AI 研判（个股）：只认宿主 `holdings[].thesis`。
 * - `text` 原样展示（不截断、不摘要）；折叠是纯视觉（≤3 行 + 展开），`title` 给全文；
 * - 来源 label 由 `kind` 决定：`order` ⇒ 委托理由，`run-note` ⇒ 本轮组合研判；
 * - **置信度宿主没有字段 ⇒ 恒 `—`** + `title="宿主无置信度字段"`（不编 0.68）。
 */
export function thesisViewOf(src: ThesisWire | null | undefined): ThesisView {
  const text = typeof src?.text === 'string' ? src.text.trim() : ''
  if (text === '') {
    return {
      text: THESIS_NONE, has: false, source: null, at: null, title: null,
      confidence: '—', confidenceTitle: THESIS_CONF_TITLE,
    }
  }
  const kind = src?.kind
  const source: ThesisSourceLabel | null = kind === 'order' ? '委托理由' : kind === 'run-note' ? '本轮组合研判' : null
  const ts = finite(typeof src?.at === 'number' ? src.at : undefined)
  return {
    text, has: true, source, at: ts === null ? null : shStampText(ts), title: text,
    confidence: '—', confidenceTitle: THESIS_CONF_TITLE,
  }
}

/* ────────────────────────── 决策流 ────────────────────────── */

export type DeskFlowKind = 'ORDER' | 'SCAN' | 'ANALYZE' | 'RISK' | 'HOLD'
export type DeskFlowTab = 'scan' | 'analyze' | 'holding' | 'order' | 'autoT' | 'risk' | 'cons'
export interface DeskFlowTabDef { id: 'all' | DeskFlowTab; label: string }

/** 七个筛选 tab（顺序 = 设计稿；`持仓` 为 v0.212.0 新增，计数 = 持仓数） */
export const FLOW_TABS: ReadonlyArray<DeskFlowTabDef> = [
  { id: 'all', label: '全部' },
  { id: 'scan', label: '决策' },
  { id: 'analyze', label: '分析' },
  { id: 'holding', label: '持仓' },
  { id: 'order', label: '挂单' },
  { id: 'autoT', label: '做T' },
  { id: 'risk', label: '风控' },
  { id: 'cons', label: '约束' },
]

export interface DeskFlowEntry {
  id: string
  at: number
  /** 时间倒序的稳定次序（同一时刻按它排） */
  seq: number
  kind: DeskFlowKind
  /** 事件来源域：run / order / holding（HOLD 恒为 `'holding'`，由 `desk.holdingAnalyses` 合并，不写 runs） */
  scope?: 'run' | 'order' | 'holding'
  /** 所属筛选视图（可多属：被拦截的委托同属「挂单」「风控」） */
  cats: DeskFlowTab[]
  title: string
  action: string
  basis: string | null
  risk: string | null
  /** ANALYZE / HOLD 三要素（观察 / 推理 / 结论）；其它类型为 null */
  three?: FlowThree | null
  /** 真实耗时（run 的 finishedAt − startedAt）；无源 ⇒ null */
  ms: number | null
  /** 复审置信度；宿主无字段 ⇒ null（不渲染该 chip） */
  review: number | null
  /** token 用量；宿主恒无 ⇒ null（不渲染该 chip） */
  tok: number | null
  verdict: 'pass' | 'block'
  /** 底部结论 pill 文案：HOLD 写自身判定（超单票上限 / 触及止损线 / …），不冒充「风控拦截」 */
  verdictLabel?: string | null
}

export interface FlowOrderInput {
  id: string
  secid: string
  name: string
  side: 'buy' | 'sell'
  price: number
  shares: number
  status: string
  decidedAt: number
  filledAt?: number
  filledShares?: number
  reason?: string
  rejectReason?: string
  skipReason?: string
  /** 委托来源（旧订单无此字段 ⇒ 不写来源，不猜） */
  origin?: string
  /** v0.243.0：自动做T 委托（channel:'autoT'）单独进「做T」筛选 */
  channel?: string
}

export interface FlowRunInput {
  slot?: string
  day?: string
  startedAt: number
  finishedAt?: number | null
  error?: string | null
  /** 本轮整篇汇总（结论段兜底：只取第一句） */
  summary?: string | null
  analyses?: ReadonlyArray<{ key: string; label: string; text: string | null; error: string | null }>
  decision?: null | {
    note?: string | null
    orders?: ReadonlyArray<unknown>
    cancel?: ReadonlyArray<unknown>
    rejects?: ReadonlyArray<{ secid: string; side: 'buy' | 'sell'; price: number; shares: number; reason: string }>
    clampEvents?: ReadonlyArray<{ at: number; secid: string; dimension: string; before: number; after: number; basis: string }>
    parseError?: string | null
  }
}

/**
 * 宿主 `desk.holdingAnalyses[]` 的线上形状（v0.212.0，只读）。
 * 观察 / 推理 / 结论由宿主按真实数据算好；客户端只负责合并进决策流（`scope:'holding'`）。
 */
export interface FlowHoldingInput {
  secid: string
  name?: string | null
  /** 分析时刻（epoch ms）；无源 ⇒ null（界面 `—`） */
  at?: number | null
  observation?: string | null
  reasoning?: string | null
  conclusion?: string | null
  /** 'over' | 'stop' | 'ok' | 'no-constraint' | null */
  verdict?: string | null
  marketValue?: number | null
}

const ORDER_STATUS: Readonly<Record<string, string>> = {
  filled: '已成交', partial: '部分成交', pending: '待成交', rejected: '已拒绝', cancelled: '已撤单',
}
const orderStatusOf = (s: string): string => ORDER_STATUS[s] ?? s
const SOURCE_LABEL: Readonly<Record<string, string>> = { auto: '自动', manual: '人工' }
const sourceLabelOf = (s: string | undefined): string | null => (s === undefined ? null : (SOURCE_LABEL[s] ?? null))

const CLAMP_DIM: Readonly<Record<string, string>> = {
  single: '单票权重', industry: '行业权重', total: '总仓位', cash: '现金下限',
  perStock: '单票上限', perOrder: '单笔金额', maxPos: '最大总仓位', minCash: '最低现金留存',
  maxDD: '日回撤', stopLoss: '止损线', available: '可卖数量',
}
const clampDimOf = (d: string): string => CLAMP_DIM[d] ?? d

/** 一段长文压成一行（去 markdown 记号、折叠空白）；空 ⇒ null。**不截断**：DOM 必须保留全文 */
export function plainOf(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  const flat = text.replace(/[#*`>]/g, ' ').replace(/\s+/g, ' ').trim()
  return flat === '' ? null : flat
}

/** 一段长文压成一行（去 markdown 记号、折叠空白、超长截断）；空 ⇒ null。仅用于需要单行摘要的旧位置 */
export function digestOf(text: string | null | undefined, max = 72): string | null {
  const flat = plainOf(text)
  if (flat === null) return null
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** ANALYZE 三要素缺失时的统一文案（`—` + 一句原因） */
export const FLOW_MISSING = '—（本条未给出）'

export interface FlowThree {
  /** 观察 ← 第一条 `- **依据**：…` */
  observation: string
  /** 推理 ← 第一条 `- **判断**：…` */
  reasoning: string
  /** 结论 ← 首段 `**总判断：…**`；没有 ⇒ `summary` 第一句 */
  conclusion: string
}

/** 行内去 markdown：标题井号 / 列表符号 / 粗体 / 行内代码 / 链接 */
const cleanInline = (s: string): string =>
  s
    .replace(/^\s{0,3}#{1,6}\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()

/** 找 `**标签**：内容`（允许 `-` 前缀、冒号在粗体内、内容在下一行）；找不到 ⇒ null */
const labelledOf = (text: string, label: '依据' | '判断' | '观察' | '推理' | '结论'): string | null => {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\*\*/g, '').trim()
    const m = line.match(/^(?:[-*+]\s*)?(依据|判断|观察|推理|结论)\s*(?:[：:]\s*(.*))?$/)
    if (m === null || m[1] !== label) continue
    let content = (m[2] ?? '').trim()
    if (content === '') {
      for (let j = i + 1; j < lines.length; j += 1) {
        const raw = lines[j].trim()
        if (raw === '') continue
        if (/^#{1,6}\s/.test(raw)) break
        const next = raw.replace(/\*\*/g, '').trim()
        if (/^(?:[-*+]\s*)?(依据|判断|总判断|观察|推理|结论)\s*(?:[：:]|$)/.test(next)) break
        content = next.replace(/^[-*+]\s*/, '').trim()
        break
      }
    }
    const clean = cleanInline(content)
    if (clean !== '') return clean
  }
  return null
}

/** 首段 `**总判断：…**`（兼容 `**总判断：** 正文` 与 `**总判断**：正文`）；没有 ⇒ null */
const totalJudgmentOf = (text: string): string | null => {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\*\*/g, '').trim()
    const m = line.match(/^(?:[-*+]\s*)?总判断\s*(?:[：:]\s*(.*))?$/)
    if (m === null) continue
    let content = (m[1] ?? '').trim()
    if (content === '') {
      for (let j = i + 1; j < lines.length; j += 1) {
        const raw = lines[j].trim()
        if (raw === '') continue
        if (/^#{1,6}\s/.test(raw)) break
        content = raw.replace(/\*\*/g, '').trim()
        break
      }
    }
    const clean = cleanInline(content)
    if (clean !== '') return clean
  }
  return null
}

/** 第一句（跳过标题 / 表格 / 空行）：用于 `runs[].summary` 兜底 */
export function firstSentenceOf(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || /^#{1,6}\s/.test(line) || /^\|/.test(line)) continue
    const plain = cleanInline(line).replace(/^(?:总判断|结论)\s*[：:]\s*/, '')
    if (plain === '') continue
    const sentence = plain.match(/^[^。！？!?]*[。！？!?]/)?.[0] ?? plain
    return sentence.trim()
  }
  return null
}

/**
 * ANALYZE 三要素抽取（纯函数）：
 * - 观察 ← 第一条 `- **依据**：…`；推理 ← 第一条 `- **判断**：…`；
 * - 结论 ← 首段 `**总判断：…**`；没有则取 `summary` 第一句；
 * - 抽不到就是 `—（本条未给出）`，**绝不用别的段落顶替**。
 */
export function threeOf(text: string | null | undefined, summary?: string | null): FlowThree {
  const md = typeof text === 'string' ? text : ''
  // v0.220.1：报告结尾必须有「观察/推理/结论」三行摘要块（提示词强制）。有块就**只用块**——
  // 以前没有块时结论会退回 `runs[].summary` 第一句，四张卡片结论因此一模一样。
  const block = {
    observation: labelledOf(md, '观察'),
    reasoning: labelledOf(md, '推理'),
    conclusion: labelledOf(md, '结论'),
  }
  if (block.observation !== null && block.reasoning !== null && block.conclusion !== null) return block
  return {
    observation: block.observation ?? labelledOf(md, '依据') ?? FLOW_MISSING,
    reasoning: block.reasoning ?? labelledOf(md, '判断') ?? FLOW_MISSING,
    // 兜底也要「本报告自己的结论」：先总判断，再本条判断句，最后才用 summary（旧实现直接跳到 summary，
    // 四张卡片因此共用同一句「必须先降低风险暴露…」）
    conclusion: block.conclusion ?? totalJudgmentOf(md) ?? labelledOf(md, '判断') ?? firstSentenceOf(summary) ?? FLOW_MISSING,
  }
}

const sideLabelOf = (s: 'buy' | 'sell'): string => (s === 'buy' ? '买入' : '卖出')

/**
 * 决策流：一条时间轴，五类徽标 `ORDER / SCAN / ANALYZE / RISK / HOLD`。
 * - SCAN：每个 run 一条（含真实耗时 `finishedAt − startedAt`）；
 * - ANALYZE：每个 run 的每份报告一条（落盘时间取 run 结束时刻）；
 * - ORDER：每笔委托一条（被拒绝的同时进「风控」视图）；
 * - RISK：确定性裁剪（`clampEvents`）与引擎直接拒绝（`decision.rejects`）各一条；
 * - HOLD（v0.212.0）：每个持仓一条（`desk.holdingAnalyses`，只读派生，不写 runs、不走手动重放）。
 * 全部**时间倒序**；同一时刻按 `seq` 稳定排序（先 run 后其报告，再按写入顺序）。
 */
export function flowEntriesOf(input: {
  runs?: readonly FlowRunInput[]
  orders?: readonly FlowOrderInput[]
  /** v0.212.0：`desk.holdingAnalyses`（每个持仓一条 HOLD；不来自 runs，也不写 runs） */
  holdings?: readonly FlowHoldingInput[]
}): DeskFlowEntry[] {
  const out: DeskFlowEntry[] = []
  let seq = 0
  const push = (e: Omit<DeskFlowEntry, 'seq'>): void => { out.push({ ...e, seq: seq++ }) }

  for (const r of input.runs ?? []) {
    const d = r.decision ?? null
    const o = d?.orders?.length ?? 0
    const c = d?.cancel?.length ?? 0
    const k = d?.rejects?.length ?? 0
    const ended = finite(r.finishedAt)
    const ms = ended === null ? null : Math.max(0, ended - r.startedAt)
    const parseErr = typeof d?.parseError === 'string' && d.parseError !== '' ? d.parseError : null
    if (r.decision !== null && r.decision !== undefined) {
      for (const rej of d?.rejects ?? []) {
        push({
          id: `rej-${r.startedAt}-${rej.secid}-${rej.side}`,
          at: r.startedAt,
          kind: 'RISK',
          cats: ['risk'],
          title: `拦截 ${sideLabelOf(rej.side)} ${rej.secid}`,
          action: `${sideLabelOf(rej.side)} ${groupInt(rej.shares)} 股 @${num2(rej.price)}`,
          basis: plainOf(rej.reason) ?? null,
          risk: '风控拦截',
          ms: null,
          review: null,
          tok: null,
          verdict: 'block',
        })
      }
      for (const cl of d?.clampEvents ?? []) {
        push({
          id: `clamp-${cl.at}-${cl.secid}-${cl.dimension}`,
          at: cl.at,
          kind: 'RISK',
          cats: ['risk', 'cons'],
          title: `约束裁剪 ${cl.secid}`,
          action: `${clampDimOf(cl.dimension)} ${groupInt(cl.before)} → ${groupInt(cl.after)}`,
          basis: plainOf(cl.basis) ?? null,
          risk: '风控拦截',
          ms: null,
          review: null,
          tok: null,
          verdict: 'block',
        })
      }
    }
    const at = ended ?? r.startedAt
    for (const a of r.analyses ?? []) {
      push({
        id: `analyze-${r.startedAt}-${a.key}`,
        at,
        kind: 'ANALYZE',
        cats: ['analyze'],
        title: `${a.label} 分析`,
        action: a.error === null || a.error === ''
          ? `生成${a.label}报告 · ${a.text === null || a.text === '' ? '空文' : `${a.text.length} 字`}`
          : `生成${a.label}报告失败`,
        basis: plainOf(a.error ?? a.text) ?? null,
        three: threeOf(a.text, r.summary),
        risk: '风控通过',
        ms: null,
        review: null,
        tok: null,
        verdict: 'pass',
      })
    }
    push({
      id: `scan-${r.startedAt}-${r.slot ?? ''}`,
      at: ended ?? r.startedAt,
      kind: 'SCAN',
      cats: ['scan'],
      title: `本轮决策 · 挂单 ${o} / 撤单 ${c} / 拦截 ${k}`,
      action: `本轮决策产出挂单 ${o} 笔、撤单 ${c} 笔、拦截 ${k} 笔`,
      basis: plainOf(d?.note) ?? null,
      risk: parseErr !== null ? `解析失败：${digestOf(parseErr, 40)}` : (r.error === null || r.error === undefined ? '风控通过' : `执行失败：${digestOf(r.error, 40)}`),
      ms,
      review: null,
      tok: null,
      verdict: parseErr !== null || (typeof r.error === 'string' && r.error !== '') ? 'block' : 'pass',
    })
  }

  for (const o of input.orders ?? []) {
    const at = finite(o.filledAt) ?? (finite(o.decidedAt) ?? 0)
    const rejected = o.status === 'rejected'
    const done = finite(o.filledShares)
    const tag = done !== null && done > 0 && done < o.shares ? ` · 已成 ${groupInt(done)}` : ''
    const src = sourceLabelOf(o.origin)
    push({
      id: `order-${o.id}`,
      at,
      kind: 'ORDER',
      // T 委托只进「做T」，不进「挂单」（用户要求两类分开统计）
      cats: o.channel === 'autoT' ? (rejected ? ['autoT', 'risk'] : ['autoT']) : rejected ? ['order', 'risk'] : ['order'],
      title: `${sideLabelOf(o.side)} ${o.name} ${groupInt(o.shares)} 股`,
      action: `${sideLabelOf(o.side)} ${groupInt(o.shares)} 股 @${num2(o.price)} · ${orderStatusOf(o.status)}${tag}${src === null ? '' : ` · ${src}`}`,
      basis: plainOf(o.rejectReason ?? o.reason ?? o.skipReason) ?? null,
      risk: rejected ? `风控拦截：${digestOf(o.rejectReason, 32) ?? '未给原因'}` : `风控通过 · ${orderStatusOf(o.status)}`,
      ms: null,
      review: null,
      tok: null,
      verdict: rejected ? 'block' : 'pass',
    })
  }

  // v0.212.0：每个持仓一条 HOLD（观察 / 推理 / 结论全部来自宿主回包；`at` 缺失 ⇒ 0 ⇒ 时间列 `—`）
  for (const h of input.holdings ?? []) {
    const at = finite(h.at) ?? 0
    const v = h.verdict
    const verdict: 'pass' | 'block' = v === 'over' || v === 'stop' ? 'block' : 'pass'
    const observation = typeof h.observation === 'string' && h.observation !== '' ? h.observation : null
    const reasoning = typeof h.reasoning === 'string' && h.reasoning !== '' ? h.reasoning : null
    const conclusion = typeof h.conclusion === 'string' && h.conclusion !== '' ? h.conclusion : null
    const label = v === 'over' ? '超单票上限' : v === 'stop' ? '触及止损线' : v === 'ok' ? '未触及上限/止损线' : v === 'no-constraint' ? '约束未设置' : '未判定'
    push({
      id: `hold-${h.secid}`,
      at,
      kind: 'HOLD',
      scope: 'holding',
      cats: ['holding'],
      title: `持仓 · ${typeof h.name === 'string' && h.name !== '' ? h.name : h.secid}`,
      action: observation ?? FLOW_MISSING,
      basis: reasoning ?? null,
      risk: reasoning ?? null,
      three: {
        observation: observation ?? FLOW_MISSING,
        reasoning: reasoning ?? FLOW_MISSING,
        conclusion: conclusion ?? FLOW_MISSING,
      },
      ms: null,
      review: null,
      tok: null,
      verdict,
      verdictLabel: label,
    })
  }

  out.sort((a, b) => (b.at - a.at) || (a.seq - b.seq))
  return out
}

export interface FlowCounts { all: number; scan: number; analyze: number; holding: number; order: number; risk: number; cons: number }

/** 七个 tab 的计数（同一份 entries 逐条数；被拦截委托在「挂单」「风控」各记一次，`all` 是去重条数） */
export function flowCountsOf(entries: readonly DeskFlowEntry[]): FlowCounts {
  const n = (tab: DeskFlowTab): number => entries.filter((e) => e.cats.includes(tab)).length
  return { all: entries.length, scan: n('scan'), analyze: n('analyze'), holding: n('holding'), order: n('order'), risk: n('risk'), cons: n('cons') }
}

/** 按 tab 过滤（`all` 原样返回） */
export function flowFilterOf(entries: readonly DeskFlowEntry[], tab: 'all' | DeskFlowTab): DeskFlowEntry[] {
  return tab === 'all' ? [...entries] : entries.filter((e) => e.cats.includes(tab))
}

/** 单屏渲染上限：决策流可能上千条，页面每秒重渲染时钟，必须截断（截断事实在页脚如实写出来） */
export const FLOW_RENDER_MAX = 60

export interface FlowWindow { rows: DeskFlowEntry[]; shown: number; total: number; truncated: boolean }

/** 列表窗口：先过滤再截断；`truncated` ⇒ 页面必须显示「还有 N 条」 */
export function flowWindowOf(entries: readonly DeskFlowEntry[], tab: 'all' | DeskFlowTab, max = FLOW_RENDER_MAX): FlowWindow {
  const rows = flowFilterOf(entries, tab)
  const limit = max > 0 ? max : 0
  return { rows: rows.slice(0, limit), shown: Math.min(rows.length, limit), total: rows.length, truncated: rows.length > limit }
}

/** 每条底部 chips：复审 / 耗时 / token —— **只给有源的**（null 不出现） */
export function flowChipsOf(e: DeskFlowEntry): Array<{ kind: 'review' | 'ms' | 'tok'; text: string }> {
  const chips: Array<{ kind: 'review' | 'ms' | 'tok'; text: string }> = []
  if (e.review !== null) chips.push({ kind: 'review', text: `复审 ${e.review.toFixed(2)}` })
  if (e.ms !== null) chips.push({ kind: 'ms', text: e.ms >= 1000 ? `${(e.ms / 1000).toFixed(1)} s` : `${Math.round(e.ms)} ms` })
  if (e.tok !== null) chips.push({ kind: 'tok', text: `${groupInt(e.tok)} tok` })
  return chips
}

/**
 * 时间列 `MM-DD HH:MM`（**北京时间**，由 `shStampText` 统一出口）。
 * 一律带月日：跨日/隔日时 `HH:MM` 会被误读成同一天，所以今天也不省略。非法时间 ⇒ `—`。
 */
export function flowTimeOf(at: number): string {
  return finite(at) === null || at <= 0 ? '—' : shStampText(at)
}

/** 时间列悬停 `title`：完整 `YYYY-MM-DD HH:MM:SS`（北京时间）；非法 ⇒ `—` */
export function flowTimeTitleOf(at: number): string {
  return finite(at) === null || at <= 0 ? '—' : shDateTimeText(at)
}
