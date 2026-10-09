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

---

## 追加（task-25）：基准为 0 污染纵轴域 ⇒ 指数卡片分时图被压成平线

**现象**（用户截图）：实时行情里的指数卡片分时图几乎是一条没有起伏的直线，纵轴刻度 `0.000/1000/2000/3000/4000`，
价格线贴着顶部，底部 0 处还有一条浅色横线。

**根因**：**"基准为 0"被当成真实值参与了纵轴域**（两个洞同一成因）——
`Sparkline`（卡片缩略图）与 `trendScale`（抽屉大图）都只判 `Number.isFinite(baseline)`，
基准为 0 时域从 0 起 ⇒ 几千点波动被压成顶部一条平线；底部那条浅线就是画在 0 上的基准虚线。
（仓库里 `RescuePanel` 与 `kline.yGrid` 早已挡过这个坑 ⇒ Sparkline 与 trendScale 是漏网的两次。）

**改法（单点判据，全部基准使用点共用）**

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| `trendView.ts` | — | 新增 `isUsableBaseline(v): v is number`（`finite && v > 0`） |
| `trendView.trendScale` | `typeof baseline === 'number' && Number.isFinite(baseline)` | `isUsableBaseline(baseline)` |
| `charts.Sparkline` | 内联 min/max 计算 + 内联虚线判据（**两处各写一遍**） | 抽出纯函数 `chartDomain(values, baseline)` ⇒ 域与虚线**共用同一判据**；不可用时域=价格域、虚线不画 |
| `kline.tsx` | `baseline !== null && !== undefined`（3 处：pct 刻度 / lastUp / 虚线） | `isUsableBaseline(props.baseline)` |
| `RescuePanel.tsx` | `base !== null && base > 0` | `isUsableBaseline(base)` |
| `MarketPage` / `QuoteDrawer` / `TopBar` / `PortfolioPage` | 直接透传 `t.prePrice`、`昨收 ${fmtPrice(t.prePrice)}`、`mini.prePrice > 0` | 一律 `isUsableBaseline(...)`；不可用时基准传 `null`、文本写 `昨收 —` |
| `host/em.ts`（上游归一） | `num(data.prePrice) ?? num(data.preClose) ?? null`（上游把"没有"给成 0 时会把 0 当昨收） | `rawPre > 0 ? rawPre : null`（缺失不许编码成 0） |

**上游侧核查结论**：`em.ts` 的 `prePrice` 只有 4 个产生点 —— 3 处写死 `null`，第 4 处（`fetchTrendSingleDay` 从东财 `trends2` 解析）
**可能拿到上游的 0**，已按约定归一为 `null`。但**跑着的宿主是旧构建**，所以客户端判据才是主修复（宿主归一只是顺带）。

**五条断言（`src/client/trendView.test.ts`，全绿）**

```
✔ 基准 0 ⇒ 域等于价格域、虚线不画（指数卡片被压成平线的那个 bug）
     baselineY=null；lo/hi 与"纯价格域 + 6% 呼吸位"逐位相等；lo > 3900（不含 0）
✔ 基准为负 / NaN / null / undefined ⇒ 一律按不可用（域=价格域，虚线不画）
     0 / -3 / NaN / null 都判不可用；12.5 判可用
✔ 基准正常（区间内 / 区间外）⇒ 域包含基准，虚线落在对应位置
     区间内 baselineY∈(0,1)；基准在上方 ⇒ hi>基准 且 baselineY<0.15；在下方 ⇒ lo<基准 且 baselineY>0.85
✔ 回归：指数在 3990 附近波动 + 基准为 0 ⇒ 域宽度接近波动幅度，不许变成 0~4000
     60 点正弦（±12）⇒ 域宽 < 60、域 ∈ (3900,4100)；（对照）把极小值当基准才会拉宽到 > 3000
✔ 大图（trendScale）与缩略图（chartDomain）对基准 0 的处理一致
```

新增断言 5 条（234 → **239**）；`npm run check` 全绿（239 × 2 时区、75 项片段）。

**需装机复核**（无浏览器，未做视觉验证）：
① "基准缺失"的指数（`lastUp` 退回"与首点比"、无虚线、域=价格域）卡片观感；
② "基准正常"标的仍画虚线、曲线有起伏；
③ 抽屉大图的 `昨收 —` 与左侧价格刻度/右侧 ±% 的对齐。

---

## 追加（task-26）：删除列头排序（保留段控）—— 两排功能重复

**用户的决定**：持仓页/自选页**保留面板头部的排序段控**（红框），**删掉列表上方那排列头排序**（蓝框）。

### 删除清单（净 −183 行 + 组件 61 行）

