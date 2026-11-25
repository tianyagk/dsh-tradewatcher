# 棱镜账务与风控核心审计（AUDIT-PRISM-ACCOUNTING）

- 审计对象：`dsh-tradewatcher` v0.224.1，基线 `HEAD = a3c9972`（`v0.224.1：修闸门基线每次重启丢失`）
- 审计范围：`src/host/prismAccount.ts`、`prismDeskWrite.ts`、`prismEval.ts`、`prismRoutes.ts` 中账户/风控相关部分
- 审计方式：只读代码 + 在 `/tmp/prism-audit/` 用 `node --experimental-strip-types` 直接 import 生产函数复现；**未改任何 `src`、未 commit、未重启**
- 结论：三账本「一次写 + fail-closed」的骨架是扎实的，但**成本口径可以为负、复制/手工调整/现金编辑三条账外注资通道、净值点的日期与数值守卫**存在 P0/P1 缺陷——一笔盈利卖出就能让浮盈虚增一倍，盘前一次 GET 就能改写上一交易日收盘净值。

**统计：P0 3 条 / P1 13 条 / P2 17 条，合计 33 条。**

> 证据行号以 `git show HEAD:`（a3c9972）为准。审计期间工作树被另一进程修改（见 §0.2），当前文件行号已相对 HEAD 漂移；本文所有引用均按 HEAD 标注。

---

## 0. 基线与方法

### 0.1 基线确认

- 审计开始时 `git status`：`位于分支 main，您的分支与上游分支 'origin/main' 一致。无文件要提交，干净的工作区`
- `git log -1`：`a3c9972 v0.224.1：修闸门基线每次重启丢失`
- `package.json`：`"version": "0.224.1"`
- 未运行完整 `npm run check`（用户已给基线 2003/2003、build 73）；仅运行了 `prismLedgerP0.test.ts` 验证三账本回滚测试（4/4 通过）。

### 0.2 工作树漂移（必须知道）

审计进行到一半（11:36–11:38）时，**另一个进程**修改了工作树：

| 文件 | 变更 |
|---|---|
| `src/host/prismAccount.ts` | `parseDecisionDetailed` 的 `side` 改为白名单（非法方向丢弃），+6/−2 行 |
| `src/host/prismRoutes.ts` | `runPrismForSlot` 末尾把 `run.decision.limits.singlePct` 归一成配置值，+4 行 |
| `src/host/prismParseSide.test.ts` | 新增未跟踪测试 |
| `docs/AUDIT-PRISM-PROMPT.md`、`docs/AUDIT-PRISM-UI-STORE.md` | 新增未跟踪文档（非本次产物） |

因此：

1. 本文所有行号/片段来自 **HEAD a3c9972**，不是当前工作树。
2. 本文 **F4 的 `side` 部分在工作树里已有未提交修复**；其余问题在工作树中仍然存在（`singlePct` 归一只是展示层，不修 §F4 的 0–100 校验；也不修本文其他任何一条）。
3. 本次审计只新增了本文档，没有触碰上述文件。

### 0.3 复现方法

复现脚本在 `/tmp/prism-audit/repro1.ts` … `repro10.ts`，全部直接 import 仓库的生产函数（不是手写模型），运行方式：

```bash
cd /tmp/prism-audit && node --experimental-strip-types repro6.ts
```

关键输出已抄在 §1.1、§2.1、§3.1 的「复现记录」里。

---

## 1. 资金/成本恒等式

**本节结论**：`cash` 只由 `applyFill` 直接加减，仓库里没有任何「cash 与 fills 对账」的校验或断言；A4/A5/A3 三条账外通道都能让两者永久脱钩，A1 是 realized/netCost/avgCost/cost 四者口径打架的主因。

