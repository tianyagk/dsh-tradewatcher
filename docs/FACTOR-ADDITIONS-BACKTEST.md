# FACTOR-ADDITIONS-BACKTEST — 现有因子之外的补充因子研究与排序

> 状态：**只研究、只排序，不改代码**。本文不修改 `src/**`、不新增路由/字段/UI、不 commit、不重启。
> 基线：`dsh-tradewatcher` **v0.256.1**（2026-11-26），本机数据 `~/.dsh/dsh-tradewatcher`。
> 口径：公式以 `docs/FACTOR-SPEC.md` 为准；验证以 `docs/FACTOR-VALIDATION.md` 为准；产品边界以 `docs/PRD-FACTOR.md` D1 为准。
> 方法：读码 + 本机数据复算 + 文档交叉核对。文中的“实测”都是**描述性统计**，不是有效性结论；样本不足时只写“样本不足”。
> 一句话：**现有因子不缺“再来一个 alpha”，缺的是执行可行性；先补 `ADV20/FILL`、`LIMITDIST`、`VWAPDEV` 三个状态量，全部只做纯函数 + 落盘 + 影子，不进门槛；今天没有任何新因子可以上线。**

---

## 0. 裁决（先给结论）

| # | 裁决 | 一句话理由 |
| --- | --- | --- |
| **A1** | **现有 10 个日线因子已经覆盖“趋势/波动/位置”，缺口集中在“流动性/执行”**：`ADV20`、`FILL`、`LIMITDIST`、`VWAPDEV` 四个定义在 SPEC 里有、代码里没有；`tickPct` 只描述最小变动，不描述深度。 | 做T的第一道门槛不是“方向看对没有”，而是“这笔单在池子里能不能做成/做完”。 |
| **A2** | **先做 3 个：`LIQ.ADV20`（含派生 `EXE.FILL`）、`EXE.LIMITDIST`、`INT.VWAPDEV`（+ `INT.POSDAY` 搭车）。** 本期形态 = 纯函数 + 因子日志 + 影子判定；**不接 `t-gate-v2`、不进主决策下单、不加 UI 列**。 | 三者都用本地已有或零新增取数的数据；都直接回答“能不能成交、挂在哪”；都不需要收益预测。 |
| **A3** | **缓做 9 个：`VOL.DAYAMP_PROJ`、`VOL.GAP`、`LIQ.RVOL`、`VOL.ONSHARE20`、`PRT.BETA60`、`SEN.LEVTEMP`、`SEN.BREADTH`、`SEN.MAINNET`、`EXE.SLIP/FILLRATE`。** | 要么需要更长的前向样本（日内/情绪），要么依赖审计 #17/#23（执行反馈），要么当前没有区分度（DAYAMP 51/52 通过）。 |
| **A4** | **不做 13 项：ADX/DMI、MA60 斜率、相对强弱 RS20、布林带宽、Parkinson/Garman-Klass、RV20、Amihud、Corwin-Schultz 价差、PE/PB 分位、IOPV、盘口/订单流、新闻情绪分、ML/综合分。** | 与现有因子高度共线（实测 ATR/AMP/RV 相关 0.93–0.97）、无数据（IOPV/历史 PE/PB/盘口）、或直接违反 PRD D1/R1–R3。 |
| **A5** | **今天没有任何新因子具备进入主决策下单或做T门槛的资格。** 当前事实：日内只有 **12 个稠密日 / 22 只 A股/ETF**、做T **0 个完整往返**、净值 **27 个点**；按 FACTOR-VALIDATION 的最低样本，全部是“样本不足”。 | 先算、先记、先影子；在样本达标前，任何“有效/可上线”的结论都是假的。 |
| **A6** | **新增因子不解决 44 条审计中的任何一条**：直接解决 0 条，部分改善 0 条（PRD D2 的 3 条部分改善来自既有因子层，不是本文新增因子）；还可能加重 #20（新日志无上限）、P2-11（30s 全量重建）、#19（无 schema）。 | 因子层和审计是两条账；不要拿“加了因子”给“账本/净持仓”记账。 |
| **A7** | **全链路禁止评分/排序/推荐**：只允许“因子原值 + 窗口 + 截至 + 缺失原因”和“二元闸 + 唯一原因码”。 | PRD D1 + FACTOR-SPEC §6.1 R1–R3；本文的 P1/P2/P3 只是**施工优先级**，不是标的排名、不是因子好坏、不是买卖建议。 |

**先做 / 缓做 / 不做 一页表：**

| 优先级 | 因子 | 本期形态 | 进入门槛的前提 |
| --- | --- | --- | --- |
| **P1 先做** | `LIQ.ADV20` + `EXE.FILL` | 纯函数；日志 `adv20/fillMin`；影子 `G7` | 回放 ≥20 日 / ≥100 往返；`Δnet≥10bp`；`fill≥30%`；`legOut≤20%` |
| **P1 先做** | `EXE.LIMITDIST` | 纯函数；日志 `limitDistPct/limitSource`；影子 `G8` | 回放近板样本 ≥20 次；`legOut` 不升；`fill≥30%` |
| **P1 先做** | `INT.VWAPDEV`（+`INT.POSDAY`） | 纯函数（行情 `amount/vol`）；日志 `vwapDevPct/vwapFrom/posDay`；影子锚定检查 | 前向 ≥120 个稠密日 / ≥20 只；影子 ≥30 天；计划级 A/B |
| **P2 缓做** | `VOL.DAYAMP_PROJ` | 先记录，不判 | 出现 ≥30 个“死日”样本；或 120 个稠密日 |
| **P2 缓做** | `VOL.GAP` | 先记录，不判 | ≥30 次 `abs(gap)>2×ATR` 事件；事件研究通过 |
| **P2 缓做** | `PRT.BETA60` | 组合风险事实，不进 T | #11 净持仓/净值可核对后 |
| **P2 缓做** | `LIQ.RVOL` | 先记录 5 个时点，不判 | ≥120 个稠密日 / ≥20 只 |
| **P2 缓做** | `VOL.ONSHARE20` | 先落盘；事实行需产品批准 | 先看分布；不改变今天过闸 |
| **P2 缓做** | `SEN.LEVTEMP` | 只落盘；环境展示需产品批准 | 只写“截至上一交易日”；不做分/不择时 |
| **P2 缓做** | `SEN.BREADTH` | 只记录，不做分/不做择时 | 250 个交易日历史；且只做事实行 |
| **P2 缓做** | `SEN.MAINNET` | 只记录，不判 | 250 个交易日快照；先证明不是噪声 |
| **P2 缓做** | `EXE.SLIP/FILLRATE` | 研究脚本，不进产品 | #17 写 trades + #23 fill 带 channel；撮合模型能产生非零滑点 |
| **P3 不做** | ADX/MA 斜率/RS20/布林/Parkinson/GK/RV20/Amihud/CS 价差/PE-PB/IOPV/盘口/新闻分/ML 综合分 | — | — |

---

## 1. 现状核对（为什么不是“因子不够”）

### 1.1 已实现的 10 个日线因子

代码入口：`src/host/prismFactors.ts` 的 `factorMetricsOf()`（`:136`）；主决策因子表在 `src/host/prismRoutes.ts:426` 生成、`:501` 注入；`src/host/prismPipeline.ts:187` 明确“因子表只作事实依据”。

| 因子 | 公式 / 窗口 | 代码 | 进 `t-gate-v2`？ | 备注 |
| --- | --- | --- | --- | --- |
| `ATR14%` | `ATR14 = mean(TR14)`；`TR = max(H−L, abs(H−prevC), abs(L−prevC))`；`ATR14/C×100`；需 15 根 final | `prismFactors.ts:58` | ✅ `atr-low` | 与 `atr.ts` 口径一致 |
| `ATRRANK120` | 当前 `ATR14%` 在最近 120 个 ATR 观测中的分位（0–100） | `prismFactors.ts:82` | ✅ `atr-rank-low` | 代码最少 **20** 个观测就放行；SPEC 要求 **60**；新上市标的会失真 |
| `AMP20` | `mean((H_i−L_i)/C_{i−1})×100`，20 根 final | `prismFactors.ts:68` | ✅ `amp-low` | 日均口径；不是区间幅度 |
| `tickPct` | `tickSize/P×100`；股票 0.01、ETF 0.001 | `prismFactors.ts:155` | ✅ `tick-high` | 只描述最小变动，不描述盘口深度 |
| `ret5/20/60` | `C_t/C_{t−n}−1`，n=5/20/60 | `prismFactors.ts:119` | ❌ | 事实行 |
| `MA20/60`、`distMa20/60Pct` | `MA_n = mean(C)`；`(C/MA_n−1)×100` | `prismFactors.ts:126` | ❌ | 事实行 |
| `RSI14` | 最近 14 日涨幅和/（涨幅和+跌幅和）×100 | `prismFactors.ts:116` | ❌ | **简单平均口径**；`indexTech.ts:86` 是 Wilder 口径，同名不同值 |
| `pos20` | `(C−L20)/(H20−L20)×100`，20 日 | `prismFactors.ts:146` | ❌ | 事实行；52 周位置另有 `position.ts` 实现，但不在因子表 |
| `eff20` | `abs(C_t−C_{t−20}) / Σabs(C_i−C_{i−1}) ×100` | `prismFactors.ts:149` | ❌ | 0–100；SPEC 写 0–1；SPEC G5 要求 `≤0.45`，代码未接 |
| `bars` | 参与计算的 final bar 数 | `prismFactors.ts:136` | ✅ `data-missing` | 门槛要求 ≥21 |

