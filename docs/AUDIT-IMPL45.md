# AUDIT-IMPL45 —— 工具箱工具①「五市场蛋糕」：宿主取数 + 每日快照 + 详情页接真数据（实现报告）

- 基线：`main` @ `e692f7c`（v0.71.0，`npm run check` 494/时区全绿）。本报告是**实现**报告（审计按惯例另开）。
- 用户已定的口径与形态（**不得改**，全部落进代码注释与本文档 §2）：五市场 = 美股/欧股/日股/A股/新兴市场；
  宽基 ETF 规模权重（主）＋横截面动量（20/60/120 日）＋A股净流入单列；详情页五块（KPI 行含 delta / 份额曲线 /
  **静态**饼图 / 市场表（份额+变化）/ 边界声明）；固定 180 日；不做自动播放；滑块手动回放最近 30 个交易日；
  不显示"延迟 15 分钟"；时间一律 `Asia/Shanghai`；数据全部公开源（**不用** Arkvol、**不标** Arkvol）；不走东财 `push2*`。
- 本轮本人写入面（与任何别的成员不重叠）：
  `src/host/globalFlow.ts`（新）、`src/host/globalFlow.test.ts`（新）、`src/host/sina.ts`（只追加取数原语）、
  `src/host/routes.ts`（加一条路由 + 一行 import）、`src/index.ts`（`ROW_ROUTES.tools`）、
  `src/client/toolText.ts`（新）、`src/client/toolRegistry.ts`、`src/client/tools/cake.ts`、
  `src/client/tools/globalFlowView.ts`（新）、`src/client/tools/globalFlowView.test.ts`（新）、
  `src/client/ToolsPage.tsx`、`src/client/api.ts`、`src/client/toolRegistry.test.ts`、`src/client/toolsPage.test.ts`、
  `src/index.test.ts`、`cordis.patch.yml`（只改注释里那一行行说明）、`docs/AUDIT-IMPL45.md`（本文件）。
  **未触碰** `build.mjs`（零改动）、`src/host/em.ts`、`src/host/tencent.ts`、`src/host/selftest.ts`、`src/host/store.ts`、
  `package.json`、`src/shared/**`、其它行的文件。
- 纪律：未 `git commit` / `push`；未装 bundle、未动 profile、**未重启用户的 `dsh web`**；
  所有实验都在 `/tmp` 隔离环境（`DSH_HOME=/tmp/cake-*`，测试内每个用例一个临时目录）。

---

## 0. 结论（先看这一段）

1. **数据层已落地**：`src/host/globalFlow.ts` 一次装配出「五市场规模 + 份额 + 5 日轮动 + 动量横截面排名 + 180 日份额曲线 + 30 日回放窗口 + A股净流入（单列）」，
   真网络冷启动 **14 次上游请求 / 1.65 秒**，热命中（TTL 内）**0 次**，`source=snapshot`（回放）**0 次**（§3.4 实测）。
2. **口径写进代码**：份额 = 市场规模 ÷ **有值**市场规模之和（缺的市场不进分子也不进分母 ⇒ 有值部分恒为 100%）；
   A股规模是人民币 ⇒ 按新浪在岸汇率折美元后进分母，**汇率取不到就不折算、单列、标注口径不一致**（不静默混算）；
   **A股净流入单列，绝不参与份额计算**（§2）。
3. **曲线口径已注明**：有实测快照的日期 = 实测（`origin=observed`），其余历史日 = `当前实测规模 × 该市场日线收盘价之比` 重建
   （`origin=rebuilt`，**假定 ETF 份额数量不变** ⇒ 只反映价格驱动的相对规模变化，不反映申赎）。实测/重建在数据与界面上分开标注。
4. **详情页五块渲染真数据**：KPI 行（含 delta）/ 份额曲线（180 点，SVG）/ 静态饼图（无动画、无自动播放）/
   市场表（份额 + 变化 + 动量 + 排名）/ 边界声明；另有 A股净流入单列块与回放滑块。缺数据一律 `未取到` + 原因，
   **整表不出现 0 顶替**（§5 断言 ②，含反例注入）。
5. **每日快照留存**：`<dataHome>/global-flow.json`，一天一条、保留 90 天。实测 **1930 B / 天** ⇒ 90 天 ≈ **170 KB**
   （量小 ⇒ 按用户要求把 TTL 放长：现价类 30 分钟、日线类 12 小时、载荷 10 分钟）。
6. **六项断言 + 六条反例注入全部到手**：①份额合计 100% ②某市场失败 ⇒ 该行未取到+原因且整表无 0 ③无轮动时给等价文案
   ④净流入不参与份额 ⑤并发 2 次只打一遍上游 ⑥回放零上游。反例注入 6/6 被抓（§6，含 `14 → 28`、`14` 这样的量级读数）。
