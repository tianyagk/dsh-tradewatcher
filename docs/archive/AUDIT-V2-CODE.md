# 代码结构与冗余审计（v0.33.1 · HEAD `b815c6c` · 只读）

**实测基线**：实现 24,376 行（`src/client` 9,802 / `src/host` 12,918 / `src/shared` 1,568 / `src/index.ts` 88，不含 `*.test.ts`）；测试 29 文件 3,624 行；代码注释里 **109 个 ≥8 行注释块合计 1,172 行**（其中 69 个含"此前/v0.x/P0-x/实测"这类历史叙述）；`docs/` 9 份 2,187 行 + README 410 + CHANGELOG 495。行号均指当前 HEAD。
**验证通则**（下列各条只写差异验证）：`npx tsc --noEmit -p tsconfig.json` + `node --test --experimental-strip-types "src/**/*.test.ts"`（本机时区）与 `TZ=UTC` 同跑（等于 `npm test`，**不跑 `npm run check`**，它会写 `lib/`）；涉及界面的条目另需装机点开对应视图。

## 一、可安全精简（收益＝行数估计；影响面已注明）

**S1 `charts.tsx` 三个零引用组件（−193 行，客户端包体同步变小）**
位置 `src/client/charts.tsx:168-177,251-323,324-433`｜现状 `PriceText`/`MultiDayTrend`/`CandleChart` 在生产与测试中**均零引用**（现役 K 线在 `kline.tsx`，图表壳在 `QuoteDrawer`）｜建议 删三个组件；`CandleBar`/`CandleMarker`/`SparkMarker`/`SparkPoint` 等类型保留（`kline.tsx:8`、`QuoteDrawer.tsx:13` 只引类型）｜判据 全仓检索命中仅定义处，且无 `export`/`export *` 转发｜验证 双时区测试（无对应断言）＋装机点开抽屉的日/周 K 与自选缩略图。

**S2 `tencent.ts` 里同一接口的两份解析（−52 行）**
位置 `src/host/tencent.ts:47-95`（`fetchTencentQuotes`）与 `:114` 起（`fetchTencentQuoteRows`，类型 `TencentQuoteFull` 在 100-112）｜现状 两者请求同一 `qt.gtimg.cn/q=`、同样按 `~` 切分；`TencentQuoteFull extends TencentQuote` 是超集，且新版多一层 GBK→latin1 回退；旧版**零引用**（`em.ts:34` 只 import 新版）｜建议 删旧函数，保留 `TencentQuote` 接口（被 `Full` 继承）｜判据 引用计数 0（生产与测试都无）｜验证 `p0/p1/chart-source` 相关测试＋`selftest`（腾讯兜底链路）。

**S3 零引用碎片 11 处（−57 行）**
位置 `store.ts:113-116`(`normalizeLedger`)、`store.ts:1090-1092`(`clampMoney`)、`em.ts:2102-2108`(`searchBest`)、`em.ts:2110`(`export { cache as _cache }`)、`ytd.ts:184`(`defaultYtdMemo`)、`ui.tsx:352-356`(`useForceNow`)、`format.ts:83-88`(`fmtTime`，仅测试用 2 处)、`model.ts:378-384/557/729-733/1402-1405`(`CalPayload`/`VIEW_MODE_LABEL`/`IndustryInfo`/`RescuePayload`)、`routes.ts:884`+`portfolio.ts:231`(转发导出 `DataStore`/`isT0Secid`)｜现状 全部零生产引用；`store.ts:105`、`ytd.ts:134/208`、`tools.ts:572` 用的是另一个符号（`normalizeLedgerEntry`/`defaultMemo`/`searchSymbols`）｜建议 删；`fmtTime` 删时同删 2 条断言（`fmtClock`+`marketTime.ts` 已覆盖同时刻能力）；`stats.ts:45-49` 的 `wilsonFromRate`（仅测试 5 处）**保留**——它是 `wilsonInterval` 的点估计入口，属 API 对称，加一行注释即可；`model.ts` 的类型若认为有契约价值，缩成一行注释代替；`ACTOR_TOOL`(`model.ts:870`)**不要直接删**——见 M7｜判据 逐个 `rg` 只有一个命中（定义处）｜验证 双时区测试。

