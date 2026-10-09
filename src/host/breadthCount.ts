/**
 * **顺序不变量自检**、合理性检查。网络取数由 `em.ts` / `sina.ts` 提供，测试里注入构造的页数据。
 * 红线：不变量不成立就**不发布这个数**（宁可 `—` + 原因，也不给一个看起来正常但错的数字）。
 */
import { MISSING_TIER_ADVICE } from '../shared/model.ts'

/** 沪深A股（沪市主板+科创板、深市主板+创业板；**不含北交所** —— 口径要如实标出） */
export const BREADTH_HS_A_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23'
/** 上游单页上限（实测东财 clist 与新浪都被截在 100） */
export const BREADTH_PAGE_SIZE = 100
/** 分页统计的请求预算（源 B：沪深A股约 54 页 ⇒ 预算 60 够一次全量；截断即失败） */
export const BREADTH_CLIST_MAX_PAGES = 60
/** 并发（源 B） */
export const BREADTH_CLIST_CONCURRENCY = 4
/** 源 C 的边界搜索预算（约 6–8 次足够） */
export const BREADTH_SINA_MAX_PAGES = 10
/** 结果缓存（毫秒）：一轮快照的有效期，避免每次刷新都把上游打一遍 */
export const BREADTH_COUNT_TTL_MS = 120_000

/** 界面/工具要照原样说明的统计口径（自己算的数不能与上游给的混为一谈） */
export const BREADTH_COUNT_CALIBER =
  '本插件自行按沪深A股全量统计（含科创板/创业板，不含北交所）：涨跌幅 >0 记上涨、=0 记平盘、<0 记下跌'

export type BreadthCountSource = 'em-index' | 'em-clist' | 'page-scan'

export interface BreadthCounts {
  up: number
  down: number
  even: number
  /** 参与统计的股票总数（分页统计时取上游给的 total） */
  total: number
  /** 实际扫过的**有效**行数（有涨跌幅的行；源 C=边界页之和） */
  scanned: number
  /** 扫到但**没有涨跌幅**的行数（停牌 / 上游给 `'-'`），未计入三类 —— 不是错误 */
  blank: number
  /** 实际请求的页数 */
  pages: number
}

/** 一页的取数结果：涨跌幅数组（按上游排序，`null` = 该行没有可用涨跌幅）+ 上游给的总数 */
export interface CountPage {
  rows: Array<number | null>
  total: number | null
  /** 该页里没有涨跌幅的行数（若取数方已把那些行丢弃，用它把"原始行数"补回来） */
  blank?: number
}

export interface CountAttempt {
  counts: BreadthCounts | null
  /** 失败原因（成功时为 null）；措辞沿用两档（transient / no-source）+ 具体原因 */
  reason: string | null
  /** 自检结论（成功时也返回，便于排查"为什么这次数变了"） */
  checks: string[]
}

/** 只有有限数才算"有一个涨跌幅"；空/非数一律不算（不许当 0） */
function pctOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 合理性检查（源 B/C 共用）：明显不合理的统计按失败处理。
 *
 * ⚠ 等式基准是**有效行数**（有涨跌幅的行），**不是上游 total**：A 股常态就有停牌/无涨跌幅的行，
 * 拿未扣除的 total 做等式会让源 B 当日有 1 只停牌就恒失败（实测就踩过这个坑）。
 * 覆盖检查用 `scanned + blank`（扫到的**原始**行数）与 total 比，`fullScan:true` 时才做。
 */
