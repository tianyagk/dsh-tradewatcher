/**
 * 复盘页（第 7 个页签）的**纯逻辑**：月历网格、交易日/休市判定、钉住标注、失败与丢弃原因。
 *
 * 当日交易的月历标记（`●` / `▲n`）、汇总行、当日盈亏、截断披露在 `fupanTrades.ts`
 * （同一层的另一个文件：那边只认交易回包，这边只认笔记/交易日）。
 *
 * 为什么单独一层：本仓库没有 DOM 测试环境（见 `toolsPage.test.ts` 文件头），页面里的规则只有
 * 下沉成纯函数才可断言；`FupanPage.tsx` 只做接线与渲染。行为判据在 `impl83.test.ts`。
 *
 * 四条硬口径（每条都配了反例注入）：
 *  ① 交易日/休市**只能**来自宿主 `dates[].trading`。字段缺失 ⇒ 这一格是「未知」并给出原因，
 *    **绝不默认成交易日**（默认全交易日 = 把周末画成开市，是假数据）。同理 `count` 缺失时
 *    **不写 0**（0 会被读成"这天没有笔记"）。
 *  ② 「钉自 YYYY-MM-DD」是**必须**的标注：钉到某天的条目在那个日子看起来就像那天写的，
 *    不标注就会被读成"那天写的复盘"。
 *  ③ 「失败」与「空」是两件事：路由不可用/读失败必须给原因 + 重试，
 *    不许用空列表冒充「本月暂无笔记」。
 *  ④ 宿主的 `dropped`（超出上限后从最旧开始丢）必须**显示出来**，不静默当成功。
 */
import type { FupanDateDto, FupanDropped, FupanMissing, FupanMonthPayload, FupanNoteDto, FupanNoteResult } from './api.ts'

