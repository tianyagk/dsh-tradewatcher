# 客户端性能 · 定时器 · 数据获取审计（v0.214.0）

> **只读审计，不改代码。** 本轮只新增本文件，未触碰 `src/**`，未 commit，未重启。
>
> 基线（任务给定）：`npm run check` 1811/1811 全绿、构建 73、`v0.214.0`（`67cdde3`）、工作树干净。
> 审计范围：`src/client/**`（含 `tools/` 子目录），重点 `PrismPage.tsx`（棱镜）与 `MarketPage.tsx`（大盘）。

---

## 一、结论

**没有发现 P0（无崩溃路径的稳定复现、无无限请求、无静默错数的必然路径）；但有 8 条 P1：其中 3 条是「页面开着就一直在花钱 / 烧 CPU」的结构性问题（P1-1 / P1-2 / P1-3），3 条会在真实操作序列下把错误数据画到屏幕上（P1-5 / P1-6 / P1-7）。**

| 级别 | 条数 | 说明 |
|---|---|---|
| **P0** | **0** | 崩溃/无限请求/必然错数：未发现（判据见 §2） |
| **P1** | **8** | 可感知的性能退化、资源浪费，或低频路径上的错误数据/白屏 |
| **P2** | **17** | 余量、防御性、可维护性；单条影响小，叠加后是 P1 的放大器 |
| 合计 | 25 | |

一句话：**棱镜页的问题是"保活 + 1s 时钟 + 30s 轮询"三件事各自都对、叠在一起就不对；大盘页的问题是"整页没有一个 memo 边界，而鼠标每移动一次就 setState 一次"。**

---

## 二、方法与口径

- 读代码为主，辅以模式扫描。镜像里**没有 `rg` 二进制**（`command -v rg` 为空），用等价的 `grep -rn` 完成同一组模式：
  `setInterval`、`useEffect(`、`addEventListener`、`fetch(`、`JSON.parse`、`toFixed(`、`Date.now()`、`React.memo`、`useMemo/useCallback`、`key: i`。
- 量级：`src/client/**` 共约 43.5k 行；重点文件 `PrismPage.tsx` 917 行 / 274 处 `createElement`，`MarketPage.tsx` 616 行 / 138 处 `createElement`，`RescuePanel.tsx` 1049 行，`PortfolioPage.tsx` 1445 行。
- 分级口径（沿用仓库既有审计）：
  - **P0**：崩溃、必然错数、请求风暴、无界内存增长；
  - **P1**：稳定可感知的性能/资源问题，或**特定但真实的操作序列**下的错误数据、白屏；
  - **P2**：余量、防御性、可维护性、单条影响轻微。
- 所有行号对 `67cdde3`（v0.214.0）成立。

---

## 三、P0（0 条）

无。

已按 P0 判据逐条排除：`useQuotes` 有 `inFlight` 去重 + 请求代号 + 15s 超时（`api.ts:270-320`、`useQuotes.ts:70-146`），行情主链路不会停摆；`chartCache` 有 160 条上限与淘汰（`chartCache.ts:164,226-247`）；决策流已截断到 60 条（`prismDeskMid.ts:613-614`）；未发现无 cleanup 的常驻 `setInterval`。

---

## 四、P1（8 条）

