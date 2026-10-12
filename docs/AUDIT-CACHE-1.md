# AUDIT-CACHE-1 —— 数据层缓存与持久化审计：是否存在「同一数据反复拉取 → 把上游打成熔断」

- 基线：`main` @ `24936cd`（v0.66.0），工作区干净；**本轮只读 + 只在 `/tmp` 跑临时脚本**，
  唯一写入是本文档（另见 §6 的副作用披露）
- 审计对象：`/home/hu/workspace/Servers/dsh/Dev/dsh-tradewatcher`（宿主侧数据层）
- 现场：2026-10-12 14:57–15:15（盘中，东财行情主机间歇性不可达；用户 3080 服务未重启、未改动）
- 方法约定：**「实测」= 本机跑出来的数字（附命令）；「推断」= 只读代码得出的结论（附验证方式）**。
  二者在文中分别标注，不混在一句里。

---

## 0. 结论（先看这一段）

**判定：存在「同键同数据的重复拉取」，且量级不小（一次调用最多 56 个 URL 各打 2 遍、页面开着时 ~62–104 次/分钟）；
但没有证据表明是我们把它打挂的 —— 相反，熔断器在东财不可达期间把请求压到 ~0.7 次/分钟，这一条有实测与现网双向证据。**

1. **真·重复拉取（同键同数据）**：`/breadth?dist=1` 在「指数行情没有涨跌家数」（＝行情走备用源时的常态）下，
   一次调用发 **113 次上游请求**，其中 **112 次落在 56 个字节级完全相同的 URL 上（每个打 2 遍）**：
   源 B 全量分页（`breadthCount.ts:355`）与涨跌分布扫描（`routes.ts:50`）各扫一遍同一份 clist 数据。
   `distCache` 60s + `BreadthCountCache` 120s 只挡「跨调用」，挡不住「同一次调用内的两遍」。
2. **页面级量级**：大盘页开着时实测 **310 次/5 分钟（=62 次/分）**；源 A 缺失时 **180 次/2 分钟（=90 次/分）**；
   每 60s 一次 56 页全量扫描，**每 60s 有 56 次是重复的**。自选页首屏（10 标的）= **31 次**（含 20 次 K 线，2 次/标的，因 `fqt` 进缓存键）。
3. **反证（反对「我们打挂上游」）**：把东财三台主机注入「连接被立刻关闭」后实测 ——
   第 1 次 `/breadth?dist=1` 只打出 **12 次**东财尝试，熔断器随即打开；之后连续两次调用 **东财 0 次**。
   模拟 40 分钟故障 + 大盘页每 10s 轮询（240 次调用）：东财累计仅 **≈28 次尝试（0.7 次/分钟）**，
   熔断 trips 停在 5 —— 与现网 3080 服务当时的 `trips=5` **完全一致**（15:00 实测）。
   **算术外推（不是实测）**：若没有熔断器，同样 240 次调用按实测的"每次调用最多 4 次尝试/页"算，
   一次调用 ≈233 次尝试、40 分钟 ≈5.6 万次 —— 熔断器把这段窗口压掉了约三个数量级。
4. **真正的缺口在「熔断器之外」**：K 线走 `fetchFromHost`（`em.ts:1835`）、腾讯/新浪/日历全部裸 `fetch`，
   **不记熔断、不受熔断保护**。冷启动/首屏那一刻，实测 3.8 秒内打出 46 次东财请求（三方临时实例日志），
   这类**突发**才是"上游正不稳时又被推一把"的现实风险 —— 但它是启动突发，不是持续重复。
5. **无法证明因果**：上游的限流/熔断阈值我们拿不到（无公开阈值、无 `429/Retry-After` 证据），
   本机只能给出「我们的量级 + 时间线」。**不许断言"是我们把上游打挂的"**，本报告也不这么写。

---

## 1. 事实清单（先画地图）

### 1.1 上游主机与保护机制

| 主机组 | 用途 | 是否过熔断器 | 位置 |
|---|---|---|---|
| `push2delay` / `push2` / `push2his`.eastmoney.com | 行情、K 线、分时、clist、资金流 | ✅ `fetchAny` | `em.ts:32-33`、`em.ts:113` |
| `searchapi.eastmoney.com` | 搜索 | ✅（独立熔断） | `em.ts:34`、`em.ts:2316` |
| `data.eastmoney.com` / `emdatah5.eastmoney.com` | 财经日历 | ❌ 裸 `fetch` | `calendar.ts:111`、`calendar.ts:256` |
| `web.ifzq.gtimg.cn` / `proxy.finance.qq.com` / `qt.gtimg.cn` / `smartbox.gtimg.cn` | 腾讯兜底（K 线、分钟线、行情、板块、搜索） | ❌ 裸 `fetch` | `tencent.ts:72,133,167,214,313`、`em.ts:1274`、`em.ts:1835` |
| `quotes.sina.cn` / `hq.sinajs.cn` / `vip.stock.finance.sina.com.cn` | 新浪兜底（5 分钟线、行情、ETF 榜） | ❌ 裸 `fetch` | `sina.ts:143,206`、`em.ts:1252`、`rescue.ts:736` |

熔断器本身（`breaker.ts`）：按主机独立（`109-118`）、连续失败 3 次打开（`38`）、
退避 `120s × 2^trips`、上限 900s（`39-40, 90`）、半开期只放行一个探针（`62-71`）、
探针失败立即重熔并加倍冷却（`84-93`）。
`fetchAny`（`em.ts:113-171`）在其上加：2 轮 × 每主机 2 次尝试 + 抖动退避（`109-110, 153`）、
9s 总截止（`111`）、「整轮都是立刻被关闭 ⇒ 跳过第二轮」（`159-162`）、
只对「本轮从未成功过」的主机记失败（`164-165`）。

### 1.2 逐条取数路径（缓存键 / TTL / in-flight / 负缓存）

