# VOTE-QUANT — 量化研究员对 PM 积压的复核轮

> **只读**：本轮除本文件外零写入，未改 `src/**`、未 commit、未重启。
> **基线**：`6b12b4d`（v0.148.0）。**输入**：`docs/PM-BACKLOG-PRISM.md`、`docs/RESEARCH-QUANT.md`（我上一轮的原稿）。
> **视角**：执行真实性与可复现 —— 只对"数字可不可信""能不能复现"投票，**不评策略好坏**（R10）。
> **方法**：PM 与我的引用我都自己重核了一遍；凡是新数字都是我在 `~/.dsh/dsh-tradewatcher/*.json` 上算出来的，不是转述。

---

## 一句话结论

**首批 5 项我全部投支持（其中 2 项附硬条件），6 条分歧全部与 PM 同向；评估口径排首批之后我接受 —— 但要求把"基准收盘价"这一列并进 P-01 的同一次改动**，否则 P-03 落地时只能回填历史。**我复核了 PM 依赖的那个数字，它是真的：名义 +40.88% vs 资本调整后 +1.88%。**

---

## §1 五项投票

| ID | 票 | 一句理由 |
| --- | --- | --- |
| **P-01** | **同意** | 我独立复算：10-22→10-23 名义 **+40.88%**，减掉 50 万资本变动后 **+1.88%** —— 不修这一项，净值序列不能用来算任何收益，P-03/P-19/P-20 全部悬空。 |
| **P-04** | **有条件** | 条件：`mandate_hash` 的输入**必须剔除 `lastFired`**；`prismStore.ts:177-182` 每天重写它，否则每天一个新 hash，"同 mandate 可比"当场失效。 |
| **P-05** | **有条件** | 条件：无 volume 必须"**不成交但仍留 pending**"，**不得复用** `prismAccount.ts:703-707` 那条 `status='rejected'` 的终态路径（见坑 1）。 |
| **P-08** | **同意** | 复核成立：全仓 `singlePct/totalPct` 只被 `prismPipeline.ts:49` 判非空 + `prismView.ts:221-223` 展示，**零裁剪**。这是真的"只记录"。 |
| **P-10** | **同意** | `em.ts:3747 export async function fetchIndustryOverview(secids)` 已是现成批量函数（并发 4 / 上限 120 / 10 分钟缓存），零新源零契约改动。 |

**两处附带说明（不改票）**

- **P-01**：`unrealized` 的语义也要一并钉死 —— `prismAccount.ts:243` 算的是 `equity − capitalLimit`（相对本金总盈亏），不是浮动盈亏。PM §7 说"P-01 只加不改"，我同意**保留数值**，但**名称必须标**，否则新口径旁边摆着一个错义的旧名字。
- **P-10**：`fetchIndustryOverview` 对未取到的标的是**缺席**（`em.ts:3751-3754` 只 `names.set` 成功者），不是值为 `null`。消费方必须 `map[secid] ?? null` 再写 `—`（R1），否则 `undefined` 直接进算术。

---

## §2 六条选边

| # | 我选 | 一句理由 |
| --- | --- | --- |
| **C-1** | **甲**（先 P-12+P-13，P-15 紧随） | 没有校验器的 `thesis` 仍是一段自然语言；校验器一旦存在，"非空 + 引用可观测字段"才可机检 —— 乙自己也把 gate 列为前提。 |
| **C-2** | **PM 的裁决**（先 P-01 再 P-03，P-02 并行） | 我原稿把卡 7 排在卡 8 之前；**PM 反过来（P-02 #6 / P-03 #7），我接受这个改动** —— 它更符合我自己写的"卡 8 是卡 7 的地基"。 |
| **C-3** | **甲对，但不为它让路** | P-05/06/07 是撮合车道、P-08/09/11 是约束车道，文件与测试都不重叠，可并行；"P-11 必须等 P-08"这一点乙确实没表态，属缺省。 |
| **C-4** | **暂缓 P-18** | 成本 L 而收益不确定；P-12/P-13 能在**零额外调用**下对已有四份报告做事后审计 —— 先拿 shadow 数据再谈红队。 |
| **C-5** | **两者都只做"提示 + 拒新买单"** | 除 PM 的 R12 理由外补一条量化理由：自动降仓会成为**不可归因的第二决策者**，P-03 的超额归因将永久无法闭合。 |
| **C-6** | **乙**（先冲击口径 + 参数版本化；冲击必须在量能之后） | 常数与冲击是同一字段的两种算法，分两批 = 同一处改两次；且 P-05 未上时"参与率"没有定义，冲击项无处计算。 |

