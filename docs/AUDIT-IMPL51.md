# AUDIT-IMPL51 —— 【大盘】「涨跌分布」模块按参考版（Arkvol）重排

- 基线：`main` @ `5c8a528`（v0.80.0），`npm run check` = **579 × 2 全绿**（我用 `git worktree` 在 HEAD 干跑确认）
- 本轮结果：**589 × 2 全绿**（+8 条断言：新建 `src/client/distLayout.test.ts`；另 `marketRefactor.test.ts` 有 1 条按新结构改写）
  - ⚠ 交付时树里还有另一批的未提交改动（`ToolsPage.tsx`/`globalFlow*`/`toolRegistry*` 等，见文末"环境说明"）；**我的改动只落在**
    `MarketPage.tsx`、`styles.ts`、新建 `distView.ts`/`distLayout.test.ts`、`marketRefactor.test.ts`
- `build.mjs` **零改动**（73 项片段校验通过）；未 commit / 未装 bundle / 未动 profile / **未重启服务**

## 1. 按参考版重排后的结构

```
.tw-panel  涨跌分布（沪深两市）
└─ [data-role=dist-cols][data-cols=2]
   ├─ 左列 .tw-dist-col
   │   ├─ [data-role=dist-trend]   涨跌趋势   ← 小色条 + 标题 + 副标题「沪深两市」
   │   │    第一行：上涨 平盘 下跌 涨停 跌停（**一行 5 个内联统计**，不做磁贴）
   │   │    第二行（小字）：上涨占比 · 近 N 日分位 · 快照 N/M 天（口径/样本全在悬停）
   │   ├─ [data-role=dist-volume]  成交量     ← 小色条 + 标题
   │   │    一行 4 个内联统计：当日成交额 昨日成交 较昨日变动（按 redUp 着色）预测全天
   │   └─ [data-role=dist-margin]  两融走势   ← 小色条 + 标题 + 副标题「本插件未集成两融数据源」+ 图例行
   │        图例：两融余额 / 上证指数 / 融资净买（各带「未取到」+ 悬停原因）
   └─ 右列 .tw-dist-col
       ├─ [data-role=dist-hist]     涨跌分布   ← [data-role=dist-chart]
       │    纵轴 [data-role=dist-axis]（整洁刻度）+ 网格线 [data-role=dist-gridline] + 柱顶标数 + 档位标签
       └─ [data-role=dist-intraday]  日内家数   ← 图例行：上涨家数 / 下跌家数（各「未取到」+ 悬停原因）
.tw-panel  [data-role=index-table]  指数行情   ← **从本模块移出**，与上面同级（自带标题；表头 6 列、点行看详情不变）
```

对照参考版的五点差异，逐条落实：

| 参考版差异 | 处置 |
|---|---|
| ① `涨跌趋势` 用大磁贴 | 改为**一行 5 个内联统计**（`.tw-dist-inline` + `item()`），磁贴类名（`tw-statrow`/`tw-stat`/`statCell`）在本页**已无** |
| ② `成交量` 竖排列表 | 改为**一行 4 个内联统计**；`tw-dist-kv` 已不在本段 |
| ③ `两融走势` 只有两行「未取到」 | 改为 小色条 + 标题 + 副标题 + **图例行**（三序列名都在，各带悬停原因） |
| ④ 直方图缺纵轴与网格线 | 补 **纵轴**（整洁刻度，值域按数据取整 1/2/5×10ⁿ）+ **虚线网格**；柱高改按**轴的上界**归一（与网格对齐） |
| ⑤ 多出三块 | `上证`/`深成` 两张大卡**按用户决定直接删除**（值仍在移出的指数表里可见）；`上涨占比` 行**保留**但压成趋势段下的**一行小字**（含样本/快照说明，过长进悬停）；**指数表移出**为独立区块 |

**常驻文案压缩**：参考版每段只有"标题 + 数字"。原先铺在正文的口径说明（成交额口径、昨日快照是否定稿、分位定义与样本、快照窗口、自统计时刻、以及五处"未取到"的原因）
**全部进 `title` / `aria-label`** —— 常驻可见处只剩标签、数字与「未取到」四个字。

## 2. 红线：无源项仍写「未取到」，不许编数

