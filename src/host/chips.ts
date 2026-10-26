/**
 * 筹码分布（纯函数，不 import react）。
 *
 * 口径由 Lead 拍定 + `docs/DESIGN-CHIPS.md` 的实测支撑：
 *  ① **衰减主口径 = 换手率**：`t_i = min(vol_i×100×close_i ÷ floatMv_now, cap=0.25)`。
 *     为什么不是"成交量 ÷ 流通股本"：**流通股本拿不到，但流通市值拿得到**，而
 *     `成交额 ÷ 流通市值` 与 `成交量 ÷ 流通股本` 等价 ⇒ 不需要股数。逐日历史流通市值我们没有，
 *     所以用**当前** `floatMv` 近似（口径字符串里写明）。
 *  ② **回落口径 = 固定半衰期** `w = 0.5^(k/H)`，`H = 10` 交易日。**港股必须走这一档**：
 *     实测港股 `vol/amount` 的缩放与 A股不同（`amount ÷ (vol×price) ≈ 9926`，单位未标定）
 *     ⇒ 用换手率口径前必须先标定，本轮**不标定、直接回落**。
 *  ③ 窗口 45 根（`fqt=1` 前复权）；不足按实际根数并写 `近 N 日`；`N < 10` ⇒ 样本不足，不给结论。
 *  ④ 指数/期货/板块（`fqSupported=false`）**不提供**该模块（比"按原始价格"更诚实）。
 *  ⑤ 桶数 32，收盘价落边界时**按位置线性分摊到相邻两桶**（守恒：分摊前后总权重相等）。
 *  ⑥ 支撑/压力 = 筹码累积分布的 **P5 / P95** 价位；过窄（`P95−P5 < 区间 3%`）⇒ 只给一句"区间过窄"。
 *  ⑦ 平均成本 = Σ(桶价×权重)/Σ权重；**盈利比例** = Σ(桶价 **<** 现价 的权重)/Σ权重。
 */
export const CHIPS_BUCKETS = 96
/** 桶数的合法范围（路由参数 `buckets`）：越界夹取，非法回落默认 */
export const CHIPS_BUCKETS_MIN = 16
export const CHIPS_BUCKETS_MAX = 384
/**
 * **自适应档数**的上下限（`planBuckets`，2026-10-16）。
 *
 * 为什么要有它：档数固定 96 时，窗口从 45 天扩到 805 天会把价格区间拉宽 ⇒ 档宽从 1.25 元
 * 粗到 6.10 元（贵州茅台实测 4.9×，"筹码覆盖变全"以"价格分辨变粗"为代价）。
 *
 * 下限 48：窗口很窄（低波动 / 短窗口）时不该把分布画成几根柱子 —— 48 根仍是可读的分布形状。
 * 上限 384：见 `CHIPS_PAYLOAD_MAX_BYTES` 的推导（回包体积预算 ÷ 每「档·日」实测字节 ÷ 展示上限 60）。
 */
export const CHIPS_BUCKETS_AUTO_MIN = 48
export const CHIPS_BUCKETS_AUTO_MAX = 384
/**
 * **目标档宽**（占窗口中间价的比例）：0.1%。
 *
 * 依据（实测，见 `docs/AUDIT-IMPL66.md` §2）：**现状默认**（45 天 / 96 档）在真实样本上的
 * 档宽就是中间价的 0.096%–0.13%（茅台 1.247/1295 = 0.096%；沪深300ETF 0.0058/4.52 = 0.128%）。
 * ⇒ 取 0.1% 作为目标 = "不要把分辨率做得比现状默认更粗"，而不是重新定一个更粗的尺子。
 * （若按"价格的 0.3%–1%"取中值，现状默认视图会先粗 3–5×，那是新的回归。）
 */
export const CHIPS_WIDTH_TARGET_PCT = 0.001
/** 档宽**允许带**（占中间价）：0.05%–0.2%；越带必须是被夹住且留痕（断言用） */
export const CHIPS_WIDTH_BAND: readonly [number, number] = [0.0005, 0.002]
/**
 * 回包体积预算（字节）与每「档·日」的实测字节成本。
 *
 * 实测（`display=45`，`buckets + centers` 两个数组是回包主体）：13.3 B/档·日（沪深300ETF，
 * 价格位数少）～22.5 B/档·日（贵州茅台，1170–1740 的 centers 串更长）。取 **24 B** 作最坏估计。
 * 推导上限：`256 KB ÷ 24 B ÷ 60 天（display 上限） ≈ 182` ⇒ 但 `display` 默认 45 时是
 * `256 KB ÷ 24 ÷ 45 ≈ 242`；而"能画出来的分辨率"另有上限（渲染行数），见 AUDIT §4。
 * 两个上限同时生效：`min(384, 体积预算推出的档数)`，谁先撞上都要留痕。
 */
export const CHIPS_PAYLOAD_MAX_BYTES = 256 * 1024
export const CHIPS_BYTES_PER_BUCKET_DAY = 24
/** 累积窗口（逐日递推用到的历史长度）：360 个交易日 */
export const CHIPS_WINDOW = 360
/** 展示窗口（滑杆覆盖的天数）：45，上限 60 */
export const CHIPS_DISPLAY = 45
export const CHIPS_DISPLAY_MAX = 60
/** 累积窗口的**上限**（`days` 参数最多给到这么多） */
export const CHIPS_WINDOW_MAX = 400
/** 换手率口径的封顶（单日最多换掉 25% 筹码，避免极端值把权重打满） */
export const CHIPS_CAP = 0.25
/** 固定半衰期（交易日）：港股与缺 floatMv 时使用 */
export const CHIPS_HALF_LIFE = 10
/** 衰减系数 k（用户口径）：`chips_t = chips_{t-1} × max(0, 1 − t_t×k) + new_t`，默认 1.5、范围 [0.5, 3.0] */
export const CHIPS_DECAY_DEFAULT = 1.5
export const CHIPS_DECAY_MIN = 0.5
export const CHIPS_DECAY_MAX = 3
/** 新增筹码的分配形状：三角形（默认，峰在当日均价）／均匀 */
export type ChipSpread = 'triangle' | 'uniform'
export const CHIPS_SPREAD_DEFAULT: ChipSpread = 'triangle'

