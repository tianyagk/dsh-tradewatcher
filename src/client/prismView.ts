/**
 * 【棱镜】页的**解释层**（纯函数：参数 → query / 值 → 文本 / 回包 → 判据）。
 *
 * 页面（`PrismPage.tsx`）只渲染这里算出来的东西，不自己拼字符串、不自己判缺失 ——
 * 这与仓库既有页面（`leveragePage` / `fupanView`）同款：可测的部分全在纯函数里。
 *
 * 本文件同时给出**十条验收判据**的实现（页面/回包/源码），每条都配"注入即失败"的口径，
 * 见 `src/client/prismView.test.ts`：
 *   ① 页签在最右（`tabPositionProblems`）
 *   ② 六个块齐全 + 不可算必须给原因（`prismPayloadProblems`）
 *   ③ 注解类文案**一律不上屏**（用户裁决；判据在 `prismView.test.ts`，实现里不留这类文案）
 *   ④ 目标价必须带规则名且可复算（`targetProblems`）
 *   ⑤ 参数必须常驻可见（`paramsVisibleProblems`）
 *   ⑥ 切频率只改参数（`freqParamOnlyProblems`）
 *   ⑦ 10/30 聚合在宿主侧（`aggregateBars`，测试在 `src/host/prism.test.ts`）
 *   ⑧ Stoikov 的 T−t 保护（`stoikovProtectionProblems`）
 *   ⑨ Monte Carlo 假设全部上屏（`mcAssumptionProblems`）
 *   ⑩ 路由永远 200（`src/host/prism.test.ts` 直接打 `prismResponse`）
 */
import {
  PRISM_BLOCK_KEYS,
  PRISM_MIN_SAMPLES,
  type PrismBook,
  PRISM_DEFAULT_PARAMS,
  PRISM_FREQS,
  PRISM_STANCES,
  type PrismBlockKey,
  type PrismBlocks,
  type PrismEdgeBlock,
  type PrismFreq,
  type PrismMcBlock,
  type PrismParams,
  type PrismPayload,
  type PrismStance,
  type PrismStoikovBlock,
} from '../shared/prism.ts'
import { shClockText } from './marketTime.ts'

/** 缺失一律这个字符（不写 0、不写空） */
export const DASH = '—'

/** 频率的中文标签 */
export const PRISM_FREQ_LABEL: Record<PrismFreq, string> = { 5: '5 分钟', 10: '10 分钟', 30: '30 分钟' }

/** 六个块的标题（Kelly / Stoikov 必须带「模拟」） */
export const PRISM_BLOCK_TITLE: Record<PrismBlockKey, string> = {
  bayes: 'Bayes 认知',
  edge: 'Edge 优势',
  spread: 'Spread 价差',
  stoikov: 'Stoikov 模拟保留价',
  kelly: 'Kelly 模拟仓位',
  mc: 'Monte Carlo 风控',
}

/* ────────────────────────────── 参数：常驻行 + query ────────────────────────────── */

/** 参数行（页面必须**常驻显示** `prismParamRowText(row)`，不许只放进悬停/折叠） */
export interface PrismParamRow {
  key: keyof PrismParams
  /** 参数名（公式名允许作标签） */
  label: string
  /** 当前值（已完成格式化，页面直接显示） */
  value: string
  /** 可选的单位/说明（极简：只留单位） */
  unit: string
}

const pct = (x: number, d = 1): string => `${(x * 100).toFixed(d)}%`

