/**
 * 交易日历的**外部覆盖文件**（每月手工更新一次；不进代码仓库）。
 *
 * 位置：`<DSH_HOME>/dsh-tradewatcher/trading-calendar.json`（与其余状态同目录，**不是**仓库文件
 * ⇒ 升级/重装本插件不会覆盖用户的日历，用户也不必改代码）。
 *
 * 格式（**按月列休市日**，不是列交易日）：
 * ```json
 * {
 *   "v": 1,
 *   "source": "上交所 2026 年部分节假日休市安排（上证公告〔2025〕45号）",
 *   "updatedAt": "2026-10-08",
 *   "months": {
 *     "2026-10": ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"],
 *     "2026-11": []
 *   }
 * }
 * ```
 *
 * 为什么选「列休市日」而不是「列交易日」：一个月里**法定休市的工作日只有 0–5 天**，而交易日有 18–23 天
 * （差 4–5 倍）。休市日是"从公告里抄下来的例外"，交易日是"整月的枚举" —— 前者写得更少、更不容易抄错，
 * 而且**周末不必列**（周末由 `shWeekdayOf` 判定，列进去只会重复）。没有法定休市的月份写一条
 * `"2026-11": []` 即可，这同时是"本月已被覆盖"的显式标记（空数组 ≠ 缺键）。
 *
 * 优先级：**外部文件 > 内置表 > 周末规则**（`rescue.ts` 的 `tradingDayState`）。
 * 失败方向：文件缺失/损坏/未覆盖当月 ⇒ 退回内置表；内置表也没命中 ⇒ 按交易日处理（= **多采一天**），
 * 不会把真交易日误判成休市（漏采真实信号是更糟的失败）。任何退回都**必须在界面与工具输出里可见**。
 */
import { readFileSync, statSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataHome } from './store.ts'
import { dayOf as shDayOf, weekdayOf as shWeekdayOf } from './time.ts'

export const TRADING_CALENDAR_FILE = 'trading-calendar.json'

export interface TradingCalendarFile {
  v: 1
  source?: string
  updatedAt?: string
  months: Record<string, string[]>
}

export interface TradingCalendarStatus {
  /** 生效来源：external = 外部文件；builtin = 内置表 */
  source: 'external' | 'builtin'
  path: string
  /** 文件声明的月份键（无文件时为 []） */
  months: string[]
  /** **当前月**是否被文件覆盖（缺键 = 未覆盖；`[]` = 已覆盖但本月无法定休市） */
  coveredThisMonth: boolean
  /** 覆盖当月时：本月法定休市日（已忽略周末条目） */
  closuresThisMonth: string[]
  /** 被忽略的周末条目数（用户在休市区间里连周末一起抄了 —— 无害，但要如实说） */
  ignoredWeekends: number
  /** 可见告警（未覆盖/损坏/隔离）；`null` = 一切正常 */
  warning: string | null
  /** 文件坏了：隔离去向 + 原因（留痕，不静默） */
  invalid: { reason: string; quarantinePath: string | null } | null
  /** 外部文件是否真的被读到了（false ⇒ 文件不存在） */
  fileExists: boolean
  /** 内部用：文件里的月份 → 该月休市日（`monthCoveredByFile` 判"缺键 vs 空数组"靠它） */
  monthsByKey: Record<string, string[]>
}

interface Cache {
  path: string
  mtimeMs: number
  size: number
  status: TradingCalendarStatus
  /** 全部外部休市日（跨月合并；周末条目已剔除） */
  closures: Set<string>
}

let cache: Cache | null = null

