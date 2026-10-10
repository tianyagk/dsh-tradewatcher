/**
 * 行情卡片的 badge 视图与配置窗的**生效集合**（纯函数，不 import react）。
 *
 * 口径（`docs/DESIGN-STRIP-CONFIG.md` §2/§4）：
 *   - `prefs.stripCfg` **存隐藏集合**：老 profile 没有这个键 ⇒ `hidden=[]` ⇒ 全部可见，
 *     且**将来新增的卡片默认可见**（存显示集合会让老 profile 永远看不到后加的国债卡）；
 *   - badge 只放**档位词**（32×14 胶囊），口径（分位/动量/有效样本/类型/更新日期）进 `title`，
 *     badge 自身 `pointer-events:none`（文案挂在卡片已有的 title/aria 上）；
 *   - 缺失一律 `—` + 原因，**绝不用「适中」冒充**。
 */
import type { ToneLevel } from './toneLevels.ts'

export interface StripCardLike {
  secid: string
  name: string
}

export interface StripRowLike {
  key: string
  label: string
  items: readonly StripCardLike[]
}

/** 一条 badge 数据（来自 `GET /tradewatcher/tones`） */
export interface ToneRow {
  secid: string
  level: ToneLevel | null
  /** 分位（0–100）；未发布时 null */
  pct: number | null
  /** 近 30 日涨跌幅（%）；已按类型方向取负 */
  r30: number | null
  /** 动量（%）；已按类型方向取负 */
  momentum: number | null
  samples: number
  bars: number
  /** 宿主判定：属于"样本不足"（区别于"本次取不到"） */
  insufficient?: boolean
  kind: 'yield' | 'price'
  /** 未发布档位的原因（人话）；已发布时 null */
  why: string | null
}

export interface ToneBadgeView {
  /** 可见文字（只放档位词）；不发布时为 null */
  text: string | null
  /** `data-tone` 属性值：五档词本身，或 `insufficient` / `none`（供断言与读屏） */
  dataTone: string
  /** 挂到卡片 title/aria 的口径长句（原则 1/6：口径不进正文） */
  detail: string
}

const fmtPct1 = (v: number | null): string => (v === null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`)

/** badge 视图：档位词 + data-tone + 口径长句 */
export function toneBadgeView(row: ToneRow | undefined): ToneBadgeView {
  if (row === undefined) return { text: null, dataTone: 'none', detail: '' }
  const kindWord = row.kind === 'yield' ? '收益率（已取负＝价格方向）' : '价格'
  if (row.level === null) {
    return {
      text: null,
      dataTone: row.insufficient === true ? 'insufficient' : 'none',
      detail: `状态：—（${row.why ?? '未取到'}）· 类型：${kindWord}`,
    }
  }
  const parts = [
    `状态：${row.level}`,
    `近 30 日涨跌幅分位 ${row.pct === null ? '—' : `${row.pct.toFixed(0)}%`}`,
    `动量 ${fmtPct1(row.momentum)}`,
    `近 30 日涨跌幅 ${fmtPct1(row.r30)}`,
    `有效样本 ${row.samples} 个（${row.bars} 根日线）`,
  ]
  return {
    text: row.level,
    dataTone: row.level,
    detail: `${parts.join(' · ')} · 类型：${kindWord} · 基准：该标的自身 30 日涨跌幅的历史分布`,
  }
}

/** 生效的隐藏集合：老 profile 缺键 ⇒ 全可见；未知 secid 过滤掉（与 store 的装载宽容一致） */
export function effectiveHidden(hidden: unknown, known: readonly string[]): string[] {
  if (!Array.isArray(hidden)) return []
  const set = new Set(known)
  const out: string[] = []
  for (const v of hidden) if (typeof v === 'string' && set.has(v) && !out.includes(v)) out.push(v)
  return out
}

/** 生效的可见卡片（按 TW_ROWS 的固定顺序） */
export function visibleCards<T extends StripRowLike>(rows: readonly T[], hidden: unknown): Array<{ row: T; items: StripCardLike[] }> {
  const all = rows.flatMap((r) => r.items.map((i) => i.secid))
  const hide = new Set(effectiveHidden(hidden, all))
  const out: Array<{ row: T; items: StripCardLike[] }> = []
  for (const r of rows) {
    const items = r.items.filter((i) => !hide.has(i.secid))
    if (items.length > 0) out.push({ row: r, items }) // 整组全隐藏 ⇒ 不渲染空组头
  }
  return out
}

/** 全选 / 恢复默认：`hidden = []` */
export const SELECT_ALL_HIDDEN: string[] = []
/** 反选：把当前可见的换掉（隐藏集变成"当前可见集"） */
export function invertHidden(rows: readonly StripRowLike[], hidden: unknown): string[] {
  const all = rows.flatMap((r) => r.items.map((i) => i.secid))
  const hide = new Set(effectiveHidden(hidden, all))
  return all.filter((s) => !hide.has(s))
}
/** 单组全选/全隐藏（组头 checkbox） */
export function toggleGroupHidden(rows: readonly StripRowLike[], hidden: unknown, rowKey: string, on: boolean): string[] {
  const all = rows.flatMap((r) => r.items.map((i) => i.secid))
  const row = rows.find((r) => r.key === rowKey)
  const hide = new Set(effectiveHidden(hidden, all))
  for (const it of row?.items ?? []) {
    if (on) hide.delete(it.secid)
    else hide.add(it.secid)
  }
  return all.filter((s) => hide.has(s))
}
/** 单张卡的开关 */
export function toggleCardHidden(rows: readonly StripRowLike[], hidden: unknown, secid: string, on: boolean): string[] {
  const all = rows.flatMap((r) => r.items.map((i) => i.secid))
  const hide = new Set(effectiveHidden(hidden, all))
  if (on) hide.delete(secid)
  else hide.add(secid)
  return all.filter((s) => hide.has(s))
}
/** 已选计数（配置窗底部的 `已选 N/M`） */
export function selectedCount(rows: readonly StripRowLike[], hidden: unknown): { on: number; total: number } {
  const total = rows.reduce((n, r) => n + r.items.length, 0)
  const hide = new Set(effectiveHidden(hidden, rows.flatMap((r) => r.items.map((i) => i.secid))))
  return { on: total - hide.size, total }
}
