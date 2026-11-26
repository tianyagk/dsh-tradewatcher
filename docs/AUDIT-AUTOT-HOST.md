# 自动做T 宿主实现审计（AUDIT-AUTOT-HOST）

- 基线：**v0.243.2 / HEAD 752a411**；`npm run check` **2062/2062**；审计开始时工作树干净。
- 审计对象：`src/host/prismRoutes.ts`（`autoTPayloadOf` / `placeAutoTPairs` / `action:'autoT'` / run 后调用点）、`src/host/prismAccount.ts`（`matchTickLocked`、`PrismOrder` 新字段、`feesOf`）、`src/host/prismStore.ts`（`prism-autot.json`）、`src/host/prismPipeline.ts`（tPlans 契约）、`docs/DESIGN-PRISM-AUTOT-MODAL.md` v5。
- 方法：只读代码审计；另用 `/tmp/repro-autot-store.mjs` 做了一次**不修改仓库**的双 store 复现。未改 `src/**`、未 commit、未重启。
- 结论：**“净持仓不变”在两条主路径上不成立**——① 一腿成交后，下一轮重审计会把回补腿撤掉；② 14:50 强制回补按计划股数而不是实际成交股数平仓。另有宿主层双缓存导致统计/计划状态回写丢失。**P0 3 条、P1 10 条、P2 11 条，共 24 条。**
- 审计期间外部有未提交改动 `src/client/styles.ts`（时间 11:44:31，非本次审计产生）；本审计只新增本文件，未触碰该文件。

## 问题清单

