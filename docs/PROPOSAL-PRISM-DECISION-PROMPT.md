# 棱镜「决策交易」提示词与决策逻辑优化建议

> 仓库：`dsh-tradewatcher`　基线：`v0.259.3`（`7888a21`）
> 性质：只读评审 + 改造建议；本文未修改任何 `src/**` 文件
> 读者：棱镜专属研发 agent
> 目标：把「汇总 → 决策」这一段从“模型替引擎算账”改成“引擎给边界，模型做判断”

---

## 0. 结论与前提纠正

### 0.1 先纠正一个前提

决策周期不是固定的 5 分钟，而是用户配置项：

- `PrismSettings.intervalSec`：`300 / 600 / 1200 / 1800 / 3600` 秒，默认 `600`。
- 只在 A 股连续竞价时段触发：`09:30–11:30`、`13:00–15:00`（左闭右开）。
- 每个时段开盘后的第一轮立即触发（09:30 / 13:00 各一次）；之后满足 `now - lastAutoAt >= intervalSec` 才触发。
- 手动「重放今日」走 `settings.times`，不占用自动节奏。

所以本文不再用“5 分钟 vs 月度叙事”的提法。真正的问题是：**提示词完全不知道当前周期是多少**。

`compileInput`（`src/host/prismPipeline.ts:106-127`）没有注入 `intervalSec`、`slot`、`now`、距收盘时间，也没有“本轮是开盘计划还是常规执行”的概念。结果是同一个提示词在 300 秒和 3600 秒下输出同一种行为：既可能在 300 秒周期里反复改计划、反复挂撤 T 腿，也可能在 3600 秒周期里错过盘中风险。

### 0.2 一句话结论

**有优化空间，量级是「中改结构」：重写决策段 + 补引擎输入 + 改输出契约 + 加回放验收。不建议只改措辞，也不必重写整条四路分析管线。**

核心改造三句话：

1. **算术还给引擎**：仓位上限、可买额度、可卖数量、股数、费用、涨跌停、T 门槛，全部由引擎算好注入；模型只做“该不该动、动什么”的判断。
2. **周期还给上下文**：提示词必须收到 `intervalSec`、`roundType`、`slot`、距收盘、数据时刻；不同周期用不同动作预算和计划刷新频率。
3. **规则必须有执行点**：提示词里每一条“强制”都要能对应到引擎的一个闸门或一个解析器校验；没有执行点的规则删掉，不要靠模型自觉。

---

## 1. 现状基线

### 1.1 每轮调用链

```
PrismScheduler.intervalDue()
  → runPrismForSlot()
    → prismInputsOf()                      // 组装输入
    → runPrismAnalysis()                   // 4 路并行分析 + 1 次汇总
      → streamText() × 4                   // 技术面 / 外盘 / 大宗 / 信息面
      → streamText() × 1                   // 汇总 → 决策 JSON
    → parseDecisionDetailed()              // 解析 decision
    → clampDecision()                      // 仓位/价格/费用/同产品/T+1 裁剪
    → applyDrawdownGate()                  // 回撤闸门（只过滤买单）
    → placeDecision()                      // 落单
    → placeAutoTPairs()                    // T 腿落单
    → store.replaceRun()                   // 落盘
```

每轮 5 次 LLM 调用；周期由用户配置，交易时段内按周期重复。

### 1.2 输入清单（`prismInputsOf`）

| 段落 | 来源 | 现状问题 |
|---|---|---|
| 【研判骨架】 | `store.skeleton()` | 2.5K 字符，5 次调用各复制一遍；内容是月/季度叙事，和本轮周期无关 |
| 【账户快照】 | `accountSnapshotOf()` | 缺价按摊薄成本算市值/权重；`可买额度 = 现金`，未扣最低现金留存/费用/整手；已有「可卖 X 股」 |
| 【指数技术面】 | `indexTechCachedOf()` | 数据缓存 5 分钟（不是决策周期）；只覆盖 5 只指数 |
| 【因子表】 | `factorsCachedOf()` | 数据缓存 5 分钟（不是决策周期）；持仓 + 自选，最多 50 行；是技术/波动/位置/动量的唯一事实源 |
| 【候选池】 | `candidatesCachedOf()` | 持仓 + 自选，过滤非沪深标的，最多 80 行；与 99 只自选不一致 |
| 【约束】 | `limitsTextOf()` | 有单票/止损/单笔/总仓/日回撤/最低现金/单板块；**没有 `maxCumDDPct`**；默认 3%/10% 不写进段落 |
| 【回撤闸门】 | `drawdownGateOf()` | 已注入状态/日跌幅/累计回撤/目标总仓/现金下限；阈值默认值未写入 |
| 【真实账户持仓】 | `assemblePortfolio()` | 只作参考；与棱镜持仓、ETF 合并、候选池重复 |
| 【ETF 按产品合并】 | `etfProductsTextOf()` | 只列同键 ≥2 只的组 |
| 【行业暴露】 | `industryExposureOf()` | 失败时整表 unavailable；现金被算进“未归类” |
| 【行情摘要】 | `loadQuotes()` | 含【待成交挂单】【今日已被风控拒绝的委托】；现价/候选池/持仓明细三处重复 |
| 【金十快讯】 | `store.news()` | 只取最新 30 条，实际覆盖约 44 分钟，不是 24h |
| 【自动做T·可计划标的】 | `autoTContextOf()` | ATR14/20 日振幅用 30 根 K 线、未筛当日未完成 bar；与因子表口径不同 |
| 【四路结论】 | `analyses` | 某路失败/截断时 digest 里没有“缺一路”标记 |

### 1.3 输出与执行链

当前输出契约（`prismPipeline.ts:199-205`）：