| # | P0/P1/P2 | 问题 | 证据 | 影响 | 建议修法 |
|---|---|---|---|---|---|
| P1-1 | P1 | **棱镜是保活页，但 30s 静默刷新只判「文档隐藏」，不判「本页是否当前页」**。切到自选/持仓后，棱镜仍在每 30s 拉一次 `/prism`；`visibilitychange` 守卫对 `display:none` 完全无效（文档仍是 visible）。`PrismPage` 收了 `active` 却全文没用。 | `src/client/index.tsx:245` `const KEEP_ALIVE = ['calendar','tools','fupan','prism']`；`index.tsx:470` 恒挂载并传 `active: page === 'prism'`；`PrismPage.tsx:186` 签名有 `active?`，`grep props.active` 无命中；`PrismPage.tsx:227-230` `setInterval(() => { if (document.visibilityState === 'hidden') return; refresh() }, 30_000)` | 面板停在其它页签时仍 2 次/分请求 + 每次 `setState` 让整棵隐藏树重渲染；并把整份回包（300+ runs、fills、equity）常驻内存不释放。 | 定时器 effect 依赖 `[active, refresh]`；`active !== true` 时不建 interval；回调里先 `if (!active) return`。可选：失活 5 分钟后把 `state` 置 `null` 释放内存。 |
| P1-2 | P1 | **每次保存成功都触发一次"真实 LLM 自检"**：`load()` 同时跑 `prismState()` 与 `prismSelftest()`，而 selftest 在宿主侧是真的发起一次 `ctx.llm.stream`。加/改/删持仓、存约束、改资产上限、改周期，全部走 `load()`。 | `PrismPage.tsx:212-215` `const load = ... api.prismState()...; api.prismSelftest()...`；调用点 `:307`（run）、`:324`、`:342`、`:361`、`:381`；`api.ts:604` 注释「运行时自检：真实调用一次 ctx.llm.stream（永远 200）」；`src/host/prismRoutes.ts:752-754` `streamText(..., [{role:'user',content:'只回复 OK'}], undefined, AbortSignal.timeout(20_000))` | 一次保存 = 一次计费模型调用 + 后台最长 20s 占用；连点 N 次保存就是 N 次。用户以为只是写本地 JSON。 | 拆成 `loadState()`（只拉 `prismState`）与 `runSelftest()`；所有写成功后只 `loadState()`；自检只在首次进入/手动点击时跑，并加 5 分钟缓存。 |
| P1-3 | P1 | **页面根节点挂 `useNow(1000)`，秒针每跳一次就把整个三栏重建一遍**。全页 5 处 `useMemo` 只覆盖 `chartNode` 与决策流的四个 memo（`flowEntries`/`flowCounts`/`flowView`/`feedCard`），其余 8 个子树（顶栏/上限卡/持仓/详情/总览/右栏/绩效/状态条）每秒重新计算与协调；其中还有 4 处未 memo 的 O(n) 派生。 | `PrismPage.tsx:210` `const now = useNow(1000)`；`:420` 只用来显示 `shClockText(now)`；`:396-399` 每渲染 `posRows.map`；`:598` `fillMarksOf(fills, picked)`；`:837` `sparkOf(...)`；`:861-870` `statusFactsOf({... blockedTodayOf(orders, runs, day)})` | 1 Hz 恒定 CPU/GC：每次约 300 个元素重建、若干数组分配；页面开着就一直在跑，隐藏时同样跑（见 P1-1）。 | 把时钟拆成 `<AgentClock/>` 子组件（1s state 只在该子树内），其余部分不再随秒针渲染；同时把 `active` 传给 `useNow` 或只在可见时 1s、不可见时 60s。 |
| P1-4 | P1 | **大盘页「汪汪队」两张 SVG 的 `onMouseMove` 直接 `setDwTip`**，每次鼠标移动都让整页重渲染——包括同页的 `RescuePanel`（1049 行）与 40 行板块表。仓库已有 `createRafCoalescer` 却没用在这里。 | `MarketPage.tsx:319-330` `const dwHover = (e, kind) => { ... setDwTip({ x, y, text }) }`；`:335`/`:343` `onMouseMove={(e) => dwHover(e,'bar')}`；`:376` 同页渲染 `RescuePanel`；对照 `kline.tsx:259-266` 已有 `createRafCoalescer(...)`（泛型参数已在源码里）；`RescuePanel.tsx:233` 用 `tip.textContent = ...` 直写 DOM（正确做法） | 一次 mousemove ≈ 250 根 `<rect>` + 折线 + 6×9 表格 + 护盘面板全量 diff；120Hz 鼠标下主线程饱和、明显掉帧。 | 用 `createRafCoalescer` 合并 `dwTip`；更好的是照 `RescuePanel` 的做法用 ref 直写 tooltip 的 `textContent/left/top`，完全不走 React state。 |
| P1-5 | P1 | **「加载更多」没有在途守卫，按钮也不 disabled**；`loadBoard` 无请求代号。连点两次会对同一页发两次请求，并把两批行都追加进 `rows`。 | `MarketPage.tsx:529` `Btn({ onClick: () => loadBoard(scope, sort, page + 1, true) }, '加载更多')`（无 `disabled`）；`:78-92` `setRows(prev => append ? [...prev, ...r.rows] : r.rows)`；`:477` ``key: `${r.code}-${i}` `` | 表格出现 40 行重复 + React 重复 key 警告；`setPage(pn)` 两次同值，页码只 +1，后续还会重复拉同一页。 | `boardLoading` 时禁用按钮；`loadBoard` 加 `inFlight` 或 `createRequestGen` 代号；key 改 `r.code`（ETF 唯一）。 |
| P1-6 | P1 | **切 scope/sort 时没有请求代号或 abort**：effect 先 `setRows([])` 再发请求，旧 scope 的慢响应落地会覆盖新 scope 的行。 | `MarketPage.tsx:98-103` `useEffect(() => { setRows([]); setPage(1); loadBoard(scope, sort, 1, false) }, [scope, sort, loadBoard])`；`:78-92` 直接 `setRows(...)`；`api.board` 未透传 `AbortSignal` | 表头写「概念板块」、内容是「行业板块」的行，`boardMeta/total` 一起错位；界面上没有任何提示。 | 每个 effect 领一代（`createRequestGen`），落地前 `if (gen.stale(my)) return`；或给 `api.board` 加 `signal` 透传并在 cleanup `abort()`。 |
| P1-7 | P1 | **ETF 行点击 `openDetail` 连发 `/detail` + `/trend`，无代号**：连点两只 ETF 时，后到的旧响应会覆盖新选择。 | `MarketPage.tsx:163-172` `setPick({secid}); setDetail(null); setTrend(null); api.detail(secid).then(r => setDetail(r.detail)); api.trend(secid).then(r => setTrend(r.trend))` | 详情卡显示 A 的行情/分时、标题却是 B，或反之——静默错数，用户没有任何线索。 | 与 P1-6 共用一套 `requestGen`（按 secid 判代）；或直接复用共享的 `QuoteDrawer`（`index.tsx:580` 已用 `key={detail.secid}` 做隔离）。 |
| P1-8 | P1 | **RescuePanel 的时间戳守卫漏了 `undefined`**：`lastSampleTs !== null` 在字段缺失时成立，`shClockText(undefined)` → `new Date(undefined)` 非法 → `Intl.formatToParts` 抛 `RangeError`。 | `RescuePanel.tsx:634` `snapshot.lastSampleTs !== null ? shClockText(...) : ''`；`:653`、`:664` 同款；同文件 `:654`/`:671` 却写了 `!== null && !== undefined`（说明作者知道要防，但只防了一半） | 渲染期抛错 → 大盘页整块白屏（本插件客户端无 error boundary）；触发条件是宿主回包缺字段，而同仓 `RescuePanel.tsx:458` 的注释已承认「host 侧改动需重启 dsh web」是常态。 | 统一 `typeof ts === 'number' && Number.isFinite(ts) && ts > 0`；更省事的是在 `marketTime.ts` 的 `shDateTimeText` 入口对非法值返回 `—`，一处覆盖所有调用点。 |

