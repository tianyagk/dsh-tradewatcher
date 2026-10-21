# AUDIT-IMPL89：采纳落地（载荷闸门 / 出处 lint / 缓存上限 / 曲线上限 / 文档漂移）

> **编号说明**：任务指定的 `docs/AUDIT-IMPL82.md` **已被占用**（复盘页那一轮），按"顺延并注明"办 ⇒ 本文件为 **IMPL89**（现存最大编号 88）。
> 上游设计：`docs/DESIGN-ADOPT-WORKBENCHES.md`（采纳矩阵）；侦察输入：`docs/RECON-WORKBENCHES.md`。
> 用户裁决：**先做 R1 + R3 + R4 + R5，再修两处文档漂移；R2（底部概率区间独立性声明）之后再说（需先测量）**。
> 本轮**不新增依赖**、**不改 `build.mjs`**、**不 commit / 不装 / 不动 profile / 不重启 `dsh web`**。
> 所有实验都在 `DSH_HOME=/tmp/r135-*` 下跑；`~/.dsh` **只读**（未写入任何文件）。

## 0. 结论

**五项全部落地，`npm run check` 全绿**：

| 关口 | 结果 |
| --- | --- |
| `typecheck`（tsc --noEmit） | 通过（0 error） |
| `test`（两轮时区） | **1046 / 1046 × 2**，0 fail（基线 1007 ⇒ **新增 39 条**） |
| `selftest` | `ALL HOST CHECKS PASSED`（实时探针为 soft，本轮东财部分不可达属既有现象） |
| `build` | `built lib/index.js + lib/client.js （v0.120.0，客户端片段校验通过：**73 项**）` |

新增测试分布：`payloadGate` 20 · `chartCache` +4 · `toolRegistry` +5 · `apiProvenance` 4 · `readmeCounts` 6 = **39**。

**意外收获（本轮唯一的真实缺口）**：闸门在**真实快照载荷**上第一次跑就抓到 2 行 —— 资金蛋糕的市场表里 A股/港股
**有规模、没有份额、也没有原因**（读者只能看到 `—`）。已按红线 1 修（`rowReasonOf` 增加第三类原因）。详见 §1.4。

---

## 1. R1 载荷闸门（`src/shared/payloadGate.ts`）

### 1.1 它是什么

**纯函数**（不 import React / 不碰 IO / 不读环境变量），对"用户能看到的读数"跑三类检查：

| 类 | 判据 | 为什么要有 |
| --- | --- | --- |
| `source` | **有值 ⇒ 必须有出处声明**；**没值 ⇒ 必须有原因** | 「—」本身不是信息；有值说不出源 = 无法追溯 |
| `date` | 必须能回答"这是几点的数据"；答不出 ⇒ 必须有整块缺失的 `why` | 与 `lagAlertOf` 同一条诚实性 |
| `caliber` | 载荷声明的不变量必须成立（合计==100、序列长度==日期数…）；**算不出来也必须给原因** | "判不了"不等于"没问题" |

不变量用**数据**（`actual` / `expected` / `tolerance` / `why`）而不是闭包：这样每条都能被单独注入、单独报出
（`实际 97 ≠ 期望 100（容差 ±0.5）`），而不是只有"整体不通过"。

### 1.2 出处覆盖面必须显式声明（`sourceScope`）

本仓库有一条用户口径：**工具详情页不写口径行**（`docs/AUDIT-LEVERAGE-HOST.md` §7.1；杠杆温度计页面上唯一的说明文字
原本只有一行日期小字，而该小字在更早一轮也按用户要求删掉了 —— `leverageHeader.test.ts` ①：「日期小字加回即必败」）。
因此"每格读数各自带出处"**不能**是硬规矩，只能由载荷自己声明走哪一档：

