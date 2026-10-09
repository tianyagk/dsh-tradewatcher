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

> 批三（task-10）的图表 bug 修复另见 **§13**（本文件末尾）—— 那一批是装机后由用户反馈的独立缺陷，不属于本表 12 项。

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

## 13. 批三（task-10，本批）：图表 bug —— 国际指数/外盘商品的分时、五日与「拿不到没原因」

装机反馈：国际市场/大宗商品的日K与五日「加载失败」，分时被画成一条**假的平线**
（y 轴 `0.000/2000/4000`、成交量印 `1.00`）。Lead 已取到实机回包，逐条对应到四个根因。

### A（根因）缺失被编码成 0 —— 均价 / 成交量 / 成交额

**现象**：`GET /tradewatcher/trend?secid=122.XAU` 的 462 个点里 `avg`、`vol`、`amount` **全是 0**
（价格本身正常：390 个不同值、4274.05 ~ 4302.99）。0 被当成真实值进入 y 轴域 ⇒ 走势被压进 0~4303；
成交量窗格的 `max` 兜底成 1 ⇒ 印出 `成交量 1.00`。

**修法**：
- `shared/model.ts` 新增纯函数 `normalizeTrendSeries(points)`，两类字段**判定方式不同**：
  `avg` 逐点判（真实 VWAP 不可能 ≤ 0 ⇒ `!(v>0)` 就是"没有" ⇒ `null`）；
  `vol`/`amount` 按**整条序列**判（只要有一个 > 0 就说明该源确实提供，其余点照原样保留 ——
  安静的分钟真的是 0，逐点抹零会把"没成交"改成"没数据"）。
- 宿主三处分时来源（东财单日、新浪/腾讯多日、腾讯当日兜底）都过一遍归一；
  **并且在 `trendWithFallback` 的出口再归一遍**：LKG 是上一次运行落盘的文件，里面还存着修复前写进去的
  `avg: 0`（实机确认 `trends-lkg.json` 里 `122.XAU|1` 就是这种），只在解析处归一的话断网/休市走 LKG 时
  `curl` 仍会看到 0，等于没修。归一幂等。
- 客户端新增纯模块 `client/trendView.ts`：`trendScale()` 只由**有效**价格/均价（+昨收）决定坐标域；
  `isUsableAvg()` 连 `≤0` 一起挡掉（纵深防御：老宿主回 0 时图也不会被压扁）；
  `hasVolumeSeries()` 判"整条序列有没有量"。`kline.tsx` 的 `TrendChart` 改用它们，
  无量数据时窗格标题显示「该市场不提供成交量」而不是 `1.00`；均价线遇无效值断线。

**验收（断言 + 实机）**：`client/trendView.test.ts` 4 条 + 用实机抓到的 122.XAU 点做 fixture 的 3 条
（归一后不得再有 `avg=0`、域必须贴价格 4270~4310、`hasVolumeSeries` 为 false）。

### B 没有多日分钟源时，五日必须如实

**事实（按代码整理，不猜）**：多日分钟源只有**沪/深**（`fetchMultiDayTrend` → 新浪 5 分钟线 → 腾讯 5 分钟线；
`sinaSymbol` 只映射沪/深）。当日分时：沪/深/港股有腾讯分钟线兜底（`tencentCode`），
国际指数/外盘商品/期货**只有东财 trends2**（`em.ts` 里新增的"分钟源覆盖表"注释写全了这张表）。

**修法**：`shared/model.ts` 新增 `trendDayCount(points)`（按标签前 10 位去重）；
抽屉的「五日」档在 `≤1` 个交易日时**先显示一句**"五日不可用：该市场只有当日分时（下图仅显示当日）。
多日分钟源只覆盖沪/深，港股/国际指数/外盘商品/期货都没有 —— 不是本页故障。"（可聚焦、`role="note"`），
再照常画当日。**不再把当日静默当五日画。**

### C `trend/kline` 为 null 时必须带原因（no-source / transient 分清）

**现象**：`GET /trend?secid=100.HSI` → `{"trend":null}`；`GET /kline?secid=101.HG00Y` → `{"kline":null}`；
客户端只剩一句「该周期暂无数据（停牌/新股/接口限流）」，把"该市场本来就没有分时源"与
"东财这会儿被限流"混成同一句。

**修法**：
- `em.ts` 新增 `trendMissingReason(secid)` / `klineMissingReason(secid,klt)` / `detailMissingReason()`，
  口径与 `quoteProvenance` 一致（`no-source` = 上游结构性没有、重试无用；`transient` = 上游此刻不可达、等恢复）。
