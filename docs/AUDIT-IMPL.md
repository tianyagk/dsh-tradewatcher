# 实现报告：批一（列头点击排序 + 年初至今 YTD）

> 任务：`task-3`（实现工程师 `impl-ui`）。本文件只记录**这一批**的改动、口径与验收方式；
> 审计条目本身的取舍见 [`AUDIT-UI.md`](AUDIT-UI.md) / [`AUDIT-FUNCTION.md`](AUDIT-FUNCTION.md)，
> 当前生效口径以 [`../README.md`](../README.md)「口径规范」为准（README 属整合范围，未改）。
> 交付时 `npm run check` 全绿；未提交 git（Lead 统一提交）。

## 0. 一句话结论

两项都做了：① 宽屏新增**列头排序**（自选/持仓各自一套可排序列，点列头排序、再点切方向、▲/▼、键盘可达、`aria-sort`，窄屏原段控保留且两个入口互斥）；② 新增**年初至今（YTD）**列（宿主 `host/ytd.ts` 按日 memo + `em.fetchKline` 前复权序列，客户端 tooltip 写死口径，缺失显式化为 `—` + 原因）。

## 1. 改动文件清单

| 文件 | 改了什么 |
| --- | --- |
| `src/shared/model.ts` | 排序键白名单扩容（自选 +`amount`/`chg`/`alpha`，持仓 +`price`/`cost`）；新增 `YTD_CALIBER`、`YtdBaseKind`、`YtdRow`、`YtdPayload`（口径常量**单一来源**，界面与工具引用同一句） |
| `src/client/sort.ts` | 新键的文案/口径提示；`WatchSortInput` +`amount`/`chg`/`alpha`、`PortSortInput` +`price`/`cost`（`switch` 穷举，不再 `if` 链）；新增列头定义 `SortColumn`/`WATCH_COLUMNS`/`PORT_COLUMNS`（`key: null` = 该列不排序） |
| `src/client/sort.test.ts` | 既有 8 组断言**全部保留**；新增列头键、新键比较语义、白名单一致性断言（详见 §4） |
| `src/client/SortHeader.tsx`（新） | 列头组件：真 `<button>`（Enter/Space 天然触发）、`role="columnheader"` + `aria-sort`、▲/▼、`↺ 默认顺序` 复位；`key: null` 的列只作标签（不装成可点） |
| `src/client/SortBar.tsx` | 新增 `wideHidden` 属性与 `.tw-sortbar` 类：**是否收起段控由调用方显式决定**，不是 CSS 无条件隐藏 |
| `src/client/styles.ts` | 新增 `.tw-sorthead*` 样式（`<1500px` 不显示、`≥1500px` 显示，与多列网格同一断点）+ `[data-wide-hide=1]` 收起规则；新增 `.tw-num`/`.tw-ytd` 数字面并**同时**登记进两张数字模糊选择器清单 |
| `src/client/WatchlistPage.tsx` | 接入 `SortHeader`；新键取值（额/涨跌额/α）；α 抽成 `alphaOf()` 单一实现（排序与显示共用）；行内新增 `YTD`；YTD 失败/截断/缺失摘要行 |
| `src/client/PortfolioPage.tsx` | 接入 `SortHeader`；新键取值（现价/成本，成本跟随口径）；持仓卡新增「标的年初至今」格；面板头补 `flexWrap:'wrap'` |
| `src/client/api.ts` | 新增 `api.ytd(secids)`（`GET /tradewatcher/ytd`） |
| `src/client/ytdView.ts`（新） | 纯函数：`ytdText` / `ytdTooltip` / `ytdMissingSummary`（不 import react，可被 `node --test` 直接跑） |
| `src/client/ytdView.test.ts`（新） | 上述纯函数的断言（6 条） |
| `src/client/useYtd.ts`（新） | hook：跟随共享行情节拍拉一次 YTD；失败**不清空**已有数字，只单独标错 |
| `src/host/ytd.ts`（新） | YTD 宿主实现：纯函数 `ytdBaseFromBars`/`ytdPctOf` + `YtdMemo`（按日）+ 批量 `computeYtds`（并发 ≤4、失败冷却、行序保持） |
| `src/host/ytd.test.ts`（新） | 上述实现的断言（9 条，K 线取数与时钟均为注入，**不打上游**） |
| `src/host/routes.ts` | 新增 `GET /tradewatcher/ytd?ids=`（上限 `YTD_MAX_IDS=60`，超出如实 `truncated`；回包带 `asOf`/`stale`/`source`/`missing[]`） |
| `src/host/tools.ts` | 新增读工具 `tradewatcher_ytd`（含 provenance 尾注与缺失明细）；`guidanceText()` 增一句触发提示；新增 `dedupeMissing()`（行情缺失与 YTD 缺失合并去重） |

