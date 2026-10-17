# REVIEW-8：客户端评审（`src/client/**`）与 UX 优化方案（只读）

- **评估时刻**：2026-10-17 20:35 起（Asia/Shanghai）
- **HEAD**：`8b06d5d`（v0.104.0）。评估期间工作区**干净**（只有本文件新增）。
- **本轮未改任何 `src/**`**、未 commit、未装、未动 profile、**未重启 `dsh web`**、**未在工作区跑 `npm run build`**。
- **实际跑过的命令**（均可复现，全部只读）：
  ```
  git log --oneline -3 / git status --short
  node_modules/.bin/tsc --noEmit -p tsconfig.json            # → exit 0
  node --test --experimental-strip-types src/client/{uiuxDiscipline,styles,badgeView,suggestAll}.test.ts   # → 35 pass / 0 fail
  node --experimental-strip-types -e "…TW_ROWS…"             # → 4 行 / 28 张卡片（cn,intl,bond,commodity）
  grep / sed / read 逐文件阅读（18 个目标文件 + 依赖的纯逻辑模块）
  ```
- **方法边界**：本报告全部结论来自**源码级阅读 + 类型检查 + 定向单测 + 常量实算**。
  **没有在浏览器里渲染过**：所有"视觉/交互后果"标注为【推断】并在 §5 给出确认方法；
  标注【实测】的条目指"代码路径或常量可被静态证实"（如空指针解引用、硬编码色值、时区 API、缺失的 `onClick`）。
- **不重复既有报告**：`REVIEW-1..7` 覆盖过的东西（死代码、文档权威性、工程质量）不再复述，只在**与本轮缺陷同一根因**时引用。

---

## 0. 结论摘要

**一行**：客户端在"诚实性"上已经做得比多数同类产品好（缺数据给原因、口径进 tooltip、四态色点、徽标只放当日涨跌幅都是真的），
但仍有 **3 处会把"没有/失败"显示成"确定的事实"的硬缺陷**（持仓页首屏失败直接崩、行情条汇总数与屏幕上的卡片对不上、做T 摘要显示**胜率**），
以及一批「失败原因被吞在弹窗背后」「重复取数由 `quotes` 对象身份驱动」「键盘走不通」的系统性问题。

| 级别 | 条数 | 代表 |
| --- | --- | --- |
| **P0（崩溃 / 把缺失说成事实 / 违反用户硬约束）** | 3 | 持仓页 null 解引用；行情条汇总口径；做T「胜率」 |
| **P1（错误路径不可见、语义色混用、时区）** | 11 | 自选首屏失败永久骨架；悬浮图失败丢原因；弹窗内写失败无提示；搜索候选键盘选不中；两融/预测文案与实际行为矛盾；买卖用涨跌色；`toTimeString()` 用浏览器时区 |
| **P2（竞态 / 重复请求 / 边界 / 无障碍）** | 12 | 无超时的 fetch 冻结轮询；`quotes` 身份驱动 4 处重复请求；无 `role=dialog`；点击型 div 不可键盘 |
| **P3（文案/死字段/硬编码小项）** | 7 | `--tw-warn` 从未定义；`dayPnl`/`indexName` 入参不用；`?? 0.02` 编造阈值；备份说明缺标点 |

**11 条用户偏好对照**见 §3：**已满足 5 条**（5/6/8/9/10）、**部分满足 3 条**（2/4/11）、**未满足 3 条**（1/3/7 的落地各有一处硬伤）。

---

## 1. 缺陷清单（按严重度排序）

> 格式：**编号 · 位置 · 证据 · 影响 · 置信度**。所有行号对 `8b06d5d`。

### P0

#### P0-1 持仓页首屏取数失败 → **运行时崩溃**（`view` 为 null 时解引用）【实测】

- **位置**：`src/client/PortfolioPage.tsx:184-188`（早退条件）+ `:188`（解引用）+ `:235`（本该显示的错误条）
- **证据**：

  ```ts
  if (view === null && error === null) { return <Skeleton … /> }   // 184-186
  const groups = [...view.groups].sort(…)                          // 188 ← view 仍可能为 null
  …React.createElement(ErrorNote, { error })                       // 235 ← 只有活过 188 才看得到
  ```

  `tsconfig.json` 是 `"strict": false`（无 `strictNullChecks`）⇒ `tsc --noEmit` 退出码 0，**类型检查不会拦住它**。
- **影响**：`GET /tradewatcher/portfolio` 首次失败（宿主 503 / 未重启 / 网络断）时，切到「持仓」页签会抛
  `TypeError: Cannot read properties of null (reading 'groups')`，整棵子树被 React 丢弃。
  用户看到的是**白屏/空白面板**，而正确行为是显示失败原因。这是本轮唯一的**渲染期崩溃**。
- **对照用户偏好 1**：把"取不到"变成了"页面没了"，比显示错数更糟。

#### P0-2 行情条汇总把**用户主动隐藏的卡片**算成「缺失」，且与相邻徽标自相矛盾【实测】

- **位置**：`src/client/TopBar.tsx:356-366`（汇总用 `TW_ROWS` 全量）vs `:380`（渲染用 `visibleCards`）vs `:484-493`（相邻的「无行情源 N」用服务端 `missing`）
- **证据**：

  ```ts
  const summary = summarizeQuoteStates(
    TW_ROWS.flatMap((row) => row.items.map((it) => stateOf(it.secid))),   // 28 张，含隐藏卡
  )
  …
  const stripRows = visibleCards(TW_ROWS, prefs.stripCfg?.hidden)         // 只渲染可见卡
  ```

  而 `engineIds.quoteEngineIds()`（`engineIds.ts:76-79`）**已经不请求隐藏卡** ⇒ `quotes[hiddenSecid]` 永远 `undefined`
  ⇒ `quoteStateOf()` 在 `quoteState.ts:49` 判为 `'missing'`。实测 `TW_ROWS` 共 **4 行 / 28 张卡**；
  隐藏 1 张（用户已隐藏的国债卡 `1.000012` 就是仓库注释里的例子）后：
  - 徽标 ①：`27/28 实时 · 1 缺失`（把"你让我别取"说成"三源都没有"）；
  - 徽标 ②：`无行情源` **不出现**（服务端 `missing` 里没有它）—— 两个相邻徽标互相打脸；
  - 徽标 ① 的 `title` 还写着「本批 28 张卡片」，而屏幕上只有 27 张。
