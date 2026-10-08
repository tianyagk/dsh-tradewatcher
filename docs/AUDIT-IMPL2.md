# 实现报告：批二（审计必修项）

> 任务：`task-5`（实现工程师 `impl-ui`）。逐条对应任务里的 12 个编号项。
> 输入：本仓库两份审计报告（[`AUDIT-FUNCTION.md`](AUDIT-FUNCTION.md) / [`AUDIT-UI.md`](AUDIT-UI.md)）。
> 批一的记录在 [`AUDIT-IMPL.md`](AUDIT-IMPL.md)（未改动）。当前生效口径以 [`../README.md`](../README.md) 为准（README 属整合范围，未改）。
> 交付时 `npm run check` 全绿；未提交 git（Lead 统一提交）。

## 0. 状态总览

| # | 项 | 状态 |
| --- | --- | --- |
| 1 | 大盘页用 0 顶替缺失涨跌家数（P0） | ✅ 做了 |
| 2 | 日历 asOf/stale 在上游全挂时失效（P0） | ✅ 做了 |
| 3 | 云图配色写死（P0） | ✅ 做了（结论见 §3） |
| 4 | Markdown `**` 泄漏（P0） | ✅ 做了（全仓扫描，14 处） |
| 5 | 输入控件没有可见焦点环（P0） | ✅ 做了 |
| 6 | 宽屏两列按行填充打乱名次 + 断点（P1） | ✅ 做了 |
| 7 | 缺失原因只能 hover（P1） | ✅ 做了（大盘 / 自选 / 持仓 / 日历的关键缺失） |
| 8 | 「同一状态四种叫法」（P1） | ✅ 做了（**一处例外需 Lead 配合**，见 §8.8） |
| 9 | 未录入成本被当成 0 成本（P1） | ✅ 做了（含 **D1**：卖出不再解除守卫 §8.9b；**D1b**：成本未知期间卖出的已实现不被算成数字 §8.9c；**N1/N5/N2** 收口 §8.9d） |
| 10 | 卖出不校验可用数量（P1） | ✅ 做了（宿主 + 表单） |
| 11 | no-source 归因方向错误（P1） | ✅ 做了 |
| 12 | replay 吞掉异常流水（P1） | ✅ 做了 |
| — | 顺手修（非本批编号） | 2 处：未定义的两个 CSS token、竞品站点"约 8 秒"未验证数字（见 §9） |

`npm run check`：typecheck 通过 · **156 条测试 × 2 时区全绿**（批一 126 → 批二 146 → D1 150 → D1b 154 → 收口 156）· 宿主自检 `ALL HOST CHECKS PASSED (live probes soft)` · 构建 75 项片段校验通过。

## 1. 大盘页 0 顶替缺失涨跌家数（P0-1）

**做了什么**：新增纯函数模块 `src/client/breadthView.ts`（不 import react）：

- `breadthCells(sh, sz)` → `{up, down, even, amount, countsOk, amountOk, reason, missingParts}`。
  任一腿的家数缺失 ⇒ **三格全 null**（不是 0），并给出缺失分量名与原因；
  成交额与家数**分开判**（家数可用不因成交额缺失而消失；成交额为 0 也视为不可用）。
- `upDownPair(up, down)`：涨/跌成对显示，**一侧缺失就整格 `—`** —— 消灭审计点名的 `1234 / 0`。
- `UPDOWN_MISSING_NOTE`：成对缺失时的统一说明（title 与 aria-label 共用一句）。

**接线**：`MarketPage.tsx` 的 `(sh?.up ?? 0)+(sz?.up ?? 0)` 求和整段替换为 `breadthCells`；
四处单元格改判 `cells.countsOk / amountOk`（上涨/下跌/平盘/两市成交额）；
表格里两处 `String(down ?? 0)` 改用 `upDownPair`；`IndustryHeatmap.tsx` 的 tooltip 同样改判。

**口径**：缺失显示 `—` + 原因（"备用源不含涨跌家数字段，等东财恢复后随行情轮询自动重试"），
**绝不把缺失编码成 0**；而真正的 0（当天确实没有一只上涨）仍照常显示 0 —— 两者含义完全不同。

**验收**：`breadthView.test.ts` 4 条断言（含"up=null 时三格必须为 null、原因必须写'显示 — 而不是 0'"、
"up 有值 down 缺失时不得出现 1234/0"、"0 是合法值"、"成交额为 0 视为不可用"）；界面另有可聚焦的原因行。

