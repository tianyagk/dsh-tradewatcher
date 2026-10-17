# REVIEW-9：性能与效率（只读测量 + 低效率清单）

- **评估时刻**：2026-10-17 20:35–21:20（Asia/Shanghai）。
- **HEAD 漂移（必须先看）**：任务给的门禁基线是 `8b06d5d`（v0.104.0，**775 用例 × 2 时区**）；
  我开始测量时 HEAD 是 `8b06d5d`，**20:37–21:05 之间另一路提交了 `cf3f864`（v0.105.0，全项目评审批次一）**，
  用例数变成 **800 × 2**（+3 个测试文件：`pacing.test.ts` / `impl71.test.ts` / `fix7Host.test.ts`）。
  ⇒ 本报告**所有数字都在 `cf3f864` 上重测过**（`/tmp` 的 `git archive` 快照 `/tmp/rv-perf/repo-pin`，与工作区同 commit）；
  只有"与 775 基线的对照"处会标注 `8b06d5d` 的旧数。
- **本轮未改任何 `src/**`**、未 commit、未装、未动 profile、**未重启 `dsh web`**、**未在工作区跑 `npm run build`**。
  真实数据目录 `/home/hu/.dsh/dsh-tradewatcher` **只读**；所有会写盘的测量都在 `/tmp/rv-perf/home-*` 副本里做。
  唯一写入面 = 本文件。
- **测量隔离**：`DSH_HOME=/tmp/rv-perf/home-{warm2,pin,io,io2,rescue,cold3}`；上游一律 `globalThis.fetch` 桩掉（形状忠实：
  800 根日线 / 242 点分时 / 行情行全字段）⇒ 下述宿主数字是**宿主自身**的 CPU/IO/序列化，不含网络。
- **负载说明**：20:35–21:05 期间有另一位评审在同一主机跑整套门禁（`load average` 峰值 2.8），
  那一段的墙钟数**已作废**；下文标注"清载"的都是 `load < 1.4` 时测的。
- **本次实际运行的命令**（全部只读或只写 `/tmp`）：
  ```
  /usr/bin/time -f 'GATE_WALL %e USER %U SYS %S MAXRSS %M' npm test
  node --test --experimental-strip-types --test-reporter=tap|spec "src/**/*.test.ts"   # 每 TZ 一次
  node --test --experimental-strip-types <单个文件>                                    # 108 次，取独占墙钟
  node --import /tmp/rv-perf/sleeplog.mjs --test ...                                    # setTimeout 记账（>=20ms）
  strace -f -e trace=openat,statx,write,rename,getdents64,unlinkat -o ... node <bench>.mts
  node --expose-gc / --cpu-prof ... bench.mts                                           # 路由级 CPU/内存/序列化
  cat /proc/self/io                                                                     # 写放大（wchar）
  NODE_COMPILE_CACHE=/tmp/rv-perf/cc node --test ... --test-concurrency={4,8,12}
  ```

---

## 0. 结论摘要