- **影响**：常驻误报 + 不可自愈（重启后仍是 27/28），且用户**点不到那张卡**去查原因。
- **修复方向**：汇总口径改成 `stripRows`；`row === undefined` 的语义另立 `'pending'` 态（`PENDING_LABEL` 已存在，见 P1-5）。

#### P0-3 做T 摘要显示「胜率」——直接违反用户第 7 条（不得呈现胜率/概率）【实测】

- **位置**：`src/client/PortfolioPage.tsx:1284`（渲染）+ `:1252`（注释里也把它当归档口径写下来）
- **证据**：`` `做T ${count} 次 · 净 ${netPnl} · 胜率 ${Math.round(dt.summary.winRate)}%` ``
- **影响**：这是**唯一**常驻呈现概率/胜率的界面位置（`RescuePanel` 反而明确写了"非胜率/概率"，见 `RescuePanel.tsx:779,837`）。
  在"总盈亏"面板上给出一个 12 期样本的百分比，会被读成"我的做T 成功率"，正是用户禁止的那类暗示。
- **修复**：删掉该字段的渲染（`winRate` 留在回包里不影响）。**这是 1 行删除、零风险**。

### P1

#### P1-1 自选页首屏取数失败 → **永久骨架屏**，且永远不显示原因【实测】

- **位置**：`src/client/WatchlistPage.tsx:153`（`if (watch === null) return <Skeleton/>`）+ `:122-134`（`reload` 失败只 `setError`）+ `:165`（`ErrorNote` 在早退之后）
- **证据**：`reload()` 的 `.catch` 把错误写进 `error`，但渲染在 `watch === null` 时**直接返回骨架屏**，
  `ErrorNote` 那一行代码在首次失败时**不可达**；`error` 也从无重试入口。
- **影响**：`/watch` 失败 = 无限 shimmer，与"正在加载"无法区分（这正是用户明确反对的"看着正常的错数"的翻版）。
- **同类**：`PortfolioPage` 的 `stale/error` 路径正常（P0-1 修完即可对照）。

#### P1-2 悬浮行情卡的图表失败把**原因丢掉**，只显示「走势获取失败」【实测】

- **位置**：`src/client/TopBar.tsx:63-65`（`.catch(() => setKind('error'))`）+ `:135`（`'走势获取失败'`）
- **证据**：`chartCache.get()` 在无上一份成功值时会把错误**抛出**（`chartCache.ts:146-153`），这里把 `e` 整个丢掉。
  而 `chartCache` 的 `kind:'unavailable'` 分支（`chartCache.ts:41-48`）**本来带着 `missing[]` 原因**，`HoverCard` 却没有消费它
  （`kind === 'none'` 时只写「暂无当日走势数据」，`:137`）。
- **影响**：用户在行情条上悬停任何一只标的失败时，无法区分"该市场本来没分时源"和"东财这会儿限流"——
  而这个区分在详情抽屉里**已经做了**（`QuoteDrawer.tsx:306-326`）。同一事实两种待遇。
- **修复**：`HoverCard` 复用 `ChartPayload.kind === 'unavailable'` 的 `missing[0].note`，长句仍可进 `title`。

#### P1-3 弹窗内的写操作失败，原因显示在**弹窗背后**（用户看不见）【实测】

- **位置**：`WatchlistPage.tsx:142-151`（`mutate` 写到页面级 `error`）、`:490/:529`（弹窗只渲染自己的 `err`，仅用于本地校验）；
  `CalendarPage.tsx:127-140`（同样写页面级 `err`）、`:436`；
  `PortfolioPage.tsx:160-172` + `:710/:740/:854`（每个 Modal 的 `err` 只装本地校验）
- **证据**：`mutate` 的 `.catch((e) => setError(e.message))` 落在父组件；弹窗没有接收该错误。
  `.tw-mask` 是全屏遮罩（`styles.ts`），`ErrorNote` 在遮罩下。
- **影响**：新增分组/加证券/保存日期事件/录流水失败时，用户看到的是"点了没反应"，关掉弹窗才看到一行红字。
  这是**操作失败路径**上最常被踩的一条，也是偏好 1 的核心场景。
- **修复**：把 `mutate` 的 Promise 交回弹窗（`mutate(body) → Promise<Result>`），或让 Modal 接收 `error` 槽位。

#### P1-4 搜索候选行只有 `onMouseDown`，**键盘永远选不中**；且缺 combobox 语义【实测】

- **位置**：`src/client/ui.tsx:224-233`（`React.createElement('button', { key, type:'button', onMouseDown: … })`）+ `:177-185`（输入框）
- **证据**：键盘 `Enter`/`Space` 激活 `<button>` 触发的是 **`click`**，不是 `mousedown` ⇒ 回调不执行。
  输入框只有 `onKeyDown` 里的"回车取第一个候选"（`:164-172`），列表内没有上下键移动、没有 `aria-activedescendant`；
  列表容器无 `role="listbox"`/`option`（`:189-200` 只有 `data-role`）。
- **影响**：只用键盘的用户**只能选中排序第一的候选**；候选行虽然 `tabIndex` 可聚焦，但按下去无效——
  这是"看起来能用其实不能用"的控件。同时读屏软件拿不到"这是搜索建议、有几条候选"。
- **偏好对应**：偏好 9 要求"列出全部匹配"已经做到，但**可达性**没跟上。

#### P1-5 `row === undefined` 被渲染成「无行情源」（把"还没取到"说成"三源都没有"）【实测】

- **位置**：`src/client/quoteState.ts:49`（`if (isMissing || row === undefined || row.price === null) return 'missing'`）；
  `PENDING_LABEL`/`PENDING_TITLE`（`:21,25`）**只在** `WatchlistPage.tsx:437-441` 与 `PortfolioPage.tsx:1060` 使用，
  行情条卡片（`TopBar.tsx:569` 的 `data-state`）与 `:594` 的色点标签不用。
- **影响**：首屏第一拍之前所有卡片都是红点「无行情源」（P0-2 的同一根因的另一半）；
  卡片 `title` 会写「东财/腾讯/新浪三源都没有给出可用价格」（`:70`）——一句**当时并不成立**的话。
- **修复**：四态扩成五态（`pending`），文案用已有的 `PENDING_*` 常量；等待期用中性灰点。

#### P1-6 买卖用涨跌语义色，并随 `prefs.redUp` 翻转【实测】

