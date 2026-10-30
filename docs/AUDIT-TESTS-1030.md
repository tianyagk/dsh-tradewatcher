# AUDIT-TESTS-1030 — 测试质量审查与补强

> **基线**：`2c78bbf`（v0.182.0）。**只读源码**：本轮只改/新增 `*.test.ts`，未改 `src/**/*.ts` 的生产逻辑、未 commit、未重启。
> **门禁**：`npm test` = 两轮（默认 TZ + `TZ=UTC`），`DSH_HOME=/tmp/testaudit-quant`。
> **方法**：脚本扫描 205 个测试文件（`src/*/*.test.ts`）+ 逐模块人工读边界。凡是"会不会挂"的判断都现场跑过。
> **并行说明**：本轮期间有同伴在同一工作区改 `GlobalClockPage.tsx` / `clockView.test.ts` / `em.ts` / `rescue.ts` / `detailTencent.ts`。下文 §8 记录了一次由此产生的红灯与自愈，**不是我改的**。

---

## 一行结论

**72 条断言只证明"源码里有这个标识符"，30 个文件；100 个测试文件完全没有反例注入（其中 8 个同时是脆弱断言）；8 个新模块里有 1 个（`hostFetch.ts`）此前零测试、另 7 个合计 26 处边界空白；44 个文件带 flaky 诱因。已补 27 条断言（每模块 ≥2、含反例注入），3 条最脆弱的改为行为断言，两轮门禁 1446 → 1478（0 失败）。**

---

## §1 脆弱断言清单（72 条 / 30 个文件）

**判据**：断言对象是 `readFileSync` / `read()` 读进来的**源码文本**，匹配的是**标识符、函数名、或源码里的精确表达式**。这类断言的特征是：**把函数改名、抽成子组件、加一层包装，行为完全不变它却会红；把实现改错但保留那个名字，它反而会绿。**

### 1.1 按文件汇总（30 个）

| 文件 | 条数 | 级别 | 典型 needle |
| --- | --- | --- | --- |
| `src/client/chipsView.test.ts` | 8 | **A** | `panesRef`、`isFiveDay`、`fqSupported`、`why`、`caliberDeviates`、`chipsRowsLayoutOf(` |
| `src/client/prismBatch2Ui.test.ts` | 8 | **A** | `dd.status`、`saveIndustryLimit`、`onBlur`、`onKeyDown`、`basisBlocks.map` |
| `src/client/splitDrag.test.ts` | 7 | **A** | `ArrowUp`、`onDoubleClick`、`cursor`、`chipsOpen`、`onPointerDown` |
| `src/client/noteIcon.test.ts` | 4 | **A** | `onKeyDown`、`isFiveDay`、`disclaimer` |
| `src/host/bottomInterval.test.ts` | 4 | B | `BOTTOM_INTERVAL_CAVEAT`、`intervalNote` |
| `src/host/globalFlow.test.ts` | 4 | B | `stats.bis.org`、`gatedFetch`、`HostBudget` |
| `src/host/usChart.test.ts` | 4 | B | `splitBars`、`tabUnavailableReason` |
| `src/client/distCard.test.ts` | 3 | **A** | `bars.map(`、`DIST_BJ_NOTE`、`trendCellsOf(` |
| `src/client/prismDay.test.ts` | 3 | **A** | `todayOrdersOf`、`todayFillsOf` |
| `src/client/auctionSeries.test.ts` | 2 | B | `AuctionSpark`、`auctionSeriesText` |
| `src/client/impl85.test.ts` | 2 | B | `snapshot.today.map(`、`e.hhmm` |
| `src/client/prismBatch1Ui.test.ts` | 2 | **A** | `exposureOk`、`exposure.reason` |
| `src/client/prismRedesign.test.ts` | 2 | **A** | `compositionItems`、`PRISM_SERIES_CSS` |
| `src/host/chips.adaptive.test.ts` | 2 | B | `bucketNote`、`caliberDeviates` |
| `src/host/rescuePiggyback.test.ts` | 2 | B | `RESCUE_INTRADAY_MAX_BYTES`、`noteBreadthMoment(` |
| `src/client/chipsNoteRemoval.test.ts` | 1 | B | `caliberDeviates` |
| `src/client/clockView.test.ts` | 1 | **A** | `refreshSec`（见 §1.3 的活样本） |
| `src/client/leverageHeader.test.ts` | 1 | B | `ASOF_PREFIX` |
| `src/client/marketRefactor.test.ts` | 1 | B | `BREADTH_PAGES_MAX` |
| `src/client/marketV1.test.ts` | 1 | B | `MINUTE_BARS` |
| `src/client/pollWiring.test.ts` | 1 | **A** | `shouldPollQuotes` |
| `src/client/prismComposition.test.ts` | 1 | **A** | `netMode` |
| `src/client/prismDecisionMove.test.ts` | 1 | **A** | `dRows.map` |
| `src/client/prismPage4.test.ts` | 1 | A | `polyline` |
| `src/client/prismVisualFixes.test.ts` | 1 | A | `zero` |
| `src/client/rescuePanelRemoval.test.ts` | 1 | B | `snapshot.summary` |
| `src/client/ticker.test.ts` | 1 | **A** | `shouldPollQuotes` |
| `src/host/auctionDecouple.test.ts` | 1 | B | `api.auction(` |
| `src/host/chips.price.test.ts` | 1 | B | `latestBarDate` |
| `src/host/rescueSameSlot.test.ts` | 1 | B | `progressSd` |

