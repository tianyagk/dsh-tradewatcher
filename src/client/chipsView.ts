/**
 * 筹码区块的**纯**视图逻辑（不 import react ⇒ 能在 node 里断言）。
 */
import { dirClass } from './format.ts'
export interface ChipsViewState {
  data: unknown
  error: string | null
  loading: boolean
}

/**
 * 日期滑杆索引的边界收敛：0 / N−1 / 越界都收敛到 `[0, N−1]`；空序列 ⇒ −1（界面据此不渲染滑杆）。
 */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return -1
  if (!Number.isFinite(index)) return length - 1
  return Math.min(length - 1, Math.max(0, Math.round(index)))
}

/**
 * 筹码分布的纵轴刻度：取 3–5 个刻度覆盖窗口两端，且**每个刻度值都必须是某行的桶中心价**
 * （task-78：旧实现按窗口两端线性等分 ⇒ 17.20/19.07/20.95 这类值不在桶中心集合里，刻度与行对不上）。
 */
export function bucketCenterTicks(centers: readonly number[], max = 5): number[] {
  const n = centers.length
  if (n === 0) return []
  if (n === 1) return [centers[0]]
  const count = Math.min(max, Math.max(2, n))
  const out: number[] = []
  for (let i = 0; i < count; i += 1) {
    const idx = Math.round((i * (n - 1)) / (count - 1))
    const v = centers[idx]
    if (out.length === 0 || out[out.length - 1] !== v) out.push(v)
  }
  return out
}

/** 筹码分布的纵轴刻度：取 3–5 个均匀刻度覆盖 [lo, hi]（含两端），与横条逐行对齐用 */
export function axisTicks(centers: readonly number[], max = 5): number[] {
  const n = centers.length
  if (n === 0) return []
  const tickCount = Math.min(max, Math.max(3, n))
  const lo = centers[0]
  const hi = centers[n - 1]
  if (!(hi > lo)) return [lo]
  return Array.from({ length: tickCount }, (_, i) => lo + ((hi - lo) * i) / (tickCount - 1))
}

/**
 * 口径**是否偏离默认**（偏离才给一行原因；正常情况一个字都不显示）。
 * 默认 = A股/深沪 + 有 floatMv + 支持前复权 + 样本够 ⇒ 换手率衰减 k=1.5、三角形、近 45 日。
 */
export function caliberDeviates(input: {
  decay: 'turnover' | 'half-life'
  decayReason: string | null
  fqSupported: boolean
  why: string | null
  samples: number
  window: number
}): string | null {
  if (input.why !== null) return input.why
  if (!input.fqSupported) return '该标的不支持前复权（指数/期货/板块）⇒ 不提供筹码分布'
  if (input.decay !== 'turnover') return input.decayReason ?? '按固定半衰期 10 日衰减（经验口径）'
  if (input.samples < input.window) return `只取到近 ${input.samples} 日（不足 ${input.window} 日）——历史越长越准`
  return null
}

/**
 * 横坐标刻度用的 **nice step**（随峰值自适应）：1/2/2.5/5 × 10^n。
 * 返回值是"占总筹码比例"的步长（0–1）。
 */
export function niceStep(peak: number, wantTicks = 5): number {
  const p = Number.isFinite(peak) && peak > 0 ? peak : 0
  if (!(p > 0)) return 0
  const raw = p / Math.max(2, wantTicks - 1)
  const mag = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (raw <= m * mag) return m * mag
  }
  return 10 * mag
}

/** 步长决定小数位（**不许出现 0.30000000004** 这类浮点毛刺） */
export function stepDecimals(step: number): number {
  if (!(step > 0)) return 2
  for (let d = 0; d <= 4; d += 1) {
    const scaled = step * 10 ** d
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return d
  }
  return 4
}

/**
 * 横坐标刻度（该价位筹码占**总筹码**的比例）：0 起步、nice step 递增，覆盖到峰值。
 * 数量控制在 3–6 之间（nice step 自适应 + 峰值上限）。
 */