7. `npm run check` **EXIT=0**：typecheck + **515×2（两时区）** + selftest + build（末尾三行见 §7）。
8. ⚠ **需要 Lead 安排一次 `dsh web` 重启**（我不能重启）：运行中的实例里 **`tools` 行没有装载**
   （19:08/21:08 两次实测 `GET /tradewatcher/rows` = `["core","calendar","watchlist","portfolio","market","cloudmap"]`，
   新路由 `GET /tradewatcher/tools/global-flow` = **404**）。原因：宿主行只在**启动时**按 manifest 装载，
   该实例 16:47 启动，而第 7 行（`tradewatcher-tools`）是 20:46 才提交的 ⇒ 装载点里根本没有这一行。
   代码/产物都是对的（§7 产物核对），重启后即生效。详见 §8.1。

---

## 1. 改动点（`文件:行号`）

### 1.1 宿主取数原语（`src/host/sina.ts`，只追加）

| 文件 | 位置 | 改动 |
| --- | --- | --- |
| `src/host/sina.ts` | `:218` | `sinaText(url, {gbk,timeoutMs})`：统一带 `Referer: https://finance.sina.com.cn` + GBK/UTF-8 解码（**实测不带 Referer 会被拒**） |
| `src/host/sina.ts` | `:242`、`:266` | `parseSinaUsDaily`（jsonp 解析，丢掉 0/非法价）/ `fetchSinaUsDaily(symbol)`（美股 ETF 全历史日线） |
| `src/host/sina.ts` | `:286`、`:306` | `parseSinaGb` / `fetchSinaGb`：`gb_*` 行 → 名称、价、涨跌幅、**总市值（下标 12）**、股本（下标 19）、行情时间 |
| `src/host/sina.ts` | `:324`、`:356` | `parseSinaEtfNode` / `fetchSinaEtfNodeSize(symbol)`：ETF 节点翻页定位（`nmc` 万元 = 规模） |
| `src/host/sina.ts` | `:380`、`:403` | `parseSinaMoneyFlow` / `fetchSinaMoneyFlow(symbol, days)`：逐日 `netamount`（元） |
| `src/host/sina.ts` | `:427`、`:439` | `parseSinaFx` / `fetchSinaFxUsdCny`：在岸人民币最新价（下标 8）+ 昨收（下标 3）作合理性校验 |

### 1.2 宿主数据层（新文件）

| 位置 | 内容 |
| --- | --- |
| `src/host/globalFlow.ts:1-60` | 文件头：**口径 ①–⑥ 全写在这里**（份额分母、币种、动量、净流入单列、时间口径）+ 数据来源 + 缓存/快照规矩 + 曲线口径 |
| `:77` | `FLOW_MARKETS`：五市场定义（规模标的 SPY/VGK/EWJ/510300/EEM、动量口径、来源文案） |
| `:107-119` | TTL 与窗口常量：现价 30 分、日线 12 小时、载荷 10 分（残缺 2 分）、曲线 180 日、回放 30 日、快照保留 90 天、轮动判定线 0.05pp |
| `:150` | `cached()`：TTL + **在飞合并**；失败不进缓存（低频日级数据，重试成本低于把抖动锁 10 分钟） |
| `:195` | `sharesOf()`：份额（分母 = 有值之和；全缺 ⇒ 全 `null`） |
| `:231`、`:255` | `momentumOf()`（20/60/120 日收益率）/ `momentumRanks()`（横截面排名，并列取最靠前，样本不足 ⇒ `null`） |
| `:307` | `rotationOf()`：5 日轮动三态（`rotation` / `flat` / `unknown`）+ 文案 |
| `:418` | `buildCurve()`：实测优先 + 重建补齐；轴 = 各市场交易日 ∪ 快照日；缺口前向填充 |
| `:507`、`:523` | `trimSnapshotDays()`（保留 90 天）/ `writeFlowSnapshot()`（一天一条、覆盖写、≥5 分钟节流、**全缺不写**） |
| `:598` | `marketRaws()`：五市场规模 + 汇率 + 两条日线序列；每一处失败都产出 `{what, why, note}` |
| `:717`、`:725` | `FLOW_NOTES`（五块的口径行，唯一来源）/ `FLOW_BOUNDARY`（边界声明 7 条） |
| `:736`、`:764`、`:919` | `globalFlowPayload()`（`auto` 在飞合并 + 两档 TTL；`snapshot` 只读本地、零上游）/ `buildLivePayload()` / `payloadFromSnapshot()` |

### 1.3 路由与行归属

| 文件 | 位置 | 改动 |
| --- | --- | --- |
| `src/host/routes.ts` | `:409` | 新增 `GET /tradewatcher/tools/global-flow`（`?source=auto|snapshot`；认不出的值 ⇒ **400**，不静默当 auto） |
| `src/index.ts` | `:63` | `ROW_ROUTES.tools = ['/tradewatcher/tools/global-flow']`：**按 §2.2 判据**（单一消费方 ⇒ 该行）从"空数组"改成独占一条；注释同时更新 |
| `cordis.patch.yml` | `:12-15` | 行说明里那句"本轮没有独占 host 路由"已过期 ⇒ 改成"独占 `/tradewatcher/tools/global-flow`"（**只改注释**） |
| `src/index.test.ts` | `:214-217`、`:322` | 同步：`tools.routes` 期望值、`ROW_ROUTES_FOR_TEST.tools`；新增"只准注册自己前缀下的路由"断言 |

