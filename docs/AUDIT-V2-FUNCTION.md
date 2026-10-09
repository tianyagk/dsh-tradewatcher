# 功能可靠性审计 V2（v0.33.1，只读）

对象 `dsh-tradewatcher` v0.33.1 / HEAD `b815c6c`（工作区干净）。立场：找**会给出错数、会假装成功、在某个分支上不工作**的地方，重点覆盖 v0.30.0–v0.33.1 叠加出来的新东西。

方法：静态阅读新增模块（`breadthCount.ts`、`ytd.ts`、`trendArchive.ts`、`trendStitch.ts`、`styles.ts`、`sort.ts`/`SortHeader.tsx`）+ 关键接线点；纯函数用 `/tmp` 一次性探针实跑（已删除）。**未跑 `npm run check`（会写 `lib/`）、未探活上游、未在真机渲染层验证** —— 见「不确定」。上一轮 `AUDIT-FUNCTION.md` 的 P0/P1 抽查后确认已修（家数 0 顶替 → `breadthView.ts:45-75`；护盘历史回看静默 → `RescuePanel.tsx` 已加三态），本报告不重复。

## 结论

新链路的设计取向（护栏优先、宁可 `—`）是对的，但**两条新链路的目标场景恰好没打通**：家数自统计算出来了却没接到三格上；源 B 的一致性判据在真实数据形态下自我否决。另有 3 处"过期/降级不标注"与 1 处"拼接超出声明天数"。

---

## P0（必须修）

### P0-1 家数自统计没接到「上涨/下跌/平盘」三格，页面自相矛盾
- 现象：三格仍读指数行情的 `f104/f105/f106`（`MarketPage.tsx:118` → `162-164`），东财不可用时全部 `—`；**同屏**却渲染「家数由本插件自行统计（统计于 HH:mm:ss）」（`MarketPage.tsx:199-206`）与「上涨占比 62.1%」（取自 `/tradewatcher/breadth` 的自统计结果，`MarketPage.tsx:189`）。
- 证据：`src/client/MarketPage.tsx:118,162-164,189,199-206`；路由已把自统计数放在 `current.up/down/even`（`src/host/routes.ts:322-331`）；README:56 与 README:282 都写"拿不到时由本插件自行统计"。
- 为什么是问题：这正是 v0.33.0 要解决的场景（用户实测"爱盯盘有、我们没有"）。现在用户看到的是「三格 `—` ＋ 一行说家数是自己统计的 ＋ 一个 62.1% 的占比」——三处互相打架；`breadth.current` 取到了也等于没用。
- 建议：三格取值改为 `cells.countsOk ? cells : (breadth.current ?? null)`（自统计时同时把 `caliber` 与统计时刻标在那三格上，`em-index` 时不标）。
- 验收：断掉东财（或构造 `sh.up=null`）→ 三格显示自统计数而不是 `—`；加断言：`countsOk=false && current!=null` 时三格取 `current` 的值。

### P0-2 源 B 的「三类之和 = 总数」在真实数据形态下恒不成立 ⇒ 自统计链不工作
- 现象：`fetchClistPctPage` 把无涨跌幅的行（上游 `f3='-'`/空）**过滤掉**（`em.ts:1848-1850`，`num()` 在 `em.ts:185-192` 把 `'-'` 判为 `null`），但 `total` 取的是上游全量行数；随后 `countFromClistPages` 用**未扣除的 total** 做等式校验，并额外要求 `scanned ≥ total`。
- 证据：`src/host/em.ts:1848-1850`、`src/host/breadthCount.ts:99-111`（`invalid` 单独计数、`scanned` 只累有效行）、`80-85`（两道校验）。实跑探针（模拟 5312 只中有 12 只无涨跌幅）：

  ```
  $ node --experimental-strip-types /tmp/probe-breadth.ts
  实际扫过行数 = 5300  上游 total = 5312
  counts = null
  reason = 统计和（5300）与总数（5312）不一致，按失败处理
  ```

- 为什么是问题：只要当日存在 1 只停牌/无涨跌幅标的（A 股常态），源 B 每次都判失败 → 家数退回 `—`，自统计白做。测试之所以通过，是因为用例手工把 `total` 传成"有效行数"（`breadthCount.test.ts:28-30` 传 3、输入 4 行含 NaN）——**测试假设与生产取数口径不同**。
- 建议：把 `invalid` 从 total 中扣除后再做等式（`expected = total - invalid`），或在源 B 判定里用 `scanned` 作为基准并如实写进 `checks`；`missing[].note` 里带上"其中 N 行无涨跌幅未计入"。
- 验收：加一条断言——`countFromClistPages([[1, 0, -1]], 4)`（total 含 1 行无效）应**通过**并把 invalid 计入 checks；再补一条"invalid 数不应超过 total"的断言。

