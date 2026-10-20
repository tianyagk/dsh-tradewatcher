/**
 * 复盘（第 8 行 `fupan`）的**宿主存储 + 纯计算**。
 *
 * 概念参考第三方插件 `dsh-fupan`（MIT）的"月历 + 当日复盘"功能，**代码/样式一行未取**（见
 * `docs/AUDIT-IMPL82.md` §6）。本文件只做三件事：
 *   ① 一份**有界**的本地笔记文件（读走 `ReadGuard`，写走 `updateJsonLocked`）；
 *   ② 纯函数：条目归一 / 增改删 / 上限裁剪（可单测、不碰 IO）；
 *   ③ 整月视图的**交易日标注**（复用既有 `tradingCalendar.ts` + `rescue.ts` 的 `tradingDayState`）。
 *
 * 数据文件：`<DSH_HOME>/dsh-tradewatcher/fupan.json`
 * ```json
 * { "v": 1, "notes": [
 *   { "id": "f…", "date": "2026-10-20", "text": "…", "pinnedTo": "2026-10-27", "source": "manual", "at": 1760000000000 }
 * ] }
 * ```
 *
 * ## 三条硬口径（每条都配了反例注入，见 `src/host/fupan.test.ts`）
 *
 * 1. **读不到 ≠ 没有**：`readFile` 只把 `ENOENT` 当作"本来就没有"（首装），其它 errno
 *    （`EACCES`/`EIO`/`EISDIR`…）一律 `ReadGuard.markUnreadable` ⇒ 本次启动**拒绝写回**
 *    （`assertWritable` 在锁内抛 `UnreadableFileError`）。与 `store.ts`/`calendar.ts` 同一判据。
 *    读到了但内容是坏 JSON/坏形状 ⇒ **改名隔离保留原字节**（`quarantineFile`），绝不静默覆写。
 * 2. **写入必须锁内读-改-写**：`updateJsonLocked` 进锁后先读**磁盘最新**，再改、再原子写回。
 *    为什么不能拿内存快照整份覆写：两个进程（或两次并发）各改各的时候，后写者会把先写者
 *    刚记下的笔记整份抹掉（`lock.ts` 文件头记的就是这个事故）。
 * 3. **有界且不静默**：单条正文 `FUPAN_MAX_TEXT` 字、总条数 `FUPAN_MAX_NOTES`、文件体积
 *    `FUPAN_MAX_BYTES`。单条超长 ⇒ **拒绝**（400，不做静默截断 —— 截断就是改用户内容）；
 *    条数/体积超限 ⇒ 按"最久未更新"（`at` 最小）丢弃并逐条写进回包的 `dropped` 段。
 *    置顶（`pinnedTo` 非空）的笔记**最后**才被丢 —— 置顶是用户对未来的承诺。
 *
 * ## `at` 的语义
 * `at` = **最后一次写入时刻**（更新会刷新它）。所以"按最旧丢"= 按"最久没动过"丢。
 * 只有这一个时间字段（schema 是任务给定的），不再多加 `createdAt` 让两份时间互相漂移。
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { log } from './context.ts'
import { HttpError } from './http.ts'
import { updateJsonLocked, type LockOptions } from './lock.ts'
import { isFirstBoot, quarantineFile, ReadGuard } from './readGuard.ts'
import { tradingDayState } from './rescue.ts'
import { dataHome } from './store.ts'
import { dayOf } from './time.ts'
import { loadTradingCalendar, monthCoveredByFile, type TradingCalendarStatus } from './tradingCalendar.ts'

/** 数据文件名（与 `dataHome()` 同目录；不进仓库，升级不会覆盖用户笔记） */
export const FUPAN_FILE = 'fupan.json'
/** 单条正文上限（字）。超限**拒绝**而不是截断。 */
export const FUPAN_MAX_TEXT = 4000
/** 总条数上限。超限按最久未更新丢弃并留痕。 */
export const FUPAN_MAX_NOTES = 2000
/** 文件体积上限（字节，序列化后）。超限按最久未更新丢弃并留痕。 */
export const FUPAN_MAX_BYTES = 512 * 1024

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export type FupanSource = 'manual' | 'import'