| # | 严重度 | 问题 | 证据（文件:行 + 片段） | 触发条件 | 后果 | 建议修法 |
|---|---|---|---|---|---|---|
| A1 | **P0** | 盈利卖出把 `netCost` 冲成负数后，`unrealized` 把已实现利润再加一遍；`realized + unrealized ≠ equity − capital`，随后 `rebase` 用这个 `unrealized` 反解会把 `realized` 冲掉 | `prismAccount.ts:279-284`：`p.netCost = money(net - (fill.amount - fill.fee))`、`p.cost = money(netCost / qty)`；`:437`：`unrealized = Σ(qty×price − (p.netCost ?? qty×cost))` | 卖出金额（减费）大于该标的剩余净成本且仍有剩余股数，例如 1000 股 @10 买入、900 股 @30 卖出 | 实测：qty=100、`cost=−169.58`、`netCost=−16,957.70`、`realized=17,958.70`、`unrealized=19,957.70`；真实总盈亏 19,962.60，账面合计 37,916.40（约 2 倍）。UI 持仓浮盈按 `(price−cost)×qty` 显示 +19,958（真实 +1,999）。再点「校平账本」：`realized` 被写成 4.90，原 17,958.70 消失 | 卖出按 `netCost` 精确结转（`realized += 卖出净额 − netCost×卖出比例`）；**净成本不得为负**：超出部分全部进 realized，剩余 netCost 归 0；`unrealized` 用 `max(netCost,0)`；加不变量测试 `cash + netCost == capital + realized` |
| A2 | **P0** | 「按成本复制」在真实持仓为空时，用空数组全量替换模拟盘持仓，并把现金重置为 `capitalLimit`；`saveAccount` 的空账户守卫不覆盖 `saveAll` | `prismAccount.ts:301`：`const positions: PrismPosition[] = []`；`:326-329`：`cash: remaining, positions`；`prismRoutes.ts:926-939`：无 `rows.length` 校验、无 `confirm`；`prismAccount.ts:886-890`：`accountWriteGuard` 只存在于 `saveAccount` | 真实组合为空 / `copyRowsOf` 读取失败返回 `[]` 时 POST `{action:'copy'}`（当前 client 无按钮、`api.prismCopy` 无调用方，但路由公开可达） | 复现：原持仓 100 股茅台（netCost 120 万）→ `positions=0`、`cash=1,500,000`、`realized` 保留；`prism-orders.json` 里的历史 fills 还在 → 账实永久不一致；`log.note=undefined`，无 skipped、无确认提示 | `rows.length===0` 时拒绝（除非 `confirm:true`）；把空账户守卫下沉到 `saveAll`；复制前把 `before` 写入 `prism-ledger.jsonl` |
| A3 | **P1** | `copyAtCost` 只改 `cash`/`positions`，不清 `realized`；复制后「已实现盈亏」沿用上一本账 | `prismAccount.ts:326-332`：`{ ...account, cash: remaining, positions, copiedAt, copyLogs }`，没有 `realized` | 账户已有 `realized ≠ 0` 后再次复制（含历史交易后首次复制） | 复现：`realized=12,345.67`、`cash=1.38M`、持仓成本 120k → `equity=1.5M`、`equity−capital=0`，但已实现仍显示 +12,345.67；此后每次复制继续保留，直到 rebase 被动改掉。`prismCopy.test.ts` ⑤ 只断言 qty/cash，没断言 realized | 复制即新账本：`realized=0`；或把差额记入 `capital` 并在 `copyLog` 里写 before/after realized；补测试断言 |
| A4 | **P1** | 持仓手工调整只改 `positions`，不动 `cash`/`realized`——资产凭空增减；`add` 还漏写 `netCost`/`avgCost`，`name` 用 secid；`remove` 直接丢弃 netCost | `prismDeskWrite.ts:66`：`positions.push({ secid, name: secid, qty: shares, available: shares, cost })`（无 netCost/avgCost）；`:74`：`{ qty: shares, available: shares, cost, netCost: round2(shares*cost), avgCost: cost }`；`:80`：`positions.splice(idx, 1)` | 手工 `add`，或把 qty 从 100 调到 1000（@1500） | 复现：`add` 100 股 @1500 → equity 1,650,000（+150,000），realized 0、unrealized 0；`update` 到 1000 股 → equity 3,000,000（+1,500,000）。总资产、单票占比、回撤基准全部以此为准；`remove` 掉的净成本无声消失；界面名称显示代码 | 手工调整必须成对记账：`cash` 减 `Δqty×cost` 或 `realized` 吸收差额，另设 `externalFlow` 字段；`add` 补齐 `netCost/avgCost` 与真实 `name`；`remove` 时把剩余 netCost 冲入 realized（或拒绝删除仍有净成本的持仓） |
| A5 | **P1** | `action cash` 直接设余额：不写 `prism-ledger.jsonl`、不动 `realized`/`capital`、不重置 `dayStartEquity` | `prismRoutes.ts:841-851`：`const value = { ...account, cash: Math.round(cash*100)/100 }` + `saveAll` | 任意 POST `{action:'cash', cash:2000000}` | 净值凭空 +500k，累计回撤消失（或反向假回撤）；已实现盈亏与现金永久不自洽；与 position 不同，**完全没有 ledger 留痕** | 记一条 `manual-cash` ledger；差额进 `realized` 或 `externalFlow`；同步 `dayStartEquity`/`gateBaseAt` 并在响应里提示影响 |
| A6 | **P1** | 「按成本复制」保留全部旧 `orders`/`fills`，同日 `pending` 单会在新账本上继续撮合 | `prismRoutes.ts:939`：`orders: deps.trading.orders()`（原样传）；`prismAccount.ts:1707-1711`：只有 `order.day !== day` 才取消 | 有未成交挂单时 POST `{action:'copy'}`（同上：当前 client 无按钮，路由可达） | 旧买单用新现金成交、旧卖单卖掉新持仓；成交价/数量与复制意图无关，`fills` 混着两本账，`feesByDay`/评估全部被污染 | 复制时把当日 `pending` 全部 `cancelled`（`cancelReason='复制重置'`），或要求 `confirm:true` 并提示；给账本加 `bookId` 代际，fills 带代际 |
| A7 | **P2** | `realizedFromIdentity` 任一输入非有限就返回 0，`rebase` 会把 realized 写成 0 而不是拒绝 | `prismAccount.ts:343-346`：`if (![...].every(Number.isFinite)) return 0`；`prismRoutes.ts:892-896` | 校平时持仓缺价且 `p.cost` 为 null/NaN，或权益计算遇 NaN | 已实现盈亏被静默清零；rebase 只返回 before/after，没有 ledger 记录 | 非有限值返回 `null`，rebase 拒绝写入并报缺价；不要用 0 冒充「算出来是 0」 |