export function ratioTicks(peak: number): Array<{ value: number; label: string; pct: number }> {
  const step = niceStep(peak)
  if (!(step > 0)) return []
  const d = stepDecimals(step)
  const top = Math.max(step, Math.ceil((peak + 1e-12) / step) * step)
  const out: Array<{ value: number; label: string; pct: number }> = []
  for (let v = 0; v <= top + 1e-12 && out.length < 6; v += step) {
    const value = Math.round(v / step) * step // 消掉累加误差
    out.push({ value, label: `${(value * 100).toFixed(d === 0 ? 0 : d)}%`, pct: top > 0 ? (value / top) * 100 : 0 })
  }
  if (out.length < 3) out.push({ value: top, label: `${(top * 100).toFixed(d === 0 ? 0 : d)}%`, pct: 100 })
  return out
}

export interface ChipsLine {
  kind: 'avg' | 'resistance' | 'support'
  /** 价格（画线用） */
  price: number
  /** 标签文本 = 该价格（保留两位） */
  label: string
}

/**
 * 三条**语义线**（平均成本 / 压力 P95 / 支撑 P5）。
 *
 * 异常输入（任一值缺失、P95 < P5、非有限数）⇒ 返回空数组（不出线、不抛错）——
 * 不拿默认值硬画一条线出来。
 */
export function chipsLinesOf(day: {
  avgCost: number | null
  support: number | null
  resistance: number | null
}): ChipsLine[] {
  const { avgCost, support, resistance } = day
  if (avgCost === null || support === null || resistance === null) return []
  if (![avgCost, support, resistance].every((v) => Number.isFinite(v))) return []
  if (resistance < support) return []
  return [
    { kind: 'avg', price: avgCost, label: avgCost.toFixed(2) },
    { kind: 'resistance', price: resistance, label: resistance.toFixed(2) },
    { kind: 'support', price: support, label: support.toFixed(2) },
  ]
}

/**
 * 分布图的行高：**96 桶在可用高度里每行 ≥1px**（低于 1px 就按 1px 画，**不许静默丢桶**）。
 *
 * ⚠ 保留此函数是为了兼容宿主侧既有的桶数断言（`src/host/chips.buckets.test.ts`）。
 * 客户端**不再用它**：它忽略了行间隙（`rows*rowH + (rows-1)*gap` 会超出可用高度 ⇒ 末行被裁），
 * 而且它的入参（旧的 `maxBottom`）与实际绘图区高度不是同一个数。客户端一律走 `chipsRowsLayoutOf`。
 */
export function chipsRowHeight(availablePx: number, bucketCount: number): number {
  const n = Math.max(1, Math.round(bucketCount))
  const h = Math.floor((Number.isFinite(availablePx) ? availablePx : 0) / n)
  return Math.max(1, h)
}

/** 行间隙（px）：与 `styles.ts` 的 `.tw-chips-plot{gap:1px}` 同源 */
export const CHIPS_ROW_GAP_PX = 1
/** 分割线命中区高（px）：与 `.tw-split{height:9px}` 同源（抽屉算筹码块高度时要用） */
export const SPLIT_HIT_PX = 9
/** 筹码块上距（px）：与 `.tw-chips{margin-top:6px}` 同源 */
export const CHIPS_MARGIN_TOP_PX = 6

/**
 * 筹码块里**除绘图区以外**的固定高度（px，向上取整记账）。Chrome 量真组件标记 + 真 CSS 得：
 *
 * | 项 | 来源 | px |
 * |---|---|---|
 * | 上边框 + 上下内边距 | `.tw-chips{border-top:1px;padding:4px 2px 2px}` | 1+4+2 |
 * | 标题行 | `.tw-chips-head`（实测 17.25） | 18 |
 * | body 的 3 段间隙 | `.tw-chips-body{gap:3px}`（滑杆/日期/绘图区/横轴刻度之间） | 9 |
 * | 日期行 | `.tw-chips-date`（实测 16.5） | 17 |
 * | 横轴刻度行 | `.tw-chips-xaxis`（实测 16.5） | 17 |
 * | | **合计** | **68** |
 */