| 项 | 常驻可见 | 悬停/读屏 |
|---|---|---|
| 涨停 / 跌停 | `未取到` | `LIMIT_REASON`（指数行情只有 f104/f105/f106，无涨停/跌停字段；判定需板块与 ST 规则 ⇒ 不做） |
| 昨日成交（无本地快照） | `未取到` | 「本地没有上一交易日的收盘快照 —— 不用今天的数顶替」 |
| 较昨日变动（缺昨日） | `未取到` | 「取不到昨日成交就无法算变动（不是 0）」 |
| 预测全天 | `未取到` | `FORECAST_REASON`（没有日内采样与校准基准 ⇒ 任何"预测"都是编的） |
| 两融余额 / 融资净买 | `未取到` | `MARGIN_REASON`（未集成两融数据源；需新路由 + 缓存 + 归属） |
| 日内上涨/下跌家数 | `未取到` | `INTRADAY_REASON`（宿主只按交易日存快照，无日内序列） |

**没有为对齐布局编任何数**；`上涨/平盘/下跌` 无数据时是 `—`（原因进悬停），不是 0。

## 3. 断言与反例注入（`src/client/distLayout.test.ts`，8 条）

| # | 断言 | 反例注入（必须失败） |
|---|---|---|
| ① | 两列（`data-cols=2`）＋五个分段 `seg(标题, role)` 恰好 5 个（左 3 右 2）＋右列顺序 分布→日内 | —— |
| ①b | 趋势段内不得有 `item('上证')`/`item('深成')`；全页不得有 `tw-statrow`；指数表标题与 `cnIndices.map` 仍在 | 把「上证」卡加回趋势段 ⇒ 判据非空 ⇒ `assert.throws` |
| ② | 趋势段用 `inline(`、**无**磁贴写法、恰好 5 个内联项（上涨/平盘/下跌/涨停/跌停）、`上涨占比` 小字那行仍在 | 内联行换回 `tw-statrow` ⇒ 判据非空 ⇒ `assert.throws` |
| ②b | 成交量段 4 个内联项、`较昨日变动` 按 `redUp` 着色、无 `tw-dist-kv` | —— |
| ③ | 六处无源项都是 `'未取到'` 且同一调用点带原因常量；昨日/较昨日缺数据也是「未取到」 | 把「预测全天」渲染成 `'0'` ⇒ `assert.throws` |
| ④ | 渲染里必须有 `dist-axis` / `dist-ytick` / `dist-gridline`，且轴由 `distAxisOf(d.counts)` 算出；纯函数语义（含 0、上界 ≥ 峰值、步长整洁、柱高 ≤100%、0 ⇒ 0、全 0 不崩） | 去掉 `dist-axis` ⇒ `assert.throws` |
| ⑤ | 指数表是**与模块同级**的独立 `tw-panel`（`data-role=index-table`）、自带标题、表头 6 列、`onClick: () => openDetail(...)` 仍在 | 把 `<table>` 换成 `null`（删而非移）⇒ `assert.throws` |
| ⑥ | 重排用到的 9 个类名在 `styles.ts` 里都有样式（标记 ↔ 样式不脱节） | 删掉 `.tw-dist-axis` 样式 ⇒ `assert.throws` |

## 4. 关于"渲染存在"这一层的**诚实说明**

本仓库 `node_modules` 里**没有** `react` / `react-dom`（客户端半区由宿主提供，插件侧只在打包时把它们当 external）⇒
测试进程**无法真渲染组件**。因此 ④ 的"纵轴与网格线存在"是这样落的：

1. 断言**真实创建调用**里的 `data-role`（`dist-axis` / `dist-ytick` / `dist-gridline`）——它们就长在渲染出来的 DOM 上；
2. 轴与柱高的**数值**由纯函数 `distAxisOf` / `distBarPctOf` 承担，逐条断言语义（含 0、整洁步长、≤100%、0 ⇒ 0）；
3. 样式存在性单独断言（⑥）。

⇒ 我没法在测试里贴"真渲染的 DOM 片段"。要那一层证据需要宿主环境（本机 `dsh web` 跑的是旧构建，且用户要求**不重启**），
故**未做真页面复核**（见 §6 未做项）。

## 5. 测试条数

| | 条数（每时区） |
|---|---|
| 基线（v0.80.0 / HEAD） | 579 |
| 新建 `distLayout.test.ts` | +8 |
| `marketRefactor.test.ts` 改写 1 条（② 未取到的格子适配新 helper） | ±0 |
| （同树另一批 `globalFlow`/`toolRegistry` 的改动） | +2 |
| **本轮之后实测** | **589** |