**S4 动词文案两份逐字重复（−11~14 行）**
位置 `src/client/PortfolioPage.tsx:30-40` 与 `src/host/portfolio.ts:390-402`｜现状 11 个 `LEDGER_VERBS` 的中文映射**逐字相同**，各写一份（界面用客户端版、工具用宿主版）｜建议 提 `src/shared/model.ts`，host/client 各引一份；并用 `LEDGER_VERBS`（`store.ts:63`）加一条键集一致性断言｜判据 已逐字比对一致（`gmove`=`移动/编辑`）｜验证 流水弹窗动词列＋`tradewatcher_ledger` 工具输出同词。

**S5 "缺失两档"标签 4 处硬编码（−6 行，主收益是防分叉）**
位置 `client/CalendarPage.tsx:210,212` 与 `host/tools.ts:70,78` 的 `m.why === 'no-source' ? '上游无此数据' : '本次失败'`｜现状 `MISSING_TIER_ADVICE`（`model.ts:933`）已单点定义"长句"，但**短标签**仍散在 4 处三目里｜建议 在 `model.ts` 紧邻处加 `MISSING_TIER_LABEL`，4 处改引用｜判据 4 处语义完全等价（都只做分档→短标签映射，无口径差异）｜验证 `calendar.test.ts` 的 S19 措辞断言＋工具 `missingLines` 输出。

**S6 原子写 `.tmp`+`rename` 六处（−30~40 行）**
位置 `store.ts:461-467`、`writeLog.ts:84`、`calendar.ts:365`、`trendArchive.ts:195`、`breadth.ts:140`、`rescue.ts:1044`｜现状 六处各写一遍"mkdir → 写 `.tmp` → rename"｜建议 抽 `host/atomic.ts` 的 `writeJsonAtomic(path, value, indent?)`，各处只保留自己的节流/错误策略｜判据 六处模式一致（唯一差异是缩进与串行链，做成参数）｜验证 `routes.test.ts`、`ledger-skip.test.ts`、`calendar.test.ts`＋手工改一次自选看 `watch.json` 无 `.tmp` 残留。

**S7 数值判定小工具 8 份（−20 行，热点路径）**
位置 `model.ts:972`(`isFiniteNumber`，15 处用)、`em.ts:185`(`num`，65 次调用)、`rescue.ts:680`、`bottom.ts:46`、`store.ts:59`(`numOrNull`)、`tencent.ts:41`、`sina.ts:21`、`breadthView.ts:40`｜现状 前五处语义等价（number|null|undefined → 有限数判定/取值），可归到 shared 的 `isFiniteNumber` + 一个 `numOrNull`；`tencent.ts`/`sina.ts` 的 `num` 接受 `string` 并 `Number(v.trim())` 解析，**语义不同**，只统一签名不合并实现｜建议 前者合并、后者加注释说明差异；保留 `bottom.ts:46` 的类型守卫写法（它同时是 `v is number`）｜判据 逐处比对实现体（`typeof === 'number' && Number.isFinite`）｜验证 全量双时区测试 + `node src/host/selftest.ts`（行情/期货解析路径调用最密）。

**S8 注释：历史叙述压缩约 −420 行（不改语义）**
位置 全仓 109 个 ≥8 行注释块（`em.ts` 416 注释行、`rescue.ts` 345、`model.ts` 478 最集中）｜现状 大量"v0.30.1 曾删过 X / 实测踩到 Y / P1-7 修的是 Z"的成段叙述；`em.ts:1332`、`quoteState.ts:24`、`styles.test.ts:36` 这类**说的是"为什么不能改回去"**，是防回归资产｜建议 按 §四 的规则机械处理：保留"红线＋代价"两句，版本号与过程叙述迁 `docs/`｜判据 注释里含 `v0.x`/`P0-x`/`K\d`/`S\d\d` 的段落才动；含"不许/必须/红线/不变量/否则"的句子**整句保留**｜验证 无代码改动，故只需 `tsc --noEmit`；人工复核被删段落里的数字（如"瞬时失败率 20–75%"）是否已留在别处。

