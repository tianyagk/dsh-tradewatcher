# REVIEW-6：工程质量与一致性（全项目 review，只读）

- **评估时刻**：2026-10-15 21:40–22:05（Asia/Shanghai）
- **HEAD**：评估开始时 `802a48f`（v0.89.0）；**评估期间另一路提交了 `c32bc59`（v0.90.0）** ⇒ 本报告按 `c32bc59` 复核并收口。
- **工作区状态**：开始评估时是**脏的**（v0.90 的 5 个文件在改：`src/host/globalFlow.ts`、`src/client/api.ts`、`src/client/tools/globalFlowView.ts` 及其测试，+267/−43）；
  评估中途该批次**已提交**，现在工作区干净（只多出本文件）。
  ⇒ **§1.1B、§3.5、§4.2 三条与"未提交状态"相关的结论都已在提交后的干净树上重新复核**（复核命令与结果写在各自小节里）。
- **本轮未改任何 `src/**`**、未 commit、未装、未动 profile、**未在工作区跑 `npm run build`**（宿主会热重载）。临时文件：`/tmp/eng-*`。
- **本次实际运行的命令**（全部只读或只写 `/tmp`）：
  ```
  git log/status/diff                     # 版本与工作区状态
  node --test --experimental-strip-types --test-reporter=tap "src/**/*.test.ts" > /tmp/eng-tap*.txt
  node_modules/.bin/tsc --noEmit -p tsconfig.json      # 类型（noUnusedLocals/Parameters 已开）
  python3 /tmp/eng-exports.py > /tmp/eng-exports.tsv    # 导出引用扫描（自写，含 v0.78.0 对比）
  python3 /tmp/eng-frag2.cjs                            # build.mjs 片段强度
  HTTP_PROXY=http://127.0.0.1:9 node --test … globalFlow.test.ts   # 真网络探测
  ```
- **方法边界**：导出扫描是**文本级**（`\bName\b` 计数，排除声明行），不解析 TS AST ⇒ 极端写法（动态字符串引用、`export *`）可能漏判；
  结论里的"0 引用"我做了逐条 `grep` 复核，但仍标注为**实测（文本级）**。

---

## 1. 死代码与冗余（自 v0.78.0 起的增量）

### 1.1 新增的「无外部引用」导出（实测）

**证据**：`python3 /tmp/eng-exports.py`（对 `e50be47`（v0.78.0）做符号级对比），输出 `/tmp/eng-exports.tsv`；
每条再用 `grep -rn "\b<Name>\b" src scripts build.mjs | grep -v "^<自身文件>:"` 复核（含 `scripts/` 与 `build.mjs`，避免把脚本消费者误判成死代码）。

**A. 应该去掉 `export`（只在自身文件内使用；`ext=0, own≥1`）—— 22 条**（下表按文件合并成 12 行；另有 3 条"连自身文件都不用"见 B）

| 导出 | 位置 | 自身文件内用量 | 备注 |
| --- | --- | --- | --- |
| `TypeSpec` | `src/client/toolDetailTheme.ts:18` | 7 | 本文件所有类型规格的别名 |
| `GlassSlots` | `src/client/toolDetailTheme.ts` | 1 | 只在 `glassProblems` 签名里 |
| `FactTopic` | `src/client/toolFacts.ts:13` | 3 | 只在 `FACT_TOPICS` 与两个纯函数里 |
| `keyframeBlock` | `src/client/toolDetailTheme.ts` | 1 | 只被 `keyframesProblems` 用 |
| `StressVerdict` | `src/client/tools/globalFlowView.ts` | 1 | 只在本文件的判定函数里 |
| `MarketExtras` | `src/client/api.ts` | 3 | 客户端 DTO 组合用 |
| `Push2Probe` | `src/host/marketExtras.ts` | 2 | 只在同文件被组合进 `MarketExtras` |
| `DayOverDay` / `LimitCounts` / `MarginCross` / `progressCurveSamples` | `src/host/marketExtras.ts` | 1 / 1 / 1 / 1 | 只在同文件被组合进 `MarketExtras` |
| `TradingDayState` | `src/host/rescue.ts` | 1 | 同文件判定函数签名 |
| `TradingCalendarInfo` | `src/shared/model.ts` | 1 | 跨端 DTO 的组成部分 |
| `CalendarValidation` / `validateTradingCalendar` / `tradingCalendarPath` / `TRADING_CALENDAR_FILE` | `src/host/tradingCalendar.ts` | 1 / 1 / 1 / 1 | 同文件自用 |
| `FLOW_MACRO_KEEP_DAYS` / `FlowPreferenceParts` / `mergedMacroHistory` / `trimMacroDays` | `src/host/globalFlow.ts` | 1 / 1 / 1 / 1 | **在未提交的 v0.90 改动里** |
| `ROBOTS_TTL_MS` | `src/host/robotsGate.ts` | 1 | 同文件 TTL 常量 |

