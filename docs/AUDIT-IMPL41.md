# AUDIT-IMPL41 —— 取数层全量修复（AUDIT-CACHE-1 / -2 已发现问题）

- 基线：`main` @ `24936cd`（v0.66.0）；本报告是**唯一**由本任务写入的文档
- 修复面：`src/host/em.ts`、`src/host/breadthCount.ts`、`src/host/routes.ts`、`src/host/rescue.ts`、
  `src/shared/model.ts`（+4 个可选字段）、新增断言文件 `src/host/fetchDedupe.test.ts`
- 计数装置：`/tmp/impl41/`（隔离 `DSH_HOME=/tmp/impl41/home-*`，`fetch` 拦截 + 合成 fixture，**不碰真实网络**）
- 未提交、未装 bundle、未动 profile、未重启用户的 `dsh web`（3080 仅只读探测）

---

## 0. 一句话

**七条修法全部落地**（P0-1/P0-2/P1-1/P1-2/P1-3/P2-1/P2-2 ＋ 稳态命中率根因、收盘后时段判断、采样器复用缓存），
每条的**上游请求数**都有"改前 → 改后"实测：**分时并发 8→1、分布 112→56、行情稳态 6→3、收盘后 6→1、
熔断全开时 `/kline` 6→0、行业榜 5→1（不退化）、采样器 3→1**，另加分布扫描墙钟 **5855ms → 1246ms**（并发峰值 1 → 6）。
**`npm run check` 全绿：EXIT=0，473/473 × 2 时区 + selftest + build**（末尾三行见 §4.1）。
（中途它曾被 `fix-store-lock` 的 `lock.test.ts:101` 抖动挡住，对方 16:16 修好后即全绿；取证见 §7.3。）

---

## 1. 逐条修法（文件:行号）

