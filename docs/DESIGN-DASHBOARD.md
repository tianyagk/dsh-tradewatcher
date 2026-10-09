# 大盘页信息密度重设计（可执行规范）

> **未落地**（v0.33.1 已回退）：这是大盘页布局的设计稿，**源码里没有 `.tw-board`**，
> 当前大盘页是 12 栏网格（见 README「宽屏布局」）。保留此文件只为记录取舍过程，不要再照着它改代码。

取证：`src/client/MarketPage.tsx`(484)、`src/client/styles.ts`(447)、`src/client/breadthView.ts`、`src/client/api.ts`、`src/client/RescuePanel.tsx:357`、`src/client/index.tsx:347/388-396`、`src/host/routes.ts:285-341`、`src/host/breadth.ts`、`docs/AUDIT-UI.md`、`README.md` 口径规范与 build.mjs 片段表。只读，未改任何源码。
不冲突声明：不推翻 AUDIT-UI 任何结论（P0-2 缺失显式化、P0-5/P0-6 窄面板、P1-5 原因可聚焦、P1-8/9 列填充与 1080 断点、P2-4 表体内滚全部保留并复用）。
硬约束：`styles.test.ts` 断言 **CSS 里所有 `@media (min-width:Npx)` 必须 == `WIDE_MIN_PX`(1080)** —— 本规范不引入任何别的 min-width 数值。

## 0. 现状量化（用户截图 2142×615）

| 现象 | 数字算据 |
| --- | --- |
| 6 张 `.tw-stat` 卡 | padding 6/7 + `.k` 11×1.5 + `.v` 15×1.35 ≈ **52px（实机 60px）**；3 张是 `—` ⇒ 约 180px 画了三个横杠 |
| 指数表 6 行 | `.tw-table td` = 4+18+4+1 = **27px/行**，6 行 + 表头 ≈ 190px |
| 横向摊开 | `.tw-table{width:100%}` 把 6 列摊在 2100px 上，名称在左、数字贴列右缘，单行跨 300px+ |
| 首屏利用率 | `.tw-body` 视口 ≈ 615 − (topbar 45 + 行情条 3×62 + 页签 45) ≈ **339px**，内容只用 ~300px，第 4 块落在首屏外 |
| 数字面 | 首屏 ≈ **20 个**（爱盯盘同屏 ≈ 40+） |

## 1. 网格定义

DOM：保留 `.tw-body`（滚动容器 / padding 10 / gap 12 不动），其内**唯一子元素**是新增网格容器 `.tw-board`；所有面板是它的直接子元素并带 `data-span`。DOM 顺序固定 `B1,B2,B3,B4,B5`（单列档的阅读顺序就是它），**不用 `grid-auto-flow:dense`**（缺块时重排会破坏名次与阅读顺序）。

```
.tw-board{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;align-content:start}
@media (min-width:1080px){
  .tw-board{grid-template-columns:repeat(12,minmax(0,1fr))}
  .tw-board>[data-span="5"]{grid-column:span 5}
  .tw-board>[data-span="7"]{grid-column:span 7}
  .tw-board>[data-span="12"]{grid-column:span 12}
}
```

列宽公式 `列宽 = (块内容宽 − 2×10 − 11×10) / 12`：1440 视口（内容 1420）≈ 109px/列 ⇒ span5 ≈ 586px、span7 ≈ 834px、span12 ≈ 1420px；1080 面板（内容 1060）⇒ span5 436px、span7 614px（B2 每卡仍有 190px）。
断点**只有 1080**（= `WIDE_MIN_PX`，与列头/多列同源）；窄化一律用 max-width：`<1080` 全单列、`<900` B2 两列、`<520` B2 单列。不写 `grid-auto-rows`，行高由下方块高预算约束。

## 2. 信息块：位置 / span / 高度预算 / 优先级

面板通用开销（`.tw-panel` padding 10/12 + `.tw-panel-h` ≈ 25）≈ **35px 头 + 10px 底**。

| 优先级 | 块 | ≥1080 位置 | span | 高度预算 | 行数预算 |
| --- | --- | --- | --- | --- | --- |
| P0 | **B1 市场宽度** | 行1 左 | 5 | **≤160px** | 头 35 + 指标行 25×3 + 分布条 34 + 底 10 |
| P0 | **B2 指数矩阵** | 行1 右 | 7 | **≤150px** | 头 35 + 卡 45×2 + gap 8 + 底 10 |
| P0 | **B3 护盘信号（收起态）** | 行2 | 12 | **≤150px** | 头 35 + 摘要 22 + 通道卡 56 + 口径 18 + 底 10 |
| P1 | **B4 板块/资金/ETF** | 行3 左 | 7 | 表体 ≤ `min(46vh,360px)` | 表头 25 + 段控 26 + 口径 18 + 表体 |
| P1 | **B5 个股查询/详情** | 行3 右 | 5 | 与 B4 同排、自适应 | 搜索 32 + 详情卡 |
| P2 | B6 指数分时（可选） | 行4 | 12 | 200px | 不进首屏承诺 |