/** 全部可调参数的**当前值行**（顺序即渲染顺序；每行都必须上屏） */
export function prismParamRows(p: PrismParams): PrismParamRow[] {
  return [
    { key: 'freq', label: '频率', value: PRISM_FREQ_LABEL[p.freq], unit: '' },
    { key: 'pairA', label: '标的 A', value: p.pairA === '' ? DASH : p.pairA, unit: '' },
    { key: 'pairB', label: '配对 B', value: p.pairB === null ? DASH : p.pairB, unit: '' },
    { key: 'zN', label: 'z 窗口 N', value: String(p.zN), unit: '根' },
    { key: 'zTh', label: '|z| 阈值', value: p.zTh.toFixed(1), unit: '' },
    { key: 'prior', label: '先验 p', value: p.prior.toFixed(2), unit: '' },
    { key: 'evMinBps', label: 'EV 阈值', value: p.evMinBps.toFixed(1), unit: 'bps' },
    { key: 'feeBps', label: '手续费', value: p.feeBps.toFixed(1), unit: 'bps' },
    { key: 'slipBps', label: '滑点', value: p.slipBps.toFixed(1), unit: 'bps' },
    { key: 'latencyMs', label: '延迟', value: String(p.latencyMs), unit: 'ms' },
    { key: 'gamma', label: 'Stoikov γ', value: p.gamma.toFixed(2), unit: '' },
    { key: 'q', label: '模拟库存 q', value: String(p.q), unit: '' },
    { key: 'ttBars', label: 'T−t', value: p.ttBars.toFixed(1), unit: '根' },
    { key: 'kellyFrac', label: 'Kelly 分数', value: pct(p.kellyFrac, 0), unit: '' },
    { key: 'tgtK', label: 'ATR×k 的 k', value: p.tgtK.toFixed(1), unit: '' },
    { key: 'mcRuns', label: 'MC 次数', value: String(p.mcRuns), unit: '次' },
    { key: 'mcFill', label: '成交率', value: pct(p.mcFill, 0), unit: '' },
    { key: 'mcPErr', label: 'p 误差', value: `±${p.mcPErr.toFixed(2)}`, unit: '' },
  ]
}

/** 参数行的可见文本（`标签 值 单位`）—— 页面直接渲染它，断言也锚它 */
export function prismParamRowText(row: PrismParamRow): string {
  return `${row.label} ${row.value}${row.unit === '' ? '' : ` ${row.unit}`}`
}

/**
 * 参数 → query（**唯一**构造点）。
 *
 * 断言 ⑥ 的判据：三个频率构造出来的 query **只差 `freq=` 这一段**（其余逐字相同）——
 * 也就是说切频率只是换参数，没有第二条接口。
 */
export function prismQueryOf(p: PrismParams): string {
  const q: Array<[string, string]> = [
    ['freq', String(p.freq)],
    ['pairA', p.pairA],
    ['pairB', p.pairB ?? ''],
    ['zN', String(p.zN)],
    ['prior', String(p.prior)],
    ['feeBps', String(p.feeBps)],
    ['slipBps', String(p.slipBps)],
    ['latencyMs', String(p.latencyMs)],
    ['evMinBps', String(p.evMinBps)],
    ['zTh', String(p.zTh)],
    ['gamma', String(p.gamma)],
    ['q', String(p.q)],
    ['ttBars', String(p.ttBars)],
    ['kellyFrac', String(p.kellyFrac)],
    ['tgtK', String(p.tgtK)],
    ['mcRuns', String(p.mcRuns)],
    ['mcFill', String(p.mcFill)],
    ['mcPErr', String(p.mcPErr)],
  ]
  return q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
}

/* ────────────────────────────── 值 → 文本 ────────────────────────────── */

export function fmtNum(v: number | null | undefined, digits: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH
  return v.toFixed(digits)
}

/** 价格的小数位随量级走（1300 元 2 位、1 元以下 5 位） */
export function priceDigits(v: number | null | undefined): number {
  if (v === null || v === undefined || !Number.isFinite(v)) return 2
  if (Math.abs(v) >= 100) return 2
  if (Math.abs(v) >= 1) return 3
  return 5
}

export function fmtPrice(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? DASH : v.toFixed(priceDigits(v))
}

export function fmtBps(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? DASH : `${v.toFixed(2)}bps`
}

export function fmtPct(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? DASH : `${v.toFixed(digits)}%`
}

/** p / 概率类数值：三位小数（不带百分号，避免被读成"胜率"式声明） */
export function fmtP(v: number | null | undefined): string {
  return fmtNum(v, 3)
}

/**
 * 推演动作（用户裁决：允许出现「建议买入 / 卖出 / 开仓」；`不下结论` ⇒ 不动作 ——
 * Edge 不达标不许硬给方向）。三态各自一句话，本身就是结论。
 */
