# 竞价展示（详情抽屉一行）—— 交付与审计

> 用户裁决（2026-10-21）：做「竞价展示」（方案 1）。位置固定在**行情抽屉**（`QuoteDrawer`）头部，
> 紧跟「今开」；**不新增页签、不新增卡片行**。四项一行：`竞价 1331.88 · 516.00 手 · 1.54% · +0.00%`
> （价格 2 位 / 量 2 位（手）/ 占全日量比 2 位（%）/ 相对昨收溢价带符号 2 位（%）），
> **不写口径、不写解释、不进悬停**。

## 1. 交付面

| 面 | 文件 | 改动 |
| --- | --- | --- |
| 契约 | `src/shared/model.ts` | 新增 `AuctionInfo`（`state: ok / not-open / unavailable` + 四项 + `reason`）；`StockDetail.auction` |
| 取数/计算 | `src/host/auction.ts`（新） | 纯函数 `auctionOfMinutePoints(points, prev, today)`；`fetchAuction(secid, prev)` 15s 缓存、**永不抛** |
| 宿主接线 | `src/host/em.ts` | `fetchStockDetail` 在拿到 quote 的 `prev` 后调 `fetchAuction(`${market}.${code}`, prev)`，随详情回包下发 |
| 展示 | `src/client/auctionView.ts`（新） | `auctionText(a)`：四项拼一行；未开盘 `—`、不可用 `—（原因）` |
| 抽屉 | `src/client/QuoteDrawer.tsx` | 在 `kv('今开', …)` 之后加 `kv('竞价', auctionText(d.auction))`（无 `title`） |

**没有新增路由、没有新增页签/卡片行、没有新数据源**：只用既有的腾讯 `m1` 链（`fetchTencentMinutes`）。

## 2. 数据链路（复用既有）

- 腾讯 `m1`（`web.ifzq.gtimg.cn/appstock/app/minute/query?code=…`）的**当日第一根**（标签 `09:30`）：
  `price` = 竞价价（= 日开），`cumVol` = 竞价量（手，累计）；当日**末根**的 `cumVol` = 当日总量（手）。
- `dayOf(ts) === 今天（Asia/Shanghai）` 才认；当日没有 m1 根 ⇒ `not-open`，四项全 null（**不拿昨日顶替**）。
- 溢价用详情回包的**昨收**（`prev > 0`）：`price / prev − 1`。
- 非沪深（`^[01]\.` 之外）⇒ `unavailable` +「仅沪深提供竞价」（不猜港/美/指数的竞价语义）。

## 3. 实测样例（`1.600519`，2026-10-21 收盘后）

| 项 | 值 | 说明 |
| --- | --- | --- |
| m1 当日根数 | 241（09:30 → 15:00） | 首根 `09:30`、末根 `15:00` |
| 竞价价 | **1331.88** | = 当日开盘（腾讯/新浪行情均为 1331.880） |
| 竞价量 | **516 手** | m1 首根 `cumVol` |
| 当日总量 | **33 514 手** | m1 末根 `cumVol`（与腾讯行情 `vol=33514` 一致） |
| 占全日量比 | **1.5397% → 1.54%** | 516 ÷ 33514 |
| 昨收 | **1331.88** | 腾讯/新浪交叉一致（今日平开） |
| 溢价 | **+0.00%** | 1331.88 ÷ 1331.88 − 1 |

⇒ 抽屉实际显示：`竞价 1331.88 · 516.00 手 · 1.54% · +0.00%`。

> 采样时东财详情主机恰好不可达（`fetch failed`，本仓库已知的上游抖动），所以 `fetchStockDetail` 的
> end-to-end 回包本次没取到；上表用**真实 m1 首末根 + 腾讯/新浪两个独立源一致的昨收**复算，
> 与 `auctionText` 的输入完全同构（`price/volLots/volSharePct/premiumPct`）。

## 4. 断言 + 反例注入（必败）

