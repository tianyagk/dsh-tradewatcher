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

/**
 * 国际指数 / 国内期货 / 外盘商品 的 EM secid → 新浪代码映射。
 *
 * 实测（2026-09-29）：腾讯 `qt.gtimg.cn` 只覆盖 sh/sz/hk 与美股三大指数；日经、德法、
 * 韩国指数与全部大宗商品都取不到。新浪 `hq.sinajs.cn` 补上：
 *   - 国际指数：int_dji / int_nasdaq / int_sp500 / int_hangseng / int_ftse / int_nikkei / int_dax30
 *   - 国内期货：nf_RB0 螺纹 / nf_JM0 焦煤 / nf_M0 豆粕 / nf_LH0 生猪
 *   - 外盘商品：hf_XAU 伦敦金 / hf_HG 铜 / hf_SI 银 / hf_OIL 布伦特原油
 * 仍未覆盖（如实返回 null）：韩国 KOSPI200、法国 CAC40、欧洲斯托克50。
 */
const SINA_SYMBOL: Record<string, string> = {
  '100.DJI': 'int_dji',
  '100.SPX': 'int_sp500',
  '100.NDX': 'int_nasdaq',
  '100.HSI': 'int_hangseng',
  '100.FTSE': 'int_ftse',
  '100.N225': 'int_nikkei',
  '100.GDAXI': 'int_dax30',
  '113.rbm': 'nf_RB0',
  '114.jmm': 'nf_JM0',
  '114.mm': 'nf_M0',
  '114.lhm': 'nf_LH0',
  '122.XAU': 'hf_XAU',
  '101.HG00Y': 'hf_HG',
  '101.SI00Y': 'hf_SI',
  '112.B00Y': 'hf_OIL',
}

export function sinaSymbol(secid: string): string | null {
  return SINA_SYMBOL[secid] ?? null
}

/** 兜底源可解析的标的数（供自检断言：预设 23 只里应覆盖 ≥ 20） */
export function sinaCovered(secids: readonly string[]): number {
  return secids.filter((s) => SINA_SYMBOL[s] !== undefined).length
}

export interface SinaHqQuote {
  name: string
  price: number
  prev: number | null
  open: number | null
  high: number | null
  low: number | null
  /** 涨跌幅（%）；昨收不可靠时为 null（不外推） */
  pct: number | null
}

/**
 * 解析 `hq.sinajs.cn` 响应。三种布局（实测字段下标）：
 *   int_*（4 字段）：名称, 最新, 涨跌额, 涨跌幅
 *   nf_* （44 字段）：名称, 时间, 开, 高, 低, 昨收, 买, 卖, **最新**, 结算, …
 *   hf_* （14 字段）：**最新**, 昨收?, …, 开, 高, 低, 时间, **昨收**, …
 */
export function parseSinaHq(payload: string): Record<string, SinaHqQuote> {
  const out: Record<string, SinaHqQuote> = {}
  for (const line of payload.split('\n')) {
    const m = /^var hq_str_([A-Za-z0-9_$]+)="([^"]*)"/.exec(line.trim())
    if (m === null) continue
    const symbol = m[1]
    const parts = m[2].split(',')
    if (parts.length < 2) continue
    let q: SinaHqQuote | null = null
    if (symbol.startsWith('int_')) {
      const price = num(parts[1])
      if (price === null) continue
      q = { name: parts[0] ?? symbol, price, prev: null, open: null, high: null, low: null, pct: num(parts[3]) }
    } else if (symbol.startsWith('nf_')) {
      const price = num(parts[8])
      const prev = num(parts[5])
      if (price === null) continue
      const pct = prev !== null && prev > 0 ? ((price - prev) / prev) * 100 : null
      q = { name: parts[0] ?? symbol, price, prev, open: num(parts[2]), high: num(parts[3]), low: num(parts[4]), pct: sanePct(pct) }
    } else if (symbol.startsWith('hf_')) {
      const price = num(parts[0])
      const prev = num(parts[7])
      if (price === null) continue
      const pct = prev !== null && prev > 0 ? ((price - prev) / prev) * 100 : null
      q = { name: symbol.replace(/^hf_/, ''), price, prev, open: num(parts[3]), high: num(parts[4]), low: num(parts[5]), pct: sanePct(pct) }
    }
    if (q !== null) out[symbol] = q
  }
  return out
}

/** 商品涨跌幅超过 ±25% 基本可判定"昨收字段不可靠"，此时不给结论 */
function sanePct(pct: number | null): number | null {
  if (pct === null || !Number.isFinite(pct) || Math.abs(pct) > 25) return null
  return pct
}

/** 批量拉取国际指数 / 商品（东财不可用时的兜底） */
export async function fetchSinaQuotes(secids: readonly string[]): Promise<Record<string, SinaHqQuote>> {
  const pairs: Array<[string, string]> = []
  for (const secid of secids) {
    const symbol = SINA_SYMBOL[secid]
    if (symbol !== undefined) pairs.push([secid, symbol])
  }
  if (pairs.length === 0) return {}
  const out: Record<string, SinaHqQuote> = {}
  // 分批请求：实测一次性要 14 个符号时新浪只返回其中一部分（10 个左右），
  // 而每批 ≤5 个时稳定返回完整（国内期货就是这样被整批丢掉的）。
  const CHUNK = 5
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const chunk = pairs.slice(i, i + CHUNK)
    const url = `https://hq.sinajs.cn/list=${chunk.map(([, s]) => s).join(',')}`
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, referer: 'https://finance.sina.com.cn/' },
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} from hq.sinajs.cn`)
      const buf = await res.arrayBuffer()
      let text: string
      try {
        text = new TextDecoder('gbk').decode(buf)
      } catch {
        text = new TextDecoder('latin1').decode(buf)
      }
      const parsed = parseSinaHq(text)
      for (const [secid, symbol] of chunk) {
        const q = parsed[symbol]
        if (q !== undefined) out[secid] = q
      }
    } catch {
      /* 单批失败不影响其它批次 */
    }
    await new Promise((r) => setTimeout(r, 60))
  }
  return out
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
