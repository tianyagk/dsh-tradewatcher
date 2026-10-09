/**
 * 三条口径必须写死并在界面标注，否则分位会被当成"预测"：
 */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataHome } from './store.ts'
import { dayOf, hhmmOf, weekdayOf } from './time.ts'
import { writeJsonAtomic } from './atomic.ts'

/** 分位窗口（交易日） */
export const BREADTH_WINDOW = 60
/** 低于该样本数不给分位（样本太少的"分位"是噪音） */
export const BREADTH_MIN_DAYS = 5
/** 收盘后多久视为定稿（15:05 收盘，再给 25 分钟让上游把家数结算完） */
const FINAL_HHMM = '15:30'
/** 开始记录的时点 */
const RECORD_HHMM = '15:05'

export interface BreadthDay {
  up: number
  down: number
  even: number
  /** 两市成交额（元） */
  amount: number
  /** 该条的观测时刻（epoch ms） */
  at: number
  /** 是否已过结算缓冲（15:30 之后记为定稿） */
  final: boolean
}

interface BreadthFile {
  v: number
  days: Record<string, BreadthDay>
}

/** 涨跌家数的四个数字是否可用（上游返回 null 时不能当 0 用） */
export function breadthUsable(parts: ReadonlyArray<number | null | undefined>): boolean {
  return parts.every((v) => typeof v === 'number' && Number.isFinite(v))
}

/** 上涨家数占比（0–1）；总数为 0 时 null（不做 0/0 的假值） */
export function upRatio(day: Pick<BreadthDay, 'up' | 'down' | 'even'>): number | null {
  const total = day.up + day.down + day.even
  return total > 0 ? day.up / total : null
}

export interface PercentileResult {
  /** 指标说明（界面上必须原样显示，避免被读成别的东西） */
  metric: string
  /** 当前值（0–1） */
  value: number | null
  /** 参与比较的历史交易日数 */
  n: number
  /** 分位（0–100）：历史中有多少比例的日子 ≤ 当前值 */
  pct: number | null
  /** 样本不足（< BREADTH_MIN_DAYS）：不给分位 */
  sampleSmall: boolean
  /** 窗口内历史值（升序），供界面画小分布 */
  samples: number[]
}

/**
 * 历史分位（纯函数）。`history` 是**过去**的每日快照（不含今天），允许乱序。
 * 定义：`pct = #{v ≤ current} / n × 100`。取 "≤" 而不是 "<"，
 * 因为"和今天一样"的日子也是"不比今天更极端"的证据。
 */
export function percentileOf(
  current: number | null,
  history: ReadonlyArray<Pick<BreadthDay, 'up' | 'down' | 'even'>>,
  window = BREADTH_WINDOW,
  minDays = BREADTH_MIN_DAYS,
): PercentileResult {
  const samples = history
    .map((d) => upRatio(d))
    .filter((v): v is number => v !== null)
    .slice(-window)
    .sort((a, b) => a - b)
  const base: PercentileResult = {
    metric: `上涨家数占比（up ÷ up+down+even）在之前 ${Math.min(samples.length, window)} 个交易日的分位`,
    value: current,
    n: samples.length,
    pct: null,
    sampleSmall: samples.length < minDays,
    samples,
  }
  if (current === null || samples.length < minDays) return base
  const le = samples.filter((v) => v <= current).length
  return { ...base, pct: Math.round((le / samples.length) * 1000) / 10 }
}

export class BreadthStore {
  private dir: string
  private file: BreadthFile = { v: 1, days: {} }
  private loaded: Promise<void> | null = null
  private writeChain: Promise<void> = Promise.resolve()

  constructor(dir: string = dataHome()) {
    this.dir = dir
  }

  private path(): string {
    return join(this.dir, 'breadth.json')
  }

  async init(): Promise<void> {
    if (this.loaded !== null) return this.loaded
    this.loaded = (async () => {
      await mkdir(this.dir, { recursive: true }).catch(() => undefined)
      try {
        const raw = await readFile(this.path(), 'utf8')
        const parsed = JSON.parse(raw) as Partial<BreadthFile>
        const days: Record<string, BreadthDay> = {}
        for (const [k, v] of Object.entries(parsed.days ?? {})) {
          // 逐条校验：一个坏条目不该让整份历史失效
          if (v !== null && typeof v === 'object' && breadthUsable([v.up, v.down, v.even, v.amount])) {
            days[k] = v as BreadthDay
          }
        }
        this.file = { v: 1, days }
      } catch {
        /* 首次或文件损坏：从空开始（不覆盖，下面写入时才落盘） */
      }
    })()
    return this.loaded
  }

  private persist(): Promise<void> {
    const run = this.writeChain.then(async () => {
      await writeJsonAtomic(this.path(), this.file)
    })
    this.writeChain = run.catch(() => undefined)
    return run
  }

  /** 已有的交易日数 */
  get days(): number {
    return Object.keys(this.file.days).length
  }

  /** 过去若干交易日的快照（按日期升序；`excludeDay` 通常传今天） */
  history(window = BREADTH_WINDOW, excludeDay?: string): Array<{ day: string } & BreadthDay> {
    const keys = Object.keys(this.file.days).filter((k) => k !== excludeDay).sort()
    return keys.slice(-window).map((k) => ({ day: k, ...this.file.days[k] }))
  }

  today(): BreadthDay | undefined {
    return this.file.days[dayOf(Date.now())]
  }

  /**
   * 记录当日快照（只在收盘后写；见文件头说明）。
   * 返回是否发生了写入（供路由回包与自检用）。
   */
  async record(now: number, data: { up: number; down: number; even: number; amount: number }): Promise<boolean> {
    await this.init()
    const hhmm = hhmmOf(now)
    const wd = weekdayOf(now)
    if (wd === 0 || wd === 6) return false
    if (hhmm < RECORD_HHMM) return false
    if (!breadthUsable([data.up, data.down, data.even])) return false
    const day = dayOf(now)
    const next: BreadthDay = { ...data, at: now, final: hhmm >= FINAL_HHMM }
    const prev = this.file.days[day]
    // 已定稿就不再改写（收盘结算后的数字不该被后续读到的抖动覆盖）
    if (prev !== undefined && prev.final) return false
    this.file.days[day] = next
    // 滚动窗口：只保留窗口 + 一些余量，避免文件无限增长
    const keys = Object.keys(this.file.days).sort()
    const keep = BREADTH_WINDOW + 30
    while (keys.length > keep) {
      const drop = keys.shift()
      if (drop !== undefined) delete this.file.days[drop]
    }
    await this.persist()
    return true
  }
}