| # | 结论 | 量级 | 状态 |
|---|---|---|---|
| 1 | 门禁 = **58.35 s**（800×2，`cf3f864`）；**单 TZ 清载 23.1 s**；串行用例时长和 76.9 s ⇒ 并行度只有 1.8× | 58.35 s | 实测 |
| 2 | 门禁的**关键路径是单个文件** `lock.test.ts`（13.07 s / 单 TZ 23.1 s 的 57%）；"跨进程锁用例 ≈22 s" 的实测值是 **16.95 s 串行 / 13.07 s 关键路径** | 13.07 s | 实测 |
| 3 | **不需要改任何断言**就能拿到的最大一笔：`NODE_COMPILE_CACHE` ⇒ 用户态 CPU **53.4 s → 25.5 s（−52%）**、子进程启动 **167 ms → 71 ms**；配 `--test-concurrency=8` 单 TZ **21.1 s → 16.7 s** | −30% 门禁 | 实测（n=2） |
| 4 | 失败注入类用例真正在等的是 `em.ts:166` 的重试退避：5 个慢文件里登记了 **19.35 s** 退避（104 次），比锁用例的手工 hold 还多 | 19.35 s | 实测 |
| 5 | 宿主热路径：`/chips` **p50 3.58 ms / CPU 4.95 ms / 131 KB**，是唯一"毫秒级"的路由；`/kline` 0.20 ms、`/quotes` 0.72 ms、`/trend` 1.45 ms、`/rescue` 0.74 ms（真实 73 KB 快照） | — | 实测 |
| 6 | `/chips` 回包 **50–66% 是同一个 242 档 `centers` 数组重复 45 遍**（83 KB / 166 KB）；只发一份 ⇒ **−49% 字节**、序列化 −0.6 ms | −82 KB/次 | 实测 |
| 7 | `/chips` 计算量 **~55% 浪费在"非展示日"的统计**（135/180 天算完就丢）；实测 `display=45` 比 `display=1` 多 **2.27 ms**，`window=60` 只 **0.54 ms** | −2.0 ms/次 | 实测+估算 |
| 8 | `/trend` **每调一次就整份重写当天归档 14.7 KB**（实测 `/proc/self/io`）；自选页迷你图 TTL 90 s、最多 80 卡 ⇒ 最坏 **1.2 MB / 90 s** 的纯重复写入 | 14.7 KB/次 | 实测（写字节）+ 估算（卡数） |
| 9 | `trends-lkg.json` **2.34 MB**，节流 5 s；"内容未变不写"的指纹里含 `Date.now()` ⇒ 该守卫永远失效。**实施时发现更严重的一层**：v0.91.0 起 `persistTrendLkg` 有两个顺序 bug（先清 `dirty`/先推进 `lastWrite` 再判定）⇒ 该文件**实际从未更新**（本机停在 10-16 10:03）。已在 `AUDIT-IMPL73.md` §3.2 修复 | 2.34 MB / 5 s（设计值） | 实测（代码+文件 mtime）+ 实施期复核 |
| 10 | 护盘快照 73.5 KB，**89% 是六通道 × 242 点**，每点 48.1 B 里 **39% 是 `"hhmm":""` / `"price":null`**；丢空字段 ⇒ 73.5→40.1 KB（−45%） | −33 KB/次 | 实测 |
| 11 | 启动到可服务 **≈70 ms**（Node 50 + import 15 + apply 4）+ `store.init` 5.4 ms；无启动瓶颈 | 70 ms | 实测 |
| 12 | 测试套件 **108 文件 = 216 个进程**，纯进程启动开销 7.4 s / 76.9 s（串行和）；`repoHygiene ④` 单例 **1.69 s** 全是 O(导出×文件) 正则扫描 | 1.69 s | 实测 |

---

## 1. 门禁耗时（`npm test`）

### 1.1 墙钟

```
$ /usr/bin/time -f 'GATE_WALL %e s  USER %U s  SYS %S s  MAXRSS %M KB' npm test
GATE_WALL 58.35 s  USER 105.00 s  SYS 13.90 s  MAXRSS 168992 KB
# 输出：ℹ tests 800 / ℹ pass 800（每个 TZ 各一遍；本机 4 核）
```

分 TZ（同一 commit，`tap`+`spec` 双报告器，比默认报告器略慢）：

```
$ node --test --experimental-strip-types --test-reporter=tap --test-reporter-destination=... "src/**/*.test.ts"
LOCAL_TAP_WALL 29.35 s      # 用例时长和 53.84 s
$ TZ=UTC node --test ...
UTC_TAP_WALL 32.00 s        # 用例时长和 51.95 s
```

清载对照（默认报告器、单 TZ、`/tmp` 快照、`load<1`）：**23.1 s / 23.1 s**（两次几乎一致）。

⇒ **并行度只有 1.8×**（53.8 s 用例时长和 ÷ 29.35 s 墙钟），因为：
① 4 核上限；② **单个文件内的用例是串行的**，而最慢那个文件自己就 13 s（见 1.3）。

### 1.2 最慢 10 个用例（+ 第 11 名并列；清载 TAP，单 TZ）

