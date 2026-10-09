/**
 */
export class HttpError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/** 上游不可用的消息特征（em.ts / tencent.ts / sina.ts 的抛错口径） */
const UPSTREAM_RE =
  /熔断|上游暂时不可用|半开探测|HTTP \d{3} from |non-JSON reply from |UND_ERR|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket|fetch failed|aborted|abort|超时|timeout/i

/** 客户端请求有问题的消息特征（历史抛错点未改成 HttpError 时的兜底） */
const BAD_REQUEST_RE = /非法|不合法|必须|应为|不支持|无效|缺失|不能为空/

export function httpStatusOf(error: unknown): number {
  if (error instanceof HttpError) return error.status
  const message = error instanceof Error ? error.message : String(error)
  if (/请求体过大/.test(message)) return 413
  if (BAD_REQUEST_RE.test(message)) return 400
  if (UPSTREAM_RE.test(message)) return 503
  return 500
}

/** 503 时给客户端的建议重试秒数（无可用信息则 null，不加该响应头） */
export function retryAfterSecondsOf(error: unknown, minutesLeft: number): number | null {
  if (httpStatusOf(error) !== 503) return null
  return Math.max(5, Math.round(minutesLeft * 60))
}