| # | 数据种类 | 宿主函数（文件:行） | 上游 | 缓存键 | TTL / 有效期 | in-flight 合并 | 负缓存 / 退避 |
|---|---|---|---|---|---|---|---|
| 1 | 批量行情（`/quotes`、`/portfolio`、`/badge`、`/anomaly`、`/ytd` 共用） | `loadQuotes` `em.ts:771`、`rawQuotes` `em.ts:536` | push2delay→push2 `/api/qt/ulist.np/get` | **逐 secid 槽**（大写）`em.ts:736` | `quoteFreshMs` = `prefs.refreshSec×1000`（默认 **10s**，夹 5–60s）`em.ts:747-752`；失败时旧值可服务 10 分钟 `em.ts:744` | ✅ `quoteInflight` `em.ts:741,787,823`（实测并发 8 → 1） | 半：TTL 内命中即不请求；**缺口重试 1 轮**（`em.ts:538`）⇒ 上游只回部分标的时一次调用 = **2 次**上游（实测 5→3 次含兜底） |
| 2 | 个股详情 `/detail` | `fetchStockDetail` `em.ts:880` | 同 1 | `detail:<secid>` `em.ts:882` | 10s | ✅ `ttlCache` `em.ts:54` | ❌ 失败不入缓存 |
| 3 | 日/周/月/年 K（`/kline`、`/chips`、`/ytd`、`/tones`、`/anomaly`、工具） | `fetchKline` `em.ts:1879` → `refreshKline` `em.ts:2060` → `requestKlineFromTencent` `em.ts:1786` / `requestKlineRaw` `em.ts:1825` | **腾讯 fqkline 优先** → push2his→push2delay→push2 `/api/qt/stock/kline/get` | 内存 `klineMem[secid\|klt\|fqt]` `em.ts:1452`；磁盘 `klines/<secid>_<klt>_<fqt>.json` `em.ts:1633`；ttlCache `kline:<secid>:<klt>:<fqt>:full\|incr` `em.ts:2061` | `full` **3600s**、`incr` **120s**（`em.ts:2062`）；未完成 bar 60s（`PARTIAL_TTL_MS` `em.ts:1462`）；**休市定稿免回源** `isSettledOffline` `em.ts:1891` | ✅ `ttlCache`（实测并发 8 → 1） | ✅ **最强**：失败结果（`null`）同样进 ttlCache ⇒ full 失败锁 1 小时、incr 失败锁 2 分钟（实测：首取 7 次尝试后连续 4 次 = 0） |
| 4 | 当日分时 `/trend?ndays=1`、缩略图、迷你卡 | `fetchTrend` `em.ts:1336` → `fetchTrendSingleDay` `em.ts:1196` → `trendWithFallbackRaw` `em.ts:1007` | push2his→push2delay→push2 `/api/qt/stock/trends2/get`（`fetchAny` ⇒ 有熔断） | `trend:<secid>:<ndays>` `em.ts:1014` | 上游值 60s（`em.ts:1061`）**+ `peekCache` 45s 宽限 ⇒ 实际 ≈105s**；LKG 值 20s（`grace: 0` `em.ts:1057`）；休市定稿复用 300s（`em.ts:1023`） | ❌ **无**：`peekCache`+手动 `cache.set`，不走 `ttlCache` ⇒ 实测并发 8 → **8 次上游** | ❌ 失败不入缓存（下一次调用立刻再打）；落盘 LKG `trends-lkg.json` 兜底 |
| 5 | 五日/多日分时 `/trend?ndays=5` | `fetchMultiDayTrend` `em.ts:1295` | 新浪 `quotes.sina.cn/…getKLineData` → 腾讯 `proxy.finance.qq.com/…mkline` | `trend-md:<sinaSym>:<txSym>:<datalen>` `em.ts:1303` | 90s | ✅ `ttlCache`（实测并发 4 → 1） | ❌ |
| 6 | 涨跌家数（源 B 全量分页） | `resolveBreadthCount` `breadthCount.ts:499` → `countBreadthFromClist` `breadthCount.ts:355` → `em.fetchClistPctPage` `em.ts:2098` | push2delay→push2 `/api/qt/clist/get`（沪深A股、`pn=1..56`、`pz=100`） | `BreadthCountCache`：**模块级单槽、非键**`breadthCount.ts:447`、`520-528` | 120s（构造时夹 60–300s `452-454`） | ❌ 并发两路各扫一遍（实测并发 2 → 56×2） | ❌ **只缓存成功**（`452-465`：失败不 `set`）⇒ 失败后每次调用重扫（熔断开着时退化为纯本地快速失败，无网络流量） |
| 7 | 涨跌分布 `/breadth?dist=1` | `distributionSnapshot` `routes.ts:50`（循环 `55-66`）→ `em.fetchClistPctPage` | **与 #6 完全相同的 56 个 URL** | `distCache`：模块级单槽 `routes.ts:48` | `DIST_TTL_MS` 60s `routes.ts:37` | ❌ 无（实测并发 2 → 56×2） | 半：`distCache = snap` **无条件写**（`routes.ts:80`）⇒ 失败也缓存 60s（带原因） |
| 8 | 板块/概念/ETF 榜 `/board` | `fetchBoard` `em.ts:2112` / `fetchBoardLive` `em.ts:2129` | `/api/qt/clist/get`（`m:90+t:2`/`t:3`/ETF fs）；失败回落腾讯板块榜 / 新浪 ETF 榜 | `board:<scope>:<sort>:<pn>:<pz>` `em.ts:2140` | 30s `em.ts:2141` | ✅ `ttlCache` | 半：LKG（`board-lkg.json`，10s 节流落盘 `em.ts:708-731`，只留最近 40 条） |
| 9 | 行业归属 `/industry`、`/industries` | `fetchIndustryOverview` `em.ts:2255`、`industryNameOf` `em.ts:2217`、`industryBoardPctMap` `em.ts:2228` | `/api/qt/stock/get`（f127，逐代码）+ 行业榜 clist **1..8 页** | `industry-name:<secid>` `em.ts:2218`；榜页沿用 #8 的键 | 名称 600s `em.ts:2214`；榜页 30s | ✅ `ttlCache`；批量用 4 路小池 `em.ts:2242` | ❌ |
| 10 | 自选异动 `/anomaly` | `detectAnomalies` `anomaly.ts:113` → `fetchKlineZero` `anomaly.ts:151` | 同 #3（**fqt=0**、`lmt=BASELINE_DAYS+6`） | 同 #3（复用同一份磁盘缓存） | 同 #3 | ✅ 同 #3 | 同 #3 |
| 11 | 搜索 `/suggest` | `searchSymbols` `em.ts:2307` | searchapi `/api/suggest/get` → 腾讯 smartbox | `suggest:<q>` `em.ts:2314` | 8s | ✅ `ttlCache` | ❌ |
| 12 | 护盘采样（**定时器**，非路由） | `RescueMonitor.tickOnce` `rescue.ts:1118`；取数 `fetchData` `rescue.ts:634`（= `fetchAny`）；`fetchMinuteSeries` `rescue.ts:805`；`fetchQuoteSource` `rescue.ts:864` | 每通道 `push2his trends2` **+** `push2delay fflow`（2 次/通道）；快照 1 次；日线基准 `push2his kline`；兜底腾讯/新浪 | **无 TTL 缓存**：快照每次 tick 都打；分钟序列 60s 节流（`rescue.ts:939,1202`） | — | ✅ `tickFlight`（SingleFlight）`rescue.ts:932,1109`；`ensureFresh` 另有 20s 冷却 `rescue.ts:1861` | ❌ 无失败缓存；日线失败有 30 分钟冷却（`rescue.ts:1193`） |
| 13 | 财经日历 `/calendar` | `calendar.sync` `calendar.ts:479` | `data.eastmoney.com` + `emdatah5.eastmoney.com`（**不过熔断器**） | `calendar.json` + `syncedAt` | 成功 6h（`calendar.ts:11`）；**失败冷却 5min**（`calendar.ts:19`） | ✅ `syncing` 单飞（`calendar.ts:486`） | ✅ 5 分钟冷却 |

### 1.3 缓存键的区分度（本轮的三个具体问题）

