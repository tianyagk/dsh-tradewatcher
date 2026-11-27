# PRD-PRISM-PROMPT-V2：棱镜决策提示词 v2 与引擎边界

> **状态**：产品裁决，**只设计不改代码**。本文未修改 `src/**`、未 commit。
> **基线**：`v0.259.3`（`7888a21`）＋ **工作区未提交改动**（3 个 host 文件 + 4 个测试文件 + 1 个新增 P0 测试；见 §0.2）。
> **输入**：`docs/PROPOSAL-PRISM-DECISION-PROMPT.md`（639 行）、本机 `~/.dsh/dsh-tradewatcher/prism-{runs,orders,autot,settings}.json`（as-of 2026-11-27 17:00）、代码抽查 8 个执行点。
> **方法**：逐条复核提案 22 项；用实盘数据重算基线；抽查 `compileInput` / `accountSnapshotOf` / `clampDecision` / `parseDecisionDetailed` / `placeAutoTPairs` / `evaluateAutoT` / `thesisOf` / `rejectReasonOf`。`npm run typecheck` 通过；`src/host/prism*.test.ts` **247 条全绿**（含工作区新增的 16 条 P0 测试，见 §0.2），未跑全量 `npm run check`。
> **分层**：提示词只负责判断；数字、闸门、状态由引擎给。本文裁决“做什么 / 不做什么 / 怎么验收”，不写实现代码。

---

## 0. 裁决摘要

### 0.1 五句话结论

1. **提案方向对，顺序错**：v2 依赖的 `buyBudget`、`accountView`、`roundType`、候选池白名单、T 腿状态都在提案“第 2 期”，却把提示词重写放在“第 1 期”。先上 v2 = 让模型引用不存在的字段，只能猜。
2. **分期按“执行点”切，不按严重度切**：引擎有闸门的进第 1 期（含提案标 P1 的 P1-3、P1-4）；只有提示词执行点的进第 2 期（含提案标 P0 的 P0-5、P0-6、P0-9）；没有执行点也没有数据支持的**不做**（P1-12）。
3. **P1-3 / P1-6 / P1-7 做，但要改口径**：P1-3 改为 `pairId` 回显保留；P1-6 一句话定死且不改骨架文件；P1-7 拆成“新闻做 / 外盘数据不做 / 无数据短路”。
4. **提案的验收基线过期**：结构拒绝率 33% 是全量历史（108/366=29.5%），**近 3 个交易日 0/139=0%**；tPlan 通过率不是 33%，真实可判定样本 20/35=**57.1%**；autoT `results=0`，“成交率 5.7%→30%”不成立。
5. **两期合计 0 个新增 UI 元素，不需要 HTML 原型**：只有“决策流加本轮类型徽标 / 加未通过门槛分组 / autoT 弹窗加计划列”三个想法属大改，本期都不做。

### 0.2 评审前置：工作区已有 P0 实现，但与产品裁决有 3 处冲突

工作区有未提交的 P0 实现（as-of 2026-11-27 17:15；测试头标 v0.259.4：3 个 host 文件 + 4 个既有测试调整 + 新增 `prismDecisionP0.test.ts` 16 条），当前 `src/host/prism*.test.ts` **247 条全绿**、`npm run typecheck` 通过。来源未在本文归属。**它不是干净基线，也不能直接当最终实现**——有 3 处产品裁决冲突：

| 冲突 | 现实现 | 本文裁决 | 影响 |
| --- | --- | --- | --- |
| **C1 总仓安全默认** | `maxPosPct=null` ⇒ 不按总仓裁剪；新测试 P0-1① 明确断言“不产生总仓裁剪”；`limits.totalPct=null` | `effectiveTotalPct = maxPosPct ?? (minCashPct>0 ? 100−minCashPct : 95)`；`limits.totalPct` 写 effective 值 | 不补 ⇒ `minCashPct=0` 时无上限；补 ⇒ 改 P0-1①/③ 两条测试 |
| **C2 可买额度带“参考价⇒股数”** | 快照写“参考价 10.000 元/股 ⇒ 15900 股”；参考价取全池最低价 | 只给元；股数由目标标的价决定 | 模型会把最低价标的的股数套到高价标的上 |
| **C3 行业上限仍由模型补位** | `limits.byIndustry = { ...model.byIndustry, ...settings.industryLimits }`；live `industryLimits={}` ⇒ 模型自报的“当前暴露”变成硬上限 | `byIndustry` 只认 settings；模型值只作展示，不作上限 | 任何已持有板块的加仓都会被裁 0（上限=当前暴露）；这是“想加也加不进去”的结构性原因，是否构成今日空单主因需回放验证 |

**已覆盖、无需重做**：P0-2 快照缺价、P0-3 `buyBudget` 主体、P0-5 上下文口径、P0-7 零股（120/100/150 三组）、P0-8 解析抬升、P0-10 池外拒单。**仍缺**：P0-2 `clampDecision` 缺价 fail-open、P0-5 `isEtf`、P0-11 行业权威、P1 全部。

**第 0 步（0.5 人日）**：确认 WIP 归属 → 对 C1/C2/C3 做产品裁决并改对应断言 → 跑 `npm run check` 全绿 → 再进第 1 期。

### 0.3 裁决表

| # | 裁决 | 直接后果 |
| --- | --- | --- |
| **D1** | 分期按执行点切：引擎闸门/数据 → 第 1 期；提示词 → 第 2 期；上下文 → 第 3 期 | P0-5/6/9 进第 2 期；P1-3/4 的引擎侧进第 1 期 |
| **D2** | 第 1 期不改写提示词；只允许两处外科补丁：`limits` 回显、autoT 门槛改引用引擎 | 避免“新字段没人用”的中间态 |
| **D3** | P1-3 做，用 `tPlans[].pairId` 回显保留；不用“同参数逐字重报” | 引擎第 1 期；提示词第 2 期 |
| **D4** | P1-6 一句话定死：配置止损线 = 禁止加仓线；触发后必须给“减/不减”；引擎不自动卖；口径 = 买入均价 | 不改用户骨架文件；文案第 1 期、提示词第 2 期 |
| **D5** | P1-7 拆开：新闻做（重要优先 + 8K 字符上限 + 覆盖声明）；外盘/大宗**不做数据接入**，只做缺数据降权；第 3 期无数据短路 | 新闻第 1 期；降权第 2 期；短路第 3 期 |
| **D6** | P1-12 动作预算**不做** | 替代：`roundType` + 既有重复闸 + T 腿保留 |
| **D7** | `PlanState` 不新建文件；`plan` 挂 `PrismDecision` 随 `prism-runs.json` 走，跨日失效 | 不引入 `prism-plan.json` 的新生命周期/新损坏面 |
| **D8** | `decision.limits` 保留字段、由引擎填；模型输出里的 `limits` 解析后丢弃并留痕；`clampDecision` 不读模型值 | schema 兼容、UI 零改动 |
| **D9** | `note` ≤120 字；空单固定“不买：…；不卖：…”；接受“个股研判覆盖率下降” | 小改；note 只点名本轮有动作/有明确判断的 ≤3 只 |
| **D10** | 验收四指标 + 三护栏；**结构拒绝率是护栏不是目标**（近 3 日已 0%） | 防止拿过期基线做 Go/No-Go |

