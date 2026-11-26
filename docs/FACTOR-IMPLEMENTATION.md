# 棱镜因子层 · 落地可行性评估与实施设计（FACTOR-IMPLEMENTATION）

> 状态：**仅评估/设计，未改 `src/**`，未 commit**。
> 基线：用户指定 `v0.249.0` / HEAD `2a91e97`。评估时工作树已前进到 `v0.249.1` / `d27fba9`（差异只有 `prismPipeline.ts` 的 autoT 注入位置，见 §5.6；本文引用的其它文件行号不变）。
> 输入：`docs/FACTOR-SPEC.md`（金融模型规范，下称 SPEC）、`docs/PRD-FACTOR.md`（产品范围/UI/验收，下称 PRD）。
> 本文回答的是**工程怎么落**：复用哪些真实代码、新增哪些文件/函数、性能多少、哪些数据源做不到、P0/P1/P2 怎么拆、每步怎么验收。本文不重复 SPEC 的公式推导，也不改 PRD 的产品裁决。

---

## 0. 结论（先给答案）

| 项 | 结论 |
|---|---|
| **总体可行性** | **有条件可行**。P0 信任底座 + P1「最小可执行门槛」可落地；P2 的完整 12 因子、因子明细 UI、收益回测受数据源与产品裁决限制，不能一次做完。 |
| **P1 范围** | 只服务**自动做T 的可执行性门槛**：`bars/asof/ATR14/20日区间幅度` 四个数 + `t-gate-v1` 的 14 个原因码 + 30 天因子日志 + U1/U2/U3 三处文案。**不选股、不评分、不排序、不进四路分析、不进主决策下单**（PRD D1）。 |
| **P2 范围** | SPEC 的 12 核心因子、`t-gate-v2`（ATR 分位/日均振幅/趋势效率/一跳/流动性/涨跌停余量/净 edge）、因子明细 tab、门禁回放/收益研究。每项都要重新裁决。 |
| **性能** | 11 只开启做T 的持仓：热缓存 <0.1s；80 只上限：热缓存约 0.3s（实测 80 个日K文件读+parse 75.5ms、指标计算 20ms、80 只行情一批约 200ms）。GET `/prism` **不 await K 线**，只做内存 join，增量 <1ms。 |
| **磁盘/内存** | 不新增日K副本；`klineMem` 80 只约 11MB（实测 59,451 根）；因子信封约 80KB；`prism-factor` 日志按 11 只×每轮约 0.4MB/日，30 天约 12MB。 |
| **最大风险** | 不是因子公式，而是**数据完整性**：未完成 bar、qfq 增量拼接、LKG 穿透、ETF 涨跌停/费用、T+1/pending。任何一条没修，因子层都会把“看起来正常”的错数送进下单。 |
| **数据源做不到** | 历史**真价差**、**IOPV/折溢价**、**历史 PE/PB** 当前都做不到；只能记当前值/前向积累或显式 `null`，不得用价格或均值冒充。详见 §7。 |

**一句话**：先修信任底座，再做一条可核对的拒绝理由；不要先做因子表、评分或收益回测。

---

## 0.1 与 SPEC / PRD 的关系

| 文档 | 定位 | 本文怎么用 |
|---|---|---|
| `docs/FACTOR-SPEC.md` | 目标态金融模型：12 核心 + 17 扩展 + 7 做T因子、`FactorEnvelope`、G0–G10、PIT 规范 | 目标态与公式的唯一来源；本文只实现其中的 P1 子集，并给出工程落地差异 |
| `docs/PRD-FACTOR.md` | 产品范围：D1 只服务 autoT、P1 只做 2 个因子 + 14 个原因码、U1–U3 文案、30 天日志 | P1 的范围/文案/验收以 PRD 为准；与 SPEC 冲突处见 §0.2 |
| `docs/FACTOR-VALIDATION.md` | 研究/验证方案：数据门、IC/回放/影子、三臂 | 本文件的 `tGateCensus`/`tGateSnapshot` 是它的输入；它不改变本文工程实现 |
| 本文 | 工程实施设计 | 文件/函数签名、数据流、性能、风险、P0/P1/P2、验收命令 |

**任务问题对照**：① 复用清单 §1.2；② 新增/改造与签名 §3、数据流 §3.7；③ 性能 §4；④ 兼容/风险 §5；⑤ 实施拆分与验收 §8/§9；⑥ 数据源做不到 §7。

### 0.2 开工前必须裁决的 5 个冲突（不裁决就会写出两套口径）

| # | 冲突 | 证据 | 建议裁决 |
|---|---|---|---|
| **C-1 范围** | 用户本次要求「供棱镜每轮决策与自动做T 使用」；PRD D1 明确「因子层只服务自动做T，不选股、不评分、不进主决策下单」 | PRD §0 D1；本次任务原文 | **P1 按 PRD 只做 autoT**；P2 若要把因子送进主决策，必须作为产品变更单独评审。本文的 `prismFactors` 设计支持 `mode:'decision'`，但默认不启用主决策 gate。 |
| **C-2 振幅定义** | SPEC §2.3：旧 `amp20` 是「20日区间幅度」，必须拆成 `VOL.AMP20`（日均）与 `VOL.RANGE20`（区间）；PRD 附录 A/Q2 仍把 `amp20Pct` 定义为「20日最高−最低」并保留 3% 门槛 | SPEC 实测中位：区间 27.92% vs 日均 4.54%；PRD Q2 建议用区间 | **P1 保留 PRD 行为**：字段名用 `range20Pct`，文案写「20日区间幅度」，门槛 3.00%；同时计算 `amp20Pct`（日均）写日志但不参与 v1 判定。**v1 的 3% 只作为 A/B 基线保留，不当有效门槛**（SPEC 实测 95% 通过）；P2 的 `t-gate-v2` 按 SPEC 用 `amp20Pct` 1.2% + 自适应门槛，废止 v1 的 3%。**禁止两个都叫「振幅」**。 |
| **C-3 回测** | PRD §1.5/§5.4 永久不做「因子回测引擎」；本次任务要求「因子日志与回测」 | PRD D4/P2 表 | **P1 只落日志，不做收益回测**。**P2-3 做门禁回放（gate replay）**：用历史 final 日K复算数据门槛，输出通过/拒绝计数，不产生收益结论；**P2-4 收益回测（IC/分层）需产品明确批准**，本文给设计但不列入 P1 DoD。 |
| **C-4 ETF 涨跌停** | SPEC §1.4 写「ETF 10%」；实测 588000（科创50ETF）与 159915（创业板ETF）是 **20%**，510300 是 10% | 腾讯 `qt.gtimg.cn` f47/f48：588000 昨收 1.254 → 涨停 1.505 / 跌停 1.003；159915 昨收 2.199 → 2.639/1.759；510300 昨收 3.970 → 4.367/3.573 | **不能按代码前缀猜 10%**。P1 给 `QuoteRow` 增加 `limitUp/limitDown`（腾讯 f47/f48，已实测存在），`limitsOf` 优先用交易所价；缺失才回落规则表，且未知时 `null` + 原因，不默认 10%。 |
| **C-5 真价差/盘口** | SPEC §5.6 说「quote.source='lkg' 硬拒」，但当前 `QuoteRow` 没有买一/卖一；只有 `auctionSeries` 在 09:15–09:25 解析腾讯 f9/f19 | `src/host/auctionSeries.ts:57-64`；`QuoteRow` 无 bid/ask | **P1 不把「真价差」当因子**。历史真价差不可得；当前盘口只能做 P2 探针，且只做质量位，不进入 v1 gate。 |

> 这 5 条中 C-1/C-2/C-3 是产品口径，C-4/C-5 是数据口径。**开工前先拍板，尤其是 C-2**：同一个字段两种定义，后面所有测试都会互相打架。

> **并行工作树提醒（2026-11-26 16:4x）**：仓库里已出现**未跟踪**的 `src/host/prismFactors.ts`、`src/host/prismGates.ts`、`src/host/prismFactors.test.ts`（非本文产物）。其 `AUTO_T_RULES.version='t-gate-v2'`、16 个 code、`minAtrPct=1.0`、`amp20` 用日均、`lastOpen=14:30`，与 PRD 的 `t-gate-v1`（14 code、ATR≥1.5%、RANGE20≥3%、deadline 14:50）**不是同一版**。本文的 P1 仍按 PRD v1 写；如果最终采纳该并行实现，必须先裁决 C-2/C-3、统一 version/code/阈值，否则 `prism-factor` 日志与 UI 会各说一套。另：并行实现仍在编辑；本文撰写时 `node --test --experimental-strip-types src/host/prismFactors.test.ts` 仍有 1 条失败（`net-low` vs `position-cap`），不能按“已落地”评估。以最终提交为准。

---

## 1. 真实代码盘点

### 1.1 现有数据链（与因子层直接相关）

```
自选/持仓（watch.json / positions.json）
        │
        ▼
prismInputsOf (prismRoutes.ts:392)
  ├─ loadQuotes(secids) ───────────────► 腾讯/东财/新浪行情槽（10s TTL，quotes-lkg 兜底）
  ├─ candidatesCachedOf (prismRoutes.ts:344)
  │     └─ candidatesTextOf (candidateStats.ts:45)
  │           └─ fetchKline(secid,101,120,0)   ← fqt=0、120根、串行
  ├─ autoTContextOf (prismRoutes.ts:366)
  │     └─ fetchKline(secid,101,30,1)  ← fqt=1、30根、Promise.all
  └─ indexTechCachedOf (prismRoutes.ts:250)
        └─ fetchKline(secid,101,120,0)  ← 5 个指数、5min 缓存

fetchKline (em.ts:3435)
  ├─ loadKlineCache (em.ts:2812) ── klineMem + klines/<secid>_<klt>_<fqt>.json
  ├─ refreshKline (em.ts:3910) ── ttlCache + 腾讯 fqkline 优先 + 东财兜底
  ├─ liveTodayBarOf (em.ts:2799) ── 行情补今日动态柱（只进回包、不落盘）
  └─ barOpen / partial / stale / fqt 回包
```

