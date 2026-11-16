# 汪汪队跟踪 · 宿主层审计（v0.185.0 → v0.188.0）

> 范围：`src/host/**`（含 `routes.ts` 注册与 `dogwatch.ts` 全链），基线 1487/1487 全绿、构建 73。
> 审查人：probe-prismfeed｜2026-11-16｜只读审 + 修复 P0/P1，**不 commit、不重启**。

## 结论

**P0 ×1、P1 ×4、P2 ×4。** P0 是折算判据方向反了：旧实现「价格没跳空 ⇒ 判折算」，把真折算（份额×2、价格−50%）判成正常、把大额申赎误判成折算。已修，并用真实 510300 日频序列断言。

## P0

### P0-1 折算判据方向反了（`detectCorporateActions`）

| 项 | 内容 |
|---|---|
| 位置 | `src/host/dogwatch.ts` `detectCorporateActions` |
| 旧逻辑 | `\|ratio−1\| > 20% && (gap === null \|\| \|gap\| ≤ 5%)` ⇒ 判折算 |
| 后果 | ① 真折算（份额翻倍、复权价 −50%）因 `\|gap\| > 5%` **不被记录** ⇒ 指数把折算读成 +100% 加仓；② 大额申赎（份额 +30%、价格不动）被误判为折算 ⇒ 指数顺延，**真实加仓被抹掉**；③ `gap === null`（无价格）时任何 >20% 跳变都判折算，误杀率最高 |
| 修法 | 判据改为 **份额跳变 且 价格反向跳变**：`\|ratio−1\| > 20% && gap !== null && \|gap\| > 5% && sign(gap) !== sign(ratio−1)`；价格未知 ⇒ **不判**（无证据不猜），只在 `missing` 说明 |
| 断言 | `dogwatch.test.ts` ②（真折算顺延）、**A2**（真实 510300 序列：10.2%/12.4%/12.0% 三个跃升点**不得**判折算，末值指数 >150；真 1:2 折算判 1 笔且指数保持 100）、**A3**（888→448→189→241→456 两个基期分别 =100，末值 51.35 / 241.27，证明 1 年 67.98 与 3 月 220.30 的差异来自**基期不同**而非折算误判） |

## P1

### P1-1 `parseSseShares` 遇 `null` 行整表崩

- 复现：上游 `result` 里混入 `null`/字符串 ⇒ `r.SEC_CODE` 抛 `TypeError`，整个 `/dogwatch` 500。
- 修：`if (r === null || typeof r !== 'object') continue`。
- 断言：**A1**（`null`、`'garbage'`、空 `TOT_VOL`、`-5`、`abc`、`0`、带空白 `SEC_CODE`、重复代码；重复键行为固定为"后者覆盖"）。

### P1-2 同日并发重复拉取 + 并发写同一文件

- 现象：两个请求同时打开页面 ⇒ 同一天各拉一次（双倍上游），且两次 `writeFileSync` 竞争。
- 修：`inflightShares: Map<day, Promise>` 合并同日在飞请求，`.finally` 清理。
- 断言：**A4**（并发两次 `loadSharesOf` ⇒ 上游 `calls === 1`）。

### P1-3 死接口调用：`/breadth`、`/marketExtras` 仍被页面请求（**降级为 P2**）

- 现象：删卡后 `MarketPage` 仍 `api.breadth()` 与 `api.marketExtras(null)`；两者的原消费方（涨跌分布卡 / 附加行情格）已下线。
- 处置：**不再带 `dist=1`**（`/breadth` 只扫 1 页，不再触发 56 页扫描），两条请求各保留一次轻量调用，供 `data-limits` 排障属性与行归属；宿主路由与聚合代码保留（本轮只下线界面）。
- 残留：彻底删除需把 `/tradewatcher/breadth`、`/tradewatcher/market-extras` 从 market 行移回 core（同时改 4 处路由账镜像），风险大于收益 ⇒ 记 P2。
- 验证：`marketCardsRemoved` ④（`dist: true` 0 处 + 路由仍在）。

### P1-4 `stats` 语义未文档化

- `stats = { fromDisk, fetched, elapsedMs, cached? }`：`elapsedMs` 单位 **毫秒**；命中汇总缓存时 `fetched = 0`、`elapsedMs` 为本次调用耗时（通常 0–1 ms）；`cached` 仅命中时为 `true`。
- 修：类型注释 + 本文件记录；断言 ⑥（命中 `elapsedMs < 50`）。

### P1-5 5 分钟 TTL 与 `asOfDay` 边界

- 键 = `${window}|${dayOf(now)}`：**跨零点必然失效**，当日会重拉 1 次（新的一天本来就该拉新数据）。这是设计取舍，不是缺陷；已在此记录，避免后续误判为 bug。
- 断言 ②（同日内 5 分钟 `fetched = 0`）、③（换窗口 `fetched = 0`）。

## P2（记录，不修）

1. **多日小额折算**：折算若分多日完成（每日子 <20%），当前判据漏判。需要日频复权价序列才能可靠识别，本期不引入新数据源。
2. **90% 阈值边界**：池 = 14 时 `ratio ≥ 0.9` ⇔ 命中 ≥ 13 只（12/14 = 85.7% 判残缺）。已在 A1/poolCoverage 断言中固定。
3. **2027-01 起的交易日历**：`BUILTIN_CALENDAR_COVERED_UNTIL = 2026-12-31`，之后 `builtinCoverageNoteOf` 给出「内置表未覆盖 YYYY-MM…外部文件也缺失」提示；`monthCoveredByFile` 修复未回退（`calendar.test.ts` 动态夹具覆盖）。

## 审查点对照

| # | 审查点 | 结论 |
|---|---|---|
| 1 | `parseSseShares` 边界 / 90% 阈值 | **P1-1 已修**；阈值边界见 P2-2 |
| 2 | 折算检测 / 1 年 vs 3 月矛盾 | **P0-1 已修**；两值差异根因 = 基期不同（A3 证明） |
| 3 | 缓存并发 / `elapsedMs` / TTL | **P1-2、P1-4、P1-5** |
| 4 | 熔断 host 隔离 / 半开降级 | `fetchTextHost` 内部 `withHostBreaker(host)` **按 host 隔离**，SSE 与东财/腾讯互不串；4 并发 120 ms 为固定节拍，熔断打开时 `fetchTextHost` 直接抛 `breaker-open: query.sse.com.cn`，`loadSharesOf` 让该日返回空表 ⇒ 该日不进序列（`totalSeries` 过滤 `totalWan > 0`），不产生脏数；无额外降级分支（P2，按需再加） |
| 5 | `BUILTIN_CALENDAR_COVERED_UNTIL` / `monthCoveredByFile` | 无回归（P2-3） |
| 6 | 死接口 `/breadth` `/marketExtras` / 路由账 | 两条都**不再带 `dist=1`**、各保留一次轻量调用（P1-3 降 P2：彻底删除需改行归属 4 处镜像）；路由账 `35 = core 18` 与 `routes.ts` 实表一致（`dogwatch.test.ts` ⑧） |

## 门禁

`npm run check` ×2：**1487+ 通过 / 0 失败**、`ALL HOST CHECKS PASSED`、构建 **73 项**。