export function actionOf(stance: PrismStance): string {
  if (stance === '看多') return '建议买入（模拟开仓）'
  if (stance === '看空') return '建议卖出（模拟）'
  return '不下结论（不动作）'
}

/** 越阈状态（只描述位置，不给挂单价） */
export function spreadStateText(block: PrismBlocks['spread']): string {
  if (!block.available) return DASH
  if (block.beyond === 'upper') return `越上阈（|z| > ${block.threshold}）`
  if (block.beyond === 'lower') return `越下阈（|z| > ${block.threshold}）`
  return `未越阈（|z| ≤ ${block.threshold}）`
}

/** 数据时刻（沿用既有 `shClockText`，不新造时区逻辑） */
export function asOfText(payload: PrismPayload | null): string {
  return payload === null ? DASH : shClockText(payload.asOf)
}

/**
 * 顶部数据行（**看得出数据是否有效**）：`30 分钟 · 6 根（样本不足）` / `30 分钟 · 120 根`。
 *
 * 不再写"（5 分钟聚合 6 根）"这种实现口径；样本不足时**明说**（用户裁决）。
 */
export function dataLine(payload: PrismPayload | null): string {
  if (payload === null) return DASH
  const n = payload.bars.n
  const short = n >= PRISM_MIN_SAMPLES ? '' : '（样本不足）'
  const downgraded = payload.downgrade === null ? '' : ' · 已降频'
  return `${payload.freq} 分钟 · ${n} 根${short}${downgraded}`
}

/** 回退足迹的可见文本（空 = 无回退）：`实际标的 1.600519（已从 116.00148 回退）` */
export function fallbackText(payload: PrismPayload | null): string {
  const f = payload?.fallback ?? null
  if (f === null) return ''
  return `实际标的 ${f.actual}（已从 ${f.requested === '' ? '空' : f.requested} 回退）`
}

/**
 * 断言 ③：回退后**参数框必须显示实际标的**（不是"回退了但显示还是所选的那个"）。
 * 源码锚点：页面从回包取 `payload.params.pairA`，并在 `pairA === ''` 或 `fallback !== null` 时同步。
 */
export function pairASyncProblems(src: string): string[] {
  const bad: string[] = []
  if (!src.includes('const actual = payload.params.pairA')) bad.push('页面没有从回包取实际标的（payload.params.pairA）')
  if (!src.includes('pairA: actual')) bad.push('回退后没有把参数框同步成实际标的')
  if (!src.includes('payload.fallback !== null')) bad.push('回退时没有触发同步（只看首次打开）')
  if (!src.includes('fallbackText(payload)')) bad.push('回退足迹没有上屏（参数区看不到实际标的）')
  return bad
}

/** 样本口径（`n 根 from → to`；缺 from/to 就不写，不编） */
export function barsLine(payload: PrismPayload | null): string {
  if (payload === null) return DASH
  const from = payload.bars.from
  const to = payload.bars.to
  const range = from === null || to === null ? '' : `（${from} → ${to}）`
  return `${payload.bars.n} 根${range}${payload.bars.lastPartial ? ' · 末根未收满' : ''}`
}

/** 盘口口径一句话（五档是否可得 —— 这是"先探索"的可见证据） */
export function bookText(book: PrismBlocks['spread']['book']): string {
  if (!book.available) return `${DASH}${book.reason === null ? '' : `（${book.reason}）`}`
  return `${book.levels} 档 · ${book.source ?? DASH}`
}

/**
 * 「只有价」形态的可见文本：`401.10 · 13:38:00`（`quoteMid` 与它的数据时刻）。
 * 没有 `quoteMid` ⇒ `—`（不拿收盘价凑）。
 */
export function quoteMidText(book: PrismBook): string {
  if (book.quoteMid === null) return DASH
  const at = book.quoteAt === null ? '' : ` · ${shClockText(book.quoteAt)}`
  return `${fmtPrice(book.quoteMid)}${at}`
}

