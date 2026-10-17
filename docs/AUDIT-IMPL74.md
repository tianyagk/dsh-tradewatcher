> **历史快照**：本文记录的是当时（见下方正文）的用例数 / 探针读数 / 注入结果，**不代表现状**；现状以 `README.md` 与代码为准。

# AUDIT-IMPL74 —— 队列第 1 项：A股年K 的量/日期/同比 + `chips.lastBar` 的 0 顶替（实现报告）

- 基线：`main` @ `5734052`（v0.106.0，`npm run check` **812 用例/时区 × 2** + 构建 73 项）。
- 依据：`docs/REVIEW-7-HOST.md` D7 / D8（探针 `/tmp/rv-host/work/probe-units.ts` P5、`probe-chips`）。
- 本批用例：**812 → 840**（本批新增 `src/host/impl74.test.ts` **8 例**；其余增量来自并行批次）。
  两轮 `npm run check` 均绿：840 × 2 时区 + selftest + 构建 73 项。
- 纪律：未 commit；未装、未动 profile、**未重启 `dsh web`**；新依赖 0；实验全部 `/tmp`（`DSH_HOME=/tmp/q1-*`）；
  **`build.mjs` 零改动**；未手工写 `~/.dsh`。

---

## 0. 一行结论

两项都修了，并且都把「旧行为」做成了**判据的一部分**：在 `/tmp/q1-base`（当前树副本）里逐项把实现改回旧写法，
`impl74.test.ts` 里对应的那条**立刻变红**（§3 注入表）；未注入时 8/8 绿。

---

## 1. ① A股年K：缺月量按 0 求和 + `date` 变月末 + 首根 `pct` 冒充同比

### 1.1 三个口径问题（同在 `resampleYearly`）

| # | 旧实现 | 后果 |
|---|---|---|
| a | `cur.vol = (cur.vol ?? 0) + (b.vol ?? 0)` | 某个月的 `vol` 是 `null` ⇒ 当成 **0** 相加 ⇒ 年K 给出**一个看起来完全正常的数字**（探针实测：缺一个月仍给 400，真值应为 `null`）。这是全仓红线「缺数据不得 0 顶替」在最新模块里的破口。 |
| b | `cur.date = b.date`（每月都覆盖） | 年K 的 `date` 变成**年末月**的月末日期。不只是标签难看：`fetchKline` 的 `barOpen` 用 `lastDate === today` 判"这根还在走"，年末月的日期永远不等于今天 ⇒ **本年那根年K 永远被当成已收盘**。 |
| c | `const base = prevClose ?? bar.open` | 首根拿**年内开盘价**当基数 ⇒ 那是"年内涨幅"，却挂在"年K 涨跌幅（同比）"这个位置上，且**从未披露**。 |

### 1.2 修法（`src/host/em.ts:2345-2425`）

与美股 `aggregateUsDaily`（`usAggregate.ts`）**刻意同形**——同一个语义在两个市场不该有两种写法：

1. **量/额 null 传播**：`volSum` / `volMissing`（`amountSum` / `amountMissing` / `amountSeen`）分开记，
   结果 `cur.vol = volMissing ? null : volSum`。`undefined`（老缓存没有这一列）不算缺失；
   `null`/`NaN` 算缺失。
2. **`date` 只在"进入新年"时定一次**，后面不再覆盖 ⇒ 年K 的 `date` = **年内首个月K的日期**。
   > 为什么不是字面意义的"年内首个交易日"：上游月K 的 `date` 本身就是**月末交易日**
   > （实测 `1.601398_103_1.json`：`2024-01-31 / 2024-02-29 / …`），输入粒度决定了拿不到"1 月第一个交易日"。
   > "取桶内**第一根输入**"这个语义与 `aggregateUsDaily` 完全一致，差异只来自输入粒度（月 vs 日）。
3. **首根 `pct = null`**：`bar.pct` 只在 `prevClose !== null && prevClose > 0` 时算同比；首根没有上一年收盘 ⇒ 留空。

### 1.3 配套：`barOpen` 与 `pctNote`（`src/host/em.ts:2650-2672`）