（A 组符号总数 22 = 上表 13 行里的 TypeSpec、GlassSlots、FactTopic、keyframeBlock、StressVerdict、MarketExtras、Push2Probe、DayOverDay、LimitCounts、MarginCross、progressCurveSamples、TradingDayState、TradingCalendarInfo、CalendarValidation、validateTradingCalendar、tradingCalendarPath、TRADING_CALENDAR_FILE、FLOW_MACRO_KEEP_DAYS、FlowPreferenceParts、mergedMacroHistory、trimMacroDays、ROBOTS_TTL_MS。）

**影响**：导出面 = 事实上的公共 API；这些符号不该对外承诺，读者会以为"别处依赖它"。**建议**：逐个去掉 `export`（保留文件内可见），
若需要跨模块用再显式导出。**风险**：低（无外部引用 ⇒ 改 `export` 不破坏调用方）；但 `src/shared/model.ts` 的 DTO 组件类型要留意
（将来若被 `api.ts` 复用则需重新导出）。

**B. 连自身文件都不用（`ext=0, own=0`）—— 3 条（疑似死代码）**

| 导出 | 位置 | 证据 |
| --- | --- | --- |
| `LimitCountsWire` | `src/client/api.ts` | `grep -rn "\bLimitCountsWire\b" src scripts build.mjs` ⇒ 仅 1 处（声明本身） |
| `macroHistory` | `src/host/globalFlow.ts`（未提交改动） | 同上 ⇒ 仅声明处 |
| `macroReadFailures` | `src/host/globalFlow.ts`（未提交改动） | 同上 ⇒ 仅声明处 |

**影响**：A/B 中的三条是"写了没用"的表面（B 的三条更明确：连本文件都没引用）。**建议**：B 的三条直接删（或补上消费点）；**风险**：低。

> **已在 `c32bc59`（v0.90.0）复核**（评估期间它们还在未提交改动里）：
> `macroHistory` / `macroReadFailures` / `LimitCountsWire` 三条 **外部引用 = 0、同文件用量 = 0** ⇒ **不是 in-flight，是死代码**（实测，不再是"未确认"）。

**C. 专给测试用的导出（`ext≤1, test_refs>0`）—— 4 条 = 测试钩子**

| 导出 | 位置 | 测试引用 |
| --- | --- | --- |
| `resetTradingCalendarCache` | `src/host/tradingCalendar.ts` | 1 个测试文件 |
| `push2Availability` / `resetPush2Availability` / `resetExtrasCache` | `src/host/marketExtras.ts` | 各 1 个测试文件 |

**影响**：这些是"重置缓存"钩子，语义上属于测试面，但和业务导出混在一起、命名不像测试钩子。
**建议**：统一命名约定（仓库已有先例：`robotsGate.ts` 的 `__resetRobotsCache`、`em.ts` 的 `__reset*`），
改成 `__reset*` 前缀或集中到 `src/host/testHooks.ts`。**风险**：低（纯改名，测试同步改）。

### 1.2 与 `docs/REVIEW-1-REDUNDANCY.md` 的对照（增量）

对照结论：旧清单的主体（`em.ts` 巨型模块拆分、`stripComments` 多份、DTO 双向声明）**仍在**（本报告不重复）；**增量**是三类新重复：

| 增量重复 | 证据 | 影响 / 建议 |
| --- | --- | --- |
| `num(value)` 在客户端**重复实现两遍**（正文几乎逐字相同） | `src/client/toolDetailTheme.ts:405` vs `src/client/toolBackButton.ts:78`（前 3 行逐字相同）；宿主还有第三个变体 `src/host/em.ts:181`（语义不同：会 `String(v).trim()`） | 两个客户端副本可合并进一个纯工具模块（如 `src/client/numUtil.ts`）。宿主那个**不要**合并（语义不同，合并会引入行为变化）。风险：低 |
| 测试里的 `stripComments` **4 份**、`readSrc` **2 份** | `grep -rln "function stripComments" src` ⇒ `assertStrength.test.ts`、`host/markdownScan.test.ts`、`client/toolsPage.test.ts`、`client/uiuxDiscipline.test.ts`（本批新增的那份是我自己加的 —— 同一模式又抄了一遍） | 抽一个 `src/testing/srcText.ts`（**不许 import react**，否则破坏 `node --test` 可导入性）。风险：低；收益：后续每个"扫源码"断言少抄 20 行 |
| `src/index.test.ts` 里**手抄一份** `ROW_ROUTES/ROW_TOOLS` | `src/index.test.ts:317-330` 的表 vs `src/index.ts:32-56` 的真表；test 头部注释自认"搬迁一行就要同步改这里" | **断言可以在真表漂移时保持绿**（实测：真表有 `/tradewatcher/market-extras`，测试副本也有 ⇒ 今天一致，但没有任何断言保证它们相等）。建议：把真表 `export`（或加 `ROW_ROUTES_FOR_TEST` 与真表的 `assert.deepEqual`），并把文档同步也纳进判据。风险：中（归属错配会导致"关某行 ⇒ 别的页面 404"这类用户可见故障） |

