# 棱镜 · AGENT DESK 第二批（中栏 + 右栏 + 底部状态条）实施记录

> 基线：第一批 `v0.205.1` 工作树（1628/1628，73 片段）→ 本批 **1692/1692，73 片段**。
> 设计稿：`AGENT DESK`（1511×1102）。差异清单见 `docs/PRISM-DESIGN-DIFF.md`，第一批记录见 `docs/AUDIT-PRISM-B1.md`。
> 范围：**中栏（个股详情 + 决策流）+ 右栏（账户总览 / 持仓·挂单 / Agent 绩效）+ 底部状态条**；顶部条与左栏未动。

---

## 1. 交付面

### 1.1 中栏 · 个股详情（选中左侧持仓后）

| 项 | 实现 |
|---|---|
| 行情头 | 名称 16px + 代码 chip + `AI 持仓` 徽标；右侧 **26px 现价**（红涨/绿跌/平灰）+ 涨跌额 + 涨跌幅；副行 `成本 / 持股 / 权重` |
| 第一行 | `昨收 / 今开 / 最高 / 最低 / 持仓`（持仓取 `desk.positions.rows[].qty`，千分位） |
| 第二行 | `成交额 / 换手率 / 量比 / 振幅`；振幅 = `(最高 − 最低) / 昨收 × 100`（真实派生），量比无源 ⇒ `—` + title |
| 成交标记 | `B 14:48 买入 124 @15.28` / `S …`，取该标的**最近 2 笔** fills；**无成交 ⇒ 整行不渲染** |
| 图表 | `分时 / 日K` 切换，复用仓内 `TrendChart` / `KlineChart`（走既有 `/tradewatcher/trend`、`/tradewatcher/kline`，**无新路由**）；失败 ⇒ `—（图未取到）` + title 原因；按容器真实像素绘制（ResizeObserver） |
| AI 研判 | 徽标 + 结论 + `置信度 0.xx`；宿主无结论/置信度字段 ⇒ `—（无研判）` + `—`（不从 `run.summary` 截一句冒充） |

### 1.2 中栏 · 决策流

| 项 | 实现 |
|---|---|
| 头 | `AGENT` 徽标 + `决策流` + `只读 · 244 条留痕` + `↺ 重放今日`（宿主无重放接口 ⇒ `disabled` + `title="宿主未提供重放接口"`） |
| 六 tab | `全部 244 / 选股 20 / 分析 80 / 挂单 137 / 风控 90 / 约束 7`（全部为真实派生计数） |
| 单条 | 时间（`HH:MM:SS`，**倒序**）+ `ORDER/SCAN/ANALYZE/RISK` 徽标 + 动作描述 + `动作 / 依据 / 风控` 三段 + 底部 chips（`复审 x.xx` / `N ms` / `N tok`，**有源才渲染**）+ `风控通过 / 风控拦截` |
| 截断 | 单屏最多 60 条，截断时页脚如实写 `仅显示最近 60 条 · 共 N 条` |

派生口径（`src/client/prismDeskMid.ts`，`flowEntriesOf`）：

- **SCAN**：每个 `state.runs` 一条；`ms` = `finishedAt − startedAt`（真实耗时）。
- **ANALYZE**：每份 `run.analyses` 一条（4 份/轮），落盘时间 = `run.finishedAt`。
- **ORDER**：每笔 `state.orders` 一条（137）；被拒绝的同时进「风控」视图（事件本来就是两件事）。
- **RISK**：`run.decision.rejects` 与 `run.decision.clampEvents` 各一条；裁剪事件同时进「约束」视图。
- `全部` = **去重条数**，六个 tab 的计数逐条数出来，不做简单相加。

### 1.3 右栏 · 账户总览

