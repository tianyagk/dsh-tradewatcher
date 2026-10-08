# 功能与数据口径审计（只读代码）

对象：`dsh-tradewatcher` v0.29.0，HEAD `1d97c6c`，工作区干净。方法：静态阅读 `src/**`（13.5k 行）与 `docs/ROADMAP.md`、`README.md`「口径规范」、「CHANGELOG.md」，逐条对照四条硬约定（缺失显式化 / 降级不许假装实时 / 不许猜字段 / 声明与实现一致）。

未运行 `npm test` 与 `npm run check`（`check` 会写 `lib/` 产物，超出本次只读范围）；结论均可在标注行号处直接复核。

> 行号快照：基于 `1d97c6c` 的只读工作副本。审计期间 `src/client/sort*.ts`、`src/client/Styles`、`src/host/routes.ts`、`src/shared/model.ts` 正被并发分支（批一实现）修改，若这些文件已变更，请以本报告结论对应的语义为准（每个结论都给了函数名与判据，不只依赖行号）。

## 结论

宿主侧的核心口径（asOf/ts 分离、lkg 回填保原始时刻、isSettledOffline 零回源、复权口径进缓存键、Wilson 区间、缺价进 `unpriced[]`）落地扎实，且多数已有断言。**缺口集中在两处：客户端的"缺失 → 0"还有三处漏网；"逐源 catch 吞错"让日历与几处子模块的降级可见性失效**——恰好都发生在最需要它的时候（上游全挂）。

---

## P0（必须修）

### P0-1 大盘页用 0 顶替缺失的涨跌家数
- 现象：`MarketPage.tsx:116-119` 以 `(sh?.up ?? 0) + (sz?.up ?? 0)` 求和，`163-165` 直接把该数渲染成「上涨 / 下跌 / 平盘」；同文件 `167` 行对成交额做对了（`amountSum > 0 ? fmtAmt : '—'`）。
- 证据：`src/client/MarketPage.tsx:116,120,163-167`；宿主对同一数据的正确处理见 `src/host/routes.ts:289-298,319`（注释已写明备用源没有 `f104/f105/f106`）。
- 为什么是问题：东财不可达而走腾讯/新浪兜底时，家数字段缺失 → 页面显示「上涨 0 / 下跌 0 / 平盘 0」，会被读成"全市场无人上涨"。README:246 明令"拿不到显示 `—`，不显示 0"；同页两条数据口径相反本身也是隐患。`breadthOk`（120 行）只控制颜色且只看 `sh.up`，不拦数字。
- 建议：复用 `/tradewatcher/breadth` 的 `current`/`missing`（或把 `breadthUsable` 同款判定搬进客户端纯函数），缺失时单元格显示 `—` 并在行内提示"备用源没有家数字段，稍后随行情轮询重试"。
- 验收：把该求和抽成不引 react 的纯函数并加断言——`up` 为 `null` 时返回 `null`（渲染 `—`）而不是 `0`；`node --test` 直跑。

### P0-2 日历：全部自动源失败时，asOf 被改写成"现在"且不标降级
- 现象：`calendar.ts` 四个自动源各自 `catch {}`（`415,443,472,480`），随后 `492` 行**无条件**执行 `this.file.syncedAt = Date.now()`；工具层把该值当数据时刻、把降级绑在 `syncError` 上（`tools.ts:550-558`，注释写的是"上一次成功同步时刻"，与实际写入语义不符）；HTTP 路由同样吞掉同步异常（`routes.ts:726-730`）。
- 证据：`src/host/calendar.ts:415,443,472,480,492`；`src/host/tools.ts:550-558`；`src/host/routes.ts:726-730,741`。
- 为什么是问题：断网/东财不可用时，事件集合还是旧的那份，但 agent 与界面读到的 `asOf` 是"刚刚"、`stale=false`。README:247 明令"失败时刻不得改写数据时刻"；agent 会据此认为"日历已经刷新过，没有新事件就是没有事件"。
- 建议：拆成 `syncedAt`（最近一次**成功**同步）与 `syncAttemptAt`（最近一次尝试），四源逐源累计失败计数并写入 `missing[]`；工具与路由的 `asOf` 只认前者，全部源失败时 `stale=true`。
- 验收：`selftest` 里把宏观源打桩为抛错后调 `calendar.sync()`，断言 `syncedAt` 保持不变、`missing` 非空；再加一条断言锁住"零成功同步时 asOf 只能是 null 或上次成功时刻"。

