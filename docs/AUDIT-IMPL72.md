> **历史快照**：本文记录的是当时（见下方正文）的用例数 / 探针读数 / 注入结果，**不代表现状**；现状以 `README.md` 与代码为准。

# AUDIT-IMPL72 —— REVIEW-7-HOST 的 D1–D5（实现报告）

- 基线：`main` @ `8b06d5d`（v0.104.0，`npm run check` **775 用例/时区 × 2** + 构建 73 项）。
- 依据：`docs/REVIEW-7-HOST.md`（475 行，含全部探针与「注入后仍全绿」的证明）。
- 本批用例：**775 → 800**（本批新增 `src/host/fix7Host.test.ts` **9 例**；其余 +16 来自并行的客户端批次 `AUDIT-IMPL71`）。
- 纪律：未 commit；未装、未动 profile、**未重启 `dsh web`**；新依赖 0；实验全部 `/tmp`
  （`DSH_HOME=/tmp/fx7-*`）；**`build.mjs` 零改动**；未手工写 `~/.dsh`。
- **未碰 `src/client/**`**（另一位队友在同一批改 `PortfolioPage/quoteState/TopBar/...`）。

---

## 0. 一行结论

五项全部修完，并且每项都换成了**能抓到旧行为的断言**：把实现逐项改回旧写法后，
`fix7Host.test.ts` 里对应的那一条**立即变红**（§6 的注入表）；未注入时 800 条全绿 × 2 时区 + 构建 73 项。

---

## 1. D1【P0】量纲护栏：前提恒真 + 20–100× 无条件 ÷100

### 1.1 两个独立缺陷

| # | 位置 | 缺陷 |
|---|---|---|
| ① | `routes.ts:414-418`（旧 `:402-407`） | `unitRef.date` 取自**日线自己最后一根** ⇒ `alignVolUnitWithQuote` 的 `findIndex(b => b.date === ref.date)` **必然命中** ⇒「必须同一天」这条前提退化成恒真式。报价的成交量属于哪一天，代码从未检查（`QuoteRow.time` 一直是有的）。 |
| ② | `klineUnits.ts:215-250`（旧 `:208-229`） | 只要 `ratio ∉ [1/20, 20]` 就**无条件** ×/÷100。实测 60× 也照乘 ⇒ 归一到手之后变成 0.6×，离「手」更远，而 `reason` 文本自己写着「相差 60.0×」。 |

### 1.2 修法

**① 参照日来自报价自己的交易日**（`src/host/routes.ts:414-418`）：

```ts
const quoteDay = typeof quote?.time === 'number' && Number.isFinite(quote.time) && quote.time > 0
  ? dayOf(quote.time)          // ← 报价那一刻属于哪个日历日（A股/港股都是北京日）
  : null
const unitRef = quote !== null && lastFq1 !== null && quoteDay !== null && … 
  ? { date: quoteDay, vol: quote.vol }   // ← 不再用 lastFq1.date
  : null
```

报价没有时刻（`time` 缺失）⇒ `unitRef = null` ⇒ **不做量纲判定**。判不了就不改数。

**② 只有真的 ≈100 倍才动手**（`src/host/klineUnits.ts:215-250`）：

```ts
const exponent = Math.log10(ratio)
const asShares     = Math.abs(exponent - 2) <= tolerance   // ratio ≈ 100  ⇒ ÷100
const asBelowHands = Math.abs(exponent + 2) <= tolerance   // ratio ≈ 0.01 ⇒ ×100
if (!asShares && !asBelowHands) return { bars, fixed: false, reason: '…判不了，未改动…' }
```

`tolerance` 默认 `0.1`（⇒ ratio ∈ [79.4, 125.9] 才算股/手之差），可注入。
这与 `findVolUnitBreak` 的「30–300 之外不动」纪律对齐：**判不了就报数，不猜量纲**。

### 1.3 断言（`fix7Host.test.ts` 的 D1-a / D1-b）

- **D1-a**：60× ⇒ `fixed:false` + `reason` 含「判不了」「未改动」+ 量**未被改**；100× 与 90× ⇒ 归一；
  79× / 126× ⇒ 不动；≈1× ⇒ `reason === null`（既有行为不退化）；≈0.01× ⇒ ×100。
- **D1-b**：**端到端**——盘缓存最后一根是 `2026-10-15`、报价时刻是 `2026-10-16 10:00`，
  整段放大 100×（段内一致 ⇒ 段内归一查不出）。断言 `/chips` 跑完后盘上最后一根仍是 `4 653 193`、
  `unitNote` 不含「归一到「手」」、`missing` 里没有量纲条目 ⇒ **闸门一次都没触发**。
  同时用旧写法 `{date: lastFq1.date}` 在同一份数据上做**反例**：必须 `fixed:true` 且把
  `4 653 193 → 46 531.93`（小 100 倍）——这正是被修掉的行为。

