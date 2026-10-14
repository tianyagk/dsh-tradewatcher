# DESIGN-TOOL-PAGE-ALIGN —— 「全球资金流蛋糕模型」详情页对齐参考版（Arkvol）

- 目标：把工具箱详情页的**排版 / 字号 / 颜色细节**对齐用户给的参考版观感（图 1），并消掉常驻口径文案的噪声（图 2）。
- 口径：本文件只定义**呈现方式**。**数字、数据来源、降级/缺失原因、边界声明一个字都不改**（红线见 §5）。
- 可检查性：每条规格都给出**可判定阈值**（不是"更大一点"），并在 §6 列出它由哪条断言看守。
- 相关文件：`src/client/tools/ToolsPage.tsx`、`src/client/toolDetailTheme.ts`（新增，令牌与判据的唯一来源）、
  `src/client/styles.ts`、`src/client/tools/globalFlowView.ts`、`src/client/tools/cake.ts`、`src/client/toolRegistry.ts`（KPI 磁贴色标字段）。

---

## 1. 差异表（现状值 → 建议值 → 依据）

| # | 项 | 现状值（`文件:行号`） | 建议值 | 依据（参考版 / 用户口径） |
| --- | --- | --- | --- | --- |
| 1 | Hero 标题 | `ToolsPage.tsx` heroView：`fontSize: 17, fontWeight: 600` | `fontSize: 46`、`fontWeight: 800`、`lineHeight: 1.06`、`letterSpacing: -0.02em` | 图 1「超大标题」目视 44–56px、极粗；用户条 1 |
| 2 | Kickerc | `fontSize: 10.5` + 胶囊（`padding 0 6px`、`borderRadius 6`、`border 1px`、`background accent-soft`） | `fontSize: 12`、`fontWeight: 600`、`letterSpacing: 0.14em`、`textTransform: uppercase`、**无边框/无底色/无圆角** | 图 1 kicker 是大写宽字距小标签，不是胶囊；用户差异条 1 |
| 3 | Hero 说明段 | `fontSize: 11.5, lineHeight: 1.6, color --tw-muted` | `fontSize: 15`、`lineHeight: 1.7`、`color: --tw-dim`、`maxWidth: 68ch` | 图 1 说明段约 14–16px、行高松、次要色 |
| 4 | 摘要卡数值 | `fontSize: 16, fontWeight: 600` | `fontSize: 34`、`fontWeight: 700`、`lineHeight: 1.1`；标签 `12.5/500/--tw-muted`（**标签在上、数值在下**） | 图 1「大号数值在下（32–40px 粗）」；用户差异条 2 |
| 5 | 卡片分层 | `.tw-panel`：`border 1px --tw-border`、`borderRadius 10`、`padding 10px 12px`（无阴影） | 专用 `.tw-tool-card`：`border 1px --tw-border-strong`、`borderRadius 14`、`padding 18px`、`background --tw-card`、`boxShadow: none` | 图 1 卡片**细边框 + 大圆角**，暗底靠**边框**分层不靠重阴影；用户差异条 3 |
| 6 | KPI 磁贴 | `border 1px --tw-border`、`borderRadius 9`、`padding 6px 9px`、标签 `.tw-hint`、值 `12.5` —— **无色标** | 磁贴 `borderRadius 10`、`padding 10px 12px`、`background --tw-card2`；新增 **8×8 色标方块**（`borderRadius 2`，颜色 = 该格对应序列色，无对应序列 ⇒ `--tw-muted` 中性色标）；标签 `12/--tw-muted`；值 `20/700`；右端 `较上日 ±x` `11.5/--tw-muted` | 图 1 每块磁贴都有彩色小方块；用户差异条 4 |
| 7 | 图例位置 | 在 `<svg>` **之后**（`ToolsPage.tsx` curveChart 尾部）、`gap 10`、色标是 `10×3` 矩形、左对齐 | 移到 `<svg>` **之前**、`justifyContent: center`、色标 = **8×8 圆点**（`borderRadius: 50%`）、名称 `12/--tw-dim` | 图 1 图例居中在图表**上方**（圆点色标 + 名称）；用户差异条 5 |
| 8 | 纵向节奏 | 详情容器 `gap: 8`、`padding: 8px 12px 12px`；卡内 `padding 10/12` | 区块间距 **22px**（20–28）、卡内边距 **18px**（16–20）、磁贴内边距 `10px 12px` | 图 1 区块间距大、内边距 16–20；用户差异条 7 |
| 9 | 常驻口径文案 | 区块口径行用 `.tw-hint` 常驻（每区一行，最多 5 行）；市场脚注 2 行；饼图缺块说明 1 行 | 见 §4 降噪方案（A 档常驻 / B 档进 `title`+`aria-label`） | 用户差异条 6「常驻多行口径说明噪声大」 |
| 10 | 图表卡标题 / AS OF | `.tw-panel-h .t`（继承 13px/600）；AS OF `11px/--tw-muted` | 卡内标题 `17px/700`；AS OF `11.5px/--tw-muted`、`letterSpacing: 0.08em`（大写） | 图 1 卡内标题 16–18 粗 + 右端小号 `AS OF 日期` |