/** 口径归一：非法值（负数/超范围/未知形状）⇒ 回落默认，并如实回报（不静默） */
export function normalizeChipPrefs(raw: { decay?: unknown; spread?: unknown }): { decay: number; spread: ChipSpread; notes: string[] } {
  const notes: string[] = []
  const d = typeof raw.decay === 'number' && Number.isFinite(raw.decay) ? raw.decay : Number.NaN
  let decay = CHIPS_DECAY_DEFAULT
  if (Number.isFinite(d)) {
    if (d < CHIPS_DECAY_MIN || d > CHIPS_DECAY_MAX) notes.push(`衰减系数 k=${d} 超出 [${CHIPS_DECAY_MIN}, ${CHIPS_DECAY_MAX}] ⇒ 回落 ${CHIPS_DECAY_DEFAULT}`)
    else decay = d
  } else if (raw.decay !== undefined) {
    notes.push(`衰减系数 k 不是数字（${String(raw.decay)}）⇒ 回落 ${CHIPS_DECAY_DEFAULT}`)
  }
  let spread: ChipSpread = CHIPS_SPREAD_DEFAULT
  if (raw.spread !== undefined) {
    if (raw.spread === 'triangle' || raw.spread === 'uniform') spread = raw.spread
    else notes.push(`筹码形状「${String(raw.spread)}」认不出（只支持 triangle/uniform）⇒ 回落 ${CHIPS_SPREAD_DEFAULT}`)
  }
  return { decay, spread, notes }
}
export const CHIPS_MIN_SAMPLES = 10
/** "区间过窄"阈值：P95−P5 占价格区间的比例 */
export const CHIPS_NARROW_RATIO = 0.03

/** 归一桶数：非数字/越界 ⇒ 如实回落（默认 96），合法范围内夹取 */
export function normalizeBuckets(raw: unknown): { buckets: number; note: string | null } {
  if (raw === undefined) return { buckets: CHIPS_BUCKETS, note: null }
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : Number.NaN
  if (!Number.isFinite(n)) return { buckets: CHIPS_BUCKETS, note: `桶数不是数字（${String(raw)}）⇒ 回落默认 ${CHIPS_BUCKETS}` }
  if (n < CHIPS_BUCKETS_MIN || n > CHIPS_BUCKETS_MAX) {
    const clamped = Math.min(CHIPS_BUCKETS_MAX, Math.max(CHIPS_BUCKETS_MIN, n))
    return { buckets: clamped, note: `桶数 ${n} 超出 [${CHIPS_BUCKETS_MIN}, ${CHIPS_BUCKETS_MAX}] ⇒ 夹到 ${clamped}` }
  }
  return { buckets: n, note: null }
}

/**
 * **档数规划**（纯函数，2026-10-16 自适应改造）。
 *
 * 规则（一句话）：让**每档宽度**尽量等于「窗口中间价 × `CHIPS_WIDTH_TARGET_PCT`」，
 * 档数落在 `[CHIPS_BUCKETS_AUTO_MIN, CHIPS_BUCKETS_AUTO_MAX]`，且**回包体积**不超预算 ——
 * 任何一道限制先撞上，都必须在 `note` 里写明（**不得静默变粗**，界面直接显示 `note`）。
 *
 * 为什么参考价取**区间中点**（不是现价、不是最高价）：档宽是"价格轴的分辨率"，
 * 它的尺度应该跟着**被覆盖的那段价格**走；现价会在区间边缘（例如跌了 40% 之后的价格），
 * 用它算出的档宽会让轴的一端明显更细/更粗。中点是对称的、与窗口端点同源（都是 low/high）。
 */
export interface BucketPlan {
  buckets: number
  /** 实际档宽（元）= 价格区间 ÷ 档数 */
  width: number
  /** 目标档宽（元）= 中间价 × 目标比例 */
  target: number
  /** 参考价（窗口价格区间的中点） */
  mid: number
  /** 实际档宽占中间价的比例 */
  widthPct: number
  /** 被哪一道限制夹住（`null` = 目标档宽直接达成） */
  clamped: 'min' | 'max' | 'payload' | null
  /** 夹取说明（未夹 ⇒ `null`）；**界面必须能读到它** */
  note: string | null
}