export const CHIPS_CHROME_PX = (1 + 4 + 2) + 18 + 9 + 17 + 17
/** 日期滑杆那一行（`.tw-chips-slider`：28 高 + 上下各 2px 外边距，实测）—— 只有多天数据才渲染 */
export const CHIPS_SLIDER_PX = 32
/** 「区间过窄」/「口径偏离」提示行（`.tw-chips-narrow`：11px 行高 + 上下 2px 内边距，实测 19） */
export const CHIPS_NARROW_PX = 19

/**
 * 绘图区**可用高度** = 筹码块高度 − 固定项（按**实际会渲染**的可选行计）。
 *
 * 为什么必须这样算：旧实现把行高按 `split.bottom`（意图高度）算，而绘图区实际高度被
 * `.tw-chips-chart{max-height:140px}` 钉到 86px（体积差 96px）⇒ 21 行占 168px、末 12 行被静默裁掉。
 */
export function chipsPlotHeightOf(input: {
  /** 筹码块的可用高度（= 抽屉下窗高度 `split.bottom`） */
  blockPx: number
  /** 是否渲染日期滑杆（`days.length > 1`） */
  hasSlider: boolean
  /** 额外提示行数（口径偏离 / 区间过窄，各占一行） */
  extraLines?: number
}): number {
  const block = Number.isFinite(input.blockPx) && input.blockPx > 0 ? input.blockPx : 0
  const extra = Math.max(0, Math.floor(Number.isFinite(input.extraLines ?? 0) ? (input.extraLines as number) : 0))
  const chrome = CHIPS_CHROME_PX + (input.hasSlider ? CHIPS_SLIDER_PX : 0) + extra * CHIPS_NARROW_PX
  return Math.max(0, block - chrome)
}

/** 分布图的行布局（**由真实绘图区高度**算出，保证所有行都装得下） */
export interface ChipsRowsLayout {
  /** 每行高度（px，可为小数：把余量均摊，行与轴刻度严格对齐） */
  rowH: number
  /** 行间隙（px） */
  gap: number
  /** 行占用的总高（= rows*rowH + (rows-1)*gap） */
  total: number
  /** 是否真的装得下（`rows` 行 × 至少 1px + 间隙 ≤ 可用高度）。false ⇒ 会把 `fits` 如实报出去 */
  fits: boolean
}

/**
 * 按**可用高度**算行布局：先留 1px 间隙，装不下就把间隙降到 0，再装不下就按 1px 画（如实报 `fits:false`）。
 *
 * 为什么必须由这个函数算（不再用 `chipsRowHeight`）：旧实现把行高按 `split.bottom` 算，而绘图区
 * 实际只有 86px（被 `max-height` 钉住）⇒ 21 行占了 168px，**末 12 行静默被裁**（用户报"可见柱只有 3-4 根"）。
 */
export function chipsRowsLayoutOf(availablePx: number, rows: number, wantGap = CHIPS_ROW_GAP_PX): ChipsRowsLayout {
  const n = Math.max(1, Math.round(rows))
  const avail = Number.isFinite(availablePx) && availablePx > 0 ? availablePx : 0
  const fitsWith = (gap: number): boolean => (avail - (n - 1) * gap) / n >= 1
  if (fitsWith(wantGap)) {
    const rowH = (avail - (n - 1) * wantGap) / n
    return { rowH, gap: wantGap, total: n * rowH + (n - 1) * wantGap, fits: true }
  }
  if (fitsWith(0)) {
    const rowH = avail / n
    return { rowH, gap: 0, total: n * rowH, fits: true }
  }
  return { rowH: 1, gap: 0, total: n, fits: false }
}

/**
 * 展示日的**盈亏边界价**（柱色与「盈利比例」共用它）。
 *
 * 口径：优先用该日 DTO 的 `price`（宿主按"最新日=现价、历史日=当日收盘价"给，与 `profitRatio` 同源）；
 * 该字段**缺失**（老宿主）或不是有限数 ⇒ **如实回退**到顶层 `priceUsed`，并给出 `note`（不静默 ——
 * 因为回退后柱色与该日 `盈利比例` 可能不同源，这件事必须能被追到）。
 * 两者都不可得 ⇒ `price: null`（界面按"未取到"处理，**不猜一个价**）。
 */
