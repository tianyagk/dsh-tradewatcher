> **历史快照**：本文记录的是当时（见下方正文）的用例数 / 上游读数 / 命令回包，**不代表现状**；现状以 `README.md` 与代码为准。

# AUDIT-IMPL70 —— 上游不可达时的降级语义 / 来源优先级 / 日志噪声（实现报告）

- 基线：`main` @ `5ee0532`（v0.103.0，`npm run check` **759 用例/时区 × 2** + 构建 73 项）。
- 本轮用例：**759 → 775**（本批新增 `src/host/degrade.test.ts` 10 例；另 6 例来自并行的 AUDIT-IMPL69 的 `usAggregate.test.ts`）。
- 用户输入：真实运行日志（见 §0），三条抱怨分别对应本文 §1 / §2 / §3。
- 纪律：未 commit；未装、未动 profile、**未重启 `dsh web`**；`build.mjs` **零改动**；
  实验全部 `/tmp`（`DSH_HOME=/tmp/deg-*`）；未手工写 `~/.dsh`；报价链**未**接 `robotsGate`
  （沿用 `docs/DECISIONS.md` 的显式豁免，且未把豁免扩大到正文/归档）。

---

## 0. 用户日志 → 结论映射

```
[tradewatcher] upstream failed push2delay.eastmoney.com/push2.eastmoney.com TypeError: fetch failed
[tradewatcher] quotes batch failed pass 1 12 symbols TypeError: fetch failed
[tradewatcher] quotes batch failed pass 1 26 symbols Error: 上游暂时不可用（熔断中，约 2 分钟后自动重试）
[tradewatcher] route error (503): 上游暂时不可用（熔断中，约 2 分钟后自动重试）      ← 反复出现
[tradewatcher] 降级采用 K 线缓存: …/klines/xxx.json 未完成 bar 已超过 60s TTL ⇒ 回源重取；但…  ← 每标的一行
```

| 现象 | 真因 | 改法 |
|---|---|---|
| 整条路由 503 | 逐标的路由把**上游异常原样抛出**，`fail()` 再把 `熔断/上游暂时不可用` 映射成 503（`http.ts:12` 的 `UPSTREAM_RE`）。详情/行业归属只有东财一个上游 ⇒ 东财一挂就整块报错 | 逐标 + 批量路由改成 **200 + 逐标 `missing[]`**；只有聚合路由才可能 5xx，且消息点名「上游 × 范围」 |
| 每拍先失败一次再兜底 | 取数顺序是**东财优先**（`loadQuotes` 先 `rawQuotes`），而本机东财长期 `UND_ERR_SOCKET` | **腾讯 → 新浪 → 东财（兜底）**；东财独占字段的调用方显式 `emFields` 提前 |
| 几十行刷屏 | 三条 `console.warn` 全是**逐标的/逐轮**打印 | 进聚合桶：同轮 N 只 ⇒ **1 行**汇总 + 样例，逐标明细降 `debug`（`TW_DEBUG=1`） |

---

## 1. P0：单个上游挂掉不得让整条路由变 503

### 1.1 判据（写死在 `routes.ts:291` 的 `fail()` 与 `:313` 的 `replyBatch()`）

1. **只要还有一个标的取到，就必须 200**（`degrade.ts:321` 的 `partialOutcomeOf`）。
2. 每个取不到的标的必须给**逐标原因**：`missingReasons[]`（`{what, why, note}`），
   `why` 只用 `transient`（等上游恢复）与 `no-source`（结构性没有）两档。
3. **只有全部来源对全部标的都失败**才允许 5xx；此时用 `degrade.ts:334` 的 `TotalUpstreamError`，
   它的构造器**强制**消息里同时出现「哪个上游」与「哪个范围」，缺一个就写不出来。

### 1.2 逐路由改动（`src/host/routes.ts`）

