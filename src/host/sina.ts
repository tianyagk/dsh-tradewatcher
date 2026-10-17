/**
 * 新浪备用源：ETF 排行 / 批量行情 / 全球市场原语（东财不可用时的兜底与交叉校验）。
 *
 * 接口（均为 2026-10 本机实测形状，原始回包见 `docs/AUDIT-IMPL45.md` §2）：
 *  - ETF 排行：`vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData`
 *    （node=etf_hq_fund，沪深 ETF 全量；sort=amount 或 changepercent；**GBK** 编码的 JSON 数组）
 *  - 批量行情：`hq.sinajs.cn/list=sh510300,sz159915`（**必须带 Referer**，否则被拒）
 *  - 规模原语：`hq.sinajs.cn/list=gb_spy` 下标 12 =「总市值」（美元，与 price×股本 交叉校验一致）；
 *    A 股规模走 ETF 节点的 `nmc`（万元）—— **不是 `mktcap`**
 *  - 美股 ETF 日线：`stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/.../US_MinKService.getDailyK?symbol=vgk`
 *    （jsonp 形态、含全历史；腾讯 `usVGK` 实测只回 1 根 ⇒ 美股 ETF 日线只能走这条）
 *  - 资金流：`MoneyFlow.ssl_qsfx_zjlrqs?daima=sh510300`（逐日 `netamount`，元）
 *  - 汇率：`hq.sinajs.cn/list=fx_susdcny`（下标 8 = 最新，下标 3 = 昨收）
 *
 *  - 美股行情：`hq.sinajs.cn/list=gb_fro`（`gb_*` = 美股/美股 ETF，**必须带 Referer**）。
 *    与腾讯 `us*` 互为第二兜底：实测 `gb_fro` 52.49 / `gb_vixy` 17.73 与腾讯逐项一致
 *    （字段下标见 `parseSinaGb`；2026-10-17 实测原始回包见 `docs/PROBE-US-QUOTES.md` §3.2）。
 *    ⚠ `int_*`（国际指数）整族**停用**：实测是陈旧快照且无时间戳，无法判定新鲜度 ——
 *    任何调用方都不许再拿它当国际指数来源（`tencent.ts`/`em.ts` 的相关注释指向这里）。
 *
 * 所有请求都过 `breakerFetch.withHostBreaker`（按主机熔断记账）。
 */

import { withHostBreaker } from './breakerFetch.ts'
import { usWallToEpoch } from './time.ts'
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

/** ⚠ 字符串解析（新浪把数字给成字符串）——与 shared 的 `numOrNull` 语义不同，不合并（S7） */
const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const n = Number(v.trim())
  return Number.isFinite(n) ? n : null
}

/**
 * 同 `num`，但**空串 = 上游没有这个字段**（null）。
 *
 * 为什么需要：`Number('')` = 0 ⇒ "没有"会被写成 0（红线：不得 0 顶替）。
 * 美股 `gb_*` 行里 `--`、空串都出现过（实测 `gb_fro` 的市盈率就是 `--`）。
 */
const numField = (v: unknown): number | null => (typeof v === 'string' && v.trim() === '' ? null : num(v))

/**
 * 国际指数 / 国内期货 / 外盘商品 的 EM secid → 新浪代码映射。
 *
 * ⚠ **国际指数（`100.*`）已从本表整体移除**（2026-10-12 实测，见 docs/AUDIT-IMPL44.md）：
 * 新浪 `int_*` 族是**陈旧快照且不带时间戳**，没法判定新鲜度，实测与腾讯同刻值差到两位数：
 *   `int_sp500` = 6643.70 vs 腾讯 `us.INX` = **7811.54**（旧值低 15.0%）
 *   `int_dji`   = 46247.29 vs 腾讯 `us.DJI` = **51654.95**（旧值低 10.5%）
 *   `int_nasdaq`= 22484.07 vs 腾讯 `us.NDX` = **30883.15**（旧值低 27.2%）
 * 现网 `quotes-lkg.json` 里 `100.SPX = 6643.7` 就是这条链路落进去的**错值**。
 * 国际指数改由腾讯 `us.INX` / `us.DJI` / `us.NDX` / `hkHSI` 兜底（见 tencent.ts 的 `tencentIndexCode`）；
 * 腾讯也没覆盖的（日经/富时/德国/韩国/斯托克50）**如实标为"无兜底源"** —— 宁可 `—`，不给错值。
 *
 * 仍保留（有真时间戳，可判新鲜度）：
 *   - 国内期货：nf_RB0 螺纹 / nf_JM0 焦煤 / nf_M0 豆粕 / nf_LH0 生猪
 *   - 外盘商品：hf_XAU 伦敦金 / hf_HG 铜 / hf_SI 银 / hf_OIL 布伦特原油
 * 仍未覆盖（如实返回 null）：韩国 KOSPI200、法国 CAC40、欧洲斯托克50、日经、富时、德国 DAX。
 */