### 1.3 文件可达性（实测）

**证据**：从 `src/**` 所有 import 语句构建引用图（相对路径解析 + `.ts/.tsx` 后缀补全）。
**结果**：116 个非测试文件里 9 个零 importer，全部可解释：

| 文件 | 解释 |
| --- | --- |
| `src/index.ts`、`src/client/index.tsx` | 入口（`build.mjs` 的 entryPoints） |
| `src/host/selftest.ts`、`src/host/calendarCheck.ts` | npm 脚本入口（`selftest` / `calendar:check`） |
| `src/host/*.child.ts`（3 个） | 被 `spawn` 的子进程脚本 |
| `src/client/env.d.ts` | 环境类型声明 |
| **`src/client/toolFacts.ts`** | **只被测试引用**（v0.87 我加的"事实清单"模块）⇒ 见下 |

**影响**：`toolFacts.ts` 在生产源码树里、却不进任何产物（`lib/client.js` 里确认无 `toolFacts` 字样）。
**建议**：二选一 —— ① 移到 `src/testing/`（语义更准）；② 保留但在文件头写明"仅供断言，不进产物"。
**风险**：低。**未确认**：`build.mjs` 是否会把 `src/client/**` 里所有文件都当客户端源收集（实测产物里没有它 ⇒ 推断不会，确认方法：看 esbuild 的 entryPoint 只有 `src/client/index.tsx`）。

---

## 2. 归属漂移：`ROW_ROUTES`/`ROW_TOOLS` vs `docs/DESIGN-SUBPLUGINS.md`

### 2.1 判据（文档原文）

> **被 ≥2 个行消费 ⇒ core；单一消费方 ⇒ 该行。** 判归属**不看名字**，看 grep 出来的调用点。（`docs/DESIGN-SUBPLUGINS.md` §2.2）

### 2.2 实测账目（不给结论，先算账）

**证据**：
```
grep -oE "path: '/tradewatcher/[a-z/-]+'" src/host/routes.ts | sort -u   # 26 条
grep -oE "'/tradewatcher/[a-z/-]+'" src/index.ts | sort -u              # 11 条（各行独占表）
```
⇒ **26 条路由 = core 15 + calendar 1 + watchlist 3 + portfolio 2 + market 4 + cloudmap 0 + tools 1**。

core 15 条逐条调用方（实测 `grep -rn "api.<method>(" src/client`，去掉 `api.ts` 与测试）：

| 路由 | 调用方（UI） | 消费行数 | 判定 |
| --- | --- | --- | --- |
| `/tradewatcher/trades` | `QuoteDrawer.tsx` | 1（core） | core ✓（文档 §2.1 同款） |
| `/tradewatcher/industry` | `QuoteDrawer.tsx` | 1（core） | core ✓ |
| `/tradewatcher/detail` | `QuoteDrawer.tsx`（唯一） | 1（core） | core ✓ |
| `/tradewatcher/ytd` | `useYtd.ts` ← `WatchlistPage.tsx` + `PortfolioPage.tsx` | 2 | core ✓ |
| `/tradewatcher/chips` | `useChips.ts` ← `QuoteDrawer.tsx` | 1（core） | core ✓ |
| `/tradewatcher/kline` | `chartCache.ts`（详情抽屉的图缓存） | 1（core） | core ✓ |
| `/tradewatcher/trend` | `chartCache.ts`（详情）+ `mini.ts`（`mini.ts` 被 `PortfolioPage.tsx` 与 `WatchlistPage.tsx` 消费）| ≥2 | core ✓ |
| `/tradewatcher/quotes` | `useQuotes.ts:67`（全页签的行情引擎） | 全部 | core ✓ |
| `/tradewatcher/prefs`、`/rows`、`/backup`、`/health`、`/tones`、`/badge`（`src/client/index.tsx:55`）、`/suggest` | 外壳/行情条/设置/健康 | ≥2 或基础设施 | core ✓ |

### 2.3 漂移项（实测）

