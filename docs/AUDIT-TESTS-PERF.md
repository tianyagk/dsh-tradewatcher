# AUDIT-TESTS-PERF — 测试与门禁的性能 / 稳定性 / 有效性审计（v0.214.0）

> **范围**：`src/**/*.test.ts`（232 个文件 / 42 576 行 / 1811 个用例 / 9 868 条 `assert.*`）、`scripts/**`、`build.mjs`、`package.json` 的 `scripts`。
> **基线**：`npm run check` **1811/1811 × 2 时区**全绿、构建 **73 项**片段校验、v0.214.0（`67cdde3`）。
> **纪律**：**只新增本文件**；未改 `src/**`、未改 `package.json`、未 commit、未重启。A/B 实验全部在 `/tmp` 的仓库副本上做。
> **方法**：`time npm run check` 完整一遍 + 分阶段单独计时；解析 `node --test` 的 `✔ … (Nms)` 输出（两遍共 3622 条，去重 1810 个唯一用例）；`grep` 统计；对嫌疑点做 **A/B 副本实验**（改副本、跑同一批用例、比时长）。
> **环境**：node v24.16.0 / npm 11.13.0 / Linux，审计时刻 **2026-11-23 11:53–12:04（北京时间）—— 落在午休段 11:30–13:00 内**。
> **快照点**：所有计时与计数取自 `11:53:35–11:54:58` 那一次 `npm run check`，当时工作区 = `v0.214.0` 干净态。
> （`12:05` 之后同一工作区出现了另一位执行者的未提交改动：`M src/client/RescuePanel.tsx`、新增 `src/client/rescueNullGuard.test.ts`；**不在本审计的基线内**，本文所有数字都不含它。）

---

## 一行结论

**门禁 83 秒里 68.8 秒（83%）是同一套 1811 个用例跑两遍，其中至少 15.4 秒纯粹是生产代码里的 `sleep` 在测试里空转（`dogwatch` 120ms/批、`breadthScan` 200ms/页、`em` 500ms 重试）——把这三处改成可注入后全量 35.0s→27.3s；另有 10 秒是 `index.test.ts` 一个「等一个永不为真的条件」的空等；源码字符串扫描型断言占全部断言的 15.8%（1561/9868），7 个高风险逻辑里 6 个有行为断言兜底，`priceCorrection` 的路由分派 0 引用、无卖出方向用例。**

---

## §0 门禁总耗时分解（先给数）

`time npm run check`：**83 s**（`11:53:35 → 11:54:58`，exit 0）。

| 阶段 | 耗时 | 占门禁 | 说明 |
| --- | --- | --- | --- |
| `typecheck`（tsc --noEmit） | **7.75 s** | 9.3% | 单独计时（冷） |
| `test` 第 1 遍（宿主时区 Asia/Shanghai） | **33.69 s** | 40.6% | `ℹ duration_ms 33689.9` |
| `test` 第 2 遍（`TZ=UTC`） | **35.11 s** | 42.3% | `ℹ duration_ms 35107.6` |
| `selftest`（`src/host/selftest.ts`，**含真实联网探针**） | **5.96 s** | 7.2% | 单独计时 |
| `build`（esbuild ×2 + **内部再跑一遍 tsc**） | **3.62 s** | 4.4% | 其中 esbuild-only 1.42 s ⇒ tsc 约 2.2 s |
| **合计（分项相加）** | **86.1 s** | — | 与 83 s 墙钟差 ±3 s（单独计时抖动） |

**两遍测试 = 68.8 s = 门禁的 82.9%。** 这一条决定了后面所有优化建议的排序。

| # | P1/P2 | 问题 | 证据 | 影响（秒/风险） | 建议 |
| --- | --- | --- | --- | --- | --- |
| 0-1 | **P1** | 全套 1811 个用例被完整跑两遍（宿主 TZ + `TZ=UTC`），收益与成本严重倒挂 | `package.json:test` 两条完全相同的命令串 `&&`；两遍分别 33.69 s / 35.11 s；另跑 `TZ=America/New_York` 一次：**1811/1811、0 fail** | **35.1 s / 门禁 42%**（可省） | 第二遍改成**只跑时区敏感子集**（`time` / `marketClock` / `marketTime` / `usQuote` / `clockView` / `impl75` 等 8 个文件 ≈ 1 s），并把 TZ 矩阵扩到 3 个（Asia/Shanghai、UTC、America/New_York）——**更快且更强** |
| 0-2 | P2 | `tsc --noEmit` 跑两次：`npm run typecheck` 一次，`build.mjs` 里 `execFileSync('tsc', ['--noEmit','-p','tsconfig.json'])` 再一次（参数完全相同） | `package.json:44` vs `build.mjs:17` | 约 **2.2 s**（热缓存下） | `check` 里给 build 传 `TW_SKIP_TYPECHECK=1`（build 已支持），或删掉 `typecheck` 脚本调用、只留 build 内的门禁 |
| 0-3 | P2 | `selftest` 在门禁里**真实联网**（15 次东财请求：quotes 批、trend、kline×2、suggest×3、industry×2、预设标的全扫、板块×3），失败被 `softOk` 吞成"软失败" | `src/host/selftest.ts:1117-1180`；日志 `ALL HOST CHECKS PASSED (live probes soft)` | **5.96 s 且不可预测**（限流/断网可到数十秒或让日志变红字） | 把 live 段拆成 `npm run selftest:live`（不进 `check`）；`check` 只跑离线段 |

