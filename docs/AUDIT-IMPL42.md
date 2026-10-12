# AUDIT-IMPL42 —— 持久化跨进程锁 + 隐藏标的请求过滤（实现报告）

- 基线：`main` @ `24936cd`（v0.66.0）；本报告是**实现**报告，不是审计报告。
- 两份审计依据：`docs/AUDIT-CACHE-1.md`（量级/重复拉取）、`docs/AUDIT-CACHE-2.md`（对抗式复核，§1.4/§7.7 记录了
  `rescue-log.json` 无跨进程锁导致 `days['2026-10-12'].samples` 被另一实例的拍数混入、无法干净剔除）。
- 本轮本人写入面：`src/host/lock.ts`（新）、`src/host/lock.test.ts`（新）、`src/host/lock.child.ts`（新）、
  `src/host/store.ts`、`src/client/engineIds.ts`（新）、`src/client/engineIds.test.ts`（新）、`src/client/index.tsx`。
  **未触碰** `em.ts` / `breadthCount.ts` / `routes.ts` / `rescue.ts` / `build.mjs`。
- 隔离纪律：所有实验（含临时实例、注入实验）一律在 `/tmp` 下，`DSH_HOME=/tmp/...`；**未重启用户的 3080 服务**。

---

## 0. 结论（先看这一段）

1. **加锁模块已落地并被实测证明**：`src/host/lock.ts` 提供跨进程互斥（锁文件 `O_EXCL`）+ 锁内「读最新 → 合并 → 写回」。
   两个**真子进程**各 `samples += 3` ⇒ 最终 **6**（一次都没丢）；把跨进程机制退化成**进程内队列**后，
   同一批断言**必红**（实测 L1/L9/L10 全红），见 §6.1。双写最小复现：锁定实现 `0 → 2`，无锁反例 `0 → 1`（§6.2）。
2. **`store.ts` 四个状态文件（`watch/positions/ledger/prefs`）已全部走锁**，并且把"整份覆写内存"改成
   "**锁内先刷新磁盘最新状态，再改，再写**" —— 这才是"不丢更新"的关键（只锁写挡不住后写者覆盖）。覆盖证明见 §6 L10。
3. **`rescue-log.json` / `klines/` 的调用点在别人的文件里**（Lead 决定：我交 patch 说明，`fix-data-fetch` 落）。
   精确 patch 见 §5；**截至本报告成稿，三处都已按其落地**（本人已复查 diff 一致），
   且 `rescue-log` 的计数合并在 §6.3 有本人独立跑的端到端对照（新版 371→**373**，旧版 372）。仍未做完的见 §8。
4. **隐藏标的的请求过滤已修**：请求集合 = 渲染的卡片 ∪ 当前页面需要的标的（`src/client/engineIds.ts`），
   用户实测隐藏的 `1.000012` 不再进入每一拍的请求；反例（修前的 `TW_ROWS` 全量）在同一断言下必红（§6 E1/E2）。

---

## 1. `src/host/lock.ts`：锁协议与 API 契约

### 1.1 协议（获取 / 等待 / 陈旧回收 / 释放 / 崩溃）

| 环节 | 做法 | 关键性质 |
|---|---|---|
| **获取** | `open(<target>.lock, 'wx', 0o600)`（`O_EXCL` 原子判定），锁文件内容 `{pid, at, token, target, note?}` | 只有一个进程能创建成功；内容人可读（事后知道"当时谁持的锁"） |
| **心跳** | 持有期间每 `max(200, staleMs/3)` ms `utimes` 刷新 mtime（`timer.unref()`，不吊住进程） | 把"陈旧"定义成**心跳断供**，而不是"持有时间超过 N 秒" ⇒ 慢写不会被误抢 |
| **等待** | `EEXIST` ⇒ 抖动退避（`retryMs` 起步、上限 400ms，`0.5–1.5×` 抖动）重试，直到 `timeoutMs` | 同进程内同路径另有 Promise 排队链（免去自己人抢自己的锁文件） |
| **超时** | 抛 `LockTimeoutError`（`code='LOCK_TIMEOUT'`，带 `lockPath`/`holder`/`waitedMs`） | **有界**：既不无限等，也**绝不"等不到就照写"**（宁可这次失败，也不覆盖持有者的数据） |
| **陈旧回收** | 判据两条：① `age > staleMs`（心跳断供）；② 持有者 pid 已不存在且 `age > 1s` 宽限。<br>回收 = 原子 `rename(<lock>, <lock>.reclaimed-<ISO 时间>)` | rename 只有一个赢家（两个回收者不会同时"抢到"）；**原锁文件改名留存**，回收**必带原因**（年龄 + 持有者 pid + pid 是否还在）写进日志与事件 ⇒ 不静默 |
| **释放** | 读锁文件比对 `token`：一致才 `unlink`；不一致 ⇒ 记 `release-skipped` 并**保留**别人的锁 | 自己若曾被判陈旧、锁已被别人重建，**绝不误删别人的锁**（删了就是两进程同时进临界区） |
| **崩溃** | `process.once('exit')` 同步 `unlinkSync` 仍持有的锁；`kill -9` 不走钩子 ⇒ 由陈旧回收兜住 | `kill -9` 留下的锁**有界时间**内可回收（实测：死主宽限 1s 档 ~0.3–0.6s 内拿到，见 §6 L6b） |

### 1.2 API 契约（`fix-data-fetch` 直接照这个用）