export function sanityOfCounts(
  counts: Pick<BreadthCounts, 'up' | 'down' | 'even' | 'total' | 'scanned' | 'blank'>,
  opts: {
    /** 源 B 的全量扫页由调用方核对覆盖（见 `countBreadthFromClist`）；此处仅在指定时校验 */
    fullScan?: boolean
    /**
     * 三类之和与谁对齐：源 B = `scanned`（它扫的就是全市场有效行）；
     * 源 C 只读边界页（`scanned` 只是读过的行数），它的三类覆盖全市场 ⇒ 与 `total` 对齐。
     */
    sumEquals?: 'scanned' | 'total'
  } = {},
): { ok: boolean; reason: string | null } {
  if (counts.blank > counts.total) {
    return { ok: false, reason: `无涨跌幅的行数（${counts.blank}）超过上游总数（${counts.total}），按失败处理` }
  }
  if (counts.scanned <= 0) return { ok: false, reason: '没有扫到任何有涨跌幅的行，按失败处理' }
  const baseline = opts.sumEquals === 'total' ? counts.total : counts.scanned
  const baselineLabel = opts.sumEquals === 'total' ? '总数' : '有效行数'
  if (counts.up + counts.down + counts.even !== baseline) {
    return {
      ok: false,
      reason: `三类之和（${counts.up + counts.down + counts.even}）与${baselineLabel}（${baseline}）不一致，按失败处理`,
    }
  }
  if (counts.total <= 0) return { ok: false, reason: '上游未给出有效总数（total ≤ 0），无法核对统计结果' }
  if (counts.up + counts.down + counts.even === 0) return { ok: false, reason: '统计结果三者全为 0，而总数大于 0 —— 按失败处理' }
  if (opts.fullScan === true && counts.scanned + counts.blank < counts.total) {
    return {
      ok: false,
      reason: `扫到的原始行数（${counts.scanned + counts.blank}）少于上游总数（${counts.total}）行，分页可能被截断，按失败处理`,
    }
  }
  return { ok: true, reason: null }
}

/**
 * 源 B：把分页拿到的涨跌幅**本地计数**（>0 上涨 / =0 平盘 / <0 下跌）。
 *
 * 页数组里 `null`/`NaN` 表示"这一行没有可用涨跌幅"（停牌、上游给 `'-'`）——按原样保留占位，
 * 这样"扫到多少行"与"其中多少行无效"都能如实算出来（`checks` 里会写明）。
 */
export function countFromClistPages(pages: readonly (readonly (number | null)[] | undefined)[], total: number | null): CountAttempt {
  let up = 0
  let down = 0
  let even = 0
  let invalid = 0
  let scanned = 0
  for (const page of pages) {
    // 缺页（含稀疏数组的空槽）不是"空页"，但这里一律跳过 —— 缺页由分页器判定并报错（D1）
    if (page === undefined) continue
    for (const raw of page) {
      const pct = pctOf(raw)
      if (pct === null) {
        invalid += 1
        continue
      }
      scanned += 1
      if (pct > 0) up += 1
      else if (pct < 0) down += 1
      else even += 1
    }
  }
  const t = total ?? scanned + invalid
  const counts: BreadthCounts = { up, down, even, total: t, scanned, blank: invalid, pages: pages.length }
  // 覆盖检查由调用方（`countBreadthFromClist`，它才知道页大小与页数）负责；这里只做等式与合理性
  const sanity = sanityOfCounts(counts)
  const checks = [
    `分页 ${pages.length} 页、有效行 ${scanned} 行${invalid > 0 ? `（另有 ${invalid} 行无涨跌幅，未计入）` : ''}${
      total !== null ? `；上游总数 ${total}` : ''
    }`,
    invalid > 0 ? `其中 ${invalid} 行没有有效涨跌幅（未计入）` : '每行都有有效涨跌幅',
  ]
  if (!sanity.ok) return { counts: null, reason: sanity.reason, checks }
  return { counts, reason: null, checks }
}

 // **顺序不变量自检**（任一条不成立 ⇒ 不发布这个数，返回失败 + 原因）：
 // - 每页内部必须非递增（降序）；
 // - 三类独立计数之和必须等于 `total`。