### 1.1 复现记录（A1/A3/A4）

```
# A1：买 1000@10，卖 900@30
buy:  cost 10.01 netCost undefined cash 1489994.9
sell: qty 100 cost -169.58 netCost -16957.7 realized 17958.7 cash 1516962.6
point: equity 1519962.6 capital 1500000 realized 17958.7 unrealized 19957.7
identity: realized+unrealized = 37916.40   equity-capital = 19962.60
rebase would set realized = 4.90

# A3：copy 保留 realized
B copy: realized= 12345.67 cash= 1380000 equity= 1500000

# A4：手工 update
F2 update qty 100->1000: cash= 1500000 equity= 3000000 equity-capital= 1500000 realized= 0
```

---

## 2. 净值点与回撤基准

**本节结论**：净值点同时承担「展示」和「风控基准」两种职责，但没有日期、数值、完整性守卫——B1/B2 都会让回撤闸门读到假数据（分别是「昨日被改写」和「0/NaN/缺价被当成市值」）。

| # | 严重度 | 问题 | 证据（文件:行 + 片段） | 触发条件 | 后果 | 建议修法 |
|---|---|---|---|---|---|---|
| B1 | **P1** | `equityPointOf` 用 `account.day` 作为净值点日期；`recordEquity`（GET/run/copy）不先 `rollDay`，盘前/休市 GET 会把当天价格写进**上一交易日**的点，覆盖其收盘净值 | `prismAccount.ts:426`：`const day = account.day \|\| dayOf(now)`；`prismRoutes.ts:398-417`：无 rollDay、无 `point.day === dayOf(now)` 校验；`:609`：GET 每次都调 `recordEquity` | 交易日 09:30 前打开页面（`account.day` 仍是昨日），或周末/停牌日 GET；行情为 null 或与昨收不同 | 复现：昨日点 1,120,000 → 盘前 null 报价写回同一天 1,100,000（−20,000 浮盈被抹掉）；若当日跳空低开，缺口被并进昨日，`drawdownGateOf` 的当日跌幅看不到缺口，显示「正常」 | 点日期一律用 `dayOf(now)`；`recordEquity` 先 `rollDay` 或拒绝写 `account.day !== today` 的点；给点加 `source/complete` 标记 |
| B2 | **P1** | `equityPointOf` 对价格只做 `?? p.cost`：0 价按 0 计市值、NaN 原样进 `money()`、缺价按成本计且不标注；`matchTick` 末尾 `quotes(...).catch(()=>({}))` 会把整仓打成缺价 | `prismAccount.ts:424-425,437`：`p.qty * (priceOf(p.secid) ?? p.cost)`；`:1825-1828`：`const quoteMap = await deps.quotes(...).catch(() => ({}))` | 上游返回 `price:0`（停牌/脏数据）、`NaN`，或收盘前最后一次取数失败 | 0 价 → 市值 0：复现 equity 1.5M→500k（假 −66%，触发熔断）；NaN → JSON 落盘 `null`，次日 gate 得 `dailyPct=-100, cumulative=-100`（永久「已拒新买单」）；内存态 NaN 则 `round(NaN)` 比较恒 false → 闸门显示「正常」但实际失效 | `price > 0 && Number.isFinite(price)` 才采用，否则走缺价分支并记 `missing[]`；点写入前校验 `equity` 有限；缺价点不参与回撤基准（保留上一有效点） |
| B3 | **P1** | `rebase` 把 `gateBaseAt` 设为当前时刻，`drawdownGateOf` 只统计 `at > baseAt` 的点；当日已有点全部被排除，`n<2` 时返回 `triggered:false, status:'正常'` | `prismRoutes.ts:898`：`patchSettings({ gateBaseAt: Date.now() })`；`prismEval.ts:134-141`：`if (valid.length < 2) return { ..., status: '正常', reason: '...不足 2 个' }` | 点「校平账本」（任何时间） | 校平后至少到次日才有 2 个点；这段时间回撤闸门完全不设防，界面仍显示「正常」而不是「未启用」 | 不移动 `gateBaseAt`（把校平点作为新基线首点写入 equity），或把 status 改为「未启用/样本不足」；`n<2` 时 clamp 按保守阈值处理 |
| B4 | **P2** | `targetTotalPct`/`cashMinPct` 只出现在 gate 返回值里，全仓库无消费者；熔断只拒新买单、不降仓。另 `maxDDPct` 在 clamp 用 settings（缺省 null→不熔断），在 gate 用 `?? 3`（缺省 3%） | `prismEval.ts:168-169`；`prismRoutes.ts:524-526,559-563`；`prismAccount.ts:1487-1491` | 熔断触发；或 `settings.maxDDPct` 未配置 | UI 显示「目标总仓 40%/现金下限 25%」但引擎不执行；同一账户两套阈值，裁剪层与闸门层可能给出相反结论 | 要么把 target 接进 clamp 的 `maxPos`/`minCash` 作为上限，要么从返回值和 UI 删除；阈值统一从 settings 读一次 |

### 2.1 复现记录（B1/B2）