---

## §1 慢测试：>500 ms 的 76 个用例

- **76 / 1811（4.2%）用例 >500 ms**；54 个 >1 s；这 76 个**单遍累计 129.9 s**（累计测试时长，不是墙钟——`--test-concurrency=8` 按文件并行）。
- **1583 / 1811（87%）用例 <50 ms**。分布是**极端长尾**：Top20 之外基本都 <1 s。
- 关键发现：**长尾不是"算得多"，而是"在等"**——真子进程、真锁、以及生产代码里为真实网络写的节流/退避 `sleep`，在全部走桩或全走磁盘缓存的测试里照付。

### Top 20（`node --test` 报的 duration，取两遍中较大值）

| # | ms | 文件 | 用例（截断） | 归因 |
| --- | --- | --- | --- | --- |
| 1 | **7099** | `host/dogwatch.test.ts` | ③ 换窗口（6m→3m）fetched = 0 | **生产 sleep**：`mapWithConcurrency(days, 4, 120)` 每批 120 ms；本用例 seed 221 天 ⇒ 221/4×120 ≈ 6.6 s，而**每天都命中磁盘缓存、零网络** |
| 2 | **5013** | `index.test.ts` | calendar 行：只注册日历那一段 | **空等**：`waitForCondition(() => __kernelStats.inits === 1, 5000)`，但前一行 `setKernel(null)` 会新建内核把 `inits` 加到 2 ⇒ 条件**永不为真**，整 5 s 超时上限被吃满（单独跑同文件复现：5014.7 ms） |
| 3 | **4331** | `host/klineAgg.test.ts` | ① 板块指数有日线缓存 ⇒ 周/月/年K 聚合，零 upstream | **生产 sleep**：`em.ts:3323` `if (attempt === 0) await sleep(500)`；本文件上游全被 stub 成死链路 ⇒ 每次 `fetchKline` 付 500 ms（A/B：本文件 12.2 s→8.5 s） |
| 4 | **4299** | `host/lock.test.ts` | L10 四个状态文件真的在锁内写 | **真子进程 + 真实持锁**：4 个 case × 子进程 spawn + `HOLD_MS=500` ⇒ 4×~1 s |
| 5 | **4040** | `host/fetchDedupe.test.ts` | P1-1 源 B 失败：30s 内第二次不再重扫 56 页 | **生产 sleep**：`breadthScan.ts:176` 每页 `sleep(CODE_PAGE_GAP_MS=200)`；本用例走 ~20 页 ⇒ ~4 s（A/B：6.2 s→4.9 s） |
| 6 | 3396 | `host/intlCoverage.test.ts` | ① CL/GC/SI 各有可用源，末点贴近最近交易时段 | 多标的 × 多主机失败回退；`em.ts:172` 退避含 `Math.random()*140` ⇒ **时长随机** |
| 7 | 3364 | `host/prismCash.test.ts` | ① capital 落 settings，3 次 GET 恒为新值；重启仍保留 | 真实 `PrismStore`/`PrismTradingStore` 落盘 + 多次 `init()`（含原子写 tmp+rename） |
| 8 | 2751 | `host/rescuePiggyback.test.ts` | ① 触发瞬间的家数：搭车进事件 | 采样器整拍路径（多主机多通道）+ 桩回包解析 |
| 9 | 2748 | `host/dogwatchRows.test.ts` | ① 复盘日期 = series 最后一天 | 同 #1（120 ms/批 × ~95 天） |
| 10 | 2699 | `host/dogwatch.test.ts` | ① 第二次同窗口调用 fetched = 0 | 同 #1 |
| 11 | 2667 | `host/dogwatch.test.ts` | P3-1 二次打开：elapsedMs < 100 且 fetched = 0 | 同 #1（**注意**：断言 `<100ms`，但建缓存那一步自己先睡了 2.6 s） |
| 12 | 2663 | `host/lock.test.ts` | L5 等待是有界的：超时抛 LockTimeoutError | 真实锁超时等待 |
| 13 | 2654 | `host/dogwatchRows.test.ts` | ④ 510300 scale/sharesYi 区间 | 同 #1 |
| 14 | 2650 | `host/dogwatchRows.test.ts` | ⑥ 表格按 scale 降序 | 同 #1 |
| 15 | 2626 | `host/dogwatchRows.test.ts` | ② series.length ≥ 20 且 change 非全 0 | 同 #1 |
| 16 | 2625 | `host/dogwatch.test.ts` | ② 5 分钟内重复调用 fetched = 0 | 同 #1 |
| 17 | 2615 | `host/dogwatch.test.ts` | ④ 删掉某一天文件 ⇒ 只补该 1 天 | 同 #1 |
| 18 | 2607 | `host/dogwatch.test.ts` | ⑥ 进程内缓存命中 elapsedMs < 50 | 同 #1（同上，断言 <50 ms 却先睡 2.6 s） |
| 19 | 2599 | `host/dogwatchRows.test.ts` | ⑤ sharesDelta 非 null 行数 ≥ 13 | 同 #1 |
| 20 | 2568 | `host/dogwatchRows.test.ts` | ③ rows[0].scale !== sharesY i | 同 #1 |