### 1.2 数据层能力（本机 2026-11-26）

| 数据 | 本机事实 | 可用字段 | 能算什么 | 不能算什么 |
| --- | --- | --- | --- | --- |
| 日K `fqt=1` | 57 个文件；单文件最多 **834 根**；按 FACTOR-VALIDATION 口径 A股/ETF **49 只**（39 股票+10 ETF），≥250 根 46 只，最新日期=2026-11-26 的 **33 只** | `date/open/close/high/low/vol`（手） | 全部日线慢因子；约 3.3 年历史 | A股日K **没有成交额**；超过 834 根不支持；`fetchKline` 永远返回“最近 N 根”，历史切片必须自己 `filter(date≤asOf)` |
| 日K `fqt=0` | 同样缓存 | OHLCV | 涨跌停价、前收、原始价成本 | 不能与 fq=1 混算收益 |
| 1 分钟 `trends` | 39 个自然日有数据，其中 **12 个稠密日**（≥40 只），A股/ETF **22 只**；`TREND_ARCHIVE_KEEP_DAYS=12` | `price/avg/vol/amount/label` | 当日 VWAP、DAYAMP、分钟级回放 | **只保留 12 天**；不能做 120 天日内回测；长历史必须另建前向日志 |
| 实时行情 | 10s TTL + `quotes-lkg.json`；东财/腾讯/新浪 | `price/prev/open/high/low/vol/amount/turnover/volRatio/mainNet/superNet/totalMv/floatMv` | VWAPDEV、DAYAMP、LIMITDIST（需补 f47/f48）、组合权重 | **无 bid/ask、无 IOPV**；`mainNet/superNet` 只有当日累计，无历史 |
| 估值 | 当前值 TTL 30s | PE(TTM)/PB/总市值 | 当前事实 | **无历史 PE/PB**，不能算分位 |
| `breadth.json` | **只有 2 个交易日**（2026-10-13、10-16） | up/down/even/amount | 市场宽度事实 | 不能做历史分位/择时 |
| `auction/` | 40 个标的；单标的 `history` 最多 **4 天** | 集合竞价 ref/matched | 开盘竞价事实 | 不能做长历史 |
| `rescue-log/` | 23 天 | 六因子护盘评分/5 分钟抽样 | 护盘行为观察 | 不是做T因子；不能当身份确认 |

### 1.3 决策与做T链路

- 主决策：默认 `PRISM_DEFAULT_INTERVAL_SEC=600`（`src/shared/prism.ts:154`），可配 300–3600s；本机 `prism-settings.json` 当前 `intervalSec=300`。因子表以**事实行**注入四路 + 汇总（`prismRoutes.ts:501`、`prismPipeline.ts:187`），不直接生成订单。
- 自动做T：`evaluateAutoT()`（`src/host/prismGates.ts:100`）按 `AUTO_T_RULES.version='t-gate-v2'` 判 5 个因子 + 仓位/费用/时间；`placeAutoTPairs` 每轮重审计（默认 600s；本机 `intervalSec=300`）；每标的每日上限在 `prismRoutes.ts` 里硬编码为 **2**；最后开仓 14:30、全部平腿 14:50。
- 因子日志：`prism-factor/<day>.jsonl`，30 天保留（`src/host/prismFactorLog.ts`），目前只记 `atrPct/atrRank120/amp20Pct/tickPct/bars` 五个值。

### 1.4 先修口径债（不是新因子，但优先级高于新因子）

| # | 问题 | 证据 | 后果 | 处置 |
| --- | --- | --- | --- | --- |
| **B1** | **EFF20 算而未用**：SPEC G5 要求 `EFF20≤0.45`，代码只展示 | `prismFactors.ts:149`；`prismGates.ts` 无 `eff` 分支 | 趋势日可能开网格；门槛少一条已知约束 | 接进 `t-gate-v2`；本机 7 只当前 EFF20 4.5–42.0，全部通过，所以它是**正确性修复**，不是收益提升 |
| **B2** | `ATRRANK120` 最少 20 个观测就放行 | `prismFactors.ts:82-92`（`win.length < 20`） | 新上市/短历史标的的“分位”不可比 | 改为 SPEC 的 60；不足写 `null` + 原因 |
| **B3** | 同名 RSI14 两套口径 | `prismFactors.ts:116` 简单平均；`indexTech.ts:86` Wilder | 同一只票两个 RSI，模型/界面各说一套 | 因子表统一用 Wilder（或明确改名 `RSI14_SMA`）；不得同名 |
| **B4** | ETF 费用在 gate 里被高估 | `prismGates.ts:111` `const isEtf = false` | ETF 卖出被算印花税，`netYuan` 偏低，可能误触 `net-low` | 按 `stampExempt` 传参；回放/影子必须用同一口径 |
| **B5** | `AUTO_T_RULES` 与 SPEC 目标表不一致 | `maxTickPct=0.5`（SPEC 0.10）、`minSpreadPct=1.2`（SPEC 公式）、无 G5/G7/G8、无 `maxRoundsPerDay` | 回放/影子不可比；“t-gate-v2”名不副实 | **先锁定以代码常量为准还是以 SPEC 目标表为准**，写进 manifest；不得混用 |
| **B6** | 因子日志只有 5 个值，无 schema 版本 | `prismFactorLog.ts:19` | 新因子无法留痕；坏行会污染 | 日志升 v2：`factor:{id:{v,unit,window,asOf,missing}}` + `schemaVersion`；30 天 + 行数上限 |

> **结论：B1–B6 不修，新增因子只会放大口径债。** 尤其是 B5：现在连“t-gate-v2 到底是什么”都没有冻结；在这个状态上再加 3 个因子，回放结果不可解释。

---

## 2. 现有因子缺口（按用途）

| 用途 | 已有 | 缺什么 | 对当前链路的具体后果 | 取舍 |
| --- | --- | --- | --- | --- |
| **趋势** | `ret5/20/60`、`MA20/60` 偏离、`RSI14`、`pos20`、`eff20`；指数另有 MA5/20/60 排列 + MACD（`indexTech.ts`） | 个股的 MA5/20/60 排列、MA 斜率、相对基准强弱（RS20）、突破距离、缺口 | LLM 能看到“单只的动量/均线偏离”，看不到“它相对市场/行业是强是弱”；做T最需要的 `EFF20` 反而没进门槛 | **不补** RS20/ADX/MA 斜率（会变成隐性选股，违反 D1）；**只补** `EFF20` 接线（已有因子）和 `GAP`（风险旗，缓做） |
| **波动** | `ATR14%`、`ATRRANK120`、`AMP20` | 当日已走振幅/投影、隔夜缺口、隔夜/日内波动结构、已实现波动、下行波动、波动率之波动 | 门槛只用**历史**波动；今天是不是“死日”、是不是“事件日”完全看不见；ATR 里有多少是隔夜完全看不见 | **记录** `DAYAMP_PROJ`（P2；当前 51/52 通过，无区分度）；`VOL.ONSHARE20` 作为隔夜/日内结构（P2）；`RV20/下行/vol-of-vol` 与 ATR/AMP 高度共线，**不做** |
| **流动性** | 无（`tickPct` 只是最小变动；`volRatio` 只在 `candidateStats`/`indexTech` 里有） | `ADV20`、`FILL`、Amihud、量比、换手率、自由流通市值、当日量能节奏 | 20% 底仓上限是“相对持仓”的，不是“相对市场”的；薄标的的大单在 gate 里完全隐形 | **先补** `ADV20` + `FILL`；`VOLRATIO` 已有（`candidateStats.ts:37`），不重复；`LIQ.RVOL` 记录当日节奏（P2）；`AMIHUD` 与 ATR/ADV 合成 ρ≈0.99，**不做**；换手率无历史，**不做** |
| **执行** | `tickPct`；`spreadPct/netYuan` 在 gate 里；报价新鲜度只有布尔 `quoteStale` | `LIMITDIST`、`VWAPDEV`、实际成交率、滑点、TTF、盘口/IOPV | 只知“一跳贵不贵”，不知“离板多近”“挂单价是否锚在 VWAP”“这一轮为什么没成交”；`limitLocked` 是事后布尔，不是事前距离 | **先补** `LIMITDIST`、`VWAPDEV`；`SLIP/FILLRATE` 等 #17/#23 修完再做；盘口/IOPV **不做**（无数据） |
| **组合** | 账户快照有每只权重/现金/总资产（`prismRoutes.ts:75`）；行业暴露/上限有 `industryExposureOf`；回撤闸门有 `drawdownGateOf` | 组合 Beta、持仓相关性、HHI/集中度、流动性调整后的清仓天数 | 多只持仓可能同时 `legOut`（同涨同跌），但系统没有“组合级 T 风险”读数；集中度只看单票/行业，不看相关性 | **缓做** `BETA60`；HHI/相关性先不做（现有权重/行业上限已覆盖大部分风险） |
| **情绪** | 两融余额 `leverage.json` **4,025 行（2010 起，T+1）**；`breadth.json`（2 天）；`marketExtras` 涨跌停家数（当前值）；行情 `mainNet/superNet`（当前值）；`prism-news`（LLM 读原文）；`rescue` 六因子（23 天） | 个股资金流历史、广度历史、涨跌停历史、新闻情绪分、竞价情绪 | 市场级情绪只有两融有长历史；个股级情绪没有可回测历史；任何“情绪分”都会变成市场择时，违反 D1/R10 | **`SEN.LEVTEMP` 只落盘；若产品批准环境段才做事实行**；`BREADTH`/`MAINNET` 只记录；其余不做 |

