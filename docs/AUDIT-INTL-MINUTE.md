# AUDIT-INTL-MINUTE：伦敦金现（`122.XAU`）当日分时接上可用的分钟源 + 滞后自曝

> 基线 `6b12b4d`（v0.148.0）→ 本轮提交前工作树；**只改** `src/host/**`、`src/shared/model.ts`、`src/client/{chartNote,QuoteDrawer,index}.tsx` 与新增两个测试文件 + 本文档。
> 未改 `build.mjs`（构建仍 73 项）、无新依赖、未 commit、未重启；实验目录 `/tmp/london-*`。

**一行结论**：`122.XAU` 的当日分时链原来**只有东财 `trends2` 一条源**，东财对该标的不回数据时整条链落到
`trends-lkg` 的旧快照（10-21 14:08），而实时价来自新浪 `hf_XAU`（当刻）—— 同一张图上两个时间却都像"今天的"。
现在接入**新浪全球期货分时**（实测能到 **2026-10-24 04:53**，1374 根、带均价），并由**宿主**判定滞后：
`lagMinutes/lagReason` 随包下发，口径行显示 `数据滞后 14.5 小时（分钟源：… · 报价源：… · 原因：…）`。

---

## 1. 第一步：侦察（全部为 2026-10-24 19:14–19:35 的**真实**回包）

### 1.1 现状链路

| 事实 | 证据 |
|---|---|
| 标的 secid = **`122.XAU`**（自选/行情条里的「伦敦金现」） | `src/shared/model.ts:77`（大宗商品组）；`quotes-lkg.json` 行 `122.XAU` |
| 实时价来源 = **sina**（`hf_XAU`），抓取时刻 19:04:17、价格 3997.79 | `quotes-lkg.json` 该行 `source:"sina"`、`at:1792839873481` |
| 当日分时链 = `fetchTrendSingleDay` → **只有** EM `trends2`（`HISTORY_HOSTS`） | `src/host/em.ts:1831-1857`（`trendWithFallback(secid, 1, …)` 里唯一上游）；美股才走 `sinaUsTrend`（`:1827`） |
| 备用分钟源对 `122.*` 都是 **null**（不发请求即返回） | `sinaSymbol()` 只认 `sh/sz`（`em.ts:1875-1883`）；`tencentCode()` 只认 0/1/116（`tencent.ts:169-176`） |
| 结果：命中 `trends-lkg`，最后一点 **2026-10-21 14:08**，`source:"eastmoney-trends2"`、`stale:true` | `trends-lkg.d/122.XAU%7C1.json`（489 点，`at=1792562845800`）+ 实时 `GET /tradewatcher/trend?secid=122.XAU` 回包（`sessionDay:"2026-10-21"`、`nonSession.detail` 写明三源都没取到） |

> 注：`122.XAU` 的 LKG 条目本身在 10-21 14:07 就被冻结（东财最后一次成功），此后每次刷新都只是复用。

### 1.2 候选分时源逐个实测（相对现在 19:14）

| 源 | 请求形状 | HTTP/条数 | **最后一点** | 距 19:14 | 成交量 | 单位 |
|---|---|---|---|---|---|---|
| 东财 `trends2`（`push2his` / `push2delay`） | `/api/qt/stock/trends2/get?secid=122.XAU&ndays=1` | **连不上**：`curl(52) Empty reply`、Node `fetch failed`；**CN 对照 `1.600519` 同样失败** ⇒ 是全局不可达，不是该标的问题 | 无法测（缓存里是 10-21 14:08） | — | 缓存点里 `vol/amount` 为 0（旧口径已归一为 null） | — |
| 腾讯分钟 `web.ifzq` `minute/query`（`hf_XAU` / `hfXAU` / `XAU`） | 现有实现同参 | 200 但 `{"code":-1,"msg":"code param error"}` | **无分钟线** | — | — | — |
| 腾讯 `mkline`（`ifzq` / `proxy`） | `param=hf_XAU,m1,,240` | 200 `param error`（`web.ifzq` 直连 301 到 stgw） | 无 | — | — | — |
| 腾讯报价 `qt.gtimg.cn/q=hf_XAU` | 快照 | 200 | tick **2026-10-24 04:54:00**（价 3997.79） | ≈14h20m | 0（不提供） | 美元/盎司 |
| 新浪报价 `hq.sinajs.cn/list=hf_XAU` | 快照 | 200 | tick **2026-10-24 04:54:00**（价 3997.79，昨收 4024.26） | ≈14h20m | 0 | 美元/盎司 |
| 新浪 CN 分钟 `getKLineData?symbol=hf_XAU` | 同 A 股分钟 | 200 `null` | 无 | — | — | — |
| 新浪美股分钟 `US_MinKService.getMinK?symbol=xau` | 同美股 | 200 `x(null)` | 无 | — | — | — |
| **新浪全球期货分时** `GlobalFuturesService.getGlobalFuturesMinLine?symbol=XAU` | jsonp | **200 / 1374 行** | **2026-10-24 04:53**（价 3996.80） | ≈14h21m | **不提供**（第 2/3 列恒 `0`） | 美元/盎司；**含均价**（第 4 列） |