---

## §3 特别判断：评估口径（我的卡 7/8）排到首批之后，接受吗

**接受，但附一个条件。**

### 接受的部分

1. **"修现在就在撒谎的数"确实该排在"修以后算出来的数"之前。** 我复核后确认三处撒谎都真实存在，且都不是风格问题：
   - P-01：有实测数字（见 §5）；
   - P-05：`prismAccount.ts:477/495` 把已到手的 `volume` 丢掉，`matchOrder` 无条件全额成交；
   - P-08：`singlePct/totalPct` 全仓无裁剪。
2. **P-02/P-03 不是被"推迟"，是紧接首批。** 顺位 #6/#7，距首批只隔 5–7 人日，不构成"评估被无限期搁置"。
3. **PM 把 P-02 排在 P-03 之前，比我的原稿更对。** 我原稿写 7→8，PM 写 6→7 —— 这一处我改判，按 PM 的。

### 不接受的部分（条件）

> **P-01 施工时，把基准收盘价（`1.000300`）一并写进净值点。**

- **为什么是同一次改动**：`equityPointOf` 是净值点的**唯一**写入口（`prismAccount.ts:229-246`），P-01 本来就要改它加 `capital`。同一函数里多写一列 `benchmarkClose`，边际成本≈0。
- **为什么不新增源**：`em.fetchKline('1.000300', 101, 300, 0)` 在 `tools.ts:1359` 已有调用先例，属既有链路（R5 不触碰）。
- **不这么做的代价**：净值点一旦不带基准就**落了空档**。P-03 落地时只能回填历史。回填技术上确定性可行（指数日线不会变），但会 (a) 触发 R9 留档；(b) 让"回填点"与"原生点"口径不同，此后每个读这段序列的人都要多问一句"哪些是回填的"。
- **一句话**：**用 S 的成本（一个字段、半天）避免 M 的返工（回填 + 双重口径分支 + 一段永久的解释负担）。**

### 如果 PM 不接受这个扩容

那我接受更窄的 P-01，但要求 P-03 的施工说明写死一句、并写进 UI：

> 「2026-10-23 之前的历史净值点无基准，超额从有基准的第一天起算」+ 空档显示 `—`（不是 0，R1）。

**我不会因为这一条投反对票** —— 它是优化，不是阻断。

---

## §4 先做会踩的坑（3 条）

### 坑 1 — P-05 的"不成交"会被写成"永久拒单"

`status` 在撮合循环里是**终态**，循环开头直接跳过：

```ts
// src/host/prismAccount.ts:677
    if (order.status !== 'pending') continue
```

而"取数失败"这条路径**直接把单判死**：

```ts
// src/host/prismAccount.ts:702-707
    const barsResult = await deps.bars(order.secid, day)
    if (barsResult.source === null) {
      order.status = 'rejected'
      order.rejectReason = barsResult.reason ?? '撮合数据不可用'
      rejected += 1
      continue
```

`source === null` 恰恰是**瞬时失败**的返回值：

```ts
// src/host/prismAccount.ts:512
    return { bars: [], source: null, reason: `1 分钟/分时取数失败（${String(error).slice(0, 60)}）` }
```

⇒ **今天一次网络抖动就能让当日全部挂单作废，且永不重试。** 这是既有缺陷，不是 P-05 引入的，但 P-05 会放大它：`trend` 兜底源造 `high=low=price` 且**没有 volume**（`:507`），若把"无 volume"并进同一条 `rejected` 路径，**每一张走 `trend` 撮合的单都会在第一个 tick 死掉**。

**要怎么做**：P-05 必须新增第三条分支 ——「**跳过但不改状态**」（留在 pending，下个 tick 再看），并在 `rejectReason` 之外另设非终态的 `skipReason` / 计数。
**措辞也要改死**：PM 验收锚写的是"该单**不成交** + 拒因"——在现有实现里"不成交"和"拒单"是两件不同的事，这一句会被实现成后者。

### 坑 2 — P-01 的基准来源**已经**对不上（实测差 93,023.63）

```
prism-account.json → dayStartEquity = 1,374,825.29
prism-equity.json  → 2026-10-22 的 equity = 1,281,801.66
差                = 93,023.63
```

而界面正拿它算"当日盈亏"：

```ts
// src/client/prismView.ts:99
  const day = a.dayStartEquity === null ? null : equity - a.dayStartEquity
```

`:103` 的提示只在 `null` 时出现（「当日基准净值未取到」）—— 这里非 `null`，**一句警告都没有**。而 `rollDay` 的回退分支会**静默保留旧值**：