| # | 用例 | 时长 | 为什么慢（证据） | 状态 |
|---|---|---|---|---|
| 1 | `L10 覆盖证明：store 的四个状态文件都**真的**在锁内写` | **4 336.6 ms** | 4 个文件**串行**各做一次：spawn 子进程（167 ms）+ 等 `held` + **外部持锁 500 ms** + 再次写。4×(500+170+)≈3.7 s | 实测 |
| 2 | `P1-1 源 B 失败：30s 内第二次调用不再重扫 56 页` | 3 689.8 ms | 3 台主机全失败 ⇒ 每台每次失败都走 `em.ts:166` 退避 `60+attempt*120+rand*140 ms`；`fetchDedupe`+`chips`+`usChart` 三文件合计登记该退避 **4 836 ms / 26 次**，本用例占大头 | 实测 |
| 3 | `L5 等待是有界的：锁被占用 ⇒ 超时抛 LockTimeoutError` | 2 730.3 ms | 子进程 `holdMs: 2500`（**故意持锁 2.5 s**）+ 等锁者按 `lock.ts:167` 抖动退避轮询 | 实测 |
| 4 | `① 触发瞬间的家数：搭车进事件` | 2 649.6 ms | `sampleNow()` 六通道 × 源回退链，上游失败时付 `em.ts:166` 退避；`sina.ts:252` 每批再 60 ms | 实测 |
| 5 | `③ 分时点带六通道读数` | 2 169.8 ms | 同上（同一 `sampleOnce` 夹具，第二次完整采样） | 实测 |
| 6 | `② K 线缓存裁剪：两进程同时裁剪` | 1 776.7 ms | 2 个子进程（各 167 ms 起）+ 两侧 `pruneKlineCache`（测试造了 >300 个文件 ⇒ 走 `readdir`+207 `statx` 分支）+ 250 ms 轮询 | 实测 |
| 7 | `④ 导出面：不许新增"零引用导出"` | 1 688.1 ms | **纯 CPU**：**1 216 个导出名 × 121 个非测试源文件 = 14.7 万次** `new RegExp(...).match()` 全文扫描（文本 1.75 MB） | 实测 |
| 8 | `② 分时：出真序列（美东标签）` | 1 309.4 ms | 上游失败 → `requestKlineRaw` 的 `attempt===0` 固定 **500 ms** 退避（`em.ts:2617`）；上述三文件合计登记 **2 500 ms / 5 次** | 实测 |
| 9 | `L1 跨进程不丢更新` | 1 270.5 ms | 2 个子进程（334 ms）+ `startAt` 对齐 800 ms 里的一部分 + 3 次 80 ms hold | 实测 |
| 10 | `L2 反例注入①：完全无锁` | 1 223.6 ms | 2 个子进程 + 200 ms hold + 时序窗口 | 实测 |
| 11 | `L3 反例注入②：进程内队列` | 1 222.5 ms | 同 L2 | 实测 |

> `L4/L7/L8/L11` 合计仅 35 ms —— 同一文件里**有快有慢**，说明慢的是"真子进程 + 真等待"，不是文件级固定成本。

### 1.3 慢在哪：把等待记账

用 `--import` 钩子记录所有 `setTimeout(ms>=20)` 的登记点（5 个最慢文件，`cf3f864`）：

```
registrations(>=20ms): 212   sum_ms: 39 627
  19 351 ms  n= 104  em.ts:166      ← fetchAny 重试退避（真实 await）
   7 200 ms  n=  18  degrade.ts:253 ← 聚合 flush（.unref() 防抖，不真等）
   6 000 ms  n=   2  rescue.ts:2179 ← withBudget 3s（Promise.race，超时才等）
   3 876 ms  n=  26  lock.ts:167     ← 等锁抖动退避（真实 await）
   2 000 ms  n=   4  em.ts:2617      ← K 线 500ms 重试（真实 await）
   1 140 ms  n=  57  fetchDedupe.test.ts:141 ← 测试桩自身 20ms 批延迟
```

按文件（独占墙钟，串行 108 个文件跑）：

```
files=108  wall_sum=76.9 s  self_sum=69.5 s  overhead=7.4 s   ← 进程启动开销只占 9.6%
lock.test.ts               13 071 ms (12 用例)
fetchDedupe.test.ts         5 545 ms (20)
rescuePiggyback.test.ts     5 038 ms (6)
degrade.test.ts             3 805 ms (10)
klineLock.test.ts           2 982 ms (2)
routes.test.ts              2 836 ms (17)
globalFlow.test.ts          2 280 ms (33)
rescueSnapshotContract      2 093 ms (3)
fix1Redline.test.ts         2 071 ms (4)
usChart.test.ts             2 011 ms (8)
repoHygiene.test.ts         1 744 ms (6)
```

**修正任务里给的线索**：跨进程锁三件套 = `lock` 13.07 + `klineLock` 2.98 + `rescuePersist` 0.90 = **16.95 s 串行和**；
并发跑时它们大多在同一条核上排队，所以"占整套约 80%"只对**关键路径**成立（13.07/23.1 = 57%），
也不是"占 80% 的 CPU"：整套 user+sys 119 s，锁三件套单独跑 **11.2 s CPU**（user 9.5 + sys 1.7；其中大部分是 14 次子进程启动，不是等待）——
真正的 CPU 大头散在 108 个文件里。

### 1.4 能压到多少（不改断言）

**实测（可直接落地，零断言改动）**：

