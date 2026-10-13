# AUDIT-IMPL50 —— 工具箱两项界面改动（删目录页两处 + 详情页三段式与时间范围）

- 触发：用户两项界面改动，**同一 owner**（避免两人改同一文件）：
  ① 工具箱目录页删掉**页级返回控件**与**搜索框**（用户判为冗余）；
  ② 蛋糕工具详情页向参考版布局对齐（Hero → 摘要卡 → 图表卡），并把固定 180 日改成 `90 / 180 / 365` 可切换。
- 本轮写入面（我拥有）：`src/client/ToolsPage.tsx`、`toolRegistry.ts`、`toolText.ts`、`toolCardView.ts`、
  `toolsNav.ts`（**删除**）、`tools/cake.ts`、`tools/globalFlowView.ts` + 对应测试；宿主 `src/host/globalFlow.ts`；
  以及一处**最小接线改动** `src/client/index.tsx`（删掉只服务返回按钮的导航管道，见 §1.3 —— 不删就是死代码）。
- 约束遵守：`build.mjs` **零改动**（片段锁里没有本批任何字面量 ⇒ 73 项原样通过）；`styles.ts` 我**没动**；
  未 commit / 未装 / 未动 profile / **未重启服务**；实验隔离 `/tmp/tools3-*`；未手工写 `~/.dsh`。

---

## 0. 结论（先看这一段）

| 项 | 结果 |
| --- | --- |
| ① 目录页两处删除 | **已删净**：返回控件（含 `BackIcon`/`PAGE_BACK_ACTION`/`onBack`/`toolsNav.ts` 整条管道）+ 搜索框（含 `query` 状态/`matchesQuery`/`searchTextOf`/`searchPlaceholder` 字段/`SEARCH_PLACEHOLDER` 常量）；模型层、文案层、`index.tsx` 接线层三层都有"不得再出现"的断言 |
| ① 详情页回目录入口 | **保留**（`← 工具目录`，`model.backAction` 仍在 `detailView` 最上面；断言锁住它在 Hero 之前） |
| ② 三段式 | Hero（kicker + 大标题 + 说明 + **右上角时间范围**）→ 摘要卡 ×2（`资金蛋糕` / `当前偏好`）→ 图表卡（标题 + KPI 口径进 title/aria + 状态行 + `AS OF` + **四个 KPI 磁贴** + 回放滑块 + 主图带图例/右侧纵轴）；其后保留饼图 / 市场表 / A股净流入 / 边界声明 |
| ② 时间范围 | 三档 `90 / 180 / 365` 序列日；宿主一次构建到最大档，客户端**本地切片**（切档 0 上游请求、0 重算）；档位集合与宿主 `FLOW_CURVE_WINDOWS` 同一份口径（断言对比） |
| ② KPI 磁贴 | 四块 = 我们**真有**的四个指标（`规模榜首` / `五市场合计规模` / `近五日轮动` / `数据时刻`），值全部来自模型；**没有**引入"蛋糕温度/流动性支持度"这类无源口径（有断言禁止这些词进磁贴标签） |
| ② 长文案压缩 | 常驻状态行只留「数据时刻 + 降级/陈旧标记」；取数方式、曲线构成、窗口、作废留痕等完整版进 `title` / `aria-label`（`model.statusTitle`）；KPI 口径行进图表卡标题的 title/aria |
| 边界声明 | 仍**默认可见**（`data-role="tool-legal-line"`，不复用 `tw-hint`）——沿用既有断言与注入 |
| 注入 | ①5 条 + ②16 条 = **21 条反例全部被抓**（每条真改源码/文档片段 → 跑真检查 → 立即还原） |
| 门禁 | `npm run check` **EXIT=0**：**589 × 2 时区**全绿 + selftest + build（末尾三行见 §5.2）。期间曾因并行写入线（涨跌分布页）半成品而红过一轮，那条线落地后复跑变绿（如实记在 §5.2） |

---

## 1. ① 目录页：删掉返回控件与搜索框

### 1.1 删了什么（逐处）