### 1.4 客户端

| 文件 | 位置 | 改动 |
| --- | --- | --- |
| `src/client/toolText.ts`（新） | `:1-30` | 固定文案下沉到**叶子模块**（见 §1.5 的环依赖说明）；`toolRegistry.ts` 原样再导出 ⇒ "文案唯一来源"不变 |
| `src/client/toolRegistry.ts` | `:62`、`:92`、`:256` | 新增 `ToolPayload`（一次取数 + 本地回放）/ `ToolData`（真实数据模型）；`detailModel(entry, data=null)`：无数据仍是骨架 + 占位（**零数字红线照旧**），有数据时数值**只来自 ToolData** |
| `src/client/toolText.ts`（新） | `:27-31` | "没有数据"的原因分三档：`PENDING_WHY`（工具还没有数据源）/ `NO_DATA_WHY`（这一屏没取到）/ `SECTION_EMPTY_WHY`（这一区没有）——缺数据必须给原因，不许含糊 |
| `src/client/tools/globalFlowView.ts`（新） | `:28-95` | 格式化（`未取到`/`—`/带符号 pp/万亿·亿美元/亿元）+ 回放索引（`step 0 = 最新`） |
| 同上 | `:97`、`:115`、`:150`、`:243` | `pieSlicesAt`（缺的市场不进饼图并说明）/ `marketRowsAt`（份额 + 变化；回放日不重算动量）/ `globalFlowToolData`（完整视图模型）/ `globalFlowToolPayload`（载荷句柄） |
| `src/client/tools/cake.ts` | `:24` | 工具条目（id `cake`，名称「五市场蛋糕」，五个区的结构 + 边界声明 + `load()`）；文案**不含阿拉伯数字**（红线） |
| `src/client/ToolsPage.tsx` | `:63-105` | 详情页数据流：`entry.load()` 取一次（`:63`）+ `payload.at(step)` 本地换帧（`:87`）+ 失败 ⇒ 原因 |
| 同上 | `:234`、`:248`、`:260`、`:383`、`:470` | 回放滑块（`type='range'`）/ 曲线 SVG（缺的点断开）/ 饼图 SVG（静态、中心留白）/ 市场表（行下逐行原因）/ 边界声明 / A股净流入单列块 |
| `src/client/api.ts` | `:70-115`、`:182` | DTO（与宿主同形）+ `api.globalFlow(source)` |

### 1.5 测试

| 文件 | 位置 | 改动 |
| --- | --- | --- |
| `src/host/globalFlow.test.ts`（新） | 14 条 | §5 的六项 + 快照保留/前向填充/曲线锚定/动量与排名/币种/视图全缺 |
| `src/client/tools/globalFlowView.test.ts`（新） | 5 条 | 格式化（缺数据不给 0）/ 五块渲染 / 缺市场一行 + 饼图说明 / 回放换帧 / 取数失败给原文原因 |
| `src/client/toolRegistry.test.ts` | `:117`、`:135`、`:161`、`:180` | 结构标签同步成五市场；红线**保持原强度**（无数据 ⇒ 整份模型零阿拉伯数字）；新增"结构先行工具走 PENDING_WHY"（`:161`）与"有数据时数值只来自数据"（`:180`）两条 |
| `src/client/toolsPage.test.ts` | `:135-200` | `detailModel(entry, data)` + 6 个新接线点（delta/滑块/逐行原因/附加块/状态行/at(step)），注入从 4 条加到 6 条 |

> **为什么多出一个 `toolText.ts`（如实记录一次踩坑）**：工具文件里有运行时 import（`load()` → `globalFlowView` → `api`），
> 而视图模块又要用 `NOT_FETCHED`。文案留在注册表里就形成 `toolRegistry → tools/cake → tools/globalFlowView → toolRegistry` 的环，
> ESM 下直接 `ReferenceError: Cannot access 'cakeTool' before initialization`（本机实测）。
> 把**纯常量**下沉到叶子模块即断环；`toolRegistry` 仍原样再导出这些名字 ⇒ 调用方与断言一行都不用改。

---

## 2. 口径定义与公式（用户已定，代码里同款）