**一句话**：现有因子在“趋势/波动/位置”上已经够用；真正缺的是**流动性/执行**四个状态量。补因子的正确顺序是“先补不可执行性，再补解释性，最后才谈预测性”。

---

## 3. 候选补充因子清单

> 说明：`S` = 纯函数、O(20) 以内、无新增取数；`M` = 需要分钟数据/新缓存/前向日志；`L` = 需要新数据源或长历史。
> 所有因子都必须遵守：`v=null` 时 `missing` 非空；不得用 0/50/均值顶替；日线只用 `date<today` 的 final bar；fq=1（涨跌停/前收用 fq=0）。

### 3.1 总表（15 行；`INT.POSDAY` 为 P1-3 搭车，不单列）

> 下表“公式（窗口）”列已含窗口；P1 三项另有独立窗口/数据源/失效场景详表（§3.2）。所有因子都必须能回答“本地已有或可前向记录”，不能回答的已列入 §3.4 不做。

| ID | 类别 | 公式（窗口） | 数据来源 | 成本 | 预期用途 | 失效场景 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `LIQ.ADV20` | 流动性 | `mean(V_i×100×C_i)`，20 根 final；`V` 单位手 | 日K `vol/close` | S | 算 `FILL`、仓位上限、G7 | 手/股 100× 错、停牌、一次性巨量、除权、ETF 与股票量纲 | **P1** |
| `EXE.FILL` | 执行 | `N/(ADV20×ρ/240)` 分钟；`N=shares×P`，`ρ=0.10`；ADV20 20 日 + 当前计划 | 派生（ADV20 + 计划） | S | G7、拆单/缩量 | 均匀成交假设、ρ 拍脑袋、无冲击模型 | **P1** |
| `EXE.LIMITDIST` | 执行 | `min((U−P)/P,(P−D)/P)×100`；`U/D` 优先 f47/f48，缺失才规则表；当前报价 | 行情 + 规则表/f47/f48 | S | G8、锁板风险 | ETF 20%、ST 5%、北交 30%、新股前 5 日、除权日、f47 缺失 | **P1** |
| `INT.VWAPDEV` | 执行/触发 | `(P−VWAP_t)/VWAP_t×100`；`VWAP_t=Σamount/Σ(vol×100)`；当日 09:30 起 | 行情 `amount/vol`（或 trends） | S（行情）/ M（trends） | 做T锚、计划价、事实行 | 混源、开盘集合竞价、块单、趋势日、ETF 无 IOPV | **P1** |
| `VOL.DAYAMP_PROJ` | 波动 | `DAYAMP=(H_day−L_day)/p0×100`；`PROJ=DAYAMP×240/elapsed`，elapsed≥30，cap `2×AMP20` | 行情 H/L/p0 | S | 开不开网格、legOut | 早盘 U 形、线性外推、午休、停牌、报价 LKG | P2 |
| `VOL.GAP` | 波动/事件 | `(O_t/C_{t−1}−1)×100`；`abs(GAP)/ATR14`；1 日 | 日K | S | 事件日风险旗、主决策事实 | 缺口回补、除权（fq=1 可避）、竞价噪声、涨停缺口 | P2 |
| `LIQ.VOLRATIO5_20` | 流动性 | `mean(V_{t−4..t})/mean(V_{t−19..t})` | 日K（已有 `candidateStats.ts:37`） | S | 活跃度事实 | 一次性放量、指数调仓、季节 | P3（已有） |
| `LIQ.RVOL` | 流动性节奏 | `RVOL(t)=(A_cum(t)/ADV20)/f(t)`；`f(t)`=同池同时刻历史中位；当日 09:30–t，t≥09:45，≥30 点 | 分时 `amount` + 日K `ADV20` | M | 当日量能节奏、fill 修正 | 剖面需 ≥10 日；`amount` 缺失/量纲不统一；半日市；不能当资金流 | P2 |
| `VOL.ONSHARE20` | 波动结构 | `100×Var_on/(Var_on+Var_id)`；`r_on=ln(O_t/C_{t−1})`、`r_id=ln(C_t/O_t)`，20 个收益（需 21 根） | 日K OHLC（fq=1） | S | 隔夜/日内波动分解；做T“有没有日内肉” | 一字板多/零方差/跨资产（黄金 ETF 隔夜含外盘）；不是波动水平 | P2 |
| `SEN.LEVTEMP` | 情绪/杠杆 | `P(rzye/ltsz)` 全历史分位（0–100），样本 ≥250 | `leverage.json`（4,025 行，T+1） | S | 市场杠杆分位（环境事实行；不是评分） | T+1 滞后、市场级、存量不是流量；不能当个股/10 分钟信号 | P2 |
| `PRT.BETA60` | 组合 | `cov(r_i,r_b)/var(r_b)`，60 日 | 日K + 指数日K | M | 组合风险/对冲 | beta 不稳定、基准选择、薄交易 | P2 |
| `SEN.BREADTH` | 情绪 | `(up−down)/(up+down)×100` 或 `up/(up+down)`；日频 | `breadth.json` / 指数 f104–f106 | S | 市场状态事实 | 仅 2 天、同步指标、无 PIT、指数成分 | P2（只记录） |
| `SEN.MAINNET` | 情绪 | `mainNet/amount×100`（或 `superNet/amount`）；当日累计 | 行情 f62/f6 | S | 资金流事实 | 供应商分类、日内累计非平稳、无历史、可反向 | P3 |
| `EXE.SLIP` | 执行反馈 | `buy: (fill−order)/order×1e4`；`sell: (order−fill)/order×1e4`（正=更差）；逐笔，20 日聚合 | orders/fills | S | 校准 `s`/`minSpread`/`netEdge` | 模拟撮合 0bp、无 channel、#17/#23 未修 | P2（等审计） |
| `EXE.FILLRATE` | 执行反馈 | `filledShares/orderedShares`；逐笔/20 日 | orders/fills | S | 校准 fill 模型 | 无部分成交、T 流水缺失、订单状态终态 | P2（等审计） |

> 数据纪律：本地没有历史的（`INT.VWAPDEV`、`LIQ.RVOL`、`VOL.DAYAMP_PROJ`、`SEN.BREADTH`、`SEN.MAINNET`）只能从上线日起**前向记录**；不得用当前值反推历史、不得把 12 天 `trends` 归档当 120 天样本。能从日K直接算的（`ADV20/FILL`、`LIMITDIST`（规则表）、`GAP`、`ONSHARE20`、`BETA60`）才允许历史回放。

### 3.2 三个先做项（P1）详表

#### P1-1 `LIQ.ADV20`（含派生 `EXE.FILL`）

| 项 | 内容 |
| --- | --- |
| **公式** | `ADV20 = (1/20) Σ_{i=t−19..t} V_i × 100 × C_i`；`V_i` 单位手，`C_i` 为 fq=1 收盘；有效量不足 15 根 ⇒ `null`。`FILL = N / (ADV20 × ρ / 240)`；`N = shares × P`；`ρ=settings.participationRate=0.1`。 |
| **窗口** | 20 根**已完成**日K；`FILL` 用当前计划股数/价格。 |
| **数据来源** | 本地日K `bars[].vol`、`bars[].close`；不需要新源、不需要逐笔。 |
| **计算成本** | **S**：O(20)/只；80 只 <1ms。历史面板 36 只 × 580 天 ≈ 2 万次，JS 约 0.1s。 |
| **预期用途** | ① `t-gate-v2` G7：`FILL≤3min`（高波动 ≤1min）；② 仓位上限：单轮 `N ≤ k×ADV20`；③ 主决策事实行：`ADV20 36.5 亿`；④ 日志 `adv20/fillMin` 供影子。 |
| **失效场景** | `vol` 是手还是股（100× 错）；ETF/股票 lot 不同；停牌/半日市；一次性大宗/指数调仓；除权日量价不匹配；`amount` 缺失只能用 `vol×close` 近似；10% 参与率不是实际成交率。 |
| **本机校验** | 7 只做T标的按 20% 底仓、10% 参与率：`FILL` 全部 **0.0–0.2 min**，当前 G7 不会 binding；`vol×close` 还原成交额与行情 `amount` 误差 **−1.0%~+0.7%**（7 只）。⇒ 它是**规模/标的变更时的保险丝**，不是当前收益来源。 |

**为什么要先做**：这是唯一一个“仓位相对市场容量”的硬约束。当前 `maxPositionPct=20%` 只限制“相对持仓”，不限制“相对 ADV”；薄标的的大单在 gate 里完全看不见。数据零新增、公式可复算、原因码清楚，投入产出最高。