| 手段 | 单 TZ 墙钟 | 用户 CPU | 证据 |
|---|---|---|---|
| 基线 `conc=4` | 23.1 s | 53.4 s | 两次 23.13 / 23.12 |
| `--test-concurrency=8` | 21.0 s | 55.3 s | 20.91 / 21.37 |
| `NODE_COMPILE_CACHE` + `conc=8` | **16.2–17.3 s** | **25.9 s** | 16.16 / 17.31 |
| `NODE_COMPILE_CACHE` + `conc=4` | 24.5–25.0 s | 25.5 s | CPU 减半但墙钟没动（关键路径没变） |
| 子进程启动（`lock.child.ts`） | **167 ms → 71 ms** | — | 3 次 · 开缓存后 71.0/73.5/166.7（首个是建缓存） |

⇒ **仅这两项**：`npm test` 58.35 s → **≈33–35 s（−40%）**。

**估算（需改测试/取数层，断言强度不变）**：

| 手段 | 预计每 TZ 省 | 怎么改（不改判据） | 风险 |
|---|---|---|---|
| 退避可注入（`em.ts:166` / `em.ts:2617`） | **5–8 s** | 把"退避时长"提成可注入常量（`setRetryDelayScale` 或测试 `process.env.TW_TEST_NO_BACKOFF=1`）；**重试次数、失败分支、请求计数断言的数值全部不变**，只是不再真等 | 中：真实时序不再被覆盖；建议同时加一条纯函数断言锁住退避序列（现有 `trendWriteDecision` 就是这种形状的先例） |
| `lock.test.ts` 用例并行 + 缩窗口 | **3–5 s** | L10 的 4 个文件互不相关 ⇒ 放进 `describe(..., { concurrency: 4 })`（判据仍逐文件断言"写入等了 ≥ HOLD-200ms"）；L5 把 `holdMs:2500`/`timeout` 按比例缩到 700/250（判据是"抛 `LockTimeoutError` 且不写"）；L6b 的 5 s hold 同比例缩 | 中低：窗口太小时慢机器上会抖；建议留 3× 余量 |
| `repoHygiene ④` 单次分词 | **1.4 s** | 先对 121 个文件（1.75 MB）做**一遍** `/[A-Za-z_$][\w$]*/g` 统计 `Map<token, 计数>`，`referenceCounts` 变 O(1)；`\bName\b` 与"整 token 相等"对标识符完全等价 | 低 |
| `trend` 归档去重 | **0.3–0.8 s**（连带宿主） | 见 §3.2：内容未变则不写 | 低 |
| 慢用例合并（`chips.test.ts` 2 例 1.12 s 全在等 K 线 500 ms 退避；`usChart` 2 例 1.74 s 同因） | 已被上一条覆盖 | 同"退避可注入" | — |

⇒ **估算总落点：`npm test` 58.35 s → 24–30 s（−50%~−60%）**，其中"不改任何 src"只能拿到 33–35 s。
**下限**：单 TZ 用户 CPU 25.5 s ÷ 4 核 ≈ 6.4 s，加 `lock.test` 压到 ~5 s 的关键路径 ⇒ 理论 ~8–10 s/TZ（未验证）。

---

## 2. 宿主热路径（真实缓存 + 桩上游，N=100）

方法：直接 `import` 真 `makeTradeRoutes(...)` 并调 handler（不起 web 服务），`DSH_HOME` 指向真实数据副本，
上游桩掉。`p50/p95/cpu` 是 `performance.now()` / `process.cpuUsage()`；`bytes` 是 `res.send` 的 JSON 字节。

```
{"url":"/tradewatcher/quotes?ids=…30 个…","N":100,"p50":0.715,"p95":1.165,"cpuMsPerCall":0.936,"bytes":9338}
{"url":"/tradewatcher/trend?secid=0.000636&ndays=1","N":100,"p50":1.449,"p95":1.764,"cpuMsPerCall":1.668,"bytes":24538}
{"url":"/tradewatcher/kline?secid=0.000636&klt=101&lmt=240","N":100,"p50":0.204,"p95":0.366,"cpuMsPerCall":0.250,"bytes":24343}
{"url":"/tradewatcher/chips?secid=0.000636","N":100,"p50":3.580,"p95":9.253,"cpuMsPerCall":4.954,"bytes":131234}
（真实 73 KB 快照，`ensureFresh` 桩空）{"p50":0.736,"p95":1.235,"cpuMsPerCall":0.948,"bytes":78676}
```

首次调用（进程刚起、磁盘缓存热、上游桩）：`quotes 23.3 ms`、`trend 60–82 ms`、`kline 4.3 ms`、
`chips 32–82 ms`、`rescue 26–88 ms`（含 18 次上游）。

### 2.1 重复计算 / 可缓存却重算

