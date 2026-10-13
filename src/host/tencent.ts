/**
 * 腾讯行情备用源（东财限流/被封锁时的兜底；也是 K 线首选源）。
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
 *  - 日线（复权）：https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh510300,day,,,N,qfq
 *  - 板块排行：https://proxy.finance.qq.com/ifzqgtimg/appstock/app/mktHs/rank
 *  - 搜索建议：https://smartbox.gtimg.cn/s3/
 *
 * ⚠ 国际指数没有腾讯兜底：新浪 `int_*` 因"陈旧快照 + 无时间戳"被整体停用（见 `sina.ts` 文件头）
 * ⇒ 取不到时如实标"无兜底源"，不许拿旧值顶替。
 *
 * 所有请求都过 `breakerFetch.withHostBreaker`（按主机熔断记账）。
 */
import { parseMarketStamp } from './time.ts'
import { withHostBreaker } from './breakerFetch.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

/**
 * 东财 secid → 腾讯代码。
 * 覆盖：沪市(1.)、深市(0.)、港股(116.)。美股(105/106/107)、商品/期货(101/113/114) 无法稳定映射，
 * 返回 null（这些标的仍只有东财源）。**国际指数(100.) 见下面的 `tencentIndexCode`**——
 * 它们用的是另一种写法（`us.INX`，带点），而且 `qt.gtimg.cn` 覆盖的只有其中几个。
 */
export function tencentCode(secid: string): string | null {
  const [market, code] = secid.split('.')
  if (market === undefined || code === undefined || code === '') return null
  if (market === '1') return `sh${code}`
  if (market === '0') return `sz${code}`
  if (market === '116') return `hk${code.padStart(5, '0')}`
  return null
}

/**
 * 国际指数（EM `100.*`）→ 腾讯代码。
 *
 * **实测（2026-10-12）**：
 *   - `us.INX` = 7811.54（标普 500）／`us.DJI` = 51654.95（道指）／`us.NDX` = 30883.15（纳指 100）；
 *     三者都带行情时间戳（`f[30]`），可判新鲜度。
 *   - ⚠ **`usSPX` / `us.SPX` 不存在**（返回 `pv_none_match`）—— 标普 500 的唯一正确腾讯代码是 `us.INX`。
 *   - `hkHSI` = 24271.200 可用来兜底恒生指数（EM `100.HSI`）。
 *   - 日经/富时/德国 DAX/韩国/斯托克 50：腾讯**没有**（逐个试过 `us.NIKKEI`/`jp.NI225`/`uk.FTSE100`/
 *     `de.DAX`/`us.SX5E`/`us.KOSPI` 全是 `pv_none_match`）⇒ 这些标的没有腾讯兜底，
 *     新浪 `int_*` 又因"陈旧快照 + 无时间戳"被整体停用（见 sina.ts 文件头）⇒ 如实标"无兜底源"。
 *
 * 为什么单列一张表、不并进 `tencentCode`：`tencentCode` 还被**五日分时**（`mkline`）与
 * 逐笔/板块等路径复用，而 `mkline` 对 `us.INX` 返回 `param error`（实测）——
 * 并进通用映射会给这些路径凭空加一条注定失败的请求。
 */
const TENCENT_INDEX_CODE: Record<string, string> = {
  '100.SPX': 'us.INX',
  '100.DJI': 'us.DJI',
  '100.NDX': 'us.NDX',
  '100.HSI': 'hkHSI',
}

/** 国际指数的腾讯代码（查不到返回 null；大小写无关） */
export function tencentIndexCode(secid: string): string | null {
  return TENCENT_INDEX_CODE[secid.trim().toUpperCase()] ?? null
}