---

## P1（应修）

### P1-1 偏好写入静默失败，界面照旧显示"已生效"
- 现象：`index.tsx:283-286` 先乐观更新本地状态、再 `api.setPrefs(patch).catch(() => undefined)`；`310-311` 的 `Alt+M` 同款且已经弹了"视图：隐身"的 toast。
- 证据：`src/client/index.tsx:283-286,310-311`；README:212 声称"非法键、非布尔方向**抛错**，界面能提示出来"。
- 为什么是问题：宿主驳回（如 `fxMode='live'`、越界汇率）或旧宿主忽略未知字段时，用户看到设置已切换、刷新后回退，全程无提示；声明与实现不一致。`SortBar`/`FxModal` 都走这条 `setPrefs`（`WatchlistPage.tsx:154`、`PortfolioPage.tsx:997`）。
- 建议：捕获失败 → 回滚本地状态 + toast 显示宿主返回的原因（复用现成的 `useToast`）。
- 验收：手工构造非法 patch（或临时让路由回 400）→ 界面必须提示且状态回滚；加一条断言覆盖"失败即回滚"的 reducer/纯函数。

### P1-2 徽标把"没有行情"写成当日盈亏 0.00%
- 现象：`index.tsx:86-91` 把 `dayPnlPct === null` 与 `=== 0` 合并在一个分支，tooltip 文案硬编码「持仓当日盈亏 0.00%（0.00 元）」。
- 证据：`src/client/index.tsx:86-91`；宿主侧未采样/无价时 `level=0`、`dayPnl` 累加为 0（`src/host/routes.ts:392,394`，`src/host/portfolio.ts:262`）。
- 为什么是问题：上游熔断时侧栏 tooltip 会给出一个确定的 0.00%，与 README:246 冲突；用户据此认为"今天没赚没亏"。
- 建议：`null` 分支文案改为「当日盈亏：—（行情源没有给出持仓价格，数据时刻 X）」，与 0 分开展示。
- 验收：把 `badgeView` 对 `dayPnlPct=null` 的输出写成断言（该函数已是纯函数）。

### P1-3 详情抽屉的行业与成交明细失败静默
- 现象：`QuoteDrawer.tsx:67` 行业失败 `catch(() => undefined)`；`68` 成交明细失败 `setTrades([])`，空 markers 又让 `kline.tsx:513` 渲染「区间内无买卖点」。
- 证据：`src/client/QuoteDrawer.tsx:67-68`；`src/client/kline.tsx:512-513,551`。
- 为什么是问题：把"取不到"说成"这只股票没有买卖点/没有板块归属"——与 P1-3 已修的 `indState` 模式（`WatchlistPage.tsx:67-95`）正好相反，同一份行业数据在自选页与抽屉页两套口径。图例里的 `区间外另有 N 笔`（`523-524`）也会一起消失，进一步掩盖。
- 建议：照抄 `indState`：给抽屉加 `{status,at,error}` 三态，失败时在图例位显示「成交明细本次取不到（原因）」；行业同理。
- 验收：断网打开抽屉 → 图例出现失败原因而非"无买卖点"。

### P1-4 护盘历史回看失败显示"当日无信号事件"
- 现象：`RescuePanel.tsx:328` 失败即 `setDayDetail({ events: [], intraday: [] })`，`DayModal` 渲染「当日无信号事件。」/「当日无抽样点（可能未处于采样时段）。」
- 证据：`src/client/RescuePanel.tsx:325-328,850,860`。
- 为什么是问题：不但把缺失说成"没有"，还给了一个错误的原因（"可能未处于采样时段"）——比沉默更容易误导。`317` 行的分时图 `setTrend(null)` 同款。
- 建议：`dayDetail` 增 `error` 字段，失败时 modal 顶部写明"历史数据本次取不到（原因），稍后重试"。
- 验收：断网打开历史回看 → 文案是失败原因而非"当日无事件"。

