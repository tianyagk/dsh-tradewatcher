# 棱镜策略研究：决策管线与防洗白

> 只读研究。依据：`docs/RECON-PAPERTRADE.md`（clawock-dsh §8 / TradingAgents §1 / astock §6）、
> `src/host/prismPipeline.ts`（当前管线）、`src/shared/prism.ts`（决策 schema）。
> 视角：决策管线与防洗白；不提议新数据源，只重组已有输入与约束。

## 0. 先回答三个问题

**① clawock 的 `stance` + `min_opposing_evidence` + 「bear_case 只能引 opposing 行」能否直接加进我们的决策 JSON？**

**结构上能，直接照搬不能。** 当前决策是普通 TS 接口 + 手写 parser， parser **不拒绝未知字段**，所以给 `PrismDecision` 加 `evidence[]` / `debate` / `thesis` 不会破坏旧回包（`src/shared/prism.ts:211-221`、`src/host/prismAccount.ts:266-297`）。但当前也没有任何代码会检查这些字段，直接加只会变成“模型多写一段自我声明”。要真正防洗白，必须同时加三件事：

1. `decisionSchemaVersion`（旧数据缺省 v1，新数据 v2；升级不静默）；
2. `evidence[]` 的稳定 `id` + `stance`（supporting/opposing/context）+ `source_class`；
3. 一个**结构化 gate**：`bear_case.evidence_ids` 必须全部指向 `stance=opposing` 的行、`bull_case` 全部指向 supporting、`min_opposing_evidence` 由配置给下限；不满足就拒绝发布/落单，而不是只在 prompt 里要求。

`min_opposing_evidence` 是**工作流参数**，不是数据源：放在 `PrismSettings` 或管线常量里即可。当前 `decisionProblems()` 只看 note 关键词和 limits 非空（`src/host/prismPipeline.ts:39-50`），正则天然可被“写一句不卖即可”绕过。**结论：可以加，但必须 v2 + 证据行 + 机械 gate 三件一起；只加字段是洗白装饰。**

**② 四路并行如何从“视角”变成“对抗”？谁出反方、如何机检？**

现状是**四个领域视角**，不是四个立场：四个 prompt 都只说“给判断与依据”，上下文隔离、同模型、同系统提示，最后把四段文字拼成 digest（`src/shared/prism.ts:114-119`、`src/host/prismPipeline.ts:105-116,123`）。领域（宏观/外盘/大宗/信息）本身不天然等于多空，直接指定“宏观当反方”是错位的。

建议的最小改造：

- 四路仍并行，但每路输出**证据行**（claim / stance / source_class / observed_at），不先给最终 action；
- 四路汇合后加 **一个红队审查员**（不是新增数据源，只读四份报告与证据行），它唯一职责是写 `bear_case` 并挑出 `opposing` 证据；`bull_case` 由汇总者从 `supporting` 行构造；
- **机检**：所有 cited id 必须存在；`bear_case` 的 id 全部 `opposing`，`bull_case` 全部 `supporting`；`context` 不得充当任何一方；`opposing >= min_opposing_evidence`；缺证时只能 `abstain`，不许用“综合来看”填空；
- **最多一轮**，不做多轮辩论。红队仍与主模型相关，无法消除共同错误前提；它的价值是**逼出可引用的反证**，不是“换一个更聪明的模型”。

**③ `thesis.invalidation_conditions` 先写可证伪条件再给动作？**

**应做，但要限定“可机检”的条件。** 当前决策只有 `limits/note/orders/cancel/rejects`，没有 thesis；汇总 prompt 要求“先判断风险暴露”，但没有任何字段强制说出**什么情况下判断会错**（`src/host/prismPipeline.ts:129-138`、`src/shared/prism.ts:211-221`）。建议在 JSON 中前置：

```json
"thesis": {
  "claim": "一句话主张",
  "invalidation_conditions": ["收盘价跌破 X", "现金低于 Y", "某个已发生新闻被证实/证伪"],
  "horizon": "1d|3d|1w"
}
```

gate 只检查**存在性 + 非空 + 引用现有可观测字段**（价格/持仓/现金/新闻时间戳），不引入新数据源。JSON 对象顺序不能真正强制“先写后做”，但 prompt 顺序 + 字段必填 + gate 能保证发布时条件已在场；这是可执行的最小版本。

