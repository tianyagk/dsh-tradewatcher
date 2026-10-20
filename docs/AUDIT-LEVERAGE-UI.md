# AUDIT-LEVERAGE-UI —— 【杠杆温度计】客户端详情页（工具箱第二个工具）

> **文件名**：`AUDIT-IMPL22 … AUDIT-IMPL88` 的编号已被历史审计用满，任务书最初写的 `AUDIT-IMPL81`
> 也被 v0.109.0 那轮占用（`src/client/impl81.test.ts` 文件头明写「历史审计不改写」）⇒ 按 Lead 口径改用
> **描述式文件名**：宿主侧 = `docs/AUDIT-LEVERAGE-HOST.md`，客户端 = **本文件**。
> **未覆盖任何既有审计文档。**
>
> 基准 HEAD：`3bed7be`（v0.115.0；门禁基线 = `npm run check` 全绿 + 构建 **73 项**片段校验）。
> 实测窗口：2026-10-20 19:31–20:2x（Asia/Shanghai）。
> **分工**：宿主 `/tradewatcher/leverage` 的取数/分位/落盘由另一路实现（`docs/AUDIT-LEVERAGE-HOST.md`）。
> **本报告只覆盖 `src/client/**`**：未改 `src/host/**`、未改 `src/shared/**`、未动 `build.mjs`。
> **纪律**：不新增依赖（页面外部模块只有 `react`，其余全相对路径）；不 commit、不装、不动 profile、
> 不重启 `dsh web`；实验隔离 `DSH_HOME=/tmp/levui-*`；未手工写 `~/.dsh`。
>
> **⚠ 阅读顺序**：§1–§7 是 **R1** 的交付记录；**§8–§11 是 R2 修订**（用户反馈"与图 1 差距过大"后按参考图改的六项结构）。
> R2 **推翻**了 R1 里的三处：①主图高度（`clamp(280px,26vh,380px)` → `min(58vh,520px)`）、
> ⑦"删水平网格线"（**恢复**，每 25 一格）、⑦"删浮框"（**恢复**为紧凑读数框，仍无十字光标）。
> 口径、`—`、`asOf` 空串、窗口只换参数、无动画、无新依赖、色值走 token —— 这些在 R2 里**一条都没动**。

---

## §0 一行结论

工具目录新增第二张卡「杠杆温度计」（副标题「A股融资杠杆热度」），并为它写了**专用详情页**：
大字温度（1 位小数）+ `/ 100` + 唯一的说明文字 `截至 YYYY-MM-DD`、**三张**摘要卡、
**双轴**主图（左温度 0–100 / 右比例 %，两条线 + 阈值线 80/95 只标数字）、底部当日融资净买入柱（正涨负跌 token）、
三档窗口（`range=250|750|all`，默认 750，**只换查询参数**）；按用户口径**删掉**水平网格线、浮框、十字光标与一切口径/解释文案；
任何缺值一律 `—`（`asOf` 为空时**连「截至」二字都不出现**）。9 条断言逐条配反例注入，
另做 **10 条真实源码注入 ⇒ 10/10 必败**；`npm run check` 两轮 **983/983** + 构建 **73 项**。

---

## §1 交付面（每个文件为什么必须存在）

| 文件 | 动作 | 内容 / 理由 |
|---|---|---|
| `src/client/tools/leverageView.ts` | **新增** | 纯视图模型（无 React）：格式化（`—` / 2 位小数 / 亿·万亿 / 正负号）、三张卡、图例、窗口档位、**绘图几何** `leverageChart()` 与结构判据 `leverageChartProblems()`。绘图做成**纯数据**而不是 JSX，是为了让"有没有网格线 / 阈值只标数字 / 缺值不画柱"成为可直接断言的对象（而不是靠正则捞 JSX） |
| `src/client/leveragePage.tsx` | **新增** | 专用详情页：取数（单飞 + 超时 + 代号丢弃旧响应）、Hero 大字、三张卡、主图卡（图例→画布）、窗口三档、失败可点重试 |
| `src/client/tools/leverage.ts` | **新增** | 工具目录条目（`ToolEntry`）：`id='leverage'` / `name='杠杆温度计'` / `blurb='A股融资杠杆热度'` / `chip='杠杆'` / `page='leverage'`；`sections`/`boundary` 留空（通用版式的结构声明，本工具一格都不渲染） |
| `src/client/toolRegistry.ts` | 改 | ① `ToolEntry` 增可选判别位 `page?: 'leverage'`（**版式**的唯一判别位，不按 id 硬编码）；② `TOOL_ENTRIES = [cakeTool, leverageTool]`（新工具**追加在末尾**，既有卡片不挪位） |
| `src/client/ToolsPage.tsx` | 改 | 详情页两条版式：`entry.page === 'leverage'` ⇒ 专用页，否则既有三段式。**回目录按钮仍只有一份实现**（`BackToCatalog` 由工具箱页注入给专用页），因此 `toolsPage.test.ts` 的既有接线断言（含 4 条注入锚点）一个字都不用改 |
| `src/client/api.ts` | 改 | `LeverageRange` / `LeveragePayloadDto`（字段名逐字照冻结契约）+ `api.leverage(range)`；**路由字面量只出现在方法体里**（`rowOwnership.test.ts` 靠它推导消费行 ⇒ 实测推导为 `tools`，与宿主那一路的 `ROW_ROUTES.tools` 一致） |
| `src/client/toolRegistry.test.ts` | 改 | **唯一一处既有断言的必要更新**：目录卡从「恰好 1 张」改为「恰好 2 张 + 顺序 `['cake','leverage']`」；原用例名/注释同步（`1 张` → `v0.116.0 起两个工具`）。其余 355 行未动 |
| `src/client/leverageTool.test.ts` | **新增** | 9 条断言（①–⑨，对应任务书九条规格），每条配反例注入；另做 10 条**真实源码**注入（§4.2） |

**没有做的事**（按任务书）：不加顶部页签、不做本地切片、不新增第二条接口、不新增依赖、不动 `build.mjs`。

---

## §2 页面元素清单（规格 1–9 逐条对照）