### P1-5 账本重放吞掉异常条目，且不告诉任何人
- 现象：`replayPosition` 对未能应用的流水执行 `try/catch` 后静默保留前值（`store.ts:259-266`），既不计数也不上抛；非有限数值直接 `continue`（`259`）。
- 证据：`src/host/store.ts:252-269`；抛错条件见 `src/host/store.ts:225,233-234,242-243`（如"卖出数量超过持仓"）。
- 为什么是问题：账本里能看到 5 笔，持仓快照却少一块，且没有任何标记说明"有 N 条流水没被应用"。这是账务口径的静默降级，用户对不上账时无从下手（导入校验会因负持仓报错，但手工改文件或历史脏数据会走到这里）。
- 建议：`replayPosition` 返回 `{state, skipped: Array<{id,reason}>}`（或并列一个 `skippedCount`），在持仓卡片与 `tradewatcher_portfolio` 的 provenance 里显示"本次有 N 条流水未能应用"。
- 验收：构造一条超出持仓的卖出流水 → 断言快照给出 `skipped≥1` 且界面/工具能读到该提示。

### P1-6 portfolio 工具的缺失清单自相矛盾、命名不统一
- 现象：`tools.ts:241-246` 把 `view.unpriced` 追加进 `missing[]`：`what` 用「名称（secid）」，而行情缺失用纯 secid（`em.ts:349`）；同一标的可能以两条不同 `why` 同时出现——`em` 侧按"有无备用源映射"判 `no-source`，`unpriced` 侧把 `no-quote` 恒判 `transient`（`243`）。
- 证据：`src/host/tools.ts:241-246`；`src/host/em.ts:346-355`；`src/host/portfolio.ts:320-325`。
- 为什么是问题：agent 会被同一标的的两条相反归因卡住（一条说"重试无效"，一条说"稍后重试"），且机械对齐做不到（命名格式不同）。`no-fx` 是本地配置缺口（`portfolio.ts:336-337`），归 `no-source` 会读成"上游没有"。
- 建议：统一 `what` 为 secid（名称放 `note`）；合并同一 secid 的条目并保留最强归因；`no-fx` 用独立的 why（如 `config`）。
- 验收：给一名无价港股持仓 → 断言 `missing` 中该 secid 只出现一次且 `why` 唯一。

### P1-7 no-source 归因只看静态映射，把瞬时故障说成结构性缺口
- 现象：`em.ts:346-355` 的 `why` 完全由 `hasQuoteFallback(secid)`（`1048-1050`）决定；东财整体不可用、该标的又没有腾讯/新浪映射时，仍判 `no-source` 并给出"重试无效"。
- 证据：`src/host/em.ts:346-355,1048-1050`；README:233 的定义是"上游**根本没有**这份数据"。
- 为什么是问题：方向错了——agent 被告知别等，而数据其实随东财恢复就有（未取到 `100.KOSPI200` 属于此类）。
- 建议：`no-source` 仅在"三源都不覆盖该 secid"时使用；东财故障期且无备用源映射时给第三种归因（如 `no-source-now` 或 `transient` + note"等东财恢复，备用源没有这个标的"）。
- 验收：把东财打桩为必失败、请求一个无备用源映射的 secid → 断言 `why !== 'no-source'`（或 note 含"等东财恢复"）。

### P1-8 卖出只校验总持仓，不看"可用（可卖）"
- 现象：客户端 `PortfolioPage.tsx:697` 只判 `qN > pos.qty`；宿主 `store.ts:234` 同样只对总持仓校验。`availableQty` 仅用于展示（`922-929`）。
- 证据：`src/client/PortfolioPage.tsx:697,922-929`；`src/host/store.ts:234`；`src/host/portfolio.ts:113-115`。
- 为什么是问题：P1-5 交付的"可用（可卖）"形同摆设——用户可以录一笔 T+1 当天买入当天卖出的流水，账本记下一个券商端不存在的成交，"当日盈亏/已实现"随之偏离真实。
- 建议：卖出表单在 `availableQty < pos.qty` 时提示"可用（可卖）X 股，今日买入部分 T+1"并要求确认（或直接驳回）；宿主侧同时校验（含 `t0` 例外）。
- 验收：建一笔当日买入的 A 股持仓 → 卖出数量超过 `availableQty` 时给出提示；加断言覆盖 `isT0Secid` 的两类分支。

