/**
 * 【护盘信号】阈值标定脚本。
 *
 * 可用历史（实测）：
 *   - 腾讯日K（web.ifzq.gtimg.cn）→ 501 根日线（volume 手，无成交额）
 *     → 用 vol×100×close 近似成交额，标定 **F1 量能放大倍数** 的分位数（比值口径对近似不敏感）
 *   - 东财日频资金流 fflow daykline → **仅当日 1 行**（个股/ETF 同样），免费源已无历史
 *     → F2 超大单强度**无法**用历史分位数标定：改用日内自分布分位 + 规模分档经验门槛，
 *       并由 host 采样器自建每日样本，累计 ≥20 交易日后自动切换到自建分位数
 *
 *   - 新浪 5 分钟线（quotes.sina.cn，datalen=1023 ≈ 22 个交易日）→ 标定 **日内累计成交进度曲线**
 *     （用于盘中「同时点量能倍数」= 累计成交额 / (20日均额 × 进度(t))），并给出各时点进度
 *
 * 输出：scripts/rescue-thresholds.json（作为插件默认阈值随仓库发布）+ 控制台汇总
 * 用法：node scripts/calibrate-rescue.mjs
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const UNIVERSE = [
  { secid: '1.510300', tx: 'sh510300', name: '沪深300ETF华泰柏瑞' },
  { secid: '1.510050', tx: 'sh510050', name: '上证50ETF华夏' },
  { secid: '1.510500', tx: 'sh510500', name: '中证500ETF南方' },
  { secid: '1.512100', tx: 'sh512100', name: '中证1000ETF华夏' },
  { secid: '1.588000', tx: 'sh588000', name: '科创50ETF华夏' },
  { secid: '0.159915', tx: 'sz159915', name: '创业板ETF易方达' },
]
const WINDOW = 20
const LIMIT = 500

const pct = (arr, p) => {
  if (arr.length === 0) return null
  const s = [...arr].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))
  return s[i]
}
const avg = (a) => (a.length === 0 ? null : a.reduce((x, y) => x + y, 0) / a.length)

async function tencentDaily(code) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,${LIMIT},qfq`
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j = await res.json()
  const d = j?.data?.[code]
  const arr = (d && (d.qfqday ?? d.day)) ?? []
  return arr
    .map((r) => ({ date: String(r[0]), close: Number(r[2]), vol: Number(r[5]) }))
    .filter((k) => Number.isFinite(k.close) && Number.isFinite(k.vol) && k.vol > 0)
    .map((k) => ({ ...k, amt: k.vol * 100 * k.close })) // 近似成交额（手→股 × 价）
}

/** 新浪 5 分钟线：标定日内累计成交进度曲线（A股 09:30-11:30 + 13:00-15:00 = 240 分钟） */
const SINA_PROGRESS_MARKS = ['10:00', '10:30', '11:00', '11:30', '13:30', '14:00', '14:30', '14:55']
async function sinaFiveMin(code) {
  const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${code}&scale=5&ma=no&datalen=1023`
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://finance.sina.com.cn/' },
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j = await res.json()
  return Array.isArray(j) ? j : []
}

/** 把一天的 5 分钟 bars 变成 49 点累计进度（index i = 开盘后 i*5 分钟） */
function dayProgress(bars) {
  const bySlot = new Map()
  for (const b of bars) {
    const hm = String(b.day).slice(11, 16)
    const [h, m] = hm.split(':').map(Number)
    const mins = h * 60 + m
    let elapsed
    if (mins <= 690) elapsed = mins - 570            // 09:30-11:30
    else if (mins >= 780) elapsed = 120 + (mins - 780) // 13:00-15:00
    else continue                                     // 午休
    if (elapsed <= 0 || elapsed > 240 || elapsed % 5 !== 0) continue
    bySlot.set(elapsed, (bySlot.get(elapsed) ?? 0) + Number(b.volume || 0))
  }
  const total = [...bySlot.values()].reduce((a, b) => a + b, 0)
  if (!(total > 0) || bySlot.size < 40) return null
  const curve = new Array(49).fill(0)
  let run = 0
  for (let i = 1; i <= 48; i++) {
    run += bySlot.get(i * 5) ?? 0
    curve[i] = run / total
  }
  return curve
}

let progressCurve = null
let progressDays = 0
{
  const curves = []
  for (const u of UNIVERSE) {
    try {
      const bars = await sinaFiveMin(u.tx)
      const byDay = new Map()
      for (const b of bars) {
        const d = String(b.day).slice(0, 10)
        const k = byDay.get(d) ?? []
        k.push(b)
        byDay.set(d, k)
      }
      for (const arr of byDay.values()) {
        const c = dayProgress(arr)
        if (c !== null) curves.push(c)
      }
    } catch (e) {
      console.log(`  ${u.secid} 新浪 5 分钟线失败: ${e.message}`)
    }
  }
  if (curves.length > 0) {
    progressCurve = new Array(49).fill(0).map((_, i) => Number((curves.reduce((a, c) => a + c[i], 0) / curves.length).toFixed(4)))
    progressDays = curves.length
    const at = (hm) => {
      const [h, m] = hm.split(':').map(Number)
      const mins = h * 60 + m
      const elapsed = mins <= 690 ? mins - 570 : 120 + (mins - 780)
      return progressCurve[Math.round(elapsed / 5)]
    }
    console.log(`\n日内累计成交进度曲线（${progressDays} 个交易日样本）：`)
    for (const m of SINA_PROGRESS_MARKS) console.log(`  ${m}  累计占全天 ${(at(m) * 100).toFixed(1)}%`)
  }
}

const perEtf = []
const pooled = []
for (const u of UNIVERSE) {
  const bars = await tencentDaily(u.tx)
  const mults = []
  for (let i = WINDOW; i < bars.length; i++) {
    const base = avg(bars.slice(i - WINDOW, i).map((b) => b.amt))
    if (base !== null && base > 0) mults.push(bars[i].amt / base)
  }
  pooled.push(...mults)
  const rec = {
    secid: u.secid, name: u.name, bars: bars.length,
    from: bars[0]?.date, to: bars[bars.length - 1]?.date,
    avgAmt20: bars.length > WINDOW ? avg(bars.slice(-WINDOW).map((b) => b.amt)) : null,
    mult: { p50: pct(mults, 50), p75: pct(mults, 75), p90: pct(mults, 90), p95: pct(mults, 95), p99: pct(mults, 99), max: pct(mults, 100) },
  }
  perEtf.push(rec)
  console.log(`${u.secid} ${u.name.padEnd(18)} ${bars.length} 根 (${rec.from}→${rec.to})`)
  console.log(`   量能倍数 P50 ${rec.mult.p50.toFixed(2)}x  P75 ${rec.mult.p75.toFixed(2)}x  P90 ${rec.mult.p90.toFixed(2)}x  P95 ${rec.mult.p95.toFixed(2)}x  P99 ${rec.mult.p99.toFixed(2)}x  MAX ${rec.mult.max.toFixed(2)}x`)
  console.log(`   20日均成交额(近似) ${(rec.avgAmt20 / 1e8).toFixed(2)} 亿`)
}

const pooledStats = { p50: pct(pooled, 50), p75: pct(pooled, 75), p90: pct(pooled, 90), p95: pct(pooled, 95), p99: pct(pooled, 99) }
console.log(`\n全池合并（${pooled.length} 个样本）：量能倍数 P50 ${pooledStats.p50.toFixed(2)}x  P75 ${pooledStats.p75.toFixed(2)}x  P90 ${pooledStats.p90.toFixed(2)}x  P95 ${pooledStats.p95.toFixed(2)}x  P99 ${pooledStats.p99.toFixed(2)}x`)

// F1 记分锚点：以 P75/P90/P95 为 40/70/100 分
const f1 = { mid: Number(pooledStats.p75.toFixed(2)), high: Number(pooledStats.p90.toFixed(2)), extreme: Number(pooledStats.p95.toFixed(2)) }
console.log(`F1 记分锚点（P75/P90/P95 → 40/70/100 分）：${f1.mid}x / ${f1.high}x / ${f1.extreme}x`)

// F2 经验门槛（无历史可分位标定）：以「超大单净额 ÷ 20日均成交额」的倍数表达，规模自适应
const f2 = { watch: 0.2, mid: 0.5, strong: 1.0, note: '经验值；累计 ≥20 个交易日自建样本后由 script 重算覆盖' }
console.log(`F2 经验门槛（超大单净额/20日均额）：观察 ${f2.watch}x  中 ${f2.mid}x  强 ${f2.strong}x —— ${f2.note}`)

const out = {
  generatedAt: new Date().toISOString().slice(0, 10),
  method: 'F1: Tencent daily kline (vol×100×close ≈ amount), 20-day rolling ratio percentiles; progress: Sina 5-min cumulative volume share',
  window: WINDOW,
  universe: perEtf.map((e) => ({ secid: e.secid, name: e.name, avgAmt20: Math.round(e.avgAmt20 ?? 0) })),
  pooled: pooledStats,
  f1,
  f2,
  progressCurve,
  progressDays,
  perEtf: Object.fromEntries(perEtf.map((e) => [e.secid, e.mult])),
}
const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, 'rescue-thresholds.json')
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`)
console.log(`\n已写出 ${file}`)