> 第 21–30 名：2547 `rescuePiggyback ③`、2351 `klineLock ②`（双进程裁剪）、2333 `intlCoverage ④`、2295 `intlMinute ①b`、2013 `klineAgg ⑥①`、1828 `klineLock ①`、1756 `chips 端到端`、1634 `klineHostFallback ③`、1521 `impl74 ②b`、1423 `klineAgg ⑥③`。

### 慢的四个根因（按可省时长排序）

| # | P1/P2 | 问题 | 证据 | 影响（秒/风险） | 建议 |
| --- | --- | --- | --- | --- | --- |
| 1-1 | **P1** | `dogwatch` 的 120 ms 批间节流**无注入点**，测试里全部命中磁盘缓存仍照付 | `dogwatch.ts:326-338` `mapWithConcurrency(tradingDays, 4, 120, …)`；`dogwatch.test.ts` 6 个慢用例 + `dogwatchRows.test.ts` 6 个，**单遍累计 36.2 s**；单文件 A/B **20.7 s→0.75 s / 15.7 s→0.53 s** | 12 个用例单遍累计 **36.2 s**（两遍 ~72 s 累计测试时长）；因 8 路文件并行，**墙钟每遍 −7.7 s** | 把 `gapMs` 提成 `fetchDogwatch` 的 deps（默认 120），测试传 0；或**只在真的走网络时**睡（磁盘命中不睡） |
| 1-2 | **P1** | `index.test.ts` 的 5 s 是**等一个永不为真的条件**，且 `waitForCondition` 超时不抛 | `index.test.ts:116-119`（`while (… ) await sleep(20)` 后直接返回）、`:176-182`；`index.ts:211-262`（`setKernel(null)` ⇒ `first=true` ⇒ `inits += 1` 到 2） | **10 s（两遍）** / 该用例的"init 只跑一次"**实际没被这条等待证明** | 改成 `assert.equal(__kernelStats.inits, 2)` 或先重置 `__kernelStats`；`waitForCondition` 超时必须 `assert.fail` |
| 1-3 | P2 | `em.ts` 的重试退避 500 ms 无条件生效，测试里"上游全死"场景每个 `fetchKline` 付一次 | `em.ts:3323`；`klineAgg.test.ts` 12.2 s→8.5 s、`intlCoverage` 段亦受影响 | 约 **3.7 s/遍**（klineAgg 单文件） | 把 `sleep` 注进 `fetchKline` 的 deps（测试传 `() => Promise.resolve()`） |
| 1-4 | P2 | `breadthScan` 的 200 ms 翻页间隔写死常量 | `breadthScan.ts:135` `CODE_PAGE_GAP_MS = 200`、`:176` | **1.3 s/遍**（fetchDedupe 6.2→4.9） | 同 1-3：`sleep` 已是 `fetchSinaCodePool` 的入参，但 `breadthScan` 内部直接调 `sleep(CODE_PAGE_GAP_MS)`，改成从 deps 透传 |
| 1-5 | P2 | 真子进程 + 真实持锁的 10 个用例（`lock` 8 + `klineLock` 2）单靠墙钟 | `lock.test.ts:361-390`（4×`HOLD_MS=500`）、`:199` `elapsed >= 200 && < 1500` | **~8.7 s（两遍）**，且并发机器上上界会破 | 保留（这层只能真跑），但把 `HOLD_MS` 降到 150–200 ms、把上界放宽到 3×（判据仍是"是否等待"，不靠精确时长） |

---

## §2 不稳定源（flaky 风险）

**先说结论：测试层是干净的** —— 232 个 `*.test.ts` 里**没有真实网络**（11 处 `fetch(` 全是"禁用词表"或注入字符串）、**没有随机端口**（无 `listen(0)`/`net`）、`--test-concurrency=8` 是**按文件分进程**，33 个文件在模块顶层改写 `process.env.DSH_HOME` 因此不会互相污染。风险集中在下面 7 条。