### P1-9 路由层吞掉日历同步与公司行为的失败，与工具层口径相反
- 现象：`/tradewatcher/portfolio` 的 `corporateActionsFor` 失败被 `catch { actions = [] }`（`routes.ts:594-599`）；`/tradewatcher/calendar` 的 `calendar.sync` 失败被 `catch { /* 同步失败仍返回本地事件 */ }`（`726-730`），回包只有 `syncedAt`。
- 证据：`src/host/routes.ts:594-599,726-730,741`；工具层意图见 `src/host/tools.ts:531-536,553-558`。
- 为什么是问题：工具层专门写了"必须把失败写进 missing[]"的注释，却因下层逐源吞错 + 路由层吞错而拿不到失败信号；界面分不清"没有除权除息"与"日历没拿到"。
- 建议：两处把失败传到回包（如 `corporateActionsError` / `syncError`），客户端如实展示；与工具层共用同一份判定。
- 验收：让 `calendar.sync` 抛错 → `/tradewatcher/calendar` 回包含失败标记，界面出现"本次同步失败"。

### P1-10 未录入成本的持仓被当成"零成本"，凭空多出整笔浮盈
- 现象：`adjust` 未给 `price` 时沿用当前 `avgCost`（`store.ts:874-882`），而新建持仓后从未买入时 `avgCost=0`；`portfolio.ts:109` 于是算出 `浮动盈亏 = (现价 − 0) × 数量`（等于全部市值），只是百分比因 `avgCost > 0` 守卫返回 `null`。
- 证据：`src/host/store.ts:874-882`；`src/host/portfolio.ts:109,118-121,139-145`；UI 的"新摊薄成本（可留空）"见 `src/client/PortfolioPage.tsx:681,703`。
- 为什么是问题：把"成本未知"编码成 0，与"缺失不许用 0 顶替"直接冲突；总盈亏、摊薄盈亏、分组汇总会一起被污染成一个很大的正数。
- 建议：区分"成本为 0"与"成本未录入"（如 `avgCost === 0 && qty > 0 && turnover === 0` 视为未录入），该情形下市值照算、盈亏显示 `—` 并提示"请在「调整」里补成本"。
- 验收：新建持仓→调整到 100 股且留空成本 → 断言浮盈为 `null` 而非 `现价×100`；加断言锁住该分支。

---

## P2（可选，按性价比排序）

- **P2-1 涨跌家数快照的成交额用 0 顶替并落盘**：`routes.ts:289-296` 的可用性判定只覆盖六个家数字段，`amount` 缺失时写入 0，`breadth.record` 落盘后（`breadth.ts:174-180`）定稿后不再覆盖 → 假 0 永久留在 history。建议把 `amount` 纳入 `breadthUsable` 或允许 `null`；验收：amount 缺失时该日快照不落盘。
- **P2-2 `cached` 的判据在两条读路径上不同，文档两处也不同**：`quotes` 用「非交易时段 + 无兜底行 + 有价」（`em.ts:397`），`kline/trend` 用 `isSettledOffline`（`time.ts:147-151`，`em.ts:1448-1449,965-970`）；README:227 与 240 各写了一套。`model.ts:771` 注释称 `cached` 与 `stale` 并存，`quotes` 路径却要求 `staleCount===0`。建议统一判据并让文档只留一套。
- **P2-3 延迟阈值有两个来源**：宿主固定 90s（`em.ts:295,394`），客户端卡片用 `refreshSec×3`（`quoteState.ts:54`）；`refreshSec` 调到 60 时列表头"延迟 N"与卡片黄点会对不上。建议客户端也读宿主下发的阈值。
- **P2-4 `asOf` 取整批最大值**：`em.ts:393` 用 `max(at)`，一个刚更新的标的会把整批的 `asOf` 拉新，最旧那行只靠 `stale/staleCount` 兜。建议同时给 `oldestAt`，或 `asOf` 取分位数。
- **P2-5 `truncated` 会假报、非法 id 会静默消失**：`requested` 在去重前累加（`routes.ts:92-99`），`ids=1.600519,1.600519` 得到 `truncated=true`；非法 id 被 `continue` 丢弃且不计入 `requested`、不进 `missing`（`routes.ts:91-92`），`ids=FOO,1.600519` 与只请求 600519 的响应完全相同。建议分列 `duplicated`/`invalid`。
- **P2-6 搜索失败与"没有结果"不可区分**：双源失败后 `return []`（`em.ts:1714-1716,1749`），路由回 `{hits: []}`（`routes.ts:533-534`）；工具层把空结果一律归因"可能被限流"（`tools.ts:443-451`），而 `em.ts:1701-1702` 的 `query>40 → []` 也走同一分支。建议在 `searchSymbols` 返回 `{hits, failed}`。
- **P2-7 K 线 high/low 缺失用 close 顶替**：`em.ts:1374-1375,1407-1410` 两处 `num(r[3]) ?? close`，无标注 → 振幅/位置类计算在这些 bar 上静默失真。建议标 `degraded` 或该 bar 不进位置计算。
- **P2-8 护盘因子缺失的归因一刀切**：`tools.ts:863-869` 按 `flowSource==='tencent'` 给全部缺失因子判 `no-source`，但 `rescue.ts:458-467` 的缺失集里的"脉冲/持续性/量价背离"与资金流无关（冷启动回填失败即缺）。建议按因子逐项归因。
- **P2-9 三份兜底文件读失败一律当"首次启动"**：`em.ts:247-249,648-650,906-908` 把损坏/权限失败与"真没有文件"合并，静默丢掉全部兜底能力且无日志。建议 `console.warn` + 一次显式降级标记。
- **P2-10 `calendar_add` 在没识别到新建事件时仍打印「已写入」**：`tools.ts:596-601`（`created===undefined` 分支），此时撤销记录可能为空。建议改为"已提交（未定位到事件 id，撤回复查请用 listOnly）"。
- **P2-11 `/anomaly` 空请求把响应时刻当数据时刻**：`routes.ts:341` 回 `asOf: Date.now(), missing: []`，与 `/quotes` 空请求的 `asOf: null`（`routes.ts:419`）自相矛盾。建议统一为 `null`。
- **P2-12 T+0 判定没有覆盖可转债**：`portfolio.ts:189` 只认 `5xxxxx` 与 `1[5-9]xxxx`；沪 `110/113`、深 `123/127/128` 段的可转债当日买入也会被算成不可卖（偏保守，与事实不符）。建议把这几个代码段纳入 `isT0Secid`，或至少在 title 里说明"未覆盖的品种按 T+1 处理"。
- **P2-13 `portfolio` 工具的 output schema 与实际返回不一致**：schema 把 `grand/groups/positions` 声明在顶层（`tools.ts:157-166`），实现把它们放在 `view` 下（`tools.ts:248`，renderer 读 `v.view`）。建议 schema 与返回对齐（否则 agent 按 schema 取字段会取空）。