| # | 判据 | 用例 | 注入 |
| --- | --- | --- | --- |
| ① | 有今日根 ⇒ 四项齐全且格式逐字 `1331.88 · 516.00 手 · 1.54% · +0.83%` | `client/auctionView.test.ts` ①、`host/auction.test.ts` ① | 少一项（去掉量比 / 把量置 null）⇒ 失败 |
| ② | 无今日根 ⇒ `竞价 —`（不拿昨日顶替） | 两个测试的 ② | 把 today 改成昨日（或把 `—` 写成昨日数值/0）⇒ 失败 |
| ③ | 占比 = 竞价量 ÷ **当日**总量 | `host/auction.test.ts` ③ | 用昨日总量 ⇒ 数值不同、断言失败 |
| ④ | 溢价 = 竞价价 ÷ **昨收** − 1 | `host/auction.test.ts` ④ | 用今收/今开当竞价价 ⇒ 数值不同、断言失败 |
| ⑤ | 抽屉里不得出现竞价解释文字，且该行不进悬停 | `client/auctionView.test.ts` ⑤ | 加一句「竞价说明/口径/等于开盘价」⇒ 非空；改 `kv('竞价', …)` 签名加 title ⇒ 逐字断言失败 |

## 5. 门禁

- 基线 1052（棱镜移除后）→ **1060 条/每时区**（新增 8 条：宿主 5 + 展示 3）。
- `DSH_HOME=/tmp/auction-check{Q,R} npm run check` 两轮：见 §6 读数；`selftest` 与 73 项客户端片段校验照跑。
- 不新增依赖、不动 `build.mjs`、不 commit、不重启。

## 6. 门禁读数

| 轮次 | 命令 | 读数 |
| --- | --- | --- |
| 第 1 轮（最终代码） | `DSH_HOME=/tmp/auction-checkQ npm run check` | **1060 × 2 全绿**（`duration_ms` 18,944 / 20,289）；selftest `ALL HOST CHECKS PASSED`；构建 `73 项`（v0.126.0） |
| 第 2 轮（最终代码） | `DSH_HOME=/tmp/auction-checkR npm run check` | **1060 × 2 全绿**（`duration_ms` 19,030 / 18,234）；selftest / 构建同第 1 轮 |

- 客户端片段校验 73 项全过（`build.mjs` 未动）；无新增依赖；不 commit、不重启。

## 7. 竞价参考价曲线（方案 1）

> 用户裁决（2026-10-22）：在竞价行下方画**迷你折线**（`ref`）+ 下部细柱（`matched`），
> 行尾给当日最高/最低参考价（两个数，` · ` 分隔）；**无坐标轴文字、无网格、无浮框**；无点显示 `—`。
> 不限新增页签/卡片行/路由。

### 7.1 采样与落盘（宿主）

| 项 | 实现 |
| --- | --- |
| 窗口 | `inAuctionWindow`：`09:15:00 ≤ t ≤ 09:25:30`（Asia/Shanghai，按秒；含 09:25:30） |
| 交易日 | `f30` 的日期必须等于本地今天（不猜节假日）；`f30` 按**北京墙上时间**显式解析（宿主 TZ=UTC 也不漂） |
| 间隔 | `AUCTION_INTERVAL_MS = 10_000`；`AuctionSampler` 随 core 行启动（`unref` 定时器；`node --test` 进程不启动） |
| 标的 | `universeOf`：自选 ∪ 持仓、去重、自选顺序优先，上限 **60**；`truncated` 计数 + 首次告警留痕 |
| 字段 | `f9` 买一价（`ref`）、`f10` 买一量（`matched`，手）、`f19` 卖一价、`f20` 卖一量、`f30` 源时间 |
| 过滤 | `f9 !== f19` ⇒ 该拍不记录（已进入连续竞价）；`f9/f19 ≤ 0`、`f10 ≤ 0`、源时间不在窗口/不是今天 ⇒ 不记录 |
| 落盘 | `<DSH_HOME>/dsh-tradewatcher/auction/<secid>.json`，根 `{day, points[]}` + `history[]`（最近 4 日，合计 5 日）；单日 ≤120 点（超限丢最旧）；`updateJsonLocked` 锁内读-改-写；读失败走 `ReadGuard`（不覆写）；坏文件先 `quarantineFile`（`.corrupt-*`）再重建 |
| 重启 | 不需要补采：历史从落盘读；当天没采到 ⇒ `series: []`（曲线 `—`） |
| 路由 | **不新增**：曲线随既有 `/tradewatcher/detail` 的 `StockDetail.auction.series` / `seriesDay` 下发 |