| # | 问题 | 改法（位置） | 关键约束 |
|---|---|---|---|
| **P0-1** | 分时并发不合并（并发 8 ⇒ 8 次上游） | `em.ts:1084` 新增 `trendInflight`；`em.ts:1106-1153` 把**回源段**（上游 → 活的备用源 → LKG 判定与写缓存）套进在飞合并；命中新鲜缓存/休市定稿的快路径不进队列 | 只合并"同一份 loader 在飞"；LKG 的 20s 短 TTL 语义不变 |
| **P0-2** | 同一次 `/breadth?dist=1` 把**同一份 56 页**扫两遍（源 B + 涨跌分布） | `em.ts:2263-2265` 给 `fetchClistPctPage` 加 **20s 页级短 TTL**（键 `clist-pct:<pn>:<pz>`），`em.ts:2272-2290` 包住取数；两条链路共用同一份页 | 窗口必须 < 分布快照的 60s 口径（截面语义） |
| **P1-1** | 源 B 失败无负缓存 ⇒ 每次调用重跑 56 页循环（抢半开探针名额） | 两层：① 页级负缓存 `em.ts:2264,2271-2275,2292-2296`（15s + 原因）；② **结果级**负缓存 `breadthCount.ts:27,485-492,553-562,585`（`BreadthCountCache.getFailure/setFailure`，30s + 原因） | 窗口 ≤60s、成功即清负缓存，恢复后的第一次请求不被挡 |
| **P1-2** | 分布扫描**串行** 56 次（100ms 延迟 ⇒ 5.9s） | `routes.ts:44-46,82-103` 改为**有限并发 6** 的 worker 池；页数上限与源 B **共用 `BREADTH_CLIST_MAX_PAGES`**（`routes.ts:44`） | 红线不变：超上限/中途失败/上游未给总数 ⇒ `counts: null` + 原因，绝不给部分分布冒充全市场 |
| **P1-3** | 日K 绕过熔断器（`allOpen=true` 时一次 `/kline` 仍发 6 条、`trips/fails` 一字不变） | `em.ts:1939-1962` 新增 `fetchHostThroughBreaker`（放行判定 + 半开探针名额 + 成功/失败记账，与 `fetchAny` 同源）；`em.ts:1973` 的 `requestKlineRaw` 改走它；`em.ts:1923-1932` 新增 `UpstreamCoolingError`；`em.ts:2208-2214` `refreshKline` 识别"冷却"⇒ **不写负缓存**（否则一次冷却把该标的锁 1 小时） | 腾讯不覆盖的标的（商品主连 / `100.*` 外盘）行为不变：冷却结束后 1 条探针即恢复（实测拿到 240 根） |
| **P2-1** | 行业榜为 1 个板块翻 5–8 页 | `em.ts:2411,2431-2478` `industryBoardPctMap(wanted)`：**要的名字都定位到就停翻** + 结果缓存 30s + 在飞合并；`em.ts:2489` 调用处只传需要的名字 | 定位不到就照实 `pct: null`（不用别的板块顶替）；名字在第 5 页时仍翻 5 页（不退化） |
| **P2-2** | `peekCache(key, 45_000)` 把 60s TTL 拉成 ≈105s | `em.ts:60-74` 删除隐式宽限，改 `readFresh`（严格 `now < exp`）；写缓存处不再带 `grace`（`em.ts:1141,1148`） | TTL 就是字面值；要提前复用就调 TTL 本身 |
| **稳态 0% 命中** | 服务端槽 TTL **等于**客户端轮询间隔 ⇒ 每拍必回源 | `em.ts:792-797` `quoteSlotTtlMs() = 间隔 + max(1s, min(5s, 20%×间隔))`；`em.ts:864` 槽写入用它 | 余量只有**一档** ⇒ 数据最坏只旧一拍（≤ 客户端间隔），界面"数据时刻"仍取行内 `at`/`asOf` |
| **收盘后仍拉** | `loadQuotes` 无时段判断 | `em.ts:798-806` `frozenOfflineSlot`：沪/深（`1.`/`0.`）槽的观测时刻已越过最近收盘（15:05）⇒ 复用、零回源；`em.ts:830-833` 两处槽判定都走它 | **只冻 A 股**：外盘/商品（`100.*`/`101/112/113/114/122.*`）/美债（`171.*`）交易时段不同，仍按 TTL 轮询 |
| **采样器绕过行情缓存** | `rescue.ts:634` 直调 `fetchAny`，与行情条互不命中 | `em.ts:942-944` 新增 `loadQuoteRowsShared`；`rescue.ts:852-880` `fetchQuoteSource` 改走它；`QUOTE_FIELDS` 并入 `f62,f66`（`em.ts:208-217`）、`f8/f10/f62/f66` 解析进 `QuoteRow`（`em.ts:461-468`、`shared/model.ts` 四个可选字段）；删除采样器自己那条 `fetchRescueQuotes` | `source !== 'em'` 的行分单资金流按 `null`（备用源没有）；**只剩 LKG 时不记样本**（与从前"两源都失败就抛"同语义） |

| **加锁前置** | 三个 LKG + K 线缓存落盘是**裸 `writeFile`**（连原子都不是） | `em.ts:21` 引入 `writeFileAtomic`；`em.ts:276`（`quotes-lkg.json`）、`734`（`board-lkg.json`）、`1054`（`trends-lkg.json`）、`1782`（`klines/<secid>_<klt>_<fqt>.json`）改为 **tmp + rename** | 序列化**逐字节不变**（compact，不换缩进——4MB 级 trends-lkg 不值得为好看翻倍）；半截 JSON 会被读侧当成"没有缓存"⇒ 白拉一遍上游，正是本轮要减少的请求 |
> 说明：`build.mjs` 锁的是**客户端片段表**（`REQUIRED_CLIENT_SNIPPETS`），本任务只改宿主侧 + 一个测试文件，
> 构建校验 73 项照常通过（`built lib/index.js + lib/client.js …客户端片段校验通过：73 项`）——**未触碰 build.mjs**。

---