### 0.4 与提案的 7 处分歧（先纠正再执行）

| # | 提案说法 | 复核结果 | 本文裁决 |
| --- | --- | --- | --- |
| 1 | “第 1 期：提示词 + 最小引擎改动，1 人日” | v2 依赖的字段在提案第 2 期；1 人日低估至少 5 倍 | 第 1 期只做引擎，5–7 人日；v2 第 2 期 3–4 人日 |
| 2 | “P0-1 模型写 100 时总仓上限消失” | `minCashPct=5` 是隐性硬顶，实际最多 95%；真正的洞是 `maxPosPct=null` 时上限不可见、`minCash=0` 时无上限 | 仍是 P0，但优先级低于 P0-2/3；补 `effectiveTotalPct` 安全默认 |
| 3 | “P1-3 条件不变原样重报” | `placeAutoTPairs` 以“本轮是否重报 + 参数完全一致”为生杀条件；1 分钱漂移即杀腿重挂 | 改 `pairId` 回显保留 |
| 4 | “结构拒绝率 33%→<5%” | 33% 是全量历史；近 3 个交易日 0/139；近 5 日 20/204=9.8% | 目标改 ≤2% 护栏，不作为主 KPI |
| 5 | “tPlan 通过率 20/60=33%” | 25 条计划无 `gateCode`（11-26 旧记录），不应当分母；真实 20/35=57.1% | 基线 57.1%，目标 ≥85% |
| 6 | “autoT 成交率 70 笔中 4 笔（5.7%）→>30%” | 70 是**腿**不是计划；`results=0`，结算链未闭环，24 笔 trades 只到单腿 | 本期**不设成交率目标**；先修计划存活/撤单 |
| 7 | “note 统一 ≤120 字” | `thesisOf` 按“note 是否提到股票名/代码”生成个股研判；120 字覆盖不了 11 只持仓 | 接受覆盖率下降；note 只点名 ≤3 只有动作/判断的标的 |

---

## 1. 问题 1：P0/P1 逐项裁决

### 1.1 分期原则：严重度 ≠ 期数

- **P0/P1 是严重度**，回答“多痛”；**期数是执行点**，回答“改哪里”。
- 引擎有闸门/数据源的 → 第 1 期，即使提案标 P1（P1-3、P1-4、P1-7a）。
- 只有提示词能执行的 → 第 2 期，即使提案标 P0（P0-5、P0-6、P0-9）。
- 既无执行点、又无数据支持的 → **不做**（P1-12），不要写进提示词当“建议”充数。

### 1.2 P0 逐项

| 编号 | 提案 | 裁决 | 期 | 执行点 / 说明 |
| --- | --- | --- | --- | --- |
| **P0-1** | 总仓上限可由模型自报 | **做**（WIP 半） | 第 1 期 | `clampDecision` 只认 `constraints.maxPosPct`；补 `effectiveTotalPct = maxPosPct ?? (minCashPct>0 ? 100−minCashPct : 95)`；`limits.totalPct` 写 effective 值；`limits.note` 由引擎写“默认值（未配置）” |
| **P0-2** | 同一仓位两套分母 | **做**（WIP 基本） | 第 1 期 | 唯一 `accountView`；缺价 → `—` + 原因；**补 fail-closed：任一持仓缺价 ⇒ 拒所有买单**（现在 `totalAssets` 按 0 算，`minCash` 仍放行） |
| **P0-3** | 可买额度 = 现金 | **做**（WIP 已） | 第 1 期 | `buyBudgetOf()`；**快照只给元，删“参考价⇒股数”**（参考价取全池最低价，模型会误当目标标的股数） |
| **P0-4** | 提示词不知道周期/时间 | **做**（只注入） | 第 1 期 | `roundType` 纯函数 + `run.roundType` + 注入 `intervalSec/slot/minToClose/minToAmClose/dataAt`；规则：**时段首轮=plan；≥14:30=close；其余=execute**；与 `intervalSec` 解耦；手动重放按时刻判定并标 `manual`；提示词第 2 期才引用 |
| **P0-5** | T 门槛两套、提示词写错 | **做**（WIP 已改上下文） | **第 2 期** | 闸门 `evaluateAutoT` 本身正确；缺陷在“模型看到的口径 + 提示词硬编码 1.5%/3%”。必须与 v2 同版删，否则中间态更差（振幅口径变小、提示词仍要 3%，模型会全面停做 T）。**第 1 期只补 `isEtf` 传参** |
| **P0-6** | A 股制度约束缺失 | **做** | **第 2 期** | 提示词加【A 股制度与引擎闸门】；文本由 `PRISM_GATE_RULES` 常量生成，不手写数字 |
| **P0-7** | 零股无法卖出 | **做**（WIP 已） | 第 1 期 | `rejectReasonOf` + `clampDecision` 已开口；测试已覆盖 120/100/150 三组，补“可卖 100、持仓 120”一条；只开“卖出 + 一次性清仓”，不开买入零股 |
| **P0-8** | 解析失败不升 `run.error` | **做**（WIP 已） | 第 1 期 | `parseError` 已抬升；可选：把被丢弃单进 `decision.rejects`（原因“字段非法被丢弃”），让 RISK 卡直接可见 |
| **P0-9** | `note` / `limits.note` 契约冲突 | **做** | **第 2 期** | `note` ≤120；空单两段；删除模型输出 `limits`/`limits.note`；`limits.note` 改引擎写 |
| **P0-10** | 候选池 80 行 vs 自选 99；引擎不校验 | **做**（WIP 已） | 第 1 期 | `applyCandidatePoolGate()`；**白名单 = 全量持仓 + 全量可交易自选，不受 80 行显示截断影响**；补单测 |
| **P0-11** | **提案未列：行业上限仍由模型补位** | **做** | 第 1 期 | `limits.byIndustry = { ...model.byIndustry, ...settings.industryLimits }` 且 live `industryLimits={}` ⇒ 模型把“当前暴露”写成 `byIndustry` 后被当硬上限，板块加仓全被裁 0。裁决：`byIndustry` 只认 `settings.industryLimits`；模型值只作展示、不进 `clampDecision`；`limits.byIndustry` 由引擎填 |

> 本机实测：11 只持仓 + 11 只自选 = 22，80 行截断当前不复现；但截断逻辑仍在，闸门仍要做。

### 1.3 P1 逐项