- **归因靠"本链路实际失败过"记账**（`noteUpstreamFailure('trend'|'kline'|'detail')` + 120s 窗口 +
  该链路主机是否全部熔断）：`fetchTrend`/`requestKlineRaw` 把上游异常吞在函数内部，路由层只看"东财整体是否不可用"
  会猜错方向 —— 实机出现过"明明上游挂了却判成结构性缺失/重试无用"的情形，已修正。
  `requestKlineRaw` 还区分"有回包但没这个标的"（no-source）与"一个成功回包都没拿到"（transient）。
- 路由：`/trend`、`/kline` 在 null 时回 `missing:[{what,why,note}]`；客户端 `ChartPayload` 新增
  `kind:'unavailable'` 变体承载它，抽屉把 `why` 与 `note` 显示出来（`no-source` 明说"重试无用"）。
- **`/detail` 保持原语义**：上游抛错仍是 `503 + retry-after`（熔断期快速失败、不要继续打上游 ——
  既有测试锁着这条），只在"上游可达但没有该标的详情字段"（返回 null 而不抛）时补 `missing`；
  客户端把「详情加载失败」补成"行情上游当前不可达（东财熔断/限流时如此）—— 稍等自动重试，
  频繁点「重试」只会加重限流"。

### D `/kline` 缓存键：老命名命中不被打断（并补断言）

把缓存文件名抽成纯函数 `klineCacheFileNames(secid,klt,fqt)`：
现行 `<secid>_<klt>_<fqt>.json`，**仅当 `fqt=0`** 才追加老命名 `<secid>_<klt>.json`
（v0.22.0 及以前一律 `fqt=0`，所以那**就是**不复权缓存）。指数/期货被 `normalizeFq` 归一为 0，
命中的正是这份老文件（实机 `100.HSI` 命中）。断言锁住：fqt=0 时两个名字都在、fqt=1/2 时**不得**含老名字
（前复权吃不复权缓存会在图上造成无解释的跳空）。行为零变化。

### 实机 before / after

```
# before（本机 127.0.0.1:3080，修复前）
trend?secid=122.XAU → {"points":[{"t":1790200800000,"label":"2026-09-24 06:00","price":4290.72,"avg":0,"vol":0,"amount":0},…]}   # 462 点，avg/vol/amount 全 0
trend?secid=100.HSI → {"trend":null}
kline?secid=101.HG00Y&klt=101&fqt=0 → {"kline":null}
detail?secid=100.HSI → HTTP 503 {"error":"fetch failed"}

# after（同一份**实际落盘**的 LKG —— 里面还存着旧进程写的 avg:0 —— 走新代码出口）
122.XAU → 462 点，avg 全为 null ? true ｜ vol/amount 全为 null ? true ｜ avg 里还有 0 吗 ? false
          首点 {"t":1790200800000,"label":"2026-09-24 06:00","price":4290.72,"avg":null,"vol":null,"amount":null}
          价格范围 4274.05 ~ 4302.99（不变）⇒ y 轴域回到价格域
trend?secid=100.HSI → {"trend":null,"missing":[{"what":"分时","why":"transient","note":"东财行情主机当前不可达（熔断/限流），而该标的没有腾讯分钟线兜底…等东财恢复即可，不是"该标的没有分时""}]}
kline?secid=101.HG00Y → {"kline":null,"missing":[{"what":"日K","why":"transient","note":"本地没有该周期的缓存，该标的也不在腾讯的 K 线覆盖内…等东财恢复即可…"}]}
detail?secid=100.HSI → 503 + retry-after（语义未变）；客户端文案已给出"上游不可达、稍后自动重试"
```

（宿主改动需重启 `dsh web` 才在跑着的实例上生效 —— 上面的 after 是把源码装进**进程内**路由跑出来的，
用的是同一份落盘数据，没有访问任何上游做探活。用户实例重启后即为该行为。）

**新增断言 12 条**（162 → 174）：`client/trendView.test.ts` 7（含实机 fixture 的 A 项）、
`host/chart-source.test.ts` 5（归因口径 + D 项缓存命名）。

**没做/做不到**：国际指数、外盘商品、期货**没有**多日分钟源（腾讯/新浪都不覆盖）——
这不是本批能修的，只能如实标注；五日档现在是"显示当日 + 明说不可用"。恒生的分时源同理：
实测 `100.HSI` 在当前环境拿不到，原因归为 `transient`（东财不可达）并在说明里点明"没有腾讯兜底"，
东财恢复后若仍无数据，会自动变成 `no-source`（同一套判定，不需要改代码）。