## 2. 日历 asOf / stale（P0-2）

**做了什么**（`src/host/calendar.ts`）：

- `CalFile` 拆成两个时刻：`syncedAt`（最近一次**成功**同步）与 `syncAttemptAt`（最近一次**尝试**）；
  旧文件缺 `syncAttemptAt` 时按"从未记录过尝试"装载（不因一个坏字段失败）。
- 四个自动源改为经 `run(key, label, body)` 执行并**记录逐源结果**（`ok | failed | skipped`）：
  `skipped` = 本次未尝试（没有关注标的时的财报/分红），**不算失败**。
- `syncStatus()` 统一翻译：`syncedAt`（从未成功 ⇒ `null`，不拿"现在"顶替）、`attemptAt`、
  `stale`（有源失败，或从未成功同步过）、`missing[]`（逐源失败明细 + 同步过程本身抛错）、`allFailed`。
- 「成功」只在**至少一个源成功**时才推进 `syncedAt`；全失败时数据仍是上次那份、且**如实标降级**。
- 补一条失败冷却 `SYNC_FAIL_COOLDOWN = 5 分钟`：旧的"无条件写 syncedAt"其实兼任了节流阀，
  拆开之后必须显式补上，否则上游全挂时每次面板刷新都会重打四个源。
- 可注入取数入口 `CalSyncFetchers`（默认真实实现），让"全挂"这条路可被断言。

**接线**：`tools.ts` 的日历工具 `asOf` 只认 `syncedAt`（不再读 `syncError`），`stale`/`staleCount`/`missing` 全部来自 `syncStatus()`，
render 增一行「本次同步失败源：…（尝试于 …）」；`routes.ts` 的 `GET/POST /tradewatcher/calendar` 回包带
`syncedAt / syncAttemptAt / stale / syncSources[] / missing[]`（GET/POST 共用 `calendarStatusPayload()`，避免两处口径分叉）；
`CalendarPage.tsx` 顶部显示"同步于 …（本次未全部成功）"或"尚未成功同步"，并在失败时给出**可聚焦**的逐源说明。

**验收**：`calendar.test.ts` 3 条（全失败后 `syncedAt` 不变 + `missing` 4 条含上游原因 + 落盘写 `syncAttemptAt`；
从未成功 ⇒ `asOf=null` 且 `stale=true`；无标的时 skipped 不算失败）。
本机实测（真实上游：新股与宏观可用）：`syncedAt=syncAttemptAt`、`stale=false`、
`syncSources=ipo:ok earnings:skipped dividend:skipped macro:ok`、`missing=[]`。

## 3. 云图配色（P0-3）—— 三条色义是否收敛为一条？

**做了什么**：`CloudMap` 改为接 `props.redUp`（调用点 `index.tsx` 传 `prefs.redUp`）并**透传**给自绘热力图；
第三方站点档位加常驻徽标「该站：红=跌 绿=涨（与本面板相反 / 与本面板当前设置一致）」，并写明"由该站点决定，本插件改不了"。

**结论（逐条回读代码后的判定）**：

| 数字面 | 是否跟随 `prefs.redUp` | 说明 |
| --- | --- | --- |
| 自绘热力图（云图页） | ✅ 现在跟随 | 改前写死 `redUp: true`，与大盘页/列表相反 |
| 列表涨跌（自选 / 持仓 / 大盘 / 行情条） | ✅ 一直跟随 | 全部经 `dirClass(..., prefs.redUp)` |
| 四态色点（实时/延迟/定稿/无行情源） | ⛔ **不跟随，也不应该跟随** | 它编码的是**新鲜度**，不是涨跌方向 |

**因此"三条收敛为一条"的准确说法是：所有**编码涨跌方向**的面已收敛到同一套 `prefs.redUp`（热力图 + 列表 + 行情条 + 筹码块）；
四态色点是另一条语义轴（数据可信度），把它并入 `redUp` 反而会出错 —— 例如"绿涨红跌"档位下，
"实时"点变成红色会被读成"跌"。它当前的问题只剩**色值硬编码**（`quoteState.ts` 用 `#27a644/#e0a94a/#8a8f98/#ff5f6d`，
恰是深色主题的取色），属审计 P1-11（硬编码色与 token 脱钩），**不在本批编号内**，见 §8.13。

第三方 iframe 是外部口径：只能提示、不能改（已加提示）。

## 4. Markdown `**` 泄漏（P0-4）

