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

export interface PrismInputs {
  positions: string
  quotes: string
  news: PrismNewsItem[]
  skeleton: string
}

export interface PrismPipelineDeps {
  get: (name: string) => unknown
  now?: () => number
  signal?: AbortSignal
}

const compileInput = (inputs: PrismInputs): string => {
  const news = inputs.news.slice(0, 30).map((n) => `- ${n.time} ${n.text}`).join('\n')
  return [
    '【研判骨架】',
    inputs.skeleton.trim() || '—',
    '【真实持仓（只读）】',
    inputs.positions || '—',
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
  const resolved = resolvePrismModel(deps.get)
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
          '\n最后另起一行输出一个 ```json 代码块，字段：' +
          '{"limits":{"singlePct":数字或null,"totalPct":数字或null,"note":"仓位上限依据"},' +
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
  }
  await store.saveRun(run)
  return run
}