---

## P1（应修）

### P1-1 五日拼接没按 `limitDays` 裁剪：归档满 12 天后图上显示 12 天，文案写「12/5 天」
- 现象：`stitchTrendDays` 把 `limitDays` 只放进 `coverage.limit`，`have`/`points` 用**全部传入的天**（`trendStitch.ts:64,75-87`）；调用方读的是最近 12 天的归档（`em.ts:1381` `keepDays: TREND_ARCHIVE_KEEP_DAYS`=12，`trendArchive.ts:23`），提交 `{limitDays: days}`=5（`em.ts:1382`）。
- 证据：`src/shared/trendStitch.ts:64,75-87,103`；`src/host/em.ts:1381-1382`；UI 文案 `src/client/QuoteDrawer.tsx:350-352`（`本地拼接 ${cov.have.length}/${cov.limit} 天`）；README:30 写"最多拼到 5 天"。
- 为什么是问题：图上时间跨度直接决定形态判断（12 天的"五日图"会被当成 5 天趋势）；界面还会出现「本地拼接 12/5 天」这种自相矛盾的读数。
- 建议：`stitchTrendDays` 内 `have` 先 `slice(-limitDays)` 再拼接（`missing` 区间随之从裁剪后的首日开始），或调用方按 `days` 只加载最近 N 个归档文件。
- 验收：断言"传入 12 天、limit=5 → `points` 只含最近 5 天且 `coverage.have.length === 5`"。

### P1-2 `pickTrendFallback` 的 `expired` 没有任何消费点：过期数据被当作当日显示
- 现象：`expired`（`sessionDay !== today`）只在 `em.ts:1130-1142` 被算出来，然后**全仓无人读**（`grep -rn expired src/` 仅命中这些生成点与测试）；选择顺序只看"有没有点"（`usable = points.length >= 2`），日期不参与。
- 证据：`src/host/em.ts:1126-1142`；标注侧只有两条路径会写"显示上次成功数据"——`payload.fallback` 与 `trend.staleAt`（`src/client/chartCache.ts:238-250`）。
- 为什么是问题：节假日（非周末，`inSession` 按工作日判断，`time.ts:111-116`）上游会回**节前那天的分时**；此时 `from='upstream'`、`staleAt` 未定义、`fallback` 为假 ⇒ 图上画的是旧交易日，脚注没有任何过期字样，用户会读成"今天横盘/成交清淡"。
- 建议：把 `expired`/`sessionDay` 透到回包与 `ChartPayload`，在 `cacheNoteOf` 里加一条"数据不是今天的（sessionDay）"；或在 `pickTrendFallback` 里对"过期的 upstream"降级处理（先试备用源/标注）。
- 验收：构造 `upstream.sessionDay='2026-10-01'`、`today='2026-10-09'` → 断言回包/标注里出现过期说明。

### P1-3 YTD 的降级信息被客户端丢弃，列上无从判断"这是不是上次的旧结果"
- 现象：`/ytd` 回包带 `stale`/`source`（`routes.ts:422-425` 一带），但 `useYtd` 的 `setState` 只取 `map/asOf/missing/truncated/limit`（`useYtd.ts:47`），`YtdState` 也没有这两个字段（`useYtd.ts:15-28`）；`asOf` 进了 state 却无渲染点。
- 证据：`src/client/useYtd.ts:15-28,47`；`src/host/routes.ts:422-425`；对照已做对的路径（大盘的 `caliber`/统计时刻、热度图的来源行）。
- 为什么是问题：YTD 基准按日 memo、失败带 10 分钟冷却（`ytd.ts:110-115`），所以"这次的数其实是冷启动前的旧基准 + 现价"是常态；没有来源/降级标注时，agent 与用户都会把它当成本轮新鲜数据（README「降级不许假装实时」）。
- 建议：`YtdState` 增 `stale/source`，在 YTD 列的 tooltip（`ytdView.ts` 的 `ytdTooltip`）里加一行"来源/降级"，或至少在有 `stale` 时给列头加角标。
- 验收：让 `/ytd` 回 `stale: true` → 断言 tooltip 文案含降级说明；加一条 `ytdView` 断言。