> 注意 D1-b 还额外守了一条**不许把闸门焊死**的边界：同一天参照时必须仍然生效（否则等于关掉这道闸门）。

---

## 2. D2【P0，一行】美股日线把缺失/空串/0 写成 0

### 2.1 修法（`src/host/sina.ts:337, 375-379`）

```ts
export interface SinaBar { …; vol: number | null }   // ← 放宽（旧：number ⇒ null 语义无法表达）
…
vol: ((): number | null => {                          // ← 旧：num(it.v) ?? 0（Number('') === 0）
  const v = numField(it.v)
  return v !== null && v > 0 ? v : null
})(),
```

两条都要挡：`numField` 管空串，`> 0` 管上游给的 `"0"`。`DayBar.vol` 本来就允许 null，
`aggregateUsDaily` 的「任一日缺失 ⇒ 该根 vol 记 null」契约**终于能从源头生效**。

### 2.2 断言（D2）——全仓第一次覆盖 `parseSinaUsDaily`

构造 4 行：`v:""` / `v:"0"` / 缺 `v` 字段 / 正常值 ⇒ 分别 `null / null / null / 12345`；
`amount` 同样不 0；再把这 4 根喂进 `aggregateUsDaily(week)`：一周里有一天缺量 ⇒ **该周 `vol` 必须是 `null`**。
反例给出旧算式 `Number('') === 0` 与旧聚合结果。

---

## 3. D3【P1】宏观红线断言太弱：`marketExtras` 是第二扇门

### 3.1 事实（评审探针 6C，本批复核一致）

`marketExtras.ts` 里有 5 个**真宏观**取数点全部裸 `fetch`，而 `globalFlow.ts` 对**同一主机、同一 symbol、
几乎同一 path** 走的是 `gatedFetch`：`DINIW`、`globalbd_us10yt`、`100.UDI`、`171.US10Y` 现货、
`171.US10Y` 日K历史。守卫它的断言只扫「谁 import 了 robotsGate」⇒ 恒绿。

### 3.2 修法（择「结构性扫描」+「登记豁免」两者并行，理由写在 `docs/DECISIONS.md`）

1. `marketExtras.ts` 新增两个门禁原语（`:46-72`）：
   - `gatedJson(url)`（宏观 JSON，如 `100.UDI` / `171.US10Y` 现货与历史）；
   - `gatedSinaBody(symbol)`（新浪宏观 `DINIW` / `globalbd_us10yt`，直连 `hq.sinajs.cn` 但走 `gatedFetch`）。
   两者各带模块级 `HostBudget`（`const macroBudget`），被 robots/预算拦下时**零请求**，
   并把 `{what,why,note}` 原样写进该函数的 `missing[]`。
2. 五条宏观取数点全部改经它们；`sinaRaw`（唯一用途就是那两条）**删除**（改后零引用 = 死代码）。
3. **两融 + 涨停池明确划出宏观圈**，登记为显式豁免（`push2ex.eastmoney.com` / `www.szse.cn` /
   `datacenter-web.eastmoney.com`）：它们是 A股**市场交易统计**（与 `/breadth` 同族），不是宏观经济数据；
   且 `/market-extras` 每次打开大盘页都调用，套「≤5 次/小时」会当场打空（涨停池只有这一个源）。
   **豁免 ≠ 不过熔断**：三台仍必须经 `withHostBreaker`。

### 3.3 断言升级（两步，缺一不可）

| 断言 | 位置 | 强度 |
|---|---|---|
| **取数点级结构扫描** | `fix7Host.test.ts` D3 | 宏观块（`usdIndexCross` → `us10yHistory`）里**不许出现任何裸 `fetch(`**；`push2delay`/`push2his` 必须出现在 `gatedJson(` 的实参里；`gatedSinaBody` 自身必须直连 `hq.sinajs.cn` **且**走 `gatedFetch`；两个新浪 symbol 必须以 `gatedSinaBody('…')` 形式出现 |
| **豁免清单双向判据** | 同上 | 豁免的三台**不得**出现在门禁调用里（不该占宏观预算）、**必须**仍在（不是删功能）、豁免清单**不得**含任何宏观主机 |
| **接线面** | `usQuote.test.ts` ⑨（已改） | `robotsGate` 的 import 面**恰好**是 `['host/globalFlow.ts', 'host/marketExtras.ts']`；三个方向都能红：报价链接入 / 接入面变空 / **只留 globalFlow**（后者正是「第二扇门」复发的形态） |

