/**
 * 日线**成交量量纲**归一（纯函数；只改 `vol`，绝不碰价格/日期/复权序列）。
 *
 * ## 为什么需要（2026-10-16 实测，三方交叉）
 *
 * 本插件全链路把 A股日线 `vol` 当作**手**：`chips` 的换手率口径 `t = vol×100×close ÷ floatMv`
 * （`src/host/chips.ts:363-369`）、行情侧 `amount ÷ (vol×100) ≈ price` 的交叉验算（`docs/DESIGN-CHIPS.md` §1）。
 *
 * 但腾讯 `fqkline` 的成交量字段在**科创板（沪市 688）**上给的是**股**：
 *
 * | 标的 | 腾讯 kline 同日 vol | 腾讯快照 vol（手，`amount÷(vol×100)=price` 自洽） | 比值 |
 * |---|---|---|---|
 * | `1.688035` 德邦科技 | 4 653 193（10-16，全天） | 46 532 | **100.0×** |
 * | `1.600519` 贵州茅台（主板） | 38 502 | 38 502 | 1.0× |
 * | `0.300285` 国瓷材料（创业板） | 546 857 | 546 857 | 1.0× |
 * | `1.510300` 沪深300ETF | 37 995 085 | 37 995 085 | 1.0× |
 *
 * ⇒ 只有**科创板**需要 ÷100；主板/创业板/ETF/港股一律不动（多测一个市场就多一份证据，
 * 但规则只在实测过的板块上生效，不做"猜别的板块也一样"的推广）。
 *
 * ## 这条规则修的是什么
 *
 * 不修的话：`t` 被放大 100× ⇒ 单日换手率立刻顶到 `CHIPS_CAP = 0.25`，旧筹码每天被清掉 37.5%
 * ⇒ 筹码分布退化成"只有最近两三天"；同一文件里"腾讯段（股）+ 东财段（手）"并存时还会出现
 * **100× 的段内断层**（`mergeBars` 按日期合并，不看过量纲）。
 *
 * ## 只做两件事，都不越界
 *
 * 1. **源归一**（`tencentVolToHands`）：腾讯科创板日线的 `vol` ÷100 入口处一次，写入缓存前生效。
 * 2. **段归一**（`normalizeVolUnits`）：已有缓存里检测 **≈100×** 的段内断层，把**较早那段**对齐到
 *    **最新那段**的量纲（只乘除 100，不插值、不填 0、不动价格与日期）；判不了就**丢段并如实给出原因**。
 *
 * 单位倍数只认 100（手↔股是 100 倍的关系）；30–300 之外的"倍数"一律**不动**——
 * 那是真实的量能变化（实测 `0.002667` 有 47× 单步、`1.603268` 有 11× 位移，都不是量纲问题），
 * 把真实放量当量纲去改，比不改更糟。
 */

/**
 * 归一函数只依赖这两个字段 ⇒ 用**结构类型**而不是 `DayBar`，
 * 这样 `fetchKline` 的 `DayBar`、chips 的 `ChipBar`（只有 date/close/vol）都能直接喂进来。
 */
export interface VolBearingBar {
  date: string
  vol: number | null
}

/** 手 ↔ 股 的换算倍数（唯一被认可的量纲倍数） */
export const VOL_UNIT_FACTOR = 100
/** 只有落在 [1/BAND, BAND] 之外的"水平位移"才被当成量纲断层；带内一律不动 */
export const VOL_UNIT_BAND = 30
/** 判定用的中位数窗口（根） */
export const VOL_UNIT_WINDOW = 30
/** 参考段（最新那段）至少要这么多根才敢拿它当量纲基准 */
export const VOL_UNIT_MIN_REF = 3

/** 科创板（沪市 688；689 是科创板存托凭证，同板块同规则，未单独实测） */
const STAR_MARKET_RE = /^1\.(688|689)\d{3}$/

export function isStarMarket(secid: string): boolean {
  return STAR_MARKET_RE.test(secid)
}

/**
 * 腾讯日线成交量 → **手**（本插件口径）。
 *
 * 科创板实测是「股」⇒ ÷100；其它市场原样返回（主板/创业板/ETF 实测就是手，港股走东财不经此路）。
 * `null` 保持 `null`（**不许用 0 顶替**），0 保持 0。
 */
export function tencentVolToHands(secid: string, vol: number | null): number | null {
  if (vol === null || !Number.isFinite(vol)) return vol
  if (!isStarMarket(secid)) return vol
  return roundTo(vol / VOL_UNIT_FACTOR, 4)
}

const roundTo = (n: number, d: number): number => Math.round(n * 10 ** d) / 10 ** d

const usable = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * `[from, to)` 里**最多 `window` 根**可用 vol 的中位数（从 `from` 往后数，不足就有多少算多少）。
 *
 * 为什么不取"到 `to` 为止的最后 window 根"：断层经常出现在**最新一段很短**的时候
 * （实测 `1.688035_101_1` 只有 10 根新 bar）——取"最后 30 根"会把 20 根旧段混进来，
 * 中位数又落回旧段，断层就永远检测不到。
 */