## 14. 批四（task-11）：五日本地归档+拼接，抽屉提示压成一行

装机反馈两条：① 抽屉顶部两条红长条把图挤掉了；② 用户要求"拿缓存的每日分时拼接出五日"。

### 一、UX：红色只留给故障，结构性限制进口径条

**规则**：红色 = 故障；结构性限制（该市场没有多日源）走**口径条那一行**，完整解释进 `title`/`aria-label`。
目标：图表上方**最多一行**常驻信息（原来两条横幅占两行）。

**三处文案 before / after（原文）**

**① 详情不可用**（`QuoteDrawer.tsx`，headerRows）
- before：
  `详情加载失败：行情上游当前不可达（东财熔断/限流时如此；行情详情只有东财一个上游）—— 稍等自动重试，频繁点「重试」只会加重限流` ＋「重试」按钮
- after（一行）：
  `⚠ 详情不可用 · 上游限流，稍后自动重试` ＋「重试」按钮
  长解释进 `title` / `aria-label`：
  `详情不可用：上游限流，稍后自动重试。行情详情只有东财一个上游：东财熔断/限流时它就拿不到。宿主已按熔断冷却快速失败并给了 retry-after，稍等会自动重试；频繁点「重试」只会让本机 IP 的限流更严重。`
- 另：宿主**可达但没有该标的详情字段**（no-source）时不是故障 ⇒ 不红、压成一行：
  `详情不可用 · 该标的无详情字段（重试无用）`（详细原因进 title/aria）。

**② 五日不可用**（`QuoteDrawer.tsx`，五日分支）
- before（单独一条横幅，与①合计两行红条）：
  `五日不可用：该市场只有当日分时（下图仅显示当日）。多日分钟源只覆盖沪/深，港股/国际指数/外盘商品/期货都没有 —— 不是本页故障。`
- after：**横幅删掉**，并入下面的口径条；完整解释进口径条的 `title`/`aria-label`（键盘也读得到）：
  `该市场没有多日分钟源（多日分钟源只覆盖沪/深：新浪 5 分钟线 → 腾讯 5 分钟线），所以五日只能显示当日 —— 不是本页故障。从本版起会按日归档本地分时，之后五日会逐日变长。`

**③ 口径条本身**（`caliberLine()`）
- before：`分时 · 不复权（分时序列无除权概念） · 截至 09-24 13:41`
  （五日档与分时档同一形态，没有任何"覆盖几天"的信息）
- after（按情形）：

  | 情形 | 口径条那一行 |
  | --- | --- |
  | 分时（当日） | `分时 · 不复权（分时序列无除权概念） · 截至 09-24 13:41`（不变） |
  | 五日 · 上游真实多日源（沪/深） | `五日 · 不复权（分时序列无除权概念） · 截至 10-09 14:59`（不加标记） |
  | 五日 · 本地拼接 3 天 | `五日 · 不复权（分时序列无除权概念） · 截至 10-09 09:01 · 本地拼接 3/5 天 · 缺 2026-10-07` |
  | 五日 · 本地拼接只有 1 天 | `… · 本地拼接 1/5 天（仅当日，从本版起累积）` |
  | 归档没写成功 | 上面任一行后追加 ` · 本次未归档（<原因>）` |

### 二、五日：本地按日归档 + 拼接（从本版起累积）

**为什么需要按日归档**：`trends-lkg.json` 的键是 `secid|ndays`，**每标的只留最新一次**，没有按日历史；
而真实多日分钟源（新浪/腾讯 5 分钟线）**只覆盖沪/深**。所以非沪/深市场的五日必须靠"每天归档一份"累积出来。

**1) 归档（新持久化，`src/host/trendArchive.ts`）**
- 路径：`<dataHome>/trends/<secid>/<YYYY-MM-DD>.json`（**单独目录**，不塞进很小很可读的主状态文件）。
- 落盘格式（紧凑列式，`label` 原样保留以便还原）：`{v:1, secid, day, updatedAt, points:[[t, price, avg, vol, amount, label], …]}`。
- **原子写**（`tmp` + `rename`）＋ 同 secid 写操作**串行化**（并发请求同时归档同一天时不会互相撕）。
- **幂等**：同一天重复取到 → 覆盖（后到的更完整），不会追加成两份。
- **保留策略**：`TREND_ARCHIVE_KEEP_DAYS = 12`（够五日 + 余量），写入时滚动清理；
  **只删自己目录里形如 `YYYY-MM-DD.json` 的文件**（用户自己放的文件不动）。