| 编号 | 提案 | 裁决 | 期 | 执行点 / 说明 |
| --- | --- | --- | --- | --- |
| **P1-1** | 风险暴露规则偏卖出 | **做** | 第 2 期 | 四项硬检查（止损/单票行业总仓/回撤闸门/低波端），逐项写“触发/未触发 + 余量”；四项未触发不要求动作、不要求辩护 |
| **P1-2** | 绝对量词制造元解释 | **做（删）** | 第 2 期 | 删提示词整条；同时删 `candidatesTextOf` 表头那句“使用唯一/全部/所有前必须…” |
| **P1-3** | 每轮重审计，旧 T 腿被替换 | **做（改 pairId）** | 引擎第 1 期 / 提示词第 2 期 | 见 §1.5.1 |
| **P1-4** | 没有上一轮决策状态 | **做** | 引擎第 1 期 / 提示词第 2 期 | 注入上轮 note、clampEvents、tPlan gate、rejects、plan 摘要；≤1.5K 字符 |
| **P1-5** | 撤单没有规则 | **降级为建议** | 第 2 期 | 引擎无法判定“叙事证伪”，写成“强制”就是无执行点的规则；只写建议 + 用撤单率验收 |
| **P1-6** | 止损语义三套 | **做** | 文案第 1 期 / 提示词第 2 期 | 见 §1.5.2 |
| **P1-7** | 新闻不是 24h；外盘/大宗无数据 | **拆开** | 新闻第 1 期 / 降权第 2 期 / 短路第 3 期 | 见 §1.5.3 |
| **P1-8** | 汇总 5 条要点没人看 | **做** | 第 2 期 | summary 改 3 行（结论/分歧/盯什么，每行 ≤50 字）；UI 只把它当 ANALYZE 兜底，0 改动 |
| **P1-9** | 重复被拒容差教微调 | **只做提示词侧** | 第 2 期 | 引擎 `isDuplicateRejected` 的 ±100 股/±0.5% **不动**（盲收紧会把“涨停打开后重报”误杀）；提示词写“被拒后不改价改量重报，除非可卖/价格条件已变化并写明” |
| **P1-10** | `tPlans` 的 `shares=0` 说明项被丢弃 | **做（删）** | 第 2 期 | 提示词删除该允许项；WIP 已把 `shares>0` 的丢弃计入 `parseError` |
| **P1-11** | 同产品/涨跌停/停牌只由引擎拦 | **并入 P0-6** | 第 2 期 | 不单列；统一进制度块 |
| **P1-12** | 没有每轮动作预算 | **不做** | — | 见 §1.5.4 |

### 1.4 第一期清单（可直接开工）

**做（8 项 P0 引擎侧 + 4 项 P1 引擎侧 + 1 项 P0 小补）**：

1. P0-1 总仓权威 + 安全默认（补 WIP 缺口）
2. P0-2 账户视图 + 缺价 fail-closed（补 WIP 缺口）
3. P0-3 `buyBudget`（去“参考价⇒股数”）
4. P0-4 `roundType` / `slot` / `minToClose` / `dataAt` 注入
5. P0-7 零股卖出（WIP 已写，补 1 条边界测）
6. P0-8 解析失败可见（WIP 已写，收口）
7. P0-10 候选池白名单（WIP 已写，补测）
8. P1-3 T 腿 `pairId` 保留（引擎侧）
9. P1-4 上一轮状态注入（引擎侧）
10. P1-7a 新闻 24h（重要优先 + 上限 + 覆盖声明）
11. P1-6a 止损文案/骨架优先级（引擎侧文本）
12. P0-5b `isEtf` 传参（引擎侧一行）
13. P0-11 行业上限只认 settings（模型 `byIndustry` 只展示）

**不做/延后**：

- P0-5 提示词门槛改写、P0-6 制度块、P0-9 note 契约 → 第 2 期
- P1-1/2/5/8/9/10/11 → 第 2 期
- P1-12 动作预算 → 不做
- P1-7b 外盘/大宗数据接入 → 不做
- `PlanState` 新文件 → 不做（挂 `decision.plan`）
- 上下文裁剪、四路合并、任何新 UI → 第 3 期或不做

### 1.5 四个专项裁决

#### 1.5.1 P1-3 保留旧 T 腿：做，但改成 `pairId` 口径

**提案写法不可执行**。`placeAutoTPairs` 现在的生杀条件：

- `tPlans === undefined`（字段缺失）⇒ 提前返回，旧腿保留；
- `tPlans: []`（明确空）⇒ 所有旧腿被撤，`cancelReason = '每轮重审计：计划变更或本轮不计划'`；
- 同标的、同开腿方向、**同价格、同股数** ⇒ 保留；否则杀旧腿、重挂新腿。

所以“条件不变原样重报”要求模型每轮逐字复述价格/股数；1 分钱漂移就杀腿重挂。实盘 11-27 有 20 条 gate ok 的腿，最终 20 条全被撤（12 条“每轮重审计”、8 条“截止”），0 成交。

**裁决**：

1. `autoTContextOf` 注入【现有 T 腿】：`pairId / secid / direction / openPrice / shares / expireAt / 已成交股数`。
2. `tPlans[]` 增加可选 `pairId`。命中同标的、同方向的 pending pair ⇒ 直接 `keep`，不比对价格/股数、不重跑 gate、不新建单。
3. 未带 `pairId` 的才是新计划，必须过 `evaluateAutoT`；`pendingShares` 传**真实值**（现在写死 0，`pending-conflict` 永不触发）。
4. 既没带 `pairId`、也没重报的旧腿 ⇒ 撤（保持“不报即撤”的现有语义，避免僵尸腿）。
5. 提示词规则：“已有腿逐条用 `pairId` 回显保留；只有条件失效才不写；不得改价重挂。”

**不做什么**：不做“价格接近就保留”的模糊匹配（会把失效腿留住）；不做自动改价追价；不新增 `prism-plan.json`。

**期**：引擎第 1 期；提示词第 2 期。

#### 1.5.2 P1-6 止损语义：做，一句话定死

现状三套：

- 骨架（用户文件 `prism-skeleton.md:71`）：“止损条件是叙事证伪，不是价格。”
- 提示词：“判断浮亏是否触及止损线必须用买入均价，不得用摊薄成本。”
- 引擎：`clampDecision` 在 `lossPct <= -stopLossPct` 时**只拒买**，不卖。

**裁决（一句话）**：**配置止损线 = 禁止加仓线；触发后模型必须给“减/不减”判断；引擎不自动卖；判断口径 = 买入均价 `avgCost`，不是摊薄成本。**

执行点：

- 引擎：`stopLoss` 事件/reject 文案统一为“已触及止损线（禁止加仓）”；`PrismClampSkip.stopLoss` 保留“缺买入均价未判”。
- 提示词：【引擎硬边界】写“骨架的叙事止损 = 清仓判断依据；配置止损线 = 禁止加仓线；两者并行，冲突以引擎为准”。
- **不改 `prism-skeleton.md`**：它是用户配置，改了会覆盖用户内容；只在提示词里加优先级声明。
- `decisionProblems` / 文案统一使用“减/不减”，不用“止损/不止损”（后者暗示引擎会卖）。

**不做什么**：不做自动止损卖单；不把骨架的“叙事证伪”删掉；不新增 `stopLossMode` 设置。

**期**：文案第 1 期；提示词第 2 期。

#### 1.5.3 P1-7 新闻 24h / 外盘数据：拆开，一个做、一个不做

**新闻：做。** 但不能“24h 全量”：