| 问题 | 实测答案 | 证据 |
|---|---|---|
| `fqt` 进 K 线键 ⇒ `fqt=0/1` 各拉一次？ | **是，各拉一次**（同 secid 两份完整序列：`_101_1.json` + `_101_0.json`）。这是**不同数据**（前复权 vs 不复权），属"必要重复"；但**首次**打开一只标的要付 2 次全量 | 实测 S3-2 = 2 次；现网 `klines/` 中 **36 个 `(secid,klt)` 组合同时有两口径文件**（如 `0.000636_101_0.json` + `0.000636_101_1.json`） |
| `lmt` 不同（界面 240 / 工具 360 / 筹码 360 天）是否重复拉？ | **否，不重复**。`lmt` **不在**缓存键里（`em.ts:2061`），首次全量恒取 `KLINE_FULL_LMT`（101→800 根，`em.ts:1432`），之后恒取 `KLINE_RECENT_LMT`（101→10 根，`em.ts:1433`），`lmt` 只在切片时用（`em.ts:1895`） | 实测 S3-1：240/360/45 三次调用共 2 次上游（1 全量 + 1 增量），**lmt 变化 0 次额外** |
| `klt` 不同？ | **各一套**（日/周/月各自缓存与增量）；**年 K 复用月 K**（`klt=104 ⇒ baseKlt=103`，`em.ts:1886`） | 实测 S7-6：切 月K→年K = 0 次上游 |
| `days`（分时）不同？ | **各一套键**（`trend:<secid>:<ndays>`），但 `ndays` 上游实际忽略（`em.ts:1192-1194` 有实测结论）⇒ 单日/五日是两条不同的取数链（东财 trends2 vs 新浪/腾讯 5 分钟） | 实测 S2-4：4×单日 + 4×五日 = 5 次（4 东财 + 1 新浪） |
| 同一批数据被不同接口各取一遍？ | **是，两处**：① `/breadth` 内 #6 与 #7 扫同一份 clist（56 URL ×2）；② 自选页里 `/tones`（fqt=0）与 `/ytd`（fqt=1）对同一 secid 各拉一次 K 线（**共享缓存已做到**：`/anomaly` 与 `/tones` 同为 fqt=0，第二者 0 额外请求） | 实测 S4-4（112 = 56×2）、S7-1（10 标的 = 20 次 K 线） |

### 1.4 客户端节拍（决定宿主被打多频）

| 客户端 | 节拍 | 影响 | 位置 |
|---|---|---|---|
| 行情引擎（行情条/自选/持仓） | `prefs.refreshSec`（默认 **10s**）；宿主 TTL 同步设为 `refreshSec×1000` | 每 10s 必打 1 次上游行情 | `client/useQuotes.ts:120`、`index.ts:153`、`routes.ts:1081`、`em.ts:747` |
| 侧栏徽标 `/badge` | 60s | 1 次上游行情（与引擎共享逐标的槽，通常 0 额外） | `client/index.tsx:60` |
| YTD `/ytd` | **跟随行情 ts 变化（=每 10s）** | 每次重算，但基准按日 memo ⇒ 稳态只有共享的行情请求 | `client/useYtd.ts:38-52` |
| 大盘页 `/breadth?dist=1` | **跟随行情 ts（=每 10s）** | 60s 一次 56 页全量扫描（实测 62 次/分） | `client/MarketPage.tsx:104-124` |
| 迷你分时（行情条卡片） | 客户端 90s TTL、失败 15s | 每 90s × 卡片数 的东财分时请求（宿主 TTL 60s ⇒ 每次都会回源） | `client/mini.ts:22,24` |
| 抽屉图表 | 分时 30s / 五日 2min / K 线 10min（休市更长） | 分时 30s 一次；K 线基本只在增量 TTL（120s）外回源 | `client/chartCache.ts:50-57` |
| 护盘面板 `/rescue` | 30s（尾盘 15s，`intervalSec`） | `ensureFresh` 有 20s 冷却 + `tickFlight` 与定时采样合并 ⇒ 通常 0 额外 | `client/RescuePanel.tsx:348`、`routes.ts:982`、`rescue.ts:1861` |
| 日历 `/calendar` | 面板打开时（`sync` 自身 6h TTL + 5min 失败冷却） | 实测 2 次上游 / 同步 | `routes.ts:1016-1046`、`calendar.ts:479-486` |

### 1.5 持久化（谁写、多久写一次）

| 文件 | 写入者（文件:行） | 节流 | 现场规模（2026-10-12 15:00） |
|---|---|---|---|
| `watch.json` / `positions.json` / `ledger.json` / `prefs.json` | 用户数据（store.ts） | — | 本次审计**只读** |
| `quotes-lkg.json` | `persistLastGood` `em.ts:248-269` | 45s（`LKG_PERSIST_MS` `em.ts:212`） | 129 行 |
| `trends-lkg.json` | `persistTrendLkg` `em.ts:966` | 5s（`TREND_LKG_PERSIST_MS` `em.ts:940`） | **4.2 MB**（当日多 secid 分时全量） |
| `trends/<secid>/<day>.json` | `archiveTrendDays`（`em.ts:1125-1143` 调用） | 每次取数后按日覆盖 | 65 个 secid 目录 |
| `klines/<secid>_<klt>_<fqt>.json` | `saveKlineCache` `em.ts:1681`（按 bar 变化写）+ `pruneKlineCache` `em.ts:1702`（上限 300、10 分钟扫一次） | 无节流（只在 bar 变化时） | 174 个文件 / 100 个 `(secid,klt)` 组合，其中 **36 组同时存在 fqt=0 与 fqt=1**（同一标的两份完整序列） |
| `board-lkg.json` | `persistBoardLkg` `em.ts:708` | 10s，只留最近 40 条 | 170 KB |
| `rescue-log.json` | `RescueMonitor.persist`（`writeChain` 串行） | 事件/快照驱动 | 356 KB；`days['2026-10-12'].samples = 371` |
| `calendar.json` | `CalendarStore` | 同步时 | 474 KB |

> **现成计数器的盘点结论**（任务要求先找）：仓库里**没有**「上游请求总数」计数器。
> 可用的现成计数只有三样：① 熔断器 `trips`/`fails`/`until`（按主机、内存态，经 `/tradewatcher/health` 暴露，`routes.ts:275-279`）；
> ② 护盘 `rescue-log.json` 的 `samples`（每拍 +1，`rescue.ts:1377`）；
> ③ `console.warn('[tradewatcher] upstream failed' …)` 日志（`em.ts:166`）。
> 因此本报告的分路径计数**都是自己测的**（见 §2），口径写在每条结论旁边。

---

## 2. 实测计数（核心证据）

### 2.0 方法与可复现性

- 用 `--import` 预加载器**替换 `globalThis.fetch`**（`/tmp/audit/intercept.mjs`），
  在**不改插件代码**的前提下拦截每一次上游调用并计数：模式 `replay`（回 fixture，**零真实网络**）、
  `fail`（对指定主机注入 `TypeError('fetch failed')`，等价于实测到的"连接被立刻关闭"）、
  `record`（真网络，仅用于最初两次形状校验）。
