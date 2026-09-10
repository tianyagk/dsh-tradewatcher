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
  execute(args: Record<string, unknown>, exec?: { signal?: AbortSignal }): Promise<unknown>
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
