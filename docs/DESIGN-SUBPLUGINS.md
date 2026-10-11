# 设计：一个 bundle 内的多行子组件（可独立开关）+ 迁移路径

**目标**：把 `dsh-tradewatcher` 从单行插件改成「core + 功能行」的多行 bundle，使【实时行情条】【自选】【持仓】【大盘】【云图】【日历】各自可开关。**只读设计**，不改代码、不改 profile、未安装任何 bundle。
**结论**：DSH 支持**同一 package 出现在多条 Loader 行**（靠 `id` + `config` 区分），我们**不需要**照抄参考包的"子路径壳"；但**每行的 host 半区是独立 fiber（apply 会被调用多次）**，共享内核必须靠 core 行 + service 注入。下面每条都有 file:line 或命令输出。

## 1. 机制实证

### 1.1 参考实现 `@linxin666/dsh-web-all`（用户截图那种形态）
- 定位命令：`cordis_inspect_query(Config.listConfigs, {name:"@linxin666/dsh-web-all"})` → `{id:"include:web-ui-compat", patchId:"web-ui-compat", packageDir:"/home/hu/.dsh/profiles/web/node_modules/@linxin666/dsh-web-all", status:"absent"}`。
- **一行一个子组件**：`<pkg>/cordis.patch.yml:13-33` 是一串 `- insert:`，每段一行，形如
  `- id: web-ui-market` / `name: '@linxin666/dsh-web-all/market'` / `config: {plugin: '@linxin666/dsh-client-ui-market'}`（同文件还给出 settings:15、task-board 等；全文 151 行、约 20 行）。
- **子名 ↔ 包内文件的对应**：`<pkg>/package.json` 的 `exports` 里 **所有** `./<family>` 都指向**同一个** `./lib/shells/shell.js`；该文件只有 2 行（`import { i as inject, r as apply, t as Config } from "../shell-CKmkldkq.js"`），真正逻辑在 `lib/shell-CKmkldkq.js`：`apply` 校验 `config.plugin`（:1167 缺则记录降级并挂空）、`await import(spec)` 动态加载真实插件包（:1188）、失败记 `recordDegraded`（:1193/1198/1210）。
- **"运行中/已关闭"由 `disabled` 决定**：profile 层 `/home/hu/.dsh/profiles/web/cordis.patch.yml` 用 `- id: web-ui-market … / disabled: true` 关闭该行（同文件另有 `- id: tradewatcher / disabled: false`）。`plugin_manager list_plugins` 的字段印证：`enabled:false ⇒ fiberPhase:null`（如 `tool-bash`），`enabled:true ⇒ fiberPhase:"active"`。
- **停用后浏览器半区怎么知道**：`lib/shell-CKmkldkq.js:889` 起是 `src/rows.ts`：apply 时 `shellState().activeRows.add(plugin)`（:912）、dispose 时删（:916）、路由 `path:"/api/dsh-web-all/rows"`（:995）返回 `{children:[…真实插件包名]}`（:1003）；该路由由 **shell 自身**持有，"stays up even when every family row is disabled"（:1030），且**不做 loopback 限制**（:988）。`README.zh.md:31` 明确："宿主半经 `GET /api/dsh-web-all/rows` 告知浏览器半哪些行活跃…被停用的行连设置入口一并消失（路由不可达时**失败放行**、全部照常挂载）"。
- **它为什么要"壳"**：它的子组件都是**独立 npm 包**（`package.json.dependencies` 列了 19 个 `@linxin666/dsh-*`），壳负责把「独立包的 host 半区」折叠进聚合行。**我们的六个功能都在同一个包内，不需要这层**。

