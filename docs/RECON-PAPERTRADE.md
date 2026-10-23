# 【棱镜】AI 模拟仓/交易系统设计侦察

> 任务：为棱镜找可借鉴的 AI 模拟仓/交易系统设计。范围上限 10 个仓库 = **开源 7 + DSH 生态插件 3**；门槛 ≥100 star 或近期有提交。
> 方式：**只读源码提取设计**，不 clone、不安装、不运行、不改 `src/**`。
> 侦察员：recon-week｜时间：2026-10-23｜仓库 HEAD 基线：`6b12b4d`（v0.148.0）
> 标记：**实测** = 读到代码；**文档声称** = 仅 README 这么写；**未找到** = 已查但不存在

---

## §0 检索台账

### 0.1 检索方式

GitHub Search API（`search/repositories`，未认证 10 次/分钟）+ 单仓元数据 API（`repos/{owner}/{repo}`，未认证 60 次/小时）+ `raw.githubusercontent.com/<owner>/<repo>/HEAD/<path>` 读源码（**不占配额**）。全程未 clone。

### 0.2 关键词与命中

| # | 关键词 | 命中总数 | 取前 N 条的结论 |
|---|---|---|---|
| 1 | `llm trading agent stars:>100` | 35 | 命中本清单 3 个（TradingAgents 113,176 / TradingAgents-astock 3,772 / nof0 2,754），其余见 §0.3 |
| 2 | `paper trading stars:>200` | 28 | 多为加密机器人或已停更；**仅 QuantDinger 13,041 达标但 86 MB**，未入选 |
| 3 | `a-share backtest stars:>100` | 3 | 生态极小：FactorHub 429 / quant-buddy-skills 195 / etf-rotation 102，均未达"设计参考"价值 |
| 4 | `quantitative trading framework stars:>2000` | 3 | 命中 **hikyuu 3,571**（入选）、akquant 2,453、investing-algorithm-framework 2,191 |
| 5 | `ai hedge fund stars:>500` | — | **API 限流**（`API rate limit exceeded`），未取到结果；改用单仓 API 补 ai-hedge-fund 元数据成功 |

单仓元数据核验（`repos/{owner}/{repo}`，逐一调用）：

| 仓库 | star | license | 最近 push | 语言 |
|---|---:|---|---|---|
| TauricResearch/TradingAgents | 113,176 | Apache-2.0 | 2026-10-16 | Python |
| virattt/ai-hedge-fund | 64,169 | MIT | 2026-10-19 | Python |
| freqtrade/freqtrade | 55,794 | **GPL-3.0** | 2026-10-23 | Python |
| microsoft/qlib | 49,613 | MIT | 2026-10-22 | Python |
| vnpy/vnpy | 46,006 | MIT | 2026-10-06 | Python |
| HKUDS/Vibe-Trading | 36,370 | MIT | 2026-10-23 | Python |
| nautechsystems/nautilus_trader | 30,647 | **LGPL-3.0** | 2026-10-23 | Rust |
| OpenByteInc/QuantDinger | 13,041 | Apache-2.0 | 2026-10-23 | Python |
| ricequant/rqalpha | 6,837 | **NOASSERTION** | 2026-10-22 | Python |
| simonlin1212/TradingAgents-astock | 3,772 | Apache-2.0 | 2026-10-11 | Python |
| fasiondog/hikyuu | 3,571 | Apache-2.0 | 2026-10-23 | C++ |
| akfamily/akquant | 2,453 | MIT | 2026-10-22 | Python |

> 查询错误留痕：`repos/rqalpha/rqalpha` 返回 **404 Not Found**（正确 owner 是 `ricequant`）。

### 0.3 被排除项与原因（含证据）

| 仓库 | star | 最近 push | 排除原因 |
|---|---:|---|---|
| paperswithbacktest/awesome-systematic-trading | 14,914 | 2026-09-28 | **是清单不是代码**，无法提取设计实现 |
| hsliuping/TradingAgents-CN | 32,430 | 2026-09-22 | 许可 **NOASSERTION**（Apache 二改但未声明），合规风险；A股场景已由 astock 版覆盖 |
| HKUDS/Vibe-Trading | 36,370 | 2026-10-23 | 仓库 **90.8 MB**、范围过宽（"personal trading agent" 含大量非交易层），10 个名额里性价比低 |
| OpenByteInc/QuantDinger | 13,041 | 2026-10-23 | **86.8 MB** 的 "AI Trading OS"，同样的名额问题；设计要点与 ai-hedge-fund 高度重叠 |
| nautechsystems/nautilus_trader | 30,647 | 2026-10-23 | **LGPL-3.0** + 5,287 文件；风控引擎价值高，但 A股撮合参考由 hikyuu（Apache）更低风险地覆盖 |
| ricequant/rqalpha | 6,837 | 2026-10-22 | A 股撮合引擎的经典参考，但 **NOASSERTION 许可**（无法确认再分发条款），改用 Apache-2.0 的 hikyuu |
| Superalgos/Superalgos | 5,721 | 2026-10-15 | 仅加密，无 A 股规则 |
| Ceruleanacg/Personae | 1,408 | **2018-11-29** | **不满足"近期有提交"**（停更 8 年） |
| TheSnowGuru/PyTrader… | 1,066 | **2025-05-05** | 停更约 1.5 年，不满足近期门槛 |
| wquguru/nof0 | 2,754 | **2025-12-07** | 有 star 但停更约 10.5 个月；"AI 交易竞技场"概念好，设计密度低 |
| etrobot/open-alpha-arena | 596 | 2026-08-03 | 概念同 nof0，规模小；且许可证 **None** |
| akfamily/akquant | 2,453 | 2026-10-22 | 达标且活跃，但 7 个名额内被 hikyuu/vnpy 挤掉；**列为后续可补** |
| coding-kitties/investing-algorithm-framework | 2,191 | 2026-10-22 | 同上，框架层与 vnpy 重叠 |

### 0.4 最终入选（10）

**开源 7**（全部 ≥3,500★ 且 2026-10 有提交）：

| # | 仓库 | star | 许可 | 一句话定位 |
|---|---|---:|---|---|
| 1 | TauricResearch/TradingAgents | 113,176 | Apache-2.0 | 多智能体 LLM 交易框架：分析师→多空辩论→风控团→经理 |
| 2 | virattt/ai-hedge-fund | 64,169 | MIT | 投资委员会多角色 + **真实 paper trading 子系统** |
| 3 | freqtrade/freqtrade | 55,794 | GPL-3.0 | 加密机器人，**dry-run 模拟撮合**语义最细（仅记设计，不引代码） |
| 4 | microsoft/qlib | 49,613 | MIT | 量化平台：point-in-time 数据、记录器、回测 |
| 5 | vnpy/vnpy | 46,006 | MIT | 交易网关抽象 + 事件引擎 + 订单生命周期 |
| 6 | simonlin1212/TradingAgents-astock | 3,772 | Apache-2.0 | **A股版**多 Agent 辩论 + 质量闸门 |
| 7 | fasiondog/hikyuu | 3,571 | Apache-2.0 | A股交易系统：TradeCost / Slippage / T+1 一等公民 |

**DSH 生态插件 3**（均已在本机 `/tmp`，零新增下载）：

| # | 插件 | 版本 | 许可 | 一句话定位 |
|---|---|---|---|---|
| 8 | `clawock-dsh` | 0.4.0 | MIT | 投资决策工件契约（decision schema）+ trade-to-plan + 台账 |
| 9 | `dsh-quant` | 0.90.0 | MIT | 59 工具量化插件：回测循环、因子评价、风险 |
| 10 | `@v587d/capital-generation` | 2.9.0 | MIT | 能力目录 + DatasetRef 数据层 + preset 角色隔离 |

> **许可处理**：freqtrade 为 **GPL-3.0**，本报告对其**只做机制描述，不引用任何代码片段**；nautilus/rqalpha/TradingAgents-CN 因 LGPL / NOASSERTION 未入选。其余均为 MIT / Apache-2.0，引用保持 1–3 行且标注出处。

---

## §1 十个项目逐个

### 1. TauricResearch/TradingAgents —— 控制层防洗白（Apache-2.0）

**113,176★｜Apache-2.0｜pushed 2026-10-16｜Python｜LangGraph**

**设计要点（实测）**