/**
 * 断言 ④：盘口契约（`available:false` **不得**携带 `microPrice`）。
 *
 * 运行时锚点：`emptyBook` / `quoteOnlyBook` / `parseTencentDepthBook` 都走这条判据；
 * 注入"把 mid 塞进 microPrice"⇒ 非空。
 */
export function bookContractProblems(book: PrismBook): string[] {
  const bad: string[] = []
  if (book.available) {
    if (book.microPrice === null) bad.push('available:true 但没有 microPrice')
    if (!(book.levels > 0)) bad.push('available:true 但 levels=0')
    if (book.quoteMid !== null) bad.push('available:true 时 quoteMid 必须为 null（避免把真盘口与只有价混在一起）')
    if (book.bids.length === 0 || book.asks.length === 0) bad.push('available:true 但没有买/卖档')
  } else {
    if (book.microPrice !== null) bad.push('available:false 却携带 microPrice（下游会分不清真盘口与只有价）')
    if (book.levels !== 0) bad.push('available:false 时 levels 必须为 0')
    if (book.quoteMid !== null) {
      if (book.quoteSource === null || book.quoteSource.trim() === '') bad.push('quoteMid 必须带 quoteSource')
      if (book.quoteAt === null) bad.push('quoteMid 必须带 quoteAt（数据时刻）')
      if (!(book.quoteMid > 0)) bad.push('quoteMid 必须是正数')
    }
  }
  return bad
}

/**
 * 断言 ⑥：参数/输入行必须显示**输入名**（可追溯标签，不是注解）。
 *
 * Stoikov 的 `s` 与 Spread 的 `mid` 都可能来自 `micro-price（5 档）` 或 `盘口中点（1 档价）`，
 * 页面必须把来源写出来；只显示数字等于让人猜。注入：删掉任一输入名 ⇒ 非空。
 */
export function inputNameProblems(src: string): string[] {
  const bad: string[] = []
  if (!src.includes('`s：${blocks.stoikov.sSource}`')) bad.push('Stoikov 卡没有显示 s 的输入名（s：micro-price（5 档）/ 盘口中点（1 档价））')
  if (!src.includes('`mid：${blocks.spread.midSource}`')) bad.push('Spread 卡没有显示 mid 的输入名')
  return bad
}

/* ────────────────────────────── 判据（回包层） ────────────────────────────── */

const finite = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)

/** 递归找出回包里"非有限数字"（NaN/Infinity）—— 它们会被渲染成 `NaN`，属于编数 */
function nonFinitePaths(value: unknown, path = '', out: string[] = []): string[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(path === '' ? '(root)' : path)
    return out
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => nonFinitePaths(v, `${path}[${i}]`, out))
    return out
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) nonFinitePaths(v, path === '' ? k : `${path}.${k}`, out)
  }
  return out
}

/**
 * 断言 ②：六个块齐全；不可算 ⇒ 必须给一句原因；可算 ⇒ `samples > 0` 且数值有限。
 *
 * "写 0 冒充"的注入会同时踩两条：块不可算却没有 reason，或块可算但 samples=0。
 * 返回失败原因列表（空 = 通过）。
 */
