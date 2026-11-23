# AUDIT-HOST-PERF — 宿主层性能 / 正确性 / 资源审计（v0.214.0）

> **只读审计，不改代码。** 本轮只新增本文件；未改 `src/**`，未 commit，未重启。
> **基线**（任务给定）：`npm run check` 1811/1811 全绿、构建 73、v0.214.0（`67cdde3`）、工作树干净。
> **范围**：`src/host/**` + `src/shared/**`（87 个非测试文件 / 38 916 行；另有 24 074 行测试只作对照，不计入结论）。
> **审计时刻**：2026-11-23 12:20 前后（北京时间，午休段）。本轮**未向任何上游发请求**，所有"实测"都是本机文件 + Node 微基准，不是线上流量。
> **快照说明**：审计开始时工作树是干净的；中途出现另一位执行者的未提交改动（`M src/client/PrismPage.tsx`、`M src/client/RescuePanel.tsx`、若干新增 client 测试与 `docs/AUDIT-CLIENT-PERF.md` / `docs/AUDIT-TESTS-PERF.md`）。**不在本审计基线内，我没有触碰它们**，本文所有行号仍对 `67cdde3` 成立。

---

## 一行结论

**发现 3 条 P0：棱镜撮合可重入 + 三份账本非事务写（会丢/错成交）、棱镜读失败被当成空库后自动覆盖（会抹掉账户）、汪汪队 2 年窗口冷启动 ≥62.5 秒且同步解析 571ms 阻塞事件循环；另有 9 条 P1，最大的是 `dayTradesOf` 每笔流水新建 Intl（实测 38–90 ms/次 `/portfolio`，复用格式化器可降到 ~8 ms）与 `rescue-log` 每分钟整份 7.7 MB 合并重写（126 ms CPU + ≈15 MB 读写/分钟）。**

| 级别 | 条数 | 说明 |
|---|---|---|
| **P0** | **3** | 静默错数 / 用户数据被覆盖 / 路线必然超时并阻塞事件循环 |
| **P1** | **9** | 稳定可感知的浪费或隐患（含一条条件性错数：宿主 TZ≠Asia/Shanghai） |
| **P2** | **8** | 余量、重复 IO、可维护性；单条小，叠加后放大 P1 |
| 合计 | 20 | |

---

## 二、方法与量级

- 镜像里**没有 `rg` 二进制**（`command -v rg` 为空），用等价的 `grep -rn` / Python 正则完成同一组扫描：
  `for`/`while` 内 `await`、`new Map()`、`setInterval`、`catch {}`、`Date.now()`、`readFileSync`+`JSON.parse`、`toLocaleDateString`、`JSON.parse(JSON.stringify`。
- 读代码为主；热点路径按"每次请求/每个定时拍"逐层展开到上游调用次数。
- **量化来源**：
  1. 本机真实数据目录 `~/.dsh/dsh-tradewatcher/`（只读）：`dogwatch/` 512 个 `shares-*.json`（9.6 MiB）、`rescue-log.json` 7.7 MB、`ledger.json` 367 条、`prism-orders.json` 171 委托 / 394 成交、`klines/` 222 个文件（20 MB）。
  2. Node 微基准（附录 A 给出原文与输出）：同步 `readFileSync+JSON.parse` 512 文件 = **571.1 ms**；`rescue-log.json` parse 73 ms + stringify 53 ms；`dayTradesOf(367 条)` = 首调 **90.2 ms** / 热 **38.0 ms**；`toLocaleDateString` 3 000 次 **824 ms** vs 复用格式化器 **64 ms**；无偏移 `Date.parse` 与 `+08:00` 差 **8 h**。
- 分级口径（沿用仓库既有审计）：
  - **P0**：会稳定产生错误数据、覆盖用户数据，或让一条真实路线必然超时/卡死；
  - **P1**：明显低效、无界资源、或特定但真实的部署/操作条件下出错；
  - **P2**：余量、重复劳动、可维护性。

---

## 三、P0（3 条）