**① `/chips`：`centers` 每个展示日重建 + 序列化 45 遍（最大的一处）**
`src/host/chips.ts:558`（`centers: centers.map((c) => round(c, 4))`）在 45 个展示日里各生成一份**元素完全相同**的数组；
`src/host/chips.ts:494` 的 `centers` 在整段序列里是同一个数组。

```
$ 实测 chips 回包（secid=1.603668，242 档）
total 166 134 B；centers 83 071 B (50.0%)；buckets 70 652 B (42.5%)；其余 12 411 B
centers len 242；跨 45 天 identical=True
若 centers 只在顶层发一份 ⇒ 估算 84 470 B（−49%）
```

**② `/chips`：非展示日的统计量算完就丢（≈55% 的递推成本）**
`src/host/chips.ts:516-552`：对**每一天**都算 `total → norm(map) → avg(reduce) → support/resistance(percentilePrice×2) → narrow → profitRatio`，
然后 `if (i < win.length - display) continue`（`chips.ts:554`）把 135/180 天的结果直接丢掉。
旋钮对照（真实 805 根日线、242 档，40 次均值）：

```
window=360 display=45   4.708 ms
window=180 display=45   3.673 ms   ← 生产默认
window=180 display=1    1.408 ms   ⇒ 44 个展示日 = 2.27 ms（52 µs/日）
window=60  display=45   0.544 ms   ⇒ 120 个非展示日 = 3.13 ms（26 µs/日）
window=180 display=45 buckets=96  1.603 ms
```

把 `total/norm/avg/support/resistance/profitRatio` 挪到 `continue` 之后 ⇒ 估算省 **~2.0 ms/次（−54%）**，输出逐字节不变。
另有 `percentilePrice`（`chips.ts:351`）自己又 `reduce` 一遍总量（调用方已有 `total`），2 次/日。

**③ `/chips`：序列化占 CPU 的 16.5%**——`routes.ts:132` 的 `send()` 调 `JSON.stringify(131 KB)`。
CPU profile（120 次调用，939 ms 采样）：

```
247.3 ms 26.3% chipSeriesOf @ chips.ts
155.2 ms 16.5% send @ routes.ts          ← 就是 JSON.stringify(131 KB)
 74.7 ms  8.0% allocateSpread @ chips.ts
 69.6 ms  7.4% (anonymous) @ chips.ts     ← 每日的 .map/.reduce 闭包
  9.4 ms  1.0% percentilePrice @ chips.ts
```

**④ `/trend`：每次调用都重写归档**（`em.ts:1605` 的注释是"出口一律归档"，有意为之，但没做"内容未变"判断）：

```
$ 12 次 /trend（时钟每次 +5 s），/proc/self/io wchar 增量
writtenBytes 176 768  ⇒ 14 731 B/次（本次桩数据序列化后 14.7 KB；真实归档文件 17 341 B）
$ strace -f -e openat,statx,write,rename,getdents64：20 次 /trend
openat trends 60（3/次）· getdents 80（4/次 = 2 次 readdir）· rename 20（**1/次**）
```

`trendArchive.ts:179` 对**每个** entry 调一次 `dirSize`（`readdir` + 每个文件一次 `statx`），`trendArchive.ts:191` 再 `prune` 一次 `readdir`；
微基准（5 entry、目录 12 个文件）：**≈68 statx + 6 readdir + 5 次整份重写（109 KB）/次调用，5.58 ms/次**。

**⑤ `/quotes`：没有重复计算，但 LKG 整份重写**（见 §3.3）；`quoteProvenance`（`em.ts:417`）只重走 `missing[]`，不是热点。

**⑥ `/rescue`：每次采样都把 242 点 × 6 通道的序列化一遍**（0.95 ms CPU；见 §4）。

---

## 3. 缓存效率

### 3.1 命中率（strace 实测，N=20/10/20，真实缓存副本）

| 路由 | 进程内首次 | 稳态每次 | 结论 |
|---|---|---|---|
| `/kline` ×20 | 1 次 `openat klines`（115 KB） | **0 次磁盘读、0 次上游** | 内存命中 19/20 = **95%**；磁盘命中 20/20 |
| `/chips` ×10 | 2 次 `openat klines`（fqt=1 + fqt=0） | 0 次 | 内存命中 9/10 = 90% |
| `/quotes` ×20 | 1 次 `openat quotes-lkg`（41.6 KB） | 0 次上游（TTL 槽） | 上游 20/20 命中 |
| `/trend` ×20 | 读归档目录 | 3 `openat` + 4 `getdents` + **1 rename（写）** | 读命中，**写不命中** |

### 3.2 写放大（`/proc/self/io` + strace）