| # | 量 | 公式 / 口径 | 代码 |
| --- | --- | --- | --- |
| 1 | 市场规模（美股/欧股/日股/新兴） | 新浪 `gb_*` 的「总市值」字段（美元）。⚠ 用户口径里的"字段 13"是**1 起数** ⇒ 下标 12；下标 13 是市盈率（实测恒 `0.00`） | `sina.parseSinaGb` |
| 2 | 市场规模（A股） | 新浪 ETF 节点 `nmc`（**万元**）× 1e4 = 元 ⇒ ÷ 汇率 = 美元 | `sina.fetchSinaEtfNodeSize` |
| 3 | 汇率 | 新浪 `fx_susdcny` 最新价（下标 8），昨收（下标 3）做 ±5% 合理性校验；**取不到 ⇒ `aumUsd = null`（不折算、不进合计、标注口径不一致）** | `sina.parseSinaFx` / `globalFlow.toUsd` |
| 4 | 份额 | `share_i = aumUsd_i / Σ_j aumUsd_j`，**分母只含有值市场**；某市场缺 ⇒ 不进分子也不进分母 ⇒ 有值部分恒为 100%（±0.1 显示位） | `sharesOf` |
| 5 | 动量 | 各市场**自己的**交易日：`r_n = close_t / close_{t−n} − 1`，n ∈ {20, 60, 120}；样本不足 ⇒ `null`（不回填 0） | `momentumOf` |
| 6 | 横截面排名 | 每个口径先排名（1 = 最强；并列取最靠前）⇒ 综合分 = 各**能算出**的口径名次均值 ⇒ 再排名 | `momentumRanks` |
| 7 | 5 日轮动 | 最新一日份额 − 5 个序列日前份额；增幅最大 = "转向"的目标、降幅最大 = 来源；**两侧幅度都 < 0.05pp ⇒ `flat`（"未见明确轮动"）**；可比市场 < 2 或序列不足 ⇒ `unknown`（"判不了"，不许当成"没有轮动"） | `rotationOf` |
| 8 | A股净流入 | 新浪 `MoneyFlow.ssl_qsfx_zjlrqs` 的逐日 `netamount`（元）累加 **20 个交易日**；**单列，不参与任何份额/规模计算**（流量 ≠ 存量加权） | `fetchSinaMoneyFlow` + `netFlow` |
| 9 | 份额曲线（180 日） | 有实测快照的日期 = 实测；其余 = `当前实测规模 × 该日收盘价 / 该市场最新收盘价`（**假定 ETF 份额数量不变**）；轴 = 各市场交易日 ∪ 快照日，缺口前向填充 | `buildCurve` / `alignSeries` |
| 10 | 回放（30 日） | 滑块位置 `0 = 最新一日`；换帧只在**同一份载荷**上本地计算 ⇒ **零上游请求**；回放历史日不重算动量（上游只保留当下横截面），如实标"不适用（回放日）" | `globalFlowView.at` |
| 11 | 时间 | 一律 `Asia/Shanghai`（快照 key 用北京时间日期；界面时刻走 `Intl` + `timeZone: 'Asia/Shanghai'`）；**不显示"延迟 15 分钟"** | `time.dayOf` / `fmtBeijing` |

**已知的口径形状（写进边界声明，免得被读成错数）**：SPY 是全世界最大的宽基 ETF（实测 8222.73 亿美元），
约为其余四家合计的 8 倍 ⇒ 这个"几只超大宽基 ETF 的规模权重"天然偏美股（实测 **89.17%**）。
这是口径本身的形状，不是错数；"各市场全部 ETF 合计"是另一个口径，本工具不做。

---

## 3. 取数路径与实测样例

### 3.1 路径表（2026-10-12 本机实测）

| 用途 | 端点 | 关键字段 | 备注 |
| --- | --- | --- | --- |
| 五市场规模（4 个） | `https://hq.sinajs.cn/list=gb_{spy,vgk,ewj,eem}` | 下标 12 = 总市值（美元）、19 = 股本、3 = 行情时间 | ⚠ 代码列表在**路径**里（`/list=...`），不是查询串；GBK |
| A股规模 | `.../Market_Center.getHQNodeData?page=1&num=100&sort=symbol&asc=1&node=etf_hq_fund` | `nmc`（万元） | `num` 上限 100（实测给 1000 也只回 100 行）；`symbol=` 参数**不生效** ⇒ 按 `symbol` 升序翻页定位（上限 6 页，实测 `sh510300` 在第 1 页） |
| A股净流入 | `.../MoneyFlow.ssl_qsfx_zjlrqs?page=1&num=20&sort=opendate&asc=0&daima=sh510300` | `opendate` / `netamount`（元） | 实测 20 行 = 2026-09-07…2026-10-12 |
| 汇率 | `https://hq.sinajs.cn/list=fx_susdcny` | 下标 8 = 最新、3 = 昨收、0 = 时刻、9 = 名称 | GBK |
| 欧/日/新兴 日线（规模重建 + 动量） | `https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/x/US_MinKService.getDailyK?symbol={vgk,ewj,eem}` | `d/o/h/l/c/v/a` | jsonp 形态（`/*<script>…*/x([...])`）；**全历史**（VGK 5430 根 ≈ 500 KB）——不接受条数参数 |
| 美股 日线（规模重建） | 同接口 `symbol=spy` | 同上 | SPY 6480 根 ≈ 632 KB |
| 美股 动量 | 腾讯 `.../fqkline/get?param=us.INX,day,,,260,qfq` | `data['us.INX'].day` | 指数没有除权除息 ⇒ `day` 与 `qfqday` 同序列（与 v0.71.0 的既有结论一致） |
| A股 动量 / A股规模重建 | 腾讯 `param=sh000300,…` / `param=sh510300,…` | `qfqday` | 实测都回 `qfqday`（A股 ETF/指数有分红） |