> 范围说明：`src/host/ytd.test.ts`、`src/client/ytdView.test.ts` 是**断言随实现**（任务要求"新增纯函数必须配断言、文件与既有 `*.test.ts` 同目录"），其余文件均在 task-3 的写作用域内。

## 2. 列头排序：口径与验收方式

**可排序列（键 ↔ 列一一对应，键必须在 prefs 白名单内）**

- 自选：名称（**不可排**）/ 成交额 `amount` / 市值 `mv` / 涨跌 `chg` / 涨跌幅 `pct` / 行业 α `alpha`
- 持仓：名称（**不可排**）/ 市值 `mv` / 成本 `cost` / 现价 `price` / 盈亏 `pnl` / 当日 `dayPnl` / 仓位 `weight`

**四条硬约束的保持方式**

1. **无效值恒沉底**：全部走既有 `sortByNumber`（`null`/`NaN`/`Infinity` 一律沉底，升序也不上前）。新增键里 `alpha` 是复合值：个股或板块任一侧缺失即 `null` ⇒ 沉底，不会退化成 0。
2. **同值稳定**：`sortByNumber` 的 `index` 比较不变；新键只是多几个 `pick` 分支。
3. **盈亏/成本跟随口径**：`pnl` 仍是 `diluted ? dilutedPnl : floatPnl`；新增的 `cost` 同样是 `diluted ? dilutedCost : avgCost` —— **排序用的数与「成本」列显示的是同一个数**。
4. **偏好仍写 prefs、白名单不变松**：键名与允许值集中在 `shared/model.ts`，宿主 `store.ts` 的校验直接引用同一份数组（见 §5 实测：新键可存可回读，非法键 `name` 仍 400）。段控 `SortBar` 完整保留。

**交互与可达性**

- 点列头排序；点同列翻转方向；当前列显示 ▲/▼；`columnheader` 上带 `aria-sort`（`ascending`/`descending`/`none`）；可聚焦的是原生 `<button>`，Enter/Space 天然生效。
- 宽屏（≥1500px）用列头、窄屏用段控：隐藏条件挂在 `SortBar` 的 `wideHidden` 属性上，且只在**同一页确实渲染了列头**时传 `true` —— 单向失败：漏传只会"两个入口都在"（多一个无害），**不会**出现"宽屏下一个排序入口都没有"。列头里另有 `↺ 默认顺序`，所以宽屏收起段控不丢操作。
- 列头与行内数值**不严格纵向对齐**（行是 `flex` 卡片、不是列网格）。这是审计 P1-1（列网格）的范围，属第二轮；本轮列头的每一格都对应行内**确实存在**的字段，且点击后排序键与显示值同源（α 已抽成单一实现）。因此控件上的可见文案写「排序 · <字段名>」而不是「列头」，但行为与验收口径就是"点列头排序"（`aria-label` 也用「列头排序」这个通用名）。

**验收方式**

- 自动：`WATCH_COLUMNS`/`PORT_COLUMNS` 的结构断言（列名与顺序、`key` 必须落在白名单、键不重复、除 `default` 外每个白名单键都能在列头点到、每列都有口径提示、名称列的提示必须写明"不做排序"）；新键的升降序与"缺失沉底"断言。
- 手工（待装机验证，见 §6）：≥1500px 点「市值」列头 → 顺序按市值降序、▲ 出现、再点变升序；Tab 到列头按 Enter 能排序；<1500px 列头消失、段控出现（宽窄各截一图）。

## 3. 年初至今（YTD）：口径与验收方式

**口径（写死在 `shared/model.ts` 的 `YTD_CALIBER`，界面 tooltip 与 agent 工具引用同一句）**

> YTD =（现价 − 本年内第一个交易日收盘价）÷ 该收盘价 × 100%，序列用**前复权**。

