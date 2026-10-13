/**
 * 全球五市场「宽基 ETF 规模权重」数据层（工具箱 → 工具①「全球资金流蛋糕模型」）。
 *
 * ── 口径（用户已定，写死在代码里；**改口径必须先改这里 + 口径标识 + docs**）──────────
 *  成分 v2（2026-10-12 用户改口径）= **A股、港股、美国、日本、韩国**；口径标识 `FLOW_SCOPE`；
 *  旧成分（美股/欧股/日股/A股/新兴市场，v1）**已废弃**，相关历史见 docs/AUDIT-IMPL45.md 与
 *  docs/AUDIT-IMPL47.md（变更依据、逐市场可得性实测）。
 *
 *  ① **份额 = 该市场规模 ÷ Σ 有值市场规模**。分母只含**有值**的市场：某个市场取不到数时，
 *     它既不做分子也不做分母，并在该行如实显示「未取到 + 原因」⇒ 有值部分的份额合计恒为 100%
 *     （±0.1 显示位）。**绝不用 0 补位**（0 会被读成"这个市场没有规模"）。
 *  ② **规模 = 该市场宽基 ETF 的规模**：A股 510300（新浪 ETF 节点 `nmc`，万元，人民币）、
 *     港股 02800 盈富基金（腾讯 `f45` 总市值，**亿港元**）、美国 SPY 与 日本 EWJ
 *     （新浪 `gb_*` 的「总市值」，美元；缺失时兜底腾讯 `f71` 股本 × 最新价）、
 *     韩国 EWY（腾讯 `f71` 股本 × 最新价 —— 新浪 `gb_ewy` 的「总市值」实测恒为 0）。
 *  ③ **币种必须统一**：A股人民币 → `fx_susdcny`，港股港元 → `fx_susdhkd`，折成美元后再进分母。
 *     对应汇率取不到时**不许静默混算**：该市场规模按原币单列、不进美元合计，并如实标注口径不一致。
 *  ④ **动量 = 20/60/120 日收益率 + 横截面排序**：A股 沪深 300、港股 恒生指数（`hkHSI`）、美国 标普 500、
 *     日本 EWJ / 韩国 EWY（**KOSPI200 在腾讯与新浪都没有日线源**，实测四个候选代码全 `pv_none_match`）；
 *     分别算 20/60/120 个**该市场交易日**的收益率；
 *     每个口径先横截面排名（1 = 最强），综合分 = 各口径名次的均值，再按综合分排名。
 *     某市场某个口径样本不足 ⇒ 该项 null（不参与该口径排名），综合分只用能算出来的部分。
 *  ⑤ **A股净流入（`MoneyFlow.ssl_qsfx_zjlrqs` 的 20 日 netamount）单列，不参与份额/规模计算** ——
 *     它是"流量"，与"存量加权"是两种量纲；混算会把 20 天的净流入加进某一天的规模里。
 *  ⑥ 时间一律 `Asia/Shanghai`（`dayOf`）。**不显示"延迟 15 分钟"提示**（用户明确要求）。
 *
 * ── 数据来源（全部公开源；**不**用 Arkvol 数据、**不**标 Arkvol 来源）────────────────
 *   腾讯：`web.ifzq.gtimg.cn` 日线（美股 `us.INX`／A股 `sh000300`／`sh510300`／港股 `hk02800`／`hkHSI`）、
 *         `qt.gtimg.cn` 行情（港股 `hk02800` 的总市值；美股 ETF 的 `f71` 股本）
 *   新浪：`hq.sinajs.cn`（`gb_*` 规模、`fx_susdcny`/`fx_susdhkd` 汇率）、`vip.stock.finance.sina.com.cn`
 *         （ETF 节点 `nmc`、MoneyFlow 资金流）、`stock.finance.sina.com.cn`（美股 ETF 日线）
 *   所有新浪请求都带 `Referer: https://finance.sina.com.cn`（见 sina.ts）。
 *   **不走东财 `push2*`**（本机实测 0 成功率）；新浪 `int_*` 族仍禁用（陈旧快照 + 无时间戳）。
 *
 * ── 缓存/去重/快照（沿用仓库数据层规矩，见 docs/AUDIT-CACHE-1/-2）──────────────────
 *   · 三层 TTL，值小、TTL 长（用户明确要求"量小就大幅延长缓存"）：
 *       现价类（规模/汇率/资金流）30 分钟；日线类 12 小时；最终载荷 10 分钟（残缺时 2 分钟）；
 *   · **并发同键只在飞一份**（`cached` 里的 in-flight 合并）⇒ 并发两次请求上游只打一遍；
 *   · **失败不进缓存**（与仓库既有口径一致：缺口下一次调用会重试）；
 *   · **每日快照** `global-flow.json`：一天一条、保留 90 天（一天 ≈ 0.9KB ⇒ 90 天 ≈ 80KB，
 *     因此 TTL 可以放长）；快照供 30 日手动回放 —— 回放走本地文件，**不发任何上游请求**。
 *
 * ── 曲线口径（**必须写清，否则会被读成实测值**）────────────────────────────────────
 *   180 日份额曲线里：当天（以及任何有快照的日期）用**实测规模**（origin = observed）；
 *   其余历史日按 `当前实测规模 × 该市场日线收盘价之比` 重建（origin = rebuilt）——
 *   即**假定各 ETF 的份额数量不变**，因此曲线只反映**价格驱动的相对规模变化**，
 *   **不反映申赎**。跨市场交易日不同（A股与美股节假日不同）时按"最近一个已知收盘价"前向填充。
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { MissingField } from '../shared/model.ts'
import { writeJsonAtomic } from './atomic.ts'
import { log } from './context.ts'
import { isFirstBoot, quarantineFile, ReadGuard } from './readGuard.ts'
import { dataHome } from './store.ts'
import { fetchTencentDaily, fetchTencentRawQuotes } from './tencent.ts'
import { dayOf } from './time.ts'
import {
  fetchSinaEtfNodeSize,
  fetchSinaFxRate,
  fetchSinaGb,
  fetchSinaMoneyFlow,
  fetchSinaUsDaily,
  type SinaBar,
  type SinaMoneyFlowDay,
} from './sina.ts'

// ── 五市场定义（顺序 = 页面顺序；测试锁它） ────────────────────────────────────

export type FlowMarketKey = 'cn' | 'hk' | 'us' | 'jp' | 'kr'
/** 展示顺序 = 需求文档 T-5 的列举顺序（A股、港股、美国、日本、韩国）—— 断言逐字锁它 */
export const FLOW_MARKET_ORDER: readonly FlowMarketKey[] = ['cn', 'hk', 'us', 'jp', 'kr']

/**
 * 口径标识（写进快照文件）：五市场成分一变，**旧快照一律作废**（不许与新成分混用）。
 * v1（v0.72.0）= 美股/欧股/日股/A股/新兴市场；v2（本版）= A股/港股/美国/日本/韩国。
 */
export const FLOW_SCOPE = 'v2:cn,hk,us,jp,kr'

export interface FlowMarketDef {
  key: FlowMarketKey
  name: string
  /** 规模口径标的（宽基 ETF） */
  etf: string
  /** 规模来源（出处块按"需要时才标"的原则，只在这张表里写一次） */
  aumSource: string
  /** 该市场规模的原币 */
  currency: 'USD' | 'CNY' | 'HKD'
  /** 动量口径标的 */
  benchmark: string
  benchmarkSource: string
}

/**
 * 五市场定义（用户口径 v2：A股、港股、美国、日本、韩国）。
 *
 * 规模取数路径（2026-10-12 本机实测，原始回包见 docs/AUDIT-IMPL47.md §1）：
 *   · A股 ：新浪 ETF 节点 `nmc`（510300，万元，人民币）—— 与腾讯 f45/f72 交叉一致
 *   · 港股：腾讯 `hk02800` 的 **f45「总市值」= 亿港元**（实测 1262.1791 亿港元；同字段对腾讯控股
 *           = 38716 亿港元、汇丰 25377 亿港元，与已知市值吻合 ⇒ 量纲确认）
 *   · 美国：新浪 `gb_spy` 的「总市值」（美元）；缺失时兜底腾讯 `usSPY` 的 f71（股本）× 最新价
 *   · 日本：新浪 `gb_ewj` 的「总市值」（美元）；缺失时兜底腾讯 `usEWJ` 的 f71 × 最新价
 *           （两条路径实测一致：97.375 × 243300000 = 236.91 亿美元 ↔ 新浪 236.913375 亿美元）
 *   · 韩国：**新浪 `gb_ewy` 的该字段实测为 0（不可用）** ⇒ 用腾讯 `usEWY` 的 f71（股本 142550000）
 *           × 最新价 = 243.4 亿美元（f71 与新浪「股本」字段同义：EWJ/SPY 两条路径都对得上）
 *
 * 动量口径：A股 沪深300（腾讯 sh000300）、港股 恒生指数（腾讯 hkHSI）、美国 标普 500（腾讯 us.INX）、
 * 日本/韩国 = EWJ / EWY 自身日线（**KOSPI200 在腾讯/新浪都没有日线** —— 实测 `us.KOSPI200`/`kr.KOSPI`/
 * `hkKOSPI200`/`us.KOSPI` 全 `pv_none_match`；新浪 `int_*` 族仍禁用）。
 */
