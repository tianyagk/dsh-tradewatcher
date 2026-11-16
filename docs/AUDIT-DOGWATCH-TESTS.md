# AUDIT-DOGWATCH-TESTS — v0.185.0 → v0.188.0 新增测试质量审查

> **范围**：四个提交（`91ff49e` v0.185 → `577e34a` v0.188）新增/改动的 5 个测试文件。
> **基线**：`1487/1487`（开工时实测）。**只审测试**，未改生产代码、未 commit、未重启。
> **方法**：读提交态（`git show 577e34a:<file>`）而非工作区 —— 审查期间有另一位执行者在同一工作区做 v0.191.0 修复（`dogwatch.ts` / `dogwatch.test.ts` / `marketPage` 均有未提交改动），见 §7。所有"会不会红"都**实际跑过**。
> **环境**：`DSH_HOME=/tmp/dwaudt-lead`。

---

## 一行结论

**189 条断言里 71 条（37.6%）是读源码/CSS 文本的扫描型；38 条自称"必败"的注入里只有 6 条是真注入、22 条只对某一个字面量有效、4 条恒真（不触生产代码）；4 个点名模块分支无用例；已补 6 条（含真注入）并定位 1 处误删 + 1 处死代码。**

---

## §1 逐条判定：行为断言 vs 源码扫描

**判定口径**
- **行为断言**：调用生产函数/读生产常量，断言其**输出值**（输入→输出可复现）。
- **源码扫描**：`readFileSync` 读 `.ts/.tsx/.css` 后做 `includes` / 正则 / `has(selector, decl)` 匹配 —— 改名字、抽函数、换写法都会红，而行为可能完全没变。

| 文件 | 断言行 | 其中源码/CSS 扫描 | 行为/数据 | 扫描占比 |
| --- | --- | --- | --- | --- |
| `src/host/dogwatch.test.ts` | 76 | 7 | 69 | 9% |
| `src/client/dogwatchParity.test.ts` | 57 | **49** | 8 | **86%** |
| `src/client/dogwatchView.test.ts` | 25 | 5 | 20 | 20% |
| `src/client/marketCardsRemoved.test.ts` | 12 | 6 | 6 | 50%（**结构上只能是扫描**：它的被测对象就是"页面里还有没有这个词"） |
| `src/host/calendarCoverage.test.ts` | 19 | 4 | 15 | 21% |
| **合计** | **189** | **71** | **118** | **37.6%** |

> 注：`marketCardsRemoved` 的 6 条虽然也是扫描，但**这类断言是唯一可行的形态**（"功能下线了没有"只能看源码），不算脆弱缺陷；`dogwatchParity` 的 49 条则是"设计稿像素对拍"，天生贴在 CSS 文本上 —— 风险最高的一类。

### 最危险 5 条

| # | 位置 | 断言 | 为什么最危险 |
| --- | --- | --- | --- |
| 1 | `dogwatchParity.test.ts:27-88`（49 条同族） | `has('.tw-panel','border-radius:10px')` 等 | 把 CSS **字面量**当契约。改成分 CSS module、把 `padding:10px 12px` 换成 `padding-block/​inline`、或经 `var()` 间接赋值，49 条会同时红，而界面一模一样。反向也成立：值写错但文本里还留着旧串（注释/死规则）就绿。 |
| 2 | `dogwatchParity.test.ts:105` | `assert.equal(has(...,'10px') && !has(...,'14px'), true)` | 同上，且用 `!has(错误值)` 当"注入"，实际是在给同一份 CSS 加一条负向 grep。 |
| 3 | `dogwatch.test.ts:157` | `` assert.equal(page.includes('涨停'), false) `` | 整个 `MarketPage.tsx` 里**任何**位置出现"涨停"二字都会红（包括将来一条合法注释被 `strip` 漏掉的情况）。判据与"卡头有没有涨停家数"不同粒度。 |
| 4 | `dogwatch.test.ts:84` | `routes.includes('fetchDogwatch(window)')` | 绑死调用点字面形状：`fetchDogwatch( window )`、或先解构再调，都会红。 |
| 5 | `calendarCoverage.test.ts:67` | `routes.includes('builtinCoverageNoteOf(month)')` | 同上；且 `missing` 条目的 `what: '交易日历'` 也按字面量匹配。 |

