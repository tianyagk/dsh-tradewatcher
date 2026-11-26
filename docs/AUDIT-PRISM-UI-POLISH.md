# 棱镜 · 决策流 / 自动做T 弹窗 UI 精修审计（AUDIT-PRISM-UI-POLISH）

> **只读审计，不改代码。** 本轮只新增本文件：未触碰 `src/**`，未 commit，未重启。
>
> 基线：**v0.243.2（`752a411`）**，`npm run check` **2062 / 2062**（任务给定；审计期间工作树被外部会话改动，故未重跑，避免把别人的半成品当成基线）。
>
> 审计对象：`src/client/PrismPage.tsx`、`prismDeskMid.ts`、`prismDeskSide.ts`、`styles.ts`（含 `.tw-ad-autot-*` 弹窗样式）。
> 关联宿主路径（只为回答「同源 / 状态一致」）：`src/host/prismRoutes.ts`（`autoTPayloadOf`）、`src/host/prismAccount.ts`（T 结算）、`src/host/prismStore.ts`（设置持久化）。
>
> ⚠ **基线变动（非本审计）**：审计开始 `git status --porcelain` 为空；审计期间外部会话先修改了 `src/client/styles.ts`（11:44，正好在改 `.tw-ad-ev-r .v` 的宽度/`line-clamp`），随后于 **11:58 提交 `ec501ff`（v0.244.0）**，包含「① 有成交的 T pair 锁定保留 ② 14:50 按净差额回补 ③ autoT 单账本 ④ 决策流长文本换行」，并新增 `docs/AUDIT-AUTOT-HOST.md`。**本文所有行号与「现状」以 `752a411`（v0.243.2）为准**；§二 末尾附「v0.244.0 已修 / 未修」对照，避免把已修的当成未修。
>
> 方法：① 逐行读码；② 用本机真实数据（`~/.dsh/dsh-tradewatcher/prism-*.json`，2026-11-26 11:30 快照）跑纯函数；③ 用无头 Chromium（Chrome for Testing 148）加载 **v0.243.2 原样 `TW_CSS`** 做版式实测（卡宽 390 / 890 / 1300；弹窗 1024×768 / 1280×800 / 1440×900 / 920 / 860 / 560），不是「看代码猜」。

---

## 一、结论（一行）

**7 条 P1、13 条 P2，合计 20 条。** 一句话：**「自动做T」唯一的人工操作（逐只开关）重启即丢**（`loadSettings` 不读 `autoT`），**弹窗在验收尺寸下会把底部面板裁掉**（`grid max-height` + `body overflow:hidden`），**做T tab 的 50 条里 46 条是已撤单且不显示撤单原因**，**弹窗「Agent 判断」取的是最旧计划、今日流水结构性永远为空**；用户报的 ORDER「依据」被切，**不是 `white-space`（已是 normal）、也不是卡片 `max-height`**，而是「列表折叠裁切 + 3 行 `line-clamp` + 展开按钮落在视野外」三层叠加（其中的「宽度计算」一层已在 v0.244.0 修掉，见 §二 末尾对照）。

---

## 二、问题清单