export const FLOW_MARKETS: readonly FlowMarketDef[] = [
  { key: 'cn', name: 'A股', etf: '510300', aumSource: '新浪 ETF 节点 nmc（万元，人民币）', currency: 'CNY', benchmark: '沪深 300', benchmarkSource: '腾讯 sh000300 日线' },
  { key: 'hk', name: '港股', etf: '02800 盈富基金', aumSource: '腾讯 hk02800 总市值（亿港元）', currency: 'HKD', benchmark: '恒生指数', benchmarkSource: '腾讯 hkHSI 日线' },
  { key: 'us', name: '美国', etf: 'SPY', aumSource: '新浪 gb_spy 总市值（美元）', currency: 'USD', benchmark: '标普 500', benchmarkSource: '腾讯 us.INX 日线' },
  { key: 'jp', name: '日本', etf: 'EWJ', aumSource: '新浪 gb_ewj 总市值（美元）', currency: 'USD', benchmark: 'EWJ 日本宽基', benchmarkSource: '新浪美股日线 EWJ' },
  { key: 'kr', name: '韩国', etf: 'EWY', aumSource: '腾讯 usEWY 股本（f71）× 最新价（美元）', currency: 'USD', benchmark: 'EWY 韩国宽基', benchmarkSource: '新浪美股日线 EWY' },
]

/** 汇率对：原币 → 美元。美/日/韩 直接用美元 ETF ⇒ 不需要汇率 */
export const FLOW_FX_SYMBOLS: Record<'CNY' | 'HKD', string> = { CNY: 'fx_susdcny', HKD: 'fx_susdhkd' }
/** 原币 → 该币种的"1 美元值多少原币"的换算标签（口径行/行级原因用） */
export const FLOW_FX_LABEL: Record<'CNY' | 'HKD', string> = { CNY: '美元/人民币', HKD: '美元/港元' }

/** 规模（AUM）取数路径 */
type AumRoute =
  | { kind: 'sina-etf'; symbol: string }
  | { kind: 'sina-gb'; symbol: string; fallbackTencent: string }
  | { kind: 'tencent-quote'; code: string }
  | { kind: 'tencent-shares'; code: string }
const AUM_ROUTE: Record<FlowMarketKey, AumRoute> = {
  cn: { kind: 'sina-etf', symbol: 'sh510300' },
  hk: { kind: 'tencent-quote', code: 'hk02800' }, // 港股 f45 = 总市值（亿港元），走"市值字段"分支
  us: { kind: 'sina-gb', symbol: 'spy', fallbackTencent: 'usSPY' },
  jp: { kind: 'sina-gb', symbol: 'ewj', fallbackTencent: 'usEWJ' },
  kr: { kind: 'tencent-shares', code: 'usEWY' },
}
/** 需要从腾讯行情里拿 f45/f71 的**原码**（一次批量取，冷启动只多 1 次请求） */
const TENCENT_AUM_CODES: readonly string[] = ['hk02800', 'usSPY', 'usEWJ', 'usEWY']

/** 曲线重建用的价格序列（= 规模口径标的自身的日线） */
const CURVE_SYMBOL: Record<FlowMarketKey, { via: 'sina-us' | 'tencent'; symbol: string }> = {
  cn: { via: 'tencent', symbol: '1.510300' },
  hk: { via: 'tencent', symbol: '116.02800' },
  us: { via: 'sina-us', symbol: 'spy' },
  jp: { via: 'sina-us', symbol: 'ewj' },
  kr: { via: 'sina-us', symbol: 'ewy' },
}
/**
 * 动量口径：A股 沪深300；港股 恒生指数（`100.HSI` → 腾讯 `hkHSI`）；美国 标普500；
 * 日本/韩国 = 该 ETF 自身日线（KOSPI200 无日线源，见文件头实测）
 */
const MOMENTUM_SYMBOL: Record<FlowMarketKey, { via: 'sina-us' | 'tencent'; symbol: string }> = {
  cn: { via: 'tencent', symbol: '1.000300' },
  hk: { via: 'tencent', symbol: '100.HSI' },
  us: { via: 'tencent', symbol: '100.SPX' },
  jp: { via: 'sina-us', symbol: 'ewj' },
  kr: { via: 'sina-us', symbol: 'ewy' },
}

// ── TTL（用户要求：量小则大幅延长缓存） ───────────────────────────────────────

/** 现价类（规模/汇率/资金流）：30 分钟。规模是日级量，日内只会随价格小幅漂移 */
export const FLOW_QUOTE_TTL_MS = 30 * 60_000
/** 日线类：12 小时。日线一天只更新一次，跨夜后自动过期 */
export const FLOW_SERIES_TTL_MS = 12 * 60 * 60_000
/** 最终载荷：全齐时 10 分钟；有缺项时 2 分钟（让恢复能很快被看见） */
export const FLOW_PAYLOAD_TTL_MS = 10 * 60_000
export const FLOW_PAYLOAD_TTL_PARTIAL_MS = 2 * 60_000
/**
 * 曲线窗口（用户口径 v0.81.0）：**90 / 180 / 365 个序列日可切换**（分段控件在详情页 Hero 右上角）。
 *
 * 实现取舍：宿主**一次构建到最大窗口**（`FLOW_CURVE_WINDOW_MAX`），客户端在这条曲线上**本地切片**
 * 出 90 / 180 / 365 —— 切档不发请求、不重算份额，三个窗口天然共用同一条日线序列；
 * 代价是载荷大一点（≈ 每点 0.3KB × 365 ⇒ 约 105KB，本机 localhost 可接受）。
 */
export const FLOW_CURVE_WINDOWS: readonly number[] = [90, 180, 365]
/** 默认窗口（首次打开时的选中档） */
export const FLOW_CURVE_WINDOW = 180
/** 实际构建的窗口 = 最大档（客户端从它切片） */
export const FLOW_CURVE_WINDOW_MAX = 365
export const FLOW_REPLAY_DAYS = 30
/** 快照保留天数 */
export const FLOW_SNAPSHOT_KEEP_DAYS = 90
/** 轮动判定的最小幅度（百分点）：低于它就算"未见明确轮动" */
export const FLOW_ROTATION_MIN_PP = 0.05
/** 轮动/变化窗口（交易日 = 序列日） */
export const FLOW_ROTATION_WINDOW = 5
/** 快照落盘节流 */
const SNAPSHOT_WRITE_MIN_MS = 5 * 60_000

// ── 带 TTL + 在飞合并的取数层 ────────────────────────────────────────────────

interface CacheSlot {
  at: number
  value: unknown
}

const flowCache = new Map<string, CacheSlot>()
const flowInflight = new Map<string, Promise<unknown>>()
/** 最终载荷的独立缓存（TTL 取决于"这次有没有缺项"，所以不放进通用 `cached`） */
let payloadCache: { at: number; value: GlobalFlowPayload } | null = null

/** 测试钩子：清空缓存（断言"冷启动只打一遍上游"要用） */
export function __resetFlowCache(): void {
  flowCache.clear()
  flowInflight.clear()
  payloadCache = null
  lastSnapshotWriteAt = 0
}

/**
 * TTL + in-flight 合并。**失败不进缓存**（下一次调用会重新打上游）——
 * 与 `AUDIT-CACHE-1` 里"失败也进负缓存"的那几条不同：这里是低频日级数据，
 * 重试成本远低于把一次抖动锁 10 分钟。
 */
async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const hit = flowCache.get(key)
  const now = Date.now()
  if (hit !== undefined && now - hit.at < ttlMs) return hit.value as T
  const flying = flowInflight.get(key)
  if (flying !== undefined) return (await flying) as T
  const started = loader().then(
    (value) => {
      flowCache.set(key, { at: Date.now(), value })
      flowInflight.delete(key)
      return value
    },
    (error) => {
      flowInflight.delete(key)
      throw error
    },
  )
  flowInflight.set(key, started as Promise<unknown>)
  return (await started) as T
}

// ── 纯计算：规模 → 份额、动量、横截面排名、轮动、曲线 ─────────────────────────

export interface FlowSeriesPoint {
  date: string
  close: number
}

/** 两条汇率（都是"1 美元 = 多少原币"）：人民币与港元 —— 任一缺失 ⇒ 该币种的市场不折算 */
export interface FlowRates {
  usdCny: number | null
  usdHkd: number | null
}

/**
 * 原币 → 美元；**汇率缺失时不许静默当成美元**（返回 null，调用方标口径不一致 + 该行给原因）。
 * 美/日/韩 用美股上市的 ETF ⇒ 天然美元，不需要汇率。
 */
export function toUsd(native: number | null, currency: 'USD' | 'CNY' | 'HKD', rates: FlowRates): number | null {
  if (native === null || !Number.isFinite(native) || native <= 0) return null
  if (currency === 'USD') return native
  const rate = currency === 'CNY' ? rates.usdCny : rates.usdHkd
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return null
  return native / rate
}

/**
 * 份额（0–1）：分母 = **有值市场**之和。全缺 ⇒ 全 null（不返回 0/1/N 这种假值）。
 * 除法后做一次"合计校验"由调用方断言（`sharesSumPct`）。
 */
export function sharesOf(aumUsd: ReadonlyArray<number | null>): Array<number | null> {
  let total = 0
  let any = false
  for (const v of aumUsd) {
    if (v !== null && Number.isFinite(v) && v > 0) {
      total += v
      any = true
    }
  }
  if (!any || total <= 0) return aumUsd.map(() => null)
  return aumUsd.map((v) => (v !== null && Number.isFinite(v) && v > 0 ? v / total : null))
}