---

## §2 反例注入的真实性（抽 5 条实跑）

**三类注入**（在 38 条里）
- **真注入 6 条**：把**产物改坏**（改源码文本 / 换错误实现）后喂给**同一个判据**，确认红。代表：`marketCardsRemoved.test.ts:28,36,46`、`dogwatch.test.ts:157`、`calendarCoverage.test.ts:48`、`dogwatchParity.test.ts:117`。
- **判别力型 6 条**：`dogwatchParity.test.ts:106-114`，用 `has(选择器, 错误声明)` 做负向检查 —— 证明匹配器能区分，但不是注入缺陷。
- **窄注入 22 条**：形如 `assert.throws(() => assert.equal(生产值, <某个字面量>))`，只证明"不等于**那一个**错值"。
- **假注入 4 条**：`dogwatch.test.ts:108,170`、`dogwatchView.test.ts:32,61` —— 断言的是测试自己构造的副本，**与生产代码无关**。

### 实跑输出（`node --experimental-strip-types /tmp/inj6.mjs`）

```
S1 dogwatch.test.ts:18-23 ②折算 —— 注入行 assert.throws(() => assert.equal(idx[1].index, 150))
  生产正确（index=100）跑注入行                PASS
  生产改坏（index=150）跑同一注入行              RED
  生产改坏成 99（非 150）跑同一注入行              PASS
    ⇒ 注入只对"恰好 150"有效；99 这类错值它抓不到（主断言 assert.equal(actions.length,1) 才抓）

S2 dogwatch.test.ts:104-108 ②总份额 —— 测试体不调用 dogwatch.ts
  原样执行                               PASS
  把 dogwatch.ts 整体删掉再跑               PASS
    ⇒ 该用例与生产代码零耦合（只测自己的 reduce）

S3 dogwatchView.test.ts:31-33「注入空副行必须判失败」
  真实 dwKpis(SUM)                     PASS
  假 dwKpis（sub 全空=缺陷态）               PASS
    ⇒ 两种输入同结论：这一行恒为 assert.equal(true,true)

S4 dogwatchView.test.ts:60-61「注入空字符串必须判失败」
  真实 dwCells(NULL_ROW)               PASS
  假结果（cells 已含 —）                    PASS

S5 dogwatchParity.test.ts:27 vs :105 CSS 圆角（真注入：替换 CSS 文本）
  真实 CSS(10px)                       PASS
  CSS 改成 14px 跑同一正断言                 RED

S6 dogwatch.test.ts:96-101 ①池覆盖率（真注入：只取第一只）
  真实 poolCoverageOf(满池).hit          PASS
  改坏：只取第一只                           RED
```

**判读**：S2/S3/S4 是**假注入** —— 无论生产代码怎么坏都照过。S1 是**窄注入**（只抓 150 这一个值；真正兜底的是它上面那行主断言）。S5/S6 是**真注入**。

> 这不是"作者偷懒"：这 5 个文件里几乎所有注入都写成 `assert.throws(() => assert.equal(值, 错值))`，属于同一套模板。模板本身只会证明"比较运算符可用"。真正有效的注入应像 `marketCardsRemoved.test.ts:28` 那样 —— **先把 `src` 改写，再跑同一个 `includes` 判据**。

---

## §3 覆盖缺口

| 点名项 | 现状 | 用例 |
| --- | --- | --- |
| **`dogwatch.ts` 折算检测** | 只有 `dogwatch.test.ts:15-24`：份额 ×1.5、价格 +0.5% ⇒ 判折算。**只覆盖"同向"一侧** | ❌ 缺"份额跳 + 价格反向跳"（真折算的另一形态）、缺"价格未知 ⇒ 不猜"、缺 20% 阈值边界（±20.0% / ±20.1%） |
| **`poolCoverageOf`** | `dogwatch.test.ts:99-100` 覆盖 14/14 与 1/14；`null` 入参、`ratio` 值域未测 | ⚠ 部分 |
| **`cacheUsableOf`** | 只断言过 **false** 分支（`:99`）；`true` 分支与 90% 边界（13/14 vs 12/14）无用例 | ❌ 缺 |
| **`dwTable` 的 stale 分支** | `dwCells(r, sharesStale)` 的 stale 分支（`dogwatchView.ts:58,79`）在**全部用例里传的都是 `false`**；`dwTable(..., true)` 的合计行文案 `'份额源未日更'` 从未被执行 | ❌ 完全未覆盖 |
| **窗口切换竞态** | `dogwatch.test.ts:215-221` 只测**串行** 6m→3m。并发（两个 window 同时进 `fetchDogwatch`、`inflightShares` 同日在飞）无用例 | ❌ 缺 |