- **位置**：`src/client/PortfolioPage.tsx:886-887`

  ```ts
  const chip = (verb) => verb === 'buy' ? 'tw-chip-up' : verb === 'sell' ? 'tw-chip-down' : 'tw-chip-flat'
  ```

- **影响**：`tw-chip-up` 在两档主题里分别是红/绿（`styles.ts:22,40`），由 `prefs.redUp` 决定 ⇒ 把色义切成"绿涨红跌"后，
  **买入变绿、卖出变红**：同一笔操作的颜色含义随用户偏好翻转，且与全站"红绿只表示涨跌"的约定冲突。
  隐身档（`data-view=incognito`）下 `--tw-up/--tw-down` 变灰（`styles.ts:108`），买卖两侧又都变成同色。
- **偏好对应**：偏好 7「不得用颜色暗示主动/被动」。买卖方向和涨跌是两件事。
- **修复**：动作用中性 chip + 文字「买/卖」；颜色只保留在金额的盈亏上。

#### P1-7 两融 / 预测全天：常驻文案还在说「本插件未集成」，而下面的数据已经是真实的【实测】

- **位置**：`src/client/MarketPage.tsx:343-350`（小节副标题 `'本插件未集成两融数据源'`）+ `:346-349`（同一屏用 `marginRowOf(extras.margin, …)` 渲染深交所/东财双源）；
  `:197` `FORECAST_REASON`（「本插件没有日内成交额采样…故不给」）vs `:205-211`（`forecastCellOf` 会真的给出盘中预测值）；
  `:196` `LIMIT_REASON`（「按板块规则自行判定…本轮不做」）vs `:291-306`（`extras.limits.up.count` 已在显示涨停家数）
- **影响**：**同一页自相矛盾**：标题说"没有这功能"，右边却显示这功能的数（v0.81.2 上线后文案没跟上）。
  这三句只在 `extras === null`（本次失败）时才出现在悬停里，所以它同时是**错误的原因说明**——
  用户会以为"这个功能永远不会有"，而实际上"这次没取到，下次会重试"。
- **修复**：把三句常量改成"本次未取到 + 会不会重试"；把"本插件不做"的事实（若仍然成立）挪到方法学说明。

#### P1-8 护盘/日历把浏览器时区当市场时间（R5 违规）【实测】

- **位置**：`src/client/RescuePanel.tsx:767`（`new Date(computedAt).toTimeString().slice(0,5)`）、`:794`（`new Date(lowAtTs).toTimeString().slice(0,5)`）
- **证据**：同项目其它所有"数据时刻"都走 `marketTime.ts` 的固定 `Asia/Shanghai`（`shClockText`/`shStampText`，见 `format.ts:91-111`）；
  这两处绕过了它。`toTimeString()` 按浏览器本地时区渲染 ⇒ UTC 浏览器里 `14:32` 会显示成 `06:32`。
- **影响**：护盘"上次结果"的时刻与"前低时点"会与页面其它时刻**不同源**，两者并排出现时用户无法判断哪个是真的。
  这与 `docs/REVIEW-2` 里修过的 R5 是同一类回归。

#### P1-9 历史回看失败被显示成「当日无信号事件 / 无抽样点」（空值顶替失败）【实测】

- **位置**：`src/client/RescuePanel.tsx:424-431`（`openHistory` 的 `.catch(() => setDayDetail({ events: [], intraday: [] }))`）+ `:1041-1042,1051-1052`
- **影响**：`GET rescue?day=` 失败时，弹窗断言"当日无信号事件""当日无抽样点"——两句话都是**未经验证的否定**。
  正确行为：`dayDetail = null` 保持加载态，另加一行「未取到 + 原因 + 重试」。
- **同类（较轻）**：`QuoteDrawer.tsx:164`（`.catch(() => setTrades([]))` ⇒ 图上"没有 B/S 标记"）、`:188`（`setErr('该周期未取到（停牌/新股/接口限流）')`
  —— 这是**猜的三个原因**，而 `payload.missing` 里其实带着真原因）。

#### P1-10 重要性 / 护盘等级复用 `--tw-up`，并与涨跌色混用【实测】

- **位置**：`src/client/CalendarPage.tsx:21-25`（`IMP_COLOR[3] = 'var(--tw-up)'`）、`:451-453`（选项文字写死「高（红）」）；
  `src/client/RescuePanel.tsx:27-32`（`LEVEL_COLOR[3] = '#f2555a'`，与浅色档 `--tw-up:#e5484d` 几乎同色）
- **影响**：
  ① `prefs.redUp = false` 时"高重要度"变绿、`等级 3` 仍是红（一档跟偏好走、一档不走）；
  ② 隐身档把 `--tw-up` 灰化（`styles.ts:108`），日历的"高"跟着变灰，而护盘的"强"因为硬编码**保持鲜红**——
     **隐身视图下最刺眼的一处颜色泄漏**；
  ③ 选项文案「高（红）」在绿涨模式下是**谎话**。
- **偏好对应**：偏好 4（跟主题、不得硬编码）+ 偏好 7（颜色不承载第二语义）。

#### P1-11 缩略图的「开/高/低」不是官方开高低，是**抽样点的首笔/极值**【实测】

- **位置**：`src/client/mini.ts:44-47`（`open: first`、`high: Math.max(...values)`、`low: Math.min(...values)`，`values` 来自 `/trend` 的分时点）
  + 展示处 `WatchlistPage.tsx:573-575`、`PortfolioPage.tsx:1155-1157`（`开 ${…}` / `高 ${…}` / `低 ${…}`）
- **影响**：分时序列的首点通常晚于 09:30、且上游分钟点可能被抽样/压缩 ⇒ 显示的"今开"与券商 App 的开盘价**可能不同**。
  这是"看着正常的错数"的典型：字段名对、语义差一档。振幅同理（分母用了 `prePrice`，正确；但分子是抽样极值）。
- **修复**：改用官方 `open/high/low`（`/detail` 已提供，`MarketPage` 的 `DetailCard` 就在用它），或把文案改成「分时首笔/分时高/分时低」。

### P2