#### P1-2 `EXE.LIMITDIST`

| 项 | 内容 |
| --- | --- |
| **公式** | `LIMITDIST = min((U−P)/P, (P−D)/P) × 100`；`U/D` 优先取行情 f47/f48；缺失才按规则表（主板 10%、创业板/科创板 20%、北交 30%、ST 5%、ETF 按交易所价，**不得默认 10%**）。`U/D` 或 `prevClose(fq=0)` 缺失 ⇒ `null`。 |
| **窗口** | 当前报价；`prevClose` 用 fq=0 昨收；不用 fq=1。 |
| **数据来源** | 行情 f47/f48（`breadthScan.ts:235-236` 已有解析先例；主 `QuoteRow` 需补两个字段，小改、不新增源）+ 规则表兜底。历史回放用规则表 + `limitSource:'rule'`，不确定 ⇒ `null`。 |
| **计算成本** | **S**：O(1)/只；历史面板 O(1)/日。 |
| **预期用途** | ① G8：`LIMITDIST < max(1.0, 1.5×ATR14)` ⇒ `near-limit`；② 事前风险旗：距板 <1% 直接不做；③ 日志 `limitDistPct/limitSource`；④ 主决策事实行。 |
| **失效场景** | ETF 涨跌停不是统一 10%（实测 588000/159915 是 **20%**，510300 是 10%，见 `FACTOR-IMPLEMENTATION.md` C-4/E-3）；ST 5%；北交 30%；新股前 5 日无涨跌停；除权日参考价不可得；f47/f48 对停牌/ETF 可能为 0；用 fq=1 前收会把板价算错。 |
| **本机校验** | 当前 7 只距板 **9.1%–19.8%**（规则表近似；实盘以 f47/f48 为准），今天不 binding；但 7 只 × 250 日 = 1,750 个 name-day 中，按收盘口径 `LIMITDIST < max(1,1.5×ATR)` 占 **10.1%**，其中 14 天收盘触板。⇒ G8 不是摆设，但 `1.5×ATR` 阈值在收盘口径偏严，**必须在盘中时点校准**，不能直接上线。 |

**为什么要先做**：`limitLocked` 现在是事后布尔；一旦一腿成交、另一腿被封，就是 legOut/裸持仓。距离是事前可见的，且数据只在行情/规则表，成本极低。它是**尾部风险保险**，不是收益因子。

#### P1-3 `INT.VWAPDEV`

| 项 | 内容 |
| --- | --- |
| **公式** | `VWAP_t = Σ amount / Σ(vol×100)`（当日 09:30 起累计）；`VWAPDEV = (P−VWAP_t)/VWAP_t×100`。行情 `amount/vol` 是累计值时 O(1)；缺失时回退 trends 分钟点，`avgApprox=true`。 |
| **窗口** | 当日 session；要求 `vwapSamples≥30`、`vwapFrom≤09:31`；开盘集合竞价是否计入必须标注（行情累计含 09:25，trends 从 09:31 起）。 |
| **数据来源** | 行情 `amount`（元，累计）+ `vol`（手，累计）；`amountSource` 混源时标注；缺失才用 `trends/<secid>/<day>.json` 的 `amount/vol`。 |
| **计算成本** | **S**（行情路径：两次除法）；**M**（trends 回退：O(240)/只，需 60s 缓存）。 |
| **预期用途** | ① 做T锚：计划买腿应在 VWAP 下方、卖腿在上方；② 影子检查 `buyPrice≤VWAP≤sellPrice` 是否成立；③ 主决策事实行：`现价相对 VWAP −0.36%`；④ 日志 `vwapDevPct/vwapFrom/avgApprox`。 |
| **失效场景** | `amount` 与 `vol` 来自不同源/不同快照（`amountSource` 必须标）；开盘集合竞价计入导致 VWAP 偏高/偏低；块单/大宗把 VWAP 拉偏；趋势日价格长期单边，VWAP 不是“回归锚”；ETF 无 IOPV，VWAP 不是净值；LKG/超龄报价 ⇒ `null`。 |
| **本机校验** | 用 trends 的分钟 `amount/vol` 复算 VWAP，与上游 `avg` 对比：5 只、35 个可得 name-day，最大绝对误差 **0.006%** ⇒ 公式/单位正确。12 天描述（45 个观测）：10:30 的 `abs(VWAPDEV)` 中位约 **0.46×s**（29% 超过 0.8s）；13:30 中位约 **0.82×s**（53% 超过 0.8s）。⇒ 0.8s 触发线在后半场更容易达到；**只是描述，不是有效性**。 |
| **搭车：`INT.POSDAY`** | `POSDAY = (P−L_day)/(H_day−L_day)×100`，0–100；同一份行情 H/L；成本 **S**；用途：现价在当日区间的位置（与 VWAPDEV 同屏读，“均价下方 + 区间低位”才是正T 候选）；**不单独设门槛**；失效：早盘 H/L 窄、LKG、区间为 0 ⇒ `null`。 |

**为什么要先做**：做T的挂单价目前由 LLM 凭 ATR/AMP 猜，上下文里没有“当日均价”。`VWAPDEV` 是唯一一个零新增取数、能直接告诉模型“现价在均价上方还是下方”的因子；它不预测方向，只描述位置，正好符合 D1。**但它是 live 因子，历史只有 12 天；验证周期最长，必须前向记录。**

### 3.3 缓做项（P2）

| 因子 | 现在不做的原因 | 触发条件 / 到点先做什么 |
| --- | --- | --- |
| `VOL.DAYAMP_PROJ` | 12 天 × 7 只回放：10:30 用 `PROJ≥2s` 过滤，**51/52 通过**，没有区分度；当前 7 只都是高波动标的，死日样本太少 | 记录每轮 `dayAmp/elapsed/proj`；等到 ≥30 个“死日”（全天振幅 <2s）再评估；先做**开/不开**二元闸，不碰平仓 |
| `VOL.GAP` | 8,068 个 name-day 中 `abs(gap)>2×ATR` 只有 **17 次（0.21%）**；太稀有，做硬闸几乎不触发；且缺口回补是常见现象，方向不确定 | 记录 `gap/atr`；累计 ≥30 次事件后做事件研究（缺口日 vs 非缺口日的 legOut/振幅）；只做风险旗，不做方向 |
| `LIQ.VOLRATIO5_20` | 已有：`candidateStats.ts:37` 已把量比写进候选池文本；`indexTech.ts` 也给指数算量比。重复实现会造第二套口径 | 不新增；若因子表要展示，直接复用 `candidateStats` 的 `volRatio`，并标 5/20 口径 |
| `PRT.BETA60` | 组合风险因子，不服务做T可执行性；且需要 #11 净持仓/净值可核对后才有意义 | #11 关闭后，做组合 Beta/相关性；只做事实行/风险提示，不做选股 |
| `LIQ.RVOL` | 模型层认为它正交（“今天的量能相对平时”）；但本文的做T硬约束先看 `ADV20/FILL`，且 RVOL 需要 12 天时间剖面 + ≥120 天验证；当前只够做管线 | 先记录 5 个时点的 `RVOL`；≥120 个稠密日/20 只后再评估；只做 G7 的当日修正，不单独设门槛 |
| `VOL.ONSHARE20` | 日线可算、与 ATR 低相关（模型层 48 只 −0.09；本机 33 只 −0.35），但它是**结构解释**，不是硬约束；当前 7 只的 ONSHARE20 18.8%–46.9%，不改变今天的过闸结果 | 先落盘/研究；若产品批准，再进事实行（“ATR 里有多少是隔夜”）；等 G2/G3 有样本后，再评估是否进 T 的“开/不开” |
| `SEN.LEVTEMP` | 有 4,025 行历史，但 T+1、市场级、存量口径；做成“情绪分”会变成择时，违反 D1/R10 | 只落盘；若产品批准环境段，才展示“两融余额/流通市值分位，截至上一交易日”；不做个股、不做 10 分钟信号、不做评分 |
| `SEN.BREADTH` | `breadth.json` 只有 2 天；市场宽度是同步指标，做成“情绪分”会变成择时，违反 D1/R10 | 每日追加 `up/down/amount`；250 天后只做事实行，不做分、不做排序 |
| `SEN.MAINNET` | 行情 f62/f66 只有当前累计值；无历史、无基线；供应商“主力/超大单”分类不可验证 | 5 个时点/日记录 250 天；先证明它不是噪声，再谈展示；**不进 gate** |
| `EXE.SLIP` / `EXE.FILLRATE` | 本机 871 笔 fill 的价格**全部等于委托价**（模拟撮合按挂单价成交）⇒ 中位滑点 **0.00bp**；`PrismFill` 无 channel（#23，需 `orderId` join）、`trades` 不写（#17）⇒ 归因不完整 | 先修 #17/#23 + 撮合模型（P-05/P-06）；再算逐笔滑点/成交率/TTF；只用于校准 `s`/`minSpread`，不做信号 |

### 3.4 明确不做（P3）