1. **[D1] 四个分析师是并行且上下文隔离的子图。** 每个 analyst 编译成独立 `StateGraph`，其 `output_schema` 只装自己的 `report_key`，注释原文："analysts running side by side never write the same key"——**用状态键隔离代替加锁**（`tradingagents/graph/setup.py:53-63`，节点 `:144-146`，汇合 `:166`）。
2. **[D1] 辩论由路由决定、不由模型决定，且有硬计数。** `should_continue_debate`：`count >= 2 * max_debate_rounds` 才进 Research Manager，否则在 Bull/Bear 间**强制轮转**；风控三人和 `3 * max_risk_discuss_rounds` 同理（`tradingagents/graph/conditional_logic.py:12-33`，我方独立复核）。两个默认值都是 **1**（`default_config.py:133-134`）→ 每个角色只说一次。
3. **[D1] 裁决者被迫选边，且这条规则被写了两遍。** "conflict alone is not a reason to Hold… **independent of which side spoke first or last**" 同时出现在 `managers/research_manager.py:36` 与 `managers/portfolio_manager.py:66`，并作为 `Field(description)` 挂到评级枚举上（`agents/schemas.py:104-112`、`:230-239`）——**prompt 与 schema 双写，防止任一路径丢失**。
4. **[D1] 「读不懂」不等于「持有」。** `RATING_REVIEW` 哨兵 + `parse_rating(default=RATING_REVIEW)`（`agents/rating.py:10-13,30,96-103`）；PM 把结构化评级写入 `final_rating` 后**故意不再从渲染文本里回读**（`portfolio_manager.py:78-86`）。这是全清单里最精准的一处：把"解析失败"与"判断为持有"分开。
5. **[D1] 缺席要显式渲染成缺席。** `opponent_argument_or_opening` 输出 `"(opponent has not spoken yet…)"`、`report_or_absent` 输出 `"(No market report in this run…)"`（`agents/context.py:37-48,190-201`）。避免"空字符串被模型脑补成同意"。
6. **[D1] 记忆不对称是刻意的。** memory 节点与分析师并行运行，但"only the Portfolio Manager reads its lessons"（`setup.py:157-166`、`portfolio_manager.py:35-40`、`memory/reflection.py:1-23`）——**历史教训只喂给最终决策者，不污染分歧阶段**。
7. **[D6] 结构化输出是 fail-open 的，不要当成校验。** `bind` 在不支持的 provider 上返回 `None`，`invoke` 吞掉任何异常退回 `llm.invoke` 纯文本（`agents/structured.py:42-95`）。真正的兜底在 schema 内：`_coerce_optional_float` 把 `"N/A"`/`"15%"`/区间归零为 null，避免"一个坏字段丢掉整个决策"（`schemas.py:33-58,185-188`）。
8. **[D7] 配置的 vendor 列表就是降级链，且没有静默回退。** `dataflows/router.py:211-225`；错误分类直接等于"router 有几种反应"（`errors.py:8-16`）；`DATA_UNAVAILABLE`/`NO_DATA_AVAILABLE` 哨兵明确指示 "do not estimate or fabricate"（`router.py:176-197`）；`date_window.py:1-11,23-31` 做时点夹取；`net.py:6-24` 做 API key 擦洗。

**防洗白评估**：做得对的是**结构**——谁说话由 router 定、硬停、枚举强制表态、REVIEW 哨兵。**没做到的是"论据质量"**：默认 1 轮 = 两段独白；Bull 永远先说（`setup.py:166`），反锚定只靠一句 prompt；所有角色读同样的 4 份报告、同一个模型，分歧是**被要求出来的**（"respond directly to each point"），不是**被证据逼出来的**——**没有"必须引你的工具调用"，也没有报告质量闸门**，所以共享的错误前提会一路传导。

**缺口对照**：本仓库**没有** quality gate（`setup.py` 无此节点、文件树无 `quality_gate.py`）；`agents/post_screen.py` 是 StockTwits/Reddit 跑题筛查器，没有 `TYPESAFE_API_KEY` 时完全不生效。structured 里"retrying once as free text"是**装饰性**的：没有重新提问、没有重新校验（`structured.py:76-81`）。
**可借鉴处**：REVIEW 哨兵（读不懂≠持有）、规则 prompt+schema 双写、状态键隔离的并行分析师、缺席显式化。

---

### 2. virattt/ai-hedge-fund —— 哈希链账本 + 确定性风控（MIT，本清单最该抄的一处）

**64,169★｜MIT｜pushed 2026-10-19｜Python**
> 名字像"巴菲特人格 Agent 玩具"，实际重心全在**记账与风控闸门**，不在行情真实度。**它对棱镜的直接价值最高。**

**设计要点（实测）**

1. **[D4] 账本是哈希链，状态是"折"出来的、从不单独存。** 每条 `SessionRecord` 携带上一条的哈希；基金状态由 `next_state` 沿链折叠重建，所以"没有东西会漂移"；缺一条、乱序或被改一笔，`replay` 直接拒绝（`hedge_fund/paper/ledger.py:1-8`）。我方独立复核该 docstring 与 `sessions()` 的链序（`:67-80`）。
2. **[D4] 记录里绑定了"是什么在产生决策"，不只是参数。** `SessionRecord` 含 `nav/cash/positions/marks/benchmark_close/rebalance/executed CycleRecord/DecisionRecord/**code_version**/**mandate_hash**/llm_model/snapshot_times`（`pipeline/session.py:86-106`）。`compute_hash` = 对 `model_dump_json` 排除 `hash` 字段后 sha256，且**只在 `snapshot_times is None` 时排除该字段**——一个为兼容旧账本的向后兼容技巧（`:108-113`）。`mandate_hash = sha256(spec)`，spec 快照到 `fund.yaml`；**换了 mandate 的决策会被 `execute_decision` 拒绝执行**（`:194`、`deployed.py:3-7`）。
3. **[D4] "两份账本"互相校验。** ledger 说基金**以为**自己持有什么，broker 说它**实际**持有什么，`advance` 每次会话前对账；两本分文件存放——"a single file could never disagree with itself"（`brokers/paper.py:3-7`）。对账不一致时**抛错而不是自动修复**（`pipeline/session.py:213-226`）。
4. **[D4] checkpoint 只是链的缓存，不是替代品。** `replay(full=True)` 忽略 checkpoint 逐链验证；checkpoint 必须与链头哈希一致才被采信（`ledger.py:15-20`）。redo 会在**记录时的价格**上重跑上一场，被取代的记录移到 `superseded/` 而**不是删除**（`tick.py:47-83,154-186`）。
5. **[D4] LLM 视角也可回放。** `PromptCache` 以 `sha256(agent|model|system|user)` 为键持久化**原始 prompt + 原始 response**，命中即绕过调用；每条 Signal 带 `prompt_key + snapshot_hash`（`llm/cache.py:25-28`、`signals/llm_agent.py:89-91,194-204`）。注释诚实：**人格采样本身不可复现，但记录可复现**。
6. **[D2] 风控是确定性算术，LLM 的影响止于 Signal。** `RiskLimits{max_position_pct, max_gross_exposure}` 写死在 FundSpec；docstring 原文："**the LLM's influence over the book ends at the Signal, and no clamp is ever negotiable**"（`risk/limits.py:1-11,21-31`）。
7. **[D2] 两级夹紧 + 每条夹紧都留痕 + 夹紧后不复投。** 先按单票 `|w|` 截断（保号），再按总敞口等比缩放——**缩放只会变小，因此不可能再次违反单票上限**（`risk/limits.py:60-66,82-102`）；每次触发记 `ClampEvent{limit,ticker,before,after}`，"every clamp is explainable"（`:34-40`）。最关键一条：**被夹掉的敞口留在现金，不重新分配给别的票——"重分配会让风控阶段反而加仓，等于把它的职责反转了"**（`:8-10`）。
8. **[D2] 风控有两层证明。** 下单前用**预估交易后**的账本再校验一次两个上限（`stages.py:129-139`）；另有 `validate_targets` 从已记录信号**独立重算**一次目标权重（`portfolio/validation.py:16-79`）。
9. **[D1] 投票到仓位是算术，没有"PM Agent"。** 信号在 [−1,+1] 加权平均；**弃权既不计分子也不计分母**，中性观点仍投票；归一化到 `gross_target`；各策略 sleeve 先按资金切片再净额化（`portfolio/construction.py:60-82,95-101`、`stages.py:56-95`）。README 明写 "The LLM never touches the trade"（`README.md:141-142`）。
10. **[D5] 计分卡只认超额，且带样本量与 t 值。** 分析师命中率与 slugging 都按**超额收益**计（"a long-only analyst in a bull market must not score for free"），逐日 Spearman IC 记均值/标准差/t 值并带 `n_dates`，要求每日 ≥3 只；docstring 自嘲 "a hit rate from twelve calls reads as the noise it is"（`scorecard/analysts.py:77-104`、`scorecard/models.py:10-13`）。策略归因带 `unattributed` 残差——"Reported, never hidden"（`scorecard/strategies.py:20-54`）。
11. **[D5] ⚠ 防过拟合只有"盲测提示"，机器**没建**。** `blind=True` 时对 LLM 隐去代码/行业/日期/金额、序列归一到 100、规模改百分位；但 docstring 自承只是"reduces that recall rather than removing it"（`features/snapshot.py:87-107`）。**无训练/测试切分、无 walk-forward、无 embargo**（`backtesting/fund.py:114-172` 是单条 `[start,end]` 循环）；`validation/__init__.py:1-5` 只有一段 docstring；README 把 CPCV/PBO 标为 ⬜ planned（`README.md:129`）。
12. **[D6] 失败契约是"数据错要炸、模型错要弃权"。** 数据错误 `raise` 传播；LLM/解析错误 → 显式 `abstained=True` 的零信号，**原始 response 落盘**（`llm_agent.py:158-176,15-20,207-215`）。不用 langchain tool-mode，理由是"forced-tool mode breaks on Anthropic reasoning models"（`llm/client.py:7-10`）。
13. **[D7] PIT 在取数时就强制。** 财务按 `filing_date_lte` 而非 `report_period` 过滤；市值取**最近一条已申报**行，因为 `get_market_cap` 只给最新值——那在回测里就是未来函数（`data/client.py:114-125`、`features/snapshot.py:208-211`）。磁盘缓存键 `sha256(method|params)`；**已结束交易日的答案视为终局、未结束当日的日线永不复用**、其他同日缓存 600 s TTL；只缓存成功、错误照常传播（`data/cached.py:128-130,147-173`）。
14. **[D3] ⚠ 成交模型是"上限"，不是模拟。** `SimBroker` 按调用方给的参考价**全额成交**，只校验价格有限且 >0；**无费用、无滑点、无部分成交、无量能约束**（`brokers/sim.py:38-50`）；费用/滑点注释写的是"a declared future addition"（`:5-6`）。订单只有两态：构造即下达，然后成交或抛错——**没有撤销/过期/挂单**（`brokers/protocol.py:19-22`）。所以它所有回测数字都是**天花板**。