**做了什么**：先写了一次全仓扫描（去注释后找字符串里的 `**`，排除 `10 ** exp` 这类幂运算），
把**会被人读到的文案**里的 18 处全部改掉（`**X**` → 「X」）：客户端界面 11 处 ——
`MarketPage`、`PortfolioPage`、`RescuePanel`（4 处）、`TopBar`（2 处）、`WatchlistPage`、
`sort.ts`（名称列提示）、`ytdView.ts`（YTD tooltip）；宿主侧会出现在工具输出里的 7 处 ——
`ytd.ts`（YTD 的 why 文案）、`tools.ts`（4 处工具描述）、`writeLog.ts`（节流错误）、`selftest.ts`（断言消息）。
复查扫描：字符串内 `**` 剩余 0 处（仅剩幂运算）。**没有把强调改成 HTML**（用「」而不是 `<b>`，`<b>` 只留给确实需要加粗的位置）。

## 5. 输入控件焦点环（P0-4 / UI 必修 4）

**做了什么**（`styles.ts`）：
- `input:focus/select:focus` 由 `box-shadow:var(--tw-focus)`（该 token **全项目未定义**）改为只改边框色；
- 新增 `input:focus-visible/select:focus-visible{box-shadow:0 0 0 3px var(--tw-ring)}`（`--tw-ring` 是已定义 token），
  **只在键盘聚焦时画环**，鼠标点击不画；
- `input[type=range]:focus-visible{outline:2px solid var(--tw-accent)}` —— `TopBar` 的不透明度滑块此前内联 `border:none`，等于完全没有焦点提示。

## 6. 宽屏多列：按列填充 + 断点（P1-6）

**做了什么**（`styles.ts`）：
- `.tw-wlist/.tw-poslist` 由 `display:grid; repeat(auto-fill,minmax(520px,1fr))`（**按行**填充，第 2 名跑到右列）
  改为 `columns:520px;column-gap:16px`（CSS 多列 = **按列竖向**填充），并给行加 `break-inside:avoid`。
- 断点 1500px → **1080px**（两列所需 520×2+16+内边距），并在三处保持**同一断点**：
  多列、`.tw-sorthead`（列头）、`[data-wide-hide=1]`（收起段控）；三处都写了"⚠ 必须一起改"的注释。
- 组头双线：**放弃** `:nth-child(-n+2)`（多列按高度均衡填充，"每列第一行"是第几个子元素取决于条目数，nth-child 表达不了），
  改为在 ≥1080px 时让 `.tw-group-h` 不画线、由行自己的 `border-top` 充当那一条线 —— 每一列看到的线都相同。
  该覆盖规则**写在 `.tw-group-h` 定义之后**（同优先级下 CSS 按出现顺序决胜，写在前面会被基础规则覆盖）。

**验收**：`npm run build` 通过（`tw-wlist`/`tw-poslist` 仍在 75 项片段里）；
按涨跌幅降序后左列自上而下是 1/2/3 名（多列竖向填充是 CSS 语义保证，需装机目视复核，见 §10）。

## 7. 缺失原因可聚焦（P1-7）

**做了什么**：给**关键缺失**补 `tabIndex=0 + role="note" + aria-label`（原因不再只挂在 `title` 上）：
大盘页涨跌家数缺失行与表格里成对的「—」、自选页的「板块 —」「α —」「无行情源」「暂无行情」以及缺失时的 YTD、
持仓页的「无行情源/成本未录入」meta 与缺失时的 YTD、日历页的同步失败说明。
可计算/正常状态**不**加 Tab 停靠点（避免每行多一个停靠点）。

## 8. 其余各项

### 8.8 同一状态四种叫法 → 「无行情源」
`quoteState.ts` 新增 `NO_SOURCE_LABEL='无行情源'`、`PENDING_LABEL='暂无行情'`、两个 title 常量；
`QUOTE_STATE_LABEL.missing` 改用同一常量（徽标「无行情源 N」与行内标记同词）；
`WatchlistPage` 行内「暂无可用行情源」→ 常量、「暂无行情」保留（专指"本轮还没取到"）；
`PortfolioPage` 徽标「N 只无价」→「N 只无行情源」、行内两态改用常量。

**（旧版报告里那处"需 Lead 配合"的例外已解决 —— D2）**：`build.mjs:172` 的片段与 `ui.tsx:147` 的 tooltip
均已由 **Lead 一并统一为「无行情源」**，构建 75 项片段校验通过。本批只负责上面四处点名处的可见文案一致。

