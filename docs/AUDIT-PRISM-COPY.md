# 复制持仓：资金不足自动提高上限并完整复制

## 一行结论

`action:'copy'` 先算 `required = Σ(数量×摊薄成本)`（成本先按分取整，不含费用）；不足则把 capital 提到 `required` 并写 settings/account，随后完整复制；回包带 `copy` 摘要，UI 不显示摘要。

## 实现

- 路由 `copy`：
  - `required` 逐只 `round2(cost) × qty` 求和，再取整到分。
  - `capitalBefore = account.capitalLimit`；`capitalAfter = max(before, required)`；`raised = after > before`。
  - 用提升后的上限调用 `copyAtCost`；`saveAccount(explicitReset)`，`saveCapital(capitalAfter)`。
  - 回包 `copy:{requestedPositions,copiedPositions,required,capitalBefore,capitalAfter,raised}`，账户同时带 `capital`/`capitalLimit`。
- 复制不是成交：`cash = capitalAfter − required`，不扣费用；`raised` 只在不足时为 true。
- `copyAtCost` 仍支持内部部分复制兜底，但本路径的上限已被 `required` 覆盖，正常不会部分复制。

## 今天真实数据读数

从上表当前 `positions.json`/`ledger.json` 逐只按摊薄成本（四舍五入到分）计算：

| 代码 | 名称 | 数量 | 摊薄成本 | 金额 |
|---|---|---:|---:|---:|
| 1.588170 | 科创半导体ETF华夏 | 600000 | 0.86 | 516000.00 |
| 1.518880 | 黄金ETF华安 | 5000 | 8.89 | 44450.00 |
| 1.601872 | 招商轮船 | 15000 | 19.39 | 290850.00 |
| 1.688035 | 德邦科技 | 4000 | 72.36 | 289440.00 |
| 1.510300 | 沪深300ETF华泰柏瑞 | 65000 | 4.33 | 281450.00 |
| 1.560010 | 中证1000ETF广发 | 85000 | 2.89 | 245650.00 |
| 1.600573 | 惠泉啤酒 | 2000 | 13.47 | 26940.00 |
| 1.688825 | 长鑫科技 | 5000 | 42.64 | 213200.00 |

- 测试夹具用同一组 8 只、按到分成本计算 `required = 1,907,980.00`；断言 `capital 1,750,000 → 1,907,980`、`cash 0`、8/8、长鑫 5000 股。
- 用活账本当前 `positions.json`/`ledger.json` 跑同一条 copy handler（隔离目录，不动 live）：`requestedPositions=8`、`copiedPositions=8`、`required=1,907,130`、`capitalBefore=1,750,000`、`capitalAfter=1,907,130`、`raised=true`、`cash=0`、长鑫 5000、8 只数量逐只相等。
- 用户给的 1,908,105 与当前账本按到分成本差 **975**（当前长鑫成本 42.6437 → 42.64；其余逐只取整），不硬编码用户值，实际按实时成本算。活账本 `capital` 当前为 1,600,000（此前数据订正）；按 1,750,000 运行同样 `raised:true`。

## 断言/注入

`src/host/prismCopy.test.ts` 4 条：

1. 1,750,000 / required 1,907,980 ⇒ `capital===required`、8 只数量全等、长鑫 5000、cash0；保留部分复制 ⇒ 败。
2. `cash===capital−required`；写负现金 ⇒ 败。
3. `raised:true`、`capitalBefore/After` 正确；不记录 ⇒ 败。
4. 上限足够（2,000,000）⇒ `raised:false`、capital 不变、cash=92,020；无条件上调 ⇒ 败。
5. 连续两次 copy ⇒ 数量/cash 不变，不累加。
6. 真实持仓空 ⇒ required0、不改上限、cash 原值。
7. GET 不触发复制回归（既有 `prismCash`/`prismLedger` 测试）。

## 门禁

- 新增 4 条；当前全量 **1234**（仓库并行任务另计）。
- 构建 73 项（v0.147.0）；`build.mjs` 未动；不 commit、不重启。