- **上游 payload 是"形状忠实的合成 fixture"**（`/tmp/audit/genfixtures.mjs`）：全市场 `total=5513`、每页 100 行、
  K 线 800/320 根、分时 242 点、分笔资金流 240 行。计数结论只依赖**控制流**（页数、早退、缓存命中），与数值无关。
  合成的原因有二：审计期间东财 clist **正在整段不可达**（连打 4 次全失败），且用户的顾虑正是"别再打它"。
- **时钟钉死**在 2026-10-12 10:30（盘中，`TW_AUDIT_NOW`），避免"15:05 休市定稿免回源"把请求数悄悄变成 0；
  需要跨 TTL 的场景用 `__twClock.advance()` 显式推进。
  所有写入都锁在 `DSH_HOME=/tmp/audit/home-*`（见 §6：这一条是**修正后**才做到的）。
- 复现命令见 §5。每条数字下面的 `Sx-y` 就是脚本里的步骤名。

### 2.1 行情（`/quotes`、`/portfolio`、`/badge`、`/anomaly`、`/ytd` 的公共链）

| 场景 | 上游请求 | 说明 |
|---|---|---|
| S1-1 冷启动一次批量取数（5 标的） | **1** | 整批 1 次 `ulist.np` |
| S1-2 立刻再取一次（≤10s TTL） | **0** | 逐标的槽命中 |
| S1-3 取子集（持仓 ⊂ 引擎集合） | **0** | 逐 secid 槽的正收益（`em.ts:727-735` 注释里那次修复确实有效） |
| S1-4 **并发 N=8 同一批（冷）** | **1** | `quoteInflight` 合并生效 |
| S1-5 混入 1 个上游不回的标的 | **3**（2 EM + 1 腾讯） | `rawQuotes` 的"缺口重试 1 轮"（`em.ts:538`）⇒ **上游只回部分标的时，每轮行情成本 ×2** |

### 2.2 分时（`/trend`、行情条迷你卡、抽屉）

| 场景 | 上游请求 | 说明 |
|---|---|---|
| S2-1 单日分时（冷） | **1** | push2his `trends2` |
| S2-2 60s 内重复取 | **0** | 命中 `trend:` 键 |
| S2-3 **并发 N=8 同一 secid（冷）** | **8** | ⚠ **无 in-flight 合并**：同一份数据打 8 次 |
| S2-4 并发 4×单日 + 4×五日 | **5** | 4 次东财 + 1 次新浪（五日那条链有 `ttlCache` 合并，对比出 #1 的缺陷） |
| S2-5 五日（冷） | **1** | 新浪 5 分钟线（`datalen=264`） |

### 2.3 K 线（`/kline`、`/chips`、`/ytd`、`/tones`、`/anomaly`）

| 场景 | 上游请求 | 说明 |
|---|---|---|
| S3-1 同一 (secid,klt,fqt) 用 `lmt=240/360/45` 连取三次 | **2** | 1 次全量 + 1 次增量；**`lmt` 变化 0 额外**（`lmt` 不在键里） |
| S3-2 `fqt=1` 后 `fqt=0`（`/chips` 的真实调用序） | **2** | `fqt` 进键 ⇒ 各一份；但两者是**不同数据**（必要重复） |
| S3-3 同一对再来一遍（各自 TTL 内） | **0** | 120s 增量键 + 3600s 全量键 |
| S3-4 **并发 N=8 同一 (secid,klt,fqt)** | **1** | `ttlCache` 合并生效（与分时形成对照） |
| S3-5 日K→周K→年K | **3** | 每周期的第一份各 1；年K 复用月K |
| S3-6 首取（full）与紧随的增量（incr） | **2** | 首次看一只标的的日K = 2 次上游（全量 800 根 + 增量 10 根），之后 120s 内 0 |

> 「首次全量 800 根」也解释了 S7-5：`/chips` 为了拿 5 根 `fqt=0` 的收盘价，付的是**一次 800 根的全量**（`KLINE_FULL_LMT`），
> 这是**故意的缓存预热**（同 secid 之后的 `/tones`、`/anomaly` 都吃这份缓存），算"设计取舍"而非缺陷。

### 2.4 `/breadth`（本轮最重要的量级）

| 场景 | 上游请求 | 构成 |
|---|---|---|
| S4-1 `/breadth?dist=1`，源 A 可用（指数行情带 f104/f105/f106） | **57** | 1 行情 + 56 clist（分布扫描） |
| S4-2 60s 内第二次 | **0** | `distCache` 命中 |
| S4-3 `/breadth`（不带 dist）连打两次 | **1** | 只有指数行情；第二次 0 |
| **S4-4 源 A 缺失（＝行情走备用源的常态）+ `dist=1`** | **113** | 1 行情 + **112 clist**；**56 个 URL 每个打 2 遍** |
| S4-5 两次调用（源 A 可用），第一次 57、第二次 0 | **57 / 0** | 60s `distCache` + 10s 行情 TTL 都在挡 |
| S4-6 **并发 2 个请求**（源 A 可用） | **113** | 两个并发各自扫 dist ⇒ **56×2**（无 in-flight 合并；行情请求被 `quoteInflight` 合成 1 次） |
| S4-7 **大盘页开着：每 10s 一轮，30 轮/5 分钟** | **310** | 每轮 `57,1,1,1,1,1` 循环 ⇒ **62 次/分**，其中 56 次/分是全量扫描 |
| S4-8 源 A 缺失 + 每 10s 一轮，12 轮/2 分钟 | **180** | `113,1,1,1,1,1,57,…` ⇒ **90 次/分** |

> S4-7 与 S7-4 测的是同一件事、窗口不同（含暖机那一轮）：稳态都是 **每 60s 一次 56 页全量扫描**，
> 因此 5 分钟窗口测得 62 次/分、2 分钟窗口测得 104 次/分；差别来自暖机轮与每轮那 1–3 次行情请求，
> 以及 10s 步进对 `now - asOf < 60s` 边界的取整。**可复现的主结论：扫描频率 1 次/分钟、每次 56 个上游请求。**

**重复拉取的硬证据（S4-4 的原始日志）**：

```
clist 请求 = 112 ，唯一 URL = 56 ，每个唯一 URL 的次数分布 = {2: 56}
样例：https://push2delay.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2
      &fid=f3&fs=m%3A0%2Bt%3A6,m%3A0%2Bt%3A80,m%3A1%2Bt%3A2,m%3A1%2Bt%3A23&fields=f3,f12
```

两条链路调用的是**同一个** `em.fetchClistPctPage`（`em.ts:2098`），因此 URL **字节级相同**：
`resolveBreadthCount`（源 B，`routes.ts:457`）扫一遍求涨跌家数，`distributionSnapshot`（`routes.ts:57`）再扫一遍求直方图。

**burst 画像**（S8，人工 100ms 上游延迟，墙钟用 `hrtime` 绕过钉死时钟）：