| 位置 | 删除内容 |
| --- | --- |
| `ToolsPage.tsx` | 页头整块（`BackIcon` 内联 SVG、`PAGE_BACK_ACTION` 文案、`props.onBack === null ? null : …` 分支）；搜索框 `<input type="search">` 与它的 `query` 状态、`setQuery` 传递；组件签名从 `ToolsPage(props)` 变为 **`ToolsPage()`**（不接任何 props） |
| `toolText.ts` | `PAGE_BACK_ACTION`（`'返回'`）、`SEARCH_PLACEHOLDER`（`'搜索工具、市场或指标'`）两个导出**整条删除**，并在文件头记下"这两样已删、不许加回来" |
| `toolRegistry.ts` | `CatalogModel.searchPlaceholder` 字段、`searchTextOf()`、`matchesQuery()`、`catalogModel()` 的 `query` 参数与那一层过滤；重导出面同步去掉两个常量 |
| `index.tsx` | `import { backTarget, rememberPage } from './toolsNav.ts'`、`const TOOLS_PAGE`、`lastNonTools` ref、`goPage` 里的记录逻辑、`backPage` 计算、`React.createElement(ToolsPage, { onBack: … })` ⇒ 改为 `React.createElement(ToolsPage)` |
| **文件级** | `src/client/toolsNav.ts` **整个删除**（`rememberPage`/`backTarget` 只服务那个返回按钮；留着就是死代码） |
| 测试 | `toolsPage.test.ts` 里"④ 返回按钮：index.tsx 的四个接线点"整段删除，替换为「目录页两处不得再出现」的三层检查 + 5 条注入；`toolRegistry.test.ts` 的"② 搜索框本地过滤生效"替换为「搜索链路已删除」的负向断言 |

### 1.2 保留了什么

- **详情页的 `← 工具目录`**（`model.backAction`）：从工具回目录的唯一入口，仍在 `detailView` 最上面。
- 分类标签行（`model.categories`）与三列卡片网格、卡片 chip/标题/说明、整卡可点语义 —— 全部不动。

### 1.3 为什么动了 `index.tsx`（越界说明）

`onBack` 是 `ToolsPage` 的 props，只被那个返回控件使用；`toolsNav.ts` 只被 `index.tsx` 用来算 `backPage`。
把控件删掉而不删这条管道，就会留下"传了但没人用"的死代码（且 `onBack` 会在类型上继续存在，下一个人很容易把它渲染回来）。
因此我在 `index.tsx` 做了**最小改动**（删 import / 删 ref / 删计算 / 删传参），共 `-27 +…` 行；除此之外没碰该文件。
`toolsPage.test.ts` 有断言锁住这三件事（`onBack`/`toolsNav`/`rememberPage` 都不许再出现）。

### 1.4 断言与注入（①）

检查函数 `catalogCleanProblems(files, exists)`（`toolsPage.test.ts`）分四层：

1. **源码层**（剥注释后）：不许出现 `PAGE_BACK_ACTION` / `BackIcon` / `type: 'search'` / `searchPlaceholder` / `matchesQuery` / `searchTextOf` / `props.onBack`，也不许出现「搜索」「返回」这两个**用户可见字样**（含 aria/title/placeholder 位置）；
2. **接线层**：`index.tsx` 不许再出现 `onBack` / `toolsNav` / `rememberPage` / `backTarget`；
3. **文件与导出层**：`src/client/toolsNav.ts` 必须**不存在**；`toolText.ts` 不许再 `export const PAGE_BACK_ACTION|SEARCH_PLACEHOLDER`；
4. **模型层**：`catalogModel()` 不许再有 `searchPlaceholder` / `query` 字段；同时正向确认"该留的还在"（分类标签行、卡片网格、`model.backAction`）。

| 注入 | 关掉什么 | 结果 | 首条失败（节选） |
| --- | --- | --- | --- |
| ①-1 | 返回按钮加回来（`title: '返回'`） | 抓到 | `目录页不许再出现「返回」字样` |
| ①-2 | 搜索框加回来（`type: 'search'` + aria） | 抓到 | `目录页源码里不许再出现「type: 'search'」` |
| ①-3 | `onBack` 又传回 `ToolsPage` | 抓到 | `index.tsx 不许再给 ToolsPage 传 onBack` |
| ①-4 | `toolsNav` 再被 import（且文件又存在） | 抓到 | `尽量… index.tsx 不许再 import toolsNav` / `toolsNav.ts 必须删除` |
| ①-5 | `toolText.ts` 再导出 `SEARCH_PLACEHOLDER` | 抓到 | `toolText.ts 不许再导出 SEARCH_PLACEHOLDER` |