| 路由 | 旧行为 | 新行为 |
|---|---|---|
| `/detail`（`:1033`） | 东财抛错 ⇒ **503 + retry-after**（旧注释明确写着"保持原有语义"） | **200** + `detail: null` + `missing[0]`（点名"详情只有东财一个上游 + 本次不可达 + 真实错误"） |
| `/industry`（`:998`） | 同上 ⇒ 503 | **200** + `industry: null` + 逐标原因 |
| `/industries`（`:954`） | 部分丢码时静默返回 `{}`（**没有原因**）；抛错时 503 | **200** + `partial{requested,succeeded,failed}` + 逐标 `missing[]` |
| `/quotes`（`:859`） | `missing` 只有 **id 列表**，没有原因 | 保留 `missing: string[]`（客户端既有契约），**新增** `missingReasons[]` |
| `/board`（`:1106`） | 抛错 ⇒ 503，消息是裸的"上游暂时不可用" | 有备用源（腾讯板块/新浪 ETF/LKG）就 200；真 503 时点名「东财 × 板块榜单 × 真实原因」 |
| `/health`（`:345`） | 只有熔断摘要 | 增加 `upstream`（§5） |

> `missing` 保持 `string[]` 是**故意的**：`client/api.ts` 的 `quotes()` 已经把 `missing` 当 id 列表用，
> 改形状会让界面渲染出 `[object Object]`。语义清楚的**加法**优于破坏性改名。

### 1.3 实测（本机，东财 `UND_ERR_SOCKET`、腾讯/新浪真实可达）

命令（打桩只拦东财，其余走真实上游）：

```
node --experimental-strip-types /tmp/deg-probe/routes-probe.mts
```

改动前 21 条路由里 **2 条 503**：

```
/tradewatcher/detail      503  上游暂时不可用（熔断中，约 2 分钟后自动重试）
/tradewatcher/industry    503  上游暂时不可用（熔断中，约 2 分钟后自动重试）
```

改动后同一脚本 **0 条 5xx**，两条都变成 200 + 原因：

```
/tradewatcher/detail      200  missing=[{what:"1.600519",why:"transient",
                                note:"…详情（开高低收/量额/市值）只有东财一个上游；…（上游暂时不可用（熔断中…））"}]
/tradewatcher/industry    200  missing=[{what:"1.600519",why:"transient",
                                note:"行业板块未取到：行业归属只有东财一个上游，而东财本次不可达（…）"}]
```

---

## 2. P1：来源优先级反了 —— 东财降为兜底

### 2.1 「品种 × 来源」覆盖矩阵（实测）

命令（映射直接 `import` 插件源码，避免抄第二份表；每一格都真的打了一次上游）：

```
node --experimental-strip-types /tmp/deg-probe/matrix2.mts
```