- `cell`（资金蛋糕）：每格读数本来就有出处（KPI 磁贴的 `source`、各区口径行 `notes.*`、市场表逐行 `note`）；
- `payload`（杠杆温度计）：整屏只有一条出处载体（`asOf` + 阈值契约）。**走这一档必须写 `sourceScopeWhy`**，
  否则它就是"跳过检查的后门"（测试里断言这句非空，且例外清单条数锁定为 **1**）。

数据时刻的载体同理：`GateInput.asOfText` 允许是"页面渲染的那一句"或"载荷里那条时刻原文"—— 杠杆页不渲染它，
但契约里必须有（`leverageHeader.test.ts` 断言 `asOf` 字段还在）。闸门校验的是**时刻存在**，不是**它被画出来**。

### 1.3 两个适配器（只做"翻成 GateInput"，判据不复制）

| 适配器 | 位置 | 覆盖面 | 不变量 |
| --- | --- | --- | --- |
| `gateInputOfCake(data, payload, step)` | `src/client/tools/globalFlowView.ts` | `cell` | 份额合计 == 100（±0.5，分母只含有值市场）、曲线条数 == 市场数、日期轴长度 == 切片点数、每条序列点数 == 日期数 |
| `gateInputOfLeverage(payload)` | `src/client/tools/leverageView.ts` | `payload` | 卡片 8 张、三条序列（温度/显性融资/净买入）与日期轴等长 |

两个适配器**共用同一份判据**（测试断言客户端里不许出现第二份 `gateProblems` 实现）。

一处刻意设计：曲线被 R5 的规模闸门拦下时会**保留日期轴、清空序列**（那是合法状态），所以"序列条数"这条不变量
在那种情况下 `expected = null` 并给 `why`，而不是报"条数不对"。

### 1.4 闸门在真实载荷上抓到的真实缺口（已修）

真实快照夹具（`fixtures/cake-full.json`）第一次跑出 5 条问题，其中 3 条是**适配器自己的错**（出处取错了字段：
`ToolData.market.note` 不存在，区口径行在 `ToolData.notes.market`），2 条是**真实缺口**：

```
[source] 资金蛋糕 · 市场表 A股 份额：没有值、也没有原因
[source] 资金蛋糕 · 市场表 港股 份额：没有值、也没有原因
```

成因：这两个市场**规模取到了**（`aumUsd` 非空），但当日**偏好分算不出**（`preferenceOf` 需要该市场自己的日线；
快照里样本不足）⇒ 份额 `null`；而 `rowReasonOf` 只覆盖"有原币规模但汇率缺"这一种，于是这一行**没有任何原因**。

修法（`src/client/tools/globalFlowView.ts` 的 `rowReasonOf` 增加第三类原因，`flowBarsAt` / `marketRowsAt` 传入 `share`）：

> `A股 份额未取到：规模 184.49 亿美元 已取到，但当日偏好分算不出（区间分位与 5/20 日动量都要该市场自己的日线，快照里样本不足或缺该市场日线）⇒ 这一行不参与份额分母（不用 0 顶替）`

修完两个夹具都是 **0 问题**（必放断言）。**这是本轮唯一改到用户可见文案的地方**，理由：红线 1「缺数据必须给原因」；
它**不改任何口径与数字**（份额仍为 `null`，分母规则不变）。

### 1.5 明确拒绝的事（写进断言，防下一个人"顺手加上"）

- **不做运行时阻塞**：判据失败只让测试红，不让路由 5xx。我们的失败方向是"少给 + 写清楚"（`partialOutcomeOf`）。
- **不在客户端复制判据**：适配器只做映射（测试扫源码：`gateInputOfCake` / `gateInputOfLeverage` 所在文件里不得出现 `function gateProblems(`）。
- **闸门不碰 React / fs / fetch / `process.env`**（测试扫源码）—— 它必须能在 `node --test` 里直接跑，且同一份输入给同一份结论。

### 1.6 断言清单（双向，20 条）

