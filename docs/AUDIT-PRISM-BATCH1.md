# 棱镜首批 5 项（P-01/P-04/P-05/P-08/P-10）施工审计

> 基线：`v0.148.0`，测试基线 1234。范围：P-01/P-04/P-05/P-08/P-10 + 定稿 UI。
> 不改 `build.mjs`、不新增依赖、不 commit、不重启；隔离 `DSH_HOME=/tmp/pb1-*`。

## 一行结论

5 项全部落地：净值口径有 `capital/benchmarkClose` 与告警，run 绑定全摘要版本/ mandate，撮合按量能部分成交且瞬时失败保持 pending，仓位上限有确定性裁剪链，行业暴露成为后端数据 + 左栏卡；全量 **1246**、构建 **73**。

## 1. P-01 权益口径与现金流

- 净值点新增 `capital` / `benchmarkClose` / `warnings`：`src/shared/prism.ts:193-207`、`src/host/prismAccount.ts:229-260`。
- `recordEquity` 用既有 `em.fetchKline('1.000300',101,1)` 取收盘；取不到写 `null`，不伪造（`src/host/prismRoutes.ts:149-162`）。
- 调整后收益：`(equity_t − capital_t) / (equity_0 − capital_0) − 1`；缺 `capital` 的点 `value:null` + 原因，绝不回填当前 `capital`（`src/client/prismView.ts:163-172`）。
- `dayStartEquity` 与前一交易日收盘净值差 >1 元 ⇒ `warnings` + `console.warn`；不改口径来源（`src/host/prismAccount.ts:254-260`、`src/host/prismRoutes.ts:157-162`）。
- 当日盈亏改为相邻净值点 `(equity−capital)` 差分，不再用 `dayStartEquity` 直接减（`src/client/prismView.ts:174-184`）。
- `unrealized` 语义不变；UI 累计盈亏 hint 标注「相对本金总盈亏」（`src/client/prismView.ts:100-103`）。

断言/注入：

- 缺 `capital` ⇒ `—` + “不能用当前值回填”；`P-01 当日盈亏...`。
- `benchmarkClose` 落盘且可空；`P-01 净值点...`。
- `dayStartEquity` 差 >1 ⇒ 告警；`P-01 净值点...`。

## 2. P-04 版本绑定

- `PrismRun.codeVersion` 来自构建注入的 `__TW_VERSION__`（`prismCodeVersion`，测试直跑回落 `dev`，不手写版本）；`mandateHash` 为骨架 + settings 参数（剔除 `lastFired`）的 **全 sha256**（`src/host/prismPipeline.ts:55-68,108-109,182-183`）。
- `canonical()` 从 `backup.ts` 导出复用；不使用 `slice(0,16)`（`src/host/backup.ts:42`）。
- `codeVersion/mandateHash` 字段进 `PrismRun`，UI 版本信息默认折叠显示（`src/shared/prism.ts:80-82`、`src/client/PrismPage.tsx:451-455`）。
- 构建注入沿用既有 `build.mjs` 的 `__TW_VERSION__`；未改构建脚本。

断言/注入：

- 两天同配置（仅 `lastFired` 不同）⇒ hash 相同；改 `capital` ⇒ 变化；64 位全摘要（`P-04 mandateHash...`）。
- 若把 `lastFired` 纳入 ⇒ 该测试失败（测试以不同 lastFired 断言相同）。

## 3. P-05 量能约束 + 无量源降级

- `MinuteBar.volume`；新浪 map 补 `r['volume']`、腾讯 m1 补 `r[5]`，注释标「股」口径与 `em.ts:1685` 一致；缺失写 `null` 不写 0（`src/host/prismAccount.ts:124-130,500-523`）。
- 参与率进 settings，默认 0.10；成交股数 ≤ `volume × rate`（`src/shared/prism.ts:11-13`、`src/host/prismAccount.ts:777,840-841`）。
- 不足 ⇒ 部分成交，`filledShares` 累加、`status` 仍 `pending`、余量排队（`src/host/prismAccount.ts:840-886`）。
- 三个独立码：`vol-missing` / `vol-zero` / `trend-no-1min`；另有 `transient-source`；均写 `skipCode/skipReason` 并进 `skipped/rejects`（`src/host/prismAccount.ts:812-838`）。
- `source===null` 不再置终态 `rejected`，保留 pending 下一 tick 重试（`src/host/prismAccount.ts:809-817`）。
- 挂单「原因」列优先显示 `skipReason`，不再只显示 `o.reason`（`src/client/PrismPage.tsx:299-303`）。