```ts
// ① 通用：锁内「读最新 → 合并 → 写回」（唯一推荐的合并入口）
export async function updateJsonLocked(
  target: string,
  update: (disk: unknown) => unknown | Promise<unknown>,   // 入参＝**磁盘最新**内容（文件不存在 ⇒ null）
  opts?: LockOptions,                                      // 返回什么就原子写回什么
): Promise<unknown>

// ② 计数：samples += 1 这种（内部就是 ①，写回的是"磁盘现值 + 本次增量"）
export async function bumpJsonCounter(
  target: string,
  path: readonly (string | number)[],   // 如 ['days','2026-10-12','samples']
  delta = 1,
  opts?: LockOptions,
): Promise<number>                      // 返回写入后的新值

// ③ 只要互斥、自己管写（例如"读目录 → 按配额删文件"）
export async function withFileLock<T>(target: string, fn: () => Promise<T> | T, opts?: LockOptions): Promise<T>
export async function withFileLocks<T>(targets: readonly string[], fn: () => Promise<T> | T, opts?: LockOptions): Promise<T>

// ④ 追加式时间序列的并集（events 按 ts / intraday 按 hhmm / selfSamples 按 day）
export function mergeByKey<T>(a: readonly T[], b: readonly T[], key: (item: T) => string | number): T[]

// ⑤ 读 JSON（文件不存在 ⇒ null；内容坏掉默认**抛错**，拒绝在锁内把用户数据静默覆盖成空）
export async function readJsonForUpdate(file: string, onCorrupt?: 'throw' | 'null'): Promise<unknown>
```

`LockOptions`（全部可选，默认值即"稳态够用、异常有界"）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `staleMs` | `10_000` | 心跳断供多久判陈旧（可被回收） |
| `timeoutMs` | `15_000` | 等待上限；到点抛 `LockTimeoutError` |
| `retryMs` | `12` | 重试基础间隔（带抖动） |
| `note` | — | 写进锁文件，便于事后归因（store 用 `store:prefs.json`） |
| `onEvent` | — | 观察点：`acquire/wait/reclaim/release/release-skipped/timeout`（测试与自检据此断言） |
| `quiet` / `verbose` | 只打异常 | 默认**只把异常**写控制台（回收/跳过释放/超时/等待≥250ms）；正常获取不刷屏 |

**失败/超时行为汇总**：任何"拿不到锁"的情形都**抛错**，调用方要么重试、要么把这次变更报失败；
**不存在"锁没拿到也照写"的分支**。`updateJsonLocked` 在写入前读到的内容无法解析时默认抛错（`onCorrupt:'null'` 才放行）。

### 1.3 进程内可重入

同一进程已持有同一路径的锁时，`withFileLock` **直接执行**（`depth += 1`），不重开锁文件 ——
所以 `store.ts` 可以在外层 `lockedWrite()` 持锁的情况下，内层 `commit()` 再"获取"同一把锁而不自锁。
`withFileLocks` 按**路径排序**获取，杜绝"我等你、你等我"的死锁。

---

## 2. 加锁覆盖清单（**逐个列出**）

### 2.1 已加锁（本轮已落地，有实测覆盖证明）

| # | 文件 | 写入者 | 锁文件 | 锁内做的事（读-改-写？） | 实测证明 |
|---|---|---|---|---|---|
| 1 | `watch.json` | `store.ts:745` `mutateWatch` | `watch.json.lock` | ✅ 锁内 `reloadWatch()` → 改 → 写 | §6 L10（外部持锁 ⇒ 写入等待）、L9（两进程各加 6 条都在） |
| 2 | `positions.json` | `store.ts:912` `mutatePortfolio` | `positions.json.lock` | ✅ 同上（持仓+流水**一起**进锁，按路径排序） | §6 L10、L9 |
| 3 | `ledger.json` | 同上 + `trade()` | `ledger.json.lock` | ✅ 锁内 `reloadLedger()` → 改 → 写 | §6 L10、L9（12 条流水一条不丢） |
| 4 | `prefs.json` | `store.ts:1121` `setPrefs` | `prefs.json.lock` | ✅ 锁内 `reloadPrefs()` → 只应用本次 patch → 写 | §6 L10 |
| 5 | `*.bak`（导入备份） | `store.ts:616` `importFiles` | 与 4 个文件同一批锁 | ✅ 从 `.bak` 到四个文件写完都在锁内（**显式覆盖**，不合并） | 代码路径 + 覆盖证明同 L10 |

`store.ts` 的读出路径（`watchData()/portData()/ledgerEntries()/getPrefs()/exportFiles()/fileMtime()`）**不加锁**：
`atomic.ts` 的 tmp+rename 已保证读者不会读到半截文件；写侧先刷新再改再写，因此不存在"读到旧值写回去"的路径。

### 2.2 交接给 `fix-data-fetch` 的调用点与其余整文件覆写者（**逐个列全**）