| 品种 | secid | 东财 push2delay/push2 | 腾讯 qt.gtimg.cn | 新浪 hq.sinajs.cn |
|---|---|---|---|---|
| A股-个股 贵州茅台 | `1.600519` | ✗ UND_ERR_SOCKET | ✓ 1329 | —（无映射） |
| A股-指数 上证指数 | `1.000001` | ✗ UND_ERR_SOCKET | ✓ 3716.28 | —（无映射） |
| A股-ETF 沪深300ETF | `1.510300` | ✗ UND_ERR_SOCKET | ✓ 4.236 | —（无映射） |
| 深市-指数 深证成指 | `0.399001` | ✗ UND_ERR_SOCKET | ✓ 11802.46 | —（无映射） |
| 港股-个股 腾讯控股 | `116.00700` | ✗ UND_ERR_SOCKET | ✓ 417.8 | —（无映射） |
| 港股-ETF 盈富基金 | `116.02800` | ✗ UND_ERR_SOCKET | ✓ 24.82 | —（无映射） |
| 国际指数 标普500 | `100.SPX` | ✗ UND_ERR_SOCKET | ✓ 7659.44 | —（无映射） |
| 国际指数 纳斯达克 | `100.NDX` | ✗ UND_ERR_SOCKET | ✓ 29187.55 | —（无映射） |
| 国际指数 道指 | `100.DJI` | ✗ UND_ERR_SOCKET | ✓ 52002.41 | —（无映射） |
| 国际指数 恒生指数 | `100.HSI` | ✗ UND_ERR_SOCKET | ✓ 24186.83 | —（无映射） |
| 国际指数 日经225 | `100.N225` | ✗ UND_ERR_SOCKET | —（无映射） | —（无映射） |
| 国际指数 韩国KOSPI200 | `100.KOSPI200` | ✗ UND_ERR_SOCKET | —（无映射） | —（无映射） |
| 国际指数 法国CAC40 | `100.FCHI` | ✗ UND_ERR_SOCKET | —（无映射） | —（无映射） |
| 国际指数 德国DAX30 | `100.GDAXI` | ✗ UND_ERR_SOCKET | —（无映射） | —（无映射） |
| 美股 苹果 | `105.AAPL` | ✗ UND_ERR_SOCKET | ✓ 343.46 | ✓ 343.46 |
| 美股 Frontline | `106.FRO` | ✗ UND_ERR_SOCKET | ✓ 52.49 | ✓ 52.49 |
| 美股 VIXY | `107.VIXY` | ✗ UND_ERR_SOCKET | ✓ 17.73 | ✓ 17.73 |
| 国内期货 螺纹钢主连 | `113.rbm` | ✗ UND_ERR_SOCKET | —（无映射） | ✓ 3086（`nf_RB0`） |
| 国内期货 生猪主连 | `114.lhm` | ✗ UND_ERR_SOCKET | —（无映射） | ✓ 10490（`nf_LH0`） |
| 外盘商品 COMEX铜 | `101.HG00Y` | ✗ UND_ERR_SOCKET | —（无映射） | ✓ 656.029（`hf_HG`） |
| 外盘商品 布伦特原油 | `112.B00Y` | ✗ UND_ERR_SOCKET | —（无映射） | ✓ 109.928（`hf_OIL`） |
| 贵金属 伦敦金现 | `122.XAU` | ✗ UND_ERR_SOCKET | —（无映射） | ✓ 4164.05（`hf_XAU`） |
| 国债指数 中国国债 | `1.000012` | ✗ UND_ERR_SOCKET | ✓ 231.52 | —（无映射） |
| 国债收益率 美国10Y | `171.US10Y` | ✗ UND_ERR_SOCKET | —（无映射） | —（无映射） |
| 国债收益率 日本10Y | `171.JP10Y` | ✗ UND_ERR_SOCKET | —（无映射） | —（无映射） |

**读法**（这张表直接决定取数顺序）：

- **腾讯**覆盖：沪深个股/指数/ETF、港股个股/ETF、国际指数里的 SPX/NDX/DJI/HSI、美股 105/106/107、国债指数。
- **新浪**覆盖：美股 `gb_*`、国内期货 `nf_*`、外盘商品与贵金属 `hf_*`。
- **只有东财覆盖**（本机实测必缺）：`171.*` 国债收益率、以及**腾讯没有映射的国际指数**
  （N225 / KOSPI200 / FCHI / FTSE / SX5E / GDAXI）。
- 预设 28 只里，腾讯/新浪能服务 **19 只**；只有 9 只必须等东财。

> 上一轮 `docs/DECISIONS.md` 里"期货/商品只有东财+新浪两路"的说法**仍然成立**，
> 但"新浪对期货/商品是空的"是**测错了代码**才会得出的结论：新浪的国内期货是 `nf_RB0`/`nf_LH0`
> （不是 `nf_rbm`），外盘商品是 `hf_HG`/`hf_OIL`。按错代码测出来的"空行"一度让我以为这三类无兜底。

### 2.2 改法（`src/host/em.ts`）