## 2. 设计令牌表（**唯一来源**：`src/client/toolDetailTheme.ts`，JS 可读 ⇒ 断言直接读）

> 为什么放在 TS 而不是 CSS：这些值必须能被 `node:test` 读到，才能"断言锚真实现"而不是"正则捞源码"。
> `styles.ts` 只保留**必须由 CSS 承担**的部分（hover、媒体查询、CSS 变量），见 §3.6。

### 2.1 字号 / 字重 / 行高 / 字距

| 令牌 | 值 | 用途 | 阈值（断言） |
| --- | --- | --- | --- |
| `kicker` | `12 / 600 / 1.2 / 0.14em / uppercase` | Hero 小标签 | 字号 11–13；字距 ≥ 0.10em；`uppercase`；**无** border/background/borderRadius |
| `heroTitle` | `46 / 800 / 1.06 / -0.02em` | Hero 大标题 | 字号 ≥ 40 且 ≤ 60；字重 ≥ 700 |
| `heroNote` | `15 / 400 / 1.7` | Hero 说明段 | 字号 14–16；行高 ≥ 1.5 |
| `summaryLabel` | `12.5 / 500` | 摘要卡标签（在上） | 字号 12–13 |
| `summaryValue` | `34 / 700 / 1.1` | 摘要卡数值（在下） | 字号 32–40；字重 ≥ 700；**与标签字号差 ≥ 18** |
| `summaryNote` | `12 / 400 / 1.45` | 摘要卡状态词 | ≤ 13 |
| `cardTitle` | `17 / 700` | 卡内标题 | 16–18；字重 ≥ 700 |
| `asOf` | `11.5 / 500 / 0.08em` | 卡右上 `AS OF` | ≤ 12；字距 ≥ 0.05em |
| `tileLabel` | `12 / 400` | 磁贴标签 | 11–13 |
| `tileValue` | `20 / 700` | 磁贴数值 | 18–22；字重 ≥ 700 |
| `tileDelta` | `11.5 / 400` | 磁贴右端「较上日 ±x」 | ≤ 12 |
| `legendLabel` | `12 / 400` | 图例名称 | 11–13 |

### 2.2 间距刻度（px）

| 令牌 | 值 | 用途 | 阈值 |
| --- | --- | --- | --- |
| `sectionGap` | `22` | 详情页区块间距 | 20–28 |
| `cardPad` | `18` | 卡片内边距（摘要卡 / 图表卡 / 功能区） | 16–20 |
| `tilePadY` / `tilePadX` | `10` / `12` | 磁贴内边距 | 10–14 |
| `heroGap` | `16` | Hero 左右栏与内部间距 | 12–20 |
| `tileGap` | `10` | 磁贴之间 | 8–12 |

### 2.3 圆角 / 边框 / 底色 / 次要色（**一律引用既有主题令牌**）

| 用途 | 取值 | 说明 |
| --- | --- | --- |
| 卡片边框 | `1px solid var(--tw-border-strong)` | 复用既有 token；比卡片内分隔用的 `--tw-border` 强一档 ⇒ 暗底靠边框分层 |
| 卡片圆角 | `14` | 大圆角 |
| 磁贴边框 / 圆角 | `1px solid var(--tw-border)` / `10` | 比卡片弱一档（层级：卡片 > 磁贴） |
| 卡片底 | `var(--tw-card)` | 既有 token |
| 磁贴底 | `var(--tw-card2)` | 既有 token |
| 卡内标题色 | `var(--tw-text)` | 既有 token |
| 次要色（标签/口径） | `var(--tw-muted)` | 既有 token |
| 说明段颜色 | `var(--tw-dim)` | 既有 token（比 muted 稍亮 ⇒ 说明段可读） |
| 范围控件选中底 | `var(--tw-card)`（在 `--tw-bg2` 的凹陷容器上） | 既有 token：浅底圆角块 |
| 卡片阴影 | **`none`** | 用户口径：不靠重阴影分层；层级由边框 + 底色区分 |
| 图例色标 | `8×8`，`borderRadius: 50%` | 圆点 |
| 磁贴色标 | `8×8`，`borderRadius: 2` | 彩色小方块；颜色 = `FLOW_SERIES_COLORS[swatch]`，无对应序列 ⇒ `var(--tw-muted)` |
| 磁贴色标与标签间距 | `8` | 与文字基线对齐（`flex` 行内 `alignItems: center`） |

