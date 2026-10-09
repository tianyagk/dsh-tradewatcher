# V2 批次实现记录（task-21）· 活文档

对象：`dsh-tradewatcher` v0.33.1 工作区。输入是三份只读审计：`AUDIT-V2-FUNCTION.md`（P0×2/P1×4/P2×8）、
`AUDIT-V2-CODE.md`（S1–S10 / M 档）、`AUDIT-COPY2.md`（用词表 + 必修 4 / 应修 10 / 保留 8）。
本文件记录**做了什么、证据是什么、哪里与审计建议不一致**。

## 第 1 段（P0）：家数链路打通

### P0-2 源 B 的"三类之和 = 总数"恒不成立（已修）
- 根因：`fetchClistPctPage` 把无涨跌幅的行（停牌 / `'-'`）过滤掉，而校验用**未扣除的 total** ⇒ 当日有 1 只停牌就恒失败。
- 修法：等式基准改为**有效行数**（`scanned`），覆盖检查用**原始行数**（`scanned + blank`）且只由分页器
  （`countBreadthFromClist`）判定；`blank`（无涨跌幅的行数）如实写进 `checks` 与 `BreadthCounts`；
  源 C 的等式的基准是 `total`（它只读边界页，`sumEquals:'total'`）。
- 测试口径一并修正：`breadthCount.test.ts` 的用例不再手工把 total 写成有效行数；
  新增"total 含 12 行无涨跌幅 ⇒ **必须通过**"的回归断言 + 分页器级覆盖断言。
- 实测：`countBreadthFromClist(3 页 × 4 行、其中 2 行无涨跌幅、total=12)`
  ⇒ `{up:3,down:5,even:2,total:12,scanned:10,blank:2,pages:3}`，`checks` 含 `扫到的原始行数 12`。

### P0-1 自统计没接到三格（已修）
- 修法：新增纯函数 `pickBreadthCounts(cells, current)`（`src/client/breadthView.ts`）——
  **指数行情优先，拿不到才用 `/tradewatcher/breadth` 的 `current`**；`MarketPage` 三格改用它，
  自统计时三格带 `title`（口径 + 数据时刻），`em-index` 时不标。
- 断言：`countsOk=true ⇒ from 'index'`（即使自统计也在）；`countsOk=false + current ⇒ from 'self'`（用户实测场景）；
  两路都没有 ⇒ 三格 `—`。

### 源 C 收口（未接线，仅文档）
- `resolveBreadthCount` 的 JSDoc 写明"C 档未接线、需要 `deps.sortedPctPage`、当前运行时没有该取数实现"，
  并指向 `deps.sortedPctPage` 的注入位；README「涨跌家数」补一行"第三条链路算法与用例已实现但未启用"。
- **没有接线、没有删用例**；算法与 6 条用例、`sanityOfCounts` 的护栏按 M2 原样保留。
- 顺带：失败原因改为**逐个列出试过的源**（`源A … 缺失；源B 东财 clist：…`），让"哪条通"可从回包直接读到。

## 第 2 段（P1）

| # | 结论 | 证据 |
| --- | --- | --- |
| P1-1 五日未按 `limitDays` 裁剪 | 已修：`stitchTrendDays` 先 `slice(-limit)` 再拼接，`missing` 从裁剪后首日算起 | 断言「传 12 天 + limit=5 ⇒ `coverage.have.length === 5`、`points` 只含最近 5 天、被裁掉的那天不出现在图上」 |
| P1-2 `expired` 无消费点 | 已修：宿主对"非当日"的序列（含上游回节前分时）回包带 `sessionDay`；客户端新增 `chartNote.nonSessionNote` 写 `· 非当日数据（MM-DD）` | 断言：上游给 10-01 的序列 ⇒ `sessionDay='2026-10-01'`；当天序列 ⇒ 不标；`cacheNoteOf` 断言输出 |
| P1-3 YTD 丢 `stale/source` | 已修：`YtdState` 增 `stale/source`（两页页面把 `asOf/stale/source` 都带上了），`ytdTooltip` 加"来源：…（本次是上次成功的结果…）"一行 | 断言：`stale:true` ⇒ tooltip 含"本次是上次成功的结果"；`source:'lkg'` ⇒ 含"来源：lkg" |
| P1-4 宽屏可能没有排序入口 | 已修：`pickSortEntry({wide, headerVisible})` + `useSortEntry()`（挂载后量一次列头的 `display`）——宽屏还要**列头真的可见**才用列头，否则退回段控；两个页面都由**同一个** `entry` 决定挂哪个 | 断言：`wide+visible ⇒ header`；`wide+hidden / wide+量不到 ⇒ bar`；`narrow ⇒ bar`。结构上"恰好一个入口" |