**S9 `docs/` 收敛：归档 4 份一次性报告（−1,433 行 ≠ 删信息）**
位置 `AUDIT-IMPL2.md`(922)、`AUDIT-VERIFY.md`(267)、`AUDIT-IMPL.md`(157)、`AUDIT-COPY.md`(87)｜现状 逐轮过程的实现/验收/审计报告，结论已被 CHANGELOG 与 README「口径规范」吸收；`AUDIT-IMPL2.md` 还是 `task-5` 的行内编号（v0.30.0 批二）｜建议 移到 `docs/archive/`，在 `README`「开发」留一行索引（"逐轮审计与验收报告见 docs/archive/，口径以 README 为准"）；**`AUDIT-UI.md`/`AUDIT-FUNCTION.md` 是本轮审计产物、`DESIGN-DASHBOARD.md` 是活文档、`COMPETITOR-NOTES.md` 是取舍依据，都留根目录**｜判据 文件头写明"报告对象版本 ≠ 当前版本"即归档，不删（git 历史与归档目录都在）｜验证 `git status` 只看到路径移动；README 链接可达。

**S10 测试文件按模块归并（29 → 21，−40 行样板，断言一条不减）**
位置 `p0.test.ts`/`p1.test.ts`/`p1b.test.ts`（622 行/36 断言，按审计批次命名）与 `portfolio-cost.test.ts`/`ledger-skip.test.ts`/`chart-source.test.ts`/`trend-fallback.test.ts`｜现状 同一模块被 3 个文件测（portfolio 3 份、em 3 份），文件名表达的是"哪一轮审计"而不是"测什么"｜建议 归并为 `portfolio.test.ts`/`em-fallback.test.ts`/`regressions.test.ts`，重复的 import 与说明注释合并｜判据 断言总数不变（当前 211 个 `test()`、1,001 处 `assert`，双时区跑两遍），只是重新分布｜验证 双时区测试通过且断言数不减少（改动前后各跑一次对比）。

## 二、不可精简（会出事）—— 用户要求"可靠有效"优先，这一档比删得多重要

**M1 `charts.tsx` 的存活部分不能跟着 S1 一起删**
`Sparkline`(TopBar/MarketPage 用)、`MiniTrend`(Portfolio/Watchlist 用) 与四个类型是现役；`polylinePath` 只被 `Sparkline`/`MiniTrend` 用。删 S1 三个组件后此文件仍有约 240 行——**不要因为"文件变小了"就把它并进 `ui.tsx`**（图表与 UI 原语的生命周期不同）。

**M2 `breadthCount.ts` 的护栏与源 C 算法（最容易被当成"没人用的死码"）**
`sanityOfCounts`(73-87)、`countFromSortedPctPages`(132-316) 与 6 条源 C 用例（该文件共 8 条）是"宁可不给数，也不给看起来对的错数"的**最后一道判据**（三者之和=总数、扫过行数≥总数、全正/全零必须有证明）。删它必须连 6 条用例一起删（届时不删用例会直接 import 失败），删完测试仍全绿 —— **没有任何机制会提醒你"不变量不成立就不发布"这条红线消失了**。见 §三 的判断题。

**M3 `breadthView.ts` 的"任一分量缺失 ⇒ 整格 `—`"**
`up` 有值而 `down` 缺失时会渲染成 `1234 / 0`，被用户读作"没有一只下跌"（`breadthView.ts:8-11`）。这条约定与 README「缺失不许用 0 代替」同源，**任何"合并成一句话/简化成 0"的改写都会造成读数谎言**。

**M4 `styles.ts` 单一模块 + `cssInjectAction` 的替换语义（不可拆、不可"优化"成只 append）**
热重载时旧 `<style>` 还在文档里，只 append 会让新 DOM 配旧 CSS（`styles.ts:440-456`）。同理**不要**把 473 行 CSS 拆成多个文件——单次注入 + 内容比对替换的契约依赖"一份字符串"。要减行只能删未使用的选择器，且必须同步两条 `data-blur=1` 清单（漏一个面就漏出数字）。

**M5 `em.ts` 的逐标的缓存槽与三处 LKG「必须存在」的理由**
整批 id 拼接做键会让 `/quotes` 与 `/portfolio` 各打一次上游（实测一拍 20 次请求）。`quotes-lkg`/`trends-lkg`/`board-lkg` 是"重启后不空屏、缩略图不闪"的兜底。**可以抽象成通用的 Lkg 类（见 R1），但不能删、不能改成只在内存保存**。