### P1-4 列头排序入口依赖样式表：宽屏在样式缺失时"没有排序入口"
- 现象：宽屏只挂列头（`WatchlistPage.tsx:178-187` 的 `wide ? null : SortBar`），而列头默认 `display:none`、靠媒体查询才显示（`styles.ts:134,136`）。样式表未注入或被覆盖（见 P2-1）时，宽屏**一个排序控件都没有**；窄屏不受影响（段控由 JS 直挂）。
- 证据：`src/client/styles.ts:134,136`；`src/client/wide.ts:15-23`；`src/client/WatchlistPage.tsx:178-187`、`src/client/PortfolioPage.tsx:266-275`。
- 为什么是问题：v0.30.1 刚修过"两个控件同时出现"，现在是镜像风险（一个都没有）；且它由样式注入的失败模式触发，两者叠加后现场表现为"排序功能整块消失"。
- 建议：互斥交给 CSS 结构（根节点 `data-wide` + 两条对称规则），或在 JS 里对"宽屏但列头不可见"留兜底（如用 `matchMedia` 之外再读一次计算样式）。
- 验收：临时清空 `<style>` 内容后不刷新页面 → 宽屏仍有一个排序入口（或至少给出提示）。

---

## P2（可选）

- **P2-1 样式注入的两个残留分支**：① `STYLE_ID` 一旦变更，`getElementById` 找不到 → 走 `append`，旧 `<style id="dsh-tradewatcher-style">` **留在文档里**与新表并存（`styles.ts:455,469-472`）。② `<style>` 被外部移除而 `injected` 仍为 `true` 时直接 `return`，不重新注入（`styles.ts:467-468`）。同一文档**二次重载**本身没问题（内容不同即就地替换，`461-465` ✓ 保留同一元素、无残留）。**建议**：append 前清掉同前缀旧节点；`injected` 与"节点是否存在"解耦。**验收**：模拟"删掉 head 里的 style 后再调 ensureCss"→ 断言重新注入。
- **P2-2 归档侧两处脏状态**：① `prune` 只删 `YYYY-MM-DD.json`（`trendArchive.ts:139`），崩溃残留的 `*.tmp` 永不被清理、也不计入 `dirSize`；② 同日覆盖无质量守卫——点数更少的一份后到也会覆盖更完整的一份（`trendArchive.ts:194-199`），跨进程无锁。**建议**：清理 `*.tmp`；覆盖前比较点数，较少时保留旧文件并在 `skipped` 里说明。**验收**：写一份 3 点的 day 文件后再写 2 点的同一 day → 断言旧文件仍在且 `skipped` 有原因。
- **P2-3 `coverage.missing` 把法定假日列为缺口**：`isWeekday` 只判周一~周五（`trendStitch.ts:47-49,96-100`），长假会被列成"缺 2026-10-01、10-02…"；常显文案只说"缺 …"，完整解释在 hover title 里（`QuoteDrawer.tsx:383-391`）。**建议**：常显文案补"（含休市日，本插件无交易日历）"。**验收**：断言长假期区间内缺口语义（要么标注休市、要么不列）。
- **P2-4 `/tradewatcher/breadth` 把缺失成交额编码成 0**：`amount: amount ?? 0`（`routes.ts:328`），而 `api.ts` 声明 `current.amount` 为非空 `number`；当前客户端没读它（用的是 `breadthCells`），但契约会引诱下一个调用方读到 0。**建议**：改 `number | null` 并在 UI 侧沿用 `amountOk`。**验收**：`amount=null` 时回包字段为 `null`。
- **P2-5 源 B/C 与源 A 同主机**：`fetchClistPctPage` 走 `QUOTE_HOSTS`（`em.ts:1844`），而源 B 的触发条件正是"这批主机上的指数行情拿不到家数"——同源风险存在但无据断言同时失败（CHANGELOG v0.33.0 记录过实测 clist 当时可用）；唯一非东财的源 C 未接线（`breadthCount.ts:475-477`，`deps.sortedPctPage` 全仓无调用方 ✓ 不会被误调用，README/CHANGELOG 也未把它算作已具备 ✓）。另：源 C 的 `down` 是 `total - up - even` **推导值**（`breadthCount.ts:299`），故 `sanityOfCounts` 对它恒成立——接线前这条护栏等于没有。**建议**：接线前把 down 改成边界页独立计数。**验收**：源 C 单测断言 down 由页面数据算出（而非 total 相减）。
- **P2-6 测试缺口**（都会让回归静默）：① 源 B 的并发 ≤4 **无断言**（`breadthCount.test.ts` 无并发计数用例）；②「盈亏键跟随成本口径」**无可执行断言**（实现 `PortfolioPage.tsx:412-419` ✓ 正确，但 `sort.test.ts` 的输入是自造的、`.tsx` 不进 `node --test`）；③ `sortByNumber` 层只测 `null`，未测 `NaN/undefined`、`weight=null`（总市值 0）、`cost=null` 升序沉底（`sort.test.ts:37-40,122,137`）。**建议/验收**：各补 1 条最小断言（并发用一个计数注入器；排序用 `[[NaN],[null],[1]]` 升序序列）。
- **P2-7 YTD 的两处契约松**：① 回包缺 `fqt/fqSupported` 时按**请求值**兜底（`ytd.ts:169-170`），理论上会把不复权序列标成前复权（`fetchKline` 恒填充，生产不可达）；② `YtdMemo` 是**最早写入淘汰**（`ytd.ts:99`），而注释/测试名写"最近使用淘汰"。**建议**：文案或策略二选一改齐。**验收**：注释与 `ytd.test.ts:138,145` 的用例名一致。
- **P2-8 文档残余**：README:324 仍写"数据源与大盘页**同一处**（上证/深证行情里的 f104/f105/f106），不另开链路"——与 v0.33.0 新增的 clist 自统计链路（README:280-292）冲突。**建议**：以「涨跌家数」章节为准，删掉这句旧口径。**验收**：README 里 `grep -c '同一处'` 为 0（该措辞只出现在旧口径那句）。

