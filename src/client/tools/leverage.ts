/**
 * 工具②：**杠杆温度计（锚定 2024）**（`leverage`；工具名与目录副标题是**用户口径逐字锁定**的）。
 *
 * 做什么：把 A 股两融的「显性融资比例」做成一条 0–100 的温度刻度 ——
 * 主图双轴（左 = 温度，右 = 比例 %）画温度与显性融资比例两条线，阈值线 80 / 95 落在温度轴上，
 * 底部柱画当日融资净买入（正红负蓝）；三张摘要卡给显性融资、杠杆率与当日净买入的读数。
 *
 * 版式：本工具**不走**通用三段式详情页（那个骨架自带 Hero 说明段、区的口径行与方法/边界两段散文），
 * 而用户对它的规格是"页面上唯一的说明文字是 `截至 YYYY-MM-DD`" ⇒ 用 `page: 'leverage'` 判别位
 * 路由到专用详情页 `src/client/leveragePage.tsx`。因此 `sections` / `boundary` 留空：
 * 它们是通用版式的结构声明，本工具一格都不渲染（写了也只是没人读的死文案）。
 *
 * 数据：`GET /tradewatcher/leverage?range=250|750|all`（宿主侧实现；客户端只消费，不重算）。
 * 归行：本工具属于 `tools` 行（调用点在 `ToolsPage.tsx` 之下 ⇒ 行归属由调用点推导）。
 */
import type { ToolEntry } from '../toolRegistry.ts'

export const leverageTool: ToolEntry = {
  id: 'leverage',
  // ⚠ 名称与目录副标题是**用户口径逐字锁定**的（不许自行改名）：
  //   卡片标题 = 「杠杆温度计（锚定 2024）」（R5：括号里是口径锚点，括号用**全角**）、
  //   目录副标题 = 「A股融资杠杆热度」。
  //   `leverageTool.test.ts` 与 `leverageHeader.test.ts` 有逐字断言（含反例注入），改这两个字面量必红。
  //   它同时是**详情页标题的唯一来源**（`ToolsPage` 把 `entry.name` 传给专用详情页）。
  name: '杠杆温度计（锚定 2024）',
  blurb: 'A股融资杠杆热度',
  // 卡片左上角的短标识（2–4 字约定；用户没有点名，取工具名的前两个字，不新造分类词）
  chip: '杠杆',
  category: 'margin',
  /** 专用详情页（见文件头：通用三段式与"唯一说明文字"的要求冲突） */
  page: 'leverage',
  sections: [],
  boundary: [],
}
