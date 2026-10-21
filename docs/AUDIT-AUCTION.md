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