| # | P1/P2 | 问题 | 证据 | 影响（秒/风险） | 建议 |
| --- | --- | --- | --- | --- | --- |
| 2-1 | **P1** | 门禁里唯一的真实联网在 `selftest`：14 个东财实探，失败只记"soft"，但**成功与否会改变输出与耗时** | `selftest.ts:1117-1180`；`softOk(…)` 不递增 `failures` | 网络抖动 ⇒ 5.96 s 变数十秒；限流 ⇒ 日志红字但 exit 0（"静默降级"） | 拆成 `selftest:live`；`check` 用离线段；live 段失败要**显式打 tag 并统计**（别只打印） |
| 2-2 | P2 | `waitForCondition` 超时**静默返回**，条件未满足也继续跑后续断言 ⇒ 可能"假绿 + 空等 5 s" | `index.test.ts:116-119`；已实测 5013 ms（见 1-2） | 10 s + 一处断言已失效 | 超时 `assert.fail`；或用 `node:test` 的 `t.signal`/`AbortSignal.timeout` |
| 2-3 | P2 | 墙钟性能断言（在 8 路并发 + 共享 CI 机器上会偶发红） | `auditFixes1030.test.ts:19` `Date.now()-t0 < 1000`；`dogwatch.test.ts:257,309` `elapsedMs < 50`、`:470,476` `< 100`；`lock.test.ts:175,254` `< 5000/6000`、`:199` `>=200 && <1500` | 偶发红 → 重跑一次就绿 → 团队开始不信任门禁 | 分类处置：**"防死循环"类**（1000 ms）改成"有界 + 可中断"的行为断言；**缓存命中类**（<50/<100）改断言 `fetched === 0 && cached === true`（已有），删掉时长断言；锁类放宽到 3× 并保留"是否等待"的语义判据 |
| 2-4 | P2 | 3 个文件在**模块加载期**捕获 `Date.now()` 当"今天"，与生产侧运行期 `Date.now()` 存在跨北京午夜翻转窗口 | `trade-rules.test.ts:13` `const NOW = Date.now()`；`fupanTrades.test.ts:46` `TODAY = dayOf(Date.now())`（注释自认"当日盈亏恒按今天"）；`fupan.test.ts:414` | 门禁跨 23:59→00:0x 时（一次 `check` 83 s，撞上概率 ≈ 83/86400 ≈ 0.1%/次，全年 CI 会碰到）→ "今天"翻转，持仓当日盈亏/T+1 判据变红 | 用 `pinNow()`（`routes.test.ts:367` 已有现成实现）把 `Date.now` 钉到固定交易日；或给这几个用例注入 `now` |
| 2-5 | P2 | 重试退避里带 `Math.random()` ⇒ 同一用例时长不可复现 | `em.ts:172` `setTimeout(60 + attempt*120 + Math.random()*140)` | 慢测试排名不稳定（本次第 6/23 名就是这么来的） | 退避函数注入（测试给确定性序列） |
| 2-6 | P2 | 两个测试读 `lib/` 产物，**结果取决于上一次 build**；而 `check` 的顺序是 `test` 在 `build` 之前 | `impl85.test.ts:97-109`（"产物存在就必须干净"）、`index.test.ts`（读 `lib/` 相关断言）；`lib/` 被 `.gitignore` | "本机绿、CI 绿、同事红"类不可复现差异；陈旧产物会让**已删功能的残留**把测试打红 | 要么在 `test` 前强制 `build`（`check` 顺序改成 `build → test`），要么让这两个用例自己生成产物到临时目录 |
| 2-7 | P3 | `index.test.ts` 在 `after()` 里 `setTimeout(() => process.exit(0), 10).unref()` —— 强制退出会**吞掉未关闭句柄**（采样器/定时器泄漏再也看不见） | `index.test.ts:96-100` | 掩盖真实泄漏；顺序敏感 | 删掉强制退出，改成在每个用例显式 `stopMonitor()`；泄漏就该让测试挂住并暴露 |

**与当前时刻（2026-11-23 11:5x，午休段）相关的边界风险**

- 调度器相关断言**全部注入了时间**（`parseMarketStamp('2026-10-22 11:29:00')` ⇒ 显式 `+08:00`），**与"现在几点"无关**；午休 11:30–12:59 **逐分钟**扫过（`prismScheduler.test.ts:122-137`），三段边界（11:29/11:30/13:00）都钉了。**这块在午休时跑不会飘。**
- 真正与"当前时段"挂钩的只有 §2-4 的 `Date.now()` 单例；午休**不是**它们的敏感区，**午夜**才是。
- **没有**任何用例依赖"现在是交易时段"来走分支（测试里 session 判定一律走注入的 `at(...)`/`pinNow`）。