### 1.2 DSH 本体：多行怎么写、开关怎么覆盖
- **同一 package 多行的官方样例**：`…/@deepseek-ai/dsh-base/cordis.patch.yml:370-387` 两行同 `name: '@deepseek-ai/dsh-tool-subagent'`，靠 `id: tool-subagent` / `id: tool-subagent-fork` + 不同 `config.provider` 区分 ⇒ **同包多行合法**。
- **子路径行样例**：`…/dsh-web-app/cordis.patch.yml:167-168`（`name: '@deepseek-ai/dsh-web-app/startup'`，同包另一行是 `@deepseek-ai/dsh-web-app`）。
- **`disabled` 的三种写法**：布尔（`dsh-web-app/cordis.patch.yml:465+` 一串 `disabled: true`）、`!!js` 表达式（同文件 :46 `!!js "ctx.get('profileContext')?.name !== 'desktop'"`）、以及被上层按 id 覆盖（技能文档：**按 id 的 patch 会整体替换该行 `config`，不是深合并**）。
- **inject 与顺序**：`dsh-web-app/cordis.patch.yml:8-9` 注释："Rows configured from flags inject that service, so Loader resolves their expressions only after it exists" ⇒ 行依赖用 `inject` 表达，Loader 保证顺序。
- **我们可照抄的最小骨架**（替换本仓库 `cordis.patch.yml:13-15`）：
  ```yaml
  - insert:
      - id: tradewatcher-core
        name: 'dsh-tradewatcher'
        config: { row: core }
      - id: tradewatcher-calendar
        name: 'dsh-tradewatcher'
        config: { row: calendar }
      # …其余功能行同形；关闭某行由 profile 层写 `- id: tradewatcher-calendar` + `disabled: true`
  ```
- **谁决定浏览器加载哪些 client 半区**：`…/dsh-client-modules/lib/index.js:121-122` 的模块注释："The manifest package name identifies the browser module; **distinct active Loader sources for that package are a composition error**"；入口解析规则是 `exports["./client"]`（`lib/index.js:170-180`），同一个包只注册一个浏览器模块（`README.md:38` "a replay would stop at the first duplicate registration"）⇒ **client 半区是"包级、单实例"，不能按行拆**。

### 1.3 我们现在的装配与要改的点
| 事项 | 位置 | 现状 |
|---|---|---|
| bundle 行 | `cordis.patch.yml:13-15` | 单行 `id: tradewatcher` / `name: dsh-tradewatcher`（无 config） |
| manifest | `package.json:10-16`（exports 仅 `.` / `./client` / `./package.json`）、`:17-24`（`dsh.bundle.patch`、`dsh.client.platform`） | 单入口双面 |
| 构建 | `build.mjs:61-85`（host→`lib/index.js`、client→`lib/client.js`）、`:192-210`（构建期硬校验 75 项 UI 片段，只查 `lib/client.js`） | 两产物 |
| host 装配 | `src/index.ts:17`（apply）、`:48`（`makeTradeRoutes`）、`:76`（`makeAgentTools`）；路由 `src/host/routes.ts:167`（22 条 `/tradewatcher/*`，如 `:211 health`、`:845 calendar`）；工具 `src/host/tools.ts:151`（12 个 `tradewatcher_*`，如 `:169 portfolio`、`:622 calendar`） | 全量一次性注册 |
| client 注册 | `src/client/index.tsx:89`（`inject=['slots']`）、`:99-107`（`sidebar.panellist`，`id=PANEL_ID`、`order:60`）、`:114`（`main`，`key=PANEL_ID`）；页签 `:185`（`PageKey`）、`:343-349`（tabs 数组） | 单个 client 入口，tab 硬编码 5 个 |

## 2. 行怎么切（选定方案）