| 位置 | 删了什么 | 行数 |
| --- | --- | --- |
| `src/client/SortHeader.tsx` | 整个文件（列头组件：原生 button + aria-sort + ▲/▼ + 「↺ 默认顺序」） | −61 |
| `src/client/styles.ts` | `.tw-sorthead` / `.tw-sorthead-cap` / `-cell` / `-btn` / `-static` / `-reset` 及其 `@media (min-width:1080px)` 块与注释 | −27 |
| `src/client/wide.ts` | `SortEntry` 类型与 `pickSortEntry()`；顶部注释里的"两个控件互斥"历史改为"只剩宽窄判定" | −15 |
| `src/client/useWide.ts` | `useSortEntry()`（量列头可见性的那个 hook） | −29 |
| `src/client/WatchlistPage.tsx` | `SortHeader` 挂载、`useSortEntry`/`useWideLayout` 调用、列头注释；段控改**无条件常驻** | −41 |
| `src/client/PortfolioPage.tsx` | 同上 | −39 |
| `src/client/sort.ts` | `WATCH_COLUMNS` / `PORT_COLUMNS` / `NO_NAME_SORT`（列头专用数据） | −21 |
| `src/client/wide.test.ts` | P1-4 那条断言（排序入口恰有一个） | −9 |
| `src/client/sort.test.ts` | 「列头定义」整条用例 | −25 |
| `README.md` / `docs/ROADMAP.md` | 见下"文档改动" | ±5 |

**保留未动**：`WATCH_SORT_KEYS`/`PORT_SORT_KEYS`、`prefs.watchSort/portSort` 的键集与校验（段控仍能排全部键）；
`SortBar` 组件本体（只清掉了为互斥服务的注释）；`build.mjs` 片段表（**一项未删**，`自选排序`/`持仓排序`/`仓位占比` 仍由段控提供 ⇒ 构建校验通过）。

### 测试条数：239 → **237**（删 2 条）

- 删 `wide.test.ts` 的「P1-4：排序入口恰有一个 —— 宽屏列头不可见时退回段控」：列头已不存在，这条断言的前提消失；
- 删 `sort.test.ts` 的「列头定义：有数值来源的列才可排…」：`WATCH_COLUMNS`/`PORT_COLUMNS` 已随列头一起删除；
- 改写 1 条（不是删）：`styles.test.ts` 的宽屏断点下限 `>= 3` → `>= 2`（列头那处断点随功能删除；"所有 min-width 必须等于 `WIDE_MIN_PX`"这条规则本身继续跑）。
- 后端/纯函数断言一条未减（家数、五日、YTD、脚注、时段网格等全部保留）。

### 静态核对

```
$ grep -rn "SortHeader\|sorthead\|useSortEntry\|pickSortEntry" src/     → 0 命中（含注释）
$ grep -c "SortBar<" src/client/WatchlistPage.tsx src/client/PortfolioPage.tsx  → 1 / 1（各只剩一个入口）
$ npm run check → 237 条 × 2 时区全绿；75 项片段校验通过（build.mjs 未改）
```

### 文档改动（只改两处）

- `README.md` 排序那条：
  - before：`…；**宽屏（≥1080px）改用列头排序** —— 点列头按该列排序、再点翻转方向、列头显示 ▲/▼、原生按钮键盘可达并带 aria-sort，另有「↺ 默认顺序」复位；窄屏保留原分段开关；两者的互斥由 useWideLayout() 决定只挂哪一个…`
  - after：`…；**排序沿用面板头部的段控**（v0.36.0 起不再有列头排序 —— 列表上方那排列头与段控功能重复，已按用户要求删除），任何宽度下都只有这一个入口`
  - 目录树里 `client/SortHeader.tsx # 宽屏列头排序…` 一行删除。
- `docs/ROADMAP.md` 对应条目：`**列头点击排序 ✅（v0.30.0）**` → `**列头点击排序（v0.30.0 引入 → v0.36.0 删除）**`，写明删除原因与"排序沿用段控"；同一段里"断点按容器而非视口"的待做项与"渲染层从未真正执行过"的限制句同步去掉列头字样。

### 那句根因结论（一眼）

**未查明**（未为它加班）。当前源码里两排结构上不可能同时出现（两个挂载点由同一个 `entry` 值互斥），
而截图里两排同时在 ⇒ 最可能是**跑着的客户端仍是旧构建**（本仓库此前已记录"宿主进程未重启、`lib/` 新而进程旧"），
那一版是"两个都渲染、靠 CSS 藏一个"的形态；用户的选择让这个形态连同它的诊断一起消失了。

---

## 追加（task-27）：非价格量被当均价 ⇒ 所有 A股指数分时被压成平线

