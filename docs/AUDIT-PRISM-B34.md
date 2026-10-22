# 棱镜批次 3+4 —— 模拟盘引擎、完整页面、运行时自检

> 用户口径已定，本批不改。基线 1110 条；`build.mjs` 未动；不 commit、不重启。

## 0. 一行结论

模拟盘账户（150 万、入金可改、按真实成本复制并可重复复制留痕）、挂单（当日有效/可撤销/跨日失效）、1 分钟 `high/low` 按挂单价撮合、三项费用（佣金万 2.5 最低 5 元 + 卖出印花税千 1 + 过户费万 0.1）、A股四类拒绝（T+1/涨跌停/停牌/整手，均带原因）、三本账（锁 + 读守卫 + 坏文件隔离）、每日净值、页面四格/三表/折线、`/tradewatcher/prism/selftest`（永远 200）全部落地；门禁 **1132 × 2**、构建 **73 项**（发布前补丁：买入现金 / 卖出可卖硬校验）。

## 1. 批次 3 逐条

| # | 口径 | 实现 |
| --- | --- | --- |
| 1 | 初始 150 万；入金可改；仓位上限由 agent 决定 | `PRISM_INITIAL_CAPITAL=1_500_000`；POST `capital` 改 `capitalLimit` 并同步现金；汇总 JSON 的 `limits.singlePct/totalPct/note` 写进 `PrismRun.decision`（不硬限制） |
| 2 | 按真实成本价复制，可随时重复制，留痕 | `copyAtCost` 用 `avgCost`（不是现价）；`cash = 上限 − Σ(qty×cost)`；`copyLogs` 记录时间 + 前后差异（保留 20 条） |
| 3 | 挂单当日有效；后续研判可撤销并留痕 | `PrismOrder.day`；`matchTick` 跨日 → `cancelled` + `当日未成交，次日失效`；`placeDecision.cancel` → `cancelled` + `后续研判撤销` + `cancelledAt` |
| 4 | 1 分钟 high/low 触及按挂单价成交；缺数据退回分时并标注 | `fetchOneMinuteBars`（新浪 scale=1 → 腾讯 m1 → 既有分时）；`matchOrder` 买看 `low ≤ price`、卖看 `high ≥ price`，成交价恒为挂单价；`fill.source` 记 `1min`/`trend`；30s 节拍由 `PrismScheduler.match` 驱动 |
| 5 | 佣金万 2.5（最低 5）/ 卖出印花税千 1 / 过户费万 0.1；不计滑点 | `feesOf` 三项逐笔、金额分位；无滑点项 |
| 6 | T+1、涨跌停、停牌、100 股整手；违反标不可成交 + 原因 | `rejectReasonOf` 四类原因；挂单落库即 `rejected`（不静默）；卖出按 `available`（当日买入不加） |
| 7 | 三账本 + 锁 + 读守卫 + 坏文件隔离 | `prism-account.json` / `prism-orders.json`（orders+fills）/ `prism-equity.json`；全部 `updateJsonLocked` + `ReadGuard`；`quarantineFile` 先隔离（测试验证 `.corrupt` 文件生成） |

## 2. 批次 4 逐条

- 顶部四格：总资产 / 现金 / 当日盈亏（需 `dayStartEquity`，缺则 `—` + 原因）/ 累计盈亏（总资产 − 资金上限）。
- 持仓表：代码、名称、数量、成本、现价、市值、浮盈；数字 `font-variant-numeric: tabular-nums` + `--tw-mono`。
- 挂单表：方向、价格、数量、状态（待成交/已成交/已撤销/不可成交 + 原因）、撤单按钮。
- 成交记录：时间、价格、数量、费用、来源（1 分钟/分时）。
- 净值曲线：`sparklineOf` 纯 SVG polyline，无坐标文字；不足两点 → `—` + 原因。
- 研判区：四份分报告 `<details>` 可展开、汇总、`limits`/挂单/撤单清单、token 用量 `—（未取到）`。
- 无声明性文案；缺数据 `—` + 一句原因；时点/资金/参数常驻可见。

## 2.1 发布前补丁：成交前资金/可卖硬校验