| # | 严重度 | 问题 | 证据（文件:行 + 片段） | 影响（量化） | 建议修法 |
|---|---|---|---|---|---|
| P0-1 | **P0** | **棱镜撮合可并发重入，且三份账本各写各的（非事务、忽略磁盘）**。`PrismScheduler` 每 30 s 无条件 `void match()`，没有在飞闸；手动 `action:'match'` 也能同时进来。`matchTick` 从内存快照读 account/orders/fills，末尾分三次写回；`saveOrders` 的锁内回调**直接返回内存数组**，不读磁盘合并；三处写都 `.catch(()=>undefined)`。 | `prismScheduler.ts:252-254`<br>`if (this.opts.match !== undefined) {`<br>`  try { void Promise.resolve(this.opts.match()).catch(() => undefined) }`<br><br>`prismAccount.ts:1052-1054`<br>`const account = rollDay(store.account(), …)`<br>`const orders = store.orders().map((o) => ({ …o }))`<br>`const fills = store.fills().slice()`<br><br>`prismAccount.ts:1177-1179`<br>`await store.saveAccount(account)`<br>`await store.saveOrders(orders, fills)`<br><br>`prismAccount.ts:534-537`<br>`this.ordersValue = orders`<br>`await updateJsonLocked(…, () => ({ v: 1, orders, fills }))` | 两轮并发都从同一 `fills` 基线出发：后写者用自己的数组覆盖前者，**account 与 fills 可能来自不同轮次**（钱扣了、流水没有；或反之）。一轮 10 笔挂单 = 10×(1 次行情 + 1–2 次分钟线) = **20–30 次上游/30 s**；单笔最坏 ≈25 s（quotes 12 s + bars 8 s×2 源），30 s 节拍下重入是现实场景。当前数据：171 委托 / 394 成交 / 11 持仓。 | `matchTick` 外包单飞 + `withFileLocks(['prism-account.json','prism-orders.json','prism-equity.json'])`，锁内「读磁盘最新 → 撮合 → 一次写三份」；`saveOrders` 的 update 回调必须用 `disk` 合并；写失败抛出而不是吞。 |
| P0-2 | **P0** | **棱镜账本"读不到/读坏了"被当成空库，写路径不拦**。`readJson` 用 `readJsonForUpdate(file,'null')`：**损坏 JSON 也返回 null 并 `guard.clear`（连 warn 都不打）**；I/O 错误只 `markUnreadable`。`init`/`reloadOrders` 把 null 当空，`saveAccount`/`saveOrders`/`saveEquity` 写前从不 `assertWritable`（对比 `store.ts` 的 `persist` 有这条）。`accountWriteGuard` 只看内存 `oldHasData`，内存已是空 ⇒ 不触发。 | `prismAccount.ts:469-482`<br>`const disk = await readJsonForUpdate(file, 'null')`<br>`this.guard.clear(file)`<br>`return disk`<br>`} catch (error) { … this.guard.markUnreadable(file, error) … }`<br><br>`prismAccount.ts:512-521`<br>`const fileOrders = Array.isArray(ordRoot?.orders) ? … : []`<br>`this.ordersValue = fileOrders.length > 0 ? fileOrders : embeddedOrders`<br><br>`prismAccount.ts:524-537`<br>`async saveAccount(…) { … await updateJsonLocked(…).catch(() => undefined) }`<br>`async saveOrders(…) { … }`<br><br>`index.ts:276-283`<br>`await k.prismTrading.init().catch((error) => log(…))`<br>`… k.prismScheduler.start()` | 文件损坏/权限错误后，**下一次自动撮合（≤30 s）把空 orders/fills 写回**；当前 171 委托 / 394 成交 / 11 持仓会在 30 s 内归零，且因为内存已空，`accountWriteGuard` 不会阻止。与仓库 R1 红线（`readGuard.ts:1-20`「读不到 ≠ 没有」）直接冲突——`store/calendar/fupan/leverage/globalFlow` 都做了，棱镜漏了。 | `readJson` 对 `SyntaxError` 也 `markUnreadable`；三个 save 前 `this.guard.assertWritable(file,'写回棱镜账本')`；`init()` 失败时置 `tradingDisabled`，撮合直接跳过（fail closed）。 |
| P0-3 | **P0** | **汪汪队 2 年窗口冷启动 ≥62.5 s，且请求内同步解析 512 个文件**。`mapWithConcurrency(items, 4, 120, fn)` 的 120 ms 是**逐条** sleep（不是"批间"）；`fetchDogwatch` 对 1y=271 / 2y=521 个交易日直接用它。`readDiskShares` 在循环里 `readFileSync` + `JSON.parse`。 | `dogwatch.ts:326-337`<br>`while (i < items.length) {`<br>`  out[idx] = await fn(items[idx] as T)`<br>`  if (gapMs > 0 && i < items.length) await new Promise((r) => setTimeout(r, gapMs))`<br>`}`<br><br>`dogwatch.ts:441-455`<br>`const days = Math.max(21, DOGWATCH_WINDOWS[window] …) + 21`<br>`const perDay = await mapWithConcurrency(tradingDays, 4, 120, async (day) => {`<br>`  const disk = readDiskShares(day)`<br><br>`dogwatch.ts:242-252`<br>`JSON.parse(readFileSync(sharesCachePath(day), 'utf8'))` | 2y：**521 × 120 ms = 62.5 s 纯等待**（1y 32.5 s），客户端 `REQUEST_TIMEOUT_MS=15_000`（`src/client/api.ts:268`）必然超时；512 个缓存文件同步 parse 实测 **571 ms** 阻塞整个宿主事件循环（9.6 MiB / 207 536 条份额行）。首次无磁盘缓存时还要 **521 次上交所请求**（每天一次 `STAT_DATE`）。 | ① 120 ms 改到"每批完成后"或直接删掉（SSE 支持 `pageSize=2000`，一天一次即可）；② 磁盘缓存启动时一次性构建 `Map<day, rows>`（异步），请求内不再碰 `readFileSync`；③ 2y 冷启动改后台任务 + 进度/部分结果，别占住 HTTP 请求。 |