/** 份额合计（百分点）：只累加有值的项；没有任何有值项 ⇒ null */
export function sharesSumPct(shares: ReadonlyArray<number | null>): number | null {
  let sum = 0
  let any = false
  for (const s of shares) {
    if (s !== null && Number.isFinite(s)) {
      sum += s
      any = true
    }
  }
  return any ? sum * 100 : null
}

export interface FlowMomentum {
  d20: number | null
  d60: number | null
  d120: number | null
}

/** 三个口径的日数（写死；改口径要同步文档与断言） */
export const FLOW_HORIZONS = [20, 60, 120] as const

/** 某市场自己的第 idx 根 bar 往回 n 根的收益率；样本不足 ⇒ null（不外推） */
export function momentumOf(series: readonly FlowSeriesPoint[]): FlowMomentum {
  const out: FlowMomentum = { d20: null, d60: null, d120: null }
  if (series.length === 0) return out
  const last = series[series.length - 1]
  const ret = (n: number): number | null => {
    const idx = series.length - 1 - n
    if (idx < 0) return null
    const base = series[idx].close
    if (!(base > 0) || !(last.close > 0)) return null
    return (last.close / base - 1) * 100
  }
  out.d20 = ret(FLOW_HORIZONS[0])
  out.d60 = ret(FLOW_HORIZONS[1])
  out.d120 = ret(FLOW_HORIZONS[2])
  return out
}

/**
 * 横截面排名（1 = 最强）。
 *
 * 规则（写死）：每个口径各自排名（并列同名次：相同值给相同名次，名次按"比它强的有几个 + 1"），
 * 综合分 = 各**能算出**的口径名次的均值（算不出的不参与）；再按综合分排名。
 * 一个口径都算不出来 ⇒ 该市场 null。
 */
export function momentumRanks(mom: ReadonlyArray<FlowMomentum | null>): Array<number | null> {
  const horizons: Array<keyof FlowMomentum> = ['d20', 'd60', 'd120']
  return momentumRanksWith(mom, horizons)
}

function momentumRanksWith(mom: ReadonlyArray<FlowMomentum | null>, horizons: ReadonlyArray<keyof FlowMomentum>): Array<number | null> {
  const n = mom.length
  const composite: Array<number | null> = new Array(n).fill(null)
  const sum = new Array<number>(n).fill(0)
  const cnt = new Array<number>(n).fill(0)
  for (const h of horizons) {
    const vals = mom.map((m) => (m === null ? null : m[h]))
    const present = vals.filter((v): v is number => v !== null && Number.isFinite(v))
    for (let i = 0; i < n; i += 1) {
      const v = vals[i]
      if (v === null || !Number.isFinite(v)) continue
      // 并列取"最靠前"的名次（比它强的数量 + 1）
      const better = present.filter((p) => p > v).length
      sum[i] += better + 1
      cnt[i] += 1
    }
  }
  for (let i = 0; i < n; i += 1) if (cnt[i] > 0) composite[i] = sum[i] / cnt[i]
  const presentC = composite.filter((c): c is number => c !== null)
  if (presentC.length === 0) return composite.map(() => null)
  return composite.map((c) => {
    if (c === null) return null
    return presentC.filter((p) => p < c).length + 1
  })
}

export type FlowRotationKind = 'rotation' | 'flat' | 'unknown'

export interface FlowRotation {
  kind: FlowRotationKind
  /** 份额下降最多（资金"从"这里走） */
  fromKey: FlowMarketKey | null
  /** 份额上升最多 */
  toKey: FlowMarketKey | null
  /** 窗口内最大变动绝对值（百分点）；判不出来 ⇒ null */
  maxAbsPp: number | null
  /** 可比市场数（两侧都有值的市场） */
  comparable: number
  window: number
  text: string
}

/**
 * 5 日轮动：比较"最新一日"与"5 个序列日之前"的份额，取增幅最大与降幅最大的两个市场。
 * 无明确轮动（两侧幅度都 < `FLOW_ROTATION_MIN_PP`，或只有不到 2 个可比市场）时给**等价文案**，
 * 不许硬凑一个"从 X 转向 Y"。
 */
export function rotationOf(input: {
  latest: ReadonlyArray<number | null>
  previous: ReadonlyArray<number | null> | null
  window?: number
}): FlowRotation {
  const window = input.window ?? FLOW_ROTATION_WINDOW
  const prev = input.previous
  if (prev === null) {
    return { kind: 'unknown', fromKey: null, toKey: null, maxAbsPp: null, comparable: 0, window, text: `序列里还没有 ${window} 个交易日之前的点 ⇒ 本轮判不了轮动（不是"没有轮动"）` }
  }
  const deltas: Array<{ key: FlowMarketKey; d: number }> = []
  for (let i = 0; i < FLOW_MARKET_ORDER.length; i += 1) {
    const a = input.latest[i]
    const b = prev[i]
    if (a === null || b === null || a === undefined || b === undefined) continue
    deltas.push({ key: FLOW_MARKET_ORDER[i], d: (a - b) * 100 })
  }
  if (deltas.length < 2) {
    return { kind: 'unknown', fromKey: null, toKey: null, maxAbsPp: null, comparable: deltas.length, window, text: `两侧都有份额的市场只有 ${deltas.length} 个 ⇒ 本轮判不了轮动（不是"没有轮动"）` }
  }
  const up = deltas.reduce((m, x) => (x.d > m.d ? x : m))
  const down = deltas.reduce((m, x) => (x.d < m.d ? x : m))
  const maxAbs = Math.max(Math.abs(up.d), Math.abs(down.d))
  const name = (k: FlowMarketKey): string => FLOW_MARKETS.find((m) => m.key === k)?.name ?? k
  if (up.d < FLOW_ROTATION_MIN_PP || down.d > -FLOW_ROTATION_MIN_PP) {
    return {
      kind: 'flat',
      fromKey: null,
      toKey: null,
      maxAbsPp: maxAbs,
      comparable: deltas.length,
      window,
      text: `近 ${window} 个交易日各市场份额基本持平（最大变动 ${signedPp(up.d >= -down.d ? up.d : down.d)}，低于 ${FLOW_ROTATION_MIN_PP}pp 的判定线）⇒ 未见明确轮动`,
    }
  }
  return {
    kind: 'rotation',
    fromKey: down.key,
    toKey: up.key,
    maxAbsPp: maxAbs,
    comparable: deltas.length,
    window,
    text: `从 ${name(down.key)} 转向 ${name(up.key)}（${window} 日份额 ${signedPp(down.d)} → ${signedPp(up.d)}）`,
  }
}

/** 带符号的百分点文本（+0.41pp / -0.62pp） */
export function signedPp(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '-' : ''
  return `${sign}${Math.abs(n).toFixed(2)}pp`
}

/**
 * 等间隔对齐：把各市场序列按日期并集（可再并入 `extraDays`，例如实测快照日）对齐，
 * 缺口用**最近一个已知收盘价**前向填充；只保留最后的 `window` 个日期。
 *
 * 为什么按日期并集：五个市场的交易日历不同（A股与美股节假日不同），用并集 + 前向填充
 * 是"同一天看同一屏"的唯一自洽做法（另一条路是各市场各自画，那就没法比份额）。
 */
export function alignSeries(
  series: ReadonlyArray<readonly FlowSeriesPoint[] | null>,
  window: number,
  extraDays: readonly string[] = [],
): { days: string[]; closes: Array<Array<number | null>> } {
  const axisSet = new Set<string>(extraDays)
  for (const s of series) for (const p of s ?? []) axisSet.add(p.date)
  const allDays = [...axisSet].sort()
  const days = allDays.slice(Math.max(0, allDays.length - window))
  const closes = series.map((s) => {
    const out: Array<number | null> = new Array(days.length).fill(null)
    if (s === null || s.length === 0) return out
    const sorted = [...s].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    let idx = -1
    let last: number | null = null
    for (let i = 0; i < days.length; i += 1) {
      while (idx + 1 < sorted.length && sorted[idx + 1].date <= days[i]) {
        idx += 1
        last = sorted[idx].close
      }
      out[i] = last
    }
    return out
  })
  return { days, closes }
}

export interface FlowPoint {
  day: string
  origin: 'observed' | 'rebuilt'
  /** 各市场规模（美元），顺序 = FLOW_MARKET_ORDER */
  aumUsd: Array<number | null>
  /** 各市场份额（0–1） */
  share: Array<number | null>
  /** 该日是否有市场缺值（分母只含有值市场） */
  partial: boolean
}

export interface ObservedDay {
  at: number
  rates: FlowRates
  /** 各市场**原币**规模 */
  aumNative: Array<number | null>
}

/**
 * 建曲线：有实测快照的日期用实测（origin = observed），其余用
 * `当前实测规模 × 该市场收盘价 / 该市场最新收盘价` 重建（origin = rebuilt）。
 *
 * `anchors` = 各市场**当前实测**美元规模；null 表示该市场当前取不到 ⇒ 整条序列都是 null
 * （**不做任何替代**：宁可这一行整段"未取到"，也不拿价格变动冒充规模）。
 */