**级别定义**
- **A（28 条）**：只写了一个裸标识符，**连断言消息都没有** —— 失败时只知道"某处少了某个词"，不知道用户会看到什么。
- **B（44 条）**：匹配的是常量名或渲染标记（`data-role`、`splitBars` 这类**跨层传参**的名字）。有一定回归价值（证明"这个值确实被传下去了"），但仍会在纯重构时误伤。

### 1.2 最该先修的三条（已在本轮改造，见 §6）

| 位置 | 原断言 | 它证明不了什么 |
| --- | --- | --- |
| `src/client/prismDay.test.ts:68` | `page.includes('todayOrdersOf')` | 证明不了"今日表真的只显示今天"，也证明不了跨时区不串日 |
| `src/client/distCard.test.ts:98` | `page.includes('trendCellsOf(')` | 证明不了"dist 优先、缺格才回落、全缺给 null"这套优先级 |
| `src/client/chipsView.test.ts:282` | `panel.includes('chipsRowsLayoutOf(')` | 证明不了"装不下时先吃间隙、再装不下如实 fits:false" |

### 1.3 活样本：今天亲眼看到它红了一次

`src/client/clockView.test.ts:114` 原本是：

```ts
assert.match(SRC, /subscribeTicker\(\(\) => load\(false\)\)/)
```

同伴把时钟页的行情改走"统一 ticker + 时段闸门"（这是**行为正确**的重构，`GlobalClockPage.tsx:165`），这条断言立刻变红 —— 22:33 那一轮 `1477 pass / 1 fail` 就是它。随后同伴的修法是把正则改得**更精确**：

```ts
assert.match(SRC, /subscribeTicker\(\(\) => \{ if \(!shouldPollQuotes/)
```

⇒ **这是本清单的典型病理：源码一变就要改测试，而测试越改越贴源码。** 真正该断言的是"到点会调 `load`、且非交易时段不调"（可注入 `now` 的行为断言），而不是函数体的字面形状。

---

## §2 无反而注入的断言

### 2.1 数量

- **100 / 205 个测试文件**没有任何 `assert.throws`（= 完全没有"把缺陷放回去看它会不会红"的机制）。
- 其中 **8 个文件同时带脆弱断言** —— 这类最危险：**既证明不了行为，也证明不了自己的判据非空**：