### 1.2 可复用清单（逐项回答任务第 1 点）

| 现有 | 位置 | 可复用 | 不能直接用的原因 / 改造 |
|---|---|---|---|
| `fetchKline` | `em.ts:3435` | 磁盘缓存、内存 `klineMem`、TTL、熔断、增量合并、`partial`/`stale`/`fqt` 回包、`mergeBars` | **不能直接当因子取数**：① `needFull` 只看缓存是否为空（`:3451`），缓存 120 根时再要 250 根不会补历史；② 总把今日 `liveTodayBarOf` 的未完成柱拼进 `days`；③ 返回“最近 N 根”，不是按 `barDate` 的 PIT 切片。需新增 `readDailyFinalBars` + `fetchKline(..., {minBars})`。 |
| `fetchTrend` | `em.ts:2364` | 分时点、VWAP（`avg`）、每分钟成交额、5 日归档 | 80 只逐只取太贵；P1 只对 autoT 持仓按需取，且只在 P2 的 `VWAPDEV/DAYAMP` 用。`avg` 可能是 null，必须如实标 `avgApprox`。 |
| `atrFromBars` | `atr.ts:27` | **纯函数，直接复用**；`atr14PctOf` 的取数包装不需要 | 因子层从已读到的 final bars 直接算，避免二次 `fetchKline`。`atrFromBars` 要求 ≥15 根，PRD gate 要求 ≥25 根（留缓冲），两者不冲突。 |
| `techOf` / `rsiOf` | `indexTech.ts:1-200` | MACD/RSI/均线/量比等扩展因子可直接复用 | `techOf` 是“最近序列”口径，不能用于历史 PIT；P2 回测必须自己按 `barDate` 切片后调用纯函数。 |
| `candidateRowOf` / `candidateLineOf` / `candidatesTextOf` | `candidateStats.ts:25/31/45` | 文本格式、`techOf`、缺失 `—` 纪律 | 当前 `loadBars` 用 `fqt=0`、120 根；因子层要统一 `fq=1`，且 `close` 改用行情 `P`，不再用日K末根。P1 不改候选池文本（PRD D1）；P2 再换源。 |
| `candidatesCachedOf` | `prismRoutes.ts:344` | 10min 缓存 + secid 键 + 串行加载 | 缓存键只有 secid，因子每日更新后不会失效；P2 若接入需加 `dailyDigest`。P1 不动它。 |
| `indexTechCachedOf` | `prismRoutes.ts:250` | 5 个指数的 5min 缓存 | 指数 `fq=0`、不可交易；不要塞进 autoT 因子池；保持独立。 |
| `autoTContextOf` | `prismRoutes.ts:366` | 现有文本格式（持仓/可卖/均价 + ATR/振幅） | 当前逐只 `fetchKline(30,1)`；P1 改为读因子快照 + gate 结果，**只列过闸标的**，不再逐只取数。 |
| `feesOf` | `prismAccount.ts:66` | 佣金/印花/过户费、最低佣金累计；ETF `stampExempt` | 继续复用；`stampExempt` 目前靠 `/ETF/i.test(name)`，名称缺失/LOF 会误判。P2 增加 `instrumentKindOf`；P1 保持并测试现有 ETF 名。 |
| `limitsOf` | `prismAccount.ts:140` | A股 10%/20%/5% 的规则骨架 | **必须改造**：ETF 20% 未覆盖、`*ST` 的 `^ST` 匹配不到、新股无涨跌幅无法识别。P1 用行情 f47/f48 优先；无则规则表 + `limitSource`。 |
| `rejectReasonOf` / `fillRejectReasonOf` | `prismAccount.ts:155/212` | T+1、停牌、涨跌停、整手、现金校验 | 继续复用；`placeDecision` 里卖单 `availableQty` 用 `position?.available ?? 0`（`:1724`），旧账本无 `available` 会被误判 T+1 0 股；P1 统一 `?? qty`。 |
| `matchOrder` / `applyFill` / `rollDay` | `prismAccount.ts:244/257/421` | 撮合、费用入账、T+1 解锁、成本核算 | 不在因子层重写；回测的成交模拟可复用 `feesOf`/`applyFill` 的公式。`matchTick` 对 LKG 报价目前没有拒单/跳过，见 §5.4。 |
| `placeDecision` | `prismAccount.ts:1650` | 最终落单权威：盘后/行情/涨跌停/T+1/撤单/三账本一次写 | P1 只加两项：`limitsOf` 用 f47/f48；`decision.factorRef` 过期时拒**风险增加**单（买/autoT 开腿），卖单/撤单放行。不把 gate 逻辑复制进账本。 |
| `matchTick` | `prismAccount.ts:1780` | 1min 撮合、部分成交、T+1、autoT 回补腿 | P1 不改主流程；仅对 `source='lkg'`/超龄报价 **skip（保持 pending）**，不 reject、不成交；autoT 回补腿必须放行，避免裸腿。 |
| `prismEval` | `prismEval.ts:26/38/131` | 非重叠窗口、null+原因、回撤 gate 的写法 | 回测的 forward windows 可复用 `nonOverlappingWindowsOf`；不要把 `evaluationOf` 的净值口径套到因子 IC 上。 |
| `trendLkgStore` / `rescueLog` | `trendLkgStore.ts` / `rescueLog.ts` | 日分片、清单、热条、保留上限、坏文件隔离 | 因子日志只借用“按日分片 + 30 天 + 坏行跳过”的工程模式，不复制 841 行的 LKG 复杂度。 |

### 1.3 实测证据（本机，2026-11-26，ASI）

| # | 证据 | 数字 | 对设计的影响 |
|---|---|---|---|
| E-1 | 日K缓存里有**未完成 bar** | `0.000636_101_1.json`：`partial:true`，mtime 13:01，最后一根 2026-11-26 收 27.14；同日腾讯 qfq 最终收 **26.88** | `dailyFinal` 必须主动丢末根；不能只信 `klineCacheUsable` 的 60s TTL（该文件已过 TTL，但直接读盘仍会拿到它） |
| E-2 | `fetchKline` 的 `needFull` 只看空缓存 | `em.ts:3451` `const needFull = entry.bars.length === 0` | 缓存 120 根时请求 250 根不会补历史；因子层必须传 `minBars` 并强制 full |
| E-3 | ETF 涨跌停不是统一 10% | 588000 昨收 1.254 → 涨停 1.505/跌停 1.003（20%）；159915 2.199 → 2.639/1.759（20%）；510300 3.970 → 4.367/3.573（10%） | `limitsOf` 按代码前缀给 10% 会把 588000/159915 判错；P1 用 f47/f48 |
| E-4 | 80 个日K文件读+parse | **75.5ms**（59,451 根，warm page cache）；堆增量 **11.0MB** | 因子层不要复制第二份 bar 缓存；复用 `klineMem` |
| E-5 | 纯指标计算（合成 800 根序列） | 80 × `techOf` **18.8ms**；80 × `atrFromBars` **1.7ms** | CPU 不是瓶颈；瓶颈是上游取数与 LLM |
| E-6 | 80 只腾讯行情一批 | 200ms（测试请求；真实 80 只同量级） | 每轮 gate 的行情可复用现有 `loadQuotes`，不要逐只取 |
| E-7 | 真实池子 | 11 持仓 + 40 自选 = **42 只唯一**；40 只有 fqt=1 日K；6 只 <250 根；2 只美股无 fqt=1 | 80 是设计上限，不是当前规模；52 周位置对 6 只自然为 `null` |
| E-8 | 真实 autoT | 7 只开启；`prism-autot.json` plans 25 / trades 24 / **results 0**，25 条全 aborted | 因子层不能拿 `results` 证明有效性；先修 PRD P0 审计项 |
| E-9 | 真实轮次 | `intervalSec=300`；最近 5 轮 LLM 耗时 **64–83s**，tPlans 2–5 | 快照在 LLM 前生成，下单时必须用 `factorRef.asOf` 检查年龄（建议 300s 上限） |

### 1.4 当前七个缺口（按严重度）

| # | 缺口 | 现状 | 严重度 |
|---|---|---|---|
| G-1 | 未完成 bar 进指标 | `fetchKline` 补今日柱；`atrFromBars` 不过滤；直接读盘会拿 `partial` 末根 | **P0/P1 阻断** |
| G-2 | 前复权增量拼接 | `mergeBars` 直接覆盖同日期；除权后新 qfq 与旧缓存基准不同，会拼出跳空 | **P1 阻断** |
| G-3 | LKG 只标注不拦截 | `quotes-lkg` 只写 `source`；`placeDecision`/`matchTick` 不校验 | **P1 阻断** |
| G-4 | 阈值只在 prompt | `prismPipeline.ts:189` 写 1.5%/3%；代码没有 gate；模型可忽略 | **P1 核心** |
| G-5 | ETF 涨跌停/费用 | `limitsOf` 统一 10%；`stampExempt` 靠名称 | **P1 高** |
| G-6 | 回测前视 | `fetchKline` 恒返回最近 N 根；`slice(-N)` 是未来 | **P2 阻断** |
| G-7 | 因子日志无上限 | 参考 `prism-autot.json` 25 plans 无 retention；PRD #20 | **P1 必须自带 30 天/3000 行** |

---

## 2. 目标模型（PIT / dailyFinal / intradayNow / fq）

### 2.1 两个视图（硬边界）

| 视图 | 允许的输入 | 允许的因子 | 绝不允许 |
|---|---|---|---|
| `dailyFinal` | `barDate < today` 的全部 bar；若已过 15:05 且当日 bar 是收盘后回源，可含当日 | ATR14、RANGE20、AMP20、MOM、MA、EFF、ADV、PCT252 | 盘中 `liveTodayBarOf` 补的柱；`partial:true` 的末根；任何 `barDate > asOf` 的 bar |
| `intradayNow` | 今日分时 + 实时行情 + 当日累计 VWAP | 只替换标量 `P`；产生 `VWAPDEV`、`DAYAMP` | 替换窗口内任何一根历史 bar |

**唯一允许的混用**：`MA20DEV = (P_now / mean(C[t-19..t] final) - 1) × 100`；分子盘中、分母 final。反过来不允许。

