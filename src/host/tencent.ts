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
 * 兜底覆盖面（实测锚点见各映射表的注释）：
 *   - 沪深/港股：行情、五日分时、日线全开；
 *   - 国际指数：**只有行情**（`us.INX`/`us.DJI`/`us.NDX`/`hkHSI`），腾讯对它不提供分时/多日；
 *   - 美股（105/106/107）：**只有行情**（`usFRO`/`usVIXY`/…），日线只回 1 根 ⇒ 不进 K 线链；
 *   - 新浪 `int_*`（旧国际指数源）因"陈旧快照 + 无时间戳"整体停用（见 `sina.ts` 文件头）。
 * 取不到时如实标"无兜底源"，不许拿旧值顶替。
 *
 * 所有请求都过 `breakerFetch.withHostBreaker`（按主机熔断记账）。
 */
import { parseMarketStamp, usWallToEpoch } from './time.ts'
import { UpstreamCoolingError, withHostBreaker } from './breakerFetch.ts'
import { breakerFor } from './breaker.ts'
import { noteHostFailure, noteHostFallback } from './degrade.ts'
import { tencentVolToHands } from './klineUnits.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

// ───────────────── 同源主机回退（K 线：一台被 WAF 挡 ⇒ 换兄弟机） ─────────────

/**
 * 腾讯 `appstock`（K 线/分钟线那套接口）的**三台同源主机**。
 *
 * 为什么必须有这一层（实测 2026-10-22 本机）：
 *   - `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,,,5,`
 *     ⇒ **HTTP 501**，回包是 WAF 挑战页（`waf.tencent.com/501page.html`）——**对任何标的都一样**，
 *     包括上证指数与沪深个股。这不是"这只标的没有数据"，而是**这台主机不接受本机请求**。
 *   - 同一路径换 `ifzq.gtimg.cn` / `proxy.finance.qq.com` ⇒ **200**，且 `data.<code>.qfqday` 与
 *     `day` 数组**逐字相同**（只有 `qt`/`mx_price` 这类元数据里的时间戳不同，解析侧本来就不取它们）。
 *   - 旧实现把 `web.ifzq.gtimg.cn` 写死在 K 线链路上 ⇒ 这台一被挡，整条 K 线链路（含所有周期）
 *     就"没数据"，而界面只能把它说成"熔断冷却/上游没有"。
 *
 * ⚠ 三台的**前缀不同**（`proxy` 走 `/ifzqgtimg/appstock`），路径与其后的查询串必须完全一致 ——
 * 换主机**不换参数**，否则就是另一个口径。
 */
export interface TencentKlineHost {
  host: string
  /** 主机根 + 该主机的 `appstock` 前缀（其后拼 `/app/...`） */
  base: string
}

export const TENCENT_KLINE_HOSTS: readonly TencentKlineHost[] = [
  { host: 'web.ifzq.gtimg.cn', base: 'https://web.ifzq.gtimg.cn/appstock' },
  { host: 'ifzq.gtimg.cn', base: 'https://ifzq.gtimg.cn/appstock' },
  { host: 'proxy.finance.qq.com', base: 'https://proxy.finance.qq.com/ifzqgtimg/appstock' },
]

/** 一次主机尝试的记账（供断言、`/health` 与原因文案读取） */
export interface TencentKlineTry {
  host: string
  ok: boolean
  /** HTTP 状态码（`null` = 连接层失败，或本轮**没发请求**） */
  status: number | null
  ms: number
  /** 失败原因（`熔断冷却中（本轮未发请求）` / `HTTP 501 from …` / 连接错误原文） */
  error: string | null
}

/**
 * 三台**都**不可用。语义是「**主机不可用**」，**不是**「上游没有这只标的的数据」——
 * 两者对用户的下一步动作完全不同（等主机恢复 vs 换标的/别等了），所以必须是两种错误。
 */
export class TencentKlineUnavailableError extends Error {
  readonly tries: readonly TencentKlineTry[]

  constructor(tries: readonly TencentKlineTry[]) {
    const detail = tries.map((t) => `${t.host} ${t.error ?? '未知原因'}`).join('；')
    super(`腾讯 K 线主机全部不可用（${detail}）`)
    this.name = 'TencentKlineUnavailableError'
    this.tries = [...tries]
  }
}