| 文件 | 脆弱条数 | 零反例 |
| --- | --- | --- |
| `src/client/noteIcon.test.ts` | 4 | ✅ |
| `src/host/globalFlow.test.ts` | 4（310 条断言里 0 条 throws） | ✅ |
| `src/host/usChart.test.ts` | 4 | ✅ |
| `src/host/rescuePiggyback.test.ts` | 2 | ✅ |
| `src/client/clockView.test.ts` | 1 | ✅ |
| `src/client/leverageHeader.test.ts` | 1 | ✅ |
| `src/host/chips.price.test.ts` | 1 | ✅ |
| `src/host/rescueSameSlot.test.ts` | 1 | ✅ |

### 2.2 只证明"真值/存在"的断言（25 条）

`assert.ok(x)` 里没有任何比较，等于只证明"x 非空"。典型：

```
src/client/tWindow.test.ts:64      assert.ok('reason' in missing)
src/client/tWindow.test.ts:67      assert.ok('reason' in noAvg)
src/shared/trendVwap.test.ts:69    assert.ok('reason' in w)
```

`'reason' in obj` 只证明**键存在** —— 值为 `''`、`'—'`、`undefined` 都能通过。这三处应当断言"reason 非空且含具体原因"。

> 说明：另外 22 条同类命中是**误报**（`existsSync(...)`、`Number.isNaN(...)` 本身就是行为判据）。所以 §2.2 的真实条数是 **3 条**，不是 25 条；我把扫描口径与误报都写出来，避免这个数字被当成结论用。

### 2.3 判断口径（避免把"纯函数测试"误判成"无反例"）

一个 `assert.equal(f(2), 4)` 本身就是反例探针：把 `f` 改成返回 5 它就会红。**所以我没把"零 throws"等同于"无价值"** —— 真正的问题只在两类：① 断言对象是源码文本（§1）；② 断言对象是"存在性"（§2.2）。

---

## §3 覆盖缺口（8 个新模块）

统计口径：**本轮补强前**的空白处。每项都在 §5 里被至少一条新断言覆盖。

| 模块 | 缺口（补强前） | 最严重的一条 |
| --- | --- | --- |
| `src/host/hostFetch.ts` | **4** | **整个模块零测试**；熔断打开、非 2xx、GBK 解码三条核心语义全靠读代码相信 |
| `src/host/detailTencent.ts` | **3** | 美股 `[37]` 是**美元**不乘 1e4 —— 文件头写明"此前一律 ×1e4 ⇒ 差 10000 倍"，**却没有一条回归测试** |
| `src/host/breadthScan.ts` | **4** | `batchesOf(codes, 0)` **死循环**（`i += 0`）；`bucketIndexOf` 的 ±10 边界两侧方向相反 |
| `src/client/distCard.ts` | **4** | 全 0 计数会让 `max=0`，无兜底时 `0/0 = NaN`；空数组的 `distSumOf` 必须是 `null` 不是 0 |
| `src/shared/pollGate.ts` | **3** | `clampRescueSec(Infinity)` 若去掉 `Number.isFinite` 会被钳成 **600**（一个"看起来合法"的值） |
| `src/host/volUnit.ts` | **4** | 0/负/NaN 走 `0/0` 分支；5% 是**闭区间**（`<=` vs `<` 会改结论） |
| `src/host/etfFlow.ts` | **3** | `superShareOf(net, 0)` 除零；`parseSinaSuperNet` 对负号/科学计数必须给 null 而不是猜 |
| `src/client/ticker.ts` | **2** | 同一回调订阅两次会因 `Set` 去重只占 1 位，退订一次即全退 —— 这个语义没被记录过 |

**边界类型覆盖对照**（用户点名的六类）

| 边界类型 | 补强前 | 补强后 |
| --- | --- | --- |
| 空数组 | `distCard` / `breadthScan` 缺 | ✅ 各补 1 条 |
| 单元素 | `batchesOf(['a'])` 缺 | ✅ |
| 除零 | `superShareOf` / `distBarsOf` / `chipsRowsLayoutOf` 缺 | ✅ 三处都补 |
| 超大值 / Infinity | `clampRescueSec` / `volUnitOf` 缺 | ✅ 各补 |
| 时区跨日 | `pollGate` 只测了 15:05，没测 09:30/11:30/13:00/15:00 四端点 | ✅ 补 5 个端点 |
| 熔断打开 | `hostFetch` 零测试 | ✅ 补 1 条（且断言"一个请求都不发"） |