**结论：19:14 仍能给"当日（最近一个交易时段）"数据的源只有一条 —— 新浪全球期货分时。** 其余源要么无分钟线、
要么整体不可达（东财）。

> ⚠ 关键前提：**2026-10-24 是周六**，现货金最后成交在 **04:54**（北京时间），此后休市。
> 所以"当日分时"的正确期望是"最近一个交易时段的最后一分钟"，不是"现在 − 1 分钟"；
> 任何"≤15 分钟"的判据只能**用注入时钟 + 打桩回包**验证（见 §3 断言②），线上周六不可验。

---

## 2. 第二步：实现（改了什么）

| # | 改动 | 位置 |
|---|---|---|
| 1 | **新分钟源**：解析 `GlobalFuturesService` 的 jsonp（表头取昨收/交易日/交易所；逐点取价、均价、完整时刻） | `src/host/sina.ts`（`parseSinaGlobalMin` / `sinaGlobalMinUrl` / `fetchSinaGlobalMin`） |
| 2 | **接进既有数据层**（不新建旁路）：走 `sinaText` → `withHostBreaker('stock2.finance.sina.com.cn')` → `ttlCache(60s)` → `normalizeTrendSeries` → `TrendData{source:'sina-global-min', caliber, prePrice}` | `src/host/em.ts`（`sinaGlobalSymbol` / `globalMinuteSources` / `sinaGlobalMinuteTrend`） |
| 3 | **只对 `122.*` 换链**：`fetchTrend` 在 `sinaGlobalSymbol(secid) !== null` 时用专用源表；CN 的"两条链同源同序"不变式（新浪 → 腾讯）**原样保留** | `em.ts`（`fetchTrend` 末尾；`minuteFallbackSources()` 未改） |
| 4 | **滞后由宿主判定**：`at`（本次取数时刻）、`lagMinutes`、`lagReason` 随包下发；阈值 `TREND_LAG_WARN_MINUTES = 15` **一处定义** | `src/shared/model.ts`（`TrendData.at/lagMinutes/lagReason`、`TREND_LAG_WARN_MINUTES`、`TREND_SOURCE_LABEL`） |
| 5 | **该不该谈滞后按市场分**：沪深/港股只在盘中、美股只在美盘；国际/商品/期货（无固定时段表）只要取数成功但点很旧就**必须说** | `em.ts`（`lagWarnApplies`） |
| 6 | **口径行自曝**：`· 数据滞后 14.5 小时（分钟源：新浪全球期货分钟 · 报价源：新浪 · 原因：上游此刻没有更新的分钟线（本次取数成功））`，与「截至 …」**同一行**（不新增第二行） | `src/client/chartNote.ts`（`trendLagNote`）+ `QuoteDrawer.tsx`（口径行拼接）+ `index.tsx`（传 `quoteSource`） |
| 7 | **缺失原因按事实改写**：`122.*` 不再写"腾讯只覆盖沪/深/港股"（它已有专用源），改写"新浪全球期货分钟这次也没取到" | `em.ts`（`trendMissingReason`） |

**实测（改后，真实网络）**：`fetchTrend('122.XAU',1)` ⇒ `source:"sina-global-min"`、**1373 点**、
首点 `2026-10-23 06:01`、**末点 `2026-10-24 04:53`（3996.80）**、`prePrice 4024.26`（与 `hf_XAU` 昨收一致）、
`sessionDay:"2026-10-24"`、`at` 有值、`lagMinutes:871`、`lagReason:"上游此刻没有更新的分钟线（本次取数成功）"`；
请求主机：EM ×6（全失败）+ `stock2.finance.sina.com.cn` ×1。旧实现同一时刻给的是 10-21 14:08。

---

## 3. 断言 + 反例注入（新增 10 条，全绿）

`src/host/intlMinute.test.ts`（6 条）+ `src/client/trendLag.test.ts`（4 条），上游一律打桩、零真实请求。