export interface FupanNote {
  id: string
  /** 这条笔记写的是**哪一天**的复盘（YYYY-MM-DD） */
  date: string
  text: string
  /** 「钉到未来某日」（YYYY-MM-DD）；空 = 不置顶 */
  pinnedTo?: string
  source: FupanSource
  /** 最后一次写入时刻（ms） */
  at: number
}

export interface FupanFile {
  v: 1
  notes: FupanNote[]
}

/** 被上限丢掉的条目（**逐条**留痕，不许只报一个数字） */
export interface FupanDrop {
  id: string
  date: string
  at: number
  reason: 'notes-limit' | 'file-size-limit'
}

/** 上限的机器原因 → 人话（回包 `dropped.reasons` 用；同一档只留一种说法） */
export const FUPAN_DROP_TEXT: Record<FupanDrop['reason'], string> = {
  'notes-limit': `条数已达上限 ${FUPAN_MAX_NOTES} 条 ⇒ 按「最久未更新」丢弃最旧的（置顶的最后才丢）`,
  'file-size-limit': `文件体积已达上限 ${FUPAN_MAX_BYTES} 字节（512 KB）⇒ 按「最久未更新」丢弃最旧的（置顶的最后才丢）`,
}

export interface FupanWriteOp {
  op: 'upsert' | 'delete'
  id: string
  date?: string
  text?: string
  pinnedTo?: string | null
}

export interface FupanWritten {
  note: FupanNote | null
  removed: number
  dropped: FupanDrop[]
}

interface NoteShape {
  notes: FupanNote[]
  invalidEntries: number
}

/** 单条归一：形状不合法返回 `null`（调用方计数并披露，不许静默跳过） */
function normalizeNote(raw: unknown): FupanNote | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id : ''
  if (!ID_RE.test(id)) return null
  const date = typeof o.date === 'string' ? o.date : ''
  if (!DATE_RE.test(date)) return null
  const text = typeof o.text === 'string' ? o.text : null
  if (text === null || text.trim() === '') return null
  const at = typeof o.at === 'number' && Number.isFinite(o.at) && o.at > 0 ? o.at : null
  if (at === null) return null
  const source: FupanSource = o.source === 'import' ? 'import' : 'manual'
  const note: FupanNote = { id, date, text, source, at }
  if (typeof o.pinnedTo === 'string' && DATE_RE.test(o.pinnedTo)) note.pinnedTo = o.pinnedTo
  return note
}

/**
 * 整文件归一（纯函数）。
 *
 * - 顶层形状不认识（`v !== 1` / `notes` 不是数组）⇒ `null` ⇒ 调用方**隔离原件**后从空开始；
 * - 单条不认识 ⇒ 跳过后计数（`invalidEntries`），随回包披露 —— 不因为一条坏条目
 *   把用户其余几百条笔记一起隔离掉。
 */
export function parseFupanFile(raw: unknown): NoteShape | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (obj.v !== 1) return null
  if (!Array.isArray(obj.notes)) return null
  const notes: FupanNote[] = []
  const seen = new Set<string>()
  let invalidEntries = 0
  for (const item of obj.notes) {
    const note = normalizeNote(item)
    if (note === null || seen.has(note.id)) {
      invalidEntries += 1
      continue
    }
    seen.add(note.id)
    notes.push(note)
  }
  return { notes, invalidEntries }
}

