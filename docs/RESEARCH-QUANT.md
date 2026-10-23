# RESEARCH-QUANT — 棱镜「执行真实性」与「可复现」量化评估

- 角色：量化/金工研究员（**只读**，未改代码、未运行引擎、未提交）
- 基线：`dsh-tradewatcher` HEAD `6b12b4d` / `v0.148.0`
- 输入：`docs/RECON-PAPERTRADE.md`（§2 ai-hedge-fund、§4 qlib）、`src/host/prismAccount.ts`、`src/shared/prism.ts`、`src/host/prismPipeline.ts`、`src/host/prismStore.ts`、`src/host/signalForward.ts`、`src/host/backup.ts`
- 视角：**执行真实性**（成交价/量到底可不可信）与**可复现**（能不能"证明"而不是"描述"）
- 方法声明：**全部结论来自读码**，没有一条是跑出来的。凡是"会怎样"都是推断，已在风险栏标注。

---

## §0 一句话结论与优先级

> **D3 的缺口不是"模型不够聪明"，是"引擎无条件给足量"。**
> `matchOrder` 只要价格触及就按挂单价**全额**成交（`src/host/prismAccount.ts:130-140`），而 bar 结构里**根本没有 volume 字段**（`:123-127`）——**而数据源其实给了，是我们自己丢的**（`:477`、`:495`）。这是本次最重要的一条：补 volume 约束**不需要新数据源、不需要换引擎**。

**建议执行顺序（按"每单位成本消除的乐观偏差"排序）**

| 序 | 事项 | 为什么排这个位置 |
|---|---|---|
| 1 | **卡 1** 量能约束 + 无 volume 源降级 | 零新数据、零新依赖；直接砍掉最大的乐观来源 |
| 2 | **卡 4** `code_version` + `mandate_hash` | 成本最低的两个字段，却是后面所有评估的**前提**（不比版本就没有可比性） |
| 3 | **卡 7** 评估口径（超额/回撤/命中率） | 现在**零指标**；没有它，前六张卡的价值无法被验证 |
| 4 | **卡 8** embargo + 非重叠样本 | 卡 7 的地基。**不做这条，卡 7 的数字是装饰** |
| 5 | **卡 2** 部分成交 | 卡 1 天然产生 partial，两者共用一次改动 |
| 6 | **卡 3** 参与率平方冲击 | 只有在卡 1 生效后才有意义（没有量就没有参与率） |
| 7 | **卡 5** 两本账互校 | 低成本，但**必须先定对账起点**，否则天天假警 |
| 8 | **卡 6** 哈希链 | 最贵；且卡 4/卡 5 已经吃掉了它 80% 的实用价值 |

> **一句话**：①②③ 三件事都该做，但**顺序比选型重要**。侦察说"只差 volume/滑点/部分成交"，从执行真实性角度我同意；但**评估口径（③）的优先级被低估了**——没有 embargo 的胜率/超额，会把前面所有真实性改进的功劳记错账。

---

## §1 现状速读（六张卡的共同底座）

### 1.1 成交是"价格触及即全额成交"

```ts
// src/host/prismAccount.ts:123-127
export interface MinuteBar {
  t: number
  high: number
  low: number          // ← 没有 volume
}

// :130-140  撮合：买看 low ≤ 挂单价，卖看 high ≥ 挂单价；按**挂单价**成交
export function matchOrder(order, bars) {
  for (const bar of bars) {
    if (bar.t < order.decidedAt) continue
    if (order.side === 'buy'  && bar.low  <= order.price) return { price: order.price, at: bar.t }
    if (order.side === 'sell' && bar.high >= order.price) return { price: order.price, at: bar.t }
  }
  return null
}
```

成交落账时数量直接取委托量，没有第二种可能：

```ts
// src/host/prismAccount.ts:726
      shares: order.shares,
```

**三个后果**（按严重度）：
1. **一张 500 万元的买单和 1 万元买单，在模型里成交概率完全相同** —— 只要那根分钟线的最低点碰到挂单价。
2. **0 成交量的分钟线也照吃** —— `low <= price` 对"全天只有 1 手成交"和"全天成交 500 万手"一视同仁。
3. **`trend` 兜底源会把 `high=low=price`**（`:507`），于是**必然成交在第一根 tick** —— 这是最乐观的一条路径，而它恰好是"取不到 1 分钟线"时的降级路径（`:505-512`）。

