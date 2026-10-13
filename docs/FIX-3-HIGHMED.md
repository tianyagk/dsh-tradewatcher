# FIX-3-HIGHMED —— 高 4 条 + 中 5 条修复记录

来源：`docs/REVIEW-2-CORRECTNESS.md` §一（H1–H4）与 §三（M1/M2/M3/M5/M6/M8）。写入面：`src/host/**`（含新文件
`breakerFetch.ts`、`fix3Highmed.test.ts`）、`src/client/**`（假断言与行归属）、`src/index.ts`(+`index.test.ts`)。
门禁：`npm run check` **EXIT=0，562/562 × 2 时区 + selftest + build（v0.76.0）**（末尾三行见 §10）。

**一行结论**：14 处绕过熔断的裸 `fetch` 全部收口到一个记账出口（并让"HTTP 非 2xx"真的进账）、锁的可重入判据改为按
**async 上下文**（兄弟调用排队，复核实测 `n=1` → 现值 2）、跳过流水不再计入当日盈亏、日历降级**落盘**且"成功但空"
单列一档；6 条假断言换成能抓的判据 + 新增两道全仓回归防线（断言强度 / 行归属），采样器复用窗口与"定稿不算 stale"
一并修掉。

---

## 1. H1 熔断器被整体绕过（14 个站点）