**本次新增的主题令牌：0 个**（全部复用 `styles.ts` 里既有的 `--tw-*`）。`styles.ts` 新增的是**工具箱专用类**（非主题令牌）：
`.tw-tool-detail`（容器：区块间距/内边距/纵向布局）、`.tw-tool-card`（细边框 + 大圆角 + 无阴影）、
`.tw-tool-card:hover`（边框加强，不加阴影）、`.tw-tool-tiles`（4 列，≤720px 折成 2 列）、
`.tw-tool-hero`（左右栏，≤720px 折成上下）、`.tw-tool-range`（凹陷容器 + 选中档浅底圆角块）。

## 3. 组件规格

### 3.1 Hero
- 结构：`kicker`（§2.1）→ `heroTitle` → `heroNote`；右上角 `range`（§3.2）。左右分栏 `flex`，`gap: heroGap`，窄屏折成上下。
- kicker 文案沿用工具声明（`cake.ts` 的 `hero.kicker`，即 `宏观 | 全球轮动`）；**style 承担大写与字距**（`text-transform: uppercase` 对中文无副作用）。
- 说明段：`maxWidth: 68ch`（防止超宽行），行高 1.7。

### 3.2 时间范围分段控件（右上角）
- 容器：凹陷 `--tw-bg2` 底 + `1px --tw-border` + `radius 10` + `padding 2`；三档 `90日 / 180日 / 365日`。
- 档位按钮：`padding 4px 10px`、`radius 8`、`12px`；**选中** = 浅底圆角块（`background --tw-card` + `1px --tw-border-strong` + 文字 `--tw-text` + `fontWeight 600`）；未选中 = 透明底 + `--tw-muted`。
- 行为不变：切档只做**本地切片**（`io.onRange`），不发请求；`aria-pressed` 保留。

### 3.3 摘要卡（×2）
- 结构：`summaryLabel`（在上）→ `summaryValue`（在下）→ `summaryNote`（状态词）。
- 卡片 = `.tw-tool-card`（§2.3）；两列 grid，`gap: tileGap`。
- 值缺失时值文本 = `未取到`（既有约定），色用 `--tw-muted`。

### 3.4 图表卡（标题 + AS OF + 四个 KPI 磁贴 + 主图）
- 卡头：`cardTitle`（左，`模型曲线区标题`）+ 状态行（中，常驻，见 §4-A）+ `AS OF <日期>`（右，`asOf`）。
- 磁贴行：**4 列** grid（`.tw-tool-tiles`；窄屏 2 列）。每块：
  `[色标 ■][标签][…… 弹簧……][较上日 ±x]` 第一行，第二行大字数值。
  色标来自 `ToolKpiDatum.swatch`（**新增字段**，见 §3.5）——没有对应序列的格子用中性色标（不许拿某条序列的颜色冒充）。
- 主图：`<svg>` 折线（逻辑不变：缺的点画断、右侧纵轴、实测日圆点）；**图例在 svg 之前**（§3.6）。

### 3.5 模型新增字段（唯一的数据侧改动）
`ToolKpiDatum.swatch?: number | null`（→ `DetailModel.kpi.cells[].swatch: number | null`）：
- 含义：该磁贴对应的**序列序号**（与曲线/图例同色）；`null` = 该格不对应任何序列 ⇒ 中性色标。
- 无数据时不产生数字（红线断言照旧：`detailModel(entry)` 整份模型零阿拉伯数字）。

### 3.6 图例
- 位置：**主图上方**、`justifyContent: center`（居中）。
- 每项：`8×8` 圆点（`borderRadius: 50%`，色 = `FLOW_SERIES_COLORS[i]`）+ 名称（`legendLabel`）。
- 「圆点 = 实测日」那句说明：**保留**（它是曲线构成的事实），但降噪见 §4-B。