### 1.2 量能数据"已经在手上，被 map 扔了"

**这是全篇最关键的发现**：不需要接任何新数据源。

```ts
// src/host/prismAccount.ts:477   （新浪 1 分钟线 → bar）
          return { t, high: Number(r['high']), low: Number(r['low']) }
//                              ↑ 同一行里的 r['volume'] / r['amount'] 直接丢掉了

// :495  （腾讯 m1 → bar）
          .map((r) => ({ ..., high: Number(r[3]), low: Number(r[4]) }))
//                                    ↑ r[5] 是 volume，同样丢掉

// :507  （分时兜底 → bar）
    const bars = points.filter(...).map((p) => ({ t: p.t, high: p.price, low: p.price }))
//                                                 ↑ 这个源本来就没有量
```

而**同一支新浪接口的 volume 字段，仓库里别处已经在解析了**：

```ts
// src/host/em.ts:1685
/** 新浪分钟线的一根（`volume` 是**股**、`amount` 是该根的成交额（元），不是累计值） */
// src/host/em.ts:1710-1721
  const rows = (await res.json()) as Array<{ day?: unknown; close?: unknown; volume?: unknown; amount?: unknown }>
  ...
    out.push({ t, label, price, vol: num(r.volume), amount: num(r.amount) })
```

且 `em.ts:1697-1699` 有真机实测记录：「`scale=1&datalen=1023` 回 1023 根、5 个交易日，每个交易日 238 根……`volume` 是**股**、`amount` 是**该根**成交额（元）——与腾讯"累计值"不同，不需要差分」。

⇒ **口径已经标定过、单位已经确认过、连"不需要差分"这个坑都踩过了。** 卡 1 的成本因此从 M 降到 S。

### 1.3 可复现：现在只有"推断"，没有"证明"

- `PrismRun` 只有 `slot/day/at/reports/decision/placement/startedAt/finishedAt/analyses/summary/error`（`src/shared/prism.ts:62-81`）——**无 hash、无 code_version、无 mandate_hash**（与 RECON:363 的判断一致）。
- `PrismFill` 有 `orderId/secid/side/price/shares/amount/fee/at/source`（`src/shared/prism.ts:143-155`）——全是有用数据，**没有链**。
- `rebuildFromOrders()`（`src/host/prismAccount.ts:639-661`）**自承只是推断**：
  > `cash 仅作参考`、`未包含历史入金/未知成交`（`:661`）

也就是说：**现在改一个字节的 `prism-trading.json`，没有任何机制能发现。** 这正是 RECON 说的"能描述不能证明"。

### 1.4 评估：零指标，但仓库已有正确的"纪律模板"

`PrismEquityPoint` 只有 `equity/cash/positionsValue/realized/unrealized/at`（`src/shared/prism.ts:177-185`）——**没有基准、没有回撤、没有样本量**。

但**别处已经写对过一次**，可以直接抄纪律：

```ts
// src/host/signalForward.ts:1-12（文件头红线）
//  ① 必须同时给基准与持有期 —— "一张只有'至今涨跌幅'的表回答不了'这段时间大盘也涨了 20%'"
//  ② 样本 < 10 照旧输出，但显式标注"样本过少，不构成统计结论"
//  ③ 不许表述成"信号有预测能力"
//  ④ 基准缺失 ⇒ null，不当 0
```

`forwardOf()`（`:79-140`）已经实现了：逐事件 `retPct / benchPct / excess`、自然日与交易日双持有期、`n / winRate / avgExcess / medianExcess`、`n < FORWARD_MIN_SAMPLES(10)` 自动加 note（`:62`、`:122`）。基准 `1.000300`（沪深300）也是现成的：`src/host/rescue.ts:140`、`src/host/globalFlow.ts:155`、`src/host/routes.ts:895`。

**但 `forwardOf` 有一个不能照搬到策略评估的结构缺陷** —— 每个事件的窗口都延伸到"**最新数据日**"（`:96-104`），所以同一天产生的多个事件、以及相邻事件之间，**持有期高度重叠**。作为"过去 N 次信号之后发生了什么"的回顾它是诚实的；但把它的 `winRate`/`n` 当作独立样本去证明策略有效，就是在**伪独立样本上做过拟合**。卡 8 专门处理这一点。