| # | 文件 | 写入者（行号按本人读到的当前工作区） | 改前 | 现在（已落地） |
|---|---|---|---|---|
| 6 | `rescue-log.json` | `src/host/rescue.ts` `persist()` | 整份覆写 `this.file`，**无锁** | `updateJsonLocked(path, (disk) => mergeRescueLog(disk, this.file, this.samplesBase))`：`days[day].samples = 磁盘现值 + 本进程自上次成功写盘以来的拍数`；events/intraday/scoreLog 取并集；成功后才重基准（§5.1） |
| 7 | `klines/<secid>_<klt>_<fqt>.json` | `src/host/em.ts:1785` `saveKlineCache` | 原子写、无锁 | `updateJsonLocked(…, (disk) => { bars: mergeBars(磁盘旧 bars, 新 bars, KLINE_CAP[klt]) })`（§5.2 P6）。**并发端到端已验**：两进程同刻写同一文件（A=D0..D399、B=D300..D700）⇒ **701 根**、首末两端都在、无重复；注入整份覆写 ⇒ 断言红（末根变 2025-02-02） |
| 8 | `klines/` 的**prune 配额** | `src/host/em.ts:1824` `pruneKlineCache` | 读目录 → 按 mtime 排序 → 删到 300，无锁 | 整段进 `withFileLock(<klines>/.klines)`，且目录清单过滤 `.json`/点文件（**否则会把锁自己删掉**）（§5.2 P7）。**并发端到端已验**：320 个缓存 + 2 个哨兵、两进程同刻触发 ⇒ 收敛到 **300**、两哨兵都在、`.tmp`/`.lock` 各 0、两次「清理 N 个」**之和 = 22 = 322 − 300**（证明串行）；注入"去掉过滤" ⇒ 断言红（哨兵被删） |
| 9 | `quotes-lkg.json` / `trends-lkg.json` / `board-lkg.json` | `em.ts:275` / `1048` / `738` | **裸 `writeFile`**（连原子都不是，可能写出半截文件） | 已改成 `writeFileAtomic`（本人复查确认）。语义是"最新快照胜"、非读-改-写 ⇒ **不需要加锁**（§5.3） |
| 10 | `trends/<secid>/<day>.json` | `src/host/trendArchive.ts:185` | 原子写、按日单文件 | 同上（按日归档、最新胜）；本轮未纳入 |
| 11 | `calendar.json` | `src/host/calendar.ts:360` | 原子写 + 6h 同步 TTL | 跨进程会各同步一次（浪费但不丢数据）；本轮未纳入 |
| 12 | `breadth` 等自建缓存 | `src/host/breadth.ts:129` | 原子写 | 同上（快照语义） |
| 13 | `write-log.json`（写入留痕） | `src/host/writeLog.ts:76` | 原子写 | **追加式**，理论上应并集；本轮未纳入（见 §8） |

> 口径说明：**加锁不是"越多越好"**。判据是"**读-改-写** + 覆盖会丢数据"：
> 只有 6/7/8 属于必须加锁的（其中 6 是用户已经真实踩到的那个）；9–13 是"最新胜快照/原子单文件"，
> 加锁收益为零而风险（陈旧锁、排队）非零。这条判据写在 §2.3，供后续评审。

### 2.3 覆盖判据（给后续审计用）

**必须加锁** ⇔ 同时满足：① 写入方式是**整文件覆写**；② 写之前**读过**该文件（或读过由它派生的目录清单）；
③ 并发两个写者时"后写者覆盖先写者"会让**用户数据/统计**产生不可恢复的损失。
**不需要加锁** ⇔ 语义是"最新快照胜"（LKG/归档缓存），或"整份来自单次上游结果、彼此等价"（日历）。

---

## 3. `store.ts` 的并发合并语义（逐文件说明）

**核心变化**（`src/host/store.ts`）：

| 位置 | 改前 | 改后 |
|---|---|---|
| `store.ts:745` `mutateWatch` | `init()` → 改内存 → `commit` | `lockedWrite(['watch.json'])` → **`reloadWatch()`（读磁盘最新）** → `applyWatchMutation()` → `commit` |
| `store.ts:912` `mutatePortfolio` | 同上 | `lockedWrite(['positions.json','ledger.json'])` → `reloadPort()/reloadLedger()` → 改 → `commit`（含卖出可用量校验也用**刷新后**的流水） |
| `store.ts:1121` `setPrefs` | 改内存 → `commit` | 进锁 → `reloadPrefs()` → 只应用本次 `patch` → `commit` |
| `store.ts:1108` `touch()` | 把内存那份整份覆写 | 进锁 → 先刷新三个文件 → 再写回（＝按归一规则重写磁盘现状，不覆盖别人刚写的） |
| `store.ts:616` `importFiles` | 备份 + 逐文件写 | **整段在四个文件的锁内**；导入是**显式覆盖**语义 ⇒ 不做合并（锁只保证"另一个进程不插在我这四次写入中间"） |
| `store.ts:547` `commit` | 进程内 `writeChain` 串行 | 保留 `writeChain`（进程内顺序）**＋ 逐文件跨进程锁**（可重入） |

**为什么"只锁写"不够**：本类的每个变更都是"拿内存那份改完再整文件覆写"，而内存那份是**装载/上次刷新**时的
磁盘快照。锁只串行化"写"，B 进程仍会用**自己那份没有 A 的条目的快照**覆盖 A 刚写的内容 —— 丢更新。
所以必须"进锁 → 刷新 → 改 → 写"。三个子文件的具体口径：

- `ledger.json`：**追加式**。刷新后再 append ⇒ 两个进程的流水都在（实测 L9：两个子进程各 6 条 `add`，共 12 条，一条不丢）。
  卖出/可用量校验也基于刷新后的流水（不会因为读到旧账本而误放行）。
- `watch.json` / `positions.json`：实体级（组/条目）。刷新后再改 ⇒ 两边新增都在；同一条目并发编辑时"后写者胜"（最后一次操作赢，符合用户直觉）。
- `prefs.json`：**patch 语义**。刷新后只把本次 patch 应用上去 ⇒ 两个进程改不同偏好项时两项都留下（此前后写者会整体抹掉先写者的改动）。

---

## 4. 任务二：隐藏标的仍在每拍被请求

- **问题**（AUDIT-CACHE-2 §3.11 / C11）：`prefs.stripCfg.hidden` 里用户已隐藏的 `1.000012` 仍出现在每一拍的东财请求里
  （渲染侧过滤了、取数侧没有），结果永远不会被渲染 ⇒ 纯浪费。
- **改动点**：
  | 文件:行号 | 内容 |
  |---|---|
  | `src/client/engineIds.ts`（新，全文 79 行） | `quoteEngineIds(rows, hidden, extraIds)`（请求集合＝渲染的卡片 ∪ 页面额外需要的标的）、`pageExtraIds({page,watchIds,posIds})`、`MARKET_PAGE_SECIDS`（大盘页直接读的 6 个指数，从 `TW_ROWS` 的 `cn` 行派生） |
  | `src/client/index.tsx:296-310` | 删掉 `baseIds = TW_ROWS.flatMap(...)`（**修前的每拍请求集合**），改为 `extraIds = useMemo(() => pageExtraIds({page, watchIds, posIds}), …)` + `engineIds = useMemo(() => quoteEngineIds(TW_ROWS, hiddenCards, extraIds), [hiddenKey, extraIds])` |
  | `src/client/index.tsx:8` | `import { pageExtraIds, quoteEngineIds } from './engineIds.ts'` |
