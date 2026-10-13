# FIX-1-REDLINE —— 红线批（数据安全与编造数字）修复记录

来源：`docs/REVIEW-2-CORRECTNESS.md` §R1/§R2/§R3/§R6/§R7（用户批准按 1→2→3→4 顺序修，本批为第一批＝红线 5 条）。
写入面：`src/host/**`（含新文件 `readGuard.ts`）、`src/shared/model.ts`、`src/client/{PortfolioPage.tsx,api.ts}` 的最小连带改动。
门禁：`npm run check` **EXIT=0，541/541 × 2 时区 + selftest + build（v0.74.0）**（末尾三行见 §3）。

**一行结论**：5 条红线全部改掉并各自带"关掉修法必失败"的反例注入；其中 R1 是**三处同族的数据丢失**（账本/日历/90 天快照），统一到一份判据与一个守卫，读不到时**拒绝整份覆写**并如实披露。

---

## 1. 逐条修法 + 断言 + 反例注入

### R1 「读不到」被当成「没有」⇒ 覆盖用户数据（账本 / 日历事件 / 90 天快照）

**新文件 `src/host/readGuard.ts`**：一份判据 + 一个守卫（三处共用）
- `isFirstBoot(error)`（`:23`）：只有 `ENOENT` 才算"本来就没有"；
- `ReadGuard.markUnreadable/clear/assertWritable/entries`（`:54-96`）：读失败（EACCES/EIO/半isdir…）记下来，**写回前 `assertWritable` 抛 `UnreadableFileError`**；重读成功自动解封（临时故障不必重启）；
- `unreadableMissing(entries, what)`（`:98`）：翻译成对外 `missing[]`，note 明确"**不会自动重试**，修好权限/磁盘后恢复"（`why` 只能用 `transient`，但不拿 `稍后自动重试` 顶替）；
- `quarantineFile(path)`（`:112`）：把"读到了但内容坏"的原件改名留档（与 `store.ts` 既有 quarantine 同口径）。

| 处 | 修法（`文件:行号`） |
|---|---|
| 账本/持仓/自选/偏好 | `store.ts:391` 新增 `readGuard`；`:415`（`readNormalized`）与 `:458`（`readLedger`）区分 ENOENT 与其它；`:498` `persist()` 写前守卫（**所有变更的唯一落盘点** ⇒ commit / lockedWrite 两条路径都被拦）；`:506` 新增 `readFailures()` |
| 日历事件 | `calendar.ts:352` 读失败即 return（不再"空库"）；`:371` 坏 JSON 先隔离再继续；`:382` `persist()` 写前守卫；`:448` `syncStatus().missing` 追加"本地读不到"+ `stale=true`；`:462` `readFailures()` |
| 90 天快照 | `globalFlow.ts:586` 新增模块级守卫；`:604-612` 读失败标记并 return 空；`:648-650` 坏 JSON 隔离；`:669-673` `writeFlowSnapshot()` 直接返回 `{written:false, reason:'读不到…拒绝写回'}`；`:589` `flowReadFailures()` |
| 披露接线 | `tools.ts:352` 把 `store.readFailures()` 并进 `provenance.missing`；`routes.ts` portfolio GET 回传 `readFailures`（有才带） |

**断言**（`src/host/readFailRedline.test.ts`，4 条；用 `chmod 000` 模拟 EACCES，本机 uid=1000 非 root）：
1. 账本：读失败 ⇒ `mutatePortfolio`/`touch` 必须抛错，**磁盘流水条数不变**（复核基线 ≥3 条）；
2. 日历：读失败 ⇒ `mutate` 抛错、手记事件条数/内容不变、`syncStatus().missing` 如实、`stale=true`；
3. 快照：读失败 ⇒ `writeFlowSnapshot` 返回 `written:false`，磁盘 2 天历史原样保留；
4. 反面对照：**ENOENT 仍然照常可写**（守卫不能一刀切），坏 JSON ⇒ 隔离留档（原字节）+ 之后可正常落盘。

**反例注入**（3 组，全部"关掉守卫 ⇒ 断言必失败"）：
```
R1-A 关掉 store.persist 的守卫   → ✖ Missing expected rejection: 读不到账本时，写账本的变更必须抛错（不许静默成功）
R1-B 关掉 calendar.persist 的守卫 → ✖ Missing expected rejection: 读不到本地日历时，写回必须被拒（否则手记事件会被覆盖）
R1-C 关掉 writeFlowSnapshot 守卫  → ✖ 读不到时必须拒绝写回
日志：/tmp/fix1/inject/R1-{A-store,B-calendar,C-globalflow}.log（每次注入后 md5 校验已还原）
```