/** 「快照」可用的腾讯代码：沪深/港股 + 国际指数（**不含**五日分时的 mkline 那条链，理由见上） */
export function tencentQuoteCode(secid: string): string | null {
  return tencentCode(secid) ?? tencentIndexCode(secid)
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

/** ⚠ 字符串解析（腾讯把数字给成字符串）——与 shared 的 `numOrNull` 语义不同，不合并（S7） */
const num = (v: string | undefined): number | null => {
  if (v === undefined) return null
  const n = Number(v.trim())
  return Number.isFinite(n) ? n : null
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
  /** 总市值（元）：腾讯 f45，原始单位为**亿元** */
  totalMv: number | null
  /** 流通市值（元）：腾讯 f44，原始单位为**亿元** */
  floatMv: number | null
  /**
   * 股本 / 发行份额（股）：腾讯 **f71**，**只在美股（`us*`）上验证过**：
   * 实测 `usEWJ` f71 = 243300000 与新浪 `gb_ewj` 的「股本」逐位一致；`usSPY` f71 = 1055532000
   * 与新浪 1056132116 同量级（差 0.06%，报价时刻不同）。
   * ⚠ 其它市场该位含义不同（A股该位是负的比值）⇒ 只对 `us*` 取值，其余一律 null。
   */
  shares: number | null
}

/** 完整批量行情（含名称/开高低/量），供自选与持仓的行情链路兜底使用 */
/** 拉 `qt.gtimg.cn` 原始文本（GBK） */
async function tencentQuoteText(codes: string[]): Promise<string> {
  const res = await withHostBreaker('qt.gtimg.cn', () =>
    fetch(`https://qt.gtimg.cn/q=${codes.join(',')}`, {
      headers: { 'user-agent': UA, referer: 'https://gu.qq.com/' },
      signal: AbortSignal.timeout(8000),
    }),
  )
  if (!res.ok) throw new Error(`HTTP ${res.status} from qt.gtimg.cn`)
  const buf = await res.arrayBuffer()
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return new TextDecoder('latin1').decode(buf)
  }
}

/**
 * 按**腾讯原码**取行情（如 `hk02800` / `usSPY` / `usEWY`）：返回的键就是传进去的原码。
 *
 * 为什么不并进 `tencentCode`：那张映射同时被**日线**（fqkline/mkline）复用，
 * 而腾讯对美股只回 1 根日线（实测 `param=usEWY,day,,,10,qfq` ⇒ 1 bar）⇒ 并进去会给日线路径
 * 凭空加一条注定拿不到历史的请求。这里只开**行情**（f44/f45/f71）这一条链。
 */
export async function fetchTencentRawQuotes(codes: string[]): Promise<Record<string, TencentQuoteFull>> {
  const wanted = codes.map((c) => c.trim()).filter((c) => /^(us|hk)[a-z0-9.]{1,12}$/i.test(c))
  if (wanted.length === 0) return {}
  const text = await tencentQuoteText(wanted)
  return parseTencentQuoteText(text, (code) => (wanted.includes(code) ? code : undefined))
}

export async function fetchTencentQuoteRows(secids: string[]): Promise<Record<string, TencentQuoteFull>> {
  const map = new Map<string, string>()
  for (const secid of secids) {
    // 用 tencentQuoteCode：国际指数（us.INX/us.DJI/us.NDX/hkHSI）也在此列 ——
    // 它们原先由新浪 int_* 兜底，实测是陈旧快照，已整族停用（见 sina.ts 文件头）
    const code = tencentQuoteCode(secid)
    if (code !== null) map.set(code, secid)
  }
  if (map.size === 0) return {}
  const text = await tencentQuoteText([...map.keys()])
  return parseTencentQuoteText(text, (code) => map.get(code))
}

/** 解析 `v_CODE="a~b~c";` 文本；`keyOf(code)` 返回该行的键（null/undefined = 丢弃这一行） */
export function parseTencentQuoteText(text: string, keyOf: (code: string) => string | undefined): Record<string, TencentQuoteFull> {
  const out: Record<string, TencentQuoteFull> = {}
  for (const line of text.split(';')) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const code = line.slice(0, eq).trim().replace(/^v_/, '')
    const secid = keyOf(code)
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
      // 市值字段：腾讯给的是**亿元**（实测 f44/f45 对 sh600519 = 15445.76 亿），统一乘 1e8 转元；
      // 指数/ETF 也有值（ETF 为基金规模），期货/国际指数无该字段 → null
      totalMv: num(f[45]) !== null ? (num(f[45]) as number) * 1e8 : null,
      floatMv: num(f[44]) !== null ? (num(f[44]) as number) * 1e8 : null,
      // f71 = 股本：只在美股上验证过（见字段注释），其它市场一律 null（含义不同，不许猜）
      shares: /^us/i.test(code) && num(f[71]) !== null && (num(f[71]) as number) > 0 ? (num(f[71]) as number) : null,
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
  // 国际指数也走这里（实测 `fqkline?param=us.INX,day,,,10,qfq` 返回 `day` 数组，下面已有 `day` 兜底）
  const code = tencentQuoteCode(secid)
  if (code === null) return []
  const res = await withHostBreaker('web.ifzq.gtimg.cn', () =>
    fetch(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,${count},qfq`, {
      headers: { 'user-agent': UA, referer: 'https://gu.qq.com/' },
      signal: AbortSignal.timeout(15000),
    }),
  )
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
  const res = await withHostBreaker('proxy.finance.qq.com', () =>
    fetch(`https://proxy.finance.qq.com/ifzqgtimg/appstock/app/mktHs/rank?l=${limit}&p=1&t=${t}&ordertype=&o=0`, {
      headers: { 'user-agent': UA, referer: 'https://stockapp.finance.qq.com/' },
      signal: AbortSignal.timeout(10000),
    }),
  )
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
  const res = await withHostBreaker('smartbox.gtimg.cn', () =>
    fetch(`https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(q)}&t=all`, {
      headers: { 'user-agent': UA, referer: 'https://stockapp.finance.qq.com/' },
      signal: AbortSignal.timeout(8000),
    }),
  )
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