- **语义边界（重要，别读成"改坏了可见性"）**：
  1. `hidden` 的语义**不变**（仍是"行情条上不显示这张卡"），渲染侧仍由 `visibleCards` 决定；本改动让"请求集合 == 渲染集合 ∪ 页面需要的标的"（E3 钉住这条不变量）。
  2. **页面真在用的标的不受隐藏影响**：自选页/持仓页那一行、以及大盘页直接 `quotes[...]` 的 6 个 A 股指数
     （`MarketPage.tsx:124-125` 的 breadth 分量 + 页内 `cnIndices`），即使被用户隐藏也继续取数 ——
     否则那些页面会凭空出现空值（那才是真的改坏语义）。E5/E6 钉住。
  3. 缺 `stripCfg` 的老 profile ⇒ 全量请求（E4），与"存隐藏集合"的既有约定一致。

---

## 5. 精确 patch（交付给 `fix-data-fetch`；本报告不含这些改动本身）

### 5.1 `rescue-log.json`（`src/host/rescue.ts`）——**必须做**，否则计数仍会互相吞

**P1. import**（`rescue.ts:18` 附近）

```ts
// 改前
import { writeFileAtomic } from './atomic.ts'
// 改后（writeFileAtomic 若本文件再无其它调用点就删掉该 import）
import { mergeByKey, updateJsonLocked } from './lock.ts'
```

**P2. 类字段**（`rescue.ts:886` `private file: LogFile = {…}` 附近新增）

```ts
  /**
   * 本进程"上次成功写盘时"各日的 samples（重基准点）。
   * `today.samples += 1` 只加在**本进程内存**里；写盘时必须变成"磁盘现值 + 我的增量"，
   * 否则两个进程各 +1 会互相吞掉（谁后写谁赢）。见 docs/AUDIT-IMPL42.md §5.1。
   */
  private samplesBase = new Map<string, number>()
```

**P3. 装载/换日时记基准**（`rescue.ts:992` 附近，`ensureDay()` 内）

```ts
    this.today = this.file.days[key] ?? { events: [], intraday: [], samples: 0, gap: false }
    this.file.days[key] = this.today
+   if (!this.samplesBase.has(key)) this.samplesBase.set(key, this.today.samples)
```
（只在首次见到该日时设；之后每次**成功写盘**后再重基准 —— 见 P4。`samples += 1` 那一行**不用改**。）

**P4. `persist()` 整体替换**（`rescue.ts:1005-1024`）

```ts
  private persist(force = false): Promise<void> {
    const run = this.writeChain.then(async () => {
      const now = Date.now()
      if (!force && now - this.lastPersist < 60_000) return
      this.lastPersist = now
      this.file.updatedAt = now
      try {
        // 跨进程：整份覆写 → **锁内「读磁盘最新 → 合并 → 写回」**（KEEP_DAYS 裁剪在合并函数里做）
        await updateJsonLocked(this.path(), (disk) => mergeRescueLog(disk, this.file, this.samplesBase), {
          note: 'rescue-log',
        })
        // **成功之后**才重基准：失败就不动基准，这次的增量下次继续算（不会丢）
        for (const day of this.samplesBase.keys()) {
          const cur = this.file.days[day]?.samples
          if (typeof cur === 'number') this.samplesBase.set(day, cur)
        }
      } catch (error) {
        console.warn('[tradewatcher] rescue persist failed:', String(error))
      }
    })
    this.writeChain = run.catch(() => undefined)
    return run
  }
```

**P5. 新增纯函数 `mergeRescueLog`**（放在 `stripSnapshot` 之后的纯函数区）

```ts
/**
 * 锁内合并（rescue-log 专用）：把"磁盘上那份"与"本进程这份"并成一份。
 * 每条规则都对应一种会丢的数据；改动前先看 docs/AUDIT-IMPL42.md §5.1。
 */
function mergeRescueLog(disk: unknown, mem: LogFile, base: Map<string, number>): LogFile {
  const onDisk = (disk !== null && typeof disk === 'object' ? disk : {}) as Partial<LogFile>
  const days: Record<string, DayLog> = { ...(onDisk.days ?? {}) }
  for (const [day, baseSamples] of base) {
    const mine = mem.days[day]
    if (mine === undefined) continue
    const theirs = days[day]
    // ① 计数：磁盘现值 + 我自上次成功写盘以来的拍数 ⇒ 两个进程各 +1 都留下
    const delta = Math.max(0, mine.samples - baseSamples)
    // ② 当日峰值不能被另一次较小的观测抹小
    const peak: Record<string, number> = { ...(theirs?.etfPeak ?? {}) }
    for (const [secid, v] of Object.entries(mine.etfPeak ?? {})) {
      const prev = peak[secid]
      if (typeof prev !== 'number' || v > prev) peak[secid] = v
    }
    const scoreLog = theirs?.scoreLog === undefined && mine.scoreLog === undefined
      ? undefined
      : mergeByKey(theirs?.scoreLog ?? [], mine.scoreLog ?? [], (s) => s.ts)
    days[day] = {
      ...theirs,                                     // 别的进程写进同一日的其它字段先留着
      ...mine,                                       // 本进程的视图（gap / etfLast / …）
      samples: (typeof theirs?.samples === 'number' ? theirs.samples : 0) + delta,
      events: mergeByKey(theirs?.events ?? [], mine.events ?? [], (e) => e.ts),
      intraday: mergeByKey(theirs?.intraday ?? [], mine.intraday ?? [], (p) => p.hhmm).slice(-120),
      etfPeak: peak,
      etfLast: { ...(theirs?.etfLast ?? {}), ...(mine.etfLast ?? {}) },
      ...(scoreLog === undefined ? {} : { scoreLog }),
    }
  }
  // ③ 裁剪放在**合并结果**上：只裁内存那份的话，被裁掉的旧日期会从磁盘"复活"
  const keys = Object.keys(days).sort()
  while (keys.length > KEEP_DAYS) {
    const drop = keys.shift()
    if (drop !== undefined) delete days[drop]
  }
  // ④ 本进程没动过的日（base 里没有的 key）一律用磁盘那份 —— 别的进程写的整天记录不许被我覆盖
  const selfSamples: LogFile['selfSamples'] = { ...(onDisk.selfSamples ?? {}) }
  for (const [secid, list] of Object.entries(mem.selfSamples ?? {})) {
    selfSamples[secid] = mergeByKey(selfSamples[secid] ?? [], list, (s) => s.day)
  }
  const pickSnapshot = (a?: PersistedSnapshot | null, b?: PersistedSnapshot | null): PersistedSnapshot | null => {
    if (a === undefined || a === null) return b ?? null
    if (b === undefined || b === null) return a
    return b.ts > a.ts ? b : a
  }
  return {
    v: mem.v,
    days,
    lastSnapshot: pickSnapshot(onDisk.lastSnapshot, mem.lastSnapshot),
    baselines: { ...(onDisk.baselines ?? {}), ...mem.baselines },
    selfSamples,
    progressCurve: mem.progressCurve ?? onDisk.progressCurve ?? null,
    progressDays: Math.max(mem.progressDays ?? 0, onDisk.progressDays ?? 0),
    updatedAt: mem.updatedAt,
  }
}
```