**实测陷阱（都是本机跑出来的，别再踩）**：

1. **用户口径里的"字段 13"是 1 起数**。`gb_spy` 的下标 13 实测恒 `0.00`（市盈率），下标 **12** 才是总市值：
   `822272781554`，而 `最新价 × 股本 = 778.57 × 1056132116 = 822272781554` ⇒ 两条独立路径对上（口径自校，代码里也做这一步）。
2. **A股 ETF 的 `nmc` 才是规模，`mktcap` 不是**：`sh510300` 实测 `nmc = 10635037.4372 万元 = 1063.50 亿元`，
   与**腾讯 `qt.gtimg.cn/q=sh510300` 的 f45（总市值）= 1063.50 亿元**一致；同一个 ETF 的 `mktcap` 只有 `824.69 亿元`（差 29%）。
3. **腾讯没有美股 ETF 的日线**：`param=usVGK,day,,,320,qfq`（含显式起止日）实测**只回 1 根** ⇒ 动量/重建必须走新浪；
   但腾讯 `qt.gtimg.cn/q=usVGK` 的行情是有的（含股本）——只是没有历史。
4. **新浪美股日线端点不接受条数参数** ⇒ 一次拿全历史再截尾（500 KB 级）。因此日线 TTL 放长到 12 小时（§4）。
5. `hq.sinajs.cn` 的 `Referer` 必带（`sinaText` 统一加）；响应是 GBK。

### 3.2 源交叉校验（两条独立路径互相印证）

| 量 | 路径 A | 路径 B | 一致性 |
| --- | --- | --- | --- |
| A股 ETF 规模 | 新浪 ETF 节点 `nmc` = 1063.50 亿元 | 腾讯 `f45` = 1063.50 亿元 | 一致（4 位有效数字） |
| 五市场 ETF 规模 | 新浪 `gb_*` 总市值 | `最新价 × 股本`（同回包内的两个字段） | 一致（代码里逐行自校，偏差 > 5% 会在口径行标出） |
| 汇率 | 新浪 `fx_susdcny` = 6.6937 | 腾讯 `whUSDCNY` = 6.6932 | 差 0.007%（在岸价不同报价源，同一量级） |

### 3.3 冷启动请求清单（真网络，隔离 `DSH_HOME`）

```
hq.sinajs.cn           /list=fx_susdcny
hq.sinajs.cn           /list=gb_spy
stock.finance.sina.com /usstock/api/jsonp_v2.php/x/US_MinKService.getDailyK ?symbol=spy
web.ifzq.gtimg.cn      /appstock/app/fqkline/get ?param=us.INX,day,,,260,qfq
hq.sinajs.cn           /list=gb_vgk
stock.finance.sina.com … ?symbol=vgk
hq.sinajs.cn           /list=gb_ewj
stock.finance.sina.com … ?symbol=ewj
vip.stock.finance.sina.com.cn /quotes_service/api/json_v2.php/Market_Center.getHQNodeData ?page=1&num=100&sort=symbol&asc=1&node=etf_hq_fund
web.ifzq.gtimg.cn      /appstock/app/fqkline/get ?param=sh510300,day,,,260,qfq
web.ifzq.gtimg.cn      /appstock/app/fqkline/get ?param=sh000300,day,,,260,qfq
hq.sinajs.cn           /list=gb_eem
stock.finance.sina.com … ?symbol=eem
vip.stock.finance.sina.com.cn …/MoneyFlow.ssl_qsfx_zjlrqs ?page=1&num=20&sort=opendate&asc=0&daima=sh510300
```

> 冷启动 **14 次**（第一次实现时是 **17 次** —— 欧/日/新兴的"规模序列"与"动量序列"是同一条 ETF 日线，
> 缓存键带了用途 ⇒ 同一份 500 KB 日线被拉两遍；改成按 **(来源, 符号)** 建键后降到 14）。

### 3.4 实测样例（2026-10-12 21:07，真网络）