export function chipsDayPriceOf(input: { dayPrice?: number | null; topPriceUsed: number | null }): {
  price: number | null
  fallback: boolean
  note: string | null
} {
  const day = input.dayPrice
  if (typeof day === 'number' && Number.isFinite(day)) return { price: day, fallback: false, note: null }
  const top = input.topPriceUsed
  if (typeof top === 'number' && Number.isFinite(top)) {
    return {
      price: top,
      fallback: true,
      note: input.dayPrice === undefined
        ? `该展示日未带 price（老宿主）⇒ 回退顶层现价 ${top}：柱色与该日盈利比例可能不同源`
        : `该展示日 price 不可用（${String(input.dayPrice)}）⇒ 回退顶层现价 ${top}：柱色与该日盈利比例可能不同源`,
    }
  }
  return { price: null, fallback: false, note: null }
}

/**
 * 单个桶的**盈亏方向**类（`tw-up`/`tw-down`/`tw-flat`）—— 筹码柱的唯一着色入口。
 *
 * | 桶中心 vs **现价** | 语义 | `redUp=true` | `redUp=false` |
 * |---|---|---|---|
 * | 中心 **高于**现价 | 成本高于现价 ⇒ **套牢** | `tw-down`（绿） | `tw-up`（红） |
 * | 中心 **低于**现价 | 成本低于现价 ⇒ **获利** | `tw-up`（红） | `tw-down`（绿） |
 *
 * ⚠ **边界必须是现价（`priceUsed`），不是平均成本**：
 *   - 套牢/获利的判据是"**成本** vs **现价**"；平均成本是**另一条语义线**（橙色虚线），它描述
 *     "所有筹码的加权平均成本在哪"，不构成盈亏边界。用平均成本当边界会让柱色与旁边的
 *     `盈利比例`（宿主按**现价**算：`Σ(桶价 < 现价)/Σ权重`，见 `host/chips.ts`）**互相矛盾**。
 *   - 外部举证：参考实现的红绿分界落在现价（≈22.1 ≈ 其现价 22.07），而不是它的平均成本 18.57。
 *
 * ⚠ **方向**：传进 `dirClass` 的是 `priceUsed − center`（"离现价多远、在现价哪一侧"），
 * 于是"中心高于现价"得到**负**号 ⇒ `tw-down`（`redUp=true` 时绿 = 套牢）。
 * 早期实现写成 `center − priceUsed` ⇒ 整幅分布的红绿**上下倒置**（用户报的 bug）。
 * 不许在这里写死 `tw-up`/`tw-down`：涨跌色偏好（`redUp`）必须继续由 `dirClass` 统一决定。
 */
export function chipProfitDirOf(input: { center: number; priceUsed: number | null; redUp: boolean }): string {
  const { center, priceUsed, redUp } = input
  if (priceUsed === null || !Number.isFinite(priceUsed) || !Number.isFinite(center)) return 'tw-flat'
  return dirClass(priceUsed - center, redUp)
}

/**
 * 分布行序：**价格降序**（顶行 = 最高价）。
 *
 * 为什么要它：左轴刻度是 `bucketCenterTicks(...).reverse()`（顶=最高价）、三条语义线按
 * `(hi−price)/(hi−lo)` 定位，两者都"价高在上"；柱若按升序渲染，整幅分布就是**上下镜像**，
 * 与左轴刻度、与平均成本/支撑/压力线互相矛盾（用户报"横向柱连续性差"时看到的正是这个）。
 * 权重与中心价**成对**倒序 ⇒ 不会把 A 的价格配到 B 的权重上。
 */
export function chipsRowsOf(centers: readonly number[], buckets: readonly number[]): Array<{ center: number; weight: number }> {
  const n = Math.min(centers.length, buckets.length)
  const out: Array<{ center: number; weight: number }> = []
  for (let i = n - 1; i >= 0; i -= 1) out.push({ center: centers[i], weight: buckets[i] })
  return out
}

/** 分布**轮廓**（柱端折线）：视觉引导，**不是新数据** —— 每个顶点都是同一个桶、经同一个 `widthOf` */
export interface ChipsProfile {
  /** SVG polyline 的 `points`（x = 占条列宽度的百分数，y = 像素） */
  points: string
  /** 顶点数（必须 == 行数：空桶也算一个顶点，**不许跳过**） */
  count: number
  /** 权重为 0 的行的顶点下标（这些顶点必须**在 x=0 上**，不许被跳过或拉直） */
  zeroAt: number[]
}