## 2. 改动前后的上游请求数实测（核心指标）

**测量口径（全部一样，可复算）**
- 装置：`/tmp/impl41/{fixtures.mjs,scenarios.mts,run.sh}`；运行器 `run.sh before|after <场景>`。
- **隔离**：每次运行都 `DSH_HOME=/tmp/impl41/home-<tag>-<场景>`（跑前 `rm -rf` 重建）；脚本内硬断言
  `DSH_HOME.startsWith('/tmp/')`，不满足直接拒绝运行。**从未写过 `~/.dsh`**。
- **计数**：包一层 `globalThis.fetch`，按 host+path+query 逐条记录（不是 `asOf`、不是 mtime、不是日志行数）。
- **上游**：合成 fixture（沪深A股 `total=5513`、每页 100 行 ⇒ 56 页；行业榜 `total=496`（与用户
  `board-lkg.json` 实测一致）；分时 242 点；日K 800 根）；**零真实网络**。
- **时钟**：`Date.now` 钉在 2026-10-12（周一）10:30（盘中）或 15:09（收盘后），需跨 TTL 时显式推进。
- **改前**：`git archive HEAD` 导出的独立副本 `/tmp/impl41/before`（`24936cd`，与我的改动无关）。

| 场景 | 改前 | 改后 | 口径（怎么数的 / 窗口） |
|---|---|---|---|
| **P0-1** 分时并发 8 同 `secid`（冷） | **8** 条 `trends2` | **1** 条 | 8 个 `Promise.all(fetchTrend('1.600519',1))`；8/8 都拿到 242 点 |
| **P0-2** `/breadth?dist=1`（源 A 缺失） | **112**（56 唯一 URL ×2） | **56**（＝唯一 URL 数，已是下限） | 一次路由调用内的 `clist` 请求数与唯一 URL 数；**两侧的分布结果都照常给出**（`scanned=5513`、`counts` 非空、`reason=null`）——共享页缓存没有吞掉结果 |
| **P1-2** 分布扫描墙钟（人工上游 100ms 延迟） | **5855ms**，并发峰值 **1** | **1246ms**，并发峰值 **6** | `hrtime` 墙钟；两侧 `scanned=5513`（扫全，红线未破） |
| **稳态** 引擎 10s 一拍、连打 6 拍 | **6**（每拍 1） | **3**（1,0,1,0,1,0） | 9 个 A 股标的，每拍推进 10s |
| **时段** 收盘后（15:09）6 拍（A 股） | **6** | **1**（首拍取一次，其余 0） | 同上；时钟钉在当日 15:09（15:05 收盘后） |
| **时段** 收盘后混合集（A 股+外盘+商品）3 拍 | 3 | 2 | 外盘/商品仍按 TTL 轮询（**设计如此**，不用 A 股时段冻住它们） |
| **P1-3** 三台 EM 全熔断时一次 `/kline`（`114.lhm`） | **6** | **0** | 先用 3 次 `trends2` 失败把三台推入冷却（`trips=1`），再取数 |
| **P1-3** 冷却结束后取同一标的 | — | **1** 条探针 ⇒ **240 根** | 半开探针成功即恢复（腾讯不覆盖的标的未退化） |
| **P1-3** EM 不可达时一次 `/kline`（记账） | 6 条，`trips/fails` **0/0 不变** | 6 条，`fails=2/台` | "熔断器看不见这条链路"的镜像证据 |
| **P1-3** 连续 3 次 `/kline`（EM 不可达） | **6,6,6**，`trips` 恒 0 | **6,3,0**，`trips=1`（全熔断） | 第 3 次起不再打上游 |
| **采样器** + 行情条共存 45s（引擎 10s / 采样器 15s） | **8**（引擎 5 + 采样器 3） | **6**（引擎 5 + 采样器 1） | 计数都是 `ulist` 请求；采样器自身 3 → 1 |
| **采样器** 只有采样器（无 UI）3 拍 | **3**（每拍 1） | **3** | 无退化（不依赖 UI 是否存在） |
| **P2-1** 行业榜（要的名字在第 1 页） | **5** 页 | **1** 页 | `fetchIndustryOf` 单标的 |
| **P2-1** 行业榜（名字在第 5 页） | **5** 页 | **5** 页 | 不退化（按需取页不许丢结果） |
| **P1-1** 源 B 失败（每调用前复位熔断，暴露"重跑循环"） | 每次调用 **4** 页尝试（累计 12）；总上游 **27** | 首调 4、第 2/3 调 **0**（累计 4）；总上游 **19** | 逐次调用计数 `clist` 请求（3 次 `GET /tradewatcher/breadth`） |