**证据边界**：clawock 的 gate 实现不在 npm 包里（`docs/RECON-PAPERTRADE.md` §8/§4.1）；`stance`/schema 可验证，`min_opposing_evidence` 与「bear_case 只能引 opposing」的行为来自其 SKILL 文档与 schema。本文把它当**契约设计参考**，不当作已实测的闸门实现。

## 1. 六栏特性卡（7 条）

| 特性 | 现状差距（`文件:行号`） | 价值 | 成本 | 风险 | 判定 |
|---|---|---|---|---|---|
| **证据行 + stance/source_class + schema 版本** | 决策只有 `limits/note/orders/cancel/rejects`（`src/shared/prism.ts:211-221`）；parser 只挑已知字段、忽略未知（`src/host/prismAccount.ts:258-297`）；四份报告只有纯文本（`src/shared/prism.ts:37-42`）；汇总 schema 无 evidence（`src/host/prismPipeline.ts:134-138`） | 让“反方”从一句叙述变成可引用的行；给后续所有 gate 一个稳定主语；不新增数据源也能把现有报告结构化 | M | 模型把结论改写成 evidence；ID 漂移；token 增加；schema 升级兼容 | **做（v2 先 shadow，不阻断落单）** |
| **`min_opposing_evidence` + bear_case 只能引 opposing** | 当前 `decisionProblems` 只查 note 正则与 limits（`src/host/prismPipeline.ts:39-50`）；汇总只要求“指出分歧”，无证据引用（`:129-138`）；`bear_case` 无字段 | 直接针对“四视角互相洗白”：反方必须有反证行，稻草人无法通过；可统计每轮反证数量 | M（依赖卡 1） | 配额会诱发凑数反证；同模型生成的反证仍可能低质；硬下限会误伤“确实无重大反证”的行情 | **做，但允许 `no_counterevidence` + abstain；不许凑数** |
| **红队审查员：四路后加一个反方 call** | 四路是并行但同系统、同“给判断”任务，互不可见（`src/host/prismPipeline.ts:105-116`）；digest 仅拼接（`:123`）；没有反方角色 | 把“领域视角”变成“立场对抗”；只加一次调用即可获得可引用的 bear_case；比让宏观/外盘各自“兼当反方”更干净 | L | 同模型相关性/共同前提；延迟与费用；红队为反对而反对；多一轮仍可能洗白 | **试点：最多 1 轮、只做 bear_case、必须引 evidence** |
| **`thesis.invalidation_conditions` 前置** | 决策无 thesis/条件字段（`src/shared/prism.ts:211-221`）；汇总 prompt 只要求先判断风险，未要求可证伪条件（`src/host/prismPipeline.ts:129-138`） | 把“我觉得”变成“什么情况下我错了”；为 hold/减仓/清仓提供可复盘依据；抑制事后叙事 | M | 条件可能空泛/不可观测；模型先定 action 后补条件；需要 gate 判“可观测引用” | **优先做（比卡 3 更高性价比）** |
| **`action` 枚举 + abstain/Review + 拒绝码** | 解析失败退化成零订单 decision（`src/host/prismPipeline.ts:146-150`）；没有 abstain 一等动作；`PrismDecision` 无 action（`src/shared/prism.ts:211-221`）；失败只有 `parseError` | 把“读不懂/没证据”与“判断为 hold”分开；避免默认 Hold 被当成交易判断；拒绝码可驱动重试/人工复核 | S | 模型过度弃权；UI/统计把 abstain 误当看空；需要与 `placement` 的 rejects 语义分开 | **做最小版：action 枚举 + abstain + 1 个 reason_code** |
| **证据 ID + `observed_at/as_of` 时点闸门** | 报告无 ID（`src/shared/prism.ts:37-42`）；run 只有 `at` 与 `startedAt`（`:62-80`）；决策无 `as_of`；parser 无时点校验（`src/host/prismAccount.ts:258-297`） | 让 bear_case 的引用可追溯；拒绝“拿未来新闻证明当前判断”；为红队提供稳定的引用键 | M | 输入行 ID 需确定性生成；时间戳来自不同源时口径不一；可能把正常延迟误判 future | **做（卡 1 之后）：ID 先只读生成，时点先告警后阻断** |
| **结构化 gate 取代 keyword 正则** | `decisionProblems` 用 `/买|加买/` 与 `/卖|减仓/` 判 note，可被关键词绕过（`src/host/prismPipeline.ts:39-50`）；gate 不在 parser 内；落库前仅 `limits` 非空（`:49`） | 把“防洗白”从提示词搬到可测试的代码；失败给 code 而非一句错误；为 shadow→enforce 提供开关 | S | 误拒/运营摩擦；gate 规则本身可能过严；与现有 `placeDecision` 的 rejects 重复 | **做：先 shadow 记录，再按误拒率开启 enforce** |