---

## 不确定（拿不准，故不上升为结论）

1. **真实上游是否存在 `f3='-'` 的标的**：未探活。P0-2 的立论是"代码自己承认可能有无效行（`invalid` 计数）却用未扣除的 total 校验"，与探针输出一致；若上游对停牌股也回数值（不常见），该条降级为 P2。
2. **腾讯分钟线兜底的时区**：`tencent.ts:334` 的 `Date.parse` 无时区后缀（按宿主 TZ）、`em.ts:1193` 日期取 `toISOString()`、时间取 `toTimeString()`。推导：该链路只处理 `0930`–`1500`（北京 09:30 = 01:30Z 同日），**任意宿主时区下日期都不错**，故未列为缺陷；夜盘/美股若接入该链路会错日。
3. **归档满 12 天的实际拼接天数**：P1-1 由代码直线推出，未用真实归档目录验证（需累积 12 个交易日）。
4. **并发上限的真实重叠**：源 B 单批 ≤4、YTD 每批 ≤4（`ytd.ts:212-214`）都是 worker 池结构（✓），但"路由 + 工具同时触发"时各自建池、最坏 2×4 同时在飞（`routes.ts:422` / `tools.ts:531` 共用 memo 而非共用池）；上游侧有 `em` 单飞合并，实际请求数未实测。
5. **真机渲染层**：任务点名的"至今没在真机渲染层验证过"——本报告只能给静态结论与纯函数探针；`cssInjectAction` 的二次重载、宽屏列头、自统计家数三处都需要在浏览器里跑一遍（尤其 P0-1 的观感）。
6. `sort.test.ts` 的"同值稳定"只断言单次调用内的顺序；"不随每次轮询重排"依赖索引比较器的传递性成立，未构造"两轮新数组"的用例。
7. **本机运行中的宿主还没加载新代码**：`curl -s 127.0.0.1:3080/tradewatcher/breadth` 返回 `current: null`，且 `missing[0]` 是 v0.29 的旧文案（`why: 'no-source'`），而 HEAD 源码此处已是 `transient` + 自统计说明；`lib/index.js` 的 mtime 是 10-09 13:04、内部含 `em-clist` ⇒ 构建是新的，**进程未重启**。因此 v0.30–v0.33 的新链路（自统计家数、五日拼接、YTD）至今一次都没在真机执行过；P0-1/P0-2 只有静态证据与纯函数探针，重启后应优先复验"源 B 是否真的每次都判失败"。

## 未覆盖

`docs/DESIGN-DASHBOARD.md` 与布局回退后的实际渲染、`RescuePanel` 空壳修复、`calendar.ts` 本轮改动（+185 行）、`store.ts` 的 ledger-skip 与成本边界改动（+115 行，属上一轮 P1-5/P1-10 的修复范围，未逐条复验）、`build.mjs` 的产物文案校验清单。
