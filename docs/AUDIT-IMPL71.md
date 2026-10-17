# AUDIT-IMPL71：review-8 客户端六项落地（P0-1 / P0-2 / P0-3 / U1 / U2 / U3）

- **实施时刻**：2026-10-17 20:40–21:35（Asia/Shanghai）
- **基线**：`main` @ `8b06d5d`（v0.104.0）。评审依据：`docs/REVIEW-8-CLIENT-UX.md`（425 行）。
- **本批只做六项**：P0-1 首屏崩溃 / P0-2 汇总与屏幕卡片对不上 / P0-3 删「胜率」 / U1 失败原因进弹窗 / U2 首屏失败不给永久骨架 / U3 请求去重。
- **未改 `build.mjs`**：73 项客户端片段校验全部原样通过（没有任何锁定片段需要改）。
  期间踩到过一次锁定片段：`无行情源 N` 的唯一来源是 `quoteState.ts` 里的一句**注释**（esbuild 非压缩构建保留注释），我重写该段注释时把 `N` 丢了 ⇒ 构建校验失败。处理方式：**改回原注释措辞**（该句仍然成立），`build.mjs` 不动、片段表不动。⚠ 留给 Lead 的一条脆弱点：这条锁实际锁的是一句注释，建议下一批把它换成真实字符串（届时才需要动 `build.mjs`，本批按纪律不碰）。
- **工作区注意**：本机同时有**另一批 host 侧改动在并行发生**（`src/host/{marketExtras,robotsGate,routes,sina,klineUnits,lock}.ts`、`src/host/fix7Host.test.ts`、`docs/DECISIONS.md`、`docs/REVIEW-7-HOST.md`，均非本批改动）。因此下面的用例数与全绿结论都标注了"含并行批次"的拆分。
- **纪律**：不 commit、不装依赖、不动 profile、不重启 `dsh web`、不手工写 `~/.dsh`；没有新增运行时依赖。

---

## 0. 结论（一行）

六项全部落地并配了**可失败的反例注入**：持仓页/自选页首屏失败不再崩/不再永久骨架（原因 + 重试）、行情条汇总分母改成屏幕卡片数并新增 `pending` 态（隐藏卡不再被说成"缺失"）、做T 摘要的「胜率」换成中性事实（次数/净额/平均每笔，口径进悬停）、四条写路径的失败原因落进**弹窗内**（`mutate` 改为返回 Promise，删掉吞错）、四条 effect 从"对象身份驱动"改成"节拍驱动"（静置 10 分钟调用数 60 → 10/10/20/10）。

---

## 1. P0-1 持仓页首屏失败会崩（渲染期 TypeError）

**问题**（评审 §P0-1）：`PortfolioPage.tsx:184-188` 只挡 `view === null && error === null`；`view === null && error !== null` 会落到 `[...view.groups]` ⇒ `TypeError`，`tsconfig` 是 `strict:false`，tsc 拦不住。

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `src/client/PortfolioPage.tsx:191-219` | 首屏守卫改成 `if (view === null)`，**加载中 / 失败分成两条路**：失败分支渲染 `ErrorNote`（`持仓数据本次未取到 —— ${error}`）+ 一行 `role="note"` 说明（"这不代表没有持仓"）+ 「重试」按钮（绑 `reload`）。**失败分支完全不读 `view`** |
| `src/client/PortfolioPage.tsx:221` | `const groups = [...view.groups]` 现在严格在守卫**之后** |

**断言与注入**：`src/client/impl71.test.ts` → `P0-1：持仓页首屏失败 ⇒ 错误 + 原因 + 重试，且不读 view（不再渲染期崩溃）`

- 判据：守卫块必须含 `ErrorNote` / `重试` / `role: 'note'` / `未取到`；`error === null` 必须存在（区分加载中与失败）；失败分支**不得**出现 `view.` / `view[`；`[...view.groups]` 的位置必须在守卫之后。
- **注入**：把守卫退回旧写法 `if (view === null && error === null) { return <Skeleton/> }` ⇒ 判据非空、断言必败（已实测）。

---

## 2. P0-2 汇总与屏幕卡片对不上（27/28 常驻误报）