| # | 规格 | 实现（锚点 = 断言用 `data-role`） | 证据 |
|---|---|---|---|
| 1 | 工具名 `杠杆温度计`；目录副标题 `A股融资杠杆热度`；**不加页签** | `tools/leverage.ts` 逐字；目录卡片 = `catalogModel()` 第 2 张 | 断言 ①（含两条改名注入） |
| 2 | 大字 = 温度 **1 位小数** + `/ 100`；**唯一**说明文字 `截至 YYYY-MM-DD`；不写口径、不写缺失原因、无悬停解释；**`asOf` 为空 ⇒ 只给 `—`，不出现「截至」二字** | `leverage-temperature`（`HERO_TYPE.title` 46px）+ `leverage-scale`（`/ 100`）+ `leverage-asof`（`CHART_TYPE.asOf`）。整份工具面（页面 + 视图模块）里 `截至` **只出现在 `leverageAsOfText` 一处**；`asOf` 空串时该函数返回 `—` | 断言 ②（注入 ①：空日期也渲染「截至 」⇒ 红；注入 ②：多写一处「截至」⇒ 红） |
| 3 | **三张**卡：显性融资 = `ratioPct` / 杠杆率 = `ratioWithShortPct`（各 2 位小数 %）/ 当日融资净买入 = `netBuy`（元→亿/万亿、2 位小数、正负号）；**不要第四张** | `leverage-card` × 3（`CARD_SURFACE` 边框 + `SUMMARY_TYPE` 层级）；`fmtRatioPct` / `fmtNetYi` | 断言 ③（`2.65%` / `2.69%` / `-63.31 亿` / `+1.50 万亿` / `0.00 亿`；注入去符号 ⇒ 红） |
| 4 | 主图 **双轴**（左温度 0–100、右比例 %）+ 两条线（温度 / 显性融资比例）+ 阈值线 80/95 画在温度轴上、**只标数字** | `leverageChart()`：左刻度 `0/50/100`、右刻度 3 个 `x.xx%`、`paths` 两条（`var(--tw-accent)` / `var(--tw-chip-avg)`）、`threshold` 线两条 + `threshold-label` 文本 `80`/`95` | 断言 ④（注入「80 高杠杆」⇒ 红；删右轴 ⇒ 红；删左轴 100 ⇒ 红） |
| 5 | 底部柱 = `net`，**正红负蓝（跟随既有涨跌 token）**；该日缺值**不画柱**、不加说明 | `netBarColor()`：`+` → `var(--tw-up)`、`-` → `var(--tw-down)`、`0`/缺 → `var(--tw-flat)`；柱数 = 有值天数；不硬编码任何色值 | 断言 ⑤⑧（注入 `?? 0` ⇒ 柱数多一根 ⇒ 红） |
| 6 | 窗口 `1 年 / 3 年 / 全历史` = `range=250/750/all`，默认 **3 年（750）** | `LEVERAGE_RANGES` + `LEVERAGE_DEFAULT_RANGE='750'`；`rangeSwitch()` 只改 `range` 状态 ⇒ `api.leverage(range)` | 断言 ⑥（注入多参数 / 第二条接口 / 本地写死 ⇒ 全红） |
| 7 | 精简：**删**水平网格线、**删**浮框与十字光标说明；**保留**图例、右轴刻度、柱图零轴、摘要卡边框 | 模型里水平线只有 `threshold` / `zero` 两种角色（**没有 grid 这一档**）；页面没有 `onMouseMove`/`onMouseEnter`/`tool-hover-tip`/`tool-crosshair`/`tw-glass`/`title:` | 断言 ⑧（注入一条 `role:'grid'` ⇒ 红） |
| 8 | 任何缺失 ⇒ `—`（破折号），不加文字、不进悬停、不写 0 | `DASH='—'` 是唯一来源；`fmtTemperature/fmtRatioPct/fmtNetYi` 缺值即 `—`；`asOf` 空 ⇒ `—`（**不是**「截至 —」） | 断言 ⑤（注入 `?? 0` ⇒ 红）；数值字段上**没有一处** `?? 0` |
| 9 | 复用既有令牌与几何（`toolDetailTheme.ts`）、字号阶梯 `12/12.5/13/13.5/14`（展示级 ≥15）、1px 间距、动效只动 transform/opacity、不新增依赖、不闪烁 | 令牌：`HERO_TYPE.title`（46）/ `SUMMARY_TYPE.value`（34）·`label`（12.5）/ `CHART_TYPE.asOf`（12）·`tileValue`（20）·`legend`（12）/ `CARD_SURFACE` / `LEGEND_ROW`·`LEGEND_DOT` / `RANGE_BOX`·`RANGE_ON`·`RANGE_OFF`·`RANGE_TYPE` / `PLOT.heightCss`（`clamp(280px,26vh,380px)`）·`PLOT.fallbackWidth`·`PLOT.heightMin` / `TOOL_SPACE.*` / `CARD_MIN_W`（148）/ `CHART_STACK`；**本页没有任何动画**（切换窗口只换数据、画布不卸载 ⇒ 不可能闪烁） | 断言 ⑨（注入 11px 字号 / 11.5px 间距 ⇒ 红） |

**关于第 9 条的"动效"**：本页面**不引入任何过渡/关键帧**（所以"只动 transform/opacity"这条纪律在实现上恒成立）；
切档的视觉反馈由既有的 `.tw-tool-range>button` 的 `transition: background/color/border-color`（纯 paint）承担，
且 `styles.ts` 的 `@media (prefers-reduced-motion)` / `[data-anim=off]` 覆盖仍然生效（未新增任何 `@keyframes`）。

**关于"不闪烁"的三处具体做法**：
1. 切窗口**不清空** `payload`（清空 = 一次白屏/骨架闪），画布节点不换 `key`、不卸载；
2. 首次加载的骨架**占住同一份高度契约**（`PLOT.heightCss`）⇒ 骨架→图之间没有高度跳变；
3. 每个窗口取到后进本地缓存（`Map`）⇒ 切回已看过的窗口**命中缓存、零请求零重绘**。

---

## §3 数据加载（复用既有 `api.ts` 模式）

```
api.leverage(range) ──► request(`/tradewatcher/leverage?range=${range}`)
                        └─ requestWithTimeout：既有 15s 超时（REQUEST_TIMEOUT_MS）
useLeverageFetch(range, attempt)
  ├─ cache: Map<LeverageRange, Payload>      // 命中即用，零请求
  ├─ inFlight: Set<LeverageRange>            // 单飞：同一窗口不重复发
  ├─ gen: createRequestGen()                 // 代号：旧代响应（含错误）整体丢弃
  └─ alive ref                               // 卸载后不写 state
```