export async function countFromSortedPctPages(
  fetchPage: (page: number, num: number) => Promise<CountPage>,
  opts: { num?: number; maxPages?: number } = {},
): Promise<CountAttempt> {
  const num = Math.max(1, Math.min(BREADTH_PAGE_SIZE, Math.round(opts.num ?? BREADTH_PAGE_SIZE)))
  const maxPages = Math.max(2, Math.round(opts.maxPages ?? BREADTH_SINA_MAX_PAGES))
  const checks: string[] = []
  const cache = new Map<number, number[]>()
  let budget = maxPages
  let total: number | null = null

  const fetchRows = async (page: number, note: boolean): Promise<number[] | null> => {
    if (page < 1 || budget <= 0) return null
    budget -= 1
    const got = await fetchPage(page, num)
    if (total === null && got.total !== null) total = got.total
    const rows = got.rows.map((v) => pctOf(v)).filter((v): v is number => v !== null)
    if (rows.length === 0) return null  // 该页全是无涨跌幅的行 ⇒ 视为取数失败（源 C 未接线）
    if (note) checks.push(`page ${page}：${rows.length} 行（首 ${rows[0].toFixed(2)} 末 ${rows[rows.length - 1].toFixed(2)}）`)
    return rows
  }
  const load = async (page: number): Promise<number[] | null> => {
    const hit = cache.get(page)
    if (hit !== undefined) return hit
    const rows = await fetchRows(page, true)
    if (rows !== null) cache.set(page, rows)
    return rows
  }
  /**
   * 不变量核对用**新取一次**的数据（不吃缓存）：上游排序/分页不稳定时，
   * 相邻页的关系会变 —— 那种情况必须失败，而不是拿两次不同的快照拼一个数出来。
   */
  const loadFresh = (page: number): Promise<number[] | null> => fetchRows(page, false)

  const descending = (rows: readonly number[]): boolean => rows.every((v, i) => i === 0 || rows[i - 1] >= v)

  const firstPage = await load(1)
  if (firstPage === null) return { counts: null, reason: '新浪接口本次没有返回可用数据（首屏为空或超预算）', checks }
  if (!descending(firstPage)) {
    checks.push('page 1 不是降序 ⇒ 上游排序语义与预期不符')
    return { counts: null, reason: '上游返回的顺序不是"按涨跌幅降序"，边界搜索不成立，本次不发布家数', checks }
  }
  const lastPage = total !== null ? Math.max(1, Math.ceil(total / num)) : maxPages

  /** 二分找"第一个 min < 0 的页"（即首个包含负值的页），从 from 页起 */
  const findFirstWithNegative = async (from: number): Promise<number | null> => {
    let lo = from
    let hi = lastPage
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      const rows = await load(mid)
      if (rows === null) return null
      if (rows[rows.length - 1] < 0) hi = mid - 1
      else lo = mid + 1
    }
    return lo
  }

  // ① 先定“首个含非正值（≤0）的页”：P=1 或 [2, lastPage] 二分
  let p = 1
  if (firstPage[firstPage.length - 1] > 0) {
    let lo = 2
    let hi = lastPage
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      const rows = await load(mid)
      if (rows === null) return { counts: null, reason: '边界搜索中途取数失败（可能是上游限流或页数超出预算）', checks }
      if (rows[rows.length - 1] <= 0) hi = mid - 1
      else lo = mid + 1
    }
    if (lo > lastPage) {
      // 所有页都全正 ⇒ 全市场上涨。但"全正"必须**证明**：新取一次最后一页，
      // 它的最小值仍 > 0 才敢下这个结论（只凭首页 + 二分没找到边界是不够的）
      if (total === null) {
        checks.push('首页全正，但上游未给总数 ⇒ 无法确认"全市场上涨"')
        return { counts: null, reason: '上游未给出总数（无法核对统计结果），本次不发布家数', checks }
      }
      const lastRows = await loadFresh(lastPage)
      if (lastRows === null) return { counts: null, reason: '无法核对最后一页（取数失败或超预算）', checks }
      if (!(lastRows[lastRows.length - 1] > 0)) {
        checks.push(`最后一页（page ${lastPage}）的新取最小值 ${lastRows[lastRows.length - 1]} 不大于 0 ⇒ "全市场上涨"不成立`)
        return { counts: null, reason: '顺序不变量不成立（最后一页并非全正），本次不发布家数', checks }
      }
      const expectedRows = Math.min(num, total - (lastPage - 1) * num)
      if (lastRows.length < expectedRows) {
        checks.push(`最后一页只有 ${lastRows.length} 行，按总数应 ${expectedRows} 行`)
        return { counts: null, reason: '上游分页行数与总数不一致，本次不发布家数', checks }
      }
      // 源 C 的页里没有「无涨跌幅占位」（解析侧已过滤），故 blank = 0
      const all = { up: total, down: 0, even: 0, total, scanned: [...cache.values()].reduce((a, rows) => a + rows.length, 0), blank: 0, pages: cache.size }
      const sanity = sanityOfCounts(all, { sumEquals: 'total' })
      if (!sanity.ok) return { counts: null, reason: sanity.reason, checks }
      checks.push(`不变量成立：最后一页（page ${lastPage}）最大值 > 0 ⇒ 全市场 ${total} 只均为上涨`)
      return { counts: all, reason: null, checks }
    }
    p = lo
  }
  const pRows = await load(p)
  if (pRows === null) return { counts: null, reason: '定位涨幅分界页失败（取数失败或超出预算）', checks }
  // 页行数必须与"按总数和页大小推算的行数"一致（最后一页允许不满）
  const expectedP = Math.min(num, (total ?? 0) - (p - 1) * num)
  if (total !== null && pRows.length < expectedP) {
    checks.push(`page ${p} 只有 ${pRows.length} 行，按总数应 ${expectedP} 行`)
    return { counts: null, reason: '上游分页行数与总数不一致，本次不发布家数', checks }
  }
  if (!descending(pRows)) {
    checks.push(`page ${p} 不是降序`)
    return { counts: null, reason: '分界页内部顺序不满足降序，边界搜索结论不可信，本次不发布家数', checks }
  }
  if (p > 1) {
    const prev = await loadFresh(p - 1)
    if (prev === null) return { counts: null, reason: '无法核对分界页前一页（取数失败或超预算）', checks }
    if (!(prev[prev.length - 1] > 0)) {
      checks.push(`page ${p - 1} 的新取末值 ${prev[prev.length - 1]} 不大于 0 ⇒ 分界页判定不成立（上游顺序/分页不稳定）`)
      return { counts: null, reason: '顺序不变量不成立（分界页前一页仍有非正值），本次不发布家数', checks }
    }
    checks.push(`不变量成立：page ${p - 1} 末值 > 0 ≥ page ${p} 末值`)
  }
  if (!(pRows[0] > 0 && pRows[pRows.length - 1] <= 0)) {
    checks.push(`page ${p} 没有跨越 0（首 ${pRows[0]} 末 ${pRows[pRows.length - 1]}）`)
    return { counts: null, reason: '分界页没有跨越涨跌分界，本次不发布家数', checks }
  }

  // ② 再定“首个含负值的页” Q（平盘可能跨多页）
  const qMaybe = await findFirstWithNegative(p)
  if (qMaybe === null) return { counts: null, reason: '定位平盘/下跌分界页失败（取数失败或超出预算）', checks }
  const q = qMaybe
  const qRows = await load(q)
  if (qRows === null) return { counts: null, reason: '定位平盘/下跌分界页失败（取数失败或超出预算）', checks }
  if (!descending(qRows)) {
    checks.push(`page ${q} 不是降序`)
    return { counts: null, reason: '分界页内部顺序不满足降序，本次不发布家数', checks }
  }
  if (q > p) {
    const prev = await loadFresh(q - 1)
    if (prev === null) return { counts: null, reason: '无法核对平盘分界页前一页（取数失败或超预算）', checks }
    if (!(prev[prev.length - 1] >= 0)) {
      checks.push(`page ${q - 1} 的新取末值 ${prev[prev.length - 1]} 小于 0 ⇒ 平盘分界判定不成立`)
      return { counts: null, reason: '顺序不变量不成立（平盘分界页前一页已有负值），本次不发布家数', checks }
    }
  } else {
    // 同页：必须"正 → 0 → 负"三段连续
    const idxNeg = qRows.findIndex((v) => v < 0)
    const idxZero = qRows.findIndex((v) => v === 0)
    if (idxZero < 0 || idxNeg < idxZero) {
      checks.push('同一页里"平盘段"不连续（0 出现在负值之后或缺失）')
      return { counts: null, reason: '顺序不变量不成立（同一分界页内 0 段不连续），本次不发布家数', checks }
    }
  }
  if (!(qRows[qRows.length - 1] < 0)) {
    // 首个含负值的页必须真的含负值；若整段只有 0（全市场平盘）则 Q 不存在
    const allZero = qRows.every((v) => v === 0) && total !== null && total <= (q - 1) * num + qRows.length
    if (!allZero) {
      checks.push(`page ${q} 末值 ${qRows[qRows.length - 1]} 不小于 0 ⇒ 负值边界判定错误`)
      return { counts: null, reason: '顺序不变量不成立（未找到真正的负值边界页），本次不发布家数', checks }
    }
  }

  // ③ 三类**独立计数** + 和必须等于 total
  const positivesInP = pRows.filter((v) => v > 0).length
  const zerosInP = pRows.filter((v) => v === 0).length
  const zerosInQ = qRows.filter((v) => v === 0).length
  const up = (p - 1) * num + positivesInP
  const even = zerosInP + Math.max(0, q - p - 1) * num + (q === p ? 0 : zerosInQ)
  if (total === null) {
    checks.push('上游未给出总数，无法独立核对三类之和')
    return { counts: null, reason: '上游未给出总数（无法核对统计结果），本次不发布家数', checks }
  }
  const down = total - up - even
  const counts: BreadthCounts = {
    up: even === 0 && up === 0 ? 0 : up,
    down: Math.max(0, down),
    even,
    total,
    // 读过的行数（含分界前的探测页）——只作排查用，不参与"是否全量扫过"的判定
    scanned: [...cache.values()].reduce((a, rows) => a + rows.length, 0),
    blank: 0,
    pages: cache.size,
  }
  const sanity = sanityOfCounts(counts, { sumEquals: 'total' })
  if (!sanity.ok) {
    checks.push(`合理性检查未通过：${sanity.reason}`)
    return { counts: null, reason: sanity.reason, checks }
  }
  checks.push(`三类独立计数：上涨 ${up} + 平盘 ${even} + 下跌 ${counts.down} = ${total} ✓`)
  return { counts, reason: null, checks }
}