| 编号 | 位置 | 证据与影响 | 置信度 |
| --- | --- | --- | --- |
| P2-1 | `src/client/api.ts:208-228` + `useQuotes.ts:61-64,110-113` | `request()` 无 `AbortController`/超时。一次挂起的 fetch ⇒ `inFlight.current` 永远 `true` ⇒ **行情轮询彻底停摆**，且 `refreshing` 常真、刷新按钮一直 disabled；只能刷新页面。 | 实测 |
| P2-2 | `useQuotes.ts:59,69,116-126` | key 变化时 cleanup 先置 `alive=false`，新 effect 立刻置 `true`；旧 id 集的响应回来时仍会写 `ts/asOf/missing/truncated` ⇒ **用旧请求的缺失集合标注新页面**（跨页切 tab 时可复现：某行显示 — 但既无"无源"也无"未取到"）。 | 实测（代码路径）/ 触发概率【推断】 |
| P2-3 | `WatchlistPage.tsx:82-104`、`MarketPage.tsx:103-121,127-141`、`RescuePanel.tsx:410-422` | 四条 effect 的依赖是**对象身份**（`quotes`/`snapshot.ts`）⇒ 每一拍行情（默认 10s）都会重发 `industries`（全自选）、`breadth?dist=1`（注释自己写"多扫 ~56 页"）、`market-extras`、`trend`。宿主侧虽有缓存，但请求数与上游压力 ×6。 | 实测 |
| P2-4 | `PortfolioPage.tsx:174-182`、`MarketPage.tsx:177-189` | 流水/详情请求**无序号或取消**：快速点 A→B 时 A 的后到响应会覆盖 B 的内容（串数据）。 | 实测（代码路径） |
| P2-5 | `index.tsx:306-319` | `cycleViewMode` 绕过 `setPrefs`（`:275-282` 那套乐观更新 + 失败回滚 + toast），自己 `setPrefsState` + `api.setPrefs().catch(()=>undefined)` ⇒ **视图档位保存失败永远静默**，与旁边注释里"此前静默吞错掩盖了整轮 bug"的教训自相矛盾。 | 实测 |
| P2-6 | `index.tsx:233,371,373` | `const visible = true` 是常量 ⇒ `useQuoteEngine(..., enabled=true)` 与 `usePageIdle(true)` 都只在 `document.hidden` 时停动画，**面板被宿主藏起来时行情照打**（每 10s）。`PortfolioPage` 的 `active` prop 同理恒真（`:396`），那套 gating 现在没有生效对象。 | 实测 |
| P2-7 | `ui.tsx:10-33`、`:271-357`、`QuoteDrawer.tsx:207-211,617-620` | 三个浮层都**没有** `role="dialog"`/`aria-modal`，打开不移动焦点、不困焦点；`Modal`/`MoreMenu`/`QuoteDrawer` 各自监听 `window` 的 `Escape` ⇒ 两层叠开时**一次 Esc 全关**。 | 实测 |
| P2-8 | `CalendarPage.tsx:158-173,266`、`WatchlistPage.tsx:209`、`RescuePanel.tsx:881` | 可点击的 `span`/`div` 没有 `role`/`tabIndex`/`onKeyDown`（对比同一文件里 `:248-259` 的日历格子是对的）⇒ 键盘与读屏到不了。 | 实测 |
| P2-9 | `index.tsx:380-421` | 六个页签**整页卸载重建**：滚动位置、折叠状态、日历月份、大盘 scope、工具详情页 id 全部丢失，切回时重发 `watch`/`portfolio`/`board`/`calendar`。用户常开六页签 ⇒ 每次切换都在"重来一遍"。 | 实测 |
| P2-10 | `kline.tsx:706-712`（K 线）、`:447-452`（分时） | `onMouseMove` 直接 `setCursor`，整张 SVG（含 240 根柱/均线/MACD）每次 mousemove 全量重渲染，**没有 rAF 节流**。窗口拉满时可能掉帧。 | 【推断】需实测帧率（§5） |
| P2-11 | `styles.ts:462` | `.tw-rescue-bar i{transition:width .25s}` 动的是 **layout 属性**，与项目"只动 transform/opacity"的纪律（`docs/DESIGN-UIUX-ADOPT`）不符；现有断言只扫 `@keyframes`，扫不到 `transition`。 | 实测 |
| P2-12 | `TopBar.tsx:495` | 「已截断 160」把宿主常量 `MAX_QUOTE_IDS = 160`（`src/host/routes.ts:125`）**抄进客户端文案**，`src/shared` 里没有共享常量 ⇒ 宿主调上限时这里会谎报。 | 实测 |

### P3

| 编号 | 位置 | 问题 |
| --- | --- | --- |
| P3-1 | `RescuePanel.tsx:644` | 用 `var(--tw-warn, #d97706)`，但 `--tw-warn` **全项目从未定义**（`styles.ts` 两档 token 表里没有）⇒ 永远走 fallback，浅色档对比度偏低、且不随主题。同文件 `:764,824` 与 `TopBar.tsx:481,491`、`WatchlistPage.tsx:430`、`ui.tsx:240`、`PortfolioPage.tsx:357` 用 `#e0a94a`；`PortfolioPage.tsx:298,1022`、`CalendarPage.tsx:23,374` 用 `#e8a33d`（**两种琥珀**并存）。 |
| P3-2 | `badgeView.ts:72,75` | `BadgeInput` 的 `indexName` 与 `dayPnl` 从未被读取（入参带着"值"却画不出来）；`PortfolioPage.tsx:1109` 的三元两个分支字面相同（`diluted ? '累计已实现' : '累计已实现'`）。 |
| P3-3 | `RescuePanel.tsx:779` | `targets.at(-1)?.targetPct ?? 0.02` — `targets` 为空时**编造**一个"+2%/日"的表头阈值。 |
| P3-4 | `PortfolioPage.tsx:1289` | 做T 明细 `rounds.slice(0, 50)` **静默截断**，不写"还有 N 次"（与搜索/流水列表"上限如实披露"的做法不一致）。 |
| P3-5 | `PortfolioPage.tsx:648-650` | 备份说明字符串拼接缺分隔：「…覆盖前写成 .bak**账本重放不一致**（…）一律拒绝导入」。 |
| P3-6 | `MarketPage.tsx:574-576` | `String(d.counts?.[i] ?? 0)` 属防御性 **0 顶替**（正常路径不会触发，但一旦触发就是"这一档 0 只"）；`:575` 用 `i<4 / i===4 / else` 硬编码 9 档的涨/平/跌配色，上游档位变化会静默错色。 |
| P3-7 | `ToolsPage.tsx:256-264` | 分类容器有 `role="tablist"`，但内部按钮没有 `role="tab"`/`aria-selected`（`data-on` 只是视觉）⇒ 读屏读到"一组普通按钮"。 |

---

## 2. UX 优化方案（对照用户 11 条偏好）