| 场景 | 请求 | 并发峰值 | 墙钟 |
|---|---|---|---|
| 源 A 可用（只有 dist 扫描） | 57 | **1（串行）** | **5.9 s** |
| 源 A 缺失（源 B + dist） | 113 | **4**（源 B 的 4 路池 `breadthCount.ts:14`） | **7.4 s** |

⇒ 分布扫描是**串行**的 56 次请求（真实上游 100–300ms/次时 ≈6–20 s 才能出图），
源 B 是 4 路并发。两者都远低于上游限流常见的"每秒几十次"门槛，但**总量**是每分钟 56 次。

### 2.5 护盘采样（`/rescue` 的宿主侧开销，7 通道 = 6 宽基 ETF + 上证指数）

| 场景 | 上游请求 | 构成 |
|---|---|---|
| S5-1 冷启动 1 拍 | **16**（等后台跑完 = **31**） | 6×`trends2` + 6×`fflow/kline` + 1 快照 + 6 EM 日线基准 + 6 腾讯日线 + 6 新浪 1023 根 |
| S5-3 盘中 4 拍（每 30s，共 2 分钟） | **46**（每拍 `16,8,10,12`） | ≈23 次/分；稳态由"分钟序列 60s 刷新 = 6 通道 × 2"主导 |
| S5-4 `ensureFresh` 连续两次 | **16 → 0** | 冷却/新鲜度守卫生效，不会叠加采样 |
| S5-5 `?force=1` 两次（相隔 1s） | **16 → 8** | 强制刷新会重打分钟序列 |

### 2.6 「一次页面打开」的聚合成本

| 场景 | 上游请求 | 构成 |
|---|---|---|
| S7-1 自选/持仓页首屏（10 标的） | **31** | 1 行情 + 10 东财分时 + **20 腾讯 K 线（2/标的：`/ytd` fqt=1 + `/tones`,`/anomaly` fqt=0）** |
| S7-2 页面开着：每 10s 一轮 + 60s 徽标 + 90s 迷你分时 | 每轮 `1,1,1,1,1,2` | ≈13 次/分 |
| S7-3 大盘页首屏 | **78** | 56 分布 + 8 行业榜页 + 10 行业名 + 1 板块榜 + 2 行情 + 1 腾讯兜底 |
| S7-4 **大盘页开着：2 分钟** | **208** | 每 10s `3`，每 60s `59`（56 分布重扫） ⇒ ≈**104 次/分** |
| S7-5 详情抽屉首开（单标的） | **14** | 8 行业榜页 + 2 K 线（fqt=1/fqt=0）+ 2 行情 + 1 个股快照 + 1 分时 |
| S7-6 抽屉切页签（分时→五日→日K→周K→月K→年K→回日K） | **7** | 分时 1 + 五日 1 + K 线 5（含一次增量；月→年 0） |
| S9 财经日历 `/calendar` 连打 | 首次 **2**，6h 内 **0**，过 6h 再 **2** | 4 个源各 1 次（宏观源最多 `MACRO_PAGE_CAP=26` 页，`calendar.ts:30,269`）；失败冷却 5min |

### 2.7 故障实弹（把东财三台主机注入"连接被立刻关闭"）

| 场景 | 真正打到上游的尝试 | 熔断器状态 |
|---|---|---|
| S6-1 第 1 次 `/breadth?dist=1` | **12 次东财**（6×push2delay + 6×push2）+ 1 腾讯 | 两台在本次调用内 `trips=1` 打开（120s） |
| S6-2 连续 3 次 `/breadth?dist=1` | `13, 1, 1` ⇒ **东财只在第 1 次打了 12 次**，后两次东财 0 次 | 保持一致；后两次只有腾讯兜底 1 次 |
| **S6-3 40 分钟故障 + 大盘页每 10s 轮询（240 次调用）** | **268 次总请求**；其中东财**恰好 28 次 = 0.7 次/分**（t=0 的 12 次 + 第 2/6/14/29 分钟各 4 次），其余 240 次全是腾讯兜底（每调用 1 次） | **`trips=5`**（与现网 3080 当时完全一致）；探针落在 2/6/14/29 分钟 ⇒ **与退避序列 120s/240s/480s/900s 逐一吻合** |
| S6-4 全源全挂时 `fetchKline` 连打 3 次（间隔 5s） | `7, 0, 0` | **熔断器全程未参与**（K 线走 `fetchFromHost`，不记账） |
| S6-5 同上但间隔 150s，共 5 次 | `7, 0, 0, 0, 0` | 负缓存是"失败结果也进 ttlCache"：full 键 3600s ⇒ **一小时内不再试** |
| S6-6 东财全挂时一次批量行情（3 标的） | **5** | 4 东财（2 主机 × 2 次）+ 1 腾讯 |
| S6-9 东财全挂时单日分时连打 6 次 | `7,7,7,1,1,1` ⇒ **东财 18 次后归零** | 第 3 次调用打开三台熔断器，之后只剩腾讯兜底 1 次/调用 |
| S6-7 东财全挂时护盘采样 1 拍（含后台） | **63** | 东财部分被熔断器截断，多出来的量落在腾讯/新浪兜底（它们不受熔断保护） |

### 2.8 现网旁证（只读，未触碰用户的 3080 服务）

- **`/tradewatcher/health`**（15:00 与 15:10 两次读取，`curl` 只读）：
  三台东财行情主机全部熔断中；`push2delay`/`push2` 的 `trips` **5 → 6**、`push2his` 3 → 4，
  `lastError` 均为 `fetch failed`，`until` 从 15:09 推到 15:19。
  按退避序列（2/4/8/15/15 分钟）反推：**上一次成功调用 ≈14:20**，与 `dsh web` 进程启动时间 14:19:34 吻合；
  也就是说 40 分钟里我们只促成了 5–6 次"熔断开合"，**每次开合最多 4 次 HTTP 尝试**。
- **数据文件 mtime**（只读 `ls`）：`klines/` 在 14:19:50-51 写入后到 15:00 未再变化
  ⇒ K 线路径在故障期间**没有反复回源**（被 3600s/120s 负缓存挡住）。
- **`rescue-log.json`**：`days['2026-10-12'].samples = 371`（今日已采样 371 拍）；
  采样器每拍至少 1 次东财快照 + 每分钟 12 次分钟序列 ⇒ 约 **14 次/分钟**的固定东财量。
- **另一路真实数据的独立样本**（别的审计实例 14:58:56–15:01:46 的真实 `fetch` 日志）：
  118 次上游请求，其中**东财 52 次 = 18.4 次/分**；
  时间线显示 **3.8 秒内 46 次东财请求（冷启动突发）→ 随后 159 秒静默**（熔断冷却）**→ 6 次探针**。
  这条独立证据同时给出"突发有多猛（≈12 次/秒）"和"熔断器确实在压（≈2.6 分钟零请求）"。

### 2.9 复跑校验（成稿后重跑，数字未变）

