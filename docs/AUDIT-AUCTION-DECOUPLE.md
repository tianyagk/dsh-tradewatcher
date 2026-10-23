# AUDIT-AUCTION-DECOUPLE：竞价数据不再依赖东财

**一行结论**：竞价（四项 + 09:15–09:25 采样序列）原本**嵌在 `/tradewatcher/detail` 里**，而详情只有东财一个上游
⇒ 东财熔断时 `detail: null`，本地已经采样好的 37 份竞价文件一条也读不到；现在竞价有**独立出口
`GET /tradewatcher/auction?secid=`**（只读本地 `auction/<secid>.json` + 腾讯 m1，**零 `push2*`**），
`/detail` 也照旧带顶层 `auction`（`detail.auction` 保留只为兼容旧客户端）。

- 纪律：`build.mjs` 未改（构建 73 项）；不 commit／不装／不重启；无新依赖；实验 `DSH_HOME=/tmp/aucdec-*`；
  `push2*` 零请求（实测探针里东财一律 stub 掉，见 §3.3）。
- 门禁：**1194 × 2 时区**（Asia/Shanghai 1194/1194、TZ=UTC 1194/1194）+ 构建 73 项。

---

## 1. 症状与根因（逐条实测）

用户实测（2026-10-23 09:27）：采样器**成功**（`auction/` 37 个文件、`day=2026-10-23`、每只 38–60 点），
但 `curl '/tradewatcher/detail?secid=1.600519'` 回 `detail: {}` + `missing[0].why=transient`。

三条耦合，缺一不可：

| # | 耦合点 | 代码位置（修前） | 后果 |
|---|---|---|---|
| 1 | 竞价**只在** `fetchStockDetail` 里算 | `em.ts` `fetchStockDetail` 末尾 `const auction = await fetchAuction(...)` | 该函数整段依赖东财 `ulist.np`；东财抛错 ⇒ 整个函数抛 ⇒ 路由 `detail: null` ⇒ **竞价跟着消失** |
| 2 | 溢价要**昨收**，而昨收只从东财 `f18` 来 | `fetchStockDetail` 的 `prev` → `fetchAuction(secid, prev)` | 即便把竞价单独取出来，东财挂时 `prev === null` ⇒ 溢价不可算 |
| 3 | 缺昨收 ⇒ **整行退化** | `auction.ts` `auctionOfMinutePoints`：`if (prev 无效) return auctionUnavailable('缺昨收 ⇒ 溢价不可算')` | 价格/量/占比明明已算出来，却因为一个字段整行变 `—` |

另有一处隐性问题：竞价四项来自腾讯 m1（`minute/query`），而这条链**只写死 `web.ifzq.gtimg.cn`**
（上一轮只给 `fqkline` 加了同源回退）—— 该主机阶段性回 WAF 501 时，四项同样取不到。

## 2. 采用方案

**A（推荐）+ B（兼容）同时做**，不新增依赖、不接新源：

1. **A：新增 core 路由** `GET /tradewatcher/auction?secid=`
   - 契约：**永远 200**；`auction` 必有（不可用时 `state:'unavailable'` + 一句原因）；
     不可用时另给 `missing[]`（沪深 `transient` / 非沪深 `no-source`）。
   - 实现：`em.fetchAuctionFor(secid)` → `fetchAuction(secid, prev)`；
     `prev` 先取**零请求**的共用行情槽（`peekQuotes`），槽里没有就用**腾讯 m1 同包**的 `qt[4]`。
2. **B：`/detail` 仍带竞价**：`detail` 与 `auction` **并发**取，`detail` 为 null 也返回顶层 `auction`；
   `detail.auction` 用同一份（兼容旧客户端）。
3. **竞价数据源只用两条**：本地 `auction/<secid>.json`（采样器 09:15–09:25:30 落盘）+ 腾讯 m1
   （`minute/query` 的 09:30 首根 = 竞价成交价/量；同包 `qt[4]` = 昨收）。**不碰东财**。