### 8.9 未录入成本不再被当成 0 成本
`derivePosition` 增判据 `costUnknown = qty>1e-9 && avgCost<=0 && turnover<=0`：
该情形下**市值照算**，`floatPnl/dilutedPnl` 及两个盈亏率一律 `null`（界面 `—`），
并在 `PositionRow` 增 `costUnknown` 上抛；界面（行内「成本 —（未录入）」「未录入成本 → 用「调整」补成本价」
+ 面板级"未计入合计"提示）与工具（总览行内点名、明细行改注释）都说明"不计入盈亏合计"。
**验收**：`portfolio-cost.test.ts` 5 条（含 `floatPnl` 必须为 null 而不是 `12.5×100`、
真正买卖过就不算未录入、补成本后标记消失、分组与总额只含成本已知的那只）。

### 8.9b D1 修复（独立验收发现的残留缺陷，必修）

**现象**：`costUnknown` 原判据里的 `turnover <= 0` 被**卖出**破坏 —— 卖出同样产生成交额，
于是一次卖出之后守卫自行解除，持仓重新落回 0 成本路径（实测：浮盈 = 剩余 50 股的全额市值、
摊薄盈亏 = 市值的两倍、已实现 = "0 成本买入"的收益）。操作路径全是界面正常动作。

**最终判据**（`src/host/portfolio.ts`）：

```ts
const costAmountRecorded = hasPricedCostEntry(entries, pos.id)
const costUnknown = !costAmountRecorded && total.avgCost <= 0 && (total.qty > 1e-9 || Math.abs(total.realized) > 1e-9)
```

`hasPricedCostEntry(entries, posId)`（新导出的纯函数）= 存在 **`buy` 且 `price > 0`**，或存在 **带 `price > 0` 的 `adjust`**。
即"不存在**产生成本**的流水"——卖出产生 `turnover` 但不产生成本，这正是旧判据失效的原因；
买入要求 `price > 0` 是为了挡住手工改过的流水里 price=0 的买入（否则又会退回"浮盈 = 全额市值"）。

**覆盖范围**：
- 部分卖出（验收员的复现）✓；
- **全部卖出**（qty 归零）：`costUnknown` 仍为真（靠 `|realized| > 1e-9`），因此那笔按 0 成本算出来的已实现也是 `—`；
- `dilutedCost` 在成本未录入时**不给数**（此时净成本被卖出收入冲成负数，例如 −12.5，显示出来会让人以为"成本真是负的"）；
- 受影响字段：`floatPnl / dilutedPnl / floatPnlPct / dilutedPnlPct / realized`（`PositionRow.realized` 类型放宽为 `number | null`）
  与 `dilutedCost`；**`mv` 照算**（与成本无关），`dayPnl` 不受影响（它基于昨收，不依赖成本）。
- 界面与工具：行内「成本 —（未录入）」「未录入成本 → 用「调整」补成本价」、已实现格的「成本未录入 → 已实现不可算（它不是 0）」、
  交易明细弹窗顶部一句说明、面板级"未计入合计"提示、`tradewatcher_portfolio` 总览行与明细行；合计侧对 `null` 一律**跳过**（不是当 0 参与求和）。

**为什么 `realized` 选 `null` 而不是 `0`**：0 会被读成"确实没有已实现盈亏"（另一条错信息），
而真相是"算不出来"。`null` 在界面渲染为 `—`，合计里被跳过，与"缺失不许用 0 顶替"这条仓库红线一致。

**新增断言（4 条，`src/host/portfolio-cost.test.ts`）**：
1. D1 正向：`adjust(100,0)` + `sell(50,12.5)` + 现价 12.5 ⇒ `costUnknown=true`、`floatPnl=null`、`dilutedPnl=null`、`realized=null`，
   且断言 `turnover=625`（说明"卖出确实产生成交额"——旧判据的成因）；
2. D1 边界（全部卖出）：`adjust(100,0)` + `sell(100,12.5)` ⇒ `qty=0`、`realized=null`、`costUnknown=true`；
   同时锁住"真的什么都没有的空仓（`adjust(0,0)`）不算未录入"；
3. D1 反向（别把正常路径一起关掉）：`buy(100,10)` + `sell(50,12)` ⇒ `costUnknown=false`、`realized=100`、`floatPnl=125`；
4. D1 边界（补成本）：`adjust(100,0)` + `sell(50,12.5)` + `adjust(100,9.5)` ⇒ 守卫解除、`floatPnl` 恢复计算。

