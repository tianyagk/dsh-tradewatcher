/**
 * 工具 ①：**持仓蛋糕**（`cake`）。
 *
 * 做什么：把持仓按分组切成一块蛋糕（饼图区），旁边给一张「各层市值 / 占比 / 当日涨跌」的市场表。
 * 本批只交付**结构骨架**：`sections` 里的区标题、KPI 格子标签、市场表列头是真的（下一批直接往里填数），
 * 任何**数值一律不编** —— 详情页在无数据时显示「未取到」并给原因（见 `toolRegistry.detailModel`）。
 *
 * 归行：本工具属于 `tools` 行（`dsh-tradewatcher/rows/tools`）。它消费的持仓数据由 core/portfolio
 * 行提供 ⇒ 本行**不需要**自己的 host 路由（判据见 `src/index.ts` 的 `ROW_ROUTES` 注释：单一消费方
 * 才归该行，而这里一个路由都不独占 ⇒ 空数组）。
 */
import type { ToolEntry } from '../toolRegistry.ts'

export const cakeTool: ToolEntry = {
  id: 'cake',
  name: '持仓蛋糕',
  blurb: '把持仓按分组切成一块蛋糕，配各层市值与占比的市场表',
  chip: '蛋糕',
  category: 'portfolio',
  sections: [
    // KPI 行：标签是真的（下一批接数据后直接填值）；本批每个格子都渲染「未取到」
    { key: 'kpi', title: 'KPI 行', cells: ['总市值', '浮动盈亏', '当日盈亏', '分组数'] },
    { key: 'curve', title: '曲线区' },
    { key: 'pie', title: '饼图区' },
    // 市场表：列头是真的；行数据由数据源决定 ⇒ 本批连行名都不编
    { key: 'market', title: '市场表', columns: ['分层', '市值', '占比', '当日涨跌'] },
    { key: 'boundary', title: '边界声明' },
  ],
  boundary: [
    '本批只搭结构骨架：KPI 行 / 曲线区 / 饼图区 / 市场表的数据源在下一批接入；接入前一律显示「未取到」并给原因，不以零值顶替。',
    '市值口径：以持仓账本逐笔流水核算（费用已计入）；无价持仓不计入总额，会在市场表里单独标注。',
    '占比 = 该层市值 ÷ 计入总额；分母不含无价持仓（口径会在数据接入时一并标注在区块口径行）。',
    '涨跌配色跟随面板主题与「红涨绿跌」偏好，不写死颜色；本组件不产生任何买卖建议。',
  ],
}