---

## §4 flaky 风险清单

扫描口径：测试文件里出现 `await fetch(` / `globalThis.fetch =` / 裸 `Date.now()` / `Math.random`。

| 类别 | 文件数 | 说明 |
| --- | --- | --- |
| **真网络** | **31** | 见下（含 `hostFetch.test.ts` 的**误报**：它只是 `globalThis.fetch =` 替身） |
| **裸 `Date.now()`** | **21** | 时间相关断言直接读系统钟，没有注入 `now` |
| `Math.random` | **0** | 无随机源 ✅ |

**真网络文件（31）**：

```
impl78 · auctionDecouple · chips · degrade · fetchDedupe · fix1Redline · fix3Highmed
fix7Host · fupan · fupanTrades · globalFlow · impl74 · impl80 · intlCoverage
intlMinute · klineAgg · klineHostFallback · klineUnits · marketClock · marketExtras
prismNews · rescuePiggyback · rescueSnapshotContract · rescueTradingDay · robotsGate
routes · sinaFutures · sinaIndex · usChart · usQuote · hostFetch(误报)
```

**为什么不一定是坏事**：多数是真机验收（`routes.test.ts` 直接起宿主 handler），仓库风格如此。但**下面三处是真隐患**：

1. **模块级缓存的测试间串味**：`src/host/etfFlow.ts:33` 的 `cache` 是模块级 `Map`，且**没有 `__reset` 导出**。两个测试先后调 `fetchSinaSuperNet` 会互相命中对方的缓存；`breadthScan` 有 `__resetCodePoolCache()`，`ticker` 有 `__resetTicker()`，`etfFlow` **没有**。→ 已记入 §7。
2. **裸 `Date.now()` 的时间断言**：`src/client/clockView.test.ts` 一类页面测试直接取系统钟；两轮门禁只切 `TZ`，没切钟。一旦遇到整分钟/整小时边界就会偶发。
3. **`hostFetch.test.ts` 会替换 `globalThis.fetch`**：我用 `try/finally` 还原，但它与**并发跑的**其它测试共享进程内全局。`--test-concurrency=8` 是**按文件**并发（每文件一个进程），所以我这层替换不会外溢；若将来有人改成同进程内含 `t.after` 遗漏，就会互相踩。已在文件里写明。

---

## §5 补强记录（27 条新增断言，全部含反例注入）

> 纪律：**不删除任何既有断言**，只在文件末尾追加；每条测试内部都有一段 `assert.throws(... /反例上/ ...)` 证明"把缺陷放回去它真的会红"。