**问题**（评审 §P0-2）：`TopBar.tsx:356-366` 用 `TW_ROWS` 全量（实测 **28 张 / 4 行**）算汇总，`:380` 只渲染 `visibleCards`；`engineIds` 已不请求隐藏卡 ⇒ 隐藏 1 张后那张永远没有回包 ⇒ 「27/28 实时 · 1 缺失」常驻，且与相邻用服务端 `missing` 的「无行情源 N」互相打脸。

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `src/client/quoteState.ts:9-17` | `QuoteState` 五态：新增 **`pending`** |
| `src/client/quoteState.ts:57-77` | `quoteStateOf`：`isMissing` ⇒ `missing`（服务端结论优先）；`row === undefined` ⇒ **`pending`**；`row.price === null` ⇒ `missing`（顺序敏感，写进注释） |
| `src/client/quoteState.ts:35-43` | `QUOTE_STATE_LABEL.pending = PENDING_LABEL`（复用既有词表，**不新增文案概念**）；`missing = NO_SOURCE_LABEL` |
| `src/client/quoteState.ts:84` | `quoteStateTitle('pending')` 用既有 `PENDING_TITLE`，**不再**说"三源都没有" |
| `src/client/theme.ts:36-44` | `QUOTE_STATE_COLOR.pending = '#8a8f98'`（中性灰；该色板在主题容器之外，只能字面量） |
| `src/client/quoteState.ts:95-190` | 新增 `summarizeStrip()`（只对**屏幕**卡片求值，隐藏张数如实带回，并给 `noSourceOnScreen` = 屏幕 ∩ 服务端 missing）与 `stripSummaryTitle()`（`屏幕 N 张卡片 …；另有 M 张已隐藏（不请求、不计入本行）`） |
| `src/client/TopBar.tsx:356-381` | 汇总改用 `summarizeStrip({ screen: stripRows, hiddenCount, missing, stateOf })`；删掉原来第二份 `stripRows/stripIds` 与全量 `summarizeQuoteStates` |
| `src/client/TopBar.tsx:487-505` | 徽标正文/悬停来自 `stripSummary`；相邻「无行情源 N」改用 `noSourceOnScreen`（隐藏卡不计入） |
| `src/client/index.tsx` 未改 | `engineIds` 不请求隐藏卡的既有行为保持不变 |

**实算（用真实 `TW_ROWS` 跑出来的，不是估计）**

```
旧（全量 28 张）: 27/28 实时 · 1 缺失
新（屏幕 27 张）: 27/27 实时 | hidden = 1 | noSourceOnScreen = 0
新 title: 屏幕 27 张卡片：实时 27 · 延迟 0 · 定稿复用 0 · 未取到 0 · 无行情源 0；另有 1 张已隐藏（不请求、不计入本行）
          最近一次成功行情 14:32:05；来源明细：em 27
```

**断言与注入**：`src/client/quoteState.test.ts`（新增 3 条）

- `汇总分母 = 屏幕卡片数（隐藏卡不计入、永不出现在"缺失/未取到"里）`：27 张屏 + 1 张隐藏 ⇒ `total = 27`、`missing = 0`、`pending = 0`、徽标正文不匹配 `/缺失|无行情源|未取到/`、title 含「屏幕 27 张卡片」「另有 1 张已隐藏」。
  **注入**：同一函数改用**全量行**（28 张）计算 ⇒ `total = 28`、多出 1 个 `pending`，「分母 = 27」断言必败（已实测）。
- `相邻的「无行情源 N」也只数屏幕上的卡`：服务端集合混入已隐藏 secid ⇒ 仍只数到 1。
- `「未取到」的 title 不冒充三源结论`：`pending` 用 `PENDING_TITLE`，`missing` 才给三源结论。

**同类收尾**：`README.md:283-293`、`styles.ts:183` 的"四态"同步成"五态"（文档与行为不许互相打脸）。

---

## 3. P0-3 删「胜率」（直接违反用户红线）