* **失败**：`ErrorNote`（既有 `.tw-err` 样式）+ 可点的「重试」（`Btn`，`data-verb="leverage-retry"`，点击 `attempt+=1` 重发）。
  失败时**保留**已取到的图（不清屏），错误条在画布下方。
* **未落地/上游没给的字段**：`LeveragePayloadDto` 的每个数值都按 `number | null` 读 ⇒ 页面显示 `—`，**不伪造**。
* **`asOf` 空串（宿主约定 = 整块不可用）**：页面显示 `—`，**不渲染「截至 」**（一个没有日期的「截至」既不是读数
  也不是时间 ⇒ 属于"缺失不加文字"）。
* **契约对齐（实测 `docs/AUDIT-LEVERAGE-HOST.md`）**：`thresholds` 宿主恒给数字（客户端按 `number | null` 读 = 超集，
  缺则不画那条线）；`temperature` 在样本 < 250 时为 `null` ⇒ 大字 `—`。

---

## §4 断言 + 反例注入

### §4.1 九条断言（`src/client/leverageTool.test.ts`，9 个用例全绿）

| 用例 | 断言要点 | 注入（用例内，必须红） |
|---|---|---|
| ① 目录项 | 卡片存在、标题/副标题**逐字**、`page==='leverage'`、`load===undefined`、顺序 `['cake','leverage']`、ToolsPage 按 `page` 分支且**不按 id** | 改副标题 / 改工具名 ⇒ `assert.throws` |
| ② 大字 + 截至 | `91.2` 匹配 `^\d+\.\d$`；`截至 2026-10-19`；**`asOf=''` ⇒ `—`（且不含「截至」）**；`null` ⇒ `—`；`截至` 全工具面**只 1 次**；`/ 100` 唯一 | 空日期也渲染「截至 」⇒ 与 `—` 不同 ⇒ 红；多写一处「截至」⇒ 计数 3 ⇒ 红 |
| ③ 三张卡 | 标签/顺序逐字、`length===3`、`2.65%`/`2.69%`/`-63.31 亿`、`+1.50 万亿`、`+3.20 亿`、`0.00 亿`、`-4e5 ⇒ 0.00 亿`（无负零） | 去掉正负号 ⇒ 与期望不同 ⇒ 红 |
| ④ 双轴与两条线 | `leverageChartProblems` 为空；两条 `paths`；左 `0/50/100`；右 3 个 `x.xx%`；阈值标签 `['80','95']`；80 在 95 下方；阈值线落在绘图区内 | 阈值带文字 / 删右轴 / 删左轴 100 ⇒ 三条注入分别红 |
| ⑤ 缺值 `—` | 三卡全 `—`、`asOf=''` ⇒ `—`、缺值那天无柱（2/3 天有值 ⇒ 2 根柱）、`netBarColor` 三档 | `net` 里 `null→0` ⇒ 3 根柱 ⇒ 柱数判据红；卡片 `?? 0` ⇒ 与期望不同 |
| ⑥ 窗口只换参数 | 档位 `['1 年','3 年','全历史']` / `['250','750','all']` / 默认 `750`；`endpointProblems`：api.ts 里**唯一**一个 `/tradewatcher/leverage` 字面量、查询串必须**恰好** `range=${range}`、页面**唯一**一处 `api.leverage(range)`；取数三件套（`createRequestGen()`/`inFlight`/`gen.current.stale(`）真的用上 | 多参数 `&win=` / 第二条接口 / 本地写死 `range=250` ⇒ 三条注入分别红 |
| ⑦ 无口径长文案 | 页面 + 视图（判据段之前）每个含汉字的字符串字面量都必须**逐字**落在白名单（工具名/卡片标签/图例/档位/`截至`/`窗口`/`重试`/单位 `亿`·`万亿`） | 页面加一段口径 / 视图加一条边界 / 缺值写「未取到」⇒ 三条注入分别红 |
| ⑧ 无网格线无浮框 | 模型水平线角色集合 = `['threshold','zero']`；页面无 `tool-hover-tip`/`tool-crosshair`/`tw-chart-tip`/`tw-glass`/`onMouseMove`/`onMouseEnter`/`onMouseLeave`/`title:`；有柱恰好一条零轴、无柱无零轴 | 塞一条 `role:'grid'` ⇒ 「水平网格线必须删除」；加回浮框 ⇒ 源码检查红 |
| ⑨ 字号/间距/令牌 | 两文件所有 `fontSize:` 过 `typeScaleProblems`；数值型 `gap/padding` 过 `spaceScaleProblems`；`TOOL_SPACE` 全整数；页面**真的用上** 22 个令牌；令牌值仍等于详情页契约（46 / 34 / 12 / 20 / `clamp(280px,26vh,380px)` / 148 / 图例居中圆点 / 选中档 600）；外部模块只有 `react`；`height: PLOT.heightCss` | 11px / 13.2px 字号、11.5px 间距 ⇒ 判据非空 |

### §4.2 真实源码注入（改真实现 ⇒ 断言必红；10/10 全中，改完立刻复原）

| # | 注入（改的是真文件） | 结果 | 被哪个用例抓住 |
|---|---|---|---|
| ① | `tools/leverage.ts` 的 `blurb` 改成「两融热度」 | **RED** | ① |
| ② | `leverageAsOfText` 多写「（上一交易日）」 | **RED** | ②（并发 ⑤⑦：新增中文文案在表外） |
| ③ | `leverageAsOfText` 改成恒写「截至 」（空日期也写） | **RED** | ② |
| ④ | `fmtNetYi` 的 `sign` 恒为 `''`（丢正负号） | **RED** | ③ |
| ⑤ | `thresholdText` 变成「80 高杠杆」 | **RED** | ④（并发 ⑦） |
| ⑥ | `fmtRatioPct` 改成 `${(v ?? 0).toFixed(2)}%` | **RED** | ⑤ |
| ⑦ | `api.leverage` 模板加 `&win=${range}` | **RED** | ⑥ |
| ⑧ | 页面里加一行 `const _leak = '显性融资比例的分位口径：全历史分位 × 100'` | **RED** | ⑦ |
| ⑨ | `leverageChart` 里塞一条 `role:'grid'` 的水平线 | **RED** | ④（同一判据）+ ⑧ |
| ⑩ | 绘图区高度写死 `'160px'`（历史事故的塌陷写法） | **RED** | ⑨ |