---

## 五、P2（17 条）

| # | P0/P1/P2 | 问题 | 证据 | 影响 | 建议修法 |
|---|---|---|---|---|---|
| P2-1 | P2 | **`/breadth` 每拍都请求，但结果从未渲染**（只有 `void breadth`）；注释声称的「最小间隔 60s」并未实现，`EXTRAS_MIN_INTERVAL_MS` 被 `void` 掉。 | `MarketPage.tsx:118-121` 注释「并且最小间隔 60s」；`:126-127` `const amountForForecast = null` / `void breadth`；`:139-144` effect 依赖 `[props.quoteTs, mkRetry]`；`:245` `void ...; void EXTRAS_MIN_INTERVAL_MS` | 盘中每小时约 60 次无效请求（宿主侧要扫 1 页），且注释与实现不一致，后人会照注释以为已节流。 | 删除该请求与 state；若要保留，改成 `dueByInterval(now, last, BREADTH_MIN_INTERVAL_MS)` 并在界面上真的消费它。 |
| P2-2 | P2 | **`/marketExtras`（两融/涨跌停/全天预测，宿主侧最重的一条）只为 `data-limits` 一个排障属性而请求**，界面不展示任何字段。 | `MarketPage.tsx:147-151` `api.marketExtras(null)...`；唯一消费点 `:372` `'data-limits': ${extras?.limits.up.count ?? ''}/${extras?.limits.down.count ?? ''}` | 每次进入大盘页 1 次重请求；失败也静默（`catch(() => undefined)`）。 | 删除；或改成 `?debug=1` 才拉，并把结果写进 `title` 而不是 attr。 |
| P2-3 | P2 | **1s 重渲染路径上还有 4 处未 memo 的派生**：`fillMarksOf(fills, picked)`（全量成交 filter + sort，只为取最后 2 条）、`sparkOf(equity)`、`accountViewOf`（遍历 rows+equity）、`statusFactsOf/blockedTodayOf`（扫全部 runs/orders）。 | `PrismPage.tsx:396-399`、`:598`、`:724-733`、`:837`、`:861-870` | 每次 tick 都有 O(fills+runs+equity) 的无谓计算与分配；与 P1-3 相乘。 | 分别 `useMemo(..., [fills, picked])` / `[state]`；`fillMarksOf` 内部改成一次倒序遍历取末 2 条，不 `sort` 全量。 |
| P2-4 | P2 | **30s 刷新一落地就重建整条决策流**：`flowEntriesOf` 对 300+ runs 全量展开，`flowCountsOf`/`flowFilterOf` 再各扫一遍，60 张卡片元素全部重建（`flowEntryNode` 每次返回新树）。 | `PrismPage.tsx:688-698`（三个 `useMemo`）；`:701-719`（`feedCard`）；`prismDeskMid.ts:613-622`（`FLOW_RENDER_MAX = 60`） | 每 30s 一次约 600–1000 节点的 diff；数据没变时也照做（宿主每次回包都是新对象）。 | 对回包做内容指纹（`runs.length` + 首末 `id/at`）相同则跳过 `setState`；`flowEntryNode` 结果按 `e.id` 缓存复用。 |
| P2-5 | P2 | **每个文本块一个 `ResizeObserver` + `useLayoutEffect` 里「加 class → 读 scrollHeight → 去 class」的同步测量**：60 条 × 3 段 = 最多 180 个观察者 / 180 次强制布局。 | `PrismPage.tsx:87-108`（`check()` 在 `:97-102`，`new ResizeObserver(check)` 在 `:106`） | 首次进入棱镜、切决策流 tab 时集中同步布局；窄栏 resize 时 180 个回调同时跑。估算 20–90ms，建议用 Performance 面板复核。 | 改成一个 `ResizeObserver` 观察容器，统一在 `requestAnimationFrame` 里批量测量；或用「按字数/行高估算 + CSS line-clamp」避免读写交替。 |
| P2-6 | P2 | **全仓 0 处 `React.memo`**，TopBar 与各页面在每次 tick 全量重渲染；`MarketPage` 616 行 0 处 `useMemo`、`RescuePanel` 1049 行 0 处。 | `grep -rn "React.memo" src/client` → 0 命中；`MarketPage.tsx` 只有 1 处 `useCallback`（`:78`，另 1 次是 import）；`RescuePanel.tsx` 只有 1 处（`:441`） | 任何一个父级 state（mousemove、每分钟时钟、每 10s 时钟）都会带走全部子块——P1-4 的放大倍数就来自这里。 | 先给 `RescuePanel`、`TopBar`、`Sparkline`/`MiniTrend` 加 `React.memo`（它们的 props 已基本是原始值或稳定引用）。 |
| P2-7 | P2 | **`chipsLoader` 的模块级 Map 无上限、无淘汰**（`resetChipsCache` 只在测试里调），每条是完整筹码载荷（注释：84 KB）。 | `chipsLoader.ts:22` `const cache = new Map<string, Entry>()`；`:35` 的 60s TTL 只影响回源、不删旧条目；`api.ts:7` 注明单包 84 KB | 看过 N 只标的就常驻 N×84 KB（50 只 ≈ 4 MB），SPA 会话内不释放。 | 加 `MAX_ENTRIES`（如 24）按 `at` 淘汰；或关闭抽屉/切标的时清空。 |
| P2-8 | P2 | **`useMiniTrends` 每个 tick 对最多 80 个标的各发一次 `/trend`**（4 并发池），且每行结果单独 `setData`。 | `mini.ts:33` `MAX_ROWS = 80`；`:74-83` `runPool`（4 并发）；`:95-108` `sink` 逐行 `setData`；`:130` ticker 每拍 `fill()` | 自选页开着时每分钟 40–80 个 `/trend`（90s TTL 下约一半回源），并触发最多 80 次整页重渲染（无 memo）。 | 缩略图改为首屏 + 每 5 分钟；或合并成一个批量接口；`sink` 用一次微任务/rAF 合并 `setData`。 |
| P2-9 | P2 | **抽屉分隔线拖拽每次 `mousemove` 都 `setDragRatio`**，整抽屉（含 240 根 K 线 + 筹码 SVG）重渲染；`window` 上的 move/up 监听只在 `mouseup` 里移除，拖拽中卸载会残留。 | `QuoteDrawer.tsx:876-895` `const move = (ev) => setDragRatio(...)` / `window.addEventListener('mousemove', move)` / `up` 里才 remove | 拖拽明显掉帧；闭包持有 `avail/commitRatio`，卸载后仍挂到 `mouseup`（一次性泄漏）。 | `createRafCoalescer` 合并；监听用 `useEffect` 注册并在 cleanup 移除（或 `setPointerCapture`）。 |
| P2-10 | P2 | **时间戳 0/缺失没有按「无效」处理**：`shClockText(o.decidedAt)`（0 或 1 会显示 `08:00`）、`boardMeta?.asOf !== undefined`（0 会显示 `08:00:00`）、`shClockText(p?.t ?? 0)`。 | `PrismPage.tsx:807` ``shClockText(o.decidedAt).slice(0, 5)``；`MarketPage.tsx:438`/`:449` ``boardMeta?.asOf !== undefined ? shClockText(...)``；`RescuePanel.tsx:233` `shClockText(p?.t ?? 0)`；正例 `prismDeskMid.ts:626` `at <= 0 ? '—'` | 把「没有时刻」显示成一个具体时刻（1970-01-01 08:00 北京时间），静默错数。 | 统一 `Number.isFinite(ts) && ts > 0` 守卫；最好在 `shDateTimeText` 入口兜底返回 `—`。 |
| P2-11 | P2 | **`QuoteDrawer` 在 render 体内联调 `Date.now()`** 计算「滞后 N 天」文案：非纯渲染，也没有时钟驱动。 | `QuoteDrawer.tsx:622-632` `trendCaliberOf({ ..., now: Date.now(), ... })` | 同一 props 两次渲染可能给出不同文案（StrictMode 双渲染不一致）；页面停着不动时「滞后 N 天」不会跨日更新。 | 用 `useNow(60_000)` 的 `now` 作为输入并进依赖；或改成只依赖 `last.label` 的纯函数。 |
| P2-12 | P2 | **`CalendarPage` 的「今天」只在渲染时算一次**，而它是保活页；跨零点后 `is-today` 与「即将发生」列表不再更新。 | `CalendarPage.tsx:54-56` `const today = shToday()` 进 `useState` 初值；`:131` `visible.filter(e => e.date >= today)`；`:271` `c.date === today` | 日历页开着过夜会高亮错一天；`today` 变化也不触发重渲染。 | 用 `useNow(60_000)` 派生 `shToday()`，或在 `visibilitychange` 时重算。 |
| P2-13 | P2 | **K 线游标每帧更新都重算可见窗口极值并重建 240 根柱**；rAF 只合并了 `setState`，没有减少渲染量。 | `kline.tsx:653-657` `bars.slice(s,e).map(...)` / `Math.max(...visHigh, ...maVisible)`（`closes/mas/macd` 在 `:638-640` 已 memo，极值与柱子没有） | 鼠标在图上移动时每帧一次 O(240×3) 计算 + 全量 SVG diff；窗口拉满时可能掉帧。 | 极值 `useMemo` 到 `[bars, s, e, mas]`；游标改成独立覆盖层（`<g>` 只画十字线），柱子不进渲染路径。 |
| P2-14 | P2 | **`viewRows` 在 render 体里 `[...rows].sort(...)`**（占比口径下每次渲染都排 40 行），而该页每次 mousemove/每分钟都会重渲染；表格 key 含索引。 | `MarketPage.tsx:64-73`；`:477` ``key: `${r.code}-${i}` `` | 与 P1-4 叠加成「每次移动排一次序」；key 漂移让行组件在重排/追加时重建。 | `useMemo([rows, moneySort, sort, scope])`；key 用 `r.code`。 |
| P2-15 | P2 | **TopBar 悬浮卡定位每次 mousemove 都遍历全部 overflow 祖先并 `getComputedStyle` + `getBoundingClientRect`**，然后写 `style.left/top`（读写交替）。 | `TopBar.tsx:236-272`（循环在 `:248-260`）；`:352-356` `moveCard` 内 `applyPos()` | 悬浮卡打开期间每次移动都强制样式/布局计算；面板嵌套 10+ 层时单次约 1ms。 | 裁剪区在 `mouseenter` 时算一次并缓存，移动时只做加减 + 写 `transform: translate3d`。 |
| P2-16 | P2 | **散落的 `toFixed` 只判 `null` 不判有限**；主出口 `format.ts` 全部有 `Number.isFinite`，脱出口没有。 | `grep -rn "toFixed(" src/client` 共 184 处；正例 `format.ts:5-9`；反例 `MarketPage.tsx:499` `r.turnover.toFixed(2)`、`ChipsPanel.tsx:126-128`、`PortfolioPage.tsx:1190`、`RescuePanel.tsx:107` | 上游若给 `NaN/Infinity`（宿主拼装错误、除零）会渲染 `NaN%` / `Infinity%`——「看着像数的错数」。JSON 会先把 NaN 变 null，所以实际概率低。 | 统一走 `format.ts` 出口；确需就地格式化时先 `Number.isFinite(v) ? v.toFixed(n) : '—'`。 |
| P2-17 | P2 | **定时器叠加：同一屏最多 4–5 个独立 `setInterval`**，`useNow` 每个实例各建一个（TopBar 10s / 棱镜 1s / 大盘 60s），互不同相，提交时刻被打散；仓库已有「全仓唯一主 tick」的先例，却没有「全仓唯一秒 tick」。 | `TopBar.tsx:222` `useNow(Math.max(5, prefs.refreshSec) * 1000)`；`PrismPage.tsx:210` `useNow(1000)`；`MarketPage.tsx:55` `useNow(60_000)`；`GlobalClockPage.tsx:144` `setInterval(..., 1000)`；`RescuePanel.tsx:472` 轮询；对照 `ticker.ts:5` `TICK_MS = 60_000` | 多个不同相位的时间源让 React 在同一秒内多次提交；每个 interval 各自持有一份闭包。单条影响小，但与 P1-3 叠加后是「秒针抖动 + 页面重渲染」的观感来源。 | 抽一个 `secondTicker.ts`（照 `ticker.ts` 的订阅模型，`subs.size===0` 时停表），`useNow` 改为订阅它并按需降频；页面隐藏时统一停表。 |

