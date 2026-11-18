# 棱镜重做 · 宿主数据契约（第 1 轮：盘点，不改代码）

> 最终范围：棱镜页**完全按 `AGENT DESK` 重构**，旧内容全部不保留（只留「棱镜」名称）；所有数值接**真实数据**，缺数据 `—` + 一句原因（R1）。
> 本文只覆盖设计稿六区块需要的字段；旧字段一律标「**页面不再展示**」（后端保留，不建议删除）。
> 不改 `src/**`、不 commit。基线回包：`GET /tradewatcher/prism`（单路由）+ `/tradewatcher/prism/selftest`；路由账 `35 = core 18`。

---

## 0. 结论摘要

| 项 | 数 |
|---|---|
| 设计稿需要的字段（六区块合计） | **48** |
| 已有（回包直接可用） | **31** |
| 需新增（宿主补算/补字段） | **16** |
| 无源（本仓无数据，只能 `—` + 原因） | **1**（token 用量） |
| **需新增路由** | **否**（决策流由现有 `orders/fills/runs` 派生；只加纯函数） |
| 与 R12 冲突 | **0 条** |

---

## 1. 六区块字段盘点

### 1.1 资产上限（8）

| # | 字段 | 含义 | 来源 | 实时 | TTL | 状态 |
|---|---|---|---|---|---|---|
| 1 | `account.capital` | 资金上限 | 本地 `prism-account.json` / settings | 是 | 无 | 已有 |
| 2 | `usedMarketValue` | 已用（Σ持仓市值） | 计算（行情×持仓） | 是 | 请求即算 | **需新增** |
| 3 | `available` | 可用 = 上限 − 已用 | 计算 | 是 | — | **需新增** |
| 4 | `usedPct` | 使用率 | 计算 | 是 | — | **需新增** |
| 5 | `status` | 正常/接近上限/超限/风控触发 | `exposure.rows[].status` + `runs[].drawdown.triggered` | 是 | — | 已有 |
| 6 | `decision.limits.singlePct` | 单票上限 | 模型决策 + 设置 | 每轮 | 当日 | 已有 |
| 7 | `decision.limits.totalPct` | 总仓上限 | 同上 | 每轮 | 当日 | 已有 |
| 8 | `settings.industryLimits` | 行业上限 | 本地 settings | 是 | 无 | 已有 |

> 口径：`used = Σ(qty × price)`；`available = capital − used`；缺 `singlePct/totalPct` ⇒ `—` + 「本轮未给上限」（R1），**不夹紧**（P-08 规则）。

### 1.2 持仓明细（10）

| # | 字段 | 含义 | 来源 | 实时 | TTL | 状态 |
|---|---|---|---|---|---|---|
| 9 | `positions[].secid` | 代码 | 本地 | 是 | 无 | 已有 |
| 10 | `positions[].name` | 名称 | 本地 | 是 | 无 | 已有 |
| 11 | `positions[].qty` | 数量 | 本地 | 是 | 无 | 已有 |
| 12 | `positions[].available` | 可卖（T+1） | 本地 | 是 | 无 | 已有 |
| 13 | `positions[].cost` | 摊薄成本价 | 本地（含费） | 是 | 无 | 已有 |
| 14 | `positions[].netCost` | 摊薄净成本 | 本地 | 是 | 无 | 已有（缺失回退 `cost`） |
| 15 | `trading.prices[secid]` | 现价 | 东财 push2 → 腾讯兜底 | 是 | 行情缓存（秒级） | 已有 |
| 16 | `marketValue` | 市值 = qty × price | 计算 | — | — | **需新增** |
| 17 | `unrealized` | 浮盈 = (price − netCost) × qty | 计算 | — | — | **需新增** |
| 18 | `weightPct` | 占比 = marketValue ÷ totalAssets | 计算 | — | — | **需新增** |

### 1.3 个股详情（6）

| # | 字段 | 含义 | 来源 | 实时 | TTL | 状态 |
|---|---|---|---|---|---|---|
| 19 | `code` | 代码 | 本地 | 是 | 无 | 已有 |
| 20 | `name` | 名称 | 本地 | 是 | 无 | 已有 |
| 21 | `cost` | 成本 | 本地 | 是 | 无 | 已有 |
| 22 | `price` | 现价 | 行情 | 是 | 秒级 | 已有 |
| 23 | `prevClose` | 昨收（当日盈亏基数） | 腾讯 f[4]（`quoteLite` 未透出） | 是 | — | **需新增** |
| 24 | `dayPnl` | 当日盈亏 = (price − prevClose) × qty | 计算 | — | — | **需新增** |