> 说明：④ 与 ⑧ 共用同一个判据函数 `leverageChartProblems()`（"唯一实现"），所以注入 ⑨ 会同时被 ④ 抓到——
> 这是**判据共用**而不是重复断言；⑧ 另有源码级的浮框/鼠标事件负向断言。

### §4.3 收尾修正（Lead 看到的 3 条红 + 2 个 tsc 报错，逐条闭环）

| 报错 | 根因 | 处置 |
|---|---|---|
| ②「`/ 100` 固定单位文本」 | 判据里的字面量多写了一个空格（写成 `' / 100'`，页面是 `'/ 100'`） | 判据改成 `'/ 100'`（页面文案没动） |
| ⑥「窗口三档只换 range」 | 判据正则 `api\.` 不匹配页面里的方法链换行写法（`api` 换行后 `.leverage(range)`） | 判据放宽为 `api\s*\.\s*leverage\(…\)`（仍然只允许 1 处调用） |
| ⑦「不得有口径长文案」 | 视图里的金额单位 `亿` / `万亿` 不在白名单 | 单位加进白名单（单位不是说明文字），其余一律仍拒 |
| tsc：`CHART_STACK` 未使用 | 只在令牌名清单里被当字符串提到 | 改成**真实断言**：`CHART_STACK` 必须等于 `['legend','plot']`，且页面按它渲染 |
| tsc：`RANGE_BOX` 未使用 | 同上 | 改成**真实断言**：凹陷容器 `background: var(--tw-bg2)` + `borderRadius: 10` |

> 这 5 条都在**最后一次全门禁之前**修完；当前读数见 §5（983/983 × 2 + 73 项，exit 0）。

---

## §5 门禁读数（最终树，`/tmp/levui-check4.log`）

```
$ npm run check          # typecheck → 测试两轮（默认时区 + TZ=UTC）→ selftest → build
✔ tsc --noEmit            通过（0 error；含 noUnusedLocals）
✔ node --test 第一轮       983 用例 / 983 pass / 0 fail      ← R1 读数
✔ node --test 第二轮(TZ=UTC) 983 用例 / 983 pass / 0 fail      ← R1 读数
✔ selftest                ALL HOST CHECKS PASSED（live probes soft；两条 WARN 为上游软失败）
✔ build                   built lib/index.js + lib/client.js（客户端片段校验通过：73 项）
```

* 本轮新增用例：`src/client/leverageTool.test.ts` **9 条**（宿主那一路另有 `src/host/leverage.test.ts`）。
* **R2 结束时读数**（`/tmp/levui-r2b.log`）：`989 用例 / 989 pass / 0 fail` × 2 轮 + selftest + 构建 **73 项**，`EXIT=0`
  （989 = 983 + `src/client/leverageChart.test.ts` 的 6 条）。
* 起始基线：`npm run check` 全绿（构建 **73 项**）——**片段表一个字没动**（本页面的文案不命中任何锁定片段）。

---

## §6 未做项 / 偏差披露（逐条给理由）

1. **没有做运行时的 `console.warn` 结构自检**（详情页对绘图区/饼图契约有这种自检）。理由：那会把一条中文诊断
   文案带进页面文件，而 ⑦ 号判据要求"页面文件里含汉字的字符串字面量只能来自白名单"——为了不给自己开后门，
   结构判据 `leverageChartProblems()` 只在测试里强制（新增/改动的每个分支都有注入覆盖）。
2. **切窗口的瞬间，画布仍是上一档的数据**（通常一帧到几百毫秒，落地即替换）。这是"不得闪烁"与"绝不显示错误的空态"
   之间的取舍：清空 `payload` 会白屏/骨架闪。失败时上方有 `ErrorNote` + 可点重试，且**不会**把旧数据当成新窗口的读数
   （窗口控件是请求态、错误条常驻可见）。**这是本批唯一的 UX 取舍，如实披露。**
3. **x 轴保留首末两个日期标签**（与既有折线图同款）。理由：它们是刻度参照，不是说明文字；规格没有点名删，
   而删掉会让"这条线覆盖哪段时间"完全无从判断。若用户认为多余，改 `leverageChart()` 里 2 行即可。
4. **`chip = '杠杆'`**：用户只锁定了工具名与目录副标题，chip 是既有卡片版式的短标识（2–4 字约定）⇒ 取工具名前两字，
   **没有新造分类词**；`category='margin'`（本轮标签行只有「全部」，不参与渲染）。
5. **目录页「工具箱目前 2 个工具……」那行稀疏说明仍在**：既有行为（`TOOL_ENTRIES.length <= 2` 时渲染），
   本批未改；工具再多一个就会自动消失。
6. **全历史档的渲染上界**：4018 个交易日的柱 = 4018 个 `<rect>`、两条 4018 点折线路径。**没有做像素级降采样**——
   降采样会把"当日融资净买入"悄悄变成"某几天的合计"，属于改语义。默认档是 750（约 705 根柱），实测渲染无卡顿。
7. **未改宿主与共享层**：README 数据文件行（`leverage.json`）、`ROW_ROUTES.tools`、`FUNCTION_OWNED_PATHS`、
   文档路由账都由宿主那一路完成（本报告只核对"实测消费行 = tools"这条推导通过）。
8. **没有在真实浏览器里跑一遍**（本机没有 `dsh web` 重启窗口，纪律也不允许）。渲染层靠
   "纯模型断言（几何/文案/缺值）+ 源码接线断言（锚点/令牌/无浮框）"两层盯住，与仓库既有页面的做法一致。

---

## §7 复现入口

```bash
cd dsh-tradewatcher
node_modules/.bin/tsc --noEmit -p tsconfig.json
node --experimental-strip-types --test src/client/leverageTool.test.ts          # 9 条断言
NODE_COMPILE_CACHE=node_modules/.cache/node-compile \
  node --test --experimental-strip-types --test-concurrency=8 "src/client/*.test.ts"
npm run check                                                                  # 全门禁
```