```
=== 冷启动：上游请求 = 14 ，耗时 1650 ms
=== 热命中（TTL 内再取一次）：上游请求 = 0
=== source=snapshot（回放）：上游请求 = 0
=== 载荷：JSON 大小 = 52371 B ；曲线点 = 180 ；回放日 = 30
=== 快照文件： $DSH_HOME/dsh-tradewatcher/global-flow.json 1930 B / 1 天
   美股    规模=8222.73 亿美元  份额=89.17%  5日=0.20pp   动量 2.0%/3.7%/9.9%    排名=1
   欧股    规模=292.19 亿美元   份额=3.17%   5日=-0.02pp  动量 -4.4%/-3.1%/-3.2% 排名=4
   日股    规模=238.09 亿美元   份额=2.58%   5日=-0.04pp  动量 -0.7%/6.5%/9.5%   排名=1
   A股     规模=1063.50 亿元    份额=1.72%   5日=-0.03pp  动量 -5.7%/-10.3%/-7.7% 排名=5
   新兴市场 规模=309.62 亿美元   份额=3.36%   5日=-0.11pp  动量 -1.5%/4.1%/5.7%   排名=3
=== 轮动： 从 新兴市场 转向 美股（5 日份额 -0.11pp → +0.20pp）
=== 合计： 9221.51 亿美元；汇率 6.6937（A股 1063.50 亿元 ÷ 6.6937 = 158.87 亿美元）
=== A股净流入（单列）： 15.56 亿元 / 20 个交易日
=== missing： []
```

（美股与日股并列排名 1：综合名次均值都是 1.67 —— 排名口径对并列取"最靠前"，所以两家都显示 1/5。）

---

## 4. 缓存 / 去重 / 快照（沿用 `AUDIT-CACHE-1/-2` 的规矩）

| 层 | 键 | TTL | 说明 |
| --- | --- | --- | --- |
| 规模（gb/ETF 节点） | `aum:gb:<市场>` / `aum:etf:<市场>` | **30 分钟** | 规模是日级量，日内只随价格漂移 |
| 汇率 | `fx:usdcny` | 30 分钟 | |
| 资金流 | `netflow:sh510300` | 30 分钟 | 失败 ⇒ 记日志 + 该栏"未取到"（不进负缓存） |
| 日线 | `series:<来源>:<符号>` | **12 小时** | 按 (来源, 符号) 建键 ⇒ 规模/动量共用同一份（§3.3 的 17→14） |
| 最终载荷 | `payload:auto` | 10 分钟（**有缺项时 2 分钟**） | 有缺项缩短 TTL ⇒ 恢复能很快被看见 |
| 快照文件 | `global-flow.json` | —— | 一天一条、保留 90 天、原子写（`writeJsonAtomic`）、≥5 分钟节流、**全缺不写** |

**去重规矩**：`cached()` 与载荷装配各有一层"在飞合并" ⇒ **并发两次同请求上游只打一遍**（断言 ⑤ 实测：并发 2 次 = 14 次，
去掉合并 = 28 次）。**失败不进缓存**（与 K 线的"失败也进负缓存"不同：这是低频日级数据，重试成本远低于把一次抖动锁 10 分钟）。
**熔断/退避规矩照旧**：本模块只走腾讯/新浪（按用户要求不走东财 `push2*`），不新增裸 `fetch` 到东财；
上游主机与既有兜底源一致（`web.ifzq.gtimg.cn` / `hq.sinajs.cn` / `vip.stock.finance.sina.com.cn` / `stock.finance.sina.com.cn`）。

**数据量测算（用户要求"先评估、量小就大幅延长缓存"）**：快照实测 **1930 B/天** ⇒ 90 天 ≈ **170 KB**；
载荷 52 KB（180 点曲线 + 30 日回放窗口）。⇒ 采用上面的长 TTL，页面打开一次通常只付 **0–4 次**上游（TTL 内 0 次）。

---

## 5. 断言清单（任务点名的六项，逐条锚真实实现）

| # | 断言 | 位置 | 抓什么 |
| --- | --- | --- | --- |
| ① | 份额合计 = 100%（±0.1 显示位）：五市场全有值时、**以及有市场缺值时**；曲线里**每一天**都成立 | `globalFlow.test.ts:227` | 分母写错、把缺失当 0、归一化被改坏 |
| ② | 某市场取数失败 ⇒ 该行「未取到」+ 原因（行下说明），其余四行照常，**整表不出现 0**（含客户端渲染层） | `globalFlow.test.ts:262`、`globalFlowView.test.ts:123` | 用 0/空串顶替、缺数据整行消失、原因丢失 |
| ③ | 轮动：有轮动 = `从 X 转向 Y`；**无轮动 = 等价写法**（"未见明确轮动"，且不出现"转向"）；判不了 = 第三种 | `globalFlow.test.ts:300`、`:321` | 无轮动时硬凑一个"从 X 转向 Y" |
| ④ | A股净流入不参与份额计算：**只改净流入** ⇒ 份额与规模逐项不变（并证明净流入确实变了） | `globalFlow.test.ts:335` | 把流量混进存量加权 |
| ⑤ | 并发 2 次同请求 ⇒ 上游只打 1 遍；TTL 内再取 = 0 次 | `globalFlow.test.ts:365` | 在飞合并被摘掉 |
| ⑥ | `source=snapshot` 与 30 日回放**零上游请求**（含路由层与客户端换帧）；坏参数 ⇒ 400 | `globalFlow.test.ts:396` | 回放偷偷回源 |
| 口径 | 汇率取不到 ⇒ A股 不折算、不进美元合计、如实标注；快照一天一条 / 保留 90 天；前向填充；曲线锚定实测；动量样本不足 ⇒ null | `globalFlow.test.ts:455`–`:558` | 静默混算币种、快照无界、插值造假 |
| 视图 | 格式化缺数据一律 `未取到`/`—`；五块渲染齐全；缺市场的饼图说明 + 脚注合计；回放换帧；取数失败给原文原因 | `globalFlowView.test.ts:88`–`:170`（5 条） | 页面自己造数/吞掉原因 |