---

## §2 六栏特性卡（8 条）

### 总览

| # | 特性 | 现状差距 | 价值 | 成本 | 风险 | 判定 |
|---|---|---|---|---|---|---|
| 1 | 量能约束 + 无量源降级 | `MinuteBar` 无 volume（`prismAccount.ts:123-127`）；成交取满量（`:726`）；volume 在 `:477/:495` 被丢 | 消掉最大乐观来源；真实度跃升一档 | **S** | 降级源会变"完全不可成交" | **做，第一位** |
| 2 | 部分成交 | 订单仅 4 态（`shared/prism.ts:167`）；`applyFill` 假设整单（`:143-173`） | 大单不再"一口吃下"；与 1 共用改动 | **M** | T+1 与日内多笔聚合的一致性 | **做，紧跟 1** |
| 3 | 参与率平方冲击 | 成交价恒等于挂单价（`:132,134`） | 大单被结构性惩罚（qlib 同款） | **S** | 偷偷改价会变成不可解释的成交价 | **做，但必须在 1 之后** |
| 4 | `code_version` + `mandate_hash` | `PrismRun` 无版本字段（`shared/prism.ts:62-81`） | 所有跨期比较的前提 | **S** | 非 git 部署取不到版本 | **做，第一位（与 1 并列）** |
| 5 | 两本账互校 | `rebuildFromOrders` 只被测试调用（`prismLedgerRecovery.test.ts:59`） | 漂移可被发现而非靠人看 | **S** | 对账起点不定 ⇒ 天天假警 | **做，但先定起点** |
| 6 | 哈希链 + 断链拒回放 | 全仓无 fill 链（`grep` 确认） | 从"推断"升到"证明" | **M** | 字段演进即断链 | **缓做，卡 4/5 先上** |
| 7 | 评估口径（超额/回撤/命中率） | `PrismEquityPoint` 无基准无回撤（`shared/prism.ts:177-185`） | 从零指标到可自证 | **M** | 含费口径若不双报会虚高 | **做，第三位** |
| 8 | embargo + 非重叠样本 | 无（且 `forwardOf` 的构造不可照搬） | 决定卡 7 数字有没有意义 | **M** | 样本会更少，可能诚实地说"不够" | **做，卡 7 的地基** |

---

### 卡 1 — 量能约束（参与率上限）+ 无 volume 源降级

| 栏 | 内容 |
|---|---|
| **现状差距** | `MinuteBar` 无 `volume` 字段（`src/host/prismAccount.ts:123-127`）；两处数据源 map 把已到手的 `volume` 丢掉（`:477` 新浪、`:495` 腾讯）；成交数量恒等于委托量（`:726`）；分时兜底源造 `high=low=price`（`:507`）⇒ 必成交。**委托量由 LLM 直接给定**（`:583` `shares: d.shares`），中间无任何裁剪。 |
| **价值** | ① 把"价格触及"这个**必要条件**补成"价格触及 **且** 有量"这个**充分条件**；② 大额委托的成交概率开始随规模下降，这是唯一能让「LLM 报的仓位」和「实际能拿到的仓位」产生差异的机制；③ 顺带修掉 `trend` 路径的静默乐观。 |
| **成本 S** | 纯函数级改动：`MinuteBar` 加 `vol?: number`、两处 map 各加一个字段（单位：股，`em.ts:1685` 已标定）、`matchOrder` 返回 `{price, at, filledShares}`。**不新增请求**（bar 是既有 `deps.bars` 调用，且有 30s 缓存 `BARS_TTL_MS = 30_000`，`:449`）；不新增依赖；不换引擎。 |
| **风险** | ① **参与率参数本身是个自由度** —— 定 10% 还是 25% 会直接改变回测结论，**必须写进 `PrismSettings` 并落盘版本**，否则同一段历史换个参数就换个答案（这正是卡 4 存在的理由）；② `trend` 兜底源无 volume ⇒ 只有两个诚实选项：**拒绝成交并说明原因**，或**标记 `source:'trend'` 且按固定低参与率打折**。前者更诚实但会让冷门票长期不成交——**我倾向前者**，因为它与仓库既有口径一致（"读不到 ≠ 空数据，不覆写"）。③ 只约束单根 bar 的 10% 仍不足以反映"多根 bar 累积吃量"，第一版可接受，但要在口径里写明。 |
| **判定** | **做，且排第一。** 这是唯一"零新数据、零新依赖、直接消除最大乐观偏差"的改动。侦察说这是 D3 唯一缺口之一，读码后我确认：**缺口成立，且比侦察描述的更便宜**（数据早已在响应里）。 |