**验收判据（给 fix-data-fetch 的端到端验证）**：两个**真进程**同时对同一个 `rescue-log.json` 各做一次
`today.samples += 1` + `persist(true)` ⇒ 文件里的 `days[今天].samples` 必须等于**初值 + 2**；
反例注入：把 `updateJsonLocked` 换回 `writeFileAtomic(this.path(), JSON.stringify(this.file))` ⇒ 该断言必须变成 +1。

### 5.2 `klines/`（`src/host/em.ts`）

**P6. `saveKlineCache`（`em.ts:1775-1788`）**：原子写 → **锁内合并写**

```ts
// 改前（关键两行）
    await writeFileAtomic(klineFile(secid, klt, fqt), JSON.stringify({ v: KLINE_CACHE_V, secid, klt, fqt, updatedAt: Date.now(), partial, bars }))
    void pruneKlineCache()
// 改后
    await updateJsonLocked(
      klineFile(secid, klt, fqt),
      (disk) => {
        // 磁盘上已有的 bar 与本轮新取的 bar 按日期合并（**同文件**里的 mergeBars 就是现成的纯函数）
        const old = (disk !== null && typeof disk === 'object' ? (disk as { bars?: DayBar[] }).bars : undefined) ?? []
        return { v: KLINE_CACHE_V, secid, klt, fqt, updatedAt: Date.now(), partial, bars: mergeBars(old, bars, KLINE_FULL_LMT[klt] ?? bars.length) }
      },
      { note: `kline:${secid}:${klt}:${fqt}` },
    )
    void pruneKlineCache()
```
> 注意 `mergeBars(oldBars, freshBars, cap)` 的第三个参数是**上限根数**；`KLINE_FULL_LMT` 不在作用域时用
> `Math.max(old.length, bars.length)` 也可（目的是别把序列越并越长）。若判为不值得，**至少**把现有
> `writeFileAtomic` 换成 `updateJsonLocked(path, () => payload)`（保住"不与其他写者交错"）。
>
> **本人示例的一处订正（已由 `fix-data-fetch` 在落地时改对）**：上限应当用 **`KLINE_CAP`**
> （101→1200 / 102→800 / 103→600，`em.ts:1529`）—— 它才是这个**文件的缓存上限**，与既有用法
> `mergeBars(entry.bars, fetched, KLINE_CAP[baseKlt])`（`em.ts:2246`）一致；`KLINE_FULL_LMT`
> （101→800 / 102→400 / 103→240，`em.ts:1527`）只是"**首次回源要多少根**"。本人 §5.2 原示例把这两个常量
> 混用了，实际落地用的是 `KLINE_CAP[klt] ?? Math.max(old.length, bars.length)`（`em.ts:1796`）。

**P7. `pruneKlineCache`（`em.ts:1797-1826`）**：目录级互斥 + **目录清单里排除锁文件**

```ts
// 改前：函数体直接 readdir → sort → rm
// 改后（关键结构，其余保持原样）
  const dir = join(dataHome(), 'klines')
  // 跨进程："读目录 → 按配额删"是读-改-写；两个进程同时裁剪会各自按同一份旧清单删。
  // 锁文件放在被裁剪的目录里 ⇒ **目录清单必须排除非 .json 与点文件**，否则会把锁自己删掉。
  await withFileLock(join(dir, '.klines'), async () => {
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json') && !n.startsWith('.'))
    ...
  }, { note: 'klines:prune', staleMs: 30_000, timeoutMs: 10_000 })
```
（锁文件是 `<klines>/.klines.lock`；`readdir` 过滤那一行是**硬要求**。）

### 5.3 LKG 三个文件（`em.ts`）——本人复查后的口径：**不需要再加锁**

`quotes-lkg.json` / `trends-lkg.json` / `board-lkg.json` 当前已是 `writeFileAtomic`
（本人复查 `em.ts:275/738/1048`；审计时的裸 `writeFile` 已被 `fix-data-fetch` 换掉）。这三个文件的语义是
**"最近一次快照，最新者胜"**，既不是读-改-写、也没有需要累加的量 ⇒ 原子写已经消除了"读到半截 JSON"这一唯一真实风险；
再加锁只会引入新的失败模式（陈旧锁、排队），**收益为零**。**结论：保持现状即可**（若后续有人给它们加"合并"，那才是引入 bug）。