| # | 漂移 | 证据（文件:行号） | 影响 | 建议动作 | 风险 |
| --- | --- | --- | --- | --- | --- |
| D1 | **`/tradewatcher/market-extras` 未进归属文档**（代码里已归 market） | 代码：`src/index.ts:50`（`market: [… '/tradewatcher/market-extras']`）；调用方实测唯一：`src/client/MarketPage.tsx:130`（`api.marketExtras(...)`）⇒ 单一消费方，归 market **正确**；文档：`docs/DESIGN-SUBPLUGINS.md:64` 仍写 `/breadth /board /rescue` | 关掉 market 行时 `/market-extras` 404 —— 行为正确但**文档没说**，下一个人会按文档以为是 core | 文档补一条（含调用方证据） | 低 |
| D2 | **`§2.1` 表里没有第 7 行 `tools`** | 文档头 `docs/DESIGN-SUBPLUGINS.md:3` 已写"v0.71.0 加第 7 行 tools"，但 §2.1 表只有 core + 5 个功能行；代码 `src/index.ts:63` `tools: ['/tradewatcher/tools/global-flow']` | 归属权威表缺一行 ⇒ 新增工具路由时没有可对照的判据位 | §2.1 补 tools 行（路由 + 空工具数组 + 理由） | 低 |
| D3 | **行-路由账目过期**（写在历史审计里） | 文档 `docs/DESIGN-SUBPLUGINS.md:4` 与 `:162` 引"路由账 24 = core 16 + calendar 1 + watchlist 3 + portfolio 2 + market 2 + cloudmap 0"；实测 26 = core 15 + calendar 1 + watchlist 3 + portfolio 2 + **market 4** + cloudmap 0 + **tools 1** | 任何人照它核对会得出"少了 2 条" | 更新为实测账目；或标注"v0.59–v0.70 时点" | 低 |
| D4 | `cordis.patch.yml` 的行注释也未提 `market-extras` | `cordis.patch.yml:10`（market 行注释只列 `breadth\|rescue\|board`）；`tools/global-flow` 已在 `:13` 说明 ✓ | 与 D1 同源：两个"注释权威"都不完整 | 同步补 `market-extras` | 低 |
| D5 | **测试副本 vs 真表无相等断言** | `src/index.test.ts:317-330`（副本）vs `src/index.ts:32-65`（真表） | 真表漂移时测试可能仍绿（见 §1.2 第三行） | 加 `assert.deepEqual(ROW_ROUTES_FOR_TEST, 真表)` | 中 |

### 2.4 `ROW_TOOLS` 复核（实测）

`src/index.ts:67-74` 分配：calendar `[calendar, calendar_add]`、watchlist `[watchlist, group_rank]`、portfolio `[portfolio, ledger]`、market `[rescue]`、cloudmap `[]`、tools `[]`；
core 保留 `quotes search position ytd undo` —— 与 `docs/DESIGN-SUBPLUGINS.md:61` 的 core 工具清单**逐字一致** ✓ **无漂移**。
唯一可争议点：`undo` 的唯一写入方是 `calendar_add`（文档 §2.1 已写明"判不准 ⇒ core"）⇒ **按文档不算漂移**；
但若将来出现第二个写入工具，`undo` 留 core 的理由要重写（**建议在 §2.2 加一句触发条件**）。

---

## 3. 测试套件健康

### 3.1 用例总数与分布（实测）

**证据**：`node --test --experimental-strip-types --test-reporter=tap "src/**/*.test.ts" > /tmp/eng-tap2.txt`
⇒ `# tests 661 / # pass 661 / # fail 0`（**第一次**跑同一命令得到 `# pass 659 / # fail 2`，见 §3.5）。

| 目录 | 文件 | 用例 | 占比 |
| --- | --- | --- | --- |
| `src/host` | 45 | 338 | 51% |
| `src/client` | 37 | 263 | 40% |
| `src/`（根：`assertStrength` 等） | 3 | 21 | 3% |
| `src/shared` | 3 | 21 | 3% |
| `src/client/tools` | 1 | 18 | 3% |
| **合计** | **89** | **661** | 100% |

### 3.2 最慢的 10 个用例（实测，TAP `duration_ms`）

| 耗时 | 用例 |
| --- | --- |
| 5171ms | L10 覆盖证明：store 的四个状态文件都真的在锁内写（外部持锁时写入会等待） |
| 4030ms | P1-1 源 B 失败：30s 内第二次调用不再重扫 56 页（负缓存带原因） |
| 3204ms | L5 等待是有界的：锁被占用 ⇒ 超时抛 LockTimeoutError，且**不写** |
| 1775ms | L3 反例注入②：只做进程内队列（没有锁文件）同样不行 |
| 1713ms | L6a kill -9 打断高频写入：状态文件任何时刻都可解析 |
| 1513ms | ② K 线缓存裁剪：两进程同时裁剪 ⇒ 收敛到配额内 |
| 1383ms | ③ 已落盘的错值：载入 last-known-good 时作废 + 留痕 |
| 1306ms | rescue-log 跨进程：两个真进程各 `samples += 1` ⇒ 计数 +2 |
| 1298ms | L1 跨进程不丢更新：两个真子进程各 `samples += 3` ⇒ 最终 6 |
| 1294ms | L2 反例注入①：无锁的读-改-写必须露出破损 |