```
# B1：昨日点被盘前 GET 覆盖
G yesterday point day= 2026-11-24 equity= 1120000
G pre-open point  day= 2026-11-24 equity= 1100000 => same day key? true
G series after upsert: [ '2026-11-24:1100000' ] lost unrealized= 20000

# B2：0 价 / NaN
zero price point: {"day":"2026-11-25","equity":500000,...}
NaN price point:  {"equity":null,...}  → gate: {"dailyPct":-100,"cumulativePct":-100,"triggered":true,"status":"已拒新买单"}
NaN in-memory → gate: {"dailyPct":null,"triggered":false,"status":"正常","n":2}
```

---

## 3. T+1 与可用数量

**本节结论**：`qty`/`available` 不会变负（§7 第 1 条），拒单/撤单也没有预占要回滚；真正的漏洞是部分成交产生卖不掉的零股（C2），以及 `rebase` 一键把全仓 T+1 解锁（C1）。

| # | 严重度 | 问题 | 证据（文件:行 + 片段） | 触发条件 | 后果 | 建议修法 |
|---|---|---|---|---|---|---|
| C1 | **P1** | `rebase` 把全仓 `available` 设为 `qty`，当日买入的股票立即可卖 | `prismRoutes.ts:895`：`positionsFixed = account.positions.map((p) => ({ ...p, available: p.qty }))` | 当日买入后点「校平账本」 | T+1 失效，可同日做 T+0 往返；费用/风控模型都被绕过；无二次确认、无 ledger 留痕 | 只解锁 `manual-adjust` 涉及的标的（按 delta 计算），或保持 `available` 不动；确需解锁要求 `confirm:true` 并留痕 |
| C2 | **P2** | 撮合 `take = min(remaining, barCap)` 不取整手；部分成交可留下非整手持仓，而卖单强制 100 股整手、clamp 又把 available 向下取整到手 | `prismAccount.ts:1769`：`const take = Math.min(remaining, barCap)`；`:153`：`order.shares % 100 !== 0 → '非100股整手'`；`:1405`：`Math.floor((pos.available ?? pos.qty) / 100) * 100` | 1000 股买单在成交量 7890 股的 bar 成交 789 股，余量当日未成交、次日被取消 | 复现：持仓 789 → 卖 700 → 剩 89 股；89 股永远卖不掉（卖 100 被 T+1/可用拒绝，卖 0 被整手拒绝），资金永久锁死 | 买入 `take` 向下取整到 100（最后一笔可例外）；或允许零股一次性卖出（A 股规则允许）；clamp 对 `qty % 100 !== 0` 给专门提示 |
| C3 | **P2** | 部分成交后若后续被拒，`order.status='rejected'` 但 `filledShares>0`、fills 有记录；`order.fee` 只在**完全成交**分支累加 | `prismAccount.ts:1778-1782`（rejected 分支）；`:1810-1814`：`order.fee = (order.fee ?? 0) + fee` 只在 `filledShares >= shares` 内 | 买单先部分成交，随后现金不足/涨跌停变化导致拒绝；或多笔 partial 后成交 | 复现：789+211 两笔成交，fills 费用合计 5.10，`order.fee=0.02`；`rebuildFromOrders` 与订单详情按 0.02 计费；`rejected` 订单实际有持仓，状态与流水矛盾 | 每笔 fill 都累加 `order.fee`；新增 `partial-rejected` 状态（或 `status='filled'` + `rejectedReason`）；`rebuildFromOrders` 以 fills 为准 |
| C4 | **P2** | clamp 对缺 `available` 的老账本回落 `pos.qty`（全部可卖），撮合 `fillRejectReasonOf` 回落 0（全部不可卖） | `prismAccount.ts:1405`：`(pos.available ?? pos.qty)`；`:224`：`const available = position?.available ?? 0` | 旧账本/手工 JSON 缺 `available` 字段，且 `account.day` 已是当天（`rollDay` 不触发） | 同一持仓先被裁成「可卖」，下单后被判「T+1 不可卖」，反复拒单 | 统一 `available ?? qty`；或在 `normalizeAccount` 里补齐 `available=qty` |

### 3.1 复现记录（C2/C3）

```
# C2：部分成交 → 零股
partial tick: qty 789 available 0
next day:    qty 789 available 789, order cancelled
sell 700:    qty 89 available 89   ← 89 股无法再卖出

# C3：order.fee 只记最后一笔
after partial1: order.fee undefined, fills [5.08]
after partial2: order.fee 0.02, fills [5.08, 0.02] sum=5.10
```

---

## 4. 并发与原子性

**本节结论**：单进程内 `matchTick`/`placeDecision` 的读-改-写被 `runExclusive` 串行化了；漏网的是 `recordEquity` 与 settings 写入（D2/D3），跨进程时 `saveAll` 的整份覆盖会丢成交（D1），而「回滚」只在抛异常时成立（D5）。