首屏算术（1440×900，`.tw-body` 视口 ≥560px）：行1 高 = max(B1 160, B2 150) = **160**，加 gap 10 与行2（B3 150）= **320px**；B4 自 330 起，`首屏表体行数 = floor((H_body − 330 − 69) / 27)`（69 = 表头 25 + 段控 26 + 口径 18）。**必须 ≥4 行**（H=560 ⇒ 5 行），**目标 ≥6 行**（需再压 30px：分布条 34→24 或口径行并入摘要行）。

## 3. 每块内部规范

**B1 市场宽度（586px）**：大盘页弃用 `.tw-stat` 两行卡，改单行指标条（**不改 `.tw-stat/.tw-statrow`**——`PortfolioPage.tsx:229/321` 在用，且 `.tw-stat .v` 在数字模糊白名单里）：

```
.tw-metricrow{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:baseline;padding:2px 0}
.tw-metric{display:inline-flex;align-items:baseline;gap:6px;min-width:0}
.tw-metric .k{font-size:11px;color:var(--tw-muted);white-space:nowrap;line-height:1.4}
.tw-metric .v{font-family:var(--tw-mono);font-size:15px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.4}
.tw-metric-sep{width:1px;height:12px;background:var(--tw-border);align-self:center}
```
一行 = 2+21+2 = **25px**（替代每格 52–60px）。三行：① 上涨/下跌/平盘（`breadthCells(sh,sz)` + `dirClass(...,redUp)`）② 沪市成交额/深市成交额/两市合计（`sh.amount`、`sz.amount`、`cells.amount`）③ 上涨占比（本地 `up/(up+down+even)`，不必等路由）+ 近 N 日分位（`breadth.percentile.pct/n`）。
第 ③ 行右侧加**历史分布条**（34px 高、60 根 1.5px 竖条）：数据用 `breadth.percentile.samples`（≤60 个历史上涨占比，升序，**现有字段**），当前值画一条竖线；标签必须写 **「近 N 日每日上涨占比的分布（不是当日涨跌分档）」**，否则会被读成爱盯盘那张直方图。

**B2 指数矩阵（834px）**：6 指数 = `1.000001/0.399001/0.399006/1.000688/1.000300/1.000905`，**全部已在行情条同一轮轮询中**（`TW_ROWS`），零新增请求。`repeat(3,minmax(0,1fr))` × 2 行；每卡 **45px**、2 行：① 名称 11px + 右对齐涨跌幅 chip ② 现价 15px mono + 右侧成交额 11px；上/下跌家数放 `aria-label`（该字段常缺，占一行不值）。卡可点开详情：沿用现有 `openDetail` + `tabIndex=0` + `role=button` + Enter/Space（AUDIT-UI 已确认无障碍正确），`min-width:170px`。

**B3 护盘信号（行2，1420px）**：标题必须保留「护盘信号」四字（build.mjs 片段表锁着）。收起态固定 3 行：摘要行（等级 + `snapshot.summary` + 指数/时段系数，22px）、6 条宽基通道缩略（`repeat(6,minmax(0,1fr))`，每卡 228px，一行 56px：名称/量能倍数/超大单净额）、口径行 18px。**改默认展开判据**：`RescuePanel.tsx:357` 现为 `expanded = manualOpen ?? (level>=2 || etfs.length===0)`——`etfs.length===0`（取数失败）会**默认展开一个空壳**；改为 `etfs.length===0` ⇒ 收起 + 一行 `— + 原因 + 「重试」`（≤60px）。展开态由手动或 `level>=2` 触发，允许撑高（在首屏外）。

**B4 板块/资金/ETF（span7）**：表 `minWidth` 640→720；`.tw-tablewrap` 的 `max-height:46vh` → `min(46vh,360px)`（同时落地 AUDIT-UI P2-4）。数值列封顶 `.tw-board .tw-table td,.tw-board .tw-table th{max-width:200px}`，现价/涨跌列 `width:120px`，避免 2142px 宽时数字飘到 300px 外。首屏承诺表头 + ≥4 行 + 口径行（其中 **「占比排序仅本页 40 条内」必须常显**，AUDIT-COPY 已定）。

**B5 个股/基金查询（span5）**：未选中 ⇒ 搜索框 + **一行** 18px 提示（现 `tw-hint` 的 margin 2/6 压成 0）；选中 ⇒ 详情卡（`Sparkline` 560×170 + kv 网格）在 586px 下 `repeat(auto-fit,minmax(150px,1fr))` 自然退为 2 列，高度允许超出首屏。