| # | 严重度 | 问题 | 证据（文件:行） | 修法 |
|---|---|---|---|---|
| **P1-1** | **P1** | **自动做T 的逐只开关不持久化：重启后全部丢，入口显示「已关闭」、表格全部「未开启做T」，但 T 计划/T 委托还在。** 这是弹窗里**唯一**的人工操作，`patchSettings` 能写盘，`loadSettings` 却根本不读 `autoT`。 | `src/host/prismStore.ts:118`（`loadSettings`）；`:119`（磁盘类型里没有 `autoT`）；`:149-166`（重建 `settingsValue` 时没有 `autoT`）；`src/shared/prism.ts:46`（字段本身存在）；`src/host/prismRoutes.ts:267`（`cfg = settings().autoT` ⇒ `undefined`）、`:1017`（`current` 恒为默认值） | `loadSettings` 的磁盘类型加 `autoT?: unknown`，按 `{ enabled: boolean, positions: Record<string, {enabled: boolean}> }` 严格校验后写回 `settingsValue`（非法键逐个丢弃）；补一条「写盘 → 新建 store → `init()` → `settings().autoT` 仍在」的测试。**这是「保存成功 ≠ 重启后还在」的又一例，且直接影响唯一人工开关。** |
| **P1-2** | **P1** | **弹窗在验收尺寸下裁内容：`.tw-ad-autot-grid` 只给了 `max-height:34vh`，行高仍是 auto，两个 panel 比 grid 高；`.tw-ad-autot-body` 又是 `overflow:hidden` ⇒ 超出的面板内容被 body 直接裁掉，且没有任何滚动条。** 设计验收 #1 要求 1440×900 / 1280×800 / 1024×768「无横纵滚动条」，现状是「无滚动条 = 内容看不到」。 | `src/client/styles.ts:1416`（body `overflow:hidden`）、`:1463`（grid `max-height:34vh`，无 `grid-template-rows`/`overflow`）、`:1464`（panel `min-height:0;overflow-y:auto`，但 panel 盒子被行高撑到内容高，滚动永不触发，实测 `panel.clientHeight == scrollHeight`）；`docs/DESIGN-PRISM-AUTOT-MODAL.md` §5 验收 #1 | `.tw-ad-autot-grid{grid-template-rows:minmax(0,1fr);overflow:hidden}`（一行），让行高被 34vh 限住、panel 真正获得可滚高度；`>860px` 的 body 再加 `overflow-y:auto` 兜底。**实测：加这一行后 1024×768/1280×800/1440×900 的 `body.scrollHeight == body.clientHeight`，两个 panel 的 `scrollHeight > clientHeight` 且 `overflow-y:auto` 生效。** |
| **P1-3** | **P1** | **「做T」tab 混入大量历史已撤单：50 条里 46 条 `cancelled`、4 条 `filled`、0 条 `pending`；卡片「依据」只写「自动做T·买入/卖出腿」，**撤单原因（后续研判撤销 29 / 手动撤销 13 / 做T开关关闭 3 / 每轮重审计 1）完全没有展示**。列表无任何「活跃/已撤」过滤。** | `src/client/prismDeskMid.ts:565-586`（所有 status 一律 push）；`:576`（只按 `channel` 分 tab）；`:579`（`basis` 取 `reason`，T 腿的 `reason` 是固定串，`skipReason`/`cancelReason` 被顶掉）；`:627-630`（计数含全部状态）；`:643-647`（窗口只截断、不过滤）；真实数据：`prism-orders.json` 中 `channel:autoT` 50 条，`{cancelled:46, filled:4, pending:0}` | 见 §四：**不改数据契约**的最小方案——`DeskFlowEntry` 增 `cancelled?: boolean`（纯客户端派生），`FlowOrderInput` 增可选 `cancelReason?: string`，`flowWindowOf` 增 `hideCancelled`；做T tab 默认开启「隐藏已撤单」，计数仍显示总数 50、旁边补「活跃 4 / 已撤 46」。**注意：若按字面做「仅看活跃（pending）」当前会得到 0 条空列表，不建议。** |
| **P1-4** | **P1** | **弹窗「Agent 今日判断」和表格判断列取的是「最旧」的非中止计划，不是最新计划。** 同一标的今天最多 8 条计划（1.601398），`find` 从旧到新返回第一条 ⇒ 1.588000 显示 09:48 的 `1.236 ↔ 1.248`，而 10:24 的 `1.245 ↔ 1.265`（`waiting`，当前有效）不显示。用户会按过期价位判断做T。 | `src/client/prismDeskSide.ts:580-584`（`list.find(status!=='aborted')`，数组按写入顺序=旧→新）；`:587-590`（focus 同病）；`:608`（表格判断列走同一函数）；实测数据：1.588000 三条计划 `[09:48 1.236/1.248 waiting, 09:54 1.236/1.250 waiting, 10:24 1.245/1.265 waiting]` | 取「按 `at` 降序的第一条非 aborted」，`autoTFocusPlanOf` 同理；补测试「同标的多计划 ⇒ 取最新非 aborted」。 |
| **P1-5** | **P1** | **弹窗「今日流水」结构性永远为空；计划状态与做T tab 不一致。** ① `prism-autot.json.trades` **全仓没有任何写入者**（结算只 push `results`），`autoTFlowOf` 永远拿到 `[]`；② `autoTPayloadOf` 的 `alive` 把「一腿 filled」也算存活 ⇒ 一腿成交+一腿撤单的计划仍显示 `waiting`（「待触发」），入口橙点「有未完成 T 单」却 0 条 pending；③ 真实数据 25 条计划里 22 aborted / 3 waiting，3 条 waiting 全部是「一腿已成交、另一腿已撤单」的裸腿。 | `src/host/prismRoutes.ts:275-282`（`alive` = 任一腿 `pending` 或 `filled`；`trades = file.trades.filter(...)`）、`:310`；`src/host/prismAccount.ts:1930-1973`（只 `file.results.push`，从不写 `trades`）；`src/client/prismDeskSide.ts:478-481`（unfinished 只看 plan.status）、`:675-714`（flow 依赖 `today.trades`）；交叉引用 `docs/AUDIT-AUTOT-HOST.md` #17 已独立确认「trades 从不写」 | 成交（含 forced）时写 `AutoTTradeRec`；`alive` 改为「两腿都 pending/filled」或一腿 filled+另一腿 cancelled ⇒ `open-filled`（不是 waiting）；计划状态以委托实际状态回写；UI 侧在流水空态写明「宿主未写 trades」而不是「今日无做T流水」。 |
| **P1-6** | **P1** | **决策流 ORDER 卡「依据」被切（用户报告）——根因不是 `white-space`、不是卡片 `max-height`，是三层叠加：① `.tw-ad-feed-list` 是固定高度的内层滚动容器，在任意滚动位置把最后一张卡从中间切断；② `.tw-ad-ev-r .v.is-clamp` 是 3 行 `line-clamp` + `overflow:hidden` 硬裁；③ 「展开」按钮在卡片底部，卡在折叠处时按钮一起被裁掉 ⇒ 视觉上就是「依据只剩两行、第三行没了、也没法展开」。另有一个**同类宽度隐患**（**v0.244.0 已修**）：v0.243.2 的 `.tw-ad-ev-vw` 没有 `width:100%`，`.v` 按 fit-content 排版（实测 1300px 卡宽下 `.v` 只有 1009px，比可用宽度 1248px 窄 19%），长文本会更早撞上 3 行上限；新版本复测为 1211（=列宽），但列表折叠/展开按钮仍在，故本条仍成立。 | `src/client/styles.ts:1258`（feed-list `flex:1 1 auto;min-height:0;overflow:auto`）、`:1545`（≤1100px 再叠 `max-height:56vh`）、`:1283`（`.v` 已是 `white-space:normal`，**不是原因**）、`:1284`（`-webkit-line-clamp:3;overflow:hidden`）、`:1285`（`align-items:flex-start`，无 `width`）；`src/client/PrismPage.tsx:129-140`（clamp 与「展开」按钮）、`:1045-1048`（60 条截断）；实测见 §三 | 见 §三：`.tw-ad-ev-vw{width:100%}` + `.tw-ad-ev-r .v{display:block;width:100%;max-width:100%;word-break:break-word}`、`.tw-ad-ev-r{align-items:start}`；列表加底部渐隐 + 常显细滚动条（或去掉内层滚动，让中栏列成为唯一滚动容器）；「展开」按钮放到 clamp 文本上方/卡片右上角常驻，避免随卡片底部被裁。 |
| **P1-7** | **P1** | **弹窗可访问性：没有焦点陷阱、没有焦点归还；11 个 `role="switch"` 的可访问名全部是同一句 title（不区分标的）；入口按钮没有 `aria-expanded`。** | `src/client/PrismPage.tsx:230-232`（只 `focus()` 第一个按钮，无 trap/restore）；`:326-334`（switch 只有 `title`，无 `aria-label`/`aria-labelledby`）；`:1025-1029`（`aria-haspopup="dialog"` 无 `aria-expanded`）；对照 `src/client/ui.tsx:52-107`（通用 `Modal` 已有 trapTab + 焦点归还 + Esc 栈） | 直接复用 `Modal` 的焦点逻辑（或抽 `useDialogFocus(ref)`）：打开时记录 `document.activeElement`、关闭时归还；`onKeyDown` 做 Tab 循环；每个 switch 加 `aria-label={`${row.name} 自动做T`}`；入口加 `aria-expanded={autoTOpen}`。 |
| P2-1 | P2 | **金额/百分比格式三套口径**：做T胜率 1 位且去尾零（`66.7%`），绩效胜率 2 位（`66.67%`），价差 2 位无符号（`1.01%`），其余金额统一 `signedMoneyOf`（2 位、千分位、带符号）。 | `src/client/prismDeskSide.ts:511-518`（`toFixed(1)` + 去 `.0`）；`:200-214`（`signedPctOrDash` 2 位）；`:630-633` + `PrismPage.tsx:348`（价差 `toFixed(2)%`） | 统一成 `signedPctOf(v, 2)`（胜率不带 +）或明确「胜率 1 位」为产品口径并在所有出现处一致；价差写 `+1.01%` 或文案标注「均为正值，不显示 +」。 |
| P2-2 | P2 | **≤860px 隐藏「结果」列后，结算金额在窄屏完全消失**（桌面端也只有多计划时拿不到金额）。 | `src/client/styles.ts:1497`（`.tw-ad-autot-col-result{display:none}`）；`PrismPage.tsx:322-325`（结果只在这一列） | 窄屏把结果并入名称下方（类似 `.tw-ad-autot-qty-mobile`），或保留一列「结果」只显示徽标；不要把唯一金额出口藏掉。 |
| P2-3 | P2 | **表格 11 行只显示约 6 行，滚动条被隐藏**（`scrollbar-width:none` + `::-webkit-scrollbar{display:none}`），用户不知道还能往下滚；设计验收 #1 的「无滚动条」被实现成「隐藏滚动条」。 | `src/client/styles.ts:1425-1426`（tablewrap）；实测 1024×768：`wrap.clientHeight 286 / scrollHeight 532`，`scrollWidth == clientWidth`（**无横向溢出，列宽实现正确**） | 至少给 `scrollbar-width:thin` + 6px `::-webkit-scrollbar`；或在表格底部加「还有 N 只持仓」提示。 |
| P2-4 | P2 | **多计划时结算金额不可拆，结果列只有状态标签，且 title 不解释「为什么没有金额」**（`autoTPlanSettlementOf` 要求 `plans.length===1`；今天 25 条计划 ⇒ 永远 null）。 | `src/client/prismDeskSide.ts:656-660`；`PrismPage.tsx:296-298`（`settle===null` 时 title 回落为 `result.title`） | 结果列 title 在 `plan.status==='done' && settle===null` 时写「今日多计划，宿主未提供单轮净额」，不要只写「两腿都成交」。 |
| P2-5 | P2 | **`autoTFlowOf` 把 `forced` 腿标成「T·失败」**：`forced` 是 14:50 强制回补，不是失败；真正的失败是回补没做成。 | `src/client/prismDeskSide.ts:682-686`（`failure = t.forced`）；类型注释 `:333` | 区分 `forced`（强制回补）与 `failed`（回补失败，宿主目前无此字段）；文案改「T·强平」/「T·失败」两种。 |
| P2-6 | P2 | **「最小化」不提交开关草稿，胶囊也不提示有未保存改动**：用户改了开关 → 点「—」→ 以为已保存，实际上只有关闭弹窗才会 POST。 | `src/client/PrismPage.tsx:688`（`minimizeAutoT` 只 `setAutoTOpen(false); setAutoTMin(true)`）、`:689-710`（只有 `closeAutoT` 提交）、`:1263-1267`（胶囊文案只有轮次/收益） | 最小化时也走 `closeAutoT` 的提交流程（或胶囊加「未保存」点 + 点击后先提示）。 |
| P2-7 | P2 | **缺 `perPosition` 统计时渲染「做T 0 次」**，与页面「缺失一律 —」的红线冲突（设计稿 §2 虽写了 `0 次`，但这是唯一一处把缺失写成 0 的地方）。 | `src/client/prismDeskSide.ts:564-570`（`stat===null ⇒ '做T 0 次 · — · 胜率 —（n=0）'`）；`PrismPage.tsx:307-311`（只有 enabled 才渲染，title 说明宿主未给） | 改 `— 次 · — · 胜率 —（n=0）`，title 保持「宿主未给出该标的累计做T统计」；真要写 0 的地方必须是宿主明确给了 `rounds:0`。 |
| P2-8 | P2 | **无持仓空态不是 `—` + 原因**：写的是 `持仓未取到`；移动端「可卖 —」没有 title（原因只在桌面单元格上）。 | `src/client/PrismPage.tsx:289`（`missText('持仓')` → `uiText.ts:6-10` 输出「持仓未取到」）；`:304-305`（mobile 行无 title）；`:312`（桌面有 title） | 空态统一 `—（账户未给出持仓）`；mobile 行把 `title="账户未给出该标的可卖数量"` 带上，或抽一个 `qtyTextOf(row)` 同时供两处。 |
| P2-9 | P2 | **T 腿在「全部/风控」里没有 `T` 徽标，和主委托无法区分；依据被固定串顶掉；撤单原因不可见。** 设计稿 §3.1 明确要求「决策流里 T 单带 T 徽标」。 | `src/client/prismDeskMid.ts:577-579`（title/action/basis 都不带 channel）；`:272-290`（`FlowOrderInput` 没有 `cancelReason`）；`PrismPage.tsx:165-176`（只渲染 `e.kind` 徽标） | `DeskFlowEntry` 增 `channel?: 'autoT'` 与 `cancelled?: boolean`；`flowEntryNode` 在 ORDER 卡标题旁加 `T` 小徽标；`basis` 优先级改 `rejectReason → skipReason → cancelReason → reason`。 |
| P2-10 | P2 | **tab 计数没有时间窗**：「风控 120」是全部历史被拒委托，而底栏「风控 全部通过」是今日；「挂单 276」也是全部历史。两个口径同屏出现，用户会读成同一件事。 | `src/client/prismDeskMid.ts:627-630`（全量计数）、`:643-647`（无日期过滤）；`src/client/prismDeskSide.ts:284-294`（`blockedTodayOf` 只算今日）；真实数据：`rejected` 120 条分布在 10-23～11-26，今日 0 | 在 tab 标题或 tooltip 写「全部历史」，或加「今日」筛选（与 P1-3 的过滤器同一个位置）；底栏与 tab 至少有一处标注口径。 |
| P2-11 | P2 | **30s 刷新会全量重建 437 条决策流（实测 11.3ms）+ 弹窗整棵重建**：`flowEntries` 的 memo 依赖整个 `state`，而 `state` 在交易时段因行情价每 30s 必变（指纹闸挡不住）；`autoTRows`/`autoTSaved`/`autoTEffective` 每次渲染都是新对象，`AutoTModal` 也没有 memo。 | `src/client/PrismPage.tsx:1005-1015`（memo 依赖 `state`）、`:664-677`（每次新建对象）、`:1249-1262`（弹窗）、`styles` 无关；实测 437 条 = 20 SCAN + 80 ANALYZE + 11 HOLD + 326 ORDER（risk 120 重叠）；`flowEntriesOf` **11.29ms/次**（本机 20 次均值） | 见 §九 的 memo 清单：给 flow 输入做内容签名（runs 长度+末条 `startedAt`、orders 长度+末条 `id/status`、holdings 长度+末条 `at`），签名不变就复用 entries；`autoTRows/autoTSaved/autoTEffective` 用 `useMemo`；`AutoTModal` 用 `React.memo` + 稳定 props；chips/focusPlan/flow/每行 judge 在弹窗内 `useMemo`。 |
| P2-12 | P2 | **暂停态在入口显示成灰色「关闭」点**（`paused` 且无未完成 ⇒ `'closed'`），与弹窗头部琥珀色「已暂停」不一致。 | `src/client/prismDeskSide.ts:484-488`（`return a.state==='running' ? 'running' : 'closed'`） | 增 `'paused'` 档（琥珀点）或把 `paused` 并入 `unfinished` 的配色。 |
| P2-13 | P2 | **CSS 残留半条规则**：`.tw-ad-sb-item{...}` 后面多了 `display:flex;align-items:center;gap:5px;white-space:nowrap;min-width:0}`，浏览器按非法选择器丢弃，当前无视觉影响，但会让后续 CSS 解析/压缩工具踩坑。 | `src/client/styles.ts:1372` | 删掉 `}` 之后那段重复声明。 |