---

### 卡 2 — 部分成交（partial fill）

| 栏 | 内容 |
|---|---|
| **现状差距** | `PrismOrder.status` 只有 `'pending' \| 'filled' \| 'cancelled' \| 'rejected'`（`src/shared/prism.ts:167`），**没有 partial**；`applyFill` 整个函数的前提是"一次成交即整单"（`src/host/prismAccount.ts:143-173`），`fill.shares` 永远等于 `order.shares`；`matchTick` 命中一次就把 `order.status` 置 `filled`（`:738`）并 `continue`。 |
| **价值** | ① 让「挂单」变成真正的**时间切片**而不是二值事件；② 与卡 1 天然耦合——量能上限一旦生效，**剩余量必须留在 `pending`，否则等于偷偷放大成交量**；③ 对"日内多次触及"的记录能力，是卡 7 里"成交质量"指标的前提。 |
| **成本 M** | 要动四处：`PrismOrder`（加 `filledShares`，`status` 加 `'partial'`）、`applyFill`（按 `fill.shares` 增量摊薄，逻辑本身已支持增量成本 `netCost`，`:158-165`）、`matchTick`（命中后算剩余量，`:709-741`）、UI（`src/client/prismView.ts` 的状态映射）。**测试面**：既有 `prismCash.test.ts`/`prismLedger.test.ts` 用例需补 partial 分支。 |
| **风险** | ① **一致性没人管**——RECON §5 已记 vnpy 的教训：「部分成交的"状态"有了，但"一致性"没人管」（不校验 `Σ成交量 ≤ 委托量`）。我们必须自己写这条断言，否则重复 tick 会把同一单吃两次。② 与 T+1 的交互：当日买入的 partial 份额不计入 `available`（现有 `applyFill:149` 新增持仓时写死 `available: 0`，语义正确，但 partial 多次买入要保证每次都写 0）。③ 与卡 3 的耦合：partial + 冲击，成交价会随批次恶化，**必须把每次 fill 的 `impact` 单独落盘**，否则事后无法解释总成交均价。 |
| **判定** | **做，紧跟卡 1。** 事实上这两张卡应该**同一次改动**落地——只加 volume 约束不加 partial，会出现"剩余量凭空消失"，比不加更糟。 |

---

### 卡 3 — 参与率平方冲击（slippage / impact cost）

| 栏 | 内容 |
|---|---|
| **现状差距** | 成交价恒等于挂单价（`src/host/prismAccount.ts:132`、`:134`），**任何规模都零价格冲击**。费用侧只有 `feesOf`（`:48-54`，佣金最低 5 元 + 印花税卖出），没有冲击项。 |
| **价值** | 抄 qlib 的形态：`adj = impact_cost × (成交额 / 该区间总成交额)²` 加在该方向费率上（RECON:164 引 `exchange.py:877,889-895`）。**平方**而非线性是关键：小单几乎无成本、大单惩罚急剧上升——这正好是"A 股散户小单 vs 模拟盘大单"的真实差别。 |
| **成本 S** | 纯算术，与 `feesOf` 同层。但**有一个不可省的字段**：`PrismFill`（`shared/prism.ts:143-155`）要新增 `impact`，否则事后分不清"价差"和"冲击"。 |
| **风险** | ① **最危险的做法是把它塞进 `price`** —— 那会让成交价变成一个既不是挂单价也不是市场价的第三个数，事后完全不可解释，也破坏"按挂单价成交"这条既有语义。**必须单列 `impact` 字段**，`amount` 可以含它，`price` 保持挂单价。② 参与率的分母（该分钟总成交额）在 `trend` 源不存在 ⇒ 与卡 1 共用同一条降级路径。③ 参数默认值 `impact_cost = 0.1` 是 qlib 注释里的"推荐值"（RECON:163），**不是 A 股标定值**，不能当结论用。 |
| **判定** | **做，但必须在卡 1 之后。** 没有量能上限就没有参与率，此时加冲击等于给一个不存在的量算罚款。 |

