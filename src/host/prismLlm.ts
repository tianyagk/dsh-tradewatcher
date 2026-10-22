/**
 * 棱镜的模型调用薄封装（批次 1+2）。
 *
 * - 服务从 `ctx.get('llm')` 取（宿主 ctx 是 Proxy，未 inject 的属性直接抛 ⇒ 必须 try/catch + 判空）；
 * - 模型取 `agentDefaultModel.currentSelection()`（同样 try/catch）；
 * - **只调用一次，不自动重试**（失败留痕，避免刷 token）。
 */
import type { PrismModelInfo } from '../shared/prism.ts'

export interface LlmStreamChunk {
  type?: string
  text?: string
  [k: string]: unknown
}

export type LlmTextBlock = { type: 'text'; text: string }

export interface LlmStreamFace {
  stream(options: {
    provider: string
    model: string
    /** 真实契约：`GenerateOptions.messages` 的 content 是 **ContentBlock[]**，不是字符串 */
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: LlmTextBlock[] }>
    system?: string
    reasoningEffort?: string
    maxTokens?: number
  }): AsyncIterable<LlmStreamChunk>
}

export interface StreamChunkSummary {
  type: string
  keys: string[]
}

export interface StreamResult {
  text: string | null
  error: string | null
  /** 前 3 个原始 chunk 的 type + 键名（失败诊断用；不携带内容） */
  chunks: StreamChunkSummary[]
}

export interface ResolvedModel {
  info: PrismModelInfo
  llm: LlmStreamFace | null
}

/** 解析 llm + 默认模型（任一缺失都给原因，不抛） */
export function resolvePrismModel(get: (name: string) => unknown): ResolvedModel {
  let llm: LlmStreamFace | null = null
  let info: PrismModelInfo = { provider: null, model: null, error: null }
  try {
    const raw = get('llm') as LlmStreamFace | undefined
    if (raw !== undefined && raw !== null && typeof raw.stream === 'function') llm = raw
    else info = { provider: null, model: null, error: '宿主没有 llm 服务（未注入/未安装适配器）' }
  } catch (error) {
    info = { provider: null, model: null, error: `llm 服务不可用（${String(error).slice(0, 80)}）` }
  }
  try {
    const sel = get('agentDefaultModel') as { currentSelection?: () => { provider?: unknown; model?: unknown } } | undefined
    const picked = sel?.currentSelection?.()
    if (typeof picked?.provider === 'string' && typeof picked?.model === 'string') {
      info = { ...info, provider: picked.provider, model: picked.model, error: info.error }
    } else if (info.error === null) {
      info = { ...info, error: '没有默认模型（agentDefaultModel.currentSelection 为空）' }
    }
  } catch (error) {
    info = { ...info, error: `默认模型不可读（${String(error).slice(0, 80)}）` }
  }
  return { info, llm }
}

/** 一次流式调用：拼接 `text-delta`；失败返回错误原文，不重试 */
export async function streamText(
  llm: LlmStreamFace,
  model: { provider: string; model: string },
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  system: string | undefined,
  signal?: AbortSignal,
  maxTokens?: number,
): Promise<StreamResult> {
  // 真实契约（dsh-llm/types）：`content` 必须是 ContentBlock[]；传字符串会让适配器
  // `message.content.some(...)` 抛 TypeError，运行时把它变成 finish(error) 空流（0 chunk / 0ms）。
  const wireMessages = messages.map((m) => ({
    role: m.role,
    content: [{ type: 'text' as const, text: m.content }],
  }))
  let out = ''
  let reasoningDeltas = 0
  const chunks: StreamChunkSummary[] = []
  let finishError: string | null = null
  try {
    const stream = llm.stream({
      provider: model.provider,
      model: model.model,
      messages: wireMessages,
      ...(system === undefined ? {} : { system }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    })
    for await (const chunk of stream) {
      signal?.throwIfAborted()
      if (chunks.length < 3) {
        const c = chunk as Record<string, unknown>
        const type = typeof c['type'] === 'string' ? c['type'] : '(no type)'
        chunks.push({ type, keys: Object.keys(c) })
      }
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
      if (chunk.type === 'reasoning-delta') reasoningDeltas += 1
      if (chunk.type === 'finish') {
        const reason = (chunk as { reason?: { kind?: unknown; failure?: { code?: unknown; message?: unknown } } }).reason
        if (reason !== undefined && (reason.kind === 'error' || reason.kind === 'aborted')) {
          const failure = reason.failure
          const code = typeof failure?.code === 'string' ? failure.code : ''
          const message = typeof failure?.message === 'string' ? failure.message : '上游未给 message'
          finishError = `模型流结束于 ${String(reason.kind)}${code === '' ? '' : ` [${code}]`}：${message}`
        }
      }
    }
    if (out.trim() === '') {
      return {
        text: null,
        error: finishError ?? `模型返回空文本（0 个 text-delta，reasoning-delta ${reasoningDeltas} 个，chunk 数 ${chunks.length}）`,
        chunks,
      }
    }
    return { text: out.trim(), error: finishError, chunks }
  } catch (error) {
    return { text: null, error: `模型调用失败（${String(error).slice(0, 120)}）`, chunks }
  }
}