| 因子/类别 | 若要算的公式 | 不做理由 | 替代 |
| --- | --- | --- | --- |
| `TRD.ADX14` / DMI | Wilder +DI/−DI/ADX(14) | 与 `EFF20` 高度重叠；多 3 个参数、多一套平滑口径；没有 gate 用途 | `EFF20` + `MA20/60` |
| `TRD.MA60SLOPE` | `(MA60_t/MA60_{t−20}−1)×100` | 与 `distMa60Pct`/`ret60` 共线；再加一个趋势定义只会互相打架 | `distMa60Pct` + `ret60` |
| `TRD.RS20` | `ret20_i − ret20_bench` | 方向/选股因子；D1 明确不选股；基准/行业中性化麻烦；容易变成隐性推荐 | 主决策 LLM + 行业暴露 |
| `VOL.BOLLBW20` | `(MA20+2σ)−(MA20−2σ)` / MA20 | 与 `ATRRANK120`/`AMP20` 重叠；带宽高低不改变可执行性 | `ATRRANK120` |
| `VOL.PARKINSON20` / `VOL.GK20` | OHLC 波动估计 | 与 ATR/AMP 相关 >0.9；20 天样本噪声大 | `ATR14`/`AMP20` |
| `VOL.RV20` | `std(ln(C_t/C_{t−1}))×√252×100` | 实测与 ATR **0.934**、与 AMP **0.944**；再加一个波动率只是重复 | `ATR14`/`AMP20` |
| `LIQ.AMIHUD20` | `mean(abs(r_i)/(V_i×100×C_i))×1e9` | `ADV/FILL` 先做；A股日K无成交额，只能用 `vol×close` 代理；冲击是非线性的，20 天估不准 | `ADV20`/`FILL` |
| `EXE.SPREAD_CS` | Corwin-Schultz 高低价估计 | 无 bid/ask；高低价估计对 A股/ETF 不可靠；`tickPct` 已描述最小摩擦 | `tickPct` + `netYuan` |
| `VAL.PEPCT` | PE/PB 历史分位 | 无历史 PE/PB；10 分钟决策尺度无关；D1 禁止选股 | 不做；当前 PE/PB 只作参考字段 |
| `ETF.IOPV` | `(P−IOPV)/IOPV×100` | 无 IOPV/NAV 源；用现价/净值猜是假精度 | `null` + “无 IOPV 源” |
| `FLOW.ORDERIMB` | 买一/卖一失衡、逐笔主动买卖 | 无 bid/ask、无逐笔；`mainNet` 是供应商分类、无历史 | 不做 |
| `SEN.NEWS` | 新闻情绪打分 | LLM 已读新闻原文；数值分不可验证、不可复算；会变成评分 | 新闻原文 + 事实行 |
| `ML.COMPOSITE` / 因子总分 | 加权求和/z-score/ML | 直接违反 PRD D1 / FACTOR-SPEC R1–R3；样本不足；不可解释 | **不做** |

---

## 4. 优先级：为什么是这三个，为什么不是更多

> 注意：本文的 P1/P2/P3 是**研究/施工排序**，不是 PRD 的 P1/P2 分期。PRD P1 仍只做 autoT 的 5 个门槛值；`VWAPDEV` 在 PRD 里仍属 P2 范畴，本文把它提前是因为它是做T挂单的锚，且零新增取数。
> 另：如果按“与现有因子正交性”排序，`INT.VWAPDEV`、`VOL.ONSHARE20`、`LIQ.RVOL` 会靠前；本文按“能否直接形成做T硬约束 + 验证成本”排序，所以 `ADV20/FILL`、`LIMITDIST` 在前。两套排序服务不同问题，不矛盾；最终上线仍要过同一套 G2/G3。

### 4.1 先做 3 个（P1）

| 顺序 | 因子 | 为什么现在 | 本期形态 | 不做的后果 |
| --- | --- | --- | --- | --- |
| **1** | `LIQ.ADV20` + `EXE.FILL` | 唯一缺失的“相对市场容量”硬约束；零新数据；公式可复算；G7 原因码天然可解释 | 纯函数 + 日志 + 影子 G7；**不接 gate** | 薄标的/大仓位可能挂出“看起来合理、实际做不完”的单；未来换标的/加规模时无保险丝 |
| **2** | `EXE.LIMITDIST` | 锁板是 legOut 的尾部风险；`limitLocked` 事后布尔不够；f47/f48 已有解析先例 | 纯函数 + 日志 `limitDistPct/limitSource` + 影子 G8；**不接 gate** | 一腿成交、另一腿被封；净持仓偏离，靠 14:50 强制回补兜底（而 #16 还未修） |
| **3** | `INT.VWAPDEV` | 做T挂单缺“当日均价”锚；行情 `amount/vol` 零新增取数；公式已对上游 `avg` 校验到 0.006% | 纯函数（行情路径）+ 日志 `vwapDevPct/vwapFrom` + 影子锚定检查；**不接 gate** | LLM 继续用 ATR/AMP 猜价位；`s=ATR/4` 的网格没有“均价”参照，计划价可能整体偏上/偏下 |

**共同点**：三者都不预测方向、都不需要 500 日 IC、都能用“二元闸 + 原因码”表达、都不会产生评分/排序/推荐。它们回答的是“这笔 T 做不做得成”，而不是“该不该买”。

### 4.2 为什么不是 `DAYAMP` / `GAP` / 更多趋势因子

- `DAYAMP_PROJ`：12 天 × 7 只，10:30 过滤 **51/52 通过**；当前 7 只全是高波动标的，死日样本不足。现在做，只会得到“几乎不筛”的第二个 ATR 门槛。
- `GAP`：`abs(gap)>2×ATR` 只占 **0.21%**（17/8,068）；做硬闸几乎不触发；且缺口回补方向不确定，不能当信号。
- ADX/MA 斜率/RS20：与 `EFF20`/`MA20/60`/`ret20` 高度共线；再加会让“趋势”出现三套定义，模型不知道该信哪个；RS20 还会把因子层变成选股层。
- RV20/下行/vol-of-vol：与 ATR/AMP 相关 **0.93–0.97**；再做只是把同一个波动率换个名字。

> `VOL.ONSHARE20` / `LIQ.RVOL` 是模型层认为最正交的两个（隔夜/日内波动分解、当日量能节奏）；本文把它们放 P2，不是否定，而是：前者是**结构解释**（不改变当前 7 只的硬约束），后者需要 12 天时间剖面 + ≥120 天验证。先让 `ADV20/FILL`、`LIMITDIST` 把“不可执行”挡住，再补“为什么不可执行”。

### 4.3 为什么不是“情绪因子”

- 两融余额 `leverage.json` 有 **4,025 行（2010 起）**，是唯一有长历史的市场级情绪/杠杆数据；但它 T+1、市场级、存量口径，只能做环境事实行，不能当个股/10 分钟信号。
- `breadth.json` 只有 **2 天**；`mainNet/superNet` 只有当前累计；`rescue` 只有 23 天。个股级情绪没有历史就没有分位、没有回放、没有置信区间。
- 情绪因子天然是“市场择时”的入口；一旦做成评分/排序，就违反 PRD D1 和 R10（不得表述为预测能力）。
- 如果确实要记录，只允许“事实行”（`up/down/amount`、`mainNet/amount`），**不进 gate、不进主决策下单、不做分**。

### 4.4 本机实测：为什么“更多 alpha”不是答案

| 检查 | 数字 | 含义 |
| --- | --- | --- |
| ATR14 vs AMP20 相关 | **0.968**（33 只 fresh） | 两个波动因子几乎同一个东西 |
| ATR14 vs RV20 相关 | **0.934** | RV20 没有增量 |
| AMP20 vs RV20 相关 | **0.944** | 同上 |
| `abs(gap)>2×ATR` 频率 | **0.21%**（17/8,068 name-day） | GAP 硬闸几乎不触发 |
| DAYAMP 10:30 过滤通过率 | **51/52**（7 只 × 12 天） | 没有区分度 |
| ADV/FILL（当前 7 只，10% 参与率） | **0.0–0.2 min** | G7 当前不 binding，是保险丝 |
| LIMITDIST（当前 7 只） | **9.1%–19.8%** | 今天不 binding；历史 250 日 10.1% 会触发 `1.5×ATR` |
| VWAP 公式 vs 上游 avg | 最大误差 **0.006%** | 公式/单位正确，可做 live |
| 871 笔 fill 的滑点 | 中位 **0.00bp** | 模拟撮合按挂单价成交；执行反馈目前是假精度 |
| 做T完整往返 | **0**（25 plans 全 aborted，24 条腿成交） | 任何 T 收益/门槛结论都没有样本 |

**结论**：当前系统的瓶颈不是“因子数量”，而是“执行真实性 + 样本量 + 账本”。新增因子最多让拒绝理由更完整；它不会把 0 个完整往返变成正收益。

### 4.5 建议施工顺序（研究→纯函数→日志→影子→回放→门槛）

