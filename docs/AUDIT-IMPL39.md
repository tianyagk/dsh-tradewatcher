# AUDIT-IMPL39 —— 大盘组件重构：删查询框 / A股全景→涨跌分布 / 护盘黄块改简洁

- 基线：`main` @ `507c802`（v0.64.1），`npm run check` = 423 × 2 全绿
- 本轮结果：**430 × 2 全绿**（+7 条断言，新建 `src/client/marketRefactor.test.ts`）
- `build.mjs` **零改动**（73 项片段校验通过）；未装 bundle / 未动 profile / 未 commit / 未重启
- 三处都配了**反例注入**（§4）；缺数一律「未取到 + 原因」，**没有编数、没有用 0 顶替**

---

## 1. ① 删除「个股 / 基金查询」UI + 归属复核

### 删了什么

| 项 | 证据 |
|---|---|
| 面板块 `个股 / 基金查询`（标题 + 搜索框 + 内联详情卡 + 下方那句 `点击指数、ETF 行或搜索后显示详情（价格/分时/基础数据）。`） | `grep -n "个股 / 基金查询" src/client/MarketPage.tsx` ⇒ 改前命中，改后 **0 处**（断言守着） |
| `SuggestInput` 的引用 | `grep -n "SuggestInput" src/client/MarketPage.tsx` ⇒ 改前 2 处（import + 使用），改后 **0 处** |
| 随之无用的状态 `detailLoading` / `detailError` | 改后 `grep` 0 处（避免"删了 UI 留下没人用的状态"） |

**详情没有跟着丢**：`DetailModal` 仍在渲染（`MarketPage.tsx` 里 `React.createElement(DetailModal, …)`），
行点击仍走 `openDetail(…)` ⇒ 点指数/ETF 行照旧弹详情。删掉的只是"搜索入口 + 内联那张卡"。

### 归属复核（按 §2.2 判据，逐条 grep）

| 候选 | grep 结论 | 处置 |
|---|---|---|
| `/tradewatcher/suggest`（搜索路由） | 客户端消费者：`PortfolioPage.tsx:728`、`WatchlistPage.tsx:554` **仍在用 `SuggestInput`** ⇒ 不是"只被大盘页消费" | **保留现状（core）**，不重定归属 |
| `tradewatcher_search`（agent 工具） | `src/host/tools.ts` 里 `` name: `${PREFIX}search` `` 仍在，内部调 `em.searchSymbols`（`src/host/em.ts`）⇒ 搜索能力仍被工具消费 | **保留路由与工具**，只删 UI |
| 别的路由/工具是否只被这个 UI 消费 | `api.detail` / `api.trend` 仍被行点击的详情弹窗消费（`openDetail`）；`api.search` 无独立消费者（搜索走 `/suggest`） | 无需要重定归属的项 |

⇒ **`src/index.ts` 的 `ROW_ROUTES` 本轮未动**，`docs/DESIGN-SUBPLUGINS.md` §2.1/§2.2 无需改动（没有归属变化）。

## 2. ② 【A股全景】→【涨跌分布】：**先审计，再实现**

### 2.1 可得性表（逐格结论；"上游无此数据"一律不显示或「未取到 + 原因」）

