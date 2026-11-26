# FACTOR-VALIDATION — 因子验证与做T反事实回放（可执行方案）

- 基线：任务指定 `dsh-tradewatcher` **v0.249.0** / HEAD `2a91e97`（2026-11-26 14:01 +08）；盘点后工作树前进到 **v0.250.0 / `e181bce`**（新增 `prismFactors/prismGates` 纯函数与四份文档），本文数据仍按 2026-11-26 快照，引用行号以 v0.249.0 为准。
- 数据快照：本机 `~/.dsh/dsh-tradewatcher`，**2026-11-26 15:00 CST** 只读盘点。
- 性质：**只设计、只读、不改代码**。本文不实现任何脚本，不修改 `src/**`；落地时新增 `research/factor-validation/` 与独立输出目录，不进入生产构建。
- 规范层级（先说清，避免和同仓文档打架）：
  - **模型层**：`docs/FACTOR-SPEC.md` 是因子公式 / 单位 / 窗口 / 复权 / 缺失 / PIT / 阈值算法的**唯一来源**；本文的因子 ID 与公式一律对齐它，不另造口径。
  - **产品层**：`docs/PRD-FACTOR.md` 定上线范围、文案、分期、验收；本文是**研究/验证设计**，不改变 PRD 的 D1（因子层只服务做T）与 P1 范围。
  - **工程层**：`docs/FACTOR-IMPLEMENTATION.md` 回答怎么落；本文只回答「怎么证明它对不对」。
- 承接的既有评审：
  - `docs/RESEARCH-QUANT.md`：现有撮合「价格触及即全额成交」、无 volume、无部分成交；评估必须先修口径。
  - `docs/RECON-PAPERTRADE.md:280`：ICIR 未年化、年化口径混用；借用 IC/RankIC/分层数学，不继承其 ICIR 语义。
  - `docs/AUDIT-AUTOT-HOST.md`：自动做T 的一腿成交/强制回补/双缓存 P0 会破坏净持仓与统计，**不能把 `prism-autot.json` 的盈亏当基准真相**。
  - `docs/AUDIT-PRISM-ACCOUNTING.md`：`netCost` 可为负、`realized+unrealized≠equity−capital`；做T 收益必须按**逐笔现金流**独立核算，不读 `realized/unrealized`。
  - `docs/DESIGN-RESCUE-VALIDITY.md`：本仓「证据不足」的写法与最低样本纪律；本文沿用「命题→方法→数字→判定」结构。

---

## 0. 结论先行

> **当前数据只能做「管线联调 + 日线面板假设生成」，不能宣布任何因子或做T门槛「有效」。**

三条硬缺口，按优先级：

| # | 缺口 | 现状 | 后果 |
| --- | --- | --- | --- |
| 1 | **做T没有一轮完整往返** | 25 个计划全部 `aborted`；24 条成交记录实际是 **12 个计划的单腿分批成交**；`results=0` | 无法计算做T净期望、PF、legOut、尾部；任何「做T赚钱」的说法都没有证据 |
| 2 | **日内样本只有 12 天** | `trends` 39 个自然日，其中 12 个稠密日；28 只全程有 ≥230 点，A股/ETF 22 只；持仓 name-day 仅 **80** 个（按 20% 底仓≥100 股过滤后 **67** 个） | 日内因子/入场时点的日级 cluster 只有 12 个；置信区间极宽，不能做统计结论 |
| 3 | **日线复权样本不完整且是「今天的池」** | 226 个 kline 文件 → 105 个唯一标的；v3 日线 89 只、fqt=1 仅 55 只；A股/ETF 49 只（39 股票+10 ETF），≥250 根 46 只；当前最新 33 只 | 只能做「固定观察池」面板；不是全市场，也不是 PIT universe；存在幸存者/回填偏差 |

**执行顺序（任何一步失败即停，不跳步）：**

```
G0 数据门：快照 + 清洗 + 排除台账 + 前视毒化测试
   ↓
G1 日线门：固定池 IC/分组/子周期/placebo（现在可跑；结论只能写「面板内」）
   ↓
G2 回放门：做T反事实回放（当前 12 天只允许做管线验收，不允许做效果结论）
   ↓
G3 影子门：30 个交易日 × 3 轮/日 A/B（需要先有 G2/H3 门槛或 G1 因子通过）
   ↓
G4 上线门：G1+G2+G3 全过，且运行约束（fillRate/legOut/回撤）全过
```

**验收速查（详细版见 §9）：**

| 结论 | 必须同时满足 | 不满足时只能写 |
| --- | --- | --- |
| **因子有效（面板内）** | 500 日 / 30 只 + h=5 RankIC≥0.04 + ICIR≥0.5 + 方向一致≥55% + Q5-Q1≥0.8%/5d + 子周期≥3/4 + placebo p<0.05 + 稳健性≥80% + 确认段同号 | 弱候选 / 淘汰 / 样本不足 |
| **门槛有效** | 回放 Δnet(v2−v1)≥10bp/attempt 且 v2 净期望≥0、CI 下限>0、legOut≤20%、fillRate≥30%、v2 fill≥50%×v1、leave-one-out 不翻转、影子 CI 下限>0 | 回放有效待影子 / 样本不足 |
| **可上线** | 因子有效 + 门槛有效 + 影子 30 天通过 + 无安全停/无人工干预 | 面板内有效，不可上线 |
| **样本不足** | 任一最低样本门槛未达（日线<500日/30只；日内<120日/20只；回放<20日/100往返；影子<20日/50往返） | 只能写「样本不足，不能判断」 |

### 0.1 与 `FACTOR-SPEC` / `PRD-FACTOR` 的四个关键对齐

| # | 事项 | 本方案口径 |
| --- | --- | --- |
| 1 | **因子 ID** | 一律用 SPEC ID：`TRD.MOM20`、`TRD.MA20DEV`、`POS.PCT252`、`VOL.ATR14`、`VOL.AMP20`、`VOL.ATRRANK120`、`TRD.EFF20`、`LIQ.ADV20`、`EXE.TICK`、`EXE.FILL`、`EXE.LIMITDIST`、`PRT.WEIGHT`；扩展用 `TRD.MOM5/60`、`TRD.RSI14`、`VOL.RANGE20`、`VOL.BETA60`、`POS.PCT20`、`LIQ.VOLRATIO`、`EXE.FEE_RT`。本文括号里的旧名只作对照，不另立口径。 |
| 2 | **AMP20 ≠ RANGE20** | `VOL.AMP20` 是 20 日**日均**振幅（分母前收，中位约 4.54%）；`VOL.RANGE20` 是 20 日**区间**幅度（中位约 27.92%）。旧「20日振幅 ≥3%」是 RANGE20 口径，**在 v2 中已废止**；v1 仍保留作现行产品基线，但只用于量化差异。v2 的做T门槛只用 AMP20（建议阈值 1.2%），RANGE20 只做箱体描述。 |
| 3 | **门槛版本** | 产品现行是 `t-gate-v1`（PRD：ATR14≥1.5%、`amp20Pct`(RANGE20)≥3%、价差≥1.2%、净额门槛）；SPEC §4.2 给出 `t-gate-v2`（G0–G10：ATR 自适应下限、ATRRANK120≥40、AMP20≥1.2、EFF20≤0.45、TICK≤0.10%、FILL≤3min、LIMITDIST、netEdge≥0.25%、s=ATR14/4）。本方案把 **v1 作为基线、v2 作为待验证门槛**，H3 同时比较 `no-gate / v1 / v2` 三臂；不把 v1 的「几乎不筛」当成有效门槛。PRD 的 `amp20Pct` 是 RANGE20 口径；v2 按 SPEC 改用 AMP20 日均口径（阈值 1.2%），两者在报告里必须分列。 |
| 4 | **产品边界** | 即使 H1/H2 通过，也不得把因子接进 `candidateStats`、四路分析或主决策下单（PRD D1/R1–R3）；本方案只服务 autoT 的可执行性验证。影子 B 只允许用 **`t-gate-v2`** 或已通过 G1 的因子做 filter，不做评分/排序/推荐。 |

> SPEC 的 V1–V12（§7）是**实现层断言**，本文把它们当作 G0 数据门的一部分（见 §9.1）；SPEC 的 `FactorEnvelope` 字段是因子输出的最小契约，本文的 `computeAt` 输出必须能填满它。
>
> **本文的 IC/回放/影子是研究验证，不是产品 P1 功能**：PRD §1.5「不做因子回测引擎」仍然有效；研究代码只放 `research/factor-validation/`，不进 `src/**`、不进 UI、不进 `/prism` 回包。

---

## 1. 数据盘点（2026-11-26 15:00 CST）

### 1.1 klines

| 口径 | 数字 | 说明 |
| --- | --- | --- |
| 文件总数 | **226** | `~/.dsh/dsh-tradewatcher/klines/*.json` |
| 唯一 `secid` | **105** | 含 A股、ETF、指数、港股、美股、期货、商品、国债 |
| `klt=101`（日线）文件 | **194** | 其余为 102/103/104 周/月/年 |
| 日线 `v=3` 文件 / 唯一标的 | **140 / 89** | `KLINE_CACHE_V=3`；v1/v2 不可用（可能冻着盘中未完成 bar） |
| 日线 `v=1` / `v=2` 文件 | **51 / 3** | 读侧 `klineCacheUsable` 会判不可用并回源 |
| 日线 `fqt=1` 唯一标的 | **55** | 前复权；收益/因子只用这一口径 |
| A股/ETF 且 `fqt=1` | **49** | **39 股票 + 10 ETF** |
| 其中 ≥250 根 | **46** | 36 股票 + 10 ETF |
| 其中最后日期 = 2026-11-26 | **33** | 28 股票 + 5 ETF |
| 最后日期 < 2026-11-20（stale） | 全库 **24**；fqt1 A股/ETF **8** | 到 cutoff 不足则当日剔除，不 forward-fill |
| ≤66 根的文件 | **6**（其中 <60 根 **4**） | 1 根、40 根、47 根、1 根等；按**可用 fqt1 序列实际根数**判断，不按文件名 |

> `partial=true` 的最后一条 bar 是盘中未完成柱（TTL 60s，`em.ts:2533/2625`）；回测必须丢弃，不能当收盘 bar。
>
> 与 `FACTOR-SPEC.md` 的「56 只」差异：SPEC 的样本含指数/重复文件/其它口径；本文按 **secid 去重 + 只保留 A股/ETF** 得 49 只，主横截面再要求 ≥250 根得 36 只股票。分母不同，不改变「固定池、非 PIT」的结论。

### 1.2 trends（1 分钟）

| 口径 | 数字 | 说明 |
| --- | --- | --- |
| 文件总数 | **842** | `trends/<secid>/<YYYY-MM-DD>.json` |
| 有数据自然日 | **39** | 2026-09-23 → 2026-11-26，含稀疏日 |
| 稠密日（≥40 只） | **12** | 2026-11-05、11-12、11-13、11-16、11-17、11-18、11-19、11-20、11-23、11-24、11-25、11-26 |
| 12 天全程 ≥230 点的标的 | **28** | 其中 A股/ETF **22**（19 股票 + 3 ETF），港股 6 |
| A股/ETF name-day（12 天合计） | **379** | 不等于独立样本；日级 cluster 只有 12 |
| 持仓 name-day | **80** | 11 只持仓，按 1 分钟 ≥230 点 |
| 过滤 20% 底仓 ≥100 股后 | **67** | 9 只；`1.601872`(120股)、`0.002913`(339股) 的 20% 不足 100 股，剔除 |
| A股单日完整点数 | **238** | 09:31–11:30、13:01–15:00；要求 ≥230 |

### 1.3 prism-autot / equity

| 对象 | 数字 | 判定 |
| --- | --- | --- |
| `prism-autot.plans` | **25**，全部 `aborted` | 计划层无成功案例 |
| 有成交记录的计划 | **12** | 每个计划只有**一条腿**有成交 |
| `prism-autot.trades` | **24 条** | 是 12 个计划的单腿**分批成交**记录，不是 24 轮 |
| 两腿都成交的计划 | **0** | **0 个完整 T 往返** |
| `prism-autot.results` | **0** | 无法计算任何 T 净收益 |
| `prism-equity.points` | **27** 点（2026-10-22 → 11-26） | <30，不足以算稳定回撤/超额 |
| `benchmarkClose` | 1 点缺失 | 不能直接做超额；回放要用 kline 重建基准 |
| `prism-orders` | 335 委托 / 871 成交 | 只用于费用/拒单口径校准；不能替代 T 回放 |