---

### 卡 4 — `code_version` + `mandate_hash` 绑定 run

| 栏 | 内容 |
|---|---|
| **现状差距** | `PrismRun`（`src/shared/prism.ts:62-81`）只有 `slot/day/at/reports/decision/placement/startedAt/finishedAt/analyses/summary/error`。**没有产生这次决策的"是什么"**：不知道用的是哪版代码、哪版骨架、哪个模型、哪组参数。ai-hedge-fund 的 `SessionRecord` 里这些全有（RECON:121，`pipeline/session.py:86-106`）。 |
| **价值** | ① **没有它，卡 7 的任何跨期指标都是把不同实验混在一起算**——改了骨架前后两段胜率不能平均；② 它是"换 mandate 的决策应被拒绝执行"（ai-hedge-fund `:194`）的前置；③ 成本极低，是全场性价比最高的一处。 |
| **成本 S** | 两个字段 + 两次赋值。`mandate_hash` 直接复用**仓库已有的稳定序列化 + 哈希**：`filesChecksum()`（`src/host/backup.ts:37-39`，`createHash('sha1')` + `canonical()` 键排序，`:41-49`）。`mandate` 的输入就是 `settings` + `skeleton`（`prismStore` 已分别落盘 `prism-settings.json` / `prism-skeleton.md`）。`code_version` **不要取 git sha**——仓库已有更好的先例：手维护常量 `ENGINE_VERSION = '0.16.0'`（`src/host/rescue.ts:139`）+ 构建注入 `__TW_VERSION__`（`src/host/routes.ts:563`）。非 git 部署（用户直接装包）取不到 sha，而常量永远可读。 |
| **风险** | ① **`code_version` 若靠人记得改，就一定会忘** —— 必须挂进既有测试纪律（仓库对这类常量有先例：`rescue.ts:143-145` 把标定常量连同"凭什么"一起写成常量并断言）；② `mandate_hash` 覆盖范围要写死（只含 `capital/times/skeleton/model`？含 `impact_cost` 等新参数？）——**覆盖不全比没有更糟**，因为它给了"可比"的错觉；③ 与卡 6 的向后兼容技巧：ai-hedge-fund 的 `compute_hash` **只在 `snapshot_times is None` 时排除该字段**（RECON:121），这是老账本能继续验证的关键，抄的时候别漏。 |
| **判定** | **做，排第一（与卡 1 并列）。** 这是所有"跨期比较"的地基，且是全部八张卡里最便宜的一张。 |

---

### 卡 5 — 两本账互校（account vs 从 orders 重建）

| 栏 | 内容 |
|---|---|
| **现状差距** | `rebuildFromOrders()`（`src/host/prismAccount.ts:639-661`）实现了"从 `orders.json` 的已成交单反推 fills 与 cash"，**但它只被测试调用**（`src/host/prismLedgerRecovery.test.ts:59-69`），生产路径从不比对。`matchTick` 直接把 `applyFill` 的结果写回 `account`（`:731-735`），没有第二个人校验。 |
| **价值** | 抄 ai-hedge-fund 的「两份账本互相校验，**不一致就抛错而不是自动修复**」（RECON:122，`brokers/paper.py:3-7`、`pipeline/session.py:213-226`）。我们现在连"漂了"都不会知道。 |
| **成本 S** | 已有函数 + 一个比对入口。**关键不是写代码，是定口径**。 |
| **风险** | ① **`rebuildFromOrders` 从 `capitalLimit` 起算**（`:640` `let cash = account.capitalLimit`），而 `capitalLimit` 会因"复制持仓自动提额"（HEAD 提交 `v0.148.0` 就在做这件事）而变化 ⇒ **天然对不上**。必须先界定「从哪个锚点之后开始对账」（建议：每个交易日 `rollDay` 时落一个 anchor，只比当日增量）。② ai-hedge-fund 的做法是**抛错**；但在宿主插件里抛错会让 UI 整页挂掉 —— 建议改为**写入不一致记录 + 状态降级 + 拒绝下单**，把"抛错"降级为"停止交易"，比让面板崩掉更可用。③ 现有 `rebuildFromOrders` 的 note 已诚实声明"未包含历史入金/未知成交"（`:661`），说明作者知道它是近似的 —— 拿近似值做严格对账会天天报警。 |
| **判定** | **做，但必须先定对账起点。** 没有起点就别上，否则会变成"每天一条假警"，很快被无视。 |