| 目标 | 频率 | 每次字节 | 折合 | 状态 |
|---|---|---|---|---|
| `trends/<secid>/<day>.json` | **每次 `/trend`** | 14.7 KB（实测） | 自选页迷你图 `mini.ts`（TTL 90 s、`MAX_ROWS=80`）⇒ 最坏 **1.2 MB/90 s** 的逐字节相同重写 | 实测(单次)+估算(卡数) |
| `trends-lkg.json` | 节流 5 s，`rememberTrend` 后必写 | **2 342 731 B**（真实文件） | 2.34 MB / ≥5 s；`payloadFingerprint` 里含 `ts: Date.now()`（`em.ts:1348`）⇒ `em.ts:1375` 的"内容未变不写"**永远不触发** | 实测（代码+体积） |
| `quotes-lkg.json` | 节流 45 s（`LKG_PERSIST_MS`） | 41 627 B（132 行）；上限 1500 行 ⇒ ≈470 KB | 41.6 KB / 45 s 整份重写 | 实测 |
| `klines/<secid>_<klt>_<fqt>.json` | 有新 bar 时（含"美股有拆股标记"时**每次都写**） | 114 710 B（805 根） | `em.ts:2979` 的判据 `|| entry.splits.length > 0` 让美股标的每次刷新都整份重写 | 实测（代码）/估算（频率） |
| `klines` 目录裁剪 | 首次落盘后每 10 min | `readdir` 一次（真机 207 项）；仅当 >300 个文件才继续 207 次 `statx`（现 207 < 300 ⇒ 只 readdir） | 一次 ~1 次 readdir | 实测（代码+目录项数） |

> `/kline` 的"有新 bar 才写"判据（`em.ts:2977`）比较的是**最后一根的日期**：盘中当天那根只改价不改日期、根数也不变，
> 所以盘中增量**不会落盘**——这不是写放大，而是"重启后当根回退"。但它与 `|| entry.splits.length > 0` 并排，
> 后者让**美股**变成"每次刷新都整份写"。（正确性影响不在本报告范围，仅记录。）

### 3.3 `readdir` / `stat` 频率

- `/trend` 每次：2 次 `readdir`（2 个 `dirSize` 里的 1 个 + `prune`）+ 每个 entry 12 次 `statx`；5 日档 ⇒ 6 次 `readdir` + 60 次 `statx`（微基准 68/次）。
- `pruneKlineCache`：每 10 min 一次 `readdir`（207 项）；超过 300 个文件才继续 `statx`（当前未触发）。
- `store.fileMtime`：`/watchlist`、`/ledger` 等**每个请求** 1 次 `statx`（`store.ts:690`）——单次 ~10 µs，可接受。
- `/quotes`、`/chips`、`/kline` 稳态 **0 次** `readdir`/`statx`。

---

## 4. 载荷大小（真实缓存 + 桩上游，跨 24 个真实自选标的）

| 路由 | P50 | P95 | 最大 | 说明 |
|---|---|---|---|---|
| `/quotes` 30 ids | 9 338 B | — | 15 053 B（41 ids） | 357 B/行；无冗余字段 |
| `/kline?lmt=240` | 23 649 B | 24 359 B | 24 470 B | 100.9 B/根；其中 `"pct":null` × 240 ≈ **2.9 KB (12%)**（本批缓存里 pct 全为 null） |
| `/trend` | 24 538 B | 24 539 B | 24 539 B | 101 B/点；`label:"2026-10-16 10:00"` 每点 25 B ⇒ **6.1 KB (25%)** 与 `t` 冗余 |
| `/chips` | 135 437 B | 167 612 B | **167 788 B** | `centers` 50–66%、`buckets` 42%、其余 ~7% |
| `/rescue` | **78 676 B** | — | 78 676 B | 快照 73 456 B + history(30)/calibration ≈5 KB |

**是否必要 / 可裁剪**：

1. **筹码（自适应后 242 档）**：`centers` 是**轴**，不是每日数据 ⇒ 只发一份就够（客户端 `ChipsPanel.tsx:74,98,101,104` 现在读 `day.centers`，
   改成读顶层 `payload.centers` 一处即可；`api.ts:5` 的 DTO 加一个顶层字段）。
   **实测估算 166 134 → 84 470 B（−49%）**；序列化 −0.6 ms/次。**必要性：没必要这么大。**
   另：`buckets` 保留 45×242 是产品的"每日筹码分布"本体，不动。