**现象**：A股指数分时图几乎是一条直线（纵轴 `0.000/1000/2000/3000/4000`、价格线贴顶、页脚 `昨收 —`、横轴已是时段网格）。
**根因（真机回包实测）**：那个 `avg` 字段**不是均价**（量纲完全不同），而 `isUsableAvg` 只要求"正数"：

```
1.000001 上证指数  price[3755.05,3824.07]   avg[15.15,17.05]
0.399001 深证成指  price[12279.09,12676.80] avg[15.87,16.76]
1.000300 沪深300   price[4239.97,4330.37]   avg[24.91,28.26]
```

⇒ 域从 ~15 起 ⇒ 价格线贴顶。（`昨收 —`/无右侧 ±% 说明 v0.35.1 的"基准 0"修复已生效 —— 这次漏的是**均价**那条。）
Lead 另扫了本机 LKG 全部 77 条分时序列：**17 条均价越界**、44 条正常、16 条无均价；倍数不固定（98×/248×/170×）⇒ 只能按"VWAP 必在当日价格区间内"这条**自证规则**拒绝，不能猜字段含义。

**判据与容差**：纯函数 `plausibleAvgs(values, avgs)` —— `isUsableAvg(v) && v >= lo*0.98 && v <= hi*1.02`
（`lo/hi` = 价格序列 min/max；±2% 容差是因为**采样点未必覆盖当日真实极值**）。
**逐点判**（不整条丢）：`114.LHM` 那种"前半段 0、后半段正常"的序列只丢坏点。

**共用点**（同一函数，域与线不脱节）：`trendScale` 内部、`kline.tsx` 的两处 `avgs`（时段网格档 + 压缩轴档，
域与均线折线共用同一份过滤结果）、以及 `chartDomain` 的价格域（间接）。**宿主侧同一规则**：
`normalizeTrendSeries`（`shared/model.ts`）逐点把越界均价置 `null` —— 该规则**对所有市场成立**（VWAP 必在当日区间内），不是指数特判；
宿主不能反向依赖客户端，且跑着的宿主可能是旧构建，所以两边都有（已在注释里写明这份重复的理由）。

**域的前后实测**（脚本复算，价格序列取自真机回包）

```
1.000001 上证指数: 改前 -213.4~4052.6（域宽 4266 ⇒ "0~4000 平线"） ⇒ 改后 3750.91~3828.21（域宽 77.3）
0.399001 深证成指: 改前 -743.8~13436.5（14180）                     ⇒ 改后 12255.23~12700.66（445.4）
1.000300 沪深300 : 改前 -233.4~4588.7（4822）                       ⇒ 改后 4234.55~4335.79（101.2）
114.LHM 期货     : 252 ⇒ 252（部分越界：坏点 0 早已被 isUsableAvg 挡，好点照旧保留）
1.600519 个股    : 28  ⇒ 28（44 条正常序列行为**一丝不变**）
```

**六条断言（5 条任务要求 + 1 条部分越界）**

```
✔ 回归（真机那组）：上证指数价格 ~3755–3824 + avg 恒为 ~15 ⇒ 域=价格域、均线不画
     域 = 3750.9088~3828.2112（与纯价格域逐位相等）、下界 > 3700、宽 < 100、均价全部置 null
✔ 正常市场：均价落在价格区间内 ⇒ 保留、参与域、折线可画
✔ 边界：恰在 lo*0.98 / hi*1.02 之内保留，之外拒绝（±2% 容差）
✔ 部分越界逐点过滤（114.LHM 那种形态）：正常的点照旧、坏的点置 null
✔ 反向保护：isUsableAvg 的语义不变（正数即有效），区间校验只是叠在它之上
✔ （宿主）归一：越界的"均价"逐点置 null —— chart-source.test.ts
```

新增断言 6 条（237 → **243**）；`npm run check` 全绿（243 × 2 时区、75 项片段；`build.mjs` 未改，"均价"并非片段表锁定词）。

**`em.ts` 那眼顺带看的结论（未据此改字段映射）**：指数/个股分时都走同一行解析 ——
`const parts = row.split(',')`，`avg: num(parts[7])`（`trends2` 的 `f58`），`vol: num(parts[5])`、`amount: num(parts[6])`。
也就是说**指数与个股取的是同一个字段位**，只是上游给指数填的值量纲不同（15 vs 3755）；本轮**不动映射**（那属于"按文档猜字段"），
只按数据自证的区间规则拒绝。若后续要查清 `f58` 在指数上的确切含义，需要对着上游文档或多次实测取证，属独立任务。

**需装机复核**（无浏览器，未做视觉验证）：4 条越界指数（上证/深证/沪深300/科创50）+ 半导体ETF + 港股 + 期货的图
应回到价格域；其中 44 条正常序列的均线**应完全无变化**。