| # | 严重度 | 问题 | 证据（文件:行 + 片段） | 触发条件 | 后果 | 建议修法 |
|---|---|---|---|---|---|---|
| D1 | **P0** | `saveAll` 在锁内只做「校验 + 写」，不做磁盘合并；`next.orders/fills` 是调用方内存快照，**整份覆盖**。`saveOrders` 有 `mergeOrders/mergeFills`，`saveAll` 没有 | `prismAccount.ts:955-997`：entries 直接用 `next.orders`；对比 `:907-929`：saveOrders 锁内 `mergeOrders(diskOrders, orders)` / `mergeFills(diskFills, fills)` | 同一 `dataHome` 上两个进程（3080 web + TUI / 第二个实例）交替写 | 复现：A 先写 `[A1]`，B reload 后 A 再写 `[A1,A2]`，B 用自己的快照写 `[A1,B1]` → 最终 `[A1,B1]`，**A2 永久丢失**；若丢失的是成交记录，现金/持仓/流水三方永久不一致（A 下次 reload 也会丢掉） | `saveAll` 锁内读盘并按 `id` / `(orderId,secid,at,price,side,shares)` 合并（复用 mergeOrders/mergeFills）；或所有写路径改走 `updateJsonLocked`；账本加 `generation/instance` 字段 |
| D2 | **P1** | `recordEquity` 不在 `runExclusive` 内，用函数入口的 `account`/`before` 快照计算点，最后 `saveEquity` 按日覆盖 | `prismRoutes.ts:398-417`；`prismAccount.ts:610-614`：`mergeEquity` 同日 `next` 覆盖 | GET 与 matchTick 并发（页面 30s 轮询 + 调度器 30s 撮合） | 成交后 matchTick 写入新 cash/equity 点，GET 随后用旧 cash 覆盖同一天点 → 当日净值少算成交，回撤闸门/评估读到旧值；下一次 GET 才自愈 | `recordEquity` 包进 `store.runExclusive`，锁内重新 `reloadForWrite` 后计算；同日点按 `at` 比较，只允许更新的点覆盖 |
| D3 | **P2** | 写路径漏网：`recordEquity→saveEquity`、`store.saveCapital`、`store.patchSettings`、`appendPrismLedger` 都在临界区外；`runPrismForSlot` 的 clamp 读 account/equity/orders 也在锁外 | `prismRoutes.ts:518-563`（锁外读）、`:684`（ledger 锁外）、`:898`（patch 锁外）、`:922`/`:942`（saveCapital 锁外）、`:943`（recordEquity 锁外） | 并发 GET/撮合/落单/手工调整 | 账户文件与 settings 的 capital 短暂不一致；ledger 少记一次调整；clamp 用旧现金/持仓裁剪，落单后再被 T+1/现金拒绝 | 见 §4.1 矩阵：capital 与 account 双写合并为一次事务；ledger append 移入 runExclusive；clamp 输入在 placeDecision 锁内重算或用版本号校验 |
| D4 | **P2** | `runExclusive` 只是 Promise 链尾，不可重入、无超时 | `prismAccount.ts:711-715`：`const run = this.exclusiveTail.then(() => fn())` | 在临界区内再调用 `store.runExclusive`（未来在 position 里调 recordEquity 或 matchTick） | 永久挂起（等自己），HTTP 请求不返回，调度器整拍卡死 | 用 AsyncLocalStorage 标记当前临界区（同 `lock.ts` 的 `heldByContext`），嵌套时直接执行；或加 30s 超时 |
| D5 | **P2** | `writeFileSetAtomic` 只在抛异常时按写前字节回滚；逐个 `rename` 提交期间进程被 SIGKILL/断电，没有 journal/generation，三账本可能不同代 | `atomic.ts:96-124`；`prismAccount.ts:992-994` | 提交三文件中途被杀（容器重启、OOM） | account 新、orders/equity 旧（或反之）；三份都是合法 JSON，`repairLedger`/`quarantine` 检测不到；期间净值/持仓错位 | 每份账本写 `generation`（单调递增）与 `txId`；启动时比较三份 generation，不一致从 `.bak`/上一代恢复；或写 commit marker |
| D6 | **P2** | `cancel` 路由拿 `orders()`（`slice()` 浅拷贝）后直接改 `order.status`，改的是 store 内存里的同一对象 | `prismRoutes.ts:973-979`；`prismAccount.ts:797`：`orders() { return this.ordersValue.slice() }` | `saveAll` 失败（锁超时/写盘错误） | 内存显示已撤、磁盘仍 pending；后续 GET 显示已撤，重启后「复活」；另一次 saveAll 成功会把未预期的撤单落盘 | `orders.map(o => ({...o}))` 后再改（`placeDecision`/`matchTick` 已这么做） |
| D7 | **P2** | `prismTrading.init()` 在 `store.init()` 之后异步执行且 `.catch(log)` 吞错；路由已注册，GET 的 `recordEquity` 可用默认账户（1.5M、空仓）写净值点 | `index.ts:276`；`prismAccount.ts:645-655`（初始默认账户）；`prismRoutes.ts:609` | 插件启动后、init 完成前打开页面/自动 GET；或 init 抛错（mkdir 失败） | 写入/覆盖当日净值点为 1.5M；若 init 永久失败，所有写路径基于默认账户（`assertWritable` 不拦，因为 degraded 为空） | 路由 handler 首行 `await ready`；init 失败置 degraded；`account()` 在未装载时返回 degraded 语义 |
| D8 | **P2** | `repairLedger` 宣称从 `*.bak` 恢复，但棱镜账本写入路径**从不生成 `.bak`**（`store.ts` 只在导入 watch/positions/ledger/prefs 时复制 `.bak`）；`prismLedgerP0.test` 里的备份是测试手工 `writeFile` 造的 | `prismAccount.ts:1070-1121`（`newestBackupOf`/`repairLedger`）；`store.ts:741`（只备份四个组合文件） | 任一棱镜账本被写坏（磁盘满、进程被杀、手工编辑） | 没有可用备份，`repairLedger` 返回「没有可用备份」；fail-closed 会把账户永久锁死，只能人工从外部备份恢复 | `saveAll` 写前把当前三份复制成 `<file>.bak`（或每日/每 N 次滚动备份），并在 repair 结果里记录来源；测试用真实备份路径 |