---

## §3 覆盖空洞：本次会话修过的 7 处高风险逻辑

| 逻辑 | 测试文件 | 用例 / assert | 反例注入 | 判定 |
| --- | --- | --- | --- | --- |
| **调度 interval** | `prismScheduler.test.ts` + `prismInterval.test.ts` | 15+6 / 98+29 | 0 `throws`，但含"必败"式正向断言 | **强**：09:29/09:30/11:29/11:30/12:59/13:00/14:59/15:00 全边界；午休逐分钟；周末；重启水位；占位守卫；600/300/1800/3600 档位 |
| **同产品闸** | `prismProductDup.test.ts` | 14 / 62 | 2 处真注入（去闸 ⇒ 两条腿进账户） | **强**：同键/不同键/加仓放行/pending 买单/缺价 |
| **错价闸** | 同上 ⑥⑦⑫ | 含在上 | 1 处真注入（121.825 按错价成交） | **强**：±3% 边界、无现价 ⇒ 放行 + `skipped`、卖出同口径 |
| **被拒去重** | `prismRejectDup.test.ts` | 10 / 61 | 2 处真注入（去闸/去上下文段） | **强**：≤100 股/≤0.5% 判重、200 股/1%/反向/异标的放行、同轮多条只记一条、跨日不串 |
| **持仓分析** | `prismData.test.ts` ⑱–㉓ | 含在 27 / 91 | 3 处（漏条目、缺数据写 0、默认 15/8 顶替） | **强**：每条持仓一条、观察四项可复算、约束未设置 ⇒ `—（约束未设置，无法判定）` |
| **thesis** | `prismData.test.ts` ⑦ + `prismThesis.test.ts` + `prismDeskMid.test.ts` | 10+14 / 含在 91 + 46 | 4 处（旧理由顶替、别股理由顶替、编造置信度、旧文案） | **强**：host 取值规则 + client 折叠/来源标签/北京时间/置信度恒 `—` |
| **priceCorrection** | `prismCorrection.test.ts` | **6 / 15** | 5 处（未成交/无成交/同价/无依据/newPrice=0） | **弱 —— 有 3 个真空洞**，见下 |

| # | P1/P2 | 问题 | 证据 | 影响（秒/风险） | 建议 |
| --- | --- | --- | --- | --- | --- |
| 3-1 | **P1** | `POST /tradewatcher/prism {action:'priceCorrection'}` 的**路由分派一行测试都没有**：action 字符串 `'priceCorrection'` 在全部 `*.test.ts` 里出现 **0 次**（只有纯函数 `applyPriceCorrection` 被直接调） | `prismRoutes.ts:588-600`（含 `400 priceCorrection 缺 orderId/newPrice/basis`、`saveAccount`+`saveOrders` 两处落盘）；`grep -rn "'priceCorrection'" --include=*.test.ts` ⇒ 空 | 把 action 名写错、漏 `saveOrders`、或 400 分支写反，**门禁全绿** | 补一条端点级用例（照 `prismCash.test.ts` 的 `call()` 模式）：200 路径断言 `account.cash` 与 `orders[].price` 真的落盘、`corrections[]` 长度 1；400 路径断言缺字段 |
| 3-2 | P2 | `priceCorrection` **无卖出方向用例**（而卖出要多算印花税千 1、现金方向相反）、**无"连续订正两次"累积用例**（"不覆盖历史"只验了 `length === 1`） | `prismCorrection.test.ts` 全文只有 `side:'buy'`，`grep -n sell` ⇒ 0 | 卖出订正可能算错现金/税费而无人知 | 加 2 条：`side:'sell'` 的 cash 减少 + 印花税；同单第二次订正 ⇒ `corrections.length === 2` 且 delta 累加 |
| 3-3 | P2 | 调度器缺 **"水位在未来"（系统时钟回拨）** 与 **"跨午夜水位"** 两个用例 | `prismScheduler.ts:141-149`：`elapsed` 为负时 `remainSec`/`floor(elapsed/1000)` 会吐出 `距上次自动决策 -N s` 这类负数字样 | 时钟回拨后提示文案荒谬（`due` 仍为 false，功能安全） | 加 `last = now + 3600_000` 用例，断言 `due===false` 且 reason 不含负数；再加 23:50 水位 → 次日 09:31 只补一次 |
| 3-4 | P2 | `scripts/` 4 个脚本里 **3 个零测试**（`install.sh` / `uninstall.sh` / `calibrate-rescue.mjs`），只有 `macro-archive.mts` 被当**文本**读了一次 | `grep -rn 'scripts/' --include=*.test.ts` 只命中 `globalFlow.test.ts:1443` 的 `readFileSync` | `install.sh` 会改用户 profile 的 `package.json`（追加 `link:` 依赖与 bundles）——写坏了只在用户机器上炸 | 用临时目录伪造 profile，跑 `install.sh` → 断言 `dependencies`/`bundles` 恰好加一项、重复跑幂等；`uninstall.sh` 同理 |

