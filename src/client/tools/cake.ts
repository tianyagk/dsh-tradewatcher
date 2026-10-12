/**
 * 工具 ①：**五市场蛋糕**（`cake`）。
 *
 * 做什么：把**五个市场**（美股 / 欧股 / 日股 / A股 / 新兴市场）的宽基 ETF 规模切成一块蛋糕，
 * 旁边给份额曲线、静态饼图与"份额 + 变化"的市场表；A股净流入**单列**（不参与份额计算）。
 *
 * 口径（细节在宿主 `src/host/globalFlow.ts` 的文件头，页面只渲染、不重算）：
 *   · 份额 = 该市场规模 ÷ Σ **有值**市场规模（缺数据的市场不进分母，该行显示「未取到 + 原因」）；
 *   · 规模 = 宽基 ETF 规模（美股 SPY / 欧股 VGK / 日股 EWJ / A股 510300 / 新兴 EEM）；
 *   · A股 规模是人民币 ⇒ 按当日汇率折成美元后进分母（汇率取不到就如实标口径不一致，不静默混算）；
 *   · 动量 = 各市场宽基口径的 20 / 60 / 120 日收益率 + 横截面排序；
 *   · 曲线固定 180 个序列日，其中实测日与重建日分开标注；滑块回放最近 30 个交易日（本地快照）。
 *
 * ⚠ 本文件里的用户文案**不许出现阿拉伯数字**：`toolRegistry.test.ts` 有一条红线断言 ——
 * 没有数据时整份详情模型里一个数字都不许有（带数字的口径文案由宿主载荷提供）。
 *
 * 归行：本工具属于 `tools` 行（`dsh-tradewatcher/rows/tools`），它独占的宿主路由是
 * `/tradewatcher/tools/global-flow`（见 `src/index.ts` 的 `ROW_ROUTES`）。
 */
import { api } from '../api.ts'
import type { ToolEntry } from '../toolRegistry.ts'
import { globalFlowToolPayload } from './globalFlowView.ts'

export const cakeTool: ToolEntry = {
  id: 'cake',
  name: '五市场蛋糕',
  blurb: '把五个市场的宽基 ETF 规模切成一块蛋糕，配份额曲线、份额变化与轮动',
  chip: '蛋糕',
  category: 'flow',
  sections: [
    { key: 'kpi', title: 'KPI 行', cells: ['规模榜首', '五市场合计规模', '近五日轮动', '数据时刻'] },
    { key: 'curve', title: '曲线区' },
    { key: 'pie', title: '饼图区' },
    { key: 'market', title: '市场表', columns: ['市场', '宽基标的', '规模（美元）', '份额', '份额变化', '动量（多周期）', '横截面排名'] },
    { key: 'boundary', title: '边界声明' },
  ],
  boundary: [
    '份额 = 各市场宽基 ETF 规模 ÷ 有值市场规模之和；取不到数的市场既不进分子也不进分母，该行显示「未取到」并给出原因，绝不用零顶替。',
    '五个市场各用一只宽基 ETF 代理：美股 SPY、欧股 VGK、日股 EWJ、A股 沪深三百ETF、新兴市场 EEM。ETF 规模不等于该市场全部市值，只代表这几只宽基 ETF 的规模权重。',
    'A股 规模以人民币计价，按当日在岸汇率折算成美元后进分母；汇率取不到时 A股 单列、不进美元合计，并标注口径不一致。',
    'A股净流入单独一栏：它是流量口径、且只覆盖一只标的，不代表全市场资金流，绝不参与份额计算。',
    '份额曲线里实测日与重建日分开标注：实测日是本插件真正观测到的那一天，其余历史日按「当前实测规模 × 日线收盘价之比」重建，只反映价格驱动的相对规模变化，不反映申赎。',
    '数据来自公开源（腾讯日线、新浪行情/ETF 节点/资金流/汇率）；本组件不给任何买卖建议。',
  ],
  load: async () => globalFlowToolPayload(await api.globalFlow()),
}