### 4.1 写路径 × 锁覆盖矩阵

> 图例：`✓` = 在 `runExclusive` 内；`✗` = 锁外；`—` = 不适用。`saveAll` 列表示是否一次提交三账本。

| 写路径（入口） | runExclusive | 三账本一次写 | 备注 |
|---|---|---|---|
| `matchTick` → `matchTickLocked` → `saveAll` | ✓ | ✓ | 锁内 `reloadForWrite` 后撮合 |
| `placeDecision` → `placeDecisionLocked` → `saveAll` | ✓ | ✓ | 但 clamp 输入在锁外（§D3） |
| `action position` → `applyPositionOp` → `saveAll` | ✓ | ✓ | `appendPrismLedger` 在锁外（`:684`） |
| `action feeCorrection` → `applyFeeCorrection` → `saveAll` | ✓ | ✓ | fills/order.fee 不同步（E5） |
| `action priceCorrection` → `applyPriceCorrection` → `saveAll` | ✓ | ✓ | — |
| `action cash` → `saveAll` | ✓ | ✓ | 无 ledger（A5） |
| `action rebase` → `saveAll` + `patchSettings` | ✓ / ✗ | ✓ | settings 在锁外（`:898`） |
| `action capital` → `saveAll` + `store.saveCapital` | ✓ / ✗ | ✓ | settings 在锁外（`:922`） |
| `action copy` → `copyAtCost` → `saveAll` + `saveCapital` + `recordEquity` | ✓ / ✗ / ✗ | ✓ | 两个后续写在锁外（`:942-943`） |
| `action backfillAvgCost` → `saveAll` | ✓ | ✓ | — |
| `action cancel` → `saveAll` | ✓ | ✓ | 共享内存对象（D6） |
| `recordEquity`（GET / run / copy）→ `saveEquity` | ✗ | ✗（只写 equity） | 竞态覆盖（D2） |
| `repairLedger` → `writeFileAtomic` | ✓ | ✗（单文件） | 修复路径本身可接受 |
| `appendPrismLedger`（position） | ✗ | ✗（append） | 锁外、无 fsync |
| `saveAccount` / `saveOrders` / `saveEquity` 公开方法 | ✗ | ✗ | 测试/兼容用；生产应只走 saveAll |

**结论**：单进程内 `matchTick`/`placeDecision` 的「读-改-写」被 `runExclusive` 串起来了，但**净值写入（recordEquity）和 settings 写入没有**；跨进程时连 account/orders 的读-改-写也没有锁保护（D1 的 `saveAll` 覆盖问题）。

---

## 5. 数值边界

**本节结论**：除零/负价/NaN 的主要风险不在除公式，而在**成本与现金的 round 口径不统一**（E1）以及**裁剪预算不含费、不扣挂单**（E2/E6）——两者都会让「裁剪结果」与「能否成交」不一致。

