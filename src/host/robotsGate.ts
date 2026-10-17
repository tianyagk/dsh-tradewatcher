/**
 * `robots.txt` 门禁 + **每主机请求预算**（用户口径 v0.89.0）。
 *
 * 两条纪律（写死在代码里，靠断言与注入守住）：
 *   ① **先取 `robots.txt`，`Disallow` 的路径一律不发请求**（只记录原因）；
 *      —— 解析支持 `User-agent` 分组、`Allow`/`Disallow`、通配符 `*` 与结尾锚点 `$`；
 *      —— 命中多条时取**最长模式**（robots 规范里的"最具体优先"）；
 *      —— `robots.txt` 取不到（404/网络失败）⇒ 视为"无声明限制"，但把这件事记进结果，不假装读过规则。
 *   ② **同一主机 ≤ 5 次/小时**（`HOST_BUDGET_MAX`），超限 ⇒ 不发请求并如实说明（等窗口或走别的源）。
 *
 * 为什么单独一层：宏观源换过好几轮（Yahoo 403 + 服务条款禁止自动化、FRED 链路未确认），
 * 每次都靠人肉记住"这条能不能打"不现实 ⇒ 把规矩变成**可执行的代码**：谁要发请求，先过这一层。
 * 计数**落盘**（`macro-log.json` 的 `req`）⇒ 进程重启不会把预算重置成 5。
 */
import type { MissingField } from '../shared/model.ts'
import { withHostBreaker } from './breakerFetch.ts'

/** 每主机每小时的请求上限 */
export const HOST_BUDGET_MAX = 5
/** 预算窗口 */
export const HOST_BUDGET_WINDOW_MS = 60 * 60_000
/** `robots.txt` 缓存时长（同一进程内） */
const ROBOTS_TTL_MS = 24 * 60 * 60_000

export interface RobotsRule {
  allow: boolean
  pattern: string
}

/** 从 `robots.txt` 文本里挑出适用于本 UA 的规则（含 `*` 分组；多组时取 UA 匹配更具体的那组） */
export function parseRobots(text: string, ua = 'dsh-tradewatcher'): { rules: RobotsRule[]; crawlDelayMs: number | null } {
  interface Group { agents: string[]; rules: RobotsRule[]; crawlDelay: number | null }
  const groups: Group[] = []
  let cur: Group | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (line === '') continue
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line)
    if (m === null) continue
    const field = m[1].toLowerCase()
    const value = m[2].trim()
    if (field === 'user-agent') {
      // 新的一组从"上一个 UA 组已经有规则"时开始（robots 里 `User-agent` 连续两行 = 同组）
      if (cur === null || cur.rules.length > 0) {
        cur = { agents: [], rules: [], crawlDelay: null }
        groups.push(cur)
      }
      cur.agents.push(value.toLowerCase())
    } else if (cur !== null && (field === 'disallow' || field === 'allow')) {
      if (value !== '') cur.rules.push({ allow: field === 'allow', pattern: value })
    } else if (cur !== null && field === 'crawl-delay') {
      const n = Number(value)
      cur.crawlDelay = Number.isFinite(n) ? n : null
    }
  }
  const mine = ua.toLowerCase()
  const score = (agents: string[]): number => agents.reduce((best, a) => (a === '*' ? Math.max(best, 1) : mine.includes(a) ? Math.max(best, 2) : best), 0)
  const pick = groups.filter((g) => score(g.agents) > 0).sort((a, b) => score(b.agents) - score(a.agents))[0]
  return { rules: pick?.rules ?? [], crawlDelayMs: pick?.crawlDelay === null || pick?.crawlDelay === undefined ? null : pick.crawlDelay * 1000 }
}

/** robots 模式匹配（支持 `*` 通配与结尾 `$` 锚点） */
export function robotsPatternMatch(pattern: string, pathAndQuery: string): boolean {
  if (pattern === '') return false
  const anchored = pattern.endsWith('$')
  const body = anchored ? pattern.slice(0, -1) : pattern
  const escaped = body.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*')
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(pathAndQuery)
}

/** 判定某路径是否被允许（最长模式优先；无规则 ⇒ 允许，并说明是"无规则"） */
export function robotsAllows(rules: readonly RobotsRule[], pathAndQuery: string): { allowed: boolean; by: string } {
  let best: RobotsRule | null = null
  for (const r of rules) {
    if (!robotsPatternMatch(r.pattern, pathAndQuery)) continue
    if (best === null || r.pattern.length > best.pattern.length) best = r
  }
  if (best === null) return { allowed: true, by: 'no-rule' }
  return { allowed: best.allow, by: `${best.allow ? 'allow' : 'disallow'} ${best.pattern}` }
}

const robotsCache = new Map<string, { rules: RobotsRule[]; note: string; at: number }>()

/** **仅供测试**：清空 robots 缓存（生产里 24h 缓存是对的；用例要换一份 robots 时必须显式清） */
export function __resetRobotsCache(): void {
  robotsCache.clear()
}