## 第 3 段（文案）

**用词表（先落表，再改句子）**
- 状态词：本次没取到 ⇒ **未取到**（原 `涨跌家数不可用`、`无可用行情（现价缺失）` 已改）；
  上游根本不提供 ⇒ **上游无此数据**；接口整体不可达 ⇒ `不可用`（只修饰接口）；无价标的 ⇒ `无行情源`（既有专名）。
- 时间格式：页面级"数据时刻" `HH:mm:ss`（新增 `hhmmssOf`）；跨日历史 `MM-DD HH:mm`（新增 `fmtStamp`/`fmtDate`）；
  禁用 `toLocaleString` 默认输出（`CalendarPage`/`RescuePanel`/`PortfolioPage`/`CloudMap` 5 处已换）；
  时刻前缀统一为 `数据时刻`（`统计于`/`判定于`/`观测时刻` 三种说法已消除）。
- 单位：金额 `亿/万`（`fmtAmt`）、倍率 `x`、标的计数 `只`、份额 `份/股`（E14：持仓页 `份` vs 抽屉 `股` 跨视图会对不上券商流水）。

**必修 4**
- E1：`· 上次成功数据（MM-DD HH:mm）` 单一形态；日期不可知才退到 `· 上次成功数据`；删掉
  `（本次刷新失败）` 与 `· 缓存数据（上游暂不可用）`。K 线兜底**必须带日期**（取最后一根/最后一天，
  日线档只给到天，不编时间）——这正是"把昨天当今天读"的事故源。
- E2：`· 家数由本插件自行统计（统计于 HH:mm:ss）` → `· 自统计 HH:mm:ss`，口径全文留 title/aria（读屏自包含）。
- E3：`MISSING_TIER_ADVICE` 尾句只留动作（`稍后自动重试` / `重试无用`），不再重复"不可达"。
- E4：护盘空态按**时段词**分两句：`非交易时段无采样（下次开盘自动重试）`（时段性）/ `上游本次未取到（下次采样自动重试）`（故障）。

**应修 E5–E13**：全部落地（`样本不足 n/5 天`、`快照 8/20 天`、热力图两句删一压一、云图两处、抽屉两处、
日历同步一行 + 「手动事件不受影响」进 title、列表单位 `份/股`）。
**专项**：`listing` 括号压成 `（本年内上市，基准为上市首日）`；`本次未归档` 并进 `caliberExplain`（正文不占位）。
**保留/动不得**：K1（正文一行 + aria 长句）、K2–K8、动不得 8 条逐条未动（尤其 K5：宿主 `checks` 未进界面，未删）。

## 第 4 段（结构精简）

