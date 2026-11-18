/**
 * 棱镜（AGENT DESK）仅剩的展示纯函数：
 * - `parseSelftestBody`：页头自检回包解析（`api.ts` 唯一消费者）
 * - `dayPnlOf`：当日盈亏（净值序列 + capital 差分；宿主测试在用）
 */
export interface SelftestResult {
  ok: boolean
  error: string | null
  model: string | null
  elapsedMs: number
  text: string | null
  chunks: Array<{ type: string; keys: string[] }>
}

export function parseSelftestBody(status: number, raw: string): SelftestResult {
  const fallback: SelftestResult = { ok: false, error: null, model: null, elapsedMs: 0, text: null, chunks: [] }
  const text = raw.trim()
  if (text === '') return { ...fallback, error: '响应为空（前 60 字：）' }
  try {
    const body = JSON.parse(text) as Partial<SelftestResult>
    if (typeof body.ok !== 'boolean') return { ...fallback, error: `响应缺少 ok 字段（前 60 字：${text.slice(0, 60)}）` }
    return {
      ok: body.ok,
      error: typeof body.error === 'string' ? body.error : null,
      model: typeof body.model === 'string' ? body.model : null,
      elapsedMs: typeof body.elapsedMs === 'number' ? body.elapsedMs : 0,
      text: typeof body.text === 'string' ? body.text : null,
      chunks: Array.isArray(body.chunks) ? body.chunks : [],
    }
  } catch {
    const prefix = status === 200 ? '响应非 JSON' : `请求失败（HTTP ${status}）`
    return { ...fallback, error: `${prefix}（前 60 字：${text.slice(0, 60)}）` }
  }
}

/** 当日盈亏：相邻净值点 (equity − capital) 差分；缺 capital 给原因（不拿当前 capital 回填） */
export function dayPnlOf(points: ReadonlyArray<{ day?: string; equity: number; capital?: number }> | null | undefined): { value: number | null; reason: string | null } {
  if (points === null || points === undefined || points.length < 2) return { value: null, reason: '净值序列不足两个点' }
  const cur = points[points.length - 1]
  const prev = points[points.length - 2]
  if (cur === undefined || prev === undefined) return { value: null, reason: '净值序列不足两个点' }
  const c1 = cur.capital
  const c0 = prev.capital
  if (c1 === null || c1 === undefined || c0 === null || c0 === undefined || !Number.isFinite(c1) || !Number.isFinite(c0)) return { value: null, reason: '缺 capital，无法算当日盈亏' }
  if (!Number.isFinite(cur.equity) || !Number.isFinite(prev.equity)) return { value: null, reason: '净值点非法' }
  return { value: (cur.equity - c1) - (prev.equity - c0), reason: null }
}