**每天的量级变化（算术外推，不是实测）**：大盘页开着时，分布扫描 56 条/分钟 → 56 条/分钟
（**但源 B 与分布不再各扫一遍：源 A 缺失时 112/分钟 → 56/分钟**）；行情稳态 6 条/分钟 → 3 条/分钟；
收盘后 A 股 6 条/分钟 → **0**（首拍后）。

---

## 3. 断言与反例注入（每条修法都有一条能抓回退的断言）

新增 `src/host/fetchDedupe.test.ts`（**20 条**，全部走**真实实现 + 真实请求计数/在飞并发计数**，不复制被测逻辑，不碰网络；单文件 20/20 通过）：

| 断言（摘要） | 反例注入（把修法关掉） | 注入后结果 |
|---|---|---|
| P0-1 并发 8 ⇒ `trends2` 恰好 1 条，8/8 拿到数据 | 删除 `trendInflight.get/pending` 分支 | ✖ 失败（`/tmp/impl41/inject/P0-1.log`） |
| P0-2 同一页 20s 内两次 ⇒ 1 条；过 20s ⇒ 2 条 | `CLIST_PCT_TTL_MS = 0` | ✖ 失败（`P0-2a.log`） |
| P0-2 `/breadth?dist=1` ⇒ 56 唯一 URL 且请求数 == 唯一数（改前 112） | 同上 | ✖ 失败（`P0-2b.log`） |
| P1-2 分布扫描：在飞并发峰值 ≥ 3（改前串行 ⇒ 1），且请求数仍 56、`scanned=5513` 扫全 | `DIST_CONCURRENCY = 1`（退化成串行） | ✖ 失败（`P1-2.log`；该用例耗时 291ms → 1247ms，墙钟也印证） |
| P1-1 结果级负缓存：30s 内第二次不再调分页器，过窗口重试 | `getFailure` 恒 `null`（只关结果级） | ✖ 结果级那条失败（`P1-1c.log`）；请求计数那条仍过（页级 15s 仍在挡 —— 这正是两层都存在的原因） |
| P1-1 同上两条 | 两层全关（＝改前行为） | ✖ 两条都失败（`P1-1e.log`） |
| P1-3 三台全熔断 ⇒ 0 请求、返回 `null` | 退回裸 `fetchFromHost` | ✖ 失败（`P1-3a2.log`） |
| P1-3 三次冷取数 ⇒ 熔断器被推起来、第 3 次 0 请求 | 去掉 `breaker.recordFailure` | ✖ 失败（`P1-3b.log`） |
| 稳态 6 拍 ⇒ `[1,0,1,0,1,0]`；`quoteSlotTtlMs() > quoteFreshnessMs()` | `quoteSlotTtlMs()` 直接返回 `quoteFreshMs` | ✖ 失败（`steady.log`） |
| 时段 收盘后 A 股 6 拍 ⇒ 总 1 条 | `frozenOfflineSlot` 恒 `false` | ✖ 失败（`closed.log`） |
| 时段 外盘不受 A 股时段冻结（仍回源） | —— | （正向断言，防"一刀切冻住"） |
| 采样器与行情条共存 ⇒ 采样器 0 请求、`superNet` 来自共用行 | `loadQuoteRowsShared` 先清空槽 | ✖ 失败（`sampler.log`） |
| 共用字段表：引擎那条 URL 就带 `f62/f66/f8/f10` | —— | （防"少一列就取不到资金流"） |
| P2-1 名字在第 1 页 ⇒ 1 页；第 5 页 ⇒ 5 页；30s 内再查 0 页 | 去掉"要的名字都定位到就停翻" | ✖ 失败（`P2-1.log`） |
| P2-2 累计 >60s 必须回源 | 恢复 45s 隐式宽限 | ✖ 失败（`P2-2.log`） |

