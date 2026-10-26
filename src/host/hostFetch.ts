/**
 * 低层**单主机取文本** helper（H1）：`src/host` 里唯一允许裸 `fetch(` 的文件之一。
 *
 * 为什么单独一个文件、而不是塞进 `http.ts`：`http.ts` 被 `degrade.ts` import，
 * 而 `degrade.ts` 又被 `breakerFetch.ts` import —— 把 `withHostBreaker` 反向引进 `http.ts`
 * 会立刻成环（`degrade.ts` 文件头专门写了这条）。所以低层取数放在这个**谁都不 import**的叶子里。
 *
 * 语义：
 *   · 每一次请求都过 `withHostBreaker(host)`（熔断/半开/记账三件事，见 breakerFetch.ts）；
 *   · 熔断冷却或半开已有探针 ⇒ **不发请求**，抛 `breaker-open: <host>`（调用方据此走兜底并如实报"冷却中"）；
 *   · HTTP 非 2xx ⇒ 抛 `HTTP <status> from <host>`（与非 2xx 的记账口径一致）；
 *   · 返回**文本**。⚠ 腾讯行情是 GBK：本函数按 UTF-8 解，中文名会变 U+FFFD，
 *     但**数值/代码是 ASCII，逐字节不变**。调用方只许用它读数值字段，不许把文本当中文展示。
 */
import { UpstreamCoolingError, withHostBreaker } from './breakerFetch.ts'

/** 熔断打开时的**约定错误**（消息固定 `breaker-open: <host>`，便于日志与断言） */
export class BreakerOpenError extends Error {
  readonly host: string

  constructor(host: string) {
    super(`breaker-open: ${host}`)
    this.name = 'BreakerOpenError'
    this.host = host
  }
}

export interface FetchTextHostOptions {
  referer?: string
  origin?: string
  ua?: string
  accept?: string
  timeoutMs?: number
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

/** 单主机 GET → 文本（内部过熔断器；熔断打开抛 `breaker-open: <host>`） */
export async function fetchTextHost(host: string, url: string, opts: FetchTextHostOptions = {}): Promise<string> {
  const headers: Record<string, string> = { 'user-agent': opts.ua ?? DEFAULT_UA }
  if (opts.referer !== undefined) headers['referer'] = opts.referer
  if (opts.origin !== undefined) headers['origin'] = opts.origin
  if (opts.accept !== undefined) headers['accept'] = opts.accept
  // 裸 fetch 只出现在这一行（H1 白名单按**所在函数**登记：`hostFetch.ts` / `fetchTextHost`）
  const run = async (): Promise<Response> => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000), redirect: 'follow' })
    return res
  }
  let res: Response
  try {
    res = await withHostBreaker(host, run)
  } catch (error) {
    // 冷却/半开探针占用：本轮**没发请求**，用约定消息告诉调用方（不是"上游失败"）
    if (error instanceof UpstreamCoolingError) throw new BreakerOpenError(host)
    throw error
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`)
  return await res.text()
}