**P1 只用 `dailyFinal` 的 ATR14/RANGE20 + `bars/asof` 元数据**；`intradayNow` 在 P1 只用于 gate 的行情新鲜度，不参与慢因子。

### 2.2 `dailyFinal` 的唯一判据

```ts
const isFinalBar = (bar: DayBar, klineBarOpen: boolean, index: number, total: number): boolean =>
  !(klineBarOpen && index === total - 1)
```

工程上还要叠加两条：

1. `entry.partial === true` 时，无论 TTL 是否过期，**末根一律丢**（E-1 实测）；
2. `bar.date === today` 且当前 <15:05 ⇒ 末根一律丢；≥15:05 且 `entry.updatedAt >= 15:05` 才可保留今日 final bar。

### 2.3 复权口径决断（与 SPEC §5.2 一致）

| 用途 | fq | 说明 |
|---|---|---|
| 动量/均线/ATR/振幅/效率/位置/区间 | **1** | 前复权；不复权会把除权跳空读成暴跌 |
| 现价 `P` / 成交价 | 0（原始价） | `fq=1` 末根与现价同量纲，可直接比；但账本成本用原始价 |
| 涨跌停 `U/D` | 0（交易所原始价） | 必须用 f47/f48 或规则表，不得用复权价 |
| 指数/期货 | 0 | `normalizeFq` 已强制；`fqSupported=false` |
| 美股 | 0 | 上游只给原始价；位置/ATR 类直接 `null` + 原因 |

**三条禁令**：① 禁止同一序列混 fq=0/1；② 禁止拿请求的 `fqt` 当实际口径，必须读回包 `KlineData.fqt`；③ 同一行的因子必须同口径。

### 2.4 因子范围分期（避免 P1 一次做 12 个）

| 因子 | P1 计算 | P1 gate | P2 | 备注 |
|---|---|---|---|---|
| `bars` / `asof` | ✅ | ✅ 数据充分性 | — | PRD 门槛：≥25 根、asof ≤10 天 |
| `VOL.ATR14` | ✅ | ✅ `atr-low` | — | 复用 `atrFromBars` |
| `VOL.RANGE20`（旧 `amp20`） | ✅ | ✅ `amp-low`（3.00%） | — | 字段名 `range20Pct`，文案「20日区间幅度」 |
| `VOL.AMP20`（日均） | ✅ 计算、写日志 | ❌ 不参与 v1 | ✅ v2 G4 | 解决 C-2；P1 不改变现有通过率 |
| `MOM20/MA20DEV/EFF20/ATRRANK120/ADV20/PCT252/…` | ❌ | ❌ | ✅ SPEC 12 核心 | P2 按 SPEC §2.1 实现 |
| `INT.VWAPDEV` / `VOL.DAYAMP` | ❌ | ❌ | ✅ | 需分时/VWAP 质量位 |
| `EXE.TICK/FILL/LIMITDIST` | ❌ | ❌ | ✅ v2 | 依赖 f47/f48、ADV20、tick 表 |

> **P1 只做 3 个值 + 2 个元数据**，不是 12 个。SPEC 的 12 核心是目标态，PRD P1 明确只做 2 个因子 + 元数据；本文把 `AMP20` 作为“算了但不判”的过渡字段，避免 C-2 以后返工。

### 2.5 `FactorEnvelope`（直接采用 SPEC §5.3）

P1 的每个值必须是信封，不允许裸 number：

```ts
export interface FactorEnvelope<T> {
  v: T | null
  unit: '%' | '元' | 'min' | 'ratio' | '0-100' | 'bool'
  asOf: number
  dailyFinalAsOf: string | null
  intradayAsOf: number | null
  fq: 0 | 1
  window: { kind: 'tradingDays' | 'naturalDays' | 'intradayMinutes'; n: number; from: string | null; to: string | null; samples: number; need: number }
  stale: { is: boolean; level: 'fresh' | 'delayed' | 'lkg' | 'stale'; ageMs: number | null; approxWorkdays: number | null; reason: string | null }
  src: 'kline' | 'quote' | 'trend' | 'derived'
  quality: { partialBarExcluded: boolean; avgApprox?: boolean; limitSource?: 'em-f47' | 'rule'; unitNote?: string | null }
  missing: string | null
}
```

**硬约束**：`v === null ⇔ missing !== null`；`quality.partialBarExcluded` 对慢因子必须 `true`；`missing` 要能复算（「日K不足 21 根」），不能写「数据异常」。

---

## 3. 模块与函数签名

### 3.1 文件清单

| 文件 | 动作 | 职责 | 测试 |
|---|---|---|---|
| `src/shared/factor.ts` | 新增 | `FactorEnvelope`、`FactorId`、`AutoTGate`、`FactorLogLine`、`PrismFactorRef` 类型 | `factorTypes.test.ts`（类型/序列化） |
| `src/host/prismFactors.ts` | 新增 | 纯因子计算 + P1 因子快照 | `prismFactors.test.ts` |
| `src/host/prismGates.ts` | 新增 | `T_GATE` 常量、`t-gate-v1` 14 码、`gateOf`/`planGateOf`、`t-gate-v2` 规则表 | `prismGates.test.ts` |
| `src/host/prismFactorLog.ts` | 新增 | `prism-factor/<day>.jsonl` 追加、内存索引、30 天/3000 行保留、坏行隔离 | `prismFactorLog.test.ts` |
| `src/host/em.ts` | 改造 | `readDailyFinalBars`、`fetchKline(..., {minBars})`、qfq 连续性检查（P1-2） | `em.klineFinal.test.ts` |
| `src/shared/model.ts` / `tencent.ts` | 改造 | `QuoteRow.limitUp/limitDown` + 腾讯 f47/f48 解析 | `quoteLimits.test.ts` |
| `src/host/prismAccount.ts` | 改造 | `limitsOf` 用 f47/f48；`placeDecision` 校验 `factorRef`；`matchTick` LKG skip；`available ?? qty` | `prismFactorAdmission.test.ts` |
| `src/host/prismRoutes.ts` | 改造 | `prismInputsOf` 构建因子快照；`autoTPayloadOf` 只读内存 gate；`placeAutoTPairs` 用 `planGateOf`；日志 | `prismFactorWiring.test.ts` |
| `src/host/prismPipeline.ts` | 改造 | 删掉 prompt 里的 1.5%/3% 硬规则；autoT 段只在汇总（v0.249.1 已做一半） | `prismPrompt.test.ts` 扩展 |
| `src/client/prismDeskSide.ts` / `PrismPage.tsx` / `styles.ts` | 改造 | U1/U2/U3 + N-1/N-3（PRD §3.3/§2.6） | `prismFactorUi.test.ts` + 布局断言 |
| `scripts/factor-replay.mts` | 新增（P2） | 门禁回放 | `factorReplay.test.ts` |
| `scripts/factor-backtest.mts` | 新增（P2 可选） | 收益研究（仅技术因子，需批准） | `factorBacktest.test.ts` |

### 3.2 `em.ts` 新增 API（P1 地基）

```ts
export interface DailyFinalBarsRead {
  secid: string
  /** 已剔除未完成 bar，按 date 升序 */
  bars: DayBar[]
  lastDate: string
  /** 回包实际使用的复权口径（不是请求值） */
  fqt: 0 | 1 | 2
  fqSupported: boolean
  /** 前复权序列指纹（最近 60 根 date+close 的 sha1 前 12 位）；用于发现除权后的基准变化 */
  fqVintage: string | null
  /** 本地最近一次成功取数/落盘时刻，不是 now */
  updatedAt: number
  source: 'cache' | 'upstream' | 'cache-degraded'
  stale: boolean
  /** 是否主动丢了末根（partial/今日未收盘） */
  partialBarExcluded: boolean
  warnings: string[]
  /** null = 可用；否则是“为什么没有足够 final bars” */
  reason: string | null
}

/** 前复权序列指纹：最近 60 根 date+close 的 sha1 前 12 位；供 readDailyFinalBars 内部与缓存 key 用 */
export function fqVintageOf(bars: readonly DayBar[]): string | null

export async function readDailyFinalBars(
  secid: string,
  opts: {
    minBars?: number          // 默认 25（PRD gate）；<25 返回 reason，不硬凑
    fqt?: 0 | 1 | 2           // 默认 1；指数/美股由 normalizeFq 收敛为 0
    allowUpstream?: boolean   // 默认 false（P1 只读缓存；预热/首次可显式 true）
    timeoutMs?: number        // allowUpstream 时的预算，默认 8000
  } = {},
): Promise<DailyFinalBarsRead>
```

实现要点（按顺序，避免踩现有坑）：

1. `const mode = normalizeFq(secid, opts.fqt ?? 1)`；`fqSupported(secid)` 记入回包。
2. `const entry = await loadKlineCache(secid, 101, mode)`（复用 `em.ts:2812`，**不联网**）。
3. `const needFull = entry.bars.length < (opts.minBars ?? 25)`；若 `needFull && opts.allowUpstream`，调用 `fetchKline(secid, 101, Math.max(minBars, 260), mode, { minBars })`；否则直接返回 `reason:'缓存不足 N 根，未允许回源'`。
4. 取 `days` 后：`const dropOpen = entry.partial || (last.date === dayOf(now) && !isAfterClose(now))`；若 `dropOpen` 丢末根，`partialBarExcluded=true`。
5. `bars = days.filter(b => b.date <= maxAllowedDate)`；`maxAllowedDate` 按 §2.2；**禁止 `slice(-N)`**。
6. `updatedAt = entry.updatedAt`（不是 `Date.now()`）；`stale = entry.degradedReason !== null` 或 `updatedAt < lastCloseBoundary(now)`（仅展示；gate 再判定）。
7. `fqVintage = fqVintageOf(bars)`（最近 60 根 date+close 的 sha1 前 12 位）；`reason` 只在 `bars.length < minBars` 或 fq/缓存不可用时非空；`missing` 由因子信封承载。

`fetchKline` 只加可选第 5 参数，**不改现有 4 参调用**：