```
ℹ tests 589
ℹ pass 589
ℹ fail 0        （默认时区与 TZ=UTC 各一次）
ALL HOST CHECKS PASSED (live probes soft)
built lib/index.js + lib/client.js （v0.80.0，客户端片段校验通过：73 项）
```

## 6. 未做项与环境说明

1. **未做真页面复核**：用户要求不重启服务 ⇒ 线上仍是旧构建。发布后建议在【大盘】页核对：
   (a) 左列三段是不是"小色条 + 标题 + 一行内联"；(b) 直方图有没有纵轴与虚线网格；(c) 指数表是不是独立区块（有「指数行情」标题）；
   (d) 悬停「未取到」能读到原因。
2. **两融段没有图表区**：参考版有副标题 + 图例 + 图区，但两融**没有任何数据源** ⇒ 只画图例会退化成一个空框（误导），
   故保留"副标题 + 图例 + 未取到 + 原因"，与红线一致。若将来接入两融源，这一段按参考版补图即可。
3. **日内家数不是折线**：宿主只按交易日存快照（无日内序列）⇒ 结构位留了图例行，但没有画线（原因在悬停）。
   要真画线得先加"日内采样 + 存储"（另一条数据管道）。
4. **另一批的未提交改动同时在树里**（`ToolsPage.tsx` / `tools/*` / `globalFlow*` / `toolRegistry*`，含 `toolsNav.ts` 的删除）——
   我**没有碰**这些文件；`npm run check` 在我这次运行里是 589 全绿，但**树不是只含我的改动**，
   交付/提交时请把两批分开看。（本轮开始时我用 `git worktree add /tmp/base51 HEAD` 干跑过：HEAD 本身 579 全绿、`toolRegistry.test.ts` 12/12。）

---

# 追加（v0.81.1）：移除【指数行情】模块 + 归属复核

- 基线：`main` @ `fa62e4e`（v0.81.0），`npm run check` = 590 × 2 全绿
- 本轮结果：**590 × 2 全绿**（负向断言替换 + `engineIds` 归属收窄；条数不变）
- 未 commit / 未装 bundle / 未动 profile / **未重启服务**；`build.mjs` 零改动（73 项）

## 1. 一行结论

【指数行情】整块（标题 + 6 列表格 + 点行看详情的接线 + 专属数据 `cnIndices`）已删除；
连带按 §2.2 复核出 **`MARKET_PAGE_SECIDS` 的 6 个指数只剩 2 个真被读**，已收窄 + 钉住；
断言改为**负向**（页内不得再出现该块，反例注入加回 ⇒ 必败）。

## 2. 删除清单（逐条 + grep 证据）

| 项 | 位置 | 证据 |
|---|---|---|
| 【指数行情】面板整块（58 行：`data-role="index-table"` 容器 + `tw-panel-h` 标题「指数行情」+ 6 列表格 + `thead/tbody` + 行 `onClick: () => openDetail(it.secid)` + 缺失态格） | `MarketPage.tsx:313-370` | `grep -n "index-table" src/` ⇒ 仅剩测试里的负向判据；页内 0 |
| `cnIndices`（6 个 A 股指数的本地表） | `MarketPage.tsx:156-164` | `grep -rn "cnIndices" src/` ⇒ 页内 0（仅 `engineIds.ts` 的变更说明注释 + 负向测试） |
| `MARKET_PAGE_SECIDS`：6 → **2**（`1.000001`/`0.399001`） | `engineIds.ts:33` → `:40` | 见 §3 |
| 该常量派生用的 `TW_ROWS` import | `engineIds.ts:23` | 收窄后不再派生 ⇒ 删（`noUnusedLocals` 报它） |
| `engineIds.test.ts` E6：6 个指数名 → **2 个 secid** + "其余 4 个不该在表里" | `engineIds.test.ts` | 测试名即证据；跑出来 6/6 绿 |
| 断言 ⑤ 反向 + ①b 尾段（原"值在指数表里仍可见"失效） | `distLayout.test.ts:154`、`:189` | —— |

**只服务该块的东西一个不留**；`noUnusedLocals` 在删完后**全绿**（= 没有留下无引用符号，这是机械证据，不是靠眼看）。

**没有跟着删的东西（都还有别的消费者，逐条 grep）**：

