# P1：apply 幂等 + core 服务 + 抽出 calendar 行 + 活跃行端点（task-52）· 实现记录

对象：`dsh-tradewatcher` v0.43.0 工作区。设计依据 `docs/DESIGN-SUBPLUGINS.md`（机制已取证，未重查）。
基线 331 条；末次 `npm run check`：**340 条 × 2 时区全绿**、`ALL HOST CHECKS PASSED (live probes soft)`、
`built lib/index.js + lib/client.js（v0.43.0，客户端片段校验通过：75 项）` ⇒ **`build.mjs` 零改动**（六条行共用同一入口，靠 `config.row` 区分 —— 不需要新入口文件）。
未安装任何 bundle、未改 profile、不 commit、不重启。

## 第 1 段：幂等 + 按行分工

- **`config.row`**（`core` | `calendar` | `watchlist` | `portfolio` | `market` | `cloudmap`）：读第二参数或 `ctx.config`，
  **缺省 `core`** ⇒ 老 profile 行为与拆分前一致；认不出的值退回 `core`（不猜）。
- **模块级单例内核** `CoreKernel { store, calendar, rescue, activeRows, started }` +
  **一次性副作用守卫**：`store.init()` / `rescue.start()` 只在 `started === false` 时执行一次
  （重复 `apply` 记一条 debug 日志后跳过）⇒ **N 行装载只会有 1 个采样器**（不会再并发写 `rescue-log.json`）。
- **`provide('tradewatcher.core')`**：core 行提供服务；功能行用 `ctx.get('tradewatcher.core')` 拿；
  **拿不到就拒绝注册并记日志**（绝不各自 `new DataStore()`）。
- `PluginContext` 最小扩宽：`config?` 与 `provide?`（可选，测试的假 ctx 可以不实现）。
- 新增**测试钩子** `__kernelStats`（inits/starts/applies/rows/routeRegs）—— 幂等的证据就靠它。

## 第 2 段：calendar 行 + 活跃行端点 + 客户端 gate

- **行 → 路由/工具**的映射表写在 `src/index.ts`（`ROW_ROUTES` / `ROW_TOOLS`）：
  - **core**：注册**除功能行独占前缀之外**的全部路由 + **排除**功能行工具（老 profile 只有 core ⇒ 与今天逐字一致）；
  - **calendar**：只注册 `/tradewatcher/calendar*` 与 `calendar`/`calendar_add` 两个工具；行未激活 ⇒ 什么也不注册 ⇒ **路由天然 404**。
  - `makeAgentTools(..., filter)` 新增 `only`/`exclude`（不含前缀的短名；都不给 = 全量，老行为不变）。
- **`GET /tradewatcher/rows`**：由 **core 持有**（`makeTradeRoutes` 新增第 7 参数 `activeRows` 读取器，缺省 `['core']`）
  ⇒ 端点不依赖任何功能行，永远可用；返回 `{ rows, asOf }`。
- **客户端 gate**：新纯函数 `src/client/tabsGate.ts`（`gateTabs`），每个 tab 带所属 `row`：
  - **端点不可达 ⇒ 失败放行**（`rows === null` 视为全开）；
  - **全关 ⇒ `hideBar`**（不渲染 tab 条这个空壳）；**当前页被停用 ⇒ `fallback` 回落首个可用 tab**；
  - 老 profile（只有 core 或端点缺失）⇒ 全部照常渲染，与今天一致。

## 第 3 段：bundle patch（只写文件，未安装）

`cordis.patch.yml` 改成 6 行：`core` + `calendar` 启用，`watchlist/portfolio/market/cloudmap` **先写 `disabled: true`**
（它们的路由暂时仍由 core 兜着，P2–P4 逐个搬迁后再打开）。字段形状照设计文档骨架与 `dsh-base` 实证。
**安装由 Lead 执行**，本批只写文件。

## 验收实测

```
① 幂等（src/index.test.ts，隔离 DSH_HOME 到临时目录）：
   apply 三次 ⇒ applies=3、inits=1、starts=1（采样器只有一个）、rows 端点已注册、rescue.running=true
② 向后兼容：rowOf(undefined) === 'core'；无 config 时 core 注册的行里含 /tradewatcher/rows 与核心工具，
   且不含 /tradewatcher/calendar* 与 calendar 工具（后者由 calendar 行负责）
③ calendar 关闭（= 只 apply core）：core.routes 里没有任何 /tradewatcher/calendar* ⇒ 路由 404；
   core.tools 不含 tradewatcher_calendar；gate 结果里不出现 calendar tab
   （src/client/tabsGate.test.ts 覆盖：失败放行 3/3、关掉日历后剩下 2 个、当前页被停用回落 watch、全关 hideBar）
④ 功能行拿不到内核 ⇒ 一个路由/工具都不注册（防多实例互踩）
```
```
331 → 340（+4 幂等/分工、+5 tab gate）
npm run check：340 × 2 时区全绿；75 项片段校验通过；build.mjs 零改动
```

## 未做项与原因（留给 P2–P4）
1. `watchlist/portfolio/market/cloudmap` 四行**只登记、未搬迁**（patch 里 `disabled: true`）：它们的路由/工具/ tab 仍由 core + 客户端的行门控兜着 —— 与"P1 只抽日历"一致。
2. 客户端 bundle 仍是**包级单实例**（机制所限）⇒ 停用门控靠 `/tradewatcher/rows` + `gateTabs`，没有按行拆 client。
3. 未跑真实的"多行装载"（需要 Lead 装 bundle）：本批的证据是**同进程 apply N 次**的等价模拟。

## 需装机复核（真正的多行装载）
① Lead 装 bundle 后确认 6 行都 active、面板照常；② 把 `tradewatcher-calendar` 置 `disabled: true` 后：日历 tab 消失、
`/tradewatcher/calendar*` 404、工具列表里没有 `tradewatcher_calendar`，其余 tab 不受影响；
③ 停用日历后重启/刷新，确认没有"白屏/停在已停用页"；④ 确认 `rescue-log.json` 只有一个写入者（不再并发）。