/**
 * 按固定顺序尝试三台同源主机（**同一路径、同一参数**），任一台 200 即返回。
 *
 * 记账分工（不重复计数）：
 *   - 每台的成败由 `withHostBreaker` 记在**该台自己**的熔断器与健康簿上（501/超时/非 JSON 都是失败）；
 *   - 冷却中的主机**记一次"跳过"并继续试下一台**（同源有人活着就不能整体失败）；
 *   - 只有三台全部失败才抛 `TencentKlineUnavailableError`；
 *   - 被兄弟主机接住的那台记 `noteHostFallback` ⇒ `/health` 里显示「降级」，**不判死**。
 */
export async function fetchTencentAppstock(
  pathAndQuery: string,
  timeoutMs: number,
  opts: { headers?: Record<string, string> } = {},
): Promise<{ json: unknown; host: string; tries: TencentKlineTry[] }> {
  const tries: TencentKlineTry[] = []
  for (const { host, base } of TENCENT_KLINE_HOSTS) {
    const startedAt = Date.now()
    try {
      /**
       * 非 2xx（含 WAF 的 501）**绝不当数据**：`withHostBreaker` 按 `res.ok === false` 记一次失败并把
       * `HTTP 501 from …` 抛出（这正是"主机不可用"的原始事实），这里只接住它去试下一台。
       */
      const res = await withHostBreaker(host, () =>
        fetch(`${base}${pathAndQuery}`, {
          headers: { 'user-agent': UA, referer: 'https://gu.qq.com/', ...(opts.headers ?? {}) },
          signal: AbortSignal.timeout(timeoutMs),
        }),
      )
      let json: unknown
      try {
        json = JSON.parse(await res.text()) as unknown
      } catch {
        // 200 但正文不是 JSON（WAF 的"200 版"挑战页之类）：同样按**主机不可用**记账，再换下一台
        const bad = new Error(`non-JSON reply from ${host}: 回包不是 JSON（可能被 WAF 拦截）`)
        breakerFor(host).recordFailure(bad)
        noteHostFailure(host, bad)
        throw bad
      }
      tries.push({ host, ok: true, status: 200, ms: Date.now() - startedAt, error: null })
      for (const t of tries) if (!t.ok) noteHostFallback(t.host, host)
      return { json, host, tries }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = /^HTTP (\d{3}) from /.exec(message)?.[1]
      tries.push({
        host,
        ok: false,
        status: status === undefined ? null : Number(status),
        ms: Date.now() - startedAt,
        error: error instanceof UpstreamCoolingError ? '熔断冷却中（本轮未发请求）' : message,
      })
    }
  }
  throw new TencentKlineUnavailableError(tries)
}

/**
 * 东财 secid → 腾讯代码。
 * 覆盖：沪市(1.)、深市(0.)、港股(116.)。商品/期货(101/113/114) 无法稳定映射，返回 null。
 * **国际指数(100.) 见下面的 `tencentIndexCode`** —— 它们用的是另一种写法（`us.INX`，带点）；
 * **美股(105/106/107) 见 `tencentUsStockQuoteCode`** —— 只开行情一条链（理由见那张表的注释）。
 * 这三档**都不并进本函数**：它被五日分时（mkline）与日线（fqkline）复用。
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

/**
 * 美股（东财 `105`=纳斯达克 / `106`=纽交所 / `107`=美交所）→ 腾讯 `us<TICKER>`。
 *
 * **实测（2026-10-17，本机；原始回包见 `docs/PROBE-US-QUOTES.md` §3.1）**：
 *   - `usFRO` = 52.49 / -0.10%、成交额 196,988,621、总市值 116.85475 亿（= 11,685,475,000 元）；
 *   - `usVIXY` = 17.73 / +8.11%、成交额 270,828,663（ETF 的 `f44/f45` 为**空串**，`f71` = 13,566,000 份）；
 *   - `usAAPL` / `usSPY` / `usEWJ` / `usUVXY` / `usUNG` / `usSLV` / `usTLT` / `usSQQQ` 同样回完整行情；
 *   - **未知代码不回行**（`usZZZZNOTREAL` ⇒ 回包里没有 `v_usZZZZNOTREAL` 这一行）⇒ 缺失仍走
 *     「未取到 + 原因」，不会被读成 0 或别的品种；
 *   - 交易所后缀可反查前缀：`FRO.N`（106）/`VIXY.AM`（107）/`AAPL.OQ`（105）。
 *
 * ⚠ **只进 `tencentQuoteCode`，不并进 `tencentCode`**：`tencentCode` 还被五日分时（mkline）与
 * 日线（fqkline）复用，而腾讯对美股只回 1 根日线（`param=usEWY,day,,,10,qfq`，实测记录见
 * `fetchTencentRawQuotes` 的注释）⇒ 并进去等于给日线路径凭空加一条注定拿不到历史的请求。
 */