> 每条：**现状（文件:行号）→ 建议 → 可检查阈值 → 影响面与风险 → 偏好对应**。
> 全部不新增依赖、不新增取数路径（只用已有回包字段/已有常量），不为好看牺牲诚实性。

### U1 让"数字与屏幕一致"：五态 + 汇总口径（偏好 1、2）

- **现状**：`TopBar.tsx:356-366` 汇总全量 28 张；`quoteState.ts:49` 把"还没取到/已隐藏"都说成「无行情源」；
  `PENDING_LABEL` 只在两处使用。
- **建议**：
  1. `QuoteState` 增加 `pending`（文字用已有 `PENDING_LABEL`，`title` 用 `PENDING_TITLE`），`quoteStateOf` 的 `row === undefined` 分支返回 `pending`；
  2. `summary` 只统计 `stripRows`（屏幕上真实张数），`title` 改为「屏幕 ${n} 张卡片（另有 ${hidden} 张已隐藏，不请求）」；
  3. `data-state` 增加 `pending` 的中性灰点（`QUOTE_STATE_COLOR.pending` 用 `--tw-flat` 同值）。
- **阈值**：① 冷启动第一帧，行情条显示"加载中"而非"N 缺失"；② 隐藏任意 1 张卡后，徽标分母 = 屏幕张数，且**永不出现**「缺失」计数；③ `quoteState.test.ts` 新增两条断言（hidden→不进 summary；undefined→pending）。
- **影响面**：`quoteState.ts` / `TopBar.tsx` / 两处 `PENDING_*` 消费点；`uiuxDiscipline.test.ts` 不受影响。
- **风险**：低。若宿主 `missing` 里混入已隐藏 secid（现在不会），会多算——需在汇总处再取交集，已有 `stripIds` 现成可用。
- **偏好对应**：1（未取到 + 原因，不 0 顶替）、2（边界声明可见：屏幕几张 vs 隐藏几张）。

### U2 失败原因必须落在**失败发生的那一层**（偏好 1、2）

- **现状**：弹窗内写失败原因落在遮罩后（§P1-3 共 6 处）；`catch` 吞错 9 处（`TopBar:63`、`QuoteDrawer:163,164,188`、`RescuePanel:419,430`、`MarketPage:184,188`、`PortfolioPage:181`…）。
- **建议**：
  1. `mutate`/`saveConfig`/`submit` 统一返回 `Promise<void>`，Modal 内部 `catch → setErr`；页面级 `error` 只承载页面级失败；
  2. `catch(() => undefined)` 一律改成 `catch((e) => setXxxReason(e.message))`，UI 用**已有的** `NoteIcon`/`tw-hint-icon` 承载（`QuoteDrawer.tsx:221-250` 是现成范式）；
  3. 语义区分写进组件契约：`null/undefined` = 未取到（要原因）；`[]` 只能是"成功且真的空"。
- **阈值**：断网后依次点「+ 新建分组 → 保存」「加证券 → 选择」「日历 + 事件 → 添加」「持仓 买 → 确认」，
  **四次都必须在弹窗内出现原因文本**（≥1 行，含 HTTP 状态或网络错误），且可通过键盘读到（`role="note"` 或 `aria-live`）。
- **影响面**：`ui.tsx`（Modal 增加 `error` 槽）、3 个页面 + 6 个 Modal 组件；改动集中在 props 层，不动取数。
- **风险**：中低。`mutate` 签名改为 Promise 会牵动 `onClose` 时机（现在是成功后才关）；需保证**失败不关窗**（这是用户想要的行为）。
- **偏好对应**：1（原因）、2（降级/失败可见）、3（长解释仍可进 tooltip）。

### U3 颜色收敛成 token，且**只表达一件事**（偏好 4、7）

- **现状**：6 位色值散落 11 个文件（§P3-1 清单）；`--tw-warn` 未定义；重要性/护盘等级复用 `--tw-up`（§P1-10）。
- **建议**：
  1. `styles.ts` 两档各补三个 token：`--tw-warn`（琥珀）、`--tw-imp-1/2/3`（重要性三档，**不使用涨跌色相**）、`--tw-rescue-0..3`（等级四档，中性→警示）；
  2. `CalendarPage`/`RescuePanel` 改引用 token；`theme.ts` 的 `BADGE_TONE_COLOR`/`QUOTE_STATE_COLOR` 是"主题容器外必须字面量"的白名单，**保留**但在文件头注明白名单依据；
  3. 隐身处（`[data-view=incognito]`）把 `--tw-imp-*`/`--tw-rescue-*` 一起灰化（`styles.ts:108` 已有该块）。
- **阈值**：① 新增断言「`src/client/**`（除 `theme.ts`/`styles.ts`）不得出现 `#[0-9a-fA-F]{6}`」；②「`--tw-warn` 在两档都有值」；
  ③ 浅色档 12px 文字对白底对比度 ≥ 4.5:1（脚本实算，现有 `#e0a94a` 约 1.9:1，**不达标**）。
- **影响面**：`styles.ts` + 5 个文件；视觉会变（琥珀更深）。
- **风险**：低-中。`rescueView.ts:47-50`、`kline.tsx:22-28,218-219,330` 的色值属于图表序列（多序列必须可区分），**建议只登记为"图表色板常量"并集中到一个 `chartPalette.ts`**，不强行改主题。
- **偏好对应**：4（跟随主题、不得硬编码涨跌色）、7（颜色不承载第二语义）。

### U4 常驻只说"值 + 短标记"，把"我们没做/这次没取到"分清（偏好 2、3）

- **现状**：`MarketPage.tsx:196-199` 三句"本插件不做"；`:344` "未集成两融"；`PortfolioPage.tsx:298-301` 公司行为说明 60+ 字常驻。
- **建议**：
  1. 三句常量改成 `未取到（本次失败，N 秒后自动重试）`，原文挪进"方法学"折叠区；
  2. `:344` 副标题改为「深交所官方 + 东财，双源交叉；不一致时两个读数都显示」（这正是代码在做的事）；
  3. 公司行为那段压成一行 `N 条公司行为 · 不自动改账`，长句进 `title`（该文件已有此范式，`:1023-1024`）。