```json
{
  "note": "本轮决策理由",
  "limits": {
    "singlePct": 30,
    "totalPct": 95,
    "byIndustry": {"行业": 30},
    "note": "仓位上限依据"
  },
  "orders": [
    {"secid": "1.600519", "side": "buy|sell", "price": 12.34, "shares": 100, "reason": "原因"}
  ],
  "cancel": ["订单id"],
  "tPlans": [
    {"secid": "1.600519", "direction": "buy-first|sell-first", "buyPrice": 12.0, "sellPrice": 12.3, "shares": 100, "observe": "观察", "reasoning": "推理", "conclusion": "结论"}
  ]
}
```

执行侧关键事实：

- `clampDecision` 的单票上限：配置优先，模型 `limits.singlePct` 只兜底（`prismAccount.ts:1560-1563`）。
- `clampDecision` 的总仓上限：配置 `maxPosPct` 优先，模型 `limits.totalPct` 只兜底（`:1580-1582`）。
- 行业上限：`prismRoutes.ts:884` 已改为配置优先。
- `limits.note`：客户端不读；`src/client/**` 无 `decision.limits` 引用。
- `parseDecisionDetailed` 的 `tPlans` 过滤：`shares >= 100 && shares % 100 === 0`（`prismAccount.ts:540`）；`shares=0` 的“不做说明项”会被直接丢弃。
- `rejectReasonOf`：`order.shares % 100 !== 0` 直接返回「非100股整手」（`prismAccount.ts:157`），零股无法一次清仓。
- `evaluateAutoT`：`const isEtf = false` 写死（`prismGates.ts:111`），ETF 会被多算 0.1% 卖出印花税。
- `decisionProblems`：只在测试里调用，生产未接入。
- `parseDecisionDetailed` 的 `parseError`：`prismPipeline.ts:213-217` 只看 `decision`，`run.error` 仍可能为 null。

---

## 2. 问题清单

### 2.1 P0（会直接影响下单正确性 / 硬约束失效）

| 编号 | 问题 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| P0-1 | **总仓上限仍可由模型自报** | live 20 轮 `totalPct` = 95×15、100×2、null×3；`clampDecision` 在未配置 `maxPosPct` 时用 `limits.totalPct` | 模型写 100 时总仓上限消失；写 95 时用“100−现金留存 5%”给自己发许可证 | 引擎注入权威 `totalPct`；提示词只回显；`clampDecision` 去掉模型值兜底 |
| P0-2 | **同一“仓位百分比”两套分母** | `accountSnapshotOf` 缺价按 `p.cost` 算市值；`clampDecision` 只对下单标的取实时价 | 模型看到的 30% 和引擎裁的 30% 不是同一个基数 | 构造唯一 `accountView`（全持仓实时价，缺价→null + 原因），提示词与 clamp 共用 |
| P0-3 | **可买额度 = 现金** | `accountSnapshotOf` 直接写 `account.cash` | 未扣最低现金留存、费用、整手；模型按虚高额度报单，必被裁 | 引擎算 `buyBudget` 并注入；提示词不再让模型自己推 |
| P0-4 | **提示词不知道周期和时间** | `compileInput` 无 `intervalSec`/`slot`/`now`/距收盘 | 300 秒和 3600 秒同一种行为；14:30 后仍可能开新 T；尾盘不知道要收口 | 注入 `intervalSec`、`roundType`、`slot`、`minToClose`、数据时刻 |
| P0-5 | **T 门槛两套、且提示词写错** | 提示词 1.5%/3%；引擎 `AUTO_T_RULES` 1.0%/ATR 分位 40/日均振幅 1.2%；`autoTContextOf` 用未完成 bar | 今天 15 笔 tPlan 死在 `atr-rank-low`；按提示词门槛本来不该报 | 数字从 `AUTO_T_RULES` 注入；`autoTContextOf` 改用因子表同一口径；提示词不写常量 |
| P0-6 | **A 股制度约束缺失** | 提示词只在 `orders` 写“shares:整百”；没有 T+1、涨跌停、停牌、±3% 价格带、5000 元/0.2% 费用闸、同产品 ETF | 历史 120 笔拒绝中 107 笔是 T+1（89%）；模型不知道这些闸门，报出去必被拒 | 加【A股制度与引擎闸门】块；每条都对应引擎已有校验 |
| P0-7 | **零股无法卖出** | `rejectReasonOf` 要求 `shares % 100 === 0`；120 股持仓无法一次清仓 | live note 出现「120 股不足整百，无法减」 | 引擎支持“卖出 100 股整数倍或一次性卖出全部剩余（含零股）”；提示词同步 |
| P0-8 | **解析失败不升 `run.error`** | `parseDecisionDetailed` 的 `dropped` 只藏在 `decision.parseError`；`orders` 非数组静默成 `[]` | 0 笔被当成“模型没动作”；用户看不到解析失败 | 任一丢弃/非数组/side 非法 ⇒ `decision=null` 或抬升 `run.error`；`parseError` 进 `run.error` |
| P0-9 | **`note` / `limits.note` 契约冲突** | JSON 说明写「一句话」，强制规则要求空单「分两段」；`limits.note` 300 字没人读 | UI 卡片溢出；模型输出长度不稳定 | `note` 统一 ≤120 字；空单固定「不买：…；不卖：…」；`limits.note` 删除 |
| P0-10 | **候选池 80 行 vs 自选 99 只；引擎不校验池成员** | `candidateStats.ts:46` `slice(0,80)`；`prismRoutes.ts:294` 过滤非沪深 | 池外标的模型可以报，引擎不拦；池截断时结构性地少机会 | 引擎加候选池白名单校验；候选池 = 持仓 + 可交易自选，持仓永远优先 |