**实测（本机，走真实 store 路径复现验收员那条操作链）**：

```
adjust(100,0) + sell(50,12.5)，现价 12.5 →
{"qty":50,"avgCost":0,"dilutedCost":null,"turnover":625,"realized":null,"costUnknown":true,
 "floatPnl":null,"dilutedPnl":null,"floatPnlPct":null,"dilutedPnlPct":null,"mv":625}
分组/总览（未计入口径）：{"totalMv":625,"floatPnl":0,"dilutedPnl":0,"realized":0}
全部卖出后：{"qty":0,"realized":null,"costUnknown":true}
反向（buy 100@10 → sell 50@12）：{"qty":50,"costUnknown":false,"realized":100,"floatPnl":125}
```

**已知边界（未在本批扩大范围）**：补成本（`adjust` 带 price）**不回溯**那笔历史卖出的已实现 ——
账本按"卖出当时的成本"记它（当时是未知的 0），这是 `adjust` 的既有语义（"调整不改已实现"）。
也就是说：`adjust(100,0)` → 卖出（已实现显示 `—`）→ 补成本 9.5 之后，已实现会显示 625（按 0 成本算）而不是 150。
要根治需要给 `TradeState` 加"在成本未知时卖出的数量"计数器、并把 `realized` 置为粘性 `null`，
但这会让"补成本后仍不给数、且用户无法修复"，属于需要 Lead 拍板的语义变更 —— 本批按任务要求
（"补上成本 ⇒ 守卫解除、盈亏恢复计算"）实现，并把这一点登记在遗留风险里。

### 8.9c D1b 修复：成本未知期间卖出的已实现，在后补成本后也不得被算成数字

**现象**（§8.9b 自己点出的那条边界）：`adjust(100,0)` → `sell(50,12.5)`（此时正确显示 `—`）→ 用户再补成本 9.5。
补成本使 `costAmountRecorded=true`、持仓级守卫解除，但重放里那笔卖出是在 `avgCost=0` 时应用的，
`realized` 于是被算成 `(12.5 − 0) × 50 = 625`（真实应为 150）—— **界面会把它当成正常数字展示**。

**修法：按"逐笔卖出时的成本是否已知"判定**（不用持仓级粘性 null）。关键几行：

```ts
// store.ts / applyTrade（sell 分支）
if (state.avgCost > 0) {
  state.realized += (price - state.avgCost) * qty - feeN
} else {
  // 成本未录入：这笔的已实现盈亏算不出来 —— 记股数，且**不累加**进 realized
  state.realizedUnknownQty += qty
}

// portfolio.ts / derivePosition
const costUnknown = !costAmountRecorded && total.avgCost <= 0 && (total.qty > 1e-9 || total.realizedUnknownQty > 1e-9)
realized: costUnknown || total.realizedUnknownQty > 0 ? null : round2(total.realized),
realizedUnknownQty: total.realizedUnknownQty,
```

**为什么不是"粘性 null"**：粘性 null 会让"补录的成本流水 ts 早于卖出"的账本也永远看不到已实现 ——
那是用"永久缺失"掩盖"可以算对的数"。逐笔判定下，重放按 `(ts,id)` 排序，成本流水在卖出之前时
`avgCost` 已知 ⇒ 该笔正常算出 150、计数为 0（见下表 ②）。**能算对的就算对，算不了的才 `—`。**

**为什么 realized 里不累加"假分量"**：`state.realized += (price − 0) × qty` 正是 625 的来源；
现在这类卖出只记股数、不进累加，所以 `realized` 这个数字里**永远不可能**混进按 0 成本算出来的部分
（即使展示层将来某处忘了判 null，也不会露出 625）。顺带：`dilutedPnl = floatPnl + realized` 这条既有恒等式在所有情形下仍然成立。

**文案（第 4 条断言）**：新增共用纯函数 `realizedUnknownNote(qty)`（`shared/model.ts`，界面与工具同句）：
「已实现不可算：其中 N 股在「成本录入前卖出」—— 那笔卖出应用时成本还是未录入的 0，(卖出价 − 0) × 数量 不是真实收益；
补录的成本流水时点若早于这笔卖出，重放即可算对」。
接在：行级已实现格、交易明细弹窗、`tradewatcher_portfolio` 的明细行与总览行（`另有 N 只的已实现为 —：共 M 股在成本录入前卖出`）。