| # | 严重度 P0/P1/P2 | 问题 | 证据 | 触发 | 后果 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **P0** | 每轮重审计只收集 `pending` 腿；一腿已成交后，剩余回补腿必然被当成“计划变更”撤销，计划置 `aborted` | `src/host/prismRoutes.ts:623-631`（pairs 只遍历 pending）；`:644-645`（`same` 要求 buyPrice/sellPrice 都匹配，已成交腿不在 pairs，缺的一侧为 0）；`:654-661`（kill 撤剩余腿、plan aborted） | 任意 T 对一腿成交后，下一轮 LLM 重审计（默认 10 分钟一次）；或模型本轮不给/给错 tPlans | 回补腿被撤、plan `aborted`；`matchTick` 跳过 aborted 计划，净持仓永久偏离（买腿成交则多仓，卖腿成交则少仓），不会再强制回补 | pairs 收集含 `filled`/`filledShares>0` 的腿；有成交腿的 pair **禁止 kill**，标 `open-filled` 并保留回补腿；只有两腿都未成交的 pair 才允许按本轮计划替换 |
| 2 | **P0** | 14:50 强制回补按 `plan.shares` 全量成交，不按实际 `filledShares` 的净差额 | `src/host/prismAccount.ts:1955-1966`：`filledLeg` 只用于判断方向，`fee`/`fill`/`applyFill` 全部用 `plan.shares`；实际已成交股数 `filledLeg.filledShares` 被忽略 | 任一腿部分成交（如买腿 400/1000）后到 14:50；或两腿都部分成交 | 买腿只成交 400 却卖 1000 → 净持仓 −600；卖腿部分成交则反向多买；若持仓不足 `applyFill` 抛错，计划永远 `waiting` 并每 30 秒重试 | 用 `buy.filledShares - sell.filledShares` 算净差额，只回补差额；两腿都部分成交也按净额；回补后校验 `qty` 回到计划开始值，再置 `done/forced` |
| 3 | **P0** | autoT 账本双实例：`PrismStore` 用启动时加载的内存缓存，`PrismTradingStore` 每次读盘；GET 读旧内存，下一轮用旧内存整文件覆盖磁盘 | `src/host/prismStore.ts:70,192-210`（`autoTValue` 只在 init 加载；`saveAutoT` 用 `() => ({v:1,...next})` 整文件覆盖）；`src/host/prismAccount.ts:981-994`（TradingStore 每次读盘/写盘）；`src/host/prismRoutes.ts:266`（payload 读 PrismStore）、`:660-663`（placeAutoTPairs 用 `file0` 覆盖） | `matchTick` 结算写盘后，任意 GET；或下一轮 `placeAutoTPairs`（即使模型不再给计划） | UI 计划永远 `waiting`、`done/open-filled` 不显示、`today`/`stats` 缺本轮结果；下一轮把磁盘 `results` 和计划状态覆盖丢失（进程重启后才恢复旧值）。临时脚本已复现：matchTick 后 disk=`done + 1 条 result`，PrismStore 仍 `waiting + 0 条`；再 `saveAutoT(stale)` 后 disk 被写回 `waiting + 0 条` | 单一 owner：`autoTPayloadOf` 改用 `PrismTradingStore.autoT()`（改为异步）或让 `PrismStore` 每次读盘；`saveAutoT` 必须在锁内以磁盘为基线 merge，禁止整文件覆盖 |
| 4 | **P1** | 回撤闸门/止损/主决策减仓都不联动撤销 T 腿 | `src/host/prismEval.ts:180-188`（`applyDrawdownGate` 只过滤 `decision.orders` 的买单）；`src/host/prismRoutes.ts:731-737`（gate 之后仍无条件 `placeAutoTPairs`）；`src/host/prismAccount.ts:1674-1681`（只撤销 `decision.cancel` 列出的 id，不扫描同标的卖单）；`src/host/prismRoutes.ts:432`（提示词说“本轮新买单会被直接拒绝”，但 T 买单不受影响） | 回撤闸门触发；或主决策对同一 secid 下减仓/止损卖单；或持仓已触及止损线（`clampDecision` 只拒主买单，T 买单仍可挂） | T 买单在冻结期成交，抵消降暴露；T 卖腿与减仓卖单叠加，实际减仓超过计划；T 买单还可能给已触及止损的持仓加仓 | gate/主决策落单前统一 `cancelAutoTFor(secid 或 all, reason)`；若 open 腿已成交，把回补数量并入减仓或先强制回补；`placeAutoTPairs` 检查 `run.drawdown.triggered` 与持仓止损状态 |
| 5 | **P1** | 无每日轮次上限；`today.limit:2` 只是展示；同参数用浮点精确相等去重 | `src/host/prismRoutes.ts:310`（`limit: 2` 硬编码）；`:641-645`（无 rounds 计数；`v.buyPrice === plan.buyPrice` 精确比较；`cap` 每次按当前 `qty/available` 重算） | 模型每轮把买卖价微调 0.01；或持仓/可卖数量变化导致 `cap` 变化 | 每 10 分钟生成新 pair，旧 pending 被撤；一天可远超 2 轮，费用/换手放大；统计显示 `x / 2` 失真 | 每 secid/day 统计 `results + 未完成 plans`，达到 2 即停止；价格比较用最小变动单位容差，pair 股数固定为首次挂单值，不用当前 cap 重算 |
| 6 | **P1** | 强制回补失败无 `forced-fail`/告警；quote 缺失仍标 `aborted`，`applyFill` 抛错则计划永久卡住 | `src/host/prismAccount.ts:1959-1970`（`px` 非有效值时跳过 fill，但 1969 仍 `aborted`；`applyFill` 在 1965 抛错会被 1974 空 catch 吞掉）；`:1974`（`catch { /* 不影响主账 */ }`） | 14:50 行情断流/停牌/现金不足/持仓不足 | 净持仓偏离无人知；或每 30 秒重试一次；UI 显示 `aborted/waiting` 与实际不符；次日 `available` 重置后彻底看不到差异 | 记录 `forced-fail`（原因、planId、已成交腿、缺口股数）并告警；回补失败不能标 `aborted`；次日首轮优先处理；UI 显示未回补次数 |
| 7 | **P1** | `prism-autot.json` 与三账本两次写、两处顺序相反、写错误全部吞掉 | `src/host/prismAccount.ts:1973`（先 `saveAutoT`）早于 `:1981`（后 `saveAll`）；`src/host/prismRoutes.ts:662-663`（先 `saveAll` 后 `saveAutoT`）；`src/host/prismStore.ts:209-210` / `src/host/prismAccount.ts:993-994`（`.catch(() => undefined)`） | 任一次磁盘写失败、进程崩溃、并发写 | matchTick 路径：autoT 先写 `aborted/done`，三账本写失败 → 计划完成但成交/账户未落盘，净持仓不还原；place 路径：T 腿已落盘但无计划 → 14:50 不会撤、过期后可能成交；`saveAutoT` 失败导致下次重试可能重复强制回补 | 把 autoT 纳入同一 atomic save set（四文件一次提交）；或先写主账本再写 autoT，并用 `planId + side + shares` 做幂等恢复；写失败必须上抛并标 `degraded`/`run.error`，禁止静默 catch |
| 8 | **P1** | `sell-first` 方向未实现：两腿同时挂，买腿仍占现金；无现金前置校验/顺序 | `src/host/prismRoutes.ts:648-650`（固定 `buy/leg:'open'` + `sell/leg:'close'` 同时挂）；`:652`（`plan.direction` 只写记录）；`:529`（非法 direction 默认 `buy-first`）；无 `cash` 前置检查 | 反T 计划 + 现金不足；买腿价格先触发 | 买腿被 `fillRejectReasonOf` 以现金不足拒绝，卖腿照常成交 → 裸减仓；14:50 强制买回又可能现金不足，形成 #6 的卡死 | sell-first 先只挂卖腿，成交后再挂买腿（或预留买入资金）；挂单前用 `feesOf` 校验现金；direction 决定 leg 标签和挂单顺序 |
| 9 | **P1** | `tPlans` 缺失/解析失败被当作空数组，`placeAutoTPairs` 直接全撤旧 T 腿 | `src/host/prismRoutes.ts:610-612`（`run.decision.tPlans ?? []`，随后 kill 全部 pairs）；`src/host/prismPipeline.ts:210-214`（parse 失败仍返回 `decision`，无 tPlans）；`src/host/prismAccount.ts:524-550`（不要求 `tPlans` 键）；`src/host/prismPipeline.ts:60-71`（`decisionProblems` 不检查 tPlans） | LLM 输出合法 JSON 但漏 `tPlans`；或汇总 JSON 解析失败 | 所有未成交 T 腿被撤；若有一腿已成交，直接触发 #1 的裸持仓；模型格式漂移即可造成 | 明确区分 `tPlans === undefined`（本轮不做审计/保留）与 `[]`（明确不做）；parse 失败不执行重审计；`decisionProblems` 缺 tPlans 报警并跳过重审计 |
| 10 | **P1** | 关闭做T开关只撤 `pending` 腿，不处理已成交腿，也不持久化 `aborted` | `src/host/prismRoutes.ts:1030-1039`（只对 `status==='pending'` 置 `cancelled`）；`:661`（aborted 只在 placeAutoTPairs 写）；无 filled leg 检查；`:611-612`（全关时 early return，也不清理） | 一腿成交后用户关闭该标的 | 回补腿被撤，净持仓偏离；`prism-autot.json` 计划仍 `waiting` 到 14:50；UI 可能显示已关闭但实际有 T 持仓 | 关闭时走统一 `closeOrCancelPair`：有成交腿先强制回补或要求二次确认；无成交腿撤单并写 `aborted`；全关时也执行清理 |
| 11 | **P1** | 没有收盘净持仓对账/`forced-fail`；设计验收 #5 无法验证 | `src/host/prismAccount.ts:421-425`（`rollDay` 只重置 `available` 和 `dayStartEquity`，不记录每 secid 开盘 `qty`）；`grep forced-fail` 全仓 0；`:1930-1954` 只在 plan deadline 处理 | 任意一腿漏平、计划丢失、14:50 进程不在线 | 净持仓变化不会告警；次日 `available=qty` 后彻底看不出差异；与 `DESIGN-PRISM-AUTOT-MODAL.md:90` 的验收 #5 直接冲突 | `rollDay` 记录 `dayOpenQty: Record<secid,number>`；15:00 后对账，差异写 `forced-fail` + 告警 + 次日优先；UI 显示未回补次数 |
| 12 | P2 | `pairId` 缺失（旧版计划）时，`matchTick` 把 `pairId===undefined` 的主委托当成 T 对，可能撤掉全部 pending 主单/用主单结算 | `src/host/prismStore.ts:49`（`pairId?` 可选）；`src/host/prismAccount.ts:1935-1939`（只按 `pairId` 过滤，不校验 `channel`）；`:1956`（deadline 会 cancel pair 中所有 pending）；主委托没有 `pairId` | `prism-autot.json` 存在 v0.240/手工计划无 `pairId`，且到 14:50 | 撤掉所有 pending 主委托；用主单成交算 T 结果，统计/净持仓全乱；pair 过滤还会把主单当 T 腿显示 | `pairId` 改必填；load 时迁移或丢弃无 `pairId` 计划；`matchTick`/payload 都过滤 `channel==='autoT' && pairId !== undefined` |
| 13 | P1 | 1.2% 固定价差不足以覆盖最低佣金，低价/小单 T 必亏 | `src/host/prismRoutes.ts:643`（只检查 `(sell/buy-1)*100 >= 1.2`）；`src/host/prismPipeline.ts:189`（提示词同样固定 1.2%）；`src/host/prismAccount.ts:66-81`（佣金最低 5 元/腿） | 100 股 @2.00，价差 1.2%：毛利 2.40 元，双边最低佣金 10 元 + 印花/过户，净约 −7.8 元 | 每轮“完成”但净亏；胜率/收益统计严重高估；低价 ETF 尤其明显 | 挂单前用 `feesOf` 估算双边费用，要求 `价差金额 >= 双边费用 + buffer`；低价/小单自动抬高最小价差或跳过 |
| 14 | P2 | `expireAt` 只在计划结算里检查，撮合循环不看；计划缺失时 T 腿过期不撤 | `src/host/prismAccount.ts:1806-1826`（撮合循环无 `expireAt` 判断）；`:1930-1954`（只有 plan 且 pair>=2 才进 deadline）；`:1936`（pair<2 直接 continue） | 14:50 后 `matchTick` 仍在撮合；或 `saveAutoT` 失败产生无 plan 的 T 腿 | 14:50 后仍可能成交且无回补，隔夜裸持仓；无 plan 的腿要到次日 `order.day !== day` 才 cancel | 撮合前对 `channel==='autoT' && expireAt<=now` 的腿直接 cancel；无 plan 的 T 腿也按 `expireAt` 清理并告警 |
| 15 | P2 | 主决策上下文只有 pending 列表，不标 T、不含已成交 T 腿/计划状态 | `src/host/prismRoutes.ts:385-393`（`pendingText` 只列 status pending，格式无 `channel/leg/pairId`）；`:416-423`（autoT 段只有持仓/可卖/买入均价）；设计 `DESIGN-PRISM-AUTOT-MODAL.md:55` 要求含“当前 T 挂单与已成交腿” | 一腿成交后的下一轮 | 模型不知道已有 open 腿，可能再下同标卖单或重给 tPlan，配合 #1/#10 撤掉回补腿；也无法正确决定是否撤销某笔 T 单 | 上下文增加 `【自动做T 当前计划】`：secid、direction、pairId、各腿状态/已成交/剩余、expireAt；pending 行加 `[T]` 标记 |
| 16 | P1 | 强制回补绕过 T+1/涨跌停/停牌/现金前置校验（买入仅 `applyFill` 事后现金检查，卖出不看 `available`） | `src/host/prismAccount.ts:1961-1966`（直接 `applyFill`）；`applyFill` 卖出 `:277-293` 只检查 `qty`，不检查 `available`；无 `limitsOf`/`suspended` 检查 | 强制卖出时 `available < plan.shares`；或跌停/停牌 | 模拟盘卖出当日买入/不可卖股份，T+1 失真；真实盘会被拒，回补失败 | 强制回补前复用 `rejectReasonOf`/`fillRejectReasonOf`；T+1 不足记 `forced-fail`，不硬成交；涨跌停/停牌按失败处理 |
| 17 | P2 | 结算只写 `results`；`trades` 从不写、`open-filled` 从不置、今日流水永远空 | `src/host/prismAccount.ts:1943-1949`（只 push result/set done）；`:1963-1966`（forced fill 未写 `AutoTTradeRec`）；`src/host/prismStore.ts:52-55`（trades 类型）；`src/client/prismDeskSide.ts:675-713`（flow 依赖 trades） | 任意成交 | UI「今日流水」空、「一腿已成」不显示；无法逐腿对账/复盘；强制回补也无 `forced` 标记 | 每次成交（含 forced）写 `AutoTTradeRec`（fee/forced/leg）；一腿成交置 `open-filled`；结算时更新 plan `done` |
| 18 | P2 | 统计只算 done 轮，强制回补亏损不进做T收益；`effectiveCost` 用当前 `qty` 摊累计利润 | `src/host/prismAccount.ts:1969`（forced 只 `aborted`，不写 result）；`src/host/prismRoutes.ts:290-304`（stats 基于 results；`profit / p.qty`） | 强制回补亏损；持仓数量变化（如先持有 1000 股赚 100 元后卖出 900 股） | 做T收益/胜率系统性偏乐观；有效成本被放大/缩小（利润 100 摊到 100 股 = −1.0，而不是 1000 股的 −0.1） | 强制轮单独记 `forcedResult`（负收益）并展示“未完成/失败”；有效成本按每次 `result.shares` 加权或维护独立 profitPool |
| 19 | P2 | `autoTPayloadOf`/`matchTick` 对 `prism-autot.json` 条目无 schema 校验；坏条目会 500 或让整段结算静默跳过 | `src/host/prismStore.ts:192-200`（直接 cast）；`src/host/prismRoutes.ts:275-280`（直接 `p.day/p.pairId`）；`src/host/prismAccount.ts:1931-1934`（直接 `plan.status`）；`:1974` 空 catch | 手工编辑/半截写/旧版本字段缺失（如 `plans:[null]`） | GET 500；或 autoT catch 后所有计划不结算，T 腿继续撮合 | load 时校验/过滤必备字段（id/secid/day/status/pairId），坏条目隔离并留痕；必要时迁移 |
| 20 | P2 | `plans/results/trades` 无保留上限；每 30 秒扫描全部历史 | `src/host/prismStore.ts:192-210`（全量 load/save）；`src/host/prismAccount.ts:1933`（每个 tick 遍历 `file.plans`）；`src/host/prismRoutes.ts:660-663`（全量 plans 重写） | 长期运行（每天多轮 + 历史） | 文件膨胀、GET/撮合变慢、事件循环阻塞；`prism-autot.json` 可达数百条并持续增长 | 保留最近 N 天（如 30）或按 day 分片；GET 只返回今日，历史落聚合统计 |
| 21 | P2 | `placeAutoTPairs` 用 `Date.now`，而 run 用 `deps.now/run.startedAt`；14:50 边界与 `day` 不一致 | `src/host/prismRoutes.ts:613-615`（day/deadline 用 `Date.now`）；`:646-647`（`at` 用 `Date.now`）；`:733-734` 注释明确主单边界用 `startedAt` | 注入时钟测试；或分析跨越 14:50 | 同一 run 主单用 `startedAt`、T 单被跳过或落到错误 `day`；测试无法稳定复现 14:49:59 边界 | 统一用 `run.startedAt`/`deps.now`；deadline/day 从 run 计算；测试覆盖 14:49:59 边界 |
| 22 | P2 | autoT 开关设置与 T 腿撤销不在同一临界区；`placeAutoTPairs` 用锁外读到的 `cfg`，可能给已关闭标的重新挂腿 | `src/host/prismRoutes.ts:609-611`（cfg 在 `runExclusive` 外读取）；`:1028`（`patchSettings` 在 trading lock 外）；`:1030-1040`（取消在锁内） | 用户在 LLM run 的 `placeAutoTPairs` 前后关闭开关 | 关闭后又被挂上新 T 腿，直到下一轮/14:50；用户以为已停 | 在 trading `runExclusive` 内重新读 settings/autoT；或先取消再 patch settings；用代际/版本号校验 |
| 23 | P2 | 费用/成交归因不完整：`PrismFill` 无 `channel`；`applyFeeCorrection` 不享受 ETF 印花税豁免 | `src/shared/prism.ts:207-220`（PrismFill 无 channel/leg/pairId）；`src/host/prismAccount.ts:112`（correction 固定算 stamp）；`:1890`（matchTick 有 `stampExempt`） | T 成交后按通道统计费用；或对 ETF 卖出做费用订正 | 无法按 T 通道单独核算费用；ETF T 卖出订正会算出偏高 `afterFee`，credit 被 `max(0)` 截断，账实不符 | `PrismFill` 增 `channel/leg/pairId`；`applyFeeCorrection` 复用 `feesOf` + 标的名判断；统一费用口径 |
| 24 | P2 | 自动做T 测试只做源码正则，无运行时结算/部分成交/一腿/重审计用例 | `src/host/prismAutoT.test.ts:34-41`（只 assert 源码字符串）；`placeAutoTPairs` 未导出，无两 store 集成测试 | 任何上述回归 | `npm run check` 2062 全绿也无法发现 #1/#2/#3/#6/#7；本次三个 P0 全部漏网 | 导出/注入 `placeAutoTPairs` 或走 `runPrismForSlot` fake LLM；至少加 5 个场景：一腿成交后重审计、部分成交 14:50、双 store 结算后 GET、强制回补失败、drawdown 触发 |