- **为什么前复权**：除权除息那天不复权序列会跳空下跌，那不是真实收益。
- **指数/期货/板块**：`fqSupported=false` ⇒ 按原始价格（点位/合约价），tooltip 必须写「该标的不适用复权（指数是点位、期货是合约价，没有除权除息），按原始价格计算」。
- **基准的两处诚实化**（写入口径的实现细节，均随结果返回并在 tooltip 显示）：
  1. `baseKind='listing'`（本年内上市）：序列里没有更早的交易日 ⇒ 基准是**上市首日**，tooltip 写成「上市首日至今，不是年初至今 —— 按年初读会高估」。
  2. **年内第一个交易日就是今天**（一年只有这一天会撞上）：口径要求的是**收盘价**，因此本轮**不给数**，`why` 说明「本年内还没有已收盘的交易日」，`missing[].why='no-source'`（今天重试无用，得等下一个交易日）。不拿未收盘价当基准，也不拿上一年收盘顶替（那属于另一条口径）。
- **现价**来自与其它面板**同一次**行情（`fetchQuotesWithProvenance` 的 TTL 缓存/逐标的槽），不是另开一条链路；行情缺失时**不去打日线**（算不出来，还白触发一次全量 K 线拉取）。

**取数与压力控制**

- 基准复用 `em.fetchKline(secid, 101, 400, 1)`：磁盘缓存 + 增量 + 单飞 + 休市定稿零回源，口径进缓存键（`_1`）。
- `YtdMemo` **按 (secid, 交易日) memo 一天一次**：同一交易日内不再取基准；失败结果带 10 分钟冷却（冷却期内不重打上游，过了冷却允许再试一次）——既不"每个轮询周期重算"，也不把一个瞬时失败钉死一整天。
- 批量 `computeYtds` **并发 ≤4**（与 `anomaly.ts` 同写法），逐条失败只影响那一条；结果按入参顺序返回（"沉底"语义依赖顺序）。
- 单次上限 **60 项**（行情的上限是 160；YTD 每个标的首次要拉一次全量日线，因此更低），超出如实回报 `requested`/`truncated`/`limit`，**不静默截断**。

**缺失显式化**（客户端与宿主都保留）

- 行内一律 `—`，**不用 0 顶替**；原因分两类写进 `missing[]`：`transient`（日线本次取不到/现价缺失，稍后随行情轮询自动重试）与 `no-source`（今年还没有已收盘交易日，重试无用）。
- 页面级只说"N 项算不出 + 第一条原因"，逐条原因在行的 tooltip 里；路由整体失败时单独标红一行，且**保留上一次已取到的数字**（不清空成 `—`）。
- 隐身/数字模糊：新数字面（`.tw-num`、`.tw-ytd`）已登记进 `styles.ts` 的两张模糊选择器清单（审计 P0-7 的预防项）。

**验收方式**

- 自动：`host/ytd.test.ts`（基准选取、年内第一个交易日、未开市、年内上市、`ytdPctOf` 的空值、批量并发 ≤4/顺序/不打日线、失败冷却与按日 memo、`no-source` 分类、memo 淘汰）；`client/ytdView.test.ts`（`—` 与方向字形、tooltip 必带口径原文、指数"不适用复权"、年内上市"上市首日至今"、缺失原因、"还没结果/未返回"的区分）。
- 实测（本机，非浏览器，K 线与行情走本地缓存）：`GET /tradewatcher/ytd` 对 `1.600519,1.000300,114.lhm,1.NOPE` 返回 200，`source='mixed'`、`stale=false`，贵州茅台 `YTD −10.17%（基准 2026-01-05 收盘 1397.976，前复权）`；沪深300 `−8.64%（fqSupported=false，按点位）`；生猪主连与不存在代码给 `—` + 原因；`truncated=false、limit=60`。工具 `tradewatcher_ytd` 同样跑通并通过 `losslessJson` 往返一致。

## 4. 新增/修改的断言清单