| 判据 | 读数 | 注入（必败） |
|---|---|---|
| **②** 有可用当日源 ⇒ 最后一点距现在 ≤15 分钟 | 打桩回包末点 `2026-10-24 04:53`、注入 `now = 末点+2min` ⇒ `source:'sina-global-min'`、末点相等、差 2 分钟 | 仍走"只有东财"的旧链 ⇒ 差 ≈4000 分钟 ⇒ 必败 |
| **③** 回包必含 `source` 与 `at` | `typeof t.source === 'string'`、`t.at === now`、`t.lagMinutes === undefined`（不滞后不挂） | —（字段缺失即 red） |
| **①** 滞后必须自曝 | 注入 `now = 末点+120min` ⇒ `lagMinutes:120`、`lagReason` 含"没有更新的分钟线" | 把 `lagMinutes` 硬置 null（旧实现）⇒ 必败 |
| **①b** 阈值边界 | 15 分钟整 **不**告警、16 分钟告警（阈值只在 `TREND_LAG_WARN_MINUTES`） | —（边界跑两边） |
| **④** 无源可用 ⇒ 明确原因，不拿旧曲线顶替 | 新浪回 `null` ⇒ `fetchTrend === null`；`trendMissingReason('122.XSI').note` 点名"新浪全球期货分钟" | 旧曲线冒充 ⇒ 必败 |
| **④b** 只有旧数据（10-21）⇒ 必须标 `nonSession` + 日期 + 滞后 | `sessionDay:'2026-10-21'`、`nonSession.day:'2026-10-21'`、`lagMinutes` 有值 | 去掉 `nonSession`（只靠 stale 标志）⇒ 必败 |
| **①（界面）** 口径行出现「数据滞后 14.5 小时 + 分钟源 + 报价源 + 原因」 | `trendLagNote(...)` 五项齐全 | 旧口径行（只有「截至 …」）⇒ 必败 |
| **①b/①c（界面）** 不滞后一个字都不加；<60 分钟写"分钟"、≥60 写小时 | `''` / `45 分钟` / `1.5 小时` / `5 小时` | 无条件渲染 ⇒ 必败 |
| **①d 接线** 抽屉把 lag 段拼进分时口径行、宿主传 `quoteSource` | 两条正则都命中源码 | 删掉 `trendLagNote(t, props.quoteSource)` ⇒ 必败 |
| 解析器 | 表头昨收 4024.26 / 交易日 10-24 / 交易所 LIFFE；逐点价与均价；坏回包 ⇒ 空序列不抛 | — |

**门禁**：**1273 × 2 时区**（Asia/Shanghai 1273/1273、TZ=UTC 1273/1273；基线 1263 + 本轮 10 条）+ 构建 **73 项**。
既有契约两处**有意更新**：`chart-source.test.ts` 的 `122.*` 措辞（腾讯 → 新浪全球期货分钟）；
`minuteFallbackSources()` **未动**（否则会稀释"当日链与五日链同源同序"这条不变式，`trendNonSession.test.ts` ② 会红）。

---

## 4. 未做项与权衡

| 项 | 说明 |
|---|---|
| `122.*` 仍然**先试东财**（每次约 2–5s、6–12 个失败请求） | 东财是唯一给 VWAP + 每分钟成交额的源，若它恢复仍是首选；代价是首次取数慢。缓存 30–60s、休市定稿走 LKG，因此不是每 tick 都付 |
| 五日档（`ndays=5`）对 `122.*` 仍是**本地归档拼接** | 新浪全球期货分时只给"当前时段"（`minLine_1d`），没有多日；不编造 |
| 滞后原因不写"休市" | 本插件没有国际品种交易日历，只陈述**事实**："上游此刻没有更新的分钟线（本次取数成功）"；把"休市"写成结论会是猜测 |
| 其余国际品种（`100.*` 指数、`112/113/114` 国内期货）未改 | 它们各有可用源（腾讯 `us.INX`、EM 期货分时）；本次只修"实测拿不到当日分钟"的 `122.*` |
| 成交量/成交额恒 `null` | 新浪这条接口第 2/3 列恒 `0`（不提供），按红线归一为 null，不写 0；界面量能为空并已有原因说明 |
| ETF/成分等无关改动 | 无 |

---

## 5. 追加（第二轮：覆盖扩到 `101.*` / `112.*` / `100.*`，2026-10-24 20:0x）

**一行结论**：`122.XAU` 修好后用户实测"只有它好了，其它外盘更显眼"。本轮把新浪全球期货分钟的**代码表**扩到
`101.CL/GC/SI/HG/NG`、`112.B00Y`、`100.N225`，并修掉三处**出处/日期**缺陷（美股缺 `source/at`、
`100.N225` 的 11 天旧图无日期、`101.*` 无源时原因不点名）。

### 5.1 侦察实测（`GlobalFuturesService.getGlobalFuturesMinLine?symbol=`，20:05–20:10）