```ts
export async function fetchKline(
  secid: string,
  klt: 101 | 102 | 103 | 104 = 101,
  lmt = 6,
  fqt: FqMode = 1,
  opts: { minBars?: number } = {},
): Promise<(KlineData & { staleReason?: string }) | null>
```

`needFull = entry.bars.length === 0 || entry.bars.length < (opts.minBars ?? 0)`；这样缓存 120 根、请求 250 根会触发 full 回源。默认 `minBars=0` 保持所有旧调用行为不变。

### 3.3 `prismFactors.ts`

```ts
import type { DayBar, QuoteRow } from '../shared/model.ts'
import type { FactorEnvelope, FactorSnapshot, FactorRow } from '../shared/factor.ts'
import type { DailyFinalBarsRead } from './em.ts'

export const FACTOR_VERSION = 1

export interface FactorDeps {
  loadDaily: (secid: string) => Promise<DailyFinalBarsRead>
  loadQuote: (secids: string[]) => Promise<Record<string, QuoteRow>>
  now: () => number
}

/** ATR14%，只吃 final bars；不足 15 根 ⇒ v=null + missing */
export function atr14EnvelopeOf(bars: readonly DayBar[], fqt: 0 | 1 | 2, asOf: number): FactorEnvelope<number>

/** 20 日日均振幅%（SPEC VOL.AMP20）；不足 21 根 ⇒ null */
export function amp20EnvelopeOf(bars: readonly DayBar[], fqt: 0 | 1 | 2, asOf: number): FactorEnvelope<number>

/** 20 日区间幅度%（旧 amp20 / PRD amp20Pct）；不足 21 根 ⇒ null */
export function range20EnvelopeOf(bars: readonly DayBar[], fqt: 0 | 1 | 2, asOf: number): FactorEnvelope<number>

/** P1 快照：只给 autoT-enabled 持仓；不碰候选池/主决策 */
export async function buildAutoTFactorSnapshotOf(
  targets: ReadonlyArray<{ secid: string; name: string }>,
  deps: FactorDeps,
  opts: { now?: number; allowUpstream?: boolean; minBars?: number } = {},
): Promise<FactorSnapshot>

/** 每行 compact 文本（P1 只给日志/调试；不塞进四路 prompt） */
export function factorRowLineOf(row: FactorRow): string

/** 每日快照的稳定摘要，用于缓存键；不含 intraday 字段 */
export function dailyDigestOf(snapshot: FactorSnapshot): string
```

**计算频率**：`buildAutoTFactorSnapshotOf` **每个交易日首轮算一次**（`dailyFinal` 只依赖昨日收盘），后续轮复用同一 `snapshotId`；T11 的「09:35 与 13:10 的 ATR/振幅完全相同」由此保证。若 `FACTOR_VERSION`/`fqVintage`/当日 final bar 变化，快照失效重算。日志仍每轮写一行（值相同、`snapshotId` 相同），便于逐轮对账。

`FactorSnapshot`（P1）：

```ts
export interface FactorSnapshot {
  v: 1
  day: string
  asOf: number
  calcVersion: number
  fqtPolicy: 'cn-qfq-1'
  universe: { requested: number; included: number; excluded: Array<{ secid: string; reason: string }> }
  rows: FactorRow[]
  summary: { fresh: number; stale: number; missing: number }
  warnings: string[]
}

export interface FactorRow {
  secid: string
  name: string
  state: 'fresh' | 'stale' | 'missing'
  reasons: string[]
  bars: number | null
  asof: string | null          // 最后一根 final bar 的日期
  atr14Pct: number | null
  range20Pct: number | null    // PRD v1 用这个
  amp20Pct: number | null      // SPEC v2 用这个
  fqt: 0 | 1 | 2
  fqVintage: string | null
  partialBarExcluded: boolean
}
```

**P1 不计算** `MOM20/MA20DEV/EFF20/ATRRANK120/ADV20/PCT252/TICK/FILL/LIMITDIST/VWAPDEV`；这些在 P2 按 SPEC 公式实现。`FactorEnvelope` 类型先落地，避免以后改字段。

### 3.4 `prismGates.ts`（单一门槛模块）

```ts
export const T_GATE_VERSION = 't-gate-v1'

export const T_GATE = {
  minBars: 25,
  maxAsofDays: 10,
  minAtrPct: 1.50,          // PRD v1；注意 C-2
  minRange20Pct: 3.00,      // PRD v1 的 amp20Pct；不是 SPEC 的 AMP20
  minSpreadPct: 1.20,
  minFeeNetYuan: 20,
  minFeeNetPctOfBuy: 0.003,
  maxRoundsPerDay: 2,
  deadline: '14:50',
  maxQuoteAgeMs: 15_000,
} as const

export type TGateCode =
  | 'pass' | 'off' | 'risk' | 'deadline' | 'round-cap'
  | 'no-data' | 'bars-short' | 'stale'
  | 'atr-low' | 'amp-low' | 'spread-low' | 'fee-net'
  | 'no-plan' | 'done'

export interface TGateInput {
  now: number
  runStartedAt: number
  secid: string
  switchOn: boolean
  hasLivePlan: boolean
  roundsUsed: number
  risk: { drawdownTriggered: boolean; mainSell: boolean; stopLoss: boolean }
  factor: {
    state: 'fresh' | 'stale' | 'missing'
    bars: number | null
    asof: string | null
    atr14Pct: number | null
    range20Pct: number | null
    amp20Pct: number | null
    version: string
  }
  quote: { price: number | null; prev: number | null; source: string | null; ageMs: number | null }
  plan?: { direction: 'buy-first' | 'sell-first'; buyPrice: number; sellPrice: number; shares: number }
  account: { cash: number; available: number; qty: number }
  settings: { perOrderYuan?: number | null; participationRate: number }
}

export interface TGateResult {
  state: 'pass' | 'reject' | 'unknown' | 'blocked' | 'off'
  code: TGateCode
  text: string                 // ≤22 全角字符，直接上屏
  detail: string               // 完整句，进 title
  factors: { atr14Pct: number | null; range20Pct: number | null; amp20Pct: number | null; bars: number | null; asof: string | null; version: string }
  at: number
  /** 内部更细的原因，不改变 UI 的 14 码契约；例：lkg-quote / stale-quote / etf-limit-unknown */
  reasonCode?: string
}

export function gateOf(input: TGateInput): TGateResult
export function planGateOf(input: TGateInput & { plan: NonNullable<TGateInput['plan']> }): TGateResult
export function gateShadowOf(input: TGateInput): { version: string; state: 'pass' | 'reject'; code: string }
export const T_GATE_PRIORITY: readonly TGateCode[]

/** 门禁普查：候选数 = 各 code 计数之和 + 过闸数；用于解释“今天为什么 0 轮” */
export interface TGateCensus {
  day: string
  candidates: number
  byCode: Record<TGateCode, number>
  passed: number
  notReplayable: number
}
export function tGateCensusOf(day: string, results: readonly TGateResult[]): TGateCensus

/** 过闸标的的完整快照（s/minSpread/netEdge + 因子值），供回放/验证对齐 planId */
export interface TGateSnapshot {
  secid: string
  gateVersion: string
  factors: { atr14Pct: number | null; range20Pct: number | null; amp20Pct: number | null; bars: number | null; asof: string | null }
  s: number | null          // ATR14% / 4
  minSpreadPct: number | null
  netEdgePct: number | null
}
export function tGateSnapshotOf(input: TGateInput, result: TGateResult): TGateSnapshot
```

> v1 的 `netEdgePct` 可以 `null`（没有 TICK/FILL 明细时不算）；v2 才要求非空。不要把 `null` 写成 0。

**优先级**（严格按 PRD 附录 B，第一条命中即 `code`，`detail` 列全部不达标）：

```
off → risk → deadline → live-plan → round-cap → no-data → bars-short → stale
→ atr-low → amp-low → [plan] spread-low → [plan] fee-net → no-plan → done
```

- `live-plan`：有 pending/open-filled 计划时，`state='pass'`、`code='pass'`，UI 渲染计划本身；不要新建 gate 码。
- `done`：当日已完成，UI 走现有结果列。
- `risk` 细分文案：`风控冻结 · 回撤闸门` / `风控冻结 · 主决策减仓` / `风控冻结 · 触及止损`。
- `no-data` 与 `bars-short` 必须区分：取数失败 = `no-data`，取到了但 <25 根 = `bars-short`。
- `stale` 包含因子 asof >10 天；行情 `lkg` 用 `reasonCode:'lkg-quote'`，UI 仍显示 `—（行情本地兜底）`，不新增第 15 个码（PRD E1 的 14 码契约）。
- `planGateOf` 先算 `R`（可卖、20% 底仓、`perOrderYuan`），再算 `spreadPct`/`feeNet`；`R<100` 或 `N<5000` ⇒ `fee-net`（与 PRD §4.2 一致）。
- `gateShadowOf` 只测一个变量（PRD Q3 建议 `atr14Pct ≥ 2.00%`），只写日志，不进 UI。
- `tGateCensusOf`/`tGateSnapshotOf` 只落盘（`kind:'census'|'snapshot'`），不进 UI；用于 SPEC §4.5 的「为什么 0 轮」归因与 FACTOR-VALIDATION 的三臂对照。PRD C 的 `factor|plan` 上屏契约不变。

**`t-gate-v2`**（P2，不混进 v1）：用 SPEC G0–G10（`ATRRANK120`、`AMP20` 日均、`EFF20`、`TICK`、`FILL`、`LIMITDIST`、`netEdge`）。`T_GATE_VERSION` 升到 `t-gate-v2`；`gateOf` 按版本选规则表；每条日志带版本。v2 上线前必须 ≥20 个完成轮影子 + 人审。

### 3.5 `prismFactorLog.ts`（不是 `updateJsonLocked` 的 JSONL 追加）