### 2.1 审计结束时的外部提交 `ec501ff`（v0.244.0）对照

> 该提交不是本审计产生的；列在这里只为避免重复修/漏修。它的样式改动与本文 §三 的「宽度计算」建议一致。

| 本文条目 | v0.244.0 状态 | 依据 |
|---|---|---|
| P1-6 的「宽度计算」子项（fit-content） | **已修** | `.tw-ad-ev-r .v` 加 `display:block;width:100%;max-width:100%;word-break:break-word`；`.tw-ad-ev-vw` 加 `width:100%`；`align-items:start`。复测 1300px 卡宽：`.v` 1009 → **1211**（=列宽），与直挂 grid 一致。 |
| P1-6 的「列表折叠裁切 + 展开按钮出视野」 | **未修** | `.tw-ad-feed-list` 仍是 `flex:1 1 auto;min-height:0;overflow:auto`；`is-clamp` 仍是 3 行；「展开」仍在卡片底部。 |
| P1-1 / P1-2 / P1-3 / P1-4 / P1-5 / P1-7 | **未修** | 见各条；`loadSettings` 仍不读 `autoT`、弹窗 grid 仍无 `grid-template-rows`、做T tab 仍不过滤、`autoTPlanOf` 仍取最旧、`trades` 仍无写入者、焦点仍无陷阱。 |
| 宿主 P0（`AUDIT-AUTOT-HOST.md` #1/#2/#3） | **已修** | `ec501ff` 的 ①②③：有成交的 pair 锁定、14:50 按净差额、autoT 单账本（`deps.trading.autoT()`）。 |
| 新增的 CSS 死规则 | **新问题（P3）** | `ec501ff` 在 `styles.ts:1284` 前插入同选择器的 `-webkit-line-clamp:4`，被后面的 3 行规则覆盖 ⇒ 死规则，且会让人误读上限。建议删掉 4 行那条。 |