> 「24 成交」必须读成「24 条腿的成交记录」；把它当「24 轮做T」会把样本量放大 12 倍，是本方案第一条要禁止的误读。
>
> `results=0` 的归因按 SPEC §4.5：`plans>0 & trades=0` 是执行层价格未触发；`trades>0 & results=0` 是**结算层缺陷**（`AUDIT-AUTOT-HOST` P0#1/#3），不是因子/门槛无效。因子层不产 `results`，只产 `tGateCensus` 与 `tGateSnapshot`；任何「0 轮」都必须能从门禁普查读出原因。
>
> `results=0` 的归因按 SPEC §4.5：`plans>0 & trades=0` 是执行层价格未触发；`trades>0 & results=0` 是**结算层缺陷**（`AUDIT-AUTOT-HOST` P0#1/#3），不是因子/门槛无效。因子层不产 `results`，只产 `tGateCensus` 与 `tGateSnapshot`；任何「0 轮」都必须能从门禁普查读出原因。

---

## 2. 样本与数据清洗规则

### 2.1 快照与 universe

**R1 快照不可变。** 以 `2026-11-26 15:00 CST` 为 `S0`；把 `klines/`、`trends/`、`prism-autot.json`、`prism-account.json`、`prism-orders.json`、`prism-equity.json`、`positions.json`、`prism-factor/`（若已存在）复制/硬链接到 `data/snapshots/S0/`，生成 `manifest.json`（逐文件 sha256、字节数、mtime）。任何测试只读 `S0`；新增数据 = `S1`，不得覆盖 `S0`。

**R15 universe 快照。** 生成 `universe.csv`，一行一个 `secid`，字段：

```text
secid, name, type(stock|etf|index|other), board(main|star|chinext|bse|etf),
industry, lot, tick, stamp_exempt, t_plus, limit_rate, list_date, first_bar, last_bar,
bars, fqt1_ok, v3_ok, has_1min, held_at_S0, in_watchlist, in_universe, exclude_reason
```

规则：

- **U_FIXED（可执行）**：`type in (stock, etf)` 且 `fqt1_ok` 且 `v3_ok`；股票 39 只、ETF 10 只。股票为**主横截面**；ETF 只有 10 只，**不做横截面 IC**，只做时间序列/池化描述。
- **U_PIT（当前不可得）**：按历史 membership 的 point-in-time universe。`positions.json` 只有当前 11 条的 `createdAt`（2026-09 起），没有历史自选/持仓快照，无法重建 2023–2026 的 PIT 池。
- 因此 U_FIXED 的结果一律标注 **`BACKFILL-SURVIVOR`**：它是「今天还在池子里的名字」的历史面板，不是全市场，也不是 PIT。**不能据此宣布市场级因子有效**。
- `industry` 取东财 `f127`（`em.ts:4130`）；缺失则 `industry=null`，该标的只能进 raw IC，不能进行业中性检验。
- 快照冻结后，测试期间不得新增/删除标的；任何变动走 `S1` 并重跑全部基线。

### 2.2 K 线文件级清洗

**R2 只认 v3 + fqt=1（收益/因子）。**
- 日线：`v===3 && klt===101 && fqt===1`。
- v1/v2 文件不得直接读入因子面板；要么回源重取 v3/fqt1，要么整只剔除。
- `fqt=0` 只用于：涨跌停价、除权比对、指数/ETF 基准；**不得与 fqt=1 混算收益**。
- 同一 `secid` 同时有 fqt0/fqt1 时，只取 fqt1；不得按文件 mtime 选。
- **口径读回包**：以 `KlineData.fqt`/`normalizeFq` 的结果为准，不把请求的 `fqt` 当实际口径；指数/期货 `normalizeFq` 恒为 0。

**R3 `partial` 处理。**
- `partial===true` 的最后一条 bar 丢弃；若丢弃后不足该因子最小根数，当日/该标的置 `null`，原因 `PARTIAL_LAST_BAR`。
- 盘中运行（cutoff < 15:00）时，当日 bar 一律视为未完成，不进入因子。

**R4 排序、去重、日期。**
- 按 `date` 升序；同一日期重复只保留最后一条（必须同 fqt），并在排除台账记 `DUP_DATE`。
- 输入可以包含 `date > cutoff` 的 bar，但进入计算的有效序列必须全部 `<= cutoff`；`computeAt` 输出不得引用任何 cutoff 之后的值。
- 日期格式 `YYYY-MM-DD`；时区固定 `Asia/Shanghai`；不得用 `Date.now()` 推日期。

**R5 OHLC 合法性。**
- `low <= min(open,close) <= max(open,close) <= high`，且 `price>0`、`high>=low`、`vol>=0`；否则整行剔除并记 `BAD_OHLC`。
- `vol===null` 可用于价格因子；用于量能因子时置 `null`，不得当 0。

### 2.3 交易日、停牌、涨跌停、除权、ETF

**R6 交易日历与缺失。**
- 以 `1.000300` 的日线日期为交易日历（指数无复权，fqt=0 可用）；缺失日 = 停牌/无交易。
- **不 forward-fill**：因子窗口内缺一天 → 该因子 `null`；forward return 的起点或终点缺失 → 该 name-day 从该 horizon 剔除，记 `NO_TRADE_DAY`。
- 连续停牌 >5 个交易日（20 日窗口内）→ 该窗口 `null`，记 `SUSPENDED_WINDOW`。

**R7 最少 bar 数。** 见 §2.4；全局研究门槛 `MIN_RESEARCH_BARS=120`，生产门槛 `MIN_PRODUCTION_BARS=250`。低于门槛的标的不进入横截面，避免「1 根 bar 的因子」污染分位。

**R8 停牌/无成交。**
- 停牌日不参与 T；因子窗口含停牌 → `null`。
- `vol===0` 且价格不变视为无成交；价格因子可保留，量能因子置 `null`；T 的成交模型该分钟不成交。

