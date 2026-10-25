# 审计：全球期货交易时钟（工具模块真实页）

> 本轮审计（2026-10-25，R14）。设计稿 `docs/mockups/global-clock.html` 为准；本页是第一版真实实现。

## 一句话结论

工具页已接进 `工具` 模块（无新顶层入口、无新路由），表盘按设计稿「整盘逆时针旋转 + 金线固定 12 点」实现，
8 项断言与 8 个反例注入全部落地；全量测试 **1294/1294** 通过（基线 1286 + 新增 8），构建 **73 项**通过。

## 新增/改动文件

| 文件 | 作用 |
|---|---|
| `src/shared/clockSessions.ts` | 时段配置（黄金/原油/主要股指，含 `tz`/`days`）+ 纯计算：`Intl` 时区换算、窗口展开、状态、倒计时、轮盘角、弧带几何常量 |
| `src/client/clockView.ts` | 视图纯函数：指数/期货规格、卡片模型（缺数据 `—` + 原因）、时区选项、圆心自检 |
| `src/client/tools/globalClock.ts` | 工具注册项（`page: 'globalClock'`） |
| `src/client/GlobalClockPage.tsx` | 专用详情页：SVG 轮盘 + 时段表 + 指数/期货卡片 |
| `src/client/toolRegistry.ts` | 注册第三项；`page` 判别位扩为 `'leverage' \| 'globalClock'` |
| `src/client/ToolsPage.tsx` | 按判别位分支到 `GlobalClockPage`（不按 id 硬编码） |
| `src/client/styles.ts` | `.tw-clock-*` 样式（字号全部落在密集阶梯） |
| `src/shared/model.ts` | `PortPrefs.clockRefreshSec?`（行情刷新间隔，30–600s） |
| `src/host/store.ts` | `applyPrefsPatch` 持久化 `clockRefreshSec`（复用既有 `/tradewatcher/prefs`，**无新路由**） |
| `src/client/clockView.test.ts` | 8 项断言 + 反例注入 |
| `src/client/toolRegistry.test.ts` / `src/client/leverageTool.test.ts` | 目录卡片数 2→3、注册表长度 2→3（新增工具的必然改动） |

## 8 项断言与注入证据

| # | 断言 | 注入（必败） | 结果 |
|---|---|---|---|
| ① | `wheelAngle(ms) = −(UTC 当日分钟 × 0.25)`，恒为负（逆时针） | 正转 / 固定不转 | ✔ 通过，两种注入都判失败 |
| ② | 金线 `x1==x2==环心x`、`y2==外圈顶`、`transform === null`，且渲染在旋转分组之外 | 金线带 `rotate(...)` | ✔ 通过 |
| ③ | 弧宽 12、相邻半径差 20、净空隙 8（`arcGapProblems()` 空数组） | 8.5 / 24 | ✔ 通过，注入报 4 条问题 |
| ④ | 圆心文字块 `|dx|,|dy| ≤ 1.5`；覆盖层 `inset:0 + grid + place-items:center`、三行 18px、无手写偏移 | `margin-top:24px` | ✔ 通过，注入 `dy=12` 判失败 |
| ⑤ | 20:37（交易日）伦敦 XAU / 上金所 AU9999「交易中」、上期所夜盘「时段外」、倒计时 23:00 分 = 1380s | 全部「交易中」 | ✔ 通过 |
| ⑥ | 缺数据卡 = `—` + 原因，文本不含 `0.00` | 0 占位 | ✔ 通过 |
| ⑦ | `clockRefreshMs()` = 120000（缺省 120s，30–600 收敛） | 1000ms | ✔ 通过 |
| ⑧ | 同一绝对时刻，切时区后 `wheelAngle` 不变、只因时区变的文字时刻变 | 角度用时区当地分钟算 | ✔ 通过 |

## 实现要点

- **表盘**：轮盘是绝对 24h 环（`wheelAngle` 只看绝对时刻）；刻度数字与弧内标签各自反向自转保持水平；弧宽 12、半径 160/140/120/100、圆头、halo 4px；中心圆盘 `r=64` 与三行文字共用环心坐标（`DIAL.cx/cy`）。
- **时区**：下拉含北京（默认）/本地/纽约/伦敦/东京/新加坡/香港/迪拜/柏林；切换只改刻度数字与文字时刻，弧与状态按绝对时刻算。
- **时段**：`CLOCK_SESSIONS` 每条 `{group, exchange, name, code, start, end, days, tz}`；跨零点由 `end <= start` 表达并从次日算起；夏令时全部走 `Intl`（`America/New_York`、`Europe/London`、`Europe/Berlin` 等），未手写偏移。
- **数据**：指数 6 条（`1.000001/1.399001/1.399006/1.000300/1.000905/1.000852`）、期货 5 条（`112.AU0/AG0/CU0/LC0/101.GC00Y`）；一律走既有 `/tradewatcher/quotes`（宿主侧东财优先、失败切新浪）；缺数据 `—` + 原因，每卡带 `source` 与 `at`。
- **刷新**：时钟 1 秒（`setInterval`，卸载清理）；行情 120 秒（`clockRefreshMs(prefs)`，可在 settings 改）；页面显示「刷新 HH:MM:SS」与「校时偏差 ±x.xxs」。
- **校时**：`立即校时` 重新拉一次行情，用响应 `ts`（宿主生成时刻）与本机时刻的差作为偏差。

## 未做项 / 已知边界

1. 未在真实 harness 里做浏览器可视化验收（本轮不允许重启 `dsh web`）；视觉基准仍是设计稿 `docs/mockups/global-clock.html`。
2. 表盘弧道的「分道」用同组内按时间重叠的贪心分配（最多 4 道）；极端情况下同一品种日夜盘会共道，属设计稿已接受的表现。
3. 期货 5 个主连代码只在东财有源；东财熔断时按「缺数据 + 原因」降级，不做第二源拼价格。
4. 交易节假日/临时休市未建模（只按 `days` 周历判断），与设计稿一致。
