/**
 * 交易时段网格（券商 App 口径）：横轴**固定为完整交易时段**，而不是数据覆盖范围。
 *
 * 为什么要这样：旧横轴 `compressedAxis` 按相邻点间隔的中位数折叠空隙，宽度仍由**数据范围**决定 ——
 * 早盘只跑到 10:00 时曲线会被拉满整个宽度，看着像"一天都在走"（半天市同理）。
 * 这里把一天固定成 0~1：午休**零宽度**（11:30 与 13:00 落在同一条竖线上），未到的时段留白。
 *
 * 只给**有两张时段表**的市场启用：A股（含 ETF/指数/板块）与港股。
 * 美股/国际指数/外盘商品/期货**一律不写**（美股时段随夏令时漂移，硬编码必错）⇒ 回落旧行为并如实说明。
 */
export interface SessionSpan {
  /** `HH:mm` */
  start: string
  end: string
}

export interface SessionDef {
  id: 'cn' | 'hk'
  /** 界面用词（"A股"/"港股"） */
  label: string
  spans: readonly SessionSpan[]
}

/** A股/ETF/指数/板块：09:30–11:30 + 13:00–15:00（240 分；由 `1.600519|5` 的 48 根/天 5 分钟 bar 得证） */
export const SESSION_CN: SessionDef = {
  id: 'cn',
  label: 'A股',
  spans: [{ start: '09:30', end: '11:30' }, { start: '13:00', end: '15:00' }],
}

/** 港股：09:30–12:00 + 13:00–16:00（330 分；由 `116.02513|1` 的 192 点 = 151 + 41 得证"上午收 12:00"） */
export const SESSION_HK: SessionDef = {
  id: 'hk',
  label: '港股',
  spans: [{ start: '09:30', end: '12:00' }, { start: '13:00', end: '16:00' }],
}

/** `HH:mm` → 当日分钟数；非法返回 null */
export function hhmmToMin(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (m === null) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 23 || mi > 59) return null
  return h * 60 + mi
}

/** 该标的适用哪张时段表（只认两张；其余市场返回 null ⇒ 回落旧行为） */
export function sessionOf(secid: string): SessionDef | null {
  const dot = secid.indexOf('.')
  if (dot <= 0) return null
  const mkt = secid.slice(0, dot)
  if (mkt === '1' || mkt === '0') return SESSION_CN
  if (mkt === '116') return SESSION_HK
  return null
}

/** 时段总分钟数（午休不计） */
export function sessionMinutes(session: SessionDef): number {
  let sum = 0
  for (const s of session.spans) {
    const a = hhmmToMin(s.start)
    const b = hhmmToMin(s.end)
    if (a === null || b === null || b <= a) continue
    sum += b - a
  }
  return sum
}

export interface SessionGridLine {
  /** 0~1（单日槽内） */
  at: number
  label: string
  /** 是否落在午休那条折线（11:30 与 13:00 同一条） */
  noon: boolean
}

export interface SessionAxis {
  /** 每个点的横坐标（0~1；多日档 = 天槽 + 时段内比例） */
  xs: number[]
  /** 单日内竖格线（**每个时段取中点** + 午休折线） */
  gridLines: SessionGridLine[]
  /** 时段总分钟 */
  totalMinutes: number
  /** 午休折线在单日槽内的位置（多日档只画它，避免 5 天 × 3 条线糊成一片） */
  noonAt: number
  /** 天槽数（单日 = 1；五日 = 5） */
  daySlots: number
  /** 早于开盘被**夹到左边界**的点数（集合竞价那类） */
  clampedBefore: number
  /** 晚于收盘被夹到右边界的点数 */
  clampedAfter: number
}

/**
 * 把点映射到固定的时段网格上。
 *
 * - `session === null` ⇒ 返回 `null`（调用方回落 `compressedAxis`，并如实说明"不适用"）；
 * - 标签里没有时间的点（日/周/月 K 的 `YYYY-MM-DD`）⇒ 也返回 `null`（这套网格只给分时/五日用）；
 * - **时段外的点夹到边界**（含 09:25 集合竞价）：绝不产生负坐标或 >1 的坐标；
 * - 多日档：按日期切成天槽，每一天在自己的槽里套同一张时段表（**部分数据只占该槽的一段，右侧留白**）。
 */