- **阈值**：常驻正文每段 ≤ 1 行 / ≤ 40 字；`grep '本插件未集成\|故不给\|本轮不做'` 在 `.tsx` 中命中数 = 0（只剩方法学区）。
- **影响面**：`MarketPage` 文案常量 + 一处副标题；`PortfolioPage` 一行。
- **风险**：低（纯文案），但要同步 `uiuxDiscipline` 第 ⑥ 条"文案与行为一致"的 README 表。
- **偏好对应**：2（诚实性默认可见但不臃肿）、3（长解释进悬停）。

### U5 搜索：键盘可达 + 计数文案自洽（偏好 9）

- **现状**：候选行 `onMouseDown`-only（§P1-4）；`countTextOf` 在截断时输出「已显示全部 N 条（上游本次上限 M 条，可能有更多）」（`suggestView.ts:154`）——同一句里既说"全部"又说"可能有更多"。
- **建议**：
  1. 行改为 `onClick`（保留 `onMouseDown` 防止输入框失焦）；
  2. 输入框加 `role="combobox"` + `aria-expanded` + `aria-controls` + `aria-activedescendant`；容器 `role="listbox"`、行 `role="option"`；
     加 `↑/↓/Home/End` 移动 `active`、`Enter` 选中 `active`、`Esc` 关闭（不改现有"回车取第一个"的默认）；
  3. 文案改为 `已显示 ${total} 条（本次上限 ${requested} 条，上游可能有更多）`。
- **阈值**：不用鼠标，Tab 进输入框 → 输入 `600` → `↓` `↓` `Enter` 能选中第 3 条；`countTextOf` 单测快照更新为不含"全部"的句式。
- **影响面**：`ui.tsx`（SuggestInput ~40 行）+ `suggestView.ts`（1 行）。
- **风险**：中。`suggestAll.test.ts`（313 行）与 `suggestHeight.test.ts` 依赖现有文案/结构 ⇒ 需同步断言，属"有意变更"。
- **偏好对应**：9（列出全部 + 上限如实 + 长列表不卡：分批 40 已满足）。

### U6 六页签保活（keep-alive）+ 把 `active` 真正接上（偏好 10、11）

- **现状**：`index.tsx:380-421` 每次只渲染一个页面组件 ⇒ 切页即卸载，状态全丢（§P2-9）；`PortfolioPage` 的 `active`、`useMiniTrends(enabled)`、`useYtd(enabled)` 这套 gating 因此形同虚设。
- **建议**：
  1. 六个页面**全部保持挂载**，用 `display:none` 切显隐（符合项目"关闭即 display:none"的既有约定，且不动画）；
  2. 每个页面接 `active: boolean`，把**取数 effect**（board/breadth/extras/calendar/industries/anomaly/mini/ytd/ledger）在 `!active` 时短路；
  3. 把 `data-idle` 的判定从 `visible=true` 改为真实可见性（`!activeTab || document.hidden` ⇒ `enabled=false`），顺带修 §P2-6。
- **阈值**：
  - 自选页滚动 200px → 切持仓 → 切回，滚动位置与折叠状态保持；
  - 静置 60s 且面板不可见时，`/tradewatcher/quotes` 请求数 = 0；
  - 切页 p95 < 100ms（`performance.measure` 手测一次即可，见 §5）。
- **影响面**：`index.tsx` 渲染结构 + 6 个页面的取数 effect 各加一个 `active` 条件（**这是本轮改动面最大的一条**）。
- **风险**：**中-高**。保活后若漏接 gating，会变成"6 页同时轮询"（比现在更糟）。
  建议分两步：先只保活 `tools`（无轮询，纯本地状态）+ `calendar`（只有用户点同步），验证收益后再动 `market`/`watch`。
- **偏好对应**：10（常开六页签）、11（切页/长列表要顺）；同时服务 5（不新增依赖）。

### U7 请求去重：用"节拍信号"而不是"对象身份"（偏好 11）

- **现状**：`WatchlistPage:82-104`（industries）、`MarketPage:103-121`（breadth dist）、`:127-141`（extras）、`RescuePanel:410-422`（trend）都挂在会变身份的 `quotes` 上（§P2-3）。
- **建议**：
  1. 这四个 effect 的依赖改为 `quoteTs`（引擎已有，`index.tsx:387/403` 已在传）；
  2. `breadth?dist=1` 单独加 **60s** 最小间隔（宿主缓存也是 60s，`api.ts:106` 注释自证）；`extras` 用 30s；
  3. `industries` 只在 `watch` 变化 + 每 N 拍（N=6，≈60s）时刷新，而不是每拍。
- **阈值**：静置 10 分钟，Network 里 `/industries` ≤ 10 次、`/breadth?dist=1` ≤ 10 次、`/market-extras` ≤ 20 次（现状分别 ≈60/60/60）。
- **影响面**：4 个 effect 的依赖数组 + 4 个时间戳 ref。
- **风险**：低。副作用是"板块涨幅最旧 60s"——需要在对应格子 `title` 里写"板块数据每 60s 更新"（诚实性要求）。
- **偏好对应**：11（性能/顺）、5（不新增依赖、不新增取数路径）。

### U8 动效与图表交互纪律（偏好 6、11）

- **现状**：`styles.ts:462` `transition:width`（§P2-11）；K 线 `mousemove` 全量重渲染（§P2-10）。
- **建议**：
  1. 进度条改 `transform:scaleX(var(--v))`（`transform-origin:left`），过渡属性换成 `transform`；
  2. K 线/分时的 `cursor` 用 `requestAnimationFrame` 合并（每帧最多一次 `setState`），并把重绘重的部分（柱体数组）`useMemo`；
  3. 后台暂停已实现（`data-idle`），补一条：`document.hidden` 时**停 `useNow` 的 tick**（`useNow.ts:12` 现在无条件跑）。
- **阈值**：`uiuxDiscipline` 新增"`transition` 属性白名单 = {transform, opacity}"扫描；K 线拖 240 根窗口，`Performance` 里 mousemove 期间单帧 < 16ms（Chrome 手测）。
- **影响面**：`styles.ts` 1 处 + `kline.tsx` 2 处 + `useNow.ts` 1 处。
- **风险**：低-中（rAF 合并要避免"最后一帧丢失"）。
- **偏好对应**：6（只动 transform/opacity、不闪）、11（图表交互顺）。

### U9 无障碍基线（不在 11 条里，但影响"能不能用"）