---

## 4. D4【P1】`marketExtras.ts` 两处 0 顶替

### 4.1 (a) `numOf` 空串 ⇒ 0（`:247-257`）

```ts
const text = v.replace(/,/g, '').trim()
if (text === '') return null          // ← 旧：Number('') === 0
```
与同仓库 `sina.ts` 的 `numField` 同一口径（那里早就踩过同一个坑）。

### 4.2 (b) `us10yHistory` 的 `numOf(v) ?? 0`（`:448-478`）

改为**丢掉缺值行 + 如实计数**：
- `unvalued > 0` ⇒ `missing[]` 里一条「上游给了 N 行，其中 M 行没有收益率数值（空串或「—」）⇒ 这些日整条不画（不用 0 顶替）」；
- `undated > 0` ⇒ 另一条（缺日期无法定位交易日）。

### 4.3 断言（D4-a / D4-b）

- **D4-a**：`marginCross` 在两源都回空串时，`szse`/`em` 的四个字段**全部 `null`**，且显式断言「`cross.em.marginBalance` 不是 0」；
  随后用正常值（含千分位 `'19,234.5'`、元→亿元换算）确认**没有为了修 0 顶替把正常路径弄坏**。
  反例给出旧算式 `Number('') === 0`。
- **D4-b**：`klines = ['2026-10-15,4.121','2026-10-16,','2026-10-17,—']` ⇒ 只留 1 点、值不含 0、`missing` 有原因；
  反例给出旧结果 `[4.121, 0, 0]`，并断言「无 0 顶替」判据必须拒绝它。

---

## 5. D5【P1】文件锁回收**活着的**持有者

### 5.1 修法（`src/host/lock.ts:225-250`）

```ts
export const HEARTBEAT_HUNG_FACTOR = 3
…
if (snap.pidAlive === true && !hungBeyond) return null   // ← 否决回收（旧：只看 ageMs）
```

- `pidAlive === true` 且心跳断供 **≤ 3 × staleMs** ⇒ **不回收**（继续等，`wait` 事件里带 `holderAlive`/`ageMs`，
  所以「为什么不回收」可见）；
- 超过 3 × staleMs ⇒ 判为**挂死**并回收，`reason` 明写「仍在运行，但心跳断供已超过 3×staleMs ⇒ 判为挂死」；
- `pidAlive === false`（进程真没了）⇒ 仍按原宽限回收；`pidAlive === null`（内容不可解析）⇒ 仍按 mtime 回收。

**为什么取 3 倍**：心跳间隔是 `max(200, staleMs/3)`。若只要求「略大于 staleMs」，一次长 GC / 一次磁盘抖动
就会把「卡住的写者」误判成「死了的写者」——而**卡住的进程随时可能继续写**，抢锁只会让两个写者同时进临界区
（`releaseLock` 的 token 校验只防误删，不防丢更新）。

### 5.2 断言（D5）

`staleReason` 的 8 格真值表：`(ageMs, pidAlive)` 组合逐格钉住，包含
「活着 + 10.006 s ⇒ false」「活着 + 2×staleMs ⇒ false」「活着 + 3×staleMs+6 s ⇒ true」
「进程不存在 ⇒ true」「未过宽限 ⇒ false」「不可解析 ⇒ true」。
反例给出旧判据 `ageMs > staleMs`，并显式断言**新旧判据在关键那一格上必须相反**；
另加 `HEARTBEAT_HUNG_FACTOR >= 3`（改小等于把 D5 修回去）。

---

## 6. 反例注入读数：改前全绿 / 改后必红

方法：把当前工作树完整复制到 `/tmp/fx7-base`（`node_modules` 只读软链，`DSH_HOME=/tmp/fx7-home-*`），
**逐项只把该条的实现改回旧写法**，再跑 `src/host/fix7Host.test.ts`。

| 注入 | 改回什么 | 结果 |
|---|---|---|
| （对照）未注入 | — | **9/9 绿** |
| **D1-②** | 删掉 `≈100×` 判据（任何 `ratio>20` 都 ÷100） | **红**：`D1-a`（其余 8 绿） |
| **D1-①** | `date: quoteDay` → `date: lastFq1.date` | **红**：`D1-b`（其余 8 绿） |
| **D2** | `vol: (numField…>0?…:null)` → `vol: num(it.v) ?? 0` | **红**：`D2`（其余 8 绿） |
| **D3** | 把 `us10yHistory` 的 `gatedJson(` 改成裸 `fetch(` | **红**：`D3` —— 消息「宏观块里只许走 gatedFetch，不许有裸 fetch」（其余 8 绿） |
| **D4-a** | `numOf` 改回 `Number(v.replace(/,/g,''))` | **红**：`D4-a`，并连带 `D4-b`（两者共用 `numOf`，属预期） |
| **D4-b** | `us10yHistory` 改回 `numOf(v) ?? 0` | **红**：`D4-b`（其余 8 绿） |
| **D5** | 删掉 `if (snap.pidAlive === true && !hungBeyond) return null` | **红**：`D5`（其余 8 绿） |
| 复原后复查 | — | **9/9 绿** |