---

## 三、已知问题 1：ORDER 卡「依据」长文本超出卡片 / 被裁成两行

### 3.1 先给结论（对应四种候选）

| 候选 | 是否根因 | 依据 |
|---|---|---|
| `white-space` | **否** | `styles.ts:1283` 已是 `white-space:normal`；`overflow-wrap:anywhere` 也在。实测 110/253 字中文在 390/890/1300 三档都正常换行（见 3.3）。 |
| 卡片 `max-height` | **否（但列表有）** | `.tw-ad-ev`/`.tw-ad-ev-body`/`.tw-ad-ev-rows` 都没有 `max-height`；有 `max-height` 的是 **`.tw-ad-feed-list`**（`flex:1 1 auto;min-height:0;overflow:auto`，`styles.ts:1258`；≤1100px 再加 `max-height:56vh`，`styles.ts:1545`）。 |
| `line-clamp` | **是（3 行）** | `styles.ts:1284` `.tw-ad-ev-r .v.is-clamp{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}`。实测 1248 字文本：`clientHeight 56 / scrollHeight 130`，第 3 行末尾有 `…`，下方有「展开」。 |
| 宽度计算 | **v0.243.2 是；v0.244.0 已修** | `styles.ts:1285` `.tw-ad-ev-vw{display:flex;flex-direction:column;align-items:flex-start}` 没有 `width:100%`，`.v` 作为 flex 子项按 **fit-content** 排版：v0.243.2 实测 1300px 卡宽时 `.v` 只有 **1009px**（直挂 grid 时是 1211px），行宽少 19%，窄列时更早撞 3 行上限。v0.244.0 已加 `width:100%`/`display:block`/`align-items:start`，复测 `.v` = 1211（=列宽）。 |

**用户看到的「两行」= 列表折叠处只露出 2 行 + 第 3 行被 clamp/裁掉 + 「展开」在视野外。** 这不是单一 CSS 属性，是「内层滚动容器裁切 + 3 行 clamp」叠加的视觉结果；`white-space` 与卡片 `max-height` 可以排除。

### 3.2 三层裁切链（按用户实际看到的顺序）

1. **第 1 层：`.tw-ad-feed-list` 的滚动视口（`styles.ts:1258`）**。中栏 `detailCard` 占掉上半屏后，feed 卡 `flex:1 1 auto`，list 只有约 360–450px 高；每张 ORDER 卡 135–193px，**第 3 张卡必然从中间被切断**。实测（890px 卡宽、8 张卡、list 高 367）：`list.clientHeight 367 / scrollHeight 1112`，卡片高 `[135×7, 154]`，最后一张正好卡在折叠处。这是「超出卡片」观感的主要来源：卡片的底边框、「展开」按钮、风控 pill 都在视野外。
2. **第 2 层：`-webkit-line-clamp:3`（`styles.ts:1284`）**。`FlowTextView` 量到溢出后给 `.v` 加 `is-clamp`，文本硬停在 3 行；DOM 里有全文、`title` 也是全文（`PrismPage.tsx:129`），但视觉上没有「还有更多」的渐隐，只有行尾 `…`。
3. **第 3 层：`fit-content` 宽度（`styles.ts:1285`）**。`.tw-ad-ev-vw` 是 flex 列、`align-items:flex-start`，`.v` 的宽度由内容决定，不是 100%；在 1300px 卡宽下实测 `.v` 1009px、文本提前换行（`clientWidth 1009 / scrollWidth 1009`，没有横向溢出，但可用行宽少了 239px）。窄列时这会**更早**触发第 2 层。

> **关于「超出卡片右缘」**：在 Chrome 148 下，390/890/1300 三档实测 `.v` 的 `scrollWidth == clientWidth`、`right <= 卡片右缘`，**没有复现「文字跑出卡片右边被切」**。截图里的横向切断与同一镜像 1336px 宽的版式一致（964px 图是裁剪），所以它更像**截图裁剪**，不是渲染溢出；但 `fit-content` 的宽度计算确实需要修（见 3.3），否则在更窄的列/更长的不可断片段上会重演。

### 3.3 实测数据（v0.243.2 原样 `TW_CSS`，无头 Chromium 148）