---

## 6. 断言与反例证据（全部可复跑，见 §9）

测试文件：`src/host/lock.test.ts`（12 条，用**真子进程** `src/host/lock.child.ts`）、`src/client/engineIds.test.ts`（6 条）。
**正例严格、反例宽松**：正例少一次就是红；反例只要求"露出破损（崩溃/半截读 或 丢更新）"，不钉具体表现（Lead 决定，理由写在 `lock.test.ts` 文件头 —— 去掉互斥后哪一种先发生是时序决定的）。

| 用例 | 断言（判据） | 实测结果 |
|---|---|---|
| **L1（正例，核心）** | 两个真子进程各 `samples += 3` ⇒ 最终 **6**；锁文件事后清空 | ✅ 6；`state.json.lock` 不存在 |
| L2（反例①） | **完全无锁**的读-改-写 ⇒ 必须露出破损（崩溃/半截读 或 `samples < 6`） | ✅ 露出（子进程非 0 退出或 `samples` 少） |
| L3（反例②） | 只做**进程内队列**（无锁文件）⇒ 同上必须露出破损 | ✅ 露出（`samples` 少，跨进程覆盖未被挡住） |
| L4 | 陈旧锁（伪造 `pid=999999` + mtime 60s 前）⇒ 能被回收，且 `reclaim` 事件带原因（含 `pid=999999`、`心跳断供/进程已不存在`），原锁文件改名留存 | ✅ 14ms 内完成；事件原文：`锁文件年龄 60007ms > staleMs 500ms（心跳断供）；持有者 pid=999999（进程已不存在）；原锁文件已改名留存为 …lock.reclaimed-2026-10-12T07-49-57-989Z` |
| L5 | 别人持锁时等待**有界**：`timeoutMs:250` 抛 `LockTimeoutError`，且**不写**（值保持 0）；持有者释放后同路径立刻可用 | ✅ 耗时 ~250–400ms（持有者 2500ms），文件保持 `samples=0` |
| L6a | `kill -9` 高频写入的子进程 ⇒ 期间每次读都能解析、`pad` 长度恒为 20000（**不半截**） | ✅ 40 次读 0 次 torn；`signal=SIGKILL` |
| L6b | `kill -9` 留下的锁在**有界时间**内被回收，且原因里有 pid 与年龄 | ✅ 遗留锁必然存在（子进程在锁内 5s 期间被杀），~0.3–0.6s 拿到，事件：`锁文件年龄 338ms > staleMs 300ms…（pid=284740 进程已不存在）` |
| L7 | 自己已被判陈旧后释放 ⇒ **不删别人的锁**（token 不匹配 ⇒ `release-skipped`，锁文件内容原样保留） | ✅ 事件 `release-skipped …（token 不匹配）` |
| L8 | 同进程可重入：嵌套获取不自锁、只建一次锁、最外层释放后清空 | ✅ 1 次 acquire、内层 0 次 |
| L11 | `mergeByKey`（供 rescue-log 用）：并集 + 升序 + 同 key 后者为准 | ✅ |
| **L9（正例）** | 两个真进程各用**真 `DataStore`** 加 6 条自选 + 6 条持仓（+12 条流水） ⇒ 两边都在 | ✅ 自选 12/12、持仓 12/12、流水 12/12、分组 2/2；三个锁文件均已释放 |
| **L10（覆盖证明）** | 外部**子进程**持锁 500ms 时，`store` 的 4 个文件写入**都必须等待** | ✅ `watch.json`/`prefs.json`/`positions.json`/`ledger.json` 各自实测等待 ≥ 300ms（漏锁会立刻返回） |
| E1/E2 | 隐藏集合（用户实测的 5 个债券）**不再进入请求集合**；**修前的 `TW_ROWS` 全量实现必须命中 `1.000012`** | ✅ 修后不含（23 张）；修前含 |
| E3 | 请求集合 == 渲染集合（同一套 `hidden` 口径） | ✅ 7 组取值逐一相等 |
| E4 | 老 profile（缺键 / 非数组）⇒ 全量，不收窄 | ✅ 28 张 |
| E5/E6 | 页面需要的标的不因隐藏被剔除；大盘页 6 个指数与 `MarketPage` 显示的指数名一一对应 | ✅ |

### 6.1 反例注入（把跨进程机制**退化**掉 ⇒ 断言必须红）

在 `/tmp/tw-inject`（**仓库工作区的副本**，`node_modules` 用 symlink）里把 `acquireLock` 改成"直接返回、不创建锁文件"
（＝只剩进程内队列），跑同一份 `lock.test.ts`：

```
✖ L1 跨进程不丢更新：两个真子进程各 samples += 3 ⇒ 最终 6（一次都没被吞）
✖ L4 陈旧锁能在有界时间内被回收，且回收**带原因**（不是静默抢锁）
✖ L5 等待是有界的：锁被占用 ⇒ 超时抛 LockTimeoutError，且**不写**（宁可失败也不覆盖）
✖ L6b kill -9 留下的锁在**有界时间**内被回收，且带原因（pid + 年龄）
✖ L7 自己已被判陈旧后释放：绝不误删别人重建的锁（token 校验）
✖ L8 同进程同一路径可重入：嵌套获取不自锁、也不重复建锁文件
✖ L9 真 DataStore 跨进程：两个进程各写自己的自选/持仓/流水 ⇒ 两边都在（不丢更新）
✖ L10 覆盖证明：store 的四个状态文件都**真的**在锁内写（外部持锁时写入会等待）
```