/** 取（并缓存）某主机的 robots 规则；取不到 ⇒ 视为无声明限制，但把原因带出来 */
export async function robotsRules(host: string): Promise<{ rules: RobotsRule[]; note: string }> {
  const hit = robotsCache.get(host)
  if (hit !== undefined && Date.now() - hit.at < ROBOTS_TTL_MS) return { rules: hit.rules, note: hit.note }
  let rules: RobotsRule[] = []
  let note = ''
  try {
    const res = await withHostBreaker(`${host}/robots`, () =>
      fetch(`https://${host}/robots.txt`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; dsh-tradewatcher/1.0)' }, signal: AbortSignal.timeout(8000) }),
    )
    if (res.ok) {
      const parsed = parseRobots(await res.text())
      rules = parsed.rules
      note = `robots 已读（${rules.length} 条规则${parsed.crawlDelayMs === null ? '' : `，Crawl-delay ${parsed.crawlDelayMs / 1000}s`}）`
    } else {
      note = `robots HTTP ${res.status} ⇒ 无声明限制（照发，但记录在案）`
    }
  } catch (error) {
    note = `robots 取不到（${String(error).slice(0, 60)}）⇒ 无声明限制（照发，但记录在案）`
  }
  robotsCache.set(host, { rules, note, at: Date.now() })
  return { rules, note }
}

/** 每主机请求预算（进程内 + 由调用方持久化 `req` 供重启后继续计数） */
export class HostBudget {
  /** ⚠ 不用"构造器参数属性"：`node --experimental-strip-types` 只剥类型，不支持需要转换的语法 */
  private readonly req: Record<string, number[]>

  constructor(req: Record<string, number[]> = {}) {
    this.req = req
  }

  /** 该主机在窗口内已用次数 */
  used(host: string, now = Date.now()): number {
    return (this.req[host] ?? []).filter((t) => now - t < HOST_BUDGET_WINDOW_MS).length
  }

  /** 能不能发（不改状态） */
  canSpend(host: string, now = Date.now()): boolean {
    return this.used(host, now) < HOST_BUDGET_MAX
  }

  /** 记一次（超限也记，便于诊断；但调用方必须先问 `canSpend`） */
  spend(host: string, now = Date.now()): void {
    const kept = (this.req[host] ?? []).filter((t) => now - t < HOST_BUDGET_WINDOW_MS)
    kept.push(now)
    this.req[host] = kept
  }

  /** 清空全部账本（**测试钩子用**：同一进程内连跑用例时不希望撞 5 次/小时上限） */
  clear(): void {
    for (const host of Object.keys(this.req)) delete this.req[host]
  }

  /** 导出（落盘） */
  snapshot(): Record<string, number[]> {
    const now = Date.now()
    const out: Record<string, number[]> = {}
    for (const [host, times] of Object.entries(this.req)) {
      const kept = times.filter((t) => now - t < HOST_BUDGET_WINDOW_MS)
      if (kept.length > 0) out[host] = kept
    }
    return out
  }
}

/**
 * 过门禁的 GET（**宏观链路四条全走它**：新浪 `globalbd_us10yt/DINIW`、美国财政部日频收益率曲线、
 * ECB 欧元/美元、东财交叉核对 —— 缺一条就等于门禁没覆盖）：
 *   ① 读 robots ⇒ 被 Disallow 的路径**零请求**，直接返回原因；
 *   ② 查预算 ⇒ 超 5 次/小时**零请求**，直接返回原因；
 *   ③ 通过 ⇒ `budget.spend(host)` 记账后走该主机的熔断键取数。
 *
 * ⚠ 断言（`globalFlow.test.ts` ⑧/⑨）：宏观块里**不许出现任何裸 `fetch(`**（结构检查，不是字符串包含），
 * 四条主机的 URL 必须各自出现在 `gatedFetch(` 调用里；成功一次 ⇒ `req` 计数 +1（REVIEW-4-RISK I14/I16/I17）。
 */
export async function gatedFetch(url: string, opts: { budget: HostBudget; headers?: Record<string, string>; timeoutMs?: number; host?: string }): Promise<
  | { ok: true; res: Response; note: string }
  | { ok: false; note: string; missing: MissingField }
> {
  const u = new URL(url)
  const host = opts.host ?? u.host
  const pathAndQuery = `${u.pathname}${u.search}`
  const robots = await robotsRules(host)
  const verdict = robotsAllows(robots.rules, pathAndQuery)
  if (!verdict.allowed) {
    const note = `${host} 的 robots.txt 禁止该路径（${verdict.by}）⇒ 按规矩不发请求`
    return { ok: false, note, missing: { what: `宏观源 ${host}${u.pathname}`, why: 'no-source', note } }
  }
  if (!opts.budget.canSpend(host)) {
    const note = `${host} 本小时已用满 ${HOST_BUDGET_MAX} 次预算 ⇒ 本次不发请求（等窗口重置；页面会用其他源或如实显示未取到）`
    return { ok: false, note, missing: { what: `宏观源 ${host}`, why: 'transient', note } }
  }
  opts.budget.spend(host)
  const res = await withHostBreaker(`${host}${u.pathname}`, () =>
    fetch(url, { headers: opts.headers ?? { 'user-agent': 'Mozilla/5.0 (compatible; dsh-tradewatcher/1.0)' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 9000) }),
  )
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`)
  return { ok: true, res, note: `${robots.note}｜预算 ${opts.budget.used(host)}/${HOST_BUDGET_MAX}（本小时）` }
}