4. **腾讯分钟链补同源回退**：`fetchTencentMinuteBundle` 走与 K 线同一套
   `web.ifzq.gtimg.cn` → `ifzq.gtimg.cn` → `proxy.finance.qq.com`（实测 09:31 首选主机 501、另两台 200）。
5. **缺昨收只缺溢价那一项**：`state:'ok'` + `price/volLots/volSharePct` 照给、`premiumPct:null`；
   展示层 `· —`（`auctionText` 不再整行退化）。
6. **客户端**：抽屉新增独立 `auction` 状态（`api.auction(secid)`），头部网格 `infoGrid(d|null)` 与曲线
   `auctionSpark(a)` 在 `detail === null` 的两个分支里**照常渲染**（其余字段 `—` + 原因）。

## 3. 实测

### 3.1 腾讯分钟接口的三台主机（2026-10-23 09:31，真实网络）

| 主机 | `minute/query` | 说明 |
|---|---|---|
| `web.ifzq.gtimg.cn` | **501**（326 B WAF 挑战页） | 首选主机又一次被挡 |
| `ifzq.gtimg.cn` | 200（1668 B） | 同源兄弟机正常 |
| `proxy.finance.qq.com` | 200（1668 B） | 同上（前缀 `/ifzqgtimg`） |

同一回包的 `qt` 数组实测：`["1","贵州茅台","600519","1317.87","1318.49","1311.84", …]`
⇒ 3=现价、**4=昨收 1318.49**、5=今开 1311.84；分钟首根 `0930 1311.84 1049 137612016.00`
⇒ 竞价价 1311.84 / 竞价量 1049 手（与今开一致，互为佐证）。

### 3.2 解耦后的真实读数（本地真实采样文件 + 真实腾讯，东财**被 stub 掉**）

`DSH_HOME=/tmp/aucdec-live`（复制本机 `auction/` 37 份、`day=2026-10-23`），`fetch` 拦截东财并抛错：

| secid | state | seriesDay | 点数 | 价 / 量 / 占比 / 溢价 | 耗时 |
|---|---|---|---|---|---|
| `1.600900` | ok | 2026-10-23 | **60** | 29.70 / 25790 手 / 14.42% / −0.40% | 398 ms |
| `1.600519` | ok | null | 0（本机没采样到这只） | 1311.84 / 1049 手 / 20.69% / −0.50% | 109 ms |
| `1.510300` | ok | 2026-10-23 | **60** | 4.08 / 127974 手 / 5.34% / −0.66% | 119 ms |
| `116.00700` | unavailable（仅沪深） | null | 0 | —（`no-source`） | 0 ms（不发请求） |

请求主机：`web.ifzq.gtimg.cn×3`（501）、`ifzq.gtimg.cn×3`（200）—— **东财 0 条**。

对比旧接线：同一时刻 `GET /tradewatcher/detail` 只能回 `detail: null`，竞价四项与 60 点曲线**全部读不到**
（`missing[0].why='transient'`，用户截图即此）。

### 3.3 计数与源码判据

`auction.ts` 里**不出现** `fetchAny` / `QUOTE_HOSTS` / `push2` / `eastmoney` / `fetchStockDetail`
（断言 ③ 逐项扫描）；`/auction` 真跑一次后断言：所有请求主机都不匹配 `eastmoney`、`push2` 计数为 0。

## 4. 断言 + 反例注入