### R2 K 线把"上游失败"写进成功用的 TTL 缓存（1 小时不回源 + 理由谎称"重试无效"）

**修法**（`em.ts`）
- `:2310` `KLINE_FAIL_TTL_MS = 10_000`：失败**不进正缓存**，只写 10 秒负缓存（同秒重复调用不再打上游）；`:2315` `KlineEmptySignal` 让 `ttlCache` 在失败时**不写槽**；`:2342` 起 `refreshKline` 先查负缓存（查命中即"本轮不发请求"并如实记录），成功才 `delete` 负缓存；
- `:2310-2331` `klineAttempts` + `klineLastAttempt(secid)`：记录"本轮**到底发没发**上游请求"；
- `:2253-2266` `klineMissingReason` 改为**按事实**下结论：真的请求过 ⇒ 才允许 `no-source`+「确实请求过上游」；没发请求 ⇒ `transient`+「本轮没有向上游发请求…不是上游没有这份数据」。

**断言**（`fix1Redline.test.ts` 第 1 条，真 `fetchKline` + stub 上游 + 计数）：
第一次请求过（计数>0）⇒ 窗口内不再请求但理由为 `transient` 且含"没有向上游发请求" ⇒ **时钟 +11s 后必须重新回源**（计数增长）。

**反例注入**：把"空结果抛信号"退回"返回空数组当成功值缓存"⇒
```
✖ 窗口内没发请求 ⇒ 理由必须是 transient（实际 no-source：…本轮确实请求过上游（上游返回 0 根）…重试无用）
日志：/tmp/fix1/inject/R2-A.log
```

### R3 做T：缺价流水按 0 价计算 ⇒ 编造盈亏

**修法**（`dayTrade.ts`）
- `:73` `hasPrice()`；`:74` `isTrade` 增加"必须有成交价"；`:78` 缺价的买卖流水进 `unpriced`；
- `:145-156` `summary`：存在未计价流水 ⇒ `netPnl/avgNet/winRate` **一律 `null`**（不再拿"已算部分"冒充），并给 `unpricedCount`；`:96-103` 这些流水进 `unmatched`（`price: null` + 说明"未取到"）；
- 连带：`client/api.ts` 的类型镜像 `netPnl: number | null`（+`unpricedCount`）；`client/PortfolioPage.tsx:1268` 净盈亏为 null 时显示「净 未取到（N 笔流水缺成交价）」。

**断言**：`fix1Redline.test.ts` 第 2 条 —— 缺价卖出 ⇒ `rounds.length===0`、`netPnl===null`、`winRate===null`、`unpricedCount===1`、`unmatched` 里 `price===null` 且有"未取到"；**价格齐全时照常算出 1000**（防"修过头"）。

**反例注入**：退回 `price ?? 0` 配对 ⇒
```
✖ 缺价的卖出不构成往返（旧实现按 0 价配出一次往返，grossPnl = −10000）
日志：/tmp/fix1/inject/R3-A.log
```

### R6 已清仓且成本未知 ⇒ 合计按 0 计，披露被 `qty > 0` 门控

**修法**
- 口径收敛：`shared/model.ts:1146` 新增 `unknownRealizedRows()`（**不看 `qty`**，判据＝`costUnknown === true || realizedUnknownQty > 0`）；
- 合计不再把 null 静默当 0：`portfolio.ts:291/302/310/319` 逐行统计"未能计入 realized 的行"（含无法折算的非人民币行），`:335` 分组 `realized` 有未知行即 `null` + `realizedUnknownCount`；`:347-369` **总览同理**（任一分组不可算 ⇒ `grand.realized = null`）；
- 披露不被门控挡掉：`tools.ts:330` 在 `includeEmpty` 过滤**之前**取 `unknownRealized`（含 `cleared` 标记），`:366` 随回包返回；`:267` 总览行写出「累计已实现：未取到 —— N 行…（含已清仓的行）」；
- 面板：`PortfolioPage.tsx:201` 去掉 `qty > 0` 门控（改用同一份判定）；`:374` 新增"未取到（N 行不可算，含已清仓的行）"提示；类型镜像同步（`model.ts:824/838-845`）。