**观察**：Top10 全部是**跨进程锁 / 真子进程**用例（合计 ≈ 22s，占整套 ~27s 的 80%）。它们不是在等网络，而是**在等真实的
子进程窗口**（`startAt = Date.now() + 600`、`holdMs` 等固定等待）。**建议**：这批用例保留（它们证明的是跨进程互斥，价值高），
但可考虑把固定等待收成可注入的常量，在 CI/本地慢机上按需放大（**未确认**：是否有 flake —— 见 §3.5）。

### 3.3 真网络依赖（实测：**未发现**）

- 全仓 `--include=*.test.ts` 扫描 `127.0.0.1|localhost|createServer|http.request|hq.sinajs|qt.gtimg|push2his|emdatah5`：
  命中全部是**桩**（`stubFetch`）或**数据构造**，例如 `src/host/globalFlow.test.ts:266` 的 `stubFetch()`（保存并替换 `globalThis.fetch`，
  `:365` 恢复）、`src/host/fix1Redline.test.ts:44` 的 `realFetch` 保存/恢复、`rescueTradingDay.test.ts:67` 同款。
- **独立验证**：把 HTTP 出口指向黑洞代理后单跑最"像联网"的那个文件：
  ```
  HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 node --test … src/host/globalFlow.test.ts
  ⇒ ℹ tests 32 / pass 32 / fail 0
  ```
  ⇒ 该文件**不依赖真网络**（推断：其它文件同理，按同一 `stubFetch` 模式；**未逐一验证**，确认方法：对每个含 `fetch` 的测试文件跑一次黑洞代理）。
- `127.0.0.1:3080` 只出现在**构造的请求对象**里（`src/host/globalFlow.test.ts:966`：`headers: { host: '127.0.0.1:3080' }`），不是真请求。

### 3.4 无断言 / 恒真断言（全量扫描 + 抽样）

**扫描**：按 `^test(` 切块，统计每块 `assert.` 数量与恒真模式（脚本见 `/tmp/eng-asserts.txt`）。
**结果**：661 块里 **3 块** `assert.` 计数为 0：

| 位置 | 判定 |
| --- | --- |
| `src/host/lock.test.ts` L2 / L3 | **假阳性**：它们用本文件自带的断言 helper（`assertNoMutexLeavesDamage(...)`）—— 有真判据（子进程退出码/文件内容） |
| `src/host/fetchDedupe.test.ts`「目录准备」 | **真发现**：整块只做 `mkdirSync`（`src/host/fetchDedupe.test.ts:612`），没有任何断言。它不是恒真（`mkdir` 失败会抛错 ⇒ 会红），但按 node:test 惯例应是 `before()` 钩子；留在用例里会虚增用例数、也让人误以为有判据 |

**恒真模式**（`|| true` / `assert.ok(true)` / 自比较）：扫描命中的 3 处**全部在 `src/assertStrength.test.ts` 里**，
是该防线自己的"坏样本"（双向对照用）。仓库**已有专门防线**：`src/assertStrength.test.ts:1-14` 写明三类形状（恒真兜底 / 字面恒真 / 自比较）
并对全仓测试文件做扫描；其**已知盲区**在自己文件头写明：**跨行调用不覆盖**（`splitArgs` 只做单行切分）。

**抽样核查 24 条**（跨 host/client/shared，均匀取每个文件的第一条）：24/24 都有实质断言（2–18 条 `assert.*`），
且多为"边界 + 缺值 + 反例"三件套（例：`chips.buckets.test.ts` ① 桶数/越界/非法回落/权重守恒 15 条；
`tools/globalFlowView.test.ts` 格式化 18 条；`marketClock.test.ts` R4-A 9 条）。**没有发现"只断言恒真"的用例。**

**残留风险（推断）**：`assertStrength` 的盲区是**多行调用**——例如
```js
assert.equal(
  f(x),
  f(x),      // 自比较但被拆成多行 ⇒ 现有判据扫不到
)
```
**确认方法**：加一条"跨行实参也切分"的样本到该防线的坏样本集，看它是否命中（当前**未确认**是否真存在这种写法）。

### 3.5 稳定性（实测 + 未确认根因）