---

## §4 源码扫描型断言

### 4.1 比例（口径写清楚）

判定：一条 `assert.*` 的表达式里引用了**由 `readFileSync` 读进来的 `.ts/.tsx/.css/.md/.yml` 文本**（含经辅助函数 `read()`/`readSrc()` 与块内二次派生，按 `test()` 块作用域做污点传播，避免跨块串味）。

| 口径 | 数值 | 说明 |
| --- | --- | --- |
| 断言级 | **1561 / 9868 = 15.8%** | 全库 |
| 用例级 | **601 / 1759 = 34.2%** | 分母 = 含扫描断言的 127 个文件里的用例数；对全部 1811 个用例是 **33.2%** |
| 文件级 | **127 / 232 = 54.7%** 的测试文件读了源码文本 | 其中 **36 个文件**的断言 >50% 是扫描（`productBatch`/`readmeCounts`/`impl71`/`prismShell` 等 4 个 ≥85%） |
| 断言形态 | `includes('字面量')` **368**、`assert.match/正则` **243**、`includes(变量)` 59、`indexOf` 10 | 611 条（39%）是"纯字面量匹配"，最脆 |

> **和"此前约 37%"对不上是正常的**：37.6% 出自 `AUDIT-DOGWATCH-TESTS.md`，那是对**一个提交的 5 个文件**（`dogwatchParity` 86% 的 CSS 像素对拍把均值拉爆）的抽样。全库真实值是 **15.8%（断言级）/ 34.2%（用例级）**——**用例级才是和 37% 同量级的口径**。建议以后统一报"用例级"。

**最重的 10 个文件**（断言级占比）：`productBatch` 100%（34/34）、`readmeCounts` 97%（29/30）、`impl71` 95%（38/40）、`prismShell` 86%（57/66）、`impl78` 66%（70/106）、`toolsPage` 66%（37/56）、`chipsView` 52%（72/139）、`leverageHeader` 49%（29/59）、`payloadGate` 48%（31/65）、`marketRefactor` 48%（21/44）。

> 说明：其中 `readmeCounts`（README 计数 ↔ `ROW_ROUTES`/tabs/patch 行数）与 `cloudMap`/`marketCardsRemoved`/`rescuePanelsRemoved`（"某功能是否已下线"）**结构上只能扫源码**，不算缺陷，下文单列。

### 4.2 Top 10 应改成行为断言的弱断言

| # | 位置 | 断言（原文） | 为什么弱 | 建议改成 |
| --- | --- | --- | --- | --- |
| 1 | `client/badgeView.test.ts:160` | `code.includes("label: () => '盯盘'")` | 绑死**源码格式**：引号改双引号、抽成常量、换行即红；而"标签真的显示成 `盯盘 · 数据 14:32`"仍可能绿 | 调注册函数，取 `label()` 返回值断言 `=== '盯盘'`（同文件 ⑦ 已有类似断言，重复了） |
| 2 | `client/productBatch.test.ts:21-22` | `src.includes('当日峰')` + `/\$\{snapshot\.score\}\/100 · 当日峰/` | 断言 JSX 的**文本顺序与插值写法**；改 `{score}/{100}` 或换成变量即红；字符串留在死分支/未渲染分支里则假绿 | 渲染 `RescuePanel`（`react-dom/server`）传 fixture，断言输出 HTML 里含 `72/100 · 当日峰` |
| 3 | `client/chipsView.test.ts:121` 等 39 条 | `styles.includes('.tw-chips-axis{')`、`plotRule.includes('flex:1 1 auto')`、`cssOf('.tw-chips').includes('min-height:0')` | 把 CSS **字面量**当契约：`{` 前加空格、改 `.tw-chips-axis {`、用 `var()` 间接赋值、拆 `padding-block` 全部红；值写错但旧串留在注释/死规则里则绿 | 把布局关键值导出成常量（`CHIPS_AXIS_FLEX`），断言常量被样式对象引用；或用 `jsdom`+`getComputedStyle` 断言计算值 |
| 4 | `client/chartCache.test.ts:239` | `drawer.includes('MA5/10/30/60') === false` | 用"文本不在"证明"UI 不渲染"：文案改半个字（`MA5/10/30/60/120`）即假绿，而脚注可能仍在渲染 | 渲染详情抽屉、断言脚注元素不存在（DOM 断言），而不是搜源码 |
| 5 | `client/auctionView.test.ts:83` | `nullBranch.includes('infoGrid(null)')` | 绑死**调用点字面形状**：`infoGrid( null )`、先解构再调、改名 `grid` 全部红 | 把 `infoGrid` 导出，直接 `assert.match(infoGrid(null), /竞价/)`；或渲染 null 分支断言竞价行存在 |
| 6 | `client/impl78.test.ts:118` | `quotes.includes('const my = gen.current.next()')` | 绑死**局部变量名与语句写法**；重命名 `my→ticket` 即红，语义零变化 | 用两个 `AbortController` 构造"旧请求后到"，断言 state 未被旧回包覆盖（行为级） |
| 7 | `client/prismShell.test.ts:719` | `for (const l of LABELS) assert.ok(PAGE.includes(l))` | 页面上**任何位置**（含 `aria-label`、`title`、未渲染的条件分支、TODO 注释若未剥净）出现该词即绿 | 渲染 `PrismPage` 断言可见文本节点集合 == 期望集合（多退少补都能抓） |
| 8 | `client/noticeBars.test.ts:63` | `kline.includes('区间内无买卖点')` —— 该字面量**同时**被 `build.mjs` 的 73 条片段表锁死 | "双保险"其实是**双倍脆**：改文案要同时改测试和构建脚本，且两处都不证明用户能看到 | 由构建产物做**一次**渲染级检查（或删掉测试里的重复，只留 build 的产物校验）；文案从 `const` 导出，测试断言常量 |
| 9 | `client/chipsNoteRemoval.test.ts:60` | `view.includes('caliberDeviates') === false` | 把"功能下线"简化成"标识符消失"：删了渲染但保留空函数/常量 ⇒ 红；改名但照旧渲染 ⇒ 绿 | 断言 `chipsViewOf(...)` 的返回里没有 `caliberDeviates` 字段（数据级） |
| 10 | `client/impl71.test.ts`（38/40）+ `client/uiuxDiscipline.test.ts` | 全客户端 `readdirSync` 后逐文件正则扫"不许出现 X" | 一改类名/抽组件就大面积红；判据是"文本里没有"，漏掉"运行时才拼出来的"违规 | 保留"下线类"（这是唯一可行形态），但**把"必须存在"的断言换成渲染/返回值断言**；对"不许出现"类加白名单注释机制 |