export function prismPayloadProblems(payload: PrismPayload): string[] {
  const bad: string[] = []
  const keys = Object.keys(payload.blocks) as PrismBlockKey[]
  if (keys.length !== PRISM_BLOCK_KEYS.length || PRISM_BLOCK_KEYS.some((k) => !keys.includes(k))) {
    bad.push(`块集合必须是 ${PRISM_BLOCK_KEYS.join(' / ')}，实得 ${keys.join(' / ')}`)
  }
  for (const key of PRISM_BLOCK_KEYS) {
    const b = payload.blocks[key]
    if (b === undefined) {
      bad.push(`缺少块：${key}`)
      continue
    }
    if (b.available) {
      if (!(typeof b.samples === 'number') || !(b.samples > 0)) bad.push(`${key} 标记为可算但 samples=${String(b.samples)}（用 0 冒充？）`)
    } else if (b.reason === null || b.reason.trim() === '') {
      bad.push(`${key} 不可算却没有给原因`)
    }
  }
  // 数值必须是有限数（NaN/Infinity 会被渲染成 "NaN"）
  for (const p of nonFinitePaths(payload)) bad.push(`回包里有非有限数字：${p}`)
  // 三态结论必须合法；块不可算 ⇒ 必须走"不下结论"
  const edge = payload.blocks.edge
  if (!(PRISM_STANCES as readonly string[]).includes(edge.stance)) bad.push(`edge.stance 非法：${String(edge.stance)}`)
  if (!edge.available && edge.stance !== '不下结论') bad.push('Edge 不可算却给了方向（必须走「不下结论」）')
  for (const t of edge.targets) {
    if (t.rule.trim() === '' || t.ruleLabel.trim() === '') bad.push('目标价缺少规则名（不许只给裸数字）')
    if (t.value !== null && Object.keys(t.inputs).length === 0) bad.push(`目标价 ${t.rule} 没有给输入（不可复算）`)
    if (t.value === null && (t.reason === null || t.reason.trim() === '')) bad.push(`目标价 ${t.rule} 不可算却没有原因`)
  }
  if (edge.stance !== '不下结论' && edge.available && edge.targets.length === 0) bad.push('给了方向却没有目标价（或反之）')
  // MC 假设必须四条齐全
  if (payload.blocks.mc.assumptions.length !== 4) bad.push(`MC 假设必须有 4 条，实得 ${payload.blocks.mc.assumptions.length}`)
  return bad
}

/**
 * 断言 ②/新裁决：三态结论必须由 EV 与阈值决定 —— **EV ≤ 阈值时只能是「不下结论」**。
 *
 * 注入（Edge 不达标仍硬给方向）⇒ 返回非空。
 */
export function stanceProblems(edge: PrismEdgeBlock): string[] {
  const bad: string[] = []
  if (!edge.available) return edge.stance === '不下结论' ? [] : ['Edge 不可算却给了方向']
  if (!finite(edge.evBps) || !finite(edge.p)) return ['Edge 可算但 EV/p 不是有限数']
  const want: PrismStance = (edge.evBps as number) > edge.thresholdBps ? ((edge.p as number) >= 0.5 ? '看多' : '看空') : '不下结论'
  if (edge.stance !== want) bad.push(`结论应为 ${want}（EV ${(edge.evBps as number).toFixed(2)}bps vs 阈值 ${edge.thresholdBps}bps，p ${(edge.p as number).toFixed(3)}），实得 ${edge.stance}`)
  return bad
}

/**
 * 断言 ④：目标价必须**能由页面参数 + 历史数据重算**（规则名 + 输入齐全 + 复算一致）。
 *
 * 注入：把某个目标价换成裸数字（无 rule / 无 inputs / 与规则不符）⇒ 非空。
 */
export function targetProblems(edge: PrismEdgeBlock): string[] {
  const bad: string[] = []
  for (const t of edge.targets) {
    const label = t.ruleLabel === '' ? t.rule : t.ruleLabel
    if (t.rule.trim() === '') bad.push(`${label}：缺规则 id`)
    if (t.ruleLabel.trim() === '') bad.push(`目标价（${t.rule}）：缺规则名（页面不许只给裸数字）`)
    if (t.value === null) {
      if (t.reason === null || t.reason.trim() === '') bad.push(`目标价（${label}）不可算却没有原因`)
      continue
    }
    const close = t.inputs['close']
    const dir = t.inputs['dir']
    if (!finite(close) || !finite(dir)) {
      bad.push(`目标价（${label}）缺少 close/dir 输入 ⇒ 不可复算`)
      continue
    }
    let want: number | null = null
    if (t.rule === 'atr-k') {
      const atr = t.inputs['atr']
      const k = t.inputs['k']
      if (finite(atr) && finite(k)) want = (close as number) + (dir as number) * (k as number) * (atr as number)
    } else if (t.rule === 'hist-p95') {
      const p95 = t.inputs['p95Bps']
      if (finite(p95)) want = (close as number) * (1 + ((dir as number) * (p95 as number)) / 10_000)
    } else {
      bad.push(`目标价规则 ${t.rule} 不在登记表里（无法复算）`)
      continue
    }
    if (want === null) bad.push(`目标价（${label}）的输入不全 ⇒ 不可复算`)
    else if (Math.abs(want - t.value) > Math.max(1e-9, Math.abs(want) * 1e-9)) {
      bad.push(`目标价（${label}）与规则复算不一致：规则=${want}，回包=${t.value}`)
    }
  }
  return bad
}