```ts
export interface FactorLogStoreOptions { dir?: string; now?: () => number }

export class FactorLogStore {
  constructor(opts: FactorLogStoreOptions = {})
  /** 启动时只读今天的分片，建立 secid→最后一条索引；坏行跳过并计数 */
  init(): Promise<{ loaded: number; badLines: number; why: string | null }>
  latestOf(secid: string): FactorLogLine | null
  /** 追加本轮 lines；30 天/3000 行上限；失败只回 warnings，不抛给交易 */
  append(lines: readonly FactorLogLine[]): Promise<{ written: number; dropped: number; warnings: string[] }>
  readDay(day: string): Promise<{ lines: FactorLogLine[]; badLines: number; why: string | null }>
  prune(): Promise<{ removedDays: string[] }>
}
```

**为什么不用 `updateJsonLocked`**：它是“读 JSON 对象→合并→整份写回”，JSONL 不是 JSON 对象；用它会把日志当 JSON parse 失败或整份重写。实现用 `withFileLock(<dir>/<day>.jsonl)` + `appendFile`（O_APPEND，单行 ≤8KB），锁内串行；失败只写 `run.warnings`。这是对 PRD C “`updateJsonLocked` 追加”的工程修正，语义不变。

**保留**：`prism-factor/<YYYY-MM-DD>.jsonl`；30 自然日；单日 3,000 行；超限丢最旧并写 `dropped` 计数；坏行跳过计数；不读全文件到 GET。

### 3.6 共享类型 / payload 增量

```ts
// shared/factor.ts
export interface PrismFactorRef {
  snapshotId: string
  asOf: number
  day: string
  state: 'fresh' | 'stale' | 'missing'
  calcVersion: number
  maxAgeMs: number
  reason: string | null
}

/** 引擎侧唯一的新鲜度判据：placeDecision 与 prismGates 共用 */
export function factorRefFreshnessOf(
  ref: PrismFactorRef,
  now: number,
): { ok: boolean; reason: string | null }
```

- `PrismDecision.factorRef?: PrismFactorRef`（引擎附加，**不是模型输出**；`parseDecision` 忽略/清洗模型伪造的字段）。
- `PrismRun.factor?: { version: string; snapshotId: string; asOf: number; state: string; summary: { fresh: number; stale: number; missing: number }; gate: { evaluated: number; rejected: number; codes: Record<string, number> } }`。**只放摘要，不放 80 行明细**，避免 `prism-runs.json` 膨胀（当前 20 条约 1MB）。
- `autoT.positions[secid].gate?: AutoTGate`（payload 派生，不落盘）；plan 增量 `netEst/gateVersion/factor` 按 PRD C。
- `QuoteRow.limitUp/limitDown?: number | null`（新增；腾讯 f47/f48；东财可选）。
- `QuoteLite`（`prismAccount.ts:1338`）增加可选 `source?: QuoteSource; at?: number`；`prismRoutes.quoteLiteOf` 透传 `q.source`/`q.time`。否则 `matchTick` 只拿到 `name/price/prev`，无法判 LKG/超龄，P1-9 的 skip 做不了。
- `limitsOf` 增加可选第 4 参，旧调用不变：

```ts
export function limitsOf(
  secid: string,
  name: string,
  prevClose: number | null,
  exchangeLimits?: { upper: number | null; lower: number | null },
): OrderLimits
```

  优先 `exchangeLimits`；缺失才按规则表；规则也不确定（ETF 20% 未知/新股/无涨跌停）⇒ `upper/lower=null` + `limitSource:'unknown'`，不默认 10%。
- `PrismOrder` 不加字段；`PrismFill.channel` 是审计 #23，别夹在因子层。

### 3.7 数据流图（P1）

```
                       ┌─────────────────────────────────────┐
                       │ settings.autoT.positions（7 只开启）│
                       │ + prism account positions（11 只）  │
                       └──────────────────┬──────────────────┘
                                          │
                                          ▼
                    ┌──────────────────────────────────────────┐
                    │ prismFactors.buildAutoTFactorSnapshotOf   │
                    │  ├─ readDailyFinalBars（只读缓存，剔末根）│
                    │  ├─ loadQuotes（复用行情槽，10s TTL）    │
                    │  └─ ATR14 / RANGE20 / AMP20 信封          │
                    └───────────────┬──────────────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────────┐
              ▼                     ▼                         ▼
   ┌──────────────────┐  ┌──────────────────────┐  ┌──────────────────┐
   │ prism-factor log │  │ prismGates.gateOf()  │  │ autoTPayloadOf   │
   │ <day>.jsonl      │  │ 14 码 + 优先级       │  │ 只读内存 gate    │
   │ （30 天）         │  │ （不取数、不 await） │  │ （GET +≤5ms）    │
   └──────────────────┘  └──────────┬───────────┘  └──────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────────┐
                    │ autoTContextOf：只列过闸标的     │
                    │ （1 份，进汇总；不进 4 路）      │
                    └──────────────┬───────────────────┘
                                   ▼
                    ┌──────────────────────────────────┐
                    │ LLM 汇总 → tPlans                │
                    └──────────────┬───────────────────┘
                                   ▼
                    ┌──────────────────────────────────┐
                    │ placeAutoTPairs：planGateOf      │
                    │ 拒 → 日志 kind:'plan'，不挂单    │
                    │ 过 → 现有 placeDecision 静态校验 │
                    └──────────────────────────────────┘
```

P2 若接入主决策，只加一条虚线：`watchlist+positions（cap 80）→ 因子快照 → candidateLines`，**不改变 P1 的 autoT 流**。

**GET 的 gate 缓存**：`prismRoutes.ts` 用 `WeakMap<PrismRouteDeps, { day: string; bySecid: Record<string, TGateResult> }>` 保存最近一轮 gate；`runPrismForSlot`/`prismInputsOf` 成功后写入，GET 的 `autoTPayloadOf` 只读它。跨日或 `runStartedAt` 变化时清空；没有缓存 ⇒ `state:'unknown'` + `—（今日尚未研判）`。**禁止**在 `autoTPayloadOf` 里 await 行情/K 线。

### 3.8 缓存 key 与单飞

| 层 | key | TTL/失效 | 单飞 |
|---|---|---|---|
| K 线（既有） | `secid\|klt\|fqt`（内存）；`<secid>_<klt>_<fqt>.json`（磁盘） | 盘中 5min；partial 60s；定稿免回源 | `ttlCache` 已按 key 单飞 |
| 日因子 | `factor:daily:<secid>:<day>:<fq>:<FACTOR_VERSION>` | 当日不变；跨日失效；`fqVintage` 变则失效 | `Map<string, Promise>`；失败 10s 负缓存 |
| 每轮 gate | `factor:gate:<day>:<runStartedAt>:<secid>:<T_GATE_VERSION>` | 单轮 | 同一 run 内 Promise 复用 |
| 快照 | `factor:snapshot:<day>:<universeHash>:<FACTOR_VERSION>` | 30s（盘中）/10min（仅展示） | 模块级 `Map<string, Promise>` |
| 日志 | `prism-factor/<day>.jsonl` | 30 天 | 写锁串行；读只读内存索引 |

**跨进程**：内存单飞只在本进程；两个进程同时写日志用 `withFileLock` 串行。不要为“单飞”引入跨进程锁等待上游——缓存只读时重复计算可接受（<100ms）。

---

## 4. 性能评估（按 80 只上限、11 只真实 autoT）

### 4.1 单轮耗时

| 场景 | 读+parse | 指标计算 | 行情 | 合计 | 说明 |
|---|---|---|---|---|---|
| 11 只 autoT，warm | ~10ms | ~3ms | ~200ms（批量） | **<0.25s** | P1 主路径；每天首轮只算一次 |
| 42 只真实池，warm | ~40ms | ~10ms | ~200ms | **~0.25s** | 若 P2 扩到候选池 |
| 80 只上限，warm | 75.5ms（实测） | 20ms（实测 techOf+ATR） | 200ms | **~0.30s** | 不含网络 |
| 80 只，cold disk | +0.2–0.5s | 同上 | 同上 | **<1s** | page cache 冷 |
| 80 只，cold upstream | 0.3–0.8s/只（AUDIT-HOST-PERF P1-8） | — | — | 串行 24–64s；8 并发 **3–8s** | 只在首次预热/缓存缺失；不得每轮做 |
| LLM 一轮 | — | — | — | **64–83s（实测最近 5 轮）** | 因子层 <1% |

**GET `/prism`**：`autoTPayloadOf` 只读内存 `gate`，不 await K 线/行情；目标 p95 增量 ≤5ms（PRD E6）。当前 GET 已有 `recordEquity` 的 K 线取数，不在因子层范围；不要在 `autoTPayloadOf` 再加任何 IO。

### 4.2 内存

| 项 | 估算 | 依据 |
|---|---|---|
| `klineMem` 80 只 × ~800 根 | **11.0MB**（实测 59,451 根） | 因子层复用，不复制第二份 |
| 因子信封 80 只 | ~80KB | 每行 ~1KB |
| `prism-factor` 今日索引（3,000 行） | ~2MB | 只存最后一条 per secid + 今日 plan 行 |
| 合计新增 | **~2–3MB**（不含已有 klineMem） | 可接受 |

### 4.3 磁盘

| 项 | 估算 | 说明 |
|---|---|---|
| 现有 `klines/` | 226 文件 / **19.1MB**（实测） | 不新增日K副本 |
| `prism-factor/` 日志 | 11 只 × 78 轮 × ~0.5KB ≈ **0.4MB/日**；30 天 ≈ **12MB** | 3,000 行/日上限；只记 autoT 行 |
| 每日全量因子 panel（P2） | 42–80 行 × ~1KB ≈ **80KB/日**；250 日 ≈ 20MB | 只在 P2 接入主决策时 |
| `prism-runs.json` 增量 | +~1KB × 20 条 ≈ 20KB | 只放摘要 |
| `prism-autot.json` plan 增量 | `netEst/gateVersion/factor` 每 plan ~200B | 旧 plan 不补算 |

### 4.4 上游请求预算

- **P1 默认 0 新增上游**：因子快照只读 `klineMem`/磁盘 + 现有行情槽；`allowUpstream` 只在首轮预热/显式诊断打开。
- 首次部署 warm-up：最多 11 只 autoT，`mapLimit(...,4)`，0.3–0.8s/只 ⇒ **1–2.5s**；可接受，LLM 60s+。
- P2 扩到 80：`mapLimit(...,8)`，冷缓存 3–8s；**必须**在后台/首轮做，不得在 GET 或 `autoTPayloadOf` 做。
- 失败负缓存 10s；不要每轮重试 80 只。