注入脚本的做法：对 §4.2 表格里的每个 `old → new` 用 `str.replace` 改真文件 → 跑
`node --experimental-strip-types --test src/client/leverageTool.test.ts` → **立刻复原**（脚本只写源码，不写 `~/.dsh`）。

---

# R2 追加：结构对齐图 1（六项修正 + 温度极差实测）

> 用户反馈：当前界面与参考图 1 差距过大 ⇒ 先做**六项结构性修正**（**都不改口径**）。
> 改动仍只在 `src/client/**`；追加断言 `src/client/leverageChart.test.ts`（6 条，逐条配反例注入）。
> 报告文件仍为本文件（`docs/AUDIT-LEVERAGE-UI.md`）。

## §8 六项逐条（改法 / 判据 / 注入）

| # | 用户口径（图 1 的结构特征） | 改法（唯一实现） | 判据 | 注入 ⇒ 必败 |
|---|---|---|---|---|
| ① | 主图占屏比 55–60%（原约 40%） | 新增 `LEVERAGE_PLOT_HEIGHT = 'min(58vh, 520px)'`（绘图区**与加载骨架**同一份契约）；**没有**改通用 `PLOT.heightCss`（那 2 份既有断言还盯着它） | `leveragePlotHeightProblems()`：必须带视口比例（≥50vh）+ 像素上限 ≥480 + 参考视口（900px）下有效高度 ≥480 | 页面写死 `300px` ⇒ 红（①⑨）；`min(40vh,520px)`、`min(58vh,300px)` ⇒ 红 |
| ② | 阈值线**右端彩色胶囊** `45/75`，不与左轴刻度重叠 | 模型新增 `capsules`（`threshold-capsule`：右端对齐、圆角=半高）；阈值数字从"左轴旁"移到**胶囊内**（`threshold-label` 改成 `anchor: middle`）；胶囊色走语义色阶 `--tw-imp-2` / `--tw-imp-3`（不跟涨跌翻转），数字色 `--tw-card` | 胶囊右缘对齐绘图区、距左轴刻度 ≥200px、数字几何上落在胶囊内、胶囊色为 token | 数字放回左轴（`x: 34`）⇒ 红；胶囊挪回左轴 ⇒ 红 |
| ③ | 左上角**紧凑读数框**（该日三个数） | 模型 `leverageReadout(payload, index)`（行名取自图例 ⇒ 不新增文案）+ 页面 `onMouseMove`/`onMouseLeave` + `leverageIndexAt()` 取点；框体复用既有 `.tw-chart-tip tw-glass`（不新增 CSS）；**无十字光标、无解释文字** | 三行 = 温度（1 位小数）/ 显性融资比例（2 位小数 %）/ 净买入（亿·万亿 + 符号），缺值 `—`；页面必须有 `leverage-readout` 与两个鼠标事件，且**不许**有 `tool-crosshair`/`tool-hover-tip` | 删读数框 ⇒ 红；加回十字光标 ⇒ 红 |
| ④ | X 轴 6–8 个刻度（按季度） | `xTickCount()`：一年 7 / 三年 8 / 全历史 9（步长因此落成 **月 / 季度 / 年**）；刻度位置在 `left + j*inner/(n-1)` **精确等分**，标签取最近某一天（`YYYY-MM`） | 刻度 ≥6、≤10、严格递增、**相邻间距差 ≤0.5px**（"等距"）；标签 `^\d{4}-\d{2}$` | `xTickCount` 改成 2（只给首末）⇒ 红 |
| ⑤ | 水平网格线（每 25、浅色虚线、不标文字） | 模型新增 `grid` 角色：`GRID_TEMPS = [0,25,50,75,100]`、`dash: true`、`color: 'var(--tw-border)'`；**不挂任何文字**（文字角色白名单里没有 grid 标签） | 5 条、虚线、颜色 token、等距、无文字 | 删网格 ⇒ 红；改实线 ⇒ 红；给网格加文字 ⇒ 红 |
| ⑥ | 底部柱区独立刻度 + 柱宽自适应 | 柱区新增 `bar-max` / `bar-min` 两个文字角色（`fmtNetYi` 输出，右对齐到左内边距）；柱宽 `min(6px, max(0.6px, 内宽/天数*0.66))` 自适应；左内边距 66→74px（放下 `+1074.85 亿`） | 有柱时上下界各**恰好一个**、形态为金额、位置在零轴上下；柱宽 >0 且 ≤6px；短窗口比长窗口粗 | 删柱区小轴 ⇒ 红；柱宽固定 18px ⇒ 红 |

**顺带修掉一个真实缺陷**（复算真实数据时发现）：`all` 窗口的最小比例是 2010 年的 `0.00%`，右轴减余量后会冒出 `-0.56%`
这种没有意义的刻度（并被 ③ 的形态判据抓红）⇒ 右轴下限**夹到 0**（比例不可能为负）。

## §9 温度线极差实测（Lead 要求，只测量、不改口径）

**方法**：直接读宿主落盘的 `~/.dsh/dsh-tradewatcher/leverage.json`（4018 行，**只读**，未写 `~/.dsh`），
用宿主 `expandingPercentiles()` 的同一算法（扩张窗口、无前视、`round1`）复算 `temp` 序列，再按窗口切片取极差。

| 窗口 | 交易日 | 温度 min | 温度 max | **极差** | 最新 | 结论 |
|---|---|---|---|---|---|---|
| `range=250`（1 年） | 250 | 88.2 | 94.3 | **6.1 点** | 90.4 | 接近水平（6.1% 的轴高） |
| `range=750`（3 年，默认） | 750 | 27.2 | 94.3 | **67.1 点** | 90.4 | **不平**（67.1 ≫ 5） |
| `range=all` | 4018 | 27.2 | 100 | **72.8 点** | 90.4 | 不平 |

**回答**：3 年窗口的极差是 **67.1 个点**（不是 <5）⇒ **曲线本身不平**，§8 的六项结构性修正之后它不会是一条直线。
真正"看起来平"的是 **1 年窗口（6.1 点）**，且这 250 天全部挤在 88–94 之间（占轴高 6%）。