2. **护盘快照**：`etfSeries` 6 通道 × 242 点，每点 `{"hhmm":"","amount":…,"price":null}` = 48.1 B，
   **其中 39% 是空字符串/显式 null**。三种编码实测：

   ```
   etfSeries 现状        69 789 B
   去掉空字段           36 393 B（−48%）
   数组编码 [amount]    20 433 B（−71%）
   快照 73 456 → 40 060 / 24 100 B；整条路由 78 676 → ≈45 KB / ≈29 KB
   ```

   **必要性**：242 点是"当日每分钟成交额"的图形精度，删点会改变图形；但空字段与 12 位小数没有信息量。
   建议：空 `hhmm`/`price` 不序列化（客户端按 `?? null` 读，已有先例）、`amount` 取整到分。
3. `/kline` 的 `pct:null`、`/trend` 的 `label` 属"可选二级裁剪"，涉及客户端解析，收益 12%/25%，不建议本轮动。

---

## 5. 启动成本

```
# 生产实际加载的是 lib/index.js（build 产物）
{"mode":"lib","bootToImport":101.4,"importMs":15.0,"applyMs":3.9,"routes":26,"firstRequestMs":27.7,"totalMs":448.6,"rssMB":84.4}
{"mode":"lib","bootToImport":116.8,"importMs":14.8,"applyMs":3.7,"routes":26,"firstRequestMs":23.0,"totalMs":458.6,"rssMB":84.7}
# 开发态加载 src/index.ts（--experimental-strip-types）
{"mode":"src","importMs":177.7,"applyMs":3.4,"routes":26,"firstRequestMs":23.2,"rssMB":108.5}
{"mode":"src","importMs":366.3,"applyMs":8.7,"routes":26,"firstRequestMs":7.9,"rssMB":110.7}

$ node -e ""                    → 0.05 s（Node 自身启动）
$ DSH_HOME=<真实数据副本> node init.mts
{"storeInitMs":5.52,"calendarInitMs":2.94,"watchItems":41,"portItems":10}   # 三次 5.4–7.1 ms
```

- **启动到可服务 ≈ 50 ms（Node）+ 15 ms（import lib）+ 4 ms（apply，注册 26 条路由）≈ 70 ms**；`store.init()` 5.4–7 ms 是异步的，不挡路由注册。
- 开发态 `--experimental-strip-types` 让 import 从 15 ms 涨到 **162–366 ms**（+110–350 ms）、RSS +24 MB；**生产不受影响**（`npm test` 每进程都付这笔，见 §6）。
- 冷启动首请求（空 DSH_HOME + 桩上游）：

```
{"quotes":{"firstMs":23.8,"bytes":1530,"upstream":2},"kline":{"firstMs":4.7,"bytes":20277,"upstream":2},
 "trend":{"firstMs":7.9,"bytes":24538,"upstream":1},"chips":{"firstMs":3.9,"upstream":2},
 "rescue":{"firstMs":16.5,"bytes":8318,"upstream":18}}
```
   `chips` 冷启动真实值另测为 **32–82 ms**（上面 3.9 ms 是"高=低"早退分支，桩数据退化）。**无启动瓶颈**。

---

## 6. 测试套件结构

- **规模**：108 个文件 / 800 用例；`npm test` 跑两遍（本机 + UTC）= **216 个 Node 进程**。
- **固定开销**：串行墙钟和 76.9 s 里只有 **7.4 s（9.6%）** 是进程启动；真正的时间在用例内部（69.5 s）。
  `--experimental-strip-types` 是每进程的固定成本（import 段 162–366 ms 的一部分）：`NODE_COMPILE_CACHE` 实测把子进程启动 **167 → 71 ms**。
- **可合并 / 重复的 fixture**（文本计数）：

```
stubFetch        3 files        mkdtempSync 共 81 次 / 28 文件
resetBreakers    3 files        new DataStore 共 23 次 / 12 文件
spawnChild       3 files        new RescueMonitor 共 11 次 / 7 文件
sleep            2 files        makeTradeRoutes 共 12 次 / 5 文件
```
  这三个 `spawnChild` 是**不同语义**（lock 夹具 / kline 锁夹具 / rescue 持久化），不建议硬合并；但
  `stubFetch`（`fetchDedupe` / `degrade` / `rescuePiggyback`）可以抽到 `src/host/testSupport.ts`（纯测试面，不动 src）。
- **无谓子进程**：没有。3 个文件用真子进程是**断言本身**（跨进程互斥/原子写），删了就削弱证明。
- **可合并的用例**：
  - `chips.test.ts` 17 例 1.36 s，其中两例 **613 + 510 ms 几乎全在等 K 线回源的 500 ms 退避**（`em.ts:2617`，与业务无关）。
  - `usChart.test.ts` 8 例 2.01 s，两例占 **1.74 s**，同样是回源失败重试。
  - `repoHygiene ④` 1.69 s 是纯算法问题：**1 216 个导出名 × 121 个非测试源文件 = 14.7 万次全文正则**（见 §1.4），单例收益最大。