export function buildCurve(input: {
  anchors: ReadonlyArray<number | null>
  chartSeries: ReadonlyArray<readonly FlowSeriesPoint[] | null>
  observed: ReadonlyMap<string, ObservedDay>
  marketCurrency: ReadonlyArray<'USD' | 'CNY' | 'HKD'>
  window?: number
}): FlowPoint[] {
  const window = input.window ?? FLOW_CURVE_WINDOW
  // 轴 = 各市场交易日 ∪ 快照日（快照日可能落在周末/节假日，不并进来就会丢掉那一天的实测值）
  const { days, closes } = alignSeries(input.chartSeries, window, [...input.observed.keys()])
  const anchors = input.chartSeries.map((s, i) => {
    const aum = input.anchors[i]
    if (aum === null || !(aum > 0)) return null
    if (s === null || s.length === 0) return null
    const sorted = [...s].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    const lastClose = sorted[sorted.length - 1].close
    if (!(lastClose > 0)) return null
    return { aum, lastClose }
  })
  const points: FlowPoint[] = []
  for (let i = 0; i < days.length; i += 1) {
    const day = days[i]
    const obs = input.observed.get(day)
    let aumUsd: Array<number | null>
    let origin: 'observed' | 'rebuilt'
    if (obs !== undefined) {
      // 实测日：只用实测值。那次缺哪个市场就是缺哪个（**不拿重建值去补实测日的洞**）
      origin = 'observed'
      aumUsd = obs.aumNative.map((native, m) => toUsd(native, input.marketCurrency[m], obs.rates))
    } else {
      origin = 'rebuilt'
      aumUsd = anchors.map((a, m) => {
        if (a === null) return null
        const c = closes[m][i]
        // 该市场在这一天还没有任何收盘价（序列比别的市场短）⇒ 该日这一行没有值
        if (c === null) return null
        return a.aum * (c / a.lastClose)
      })
    }
    const share = sharesOf(aumUsd)
    points.push({ day, origin, aumUsd, share, partial: aumUsd.some((v) => v === null) })
  }
  return points
}

// ── 快照文件（一天一条，保留 90 天） ─────────────────────────────────────────

export interface FlowSnapshotMarket {
  aumNative: number | null
  aumUsd: number | null
  share: number | null
  currency: 'USD' | 'CNY' | 'HKD'
  aumSource: string
}

export interface FlowSnapshotDay {
  at: number
  rates: FlowRates
  /** 该记录所属的口径（`FLOW_SCOPE`）—— 成分一变，**当天起就不再采用旧记录** */
  scope: string
  markets: Record<FlowMarketKey, FlowSnapshotMarket>
  momentum: Record<FlowMarketKey, FlowMomentum | null>
  ranks: Record<FlowMarketKey, number | null>
  totalUsd: number | null
  rotationText: string
  missing: string[]
}

/** 口径不一致而被作废的旧快照记录（留痕，不删数据） */
export interface FlowSnapshotPurged {
  day: string
  scope: string | null
  reason: string
}

export interface FlowSnapshotFile {
  v: 2
  /** 文件级口径标识（与 `FLOW_SCOPE` 不一致 ⇒ 整份 days 作废并留痕） */
  scope: string
  days: Record<string, FlowSnapshotDay>
  /** 作废留痕（口径变更/不可解析的记录；只增不删，供事后核对） */
  purged?: FlowSnapshotPurged[]
  /** 最近一次落盘时刻（本机） */
  writtenAt?: number
}

export function flowSnapshotPath(): string {
  return join(dataHome(), 'global-flow.json')
}

let purgedFromOldScope: FlowSnapshotPurged[] = []

/** 本进程本次装载时因"口径不一致"被作废的旧快照记录（自检/断言用） */
export function flowSnapshotPurged(): readonly FlowSnapshotPurged[] {
  return purgedFromOldScope
}

/**
 * 「读不到」≠「空快照」（R1）：global-flow.json 读失败（非 ENOENT）时**禁止写回** ——
 * 否则 `writeFlowSnapshot()` 会拿"空 days"整份覆写，90 天历史当场消失（实测复现）。
 * 键用完整路径（同一个进程里不同 DSH_HOME 互不影响）。
 */
const flowReadGuard = new ReadGuard()

/** 本次启动"读不到"的快照文件与原因（R1 披露/断言用） */
export function flowReadFailures(): ReadonlyArray<{ file: string; reason: string }> {
  return flowReadGuard.entries
}

/**
 * 读快照文件。
 *
 * **口径隔离（v0.74.0）**：文件级 `scope`（或任何一天的 `scope`）与当前 `FLOW_SCOPE` 不一致 ⇒
 * 那份 days **一律不采用**（旧成分欧股/新兴市场的数据不许混进新成分的分母），
 * 并逐条记进 `purged`（留痕、不删数据），由下一次落盘写回文件。
 */
export async function readFlowSnapshot(): Promise<FlowSnapshotFile> {
  let raw: string
  try {
    raw = await readFile(flowSnapshotPath(), 'utf8')
    flowReadGuard.clear(flowSnapshotPath())
  } catch (error) {
    if (isFirstBoot(error)) {
      purgedFromOldScope = []
      return { v: 2, scope: FLOW_SCOPE, days: {} }
    }
    // ⚠ 读不到 ≠ 空快照：本次启动拒绝写回（writeFlowSnapshot 会检查同一个守卫）
    const reason = flowReadGuard.markUnreadable(flowSnapshotPath(), error)
    purgedFromOldScope = []
    log(`global-flow：快照读不到（${reason}）—— 读不到 ≠ 空快照：本次启动拒绝写回 global-flow.json（避免抹掉历史 days）`)
    return { v: 2, scope: FLOW_SCOPE, days: {} }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<FlowSnapshotFile> & { v?: number; days?: Record<string, FlowSnapshotDay>; purged?: FlowSnapshotPurged[] }
    if (parsed === null || typeof parsed !== 'object' || parsed.days === null || typeof parsed.days !== 'object') {
      purgedFromOldScope = Array.isArray(parsed?.purged) ? parsed.purged : []
      return { v: 2, scope: FLOW_SCOPE, days: {} }
    }
    const keepPurged = Array.isArray(parsed.purged) ? parsed.purged : []
    const sameScope = parsed.v === 2 && parsed.scope === FLOW_SCOPE
    if (sameScope) {
      // 文件级一致还不够：逐日再查一遍（防"同一文件里混了两种口径"）
      const good: Record<string, FlowSnapshotDay> = {}
      const bad: FlowSnapshotPurged[] = []
      for (const [day, rec] of Object.entries(parsed.days)) {
        if (rec !== null && typeof rec === 'object' && rec.scope === FLOW_SCOPE) good[day] = rec
        else bad.push({ day, scope: (rec as FlowSnapshotDay | undefined)?.scope ?? null, reason: `该日记录的口径与当前成分不一致（A股/港股/美国/日本/韩国）⇒ 作废，不参与曲线与回放` })
      }
      purgedFromOldScope = [...keepPurged, ...bad]
      if (bad.length > 0) log(`global-flow：作废 ${bad.length} 条口径不一致的历史快照（${bad.map((b) => b.day).join(',')}）`)
      return { v: 2, scope: FLOW_SCOPE, days: good, purged: purgedFromOldScope }
    }
    const days = Object.keys(parsed.days)
    const purged = days.map((day) => ({
      day,
      scope: (parsed.days as Record<string, FlowSnapshotDay>)[day]?.scope ?? parsed.scope ?? null,
      reason: `旧口径快照（文件 scope=${String(parsed.scope ?? 'v1/无')}，当前=${FLOW_SCOPE}）⇒ 整份作废，不与新成分（A股/港股/美国/日本/韩国）混用`,
    }))
    purgedFromOldScope = [...keepPurged, ...purged]
    if (days.length > 0) log(`global-flow：口径变更 ⇒ 作废 ${days.length} 天的旧快照（${days.join(',')}），留痕 purged`)
    return { v: 2, scope: FLOW_SCOPE, days: {}, purged: purgedFromOldScope }
  } catch (error) {
    // 「读到了但内容坏」：先隔离原件（保留原字节）再从容器的空快照开始 —— 与 store.ts 同口径。
    // 隔离成功 ⇒ 原数据已保住，写回是安全的；隔离失败 ⇒ 当成"读不到"，禁止写回。
    const kept = await quarantineFile(flowSnapshotPath())
    log(`global-flow：快照内容坏（${error instanceof Error ? error.message : String(error)}）—— ${kept === null ? '隔离失败，已改为不写回' : `已隔离为 ${kept}`}`)
    if (kept === null) flowReadGuard.markUnreadable(flowSnapshotPath(), error)
    purgedFromOldScope = []
    return { v: 2, scope: FLOW_SCOPE, days: {} }
  }
}

/** 保留最近 `keep` 天（按日期字符串排序；一天一条，key 就是北京时间日期） */
export function trimSnapshotDays(days: Record<string, FlowSnapshotDay>, keep = FLOW_SNAPSHOT_KEEP_DAYS): Record<string, FlowSnapshotDay> {
  const keys = Object.keys(days).sort()
  if (keys.length <= keep) return days
  const out: Record<string, FlowSnapshotDay> = {}
  for (const k of keys.slice(keys.length - keep)) out[k] = days[k]
  return out
}

let lastSnapshotWriteAt = 0