`src/client/sort.test.ts`（原 8 条**全部保留**，新增 4 条）
1. `sortWatch：列头新增的成交额/涨跌额/行业α 三个键各自可用，缺失恒沉底`
2. `sortPositions：列头新增的现价/成本两个键各自可用，无价者沉底`
3. `列头定义：有数值来源的列才可排，键必须在白名单内且不重复`（列名与顺序、名称列 `key=null` 且提示须含"不做排序"、每列都有口径提示、除 `default` 外白名单键都能点到）
4. `新增排序键进入 prefs 契约：白名单与列头一致，非法键仍然回退`

`src/host/ytd.test.ts`（新，9 条）
5. 基准取本年内第一个交易日收盘价
6. 年内第一个交易日就是今天 ⇒ 不给基准
7. 序列里还没有今年交易日（未开市）⇒ 不给基准（含空序列）
8. 本年内上市 ⇒ `baseKind='listing'`（并验证"取满窗口时不算 listing"）
9. `ytdPctOf` 空值/非正基准/NaN ⇒ `null`；两位小数四舍五入
10. `computeYtds`：并发 ≤4、顺序保持、现价缺失不打日线、缺失分类
11. `computeYtds`：日线失败 ⇒ `—` + `transient`；按日 memo 不重算、失败冷却 10 分钟、冷却过后允许再试
12. 今年还没有已收盘交易日 ⇒ `no-source`
13. `YtdMemo`：容量淘汰 + 换一天必须重算

`src/client/ytdView.test.ts`（新，6 条）
14. `ytdText`：`—`/方向字形/0.00%
15. tooltip 必带口径原文 + 基准日 + 现价 + 实际生效复权口径
16. 指数/期货：必须说明"不适用复权、按原始价格"
17. 年内上市：必须写成"上市首日至今"
18. 缺失时给原因，并区分"尚未取到"与"路由未返回"
19. `ytdMissingSummary`：全可算为 `null`，有缺失报数量 + 首条原因

合计：107 → **126** 条（两个时区各跑一遍）。

## 5. `npm run check` 实测输出摘要

```
> dsh-tradewatcher@0.29.0 check        # typecheck → test → selftest → build
typecheck: tsc --noEmit 通过（无输出）
test:      ℹ tests 126 / ℹ pass 126 / ℹ fail 0   （Asia/Shanghai 与 TZ=UTC 各一遍，两遍同结果）
selftest:  ALL HOST CHECKS PASSED (live probes soft)   # 本机上游被重置，网络探针按既有约定 soft
build:     built lib/index.js + lib/client.js （v0.29.0，客户端片段校验通过：75 项）
```

另有两条本机实测（临时脚本，未入库）：

- `GET /tradewatcher/prefs` 写入 `{watchSort:{key:'alpha',desc:false},portSort:{key:'cost',desc:true}}` → 200 并回读一致；写 `{key:'name'}` → **400「watchSort.key 必须是 default/pct/mv/amount/chg/alpha」**，且被拒的写入不污染已有偏好（白名单是自动扩容的，没被放宽）。
- `tradewatcher_ytd` 注册成功（注册总数 9 → 10；读工具 7 → 8，另两个是写工具 `calendar_add` 与 `undo`），回包 `losslessJson` 往返一致，render 含口径行、逐行基准与"不适用复权"标注、`【数据出处】`与缺失明细。

## 6. 没做的项及原因