/**
 * 大小写无关的查表：键统一为大写。
 * secid 后缀区分大小写（114.lhm），而库/路由历史上存过大写写法（114.LHM），
 * 按原样查表会让这些标的丢掉新浪兜底 —— 这里统一按大写匹配，输出仍用请求的写法。
 */
const SINA_BY_UPPER: Record<string, string> = {}

/**
 * 美股（东财 `105`=纳斯达克 / `106`=纽交所 / `107`=美交所）→ 新浪 `gb_<ticker>`。
 *
 * 为什么是**规则**而不是往 `SINA_SYMBOL` 里再加几行：那张表是逐标的登记（期货主连/外盘商品，
 * 因为新浪对它们的代码是另一套 `nf_*`/`hf_*`）；美股的新浪代码就是 `gb_` + 小写 ticker，
 * 全市场同一个形状 ⇒ 用规则才对得上任意自选股（否则每加一只美股都要改表）。
 *
 * **实测（2026-10-17）**：`gb_fro` 52.49 / -0.10%、`gb_vixy` 17.73 / +8.11%、`gb_spy` 763.25 / -1.11%
 * 与腾讯 `us*` 同刻一致。
 * ⚠ **未知 ticker 与腾讯行为不同**：腾讯不回行，而新浪会回一行"全零空壳"（实测 `gb_zzzz` 价格给 1.0000、
 * 其余全 0）⇒ 必须由 `gbRowOf` 的占位行判据丢掉，否则界面会把"没有这只票"显示成 1.00 / 0.00%。
 */
function sinaUsSymbolOf(secid: string): string | null {
  const dot = secid.indexOf('.')
  if (dot <= 0) return null
  const market = secid.slice(0, dot)
  if (market !== '105' && market !== '106' && market !== '107') return null
  const code = secid.slice(dot + 1).trim().toUpperCase()
  // 与腾讯侧同一形状约束：字母起头，允许数字与点（BRK.B 这类）
  if (!/^[A-Z][A-Z0-9.]{0,11}$/.test(code)) return null
  return `gb_${code.toLowerCase()}`
}

function sinaSymbolOf(secid: string): string | null {
  return SINA_BY_UPPER[secid.trim().toUpperCase()] ?? sinaUsSymbolOf(secid)
}

const SINA_SYMBOL: Record<string, string> = {
  // 注：`100.*`（国际指数）**故意不在本表**—— 见文件头的实测证据（int_* 是陈旧快照且无时间戳）
  '113.rbm': 'nf_RB0',
  '114.jmm': 'nf_JM0',
  '114.mm': 'nf_M0',
  '114.lhm': 'nf_LH0',
  '122.XAU': 'hf_XAU',
  '101.HG00Y': 'hf_HG',
  '101.SI00Y': 'hf_SI',
  '112.B00Y': 'hf_OIL',
}

// 建索引：查表一律走大写键（见 SINA_BY_UPPER 的说明）
for (const [secid, symbol] of Object.entries(SINA_SYMBOL)) SINA_BY_UPPER[secid.toUpperCase()] = symbol

export function sinaSymbol(secid: string): string | null {
  return sinaSymbolOf(secid)
}