export async function writeFlowSnapshot(day: string, record: FlowSnapshotDay): Promise<{ written: boolean; reason?: string }> {
  // 读不到过 ⇒ 绝不用"空 days"整份覆写（R1）
  if (flowReadGuard.isBlocked(flowSnapshotPath())) {
    return {
      written: false,
      reason: `本地快照本次读不到（${flowReadGuard.reasonOf(flowSnapshotPath()) ?? '未知'}）⇒ 拒绝写回，避免覆盖已有历史（读不到 ≠ 空数据）`,
    }
  }
  const now = Date.now()
  const file = await readFlowSnapshot()
  const isNewDay = file.days[day] === undefined
  if (!isNewDay && now - lastSnapshotWriteAt < SNAPSHOT_WRITE_MIN_MS) return { written: false, reason: `距上次落盘不足 ${Math.round(SNAPSHOT_WRITE_MIN_MS / 1000)}s（节流）` }
  const days = trimSnapshotDays({ ...file.days, [day]: { ...record, scope: FLOW_SCOPE } })
  try {
    await writeJsonAtomic(flowSnapshotPath(), { v: 2, scope: FLOW_SCOPE, days, purged: file.purged ?? [], writtenAt: now })
    lastSnapshotWriteAt = now
    return { written: true }
  } catch (error) {
    log('global-flow snapshot write failed:', String(error))
    return { written: false, reason: `落盘失败：${String(error)}` }
  }
}

/** 快照文件的规模（页面/自检用；拿不到就如实 null） */
export async function flowSnapshotStats(): Promise<{
  path: string
  days: number
  bytes: number | null
  firstDay: string | null
  lastDay: string | null
  /** 因口径不一致作废的旧快照（留痕；成分变更后非空 —— UI 要能说清"历史为什么这么短"） */
  purged: FlowSnapshotPurged[]
}> {
  const file = await readFlowSnapshot()
  const keys = Object.keys(file.days).sort()
  let bytes: number | null = null
  try {
    const s = await stat(flowSnapshotPath())
    bytes = s.size
  } catch {
    bytes = null
  }
  return { path: flowSnapshotPath(), days: keys.length, bytes, firstDay: keys[0] ?? null, lastDay: keys[keys.length - 1] ?? null , purged: file.purged ?? purgedFromOldScope }
}

// ── 取数（五市场原始输入） ───────────────────────────────────────────────────

interface MarketRaw {
  key: FlowMarketKey
  currency: 'USD' | 'CNY' | 'HKD'
  /** 原币规模（A股 = 元，其余 = 美元） */
  aumNative: number | null
  aumNote: string | null
  aumAsOf: number | null
  /** 曲线重建用价格序列 */
  chart: FlowSeriesPoint[] | null
  /** 动量用价格序列 */
  momentum: FlowSeriesPoint[] | null
  missing: MissingField[]
}