---

## 四、P1（9 条）

| # | 严重度 | 问题 | 证据（文件:行 + 片段） | 影响（量化） | 建议修法 |
|---|---|---|---|---|---|
| P1-1 | **P1** | **北京时间墙上字符串用无偏移 `Date.parse` 解析（宿主时区依赖）**。腾讯 A股/港股行情时间 `YYYYMMDDHHMMSS` / `YYYY/MM/DD HH:MM:SS` 拼成 `YYYY-MM-DDTHH:MM:SS` 后直接 `Date.parse`；东财分时 `YYYY-MM-DD HH:mm` 与腾讯 5 分钟线同样处理。 | `tencent.ts:270-276`<br>`if (t.includes('/')) { const parsed = Date.parse(t.replace(/\//g, '-')) … }`<br>`const iso = \`${t.slice(0,4)}-…\``<br>`const parsed = Date.parse(iso)`<br><br>`em.ts:1338`<br>`const t = Date.parse(timeText.replace(' ', 'T'))`<br><br>`em.ts:2130`<br>`const t = Date.parse(label.replace(' ', 'T'))` | 宿主 `TZ!=Asia/Shanghai`（Docker/云主机默认 UTC）时：`QuoteRow.time` 比真实晚 **8 h**，顶部「行情 HH:mm:ss」直接显示错值（`src/client/TopBar.tsx:180-181` 消费）；`trendLagOf` 的 `now - last.t` 变负 ⇒ **滞后告警永不触发**；东财分时 `t` 也偏 8 h。`npm test` 的 TZ=UTC 双跑没有覆盖：`usQuote.test.ts:122` 是 `parseTencentStamp(...)` 自比较。反例：`auctionSeries.ts:27-36` 的 14 位时间戳已显式走 `parseMarketStamp`，证明正确写法就在仓库里。 | 三处统一改走 `parseMarketStamp`（tencent.ts 已 import time.ts 的其他函数）；补断言 `parseTencentStamp('20260924093817') === Date.UTC(2026,8,24,1,38,17)` 并在 TZ=UTC 下跑。 |
| P1-2 | **P1** | **两个只增不减的 Map**：`em.cache` 是普通 `Map`，`readFresh` 只判过期不删；`trendCacheKey` 带 `dayOf(now)` ⇒ 每个交易日每个标的产生**新键**，旧键永不命中、永不删除。`klineMem` 同样只 `set` 不 `delete`。 | `em.ts:59-70`<br>`cache.set(key, { exp: Date.now() + ttlMs, value })`<br>`em.ts:87-91`<br>`const slot = cache.get(key); if (slot === undefined …) return undefined`<br>`em.ts:1448-1450`<br>`return \`trend:${secid}:${ndays}:${dayOf(now)}\``<br>`em.ts:2429` / `2784`<br>`const klineMem = new Map<string, KlineEntry>()` / `klineMem.set(key, entry)` | 42 只自选 × 2 档（ndays 1/5）≈ **84 条/日**；242 点 TrendData ≈25–30 KB ⇒ **2–2.5 MB/日、60–75 MB/月**，且永不释放。`klineMem` 现有 222 个文件 × ≈90 KB ≈ **20 MB**；磁盘裁剪到 300 个文件后，被删文件的条目仍留在内存（`cache.delete` / `klineMem.delete` 全仓 0 处）。`docs/REVIEW-7-HOST.md:392` 已记 `klineMem`（E5，仍未修）；**`trend:` 日键这条是本轮新增**，量级远大于已知的 `suggest:`（E4）。 | `cache` 换成「TTL + 最大条数 LRU」（如 2 000 条）；`trend:` 键跨日复用一份、或每日 `cache.delete` 前一天；`klineMem` 加 `KLINE_MEM_MAX`（如 300）并按访问序淘汰。 |
| P1-3 | **P1** | **行业归属 N+1**：`fetchIndustryOverview` 对每个 secid 单独打 `/api/qt/stock/get?fields=f57,f58,f127`，只靠 4 路小池；同一上游明明支持 `ulist.np/get?secids=…` 批量。 | `em.ts:4037-4044`<br>`const json = await ttlCache(\`industry-name:${secid}\`, …`<br>`  fetchAny(QUOTE_HOSTS, \`/api/qt/stock/get?secid=${secid}&…&fields=f57,f58,f127\`))`<br><br>`em.ts:4121-4124`<br>`await poolRun(targets, 4, async (secid) => {`<br>`  const name = await industryNameOf(secid)`<br>`})` | 当前自选 42 条中 34 只 A股 ⇒ 冷缓存 **34 次 `stock/get`**（4 并发 ≈9 轮，≈1–2 s）；EM 抖动时每次 `fetchAny` 最多 8 次尝试 ⇒ **最坏 272 次**。名称 TTL 600 s 且同一批同时到期 ⇒ 每 10 分钟一次 34 连发（`/industries` 由客户端每 60 s 调一次，`pacing.ts:21`）。 | 用 `ulist.np/get` 批量（50 个 secids/批）替代逐代码；TTL 加 ±10% 抖动，避免同刻过期；`/industries` 与 `/industry` 共用同一份批量结果。 |
| P1-4 | **P1** | **`dayTradesOf` 对每一笔流水新建 Intl 格式化器**。`new Date(e.ts).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'})` 在 `trades` 循环和 `unpriced` 循环里各调用一次。 | `dayTrade.ts:83`<br>`const day = new Date(e.ts).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })`<br>`dayTrade.ts:91`<br>`day: new Date(e.ts).toLocaleDateString(…),`<br><br>`routes.ts:1477`<br>`dayTrades: dayTradesOf(store.ledgerEntries()),` | 实测 367 条：**首调 90.2 ms / 热 38.0 ms 一次 `/portfolio` GET**；微基准 3 000 次 `toLocaleDateString` = **824 ms** vs 复用 `Intl.DateTimeFormat` = **64 ms**（13×）。`/portfolio` 是 10 s 轮询端点 ⇒ 当前规模 0.4% 单核、3 000 条时 **310–740 ms/次**，且是纯 CPU 阻塞。 | 模块级建一个 `Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'})` 复用；更快的写法是 `day = new Date(ts + 8*3_600_000).toISOString().slice(0,10)`（无 Intl，O(1)）。 |
| P1-5 | **P1** | **护盘日志每分钟整份 merge + 重写**。`persist()` 把 60 天全量 `rescue-log.json` 交给 `updateJsonLocked`：锁内读 7.7 MB → `mergeRescueLog` 合并全部 days → `JSON.stringify` → 原子写。 | `rescue.ts:1996-2022`<br>`if (!force && now - this.lastPersist < 60_000) return`<br>`await updateJsonLocked(this.path(), (disk) => mergeRescueLog(disk, this.file, this.samplesBase), …)`<br>`rescue.ts:128`<br>`const KEEP_DAYS = 60` | 实测 7.7 MB（7.66 MB UTF-8）：**parse 73.0 ms + stringify 53.0 ms ≈ 126 ms CPU/分钟**；交易时段 ~260–300 次/日（09:25–11:35 + 12:55–15:05）⇒ **≈33 s CPU + ≈2.0 GB 写盘/日（读写合计 ≈3.9 GB）**。53 天 × 每日 ~136 KB，其中 `intraday` 50 点是主要体积；这些历史日每天都被原样重写。 | 按日分片（`rescue/<day>.json`）只写当日；`intraday` 只持久化当日/最近 3 日；`lastSnapshot` 单独小文件；`KEEP_DAYS` 裁剪放在分片删除上。 |
| P1-6 | **P1** | **新浪兜底串行分批 + 固定 sleep + 无总截止**。`fetchSinaQuotes` 每批 5 个符号，批间 `await sleep(60)`，单批 10 s 超时；整条链没有 deadline。 | `sina.ts:336-364`<br>`const CHUNK = 5`<br>`for (let i = 0; i < pairs.length; i += CHUNK) {`<br>`  const res = await withHostBreaker('hq.sinajs.cn', () => fetch(url, { … signal: AbortSignal.timeout(10000) }))`<br>`  …`<br>`  await new Promise((r) => setTimeout(r, 60))`<br>`}` | 20 个缺价标的（国际/商品/美股常见）= 4 批；单批挂起 10 s ⇒ **最坏 40 s**，`/quotes`、护盘 tick 一起被拖住；正常情况下也要 ≥240 ms 空等。`docs/REVIEW-7-HOST.md:395` 只记了 E8「每批 60 ms」，没记"串行 + 无总 deadline"这一层。 | `Promise.all` 限 2–3 并发；整条链加 `AbortSignal.timeout(3_000)` 或 `Promise.race`；失败批才退避；批大小可按上游实测调到 10。 |
| P1-7 | **P1** | **`calendar.json` 跨进程无锁，且 `writeFileAtomic` 用固定 `.tmp`**。`CalendarStore.persist` 只有进程内 `writeChain` + `writeJsonAtomic`（锁内读改写只存在于 store/rescue/fupan/leverage/kline）。 | `calendar.ts:398-407`<br>`const run = this.writeChain.then(async () => {`<br>`  this.readGuard.assertWritable(this.path(), '写回日历事件')`<br>`  await writeJsonAtomic(this.path(), this.file)`<br>`})`<br><br>`atomic.ts:15-20`<br>`const tmp = \`${target}.tmp\``<br>`await writeFile(tmp, text, 'utf8')`<br>`await rename(tmp, target)` | 两个 dsh 实例（3080 服务 + TUI/另一实例，`lock.ts:1-20` 记录过真实事故）同时同步时，后写者用自己内存整份覆盖，另一实例新同步的事件丢失；现有 **1,403 条事件**。固定 `.tmp` 并发写时 rename 可能拿到别人半截内容 ⇒ 解析失败 → 隔离（`calendar.ts:390`），等于丢一次同步。 | `persist` 改 `updateJsonLocked(path, (disk)=>mergeCalendar(disk,this.file))`（autoKey upsert + 手动事件保留）；`writeFileAtomic` 的 tmp 加 `pid + 随机` 后缀。 |
| P1-8 | **P1** | **工具层"位置"指标串行拉 K 线**。`tradewatcher_position` 与 `group_rank(by='位置')` 都在 `for` 里 `await em.fetchKline(secid, 101, 250, fq)`；K 线之间互不依赖。 | `tools.ts:1044-1053`<br>`for (const it of items) {`<br>`  …`<br>`  const k = await em.fetchKline(it.secid, 101, POSITION_WINDOW.bars, fq)`<br>`}`<br><br>`tools.ts:1182-1193`<br>`for (const secid of ids) {`<br>`  …`<br>`  const k = await em.fetchKline(secid, 101, POSITION_WINDOW.bars, fq)`<br>`}` | 默认 20 只、上限 60；冷缓存每只 0.3–0.8 s ⇒ **20 只 6–16 s / 60 只 18–48 s**（同一工具调用内串行；`fetchKline` 本身已有单飞与磁盘缓存，但首次仍要回源）。 | 用 `poolRun(ids, 4, …)` 并发取，再按原顺序组装；失败占位保持现在的 `missing[]` 语义。 |
| P1-9 | **P1** | **`fetchAny` 的熔断记账粒度是"调用"而不是"请求"，阈值 3 被放大 8 倍**。一次调用最多 2 轮 × 2 主机 × 2 次 = 8 个 HTTP，但只有全部失败后才对每台主机 `recordFailure` 一次。 | `em.ts:145` / `151-181` / `191-193`<br>`const neverSucceeded = new Set<string>(claimed)`<br>`for (let round = 0; round < FETCH_ROUNDS; round++) { … for (let attempt = 0; attempt < FETCH_ATTEMPTS_PER_HOST; attempt++) { … fetchFromHost … } }`<br>`for (const host of neverSucceeded) { breakerFor(host).recordFailure(lastError) }`<br>`em.ts:123-125` `FETCH_ROUNDS=2 / ATTEMPTS=2 / DEADLINE=9_000` | 熔断阈值 3（`breaker.ts:38`）实际等于 **最多 3×8 = 24 次真实请求**才打开；故障瞬间 4 个 clist 页并发（`breadthCount.ts:14` `BREADTH_CLIST_CONCURRENCY=4`；`/breadth?dist=1` 路径为 6，`routes.ts:64`）⇒ **最多 32 次（dist 路径 48 次）请求**在打开前发出，正是"上游不稳时再推一把"。 | 每次 `fetchFromHost` 失败即 `recordFailure`（成功即 `recordSuccess`），调用级只做 `noteHostFailure` 去重；或把阈值改成按"真实请求数"计。 |

