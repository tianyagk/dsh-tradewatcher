/**
 * 约定（与 README「缺失不许用 0 代替」一致）：**任一分量缺失 ⇒ 整格 `—` + 原因**，
 */
import { numOrNull } from '../shared/model.ts'

export interface BreadthLeg {
  up: number | null
  down: number | null
  even: number | null
  amount: number | null
}

export interface BreadthCells {
  /** 两市合计家数；`countsOk=false` 时三个都是 null（不是 0） */
  up: number | null
  down: number | null
  even: number | null
  /** 两市成交额合计；`amountOk=false` 时为 null */
  amount: number | null
  /** 家数是否可用 —— false 时界面必须显示 `—` */
  countsOk: boolean
  /** 成交额是否可用（两腿都非空且为正） */
  amountOk: boolean
  /** `countsOk=false` 的原因（人话）；可用时为 null */
  reason: string | null
  /** 缺失的分量名（如 `沪市上涨家数`），供提示与断言定位 */
  missingParts: string[]
}

const LABEL: Record<'up' | 'down' | 'even', string> = { up: '上涨家数', down: '下跌家数', even: '平盘家数' }

/** 有限数值才算有效；null/undefined/NaN/Infinity 一律视为缺失 */
/** 涨跌家数三格 + 成交额：任一腿的家数缺失 ⇒ 家数三格全部不可用（含原因） */
export function breadthCells(sh: BreadthLeg | undefined, sz: BreadthLeg | undefined): BreadthCells {
  const legs: Array<[string, BreadthLeg | undefined]> = [['沪市', sh], ['深市', sz]]
  const missingParts: string[] = []
  const sums: Record<'up' | 'down' | 'even', number> = { up: 0, down: 0, even: 0 }
  for (const [market, leg] of legs) {
    for (const key of ['up', 'down', 'even'] as const) {
      const v = numOrNull(leg?.[key])
      if (v === null) {
        missingParts.push(`${market}${LABEL[key]}`)
        continue
      }
      sums[key] += v
    }
  }
  const countsOk = missingParts.length === 0
  const amounts = legs.map(([, leg]) => numOrNull(leg?.amount))
  const amountOk = amounts.every((a) => a !== null && a > 0)
  return {
    up: countsOk ? sums.up : null,
    down: countsOk ? sums.down : null,
    even: countsOk ? sums.even : null,
    amount: amountOk ? (amounts[0] as number) + (amounts[1] as number) : null,
    countsOk,
    amountOk,
    // M5：只说原因；"为什么不能显示 0"全局只在 UPDOWN_MISSING_NOTE 里讲一次
    reason: countsOk
      ? null
      : `${missingParts.join('、')}未取到（备用源不含涨跌家数字段，等东财恢复后随行情轮询自动重试）`,
    missingParts,
  }
}

/**
 * 涨 / 跌成对显示：**一侧缺失就整格 `—`**。
 *
 * 单只指数（或板块行）的「上涨 N / 下跌 M」是同一个事实的两个分量，
 * 只渲染半边会得到 `1234 / 0` 这种"没有一只下跌"的假读数。
 */
export function upDownPair(up: number | null | undefined, down: number | null | undefined): { ok: boolean; up: number | null; down: number | null } {
  const u = numOrNull(up)
  const d = numOrNull(down)
  if (u === null || d === null) return { ok: false, up: null, down: null }
  return { ok: true, up: u, down: d }
}

/** 成对显示缺失时的统一说明（hover + aria-label 共用一句） */
export const UPDOWN_MISSING_NOTE =
  '涨跌家数未取到：备用源（腾讯/新浪）不含该字段（东财 f104/f105/f106），等东财恢复后自动重试。' +
  '这里不显示 0 —— 0 会被读成"没有一只下跌"，那是错的信息'

/**
 * 家数三格取哪一份（P0-1）：**指数行情优先，拿不到才用自统计**。
 *
 * 为什么必须有这一步：指数行情走备用源时 `f104/f105/f106` 就没有了（三格全 `—`），
 * 而 `/tradewatcher/breadth` 的 `current` 可能是本插件自行统计出来的 —— 不接上就会出现
 * "三格 `—` ＋ 一行说家数是自己统计的 ＋ 一个 62.1% 的占比"这种同屏自相矛盾的读数。
 *
 * `current` 为 `null` 时（自统计也没成）返回 `from:'none'`，三格一律 `—`（不用 0 顶替）。
 */
export function pickBreadthCounts(
  cells: Pick<BreadthCells, 'countsOk' | 'up' | 'down' | 'even'>,
  current: { up: number; down: number; even: number } | null | undefined,
): { up: number | null; down: number | null; even: number | null; from: 'index' | 'self' | 'none' } {
  if (cells.countsOk && cells.up !== null && cells.down !== null && cells.even !== null) {
    return { up: cells.up, down: cells.down, even: cells.even, from: 'index' }
  }
  if (current !== null && current !== undefined) {
    return { up: current.up, down: current.down, even: current.even, from: 'self' }
  }
  return { up: null, down: null, even: null, from: 'none' }
}