export function tencentUsStockQuoteCode(secid: string): string | null {
  const dot = secid.indexOf('.')
  if (dot <= 0) return null
  const market = secid.slice(0, dot)
  if (market !== '105' && market !== '106' && market !== '107') return null
  const code = secid.slice(dot + 1).trim().toUpperCase()
  // 只放行常见美股代码形状：字母起头，允许数字与点（BRK.B / BF.B 这类），长度上限够用即可。
  if (!/^[A-Z][A-Z0-9.]{0,11}$/.test(code)) return null
  return `us${code}`
}

/** 「快照」可用的腾讯代码：沪深/港股 + 国际指数 + 美股（**不含**五日分时的 mkline 那条链，理由见上） */
export function tencentQuoteCode(secid: string): string | null {
  return tencentCode(secid) ?? tencentIndexCode(secid) ?? tencentUsStockQuoteCode(secid)
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

/**
 * 同 `num`，但把**空串**当成「上游没有这个字段」⇒ null。
 *
 * 为什么需要它：`Number('')` = 0 ⇒ 老实的"没有"会被写成 **0**（红线：不得 0 顶替）。
 * 实测美股 ETF 的 `f44`/`f45` 就是空串（`usVIXY` / `usSPY` / `usEWJ`），
 * 而 `f34`（币种）之类的位置在其它市场也可能空。
 * 只用于**市值/成交额/股本**这类"空 = 不知道"的字段；价格/涨跌幅仍走 `num`（0 价的语义另行处理）。
 */
const numField = (v: string | undefined): number | null => (v === undefined || v.trim() === '' ? null : num(v))

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

/**
 * **美股**行情时间（腾讯 `us*` 的 `f[30]`）：`"2026-10-16 16:00:01"` = **美东墙上时间**。
 *
 * 为什么不能复用 `parseTencentStamp`：
 *   · 它只认 14 位纯数字（A股/ETF/指数）与带 `/` 的写法（港股），美股这种 `-` 分隔的会拼出乱码 ⇒ null；
 *   · **更危险的是**：即便给它加一条 `-` 分支，`Date.parse('2026-10-16T16:00:01')` 会按**宿主时区**解释
 *     ⇒ 东八区机器上把美东 16:00 读成北京时间 16:00，整整差 **12–13 小时**（还会被当成"未来时间"）。
 *
 * 实现已下沉到 `time.ts:usWallToEpoch`（AUDIT-IMPL68：新浪美股日线/分钟也用同一套美东换算，
 * 不再各写一份）。实测锚点：`usFRO` = `2026-10-16 16:04:53`、`us.INX` = `2026-10-16 16:42:08`。
 */
export function parseTencentUsStamp(text: string | undefined): number | null {
  return usWallToEpoch(text ?? '')
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
export async function tencentQuoteText(codes: string[]): Promise<string> {
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

/**
 * 解析 `v_CODE="a~b~c";` 文本；`keyOf(code)` 返回该行的键（null/undefined = 丢弃这一行）。
 *
 * 字段下标按市场分档（**实测**，见 `docs/PROBE-US-QUOTES.md` §3.4/§4）：
 *   · 沪深/港股（88 字段）：`f[30]` 14 位北京时刻、`f[35]` = `"价/量/成交额(元)"`、`f[37]` 成交额**万元**；
 *   · 美股（73 字段）：`f[30]` = **美东** `"YYYY-MM-DD HH:MM:SS"`、`f[35]` = `"USD"`（币种，不是三连）、
 *     `f[37]` 成交额**美元**（实测 usFRO 196,988,621 与新浪 `gb_fro` 下标 30 同量级）、
 *     `f[44]/f[45]` 流通/总市值（亿元；**ETF 为空串**）、`f[71]` 股本/份额。
 *   ⇒ 成交额量纲与时间戳时区**必须按市场分流**，否则美股会乘 10000 倍、把美东当东八区。
 */
export function parseTencentQuoteText(text: string, keyOf: (code: string) => string | undefined): Record<string, TencentQuoteFull> {
  const out: Record<string, TencentQuoteFull> = {}
  for (const line of text.split(';')) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const code = line.slice(0, eq).trim().replace(/^v_/, '')
    const secid = keyOf(code)
    if (secid === undefined) continue
    const isUs = /^us/i.test(code)
    const raw = line.slice(eq + 1).trim().replace(/^"/, '').replace(/"$/, '')
    const f = raw.split('~')
    // A股/港股：`f[35]` 是 `"价/量/成交额(元)"` 三连 ⇒ 第 3 段直接是元。美股 `f[35]` 是币种（USD）⇒ 无三连。
    const tri = (f[35] ?? '').split('/')
    const amountTri = num(tri[2])
    const amountF37 = numField(f[37])
    // 成交额量纲：A股/港股的 `f[37]` 是**万元** ⇒ ×1e4；美股 `f[37]` 已是**美元** ⇒ 原样。
    const amountFallback = amountF37 === null ? null : amountF37 * (isUs ? 1 : 1e4)
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
      amount: amountTri ?? amountFallback,
      // 市值字段：腾讯给的是**亿元**（实测 f44/f45 对 sh600519 = 15445.76 亿；usFRO = 75.15370/116.85475 亿），
      // 统一乘 1e8 转元；期货/国际指数无该字段 → null。
      // ⚠ 美股 **ETF 的 f44/f45 是空串**（实测 usVIXY/usSPY/usEWJ），必须走 `numField` 变 null ——
      //    `num('')` 会给出 0，那就是"用 0 顶替市值"。
      totalMv: numField(f[45]) !== null && (numField(f[45]) as number) > 0 ? (numField(f[45]) as number) * 1e8 : null,
      floatMv: numField(f[44]) !== null && (numField(f[44]) as number) > 0 ? (numField(f[44]) as number) * 1e8 : null,
      // f71 = 股本：只在美股上验证过（见字段注释），其它市场一律 null（含义不同，不许猜）
      shares: isUs && numField(f[71]) !== null && (numField(f[71]) as number) > 0 ? (numField(f[71]) as number) : null,
      // 时间戳：美股是**美东**墙上时间（时区无关的反解），沪深/港股是北京时刻/带斜杠格式
      ts: isUs ? parseTencentUsStamp(f[30]) : parseTencentStamp(f[30]),
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
  // 同源三台主机回退（一台被 WAF 挡成 501 时换兄弟机；见 TENCENT_KLINE_HOSTS）
  const { json } = await fetchTencentAppstock(`/app/fqkline/get?param=${code},day,,,${count},qfq`, 15000)
  const j = json as { data?: Record<string, { qfqday?: string[][]; day?: string[][] }> }
  const arr = j?.data?.[code]?.qfqday ?? j?.data?.[code]?.day ?? []
  const out: Array<{ date: string; open: number; close: number; high: number; low: number; vol: number }> = []
  for (const r of arr) {
    // 量纲归一：腾讯科创板日线的成交量是「股」，本插件统一按「手」（见 src/host/klineUnits.ts 的实测表）
    const vol = tencentVolToHands(secid, Number(r[5]))
    const bar = { date: String(r[0]), open: Number(r[1]), close: Number(r[2]), high: Number(r[3]), low: Number(r[4]), vol: vol === null ? Number.NaN : vol }
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