- 实测 24h `prism-news.json` = **952 条 / 99,082 字符**，important 219 条；全量 5 次调用会把 token 打爆。
- 现 `compileInput` `slice(0,30)` = 2,832 字符，17:02 时只覆盖 29 分钟（盘中约 44 分钟）。
- 裁决：**重要优先 + 时间倒序 + 上限 8,000 字符（约 80 条）**；段头写“覆盖 24h，共 952 条，展示 80 条，省略 872 条（重要 219 条中展示 60 条）”。只进信息面一路；决策轮只给“信息面结论 + ≤10 条重要标题”，不给全量。
- 观测：`run.usage.newsChars` 与 `run.newsMeta{from,to,total,shown}`。

**外盘/大宗：不做数据接入。**

- `prismInputsOf` 没有外盘/大宗行情字段；四路里 `overseas`/`commodity` 两路拿不到对应数据，live summary 自认“三项全缺”仍给方向。
- 接数据要新数据源、新口径、新失败模式，且无法用现有数据验收。**本期不买数据源、不用 A 股/相关 ETF 代理外盘**。
- 第 2 期只做提示词降权：无数据写 `—（缺数据）`，该路只作参考、不得当方向证据；四路 digest 必须列出全部四路，失败写 `—（失败：原因）`，不得只拼可用三路。
- 第 3 期做“无数据短路”：`overseas`/`commodity` 无数据时不调用 LLM，卡片文本写 `—（缺数据：未接入外盘/大宗行情，本路不参与决策）`。5 次调用降到 3 次，token 直接 −40%。**卡片仍在、布局不变，属小改。**

**期**：新闻第 1 期；降权文案第 2 期；短路第 3 期。

#### 1.5.4 P1-12 动作预算：不做

**理由（数据）**：

- 11-27 20 轮：19 轮 0 单、1 轮 1 单；11-26 单日 85 单是异常日。预算不解决任何现有问题。
- 按 `intervalSec` 给 1/2/3 笔是拍脑袋，而且算术方向反了：300s×1 笔/轮 = **48 笔/日**，600s×2 笔/轮 = **48 笔/日**，1200s×2 = 24 笔/日，1800s×3 = 24 笔/日，3600s×3 = 12 笔/日。300 秒并不比 600 秒更紧。
- 引擎截断超预算的单 = **静默丢单**，违反本项目“不静默”的红线。
- 真正要治的是“同标的重复报/撤后重挂”，已由候选池闸、重复被拒闸、P1-3 的 `pairId` 保留覆盖。

**替代**：

- `roundType=execute` 不得改计划（第 2 期提示词）；
- T 腿不报即撤、报 `pairId` 即留（第 1 期引擎）；
- 重复委托闸保持现有 ±100 股/±0.5%，不收紧（见 P1-9）。

**重新立项的触发条件**（写死，避免拍脑袋）：连续 5 个交易日“单轮新委托中位 ≥2”或“同标的一日新开 ≥3 次”。届时再按实测分布定预算，不按周期档位拍。

---

## 2. 问题 2：提示词 v2 的用户可见行为变化

### 2.1 行为变化清单

| # | 变化 | 现在 | v2 | 用户看到什么 | UI 级别 |
| --- | --- | --- | --- | --- | --- |
| **B1** | `note` 长度 | 88–320 字，中位 180；14:50 那条 320 字在“现金”处截断 | ≤120 字；空单两段各 ≤60 字 | 决策流 SCAN 行“依据”从 3 行 clamp 变 2 行（≤1 行变化）；展开按钮仍在；不再出现半句截断 | **小改**（只换文本） |
| **B2** | 空单文案 | 提示词“一句话”与“空单两段”冲突，模型自由发挥 | 固定 `不买：…；不卖：…` | SCAN 行结构稳定；`decisionProblems` 可校验 | **无改动** |
| **B3** | 周期/时间提示 | 提示词不知道 300s/3600s；14:30 后仍开新 T | 注入 `intervalSec/roundType/slot/minToClose`；14:30 后 `close` 只平 T/减仓/撤单 | 底条仍显示“决策周期 300s”（已有）；14:30 后不再出现新仓/新 T；同一标的不再每 5 分钟改计划 | **无改动** |
| **B4** | 拒绝原因展示 | `decision.rejects` 已在 RISK tab 全文展示；`clampEvents` 也在；tPlan gate 在 autoT 弹窗；`parseError` 只在 SCAN 行 | 解析丢弃的订单/计划进 `rejects`；`run.error` 非空时 SCAN 行显示“解析失败/执行失败” | 复用既有 RISK/SCAN 卡片；不新增展示位 | **无改动** |
| **B5** | 个股研判覆盖（隐性） | `thesisOf` 按 note 是否提到股票名/代码生成；320 字能覆盖 7–8 只 | 120 字只能覆盖 ≤3 只；其余显示 `—（该股暂无研判）` | 持仓详情里的“AI 研判”空态变多 | **小改**（空态文案已是现成常量） |
| **B6** | 零股可卖（能力） | 120 股持仓无法一次清仓，note 出现“不足整百无法减” | 卖出一次性清仓含零股 | 招商轮船 120 股可一次卖出；不再出现“不足整百” | **无改动**（数据/引擎） |
| **B7** | T 腿存活（autoT 弹窗） | 计划每轮被重审计撤/重挂，存活中位 5 分钟 | 带 `pairId` 回显即保留，14:50 截止 | autoT 弹窗里同一计划不再每 5 分钟消失又出现 | **无改动**（列表数据） |
| **B8** | 解析失败可见 | 丢单静默成 0 笔 | `run.error` + `parseError`；RISK/SCAN 行可见 | 出错时能看到“解析失败：orders 中有 N 笔字段非法被丢弃” | **无改动**（复用既有风险标签） |

### 2.2 UI 改动分级（沿用 `PRD-FACTOR.md` §3.1 的用户规则）

| 级别 | 判定 | 流程 |
| --- | --- | --- |
| **无改动** | 只动宿主/数据/日志/提示词，用户看不到像素变化 | 工程自测 + 本文验收 |
| **小改** | 只替换已有文本/字段/表头/单个按钮；不新增行、列、卡片、面板、页；布局盒尺寸变化 ≤1 行 | **产品决定**，本 PRD 即决策记录，**不需要 HTML** |
| **大改** | 新增面板/页/tab/列/卡片组，或改变弹窗高度分配、滚动结构、信息层级 | **必须先出 HTML 原型给用户审核**，审核通过才实现 |

**逐项分级**：

| ID | 改动 | 级别 | 是否需要 HTML |
| --- | --- | --- | --- |
| B1 note ≤120 | 替换文本 | 小改 | 否 |
| B2 空单两段 | 替换文本 | 无改动 | 否 |
| B3 周期/时间 | 提示词内部；底条已有 | 无改动 | 否 |
| B4 拒绝原因 | 复用既有 RISK/SCAN | 无改动 | 否 |
| B5 个股研判空态 | 既有常量 `—（该股暂无研判）` | 小改 | 否 |
| B6 零股 | 引擎能力 | 无改动 | 否 |
| B7 T 腿存活 | autoT 列表数据 | 无改动 | 否 |
| B8 解析失败 | 既有风险标签 | 无改动 | 否 |

**结论：第 1、2 期合计 0 个新按钮、0 个新卡片、0 个新列、0 个新面板、0 处结构高度变化；B1 的 SCAN 行可能少 1 行，属文本驱动，不新增行/列/卡片；不需要 HTML 原型。**