/** 失败时用的统一原因（沿用两档措辞 + 具体原因） */
export function breadthFailReason(detail: string, why: 'transient' | 'no-source'): string {
  return `${detail} —— ${MISSING_TIER_ADVICE[why]}`
}

/**
 * 源 B：东财 clist **分页扫全量**（并发 ≤4、页数上限、请求预算内），本地按 f3 计数。
 *
 * 为什么要有页数上限与预算：上游把 `pz` 截在 100，沪深A股约 54 页 —— 一旦上游返回的 total
 * 异常大（或被限流返回空页），没有上限就会一直打上游。超预算即**失败**（宁可 `—`）。
 */
export async function countBreadthFromClist(
  fetchPage: (pn: number, pz: number) => Promise<CountPage>,
  opts: { pageSize?: number; maxPages?: number; concurrency?: number } = {},
): Promise<CountAttempt> {
  const pz = Math.max(1, Math.min(BREADTH_PAGE_SIZE, Math.round(opts.pageSize ?? BREADTH_PAGE_SIZE)))
  const maxPages = Math.max(1, Math.round(opts.maxPages ?? BREADTH_CLIST_MAX_PAGES))
  const concurrency = Math.max(1, Math.round(opts.concurrency ?? BREADTH_CLIST_CONCURRENCY))
  const checks: string[] = []

  let first: CountPage
  try {
    first = await fetchPage(1, pz)
  } catch (error) {
    return { counts: null, reason: `东财 clist 首页取数失败：${String(error).slice(0, 60)}`, checks }
  }
  const total = first.total
  if (first.rows.length === 0) {
    return { counts: null, reason: '东财 clist 本次没有返回数据（限流或接口不可达）', checks }
  }
  const rawRows = (page: CountPage): number => page.rows.length + (page.blank ?? 0)
  if (rawRows(first) < pz && total !== null && total > rawRows(first)) {
    return {
      counts: null,
      reason: `首页只有 ${rawRows(first)} 行而总数 ${total} 行（上游分页行为异常），按失败处理`,
      checks,
    }
  }
  const pageCount = total !== null ? Math.ceil(Math.max(total, first.rows.length) / pz) : 0
  if (pageCount === 0) {
    // 不知道总数时可以只扫首页，但那样必然通不过"扫过的行数 ≥ 总数"，直接失败更诚实
    return { counts: null, reason: '东财 clist 未给出总数，无法确认是否扫全（按失败处理）', checks }
  }
  if (pageCount > maxPages) {
    return {
      counts: null,
      reason: `需要 ${pageCount} 页 > 上限 ${maxPages} 页（总数 ${total}），按失败处理（不静默截断）`,
      checks,
    }
  }
  // ⚠ 必须**显式填 undefined**：`new Array(n)` 造出的是稀疏数组，空槽会被 `filter`/`some`/`for...of` 跳过，
  // 于是"缺页统计"恒为 0、逐页诊断丢失，最坏还会 `for (const x of undefined)` 抛 TypeError（D1）
  const pages: Array<Array<number | null> | undefined> = Array.from({ length: pageCount }, () => undefined)
  pages[0] = first.rows
  let rawSeen = rawRows(first)
  const queue = Array.from({ length: pageCount - 1 }, (_, i) => i + 2)
  let firstError: string | null = null
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, async () => {
    for (;;) {
      const pn = queue.shift()
      if (pn === undefined) return
      try {
        const got = await fetchPage(pn, pz)
        if (rawRows(got) === 0) {
          if (firstError === null) firstError = `第 ${pn} 页为空（上游限流或分页被截断）`
          continue
        }
        pages[pn - 1] = got.rows
        rawSeen += rawRows(got)
      } catch (error) {
        if (firstError === null) firstError = `第 ${pn} 页取数失败：${String(error).slice(0, 60)}`
      }
    }
  })
  await Promise.all(workers)
  // 下标循环：即使真有空槽也能数出来（`filter`/`some` 会跳过空槽 —— 这正是 D1 的坑）
  let missingPages = 0
  for (let i = 0; i < pageCount; i += 1) if (pages[i] === undefined) missingPages += 1
  if (missingPages > 0) {
    // 逐页诊断必须活下来：`firstError` 是"第 N 页抛了什么"的唯一记录
    const detail = `共 ${pageCount} 页，其中 ${missingPages} 页未取到`
    checks.push(detail + (firstError !== null ? `：${firstError}` : ''))
    return {
      counts: null,
      reason: firstError !== null ? `${firstError}；${detail}（分页不完整，按失败处理）` : `${detail}（分页不完整，按失败处理）`,
      checks,
    }
  }
  // 覆盖检查（全量扫页的红线）：扫到的**原始行数**（有效 + 无涨跌幅）必须不少于上游 total
  if (total !== null && rawSeen < total) {
    checks.push(`扫到的原始行数 ${rawSeen} < 上游总数 ${total}`)
    const why = `只扫到 ${rawSeen} 行 < 总数 ${total} 行，分页可能被截断`
    return { counts: null, reason: firstError !== null ? `${firstError}；${why}（按失败处理）` : `${why}（按失败处理）`, checks }
  }
  const attempt = countFromClistPages(pages, total)
  return {
    counts: attempt.counts,
    reason: attempt.reason,
    checks: [...checks, `扫到的原始行数 ${rawSeen}（上游总数 ${total ?? '未给'}）`, ...attempt.checks],
  }
}