### 2.2 P1（会造成误导、自相矛盾、反复无效操作）

| 编号 | 问题 | 证据 | 建议 |
|---|---|---|---|
| P1-1 | **风险暴露规则偏卖出** | 「若判断不减，必须写明为什么满仓是合理的」；实际仓位 80.62%；历史卖单 273/366（75%） | 改成四项硬检查：止损线 / 单票行业总仓 / 回撤闸门 / 低波端；都不触发就写「未触发」+ 余量，不要求辩护 |
| P1-2 | **绝对量词规则制造元解释** | 实盘 14:55 summary 花 30 多字写「『唯一』在此仅指…」 | 删除整条；改成「数量/排名断言必须写对照范围」|
| P1-3 | **“每轮重新审计，旧 T 腿被替换”** | autoT 70 笔中 66 笔取消、4 笔成交（5.7%）；29 笔是模型下一轮主动撤单 | 改为「已有未成交 T 腿优先保留；条件不变原样重报；只有条件失效才不报」|
| P1-4 | **没有上一轮决策状态** | 只有【今日已被风控拒绝的委托】；没有上轮 note、clampEvents、tPlan gate 结果 | 注入【上一轮决策与计划状态】；失败原因只作事实，不要求本轮与上轮一致 |
| P1-5 | **撤单没有规则** | 92 笔「后续研判撤销」，中位存活 5.0 分钟；撤单率 135/366 = 37% | 只允许三种撤单：价格偏离且条件失效 / 叙事证伪 / 闸门触发；不因“重新研判”撤单重挂 |
| P1-6 | **止损语义三套** | 骨架「叙事证伪，不是价格」；提示词「买入均价」；引擎只拒买、不卖 | 统一为「配置止损线 = 禁止加仓线；触发后必须给减/不减判断；引擎不自动卖」|
| P1-7 | **新闻不是 24h；外盘/大宗无数据** | `news.slice(0,30)` 实际约 44 分钟；外盘/大宗无对应行情字段，live summary 自认三项全缺仍给方向 | 新闻按 24h 全量或“重要优先 + 省略计数”；外盘/大宗缺数据时明确降权，不得用 A 股代理 |
| P1-8 | **汇总 5 条要点没人看** | UI 只把 summary 当 ANALYZE 卡片兜底；真正展示的是 `note`；2.6K 字/轮 | 改为 3 行（结论/分歧/盯什么），每行 ≤50 字；详细内容留在四路报告 |
| P1-9 | **重复被拒容差教微调** | 去重容差 ±100 股 / ±0.5%；闸门期间同因拒绝 | 同一原因 + 同标的 + 同方向，价格/股数微调也视为重复；只允许“依据变化”重报 |
| P1-10 | **tPlans 的 shares=0 说明项被丢弃** | `prismAccount.ts:540` filter 直接丢 | 删掉这个允许项；空数组就是空数组 |
| P1-11 | **同产品 ETF / 涨跌停 / 停牌只由引擎拦** | 引擎有校验，但提示词不说，模型反复报必拒单 | 把引擎已有闸门写进提示词（不写引擎没有的规则） |
| P1-12 | **没有每轮动作预算** | 用户可把周期设为 300 秒；模型可能每轮报单 | 引擎注入 `maxNewOrders` / `maxNewTPlans` / 同标的冷却；按周期调整 |

### 2.3 P2（噪声、成本、可维护性）

| 编号 | 问题 | 建议 |
|---|---|---|
| P2-1 | 骨架 2.5K × 5 次；因子表 9K × 5；候选池 6K × 5；行情摘要 2.7K × 5 | 骨架只在 system 放一次；按角色裁剪上下文；预计 token −30–50% |
| P2-2 | 提示词硬编码在 TS 字符串里，测试逐字锁死 | 移到 `src/host/prompts/prism-decision.md`；测试改成语义断言（包含哪些块/字段），不要锁全文 |
| P2-3 | `limitsTextOf` 不写 `maxCumDDPct`；默认 3%/10% 不写 | 补全默认值和“默认生效”标注 |
| P2-4 | 缺价与停牌同文案「—（未取到行情）」 | 区分停牌 / 代码无效 / 取数失败 / 确实没有 |
| P2-5 | 真实账户持仓与棱镜持仓重复 | 若只作参考，压成一行摘要或删除；保留时明确“不参与计算” |
| P2-6 | `decisionProblems` 是死代码 | 接入生产：至少写 `run.noteProblems` 留痕 |
| P2-7 | 输出 2.6K 字散文在 JSON 前 | 3 行摘要即可；解析器只取 JSON 块 |

---

## 3. 优化原则

1. **引擎所有，模型所用**：所有硬边界、金额、股数、费用、门槛由引擎计算；模型不推导、不改写。
2. **一个事实一个来源**：同一指标只允许一个口径。因子表统一技术/波动/位置/动量；T 门槛统一 `AUTO_T_RULES`；账户统一 `accountView`。
3. **周期自适应**：提示词收到 `intervalSec` 和 `roundType`；300 秒只执行，1800/3600 秒才允许重写计划；尾盘只收口。
4. **计划状态化**：不是每轮从零“重新研判”，而是维护 `PlanState`（主线、阶段、目标总仓、观察条件、证伪条件）；每轮只判断“维持 / 修订 / 执行 / 不交易”。
5. **空单是一等结果**：`noTrade` 结构化；不要求为了格式凑单，也不要求为“不动作”写长篇辩护。
6. **规则必须有执行点**：每条规则对应一个引擎闸门或解析校验；没有执行点的规则删除或标为“建议”。
7. **输出最小化**：模型输出“意图 + 理由 + 失效条件”，引擎负责转成订单；JSON 字段越少越稳。

---