### 7.2 展示（客户端）

- `AuctionSpark`（`src/client/AuctionSpark.tsx`）：一条 `ref` 折线（`--tw-accent`）+ 下部 `matched` 细柱（`--tw-muted`，正柱贴底）；
  高度 `Math.min(48, …)`，默认 44；**无 `<text>`、无网格、无 `<title>`/浮框**，`aria-hidden`。
- 位置：抽屉头部 `tw-dkv-grid` 之后（竞价行下方），`data-auction-series="1"`，高 44。
- 行尾：`auctionSeriesText(series)` ⇒ `1332.68 · 1330.75`（最高 · 最低，2 位小数；不写文字说明）。
- 无点：`AuctionSpark` 渲染 `—`；行尾不再出数。

### 7.3 实测（干跑，09:25 已过）

本题采样窗口已过，本实现的采样器**没有真实跑过一整场**；用**注入式时钟 + 构造行情**证明窗口/过滤/落盘逻辑（见 §7.4 ①–④）。
同期 `docs/PROBE-AUCTION-LIVE.md`（09:15:50–09:26:01，61 次快照）已独立证明字段可用：`f10>0` 61/61、`f9==f19` 55/61、
09:25:10 起 `f9≠f19` 且 `f6` 跳到 836 手 ⇒ 与本节"进入连续竞价即不记录"的实现一致。
另用 63 个构造点（09:15:00–09:25:20，每 10s）跑几何：

| 项 | 值 |
| --- | --- |
| 点数 | 63 |
| `auctionSeriesText` | `1332.68 · 1330.75` |
| 几何高 | 44（≤48）；量柱 63 根 |
| 折线 path 头 | `M2.0,15.9 L4.8,13.8 L7.7,11.7 …` |

落盘形状（6 天写入后）：

```json
{ "day": "2026-10-22", "points": [/* ≤120 */],
  "history": [{"day":"2026-10-21"},{"day":"2026-10-20"},{"day":"2026-10-17"},{"day":"2026-10-16"}] }
```

⇒ 今天 + 4 个历史日 = **5 个交易日**；最旧一天被丢。

### 7.4 断言 + 反例注入（必败）

| # | 判据 | 用例 | 注入 |
| --- | --- | --- | --- |
| ① | 09:14:59 / 09:25:31 不采；09:15:00 / 09:25:00（+09:25:30）采 | `host/auctionSeries.test.ts` ① | 全天都算窗口内 ⇒ 失败 |
| ② | `f9 !== f19` 不入库 | 同上 ② | 不比较、照收 ⇒ 失败 |
| ③ | 单日 ≤120、5 日轮转、丢最旧 | 同上 ③（+落盘用例） | 不裁剪 ⇒ 121 点 / 6 日 ⇒ 失败 |
| ④ | 上限 60 只、按自选顺序截断 | 同上 ④ | 不截断 ⇒ 75 只 ⇒ 失败 |
| ⑤ | 曲线无坐标轴文字/网格/浮框，高 ≤48 | `client/auctionSeries.test.ts` ⑤（`auctionSparkProblems`） | 加 `createElement('text', …)` ⇒ 非空 |
| ⑥ | 详情回包带 `series`/`seriesDay`，且无 `/tradewatcher/auction`、路由账仍 30 | `host/auctionSeries.test.ts` ⑥ | 不读落盘序列 ⇒ series 空、失败；源码出现竞价路由 ⇒ 失败 |
| ⑦ | 无点 ⇒ `—` | `client/auctionSeries.test.ts` ⑦ | 写成 `0.00 · 0.00` ⇒ 失败 |

### 7.5 门禁

- 基线 1060 → **1072 条/每时区**（新增 12：宿主 8 + 展示 4）。
- `DSH_HOME=/tmp/aucseries-check{S,T} npm run check` 两轮：

| 轮次 | 读数 |
| --- | --- |
| S | **1072 × 2 全绿**（18,782 / 18,767ms）；selftest 全过；构建 73 项（v0.127.0） |
| T | **1072 × 2 全绿**（18,823 / 18,070ms）；selftest / 构建同 S |