必拦（注入）：0 顶替（值 `0.00%` + 无出处 + 无原因）· 有值无出处 · 缺值无原因 · `payload` 档没写理由 ·
`asOf` 为空且无 `why` · 不变量 97≠100 · 不变量算不出且无 `why` · 真实载荷上删掉某个 KPI 的 `source` ·
真实载荷上把 `asOf` 抹掉 · 真实载荷上把份额改成合计 97% · 真实载荷上把杠杆序列截短 · 空载荷塞进一个日期（三条序列各报一条）。

必放（真实 fixture，4 份）：`cake-full` · `cake-empty`（整块缺失）· `leverage-full` · `leverage-empty`（契约里的空载荷）。
**没有"必放"这一半，门禁就会退化成"永远报警"**；反过来没有"必拦"，它就会退化成恒真。

---

## 2. R3 出处字段的载荷级 lint（`src/client/apiProvenance.test.ts`）

**判据**：`src/client/api.ts` 里每个**顶层载荷类型**（`*Payload` / `*Dto`）必须同时含 `asOf` 与 `missing`（可带 `?`）。

**白名单 8 条（条数锁定，新增一条必须改数字 ⇒ 改测试就要评审）**：

| 条目 | 类型 | 理由 |
| --- | --- | --- |
| `ChipDayDto` | 行内 | 筹码分布里的一天（属于 `ChipsPayload`） |
| `GlobalFlowMarketDto` | 行内 | 五个市场的一行 |
| `GlobalFlowPointDto` | 行内 | 曲线上的一个序列日 |
| `FupanDateDto` | 行内 | 复盘月历的一天 |
| `FupanNoteDto` | 行内 | 一条复盘笔记 |
| `FupanTradeDto` | 行内 | 当日一笔交易 |
| `FupanTradesPayload` | **载体不同** | 出处是逐字段原因（`dayPnlWhy` / `dayPnlReason` / `readFailedReason`），不是聚合 `missing[]`；`carrier: 'dayPnlReason'` |
| `LeveragePayloadDto` | **契约例外** | 缺数据一律 `null`、页面不写口径；出处在 `payloadGate` 的 `payload` 档声明；`carrier: 'asOf'` |

两条硬化：① 带 `carrier` 的豁免**必须指到真实存在的字段**（否则豁免就是一句空话）；② 豁免清单里的名字必须真的
存在于 `api.ts`（否则是死条目）。

**注入**：往 `api.ts` 文本里塞一个 `GhostDto { value, note }` ⇒ 必报 `GhostDto 缺 asOf + missing`；只带 `asOf` 的
`HalfPayload` ⇒ 必报 `缺 missing`。另有一条"`missing` 的写法只有已知几类"（按粗分桶：数组 / 对象数组 / 可空字符串 / 计数），
拦的是"又发明一种缺失表达"，不是写法细节。

---

## 3. R4 客户端图表缓存上限（`src/client/chartCache.ts`）

### 3.1 先测，再定值（不抄经验值）

**测量方法**（2026-10-21，`~/.dsh/dsh-tradewatcher` 只读；测量脚本在 `/tmp`，未入库）：

1. **每个标的的键数**：由 `keyOf` 的取值空间推出 —— 分时 1 + 五日 1（二者不分复权口径）+ 4 个 K 线周期 × 3 个复权口径 = **14**。
2. **标的数**：本机 `watch.json` 41 个 secid ∪ `positions.json` 9 个 = **45**。
3. **单条回包体积**：把真实缓存文件按**回包形状**（`wireSlim` 的紧凑编码：K 线丢 `pct:null`、分时逐点 `label` 留 `HH:mm`）
   重新序列化后取紧凑 JSON 字节数。

| 载荷 | n | p50 | p95 | max |
| --- | --- | --- | --- | --- |
| K 线（4 个周期 × 3 口径） | 207 | 70 145 B | **88 524 B** | 140 445 B |
| 分时（1 日 / 5 日） | 553 | 14 673 B | 18 565 B | 54 699 B |

