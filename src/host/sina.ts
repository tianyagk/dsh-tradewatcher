/**
 * 新浪备用源：ETF 排行（东财行情 CDN 被限流时使用）。
 *
 * 接口：Market_Center.getHQNodeData（node=etf_hq_fund，沪深 ETF 全量）
 *   参数 page/num/sort/asc；sort=amount（成交额）或 changepercent（涨跌幅）
 *   响应为 GBK 编码的 JSON 数组，字段：symbol/code/name/trade/changepercent/amount/volume/turnoverratio
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

export interface SinaEtfRow {
  secid: string
  code: string
  name: string
  price: number | null
  pct: number | null
  amount: number | null
  /** 换手率（%） */
  turnover: number | null
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const n = Number(v.trim())
  return Number.isFinite(n) ? n : null
}

/** 解析新浪 ETF 排行（纯函数，便于自检） */
export function parseSinaEtfRanking(payload: string, limit = 40): SinaEtfRow[] {
  let rows: unknown
  try {
    rows = JSON.parse(payload)
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const out: SinaEtfRow[] = []
  for (const raw of rows) {
    const it = raw as Record<string, unknown>
    const symbol = String(it.symbol ?? '').trim().toLowerCase()
    const m = /^(sh|sz)(\d{6})$/.exec(symbol)
    const name = String(it.name ?? '').trim()
    if (m === null || name === '') continue
    const market = m[1] === 'sh' ? '1' : '0'
    const code = m[2]
    out.push({
      secid: `${market}.${code}`,
      code,
      name,
      price: num(it.trade),
      pct: num(it.changepercent),
      amount: num(it.amount),
      turnover: num(it.turnoverratio),
    })
    if (out.length >= limit) break
  }
  return out
}

/** 拉取新浪 ETF 排行（成交额或涨跌幅降序） */
export async function fetchSinaEtfRanking(sort: 'pct' | 'amount' = 'amount', limit = 40): Promise<SinaEtfRow[]> {
  const field = sort === 'amount' ? 'amount' : 'changepercent'
  const url =
    'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData' +
    `?page=1&num=${limit}&sort=${field}&asc=0&node=etf_hq_fund`
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://finance.sina.com.cn/' },
    signal: AbortSignal.timeout(12000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from vip.stock.finance.sina.com.cn`)
  const buf = await res.arrayBuffer()
  let text: string
  try {
    text = new TextDecoder('gbk').decode(buf)
  } catch {
    text = new TextDecoder('latin1').decode(buf)
  }
  return parseSinaEtfRanking(text, limit)
}