---

## 5. 兼容与风险

### 5.1 fqt 与未完成 bar（最高风险）

| 风险 | 现状 | 处置（P1） | 测试 |
|---|---|---|---|
| qfq 增量拼接 | `mergeBars` 直接按日期覆盖；除权后新 qfq 基准与旧缓存不同，拼出跳空 | `refreshKline` 增加重叠校验：同日期 close 相对差 >1e-3 ⇒ `fqRebase`，丢整段缓存并 full 回源；失败则 `fqUnstable`，因子 gate 拒 | 构造旧序列 ×0.9 + 新序列，断言不混排、full 重取 |
| 未完成 bar | `partial:true` 的末根可能被直接读盘（E-1） | `readDailyFinalBars` 主动丢 `entry.partial` 末根 + 今日未收盘末根；`partialBarExcluded=true` | 用 E-1 真实 fixture，断言 ATR/RANGE20 不含 27.14 |
| 缓存不足 250 根 | `needFull` 只看空缓存（E-2） | `fetchKline(...,{minBars})` 强制 full；`readDailyFinalBars` 默认 `minBars=25`，52 周需要 250 时单独请求 | 缓存 120 根 + 请求 250 ⇒ 断言 full 被调用 |
| fq 混用 | 候选池 fqt=0、ATR fqt=1 | P1 只对 autoT 用 fq=1；P2 候选池换源；同一行 `fq` 字段必须一致 | V4：fq 0/1 混排测试失败 |

### 5.2 ETF 费用 / 涨跌停 / T+0

| 风险 | 现状 | 处置 |
|---|---|---|
| ETF 涨跌停 20% | `limitsOf` 只按 `300/301/688/689` 给 20%，ETF 一律 10%；588000/159915 实测 20% | P1 `QuoteRow.limitUp/limitDown`（腾讯 f47/f48）优先；`limitsOf` 用交易所价；无则规则表 + `limitSource:'rule'`；未知 `null` + 原因 |
| `*ST` 5% | `/^ST/i` 匹配不到 `*ST` | P1 改 `/^(?:\*?ST|S\*ST)/i`；有 f47/f48 时优先交易所价 |
| ETF 印花税 | `stampExempt = /ETF/i.test(name)` | P1 保持并测试真实名称；P2 `instrumentKindOf(secid,name)` 明确 etf/lof/stock；未知按股票（保守，不逃税） |
| 新股无涨跌停 | 当前按 10%/20% 判，可能误拒 | f47/f48 缺失/为 0 ⇒ `limitSource:'unknown'`，不做涨跌停判断（不默认 10%） |
| ETF T+0 | `rollDay` 统一 T+1；买入 `available=0` | P1 保持 T+1（保守，少做不错账）；P2 `EXE.T0` 表（债券/黄金/跨境/货币/商品 ETF）再放开；**不得**用“T+0”绕过 `available` 校验 |
| 费用最低 5 元 | `feesOf` 已正确处理累计佣金；做T plan 用 `feesOf` 双边 | P1 `planGateOf` 必须用 `feesOf`，不能自己写 `price*shares*rate`；测试 100 股 @2.00（双边 10 元）⇒ `fee-net` |

### 5.3 T+1 / pending

| 风险 | 现状 | 处置 |
|---|---|---|
| 旧账本无 `available` | `placeDecision` 传 `position?.available ?? 0`（`:1724`），卖单会被误判 T+1 0 股；`fillRejectReasonOf` 已 `?? qty` | P1 统一 `availableOf(p) = p.available ?? p.qty`；测试旧账本可卖 |
| 部分成交 | `filledShares` + `available` 递减 | `planGateOf` 的 `R` 用 `shares - filledShares` 剩余；不要用原始 `shares` |
| pending 单 | `matchTick` 只处理 `pending`；跨日撤 | 因子 stale **不撤 pending**（尤其卖单/回补腿）；只拦新开仓 |
| autoT 截止 | `placeAutoTPairs` 用 `Date.now()`，与 run 时钟不一致（审计 #21） | P1 改为 `run.startedAt`/显式 `at`；deadline、rounds、日志用同一时刻 |
| T+0 品种 | 未建模 | P1 保守 T+1；P2 表驱动；测试 518880/511090 |

### 5.4 LKG / stale 硬拒矩阵

| 数据状态 | 主买（仅 P2 接入后） | 主卖/撤单 | autoT 开腿 | autoT 平腿/回补 | UI |
|---|---|---|---|---|---|
| 因子 fresh + 行情 fresh（≤15s，非 lkg） | ✅ | ✅ | ✅（再走 plan gate） | ✅ | 正常 |
| 因子 fresh + 行情 delayed（15–60s） | ❌（`stale`） | ✅ | ❌ | ✅ | `—（行情延迟）` |
| 因子 fresh + 行情 lkg（`source='lkg'`） | ❌（`lkg-quote`） | ✅ | ❌ | ✅ | `—（行情本地兜底）` |
| 因子 stale（asof >10 天） | ❌ | ✅ | ❌ | ✅ | `—（日K停更 N 天）` |
| 因子 missing / 取数失败 | ❌ | ✅ | ❌ | ✅ | `—（日K未取到：原因）` |
| 快照 age >300s（LLM 慢） | ❌ | ✅ | ❌ | ✅ | `—（快照过期 Ns）` |

**硬拒单的边界**：只拦“风险增加”的新单（主买、autoT 开腿）；**卖单、撤单、autoT 平腿/强制回补必须放行**——否则数据故障会制造裸腿/无法止损，比不做更危险。`matchTick` 对 LKG/超龄报价 **skip 保持 pending**，不按 stale 价成交。

### 5.5 旧账本 / run / settings 迁移

| 项 | 是否需要迁移 | 处置 |
|---|---|---|
| `prism-account.json` / `prism-orders.json` / `prism-equity.json` | **不需要** | 不加字段；因子层不写三账本 |
| `prism-autot.json` plans | 兼容 | 新增 `netEst/gateVersion/factor` 可选；旧 plan 缺 ⇒ UI `—` + 原因，**不补算**（PRD T8） |
| `prism-runs.json` | 兼容 | 新增 `factor` 摘要可选；旧 run 缺 ⇒ `—`；只放摘要，不放 80 行 |
| `prism-settings.json` | **不需要** | 门槛是 `T_GATE` 常量，不给用户配置（PRD §1.5）；不加字段，避免 `mandateHashOf` 变化 |
| `prism-factor/` | 新建 | 首次 run 创建；坏行跳过；缺失 = `unknown`，不是空表 |
| 旧 `prism-autot` 25 plans/24 trades/0 results | 不改历史 | 因子层不修 `results`；PRD P0 #10/#11/#16/#24 另开 |

**回滚**：删除/停用 `prismGates` 调用即可恢复旧行为；`prism-factor/` 与 `factor` 字段可保留不影响；三账本无需回滚。

### 5.6 token / 四路重复（v0.249.1 已修一半）

- v0.249.0：`compileInput` 把 `inputs.autoT` 放进 4 路 + 汇总重复（PRD §6.1 说 6 份）。
- v0.249.1：`prismPipeline.ts` 已把 autoT 从 `compileInput` 移除，只在汇总 `contextNoNews` 后拼一次（`:182`）。**这是当前工作树的真实状态**；PRD 的 E3/E4 基线应按 v0.249.1 重测。
- 因子层 P1 **不得**把 ATR/振幅表塞回 4 路；`autoTContextOf` 只输出过闸标的的 gate 结论，且只在汇总。E3 断言 4 路 context 不含 `【自动做T`；E4 单轮字符数不得高于 v0.249.1。

### 5.7 路由 / 构建 / 测试

| 项 | 结论 |
|---|---|
| 新路由 | **0 条**。因子数据挂现有 `/tradewatcher/prism` GET/POST；日志只落盘；回放/回测是脚本。路由账 `35 = core 18 + … + prism 2` 不变。 |
| 构建片段 | 若只改宿主，`build.mjs` 的 73 项不变；若新增 U1/U2/U3 文案并加入 `REQUIRED_CLIENT_SNIPPETS`，73→76，必须同步 CHANGELOG 和验收数字。**不要**只改文案不加断言（历史上“少一段 JSX”就是这么漏的）。 |
| 测试基线 | `npm run check` 当前 **2064 / 2064 × 2 时区** + build **73 项** + `tsc 0`（v0.249.0/0.249.1 相同）。新增测试 ≥15 条（PRD E1–E8）。 |
| 路由账测试 | 不改路由则 `src/index.test.ts`、`src/host/prismRegistration.test.ts` 不动；若 P2 加路由，必须同步 4 处镜像 + `FUNCTION_OWNED_PATHS`。 |

---

## 6. 因子日志与回测

### 6.1 日志 schema（按 PRD 附录 C，P1 只落 autoT 行）

```jsonc
{
  "v": 1,
  "at": 1795675243894,
  "day": "2026-11-26",
  "runId": "14:40@1795675167922",
  "secid": "1.588000",
  "kind": "factor",                     // factor | plan | census | snapshot（census/snapshot 只给回放/验证）
  "factors": { "bars": 833, "asof": "2026-11-25", "atr14Pct": 4.73, "range20Pct": 19.54, "amp20Pct": 4.49 },
  "gate": { "version": "t-gate-v1", "state": "pass", "code": "no-plan" },
  "shadow": { "version": "t-gate-v1-shadow", "state": "pass", "code": "pass" },
  "plan": null,
  "placement": null
}
```

- P1 只落 autoT 行；P2 若接入主决策，另加每日全量 panel，不塞进这 30 天日志。
- `kind:'plan'` 行才带 `plan`（`planId/buyPrice/sellPrice/shares/spreadPct/feeNet`）与 `placement:'placed'|'rejected'`；被拒原因必须在 `gate.code`。
- 每行必须有 `v/at/day/secid/gate.version`（PRD E5）；`kind:'census'`/`kind:'snapshot'` 只给回放/验证，不进 UI。
- 30 天 / 3,000 行/日 / 坏行跳过计数；JSONL 追加，不整份重写。
- **不写**账户现金、真实持仓成本等敏感字段；`runId` 关联 `prism-runs`。