| # | 严重度 | 问题 | 证据（文件:行 + 片段） | 触发条件 | 后果 | 建议修法 |
|---|---|---|---|---|---|---|
| E1 | **P2** | 金额/成本四套 round：`money`(2dp)、`round2`(2dp)、`toFixed(2)`(日志)、portfolio `round4`、`avgCostFromHistory` 对 <10 元保留 3dp；`applyFill` 新建持仓漏 `netCost` 且 avgCost 2dp | `prismAccount.ts:51,261,268,304,314,322,399-400`；`prismDeskWrite.ts:50`；`portfolio.ts:198` | 低价 ETF（0.6952 元）买入/复制；大数量 | 复现：40,000 股 @0.6952 复制 → `cost=0.70`、`netCost=28,000`（真实 27,808，差 192 元）；卖出按 0.70 结转 realized，复现 `realized −33.28` vs 真实 `+161.44`（差 194.72）；新建持仓 `netCost` 缺失使 equity 走 `qty×cost` 回退 | 内部统一用整数「分」或 4dp 结算，展示层再 2dp；`applyFill` 新持仓写 `netCost`；cost/avgCost 对 <10 元保留 3–4dp；日志用 4dp |
| E2 | **P2** | clamp 的现金预算不含手续费：`cashMax = lot(floor(cashLeft/px))`，`minCash` 也按不含费现金算 | `prismAccount.ts:1511-1525`；成交前校验 `:213-219` 含费 | 买单恰好用满现金（如 100,000 元 / 10 元 = 10,000 股） | 复现：clamp 放行 10,000 股，成交需 100,026 元 → `fillRejectReasonOf` 报「现金不足」；裁剪记录写「现金 100000」却无法成交 | 现金预算按 `cashLeft/(px×(1+费率))` 或预留 `max(5, 费率×金额)+过户费`；minCash 用含费现金 |
| E3 | **P2** | `evaluationOf` 用 `base = equity − capital`，`if (!(base > 0)) continue`：亏损账户所有窗口被跳过 → `nUsed=0` → 显示「样本不足」而非亏损；`baseAdj<0` 时 `v/baseAdj−1` 使回撤符号反转 | `prismEval.ts:70-72,96-98` | 账户累计亏损（equity < capital）后做评估 | 评估永远「样本不足 n=0 < 30」，超额/回撤/命中率全 null；用户看不到真实亏损；负基数窗口方向错误 | 分母改用 `capital`（与 gate 一致），收益序列用 `equity−capital`；baseAdj ≤ 0 时用绝对收益或资金曲线，不要跳过全部窗口 |
| E4 | **P2** | `validateConstraints` 只做单字段 0–100，不校验字段间关系 | `prismDeskWrite.ts:110-125`；`prismAccount.ts:1517-1527` | 设 `minCashPct=90` 且 `maxPosPct=50`（或 `perStockPct > maxPosPct`） | 所有买单被裁到 0，统一报「裁剪后不足一手」，用户以为是行情/整手问题，实际是配置互斥 | 保存时校验 `minCashPct + maxPosPct ≤ 100`、`perStockPct ≤ maxPosPct`、`perOrderYuan ≥ 100×价格下限`，给字段级错误 |
| E5 | **P2** | `applyFeeCorrection` 只改 cash/realized，不改 fills 的 `fee` 与 `order.fee`；`credit` 只退不补（`beforeFee < afterFee` 时 `credit=0` 但仍记一条 correction） | `prismAccount.ts:104-126`；`prismRoutes.ts:621-622`（feesByDay 用 `f.fee`） | 拆单重复收最低佣金后订正；或反向订正 | 评估的 withFee 仍按旧费用；订单详情与 cash/realized 不一致；反向订正留下「credit 0」的假记录 | 订正同时回写 `fills.fee/commission` 与 `order.fee`，或把 correction 作为费用聚合的独立输入；`credit < 0` 时拒绝或显式记录补收 |
| E6 | **P2** | clamp 的现金预算只从 `ctx.cash` 起算，不扣已在场的 `pending` 买单；`pendingBuys` 只用于同产品闸 | `prismAccount.ts:1304-1305`（`pendingBuys` 定义）、`:1330`（`let cashLeft = ctx.cash`）、`:1352-1355`（只用 name 做同产品判据） | 上一轮已挂 10 万买单未成交，本轮再按 `cash` 全额裁剪 | 两轮 pending 合计超过现金；撮合按数组顺序先到先得，后一笔被「现金不足」拒绝，而裁剪记录显示「现金充足」 | `cashLeft = ctx.cash − Σ(pending 买单金额 + 预估费用)`；或在 `placeDecision` 落单前统一预占并写 `reservedCash` |

---

## 6. 风控阈值

**本节结论**：五个阈值（单票/行业/总仓/现金下限/止损）**顺序本身不会越裁越大**（§7 第 6 条）；问题是基数（F2 用成本价算总资产）、覆盖面（F3 行业闸只覆盖已持仓）和输入可信度（F4 模型可放大 singlePct）——以及止损的兜底口径（F1）。

| # | 严重度 | 问题 | 证据（文件:行 + 片段） | 触发条件 | 后果 | 建议修法 |
|---|---|---|---|---|---|---|
| F1 | **P1** | 止损 `costs = avgCost ?? cost`；`copyAtCost` 产出的持仓**没有 avgCost**，`applyFill` 首笔买入也用 `p.cost` 作 avg0；摊薄成本可负/可被亏损卖出推高，`cost > 0` 检查会让止损直接失效 | `prismAccount.ts:314`（copy 不写 avgCost）、`:265-268`（`avg0 = p.avgCost ?? p.cost`）、`prismRoutes.ts:549`；`:352-353` 注释（已知 30.71 vs 18.2） | 复制持仓后未手动「回填买入均价」；或老账本无 avgCost | 止损闸用摊薄成本：亏损卖出抬高成本 → 误判 −49% 触发（阻止加仓）；盈利卖出压低甚至打负 → `cost>0` 不成立，**止损永不触发**；无任何「未校准入均价」提示 | `copyAtCost` 写真实 `avgCost`（portfolio 的 avgCost）；缺失时 `avgCost:null` 并让 clamp 记 `skipped: stopLoss`（不回落 cost）；`applyFill` 对 avgCost 缺失的持仓不要用 cost 污染；启动自动 backfill 一次并留痕 |
| F2 | **P1** | routes 把 `price: quotes[p.secid]?.price ?? p.cost` 传给 clamp，使 `missingPrice` 永远为 false，单票/行业/总仓/maxPos/minCash 用成本价算总资产；clamp 自身在 `missingPrice` 为真时又静默跳过这些维度（`skipped` 只记 deviation/product） | `prismRoutes.ts:537`；`prismAccount.ts:1321-1322,1450-1484,1517` | 任一持仓缺现价（停牌/取数失败/新股） | 总资产被高估/低估 → 单票 30% 上限按错误基数放宽/收紧；minCash 下限按错误总资产；用户看不到「本次未做仓位校验」 | 传 `price:null` 并让 clamp 对每个被跳过的维度写 `skipped`；缺价时按保守值（上一有效价/成本取低）或直接拒新开仓 |
| F3 | **P1** | `industries` 只对 `account.positions` 取行业；模型新开仓的 secid 不在 map 中 → `industry=null` → 行业维度不加入 | `prismRoutes.ts:518`：`fetchIndustryOverview(account.positions.map(...))`；`prismAccount.ts:1460-1462` | 买入一个当前未持有的标的（最常见的新开仓） | 行业集中度上限对新开仓永远不生效，且无 skipped；组合可能在一夜之间堆满同一行业 | 对 `decision.orders` 的 secid 一并取行业；取不到时记 `skipped: industry`，可选拒绝该单 |
| F4 | **P1** | 决策解析把非 `'sell'` 一律当 `'buy'`；`singlePct`/`totalPct` 只校验 `typeof number`，不限 0–100 | `prismAccount.ts:476`：`side: o['side'] === 'sell' ? 'sell' : 'buy'`；`:494-495` | 模型输出 `"side":"SELL"`/`"卖出"`；或 `singlePct:500,totalPct:1000` | 复现：`SELL` 变成 `buy`（方向反转，可能把减仓做成加仓）；`singlePct=500` 时单票上限 = 5×总资产，完全不裁剪（`totalPct=1000` 同理） | side 白名单，非法即丢弃并计入 `parseError`；两个 pct 校验有限且 0–100，非法置 null。**注：工作树已有未提交的 side 修复（§0.2），本条按 HEAD 记录，仍需补 pct 校验** |

