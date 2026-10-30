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