## 4. 目标决策逻辑

### 4.1 决策状态机

```
每轮开始
  │
  ├─ 0. 数据闸门
  │     行情/因子/账户缺失或过期？
  │       ├─ 是 → NO_TRADE(data)，不报任何新单
  │       └─ 否 → 继续
  │
  ├─ 1. 读取 PlanState（当日计划；无/过期 → 本轮强制 roundType=plan）
  │
  ├─ 2. 风控闸门（顺序执行，命中即记动作）
  │     a. 回撤闸门 triggered → 禁止新买；评估减仓至 targetTotalPct
  │     b. 止损线（买入均价）→ 生成“减/不减”判断；减则给减仓意图
  │     c. 单票/行业/总仓超限 → 生成减仓意图
  │     d. 现金 < 最低现金留存 → 只允许卖单
  │     e. T+1 可卖 = 0 → 该标的不可卖
  │
  ├─ 3. 机会闸门（仅当 buyBudget > 0 且无风控动作）
  │     a. 候选池内？
  │     b. 计划内触发条件命中？（watch/invalidation）
  │     c. 同标的冷却期已过？
  │     d. 单笔金额/费用/价格带通过？
  │       └─ 是 → 生成买入意图
  │
  ├─ 4. 做T闸门（仅对 autoT 开启的持仓）
  │     a. 已有未成交 T 腿？→ 条件不变则原样重报；条件失效则撤
  │     b. 新 T：ATR/分位/振幅/一跳/价差/净额/可卖/现金/时间窗 全部通过
  │     c. 14:30 后不开新 T；14:50 前平腿
  │
  ├─ 5. 输出
  │     有动作 → orders/tPlans/cancel
  │     无动作 → orders=[] + noTrade{code,detail}
  │
  └─ 6. 引擎执行 + 反馈
        clampEvents / rejects / tPlan gate → 写入下一轮【上一轮决策】
```

### 4.2 周期自适应表

| `intervalSec` | 默认 `roundType` | 是否允许重写 PlanState | 每轮最多新委托 | T 腿策略 |
|---|---|---|---|---|
| 300 | execute | 否（除非证伪条件出现） | 1 | 只维护已有 T 腿，不新开 |
| 600 | execute | 否（除非证伪条件出现） | 2 | 维护已有 T 腿；新开需计划内触发 |
| 1200 | execute / plan | 有新信息时允许 | 2 | 同上 |
| 1800 | plan / execute | 允许 | 3 | 允许新开，但需过 gate |
| 3600 | plan | 允许 | 3 | 允许新开；尾盘前必须收口 |

补充规则：

- 每个时段首轮强制 `plan`；`14:30` 后强制 `close`（只平 T、减仓、撤无效单，不开新仓/新 T）。
- `roundType` 由引擎判定并注入，模型不得自行改判。
- 周期越短，动作预算越紧、计划改写越少；周期越长，允许更多计划复核，但风险事件仍按每轮风控闸门即时处理。

### 4.3 PlanState 建议字段

```ts
interface PrismPlanState {
  day: string                  // YYYY-MM-DD
  updatedAt: number            // epoch ms
  roundType: 'plan' | 'execute' | 'close'
  thesis: string               // 主线叙事（≤60 字）
  phase: '展望' | '兑现' | '证伪'
  targetTotalPct: number | null
  watch: string[]              // 观察条件（≤30 字/条）
  invalidation: string[]       // 证伪条件（≤30 字/条）
  tLegs: Array<{
    secid: string
    direction: 'buy-first' | 'sell-first'
    buyPrice: number
    sellPrice: number
    shares: number
    openedAt: number
    status: 'pending' | 'filled' | 'cancelled'
  }>
  lastNote: string | null
}
```

存储建议：`~/.dsh/dsh-tradewatcher/prism-plan.json`；每日开盘首轮重建，盘中只增改；收盘后保留供次日复盘。若不新增文件，也可挂在 `PrismRun` 上，但需要保证跨轮可读。

### 4.4 引擎闸门顺序（与提示词一一对应）

| 顺序 | 闸门 | 判定 | 动作 | 反馈 |
|---|---|---|---|---|
| 1 | 数据新鲜度 | 行情/因子/账户时间戳超龄或缺失 | 拒绝新单 | `noTrade.code=data` |
| 2 | 回撤闸门 | 日/累计触发 | 只允许卖单；目标总仓 | `gateStatus` |
| 3 | 止损线 | 现价/买入均价 ≤ -stopLossPct | 只禁止加仓；给减/不减判断 | `stopLoss` 事件 |
| 4 | 单票上限 | 市值 > 总资产 × singlePct | 裁剪/减仓 | `single` 事件 |
| 5 | 行业上限 | 行业市值 > 总资产 × industryLimit | 裁剪/减仓 | `industry` 事件 |
| 6 | 总仓上限 | 持仓市值 > 总资产 × totalPct | 裁剪/减仓 | `total` 事件 |
| 7 | 最低现金 | 现金 < 总资产 × minCashPct | 只允许卖单 | `minCash` 事件 |
| 8 | T+1 可卖 | 卖出 > available | 裁剪到 available；0 则拒 | `available` 事件 |
| 9 | 候选池 | secid 不在池内 | 拒单 | `candidate` 拒绝 |
| 10 | 价格带 | 委托价偏离现价 >3% | 拒单 | `deviation` 拒绝 |
| 11 | 费用/金额 | 单笔 <5000 或费用率 >0.2% | 拒单（清仓/碎股除外） | `fee` 拒绝 |
| 12 | 同产品 ETF | 已持有同键另一只 | 拒买 | `product` 拒绝 |
| 13 | 重复被拒 | 同标的/方向/原因，价格股数微调 | 拒单 | `duplicate` 拒绝 |
| 14 | 冷却/预算 | 同标的当日已买或超每轮预算 | 拒单/延后 | `cooldown` 拒绝 |
| 15 | T gate | `evaluateAutoT` 不通过 | 丢 tPlan | `gateCode` 反馈 |