| 卡宽 | 文本 | `.v` 宽 | `.v` 高 | 行数 | `clientW/scrollW` | 结论 |
|---|---|---|---|---|---|---|
| 390 | 招商轮船 110 字 | 301 | 74 | 4 | 301/301 | 正常换行，会撞 3 行 clamp |
| 890 | 招商轮船 110 字 | 801 | 37 | 2 | 801/801 | 正常 |
| 890 | 招商轮船 253 字 | 801 | 56 | 3 | 801/801 | 正好 3 行，不触发 clamp |
| 890 | 1248 字 | 801 | 56 | 3（clamp） | 801/801 | `scrollH 130`，有 `…` + 「展开」 |
| 1300（包 `.tw-ad-ev-vw`） | 110 字 | **1009** | 19 | 1 | 1009/1009 | 内容宽 < 卡片宽，**宽度计算缺陷** |
| 1300（直挂 grid） | 110 字 | 1211 | 19 | 1 | 1211/1211 | 对照组：可用宽度 1211 |

> 上表是 **v0.243.2** 的数字。v0.244.0（`ec501ff`）给 `.v` 加了 `width:100%` 后复测：1300 那行 `.v` = **1211**（= 列宽），与直挂 grid 一致；其余行不变。也就是说 1009 这个缺陷在新版本已不存在，**但列表折叠/3 行 clamp/展开按钮出视野这三件事仍在**。

### 3.4 修法（按优先级）

```css
/* 1) 消除 fit-content：宽度永远等于 1fr 列（v0.244.0 已应用） */
.tw-ad-ev-vw{min-width:0;width:100%;display:flex;flex-direction:column;align-items:flex-start;gap:2px}
.tw-ad-ev-r .v{display:block;width:100%;max-width:100%;font-size:12px;color:var(--tw-dim);
  line-height:1.55;min-width:0;overflow-wrap:anywhere;word-break:break-word;white-space:normal}
/* 2) 多行块不要 baseline 对齐（clamp 后 baseline=底边，行高会抖） */
.tw-ad-ev-r{display:grid;grid-template-columns:30px minmax(0,1fr);gap:7px;align-items:start}
/* 3) 列表折叠处给「还有内容」的信号，并让滚动条可见 */
.tw-ad-feed-list{scrollbar-width:thin;scrollbar-gutter:stable;
  -webkit-mask-image:linear-gradient(180deg,#000 calc(100% - 24px),transparent 100%);
  mask-image:linear-gradient(180deg,#000 calc(100% - 24px),transparent 100%)}
```

**「展开」按钮**：建议从卡片底部移到 `.tw-ad-ev-top` 右侧（与时间同排，`margin-left:auto`），或做成 clamp 文本右下角的浮动小按钮；否则卡在折叠处时按钮永远不可见，用户会认为「没有展开」。

**备选（更彻底）**：去掉 `.tw-ad-feed-list` 的内层滚动（`overflow:visible`），让 `.tw-ad-col` 成为唯一滚动容器；代价是 feed 卡高度随 60 条内容增长，中栏整体滚动。对「人类只设边界」的只读页，这比双层滚动更好维护。

### 3.5 影响面

- **所有走 `FlowTextView` 的卡片**：ORDER / SCAN / ANALYZE / RISK / HOLD 共用 `.tw-ad-ev-r .v` 与同一个 `.tw-ad-feed-list`；不是 ORDER 专属。
- ORDER 最常被看到，是因为 `basis` 取 `rejectReason/reason/skipReason` 的全文（253 字很常见），且 ORDER 卡的行数最少、最容易在折叠处只剩 2 行。
- 现有测试（`prismDeskMid.test.ts:429-430`）只断言 CSS 文本里有 `line-clamp:3` / `line-height:1.55`，**不断言实际排版**，所以这类回归 `npm run check` 抓不到。

---

## 四、已知问题 2：「做T」tab 混入历史已撤单 —— 是否需要「仅看活跃」

### 4.1 数据（2026-11-26 11:30 快照）

| 维度 | 数值 |
|---|---|
| `channel:'autoT'` 委托 | **50** |
| `cancelled` | **46（92%）**：后续研判撤销 29 / 手动撤销 13 / 做T开关关闭 3 / 每轮重审计 1 |
| `filled` | 4 |
| `pending` | **0** |
| 计划 | 25 条（22 aborted / 3 waiting） |
| 每个标的的计划数 | 1.601398 **8 条**、1.510300 6 条、1.588000 3 条、1.601872 3 条、1.560010 2 条、1.600900 2 条、1.511090 1 条 |

### 4.2 评估

**需要过滤，但不要叫「仅看活跃」——按字面（pending/partial）当前会得到 0 条空列表。** 用户真正想过滤的是「已撤单」这种噪声，不是「已成交」这种结果。建议开关叫 **「隐藏已撤单」**：

- 做T 列表 50 → **4 条**（4 条已成交腿），仍然能看到「今天做成了什么」；
- 已撤单 46 条不消失（关掉开关即可看），但默认不占屏；
- `风控` tab 不受影响（`rejected` 不隐藏）。

同时建议把「撤单原因」显示出来（现在 46 条卡片只写「自动做T·买入腿」，等于没有信息）。`prism-orders.json` **已经有** `cancelReason`，不需要改宿主数据契约。

### 4.3 最小改动（不改数据契约）

```ts
// 1) prismDeskMid.ts：只加客户端派生字段（wire 不动）
export interface FlowOrderInput {
  // ...现有字段
  /** 撤单原因（宿主已有，旧单可能没有） */
  cancelReason?: string
}
export interface DeskFlowEntry {
  // ...现有字段
  /** 仅 ORDER：已撤单（做T/挂单列表默认隐藏） */
  cancelled?: boolean
  /** 仅 ORDER：自动做T 腿（用于 T 徽标） */
  channel?: 'autoT'
}
// ORDER push 里：
cancelled: o.status === 'cancelled',
channel: o.channel === 'autoT' ? 'autoT' : undefined,
basis: plainOf(o.rejectReason ?? o.skipReason ?? o.cancelReason ?? o.reason) ?? null,

// 2) flowWindowOf 多一个可选参数（默认 false，保持旧行为）
export function flowWindowOf(entries, tab, max = FLOW_RENDER_MAX, hideCancelled = false): FlowWindow {
  const all = flowFilterOf(entries, tab)
  const rows = hideCancelled ? all.filter((e) => e.kind !== 'ORDER' || e.cancelled !== true) : all
  const limit = max > 0 ? max : 0
  return { rows: rows.slice(0, limit), shown: Math.min(rows.length, limit), total: rows.length, truncated: rows.length > limit }
}

// 3) PrismPage：一个 state + 一个按钮（只在 order / autoT tab 显示）
const [flowHideCancelled, setFlowHideCancelled] = React.useState(false)
// 切到「做T」时默认打开（一次性）
React.useEffect(() => { if (flowTab === 'autoT') setFlowHideCancelled(true) }, [flowTab])
// 按钮：role="switch" aria-checked，data-role="ad-flow-hide-cancelled"
// 文案：`隐藏已撤单 ${flowCounts.autoT - activeCount}`，计数仍用 flowCounts.autoT（总数不变）
```

