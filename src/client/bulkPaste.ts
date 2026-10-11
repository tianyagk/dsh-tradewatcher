/**
 * 批量粘贴录入的**解析层**（纯函数，P2-9）。
 *
 * 输入一行一条：`代码 ｜ 名称 ｜ 日期 ｜ 数量 ｜ 价格`（可选第 6 列 备注）。
 * 分隔符接受 `|`、`｜`（全角）、制表符、逗号（半角）—— 粘贴来源五花八门，先统一再切列。
 *
 * 三条纪律：
 *  ① **解析失败的行逐行报错并保留原文**（`raw`）—— 不静默丢弃，也不"猜一猜"；
 *  ② 列数不足/过多都算错（明确说差几列/多几列），不截断、不补默认值；
 *  ③ 解析结果 = 与**逐条手工录入字段级等价**的 `{op, secid, symbolName, qty, price, ts, note}`（断言锁住）。
 */
import type { LedgerEntry } from '../shared/model.ts'

export type PasteDelimiter = '|' | '｜' | '\t' | ','

export interface BulkRow {
  /** 行号（从 1 开始，报错时说"第 N 行"） */
  line: number
  /** 原始行（报错时保留，用户可以复制回去改） */
  raw: string
  secid: string
  symbolName: string
  /** 交易日 `YYYY-MM-DD` */
  day: string
  qty: number
  price: number
  note: string
  /** 会被记成什么：建仓（该标的还没有持仓）/买入/卖出 */
  op: 'buy' | 'sell'
  /** 是否新建持仓（宿主侧 addPos） */
  createsPosition: boolean
  /** 落到账本时的毫秒时间戳（当日 15:00，A股收盘口径；避免同一天多笔排序随机） */
  ts: number
}

export interface BulkError {
  line: number
  raw: string
  /** 一行说明（列数/数字/日期/重复） */
  message: string
}

export interface BulkParseResult {
  rows: BulkRow[]
  errors: BulkError[]
  /** 汇总一行：`可写入 3 条（建仓 1 · 买入 2）· 报错 2 行` */
  summary: string
}

/** 统一分隔符：全角竖线与中文逗号也当分隔符；连续 blank 保留空列（**不合并**，否则列会错位） */
export function splitCells(line: string): string[] {
  return line
    .replace(/｜/g, '|')
    .replace(/，/g, ',')
    .split(/[|\t,]/)
    .map((x) => x.trim())
}

const SECID_RE = /^[0-9]{1,3}\.[A-Za-z0-9_]+$/
const DAY_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/

/** 日期：接受 `YYYY-MM-DD` 与 `YYYY/MM/DD`（也接受单位数月/日） */
export function parseDay(s: string): string | null {
  const m = DAY_RE.exec(s.trim())
  if (m === null) return null
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** 该日 15:00（Asia/Shanghai）的时间戳 —— 与手工录入"当天收盘价"的口径一致 */
export function tsOfDay(day: string): number {
  return Date.parse(`${day}T15:00:00+08:00`)
}

export function parseBulk(text: string, opts: { heldSecids?: readonly string[] } = {}): BulkParseResult {
  const held = new Set((opts.heldSecids ?? []).map((s) => s.toUpperCase()))
  const rows: BulkRow[] = []
  const errors: BulkError[] = []
  const seen = new Set<string>()
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = i + 1
    const raw = lines[i]
    if (raw.trim() === '') continue // 空行直接跳过（不算错）
    const cells = splitCells(raw)
    if (cells.length < 5) {
      errors.push({ line, raw, message: `列数不足（需要 5 列：代码｜名称｜日期｜数量｜价格，实际 ${cells.length} 列）` })
      continue
    }
    if (cells.length > 6) {
      errors.push({ line, raw, message: `列数过多（最多 6 列，实际 ${cells.length} 列）—— 备注里若含分隔符请改写` })
      continue
    }
    const [secid, symbolName, dayRaw, qtyRaw, priceRaw, note = ''] = cells
    if (!SECID_RE.test(secid)) {
      errors.push({ line, raw, message: `代码「${secid}」不是 secid 格式（如 1.600519 / 116.00700）` })
      continue
    }
    const day = parseDay(dayRaw)
    if (day === null) {
      errors.push({ line, raw, message: `日期「${dayRaw}」认不出（支持 YYYY-MM-DD 与 YYYY/MM/DD）` })
      continue
    }
    const qty = Number(qtyRaw)
    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push({ line, raw, message: `数量「${qtyRaw}」不是正数` })
      continue
    }
    const price = Number(priceRaw)
    if (!Number.isFinite(price) || price <= 0) {
      errors.push({ line, raw, message: `价格「${priceRaw}」不是正数` })
      continue
    }
    const key = `${secid.toUpperCase()}|${day}|${qty}|${price}`
    if (seen.has(key)) {
      errors.push({ line, raw, message: `与前面某行完全重复（${secid} ${day} ${qty}@${price}）——已跳过` })
      continue
    }
    seen.add(key)
    if (symbolName === '') {
      errors.push({ line, raw, message: '名称列是空的（界面要用它建仓/显示）' })
      continue
    }
    // 买卖方向约定：默认买入；备注以 `卖` 开头 ⇒ 卖出（不引入"数量正负"这种隐式约定）
    const sell = /^卖/.test(note.trim())
    if (sell && !held.has(secid.toUpperCase())) {
      errors.push({ line, raw, message: `要卖出 ${secid}，但本地没有该持仓 —— 先建仓再卖（或把这行改成买入）` })
      continue
    }
    rows.push({
      line,
      raw,
      secid,
      symbolName,
      day,
      qty,
      price,
      note,
      op: sell ? 'sell' : 'buy',
      createsPosition: !held.has(secid.toUpperCase()),
      ts: tsOfDay(day),
    })
  }
  const creates = rows.filter((r) => r.createsPosition && r.op === 'buy').length
  const buys = rows.filter((r) => r.op === 'buy' && !r.createsPosition).length
  const sells = rows.filter((r) => r.op === 'sell').length
  const parts = [
    `可写入 ${rows.length} 条`,
    creates > 0 ? `建仓 ${creates}` : '',
    buys > 0 ? `买入 ${buys}` : '',
    sells > 0 ? `卖出 ${sells}` : '',
  ].filter((x) => x !== '')
  return {
    rows,
    errors,
    summary: `${parts.join(' · ')}${errors.length > 0 ? ` · 报错 ${errors.length} 行` : ''}`,
  }
}

/** 预览表里"这条会被记成什么"的文案（与账本动词一一对应，导出给界面与断言共用） */
export const BULK_OP_LABEL: Record<'buy' | 'sell', string> = { buy: '买入', sell: '卖出' }

export function bulkOpText(row: BulkRow): string {
  if (row.op === 'sell') return '卖出'
  return row.createsPosition ? '建仓（买入）' : '买入'
}

/** 与"逐条手工录入"等价的字段（断言用：手工录入走的是同一组字段） */
export function manualFieldsOf(row: BulkRow): Partial<LedgerEntry> {
  return { secid: row.secid, name: row.symbolName, qty: row.qty, price: row.price, ts: row.ts, note: row.note }
}