| 东西 | 还有谁在用 |
|---|---|
| `tw-tablewrap` / `tw-table` / `tw-chg-chip` / `tw-chip-up|down|flat` | 本页「板块 / 资金 / ETF」表（`MarketPage.tsx:382-391`，表头 `幅度`/`成交额`/`换手`）＋ `TopBar.tsx`/`PortfolioPage.tsx`/`WatchlistPage.tsx` |
| `tw-rowhover` | 本页板块表 ＋ `ToolsPage.tsx` |
| `upDownPair()` / `UPDOWN_MISSING_NOTE` | 板块表的两处缺失态（`MarketPage.tsx:497/503`）＋ `breadthView.ts` 自己的注释 |
| `openDetail` / `DetailModal` / `DetailCard` | 板块表行点击（`:475/484`）＋ 详情弹窗本身 |
| `api.detail`（`/tradewatcher/detail`） | `MarketPage` 的板块表 + `QuoteDrawer.tsx:156` |
| `api.trend` / `TrendData` | 详情弹窗的 `DetailCard`（分时图） |

⇒ **没有任何路由/字段因为这次删除失去最后一个消费者**（"指数表"只消费共享的 `quotes` props 与 `api.detail`，两者都还有别的消费者）。

## 3. §2.2 归属复核结论：`MARKET_PAGE_SECIDS` 6 → 2（**唯一一处归属变化**）

`engineIds.ts` 这一行的职责是"**大盘页直接读 `quotes[secid]` 的标的**"，它的注释把理由写成了两条：
① `1.000001`/`0.399001`（涨跌家数/成交额三格的分量 `breadthCells`）；② **页内 6 个 A 股指数行（`cnIndices`）**。

删掉指数表后**第②条整条失效** ⇒ 实测页面还剩哪些直接读：

```
$ grep -n "quotes\[" src/client/MarketPage.tsx
123:  const sh = quotes['1.000001']
124:  const sz = quotes['0.399001']        # 供 breadthCells(sh, sz) 用
（再无其它）
```

⇒ 按该文件自己的原则（"**不渲染的东西不该被轮询** —— 这里顺带让它不再产生每拍的请求"），
把 `MARKET_PAGE_SECIDS` 从 `TW_ROWS` 的 6 个 `cn` 行收窄为**这 2 个**，并同步：
- 注释：把"页内 6 个 A 股指数行"改成"已删 + 为什么只剩这两个"；
- `engineIds.test.ts` E6：断言这 2 个在 `TW_ROWS` 里存在、被隐藏也断不了供，并**额外断言那 4 个已不在表里**
  （防止有人把模块加回来时忘了把这一行改回去 —— 这类"漂移必须红"的守卫沿用原测试的写法）。

**效果**：大盘页不再为 4 个自己根本不显示的指数要求"隐藏也要取数"（其余指数仍由行情条**可见卡片**取数，隐藏语义不变）。
**风险/边界**：这是"该页自己的需求清单"，改动落在 `engineIds.ts` + 它的测试两个文件（不在"该页"里）——
若你希望它归另一位（引擎侧）改，把这两处 hunk 撤掉即可，页面的删除不受影响。

## 4. 断言（负向）与反例注入

| # | 断言 | 反例注入（必败） |
|---|---|---|
| ⑤（改写） | 页内不得出现该块**独有**的痕迹：`'t' }, '指数行情'`（标题位）、`index-table`、`cnIndices`、`点行看详情`、`minWidth: 560`；同时正面确认"别处还在用"的 `openDetail`／`板块 / 资金 / ETF` 仍在 | 在 `RescuePanel` 前插回 `React.createElement('div', { 'data-role': 'index-table' }, '指数行情')` ⇒ 判据非空 ⇒ `assert.throws` |
| ①b（尾段改） | 「上证/深成」两张大卡不在（含 `tw-statrow`），且**不许以任何形式回填**（`item('上证指数'…)` 也不许）——值在页内彻底不再出现（用户要的结果） | 把「上证」卡加回趋势段 ⇒ `assert.throws` |

**判据只认"该块独有"的标记**：`tw-table`/`幅度`/`成交额`/`上涨/下跌` 这些是板块表**共用**的，
拿它们当"痕迹"会误报（我第一版就误报了 `tw-tablewrap`，已改成独有标记）——这一点写在测试注释里了。

## 5. 未做项

1. **未做真页面复核**（仍是"不重启服务"）⇒ 发布后可直接看大盘页：不应再有【指数行情】区块，且板块/资金/ETF 表的行点击仍能打开详情。
2. `engineIds.ts` 注释里仍保留一句历史说明（"原 `cnIndices` 表 /【指数行情】模块已删除"）——这是**变更说明**，不是死代码；
   若你的文档规范要求注释只描述现状，可以再收一次（本轮保留，便于以后回答"这 6 行去哪了"）。