**可借鉴处（按优先级）**：① `risk/limits.py` 的确定性两级夹紧 + `ClampEvent` +「夹掉不重分配」——**直接补棱镜 D2 最大缺口**；② 哈希链账本 + `mandate_hash`/`code_version` 绑定 + 拒绝跨 mandate 执行（D4）；③ 两本账互校、不一致就抛错（D4）；④ 弃权 vs 抛错的二分失败契约（D6）。
**不要借鉴**：成交模型（无费用/滑点/部分成交，棱镜反而更强）、防过拟合（只有声明没有机器）、`assess_fund` 在数据完整时反抛"requires incomplete data"的反逻辑报错（`stages.py:46-47`）。

---

### 3. freqtrade/freqtrade —— dry-run 与"连亏熔断"（GPL-3.0，只记设计）

**55,794★｜⚠ GPL-3.0｜pushed 2026-10-23｜Python**
> **许可证约束：本节只描述机制，不引用任何代码片段。** 借鉴时须自行独立实现，不可复制源码。

**设计要点（只读机制）**

1. **[D2] "频繁止损 → 自动停手窗口"是一等风控对象。** `StoplossGuard` 保护器：在回看窗口内统计 `exit_reason` 属于四类止损枚举、且收益低于 `required_profit`（默认 0）的**已平仓**交易数，达到 `trade_limit`（默认 10）即锁定开仓；`has_global_stop`/`has_local_stop` 决定锁**全局**还是**只锁该交易对**，`only_per_pair` / `only_per_side` 再细化（`freqtrade/plugins/protections/stoploss_guard.py:14-24,52-111`，我方独立复核结构）。**这是棱镜完全没有的"元风控"：不是管单笔，而是管"最近手气"。**
2. **[D2/D4] 风控状态**不存计数器**，每次从审计表重算。** 保护器本质是"对持久化成交史的一次查询"——不维护"连亏 3 次"这类可变计数。→ **状态少一处，就少一处能漂移的地方。** 这条对棱镜很有价值：与其在内存里维护 `consecutiveStopLosses`，不如从 `fills` 里算。
3. **[D2] 仓位公式有明确不变量。** `stake_amount` 可为"无限"哨兵，此时单笔 = (可用+已占用)/`max_open_trades` 再与可用取小（`freqtrade/wallets.py:347-359`）；`tradable_balance_ratio` 刻意乘在**（已占用+自由）**之上而非仅自由，注释理由是避免每开一单就摊薄后续仓位（`:328-333`）；尾单可缩量到 `last_stake_amount_min_ratio` 以下则归零（`:369-375`）；**加仓时上限再压到 `max_stake − 当前仓位`**（`:408-427`）。
4. **[D2] 移动止损是单调棘轮，只有一个"反向通道"。** 止损存的是持仓上的**绝对价 + 百分比三元组**（`persistence/trade_model.py:431-438`）；移动止损按现价 ± |stoploss|/杠杆算新价并按最小价位取整，**只在有利方向接受**，`allow_refresh` 是唯一允许反向的显式开关（`:858-899`）；`stoploss_or_liquidation` 取止损与强平价中**更差**的一个（`:473-480`）。→ **"棘轮 + 唯一逃生阀"是防手滑的好结构。**
5. **[D2] 止损有两条落地路径。** 本地轮询比对现价与止损价后走普通退出；或 `stoploss_on_exchange=True` 时在交易所挂**真实止损单**，仓位数量变化就**先撤后建**（`freqtradebot.py:1601-1619,1265-1285,1509-1517`）。棱镜只有本地路径，够用，但要意识到**本地路径在"进程没跑"时不生效**。
6. **[D3] dry-run 的撮合是**乐观全量**，必须知道偏差在哪。** 限价单在最优买卖价穿越限价时**全量成交于限价**，创建当轮按 taker、之后按 maker 计费；**全程没有部分成交**（`exchange/exchange.py:1400-1465`）。限价与盘口偏离超过 1% 会被**直接改判为市价单**（`:1270-1278`）；市价按逐档吃 L2 求均价并被 **±5%** 最差价夹住，无 L2 时退回请求价（`:1280-1297,1325-1370`）；无 L2 的交易所上 `_dry_is_price_crossed` 直接返回真——**"没有盘口也立刻成交"**（`:1381-1383`）。
7. **[D4] 持久化是 trade : order : fill 三层。** 一张 `Trade` 行承载全生命周期（请求价/实际价、请求量/实际量、双边费率与费用币种、stake 与 max_stake、止损三元组+移动标记、`exit_reason`/`exit_order_status`、策略名、timeframe、三档精度、合约面值、杠杆/方向/强平价、最高最低价、`record_version`）（`trade_model.py:401-470`），成交落独立 `Order` 行（`:65-120,324-340`）。余额审计是 `WalletHistory` **每日每币种**快照（含汇率/持仓市值/抵押/杠杆，唯一约束 `timestamp+currency`）（`wallet_history.py:15-43`）——**日粒度，不是逐笔流水**。
8. **[D4] 回测导出把**策略源码**一起打包。** ZIP 内含脱敏 config、策略 `.py` 原文、本次实际参数文件、统计与元数据（`optimize/optimize_reports/bt_storage.py:86-134`，调用点 `optimize/backtesting.py:1963`）。→ **复现包含代码，不只是配置**，比 qlib 的"记 git diff"更彻底。
9. **[D7] 限速**不在本仓实现**，交给 ccxt；重试是装饰器，二次退避 `(max−remaining)²+1` 秒、默认 4 次，只有 `DDosProtection` 与 `RetryableOrderError` 才 sleep（`exchange/common.py:35-36,114-121,170-191`）。同步/异步两套 ccxt 客户端由合并配置构建，markets 由异步客户端加载后**回灌**同步客户端（`exchange/exchange.py:287-300,751-801`）。

**可借鉴处**：① `StoplossGuard` 的"连亏 → 冷静期"思路（棱镜加一条从 `fills` 派生的规则即可）；② **风控状态从审计表重算而不存计数器**；③ 风控做成"允许/不允许"插件接口而非散落 if；④ 锁状态持久化。
**注意**：GPL-3.0，**任何代码复用都会传染**；本报告仅记录设计。此外它是加密场景（**无 T+1、无涨跌停、无印花税、无整手**），A 股约束一条都不能照搬。

---

### 4. microsoft/qlib —— A 股撮合五规则 + 真 embargo（MIT）

**49,613★｜MIT｜pushed 2026-10-22｜Python**

**设计要点（实测）**

1. **[D3] 成交额裁剪是有序的三步：量能 → 现金 → 整手。** `deal_amount` 先取满额，再按量能上限裁剪（`current` = 区间累计成交、`cum` = 上一笔减已成交，取各上限的最小值），再按现金裁剪，最后按 `trade_unit`（A 股 100）取整；现金连费用都不够时直接归零（`qlib/backtest/exchange.py:786-832,728-761,919-942`）。
2. **[D3] 费用是 `max(成交额 × 费率, 最低费用)`。** `open_cost=0.0015`、`close_cost=0.0025`、`min_cost=5.0`、`impact_cost=0.0`（注释推荐 0.1）（`exchange.py:48-51,114`）；成交额 ≤1e-5 时费用强制为 0（`:947-951`）。
3. **[D3] 冲击成本按"参与率平方"计。** `adj = impact_cost × (trade_val / total_trade_val)²`，其中 `total_trade_val = volume × price`，加在该方向的费率上（`exchange.py:877,889-895`）。→ **小单几乎无冲击、大单惩罚急剧上升**，比线性滑点更接近真实。
4. **[D3] 涨跌停与停牌从行情帧推导，不查日历。** 停牌 ⇔ `$close` 为 NaN；涨停 ⇔ `$change ≥ 阈值`；跌停 ⇔ `$change ≤ −阈值`；各自与停牌取或；聚合用 `method="all"` 所以**任一分钟受限即全天不可成交**；失败时 `deal_amount=0` 并返回 `(0,0,nan)` 而**不抛错**（`exchange.py:273-292,362-376,437-442`）。
5. **[D3] 成交价是表达式，买/卖可不同。** `deal_price` 支持 `$close` / `$vwap` 表达式，按 `method="ts_data_last"` 在订单区间上求值；None/NaN/≤1e-8 时告警并回退收盘价（`exchange.py:494-514,157-162`）。
6. **[D5] 真的有 purge/embargo。** `RollingGen(step, rtype=expanding|sliding, trunc_days)` 每窗口一个任务；`trunc_segments` 会把**每一个非测试段**按测试段起点截断，注释："To avoid the leakage of future information"；驱动侧传 `trunc_days = horizon + 1`（**标签周期的 embargo**，不是完整 CPCV）（`qlib/workflow/task/gen.py:128-139,142-181`、`contrib/rolling/base.py:194-201`）。
7. **[D5] 超额收益同时报"含费"与"不含费"。** `excess_return_without_cost = return − bench` 与 `excess_return_with_cost = return − bench − cost` 两条并列（`workflow/record_temp.py:498-518`）；`risk_analysis` 输出 mean/std/年化/IR（=mean/std·√N）/最大回撤（`contrib/evaluate.py:26-93`）。
8. **[D7] PIT 在算子层面拒绝未来。** `P` 算子把 `<period_time>` 折叠到 `<observe_time>`，遇到任何未来延伸**直接抛错**（"PIT database does not support referring to future period"）——**在表达式加载时拒绝，而不是靠约定**（`qlib/data/pit.py:24-49`）。存储是列式二进制：每个 (instrument, field, freq) 一个 float32 文件，首元素是起始索引（`data/storage/file_storage.py:285-344`）。
9. **[D4] ⚠ 运行记录"能描述、不能证明"。** Recorder 记录的是**代码状态**而非仅参数：`sys.argv`、所有 `_QLIB_*` 环境变量、以及 `git diff` / `git status` / `git diff --cached` 三份产物（注释理由：MLflow 只记 commit id，而"user will have a lot of uncommitted changes"）（`workflow/recorder.py:345-388,407-421`）。但**没有 config/数据集的 content hash**——身份是 run id + 参数。