```
Phase 0（先决，1–2 人日）
  B1 EFF20 接线；B2 ATRRANK 最小样本 60；B3 RSI 单一口径；
  B4 ETF 费用；B5 锁定 t-gate-v2 常量/版本；B6 日志 schema v2
        ↓ 任一项不过，停
Phase 1（本期建议，2–3 人日）
  ADV20/FILL、LIMITDIST、VWAPDEV 纯函数 + 单测（100× 量纲、f47/f48 规则、VWAP 对 avg）
        ↓
Phase 2（同期，1 人日）
  写 prism-factor v2 日志：每轮每个 autoT 标的记 3 个新值 + 影子 gateCode；30 天 + 行数上限
        ↓
Phase 3（现在只能做管线联调）
  用 12 个稠密日跑回放管线；只输出 fillRate/legOut/覆盖率；不输出收益结论
        ↓ 样本不足（当前 0 往返）
Phase 4（≥120 稠密日 / ≥20 只；或 ≥20 日 / ≥100 往返）
  G2 回放：单变量 A/B；Δnet≥10bp；fill≥30%；legOut≤20%
        ↓
Phase 5（≥30 交易日影子）
  G3 影子：A/B 同模型同资金；ΔNet_bps CI 下限>0；无安全停
        ↓
Phase 6（只有全过才 bump T_GATE_VERSION）
```

**停条件**：Phase 0 任一项失败；Phase 3 发现 `legOut` 或 `fillRate` 不可复算；Phase 4 样本 <20 日/100 往返；Phase 5 出现安全停/人工干预。任一停 ⇒ 不进入下一阶段。

---

## 5. 验证要求：什么证据才能进主决策 / 做T门槛

### 5.1 先分清四类因子、对应证据

| 因子类型 | 例子 | 主指标 | 不能用什么证明 |
| --- | --- | --- | --- |
| **方向/择时因子** | 假设中的 `MOM20+MA20DEV`、`POS.PCT20` | 日线 IC / RankIC / 分组 Q5−Q1 | 单日回测、只看胜率、只看最好一段 |
| **执行/门槛因子** | `ADV20/FILL`、`LIMITDIST`、`VWAPDEV` | 回放 `Δnet/attempt`、`legOut`、`fillRate`、`bothLegs` | IC 高不代表门槛有效；门槛是“筛掉不能做的”，不是“预测会涨” |
| **组合/风险因子** | `BETA60`、相关性、HHI | 暴露/回撤/相关性、压力情景 | 不能当 alpha；不能做买卖建议 |
| **情绪因子** | `BREADTH`、`MAINNET` | 只做描述/事实行 | 不能做评分、排序、择时；D1/R10 |

> **关键**：`ADV20/FILL` 这类门槛因子，IC 不是主要指标。一个因子可以 IC=0，但作为“不可执行”的过滤器完全有效；反过来，IC 很高的因子也可能对 fill/legOut 毫无帮助。**门槛因子必须用回放/影子证明，不得拿 IC 代替。**

### 5.2 进主决策：只允许“事实行”，不允许“因子信号”

PRD D1 的现行边界是：因子层只服务自动做T 的可执行性门槛，不选股、不评分、不排序、不进主决策下单。当前代码 `v0.254.0` 已把因子表作为**事实行**注入主决策（`prismRoutes.ts:501`、`prismPipeline.ts:187`），这是既成事实，但不是“因子可以下单”。

| 目标 | 需要的证据 | 说明 |
| --- | --- | --- |
| 进主决策**文本**（事实行） | 数据门（PIT、fq、final bar、缺失处理、可复现）+ 覆盖率 ≥80% | 只写“值/窗口/截至/缺失原因”；不写“好/坏/建议” |
| 进主决策**下单**（因子改变订单） | **G1 日线门** + 产品裁决；D1 目前**禁止** | 即使 G1 通过，也不能绕过 D1；需要单独产品变更 |
| 进因子库 **UI** | 数据门 + UI 评审；新增列/面板属于大改 | 本期 P1 不加 UI 列；只写日志/gate 原因码 |

**G1 日线门（与 FACTOR-VALIDATION §9.2 一致，不另造）**：

| 项 | 门槛 |
| --- | --- |
| 样本 | `T≥500` 个有效交易日；`median(N_t)≥30`；覆盖率 `≥80%` |
| 主指标 | `h=5` 的 `abs(mean RankIC)≥0.04`，95% CI 不含 0 |
| 稳定性 | `abs(ICIR_ann)≥0.5`；方向一致天数 `≥55%` |
| 分组 | `Q5−Q1≥0.8%/5d`（或反向 `Q1−Q5`）；`monotonicity≥0.6` |
| 子周期 | 至少 4 段可评估，`≥3/4` 同号；6 段则 `≥5/6` |
| 安慰剂 | 随机因子/收益置换/时间平移 `p<0.05`；毒化 bar 不改变输出 |
| 稳健性 | 至少 10 格（lag/winsorize/加权/含不含 ETF/剔极值/成本 0–20bp）中 `≥80%` 同号 |
| 确认段 | Confirmation 同号，且 `abs(IC)≥validation 的 50%` |
| 增量 | 对现有因子正交化后，增量 `RankIC≥0.02`；与现有因子 `abs(ρ)>0.8` 视为冗余，直接淘汰 |

> 本机日线面板：36 只股票 / 约 580 天，**可以跑 G1**，但必须标 `BACKFILL-SURVIVOR`（不是 PIT universe），结论只能写“面板内”，不能外推全市场。

### 5.3 进做T门槛：G2 回放

| 项 | 门槛 |
| --- | --- |
| 设计 | 三臂：`no-gate` / `v1` / `v2`；主比较 `v2−v1`，次比较 `v2−no-gate`；只有被验证的那一个变量不同 |
| 样本 | `≥20` 个日级 cluster；`≥100` 个完整往返；`v1∩v2` 配对样本另报 |
| 主指标 | `Δnet ≥ 10 bp/attempt`；`v2 netExpectation ≥ 0`；95% CI 下限 >0 |
| 执行质量 | `legOutRate≤20%`；`fillRate≥30%`；`bothLegsRate≥60%`；`v2 fillRate ≥ 50%×v1` |
| 风险 | `maxDD` 不比 v1 差 >1pp；`CVaR5` 亏损绝对值 ≤v1 的 1.5 倍 |
| 稳健 | 去掉贡献最大的 1 只/1 天/前 5% attempt，`Δnet` 符号不翻转 |
| 版本 | 阈值、常量、`T_GATE_VERSION`、数据 hash 全部写 manifest；改阈值必须 bump 版本 |

**单变量 A/B 规则**：一次只加一个因子/一个阈值；不得同时改 `ADV20` 和 `LIMITDIST`；不得在同一轮回放里调两次阈值。每个因子预注册一个方向（例如 `FILL>3min ⇒ 更差`），不得看到结果后改方向。

**门槛因子的“分组”检查**（不是收益 quintile，而是执行结果分档）：

| 因子 | 分档 | 预期单调关系 | 最低样本 |
| --- | --- | --- | --- |
| `FILL` | `<1 / 1–3 / 3–10 / >10 min` | 档位越高，`legOut` 越高、`fillRate` 越低 | 每档 ≥20 次 attempt；总 ≥100 往返 |
| `LIMITDIST` | `<1% / 1–2% / 2–5% / >5%` | 档位越低，`locked-leg`/`legOut` 越高 | 近板样本 ≥20 次；否则“样本不足” |
| `VWAPDEV` | `<-1s / -1s..-0.3s / -0.3s..+0.3s / >+1s` | 计划价跨 VWAP 的组，`bothLegs` 更高 | 每档 ≥20 次；总 ≥100 往返 |

### 5.4 进做T门槛：G3 影子

| 项 | 门槛 |
| --- | --- |
| 时长 | **30 个交易日**为判定口径；20–29 天只算方向性；<20 天样本不足 |
| 轮次 | 3 轮/日（09:45、10:30、13:30） |
| 资金/候选/模型 | A/B 同一账户克隆、同一候选、同一 LLM 输出、同一成交模型；只有门槛不同 |
| 主指标 | `ΔNet_bps = mean_day(B−A)`；95% CI 下限 >0；且 `≥max(5bp/日, 10%×abs(A 平均日净额))` |
| 执行质量 | B 的 `legOut≤20%`、`fill≥30%`、`bothLegs≥60%` |
| 风险 | B 的 `maxDD` 不比 A 差 >1pp；`CVaR5` ≤A 的 1.2 倍 |
| 功效 | 必须报 MDE；`MDE>经济门槛` ⇒ `UNDERPOWERED`，不得写“无效” |
| 安全 | 无安全停、无人工干预；有则不计入效果 |

### 5.5 样本不足的硬规则（写死）

| 层级 | 最低样本 | 不满足时只能写 |
| --- | --- | --- |
| 日线因子 G1 | `T≥500` 日；`median N≥30`；覆盖率 ≥80%；fqt1 可用标的 ≥20 | “样本不足，不能判断” |
| 日内因子 | `≥120` 个稠密日；`≥20` 只；日级 cluster ≥120 | “样本不足，不能判断”（12 天不够） |
| 做T回放 G2 | `≥20` 个日级 cluster；`≥100` 个完整往返 | “样本不足，不能判断”（0 往返不够） |
| 影子 G3 | `≥20` 天且 `≥50` 往返/臂；判定要 30 天 | “样本不足，不能判断” |
| 组合/情绪 | 250 个交易日；否则只做事实行 | “样本不足，不能判断” |

**当前状态**：日内 12 个稠密日 / 22 只；做T 0 个完整往返；净值 27 个点；`breadth` 2 天；`auction` 最多 4 天。⇒ **任何新因子都不能进主决策下单或做T门槛；只能计算、落盘、影子。**