3. 那 4 个指数（创业板指/科创50/沪深300/中证500）在大盘页**不再保证"隐藏也取数"** —— 这是本次收窄的**预期行为**；
   若将来大盘页又要显示它们，得把 `MARKET_PAGE_SECIDS` 加回去（E6 会红，提示回来核对）。

---

# 追加（v0.81.2）：附加行情界面接线批（六处逐项）

- 基线：`main` @ `fa62e4e`（v0.81.0）+ 另一批（`marketExtras.ts`）落地后 **603 × 2 绿**（我开工前实测，等它收敛才动手）
- 本轮结果：**611 × 2 全绿**；`build.mjs` 零改动（73 项）；未 commit / 未装 / 未动 profile / **未重启服务**
- 实验隔离 `DSH_HOME=/tmp/wire-1`（真上游探针，见 §3）

## 1. 一行结论

`marketExtras` 的宿主能力已通过**新增只读路由** `/tradewatcher/market-extras` 接到大盘页：
涨停/跌停、预测全天、两融（双源）三处由「未取到」改为真值；昨日成交/较昨日变动沿用既有接线并复核；
日内家数仍无源、保留「未取到 + 原因」。

## 2. 路由与行归属（四条约束的落实）

| 约束 | 落实 |
|---|---|
| ① 行归属同步 | `src/index.ts` 的 `ROW_ROUTES.market` 加了 `'/tradewatcher/market-extras'`（**只加这一处**）；`src/index.test.ts` 的四处期望（`FUNCTION_OWNED_PATHS`、`owned`、`ROW_ROUTES_FOR_TEST.market`、`OWNER_BY_CALLERS`）与一条反例锚点同步 ⇒ `index.test.ts` + `rowOwnership.test.ts` **19/19 绿**（后者按**真实调用点**推导：`MarketPage.tsx` → `api.marketExtras(...)` ✓ 与声明一致） |
| ② 只读 + 收口 | 路由**只调** `marketExtras.ts` 的导出（`limitCounts` / `marginCross` / `amountForecast`），**不复刻任何宿主逻辑**；`routes.ts` 里**没有新增裸 `fetch`**（`fix3Highmed` 的 H1 防线绿）；成交额由调用方带（`?amount=`，非正数/缺省一律按"没取到"，**不当 0**）——避免把 `/breadth` 的取数口径复制一份 |
| ③ 缺失语义 | 三段各自带 `missing[]`；缺 ⇒ `null` + 原因；两融不一致 ⇒ `mismatch` + `diffPct` + **两个读数**都回；预测口径（曲线/样本天数/生成时间/区间/进度/相位）随值一起回 |
| ④ 门控与断言 | 路由登记在 `market` 行 ⇒ 关掉该行时它**不注册 = 404**（`index.test.ts` 的"core 不该注册功能行路由"断言覆盖）；断言见 §4 |

**接口形状**：`GET /tradewatcher/market-extras?amount=<当前累计成交额>&day=YYYY-MM-DD&date=YYYYMMDD` → `{ limits, margin, forecast, asOf }`。

## 3. 六处逐项（含真上游探针数字）

| # | 处置 | 真值来源 | 探针实测（`DSH_HOME=/tmp/wire-1`） |
|---|---|---|---|
| ① | `涨跌趋势` 段内联统计：涨停/跌停 = **池接口家数**，悬停带口径 + 来源 + 时刻 + 池内前 5 只样本 | `extras.limitCounts()` | 涨停 **67**（push2ex 涨停池）、跌停 **8**；样本 `荣丰控股 10.01% / 慈文传媒 10.01% / 金奥博 10%`；`missing = 0` |
| ② | `成交量` 段：昨日成交（沿用 task-14 的 `prevAmount`） | 本地 `breadth.json` 上一交易日快照 | 无快照时仍「未取到 + 不用今天的数顶替」 |
| ③ | `成交量` 段：较昨日变动（派生） | 同上 | 缺昨日 ⇒ 「未取到 + 取不到昨日成交就无法算变动（不是 0）」 |
| ④ | `成交量` 段：预测全天 = **只在盘中给预测**；收盘后回落**实际值**；盘前/休市/缺数 ⇒ 未取到 + 原因；口径（曲线、样本 126 天、生成时间、区间、进度）进悬停 | `extras.amountForecast(current)` | `phase = closed` ⇒ `forecast = null`、`actual = 2.300 万亿`（我传的 current）⇒ 界面显示实际值并写明"不再给预测" |
| ⑤ | `两融走势` 段图例：**深所 + 东财两个读数都显示**；不一致时加 `⚠不一致` 标记并把相对差与口径差异写进悬停 | `extras.marginCross(day)` | 此刻 `深所 = null`、`东财 = 25252.96 亿`、`mismatch = false`（note：仅一个源可用）⇒ 界面**如实显示单源**、不假装一致；两源都在时的 `⚠不一致` 路径由夹具断言覆盖 |
| ⑥ | `日内家数` 段：**仍无源** ⇒ 保留「未取到 + 原因」 | —— | 宿主明确不可得，本轮不动 |