- `barOpen` 新增 **A股年K 分支**：`baseKlt === 103 && klt === 104` ⇒ 比**年份**而不是比日期
  （美股那半边原本就有 `usBucketOf` 按周期比，所以 US 年K 不受影响）。
- 新增 `KlineData.pctNote`（`src/shared/model.ts:372`）：年K 一律回带一句口径
  「年K 涨跌幅 = 相对上一年收盘（同比）；首根没有上一年数据 ⇒ 留空，不用年内开盘价冒充」。
  客户端把它并进**口径行**（`src/client/QuoteDrawer.tsx:545,551`）——不然那个 `null` 会被读成"那一年平盘"。

---

## 2. ② `chips.lastBar.vol ?? 0`：缺失被编码成 0

### 2.1 修法（`src/host/chips.ts:477-495, 543`）

新增纯函数 `lastBarMetaOf(bar, date)`，把「真 0」与「缺失」分开表达：

| 情形 | 旧 | 新 |
|---|---|---|
| 上游没给 | `vol: 0`（与真 0 无法区分） | `vol: null` + `volReason: '上游这一根没有给出成交量（缺失，不是 0）⇒ 按「未取到」处理'` |
| 上游真的给 0（实测港股有 3 根） | `vol: 0` | `vol: 0` + `zeroVolume: true` + `volReason: null` |
| 正常值 | 原样 | 原样 |

`ChipSeries['lastBar']` 的类型同步改成 `vol: number | null` + `volReason` + `zeroVolume`。

同时把 `em.lastBarOfKline`（`src/host/em.ts:2040-2070`）的返回形状对齐：它以前声明 `vol: number`
而 `DayBar.vol` 是 `number | null` —— 因为 `tsconfig` 是 `strict: false`（`strictNullChecks` 关），
这条谎话一直没有被编译器抓到；实际后果是回包里"缺失"会被读成"零成交"。

> 注：`/tradewatcher/chips` 的路由先写 `lastBar: em.lastBarOfKline(...)`，随后 `...series` 把它覆盖成
> `chipSeriesOf` 产出的那份（两者现在同源同形）。已在路由处加注释说明优先级，避免下一个人以为是两个来源。

---

## 3. 反例注入读数：改前全绿 / 改后必红

方法：把当前工作树完整复制到 `/tmp/q1-base`（`node_modules` 只读软链，`DSH_HOME=/tmp/q1-home-*`），
**逐项只把该条的实现改回旧写法**，再跑 `src/host/impl74.test.ts`。

| 注入 | 改回什么 | 结果 |
|---|---|---|
| （对照）未注入 | — | **8/8 绿** |
| **I1** | `cur.vol = volSum`（缺失当 0 相加） | **红**：① + ②b（②b 顺带断言"本年那根缺量 ⇒ vol null"） |
| **I2** | `cur.date = b.date`（覆盖回月末） | **红**：②（仅此一条） |
| **I3** | 年K `barOpen` 改回按**日期**比 | **红**：②b（仅此一条） |
| **I4** | `const base = prevClose ?? bar.open` | **红**：③ + ③b（口径句与首根 null 一并失守） |
| **I5** | `chips` 改回 `vol ?? 0` | **红**：④ + ④b（缺失与真 0 重新合并） |
| 复原后复查 | — | **8/8 绿** |

「改前全绿」那半边由评审给出（`REVIEW-7-HOST.md` §四 I4：把 `resampleYearly` 改成 null 传播后 775 条仍全绿）；
本表补的是相反半边：**现在改回去，新断言立刻红**。

### 3.1 断言清单（`src/host/impl74.test.ts`，8 例）