断言/注入：

- `volume=null/0/trend/transient` 各自 pending + 独立码；`P-05 volume=null...`。
- 参与率不足 ⇒ 100/200 部分成交、余量 pending；`P-05 参与率不足...`。
- 若瞬时失败置 rejected ⇒ 测试失败；若三码合并 ⇒ 测试失败。

## 4. P-08 仓位上限真正执行

- 纯函数 `clampDecision(decision, ctx)`：固定链 **单票 → 行业 → 总仓 → 现金**；同一 `ClampContext` 分母 `现金 + 持仓市值`；整手向下；`<100` 不成交并留痕；卖单不裁；缺价格/行业/上限不夹；夹掉不重分配（`src/host/prismAccount.ts:565-650`）。
- `ClampEvent{at,secid,dimension,before,after,basis}` 写进 decision，由 run 落盘（`src/shared/prism.ts:211-221`、`src/host/prismRoutes.ts:254-271`）。
- 裁剪在 `placeDecision` 之前执行；引擎只调整已有订单数量，不新建委托（R12）。
- 决策卡「仓位上限依据」三行：资金上限·单票·总仓 / 达成度 / 本次夹紧（无则 `—`）（`src/client/PrismPage.tsx:219-227`）。

断言/注入：

- 4092 股（40.92%）/ 单票 25% ⇒ 2500 股，先整手到 4000 再夹；`P-08 单票 40.92%...`。
- 两个买单总仓 60% ⇒ 第一个 6000，第二个被拒；不把额度补给它；`P-08 夹掉不重分配...`。
- 缺行业 ⇒ 不产生 industry 事件；`P-08 缺行业...`。
- 卖单 10000 保持 10000；`P-08 单票上限...`。

## 5. P-10 行业暴露

- `industryExposureOf`：市值 ÷ `(cash + positions market value)`；行业来自 `fetchIndustryOverview(f127)`；宽基目录去重为「宽基 ETF」，族级用 `RESCUE_COVERAGE_FAMILY_OF_INDEX`（display `大盘/中小盘/成长/混合`）；未穿透与现金独立（`src/host/prismExposure.ts:1-80`）。
- GET 注入 `trading.exposure`；决策输入 `compileInput` 增加「行业暴露」段，含单票权重/行业上限（`src/host/prismRoutes.ts:83-113,288-293`、`src/host/prismPipeline.ts:53-66`）。
- UI：构成条之后新增卡，堆叠条 + 图例 + 前 6 行/其余 N 行 + 未穿透/现金固定行；identity `已归类 X% + 未归类 Y% = 100.00%`（`src/client/PrismPage.tsx:360-386`）。

断言/注入：

- 权重合计 100.00；`宽基 ETF` 只一行且 family=大盘；未穿透不并入其它；`P-10 暴露...`。
- 若把未穿透折进「其它」⇒ 测试失败；若两处权重分母不同 ⇒ 页面/后端断言失败。

## 6. UI 定稿落点

- **净值卡**移到右栏（研判之后、版本信息之前）；卡头 `名义/调整后` 开关，默认 `adjusted`；卡头显示当前口径数值（`src/client/PrismPage.tsx:429-448`）。
- **夹紧记录**不单独占卡，写入决策卡「仓位上限依据」三行（`:219-227`）。
- **版本信息**为默认折叠 `<details>`（`:451-455`）。
- **行业暴露**卡在左栏构成条之后、决策卡之前；移动端决策仍在净值前（`src/client/styles.ts` order）。
- 其余：两栏 62:38、6px 分隔、块间 16/组内 8、表格 12px、持仓 8 列、决策 7 行、挂单原因列、零免责文案保持。