## 4. 口径文案降噪方案（用户差异条 6）

三档处置，**只改呈现方式，不删事实**：

### A 档：**必须常驻可见**（任何视图档：完整 / 紧凑 / 隐身）
| 内容 | 位置 | 判据 |
| --- | --- | --- |
| 状态行（数据时刻 + 降级/回退/快照标记） | 图表卡头部 | `data-role="tool-status"`，inline 样式（**不复用 `.tw-hint`**，那个类在紧凑/隐身档 `display:none`） |
| 空态原因（`未取到：<原因>`） | 各区占位框 | inline 样式 |
| 逐行缺口原因（`未取到：<原因>`） | 市场表每行下方 | `data-role="tool-row-note"`，inline 样式 |
| 「哪几个市场没进饼图」 | 饼图卡 | `data-role="tool-pie-missing"`（**本次从 `.tw-hint` 改为 inline**） |
| 份额合计（分母口径） | 市场表脚注第一行 | `data-role="tool-market-total"`（**本次从 `.tw-hint` 改为 inline**） |
| 边界声明（全部条目，首条为核心免责） | 末尾卡 | `data-role="tool-legal"`/`tool-legal-line`，inline 样式 |

### B 档：**降噪**（常驻 → `title` + `aria-label`，事实仍可读）
| 内容 | 处置 |
| --- | --- |
| 各区口径行（`kpi/curve/pie/market/boundary` 的 `note`） | 从常驻文本改为区块标题的 `title` + `aria-label`（`sectionHead` 改造） |
| 市场脚注的**其余**行（动量列口径 / 回放不下发动量…） | 合并进脚注行的 `title` + `aria-label` |
| 曲线实测/重建说明、「第 N/M 个交易日」等操作说明 | 保留在 `title`/`aria-label` |
| 状态行的完整版（`statusDetail`） | 已在 `title`（既有） |

### C 档：**不改**
数字、单位、数据来源、缺失与否、`未取到` 的取值规则、快照/回退语义、边界声明的全部条目与措辞。

## 5. 红线（不得违反）
1. **口径诚实性只改呈现方式**：降级/陈旧/缺失原因、边界声明（含「这是风险偏好代理，不是真实跨境资金净流入」）**默认可见**，
   **紧凑与隐身档也可见** ⇒ A 档一律用 inline 样式，**不许复用 `.tw-hint`**（`styles.ts:90-98` 会隐藏它）。
2. **不得为好看编数**：磁贴色标只做颜色区分，不引入任何新数值；无数据时模型里零阿拉伯数字。
3. **数字与数据来源不变**：本批不改 `globalFlowView.ts` 的任何计算与文案事实，只加 `swatch` 与（如有的）措辞位置调整。

## 6. 可检查性矩阵（每条规格 → 看守它的断言）
| 规格 | 断言（`src/client/toolsPage.test.ts` / `toolDetailTheme.test.ts`） |
| --- | --- |
| §2.1 heroTitle / kicker / heroNote | `heroTypeProblems(TOOL_TYPE)` + 源码接线（页面用同一批常量） |
| §2.1 摘要卡标签/数值层级 | `summaryHierarchyProblems(...)`（字号差 ≥ 18） |
| §2.3 卡片边框/圆角/无重阴影/内边距 | `cardSurfaceProblems(CARD_SURFACE)` |
| §3.4 磁贴色标 | `tileProblems(...)` + 源码 `data-role="tool-kpi-swatch"` 出现在 `tool-kpi-tile` **内部** |
| §3.6 图例在图上、居中、圆点 | `legendProblems(...)` + **顺序断言**：`curveChart` 里 legend 锚点索引 < svg 锚点索引 |
| §3.2 范围三档可切换 | 真实条目 `ranges.options === [90,180,365]` + `io.onRange(n)` 接线 + 选中样式常量 |
| §4-A 常驻可见 | 现有 `tw-hint` 负向检查扩展到 `tool-pie-missing` / `tool-market-total` |
| §4-B 降噪但事实可读 | `sectionHead` 的 note 必须进 `title`/`aria-label`，且**不许**作为常驻文本渲染 |