| 列 | 格子 | 现有路由/字段 | 结论 |
|---|---|---|---|
| 涨跌趋势 | 上涨 / 平盘 / 下跌 | `/breadth` → `current.up/even/down`（指数行情 f104/f105/f106；自统计兜底） | **可得**（已实现，红绿仍走 `dirClass`） |
| 涨跌趋势 | 涨停 / 跌停 | 指数行情**只有涨/跌/平家数**，无涨停/跌停字段；自行判定要按板块（10%/20%/30%）与 ST（5%）规则，需要本插件没取的名字/板块字段 | **未取到 + 原因**（本轮不做，不是 0） |
| 成交量 | 当日成交额 | `/breadth` → `current.amount`（两市，指数 f6 之和） | **可得** |
| 成交量 | 昨日成交 | **本地** `breadth.json` 的上一交易日快照 `amount`（`BreadthDay.amount`，`breadth.history()` 取） | **可得**（本轮新增 `/breadth` 的 `prevAmount` 字段；缺快照 ⇒ 未取到 + 原因） |
| 成交量 | 较昨日变动 | 上面两项相减（口径进 title） | **可得**（派生；任一缺失 ⇒ 未取到，不写 0） |
| 成交量 | 预测全天 | 无上游字段；本插件**没有日内成交额采样，也没有校准基准** | **未取到 + 原因**（"任何预测都是编的"，由 `FORECAST_REASON` 说明） |
| 两融走势 | 两融余额 / 融资净买 | 本插件**未集成两融数据源**（全部路由里没有任何 margin 字段） | **未取到 + 原因**（需新路由 + 新缓存 + 归属，另开） |
| 涨跌分布 | 分档直方图（9 档） | **同一处上游**：东财 clist 分页的 `f3` 涨跌幅（`em.fetchClistPctPage`，每页 100 只、上限 60 页） | **可得**（本轮实现；见 2.2 的成本与边界） |
| 日内家数 | 上涨/下跌家数折线 | 宿主只按**交易日**存快照（`BreadthDay` 每天一条），无日内采样序列 | **未取到 + 原因**（需新增日内采样与存储，另开） |

**红线遵守**：所有"未取到"格子常驻只有三个字（`未取到`），原因进 `title`/`aria-label`（可键盘/触屏读到）；
**没有任何格子用 0 或编造的数值顶替**。

### 2.2 新布局与实现

- **命名**：区块标题 `A股全景` → **`涨跌分布`**（`MarketPage.tsx`）。
- **两列**（`styles.ts` 新增 `.tw-dist-cols/.tw-dist-col/.tw-dist-block/.tw-dist-h/.tw-dist-kv/…`）：
  左列 `涨跌趋势`（上涨/平盘/下跌 + 涨停/跌停未取到）｜`成交量`（当日/昨日/较昨日/预测全天）｜`两融走势`（两行未取到）；
  右列 `涨跌分布` 直方图（柱上标数）｜`日内家数`（未取到）。
- **直方图**（`DistHistogram`，`MarketPage.tsx`）：柱高按最大档归一、柱色按档位（红/灰/绿）、
  柱宽用**百分比**（窄面板不会把某档挤成 0 宽）；`title` 带覆盖数（`覆盖 N 只 / 全市场 M 只；无涨跌幅 X 只未计入任何档`）。
- **分档逻辑**（纯函数 `distributionBinsOf`，`breadthView.ts`）：**对称 9 档**
  `≥7% / 5~7% / 3~5% / 0~3% / 平盘 / -3~0% / -5~-3% / -7~-5% / ≤-7%`；
  **无涨跌幅的行（停牌/上游给 `-`）不计入任何档**，单独记 `blank`（不许当 0 —— 那会凭空多一只平盘）。
- **路由**（`routes.ts`）：`/breadth?dist=1` 才触发扫描；结果 60s 内存缓存；
  页数上限 `BREADTH_PAGES_MAX = 60`；**没扫全 ⇒ `counts: null` + 原因**（绝不拿扫到的那部分冒充全市场），
  并在 `missing[]` 里加一条 `what: '涨跌分布'` 的说明。`(api.ts)` 的 `api.breadth({ dist: true })` 只有大盘页用。
- **`prevAmount`**（新字段）：`{ day, amount, final } | null`，来自本地上一交易日快照；`null` ⇒ 界面「未取到」。
- **没有新增说明性长文案**：可见处只有数字、标签与「未取到」三个字，口径/原因全在 `title`/`aria-label`。

### 2.3 真实上游验证（含当前上游故障的事实）

- **成本与页大小（curl 实测过一次）**：`pz=500` 请求，上游**只回 100 行**（`total: 5562`）⇒ 全市场扫描 ≈ **56 页**，
  与 `BREADTH_PAGES_MAX = 60` 一致（注释里写死了这个账）。