**可借鉴处（对本仓库最直接）**：① **五规则撮合**几乎是 A 股现成规范：`max(成交额×费率, 最低费用)` + 整手 100 + 涨跌停/停牌从行情帧推导 + 量能裁剪 + 参与率平方冲击（`exchange.py:48-51,273-292,786-832,947-951`）——**比棱镜现在的"按挂单价全额成交、不看 volume"更真实**；② `trunc_days = horizon + 1` 作为默认 embargo；③ 含费/不含费双报。
**不要借鉴**：运行身份用 MLflow run-id（要用 ai-hedge-fund 的哈希链替代）。

### 5. vnpy/vnpy —— 订单状态机与网关抽象（MIT）

**46,006★｜MIT｜pushed 2026-10-06｜Python**

**设计要点（实测）**

1. **[D3] 订单状态是六态枚举，`部分成交` 是一等状态而非异常。** `Status = SUBMITTING / NOTTRADED / PARTTRADED / ALLTRADED / CANCELLED / REJECTED`（`vnpy/trader/constant.py:30-39`）。**棱镜的挂单只有 pending/filled/cancelled/rejected，没有"部分成交"这一态**——这是最直接可补的一处。
2. **[D3] 订单带"时间有效性"语义。** `OrderType` 含 `LIMIT / MARKET / STOP / FAK / FOK / RFQ / ETF`（`constant.py:61-72`）。FAK（立即成交剩余取消）、FOK（全部成交否则取消）在 A 股散户场景用处有限，但 **`STOP` 条件单**是棱镜"止损"落地时最缺的原语。
3. **[D2] 开平仓是独立维度，含"平今/平昨"。** `Offset = NONE / OPEN / CLOSE / CLOSETODAY / CLOSEYESTERDAY`（`constant.py:19-27`）。棱镜用 `availableQty` 隐式表达 T+1，vnpy 把它提升为**显式的枚举维度**——对我们这种只需 T+1 的股票系统是过度设计，但**"可卖数量为什么要单独一个字段"**的逻辑是一致的。
4. **[D3] 部分成交 = "一张委托多条成交回调"，但引擎**不聚合也不校验**。** `TradeData` 注释明写 "One order can have several trade fills"（`vnpy/trader/object.py:154-158`）；`on_trade` 每次成交推两条事件（总频道 + 按合约频道，`gateway.py:107-113`）；OmsEngine 以 `vt_tradeid` 为键逐条入库，**不累加、不校验 Σ成交量 ≤ 委托量**（`engine.py:439-449`）；`OrderData.traded` 只是网关回报的累计量，引擎不自己算（`object.py:127`）。→ **部分成交的"状态"有了，但"一致性"没人管。**
5. **[D7] 多网关共存 = 名字作键的 dict + 交易所并集列表。** `engine.py:104`、`128-137`；`send_order` 只做一次 `get_gateway` 查找，找不到就打日志返回空串（`engine.py:265-275`）。**无 failover、无健康检查、无熔断**；`connect` 是同步透传（`:245-253`），**重连只是网关基类对实现者的 docstring 要求**："automatically reconnect if connection lost"（`gateway.py:52`），引擎侧无对应代码。
6. **[D2] ⚠ 核心仓**没有**风控引擎，只有路由查找。** `vnpy/trader/` 全 14 个模块无 risk 类；全仓文件名检索 "risk" 只命中 **3 份文档**，而这些文档引用的是**仓外的独立包**：`from vnpy_riskmanager import RiskManagerApp`（`docs/community/app/risk_manager.md:27`）。文档列了 5 条规则（活动委托/每日上限/重复报单/委托规模/委托指令，`:9-13`）——**属文档声称，代码不在本仓**。
7. **[D4] ⚠ 无审计、无落盘。** OmsEngine 全部状态是 **6 个内存 dict + 2 个活跃 dict**（`engine.py:386-395`），进程退出即丢；整个 trader 包唯一落盘是网关配置 JSON（`engine.py:733,767`）；`database.py` 只管 bar/tick，**没有委托/成交表**。→ **vnpy 在 D4 上是反面教材**，别学。
8. **[D7] ⚠ 事件引擎是单队列双线程，handler 串行。** `event/engine.py:44-66`，handler 在消费线程串行执行（`:76-80`）——**任一 handler 阻塞即拖垮全部分发**；"低延迟"寄托于网关契约 "all methods should be non-blocked"（`gateway.py:50`）。

**可借鉴处**：① 六态订单状态机 + "部分成交追加 trade 而非改 order"（D3，直接补棱镜"无部分成交"）；② `STOP` 条件单作为止损原语（D2）；③ `BaseGateway` 薄子类 + 事件解耦的分层（D7）。
**不要借鉴**：`CLOSETODAY/CLOSEYESTERDAY`（期货语义，A 股 T+1 用不上）、把风控外置（棱镜风控必须在引擎内，否则可被绕过）、内存态无落盘（D4）、串行 handler 事件引擎。

---

### 6. simonlin1212/TradingAgents-astock —— A 股的"质量闸门"其实是个评论员（Apache-2.0）

**3,772★｜Apache-2.0｜pushed 2026-10-11｜Python**

**设计要点（实测）**

1. **[D1] 把上游的并行改成了 7 分析师串行链，每跳之间清空消息。** 硬编码顺序 + `Msg Clear` 节点（`setup.py:153-175`，首个 `:154`，清理节点 `:135-138`，链 `:171-175`）。每角色可单独钉模型，只有 RM/PM 用强模型（`setup.py:15,48-54`）。
2. **[D1/D6] `quality_gate.py` 只按"形式"打分，且只写文本。** 空→F、<200 字→D、失败标记占比过高→D（`MIN_REPORT_LENGTH=200` `:23`、`FAILURE_MARKERS` `:25-31`）；再由两个结构特征推 A/B/C：有无 markdown 表格、`[数据缺失` 出现次数 ≥3→C（`:34-64`）；另发一次 LLM 复核出 A–F 表，若已有 ≥4 份 D/F 则跳过（`:67-115,145-156`）。
3. **[D1] 闸门**没有否决权**：返回值只有 `{"data_quality_summary": …}`（`:166`），`Quality Gate → Bull Researcher` 的边是**无条件**的（`setup.py:177`）。没有重生成、没有重试、没有拦截。
4. **[D1] 闸门唯一真实作用是给两位辩手一个"信任先验"**："⚠️ If … grade C/D/F, reduce your reliance … note the data limitation"（`researchers/bull_researcher.py:45,48`、`bear:19`）。而在 RM/PM/trader/三位风控辩手里 **grep 命中 0** → **裁决者永远看不到这个评级**。
5. **[D1] 裁决规则被削弱了。** 只剩"Commit to a clear stance … reserve Hold for genuinely balanced"（`managers/research_manager.py:37`），**上游那两条关键条款（冲突≠Hold、忽略发言顺序）不见了**；默认仍是 1/1 轮、固定 Aggressive→Conservative→Neutral（`conditional_logic.py:70-91`）。
6. **[D6] 解析失败被压成可交易的 Hold —— 正是上游写代码要避免的那种失败。** `parse_rating(text, default="Hold")`（`agents/utils/rating.py:89`），模块自己的注释记着这个 bug："defaulted to Hold regardless of the model's actual call (issues #78 / #80)"（`:17`）。没有 REVIEW 哨兵。
7. **[D6] 层级压制与上游相反：PM 与 trader 被禁止给出入场/止损/目标/仓位**（`portfolio_manager.py:24-29,92`、`trader.py:16-21,67`），`PortfolioDecision` 直接删掉 `price_target`（`schemas.py:156-190`）。**对我们是个反例：禁止给价位反而让决策不可执行。**
8. **[D7] 这是全清单里 A 股数据层最实干的一处。** mootdx/tdx 主源 + 服务器探测（`dataflows/a_stock.py:272-385`）、腾讯快照带 `limit_up`（`:488-530`）、主源陈旧时新浪补数（`_needs_sina_supplement :694`、`_supplement_stale_ohlcv_with_sina :717`）、东财数据中心共享助手取龙虎榜/解禁（`:530-579`）、`get_dragon_tiger_board :2319`、`get_lockup_expiry :2447`、北向带本地快照缓存（`:1909-1963`）。**缺失数据被解析成 `[数据缺失: ...]` 并回写成可重试任务文件**（`dataflows/missing_data.py:1-6,25-26,65`）——一个上游没有的"出处/重试通道"。
9. **[D2] A 股规则全在提示层，不在控制层。** 涨跌停（含 2026-07-06 ST 新规、上市前 5 日无限制，`analysts/market_analyst.py:28`、`portfolio_manager.py:56-73`、`trader.py:53-65`）；T+1 既是约束（`market_analyst.py:29`）又是空方论据（"T+1 Trap… losses are locked in" `bear_researcher.py:28`）；解禁减持的 1%/2% per 90d、提前 15 交易日披露、减持新规三条禁令（破发/破净/分红不达标）被用来论证"大解禁≠必然供给"（`lockup_watcher.py:32-35`）。

