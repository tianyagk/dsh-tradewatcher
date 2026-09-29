/**
 * 路由错误语义。
 *
 * 此前所有路由异常一律回 `400 {error}`：上游（东财/腾讯/新浪）被限流或连接被掐断时
 * 也是 400 —— 客户端与排障都把它读成「我的请求写错了」，而真实原因是**服务端暂时不可用**，
 * 应当稍后重试而不是改参数。这里把三类混在一起的失败拆开：
 *
 *   400 请求本身有问题（secid/scope/sort 非法、JSON 解析失败）
 *   413 请求体过大
 *   503 上游不可用（熔断中、连接被关闭、超时、上游 5xx、上游返回非 JSON）
 *   500 其它未归类错误（本插件的 bug）
 *
 * 路由内已知的客户端错误用 HttpError 显式声明状态码；其余按消息模式归类，
 * 避免为历史抛错点逐个改造而漏掉分支。
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