**计数器**：`flowCountsOf` 不动（tab 上的 50 是「T 委托总数」，语义正确）；在开关旁显示「活跃 4 / 已撤 46」，避免用户把 50 读成 50 笔在途。若要连计数也分「活跃/总数」，在 `FlowCounts` 加 `autoTActive`（同一次遍历算，别再加 7 次 filter，见 §九）。

**测试**：`prismDeskMid.test.ts` 加 3 条——`cancelled` 派生正确、`hideCancelled` 只影响 ORDER、`autoT` tab 默认过滤后剩 4 条（用真实 fixture 的 50/46/4/0）。

**备选（零 UI 改动）**：不新增开关，改为「活跃在前、已撤单在后 + 已撤单卡片整行降透明度 + 撤单原因做 basis」。缺点是 46 条仍然占屏，用户还是要滚很久；不推荐。

---

## 五、自动做T 弹窗：920 / <860 / <560 三档滚动、表格列、格式化

### 5.1 三档到底有没有滚动条（实测）

> 测法：v0.243.2 原样 CSS + 真实结构（5 chips + 11 行持仓表 + 左判断面板 + 右 6 条流水），读 `clientHeight/scrollHeight/overflow`。`vw` 为窗口宽，`vh` 为 `innerHeight`（有浏览器 chrome 时小于窗口高）。

| 档位（窗口） | body 可滚？ | 表格竖滚？ | 面板竖滚？ | 可见滚动条 | 是否裁内容 |
|---|---|---|---|---|---|
| **1440×900**（inner 813） | 否（`overflow:hidden`） | 是（350 / 556，条被隐藏） | 否（grid 276 / 内容 316） | **无** | **是**：body `scrollH 747 > clientH 720`，底部 27px 被裁 |
| **1280×800**（inner 713） | 否 | 是（284 / 556） | 否（242 / 316） | **无** | **是**：`681 > 620`，61px |
| **1024×768**（inner 681） | 否 | 是（286 / 532） | 否（218 / 316） | **无** | **是**：`676 > 588`，88px |
| **≤860**（860×900） | 是（`overflow-y:auto`） | 是（556/556，不滚） | 否（439/439） | **无**（`scrollbar-width:none`） | 否（body 可滚，但看不到条） |
| **≤560**（560×900） | 是（`overflow-y:auto`） | 是（765/765） | 否（564/564） | **无** | 否（body 可滚，但看不到条） |
| **920 宽档**（920×800） | 否 | 是（284 / 556） | 否（242 / 316） | **无** | **是**（同 1280×800） |

**结论：三档都「无滚动条」，但不是「不需要滚」——>860px 时是 body 直接 `overflow:hidden` 把内容裁掉（真正看不到、也滚不到）；≤860 时是 body 能滚但滚动条被 `scrollbar-width:none` + `::-webkit-scrollbar{display:none}` 藏了。**

补充：
- **今日流水为空时**（当前真实数据 `trades: []`），1024×768 只差 7px（`595 > 588`）；一旦 P1-5 修好、流水有 3–6 条，三档就会按上表 27/61/88px 裁切。
- **表格列宽正确**：`table-layout:fixed` + 各断点 `th` 宽度合计 100%，实测 `table.scrollWidth == wrap.clientWidth`（888/888、533/533、470/470），**没有横向溢出**。≤860 隐藏「账面成本/结果」，≤560 再隐藏「底仓/可卖」并把可卖挪到名称下方，都是对的（唯一问题是结果列消失，见 P2-2）。
- **grid 为什么裁**：`max-height` 只限盒子，不限行高；`.tw-ad-autot-grid` 没有 `grid-template-rows`/`overflow`，行高仍是内容高（panel 316），panel 的 `overflow-y:auto` 永远不触发（panel 盒子 = 行高 = 内容高）。修法只需 `grid-template-rows:minmax(0,1fr);overflow:hidden`（实测 body `scrollH == clientH`，panel 变成 216 / 314 可滚）。

### 5.2 金额 / 百分比格式化一致性

| 位置 | 实现 | 位数/符号 | 问题 |
|---|---|---|---|
| 顶部 chips / 流水金额 / 结果金额 | `signedMoneyOf` | 2 位、±、千分位 | 一致 |
| 股数（表格底仓/可卖） | `groupOf` | 0 位、千分位 | 一致 |
| 股数（判断列） | `moneyOf(shares,0)` | 0 位、千分位 | 与 `groupOf` 输出相同（重复实现） |
| 账面成本 / 有效成本 | `toFixed(3).replace(/\.?0+$/,'')` | ≤3 位、去尾零 | 3.96 与 3.918 列宽不一致；无千分位（成本 <1000，影响小） |
| 胜率 | `toFixed(1)` + 去 `.0` | **1 位** | 与绩效卡 `signedPctOrDash` 的 **2 位**不一致 |
| 价差 | `toFixed(2) + '%'` | 2 位、**无 +** | 与 `signedPctOf` 的带符号不一致（方向恒正时可接受，但两套函数应统一） |
| 买卖价 | `toFixed(2)` | 2 位 | 与成本 3 位不同（刻意，但列头没标注） |

**建议**：抽一个 `pctTextOf(v, {digits:2, sign:false})` 供胜率/价差/绩效共用；成本列头写「账面成本（3 位）」；`moneyOf(shares,0)` 与 `groupOf` 合并成一个函数。

---

## 六、空态口径（无 autoT / 无持仓 / n=0 / 缺可卖）

| 场景 | 现状 | 是否 `—` + 原因 | 结论 |
|---|---|---|---|
| 宿主回包没有 `autoT` | 横幅「自动做T 未启用…宿主回包没有 autoT 字段；逐只开关暂不开放」；5 个 chip 全 `—`（title 说明）；表格每行「未开启做T」+ 开关 disabled；左面板「—（今日无做T计划）」；右面板「—（自动做T 未启用）」 | **是** | ✅ |
| 无持仓 | 表格 `<td colSpan=7>持仓未取到</td>` | **否**：不是 `—`，也没有原因 | ❌ P2-8 |
| 胜率 `n=0` | `—（n=0）` + title「样本数 n=0，胜率不可算」 | **是** | ✅ |
| 有 n、缺 rate | `—（n=N）` + title | **是** | ✅ |
| 缺可卖数量 | 桌面 `—` + title「账户未给出该标的可卖数量」；**移动端（≤560）同名行只有 `—`，无 title** | 桌面是；移动端丢原因 | ⚠ P2-8 |
| 缺账面成本 | `—`，**无 title** | 否 | ⚠ 补 title |
| 缺有效成本 | `—` + title「宿主未给出该标的有效成本」 | 是 | ✅ |
| 缺 `perPosition` | `做T 0 次 · — · 胜率 —（n=0）` | **否**（写了 0 次） | ❌ P2-7（设计稿 §2 也写 0，建议改 —） |
| 无计划 | `—（今日无做T计划）` + 三格 meta 全 `—`（title「今日无做T计划」） | 是 | ✅ |
| 无流水 | `—（今日无做T流水）`，但**宿主根本没写 trades**，所以这句话在说谎 | 文案不准确 | ⚠ 改「宿主未提供做T流水（trades 为空）」 |