---

## 六、专项：棱镜页 `PrismPage.tsx`

### 6.1 重渲染路径

```
Dashboard (index.tsx)
└─ <div data-keepalive="prism">        ← 恒挂载，非当前页时 display:none
   └─ PrismPage
      ├─ useNow(1000)                  ← 每秒 setState（P1-3）
      ├─ 顶栏 topbar                    ← 每次重建（只用到 now）
      ├─ 左栏 cap / pos                 ← 每次重建（posRows map 每秒新数组）
      ├─ 中栏 detailCard                ← 每次重建（chartNode 内部 memo，外层不 memo）
      ├─ 中栏 feedCard                  ← ✅ useMemo 锁住（每 30s 刷新时才重建）
      ├─ 右栏 acctCard / panelCard / perfCard ← 每次重建
      └─ 底栏 statusBar                 ← 每次重建（blockedTodayOf 扫全部 runs）
```

结论：**「每秒一次的重渲染」是设计上的意外，不是需求**——只有顶栏那 8 个字符的时钟需要 1s 精度。

### 6.2 决策流 300+ 条：已缓解，但不是零成本

- 已截断：`prismDeskMid.ts:613-614` `export const FLOW_RENDER_MAX = 60`，`flowWindowOf` 先过滤再 `slice(0, 60)`，页脚如实写「仅显示最近 60 条 · 共 N 条」。**所以不会一次渲染上千节点**——这是本轮唯一「重点项已缓解」的地方。
- 剩余成本在**派生层**：`flowEntriesOf` 仍按 300+ runs 全量展开（每轮 1 条 SCAN + 每条 reject/clampEvent/analysis 各 1 条 + 每笔 order 1 条 + 每个持仓 1 条 HOLD），`flowCountsOf` 再全扫、`flowFilterOf` 再全扫+排序；30s 一次，数据没变也照做（P2-4）。
- 单个文本块用 `FlowTextView`：60 条 × 3 段 → 最多 180 个 `ResizeObserver` 与 180 次同步测量（P2-5）。