**防洗白评估**：它比上游多了一个**非 LLM 的代码计算信号**（数据质量评分），但这个信号**对称且不辨方向**——多空双方会以同样方式打折同一份报告，于是产生"对数据可靠性的共识"，而不是"对交易的真正分歧"；而且它到不了裁决者。同时上游的两件决定性装置都被删了（冲突≠Hold、REVIEW 哨兵），`parse_rating` 又默认 Hold → **残余失败模式正是"最后一跳漂移成 Hold"**。

**可借鉴处**：`[数据缺失: …]` → 可重试任务文件的"缺失即任务"通道；多源补数（主源陈旧才补，`_needs_sina_supplement`）；把解禁/减持做成结构化论据而非结论。
**不要借鉴**：形式化质量闸门（无否决权、到不了裁决者）、禁止给价位、`default="Hold"`。



### 7. fasiondog/hikyuu —— 交易成本按"监管年代"版本化（Apache-2.0）

**3,571★｜Apache-2.0｜pushed 2026-10-23｜C++（Python 封装）**

**设计要点（实测）**

1. **[D3] 成本模型是**按监管年代版本化**的独立对象，不是一组常量。** 仓库里有 `FixedAPre2015TradeCost`、`FixedA2015TradeCost`、`FixedA2017TradeCost`、`FixedETFTradeCost` 四个实现 + `FixedATradeCostBase` 基类（`hikyuu_cpp/hikyuu/trade_manage/imp/`）。**费率会随监管变，所以费率必须带"生效版本"。**
2. **[D3] 每个版本的四参数可覆写，且默认值就是历史真值。** `FixedA2017TradeCost` 构造：`commission=0.0018`、`lowest_commission=5.0`、`stamptax=0.001`、`transferfee=0.00002`（`hikyuu_cpp/hikyuu/trade_manage/imp/FixedA2017TradeCost.cpp:17-22`），并暴露同名工厂 `TC_FixedA2017(commission, lowestCommission, stamptax, transferfee)` 供覆盖（`:35-43`）。
3. **[D3] 版本差异被写进注释，而不是留给猜。** 2017 版的关键差异：`_calcTransferFee` 覆写并注明 "**From 2017 the Shenzhen market also charges the transfer fee, in both directions**"（`FixedA2017TradeCost.cpp:26-29`）。→ **费率变更点必须记录"为什么变"，否则半年后没人敢动。**
4. **[D3] 费用分项按"标的类型"分支，不是一刀切。** 买入总成本 = commission + transferfee；卖出追加印花税，**且只对 `STOCKTYPE_A/GEM/START/A_BJ` 计提，其余为 0**（`hikyuu_cpp/hikyuu/trade_manage/imp/FixedATradeCostBase.cpp:33,51-61`）；`commission = round(成交额 × 费率, precision)` 并对 `lowest_commission` 取底（`:27-31`）。`CostRecord` 是 5 字段记录，注释明确"结构体不算 total、不保证公式成立"（`CostRecord.h:19-35`）。
5. **[D3] 滑点可插拔，但**默认关闭**。** 未注入滑点对象时 `realPrice` 直接等于 `planPrice`（`trade_sys/system/System.cpp:1865` 三元）——**零滑点是默认值**。注入后 `SP_FixedPercent`：买 `price×(1+p)`、卖 `price×(1−p)`，p 默认 0.001；滑点后价格**再被夹进该根 [low, high] 并对齐最小价位**（`fixupSlippagePrice` `:1844-1861`）。滑点是 4 钩子对象（买/卖 × 多/空），空头钩子默认委托给多头钩子。
6. **[D3] 成交价默认是"次根开盘"，且这是 T+1 的**隐式**来源。** `buy_delay/sell_delay` **默认 true**，注释即 "Without a delay the close price of the current bar is used"（`System.cpp:116-119`）；默认口径 = 下一根开盘成交（`:1285`），无延迟时 = 当根收盘（`:914`）。
7. **[D2] ⚠ T+1 没有显式检查。** `sell` 只要求有持仓（`System.cpp:1002-1004,1015-1017`）。同日回转不发生，是"默认次根开盘 + 每根一次决策"架构的**副产物，不是规则**。更要注意：资金管理器开 `auto_checkin` 时 `_autoCheckin` 会按买入成本**预先补足现金**，使 buy 的现金检查必过（`:1079-1092`）——**闸门存在但被前置填平**。→ **棱镜显式 `availableQty` 校验反而是更正确的做法。**
8. **[D3] 一字板是"延迟"而非"拒单"。** `high == low` 且 `close < 前收` 判为跌停锁死，卖单进延迟队列（`System.cpp:1174-1196,1260-1274`）；成交额或成交笔数为 0 也延迟（`:900-905,1198-1202`）。`ISLIMITUP` 用独立阈值：A 1.1 / 北交所 1.3 / 创业板+科创 1.2，基于**后复权**收盘比较以穿越除权，**ST 的 5% 明确未处理**（`indicator/imp/IIsLimitUp.cpp:47-68`）。→ **棱镜按 ST/创业板/科创板分档的 `limitsOf` 在这一项上比 hikyuu 更完整。**
9. **[D2] TradeManager 的拒绝清单值得对照。** 空 stock、时间倒流（`:820-829,980-982`）、价格非有限或负、数量 < minTradeNumber 或 > maxTradeNumber（`:838-843,993-998`）、现金不足（`:924-926`）、卖出超持仓（`:1015-1017`）。手数向下取整发生在 System：`int64_t(number/min_num)*min_num`（`:938`）。
10. **[D3] 精度按标的走。** `_calcTransferFee` 用 `stock.precision()` 做 `roundEx`（`FixedA2017TradeCost.cpp:28`）——费率是浮点，但**金额必须按该标的的最小价格单位取整**。棱镜的 `money()` 统一两位小数，对 A 股够用，**ETF/债券/基金会不准**。
11. **[D3] 费率口径要写清是"券商口径"还是"交易所口径"。** TC_FixedA2017 默认 commission `0.0018`（万 18）是**含双边议价的券商口径**，不是交易所 0.03% 的规费口径；测试用例 2100 股 @10.00 卖出 → 37.8 + 0 + 2.1 = 39.9 与之吻合（`hikyuu/test/TradeCost.py:58-59`）。**引用默认值前必须确认口径，否则会算出 60 倍的费用。**

**可借鉴处**：① **成本模型版本化**（`TC_FixedA2015/2017/ETF` 的形态）——棱镜现在是 `COMMISSION_RATE/STAMP_RATE/TRANSFER_RATE` 三个裸常量（`src/host/prismAccount.ts:33-36`），**建议改成带 `effectiveFrom` 的费率表**；② 费用按标的类型分支（不是所有标的都收印花税）；③ 滑点独立对象 + 滑点后夹进 bar 区间；④ 按标的精度取整。
**不要借鉴**：用"延迟成交"隐式实现 T+1（不可靠且不可审计）、`auto_checkin` 预填现金（会让现金闸门失效）、C++/序列化那套重型框架。

---

### 8. clawock-dsh —— 决策工件契约（MIT，本清单最强的一处）

**仓库**：npm `clawock-dsh@0.4.0`（本机 `/tmp/week-clawock-dsh-0.4.0`）｜**MIT**｜约 18.6k 行（`lib/client.js` 11.8k + `taskqueue.js` 883 + `ledger.js` 493 + `typert.host.js` 484）
**定位**：DSH 的"投资决策 + trade-to-plan + 后台任务队列"插件。真正值钱的不是 UI，是它把**一份投资决策变成了可机检的工件**。

**设计要点（实测）**