> 详情抽屉可复用 `/tradewatcher/detail`（已有，含 PE/PB/量比等）；本页只展示持仓上下文六项。

### 1.4 决策流（9）—— 本轮重点

| # | 字段 | 含义 | 来源 | 实时 | TTL | 状态 |
|---|---|---|---|---|---|---|
| 25 | `time` | 时间 | `orders[].decidedAt` / `fills[].at` / `runs[].at` | 是 | 无 | 已有 |
| 26 | `action` | 买/卖/持有/拒绝/撤单/成交 | `orders[].side` + `status` + `decision.rejects` + `runs` 空单 | 是 | — | **需新增**（派生枚举） |
| 27 | `reason` | 理由 | `orders[].reason` / `decision.note` / `rejects[].reason` | 是 | — | 已有 |
| 28 | `targetPrice` | 目标价 | `orders[].price`（成交取 `fills[].price`） | 是 | — | 已有 |
| 29 | `status` | 已成交/挂单/已撤/被拒/跳过 | `orders[].status` + `skipCode/skipReason` | 是 | — | 已有 |
| 30 | `source` | 人工 / 自动 | **需新增** `orders[].origin`（落库时写 `auto`；无 run 归属 ⇒ `manual`） | 是 | — | **需新增** |
| 31 | `qty` | 数量 | `orders[].shares` | 是 | — | 已有 |
| 32 | `filledQty` | 已成交数量 | `orders[].filledShares` | 是 | — | 已有 |
| 33 | `fee` | 费用 | `fills[].fee` | 是 | — | 已有 |

**能否用 `prism/orders` + `prism/fills` + `prism/runs` 拼出六字段？**

| 设计稿列 | 现有源 | 结论 |
|---|---|---|
| 时间 | `orders.decidedAt`、`fills.at`、`runs.at` | ✅ 可拼（统一北京时间 ISO） |
| 动作 | `orders.side`、`orders.status`、`decision.rejects[]`、`runs`（无委托 ⇒ 持有） | ✅ 可派生（需 1 个纯函数把 5 种来源归一为枚举） |
| 理由 | `orders.reason`、`decision.note`、`rejects[].reason` | ✅ 可拼 |
| 目标价 | `orders.price`，成交取 `fills.price` | ✅ 可拼 |
| 状态 | `orders.status`、`skipCode/skipReason` | ✅ 可拼 |
| 来源 | **无字段** | ❌ **缺**：`orders` 未记录人工/自动；建议落库时写 `origin` |

**结论**：六列中 **5 列可拼、1 列（来源）缺字段**。建议新增**纯函数** `prismDecisionFlowOf(state, orders, fills, runs)` + 落库补 `orders[].origin`；**不需要新增路由**（数据已在 `/tradewatcher/prism` 回包里）。

### 1.5 账户总览（7）

| # | 字段 | 含义 | 来源 | 实时 | TTL | 状态 |
|---|---|---|---|---|---|---|
| 34 | `totalAssets` | 总资产 = cash + ΣmarketValue | 计算 | 是 | — | **需新增** |
| 35 | `cash` | 现金 | 本地 `account.cash` | 是 | 无 | 已有 |
| 36 | `positionPct` | 仓位 = ΣmarketValue ÷ totalAssets | 计算 | — | — | **需新增** |
| 37 | `available` | 可用资金 | 计算（同 1.1#3） | — | — | **需新增** |
| 38 | `realized` | 累计已实现盈亏 | 本地 | 是 | 无 | 已有 |
| 39 | `dayPnl` | 当日盈亏合计 | 计算（Σ 个股 dayPnl） | — | — | **需新增** |
| 40 | `asOf` | 数据时刻 | 回包 `asOf` | 是 | — | 已有 |

### 1.6 Agent 绩效（8）