export function planBuckets(input: {
  low: number
  high: number
  /** 展示天数（体积预算按"每档·日"算，展示越长预算越紧） */
  displayDays: number
  /** 显式指定的档数（路由/工具参数）：给了就**不再自适应**，只做范围夹取 */
  explicit?: number | null
}): BucketPlan {
  const r4 = (n: number): number => Math.round(n * 1e4) / 1e4
  const low = Number.isFinite(input.low) ? input.low : 0
  const high = Number.isFinite(input.high) ? input.high : 0
  const span = Math.max(0, high - low)
  const mid = (low + high) / 2
  const target = mid > 0 ? mid * CHIPS_WIDTH_TARGET_PCT : 0
  const days = Math.max(1, Math.round(Number.isFinite(input.displayDays) ? input.displayDays : 1))
  /** 体积预算允许的档数（展示天数越多，允许的档数越少） */
  const byPayload = Math.max(CHIPS_BUCKETS_AUTO_MIN, Math.floor(CHIPS_PAYLOAD_MAX_BYTES / (CHIPS_BYTES_PER_BUCKET_DAY * days)))
  const finish = (buckets: number, clamped: BucketPlan['clamped'], note: string | null): BucketPlan => {
    const width = buckets > 0 ? span / buckets : 0
    const widthPct = mid > 0 ? width / mid : 0
    return { buckets, width: r4(width), target: r4(target), mid: r4(mid), widthPct, clamped, note }
  }

  // 显式档数：既有的 `buckets` 参数语义不变（只在 [MIN, MAX] 里夹取，越界留痕）
  if (input.explicit !== null && input.explicit !== undefined) {
    const n = Math.round(input.explicit)
    if (n < CHIPS_BUCKETS_MIN || n > CHIPS_BUCKETS_MAX) {
      const clampedN = Math.min(CHIPS_BUCKETS_MAX, Math.max(CHIPS_BUCKETS_MIN, n))
      return finish(clampedN, n > CHIPS_BUCKETS_MAX ? 'max' : 'min', `显式档数 ${n} 超出 [${CHIPS_BUCKETS_MIN}, ${CHIPS_BUCKETS_MAX}] ⇒ 夹到 ${clampedN}（显式指定 ⇒ 不做自适应）`)
    }
    return finish(n, null, null)
  }

  if (!(target > 0) || !(span > 0)) {
    // 退化输入（区间为 0 / 中间价非正）：给下限，并留痕（不假装算出了目标档宽）
    return finish(CHIPS_BUCKETS_AUTO_MIN, 'min', `价格区间 ${r4(span)} 元 / 中间价 ${r4(mid)} ⇒ 目标档宽不可算，按档数下限 ${CHIPS_BUCKETS_AUTO_MIN} 出分布`)
  }
  const want = Math.round(span / target)
  let buckets = Math.min(CHIPS_BUCKETS_AUTO_MAX, Math.max(CHIPS_BUCKETS_AUTO_MIN, want))
  let clamped: BucketPlan['clamped'] = want < CHIPS_BUCKETS_AUTO_MIN ? 'min' : want > CHIPS_BUCKETS_AUTO_MAX ? 'max' : null
  let note: string | null = null
  const ratio = (b: number): number => (span / b) / target
  if (clamped === 'min') {
    note = `目标档宽 ${r4(target)} 元（中间价 ${r4(mid)} 的 ${(CHIPS_WIDTH_TARGET_PCT * 100).toFixed(2)}%）只需 ${want} 档 < 下限 ${CHIPS_BUCKETS_AUTO_MIN} ⇒ 按下限出分布，实际档宽 ${r4(span / buckets)} 元（比目标细 ${ratio(buckets).toFixed(2)}×）`
  } else if (clamped === 'max') {
    note = `按目标档宽 ${r4(target)} 元需要 ${want} 档 > 上限 ${CHIPS_BUCKETS_AUTO_MAX} ⇒ 夹到 ${CHIPS_BUCKETS_AUTO_MAX}，实际档宽 ${r4(span / buckets)} 元（比目标粗 ${ratio(buckets).toFixed(2)}×；分辨率已到本模块上限）`
  }
  // 体积预算：展示天数多 / 价格位数长时先撞上（回包主体是 buckets + centers 两个数组）
  if (buckets > byPayload) {
    const before = buckets
    buckets = byPayload
    clamped = 'payload'
    note = `回包大小上限 ${Math.round(CHIPS_PAYLOAD_MAX_BYTES / 1024)} KB（每档·日实测 ${CHIPS_BYTES_PER_BUCKET_DAY} B × 展示 ${days} 天）只允许 ${byPayload} 档 ⇒ 档数 ${before} → ${byPayload}，实际档宽 ${r4(span / buckets)} 元（比目标 ${r4(target)} 元粗 ${ratio(buckets).toFixed(2)}×）`
  }
  return finish(buckets, clamped, note)
}

export interface ChipBar {
  date: string
  close: number
  /** 成交量（手/股按上游原样；换手率口径下与 close 一起构成成交额） */
  vol: number | null
}

export type ChipDecay = 'turnover' | 'half-life'

/**
 * 【测试钩子】本次进程内"真的算了逐日统计量"的天数（`__resetChipStatsDays` 清零）。
 *
 * 为什么需要它：非展示日的统计量算完就丢（无输出差异），唯一可观测的差异是**成本**。
 * 用耗时断言会被机器负载打成 flaky；这里用**调用次数**断言"只有 display 天算统计"，
 * 判据是确定的：180 天窗/45 天展示 ⇒ 计数必须恰好 45（旧写法是 180）。
 */
let __chipStatsDays = 0

/** 测试钩子：读累计"计算过统计量的天数" */
export function __chipStatsDaysOf(): number {
  return __chipStatsDays
}

/** 测试钩子：清零 */
export function __resetChipStatsDays(): void {
  __chipStatsDays = 0
}