- **门禁结构建议（不改断言）**：
  1. `npm test` 前置 `NODE_COMPILE_CACHE=.cache/node-compile`（`.gitignore` 加一行）；
  2. `--test-concurrency=8`（本机 4 核实测 16.2–17.3 s/时区；慢 CI 可回落到 4）；
  3. 退避常数可注入 + 锁用例分组并行；
  4. `repoHygiene ④` 单次分词。
  预计 `npm test` **58.35 s → 24–30 s**（其中"只做 1+2"就能到 **33–35 s**）。

---

## 7. 收益最大的三项（可直接排期）

| 排序 | 动作 | 预计节省 | 依据 | 风险 |
|---|---|---|---|---|
| **1** | 门禁：`NODE_COMPILE_CACHE` + `--test-concurrency=8`（再叠加"退避可注入 + 锁用例并行 + repoHygiene 分词"） | **−24 s**（58.35→33–35 s）；叠加后 **−30~−34 s**（→24–30 s） | §1.4 五组实测 + 估算 | 低（前两项零源码改动）；中（退避注入会少覆盖真实时序，需保留一条退避序列的纯函数断言） |
| **2** | `/chips`：`centers` 只发一份（顶层）+ 非展示日跳过统计 | **−82 KB/次（−49%）**、**−2.0 ms CPU/次（−40%）**、序列化 −0.6 ms | §2.1①、§2.1② 实测（`centers` identical=True；display 旋钮对照） | 低（客户端 `ChipsPanel.tsx` 改 4 处读顶层；服务端只删重复数组，数值逐字节不变） |
| **3** | `/trend` 与 `trends-lkg` 的写放大：归档按内容指纹跳过 + `dirSize` 只算一次 + `prune` 节流；`trends-lkg` 指纹排除 `ts` | 单次调用 **−14.7 KB 写 + ~2–6 次 readdir/statx + 1–3 ms**；迷你图场景 **−1.2 MB/90 s**；`trends-lkg` **2.34 MB/5 s → 仅内容变化时（≈1 次/分钟）** | §3.2 实测（`/proc/self/io` 14 731 B/次；指纹含 `ts` 的代码路径） | 低-中：归档"内容不变就不写"必须逐字节比较（可复用 `payloadFingerprint`），否则会丢盘中更新；`trends-lkg` 去掉 `ts` 后要保证"`at` 变化也算变化"（`entries.at` 在载荷里） |

**其他值得顺手做的**：护盘快照丢空字段（**−33 KB/次**，−45%）；`repoHygiene ④` 分词（**−1.4 s/时区**）；`/quotes` LKG 只在"行内容变了"才写（41.6 KB/45 s → 更低）。

---

## 8. 未确认 / 测量边界

1. **客户端真实调用频率**：`/chips` 60 s TTL、迷你图 90 s/最多 80 卡、`/rescue` 60 s（尾部 15 s）都来自**读代码**，
   没有在浏览器里实测请求数 ⇒ "1.2 MB/90 s" 是**上限估算**（取决于同时渲染多少卡）。
2. **退避可注入的墙钟收益**（5–8 s/TZ）是**估算**：没有改源码验证；`em.ts:166` 的 19.35 s 是"登记时长和"，实际等待因并发重叠会少。
3. **`--test-concurrency=8` 的稳定性**只在 4 核/16 GB、两次重复上验证；更慢的 CI 上可能因锁用例竞争变慢或抖动。
4. **`NODE_COMPILE_CACHE` 的收益**只在 Node **v24.16.0** 上实测；其它大版本需复测（低版本可能无效）。
5. **`centers` 跨市场一致性**：抽查 5 个回包（A股/港股/美股、242 档）全部 identical；代码层面它是同一个数组 `centers`（`chips.ts:373`），
   但对"未来某个分支按日重算档位"没有断言保护 —— 建议改客户端时同时加一条"`days[].centers` 若存在必须与顶层相等"的断言。
6. **`klines` 目录裁剪在真机的实际触发频率**未测（需要真实落盘轮转）；只确认了"首次落盘后每 10 min 一次、每次 readdir 207 + stat 207"。
7. **8b06d5d（775 用例）的干净基线不可得**：20:35 那次 local 跑（36.84 s）与另一路评审的门禁重叠，已作废；
   UTC 那次（30.18 s，165 MB）也重叠。**本报告的 58.35 s 只对 `cf3f864`（800 用例）成立**。