**core 行（必需，不可关）**：`tradewatcher-core` —— host：`DataStore`（watch/positions/ledger/prefs）、`em` 取数 + LKG、`/health` `/prefs` `/backup` `/quotes` `/badge` `/tones` `/trend` `/kline` `/detail` `/suggest` `/ytd` `/undo`、`quotes`/`search`/`position`/`ytd` 工具；另持有 **`/tradewatcher/rows`**（活跃行清单）。client：外壳 + 顶部行情条 + 详情抽屉 + 侧栏图标/徽标 + 样式表 + **全部 Slot 注册**。
**功能行（可关）**：`watchlist`（`/watch` `/ledger` `/trades`、`watchlist`/`group_rank` 工具、自选 tab）｜`portfolio`（`/portfolio`、`portfolio`/`ledger` 工具、持仓 tab）｜`market`（`/breadth` `/board` `/rescue` `/anomaly` `/industries` `/industry`、`rescue` 工具、大盘 tab + 护盘面板）｜`cloudmap`（**无 host 路由**，纯客户端 iframe，云图 tab）｜`calendar`（`/calendar`、`calendar`/`calendar_add` 工具，日历 tab）。
**总行数**：core + 5 = 6 行；【实时行情条】不单独成行（它是 core 的外壳组件，拆出去会让 core 空转且抽屉依赖它）。若用户坚持要"行情条"也能关：加第 7 行 `strip`，client 侧仅 gate 该组件（代价：core 仍持有行情引擎）。
**被否决的切法**：按"数据来源"切（行情行 / 账本行 / 日历行 / 云端行）——一个 tab 会依赖两行，关掉任一行都留下半个页面，违背"可单独开关"；也违背 §3 的"不出现空壳"。
**取舍判据**：一个功能行 = **一条 host 路由段 + 一个 tab + 一组工具**，三者同生共死；跨行的（`ytd`/`search`/`position`/`undo`）一律留 core，避免"关掉自选导致持仓页 YTD 失效"。

## 3. 行被停用时界面表现（选定：tab 消失 + 空态收敛）

- **选择**：tab **直接不渲染**（不是灰显）。理由：① 参考实现同款（`README.zh.md:31`"被停用的行连设置入口一并消失"）；② 灰显 tab 点击后只能给"未启用"，与项目"缺失必须给原因"口径冲突且无动作可做；③ 不渲染就没有"点了没反应"的故障感。
- **实现**：client 启动时读 `GET /tradewatcher/rows`（core 提供）→ 用返回的 `rows[]` 过滤 `src/client/index.tsx:343-349` 的 tabs；`tabs.length === 0` 时**不渲染 `.tw-tabs` 容器**（避免空壳）；当前 `page` 被停用时回落到第一个可用 tab（否则白屏）。
- **失败放行**：端点 404/超时/解析失败 ⇒ **全部按启用渲染**（照抄参考实现 "路由不可达时失败放行"）。理由：网络抖动不该让界面消失；真正停用的行仍有 host 路由 404 兜底。
- **停用行的残留 UI**：抽屉（core）不依赖功能行；若用户在停用前停在"日历"页，回落逻辑会把他带到第一可用 tab —— 这一点必须在实现时验证（见 §5 判据）。

## 4. 共享内核边界与机制选择

| 层 | 留 core | 归功能行 |
|---|---|---|
| host | `store.ts`/`model.ts`/`em.ts`/`time.ts`/`http.ts`/`fence.ts`/`writeLog.ts`/`trendArchive.ts`、`rows` 端点、`/prefs` | 各自的路由段函数与工具段函数 |
| client | `api.ts`、`useQuotes`（行情引擎）、`format.ts`、`styles.ts`、`ui.tsx`、`useNow`、外壳、**全部 Slot 注册** | `WatchlistPage`/`PortfolioPage`/`MarketPage`/`CloudMap`/`CalendarPage` 组件本体 |

- **host 用 `inject` + service（不用 import 直连）**：core 行 `provide` 一个 `tradewatcher.core`（`{store, calendar, rescue, prefs, rows}`），功能行 `inject: ['tradewatcher.core']`。理由：① Loader 的行挂载顺序由 inject 保证（`dsh-web-app/cordis.patch.yml:8-9` 的做法）；② import 直连会让功能行**各自 `new DataStore()`**，多实例并发写同一份 JSON —— 我们已有原子写与 `writeChain`，多实例会互踩（`src/host/store.ts` 的 `persist`）。**判据：任何 `new DataStore()` 只允许出现在 core 行**。
- **client 不能用行级 inject**：包级单 client 入口 + "manifest package name 唯一"（§1.2）⇒ 浏览器侧只有一个实例。gate 由 core 的 `rows` 端点完成；**所有 `ctx.slots.register` 只允许出现在 core 的 client 路径里**，功能行不得各自注册 Slot（否则一旦多行共享同包，注册会冲突或重复）。
- **单 bundle 一次安装 > 多个 bundle**：① 用户截图就是前者；② 多包会让 core 被各功能包重复依赖、版本漂移；③ 多包 = 多份 `DataStore`/定时器（`RescueMonitor` 采样循环）⇒ 数据竞争，**这才是硬理由**。故：**一个 npm 包、一个 client bundle、六条 Loader 行**。

