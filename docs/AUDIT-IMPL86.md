# AUDIT-IMPL86 —— 复盘行（第 8 行 `fupan`）联动持仓交易记录（只读）

> 版本：v0.113.0 工作区（**未 bump 版本号**、未提交）
> 主题：① 新增 `GET /tradewatcher/fupan/trades?day=YYYY-MM-DD`（该日逐笔 + 汇总 + **当日盈亏**，取持仓核算）；
> ② `GET /tradewatcher/fupan/month` 的 `dates[]` 增加 `trades`（该日计入笔数，**0 = 真的没有**，读不到 = `null`）
> 门禁基线：**933 用例 × 2 时区 + 构建 73 项** → 本次 **957 用例 × 2 时区 + 构建 73 项**
> （宿主侧本批 +13；客户端另一路 +11，见 §6）

## 0. 结论

复盘行新增一条**只读**路由，把「某一天的持仓交易记录」接到复盘页：

- **零新增上游请求**：流水读本地 `ledger.json`，行情只读共用槽与 LKG 银行（新增的 `em.peekQuotes`，
  `src/host/em.ts:1209`），缺价就如实缺 —— 不为了这条路由回源。
- **当日盈亏不重算**：直接取持仓核算（`assemblePortfolio` 的 `grand.dayPnl`，与持仓页同一条链），
  逐笔重算会漏掉隔夜持仓那部分 `(现价 − 昨收) × 期初数量`（实测差 100 元，见 §5 第 ③ 条）。
- **读取失败按用户显式决定**回「0 笔」（HTTP 200，不抛错、界面不画提示），但回包**仍然**带
  `readFailed` / `readFailedReason` / `missing[]` —— 数据层不许撒谎，显示层按豁免执行（§3）。
- 四处镜像（真表 / `cordis.patch.yml` 行注释 / 文档 §2.1 + 路由账 / `src/index.test.ts` 副本）
  与 `FUNCTION_OWNED_PATHS` 同批更新；路由账 **28 → 29**（`fupan 2 → 3`）。
- **月历带每日笔数**：`dates[].trades` 与逐日明细**同一份**过滤/归属（一次遍历当月流水），
  所以「没点开的日子」不再看起来像没有交易；流水读不到时是 `null` 而不是 0（§2.5）。
- `build.mjs` **未改动**（`git status` 无该文件；73 项锁定片段照旧通过）。

## 1. 路由与四处镜像（落点）

| 位置 | 内容 |
| --- | --- |
| `src/host/routes.ts:1495-1520` | 路由本体：`kind:'exact'`、`path:'/tradewatcher/fupan/trades'`，GET-only（非 GET ⇒ 405），`store.init()` 后直接 `send(res, 200, readFupanTrades(store, day))` |
| `src/host/routes.ts:32` | `import { parseFupanDay, readFupanMonthTrades, readFupanTrades } from './fupanTrades.ts'` |
| `src/host/routes.ts:1388-1456` | **月历**：`dates` 每格补 `trades`（`readFupanMonthTrades(store, ym)`），回包另给 `readFailed` / `readFailedReason`，`missing[]` 并入流水那条 |
| `src/index.ts:81` | 真表（唯一事实源）：`fupan: ['/tradewatcher/fupan/month', '/tradewatcher/fupan/note', '/tradewatcher/fupan/trades']`；注释块 `:71-80` 同步 |
| `cordis.patch.yml:15-19` | 行注释：三条路由各自一个反引号 token（**不写 `/a\|b`**） |
| `cordis.patch.yml:81-82` | 插入块上方的注释：同款三个独立 token |
| `docs/DESIGN-SUBPLUGINS.md:4`、`:172` | 路由账 **29 = core 15 + calendar 1 + watchlist 3 + portfolio 2 + market 4 + cloudmap 0 + tools 1 + fupan 3**（两处都改） |
| `docs/DESIGN-SUBPLUGINS.md:55`、`:73`、`:90` | §2 功能行清单 / §2.1 表 fupan 行 / §2.2 判据表新增一行 |
| `src/index.test.ts:76` | `FUNCTION_OWNED_PATHS` 加 `/tradewatcher/fupan/trades`（并集 = 真表并集，判据 `src/index.test.ts:586`） |
| `src/index.test.ts:348`、`:518`、`:543`、`:565`、`:586` | 测试副本 / `fupanOwnershipProblems` 的 `want` / 真表断言 / 「归 core」注入源码串 / 运行时"fupan 行只注册自己那三条" |