**问题**（评审 §P0-3）：`PortfolioPage.tsx:1284` 渲染 `胜率 ${Math.round(winRate)}%`。

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `src/client/PortfolioPage.tsx:1293-1336` | 删掉「胜率」渲染；做T 收起态改成 **`做T N 次 · 净 ±X · 平均每笔 ±Y`**（`avgNet === null` 时只给前两项，缺价流水仍走「净 未取到（N 笔流水缺成交价）」） |
| `src/client/PortfolioPage.tsx:1313-1326` | 新增 `dayTradeTitle` 进 `title`（悬停）：样本次数、跨几个交易日、净额公式、方向语义（正T/反T）、"配不上的单边不硬凑"、以及"只统计已发生的交易，不做任何对将来的推断" |
| `src/client/PortfolioPage.tsx:1290` | 文件头注释同步（旧注释里也写着 `胜率 58%`，一并删） |

**「胜率」替换成了什么**：**中性事实**——`做T 12 次 · 净 +328.50 · 平均每笔 +27.38`（数字全部来自回包既有字段 `count/netPnl/avgNet`，零新口径、零新依赖）；口径（样本天数、公式、方向、边界）整段进悬停。`winRate` 仍留在宿主回包里（不影响 agent 工具），客户端**不再消费**。

**断言与注入**：`src/client/impl71.test.ts` → `P0-3：客户端源码不许出现"胜率/概率/预测 + 数字"`

- 判据：扫全部 `src/client/**` 产品源文件（排除 `*.test.ts`），正则 `/(胜率|概率|预测)\s*[:：]?\s*[0-9]/` 命中数 = **0**（实测 0）；并断言 `平均每笔` 已接线、`winRate` 已不再被界面消费、口径句在源码里。
- **注入**：往源码追加 `` `胜率 58%` `` ⇒ 判据必须命中、断言必败（已实测）。
- 边界说明：`RescuePanel` 里既有的"**不是**胜率、概率或预测"这类**否定式**诚实说明不受影响（该文件另有 `rescueVisual.test.ts` 的同类判据，本次未触碰）。

---

## 4. U1 失败原因要可见（弹窗内）

**问题**（评审 §P1-3 / §U2）：写失败原因落在 `.tw-mask`（`styles.ts:352` z-index 1200）**后面**；`mutate/saveConfig/submit` 有多处 `catch(() => undefined)` 静默吞错。

**改动（统一契约）**：`mutate` 一律改成 **返回 `Promise`、拒绝即失败**，由**失败发生的那一层**显示原因；页面级（非弹窗）按钮走新增的 `mutatePage`（失败写页面级 `ErrorNote`，仍可见，不是吞掉）。

| 文件:行号 | 改动 |
| --- | --- |
| `WatchlistPage.tsx:158-175` | `mutate(body): Promise<void>`（只更新数据、不再写页面级 error）+ `mutatePage(body)`；页面级三处（归档分组 `:346`、移除条目 `:505`、恢复分组 `:470`）改走 `mutatePage` |
| `WatchlistPage.tsx:518/521/523/533/567` | 弹窗五条写路径全部 `.then(onClose, (e: Error) => setErr(e.message))` —— 原因落在**弹窗自己的** `err` 槽（`ErrorNote` 在 `Modal` 内） |
| `PortfolioPage.tsx:159-181` | 同上：`mutate(body): Promise<void>` + `mutatePage`；页面级三处（归档分组 `:473`、移除空仓 `:518`、恢复分组 `:533`）走 `mutatePage` |
| `PortfolioPage.tsx:757-758 / 791-792 / 863-865 / 870 / 910` | `GroupFormModal` / `AddPosModal` / `TradeModal` / `PosEditModal` 的写失败全部落进各自 `err`（原先 4 个 Modal 的 `err` 只装本地校验；现在是"本地校验 + 上游失败"共用一个槽） |
| `CalendarPage.tsx:128-147` | `mutate(body): Promise<void>`（不再替弹窗关窗） |
| `CalendarPage.tsx:333-339` | `DayModal` 新增本层 `err` + `act()`：隐藏自动事件 / 删除事件失败 ⇒ 弹窗顶部给原因 |
| `CalendarPage.tsx:441-449` | `EventModal` 添加/保存：`.then(props.onClose, (e: Error) => setErr(e.message))` ⇒ **失败不关窗**，原因就地显示 |