---

## 五、P2（8 条）

| # | 严重度 | 问题 | 证据（文件:行 + 片段） | 影响（量化） | 建议修法 |
|---|---|---|---|---|---|
| P2-1 | **P2** | **`assemblePortfolio` 对每个持仓把全量流水扫三遍**：`derivedPosition` 调 `replayPositionWithSkips`（全表按 posId 过滤）+ `slicePosition`（再扫一遍）+ `replayPosition(pre)`；外层还每请求 `sortLedger`。 | `portfolio.ts:266-280`<br>`const sorted = sortLedger(entries)`<br>`for (const p of items) { const row = derivePosition(sorted, p, …) }`<br><br>`portfolio.ts:78-90`<br>`for (const e of entries) { if (e.posId !== posId) continue … }`<br>`slice.start = replayPosition(pre, posId)` | 10 持仓 × 367 条：热态 1–7 ms（首调 60–100 ms，JIT）；100 持仓 × 5 000 条按 O(P×E) ≈ **50–350 ms/请求**，`/portfolio` 与 `/badge` 都会被拖慢。 | 请求内一次遍历按 `posId` 分组；每仓只重放自己的 entries（O(E + ΣE_p)），`dayStart` 切片复用同一分组。 |
| P2-2 | **P2** | **`store.watchData()` / `portData()` 每次调用都 `JSON.parse(JSON.stringify(...))` 深拷贝**；`/calendar` 一次请求里 `focusCodes` 被调 3 次 ⇒ 6 次全量克隆。 | `store.ts:747-753`<br>`return JSON.parse(JSON.stringify({ groups: …, items: … }))`<br>`return JSON.parse(JSON.stringify(this.port))`<br><br>`routes.ts:1614/1626/1627`<br>`const codes = focusCodes(store)`<br>`const heldSet = new Set(focusCodes(store, true))`<br>`const watchSet = new Set(focusCodes(store, false))` | 42 自选 + 10 持仓 ≈ 52 条 × 6 次克隆/`GET /calendar`；每次是完整序列化+解析（当前文件 7 KB，量小；但随自选/分组线性增长，且是纯浪费）。 | 读接口返回 `Readonly` 视图（调用方按契约不改），或浅拷贝 `{ groups: [...], items: items.map(i=>({...i})) }`；`focusCodes` 一次算完 held/watched 两个集合。 |
| P2-3 | **P2** | **汪汪队（dogwatch）同一文件读两遍 + 金额档案每次 readdir + 逐文件读**。`fetchDogwatch` 先在循环里 `readDiskShares(day)`，miss 后再调 `loadSharesOf`，后者又 `readDiskShares` 一次；`readAmountArchive()` 每次请求 `readdirSync` + 读全部 `amount-*.json`。 | `dogwatch.ts:453-455`<br>`const disk = readDiskShares(day)`<br>`if (disk !== null) … ; const rows = await loadShares(day)`<br>`dogwatch.ts:266-268`（`loadSharesOf`）<br>`const disk = readDiskShares(day); if (disk !== null) return disk`<br>`dogwatch.ts:371-383`<br>`for (const f of readdirSync(dir)) { … JSON.parse(readFileSync(join(dir, f), 'utf8')) }` | 冷请求每个缺失日多 1 次 `open` + 1 次 `unlink`（失败分支）；512 天 = 多 ~1 024 次 syscall。金额档案 20–90 个小文件每次请求同步读。 | `loadSharesOf` 内部拿掉重复读；金额档案启动时一次加载到 Map（或 mtime 失效）；批量读用 `Promise.all`。 |
| P2-4 | **P2** | **竞价采样每标的每拍 3 次文件操作 + 定时器无在飞闸**。`addPoint` 每次 `mkdir` + `isCorrupt`（读+parse）+ `updateJsonLocked`（锁内再读+写）；`setInterval(10 s)` 直接 `void this.tick()`，tick 串行写 40 个文件。 | `auctionSeries.ts:234-250`<br>`await mkdir(this.dir, …)`<br>`if (await this.isCorrupt(file)) …`<br>`await updateJsonLocked(file, (disk) => mergeAuctionFile(disk, day, point))`<br>`auctionSeries.ts:336-344`<br>`for (const row of rows) { … await deps.savePoint(row.secid, day, point) }`<br>`auctionSeries.ts:380-386`<br>`this.timer = setInterval(() => { void this.tick().catch(() => undefined) }, …)` | 40 标的 × 60 拍（09:15–09:25）= **2 400 点/早盘**，每点约 3 次读/1 次写/1 次锁；若一拍 >10 s（磁盘慢/锁等待 15 s）定时器会重叠，同一文件并发写（锁能串行但放大 IO）。 | 一拍一次批量写（一个文件/日或按 secid 分片后一次 `Promise.all`）；`tick` 加 `SingleFlight`；`isCorrupt` 只在读失败时做。 |
| P2-5 | **P2** | **两融历史回填串行 6 页 + 每页整文件 save**。 | `leverage.ts:986-993`<br>`const first = await this.page({ page: 1, … })`<br>`await this.store.save(first.rows)`<br>`for (let p = 2; p <= pages; p += 1) {`<br>`  const page = await this.page({ page: p, … })`<br>`  await this.store.save(page.rows)`<br>`}` | 6 页 × 800 行串行（≈6 次上游、每次整份 JSON 重写，最后一份 ≈4 800 行/600 KB）；只在首次回填发生，影响一次性。 | 先 `Promise.all` 取 6 页，再 `save` 一次；失败页记录后其余继续。 |
| P2-6 | **P2** | **`persistBoardLkg` 先 `boardLkgDirty=false` 再异步写**；写失败只 `console.warn`，本次 LKG 不重试；`writeFileAtomic` 的 `mkdir` 失败也被吞。 | `em.ts:884-895`<br>`boardLkgDirty = false`<br>`void (async () => { try { await writeFileAtomic(…) } catch (error) { console.warn(…) } })()`<br>`atomic.ts:17`<br>`await mkdir(dirname(target), { recursive: true }).catch(() => undefined)` | 一次写失败（磁盘满/权限）⇒ 该次 LKG 丢失，直到下一次有成功抓取才可能再写；`mkdir` 失败原因不可见。 | 成功后再清 dirty；失败恢复 dirty 并退避重试；`mkdir` 失败记录到日志/健康簿。 |
| P2-7 | **P2** | **`/prism` GET 每 30 s 重读 195 KB orders + 重写 equity**。客户端 `PrismPage` 每 30 s `prismState()`；GET 里 `reloadOrders()`（读文件）+ `recordEquity()`（`fetchKline` 300 + 行情 + `saveEquity` 写盘）+ `industryDataOf`（N+1 行业）。 | `prismRoutes.ts:447-453`<br>`await deps.trading.reloadOrders()`<br>`await recordEquity(deps)`<br>`const account = deps.trading.account()`<br>`const quotes = await quoteLiteOf(…).catch(() => ({}))`<br>`const industryData = await industryDataOf(…)`<br><br>`prismAccount.ts:540-542`<br>`await updateJsonLocked(this.pathOf('prism-equity.json'), …)` | 页面开着：**2 880 次/日**读 195 KB + 2 880 次 equity 原子写（同日 upsert 大多无变化）；行业 11 只每 10 分钟 11 次 `stock/get`。 | `recordEquity` 只在 `point` 变化或跨日时写；`reloadOrders` 用 mtime 缓存；行业数据走 P1-3 的批量接口。 |
| P2-8 | **P2** | **五市场构建串行**：`marketRaws` 对 `FLOW_MARKETS` 逐个 `await`（每个还有 aum + chart + momentum 三次等待）。 | `globalFlow.ts:973-1063`<br>`for (const def of FLOW_MARKETS) {`<br>`  … const aum = await cached(…)`<br>`  const chart = await dailySeries(def.key, 'chart')`<br>`  const mom = await dailySeries(def.key, 'momentum')`<br>`}` | 冷启动 5 市场串行 ≈3–6 s（每市场 2–3 次上游；`series` 缓存键已按 symbol 去重），可压到 1.5 s 左右；页面低频，故 P2。 | `Promise.all(FLOW_MARKETS.map(...))` 限 3 并发，`missing[]` 仍按市场收集。 |