### 6.3 30s 静默刷新

- 设计正确的一半：只拉 `prismState`、不跑 selftest、不清错误（`PrismPage.tsx:223-225`，并有 `prismAutoRefresh.test.ts ②` 守着）。
- 设计缺失的一半：**不判 `active`**（P1-1），且没有 in-flight 合并——`load()` 与 `refresh()` 在首屏同一秒可能并发同路由请求（概率低，但结构上存在）。

### 6.4 已核对无问题

- `detail` / `chart` 两个 effect 有 `alive` 标志，切换标的不回写旧响应（仅浪费一次带宽，未 abort）。
- 图表全是 SVG，无 canvas/echarts 实例 ⇒「chart 未 dispose」不适用。
- `flowEntryNode` 的 key 是 `e.id`（scan-时间戳 / rej-secid-side / clamp-at-secid-dim），稳定。
- 所有用户可见数值走 `prismDesk*.ts` 的 `finite()` 守卫（`weightOf` / `pnlPctOf` / `usageOf` / `orderProgressOf` 都先 `Number.isFinite`）。

---

## 七、专项：大盘页 `MarketPage.tsx`

### 7.1 一次 mousemove 到底重渲染了什么

`onMouseMove` → `dwHover` → `setDwTip` → `MarketPage` 重渲染，于是：

