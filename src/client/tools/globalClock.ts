/**
 * 工具③：**全球期货交易时钟**（`globalClock`）。
 *
 * 做什么：24 小时轮盘 + 今日时段表 + 指数/期货卡片。表盘随时间**逆时针整盘旋转**（金线固定在 12 点），
 * 时段按交易所当地墙钟配置（夏令时走 `Intl`），显示时区可切（只影响显示，不影响绝对时刻）。
 * 版式：`page: 'globalClock'` ⇒ 专用详情页 `src/client/GlobalClockPage.tsx`（通用三段式不适用）。
 * 数据：复用 `/tradewatcher/quotes`（东财优先、失败切新浪）；缺数据一律 `—` + 原因。
 */
import type { ToolEntry } from '../toolRegistry.ts'

export const globalClockTool: ToolEntry = {
  id: 'globalClock',
  name: '全球期货交易时钟',
  blurb: '24 小时交易时段 · 跨市场对照',
  chip: '时钟',
  category: 'market',
  page: 'globalClock',
  sections: [],
  boundary: [],
}