---

## 2. ② 详情页：三段式（Hero → 摘要卡 → 图表卡）

### 2.1 结构与字段（模型 → 页面）

| 段 | 模型字段（`DetailModel`） | 页面锚点（`data-role`） |
| --- | --- | --- |
| 回目录入口 | `model.backAction` | （原有 `Btn`，仍在最上面） |
| ① Hero | `hero.kicker` / `hero.title`（= 工具名）/ `hero.note`；右上角 `ranges.options` + `ranges.selected` | `tool-hero`、`tool-hero-kicker`、`tool-range`、`tool-range-option` |
| ② 摘要卡 | `summary[]`（`{ key, label, value, note }`，0–2 张） | `tool-summary`、`tool-summary-card` |
| ③ 图表卡 | `curve.title` / `kpi.note`（进 title+aria）/ `status` + `statusTitle` / `chartAsOf` / `kpi.cells[]` | `tool-chart-card`、`tool-chart-title`、`tool-status`、`tool-chart-asof`、`tool-kpi-tile` |
| 其后功能区 | `pie` / `market` / `extras` / `boundary`（功能全保留） | `tool-legal`、`tool-legal-line`、`tool-row-note` |

摘要卡的两张（值全部来自真实数据，`tools/globalFlowView.ts`）：

- `资金蛋糕` = **五市场合计规模**（`fmtUsd(payload.totalUsd)`），状态词 = 份额集中度（`美国 占 91.14%`，由真实份额导出）；
- `当前偏好` = **份额榜首市场**（当前显示那一天），副文案 = 轮动文案（回放历史日时如实说明"显示那一天的份额榜首"）。

### 2.2 时间范围：90 / 180 / 365

- 宿主：`FLOW_CURVE_WINDOWS = [90, 180, 365]`、`FLOW_CURVE_WINDOW_MAX = 365`（**一次构建到最大档**）；
  腾讯日线条数从 `260` 提到 `FLOW_CURVE_WINDOW_MAX + 60`（要覆盖 365 个**序列日**：A股/港股约 245 交易日/年）；
  载荷新增 `curve.windowOptions`。
- 客户端：`globalFlowToolData(payload, step, rangeDays)` 从同一条曲线上**切片**（尾部 `rangeDays` 个点），
  切片后的视图用于**所有**按天的计算（回放、合计、饼图、市场表）⇒ 口径一致、切档 0 请求 0 重算；
  超过可用点数 ⇒ 如实给全部（不补齐、不编造）。
- 页面：`payload.at(step, selectedRange ?? undefined)`；`selectedRange = 用户选过的档 ?? entry.ranges.initial`（默认 180，与改动前行为一致）。
- 口径行同步改写为「可选 90 / 180 / 365 个序列日」（不再写死 180）。

### 2.3 KPI 磁贴：四块都来自真实数据

| 磁贴 | 值 | delta | 来源 |
| --- | --- | --- | --- |
| 规模榜首 | `美国 91.14%` | `五日 +0.20pp` | 份额榜首（`top.name` + `fmtSharePct(topShare)`） |
| 五市场合计规模 | `9017.04 亿美元` | 汇率摘要（`美元/人民币 6.6941、美元/港元 7.8473`）或"合计只含有值市场" | `payload.totalUsd` / `rateSummary` |
| 近五日轮动 | `从 韩国 转向 美国（…）` | `明确轮动 / 持平 / 判不了` | `payload.rotation` |
| 数据时刻 | `2026-10-12（实测）` | `快照至 2026-10-12（1 天）` | 当前显示那一日的点 origin |

**没有编造**：参考版那两块（蛋糕温度 / 流动性支持度）我们没有口径 ⇒ **不摆**；`美元指数 DINIW` / `美国 10Y` 虽是真实可接的源，
但本批是界面改动，引入两个新上游 + 降级/缓存口径属于数据层扩容 ⇒ **本批不做**（记在 §6），四块磁贴改用我们真有的四个指标。
断言：磁贴标签恰为这四个、且**禁止**出现 `温度` / `流动性支持` / `美元指数` / `10Y` 字样（反例：塞一个常量磁贴必败）。