---

## 5. 完整提示词 v2

> 说明：`${...}` 全部由引擎注入；提示词本身不包含任何引擎常量。若某项确实没有，注入 `—（原因）`，不要让模型猜。

### 5.1 system

```
你是 A 股模拟盘的决策执行员。你的职责是：在引擎给定的硬边界内，判断这一轮该不该动、动什么，并给出可被引擎执行的交易意图。你不计算仓位上限、不计算股数、不修改风控参数——这些由引擎完成。只依据给定材料；缺失写 — 或 null 并给一句原因；不写免责声明；严格按格式输出。
```

### 5.2 user 模板

````
【本轮上下文】
- 决策周期：${intervalSec} 秒（用户配置，300/600/1200/1800/3600）
- 本轮类型：${roundType}（plan=开盘计划/周期复核；execute=常规执行；close=尾盘收口）
- 当前时间：${slot}（北京时间 ${day}）；距 11:30 ${minToAmClose} 分钟；距 15:00 ${minToClose} 分钟
- 数据时刻：行情 ${quoteAt}；因子表 ${factorAt}；账户 ${accountAt}；新闻覆盖 ${newsFrom}–${newsTo}
- 交易时段：${session}
- 本轮动作预算：最多 ${maxNewOrders} 笔新委托；最多 ${maxNewTPlans} 条新 T 计划；同标的冷却 ${cooldownMin} 分钟

【研判骨架（用户配置；只作叙事框架，与引擎硬边界冲突时以引擎为准）】
${skeleton}

【账户快照（模拟盘，唯一账户事实源；只读）】
${account}

【引擎硬边界（只读；不得推导、不得改写、不得回显为自报值）】
- 单票上限：${singlePct}%
- 总仓上限：${totalPct}%
- 单板块上限：${industryLimits}
- 单票止损线：${stopLossPct}%
- 单笔金额上限：${perOrderYuan} 元
- 最低现金留存：${minCashPct}%
- 回撤闸门：日 ${maxDDPct}% / 累计 ${maxCumDDPct}%；当前 ${gateStatus}；触发时目标总仓 ${targetTotalPct}%、现金下限 ${cashMinPct}%
- 本轮可买额度（已扣最低现金留存、费用与整手）：${buyBudget} 元
- 委托价偏离闸：±3%；单笔成交额下限 5000 元（清仓/碎股除外）；单边费用率上限 0.2%

【持仓明细（含 T+1 可卖）】
${positions}

【候选池（持仓 + 自选；只列可交易 A 股/ETF）】
${candidates}

【因子表（技术/波动/位置/动量的唯一事实源；前复权、已完成 bar）】
${factors}

【指数技术面】
${tech}

【外部环境（外盘/大宗）】
${overseas}
${commodity}
（无数据时写“—（缺数据）”；不得用 A 股代理推断外盘/大宗方向）

【新闻（实际覆盖 ${newsFrom}–${newsTo}；未覆盖 24h 时必须写明）】
${news}

【待成交挂单】
${pending}

【今日已被风控拒绝的委托】
${rejectedToday}

【上一轮决策与计划状态（只作连续性参考，不要求与本轮一致）】
- 上轮时间：${lastAt}
- 上轮 note：${lastNote}
- 上轮委托结果：${lastOrders}
- 上轮裁剪事件：${clampEvents}
- 上轮 T 计划 gate：${tGateResults}
- 当前计划：${planState}

【四路结论】
${digest}
（缺哪一路必须标注；外盘/大宗无数据时只作参考，不得当作方向证据）

【任务】
1. 判断本轮类型：${roundType}
   - plan（开盘首轮或周期 ≥1800 秒）：复核并更新计划：主线叙事、阶段（展望/兑现/证伪）、目标总仓、观察条件、证伪条件。
   - execute：只执行计划内触发；不因“重新研判”改写主线，除非证伪条件出现。
   - close（14:30 后）：只平 T、减仓、撤无效单；不开新 T、不开新仓。
2. 按以下顺序检查，命中即停：
   a. 数据门：行情/因子/账户任一缺失或过期 ⇒ 不报任何新单，输出 noTrade(code=data)。
   b. 风控门：回撤闸门触发 ⇒ 只允许卖单/减仓；止损线触发 ⇒ 必须给“减/不减”判断；单票/行业/总仓超限 ⇒ 给减仓意图；现金低于下限 ⇒ 只允许卖单。
   c. 机会门：仅在无风控动作且 buyBudget > 0 时评估买入；候选池外不下单；同标的当日已买且未过冷却期不重复买。
   d. 做T门：只对【自动做T·可计划标的】给 tPlans；已有未成交 T 腿优先保留，条件不变则原样重报，不改价重挂；14:30 后不开新 T，14:50 前平腿。
3. 没有触发就空单。空单是正常结果，不要为了有动作而交易。