/** 兜底源可解析的标的数（供自检断言：预设 23 只里应覆盖 ≥ 20） */
export function sinaCovered(secids: readonly string[]): number {
  return secids.filter((s) => sinaSymbolOf(s) !== null).length
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
  /** 成交量（股）—— 只有 `gb_*` 有该字段 */
  vol?: number | null
  /** 成交额（原币）—— 只有 `gb_*` 有该字段（美元） */
  amount?: number | null
  /** 总市值（原币）—— 只有 `gb_*` 有该字段（美元，下标 12） */
  totalMv?: number | null
  /** 股本/份额（股）—— 只有 `gb_*` 有该字段（下标 19） */
  shares?: number | null
  /** 上游自报的**成交**时刻（epoch ms）—— 只有 `gb_*` 有（美东，见 `parseSinaUsTradeStamp`） */
  time?: number | null
}

/**
 * 解析 `hq.sinajs.cn` 响应。三种受支持布局（实测字段下标）：
 *   nf_* （44 字段）：名称, 时间, 开, 高, 低, 昨收, 买, 卖, **最新**, 结算, …
 *   hf_* （14 字段）：**最新**, 昨收?, …, 开, 高, 低, 时间, **昨收**, …
 *   gb_* （36+ 字段）：**美股/美股 ETF**，下标见 `parseSinaGb`（价格/涨跌幅/开高低/量/额/市值/成交时刻）
 *
 * ⚠ `int_*`（国际指数，4 字段：名称/最新/涨跌额/涨跌幅）**不再解析**：它没有时间戳，
 * 无法判定新鲜度，且实测是陈旧快照（见文件头）。整族停用 ⇒ 任何调用方都不可能再拿到它
 * （比"映射表里不列"更硬：连手工构造的 payload 也解析不出来）。
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
    if (symbol.startsWith('nf_')) {
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
    } else if (symbol.startsWith('gb_')) {
      // 美股：字段语义与 nf_/hf_ 完全不同（下标见 parseSinaGb）⇒ 复用同一个下标表，不另抄一份
      const gb = gbRowOf(parts)
      if (gb === null || gb.price === null) continue
      q = {
        name: gb.name === '' ? symbol : gb.name,
        price: gb.price,
        prev: gb.prev,
        open: gb.open,
        high: gb.high,
        low: gb.low,
        // gb_ 自带现成的涨跌幅字段（下标 2），直接用它 —— 不再用 ±25% 的"昨收可疑"闸门
        //（那道闸门是为商品期货的不可靠昨收设的，用在股票/ETF 上会误杀真涨跌）
        pct: gb.pct,
        vol: gb.vol,
        amount: gb.amount,
        totalMv: gb.totalMv,
        shares: gb.shares,
        time: gb.tradeTime,
      }
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
    const symbol = sinaSymbolOf(secid)
    if (symbol !== null) pairs.push([secid, symbol])
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
      const res = await withHostBreaker('hq.sinajs.cn', () =>
        fetch(url, {
          headers: { 'user-agent': UA, referer: 'https://finance.sina.com.cn/' },
          signal: AbortSignal.timeout(10000),
        }),
      )
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

/**
 * ── 全球五市场（宽基 ETF 规模权重）用的新浪取数原语 ──────────────────────────
 *
 * 全部是 2026-10-12 本机实测的形状（原始回包见 docs/AUDIT-IMPL45.md §2）：
 *   · 规模：`hq.sinajs.cn/list=gb_spy` 的**第 13 个字段（1 起数）= 下标 12 =「总市值」**（美元）。
 *     ⚠ 用户口径里写的"字段 13"是**1 起数**：下标 13 是市盈率（实测恒 0.00）——
 *     这里按 `price × 股本(下标 19)` 交叉校验总市值，两者必须一致（实测 822272781554 = 778.57 × 1056132116）。
 *   · A股规模：ETF 节点的 `nmc`（万元）—— **不是 `mktcap`**（实测 510300：nmc 10635037.4372 万元
 *     = 1063.50 亿元，与腾讯 f45「总市值」1063.50 亿元一致；同一个 ETF 的 `mktcap` 只有 824.69 亿元）。
 *   · 日线：`stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/x/US_MinKService.getDailyK?symbol=vgk`
 *     （jsonp 形态，含全历史；腾讯 `usVGK` 实测只回 1 根 ⇒ 美股 ETF 日线只能走这条）。
 *   · 资金流：`MoneyFlow.ssl_qsfx_zjlrqs?daima=sh510300`（逐日 `netamount`，元）。
 *   · 汇率：`hq.sinajs.cn/list=fx_susdcny`（下标 8 = 最新，下标 3 = 昨收）。
 */