export interface ChipDay {
  date: string
  /** 32 桶权重（和为 1；全 0 时代表没有可用样本） */
  buckets: number[]
  /**
   * ⚠ **本批（AUDIT-IMPL73）起逐日不再携带 `centers`**：档中心是整段序列的**同一根轴**
   * （`centers` 在 `chipSeriesOf` 里只生成一次），逐日重复一遍让回包 166 KB 里 83 KB
   * 是同一个 242 元数组的 45 份拷贝（REVIEW-9-PERF §2.1/§4）。轴改在顶层 `ChipSeries.centers` 给一份。
   * 保留这个可选字段只为**老宿主回包**在客户端能被读到（`ChipsPanel` 用 `day.centers ?? payload.centers`）。
   */
  centers?: number[]
  avgCost: number | null
  support: number | null
  resistance: number | null
  narrow: boolean
  /**
   * 该展示日的**盈亏边界价**（与 `profitRatio` **同源**：同一行代码里那一个变量算出来的）。
   *
   * 口径：**最新展示日** = 顶层 `priceUsed`（现价：优先 quote，宿主按需回落到收盘价）；
   * **历史展示日** = **当日收盘价**（`bars[i].close`）—— 历史那天的"套牢/获利"只能按那天的价算。
   * 不可得 ⇒ `null`（界面按"未取到"处理，**不猜一个价**）。
   *
   * 为什么要逐日给：界面用 `priceUsed` 给筹码柱上色时，拖到历史日就会与该日 `profitRatio`
   * 形成两套边界 ⇒ 同一屏自相矛盾。有了它，柱色与盈利比例用同一个价。
   */
  price: number | null
  profitRatio: number | null
  samples: number
}

export interface ChipSeries {
  days: ChipDay[]
  /** 最后一天（界面默认显示这一天） */
  latest: ChipDay | null
  /**
   * **档中心价位（轴）——整段序列只此一份**（与每天的 `buckets` 等长；无分布 ⇒ 空数组）。
   *
   * 为什么在顶层：档位由窗口的 `[low, high]` 与档数决定，**与"哪一天"无关** ⇒ 逐日重复是纯冗余
   * （REVIEW-9-PERF：166 KB 回包里 83 KB 是 45 份相同数组）。客户端按 `day.centers ?? payload.centers` 读，
   * 老宿主（逐日给）与新宿主（顶层给）都能渲染。
   */
  centers: number[]
  /** 累积窗口（递推实际用了几根） */
  window: number
  /** 展示窗口（`days` 里最后这么多天有状态；滑杆只覆盖这些天） */
  displayWindow: number
  bucketCount: number
  /**
   * **实际档宽**（元）= 价格区间 ÷ 档数；没有分布（不提供模块/样本不足/区间为 0）⇒ `null`。
   *
   * 为什么要单独给：档数不变时档宽会随窗口变粗（45 天 1.25 元 → 805 天 6.10 元，茅台实测 4.9×）。
   * 界面必须能读到"这个分布的价格分辨率是多少"（`档宽 X 元`），而不是只看到"96 档"。
   */
  bucketWidth: number | null
  /** 目标档宽（元）= 中间价 × `CHIPS_WIDTH_TARGET_PCT`；无分布 ⇒ `null` */
  bucketTarget: number | null
  /** 档数被哪一道限制夹住（`null` = 目标档宽直接达成；`min`/`max`/`payload` 见 `planBuckets`） */
  bucketClamped: 'min' | 'max' | 'payload' | null
  /** 夹取说明（未夹 ⇒ `null`）——**界面必须显示它**，否则"档数被上限夹住"就成了静默变粗 */
  bucketNote: string | null
  decay: ChipDecay
  /** 回落原因（主口径可用时为 null；**必须如实写清**，界面直接显示） */
  decayReason: string | null
  avgCost: number | null
  support: number | null
  resistance: number | null
  narrow: boolean
  profitRatio: number | null
  samples: number
  /** 口径字符串（与算法同源，随结果返回） */
  methodology: string
  /** 盈利比例实际用到的现价（已换算到前复权空间）；不可得 ⇒ null（界面显示"未取到"，不是 0） */
  priceUsed: number | null
  /** 现价来源：quote = 报价快照（已换算）；close = 回落用展示日前复权收盘价 */
  priceSource: 'quote' | 'close' | null
  /** 价格空间：桶价与 priceUsed 都在这个口径下（固定 1 = 前复权） */
  fqt: 1
  /** 换算因子（1 = 恒等；≠1 时说明现价被换算了多少） */
  priceScale: number
  /** 递推窗口最后一根 bar 的日期（"最新一根"的语义锚点） */
  latestBarDate: string | null
  /** 展示日（滑杆当前日）与最新 bar 是否同一天；不一致时盈利比例用**展示日收盘价**，不混用 */
  barAlignsWithDisplay: boolean
  /**
   * 最后一根 bar 的元信息（partial = 盘中未完成 bar，数值会变）。
   *
   * ⚠ REVIEW-7 D8 / AUDIT-IMPL74：`vol` 以前是 `number`，取值写成 `vol ?? 0` ——
   * **把"上游没给"编码成 0**，而类型又把 0 写死成合法值，于是「缺失」与「真的零成交」
   * 在回包里长得一模一样（同文件其余字段一律 `number | null` + 原因，只有这一处破例）。
   * 现在两者分开表达：
   *   · `vol === null` + `volReason !== null` ⇒ **上游没给**（缺失，不是 0）；
   *   · `vol === 0` + `zeroVolume === true` ⇒ **上游真的给了 0**（停牌/无成交），不是缺失。
   */
  lastBar: {
    date: string
    close: number
    /** 成交量：`null` = 上游没给；`0` = 上游真的给了 0 */
    vol: number | null
    /** `vol === null` 时的原因（`vol` 有值——含真 0——时为 null） */
    volReason: string | null
    /** `vol === 0` 且来自上游的 0（不是缺失）—— 界面据此说「零成交」而不是「未取到」 */
    zeroVolume: boolean
    partial: boolean
  } | null
  /** 不提供该模块时的一句话原因（指数/期货/样本不足），否则 null */
  why: string | null
  disclaimer: string
}