**推论**：本机自选 + 持仓**全量浏览**的上界 = 45 × 14 = **630 条**，按 K 线 p95 计约 **48 MB JSON**
（解析成对象后的堆更大）—— 单个浏览器标签放不下 ⇒ **必须有上限，且不能取"永不淘汰"的算法**。

### 3.2 取值与推导（写进常量注释，来源可查）

```ts
export const CHART_CACHE_EVIDENCE = { measuredAt: '2026-10-21', keysPerSecid: 14, universeSecids: 45,
  klineSamples: 207, trendSamples: 553, klineBytesP95: 88_524, trendBytesP95: 18_565 } as const
export const CHART_CACHE_MAX_ENTRIES = 160
```

- **160 × 88 524 B ≈ 13.8 MB**（按 K 线 p95 计；分时更小）—— 这是"能覆盖自选 45 行分时缩略线（45 × 18.6 KB ≈ 0.8 MB）
  之后还剩 115 条给抽屉"的最小够用值（115 ≈ 9 只标的看全 14 个键）。
- 上限的**必要性**由 `CHART_CACHE_EVIDENCE` 的全量上界（630 条 / 48 MB）给出；上限的**大小**是一条**预算**（不是测出来的最大值），
  断言把它钉在 ≤ 16 MB。**"必须小于 16 MB"与"全量上界必须超 16 MB"两条一起断言** ⇒ 判据非恒真：
  若有人把上限改成 630（等于没限）或把预算逻辑改歪，测试都红。

### 3.3 淘汰规则（唯一写入口 `put`）

① 先清**已过期**条目（它们本来就命中不了，占着位置只会把有用条目挤出去；**清过期不计入 `evicted`** —— 两种原因必须能分开）；
② 仍超上限 ⇒ 按 `exp` 最小（= 最旧的数据）淘汰，**绝不淘汰正在写入的那条**；③ `stats()` 增加 `evicted` / `maxEntries`。

**行为不变的部分**（有断言）：失败保留上一份成功值、失败后的保底 TTL（20 s）、同键在飞合并、4 种 TTL 分档、
`clear()` 后回到冷启动 —— 全部原样。新增断言：写满 +5 条 ⇒ `entries == 160`、`evicted == 5`、最早写入的两条被淘汰、
最后写入的仍在；写满 160 条分时后过 31 s 再写 1 条 ⇒ `entries == 1` 且 `evicted == 0`；超限状态下刷新失败 ⇒ 仍返回
`fallback: true` 且该条不被自己挤掉。

---

## 4. R5 曲线序列 / 标记上限（`src/client/toolDetailTheme.ts` + `toolRegistry.ts`）

**上限**：序列 ≤ **6**、标记 ≤ **50**（`CURVE_MAX_SERIES` / `CURVE_MAX_MARKS`）。取这个量级的理由写在常量注释里：
图例一行（`LEGEND_ROW`，`gap: 14`）在 1280px 宽的详情页里大约容 6 个中文序列名；标记超了图会变成"一串珠子"。

**判据在纯模型层**（`curveContractProblems`，只认结构、不 import 注册表 ⇒ 无环）：`detailModel` 得到问题就
**清空序列与标记**并把 `curve.empty` 换成原因。页面**零改动** —— 它的判据本来就是 `series.length > 0 && days.length > 0`，
清空即自然落到"渲染 `curve.empty`"那一支。

**为什么不截断**：少画一条线，读者会读成"那条线没有数据" —— 那是**改数据**，不是收敛。空态文案：

> `未取到：这一屏的曲线超过上限（7 条序列 > 上限 6）⇒ 不绘制 —— 截断会悄悄少画，读者会把缺线读成"没有数据"`

**断言**（5 条）：7 条序列 ⇒ 序列与标记都空 + 空态含"超过上限"+ 真实条数 + 解释"为什么不截断"；51 个标记 ⇒ 同样；
**恰好** 6 条 / 50 个标记 ⇒ 原样放行（边界是 `>` 不是 `>=`）；**反例注入**：模拟"顺手截断到 6 条 + 普通空态"
⇒ 上述两条断言必须失败（证明"清空 vs 截断"可判定）；无数据骨架里不得出现"上限"字样与数字（红线：骨架零阿拉伯数字）。