- `fillRejectReasonOf(account, order, price)`：买入 `成交金额 + 费用 ≤ 现金`，否则 `现金不足（需 X，可用 Y）`；卖出 `available（已扣当日买入）≥ 委托数量`，否则 T+1 原因。
- `matchTick` 在 high/low 触及后、`applyFill` 之前调用；拒绝 ⇒ `rejected` + 原因，现金/持仓不变、不写成交。
- `applyFill` 再加兜底：买入不足直接抛错（任何绕过路径都不能把现金打成负数）。
- 实测：现金 1,000 买 100@20（需 2,005.02）⇒ `rejected`，现金仍 1,000；现金 1,000 买 100@9.9（需 995.01）⇒ 成交，现金 4.99；持仓 100 卖 200 ⇒ `rejected`，持仓仍 100。

## 2.2 活宿主五处落账修复（2026-10-22 17:1x）

| 问题 | 修复 |
| --- | --- |
| `state.account` 为空 | GET `/tradewatcher/prism` 与 `run` 前调用 `ensureAccount`：`copiedAt=null` 时按真实 `avgCost` 复制；现金不足**部分复制**（逐行 `take=min(qty,floor(剩余/cost))`）并在 `copyLogs.note/skipped` 留痕；`cash=150万−已复制成本`。`state` 顶层同时返回 `account/orders/fills/equity/decision/prices`（旧消费者读 `state.account`） |
| `run.day/at` null | `PrismRun` 增 `day`（北京日期）与 `at`（`beijingIsoOf`，ISO+08:00）；旧 runs 读盘时归一化补齐 |
| `run.reports` [] | `reports:[{role,text,error}]` 四份逐份写入 `prism-runs.json` 并随 run 回包；旧 runs 从 `analyses` 归一化 |
| `decision.orders/cancels` 0 | 活宿主实际汇总的 JSON **解析成功**（`limits.singlePct=20`，`orders=[]`、`cancel=[]` 是模型真实选择，不是解析失败）。新增 `decision.parseError`：无 JSON 块/JSON 非法/orders 字段非法被丢弃 ⇒ 带原文或丢弃计数，**不再静默成 0 笔**；提示词要求严格 JSON（无注释/尾逗号） |
| `equity` 0 点 | GET、每次研判、复制持仓后都 `recordEquity`：总资产=现金+持仓市值（缺价按成本），`upsertEquity` 同日覆盖、每日一点 |
| 盘后下单 | `placeDecision` 在 `<09:30` 或 `≥15:00` 时把每笔决策单置 `rejected`，原因 `盘后不下单（HH:MM，A股 15:00 收盘）`，并写入 `decision.rejects`（`run` 后 `replaceRun` 落盘） |

**活宿主 pre-fix 真实读数**（`~/.dsh/dsh-tradewatcher/prism-runs.json` 最后一轮 `14:40`）：`limits.singlePct=20`、`totalPct=null`、`orders=[]`、`cancel=[]`、`reports` 缺、`day/at` 缺；账户 `cash=1,500,000`、`positions=[]`、`copiedAt=null`；`orders=[]`、`equity=[]`。修复后首次 GET 即应得到 `copiedAt` 非空、成本持仓、`equity` 1 点；盘后手动补跑会得到 4 份 `reports` + `rejects`。

## 2.3 用户三条改动 + 页头自检（2026-10-22 20:1x）

| 改动 | 实现 |
| --- | --- |
| 摊薄成本 | `copyRowsOf` 取主插件 `PositionRow.dilutedCost`（回退 `avgCost` 仅当摊薄为 null）；`PrismPosition` 增 `netCost`；买入 `netCost += amount + fee`、卖出 `netCost -= amount − fee`，`cost = netCost/qty`；浮盈/页面仍用 `cost`（现价−摊薄）×数量。样例：买 100@10 → 卖 50@12 ⇒ `netCost=400`、`cost=8.00`（移动加权会留 10.00） |
| 仓位占比 | 持仓表在「市值」后、「浮盈」前新增列：`市值 ÷ 总资产 ×100`（总资产=现金+持仓市值），2 位小数 `%`；`positionWeightPct` 可测；总资产 0/缺价 ⇒ `—` |
| 模型配置 | `PrismSettings.model{provider,model}` 落 `prism-settings.json`；页面顶部 provider/model 两个自由输入 + 宿主 `listProviders/listModels` 的 datalist 候选；`resolvePrismModel(get, selected)` 配置优先，研判与自检都传 `settings.model`；保存时未知 provider ⇒ 400 明确报错、不写入（不静默回退） |
| 页头自检 | `selftestText`：`ok:true ⇒ 自检通过 · {elapsedMs}ms · {text}`；`ok:false ⇒ 自检失败 · {error}`；不再把 HTTP 200 当失败、不再显示 0ms |

