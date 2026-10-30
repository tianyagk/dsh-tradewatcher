/**
 * 详情头的**腾讯兜底**（东财 `ulist.np` 失败时启用）。
 *
 * 背景：`fetchStockDetail` 只有东财 `push2` 一条链（`f57/f46/...`），东财一熔断，抽屉头部
 * 「所属板块 / 今开 / 昨收 / 换手率 / 最高 / 最低 / 成交量 / 成交额 / 市盈率 / 总市值」全变 `—`。
 * 腾讯单票快照（`qt.gtimg.cn/q=sh600519`）能补齐其中 10 项里的 9 项，且**零鉴权**。
 *
 * ⚠ 两个**实测与任务卡不一致**的点（按数据走，不按卡片硬抄）：
 *   ① 市值：工商银行 `f44=22944 亿 < f45=30330 亿` ⇒ **`f44` 是流通市值、`f45` 是总市值**
 *      （与 `tencent.ts` 既有口径一致）。任务卡写的 `[44] 总 / [45] 流通` 是反的。
 *   ② 量比：腾讯 `f49` 语义未确认 ⇒ 不取、不猜，进 `missing[]`（`no-source`）。
 *
 * 单位：成交量 `手 → 股`（×100）、成交额 `万元 → 元`（×1e4）、市值 `亿元 → 元`（×1e8）——
 * 与 `StockDetail` 既有口径一致（页面 `fmtAmt` 按元换算）。
 */
import type { MissingField, StockDetail } from '../shared/model.ts'
import { fetchTextHost } from './hostFetch.ts'
import { tencentQuoteCode } from './tencent.ts'
import { volToShares, volUnitOf } from './volUnit.ts'

export interface TencentDetailResult {
  detail: StockDetail
  source: 'tencent'
  missing: MissingField[]
}

const numOf = (v: string | undefined): number | null => {
  if (v === undefined) return null
  const s = v.trim()
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * 解析 `qt.gtimg.cn` 单票回包（0-based 下标）：
 * `[1]` 名称 `[3]` 现价 `[4]` 昨收 `[5]` 今开 `[31]` 涨跌 `[32]` 涨跌幅
 * `[33]` 最高 `[34]` 最低 `[36]` 成交量(手) `[37]` 成交额(万元) `[38]` 换手率%
 * `[39]` 市盈率(TTM) `[44]` 流通市值(亿) `[45]` 总市值(亿) `[46]` 市净率
 */
export function parseTencentDetail(text: string, secid: string): TencentDetailResult | null {
  // 必须同时认 `us*`：腾讯美股回包是 `v_usAAPL="…"`，只认沪深北 ⇒ 美股详情兜底永远解析失败
  const m = /v_((?:sh|sz|bj)\d{6}|us[A-Za-z.]+)="([^"]*)"/.exec(text)
  if (m === null) return null
  const code = (m[1] as string).slice(2)
  const f = (m[2] as string).split('~')
  const price = numOf(f[3])
  if (price === null) return null
  const prev = numOf(f[4])
  const chg = numOf(f[31]) ?? (prev === null ? null : Math.round((price - prev) * 1000) / 1000)
  const pct = numOf(f[32]) ?? (prev === null || prev <= 0 ? null : Math.round((price / prev - 1) * 10000) / 100)
  const amountRaw = numOf(f[37])
  /**
   * ⚠ 美股 `[37]` 是**美元**（见 `tencent.ts:parseTencentQuoteText` 的 `isUs ? 1 : 1e4`），
   * A股/ETF 才是**万元**。此前一律 ×1e4 ⇒ 美股详情头的成交额差 10000 倍。
   */
  const isUs = /^(105|106|107)\./.test(secid)
  const amount = amountRaw === null ? null : Math.round(amountRaw * (isUs ? 1 : 1e4))
  const floatMvYi = numOf(f[44])
  const totalMvYi = numOf(f[45])
  const detail: StockDetail = {
    secid,
    code,
    name: (f[1] ?? '').trim() || code,
    price,
    chg,
    pct,
    open: numOf(f[5]),
    high: numOf(f[33]),
    low: numOf(f[34]),
    prev,
    /**
     * 成交量统一到**股**：腾讯 `[36]` 多数标的是「手」，但科创板/新股实测是「股」
     * （长鑫科技 `[36]=292,040,261` ×44.25 ≈ 129 亿 = `[37]` ⇒ 它是股不是手）。
     * 用成交额当锚判单位，判不出 ⇒ null（不让 100 倍错值上屏）。
     */
    vol: (() => {
      const raw = numOf(f[36])
      if (raw === null) return null
      const unit = volUnitOf(raw, price, amount)
      return unit.ok ? volToShares(raw, unit.unit) : null
    })(),
    // 万元 → 元
    amount,
    turnover: numOf(f[38]),
    // 腾讯单票不含量比（f49 语义未确认）⇒ 不猜
    volumeRatio: null,
    pe: numOf(f[39]),
    pb: numOf(f[46]),
    // 亿元 → 元（f45 = 总市值、f44 = 流通市值，见文件头实测）
    totalMv: totalMvYi === null ? null : Math.round(totalMvYi * 1e8),
    floatMv: floatMvYi === null ? null : Math.round(floatMvYi * 1e8),
    up: null,
    down: null,
  }
  const missing: MissingField[] = []
  if (detail.volumeRatio === null) missing.push({ what: '量比', why: 'no-source', note: '腾讯单票行情不含量比（f49 语义未确认，不猜）' })
  if (detail.up === null || detail.down === null) missing.push({ what: '涨跌家数', why: 'no-source', note: '腾讯单票行情不含指数级的涨跌家数（只在指数快照里有）' })
  if (detail.open === null) missing.push({ what: '今开', why: 'no-source', note: '腾讯回包里今开为空（停牌/集合竞价前可能如此）' })
  if (detail.vol === null) missing.push({ what: '成交量', why: 'no-source', note: '腾讯 [36] 与成交额不自洽（量纲判不出）⇒ 按未取到处理，不显示可能差 100 倍的数' })
  return { detail, source: 'tencent', missing }
}