/** 源 B/C 的结果缓存（一轮快照的有效期）：避免每次刷新都把上游打一遍 */
export class BreadthCountCache {
  private at = 0
  private value: { counts: BreadthCounts; source: BreadthCountSource; asOf: number } | null = null
  private readonly ttlMs: number

  constructor(ttlMs: number = BREADTH_COUNT_TTL_MS) {
    this.ttlMs = Math.max(60_000, Math.min(300_000, ttlMs))
  }

  get(now: number = Date.now()): { counts: BreadthCounts; source: BreadthCountSource; asOf: number } | null {
    if (this.value === null || now - this.at > this.ttlMs) return null
    return this.value
  }

  /** 只缓存自统计（B/C）的结果：源 A 是行情对象里现成的，没必要缓存 */
  set(value: { counts: BreadthCounts; source: BreadthCountSource; asOf: number }, now: number = Date.now()): void {
    this.at = now
    this.value = value
  }
}

export interface BreadthCountDeps {
  /** 源 B：东财 clist 的一页 */
  clistPage: (pn: number, pz: number) => Promise<CountPage>
  /** 源 B 的页大小（默认 100，即上游上限；测试可注入更小的页） */
  clistPageSize?: number
  /**
   * 可选：**任何**"按涨跌幅降序返回分页"的源（边界搜索用；当前运行时未接入，
   * 见 `resolveBreadthCount` 的说明）。不传就跳过这一档。
   */
  sortedPctPage?: (page: number, num: number) => Promise<CountPage>
}

