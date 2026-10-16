# AUDIT-IMPL63 —— 搭车落盘三项（触发瞬间家数 + 分时点六通道 + 每卡分钟序列）

**一行结论**：三项都落在**同一次采样的既有数据**上（家数取本拍行情里本来就在的指数家数、六通道取同一拍 `etfs`、
每卡序列取采样器**已经在取**的分钟链）⇒ **零新增上游请求**（并对"有没有为它们单独取数"做了 URL 级与结构性断言）；
体积/点数都有上界（分时点条数 120 + 字节 192KB；每卡 ≤242 点、整块 ≤128KB，超出从最旧丢、六卡同步裁）。
`npm run check` 的**类型检查 + 717 测试 × 两时区 + 宿主自检全绿**；注入 **8/8 全抓**；`build.mjs` 未触碰；
未 commit/装/profile/**未重启服务**；隔离 `DSH_HOME=/tmp/rp2-*`（测试内 `mkdtemp`）；**没有手工写 `~/.dsh`**。

> ⚠ **`npm run check` 的构建段失败，但不是本批**：`build.mjs` 要求客户端保留片段
> `'底部位置 / 形态 / 概率'`，而工作区里 `src/client/RescuePanel.tsx`（**另一路的未提交改动**，13:56）
> 把它改成了 `'底部位置 / 形态 / 触发后对照'` ⇒ 片段校验失败。
> 证据：`git diff -- src/client/RescuePanel.tsx` 里那一行是被**删掉**的（HEAD 版本里存在，当前源码 0 命中）；
> 本批改的是 `src/host/rescue.ts`、`src/host/routes.ts`、`src/shared/model.ts`（+ 测试），**没动任何客户端文件**。
> 我没有去动 `build.mjs`（你持有）也没去改他们的文案 —— 这属于两路之间的一致性，请你裁决。

---

## 1｜决策 1：触发瞬间的涨跌家数（搭车落盘）

**做法**：救助事件（`RescueSignalEvent`）写入时带上当时家数，取数优先级（`resolveBreadthMoment`，**纯函数**）：

| 优先级 | 来源 | 成本 |
|---|---|---|
| ① | **本拍行情批量**里的指数家数（`INDEX_SECID = 1.000300` 的 `f104/f105/f106`；同一次 `ulist.np` 就有，`RescueQuoteRow` 现在把这三位带出来了） | **零请求**、时刻最准 |
| ② | `/breadth` 最近一次成功结果（≤120 秒）；路由在响应时用 `noteBreadthMoment()` 顺手记进内存（**无 IO、无请求**） | 零请求 |
| ③ | 都没有 ⇒ `breadth: null` + `breadthWhy` 写明原因（含"不为此单独发请求"），**绝不写 0** | 零请求 |

契约：`RescueSignalEvent.{breadth, breadthWhy, breadthSource}`（`RescueBreadthMoment{up,down,even,amount,asOf,source}`）。
`amount` 缺失 ⇒ `null`（不写 0）；缓存过期也算缺失（`BREADTH_MOMENT_TTL_MS = 120s`，不拿旧数冒充"触发瞬间"）。

## 2｜决策 2：分时点带上六通道读数

`RescueIntradayPoint.channels: RescueIntradayChannel[]`（secid/name/price/pct/amount/timeAdjMult/volumeZ/superNet），
数据就是**同一拍**的 `etfs`（`scoring` 通道，自定义板块 ETF 不进）⇒ 悬停"按时刻看六只"不再需要额外取数。
上界：`RESCUE_INTRADAY_MAX = 120` 条 + `RESCUE_INTRADAY_MAX_BYTES = 192KB`（`trimIntradayBySize` 从最旧丢）。

## 3｜追加：快照里补「每卡分钟序列」

`RescueSnapshot.etfSeries: RescueCardSeries[]`（六只宽基 ETF 各一条当日分钟序列）：
- **口径**（写进契约、原样展示）：`每分钟成交额（元）·当日；腾讯分钟链的逐分钟值由累计额差分推导（amountDerived）`；
  点形如 `{ hhmm: '14:00', amount: 1234567|null, price: 3.9|null }`（缺失 ⇒ `null`，**不写 0**）。
- **数据来源**：`this.minutes`（采样器已在取的分钟链，60 秒刷新一次，六通道共用）⇒ 客户端**不必**每卡各打一次 `/trend`。
- **上界**：每卡 ≤ `RESCUE_CARD_MAX_POINTS = 242`（一整日）点；整块 ≤ `RESCUE_CARD_SERIES_MAX_BYTES = 128KB`；
  超出从最旧丢、**六卡同步裁**（保证卡间长度一致）；持久化也带（已裁剪 ⇒ 文件有界），沿用既有 60 秒写入节流。
- **缺数据**：该卡 `points: []` + `why`（"还没拿到分钟序列 ⇒ 空数组，不补 0"），不是补 0 的假序列。

## 4｜「零新增请求」是怎么被证住的

| 证据 | 内容 |
|---|---|
| 端到端 URL 级 | 打桩上游跑**真的一次采样**，统计全部请求 URL：`clist`/`breadth`/`f104=` 的请求数 = **0**（家数只能来自同拍行情或内存记录） |
| 端到端批量级 | `ulist.np/get` 请求数 **≤1**（六通道搭同一批的车；绝无"每卡一次"） |
| 结构性（扫描） | `resolveBreadthMoment` / `trimIntradayBySize` 函数体内 **0 个 `fetch(`**；事件家数段、分时点通道段、卡序列构造段都 0 个 `fetch(` |
| 数据同源 | 分时点六通道的 `price/amount/superNet/timeAdjMult` 与**同拍快照** `etfs` **逐个相等**（证明是同一拍投影，不是另取一遍） |

## 5｜断言与注入（8/8 全抓）

| 注入 | 关掉什么 | 改后读数 |
|---|---|---|
| P1 | 事件里删掉家数字段 | ✅ 红：`事件必须带家数（breadth）` |
| P2 | 家数缺失时写 0 顶替 | ✅ 红 |
| P3 | 为家数单独加一次取数 | ✅ 红：`不许为家数单独取数（实际 ["…/clist/get?pn=1"]）` |
| P4 | 分时点删掉六通道字段 | ✅ 红：`分时点必须带六通道（实际 0）` |
| P5 | 快照里删掉六卡序列 | ✅ 红 |
| P6 | 去掉点数/体积上限（裁剪空操作） | ✅ 红：`每卡 ≤ 242 点（实际 400）` |
| P7 | 缺数据补 0 冒充完整序列 | ✅ 红：`1.510300 缺数据 ⇒ 空数组` |
| P8 | 卡序列路径自己去取数（`fetch` 出现在纯函数里） | ✅ 红 |

断言文件：`src/host/rescuePiggyback.test.ts`（6 条：① 家数搭车进事件 + 零请求；② 缺失/过期 ⇒ null + 原因（不写 0）；
③ 分时点六通道与同拍快照逐值相等 + 六卡序列长度一致；④ 结构性扫描（纯函数不含 fetch、上限存在且被使用）；
⑤ `trimIntradayBySize` 上限；⑥ `cardSeriesOf`/`trimCardSeries` 语义（有数据 ⇒ 有点 + 口径；缺数据 ⇒ `[]` + 原因；超限 ⇒ 裁到上限且保最新））。
测试内 `process.env.DSH_HOME` 在 import 之前钉到 `mkdtemp` 目录（否则共享行情链会读到**真机**的 `quotes-lkg`，家数来源就假了 —— 实测踩过一次）。

## 6｜未做 / 交回

| 项 | 说明 |
|---|---|
| `build.mjs` 的片段校验失败 | **不是本批**（见文件头 ⚠）：另一路把客户端 `'底部位置 / 形态 / 概率'` 改成了 `'…触发后对照'`。修复要么改回文案、要么改 `build.mjs` 的片段清单 —— 两者都在你手上，我没动 |
| 客户端卡内迷你折线 | 本批只交付**数据面**（契约 + 快照字段）；画线是客户端那路的事（字段：`etfSeries[].points[].{hhmm,amount,price}` + `caliber`） |
| 每卡「超大单」分钟序列 | **不具备**：上游只有当日累计超大单（30 秒采样差分是窗口值，不是分钟值）⇒ 卡内序列用**每分钟成交额**（口径已写清）。若你要"每分钟超大单"，需要新上游（红线） |
| `fflow/kline` 链路 | 采样器本身还会打 `fflow/kline`（既有链路，非本批新增）；本批没有增删它 |
| 分时点 5 分钟粒度 | 未改（仍是 5 分钟一点）；1 分钟粒度可用性见 `docs/PROBE-RESCUE-UI.md` |