- **体积保护**：单日 > 512KB 或该标的总量 > 8MB ⇒ **不写**，并把原因带进回包（界面显示"本次未归档"）。
- **可关闭**：`prefs.trendArchive`（默认开，设置里在「截图/录屏」面板，与数字模糊同一处）。
- **坏文件/缺目录**：缺目录 = 还没归档过（不是错误）；坏文件进 `unreadable` 并带原因，
  **不影响同目录里其它日子**（实测用例覆盖）。

**2) 拼接（纯函数 `src/shared/trendStitch.ts`）**
- `stitchTrendDays(days, {limitDays, today})` → `{points, breaks, coverage:{have, missing, limit}}`。
- 日期升序；**同一天只保留一份**（后传入的覆盖）；空序列 / 点不足 2 个的日期**不计入覆盖**；
  非法的 `price`（≤0 / NaN）直接丢弃。
- `missing` 只列**工作日**里没有归档的日子（升序）。**本插件没有交易日历**，因此法定假日也会落在这里 ——
  与其猜"这天是假期"，不如如实列出（界面文案已写明这一点）。
- **三条不许**：不假装立刻有五日（缺的日子只列不补）、不用日K冒充分时（本模块只接触 `TrendPoint`）、
  不凭空补齐（`have`/`missing` 与 `points` 出自同一次调用）。

**3) 接线**
- `fetchTrend(secid, ndays, {archive})`：`ndays>1` 时先走**真实多日源**（沪/深）；拿不到就
  **本地拼接**：先读归档拼一次，若一天都没有则先取当日（顺带归档）再拼 —— 这样"今天"必然在内。
  回包带 `source:'local-stitch'` 与 `coverage`。
- 归档点在 `trendWithFallback` 的**出口**：上游、内存缓存、落盘 LKG 命中的都过一遍
  （用户要的"拿缓存拼接"必须连 LKG 那次也归档，否则永远只有今天）。归档失败只记 `archive.skipped`，**不影响取数**。
- 客户端五日档：有 `coverage` 就在口径条写明 `本地拼接 3/5 天 · 缺 …`；`have.length === 1` 时就是"仅当日"。

### 本机实测（进程内路由，未重启 dsh web、未探活上游）

```
# 预置 3 天归档（10-06/10-08/10-09，故意留 10-07 缺口）
GET /tradewatcher/trend?secid=122.XAU&ndays=5 →
  {"source":"local-stitch","coverage":{"have":["2026-10-06","2026-10-08","2026-10-09"],"missing":["2026-10-07"],"limit":5}}
  点数 9（三天连续拼接）· 首末点 2026-10-06 09:00 → 2026-10-09 09:01 · avg 里没有 0（拼接不造数）
GET /tradewatcher/trend?secid=101.SI00Y&ndays=5 → have=["2026-10-09"] missing=[] （今天只有 1 天）

# 归档在 LKG 命中时也会写（这是"从本版起累积"能不能滚起来的关键）
GET /tradewatcher/trend?secid=122.XAU&ndays=1（走落盘 LKG）→ 点数 217
  <DSH_HOME>/dsh-tradewatcher/trends/122.XAU/2026-10-09.json 已生成
  再请求 ndays=5 → {"source":"local-stitch","coverage":{"have":["2026-10-09"],...}} 点数 217
```

用户实例的行为：**今天第一个五日请求**看到 `本地拼接 1/5 天（仅当日，从本版起累积）`，
之后每打开一次（每天）就 +1 天，最多 5 天；归档保留 12 个交易日。

### 新增断言 13 条（174 → 187）

- `src/shared/trendStitch.test.ts` 6 条：升序拼接/日分隔位置/连续点；缺的工作日如实列出且周末不算；
  只有一天时 `missing` 为空（界面的"仅当日"靠它）；空序列与 1 点日期不计入；同日只留一份；
  非法日期/非法价格被丢弃。
- `src/host/trendArchive.test.ts` 7 条：往返（label/价格/缺失字段可还原）；幂等覆盖（一天一个文件）；
  滚动清理只保留最近 N 且**不碰非日期文件**；体积保护（单日/总量超限不写并报原因）；
  点数不足/secid 非法跳过；**坏文件与缺目录**（缺目录=还没归档；坏文件带原因进 `unreadable`，其余日子照常）；编解码判坏。