| 项 | 实现 |
|---|---|
| 大数 | 标签 `总资产（元）` + **27px** `1,582,253.68` + 右上 `只读` 徽标 |
| 盈亏行 | `今日盈亏 -11,603.82 (-0.73%)` + 右 `累计 -217,746.32 · -12.10%`（今日 = 总资产 − `dayStartEquity`；累计 = 总资产 − `capitalLimit`） |
| 四格 | `可用资金 559,774.00 / 持仓市值 1,240,226.00 / 浮动盈亏 -217,716.00 / 今日已实现 -45,083.06` |
| 仓位 | `仓位 78.4%` 进度条（`transform:scaleX`；85% 刻度仅在 `maxPosPct` **已保存**时画） |

> `今日已实现` 在本版有真实来源：宿主每天写一个净值点（同日覆盖），取 `今日 realized − 上一净值点 realized`；缺今日点/缺点 ⇒ `—` + title，不拿累计值冒充。

### 1.4 右栏 · 持仓 / 挂单 / Agent 绩效

| 项 | 实现 |
|---|---|
| tab 卡 | `持仓 8 / 挂单 0`；行 = 名称 + 代码 + 权重 + 盈亏%（`现价/成本 − 1`，红涨绿跌）；点行联动中栏详情 |
| 上限提示 | 表头右上 `权重 / 上限 15%` **只读已保存的 `perStockPct`**；未保存 ⇒ 整段不渲染（不拿设计稿默认值充数） |
| 挂单 | `status === 'pending'` 才算挂单；行 = BUY/SELL + 名称 + 待成交 + 限价/数量/已成/时间 + 进度条；无挂单 ⇒ `—（当前无挂单）` |
| Agent 绩效 | 四格 `决策 20 / 胜率 — / 回撤 — / 超额 —` + 底部 sparkline（`state.equity` 最近 20 点）；少于 2 点 ⇒ `—（样本不足）` |

### 1.5 底部状态条（28px）

`行情源 — · 决策引擎 cn:deepseek-v4.1-flash · T — · 决策周期 09:35 · 11:15 · 13:10 · 14:35 · 约束版本 — · 风控 全部通过`

- `决策周期` = `settings.times` 的真实时点（不写演示值 `90s`）。
- `风控` = 今日被拒委托 + 今日各轮 `decision.rejects` 之和；0 ⇒ `全部通过`，否则 `拦截 N 笔`。
- 设计稿右端的「演示环境免责句」**未实现**（仓内红线）。

---

## 2. 三条红线（与第一批同一套）

1. **有源才出数**：`复审 / token` 无字段 ⇒ 字段 `null`，界面不渲染该 chip（不写 `—` 占位、更不写 0）；
   胜率 / 回撤 / 超额 / 行情源 / T / 约束版本同为 `null` ⇒ `—` + title 原因。
2. **默认值不参与呈现**：`上限 15%`、`85%` 刻度只认已保存值；未保存就不出现。
3. **不新增路由 / 不新增依赖**：图表只打既有 `/trend`、`/kline`；`package.json` 依赖零变化；`build.mjs` 未动。

---

## 3. 与设计稿的已知偏离（都写在代码注释里）

| 处 | 设计稿 | 本批 | 原因 |
|---|---|---|---|
| 决策流条数 | `16 条留痕` | `244 条留痕` | 设计稿是演示数据；本批按真实 runs/orders 派生 |
| 决策流 chips | 每条都有 `复审 0.71 / 702 tok` | 只有 `N ms` 有源时出现 | 宿主无 confidence / token 字段（R1） |
| AI 研判 | 一句结论 + 0.68 | `—（无研判）` | 宿主无结论与置信度字段 |
| 图表 DOM | canvas 196px | SVG（复用仓内图组件）+ 206–268px | 复用既有组件；高度按读数可读性定 |
| 挂单行 | 设计稿有 1 条演示挂单 | 当前真实挂单 0 条 ⇒ 空态 | 宿主当前无 pending 委托 |
| 状态条温度 | `T=0.25` | `T —` | `settings` 无温度字段 |
| 右栏面板高度 | flex:1（min-height 238） | 同（370–1000 随内容） | 与设计稿一致，空区来自真实只有 8 行持仓 |

---

## 4. 门禁