| 模块 | 文件 | 新增 | 覆盖 |
| --- | --- | --- | --- |
| `volUnit` | `src/host/volUnit.test.ts` | **+3** | ⑥ 0/负/NaN/±Infinity/缺失 ⇒ `ok:false` 且 `errPct=Infinity`；⑦ 5% **闭区间**（5.000% 过、5.005% 不过）；⑧ 换算舍入方向（49→0 手、50→1 手） |
| `etfFlow` | `src/host/etfFlow.test.ts` | **+3** | ⑦ 负号/科学计数/缺字段 ⇒ `null`（不写 0）；⑧ `superShareOf` 除零 vs 真零必须可分；⑨ `sinaSymbolOf` 严格全匹配（多/少一位都拒） |
| `detailTencent` | `src/host/detailTencent.test.ts` | **+3** | ⑤ **美股 `[37]` 是美元**（与 A 股正好差 10000 倍）；⑥ 量纲判不出 ⇒ `vol:null` + `missing` 点名；⑦ 空包/无匹配/空现价 ⇒ `null` |
| `breadthScan` | `src/host/breadthScan.test.ts` | **+3** | ⑨ ±7/±10/0 归属 + 9 档合并不变性；⑩ 空池/非法 pct 不计入 total；⑪ 11 桶长度不符**抛错** |
| `distCard` | `src/client/distCard.test.ts` | **+4** | ⑧ 空数组/全 0 不产 NaN、Y 轴仍 3 档；⑨ 长度不等补 `null` 不补 0；⑩ 一致性缺数据不编文案；⑪ `trendCellsOf` 优先级（见 §6） |
| `ticker` | `src/client/ticker.test.ts` | **+2** | ⑦ 同一回调重复订阅只占 1 位、退订幂等；⑧ 归零后 timer 停且可重启 |
| `pollGate` | `src/shared/pollGate.test.ts` | **+3** | ⑦ 钳位数值边界（Infinity 必须回默认而非 600）；⑧ 时段四端点（09:30/11:30/13:00/15:00）；⑨ 去重归一与首次出现顺序 |
| `hostFetch` | `src/host/hostFetch.test.ts`（**新建**） | **+4** | ① 熔断打开 ⇒ `BreakerOpenError` 且**零请求**；② 非 2xx ⇒ `HTTP <status> from <host>`；③ GBK 真按 GBK 解；④ 请求头只在给了才带 |
| 行为升级 | `src/client/prismDay.test.ts` | **+1** | ⑥ `todayOrdersOf` 跨日过滤 + `decidedAt` 北京日回退 |
| 行为升级 | `src/client/chipsView.test.ts` | **+1** | ⑧ `chipsRowsLayoutOf` 三分支（目标间隙 → 零间隙 → `fits:false`） |
| **合计** | **10 个文件** | **+27** | 8 个新模块各 ≥2；另 2 条为 §6 的行为升级 |

---

## §6 三条最脆弱断言 → 行为断言

**做法**：原断言**一行未删**（保留为静态 lint），在其后追加一条**行为断言**作为主判据。这样既满足"只增强"，也把"改坏了会不会失败"从"源码里有没有这个词"换成"函数输出对不对"。

| # | 位置 | 原断言 | 新增的行为断言 | 它现在能抓住什么 |
| --- | --- | --- | --- | --- |
| 1 | `src/client/prismDay.test.ts:68` | `page.includes('todayOrdersOf')` | ⑥ 造 4 条挂单（含 2 条 `day` 为空、只有 `decidedAt`），断言只返回今天的 2 条、且**按北京日**而非 UTC 日归属；源数组长度不变 | 按 UTC 切日会漏掉 00:30 的单、把前一天 23:30 的单算进来 —— 这正是跨时区最容易错的地方 |
| 2 | `src/client/distCard.test.ts:98` | `page.includes('trendCellsOf(')` | ⑪ 断言取值优先级 **dist > current > limits**、**逐格独立回落**、`NaN` 视为没给、**全缺 ⇒ 5 个 `null`** | 整组一起回退、把缺失写 0、NaN 直接进高度 —— 三种都会让"5 格"显示假数字 |
| 3 | `src/client/chipsView.test.ts:282` | `panel.includes('chipsRowsLayoutOf(')` | ⑧ 断言三个分支：装得下保留 6px 间隙且总高=可用高；装不下退到 0 间隙；连 1px/行 都给不出时 `fits:false, rowH:1`，且 `availablePx=0/NaN` 不产生 `0/0` | 不判 `fits` 直接均分 ⇒ 10 行塞进 1px 会得到 0.1px 的"蚂蚁行" |

> 为什么只改三条：三条都是 A 级里"纯裸标识符 + 无断言消息"的，且都有**现成的纯函数**可断言。其余 A 级（`prismBatch2Ui` 的 `onBlur`/`onKeyDown`、`splitDrag` 的 `ArrowUp`、`prismBatch1Ui` 的 `exposureOk`）落在 JSX 渲染里，**没有纯函数可断言**；把它们变成行为断言需要渲染层测试，属另一个工程（且会引入依赖，违反 R11）。

---

## §7 顺带发现的源码问题（**未修**，只报告）

本轮只做测试，以下四条是读码/实测发现的**生产代码**问题，留给出题人决定：