const round = (n: number, d = 4): number => Math.round(n * 10 ** d) / 10 ** d

/** 桶中心：把 [low, high] 等分成 n 桶，中心取每桶中点（与参考实现"价格刻度"同性质） */
export function bucketCenters(low: number, high: number, n: number): number[] {
  const width = (high - low) / n
  return Array.from({ length: n }, (_, i) => low + width * (i + 0.5))
}

/**
 * 把一份权重按价格**线性分摊**到相邻两桶（守恒）。
 * 价格正好落在桶中心 ⇒ 全给该桶；落在两中心之间 ⇒ 按距离反比拆分。
 */
export function allocate(weights: number[], centers: number[], price: number, w: number): void {
  const n = centers.length
  if (n === 0 || !(w > 0)) return
  if (price <= centers[0]) {
    weights[0] += w
    return
  }
  if (price >= centers[n - 1]) {
    weights[n - 1] += w
    return
  }
  for (let i = 0; i < n - 1; i += 1) {
    const a = centers[i]
    const b = centers[i + 1]
    if (price >= a && price <= b) {
      const t = (price - a) / (b - a)
      weights[i] += w * (1 - t)
      weights[i + 1] += w * t
      return
    }
  }
}

/**
 * 当日新增筹码的分配（守恒）：`new_t` 按形状铺到当日价格区间。
 *  - 三角形（默认）：以**当日均价** `(high+low+close)/3` 为峰，向 high/low 线性递减；
 *  - 均匀：区间内平均分配。
 * 两种形状的总权重都等于 `w`（断言守恒）。
 */
export function allocateSpread(
  weights: number[],
  centers: number[],
  low: number,
  high: number,
  w: number,
  shape: ChipSpread,
  peak: number,
): void {
  const n = centers.length
  if (n === 0 || !(w > 0)) return
  const span = high - low
  // 三角形未归一化的密度：峰处 1，端点 0；退化（span=0）⇒ 单点
  const density = (p: number): number => {
    if (!(span > 0)) return p === peak ? 1 : 0
    return p <= peak ? Math.max(0, (p - low) / Math.max(1e-12, peak - low)) : Math.max(0, (high - p) / Math.max(1e-12, high - peak))
  }
  // 先用密度函数算每个桶的权重（用桶中心的密度 × 桶宽近似，再归一化保证总量守恒）
  const raw = centers.map((c) => (shape === 'uniform' ? 1 : density(c)))
  const total = raw.reduce((s2, x) => s2 + x, 0)
  if (total <= 0) {
    // 密度全 0（形状退化）⇒ 退化成"全给最接近峰值的桶"，仍守恒
    let best = 0
    for (let i = 1; i < n; i += 1) if (Math.abs(centers[i] - peak) < Math.abs(centers[best] - peak)) best = i
    weights[best] += w
    return
  }
  for (let i = 0; i < n; i += 1) weights[i] += (raw[i] / total) * w
}

/** 分位价位（在桶中心上线性插值，稳定可复算） */
export function percentilePrice(buckets: readonly number[], centers: readonly number[], q: number): number | null {
  const total = buckets.reduce((s, x) => s + x, 0)
  if (!(total > 0)) return null
  const target = total * q
  let acc = 0
  for (let i = 0; i < buckets.length; i += 1) {
    const next = acc + buckets[i]
    if (next >= target) {
      if (buckets[i] === 0) return centers[i]
      // 在该桶的价格区间内线性插值：桶 i 的区间 = [上一个中心, 本中心]
      const lo = i === 0 ? centers[i] : centers[i - 1]
      const hi = centers[i]
      const frac = (target - acc) / buckets[i]
      return lo + (hi - lo) * frac
    }
    acc = next
  }
  return centers[centers.length - 1] ?? null
}

/** 当日均价（用户口径）：(high + low + close) / 3 —— 三角形分布的峰 */
export function peakAfter(low: number, high: number, close: number): number {
  return (high + low + close) / 3
}

export interface ChipOptions {
  /** 当日流通市值（元）。拿不到 ⇒ 回落半衰期 */
  floatMv?: number | null
  /** 港股（`116.*`）：vol/amount 单位未标定 ⇒ **必须**回落半衰期 */
  isHk?: boolean
  /** 现价（盈利比例用；缺失 ⇒ 盈利比例未取到，平均成本仍给） */
  price?: number | null
  /**
   * **价格空间换算因子**：桶价来自 `fqt=1` 前复权序列，而报价快照是**未复权**的 ⇒
   * 比较前必须换算：`priceAdj = priceRaw × priceScale`，其中
   * `priceScale = closeFq1_last / closeFq0_last`（两个 close 取**同一根**最新日线）。
   * 缺失/为 1 ⇒ 不换算（恒等，不引入漂移）。
   */
  priceScale?: number | null
  /** 现价来源：`quote`（报价快照，已按 priceScale 换算）/ `close`（回落用展示日的前复权收盘价） */
  priceSource?: 'quote' | 'close'
  /** 该标的是否支持前复权（指数/期货/板块 ⇒ false，直接不提供模块） */
  fqSupported?: boolean
  /**
   * 换手率口径里的流通市值怎么取：
   *  - `now`（默认）：`amount_t ÷ floatMv_now`（现在线上的口径）
   *  - `price-scaled`（历史代理）：`amount_t ÷ (floatMv_now × close_t / close_now)`，
   *    假设**股本近似不变** ⇒ 历史流通市值随价格缩放（更贴近"当年那天的市值"）
   */
  floatMvMode?: 'now' | 'price-scaled'
  buckets?: number
  window?: number
  halfLife?: number
  cap?: number
  /** 样本数下限（默认 `CHIPS_MIN_SAMPLES`；断言/离线分析可放宽） */
  minSamples?: number
  /**
   * 展示窗口（滑杆覆盖的天数，默认 45、上限 60）。
   * **累积窗口**由 `window` 给（默认 180）：递推从 180 天前开始，只为最近 `display` 天记录状态 ——
   * 否则最早那批筹码"全是获利盘"（用户指出的问题）。
   */
  display?: number
  /** 衰减系数 k（默认 1.5，范围 [0.5, 3.0]） */
  decay?: number
  /** 新增筹码分配形状（默认 triangle） */
  spread?: ChipSpread
}