---

## 6. 反例注入证据（关掉行为 ⇒ 断言必须失败；贴证据后已恢复）

脚本 `/tmp/cake-probe/inject.py`（不进仓库）。每条都是**真改工作区源码** → 跑对应测试文件 → 记录 exit code 与首条失败断言 →
立刻还原并校验 sha256（`sha256sum -c` 通过）。**注入期间只跑测试、不构建** ⇒ 用户运行中的实例不受影响。

| # | 注入（关掉什么） | 文件 | 结果 | 首条失败断言 |
| --- | --- | --- | --- | --- |
| ① | 份额归一化改坏（`v/total` 后再 ×1.01） | `globalFlow.ts` | exit=1 | `份额 = 自身 ÷ 有值之和` |
| ② | 缺数据的市场渲染成 `0.00%`（视图层把 `null` 换成 0） | `globalFlowView.ts` | exit=1 | `欧股行必须是「未取到」：["欧股","VGK","未取到","0.00%",…]` |
| ③ | 轮动判定失效（永远给"从 X 转向 Y"） | `globalFlow.ts` | exit=1 | `两端完全相同 ⇒ 必须是"未见明确轮动"` |
| ④ | 把 A股净流入混进 A股规模（进分母） | `globalFlow.ts` | exit=1 | `净流入变化不许影响任何份额` |
| ⑤ | 摘掉在飞合并 | `globalFlow.ts` | exit=1 | `并发 2 次必须只打一遍上游（单次冷启动 = 14，实际 28）` |
| ⑥ | 快照模式改成也回源 | `globalFlow.ts` | exit=1 | `source=snapshot 不许发任何上游请求（实际发了 14）` |

汇总（原始输出 `/tmp/cake-probe/inject/*.log`）：

```
=== 汇总（每条都必须 exit!=0）
  ✅ ① 份额归一化被改坏（除以 total 后再乘 1.01） → exit=1｜份额 = 自身 ÷ 有值之和
  ✅ ② 缺数据的市场用 0 顶替（视图层把 null 渲染成 0.00%） → exit=1｜欧股行必须是「未取到」：["欧股","VGK","未取到","0.00%",…]
  ✅ ③ 轮动判定失效：永远给"从 X 转向 Y"（无轮动也硬凑） → exit=1｜两端完全相同 ⇒ 必须是"未见明确轮动"
  ✅ ④ 把 A股净流入混进 A股规模（参与份额分母） → exit=1｜净流入变化不许影响任何份额
  ✅ ⑤ 去掉在飞合并（并发 2 次 ⇒ 上游打 2 遍） → exit=1｜并发 2 次必须只打一遍上游（单次冷启动 = 14，实际 28）
  ✅ ⑥ 快照模式也去回源（source=snapshot 不再零上游） → exit=1｜source=snapshot 不许发任何上游请求（实际发了 14）
恢复校验：全部文件 sha256 与注入前一致
```

另有**测试内自带**的两层注入（不依赖上面的脚本）：
- `toolsPage.test.ts`：6 条"关掉渲染"的注入（含新增的 delta 不渲染、回放滑块改成 `hidden` 两条）必须让接线检查非空；
- `toolRegistry.test.ts`：结构先行工具（无 loader）走 `PENDING_WHY`、有数据时数值只来自数据 —— 两条各自独立成例。

---

## 7. `npm run check`

```
EXIT=0
ℹ tests 515 / ℹ pass 515 / ℹ fail 0        （默认时区）
ℹ tests 515 / ℹ pass 515 / ℹ fail 0        （TZ=UTC）
ALL HOST CHECKS PASSED (live probes soft)
```

末尾三行（`/tmp/cake-probe/check.log`，非空行）：

```
> dsh-tradewatcher@0.71.0 build
> node build.mjs
built lib/index.js + lib/client.js （v0.71.0，客户端片段校验通过：73 项）
```