1. **[D6→D1] 决策工件是带版本的 JSON Schema，不是自由文本。** `$id: urn:clawock:workflow:investment-decision:1.1.0:decision`，`schema_version` 用 `const: 1` 锁死，全对象 `additionalProperties: false`，`required` 含 `evidence / debate / thesis / decision`（`skills/investment-decision/references/decision.schema.json:1-30`）。**schema 版本号写进 $id**，升级即换 id——这是"参数版本化"最轻的做法。
2. **[D1] 证据必须标注立场，且系统强制"反方下限"。** `evidence[].stance ∈ {supporting, opposing, context}`、`source_class ∈ {primary, secondary, market, agent}`（schema `$defs/evidence`）。工作流带 `min_opposing_evidence` 参数，SKILL 原文：**"publish refuses a decision whose bear case is a strawman"**（`SKILL.md:66-67`）。
3. **[D1] 多空论述必须各自引用对应立场的证据。** `debate.bull_case/bear_case` 都是 `{summary, evidence_ids[minItems:1]}`（schema `$defs/case`），闸门会校验 `bear_case` 只能引 `opposing` 行、`bull_case` 只能引 `supporting` 行，否则报 `unsupported_bear_case` / `unsupported_bull_case`（`SKILL.md:191`）。**这就是防"四视角互相洗白"的硬机制：反方不是一句话，而是必须挂到具体证据行上。**
4. **[D1] 先写可证伪条件，再选动作。** `thesis.invalidation_conditions` 是 `minItems: 1` 的字符串数组（schema `thesis`），SKILL 要求"State the thesis and its invalidation conditions **before** choosing an action"（`SKILL.md:69-70`）。
5. **[D6] 七类结构化拒绝码，把"重试"变成可编程分支。** `unknown_fields / missing_fields`、`insufficient_supporting_evidence / insufficient_opposing_evidence`、`unsupported_bull_case / unsupported_bear_case`、`missing_evidence_reference`、`gross_amount_mismatch / fx_amount_mismatch`、`confidence_without_primary_source`、`future_evidence`（`SKILL.md:187-195`）。每个码都给了"怎么改"的一列——**拒答不是失败，是可执行的修复指令**。
6. **[D6] 置信度受来源等级约束。** 参数 `max_confidence_without_primary_source`：置信度超过该上限时**必须**引一条 `primary` 证据，否则拒绝（`SKILL.md:59,133,194`）。把"你有多确定"和"你的一手证据够不够"绑死。
7. **[D4] 时点强校验，天然反前视。** `observed_at` 晚于 `as_of` 直接判 `future_evidence` 拒绝（`SKILL.md:195`）。比事后审计信号时间戳可靠得多。
8. **[D4] 台账用"文件签名"做缓存失效，且记录过一次真实踩坑。** `barsSignature()` 对 `memory/bars/*.json` 逐文件取 `name:mtimeMs:size` 再 sha1，前 16 位作为签名；注释写明：早期版本只按"最新快照文件名"做键，**漏掉了就地重写**（issue #711），所以改成 stat 级签名（`lib/freshness.js:13-40`）。同理 `fxProvenance` 有 `FX_STALE_READ_HOURS = 96` 的陈旧判定（`lib/ledger.js:60-75`）。
9. **[D3] 委托意图里的两条金额恒等式。** `gross_amount_quote = quantity × unit_price`、`gross_amount_base = gross_amount_quote × fx_quote_to_base`，并要求"reconcile to currency cents"（`decision-contract.md:44-53`）。委托自带算术自检。
10. **[D5] 评估指标定义得极克制、可复现。** `decision_value_bps`：long/hold 记 +1、trim/sell/exit 记 −1、watch/abstain 记 0，乘市场变动 bps；文档明确写着 **"This is a reproducible directional evaluation, not realized P&L; portfolio cash, fills, fees, taxes and position size remain outside this artifact"**（`decision-contract.md:62-78`）。**把"我能测什么"和"我不测什么"划清，是评估设计最难的一步。**
11. **[D5] `abstain` 是一等动作。** `action` 枚举含 `buy/add/hold/watch/trim/sell/exit/abstain`，且 `hold/watch/abstain` 必须 `order: null`（`decision-contract.md:40-44`）。棱镜没有这个出口。

**可借鉴处**：① `evidence.stance` + `min_opposing_evidence` + "反方案例必须引反方证据"——**直接补上棱镜 D1 的对抗性缺口**；② 七类拒绝码 + 修复指令表——把 `decisionProblems()` 从"挑错"升级成"可重试契约"；③ `future_evidence` 校验 + `observed_at/as_of` 时点语义——补 D4；④ `decision_value_bps` 的"只测方向、不冒充实盘"——补 D5 且不心虚。

**注意**：闸门代码本身不在 npm 包里（包里只有 SKILL + schema + 文档，`lib/` 是 gateway/UI），上述 gate 行为来自 SKILL 文档描述 + schema 约束，判定逻辑在外部 `clawock workflow` CLI。**属"文档声称 + schema 可验证"，gate 实现未读到。**

---

### 9. dsh-quant —— 回测循环与因子评价（MIT）

**仓库**：npm `dsh-quant@0.90.0`（本机 `/tmp/week-dsh-quant-0.90.0`）｜**MIT**｜零运行时依赖
> 完整清点见 `docs/RECON-WORKBENCHES.md` §3（含 59 工具清单与「宣称 vs 实测」三处冲突）。此处只取与本任务 7 维度相关的部分。

1. **[D3] 挂单槽式回测循环，结构上杜绝未来函数。** 每根 bar 一个 `for` 循环，`pendingEntry/pendingExit` 两个槽：第 `i` 根产生的信号在第 `i+1` 根**收盘价**成交（`lib/dsh-ml/backtest.js:45-56`）。比"事后审计时间戳"更可靠——错误在结构上不可能发生。
2. **[D3] 费用按"每边乘算"落地。** `cash *= 1 - feeRate`，买卖各一次（`backtest.js:51,55`）。**但全包无印花税、无最小变动单位、无 T+1、无涨跌停**（`grep 印花|stamp` 零命中）——A 股真实度约等于 0，**不能照抄到棱镜**（棱镜这部分反而更强）。
3. **[D5] 因子评价数学是干净的。** Pearson IC 用滚动配对 `factor[i]` vs `returns[i+1]`；RankIC 先取**平均秩**再 Pearson；分层 `bucketSize = ceil(n/q)` 记每桶前向收益均值与样本数；多空 = 首尾桶差（`lib/dsh-alpha/factor.js:16-136`）。IC 衰减单独一档：`IC(h)=corr(f, Σreturns[i+1..i+h])`，`halfLife` = 首个 IC ≤ peak/2 的 h（`lib/dsh-alpha/decay.js:41-92`）。
4. **[D5] ⚠ ICIR 没有年化，且年化因子混用。** `icir = icMean/icStd`，总体标准差、无 √252（`factor.js:100`）；同包 `√365`（`metrics.js:21`）与 `√252`（`optimizer.js:165`）并存。**借用时不要继承它的 ICIR 语义。**
5. **[D2] 风险指标有标准实现可抄。** 历史法 VaR/CVaR：`tailIdx = max(0, floor((1-conf)*n)-1)`、`varCut = -sorted[tailIdx]`、`cvar = -(r ≤ -varCut 的均值)`，置信度默认 0.95，**无窗口参数**（数组长度即窗口）（`lib/dsh-risk/risk.js:14-23`）；Beta/Alpha/IR/TE 见 `risk.js:43-67`；Kupiec POF 回测 `LR ≤ 3.841`（`risk.js:89-111`，**注意其 x=0/x=n 退化分支写坏了**，`:103-106`）。
6. **[D5] 图表数据用可辨识联合，便于复用渲染器。** `{kind:'candles'|'series'|'annotations', ...}`（`lib/dsh-execution/chart.js:11-21`）。
7. **[D7] ⚠ 无任何缓存/断路器**（`grep cache|circuit|breaker lib/` 零命中），且「三所行情容错」对 A 股不成立（`lib/dsh-execution/pipeline.js:14-16` 直接短路）。**数据层不要参考它。**

**可借鉴处**：挂单槽回测循环（D3 结构防前视）；因子 IC/RankIC/分层/IC 衰减数学（D5）；`{kind}` 图表协议（D5）。**不要借鉴**：费用模型（缺 A 股项）、ICIR 语义、数据层容错。

---

### 10. @v587d/capital-generation —— 能力目录与数据分层（MIT）

**仓库**：npm `@v587d/capital-generation@2.9.0`（本机 `/tmp/week-v587d-capital-generation-2.9.0`）｜**MIT**｜7.6 MB / 734 文件
> 完整清点见 `docs/RECON-WORKBENCHES.md` §6。

1. **[D7] 数据源接口是「能力 + 校验 + 归一」三件套。** `DataSource{schema, execute(req,signal), validateOutput?, normalizeParams?}`；`normalizeParams` 的契约写得很细：**"the Hub calls it before merge key and params_digest, so equivalent requests share one Dataset. Must be idempotent"**（`lib/data-collector/hub.d.ts:49-62`）。**"等价请求共享同一份数据"是数据层去重的正确定义。**
2. **[D7] 参数摘要用 SHA-256，且带确定性降级。** `paramsDigest()` 先 `stableSerialize` 再 sha256；取不到 `node:crypto` 时降级为 **FNV-1a 64 位**并重复四次补足 16 位（`lib/data-collector/hub.js:110-123`）。在飞请求的合并键是 `capability:task_id:params`（`:125-127`）。
3. **[D7] 能力名与 data_key 双重唯一，把"同一能力多源"变成不可能。** 注册时 capability 或 data_key 重复即抛错——**所以它没有 fallback 链**（`hub.js:162-178`）。**这是棱镜要避免的形态**：我们要的是同一能力多源可降级，它做的是同一能力只能有一个源。
4. **[D4] 数据集引用化：工具只返回 `DatasetRef` 元数据，落盘后按需查。** 配套每能力自带的 `cacheMaxAgeMs` 决定复用窗口（`hub.js:195-218`）。适合"上下文贵、数据重"的场景。
5. **[D1] 角色隔离靠 preset-id 白名单 + 名字 deny。** 只有 `capital-data-collector` 这个 preset 能调 `request_data`（`lib/data-collector/tools.js:123`），根 Agent 被 `lib/agents/root-tool-policy.js:41-49` 按名字拒绝。**比提示词约束硬，但仍是"模式级"不是"人级"。**
6. **[D6] 系统提示注入点很干净。** `inject=['systemPrompt']` + `ctx.systemPrompt.section(...)`（`lib/index.js:93,149-154`），persona 是 YAML 里的字面 `prefix:` 块（`preset/capital-generation/agent.patch.yml:497-608`）。
7. **[D2] ⚠ 有一个 `disabled: true` 的 preset**（`data_analyst`/Python，注释自陈"当前均未实现"，`agent.patch.yml:394-410`）。**读到 disabled 就要当它不存在。**