| # | 字段 | 含义 | 来源 | 实时 | TTL | 状态 |
|---|---|---|---|---|---|---|
| 41 | `returnPct` | 累计收益率 | `equity[]` 首末点（**仅内部计算，不画曲线**） | 日频 | 收盘后 | **需新增**（派生） |
| 42 | `benchmarkPct` | 基准（沪深300） | `equity[].benchmarkClose` | 日频 | 收盘后 | 已有 |
| 43 | `excessPct` | 超额 = 收益 − 基准 | 计算 | 日频 | — | **需新增**（派生） |
| 44 | `maxDrawdown` | 最大回撤 | `evaluation.drawdown` | 日频 | — | 已有 |
| 45 | `hitRate` | 胜率 | `evaluation.hitRate`（不足 ⇒ `—` + `n=<k>`，R8） | 日频 | — | 已有 |
| 46 | `runsCount` | 决策轮数 | `runs[].length` | 是 | 无 | 已有 |
| 47 | `latencyMs` | 单轮耗时 | `runs[].startedAt/finishedAt` | 是 | 无 | 已有 |
| 48 | `tokenUsage` | token 调用统计 | **无源**（LLM 适配层未回传 usage） | — | — | **无源** |

---

## 2. 页面不再展示（后端保留，**不建议删除**）

| 字段 | 内容 | 处置 |
|---|---|---|
| `equity[]` | 净值曲线（day/equity/benchmarkClose/cash/positionsValue/unrealized/warnings…） | **页面不再展示**；仅供 §1.6 内部计算 |
| `evaluation.*` | 评估卡（excess/drawdown/hitRate/n/curve/footnote） | **页面不再展示**；§1.6 取 `drawdown`/`hitRate` 两个标量 |
| `state.model` / `modelCatalog` | 模型与可用模型目录 | **页面不再展示** |
| `state.settings`（times/lastFired/participationRate） | 时点与参数 | **页面不再展示**（`capital`/`industryLimits` 仍用） |
| `exposure.rows[]` | 行业暴露明细表 | **页面不再展示**（`status`/`classifiedPct` 仍用于 §1.1 状态） |
| 构成条（`exposure.classifiedPct` 等比例条） | 分类覆盖条 | **页面不再展示** |
| `state.skeleton` / `state.news` / `runs[].analyses/reports` | 骨架、新闻、研判全文 | **页面不再展示** |
| `AGENT DESK · 权责模型说明` 五节 | 说明性内容 | **删除**（不进新页面） |

---

## 3. 缺口清单（宿主函数与路由）

| # | 缺口 | 建议实现 | 新路由？ |
|---|---|---|---|
| G1 | `prevClose` | `quoteLiteOf` 增透腾讯 f[4] | 否 |
| G2 | 持仓派生（市值/浮盈/占比） | 纯函数 `prismPositionViewOf(account, prices)` | 否 |
| G3 | 上限使用度 | 纯函数 `prismLimitUsageOf(account, prices, limits)` | 否 |
| G4 | 决策流时间轴 | 纯函数 `prismDecisionFlowOf(state, orders, fills, runs)` | 否 |
| G5 | `orders[].origin` | 落库时写 `origin: 'auto'`；人工单 `manual` | 否 |
| G6 | 绩效汇总 | 纯函数 `prismPerformanceOf(equity, evaluation, runs)` | 否 |
| G7 | token 用量 | 无源 ⇒ `—` + 「宿主未回传 usage」 | 否 |

**路由账**：本轮**不新增路由** ⇒ `35 = core 18` **不变**，无需同步。

---

## 4. 红线核对：R12 vs 权责模型

R12：引擎不得自行发起交易 —— 只「提示 + 拒新买单」，允许撤未成交单，**不得自动卖出**。

| # | 设计稿表述 | 冲突？ | 说明 |
|---|---|---|---|
| 1 | Agent 拥有决策与下单 | 否 | 模型给委托 → 引擎确定性裁剪 → 落库；上限由人类设定 |
| 2 | Agent 可卖出 | 否（有边界） | 卖出仅来自模型显式委托；回撤闸门不自动卖，只提示 + 拒新买单 |
| 3 | 人类拥有资金与上限 | 否 | `capital` 仅人工可改 |
| 4 | 人类可接管/停止 | 否 | 时点由 `settings.times` 控制 |
| 5 | 「自动执行」措辞 | 需改文案 | 建议「按人类设定的上限执行模型委托」 |

**冲突 0 条。**

---

## 5. 验收（实现轮）

1. 页面只调 `/tradewatcher/prism`（+ 详情 `/tradewatcher/detail`），不新增路由；
2. 六区块字段全部来自真实回包；缺数据 `—` + 一句原因；
3. 决策流六列齐全；无记录 ⇒ `—（本日无决策）`；
4. 净值/评估/模型/时点/行业暴露/构成条**页面零出现**，后端字段保留；
5. 权责五节源码零命中；
6. 反例注入：缺字段渲染 `—`（不是 0）、演示数据常量出现即判失败。