**行为细节（有意为之）**：成功才关窗；失败**保持弹窗打开**并显示原因（用户可直接改完再提交）。`PortfolioPage` 的 `onDone` 回调参数随之删除（不再由父组件替弹窗关窗）。

**断言与注入**：`src/client/impl71.test.ts`（4 条）

- `U1：分组 / 加证券 / 移动 的写失败留在弹窗内（WatchlistPage）`：扫描 `WatchModal` 体内每个 `mutate({` 调用点**所在语句**，必须含 `setErr(`；另断言 `mutate` 返回 `Promise<void>`、页面级 `mutatePage` 仍把失败写进 `setError`。
- `U1：分组 / 加仓 / 买入卖出 / 编辑 的写失败留在弹窗内（PortfolioPage）`：四个 Modal 逐个扫描 `props.mutate(`。
- `U1：日历事件的写失败留在弹窗内（EventModal + DayModal 的隐藏/删除）`。
- `U1：三条写路径都不再用 catch(() => undefined)` 吞错。
- **注入**：把某个调用点的失败处理换成 `() => undefined` ⇒ 判据非空、断言必败（4 条各自都注入了，已实测）。

> 判据用"**语句级**窗口"而不是固定字符窗口：同一个弹窗里两个写调用点可能只隔几十个字符，用字符窗口会让"另一个调用点的 setErr"冒充本条（我们自己的第一版判据就这样假阴性过一次，已修）。

---

## 5. U2 首屏失败不得永久骨架屏

**问题**（评审 §P1-1）：`WatchlistPage.tsx:153` 失败时骨架屏永久显示，`:165` 的 `ErrorNote` 不可达。

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `src/client/WatchlistPage.tsx:176-203` | 首屏守卫改成 `if (watch === null)`：`error === null` ⇒ 骨架；否则渲染 `ErrorNote`（`自选列表本次未取到 —— ${error}`）+ `role="note"` 说明 + 「重试」（绑 `reload`）。**失败分支不读 `watch`** |

**断言与注入**：`src/client/impl71.test.ts` → `U2：自选页首屏失败 ⇒ 错误 + 原因 + 重试（不再永久骨架屏）`；判据与 P0-1 共用 `firstLoadProblems`（同一套语义，两个页面各一条），并额外断言重试按钮绑的是 `reload`。
**注入**：退回 `if (watch === null) return <Skeleton/>` ⇒ 判据非空、断言必败（已实测）。

---

## 6. U3 请求去重（对象身份 → 节拍信号）

**问题**（评审 §P2-3 / §U7）：四条 effect 依赖会换身份的对象 ⇒ 每 10 秒重发 `industries`（全自选）、`breadth?dist=1`（自注"多扫 ~56 页"）、`market-extras`、`trend`。

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `src/client/pacing.ts`（新增，109 行） | 纯函数与常量：`dueByInterval` / `dueEveryTicks` / `callsInWindowInterval` / `callsInWindowTicks` + `INDUSTRIES_EVERY_TICKS=6`、`BREADTH_MIN_INTERVAL_MS=60s`、`EXTRAS_MIN_INTERVAL_MS=30s`、`TREND_MIN_INTERVAL_MS=60s`、`CALL_BUDGET_10MIN` |
| `src/client/WatchlistPage.tsx:82-124` | `industries`：依赖 `[watch, quotes]` → **`[watch, props.quoteTs]`**；每 **6 拍**才发（`dueEveryTicks`），自选集合变化时立即发（不等节拍） |
| `src/client/MarketPage.tsx:104-131` | `breadth?dist=1`：依赖 `[amountForForecast]`/`quotes` → **`[props.quoteTs]`** + **60s** 最小间隔 |
| `src/client/MarketPage.tsx:137-163` | `market-extras`：依赖 → **`[props.quoteTs, amountForForecast]`** + **30s** 最小间隔（成交额仍直传 `amountForForecast`，宿主不必再抓一遍） |
| `src/client/RescuePanel.tsx:410-437` | `trend`：每拍重取 → **60s** 最小间隔；**切通道立刻取**（`switched` 分支） |
| `src/client/index.tsx:410` | 给 `MarketPage` 传 `quoteTs: engine.ts`（节拍信号） |
| `WatchlistPage.tsx:420-431`、`MarketPage.tsx:195-197/283-284/323/331/366`、`RescuePanel.tsx:763-767` | 副作用如实进 `title`：板块数据/涨跌家数"最多旧 60 秒"、附加行情"最多旧 30 秒"、护盘分时量能"最多旧 60 秒" |