/**
 * 断言 ⑧：Stoikov 的 `T−t → 0` 保护必须真的生效（`r === s` 且 `protected` 且有原因）。
 *
 * 注入（不保护、照公式给偏离值）⇒ 非空。
 */
export function stoikovProtectionProblems(block: PrismStoikovBlock): string[] {
  const bad: string[] = []
  if (!block.available) return []
  if (block.ttBars < 0.5) {
    if (!block.protected) bad.push(`T−t ${block.ttBars} 根 < 0.5 根但没有触发保护`)
    if (block.reserve !== block.s) bad.push(`T−t→0 时保留价必须夹回 s（r=${String(block.reserve)}，s=${String(block.s)}）`)
    if (block.protectReason === null || block.protectReason.trim() === '') bad.push('保护生效却没有给原因')
  }
  if (block.protected && (block.protectReason === null || block.protectReason.trim() === '')) bad.push('protected=true 却没有原因')
  if (block.reserve !== null && block.s !== null && block.s > 0 && Math.abs(block.reserve - block.s) > 0.2 * block.s + 1e-9) {
    bad.push('保留价偏离超过 20%·s（保护没夹住）')
  }
  return bad
}

/** 断言 ⑨：Monte Carlo 的四条假设必须齐全、有值、有来源（缺一条 ⇒ 非空） */
export function mcAssumptionProblems(mc: PrismMcBlock): string[] {
  const bad: string[] = []
  const want = ['fill', 'slip', 'latency', 'pErr']
  const got = mc.assumptions.map((a) => a.key)
  for (const k of want) if (!got.includes(k)) bad.push(`缺少 MC 假设：${k}（假设必须全部上屏）`)
  if (got.length !== 4) bad.push(`MC 假设应为 4 条，实得 ${got.length} 条`)
  for (const a of mc.assumptions) {
    if (!Number.isFinite(a.value)) bad.push(`MC 假设 ${a.key} 的值不是数字`)
    if (a.label.trim() === '') bad.push(`MC 假设 ${a.key} 缺标签`)
    if (a.source.trim() === '') bad.push(`MC 假设 ${a.key} 缺来源`)
  }
  if (mc.available) {
    if (!(mc.runs >= 10_000)) bad.push(`MC 次数必须 ≥ 10000（实得 ${mc.runs}）`)
    if (!finite(mc.mddP50) || !finite(mc.mddP95)) bad.push('MC 可算但 MDD 分位不是有限数')
    if (!finite(mc.ruinProb)) bad.push('MC 可算但破产概率不是有限数')
  }
  return bad
}

/* ────────────────────────────── 判据（源码层） ────────────────────────────── */

/**
 * 断言 ⑤：参数必须**常驻可见**（值不许只进悬停/折叠/隐藏 class）。
 *
 * 判据锚页面源码的三个事实：`prismParamRows(` 参与渲染、`prismParamRowText(` 输出可见文本、
 * 该文本没被塞进 `title:` 或会被 compact/隐身档隐藏的 class。
 */
export function paramsVisibleProblems(src: string): string[] {
  const bad: string[] = []
  if (!src.includes('prismParamRows(')) bad.push('参数区没有从 prismParamRows() 渲染（参数可能根本没上屏）')
  if (!src.includes('prismParamRowText(')) bad.push('参数行没有用 prismParamRowText() 输出可见文本（值可能只进了属性/悬停）')
  // 值必须是 createElement 的**子节点**（`<span data-param-text>{text}</span>`），不是属性
  if (!src.includes("'data-param-text'")) bad.push('参数值没有独立的可见节点（可能只写进了 title/aria）')
  if (!src.includes('prismParamRowText(props.row)')) bad.push('参数值没有用 prismParamRowText() 渲染成可见文本')
  if (!src.includes('React.createElement(ParamText, { row })')) {
    bad.push('参数行没有用 ParamText 渲染当前值（参数值可能被藏起来）')
  }
  if (/title:\s*(?:rowOf|prismParamRowText|ParamText)/.test(src)) bad.push('参数值被塞进 title（悬停）—— 必须常驻可见')
  if (/className:\s*'tw-(hint|chartnote|empty|caliber)'[^}]*ParamText/.test(src)) {
    bad.push('参数行走的是会被 compact/隐身档隐藏的 class ⇒ 参数不再常驻可见')
  }
  if (!src.includes('data-param')) bad.push('参数行缺少 data-param 锚点（可见性无从断言）')
  return bad
}