/**
 * 把各桶柱端连成折线。
 *
 * `widths` 必须与柱宽**同源**（同一个 `axis.widthOf`），`rowH`/`gap` 与柱高同源 ⇒ 轮廓与柱不可能对不上。
 * 顶点都保留（含空桶）：空桶的 `widthOf(0) === 0` ⇒ 折线照实经过 0，**不跨过空桶拉直**。
 */
export function chipsProfileOf(input: {
  widths: readonly number[]
  rowH: number
  gap: number
  plotH: number
}): ChipsProfile {
  const { widths } = input
  const rowH = Number.isFinite(input.rowH) && input.rowH > 0 ? input.rowH : 1
  const gap = Number.isFinite(input.gap) && input.gap >= 0 ? input.gap : 0
  const pts: string[] = []
  const zeroAt: number[] = []
  for (let i = 0; i < widths.length; i += 1) {
    const w = Number.isFinite(widths[i]) ? widths[i] : 0
    if (w <= 0) zeroAt.push(i)
    const y = i * (rowH + gap) + rowH / 2
    pts.push(`${w.toFixed(4)},${y.toFixed(2)}`)
  }
  return { points: pts.join(' '), count: widths.length, zeroAt }
}

/** ① 的填充账：上窗 + 分割线 + 筹码块 + 其余固定项 == body 内容高（空白恒 0） */
export interface DrawerFill {
  /** body 内容高（clientHeight − 上下 padding） */
  body: number
  /** 上窗（K线）高度 */
  top: number
  /** 分割线高度 */
  split: number
  /** 筹码块高度（= 剩余，被 minChips 兜底） */
  chips: number
  /** 空白（= body − 各项之和；正常为 0） */
  blank: number
}

/**
 * 两窗格**确定性铺满** body：上窗 = `split.top`，筹码块 = 剩余高度（多显行），**不留死空白**。
 * 可用高度不足（剩余 < `minChips`）⇒ 按 `minChips` 给，`blank` 变负（= 内容超出 body，body 自身可滚动），
 * **不假装装得下**。
 */
export function drawerFillOf(input: {
  bodyContentH: number
  top: number
  split: number
  /** 其余固定项（口径行 / 底栏说明）之和 */
  others: number
  minChips?: number
}): DrawerFill {
  const body = Number.isFinite(input.bodyContentH) && input.bodyContentH > 0 ? input.bodyContentH : 0
  const top = Math.max(0, Number.isFinite(input.top) ? input.top : 0)
  const split = Math.max(0, Number.isFinite(input.split) ? input.split : 0)
  const others = Math.max(0, Number.isFinite(input.others) ? input.others : 0)
  const minChipsRaw = input.minChips === undefined ? 0 : input.minChips
  const minChips = Math.max(0, Number.isFinite(minChipsRaw) ? minChipsRaw : 0)
  const chips = Math.max(minChips, body - top - split - others)
  return { body, top, split, chips, blank: body - top - split - others - chips }
}

/**
 * 横向三段的宽度**契约**（唯一来源：`styles.ts` 的 CSS 必须与这三个数一致，断言直接读 CSS 文本比对）。
 *
 * 为什么要有这一组数：条宽是按百分比写的（`width: 86%`），百分比只在**条列自己的内容盒**里才有意义。
 * 条列一旦不是"确定性地等于 可用宽度 − 左轴 − 语义线标签列"，同样的 86% 就会渲染成完全不同的像素数
 * —— 用户两次报"条被压到左侧"，而函数返回值（86%）一直是对的 ⇒ 病根在**宽度从哪来**，不在宽度算多少。
 */

/** 左轴价格列的**最小**宽度（px）：与 `.tw-chips-axis{min-width:34px}` 同源 */
export const CHIPS_AXIS_MIN_PX = 34
/** 轴与条列之间的间隙（px）：与 `.tw-chips-chart{gap:4px}` 同源 */
export const CHIPS_CHART_GAP_PX = 4
/** 语义线右侧标签列占位（px）：与 `.tw-chips-refline{right:44px}` 同源（标签绝对定位在它内侧，不参与排版） */
export const CHIPS_LABEL_RESERVE_PX = 44