| 断言 | 首测 | 复跑 |
|---|---|---|
| 源 A 缺失的 `/breadth?dist=1` = 113（56 URL ×2） | 113 / 分布 `{2: 56}` | **113 / `{2: 56}`** |
| 并发 8 同 secid 单日分时 = 8 | 8 | **8** |
| 自选页首屏（10 标的）= 31 | 31 | **31** |
| 40 分钟故障东财尝试 = 28 | 28 | **28（12 + 4×4）** |

### 2.10 合起来看：我们的东财请求量级

| 状态 | 东财请求/分钟 | 说明 |
|---|---|---|
| 无 UI、仅后台采样器（现网实测） | **≈18** | 另一实例 2.8 分钟样本 |
| 自选页开着（10 标的），不计护盘采样器 | **≈13**（行情 6/分 + 迷你分时 6.7/分） | 实测 S7-2；行情 1 次/10s、迷你分时 10 次/90s |
| 大盘页开着 | **≈62**（分布扫描 56 主导，源 A 缺失时 ≈90） | 实测 S4-7 / S4-8 |
| 冷启动/首屏那一刻 | **3.8 秒 46 次 ≈ 12 次/秒** | 另一实例真实日志 |
| 东财不可达期间 | **≈0.7**（熔断器接管） | 实测 S6-3（40 分钟 28 次） |

---

## 3. 判定：是否存在「重复拉取放大熔断」

### 3.1 存在（支持）—— 但都是"同一次调用/同一分钟内的重复"，不是"失败后无限重试"

| 触发放大的路径 | 位置 | 复现 | 量级 | 性质 |
|---|---|---|---|---|
| 源 B 与涨跌分布各扫同一份 56 页 | `breadthCount.ts:355` + `routes.ts:50,57`（同一 `em.ts:2098`） | S4-4 | 一次调用 **112 次**（56 URL ×2） | **真重复**（同键同数据） |
| 并发调用不合并：dist 扫描与源 B 扫描都无 in-flight 合并 | `routes.ts:48/80`、`breadthCount.ts:520` | S4-6 | 并发 2 → **56×2** | **真重复** |
| 60s 到期即整段重扫（页面开着时循环） | `routes.ts:37`、`breadthCount.ts:18` | S4-7/S4-8 | **56–112 次/分钟** | 半重复（刷新语义，但 56 页整段重扫代价过高） |
| 分时同键并发不合并 | `em.ts:1014-1063`（不走 `ttlCache`） | S2-3 | 并发 8 → **8 次** | **真重复** |
| 行情批次部分丢码触发整批重试 | `em.ts:538` | S1-5 | 每轮 ×2 | 半重复（有意义的兜底，但成本翻倍） |
| 行业榜为查 1 个板块拉 8 页 | `em.ts:2228-2240` | S7-3/S7-5 | 每个"首屏" **+8** | 真重复（数据面过宽） |
| `fqt=0/1` 各一份全量 K 线 | `em.ts:2061`、`em.ts:1628` | S3-2、`klines/` 成对 | 首屏 **2×标的数** | **必要重复**（数据不同） |

### 3.2 不存在（反对）—— 熔断器与负缓存把"持续重复"挡住了，且有实测

1. **熔断器在故障期间把东财请求压到 ≈0**：S6-2（3 次调用只有第 1 次打 12 次）、
   S6-3（40 分钟 240 次调用 ⇒ 东财 ≈28 次尝试）、S6-9（分时 6 次调用 ⇒ 东财 18 次后归零）。
2. **顺序与现场一致**：S6-3 结束时 `trips=5`，与现网 3080 服务 15:00 实测的 `trips=5` **数字相同**
   —— 同一套逻辑、同一个量级，不是巧合式吻合。
3. **K 线路径有很强的负缓存**：S6-4/S6-5 显示失败后 2 分钟～1 小时不再回源（`em.ts:2062`）。
4. **现网 K 线缓存文件在 14:19:51 后 40 分钟未变**（`ls --time-style`），说明故障期间没有反复拉 K 线。
5. **真实日志里的 159 秒静默**（另一实例 3.8 s 突发 → 159 s 零请求 → 探针）是熔断在真实网络上的直接体现。
6. **`/rescue`、`/calendar` 都有单飞或冷却**：`tickFlight`（`rescue.ts:1109`）、`ensureFresh` 20s 冷却（`rescue.ts:1861`）、
   `syncing` 单飞 + 5 分钟失败冷却（`calendar.ts:486,19`）；实测都是"第二次 0 请求"。

### 3.3 因果边界（**不许**下的结论）

- **上游的限流/熔断阈值我们拿不到**：东财不公开 QPS 阈值；本次故障里也没有抓到 `429`/`Retry-After`
  这类"你被限流了"的直接证据（实测的失败形态是连接被立刻关闭：`fetch failed`、耗时 <300ms，`em.ts:149-151` 的判据）。
  ⇒ **无法从本机证明"是我们把上游打挂的"**，本报告不做这个断言。
- 能给的只是**量级与时间线对照**：故障期间我们 ≈0.7 次/分钟；故障之前/页面开着时 ≈13–104 次/分钟，
  突发 ≈12 次/秒（3.8 秒 46 次）。这些数字是否超过上游阈值，**没有证据**。
- 另一类无法排除的因素：用户侧还有别的客户端（浏览器直连东财？其它应用？），以及上游自身故障 ——
  这三者本报告都无法观测。

---

## 4. 问题清单（按性价比排序）

分类标签：`真重复` = 同键同数据多拉；`缓存键` = 键设计导致多拉；`缺合并` = 缺 in-flight 合并；`缺退避` = 失败后无负缓存。

### P0-1 分时（`/trend`）并发不合并 ⇒ 同一份数据被并发打 N 次（`缺合并`）

- **现象**：8 个并发调用同一 `secid` 的单日分时 ⇒ **8 次上游请求**（实测 S2-3）。
  客户端有三条互不共享缓存的分时消费者（`mini.ts` 90s、`chartCache` 30s、`MarketPage.openDetail` 无缓存），
  行情条 + 抽屉 + 大盘页滚动时会撞在一起。
- **位置**：`em.ts:1007-1063`（`peekCache` + 手动 `cache.set`，**没有**走 `ttlCache` 的 `inflight` 合并 `em.ts:49-67`）。
- **影响**：同 secid 并发 N ⇒ N 次上游（实测 N=8 → 8 次）；故障期若恰好并发，会集中在同一瞬间。
- **修法（最小改动）**：把 `trendWithFallbackRaw` 的"回源那一段"套进 `ttlCache`（或给它单独一个 `inflight: Map<string, Promise>`），
  键沿用 `trend:<secid>:<ndays>`；注意 LKG 分支的 `grace: 0` 语义别被吞掉。
- **风险**：中 —— 分时的 TTL 语义较细（上游 60s / LKG 20s / 定稿 300s / peek 宽限 45s），
  合并必须只合并"同一份 loader 在飞"，不能把 LKG 结果合并给上游等待者；改完用 `trend-fallback.test.ts` + 本报告 S2-3 复现验证。