归属判据仍按 §2.2「单一消费方 ⇒ 该行」：这条路由只被复盘页消费（`api.fupanTrades` 的唯一调用方是
`src/client/FupanPage.tsx`），`src/rowOwnership.test.ts` 按真实调用点推导后**仍全绿**
（该判据有"唯一调用方"要求，所以客户端那条线必须同批接线 —— 已由另一路落地）。

## 2. 数据来源与口径

新模块 `src/host/fupanTrades.ts`（纯函数 + 60 秒缓存；**一个 fetch 都没有**）。

### 2.1 逐笔字段（`FupanTradeRow`，`src/host/fupanTrades.ts:33-45`）

| 字段 | 口径 |
| --- | --- |
| `ledgerId` | 流水 `id`（客户端跳转并在流水列表里高亮那一条） |
| `ts` / `time` | 原始 epoch + `HH:mm`（**北京**，`time.ts` 的 `hhmmOf`） |
| `name` | `name ?? secid ?? '（未命名）'` |
| `side` / `direction` | `buy|sell|adjust` + 人话「买/卖/调整」（`FUPAN_TRADE_LABEL`） |
| `qty` / `price` / `fee` | 未填 ⇒ **`null`**（不补 0） |

- **归属日 = `ts` 的北京日**（`tradesOfDay` 用 `dayOf`，`Asia/Shanghai` 固定时区）。
- **只计入 `buy` / `sell` / `adjust`**（`FUPAN_TRADE_VERBS`）；`add`/`remove`/`gcreate`/`grename`/`gdelete`/
  `grestore`/`gmove`/`pnote` 一律不进交易记录。
- 排序：`ts` 升序，同 ts 按 `id` 稳定（与 `sortLedger` 同口径）。

### 2.2 当日盈亏 = 持仓核算值（不重算）

`accountingDayPnl()`（`src/host/fupanTrades.ts:165`）读 `assemblePortfolio(...)` 的结果：

- 行情来自 `em.peekQuotes()`（`src/host/em.ts:1209`）= **只读**共用槽（10 分钟窗口）+ LKG 银行，不回源；
- `dayPnl = view.grand.dayPnl`（与 `/tradewatcher/portfolio`、徽标同一份核算）；
- **任何一行算不出**（缺现价/昨收）⇒ `dayPnl: null` + `dayPnlReason` 点名哪几只 ⇒ **不写 0**；
- **只对"今天"（北京日）给数**：`day` 不是今天 ⇒ `dayPnl: null` + 原因（`src/host/fupanTrades.ts:252-266`）。
  持仓核算的"当日盈亏"永远指今天那一天，拿它冒充历史某天就是编数 —— 历史日期的逐笔照给，盈亏不给；
- 空仓 ⇒ `0`（那是真的 0，不是"不知道"）。

### 2.3 上限与截断

单日 **500** 笔（`FUPAN_TRADES_MAX`），超出返回前 500 并带 `truncated {shown, total}`；
`total` 是该日**全部**计入笔数（不受截断影响），客户端据此显示「另有 N 笔未显示」。

### 2.4 汇总（`summary`，按**全日**算）

`count` / `buy{count,qty}` / `sell{count,qty}` / `adjust{count,qty}` / `fees` / `amount` / `unpriced`。
- 成交额只在买卖两侧**价格齐全**时给数；有缺价流水 ⇒ `amount: null` + `unpriced` 条数（不拿部分冒充总额）；
- 调整没有成交额，不计入 `unpriced`；费用未填按 0 计（与持仓核算同口径）。

### 2.5 月历的每日笔数（`dates[].trades`）

- 实现：`tradeCountsOfMonth`（`src/host/fupanTrades.ts:130`）在一次遍历里按**北京日**分组；
  该分组函数 `tradesByDayOfMonth`（`:116`）**同时**被 `tradesOfDay` 用来取当天逐笔 ——
  两条路由不可能各写一套判断（"哪些 verb 算交易、算在哪一天"只有这一处）。