**只有以下三项属大改，本期不做、也不“顺手做”**：

1. 决策流 SCAN 行加“本轮类型/决策周期”徽标（新增信息层级）；
2. 决策流加“今日未通过门槛”分组（`PRD-FACTOR` B2 已判大改）；
3. autoT 弹窗加“计划存活/`pairId`”列（新增列）。
   若用户明确要求，先出 `docs/prototype/prism-*.html`，再评审。

### 2.3 文案规格（可直接施工）

**note（空单）**：

```
不买：<≤60 字，写触发条件/额度/估值三者中最主要的一条>；不卖：<≤60 字，写止损/减仓/低波端中最主要的一条>
```

**note（有单）**：≤120 字，必须点名本轮有动作的标的（≤3 只），不得写“唯一/全部/所有”。

**个股研判空态**：沿用 `THESIS_NONE = '—（该股暂无研判）'`；不新增“本轮未判断”之类新文案。

**tPlan gate 文案**：沿用现有 `条件不足 · {gateDetail}`；不新增颜色/图标。

**解析失败文案**：`解析失败：{parseError}`；`parseError` 已包含“orders 中有 N 笔字段非法被丢弃（原始 M 笔）”。

---

## 3. 问题 3：验收标准

### 3.1 四个主指标（目标值 + 观测方式）

| # | 指标 | 定义（必须可计算） | 实测基线（2026-11-27） | 目标 | 观测方式 |
| --- | --- | --- | --- | --- | --- |
| **M1** | **结构拒绝率** | 结构闸拒绝笔数 ÷ 提交委托笔数。结构闸 = T+1 / 涨跌停 / 停牌 / ±3% 偏离 / 费用门槛 / 同产品 / 候选池外 / 重复被拒。**排除**盘后不下单、无持仓、资金不足 | 全量 **108/366 = 29.5%**；近 5 日 **20/204 = 9.8%**；近 3 日 **0/139 = 0%** | **≤2%**（滚动 5 个交易日，分母 ≥20 笔）；T+1 类必须为 0 | 读 `prism-orders.json` 的 `rejectReason` 按前缀归类；`scripts/prism-metrics.mts` 每日收盘后跑；按 `day` 滚动 |
| **M2** | **tPlan gate 通过率** | `evaluateAutoT.ok` 的 plans ÷ **有 `gateCode`** 的 plans（无 gate 结果的旧记录不计分母） | **20/35 = 57.1%**（11-27；15 条 `atr-rank-low`）；全量 20/60=33.3% 是错分母 | **≥85%**（首月 ≥80%）；`atr-rank-low` 占比 **<10%** | 读 `prism-autot.json` 的 `plans[].gateCode/gateVersion` + `prism-factor/` 日志；按 `gateVersion` 分组，不跨版本混算 |
| **M3** | **重复撤单率** | ① 模型撤单率 = 模型主动撤单 ÷ 总委托；② 撤后 10 分钟内同指纹重挂 ÷ 撤单；③ 撤单中位存活 | ① **92/366 = 25.1%**；② **12/92 = 13.0%**（精确同价 0 笔）；③ **5.0 分钟** | ① **<10%**；② **<5%**；③ **>30 分钟** | `prism-orders.json` 的 `cancelReason/decidedAt/cancelledAt`；同 `secid+side+price(±0.5%)+shares(±100)` 配对；按滚动 5 日 |
| **M4** | **token 成本** | `inputChars/轮`（5 次调用输入字符合计）+ `outputChars/轮` + `calls/轮` | **未实测**；按段落估算 **110–140K 字符/轮**；output **13–15K 字符/轮**；calls=5 | 第 2 期 output **−20~25%**；第 3 期 input **−40%**；calls **5→3** | 第 1 期新增 `run.usage={inputChars,outputChars,calls}`；LLM 接口当前不返回 usage，**以字符为准**，不编 token 数 |

> **M1 的口径警告**：提案把“120/366=33%”当基线，其中 9 条盘后、3 条无持仓，不是提示词能修的；且 11-25 起已无 T+1 拒绝。**M1 是护栏（不得回升），不是主 KPI。**
> **M2 的口径警告**：25 条 11-26 的旧计划没有 `gateCode`，把它们算失败会得到 33% 的假基线。
> **M3 的口径警告**：135 条撤单里 13 条手动、8 条截止、6 条次日失效、3 条开关关闭，不是模型 churn；模型主动撤单只算 92 条。
> **M4 的口径警告**：提案的“85–100K token”没有计量依据；先测字符，再谈 token。

### 3.2 护栏（Go/No-Go 必须同时看）

| # | 护栏 | 目标 | 为什么 |
| --- | --- | --- | --- |
| **G1** | 未触发轮空单 | 无风控事件的 `execute` 轮，`orders` 中位 = 0；不得为了“有动作”把中位推到 ≥1 | 防模型变勤/变懒两个方向 |
| **G2** | 回放一致性 | 同一输入跑 3 次，`orders` Jaccard ≥0.8 | 防提示词把决策变成随机 |
| **G3** | 解析/丢单 | `parseError=0`、`orders` 丢弃=0；`run.error` 与真实失败一一对应 | 防“0 笔被当成没动作” |
| **G4** | 零股 | 120 股全卖 replay 必须成交；不得出现“非100股整手” | 防零股改动回归 |
| **G5** | note | ≤120 字 100%；空单两段 100% | 防格式回退 |

### 3.3 Go/No-Go

- **第 1 期 Go**：`npm run check` 全绿；C1/C2/C3 裁决落地并改完断言；连续 5 个交易日 M1 无新增结构拒绝；G4 通过；`run.usage` 有值；`maxPosPct=null` 时 `clampEvents` 出现 `total` 维度。
- **第 2 期 Go**：离线回放 48 轮（`prism-replay/` 历史输入）满足：JSON 合法 100%、M1 ≤2%、M2 ≥80%、`orders` 数 ≥ v1 的 70%、note ≤120 100%；再跑 1 天影子（不落单）无异常；才把 `promptVersion` 默认切 v2。
- **第 3 期 Go**：M4 input −40%、calls 3；M2 不低于第 2 期；M1 不回升；`npm run check` 全绿。

> **不要用“读起来更顺”验收。** 三个硬门：M2、M3、G1；M1 是护栏。

### 3.4 样本量纪律

- 单日委托 <20 笔时，**只报计数不报率**；M1/M3 用滚动 5 日，M2 用滚动 10 个交易日或 ≥35 条 gate 样本。
- 11-26 是异常日（85 单/69 撤/0 拒），任何全量平均都会被它带偏；报表必须同时给“含 11-26 / 不含 11-26”两列。
- 离线回放优先于线上 A/B：线上 300 秒周期 × 5 次 LLM 调用，样本积累慢且不可回滚；回放可固定输入、重复跑。

---

## 4. 问题 4：分期

> 用户口径：**第 1 期 = P0 引擎正确性 → 第 2 期 = P1 提示词 v2 → 第 3 期 = P2 上下文裁剪**。本文正文用“第 N 期”，避免与提案的 P0/P1 严重度混号。

### 4.1 第 0 步：工作区收口（0.5 人日，前置）