---

### 卡 6 — 哈希链（fills/orders）+ 断链拒回放

| 栏 | 内容 |
|---|---|
| **现状差距** | 全仓 `grep` 无 fill 链：`PrismFill`（`src/shared/prism.ts:143-155`）是扁平数组，`prismStore` 用 `updateJsonLocked` 整文件覆写（`prismStore.ts:221,226`）。**改一个字节无人知晓**。RECON:363 的"无内容哈希/无回放"判断成立。 |
| **价值** | 把账本从"存储"变成"证据"：每条 fill 带上一条的哈希 ⇒ 缺一条/乱序/被改一笔，回放**直接拒绝**（RECON:120，`ledger.py:1-8`）。这是唯一能回答"这轮模拟盘的数字我凭什么信"的机制。 |
| **成本 M** | `PrismFill` 加 `prevHash/hash`；写入路径加链；新增 `replay()` 逐链验证（ai-hedge-fund 的 `replay(full=True)` **忽略 checkpoint**，RECON:123）。哈希原语**已有**：`filesChecksum()` + `canonical()`（`backup.ts:37-49`）—— 但注意它 `.slice(0,16)` 截断到 16 字符，做**链**要改成完整摘要。 |
| **风险** | ① **字段演进即断链** —— 这是最大的运维风险。ai-hedge-fund 的解法是"计算时排除 `hash` 字段，且只在 `snapshot_times is None` 时排除该字段"（RECON:121）；我们要照抄这个兼容技巧，否则**第一次加字段就让全部历史无法验证**。② 仓库已有 `BACKUP_SCHEMA_VERSION` + 版本闸门先例（`backup.ts:10`、`:107-108` 明确"高版本无法理解⇒拒绝而不是静默接受"）—— 哈希链也该有自己的 `LEDGER_FORMAT_VERSION`。③ **不要**同时上 checkpoint 优化：ai-hedge-fund 的第一版是纯逐链验证，checkpoint 是后来的缓存且**必须与链头哈希一致才被采信**（RECON:123）。先做慢的、对的。 |
| **判定** | **缓做。** 卡 4（版本绑定）+ 卡 5（互校）已经吃掉了它 80% 的实用价值，而它带来的是全部八张卡里最重的长期运维负担。**如果只做一件事，做卡 4；如果做两件，加卡 5。** 哈希链留给"要认真对外交付战绩"的那天。 |

---

### 卡 7 — 评估口径：超额 / 回撤 / 命中率