## 7. 落地顺序
1. `toolDetailTheme.ts`（令牌 + 判据，纯函数）—— 先定规格，后面所有页面改动都引用它。
2. `styles.ts`（`.tw-tool-*` 类：容器节奏 / 卡片分层 / 磁贴网格 / Hero 分栏 / 范围控件）。
3. `toolRegistry.ts`（`ToolKpiDatum.swatch` + `DetailModel.kpi.cells[].swatch` 透传）。
4. `globalFlowView.ts`（给四个磁贴填 `swatch`；无序列的格子给 `null`）。
5. `ToolsPage.tsx`（Hero / 摘要卡 / 图表卡 / 磁贴 / 图例 / `sectionHead` 降噪）。
6. 测试（6 条断言 + 每条一反例注入）→ `npm run check`（612 基线 × 2 时区）。

---

## 8. A 组：绘图区必须填满卡片（用户补充要求）

### 8.1 差异表（现状 → 建议 → 依据）

| # | 项 | 现状值 | 建议值 | 依据 |
| --- | --- | --- | --- | --- |
| A1 | 绘图区高度 | `<svg height: 180>`（固定像素） | `min-height: 420px` + `aspect-ratio: 16 / 7`（**高度契约两条**：下限 + 高度来源） | 参考版绘图区目视 480–620px；用户点名 `min-height: 420px` 与"宽高比随卡片宽度自适应" |
| A2 | 坐标缩放 | 固定 `viewBox="0 0 720 180"` + `width:100%`（`meet` 会留白、`none` 会拉伸） | **ResizeObserver 量容器真实像素**当 viewBox（W×H 像素坐标）⇒ 线宽/圆点/文字不缩放、SVG 100% 填满 | 消除"图比参考版小 + 图与图例之间大片空白" |
| A3 | 图例位置 | `<svg>` **之后**、左对齐 | `<svg>` **之前**、居中（`CHART_STACK = ['legend','plot']`） | 参考版图例居中在图表上方 |
| A4 | 空白带 | 图例与画布分居两处 + 固定 180px 画布 | 图例紧贴画布上方（容器 `gap: 8`），画布本身填满卡片宽度 | 用户："消除空白带" |
| A5 | 高度塌陷风险 | 历史事故 `.tw-chips-plot` 只写 `flex:1` ⇒ 塌成 1px | `plotHeightProblems()` 判据 + 渲染前自检（缺一条即抛错） | 用户点名"无 `flex: 1` 却无高度契约的写法" |

### 8.2 断言与反例（A 组）

| 断言 | 位置 | 反例注入（必败） |
| --- | --- | --- |
| 绘图区下限 ≥ 420 且有高度来源 | `toolDetailTheme.test.ts`「A 绘图区高度契约」 | `minHeight: 160`；`minHeight: 0`；`{flex: 1}`（历史事故形态） |
| 几何：端点贴内边距、x 单调、带外 ⇒ null | 同上「A′ 绘图区几何」 | —（`nearestIndex` 带外返回值的分支断言） |
| 页面真的用了 `PLOT.minHeight` / `PLOT.aspectRatio` / `plotHeightProblems` / `ResizeObserver` | `toolsPage.test.ts` `renderWiringProblems` | 「写死 160px」「去掉 aspect-ratio」「去掉 usePlotSize」三条注入 |
| 图例**在画布上方**（顺序来自 `CHART_STACK`） | 同上 + `chartStackProblems(CHART_STACK)` | 「图例挪到画布之后」（改 `CHART_STACK` / 改渲染顺序）两条注入 |

## 9. B 组：动效（用户补充要求）

| # | 能力 | 实现 | 参数 | 断言 / 反例 |
| --- | --- | --- | --- | --- |
| B1 | 悬停十字线 + 提示框（**逐序列**列五个市场） | 容器 `onMouseMove` → `nearestIndex`（纯函数）→ 竖线 + 焦点圆点；提示框复用 `.tw-chart-tip`，行模型来自 `hoverRowsOf()` | 取点带宽 `PLOT.hoverBand` | `hoverRowsOf` 单元断言（缺值 ⇒ `未取到`，**绝不写 0**）；页面接线断言；注入：删提示框 / 删十字线 |
| B2 | 切换范围档有过渡动画 | 按窗口长度重挂载绘图组 ⇒ `MOTION_STYLE.fadeIn`（`@keyframes tw-tool-in`） | `MOTION.rangeMs = 200`（150–250） | `motionProblems()`；注入：删淡入 / 把时长改 400ms |
| B3 | 回放拖动**平滑跟随** | ① 路径 `key` 只含序列序号（不含回放步）⇒ 节点不重建、不闪；② `d` 同时给属性与 CSS（`pathStyle`）⇒ 支持 CSS `d` 的浏览器做 `transition: d` | `MOTION.replayMs = 180`（120–250） | `MOTION_STYLE.line` 含 `d <ms>`；注入：去掉 `pathStyle` |
| B4 | 只用 CSS / SVG，不引依赖 | 无新增依赖（无图表库） | — | 页面源码断言"不含 recharts/chart.js/echarts/d3" |
| B5 | 尊重 reduced-motion | ① `@media (prefers-reduced-motion: reduce)` 停动画与过渡；② `matchMedia` → 容器 `data-anim="off"`（与系统偏好等效，且可断言） | — | `motionProblems()` 的 `hasMediaQuery`/`hasOffSwitch`；注入：删媒体查询 / 删 `data-anim` |

