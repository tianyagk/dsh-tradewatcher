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

export interface LlmStreamFace {
  stream(options: {
    provider: string
    model: string
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
    system?: string
    maxTokens?: number
  }): AsyncIterable<LlmStreamChunk>
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
): Promise<{ text: string | null; error: string | null }> {
  let out = ''
  try {
    const stream = llm.stream({
      provider: model.provider,
      model: model.model,
      messages,
      ...(system === undefined ? {} : { system }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    })
    for await (const chunk of stream) {
      signal?.throwIfAborted()
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    }
    return { text: out.trim() === '' ? null : out.trim(), error: out.trim() === '' ? '模型返回空文本' : null }
  } catch (error) {
    return { text: null, error: `模型调用失败（${String(error).slice(0, 120)}）` }
  }
}