| 项 | 读数 |
|---|---|
| `tsc --noEmit` | **0 error** |
| `npm run check` 第 1 轮 | 1692/1692（默认 TZ + `TZ=UTC` 两遍全绿），host 自检 ALL PASSED，build **73 片段** |
| `npm run check` 第 2 轮 | 同上 1692/1692、73 片段 |
| 测试总数 | 1628 → **1692**（新增 `prismDeskMid.test.ts` 36 条 + `prismDeskSide.test.ts` 28 条；改 9 条与设计稿冲突的旧断言，只增不减） |

本轮刻意同步修改的旧断言（都在第一批里写死了「本批不动中右栏」）：

- `prismShell ⑬`（详情 KV 七字段 → 九项口径）、`⑯`（右栏四项 + 绩效五项 → 四格）、`⑰`（tokenUsage → 绩效无源 + spark）、`㉓`（`desk.decisionFlow` → `state.runs`）
- `prismB7`（部分失败隔离的字段名）
- `prismDeskPath ④`（`ratioPctOf(ov.positionPct)` → `accountViewOf`）、`⑤`（状态/来源标签表搬到 `prismDeskMid`）
- `prismDeskTop ㊻`（接口白名单加 `trend`/`kline`；仍禁止新路由封装）

---

## 5. 截图

- `docs/shots/PRISM-AGENT-DESK-B2-1700-dark.png`：1700×1200 深色整页（三栏 + 底条）。
- `docs/shots/PRISM-AGENT-DESK-B2-1700-dark-interactive.png`：挂单 tab + `权重 / 上限 15%`（已保存约束）展开态。
- `docs/shots/PRISM-AGENT-DESK-B2A-1700-dark.png`：中栏单段验收截图（右栏仍为旧版）。

**来源：静态镜像，不是 CDP 实机。** 做法与第一批同一套：同一份 `src/client` 代码用 esbuild 打成 IIFE，`fetch` 打桩喂
**实机真实回包**——在已登录的 DSH Web 会话里用 CDP 现场取 `/tradewatcher/prism`（744 KB）+ 8 只持仓的
`/detail` `/trend` `/kline`，冻结成夹具后渲染截图；仓库侧没有新增任何路由或请求。

布局实测：

- 1700px：board `clientWidth 1700 / scrollWidth 1700`、`clientHeight 1116 / scrollHeight 1116`（无横向/纵向溢出）；列宽 392 / 890 / 374。
- 1100px：单列 `clientWidth 1085 / scrollWidth 1085`（无横向溢出），整页纵向滚动；底条 1100/1100。

---

## 6. 改动文件

| 文件 | 变更 |
|---|---|
| `src/client/prismDeskMid.ts` | 新增：详情行情头 / 九项口径 / 成交标记 / AI 研判 / 决策流派生与六 tab 计数 |
| `src/client/prismDeskSide.ts` | 新增：账户总览 / 挂单队列 / 绩效四格 / sparkline / 底条六项 |
| `src/client/prismDeskMid.test.ts` | 新增 36 条 |
| `src/client/prismDeskSide.test.ts` | 新增 28 条 |
| `src/client/PrismPage.tsx` | 中栏与右栏重写 + 底条 + 图表取数/测宽 |
| `src/client/styles.ts` | 中/右栏与底条样式；三栏高度约束（`grid-auto-rows:minmax(0,1fr)`）与 ≤1100 单列回退 |
| `src/client/index.tsx` | 给 `PrismPage` 传 `redUp`（跟随 `prefs.redUp`） |
| `src/client/prismShell.test.ts` / `prismB7.test.ts` / `prismDeskPath.test.ts` / `prismDeskTop.test.ts` | 同步 9 条与设计稿冲突的旧断言 |

> 工作树里另有 `src/client/api.ts`（`prismConstraints` 允许传 `null`）与 `src/client/prismEdit.test.ts` 两处改动，是**第一批**留下的未提交内容，本批未触碰。

未提交、未重启（按要求）。