| 任务 | 交付 |
| --- | --- |
| 确认 3 个 WIP 文件的归属与去留 | 保留 / 回退的书面结论 |
| 补 P0-1 安全默认 | `effectiveTotalPct` 单测：`maxPosPct=null, minCashPct=5` ⇒ 95%；`minCashPct=null` ⇒ 95% |
| 落地 C1/C2/C3 裁决 | 改 P0-1①/③、P0-3③ 三条测试；补行业上限只认 settings 的单测 |
| 补 P0-2 fail-closed | 缺价 ⇒ 买单拒绝单测 |
| 跑 `npm run check` | 全绿才进第 1 期 |

### 4.2 第 1 期：引擎正确性（P0，5–7 人日）

**目标**：模型看到的每个数字都是引擎算的；引擎的每个拒绝都有原因；零股能卖；解析失败可见；T 腿能留。

| # | 改动 | 文件/函数 | 人日 |
| --- | --- | --- | --- |
| 1 | `accountViewOf()`：全持仓实时价、缺价 `null`+原因、总资产/权重/可买额度唯一来源；缺价 fail-closed | `prismRoutes` / `prismAccount.clampDecision` | 1.5 |
| 2 | `effectiveTotalPct` + `limits` 引擎填充 + `limits.note` 引擎写 + `maxCumDDPct`/默认值写入 | `prismRoutes.limitsTextOf` / `prismAccount.clampDecision` | 1.0 |
| 3 | `buyBudgetOf` 收口：只给元、删“参考价⇒股数”；任何缺价 `—`；总仓剩余用 `effectiveTotalPct` | `prismRoutes` | 0.5 |
| 4 | `roundType` 纯函数 + `run.roundType` + 注入 `intervalSec/slot/minToClose/minToAmClose/dataAt`；时段首轮=plan、≥14:30=close、其余=execute | `prismScheduler` / `prismPipeline.compileInput` / `prismRoutes` | 0.5 |
| 5 | 零股 4 个边界单测（120→120 / 120→100 / 可卖 100 持仓 120 / 220→220） | `prismAccount.test.ts` | 0.5 |
| 6 | 解析失败：被丢弃单进 `rejects`（可选）；`decisionProblems` → `run.noteProblems`（先改 `totalPct=null` 判定） | `prismPipeline` | 0.5 |
| 7 | 候选池白名单单测；池 = 全量非截断 | `prismRoutes` | 0.5 |
| 8 | T 腿 `pairId`：注入现有腿、`tPlans[].pairId`、真实 `pendingShares`、`isEtf` 传参 | `prismRoutes.placeAutoTPairs` / `prismGates` | 1.0 |
| 9 | 上轮反馈：`lastNote/clampEvents/tGateResults/rejects/plan` 摘要 ≤1.5K | `prismRoutes.prismInputsOf` | 0.5 |
| 10 | 新闻 24h：重要优先 + 8K 上限 + 覆盖/省略计数；四路 digest 失败标注 | `prismPipeline.compileInput` | 0.5 |
| 11 | 止损文案统一（引擎侧）+ 骨架优先级声明 | `prismAccount` / `prismRoutes.limitsTextOf` | 0.2 |
| 12 | `run.usage` + `prism-replay/<day>-<slot>.txt`（仅决策调用输入 + settings 快照，保留 10 个交易日）+ `scripts/prism-metrics.mts`（M1–M4 报表） | `prismPipeline` / `scripts/` | 1.0 |
| 13 | 行业上限权威：`byIndustry` 只认 settings，模型值只展示 | `prismRoutes.runPrismForSlot` / `prismAccount.clampDecision` | 0.5 |

**不做清单**：

- 不改写提示词（只保留 WIP 已有的 `limits` 回显、T 门槛引用两处）；
- 不做 `PlanState` 新文件；不做动作预算；不做撤单原因码；
- 不接外盘/大宗数据；不做上下文裁剪；不做任何新 UI；
- 不收紧 `isDuplicateRejected` 的 ±100/±0.5%；
- 不改 `prism-skeleton.md`。

**退出条件**：§3.3 第 1 期 Go 全部满足。

### 4.3 第 2 期：提示词 v2（P1，3–4 人日 + 1 天回放）

**目标**：把“模型替引擎算账”改成“引擎给边界，模型做判断”；输出契约稳定；token 输出降 20–25%。

| # | 改动 | 交付 |
| --- | --- | --- |
| 1 | 提示词文件化 `src/host/prompts/prism-decision.md`（P2-2 提前） | 模板 + 版本号 `prism-decision-v2` |
| 2 | system + 本轮上下文 + 引擎硬边界（只读）+ 任务顺序（数据/风控/机会/做T）+ 判断规则 + 3 行摘要 + 最小 JSON | 完整 v2 |
| 3 | 输出契约：`roundType`（回显）、`plan`（可空）、`note` ≤120、`orders`、`cancel`、`tPlans`（含 `pairId`）、`noTrade{code,detail}`；删除模型 `limits`/`limits.note`/`shares=0` | `parseDecisionDetailed` 兼容解析 |
| 4 | autoT 段：门槛只引用引擎段；删除 1.5%/3%/1.2% 硬编码；`1.2%` 改“以引擎门槛为准” | `prism-decision.md` + 测试 |
| 5 | A 股制度块：T+1/涨跌停/停牌/整手/±3%/5000/0.2%/同产品/候选池/重复被拒；数字由 `PRISM_GATE_RULES` 生成 | 常量 + 模板 |
| 6 | 风险四项检查；删除绝对量词；撤单三因降级为建议；P1-9 写“被拒后不微调” | 模板 |
| 7 | summary 3 行（结论/分歧/盯什么，每行 ≤50 字） | 第 5 次调用 prompt |
| 8 | 测试语义化：`prismPrompt`/`prismTechPrompt`/`prismRejectDup`/`prismAutoT` 断言“包含哪些块/字段/常量来自代码”，不锁全文 | 4 个测试文件 |
| 9 | 离线回放 48 轮：旧 vs 新，同输入跑 `parseDecisionDetailed → clampDecision → applyDrawdownGate → evaluateAutoT` | 报告 `docs/REPLAY-PRISM-PROMPT-V2.md` |
| 10 | 影子 1 天：`settings.promptVersion='v2'` + `shadow=true`，不落单，记录 `wouldPlace` | 影子日志 |

**不做清单**：

- 不做上下文裁剪（第 3 期）；不合并/删除四路卡片；
- 不做动作预算；不接外盘数据；不加新 UI 徽标/分组/列；
- 不改引擎裁决逻辑（除 `pairId` 兼容解析）；
- 不设 autoT 成交率目标（`results=0`，结算链未闭环）。

**退出条件**：§3.3 第 2 期 Go；回放报告经用户确认；`promptVersion` 默认切 v2。

### 4.4 第 3 期：上下文裁剪（P2，3–5 人日）

**目标**：input −40%，calls 5→3，不降判断质量。