## 4. 缺失时怎么收缩（核心）

原则：**缺失只允许影响"一格/一行"，不得改变块高超过 ±8px；只有整块无源才允许塌成一行。**

| 块 | 情形 | 收缩行为 | 判据（代码层） |
| --- | --- | --- | --- |
| B1 | `countsOk===false` | 上涨/下跌/平盘**三格合并成一格** `涨跌家数 —`（宽=3 格），原因在该行尾出现**一次**，行高仍 25px | `breadthCells(...).countsOk`（勿自算） |
| B1 | `amountOk===false` | 只有该格 `—`；沪/深分项按 `sh.amount===null` 各自判定 | `cells.amountOk` |
| B1 | `percentile.pct===null` | 显示 `分位不可算` / `样本 n/5 天`（README 的 5 天护栏），**不显示 0** | `percentile.sampleSmall` |
| B2 | `price===null` | 卡保留名称 + `—` + `aria-label` 原因，卡高不变 | `q?.price == null` |
| B2 | `up/down` 任一 null | 副行/`aria-label` 用 `UPDOWN_MISSING_NOTE` | 现有 `upDownPair().ok` |
| B3 | `snapshot===null` | 一行 `— + 原因 + 重试`（≤60px），**不留 150px 空壳** | `data?.snapshot ?? null` |
| B3 | 因子缺失 | 沿用现有「因子 3/6」徽标，**不许把缺因子画成 0 分** | `snapshot.completeness` |
| B4 | `boardError!==null` | 只显示错误行，**表体 0 行**（不保留空行占位） | 现有 |
| B5 | `detailError` / `trend===null` | 一行错误 + 重试 / `无当日分时数据`（现有文案） | 现有 |
| 全局 | 任何 `—` | 必须 `tabIndex=0` + `role=note` + `aria-label`（AUDIT-UI P1-5 既有要求，新增的 `—` 一并遵守） | — |

## 5. 密度目标与可量化验收

1440×900 首屏清单（面板宽 = 视口 − 侧栏，仍 ≥1080）：① B1 完整（家数 + 沪/深/两市成交额 + 占比 + 分位 + 分布条）② B2 完整（6 张指数卡）③ B3 完整（收起态：摘要 + 6 条通道）④ B4 表头 + **≥4 行**（目标 6 行）。

| # | 指标 | 阈值 |
| --- | --- | --- |
| V1 | 首屏块数 / 数字面数 | ≥4 块（3 完整 + 1 部分）；数字面 **≥60**（B1 8 + B2 18 + B3 15 + B4 行×5；现 ≈20） |
| V2 | 块高 | B1 ≤160、B2 ≤150、B3 ≤150；行1 高 = max(B1,B2) ≤160，**行1+行2 ≤320px**（1440 下 320±8） |
| V3 | 横向利用率 | 块内最后一行内容右边界 / 块宽 **≥0.70**；数值列 ≤200px（"数字离名称 >600px"即不合格） |
| V4 | 缺失态 | `countsOk===false` 时 B1 顶部三格高度 **≤25px**（现 60px×3），原因文本在可见界面**只出现一次** |
| V5 | 占位 | 装饰/骨架/空态面积不超预算；任意块加载态高度 ≤ 该块预算 |
| V6 | 回归 2142×615 | 首屏出现 B1+B2+B3 三块完整（合计 ≤320px），且不出现"6 张 60px 的 `—` 卡" |
| V7 | 窄面板 <1080 | 单列不丢控件（B4 段控换行，AUDIT-UI P0-6）；B2 退 2 列、指数卡仍可点 |

可执行断言（新增 `src/client/boardLayout.ts`，**不 import react**，中文用例名）：`boardSpans(width)`（`<1080` 全单列；`≥1080` ⇒ `{b1:5,b2:7,b3:12,b4:7,b5:5}`；1440 与 2142 同档）；`breadthMetrics(cells)`（`countsOk===false ⇒ 家数项数===1 且不含 0`；`countsOk===true 且真值全 0 ⇒ 项数===3 且显示 0`，真 0 不得被误判为缺失）；`percentileBar(samples,value)`（空样本 ⇒ `{ok:false,reason}`，**不返回全 0 数组**；`samples` 升序且长度 ≤ window）。`styles.test.ts` 的 1080 断言继续跑绿。

## 6. 禁止项（红线）