1. `(() => {...})()` 这个**写在 JSX 里的 IIFE 每次渲染都重跑**：`dwTable/dwReview/dwKpis/dwSeries` 重新计算（`MarketPage.tsx:249-252`）；
2. 两张 SVG 重建：约 250 根 `<rect>` + 折线 + 轴刻度（`:256-272`、`:300-315`）；
3. 汪汪队表格 6 行 × 9 列重建（`:347-351`）；
4. 40 行板块表重建（`:472-521`）；
5. 同页 `RescuePanel` 全量重渲染（`:376`，1049 行组件，无 memo）。

**这就是 P1-4。** 对比：`RescuePanel` 的同一类悬停（`:230-235`）是直写 `tip.textContent`，`TopBar` 悬浮卡移动时也只写 `style`、不 `setState`——同一仓库里已经有正确写法。

### 7.2 请求清单（进入页面及之后）

| 路由 | 触发 | 是否被渲染 | 评价 |
|---|---|---|---|
| `/board` | scope/sort 变化、加载更多 | 是 | 必须；缺请求代号（P1-5/6） |
| `/dogs`（dogwatch） | 窗口切换、重试 | 是 | 合理 |
| `/breadth` | **每拍 `quoteTs` 变化** | **否**（`void breadth`） | 死请求（P2-1） |
| `/marketExtras` | 重试 | 仅 `data-limits` 属性 | 死请求（P2-2） |
| `/detail` + `/trend` | ETF 行点击 | 是（内部 DetailModal） | 竞态（P1-7） |