## 5. 迁移路径（每阶段可独立验证、可随时停）

- **P0 骨架（不改行为）**：`src/index.ts` 的 apply 改为读 `config.row`（缺省 `core`，且**缺省时保持现状=全部启用**，向后兼容老 profile 的无 config 行）；6 条行先全部插在 `cordis.patch.yml`，但 `config.row` 只解析 core，功能行是空操作。验收：`npm test` 全绿；`plugin_manager list_plugins` 出现 6 条 `enabled:true, fiberPhase:"active"`；界面与现在**完全一致**。
- **P1 最小切片（证明整条链路）**：切 **【日历】**（它同时有 host 路由、工具、tab —— 三处 gate 都能验证；云图虽更小但只有 client 一处，证明力弱）。
  验收判据（全部要跑）：① 插件列表出现 `tradewatcher-core` 与 `tradewatcher-calendar` 两行，可独立开关；② 关掉 calendar 后 `curl /tradewatcher/calendar` → 404（或未注册）、`Tool.listTools` 里 `tradewatcher_calendar`/`calendar_add` 消失、面板不再有"日历"tab **且不出现空壳**、`GET /tradewatcher/rows` 的 `rows[]` 里没有 calendar；③ core 的行情条/自选/持仓/大盘照常，无 unhandled rejection；④ 重开行后恢复；⑤ 重启 `dsh web` 后开关状态保持（在 profile patch 里）；⑥ 老 profile（无 config 的单行）启动后行为不变。
- **P2**：依 §2 顺序切 `cloudmap`（最快）→ `watchlist` → `portfolio` → `market`（含护盘采样，风险最高，放最后；`RescueMonitor` 必须留在 core 或改成 core 代管）。
- **P3 收尾**：README/CHANGELOG 行清单与开关说明；`build.mjs` 的 75 项片段校验**无需改**（client 产物仍是单文件）；补一条断言：`cordis.patch.yml` 里每条功能行的 `config.row` 都在代码的行表里（防拼错 row 名导致静默不挂载）。

### 5.1 P1 的改动清单（文件级，供实现者直接落地）
| 文件 | 改动 |
|---|---|
| `cordis.patch.yml:13-15` | 单行 → 6 行 insert（§1.2 骨架）；**用 id 前缀 `tradewatcher-*` 而不是 `group: true`**——平铺的行在插件列表里各自可开关，分组行自身也会占一行 |
| `src/index.ts:17` | `apply(ctx, config)` 读 `config.row`（缺省 `core` ⇒ 老 profile 行为不变；现行签名无 `config` 参数，需补上）；`:31` 的 `store.init()` 与 `:41` 的 `rescue.start()` 收进 core 分支 + 模块级幂等 |
| `src/host/routes.ts:167` | 增加 `row` 参数：每个功能行只注册自己那段 `/tradewatcher/*`（§2 映射）；core 额外注册 `GET /tradewatcher/rows` |
| `src/host/tools.ts:151` | 按 `row` 过滤 `tradewatcher_*` 工具；`:1365` 的 systemPrompt 段同步过滤 |
| `src/client/api.ts` | 加 `rows()`（拉 `{rows:[…]}`，失败返回 null） |
| `src/client/index.tsx:343-349` | tabs 按 `rows` 过滤；`tabs.length===0` 不渲染 `.tw-tabs`；当前 `page` 不在可用集合时回落到首个可用 tab；Slot 注册（`:99-114`）保持只在这里、并加 `registered` 幂等 |
| 测试 | 新增 `rows` 端点与 tab 过滤的纯函数断言（`node --test` 可跑，不进 `lib/`） |

## 6. 风险清单（判据 + 验证）

