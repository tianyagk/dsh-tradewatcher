# AUDIT-LEVERAGE-HOST —— 【杠杆温度计】宿主侧实现与断言

> **文件名说明**：本报告原名 `AUDIT-IMPL89.md`（任务书原写 `AUDIT-IMPL80`，但 `AUDIT-IMPL80` … `AUDIT-IMPL88` 已被历史批次占满）。**Lead 决定改用描述式名字**（编号已被占满，避免再撞）：宿主侧 = **`AUDIT-LEVERAGE-HOST.md`**（本文件），客户端那一路 = `AUDIT-LEVERAGE-UI.md`。
> 改名**未覆盖任何既有审计文档**；正文内容除本段与 §7.1 外未变。
> 基准 HEAD：`3bed7be`（v0.115.0）。实测时间：2026-10-20 19:21–20:0x（Asia/Shanghai）。

**一行结论**：宿主侧按冻结契约实现完毕 —— `GET /tradewatcher/leverage?range=250|750|all` **永远 200**、缺数据一律 `null`；
温度 = `RZYEZB`（融资余额 ÷ 全市场股票流通市值）的**全历史（4018 交易日 / 2010-03-31 起）扩张窗口分位**，实测 **90.4**；
历史回填 **7 个上游请求**（1 次当日 + 6 页）得到 **4018 行 / 610 KB**，之后**每自然日最多 1 次**（实测连续回包 0 次额外请求）；
八条断言全部带反例注入（`npm run check` 两轮全绿 + 构建 73 项通过，见 §6）。

---

## §1 契约实现情况（字段名逐字，**未改名、未增字段**）

`GET /tradewatcher/leverage?range=250|750|all`（默认 750）→ 永远 `200`：

| 契约字段 | 实现 | 来源 / 口径 |
|---|---|---|
| `asOf` | `YYYY-MM-DD` | 最新一行的**数据日**（两融 T+1 ⇒ 实测 `2026-10-19`，不是"今天"）。**无任何数据时是空串 `''`**（契约写的是字符串，用 `''` 而不是 `null`，客户端 `.slice()/格式化` 不会崩 —— 这条超出契约字面，已在代码注释与 §5 写明） |
| `temperature` | 全历史分位 0–100，**1 位小数** | `RZYEZB` 当前值在**全样本**里的百分位（`≤` 计数 ÷ 样本数 × 100）；样本 < `LEVERAGE_MIN_SAMPLES = 250` ⇒ `null`（**不是 0**） |
| `ratioPct` | `RZYEZB` 原值（%）2 位小数 | 上游直接给；4018 行全部满足 `RZYE/LTSZ×100`（已在 `docs/PROBE-LEVERAGE.md` 验算） |
| `ratioWithShortPct` | `(RZYE+RQYE)/LTSZ×100` 2 位小数 | 三者缺一 ⇒ `null`（不拿 0 补） |
| `marginBalance` / `shortBalance` / `floatMv` / `netBuy` | 元 | `RZYE` / `RQYE` / `LTSZ` / `RZJME` |
| `thresholds` | 常量 `{p80:80, p95:95}` | 图上两条线（分位口径） |
| `dates` / `temp` / `ratio` / `net` | 升序，长度 = 窗口 | `all` ⇒ 4018 天；`250`/`750` ⇒ 最近 N 天；`temp[i]` 用**扩张窗口**（无前视），最后一点恒等于 `temperature` |

**契约之外的三条约定**（不涉及字段名，供客户端与后续维护知悉）：

1. **`range` 非法 ⇒ 回落 750，不 400**：它是画图参数，不是用户输入错误（`parseLeverageRange`）。
2. **交叉校验不进回包**：深交所单市读数只落盘到 `cross`（`docs/PROBE-LEVERAGE.md` 已说明"深交所=深市、东财=沪深北"，**不能等值比对**；这里只校验"深市 >0、小于合计、占 30–70%"这一条量级关系）。
3. **唯一非 200 是既有围栏**：`needGate`（trustedHosts 校验）失败仍是 403 —— 那是全站一致的鉴权行为，不是数据路径。

---

## §2 取数、落盘、分位

### 2.1 取数（新文件 `src/host/leverage.ts`）