### 7.3 已核对无问题

- `useNow(60_000)` 的粒度对「定稿/盘中」判定足够（`cnSessionState` 只到分钟）。
- 板块表 `viewRows` 的「本页 40 条内重排」口径有注释与界面说明，不是全市场排行，语义诚实。
- `loadBoard` 失败会写 `boardError` 并有 `ErrorNote`，不是静默吞错。
- 备用源（腾讯/新浪）不含资金流字段时按钮置灰并给 `title` 说明，无「看着能用的空功能」。

---

## 八、Top 5（按「先修收益 / 成本」排序）

| 排名 | 对应条目 | 标题 | 为什么先修 | 预估工作量 |
|---|---|---|---|---|
| 1 | **P1-2** | 每次保存都触发一次真实 LLM 自检 | 唯一「直接花钱」的一条；一次保存成功 = 一次模型调用 + 最长 20s 后台占用。拆 `load()` 即可，不涉及 UI。 | ~0.5h |
| 2 | **P1-1** | 棱镜保活页 30s 轮询不看 `active` | 切走后仍在请求 + 整树重渲染 + 大回包常驻内存；加一个 `active` 判断即可停掉。 | ~0.5h |
| 3 | **P1-3** | 根节点 `useNow(1000)` 每秒重建整个三栏 | 棱镜是常开页，1 Hz 是持续的 CPU/GC 底噪；拆出 `<AgentClock/>` 子组件即可，视觉零变化。 | ~1h |
| 4 | **P1-4** | 大盘页 mousemove 每次整页重渲染 | 用户能直接感知的掉帧，且同页还带着 1049 行的护盘面板；用仓库现成的 `createRafCoalescer` 即可。 | ~1h |
| 5 | **P1-8** | `shClockText(undefined)` 抛 RangeError → 白屏 | 后果最重（整页白屏）、修法最便宜（入口兜底 + 一处守卫）；属于「花 10 分钟买保险」。 | ~0.3h |