**要点**：注入后 `L1`（计数不丢更新）与 `L9`（真 `DataStore` 不丢更新）、`L10`（覆盖证明）**全部变红** ——
说明这三条断言真的在测"跨进程互斥"，不是自证。仓库源码**不含**这段注入代码。

### 6.2 双写实测（"不丢更新"的最小可复现数字）

同一份状态文件、两个**真子进程**、各写 1 次，用夹具手工跑（命令见 §9）：

```
# 锁定实现：withFileLock + bumpJsonCounter（各 +1）
$ for i in 1 2; do node --experimental-strip-types src/host/lock.child.ts '{"mode":"bump",…,"count":1,"holdMs":120}' & done; wait
bump done samples=1
bump done samples=2
$ cat state.json        → { "samples": 2 }        ← 两次都生效

# 无锁反例：naive 的"读 → 改 → 写"（＝修复前的行为）
bump done samples=-1                              ← 读到了**半截文件**（-1 ＝解析失败）
bump done samples=1
$ cat state.json        → {"samples":1}           ← 丢了一次更新
```
（这段同时抓到两种破损表现：**半截读**与**丢更新** —— 也是 §6 反例用例允许两种表现的原因。）

真 `DataStore` 的双进程写入（各建 1 组 + 1 条自选 + 1 条持仓）：

```
自选条目：['Waa0', 'Wbb0']        持仓条目：['Paa0', 'Pbb0']        流水条数：4        遗留锁文件：0
```
⇒ 两个进程写的数据都在，且锁文件全部释放干净。

### 6.3 端到端：`rescue-log.json` 的计数合并（本人独立跑，新/旧代码对照）

装置：`RescueMonitor` 的**真实现**（`init()` → `persist(true)`），两个**真进程**、隔离目录、对齐时刻同时"采样一拍"
（唯一被绕过的是需要网络的 `tick`，而它与计数无关 —— 真实路径上就是 `rescue.ts` 的 `this.today.samples += 1` 那一行）。
初值 371，两个进程各 +1：

```
--- 新版（锁内合并写）---
round1 samples: 373     round2 samples: 373        ⇒ 两次都生效（371 + 2）
--- 旧版（24936cd 的整份覆写，反例对照）---
round1 samples: 372     round2 samples: 372        ⇒ 丢了一次更新
[tradewatcher] rescue persist failed: Error: ENOENT: no such file or directory,
  rename '/tmp/…/rescue-log.json.tmp' -> '/tmp/…/rescue-log.json'
```
旧版还额外暴露一个此前没人提的缺陷：`writeFileAtomic` 的临时文件名是**写死的 `<target>.tmp`**，
两个进程同时落盘时，一个把 `.tmp` rename 走、另一个的 rename 就以 `ENOENT` 失败（**整次落盘静默丢失**，
只在控制台留一行 warn）。⇒ 锁 + 锁内合并同时消灭了这两件事。

### 6.4 交叉验证：`rescue-log` 的计数合并被**两套独立装置**验证

| 装置 | 作者 | 正例（锁内合并） | 反例（退回整份覆写） |
|---|---|---|---|
| `RescueMonitor.init()+persist(true)`，两个真进程各一拍（§6.3） | 本人 | 371 → **373**（两轮都是） | 371 → **372**（两轮都是） |
| `rescuePersist.test.ts` + `rescuePersist.child.ts`（两个真子进程各 `+= 1` → flush） | `fix-data-fetch` | 7 → **9** | 7 → **8**（断言红） |

两套装置独立写成、数字结论一致（+2 / +1），互为旁证。

### 6.5 交叉验证：`klines/` 的两处并发（`fix-data-fetch` 补测，本人复跑）

`src/host/klineLock.test.ts` + `src/host/klineLock.child.ts`（真子进程，走真实 `fetchKline → saveKlineCache`；
子进程内钉盘中时钟、并**硬断言 `DSH_HOME` 在 `/tmp`**）：

| 用例 | 正例 | 反例注入 |
|---|---|---|
| ① 两进程同刻保存**同一个** `1.600519_101_1.json`（A=D0..D399、B=D300..D700，重叠 101） | **701 根**（400+401−101）、首根 D0、末根 D700、无重复日期 | 退回 `writeFileAtomic` 整份覆写 ⇒ 断言红（末根变成 2025-02-02） |
| ② 320 个缓存文件 + 2 个"非缓存"哨兵（`.keepme` 点文件 / `keepme.txt`，mtime 故意设最旧），两进程同刻触发裁剪 | 文件数 **300**、两哨兵都在、`.tmp` 0 个、`.lock` 0 个、两次「清理 N 个」**之和 = 22 = 322 − 300**（证明两次裁剪串行、第二次看到的是第一次的结果） | 去掉 `*.json`/点文件过滤 ⇒ 断言红（哨兵被删） |

本人复跑该文件：2/2 绿（`node --test --experimental-strip-types src/host/klineLock.test.ts`），断言内容逐条核对与上表一致。

> **一条可复用的测试经验（`fix-data-fetch` 提出，本人认可并采纳）**：
> **不要拿"活着的锁文件还在"当注入哨兵** —— `.klines.lock` 的 mtime 永远是最新，而裁剪是"最旧先删"，
> 它永远不会成为删除候选，因此"锁文件没被删"这条断言咬不住"过滤逻辑被去掉"的注入（会假绿）。
> 正确的哨兵是**同属点文件/非 `.json`、但 mtime 故意设最旧**的文件（如 `.keepme`）。

### 6.6 仓库外的旁证：`chips.test.ts` 的一条失败与本人无关

`npm test` 曾出现 `src/host/chips.test.ts:314` 失败（`回源失败 + 用缓存 ⇒ stale 必须为 true`）。
用 `git archive HEAD` 在 `/tmp/tw-head-check` 重建**纯 HEAD**（不含本人任何改动）后，**同一条同样失败** ⇒
该失败与本人的改动无关（它依赖 `fetchKline` 的 `stale` 语义与运行时刻，属取数层；见 §10 提醒）。