**可借鉴处**：`normalizeParams` + `params_digest` 的去重契约（D7）；`DatasetRef` 引用化 + 每能力 `cacheMaxAgeMs`（D4/D7）；preset-id 白名单做角色隔离（D1/D2）。

## §2 横向对比表（10 个项目 × 7 维度）

图例：● 做得好且有机器保障 ｜ ◐ 有但弱/半自动 ｜ ○ 有声明无实现 ｜ — 没有 ｜ ⚠ 反面教材

| # | 项目 | D1 决策管线 | D2 组合与风控 | D3 撮合与成交 | D4 记录与可复现 | D5 评估与校准 | D6 提示与输出 | D7 数据层 |
|---|---|---|---|---|---|---|---|---|
| — | **棱镜（基线）** | ◐ 四路并行但不对抗，无裁决规则 | ⚠ 仓位上限只记录不执行；无止损 | ◐ 1 分钟撮合+三项费用+T+1/涨跌停，但无滑点/无部分成交/不看量能 | ⚠ 每次 run 落盘但无哈希/无回放/无参数版本 | — 零指标 | ◐ 有决策 JSON 与事后挑错，无 schema/无重试/无拒答 | ◐ 有熔断器；无统一出处字段 |
| 1 | **TradingAgents** | ● 路由定序+硬计数+强制选边+REVIEW 哨兵 | — 无仓位/无止损（只有辩论） | — | ◐ 有 memory 反思，无账本 | ○ 无评估 | ◐ 结构化 fail-open，无重试校验 | ◐ 配置列表即降级链，无静默回退 |
| 2 | **ai-hedge-fund** | ● 投票→算术出仓，LLM 不碰交易 | ● 两级夹紧+ClampEvent+不重分配+双层校验 | ⚠ 全量成交于参考价，无费用/滑点/部分成交 | ● **哈希链账本+两本账互校+mandate_hash** | ◐ 计分卡带 n/t 值，但防过拟合只有声明 | ● 弃权 vs 抛错二分；schema 内清洗 | ● PIT 在取数时强制；缓存分"终局/未终局" |
| 3 | **freqtrade** | — | ● 连亏熔断+棘轮止损+仓位公式，风控从审计表重算 | ◐ dry-run 乐观全量，限价偏离>1% 转市价 | ◐ trade:order:fill 三层+日粒度钱包历史+导出含策略源码 | ○ 无内建评估框架 | ◐ 保护器接口化 | ◐ ccxt 双层+二次退避，限速外置 |
| 4 | **qlib** | — | ◐ 有 trade_unit/涨跌停，无组合级风控 | ● **五规则撮合**：量能→现金→整手，max(额×费率,5)，参与率平方冲击 | ○ 记 git diff 但无内容哈希，能描述不能证明 | ● **真 embargo**（trunc_days=horizon+1）+ 含费/不含费双报 | — | ● PIT 算子层拒绝未来；列式二进制 |
| 5 | **vnpy** | — | ⚠ 核心仓无风控（外置闭源包） | ● 六态状态机+部分成交多笔回调（但引擎不聚合不校验） | ⚠ 纯内存 dict，无审计无落盘 | — | — | ◐ 网关按名共存，无 failover；单队列串行 handler |
| 6 | **TradingAgents-astock** | ◐ 串行 7 分析师+质量闸门（无否决权、到不了裁决者） | — | — | ◐ 同上+缺失数据回写可重试任务 | ○ | ⚠ `default="Hold"` 把解析失败变成可交易决策 | ● **A 股多源补数**：tdx 主源+腾讯+新浪补缺+东财龙虎榜/解禁 |
| 7 | **hikyuu** | — | ◐ 现金/手数/超卖硬校验，但 T+1 无显式检查、auto_checkin 可填平现金 | ● **成本按监管年代版本化**+滑点可插拔（默认零）+成交价夹 [low,high]+一字板延迟 | ◐ 内存 trade_list + position_history，无配置快照 | — | — | ◐ 成本/滑点/broker 插件可换 |
| 8 | **clawock-dsh** | ● **证据立场+反方下限+"反方必须引反方证据"** | — | ◐ 委托金额双恒等式（对到分），不含费用/撮合 | ● 文件签名缓存失效（含 #711 踩坑记录） | ● `decision_value_bps` 方向评估，明说不冒充实盘 | ● **版本化 JSON Schema + 七类拒绝码 + abstain** | ◐ FX 陈旧判定 96h |
| 9 | **dsh-quant** | — | ◐ VaR/CVaR/Beta/压力测试可抄；无仓位落地 | ◐ 挂单槽 i→i+1（结构防前视），但无印花税/无 T+1 | — | ◐ IC/RankIC/分层/IC 衰减数学干净，ICIR 未年化 | — | ⚠ 无缓存无熔断，A 股容错不成立 |
| 10 | **capital-generation** | ◐ preset-id 白名单做角色隔离 | — | — | ◐ DatasetRef 引用化 + 每能力 TTL | — | ● systemPrompt 注入点干净 | ◐ 能力目录+params_digest 去重；**无 fallback 链** |

### 2.1 单维最强（可直接指定"去抄谁"）

| 维度 | 最强 | 理由一句话 |
|---|---|---|
| **D1 决策与防洗白** | **clawock-dsh** > TradingAgents | clawock 用"证据 stance + 反方下限 + 反方必须挂反方证据"把反方变成**可机检**的；TradingAgents 只保证反方**有说话**，不保证不是稻草人 |
| **D2 组合与风控** | **ai-hedge-fund** | 唯一一个把"仓位上限"做成**确定性后处理 + 留痕 + 不重分配 + 双层校验**的 |
| **D3 撮合与成交** | **qlib**（A 股口径） / hikyuu（成本版本化） | qlib 五规则最贴 A 股；hikyuu 解决了"费率会变"这个长期问题 |
| **D4 记录与可复现** | **ai-hedge-fund** | 哈希链 + mandate/code 版本绑定 + 两本账互校，是唯一"能证明"而不只是"能描述"的 |
| **D5 评估与校准** | **qlib**（embargo 双报） / clawock（方向评估的诚实边界） | 一个给机器，一个给态度 |
| **D6 提示与输出** | **clawock-dsh** | 版本化 schema + 七类拒绝码 + abstain 一等公民 |
| **D7 数据层** | **astock**（A 股多源补缺） / ai-hedge-fund（PIT+缓存语义） | 前者实战最厚，后者语义最严 |

---

## §3 「我们已有」与「我们没有」的分界

基线 `6b12b4d`（v0.148.0）。逐条对照源码，不采信文档。

### 3.1 我们已有（实测）

| 能力 | 实现位置 | 到什么程度 |
|---|---|---|
| **单据账本** | `src/host/prismAccount.ts`（750 行）、`PrismOrder`/`PrismFill`/`PrismAccount`（`src/shared/prism.ts:131-210`） | 挂单/成交/持仓/权益点齐全；`rejects` 保留被拒委托及原因 |
| **T+1** | `rejectReasonOf` 的 `availableQty < shares` 分支（`prismAccount.ts:90`）、成交前二次校验（`:117-118`） | 买入当日不计入可卖，卖出校验双路径 |
| **涨跌停** | `limitsOf`（`prismAccount.ts:63-69`） | 主板 10% / 创业板科创板（300、301、688、689）20% / ST 5%；涨停不买、跌停不卖、越界拒单 |
| **1 分钟撮合** | `matchOrder` + `MinuteBar`（`prismAccount.ts:123-130`） | 买看 `low ≤ 挂单价`、卖看 `high ≥ 挂单价`，**按挂单价成交**（不用收盘价）；缺 1 分钟退回分时并标注来源 |
| **费用三项** | `feesOf`（`prismAccount.ts:48-54`） | 佣金万 2.5（最低 5 元）+ 卖出印花税千 1 + 过户费万 0.1；**明确不计滑点**（`:9`） |
| **四路并行 + 汇总** | `PRISM_ANALYSIS_META` 四键（`src/shared/prism.ts:114-119`）+ `Promise.all`（`src/host/prismPipeline.ts:105`） | A股宏观 / 外盘 / 大宗 / 信息面，并行后交汇总 |
| **决策 JSON** | `PrismDecision`（`src/shared/prism.ts:211-221`） | `limits{singlePct,totalPct,note}` + `orders[]` + `cancel[]` + `rejects[]` + `parseError` |
| **失败不静默** | `parseError` 字段（`prism.ts:220` 注释「不得静默成 0 笔」） | 解析失败保留原文，不伪装成"模型没动作" |
| **新闻增量** | `PrismNewsState/PrismNewsStatus`（`prism.ts:25-36`）、`PRISM_NEWS_*` 常量（`:109-111`） | 有 backfilling/ready/error 状态机、3 s 缺口、24 h 保留 |
| **熔断器** | `src/host/breaker.ts:26-44` | `open/fails/trips/lastError`，阈值默认 3 |
| **仓位上限的「输入」** | `limits.singlePct/totalPct` 解析（`prismAccount.ts:284-285`） | 仅校验**非空**（`prismPipeline.ts:49`），不校验与实际委托是否一致 |