/** 断言 ①：页签存在、标签「棱镜」、归属 `prism`、且**在最右** */
export function tabPositionProblems(tabs: ReadonlyArray<{ key: string; label: string; row: string }>): string[] {
  const bad: string[] = []
  const last = tabs[tabs.length - 1]
  if (last === undefined) return ['没有页签（抽不到 tabs 数组）']
  if (last.key !== 'prism') bad.push(`「棱镜」必须在最右（最后一个是 ${last.key}）`)
  if (last.label !== '棱镜') bad.push(`标签必须是「棱镜」（实得「${last.label}」）`)
  if (last.row !== 'prism') bad.push(`归属行必须是 prism（实得 ${last.row}）`)
  if (tabs.filter((t) => t.key === 'prism').length !== 1) bad.push('「棱镜」页签必须恰好一个')
  return bad
}

/** 断言 ⑥：切频率只改参数（不新增接口）。输入三份源码文本 + 三个频率的 query。 */
export function freqParamOnlyProblems(input: {
  rowRoutes: readonly string[]
  apiSrc: string
  routesSrc: string
  queryOf: (freq: PrismFreq) => string
}): string[] {
  const bad: string[] = []
  if (JSON.stringify([...input.rowRoutes]) !== JSON.stringify(['/tradewatcher/prism'])) {
    bad.push(`prism 行只准宣告一条路由（实得 ${JSON.stringify(input.rowRoutes)}）—— 新开接口就会多一条`)
  }
  const apiHits = input.apiSrc.match(/\/tradewatcher\/prism/g) ?? []
  if (apiHits.length !== 1) bad.push(`api.ts 里 prism 路径必须恰好一处（实得 ${apiHits.length}）`)
  if (input.apiSrc.includes('/tradewatcher/prism/')) bad.push('api.ts 里出现了 prism 的子路径（新开接口）')
  const routeHits = input.routesSrc.match(/path: '\/tradewatcher\/prism'/g) ?? []
  if (routeHits.length !== 1) bad.push(`routes.ts 里 prism 路由必须恰好一条（实得 ${routeHits.length}）`)
  if (input.routesSrc.includes("path: '/tradewatcher/prism/")) bad.push('routes.ts 里出现了 prism 的子路径（新开接口）')
  const stripped = PRISM_FREQS.map((f) => input.queryOf(f).replace(/freq=[^&]*/, ''))
  if (new Set(stripped).size !== 1) bad.push(`切频率只许改 freq 参数（实得 ${JSON.stringify(stripped)}）`)
  return bad
}

/**
 * 断言 ⑨（源码层）：Monte Carlo 的四条假设必须**逐条渲染**（截断/摘要 ⇒ 必败）。
 */
export function assumptionsOnScreenProblems(src: string): string[] {
  const bad: string[] = []
  if (!src.includes('.assumptions.map(')) bad.push('MC 假设没有逐条渲染（假设必须全部上屏）')
  if (!src.includes('假设 ')) bad.push('MC 假设缺少可见标签（假设要能被读到）')
  if (/assumptions\.slice\(\s*0\s*,/.test(src)) bad.push('MC 假设被截断渲染（必须全部上屏）')
  return bad
}

/** 参数默认值的完整键集（页面初始化用；也防"新加参数忘了给默认值"） */
export const PRISM_PARAM_KEYS = Object.keys(PRISM_DEFAULT_PARAMS) as Array<keyof PrismParams>