## 7. 门禁

- 新增测试 **16**（P-01 2、P-04 1、P-05 2、P-08 4、P-10 2、UI 5）。
- 全量：**1250 / 1250**；`DSH_HOME=/tmp/pb1fix-check3` 与 `/tmp/pb1fix-check4` 两轮 `npm run check` 均绿（每轮正常 + UTC 各 1250）。
- 构建：**73 项**（v0.150.0；基线 v0.148.0）。
- `build.mjs` 未改；无新依赖；未 commit、未重启。

## 8. 未做 / 边界

- P-02/P-03/P-06/P-07/P-09/P-11/P-12…不在首批，未动。
- P-04 的 `codeVersion` 依赖既有构建注入；未改 `build.mjs`，测试直跑回落的 `dev` 只用于测试环境。
- P-05 为 mock 测试 + 既有真机口径注释；未新增行情源、未做真实逐笔回放。
- P-08 只裁模型给出的买单，不自动卖、不把已有超限仓位直接卖到上限（R12）；行业裁剪需要 `limits.byIndustry` 或 settings 行业上限，未配置时不夹。
- P-10 不做 ETF 成分穿透；未穿透独立披露，不猜行业；行业上限在未配置时显示 `—`。
- 未在活宿主重启后做浏览器截图验收；以 `npm run check`、构建和 UI 源码断言为准。

## 9. 重启后核对修复（2026-10-23）

- **exposure 不再可消失**：`GET /tradewatcher/prism` 的 `trading.exposure` / `state.exposure` 始终为对象；行业 f127 取不到时返回 `{state:'unavailable',reason}`，前端在 `state==='unavailable'` 时仍渲染行业卡，表体一行 `—（reason）`。
- **根因**：当前宿主 breakers 对 `push2.eastmoney.com` / `push2delay.eastmoney.com` / `push2his.eastmoney.com` 报 `fetch failed`，`fetchIndustryOverview` 没有拿到 f127；此前代码把空 map 当全部未穿透且前端遇到 null 就不渲染。现在 reason 会明确写「行业归属接口未返回 f127（东财可能限流/熔断）」或「f127 取数失败（…）」。
- **equity 同源**：GET 的 `trading.equity` 与页面 `equityPoints` 都取 `PrismTradingStore.equity()`；`normalizeTradingState` 保留 `exposure`，并在旧包缺 exposure 时补 `unavailable`，不返回 null。
- **版本信息**：`codeVersion`/`mandateHash` 为空、全横线时固定显示 `—（旧记录无版本绑定）`。
- **达成度**：`—` 必带原因：`缺行业数据`（exposure unavailable）或 `未配置行业上限`（可用但无行业上限）。

新增断言（`src/host/prismBatch1.test.ts`、`src/client/prismBatch1Ui.test.ts`）：

- exposure unavailable 对象仍存在、reason 含 f127；
- 前端 unavailable 仍渲染卡片；注入不渲染 ⇒ 必败；
- `trading`/`state` 的 equity 同源；注入点数为 0 ⇒ 必败；
- 版本缺值固定文案；注入空串/横线 ⇒ 必败；
- 达成度 `—` 带原因；注入只写 `—` ⇒ 必败。

门禁更新：**1250 / 1250 × 2 轮**，构建 **73 项**；`build.mjs` 未动、无新依赖、未 commit、未重启。

## 10. 版本信息行（2026-10-23）

- 采用 A：`版本 <值> · 指纹 <值>`，两字段各自带字段名；两字段都缺时各写一次 `—（旧记录无版本绑定）`。
- 有值时：`版本 v0.150.0 · 指纹 ab12cd34ef56…`（指纹截 12 位 + 省略号）。
- 不再出现 `—（旧记录无版本绑定） · —（旧记录无版本绑定）` 无字段名重复。
- 断言：缺值 phrase 出现次数 = 2 且前有「版本 / 指纹」；有值丢字段名 ⇒ 必败。