// 同时产出 host 侧可直接 import 的 TS 模块（避免 JSON import 在打包/类型剥离下的差异）
const ts = `/**
 * 【护盘信号】默认阈值与基准 —— 由 scripts/calibrate-rescue.mjs 生成，请勿手改。
 * 标定日 ${out.generatedAt}；方法：${out.method}
 *   F1 量能倍数：${pooled.length} 个样本（6 只宽基 ETF × 约 481 个交易日的 20 日滚动量比）
 *   日内进度曲线：${progressDays} 个交易日（新浪 5 分钟线）
 *   F2 超大单强度：免费源已无日频资金流历史 → 经验锚点，由 host 采样器自建样本满 20 交易日后重算
 */
export interface RescueCalibration {
  generatedAt: string
  /** F1 量能倍数锚点（对应 40/70/100 分） */
  f1: { mid: number; high: number; extreme: number }
  /** F2 超大单净额/20日均额 锚点（经验值） */
  f2: { watch: number; mid: number; strong: number }
  /** 日内累计成交占比曲线，索引 i = 开盘后 i*5 分钟（0..48） */
  progressCurve: number[]
  progressDays: number
  pooled: { p50: number; p75: number; p90: number; p95: number; p99: number }
  universe: Array<{ secid: string; name: string; avgAmt20: number }>
}

export const RESCUE_CALIBRATION: RescueCalibration = ${JSON.stringify(
  {
    generatedAt: out.generatedAt,
    f1: out.f1,
    f2: { watch: out.f2.watch, mid: out.f2.mid, strong: out.f2.strong },
    progressCurve: out.progressCurve ?? [],
    progressDays: out.progressDays ?? 0,
    pooled: out.pooled,
    universe: out.universe,
  },
  null,
  2,
)} as unknown as RescueCalibration
`
const tsFile = join(here, '..', 'src', 'host', 'rescue-thresholds.ts')
writeFileSync(tsFile, ts)
console.log(`已写出 ${tsFile}`)