| 位置 | 内容 |
|---|---|
| `em.ts:984` | 新增 `sourceCapabilityOf(source, secid)` —— 能力表**只调用各源自己的映射函数**（`tencentQuoteCode` / `sinaSymbol`），不抄第二份表 |
| `em.ts:991` | 新增 `quoteSourcesOf(secid)`（顺序＝腾讯 → 新浪 → 东财） |
| `em.ts:1000` | 新增 `emQuotesWorthTrying()`：至少一台东财行情主机不在熔断。**纯读熔断器，不发请求** |
| `em.ts:1020` | 新增 `quoteSourcePlan(secids, { emFields })` → `{order, coverage, emOnly}` |
| `em.ts:1053` | `loadQuotes(secids, minReuseMs, opts)`：**腾讯/新浪先**（`fillFromFallbacks`），东财只对**仍无价**的标的兜底 |
| `em.ts:1682` | `hasQuoteFallback` 改为 `quoteSourcesOf(secid).length > 1` —— 判据**只此一处** |
| `em.ts:1041` | `QuoteLoadOptions.emFields`（默认 false） |

**为什么需要 `emFields`**：`f8/f10/f62/f66/f104-106`（换手率/量比/主力净额/超大单净额/涨跌家数）
**只有东财给**。若把东财无条件降到最后，健康主机上：

- 护盘评分（`rescue.ts:1406`）的 `superNet/mainNet` 会静默变成全 `null` —— "功能还在、数据没了"；
- 涨跌家数源 A（`routes.ts` 的 `/breadth`）会永久缺失，被迫每拍扫 56 页东财 clist。

所以只有这两个调用方传 `emFields: true`，东财可以被提前（且**仅在它还有主机没熔断时**）。

### 2.3 实测收益（单拍 `/quotes`，按主机计请求数）

命令：

```
node --experimental-strip-types /tmp/deg-probe/count.mts
```

```
/quotes 6 只（腾讯全覆盖）：code=200 priced=6 用时=222ms
上游请求（按主机）： {"tencent":1}            ← 东财 0 次

/quotes 8 只（6 只可被腾讯覆盖 + 2 只东财独占）：code=200 priced=6 用时=658ms
上游请求（按主机）： {"eastmoney":4}          ← 东财只为"仍缺价的 2 只"打
```

改动前同一批 8 只：`quotes batch failed pass 1 8 symbols`（东财被请求了**全部 8 只**）+ 用时 ~1.18 s。
改动后对腾讯覆盖的标的**一次东财都不发**，东财的尝试范围被收窄到"真的只有它能给的那几只"。

---

## 3. P2：日志噪声（逐标的 → 1 行汇总）

### 3.1 三处改动

| 位置 | 旧 | 新 |
|---|---|---|
| `em.ts:2231` | `console.warn('降级采用 K 线缓存:', path, reason)` —— **每标的每轮一行** | `noteDegraded('kline-cache', …)` |
| 同函数下一条 | `console.warn('跳过 K 线缓存:', …)` | `noteDegraded('kline-cache-skip', …)` |
| `em.ts:687` | `console.warn('quotes batch failed', pass, N symbols, err)` —— 一轮 3 条（`/quotes` `/ytd` `/badge`） | `noteDegraded('quotes-batch', …)`，按 pass/原因聚合 |
| `em.ts:174` / `:188` | `upstream fast-fail on …` / `upstream failed …`（每个失败轮 2 行） | `noteDegraded('em-fast-fail')` / `noteDegraded('em-upstream-failed')` |

聚合实现在 `src/host/degrade.ts`：

- `noteDegraded(kind, {label, subject, reason, detail})`（`:235`）—— 进桶，不打印；
- 窗口 `AGG_FLUSH_MS = 400`（`:208`）—— 一轮取数（实测 100–1200 ms）能收全，相邻两轮（≥ 一个轮询间隔）不会并成一行；
- `flushDegraded()`（`:271`）—— 产出 **每个 kind 一行**：

```
[tradewatcher] K 线缓存降级采用 27 个（未完成 bar 已超过 60s TTL ⇒ 回源重取 ×27）；
              样例：1.600519_101_1.json、1.000300_101_1.json、0.399001_101_1.json 等 27 个；
              明细见 debug 级（TW_DEBUG=1）
```