| 轮次 | 命令（同一份工作区） | 读数 |
| --- | --- | --- |
| 第 1 轮 | TAP 全量 | `# tests 661 / pass 659 / fail 2`（`⑤ 宏观两档…`、`⑥ 源纪律…`，均在 `src/host/globalFlow.test.ts`） |
| 单跑该文件 | 同上文件 | `32/32 pass` |
| 第 2 轮 | TAP 全量 | `661/661 pass` |

**结论（已复核）**：解释 ① 成立 —— 评估期间另一路正在改这两个文件（`src/host/globalFlow.ts` 与其测试），第 1 轮读到的是"半写状态"。
**在 v0.90.0 提交后的干净树上复跑**：`ℹ tests 661 / pass 661 / fail 0`（实测）⇒ **不是用例间耦合，也不是 flake**。
**残留建议**：把"跑门禁前先确认工作区静止（无并发写）"写进流程 —— 否则读数会像本次这样先红后绿，浪费一轮排查。

---

## 4. 构建与发布纪律

### 4.1 `build.mjs` 的 73 条锁定片段（实测）

**证据**：`node /tmp/eng-frag2.cjs`（按 `build.mjs` 的三形态转义规则计数）⇒

- **片段数 = 73**，与构建日志 `客户端片段校验通过：73 项` 一致 ✓；
- **产物里出现 0 次的片段 = 0 条** ⇒ **没有"锁着已删功能"的片段**（若有，构建会直接失败——机制自洽）；
- **锁的强度分布**：`n=1`（唯一出现，最强）**29 条**；`n=2–3` 24 条；**`n≥4`（弱锁）20 条**。

**弱锁 Top（出现次数越多越弱）**：

| 次数 | 片段 | 它想锁的东西 |
| --- | --- | --- |
| 29× | `板块` | 自定义通道卡片标记 |
| 12× | `隐身` / `不适用` | 三档视图 / 指数期货除权口径 |
| 9× | `前复权` | 详情图默认复权口径 |
| 8× | `数字模糊` | 截图保护开关 |
| 7× | `¥••••` | 隐身模式金额遮罩 |
| 6× | `复盘` / `振幅` / `tw-wlist` / `tw-poslist` | 复盘态 / 缩略图读数 / 宽屏多列容器 |
| 5× | `自定义通道` / `护盘信号` / `不含 ` / `本地缓存` / `复权口径` | — |
| 4× | `面板不透明度` / `无行情源` / `不复权` / `sidebar.panellist` / `slots.register` | — |

**影响**：这些片段**删掉它想守的那一处 UI 时构建仍会通过**（字符串在别处也出现）⇒ 锁形同虚设（例如 `板块` 29 次，
"自定义通道卡片标记"消失完全不会被发现）。
**建议动作**：把 `n≥4` 的片段改成**带上下文的唯一子串**（例如 `板块` → `'板块'` 所在标签的整句，
如 `'自定义通道' + '板块'` 的相邻文本；`隐身` → `'隐身'` 与三档段控的 `aria-label` 连写）。
**风险**：低（只改断言字符串）；**收益**：这 20 条从"装饰"变成"真锁"。**未确认**：哪些弱锁是**故意**用宽字符串（容忍文案微调）—— 建议在片段表里加注释区分意图（现有注释多数写了"锁什么"，但没有写"为什么用这么短的串"）。

### 4.2 `lib/` 与 `src/` 的版本一致性机制（实测）

- **机制**：`build.mjs` 用 `define: { __TW_VERSION__: JSON.stringify(pkg.version) }` 注入（`build.mjs:68`、`:81`），构建末尾**校验产物含版本号**
  （`build.mjs:193-197`，失败即 `exit 1`）；版本来自 `package.json`（`build.mjs:36-37`）。
- **当前读数**：`package.json.version = 0.89.0`；`lib/client.js` 里 `0.89.0` 出现 2 次 ✓、`lib` 的 mtime（今天 21:44）**晚于全部 `src/**`**
  （`find src -newer lib/client.js | wc -l` ⇒ 0）⇒ **产物未落后于源码**（实测）。
- **版本 / CHANGELOG / 提交三者已同步（v0.90.0 提交后复核）**：`package.json = 0.90.0`、`CHANGELOG.md:14` 有 `## v0.90.0` 条目、
  `c32bc59` 的提交标题也是 v0.90.0 ✓（**实测**）。
  ⚠ **评估中途它们曾不同步**（CHANGELOG 已有 v0.90.0 而 `package.json` 仍 0.89.0、HEAD 仍 v0.89.0）—— 那是"先写记录、后发版"的中间态；
  **当时若重启 `dsh web`，宿主会装载一个"版本号 0.89.0 但含 v0.90 代码"的产物**（推断，风险中）。
  **建议（流程）**：把"升 `package.json` → 跑 `npm run check`（含构建）→ 确认产物版本号 → 再重启/发布"当成一个原子动作。