**补充：263 / 470（56%）的 `assert.throws` 是"自证式"** —— 形如 `assert.throws(() => assert.equal(生产值, <某字面量>))`，只证明"不等于**那一个**错值"，生产代码坏成**别的**错值时照样绿（`AUDIT-DOGWATCH-TESTS.md` §2 已实测过：改坏成 99 时注入仍 PASS）。这类不是假注入，但**判别力只有 1 个比特**；建议只保留"改坏源码 → 喂同一判据"的真注入，删掉纯字面量自证。

---

## §5 构建与门禁低效

| 项 | 实测 | 结论 |
| --- | --- | --- |
| `build.mjs` 是否重复编译 | esbuild **两次**（`src/index.ts` → `lib/index.js` node/esm；`src/client/index.tsx` → `lib/client.js` browser/cjs） | **不是重复**：目标平台/格式/外部依赖都不同，必须两次。esbuild 本身只占 **1.42 s** |
| 是否重复跑 tsc | **是**：`npm run typecheck` + `build.mjs` 内部 `execFileSync(tsc --noEmit)`，参数逐字相同 | 约 **2.2 s** 纯重复（见 0-2） |
| 是否重复跑全量测试 | **是**：同一 glob 跑两遍，只有 `TZ` 不同 | **35.1 s**，门禁 42%（见 0-1）；且 `TZ=America/New_York` 也全绿 ⇒ 边际收益近零 |
| 构建期片段校验 | 73 条中文字面量对 `lib/client.js` 做 `includes`（含 esbuild 的 `\xHH`/`\uXXXX` 两种转义形式） | 代价可忽略（<50 ms），但它把**用户文案冻结成构建契约**：改一个词就 `exit 1`。与 §4-2#8 是同一条脆链的两端 |
| `check` 的阶段顺序 | `typecheck → test → selftest → build` | `test` 里有 2 个用例读 `lib/`（§2-6），于是"测试结果依赖上一次构建"；`build` 的片段校验放最后，最贵的 `test` 跑完才发现产物不对 |

### 量化建议（按收益排序）

| 动作 | 省时 | 门禁占比 | 风险 |
| --- | --- | --- | --- |
| ① 第二遍 TZ 改成"时区敏感子集 + 3 个时区" | **−34 s** | −41% | 低（覆盖面反而变宽：3 TZ > 2 TZ） |
| ② 给 `dogwatch` 的 `gapMs`、`em` 的 `sleep`、`breadthScan` 的 `sleep` 加注入点（生产默认值不变） | **−15.4 s**（两遍合计，A/B 实测 35.0→27.3 s/遍） | −19% | 低（只加 deps 参数，默认值原地不动） |
| ③ 修掉 `index.test.ts` 的 5 s 空等 | **−10 s** | −12% | 无（顺手把失效的断言变成真断言） |
| ④ `build` 传 `TW_SKIP_TYPECHECK=1`，只留一次 tsc | **−2.2 s** | −3% | 无（build 的类型门禁仍在） |
| ⑤ 拆出 `selftest:live` | **−5.96 s**（且去掉不可预测项） | −7% | 低 |
| **合计** | **≈ −67 s**（83 s → **16–20 s**） | **−80%** | — |