- **现状**：浮层无 `role=dialog`/焦点管理/多浮层 Esc 串联（§P2-7）；点击型 div/span 不可键盘（§P2-8）。
- **建议**：`Modal` 加 `role="dialog" aria-modal="true"` + 打开时聚焦第一个可聚焦元素 + 关闭后归还焦点（`StripConfig` 已对齿轮做过这件事，`:627-631`，照抄即可）；
  Esc 监听下沉到"最上层浮层"（用一个模块级栈，`ui.tsx` 内部 8 行）；点击型行统一补 `role="button" tabIndex={0} onKeyDown`（`WatchlistPage:317-339` 已有正确范式）。
- **阈值**：只用键盘从侧栏进面板 → 打开详情抽屉 → Esc 关闭 → 焦点回到原来的卡片；两层浮层叠开时 Esc 只关最上面一层。
- **影响面**：`ui.tsx` + `QuoteDrawer.tsx` + 4 处点击型行。
- **风险**：低。
- **偏好对应**：间接服务 2（原因要能被键盘/触屏读到，项目里已有这条约定）。

### U10 徽标补"数据时刻"（偏好 8 的收尾）

- **现状**：徽标内容已符合偏好 8（标签恒「盯盘」，徽标只放当日涨跌幅，`index.tsx:120-139`、`badgeView.ts:94-121`）。
  但 `dayPnlPct === null` 时 `detail` 只有「当日盈亏 —（无持仓行情）」（`badgeView.ts:107`），**没有数据时刻**，
  而这一行是侧栏条目**唯一**的时刻出口（`index.tsx:176-183`）。
- **建议**：该分支补 `· 数据 ${asOfText}`，并把上限从 32 提到 40（实测宿主截断点见 `badgeView.ts:81` 注释）。
- **阈值**：无持仓时侧栏悬停仍能看到「数据 HH:mm:ss」；`badgeView.test.ts` 增加该分支断言。
- **风险**：低（长度只影响悬停截断）。
- **偏好对应**：8（后缀进悬停）、2（事实不消失）。

### U11 工具目录（1 个工具时"不显空"）

- **现状**：**已满足**——`ToolsPage.tsx:269-273` 在 `TOOL_ENTRIES.length <= 2` 时给一行说明；卡片是原生 `button`（键盘可达）。
- **建议（可选）**：把这一行从"常驻小字"改成卡片的 `aria-describedby` + 一行虚线占位卡（视觉上补满三列网格的第一行），
  但**不得**引入占位数据。若维持现状也符合偏好 3（简洁）。
- **阈值**：1420px 宽下，1 张卡的目录页不出现"整页只有一张卡+大片空白"的观感（截图比对）。
- **风险**：低。**偏好对应**：10。

---

## 3. 与 11 条用户偏好的逐条对照

| # | 偏好 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 缺数据必须「未取到 + 原因」，不得 0 顶替 | **未完全满足**（4 处硬伤） | 已做到：`quoteState.ts:20-25` 双词表、`ytdView.ts:26-31`、`PortfolioPage.tsx:377-387`（累计已实现宁可不给）、`MarketPage.tsx:331-339`（昨日成交不拿今天顶）。**未做到**：P0-2 / P1-1 / P1-5（把"没取到/已隐藏"说成"无源"）、P1-9（空数组顶替失败）、P3-6（`?? 0`） |
| 2 | 诚实性默认可见（降级/陈旧/缺失原因、边界、口径） | **基本满足，但有两处"看见的是错的"** | 已做到：`TopBar.tsx:470-507`（数据时刻/四态/无源/截断/备用源）、`PortfolioPage.tsx:241-248`（总额不含）、`CalendarPage.tsx:193-220`（同步降级）。未做到：P1-7（旧文案说"没这功能"） |
| 3 | 文案简洁：常驻只留值 + 短标记，长解释进悬停 | **基本满足** | 已做到：`stripTone.ts:43-77`、`MarketPage.tsx:419-435`（口径压缩为「口径 ⓘ」）、`RescuePanel.tsx:605-635`（熔断只留标记）。**退化点**：`PortfolioPage.tsx:298-301` 与 `MarketPage.tsx:196-199` 属长常驻；P3-5 文案拼接 |
| 4 | 跟随主题与红涨绿跌，不硬编码底色/涨色 | **未满足** | `styles.ts:22,40` 两档 token 已就位；但 11 个文件里有 6 位色值、`--tw-warn` 未定义（P3-1）、重要性/等级复用涨跌色（P1-10） |
| 5 | 不新增依赖、不引图表库；字号阶梯；1px 间距 | **满足** | `package.json` 零运行时依赖；`uiuxDiscipline.test.ts` ①②⑤ 全绿（35 pass）；字号 `12/12.5/13/14/15`（styles.ts 实测 103×12 / 6×13 / 3×12.5 / 1×14 / 4×15） |
| 6 | 动效只动 transform/opacity、关闭即 `display:none`、后台暂停、减少动画、不闪 | **基本满足**（1 处越界） | `styles.ts:114-119`（tw-breathe 只动 opacity + reduced-motion）、`:392-393`（shimmer 用 transform）、`:435`（抽屉 transform+opacity）、`:51`（data-idle 暂停）。越界：`:462` `transition:width` |
| 7 | 不暗示买卖、不呈现胜率/概率、不用颜色暗示主动/被动 | **未满足** | 正面：`RescuePanel.tsx:837-839` 明确"不是胜率/概率"、`:521` `aria-label` 写"非买卖建议"。**违反**：P0-3（做T 胜率）、P1-6（买卖用涨跌色） |
| 8 | 侧栏标签只显示「盯盘」，徽标显示当日涨跌幅 | **满足**（细节可补） | `index.tsx:120-139`（`label: () => '盯盘'`，时刻进 `title`）、`:176-183`；`badgeView.ts:105-121`（null→原因、0→0.0%、10+ 封顶）。补 U10 |
| 9 | 搜索列出全部匹配（分组/计数/上限披露/长列表不卡） | **满足**（可达性待补） | `suggestView.ts:150-156`（三类互斥文案）、`ui.tsx:211-255`（分组头 + 「显示更多」）、`SUGGEST_PAGE=40`。补 U5（键盘 + 一句文案） |
| 10 | 常开六个页签；工具目录 1 个工具时不显空 | **部分满足** | 页签齐全（`index.tsx:425-433`，含 gate 与失败放行）；工具目录已处理（U11）。**未满足**：切页丢状态（P2-9 / U6） |
| 11 | 性能：切页、长列表、图表交互要顺 | **部分满足** | 好：`mini.ts` 4 并发池 + 90s TTL、`chartCache.ts` 单飞合并、`engineIds.ts` 不请求隐藏卡、搜索分批渲染。不足：P2-1（无超时）、P2-3（4 处每拍重复取数）、P2-9（切页重来）、P2-10（mousemove 全量重渲染） |

