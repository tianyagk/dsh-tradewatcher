/**
 * 腾讯行情备用源。
 *
 * 用途：东财行情主机（push2 系列与 push2his）对本机 IP 限流/封锁时，至少保住
 * **量能、脉冲与价格**这三项可观测指标；「超大单净流入」只有东财提供，无替代，
 * 因此备用源下该字段为 null，并在快照里标注数据来源，评分相应降级。
 *
 * 接口（免费、无需鉴权）：
 *  - 批量快照：https://qt.gtimg.cn/q=sh510300,sz159915  （GBK 文本，按 ~ 分隔）
 *  - 当日分钟：https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=sh510300
 *    （每行 `HHmm 价 累计量(手) 累计额(元)` —— 第 4 字段是**累计成交额**，
 *      实测末行 1530 = 全天成交额，与批量快照的成交额一致）
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

/**
 * 东财 secid → 腾讯代码。
 * 覆盖：沪市(1.)、深市(0.)、港股(116.)。美股(105/106/107)、国际指数(100.)、
 * 商品/期货(101/113/114) 无法稳定映射，返回 null（这些标的仍只有东财源）。
 */
export function tencentCode(secid: string): string | null {
  const [market, code] = secid.split('.')
  if (market === undefined || code === undefined || code === '') return null
  if (market === '1') return `sh${code}`
  if (market === '0') return `sz${code}`
  if (market === '116') return `hk${code.padStart(5, '0')}`
  return null
}

export interface TencentQuote {
  secid: string
  price: number | null
  prev: number | null
  pct: number | null
  /** 当日累计成交额（元） */
  amount: number | null
  /** 行情时间戳（epoch ms） */
  ts: number | null
}

const num = (v: string | undefined): number | null => {
  if (v === undefined) return null
  const n = Number(v.trim())
  return Number.isFinite(n) ? n : null
}