- `0` = 那天真的没有交易；`null` = 流水读不到（整月每格都是 `null`，界面据此不画 `▲n`）。
- 缓存：与逐日同一份 60 秒缓存（键 `month:YYYY-MM`）+ 同一条写路径失效。
- `source` 仍是月历原来那一行（`local:fupan.json+calendar:trading-calendar.json`）：笔数来自本地流水，不改口径行。

## 3. 读取失败口径（用户显式决定 × 红线的处理）

用户要求「读取失败即返回 0 笔、不给提示、界面不画三角」，与「数据层不得撒谎」冲突。落法：

- **HTTP 仍是 200**（不抛 500）：`trades: []`、`total: 0`、`truncated {shown:0,total:0}`、`summary` 全 0、
  `dayPnl: null` + `dayPnlReason`；
- **同时**保留 `readFailed: true`、`readFailedReason`、`missing[]`（`unreadableMissing`）⇒ 服务端如实记录，
  显示层按用户豁免不展示；
- `readFailed` **恒存在**（正常时 `false`），不只是失败时才有 —— 客户端不靠"字段缺席"猜状态。

判据：`readFailProblems`（`src/host/fupanTrades.test.ts`）要求 `code===200` + `trades` 空数组 + `readFailed===true`。
反例注入：失败时**不给** `readFailed` ⇒ 必败；失败时**抛 500** ⇒ 必败；失败时 `dayPnl: 0` ⇒ 必败。

## 4. 缓存与零上游请求

- **60 秒内存缓存**（`FUPAN_TRADES_TTL_MS`，按 `(store, day)` 分槽，条数上界 64）；
- **流水写入后立即失效**：`DataStore` 新增写路径钩子 `onLedgerWrite`（`src/host/store.ts:533`），
  在 `commit()` 落盘成功后触发（`src/host/store.ts:616`，只对 `ledger.json` 触发），
  导入备份也触发一次（`:709`）。订阅方是 `attachFupanTradesCache`（幂等，同一个 store 只订阅一次）——
  **不是轮询**。
- **零新增上游请求**：源码判据只允许 `em.peekQuotes`；运行时用打桩 fetch 计数（见 §5 ⑦）。

## 5. 断言与反例注入（`src/host/fupanTrades.test.ts`，10 条）