### 4.3 `package.json` 脚本清单（实测：无失效项）

| 脚本 | 指向 | 存在性 |
| --- | --- | --- |
| `build` | `node build.mjs` | ✓ |
| `typecheck` | `tsc --noEmit -p tsconfig.json` | ✓（`tsconfig.json` 存在，`noUnusedLocals`/`noUnusedParameters` 已开） |
| `test` | `node --test --experimental-strip-types "src/**/*.test.ts"` + `TZ=UTC` 第二轮 | ✓（两轮 ⇒ 时区回归） |
| `check` | `typecheck && test && selftest && build` | ✓（**注意：`check` 会构建**，本轮按约束未在工作区跑） |
| `selftest` | `node src/host/selftest.ts` | ✓ 文件存在 |
| `install:profile` / `uninstall:profile` | `bash scripts/install.sh` / `uninstall.sh` | ✓ 两个脚本都在 |
| `calendar:check` | `node src/host/calendarCheck.ts` | ✓ |
| `macro:archive` | `node --experimental-strip-types scripts/macro-archive.mts` | ✓ |

- `main: lib/index.js` ✓ 与构建产物一致；`type: module` ✓ 与 ESM 产物一致；`files` 里的 `locale/` 目录**确实存在** ✓；
  无 `prepare`/`prepublishOnly`（发布靠手工）—— **建议**（可选）：加 `prepublishOnly: npm run check`，让"发布必过门禁"变成机制（**风险**：低，但会改变发布习惯，需用户确认）。

---

## 5. 文档权威性

### 5.1 同一事实的"权威处"是否唯一（实测）

| 事实 | 出现处 | 权威性判定 |
| --- | --- | --- |
| **七行清单** | `README.md:384-386`（并**明确声明**权威 = `cordis.patch.yml:53-75`）；`cordis.patch.yml:5-13`（注释表）；`docs/DESIGN-SUBPLUGINS.md:3,61-70` | ✓ **好实践**：README 指明单一权威；且 `:53-75` 行号实测仍对得上（`sed -n '53p'` ⇒ `- insert:`） |
| **路由/工具归属** | ①`src/index.ts:32-68`（代码，事实源）②`docs/DESIGN-SUBPLUGINS.md` §2.1/§2.2 ③`cordis.patch.yml:5-13` 注释 ④`src/index.test.ts:317-330`（副本） | ⚠ **四处**，且 ②③ 都已漂移（§2.3 D1/D2/D4）⇒ **建议**：在 §2.1 表头声明"本表是 `src/index.ts` 的镜像，冲突以代码为准"，并给 ②③ 加同步断言（可扫注释文本） |
| **数据文件清单** | `README.md:190-216`（表）+ 代码里的字面量 | ✓ v0.87 起**已有断言**（`uiuxDiscipline.test.ts` ⑥：宿主每个 `*.json` 必须出现在表里） |
| **测试条数** | `README.md`/`CHANGELOG.md` 少提具体数；多出现在 `docs/AUDIT-*.md`（历史） | ✓ 现状不重复；**但**历史审计里的数字（如 `AUDIT-IMPL35.md:4` 的"412 × 2"）没有"历史快照"标注 ⇒ 见 §5.2 |
| **「不做账号体系」** | `README.md`（明确不做）+ `docs/ROADMAP.md:244` + `docs/DECISIONS.md:742` | ✓ 三处口径一致；`README.md:442` 指向 `docs/DECISIONS.md` 作为完整决策记录 ⇒ 权威链清楚 |

### 5.2 过期或易误读的段落（实测）

| 位置 | 内容 | 问题 | 建议 |
| --- | --- | --- | --- |
| `docs/DESIGN-SUBPLUGINS.md:162` | "路由账 24 = core 16 + calendar 1 + watchlist 3 + portfolio 2 + market 2 + cloudmap 0" | 实测 26 / core 15 / market 4 / +tools 1（§2.3 D3） | 更新或标注时点 |
| `docs/AUDIT-IMPL35.md:1-101` | 通篇"六行"（该文件是六行时代的审计） | 现在七行；文件名/标题都没有"历史"标记 | 加页眉"（历史快照：v0.59–v0.70，六行时代，勿作现状依据）" |
| `docs/AUDIT-IMPL45.md:6` | "静态饼图 / 市场表（份额+变化）/…固定 180 日；不做自动播放" | v0.85 已改成 横条 + 实心饼 + 播放按钮 + 默认 365 | 同上（历史标记）；若这段被引用为"现状"，会直接误导 |
| `docs/AUDIT-IMPL46.md:316`、`47.md:210/239`、`HY4-1.md:148` | "曲线 180 个序列日（实测 1 / 重建 179）" | 同上：默认档已 365 | 同上 |
| `docs/DECISIONS.md:1,3,5,7` | 连续 4 行 H1（"历史记录，不适用 STE 规范。" 重复 3 次 + "决策与历史过程…"） | 文档结构噪音；渲染出多个一级标题 | 合并为一个 H1 + 一行说明 |
| `docs/DESIGN-TOOL-PAGE-ALIGN.md` §13 vs §14 | §13 是评估线在 21:2x 的读数（含"仍红 1 条"），§14 是收口终态 | 已**显式**写"冲突以 §14 为准" ✓ | 无需改（可作为"如何处理同一文档内新旧读数"的范例） |