**调用次数实测**（`node --experimental-strip-types` 直接跑 `pacing.ts` 的模型，10 分钟窗口、一拍 10s、含首拍）

| 路由 | 改前（每拍一次） | 改后 | 预算 |
| --- | --- | --- | --- |
| `/tradewatcher/industries` | 60 | **10** | ≤10 |
| `/tradewatcher/breadth?dist=1` | 60 | **10** | ≤10 |
| `/tradewatcher/market-extras` | 60 | **20** | ≤20 |
| `/tradewatcher/trend`（护盘分时量能） | 60 | **10** | ≤10 |

```
OLD (every tick): { industries: 60, breadth: 60, extras: 60, trend: 60 }
NEW:              { industries: 10, breadth: 10, extras: 20, trend: 10 }
```

> 这是**模型实算**（纯函数跑出来的），不是浏览器 Network 计数：本机没有浏览器自动化、也不允许重启 `dsh web`。模型与接线的对应关系由下面第 ③ 组断言钉死。

**断言与注入**：`src/client/pacing.test.ts`（6 条）

- 纯函数语义：`dueByInterval`（null 放行 / 到点 / 差 1ms 拦 / 坏值处理）、`dueEveryTicks`（第 1、7、13 拍取）。
- **模型**：10 分钟窗口四条路由 `10 / 10 / 20 / 10`，逐条 ≤ 预算；**注入**：不节流（`every=1` / `minMs=0`）⇒ `60 / 60 / 60 / 60`，预算断言必败（已实测）。
- **接线**（每条 effect 单独定位，按**位置**替换依赖数组，避免同一文件两处 `[props.quoteTs]` 被换错）：依赖里不许出现 `quotes` 对象身份、必须出现节拍信号（`props.quoteTs` / `snapshot?.ts`）、effect 体内必须有节拍守卫。
  **注入**：把依赖改回 `[props.quotes]` / `[lane, snapshot]` ⇒ 判据非空；删掉守卫行 ⇒ 判据非空（4 条 effect 全部注入，已实测）。
- 副作用披露：四条路由的"最多旧 60/30 秒"文案必须存在。

---

## 7. 门禁与验证

```
node_modules/.bin/tsc --noEmit -p tsconfig.json      → exit 0
node --test --experimental-strip-types "src/client/*.test.ts"
                                                     → 314 pass / 0 fail（含本批新增 16 条）
node --test --experimental-strip-types "src/**/*.test.ts"
                                                     → 800 pass / 0 fail
npm run check（typecheck + 两轮时区 + selftest + build）
                                                     → 见文末"门禁记录"
```

- **本批新增用例 16 条**：`quoteState.test.ts` +3、`impl71.test.ts` 7（新文件）、`pacing.test.ts` 6（新文件）。
- 基线 775 + 本批 16 = 791；并行 host 批次另有 `src/host/fix7Host.test.ts` 的 9 条 ⇒ 合计 **800/轮**（数字对得上）。
- **构建片段**：`REQUIRED_CLIENT_SNIPPETS` 73 项**逐字未动**，`build.mjs` 未改，构建输出仍是「客户端片段校验通过：73 项」。

### 门禁记录（本批实测）

| 命令 | 结果 |
| --- | --- |
| `tsc --noEmit -p tsconfig.json` | exit 0 |
| `node --test "src/client/*.test.ts"` | 314 pass / 0 fail |
| `node --test "src/**/*.test.ts"`（本地时区） | 800 pass / 0 fail |
| `npm run check` 第 1 轮（typecheck + 2 时区 + selftest + build） | **通过**：`ℹ tests 800 / pass 800 / fail 0`（本地时区）＋ `ℹ tests 800 / pass 800 / fail 0`（`TZ=UTC`）；`ALL HOST CHECKS PASSED (live probes soft)`；`built lib/index.js + lib/client.js（v0.104.0，客户端片段校验通过：73 项）`；`PIPE_STATUS=0` |
| `npm run check` 第 2 轮（同上，复跑） | **通过**（同上四条，`PIPE_STATUS=0`） |
| `npm run check` 第 3 轮（同上，复跑；与第 2 轮同一份代码） | **通过**（同上四条，`PIPE_STATUS=0`） |