| # | 改动 | 预期节省 |
| --- | --- | --- |
| 1 | 骨架只在 system 放一次；决策轮只带 3 行“当前主线/证伪条件” | 2.5K×5 → 2.5K+0.3K，省 ~9.5K 字符 |
| 2 | 按角色裁剪：技术面只给指数+因子；信息面只给新闻+持仓；决策给全量但压缩 | 因子表 9K×5 → 2 次，省 ~27K |
| 3 | 候选池只给决策 1 次；按“持仓 + 前 N 只候选”压缩 | 6K×5 → 6K，省 ~24K |
| 4 | 行情摘要去重（现价/持仓明细三处重复） | 2.7K×5 → 2 次，省 ~8K |
| 5 | 外盘/大宗无数据短路：不调用 LLM，卡片写 `—（缺数据）` | calls 5→3，省 ~40% |
| 6 | 真实账户持仓压成一行或删除；缺价原因分类（停牌/代码无效/取数失败/确实没有） | 省 ~1K，减少误读 |

**不做清单**：

- 不改提示词语义/裁决规则；不删四路卡片（UI 信息层级属大改）；
- 不加新数据源；不做因子明细 B1；不做决策流“未通过门槛”分组；
- 不做 prompt cache（LLM 接口无 cache 字段）。

**退出条件**：§3.3 第 3 期 Go；M4 input −40%、calls 3；M2 不低于第 2 期。

---

## 5. 问题 5：风险

### 5.1 模型变“懒”

| 项 | 内容 |
| --- | --- |
| 机制 | v2 删除“若判断不减必须辩护”、强调“空单正常”、`execute` 轮禁改计划、`close` 轮禁新开 ⇒ 可能连续空单，漏掉应交易机会 |
| 观测 | G1“未触发轮空单中位=0”是**双向**护栏：既防乱下单，也防该动不动；回放对照 v1 的 `orders` 数；每周人工抽 5 轮看“四项检查”是否逐项写 |
| 缓解 | 回放要求新提示词 `orders` ≥ 旧 70%；上线 2 周保留 `promptVersion` 一键回滚；`close` 轮只禁“新开”，不禁“减仓/平 T” |
| 不接受 | 用“下单数”验收；用“读起来更顺”验收 |

### 5.2 总仓无配置

| 项 | 内容 |
| --- | --- |
| 现状 | `prism-settings.json`：`maxPosPct=null`、`maxDDPct=null`、`maxCumDDPct=null`；`minCashPct=5` |
| 风险 | WIP 已删模型兜底；若不再补默认，`maxPosPct=null` 时总仓维度消失，只剩 `minCash` 5% 的隐式 95%；若用户把 `minCashPct` 设为 0，则**完全无总仓上限** |
| 裁决 | `effectiveTotalPct = maxPosPct ?? (minCashPct>0 ? 100−minCashPct : 95)`；`limits.totalPct` 写 effective 值；`limits.note` 写“默认值（未配置 `maxPosPct`）”；`buyBudgetOf` 用同一个 effective 值 |
| 可见性 | UI 不读 `decision.limits`，不会新增展示；靠 CHANGELOG + `limits.note` 说明；**不要**把 95 写成“用户配置” |
| 验收 | 单测：`maxPosPct=null` ⇒ 买入被裁到 95%，`clampEvents` 有 `total`；`maxPosPct=60` ⇒ 裁到 60% |

### 5.3 零股改动

| 项 | 内容 |
| --- | --- |
| 现状 | WIP 已支持卖出一次性清仓含零股；本机有 120 股招商轮船、639 股奥士康、1186 股中国海油等零股 |
| 风险点 | ① `rejectReasonOf` 的 `fullLiquidation` 依赖 `order.shares === positionQty`；部分成交后 `remaining === positionQty` 的语义要测；② `clampDecision` 的 `availRaw >= heldQty` 才能全卖，T+1 锁定 20 股时只能卖 100；③ `applyFeeGate` 的 cleanup 用 `o.shares >= pos.qty`，部分卖出不豁免；④ 撮合/费用/持仓权重是否假设整手 |
| 缓解 | 只开“卖出 + 一次性清仓”；买入仍整手；4 个边界单测；`matchOrder` 已核实无整手限制；`applyFeeGate` cleanup 逻辑已核实 |
| 验收 | G4：120 股全卖 replay 成交；`非100股整手` 不再出现；220 股全卖不被裁成 200 |

### 5.4 schema 兼容

| 项 | 内容 |
| --- | --- |
| 新增字段 | `PrismDecision.roundType?`、`plan?`、`noTrade?`、`tPlans[].pairId?`；`PrismRun.roundType?`、`usage?`、`noteProblems?` —— **全部可选**，旧 runs 解析给默认值；回放输入落在独立 `prism-replay/`，不进 `prism-runs.json` |
| `limits` | 保留字段；引擎填充；模型输出丢弃并留痕；旧客户端不读（已核 `src/client/**` 无 `decision.limits` 引用） |
| `cancel` | 仍 `string[]`，不加原因码；撤单率用 `orders.json` 的 `cancelReason` 计算 |
| `prism-orders.json` | 无新字段；T 腿保留用现有 `tPlanId`/`pairId` |
| `run.error` | 语义扩展为“解析失败也算 error”；SCAN 行显示“解析失败/执行失败”，是既有样式 |
| 测试 | 4 个锁提示词原文的测试改语义断言；否则改一个字就红 |
| 回滚 | `settings.promptVersion` = `v1` / `v2`；引擎改动随整包版本回退；不新增账本类持久化文件（`prism-replay/` 只是回放文本，可随时删），无需迁移 |

### 5.5 其他风险

| 风险 | 缓解 |
| --- | --- |
| **WIP 未提交 + 3 处裁决冲突** | 第 0 步收口；C1/C2/C3 有书面裁决；保留/回退有结论 |
| **样本不足** | 单日 <20 笔只报计数；滚动 5 日；同时给“含/不含 11-26”两列 |
| **回放无输入** | 第 1 期落 `prism-replay/<day>-<slot>.txt`（仅决策调用输入 + `settings` 快照，保留 10 个交易日）；`PRISM_RUNS_KEEP=20` 不够 48 轮回放，不能只存 runs |
| **提示词文件化后测试失效** | 测试改为“包含哪些块/字段/常量来自代码”，不锁全文 |
| **`decisionProblems` 误报** | 接入前先改 `totalPct=null` 判定（effective 值上线后不再为 null） |
| **新闻 8K 上限仍可能挤占** | 只进信息面一路；决策轮只给 ≤10 条重要标题；`inputChars` 超 10K 时再降上限 |

---

## 6. 回滚

1. `settings.promptVersion`：`v2` → `v1`，下一轮立即生效；不需要重启。
2. 引擎改动：随整包版本回退（`git revert` 第 1 期提交）；不新增账本类持久化文件，无需数据迁移；`prism-replay/` 可直接删除。
3. `PlanState` 挂在 `decision.plan`，回退后旧 runs 解析忽略该字段，不破坏历史。
4. `tPlans[].pairId`：旧客户端/旧引擎忽略未知字段；新引擎对没有 `pairId` 的旧计划按“新计划”处理，行为不变。
5. 零股：回退 `rejectReasonOf`/`clampDecision` 两处即可恢复“仅整手”；`applyFeeGate` 的 cleanup 逻辑保留也安全。

---

