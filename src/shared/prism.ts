/**
 * 【棱镜】批次 1+2 的共享契约：调度设置 / 骨架 / 金十新闻 / 研判运行。
 * 页面与路由共用同一份字段名（错一个就会被断言抓住）。
 */

export interface PrismSettings {
  /** `HH:MM`（Asia/Shanghai），默认 09:35 / 11:20 / 13:10 / 14:40；可增删、无上限 */
  times: string[]
  /** 每个交易日已触发的时点（`YYYY-MM-DD` → `HH:MM[]`），进程重启不丢 */
  lastFired: Record<string, string[]>
}

export interface PrismNewsItem {
  id: string
  /** `YYYY-MM-DD HH:mm:ss`（金十原始，东八区） */
  time: string
  text: string
  important: boolean
}

export type PrismNewsState = 'idle' | 'backfilling' | 'ready' | 'error'

export interface PrismNewsStatus {
  state: PrismNewsState
  /** 本次回填已完成页数 */
  pages: number
  lastSeenId: string | null
  fetchedAt: number | null
  reason: string | null
  items: number
}

export interface PrismAnalysis {
  key: 'a-macro' | 'overseas' | 'commodity' | 'info'
  label: string
  text: string | null
  error: string | null
}

export interface PrismRun {
  /** 触发时点（手动补跑也写时点；`manual` 用于非时点补跑） */
  slot: string
  startedAt: number
  finishedAt: number | null
  analyses: PrismAnalysis[]
  summary: string | null
  error: string | null
}

export interface PrismModelInfo {
  provider: string | null
  model: string | null
  error: string | null
}

export interface PrismState {
  settings: PrismSettings
  skeleton: string
  news: PrismNewsStatus
  runs: PrismRun[]
  model: PrismModelInfo
}

export const PRISM_DEFAULT_TIMES = ['09:35', '11:20', '13:10', '14:40'] as const
export const PRISM_MAX_TIMES = 50
export const PRISM_SKELETON_MAX = 20_000
export const PRISM_NEWS_KEEP_MS = 24 * 3_600_000
export const PRISM_NEWS_PAGE_MAX = 10
export const PRISM_NEWS_GAP_MS = 3_000
export const PRISM_RUNS_KEEP = 20

export const PRISM_ANALYSIS_META: ReadonlyArray<{ key: PrismAnalysis['key']; label: string; prompt: string }> = [
  { key: 'a-macro', label: 'A股宏观', prompt: '聚焦 A股宏观：政策、流动性、指数与风格。只给判断与依据，不写免责声明。' },
  { key: 'overseas', label: '外盘', prompt: '聚焦外盘：美股、美债、汇率与主要指数。只给判断与依据，不写免责声明。' },
  { key: 'commodity', label: '大宗', prompt: '聚焦大宗商品：原油、贵金属、有色与黑色。只给判断与依据，不写免责声明。' },
  { key: 'info', label: '信息面', prompt: '聚焦信息面：金十快讯里对 A股有影响的事件与主题。只给判断与依据，不写免责声明。' },
]

export const PRISM_DEFAULT_SKELETON = `# 棱镜研判骨架（可编辑）

- 视角：以持仓为中心，先风险后机会。
- 顺序：A股宏观 → 外盘 → 大宗 → 信息面 → 汇总。
- 输出：每段给「判断 / 依据 / 需要盯的变量」，不写免责声明。
- 缺失数据写 — 并给一句原因。`
