# 资金上限持久化 / 现金稳定

## 一行结论

资金上限写入 `prism-settings.json` 与 `prism-account.json`；GET 不再复制、不再重算现金；账户文件读取修正 `{v,account}` 包裹导致的重启回落；现金只在成交/入金/显式复制三处变化。

## Bug 1 根因

1. 页面与宿主字段一致：`action:'capital'` + `capitalLimit`。
2. **根因 A**：上限只写 `prism-account.json`，没有写 `prism-settings.json`；设置里没有 `capital` 字段。
3. **根因 B**：`PrismTradingStore.init()` 把 `{ v: 1, account }` 整个对象交给 `normalizeAccount`，没解包 `account` ⇒ 重启后字段全部回落默认（capital 1500000、cash 1500000、positions []）。
4. 现修：`PrismSettings.capital` 持久化；`saveCapital` 写 settings；账户初始化兼容包裹与旧裸对象；capital 成功后同时返回 account + settings。

## Bug 2 根因

1. **GET 自动复制**：`ensureAccount` 在每次 GET/run/capital 前调用，首次会 `copyAtCost` 写现金；已从 GET/run/capital 全部移除，只有显式 `action:'copy'` 才复制。
2. **账户初始化解包 bug**：重启后 `{v,account}` 被当裸账户解析 ⇒ cash 变 150 万、positions 0，随后又被自动复制覆盖，造成两个值来回跳。
3. `recordEquity` 只写 equity，不写 account；`state.account` 与 `trading.account` 由同一个 `tradingWithDecision` 展开。
4. `capital` 只按 `delta = 新上限 − 旧上限` 调整一次现金；同值重复保存 delta=0，不重复加钱；不触碰 positions/cost。

## 实测 curl 序列（隔离 route 服务器，同 handler；非活宿主重启）

命令按用户要求：显式 copy 建立基线 → GET → POST capital 2000000 → GET×3（2s）→ POST copy → GET×3。

```
1) POST copy (baseline)
capital=1500000 cash=1400000 copiedAt=1792733070615
2) GET baseline
capital=1500000 cash=1400000 copiedAt=1792733070615
3) POST capital 2000000
capital=2000000 cash=1900000 copiedAt=1792733070615
4) GET x3 (2s)
  GET1 capital=2000000 cash=1900000 copiedAt=1792733070615
  GET2 capital=2000000 cash=1900000 copiedAt=1792733070615
  GET3 capital=2000000 cash=1900000 copiedAt=1792733070615
5) POST copy
capital=2000000 cash=1900000 copiedAt=1792733076866
6) GET x3 after copy
  GET1 capital=2000000 cash=1900000 copiedAt=1792733076866
  GET2 capital=2000000 cash=1900000 copiedAt=1792733076866
  GET3 capital=2000000 cash=1900000 copiedAt=1792733076866
```

- capital 恒 2000000；cash 三次完全相同；copy 只改 copiedAt 一次；copy 后 GET 仍稳定。
- 夹具为 1 只 100 股 @1000；活宿主 6 只持仓的基线是 1500000/1.12，数值不同，序列语义相同。

## 断言/注入

`src/host/prismCash.test.ts` 4 条：

1. capital 落 settings；3 次 GET 恒为新值；重启后 settings/account 仍保留。
2. GET 不写 account：cash/copiedAt/`JSON.stringify(account)` 三次相同；`state.account` 与 `trading.account` 逐字节一致。
3. copiedAt 非空 GET 不复制；入金只改 capital/cash 一次，positions/cost/copiedAt 不变；同值再存不重复加现金。
4. GET 源码分支不得含 `saveAccount`/`ensureAccount`/`copyAtCost`；注入 `saveAccount` ⇒ 败。

## 数据/构建

- 新增 4 条；当前全量 1223。
- 构建 73 项；`build.mjs` 未动；不 commit、不重启。