### 2.4 长文案压缩（常驻 vs title/aria）

| 文本 | 旧 | 新 |
| --- | --- | --- |
| 状态行 | 一整行：数据时刻 ｜ 取数方式（三层 TTL 细节）｜ 曲线构成（实测/重建）｜ 作废留痕 | **常驻**：`数据时刻 2026-10-12 21:52（北京时间）` + 降级/陈旧标记（`⚠ 上游全部失败 ⇒ 快照回退…，不是实时值` / `快照只读（累积 N 天）` / `⚠ 另有 N 天旧口径快照已作废…`）；**完整版**（取数方式 + 曲线构成 + 窗口 + 留痕）进 `title` 与 `aria-label`（`model.statusTitle`） |
| KPI 口径行 | 面板标题右侧常驻一行 | 进图表卡标题的 `title` / `aria-label`（`tool-chart-title`） |
| 各功能区口径行 | 常驻（保持） | 保持（它们只在各自区块出现一次，不是"图上的长说明"） |

诚实性红线未降级：**降级/陈旧/回退/作废**这类会误导读数的信息一律留在常驻行里（断言逐条锁：`上游全部失败`、`不是实时值`、
`本地还没有任何快照`、`旧口径快照已作废` 必须出现在 `status` 里；`不发上游请求`/`只读本地快照`/`来自最近一次本地快照`
**不许**出现在不该出现的场景）。

### 2.5 断言与注入（②）

`renderWiringProblems(src)`（`toolsPage.test.ts`）检查：`catalogModel`/`detailModel` 接线、`payload.at(step, range)`、
`entry?.ranges?.initial` 默认档、三段式**渲染顺序**（在 `detailView` 函数体里比 `model.backAction` → `heroView` → `summaryCards` → 图表卡锚点）、
各段锚点与字段、范围控件三档来自模型且可点、KPI 磁贴锚点、`AS OF`、状态行 `title`/`aria-label`、边界声明不复用 `tw-hint`。

| 注入 | 关掉什么 | 首条失败（节选） |
| --- | --- | --- |
| ②-1 | Hero 整段删掉 | `三段式缺少 heroView(model, io)` |
| ②-2 | 摘要卡整段删掉 | `三段式缺少 summaryCards(model)` |
| ②-3 | 图表卡锚点改名 | `三段式缺少 'data-role': 'tool-chart-card'` |
| ②-4 | 三段顺序颠倒（摘要在 Hero 前） | `渲染顺序必须是 回目录入口 → Hero → 摘要卡 → 图表卡` |
| ②-5 | 范围档位写死 `[90,180,365]`（绕过模型） | `范围档位必须来自模型` |
| ②-6 | 范围控件去掉 `onRange` | `范围档位必须可点` |
| ②-7 | 默认窗口写死 180（绕过工具声明） | `默认窗口必须来自工具声明` |
| ②-8 | KPI 口径行（缺数据原因）被丢掉 | `KPI 口径行必须进图表卡标题的 title/aria-label` |
| ②-9 | 状态行不再把完整口径放进 title/aria | `状态行的完整版必须进 title 与 aria-label` |
| ②-10/11/12 | 边界声明 / 逐行缺口原因 / 状态行复用 `tw-hint` | `…不许复用 tw-hint（紧凑/隐身视图会把它整块隐藏）` |
| ②-13 | 回放滑块改成固定文本 | `回放滑块必须渲染` |
| ②-14 | KPI delta 不渲染 | `KPI 的 delta（变化）必须渲染` |
| ②-15 | 卡片网格改两列 | `卡片网格必须是三列` |
| ②-16 | 空数据占位不再渲染 | `详情页功能区未渲染：model.pie.empty` |

另有三条**行为级**断言（不只查源码）：

- `tools/globalFlowView.test.ts`「② 时间范围三档」：切到 90 / 180 / 365 后，曲线点数、每条序列点数、首末日期
  （`days[0] === points[365-range]`、`days[last] === points[364]`）逐项对齐；切片后份额合计仍 100%；
  窗口大于可用点数给全部；**且切档是纯函数**（传入载荷 JSON 前后一致）。