## Top5

1. **#1（P0）一腿成交后重审计撤掉回补腿**：这是“净持仓不变”最直接的破坏路径；任何一次正常成交 + 下一轮重审计即可复现，且 `matchTick` 对 `aborted` 计划不再强制回补。
2. **#2（P0）14:50 强制回补按 `plan.shares` 全量而不是 `filledShares` 差额**：部分成交时必然过度平仓（或 `applyFill` 抛错卡死），与 #1 共同构成两类主路径的净持仓破坏。
3. **#3（P0）autoT 双缓存**：GET/统计读 `PrismStore` 内存，`matchTick` 写磁盘，下一轮又用旧内存整文件覆盖；已用临时脚本复现，统计与计划状态会持续丢失。
4. **#4（P1）回撤闸门/止损/主决策减仓不撤 T 腿**：风控触发时 T 买单仍可成交，T 卖腿与减仓叠加；这是净持仓偏离之外最直接的资金/暴露风险。
5. **#7（P1）`prism-autot.json` 与三账本非原子写、两处顺序相反且吞错**：一旦写失败或进程崩溃，会出现“计划 done 但成交没落盘”或“T 腿落盘但无计划”，后者还会绕过 14:50 截止。

## 已核对通过的点（不算问题）

- T 腿确实走同一个 `matchTick`：`prismAccount.ts:1806-1925` 对 `channel:'autoT'` 没有特殊分支；`net` 用真实 `fills` 计算并扣双边费用（`1941-1946`）。
- `feesOf` 的 ETF 卖出免印花税生效：`feesOf(..., stampExempt)`（`prismAccount.ts:66-81`），matchTick 传 `/ETF/i.test(order.name)`（`:1890`），测试 `prismAutoT.test.ts:44-51` 通过。
- 单票/行业/总仓上限对 T 腿豁免：`placeAutoTPairs` 不经过 `clampDecision`；现金/可卖/涨跌停/停牌在成交前仍有 `fillRejectReasonOf`/`rejectReasonOf` 校验（`prismAccount.ts:155-172,212-232`）。
- 计划创建时对 `shares` 做了 100 股整手、20% 底仓、可卖数量、1.2% 价差的裁剪（`prismRoutes.ts:641-643`）；问题在于**裁剪后的计划生命周期**（#1/#5/#9），不在裁剪公式本身。

## 复现记录（#3）

临时脚本 `/tmp/repro-autot-store.mjs`（不修改仓库）实测输出：

```text
after placeAutoTPairs memory plans: [ 'waiting' ] disk: [ 'waiting' ]
after matchTick  memory: {"plans":[{"id":"P1",...,"status":"waiting"}],"trades":[],"results":[]}
              disk: {"plans":[{"id":"P1",...,"status":"done"}],"results":[{"id":"P1-r",...,"net":117.5}]}
after next round disk results: 0 plan: waiting
```

即：`matchTick` 已把 `done + result` 写入磁盘，`PrismStore.autoT()` 仍返回 `waiting + results:[]`；下一轮 `placeAutoTPairs` 用旧内存覆盖后，磁盘回到 `waiting + 0 条结果`。

## 审计边界

- 未修改 `src/**`、未 commit、未执行重启；本文件为唯一新增审计产物。
- 审计开始时 `git status --porcelain` 为空；审计期间外部出现 `src/client/styles.ts` 的未提交改动（11:44:31），非本次审计产生，未纳入本报告结论。
- 未重跑 `npm run check`（基线由任务给定 2062/2062）；本次以只读代码路径和 `/tmp` 脚本复现为准。