### 遗留风险 / 做不到

1. **今天不可能有五日**：归档从本版起累积，用户今天最多看到 1 天 —— 这是数据事实，界面已如实说明（"本版起累积"）。
   若某天没打开过该标的，那天就永久缺一格（`missing` 会列出来）。
2. **没有交易日历**：`missing` 里的法定假日与"漏归档"无法区分（如实列出，不猜）。
3. **归档量**：单标的最多 12 天 × 每天几十 KB；超限时**不写**并显示"本次未归档"，不会悄悄写满磁盘。
4. 需要**重启 `dsh web`** 才在跑着的实例生效（我没重启）；客户端改动需重建 bundle（已通过 75 项片段校验）。

## 15. 批五（task-12）：分时兜底顺序（LKG 不该压过活的备用源）+ 五日按天标注

### 一（P0）今天早上 9:38 还显示昨日整场

**实测（Lead 2026-10-09 09:38）**：`1.600519` 有 10-09 的实时点（腾讯分钟线），
而 `1.510300`（42 点）与 `1.000001`（231 点）**全是 10-08**、都带 `staleAt` —— 差别只在"有没有昨日 LKG"。

**根因**：`em.ts` 的 `trendWithFallbackRaw` 两个分支都把**过期的 LKG** 排在**活的腾讯分钟线**前面 ——
分支 A（上游返回 null）直接 `lastGoodTrend ?? data` 根本不试腾讯；分支 B（上游抛错）也是 LKG 命中就 return。
于是"有昨日 LKG 的标的"永远显示昨天，"恰好没有 LKG 的标的"反而实时。

**修法**：非休市定稿路径改成 `上游 → 活的备用源（腾讯分钟线）→ LKG`，
决策抽成**纯函数** `pickTrendFallback({upstream, backup, lkg, today})`（`src/host/em.ts`，导出）：
判据是**数据是不是今天的**（`trendSessionDay()` = 序列最后一个点所属交易日；跨日即 `expired`），
而不是"有没有 LKG"。缓存 TTL 按来源区分（上游 60s / 备用源 30s / LKG 20s 且不享受 peek 宽限）。
休市定稿分支（`isSettledOffline`）**一行未动**。
兜底回 LKG 时回包带 `sessionDay`，界面据此写清日期。

**界面文案（本次只动这一处，避免与并行文案精简任务撞车）**：
`cacheNoteOf` 的 ` · 显示上次成功数据（本次刷新失败）` → ` · 显示上次成功数据（2026-10-08 11:08）`
（日期时间取自序列最后一个点的 `label`，跨日以 `sessionDay` 为准 —— 不造时间）。
口径条那行的其余部分与别的提示一律未动。

**三条断言实测**（`src/host/trend-fallback.test.ts`，均可构造：`TrendOptions` 支持注入 `now` / `upstream` / `fallbackSource`）：

```
✔ 纯决策：上游没有数据时，先用活的备用源，绝不能被过期的 LKG 挡住
✔ 纯决策：上游与备用源都没有 ⇒ 才吃 LKG，并把它的交易日交出来（跨日即过期）
✔ trendSessionDay：交易日取自序列最后一个点的 label
✔ ① 上游抛错 + 有昨日 LKG + 备用源可用 ⇒ 返回备用源的当日数据（staleAt 为空）
✔ ② 上游抛错 + 有昨日 LKG + 备用源也失败 ⇒ 回 LKG，且带 sessionDay（等于 LKG 那天）
✔ ③ 休市定稿 ⇒ 仍复用本地，且不去打上游/备用源（不许被这次改动破坏）
```

**进程内 before / after**（喂**实机落盘的 LKG**，未重启 dsh web、未探活上游）：

```
before（跑着的实例，2026-10-09 09:38）
  1.600519 → 42 点里 10 个点，日期 2026-10-09，staleAt=null      ← 活的腾讯分钟线
  1.510300 → 42 点全是 2026-10-08，staleAt=1791425437428         ← 昨天的整场
  1.000001 → 231 点全是 2026-10-08，staleAt=1791442178098        ← 昨天的整场
after（进程内路由，同样喂那份 LKG）
  1.510300 → 点数 15 · 日期 2026-10-09 · staleAt null · cached false
  1.000001 → 点数 15 · 日期 2026-10-09 · staleAt null · cached false
② 备用源也挂掉（注入 fallbackSource=null）
  1.512660 → 点数 99 · 日期 2026-10-08 · staleAt 1791428851341 · sessionDay 2026-10-08
             ⇒ 界面写「显示上次成功数据（2026-10-08 11:08）」
```