### 5.3 权威性建议（一句话版）

在 `docs/DESIGN-SUBPLUGINS.md` §2.1 表头加一行：**"本表是 `src/index.ts` 的 `ROW_ROUTES`/`ROW_TOOLS` 的镜像；
归属判据见 §2.2；冲突以代码为准，改代码时同步本表 + `cordis.patch.yml` 注释 + `src/index.test.ts` 副本"** —— 四处同源的漂移问题就变成了"有明确同步清单"的机械动作。

---

## 6. 最值得做的三项

| # | 事项 | 为什么值得做 | 成本 | 风险 |
| --- | --- | --- | --- | --- |
| **1** | **给 `ROW_ROUTES/ROW_TOOLS` 建立"真表 → 测试副本/文档/注释"的同步断言**（§1.2 第三行、§2.3 D5） | 归属错配是**用户可见**故障（关某行 ⇒ 别的页面 404），而判据本身有一套很好的规则（§2.2）；现在唯一的缺口是"真表变了没人拦" | 小（一条 `deepEqual` + 3 处文档同步清单） | 低 |
| **2** | **把 20 条弱锁片段改成唯一子串**（§4.1） | 构建期的 73 条片段是"少了一段 JSX"这类事故的唯一拦截网；其中 20 条现在**拦不住**（`板块` 出现 29 次） | 中（逐条挑唯一上下文，需回看源码文案） | 低（只动断言字符串；改完必须跑一次构建确认不误报） |
| **3** | **清理/标注历史审计文档 + 归并导出面**（§5.2 + §1.1A/B） | ①权威性：历史文档里的"180 日/市场表/六行/24 条路由"会被当成现状引用；②导出面：25 条新增导出里 19 条不必要、3 条疑似死代码 —— 都是"下一个人被误导"的成本 | 小–中（文档加页眉是分钟级；导出清理需逐个文件改 `export` 并跑门禁） | 低（B 类里的 2 条在**未提交改动**里 ⇒ 先与 v0.90 实现线确认） |

---

## 附录 A：本次读数与原始文件

| 文件 | 内容 |
| --- | --- |
| `/tmp/eng-tap.txt` | 第 1 轮 TAP（659 pass / 2 fail，工作区并发编辑中） |
| `/tmp/eng-tap2.txt` | 第 2 轮 TAP（661 pass / 0 fail） |
| `/tmp/eng-exports.tsv` | 导出引用扫描（310 条候选行，含 `src_refs`/`test_refs`/是否新增） |
| `/tmp/eng-cands.tsv` | v0.78.0 后新增且 `src_refs≤1` 的候选 |
| `/tmp/eng-asserts.txt` | 断言强度扫描（661 块 / 无断言 3 块 / 恒真命中 3 处 / 抽样 24 条） |
| `/tmp/eng-route-callers.txt` | 路由 → api 方法 → UI 调用方（粗映射，本报告只采信逐条复核过的行） |
| `/tmp/eng-frag2.cjs`、`/tmp/eng-frag.cjs` | 73 条片段的强度与缺失统计 |

## 附录 B：本报告的**未确认**项（附确认方法）

1. ~~工作区脏 ⇒ 读数与 HEAD 可能不同~~ ⇒ **已在 `c32bc59` 干净树上复核**（测试读数与 B 组死代码结论）；其余小节仍以"脏树 + 干净树"两次读数的一致性为准（两者未发现冲突）。
2. **§3.5 的 2 条红**：是并发编辑还是用例间耦合。确认方法：冻结工作区后连跑 3 轮 + `--test-concurrency=1` 对照。
3. ~~`macroHistory`/`macroReadFailures` 是否 in-flight~~ ⇒ **已确认：死代码**（v0.90.0 上复核，外部引用 0 / 同文件用量 0）。
4. **`n≥4` 的弱锁是否有意为之**（§4.1）。确认方法：查这些片段的引入提交信息/注释意图。
5. **`assertStrength` 的多行盲区是否真有漏网**（§3.4）。确认方法：把多行自比较样本加进它的坏样本集，看是否命中。