---

## 7. 已核验、不构成问题的点

以下项做了代码 + 复现核验，结论是**没有**问题（写进来是为了避免下一轮重复怀疑）：

1. **qty/available 不会变负**：`applyFill` 卖出先 `if (fill.shares > p.qty) throw`（`prismAccount.ts:275`），`available` 用 `Math.max(0, ...)`（`:283`）；下单前 `fillRejectReasonOf` 用 available 硬校验（`:224`）。
2. **拒单/撤单没有资金预占**：引擎没有 `hold/frozenCash` 概念，买单不锁现金、卖单不锁股数，因此「拒单/撤单后回滚预占」这一类 bug 不存在；代价是挂单不占额度（见 §E6）。
3. **`saveAll` 抛异常时的回滚有效**：`prismLedgerP0.test.ts` ② 注入「写第二个文件失败」，断言三文件与写前逐字节一致，实测通过（4/4）。缺口只在「rename 中途进程被杀」（§D5）。
4. **最低佣金按委托累计正确**：`feesOf` 用 `priorAmount/priorCommission`（`prismAccount.ts:73-74`），789+211 两笔实测费用 `5.08 + 0.02 = 5.10`，与整单 5.10 一致，没有重复收 5 元。
5. **净值点合并/排序正确**：`mergeEquity` 同日 next 覆盖、按 day 升序（`:610-615`）；`upsertEquity` 同日覆盖并 `slice(-365)` 有界（`:451-455`）。
6. **clamp 的维度顺序本身不会「越裁越大」**：各维度取绝对上限并依次收紧（`single → industry → total → perStock → perOrder → maxPos → dims → cash → minCash`），顺序不会放大结果；真正的问题是**基数**（F2 用成本价算总资产）和**费用**（E2 不含费），不是顺序。

---

## 附录：本次审计的边界

- 未审计：`prismCorrection.ts` 的错价订正数学（只看了入口与 cash/realized 影响）、`prismData.ts` 的展示层聚合、client 侧渲染、`prismPipeline` 的提示词。
- 未运行：完整 `npm run check`（基线由用户提供）；未做真实行情下的端到端撮合。
- 未修改：任何 `src`、`package.json`、配置；未 commit、未重启。
- 工作树漂移见 §0.2；如果要把本文当修复清单用，请先确认当前工作树与 HEAD 的差异，再按 HEAD 行号定位。

---

## 8. Top 5

1. **A2（P0）「按成本复制」在真实持仓为空时会清空模拟盘持仓，并把现金重置为本金** —— 一次 POST 造成账实永久不一致，且绕过了已有的空账户守卫。
2. **D1（P0）`saveAll` 整份覆盖 orders/fills，跨进程丢成交** —— 两个实例同开时，后写者用自己的旧快照覆盖，成交记录永久消失；`saveOrders` 有 merge，`saveAll` 没有。
3. **A1（P0）盈利卖出把 netCost 打成负数：浮盈虚增一倍，`rebase` 再把已实现盈亏冲掉** —— 买入 1000@10、卖出 900@30 即可复现；`realized+unrealized` 与 `equity−capital` 差 17,953.80。
4. **B1（P1）净值点按 `account.day` 落盘：盘前一次 GET 覆盖上一交易日收盘** —— 跳空缺口被并进昨日，回撤闸门看不到当日跌幅。
5. **F1（P1）止损用摊薄成本兜底：复制出来的持仓没有 avgCost，止损可能永不触发或误触发** —— 与项目自己记录过的「招商轮船 cost 30.71 vs 真实 18.2」是同一根因，只是修在了 backfill 一侧，没有修在数据产生侧。