### P0-2 `/breadth` 同一份 clist 被扫两遍（`真重复`）

- **现象**：源 A 缺失时一次调用 = **113 次上游**，其中 112 次落在 **56 个字节级相同的 URL**（每个 2 遍，实测 S4-4）。
- **位置**：`routes.ts:50-82`（分布扫描）与 `routes.ts:452-459` + `breadthCount.ts:355-444`（源 B 全量分页），
  两者都调 `em.fetchClistPctPage`（`em.ts:2098`，**函数内无任何缓存**）。
- **影响**：每次调用多 56 次上游；60s 一轮 ⇒ **56 次/分钟**的纯重复。
- **修法（最小改动）**：给 `fetchClistPctPage` 加一层按 `(pn,pz)` 的短 TTL 缓存（例如 15–30s，值 `CountPage`），
  一次调用内两遍自然共享；或让 `distributionSnapshot` 直接复用 `resolveBreadthCount` 已扫的页（把页数组从源 B 返回上来）。
  前者改动更小、不动算法与红线（不变量检查仍在）。
- **风险**：低–中 —— 缓存窗口要 < 60s（分布直方图的口径是"同一时刻全市场"），
  且 `sanityOfCounts` 的"顺序不变量"依赖同一轮数据；同轮共享反而更符合不变量（同一快照）。
  需要一条新断言：同一轮两遍调用只发 N 次上游。

### P1-1 涨跌家数源 B 失败无负缓存（`缺退避`）

- **现象**：`BreadthCountCache` **只缓存成功**（`breadthCount.ts:452-465`）；失败时 `resolveBreadthCount` 直接返回失败
  （`breadthCount.ts:544-550`）且不写缓存 ⇒ **每次 `/breadth` 调用都会重跑一遍 56 页循环**。
- **位置**：`breadthCount.ts:520-528`（`set` 只在成功分支）。
- **影响**：故障期间每次调用白跑 56 次循环（**网络流量为 0**，因为 `fetchAny` 被熔断快速失败；
  代价是 CPU + 每次调用都去抢半开探针名额）。**在"半开"瞬间会让一次低价值的页请求把探针名额吃掉**。
- **修法**：把失败结果也写进同一个缓存槽（带 60–120s 短 TTL 与 `reason`），或让 `resolveBreadthCount` 在
  `hostsUnavailable(QUOTE_HOSTS)` 为真时直接短路（`em.ts:521` 已有现成判定）。
- **风险**：低 —— 但注意别让"负缓存"把恢复后的第一次请求也挡掉；建议 TTL ≤60s 且带原因字符串。

### P1-2 分布扫描串行 56 次、页数上限写死 60（`真重复` 的延迟面）

- **现象**：`distributionSnapshot` 串行 56 次（实测并发峰值 = 1，100ms 延迟下墙钟 5.9 s；真实上游 ≈6–20 s）。
- **位置**：`routes.ts:55-66`。
- **影响**：大盘页首屏被这一段时间绑住；期间若客户端又触发一次（10s 轮询 + 扫描 > 10s）⇒ **扫描重叠**（无合并）。
- **修法**：与 P0-2 合并成"一轮扫描只做一次、结果共享"；或给小并发（如 4，与源 B 一致）。
- **风险**：低；顺带把 `BREADTH_PAGES_MAX` 与 `em.ts` 的 100/页 上限做个一致性断言（现在两边各自写死）。

### P1-3 K 线路径绕开熔断器（`缺退避` 的镜像问题）

- **现象**：`requestKlineRaw`（`em.ts:1832-1862`）用 `fetchFromHost` 直连，**不进熔断器、不记失败**：
  实测全源全挂时一次 miss = **7 次尝试**（1 腾讯 + 2 轮 × 3 台东财，含 500ms 睡眠）。
- **位置**：`em.ts:1825-1866`（对比 `fetchAny` `em.ts:113` 的保护）。
- **影响**：① 故障期 K 线风暴不会让熔断器"看见"，与行情链路的熔断状态脱节；
  ② 好处是失败被 ttlCache 负缓存吸收（`em.ts:2062`），所以不构成持续放大。
- **修法**：把 `requestKlineRaw` 的东财部分改为 `fetchAny(HISTORY_HOSTS, path)` + 保留腾讯优先；
  或至少给 `fetchFromHost` 加"失败记账"（`noteUpstreamFailure('kline')` 已有，但只是给 `missing.why` 用）。
- **风险**：中 —— `fetchAny` 的重试/截止语义与现在不同（现在 2 轮×3 台、每台 9s 超时；`fetchAny` 是 2 轮×每台 2 次 + 9s 总截止），
  会改变"多久拿到 K 线"的表现；必须先确认不会让腾讯优先的兜底逻辑退化。

### P2-1 行业榜为 1 个板块拉 8 页（`真重复`）

- **现象**：`industryBoardPctMap`（`em.ts:2228-2240`）在"查 1 个板块涨跌幅"时也会翻页到 8 页（实测抽屉首开 +8 次上游，S7-5）。
- **位置**：`em.ts:2228`（`pn ≤ 8` 循环）+ `em.ts:2273`（`fetchIndustryOf` 也走全量 overview）。
- **影响**：每个首屏 +8 次上游；只在"该 secid 的行业名缓存过期（10 分钟）"时发生。
- **修法**：`fetchIndustryOf`（单只）不必翻全榜 —— 用 `f127` 拿到行业名后，只在榜里**定位**该板块（按名字二分/或改用板块代码接口）；
  或把榜页缓存 TTL 从 30s 提到与"行业归属 10 分钟"同档。
- **风险**：低 —— 涨跌幅会随之变旧（板块当日涨幅每秒都在动），所以更稳的改法是"只定位不翻页"。

### P2-2 `trend` 的 peek 宽限让"60s TTL"实际 ≈105s（`缓存键` / 文档一致性）

- **现象**：`peekCache(key, 45_000)`（`em.ts:1015`）+ 上游值 `exp = now+60s`（`em.ts:1061`）⇒ 数据最坏可陈旧 105s，
  而界面用它算"新鲜度"。（代码注释只解释了 LKG 分支的 `grace: 0`，没写这个 45s 宽限对上游值的影响。）
- **位置**：`em.ts:41-46`（`grace` 语义）、`em.ts:1015`、`em.ts:1061`。
- **影响**：不是请求放大（反而更省），是**口径一致性**问题：`/trend` 的 `asOf` 与"多少秒前的数据"可能被读错。
- **修法**：给上游值显式 `grace: 0`（或把 60s 写成 105s），并加断言。
- **风险**：低（会略微增加回源频率）。

### P2-3 行情缺口重试让每轮成本 ×2（`真重复` 的边界情形）

- **现象**：`rawQuotes` 对"未回包的标的"再跑一轮（`em.ts:538`），实测混入 1 个上游不回标的 ⇒ 2 次东财 + 1 次兜底（S1-5）。
- **位置**：`em.ts:536-563`。
- **影响**：上游只回部分标的（限流时的常见表现）时，**每轮行情请求都翻倍**。
- **修法**：第二轮改为"短延迟后只试一次单主机"，或仅当缺口比例 > 阈值时才重试。
- **风险**：低 —— 缺口不给第二次机会会更容易整行落 LKG（有 10 分钟旧值可服务）。

