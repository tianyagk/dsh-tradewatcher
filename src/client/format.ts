/** Client-side formatting helpers (pure). */

export function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  let digits = 2
  if (abs > 0 && abs < 10) digits = 3
  return n.toFixed(digits)
}

export function fmtSigned(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const sign = n > 0 ? '+' : n < 0 ? '-' : ''
  return `${sign}${Math.abs(n).toFixed(digits)}`
}

/** Direction glyph for double-encoded semantics (▲/▼ + color). */
export function pctArrow(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return ''
  return n > 0 ? '▲' : '▼'
}

/** Percent with double encoding: arrow + magnitude (direction implied by the
 *  arrow, color by the theme semantic tokens). */
export function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const arrow = n === 0 ? '' : n > 0 ? '▲' : '▼'
  return `${arrow}${Math.abs(n).toFixed(2)}%`
}

export function fmtAmt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (abs >= 1e4) return `${(n / 1e4).toFixed(2)}万`
  return n.toFixed(2)
}

export function fmtBig(n: number | null | undefined): string {
  // raw integer-ish quantities (volume etc.)
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}万`
  return String(Math.round(n))
}

export function fmtTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts) || ts <= 0) return '—'
  const d = new Date(ts)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fmtClock(ts: number): string {
  const d = new Date(ts)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Direction class given redUp convention (CN red-up / international flipped). */
export function dirClass(n: number | null | undefined, redUp: boolean): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return 'tw-flat'
  const up = n > 0
  const redIsUp = redUp
  return (up === redIsUp) ? 'tw-up' : 'tw-down'
}

export function shortLabel(secid: string): string {
  const m = /^(\d+)\.[A-Za-z0-9]+$/.exec(secid)
  if (m === null) return secid
  const market = m[1]
  if (market === '1' || market === '0') return '沪深'
  if (market === '116') return '港股'
  if (market === '100') return '国际'
  if (market === '105' || market === '106' || market === '107') return '美股'
  return '市场'
}