function levelOf(bars: readonly VolBearingBar[], from: number, to: number, window: number): { level: number; count: number } {
  const xs = bars.slice(Math.max(0, from), Math.min(bars.length, to)).slice(0, window).map((b) => b.vol).filter(usable)
  return { level: median(xs), count: xs.length }
}

export interface VolUnitBreak {
  /** 断层位置：`bars[index]` 是**新那段**的第一根 */
  index: number
  /** 旧段水平 ÷ 新段水平（≈100 ⇒ 旧段被放大；≈1/100 ⇒ 旧段被缩小） */
  ratio: number
  before: number
  after: number
}

/**
 * 找**段内量纲断层**：某处两侧的成交量水平相差 ≈100×（且断层那一根本身就是数量级跳变）。
 *
 * 为什么两个条件都要：只看单步会被一根异常巨量骗到；只看水平会被"缓慢放量/缩量"骗到。
 * 取 |log10(比值)| 最大的候选，且必须落在量纲带内。
 */
export function findVolUnitBreak(bars: readonly VolBearingBar[], opts: { window?: number; band?: number } = {}): VolUnitBreak | null {
  const window = opts.window ?? VOL_UNIT_WINDOW
  const band = opts.band ?? VOL_UNIT_BAND
  let best: VolUnitBreak | null = null
  for (let k = 1; k < bars.length; k += 1) {
    const prev = bars[k - 1].vol
    const next = bars[k].vol
    if (!usable(prev) || !usable(next)) continue
    const step = prev / next
    const inBand = (r: number): boolean => r >= band || r <= 1 / band
    if (!inBand(step)) continue
    const before = levelOf(bars, k - window, k, window)
    const after = levelOf(bars, k, k + window, window)
    if (before.count < 1 || after.count < 1 || !(before.level > 0) || !(after.level > 0)) continue
    const ratio = before.level / after.level
    if (!inBand(ratio)) continue
    // 单步与水平必须同向（都放大或都缩小），否则是"坑"不是"断层"
    if ((step > 1) !== (ratio > 1)) continue
    const score = Math.abs(Math.log10(ratio))
    if (best === null || score > Math.abs(Math.log10(best.ratio))) best = { index: k, ratio, before: before.level, after: after.level }
  }
  return best
}

export interface VolUnitFix<T extends VolBearingBar = VolBearingBar> {
  /** 归一后的序列（未命中 ⇒ 与入参同一引用） */
  bars: T[]
  /** 是否真的动过 vol */
  fixed: boolean
  /** 丢弃的根数（不可修时 > 0；**只要有丢弃就必须带 reason**） */
  dropped: number
  /** 如实标注（未命中 ⇒ null）；界面与回包直接显示这句话 */
  reason: string | null
}

/**
 * 段内量纲归一：把**较早那段**对齐到**最新那段**的量纲（只乘除 100）。
 *
 * 为什么以"最新那段"为基准：① 缓存是**追加式**的，未来的写入必须与最新那段同类，
 * 否则每次增量都会再造一个断层；② 源归一（`tencentVolToHands`）之后新写入的段已经是「手」。
 *
 * 判不了（最新那段可用根数 < {@link VOL_UNIT_MIN_REF}）⇒ **丢弃较早那段**并给出原因
 * （不拿不可信的那侧继续算，也不静默丢）。
 */
export function normalizeVolUnits<T extends VolBearingBar>(bars: readonly T[], opts: { window?: number; band?: number; minRef?: number } = {}): VolUnitFix<T> {
  const minRef = opts.minRef ?? VOL_UNIT_MIN_REF
  const hit = findVolUnitBreak(bars, opts)
  if (hit === null) return { bars: bars as T[], fixed: false, dropped: 0, reason: null }
  const newer = bars.slice(hit.index)
  const newerUsable = newer.map((b) => b.vol).filter(usable).length
  /** 断层**之前**的根数（= 被归一的、或不可修时被丢弃的那一段） */
  const older = hit.index
  const factor = hit.ratio > 1 ? 1 / VOL_UNIT_FACTOR : VOL_UNIT_FACTOR
  const direction = hit.ratio > 1 ? '较早那段被放大 100×（股）' : '较早那段被缩小 100×'
  if (newerUsable < minRef) {
    const kept = newer
    return {
      bars: kept.map((b) => ({ ...b })),
      fixed: true,
      dropped: older,
      reason:
        `日线缓存里检出成交量量纲断层（${bars[hit.index].date} 起两侧相差 ${hit.ratio.toFixed(1)}×），` +
        `但最新一段只有 ${newerUsable} 根可用 bar（< ${minRef}）⇒ 无法确定量纲基准：丢弃较早的 ${older} 根` +
        `（疑似${direction}；不拿不可信的那侧继续算，后续取数会重新补齐）`,
    }
  }
  const out = bars.map((b, i) => {
    if (i >= hit.index || !usable(b.vol)) return { ...b }
    return { ...b, vol: roundTo(b.vol * factor, 4) }
  })
  return {
    bars: out,
    fixed: true,
    dropped: 0,
    reason:
      `日线缓存里检出成交量量纲断层（${bars[hit.index].date} 起两侧相差 ${hit.ratio.toFixed(1)}×，` +
      `旧段中位 ${hit.before.toFixed(0)} / 新段中位 ${hit.after.toFixed(0)}）：${direction} ⇒ 已把较早的 ${older} 根` +
      `按 ×${factor} 归一为「手」（只改 vol，价格与日期未动）`,
  }
}