/** 周一起头的表头（与 `CalendarPage` 同一约定：周一=0） */
export const FUPAN_DOW: readonly string[] = ['一', '二', '三', '四', '五', '六', '日']
/** 网格固定 7 列（方向键 ↑/↓ 的步长就是它） */
export const FUPAN_GRID_COLS = 7
/** 月历格子的 `aria-label` 前缀（断言用单一来源） */
export const FUPAN_GRID_LABEL = '复盘月历'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isDateText(text: string): boolean {
  return DATE_RE.test(text)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** `Date` → `YYYY-MM-DD`（取**本地**年月日；日期格是自然日，不做时区换算） */
export function isoOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `YYYY-MM-DD` → `YYYY-MM`（非法输入 ⇒ 空串，调用方按"未知"处理，不猜） */
export function ymOf(date: string): string {
  return typeof date === 'string' && date.length >= 7 ? date.slice(0, 7) : ''
}

/** 月份加减（`YYYY-MM` 进、`YYYY-MM` 出；跨年由 `Date` 归一） */
export function shiftYm(ym: string, delta: number): string {
  const y = Number(ym.slice(0, 4))
  const m = Number(ym.slice(5, 7))
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return ym
  const t = new Date(y, m - 1 + delta, 1)
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}`
}

/** 面板标题用的月份文字 */
export function monthLabelOf(ym: string): string {
  const y = Number(ym.slice(0, 4))
  const m = Number(ym.slice(5, 7))
  if (!Number.isFinite(y) || !Number.isFinite(m)) return ym
  return `${y} 年 ${m} 月`
}

export interface FupanCell {
  date: string
  /** 是否属于当前月（相邻月的补格只用来对齐周） */
  inMonth: boolean
  /** 日号（1–31） */
  dom: number
}

/**
 * 月历网格：周一起头，6 行（42 格）后把整行都不属于本月的尾行裁掉。
 *
 * 只做**自然日**加减（`new Date(y, m-1, d)` 再取本地年月日），因此与浏览器时区无关
 * （两个时区的门禁跑出来必须是同一张网格）。
 */
export function fupanGridOf(ym: string): FupanCell[] {
  const y = Number(ym.slice(0, 4))
  const m = Number(ym.slice(5, 7))
  if (!Number.isFinite(y) || !Number.isFinite(m) || y <= 0 || m < 1 || m > 12) return []
  const first = new Date(y, m - 1, 1)
  const shift = (first.getDay() + 6) % 7 // 周一=0
  const out: FupanCell[] = []
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(y, m - 1, 1 - shift + i)
    out.push({ date: isoOf(d), inMonth: d.getMonth() === m - 1, dom: d.getDate() })
  }
  while (out.length > 35 && out.slice(35).every((c) => !c.inMonth)) out.splice(35)
  return out
}

/** `YYYY-MM-DD` → `周三`（日期是自然日，按本地 00:00 取星期，与日历页同一约定） */
export function weekdayLabelOf(date: string): string {
  if (!isDateText(date)) return ''
  return `周${FUPAN_DOW[(new Date(`${date}T00:00:00`).getDay() + 6) % 7]}`
}

// ── 交易日 / 休市 ────────────────────────────────────────────────────────

export type TradingKind = 'trading' | 'closed' | 'unknown'

/**
 * 单日类型：**只认宿主给的布尔**。
 *
 * `trading` 缺省（老宿主 / 回包不完整）⇒ `'unknown'` —— 这是本页最重要的一条：
 * 把缺字段当 `true` 会让整月看起来都是交易日（周末也不例外），而界面上没有任何地方能看出来。
 */
export function tradingKindOf(day: FupanDateDto | null | undefined): TradingKind {
  if (day === null || day === undefined) return 'unknown'
  if (day.trading === true) return 'trading'
  if (day.trading === false) return 'closed'
  return 'unknown'
}

/** 单日类型的用户可见标签（休市要带上宿主给的原因：周末 / 假日名 / 外部日历） */
export function tradingLabelOf(kind: TradingKind, reason?: string | null): string {
  if (kind === 'trading') return '交易日'
  if (kind === 'closed') {
    const text = typeof reason === 'string' ? reason.trim() : ''
    return text === '' ? '休市' : `休市（${text}）`
  }
  return '交易日未知'
}

export interface TradingMonthState {
  kind: 'known' | 'unknown'
  /** `dates[]` 里缺 `trading` 字段的天数 */
  unknownDays: number
  /** `dates[]` 覆盖的天数（宿主契约：该月每一天一条） */
  total: number
  /** `kind === 'unknown'` 时的原因 */
  reason: string | null
}

/** 整月的交易日判定状态（未知时**必须**能给出一句原因） */
export function monthTradingStateOf(month: FupanMonthPayload | null): TradingMonthState {
  // 根本还没拿到回包（首取中/取数失败）与"回包缺字段"是两个原因，措辞不能混
  if (month === null || month === undefined) {
    return { kind: 'unknown', unknownDays: 0, total: 0, reason: '月历尚未取到（见上方原因）' }
  }
  const dates = month.dates
  if (!Array.isArray(dates) || dates.length === 0) {
    return { kind: 'unknown', unknownDays: 0, total: 0, reason: '宿主回包没有 dates[]（该月任何一天的交易日信息都没有）' }
  }
  const unknownDays = dates.filter((d) => typeof d?.trading !== 'boolean').length
  if (unknownDays > 0) {
    return {
      kind: 'unknown',
      unknownDays,
      total: dates.length,
      reason: `宿主回包有 ${unknownDays}/${dates.length} 天没给 trading 字段`,
    }
  }
  return { kind: 'known', unknownDays: 0, total: dates.length, reason: null }
}

/**
 * 月历下方那行口径文字（交易日/休市怎么来的、为什么可能是未知）。
 *
 * `calendarWhy` 非 null 时**原样**带上（宿主说"外部交易日历未覆盖该月、已回退内置表"），
 * 不写成 0 / 空串。
 */
export function tradingNoteTextOf(month: FupanMonthPayload | null): string {
  const state = monthTradingStateOf(month)
  const why = typeof month?.calendarWhy === 'string' ? month.calendarWhy.trim() : ''
  if (state.kind === 'unknown') {
    return `交易日与休市：未知 —— ${state.reason ?? '原因未给出'}（因此不按交易日显示）${why === '' ? '' : `；${why}`}`
  }
  return `交易日与休市：按宿主交易日历标注（该月 ${state.total} 天）${why === '' ? '' : `；${why}`}`
}

/** 单格信息：`count === null` 表示**条数未知**（缺失不写 0） */
export interface FupanCellInfo {
  count: number | null
  hasPinned: boolean
  kind: TradingKind
  closedReason: string | null
  /**
   * 该日交易笔数（页面把 `monthTradeCountOf` / 按日惰性取数的结果并进来）。
   * `null` / `undefined` = 未取到或读取失败 ⇒ **不写进读屏文本**（不画 `▲0`）。
   */
  trades?: number | null
}

export function cellInfoOf(month: FupanMonthPayload | null, date: string): FupanCellInfo {
  const day = Array.isArray(month?.dates) ? month?.dates.find((d) => d?.date === date) : undefined
  const count = typeof day?.count === 'number' && Number.isFinite(day.count) ? day.count : null
  return {
    count,
    hasPinned: day?.hasPinned === true,
    kind: tradingKindOf(day),
    closedReason: typeof day?.closedReason === 'string' && day.closedReason !== '' ? day.closedReason : null,
  }
}

/** 月历格的读屏文本（日期 / 星期 / 交易日或休市 / 条数 / 交易笔数 / 是否有钉住） */
export function cellAriaOf(cell: FupanCell, info: FupanCellInfo, selected: boolean): string {
  const parts = [cell.date, weekdayLabelOf(cell.date), tradingLabelOf(info.kind, info.closedReason)]
  parts.push(info.count === null ? '条数未知' : `${info.count} 条笔记`)
  // 交易笔数未知/读取失败 ⇒ 这一句整个不出现（`▲0` 那种假数据不许进读屏文本）
  if (typeof info.trades === 'number' && Number.isFinite(info.trades) && info.trades > 0) parts.push(`${info.trades} 笔交易`)
  if (info.hasPinned) parts.push('含钉到该日的条目')
  if (selected) parts.push('已选中')
  return parts.filter((p) => p !== '').join('，')
}

// ── 笔记 / 钉住 ─────────────────────────────────────────────────────────

export interface DayNotes {
  /** 这一天写的（`date === day`） */
  own: FupanNoteDto[]
  /** 别天写的、钉到这一天的（`date !== day && pinnedTo === day`） */
  pinned: FupanNoteDto[]
}

function byAt(a: FupanNoteDto, b: FupanNoteDto): number {
  return (a.at ?? 0) - (b.at ?? 0) || String(a.id ?? '').localeCompare(String(b.id ?? ''))
}

/** 该日要显示的笔记：自己的在前、钉进来的在后（各自按写入时刻升序） */
export function notesOfDay(notes: readonly FupanNoteDto[] | null | undefined, day: string): DayNotes {
  const own: FupanNoteDto[] = []
  const pinned: FupanNoteDto[] = []
  for (const n of notes ?? []) {
    if (n === null || typeof n !== 'object') continue
    if (n.date === day) own.push(n)
    else if (n.pinnedTo === day) pinned.push(n)
  }
  own.sort(byAt)
  pinned.sort(byAt)
  return { own, pinned }
}

/**
 * 钉住标注。**「钉自」必须有**（否则目标日那条会被读成"那天写的"）；
 * 在它自己那一天则标「已钉到 X」，让用户知道这条还会出现在别处。
 */
export function pinBadgeOf(note: FupanNoteDto, day: string): { text: string; kind: 'from' | 'to' } | null {
  const to = typeof note.pinnedTo === 'string' ? note.pinnedTo : null
  if (to === null || to === '' || to === note.date) return null
  if (to === day) return { text: `钉自 ${note.date}`, kind: 'from' }
  if (note.date === day) return { text: `已钉到 ${to}`, kind: 'to' }
  return null
}

/** 某一日的列表状态：`empty`（真的没有）/ `unreadable` / `incomplete` 三者的区别不能糊 */
export type DayListState = 'list' | 'empty' | 'unreadable' | 'incomplete'

export function dayListStateOf(input: {
  count: number | null
  own: number
  pinned: number
  notesUnreadable: string | null
}): DayListState {
  if (input.notesUnreadable !== null) return 'unreadable'
  const shown = input.own + input.pinned
  if (shown === 0 && input.count !== null && input.count > 0) return 'incomplete'
  return shown === 0 ? 'empty' : 'list'
}

/** 宿主明说"笔记读不到"时的原因文字（`notesUnreadable` 可能是对象也可能是字符串） */
export function unreadableReasonOf(month: FupanMonthPayload | null): string | null {
  const raw = month?.notesUnreadable
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') return raw.trim() === '' ? '宿主未给出原因' : raw
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : ''
  return reason === '' ? '宿主未给出原因' : reason
}

/** 该月的笔记总数（`null` = 未知，**不写 0**） */
export function monthNoteTotalOf(month: FupanMonthPayload | null): number | null {
  if (month === null) return null
  const t = month.totals
  if (typeof t?.notes === 'number' && Number.isFinite(t.notes)) return t.notes
  if (Array.isArray(month.notes)) return month.notes.length
  if (Array.isArray(month.dates) && month.dates.every((d) => typeof d?.count === 'number')) {
    return month.dates.reduce((sum, d) => sum + (d.count as number), 0)
  }
  return null
}

/** 面板头部的计数文字（条数未知要如实写"未知"） */
export function monthTotalsTextOf(month: FupanMonthPayload | null): string {
  const total = monthNoteTotalOf(month)
  const pinned = typeof month?.totals?.pinned === 'number' && Number.isFinite(month.totals.pinned) ? month.totals.pinned : null
  const head = total === null ? '本月条数未知' : `本月 ${total} 条`
  if (pinned === null) return head
  return `${head} · 钉住 ${pinned} 条`
}

// ── 月历主体的状态机（「没有」与「没取到」分开写） ─────────────────────

/**
 * 月历主体该渲染哪一种。
 *
 * 这张表的**唯一不可交换的规则**：`failed` 永远压过 `empty`。
 * 取数失败时"有没有笔记"是未知的，渲染「本月暂无笔记」就是把失败说成了空 ——
 * 反例注入（`EMPTY_MASQUERADE`）在 impl83.test.ts 里证明这条会被抓住。
 */
export type MonthBodyState = 'loading' | 'failed' | 'empty' | 'blank' | 'grid'

export function monthBodyStateOf(input: {
  loading: boolean
  loadErr: string | null
  hasData: boolean
  /** `monthNoteTotalOf` 的结果（`null` = 未知） */
  total: number | null
  notesUnreadable: string | null
}): MonthBodyState {
  if (input.loading) return 'loading'
  // 失败优先：只要没有数据且报了原因，就**不许**落到 empty/blank
  if (input.loadErr !== null && !input.hasData) return 'failed'
  // 笔记读不到 ⇒ 网格照画（交易日骨架仍然有效），"读不到"由告警条与日面板说
  if (input.notesUnreadable !== null) return 'grid'
  if (input.total === null) return 'blank'
  if (input.total === 0) return 'empty'
  return 'grid'
}

// ── 空态（「没有」与「没取到」分开写） ─────────────────────────────────

export function emptyMonthTextOf(): { title: string; hint: string } {
  return {
    title: '本月暂无笔记',
    hint: '点月历里任意一天，在右侧写一条并点「保存」；保存后那天的格子会显示条数。想把某天的结论留到别的日子看 ⇒ 在编辑器里选「钉到」。',
  }
}

export function emptyDayTextOf(): { title: string; hint: string } {
  return {
    title: '这一天还没有笔记',
    hint: '在下方写一条并点「保存」（也可以选一个「钉到」的日期，让它出现在将来的那天）。',
  }
}

// ── 失败 / 丢弃 / 缺失 ─────────────────────────────────────────────────

function errTextOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

/**
 * 月历取数失败的原因。**必须**带路由与最可能的成因（宿主未注册 ⇒ 404；复盘行未启用），
 * 因为这条正是"页面不许空白"的落点。
 *
 * `afterWrite`：写成功后的**重取**失败。这时写入已经落盘，措辞必须与首取失败分开
 * （否则用户会以为刚才那条没保存）。
 */
export function monthFailTextOf(err: unknown, afterWrite = false): string {
  const head = afterWrite
    ? '写入已成功，但月历重取失败（界面继续显示写入前的月历，数字可能少一条）'
    : '复盘月历未取到'
  return `${head} —— ${errTextOf(err)}（GET /tradewatcher/fupan/month；宿主未注册该路由时返回 404，通常是复盘行未启用）`
}

export function monthFailHintOf(): string {
  return '这不是「本月暂无笔记」：月历没取到时，该月有没有笔记是「未知」的。点「重试」再取一次。'
}

export type WriteOp = 'create' | 'update' | 'delete' | 'pin'

export function writeVerbOf(op: WriteOp): string {
  if (op === 'create') return '新增'
  if (op === 'update') return '修改'
  if (op === 'delete') return '删除'
  return '钉住'
}

/** 写失败的原因（就地显示在编辑器旁边；⚠ 不许 `catch(() => {})` 静默） */
export function writeFailTextOf(op: WriteOp, err: unknown): string {
  return `${writeVerbOf(op)}失败（本次未写入，界面保留原内容）—— ${errTextOf(err)}（POST /tradewatcher/fupan/note）`
}

/** 写成功的回执（数据时刻来自宿主 `asOf`；没有就只报动作，不编时间） */
export function writeOkTextOf(op: WriteOp, stampText: string | null): string {
  return stampText === null ? `已${writeVerbOf(op)}` : `已${writeVerbOf(op)} · 数据时刻 ${stampText}`
}

/**
 * 宿主丢弃条目的提示（超上限后从最旧开始丢）。`count <= 0` ⇒ `null`（没有丢就不占版面）。
 * 形态容错：对象 `{count, reasons}` / 数字 / 字符串数组，认不出就只说条数、不编原因。
 */
export function droppedTextOf(dropped: FupanDropped | number | string[] | null | undefined): string | null {
  if (dropped === null || dropped === undefined) return null
  let count = 0
  let reasons: string[] = []
  if (typeof dropped === 'number') {
    count = dropped
  } else if (Array.isArray(dropped)) {
    count = dropped.length
    reasons = dropped.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
  } else if (typeof dropped === 'object') {
    if (typeof dropped.count === 'number' && Number.isFinite(dropped.count)) count = dropped.count
    else if (Array.isArray(dropped.notes)) count = dropped.notes.length
    if (Array.isArray(dropped.reasons)) reasons = dropped.reasons.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
  }
  if (!Number.isFinite(count) || count <= 0) return null
  const tail = reasons.length > 0 ? reasons.join('；') : '宿主未给原因'
  return `宿主丢弃了 ${count} 条最旧笔记（超出上限）：${tail}`
}

/** 回包 `missing[]` 的如实转述（原因分"上游没有"与"本次失败"两档，标签来自 shared/model） */
export function missingTextOf(missing: readonly FupanMissing[] | null | undefined, tierLabel: (why: string) => string): string | null {
  const list = Array.isArray(missing) ? missing.filter((m) => m !== null && typeof m === 'object') : []
  if (list.length === 0) return null
  const parts = list.map((m) => {
    const what = typeof m.what === 'string' && m.what !== '' ? m.what : '未命名项'
    const why = tierLabel(typeof m.why === 'string' ? m.why : 'transient')
    const note = typeof m.note === 'string' && m.note !== '' ? `：${m.note}` : ''
    return `${what}（${why}${note}）`
  })
  return `本次有未取到的项 —— ${parts.join('；')}`
}

/** 「这一天的笔记读不到」的整句（**读不到 ≠ 没有**，措辞必须把这件事说出来） */
export function unreadableTextOf(reason: string): string {
  return `这一天的笔记未取到（不是「没有笔记」）—— ${reason}`
}

/** 笔记文件被隔离 / 有条目被跳过时的披露（宿主给了就说，没给返回 null） */
export function quarantineTextOf(month: FupanMonthPayload | null): string | null {
  const parts: string[] = []
  const q = month?.notesQuarantined
  if (typeof q === 'string' && q.trim() !== '') {
    parts.push(`笔记文件内容不合法，原件已隔离到 ${q}（原字节保留，可人工恢复）`)
  }
  const bad = typeof month?.invalidEntries === 'number' && Number.isFinite(month.invalidEntries) ? month.invalidEntries : 0
  if (bad > 0) parts.push(`有 ${bad} 条形状不合法的笔记被跳过（未计入条数）`)
  return parts.length === 0 ? null : parts.join('；')
}

/** 该月交易日天数（宿主算的；没有就返回 null，不写 0） */
export function tradingDaysTextOf(month: FupanMonthPayload | null): string | null {
  const n = month?.totals?.tradingDays
  return typeof n === 'number' && Number.isFinite(n) ? `交易日 ${n} 天` : null
}

/**
 * 写成功之后的**附加披露**（丢弃 / 写后读不到 / 隔离）。空数组 = 没有要说的。
 * 这条的存在理由：写接口可能"成功但丢了最旧的几条"或"写进去了但读不出来"，
 * 只显示"已保存"会让用户以为一切完好。
 */
export function writeWarningsOf(result: FupanNoteResult): string[] {
  const out: string[] = []
  const drop = droppedTextOf(result.dropped)
  if (drop !== null) out.push(drop)
  const raw = result.notesUnreadable
  const un = typeof raw === 'string' ? raw.trim() : (raw !== null && typeof raw === 'object' && typeof raw.reason === 'string' ? raw.reason.trim() : '')
  if (un !== '') out.push(unreadableTextOf(un))
  const q = result.notesQuarantined
  if (typeof q === 'string' && q.trim() !== '') out.push(`写入后笔记文件出现不合法内容，原件已隔离到 ${q}`)
  return out
}

// ── 写入请求体 ─────────────────────────────────────────────────────────

export interface WriteInput {
  op: WriteOp
  date: string
  id?: string
  text?: string
  pinnedTo?: string | null
}

/**
 * POST body 的唯一构造出口（宿主契约 `{ op:'upsert'|'delete', date, id?, text?, pinnedTo? }`）。
 *
 * `pin` 会把**原文一并带上**：宿主的 upsert 是整体覆盖语义，只发 `pinnedTo` 有丢掉正文的风险。
 */
export function noteBodyOf(input: WriteInput): Record<string, unknown> {
  const date = input.date
  if (input.op === 'delete') return { op: 'delete', date, id: input.id }
  const body: Record<string, unknown> = { op: 'upsert', date }
  if (input.id !== undefined && input.id !== '') body.id = input.id
  if (input.text !== undefined) body.text = input.text
  body.pinnedTo = input.pinnedTo === undefined || input.pinnedTo === '' ? null : input.pinnedTo
  return body
}

/** 提交前的本地校验（返回错误原因；`null` = 可提交）。**不替代**宿主校验，只是省一次往返 */
export function writeInputProblems(input: WriteInput): string | null {
  if (!isDateText(input.date)) return `日期格式不对：${input.date}（应为 YYYY-MM-DD）`
  if (input.op === 'delete' || input.op === 'pin') {
    if (input.id === undefined || input.id === '') return '这条笔记缺少 id，无法定位（请重新取一次月历）'
  }
  if (input.op === 'create' || input.op === 'update' || input.op === 'pin') {
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (text === '') return '笔记内容不能为空（空白不会被保存）'
  }
  const pin = input.pinnedTo
  if (pin !== undefined && pin !== null && pin !== '') {
    if (!isDateText(pin)) return `钉到的日期格式不对：${pin}（应为 YYYY-MM-DD）`
    /**
     * 「钉到未来某日」只在**新建**时强制（这条功能的名字就是未来）。
     * 改一条**已存在**的笔记不加这条限制：手工改过 `fupan.json`（`source:'import'`）的条目
     * 可能本来就钉在更早的日子，加了限制它就变成"改不动、也清不掉"的僵尸。
     */
    if (input.op === 'create' && pin < input.date) return `钉到的日期不能早于这条笔记的日期（${pin} < ${input.date}）`
  }
  return null
}

/** 字数（按码点算，emoji 不会被算成两个字） */
export function charCountTextOf(text: string): string {
  return `${[...text].length} 字`
}

// ── 键盘 ───────────────────────────────────────────────────────────────

/**
 * 日期格的焦点移动（`↑↓←→ Home/End`）。返回 `null` = 不处理这个键（交给浏览器）。
 *
 * 三条约定（都为了"别做出用户没预期的跳月"）：
 *  ① 左右是**同一平面**的 −1/+1（跨行时会走到上一行末尾，这是网格导航的标准行为）；
 *  ② 上下的目标越界时**原地不动**（不夹到最后一格 —— 那会让人突然选中 11-01）；
 *  ③ Home/End 落在**本月**的第一天/最后一天，而不是网格的补格（补格属于相邻月）。
 */
export function moveCellFocus(cells: readonly FupanCell[], index: number, key: string): number | null {
  if (cells.length === 0) return null
  const last = cells.length - 1
  const cur = Math.min(Math.max(index, 0), last)
  const clamp = (i: number): number => Math.min(Math.max(i, 0), last)
  if (key === 'ArrowLeft') return clamp(cur - 1)
  if (key === 'ArrowRight') return clamp(cur + 1)
  if (key === 'ArrowUp') return cur - FUPAN_GRID_COLS >= 0 ? cur - FUPAN_GRID_COLS : cur
  if (key === 'ArrowDown') return cur + FUPAN_GRID_COLS <= last ? cur + FUPAN_GRID_COLS : cur
  const inMonth = cells.map((c, i) => (c.inMonth ? i : -1)).filter((i) => i >= 0)
  const first = inMonth[0] ?? 0
  const lastIn = inMonth[inMonth.length - 1] ?? last
  if (key === 'Home') return first
  if (key === 'End') return lastIn
  return null
}