---

## 六、Top 5 建议先修

1. **P0-1 棱镜撮合单飞 + 三账本事务化** —— 唯一会**动钱**的一条：并发重入 + 覆盖写会让账户与成交流水对不上，且自动撮合每 30 s 就跑一次，复现窗口足够。修法成本低（一个 `SingleFlight` + `withFileLocks` + 合并回调），收益是整条模拟盘的可信度。
2. **P0-2 棱镜读失败 fail-closed** —— 与 P0-1 同源但更致命：一次坏文件/权限错误就会把 171 委托、394 成交、11 持仓在交易时段的 30 s 内覆盖成空。仓库已经在 `store/calendar/fupan/leverage/globalFlow` 立了 R1 红线，棱镜只差三个 `assertWritable`。
3. **P0-3 汪汪队（dogwatch）2y 冷启动** —— 62.5 s 纯 sleep + 571 ms 同步 parse，客户端 15 s 必然超时；这是用户点「2年」就一定能看到的卡死。修 `mapWithConcurrency` 的 gap 语义 + 缓存预加载即可，且能让测试门禁一起变快（见 `AUDIT-TESTS-PERF` 的同一处 sleep）。
4. **P1-4 `dayTradesOf` 复用 Intl** —— 一行改动，实测从 **38–90 ms/请求降到 ~8 ms**（3 000 次 824 ms → 64 ms 的微基准，367 笔按 0.021 ms/次折算）；`/portfolio` 是 10 s 轮询，属于"改完立刻有感"的最高性价比。
5. **P1-5 rescue-log 按日分片** —— 126 ms CPU + ≈15 MB 读写 **每分钟**，一天 ≈2 GB 写盘；交易时段持续发生、影响整机（同步 parse/stringify 会卡所有并发请求）。把历史 53 天从"每次重写"改成"只写当日"是结构性收益。

