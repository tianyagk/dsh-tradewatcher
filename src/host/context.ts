/**
 * Structural faces of the host services dsh-tradewatcher consumes. This plugin
 * resolves outside the DSH monorepo's single cordis instance, so the upstream
 * `declare module '@deepseek-ai/cordis'` augmentations do not reliably reach
 * this Context — the members below mirror the actual runtime shapes (the same
 * approach dsh-better-sidebar and ecosystem plugins take). The real `ctx`
 * passed by the loader satisfies these structurally.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** The web runtime face (`ctx.webRuntime.trustedHosts` — the /api gateway's trust source). */
export interface PluginWebRuntime {
  trustedHosts: readonly string[]
}

/** One named webserver route (mirror of @deepseek-ai/dsh-host-webserver WebRoute). */
export interface PluginWebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** The webserver service face (`ctx.webServer.register`). */
export interface PluginWebServer {
  register(route: PluginWebRoute): () => void
}

/**
 * Structural face of `@deepseek-ai/dsh-tools` tool definitions. The host only
 * reads these properties (schema + execute + render), so a plain object
 * literal satisfies it — same approach the starter plugin takes.
 */
export interface PluginToolDefinition {
  name: string
  description: string
  /** Full JSON Schema for the tool arguments (object root). */
  parameters: Record<string, unknown>
  output: {
    /** JSON Schema for the canonical return value. */
    schema: Record<string, unknown>
    /** Pure projection from args + value to model-facing content blocks. */
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>
  }
  execute(args: Record<string, unknown>, exec?: PluginToolExec): Promise<unknown>
}

/**
 * 工具执行上下文的结构面（`@deepseek-ai/dsh-tools` 的 ToolRunContext 子集）。
 * 只声明本插件真正读的字段：
 *   - `signal`：取消信号（写操作应在长耗时前先看它）；
 *   - `agent.id`：**会话 id**，写操作的 `by` 字段用它标注"这次是谁写的"（P0-11）。
 *     真实 `Agent` 的 id 是 `SessionId`（见 dsh-agent 的 types.d.ts），此处只当作
 *     不透明字符串 —— 不引入对 dsh-agent 的类型依赖。
 */
export interface PluginToolExec {
  signal?: AbortSignal
  agent?: { id?: unknown }
}

/** The cordis `tools` service face: register returns a disposer. */
export interface PluginToolRuntime {
  register(def: PluginToolDefinition): () => void
}

/** One system-prompt section registration (returns a disposer). */
export interface PluginSystemPrompt {
  section(opts: { name: string; order: number; text: () => string }): () => void
}

/** The host context face this plugin's host half reads. */
export interface PluginContext {
  webServer: PluginWebServer
  webRuntime: PluginWebRuntime
  /** Register a lifecycle callback (DSH-vendored cordis). */
  effect(fn: () => void | (() => void), label?: string): void
  /** Optional capabilities — resolved via ctx.get, never injected. */
  get(name: 'tools'): PluginToolRuntime | undefined
  get(name: 'systemPrompt'): PluginSystemPrompt | undefined
  get(name: string): unknown
}

/** Minimal logger used across host modules. */
export function log(...parts: unknown[]): void {
  console.log('[tradewatcher]', ...parts)
}