**新出口** `src/host/breakerFetch.ts`：`withHostBreaker(host, run)`（`:34`）——`allow()` → `claimProbe()` → 运行 →
成功 `recordSuccess()`／失败 `recordFailure()`，`finally` 必 `releaseProbe()`。
**关键一条**：`HTTP 非 2xx 也记账**（`:45`）—— 调用方普遍把 `if (!res.ok) throw` 写在**包装之外**，
只看"没抛异常"就 `recordSuccess()` 会让 5xx 永远不进账（实测：包了熔断器但 `fails` 仍是 0，等于没包）。

| 文件 | 站点数 | 主机 |
|---|---|---|
| `tencent.ts` | 5 | `qt.gtimg.cn` / `web.ifzq.gtimg.cn`×2 / `proxy.finance.qq.com` / `smartbox.gtimg.cn` |
| `sina.ts` | 3 | `hq.sinajs.cn`（行情批量 + `sinaText` 低层）/ `vip.stock.finance.sina.com.cn` |
| `calendar.ts` | 2 | `datacenter-web.eastmoney.com` / `emdatah5.eastmoney.com` |
| `rescue.ts` | 2 | `web.ifzq.gtimg.cn`（25 日线）/ `quotes.sina.cn`（5 分钟） |
| `em.ts` | 2 | 腾讯 mkline（`fetchHostThroughBreaker` 收口）+ 新浪 5 分钟（`withHostBreaker`） |

`em.ts` 的 `fetchHostThroughBreaker`（K 线首选源腾讯那条链，复核实测"每次 `/kline` 9 秒"）改为复用同一个出口；
低层 `fetchFromHost`（`em.ts:88`）保持裸 fetch —— 它的调用方只有 `fetchAny`（自带记账）与 `fetchHostThroughBreaker`，
**记进白名单并写明理由**（见 §3 的 H1 回归防线）。

## 2. H2 锁的"可重入"判据把并发兄弟当嵌套

`lock.ts:397` 新增 `AsyncLocalStorage<ReadonlySet<string>>`；`withFileLock`（`:408`）只在**当前 async 链**持有该路径时
才走可重入快路径，取得锁后用 `heldByContext.run(...)` 把路径标进"本链持有的集合"。
于是：同一临界区里的嵌套调用（`store.commit` 依赖这条）仍然直接放行、不自锁；**同进程另一个任务**（兄弟调用）
不在同一条链上 ⇒ 正常排队。复核的 X6 场景（A 持锁时发起 B）现在稳定给出 `n=2`（注入回旧判据 ⇒ `n=1`）。

## 3. H3 已跳过流水仍计入当日盈亏

`store.ts:280/296/309/316`：`replayPositionWithSkips` 现在回报 `appliedIds`（实际被应用的流水 id）。
`portfolio.ts:68` 的 `slicePosition` 只把 `appliedIds` 命中的当日买卖放进去（`dayTrades`/`dayFees` 同源），
于是"空仓 + 被跳过的卖出"不再产出 `qty=0` 却 `dayPnl=-50` 的自相矛盾行。

## 4. H4 日历降级只在内存 + "成功但空"记 ok

- `calendar.ts:49`：`CalFile` 新增**落盘**的 `lastSources`；`init` 恢复它（`:683` 每次同步写回）⇒ 重启不再"洗白"成
  `stale=false` / `missing=[]`。
- `calendar.ts:571`：`run()` 里 `count === 0` 记 **`empty` 档**（既不算成功也不算失败），`syncStatus` 给它一条
  `missing[]`（"回包正常但 0 条 —— 与'确实没有'分不开"），并让 `stale` 为真。
- `calendar.ts:680`：`syncedAt` 只在**所有被尝试的源都成功**时推进（`skipped` 不算尝试）；旧实现"任一源 ok 就推进"。
- 连带更新 `calendar.test.ts`：原来的"宏观返回空数组也算成功"契约按 H4 **作废**（改 fixture 给一条真数据），
  新增用例断言 empty 档、`asOf` 不推进、重启后仍如实报告。

## 5. 中-① 假断言 6 条（含相邻同类扫描）

| 位置 | 旧（恒真/自比较） | 新（能抓） |
|---|---|---|
| `client/chipsView.test.ts:96` | `assert.equal(/\[secid, tab, fqt\|retry\]/.test(drawer) \|\| true, true)` | 正向断言依赖数组**真的**含 `retry` / `secid,tab,fqt,retry` |
| `client/splitDrag.test.ts:66` | `assert.ok(drawer.includes("cursor") === false \|\| true)` | `assert.equal(drawer.includes('cursor'), false, …)`（样式只许 in styles.ts） |
| `host/chips.price.test.ts:75` | `panel.includes(k) \|\| panel.includes('latestBarDate')`（与循环变量无关的恒真 disjunct） | 要求**点访问**：`/\.${k}\b/`（复核实测 INJ-4 的改名注入现在会红） |
| `client/marketRefactor.test.ts:111` | `… \|\| page.includes('title: reason') \|\| …`（组件通用兜底） | 该常量必须由一条 `kvRow/missRow/statMiss(...)` **调用点实参**传入 |
| `client/chartCursor.test.ts:232` | `deepEqual(klineReadout(x), klineReadout(x))`（自比较） | 对着**固定字面量**断言 8 行读数 |
| `client/quoteState.test.ts:80` | `assert.equal(fmtPrice(1500.25), fmtPrice(1500.25))` | `'1500.25'` + `fmtPrice(9.5) === '9.500'`（口径双向） |

**相邻同类扫描（新增防线）**：`src/assertStrength.test.ts` 把三类形状钉成可执行扫描（剥注释后）：①断言实参里的
`|| true/1/'…'` 恒真兜底；②`assert.ok(true)` / `assert.equal(true,true)`；③**自比较**（按顶层逗号切分实参，
括号/引号感知 ⇒ 对象字面量里的逗号不会误判）。**自证非恒真**：坏样本 8 例必须命中、好样本 6 例不得误报、
注释里的字样不算（同一文件里的双向对照用例）。全仓扫描 0 命中（本文件自身排除，理由写在文件里）。

## 6. 中-② 行归属改成"按实际调用方推导"

`src/rowOwnership.test.ts`：`deriveRouteOwners()` 自己解析 `api.ts`（函数 → 路由）＋ 客户端**调用点**
（`api.<fn>(`，先剥注释 —— 真实调用点写成 `api` 换行 + 注释 + `.breadth(...)`，不剥就会漏）＋**本地 import 图**，
用页面组件作根做反向可达性，得到"这条路由被哪些行消费"，再与 `src/index.ts` 的 `ROW_ROUTES` 对齐（消费行必须
**恰好**等于声明的行）。第二条例用**同一份判据**对"往 core 加一个 market 路由消费者"的合成样本断言必须报冲突
（自证非恒真）；另外做了**真实文件注入**（TopBar 加 `api.board(...)`）⇒ 两条都红。

## 7. 中-③ 行情槽 TTL < 采样间隔（命中率 0%）+ 休市定稿被判 stale/假限流

- `em.ts:1024` `loadQuoteRowsShared(secids, { minReuseMs })` + `:903` 的复用判据：**调用方自己的窗口**
  （采样器按 tick 对齐：`rescue.ts:1229` 传 `interval*0.75`，尾盘 15s ⇒ 11s、盘中 30s ⇒ 22s）⇒ 采样拍内复用同一条槽、
  零额外上游；默认路径（客户端 10s）仍是"TTL = 间隔 + 一档余量"，界面不会看到更旧的数据。
- `em.ts:459`：**已定稿**（休市 + 观测时刻越过最近收盘）的行不再算 `stale`（`em` 与 `lkg` 一视同仁）⇒ 15:20 时
  15:06 的收盘价仍是"已收盘/定稿"，不再退化成"数据在延迟/限流"。盘中同样"20 分钟没取到"仍判 stale（对照断言）。

## 8. 中-④（M8）globalFlow 的"成功但空"日线进 12h 正缓存

`globalFlow.ts:748`：日线源回包正常但序列 < 2 点 ⇒ **抛错**（空 ≠ 成功）⇒ 不写 12h 正缓存，下一次会重新回源；
`missing` 也随之从"no-source（重试无用）"变成如实的失败原因（与 R2 同一原则）。

## 9. 中-⑤ `index.test.ts:491` 的 flake（`11 !== 1`）

根因不是"等得不够"，而是**判据读的是模块级计数** `__kernelStats.starts`：上一个用例的 `store.init()` 若在下一个
用例跑起来之后才落定，它的 `.then` 会把 +1 加到新用例头上（满负载时累计到 11）。
修法：`src/index.ts:99/180` 给内核加 **per-kernel `starts`** 计数；用例改读 `coreKernel()?.starts` 并加"静默窗口"
（等本内核计数连续两拍不变）。**强度不变**：本内核真启动两次 ⇒ 稳定在 2 ⇒ 断言照样失败（注入"允许重复启动"
⇒ 该用例红，见 §11）。

---

## 10. 门禁（`npm run check`）

```
EXIT=0
ℹ tests 562   ℹ suites 0   ℹ pass 562   ℹ fail 0     （默认时区）
ℹ tests 562   ℹ suites 0   ℹ pass 562   ℹ fail 0     （TZ=UTC）
ALL HOST CHECKS PASSED (live probes soft)
```
**末尾三行**：
```
> node build.mjs

built lib/index.js + lib/client.js （v0.76.0，客户端片段校验通过：73 项）
```
（550 基线 + 本轮 12 条 = 562：`fix3Highmed` 7 + `assertStrength` 2 + `rowOwnership` 2 + `calendar` 新增 1。）

## 11. 断言与反例注入（全部贴证据后恢复，md5 校验）

| 注入 | 结果 |
|---|---|
| **H1-A** 腾讯分时退回裸 fetch | ✖ H1 记账断言 + ✖ H1 回归防线（两条都咬） |
| **H2-A** 锁判据退回"进程级 held" | ✖ `两次 +1 必须都留下…实际 1` |
| **H3-A** 当日盈亏退回原始流水 | ✖ H3（`dayPnl=-50`） |
| **M5-A** 采样器复用窗口被忽略 | ✖ M5（窗口内又打上游） |
| **M6-A** 定稿行又算 stale | ✖ M6（`stale=true`） |
| **M8-A** 空日线又当成功值缓存 | ✖ M8（第二次不回源） |
| **M3-A** TopBar 里加 `api.board(...)`（真实文件） | ✖ 行归属两条 |
| **IDX-9** 允许重复启动采样器 | ✖ `task-6` 幂等用例 |
| **FA-1..FA-6** 六条假断言的对应坏状态（去掉 retry 依赖 / JS 里硬编码 cursor / 面板改名 / 原因换通用文案 / 读数改名 / fmtPrice 改口径） | 全部 ✖（`/tmp/fix3/inject/FA-*.log`） |

日志目录：`/tmp/fix3/inject/`（`H1-A.log`、`H2-A.log`、`H3-A.log`、`M5-A.log`、`M6-A.log`、`M8-A.log`、`M3-A.log`、`IDX-9.log`、`FA-1..6.log`）。

## 12. 未做项（不许读成"已修"）

| 项 | 说明 |
|---|---|
| `lock.ts` 的 L4（退出钩子按路径删锁、不校验 token） | 属"低"档且未确认是否真会误删（复核 §7 的 U3）；本轮只改了可重入判据，**未动** release/退出钩子语义 |
| H1 的"主机粒度" | 熔断键仍按 **host**：腾讯 `web.ifzq.gtimg.cn` 同时服务 K 线/分时，一类请求把它打熔断会连带另一类快速失败（既有行为，AUDIT-IMPL41 §5 已记；按 (host,endpoint) 细分未做） |
| M9/M10/M11/M12/M13/M14/M15/M16/M17 等其余"中"档 | 未在本批范围（复核里仍是独立条目；其中 M12/M13/M17 的同类已在时区批与红线批各自修掉） |
| `messages`/`docs` 同步 | `docs/DECISIONS.md` 的时区禁令已在上一批提到；本轮新增的"熔断出口/行归属推导/断言强度扫描"三条约定**未**写进 DECISIONS（属文档批） |