> 次优：P1-3 行业 N+1（42 次 → 1 次批量，改动小）、P1-9 `fetchAny` 记账粒度（防"熔断前的 48 连发"）。

---

## 七、复核过、未发现（如实记录，避免下一位重复劳动）

- **`time.ts` 本体是对的**：`shanghaiParts` / `shDayOf` / `weekdayOf` / `parseMarketStamp` / `isSettledOffline` 全部钉死 `Asia/Shanghai` 或显式 `+08:00`；`isSettledOffline` 用 `inMarketWindow`（09:15 起）而非 `inSession`，集合竞价段不会被误判定稿。**问题只在调用方绕过了它**（P1-1）。
- **熔断器闭环完整**：按主机隔离（`breaker.ts:109-118`）、半开只放一个探针（`62-71`）、非 2xx 也 `recordFailure`（`breakerFetch.ts:54-59`）、`finally releaseProbe`（`breakerFetch.ts:72-74`）、半开失败立即重熔（`breaker.ts:84-94`）。
- **行情槽/单飞/LKG**：逐 secid 槽 + `quoteInflight` 合并 + `quoteSlots` 上限 1500 + `LKG_MAX=1500` + 休市冻结（`em.ts:908-970`）；`peekQuotes` 零请求路径符合契约。
- **写路径 R1/锁**：`store`（`store.ts:505-510,628-642`）、`calendar`（`calendar.ts:402-406`）、`fupan`（`fupan.ts:482`）、`leverage`（`leverage.ts:771`）、`globalFlow`（`globalFlow.ts:836-849`）、K 线（`em.ts:2839-2860`）都有 `assertWritable` / `updateJsonLocked`；**棱镜是唯一缺口**（P0-2）。
- **定时器**：`rescue` 的 `withBudget`/`deferredTimer`、`prismScheduler`、`auctionSeries` 的 `setInterval` 都 `unref()` 或在 `stop()` 清理；插件 dispose 调 `rescue.stop()/auction.stop()/prismScheduler.stop()`（`index.ts:306-308`）。`degrade.ts` 的 400 ms 聚合定时器也 `unref`（`degrade.ts:545-549`）。
- **文件句柄**：`lock.ts` 的 `open('wx')` 在 `finally` 关闭（`lock.ts:299-305`），心跳 `setInterval` 已 `unref`（`277-283`）；未发现 fd 泄漏。
- **`fetchAny` 的截止时间**：9 s 总 deadline + `left <= 250ms` 快速失败 + "整轮瞬断跳过第二轮"（`em.ts:123-125,151-186`），单次调用有界（问题在记账粒度 P1-9，不在超时缺失）。
- **缓存键**：`detail:${secid}` / `kline:${secid}:${klt}:${fqt}:{full|incr}` / `board:${scope}:${sort}:${pn}:${pz}` / `trend-md:*` / `fx:*` 都包含影响结果的参数；未发现键碰撞。
- **竞价时间**：`auctionSeries.ts:27-36` 的 14 位时间戳走 `parseMarketStamp`，**不受 P1-1 影响**（我最初怀疑它，读实现后排除，如实记在这里）。