**R9 涨跌停。**
- 涨跌停价优先取行情 `f47/f48`（腾讯已有）；缺失才按 `roundToTick(prevClose_fqt0 × (1 ± rate))` 规则表。`prevClose_fqt0` 是**不复权**前收；ETF 按 0.001 取整，股票按 0.01。
- rate：主板 10%；科创板 688 / 创业板 300·301 20%；北交所 8xx/4xx 30%；ST/*ST 5%（本文直接剔除 ST）；ETF 默认 10%，科创/创业板相关 ETF 20%（以 universe 快照的 `limit_rate` 为准；不确定 → `null`）；新股上市后前 5 日无涨跌停 → `null`。
- 一字板判定：`high===low===limit`，或最后 ≥5 分钟 `last===limit` 且成交量为 0；T 回放遇到一字板直接跳过（买不到/卖不出）。
- 触板未封：允许，但 T 的保守成交模型通常不会成交；不要假设排队优先。

**R10 除权除息。**
- 收益/因子用 fqt=1；涨跌停/前收用 fqt=0。
- 若同一标的 fqt0 与 fqt1 在某一日的比率跳变 >1%，标记 `CORPORATE_ACTION`；`VOL.AMP20`、`LIQ.VOLRATIO`、`INT.AMOUNT_RATIO` 在该窗口置 `null`（成交量/额可能被拆分调整）。
- 单日价格跳变 >30%（股票）或 >15%（ETF）且不在涨跌停 → 标记 `PRICE_JUMP`，该 name-day 从因子/回放剔除；不得用「异常值 winsorize」掩盖。
- **除权日当天 `distLimitUp/Down=null`**：涨跌停要用交易所除权参考价，本地只有 fqt0 前收，直接用会把 limit 算错；宁可不做。

**R11 ETF 特殊处理。**
- tick=0.001；lot=100；`stamp_exempt=true`（卖出免印花税）；默认 T+1。
- T+0 白名单：`511xxx` 债券 ETF、`518xxx` 黄金 ETF、`513xxx` 跨境 ETF；其余按 T+1。白名单写入 universe 快照，不靠名字猜。
- ETF 分红/拆分：用 fqt=1；缺 fqt=1 的 ETF 不进入收益因子。
- ETF 横截面只有 10 只，**不做 IC 分位**；只做「ETF 池内时间序列/事件研究」，并与股票分开报告。

**R12 ST / 新股 / 北交所。**
- 名称含 `ST`、`*ST`、`退` 的标的：从因子横截面和 T 回放中剔除（5% 涨跌停 + 流动性/退市风险）。
- 上市后前 60 个交易日：不进入因子；上市后前 250 个交易日：不进入生产门槛。
- 北交所 30% 涨跌停、流动性差：只做描述，不进入主横截面。

**R13 stale。**
- `last_bar < cutoff` 的标的，该 cutoff 不进入横截面；不得用旧价格 forward-fill。
- 当前 fqt1 A股/ETF 有 8 只 stale；全库 24 只。快照报告必须列出名单。

**R14 异常值与权重。**
- IC 用 Spearman（秩），不做 winsorize；分组收益对因子/forward return 做**按日 1%/99% winsorize**（只影响均值，不影响秩）。
- 等权为主；另报「按成交额加权」作为稳健性，不得用市值加权（没有可靠市值）。

### 2.4 最少 bar 数（单因子）

| 因子 | 公式所需最少 bar / 观测 | 说明 |
| --- | ---: | --- |
| `TRD.MOM5` | 6 | 5 个收益 + 当前 |
| `TRD.MOM20` | 21 | |
| `TRD.MOM60` | 61 | |
| `TRD.MA20DEV` | 20 | 20 个收盘；建议 21 以留 1 根缓冲 |
| `TRD.MA60DEV` | 60 | 建议 61；不在 SPEC 扩展表 |
| `TRD.RSI14` | 15 | Wilder 需要 14 个差分 |
| `VOL.ATR14` | 15 | Wilder ATR |
| `VOL.AMP20` | 21 | 20 个 (H−L)/prevC |
| `VOL.RANGE20` | 20 | 20 日高低 |
| `VOL.ATRRANK120` | 60 个 ATR 观测 | V120 最多 120 个观测；<60 → null |
| `TRD.EFF20` | 21 | 20 个日变动 |
| `POS.PCT252` | 约 245 根 / 365 自然日 | 窗口内 <2 根 → null；上限 300 根 |
| `POS.PCT20` | 20 | 20 日高低 |
| `LIQ.ADV20` | 21 根 / 有效量 ≥15 | V 单位手；×100×C |
| `LIQ.VOLRATIO` | 20 | 5 日/20 日均量 |
| `VOL.BETA60` | 61 | 60 个收益对 benchmark |
| `EXE.TICK` | 有 P | tickSize/资产类别表 |
| `EXE.FILL` | 有 ADV20 与 N | N=计划股数×P |
| `EXE.LIMITDIST` | 有 U/D 或 p0 | 行情 f47/f48 优先 |
| `INT.AMOUNT_RATIO` | 21 日线 + 当日分钟 | 20 日均额 + 当日累计额 |
| `INT.VOLPACE` / `INT.AMTPACE` | 10 个历史同日 profile + 当日分钟 | 不足 10 天 → null |

**全局：**
- 研究横截面：`bars >= 120`；生产：`bars >= 250`。
- 只有短窗因子（`TRD.MOM5/20`、`TRD.MA20DEV`、`TRD.RSI14`、`VOL.ATR14`、`POS.PCT20`）可在 60–119 根时做**单因子描述**，但不得进入横截面排名/生产。
- 1–66 根的文件/标的：一律不进入主表；只在排除台账列出。
- **产品门槛的 25 根 ≠ 研究横截面的 120/250 根**：v1/v2 的 `bars>=25` 是运行时「能不能算 ATR」的下限；研究面板要求 120/250 是为了让 60 日因子和 forward 收益有足够历史，二者不能互相替代。

### 2.5 1 分钟数据清洗

**R16 完整性。**
- A股单日应有 238 点（09:31–11:30、13:01–15:00）；`points >= 230` 才可用于 T；`<230` 该 name-day 剔除，记 `SHORT_MINUTE_SERIES`。
- 有效首点应为 09:31；若文件首点是 09:30/09:25，先丢弃集合竞价点，再确认 09:31 存在（`price` 可能不是连续成交价）。
- 11:30–13:00 午休不算缺口；13:00 点若存在，丢弃（非连续竞价）。
- 相邻点间隔 >5 分钟：记 `MINUTE_GAP`；超过 2 个缺口 → 该 name-day 不用于 T。

**R17 零量 / 单位。**
- `vol<=0` 的分钟：价格因子可用；T 成交模型不得成交。
- 零量点占比 >5% → 该 name-day 不用于 T（流动性不合格）。
- **成交量单位先校准为「股」**：trends 的 `vol` 若为「手」，×100；日线 `vol` 与分钟 `vol` 必须同单位；无法确认单位 → 该 name-day 不做 T（10% 分钟量会差 100 倍，宁可不出结论）。

**R18 cutoff。**
- `computeIntradayAt(points, cutoffTs)` 只取 `t <= cutoffTs` 的点；cutoffTs 必须正好是某根**已完成**分钟的收盘时刻；若该点还在变化（当前分钟），丢弃。
- 5 个入场时点的 cutoff 严格是 `09:45/10:30/11:15/13:30/14:00` 的**整分**；不得用「最近一根」替代。

**R19 前视毒化测试（强制）。**
- 在 `bars` 末尾追加一根 `cutoff+1` 的假 bar（价格 +50%、量 ×100），`computeAt` 输出必须**逐字段完全不变**；否则整条因子管线判失败。
- 对 1 分钟序列同样：在 cutoff 后追加假点，输出不变。
- 静态检查：`computeAt` 不得调用 `Date.now()`、`Math.random()`、不得读全局缓存。

**R20 排除台账。**
- 每个被剔除的 file/name-day 写一行：`rule_id, secid, date, reason, detail`。
- 报告必须给出每个 rule 的剔除数量；任何「默默丢掉」都算验收失败。

---

## 3. `computeAt` 纯函数契约

### 3.1 签名

> 对外统一入口可叫 `computeAt(bars, cutoff, kind)`；内部按 `kind` 拆成下面两个函数，二者共享同一套纯度/毒化契约。

```ts
// 日线：cutoff 是 YYYY-MM-DD（收盘后）
computeDailyAt(bars: readonly DayBar[], cutoff: string): DailyFactorFrame

// 日内：cutoffTs 是 epoch ms（该分钟收盘）
computeIntradayAt(points: readonly TrendPoint[], cutoffTs: number, ctx: IntradayCtx): IntradayFactorFrame
```

**PIT 两个视图（SPEC §5.1，先于任何公式）：**

| 视图 | 定义 | 允许进入的因子 | 绝不允许 |
| --- | --- | --- | --- |
| `dailyFinal` | `barDate < today` 的全部 bar；若已过 15:05 且当日 bar 来自收盘后回源，则含当日 | 全部慢因子（MOM/MA/ATR/AMP/RANK/EFF/ADV/PCT） | 盘中由实时快照补出的那根 `liveTodayBarOf` |
| `intradayNow` | 今日分时点 + 实时行情 + 当日累计 VWAP | 只允许替换**一个标量 P**；以及 `INT.VWAPDEV`/`INT.POSDAY`/`INT.RET30M` 等纯盘中量 | 替换窗口内任何一根历史 bar |

> 唯一合法的混用：`MA20DEV = (P_now / mean(C_{t-19..t} [全部 final]) - 1)`。分子盘中、分母 final；反过来不允许。本文 `cutoff` 一律指 **最后一根 final bar 的 barDate**；盘中跑 T 查询时 `cutoff = prevTradingDay(today)`，15:05 后才可等于 today。

**窗口上限**：单因子窗口 ≤300 根（52 周约 245 根），日K缓存 800 根；超过 800 根的历史分位（如 3 年 ATR 分位）本仓不支持，必须 `null` + 「历史窗口超过 800 根」，不得静默用 800 根近似。

**硬约束：**

1. **纯函数**：无 I/O、无 `Date.now()`、无随机、无全局可变状态；不修改入参。
2. **cutoff 包含**：只使用 `date <= cutoff` / `t <= cutoffTs` 的 bar；cutoff 之后的数据不得参与任何中间量（包括 warmup）。
3. **按日期/时间排序**：内部排序，但断言无重复；不依赖调用方顺序。
4. **确定性**：同一输入多次调用逐字段相等；浮点结果保留 10 位小数后比较。
5. **null 语义**：不足/不可算 → `null` + `reason`，**不得用 0、前值、均值顶替**。
6. **输出元数据**：`asOf`（最后一根 bar 的 date/ts）、`barsUsed`、`fqt`、`partialDropped`、`warnings[]`。
7. **毒化测试**：见 R19；`computeAt` 输出断言 `asOf <= cutoff`，但**输入允许包含** cutoff 之后的 bar（正常缓存就有），函数必须先过滤。
8. **输出契约**：每个因子值必须能填满 SPEC §5.3 的 `FactorEnvelope`：`v/unit/asOf/dailyFinalAsOf/intradayAsOf/fq/window{kind,n,from,to,samples,need}/stale{is,level,ageMs,approxWorkdays,reason}/src/quality/missing`。`v===null ⇔ missing!==null`；样本不足返回 `0` 直接判失败（V5）。

### 3.2 日线因子定义

> 所有收益/比率用**小数**（0.05 = 5%）；展示时 ×100。`C_t` 是 cutoff 当日收盘；`vol` 单位按数据源（股/手）保持一致，只用比值。

| ID（SPEC） | 旧名/本文别名 | 公式 | 最少 bar | 角色 | 备注 |
| --- | --- | --- | ---: | --- | --- |
| `TRD.MOM20` | `ret20` | `C_t/C_{t-20}-1`（小数；SPEC 显示为 %） | 21 | **H1 分量** | 正方向 |
| `TRD.MA20DEV` | `distMA20` | `C_t/mean(C_{t-19..t})-1` | 20 | **H1 分量** | 正方向 |
| `TRD.MOM5` | `ret5` | `C_t/C_{t-5}-1` | 6 | 探索 | 短周期 |
| `TRD.MOM60` | `ret60` | `C_t/C_{t-60}-1` | 61 | 探索 | 中期 |
| `TRD.MA60DEV` | `distMA60` | `C_t/mean(C_{t-59..t})-1` | 60 | 探索 | **不在 SPEC 扩展表**；仅作候选，不进门禁 |
| `TRD.RSI14` | `rsi14` | Wilder RSI(14)，0–100（复用 `indexTech.rsiOf`） | 15 | 探索 | `avgLoss=0 → 100`（含全平盘，按现有 `rsiOf` 口径）；`avgGain=0 → 0`；缺 15 根 → null |
| `VOL.ATR14` | `atrPct14` | `ATR14/C_t×100`；`TR=max(H-L, abs(H-PC), abs(L-PC))` | 15 | 探索 / T 门槛 | Wilder；单位 % |
| `VOL.AMP20` | `meanDailyRange20` | `mean((H_i-L_i)/C_{i-1})×100`，i=t-19..t | 21 | **T 门槛** | **日均振幅**；不是 RANGE20 |
| `VOL.RANGE20` | `range20` | `(max H_{t-19..t} - min L_{t-19..t})/C_t×100` | 20 | 探索/描述 | **区间幅度**；旧 `amp20` 真身；不得与 AMP20 混用 |
| `VOL.ATRRANK120` | `atrRank120` | `100 × #{v∈V120 : v≤ATR14%_t}/n(V120)`；每个观测只用其当日及之前数据 | 60 个 ATR 观测 | **T 门槛（v2 G3）** | 自历史分位，不是池内排名；<60 → null |
| `TRD.EFF20` | `trendEfficiency20` | `abs(C_t-C_{t-20}) / Σ_{i=t-19..t} abs(C_i-C_{i-1})` | 21 | **T 门槛（v2 G5）** | 0–1；越低越适合做T |
| `POS.PCT252` | `pos252` | `(C_t - min L_{365自然日}) / (max H_{365自然日} - min L_{365自然日})×100` | 约 245 根（≤300） | 探索 | SPEC 核心位置；窗口 365 自然日 |
| `POS.PCT20` | `pos20` | `(C_t - min L_{t-19..t}) / (max H_{t-19..t} - min L_{t-19..t})×100` | 20 | **H2** | 短窗位置；低=接近 20 日低点 |
| `LIQ.ADV20` | `adv20` | `(1/20)Σ V_i×100×C_i`，V 单位**手** | 21（有效量≥15） | **T 门槛/EXE.FILL** | 单位元；指数不可算 |
| `LIQ.VOLRATIO` | `volTrend5_20` | `mean(V_{t-4..t})/mean(V_{t-19..t})` | 20 | 探索 | 量比 5/20 |
| `EXE.TICK` | —（用户候选里的 `tickPct` 见 `INT.UPTICK`） | `tickSize/P×100`；股票 0.01，ETF 0.001 | 有 P | **T 门槛（v2 G6）** | 一跳占价格比；不是上涨分钟占比 |
| `EXE.FILL` | — | `N/(ADV20×ρ/240)`，N=单轮名义额，ρ=0.10 | ADV20 有效 | **T 门槛（v2 G7）** | 单位分钟；N 用计划股数×P |
| `EXE.LIMITDIST` | `distLimitUp/Down` | `min((U-P)/P, (P-D)/P)×100`；U/D 优先行情 f47/f48，缺失才按规则表 | 有 U/D 或 p0 | **T 门槛（v2 G8）** | 方向分量可另报 `DIST_UP/DIST_DOWN` |
| `EXE.FEE_RT` | — | `(feesOf(buy,P,R)+feesOf(sell,P,R))/N×100` | 有 P/R | **T 门槛（v2 G9）** | 含最低佣金；ETF 免印花 |
| `PRT.WEIGHT` | — | `MV_i/(cash+ΣMV)×100` | 有持仓/行情 | 组合暴露 | 不参与做T门槛 |
| `VOL.BETA60` | `beta60` | `Cov(r_i,r_b,60)/Var(r_b,60)` | 61（有效对≥55） | 探索 | benchmark=1.000300；fq=1 股票 |

> **单位**：本表 `TRD.MOM*` / `TRD.MA*DEV` 用小数（0.05=5%）；`VOL.ATR14` / `VOL.AMP20` / `VOL.RANGE20` / `EXE.TICK` / `EXE.LIMITDIST` 用百分数；`POS.*` / `VOL.ATRRANK120` 用 0–100；`TRD.EFF20` 用 0–1；`LIQ.ADV20` 用元。IC 用秩，单位不影响；分组收益统一换成 % 报告。**所有 V 先按 R17 校准为「手」**；源为「股」时先 ÷100。
>
> **ATRRANK120 的历史长度**：V120 是「最近 120 个 ATR 观测」，不是 120 根原始 bar；最少 60 个观测才可算。SPEC 的单因子窗口 ≤300 根、日K缓存 800 根；超过 800 根的历史分位不支持，必须 `null` + 原因。
>
> **P vs C_t**：`TRD.MA20DEV` / `POS.PCT252` 在 T 门槛/盘中用实时 `P` 替换 `C_t`（分母仍为 final 窗口），这是 SPEC §5.1 唯一允许的混用；日线回测没有盘中 P，才用 `C_t`。

### 3.3 日内因子定义

> `P_t` = cutoff 时最后一根 1 分钟 `price`；`VWAP_t` = 当日累计成交额/累计成交量（或数据源 `avg`，需通过合理性检查）。所有因子只用 `t <= cutoffTs` 的点。

| ID | 公式 | 最少数据 | 说明 |
| --- | --- | --- | --- |
| `INT.VOLPACE` | `cumVol(t) / E[cumVol at same clock]` | 当日 ≥10 点 + 10 个历史同日 profile | 历史 profile 用同一标的过去 10–20 个交易日的分钟-of-day 累计量均值；<10 天 → null |
| `INT.AMTPACE` | `cumAmount(t) / E[cumAmount at same clock]` | 同上 | 与 VOLPACE 同构；成交额更抗拆单 |
| `INT.AMOUNT_RATIO` | `cumAmount(t) / ADV20` | 21 日线 + 当日 ≥10 点 | 不做时间归一；与 AMTPACE 一起看 |
| `INT.UPTICK` | `N_up/(N_up+N_down)×100` | ≥10 个有效分钟 | `N_up=count(P_i>P_{i-1})`；平盘不计；分母 0 → null。**这是用户候选 `tickPct` 的口径**，不是 `EXE.TICK` |
| `EXE.LIMITDIST` | `min((U-P_t)/P_t, (P_t-D)/P_t)×100` | 有 U/D 或 p0 | U/D 优先行情 f47/f48；缺失按规则表；除权日/新股/ST → null。方向分量另报 `DIST_UP/DIST_DOWN` |
| `INT.VWAPDEV` | `P_t/VWAP_t-1`（报告 ×100%） | 当日 ≥30 点 + 累计量>0 | `VWAP_t=Σamount/(Σvol×100)`（vol 按 R17 校准为手；若源为股则去掉 ×100）；`avg` 需在当日价格区间 ±2%；必须带 `vwapFrom/vwapApprox/vwapSamples`（SPEC T7） |
| `INT.RET30M` | `P_t/P_{t-30m}-1` | 有 t-30m 的点（±1 分钟） | 09:45 天然无 t-30m；不跨午休 |
| `INT.POSDAY` | `(P_t-min(P,day))/(max(P,day)-min(P,day))×100` | 当日 ≥10 点 | running high/low；区间 0 → null |

> 用户给的候选名与本表 ID 的映射：`volPace→INT.VOLPACE`、`amountPace→INT.AMTPACE`、`amountToday/adv20→INT.AMOUNT_RATIO`、`tickPct→INT.UPTICK`、`distLimitUp/Down→EXE.LIMITDIST` 的两个方向分量、`vwapDev→INT.VWAPDEV`、`ret30m→INT.RET30M`、`posDay→INT.POSDAY`。`EXE.TICK` 是 SPEC 的「一跳占价格比」，不要和 `tickPct` 混用。

### 3.4 null 原因码（固定词表）

`NO_BARS`、`SHORT_HISTORY`、`PARTIAL_LAST_BAR`、`SUSPENDED`、`SUSPENDED_WINDOW`、`LIMIT_LOCKED`、`NO_VOLUME`、`NO_AMOUNT`、`STALE`、`BAD_OHLC`、`PRICE_JUMP`、`CORPORATE_ACTION`、`UNKNOWN_LIMIT_RULE`、`NOT_IN_UNIVERSE`、`MINUTE_GAP`、`SHORT_MINUTE_SERIES`、`ATR_RANK_SHORT`、`QUOTE_STALE`、`LKG_QUOTE`、`FILL_TOO_LONG`。

> 09:45 入场时，`INT.RET30M` 必为 `null`（没有 t-30m），`INT.UPTICK`/`INT.POSDAY`/`INT.VWAPDEV` 只有约 14 个点；这是设计使然，不得用更早的集合竞价点补足。`INT.VOLPACE`/`INT.AMTPACE` 在 12 天面板的前几天会因历史 profile <10 天而为 `null`；不得把 min profile 降到 3 天来凑样本（预注册固定 10 天）。

> 命名冲突：`tickPct` 在本方案明确为**上涨分钟占比**（0–100），不是逐笔涨跌幅；不要与「tick 收益率」混用。若产品原字段另有含义，实现时改名为 `upTickPct`，避免同名异义。

---

## 4. 日线因子 IC / 分组测试

### 4.1 面板构建

- 行：`(date, secid)`；列：每个因子值 + 1/5/20 日 forward 收益 + `tradable_*` 标志 + `universe_version`。
- 主横截面：**U_FIXED 的 39 只股票池**；进入横截面还要求 `bars>=250`（最多 36 只）。每天有效股票数 `N_t >= 30`，否则该日跳过。当前中位数 36 只，约 69% 的交易日 ≥30，约 **580 个有效日**。
- 次横截面：股票+ETF 合并（49 只），按 `type` 做**类型中性**（减去 type 内均值）后再算 IC；只作稳健性，不作主结论。
- ETF 单独：10 只，**不做横截面 IC**；只做时间序列/事件描述。
- 行业中性：用 `industry` 对因子和 forward return 做行业内 demean；`industry=null` 的标的不进中性检验。若行业字段缺失，报告 `SECTOR_NEUTRAL=NA`，不得声称「行业中性后仍有效」。

### 4.2 forward 收益（1/5/20 日）

对 cutoff `t`（收盘后因子）：

```text
r_close(t,h) = C_{t+h} / C_t - 1                 # 研究口径（假设收盘成交，仅作参照）
r_trad(t,h)  = C_{t+h} / O_{t+1} - 1             # 主口径（次日开盘进场，可交易）
```

- **主口径 `r_trad`**：信号在 t 收盘后生成，最早 t+1 开盘执行；`h=1` 即 t+1 开盘到 t+1 收盘，`h=5/20` 到 t+h 收盘。
- 若 `t+1` 开盘一字涨停（买不到）或停牌：该 name-day 从 `r_trad` 剔除，记 `ENTRY_UNTRADABLE`；`r_close` 仍保留作参照。
- 若 `t+h` 停牌/缺 bar：从该 horizon 剔除，记 `EXIT_UNTRADABLE`；不得用最后可得价顶替。
- 收益不做复权再调整（已用 fqt=1）；不扣成本（成本在分组净收益里单独扣）。
- 1/5/20 日重叠样本：点估计可用全样本；**置信区间必须按日 cluster + 重叠修正**（见 4.3）。

### 4.3 IC / ICIR / 方向一致天数

对每个因子 `f`、每个 horizon `h`：

```text
IC_t = Spearman( rank(f_{i,t}), rank(r_{i,t,h}) )   # 仅 i 同时有效，N_t>=30
meanIC = (1/T) Σ_t IC_t
sdIC   = sample_sd(IC_t)                            # ddof=1
ICIR_raw = meanIC / sdIC                            # 每期，不年化
```

- **年化 ICIR**：
  - `h=1`：`ICIR_ann = ICIR_raw × sqrt(252)`（日频非重叠）。
  - `h=5/20`：先取**非重叠**子样本 `t = t0, t0+h, t0+2h, ...`（`t0` 固定为第一个有效日，不许挑 offset；另报 h 个 offset 的平均作稳健性），再 `ICIR_ann = ICIR_raw × sqrt(252/h)`；非重叠窗口 <30 个 → `ICIR_ann=null`，只报 meanIC 和 NW t。
  - **禁止**对重叠的 h 日 IC 直接乘 `sqrt(252)`；这正是 `RECON-PAPERTRADE.md:280` 指出的错误。
- **方向一致天数**：`count(sign(IC_t)==expected)/T`；同时报原始「正 IC 天数」`count(IC_t>0)/T`（H2 预期为负，两个数会不同，必须并列）。
- **标准误 / t**：
  - `h=1`：`t = meanIC / (sdIC/sqrt(T))`。
  - `h>1`：`t = meanIC / NW_se(lag=h-1)`，NW 用完整 IC 序列估计方差；`T_eff = T/h` 只用于 ICIR 年化，不用于手算 t。也可按日 block bootstrap（block 长度 `h`，10,000 次）。
  - 同时报 95% CI（bootstrap 百分位）。
- **样本门槛**：`T >= 500` 个有效交易日；`median(N_t) >= 30`；因子覆盖率 `>= 80%`（有效 name-day / universe name-day）。否则 `样本不足`。

### 4.4 Q1–Q5 分组

- 每个交易日按因子值升序分 5 组（Q1 最低，Q5 最高）；`N_t<30` 或任一组 <5 只 → 跳过该日。
- 组收益 = 组内等权 `r_trad(t,h)`；按日汇总后取均值。
- 报：
  - `Q1..Q5` 的均值（% / h 日）；
  - `Q5-Q1`（正方向因子）或 `Q1-Q5`（负方向因子）；
  - `monotonicity = Spearman([1..5], [mean(Q1)..mean(Q5)])`；
  - `hitRate = count(spread_t > 0)/T`；
  - 净口径：每次换仓按单边 10bp 扣（`Q5-Q1` 毛收益 − 2×10bp；组内换手另算）。
- Q5-Q1 的 t 值按日 cluster / NW；不得把 name-day 当独立样本。

### 4.5 子周期与 regime

- 日历子周期：`2023H2、2024H1、2024H2、2025H1、2025H2、2026YTD`；每段至少 60 个有效日；不足 60 日记 `—`。
- 方向一致性：至少 4 段可评估，且 ≥3/4 段与预期同号；6 段全有则 ≥5/6。
- Regime：
  - 基准 `1.000300` 的 20 日收益 >0 / <0；
  - 基准 20 日 ATR 分位 top/bottom tercile（高波动/低波动）。
- 每个 regime 报 meanIC、方向一致天数；任一 regime 样本 <30 日 → `—`，不强行下结论。
- **子周期/regime 只在 Train+Validation 上做**；Confirmation（2026-07-01 → 2026-11-26）只做一次最终检验，不得参与子周期筛选/调参。

### 4.6 Placebo（阴性对照）

| 对照 | 做法 | 通过标准 |
| --- | --- | --- |
| 随机因子 | 每个 name-day 生成 N(0,1) 随机分数，500 次，算同样的 meanIC 分布 | 实际 `abs(meanIC)` > 95th percentile，且 `p<0.05` |
| 收益置换 | 日内打乱 forward return 与 name 的对应，500 次 | 同上；实际不能落在置换分布内 |
| 时间平移 | 用 `t+20` 的因子值预测 `t→t+h` 收益 | 应≈0；若 `p<0.05`，判数据泄漏，整条因子停用 |
| 毒化 bar | R19 追加未来 bar | 输出逐字段不变 |
| 随机 cutoff | 同一天随机取 5 个 cutoff 重算 | 因子值随 cutoff 单调可用；不得出现「未来值」 |

`p_placebo = (1 + #{|IC_b| >= |IC_obs|}) / (B+1)`，`B=500`；报告实际值、零分布 5%/50%/95% 分位。

### 4.7 多重检验

- **只允许 3 条预注册假设**（§7）进入「通过」判定；其余探索性因子全部标记 `探索性`，无论 IC 多好都不得直接上线。
- 3 条假设内用 Bonferroni `α=0.05/3≈0.0167`，或 BH-FDR `q<=0.10`；两条口径都报，以更保守者为准。
- 探索性因子若想转正：必须**重新预注册 + 用未看过的新样本**（至少 120 个新交易日或 30 天影子），不能在同一份数据上「再挑一次」。

### 4.8 通过 / 淘汰标准（日线）

| 状态 | 条件（全部满足） | 用途 |
| --- | --- | --- |
| **通过（面板内）** | 预注册假设；T≥500；median N≥30；覆盖率≥80%；h=5 `abs(meanIC)>=0.04` 且 95% CI 不含 0；`ICIR_ann>=0.5`；方向一致天数≥55%；Q spread≥0.8%/5d；monotonicity≥0.6；≥3/4 子周期同号；placebo p<0.05；稳健性 ≥80% 单元格同号 | 可进入 G2/G3 候选，但**不可直接上线** |
| **弱候选** | `0.02<=abs(meanIC)<0.04`，或 ICIR 0.3–0.5，或 Q spread 0.4–0.8% | 只观察；不得作为门槛 |
| **淘汰** | `abs(meanIC)<0.02`；或符号在 ≥2 个子周期翻转；或 Q spread<0；或 placebo p>=0.10；或稳健性 <60% 单元格同号 | 从候选池移除 |
| **样本不足** | T<500；或 median N<30；或覆盖率<60%；或 fqt1 可用标的 <20 | 不下结论；不得写「无效」或「有效」 |

> `h=1` 的阈值可降到 `|meanIC|>=0.03`、`ICIR_ann>=0.4`；`h=20` 因重叠严重，只作辅助，不单独作为通过依据。

### 4.9 输出物

```text
out/fv/<snapshot>/daily_panel.parquet
out/fv/<snapshot>/ic_summary.csv          # factor,horizon,meanIC,sdIC,ICIR_raw,ICIR_ann,posDays,dirDays,ciLo,ciHi,nDays,medianN
out/fv/<snapshot>/quintiles.csv           # factor,horizon,period,Q1..Q5,spread,mono,hitRate,nDays
out/fv/<snapshot>/subperiods.csv
out/fv/<snapshot>/placebo.json
out/fv/<snapshot>/exclusions.csv
out/fv/<snapshot>/run_manifest.json
```

---

## 5. 做T反事实回放

### 5.1 回放池

| 池 | 定义 | 用途 |
| --- | --- | --- |
| **T_HELD（主）** | S0 持仓 11 只 ∩ 12 个稠密日 ∩ 1 分钟 ≥230 点；80 个 name-day；20% 底仓 ≥100 股后 **67 个 / 9 只** | 产品口径：只对持仓做T |
| **T_ALL（次）** | 12 个稠密日 ∩ A股/ETF ∩ 1 分钟 ≥230 点；**379 个 name-day / 22 只** | 研究口径：因子与做T结果的关系；**不作产品结论** |
| **T_ATTEMPTS** | 每个 name-day × 5 个入场时点；主池约 **67×5=335** 次尝试 | 回放主表 |

- 历史回放的 `available` 假设：每日开盘 `available = qty`（前一交易日已持有，T+1 满足）；当日买入的股份不参与卖出腿。该假设写入 manifest。
- **持仓恒定假设**：把 S0 的 11 只持仓和 qty 反事实地回填到 12 个稠密日（不按真实历史持仓变动）；因此回放只回答「这套规则在这 12 天会怎样」，不是「账户真实做T收益」。
- 现金：用 S0 的 `cash` 作为每日起始现金；正T 买入金额不得超过现金；反T 不需要现金（卖出款可买回）。
- **每次 attempt 独立**：从同一日初账户状态开始（现金、qty、available 相同），不把上一次 attempt 的盈亏/持仓带到下一次；否则 5 个时点会互相污染。
- 同一 name-day 的 5 个入场时点是**同一情景的 5 个反事实**，不是 5 个独立样本；主指标先按 name-day 聚合（5 个时点等权），再按日 cluster。

### 5.2 五个入场时点（预注册，不许改）

| 时点 | 理由 |
| --- | --- |
| **09:45** | 跳过 09:30–09:45 集合竞价/开盘 15 分钟噪声；留足 5 小时 |
| **10:30** | 上午趋势确认；距 14:50 还有 4h20m |
| **11:15** | 午前第二观察点；避开 11:30 收盘瞬间 |
| **13:30** | 午后开盘 30 分钟，方向相对稳定 |
| **14:00** | 最后一个可执行点；距 14:50 强制平腿 50 分钟，够 2 根 bar + 回补 |

> 09:30、09:35、14:30、14:45 不在列表内；不得用「最优时点」事后替换。

### 5.3 可做T门槛：v1 基线 vs v2 待验证（三臂）

> 现行产品是 `t-gate-v1`（PRD 附录 A）；SPEC §4.2 给出 `t-gate-v2`（G0–G10）。本方案不把 v1 的「几乎不筛」当成有效门槛；H3 同时跑 **no-gate / v1 / v2** 三臂，主比较是 **v2 − v1**，次比较是 **v2 − no-gate**。

**共同 eligibility（三臂都要求）：**

1. 持仓 `qty>=100`，且 `available>=100`（历史回放 `available=qty`）。
2. 非 ST/*ST/退；非停牌；非一字板；非新股前 5 日；行情不是 `lkg`。
3. 1 分钟 ≥230 点；零量点 ≤5%；无 >5 分钟缺口 ×2。
4. `P0>0.5` 元；当日涨跌停价可计算；`P0` 不在涨停/跌停价上。
5. 日线因子一律用 `computeDailyAt(bars, cutoff=prevTradingDay(d))`，即**前一交易日收盘**；不得用当日未完成日线 bar。日线根数：v1 要求 `bars>=25`，v2 要求 `bars>=21`（代码 `prismGates` 口径），研究面板仍要求 120/250。

> `ADV20`/流动性由 v2 的 G7 `EXE.FILL` 使用；v1 保持 PRD 基线，不额外加流动性闸。这样三臂的差异只来自各自门槛，不来自共同预筛。

**v1（PRD 基线，逐条复算）：**

| 闸 | 条件 | skipCode |
| --- | --- | --- |
| v1-bars | `bars >= 25`（fqt=1，剔除未完成 bar） | `bars-short` |
| v1-asof | 最后一根 final bar 距今天 ≤10 自然日 | `stale` |
| v1-atr | `ATR14 >= 1.50%` | `atr-low` |
| v1-amp | `RANGE20 >= 3.00%`（PRD 的 `amp20Pct` 是区间口径） | `amp-low` |
| v1-spread | 计划价差 `(sell/buy-1)*100 >= 1.2%` | `spread-low` |
| v1-fee | `feeNet >= max(20 元, 0.3%×买入额)` | `fee-net` |
| v1-round | `roundUsed < 2` | `round-cap` |
| v1-deadline | `now < 14:50` | `deadline` |

**v2（SPEC §4.2，G0–G10）：**

先算：
```text
R = min(floor(available/100)*100, floor(qty*0.20/100)*100, perOrderYuan? floor(perOrderYuan/P/100)*100 : ∞)
N = R × P
若 R<100 或 N<5000 ⇒ skip('fee-gate')
s = ATR14% / 4
feeRT% = (feesOf(buy,P,R)+feesOf(sell,P,R)) / N × 100
```

| 闸 | 条件 | 备注 |
| --- | --- | --- |
| G0 | 行情 fresh（≤15s，`source!='lkg'`） | 否则 `stale-quote` / `lkg-quote` |
| G1 | 非停牌/非一字板，`R>=100`；正T `cash>=N+fee` | `not-tradable` |
| G2 | `ATR14 >= max(1.0, 2×(feeRT% + 2×TICK))` | 自适应绝对下限；`atr-floor` |
| G3 | `ATRRANK120 >= 40`；池内样本 ≥8 时另要求池内分位 ≥30 | 自历史分位，不做排名；`atr-rank` |
| G4 | `AMP20 >= max(1.2, 0.6×ATR14)` | **日均振幅**；`amp-floor` |
| G5 | `EFF20 <= 0.45`（ATR≥5% 放宽到 0.55） | `trend-too-strong` |
| G6 | `TICK <= 0.10%` 且 `TICK <= 0.5×s` | 一跳成本；`tick-too-coarse` |
| G7 | `FILL <= 3 min`（高波动票 ≤1 min） | `too-illiquid` |
| G8 | `LIMITDIST >= max(1.0, 1.5×ATR14)` | `near-limit` |
| G9 | `netEdge% = 2×s − feeRT% − 2×TICK >= 0.25%`，且 `2s >= minSpread%` | `no-economic-edge` |
| G10 | `roundUsed < maxRoundsPerDay`（默认 1） | `round-limit` |

```text
minSpread% = max(0.8, 2.2×feeRT% + TICK, 0.25×ATR14)
```

> **单位警告**：`ATR14`、`s`、`feeRT`、`TICK`、`netEdge`、`minSpread` 全部用「百分数」（1.5 表示 1.5%），不要用小数混算。`s=ATR14/4` 是 SPEC 的档距，不是固定 1.2%。
>
> **v1 的 `RANGE20>=3%` 已废止**：SPEC 实测中位 27.92%，通过率 95%，等于没筛；v1 只作为「现行产品基线」保留，不能拿它证明「门槛有效」。v2 的 `AMP20>=1.2%` 才是日均振幅口径；两者不得共用「振幅」二字。
>
> 本文不替产品拍板 v1→v2；H3 只提供证据。即使 v2 通过，切换仍要按 PRD/D1 裁决、bump `T_GATE_VERSION` 并留 CHANGELOG。
>
> **v2 口径锁定**：本文上面的 v2 表是 **SPEC §4.2 目标口径**（G0–G10）。v0.250.0 的 `src/host/prismGates.ts` 已落一版 `AUTO_T_RULES.version='t-gate-v2'`，常量与 SPEC 目标并不完全一致（例如 `minAtrPct=1.0`、`maxTickPct=0.5`、`minSpreadPct=1.2`、无 EFF/FILL/LIMITDIST 闸）。**PRE-REGISTRATION 必须二选一并写死**：要么用 SPEC 目标表（实现另补缺口），要么用代码 `AUTO_T_RULES` 的实际常量并记 `gateVersion='t-gate-v2-code'`；不得在同一实验里混用两套阈值。 另外，`prismFactors.atrRank120Of` 当前用 `<20` 个观测就放行，SPEC 要求 60；用代码口径时必须在报告写 `ATRRANK_MIN=20`，不能与 SPEC 60 混比。 用 v2-code 时还要注意 `prismGates.evaluateAutoT` 内 `isEtf=false` 硬编码：ETF 费用会被高估，回放必须按标的类型传 `stampExempt`，不能直接复用该常量。

### 5.4 计划构造（固定规则，不用 LLM）

- **方向**：
  - 主口径 **sell-first（反T）**：先卖底仓，再买回；不依赖现金，且当前 25 个计划中 14 个是 sell-first。
  - 次口径 **buy-first（正T）**：先买，再卖底仓；需要现金与 `available`。单独报表，不与 sell-first 合并。
  - **方向不由因子决定**；否则会把「方向选择」混进「门槛/时点」效应。
- **股数**（三臂共用）：
  ```text
  shares = min(
    floor(0.20 × qty / 100) × 100,
    floor(available / 100) × 100,
    perOrderYuan ? floor(perOrderYuan / P0 / 100) × 100 : ∞
  )
  ```
  若 `shares < 100` → 跳过（记 `LOT_TOO_SMALL`）。`perOrderYuan` 取设置的单笔上限；没有则不加。流动性不在股数层砍，交给 `EXE.FILL`（v2 G7）与 10% 分钟量成交模型。
- **价格（v1 基线）**：
  ```text
  s = max(1.2%, feeBreakeven + 2×tick/P0)
  feeBreakeven = (2×commissionMin + stamp + 2×transfer) / (P0 × shares)
  buyPrice  = roundToTick(P0 × (1 - s/2))
  sellPrice = roundToTick(P0 × (1 + s/2))
  ```
- **价格（v2 待验证，SPEC §4.3）**：
  ```text
  s = ATR14 / 4                                  # 百分数；如 ATR14=2.4% ⇒ s=0.6%
  anchor = VWAP_t                                 # 当日 09:30 起累计 VWAP；缺失/不可信 → P0 + avgApprox=true
  buyPrice  = roundToTick(anchor × (1 - 0.8 × s / 100))
  sellPrice = roundToTick(anchor × (1 + 0.8 × s / 100))
  ```
  - v2 要求 `2s >= minSpread` 且 `netEdge>=0.25%`，否则 `no-economic-edge`；不满足就不挂，不靠缩小档距凑单。
  - v2 的 `s` 只由 ATR14 决定，**不用当日振幅缩小**（SPEC 明确禁止 `min(ATR%/4, 当日振幅%/4)`）。
- **通用约束**：
  - 先保证 `sellPrice - buyPrice >= 1 tick`；不足则 `s` 加到满足为止。
  - 价格必须在当日涨跌停区间内；越界 → 跳过。
  - **不追价**：入场后价格离开区间也不改价；只等回归。
- **下单序列**：
  - sell-first：先挂 sell；成交后挂 buy（回补）。
  - buy-first：先挂 buy；成交后挂 sell（卖底仓）。
  - 另一腿只在第一腿**全部成交**后挂；不预先挂两张（与当前产品「先卖后买」一致，也更保守）。
  - **第二腿的下单时刻 = 第一腿最后一笔 fill 的下一分钟**；第二腿只能从该时刻之后扫描，不得用原始入场时点回溯成交（否则是前视）。

### 5.5 保守成交模型（核心）

对每个 leg，限价 `L`，方向 `side`，从下单后的下一根 1 分钟 bar 开始扫描到 14:50：

**成交条件（必须同时满足）：**

1. **连续 2 根 bar 穿过**：
   - buy：`low_i <= L - tick` 且 `low_{i+1} <= L - tick`；
   - sell：`high_i >= L + tick` 且 `high_{i+1} >= L + tick`。
   - 只触及 `L` 不算；必须**穿过 1 tick**，模拟排队/滑点保守性。
2. **量能约束**：
   ```text
   cap = floor(0.10 × min(vol_i, vol_{i+1}) / 100) × 100
   ```
   `cap < 100` → 该两根不成交；`fill = min(remaining, cap)`。
3. **价格**：成交价 = 限价 `L`（不取更优的开盘价/低点），这是保守口径。
4. **部分成交**：`fill < remaining` 时，剩余继续挂；后续每两根 bar 可继续成交，直到 14:50。
5. **费用**：每笔 fill 调 `feesOf(side, L, fill, priorAmount, priorCommission, stampExempt)`；同一委托累计 `priorAmount/priorCommission`，最低佣金 5 元只收一次（与 `prismAccount.ts:66-81` 一致）。
6. **T+1**：卖出腿 `fill <= available`；正T 卖出的是底仓，不卖当日买入。
7. **停牌/零量/涨跌停**：该 bar 不成交；一字板直接跳过整个 name-day。
8. **不成交不惩罚**：第一腿未成交 → `noFill`，net=0，计入分母（per-attempt 口径）；另报 per-filled 口径。
9. **第一腿必须全部成交才挂第二腿**：第一腿只部分成交时不挂第二腿；到 14:50 按**已成交股数**做 legOut。这样避免「部分腿 + 部分回补」的路径依赖，也更保守。

**为什么不用仓库现有 `matchOrder`：**
`prismAccount.ts:244` 的 `matchOrder` 是「价格触及即按挂单价全额成交」，没有 volume、没有部分成交、没有排队；用它回放会把 fillRate 和收益系统性高估。本方案不复用该函数。

### 5.6 14:50 未平腿：mark + legOut

- 14:50 到了：
  - 两腿都成交 → `closed`，正常结算。
  - 第一腿有成交（含部分成交）、第二腿未成交 → **撤第二腿**，按 14:50 最后一根 1 分钟 `price` 对**第一腿已成交股数**做**强制平腿**：
    - 平买入腿：成交价 = `last + tick`（对你不利）；
    - 平卖出腿：成交价 = `last - tick`；
    - 记 `legOut=true`、`legOutReason='14:50'`、`legOutPrice`、`legOutShares=remaining`。
  - 第一腿都没成交 → `noFill`，无 legOut。
  - 14:50 一字板/停牌无法平 → `legOutFail=true`，按 `last` mark，计入尾部；该笔不得算 `closed`。
- 结算恒等式（逐笔现金流）：
  ```text
  net = Σ(sell fill amount) - Σ(buy fill amount) - Σ(fees)
  ```
  不读 `realized/unrealized`、不读 `netCost`（避免 `AUDIT-PRISM-ACCOUNTING` 的负成本 bug）。
- 净持仓校验：`end_qty == start_qty`；若不等，标 `POSITION_DRIFT`，该 attempt 从主表剔除并计入数据质量告警。

### 5.7 基准

| 基准 | 定义 | 用途 |
| --- | --- | --- |
| **B0 不T** | 同一底仓从入场持有到 14:50（与 T 同窗口；另报收盘），不做任何 T；增量 PnL 恒为 0 | 主对照：T 的增量必须 >0 才值得做；同时报底仓当日涨跌，避免把市场 beta 当 T 收益 |
| **B1 随机T** | 同一 v2 合格 name-day 池，随机抽入场时点（5 个均匀）与**可行方向**（两个方向都可行才各 50%，否则只在可行方向中抽），同样的门槛/成交/费用模型；每 name-day 1,000 次 | 检验「时点/方向选择」是否真的优于随机；实际策略应 > 随机分布的 95th percentile |
| **B2 买入持有** | 入场时点买入同名义金额，持有到 14:50（与 T 同窗口；另报收盘）；同样的费用 | 市场基准；证明 T 的收益不是「当天大盘涨」 |
| **B3 固定 09:45 反T** | 不做任何选择，所有 v2 合格 name-day 09:45 sell-first | 最朴素的「有波动就做」策略；用于判断复杂门槛是否真的加分 |

> B1 的随机分布是**单尾**比较；如果实际策略落在随机分布中位数附近，说明「门槛/时点」没有信息，不能靠挑最好的一天讲故事。

### 5.8 指标

| 指标 | 公式/口径 | 主/次 |
| --- | --- | --- |
| `netExpectation` | `mean(net_i / notional_i × 10000)`，**per attempt**（noFill=0） | **主** |
| `netPerFilled` | 同上，仅 `firstLegFilled` | 次 |
| `PF` | `Σ max(net,0) / abs(Σ min(net,0))`；分母 0 → null | 主 |
| `winRate` | `count(net>0)/count(firstLegFilled)`（含 legOut） | 次 |
| `fillRate` | `count(firstLegFilled)/count(attempts)` | 主（约束） |
| `bothLegsRate` | `count(bothLegsFilled)/count(attempts)` | 主 |
| `legOutRate` | `count(legOut)/count(firstLegFilled)` | **主（约束）** |
| `legOutFailRate` | `count(legOutFail)/count(firstLegFilled)` | 主（尾部） |
| `maxDD` | 按日累计 net / 日初 equity 的 `min(cum/cummax-1)` | 主 |
| `CVaR5_day` | **5% 尾部**：最差 5% **日净额**（name-day 聚合后）的均值，按日初 equity 折 bps | **主（尾部）** |
| `CVaR5_attempt` | **5% 尾部（单笔）**：最差 5% 单次 `net_bps` 的均值 | 次 |
| `tailLoss5` | 日净额的 5% 分位 | 主 |
| `fees` | 双边费用合计 / notional | 次 |
| `turnover` | 成交名义金额 / 日初 equity | 次 |
| `holdMinutes` | 第一腿成交到第二腿/legOut 的分钟数 | 次 |

**日净值/回撤口径：** 先用每个 name-day 的 5 个时点等权平均得到该 name-day 的净额，再按日加总；**不得把 335 个 attempt 直接相加**（否则同一情景被重复计 5 次，回撤/尾部全部放大）。

**主表必须按以下维度拆分，不得只报总计：**

- 方向：sell-first / buy-first；
- 入场时点：5 个；
- 门槛：no-gate / v1 / v2；
- **样本重叠**：`v1∩v2`（配对比较）/ `v2-only`（v2 新增）/ `v1-only`（v2 剔除）三列必须分列；主比较 `v2−v1` 用 **v1∩v2 配对样本**，另报全样本；不得把 v2-only 的收益说成「v1 也会错过/也会赚」；
- 子周期：前 6 天 / 后 6 天（仅描述，当前 12 天不够做推断）；
- 标的类型：股票 / ETF；
- 是否 legOut。

### 5.9 统计与置信区间

- **cluster**：按 `day` 做主 cluster；`name` 做二维 cluster（Cameron–Gelbach–Miller）或按 day block bootstrap。
- **bootstrap**：10,000 次，按日整块重采样（保留同日 name-day 的相关性）；报 95% 百分位 CI。
- **主指标**：先对每个 name-day 的 5 个时点取等权平均，再对日取平均；`n_days=12` 是实际独立单元，`n_attempts=335` 不是。
- **最小样本**：`n_days>=20` 且 `closed round trips>=100` 才可下统计结论；当前 12 天/0 完整往返 → **样本不足**。
- **leave-one-out**：去掉贡献最大的 1 个 name / 1 天 / 前 5% 的 attempt，主指标符号不得翻转；否则标 `CONCENTRATED`。
- **多重比较**：5 个入场时点 × 2 方向 × 3 臂（no-gate/v1/v2）= 30 个格；只报全表 + CI，不挑「最好格」；主检验固定为 v2−v1 的 sell-first 全时点聚合，其余格子只作描述。

### 5.10 回放验收（工程层，不是效果层）

在 12 天样本上，回放只验收**管线正确性**：

- [ ] 同一输入重跑，`attempts.csv` 逐行一致（除时间戳）。
- [ ] 每个 attempt 都能复算：`net = sellAmount - buyAmount - fees`，误差 <0.01 元。
- [ ] `end_qty == start_qty` 的比例 = 100%；否则列 `POSITION_DRIFT`。
- [ ] 2 根 bar / 1 tick / 10% 量 / 最低佣金 5 元 / ETF 免印花税 各有单元测试。
- [ ] 14:50 legOut、legOutFail、noFill 三种状态都能构造出样例。
- [ ] `fillRate`、`legOutRate`、`PF`、`CVaR5` 与手工小样本对得上。
- [ ] 每天输出 `tGateCensus`：候选数 = 各闸淘汰数之和 + 过闸数；过闸=0 时至少有一个 `skipCode` 计数 >0（SPEC §4.5/V12）。
- [ ] 同一 name-day 5 个时点的结果可追溯到原始分钟 bar（行号/时间戳）。

> 以上全过，只说明「回放器可信」；**不说明做T能赚钱**。

---

## 6. 影子 A/B（20–30 个交易日）

### 6.1 设计

| 项 | 规定 |
| --- | --- |
| 时长 | **30 个交易日**为判定口径；20–29 天只算「方向性证据」；<20 天 `样本不足` |
| 轮次 | **3 轮/日**：09:45、10:30、13:30（§5.2 的子集，均在 14:50 前） |
| 资金 | 每日开盘把 S0 账户克隆成 A/B 两本账：相同 cash、positions、available、dayStartEquity；两本账完全隔离 |
| 候选 | 同一 `universe.csv`、同一数据时刻、同一候选池；不得给 B 额外标的 |
| 模型 | **每轮只调用一次 LLM**，同一 prompt、同一模型版本、temperature=0、同一 seed；输出一份中性 `tPlans` 候选集 |
| 处理 | A=现行策略（`t-gate-v1`，全部合格计划）；B=只使用 **`t-gate-v2`（或 `t-gate-v2-code`，见 §5.3）** 和/或 **G1 通过的因子** 过滤后的计划（具体组合在 PRE-REGISTRATION 固定；影子期间不得新增）；**只有 B 不同** |
| 成交 | A/B 共用同一个 §5.5 成交模型、费用、滑点、14:50 规则 |
| 日志 | 每轮写 `tGateCensus`（候选/各闸淘汰/过闸）与每个 secid 的 `gateVersion/gateCode`；B 的 `t-gate-v2` 版本必须可追溯 |
| 随机化 | 每轮 A/B 执行顺序随机；报告标签用 X/Y，分析锁定后再解码 |
| 人工 | 测试期间不手工改计划、不改参数、不重启策略；只有安全停可以中断 |

> 关键：**同一次 LLM 输出喂给两臂**，避免「模型随机性」被误判成策略差异。B 的处理只发生在确定性策略层。

### 6.2 主指标与置信区间

- **主指标**：`ΔNet_bps = mean_day( B_day_net_bps - A_day_net_bps )`，其中 A=`t-gate-v1`、B=`t-gate-v2`（或预注册的 v2 + 因子 filter），`day_net_bps = 当日 T 净额 / 日初 equity × 10000`。
- **配对**：同一天 A/B 用同一账户克隆、同一候选、同一成交模型 → 按日配对。
- **配对样本**：除全候选比较外，另报 **v1∩v2 的 matched 子样本**（同一 name-day 上 A/B 都有计划）；避免「B 只做 3 只、A 做 10 只」的暴露差异被当成门槛 alpha。
- **CI**：按日 block bootstrap 10,000 次，95% 百分位 CI；同时报 paired t（day cluster）。
- **MDE**：用实际日配对差的 sd 计算「80% 功效、α=0.05（单尾）」的最小可检测效应；若 MDE > 经济门槛，报告 `UNDERPOWERED`，不得把「不显著」写成「无效」。
- **经济门槛**：`ΔNet_bps >= max(5 bp/日, 10% × abs(A 的平均日净额))`；且 B 的 `legOutRate<=20%`、`fillRate>=30%`、`maxDD` 不比 A 差超过 1pp。
- **次要指标**：PF、winRate、bothLegsRate、fees、turnover、CVaR5、tailLoss5；全部给 CI，不只报点估计。

### 6.3 样本与判定

| 项 | 要求 |
| --- | --- |
| 天数 | 30（20–29 只算方向性；<20 样本不足） |
| 轮次 | 90 轮对（30×3） |
| B 臂完整往返 | ≥50 |
| A 臂完整往返 | ≥50（否则对照无意义） |
| 日级 cluster | 30 |
| 安全停 | 回撤 >3%、legOut>30%、数据覆盖率<80%、账本 degraded → 立即停，不计入效果 |

### 6.4 影子验收

- [ ] 30 天、3 轮/日、同资金/同候选/同模型/同成交模型均有记录。
- [ ] 主指标 95% CI 下限 >0，且 ≥ 经济门槛。
- [ ] `legOutRate<=20%`、`fillRate>=30%`、`bothLegsRate>=60%`。
- [ ] B 的 maxDD 不比 A 差超过 1pp；CVaR5_day 的亏损绝对值不超过 A 的 1.2 倍。
- [ ] 预注册 hash、逐轮日志、账本快照、成交明细齐全，可复算。
- [ ] 无安全停 / 无人工干预；若有，报告单独说明。

---

## 7. 预注册假设（3 条，不许加）

> 在跑任何 G1 之前，把以下文本 + 因子公式 + 阈值 + 数据 hash 写进 `PRE-REGISTRATION.md`，算 sha256，写入 `run_manifest.json`。跑完后不得改。
>
> H1/H2 是**研究假设**：即使通过，也只说明「在这批标的的面板里，趋势/位置叙事有一点统计支持」，不得用于选股、候选排序或主决策；产品边界见 §0.1 第 4 条与 PRD D1。

### H1：`TRD.MOM20` + `TRD.MA20DEV` 的等权 composite 在 5 日尺度有正向横截面排序能力

- **定义**：
  ```text
  trendScore = 0.5 × z(TRD.MOM20) + 0.5 × z(TRD.MA20DEV)
  ```
  `z` = 每日横截面 rank 后转为标准正态（或 [-1,1] 均匀），**等权、不拟合**；任一缺失 → null。
- **样本**：U_FIXED 股票，T≥500 有效日，median N≥30。
- **检验**：`mean RankIC(trendScore, r_trad(t,5)) >= 0.04`；95% CI 下限 >0；`ICIR_ann>=0.5`；方向一致天数≥55%；Q5-Q1≥0.8%/5d；monotonicity≥0.6；≥3/4 子周期同号；placebo p<0.05。
- **通过**：全部满足 → `通过（面板内）`；任一不满足 → `淘汰/弱候选`。
- **禁止**：不得在看到结果后改成 `TRD.MOM20` 或 `TRD.MA20DEV` 单因子；不得改权重；不得改 5 日。

### H2：`POS.PCT20` 是反向因子（低位置 → 未来 5 日收益更高）

- **定义**：`POS.PCT20` 按 §3.2；方向预期为负。`POS.PCT252`（52 周位置）另做描述，不替代本条。
- **检验**：`mean RankIC(POS.PCT20, r_trad(t,5)) <= -0.04`；95% CI 上限 <0；`|ICIR_ann|>=0.5`；方向一致天数（IC<0）≥55%；`Q1-Q5>=0.8%/5d`；monotonicity≤-0.6（按 Q1..Q5 与收益的秩相关）；≥3/4 子周期同号；placebo p<0.05。
- **通过**：全部满足 → `通过（面板内）`；若符号为正，**直接淘汰 H2**，不得反向解释成「动量」。
- **说明**：这条直接检验产品里「20 日位置低 → 超跌修复」的叙事；若 H2 不成立，做T 的「低吸」理由缺少日线证据。

### H3：`t-gate-v2`（或 `t-gate-v2-code`）比 `t-gate-v1` 提高每轮净期望

- **定义**：三臂见 §5.3：`no-gate` / `v1` / `v2`。主比较是 **v2 − v1**（现行产品基线），次比较是 **v2 − no-gate**；其他条件、成交模型、费用完全相同。
- **检验**（在 G2 回放，样本足够时；主检验在 **v1∩v2 配对样本**，另报全样本）：
  ```text
  Δ_main = netExpectation(v2) - netExpectation(v1)
  Δ_sec  = netExpectation(v2) - netExpectation(no-gate)
  ```
  要求 `Δ_main >= 10 bp/attempt`，且 v2 的 `netExpectation >= 0`（扣费后）；95% CI 下限 >0；`legOutRate<=20%`；`fillRate>=30%`；leave-one-out 符号不翻转。
- **附加**：v2 的 `fillRate` 不得低于 v1 的 50%（否则「筛得只剩 1 只」也能做出好看的均值）；v2 的 `bothLegsRate>=60%`；v2 的 `maxDD` 不差于 v1 超过 1pp。
- **样本**：≥20 个日级 cluster、≥100 个完整往返；当前 0 → **样本不足，禁止判定**。
- **通过**：G2 通过 + G3 影子同向且 CI 下限 >0 → `门槛有效`；只过 G2 不过 G3 → `回放有效，待影子`。

> 除 H1/H2/H3 外，`TRD.MOM5/60`、`TRD.MA60DEV`、`TRD.RSI14`、`VOL.ATR14`、`VOL.RANGE20`、`TRD.EFF20`、`LIQ.VOLRATIO`、`VOL.BETA60`、`INT.VOLPACE/AMTPACE/AMOUNT_RATIO/UPTICK/RET30M/POSDAY`、`EXE.LIMITDIST` 的方向分量 全部是**探索性**；可以出描述表，但不得称为「有效」，不得直接进门禁。

---

## 8. 防过拟合规则（12 条）

1. **预注册 hash 先行**：因子公式、方向、阈值、样本切分、主指标、seed、数据 hash 全部写入 `PRE-REGISTRATION.md`；跑前算 sha256，跑后只读。
2. **时间切分 + embargo**：
   - Train：2023-06-05 → 2025-06-30；
   - Validation：2025-07-01 → 2026-06-30；
   - Confirmation：2026-07-01 → 2026-11-26；
   - 段间 embargo = 20 个交易日（forward horizon），并 purge 重叠标签；confirmation 只允许看一次。
3. **一次确认**：confirmation 结果出来后不得回头改因子/阈值；若改了，confirmation 作废，重新等新数据。
4. **参数网格上限**：每个因子最多 2 个预注册变体（如 winsorize 有/无）；不得按标的、按月份、按行业分别调参。
5. **只测 3 条假设**：H1/H2/H3；其余探索性因子的 p 值只作描述，不做上线依据。
6. **多重检验**：3 条假设 Bonferroni/BH；探索性因子 BH-FDR q≤0.10，且标注 `EXPLORATORY`。
7. **稳健性矩阵**（至少 10 格）：lag 0/+1 日、winsorize 有/无、等权/成交额加权、含/不含 ETF、剔前 1% 极值、成本 0/10/20bp；符号在 ≥80% 格保持一致才算稳。
8. **阴性对照**：随机因子、收益置换、时间平移、毒化 bar；任一失败 → 整条因子停用。
9. **全量留痕**：所有跑过的变体（含失败）写 `attempts.log`；不得只报最好的一组。
10. **禁止 LLM/人工在环**：因子计算、分组、回放、统计全部确定性脚本；LLM 只在影子 A/B 的中性候选生成处出现，且两臂共用。
11. **universe 冻结**：测试期间不得新增/删除标的；不得因为某只股票后来涨了而把它加进历史池。
12. **版本固定**：git commit、node/python 版本、依赖 lock、数据 hash、时区全部写 manifest；输出目录只增不改。

---

## 9. 验收清单

> **证据的定义**：不是一张收益曲线、也不是一句「IC 0.05」，而是**预注册 hash + 可复现的 artifact + 按日 cluster 的 95% CI + placebo/负对照 + 子周期/稳健性**这一整套。缺任何一项，只能写「未验证 / 样本不足」。`通过（面板内）` 与 `门槛有效` 是两个不同层级；后者必须多过回放/影子。

### 9.1 数据门（D）

- [ ] **D1** `S0` 快照 + `manifest.json` + 逐文件 sha256；测试只读 `S0`。
- [ ] **D2** 日线只用 `v3 + fqt1`；v1/v2 数量与排除名单在台账。
- [ ] **D3** `partial` 最后 bar 全部丢弃；无盘中未完成 bar。
- [ ] **D4** 涨跌停/停牌/除权/ETF/ST/新股规则按 R8–R12 执行；排除台账逐条可查。
- [ ] **D5** universe.csv 冻结；`BACKFILL-SURVIVOR` 标签在报告首页。
- [ ] **D6** 1 分钟 ≥230 点、零量 ≤5%、缺口 ≤2；不合格 name-day 列表。
- [ ] **D7** 毒化 bar 测试通过（未来数据不改变输出）。
- [ ] **D8** 样本矩阵与 §1 一致：日线股票 36 只/约 580 天；日内 12 天/22 只；T 主池 67 name-day；autot 0 完整往返。
- [ ] **D9** SPEC §7 的 V1–V12 全过；至少 V2（未完成 bar）、V3（无前视）、V7（AMP20≠RANGE20）、V8（t-gate 8 行 fixture 逐行一致）在 CI 中有断言。
- [ ] **D10** 每条日志/每条 attempt 带 `T_GATE_VERSION`（或代码 `AUTO_T_RULES.version`；`t-gate-v1`/`t-gate-v2`/`t-gate-v2-code`）；改阈值必须 bump 版本，旧记录保留旧版本。

### 9.2 因子有效（F）

> 只有 H1/H2 可以走此表；探索性因子只能出描述。

- [ ] **F1** 预注册 hash 存在且未改。
- [ ] **F2** T≥500 有效日、median N≥30、覆盖率≥80%。
- [ ] **F3** h=5 `|meanIC|>=0.04`，95% CI 不含 0。
- [ ] **F4** `|ICIR_ann|>=0.5`（非重叠口径）；方向一致天数≥55%。
- [ ] **F5** Q spread≥0.8%/5d；monotonicity≥0.6；Q spread 的 NW t≥2。
- [ ] **F6** ≥3/4 子周期同号；高/低波动两个 regime 均不出现符号翻转（样本 <30 日的 regime 记 `—`）。
- [ ] **F7** placebo p<0.05，实际 |IC| > 零分布 95th percentile；时间平移不显著。
- [ ] **F8** 稳健性 ≥80% 格同号；leave-one-name/day-out 不翻转。
- [ ] **F9** confirmation 段同号且 |IC| ≥ validation 的 50%。
- [ ] **F10** 多重检验 q≤0.10（3 条假设内）。

**判定：** F1–F10 全过 → `通过（面板内）`；F1–F10 全过但未做影子 → `面板内有效，不可上线`；任一样本门槛不满足 → `样本不足`。

### 9.3 门槛有效（G）

- [ ] **G1** `t-gate-v1` / `t-gate-v2`（或代码 `t-gate-v2-code` 实际常量）定义冻结（§5.3），回放同时跑 no-gate / v1 / v2 三臂；版本与常量写进 manifest。
- [ ] **G2** 在 `v1∩v2` 配对样本上 `Δ_main = netExpectation(v2) − netExpectation(v1) >= 10 bp/attempt`，且 v2 `netExpectation>=0`；95% CI 下限 >0；另报全样本。
- [ ] **G3** v2 `legOutRate<=20%`、`fillRate>=30%`、`bothLegsRate>=60%`；且 v2 `fillRate >= 50% × v1 fillRate`（防「筛得只剩 1 只」）。
- [ ] **G4** v2 maxDD 不比 v1 差超过 1pp；CVaR5 的亏损绝对值不超过 v1 的 1.5 倍。
- [ ] **G5** 去掉贡献最大的 1 只/1 天/前 5% attempt，`Δ_main` 符号不翻转。
- [ ] **G6** 影子 A/B 主指标 CI 下限 >0 且 ≥经济门槛。
- [ ] **G7** 无安全停/无人工干预；账本无 `POSITION_DRIFT`。

**判定：** G1–G5 过 + G6 未做 → `回放有效，待影子`；G1–G7 全过 → `门槛有效`；G2 样本 <20 天/100 往返 → `样本不足`（即使点估计为正）。

### 9.4 影子有效（S）

- [ ] **S1** 30 天 × 3 轮/日；A/B 同资金/同候选/同模型/同成交模型。
- [ ] **S2** 主指标 `ΔNet_bps` 95% CI 下限 >0。
- [ ] **S3** `ΔNet_bps >= max(5bp/日, 10%×abs(A 的平均日净额))`。
- [ ] **S4** B 的 `legOutRate<=20%`、`fillRate>=30%`、`bothLegsRate>=60%`。
- [ ] **S5** B 的 maxDD 不比 A 差 >1pp；CVaR5 的亏损绝对值不超过 A 的 1.2 倍。
- [ ] **S6** MDE 已报告；若 MDE > 经济门槛 → `UNDERPOWERED`，不得写「无效」。
- [ ] **S7** 预注册/逐轮日志/账本/成交明细齐全，可复算。
- [ ] **S8** 无安全停/无人工干预。

### 9.5 总判定矩阵

| 数据门 | 统计门 | 经济门（回放） | 影子门 | 结论 |
| --- | --- | --- | --- | --- |
| 失败 | — | — | — | **数据不合格 / 样本不足**；不得下因子结论 |
| 过 | 失败 | — | — | **淘汰 / 弱候选** |
| 过 | 过 | 失败 | — | **面板内有效，不可上线** |
| 过 | 过 | 过 | 未做/失败 | **回放有效，待影子** |
| 过 | 过 | 过 | 过 | **可上线（限定 U_FIXED 范围）** |

> 矩阵按**单个假设/门槛**分别判定，不是全系统一刀切；例如 H1/H2 失败不影响 H3 单独走 G2/G3。

### 9.6 当前状态（2026-11-26）

| 项 | 状态 | 理由 |
| --- | --- | --- |
| H1 趋势 composite | **未验证（可跑）** | 日线股票 36 只/约 580 天，可出面板 IC；但 `BACKFILL-SURVIVOR`，不能外推 |
| H2 `POS.PCT20` | **未验证（可跑）** | 同上 |
| H3 做T门槛 | **样本不足** | 0 个完整 T 往返；12 天日内；67 个持仓 name-day |
| 日内因子（volPace 等） | **样本不足** | 12 天/22 只；日级 cluster 12 |
| 做T回放 | **样本不足（仅管线）** | 12 天/67 name-day/≈335 attempts；无 100 往返 |
| 影子 A/B | **未开始** | 需要 G2/H3 门槛通过（或 G1 因子通过）+ 30 天 |
| 账户净值/回撤 | **样本不足** | 27 点 <30；基准缺失 1 点 |

> 按当前 67 个持仓 name-day / 12 天、5 个时点、30% fillRate、60% bothLegs 估算，**100 个完整往返约需 20–30 个交易日**；日内因子要 120 个稠密日，则还需约 108 个交易日（约 5 个月）。在达到前，所有相关结论只能写 `样本不足`。

### 9.7 禁止结论（硬红线）

- 禁止写「因子有效」「门槛有效」「显著」「可上线」「建议实盘」，除非 §9.5 对应行全过。
- 样本不足时只能写：
  > 「当前样本 n=…，点估计…，95% CI…；**样本不足，不能判断是否有效**。」
- 禁止把「0 个 T 结果」解释成「做T没用」；也禁止解释成「做T有效」。它只是**没有证据**。
- 禁止把「24 条成交记录」当「24 轮做T」；禁止把「12 天」当「12 个独立月」。
- 禁止只报 winRate 不报 PF/尾部/legOut；禁止只报最好入场时点。
- 禁止用 `prism-autot.results` 或 `prism-equity` 的 `realized/unrealized` 作为 T 收益真相；必须逐笔现金流复算。
- 禁止把 H1/H2 的因子接进 `candidateStats`、四路分析或主决策下单（PRD D1/R1–R3）；本方案只服务 autoT 的可执行性验证。
- 禁止把 `t-gate-v1` 的「几乎不筛」写成「门槛有效」；v1 只是基线，v2 才是待验证对象。

### 9.8 交付物清单

```text
docs/FACTOR-VALIDATION.md                     # 本文（设计）
research/factor-validation/PRE-REGISTRATION.md
research/factor-validation/README.md           # 运行说明
data/snapshots/S0/manifest.json
data/snapshots/S0/universe.csv
out/fv/S0/daily_panel.parquet
out/fv/S0/ic_summary.csv
out/fv/S0/quintiles.csv
out/fv/S0/subperiods.csv
out/fv/S0/placebo.json
out/fv/S0/replay_attempts.csv
out/fv/S0/t_gate_census.csv
out/fv/S0/prism-factor/<day>.jsonl
out/fv/S0/replay_metrics.json
out/fv/S0/shadow_rounds.csv
out/fv/S0/verdict.md
out/fv/S0/run_manifest.json
```

研究目录（待实现，不进 `src/**`）：

```text
research/factor-validation/
  build_snapshot.py     # S0 + universe.csv + exclusions.csv
  factors.py            # computeDailyAt / computeIntradayAt / FactorEnvelope
  ic_test.py            # IC/ICIR/分组/子周期/placebo
  replay.py             # no-gate/v1/v2 三臂 + 成交模型
  shadow.py             # 30 天 A/B 配对 + CI/MDE
  report.py             # verdict.md + 图表
```

---

## 10. 执行顺序与停止条件

### G0 数据门（0.5–1 天）

1. 建 `S0` 快照与 manifest。
2. 跑清洗：v3/fqt1、partial、OHLC、日历、停牌、涨跌停、除权、ETF、ST/新股。
3. 生成 `universe.csv`、`exclusions.csv`。
4. 跑毒化测试；不过就停。

**停止条件：** 任一 D1–D10 失败；或 fqt1 股票 <20 只（当前 36，过）。

### G1 日线因子门（1–2 天）

1. 建 `daily_panel.parquet`（股票主表）。
2. 跑 H1/H2 + 全部探索性因子的 IC/分组/子周期/placebo。
3. 写 `ic_summary.csv`、`quintiles.csv`、`verdict.md`。

**停止条件：** H1/H2 均 `淘汰/样本不足` → 不进入「因子增强」；只保留描述报告。**G2 的 H3 门槛可独立继续**（`t-gate-v2` 不依赖 H1/H2），但影子 B 只能用 `t-gate-v2`，不得用 H1/H2。
**注意：** 即使 H1/H2 通过，也只能写「面板内有效」；不能写「可上线」。

### G2 做T回放门（2–3 天，先管线）

1. 用 12 天数据实现 §5 回放器；先跑 `T_HELD` 67 name-day，验证管线。
2. 用手工小样本（10 个 attempt）核对 2 根 bar/1 tick/10% 量/费用/legOut。
3. 跑全量 12 天，输出 no-gate / v1 / v2 三臂的 `replay_attempts.csv` / `replay_metrics.json` / `t_gate_census.csv`。
4. **只做工程验收**；效果结论写「样本不足」。

**停止条件：** 回放恒等式/净持仓校验失败；或 `fillRate` >70%（说明模型太松）且无法解释；或 `legOutRate` >30%（说明参数/数据有误）。

### G3 影子 A/B（30 个交易日）

1. 只在 **G2 的 H3 门槛通过**（或 G1 有 `通过（面板内）` 因子作为 B 的附加条件）时启动；若 B 只用 `t-gate-v2`（或 `t-gate-v2-code`），不要求 H1/H2 通过；否则不做（B=A 无意义）。
2. 每日 3 轮，A/B 克隆账户；写 `shadow_rounds.csv`。
3. 30 天后锁定分析；算主指标/CI/MDE；写 `verdict.md`。

**停止条件：** 安全停触发；或 B 臂完整往返 <50；或数据覆盖率 <80%。

### G4 上线门

- 只有 §9.5 最后一行全过，才允许把因子/门槛接入产品。
- 上线后仍保留 30 天影子对照；若 live 与 shadow 偏差 >2σ，回滚。

---

## 附录 A：关键公式与伪代码

### A.1 `computeDailyAt` 伪代码

```ts
function computeDailyAt(bars, cutoff) {
  // 输入允许包含 cutoff 之后的 bar（正常缓存就有）；必须过滤掉，不得引用
  const usable = bars
    .filter(validOhlc)                      // R5
    .filter(b => b.date <= cutoff)          // 严格 <=
    .sort((a,b) => a.date.localeCompare(b.date))
  const last = usable[usable.length-1]
  if (!last) return allNull('NO_BARS')
  // 每个因子独立判断 min bars；不足 -> null + SHORT_HISTORY
  return { asOf: last.date, barsUsed: usable.length, fqt: 1, values: {...} }
}
```

### A.2 `computeIntradayAt` 伪代码

```ts
function computeIntradayAt(points, cutoffTs) {
  // 输入允许包含 cutoff 之后的点；必须过滤掉，不得引用
  const usable = points
    .filter(p => p.price > 0)
    .filter(p => p.t <= cutoffTs)           // 严格 <=
    .sort((a,b) => a.t - b.t)
  if (!usable.length) return allNull('NO_BARS')
  const last = usable[usable.length-1]
  // volPace/amountPace 需要历史同日 profile；不足 -> null
  return { asOf: last.t, pointsUsed: usable.length, values: {...} }
}
```

### A.3 费用

```text
commission = max(5, amount × 0.0003)        # 元，按委托累计，不重复收最低
stamp      = sell && !stampExempt ? amount × 0.001 : 0
transfer   = amount × 0.00001
total      = commission + stamp + transfer
```

与 `prismAccount.ts:66-81` 一致；ETF `stampExempt=true`。

> **费率口径以代码为准**：`STAMP_RATE=0.001`（卖出 0.1%，ETF 免）、`COMMISSION_RATE=0.0003`（最低 5 元/腿）、`TRANSFER_RATE=0.00001`。若 PRD/旧文案写「印花税 0.05%」，回放仍用代码常量，并在报告脚注注明文案差异；否则费用会被低估一半。

### A.4 IC 年化

```text
h=1 : ICIR_ann = mean(IC)/sd(IC) × sqrt(252)
h>1 : 取非重叠 t=t0, t0+h, ...；ICIR_ann = mean(IC)/sd(IC) × sqrt(252/h)
      非重叠窗口 <30 -> ICIR_ann = null
```

### A.5 block bootstrap

```text
for b in 1..10000:
  sample days with replacement (block length = h for overlapping horizon)
  compute mean IC / mean net / Q spread on sampled days
CI = [2.5th, 97.5th] percentile
```

### A.6 最小输出 schema

```text
daily_panel.parquet:
  date, secid, universe_version, type, industry,
  TRD.MOM5, TRD.MOM20, TRD.MOM60, TRD.MA20DEV, TRD.MA60DEV,
  TRD.RSI14, VOL.ATR14, VOL.AMP20, VOL.RANGE20, VOL.ATRRANK120,
  TRD.EFF20, POS.PCT252, POS.PCT20, LIQ.ADV20, LIQ.VOLRATIO,
  EXE.TICK, EXE.FILL, EXE.LIMITDIST, VOL.BETA60,
  r_trad_1, r_trad_5, r_trad_20, r_close_1, r_close_5, r_close_20,
  tradable_1, tradable_5, tradable_20, exclusion_reason

replay_attempts.csv:
  attempt_id, day, secid, entry_time, direction, gate_version, gate_pass,
  qty, available, shares, p0, buy_price, sell_price, spread_bps,
  atr_pct, amp20_pct, atr_rank120, eff20, tick_pct, fill_min, limit_dist_pct, adv20_amount,
  first_leg, first_fill_at, first_fill_shares, first_fill_price,
  second_leg, second_fill_at, second_fill_shares, second_fill_price,
  leg_out, leg_out_fail, leg_out_price, fees, net, notional, net_bps,
  hold_minutes, status, exclusion_reason

t_gate_snapshot.csv:
  day, run_id, secid, gate_version, gate_code,
  atr14_pct, amp20_pct, atr_rank120, eff20, tick_pct, fill_min,
  limit_dist_pct, s_pct, min_spread_pct, net_edge_pct, pass

shadow_rounds.csv:
  round_id, day, slot, arm, candidate_count, plans_count,
  fills_count, round_trips, net, equity_start, equity_end,
  leg_out_count, fees, max_drawdown_day, status
```

`run_manifest.json`：`git_commit`、`package_version`、`t_gate_version`、`data_snapshot_sha256`、`universe_sha256`、`pre_registration_sha256`、`node_version`、`python_version`、`seed`、`timezone`、`started_at`、`finished_at`、`host`、`outputs[]`。

---

## 附录 B：盘点命令（复现 §1 的数字）

```bash
# klines 文件数 / 唯一 secid / 日线版本
python3 - <<'PY'
import json,glob,os,collections
H=os.path.expanduser('~/.dsh/dsh-tradewatcher')
fs=glob.glob(H+'/klines/*.json')
print('files',len(fs))
print('unique',len({json.load(open(f))['secid'] for f in fs}))
print(collections.Counter((json.load(open(f)).get('klt'),json.load(open(f)).get('v')) for f in fs))
PY

# trends 稠密日 / 12 天全程标的
python3 - <<'PY'
import json,glob,os,collections
H=os.path.expanduser('~/.dsh/dsh-tradewatcher')
days=collections.defaultdict(dict)
for f in glob.glob(H+'/trends/**/*.json',recursive=True):
    d=json.load(open(f)); days[d['day']][d['secid']]=len(d.get('points') or [])