### 6.2 L1 门禁回放（P2-3，允许，且不产生收益结论）

目的：验证 `t-gate-v1` 的阈值在历史上会挡掉哪些标的，而不是证明“因子能赚钱”。

```text
scripts/factor-replay.mts
  --from 2026-08-01 --to 2026-11-25
  --version t-gate-v1
  --out /tmp/factor-replay.json
```

算法：
1. 对每个交易日 D，从 `readDailyFinalBars` 取 `barDate <= D` 的 final bars（**禁止 slice(-N)**）。
2. 计算 `ATR14`、`RANGE20`、`AMP20`、`bars`、`asof`；只应用**数据门槛**（`bars-short/stale/atr-low/amp-low`）。
3. `spread-low`/`fee-net`/`deadline`/`round-cap` 依赖计划/账户，历史无法复原 ⇒ 输出 `notReplayable`，**不伪造**。
4. 输出每日 `pass/reject` 计数、各 code 计数、覆盖率；与真实 `prism-factor` 日志（如有）比对，报告 `parity`（同 secid/同 day 的 code 一致率）。
5. 样本 <60 交易日 ⇒ 只输出计数，不写“结论”。

### 6.3 L2 收益研究（P2 可选，需产品批准；PRD 默认不做）

若用户坚持“回测因子收益”，只能做**技术因子、日频、close-to-close**：

- 面板：每个 D 用 `barDate <= D` 的 final bars 计算因子；forward return `close[D+h]/close[D]-1`，`h ∈ {1,5,20}`。
- 横截面：每日至少 20 只、至少 60 个交易日；否则 `null` + 原因。
- 指标：每日 IC（Pearson/Spearman）、`ICMean/ICStd/positiveRate/nDays`；5 分位组合平均 forward return；**不做年化 ICIR**（`docs/RECON-WORKBENCHES.md` 明确 ICIR 未年化）。
- 成本：用 `costBps` 假设 + 印花税/最低佣金；输出 0/5/10/20 bps 敏感性；**不是真实滑点**。
- 分 cohort：股票 vs ETF 分开；不混合解释。
- 明确警告：universe 是当前自选/持仓（幸存者偏差）；估值/IOPV/真价差/历史分时不可用；价格 PIT 只到“当前 qfq 基准”，不是历史当日 qfq 基准。

### 6.4 不做的“回测”

- 不做分钟级/盘口级回测（无历史逐笔/盘口）。
- 不做含 PE/PB 分位、IOPV 折溢价、真实价差的回测（无数据）。
- 不做“因子评分/权重优化/机器学习”（PRD 永久不做；无样本会过拟合）。
- 不用 `prism-autot` 的 `results` 反推因子有效性（当前 results=0，且 #10/#11/#16 未修）。

---

## 7. 当前数据源做不到的项（不得假精度）

| 需求 | 当前数据源 | 能否做到 | 处置 |
|---|---|---|---|
| **真价差**（买一/卖一、有效价差、冲击成本） | `QuoteRow` 无 bid/ask；`auctionSeries` 只在 09:15–09:25 解析腾讯 f9/f19；无逐笔/盘口历史 | **历史：不能**。当前盘口：腾讯原始报文有 f9/f19，但未接入 `QuoteRow`、未验证 ETF 深度、只有快照 | P1 不把真价差当因子；回测用显式 `costBps` 假设并给敏感性；P2 只做探针，探针通过才加 live 质量位。**禁止**用 `(high-low)/close` 冒充价差。 |
| **IOPV / ETF 折溢价** | 无 IOPV/NAV 字段；无基金公司源 | **不能** | 一律 `null` + 「无 IOPV 源」；不得用现价/净值估算冒充。P2 如需，先接源并写探针文档。 |
| **历史 PE/PB** | `fetchValuationBatch` 只有当前 f9/f23/f20（`em.ts:4330`）；无历史估值接口 | **不能回填历史**；只能从 P1 起前向记录当前 PE/PB | 因子层不计算 PE/PB 分位；P2 只做“当前值记录”，至少积累 250 个交易日再谈分位；不得用现价/当前 EPS 反推历史。 |
| **历史分钟 / 分时** | `trendArchive` 只有最近 5 日；`fetchTrend` 请求即取 | 不能做长历史 intraday 回测 | `VWAPDEV/DAYAMP` 只做 live；P2 回测明确 `intraday: unavailable`。 |
| **精确涨跌停（历史）** | 腾讯 f47/f48 只有当前快照；历史无 | 当前可做（加字段）；历史只能规则表 | P1 加 `limitUp/limitDown`；历史回放用规则表 + `limitSource:'rule'`，ETF 20%/新股未知标 `null`；不得默认 10%。 |
| **真实成交/滑点** | `matchTick` 用 1min high/low + participation cap，不是真实成交 | 不能 | 回测用 `costBps` + 参与率假设；输出假设，不输出“真实收益”。 |
| **资金流历史** | 行情 f62/f66 只有当前；rescue 采样不是全历史 | 不能做长历史因子 | 不纳入 P1/P2 因子；只做展示。 |
| **ETF 份额/换手历史** | 无历史份额；`f8` 只有当前 | 不能做历史换手因子 | `LIQ.TURNOVER` 只做当前描述；不进回测。 |
| **北交所/新股无涨跌幅** | 无上市日期/规则表 | 不能精确 | f47/f48 缺失 ⇒ `limitSource:'unknown'`，不做涨跌停判断；不默认 10%。 |

> 结论：**P1 的因子只用日K OHLCV + 当前行情**，这些是真实可得的；凡是需要盘口、IOPV、历史估值、历史分时的，全部 `null` + 原因，不做“看起来精确”的替代。

---

## 8. 实施拆分：P0 / P1 / P2

### 8.1 P0 信任底座（PRD §2.5，先于/同批于 P1；约 2.25 人日）

| ID | 任务 | 文件 | 验收 |
|---|---|---|---|
| P0-1 | #10 关闭做T开关时处理已成交腿（不能只撤 pending） | `prismRoutes.ts` / `prismAccount.ts` | 关闭开关后无裸腿；集成测试 |
| P0-2 | #11 收盘净持仓对账 + `dayOpenQty`/`forced-fail` | `prismAccount.ts` / `prismStore.ts` | 开盘/收盘 qty 一致；forced-fail=0 可验证 |
| P0-3 | #16 强制回补复用 T+1/涨跌停/停牌/现金校验 | `prismAccount.ts` | 强制回补不再绕过 `fillRejectReasonOf` |
| P0-4 | #24 至少 5 个集成场景（一腿成交后重审计/部分成交 14:50/双 store/回补失败/闸门） | `prismAutoT.test.ts` | 5 场景全绿 |
| P0-5 | #20 `prism-autot.json` 保留上限（30 天） | `prismStore.ts` | 旧 plans/results 裁剪；不无限增长 |

> 这 5 条不改 UI，且是因子层的前置条件；**未完成前不要对外说“自动做T 优化完成”**（PRD）。

### 8.2 P1 最小因子闸（约 3–5 人日 + 测试）

| ID | 任务 | 依赖 | 验收 |
|---|---|---|---|
| P1-1 | `em.readDailyFinalBars` + `fetchKline({minBars})` + 未完成 bar 剔除 + qfq 连续性检查 | — | E-1/E-2 fixture；`npm run typecheck`；单测 |
| P1-2 | `shared/factor.ts` + `prismFactors.ts`：`ATR14/RANGE20/AMP20` 信封、`bars/asof`、P1 快照 | P1-1 | V2/V3/V4/V5/V7；PIT A1–A3（append 未来 bar 不变）；V1 的 12 因子留 P2 |
| P1-3 | `prismGates.ts`：`T_GATE`、14 码、优先级、`planGateOf`、shadow、`tGateCensus`/`tGateSnapshot` | P1-2 | E1 ≥14 夹具；边界值（1.50/3.00/1.20/20）；V12 census 求和；SPEC §4.4 的 8 行高级 fixture 留 P2-2 |
| P1-4 | `prismFactorLog.ts`：JSONL 追加、30 天、3000 行、坏行隔离 | — | 写读回放；坏行计数；超限 dropped |
| P1-5 | `prismRoutes.ts`：`prismInputsOf` 构建快照；`autoTPayloadOf` 读内存 gate；`placeAutoTPairs` 用 `planGateOf`；`factorRef` | P1-2/3/4 | E2（GET 不取 K 线）、E6（+≤5ms）；T1–T9 文案 |
| P1-6 | `prismPipeline.ts`：删 1.5%/3% prompt 规则；autoT 只在汇总；4 路无因子 | v0.249.1 已移出 | E3/E4；4 路 context 无 `【自动做T` |
| P1-7 | `QuoteRow.limitUp/limitDown` + 腾讯 f47/f48；`limitsOf` 用交易所价；`*ST` 修复 | — | E-3 的 588000/159915/510300；`*ST` fixture |
| P1-8 | `placeDecision` `factorRef` 过期拒风险增加单；卖/撤/回补放行；`available ?? qty` | P1-3 | 旧账本可卖；stale 买拒/卖过 |
| P1-9 | `QuoteLite` 透传 `source/at`；`matchTick` 对 LKG/超龄 quote skip（保持 pending） | P1-7 | LKG 不成交；回补腿不受影响 |
| P1-10 | UI U1/U2/U3 + N-1/N-3（PRD §3.3/§2.6） | P1-5 | T1–T12；布局 1024/1280/1440 无滚动；禁用词 E8 |
| P1-11 | 测试 E1–E8 + V2/V3/V4/V5/V7/V9/V10/V11/V12（P1 子集） | 全部 | `npm run check`；新增 ≥15 条 |

**P1 明确不做**：12 核心全量、因子明细 tab、第 6 chip、决策流分组、阈值可调、主决策接入、收益回测。

