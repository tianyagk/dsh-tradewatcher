/**
 * 客户端调试开关（AUDIT-CLIENT-PERF P2-2）。
 *
 * 背景：`/tradewatcher/market-extras` 是宿主侧最重的一条（两融双源 + 涨跌停全池扫描 + 全天预测），
 * 但界面**一个字段都不展示** —— 它只为页面根节点上一个 `data-limits` 排障属性而发。默认不该发。
 *
 * 开关口径：地址栏 `?debug=1`（`1` / `true` / `yes`，也接受 `debug` 裸参数）。
 * 纯字符串解析（不碰 `window`）⇒ 可被 node:test 直接断言，也让"默认关"这件事可验证。
 */

/** 地址栏 query（带不带 `?` 都行）里是否开了 debug 开关；缺省/坏值一律 false（默认关） */
export function debugFlagOf(search: string | null | undefined): boolean {
  if (typeof search !== 'string') return false
  const q = search.startsWith('?') ? search.slice(1) : search
  for (const part of q.split('&')) {
    const at = part.indexOf('=')
    const key = (at < 0 ? part : part.slice(0, at)).trim()
    if (key !== 'debug') continue
    if (at < 0) return true
    let raw = part.slice(at + 1)
    try {
      raw = decodeURIComponent(raw)
    } catch {
      /* 坏编码就当字面值处理（宁可不开，也不抛） */
    }
    const v = raw.trim().toLowerCase()
    return v === '1' || v === 'true' || v === 'yes'
  }
  return false
}
