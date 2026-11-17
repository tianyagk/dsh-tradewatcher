/**
 * 用户可见文案的统一出口（第 1 轮界面打磨）：
 * 失败/降级只有两种句式 —— `<对象>未取到（原因）` / `<对象>失败（原因）`；
 * 显示值一律经这里格式化，**保证不会把 undefined / NaN / null 送到界面**。
 */
export function missText(obj: string, reason?: string | null): string {
  return reason === null || reason === undefined || reason === ''
    ? `${obj}未取到`
    : `${obj}未取到（${reason}）`
}

export function failText(obj: string, reason?: string | null): string {
  return reason === null || reason === undefined || reason === ''
    ? `${obj}失败`
    : `${obj}失败（${reason}）`
}

/** 数字显示：非有限值 ⇒ `—`（绝不输出 NaN/undefined/null） */
export function numText(v: number | null | undefined, digits = 2): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

/** 百分比：非有限值 ⇒ `—`；`sign` 为真时正数带 + */
export function pctText(v: number | null | undefined, digits = 2, sign = false): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  const s = v > 0 && sign ? '+' : ''
  return `${s}${v.toFixed(digits)}%`
}

/** 倍率：非有限值 ⇒ `—` */
export function ratioText(v: number | null | undefined, digits = 2): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  return `${v.toFixed(digits)}×`
}