| 判据 | 读数 | 注入（必败） | 位置 |
|---|---|---|---|
| ① 东财熔断时竞价仍非空且有序列 | 东财 stub 抛错 + 腾讯首台 501 ⇒ `/auction` 200、`state=ok`、`price=1311.84`、`volLots=1049`、`premium` 由同包昨收算出、`series.length=4` | 与 detail 一起置空 ⇒ "竞价必须仍在"必败 | `host/auctionDecouple.test.ts` ① |
| ② `seriesDay` = 今天 | `seriesDay === TODAY` | 写 `null` ⇒ 必败 | 同上 ② |
| ③ 不碰东财 | 源码 5 个禁词 0 命中 + 请求计数 0 条 `push2*` | 把东财主机塞进请求列表 ⇒ 计数必败 | 同上 ③ |
| ④ 客户端在无 detail 时仍渲染竞价行与曲线 | `infoGrid(null)`（含竞价行）在 `detail===null` 的两个分支各一次、`auctionSpark(auction)` 同上 | 把三处收进 `detail !== null`（旧写法）⇒ 必败 | `client/auctionView.test.ts` ④ |
| ⑤ 新增路由必须登记 | `routes.ts` 注册表含 `/tradewatcher/auction`；设计文档 `路由账 33 = core 16` | 用旧账目 `路由账 32 = core 15` ⇒ 必败 | `host/auctionSeries.test.ts` ⑥、`host/prismRegistration.test.ts` ① |
| 兼容：`/detail` 带顶层 `auction` | 东财挂时 `detail:null` + `missing[0].why='transient'`，顶层 `auction.state='ok'`、`series.length=4` | 回包去掉顶层 `auction` ⇒ 必败 | `host/auctionDecouple.test.ts` 兼容条 |
| 昨收缺只缺溢价 | `state='ok'`、`price/volLots` 照给、`premiumPct===null`；展示 `… · —` | 用今开顶替昨收 ⇒ 溢价变成错数 ⇒ 必败；整行退化 ⇒ 必败 | 同上最后一条 + `client/auctionView.test.ts` ①b |
| 不可用归因两档 | 沪深 `transient`（原因里写"不依赖东财"）/ 非沪深 `no-source`（重试无用） | —（两档真值表） | 同上 |
| 回退契约（分钟链） | 三台冷却才零请求；只冷却一台时由兄弟机接住 | 只冷却首选主机就要求零请求 ⇒ 必败 | `host/fix3Highmed.test.ts` H1（已按回退语义更新） |

## 5. 路由账（30 → 31，含棱镜共 33）

- `src/host/routes.ts`：新增 `path: '/tradewatcher/auction'`（**core**：详情抽屉消费，`ROW_ROUTES` 不变）。
- `docs/DESIGN-SUBPLUGINS.md` 两处账目行：`路由账 32 = core 15 + …` ⇒ **`33 = core 16 + …`**。
- `README.md` 的 HTTP 路由清单加入 `auction?secid=`，并写明"唯一一条不依赖东财的详情类出口"。
- 断言：`host/auctionSeries.test.ts` ⑥（注册表命中 + 账目 33/16 + 反例旧账目必败）、
  `host/prismRegistration.test.ts` ①（文档 `路由账 33 = core 16`）、`src/index.test.ts` 的账目用例
  （扫 `routes.ts` 实测 vs 文档，自动生效）。

## 6. 门禁与未做项

- 测试：**1194 × 2 时区**全绿（基线 1181 + 本轮 **9** 条：①①②③ + 兼容 + 归因 + 昨收缺 = 6（`host/auctionDecouple.test.ts`）+ 归属 1 + 客户端 ④/①b = 2；
  并行批另有 4 条（`client/rescuePanelRemoval.test.ts`）在飞，未计入本轮）。构建：73 项。
- 未做项：
  | 项 | 原因 |
  |---|---|
  | 竞价四项在 **09:25–09:30** 的取值 | 腾讯 m1 的首根是 09:30，09:25 撮合价要等它出现；这之前只有采样序列（`state:'not-open'`），属上游时序，不是本插件能补的 |
  | 采样器（`auctionSeries.ts`）自身的窗口/条数 | 本轮只改**读路径**；采样侧本来就只用腾讯 `qt.gtimg.cn`（EM-free），未动 |
  | `/trend`、`/kline` 回包再带一份 `auction` | Lead 给的是"或"关系；已有独立路由 + `/detail` 两条出口，再加一份只会让同一事实有第三种到达路径（违背单一来源） |
  | 竞价四项的**历史回看** | 落盘只留 5 日（今天 + 4），更早的没有；本轮不扩 |