/** 拉腾讯单票详情（走 `fetchTextHost` ⇒ 内部过熔断器） */
export async function fetchTencentDetail(secid: string): Promise<TencentDetailResult | null> {
  const code = tencentQuoteCode(secid)
  if (code === null) return null
  const text = await fetchTextHost('qt.gtimg.cn', `https://qt.gtimg.cn/q=${encodeURIComponent(code)}`, { referer: 'https://gu.qq.com/', charset: 'gbk' })
  return parseTencentDetail(text, secid)
}

export type DetailSource = 'eastmoney' | 'tencent'

export interface DetailFallbackResult {
  detail: StockDetail | null
  source: DetailSource | null
  missing: MissingField[]
}

/**
 * 详情取数的一级/兜底编排（可注入，便于断言"东财可用时**不请求**腾讯"）。
 * 顺序：东财 → 腾讯；两边都失败 ⇒ `detail:null` + 原因（保持旧行为：不抛 503）。
 */
export async function detailWithFallback(
  secid: string,
  deps: {
    eastmoney: (secid: string) => Promise<StockDetail | null>
    tencent: (secid: string) => Promise<TencentDetailResult | null>
  },
): Promise<DetailFallbackResult> {
  let emDetail: StockDetail | null = null
  let emError: unknown = null
  try {
    emDetail = await deps.eastmoney(secid)
  } catch (error) {
    emError = error
  }
  if (emDetail !== null) return { detail: emDetail, source: 'eastmoney', missing: [] }
  let tx: TencentDetailResult | null = null
  try {
    tx = await deps.tencent(secid)
  } catch {
    tx = null
  }
  if (tx !== null) return { detail: tx.detail, source: 'tencent', missing: tx.missing }
  return {
    detail: null,
    source: null,
    missing: [
      {
        what: secid,
        why: 'transient',
        note: `东财与腾讯都没取到详情${emError === null ? '' : `（东财：${String(emError).slice(0, 60)}）`}`,
      },
    ],
  }
}