---

## 7. 门禁（`npm run check` 实跑）

最近一次（本人改动的最终态 + 队友已落的 `rescue.ts` / `em.ts` / `klineLock.test.ts` 补丁都在工作区）：

```
ℹ tests 476
ℹ pass 476
ℹ fail 0
（默认时区；随后 TZ=UTC 再跑一遍：同为 476/476/0）

> dsh-tradewatcher@0.69.0 build
> node build.mjs

built lib/index.js + lib/client.js （v0.69.0，客户端片段校验通过：73 项）
（退出码 0）
```

- 本轮开头基线 `24936cd` 记的是 435 条 × 2；现在 476 条 × 2（本人 +18：`lock.test.ts` 12、`engineIds.test.ts` 6；
  其余为队友的取数层与 klines 并发用例）。
- `npm run check` = `typecheck`（tsc 0 error）→ `test`（双时区）→ `selftest`（`ALL HOST CHECKS PASSED (live probes soft)`）→ `build`（0）。
- 复核纪律：本人在**整套并行**（61+ 测试文件）的上下文里跑过 `npm test` 至少 3 次，`lock.test.ts` 的 12 条无抖动。

---

## 8. 未做项（逐条，不许读成"已修"）

| # | 未做项 | 原因 | 现状与下一步 |
|---|---|---|---|
| 1 | `rescue-log.json` 的锁与计数合并 | 该文件由 `fix-data-fetch` 负责（Lead 决定：只交 patch） | **已按其落地**（工作区 diff 与 §5.1 逐条一致：import / `samplesBase` / `ensureDay` 记基准 / `persist` → `updateJsonLocked` + 成功后才重基准 / `mergeRescueLog`）。本人独立端到端复跑见 §6.3（371→**373**，旧版 372） |
| 2 | `klines/` 的 save 合并 / prune 目录锁 | 同上（`em.ts`） | **已按其落地并已并发端到端验证**（`em.ts:1785` `updateJsonLocked` + `em.ts:1824` `withFileLock(join(dir,'.klines'))` 且清单过滤 `.json`/点文件）。验证由 `fix-data-fetch` 补测（`src/host/klineLock.test.ts`，两用例各带反例注入），**本人复跑 2/2 绿**并逐条核对断言 ⇒ 本项**已闭环**，见 §6.5 |
| 3 | LKG 三文件 | 已由队友从裸 `writeFile` 改成原子写 | 本人判定"不需要锁"（§5.3）——**这是一条结论，不是未做项** |
| 4 | `trends/<secid>/<day>.json`、`calendar.json`、`breadth` 缓存、`write-log.json` | 不在本轮范围（有的是原子单文件"最新胜"，有的属追加式留痕） | 按 §2.3 判据评估：`write-log.json` 是唯一"看起来该并集"的，但写入频率低、且非用户数据，留待后续 |
| 5 | 读路径的跨进程新鲜度（A 进程改了、B 进程的 GET 仍返回内存旧值，直到 B 自己发生一次写） | 本轮范围是"写不丢" | 下一步可选：给读接口加"mtime 变了就便宜地刷新一次"（`fileMtime` 已现成）。**注意**：这是**既有**行为，不是本轮引入的 |
| 6 | 真实浏览器里"隐藏卡片不再被请求"的端到端观测 | 不驱动用户浏览器、不动 3080 | 已用纯函数断言 + 反例注入覆盖；端到端观测留给 Lead/用户 |
| 7 | 上游"限流阈值/是否被限流" | 不可知（见两份审计 §3.3/§3.12） | 与本人改动无关 |

---

## 9. 复现命令

```bash
cd /home/hu/workspace/Servers/dsh/Dev/dsh-tradewatcher

# 1) 单跑两个新测试文件（含真子进程、kill -9、陈旧锁）
node --test --experimental-strip-types src/host/lock.test.ts
node --test --experimental-strip-types src/client/engineIds.test.ts

# 2) 整套（类型 + 双时区测试 + selftest + 构建）
npm run check

# 3) 反例注入（在 /tmp 副本里做，仓库源码不动）
rm -rf /tmp/tw-inject && mkdir -p /tmp/tw-inject
tar -cf - --exclude=node_modules --exclude=lib --exclude=.git . | tar -xf - -C /tmp/tw-inject
ln -s "$PWD/node_modules" /tmp/tw-inject/node_modules
#   把 /tmp/tw-inject/src/host/lock.ts 的 acquireLock 开头改成"
#   直接 return { lockPath, target, holder: {...}, depth: 1, release: async () => undefined }"
cd /tmp/tw-inject && node --test --experimental-strip-types src/host/lock.test.ts   # ⇒ L1/L9/L10 必须红

# 4) 手工观察锁文件（诊断用）
node --experimental-strip-types -e "import('./src/host/lock.ts').then(async (m) => {
  const f = '/tmp/tw-lock-demo/state.json'
  await m.withFileLock(f, async () => console.log('body; lock=', JSON.stringify(await m.inspectLock(m.lockPathFor(f)))))
})"
```

---

## 10. 需要 Lead 知道的两件事

1. **`src/host/chips.test.ts:314` 的失败与本轮改动无关**（纯 HEAD 同样失败，§6.2）；重复一次是给"整套跑挂"的归因留证据。
2. **`store.ts` 的写路径语义变了**：改前"内存即真相"，改后"进锁先刷新磁盘"。对用户可见行为的影响是
   "另一个进程的改动会在下一次写操作时被本进程吸收"（此前会被覆盖）——这是修复目标；若后续有人加"批量写"
   之类的路径，请沿用 `lockedWrite()` + `reload*()` 的写法，**不要**直接 `persist()` 整份覆写。