**断言**：`fix1Redline.test.ts` 第 3 条 —— 真 `assemblePortfolio` + 真工具 `execute`/`output.render`：已清仓且不可算的行必须能被识别；`grand.realized === null`（不再是自信的 `200`）且 `realizedUnknownCount ≥ 1`；分组合计同样 null；工具回包 `unknownRealized` 含 `cleared` 行；正文含"未取到"并点名标的。

**反例注入**：退回 `realized = add(realized, r.realized)`（null 当 0）⇒
```
✖ 存在不可算的行 ⇒ 累计已实现必须是 null（实际 200）
日志：/tmp/fix1/inject/R6-A.log
```

### R7 组合构成把 HKD/USD/CNY 按 1:1 相加

**修法**
- `composition.ts:14-36` 输入新增**必填口径** `mvCny`（人民币口径市值，由调用方按与 `grand` 相同规则给；未给一律按"折不了"处理，**不退回原币种**）；`:105-133` 分母与权重全部改用 `mvCny`，行里同时保留原币种 `mv`（事实不隐藏），新增 `excludedNonCny` 标注被排除条数；
- `portfolio.ts:374-383` 组合构成输入与 `grand.totalMv` 用**同一份**"能折算才计入"的集合（`cn ? mv : toCny(mv).value`）；
- 类型：`model.ts:862-870` 的组合构成镜像同步（`excludedNonCny` + `mvCny`）。

**断言**：`fix1Redline.test.ts` 第 4 条（真 `assemblePortfolio`，fxMode=none）：`composition.totalMv === grand.totalMv === 1100`（旧实现 69300）；港股 `weightPct === null` 但 `mv === 64000`；`excludedNonCny === 2`；集中度只统计进分母的行。另在 `position.test.ts` 增 1 条：折算后权重合计仍 100%±0.01。

**反例注入**：退回"原币种直接相加"⇒
```
✖ 分母只能含人民币口径：A股 100×11（旧实现 69300 = 三者 1:1 直接相加）
日志：/tmp/fix1/inject/R7-A.log
```

---

## 2. 与既有测试/文案的连带处理

- `markdownScan.test.ts` 两次抓到我在**用户可见字符串**里写的 `**`（`dayTrade.ts` 的 methodology、`em.ts` 的 missing note）⇒ 已去掉符号（不改扫描规则）。
- `position.test.ts` 的组合构成用例按新契约补 `mvCny`（原来那组输入本身就在混币种，正是 R7 的病灶）。
- `pnlLine`/`fmtMoneySigned`/`dirClass` 本就接受 `null` ⇒ 合计为 null 时显示 `—`，无需新格式函数。

---

## 3. 门禁（`npm run check`）

```
EXIT=0
ℹ tests 541   ℹ suites 0   ℹ pass 541   ℹ fail 0     （TZ=Asia/Shanghai）
ℹ tests 541   ℹ suites 0   ℹ pass 541   ℹ fail 0     （TZ=UTC）
ALL HOST CHECKS PASSED (live probes soft)
```
**末尾三行**：
```
> node build.mjs

built lib/index.js + lib/client.js （v0.74.0，客户端片段校验通过：73 项）
```
（532 基线 + 本轮新增 9 条 = 541：`readFailRedline` 4 + `fix1Redline` 4 + `position.test` 1。）

---

## 4. 未做项（不许读成"已修"）

| 项 | 说明 |
|---|---|
| `missing[].why` 缺"本地故障"档 | 现有枚举只有 `transient`（稍后重试）与 `no-source`（上游没有）。"文件读不到"属于**本地故障、不会自动重试**，我用 `transient` + 明确 note（写明"不会自动重试，修复后重启即恢复"）承载。要真正加一档需要改 `shared/model.ts` 的枚举 + 两端渲染，属跨端改动，未在本批做 |
| R2 的"同型"检查点 M8 | 复核提到 `globalFlow.ts` 的"成功但空"日线进 12h 正缓存（M8，属"中"档）本批未动 |
| 归档分组与 `grand` 的口径（U7） | 组合构成的输入含归档分组、`grand` 不含 —— 复核标为"意图不明"，本批未裁决 |
| 客户端组合构成渲染 | 复核确认客户端今天不渲染 `composition`（0 命中）⇒ 本次只改数据层与类型，未加界面 |
| 用户真实数据目录 | 我**没有**手工改动 `~/.dsh/dsh-tradewatcher` 任何文件；R1 的守卫只在"下一次落盘"时生效。若用户当前那份文件已读不到，修好权限后重启即可恢复写回（此前的行为会直接覆写成空） |