---

## 5. 两处文档漂移 + 防复发断言

### 5.1 改了什么

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| `README.md:13` | 面板由**六个页签**组成（缺复盘） | **七个页签**：自选 / 持仓 / 大盘 / 云图 / 日历 / 工具箱 / 复盘 |
| `README.md:388` | 拆成**七行**（清单缺 `fupan`） | **八行**（core / calendar / cloudmap / market / watchlist / portfolio / tools / fupan） |
| `README.md:390` | 共七行 + 引用 `cordis.patch.yml:53-75`（行号已漂） | 共八行（补 `-tools` / `-fupan` 与版本）+ 改引用 **`- insert:` 块**，不再写行号 |
| `docs/DESIGN-SUBPLUGINS.md:8` | 「现状（v0.59.0 起）：**六行** bundle 已生效」 | 现状：v0.59.0 六行 / v0.71.0 七行 / v0.111.0 八行，**八行**已生效 |
| `docs/DESIGN-SUBPLUGINS.md:185` | 「我们**六行**的 `name` 都是…」 | 「我们**所有行**的 `name` 都是…」（该论证与行数无关，去掉数字以免再漂） |

设计文档里明确标注为**历史快照**的段落（v0.44 迁移现场、v0.50 回退、v0.59 恢复）**一字未改** —— 历史不改写。

### 5.2 防复发：`src/readmeCounts.test.ts`（6 条）

锁五处**同源事实**：① README 的页签计数 == 它自己列出的页签名；② == 客户端 `tabs` 条数 == `PageKey` 成员数
（并逐个核对名字，`工具`↔`工具箱` 登记为别名）；③ README 的行数 == 它列出的行名；④ == `ROW_ROUTES` 键数 + 1（core）
== `cordis.patch.yml` 的 `id: tradewatcher-*` 行数（名字按**集合**比对，不管顺序 —— 清单顺序是叙述选择）；
⑤ README 不许再出现 `cordis.patch.yml:<行号>`。

**注入**：把 README 改回「六个页签」/「七行」/删掉 ` / fupan` ⇒ 对应断言必红（三条各自验证过）。

---

## 6. 验证证据（可复现）

```
$ npx tsc --noEmit -p tsconfig.json
（无输出）
$ DSH_HOME=/tmp/r135-check npm test
ℹ tests 1046   ℹ pass 1046   ℹ fail 0        # 宿主时区
ℹ tests 1046   ℹ pass 1046   ℹ fail 0        # TZ=UTC
$ DSH_HOME=/tmp/r135-check npm run check
ALL HOST CHECKS PASSED (live probes soft)
built lib/index.js + lib/client.js （v0.120.0，客户端片段校验通过：73 项）
```

夹具生成（一次性，结果入库，脚本未入库）：

```
# 1) 真实快照载荷（只读本机缓存；DSH_HOME 指向 /tmp 副本，从不写 ~/.dsh）
DSH_HOME=/tmp/r135-fixture-home node --experimental-strip-types /tmp/r135-genfixtures.mts
# 2) 空快照（空 DSH_HOME ⇒ 整块缺失）
DSH_HOME=/tmp/r135-empty-home  node --experimental-strip-types /tmp/r135-gen2.mts
# 3) 杠杆：buildLeveragePayload(真实 4019 行, '250') / emptyLeveragePayload('250')
DSH_HOME=/tmp/r135-fixture-home node --experimental-strip-types /tmp/r135-gen3.mts
```

产物：`src/client/tools/fixtures/{cake-full,cake-empty,leverage-full,leverage-empty}.json`
（10.4 KB / 8.6 KB / 8.9 KB / 215 B；含 `asOf`=2026-10-20、250 个序列日、温度 85.2 —— 与 `CHANGELOG` v0.120.0 的 85.4 同一量级）。
**夹具里没有任何个人数据**（全是市场数据）。