【判断规则】
- 技术/波动/位置/动量只用【因子表】；不得从 K 线重算；缺数写 — + 原因。
- 仓位/权重/可卖/现金只用【账户快照】；【真实账户持仓】只作研究参考，不参与任何计算。
- 买入理由必须引用骨架中的具体条目，并写明叙事处于展望期还是兑现期；卖出理由按“证伪 > 风控 > 机会成本”排序。
- 止损用买入均价（卖出不变），不得用摊薄成本；配置止损线是“禁止加仓线”，触发后必须给“减/不减”判断，引擎不会自动卖。
- A 股制度：卖出 ≤ 快照“可卖”（T+1）；买入 100 股整数倍；卖出 100 股整数倍或一次性卖出全部剩余（含零股）；涨停价不买、跌停价不卖；停牌不报；行情为 — 不报。
- 委托价与现价偏离 ≤3%；单笔成交额 ≥5000 元（清仓/<100 股碎股除外）；单边费用率 >0.2% 不报。
- 同一标的同方向已有挂单不重复报；只有明确加仓才报新单并在 reason 写“追加”。
- 撤单只允许三种：价格明显偏离且原条件失效；叙事/触发条件证伪；回撤闸门触发。不因“重新研判”撤单重挂。
- 不得使用“唯一/全部/所有”等绝对量词；数量/排名断言必须写对照范围。

