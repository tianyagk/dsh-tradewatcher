# 历史拆单最低佣金订正

> 时间：2026-10-26 11:52:36 +08:00（备份时间戳）。范围：`src/host/**` 的幂等订正函数 + live `prism-account.json`。
> 备份：`/tmp/prism-account-feecredit-20261026-115236.json`、`/tmp/prism-orders-feecredit-20261026-115236.json`。
> 原始 fills **未改动**；`prism-orders.json` 与备份逐字节 deepEqual。

## 结论

已对实际拆单组做一次费用订正：重算应收 **106.29**，旧费用 **205.34**，退回现金 **99.05**；现金 263,795.28 → **263,894.33**，已实现盈亏 −43,773.36 → **−43,674.31**。重复执行 duplicate=true、credit=0、不新增记录。

## 实际账本与用户口径差异（重要）

用户描述为 **26 笔 × 8.60 = 223.60**；磁盘实际同组为：

- 订单：`o-1792984516628-1.588170-sell-0.703-120000`
- 证券：`1.588170`，卖出，价格 `0.703`，bar `1792984560000`（2026-10-26 11:16:00 +08）
- 实际 fills：**24 笔**（23 × 5062 股 @8.60 + 1 × 3574 股 @7.54），合计 120,000 股
- 旧费用合计：**205.34**（不是 223.60；差 18.26 是 2 笔缺失/数据漂移）

**没有按 223.60 硬编码加钱**，否则会多退 18.26。若后续找到另 2 笔同组 fill，可用同一函数按实际 beforeFee 重算/幂等订正。

## 重算公式与数值

- 委托金额：`0.703 × 120000 = 84360.00`（fills amount 合计 84,360.09，取实际 fills 合计）
- 佣金：`max(5, 84360.09 × 0.00025) = 21.09`
- 印花税（卖出）：`84360.09 × 0.001 = 84.36`
- 过户费：`84360.09 × 0.00001 = 0.84`
- 应收合计：`21.09 + 84.36 + 0.84 = 106.29`
- 订正金额：`205.34 − 106.29 = 99.05`

## 改动

- `PrismAccount.feeCorrections?: PrismFeeCorrection[]`，记录：
  `{at, secid, orderIds, orderKey, beforeFee, afterFee, credit, reason:'拆单重复收取最低佣金'}`
- `applyFeeCorrection(account, fills, input)`：
  - 按 `orderId + secid + at + price` 取同组 fills；
  - 重算整单佣金一次 + 印花税 + 过户费；
  - `credit = max(0, beforeFee − afterFee)`；
  - `cash += credit`、`realized += credit`；
  - `orderKey` 去重，重复执行返回 `duplicate:true, credit:0`；
  - **fills 完全不动**。
- 路由 `POST /tradewatcher/prism {action:'feeCorrection', orderId, secid, at, price}` 调用同一函数并保存账户。

## 断言/注入

`src/host/prismFeeCorrection.test.ts`：

- 26 笔 × 5062 × 8.60（fixture）⇒ beforeFee 223.60、afterFee 116.58、credit 107.02；硬编码 125 ⇒ 必败。
- 现金增量 = credit；realized 增量 = credit。
- 原始 fills `deepEqual` 不变。
- 第二次订正 ⇒ `credit=0`、`duplicate=true`、`feeCorrections.length=1`、现金不变。
- 无匹配 fills ⇒ 拒绝，不写账。

## 门禁

- 全量 **1319 / 1319**；两轮 `npm run check` 均绿。
- 构建 **73 项**；`build.mjs` 未动、无新依赖、未 commit、未重启。
- live 账户已写；宿主内存中的旧账户需下次启动读盘后体现。