**另外还发现 3 处（未被点名但同源）**

1. **总份额的聚合从未被生产级断言**：`dogwatch.ts:433` 的 `totalSharesYi` 是全池 Σ，但 `dogwatch.test.ts:104-108` 只在测试里 `rows.reduce` 一遍（见 §2 S2）。⇒ 把它改成"只取第一只"**不会红**。
2. **`parseSseShares` 的重复代码/空值/负数**：v0.188 只有"TOT_VOL=0 被丢弃"一条；去重覆盖、trim、负值都无用例（后续 v0.191 已被他人补上）。
3. **`tradingDaysBack`** 无任何直接用例：跳周末、升序、含今天都没断言。

---

## §4 flaky 诱因

| 类别 | 位置 | 说明 |
| --- | --- | --- |
| **真实网络** | `dogwatch.test.ts:66-75`、`:126-141` | `globalThis.fetch` 被替换 → 实际上是**假网络**（好）。但 `:186` `loadSharesOf` 在未注入时会走真 `fetchTextHost`；当前所有 fetch 都被 stub，风险低。 |
| **裸 `Date.now()`** | `dogwatch.ts:206`（`loadSharesOf(day, now = Date.now())`）、`:326`（`elapsedMs: Date.now() - t0`） | 测试大都传了 `now`；但 `elapsedMs` 用的是真钟。 |
| **计时断言** | `dogwatch.test.ts:211`、`:257` `assert.ok(r.stats.elapsedMs < 50)` | **最脆**：`--test-concurrency=8` 下机器一忙就超 50ms。实测本机 2569ms/7067ms 的用例里这两条仍过，但余量只有几十毫秒，属典型 flaky。 |
| **共享磁盘缓存** | `sharesCachePath()` → `<DSH_HOME>/dogwatch/shares-*.json` | 只有 `dogwatch.test.ts` 一个文件写这些文件，**文件间不串味**；但**同一文件内**强顺序依赖：`seedDays()` 写 → 后续用例读/删/损坏，重跑或并发都会互相影响。且**不清理**，污染 `DSH_HOME`。 |
| **进程内汇总缓存** | `dogwatch.ts:309` `const summaryCache = new Map()` | **无 `__reset` 导出**，测试无法清空。缓存键是 `${window}|${dayOf(now)}`，目前每个用例用不同日期，**碰巧不撞**；一旦有人复用日期或加用例，就会出现"上一个用例的 payload 泄漏到下一个"。 |
| **执行顺序** | 同上 | `dogwatch.test.ts` 的 ①–⑥（v0.190 块）依赖前序用例留下的 `summaryCache` 与磁盘状态；`node --test` 默认**同文件内串行**，但**不保证**跨文件顺序，也不保证重跑一致。 |

**结论**：没有跨文件 `shares-*.json` 串味（只有一个文件用它），但有 **同文件内顺序耦合 + 无缓存重置钩子 + 50ms 计时断言** 三重隐患。

---

## §5 删除的用例：是否合理

**实测删除量**：`e81996d..577e34a` 的 `*.test.ts` 共删除 **30 条** `test(`（不是 22+17；按提交拆：v0.185 删 30 条、v0.186/v0.187 各 0、v0.188 删 1 条），新增 42 条。