**实测（真实 store 路径，`npm` 同一套写入操作）**：

| 场景 | realized | realizedUnknownQty | costUnknown | floatPnl |
| --- | --- | --- | --- | --- |
| ① `adjust(100,0)` → `sell(50,12.5)` → 补成本 9.5（**ts 晚于**卖出） | `null`（**不是 625**） | 50 | false（整仓不再是"未录入"） | 300 |
| ② 同上，但补成本流水 **ts 早于**卖出 | **150** | 0 | false | 150 |
| ③ 正常路径 `buy(100@10)` → `sell(50@12)` | 100 | 0 | false | 125 |

**新增断言 4 条**（`src/host/portfolio-cost.test.ts`，5 → 13 条）：①不得是 625 + 记股数 + 整仓守卫解除；
②数组顺序打乱、按 `(ts,id)` 重放 ⇒ 150；③正常路径 `realized=100`、计数 0（不被误伤）；
④文案断言（含"成本录入前卖出"、含股数、不含 Markdown 星号；整仓未录入时不误报）。

**边界**：同一毫秒的流水按 id 顺序重放（与既有 `sortLedger` 口径一致）；
补成本若是**分多笔**且只有部分在卖出之前，只有卖出之前那部分参与该笔的已实现计算 —— 这是"重放"的自然结果，符合直觉。

### 8.9d 收口 N1 / N5 / N2（验收发现，非阻塞）

**N1（可见性缺口，已修）**：面板级的 `stat('累计已实现', grand.realized)` 此前**没有**任何"不含 N 项"提示
（行内与 `tradewatcher_portfolio` 都有）—— 用户看到合计比预期少却不知道为什么，正是本项目最反对的"静默缺口"。

- 新增两个**共用纯函数**（`shared/model.ts`，与 `realizedUnknownNote` 同一处）：
  `realizedUnknownRows(rows)`（判据：`realizedUnknownQty > 0` 且 `costUnknown !== true`）与
  `realizedUnknownQtyOf(rows)`（"共 X 股"合计）。**客户端面板、行内提示、宿主工具调的是同一个函数**，
  三处不再各写一套 `filter/reduce` —— 分叉出的差额就是静默缺口。
- 分区不重不漏：`costUnknown` 的行已经在"成本未录入"提示里报过，因此这里排除它们，
  **两个提示合起来恰好覆盖所有 `realized === null` 的行**（断言锁定）。
- 面板级提示行（可聚焦 `tabIndex=0 + role=note + aria-label`，文案含共用句）：
  「累计已实现不含 N 只（名单）：已实现不可算：其中 X 股在「成本录入前卖出」…」。

**N5（弱断言，已修）**：`selftest.ts` 的 `摊薄盈亏 == 均价浮盈 + 已实现` 在 `realized === null` 时，
JS 会把 `null + x` 静默算成 `x`、`(nan ?? 0)` 又会把整条断言算成 `0 == 0` 而**假通过**。
现在显式分叉：三者都可算才验恒等式；有 `null` 时必须给出**明确原因**（`costUnknown` 或 `realizedUnknownQty > 0`），
并新增一条覆盖 null 的自检用例（`adjust(100, price:0)` + `sell(50,12.5)` ⇒ `realized===null`、`realizedUnknownQty===50`、盈亏同为 `null`）。
（写这条用例时顺手踩到一次真实行为：`adjust` 流水**缺 `price` 字段**会被判为坏流水跳过 ——
fixture 必须写 `price: 0`，与宿主「调整」只填数量时的写法一致。）

**N2（类型对齐，已修）**：`tools.ts` 的 render 类型断言从 `realized: number` 对齐为 `realized: number | null`（运行时无影响）。

**新增断言 2 条**（`src/host/portfolio-cost.test.ts`，13 → 15 条）："1 只 D1b + 1 只正常 ⇒ 只数/股数与行内事实一致"、
"分区不重不漏（A 走已实现提示，C/D 走成本未录入提示，B 不该被任何提示覆盖）"。
自检新增 1 组（null 覆盖用例）。

### 8.10 卖出校验可用数量
- 新增纯函数 `availableQtyAt(entries, posId, at)`（`store.ts`）：
  `可卖 = 该时点前已持有 − 同日该时点前买入`，时点取**这笔流水自己的 ts**（补录历史按那一天算）。