- **本轮收尾时上游整段不可达**（`push2delay.eastmoney.com` / `push2.eastmoney.com` 连接被重置）⇒
  直接跑扫描器：`页数 = 0 / 扫到 = 0 / 失败 = TypeError: fetch failed` ⇒
  按实现返回 `counts: null` + 原因（`第 1 页取数失败（…）⇒ 没有扫全，不给部分分布冒充全市场`）。
  **这正是"未取到 + 原因"要跑的那条路**，且它**没有**把 0 当成"全市场 0 只涨"画出去 ✓。
- **happy path 没能当场观测**（上游故障期间拿不到真实分页）⇒ 报告里如实标注；分档算法用 fixture 逐点断言（§4 ②b），
  等上游恢复后可用 `curl '127.0.0.1:3080/tradewatcher/breadth?dist=1' | jq '.distribution'` 复核。

## 3. ③ 【护盘信号】黄块 → 紧凑标记

- **删**：那条常驻黄色块（`东财行情主机 3/3 台熔断 · 最早约 1 分钟可重试（全部恢复 14 分钟）—— 当前快照已由腾讯备用源兜底：…`）。
- **改**：提取纯函数 `breakerBadgeOf()`（新建 `src/client/rescueView.ts`，与 `badgeView/breadthView` 同一约定），返回
  `{ marker, reason, fromAlt }`：
  - `marker`（**常驻唯一可见**）：备用源兜底 ⇒ `备用源`；否则 ⇒ `熔断 N/M`（都 ≤6 字）；
  - `reason`（完整那句，**一个字没删**）：`${head} —— ${impact}`；
  - 渲染处：`.tw-badge` 元素，`aria-label: badge.reason`、`title: [badge.reason, 熔断明细…, 最后错误…, …].join('\n')`、
    `tabIndex: 0` + `role: 'note'`（键盘/触屏也能读到）✓ **降级事实仍在，只是不再常驻占位**。

## 4. 三处反例证据（`src/client/marketRefactor.test.ts`，7 条）

| # | 断言 | 反例注入（必须失败） |
|---|---|---|
| ① | 常驻无 `个股 / 基金查询` / 搜索占位 / 那句说明 / `SuggestInput`；`DetailModal` 与行点击仍在 | 把 `个股 / 基金查询` 加回常驻 ⇒ 判据非空（`assert.throws` 同款） |
| ① | `/suggest` 仍有 ≥2 个客户端消费者（PortfolioPage / WatchlistPage）+ `tradewatcher_search` 仍用 `searchSymbols`；未塞进 market/watchlist 行 | ——（归属复核，无注入面；用"消费者仍在"正面证明） |
| ②a | 标题 = `涨跌分布`、无 `A股全景`、五个小节标题都在、两列样式真在 `styles.ts` | —— |
| ②b | 分档：9 档各落一档、`null`/`NaN` 记 `blank` **不计入任何档**、边界点（7/5/3/0/-3/-5/-7）归属正确 | 把 `blank` 当平盘 ⇒ 与真实现不同 ⇒ `assert.throws` 证明"blank 不许当 0"必然失败 |
| ②c | 四处未取到原因常量都在且挂在 `title`/`aria`；常驻文本只有 `未取到` 三个字 | 给「预测全天」编一个数（`1.23 万亿`）⇒ `assert.throws` 证明"必须显示未取到"失败 |
| ②d | 路由：`dist=1` 显式开关、`full` 判据、`counts: full ? … : null`、原因文案、页数上限；客户端只在需要时带 `dist=1` | —— |
| ③ | `marker` = `备用源` / `熔断 1/3`（≤6 字）；`reason` 仍含熔断台数 + 最早可重试 + 备用源兜底/超大单；渲染处常驻孩子是 `badge.marker`、`reason` 只在 `aria-label` 与 `title` 里 | 把长句（`badge.reason`）换到常驻孩子位置 ⇒ 判据抓到 `badge.reason` ⇒ `assert.throws` 证明"长句不许常驻"失败 |