**M6 `quoteState.ts` 的四态命名（已统一，别再散开）**
此前同一件事有四种叫法（缺失/无价/无行情源/暂无行情）。`NO_SOURCE_LABEL`/`PENDING_LABEL`/`QUOTE_STATE_LABEL` 是**唯一出口**；新增任何行情状态显示面都必须引这里，否则回到已修过的病（用户无法判断"要不要重试"）。

**M7 `model.ts` 的 `MISSING_TIER_ADVICE` 与 `ACTOR_TOOL`：口语化缩写会丢动作指引**
advice 两档决定用户**下一步动作**（等 vs 改口径），不能压成一句。`ACTOR_TOOL`('tool') 与 `store.ts:78` 的读入兼容、`tools.ts:357` 的"会话/界面"分支构成一条**当前没有写入者**的通道；`store.ts:78` 的一行兼容**必须留**（历史文件里的 `actor:'tool'` 不能被改写成 `'web'`），而 `ACTOR_TOOL` 常量与 `tools.ts:357` 的渲染分支：若近期要接"工具写流水"就接线（用常量而非字面量），否则删掉两处并把 `store.ts:78` 的注释改成"兼容历史值"。

**M8 `model.ts` 是宿主/客户端契约，不能按"客户端用不到就删"处理**
`shared/model.ts` 1,406 行里大量类型只在一侧被引用（如 `PortfolioAssembly`、`RescueFactor`）；它是两半之间**唯一**的接口定义处，删"看起来单侧"的类型会造成两端各写一份（`VERB_LABEL` 就是既有教训，见 S4）。

**M9 客户端文案与工具文案「故意不同」，不要强行统一**
`ytdView.ts:31`「本年内上市：基准是上市首日，按年初读会高估」与 `tools.ts:507`「本年内上市：这是上市首日，不是年初」是**面向人 vs 面向模型**的两套措辞；共享的是 `YTD_CALIBER`/`FQ_LABEL` 常量（已共享）。合并只会让一侧变差。

**M10 `RescuePanel` 的本地 `fmtPct`/`fmtYi`/`fmtX` 不与 `format.ts` 合并**
语义不等价：`format.ts:25` 的 `fmtPct` 输出 `▲1.23%`（列表用），RescuePanel 输出 `+1.23%`（面板用）；`fmtYi` 固定"亿"且**不受 `moneyMasked` 遮罩**，换成 `fmtAmt` 会改变隐身档的显示行为。要合并必须先决策"隐身是否遮盖护盘金额"，属 UI 决策（交 `audit-ui`/`design-ui`），不是重构。

**M11 `kline.tsx`（780 行）不要拆；`MarketPage.tsx` 本轮不要单独重构**
`TrendChart`/`KlineChart` 共用 `yGrid`/`volumePane`/`macdPane` 与同一套坐标常量，拆开会造成交叉 import 与两份 padding 常量。`MarketPage` 正由 `DESIGN-DASHBOARD.md` 重设计，重构必须与那份规范一起做，否则两边会打架。

## 三、判断题：家数"源 C"（`deps.sortedPctPage` 未接线）