- 不新增依赖、不引图表库；分布条/矩阵用现有自绘 SVG（`charts.tsx`）。
- 不造装饰填充：无数据不用灰块/占位图/大空态；`—` + 原因本体不许改（AUDIT-COPY「保留 10」）。
- 不引入预测（"预测全天成交额"）与导流（`免5`/`开户`）；不做涨停/跌停家数（§7）。
- 缺失不许 0 顶替、不许用 0 或图形遮住缺失（README 口径规范）。
- **新增任何数字展示面必须同时加进 `styles.ts` 两条 `data-blur=1` 清单**（`.tw-metric .v`、分布条数值面），否则隐身档漏数。
- 不许删 build.mjs 片段表里与大盘页相关的串：`日分位`、`护盘信号`、`板块涨跌来自腾讯备用源`、`「主力净流入」仅东财提供`、`净占比`、`不适用`、`点击查看详情`。
- 不许改 `.tw-stat/.tw-statrow`（持仓页在用）；大盘页一律用新类 `.tw-metric*`。
- 不 commit / push；不访问任何上游站点。

## 7. 数据可得性（逐块）

| 块 / 字段 | 来源 | 状态 |
| --- | --- | --- |
| B1 家数 | `/quotes`(1.000001/0.399001) `f104/105/106` → `breadthCells` | **现有字段**（仅东财；备用源缺 ⇒ `—`）。task-15 正加"东财 clist 统计 / 新浪边界搜索"自统计链，落地后须在 B1 口径行显示其 `source` + 统计完成时刻 |
| B1 沪/深/两市成交额 | `q.amount` 分项 + `cells.amount` 合计 | **现有字段** |
| B1 上涨占比 | 本地 `up/(up+down+even)`；路由 `breadth.current.ratio` | **现有字段** |
| B1 分位与样本分布 | `/tradewatcher/breadth` 的 `percentile.{value,pct,n,sampleSmall,samples[]}` | **现有字段** |
| B1 昨日成交额 / 较昨日变动 | `breadth.json` 存了每日 `amount`，但路由**未暴露历史** | **需新增只读字段（`history[]` 或 `prevAmount`）→ 当前不可得** |
| B2 6 指数行情 | 与行情条同一轮 `/quotes` | **现有字段，零新增请求** |
| B2 指数分时缩略 | `api.trend` + 现有 `MiniTrend`/`mini.ts`（90s memo、有界并发、失败留旧图） | 接口与组件现有，**需新增 6 路取数（6 次/90s）**；可选增强，不进首屏承诺 |
| B3 护盘 | `/tradewatcher/rescue`（六因子/宽基通道/时间线/历史回看） | **现有字段** |
| B4 板块/资金/ETF | `/tradewatcher/board`（40/页，total ≤100，腾讯/新浪备用源） | **现有字段** |
| B5 搜索/详情 | `/suggest` `/detail` `/trend` | **现有字段** |

**明确不做 / 当前不可得**（不许设计这些块）：
- **当日涨跌分布直方图（分档计数）**：现有源只有 up/down/even 三个总数，task-15 的统计链也只出三个总数 ⇒ **当前不可得**（要做得扩统计链产出分桶，见 §8）；替代物 = B1 的历史分位分布（现有字段，口径写清）。
- **涨跌家数分时曲线**：无盘中家数时间序列（`breadth.ts` 只在收盘后记一条日快照）⇒ **当前不可得**。
- **两融走势**：无融资融券数据源 ⇒ **当前不可得**。
- **涨停/跌停家数**：需涨跌停价 + ST/科创规则 ⇒ **不做**（另一任务已决）。
- **预测全天成交额/家数** ⇒ **不做**（本仓库不做预测）。
- **分单资金流历史（超大单曲线）**：东财 fflow 仅当日 1 行、push2his 常限流 ⇒ **当前不可得**。
- **自选异动**：链路存在（`/anomaly?ids=`），但大盘页拿不到自选 ids（`watchIds` 只在自选页挂载后由 `onSymbols` 上报，`index.tsx:347`）⇒ **需接线（新增 `all=1` 入参或把 ids 传进 MarketPage），当前不可得**；接线成功可放 B6（span12，行4）。

## 8. 未定项（交 Lead）

1. 是否扩统计链产出**当日分档**（东财 clist 拉全量 `pct` 时天然可顺带分桶；新浪边界搜索不可）——涉及 task-15 作用域与新增回包字段，本规范不擅自设计。
2. `/tradewatcher/breadth` 是否暴露 `history[]`（昨日成交额与"较昨日"的唯一缺口）。
3. 大盘页是否接自选 ids（异动块进首屏的前提）。
4. 指数分时缩略图是否上（6 路/90s 取数成本 vs 首屏观感）。
5. 1080 断点按**视口宽**（现状 media query）而非面板宽，DSH 侧栏展开时会误判；修法需容器查询 `@container`，属独立改动（与 AUDIT-UI U-2 同源），本次不动。

自证清单：`npm run check` 全绿（含新增 `boardLayout` 断言与既有 1080 断言）+ 三张截图（1440×900 / 2142×615 / 700 窄面板）+ 构造缺失态（`quotes['1.000001'].up = null`）验证 V4，并贴 `breadthMetrics` 实测输出。
