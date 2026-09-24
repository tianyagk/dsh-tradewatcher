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

/** 东财 secid(1.510300) → 腾讯代码(sh510300) */
export function tencentCode(secid: string): string | null {
  const [market, code] = secid.split('.')
  if (market === undefined || code === undefined || code === '') return null
  if (market === '1') return `sh${code}`
  if (market === '0') return `sz${code}`
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

/** "20260924161456" → epoch ms */
function parseTencentStamp(text: string | undefined): number | null {
  if (text === undefined || text.length < 14) return null
  const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}`
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

export interface TencentMinutePoint {
  ts: number
  /** 当日累计成交额（元） */
  amount: number
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
    if (Number.isFinite(t)) points.push({ ts: t, amount })
  }
  return points
}