---

## 7. 未做项（有意，不是漏）

| 项 | 为什么不做 |
| --- | --- |
| **R2** 底部概率的区间独立性声明 | 用户裁决"之后再说（需先测量）"。测量口径已在设计稿 §2-R2 写好：先数现有 `bottom.json` 里"同日 ≥2 通道命中"的比例 |
| **救援面板的闸门接入** | `RescuePanel.tsx` 把六因子表与「历史频率」的字符串**内联构造在 JSX 里**，没有整块纯模型可套；要先抽模型（+M），属第二批 |
| **闸门的运行时告警** | 本轮**只做测试强制点**。理由：现有 `warnPieContractOnce` / `warnPlotContractOnce` 是"展示层配置写坏"的兜底，而载荷闸门检查的是数据诚实性 —— 它的强制点应在测试（与 `plotHeightProblems` 注释里"判据的强制点在测试"同款）。运行时阻塞按裁决明确拒绝 |
| **CHANGELOG 条目与版本号** | 属**发版原子动作**（`docs/DECISIONS.md` 的四步：升版本 → check → 核对产物版本号 → 再重启）。本轮未发版、未重启，故不写 CHANGELOG、不动版本号。发版时建议条目名：`v0.121.0 — 载荷闸门 / 出处 lint / 缓存上限 / 曲线上限；修 A股·港股"有规模无份额"无原因` |
| 全仓统一 `DataProvenance` 形状 | 设计稿 §1.7-Q2 方案 A 判为 L 级、收益 0；本轮只做"新载荷必须带出处"的 lint（R3） |

---

## 8. 边界与未确认

1. **R4 的 160 条是"预算"不是"测量值"**：测量到的是 14 键/标的、45 个标的、p95 字节；把三者换算成 13.8 MB 时用了
   "一个浏览器标签能接受多少 JSON"这一判断。**解析成对象后的堆占用比 JSON 大多少，本轮没有测**（需要浏览器内存分析工具）。
   若将来实测偏大，只需改 `CHART_CACHE_MAX_ENTRIES`（断言会跟着校验预算）。
2. **夹具的 `cake-full` 只有 4 个序列日**（本机快照才累积了 4 天）。曲线不变量（条数 == 市场数、点数 == 日期数）照样成立，
   但"长窗口切片"这条路径的覆盖仍靠 `globalFlowView.test.ts` 的构造夹具。
3. **`cake-empty` 的 `asOf` 非空**（宿主给了"取数时刻"，只是没有点）：所以"必放 ②"验证的是"整块缺失必须有 `why`"，
   而不是"`asOf` 为空"这一支 —— 后者由单元断言覆盖。
4. **杠杆页不渲染日期**是既有用户决定（`leverageHeader.test.ts` ①），闸门对此的处理是"时刻必须在契约里"（`payload` 档 +
   `carrier: 'asOf'`），**不是**"允许没有时刻"。这一点在设计稿 §1.7-Q5 与本文件 §1.2 都写了理由。
5. **A股/港股行级原因的措辞**：写的是"区间分位与 5/20 日动量都要该市场自己的日线，快照里样本不足或缺该市场日线"。
   宿主侧的确切缺因（是"快照天数不足"还是"该市场日线没采到"）没有逐市场区分 —— 两者在快照里目前无法可靠分辨，
   所以按**能同时覆盖两者的表述**写（不猜）。
6. **未做浏览器端验证**：本轮没有打开 GUI 实测（不重启 `dsh web`）。以下两处只有静态证据：
   ① `detailModel` 清空序列后页面落到 `curve.empty` 那一支（锚源码的 `hasCurve` 判据）；
   ② 缓存淘汰在真实浏览器里的条目数曲线（只有单测的假时钟证据）。
