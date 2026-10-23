# 自动 run 落单 / 账本丢失保护 / 重建

## 一行结论

自动时点路径现在和手动路径共用 `runPrismForSlot` 的落单逻辑，每个 run 写 `placement`；账户读取兼容三种历史格式，写空账户有 `accountWriteGuard`；`orders.json` 的已成交单可重建 fills（现金仅参考）。

## Bug 1 根因

- `runPrismForSlot` 只调用 `runPrismAnalysis` 写 `prism-runs.json`；**只有** POST `action:'run'` 手动路径在路由里调用 `placeDecision`。调度器 `PrismScheduler` 直接持有 `runPrismForSlot` ⇒ 自动时点的 4/1/2/1 笔从未进入 `trading.orders`。
- 修复：把 `quoteLiteOf` + `placeDecision` + `store.replaceRun` 移入 `runPrismForSlot`；手动路由不再重复 place。每个 run 都有：
  `placement:{placed,skipped,rejects:[{secid,reason}],skippedReasons?}`
- `placeDecision` 的重复单不再静默 `continue`：计入 `skipped` 并写 `skippedReasons`；被引擎拒绝的写 `rejects`。`placed` = 本轮新 pending 数。

## Bug 2 根因

1. `PrismTradingStore.init()` 把 `{v:1, account}` 整包交给 `normalizeAccount`，未解包 ⇒ 重启后 capital/cash/positions 回落；已修复并兼容：
   - 裸 account；
   - `{v:1, account}`；
   - `{v:1, account, fills}` / `{v:1, ...account, fills}`；
   - fills 优先 `prism-orders.json`，其次账户内嵌 fills。
2. `ensureAccount` 曾在 GET/run/capital 自动 `copyAtCost` 写现金；已移除，只有显式 `action:'copy'` 才复制。
3. `saveAccount` 增加 `accountWriteGuard`：旧账户有 positions/fills 时，新账户 `positions=0` 且当前 fills=0，且非 `explicitReset` ⇒ 抛错 + console.warn，拒绝写盘。显式 copy 允许 reset。

## 残留 A：orders/fills 接口为 0

- **根因**：`PrismTradingStore` 只在 `init()` 读一次 `prism-orders.json`；活进程启动时文件是旧的/空的，之后文件写入不会重新读；另外账户内嵌 orders/fills 被清空时容易误走内嵌。
- **修复**：`reloadOrders()` 统一解析；GET 每次 `await deps.trading.reloadOrders()`；`prism-orders.json` 的 orders/fills 优先，账户内嵌仅作兜底。
- 断言：磁盘 2 笔胜过内嵌 1 笔；外部写第 3 笔后 `reloadOrders()` 可见；GET 源码含 reload。注入只读内嵌 ⇒ 败。

## 残留 B：account.capital 与 settings.capital

- **根因**：账户只有历史字段 `capitalLimit`，没有对外 `capital`；页面/接口读 settings.capital 与 account.capital 时两个来源。
- **修复**：`PrismAccount.capital` 作为 `settings.capital` 同值别名；`normalizeAccount` 从 `capital`/`capitalLimit` 双向兼容；GET 用 `settings.capital` 构造 `accountView`，不写盘；capital 保存同时写两者。
- 断言：GET 后 `settings.capital === trading.account.capital`；注入留 null ⇒ 败。

## 盘后边界口径

- `placeDecision` 的 `afterHours = hhmm >= '15:00' || hhmm < '09:30'`，输入是 `now`。
- 修复前 `runPrismForSlot` 传 `Date.now()`（分析结束后的墙钟），14:59:09 触发、分析跨过 15:00 就被判盘后。
- 现改为传 **run.startedAt（研判触发时刻）**：14:59:09 可下单，15:00:00 才判盘后。不是收盘价时刻，也不是实际调用 placeDecision 的墙钟。

## 今天的数据能否恢复

实测 `~/.dsh/dsh-tradewatcher`：

- `prism-orders.json`：`orders=4`、`fills=4`；4 笔均为 `status:'filled'`（10:12 的 4 笔卖出）。
- `rebuildFromOrders` 重建：`fills=4`；fills 明细：
  `1.588170 sell 50000@0.698`、`1.560010 sell 20000@2.657`、`1.688035 sell 500@52.33`、`1.518880 sell 1000@8.187`。
- **判断：10:12 的 4 笔成交可以恢复 fills**（订单文件有成交价/费/时间）；现金只能给出参考值 `1,722,234.82`，不能精确复原（缺历史入金/买入流水），以当前账户/流水为准。
- 11:15 / 13:10 / 14:35 的 1/2/1 笔：`runs.decision.orders` 有决策，但从未落单、无成交价/成交时刻 ⇒ **不能伪造为已成交**；只能在新代码下重跑并按时点重新挂单，不能补成历史成交。
- 现金自洽：4 笔卖出净额 `34900+53140+26165+8187 − 157.18 = 122,234.82`；`1,600,000 + 122,234.82 = 1,722,234.82`。相对订正前账户现金 `100,000.16` 的差额 `1,622,234.66` 来自历史买入/其他流水，不硬凑。
- 回包/UI 不含「重建 / recovered / rebuilt」；`note` 只写“据 orders.json 的 N 笔已成交单推断…”，`fills[].source` 仍为 `1min`；只有本文档保留留痕。
- 当前活宿主 `GET` 若仍显示 0，是未重启装载新 host 代码；本任务不重启。

## 断言/注入

`src/host/prismLedgerRecovery.test.ts` 4 条：

1. 三种历史账户格式（裸 / wrapper / wrapper+fills）读取后 positions 与 fills 非空；注入读空 ⇒ 败。
2. `accountWriteGuard`：旧有数据时写空账户 ⇒ reject，磁盘保留旧持仓；`explicitReset` 才允许。
3. `rebuildFromOrders`：2 笔买入 ⇒ fills=2、cash=699.9、note 含「重建」；重建为空 ⇒ 败。
4. 自动 `runPrismForSlot` 路径：run.placement 存在、`trading.orders` 增加、`store.runs` 带 placement；只写 runs ⇒ 败。

`src/host/prismLedger.test.ts` 同步改为显式 copy；`prismCash.test.ts` 覆盖 GET 不写账户与 capital 持久化。

## 门禁

- 本批新增 3 条（orders 唯一源、无标记、14:59 边界；B 断言并入既有 cash 测试）；当前全量 **1230**（仓库并行任务另计）。
- `DSH_HOME=/tmp/prismledger2-check{1,2} npm run check`：两轮 1230/1230 全绿。
- 构建 73 项（v0.146.0）；`build.mjs` 未动；不 commit、不重启。