补充读数（供口径决策参考，**本轮未改任何口径**）：最近 750 天里温度落在 **80–100 分位带的天数 = 378 天（50.4%）**，
落在 40–80 的 296 天、20–40 的 9 天。即"全历史扩张窗口分位"对单调上行的比例序列会**天然逼近上限并饱和**
（比例从 2.4% 一路抬到 2.9% 时，分位从 27 爬到 94 然后就只能在高位抖动）。
若要与图 1 的"全幅波动"观感对齐，需要把温度改成**滚动窗口分位**（如近 3 年滚动）——那会改口径，等你的决定。

## §10 断言 + 注入证据（R2）

新增 `src/client/leverageChart.test.ts`（6 条）：① 主图高度 ② 阈值胶囊 ③ 读数框 ④ X 刻度 ⑤ 网格线 ⑥ 柱区小轴。
连同既有 `src/client/leverageTool.test.ts`（9 条）一起跑；下表 **17 条注入全部 RED**，**改的是真源码**、改完立刻复原：

| 注入 | 结果 | 被哪条抓住 |
|---|---|---|
| 页面高度写死 `300px` | **RED** | R2 ①（并发旧 ⑨） |
| 阈值数字放回左轴（`x: left+4`） | **RED** | R2 ②（并发 ④、旧 ④） |
| 删掉悬停读数框 | **RED** | R2 ③（并发旧 ⑧） |
| `xTickCount` 改成 2（只给首末） | **RED** | R2 ④ |
| 删掉水平网格线 | **RED** | R2 ⑤ |
| 删掉柱区独立小轴 | **RED** | R2 ⑥ |
| 柱宽写死 18px | **RED** | R2 ⑥ |
| 胶囊挪回左轴（`capX = left + 4`） | **RED** | R2 ② |
| 网格改实线 | **RED** | R2 ⑤ |
| 画布上加回十字光标标记 | **RED** | R2 ③（并发旧 ⑧） |
| 目录副标题改错 | **RED** | 旧 ① |
| `asOf` 为空也写「截至 」 | **RED** | 旧 ②（并发 ⑤） |
| 缺值 `?? 0`（比例） | **RED** | 旧 ⑤ |
| `api.leverage` 多一个查询参数 | **RED** | 旧 ⑥ |
| 页面加一段口径说明 | **RED** | 旧 ⑦ |
| 多写一处「截至」 | **RED** | 旧 ②（并发旧 ⑦） |
| 金额丢正负号 | **RED** | 旧 ③（并发旧 ⑧） |

> ②④⑤⑥ 的注入会同时点亮别的用例，是因为它们共用同一个结构判据 `leverageChartProblems()`
> （"唯一实现"）；每条注入都**至少**点亮自己那条。

## §11 R2 未做项 / 取舍（如实披露）

1. **X 轴标签与数据点可有半个步长的偏差**：为了让刻度**像素级等距**（用户口径"6–8 个等距刻度"），
   刻度位置按 `left + j*inner/(n-1)` 精确等分，标签取**最近的那一天**的 `YYYY-MM`（轴标签不必落在数据点上）。
2. **读数框只在鼠标进入画布时出现**（触屏没有 hover ⇒ 不显示；没有做"点击固定"——那会引入第四条交互语义）。
3. **读数框不含阈值差**：图 1 那两行 `Δ23.89pp` 是"与阈值的差"，属解释性口径；本轮按"三个数 + 无解释文字"实现。
4. **网格线用 `--tw-border`、阈值胶囊用 `--tw-imp-2/3`**：都不新增色值、不跟涨跌翻转（隐身视图统一转灰阶）。
5. **主图高度是 `min(58vh, 520px)`**：视口矮于约 828px 时实际高度会低于判据的 480px 下限（这是 `min()` 的语义，
   不是实现缺陷）；判据按参考视口（900px）检查。
6. 未改口径、未改宿主/共享层、未新增依赖、未动 `build.mjs`；仍不 commit、不重启服务。

---

# R3 追加：温度搬进卡片行 + 第二行四张卡（两行 × 四列，共 8 张）

> 用户要求：**温度从大字区移进卡片行**，并**新增第二行四个卡片**；移除原大字区留下的空位。
> 改动仍只在 `src/client/**`；追加断言 `src/client/leverageCards.test.ts`（7 条，逐条配反例注入）。
> **口径一条没改**：温度仍是全历史扩张窗口分位、比例仍是 `RZYEZB`、净买入仍是 `RZJME`；新增的"窗口累计净买入"是**对既有 `net` 序列求和**（不含任何新数据源）。

## §12 目标布局与落地

| 行 | 卡片（左→右） | 实现 |
|---|---|---|
| 第一行 | **温度**（原大字）+ 显性融资 + 杠杆率 + 当日融资净买入 | `leverageCards()[0..3]`；温度卡带 `suffix: '/ 100'` 与 `note: 截至 …` |
| 第二行 | **融资余额** + **融券余额** + **流通市值** + **窗口累计净买入** | `leverageCards()[4..7]`：`marginBalance` / `shortBalance` / `floatMv` / `windowNetSum(net)` |

* **布局**：新增 CSS 类 `.tw-lev-cards`（`styles.ts`）：`repeat(4, minmax(0,1fr))`，`@media (max-width:760px)` 折成
  `repeat(2, minmax(0,1fr))` —— 四列 → 两列，**不会**变成纵向长列表；卡片间距仍走 `TOOL_SPACE.tileGap`（内联令牌），
  边框/字号沿用 `CARD_SURFACE` / `SUMMARY_TYPE`；**本页仍然零动画**（没有新增任何 `transition`/`@keyframes`）。
* **原大字区已整块删除**：页面顶行改成 `回目录按钮（左）+ 窗口三档（右）`，`leverage-hero` 锚点一并消失
  （断言 `page.includes('leverage-hero') === false`）⇒ 没有留下空白。
* **温度卡文案位只有三个**：`label`（温度）/ `value` + `suffix`（`90.4` + `/ 100`）/ `note`（`截至 YYYY-MM-DD`）；
  `asOf === ''` 时 `note` 退回 `—`（**不出现「截至」二字**）。其余七张卡**没有** `suffix`/`note`（判据直接拒）。
* **金额格式**：余额/市值走新 `fmtAmountYi()`（亿/万亿、2 位小数、**不带符号** —— 余额没有方向）；
  净买入类沿用 `fmtNetYi()`（亿/万亿、2 位小数、**带符号**）。
* **`截至` 字面量仍是 1 处**：抽成 `ASOF_PREFIX` 常量，格式化与判据都从它拼（`grep 截至` 在非注释源码里恰好 1 次）。