### 5.6 三个 P1 因子的逐项验证清单

#### `LIQ.ADV20` / `EXE.FILL`

- [ ] **量纲**：同一标的用 `vol×100×close` 与行情 `amount` 对比，误差在 ±2% 内（本机 7 只：−1.0%~+0.7%）；构造 100× 错夹具，必须失败。
- [ ] **窗口**：20 根 final；`partial` 末根剔除；`date<today`；缺量 ≥5 根 ⇒ `null` + `原因`。
- [ ] **PIT**：`cutoff` 后 bar 不参与；把 `slice(-20)` 改成未来数据，测试必须失败。
- [ ] **回放**：G7 单变量 A/B；`FILL>3min` 组的 `legOut` 是否更高、`fillRate` 是否更低；若 G7 拒绝 <5% attempt，报告“不 binding”，不得声称有效。
- [ ] **影子**：30 天；`fillRate≥30%`、`legOut≤20%`、`bothLegs≥60%`；`ΔNet_bps` CI 下限 >0。
- [ ] **样本不足**：<20 日/100 往返 ⇒ 只写“样本不足”。

#### `EXE.LIMITDIST`

- [ ] **f47/f48**：至少 20 个已知案例（主板/创业板/科创板/ETF/ST）对比交易所价；588000/159915 必须识别为 20%，510300 为 10%。
- [ ] **规则表**：f47/f48 缺失时按板块/ST/北交/新股规则；不确定 ⇒ `null` + `限价源未知`；不得默认 10%。
- [ ] **历史**：用 fq=0 前收；除权日 `limitSource:'unknown'`；回放报告 `limitSource` 分布。
- [ ] **回放**：近板样本 ≥20 次；`LIMITDIST<1%` 组的 `locked-leg`/`legOut` 是否更高；若近板样本 <20，报告“样本不足”。
- [ ] **阈值**：`max(1.0,1.5×ATR)` 在 7 只/1,750 name-day 上触发 **10.1%**（收盘口径）；必须用盘中时点重算，不得直接上线。
- [ ] **影子**：30 天；`legOut≤20%`、`fill≥30%`；不得把 `near-limit` 写成“不会成交”。

#### `INT.VWAPDEV`

- [ ] **公式**：行情 `amount/(vol×100)` vs trends 分钟累计 vs 上游 `avg`；本机最大误差 0.006%；夹具有 `amountSource` 混源、`vol=0`、`amount=null`。
- [ ] **质量位**：`vwapFrom`、`vwapSamples`、`avgApprox`；`vwapSamples<30` 或 `vwapFrom>09:31` ⇒ `null` 或降级标注。
- [ ] **LKG**：`source='lkg'` 或 `ageMs>15s` ⇒ `null`，不得用兜底价算。
- [ ] **前向记录**：5 个时点/日（09:45、10:30、11:15、13:30、14:00）× 40 只 × 250 日 ≈ 5 万行；不要依赖 12 天 `trends` 归档（`TREND_ARCHIVE_KEEP_DAYS=12`）。
- [ ] **回放**：120 个稠密日 / 20 只；`VWAPDEV` 分档 vs `bothLegs`/`legOut`；计划价跨 VWAP 的比例。
- [ ] **影子**：30 天；`ΔNet_bps` CI 下限 >0；`bothLegs≥60%`；不得把 VWAP 当“公允价值”。

### 5.7 证据 artifact（缺一不可）

```
PRE-REGISTRATION.md          # 因子公式/方向/阈值/样本切分/主指标/seed/data hash，跑前 sha256
run_manifest.json            # git commit、node 版本、依赖 lock、数据 hash、时区、T_GATE_VERSION
daily_panel.parquet          # 日线面板（PIT）
ic_summary.csv               # meanIC/sdIC/ICIR/CI/覆盖率（方向因子）
quintiles.csv                # Q1–Q5/spread/mono/hitRate（方向因子）
gate_replay.csv              # 三臂/attempt/legOut/fillRate/bothLegs/net
shadow_daily.csv             # 30 天 A/B 日配对
exclusions.csv               # 每条剔除原因
placebo.json                 # 随机/置换/时间平移/毒化 bar
attempts.log                 # 所有跑过的变体（含失败），不得只报最好
```

**判定语言**：只有 `G1+G2+G3` 全过，才能写“门槛有效”；只有 G1 过，只能写“面板内有效，不可上线”；样本不足，只能写“样本不足，不能判断”。**不得写“显著/有效/可上线/建议实盘”，除非对应表全过。**

---

## 6. 与 44 条审计、PRD D1 的边界

### 6.1 44 条审计：新增因子直接解决 0 条

44 条 = `AUDIT-AUTOT-HOST.md` 24 条（P0 3 / P1 10 / P2 11）+ `AUDIT-PRISM-UI-POLISH.md` 20 条（P1 7 / P2 13）。PRD D2 的结论仍然成立：因子层直接解决 **0** 条，部分改善 3 条（#13/#24/P1-5），加重 1 条（#20）。**本文的候选因子不会改变这个计数。**

| 审计项 | 与新增因子的关系 | 必须怎么做 |
| --- | --- | --- |
| **#10 关闭开关只撤 pending，不处理已成交腿** | 无关；但任何“门槛有效”的声明都要求净持仓可信 | 先修；未修前 G3 不放行 |
| **#11 无收盘净持仓对账/`dayOpenQty`/`forced-fail`** | G3 的 PnL/legOut 真相来源；未修则影子无法判定 | 先修；否则只能写“样本不足/不可对账” |
| **#16 强制回补绕过 T+1/涨跌停/停牌/现金** | `LIMITDIST` 的尾部风险最终由它兜底；未修则 G8 只是“少开单”，不是“不会裸腿” | 先修 |
| **#17 结算只写 results；trades 从不写** | `EXE.SLIP/FILLRATE` 无法算 T 通道执行质量 | 先修再谈执行反馈 |
| **#19 `prism-autot.json` 无 schema** | 新因子日志必须自校验 | 日志 v2 + schemaVersion；坏行隔离 |
| **#20 plans/results/trades 无保留上限** | 新日志会再添一个无上限文件 | **硬约束**：30 天 + 行数/字节上限；不遵守就不做 |
| **#21 用 `Date.now` 与 run 时钟不一致** | 新因子快照必须用 `run.startedAt`/`deps.now` | 写进实现验收 |
| **#23 `PrismFill` 无 channel** | 执行反馈需靠 `orderId` join 才能归因；#17 又缺 T 流水 ⇒ 归因不完整 | 先修；或明确只做研究脚本，不进产品 |
| **#24 测试只做源码正则** | 新因子必须有行为级 fixture | 每个 P1 因子 ≥5 个行为用例 |
| **P2-11 30s 刷新全量重建 437 条 flow** | 新 payload 字段必须 memo | 不进 30s 重算路径；只进 5 分钟缓存/日志 |
| **P2-2 ≤860px 结果列消失** | 不新增窄屏隐藏 | P1 不加 UI 列 |

**P0 顺序不变**：`#10 → #11 → #16 → #24 → #20`。在这 5 条关闭之前，**不要对外宣称“自动做T 已优化完成”**；因子层最多只能说“拒绝理由更完整”。

### 6.2 PRD D1：只服务做T可执行性，不选股/不评分/不排序/不推荐

| 允许 | 不允许 |
| --- | --- |
| 因子原值 + 单位 + 窗口 + 截至 + 缺失原因 | `score`、`totalScore`、`rating`、`confidence`、`stars`、`rank`、`topN`、`best`、`preferred` |
| 自比分位（`ATRRANK120`：这只票当前 ATR 在它自己过去 120 日的位置） | 同池排名/候选排序/“最值得做T 的 3 只” |
| 同池分位（必须写池名 + 样本数 + “相对位置”） | 用分位决定买卖/仓位/候选顺序 |
| 二元闸 `ok/code/detail`（唯一原因码） | 因子加权求和、z-score 合成、ML 综合分 |
| 事实行（“ADV20 36.5 亿”“距板 9.6%”） | 方向判断（“因为 ATR 低所以会涨”） |
| 缺失 `—` + 原因 | 0/50/均值顶替；省略字段 |
| 研究脚本里的 IC/分组描述 | 把 IC 写成“预测能力/胜率/推荐” |

**落地检查（实现时出现以下任一，直接判违规）：**

- 回包/日志出现 `score|totalScore|rating|confidence|rank|topN|recommend|best|preferred` 字段；
- 因子库/弹窗出现“推荐/首选/最优/值得买/该做T/看多/看空”文案；
- 用多个因子算一个总分或星级；
- 按因子值给候选池排序（`groupRank` 既有排序只允许在显式的分组工具里，且文案必须写“不是买卖建议”）；
- 把 `ATRRANK120` 解释成“排名”或“跨标的比较”。

### 6.3 与现有因子库 UI 的边界

- 因子库抽屉（v0.255.0/v0.256.0）目前 10 列；**P1 不新增列/卡片/面板**。
- 新因子只进：① `prism-factor` 日志；② `t-gate` 的影子 `gateCode`；③ 主决策事实行（如果产品批准）。
- 任何新增列、筛选、tab、面板都属于 UI 变更：按 PRD §3.1，新增面板/列/卡片是**大改**，必须先出 HTML 原型并经用户审核；本期不做。
- ≤860px 不得新增隐藏列（P2-2）；30s 刷新路径不得新增字段（P2-11）。