注入脚本：`/tmp/impl41/inject/run.py`（每次注入前备份、注入后**恢复并校验 md5**；全部输出留存 `/tmp/impl41/inject/*.log`）。
注入产物已全部回滚（`grep` 无残留，见 §6）。

---

## 4. `npm run check`

### 4.1 `npm run check` —— **全绿**（EXIT=0，473/473 × 2 时区）

```
> dsh-tradewatcher@0.66.0 typecheck → 0 error
> dsh-tradewatcher@0.66.0 test
ℹ tests 473   ℹ suites 0   ℹ pass 473   ℹ fail 0      （TZ=Asia/Shanghai）
ℹ tests 473   ℹ suites 0   ℹ pass 473   ℹ fail 0      （TZ=UTC，package.json 的 test 脚本跑两遍）
> dsh-tradewatcher@0.66.0 selftest
ALL HOST CHECKS PASSED (live probes soft)
> dsh-tradewatcher@0.66.0 build
built lib/index.js + lib/client.js （v0.66.0，客户端片段校验通过：73 项）
```

**末尾三行**（构建那一步）：

```
> node build.mjs

built lib/index.js + lib/client.js （v0.66.0，客户端片段校验通过：73 项）
```

（473 条 = 基线 435 + 我新增 20 + 其它批次新增 18。本条 `npm run check` 是在
`fix-store-lock` 于 16:16 修好它那条抖动用例之后跑的，见 §7.3。）

### 4.2 中途观测到的一条跨团队抖动（**已由对方修好**）

`src/host/lock.test.ts:101`（L3）在 15:5x–16:1x 之间会挂：单独跑 5 连绿（11/11），
整套跑两次都挂（`lock.child.ts:99` `JSON.parse` 读到半截文件 ⇒ `SyntaxError`）——
它在"故意去掉锁"的竞态下断言一个具体结果，文件级并行时不稳。
`fix-store-lock` 于 **16:16** 更新了该文件（`ls -la`：`lock.test.ts 16:16:36`），此后整套 473/473 全绿。
取数层全程未参与该文件。

## 5. 未做 / 明确不做的项

| 项 | 原因 |
|---|---|
| **按 (host,endpoint) 细分熔断器** | P1-3 收口到**按主机**的既有熔断器后，理论上存在"clist 挂了、kline 端点其实健康，但该标的因为三台全冷却而暂时取不到"这一副作用（AUDIT-CACHE-2 §3.12 观察过这种"按端点不可达"）。这是"少打上游"与"不误伤健康端点"的取舍，按 Lead 指定的修法（沿用 `fetchAny`/`breakerFor` 模式）先收口；细分熔断器要改 `breaker.ts` 的键语义与 `/health`、界面横幅口径，属另一轮 |
| **行业榜"按名字定位缓存"（真正的 1 页稳态）** | 更优解是"按名字排序 + 二分定位 + 记住页号"或"名字 → 板块代码（`searchapi`/`slist`）后直接取该板块行情"，能把稳态压到 **1 页/30s**。今天东财三台主机整段不可达（`curl` 空回包，与审计期一致）⇒ **无法用真实回包验证新端点/新排序语义**；宁可先落"可验证的按需取页"，并把这条列为待验证项（验证方法：东财恢复后 `curl '/api/qt/clist/get?...&fid=f14'` 看是否真按名字排序 + `ulist.np?secids=90.BK0475` 是否回板块行情） |
| **缺口重试让每轮行情 ×2（AUDIT-CACHE-1 P2-3）** | 报告列为 P2 的"半重复"且 Lead 的清单未列入；本轮未改（改动会把"部分丢码"整行推给 LKG） |
| **隐藏卡片仍被轮询（AUDIT-CACHE-2 C11）** | 由 `fix-store-lock` 批次的 `engineIds` 负责，不在本任务清单 |
| **`/chips` 冷缓存拉 800 根（C14 后半段）** | 两份审计均判为"故意的缓存预热、设计取舍"，不改 |
| **`days`/`lmt`/`fqt`/`klt` 键语义、年K 复用月K** | 审计已判"非缺陷"或"必要重复" |