- 宿主 `trade()` 在 T+1 品种（`!isT0Secid(secid)`）上校验并**驳回**，错误信息给出可用量、持仓量与原因。
- `isT0Secid` 从 `host/portfolio.ts` **搬到 `shared/model.ts`**（只依赖 `marketOf`），
  避免 store ↔ portfolio 的循环依赖；`portfolio.ts` 处保留 re-export（既有 import 不受影响）。
- 客户端卖出表单同样拦截（并把"可用 X / T+1"写进预计回收那一行），不让人填完整张表才吃 400。
- 自检脚本原来在 A股上做"当天买、当天卖"，现改为 T+0 的 `1.510300`（当日买卖合法），
  并**新增两条自检**：A股当日买当日卖必须被驳回、昨日买入的部分今天可以卖。

**已知边界（写在代码注释里）**：同一毫秒的流水无法分辨先后，一律算作"之前"（宁可少算可卖量，也不放行券商端不存在的成交）。

### 8.11 no-source 归因方向
`em.ts` 增 `emUnavailableNow()`（熔断中，或最近 2 分钟内整批失败）+ `quoteProvenance(detail, { emDown })`（可注入）：
- 无备用源映射 **且东财可达** → `no-source`（"结构性缺失，重试无效"）；
- 无备用源映射 **但东财此刻不可用** → `transient` + note **"等东财恢复就会有（不是结构性缺失）"**；
- 有备用源映射 → `transient`（原行为）。

**验收**：`p0.test.ts` 新增一条（同一标的在 `emDown=false/true` 下的归因与措辞，含"不得再说重试无效"），既有那条断言不变。

### 8.12 replay 不吞异常流水
`store.ts` 新增 `replayPositionWithSkips(entries, posId)` → `{ state, skipped: [{id, verb, reason}] }`
（缺数量/价格、卖出超持仓等都逐条记原因；坏流水不影响后续流水；`replayPosition` 保留为薄包装）。
`derivePosition` 带上 `skippedLedger` 与 `skippedNotes`（前 3 条）；持仓行显示「流水 N 条未应用」徽标、
面板顶部给出可聚焦的明细行；`tradewatcher_portfolio` 的 render 与 `provenance.missing[]` 都会报出。

**验收**：`ledger-skip.test.ts` 3 条 + 工具实测（坏流水 → `⚠ 1 条流水未能应用… [bad1] 卖出数量超过持仓（持有 100）`，
出处行 `缺失 1（无此数据源 1 / 本次失败 0）`）。

### 8.13（未做）审计 P1-11：硬编码色与主题 token 脱钩
`quoteState.ts` 的四态色值、`IndustryHeatmap.cellColor` 的 rgb 字面量、异动呼吸底色、侧栏徽标四色、
两种琥珀色（`#e0a94a` / `#e8a33d`）仍在。**不在本批 12 项编号内**，且我这一批新增/改动的色值都沿用了既有常量，
没有扩大问题面。建议单独一轮处理（改法见 AUDIT-UI P1-11）。

## 9. 顺手修的相邻项（非本批编号，均已在结果里标注）

1. **两个从未定义的 CSS token**：`--tw-fg-dim` / `--tw-line` 只被 `var()` 引用、从未定义 ——
   无 fallback 的地方会因"无效值"退回初始色（浅色主题下出现近黑的图表轴线）。
   已在深浅两套主题里补为 `var(--tw-muted)` / `var(--tw-border)`（即审计 P2-2 的建议改法）。
2. **竞品站点"约 8 秒自动刷新"**：该数字未经实测核对（竞品官网自述 11 秒，审计 U-3），
   改为"自动刷新（频率以站点实际为准）" —— 不写没验证过的数。
3. **数字模糊清单补全**：把 `.tw-ytd` 显式加进 `data-blur=1` 的两条选择器清单（批一用的是"渲染时挂 `tw-num`"，
   两条都做上，未来任何位置出现 `.tw-ytd` 都不会漏糊）。本批新增的数字面（大盘页家数等）复用既有 `.tw-stat .v`，已在清单内。

## 10. 没做的项及原因

- **审计 P1-11 硬编码色**（见 §8.13）：不在本批编号内，改动面大（涉及四态色点语义），建议单独一轮。
- **审计 P1-1 列网格**（自选行数值列对齐）：不在本批编号内（批一报告里已登记为第二轮）。
- **审计 P1-12 原生 confirm/alert 改面板内对话框、P1-14 弹窗/抽屉对话框语义与焦点管理**：不在本批编号内。
- **审计 P1-6 四态色点读屏可达**（把状态并进卡片 aria-label）、**P1-7 其余图表读屏等价物**：不在本批编号内，
  本批只做了"缺失原因可聚焦"（第 7 项）。