| 栏 | 内容 |
|---|---|
| **现状差距** | `PrismEquityPoint` 只有 `equity/cash/positionsValue/realized/unrealized/at`（`src/shared/prism.ts:177-185`）——**无基准、无回撤、无样本量、无含费/不含费双报**。`unrealized` 的算法是 `equity - account.capitalLimit`（`prismAccount.ts:243`），即"相对本金的总盈亏"，**不是浮动盈亏**——字段名和语义已经不一致了。 |
| **价值** | 从"零指标"到"能自证"。三个指标各自的正确形态：<br>• **超额**：`总收益 − 同期基准收益`，基准直接用现成的 `1.000300`（`rescue.ts:140`/`globalFlow.ts:155`），**不引入新数据源**；<br>• **回撤**：用**日净值序列**算（`upsertEquity` 已保证一天一点，`prismAccount.ts:248`），口径 = `min(equity/cummax − 1)`；<br>• **命中率**：按**超额为正**计，不按绝对收益计——RECON:130 引 ai-hedge-fund 的原话「a long-only analyst in a bull market must not score for free」。 |
| **成本 M** | 要给 `PrismEquityPoint` 加 `benchmarkClose`（ai-hedge-fund 的 `SessionRecord` 里就有这个字段，RECON:121），并在 `matchTick` 收尾处一并写入（`:757-759` 已有 equity 落盘点）。指标计算本身是纯函数，可直接抄 `forwardOf` 的 `summary` 结构（`signalForward.ts:110-130`：`n/winRate/avgExcess/medianExcess/note`）。 |
| **风险** | ① **含费/不含费必须双报**（qlib 的 `excess_return_without_cost` / `with_cost` 并列，RECON:174）。我们已经有 `feesOf`，只报一个数就是把费用的影响藏起来。② **命中率的分母是"决策次数"还是"成交次数"** —— 这个选择会显著改变结论，且极易被无意识地挑一个好看的。必须写死并在界面标注。③ **`unrealized` 现有语义（相对本金）与名字不符**（`prismAccount.ts:243`），做指标时会踩到 —— 要么改名，要么明确"这是累计浮盈不是入场浮盈"。④ **只有 4 个默认时点**（`PRISM_DEFAULT_TIMES`，`shared/prism.ts:106`）⇒ 一天最多 4 个决策点，样本积累极慢。**这是评估的现实约束：跑一个月也只有约 80 个决策点**，任何"月胜率"都还在这条卡的第 8 卡警告范围内。 |
| **判定** | **做，第三位。** 但必须先接受一个结论：**短期（<3 个月）这套指标的用途是"发现引擎荒谬"，不是"证明策略有效"**。写进界面文案，别写成绩单。 |

---

### 卡 8 — embargo + 非重叠样本（防过拟合的机器）

| 栏 | 内容 |
|---|---|
| **现状差距** | 无训练/测试切分、无 walk-forward、无 embargo。更具体地：**仓库里唯一的评估器 `forwardOf` 的样本构造不可直接复用** —— 每个事件的窗口都从信号日延伸到"**最新数据日**"（`src/host/signalForward.ts:96-104`），于是相邻事件的持有期**高度重叠**。它的 `n`（`:115`）数的是"能算出超额的事件数"，**不是独立样本数**。 |
| **价值** | 抄 qlib 的形态而不是细节：`trunc_days = horizon + 1` 作为默认 embargo（RECON:173，`qlib/workflow/task/gen.py:128-139`）——**标签周期的长度 +1 天**必须从训练段里切掉，否则"用明天的信息预测今天"。对我们的场景，embargo 的含义是：<br>• 评估任一决策时点，**它之后的 horizon 天内产生的其它决策点，不得计入同一批统计**；<br>• 若用"当天新闻"做输入，**同一交易日的不同时点之间**本身就是高度相关的样本。 |
| **成本 M** | 不需要框架，只需要**一条抽样规则 + 一条断言**：按"非重叠窗口"重建事件序列（每个窗口取第一个事件，跳过随后 `horizon` 天），并把 `n` 改成"独立窗口数"。断言可以照仓库既有风格写成可注入反例的测试（`uiuxDiscipline.test.ts` 的写法已在仓库确立）。 |
| **风险** | ① **样本会变少，而且可能少到"不该下结论"** —— 一天 4 个时点、1 个月 80 个决策点，非重叠化后可能只剩 ~20 个独立窗口。这不是失败，是**真实的信息量**。关键是界面要像 `forwardOf` 那样**如实说"样本过少"**（`FORWARD_MIN_SAMPLES = 10`，`:62`、note 在 `:122`），而不是用 80 个伪样本画一条漂亮的胜率曲线。② **embargo 长度选错方向都会错**：太短 ⇒ 泄漏；太长 ⇒ 没样本。qlib 给的 `horizon + 1` 是"标签周期"的口径，我们的 `horizon` 是什么需要先定（建议先定为决策的持有期上限，而不是拍一个数）。③ **别把 embargo 做成一个可调参数** —— 一旦可调，它就会被调到"结果最好看"的那个值。写死常量 + 断言，像 `ENGINE_VERSION` 那样。 |
| **判定** | **做，且必须先于卡 7 的"下结论"能力。** 如果只能做一件事，而目标是"数字可信"，那么**卡 8 比卡 7 更重要** —— 没有卡 8，卡 7 只是在生产精装修的错觉。 |

---

## §3 明确不建议做（红线圈）