/** 横轴三段的宽度账（**纯算术**：不含 DOM 猜测，可被断言锚住） */
export interface ChipsColumns {
  /** 容器内容宽（px） */
  container: number
  /** 左轴价格列（px，≥ 最小值） */
  axis: number
  /** 轴与条列之间的间隙（px） */
  gap: number
  /** 语义线标签列占位（px） */
  label: number
  /** 条列（= 容器 − 左轴 − 间隙）—— 条宽百分比的**分母** */
  bars: number
}

/**
 * 由容器宽度算出三段的像素账。
 *
 * 关键结论（断言锚的就是它）：`bars = container − axis − gap`。
 * 左轴与间隙是**确定量**，标签列是**绝对定位的覆盖层**（`right:44px` 只是画线让位，不吃排版宽度）。
 *
 * ⚠ 口径：`axis` 取**左轴最小宽度**（`.tw-chips-axis{min-width}`）⇒ `bars` 是**条列的上界**。
 * 实际轴宽在 `[min-width, max-width]` 内由价格标签位数决定（如 `5.47` 比 `1553.40` 窄），
 * 所以真实条宽会略小于这里的上界（浏览器实测 940px 容器下轴 45.67px ⇒ 条列 902px 是上界）。
 * 界面**不依赖**这个差：条宽是条列内容盒的百分比 ⇒ 无论轴多宽，条都占条列的同比例。
 * 容器宽度不可用（0/NaN/负数）⇒ 全 0（不抛错、不给负数几何）。
 */
export function chipsColumnsOf(containerPx: number): ChipsColumns {
  const container = Number.isFinite(containerPx) && containerPx > 0 ? containerPx : 0
  if (container === 0) return { container: 0, axis: 0, gap: 0, label: CHIPS_LABEL_RESERVE_PX, bars: 0 }
  const gap = CHIPS_CHART_GAP_PX
  const axis = Math.max(CHIPS_AXIS_MIN_PX, 0) // 左轴是内容决定宽度、但**不许被压缩**（flex:none + min-width）
  const bars = Math.max(0, container - axis - gap)
  return { container, axis, gap, label: CHIPS_LABEL_RESERVE_PX, bars }
}

/** 单条在**像素**上的宽度（条宽的 `%` 是条列的分母 ⇒ 这里显式乘一次，避免"百分比写在错的容器里"） */
export function chipBarPxOf(widthPct: number, barsPx: number): number {
  if (!Number.isFinite(widthPct) || !Number.isFinite(barsPx) || barsPx <= 0) return 0
  return (Math.min(100, Math.max(0, widthPct)) / 100) * barsPx
}

/** 价格轴裁剪的目标覆盖面（筹码质量）：显示区间覆盖 99% 权重，其余在轴外但如实报告 */
export const CHIPS_COVERAGE = 0.99
/** 稀疏行阈值：窗口内权重 < 窗口峰值的这个比例的行不显示（观感密集带，质量差额如实计入 dropped） */
export const MASS_THRESHOLD = 0.2

export interface MassWindow {
  from: number
  to: number
  /** 显示区间内的筹码质量占比（≥ coverage） */
  covered: number
  /** 被裁到轴外的质量占比（= 1 − covered） */
  dropped: number
  rows: number
  lo: number
  hi: number
}

/**
 * 把价格轴裁到**筹码密集区**（按质量覆盖）：从两端往内丢桶，直到剩下的质量仍 ≥ `coverage`。
 *
 * 为什么：96 桶铺在 360 天全区间（如 5.47–22.82）时，绝大多数桶权重≈0 ⇒ 画出来只有十来个可见条，
 * 观感是"条少而宽"。裁剪只改**显示范围**，不改任何权重、不做归一化拉伸（`sum = 1` 依旧守恒）。
 */