【输出】
先写 3 行、每行 ≤50 字：
结论：...
分歧：...
盯什么：...
然后另起一行，输出唯一一个 ```json 代码块（严格 JSON，不得注释、尾逗号、额外 JSON）：
${schema}
````

### 5.3 输出契约

```json
{
  "roundType": "plan|execute|close",
  "plan": {
    "thesis": "≤60字",
    "phase": "展望|兑现|证伪",
    "targetTotalPct": 60,
    "watch": ["≤30字", "≤30字"],
    "invalidation": ["≤30字", "≤30字"]
  },
  "note": "orders 为空时写“不买：…；不卖：…”，每段≤60字；非空时≤60字",
  "orders": [
    {
      "secid": "1.600519",
      "side": "buy|sell",
      "price": 12.34,
      "shares": 100,
      "reason": "≤40字"
    }
  ],
  "cancel": ["订单id"],
  "tPlans": [
    {
      "secid": "1.600519",
      "direction": "buy-first|sell-first",
      "buyPrice": 12.0,
      "sellPrice": 12.3,
      "shares": 100,
      "observe": "≤30字",
      "reasoning": "≤60字",
      "conclusion": "≤30字"
    }
  ],
  "noTrade": {
    "code": "data|no-signal|risk|gate|cooldown",
    "detail": "≤60字"
  }
}
```

字段约束：

- `plan`：`roundType=execute` 且计划未变时可为 `null`；`plan` 轮必须给。
- `note`：必填；`orders=[]` 时必须同时含“不买”和“不卖”两段。
- `orders`：可为空数组；`shares` 为正整数，引擎按整手/零股规则裁剪；`price` 必须在涨跌停内且偏离现价 ≤3%。
- `cancel`：只允许【待成交挂单】里的 id；未知 id 忽略并留痕。
- `tPlans`：可为空数组；只对【自动做T·可计划标的】给；`shares` 为 100 的倍数；不再允许 `shares=0` 的说明项。
- `noTrade`：`orders=[]` 时必填；`orders` 非空时为 `null`。
- 删除顶层 `limits`：引擎按 settings 填充；`limits.note` 删除。

### 5.4 与旧版的差异（删/改/加）

**删除**

- 11 条“【强制】”逐条补丁式规则 → 合并为「任务顺序 + 判断规则 + 制度块」。
- `limits` 输出、`limits.note`、“正常应当给出 singlePct/totalPct”。
- 「若判断不减，必须写明为什么满仓是合理的」。
- 「不得使用唯一/全部/所有」。
- 「每轮都会重新审计，旧 T 腿会被替换」。
- 「tPlans 空数组时允许给一条 shares=0 的不做说明项」。
- 「5 条以内的要点」→ 3 行摘要。

**改写**

- 风险暴露 → 四项硬检查（止损/超限/闸门/低波端）。
- 止损 → “配置止损线 = 禁止加仓线”，触发后给减/不减判断。
- T 门槛 → 全部由 `AUTO_T_RULES` 注入，不在提示词写数字。
- 候选池 → 持仓优先 + 可交易自选；池外不下单；引擎白名单校验。
- 重复被拒 → 同因同标的同方向，微调也算重复。

**新增**

- `intervalSec` / `roundType` / `slot` / 距收盘 / 数据时刻 / 动作预算。
- 【引擎硬边界（只读）】、【上一轮决策与计划状态】、【A股制度与引擎闸门】。
- `PlanState`、`noTrade`、`roundType` 字段。
- 3 行摘要 + 最小 JSON。

---

## 6. 引擎改造清单

### 6.1 输入侧

| 改动 | 文件/函数 | 说明 |
|---|---|---|
| 注入周期与时间 | `prismRoutes.prismInputsOf` / `prismPipeline.compileInput` | `intervalSec`、`roundType`、`slot`、`minToClose`、`quoteAt/factorAt/accountAt` |
| 判定 `roundType` | `prismScheduler` 新增纯函数 | 首轮/14:30 后/周期档位；可测试 |
| 统一账户视图 | `prismRoutes` 新增 `accountViewOf()` | 全持仓实时价；缺价 `null` + 原因；提示词与 `clampDecision` 共用 |
| 计算 `buyBudget` | `prismRoutes` | `min(cash - totalAssets×minCashPct/100, totalAssets×totalPct/100 - currentMv)`，再按整手/费用估算 |
| 补 `maxCumDDPct` 与默认值 | `limitsTextOf` | 明确“未设置=默认 3%/10%” |
| 候选池白名单 | `prismRoutes` / `clampDecision` | 池外 secid 拒单 |
| 新闻 24h 全量/重要优先 | `prismRoutes` | 现在是 `slice(0,30)`；至少输出“实际覆盖时段 + 省略条数” |
| 外盘/大宗数据 | `prismRoutes` | 没有就明确写缺数据；不要用 A 股代理 |
| 上一轮反馈 | `prismRoutes` | 上轮 note、`clampEvents`、tPlan `gateCode`、orders 状态 |
| `autoTContextOf` 口径 | `prismRoutes` | 用已完成 bar；与 `factorRowsOf` 同一 ATR/振幅口径；或直接引用因子表 |

### 6.2 输出侧

| 改动 | 文件/函数 | 说明 |
|---|---|---|
| 删除 `limits` 权威 | `prismAccount.parseDecisionDetailed` | 解析可选；引擎按 settings 构造 `PrismDecision.limits` |
| `PlanState` 持久化 | `prismStore` | `prism-plan.json`；跨轮读取 |
| `noTrade` 解析 | `prismAccount` | 校验 code 枚举；空单必须给 |
| `roundType` 校验 | `prismAccount` | 与引擎判定不一致时以引擎为准并留痕 |
| `parseError` 升 `run.error` | `prismPipeline` | 任一丢弃/非数组/side 非法 ⇒ `decision=null` 或 `run.error` |
| `decisionProblems` 接入 | `prismPipeline` | 写 `run.noteProblems`；不合格时至少告警 |
| 零股卖出 | `prismAccount.rejectReasonOf` / `clampDecision` | 允许“一次性卖出全部剩余（含零股）”；卖单裁剪按 available 向下取整到 100，但清仓时允许全部 |
| `isEtf` 传参 | `prismGates.evaluateAutoT` | 按 `isEtfName(name)` 传入，不要写死 `false` |
| 重复被拒口径 | `prismAccount.isDuplicateRejected` | 同因同标的同方向，价格/股数微调也判重复；只有“依据变化”才允许重报 |
| 动作预算 | `prismAccount` / `prismRoutes` | 每轮最多新委托/新 T；同标的冷却；按 `intervalSec` 配置 |

### 6.3 兼容性

- 旧 `prism-runs.json` 没有 `plan`/`noTrade`/`roundType`：解析时给默认值，不破坏历史。
- 旧客户端只读 `decision.limits`：若删除 `limits`，客户端显示“上限”会空；建议引擎仍填充 `decision.limits`（来自 settings）供 UI 展示，但**不参与裁剪兜底**。
- 旧测试 `prismRejectDup.test.ts` 锁死 11 条规则原文：需要同步改成“语义断言”，否则改一个字就红。

---

## 7. 测试与验收

### 7.1 先补回放能力

现状：`prism-runs.json` 只保留最近 20 轮，且不存输入全文；“重放今日”是重新取当前数据跑，不是历史回放。

改造：

1. 每轮落盘 `inputText`（或 `prism-replay/<day>-<slot>.txt`）+ settings 快照 + `roundType`。
2. 固定 10 个场景：空仓 / 满仓 / 接近单票上限 / 触及止损 / 闸门触发 / 停牌 / 涨停 / 120 股零股 / 候选池截断 / 今日已拒 3 笔。
3. 回放脚本不调用 LLM：直接用历史模型输出跑 `parseDecisionDetailed` → `clampDecision` → `applyDrawdownGate` → `evaluateAutoT`，输出“预演拒绝率/通过率”。

### 7.2 离线契约测试（不消耗 token）

新增 `src/host/prismDecisionContract.test.ts`：

- 每笔 order：secid ∈ 候选池；价格偏离 ≤3%；shares 整百（或清仓零股）；sell shares ≤ available；notional ≥5000 或清仓；无同产品 ETF；无重复被拒。
- 每个 tPlan：用同一 `factorMetrics` + 账户跑 `evaluateAutoT`，必须 `ok`；目标 100%。
- `note`：空单必须含“不买”“不卖”；`decisionProblems` 返回 `[]`。
- `limits`：`singlePct == settings.perStockPct`；`totalPct == settings.maxPosPct ?? null`；`byIndustry == settings.industryLimits ?? {}`。
- `plan`：`roundType=plan` 时必须非 null；`execute` 可为 null。
- `noTrade`：`orders=[]` 时必须给合法 code。

### 7.3 影子模式

- 加 `prism.shadow` 开关：新提示词生成决策但不落单，记录 `wouldPlace`。
- 与旧提示词并行 48 轮，比较：预演拒绝率、触发命中率、tPlan 通过率、note 字数、JSON 成功率、token。
- 只有“预演拒绝率下降且触发命中率不降”才切正式。

### 7.4 指标（当前基线 → 目标）

| 指标 | 当前基线 | 目标 |
|---|---|---|
| 结构拒绝率（T+1/涨跌停/偏离/费用/同产品/重复） | 120/366 = 33%（T+1 107/120 = 89%） | <5% |
| tPlan gate 通过率 | 20/60 = 33%（今天 15 笔 `atr-rank-low`） | >80% |
| 撤单率 / 挂单存活中位 | 37%；92 笔“后续研判撤销”中位 5.0 分钟 | <15%；>30 分钟 |
| autoT 成交率 | 70 笔中 4 笔（5.7%） | >30% |
| 空单率（分层） | 最近 19/20 空单；11/26 单日 85 笔 | 未触发轮≈0 单；触发轮>50% 有单 |
| note 字数 | 182–320 字 | ≤120 字 100% |
| token/轮 | 约 130–140K 字符（≈85–100K token） | −40–50% |
| limits 一致率 | singlePct 30/30；totalPct 95/100/null | 100%；totalPct 只能是配置值或 null |
| 无效 JSON / 静默丢单 | parseError 0，但 dropped 可能静默 | 0 / 0 |
| 决策一致性（同输入 3 次） | 未测 | orders/note Jaccard >0.8 |

**不要用“读起来更顺”验收。** Go/No-Go 看三个硬指标：结构拒绝率、tPlan gate 通过率、未触发轮的下单数。

---

## 8. 分期实施

### 第 1 期（约 1 人日）：提示词 + 最小引擎改动

- 替换决策段为第 5 节版本（兼容旧 schema：保留 `limits` 字段但只回显，新增 `roundType`/`plan`/`noTrade` 可选）。
- `compileInput` 加 `${slot}`、`intervalSec`、`roundType`、`minToClose`。
- `autoTContextOf` 改用已完成 bar + 因子表口径。
- 零股卖出支持。
- 更新 `prismPrompt.test.ts` / `prismRejectDup.test.ts` 为语义断言。
- 预期：结构拒绝率 33%→<5%，tPlan 通过率 33%→>80%。

### 第 2 期（1–2 人日）：权责与状态

- `limits` 引擎化：`PrismDecision.limits` 由 settings 填充，clamp 不再用模型值兜底。
- `buyBudget`、`accountView`、`maxCumDDPct`/默认值、候选池白名单。
- `PlanState` 持久化 + `prism-plan.json`。
- 上一轮 `clampEvents` / tPlan gate 反馈回灌。
- `parseError` 升 `run.error`；`decisionProblems` 接入。
- 重复被拒口径收紧；动作预算/冷却。

### 第 3 期（3–5 人日）：上下文与成本

- 按角色裁剪上下文（技术面只给指数+因子；外盘/大宗只给行情+外部；信息面给新闻+持仓；决策给全量但压缩）。
- 骨架移到日频/周频复盘；决策轮只带 3 行“当前主线/证伪条件”。
- 外盘/大宗补数据或合并为“外部环境”一路。
- 候选池/因子表按持仓 + 前 N 只候选压缩。
- 预期 token −40–50%。

---

## 9. 风险与回滚

| 风险 | 说明 | 缓解 |
|---|---|---|
| 模型变“懒” | 新提示词强调空单正常，可能漏掉应交易机会 | 验收看“触发命中率”而不是下单数；保留 shadow 对照 |
| `totalPct` 无配置 | 删除模型兜底后，未配置 `maxPosPct` 等于无总仓上限 | 保留 `minCashPct` 硬顶；提示词显示“未设置”；第 1 期先不改 clamp 兜底，第 2 期再切 |
| 零股卖出改坏 | 引擎现有整手假设遍布撮合/费用 | 只对“卖出且一次性清仓”开口；加单测：120 股→100+20 或全卖 |
| `PlanState` 过期 | 跨日/隔夜未清理，旧计划误导 | `day` 不匹配即重建；收盘后标记 expired |
| 输出 schema 变更 | 旧客户端/旧测试不兼容 | 保留 `limits` 展示字段；新增字段可选；分两期切 |
| token 下降但质量下降 | 裁剪上下文丢关键数据 | A/B 对比触发命中率；先裁重复段落，再裁角色段落 |

回滚：提示词模板文件化后可按版本回退；`prism.shadow` 可一键切回旧提示词；`PlanState` 可关闭（`roundType` 恒为 execute）。

---

## 附录 A：关键文件/行号（v0.259.3）

| 位置 | 内容 |
|---|---|
| `src/host/prismPipeline.ts:106-127` | `compileInput` 输入拼装 |
| `src/host/prismPipeline.ts:183-207` | 当前决策提示词（summary 调用） |
| `src/host/prismPipeline.ts:213-217` | `parseDecisionDetailed` 结果使用（`parseError` 未升 `run.error`） |
| `src/host/prismRoutes.ts:75-107` | `accountSnapshotOf`（七项 + 持仓明细 + 可卖） |
| `src/host/prismRoutes.ts:342-365` | `limitsTextOf` |
| `src/host/prismRoutes.ts:389-412` | `autoTContextOf` |
| `src/host/prismRoutes.ts:551-563` | 回撤闸门注入 |
| `src/host/prismAccount.ts:496-570` | `parseDecisionDetailed` |
| `src/host/prismAccount.ts:1433-1645` | `clampDecision` |
| `src/host/prismAccount.ts:1560-1582` | 单票/总仓上限兜底逻辑 |
| `src/host/prismAccount.ts:150-160` | `rejectReasonOf` 整手/停牌/涨跌停 |
| `src/host/prismGates.ts:10-40` | `AUTO_T_RULES` |
| `src/host/prismGates.ts:100-140` | `evaluateAutoT`（`isEtf=false`） |
| `src/host/prismScheduler.ts:100-180` | `intervalDue` 周期判定 |
| `src/shared/prism.ts:151-170` | `PRISM_INTERVAL_OPTIONS` / `PRISM_ANALYSIS_META` |

## 附录 B：旧提示词的 12 个反效果点（速查）

1. `limits` 让模型自报 → 自证上限。
2. `limits.note` 300 字没人读。
3. `note` 一句话 vs 空单两段 → 冲突。
4. 「必须是满仓辩护」→ 偏卖出。
5. 「不得使用唯一/全部/所有」→ 元解释噪声。
6. 「每轮重新审计，旧 T 腿被替换」→ 挂撤循环。
7. T 门槛 1.5%/3% 与引擎 1.0%/40/1.2% 不一致。
8. 「1.2% 价差覆盖双边费用」→ 小额必亏。
9. 「tPlans 允许 shares=0 说明项」→ 解析器丢弃。
10. 「候选池外不下单」→ 引擎不校验，软规则。
11. 「不得重复被拒」→ ±100 股/±0.5% 容差教微调。
12. 「必须先判断是否降风险」→ 单向偏置，与骨架冲突。

---

**一句话总结**：这版提示词不是“写得不好”，而是“让模型做了引擎该做的事，又没告诉它 A 股的制度边界和当前决策周期”。把算术、制度、周期上下文还给引擎，把叙事和判断留给模型，提示词自然就短了、稳了。