## 附录 A：代码锚点（v0.259.3 + WIP）

| 位置 | 内容 |
| --- | --- |
| `src/host/prismPipeline.ts:88-110` | `compileInput`：骨架/账户/因子/候选/行情/新闻拼装；新闻 `slice(0,30)` |
| `src/host/prismPipeline.ts:183-207` | 决策提示词（5 条强制 + 止损/候选池/绝对量词） |
| `src/host/prismPipeline.ts:211-236` | `parseDecisionDetailed` 结果使用；WIP 已把 `parseError` 抬升 `run.error` |
| `src/host/prismRoutes.ts:159-230` | `accountSnapshotOf`；WIP 缺价 `—`、`buyBudgetOf` |
| `src/host/prismRoutes.ts:446-470` | `limitsTextOf`：无 `maxCumDDPct`、默认值未写 |
| `src/host/prismRoutes.ts:499-530` | `autoTContextOf`；WIP 改因子口径 + `AUTO_T_RULES` 门槛 |
| `src/host/prismRoutes.ts:877-955` | `placeAutoTPairs`：每轮重审计、`pendingShares:0`、`isEtf` 在 gate 内 |
| `src/host/prismAccount.ts:152-180` | `rejectReasonOf`：整手/零股/T+1/涨跌停/停牌 |
| `src/host/prismAccount.ts:510-580` | `parseDecisionDetailed`：`tPlans` 过滤 `shares>=100`；WIP 计 `tPlansDropped` |
| `src/host/prismAccount.ts:1540-1620` | `clampDecision`：卖出裁剪、总仓兜底、缺价 `missingPrice` |
| `src/host/prismGates.ts:10-40` | `AUTO_T_RULES`：1.0%/40/1.2%/1.2%/0.5%/20 元/0.3% |
| `src/host/prismGates.ts:111` | `const isEtf = false`（ETF 多算 0.1% 印花税） |
| `src/host/prismScheduler.ts:100-180` | `intervalDue`：300/600/1200/1800/3600；时段首轮立即触发 |
| `src/host/prismData.ts:114-141` | `thesisOf`：note 提到股票名/代码才有个股研判 |
| `src/host/prismStore.ts:241` | `PRISM_RUNS_KEEP`：只留最近 20 轮 |
| `src/client/prismDeskMid.ts:347-358` | `plainOf`/`digestOf`；SCAN 行不截断，视觉层 3 行 clamp |
| `src/client/prismDeskSide.ts:266-281` | 底条“决策周期 600s”已存在 |
| `src/client/prismDeskSide.ts:625-638` | autoT 弹窗 `条件不足 · {gateDetail}` |

## 附录 B：实测基线（2026-11-27 17:00）

| 数据 | 值 |
| --- | --- |
| 决策轮（`prism-runs.json`） | 20 轮，13:20–14:55，`intervalSec=300` |
| `note` 长度 | min 88 / 中位 180 / max 320 / 均值 182 字 |
| `limits.totalPct` | 95×15、100×2、null×3 |
| `limits.singlePct` | 30×20 |
| 每轮 tPlans | 1–4 条（均值 3.1） |
| 每轮 orders | 19 轮 0 单、1 轮 1 单 |
| summary 长度 | 1,421–3,832 字符（均值约 2,600） |
| 四份报告输出 | 约 10,700 字符/轮；合计 output 约 13–15K 字符/轮 |
| 委托（`prism-orders.json`） | 366 笔：filled 111 / rejected 120 / cancelled 135 |
| 拒绝原因 | T+1 107、盘后 9、无持仓 3、涨跌停 1 |
| 撤单原因 | 后续研判撤销 92、手动 13、每轮重审计 13、截止 8、次日失效 6、开关关闭 3 |
| 撤单存活 | 中位 5.0 分钟；p25 4.9 / p75 19.8 |
| 撤后同指纹重挂 ≤10 分钟 | 精确同价 0/92；近似（±100 股/±0.5%）12/92 = 13.0% |
| 自动做T（`prism-autot.json`） | plans 60（aborted 60）、results 0、trades 24（仅 11-26） |
| tPlan gate | 11-27：ok 20 / atr-rank-low 15；11-26：25 条无 gate 结果 |
| autoT 委托 | 70 笔：cancelled 66 / filled 4 |
| 新闻 | 24h 952 条 / 99,082 字符；important 219；前 30 条 2,832 字符（29 分钟） |
| 账户 | 11 只持仓、现金 296,317.75；零股：招商轮船 120、奥士康 639、中国海油 1,186、长江电力 1,398、中远海控 4,986 |
| 设置 | `perStockPct=30`、`stopLossPct=20`、`minCashPct=5`、`maxPosPct=null`、`maxDDPct=null`、`maxCumDDPct=null`、`perOrderYuan=null` |
| 自选 | 11 只（提案“99 只”在本机 profile 不复现；80 行截断逻辑仍在） |

## 附录 C：提案中不可执行 / 需修正的条目

| 提案条目 | 问题 | 本文处置 |
| --- | --- | --- |
| §4.2 周期自适应表（300s→1 笔、600s→2 笔、1800s→3 笔） | 拍脑袋；引擎截断=静默丢单；实盘 19/20 轮 0 单 | 删除；P1-12 不做 |
| §4.3 `PlanState` + `prism-plan.json` | 新文件=新生命周期/新损坏面；跨日清理未定义 | 改挂 `PrismDecision.plan`，随 runs 走 |
| §5.2 输出契约含顶层 `limits` | 模型自报上限与引擎夺权冲突 | 保留字段但引擎填；模型输出丢弃 |
| §7.4 “结构拒绝率 33%→<5%” | 基线过期；近 3 日 0% | 改 ≤2% 护栏 |
| §7.4 “tPlan 20/60=33%” | 25 条无 gate 记录被算失败 | 改 20/35=57.1% |
| §7.4 “autoT 成交率 5.7%→30%” | `results=0`；70 是腿不是计划 | 本期不设成交率目标 |
| §5.2 “note ≤120；空单两段” | 未评估 `thesisOf` 个股研判覆盖率下降 | 接受；note 点名 ≤3 只有动作标的 |
| §5.2 “撤单只允许三种” | 引擎无法判定“叙事证伪”，无执行点 | 降级为建议；用撤单率验收 |
| §5.2 “不得使用唯一/全部/所有” | 删了提示词，但 `candidatesTextOf` 仍留着同句 | 两处一起删 |
| §6.2 “零股卖出” | WIP 已实现，已有 120/100/150 三组测试 | 第 1 期补“可卖 100、持仓 120”一条 |
| §8 第 1 期 1 人日 | 低估至少 5 倍 | 5–7 人日 |
| §1.1 “行业上限已改为配置优先” | 只对**已配置**的行业成立；live `industryLimits={}` ⇒ 模型 `byIndustry` 补位，当前暴露变硬上限 | 新增 P0-11；`byIndustry` 只认 settings |

---

**一句话总结**：这版改造真正要修的不是“提示词写得不好”，而是**引擎没把权威数字和状态交给模型、提示词又把不可执行的规则写成强制**。先把引擎的账算对、把闸门的执行点补齐，再用一版短提示词让模型只做判断；不要反过来。