---

## 6. 纪律与可复算

- **隔离**：所有临时实例/脚本 `DSH_HOME=/tmp/impl41/home-*`；`~/.dsh/dsh-tradewatcher` **本轮零写入**
  （唯一例外是只读 `board-lkg.json` 读了一次 total=496 作为行业榜规模依据）。
- **未提交**：`git status` 里我的改动只在这 6 个文件（`em.ts` / `routes.ts` / `breadthCount.ts` / `rescue.ts` /
  `shared/model.ts` / `chips.test.ts`）+ 新文件 `src/host/fetchDedupe.test.ts`；`build.mjs` 零改动。
- **原子写验证**：`quotes-lkg.json` 落盘后 `JSON.parse` 通过（9 行）、目录内 **0 个 `.tmp` 残留**；
  这是"加锁批次"的前置项（原子写），**加锁本身**要等 `fix-store-lock` 的补丁到位后按它的契约接
  （三处：`rescue.persist` 合并语义 / `saveKlineCache`+`pruneKlineCache` 读-改-写 / 上表四处落盘点）。
- **注入已回滚**：`grep -n "if (false) break\|CLIST_PCT_FAIL_TTL_MS = 0\|CLIST_PCT_TTL_MS = 0\|slot.exp + 45_000\|0 \* BREADTH_COUNT_FAIL_TTL_MS" src/host/{em,breadthCount}.ts` → 无命中。
- **复算命令**（任取两条）：
  ```bash
  bash /tmp/impl41/run.sh before B2 && bash /tmp/impl41/run.sh after B2      # 112 → 56
  bash /tmp/impl41/run.sh before A  && bash /tmp/impl41/run.sh after A       # 8 → 1
  EXTRA="TW_DELAY_MS=100" bash /tmp/impl41/run.sh before B3                  # 5855ms / 峰值 1
  EXTRA="TW_DELAY_MS=100" bash /tmp/impl41/run.sh after  B3                  # 1246ms / 峰值 6
  ```

---

## 7. 时刻敏感用例排查（Lead 追加项）+ 基线"假绿"说明

### 7.1 已修的这条（`src/host/chips.test.ts`）

原用例假设"缓存最后一根未完成 bar 已超 60s TTL、需要回源"，但把缓存的 `updatedAt` 写成
`Date.now() - 10min`：**收盘后**（≥15:05）`isSettledOffline` 判 true ⇒ 走"休市定稿"分支、根本不回源 ⇒ `stale=false`。
改法（**只改测试，不动任何生产逻辑**）：在该用例内把 `Date.now` 钉在北京时间 **2026-10-12 10:30**（连续竞价中），
`finally` 里恢复（`src/host/chips.test.ts:322-337` 与 finally 首行）。

### 7.2 为什么 14:14 的"435×2 全绿"是**假绿**

- 那条用例只有在 **09:25–15:05**（`inSession` 为真）之间才成立；14:14 跑基线时**刚好在窗口内** ⇒ 绿。
- 15:57 再用**干净 HEAD 的独立副本**（`/tmp/impl41/before`，我的改动全部不在）跑同一文件：**16 过 1 挂** ⇒ 与我的改动无关。
- 直接证据：`inSession(now)=false`、`isSettledOffline(now-10min)=true`（现网 15:57）；
  同一份缓存把时钟钉在 10:30 时 `isSettledOffline=false`。