/** 批量快照：一次请求覆盖全部通道（GBK 响应按 latin1 读取，只取数字字段，不依赖 ICU 的 GBK 解码） */
export async function fetchTencentQuotes(secids: string[]): Promise<Record<string, TencentQuote>> {
  const map = new Map<string, string>()
  for (const secid of secids) {
    const code = tencentCode(secid)
    if (code !== null) map.set(code, secid)
  }
  if (map.size === 0) return {}
  const res = await fetch(`https://qt.gtimg.cn/q=${[...map.keys()].join(',')}`, {
    headers: { 'user-agent': UA, referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from qt.gtimg.cn`)
  const buf = await res.arrayBuffer()
  const text = new TextDecoder('latin1').decode(buf)
  const out: Record<string, TencentQuote> = {}
  for (const line of text.split(';')) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const code = line.slice(0, eq).trim().replace(/^v_/, '')
    const secid = map.get(code)
    if (secid === undefined) continue
    const raw = line.slice(eq + 1).trim().replace(/^"/, '').replace(/"$/, '')
    const f = raw.split('~')
    // 36 号字段形如「价/量(手)/额(元)」，成交额取其中最可靠的一份
    const tri = (f[35] ?? '').split('/')
    const amount = num(tri[2]) ?? (num(f[37]) !== null ? (num(f[37]) as number) * 1e4 : null)
    out[secid] = {
      secid,
      price: num(f[3]),
      prev: num(f[4]),
      pct: num(f[32]),
      amount,
      ts: parseTencentStamp(f[30]),
    }
  }
  return out
}

/** 时间戳：A股/ETF/指数为 "20260924161456"，港股为 "2026/09/24 16:14:56" */
export function parseTencentStamp(text: string | undefined): number | null {
  if (text === undefined) return null
  const t = text.trim()
  if (t.includes('/')) {
    const parsed = Date.parse(t.replace(/\//g, '-'))
    return Number.isFinite(parsed) ? parsed : null
  }
  if (t.length < 14) return null
  const iso = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}`
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : null
}

export interface TencentQuoteFull extends TencentQuote {
  name: string
  open: number | null
  high: number | null
  low: number | null
  /** 成交量（手；港股为股） */
  vol: number | null
}

/** 完整批量行情（含名称/开高低/量），供自选与持仓的行情链路兜底使用 */
export async function fetchTencentQuoteRows(secids: string[]): Promise<Record<string, TencentQuoteFull>> {
  const map = new Map<string, string>()
  for (const secid of secids) {
    const code = tencentCode(secid)
    if (code !== null) map.set(code, secid)
  }
  if (map.size === 0) return {}
  const res = await fetch(`https://qt.gtimg.cn/q=${[...map.keys()].join(',')}`, {
    headers: { 'user-agent': UA, referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from qt.gtimg.cn`)
  const buf = await res.arrayBuffer()
  let text: string
  try {
    text = new TextDecoder('gbk').decode(buf)
  } catch {
    text = new TextDecoder('latin1').decode(buf)
  }
  const out: Record<string, TencentQuoteFull> = {}
  for (const line of text.split(';')) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const code = line.slice(0, eq).trim().replace(/^v_/, '')
    const secid = map.get(code)
    if (secid === undefined) continue
    const raw = line.slice(eq + 1).trim().replace(/^"/, '').replace(/"$/, '')
    const f = raw.split('~')
    const tri = (f[35] ?? '').split('/')
    out[secid] = {
      secid,
      name: (f[1] ?? '').trim(),
      price: num(f[3]),
      prev: num(f[4]),
      open: num(f[5]),
      pct: num(f[32]),
      high: num(f[33]),
      low: num(f[34]),
      vol: num(f[6]),
      amount: num(tri[2]) ?? (num(f[37]) !== null ? (num(f[37]) as number) * 1e4 : null),
      ts: parseTencentStamp(f[30]),
    }
  }
  return out
}

/** smartbox 返回的是带 \uXXXX 转义的 JS 字符串字面量，需反转义才能显示中文 */
export function unescapeUnicode(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

/** 腾讯类型词表 → 与东财 suggestKind 对齐的展示口径 */
export function suggestKindFromTencent(marketKey: string, rawKind: string): string {
  if (marketKey === 'hk') return '港股'
  if (/ETF/i.test(rawKind)) return 'ETF'
  if (/ZS/i.test(rawKind)) return '指数'
  if (/LOF|FUND|JJ/i.test(rawKind)) return '基金'
  return '股票'
}

/** 日线（腾讯 fqkline，前复权）；用于位置与底部概率回算 */
export async function fetchTencentDaily(secid: string, count = 320): Promise<Array<{ date: string; open: number; close: number; high: number; low: number; vol: number }>> {
  const code = tencentCode(secid)
  if (code === null) return []
  const res = await fetch(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,${count},qfq`, {
    headers: { 'user-agent': UA, referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from web.ifzq.gtimg.cn`)
  const j = (await res.json()) as { data?: Record<string, { qfqday?: string[][]; day?: string[][] }> }
  const arr = j?.data?.[code]?.qfqday ?? j?.data?.[code]?.day ?? []
  const out: Array<{ date: string; open: number; close: number; high: number; low: number; vol: number }> = []
  for (const r of arr) {
    const bar = { date: String(r[0]), open: Number(r[1]), close: Number(r[2]), high: Number(r[3]), low: Number(r[4]), vol: Number(r[5]) }
    if (!Number.isFinite(bar.close) || !(bar.close > 0) || !(bar.vol > 0)) continue
    out.push(bar)
  }
  return out
}

/** 腾讯板块排行（t=01 行业 / 02 概念 / 03 地域） */
export interface TencentBoardRow {
  code: string
  name: string
  /** 板块指数涨跌幅（%） */
  pct: number | null
  /** 板块指数点位 */
  price: number | null
  leader: string | null
  leaderPct: number | null
}

/**
 * 腾讯板块排行。东财行情 CDN（push2 系列）被限流/封锁时，板块与概念排行用它兜底；
 * 注意：**没有主力净流入**（资金流排行仅东财提供），该列会显示为 —
 */
export async function fetchTencentBoards(kind: 'industry' | 'concept', limit = 40): Promise<TencentBoardRow[]> {
  const t = kind === 'industry' ? '01/averatio' : '02/averatio'
  const res = await fetch(`https://proxy.finance.qq.com/ifzqgtimg/appstock/app/mktHs/rank?l=${limit}&p=1&t=${t}&ordertype=&o=0`, {
    headers: { 'user-agent': UA, referer: 'https://stockapp.finance.qq.com/' },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from proxy.finance.qq.com`)
  const j = (await res.json()) as { code?: number; data?: Array<Record<string, unknown>> }
  if (j?.code !== 0 || !Array.isArray(j.data)) return []
  const out: TencentBoardRow[] = []
  for (const it of j.data) {
    const name = String(it.bd_name ?? '').trim()
    const code = String(it.bd_code ?? '').trim()
    if (name === '' || code === '') continue
    out.push({
      code,
      name,
      pct: num(it.bd_zdf as string | undefined),
      price: num(it.bd_zxj as string | undefined),
      leader: it.nzg_name === undefined || it.nzg_name === '' ? null : String(it.nzg_name),
      leaderPct: num(it.nzg_zdf as string | undefined),
    })
  }
  return out
}

export interface TencentSuggestRow {
  secid: string
  code: string
  name: string
  kind: string
  market: string
}

/** 腾讯市场前缀 → 东财市场号（只覆盖能稳定映射的：沪/深/港股） */
const SUGGEST_MARKET: Record<string, { secid: string; market: string }> = {
  sh: { secid: '1', market: '1' },
  sz: { secid: '0', market: '0' },
  hk: { secid: '116', market: '116' },
}

/**
 * 腾讯智慧搜索（东财 searchapi 不可用时的备用源）。
 * 响应形如 `v_hint="sh~510300~沪深300ETF华泰柏瑞~hs300etfhtbr~ETF^sz~159919~…"`
 * 字段：市场~代码~名称~拼音~类型；多行以 ^ 分隔。
 */
export async function fetchTencentSuggest(query: string, limit = 10): Promise<TencentSuggestRow[]> {
  const q = query.trim()
  if (q === '') return []
  const res = await fetch(`https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(q)}&t=all`, {
    headers: { 'user-agent': UA, referer: 'https://stockapp.finance.qq.com/' },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from smartbox.gtimg.cn`)
  const buf = await res.arrayBuffer()
  let text: string
  try {
    text = new TextDecoder('gbk').decode(buf)
  } catch {
    text = new TextDecoder('latin1').decode(buf)
  }
  return parseTencentSuggest(text, limit)
}

/** 解析 smartbox 响应（纯函数，便于自检） */
export function parseTencentSuggest(payload: string, limit = 10): TencentSuggestRow[] {
  const m = /v_hint="([^"]*)"/.exec(payload)
  if (m === null) return []
  const out: TencentSuggestRow[] = []
  const seen = new Set<string>()
  for (const raw of m[1].split('^')) {
    const f = raw.split('~')
    const marketKey = (f[0] ?? '').toLowerCase()
    const code = (f[1] ?? '').trim()
    const name = unescapeUnicode((f[2] ?? '').trim())
    const kind = suggestKindFromTencent(marketKey, (f[4] ?? '').trim())
    const mapped = SUGGEST_MARKET[marketKey]
    if (mapped === undefined || code === '' || name === '' || !/^[A-Za-z0-9]{1,10}$/.test(code)) continue
    const secid = `${mapped.secid}.${code}`
    if (seen.has(secid)) continue
    seen.add(secid)
    out.push({ secid, code, name, kind, market: mapped.market })
    if (out.length >= limit) break
  }
  return out
}

export interface TencentMinutePoint {
  ts: number
  /** 当日累计成交额（元） */
  amount: number
  /** 该分钟价格（分时图兜底用） */
  price?: number
  /** 当日累计成交量（手） */
  cumVol?: number
}

/** 当日分钟线 → 累计成交额序列（HHmm 从 09:30 至 15:00） */
export async function fetchTencentMinutes(secid: string): Promise<TencentMinutePoint[]> {
  const code = tencentCode(secid)
  if (code === null) return []
  const res = await fetch(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`, {
    headers: { 'user-agent': UA, referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from web.ifzq.gtimg.cn`)
  const j = (await res.json()) as { data?: Record<string, { data?: { date?: string; data?: string[] } }> }
  const body = j?.data?.[code]?.data
  const date = body?.date ?? ''
  const rows = Array.isArray(body?.data) ? body.data : []
  if (date.length < 8 || rows.length === 0) return []
  const day = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
  const points: TencentMinutePoint[] = []
  for (const row of rows) {
    const parts = row.split(' ')
    const hhmm = parts[0] ?? ''
    if (hhmm.length < 4) continue
    if (hhmm < '0930' || hhmm > '1500') continue
    const amount = num(parts[3]) // 累计成交额（不是每分钟增量）
    if (amount === null || !(amount > 0)) continue
    const t = Date.parse(`${day}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00`)
    if (Number.isFinite(t)) points.push({ ts: t, amount, price: num(parts[1]), cumVol: num(parts[2]) })
  }
  return points
}