---

## 八、未验证 / 限制

| # | 项 | 状态 | 说明 |
|---|---|---|---|
| U1 | 棱镜撮合并发复现 | ○ | 静态证明"无在飞闸 + 忽略磁盘"，未在真实交易时段注入并发 `matchTick`；复现需临时改代码（本轮纪律禁止）。 |
| U2 | 内存增长曲线 | ◐ | `trend:` 每条 25–30 KB 是按 242 点 × 6 字段的 JSON 量级估算；`klineMem` 的 20 MB 是按现有 222 文件 × 90 KB 推算，未做 heap snapshot。 |
| U3 | 2y 首次无缓存的上游耗时 | ◐ | 本机已有 512 个 `shares-*.json`，未打上交所；521 次请求的耗时按单次 ~0.7 s + 4 并发推算 ≈90 s，未实测。 |
| U4 | `TZ=UTC` 的真实影响面 | ◐ | 静态确认 `parseTencentStamp` 偏 8 h、`trendLagOf` 失效；未在 UTC 容器里跑完整面板截图（本轮只跑 `node -e` 验证解析差）。 |
| U5 | 生产流量 | ○ | 本轮**未发任何上游请求**；所有"每次请求 N 次上游"都是代码路径展开，不是抓包。 |
| U6 | 门禁 | — | 未重跑 `npm run check`（基线由任务给定；且并行执行者正在改 client，跑门禁会互相干扰）。 |