export interface VolUnitQuoteRef {
  /** 参照日（与日线最后一根同一天才有意义） */
  date: string
  /** 同日报价成交量，**本插件手口径**（`amount ÷ (vol×100) ≈ price` 自洽的那种） */
  vol: number | null
}

/**
 * **绝对量纲**校正（读侧最后一道闸）：用同日报价（手口径）比对日线。
 *
 * 段内归一只能保证"自己一致"，保证不了"自己是手"——整段都被放大 100×（一致性完好）时，
 * 只有外部参照能抓出来。
 *
 * 判据（REVIEW-7 D1 收紧，两条都必须成立才动手）：
 *   ① **必须是 100 的整数次幂附近**：`|log10(ratio / 100)| ≤ 0.1`（缓存是股）或
 *      `|log10(ratio * 100)| ≤ 0.1`（缓存比手还小 100×）。旧写法只要 `ratio ∉ [1/20, 20]` 就
 *      **无条件 ×/÷100** —— 实测 60× 也照乘，归一到手之后反而变成 0.6×，离"手"更远；
 *   ② `opts.band` 的"盘中快照不许误判"band 仍然先判（比全量小是正常的）。
 *
 * 不满足 ① 时**不改数**，只回一句"判不了"（如实说明，不猜）。
 */
export function alignVolUnitWithQuote<T extends VolBearingBar>(
  bars: readonly T[],
  ref: VolUnitQuoteRef,
  opts: { band?: number; tolerance?: number } = {},
): VolUnitFix<T> {
  const band = opts.band ?? 20
  /** 100 倍判据的容差（十进对数）：0.1 ⇒ ratio ∈ [79.4, 125.9] 才算"这是股/手之差" */
  const tolerance = opts.tolerance ?? 0.1
  if (!usable(ref.vol)) return { bars: bars as T[], fixed: false, dropped: 0, reason: null }
  const i = bars.findIndex((b) => b.date === ref.date)
  if (i < 0 || !usable(bars[i].vol)) return { bars: bars as T[], fixed: false, dropped: 0, reason: null }
  const ratio = (bars[i].vol as number) / (ref.vol as number)
  if (ratio <= band && ratio >= 1 / band) return { bars: bars as T[], fixed: false, dropped: 0, reason: null }
  /**
   * ② 只有"真的是 100 倍差"才动手。
   *
   * `log10(ratio)` 落在 +2 附近 ⇒ 缓存是股（÷100）；落在 −2 附近 ⇒ 缓存比手还小 100×（×100）。
   * 其它任何倍数（实测踩到 60×）**判不了**：既可能是上游量纲，也可能是"日线是盘中快照、
   * 报价是全天"或两者根本不是同一天 —— 猜一个 100 倍只会把数字改错。
   */
  const exponent = Math.log10(ratio)
  const asShares = Math.abs(exponent - 2) <= tolerance
  const asBelowHands = Math.abs(exponent + 2) <= tolerance
  if (!asShares && !asBelowHands) {
    return {
      bars: bars as T[],
      fixed: false,
      dropped: 0,
      reason:
        `${ref.date} 的日线成交量 ${String(bars[i].vol)} 与同日报价 ${String(ref.vol)}（手）相差 ${ratio.toFixed(1)}×，` +
        `既不是 ≈1×（同口径）也不是 ≈${VOL_UNIT_FACTOR}×（股/手）⇒ 判不了，未改动（只报数，不猜量纲）`,
    }
  }
  const factor = ratio > 1 ? 1 / VOL_UNIT_FACTOR : VOL_UNIT_FACTOR
  const out = bars.map((b) => (usable(b.vol) ? { ...b, vol: roundTo(b.vol * factor, 4) } : { ...b }))
  return {
    bars: out,
    fixed: true,
    dropped: 0,
    reason:
      `${ref.date} 的日线成交量 ${bars[i].vol} 与同日报价 ${ref.vol}（手）相差 ${ratio.toFixed(1)}× ⇒ ` +
      `判定这段日线的量纲不是「手」⇒ 全段按 ×${factor} 归一到「手」（只改 vol，价格与日期未动）`,
  }
}