/** 抓一段新浪文本（GBK 或 UTF-8），统一带 Referer（实测不带会被拒） */
async function sinaText(url: string, opts: { gbk?: boolean; timeoutMs?: number } = {}): Promise<string> {
  // H1：统一走 per-host 熔断（否则单台挂起时每次都付满超时，且降级横幅看不见它）
  const res = await withHostBreaker(new URL(url).host, () =>
    fetch(url, {
      headers: { 'user-agent': UA, referer: 'https://finance.sina.com.cn/' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    }),
  )
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`)
  const buf = await res.arrayBuffer()
  try {
    return new TextDecoder(opts.gbk === false ? 'utf-8' : 'gbk').decode(buf)
  } catch {
    return new TextDecoder('latin1').decode(buf)
  }
}

export interface SinaBar {
  date: string
  open: number
  close: number
  high: number
  low: number
  /**
   * 成交量（**股**）。
   *
   * ⚠ 可空（REVIEW-7 D2）：上游对早期 bar 会给 `v: ""` 或 `v: "0"`，
   * `Number('')` = 0 ⇒ 旧写法 `num(it.v) ?? 0` 会把"没有"编码成 **0**，
   * 于是 `usAggregate` 的「任一日缺失 ⇒ 该根 vol 记 null」契约在真实链路上**永远走不到**
   * （实测构造载荷：一周 3 天里有 2 天是空 `v`，聚合结果仍是具体数字）。
   * 与同结构体的 `amount`（早就是 `number | null`）保持同一标准。
   */
  vol: number | null
  /**
   * 成交额（**美元**，新浪日线的 `a` 段）。
   * 实测：近期 bar 有值（`2026-10-16` FRO = 197,036,000，与 `gb_fro` 下标 30 的 197,036,261 同源），
   * 早期 bar 上游给 `"0"` ⇒ 这里如实给 null（**不把"没有"读成 0**）。
   */
  amount?: number | null
}

/** 解析新浪美股日线（jsonp：`/*<script>…*\/x([{d,o,h,l,c,v,a},…]);`） */
export function parseSinaUsDaily(payload: string): SinaBar[] {
  const from = payload.indexOf('[')
  const to = payload.lastIndexOf(']')
  if (from < 0 || to <= from) return []
  let rows: unknown
  try {
    rows = JSON.parse(payload.slice(from, to + 1))
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const out: SinaBar[] = []
  for (const raw of rows) {
    const it = raw as Record<string, unknown>
    const date = String(it.d ?? '').trim()
    const close = num(it.c)
    // 除权/停牌的行会给 0 或空 ⇒ 直接丢掉（不许把 0 当成一根 bar 混进收益率）
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || close === null || !(close > 0)) continue
    const amount = numField(it.a)
    out.push({
      date,
      open: num(it.o) ?? close,
      close,
      high: num(it.h) ?? close,
      low: num(it.l) ?? close,
      // 早期 bar 上游给 `""` / `"0"` ⇒ 按"没有"处理（缺失不许编码成 0）。
      // `numField` 只挡空串，`"0"` 还要再过一道 `> 0` —— 成交量 0 在日线上不是"零成交"，
      // 而是上游没给（真有零成交也不会出现在日线序列里）。
      vol: ((): number | null => {
        const v = numField(it.v)
        return v !== null && v > 0 ? v : null
      })(),
      // 早期 bar 上游给 "0" ⇒ 按"没有"处理（缺失不许编码成 0）
      amount: amount !== null && amount > 0 ? amount : null,
    })
  }
  return out
}

/**
 * ── 新浪**美股分钟**（AUDIT-IMPL68）────────────────────────────────────────
 *
 * 接口：`.../usstock/api/jsonp_v2.php/x/US_MinKService.getMinK?symbol=fro&type=<1|5|15>`
 *
 * **实测（2026-10-17，原始回包见 `docs/AUDIT-IMPL68.md` §3）**：
 *   · `type=1`（1 分钟）→ **1023 根 / 3 个交易日**（当日 390 根：09:31→16:00 ET）；
 *   · `type=5`（5 分钟）→ **1023 根 / 14 个交易日**（每日 78 根）；
 *   · `type=15`（15 分钟）→ **1023 根 / 40 个交易日**（每日 26 根）；
 *   · 三种都**恰好 1023 根**（上游硬上限）；时间戳是**美东墙上时间**，只含常规盘 09:30–16:00。
 *   · 每根字段：`d`（`YYYY-MM-DD HH:mm:ss`）· `o/h/l/c` · `v`（**股**）· `a`（**该根**成交额，美元）。
 *     实测 `15:20` 那根 `v=23743`、`a=1161990` ⇒ 1161990/23743 ≈ 48.94 = 当时价 ⇒ **是逐根额，不是累计额**。
 *   · 未知代码：返回 `null`（实测 `getMinK?symbol=zzzz` ⇒ 空），不会给假序列。
 */
export interface SinaUsMinBar {
  /** epoch ms（由**美东**墙上时间换算，`TZ` 无关） */
  t: number
  /** 上游原样的美东墙上时间 `YYYY-MM-DD HH:mm:ss`（界面按美东读，与 A股 的北京时间分开） */
  label: string
  price: number
  /** 成交量（**股**） */
  vol: number | null
  /** 该根成交额（**美元**） */
  amount: number | null
}

/** 解析新浪美股分钟 jsonp：`/*<script>…*\/x([{d,o,h,l,c,v,a},…]);` */
export function parseSinaUsMin(payload: string): SinaUsMinBar[] {
  const from = payload.indexOf('[')
  const to = payload.lastIndexOf(']')
  if (from < 0 || to <= from) return []
  let rows: unknown
  try {
    rows = JSON.parse(payload.slice(from, to + 1))
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const out: SinaUsMinBar[] = []
  for (const raw of rows) {
    const it = raw as Record<string, unknown>
    const label = String(it.d ?? '').trim()
    const price = num(it.c)
    // 时间戳必须能被**美东**换算：换算不出来的行直接丢（不许按本机时区猜）
    const t = usWallToEpoch(label)
    if (t === null || price === null || !(price > 0)) continue
    out.push({ t, label, price, vol: numField(it.v), amount: numField(it.a) })
  }
  return out
}

/** 拉新浪美股分钟（`type` = 1/5/15 分钟）；上游单次最多 1023 根 */
export async function fetchSinaUsMin(symbol: string, type: 1 | 5 | 15): Promise<SinaUsMinBar[]> {
  const sym = symbol.trim().toLowerCase()
  if (!/^[a-z.]{1,8}$/.test(sym)) throw new Error(`美股代码不合法：${symbol}`)
  const url = `https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/x/US_MinKService.getMinK?symbol=${sym}&type=${type}`
  return parseSinaUsMin(await sinaText(url, { gbk: false, timeoutMs: 20000 }))
}

/** 拉新浪美股（`us<ETF>`）全历史日线；调用方自己截尾（本接口不接受条数参数，实测） */
export async function fetchSinaUsDaily(symbol: string): Promise<SinaBar[]> {
  const sym = symbol.trim().toLowerCase()
  if (!/^[a-z.]{1,8}$/.test(sym)) throw new Error(`美股代码不合法：${symbol}`)
  const url = `https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/x/US_MinKService.getDailyK?symbol=${sym}`
  return parseSinaUsDaily(await sinaText(url, { gbk: false, timeoutMs: 20000 }))
}

export interface SinaGbQuote {
  name: string
  price: number | null
  pct: number | null
  /** 总市值（美元，下标 12）—— 用户口径里的"字段 13"（1 起数） */
  totalMv: number | null
  /** 股本（下标 19），用于与总市值交叉校验 */
  shares: number | null
  /** 快照时刻文本（下标 3，**北京时间**的下发时刻，不是成交时刻） */
  time: string | null
  /** 昨收（下标 26；缺失时用「最新 − 涨跌额」推导，两者都不可得则为 null） */
  prev: number | null
  open: number | null
  high: number | null
  low: number | null
  /** 成交量（**股**，下标 10） */
  vol: number | null
  /** 成交额（**美元**，下标 30） */
  amount: number | null
  /**
   * 最新成交时刻（epoch ms，**美东**）：取下标 24（含盘后的最新一笔）→ 回退下标 25（常规收盘）。
   * 解析不出就是 null —— 不拿下标 3 那个"下发时刻"冒充成交时刻。
   */
  tradeTime: number | null
}

/** `Oct 16 04:00PM EDT` → epoch ms（EDT=−4 / EST=−5；其它时区标记一律 null，不猜） */
function parseSinaUsTradeStamp(text: string | undefined, year: number | null): number | null {
  const m = /^([A-Z][a-z]{2}) (\d{1,2}) (\d{1,2}):(\d{2})(AM|PM) (EDT|EST)$/.exec((text ?? '').trim())
  if (m === null || year === null || !(year > 2000)) return null
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const month = MONTHS.indexOf(m[1]) + 1
  if (month === 0) return null
  const day = Number(m[2])
  const hour12 = Number(m[3])
  if (!(hour12 >= 1 && hour12 <= 12)) return null
  const hour = (hour12 % 12) + (m[5] === 'PM' ? 12 : 0)
  const wall = Date.UTC(year, month - 1, day, hour, Number(m[4]))
  // EDT = UTC−4 ⇒ UTC = 墙上时间 + 4h；EST = UTC−5 ⇒ +5h
  return wall + (m[6] === 'EDT' ? 4 : 5) * 3_600_000
}

/**
 * 解析 `gb_*`（美股/美股 ETF）行情行。
 *
 * 下标实测（2026-10-17，`gb_fro` / `gb_vixy` / `gb_spy` 三条原始回包见 `docs/PROBE-US-QUOTES.md` §3.2）：
 *   0 名称 · 1 最新 · 2 涨跌幅% · 3 下发时刻(北京) · 4 涨跌额 · 5 开 · 6 高 · 7 低 · 8 52周高 · 9 52周低
 *   10 成交量(股) · 11 均量 · 12 总市值(美元) · 13 市盈率 · … · 19 股本 · … · 24 最新成交(含盘后,ET)
 *   25 常规收盘(ET) · 26 昨收 · … · 29 年份 · 30 成交额(美元)
 * 交叉校验：`price × shares == totalMv`（FRO 52.49×222,622,894 = 11,685,475,706 ✔；VIXY 17.73×13,566,252 ✔）。
 */
export function parseSinaGb(payload: string): Record<string, SinaGbQuote> {
  const out: Record<string, SinaGbQuote> = {}
  for (const line of payload.split('\n')) {
    const m = /^var hq_str_(gb_[A-Za-z0-9._]+)="([^"]*)"/.exec(line.trim())
    if (m === null) continue
    const q = gbRowOf(m[2].split(','))
    if (q !== null) out[m[1]] = q
  }
  return out
}

/** 一条 `gb_*` 行的字段映射（下标见 `parseSinaGb` 的注释）；`parseSinaHq` 的 `gb_` 分支复用它 */
function gbRowOf(parts: string[]): SinaGbQuote | null {
  if (parts.length < 20) return null
  const price = numField(parts[1])
  const chg = numField(parts[4])
  const prevAt26 = numField(parts[26])
  const prev = prevAt26 ?? (price !== null && chg !== null ? price - chg : null)
  const year = numField(parts[29])
  const q: SinaGbQuote = {
    name: String(parts[0] ?? '').trim(),
    price,
    pct: numField(parts[2]),
    time: parts[3] === undefined ? null : String(parts[3]).trim(),
    totalMv: numField(parts[12]),
    shares: numField(parts[19]),
    prev,
    open: numField(parts[5]),
    high: numField(parts[6]),
    low: numField(parts[7]),
    vol: numField(parts[10]),
    amount: numField(parts[30]),
    tradeTime: parseSinaUsTradeStamp(parts[24], year) ?? parseSinaUsTradeStamp(parts[25], year),
  }
  /**
   * 占位行必须丢弃：新浪对**不存在的**美股代码会回一行"全零空壳"，
   * 实测 `gb_zzzz`（2026-10-17 抓包）：
   *   `ZZZZ,1.0000,0.00,2026-05-28 09:30:13,0,0,0,0,0,0,0,0,0,…,0,0,0.0000,…`
   * —— 价格给 **1.0000**、其余全 0、日期停在几个月前。若照收，界面会把"这只票不存在"
   * 显示成 "1.00 / 0.00%"，比"无行情源"更坏（编造）。
   * 判据：价格 > 0，且**至少有一项真实活动痕迹**（昨收 / 成交量 / 成交额 / 当日高低）。
   * 停牌股仍会留下昨收 ⇒ 不会被误杀。
   */
  const active = [q.prev, q.vol, q.amount, q.high, q.low].some((v) => v !== null && v > 0)
  if (q.price === null || !(q.price > 0) || !active) return null
  return q
}

/** 拉 `gb_*` 行情（`spy` → `gb_spy`） */
export async function fetchSinaGb(symbols: readonly string[]): Promise<Record<string, SinaGbQuote>> {
  const list = symbols.map((s) => `gb_${s.trim().toLowerCase()}`)
  if (list.length === 0) return {}
  return parseSinaGb(await sinaText(`https://hq.sinajs.cn/list=${list.join(',')}`))
}

export interface SinaEtfNodeRow {
  symbol: string
  name: string
  price: number | null
  pct: number | null
  /** 流通市值（**万元**）：ETF 的"规模"字段，实测与腾讯 f45 一致 */
  nmcWan: number | null
  /** 总市值（万元）：对 ETF 与 nmc 不同义（实测 510300 差 29%）⇒ 只作对照，不当规模用 */
  mktcapWan: number | null
}

/** 解析新浪 ETF 节点（`Market_Center.getHQNodeData`）的一页 */
export function parseSinaEtfNode(payload: string): SinaEtfNodeRow[] {
  let rows: unknown
  try {
    rows = JSON.parse(payload)
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const out: SinaEtfNodeRow[] = []
  for (const raw of rows) {
    const it = raw as Record<string, unknown>
    const symbol = String(it.symbol ?? '').trim().toLowerCase()
    if (!/^(sh|sz)\d{6}$/.test(symbol)) continue
    out.push({
      symbol,
      name: String(it.name ?? '').trim(),
      price: num(it.trade),
      pct: num(it.changepercent),
      nmcWan: num(it.nmc),
      mktcapWan: num(it.mktcap),
    })
  }
  return out
}

/**
 * 定位一只 ETF 的规模（万元）。
 *
 * 实测：`symbol=` 参数**不生效**（仍回第 1 页），`num` 上限 100 ⇒ 只能按 `symbol` 升序翻页找。
 * 因此这里翻到找到为止（上限 `maxPages`，默认 6 页；实测 `sh510300` 在第 1 页），
 * 每页约 37KB —— 调用方必须带长 TTL（日级数据，见 globalFlow.ts）。
 */
export async function fetchSinaEtfNodeSize(symbol: string, maxPages = 6): Promise<SinaEtfNodeRow> {
  const want = symbol.trim().toLowerCase()
  if (!/^(sh|sz)\d{6}$/.test(want)) throw new Error(`ETF 代码不合法：${symbol}`)
  let seen = 0
  for (let page = 1; page <= maxPages; page += 1) {
    const url =
      'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData' +
      `?page=${page}&num=100&sort=symbol&asc=1&node=etf_hq_fund`
    const rows = parseSinaEtfNode(await sinaText(url, { gbk: false }))
    seen += rows.length
    const hit = rows.find((r) => r.symbol === want)
    if (hit !== undefined) return hit
    if (rows.length === 0) break
  }
  throw new Error(`ETF 节点里没找到 ${want}（已翻 ${maxPages} 页 / ${seen} 行）`)
}

export interface SinaMoneyFlowDay {
  day: string
  /** 当日净流入（元）；上游给 `--`/空 ⇒ 跳过该日（不当 0） */
  netCny: number
}

/** 解析资金流序列（`MoneyFlow.ssl_qsfx_zjlrqs`） */
export function parseSinaMoneyFlow(payload: string): SinaMoneyFlowDay[] {
  const from = payload.indexOf('[')
  const to = payload.lastIndexOf(']')
  if (from < 0 || to <= from) return []
  let rows: unknown
  try {
    rows = JSON.parse(payload.slice(from, to + 1))
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const out: SinaMoneyFlowDay[] = []
  for (const raw of rows) {
    const it = raw as Record<string, unknown>
    const day = String(it.opendate ?? '').trim()
    const net = num(it.netamount)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || net === null) continue
    out.push({ day, netCny: net })
  }
  return out
}

/** 拉某标的最近 `days` 个交易日的逐日净流入（元） */
export async function fetchSinaMoneyFlow(symbol: string, days = 20): Promise<SinaMoneyFlowDay[]> {
  const want = symbol.trim().toLowerCase()
  if (!/^(sh|sz)\d{6}$/.test(want)) throw new Error(`资金流代码不合法：${symbol}`)
  const url =
    'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs' +
    `?page=1&num=${Math.max(1, Math.round(days))}&sort=opendate&asc=0&daima=${want}`
  return parseSinaMoneyFlow(await sinaText(url, { gbk: false }))
}

export interface SinaFxQuote {
  /** 最新价（下标 8） */
  rate: number | null
  /** 昨收（下标 3）—— 用于剔除明显错值（|涨跌| < 5%） */
  prev: number | null
  /** 上游时刻文本（下标 0，只有 HH:mm:ss） */
  time: string | null
  name: string | null
}

/**
 * 解析新浪外汇行。实测 `fx_susdcny` 的下标：
 *   [0] 时间 [1] 买价 [2] 卖价 [3] 昨收 [4] 成交量 [5] 开 [6] 高 [7] 低 [8] **最新** [9] 名称 [10] 涨跌幅%
 * 交叉校验：(最新 − 昨收) / 昨收 × 100 ≈ 下标 10（实测 (6.6937−6.6929)/6.6929 = 0.012%）。
 */
export function parseSinaFx(payload: string, symbol: string): SinaFxQuote {
  const m = new RegExp(`^var hq_str_${symbol.replace(/\./g, '\\.')}="([^"]*)"`, 'm').exec(payload)
  if (m === null) return { rate: null, prev: null, time: null, name: null }
  const parts = m[1].split(',')
  if (parts.length < 10) return { rate: null, prev: null, time: null, name: null }
  const rate = num(parts[8])
  const prev = num(parts[3])
  const sane = rate !== null && rate > 0 && (prev === null || prev <= 0 || Math.abs(rate / prev - 1) < 0.05)
  return { rate: sane ? rate : null, prev, time: parts[0] === undefined ? null : String(parts[0]).trim(), name: parts[9] === undefined ? null : String(parts[9]).trim() }
}

/**
 * 拉一条新浪外汇行情（`fx_*` 符号，例如 `fx_susdcny` 在岸人民币 / `fx_susdhkd` 美元兑港元即期）。
 * 两条的下标布局一致（见 `parseSinaFx`）。
 */
export async function fetchSinaFxRate(symbol: string): Promise<SinaFxQuote> {
  const sym = symbol.trim()
  // ⚠ 币种对是 6–8 个字母：`fx_susdcny` / `fx_susdhkd` / `fx_shkdcny`（早先写成恰好 6 个 ⇒ 直接把请求挡掉）
  if (!/^fx_[a-z]{6,8}$/.test(sym)) throw new Error(`外汇符号不合法：${symbol}`)
  return parseSinaFx(await sinaText(`https://hq.sinajs.cn/list=${sym}`), sym)
}

/** 拉美元兑人民币在岸价（新浪 `fx_susdcny`）—— `fetchSinaFxRate` 的便捷包装 */
export async function fetchSinaFxUsdCny(): Promise<SinaFxQuote> {
  return fetchSinaFxRate('fx_susdcny')
}

/** 拉取新浪 ETF 排行（成交额或涨跌幅降序） */
export async function fetchSinaEtfRanking(sort: 'pct' | 'amount' = 'amount', limit = 40): Promise<SinaEtfRow[]> {
  const field = sort === 'amount' ? 'amount' : 'changepercent'
  const url =
    'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData' +
    `?page=1&num=${limit}&sort=${field}&asc=0&node=etf_hq_fund`
  const res = await withHostBreaker('vip.stock.finance.sina.com.cn', () =>
    fetch(url, {
      headers: { 'user-agent': UA, referer: 'https://finance.sina.com.cn/' },
      signal: AbortSignal.timeout(12000),
    }),
  )
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