| # | 判据 |
|---|---|
| ① | 三个月里缺一个 ⇒ 年K `vol === null`；三个月都齐 ⇒ 求和（10+20+30=60）；输出里不许出现 0 量。**反例**：旧写法给 400（一个"看起来正常"的数字），判据必须拒绝"用数字表示缺失"。 |
| ①b | 成交额同样的 null 传播；**完全没有 `amount` 列**（A股月K 的真实形态）⇒ 不许凭空造 0。 |
| ② | `date` = 桶内**第一根输入**的日期（不是年末月）。判据写成"等于该年第一根输入"而不是硬编码字符串 ⇒ 换一份数据仍成立。 |
| ②b | **端到端** `fetchKline(secid, 104)`：盘中（北京 2026-10-16 10:30）本年那根年K `barOpen === true`；本年有一个月缺量 ⇒ 该年 `vol === null`；2025 年量齐 ⇒ 有值。**反例**：旧口径 `date === 今天` 在同一份数据上必然为 false。 |
| ③ | 首根 `pct === null`；第二根是**同比**（20→40 ⇒ +100%）。**反例**：旧写法给出年内涨幅。 |
| ③b | 年K 必须回带 `pctNote`（含「同比」「首根」）；日K **不许**带（不给非年K 加噪音）。 |
| ④ | `lastBarMetaOf`：缺失 ⇒ `vol:null` + 原因 + `zeroVolume:false`；真 0 ⇒ `vol:0` + 无缺失原因 + `zeroVolume:true`；正常值原样。**反例**：`v ?? 0` 让两种情形变成同一个值。 |
| ④b | 端到端 `chipSeriesOf`：最后一根缺量 ⇒ `lastBar.vol === null`；最后一根真 0 ⇒ `lastBar.vol === 0` 且两者**不相等**（证明不是两套口径）。 |

---

## 4. 改动清单（`文件:行号`）

| 文件 | 内容 |
|---|---|
| `src/host/em.ts:2345-2425` | `resampleYearly`：量/额 null 传播、`date` 只定一次（年内首个月K）、首根 `pct = null` |
| `src/host/em.ts:2650-2672` | `fetchKline`：`barOpen` 新增 A股年K 按年份比；新增 `pctNote` 回包 |
| `src/host/em.ts:2040-2070` | `lastBarOfKline`：返回形状补 `vol: number \| null` + `volReason` + `zeroVolume` |
| `src/shared/model.ts:372` | `KlineData.pctNote?: string` |
| `src/client/QuoteDrawer.tsx:545,551` | 口径行显示 `pctNote` |
| `src/host/chips.ts:477-495, 543` | 新增 `lastBarMetaOf`；`ChipSeries['lastBar']` 类型与取值改 null 语义 + `zeroVolume` |
| `src/host/routes.ts:452` | 注释说明 `lastBar` 的覆盖优先级（行为不变） |
| `src/host/impl74.test.ts`（新，228 行） | §3.1 的 8 例 |
| `src/host/selftest.ts`（年K 段） | 期望值同步到新契约（`date` = 年内首个月K），并**加强**两条：首根 `pct === null`、缺月量 ⇒ 该年 `vol === null` |

**`build.mjs` 零改动。**

---

## 5. 未做项 / 边界

1. **`date` = "年内首个月K" 而非"年内首个交易日"**：上游月K 的 `date` 就是月末交易日，输入粒度决定拿不到
   "1 月第一个交易日"。语义与美股 `aggregateUsDaily`（取桶内第一根输入）一致，差异只来自粒度。
   若以后要精确到"首个交易日"，得让 `fetchKline` 顺手读一次日线缓存（外加一次 I/O），本批没做。
2. **`lastBar.partial` 仍然是恒 `false`**：`chipSeriesOf` 里写死 `partial: false`，而路由里那份
   `lastBarOfKline` 的 `partial` 被 `...series` 覆盖掉。这是**既有**问题（不是本批引入），
   且当前没有任何界面读这个字段（`grep` 全仓：`lastBar.partial` 零消费），所以本批**只加注释、不改行为**。
   真要修，正确做法是把 `partial` 作为 `chipSeriesOf` 的入参从 `lastBarOfKline` 传进去。
3. **`resampleYearly` 的 `open` 仍是"首月开盘价"**：与 `aggregateUsDaily` 的"首日开盘价"在粒度上同样有差，
   但月K 的 `open` 本来就是该月第一个交易日的开盘，年K 用它没有引入额外误差 —— 记录在案，不改。
4. **评审列的 D6 / D9–D12 未做**（不在本批范围）：`suggest` 无界缓存、美股聚合落盘放大、`quoteSlots` 非 LRU、
   `fetchSinaQuotes` 死代码、`chips` 桶数注释。