---

## 5. 未做 / 不可知

| 未做或不可知的事 | 原因 | 若要做需要什么 |
|---|---|---|
| 上游（东财）的限流阈值、是否对我们限流 | 无公开阈值；本次故障未抓到 `429`/`Retry-After` 证据 | 需要上游侧证据（`429`、`Retry-After`、限流页）或长周期实验 |
| "是我们打挂的"这类因果结论 | 无法从本机证明（见 §3.3） | 需要在故障前/故障中的完整请求时间线 + 上游日志 |
| 真实网络下"每次请求的 HTTP 尝试数" | 审计期间东财 clist 整段不可达，不宜反复实测 | 在健康时段用 `record` 模式跑一遍 §2 的场景 |
| 容器/代理层（`verge-mihomo` 代理）对失败形态的影响 | 本机有代理进程（`ps` 可见），未验证是否参与连接重置 | 关代理/换出口对照实验 |
| 其它客户端（浏览器直连东财）对同一 IP 的请求量 | 无法观测 | 抓包/网关日志 |
| 单机的三份进程（用户 3080 + 审计临时实例）各自贡献量 | 临时实例是并发运行的，未做严格隔离计时 | 停机对照 |
| `/calendar` 宏观源真实页数（上限 26 页） | fixture 只覆盖首屏 | 健康时段实测 |

---

## 6. 审计自身的副作用与修复（必须披露）

**偏差**：本节所有场景在**最初两条命令**里没有设置 `DSH_HOME`，于是 `dataHome()`（`store.ts:175-180`）落到了
真实的 `/home/hu/.dsh/dsh-tradewatcher`，把 fixture 里的**合成**数据写进了用户的数据目录。

**被写到的文件（已按内容签名逐个核验并修复）**：

| 文件 | 我写的签名 | 处理 |
|---|---|---|
| `klines/1.600519_101_0.json`（1067 根，min=8.07） | 合成 bar 与真实 bar 按日期 merge（min 价 10 元级） | **删除**（下次访问自动回源重建） |
| `klines/1.600519_101_1.json`（910 根，min=10） | 同上 | **删除** |
| `klines/1.600519_102_1.json`（800 根，min=8.15） | 同上 | **删除** |
| `klines/1.600519_103_1.json`（600 根，min=8.51） | 同上 | **删除** |
| `trends/1.600519/{2026-10-09..12}.json` | 分时价 ≈10 元（真实茅台 ≈1250–1500） | **删除**（宁可显示"归档缺口"也不留编造的分时） |
| `trends-lkg.json` 的 `1.600519|1` / `1.600519|5` 两条 | 同上 | **外科式删除**（临时的 `tmp` + `rename`，其余 65 个 secid 条目未动） |
| `quotes-lkg.json` 中 5 个标的的行 | 合成价（如 600519=1500.0） | **无需处理**：用户服务下一次落盘已用真实值覆盖（15:03 核验：600519=1278.25，source=tencent） |
| 其它顶层文件（`watch/positions/ledger/prefs/calendar/board-lkg/rescue-log`） | **未触碰** | 只读 |

**修好之后**：后续所有场景一律 `DSH_HOME=/tmp/audit/home-*`（`run.sh` 里 `rm -rf` 后重建），
上表 9 个文件之外**再无写入**；本文档是唯一落在仓库里的产物。

**另外**：审计期间另外两个进程也在写同一个数据目录（用户的 `dsh web` 与另一条审计用的临时实例），
所以上面只列"按内容签名能 100% 归因到我"的文件；时间上重叠但签名不符的（如 `0.000858_101_1.json`、`1.601288_101_1.json`）没有动。

---

## 7. 复现命令（全部只读 + `/tmp`）

```bash
# 0) 现场证据（只读，不触碰用户服务）
curl -s -m 5 "http://127.0.0.1:3080/tradewatcher/health" -H "Origin: http://127.0.0.1:3080" \
  | python3 -m json.tool | head -40                     # 熔断 trips/until/lastError
ps -eo pid,lstart,etime,args | grep "dsh web" | grep -v grep   # 进程启动时间（用于反推熔断时间线）
ls -la --time-style=+%F_%T ~/.dsh/dsh-tradewatcher/klines | head   # 缓存文件 mtime

# 1) 计数与场景（无真实网络；shape 忠实的合成 fixture）
node /tmp/audit/genfixtures.mjs                              # 生成 fixture
bash /tmp/audit/run.sh replay /tmp/audit/sc-quotes.mts cold
bash /tmp/audit/run.sh replay /tmp/audit/sc-trend.mts single-concurrent
bash /tmp/audit/run.sh replay /tmp/audit/sc-kline.mts lmt
TW_AUDIT_STRIP=f104,f105,f106 bash /tmp/audit/run.sh replay /tmp/audit/sc-breadth.mts sourceB
TW_AUDIT_STRIP=f104,f105,f106 bash /tmp/audit/run.sh replay /tmp/audit/sc-breadth.mts ttl-sweep-sourceB
bash /tmp/audit/run.sh replay /tmp/audit/sc-rescue.mts one
bash /tmp/audit/run.sh replay /tmp/audit/sc-page.mts market-steady
TW_AUDIT_DELAY_MS=100 bash /tmp/audit/run.sh replay /tmp/audit/sc-burst.mts A

# 2) 故障实弹（东财三台注入 "fetch failed"，备用源照常）
TW_AUDIT_FAIL=eastmoney.com bash /tmp/audit/run.sh fail /tmp/audit/sc-fail.mts breadth3
TW_AUDIT_FAIL=eastmoney.com bash /tmp/audit/run.sh fail /tmp/audit/sc-fail.mts outage
TW_AUDIT_FAIL=eastmoney.com,gtimg.cn,qq.com,sina bash /tmp/audit/run.sh fail /tmp/audit/sc-fail.mts trend5

# 3) 去重证据（56 个 URL 各打两遍）
python3 - <<'EOF'
import json, collections
L=[json.loads(l) for l in open('/tmp/audit/fetch-replay-sc-breadth-sourceB.jsonl')]
cl=[e['url'] for e in L if 'clist' in e['path']]
c=collections.Counter(cl)
print('clist 请求 =', len(cl), '唯一 URL =', len(c), '次数分布 =', collections.Counter(c.values()))
EOF
```

脚本清单（都在 `/tmp/audit/`，不改仓库）：
`intercept.mjs`（fetch 拦截 + 时钟钉死 + 故障注入 + in-flight 峰值统计）、
`genfixtures.mjs`（合成 fixture）、`lib.mjs`（假 req/res + 报告）、`run.sh`（隔离运行器）、
`sc-quotes / sc-trend / sc-kline / sc-breadth / sc-rescue / sc-page / sc-burst / sc-fail / sc-cal.mts`。