| 项 | 结果 |
| --- | --- |
| S1 | `charts.tsx` 删 `PriceText`/`MultiDayTrend`/`CandleChart` 三个零引用组件：**432 → 257 行（−175）**；`Sparkline`/`MiniTrend`/类型与 `polylinePath` 按 M1 保留 |
| S2 | `tencent.ts` 删旧解析 `fetchTencentQuotes`：**338 → 289（−49）**；`TencentQuote` 接口保留 |
| S3 | 删 11 处零引用碎片（`normalizeLedger`/`clampMoney`/`searchBest`/`_cache`/`defaultYtdMemo`/`useForceNow`/`fmtTime`+2 断言/`CalPayload`/`VIEW_MODE_LABEL`/`IndustryInfo`/`RescuePayload`/两处转发导出）；`stats.ts` 的 `wilsonFromRate` 与 `ACTOR_TOOL` 按报告要求**保留** |
| S4 | 动词文案提到 `shared/model.ts` 的 `LEDGER_VERB_LABEL`，host/client 各引一份；新增键集一致性断言（对 `store.ts` 的 `LEDGER_VERBS`） |
| S5 | 新增 `MISSING_TIER_LABEL`，4 处三目改引用（`CalendarPage`×2、`tools.ts`×1，另一处为同形表达） |
| S7 | **按实际语义收窄**：只有 `store.ts`/`rescue.ts` 的两处与 shared 的 `numOrNull` 真等价 → 合并；`em.ts`/`tencent.ts`/`sina.ts` 的 `num` 要**解析字符串**（含 `'-'`），合并会把整片字段判成 null ⇒ 保留并各加一行说明；`bottom.ts` 的类型守卫按报告保留 |
| S8 | 机械规则 ②：删掉注释里的版本/批次标记（68 行）；规则 ④⑤：长注释块压缩，过程叙述迁 `docs/DECISIONS.md`（81 块），**含"不许/必须/红线/不变量/否则/宁可"的句子整句保留**；压缩后出现 8 处结构破损，由状态机修复脚本收尾（内容未丢，转为行注释） |
| S9 | `AUDIT-IMPL.md`/`AUDIT-IMPL2.md`/`AUDIT-VERIFY.md`/`AUDIT-COPY.md` → `docs/archive/`；README「开发」加一行索引（"口径以 README 为准"）；`AUDIT-UI/FUNCTION/V2-*/COPY2/DESIGN-DASHBOARD/COMPETITOR-NOTES` 留在原处 |
| 不做 | S6（原子写抽公共模块，6 处）、S10（测试文件归并，纯 churn）——按任务书留待后续 |
| M 档 | 一条未碰（`breadthCount` 护栏与源 C 算法、`charts.tsx` 存活部分、`ACTOR_TOOL` 与 `store.ts` 历史兼容、`breadthView` 的"任一分量缺失 ⇒ 整格 —"、`styles.ts` 单次替换语义、`RescuePanel` 本地格式化） |

**规模**：93 个文件变更，**+616 / −2657 行**（净 −2041）。抽查三次：`charts.tsx −175`、`tencent.ts −49`、`em.ts −54`（其中 em 的减少全部来自注释压缩）。

## 新增/改动的断言

```
✔ 源 B 计数：>0 上涨 / =0 平盘 / <0 下跌，等式基准是有效行数
✔ 源 B 生产口径：上游 total 含停牌/无涨跌幅的行时**必须通过**（P0-2 回归）
✔ 源 B 分页器：跨页跳过的无涨跌幅行也算扫过，覆盖不足则失败
✔ 合理性检查：三者全 0 而 total>0 / 三类之和与有效行数不等 / 覆盖不足 ⇒ 失败
✔ 家数取值（P0-1）：指数行情有就用它；没有则用自统计，绝不留在 —
✔ 拼接按 limitDays 裁剪：传 12 天 + limit=5 ⇒ 只拼最近 5 天
✔ P1-2：上游回的是过去某交易日的序列 ⇒ 回包必须带 sessionDay
✔ E1/E1-K线/P1-2/口径独立/stamp：脚注用词 6 条（chartNote.test.ts）
✔ P1-3：YTD 的降级必须能读出来
✔ P1-4：排序入口恰有一个（宽屏列头不可见时退回段控）
✔ S4：动词文案的键集必须与 LEDGER_VERBS 完全一致
```
合计新增 17 条断言（211 → 225 个 `test()`），删掉 2 条 `fmtTime` 断言（S3 允许）。

## 契约变化

- `/tradewatcher/breadth` 的 `missing[].note` 现在**逐个列出试过的源**（`源A … 缺失；源B 东财 clist：…`）。
- `TrendData` 的 `sessionDay` 现在在"**不是今天**"时也会出现（此前只在 LKG 兜底时给）。
- `YtdPayload` 的 `stale/source` 现在被客户端消费（`YtdState.stale/source` → tooltip 一行）。

## 需装机复核（无浏览器，未做视觉验证）

1. 家数三格在东财不可达时是否显示自统计数据（P0-1 的观感）—— 断言已锁选择逻辑，但"看起来对不对"要人眼。
2. 排序入口在**人为清空 `<style>` 内容**后是否仍有一个（P1-4 的量测分支）。
3. 图表脚注在 K 线兜底时的日期展示（E1）。
4. YTD 列 tooltip 的"来源/降级"一行（P1-3）。
5. `docs/DECISIONS.md` 里迁出的 81 块叙述是否还有需要回收进源码注释的判据（人工过一遍）。