### 二 五日图看不出"天"

**现状**：只在**内部**日边界画虚线 + 图内左上角 9px 小字，`brk <= 0` 被跳过 ⇒ 第一天永无标签，
底部轴只有首末两个时间戳（用户说"只有横向四分格"）。

**修法**：新增纯函数 `trendDayAxis(points, maxLabels)`（`src/client/trendView.ts`）：
- 按 `label` 前缀切出每天的区段（`startIndex/endIndex/day/text`），**只有 1 天或 0 天返回空** ⇒ 走原时间轴；
- 标签是区段的子集：超过可容纳数时**均匀抽样且首末必留**；
- 标签文字一律取该天第一个点 `label` 的 `MM-DD`（**不造日期**；label 太短就留空）。

图表（`kline.tsx` TrendChart）：
- 底部轴改为**按天标注**（`x = (xAt(startIndex) + xAt(endIndex)) / 2`，`textAnchor='middle'`，居中于各自区段）；
- 日分隔线保留并**从主图延伸到底部轴**（`y2 = axisLabelY - 10`），且画在各窗格之后（不被成交量柱盖住）；
- 图内左上角那条 9px 小字**删掉**（被底部按天标签取代，属本项范围内的替换）；
- 单日（分时）档不受影响：`trendDayAxis` 返回空 ⇒ 仍是最左/最右两个时间戳；
- 容量按宽度算：`max(2, min(8, floor(内宽/56)))`。
- 数字面未新增（SVG 轴标签本就不在 `data-blur=1` 的 HTML 选择器清单覆盖范围内，与既有轴标签一致）。

**四条断言实测**（`src/client/trendView.test.ts`）：

```
✔ 按天轴：3 天 3 个标签，且标签落在各自区段中间（第一天也有）
✔ 按天轴：只有 1 天（或空）⇒ 返回空，走原来的时间轴
✔ 按天轴：天数超过可容纳数时均匀抽样，且首末必留
✔ 按天轴：标签文本等于该天点里的 label 前缀（不许自己造日期）
```

### 新增断言 10 条（187 → 197）

`src/client/trendView.test.ts` +4（按天轴四条）；`src/host/trend-fallback.test.ts` +6（兜底顺序三条 + 纯决策两条 + `trendSessionDay` 一条）。

### 遗留风险

1. 宿主改动要**重启 `dsh web`** 才在跑着的实例生效（我没重启）；上面的 after 是进程内路由跑出来的。
2. `trends-lkg.json` 里那份**昨天**的 LKG 仍在盘上（它是"上次成功数据"，不是错误）；
   现在它只会在**上游与腾讯都拿不到**时被用，并且必须带 `sessionDay` 显示日期。
3. 五日的"按天标签"依赖点里的 `label`：若某个源给出异常 label（缺日期前缀），该天的标签会留空
   （宁可不标，也不造一个日期）。

## 16. 批六（task-14）：界面文案精简（按 AUDIT-COPY 清单）+ 空值不占位

输入是 [`AUDIT-COPY.md`](AUDIT-COPY.md)（规则 R1–R5 / 必修 6 / 应修 20 / 保留 10 / 边界 7）。本批做：**必修 6 全部** + 应修里的 S18 / S20 / S13 / S19，外加 S1 / S2 / S4（S4 是"两处口径互相打架"的正确性问题）。

### 一、必修 6：逐条 before → after（原文）

**M1 可用数量**（`PortfolioPage.tsx` 的「可用（可卖）」meta）
- before（**每只持仓必出两个分支之一**）：`T+0：当日买入当日可卖（ETF/LOF、港股、美股等）` ／ `T+1：今日买入 0 份当日不可卖，故可用少于持仓`（今日无买入时是**假话**）
- after（`portfolioMeta.availableLockNote`）：`availableQty === qty` → **整条不渲染**；确有不可卖 → `今日买入 200 份不可卖`（≤14 字）
  口径进该行的 `title`：`T+1：今日买入的部分当日不可卖，所以"可用（可卖）"可能少于持仓` ／ `T+0：当日买入当日可卖（ETF/LOF、港股、美股等）`