**降级行为**：`data-anim=off` 或系统减少动画时，**图、图例、悬停提示框、滑块全都照常可用**，只是不做过渡 —— 信息一条不少。

## 10. 更新后的落地顺序（本批实际执行）

1. `docs/DESIGN-TOOL-PAGE-ALIGN.md`（本文件：先写规格）
2. `src/client/toolDetailTheme.ts`（令牌 + 判据 + 几何/顺序/动效常量）
3. `src/client/styles.ts`（`.tw-tool-*` 类 + keyframes + 两条 reduced-motion 规则）
4. `src/client/toolRegistry.ts`（`ToolKpiDatum.swatch` 透传）
5. `src/client/tools/globalFlowView.ts`（磁贴 `swatch`；`hoverRowsOf`）
6. `src/client/ToolsPage.tsx`（Hero / 摘要卡 / 图表卡 / 磁贴 / 图例在上 / 自适应画布 / 悬停 / 动效 / 口径降噪）
7. 测试：`toolDetailTheme.test.ts`（10 条）+ `toolsPage.test.ts`（接线与注入扩展到 30+ 条）
8. `npm run check`（612 基线 × 2 时区）

---

## 11. 本轮证据（实现报告）

### 11.1 `npm run check`（基线 612）

```
ℹ tests 622 / ℹ pass 622 / ℹ fail 0     （默认时区）
ℹ tests 622 / ℹ pass 622 / ℹ fail 0     （TZ=UTC）
built lib/index.js + lib/client.js （v0.82.0，客户端片段校验通过：73 项）
```

`build.mjs` **零改动**（片段数仍 73 项）。新增测试：`toolDetailTheme.test.ts` 10 条（本批）+ `toolsPage.test.ts` 扩展（接线与注入 30+ 条）。

### 11.2 反例注入（15 条，全部被抓住；脚本 `/tmp/align-inject.py`，输出 `/tmp/align-inject-evidence.txt`）

| 组 | 注入 | 首条失败断言 |
| --- | --- | --- |
| **A**（4/4） | 绘图区写死 160px | 绘图区必须同时给高度下限与高度来源（aspect-ratio） |
| A | 去掉 aspect-ratio（只剩 min-height） | 同上 |
| A | 不再按容器真实像素绘制（拿掉 ResizeObserver） | 绘图区必须按容器真实像素绘制（填满卡片、随容器自适应） |
| A | `CHART_STACK` 顺序颠倒（图例回到底部） | 渲染顺序契约：图例在上、画布在下 |
| **B**（6/6） | 切档过渡改成 400ms | 切档过渡必须在 150–250ms（实得 400） |
| B | 回放跟随关掉（路径不再交给 CSS） | 回放平滑跟随：路径经 pathStyle 交给 CSS，且 key 不含回放步 |
| B | 删掉 `@media (prefers-reduced-motion:reduce)` | 缺少 @media (prefers-reduced-motion: reduce) 规则 |
| B | 删掉 `[data-anim=off]` 开关规则 | 缺少 data-anim="off" 的降级开关规则 |
| B | 悬停浮层缺项（只列榜首） | 有值时必须逐序列给出真实值 |
| B | 浮层把缺值写成 0 | 缺值必须写「未取到」 |
| **排版**（5/5） | Hero 标题缩回 17px | Hero 标题字号必须 40–60px（实得 17） |
| 排版 | 摘要卡数值缩回 16px | 数值必须 32–40px；标签与数值字号差必须 ≥ 18px |
| 排版 | 卡片改回重阴影 | 卡片不许用重阴影分层（必须为 none） |
| 排版 | 磁贴色标塌成 0 | 磁贴色标必须 ≥ 6×6px |
| 排版 | 图例色标退回小矩形 | 图例色标必须是正圆（宽高相等 + borderRadius 50%） |