/**
 * 最后一根 bar 的元信息（**真 0 与缺失必须可区分**）。
 *
 * 判据就一条：`vol` 是不是有限数字。
 *   · `null` / `undefined` / `NaN` ⇒ 上游没给 ⇒ `vol: null` + 原因；
 *   · `0` ⇒ 上游真的给了 0（实测港股有 3 根这样的 bar）⇒ `vol: 0` + `zeroVolume: true`。
 * **绝不** `?? 0`：那会把「没取到」显示成「零成交」，而零成交是**事实断言**。
 */
export function lastBarMetaOf(
  bar: Pick<ChipBar, 'date' | 'close' | 'vol'>,
  date: string,
): NonNullable<ChipSeries['lastBar']> {
  const raw = bar.vol
  const usable = typeof raw === 'number' && Number.isFinite(raw)
  const vol = usable ? raw : null
  return {
    date,
    close: bar.close,
    vol,
    volReason: vol === null ? `上游这一根没有给出成交量（缺失，不是 0）⇒ 按「未取到」处理` : null,
    zeroVolume: vol === 0,
    partial: false,
  }
}

/** 逐日筹码分布（含每日的 avgCost / P5 / P95 / 盈利比例） */
export function chipSeriesOf(bars: readonly ChipBar[], opts: ChipOptions = {}): ChipSeries {
  /**
   * 档数：**不显式指定就自适应**（`planBuckets` 按价格区间定档宽）；显式指定仍走 `normalizeBuckets`
   * （非数字回落默认 96 并留痕）—— 显式值不参与自适应，**几何口径仍由 `planBuckets` 统一计算**。
   */
  const nb = opts.buckets === undefined ? null : normalizeBuckets(opts.buckets)
  const window = opts.window ?? CHIPS_WINDOW
  const display = Math.min(CHIPS_DISPLAY_MAX, Math.max(1, Math.round(opts.display ?? CHIPS_DISPLAY)))
  const halfLife = opts.halfLife ?? CHIPS_HALF_LIFE
  const cap = opts.cap ?? CHIPS_CAP
  const norm = normalizeChipPrefs({ decay: opts.decay, spread: opts.spread })
  const kFactor = norm.decay
  const shape = norm.spread
  const mvMode = opts.floatMvMode ?? 'now'
  const win = bars.filter((b) => Number.isFinite(b.close) && b.close > 0).slice(-window)
  // 价格空间：桶价是 fqt=1 前复权；报价快照未复权 ⇒ 先换算再比较（因子缺失/非有限 ⇒ 1，恒等）
  const scaleRaw = typeof opts.priceScale === 'number' && Number.isFinite(opts.priceScale) && opts.priceScale > 0 ? opts.priceScale : 1
  const priceRaw = typeof opts.price === 'number' && Number.isFinite(opts.price) && opts.price > 0 ? opts.price : null
  const priceUsed = priceRaw === null ? null : priceRaw * scaleRaw
  const priceSource: 'quote' | 'close' | null = priceRaw === null ? null : (opts.priceSource ?? 'quote')
  const latestBarDate = win.length > 0 ? win[win.length - 1].date : null
  const samples = win.length
  const base: Omit<ChipSeries, 'days' | 'latest'> = {
    window,
    displayWindow: display,
    // 没有分布时（不支持前复权/样本不足/区间为 0）不给假的档宽：档数写历史默认值，档宽与夹取说明为 null
    bucketCount: nb?.buckets ?? CHIPS_BUCKETS,
    bucketWidth: null,
    bucketTarget: null,
    bucketClamped: null,
    bucketNote: null,
    decay: 'half-life',
    decayReason: null,
    avgCost: null,
    support: null,
    resistance: null,
    narrow: false,
    profitRatio: null,
    samples,
    methodology: '',
    priceUsed,
    priceSource,
    fqt: 1,
    priceScale: scaleRaw,
    latestBarDate,
    barAlignsWithDisplay: true,
    // 无分布（不支持复权/样本不足/区间为 0）时没有轴：不给空档位冒充"档数为 0"
    centers: [],
    lastBar: win.length > 0 ? lastBarMetaOf(win[win.length - 1], latestBarDate ?? '') : null,
    why: null,
    disclaimer: '这是筹码分布统计量（成交量的历史累积），不是支撑/压力的预测，也不是买卖建议。',
  }
  // ⑤ 不提供的三种情形：不支持前复权（指数/期货/板块）、样本不足、没有可用 bar
  if (opts.fqSupported === false) {
    return {
      ...base,
      days: [],
      latest: null,
      // ⚠ 措辞要同时覆盖两种"没有复权序列"：指数/期货是**不需要**，美股是上游**只给未复权价**
      // （实测 AAPL 拆股日 499.23→129.04 未被调整）⇒ 跨拆股算持仓成本会失真，宁可不提供。
      // 本函数拿不到 secid（只有 bars），所以两种情况用同一句、把两种原因都写全。
      why: '本插件没有该标的的前复权序列（指数/期货/板块无除权概念；美股上游只给未复权原始价，拆股/分红未调整）⇒ 本模块不提供筹码分布',
    }
  }
  if (samples < (opts.minSamples ?? CHIPS_MIN_SAMPLES)) {
    return { ...base, days: [], latest: null, why: `样本不足（近 ${samples} 个交易日 < ${CHIPS_MIN_SAMPLES}）⇒ 不给结论` }
  }
  const lows = win.map((b) => b.close)
  const low = Math.min(...lows)
  const high = Math.max(...lows)
  if (!(high > low)) {
    return { ...base, days: [], latest: null, why: '窗口内价格没有变化（高=低）⇒ 分布无意义' }
  }
  // 档数自适应（2026-10-16）：让档宽 ≈ 中间价 × 0.1%，并受 [48, 384] 与回包体积预算约束（夹住必留痕）
  const plan = planBuckets({ low, high, displayDays: display, explicit: nb === null ? null : nb.buckets })
  const buckets = plan.buckets
  const bucketNote = plan.note ?? nb?.note ?? null
  const centers = bucketCenters(low, high, buckets)
  // 衰减口径：港股或缺 floatMv ⇒ 半衰期（并如实写原因）
  const useTurnover = opts.isHk !== true && typeof opts.floatMv === 'number' && opts.floatMv > 0
  const decay: ChipDecay = useTurnover ? 'turnover' : 'half-life'
  const decayReason = useTurnover
    ? null
    : opts.isHk === true
      ? '港股 vol/amount 的缩放与 A股不同（实测比值≈9926，单位未标定）⇒ 未标定前不能按换手率口径算，回落固定半衰期 10 日'
      : '缺当日流通市值（floatMv，新浪备用源不提供）⇒ 回落固定半衰期 10 日'
  // 逐日递推：先算每天新增权重贡献，再按"旧筹码被换掉"的比例衰减历史
  const days: ChipDay[] = []
  let hist = new Array<number>(buckets).fill(0)
  /** 实际生效的衰减因子（取整段里最小的那个）——用来在口径里如实写"夹到 0"这件事 */
  let minFactor = Number.POSITIVE_INFINITY
  let clamped = false
  let peakSum = 0
  for (let i = 0; i < win.length; i += 1) {
    const b = win[i]
    let w: number
    if (useTurnover) {
      // t_i = 成交额 ÷ 流通市值（= 换手率）；vol 是"手" ⇒ ×100 得股数（上游 A股口径）
      const amount = b.vol === null ? null : b.vol * 100 * b.close
      const mv = mvMode === 'price-scaled'
        ? (opts.floatMv as number) * (b.close / Math.max(1e-9, win[win.length - 1].close))
        : (opts.floatMv as number)
      const raw = amount === null ? null : amount / mv
      const t = raw === null ? null : Math.min(cap, Math.max(0, raw))
      // 新增筹码权重 = 当日换手率（夹到 cap）；下面递推里乘的换手率因子也用同一个 t
      w = t === null ? 0 : t
    } else {
      // 半衰期：越近的 bar 权重越大（k=0 是最近）
      const k = win.length - 1 - i
      w = 0.5 ** (k / halfLife)
    }
    // 递推式（用户口径）：chips_t = chips_{t-1} × max(0, 1 − t_t×k) + new_t
    //  `t_t` = 当日换手率 = 成交额 ÷ 流通市值（等价于 成交量 ÷ 流通股本）；`k` = 衰减系数（默认 1.5）
    //  `1 − t_t×k` 可能为负 ⇒ **必须**夹到 0（旧筹码全清），并把**实际生效的因子**写进口径字符串
    const rawFactor = useTurnover ? 1 - w * kFactor : 0.5 ** (1 / halfLife)
    const decayFactor = Math.max(0, rawFactor)
    if (decayFactor < minFactor) minFactor = decayFactor
    if (rawFactor < 0) clamped = true
    const lowBar = (b as { low?: number }).low ?? b.close
    const highBar = (b as { high?: number }).high ?? b.close
    peakSum += (highBar + lowBar + b.close) / 3
    for (let x = 0; x < buckets; x += 1) hist[x] *= decayFactor
    // 新增筹码按形状铺到当日价格区间（三角形峰在当日均价）
    allocateSpread(hist, centers, lowBar, highBar, w, shape, peakAfter(lowBar, highBar, b.close))
    /**
     * ⚠ 只为**最近 display 天**记录状态（递推仍在整个 window 上跑）。
     *
     * 这条 `continue` 必须在**算统计量之前**：`total/norm/avg/support/resistance/profitRatio`
     * 只服务于被记录的那些天，非展示日算完就丢 —— 旧写法把它们写在 `continue` 之前，实测
     * 180 天窗/45 天展示里有 135 天的统计量全部白算（REVIEW-9-PERF §2.1②：display=45 比 display=1 慢 2.27 ms）。
     * 递推所需的只有 `hist`、`minFactor`/`clamped`/`peakSum`（都在这之前完成，口径文案依赖它们）。
     */
    if (i < win.length - display) continue
    __chipStatsDays += 1
    const total = hist.reduce((s, x) => s + x, 0)
    const norm = total > 0 ? hist.map((x) => x / total) : hist
    const avg = total > 0 ? centers.reduce((s, c, x) => s + c * norm[x], 0) : null
    const support = percentilePrice(norm, centers, 0.05)
    const resistance = percentilePrice(norm, centers, 0.95)
    const narrow = support !== null && resistance !== null && (resistance - support) / (high - low) < CHIPS_NARROW_RATIO
    // 最新一根（= 展示日的默认值）用换算后的现价；**历史展示日**用当天收盘价 —— 不得混用（口径字段如实标注）
    const isLatest = i === win.length - 1
    const price = isLatest ? priceUsed : b.close
    const profitRatio = price === null || total <= 0
      ? null
      : norm.reduce((s2, x, idx) => (centers[idx] < price ? s2 + x : s2), 0)
    days.push({
      date: b.date,
      buckets: norm.map((x) => round(x, 8)),
      avgCost: avg === null ? null : round(avg, 4),
      support: support === null ? null : round(support, 4),
      resistance: resistance === null ? null : round(resistance, 4),
      narrow,
      // 与 `profitRatio` 同一个 `price`（上面那行）⇒ 两者永远同源，不许各算一套
      price: price === null ? null : round(price, 4),
      profitRatio: profitRatio === null ? null : round(profitRatio * 100, 2),
      samples: i + 1,
    })
  }
  const latest = days[days.length - 1] ?? null
  const barAligns = latest !== null && latestBarDate !== null && latest.date === latestBarDate
  return {
    ...base,
    days,
    latest,
    // 轴只输出一份（45 天共用同一组档中心）：`round` 也只做一次，不再每天 map 一遍
    centers: centers.map((c) => round(c, 4)),
    bucketCount: buckets,
    bucketWidth: plan.width,
    bucketTarget: plan.target,
    bucketClamped: plan.clamped,
    bucketNote,
    decay,
    decayReason,
    priceUsed: barAligns ? priceUsed : (latest !== null ? null : priceUsed),
    priceSource: barAligns ? (priceSource ?? (latest !== null ? 'close' : null)) : (latest !== null ? 'close' : priceSource),
    barAlignsWithDisplay: barAligns,
    avgCost: latest?.avgCost ?? null,
    support: latest?.support ?? null,
    resistance: latest?.resistance ?? null,
    narrow: latest?.narrow ?? false,
    profitRatio: latest?.profitRatio ?? null,
    methodology:
      (useTurnover
        ? `递推式：chips_t = chips_{t-1} × max(0, 1 − t_t×k) + new_t；` +
          `t_t = 当日换手率 = 成交额 ÷ 流通市值（等价于 成交量 ÷ 流通股本；cap=${cap}）` +
          (mvMode === 'price-scaled'
            ? '，历史流通市值按 floatMv_now × close_t/close_now 代理（假设股本近似不变）。'
            : '，逐日历史流通市值不可得 ⇒ 用当前 floatMv 近似（东财/腾讯市值字段）。')
        : `递推式：chips_t = chips_{t-1} × 0.5^(1/${halfLife}) + new_t（固定半衰期 ${halfLife} 日）—— ${decayReason ?? ''}`) +
      `衰减系数 k=${kFactor}（越大越强调近期筹码；>1 时旧筹码衰减更快）` +
      (clamped ? `；本段出现过 1−t×k < 0 的极端换手，因子已夹到 0（旧筹码全清），实际最小生效因子 ${minFactor.toFixed(4)}` : `；实际最小生效因子 ${Number.isFinite(minFactor) ? minFactor.toFixed(4) : '—'}`) +
      `。新增筹码按${shape === 'triangle' ? '三角形分布（峰在当日均价 (high+low+close)/3）' : '均匀分布'}铺到当日 [low, high]` +
      `（均价均值 ${(peakSum / Math.max(1, win.length)).toFixed(4)}）；` +
      `窗口：用了近 ${samples} 根日线${samples < CHIPS_WINDOW ? `（不足累积窗口 ${CHIPS_WINDOW} 根 ⇒ 历史越短越不准，如实标注）` : ''}（fqt=1 前复权）；` +
      `档数 ${buckets}（自适应：窗口价格区间 ${round(high - low, 4)} 元 ÷ ${buckets} = 档宽 ${plan.width} 元；目标 = 中间价 ${plan.mid} × ${(CHIPS_WIDTH_TARGET_PCT * 100).toFixed(2)}% = ${plan.target} 元；限制 [${CHIPS_BUCKETS_AUTO_MIN}, ${CHIPS_BUCKETS_AUTO_MAX}] 与回包大小上限 ${Math.round(CHIPS_PAYLOAD_MAX_BYTES / 1024)} KB）` +
      `（显示区间裁剪：先按筹码质量 99% 覆盖，再隐去权重低于窗口峰值 20% 的稀疏行；被裁到轴外的权重不显示、也不参与四数统计口径）；支撑/压力 = 筹码累积分布的 P5/P95 价位；平均成本 = Σ(桶价×权重)/Σ权重；盈利比例 = Σ(桶价 < 现价 的权重)/Σ权重；价格空间：fqt=1 前复权（桶价与现价同一空间）；换算因子 ${scaleRaw}（1 = 恒等）；现价来源 ${priceSource ?? '未取到'}（原始价 ${priceRaw ?? '未取到'} × ${scaleRaw}）；"最新一根" = 递推窗口最后一根 ${latestBarDate ?? '—'}：最新一根用换算后的现价，展示日与它不一致时该展示日用当天收盘价，不混用。`,
  }
}