- **`ui.tsx:147` 的旧词引用**：见 §8.8 的例外说明（改它会挂构建校验，需 Lead 先更新 build.mjs 片段表）。
- **浏览器内实测**：本机 `node_modules` 里没有 `react`（客户端 externals 由 web shell 提供）、也没有浏览器自动化，
  渲染路径仍然**一行都没真正执行过**（同批一）。第 6 项的多列/断点、第 5 项的焦点环、第 3 项的配色都需要装机目视复核。

## 11. `npm run check` 实测输出摘要

```
> dsh-tradewatcher@0.29.0 check        # typecheck → test → selftest → build
typecheck: tsc --noEmit 通过（无输出）
test:      ℹ tests 156 / ℹ pass 156 / ℹ fail 0   （Asia/Shanghai 与 TZ=UTC 各一遍）
selftest:  ALL HOST CHECKS PASSED (live probes soft)
build:     built lib/index.js + lib/client.js （v0.29.0，客户端片段校验通过：75 项）
```

新增断言 30 条（126 → 156）：`client/breadthView.test.ts` 4、`host/calendar.test.ts` 3、
`host/portfolio-cost.test.ts` 15（5 条 P1-10 + 4 条 D1 + 4 条 D1b + **2 条 N1**）、`host/trade-rules.test.ts` 4、`host/ledger-skip.test.ts` 3、
`host/p0.test.ts` +1（P1-7 归因）。另有自检新增 2 条（T+1 驳回 / 昨日买入可卖）。

## 12. 遗留风险

1. **README 需要同步的一处**：README 已写"宽屏（≥1500px）改用列头排序"，批二把断点降到了 **1080px**
   （列头 + 多列 + 收起段控三处一致）；README 在 Lead 的整合范围内，我未改。
2. **`columns` 多列的兼容性**：现代 Chromium/Firefox/Safari 均支持；如果宿主 webview 很旧，
   会退化为单列（不会坏，只是不会多列）。
3. **T+1 校验的边界**：同一毫秒的流水、以及"同一自然日内先买后卖"的历史补录（ts 粒度足够时能判对）
   已有说明；跨日补录按各自日期判定。极端情况下用户若确需录入券商端的当日回转（如 ETF 当日买卖），
   本身就是 T+0 品种，不受限制。
4. **日历同步失败后的重试节奏**：改为"失败冷却 5 分钟"（原先靠无条件写 `syncedAt` 节流）。
   冷却期内界面显示的是"上次成功同步"的数据 + 降级标记；`force=1`（用户点「同步」）不受冷却限制。
5. **`missing[]` 的一处措辞错配**：`tradewatcher_portfolio` 里"账本流水"这条用的 `why='no-source'`，
   而通用渲染把它印成「上游无此数据」—— 与紧跟的说明（"不是上游问题、重试无用"）读起来重复。
   语义正确（重试无用），措辞可优化；因通用渲染被多个工具共用，未在本批改动。
6. **四态色点仍是硬编码色值**（§8.13）：深浅主题下与面板红/绿略有差异，但不承载涨跌方向语义。
7. **~~面板级"已实现"缺口~~（已在 §8.9d / N1 修复）**：面板级提示与行内、工具共用同一份判定；
   `costUnknown` 与"已实现不可算"两个提示合起来覆盖所有 `realized === null` 的行（断言锁定不重不漏）。
   **N3/N4 已由 Lead 决定不做**：「调整」表单不加日期字段（时点说明保留为能力说明，缺口记 ROADMAP）；
   fx 分支 `?? 0` 写法不统一（数值等价）。
8. **~~补成本不回溯历史已实现~~（已在 §8.9c / D1b 修复）**：现在按"逐笔卖出时的成本是否已知"判定 ——
   成本未知期间卖出的部分记入 `realizedUnknownQty`、已实现给 `—` 并说明"其中 N 股在成本录入前卖出"；
   若补录的成本流水 ts 早于该笔卖出，重放即可正确算出（实测 150）。残留：`adjust` 仍不会**自动改写**历史流水的成本
   （这是刻意的：账本是追加式记录），要"算对"需要成本流水的时点确实在卖出之前。