## 2. 卡 1/2 的直接可加性判断（回答“直接加吗”）

**可以直接加进 JSON，但要按“旁路契约”加，不要把它变成硬阻断的第一版。**

- 解析层：`parseDecisionDetailed` 目前只读 `limits/orders/cancel/note`，未知字段不会报错，也不会保留（`src/host/prismAccount.ts:266-297`）。要让 v2 生效，必须显式解析 `evidence/debate/thesis/action`；**未知顶层字段仍拒绝**，否则拼写错误会被静默吞掉。
- 版本层：`PrismDecision` 加 `schemaVersion: 2`，旧记录缺省按 v1 展示，但不允许 v1 以“证据缺失”通过 v2 gate。
- 配置层：`min_opposing_evidence` 放设置/管线参数，不放进 evidence 行；否则模型可以自己声明下限。
- 结论：**字段可以直接加；机制不能只靠字段。** 先 shadow 计算 gate 结果并写入 `parseError`/独立 `gate` 字段（不阻断落单）；统计一周误拒与真实反证质量后再 enforce。

## 3. 卡 3 的“谁出反方”细化

不要让四个领域之一“兼当反方”，原因：领域不是立场，宏观分析师被迫看空会产出与职责无关的文本。推荐两段式：

1. **四路**仍然只负责“本领域事实 + 证据行 + stance”；
2. **红队**读四份报告与证据行，只输出 `bear_case`（summary + evidence_ids）与 `what_would_change_my_mind`；它**不产出订单**；
3. **汇总/裁决**只允许从 `bull_case`/`bear_case` 的引用行选择 action；订单的 `reason` 必须引用 `thesis` 或 evidence id。

机检最小集：

- `evidence_ids` 全部存在；
- `bear_case` 的 id 的 stance 全为 `opposing`；`bull_case` 全为 `supporting`；
- 同一 id 不得同时出现在 bull 和 bear（context 行两边都不能用）；
- `opposing` 数 ≥ `min_opposing_evidence`；不足时 action 只能是 `abstain`，并写 `reason_code=insufficient_opposing_evidence`；
- 红队不得引用四路报告中的结论句作为“证据”，只能引用证据行的 id。

这四条的代码量很小，真正的成本在把“证据行”从四份自由文本里稳定抽出来；因此卡 1 是前置，卡 3 不应先于卡 1 上线。

## 4. 落地顺序（建议）

1. **卡 4**（thesis/invalidation）：字段少、gate 简单、立刻改善“为什么下单/不下单”的可复盘性。
2. **卡 1 + 卡 2**（evidence/stance + opposing 下限）：shadow gate，先看模型能否产出可用 evidence，不看它是否“同意”。
3. **卡 7**（结构化 gate）：把 shadow 结果变成可执行判定，先 warn 后 block。
4. **卡 5**（abstain/Review）：在 gate 有稳定 reason_code 后加，避免“弃权”变成新的洗白出口。
5. **卡 3**（红队）：最后加一次调用；没有卡 1/2 时不要做，否则只是多一段反方散文。
6. **卡 6**（ID/时点）：与卡 1 同步设计、分阶段启用；先告警后阻断。

## 5. 明确不做

- 不引入新数据源、不新增行情/新闻供应商；所有证据只能来自现有账户、行情摘要、金十快讯、四份报告。
- 不做多轮多空辩论；最多一个红队 call，避免“多轮更像对抗”的错觉。
- 不把 `context` 行当作支持或反对；它只能解释背景。
- 不用“反方字数/条数”作为质量指标；只认引用关系与来源等级。