- 上游：`datacenter-web.eastmoney.com` 的 `RPTA_RZRQ_LSHJ`，列 `DIM_DATE,RZYE,RQYE,RZJME,LTSZ,RZYEZB`，走既有 `withHostBreaker`（同一台主机与 `marketExtras.marginFromEm` 共用熔断器）。
- **实测**：`pageSize=800` ⇒ `pages=6`（4018 行）；顺序用 `sortColumns=DIM_DATE&sortTypes=1`（升序回填），"取当日"用 `sortTypes=-1&pageSize=1`（1 行）。
- **每天最多 1 次**：`needsDailyFetch(state, today, now)` —— `lastFetchDay === 今天` 就不再打上游；唯一例外是"今天那次拉取发生在披露窗口（`09:30`）之前、现在已过窗口、且库里最新一日仍落后于上一工作日"（早拉早了，补一次）。失败也记 `lastFetchDay`（两融一天只更新一次，反复重试的收益低于烧上游预算）。
- **跨实例**：`LeverageStore.syncFromDisk()` 按 **mtime** 判断"别的实例/进程写过没有"，变了才重读（`dsh web` 里 `index.ts` 有两个注册点，各持一份 store）。

### 2.2 落盘（`<DSH_HOME>/dsh-tradewatcher/leverage.json`）

行 = `{d,rzye,rqye,ltsz,rzyezb,rzjme}`（`null` = 上游没给，**不是 0**）。

- **读**：`ReadGuard` —— `ENOENT` 才算"本来就没有"；其它 errno ⇒ 记封锁 + **拒绝写回**（不拿空库覆写）；坏 JSON/形状不认识 ⇒ `quarantineFile` 隔离原件再重建。
- **写**：`updateJsonLocked` —— 锁内读磁盘最新 → 按 `d` 去重合并（同日以后写的为准）→ 升序 → 裁剪 → 原子写回。
- **体积**：实测 4018 行 = **610 KB**（`writeJsonAtomic` 的 1 空格缩进口径；紧凑序列化是 459 KB）。上限 `LEVERAGE_MAX_ROWS = 4500`、`LEVERAGE_MAX_BYTES = 1 MB`。
  > 说明：任务书的"≈400 KB 量级"是按紧凑 JSON 估的；落盘用的是既有 `atomic.ts:31` 的 1 空格缩进（**不能改** —— `updateJsonLocked` 内部固定），所以真实字节 ×1.3。行数上限才是增长闸（按日只增 1 行，≈17 年后才丢最旧的）。

### 2.3 分位（`expandingPercentiles`）

- 定义：`≤ current` 的样本数 ÷ 样本数 × 100，`Math.round(x*10)/10`（1 位小数），与 `host/breadth.ts` 的 `percentileOf` 同口径。
- 扩张窗口：第 i 天只用 `values[0..i]`（无前视），样本 < 250 ⇒ `null`。最后一点的全样本分位与扩张窗口分位**恒等**（所以 `temperature` 两种算法一致）。
- 复杂度：有序插入 + 二分（n≈4018，实测整条序列 < 10 ms；实测首包到完整回包 1.07 s 含 7 次网络请求）。

---

## §3 实测读数（2026-10-20 20:0x，DSH_HOME=/tmp/lev-live）

```
第一次回包（历史为空）: {"asOf":"2026-10-19","temperature":null,"ratioPct":2.65,"rowsOnChart":1}
回填: leverage backfilled 4018 rows (pages=6)
请求构成: ["desc:1/1","asc:1/800","asc:2/800","asc:3/800","asc:4/800","asc:5/800","asc:6/800"]   ← 共 7 次
第二次回包: {"asOf":"2026-10-19","temperature":90.4,"ratioPct":2.65,"ratioWithShortPct":2.69,
            "marginBalance":2453374239917,"shortBalance":29167627323,
            "floatMv":92416865855823.7,"netBuy":-6331355686,"days":4018,"lastTemp":90.4}
再打两次回包的额外上游请求: 0
落盘字节: 624408（610 KB）
首行: {"d":"2010-03-31","rzye":6495609,...,"rzyezb":0.000041}
末行: {"d":"2026-10-19","rzye":2453374239917,...,"rzyezb":2.654682}
cross: {"d":"2026-10-19","szseRzye":11864.48,"emRzye":24533.74,"sharePct":48.36,"ok":true}
```

- `temperature = 90.4` 与 `docs/PROBE-LEVERAGE.md` 独立算出的全历史分位 **90.4%** 一致（那条路径是脚本直接拉 6 页算的，与实现互不依赖）。
- `ratioWithShortPct = 2.69`（上游 2.6862% 的 2 位小数）。
- `cross.ok = true`：深市 11,864.48 亿 / 合计 24,533.74 亿 = **48.36%**（落在 30–70%）。
- **首包即当日读数**：第一次请求只打 1 次上游（`desc:1/1`），历史在后台 6 页回填 ⇒ 用户不会等 7 个请求。