| 风险 | 判据 | 验证 |
|---|---|---|
| 同一 name 多行 ⇒ host apply 被调用 N 次 | `src/index.ts:17` 的 apply 现在无条件 `store.init()`（`:31`）/`rescue.start()`（`:41`）；6 次调用会重复起采样循环 | 把初始化收进 core 分支 + 模块级幂等；`plugin_manager list_plugins` 看 `fiberPhase`，并确认只有一个采样器（日志/`rescue` 快照时间序） |
| client 侧多行重复注册 Slot | 包级单实例（§1.2）；但"注册"若写在功能行分支里仍可能被多次执行 | 所有 `slots.register` 只在 core 分支；模块级 `registered` 幂等；`cordis_inspect_query(Slots.listSubTree, {root:'sidebar.panellist'})` 只出现一条 `tradewatcher` |
| `build.mjs` 75 项片段校验 | `build.mjs:192-210` 只读 `lib/client.js`；代码仍在一个 bundle ⇒ 不破 | `npm run build` 末尾打印"客户端片段校验通过：75 项" |
| `styles.ts` 单次注入 + 两条 data-blur 清单 | 样式表全量注入，未用选择器无害；但新行的新数字面必须登记进 `styles.ts:138` 与 `:151` 两条 `data-blur=1` 清单 | `styles.test.ts` + 装机切隐身档逐个 tab 看 |
| prefs 键归属与向后兼容 | `DEFAULT_PREFS`（`src/shared/model.ts:672-688`）是全行并集；**停用行不删键**（重开行后设置还在） | 停用→重启→重开一次，比对 `prefs.json` 不变；老 profile 升级不丢键（`store.ts` 的归一化入口） |
| 工具/路由的归属行 | 停用即消失（行语义 = 不加载不注册）；但工具的 **systemPrompt guidance**（`src/host/tools.ts:1365` 的"缺失分两类…"整段）必须同步 gate，否则模型被引导调不存在的工具 | `Tool.listTools` + 一次工具调用回包里的 guidance 文本 |
| tab 顺序 | 固定顺序表来自 `src/client/index.tsx:343-349`，停用只过滤不重排 | 三个 tab 任意组合停用/启用，顺序恒定 |
| `rows` 端点自身 | 由 core 持有（参考实现同款：shell 持有、`rows` 路由不随家族行消失），**不 loopback fence**（参考实现明确如此） | core 行开着时端点始终 200；core 关掉则整个插件失效（文档里写明 core 必需） |
| 客户端 fail-open | 端点不可达 ⇒ 全部渲染（照抄参考实现） | 临时把 core 的 rows 路由改成 500，界面仍完整（不消失） |
| 开关写回与覆盖层冲突 | 用户 patch 按 id 覆盖；**同一 id 在更高优先级层再次覆盖会 `overridden`**（技能文档） | `plugin_manager set_bundle/set_plugin` 的结果字段；profile patch 只保留一份该 id |

## 7. 明确不做 / 未验证

- **不做**：拆多个 npm 包；为每行产出独立 client bundle；重写数据层；把 `RescueMonitor` 采样循环挪进可关闭的功能行（采样必须随 core 常驻，否则大盘行的历史信号会断档）。
- **未验证**（本轮约束：只读、不安装、不改 profile）：① 同一包多行时**浏览器侧** `apply` 被调用几次（server 侧必然多次）——设计上不依赖它：gate 全在 core 的 `rows` 端点 + 模块级幂等；② `dsh.client` 是否支持按行区分（`dsh-client-modules/lib/client.js:63-68` 的解析按"包名"进行，判为不支持，未做实验）；③ 我们自己的 6 行形态**未在本机装载实测**（需 P0 阶段验证）。
- **参考实现的两个坑要记住**：其 `README.zh.md:69` 记录过"keyed slot 用 `id` 而非必填 `key`"导致 GUI 启动失败 ⇒ 我们注册 keyed 槽（`main`）时必须给 `key`（我们已经在用 `key: PANEL_ID`，`src/client/index.tsx:114`）；其外部行标记 `"inactive": true` 时会在产物后追加 `disabled: true` 覆盖行（`README.zh.md:27`）——这正是"出厂默认关闭"的实现方式，我们照抄即可。
