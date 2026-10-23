/**
 * 棱镜研判管线（批次 2）：4 路并行分析（A股宏观 / 外盘 / 大宗 / 信息面）+ 1 次汇总。
 *
 * 输入：真实持仓（只读，来自既有持仓核算）、`prism-skeleton.md`、金十 24h 新闻、
 * 本插件行情摘要（既有行情链，**不接新源**）。
 * 失败：该路留痕（`error`）并继续；**不自动重试**。结果落 `prism-runs.json`。
 */
import {
  PRISM_ANALYSIS_META,
  type PrismAnalysis,
  type PrismDecision,
  type PrismNewsItem,
  type PrismRun,
} from '../shared/prism.ts'
import type { PrismStore } from './prismStore.ts'
import { beijingIsoOf, dayOf } from './time.ts'
import { resolvePrismModel, streamText, type LlmStreamFace } from './prismLlm.ts'
import { parseDecisionDetailed } from './prismAccount.ts'
import { createHash } from 'node:crypto'
import { canonical } from './backup.ts'

export interface PrismInputs {
  positions: string
  quotes: string
  /** 账户快照：总资产/现金/持仓市值/仓位/可买额度/当日成交笔数/未成交挂单（数字+单位） */
  account: string
  news: PrismNewsItem[]
  skeleton: string
  /** 行业暴露 + 单票权重（P-10；无数据时说明，不猜行业） */
  exposure?: string
}

export interface PrismPipelineDeps {
  get: (name: string) => unknown
  /** 页面配置的模型；缺省用 agentDefaultModel */
  model?: { provider: string; model: string } | null
  now?: () => number
  signal?: AbortSignal
}

export const ACCOUNT_PROMPT_FIELDS = ['总资产：', '现金：', '持仓市值：', '当前仓位占比：', '可买额度：', '当日已成交笔数：', '未成交挂单：'] as const

/** 决策自检：orders 为空必须给 note（否则"为什么不下单"只存在汇总里） */
export function decisionProblems(decision: PrismDecision | null): string[] {
  if (decision === null) return ['decision 为 null']
  const bad: string[] = []
  const note = decision.note ?? ''
  if (note.trim() === '') bad.push('note 为空')
  if (decision.orders.length === 0) {
    if (!/买|加仓|建仓/.test(note)) bad.push('orders=[] 但 note 未说明不买/不加仓')
    if (!/卖|减仓|清仓|止损/.test(note)) bad.push('orders=[] 但 note 未说明不卖/减仓/止损')
  }
  if (decision.limits.singlePct === null || decision.limits.totalPct === null) bad.push('limits 有空值')
  return bad
}

/** 构建注入的版本；测试直跑（无 esbuild define）回落 dev，禁止手写版本常量 */
export function prismCodeVersion(): string {
  try { return typeof __TW_VERSION__ === 'string' ? __TW_VERSION__ : 'dev' } catch { return 'dev' }
}

/** 骨架 + settings 参数（剔除 lastFired）的全 sha256；改配置即变，跨日不变 */
export function mandateHashOf(skeleton: string, settings: Record<string, unknown>): string {
  const params: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(settings)) if (k !== 'lastFired') params[k] = v
  return createHash('sha256').update(canonical({ skeleton, params })).digest('hex')
}

const compileInput = (inputs: PrismInputs): string => {
  const news = inputs.news.slice(0, 30).map((n) => `- ${n.time} ${n.text}`).join('\n')
  return [
    '【研判骨架】',
    inputs.skeleton.trim() || '—',
    '【账户快照（模拟盘，只读；数字均带单位）】',
    inputs.account || '—（未取到账户快照）',
    '【真实持仓（只读）】',
    inputs.positions || '—',
    '【行业暴露（市值 ÷ 总资产；未穿透单列）】',
    inputs.exposure || '—（未取到行业归属）',
    '【行情摘要】',
    inputs.quotes || '—',
    '【金十快讯（24h）】',
    news || '—（24h 内没有取到新闻）',
  ].join('\n')
}