---

## §4 八条断言 × 反例注入（`src/host/leverage.test.ts`，13 个用例）

| # | 断言 | 反例注入（证明非恒真） |
|---|---|---|
| ① | 字段集合 = 契约 13 个键；`dates/temp/ratio/net` 等长；`dates` 升序；`thresholds` 常量；小数位 | 少了/多了字段、数组不等长、乱序都会被 `leveragePayloadProblems` 报出（该判据本身在 ①③⑥ 三处复用，且用例里对它做了正反两种输入） |
| ② | `temperature` = **全历史**分位，1 位小数，且 `temp[]` 末点恒等 | 构造 200×3.0 + 99×1.0 + 今天 2.0 的样本：全历史 = **33.3**，近 250 天 = **40.0** ⇒ 换成"近 N 天"必被打死（`assert.notEqual`） |
| ③ | 样本 < 250 ⇒ `temperature: null`；恰 250 ⇒ 必须给数 | 把 `null` 换成 `0` ⇒ `leveragePayloadProblems` 立刻报"样本不足时必须是 null" |
| ④ | 每天最多 1 次上游 | 同一实例连打 **5 次** ⇒ 上游 `desc` 调用 = **1**；`dailyFetchProblems(5)` 报错（注入"每次请求都打上游"）；两个 store 共享同一文件也仍是 1 次；反证：换一天 `needsDailyFetch` 必须为 `true` |
| ⑤ | 缺字段 ⇒ `null` | 造一行 `RZYE/RQYE/LTSZ/RZJME/RZYEZB` 全缺 ⇒ 6 个字段全 `null`；注入 `?? 0` 版本 ⇒ `nullFieldProblems` 报错；另有**源码判据**：`leverage.ts` 里不许出现 `?? 0` |
| ⑥ | 路由永远 200 | 注入"上游抛错"的 fetch ⇒ 200 + 全 null 空壳；再注入"service 直接 reject" ⇒ 路由仍 200（service 自己抛错的路径也被覆盖） |
| ⑦ | 落盘走锁且幂等 | 静态源判据（`updateJsonLocked` / 禁 `writeFile`・`writeJsonAtomic` / `assertWritable` / `ReadGuard` / `quarantineFile`）＋ 三种注入（绕锁、直接 writeFile、去掉 assertWritable）都必败；行为：同批写两次 `added=0` 且**字节完全一致**；两个 store 并发写不同日期 ⇒ 两条都在（锁内合并）；同日两次写 ⇒ 只留一行以后写的为准 |
| ⑦b | 体积上限丢最旧、留痕、最新一行不丢 | 极小上限（1200 B）⇒ `dropped > 0` 且文件 ≤ 上限；真实上限下 4018 行完整落盘且 ≤ 1 MB |
| ⑦c | 读不到 ≠ 没有 | 坏 JSON ⇒ 隔离原件（`*.corrupt-*`）后仍可重建 |
| ⑧ | `range` 切片 | 800 行样本：`all`=800、`750`=750、`250`=250 且起点是**最近** 250 天；注入"all 只给 750" ⇒ `rangeSliceProblems` 必败；`?range=abc|99999|空` 一律回落 750 |

补充：`temp[]` 前 249 天必须是 `null`（扩张窗口样本不足），第 250 天起才有值 —— 与 ③ 同一口径的曲线侧证明。

---

## §5 路由归属同步（按任务书 §2.2：单一消费者 = `ToolsPage`）

`/tradewatcher/leverage` 的唯一消费链是 `ToolsPage.tsx` → `leveragePage.tsx` → `api.leverage(range)`（客户端那一路），因此归 **`tools`** 行。四处镜像已同步：

| 位置 | 改动 |
|---|---|
| `src/index.ts`（唯一事实源） | `ROW_ROUTES.tools` += `/tradewatcher/leverage`（含判据注释） |
| `src/index.test.ts` | `FUNCTION_OWNED_PATHS` += 该路径；`ROW_ROUTES_FOR_TEST.tools` += 该路径；`tools.routes` 的精确列表断言与"只准注册自己的前缀"断言同步（后者改为"除前缀外只准有已宣告的这一条"） |
| `docs/DESIGN-SUBPLUGINS.md` | §2.1 `tools` 行的路由栏 + 理由；§2.2 调用方表新增一行；**路由账 29 → 30**（两处：§1 摘要与文末「归因纠正与恢复记录」） |
| `cordis.patch.yml` | `tradewatcher-tools` 行注释 += 该路由 |