**M2 YTD 基准**（同行的「标的年初至今」meta）
- before：`基准 2026-01-02`（每只都出）／ `本轮未算（悬停看原因）`（每个缺 YTD 的行都出）
- after（`portfolioMeta.ytdBaseNote`）：常态基准 → **不渲染**（口径+基准+复权口径都在既有 `ytdTooltip` 里）；
  仅 `baseKind='listing'` → `上市首日 2026-06-30`（**必须留**：否则会被读成"年初至今"而高估）；`本轮未算…` → 删

**M3 面板级 YTD 摘要**
- before：`年初至今（YTD）：3 项缺数据：日线本次取不到（上游限流或超时）—— 上游暂时不可达，稍后自动重试`（常驻）
- after：**删除**（缺失原因由行级 tooltip 承担，R2 只留一处）

**M4 费用占比**
- before：`尚无成交，占比不可算（不用 0 顶替）` ／ `占累计成交额 56.70万 的 0.000%`
- after（`portfolioMeta.feeShareNote`）：`fees = 0` → **整条不渲染**（值列已有 `0.00`）；`fees > 0` → `占成交额 0.021%`；
  口径进 `title`：`费用 ÷ 累计成交额（买卖双向，含佣金/手续费）`

**M5 集群①「0 会被读成…」**（audit 记 11 处 → 可见字符串现为 **1** 处）
- before：`板块涨幅与 α 显示 — 而不是 0：0 会被读成"没涨没跌"，那是错的；下一次行情轮询会自动重试。`（还有 YTD 失败行、板块行 tooltip/aria 各一遍）
- after：`板块涨幅与 α 本次未取到：下一次行情轮询会自动重试。` / `YTD 本次未取到 · <error>（已取到的保留上一次结果）` / `板块当日涨幅未取到：…（稍后随行情轮询重试）`
  「为什么不能显示 0」只在 `UPDOWN_MISSING_NOTE`（`breadthView.ts`）保留一次；`breadthCells.reason` 也只剩原因

**M6 集群②「三源都没有可用价格」**（audit 记 7 处 → 可见字符串现为 **1** 处）
- before：`东财、腾讯、新浪三个源都没有返回该标的的可用价格。若为期货主连/商品合约，请核对代码大小写（…）。`（行内 title、aria、顶栏 title 各写一遍；持仓页还多一句"按成本口径暂以 0 计"）
- after：全文只在 `quoteState.ts` 的 `NO_SOURCE_TITLE` 留一处；其余引用常量或 `NO_SOURCE_LABEL`（`无行情源`）。
  顶栏 title：`其中 N 个无行情源；这些卡片显示 —，明细见自选或持仓页` + 常量全文

**S7（= 必修 6 第 5 条）大盘页口径行**
- before（常驻 ≈90 字）：`数据时刻 09:41 · 来源 em · 主力净额＝超大单＋大单净流入（上游口径，仅东财提供）；占比＝净额 ÷ 成交额` +（占比排序时）`。注意：占比排序只在「本页 40 条」内重排 —— 上游按净额取前 40，本插件没有"按净占比的全市场排行"这一口径，因此不把它呈现成全市场排行。`
- after：`数据时刻 09:41 · 来源 em · 口径 ⓘ`（+ 占比排序时 ` · 占比排序仅本页 40 条内`）；全文进该行 `title`

### 二、本批做的应修项

**S13 云图徽标**：before 两种分支都出（`该站：红=跌 绿=涨（与本面板相反）` ／ `（与本面板当前设置一致）`）→
after **只在相反时**出 `该站红跌绿涨，与本面板相反`（一致时不渲染），完整口径进 `title`（K7 未动）。

**S18 已实现不可算**（同句 80 字曾在面板 + 行内 + 弹窗各一遍）→ 行内/弹窗改成 `已实现不可算：50 股成本录入前卖出`
（全文进 `title`）；80 字全文只留**面板级一处**（`realizedUnknownNote` 未改，K5 的"原因本体"仍在）。

**S19 宿主两档措辞**：新增 `MISSING_TIER_ADVICE = { transient: '上游暂时不可达，稍后自动重试', 'no-source': '结构性缺失，重试无用' }`（`shared/model.ts`），
`em.ts`（quoteProvenance / trend / kline / detail 共 9 处）、`ytd.ts`、`calendar.ts`、`portfolio.ts` 的缺失说明全部改用它 + 各自"原因对象"半句
（如"该标的没有腾讯分钟线兜底（腾讯只覆盖沪/深/港股）"）。两档仍**可区分**（K1），"等东财恢复/该等谁"作为原因对象保留。

**S20 补成本指令**：`…用「调整」补成本价` 4 处 → **1 处**（行级成本格的 `title`）；面板级提示与行内 aria 只留说明，不再重复指令。