## §13 窗口累计净买入（口径与三档实测）

**口径**：`windowNetSum(payload)` = 当前窗口 `net` 序列求和；**窗口内只要有一个 `null` ⇒ 返回 `null`（界面 `—`）**，
绝不"跳过缺的那天照算"（那会让"累计"变成一个无法解释的数）；空窗口同样 `null`（不写 0）。

**三档实测**（宿主落盘 `~/.dsh/dsh-tradewatcher/leverage.json`，4018 行、**只读**；按窗口求和）：

| 窗口 | 交易日 | 累计净买入（元） | 界面显示 |
|---|---|---|---|
| `range=250`（1 年） | 250 | 40,258,761,307 | **+402.59 亿** |
| `range=750`（3 年，默认） | 750 | 969,148,374,180 | **+9691.48 亿** |
| `range=all` | 4018 | 2,429,784,225,797 | **+2.43 万亿** |

三档 0 缺失（与 `docs/PROBE-LEVERAGE.md` 的"`RZJME` 无缺失"一致）⇒ 正常情形都会出数；一旦上游某天缺，
卡片显示 `—` 而不是少算。

## §14 断言 + 注入证据（R3）

新增 `src/client/leverageCards.test.ts`（7 条）：① 恰好 8 张 ② 温度卡在第一位且带 `/ 100` 与 `截至`
③ 第二行顺序 ④ 金额格式 ⑤ 累计随窗口变 ⑥ 有 `null` ⇒ `—` ⑦ 无口径/解释文字。
连同 R1 的 `leverageTool.test.ts`（9 条）与 R2 的 `leverageChart.test.ts`（6 条）一起跑。**16 条注入全部 RED**
（改真源码、改完立刻复原）：

| 注入 | 结果 | 被哪条抓住 |
|---|---|---|
| 卡片多一张（9 张） | **RED** | R3 ①（并发 ③⑦） |
| 卡片少一张（7 张） | **RED** | R3 ①（并发 ③④⑤） |
| 页面只渲染前 4 张（`cards.slice(0,4)`） | **RED** | R3 ①（"必须逐张渲染整份模型"） |
| 温度卡搬到末尾 | **RED** | R3 ②（并发 ①③） |
| 第二行两张换位 | **RED** | R3 ③（并发 ①④⑦） |
| 余额金额丢 2 位小数 | **RED** | R3 ④（并发 ①⑦） |
| 窗口累计写成常量 | **RED** | R3 ⑤（并发 ④⑥） |
| 累计忽略 `null` 求和 | **RED** | R3 ⑥（并发 旧⑤） |
| 给余额卡加一句说明 | **RED** | R3 ⑦（并发 ①） |
| （回归）主图高度写死 300px / 阈值数字放回左轴 / 删读数框 / X 轴只给首末 / 删网格线 / 删柱区小轴 | **RED** ×6 | R2 ①②③④⑤⑥ |

**R3 结束门禁读数**：`npm run check` 两轮 **996/996**（983 基线 + 6 + 7）+ selftest + 构建 **73 项**，`EXIT=0`。

## §15 R3 未做项 / 取舍

1. **窗口三档控件挪到顶行右侧**（原来贴在大字区右边）：大字搬走后那个位置空了，把控件放回顶行既补上空位、
   又离它影响的两处（主图 + 累计卡）更近。
2. **余额类金额不带符号**：`+2.45 万亿` 会被读成"涨了"；符号只保留在净买入类（用户口径写的是"带符号"）。
3. **窄屏折两列用 CSS 媒体查询**（`max-width:760px`），不在 TS 里算：8 张卡在 4 列时要保持同一行，
   `auto-fit` 在宽屏上会变成 8 列，与"两行 × 四列"冲突。
4. 触屏没有 hover ⇒ 悬停读数框不出现（与 R2 一致，未改）。

---

# R4 追加：删日期小字 / 卡片值字号降档 / 工具名标题

> 用户三条（只在 `src/client/**`）：① 删掉温度卡里的日期小字（那个词页面上**不再出现**，`asOf` 仍留在数据里不渲染）；
> ② 卡片值字号整体降一档（温度 28px、其余 26px，**不得低于 26**）；③ 卡片行上方加工具名标题（单行左对齐、
> 复用既有 section 标题层级、**整页只出现一次**）。追加断言 `src/client/leverageHeader.test.ts`（5 条，逐条配反例注入）。
> **口径仍未改**：数据契约、缺值 `—`、窗口只换参数、无动画、无新依赖、色值走 token 全部原样。

## §16 三项落地

| # | 用户口径 | 改法 | 判据 |
|---|---|---|---|
| ① | 删温度卡的日期小字 | **整条渲染链删除**：`ASOF_PREFIX` 常量、`leverageAsOfText()` 函数、`LeverageCard.note` 字段、页面 `leverage-card-note` 锚点全部移除。`asOf` 仍在 `LeveragePayloadDto` 里（宿主照回，客户端不渲染） | `asofRenderProblems()`：页面 + 视图模块（剥注释）里 `截至` **0 处**、无 `ASOF_PREFIX`、无小字锚点 |
| ② | 卡片值字号降一档 | 新增 `LEVERAGE_CARD_VALUE_PX = { temperature: 28, other: 26 }`（**通用 `SUMMARY_TYPE.value` 34px 没动** —— 蛋糕工具还在用它）；页面按 `card.key === 'temperature'` 取 | `leverageCardValueSizeProblems()`：温度 > 其余、两者 ≥ `LEVERAGE_CARD_VALUE_MIN_PX`(26)、都 < 40；另用 `typeScaleProblems` 证明两者是展示级（≥15，不受密集阶梯约束） |
| ③ | 卡片行上方加工具名标题 | 页面在顶行之下、卡片行之上渲染 `<h2 data-role="leverage-title">`，样式 `{ margin: 0, ...CHART_TYPE.cardTitle }`（17px/700，**没新造 class**）；文案来自 `ToolEntry.name`（`ToolsPage` 传 `title={entry.name}`），**页面里 0 处写死工具名**（连 svg 的 `aria-label` 也改成 `props.title`） | `titleWiringProblems()`：恰好 1 处、位置在卡片行与主图卡**之前**、必须是 `h2`、必须用 `CHART_TYPE.cardTitle`、必须无 `className`、子节点必须是 `props.title` |