---

## 附录 A：测量命令与原始输出

```text
# 1) 汪汪队磁盘缓存：512 个文件 / 207 536 行 / 9.6 MiB，同步 readFileSync+JSON.parse（脚本里的 MB 是字符数，非字节）
$ cd ~/.dsh/dsh-tradewatcher/dogwatch && node -e "…"
files 512 rows 207536 MB 8.6 ms 571.1

# 2) rescue-log 整份 parse / stringify
rescue-log.json MB 6.35 parse 73.0 ms stringify 53.0 ms
prism-runs.json MB 0.50 parse 3.0 ms stringify 7.9 ms
calendar.json   MB 0.39 parse 1.9 ms stringify 8.2 ms

# 3) dayTradesOf（真实 ledger.json，367 条）
entries 367 ms 90.2 rounds 38
second call ms 38.0

# 4) Intl 微基准（3 000 次）
toLocaleDateString per call ms: 824.24
cached formatter ms: 64.39

# 5) 无偏移 Date.parse 的时区差
naive 1791797460000 correct 1791768660000 diff_h 8
```

> 复现提示：以上 2)–5) 只读本机文件、不联网；1) 的 512 个文件来自用户真实缓存，量级可随使用变化。
> 口径提醒：脚本里的 `MB` 是 UTF-8 **字符数**/1048576（中文占 1 字符但 3 字节）；文件字节数见正文（`rescue-log.json` 7.66 MB、汪汪队 512 文件 9.6 MiB）。