**常驻文案**：六处都只留"标签 + 数字 + （四字的）未取到"；口径/样本/区间/差异说明**全部进 `title`/`aria-label`**（并已清掉界面字符串里的 Markdown `**`，项目全局防线绿）。

## 4. 断言与反例注入（`src/client/marketExtrasWire.test.ts`，8 条）

| 断言 | 反例注入（必败） |
|---|---|
| ④ 盘中有预测值，且口径（曲线名/126 天/生成时间/区间/进度）必须随值一起给，并点明"非实际值" | 只给一个光秃秃的预测数（缺口径）⇒ `assert.throws` |
| ④ 收盘后回落实际值、不再给预测；盘前/休市/缺当前累计额 ⇒ 未取到 + 原因 | 收盘后仍给预测 ⇒ `assert.throws` |
| ⑤ 两融不一致时**两个读数都显示** + `⚠不一致` + 相对差 + 口径解释 | 只显示东财一个数（掩盖差异）⇒ `assert.throws` |
| ⑤ 单源可得、双源全缺 ⇒ 未取到 + 原因 | —— |
| ① 涨停/跌停：家数 + 池内样本可核对；缺数回落「未取到 + 原因」 | 缺数写成 `0` ⇒ `assert.throws` |
| ②③ 昨日成交/较昨日变动：缺快照 ⇒ 未取到 + 原因（不许 0 / 不许用今天顶替） | 缺昨日写 `0` ⇒ `assert.throws` |
| ⑥ 日内家数仍是未取到 + `INTRADAY_REASON` | —— |
| 路由三处一致（`ROW_ROUTES.market` 登记 / `api.ts` 指向 / 页面真在调且带 `amount`） | 把路由从 market 行删掉 ⇒ `assert.throws` |

另外同步改造了既有断言（否则它们钉的是旧字面量）：`distLayout.test.ts` 的 ②/②b/③（内联项改为多行容忍匹配 + 按结构计数）、`marketRefactor.test.ts` 的 ②（原因"必被调用点实参传入"扩展到 `? REASON` 的三元回落形态）。

## 5. 未做项 / 缺口（按你的要求写进报告）

1. **`marketExtras.ts` 缺"最后一次成功 / 降级状态"字段**：现在只有 `missing[]` + `at`（时间戳），没有"上次成功时刻 / 是否走缓存 / 上游熔断状态"这类字段，
   所以界面上**看不出"这个 67 是刚刚取的还是几分钟前的"**（悬停只有池接口自己的 `at`）。⇒ 建议由 `fix-data-fetch` 补 `lastOkAt` / `degraded` / `breaker` 三选一，我再挂到悬停；**我不改它的文件**。
2. **两融"不一致"路径没能用真上游复现**（探针此刻深交所当日文件未发布 ⇒ 单源）⇒ 该路径只有夹具断言；白天两源都在时可以再跑一次真探针。
3. **预测的盘中路径同样未在真上游观测**（探针时刻 23:1x ⇒ `phase = closed`）⇒ 盘中路径由夹具覆盖；09:30–15:00 之间可复跑 `amountForecast`。
4. **未做真页面复核**（要求不重启服务）⇒ 发布后建议按：涨停/跌停有数且悬停能看到样本；预测全天在盘中是"预测+区间"、收盘后变实际值；两融两个读数都在（不一致时带 ⚠）；日内家数仍是未取到。
5. 路由是**只读镜像**；`/tradewatcher/market-extras` 的调用方目前只有 `MarketPage.tsx`（若以后别的页要用，按 §2.2 判据应回到 core —— `rowOwnership.test.ts` 会自动报冲突）。