export function massWindowOf(centers: readonly number[], buckets: readonly number[], coverage = CHIPS_COVERAGE): MassWindow {
  const n = Math.min(centers.length, buckets.length)
  if (n === 0) return { from: 0, to: -1, covered: 0, dropped: 0, rows: 0, lo: Number.NaN, hi: Number.NaN }
  const total = buckets.reduce((a, b) => a + b, 0)
  if (!(total > 0)) return { from: 0, to: n - 1, covered: 0, dropped: 1, rows: n, lo: centers[0], hi: centers[n - 1] }
  let from = 0
  let to = n - 1
  let head = 0
  let tail = 0
  while (from < to && (total - head - tail - buckets[from]) >= coverage * total) {
    head += buckets[from]
    from += 1
  }
  while (to > from && (total - head - tail - buckets[to]) >= coverage * total) {
    tail += buckets[to]
    to -= 1
  }
  // ⚠ **不得**再按"权重小"删行：价格轴必须连续（窗口内每个桶都占位，空桶画零长度）。
  // 观感的"稀疏"只能靠**缩小窗口区间**（即这里的质量覆盖）解决 —— 删行会让刻度与桶价失真（task-78）。
  const kept = buckets.slice(from, to + 1).reduce((a, b) => a + b, 0)
  const covered = total > 0 ? kept / total : 0
  return { from, to, covered, dropped: 1 - covered, rows: to - from + 1, lo: centers[from], hi: centers[to] }
}

/**
 * 筹码横轴的**单位约定（写死，别再猜）**：
 * - `peak` / `top` / `step` 一律是**分数**（0–1，即"占总筹码比例"），与 `buckets` 权重同单位；
 * - `ticks[].pct` 是**百分数**（0–100），只用于 CSS 的 `%` 与文案；
 * - `widthOf(w)` 入参是**分数**（`buckets` 的权重），返回**百分数**（0–100），直接写进 CSS 宽度。
 * 任何一处跨单位都要在这里显式 `× 100`，并且**只允许在边界处乘一次**。
 */
export interface ChipAxis {
  /** 当前展示日的**单桶峰值**（分数；条宽分母、刻度峰值的**唯一来源**） */
  peak: number
  /** 轴顶（**分数**）：把峰值向上取到 nice step 的整数倍（刻度与条宽都用它 ⇒ 两者同尺度） */
  top: number
  ticks: Array<{ value: number; label: string; pct: number }>
  window: MassWindow
  /** 条宽（**百分数 0–100**）：入参是分数权重，按**轴顶**换算（不是按峰值）⇒ 8.63% 的桶在 10% 轴上占 86.3% 宽 */
  widthOf: (w: number) => number
}

/**
 * 横轴与条宽的**同一个来源**。
 *
 * 旧实现的错：条宽按 `peak` 归一（峰值 ⇒ 100% 宽），而刻度按 nice 取整后的 `top`（如 8.05% ⇒ 10%）⇒
 * 轴上最高的一条看起来"顶到 10% 的位置"、小条被压扁在左侧。现在两者都用 `top`。
 * 峰值 ≤ 0 ⇒ 不出刻度（`top = 0`），`widthOf` 恒返回 0（不抛错、不出畸形刻度）。
 */
export function chipAxisOf(centers: readonly number[], buckets: readonly number[], coverage = CHIPS_COVERAGE): ChipAxis {
  const window = massWindowOf(centers, buckets, coverage)
  const inWindow = buckets.slice(window.from, window.to + 1)
  const peak = inWindow.length > 0 ? Math.max(...inWindow) : 0
  if (!(peak > 0)) {
    return { peak: 0, top: 0, ticks: [], window, widthOf: () => 0 }
  }
  const step = niceStep(peak)
  const d = stepDecimals(step)
  const top = Math.max(step, Math.ceil((peak - 1e-12) / step) * step)
  const ticks: Array<{ value: number; label: string; pct: number }> = []
  for (let v = 0; v <= top + 1e-12 && ticks.length < 6; v += step) {
    const value = Math.round(v / step) * step
    ticks.push({ value, label: `${(value * 100).toFixed(d)}%`, pct: top > 0 ? (value / top) * 100 : 0 })
  }
  return { peak, top, ticks, window, widthOf: (w: number) => (top > 0 ? Math.min(100, Math.max(0, (w / top) * 100)) : 0) }
}