### 3.2 我们没有（按 7 个维度，实测确认）

| # | 维度 | 缺口 | 证据 |
|---|---|---|---|
| D1 | 决策管线 | **四路是"视角并行"而非"对抗"**：四份分析互不可见、无交叉质询、无多空强制对立，汇总只需"给判断与依据"，**没有反方角色、没有裁决者必须选边的规则** | `prism.ts:115-118` 各 prompt 均为单侧描述；`prismPipeline.ts:105` 只做 `Promise.all` 后拼接 |
| D2 | 组合与风控 | **仓位上限不落地**：`singlePct/totalPct` 是模型自报数，引擎不按它砍单；**无止损/减仓规则**、**无现金缓冲下限** | `prismPipeline.ts:49` 只判 null；`prismAccount.ts` 全文无止损逻辑 |
| D3 | 撮合与成交 | **无滑点**（文档明示不计）、**无部分成交**（一律整笔）、**无成交量约束**（不看 bar 的 volume/amount，理论上可全额吃掉一根 1 分钟 bar） | `prismAccount.ts:9`（不计滑点）、`:123-130`（无 volume 参与） |
| D4 | 记录与可复现 | **无参数版本化、无内容哈希/快照、无回放**：`PrismRun` 只存结果，不能"同输入重跑得同输出" | `prism.ts:62-81`；全仓 `grep hash/sha/replay` 在 prism 相关文件无命中 |
| D5 | 评估与校准 | **完全没有指标**：无超额、无回撤、无命中率、无基准、无训练/验证切分 | `grep 超额/alpha/回撤/drawdown/命中率/胜率` 于 `prism*.ts`、`shared/prism.ts` **零命中** |
| D6 | 提示与输出约束 | **无 JSON Schema**、无结构化校验失败后的重试、**无显式拒答路径**（模型只能说 hold，不能"拒绝判断"） | `PrismDecision` 是 TS 接口而非 schema；`prismPipeline.ts` 只有 `decisionProblems()` 事后挑错 |
| D7 | 数据层 | 有熔断器，但**多源容错/缓存/出处字段**在棱镜链路内未统一（`PrismTradingState.prices` 允许 null + 原因，但无 `cacheState` 三态） | `prism.ts:229-230`；对照 Hanai 的 `ProviderMeta` 五元组（前次侦察 `docs/RECON-WORKBENCHES.md` §1） |

**一句话**：棱镜的**交易侧（撮合/约束/账本）已经相当扎实**，缺的全在**决策侧（对抗性、仓位落地）与评估侧（指标、复现、校准）**。

### 3.3 反过来：这十家里我们**已经更好**的地方（别抄回去）

侦察的价值不止"抄什么"，也包括"别把别人的短板抄进来"。以下四项经代码对照，**棱镜现状优于或等于全部 10 个项目**：

| 能力 | 棱镜 | 对照组的问题 |
|---|---|---|
| **T+1 显式校验** | `rejectReasonOf` 用 `availableQty` 显式拒绝（`prismAccount.ts:90`），成交前二次校验（`:117-118`） | hikyuu **无显式 T+1 检查**，靠"默认次根开盘"隐式实现，且 `auto_checkin` 会把现金预填到买入检查必过（`System.cpp:1079-1092`）；vnpy 完全不涉及 |
| **涨跌停分档** | ST 5% / 创业板科创板 20% / 主板 10%（`prismAccount.ts:63-69`） | hikyuu 的 `ISLIMITUP` **明确未处理 ST 5%**（`IIsLimitUp.cpp:47-68`）；qlib 只有单一 `limit_threshold`；ai-hedge-fund / TradingAgents 无 |
| **成交价取"挂单价"而非收盘价** | 买看 `low ≤ 挂单价`、卖看 `high ≥ 挂单价`，按**挂单价**成交（`prismAccount.ts:129`） | ai-hedge-fund 按"决策自己的参考收盘价"全额成交（`brokers/sim.py:38-50`）；TradingAgents 无撮合层 |
| **失败不静默** | `parseError` 字段保留原文，明确"不得静默成 0 笔"（`prism.ts:220`） | astock 的 `parse_rating(default="Hold")` 把解析失败变成可交易决策（`agents/utils/rating.py:89`） |

另外一条**刻意的设计选择**需要记下来，避免被当成缺陷去"修"：棱镜**不自动重试**——`prismPipeline.ts:6` 写明「失败：该路留痕（`error`）并继续；**不自动重试**」。对照 TradingAgents 的"结构化输出 fail-open + 吞异常"（`structured.py:42-95`），**我们的不重试反而更诚实**。若将来要加重试，应加**有限次 + 留痕 + 拒答**，而不是静默 fallback。

---

## §4 未确认项

### 4.1 读不到 / 无法确认

| # | 事项 | 状态与证据 |
|---|---|---|
| 1 | **clawock-dsh 的闸门实现** | `publish` 的校验逻辑**不在 npm 包里**。包内只有 `skills/investment-decision/{SKILL.md, references/decision.schema.json, references/decision-contract.md, assets/*.example.json}` + `lib/`（gateway/UI/ledger/taskqueue）。七类拒绝码来自 SKILL 文档描述 + schema 约束，**判定代码在外部 `clawock workflow` CLI**。→ 标注为"文档声称 + schema 可验证"，**闸门实现未读到** |
| 2 | **freqtrade 的全部实现细节** | GPL-3.0，**只做了机制描述，未引用任何代码片段**，行号仅供定位。若要复现其"连亏熔断"，必须**独立实现** |
| 3 | **vnpy 的"5 条风控规则"** | 只在 `docs/community/app/risk_manager.md:9-13` 有描述，实现属**仓外闭源包** `vnpy_riskmanager`（`risk_manager.md:27`）→ 文档声称 |
| 4 | **akquant / QuantDinger / Vibe-Trading / nof0** | 均达标（≥100★ 或近期提交）但**未入选**，理由见 §0.3。**未读其源码**，本报告不对其做任何判断 |
| 5 | **`akshare`/`mootdx` 类库的实际可用性** | astock 的数据层依赖 mootdx/tdx/东财端点，**未实测其可达性**；本报告只核实"代码里写了降级与补数逻辑" |
| 6 | **行号时效** | 所有行号对应各自仓库 **HEAD 快照**（2026-10-23 抓取）。vnpy HEAD 处于 v4.x 重构态（`X \| None` + google docstring），hikyuu 成本模块近期刚重构（`FixedATradeCostBase.cpp` 文件时间 2026-10-9），**行号会随上游提交漂移** |
| 7 | **GitHub 搜索覆盖度** | `ai hedge fund stars:>500` 一条查询**被限流**未取到结果，改用单仓 API 补齐；因此 §0.2 的"关键词命中总数"对 AI 对冲基金类项目**不完整** |

### 4.2 判断性结论（有依据但非绝对）

1. **"防洗白"的真实分界**：全部 10 个项目里，**只有 clawock-dsh 把反方变成可机检对象**（证据 stance + 反方下限 + 反方必须引反方证据）。TradingAgents 保证"反方会说话"，但不保证"不是稻草人"；astock 的质量闸门**到不了裁决者**。→ 若棱镜只学一件事，学 clawock 的 `evidence.stance` 契约。
2. **"可复现"的真实分界**：**只有 ai-hedge-fund 能"证明"一次运行**（哈希链 + mandate_hash + code_version + 两本账互校）。qlib 能"描述"（记 git diff 与参数）但不能"证明"；freqtrade 把策略源码打进导出 ZIP，属于"可重跑"而非"可证明"。→ 棱镜补 D4 应照 ai-hedge-fund 的形态，不要照 qlib。
3. **成交模型没有一家能直接用**：qlib 最贴近 A 股但**无 T+1**（靠 `limit_threshold` + 停牌 NaN）；hikyuu 有成本版本化但 **T+1 隐式**；ai-hedge-fund/freqtrade 无费用或极乐观；vnpy 只有状态机没有撮合。→ **棱镜的撮合层其实已经在第一梯队**，需要补的只是 **volume 约束 + 滑点 + 部分成交**三件事，而不是换引擎。
4. **评估是全场最弱的一维**：10 个项目里 D5 拿 ● 的只有 qlib 与 clawock，且两者都**只覆盖一半**（qlib 有 embargo 无归因诚实性，clawock 有诚实性无统计检验）。→ 棱镜在这里是**零起点**，可以直接定一个比它们都完整的最小集（见回报建议）。

### 4.3 方法与合规声明

- 全部源码通过 `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/<path>` 逐文件读取，管道内 `nl -ba` 取行号；**未 clone、未安装、未执行任何被测代码**。
- GitHub API 仅用于元数据与文件树（`repos/*` 11 次、`git/trees/HEAD?recursive=1` 9 次，共 **20 次 core**；搜索 5 次），遵守未认证速率限制（core 60/h、search 10/min）；限流发生时已留痕（§0.2 第 5 行）并改用单仓 API 或 raw 路径。
- **许可处理**：freqtrade（GPL-3.0）**零代码引用**，仅机制描述；nautilus_trader（LGPL-3.0）、rqalpha（NOASSERTION）、TradingAgents-CN（NOASSERTION）**未入选**。其余为 MIT / Apache-2.0，引用保持 1–3 行并标注 `path:line`。
- **仓库写入**：仅新增本文档。`src/**` 零改动，未 commit、未装包、未重启 `dsh web`。