**结论：既是有意预留、也已经是"半成品死码"——判断的关键不在于它有没有价值，而在于当前三处标注不闭合，必须做一次 3 行收口；不接线也不收口，它就会在下一个版本变成误导后人的死码。**
- **证据**：算法 185 行 + 6 条源 C 用例（`breadthCount.test.ts:38-107`）是全项目最严的一段正确性逻辑；`resolveBreadthCount:475` 用 `deps.sortedPctPage === undefined` 短路，`routes.ts:314` 的调用**没传**该字段⇒C 档在当前运行时不可达。CHANGELOG v0.33.0 已如实写明"运行时未接线"（`CHANGELOG.md:62`），但 **README「涨跌家数」只写了 A/B 两条源**，且 `breadthCount.ts:424-428` 的注释让人"见 `resolveBreadthCount` 的说明"，而那段 JSDoc(440-444)**并没有说明 C 未接线** —— 指路是断的。
- **删掉会丢什么**：① 通用"降序分页边界搜索"算法（含"两次取数不一致就不发布""全正必须有证明"两条红线）；② 6 条用例；③ 未来任何降序分页源的接入成本（重写+重新验证）。
- **保留要补什么（3 行）**：`resolveBreadthCount` JSDoc 补一句"C 需要 `deps.sortedPctPage`，当前运行时无可用取数实现，只走 A→B"；README「涨跌家数」补一行"第三条链路算法已实现但未接线"。
- **二选一收口（建议 30 天内定）**：接线——`sina.ts:207` 的 `Market_Center.getHQNodeData` 已在项目内用于 ETF 排行（同接口换 `node=hs_a` + `page/num` 即构成降序分页源，解析器已在仓内），这是**基于代码事实的推断、未验证上游行为**，接线前需实测一次；或删除——连算法与 6 条用例一起删，并把 `BreadthCountDeps.sortedPctPage` 一并移除。**不要保持现状再过一轮。**

## 四、可机械执行的取舍规则

**注释**（对 S8）：① 含 `不许/不能/必须/红线/不变量/否则/宁可` 的句子**整句保留**（它是防回归判据）；② 含 `v0.x`、`P0-x/P1-x/P2-x`、`K\d/S\d\d` 的**版本号与批次号删除**，只留"这条规则为什么存在"（≤2 行）；③ 含"实测 + 数字"的保留数字、删过程（数字是判据）；④ 单块 >12 行且不含约束词 ⇒ 迁 `docs/DECISIONS.md` 并在原位留一行锚点；⑤ 文件头块注释压到 ≤6 行（现状最长 21 行）。
**文档**：⑥ 文件头写"报告对象版本"的即为过程产物，进 `docs/archive/`；⑦ 口径类内容只在 README「口径规范」出现一次，其它文档引用不复制；⑧ 每份 `docs/` 文件头部一句话写明"活文档/一次性报告"。
**测试**：⑨ 一个实现模块最多一个 `*.test.ts`（跨模块的回归用 `regressions.test.ts`）；⑩ 断言"规则形状"（如 `styles.test.ts:24` 断言 CSS 里不得再出现隐藏式互斥）是**行为断言**，属高价值，不按"脆弱"处理；只对"断言实现细节字符串"的用例做收紧。

## 五、建议但风险较高（需单独一轮，且有对应验证）

**R1 三处 LKG 抽象为通用 `LkgStore<T>`（−120 行）**：`quotes`(`em.ts:222-285`)/`board`(`em.ts:710-748`)/`trend`(`em.ts:960` 起) 三套 load/persist/note 结构同形但 TTL(45s/10s/5s)、上限(1500/40/400)、校验与键大小写策略各不相同。抽象必须把三项差异做成参数，并保留"键统一大写"（历史大写 secid 会丢兜底价）。
**R2 `em.ts` 拆分（−0 行，只降"改一处要读多少行"）**：2,110 行含 6 个域（基础设施/行情/LKG/兜底/分时K线/板块搜索）。建议先抽 `em-lkg.ts`（与 R1 合并做）与 `em-board.ts`（板块+搜索，约 270 行）；**分时/K线那段与 P1-7 失败记账共享 `upstreamFailAt`，暂不拆**。风险：模块级 Map 与 inflight 状态搬迁时若复制而非共享，会造成双份缓存（表现为上游请求翻倍）。
**R3 `PortfolioPage.tsx` 拆出 7 个 Modal（−约 600 行搬运）**：`BackupModal`/`GroupFormModal`/`AddPosModal`/`TradeModal`/`PosEditModal`/`LedgerModal`/`FxModal`(525-1141) props 已明确，属低风险搬运，但会与任何同时改持仓页的工作冲突——**排在 DESIGN-DASHBOARD 落地之后**。
**R4 自选/持仓两页行提示统一**：`PortfolioPage.tsx:1117-1127` 与 `WatchlistPage.tsx:609-619` 的"振幅/相对昨收/分时提示"双份。两页字段并不相同（持仓有成本/盈亏、自选有 α），先抽纯函数 `miniHoverText()` 再谈合并行渲染；直接合并会丢掉各自的口径提示。