```ts
// src/host/prismAccount.ts:225
  return { ...account, day, positions, dayStartEquity: previousEquity ?? account.dayStartEquity }
```

`previousEquity` 来自 `store.equity().at(-1)?.equity`（`matchTick` `:671`、`placeDecision` `:558`）；净值文件读空时它即 `null`，于是 `dayStartEquity` **保留上一次的值**，看起来完全正常。

⇒ **P-01 的"资本调整后收益"必须从「净值序列 + `capital` 差分」推导，不得以 `dayStartEquity` 为基。** 同时建议顺手修掉这个静默回退（读空置 `null` 并如实提示 —— 符合 R2"读不到 ≠ 没有"）。

> `dayStartEquity` 为何是 1,374,825.29 —— **原因未确认**：可能是同日 `upsertEquity` 覆盖（`:248-252`）或上述静默回退二者之一。**不猜**，但无论哪个，结论都是"别拿它当基准"。

### 坑 3 — P-04 的 `mandate_hash` 会被 `lastFired` 每天污染

`prism-settings.json` 实测只有四个字段：

```json
{"v":1,"times":["09:35","11:15","13:10","14:35"],
 "lastFired":{"2026-10-23":["09:35","11:15","13:10","14:35"]},
 "model":null,"capital":2000000}
```

而 `lastFired` 每天被重写，且只保留当天 key：

```ts
// src/host/prismStore.ts:177-182
    const slots = new Set(this.settingsValue.lastFired[day] ?? [])
    this.settingsValue.lastFired = { ...this.settingsValue.lastFired, [day]: [...slots].sort() }
    const keep: Record<string, string[]> = { [day]: this.settingsValue.lastFired[day] as string[] }
    this.settingsValue.lastFired = keep
```

⇒ 直接哈希整个 settings ⇒ **每天一个新 mandate hash**，P-04 声称的价值（"这轮和上轮能不能比"）当场归零，而且失败方式很隐蔽：hash 一直在变，没人会立刻发现是 `lastFired` 干的。

**附带一处**：PM 说复用 `filesChecksum`（`backup.ts:37-39`），但它的 `canonical()` 是**模块私有**（`backup.ts:41`），要复用得先导出；且它 `.slice(0, 16)` 截断到 64 bit —— 做 mandate 指纹够用，**做哈希链（Q6，本轮缓做）不够**。

---

## §5 复核留痕（我自己算的，不是转述）

| 项 | 我的实测 | 结论 |
| --- | --- | --- |
| 10-22→10-23 名义收益 | 524,053.34 / 1,281,801.66 = **+40.88%** | 与 PM 引用的"+41%"一致 |
| 资本调整后 | (1,805,855 − 500,000) / 1,281,801.66 − 1 = **+1.88%** | 与名义值差 **39 个百分点** |
| 恒等式自检 | Δequity − (ΔpositionsValue + Δcash) = **0.000000** | 净值口径内部自洽，问题只在"没减去资本变动" |
| 50 万的来源 | `prismRoutes.ts:375-377` `capitalAfter = Math.max(capitalBefore, required)` | 是**复制自动提额**（v0.148.0），非用户入金 —— 但对收益口径的破坏完全相同 |
| P-08 是否真的只记录 | 全仓 `singlePct` 消费方 = `prismPipeline.ts:49`（判空）+ `prismView.ts:221-223`（展示） | **确认无裁剪** |
| P-10 是否有现成批量函数 | `em.ts:3747 export async function fetchIndustryOverview` | 已导出、并发 4、上限 120、10 分钟缓存 |
| 净值点是否带基准 | `prism-equity.json` 两点均无 `benchmark` 字段（只有 `equity/cash/positionsValue/realized/unrealized/at`） | P-03 的基准维度**零起点**，与 §3 的条件同源 |

---

## §6 未确认

1. `dayStartEquity = 1,374,825.29` 的确切成因（坑 2 已给两个候选，未定）。
2. 腾讯 m1 的字段顺序（`r[3]/r[4]=high/low` 为推断，`r[5]=volume` 未核对）—— 上一轮已标，P-05 施工前应按 `em.ts:1697-1724` 的做法做一次真机标定并写进注释。
3. 参与率参数（10% / 25%）无标定。P-05 施工**必须先定一个并写进 settings**（与 C-6 / P-07 同一条纪律），否则同一段历史换个参数就换个答案。
4. P-01 若并进 `benchmarkClose`，`upsertEquity` 的 365 天滚动窗口（`prismAccount.ts:252`）会让超过一年的点被静默丢弃 —— 对"长期可复现"是另一个暗坑，但不在本轮范围。