> ②③④ 都只是"把等待变成可注入/可断言"，**不改任何生产默认值、不改任何判据强度**；①⑤ 是门禁编排的调整。

---

## §6 附：判定口径与复现

```bash
# 总耗时（本文件 §0 的数据来源）
time npm run check                       # 83 s, exit 0, 1811/1811 ×2

# 分阶段
/usr/bin/time -f "typecheck %e" npm run typecheck
/usr/bin/time -f "selftest  %e" npm run selftest
/usr/bin/time -f "build     %e" npm run build                    # 3.62 s（含 tsc）
/usr/bin/time -f "build-notsc %e" env TW_SKIP_TYPECHECK=1 npm run build   # 1.42 s（esbuild only）

# 最慢用例（两遍去重取大）
#   ✔ 名称 (123.45ms)  →  按 ms 降序
```

A/B 实验（**在副本上做，未动工作区**）：

```bash
cp -r <repo> /tmp/tw-base && cp -r <repo> /tmp/tw-exp
# tw-exp 三处改动：dogwatch.ts gap 120→0；breadthScan.ts gap→0；em.ts 500ms 退避→跳过
cd /tmp/tw-base && NODE_COMPILE_CACHE=node_modules/.cache/node-compile \
  node --test --experimental-strip-types --test-concurrency=8 "src/**/*.test.ts"   # 35.0 s
cd /tmp/tw-exp  && NODE_COMPILE_CACHE=node_modules/.cache/node-compile \
  node --test --experimental-strip-types --test-concurrency=8 "src/**/*.test.ts"   # 27.3 s
```

第三时区验证（证明第二遍 TZ 的边际收益）：

```bash
TZ=America/New_York node --test --experimental-strip-types --test-concurrency=8 "src/**/*.test.ts"
# ℹ tests 1811 / pass 1811 / fail 0
```

---

## Top 5

| # | 优先级 | 问题 | 证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- | --- |
| **1** | **P1** | 全量测试跑两遍（TZ），第二遍 35.1 s 只换来"再跑一遍同样的用例"；而 `TZ=America/New_York` 也 1811/1811 全绿 | §0 表；§6 第三时区实验 | **35 s / 门禁 42%** | 第二遍收窄成 8 个时区敏感文件 × 3 个时区（≈1 s），省 34 s 且覆盖更宽 |
| **2** | **P1** | `dogwatch` 的 120 ms/批节流在"全命中磁盘缓存、零网络"的测试里照付；12 个慢用例单遍累计 36.2 s | `dogwatch.ts:326-338`；单文件 A/B 20.7 s→0.75 s、15.7 s→0.53 s；全量 35.0→27.3 s/遍 | **每遍 −7.7 s（两遍 −15.4 s）/ 门禁 19%** | `gapMs` 提成 deps（默认 120），测试传 0；或磁盘命中不睡 |
| **3** | **P1** | `index.test.ts` 一个用例空等 5 s：`setKernel(null)` 把 `inits` 变成 2，却还在等 `=== 1`；且 `waitForCondition` 超时不抛 ⇒ 该断言实际已失效 | `index.test.ts:176-182` + `index.ts:211-262`；单独跑复现 5014.7 ms | **10 s / 门禁 12%**，且"init 只跑一次"是假绿 | 改成断言 `inits === 2`（或先重置计数）；`waitForCondition` 超时必须 `assert.fail` |
| **4** | **P1** | `priceCorrection` 是 7 个高风险逻辑里唯一有真空洞的：路由 `action:'priceCorrection'` **0 条用例**、无卖出方向、无二次订正累积 | `prismRoutes.ts:588-600`；`grep priceCorrection *.test.ts` ⇒ 空；`prismCorrection.test.ts` 6 条全是 `side:'buy'` | 改 action 名/漏 `saveOrders`/卖出算错现金 —— **门禁全绿** | 补端点级 200/400 各一条 + 卖出订正 + 连续两次订正 |
| **5** | P1 | 源码扫描型断言占 15.8%（1561/9868）、用例级 34.2%；其中 611 条是纯字面量匹配，`build.mjs` 的 73 条片段表把用户文案冻成构建契约 | §4.1/§4.2 | 改文案/抽常量/换格式即红（假红），字符串留在死分支即绿（假绿） | 按 §4.2 Top10 逐条换成行为断言；`build.mjs` 片段表改为"导出常量 + 渲染级校验" |