- 教训：**"全绿"必须记录跑的时刻与交易日**；凡断言走 `inSession`/`isSettledOffline`/`lastCloseBoundary`
  分支的用例，必须在用例内**钉死时钟**，否则它在盘外会红、在盘内会掩盖"盘外才暴露"的缺陷。

### 7.3 中途观测到的另一条红（**跨团队**，非取数层；**已被对方修好**）

`src/host/lock.test.ts:101`「L3 反例注入②：只做进程内队列（没有锁文件）同样丢更新」：
- **单独跑**：11/11 过（连跑 5 次，含 4 连绿）；
- **整套跑**：`npm run check` 里两次都挂，`SyntaxError: Unexpected end of JSON input`（`lock.child.ts:99` 的
  `JSON.parse` 读到半截文件）⇒ 该用例在"故意去掉锁"的竞态下断言一个具体结果，**在整套并发（文件级并行）下不稳**。
- 归 `fix-store-lock`；我未改动 `lock.ts` / `lock.child.ts` / `lock.test.ts` / `store.ts`。
- **结局**：对方 16:16 更新后，整套 473/473 全绿（§4.1 的 `npm run check` EXIT=0）。

### 7.4 其余"时刻敏感用例"清单（本次实测扫描，不只靠读代码）

方法：`Date.now` 整体**平移**到指定时刻（`/tmp/impl41/shiftclock.mjs`，保持时钟继续走，避免拖死等时循环），
跑**全仓 61 个测试文件**，比对失败集合：

| 时钟平移 | 结果（不含 `lock.test.ts`） |
|---|---|
| 盘中 2026-10-12（周一）10:30 | **461/461 通过**（当轮口径） |
| 盘后 2026-10-12（周一）23:30 | **461/461 通过**（当轮口径） |
| 周六 2026-10-10 15:50 | 461/461 通过（含当轮新增文件） |
| （含 `lock.test.ts`） | 该文件的 `L5/L6b/L10/L3` 在"时钟平移"下挂 —— **是平移装置自身造成的**：它 spawn 子进程，子进程各自用真实时间重算偏移，而这些用例断言的是**真实墙钟有界等待**；真实时钟下 11/11 全绿 |

⇒ **除已修的 `chips.test.ts:314` 外，没有其它用例依赖"现在是不是交易时段/哪个交易日"**。
静态扫描（`grep -rn "Date.now()\|new Date()" src --include=*.test.ts`）也一致：其余用法都是
"造 fixture 的时间戳"（`p0/p1/p1b/portfolio-cost/trend-fallback`）或"量耗时"（`index/lock`），
`time.test.ts` 则显式传时间戳、本来就确定性。

---

## 8. 顺带发现（供 Lead 处置，未擅自改）

1. ~~`lock.test.ts` 在整套运行时不稳~~ —— **已由 `fix-store-lock` 于 16:16 修好**，`npm run check` 现已全绿（§4.1/§4.2）。
2. **东财今天整段不可达**：`curl push2/push2delay` 的 `ulist/clist/stock/get` 全部空回包（与审计期一致），
   所以本轮**所有**计数都在合成 fixture 上做；东财恢复后建议用 §5 的方法验证"行业榜按名字定位"这条更优解。
3. **`trip` 语义提醒**：`breaker.recordFailure` 每个 `fetchAny` 调用**每台只记 1 次**
   （`em.ts:164-165`），而我把 K 线的**逐主机尝试**也接了记账 ⇒ K 线链路的 `fails` 增长速度与行情链路不同
   （实测：一次冷取数 `fails=2/台`）。这是有意的（否则这条链路的失败对熔断器永远不可见），已在 §1 与
   断言里写明；若要统一到"每次调用每台 1 次"，改 `fetchHostThroughBreaker` 的记账点即可。