---

## 七、同源与状态一致：做T 委托在 tab 与弹窗流水

**结论：不同源，且当前状态不一致。**

| 视图 | 数据源 | 今日真实值 |
|---|---|---|
| 决策流「做T」tab | `state.orders` 过滤 `channel==='autoT'`（`prismDeskMid.ts:576`） | **50 条**：46 已撤、4 已成交、0 pending |
| 弹窗「今日流水」 | `autoT.today.trades` ← `prism-autot.json.trades`（`prismRoutes.ts:282`、`prismDeskSide.ts:675-714`） | **0 条**（`trades` 无写入者） |
| 弹窗「结果」列 | `autoT.today.plans[].status` + `results`（`prismDeskSide.ts:617-660`） | 3 条 waiting（一腿成交+一腿撤单）、22 aborted |
| 入口状态点 | `autoT.enabled` + `today.plans`（`prismDeskSide.ts:478-498`） | `enabled=false`（settings 丢字段）⇒ **灰点「已关闭」**，但 3 条 waiting 会让 `autoTHasUnfinishedOf` 为 true（被 `!enabled` 挡住） |

**三条具体不一致：**

1. **成交腿只在 tab 里，不在流水里**：4 条 `filled` 的 T 腿在 tab 能看到；弹窗流水 0 条。原因：`prismAccount.ts:1930-1973` 只写 `results`，从不写 `AutoTTradeRec`。
2. **计划状态与委托状态脱节**：`autoTPayloadOf` 的 `alive = pair.some(pending || filled)`（`prismRoutes.ts:278`）；一腿 filled、一腿 cancelled 时 `alive` 仍 true ⇒ 计划保持 `waiting`，弹窗显示「待触发」，tab 显示「已成交 + 已撤单」。真实数据 3 条计划全部如此（1.588000 两条、1.601398 一条）。
3. **入口说「已关闭」，实际有 3 条裸腿**：settings 的 `autoT` 没读回来 ⇒ `enabled=false`；`autoTEntryStatusOf` 第一行就返回 `closed`，连「有未完成 T 单」都不显示。20,000 股卖出腿已成交、买入腿已撤，用户以为做T已停。

**修法**：以 `orders`（唯一事实源）派生弹窗流水与计划状态；`trades` 要么由成交时写入，要么干脆删掉这个字段、`autoTFlowOf` 改吃 `orders.filter(channel==='autoT')`（客户端只读，不新增数据契约）。后者更小：`autoTFlowOf(a, orders)` 用 `pairId` join 计划名，直接展示「T·买入/卖出/强平」，状态与 tab 100% 同源。

---

## 八、可访问性（自动做T 弹窗）

| 项 | 现状 | 评价 |
|---|---|---|
| `role="dialog"` / `aria-modal` / `aria-label` | 有（`PrismPage.tsx:252`） | ✅ |
| Esc 关闭 | `useEscapeLayer`（`:230`），saving 时忽略 | ✅ |
| 遮罩点击关闭 | `onMouseDown` + `target===currentTarget`（`:249`） | ✅（建议改 `onClick`，避免拖拽误关） |
| 初始焦点 | 聚焦第一个 `button:not([disabled])` = **「最小化」**（`:232`） | ⚠ 一按空格就最小化；应聚焦对话框本身（`tabIndex=-1`）或「关闭」 |
| 焦点陷阱 | **无**；Tab 会跑到弹窗背后的页面 | ❌ P1-7 |
| 焦点归还 | **无**；关闭后焦点落到 body | ❌ P1-7 |
| 开关可访问名 | `role="switch"` + `aria-checked` 正确；但 11 个开关的 name 只有 `title`（「关闭该标的自动做T」/「开启该标的自动做T」），**不区分标的** | ❌ P1-7 |
| 入口 `aria-expanded` | 无（只有 `aria-haspopup="dialog"`） | ⚠ |
| 错误播报 | `.tw-ad-autot-err` 有 `role="alert"`（`:361`） | ✅ |
| 保存中状态 | 「保存中…」无 `aria-live` | ⚠ |
| 背景滚动 | 未锁 body；移动端 100vh 弹窗背后仍可滚 | ⚠ P2 |

**修法**：把 `ui.tsx` 的 `Modal` 焦点逻辑抽成 `useDialogFocus(ref, onClose)`（记录 prev、首焦点、Tab 循环、归还），`AutoTModal` 复用；switch 加 `aria-label={`${row.name} 自动做T`}`；入口加 `aria-expanded`。

---

## 九、性能：30s 刷新下的 400+ 条 flow 与弹窗重建

### 9.1 现状（实测）

- 决策流 **437 条**：20 SCAN + 80 ANALYZE + 11 HOLD + 326 ORDER（risk 120 与 order 重叠计数）。`flowEntriesOf` **11.29ms/次**（本机 20 次均值，Node 24），`flowCountsOf` 0.16ms（7 次 `filter`），`flowWindowOf` 0.05ms；渲染 60 张卡 ≈ 600–1200 个 React 元素。
- `flowEntries` 的 memo 依赖 **整个 `state`**（`PrismPage.tsx:1005-1013`），而回包里 `desk.quotes`/`desk.positions.rows` 带实时价，交易时段每 30s 必变 ⇒ **指纹闸挡不住**（`prismStateGate.ts` 只排除了 `asOf`），`flowEntriesOf` 每拍全量重算。
- 把 memo 依赖换成 `state.state.runs`/`orders` 也**无效**：宿主 `runs()`/`orders()` 每次都 `.slice()`（`prismStore.ts:345`、`prismAccount.ts:846`），引用每拍都是新的。
- 弹窗：`AutoTModal` 是普通函数组件，PrismPage 每次渲染都整棵重建；`autoTRows`（`PrismPage.tsx:664`）、`autoTSaved`（`:673`）、`autoTEffective`（`:675`）每次都是新对象；弹窗内 `chips`/`focusPlan`/`flow`/`tri`/每行 `judge` 都是渲染时现算。

### 9.2 可 memo 的点（按收益排序）