> 「改前全绿」的对照由评审本人给出（`REVIEW-7-HOST.md` §四：I1–I4 逐字注入后 775 条仍全绿，对照注入能红）；
> 本表补上的是相反的半边：**现在把实现改回去，新断言立刻红**。

---

## 7. 改动清单（`文件:行号`）

| 文件 | 内容 |
|---|---|
| `src/host/routes.ts:414-418` | D1① 参照日改取**报价自己的交易日**（`dayOf(quote.time)`），不一致即不做量纲判定 |
| `src/host/klineUnits.ts:215-250` | D1② 判据收紧为「`|log10(ratio/100)| ≤ 0.1`」，否则 `fixed:false` + 「判不了，未改动」；新增 `opts.tolerance` |
| `src/host/sina.ts:337, 375-379` | D2 `SinaBar.vol` 放宽为 `number \| null`；解析改 `numField` + `> 0` |
| `src/host/marketExtras.ts:32-72` | D3 新增 `macroBudget` / `gatedJson` / `gatedSinaBody` / `__resetMacroBudget`；删除死代码 `sinaRaw` |
| `src/host/marketExtras.ts`（`usdIndexCross` / `us10yCross` / `us10yHistory`） | D3 五条宏观取数点改经门禁，被拦时写 `missing[]` |
| `src/host/marketExtras.ts:247-257, 448-478` | D4 `numOf` 空串 ⇒ null；`us10yHistory` 丢缺值点 + 计数进 `missing[]` |
| `src/host/lock.ts:225-250` | D5 `HEARTBEAT_HUNG_FACTOR = 3`；`pidAlive === true` 时限内**否决回收** |
| `src/host/robotsGate.ts:140-143` | 新增 `HostBudget.clear()`（测试钩子用；`__resetMacroBudget` 依赖它） |
| `src/host/usQuote.test.ts:247-275` | robotsGate 接入面断言更新为**恰好两份**，并加第三个反例（只留 globalFlow ⇒ 红） |
| `src/host/fix7Host.test.ts`（新，368 行） | D1–D5 的 9 例断言（含逐项反例注入） |
| `docs/DECISIONS.md` | 新增决策：「宏观门禁的第二扇门补上 + 两融/涨停池明确划出宏观圈」 |

**`build.mjs` 零改动。**

---

## 8. 未做项 / 边界

1. **D3 的预算记账是"每模块一份"**：`marketExtras` 的 `macroBudget` 与 `globalFlow` 的 `HostBudget` 各自计数，
   因此 `hq.sinajs.cn` 的实际上限是「两处各 ≤5 次/小时」。本批**不合并**（合并会把 globalFlow 的持久化账本口径改掉，
   属另一个决策）；已在 DECISIONS 里写明。
2. **D5 没上 fencing token**：评审给的另一条路（写回前再校验 token、不匹配则拒写）改动面更大
   （每个写回点都要带 token 并处理"锁已易主"），本批取"否决回收 + 3× 挂死判定"，代价是
   **真挂死的进程会让后来者多等 3×staleMs（默认 30 s）**。已写进注释。
3. **`pidAlive === true` 但 pid 被复用**：无法区分「原持有者」与「复用了同一 pid 的新进程」，
   3× 挂死判定是当前的折中（届时仍会回收，最坏多等 30 s，不会永久死锁）。
4. **D1 的 `quoteDay` 只按北京日历日**：筹码链只在 `fqSupported` 的市场跑（A股/港股/指数），
   这三类都用北京日；美股在 v0.103 已 `fqSupported=false`，不进入本链路。
5. **评审列的 D6–D12 未做**（不在本批 D1–D5 范围内）：`suggest` 无界缓存、`resampleYearly` 0 求和、
   `chips.lastBar.vol ?? 0`、美股聚合落盘放大、`quoteSlots` 非 LRU、`fetchSinaQuotes` 死代码、`chips` 桶数注释。
   其中 **D7（`resampleYearly`）与 D8（`chips.lastBar`）与 D2 是同一条红线**，建议下一批优先。