每条注入后立刻还原，`sha256` 与注入前一致；恢复后两个测试文件复跑 `exit=0`。

### 11.3 产物层复核（`lib/client.js`）

含：`tw-tool-card` / `tw-tool-tiles` / `tw-tool-plot` / `tw-tool-range` / `tw-tool-in`（keyframes）/
`tool-kpi-swatch` / `tool-hover-tip` / `tool-crosshair` / `tool-chart-legend` / `tool-legal-line` /
`tool-pie-missing` / `tool-market-total` / `ResizeObserver` / `prefers-reduced-motion` / `data-anim` /
`path("`（CSS `d` 的平滑跟随）/ `AS OF`；`未取到` 占位仍在。

### 11.4 未做项 / 已知边界

1. **浏览器实机观感**未验证（约束：不装 bundle、不动 profile、不重启服务）——"是不是好看"仍需用户看图确认；
   本批给的是"令牌 + 渲染接线 + 产物 + 反例注入"四层证据。
2. **CSS `d` 的过渡**只在支持该属性的浏览器（Chrome / Firefox 97+）生效；不支持时**行为不变**（逐帧切换，不闪），
   这一降级是设计内的（`pathStyle` 同时给属性与 CSS，属性永远是兜底）。
3. 悬停提示框是**鼠标**交互；触屏/键盘用户仍可从市场表与 KPI 磁贴读到同样的数值（没有新信息只存在于浮层里）。
4. 未新增任何主题令牌（全部复用既有 `--tw-*`）；`styles.ts` 新增的是工具箱专用类与两条 reduced-motion 规则。

---

## 12. 第四批：折线图与饼图的**尺寸**对齐（用户补充要求）

### 12.1 病根（诊断，Lead 已确认 + 本人复核）

上一版给绘图区写了 `min-height: 420` + **`aspect-ratio: 16 / 7`**。整卡宽度约 **2000px** 时，
`16/7` ⇒ 高度 ≈ **875px** ⇒ 折线图几乎占满视口，并把饼图挤到下方（用户截图 2 的观感）。
⇒ **高度不许再由卡片宽度单独决定**（`plotHeightProblems` 现在把"只有 aspect-ratio"直接判红）。

### 12.2 差异表（现状 → 建议 → 依据）

| # | 项 | 现状 | 现在 | 依据 |
| --- | --- | --- | --- | --- |
| S1 | 折线图高度 | `min-height: 420` + `aspect-ratio: 16/7`（整卡宽 ⇒ ~875px） | `height: clamp(280px, 26vh, 380px)`（有界） | 参考版约 300–350px；用户口径区间 [280, 420] |
| S2 | 卡内布局 | 单列：磁贴 → 折线图 → **另起一张饼图卡** | **两列**：左 = 折线图；右 = 饼图 + 回放滑块 | 参考版图 3：左 62–66% 折线，右列饼图 + 滑块 |
| S3 | 饼图直径 | 固定 `168px` 的 svg 盒子（旧版），后并入独立卡 | `clamp(220px, 22vh, 320px)`、居中；画面直径 = 尺寸 × 2 × `radiusRatio`(0.46) ∈ [202, 294] | 参考版饼直径约 260–300；用户口径 [220, 320] |
| S4 | 饼图图例 | 饼右侧竖排 | 饼**下方**、居中、圆点色标（与折线图同一套色） | 参考版图例在饼下方 |
| S5 | 窄屏 | — | `@media (max-width:900px)` ⇒ 单列（上下堆叠） | 用户："窄屏回落为上下堆叠" |
| S6 | 保留项 | 图例在图上居中 / 悬停十字线 + 浮层 / 切档过渡 / 回放平滑 / reduced-motion / 零依赖 | **全部保留**（本批只改尺寸与列布局） | 用户第 4 条 |

### 12.3 新增的常量与 CSS（优先复用既有令牌：**新增主题令牌 0 个**）