| # | 位置 | 现状 | 建议 |
|---|---|---|---|
| 1 | `PrismPage.tsx:1005-1013` `flowEntries` | 依赖 `state` | 用**内容签名**做 key：`runs.length + 末条 startedAt + orders.length + 末条 id/status + holdings.length + 末条 at`；签名相同就复用上一份 entries |
| 2 | `PrismPage.tsx:1014` `flowCounts` | 7 次 `filter` 全表扫 | 在 `flowEntriesOf` 里顺带累计（或一次遍历算 7 个计数），并入 #1 的 memo |
| 3 | `PrismPage.tsx:1015` `flowView` | `[...entries]` 复制再 slice | `tab==='all'` 时直接 `entries.slice(0,60)`；过滤+截断一次完成 |
| 4 | `PrismPage.tsx:664-677` `autoTRows/autoTSaved/autoTEffective` | 每次渲染新建 | `useMemo([posRows, acctPositions])` / `useMemo([autoT, autoTRows])` |
| 5 | `PrismPage.tsx:519` `autoT` | 依赖 `state` | 依赖 `state.autoT` 的内容签名（plans 长度 + 末条 id/status + results 长度） |
| 6 | `AutoTModal` 233-244 | chips/focusPlan/flow/tri 每次算 | 各自 `useMemo([autoT])`；11 行 judge 一次 `useMemo` 生成 `rows` |
| 7 | `AutoTModal` 组件本身 | 每次 PrismPage 渲染都重建 | `React.memo(AutoTModal)` + #4/#6 的稳定 props（否则 memo 无效） |
| 8 | `flowEntryNode` | 60 次/重建 | `React.memo` 单条（entries 稳定后才有意义） |
| 9 | `statusFacts`/`acctView` | 已 memo，但依赖 `state` | 同 #1，改内容签名 |
| 10 | `AutoTModal` 的表格 | 11 行 × 7 列，无虚拟化 | 11 行无需虚拟化；只要 #6/#7 生效即可 |

**量化目标**：行情只变价时，`flowEntriesOf` 从 11.3ms → 0ms（签名不变直接复用）；弹窗从每次 PrismPage 渲染重建 → 只有 `autoT/rows` 变才重建。

---

## 十、Top5

1. **P1-1 做T 开关重启即丢**（`prismStore.ts:118-166` 漏读 `autoT`）：唯一人工操作失效，重启后入口「已关闭」、表格全「未开启做T」，而 25 条计划/50 条 T 委托还在——这是本轮最该先修的一条，且修法只有十几行 + 一条持久化测试。
2. **P1-2 弹窗在 1440×900 / 1280×800 / 1024×768 裁内容**（`styles.ts:1416/1463`）：`grid max-height` 不限行高 + body `overflow:hidden`，实测裁 27/61/88px（流水为空时 1024×768 也裁 7px）；一行 `grid-template-rows:minmax(0,1fr);overflow:hidden` 即可让 body 不再溢出、panel 真正可滚。
3. **P1-6 ORDER「依据」被切**（`styles.ts:1258/1284/1285`）：不是 `white-space`（已 normal）、不是卡片 `max-height`；是「内层滚动容器折叠裁切 + 3 行 clamp + 展开按钮出视野」三层叠加。v0.244.0 已修掉其中的 fit-content 宽度（实测 1009→1211），**但列表折叠/展开按钮仍要修**：列表底部渐隐/常显滚动条 + 展开按钮上移；影响所有 FlowTextView 卡片，ORDER 最明显。
4. **P1-3 做T tab 92% 是已撤单且不显示撤单原因**（`prismDeskMid.ts:565-586`）：50 条里 46 cancelled、0 pending；按字面做「仅看活跃」会得到空列表，应做「隐藏已撤单」（默认对做T开启），并复用宿主已有的 `cancelReason` 作为依据；50→4 条，不改数据契约。
5. **P1-4 + P1-5 弹窗计划/流水不可信**（`prismDeskSide.ts:580-590/675-714`、`prismRoutes.ts:275-282`）：判断面板取**最旧**计划（1.588000 显示 09:48 的 1.236/1.248，而非 10:24 的 1.245/1.265）；`trades` 无写入者 ⇒ 「今日流水」永远空；一腿成交+一腿撤单仍显示「待触发」。建议先把弹窗流水改成直接从 `state.orders` 派生（同源），再补 `trades` 写入。

---

## 附录 A：实测/复现记录

- 数据快照：`~/.dsh/dsh-tradewatcher/prism-orders.json`（326 条，10-23～11-26）、`prism-runs.json`（20 轮 / 80 份分析）、`prism-autot.json`（25 plans / 0 trades / 0 results）、`prism-settings.json`（**无 `autoT` 字段**）。
- 纯函数基准：`flowEntriesOf` 11.29ms/次、`flowCountsOf` 0.16ms、`flowWindowOf` 0.05ms（Node 24，本机）。
- 版式实测：v0.243.2 原样 `TW_CSS` + 无头 Chromium 148；卡宽 390/890/1300；弹窗 1024×768、1280×800、1440×900、920×800、860×900、560×900。
- 弹窗修复验证：加 `.tw-ad-autot-grid{grid-template-rows:minmax(0,1fr);overflow:hidden}` 后，1024×768/1280×800/1440×900 的 `body.scrollHeight` 分别 588/620/720 = `clientHeight`，两个 panel `clientHeight 216 / scrollHeight 233、314` 且 `overflow-y:auto` 生效。
- `autoTPayloadOf` 模拟（v0.243.2 原函数 + 真实文件）：`plans 25 {aborted:22, waiting:3}`、`trades 0`、`rounds 0`、`profit null`；3 条 waiting 全部是「一腿 filled + 一腿 cancelled」。

## 附录 B：边界与未做的事

- 未改 `src/**`、未 commit、未重启（任务要求）。
- **未重跑 `npm run check`**：审计期间外部会话改了 `styles.ts`/`prismAccount.ts`/`prismRoutes.ts` 并提交为 v0.244.0（`ec501ff`，其自述验证 2062/2062 × 2 时区）；重跑结果不代表 v0.243.2，故基线 2062/2062 采用任务给定值。本文行号/结论只对 `752a411` 成立。
- 未在真实浏览器里点开弹窗（3080 需要登录）；版式结论来自「原样 CSS + 同结构 DOM」的无头实测，尺寸为 `innerHeight`（窗口含浏览器 chrome 时比标称高度小 80–120px，这会让 P1-2 的裁切更严重，不会更轻）。
- 色彩/对比度、字体、图表未在本审计范围。
- 宿主侧「净持仓不变」的两条 P0（一腿成交后重审计撤回补腿、14:50 按计划股数全量回补）见 `docs/AUDIT-AUTOT-HOST.md`，且已在 v0.244.0（`ec501ff`）修复；本文只覆盖它们暴露到 UI 的状态不一致（P1-5 仍未修）。
