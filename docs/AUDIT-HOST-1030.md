# AUDIT-HOST-1030：宿主层代码审查（v0.182.0 基线）

审查日期：2026-10-30 · 范围 `src/host/**`（路由 / 熔断 / 缓存 / 单位 / 缺失 / 并发 / 时间）
基线：`2c78bbf v0.182.0`（门禁 1446）

## 结论

| 级别 | 条数 | 处理 |
|---|---|---|
| P0 | **0** | — |
| P1 | **5** | 本轮已修，逐条配断言（`src/host/hostAudit.test.ts`） |
| P2 | 6 | 仅登记，不改 |

未发现「无熔断保护的裸请求」：`src/host` 的裸 `fetch(` 全部落在 `fetchFromHost`/`hostFetch.ts` 白名单内（H1 测试持续把关）。

## P1（已修）

### H-01 腾讯详情解析只认沪深北，美股兜底恒为空
- **路径**：`src/host/detailTencent.ts:43`
- **问题**：正则 `v_((?:sh|sz|bj)\d{6})` 不匹配 `v_usAAPL="…"` ⇒ `parseTencentDetail` 返回 `null`。
- **影响**：东财不可达时，美股详情**永远**走不到兜底（页面「详情暂不可用」），而 A股正常 —— 故障只在美股显现，最容易被漏测。
- **修复**：正则补 `us[A-Za-z.]+`；`code` 取 `slice(2)`（`usAAPL → AAPL`）。

### H-02 腾讯 `[37]` 对美股是**美元**，被一律当「万元」
- **路径**：`src/host/detailTencent.ts:57`
- **问题**：`amount = [37] × 1e4`；但 `tencent.ts:parseTencentQuoteText` 明确 `isUs ? 1 : 1e4`。
- **影响**：美股详情头成交额**放大 10000 倍**（AAPL 2 亿美元 → 2 万亿元）。
- **修复**：按 secid 前缀 `105/106/107` 判美股，`×1`；A股/ETF 仍 `×1e4`。

### H-03 成交量量纲判不出时 `vol:null`，但 `missing[]` 里没有条目
- **路径**：`src/host/detailTencent.ts:100`
- **问题**：`volUnitOf` 判定失败 ⇒ `vol:null`，但缺失清单只列量比/涨跌家数/今开。
- **影响**：界面只显示 `—`，用户与排障者都看不到原因（违反「缺失必须给原因」）。
- **修复**：补 `{what:'成交量', why:'no-source', note:'…量纲判不出…'}`。

### H-04 补今日动态柱后突破 `lmt`
- **路径**：`src/host/em.ts:3383`（helper `withLiveBar` 在 `2637`）
- **问题**：`days` 先按 `lmt` 切片，再 `push` 今日柱 ⇒ 返回 `lmt+1` 根。
- **影响**：`/kline?lmt=5` 回 6 根；调用方按数组长度切窗口（滑块/区间统计）会错位一根。
- **修复**：`withLiveBar(days, live, lmt)` 统一截断，测试断言 `lmt=5` 必回 5 根且末根为今日。

### H-05 护盘超大单兜底在循环里逐个 `await`（6 只串行）
- **路径**：`src/host/rescue.ts:2238-2260`
- **问题**：`for (const meta of metas) { … await fetchSinaSuperNet(…) }` ⇒ 6 次往返串行。
- **影响**：东财 f66 缺失时每拍多 ~1.2s，5 分钟采样被拖慢；极端情况下与下一拍重叠。
- **修复**：遍历前 `Promise.all` 并发预取到 `Map`（60s 缓存 ⇒ 重复调用零请求），循环只读 Map。

## P2（仅登记，未改）

| # | 路径 | 问题 | 影响 |
|---|---|---|---|
| P2-01 | `src/host/etfFlow.ts:33` | 新浪净额缓存 `Map` 无上限 | 当前仅 10 只标的，风险低；若支持自定义 ETF 池需加 LRU |
| P2-02 | `src/host/em.ts:2585` | `klineTtlOf` 盘中 5 分钟对**全量 800 根**同样生效 | 盘中每 5 分钟重拉 800 根，流量偏大；可改「增量 5 分钟 / 全量 30 分钟」 |
| P2-03 | `src/host/em.ts:2637` | `withLiveBar` 只服务 A股 | 美股盘中同样缺当日柱（需另判美东时段） |
| P2-04 | `src/host/routes.ts:1161` | `/kline` 允许 `lmt` 到 1000，但 `KLINE_CAP[101]=800` | 请求 1000 实际最多 800 根，属静默截断 |
| P2-05 | `src/host/detailTencent.ts:110` | `fetchTencentDetail` 无 TTL 缓存 | 每次打开抽屉都打一次 `qt.gtimg.cn`（可复用行情槽） |
| P2-06 | `src/host/volUnit.ts:32` | `volUnitOf` 判不出时只回 `ok:false`，无原因文本 | 调用方只能给「量纲不一致」这句通用话术 |

## 断言（`src/host/hostAudit.test.ts`，均含反例注入）

| 断言 | 覆盖 |
|---|---|
| A1 美股 `[37]` 按美元、A股按万元（×1e4 用在美股 ⇒ 必败） | H-01/H-02 |
| A2 量纲判不出 ⇒ `vol:null` 且 `missing` 含「成交量」（缺条目 ⇒ 必败） | H-03 |
| A3 `lmt=5` 补今日柱后仍 5 根、末根今日（push ⇒ 6 根 ⇒ 必败） | H-04 |
| A4 预取在循环前且 `Promise.all`（循环内 `await` ⇒ 必败） | H-05 |

## 未覆盖项（诚实声明）
- 路由层 34 条的**逐条**参数校验未全部人工复核：本轮只针对 `/kline`、`/detail` 两条改动路径做了回归，其余依赖既有 `SECID_RE`/`HttpError` 断言与门禁。
- 熔断半开探测与退避上限沿用既有实现（`breaker.ts`），本轮未改；`breakerSummary` 快照见门禁输出。
- 时区：`dayOf`/`shanghaiParts` 全量走 `time.ts`，未发现 `new Date(ts + 8h)` 新增用法（`beijingIsoOf` 是唯一既有用法）。