| 被删内容 | 文件 | 对应功能 | 判定 |
| --- | --- | --- | --- |
| 涨跌分布 9 档全套（⑩ 条） | `distCard.test.ts`（整文件 207 行） | `distCard.ts` / `distCardRender.tsx` 已删除 | ✅ **合理**（功能下线） |
| 分布布局/网格（100 行） | `distLayout.test.ts`（整文件） | `distLayout.ts` 已删除 | ✅ 合理 |
| 左列四卡 / P3-5 分布 / 空容器 | `marketPolish*.test.ts` 等 | v0.184 删四卡 | ✅ 合理 |
| `DIST_BUCKETS === 11` | `marketV1.test.ts:63-72` | 常量已从 `marketBlocks.ts` 移除（全仓 grep 为 0） | ✅ 合理 |
| 日内家数 / 路由接线与行归属 | `marketExtrasWire.test.ts:?` | 「分钟成交额较昨日增减」卡下线 | ⚠ **部分可疑**："行归属"不是那张卡独有的——见下 |
| **四条 effect 挂节拍信号 + 其反例注入** | `pacing.test.ts:146-175` | 四条 effect 里两条（`MarketPage.breadth` / `.marketExtras`）已随卡片下线 | ❌ **误删**：剩下两条（`WatchlistPage.industries`、`RescuePanel.trend`）**仍在线上**，删完后这两个 effect 的节拍守卫**再无任何用例** |

### 误删的两处证据

1. `pacing.test.ts:100-105` 的 `EFFECTS` 仍列着 4 条，其中 `breadth` / `marketExtras` 对应的卡片已删 ⇒ **常量本身已过期**，但没人改；而删掉的那条测试正是唯一遍历它的用例。
2. `pacing.test.ts:148` 留下 `export const __pacingHelpers = [read, EFFECTS, pacingViolations]` —— **全仓无人 import**（`grep -rn "__pacingHelpers" src/` 只命中定义本身）⇒ 死代码 + 过期常量，会给后来者"这块还有测试在管"的错觉。

---

## §6 本轮补强（6 条，全部真注入）

新增 `src/host/dogwatchGaps.test.ts`（4 条）+ 追加到 `src/client/dogwatchView.test.ts`（2 条）。**未删除任何既有断言。**

| # | 用例 | 补的缺口 | 真注入（把缺陷喂给同一判据） |
| --- | --- | --- | --- |
| G1 | 折算检测**双向**判据 | 真折算 = 份额跳 **且** 价格反向跳；价格不动的大额变化 = 申赎 | 用 v0.188 旧判据（"价格没跳空就判折算"）跑同一组输入 ⇒ 结论必须不同 |
| G2 | 覆盖率 boundary | `poolCoverageOf(null)`、`cacheUsableOf` **true** 分支、13/14 vs 12/14 边界、ratio ∈ (0,1] | 门槛从 0.9 写松到 0.5 ⇒ 12/14 会被放行 ⇒ 断言红 |
| G3 | **总份额的生产聚合** | `fetchDogwatch().summary.totalSharesYi` = Σ14（原用例只测自己的 reduce） | 只取第一只 ⇒ 与 Σ14 不等 ⇒ 断言红 |
| G4 | `tradingDaysBack` | 跳过周末、升序、末日=今天 | 用自然日倒推代替交易日 ⇒ 必含周末 ⇒ 断言红 |
| G7 | `dwCells/dwTable` 的 **stale 分支** | `sharesStale=true` ⇒ 第 9 列 `—` + title `份额源未日更` + `missing=true`；合计行 stale/非 stale 文案不同 | 忽略 `sharesStale`（永远按未 stale 渲染）⇒ 断言红 |
| G8 | 缺数据**每列**都有可读原因 | 7 个 `—` 至少 5 种不同原因，且不许只写 `—` | 抹掉第 4 列的 title ⇒ 判据红 |

---

## §7 门禁与并行执行的说明

| 时点 | tests | pass | fail | 说明 |
| --- | --- | --- | --- | --- |
| 开工基线 | 1487 | 1487 | 0 | 与 Lead 给的一致 |
| 审查期间 | 1505 | 1500 | **5** | 另一位执行者正在同仓做 v0.191.0 修复（`dogwatch.ts` 已改、`dogwatch.test.ts` 追加 80 行、`marketPage` 改动），出现 5 条红：`断言强度`、`⑤ 分钟柱数`、`A4 同日并发`、`行归属`×2 |
| 其中一条是**真实冲突** | — | — | — | `dogwatch.test.ts:15-24` 的 ②（旧语义"价格没跳空 ⇒ 判折算"）与工作区已改的新语义**互斥**，实测该用例红 —— 属并行施工的中间态，不是本轮新增测试的问题 |