- `toolRegistry.test.ts`「⑥ 三段式骨架」：Hero 标题 = 工具名（逐字）、kicker/说明非空、无数据时 `summary=[]`/`chartAsOf=null`；
  范围三档 = `[90,180,365]` 且与宿主 `FLOW_CURVE_WINDOWS` **同一份口径**（跨模块对比，防两处漂移）、默认档 180；
  反例（写死一档）必败。
- `toolRegistry.test.ts`「③(页面) KPI 磁贴」：四块标签恰为四个真指标、无数据时全 `未取到`+`null`、禁止无源口径字样。

---

## 3. 渲染/视觉说明（图 2 → 图 3 对齐点）

- Hero 的 kicker 复用了卡片同款小标签样式（主题 token `--tw-accent-soft` / `--tw-accent`）。
- 时间范围控件复用既有 `.tw-tabs` / `.tw-tab`（与分类标签行同一套观感），带 `aria-pressed` 与说明性 `title`。
- 图表卡：标题左、`AS OF <日期>` 右；下面是四块磁贴（同一行 `repeat(4, 1fr)`，窄屏自动换行）；
  主图纵轴刻度**移到右侧**（向参考版对齐），图例仍在图下方（`data-role="tool-chart-legend"`），缺数据的点仍画**断**。
- 未改 `styles.ts`（本批我确实没动它；观感全部走既有 class 与内联主题 token）。

---

## 4. 红线自查

| 红线 | 本批如何守住 |
| --- | --- |
| 缺数据「未取到 + 原因」，不许 0 顶替 | 磁贴/摘要卡/曲线/饼图/市场表在无数据时全走 `未取到` + 原因（既有断言不变）；新增 `summary=[]`、`chartAsOf=null` 的无数据形态 |
| 无数据时整份模型**零阿拉伯数字** | 仍成立；唯一例外是新增的 `ranges`（90/180/365 —— 声明在工具文件里的**UI 契约常量**，不是编造值），该例外被单独钉死（必须等于 `[90,180,365]` 且与宿主窗口集合一致），扫描前把 `ranges` 归一化 |
| 边界声明默认可见 | `data-role="tool-legal-line"` + 内联样式（**不复用** `tw-hint`）；注入"改回 tw-hint"必败 |
| 常驻不留长文案、但降级事实不许丢 | 见 §2.4；降级/回退/作废/无快照四类标记常驻，其余进 title/aria |
| 不编造 KPI | 见 §2.3；禁用词断言 + 常量磁贴反例注入 |

---

## 5. 门禁与验证

### 5.1 我这一侧（本轮改动）

```
npm run typecheck  → 我改动的文件（ToolsPage / toolRegistry / toolText / toolCardView / tools/cake /
                     tools/globalFlowView / host/globalFlow / index.tsx）零错误
node --test 相关文件（默认时区 + TZ=UTC）→ 全绿：
  src/client/toolsPage.test.ts          5/5
  src/client/toolRegistry.test.ts      14/14
  src/client/tools/globalFlowView.test.ts  8/8
  src/client/toolCardView.test.ts       全部通过
  src/host/globalFlow.test.ts           24/24
```

### 5.2 全仓 `npm run check`

**最终（本批收口）**：

```
EXIT=0
ℹ tests 589 / pass 589 / fail 0      （默认时区）
ℹ tests 589 / pass 589 / fail 0      （TZ=UTC）
ALL HOST CHECKS PASSED (live probes soft)
```

末尾三行：

```
> dsh-tradewatcher@0.80.0 build
> node build.mjs
built lib/index.js + lib/client.js （v0.80.0，客户端片段校验通过：73 项）
```

- 基线 579 ⇒ 本批 589（+10：本批新增/改写的断言 + 并行写入线的新用例）。
- `build.mjs` 零改动 ⇒ 片段校验仍是 **73 项**（我先核对过锁定片段里**没有**任何本批涉及的字面量：
  `返回` / `搜索` / `工具目录` / 蛋糕工具相关字符串都不在锁里）。