## 3. 撮合与费用实测样例（一买一卖完整链路）

样例（脚本直跑引擎，1 分钟 bar 为构造值）：

| 步骤 | 数值 |
| --- | --- |
| 初始 | 现金 1,500,000.00 |
| 买 100 股 @10（bar low 9.9） | 成交价 **10**；amount 1,000；佣金 **5.00**（最低）；过户费 **0.01**；费用合计 **5.01**；现金 **1,498,994.99**；成本 **10.05** |
| 次日卖 100 股 @10.8（bar high 10.9） | 成交价 **10.8**；amount 1,080；佣金 **5.00**；印花税 **1.08**；过户费 **0.01**；费用合计 **6.09**；现金 **1,500,068.90**；已实现 **68.91** |
| 净值 | 10-22 **1,500,044.99**；10-23 **1,500,068.90**（每日一点） |

## 4. 断言 + 反例注入

| # | 判据 | 用例 |
| --- | --- | --- |
| ① | 初始 150 万、入金可改 | `prismAccount.test.ts` ①；改 `capitalLimit` 现金同步 |
| ② | 复制按成本价（现价会失败） | ② 成本 1200（现价不影响） |
| ③ | 当日有效/撤销留痕/跨日失效 | ③ 两用例（`cancelledAt` + reason） |
| ④ | 1 分钟 high/low、按挂单价成交 | ④ 买 low 9.9 → 10；卖 high 10.1 → 10；不触及不成交 |
| ⑤ | 三项费用逐笔 + 最低 5 元 | ⑤ 买 5.01 / 卖 6.01；大额佣金 25 |
| ⑥ | 四类拒绝各有原因、不静默 | ⑥ 整手/T+1/涨停/停牌 |
| ⑦ | 三账本锁 + 读守卫 + 隔离 | ⑦ 源码三关键词 + 坏 JSON → `.corrupt` |
| ⑧ | 净值每日一点、同日覆盖 | ⑧ `upsertEquity` |
| ⑨ | 自检永远 200、失败带 error 原文 | `prismPage4.test.ts` ⑨ 源码判据 + `prismSelftest.test.ts` 真 handler（抛错仍 200） |
| ⑩ | 四格 + 三表 + 曲线齐全 | ⑩ 页面源码；注入删「总资产」⇒ 判据可区分 |

## 5. 运行时自检

`GET /tradewatcher/prism/selftest`：真实调用一次 `ctx.llm.stream`（`只回复 OK`，20s 超时），返回 `{ok, error, model, elapsedMs}`；**任何异常都 `send(res, 200, …)`**，`error` 用 `String(e)` 原文。路由已注册到 `prism` 行（账目 32）。

**未实跑活宿主**：本机不重启宿主无法装载新行；handler 已用假 llm 跑通两条（成功 `ok=true`；`stream` 抛 `boom-原文` 仍返回 200 且 error 带原文）。重启后可直接 `curl http://127.0.0.1:3080/tradewatcher/prism/selftest`。

## 6. 门禁

- 基线 1096 → 1110 → 1132 → 本批 **1139**（1134 + 5：首次初始化/部分复制/盘后 rejects 3 + day/at/reports 1 + parseError 1）。
- `DSH_HOME=/tmp/prismb34-check{AM,AN} npm run check`：两轮 **1132 × 2 全绿**（AM 18,976/18,745ms；AN 20,030/18,778ms）；selftest 全过；构建 **73 项**（v0.130.0，`build.mjs` 未改）。

## 7. 未做 / 已知边界

- 自检路由与真实 `ctx.llm.stream` 未在活宿主内执行（需重启）。
- 1 分钟源未做真机联网实测（本批测试全部注入 bar；新浪/腾讯接口路径沿用既有源）。
- 撮合只在交易日由 30s 节拍触发；非交易日不撮合。
- 买入现金硬校验已补（本补丁）；卖出可卖数量同路径复检。
- 涨跌停用「前一收盘价 × 板块幅度」近似；ST 用名称前缀判断。
- token 用量字段上游未提供，页面显示 `—（未取到）`。
