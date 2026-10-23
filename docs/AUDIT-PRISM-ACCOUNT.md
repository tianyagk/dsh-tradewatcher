# 棱镜账户快照 / 决策理由 / trading.account 统一

## 一行结论

研判 prompt 现在注入 7 项账户快照；汇总 JSON 强制 `note`，页面决策卡展示 `note` 与 `limits.note`；API 的 `state.account` 与 `trading.account` 由同一个 `tradingWithDecision` 展开，客户端另有 `normalizeTradingState` 兜底。

## 缺陷 1：账户数据未喂给模型

- `PrismInputs` 新增 `account`；`accountSnapshotOf` 输出：
  `总资产 / 现金 / 持仓市值 / 当前仓位占比 / 可买额度 / 当日已成交笔数 / 未成交挂单`，数字带 `元 / % / 笔`。
- `prismInputsOf` 使用 `trading.account()` + 现价（缺价按成本）+ 当日 fills + pending 数生成。
- 汇总 prompt 明确“依据账户快照计算仓位上限；正常应给 singlePct/totalPct，确实无法计算才 null 并在 limits.note 说明”。
- 断言：捕获 5 个请求体（4 路 + 汇总）均含 7 项；少一项注入 ⇒ 败；正常模型回包 `singlePct=20,totalPct=50` ⇒ 解析非 null。
- 页面：`limits.note` 在决策表「仓位上限依据」展示；null 时仍显示 `—` 并保留 note。

## 缺陷 2：决策没有“为什么不下单”

- `PrismDecision.note` 新增（可选，兼容旧落盘）；`parseDecisionDetailed` 优先读顶层 `note`，兼容 `limits.note`，空串归一为 null。
- prompt JSON 字段增加 `note`：`本轮决策理由（一句话；orders 为空也必须写）`。
- 页面决策表新增「决策理由」行；空 ⇒ `—`。
- 断言：`decisionProblems`：`orders=[]` 且 `note` 空 ⇒ 非空错误；`note` 非空 ⇒ 通过。

## 数据结构核实

- 活宿主 `GET /tradewatcher/prism`：`state.account.cash` 与 `trading.account.cash` 都是 `1.12`，`positions` 都是 6 个。
- 路由用 `const tradingWithDecision = { ...trading, decision: latestDecision }`，同时展开到 `state` 与顶层 `trading`；断言源码保证同一对象。
- 客户端 `normalizeTradingState`：若 `trading.account.positions` 为空而 `state.account` 有值，落回 `state.account`；断言 cash/positions 一致。

## 门禁

- 新增 7 条（prompt 4 + client 2 + 既有行断言 1 调整）；当前全量 1200（仓库同时有其它未提交变更）。
- 构建 73 项（v0.139.0）；`build.mjs` 未动；不 commit、不重启。