| # | 判据 | 实测读数 | 反例注入（必须被抓到） |
| --- | --- | --- | --- |
| ① | 逐笔只含 buy/sell/adjust | 7 条流水（含 add/remove/grename/pnote）⇒ 只回 3 条，`total=3` | 全量返回 ⇒ 必败；漏 `adjust` ⇒ 必败 |
| ② | 归属日按**北京日** | `2026-10-19T23:30Z` ⇒ 北京 **10-20**（`time=07:30`）；`2026-10-19T00:30Z` ⇒ 北京 **10-19**（`08:30`）；非法 day ⇒ 400 | 按 UTC/宿主日 ⇒ 两条串到同一天（`assert.notDeepEqual` 实证不同） |
| ③ | 当日盈亏取**持仓核算值**（且只对"今天"） | 隔夜 100 股@10 + 今日买 100@11 费 5，现价 11/昨收 10 ⇒ **95**（= `assemblePortfolio().grand.dayPnl`）；查 3 天前 ⇒ `dayPnl:null` + 原因含「不是今天」，逐笔照给 | 按逐笔重算 = **−5** ⇒ 必败；写 0 ⇒ 必败 |
| ④ | 算不出 ⇒ `null` + 原因 | 持仓在、本地无行情 ⇒ `dayPnl:null`，原因点名「浦发银行」 | 写 0 ⇒ 必败；空原因 ⇒ 必败；空仓 `0` 且无原因（真的 0） |
| ⑤ | 单日上限 500 | 600 笔 ⇒ `trades.length=500`、`truncated{shown:500,total:600}`、`summary.count=600`、首行 `l-000` 末行 `l-499` | 不截断（shown=600）⇒ 必败 |
| ⑥ | 缓存 60s + 写后失效 | 60s 内两次读 ⇒ 构建 **1** 次；+61s ⇒ **2** 次；录入一笔流水后 `fupanTradesCached=false`，再读 ⇒ 构建 +1 | 无缓存（60s 内构建 2 次）⇒ 必败；永不失效（写后仍命中、构建 0 次）⇒ 必败 |
| ⑦ | 零上游请求 | 打桩 fetch：预热后调用路由 ⇒ **delta 0**；源码扫描（只允许 `em.peekQuotes`）0 命中 | 为它发一次 fetch ⇒ 计数 ≠ 0；源码注入 `fetch(...)` / `em.fetchQuotes(...)` ⇒ 必败 |
| ⑧ | 路由归属 = `fupan` | 真源码 0 冲突；`src/index.test.ts` 的四处镜像 + 运行时"fupan 行只注册这三条"全绿 | 从 fupan 行删掉（⇒ 归 core）/ 同时塞进 market ⇒ 必败 |
| ⑨ | 读取失败口径 | `ledger.json` 建目录（EISDIR）⇒ 200 + 0 笔 + `readFailed:true` + `missing[]` 1 条 | 不给 `readFailed` / 抛 500 / `dayPnl:0` ⇒ 必败 |
| ⑩ | 正常回包字段齐全 | 逐笔 9 个字段齐；`adjust` 的 qty/price 为 `null`；`summary.amount` 只算买卖 | —（`readFailed` 恒存在断言在此） |
| ⑪ | 月历逐日笔数 | 3 笔落 2 天 ⇒ `2026-09-08=2`、`2026-09-15=1`、其余 0；只有 `remove/grename` 的那天 = 0 | 不填该字段 ⇒ 必败；把 create/remove/rename 也算 ⇒ 必败（09-08 会变 3） |
| ⑫ | 月历 × 逐日 **交叉一致** | 30 天逐日调 `/trades?day=` 与月历笔数逐一比对 ⇒ 0 差异 | 月历按全量、逐日按过滤（两套口径）⇒ 必败 |
| ⑬ | 月历读失败 ⇒ `null` | `ledger.json` 建目录 ⇒ 每格 `trades: null` + `readFailed: true` + `missing[]` 1 条 | 写 0 ⇒ 必败；不填 ⇒ 必败 |
| ⑭ | 月历仍零上游 | 打桩 fetch：调用月历 delta **0**；handler 只出现 `readFupanMonthTrades` | 发一次 fetch / handler 里出现取数 ⇒ 必败 |

## 6. 门禁读数（本批实测）

```
$ npm run typecheck                      # 0 error
$ npm test                               # TZ 默认：ℹ tests 957 / ℹ pass 957 / ℹ fail 0
                                         # TZ=UTC ：ℹ tests 957 / ℹ pass 957 / ℹ fail 0
$ npm run selftest                       # ALL HOST CHECKS PASSED（live probes soft）
$ npm run build                          # built lib/index.js + lib/client.js（客户端片段校验通过：73 项）
```

基线 933 ⇒ 957 的构成：宿主侧本批 **+13**（`src/host/fupanTrades.test.ts`：逐日 10 + 月历 3），
客户端另一路 **+11**（`src/client/impl87.test.ts`，同一功能的界面侧）。

## 7. 未做项 / 明确不做

- 月历笔数已按 Lead 要求补上（§2.5）：客户端的前视兼容（`FupanDateDto.trades?`）自动生效，无需改界面。
- **不做写入**：本路由 `GET` only；不改流水、不补成本、不自动配对（做T在 `/portfolio` 的 `dayTrades`）。
- **不做跨日/跨月汇总**：一次只答一天；月级统计留给后续批次。
- **不改 `src/client/**`**：界面侧（`api.fupanTrades`、`FupanPage`、`fupanTrades.ts`/`tradeJump.ts`）由另一路负责。
- **未透出行情新鲜度**：`asOf` 是回包生成时刻，`stale` 恒 `false`（"本地读没出问题"）。`dayPnl` 用的是共用槽里
  最近一次真实读数（`row.at` 可算），但本批没有把它单列成 `quotesAsOf` —— 客户端 DTO 也还不读这个字段。
  注意：行情"旧但非空"时 `dayPnl` 仍会给数（它确实是持仓核算按那条读数算出来的），只是不知道多久之前；
  要显示「盈亏是几分钟前的」时再加字段。

## 8. `build.mjs` 未改动

```
$ git status --short build.mjs
（无输出）
```

73 项客户端片段校验照旧通过（§6 最后一行），本批没有新增/删除任何被锁定的文案片段。