---

## 追加（task-23）：提交前修掉验证员挖出的三条

### D1（P1，真缺陷）缺页检查在稀疏数组上失效
- 现象：`pages = new Array(pageCount)` 造出的是**稀疏数组**，`pages.filter((p) => p === undefined)` 会**跳过空槽**
  ⇒ `missingPages` 恒为 0、`firstError` 分支不可达（逐页诊断永久丢失）；最坏情况走进遍历空槽的路径抛
  `TypeError: page is not iterable`，被 `/breadth` 路由 catch ⇒ 整条链路失败（不产生错数）。
- 最终实现（关键几行）：
```ts
// ⚠ 必须显式填 undefined：new Array(n) 是稀疏数组，空槽会被 filter/some/for...of 跳过（D1）
const pages: Array<Array<number | null> | undefined> = Array.from({ length: pageCount }, () => undefined)
pages[0] = first.rows
...
// 下标循环：即使真有空槽也能数出来
let missingPages = 0
for (let i = 0; i < pageCount; i += 1) if (pages[i] === undefined) missingPages += 1
if (missingPages > 0) {
  const detail = `共 ${pageCount} 页，其中 ${missingPages} 页没取到`
  checks.push(detail + (firstError !== null ? `：${firstError}` : ''))
  return {
    counts: null,
    reason: firstError !== null ? `${firstError}；${detail}（分页不完整，按失败处理）` : `${detail}（分页不完整，按失败处理）`,
    checks,
  }
}
```
  覆盖检查那条也把 `firstError` 并进原因；`countFromClistPages` 对 `undefined` 页免疫（跳过，缺页由分页器判定）。
  **注**：`Array.prototype.some` 同样会跳过空槽，所以"改成 `some`"并不能修这个 bug —— 必须显式填 `undefined` 或下标循环。
- 三种失败情形的实测（`countBreadthFromClist(pageSize 4 / concurrency 2)`）：

```
【第 3 页抛错】   counts=null
  reason: 第 3 页取数失败：Error: boom-3；共 3 页，其中 1 页没取到（分页不完整，按失败处理）
  checks: 共 3 页，其中 1 页没取到：第 3 页取数失败：Error: boom-3
【第 3 页返回空】 counts=null
  reason: 第 3 页为空（上游限流或分页被截断）；共 3 页，其中 1 页没取到（分页不完整，按失败处理）
  checks: 共 3 页，其中 1 页没取到：第 3 页为空（上游限流或分页被截断）
【每页少给行】   counts=null
  reason: 只扫到 6 行 < 总数 12 行，分页可能被截断（按失败处理）
  checks: 扫到的原始行数 6 < 上游总数 12
```
  三例都失败、原因里都有逐页诊断、**没有 TypeError/iterable**；新增断言 1 条覆盖这三例 + 记录"稀疏数组 `filter` 跳过空槽"这一坑本身。

### D4（P3）抽屉里还剩一句旧降级说法 + 可能同屏两条
- before（`QuoteDrawer.tsx`）：`… 滚轮或拖动滑块缩放日期区间${k.stale === true ? ' · 缓存数据（上游暂不可用）' : ''}`
- after：`… 滚轮或拖动滑块缩放日期区间`（**该分支删除**）；同时让统一脚注覆盖宿主自标降级的 K 线 ——
  `chartNote.cacheNoteOf` 新增 `kind === 'kline' && kline.stale === true ⇒ lastSuccessNote(payload)`，
  于是只由 `cacheNoteOf` 输出一句 `· 上次成功数据（MM-DD HH:mm）`，同屏不会再出现两条降级说明。
- 断言：`cacheNoteOf({kind:'kline', kline:{stale:true, days:[{date:'2026-10-08'}]}})` ⇒ ` · 上次成功数据（10-08）`，且不含"上游暂不可用"。

### D5（P3）用词残留
- before（`quoteState.ts`）：`观测时刻在刷新间隔内，视为实时`
- after：`数据时刻在刷新间隔内，视为实时`（同段上一行已是"数据时刻"，前缀统一）

**本批新增断言 2 条**（D1 一条 + D4 一条）；测试总数 **225 → 227**；`npm run check` 全绿（227 × 2 时区、75 项片段）。