**因此本文件给出的"新增断言数 = 6"是在 1487 基线上计数**；最终两轮读数取决于并行执行者收尾，见回报。

---

## §8 未确认

1. **删除条数与 Lead 口径的差异**：我实测是 30 条 `test(`（不是 22+17）。若 Lead 的 22/17 指"删掉的 assert 行数"，则需另算；本文件按 `test(` 计。
2. **`marketExtrasWire` 被删的"路由接线与行归属"是否已被别处替代**：现存 `rowOwnership.test.ts` 覆盖了行归属，但两条用例的**粒度不同**（一条管 market 行的调用点，一条管全表）。并行执行者恰好在改行归属判据，此点可能已变。
3. **`elapsedMs < 50` 在 CI 负载下的实际失败率**：本机（8 并发）未复现，但余量小；需要多轮长跑才能定性。
4. **`summaryCache` 无重置钩子**是否会在未来用例中真的撞键：当前用不同日期规避，未做压力验证。
5. `dogwatchParity` 的 49 条 CSS 断言是否值得保留：它们是"设计稿对拍"的一次性验收，长期维护成本高；是否降级为快照/截图比对需产品决定（本轮不动）。

---

## §9 追加发现：删用例的**连带副作用**（审查期间实测）

`npm run build` 当前**中断**：

```
src/client/marketV1.test.ts(9,24): error TS6133: 'MINUTE_BARS' is declared but its value is never read.
src/client/marketV1.test.ts(9,66): error TS6133: 'minuteDeltaOf' is declared but its value is never read.
构建中断：类型检查未通过（tsc --noEmit，退出码 1）
```

- **提交态 v0.188 是好的**：`git show 577e34a:src/client/marketV1.test.ts` 里这两个符号被引用 5 次。
- **工作区**只剩 1 次（import 行本身）—— 并行执行者又删了 10 行用例，但**没删对应的 import** ⇒ `tsc` 报未使用 ⇒ 构建中断。
- 这是"删用例"最常见的连带事故：**删测试不改 import**。建议把 `tsc --noEmit` 前置为删用例后的必跑项（本仓库 `npm run build` 已内含，但 `npm test` 不含 —— 所以测试全绿也可能构建红）。

> 该问题**不属于 v0.185→v0.188 四个提交**，属审查期间的并行施工中间态，已同步给 Lead。

---

## §10 最重的一条：`②` 把**错误行为**固化成了契约

`dogwatch.test.ts:15-24`（v0.186 引入）断言：

```ts
// 份额 ×1.5、价格 +0.5% ⇒ 判为折算
const series = [{ day:'d1', totalWan:1000, priceGapPct:0.5 }, { day:'d2', totalWan:1500, priceGapPct:0.5 }, …]
assert.equal(actions.length, 1, '只有 d2 触发折算')
```

而 `dogwatch.ts` 的正确判据（v0.191.0 由另一位审计者修正，工作区已改）是：
**真折算 = 份额跳变 且 价格「反向」跳变**（份额↑价格↓）；价格几乎不动的大额份额变化是**真实申赎**，必须计入加仓指数。

⇒ 上面这组输入在新判据下**不该**被判折算 —— 也就是说，v0.186 的 `②` **把一个缺陷（把大额申赎误判成折算、从而抹掉真实加仓）写成了"必须成立"的契约**。修正生产代码后，这条用例立刻变红（实测 `pass 25 / fail 1`，唯一红的就是它）。

**为什么值得记一笔**：本文件 §2 说的是"注入太弱，抓不到 bug"；这一条更严重 —— **断言把 bug 锁死了**。弱注入只是漏报，错断言是**误报式拦截**：它会让正确的修复看起来像回归。`§3` 里点名的"折算检测"缺口，实质就在这里：只有同向一侧、且那一侧是错的。

> 处置建议：把它改成双向判据（份额跳 + 价格反向 ⇒ 折算；价格不动 ⇒ 申赎），并在标题里写明方向。本轮**未替作者改**（该文件正被并行编辑），已写入 §6 G1 作为补充覆盖。