（断言锚的是**真源码文本 + 纯函数语义 + 真实回包形状**，不引用本测试自己的常量。）

## 5. 测试条数变化

| | 条数（每时区） |
|---|---|
| 基线 `507c802` | 423 |
| 新建 `src/client/marketRefactor.test.ts` | +7 |
| **本轮之后** | **430** |

```
ℹ tests 430
ℹ pass 430
ℹ fail 0
```

（两次各 430；随后 `ALL HOST CHECKS PASSED (live probes soft)` 与
`built lib/index.js + lib/client.js （v0.64.1，客户端片段校验通过：73 项）`。）
改动文件：`src/client/{MarketPage.tsx,RescuePanel.tsx,rescueView.ts,breadthView.ts,styles.ts,api.ts,marketRefactor.test.ts}`、
`src/host/routes.ts` + 本文件；`build.mjs` / `package.json` / `cordis.patch.yml` **零改动**；
`src/index.ts` **未动**（归属无变化，见 §1）。

## 6. 未做项（都给了"要做得先做什么"）

1. **涨停/跌停家数**：需要按板块与 ST 规则判定的名字/板块字段（如 clist 的 `f12/f13/f14`）⇒ 要扩字段表并写清判定口径；本轮不做（红线：不许拿"涨幅≥9.9%"冒充涨停）。
2. **预测全天成交额**：需要日内成交额采样 + 与收盘值的校准；在没有校准前不做（现状：未取到 + 原因）。
3. **两融走势**：需要新路由（东财 datacenter 融资融券类接口）+ 缓存 + 归属（按 §2.2 判：若只被大盘页消费 ⇒ 归 `market` 行）。本轮**未**新增该路由，故该块显示未取到。
4. **日内上涨/下跌家数折线**：需要新增"日内采样 + 存储"（现在 `breadth.json` 一天一条）⇒ 属于新数据管道，另开。
5. **上游故障期间的 happy path 观测**：见 §2.3（不是没做，是当时拿不到真实分页）。
6. **直方图建议加"按幅度归一/对数"选项**：本轮柱高按最大档线性归一（大档会压扁小档，属实测观感问题，等用户看了再定）。

---

# 追加（v0.69.1）：自选页红框两行常驻提示已删 —— 降级事实降到悬停层

- 基线：`main` @ `6e881db`（v0.69.0），`npm run check` = 476 × 2 全绿
- 本轮结果：**478 × 2 全绿**（+2 条断言，新建 `src/client/watchlistHints.test.ts`）
- `build.mjs` 零改动（73 项）；未 commit / 未装 bundle / 未动 profile / 未重启

## 1. 逐条判定（用户红框两行）

| 红框内容 | 「这话别处有没有」 | 处置 |
|---|---|---|
| `YTD 缺 1 项` | **有**：行内那一格已经显示 `YTD —`（`ytdText()` 的缺失态，见 `ytdView.ts` 及其断言） | **直接删**（含它专用的三个变量与 import） |
| `板块涨跌与 α 本次未取到 · 17:38:06 · 上游暂时不可用（熔断中，约 11 分钟后自动重试）` | **别处看不到原因**：行内只显示 `板块 —` / `α —`，且原来那两格的 tooltip 写的是"**见上方「板块涨跌与 α」一行**"——删掉面板那行后这两处会**变成悬空引用** | 面板整块删；**原因改挂到受影响的两格**（`title` + `aria-label`），事实一个不丢 |

**红线遵守**：降级事实（上游状态、失败时刻、会不会自动重试）全部保留在悬停层，**常驻可见处不再出现**；
**没有新增任何常驻文案**。

## 2. 改动点