export function tradingCalendarPath(): string {
  return join(dataHome(), TRADING_CALENDAR_FILE)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-\d{2}$/

/**
 * 校验外部文件（**纯函数**，便于对拍）：返回 `{ ok: true, data }` 或 `{ ok: false, reason }`。
 *
 * 硬失败（⇒ 隔离 + 退回内置）：
 *   - JSON 解析失败 / `v !== 1` / `months` 不是对象或为空；
 *   - 月份键不是 `YYYY-MM`；值不是数组；日期不是 `YYYY-MM-DD`；
 *   - 日期**不属于它所在的月份**（自相矛盾）；
 *   - **任意重复**（同月内或跨月重复 ⇒ 抄写事故）。
 * 软提示（不隔离，如实计入 `ignoredWeekends`）：条目落在周末 —— 周末本来就休市，多写无害，
 *   但它通常意味着用户把整段假期（含周末）抄了下来，界面上要能看到"已忽略 N 条"。
 */
export type CalendarValidation =
  | { ok: true; data: TradingCalendarFile; ignoredWeekends: number }
  | { ok: false; reason: string }

export function validateTradingCalendar(raw: unknown): CalendarValidation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: '顶层必须是对象' }
  const obj = raw as Record<string, unknown>
  if (obj.v !== 1) return { ok: false, reason: `v 必须是 1（收到 ${JSON.stringify(obj.v)}）—— 版本不认识时不许猜` }
  const months = obj.months
  if (months === null || typeof months !== 'object' || Array.isArray(months)) return { ok: false, reason: 'months 必须是对象（键 = YYYY-MM，值 = 该月休市日数组）' }
  const keys = Object.keys(months as Record<string, unknown>)
  if (keys.length === 0) return { ok: false, reason: 'months 不能为空（至少写上当月，哪怕是空数组）' }
  const seen = new Map<string, string>()
  let ignoredWeekends = 0
  const out: Record<string, string[]> = {}
  for (const key of keys) {
    if (!MONTH_RE.test(key)) return { ok: false, reason: `月份键 "${key}" 不是 YYYY-MM` }
    const value = (months as Record<string, unknown>)[key]
    if (!Array.isArray(value)) return { ok: false, reason: `"${key}" 的值必须是数组（无休市就写 []）` }
    const list: string[] = []
    for (const item of value) {
      if (typeof item !== 'string' || !DATE_RE.test(item)) return { ok: false, reason: `"${key}" 里有非法日期 ${JSON.stringify(item)}（必须是 YYYY-MM-DD 字符串）` }
      if (!item.startsWith(`${key}-`)) return { ok: false, reason: `日期 ${item} 不在它所属的月份 ${key} 里（自相矛盾）` }
      const prev = seen.get(item)
      if (prev !== undefined) return { ok: false, reason: `日期 ${item} 重复出现（已在 "${prev}" 里）—— 抄写事故，请核对` }
      seen.set(item, key)
      // 周末本来就休市：多写无害，但不计入（并如实报数）
      if (shWeekdayOf(Date.parse(`${item}T12:00:00+08:00`)) === 0 || shWeekdayOf(Date.parse(`${item}T12:00:00+08:00`)) === 6) {
        ignoredWeekends += 1
        continue
      }
      list.push(item)
    }
    out[key] = list.sort()
  }
  const data: TradingCalendarFile = { v: 1, months: out }
  if (typeof obj.source === 'string') data.source = obj.source
  if (typeof obj.updatedAt === 'string') data.updatedAt = obj.updatedAt
  return { ok: true, data, ignoredWeekends }
}

/** 隔离坏文件（留痕，不静默丢弃）：改名到 `<名字>.invalid-<时间戳>` 并返回去向 */
async function quarantine(path: string, reason: string): Promise<string | null> {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = `${path}.invalid-${stamp}`
    await rename(path, target)
    await writeFile(`${target}.reason.txt`, `${new Date().toISOString()}\n${reason}\n`, 'utf8')
    return target
  } catch {
    return null
  }
}

function emptyStatus(path: string, warning: string | null, others: Partial<TradingCalendarStatus> = {}): TradingCalendarStatus {
  return {
    source: 'builtin', path, months: [], coveredThisMonth: false, closuresThisMonth: [],
    ignoredWeekends: 0, warning, invalid: null, fileExists: false, monthsByKey: {}, ...others,
  }
}