### 6.4 一句话边界

> **因子层不是审计修复的替代品，也不是第二套决策者。**
> 它只做两件事：把“为什么没做T”说清楚；把“这笔单能不能做成”变成可核对的事实。
> 如果只能做一件事，先修 `#10/#11/#16/#24/#20`，不是加因子。

---

## 7. 结论与下一步

### 7.1 最终施工排序

| 排序 | 因子 | 结论 |
| --- | --- | --- |
| **1** | `LIQ.ADV20` + `EXE.FILL` | **先做**：唯一缺失的“相对市场容量”硬约束；零新数据；G7 原因码；当前 7 只不 binding，是规模/标的变更的保险丝 |
| **2** | `EXE.LIMITDIST` | **先做**：锁板尾部风险；f47/f48 已有解析先例；G8；历史 10.1% 触发，阈值需盘中校准 |
| **3** | `INT.VWAPDEV` | **先做**：做T挂单缺当日均价锚；行情 `amount/vol` 零新增；公式误差 0.006%；但只能 live/前向，验证周期最长 |
| 4 | `VOL.ONSHARE20` | 缓做：与 ATR 低相关（模型层 48 只 −0.09；本机 33 只 −0.35），但属结构解释；先落盘/研究，事实行需产品批准，不进 gate |
| 5 | `LIQ.RVOL` | 缓做：当日量能节奏；12 天剖面只够管线，需 ≥120 天 |
| 6 | `VOL.DAYAMP_PROJ` | 缓做：12 天 51/52 通过，无区分度；等死日样本 |
| 7 | `VOL.GAP` | 缓做：0.21% 频率，太稀有；先记录 |
| 8 | `PRT.BETA60` | 缓做：组合风险，不服务 T；等 #11 |
| 9 | `SEN.LEVTEMP` | 缓做：4,025 行历史，但 T+1/市场级；只落盘，环境展示需产品批准 |
| 10 | `SEN.BREADTH` / `SEN.MAINNET` | 缓做：只有 2 天/无历史；只记录，不做分/不做择时 |
| 11 | `EXE.SLIP` / `EXE.FILLRATE` | 缓做：模拟撮合 0bp、#17/#23 未修；先做研究脚本 |
| — | 其余 13 项 | 不做：冗余/无数据/违反 D1/R1–R3 |

### 7.2 下一步（需要产品/工程裁决的三件事）

1. **是否批准 Phase 0 口径修复**（B1–B6）？不修，新增因子不可解释。
2. **是否批准 3 个因子以“纯函数 + 日志 + 影子”形态进入下一轮**？不接 gate、不加 UI、不进主决策下单。
3. **是否接受“今天没有任何新因子可以上线”**？如果必须上，只能上“事实行/日志”，不能上“门槛/评分/推荐”。

**建议**：先做 Phase 0 + Phase 1；Phase 2 只写日志；Phase 3 只做管线联调；在 G2/G3 样本达标前，`t-gate-v2` 的判定保持原样。**如果只允许加一个因子，选 `ADV20/FILL`；如果只允许改一处，选 `EFF20` 接线（已有因子，零新数据）。**

---

## 附录 A：本机实测数字（2026-11-26）

| 项 | 数字 | 来源/口径 |
| --- | --- | --- |
| 日K `fqt=1` 文件 | 57 个；单文件最多 **834 根** | `~/.dsh/dsh-tradewatcher/klines/*_101_1.json` |
| A股/ETF 日K | 49 只（39 股票 + 10 ETF）；≥250 根 46 只；最新 2026-11-26 的 33 只 | FACTOR-VALIDATION §1.1 |
| 1 分钟稠密日 | 12 天（2026-11-05 起）；A股/ETF 22 只 | FACTOR-VALIDATION §1.2 |
| 做T计划/成交/结果 | plans 25（全 aborted）/ trades 24（12 个计划的单腿分批）/ results **0** | `prism-autot.json` |
| 净值点 | 27 个（2026-10-22 → 11-26） | `prism-equity.json` |
| 因子分布（33 只 fresh） | ATR14 中位 **4.95%**、AMP20 中位 **4.60%**、EFF20 中位 **24.7**、pos20 中位 **10.9** | 本机复算 |
| 相关性 | ATR/AMP **0.968**；ATR/RV **0.934**；AMP/RV **0.944** | 33 只 fresh，Pearson |
| 缺口频率 | `abs(gap)>2×ATR` **17/8,068 = 0.21%** | 33 只 × 最近 250 日 |
| DAYAMP 过滤 | 10:30 `PROJ≥2s`：**51/52 通过**（7 只 × 12 天） | 1 分钟 trends |
| ADV/FILL | 7 只做T标的，20% 底仓、10% 参与率：**0.0–0.2 min** | 日K + 行情 + 账户 |
| LIMITDIST | 当前 7 只 **9.1%–19.8%**；历史 250 日 `1.5×ATR` 触发 **10.1%**（1,750 name-day，收盘口径） | 日K + 规则表 |
| VWAP 公式误差 | 5 只、35 个可得 name-day，最大 **0.006%** | trends 分钟 `amount/vol` vs 上游 `avg` |
| 871 笔 fill 滑点 | 中位 **0.00bp**（全部按委托价成交） | `prism-orders.json` |
| 因子日志 | 30 天保留；当前字段仅 5 个 | `prismFactorLog.ts` |

> 这些数字是**描述性**的：它们能说明“因子是否可算/是否共线/是否常触发”，不能说明“因子有效”或“做T赚钱”。

## 附录 B：代码与文档锚点

| 主题 | 位置 |
| --- | --- |
| 因子计算 | `src/host/prismFactors.ts:58`（ATR）、`:68`（AMP20）、`:82`（ATRRANK120）、`:116`（RSI）、`:136`（`factorMetricsOf`）、`:149`（EFF20） |
| 做T门槛 | `src/host/prismGates.ts:11`（`AUTO_T_RULES`）、`:100`（`evaluateAutoT`）、`:111`（`isEtf=false`） |
| 主决策因子表 | `src/host/prismRoutes.ts:426`（`factorsCachedOf`）、`:501`（注入）；`src/host/prismPipeline.ts:187`（事实行规则） |
| 自动做T接线 | `src/host/prismRoutes.ts:700-800`（`placeAutoTPairs`、gate、日志） |
| 因子日志 | `src/host/prismFactorLog.ts:1-60`（30 天、5 字段） |
| 日K缓存 | `src/host/em.ts:2493`（`KLINE_FULL_LMT=800`）、`:3467`（`slice(-want)`）、`:2531`（`KLINE_CACHE_V=3`） |
| 分钟归档 | `src/host/trendArchive.ts:13`（`TREND_ARCHIVE_KEEP_DAYS=12`） |
| 行情字段 | `src/shared/model.ts:130-184`（`QuoteRow`：amount/turnover/volRatio/mainNet/superNet/totalMv/floatMv） |
| 52 周位置 | `src/host/position.ts`（`POSITION_WINDOW`、`positionOfBars`） |
| 指数技术面/RSI Wilder | `src/host/indexTech.ts:86` |
| 候选池量比 | `src/host/candidateStats.ts:37` |
| 因子规范 | `docs/FACTOR-SPEC.md` §2.1/§4.2/§6.1 |
| 验证门槛 | `docs/FACTOR-VALIDATION.md` §4.8/§5.3/§6/§9 |
| 产品边界 | `docs/PRD-FACTOR.md` D1/D2、§1.5、§2.5 |
| 审计 | `docs/AUDIT-AUTOT-HOST.md`（24）、`docs/AUDIT-PRISM-UI-POLISH.md`（20） |
| 实施口径/数据源限制 | `docs/FACTOR-IMPLEMENTATION.md` §1.4/§7（ETF 20%、无 IOPV、无历史 PE/PB、无真价差） |

## 附录 C：符号与单位

| 符号 | 含义 |
| --- | --- |
| `C_t/O_t/H_t/L_t` | 第 t 根**已完成**日K 的收盘/开/高/低；fq=1 |
| `V_t` | 第 t 根成交量，单位**手**（1 手 = 100 股/份） |
| `P` | 实时现价；原始价 |
| `p0` | 昨收；原始价 |
| `s` | 做T档距：`ATR14%/4` |
| `ρ` | 参与率：`settings.participationRate`，默认 0.10 |
| `N` | 单轮名义额：`shares × P` |
| `U/D` | 涨停/跌停价；fq=0 |
| `ADV20` | 20 日日均成交额（元） |
| `FILL` | 按参与率填完所需分钟数 |
| `VWAP_t` | 当日累计成交额 ÷ 累计成交量（股） |
| `LIMITDIST` | 距最近涨/跌停的百分比距离 |
| `DAYAMP` | 当日已走振幅 `(H_day−L_day)/p0×100` |
| `EFF20` | 20 日趋势效率（0–100；SPEC 目标 0–1） |
| `ATRRANK120` | 当前 ATR% 在自身最近 120 个 ATR 观测中的分位（0–100） |

---

**文档结束。本文只做研究与排序，不构成任何买卖建议、评分或推荐。**