export interface BreadthCountResolution {
  counts: BreadthCounts | null
  source: BreadthCountSource | null
  /** 数字时刻：源 A = 行情时刻；源 B/C = **统计完成时刻**（不复用行情时刻） */
  asOf: number | null
  reason: string | null
  checks: string[]
}

/**
 * 多源家数链（按成本从低到高，命中即止）：A 指数字段 → B 东财 clist 全量统计 → C 降序分页边界搜索。
 *
 * ⚠ **C 档当前未接线**：它需要 `deps.sortedPctPage`（一个"按涨跌幅降序返回分页"的取数实现），
 * 而当前运行时没有可用的那条取数实现（该目标在本环境不可用）⇒ 只传 `clistPage`，链实际只走 A→B。
 * 算法 `countFromSortedPctPages` 与它的用例是**通用件**（任何降序分页源都能用），刻意保留：
 * 接线前请先给 `deps.sortedPctPage` 传实现，并按 把 `down` 改成边界页独立计数。
 *
 * 源 A 由调用方（路由）从指数行情里取出；B/C 都拿不到就返回失败 + 原因（界面维持现状的 `—`）。
 */
export async function resolveBreadthCount(args: {
  fromIndexQuote: { up: number; down: number; even: number; total?: number } | null
  indexAsOf: number | null
  deps: BreadthCountDeps
  now?: number
  cache?: BreadthCountCache
}): Promise<BreadthCountResolution> {
  const now = args.now ?? Date.now()
  // 源 A：东财指数字段（最便宜）
  if (args.fromIndexQuote !== null) {
    const q = args.fromIndexQuote
    const total = q.total ?? q.up + q.down + q.even
    // 源 A 是上游直接给的三个数，没有「无涨跌幅行」这个概念（blank = 0）
    const counts: BreadthCounts = { up: q.up, down: q.down, even: q.even, total, scanned: total, blank: 0, pages: 0 }
    const sanity = sanityOfCounts(counts, { fullScan: false })
    if (sanity.ok) {
      return { counts, source: 'em-index', asOf: args.indexAsOf ?? now, reason: null, checks: ['源 A：指数行情 f104/f105/f106（上游直接给的数）'] }
    }
    // A 不可信 ⇒ 继续往下试，不直接放弃
  }
  // 缓存：B/C 的结果在 TTL 内直接复用（并原样带上"当时统计完成"的时刻）
  const cached = args.cache?.get(now)
  if (cached !== undefined && cached !== null) {
    return { counts: cached.counts, source: cached.source, asOf: cached.asOf, reason: null, checks: ['源 B/C：命中自统计结果缓存'] }
  }
  const b = await countBreadthFromClist(args.deps.clistPage, { pageSize: args.deps.clistPageSize })
  if (b.counts !== null) {
    const at = args.now ?? Date.now()
    args.cache?.set({ counts: b.counts, source: 'em-clist', asOf: at }, at)
    return { counts: b.counts, source: 'em-clist', asOf: at, reason: null, checks: b.checks }
  }
  const c = args.deps.sortedPctPage === undefined
    ? null
    : await countFromSortedPctPages(args.deps.sortedPctPage)
  if (c !== null && c.counts !== null) {
    const at = args.now ?? Date.now()
    args.cache?.set({ counts: c.counts, source: 'page-scan', asOf: at }, at)
    return { counts: c.counts, source: 'page-scan', asOf: at, reason: null, checks: c.checks }
  }
  // 逐个列出**试过的源**与各自的原因：用户/agent 在无法探活的环境里要靠这一行判断"哪条通"
  const tried: string[] = []
  if (args.fromIndexQuote === null) tried.push('源A 指数 f104/f105/f106 缺失')
  tried.push(`源B 东财 clist：${b.reason ?? '失败'}`)
  if (c !== null) tried.push(`源C 降序分页扫描：${c.reason ?? '失败'}`)
  const detail = tried.join('；')
  return {
    counts: null,
    source: null,
    asOf: null,
    reason: breadthFailReason(detail, 'transient'),
    checks: [...b.checks, ...(c?.checks ?? [])],
  }
}