- 逐标的完整原因 → `console.debug`，且**只在** `TW_DEBUG=1`（或 `DEBUG` 含 `tradewatcher`）时输出
  （`debugEnabled()`，`:183`）。默认安静。

### 3.2 实测（同一份路由探针的日志行数）

```
[东财连接被立刻关闭（跳过第二轮重试）] 1 个（pass 1 整轮 TypeError: fetch failed）；样例：push2delay/push2；明细见 debug 级
[东财上游不可达] 1 个（fetch failed）；样例：push2delay/push2；明细见 debug 级
[东财行情批量失败] 1 个（pass 1（fetch failed））；样例：100.N225,171.US10Y；明细见 debug 级
```

21 条路由（≈ 十几拍）合计 **5 行**；改动前同类场景是几十行。

---

## 4. 熔断作用域：确认**按主机**，并补上"跳过 ≠ 失败"

### 4.1 结论：`withHostBreaker` 本来就是按主机

| 位置 | 事实 |
|---|---|
| `src/host/breaker.ts:109` | `const breakers = new Map<string, CircuitBreaker>()` |
| `src/host/breaker.ts:111` | `breakerFor(host)` 按主机取/建熔断器 |
| `src/host/breakerFetch.ts:35-36` | `withHostBreaker(host, run)` → `const breaker = breakerFor(host)`，**只影响这一台** |
| `src/host/em.ts:121-130` | `fetchAny(hosts, …)` 用 `hostsAllowed(hosts)` 取**仍可用的子集**，再用 `claimed` 逐台领半开探针 |

`breaker.ts` 文件尾还有一条历史注记：曾导出过单台 `push2delay` 的别名 `quoteBreaker` 被当"行情整体闸门"用，
正是"按主机隔离"要避免的语义，已删除（本批确认它没有复活）。

### 4.2 仍会"因一台挂掉而整路由 503"的**真实**原因（本批修掉）

熔断器按主机是对的，但**抛出来的错误被路由层统一映射成 503**：

- `em.ts:121` 的 `fetchAny` 在"整组都在冷却"时抛**普通 `Error`**（`上游暂时不可用（熔断中…）`）；
- `src/host/http.ts:12` 的 `UPSTREAM_RE` 命中"熔断/上游暂时不可用" ⇒ `httpStatusOf` 返回 **503**；
- 于是 `/detail`、`/industry` 这类"只有东财一个上游"的逐标路由，把**别的主机完全能给的其它数据**一起打成 503。

**改法**：熔断期间**不再把逐标路由送到 `fail()`**（见 §1.2）。`fail()` 本身也升级了：
`routes.ts:299` 在 5xx 时附上 `upstream{line,hosts}` 与 `scope`，界面/agent 能直接看到"哪台上游不行"。

### 4.3 `fetchAny` 的"跳过"记账（`em.ts:123-130`）

熔断冷却/半开探测被占时，**本轮没有发出请求**。此前这种"跳过"既不记也无从观测；
现在走 `noteHostSkipped(host, reason)`（`degrade.ts:67`），与 `noteHostFailure` **分开记** ——
否则熔断期间每个调用都会把"连续失败次数"堆高，看起来像"上游越来越坏"，
而事实是"我们一个请求都没发，上游状态未知"。

---

## 5. 可观测性：「上一次上游健康摘要」（零新增请求）

`degrade.ts:117` 的 `upstreamHealth(hosts?)` → `{ hosts[], line, anyOpen, allOpen }`，逐主机给出：

| 字段 | 含义 |
|---|---|
| `lastOkAt` / `lastFailAt` | 最后一次**成功** / **失败**时刻（epoch ms） |
| `consecutiveFails` | 连续失败次数（**自己的**计数器；熔断器的 `fails` 在跳闸瞬间被清零，当不了"连续"） |
| `open` / `minutesLeft` | 是否熔断、还剩几分钟 |
| `lastSkipAt` / `lastSkipReason` | 最近一次"没发请求"（熔断冷却 / 半开探测被占） |
| `healthy` | 最后已知状态：最近一次成功晚于最近一次失败 |