| 文件 | 改动 |
|---|---|
| `src/client/WatchlistPage.tsx` | 删面板级「板块涨跌与 α」块（含 `indState.status === 'error'` 的渲染守卫）与「YTD 缺 N 项」块；删随之无用的 `ytdRows`/`ytdMissingCount`/`ytdSummary` 与 `ytdMissingSummary` import；`板块 —` / `α —` 两格的 `title` 与 `aria-label` 改带完整原因（替换"见上方一行"的指路） |
| `src/client/watchlistView.ts`（新） | 纯函数 `indReasonOf({at, error})`：产出那句原因（唯一来源，两格复用） |
| `src/client/watchlistHints.test.ts`（新） | 两行不再渲染 + 事实仍可达，各带反例注入 |

**产出文案（悬停层，两格共用）**：
`板块涨跌与 α 本次未取到 · 17:38:06 · 上游暂时不可用（熔断中，约 11 分钟后自动重试）；下一次行情轮询会自动重试`
（没有时刻时写「时刻未知」；没有原因时给通用词 —— 都不留空）

**顺手修一处时区缺陷**：原来那行常驻文案用**宿主本地时区**格式化时刻 ⇒ 宿主机不在东八区时会显示成别的钟点。
`indReasonOf` 写死 `timeZone: 'Asia/Shanghai'`（与 `marketTime.ts` 同一规矩），**一律北京时间**；
断言里写明这条口径（`TZ=UTC` 下也必须得到 `17:38:06`）。

**没有跟着删的两行（不是红框内容，仍是另一件事）**：
`YTD 本次未取到 · …（已取到的保留上一次结果）`（整条 YTD 请求失败）与 `YTD 单次上限 N 项，超出部分显示 —`（截断说明）
—— 这两条各自说的是"整条失败"和"被上限截断"，与"个别项算不出来"不同，删了会让这两类事实无处可读。

## 3. 断言与反例（+2）

| # | 断言 | 反例注入（必须失败） |
|---|---|---|
| ① | `permanentHintViolations(src)` 为空：两个块各自的渲染守卫/可见模板、三个专用变量、**两处悬空指路**（`见上方「板块涨跌与 α」一行` / `见左侧「板块 —」的说明`）都不许再出现；同时正面确认"另一件事"的两行仍在 | 把面板级那行加回渲染位置（注入 `indState.status === 'error'` 守卫 + 可见模板）⇒ 判据非空 ⇒ `assert.throws` |
| ② | `indReasonOf` 三位事实（`板块涨跌与 α 本次未取到` / 熔断与 11 分钟 / `17:38:06` / `自动重试`）+ 两个兜底分支（「时刻未知」「上游不可用」）；**接线计数**：`${indReasonOf(indState)}` 必须出现 **4 处**（两格 × title+aria） | 去掉 `板块 —` 那格的 `title` ⇒ 计数变 3 ⇒ `assert.throws` 证明"四处都要有"失败 |

## 4. 测试条数变化（含追加）

| | 条数（每时区） |
|---|---|
| 追加前（v0.69.0） | 476 |
| 新建 `watchlistHints.test.ts` | +2 |
| **追加之后** | **478** |

```
ℹ tests 478
ℹ pass 478
ℹ fail 0
```

（两次各 478：默认时区 + `TZ=UTC` —— 第二条断言专门盯时区口径；随后 `ALL HOST CHECKS PASSED (live probes soft)`
与 `built lib/index.js + lib/client.js （v0.69.0，客户端片段校验通过：73 项）`。）

## 5. 未做项

1. **同类"宿主本地时区"写法还有残留**（如 `RescuePanel.tsx` 里 `new Date(ts).toLocaleTimeString('zh-CN', …)` 的多处）——
   本轮只修了 `indReasonOf` 这一处（我改的那行）；其余属于既有代码，建议单开一次"客户端时刻一律北京时间"的收口。
2. **`板块 —` / `α —` 之外的受影响面**：本轮只挂了两格（受影响控件）；若还想让分组头也带提示，
   是另一次改动（现在没有那个需求）。
3. 未做真页面复核：线上宿主仍是旧构建；发布后可在自选页悬停 `板块 —` 一格复核（`title` 应含上游状态与重试说明）。