export function sessionAxis(
  points: readonly { label: string }[],
  session: SessionDef | null,
): SessionAxis | null {
  if (session === null) return null

  // 时段表 → 两个坐标系：**绝对钟点**（判点在哪个区间）与**相对分钟**（算比例，午休不计）
  const abs: Array<{ a: number; b: number }> = []
  const rel: Array<{ a: number; b: number }> = []
  let acc = 0
  for (const s of session.spans) {
    const a = hhmmToMin(s.start)
    const b = hhmmToMin(s.end)
    if (a === null || b === null || b <= a) continue
    abs.push({ a, b })
    rel.push({ a: acc, b: acc + (b - a) })
    acc += b - a
  }
  const total = acc
  if (total <= 0 || abs.length === 0) return null

  const parsed: Array<{ day: string; min: number }> = []
  for (const p of points) {
    const label = typeof p.label === 'string' ? p.label : ''
    const min = hhmmToMin(label.slice(11, 16))
    if (min === null) return null // 标签里没有时间（日/周/月 K）⇒ 这套网格不适用
    parsed.push({ day: label.slice(0, 10), min })
  }
  if (parsed.length === 0) return null

  const dayList: string[] = []
  for (const p of parsed) if (dayList[dayList.length - 1] !== p.day) dayList.push(p.day)
  const daySlots = Math.max(1, dayList.length)
  const noonAt = rel[0].b / total
  const openMin = abs[0].a
  const closeMin = abs[abs.length - 1].b

  let clampedBefore = 0
  let clampedAfter = 0
  const xs: number[] = []
  for (const { day, min } of parsed) {
    let frac: number
    if (min < openMin) {
      frac = 0 // 盘前（09:25 集合竞价那类）：夹到左边界，不产生负坐标
      clampedBefore += 1
    } else if (min > closeMin) {
      frac = 1 // 收盘后：夹到右边界（收盘那一刻仍在时段内，由下面的区间命中给 1）
      clampedAfter += 1
    } else {
      let hit: number | null = null
      for (let k = 0; k < abs.length; k += 1) {
        if (min >= abs[k].a && min <= abs[k].b) {
          hit = (rel[k].a + (min - abs[k].a)) / total
          break
        }
      }
      // 午休里的点（11:30~13:00，含整点）落到"午休折线"上：既不属于上午也不属于下午
      frac = hit ?? noonAt
    }
    if (!Number.isFinite(frac)) frac = 0
    frac = Math.min(1, Math.max(0, frac))
    const slot = Math.max(0, dayList.indexOf(day))
    xs.push((slot + frac) / daySlots)
  }

  // 竖格线：**每个时段取中点**（A股 ⇒ 10:30 / 11:30·13:00 / 14:00，正好四格等宽）；
  // 午休那条用 `11:30/13:00` 双时刻标注。港股按同一规则得 10:45 / 12:00·13:00 / 14:30
  // （若强行 330/4 等分，刻度会落在 10:52:30 这种非整分钟上）。
  const clock = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  const gridLines: SessionGridLine[] = []
  for (let k = 0; k < rel.length; k += 1) {
    gridLines.push({
      at: (rel[k].a + (rel[k].b - rel[k].a) / 2) / total,
      label: clock(abs[k].a + Math.floor((abs[k].b - abs[k].a) / 2)),
      noon: false,
    })
  }
  if (abs.length > 1) {
    gridLines.push({ at: noonAt, label: `${clock(abs[0].b)}/${clock(abs[1].a)}`, noon: true })
  }
  gridLines.sort((a, b) => a.at - b.at)
  return { xs, gridLines, totalMinutes: total, noonAt, daySlots, clampedBefore, clampedAfter }
}