- 期间的一次红：**如实记录** —— 第一次全量跑时 TZ=UTC 有 1 条失败（`src/client/marketRefactor.test.ts`
  「② 涨跌趋势：一行 5 个内联统计》），同时 `npm run typecheck` 报 `src/client/MarketPage.tsx` 的
  `Cannot find name 'countsNote'`；那是**并行写入线**（`impl-client` 的涨跌分布页）当时的半成品状态，
  与本文改动无关（我未触碰 `MarketPage.tsx` / `distView.ts` / `marketRefactor.test.ts` / `styles.ts`）。
  我没有为了"让 check 绿"去改别人的文件；那条线落地后复跑即为上面的 EXIT=0。

### 5.3 真网络复核（隔离 `DSH_HOME=/tmp/tools3-live-*`，2026-10-13 21:52）

```
宿主构建窗口 = 365 点；可选 = 90 / 180 / 365
   90 日档 ⇒ 曲线 90 点，首末 = 2026-06-09 → 2026-10-13；份额合计 = 100.00%
  180 日档 ⇒ 曲线 180 点，首末 = 2026-02-03 → 2026-10-13；份额合计 = 100.00%
  365 日档 ⇒ 曲线 365 点，首末 = 2025-05-19 → 2026-10-13；份额合计 = 100.00%
Hero = 宏观 | 全球轮动 / 全球资金流蛋糕模型
Hero 说明 = 五个市场的宽基 ETF 规模权重：比值、份额变化与轮动方向。它衡量的是「相对强弱」，不是真实跨境资金净流入。
范围控件 = 90 / 180 / 365 ｜选中 = 180
AS OF = 2026-10-13
摘要卡 资金蛋糕 = 9011.28 亿美元（美国 占 91.20%）
摘要卡 当前偏好 = 美国（从 韩国 转向 美国（5 日份额 -0.24pp → +0.29pp））
磁贴 规模榜首 = 美国 91.20%｜五日 +0.29pp
磁贴 五市场合计规模 = 9011.28 亿美元｜汇率：美元/人民币 6.6920、美元/港元 7.8475
磁贴 近五日轮动 = 从 韩国 转向 美国（5 日份额 -0.24pp → +0.29pp）｜明确轮动
磁贴 数据时刻 = 2026-10-13（实测）｜快照至 2026-10-13（1 天）
常驻状态行 = 数据时刻 2026-10-13 21:52（北京时间）
状态行完整版（进 title/aria）= 上游现取（宿主三层 TTL：现价类 30 分钟 / 日线 12 小时 / 载荷 10 分钟）｜曲线 180 个序列日（实测 1 / 重建 179）｜窗口 180 / 可选 90 / 180 / 365 个序列日
边界声明条数 = 13 ｜免责在首条 = true
```

（三档共用一次取数：冷启动上游请求数与改动前同量级 —— 只是日线条数从 260 提到 425，覆盖 365 个序列日。）

---

## 6. 未做项 / 诚实披露

| 项 | 说明 |
| --- | --- |
| KPI 磁贴没有接美元指数 / 美债 10Y | 方案②需新增两个上游（`DINIW`、美债 10Y）+ 各自的降级/缓存/口径行，属于数据层扩容；本批是界面改动 ⇒ 采用方案①（我们真有的四个指标），并在断言里禁止无源口径字样 |
| 排序/密度 | 摘要卡固定 1–2 张（`repeat(min(2, n), 1fr)`）；磁贴 `repeat(4, 1fr)`，窄屏靠 `flexWrap`/`minWidth:0` 兜底，未做响应式断点（仓库既有页面同样不分断点） |
| 浏览器像素级验证 | 仓库无 DOM 测试环境（无 jsdom），沿用既有的"源码接线 + 纯函数行为"两层断言；没有做渲染后的计算样式比对 |
| `tools` 行的装载 | 新页签/新路由仍需**重启** `dsh web` 才在运行实例里可见（沿用 `AUDIT-IMPL45.md` §8.1；本轮未重启） |
| 视觉细节 | 纵轴已移到右侧、图例保留；参考版的其它装饰（渐变、圆角进度条等）未做 —— 用户只要求"视觉层级与分段向参考版靠拢"，未要求逐像素 |
| 组件版本号 | 未动；构建产物仍是当前版本号（发布收口由 Lead 处理） |