一行摘要（`degrade.ts` 的 `healthLine`）：

```
上游健康 20:15:03：qt.gtimg.cn ✓ 20:15:02 ｜ push2delay.eastmoney.com ✗ 20:14:58（连续失败 3 次，fetch failed）｜ …
```

暴露两处：`/tradewatcher/health` 的 `upstream`（`routes.ts:360`）与 5xx 回包里的 `upstream`
（`routes.ts:299`）。**零新增上游请求**：全部来自 `withHostBreaker` / `fetchAny` 已有的记账，
读摘要只是读内存（`degrade.test.ts` ⑧ 用请求计数器断言"读完请求数不变"）。
它**不复位、不探活** —— 探活会变成"看一眼就多一次请求"。

---

## 6. 断言与反例注入（`src/host/degrade.test.ts`，10 例）

上游全部**打桩**（`globalThis.fetch` 按主机分流），断言不依赖任何真实网络。

| # | 判据 | 反例注入（必败） |
|---|---|---|
| ① | 取数顺序 `['tencent','sina','em']`；能力表逐品种；`emOnly` 清单 | 顺序写回"东财优先" ⇒ `notDeepEqual` 必须判不等 |
| ② | 东财挂 + 腾讯可达 ⇒ **200** 且 A股/港股/美股**三只有价**、`sources.tencent===3` | 注入 `503` / `priced:0` / "只有一只有价" ⇒ 判据必须 false |
| ③ | 东财挂 + 只查东财独占品种 ⇒ **200** + 两条 `missingReasons`（`transient` + "只有东财一个行情源" + "等东财恢复"）；`missing`（id）与 `missingReasons` 覆盖同一批 | 注入 `503`；注入 `why:'no-source'`（把"等它恢复"说成"重试无效"）⇒ 必须 false |
| ④ | 全源关闭 ⇒ 每标的 `missing`，且**没有任何 0 价/编价**（`price` 必须是 null） | 注入 `price:0`；注入 `price:1`；注入"缺 missing" ⇒ 必须 false |
| ⑤ | 部分成功 ⇒ `sources` **与实际行数自洽**（每项 = 该 `source` 的行数、合计 = `rows`、`priced` 一致） | 注入 `tencent:2`（把失败标的计成功）；注入 `rows:9`；注入 `priced:2` ⇒ 必须 false |
| ⑥ | 同一轮 27 个降级 ⇒ **1 行**汇总（`27 个` / `×27` / 样例 / "明细见 debug 级"），逐标明细只在 debug | 注入"逐标的各 1 行"；注入"信息不足的一行" ⇒ 必须 false |
| ⑥b | 未开 `TW_DEBUG` ⇒ 明细 0 条，汇总 1 行 | —— |
| ⑦ | 东财熔断时 `hostsAllowed([东财, 东财, 腾讯]) === ['qt.gtimg.cn']`；且东财熔断期间腾讯仍能供价 | 注入"整组共用一把闸"（空数组）⇒ 必须判不等 |
| ⑧ | 健康摘要逐主机 lastOk/lastFail/连续失败/熔断；**读完请求数不变**；`/health` 带 `upstream` | 注入"把刚失败的主机写成 ✓" ⇒ 必须能改写出差异 |
| ⑨ | 全失败 5xx 的消息必须同时含「上游」与「范围」与「真实原因」 | 注入旧的裸消息"上游暂时不可用（熔断中…）" ⇒ 必须判不合格 |

另：`src/host/routes.test.ts` 的既有用例
`错误语义：上游熔断 → 503 且带 retry-after（无备用源的路由）` **按新契约改写**为
`错误语义：上游熔断 ⇒ 逐标/批量路由 200 + 原因；聚合路由才可能 503（点名上游与范围）`
—— 这条用例原先断言的正是**用户抱怨的那条行为**，保留它会让"修好"变成"红灯"。