> 稳定性证据：第 2 轮**开始前**与**结束后** `src/client/**` + `build.mjs` 的 sha256 汇总一致
> （`4930f0c4b6b7777f689d97e1db03f57e93743285d6bb90f7a1fd4009a84dedbf`），第 3 轮在同哈希上复跑也全绿
> ⇒ "两轮全绿"是**同一份代码**的两轮，不是两棵不同的树各绿一次。
> 期间工作区里**另有一批 host 侧并行改动**（见文首），它的用例数与构建片段同样被这几轮覆盖。

> 说明：`selftest` 的 live probes 是 **soft**（网络/上游限流不影响退出码），本轮出现过的 `TypeError: fetch failed` / `WARN(soft)` 均为上游探测，属既有行为。

---

## 8. 硬约束对照

| 约束 | 本批 |
| --- | --- |
| 不新增依赖 | ✅ `package.json` 未动 |
| 字号只用既有阶梯 | ✅ 新增代码未引入任何 `fontSize` 数值 |
| 动效只动 transform/opacity | ✅ 未新增动画/过渡；未改 `styles.ts` 的动效规则（只改了一行注释的"四态→五态"） |
| 不得新增强制提示或闪烁 | ✅ 新增文字只出现在**失败态**与 `title`（悬停）里；`role="note"` 供键盘/读屏 |
| 缺数据一律「未取到 + 原因」，不得 0 顶替 | ✅ `pending` 用既有 `PENDING_LABEL`/`PENDING_TITLE`；`summarizeStrip` 不把隐藏/未取到算成 0 或"缺失" |
| 不 commit / 不装 / 不动 profile / 不重启 `dsh web` | ✅ 均未做 |
| `build.mjs` 不动；锁定片段不改 | ✅ 73 项原样通过，无需改锁定片段 |

---

## 9. 未做项（本批不做，留给下一批）

- 评审 §P1-2（悬浮卡丢图表失败原因）、§P1-4（搜索候选键盘不可选 + combobox 语义）、§P1-6（买卖用涨跌色）、§P1-7（两融/预测的"未集成"旧文案）、§P1-8（`toTimeString()` 浏览器时区）、§P1-9（历史回看空值顶替失败）、§P1-10（重要性/护盘等级复用 `--tw-up`）、§P1-11（缩略图"开/高/低"其实是分时首笔）。
- 评审 §P2-1（fetch 无超时）、§P2-2（旧响应标注新页面）、§P2-4（流水/详情无序号）、§P2-5（`cycleViewMode` 静默吞错）、§P2-6（`visible = true`）、§P2-7/8（`role=dialog`、点击型 div 键盘）、§P2-9（六页签保活）、§P2-10（mousemove 全量重渲染）、§P2-11（`transition:width`）、§P2-12（`已截断 160` 抄常量）。
- §P3 全部（`--tw-warn` 未定义、死字段、`?? 0.02`、做T 明细 50 行静默截断、备份说明拼接、`?? 0` 与硬编码 9 档配色、ToolsPage 的 `role=tab`）。
- **同类但不在本批六项内**：`PortfolioPage` 的「操作记录」弹窗取流水失败仍写页面级 `error`（`openLedger` → `setError`），弹窗里会停在"加载流水…"。这是 §P1-9 的近亲，建议下一批按本批的 `mutate` 范式一并改成弹窗内 `err`。
- U3 的**浏览器 Network 实测**（静置 10 分钟的请求计数）未做：本机无浏览器自动化、不允许重启 `dsh web`；本批用"纯函数模型 + 接线断言 + 反例注入"三件套替代，方法与评审 §5 的"未确认项"一致。