/**
 * 载入并缓存外部日历（按 **mtime + size** 失效 ⇒ 用户改完文件不必重启）。
 *
 * `quarantineBroken = true` 时，损坏文件会被改名隔离（默认只在 `npm run calendar:check` 与
 * 启动路径里做，避免只读的快照路径产生写副作用）。
 */
export async function loadTradingCalendar(opts: { quarantineBroken?: boolean } = {}): Promise<TradingCalendarStatus> {
  const path = tradingCalendarPath()
  const month = shDayOf(Date.now()).slice(0, 7)
  let st: { mtimeMs: number; size: number } | null = null
  try {
    const s = statSync(path)
    st = { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    st = null
  }
  if (cache !== null && cache.path === path && st !== null && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
    return cache.status
  }
  if (st === null) {
    const status = emptyStatus(path, null)
    cache = { path, mtimeMs: 0, size: 0, status, closures: new Set() }
    return status
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const reason = `JSON 解析失败：${String(error).slice(0, 160)}`
    const quarantinePath = opts.quarantineBroken === true ? await quarantine(path, reason) : null
    const status = emptyStatus(path, `交易日历文件损坏（${reason}）⇒ 已退回内置规则${quarantinePath !== null ? `；原文件已隔离到 ${quarantinePath}` : ''}`, {
      fileExists: true, invalid: { reason, quarantinePath },
    })
    cache = { path, mtimeMs: st.mtimeMs, size: st.size, status, closures: new Set() }
    return status
  }

  const checked = validateTradingCalendar(parsed)
  if (checked.ok === false) {
    const reason = checked.reason
    const quarantinePath = opts.quarantineBroken === true ? await quarantine(path, reason) : null
    const status = emptyStatus(path, `交易日历文件不合法（${reason}）⇒ 已退回内置规则${quarantinePath !== null ? `；原文件已隔离到 ${quarantinePath}` : ''}`, {
      fileExists: true, invalid: { reason, quarantinePath },
    })
    cache = { path, mtimeMs: st.mtimeMs, size: st.size, status, closures: new Set() }
    return status
  }

  const closures = new Set<string>()
  for (const list of Object.values(checked.data.months)) for (const d of list) closures.add(d)
  const covered = Object.prototype.hasOwnProperty.call(checked.data.months, month)
  const closuresThisMonth = checked.data.months[month] ?? []
  const warning = covered
    ? null
    : `交易日历未更新到本月（${month}）：文件里只有 ${Object.keys(checked.data.months).sort().join('、')} ⇒ 已退回内置规则。请按 README「交易日历维护」一节补上 "${month}": []（或本月休市日）`
  const status: TradingCalendarStatus = {
    // 未覆盖当月 ⇒ 生效来源就是**内置表**（界面必须如实显示，不许写"外部文件"）
    source: covered ? 'external' : 'builtin',
    path,
    months: Object.keys(checked.data.months).sort(),
    coveredThisMonth: covered,
    closuresThisMonth,
    ignoredWeekends: checked.ignoredWeekends,
    warning,
    invalid: null,
    fileExists: true,
    monthsByKey: checked.data.months,
  }
  cache = { path, mtimeMs: st.mtimeMs, size: st.size, status, closures }
  return status
}

/** 外部文件**是否覆盖**该月（缺键 = 未覆盖；`[]` = 已覆盖且本月无法定休市） */
export function monthCoveredByFile(month: string): boolean {
  const st = cache?.status
  return st !== undefined && st.source === 'external' && Object.prototype.hasOwnProperty.call(st.monthsByKey, month)
}

/**
 * 该日是否为外部文件声明的休市日。
 *
 * ⚠ 只在该月**被覆盖**时才有意义（调用方先问 `monthCoveredByFile`）：
 * 覆盖当月 ⇒ **以文件为准**（内置表不参与，用户可以用"不写"来纠正过期的内置条目）；
 * 未覆盖 ⇒ 退回内置表。
 */
export function externalClosureOf(day: string): boolean {
  return cache?.closures.has(day) ?? false
}

export function externalCalendarStatus(): TradingCalendarStatus | null {
  return cache?.status ?? null
}

/** 测试/CLI 用：丢掉缓存（改文件后立即生效） */
export function resetTradingCalendarCache(): void {
  cache = null
}

// ── 只读校验入口（`npm run calendar:check`） ─────────────────────────────────

export interface CalendarCheckReport {
  path: string
  status: TradingCalendarStatus
  /** 未来 10 个自然日的判定（含来源），供用户肉眼核对 */
  upcoming: Array<{ day: string; trading: boolean; reason: string }>
}

/**
 * 组装校验报告（纯读；`quarantine` 由调用方决定是否允许写）。
 *
 * `judge` 由调用方注入（CLI 传 `rescue.tradingDayState`）—— 这样预览用的是**真正生效**的判定链
 * （外部文件 → 内置表 → 周末），而不是在报告里重写一遍规则（重写就会两边漂）。
 */
export async function calendarCheckReport(
  now = Date.now(),
  judge?: (ts: number) => { trading: boolean; reason: 'weekend' | 'holiday' | null; label: string | null },
): Promise<CalendarCheckReport> {
  const status = await loadTradingCalendar({ quarantineBroken: true })
  const upcoming: CalendarCheckReport['upcoming'] = []
  for (let i = 0; i < 10; i += 1) {
    const ts = now + i * 86_400_000
    const day = shDayOf(ts)
    if (judge !== undefined) {
      const st = judge(ts)
      upcoming.push({
        day,
        trading: st.trading,
        reason: st.trading
          ? (monthCoveredByFile(day.slice(0, 7)) ? '交易日（本月以外部文件为准，文件未列为休市）' : '按交易日（月度表与内置表都未命中）')
          : (st.reason === 'weekend' ? '周末' : `外部日历/内置表：${st.label ?? '休市'}`),
      })
      continue
    }
    const wd = shWeekdayOf(Date.parse(`${day}T12:00:00+08:00`))
    if (wd === 0 || wd === 6) upcoming.push({ day, trading: false, reason: '周末' })
    else if (monthCoveredByFile(day.slice(0, 7))) {
      upcoming.push(externalClosureOf(day)
        ? { day, trading: false, reason: '外部日历' }
        : { day, trading: true, reason: '交易日（本月以外部文件为准，文件未列为休市）' })
    } else {
      upcoming.push({ day, trading: true, reason: '按交易日（月度表与内置表都未命中）' })
    }
  }
  return { path: status.path, status, upcoming }
}

/** `npm run calendar:check` 的 main：打印报告，坏文件同时给出隔离去向 */
export function printCalendarCheck(report: CalendarCheckReport): void {
  const { status } = report
  console.log(`文件：${report.path}`)
  console.log(`存在：${status.fileExists ? '是' : '否'}｜生效来源：${status.source === 'external' ? '外部文件' : '内置表'}`)
  if (status.months.length > 0) console.log(`已覆盖月份：${status.months.join('、')}`)
  console.log(`当月被覆盖：${status.coveredThisMonth ? '是' : '否'}｜本月休市日：${status.closuresThisMonth.length > 0 ? status.closuresThisMonth.join('、') : '（无）'}`)
  if (status.ignoredWeekends > 0) console.log(`已忽略周末条目：${status.ignoredWeekends} 条（周末本来就休市，多写无害）`)
  if (status.warning !== null) console.log(`⚠ 告警：${status.warning}`)
  if (status.invalid !== null) console.log(`⚠ 隔离：${status.invalid.quarantinePath ?? '（隔离失败）'} —— ${status.invalid.reason}`)
  console.log('未来 10 天判定：')
  for (const u of report.upcoming) console.log(`  ${u.day}  ${u.trading ? '交易日' : '休市  '}  ${u.reason}`)
}

/** CLI 入口（`node src/host/calendarCheck.ts`） */
export async function calendarCheckMain(): Promise<void> {
  await mkdir(dataHome(), { recursive: true }).catch(() => undefined)
  printCalendarCheck(await calendarCheckReport())
}