---

## 7. 改动清单（`文件:行号`）

| 文件 | 内容 |
|---|---|
| `src/host/degrade.ts`（新，353 行） | ① 上游健康簿 `noteHostSuccess/Failure/Skipped` + `upstreamHealth`；② 降级日志聚合 `noteDegraded/flushDegraded/pendingDegraded`；③ 部分成功契约 `partialOutcomeOf` + `TotalUpstreamError`。**只 import `breaker.ts`/`http.ts`/`time.ts`**（不 import 取数模块，避免 `breakerFetch → degrade → tencent → breakerFetch` 成环） |
| `src/host/degrade.test.ts`（新，626 行） | §6 的 10 例 |
| `src/host/breakerFetch.ts:19,35-70` | 熔断出口接健康簿；冷却/半开"跳过"与"失败"分开记 |
| `src/host/em.ts:174,188` | `fetchAny` 的失败日志聚合 + 健康记账 |
| `src/host/em.ts:687` | `quotes batch failed` 聚合 |
| `src/host/em.ts:984-1052` | 能力表 + `quoteSourcePlan` + `emQuotesWorthTrying` + `QuoteLoadOptions` |
| `src/host/em.ts:1109` | `loadQuotes` 顺序改为"腾讯/新浪 → 东财兜底" |
| `src/host/em.ts:1682` | `hasQuoteFallback` 收敛到能力表 |
| `src/host/em.ts:417-456` | `quoteProvenance` 的 `missing[].note` 点名"该品种只有东财一个行情源"与来源顺序 |
| `src/host/em.ts:2231` | K 线缓存降级/跳过日志聚合 |
| `src/host/rescue.ts:1406` | 护盘采样器声明 `emFields: true` |
| `src/host/routes.ts:291-330` | `fail()` 补 `upstream`/`scope`；新增 `replyBatch()` |
| `src/host/routes.ts:345-362` | `/health` 增加 `upstream` |
| `src/host/routes.ts:859-895` | `/quotes` 增加 `missingReasons[]` |
| `src/host/routes.ts:954-1106` | `/industries`、`/industry`、`/detail` 改 200 + 逐标原因；`/board` 的 5xx 点名上游与范围 |
| `src/host/routes.ts`（`/breadth`） | `fetchQuotesWithProvenance(ids, { emFields: true })` |
| `src/host/routes.test.ts:203` | 既有 503 用例按新契约改写 |

**`build.mjs` 零改动**（锁定片段未命中）。

---

## 8. 未做项 / 留给下一批

1. **客户端未显示 `missingReasons`**：`client/api.ts` 的 `quotes()` 仍只声明 `missing: string[]`。
   本批只保证**路由契约**有逐标原因（工具层 `tradewatcher_quotes` 走的是 `fetchQuotesWithProvenance`，
   早就有 `missing[]{what,why,note}`）。要让面板也显示，需要改 `client/*`（本批避开并行改动）。
2. **`/industry`、`/industries` 的 200 形状是加法**：老客户端忽略新增的 `missing`/`partial` 字段，
   但**没有**任何界面逻辑去读它们 —— 界面仍显示"未取到"，只是不再是报错。
3. **`AGG_FLUSH_MS = 400` 是经验值**：一轮取数实测 100–1200 ms，所以**极端慢**的一轮（>400 ms）
   可能拆成两行。宁可两行也不要把两拍并成一行（后者会让人以为"只降级了一次"）。
4. **`emFields` 的两个调用方之外没有别的消费者**：若以后有人需要 `f8/f10`（换手率/量比）做展示，
   要显式传 `emFields`，否则字段会是 `null`（不会报错，**只会静默缺**——这点已写进 `QuoteLoadOptions` 注释）。
5. **`TotalUpstreamError` 目前只在 `/board` 的 catch 里**：其它路由都走不到 5xx 了（这是目标）。
   如果将来新增一条"没有部分结果可言"的上游接口，应当复用它而不是 `throw new Error('上游不可用')`。