- 基线 **494/时区** ⇒ 本批 **515/时区**（+21：`globalFlow.test.ts` 14、`globalFlowView.test.ts` 5、注册表 2）。
- `build.mjs` **零改动** ⇒ 片段校验仍是 73 项（本批新增 UI 文案不依赖那份锁表）。
- 两条 `WARN(soft)` 都是**既有**的（上游当时不可用；`100.FTSE/GDAXI/N225` 在 v0.71.0 起如实没有兜底源），与本批无关。
- 产物核对（`lib/client.js` 里真的出现这批新片段）：`五市场蛋糕` / `规模榜首` / `近五日轮动` / `横截面排名` / `宽基标的` /
  `回放最近三十个交易日` / `A股净流入（单列` / `曲线下方的圆点 = 实测日` / `未取到` —— 9/9 命中；
  宿主产物 `lib/index.js` 里 `/tradewatcher/tools/global-flow`、`global-flow.json`、`静态饼图（无动画）`、`新浪 fx_susdcny` 均命中。
- ⚠ 本批**在工作区执行了构建**（`npm run check` 含 build）⇒ 运行中的 `dsh web` 会热重载宿主/客户端产物
  —— 这是有意的（功能要生效），但按 `AUDIT-IMPL44` §3 的教训记一笔：**构建前工作区必须处于完整状态**。
  本次构建时的状态 = 全绿（§7 的读数就是那一次）。

---

## 8. 未做项 / 诚实披露（不许读成"已完成"）

### 8.1 ⚠ 工具箱行在**运行中的实例**里没有装载（需要 Lead 安排一次重启）

```
$ curl -s -H 'Host: 127.0.0.1:3080' http://127.0.0.1:3080/tradewatcher/rows
{"rows":["core","calendar","watchlist","portfolio","market","cloudmap"],"asOf":1791810549392}
$ curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: 127.0.0.1:3080' 'http://127.0.0.1:3080/tradewatcher/tools/global-flow'
404
```

- 服务进程 `dsh web`（PID 330607）**16:47:31 启动**；第 7 行 `tradewatcher-tools` 是 **20:46 提交**的 ⇒
  该实例的装载点里没有这一行（宿主行只在**启动时**按 manifest 装载；**刷新页面不够**，`cordis.patch.yml` 的注释里也写着这句）。
- 我这边的代码与产物都是对的：`/tradewatcher/health` = 200（插件在跑）、产物片段核对通过（§7）、
  `src/index.test.ts` 里"开 tools 行 ⇒ 路由注册、关掉 ⇒ 不注册"的断言全绿。
- **按硬约束我没有重启服务**。⇒ 要让用户看到「工具」页签与五市场蛋糕，需要 **Lead 安排一次 `dsh web` 重启**（或等价的重载动作）。
  重启前这批能力**不会出现在界面上**（路由 404、页签不渲染，都是"行未激活"的预期行为，不是 bug）。

### 8.2 其它未做项

| 项 | 说明 |
| --- | --- |
| 浏览器实机验证 | 约束是"不装 bundle、不动 profile、不重启 `dsh web`" ⇒ **没有**肉眼确认页面渲染。替代证据：模型层断言（14+5 条）+ 源码接线断言（6 条注入）+ 产物片段核对。像素/样式级问题抓不到（本批不改样式表） |
| 每回放日的动量/排名 | 回放历史日时动量与排名显示"不适用（回放日）"（上游只保留当下的横截面；逐日重算会把载荷再撑大 3 成）。这是**有意的取舍**，写在市场表口径行里 |
| 曲线的"申赎" | 180 日曲线是 `当前实测规模 × 收盘价之比` 的重建（份额数量视为不变）⇒ 反映价格驱动的相对规模变化，**不反映申赎/份额变动**。只有实测日（快照）是真正的观测。要反映申赎需要"逐日份额数量"的历史，公开源没有 |
| 汇率只有现价 | `fx_susdcny` 只有当下值，因此历史日的 A股规模用的是**当日无汇率**（重建按"当前美元规模 × 收盘价之比"，等价于假定汇率不变）。这条也写在曲线口径行里 |
| 美股以外的"成交量"字段 | 本次只用到规模与收盘价；新浪日线里的 `v/a` 没有消费 |
| 快照向前累积 | 快照从本功能上线当天开始累积（一天一条）。**第一天的曲线里"实测日"只有 1 天**，其余 179 天是重建日 —— 这是数据来源的硬边界，不是缺陷 |
| 分类标签行 | 仍是「全部」一个（沿用 v0.71.0 的决定；条目 `category` 已落库为 `flow`） |
| 版本号 / CHANGELOG / README | 未动（避免抢发布动作；发布时建议由 Lead 统一升版本并按 §1 的清单写 CHANGELOG） |

### 8.3 本轮的一次返工（如实记录）

首次实现把"规模序列"与"动量序列"分别建缓存键 ⇒ 同一条 ETF 日线被拉两遍（冷启动 17 次请求）。
是 §3.3 的**真网络请求清单**发现的（单元断言全绿也看不出来）。改成按 (来源, 符号) 建键 ⇒ 14 次，并补进断言 ⑤ 的"冷启动请求数"基准里。
这正是 `AUDIT-CACHE-1/-2` 那条教训的同一形态：**只有数上游请求才能发现重复拉取**。