## §17 断言 + 注入证据（R4）

新增 `src/client/leverageHeader.test.ts`（5 条）：① 无「截至」/`ASOF_PREFIX` ② 8 张卡回归 ③ 值字号 28/26
④ 标题恰好一次且在卡片行之前 ⑤ 仍无口径/解释文字。连同另外三个套件（9 + 7 + 6 条）一起跑。

**12 条真源码注入 ⇒ 12/12 RED**（改完立刻复原）：

| 注入 | 结果 | 被哪条抓住 |
|---|---|---|
| 视图里加回 `ASOF_PREFIX` + 「截至」 | **RED** | R4 ①（并发旧 ②、⑤） |
| 卡片加回 `note` 字段（日期） | **RED** | R4 ①（并发旧 ②⑤） |
| 页面加回 `leverage-card-note` 锚点 | **RED** | R4 ①（并发旧 ②⑦） |
| 少一张卡（7 张） | **RED** | R4 ②（并发 R3 ①③④⑤） |
| 温度值改回 34px | **RED** | R4 ③ |
| 其余值降到 24px（低于下限） | **RED** | R4 ③ |
| 页面写死 `fontSize: 34` | **RED** | R4 ③（并发旧 ⑨） |
| 标题挪到主图下面 | **RED** | R4 ④（并发旧 ⑨） |
| 标题写两遍 | **RED** | R4 ④ |
| 标题文案写死（不走 `props.title`） | **RED** | R4 ④ |
| 标题新造 `className` | **RED** | R4 ④ |
| 给流通市值卡加一句说明 | **RED** | R4 ⑤（并发 R3 ①②⑦） |

**R4 结束门禁读数**：`npm run check` 两轮 **1001/1001**（996 基线 + 新增 5）+ selftest + 构建 **73 项**，`EXIT=0`。

## §18 R4 未做项 / 取舍

1. **`asOf` 变成"只进不出"的契约字段**：宿主照回、客户端不渲染，也没有别的地方用它 —— 这是用户"留在数据里"的明确要求，
   不是漏接；`LeveragePayloadDto.asOf` 的注释已写明。
2. **卡片值字号没有挤进 `SUMMARY_TYPE`**：那是通用摘要卡令牌（34px），改它会连带改蛋糕工具；
   本工具的降档值单独放在 `LEVERAGE_CARD_VALUE_PX`，判据里连"下限 26"一起钉住，避免下一次"顺手再降一档"。
3. **标题文案来自 `ToolEntry.name`**（不是页面常量）：改名只需改 `tools/leverage.ts` 一处；
   代价是页面必须接一个 `title` prop（`ToolsPage` 传 `entry.name`）。
4. 触屏没有 hover ⇒ 悬停读数框不出现（与前两轮一致，未改）。

---

# R5 追加：工具名带口径括号（`杠杆温度计（锚定 2024）`）

> 用户决定：标题带口径括号 —— 显示 `杠杆温度计（锚定 2024）`，括号用**全角**。
> 只改 `src/client/**`；**单一来源**在 `tools/leverage.ts` 的 `name`，目录卡与详情页标题一起变，页面里仍**不得写死**。

## §19 改了哪几处

| 文件 | 改动 |
|---|---|
| `src/client/tools/leverage.ts` | `name: '杠杆温度计'` → **`杠杆温度计（锚定 2024）`**（全角括号；注释里写明它同时是详情页标题的唯一来源） |
| `src/client/toolRegistry.test.ts` | 追加一致性断言：`model.cards[1].title === leverageTool.name`（目录卡标题与工具条目**同源**，不另抄一份字面量）；导入 `leverageTool` |
| `src/client/leverageTool.test.ts` | ① 的逐字断言同步到新名（含"半角括号"反例注入）；⑦ 的文案白名单**删掉旧名**（留着等于给"页面写死工具名"开后门） |
| `src/client/leverageHeader.test.ts` | 新增 R5 ①②③ 两条用例；⑤ 的白名单同样删掉旧名 |
| `build.mjs` | **未动**：新名字没有命中任何锁定片段（`grep '杠杆温度计\|锚定' build.mjs` = 0 命中，73 项不变） |

详情页与 svg 的 `aria-label` 都不含字面量：`ToolsPage` 传 `title={entry.name}`，页面渲染 `props.title`。

## §20 断言 + 注入证据（R5）

新增/同步的判据（`src/client/leverageHeader.test.ts`，7 条；`leverageTool.test.ts` 9 条；`toolRegistry.test.ts` 同步 1 条）：

| # | 断言 | 注入（改真源码） | 结果 |
|---|---|---|---|
| R5 ① | 目录卡名字**逐字**等于 `杠杆温度计（锚定 2024）`、括号全角且恰好一对、`leverageTool.name` 同源 | 改半角括号 / 少括号（旧名）/ 年份改错 | **RED ×3** |
| R5 ② | 标题与目录名**同源**：`ToolsPage` 传 `entry.name`；页面里不含 `杠杆温度计` / `锚定` / `2024` | 页面写死标题文案 / `ToolsPage` 改成写死字符串 | **RED ×2** |
| R5 ③ | 标题仍**恰好一处** | 标题写两遍 | **RED** |
| 负对照 | 把名字写进**注释**不算渲染（剥注释后扫描） | 页面注释里写 `杠杆温度计（锚定 2024）` | **GREEN（预期）** |

**R5 结束门禁读数**：`npm run check` 两轮 **1005/1005** + selftest + 构建 **73 项**，`EXIT=0`
（本轮新增 2 条 R5 用例；用例总数比 R4 的 1001 多 4 —— 另外 2 条是**宿主那一路并行加的**，不是本批的写入面）。

## §21 R5 未做项

1. **没有改宿主/共享层的任何字符串**：宿主回包与工具描述里仍叫「杠杆温度计」（那是另一路的名字，不在本批写入面）。
2. **没有把括号内容做成配置项**（例如 `anchoredYear`）：用户只要求"名字带括号"，做成字段会让"目录名/详情页标题/工具条目名"三处再多一条同步链。
3. 目录卡标题变长（`杠杆温度计（锚定 2024）`）后仍单行不换行溢出：卡片标题是 12.5px/600，最窄两列布局下也放得下；未新增截断逻辑。