**S1 / S2（额外做的）**：面板级提示压短 ——
`有 3 只持仓未录入成本（名1、名2）：市值照算，但…拿 0 当成本会把全部市值算成一笔盈利。用行内「调整」补上成本价即可。` → `3 只未录入成本：市值照算，盈亏 —`（长解释进 `title`）；
`有 2 条流水未能应用（账本里有、持仓快照没算进来）：…请用行内「交易明细」核对这几笔（数量/价格缺失，或卖出超出当期持仓）。` → `2 条流水未应用：用「交易明细」核对`（逐条原因进 `title`）。

**S4（额外做的，正确性）**：持仓行无价时 title 原写 `…；市值/盈亏在无价时按成本口径暂以 0 计`，与徽标 `N 只无行情源 · 总额不含` **互相矛盾**
（实际不计入总额）。已删掉"按 0 计"半句、引用 `NO_SOURCE_TITLE`；徽标文案**保持 `总额不含`** ——
`build.mjs` 的 75 项片段里锁着这个词（清单建议的 `未计入总额` 会挂构建，未采纳，见下）。

### 三、自查计数（脚本：剥块注释/行注释后，只统计字符串内的出现）

```
"0 会被读成"            可见 2 处 → host/tools.ts×1（**给 agent 的工具说明**，非界面）+ client/breadthView.ts×1（保留的那一处）
"不用 0 顶替"           可见 2 处 → 都在 host/tools.ts（同上，非界面）
"三个源都没有返回该标的"  可见 1 处 → client/quoteState.ts（NO_SOURCE_TITLE，唯一保留）
"补上成本价"            可见 1 处 → client/PortfolioPage.tsx（S20 的唯一一处）
"故可用少于持仓"         可见 0 处（M1 的假话已消失）
"本轮未算"              可见 0 处
"尚无成交"              可见 0 处（M4 的空值句已消失）
"T+0：当日买入当日可卖"   可见 2 处 → 行内 title（口径本体，保留）+ 卖出弹窗提示（非常驻）
"稍后自动重试"           可见 7 处 → shared/model.ts×1（常量本体）+ tools.ts×1（agent 说明）+ CalendarPage×2、QuoteDrawer×3
                        （客户端两处属 S17/S16，本批未做；QuoteDrawer 那两处是 K1/K2 要求保留的两档区分与"重试会加重限流"）
```

### 四、新增断言与实测

`src/client/portfolioMeta.test.ts`（4 条，锁住"空值不占位"与 listing 基准）：

```
✔ M1 可用数量：可用=持仓时**不出现**（今日买入 0 份那句话是假话）
✔ M1 可用数量：确实有不可卖部分时给一句短的（≤14 字，不含口径）
✔ M4 费用占比：未录费用（fees=0）时整条不出；有费用才给占比
✔ M2 YTD 基准：常态基准不常显（进 tooltip），年内上市的"上市首日"必须出现
```

同步改动的既有断言（措辞收敛，语义不变）：`breadthView.test.ts`（缺失原因只验"未取到"）、
`calendar.test.ts`（`稍后自动重试`）、`p0.test.ts`（no-source 一档统一为 `重试无用`，原为 `重试无效`）。
测试总数 197 → **201**。

### 五、本批**没做**的应修项及原因

- **S3 / S6（部分）**：与 M5/M3 同簇的重复已在 M5 里收敛，剩余的 `title`/`aria` 双写留待下一轮（改它们要逐处确认读屏路径）。
- **S5**：已做（watch 页 YTD 摘要压成 `YTD 缺 N 项`，原因进 title/aria）。
- **S8 / S9**（大盘页分位样本、快照天数）：属"压缩显示"而非去重，且改完要重新对账分位口径，单独一轮做更稳。
- **S10 / S11**（热力图口径句、无成交额块数）：涉及"面积口径"表述，`面积＝成交额` 是 build 片段；留到与热力图一起改。
- **S12 / S14**（第三方页操作提示、超时三行）：低风险但收益也小；且 S14 的"最后成功加载时刻"与 K8 徽标有交叉。
- **S15 / S16**（抽屉口径 tooltip、页脚"延迟行情"）：S15 的 tooltip 与口径条正文是同源解释，删之前要先确认读屏路径；S16 涉及四态徽标（K8）的措辞统一。
- **S17**（日历同步失败两行）：与并行审计的下一步有关，且 `手动事件不受影响` 属可操作信息，压之前要先想清楚放哪。