/**
 * 腾讯逐分钟点 → `TrendPoint`（**纯函数**，便于直接把"推导值"这件事断言死）。
 *
 * 关键映射（与上游实测结构对应）：
 *   - 上游每行 = `HHMM 价格 累计成交量(手) [累计成交额(元)]` —— **累计**，不是每分钟增量；
 *   - `TrendPoint.amount` 的口径是**每分钟**成交额（东财 trends2 就是每分钟）⇒ 这里做**差分**；
 *   - 每个带成交额的点都挂 `amountDerived: true` + `amountNote`：**这是推导值，不是上游直给的分钟额**；
 *   - 累计值回退/缺失 ⇒ 该点 `amount: null`（不编、不用 0 顶替）；
 *   - `vol` 同样改成每分钟手数（与东财口径一致）。
 *
 * 返回 `points`（可直接进 `TrendData.points`）与 `allDerived`（是否每个成交额点都是推导来的）。
 */
export function minuteTrendPointsOf(
  raw: readonly TencentMinutePoint[],
  tsLabel: (ts: number) => string,
): { points: Array<Record<string, unknown>>; allDerived: boolean } {
  const points: Array<Record<string, unknown>> = []
  let prevAmount = 0
  let prevVol = 0
  let amountPoints = 0
  let derivedPoints = 0
  for (const p of raw) {
    if (typeof p.price !== 'number' || !(p.price > 0)) continue
    const cumVol = typeof p.cumVol === 'number' && Number.isFinite(p.cumVol) ? p.cumVol : null
    const cumAmount = typeof p.amount === 'number' && Number.isFinite(p.amount) ? p.amount : null
    const minuteAmount = cumAmount !== null && cumAmount >= prevAmount
      ? Math.round((cumAmount - prevAmount) * 100) / 100
      : null
    const minuteVol = cumVol !== null && cumVol >= prevVol ? Math.round((cumVol - prevVol) * 100) / 100 : null
    if (cumAmount !== null && cumAmount >= prevAmount) prevAmount = cumAmount
    if (cumVol !== null && cumVol >= prevVol) prevVol = cumVol
    const avg = cumVol !== null && cumVol > 0 && cumAmount !== null ? cumAmount / (cumVol * 100) : null
    if (minuteAmount !== null) {
      amountPoints += 1
      derivedPoints += 1
      points.push({
        t: p.ts, label: tsLabel(p.ts), price: p.price, avg, vol: minuteVol, amount: minuteAmount,
        amountDerived: true,
        amountNote: '腾讯逐分钟只给累计成交额 ⇒ 每分钟成交额由相邻累计值差分得到（推导值，非上游直给的分钟额）',
      })
    } else {
      points.push({ t: p.ts, label: tsLabel(p.ts), price: p.price, avg, vol: minuteVol, amount: null })
    }
  }
  return { points, allDerived: amountPoints > 0 && amountPoints === derivedPoints }
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
  const res = await withHostBreaker('web.ifzq.gtimg.cn', () =>
    fetch(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`, {
      headers: { 'user-agent': UA, referer: 'https://gu.qq.com/' },
      signal: AbortSignal.timeout(8000),
    }),
  )
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
    // ⚠ 北京墙上时间 ⇒ 显式 +08:00（无偏移的 Date.parse 在 TZ=UTC 宿主要偏 8 小时）
    const t = parseMarketStamp(`${day} ${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}`)
    if (Number.isFinite(t)) points.push({ ts: t, amount, price: num(parts[1]), cumVol: num(parts[2]) })
  }
  return points
}