> 次优先：**P1-5 / P1-6 / P1-7** 是同一类问题（大盘页三个请求都没有代号），建议用同一套 `createRequestGen` 一次修完，再补两条断言（连点两次只发一次、切 scope 后旧响应被丢弃）。

---

## 九、附：已核对且未发现问题（避免下一轮重复劳动）

1. **行情主链路**：`useQuotes` 有 `inFlight.current` 去重、`createRequestGen` 代号丢弃旧响应、15s 超时（`useQuotes.ts:70-146`、`api.ts:270-320`）；单 tick 只发 1 次 `/quotes`。
2. **主 tick 唯一**：`ticker.ts:5` `TICK_MS = 60_000` 是全仓唯一报价定时器；5 个消费方（主引擎 `useQuotes.ts:140`，加 `index.tsx:86`、`mini.ts:130`、`PortfolioPage.tsx:158`、`GlobalClockPage.tsx:165`）都在 effect cleanup 里退订，`subs.size === 0` 时 `clearInterval`。
3. **事件监听**：`PrismPage`(visibilitychange)、`usePageIdle`、`ui.tsx`(Modal/Suggest/MoreMenu)、`TopBar`(resize/scroll)、`kline.tsx`(wheel/pointer) 全部有配对 `removeEventListener`；唯一例外是 P2-9 的拖拽临时监听。
4. **图表实例**：全仓无 canvas / `getContext` / echarts（`grep` 0 命中），纯 SVG，不存在「实例未 dispose」。
5. **决策流条数**：`FLOW_RENDER_MAX = 60` 已截断并在页脚披露（`prismDeskMid.ts:613-622`）。
6. **北京时间**：`marketTime.ts:34-115` 用 `Intl` 固定 `Asia/Shanghai`；未发现 `getHours()`/默认 `toLocaleString()` 用于市场时刻；`CalendarPage`/`fupanView` 的 `new Date(y,m,d)` 只做自然日加减。
7. **`toFixed` 主出口**：`format.ts` 的 `fmtPrice/fmtSigned/fmtPct/fmtAmt/fmtBig/fmtStamp` 全部先 `Number.isFinite`（余量见 P2-16）。
8. **抽屉图表缓存**：`chartCache` 160 条上限 + 过期淘汰 + 同键并发合并（`chartCache.ts:164,226-247`）；`peek()` 保证切周期不闪骨架。
9. **`PrismPage` 竞态**：`detail`/`chart` effect 有 `alive` 标志（只浪费带宽，不会串数据）。
10. **定时器清理**：`useNow`、`PrismPage` 30s、`RescuePanel` 轮询、`CloudMap` 超时全部有 `clearInterval/clearTimeout`——本轮 P1 的问题在「该不该跑」，不在「有没有清」。
11. **错误重试**：没有发现无限重试环——`mini.ts:120-128` 的补拉最多 2 次（20s 间隔），其余失败只写错误态、等下一拍；`loadBoard` 只有用户点击才重试。

---

## 十、复现与验证建议（不改码，供修复后用）

1. **P1-1/P1-3**：打开面板停在「自选」页，DevTools → Performance 录 30s：应看到每 1s 一次 React commit（棱镜隐藏树）与每 30s 一次 `/prism` 请求（Network 过滤 `prism`）。修复后两者都应消失。
2. **P1-4**：大盘页，鼠标在「汪汪队每日份额变化」图上左右移动 5s，Performance 面板应看到每帧一次长任务（>8ms）与 `RescuePanel` 的重复 render。
3. **P1-5**：快速双击「加载更多」，Network 应出现两次相同 `page` 的 `/board`，表格出现重复行 + 控制台 duplicate key 警告。
4. **P1-2**：打开棱镜 → 加一笔持仓 → Network 过滤 `selftest`，应看到一次 `/prism/selftest`，且其耗时与 LLM 首 token 一致。
5. **P1-8**：把 `/tradewatcher/rescue` 回包里的 `lastSampleTs` 删掉（mock），大盘页应白屏；修复后应显示 `—`。

---

*审计人：客户端只读审计（v0.214.0）。本文件是唯一改动；`git status` 应只显示 `docs/AUDIT-CLIENT-PERF.md`。*