---

## 不确定（答不上"如果错了怎么知道"，故不上升为结论）

1. `rescue.ts:1097` 的 `tick().catch(() => undefined)`：`tick` 内部对取数失败有 `noteSampleFailure()`（`1180`），但其它位置的抛错只被外层吞掉、`lastFailTs` 收不到记录。是否为可达路径未证。
2. `tools.ts:805` 未采样时渲染「平静（评分 0/100）」的实际观感：同段有 `summary`（"尚未采样…"）兜底，影响程度取决于 agent 先读哪一行，未实测。
3. `em.ts:260-267` 的 lkg 淘汰按 Map 插入序而非 `at` 新旧，极端下可能淘汰较新鲜的行；未构造复现。
4. `em.ts:439` 字段级回填时 `good.at` 非数值会保留行内 `now`——静态看生产不可达（写库路径都保证数值 at），但该函数被导出，存在被新调用方误用的空间。
5. 时钟回拨期间槽的 `now < slot.exp` 行为（`em.ts:730`）只看代码推断，未做时间篡改实验。
6. `/badge` 把行情 `asOf` 与护盘 `lastSampleTs` 合并进同一字段（`routes.ts:401`）的判读影响，取决于客户端如何使用（当前只用于文本）。

## 未覆盖区域

- `rescue.ts`（1942 行）只做了抽样：六因子权重、评分等级映射、`scoreLogOf/eventsOf/intradayOf` 的边界（如 `tools.ts:885` 的 `.slice(-24)` 依赖其恒返回数组）、复盘表历史峰值口径均未逐条审。
- `selftest.ts`（1088 行）与 `p0/p1/p1b.test.ts` 的断言覆盖度只抽查；未核"是否有断言锁住了本次发现的缺口"（多数结论按"无断言"推断）。
- 客户端 `ChartCache`/`mini.ts` 的 TTL 与并发合并在断网下的行为、`CloudMap` 三态、`CalendarPage` 的同步入参，未做端到端追踪。
- 真实数据文件（`~/.dsh/dsh-tradewatcher/*.json`）未读取校验，结论仅基于代码路径。
- 未运行任何构建或测试（见文首）。