/** 排序口径（唯一一处）：置顶的最后被丢，其余按"最久未更新" */
function dropOrder(a: FupanNote, b: FupanNote): number {
  const pinA = a.pinnedTo === undefined ? 0 : 1
  const pinB = b.pinnedTo === undefined ? 0 : 1
  if (pinA !== pinB) return pinA - pinB
  if (a.at !== b.at) return a.at - b.at
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** 该文档按落盘口径的字节数（与 `writeJsonAtomic` 的序列化完全一致） */
function bytesOf(file: FupanFile): number {
  return Buffer.byteLength(JSON.stringify(file, null, 1), 'utf8')
}

/**
 * 上限裁剪（纯函数）。
 *
 * 返回**新**文档与逐条丢弃记录；顺序：先按条数、再按体积（两者可同时触发）。
 * 至少留下 1 条（`notes.length > 1` 是循环条件）：单条 4000 字的笔记远小于 512 KB，
 * 所以"留最后一条"不会把体积卡在上限之上。
 */
export function trimFupan(file: FupanFile): { file: FupanFile; dropped: FupanDrop[] } {
  const queue = [...file.notes].sort(dropOrder)
  const dropped: FupanDrop[] = []
  let current: FupanFile = { v: 1, notes: queue }
  // 两道闸同款实现：谁先触发按谁的 `reason` 留痕（两者可能都触发）
  const limits: Array<{ hit: (f: FupanFile) => boolean; reason: FupanDrop['reason'] }> = [
    { hit: (f) => f.notes.length > FUPAN_MAX_NOTES, reason: 'notes-limit' },
    { hit: (f) => bytesOf(f) > FUPAN_MAX_BYTES, reason: 'file-size-limit' },
  ]
  for (const { hit, reason } of limits) {
    while (current.notes.length > 1 && hit(current)) {
      const victim = current.notes[0] as FupanNote
      dropped.push({ id: victim.id, date: victim.date, at: victim.at, reason })
      current = { v: 1, notes: current.notes.slice(1) }
    }
  }
  return { file: current, dropped }
}

/**
 * 增/改/删一条（纯函数）。
 *
 * 定位规则（任务给的是"按 id 或 (date, id)"）：
 *   - `id` 命中 ⇒ 更新；此时若同时给了 `date` 且与原条目日期不符 ⇒ **409**
 *     （说明按 `(date, id)` 定位失败 —— 想移动日期请先删再建，别让一条笔记静默换日）；
 *   - `id` 未命中 ⇒ **用调用方给的 id 新建**（客户端可自行生成 id 做幂等重试）；
 *   - 删除时 `id` 未命中 ⇒ **404**（不静默成功）。
 *
 * 输入上限单条正文超过 `FUPAN_MAX_TEXT` ⇒ **400**（拒绝，不截断）。
 */
export function applyFupanOp(file: FupanFile, op: FupanWriteOp, now: number): { file: FupanFile; written: FupanWritten } {
  const notes = [...file.notes]
  if (op.op === 'delete') {
    const idx = notes.findIndex((n) => n.id === op.id)
    if (idx < 0) throw new HttpError(`没有 id=${op.id} 的复盘笔记（删除前请先刷新整月视图）`, 404)
    const victim = notes[idx] as FupanNote
    if (op.date !== undefined && op.date !== victim.date) {
      throw new HttpError(`id=${op.id} 是 ${victim.date} 的笔记，与请求日期 ${op.date} 不符（按 (date, id) 定位失败）`, 409)
    }
    notes.splice(idx, 1)
    return { file: { v: 1, notes }, written: { note: victim, removed: 1, dropped: [] } }
  }
  if (op.date === undefined || !DATE_RE.test(op.date)) throw new HttpError('date 必须是 YYYY-MM-DD', 400)
  const text = op.text ?? ''
  if (text.trim() === '') throw new HttpError('笔记正文不能为空（要删除请用 op: delete）', 400)
  if (text.length > FUPAN_MAX_TEXT) {
    throw new HttpError(`笔记正文 ${text.length} 字 > 上限 ${FUPAN_MAX_TEXT} 字：本接口不做静默截断（截断=改你的内容），请精简后重试`, 400)
  }
  if (op.pinnedTo !== undefined && op.pinnedTo !== null && !DATE_RE.test(op.pinnedTo)) {
    throw new HttpError('pinnedTo 必须是 YYYY-MM-DD（清除置顶传 null）', 400)
  }
  const idx = notes.findIndex((n) => n.id === op.id)
  if (idx >= 0) {
    const prev = notes[idx] as FupanNote
    if (op.date !== prev.date) {
      throw new HttpError(`id=${op.id} 原是 ${prev.date} 的笔记，与请求日期 ${op.date} 不符（按 (date, id) 定位失败）—— 想换日期请先删除再新建`, 409)
    }
    const next: FupanNote = { id: prev.id, date: prev.date, text, source: prev.source, at: now }
    if (op.pinnedTo !== undefined) {
      if (op.pinnedTo !== null) next.pinnedTo = op.pinnedTo
    } else if (prev.pinnedTo !== undefined) next.pinnedTo = prev.pinnedTo
    notes[idx] = next
    return { file: { v: 1, notes }, written: { note: next, removed: 0, dropped: [] } }
  }
  const created: FupanNote = { id: op.id, date: op.date, text, source: 'manual', at: now }
  if (op.pinnedTo !== undefined && op.pinnedTo !== null) created.pinnedTo = op.pinnedTo
  notes.push(created)
  return { file: { v: 1, notes }, written: { note: created, removed: 0, dropped: [] } }
}

/**
 * 请求体 → 写入指令（纯函数，校验全在这里）。
 *
 * 校验是**逐字段给原因**的：400 的 message 会被界面原样显示，含糊的"参数错误"等于没提示。
 */
export function parseFupanOp(body: unknown): FupanWriteOp {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError('请求体必须是 JSON 对象', 400)
  const b = body as Record<string, unknown>
  const raw = typeof b.op === 'string' ? b.op.trim() : ''
  if (raw !== 'upsert' && raw !== 'delete') throw new HttpError('op 只接受 upsert（新增或更新）或 delete（删除）', 400)
  const id = typeof b.id === 'string' ? b.id.trim() : ''
  if (id === '' && raw === 'delete') throw new HttpError('delete 必须带 id（按 id 或 (date, id) 定位）', 400)
  const date = typeof b.date === 'string' ? b.date.trim() : undefined
  if (date !== undefined && date !== '' && !DATE_RE.test(date)) throw new HttpError('date 必须是 YYYY-MM-DD', 400)
  if (raw === 'upsert' && (date === undefined || date === '')) throw new HttpError('upsert 必须带 date（YYYY-MM-DD）', 400)
  if (raw === 'upsert' && typeof b.text !== 'string') throw new HttpError('upsert 必须带 text（笔记正文）', 400)
  // 长度先在**门口**判：超长不该先开锁读一遍磁盘（applyFupanOp 里仍保留同一条判据，纵深防御）
  if (raw === 'upsert' && typeof b.text === 'string' && b.text.length > FUPAN_MAX_TEXT) {
    throw new HttpError(`笔记正文 ${b.text.length} 字 > 上限 ${FUPAN_MAX_TEXT} 字：本接口不做静默截断（截断=改你的内容），请精简后重试`, 400)
  }
  const pinned = b.pinnedTo
  if (pinned !== undefined && pinned !== null && typeof pinned !== 'string') throw new HttpError('pinnedTo 必须是 YYYY-MM-DD 或 null', 400)
  const op: FupanWriteOp = {
    op: raw,
    // 新建时客户端可以不传 id ⇒ 由 store 生成（见 FupanStore.newId）
    id: id === '' ? '' : id,
  }
  if (id !== '' && !ID_RE.test(id)) throw new HttpError('id 只允许字母/数字/下划线/连字符（≤64 字符）', 400)
  if (date !== undefined && date !== '') op.date = date
  if (raw === 'upsert') {
    op.text = b.text as string
    if (pinned === null) op.pinnedTo = null
    else if (typeof pinned === 'string' && pinned.trim() !== '') op.pinnedTo = pinned.trim()
  }
  return op
}

/** `YYYY-MM` → 该月全部日期（28–31 条；用 UTC 算术，与时区无关） */
export function monthDays(ym: string): string[] {
  const [y, m] = ym.split('-').map(Number)
  const count = new Date(Date.UTC(y as number, m as number, 0)).getUTCDate()
  return Array.from({ length: count }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`)
}

/** 校验 `ym` 查询参数（返回规范化值；不合法抛 400） */
export function parseFupanMonth(raw: unknown): string {
  const ym = typeof raw === 'string' ? raw.trim() : ''
  if (!MONTH_RE.test(ym)) throw new HttpError('ym 应为 YYYY-MM（例如 2026-10）', 400)
  return ym
}

/** 该月的笔记：写在这一天（`date`）或**钉到**这一天（`pinnedTo`）的都要给 */
export function notesInMonth(notes: readonly FupanNote[], ym: string): FupanNote[] {
  return notes
    .filter((n) => n.date.startsWith(`${ym}-`) || (n.pinnedTo !== undefined && n.pinnedTo.startsWith(`${ym}-`)))
    .sort((a, b) => (a.date === b.date ? (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at - b.at) : a.date < b.date ? -1 : 1))
}

/** 某一天的笔记（`date` 恰为这天） */
export function notesOnDay(notes: readonly FupanNote[], date: string): FupanNote[] {
  return notes.filter((n) => n.date === date).sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at - b.at))
}

export interface FupanDay {
  date: string
  /** 写在这一天的笔记条数 */
  count: number
  /** 有笔记**钉到**这一天（未来日期的角标靠它；与 count 无关） */
  hasPinned: boolean
  /** 是否交易日（来自既有交易日历判定链；**恒给**，不靠客户端猜） */
  trading: boolean
  /** 休市原因（交易日为 null）：`周末` / 假日名 / `外部日历（手工维护）` */
  closedReason: string | null
}

export interface FupanCalendarInfo {
  /** 外部交易日历文件是否**声明了**这个月（缺键 = 未覆盖；`[]` = 覆盖但无法定休市） */
  covered: boolean
  /** 既有判定链（`monthCoveredByFile`）这次是否真的按外部文件判定该月 */
  inForce: boolean
  /** 生效来源：external = 外部文件覆盖当前月；builtin = 内置假日表 */
  source: TradingCalendarStatus['source']
  fileExists: boolean
  /** 文件里已覆盖的月份（排序） */
  months: string[]
  warning: string | null
  /** 文件不合法时的原因（已退回内置表） */
  invalidReason: string | null
  ignoredWeekends: number
}

export interface FupanMonthView {
  dates: FupanDay[]
  calendar: FupanCalendarInfo
  /** 覆盖不足/未生效的原因（`null` = 该月真的按外部文件判定）—— 不许写 0 或空串 */
  calendarWhy: string | null
  /** 口径一行（回包 `source` 用） */
  source: string
}

/**
 * 整月视图的日期骨架 + 交易日标注（**零上游请求**：只读本地交易日历文件 + 纯函数判定）。
 *
 * 交易日**只由 `tradingDayState` 判定**（周末 → 外部文件 → 内置表，一处实现）——
 * 这里再写一遍 `星期 === 0/6` 就会把国庆/调休当成交易日（反例注入见测试 ⑤）。
 */
export async function fupanMonthView(notes: readonly FupanNote[], ym: string, now = Date.now()): Promise<FupanMonthView> {
  const status = await loadTradingCalendar()
  const covered = status.fileExists && status.invalid === null && Object.prototype.hasOwnProperty.call(status.monthsByKey, ym)
  const inForce = monthCoveredByFile(ym)
  const calendar: FupanCalendarInfo = {
    covered,
    inForce,
    source: status.source,
    fileExists: status.fileExists,
    months: status.months,
    warning: status.warning,
    invalidReason: status.invalid === null ? null : status.invalid.reason,
    ignoredWeekends: status.ignoredWeekends,
  }
  const today = dayOf(now)
  const calendarWhy = covered && inForce
    ? null
    : status.fileExists === false
      ? `外部交易日历文件不存在（${status.path}）⇒ ${ym} 的休市日只按内置假日表 + 周末判定：法定调休/临时休市会被当成交易日（要精确请新建该文件并写上 "${ym}": []）`
      : status.invalid !== null
        ? `外部交易日历文件不合法（${status.invalid.reason}）⇒ 已退回内置假日表 + 周末判定，${ym} 的休市标注可能失真`
        : covered === false
          ? `外部交易日历未覆盖 ${ym}（文件里只有 ${status.months.length === 0 ? '（无）' : status.months.join('、')}）⇒ 该月按内置假日表 + 周末判定；内置表只登记了 2026 年的法定假日，其它年份的调休会被当成交易日`
          : `外部交易日历已声明 ${ym}，但既有判定链（tradingCalendar 的 monthCoveredByFile）只在该月为「当前月」时按文件生效（当前 ${today.slice(0, 7)}）⇒ 这次仍按内置假日表 + 周末判定`
  const dates: FupanDay[] = monthDays(ym).map((date) => {
    // 12:00 是刻意的：避开夏令时/时区边界把北京日推到前一天
    const state = tradingDayState(Date.parse(`${date}T12:00:00+08:00`))
    const pinned = notes.some((n) => n.pinnedTo === date)
    return {
      date,
      count: notes.filter((n) => n.date === date).length,
      hasPinned: pinned,
      trading: state.trading,
      closedReason: state.trading ? null : (state.label ?? (state.reason === 'weekend' ? '周末' : '休市')),
    }
  })
  return { dates, calendar, calendarWhy, source: 'local:fupan.json+calendar:trading-calendar.json' }
}

export interface FupanReadState {
  notes: FupanNote[]
  /** 读不到的原因（`null` = 读到了或本来就没有）。**读不到 ≠ 没有** —— 回包必须带上它 */
  unreadable: string | null
  /** 读到了但内容坏 ⇒ 已隔离的原件路径（原字节保留，可人工恢复） */
  quarantined: string | null
  /** 形状不合法被跳过的条目数（披露，不静默） */
  invalidEntries: number
}

/**
 * 复盘笔记的本地存储。
 *
 * 与 `CalendarStore`/`DataStore` 同款：`init()` 幂等、读失败守卫、写前 `assertWritable`。
 * 差别只有一个 —— **写回走 `updateJsonLocked`**（任务要求），不是"拿内存快照整份覆写"：
 * 因为笔记可能被两个进程同时写（例如用户在两个浏览器 profile 各开一个 `dsh web`）。
 */
export class FupanStore {
  private readonly dir: string
  private readonly readGuard = new ReadGuard()
  private loaded: Promise<void> | null = null
  private seq = 0
  private state: FupanReadState = { notes: [], unreadable: null, quarantined: null, invalidEntries: 0 }

  constructor(dir: string = dataHome()) {
    this.dir = dir
  }

  /** 数据文件完整路径（回包的 `source`/`missing` 里要能指出"哪个文件没读到"） */
  path(): string {
    return join(this.dir, FUPAN_FILE)
  }

  /** 幂等装载：首装（ENOENT）⇒ 空是真的；其它 errno ⇒ 记封锁 + 拒绝写回；坏内容 ⇒ 隔离原件 */
  async init(): Promise<void> {
    if (this.loaded !== null) return this.loaded
    this.loaded = (async () => {
      await mkdir(this.dir, { recursive: true }).catch(() => undefined)
      let raw: string
      try {
        raw = await readFile(this.path(), 'utf8')
        this.readGuard.clear(this.path())
      } catch (error) {
        if (isFirstBoot(error)) return /* 首装：确实还没有这份文件 ⇒ 空是真的 */
        const reason = this.readGuard.markUnreadable(this.path(), error)
        this.state.unreadable = reason
        log(`fupan read failed: ${reason} —— 读不到 ≠ 没有笔记：本次启动拒绝写回 ${FUPAN_FILE}`)
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        const kept = await quarantineFile(this.path())
        this.state.quarantined = kept
        if (kept === null) this.state.unreadable = this.readGuard.markUnreadable(this.path(), error)
        log(`corrupt ${FUPAN_FILE} (bad JSON) — ${kept === null ? '隔离失败，已改为不写回' : `已隔离为 ${kept}`}`)
        return
      }
      const norm = parseFupanFile(parsed)
      if (norm === null) {
        const kept = await quarantineFile(this.path())
        this.state.quarantined = kept
        if (kept === null) this.state.unreadable = this.readGuard.markUnreadable(this.path(), new Error('顶层形状不认识'))
        log(`invalid ${FUPAN_FILE} shape — ${kept === null ? '隔离失败，已改为不写回' : `已隔离为 ${kept}`}`)
        return
      }
      this.state.notes = norm.notes
      this.state.invalidEntries = norm.invalidEntries
      if (norm.invalidEntries > 0) log(`${FUPAN_FILE} 有 ${norm.invalidEntries} 条形状不合法 —— 已跳过（原件未改动，随回包披露）`)
    })()
    return this.loaded
  }

  /** 当前读到的状态（只读视图；`notes` 不要原地改） */
  readState(): FupanReadState {
    return this.state
  }

  /** 写入一条（新增/更新/删除）。**锁内**读磁盘最新 → 改 → 裁剪 → 原子写回。 */
  async write(op: FupanWriteOp, lockOpts: LockOptions = {}): Promise<FupanWritten> {
    await this.init()
    // 进锁**之前**先给一次"读不到 ⇒ 拒绝写回"的明确错误：锁内的 assertWritable 仍然保留（纵深防御），
    // 但锁内的第一步是读磁盘（`readJsonForUpdate`），读失败会抛出裸 fs 错误 —— 那对用户只是噪音。
    this.readGuard.assertWritable(this.path(), '写回复盘笔记')
    const now = Date.now()
    const id = op.id === '' ? this.newId() : op.id
    /** 锁内回调的返回值容器（`let` 在闭包里赋值不会让 TS 的类型收窄跟着走，故用一个对象承接） */
    const out: { value?: FupanWritten } = {}
    const written = (await updateJsonLocked(
      this.path(),
      (disk) => {
        // 「读不到」≠「空」：读失败过的文件绝不允许拿空库整份覆写（与 store.ts 同一条红线）
        this.readGuard.assertWritable(this.path(), '写回复盘笔记')
        const parsed = disk === null ? { notes: [], invalidEntries: 0 } : parseFupanFile(disk)
        if (parsed === null) {
          // 锁内读到的内容不认识 ⇒ 不动它（宁可这次写失败，也不抹掉用户的文件）
          throw new HttpError(`${FUPAN_FILE} 内容形状不合法：拒绝在锁内改写它（先修好该文件再重试）`, 500)
        }
        const applied = applyFupanOp({ v: 1, notes: parsed.notes }, { ...op, id }, now)
        const trimmed = trimFupan(applied.file)
        out.value = {
          note: applied.written.note,
          removed: applied.written.removed,
          dropped: [...applied.written.dropped, ...trimmed.dropped],
        }
        return trimmed.file
      },
      { note: 'fupan:note', ...lockOpts },
    )) as FupanFile
    const result = out.value
    if (result === undefined) throw new Error('fupan write 未产生结果（锁内回调没有跑完）')
    // 内存镜像**以刚落盘的那份为准**（下一次读取立即看到写入结果 + 裁剪后的真实集合）
    this.state.notes = written.notes
    this.state.invalidEntries = 0
    return result
  }

  private newId(): string {
    this.seq += 1
    return `f${Date.now().toString(36)}${randomBytes(3).toString('hex')}${this.seq.toString(36)}`
  }
}