---

## 4. 性价比前三（建议按此顺序做）

| 顺序 | 事项 | 为什么值 | 成本 | 风险 |
| --- | --- | --- | --- | --- |
| **① 数字诚实三连**（P0-1 + P0-2/U1 + P0-3） | 一处崩溃 + 一处常驻误报 + 一处**用户明令禁止**的胜率。三者都是"把不存在/不确定说成确定"，正是用户最在意的那类问题 | 崩溃 1 行守卫（`if (view === null) return <ErrorNote/>`）；汇总口径改 `stripRows` + 新增 `pending` 态；胜率删 1 行 | 低（改动面 `PortfolioPage` / `quoteState` / `TopBar`，需同步 2–3 个断言） |
| **② 失败原因可见**（P1-3 + U2） | 影响**所有写操作**（分组/自选/流水/日历/护盘设置），是偏好 1 的核心场景；现在失败=没反应 | 中（Modal 增加错误槽 + 6 处 `catch` 改写入本地） | 中低（`mutate` 返回 Promise，注意"失败不关窗"） |
| **③ 请求去重**（P2-3 + U7） | 4 条 effect 每 10s 各发一次全量请求，其中 `breadth?dist=1` 自述"多扫 ~56 页"；用户在意顺滑，也会触碰上游限流 | 低（改依赖 + 2 个时间戳） | 低（副作用是数据最多旧 60s，需在 title 写明） |

> 如果只能做一条：**①**。它一条同时消灭 P0 三件里的两件半（P0-1 崩溃、P0-2 口径、P0-3 胜率）。

---

## 5. 未确认项（附确认方法）

| # | 未确认的事 | 为什么没确认 | 怎么确认 |
| --- | --- | --- | --- |
| 1 | **渲染期是否真的崩**（P0-1） | 本机无浏览器自动化、无宿主运行实例；只做到"代码路径 + `strict:false`"级证明 | 在 `/tmp` 副本里把 `/tradewatcher/portfolio` 打成 503（或停宿主路由）→ 打开持仓页，看是否白屏 / 控制台 `TypeError` |
| 2 | 颜色对比度数值（U3 阈值 4.5:1） | 只做了人眼估算与常识判断，未跑脚本 | 用 8 行 node 脚本算 WCAG 对比度（`#e0a94a` on `#ffffff` ≈ 1.9:1） |
| 3 | K 线 mousemove 掉帧（P2-10） | 需要真实渲染 | Chrome Performance 录制：拖到 240 根窗口、来回移动 3 秒，看单帧耗时与 FPS |
| 4 | 保活方案的收益/风险比（U6） | 未实现，无法测；`active` gating 是否覆盖全部 effect 需逐页核对 | 先只保活 `tools`+`calendar`，观察 60s 内请求数不上升，再逐步放开 |
| 5 | 「已截断 160」是否会漂（P2-12） | 当前 `MAX_QUOTE_IDS=160` 与文案一致（`host/routes.ts:125`） | 把常量挪进 `src/shared/model.ts` 并在两端引用；断言客户端文案由常量生成 |
| 6 | `1.000012` 是否就是用户实际隐藏的那张卡 | 仓库注释这么写（`engineIds.ts:7-9`），但本机 `~/.dsh/dsh-tradewatcher/prefs.json` 未读（本轮不碰用户数据） | 读 `prefs.stripCfg.hidden` 或在 1420px 面板上数卡片数 |
| 7 | 六个页签是否真的"同时"常开（宿主是否卸载非活跃面板） | 宿主 shell 的 `main` slot 生命周期不在本仓库 | 在 RSH 里切走再切回，看自选页滚动位置是否复位（现在预期复位） |
| 8 | `_props` 未使用（`CalendarPage.tsx:44`）是否会被 `noUnusedParameters` 放过 | `tsc` 通过，说明 `_` 前缀豁免生效；但字段本身是死参数 | 直接删 `_props`：`CalendarPage` 在 `index.tsx:412` 是唯一调用方 |

---

## 附录 A：本轮读过的文件与关键行

- 已全量阅读：`index.tsx`、`ui.tsx`、`TopBar.tsx`、`WatchlistPage.tsx`、`PortfolioPage.tsx`、`MarketPage.tsx`、`CalendarPage.tsx`、`RescuePanel.tsx`、`QuoteDrawer.tsx`（头部 + 渲染骨架 + 错误路径）、`suggestView.ts`、`api.ts`、`quoteState.ts`、`stripTone.ts`、`badgeView.ts`、`theme.ts`、`format.ts`、`marketTime.ts`、`engineIds.ts`、`chartCache.ts`、`useQuotes.ts`、`useYtd.ts`、`usePageIdle.ts`、`idle.ts`、`mini.ts`、`alerts.ts`、`useNow.ts`、`ytdView.ts`、`watchlistView.ts`。
- 定向阅读（按需）：`kline.tsx`（游标/滚轮/缩放窗）、`ToolsPage.tsx`（目录/空态/分类 tab）、`styles.ts`（token/动效/焦点）、`toolRegistry.ts`（目录数据）。
- 未展开：`charts.tsx`、`CloudMap.tsx`、`ChipsPanel.tsx`、`chipsView.ts`、`distView.ts`、`breadthView.ts`、`StripConfig.tsx`、`BulkPaste.tsx`、`sort.ts`、`suggestView` 之外的纯逻辑模块——它们不在本轮指定的 18 个文件清单里，或只被用于交叉验证。

## 附录 B：与既有报告的关系

- `docs/REVIEW-2-CORRECTNESS.md`（R5 时区红线）：本轮发现**两处回归**（P1-8），都在 `RescuePanel.tsx`，说明"固定北京时间"的纪律没有做成**结构性防线**（`toTimeString()` 仍可编译、仍能通过现有断言）。
  建议增加一条可检查断言：`src/client/**` 出现 `toTimeString|toLocaleTimeString|getHours()` 即红（`watchlistView.ts:16` 有一处 `toLocaleTimeString` 但显式传了 `timeZone: 'Asia/Shanghai'`，需在白名单里注明理由）。
- `docs/REVIEW-6-ENGINEERING.md` §5（文档权威性）：本轮新增两处"文案与实际行为不一致"（`MarketPage.tsx:196-199,344`），与本报告 U4 同一根因。