| symbol | 对应 secid | 条数 | 末点 | 有量 |
|---|---|---|---|---|
| `CL` | `101.CL` 原油 | 1378 | 2026-10-24 04:59 | 否 |
| `GC` | `101.GC` 黄金 | 1379 | 2026-10-24 04:59 | 否 |
| `SI` | `101.SI` 白银 | 1365 | 2026-10-24 04:59 | 否 |
| `HG` | `101.HG00Y` 铜 | 1321 | 2026-10-24 04:59 | 否 |
| `NG` | `101.NG` 天然气 | 1121 | 2026-10-24 04:59 | 否 |
| `OIL` | `112.B00Y` 布伦特 | 1270 | 2026-10-24 05:59 | **是**（第 2/3 列有值） |
| `NK` | `100.N225` 日经（SGX 期货） | 673 | 2026-10-24 05:03 | **是** |
| `XAG` | `122.XAG` 伦敦银 | 1373 | 2026-10-24 04:53 | 否 |
| `N225`/`NIKKEI`/`KS200`/`KOSPI`/`KOSPI200`/`K200`/`KS`/`KRX`/`NKD`/`NIY`/`SPI`/`B`/`BRENT`/`PL`/`PA` | `100.KOSPI200` 等 | **0** | — | — |

### 5.2 采用方案

| 品种 | 源 | 说明 |
|---|---|---|
| `101.CL/GC/SI/HG/NG` | `sina-global-min`（同一条链、同一缓存 60s、同一主机断路器 `stock2.finance.sina.com.cn`） | 代码表 `SINA_GLOBAL_MIN`（去掉 `00Y` 后缀再查） |
| `112.B00Y` | `OIL` | **代理**：ICE 布伦特连续 ≠ 当月合约，口径行自曝 |
| `100.N225` | `NK` | **代理**：SGX 日经 225 期货 ≠ 日经现货，口径行自曝 |
| `100.KOSPI200`、`100.HSI` 等 | 无 | 实测 KS200/KOSPI/KOSPI200/K200/KS/KRX 全空 ⇒ `trend:null` + `missing.why='no-source'`，原因里列「已试：东财 trends2、新浪全球期货分钟（该品种没有对应代码）、腾讯分钟、本地兜底快照」 |
| `106.FRO`/`107.VIXY`（美股） | `sina-us-min` | 修 early-return：美股改走同一条 `trendWithFallback` loader，从而拿到 `at`/`lag`/`nonSession` |
| 任何 LKG 兜底 | `lkg-snapshot` | 老快照没记 `source` 时补上；`nonSession.reason` 改为「当日分时源不可用，最后交易日 YYYY-MM-DD（显示本地兜底快照）」 |

**统一标注**：把 `annotate()` 抽成模块级 `annotateTrendPayload()`，`settled` 短路复用也过同一套标注
（原来它直接 `{...settled.trend, cached:true}` 返回 ⇒ 旧图既无 `stale` 也无 `nonSession`、`source` 为空）。

**改后实测（真实网络，20:0x）**

| secid | 点数 | 末点 | source | at | lagMinutes |
|---|---|---|---|---|---|
| `122.XAU` | 1373 | 10-24 04:53 | sina-global-min | 有 | 924 |
| `101.CL` | 1378 | 10-24 04:59 | sina-global-min | 有 | 918 |
| `101.GC` | 1379 | 10-24 04:59 | sina-global-min | 有 | 918 |
| `101.SI` | 1365 | 10-24 04:59 | sina-global-min | 有 | 918 |
| `101.HG00Y` | 1321 | 10-24 04:59 | sina-global-min | 有 | 918 |
| `112.B00Y` | 1270 | 10-24 05:59 | sina-global-min | 有 | 858 |
| `100.N225` | 673 | 10-24 05:03 | sina-global-min | 有 | 914 |
| `100.KOSPI200` | — | — | — | — | —（null + no-source + 已试清单） |
| `106.FRO` | 385 | 10-23 16:00 | sina-us-min | 有 | —（周末，非美盘时段） |
| `107.VIXY` | 385 | 10-23 16:00 | sina-us-min | 有 | — |

### 5.3 断言 + 注入（`src/host/intlCoverage.test.ts`，6 条）

① `CL/GC/SI` 各有可用源且末点距取数 ≤18h（注入：不接新源 ⇒ 必败）；①b `100.KOSPI200` 路由回
`trend:null` + `missing`（含「已试：」与「没有对应代码」，注入：只回 `{trend:null}` ⇒ 必败）；
② `122.XAU/101.CL/106.FRO` 三条路径都必带 `source`+`at`（注入：删掉 ⇒ 必败）；③ `100.N225` 兜底快照
必带 `stale:true`+「最后交易日 2026-10-13」（注入：旧文案无日期 ⇒ 必败）；④ 滞后读数（落后 14h 必给 / 只差 2 分钟必不给）；
④b 接线：美股不得 early-return。

**门禁**：**1279 × 2 时区**全绿（1273 基线 + 6 条）+ 构建 **73 项**。
**有意更新的既有断言 1 处**：`usChart.test.ts` ②b 原写"真实多日源不标 source" ⇒ 与"国际回包必须带出处"冲突，本轮反转为 `source === 'sina-us-min'`。