/** 4 路并行 + 1 汇总；任何一路失败只留痕 */
export async function runPrismAnalysis(
  store: PrismStore,
  slot: string,
  inputs: PrismInputs,
  deps: PrismPipelineDeps,
): Promise<PrismRun> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const resolved = resolvePrismModel(deps.get, deps.model)
  const base: PrismRun = {
    slot,
    day: dayOf(startedAt),
    at: beijingIsoOf(startedAt),
    reports: [],
    startedAt,
    finishedAt: null,
    analyses: PRISM_ANALYSIS_META.map((m) => ({ key: m.key, label: m.label, text: null, error: null })),
    summary: null,
    decision: null,
    error: null,
    codeVersion: prismCodeVersion(),
    mandateHash: mandateHashOf(store.skeleton(), store.settings() as unknown as Record<string, unknown>),
  }
  if (resolved.llm === null || resolved.info.provider === null || resolved.info.model === null) {
    const run: PrismRun = {
      ...base,
      finishedAt: now(),
      error: resolved.info.error ?? '模型不可用',
      decision: null,
      analyses: base.analyses.map((a) => ({ ...a, error: resolved.info.error ?? '模型不可用' })),
    }
    await store.saveRun(run)
    return run
  }
  const llm = resolved.llm as LlmStreamFace
  const model = { provider: resolved.info.provider, model: resolved.info.model }
  const context = compileInput(inputs)
  const analyses: PrismAnalysis[] = await Promise.all(
    PRISM_ANALYSIS_META.map(async (meta) => {
      const result = await streamText(
        llm,
        model,
        [{ role: 'user', content: `${context}\n\n【任务】${meta.prompt}` }],
        '你是严谨的市场研判助手。只依据给定材料，缺失就写 — 并给一句原因；不写免责声明。',
        deps.signal,
      )
      return { key: meta.key, label: meta.label, text: result.text, error: result.error }
    }),
  )
  const usable = analyses.filter((a) => a.text !== null)
  let summary: string | null = null
  let summaryError: string | null = null
  if (usable.length === 0) {
    summaryError = '四路分析都没有产出 ⇒ 汇总跳过'
  } else {
    const digest = usable.map((a) => `【${a.label}】\n${a.text}`).join('\n\n')
    const res = await streamText(
      llm,
      model,
      [{
        role: 'user',
        content: `${context}\n\n【四路结论】\n${digest}\n\n【任务】把四路结论汇总成 5 条以内的要点，指出分歧与需要盯的变量。` +
          '\n必须依据【账户快照】计算仓位上限；正常应当给出 singlePct/totalPct，确实无法计算时才用 null 并在 limits.note 说明原因。' +
          '\n【强制·风险暴露】必须先判断是否需要降低风险暴露（减仓/止损/清仓），给出结论与理由；若判断不减，必须写明为什么满仓是合理的。' +
          '\n【强制·双侧】orders 允许卖单，卖单字段同样是 {secid, side:\'sell\', price, shares, reason}；不能只考虑买入侧。' +
          '\n【强制·空单说明】orders 为空时，note 必须分两段：「不买的理由」与「不卖的理由」；缺一段即视为不合格。' +
          '\n最后另起一行输出一个 ```json 代码块，字段：' +
          '{"note":"本轮决策理由（一句话；orders 为空时必须同时说明不买与不卖）",' +
          '"limits":{"singlePct":数字或null,"totalPct":数字或null,"byIndustry":{"行业":数字},"note":"仓位上限依据"},' +
          '"orders":[{"secid":"1.600519","side":"buy|sell","price":数字,"shares":整百,"reason":"原因"}],' +
          '"cancel":["订单id"]}。严格 JSON（不得注释、尾逗号、额外文字）；没有挂单就输出空数组；不要输出别的 JSON。',
      }],
      '你是严谨的市场研判助手。只依据给定材料，缺失就写 — 并给一句原因；不写免责声明。',
      deps.signal,
    )
    summary = res.text
    summaryError = res.error
  }
  const parsed = parseDecisionDetailed(summary)
  const decision: PrismDecision | null = parsed.decision
    ?? (summary === null
      ? null
      : { limits: { singlePct: null, totalPct: null, note: null }, orders: [], cancel: [], rejects: [], parseError: parsed.parseError })
  const run: PrismRun = {
    slot,
    day: dayOf(startedAt),
    at: beijingIsoOf(startedAt),
    reports: analyses.map((a) => ({ role: a.label, text: a.text, error: a.error })),
    startedAt,
    finishedAt: now(),
    analyses,
    summary,
    decision,
    error: summaryError,
    codeVersion: base.codeVersion,
    mandateHash: base.mandateHash,
  }
  await store.saveRun(run)
  return run
}