1. **`batchesOf(codes, 0)` 死循环**（`src/host/breadthScan.ts:64`）
   `for (let i = 0; i < codes.length; i += size)`，`size=0` 时 `i` 永不递增。实测：`timeout 3 node -e "...batchesOf(['a'],0)..."` → **exit 124（超时）**。
   现状不会触发（三个调用点都传默认 600），但函数是 `export` 的，且 `size` 是形参。**不写测试是刻意的**——写了会把整轮门禁挂死。

2. **`bucketIndexOf` 的 ±10 边界两侧方向相反**（`src/host/breadthScan.ts:16-29`）
   `pct > 10 → 0`（严格），但 `pct > -10` 为假时落到 10。于是 **+10.00% 进「7~10」桶，而 −10.00% 进「<−10」桶**。9 档合并把两者都并到最外档，所以**当前界面不受影响**；但 11 档界面一上就会看到"涨停在 7~10 档、跌停在 <−10 档"的不对称。已在新增测试 ⑨ 里**用断言把这个现状钉住并标注**，避免有人默默改掉。

3. **`dedupeSecids` 会把 secid 改成大写**（`src/shared/pollGate.ts:89`）
   `const k = s.trim().toUpperCase()`，返回的是 `k` 而不是原串。`1.510300` 无所谓，`sh600000` / `hkHSI` 这类大小写敏感的代码会被改写。已在测试 ⑨ 里显式断言该行为并注明"下游若按小写比对会失配"。

4. **`etfFlow` 的模块级缓存无重置钩子**（`src/host/etfFlow.ts:33`）
   `const cache = new Map<...>()` 没有 `__reset` 导出，而同仓库的 `breadthScan`/`ticker`/`chipsLoader` 都有。测试间会串味（谁先跑谁定调），也是 §4 的 flaky 源。

---

## §8 门禁读数

| 轮次 | 命令 | tests | pass | fail |
| --- | --- | --- | --- | --- |
| 基线（本轮开工前） | `npm test` 第 1 轮 | 1446 | 1446 | 0 |
| **第 1 轮（默认 TZ）** | `node --test "src/**/*.test.ts"` | **1478** | **1478** | **0** |
| **第 2 轮（`TZ=UTC`）** | 同上 + `TZ=UTC` | **1478** | **1478** | **0** |

- **1446 → 1478 = +32**，其中 **+27 是本轮新增**，另 +5 来自并行同伴（`clockView` / `hostAudit` 等）。
- 我改/新增的 10 个文件单独跑：**90 tests / 90 pass**，两轮均 0 失败。
- `DSH_HOME=/tmp/testaudit-quant`；无新依赖；未 commit；未重启。

**一次红灯与自愈（记录在案）**：22:33 那一轮出现 `1477 pass / 1 fail`，失败点是 `src/client/clockView.test.ts:114`（详见 §1.3）。同一时刻 `GlobalClockPage.tsx`(22:32:38) 与 `clockView.test.ts`(22:33:39) 正被同伴编辑。等其改完后重跑即 **1478/1478**。**该失败与本轮改动无关**，我未触碰这两个文件。

---

## §9 未确认

1. **`days`/`BOTTOM_INTERVAL_CAVEAT` 这类 B 级断言的价值**：它们证明"常量确实被传进了渲染"，属跨层传参的弱证明。我没有改它们（改动面太大、收益不确定）。
2. **`assert.ok('reason' in x)` 三处（§2.2）未改**：改成"非空 + 含关键字"需要知道每处的合法文案集合，容易写成新的脆弱断言。留作待办。
3. **31 个真网络测试的稳定性**：只统计了"是否打网络"，**没有做长跑复现**。`--test-concurrency=8` 下是否偶发 429/超时，需要多轮跑才知道。
4. **`hostFetch.test.ts` 的 `globalThis.fetch` 替换**：依赖"每个测试文件一个进程"这一现状（`--test-concurrency` 按文件切）。若将来改成同进程串行，需要 `t.after` 兜底。
5. **`batchesOf(size=0)` 的死循环**只做了 3 秒超时证明，未确定修复方式（加 `size = Math.max(1, ...)` 会静默改变调用方语义，应报错还是钳位需产品决定）。