### 8.3 P2 增强（触发后做，约 5–10 人日）

| ID | 任务 | 触发条件 | 说明 |
|---|---|---|---|
| P2-1 | SPEC 12 核心因子 + `FactorEnvelope` 全量；候选池只读接入 | 用户确认 C-1 / P1 稳定 ≥2 周 | 不评分/不排序；只加字段 |
| P2-2 | `t-gate-v2`（G0–G10：ATR 分位/AMP20 日均/EFF/TICK/FILL/LIMITDIST/netEdge） | 影子 ≥20 完成轮；人审 | `T_GATE_VERSION` bump；不覆盖 v1 历史 |
| P2-3 | `scripts/factor-replay.mts` 门禁回放 + 报告 | P1 日志 ≥20 天 | 只输出计数/parity，不输出收益 |
| P2-4 | `scripts/factor-backtest.mts` 技术因子收益研究 | **产品明确批准**（PRD 默认不做） | 见 §6.3；必须带 4 条限制 |
| P2-5 | 因子明细 tab B1（PRD） | P1 上线 ≥2 周 + 3 次具体反馈 | 先 HTML 原型；不新增高度 |
| P2-6 | 当前 PE/PB 前向记录（不回溯） | P2 | 只记录；不计算分位/不参与 gate |
| P2-7 | IOPV/真价差探针 | 有明确需求 | 先写 `docs/PROBE-FACTOR-SOURCES.md`；未验证不接 |

**P2 永久不做**：因子评分/星级/置信度/排名、推荐榜、因子页、第 6 chip、影子收益进 UI、用户可调阈值、机器学习。

### 8.4 依赖顺序

```
P0-1..P0-5（信任底座）
        │
        ▼
P1-1 ──► P1-2 ──► P1-3 ──┬─► P1-5 ──► P1-8/P1-9 ──► P1-11
        │                 │
P1-4 ───┴─────────────────┘
P1-7 ─────────────────────► P1-8/P1-9
P1-6（独立，v0.249.1 已完成大半）
P1-10 依赖 P1-5/P1-3
        │
        ▼
P2-1/P2-2（需 P1 稳定 + 影子样本）──► P2-3/P2-4 ──► P2-5
```

---

## 9. 验收命令与基线

### 9.1 基线（开工前先跑一遍，记录真实值）

```bash
cd /home/hu/workspace/Servers/dsh/Dev/dsh-tradewatcher
npm run check
# 期望（v0.249.0/0.249.1）：tsc 0；2064 / 2064 × 2 时区；selftest exit 0；build 73 项
npm run typecheck
npm run selftest
npm run build          # 末行：客户端片段校验通过：73 项
```

> 若工作树已有别的未提交改动，先在干净副本跑；不要把“别人的红”算到本批。

### 9.2 每步验收命令

| 步 | 命令 | 通过标准 |
|---|---|---|
| P0-1..P0-5 | `node --test --experimental-strip-types src/host/prismAutoT.test.ts` + `npm run check` | 5 集成场景；全量绿 |
| P1-1 | `node --test --experimental-strip-types src/host/em.klineFinal.test.ts`；`TZ=UTC ...` | E-1/E-2 fixture；partial 丢末根；minBars 强制 full |
| P1-2 | `node --test --experimental-strip-types src/host/prismFactors.test.ts`；`TZ=UTC ...` | V2/V3/V4/V5/V7；PIT A1–A3；append 未来 bar 结果不变；V1 留 P2 |
| P1-3 | `node --test --experimental-strip-types src/host/prismGates.test.ts` | ≥14 码；边界 1.50/3.00/1.20/20；高级 8 行 fixture 留 P2-2 |
| P1-4 | `node --test --experimental-strip-types src/host/prismFactorLog.test.ts` | 追加/回读/坏行/3000 行/30 天 |
| P1-5 | `node --test --experimental-strip-types src/host/prismFactorWiring.test.ts` | GET 不取 K 线；`gate` payload；T1–T9 |
| P1-6 | `node --test --experimental-strip-types src/host/prismPrompt.test.ts` | 4 路无 `【自动做T`；汇总有；字符数不增 |
| P1-7 | `node --test --experimental-strip-types src/host/quoteLimits.test.ts` | 588000/159915=20%；510300=10%；`*ST`=5% |
| P1-8/P1-9 | `node --test --experimental-strip-types src/host/prismFactorAdmission.test.ts` | stale 买拒/卖过；旧账本可卖；LKG 不成交 |
| P1-10 | `node --test --experimental-strip-types src/client/prismFactorUi.test.ts` + 布局脚本 | T1–T12；1024/1280/1440 无滚动；E8 禁用词 |
| 全量 | `npm run check` | 2064+新增 ×2 全绿；build 73（或同步后的 N 项）；tsc 0 |
| P2-3 | `node --experimental-strip-types scripts/factor-replay.mts --from 2026-08-01 --to 2026-11-25 --out /tmp/factor-replay.json` | JSON 有 coverage/parity/notReplayable；无收益结论 |
| P2-4 | `node --experimental-strip-types scripts/factor-backtest.mts --from 2026-01-05 --to 2026-11-25 --horizons 1,5,20 --out /tmp/factor-backtest.json` | `nDays≥60`、`crossSection≥20` 才输出 IC；否则 `null`+原因 |

### 9.3 性能/质量门槛（P1 DoD）

- [ ] 11 只真实持仓每只**有且只有一个** gate code；`unknown` 不静默。
- [ ] `GET /prism` p95 相对基线 **+≤5ms**；`autoTPayloadOf` 不 await K 线/行情。
- [ ] 80 只 warm 快照 **<0.5s**；GET 0 上游请求。
- [ ] `prism-factor` 30 天可回读；单日 ≤3,000 行；坏行计数可见。
- [ ] `npm run check` 全绿；新增测试 ≥15 条；构建 73 项（若 UI 片段新增则同步数字）。
- [ ] 4 路 prompt 无 `【自动做T`；单轮字符数不高于 v0.249.1。
- [ ] E-3 的 588000/159915/510300 涨跌停测试通过；`*ST` 5% 通过。

---

## 10. Go / No-Go

### 10.1 建议 Go 的顺序

1. **先做 P0 信任底座**（#10/#11/#16/#24/#20）。不做这一步，因子层只是在错误账本上贴一张更精确的标签。
2. **P1 只做 autoT 最小闸**，按 PRD 的 2 个因子 + 14 码 + U1–U3；先影子/日志跑 10 个交易日。
3. **P2 只在影子 ≥20 完成轮后**评估 `t-gate-v2`；收益回测需产品单独批准。
4. **主决策接入（C-1）单独评审**：PRD D1 明确不做；如果用户坚持，按 P2-1 的 `mode:'decision'` 设计单独开，不要偷偷塞进 4 路 prompt。

### 10.2 No-Go 条件（出现任一条就停）

- 未完成 bar 仍可能进 ATR/RANGE20（V2 失败）。
- 任何因子用 `slice(-N)` 当历史（V3 失败）。
- 同一行 fq 0/1 混用（V4 失败）。
- `v=null` 却渲染 0/50/均值（V5 失败）。
- LKG/超龄行情能进 `placeAutoTPairs` 或 `matchTick` 成交（V11 失败）。
- 588000/159915 仍按 10% 判涨跌停（E-3 失败）。
- `prism-factor` 无 30 天/3000 行上限（PRD #20）。
- `GET /prism` 因因子层新增 K 线/行情 await（E6 失败）。
- 4 路 prompt 重新出现 autoT/因子表（E3 失败）。
- 收益回测未标样本量/成本假设/universe 偏差，或输出“年化 ICIR/稳赚”结论。

### 10.3 最终判断

**可行，但只能按“P0 → P1 最小闸 → P2 目标态”分三段走。** P1 的真实价值是：

1. 把 prompt 里“模型可以忽略”的 1.5%/3% 变成**代码必过**的 gate；
2. 把静默 `continue` 变成**唯一原因码 + 数值 + 版本**；
3. 把 `results=0` 的黑箱变成**门禁普查/日志**（但不伪造结算）；
4. 为 P2 的 12 因子/回测留下**PIT、fq、LKG、日志**四条地基。

如果只能做一件事：**先做 P1-1（dailyFinal 读口）+ P1-2（ATR/RANGE20 信封）+ P1-3（gate）+ P1-4（日志）**，不要先做 UI 或评分。

---

## 11. 参考与证据索引

| 文档/代码 | 用途 |
|---|---|
| `docs/FACTOR-SPEC.md` | 12 核心/17 扩展/7 做T因子公式、`FactorEnvelope`、G0–G10、PIT 规范 |
| `docs/PRD-FACTOR.md` | D1/D4、P1 范围、U1–U3、14 码、30 天日志、E1–E8 |
| `docs/AUDIT-AUTOT-HOST.md` | #10/#11/#16/#20/#24 信任底座；#13 费用 |
| `docs/AUDIT-HOST-PERF.md` | P1-8 冷缓存 0.3–0.8s/只 |
| `docs/AUDIT-PRISM-PROMPT.md` | P1-12 LLM 61–109s；token 基线 |
| `docs/RECON-WORKBENCHES.md` | IC/ICIR 口径：ICIR 未年化，不要照搬 |
| `docs/FACTOR-VALIDATION.md` | 门禁回放/IC 的验证方案；`tGateCensus`/`tGateSnapshot` 的消费方 |
| `src/host/em.ts:3435/3451/3910` | `fetchKline`/`needFull`/`refreshKline` |
| `src/host/atr.ts:27` | `atrFromBars` 纯函数 |
| `src/host/prismRoutes.ts:344/366/629/715/730` | 候选池/autoT/gate 接入点 |
| `src/host/prismAccount.ts:66/140/155/1650/1780` | 费用/涨跌停/落单/撮合 |
| `src/host/prismPipeline.ts:86/182/189` | prompt 注入与阈值 |
| `src/host/auctionSeries.ts:57-64` | 竞价 f9/f19（仅 09:15–09:25） |
| `src/host/prismStore.ts:210-219` | `loadAutoT` 无 schema 校验（#19） |