function barsToSeries(bars: readonly SinaBar[] | readonly { date: string; close: number }[]): FlowSeriesPoint[] {
  const out: FlowSeriesPoint[] = []
  for (const b of bars) if (typeof b.close === 'number' && b.close > 0) out.push({ date: b.date, close: b.close })
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

/** 日线：腾讯（A股/美股指数）或新浪（美股 ETF）。两条都带 12h TTL */
async function dailySeries(key: FlowMarketKey, which: 'chart' | 'momentum'): Promise<{ points: FlowSeriesPoint[] | null; missing: MissingField | null }> {
  const def = which === 'chart' ? CURVE_SYMBOL[key] : MOMENTUM_SYMBOL[key]
  const name = FLOW_MARKETS.find((m) => m.key === key)?.name ?? key
  const what = which === 'chart' ? `${name}规模序列（${def.symbol}）` : `${name}动量序列（${def.symbol}）`
  try {
    // 缓存键按 **(来源, 符号)** 而不是 (市场, 用途)：欧股/日股/新兴的"规模序列"与"动量序列"
    // 就是同一条 ETF 日线，键带上用途会让同一份 500KB 的日线被拉两遍（实测冷启动 17 次请求）。
    const points = await cached(`series:${def.via}:${def.symbol}`, FLOW_SERIES_TTL_MS, async () => {
      // ⚠ M8（与 R2 同一原则）：「**成功但空**」不算成功。
      // 日线源在缺字段/解析不到时会 `return []`（不抛）—— 旧实现把它当成功值写进 **12 小时**正缓存，
      // 于是"这次空包"被锁半天，还按 `no-source` 报给用户（"重试无用"）。
      // 现在空/过短一律抛，由上层记成本次失败（不写正缓存，下次会重试）。
      const series = def.via === 'sina-us' ? barsToSeries(await fetchSinaUsDaily(def.symbol)) : barsToSeries(await fetchTencentDaily(def.symbol, FLOW_CURVE_WINDOW_MAX + 60))
      if (series.length < 2) throw new Error(`日线源回了 ${series.length} 个点（空包/过短 ⇒ 不写正缓存）`)
      return series
    })
    if (points.length < 2) {
      return { points: null, missing: { what, why: 'no-source', note: `上游这次没有返回可用的日线序列（${def.via === 'sina-us' ? '新浪美股日线' : '腾讯 fqkline'}，${def.symbol}）—— 重试仍可能失败，需核对上游字段` } }
    }
    return { points, missing: null }
  } catch (error) {
    return { points: null, missing: { what, why: 'transient', note: `${def.via === 'sina-us' ? '新浪美股日线' : '腾讯日线'} 本次取数失败（${String(error).slice(0, 120)}）⇒ 稍后重试即可，这一格不用 0 顶替` } }
  }
}

/** 各市场当期规模（原币）+ 取不到的原因 */
export interface FlowFxOut {
  rates: FlowRates
  at: number | null
  /** 某条汇率没有可用值时的原因（键 = 原币） */
  notes: Partial<Record<'CNY' | 'HKD', string>>
}

/** 一条汇率：失败/不可用 ⇒ **抛出**（不许进 30 分钟 TTL，见 AUDIT-IMPL46 §5） */
async function rateOf(currency: 'CNY' | 'HKD'): Promise<number> {
  const symbol = FLOW_FX_SYMBOLS[currency]
  return cached(`fx:${symbol}`, FLOW_QUOTE_TTL_MS, async () => {
    const q = await fetchSinaFxRate(symbol)
    if (q.rate === null || !(q.rate > 0)) throw new Error(`新浪 ${symbol} 没有给出可用最新价（已按 ±5% 剔除明显错值）`)
    return q.rate
  })
}

/** 腾讯行情批量（f45 市值 / f71 股本）—— 一次请求覆盖港股规模与美股兜底 */
async function tencentAumQuotes(): Promise<Record<string, { totalMv: number | null; shares: number | null; price: number | null; name: string }>> {
  return cached('tencent:aum-quotes', FLOW_QUOTE_TTL_MS, async () => {
    const rows = await fetchTencentRawQuotes([...TENCENT_AUM_CODES])
    const out: Record<string, { totalMv: number | null; shares: number | null; price: number | null; name: string }> = {}
    for (const [code, row] of Object.entries(rows)) out[code.toLowerCase()] = { totalMv: row.totalMv, shares: row.shares, price: row.price, name: row.name }
    return out
  })
}

/** 各市场当期规模（原币）+ 取不到的原因；汇率两条各自独立成败 */
export async function marketRaws(): Promise<{ markets: MarketRaw[]; fx: FlowFxOut }> {
  const notes: Partial<Record<'CNY' | 'HKD', string>> = {}
  const rates: FlowRates = { usdCny: null, usdHkd: null }
  let fxAt: number | null = null
  for (const currency of ['CNY', 'HKD'] as const) {
    try {
      const rate = await rateOf(currency)
      if (currency === 'CNY') rates.usdCny = rate
      else rates.usdHkd = rate
      fxAt = fxAt ?? Date.now()
    } catch (error) {
      notes[currency] = `新浪 ${FLOW_FX_SYMBOLS[currency]} 本次没有可用值（${String(error).slice(0, 120)}）`
    }
  }

  const markets: MarketRaw[] = []
  for (const def of FLOW_MARKETS) {
    const missing: MissingField[] = []
    let aumNative: number | null = null
    let aumNote: string | null = null
    let aumAsOf: number | null = null
    const route = AUM_ROUTE[def.key]
    try {
      if (route.kind === 'sina-etf') {
        // A股：新浪 ETF 节点 nmc（万元）→ 元
        const aum = await cached(`aum:etf:${def.key}`, FLOW_QUOTE_TTL_MS, async () => {
          const row = await fetchSinaEtfNodeSize(route.symbol)
          if (row.nmcWan === null || !(row.nmcWan > 0)) return { value: null as number | null, note: '新浪 ETF 节点的 nmc（流通市值/规模）字段为空', at: Date.now(), from: '新浪 ETF 节点 nmc' }
          return { value: row.nmcWan * 1e4, note: null as string | null, at: Date.now(), from: '新浪 ETF 节点 nmc' }
        })
        aumNative = aum.value
        aumNote = aum.note
        aumAsOf = aum.at
      } else if (route.kind === 'tencent-quote' || route.kind === 'tencent-shares') {
        // 港股：腾讯 f45「总市值」（**亿港元**）⇒ ×1e8；
        // 韩国：腾讯 f71「股本」× 最新价（新浪 gb_ewy 的总市值字段实测为 0 ⇒ 只能用这条）
        const quotes = await tencentAumQuotes()
        const q = quotes[route.code.toLowerCase()]
        if (q === undefined) {
          aumNote = `腾讯行情没有回 ${route.code} 这一行`
        } else if (route.kind === 'tencent-quote') {
          if (q.totalMv === null || !(q.totalMv > 0)) aumNote = `腾讯 ${route.code} 的「总市值」字段为空/为 0`
          else {
            aumNative = q.totalMv
            aumAsOf = Date.now()
          }
        } else {
          if (q.shares === null || !(q.shares > 0)) aumNote = `腾讯 ${route.code} 的「股本」（f71）字段为空/为 0`
          else if (q.price === null || !(q.price > 0)) aumNote = `腾讯 ${route.code} 没有可用最新价（无法用 股本×价 估算规模）`
          else {
            aumNative = q.shares * q.price
            aumAsOf = Date.now()
            aumNote = '规模 = 股本（腾讯 f71）× 最新价（推导值：新浪该标的的「总市值」字段实测为 0）'
          }
        }
      } else {
        // 美国 / 日本：新浪 gb_* 的「总市值」（美元）；缺失时兜底腾讯 f71 × 最新价
        const aum = await cached(`aum:gb:${def.key}`, FLOW_QUOTE_TTL_MS, async () => {
          const got = await fetchSinaGb([route.symbol])
          const q = got[`gb_${route.symbol}`]
          if (q === undefined) return { value: null as number | null, note: `新浪 gb_${route.symbol} 没有回这一行`, at: Date.now(), from: '新浪 gb_* 总市值' }
          if (q.totalMv === null || !(q.totalMv > 0)) return { value: null as number | null, note: `新浪 gb_${route.symbol} 的「总市值」字段为空/为 0`, at: Date.now(), from: '新浪 gb_* 总市值' }
          // 口径自校：总市值 应当 ≈ 最新价 × 股本（实测一致；不一致就如实标出来，不静默用）
          const implied = q.price !== null && q.shares !== null ? q.price * q.shares : null
          const drift = implied !== null && implied > 0 ? Math.abs(q.totalMv / implied - 1) : null
          const note = drift !== null && drift > 0.05 ? `新浪 gb_${route.symbol} 的「总市值」与「最新价×股本」差 ${(drift * 100).toFixed(1)}%（按总市值计，但口径存疑）` : null
          return { value: q.totalMv, note, at: Date.now(), from: '新浪 gb_* 总市值' }
        })
        aumNative = aum.value
        aumNote = aum.note
        aumAsOf = aum.at
        if (aumNative === null) {
          // 兜底：腾讯 f71（股本）× 最新价（与新浪同口径：都是"发行份额 × 最新价"）
          const quotes = await tencentAumQuotes()
          const q = quotes[route.fallbackTencent.toLowerCase()]
          if (q !== undefined && q.shares !== null && q.shares > 0 && q.price !== null && q.price > 0) {
            aumNative = q.shares * q.price
            aumAsOf = Date.now()
            aumNote = `${aumNote ?? '新浪总市值为空'} ⇒ 兜底用腾讯 ${route.fallbackTencent} 的 股本（f71）× 最新价（推导值）`
          } else {
            aumNote = `${aumNote ?? '新浪总市值为空'}；腾讯 ${route.fallbackTencent} 的兜底也不可用（股本/最新价缺）`
          }
        }
      }
      if (aumNative === null) {
        missing.push({ what: `${def.name}规模（${def.etf}）`, why: 'transient', note: `${def.name}规模（${def.etf}）：${aumNote ?? '上游没有给出规模'} ⇒ 这一行显示「未取到」，并且不参与份额分母（不用 0 顶替）` })
      } else if (aumNote !== null) {
        // 口径自校告警 / 兜底说明**必须被消费**：有值但口径存疑时也进 missing（AUDIT-IMPL46 §6）
        missing.push({ what: `${def.name}规模（${def.etf}）`, why: 'no-source', note: `${def.name}规模（${def.etf}）：${aumNote}` })
      }
    } catch (error) {
      missing.push({ what: `${def.name}规模（${def.etf}）`, why: 'transient', note: `${def.name}规模（${def.etf}）：本次取数失败（${String(error).slice(0, 120)}）⇒ 稍后重试即可；这一行不参与份额分母` })
    }
    // 汇率缺 ⇒ 该市场折算不出来：**明确标注**（行级原因由渲染层给）
    if (aumNative !== null && def.currency !== 'USD' && rates[def.currency === 'CNY' ? 'usdCny' : 'usdHkd'] === null) {
      missing.push({
        what: `${def.name}规模（${def.etf}）折算`,
        why: 'transient',
        note: `${def.name}规模是${def.currency === 'CNY' ? '人民币' : '港元'}（${FLOW_FX_LABEL[def.currency]} 换算），本次 ${def.currency === 'CNY' ? '美元/人民币' : '美元/港元'} 汇率未取到 ⇒ 不做美元折算、不进美元合计（口径不一致，不许静默混算）`,
      })
    }
    const chart = await dailySeries(def.key, 'chart')
    if (chart.missing !== null) missing.push(chart.missing)
    const mom = await dailySeries(def.key, 'momentum')
    if (mom.missing !== null) missing.push(mom.missing)
    markets.push({ key: def.key, currency: def.currency, aumNative, aumNote, aumAsOf, chart: chart.points, momentum: mom.points, missing })
  }
  return { markets, fx: { rates, at: fxAt, notes } }
}

// ── 载荷 ─────────────────────────────────────────────────────────────────────

export interface FlowMarketRow {
  key: FlowMarketKey
  name: string
  etf: string
  aumSource: string
  currency: 'USD' | 'CNY' | 'HKD'
  benchmark: string
  benchmarkSource: string
  /** 规模（原币） */
  aumNative: number | null
  /** 规模（美元）：A股在汇率缺失时为 null（口径不一致，不混算） */
  aumUsd: number | null
  /** 份额（0–1） */
  share: number | null
  sharePct: number | null
  /** 与上一序列日的份额变化（百分点） */
  delta1Pp: number | null
  /** 与 5 个序列日前的份额变化（百分点） */
  delta5Pp: number | null
  momentum: FlowMomentum | null
  rank: number | null
  /** 该行缺什么 + 原因（null = 全齐） */
  missing: string | null
}

export interface GlobalFlowPayload {
  asOf: number
  day: string
  /**
   * 本次载荷怎么来的（三种，**不许混**）：
   *   live     = 上游现取（可能仍有个别市场缺值，逐行给原因）
   *   snapshot = 路由显式要求只读本地快照（零上游请求）
   *   fallback = 上游这次全部失败 ⇒ 退化到最近一次本地快照（**发过上游、全失败**，不许说成"只读快照"）
   */
  source: 'live' | 'snapshot' | 'fallback'
  /** true 表示当期数值来自最近一次快照（上游这次全部失败） */
  fallbackDay: string | null
  fx: { usdCny: number | null; usdHkd: number | null; at: number | null; source: string; note: string | null }
  markets: FlowMarketRow[]
  totalUsd: number | null
  totalNote: string | null
  rotation: FlowRotation
  curve: {
    points: FlowPoint[]
    /** 本次**实际构建**的窗口（= 最大档；客户端从这条曲线切片出各档） */
    window: number
    /** 可选窗口（分段控件用；顺序即显示顺序） */
    windowOptions: number[]
    observedDays: number
    rebuiltDays: number
    note: string
  }
  replay: { days: string[]; max: number; note: string }
  netFlow: {
    code: string
    label: string
    days: number
    sumCny: number | null
    asOf: number | null
    series: SinaMoneyFlowDay[]
    basis: string
    miss: string | null
  }
  snapshot: {
    path: string
    days: number
    bytes: number | null
    firstDay: string | null
    lastDay: string | null
    /** 因口径不一致作废的旧快照（留痕，UI 用来说清"历史为什么这么短"） */
    purged: FlowSnapshotPurged[]
  }
  notes: { kpi: string; curve: string; pie: string; market: string; boundary: string }
  boundary: string[]
  missing: MissingField[]
}

/** 曲线/饼图/市场表共用的口径行（唯一来源；页面不许另写一份） */
export const FLOW_NOTES = {
  kpi: `规模 = 各市场宽基 ETF 规模；delta = 与 ${FLOW_ROTATION_WINDOW} 个序列日前的份额变化（百分点）`,
  curve: `份额曲线可选 ${FLOW_CURVE_WINDOWS.join(' / ')} 个序列日：有实测快照的日期用实测规模，其余按「当前实测规模 × 该市场日线收盘价之比」重建（假定 ETF 份额数量不变 ⇒ 只反映价格驱动的相对规模变化，不反映申赎）`,
  pie: `静态饼图（无动画、无自动播放）：份额 = 该市场规模 ÷ Σ 有值市场规模；缺值的市场不进分母，在该行如实显示「未取到 + 原因」`,
  market: `份额合计恒为 100%（分母只含有值市场）；「未取到」= 该行本次没有数，不用 0 顶替；动量列 = 各市场自己的 ${FLOW_HORIZONS.join(' / ')} 个交易日收益率（样本不足的那一格显示「—」，不回填 0），且只反映最新交易日 —— 回放历史日时不重算`,
  boundary: `A股净流入是「流量」，单列且不参与份额/规模计算；份额是「存量加权」，两者量纲不同，禁止相加`,
} as const

export const FLOW_BOUNDARY: readonly string[] = [
  // ⚠ 与工具文件 `tools/cake.ts` 的边界声明**不许重复**（v0.73.0 前是 6+7 拼接，5 组近似重复，AUDIT-HY4-1 §8）：
  //   工具文件讲「这个模型是什么 / 不是什么」；这里只讲「具体的数字口径与数据源事实」。
  '规模字段口径（成分 v2：A股 / 港股 / 美国 / 日本 / 韩国）：A股 取新浪 ETF 节点 nmc（510300，万元人民币）；港股 取腾讯 02800 盈富基金的「总市值」字段（亿港元）；美国 / 日本 取新浪 gb_* 的「总市值」（美元）；韩国 取腾讯 EWY 的股本（f71）× 最新价（美元）—— 新浪 gb_ewy 的「总市值」字段实测为 0，只能用这条推导值。每条都用第二条路径交叉校验，对不上时在该行说明里标出。',
  '汇率来源：新浪 fx_susdcny（美元/人民币，在岸）与 fx_susdhkd（美元/港元即期）最新价；缺值或明显错值（相对昨收 ≥ 5%）一律视为未取到 ⇒ 该币种的市场保持原币、不进美元合计。美 / 日 / 韩 用的是美股上市 ETF，天然美元。',
  '动量 = 各市场自己的 20 / 60 / 120 个交易日收益率，再做横截面名次（并列取最靠前）；轮动判定线 = 5 日份额变化 0.05 个百分点，低于它算「未见明确轮动」。A股 用沪深 300、港股 用恒生指数（hkHSI）、美国 用标普 500；日本 / 韩国 用对应 ETF 自身日线 —— KOSPI200 在腾讯与新浪都没有日线源（实测四个候选代码全 pv_none_match）。',
  '曲线固定 180 个序列日、滑块回放最近 30 个交易日；每日快照一天一条、保留 90 天，且带口径标识：成分一变，旧快照整份作废并留痕，不与新成分混用。回放只读本地快照，不发上游请求。',
  '这个口径天然偏美国：SPY 本身就是全世界最大的宽基 ETF，规模远大于其余四家之和 ⇒ 饼图会明显向美国倾斜。这是口径本身的形状（「五只代表性宽基 ETF 的规模权重」），不是错数；要「各市场全部 ETF 合计」是另一个口径，本工具不做。',
]

/** 主入口：装配载荷。`source='snapshot'` ⇒ **只读本地快照，零上游请求** */
export async function globalFlowPayload(opts: { source?: 'auto' | 'snapshot'; now?: number } = {}): Promise<GlobalFlowPayload> {
  const now = opts.now ?? Date.now()
  const day = dayOf(now)
  const source = opts.source ?? 'auto'

  // ① 只读快照模式（30 日手动回放走这条；断言"零上游请求"也用它）
  if (source === 'snapshot') {
    const snap = await readFlowSnapshot()
    const stats = await flowSnapshotStats()
    return payloadFromSnapshot(snap, stats, now, day)
  }

  // ② 现取模式：整份载荷做 TTL + 在飞合并（并发两次 ⇒ 上游只打一遍）
  const ttl = payloadCache !== null && payloadCache.value.missing.length > 0 ? FLOW_PAYLOAD_TTL_PARTIAL_MS : FLOW_PAYLOAD_TTL_MS
  // ⚠ 时间基准一律用**本次调用传进来的 now**（不用真实 Date.now()）：注入 now 的调用方
  // （测试/复盘）才有可预期的 TTL 语义 —— 否则"推进 now 越过 TTL"永远命中缓存。
  if (payloadCache !== null && now - payloadCache.at < ttl) return payloadCache.value
  const flying = flowInflight.get('payload:auto')
  if (flying !== undefined) return (await flying) as GlobalFlowPayload
  const started = buildLivePayload(now, day)
  flowInflight.set('payload:auto', started as Promise<unknown>)
  try {
    const payload = await started
    payloadCache = { at: now, value: payload }
    return payload
  } finally {
    flowInflight.delete('payload:auto')
  }
}

async function buildLivePayload(now: number, day: string): Promise<GlobalFlowPayload> {
  const { markets: raw, fx } = await marketRaws()
  const usdOf = (m: MarketRaw): number | null => toUsd(m.aumNative, m.currency, fx.rates)
  const aumUsd = raw.map(usdOf)
  const shares = sharesOf(aumUsd)
  const mom = raw.map((m) => (m.momentum === null ? null : momentumOf(m.momentum)))
  const ranks = momentumRanks(mom)

  // 曲线：实测快照 + 重建补齐。**今天本身就是一次实测**（本轮刚取到的规模），
  // 因此把今天的观测值一并交给 buildCurve —— 否则第一屏的"最新一天"会被标成"重建"。
  const snap = await readFlowSnapshot()
  const observed = observedMapOf(snap)
  // 只有当**至少一个市场**拿到规模时，今天才算一次"实测"：全缺时若也登记，
  // 曲线上会出现一个"什么都没测到的实测点"（origin=observed 但每个值都是 null），
  // 既误导又会把空态顶掉（v0.73.0 修，见 AUDIT-IMPL46 §1/§5）
  if (raw.some((m) => m.aumNative !== null)) observed.set(day, { at: now, rates: fx.rates, aumNative: raw.map((m) => m.aumNative) })
  const curve = buildCurve({
    anchors: aumUsd,
    chartSeries: raw.map((m) => m.chart),
    observed,
    marketCurrency: raw.map((m) => m.currency),
    window: FLOW_CURVE_WINDOW_MAX,
  })
  const latest = curve.length > 0 ? curve[curve.length - 1].share : shares
  const prevIdx = curve.length - 1 - FLOW_ROTATION_WINDOW
  const rotation = rotationOf({ latest, previous: prevIdx >= 0 ? curve[prevIdx].share : null })
  const prev1 = curve.length - 2 >= 0 ? curve[curve.length - 2].share : null

  const rows: FlowMarketRow[] = raw.map((m, i) => {
    const def = FLOW_MARKETS[i]
    const share = latest[i] ?? null
    const delta1 = prev1 === null || share === null || prev1[i] === null ? null : (share - (prev1[i] as number)) * 100
    const delta5 = prevIdx < 0 || share === null || curve[prevIdx].share[i] === null ? null : (share - (curve[prevIdx].share[i] as number)) * 100
    const miss = m.missing.map((x) => x.note).join('；')
    return {
      key: m.key,
      name: def.name,
      etf: def.etf,
      aumSource: def.aumSource,
      currency: m.currency,
      benchmark: def.benchmark,
      benchmarkSource: def.benchmarkSource,
      aumNative: m.aumNative,
      aumUsd: aumUsd[i],
      share,
      sharePct: share === null ? null : share * 100,
      delta1Pp: delta1,
      delta5Pp: delta5,
      momentum: mom[i],
      rank: ranks[i],
      missing: miss === '' ? null : miss,
    }
  })

  const totalUsd = aumUsd.some((v) => v !== null) ? aumUsd.reduce((s: number, v) => s + (v ?? 0), 0) : null
  const missing: MissingField[] = raw.flatMap((m) => m.missing)
  for (const currency of ['CNY', 'HKD'] as const) {
    if (fx.rates[currency === 'CNY' ? 'usdCny' : 'usdHkd'] !== null) continue
    const label = FLOW_FX_LABEL[currency]
    const who = currency === 'CNY' ? 'A股' : '港股'
    missing.push({ what: `${label}汇率`, why: 'transient', note: `${fx.notes[currency] ?? `新浪 ${FLOW_FX_SYMBOLS[currency]} 没给出可用值`} ⇒ ${who} 规模保持${currency === 'CNY' ? '人民币' : '港元'}、不进美元合计（口径不一致，不许静默混算）` })
  }

  // A股净流入（单列，**不参与**上面的任何计算）。
  // ⚠ 同汇率：失败必须抛到 cached 外面，否则一次抖动会被锁进 30 分钟（review §6 附带缺陷 A）
  let netFlowRaw: SinaMoneyFlowDay[] = []
  let netFlowWhy: string | null = null
  try {
    netFlowRaw = await cached('netflow:sh510300', FLOW_QUOTE_TTL_MS, async (): Promise<SinaMoneyFlowDay[]> => {
      const rows = await fetchSinaMoneyFlow('sh510300', 20)
      if (rows.length === 0) throw new Error('上游返回空序列')
      return rows
    })
  } catch (error) {
    netFlowWhy = `新浪 MoneyFlow 本次没有可用序列（${String(error).slice(0, 120)}）`
    log('global-flow netflow failed:', String(error))
  }
  const netSum = netFlowRaw.length > 0 ? netFlowRaw.reduce((s, r) => s + r.netCny, 0) : null
  if (netSum === null) {
    missing.push({ what: 'A股净流入（510300）', why: 'transient', note: `${netFlowWhy ?? '新浪 MoneyFlow 本次没返回可用净流入序列'} ⇒ 单独那一栏显示「未取到」，且它本来就不进份额计算（失败不进缓存，下一次调用会重试）` })
  }

  const stats = await flowSnapshotStats()
  const totalNote = aumUsd.some((v) => v === null)
    ? `合计只含有值市场（${raw.filter((_, i) => aumUsd[i] !== null).map((m) => FLOW_MARKETS.find((d) => d.key === m.key)?.name).join('、')}）`
    : null

  const payload: GlobalFlowPayload = {
    asOf: now,
    day,
    source: 'live',
    fallbackDay: null,
    fx: {
      usdCny: fx.rates.usdCny,
      usdHkd: fx.rates.usdHkd,
      at: fx.at,
      source: `新浪 ${FLOW_FX_SYMBOLS.CNY}（在岸人民币）/ ${FLOW_FX_SYMBOLS.HKD}（美元兑港元即期）`,
      note: Object.entries(fx.notes).map(([, v]) => v).join('；') || null,
    },
    markets: rows,
    totalUsd,
    totalNote,
    rotation,
    curve: {
      points: curve,
      window: FLOW_CURVE_WINDOW_MAX,
      windowOptions: [...FLOW_CURVE_WINDOWS],
      observedDays: curve.filter((p) => p.origin === 'observed').length,
      rebuiltDays: curve.filter((p) => p.origin === 'rebuilt').length,
      note: FLOW_NOTES.curve,
    },
    replay: {
      days: curve.slice(Math.max(0, curve.length - FLOW_REPLAY_DAYS)).map((p) => p.day),
      max: Math.max(0, Math.min(FLOW_REPLAY_DAYS, curve.length) - 1),
      note: `滑块回放最近 ${FLOW_REPLAY_DAYS} 个交易日（最多 ${Math.max(0, Math.min(FLOW_REPLAY_DAYS, curve.length) - 1)} 步）；回放数据来自本地曲线/快照，不再请求上游`,
    },
    netFlow: {
      code: 'sh510300',
      label: '沪深300ETF（510300）主力净流入',
      days: netFlowRaw.length,
      sumCny: netSum,
      asOf: netFlowRaw.length > 0 ? now : null,
      series: [...netFlowRaw].reverse(),
      basis: '新浪 MoneyFlow.ssl_qsfx_zjlrqs 的逐日 netamount（元）累加；单列，不参与份额/规模计算（流量 ≠ 存量加权）',
      miss: netSum === null ? '新浪资金流本次未返回可用序列' : null,
    },
    snapshot: stats,
    notes: { ...FLOW_NOTES },
    boundary: [...FLOW_BOUNDARY],
    missing,
  }

  // 写当日快照（一天一条；节流见 writeFlowSnapshot）。
  // ⚠ 只在**至少有一个市场拿到规模**时写：全缺的那一天不是"观测"，写进去会让回放出现一个
  //    "那天五个市场都没数"的假历史日（实测日的洞必须是真的洞）。
  const hasAnyAum = aumUsd.some((v) => v !== null)
  const record: FlowSnapshotDay = {
    at: now,
    rates: fx.rates,
    scope: FLOW_SCOPE,
    markets: Object.fromEntries(rows.map((r) => [r.key, { aumNative: r.aumNative, aumUsd: r.aumUsd, share: r.share, currency: r.currency, aumSource: r.aumSource }])) as Record<FlowMarketKey, FlowSnapshotMarket>,
    momentum: Object.fromEntries(rows.map((r, i) => [r.key, mom[i]])) as Record<FlowMarketKey, FlowMomentum | null>,
    ranks: Object.fromEntries(rows.map((r, i) => [r.key, ranks[i]])) as Record<FlowMarketKey, number | null>,
    totalUsd,
    rotationText: rotation.text,
    missing: missing.map((m) => m.what),
  }
  if (hasAnyAum) await writeFlowSnapshot(day, record)
  payload.snapshot = await flowSnapshotStats()

  // 全部市场都没有值 ⇒ 分两种情形（都不许用 0/空表冒充）
  if (!hasAnyAum) {
    const snapDays = Object.keys(snap.days).sort()
    if (snapDays.length === 0) {
      // 连快照都没有：**不能**说"来自最近一次快照"（那会误导成有兜底）
      payload.missing = [
        { what: '实时取数', why: 'transient', note: '五个市场的上游本次全部失败，且本地还没有任何快照 ⇒ 这一屏没有数据可显示（不是来自快照）；下面逐行给出各自的失败原因' },
        ...missing,
      ]
      return payload
    }
    const fallback = await payloadFromSnapshot(snap, payload.snapshot, now, day, 'fallback')
    fallback.missing = [
      { what: '实时取数', why: 'transient', note: `五个市场的上游本次全部失败 ⇒ 下表与曲线来自最近一次本地快照（${snapDays[snapDays.length - 1]}），不是实时值` },
      // 保留每一处失败的真实原因：否则回退以后只剩一句"全部失败"，看不到是哪一个源挂了
      ...missing,
      ...fallback.missing.filter((m) => m.what !== '实时取数' && m.what !== '本地快照' && m.what !== '实时取数'),
    ]
    return fallback
  }
  return payload
}

function observedMapOf(snap: FlowSnapshotFile): Map<string, ObservedDay> {
  const out = new Map<string, ObservedDay>()
  for (const [day, rec] of Object.entries(snap.days)) {
    const aumNative = FLOW_MARKET_ORDER.map((k) => rec.markets?.[k]?.aumNative ?? null)
    out.set(day, { at: rec.at, rates: rec.rates ?? { usdCny: null, usdHkd: null }, aumNative })
  }
  return out
}

/** 只用本地快照装配载荷（零上游请求） */
async function payloadFromSnapshot(
  snap: FlowSnapshotFile,
  stats: {
    path: string
    days: number
    bytes: number | null
    firstDay: string | null
    lastDay: string | null
    purged: FlowSnapshotPurged[]
  },
  now: number,
  day: string,
  source: 'snapshot' | 'fallback' = 'snapshot',
): Promise<GlobalFlowPayload> {
  const keys = Object.keys(snap.days).sort()
  const points: FlowPoint[] = keys.map((d) => {
    const rec = snap.days[d]
    const aumUsd = FLOW_MARKET_ORDER.map((k) => rec.markets?.[k]?.aumUsd ?? null)
    return { day: d, origin: 'observed' as const, aumUsd, share: sharesOf(aumUsd), partial: aumUsd.some((v) => v === null) }
  })
  const lastRec = keys.length > 0 ? snap.days[keys[keys.length - 1]] : null
  const lastPoint = points.length > 0 ? points[points.length - 1] : null
  const latest = lastPoint?.share ?? FLOW_MARKET_ORDER.map(() => null)
  const prevIdx = points.length - 1 - FLOW_ROTATION_WINDOW
  const rotation = lastRec !== null && prevIdx >= 0
    ? rotationOf({ latest, previous: points[prevIdx].share })
    : { kind: 'unknown' as const, fromKey: null, toKey: null, maxAbsPp: null, comparable: 0, window: FLOW_ROTATION_WINDOW, text: '本地快照还不够（没有 5 个交易日的记录）⇒ 判不了轮动（不是"没有轮动"）' }
  const rows: FlowMarketRow[] = FLOW_MARKETS.map((def, i) => {
    const rec = lastRec?.markets?.[def.key]
    const share = latest[i] ?? null
    const prev1 = points.length >= 2 ? points[points.length - 2].share[i] : null
    return {
      key: def.key,
      name: def.name,
      etf: def.etf,
      aumSource: def.aumSource,
      currency: def.currency,
      benchmark: def.benchmark,
      benchmarkSource: def.benchmarkSource,
      aumNative: rec?.aumNative ?? null,
      aumUsd: rec?.aumUsd ?? null,
      share,
      sharePct: share === null ? null : share * 100,
      delta1Pp: share === null || prev1 === null ? null : (share - prev1) * 100,
      delta5Pp: prevIdx >= 0 && latest[i] !== null && points[prevIdx].share[i] !== null ? ((latest[i] as number) - (points[prevIdx].share[i] as number)) * 100 : null,
      momentum: lastRec?.momentum?.[def.key] ?? null,
      rank: lastRec?.ranks?.[def.key] ?? null,
      missing: rec === undefined ? '本地快照里没有这一天的记录（本功能上线后第一天开始累积）' : null,
    }
  })
  const aumUsd = rows.map((r) => r.aumUsd)
  const missing: MissingField[] = keys.length === 0
    ? [{ what: '本地快照', why: 'transient', note: '本地还没有任何快照（本功能上线后第一天开始累积，一天一条、保留 90 天）⇒ 这一屏显示「未取到」，不编造历史' }]
    : [{ what: '实时取数', why: 'transient', note: `本次只读本地快照（零上游请求）：最新一条是 ${keys[keys.length - 1]}。要看实时值请用默认模式（不带 source=snapshot）` }]
  return {
    asOf: now,
    day,
    source,
    fallbackDay: lastRec === null ? null : keys[keys.length - 1],
    fx: {
      usdCny: lastRec?.rates?.usdCny ?? null,
      usdHkd: lastRec?.rates?.usdHkd ?? null,
      at: lastRec?.at ?? null,
      source: `新浪 ${FLOW_FX_SYMBOLS.CNY}（在岸人民币）/ ${FLOW_FX_SYMBOLS.HKD}（美元兑港元即期）`,
      note: lastRec === null ? '本地还没有快照，因此汇率也是未取到' : '取自最近一条本地快照（本次不发上游请求）',
    },
    markets: rows,
    totalUsd: aumUsd.some((v) => v !== null) ? aumUsd.reduce((s: number, v) => s + (v ?? 0), 0) : null,
    totalNote: aumUsd.some((v) => v === null) ? '合计只含有值市场；缺值市场不进分母' : null,
    rotation,
    curve: { points, window: FLOW_CURVE_WINDOW_MAX, windowOptions: [...FLOW_CURVE_WINDOWS], observedDays: points.length, rebuiltDays: 0, note: '本次只读本地快照：曲线只含已记录的日期（没有重建补齐）' },
    replay: { days: points.slice(Math.max(0, points.length - FLOW_REPLAY_DAYS)).map((p) => p.day), max: Math.max(0, Math.min(FLOW_REPLAY_DAYS, points.length) - 1), note: '回放取本地快照，不发上游请求' },
    netFlow: { code: 'sh510300', label: '沪深300ETF（510300）主力净流入', days: 0, sumCny: null, asOf: null, series: [], basis: '本地快照不保存资金流明细（单列项，不参与份额计算）', miss: '本次只读快照 ⇒ 资金流未取到' },
    snapshot: stats,
    notes: { ...FLOW_NOTES },
    boundary: [...FLOW_BOUNDARY],
    missing,
  }
}