1. **不换撮合引擎。** 读码确认 RECON:403 的判断成立：现有撮合已是第一梯队（T+1 `rejectReasonOf:78-93`、涨跌停分档 `limitsOf:63-69`、三项费用 `feesOf:48-54`、整手、跨日失效、停牌）。缺口就是量能/滑点/部分成交三件，**全是纯函数级改动**。
2. **不新增任何数据源。** 卡 1 需要的 volume 已在 `:477/:495` 的响应里；卡 7 需要的基准已在 `rescue.ts:140`/`globalFlow.ts:155`。**唯一要写的代码是"别把字段丢掉"。**
3. **不照抄 `forwardOf` 的样本构造。** 抄它的**纪律**（基准/持有期/样本量/不许说成预测能力），**不抄它的重叠窗口**。理由见卡 8。
4. **不为了"看起来严谨"上哈希链。** 卡 4+卡 5 的性价比高一个数量级；哈希链的真正成本不在实现，在**以后每次加字段都要维护兼容**。
5. **不在界面写"策略有效"。** `signalForward.ts:12` 的 `disclaimer` 已经把话说到位了，棱镜的评估也应沿用同一口径 —— **只能说"过去发生了什么"**。

---

## §4 未确认项

1. **`deps.bars` 在真实 profile 下的请求次数**：卡 1 声称"不新增请求"，依据是 `matchTick` 里 bar 已在订单循环内调用且有 30s 缓存（`prismAccount.ts:449`、`:705`）。**未实跑确认**每 tick 的真实上游请求数（每个 pending 单一次 `deps.quotes` + 一次 `deps.bars`，`N` 张单即 `2N` 次）。
2. **新浪 `volume` 单位"股"是否对所有标的成立**（ETF/科创板）：依据是 `em.ts:1685` 的注释与 `:1697-1699` 的真机实测记录，但那条实测是"A股/ETF"，**未覆盖科创板/北交所**。
3. **腾讯 m1 的 `r[5]` 是否恒为 volume**：`prismAccount.ts:495` 用 `r[3]/r[4]` 取 high/low，我据此推断 `r[5]` 是 volume（腾讯 `mkline` 通行格式 `[时间,开,收,高,低,量,额]`），**本机未核对该接口的字段顺序**。落地前应像 `em.ts` 那样做一次真机标定并写进注释。
4. **参与率参数（10%/25%）的合理区间**：未做任何标定。qlib 的 `impact_cost=0.1` 也是"注释推荐值"（RECON:163），不是 A 股实证。
5. **`capitalLimit` 的变更频率**：卡 5 的对账起点设计依赖它。HEAD 提交 `v0.148.0` 刚加了"复制持仓自动提额"，**未确认它还会在哪些路径被改**。
6. **`unrealized` 字段的实际消费方**：`prismAccount.ts:243` 用的是 `equity - capitalLimit`。**未逐一核对 UI/接口里有没有把它当"浮动盈亏"展示**——若有，是个既有的语义 bug，值得单独开一条。
7. **`forwardOf` 的 `n` 在护盘场景下的重叠程度**：未量化。若护盘事件本身稀疏（近 30 日里等级≥1 的日子），重叠可能不严重 —— 但**这不改变"不能照搬到策略评估"的结论**。
8. **本报告未运行任何代码**：所有"会产生什么后果"都是读码推断。落地前建议按仓库既有习惯先写可注入反例的断言（`uiuxDiscipline.test.ts` 风格），再改实现。

---

## §5 一页备忘：如果只有一天时间

| 做 | 不做 |
|---|---|
| 卡 1（`MinuteBar` 加 `vol`，两处 map 不再丢字段，`matchOrder` 按参与率裁剪） | 哈希链 |
| 卡 4（`PrismRun` 加 `code_version` 常量 + `mandate_hash`，复用 `filesChecksum`） | 部分成交的 UI 完整化 |
| 卡 8 的**抽样规则**（非重叠 + `horizon+1`，写死常量） | 任何新数据源 |
| 卡 7 的**一个**指标（含费/不含费双报的超额），其余留空 | 用伪样本算胜率 |

理由：这四件加起来能让「一轮 500 万的单能不能吃到」和「这个数字能不能信」两个问题各自有一个诚实答案；而哈希链与部分成交的完整形态，都可以在有了可信数字之后再加。