dense=[d for d in sorted(days) if len(days[d])>=40][-12:]
common=set.intersection(*[set(s for s,n in days[d].items() if n>=230) for d in dense])
print(len(days),len(dense),len(common),dense)
PY

# autot 完整往返
python3 - <<'PY'
import json,os,collections
H=os.path.expanduser('~/.dsh/dsh-tradewatcher')
d=json.load(open(H+'/prism-autot.json'))
by=collections.defaultdict(set)
for t in d['trades']: by[t['planId']].add(t['leg'])
print(len(d['plans']),len(d['trades']),len(d['results']),sum(1 for v in by.values() if len(v)==2))
PY
```

---

## 附录 C：已知坑（不要在实现时重犯）

| 坑 | 证据 | 本方案对策 |
| --- | --- | --- |
| `matchOrder` 价格触及即全额成交、无 volume | `src/host/prismAccount.ts:244`；`RESEARCH-QUANT.md` §1.1 | §5.5 两 bar 穿过 + 10% 分钟量 + 部分成交 + 限价成交 |
| ICIR 未年化、年化口径混用 | `docs/RECON-PAPERTRADE.md:280` | §4.3 明确 `sqrt(252/h)` + 非重叠窗口 |
| `netCost` 可为负、realized/unrealized 双计 | `docs/AUDIT-PRISM-ACCOUNTING.md` A1 | §5.6 逐笔现金流，不读 `realized/unrealized` |
| 最低佣金 5 元按笔重复收 | `prismAccount.ts:73-74` 的 `priorAmount/priorCommission` | §5.5 同一委托累计，费用只收一次 |
| 把 24 条腿成交当 24 轮 | `prism-autot.trades` 实际 12 个计划单腿 | §1.3/§9.7 硬性禁止 |
| 把 12 天当 12 个月 | `trends` 稠密日 12 天 | §5.9 日级 cluster，`n_days=12` |
| 只报胜率/最好时点 | 现有 autoT stats 只看 results | §5.8 强制 PF/legOut/CVaR5/全表 |
| 用当前观察池外推全市场 | U_FIXED 是 `BACKFILL-SURVIVOR` | §2.1 标签 + §9.7 禁止措辞 |
| 代码 `t-gate-v2` 与 SPEC 目标口径不一致 | `src/host/prismGates.ts` 的 `AUTO_T_RULES`（minAtr 1.0 / maxTick 0.5 / 无 EFF/FILL/LIMITDIST）；`prismFactors.atrRank120Of` 的 `<20` 观测门槛 | §5.3「v2 口径锁定」：PRE-REGISTRATION 二选一，记 `t-gate-v2-code` 与 `ATRRANK_MIN`，不得混算 |

---

*本文为设计稿；所有阈值、样本量与验收条件在 `PRE-REGISTRATION.md` 冻结后才可执行。*