**路由账新数字（实测，不是手算）**：`makeTradeRoutes(...).routes.length = 30`；行独占 = 15 ⇒ **30 = core 15 + calendar 1 + watchlist 3 + portfolio 2 + market 4 + cloudmap 0 + tools 2 + fupan 3**。
`src/rowOwnership.test.ts` 的"按调用点推导"用例也通过（`/tradewatcher/leverage` 的实测消费行 = `tools`，恰好等于声明行）。

---

## §6 门禁结果（`npm run check` 两轮全绿 + 构建 73 项）

```
# 基线（改动前，HEAD 3bed7be）
ℹ tests 961 / pass 961 / fail 0     ×2 轮（本地时区 + TZ=UTC）
ALL HOST CHECKS PASSED (live probes soft)
built lib/index.js + lib/client.js （v0.115.0，客户端片段校验通过：73 项）

# 改动后（本报告 §8 的 9 个文件）
ℹ tests 983 / pass 983 / fail 0     ×2 轮（本地时区 + TZ=UTC）
ALL HOST CHECKS PASSED (live probes soft)
built lib/index.js + lib/client.js （v0.115.0，客户端片段校验通过：73 项）
```

- 983 = 961（基线）+ **13**（`src/host/leverage.test.ts`，本批宿主侧）+ 9（客户端那一路的工具页用例）。
- `npm run check` = `typecheck → test（两轮）→ selftest（真机探针 soft）→ build（含 73 项客户端片段校验）`；**`build.mjs` 未改动**。
- 日志：`/tmp/lev-check3.log`（首轮）、`/tmp/lev-check4.log`（复核轮）。
- 中途出现过一次红：`src/client/uiuxDiscipline.test.ts` ⑥ 要求 README 的「数据文件」表覆盖 `src/host/**` 里出现的每个 `.json` ⇒ 补了 `leverage.json` 一行（见 §8 的改动清单；这是宿主新增落盘文件的必然要求，不是客户端的活）。

---

## §7 未做项 / 已知限制（如实）

1. **未改 `src/client/**`**（按分工由另一路负责）：`api.leverage`、`LeveragePayloadDto`、`ToolsPage` 的杠杆详情页均不在本报告范围内；宿主侧只保证契约字段与"永远 200"。
2. **未改 `build.mjs`**（构建期 73 项片段校验未动）。
3. **`asOf` 用空串而不是 `null`**：契约写的是 `'YYYY-MM-DD'`；整块不可用时用 `''`，客户端判 `asOf === ''` 即可。若客户端希望 `null`，改一行（`buildLeveragePayload` / `emptyLeveragePayload`）即可 —— 需要客户端那一路同步改类型。
4. **两融披露时刻只有一个实测点**（10-20 19:21 时最新仍是 10-19）⇒ 披露窗口常量取 `09:30`（次日早间）。若将来实测发现是"当日夜间"，把 `LEVERAGE_DISCLOSE_HHMM` 调一下即可（只影响"早拉早了补一次"这一条分支）。
5. **分位跨越两次制度断点** —— 这条按 Lead 要求**只留档、不进 UI**（用户明确要求界面不写口径），详见下方 **§7.1**。
6. **`cross` 只做量级校验**：深交所=深市、东财=沪深北，两者不可等值比对；`sharePct` 只是"深市份额"的合理性指标，不写进回包、不当数据质量结论。
7. **`LTSZ` 含 B 股与北交所**（交易所"股票"口径）：显性融资比例因此略被低估约 0.1%（口径已在 probe 报告与代码注释写明）。
8. **深市单市净买入不可得**：深交所报表没有"融资偿还额"字段，深市净买入只能用余额差推（每天两请求）；本实现不提供，净买入一律取东财 `RZJME`。

### §7.1 「全历史分位」跨越的两个制度断点（本档留存 · **UI 不写**）

用户明确要求：**杠杆温度计页面上唯一的说明文字只有「截至 YYYY-MM-DD」，不写口径**。因此下面这些口径事实**不进界面**，只留在本档，供日后复核"为什么 90.4 这个数在 2014 年前后不可比"时有据可查。