1. **名称列不做排序**（自选与持仓都不做）：本插件的排序契约是**数值比较**（无效值恒沉底、同值保持原顺序）；中文名顺序取决于运行环境的排序表（ICU），不同环境可能给出不同结果，排错比不排更糟。列头里名称列只作标签，`hint` 写明原因，`SortBar` 的「默认」与列头的 `↺ 默认顺序` 负责回到自定义顺序。**替代方案**：若确实要按名称排，需要先定一套不依赖环境的口径（如拼音首字母表入库），属另一轮。
2. **YTD 不进列头排序**：task-3 给出的两张列头清单里没有 YTD（自选 = 名称/成交额/市值/涨跌/涨跌幅/行业α；持仓 = 名称/市值/成本/现价/盈亏/当日/仓位），因此本轮把 YTD 做成**展示列**。数值本身已随行返回，若 Lead 要 `⇅`，加一个 `ytd` 键 + 一行列表项即可（`sortByNumber` 直接可用）。
3. **列头与行内数值不纵向对齐**：行的布局是 `flex` 卡片（`styles.ts` 的 `.tw-wrow`/`.tw-posrow`），真正的列网格是审计 P1-1（第二轮）。本轮的列头是"字段级排序入口"，每格都对应行内确实存在的字段，且排序键与显示值同源（α 已抽成 `alphaOf()` 单一实现）。**替代方案**：P1-1 落地后列头可原位复用（`WATCH_COLUMNS`/`PORT_COLUMNS` 就是列顺序的单一来源）。
4. **年内第一个交易日的 YTD 不给数**：口径要求"**收盘价**"，该日没有已收盘的更早交易日 ⇒ 显示 `—` 并说明原因（不去拿未收盘价或上一年收盘顶替）。这是对写法的一处**收紧**，如果是"跨年首日必须有数"的诉求，需要先定第二条口径（基准＝上一年最后一个交易日收盘价），本轮不擅自引入。
5. **港/美股的交易日口径未处理**：YTD 的"本年内第一个交易日"取的是该标的**日线序列里今年的第一根**，因此港股/美股用的是它们自己的交易日序列（这一点是对的）；但没有引入"市场日历"层（P1-13），跨市场比较时"年初"的起算日不同属已知边界。
6. **审计 P1-13（排序键名随成本口径漂移）未做**：切到均价口径后段控仍写「持仓盈亏」，而列名是「浮动盈亏」。这是既有问题、且属第二轮清单；本轮只保证**排序键与显示值同源**，并在 hint 里写明"跟随当前口径"。（列头用的是中性的「盈亏」，不受此影响。）
7. **未做浏览器内实测**：本机 `node_modules` 里没有 `react`（客户端 externals 由 web shell 提供），也没有浏览器自动化，因此"列头点击/键盘/aria-sort/模糊"这些**渲染层**验收只有类型检查 + 构建产物片段校验 + 列定义的结构断言兜底，**渲染路径一行都没真正执行过**，需要装机后在 ≥1500px 与 <1500px 各看一次（§2 的手工清单）。

## 7. 顺带修掉的相邻问题（都是本批改动诱因，标注在案）

- **`styles.ts` 数字模糊清单**：新增 `.tw-num`（额/市值/α，此前只有 α 用内联等宽字体、**不在**模糊清单里）与 `.tw-ytd`，两张规则同时登记。
- **持仓页面板头不换行**：排序键从 5 个增到 7 个后整行约 900px+，不 wrap 会把「汇率/备份/刷新」顶出卡片右缘 —— 已补 `flexWrap:'wrap'`，与自选页行为一致（审计 P1-3 的同一现象）。
- **列头/段控的隐藏条件绑成一处**：不再由 CSS 无条件隐藏段控，而是 `SortBar` 的 `wideHidden` 属性（审计 P1-2①）。

## 8. 遗留风险

1. **首次打开自选/持仓页的成本**：每个标的第一次会触发**一次**全量日线拉取（`em` 侧的 800 根上限，≤4 并发，之后进 `klines/` 磁盘缓存 + 增量；休市定稿时零回源）。自选 40 只 ⇒ 首次约 40 次历史接口请求，分摊在 ≤4 并发内；此后每个交易日首次刷新只做增量。若嫌重，可把 `YTD_BARS` 降到 260 或把 `YTD_MAX_IDS` 再压低。
2. **YTD 的分子来自行情、分母来自 K 线**：前复权序列的"最新价"与真实成交价一致（前复权锚在最新价），因此盘中口径一致；但若上游对复权因子做了历史重算而本地缓存尚未刷新，基准价会短暂是旧复权口径（已由 `asOf` 暴露，tooltip 里给出基准时刻）。
3. **YtdMemo 是进程级内存**：重启后当天会重算一次基准（命中磁盘缓存 ⇒ 不产生上游请求）；容量 800 条按最早写入淘汰。
4. **`aria-sort` 的结构合规性**：`role="row"`/`role="columnheader"` 未包在 `table`/`grid` 容器里（行不是真表格），部分读屏软件可能只播报 `aria-label` 与 `aria-sort` 文本 —— 属 P1-1 列网格落地后一并规整的范围。
5. **`README.md` 的工具清单 / 路由清单需要 Lead 补**：新增了路由 `GET /tradewatcher/ytd` 与工具 `tradewatcher_ytd`（README「会话内分析」「HTTP 路由」两处），README 不在我的写作用域内。