| 名称 | 值 | 用途 |
| --- | --- | --- |
| `PLOT.heightCss` | `clamp(280px, 26vh, 380px)` | 折线图高度契约（下限 280 / 上限 380，落在 [280,420] 内） |
| `PLOT.heightMin` / `heightMax` | `280` / `380` | 判定用上下界（与 CSS 契约一致性由断言核对） |
| `PIE.sizeCss` | `clamp(220px, 22vh, 320px)` | 饼图直径契约 |
| `PIE.sizeMin` / `sizeMax` | `220` / `320` | 判定用上下界 |
| `PIE.radiusRatio` | `0.46` | 饼在 100×100 viewBox 里的半径比例（画面直径 = 尺寸 × 2 × 该值） |
| `CHART_SPLIT` | `['plot', 'pie']` | 两列顺序的唯一来源（数组顺序 = 渲染顺序） |
| `.tw-tool-split`（styles.ts） | `grid-template-columns: minmax(0,1.9fr) minmax(220px,1fr)` | 两列栅格（左列弹性、右列至少 220px） |
| `@media (max-width:900px) .tw-tool-split` | `grid-template-columns: minmax(0,1fr)` | 窄屏回落为堆叠 |
| `.tw-tool-pie-legend`（styles.ts） | `flex; justify-content:center; flex-wrap:wrap` | 饼图图例居中换行 |

### 12.4 断言与反例注入（本批 ①②③④ 全部，另有 A 组 8/8 文件级注入）

| # | 断言（位置） | 反例注入（必败） |
| --- | --- | --- |
| ① | 折线图高度有界且落在 [280,420]：`plotHeightProblems({height: PLOT.heightCss})` 空 + 上下界等于常量（`toolDetailTheme.test.ts`「① 折线图高度**有界**」） | 写死 `160px`；回到整卡 `aspect-ratio: 16/7`；上限放到 `600px`；只写 `flex:1` |
| ② | 两列存在且**折线在左、饼在右**：`chartSplitProblems(CHART_SPLIT)` 空 + 页面 `...CHART_SPLIT.map(...)` + 左右列锚点（`toolsPage.test.ts` 接线） | `CHART_SPLIT` 换成 `['pie','plot']`；把 `slot === 'plot'` 改成 `slot === 'pie'`；`CHART_SPLIT.map` 换成 `['plot'].map`（两列塌成单列） |
| ③ | 饼图直径 [220,320] 且正方形：`pieProblems({width: PIE.sizeCss, height: PIE.sizeCss})` 空 + 画面直径 ∈ [200,320] + 页面走 `PIE.sizeCss`/`pieProblems` | 改成 `80px`；撑满整列（`100%`）；宽高不等；删掉图例 |
| ④ | 窄屏回落堆叠：styles.ts 有 `.tw-tool-split` 两列栅格 + `@media (max-width:900px)` 单列规则 | 删掉 900px 媒体查询 |
| ⑤ | 既有动效与红线断言全绿（`MOTION` / reduced-motion / 图例在上 / 浮层缺值「未取到」/ 边界声明可见） | 见 §11.2 的 B 组 6 条 + 本批 A 组 8 条 |

### 12.5 证据

- **文件级注入：A 组 8/8 被抓住**（`/tmp/align-inject.py` → `/tmp/align-inject-evidence.txt`）：
  写死 160px / 回到 aspect-ratio / `CHART_SPLIT` 颠倒 / 饼图 100% / 饼图 80px / 删 900px 媒体查询 —— 各自的失败断言见该文件；
  另有 B 组 6/6、排版组 5/5 仍全绿（说明本批没碰坏上一批的判据）。
- **尺寸实测值**：折线图 `clamp(280px, 26vh, 380px)`（1080p 视口 26vh ≈ 280px ⇒ 实际取 **280px**；视口高 ≥ 1462px 时取上限 **380px**）；
  饼图 `clamp(220px, 22vh, 320px)`（1080p ⇒ **220px**；视口高 ≥ 1455px ⇒ **320px**），画面直径 = 尺寸 × 0.92 ⇒ **202–294px**。
- `npm run check`：**622 → 625 条测试 × 2 时区全绿**（+3：①②③④ 拆成 4 条、替换掉旧的 A 组高度用例）。

### 12.6 未做项 / 已知边界

1. **浏览器实机**仍未验证（不重启服务的约束）：`vh` 在插件面板里取的是**视口**高度，若宿主把插件放进一个很矮的容器，
   实际高度会更接近下限 280px（这正是"有界"的意义）；要精确贴合容器需要容器查询（`@container`），本轮不做（浏览器支持与宿主结构都要先确认）。
2. 右列宽度用 `minmax(220px, 1fr)`：极窄列（<220px）时饼图仍按 220px 下限显示，可能轻微溢出 —— 由 900px 断点提前转堆叠来规避。
