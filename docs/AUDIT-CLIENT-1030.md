# 客户端层代码审查（2026-10-30）

> 本轮审计（2026-10-30）。范围：`src/client/**`；只修 P0/P1，P2 只登记。门禁从 1446 起不降。

## 结论

- **P0：0 条**（未发现崩溃/数据错乱/无限请求级问题）。
- **P1：1 条**（已修，附断言 + 反例注入）。
- **P2：6 条**（只登记）。

## P1（已修）

### P1-1 时钟页行情 effect 依赖 `refreshSec` ⇒ 设置解析完成后重复请求 `/quotes`
- 位置：`src/client/GlobalClockPage.tsx:166-172`（修前）
- 问题：`React.useEffect(() => { load(false); subscribeTicker(...) }, [load, refreshSec])`。`refreshSec` 由 `api.prefs()` 异步解析（初值 120 → 实值），解析完成后 effect 重跑 ⇒ 首屏多打一次 `/quotes`；且 `clockRefreshMs()` 自 v0.172.0 起不再参与调度（统一 60s 主 tick），`refreshSec` 与整个 prefs 请求都是死代码。
- 影响：首屏多一次行情请求；多一次 `/prefs`；后人会误以为行情节拍由该设置控制。
- 修法：删除 `refreshSec` 状态与 `api.prefs()` effect，行情 effect 依赖收窄为 `[load]`，注释说明节拍由共享 ticker 决定。
- 断言：`src/client/clockView.test.ts`「P1-1」——源码不得出现 `api.prefs()` / `refreshSec`；行情 effect 依赖必须只有 `load`；注入 `[load, refreshSec]` 必败。

## P2（只登记，未改）

| # | 位置 | 问题 | 影响 |
|---|---|---|---|
| P2-1 | `src/client/RescuePanel.tsx:211` | 分时量能柱 `key: i`（索引键） | 序列整体替换时无 diff 复用；柱数少，影响轻微 |
| P2-2 | `src/client/CalendarPage.tsx:259` / `ToolsPage.tsx:854` / `PortfolioPage.tsx:750,757` / `ui.tsx:562` / `ChipsPanel.tsx:210` | 同上，索引键 | 静态/追加型列表，无重排，影响可忽略 |
| P2-3 | `src/client/FupanPage.tsx:282,405`；`src/client/index.tsx:135,158,184` | 注释里出现 `⚠`（**用户可见文案没有**） | 仅注释；若做全仓 grep 巡检会误报 |
| P2-4 | `src/client/clockView.ts:zoneOffsetOf` | 每次调用新建 `Intl.DateTimeFormat`（每秒 1 次渲染 × 2 次调用） | 单次 ~0.1ms，当前页面可接受；若后续加图表再缓存 |
| P2-5 | `src/client/GlobalClockPage.tsx` | 1s 时钟在标签页隐藏时仍重绘 500+ 节点 SVG | 后台标签页耗电；可加 `visibilitychange` 门控 |
| P2-6 | `src/client/RescuePanel.tsx:455` | 轮询间隔依赖 `snapshot.activeIntervalSec`（类型必填，但线缆无运行时校验） | 若上游缺字段 → `Math.max(10, undefined)` = NaN → 0ms 轮询；建议客户端 clamp（`Number.isFinite` 兜底） |

## 未发现问题（已核对）

- `useEffect` 清理：`PrismPage`（30s 日历）、`RescuePanel`（轮询）、`PortfolioPage`（主 tick 订阅）、`GlobalClockPage`（1s 时钟）均有 `clearInterval/退订`。
- 空数组/NaN：`auctionSeries`（`pts.length === 0 ⇒ null`）、`mini.ts`（`points.length >= 2` 才计算）已有守卫；`quoteCard` 用 `Number.isFinite(price)` 判定，缺数据落 `—` + 原因。
- 文案：未发现用户可见的 `⚠` / 免责 / `undefined` / `NaN`。

## 已按用户要求下线（2026-11-14）

**大盘页左列四张卡整组删除**：`涨跌趋势`（5 格）、`成交量`（4 格）、`两融`（3 格）、`成交额分时`（折线）。
页面改为**单列**（`.tw-mk-single`），只剩 `涨跌分布` 与 `分钟成交额较昨日增减`；隐藏旧块（`data-legacy=market-summary`）里的同一组左列段也一并删除。

- 删除的 CSS：`.tw-mk-grid5` / `.tw-mk-grid4` / `.tw-mk-grid3` / `.tw-mk-grid2` / `.tw-mk-col-l` / `.tw-mk-col-r`（后者换成 `.tw-mk-single`）。
- 删除的用例：`marketPolish ③`（5/4/3 等分）、`marketPolish2 ②`（左列三卡紧凑）——共 **2 条**；`④⑤ / ①②③ / ③(modules) / legacy` 为**改写**（不是放宽），断言对象改成保留的两块与单列。
- 宿主接口 `/breadth` 的 `limitUp/limitDown/up/down/flat` **保留不动**，界面不再展示。

## 护盘卡内五块下线（2026-11-14，按用户红框）

删除：`底部位置 / 形态 / 触发后对照` 整表（表头 + 6 行通道 + 日期列）、表下 `历史概率 … vs 基线` 行与 `口径与边界（悬停查看）` 入口、`今日信号时间线（N）` 整块（含「旧口径」注释行）、`历史回顾（30 天…）` 整块。
保留：护盘卡头（等级/族/分数/因子/采样态/按钮）、共振行、六张 ETF 卡、因子明细、分时量能、`今日 5 分钟抽样`。
后端 `/rescue` 的 `history` 与 `bottomPosition` **保留不动**，仅前端不再渲染。

- 删除 CSS：`.tw-rescue-timeline`（口径入口类此前已无独立规则）。
- 删除用例：`impl78 P3-3`（触发后对照表头）、`impl79 ⑤`（口径入口接线）、`impl85 ②`（时间线保留项）、`marketPolish ①`（时间线 40 字）——共 **4 条**；`impl78 P2-6`、`impl85 ③④`、`rescueVisual ②` 为**改写**（去掉已删块的锚点，保留项不动）。

## 剩余两卡下线（2026-11-14，用户红框：涨跌分布 + 分钟成交额较昨日增减）

大盘页再删两张卡：`涨跌分布`（含 DistHistogram 旧块）与 `分钟成交额较昨日增减`。页面只剩 **护盘信号** 与 **汪汪队跟踪** 两张卡。
- 删除文件：`src/client/distCardRender.tsx`、`src/client/distCard.ts` 及其测试、`distLayout.test.ts`、`marketLegacyHidden.test.ts`（旧隐藏块整块删除）。
- 删除 CSS/工具：`tw-mk-single`（换成 `tw-mk-body`）、`tw-dist-*` 残留类、`distAxisOf/distBarPctOf/distToneOf/daySeriesOf/X_TICKS/gridYsOf/yTicksOf/DIST_BUCKETS/DIST_BJ_TITLE` 等零引用导出。
- 请求：不再请求 `/tradewatcher/breadth?dist=1`（`api.breadth()` 不带参数）；宿主 `/breadth` 路由与聚合代码保留。
- 用例：删除 9 条（distCard 5 / distLayout 5 / marketLegacyHidden 1 / marketPolish 2 / marketPolish2 1 / marketV1 1 / pacing 2 / marketExtrasWire 2 / marketModules 1 / impl78 1 / prevArchive 1 中的相关块），改写 `marketCardsRemoved` 为 4 条新断言（1 张卡 / 标题 0 处 / 汪汪队仍在 / 不请求 dist=1）。