| 断点 | 生效日 | 事实来源（实测原文） | 对 `RZYEZB` 与分位的影响 |
|---|---|---|---|
| **① 两融总量并入"调出标的"** | **2014-09-22** | 深交所「融资融券交易总量」报表 `metadata.footer` 原话：`2014年9月22日起，"融资融券交易总量"数据包含调出标的证券名单的证券的融资融券余额。` | 同一口径扩容：分子（融资余额）在此之前**不含**被调出标的的存量 ⇒ 2014-09-22 之前的历史读数系统性偏低，**越早越偏低**。后果是**历史分布整体被压低** ⇒ 今天的百分位**略偏高**（温度可能比严格口径略偏热）。方向已知、**幅度不可量化**（上游只给总量，不给"调出标的余额"分项） |
| **② 北交所并入沪深合计** | **2023 年**（北交所两融业务自 2023 年起才有数据；东财分市场报表 `SCDM=002` 的样本仅 **892** 个交易日，而沪/深各 **4018** 个） | `RPTA_WEB_RZRQ_LSSH` `filter=(SCDM=002)` 实测 `pages=892`，与沪深 4018 不一致 | 合计报表 = 沪 + 深 + 京 **精确相加**（本报告 §3 已验算）；2023 年前合计里没有北交所的存量。北交所体量极小（2026-10-19：融资余额 78.77 亿 vs 合计 24,533.74 亿 = **0.32%**）⇒ 对分位的影响可忽略，但**口径确实变过一次** |

**怎么用这两条（给日后的维护者）**：

- **不要**据此给温度加"断点校正"：校正需要假设"调出标的的存量是多少"，而公开数据里没有这个数（深交所只给总量，不给调出名单的余额）⇒ 任何校正都是**编数**，比"承认它是原始口径"更糟。
- **也考虑过**把窗口改成"2014-09-22 之后"或"近 3 年"来回避断点 —— **否决**：近 3 年只有 725 个样本，同一现值 2.655% 的分位会从 **90.4**（全历史 4018）变成 **90.2**（近 3 年），而 P95 从 **2.974%** 掉到 **2.747%**（相差 0.23 个百分点）⇒ 阈值线会跟着漂，图上"80/95"两条线的含义就不可跨版本比较了。
- **取全历史的理由**：温度是一个"相对自身历史的位置"指标，样本越长越稳。断点带来的偏差**方向已知**（早期读数偏低 ⇒ 今天的分位略偏高 ≈ 温度略偏热），但**幅度不可量化**。我们选择"接受这个已知偏差 + 留档"，而不是用一个没有数据支撑的系数去"校正"它 —— 后者会让读数看起来更精确，实际上只是把假设藏进了数字里。
- 若将来真要做严格口径，唯一诚实的做法是**换数据源**（交易所发布的"两融标的余额"分项，本仓库目前没有这条路），而不是在现有序列上做调整。

---

## §8 复现入口

```bash
# 单测（隔离 DSH_HOME，绝不碰 ~/.dsh）
DSH_HOME=$(mktemp -d) node --test --experimental-strip-types src/host/leverage.test.ts
# 归属与镜像
DSH_HOME=$(mktemp -d) node --test --experimental-strip-types src/rowOwnership.test.ts src/index.test.ts
# 实盘冒烟（7 个上游请求：1 当日 + 6 页回填；之后每自然日最多 1 次）
DSH_HOME=/tmp/lev-live node --experimental-strip-types -e "
import('./src/host/leverage.ts').then(async (m) => {
  const s = new m.LeverageService(new m.LeverageStore())
  console.log(await s.payload('750')); await s.startBackfill(); console.log(await s.payload('all'))
})"
# 全量门禁（两轮：本地时区 + TZ=UTC）
npm run check
```

**改动文件清单**（本批宿主侧 + 归属/文案同步）：
`src/host/leverage.ts`（新）、`src/host/leverage.test.ts`（新）、`src/host/routes.ts`（导入 + `makeTradeRoutes` 第 10 个可选参数 + `/tradewatcher/leverage` 路由）、
`src/index.ts`（`ROW_ROUTES.tools`）、`src/index.test.ts`（`FUNCTION_OWNED_PATHS` / 测试副本 / `tools.routes` 两条断言）、
`docs/DESIGN-SUBPLUGINS.md`（§2.1 §2.2 + 路由账 29→30 两处）、`cordis.patch.yml`（`tradewatcher-tools` 行注释）、
`README.md`（「数据文件」表 += `leverage.json`，由 `uiuxDiscipline.test.ts` ⑥ 强制）。
**未改**：`src/client/**`（另一路）、`build.mjs`、`package.json`。
