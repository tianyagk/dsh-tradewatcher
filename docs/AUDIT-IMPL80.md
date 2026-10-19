# AUDIT-IMPL80：护盘「覆盖广度」阶段一（只记录 + 展示，附加分恒 0）+ 阶段二函数（默认关闭）

- **实施时刻**：2026-10-19 20:05 起（Asia/Shanghai）
- **起点**：`e7e29f9`（v0.109.0；门禁基线 868 用例 × 2 时区 + 构建 73 项）
- **用户批准的规格**（**不得改口径**）：
  1. 每条采样记录都算 coverage：触发 = 该通道**同刻度 z ≥ 2**（`sameSlotZ` 那套基线，**不另造阈值**）；
     族＝大盘(沪深300+上证50) / 中小盘(中证500+中证1000) / 成长(科创50+创业板)，族内任一触发即命中（M 上限 3）；
     `confirm1`＝沪深300 与 6 只宽基 ETF 的方向一致性（**只用已有数据、零新增上游请求**）；
     `confirm2`＝30 年国债 ETF 的**反向**读数（**只展示、永不进评分**）；
     落盘 `rescue-log` 每条记录新增 `coverage`，**与现有日志同寿命**（不单独裁剪）。
  2. 阶段二（实现但**默认关闭**）：4 因子权重合计 **0.717 不动、严禁重新归一化**；阶梯 1 族 0 / 2 族 3 / 3 族 6
     （且必须 **M ≥ 2 且 N ≥ 3**）；`confirm1` 一致 2 / 强一致 4，`confirm2` 永不加分；合计上限 **10**，加进 `raw`；
     单一开关 `rescueCoverageEnabled`（默认 false），false ⇒ 附加分**恒 0**，但字段照常落盘与展示，开关状态进快照。
- **纪律**：未动 `build.mjs`、未新增依赖、不 commit、不装、不动 profile、不重启 `dsh web`；实验隔离
  `DSH_HOME=/tmp/cov-*`（测试内 `mkdtemp`）、注入实验在 `/tmp/cov80-inject`（`rsync` 出、依赖软链）；未手工写 `~/.dsh`。

---

## 0. 结论（一行）

覆盖广度已按批准的 7 键契约落进**快照 / 事件 / 每条出分日志**，阶段一附加分恒 0（穷举验证）、阶段二函数在开关打开时
**只做加法**（M=3+强一致 = 10，恰好加进 `raw`，四因子权重合计仍 0.717），`confirm2` 只展示、永不进评分；
13 条断言 + 9 个**真实源码注入**都在隔离副本里证明"注入即红"（含阶段一恒 0、归一化、阶梯、上限、fetch、族映射、`confirm2` 写 0）。

---

## 1. `coverage` 字段与族映射

### 1.1 契约（与客户端对齐的**最终** 7 键，`src/shared/model.ts:1649`）

| 字段 | 含义 | 进评分 |
| --- | --- | --- |
| `nEtf` | 本拍**触发**的宽基通道数（`volumeZ ≥ 2`） | ✅ 门槛 N≥3 |
| `nEtfWithData` | 本拍**取到 `volumeZ`**（基线可用）的宽基通道数 ⇒ 触发数的诚实分母（0 = 基线不足，不是"没通道"） | ❌ 仅展示 |
| `nFamily` | 命中族数 0–3（族内任一通道触发即命中） | ✅ 阶梯 + 门槛 M≥2 |
| `families` | 命中的**族名**子集（固定顺序 `大盘 → 中小盘 → 成长`，长度恒 == `nFamily`） | ❌ 仅展示 |
| `confirm1` | 沪深300 与宽基 ETF 的方向一致性：`strong` / `same` / `mixed` | ✅ 2 / 4 / 0 |
| `confirm1N` | 与沪深300 **同向**的通道数（方向读数口径） | ❌ 仅展示 |
| `confirm2` | 30 年国债 ETF 的**反向**读数 = −(当日涨跌幅%)；`null` = 本次行情批次里没有它 | ❌ **永不加分** |

同级的 `coverageWhy: string[]`（空数组 = 本次无缺失）承载**缺失原因**：`confirm2` 未取到、沪深300 涨跌幅未取到/为
0.00%（方向无从判断）等 —— **不写 0**（红线：0 会被读成"债不动 / 没有触发"）。

### 1.2 族映射（**唯一来源**，宿主与客户端共用）

| 文件:行号 | 内容 |
| --- | --- |
| `src/shared/model.ts:1611` | `RescueCoverageFamily = 'large' \| 'mid' \| 'growth'` |
| `src/shared/model.ts:1614` | `RESCUE_COVERAGE_FAMILY_LABEL`：`large/大盘`、`mid/中小盘`、`growth/成长` |
| `src/shared/model.ts:1626` | `RESCUE_COVERAGE_FAMILY_OF_INDEX`：沪深300/上证50→large、中证500/中证1000→mid、**科创50/创业板指→growth** |
| `src/host/rescue.ts:591` | `RESCUE_COVERAGE_Z_HIT = 2`（触发门槛，与量能因子同一套 `sameSlotZ` 刻度） |
| `src/host/rescue.ts:684` | `buildRescueCoverage()`（纯函数：不读时钟、不发请求、不写盘） |
| `src/host/rescue.ts:2221` | 采样路径调用点：`channels: etfs.map(...)` + `indexPct`（**就是本拍已取回的那批行情**） |

**触发口径**：`volumeZ >= 2`（`>=`，不是 `>`）。`volumeZ` 就是 `etfs[].volumeZ` —— 即 v0.94 起量能因子用的
`sameSlotZ`（同 5 分钟 slot 的近 20 日 μ/σ），**没有第二套阈值**。

### 1.3 `confirm1` 判据（方向一致性）

- 指数方向取 `indexPct`（沪深300）；通道方向取各自 `pct`；`|涨跌幅| < 0.005` 视为 `flat`（0.00%，无方向）。
- `strong` 强一致：**有方向读数的通道全部同向**且至少 3 条读数（默认 6/6）；
- `same` 一致：同向数 > 反向数（严格多数，默认 5/6 或 4/6）；
- `mixed` 不一致 / 无从判断（数据缺失、指数 0.00%）⇒ 0 分，**绝不抬高**（并写入 `coverageWhy`）。

### 1.4 `confirm2`（30 年国债 ETF 反向读数）

- 在**本次行情批次**里查 `1.511090` / `1.511130` 或名称含「30年国债 / 30 年国债 / 三十年国债」的通道
  （`src/shared/model.ts:1845`、`src/host/rescue.ts:666`）；命中 ⇒ `−(涨跌幅%)`，保留 2 位小数。
- **不为它单独发请求**：它不在护盘通道池里，用户把它加进「自定义通道」后才会随批次出现；不在批次里 ⇒
  `null` + 原因「本次行情批次里没有 30 年国债 ETF（它不在护盘通道池；不为此单独取数）⇒ confirm2 未取到」。
- `confirm2` **永不进评分**（断言 ④ 用"只改 `confirm2` ⇒ raw 一模一样"锁住）。

---

## 2. 阶段二附加分与开关

| 文件:行号 | 内容 |
| --- | --- |
| `src/host/rescue.ts:596` | 阶梯 `{1: 0, 2: 3, 3: 6}`（族数上限 3，`≥3` 兜异常输入） |
| `src/host/rescue.ts:598` | `confirm1`：`mixed 0 / same 2 / strong 4` |
| `src/host/rescue.ts:600` | 合计上限 `10` |
| `src/host/rescue.ts:593` | 门槛 `M ≥ 2` 与 `N ≥ 3`（两者**同时**满足才给阶梯分） |
| `src/host/rescue.ts:619` | `rescueCoverageBonusOf(coverage, enabled)` —— **唯一实现**，`enabled !== true` 立即返回 0 |
| `src/host/rescue.ts:2252` | 采样路径把开关传进评分：`coverageEnabled: this.config.rescueCoverageEnabled === true` |
| `src/host/rescue.ts:991` | `const raw = rawFactors + coverageBonus`（**加法**，不动 `RESCUE_WEIGHTS`；`coverage`/开关判定在 :987-988） |

- **权重合计 0.717 不动**：`RESCUE_WEIGHTS` 字面量逐项未改（断言 ② 逐项对拍 + 表内不许出现除法）。
- **不重新归一化**：附加分只加在 `raw` 上；四因子的 `weight` / `score` / `contribution` 与关闭开关时**逐字段相同**
  （断言 ⑩ 对比同一行情下开关开/关的 `scoreLog`）。
- **开关**：`RescueConfig.rescueCoverageEnabled?: boolean`（`src/shared/model.ts:1812`），`DEFAULT_PREFS.rescue` 里显式
  `false`；`normalizeRescuePrefs` 按 `=== true` 收敛（`src/host/store.ts:1348`），手改坏值一律当 false。
- **开关状态进快照**：`snapshot.coverageEnabled`（`src/shared/model.ts:1934`，`src/host/rescue.ts:2352`）＋
  `snapshot.config.rescueCoverageEnabled`；阶段一在 `summary` 里也写明「附加 0（开关关闭：只记录不评分）」。
- **非交易时段**：不出等级 ⇒ 附加分记 0（不出现"加了但没用上"这种会误读的结果），但 `coverage` 读数照常给出。

### 2.1 落盘（与日志同寿命）

| 位置 | 文件:行号 | 说明 |
| --- | --- | --- |
| 每条出分日志 | `src/host/rescue.ts:2621`（`pushScoreLog`）/ `ScoreLogEntry` 的 `coverage`、`coverageWhy`、`coverageBonus` | 跟着 `scoreLog` 的 60 天 / 240 条裁剪走，**不新增保留规则**（`DayLog`/`LogFile` 里没有 coverage 存储，断言 ⑩ 扫源码锁住） |
| 信号事件 | `src/host/rescue.ts:2283` | 跨日回看（`?day=` 的 `dayEvents[]`）也能读 |
| 快照 | `src/host/rescue.ts:2350` | `coverage` / `coverageWhy` / `coverageEnabled` |
| 上次成功快照 | `src/host/rescue.ts:155-205`（`PersistedSnapshot` / `stripSnapshot`，新字段在 `:180`） | 收盘后重启照样能显示；老快照 ⇒ `null` + 原因 |
| 线上回包 | `wireRescueSnapshot` 是 `{...snapshot}` 展开 | **不裁**新字段（客户端读的就是它） |

---

## 3. 断言 + 反例注入（`src/host/impl80.test.ts`，13 条用例）

| # | 规格要求 | 断言 | 真实源码注入（隔离副本 `/tmp/cov80-inject`，一次只注一处）与读数 |
| --- | --- | --- | --- |
| ① | 开关 false ⇒ 附加分恒 0 | 穷举 `nEtf 0–8 × nFamily 0–4 × confirm1 3` 全组合，false ⇒ 0；同输入 true ⇒ 10 | 把 `if (enabled !== true) return 0` 改成永假 ⇒ **5 条用例红**，首条 `开关 false ⇒ 附加分必须恒 0（输入 {"nEtf":3,"nFamily":2,"confirm1":"strong"}）` |
| ② | 权重合计 0.717、四项未变；严禁归一化 | `RESCUE_WEIGHTS` 逐项对拍 + 合计 0.717；出分因子权重同源；`raw = Σw·f + bonus`；权重表里没有 `/` | 四项改成归一化值（0.333/0.273/0.181/0.213，合计 1.000）⇒ **5 条红**，首条 `volume 的权重必须保持 0.239（实际 0.333）` |
| ③ | 阶梯与门槛 | `M=1⇒0`；`M=2,N=5⇒3`；`M=3,N=3⇒6`；`M=2,N=2⇒0`（+`M=2,N=3,same⇒5`） | 阶梯错一档（`{1:0, 2:6, 3:6}`）⇒ **2 条红**，首条 `M=2,N=5 ⇒ 3` |
| ④ | confirm1 一致 2 / 强一致 4；② 永不加分 | `mixed 0 / same 2 / strong 4`；只改 `confirm2` ⇒ 附加分、raw、连续评分**完全相同**；展示字段（`confirm1N`/`nEtfWithData`/`families`）全改 ⇒ raw 不变 | 把 `\|confirm2\|` 加进附加分 ⇒ 判据红；把 `confirm1N` 混进附加分（源码注入）⇒ **7 条红** |
| ⑤ | 合计上限 10 | `M=3 + strong = 10`；全组合穷举最大值 = 10 | 上限抬到 12 ⇒ **1 条红**（`⑤ 合计上限 10`）；另有一条"上限外再加 2 分（=12）"的用例内注入 |
| ⑥ | 不新增上游请求 | 构造器是**同步纯函数**、函数体无 `fetch(`/`await`/`http`；采样路径输入来自 `etfs`；**批次里没有国债 ETF 时不发任何 `511090/511130` 请求**；在池里时的请求全部落在既有管线（`ulist/trends2/fflow/kline/minute/fqkline`） | 给 `buildRescueCoverage` 插一行 `fetch(...)` ⇒ **5 条红**，首条 `覆盖广度构造器里不许出现 fetch(` |
| ⑦ | 族归类逐通道正确 | 逐通道断言 6 条 index→族；科创50 单独触发 ⇒ 只命中「成长」；大盘+中小盘 ⇒ `['大盘','中小盘']` | 把 `科创50` 改成 `'large'` ⇒ **3 条红**，首条 `科创50 必须归入「成长」` |
| ⑧ | `confirm2`：批次含 ⇒ 有值；不含 ⇒ null + 原因 | 债跌 1.26% ⇒ `+1.26`；债涨 0.8% ⇒ `−0.8`；名称兜底命中；不含 ⇒ `null` + 原因；在批次但缺涨跌幅 ⇒ `null` + 原因 | 缺数据写 0（`confirm2 ?? 0`）⇒ **5 条红**，首条 `未取到必须是 null（0 会被读成"债不动"）` |
| ⑨ | confirm1 三档 | 6/6 ⇒ strong；5/6 ⇒ same（`confirm1N=5`）；3:3 ⇒ mixed；指数缺失/0.00% ⇒ mixed + 原因 | 见 ④/⑦ 的注入（同一判据） |
| ⑩ | 端到端 | 打桩上游跑**真采样**：快照 7 键齐全、`coverageEnabled` 回显、事件带同一份 coverage、每条 `scoreLog` 都有 coverage（阶段一 `coverageBonus=0`）；开关打开 ⇒ `coverageBonus=10`、`rawScore` **恰好 +10**、四因子 `id/weight/score` 逐项不变、权重合计 0.717；`DayLog/LogFile` 里没有 coverage 存储；自定义通道不进族/分母；国债读数来自既有管线 | 附加分不进 `raw`（`raw = rawFactors`）⇒ **5 条红**，首条 `raw 必须 = Σw·f + 附加分` |
| ⑪ | prefs 白名单 | 写入 `rescueInboxRead` 后 GET `/prefs` **原样读回**；未登记键（`notARealPref`）确实被静默丢弃（= 删分支的等价注入）；`applyPrefsPatch` 分支存在于源码 | 等价注入 = 去掉分支：`rescueInboxRead` 会像 `notARealPref` 一样消失 ⇒ 读回断言必红（前置用例已把该行为钉住） |
| ⑫ | 宽容归一 + 上界 | 非对象/数组 ⇒ `{}`；`'2'`/`NaN`/`Infinity`/空键 ⇒ 丢弃；2500 键 ⇒ 裁到 2000 且**最旧的被丢**；HTTP 非对象不 500 | 强转（不归一）⇒ 判据红；不裁剪 ⇒ 判据红（用例内注入） |
| ⑬ | 装载纪律 | 手改 `prefs.json`（`rescueInboxRead: 'broken'`、`rescueCoverageEnabled: 'yes'`）⇒ `{}` 与 `false`，不阻断启动；合法值可 `setConfig` 并回显 | —（正向多态断言） |

> 注入实验的判定标准：`node --test src/host/impl80.test.ts` 在隔离副本里 **exit 1**，且失败用例正是对应断言。
> **9 个真实源码注入**（① 开关 / ② 归一化 / ③ 阶梯 / ④ confirm1N 进 raw / ⑤ 上限 / ⑥ fetch / ⑦ 族映射 /
> ⑧ confirm2 写 0 / ⑩ 附加分不进 raw）全部让门禁变红，读数逐条记在上表。

---

## 4. 与客户端对齐的接口面（本批宿主侧改动）

| 文件 | 改动 |
| --- | --- |
| `src/shared/model.ts` | `RescueCoverage` / `RescueCoverageConfirm1` / `RescueCoverageFamily` / 族映射与族名 / `RESCUE_BOND_30Y_*`；`RescueSnapshot.coverage/coverageWhy/coverageEnabled`；`RescueSignalEvent.coverage/coverageWhy`；`RescueConfig.rescueCoverageEnabled`；`PortPrefs.rescueInboxRead`；`DEFAULT_PREFS` 两项默认值 |
| `src/host/rescue.ts` | 覆盖广度常量 + `rescueCoverageBonusOf` + `buildRescueCoverage`；`scoreRescue` 接收 `coverage/coverageWhy/coverageEnabled` 并把附加分加进 `raw`；`RescueScoreResult.coverage/coverageWhy/coverageBonus`；采样路径计算 + 事件/快照/出分日志落盘；`PersistedSnapshot`/`stripSnapshot` 保留 |
| `src/host/store.ts` | `applyPrefsPatch` 放行 `rescueInboxRead`（宽容归一）；`normalizeRescueInboxRead` + `RESCUE_INBOX_READ_MAX = 2000`；`normalizeRescuePrefs` 收敛 `rescueCoverageEnabled`；`prefsFrom` 装载归一 |
| `src/host/impl80.test.ts` | 本批 13 条断言 |

**客户端（另由 impl-cov-ui 负责）**：`src/client/rescueCoverage.ts`（短标记 `3 族 · 5/6` + 悬停口径）、
`src/client/rescueInbox.ts`（跨日信号收件箱）、`RescuePanel.tsx` 接线；读 `snapshot.coverage`（老宿主回退到最新事件）、
`coverageWhy`、`coverageEnabled`。

---

## 5. 门禁读数

**两轮 `npm run check`（运行期间未再改动工作树，2026-10-19 20:2x，Asia/Shanghai）**

| 轮次 | typecheck | 用例（本地 TZ） | 用例（`TZ=UTC`） | selftest | 构建 |
| --- | --- | --- | --- | --- | --- |
| 第 1 轮 | 通过 | **890 通过 / 0 失败**（22.03 s） | **890 通过 / 0 失败**（19.17 s） | `ALL HOST CHECKS PASSED (live probes soft)` | **73 项通过** |
| 第 2 轮 | 通过 | **890 通过 / 0 失败**（19.77 s） | **890 通过 / 0 失败**（18.27 s） | 同上 | **73 项通过** |

- 用例构成：**868（`e7e29f9` 基线）+ 13（本批 `src/host/impl80.test.ts`）+ 9（`src/client/impl81.test.ts`，客户端批次）**。
- 两轮 `RUN_EXIT=0`；只有两条**既有** soft 告警（`drawer endpoints 上游熔断`、`preset instruments 25/28`，基线同样存在，非本批引入）。
- `build.mjs` **未改动**（`git diff` 无该文件），两条锁定片段照旧命中（构建 73 项）。

---

## 6. 未做项（如实登记）

1. **`confirm2` 的实际读数依赖用户配置**：默认通道池不含 30 年国债 ETF，因此**默认态 `confirm2 = null`**（带原因）；
   要看到真实读数需把 `1.511090` 加进「自定义通道」。这是"零新增上游请求"的直接代价，不是缺陷。
2. **阶段二没有打开**：`rescueCoverageEnabled` 默认 false；开关的界面入口、跨日回放对照（打开后等级分布差异 ≤ ±1 天/档）
   属下一批（需要真实日志回放）。本批只用合成/打桩样本证明"加 10 分、权重不变"。
3. **`continuous` 触顶**：开关打开且附加分到 10 时，`raw` 上限 81.7 ⇒ 连续评分 = 113.9 被既有 clamp 收在 100
   （阶段一不受影响）。若阶段二上线，是否要改连续评分分母是**口径决策**，本批不动。
4. **agent 工具输出**：`tradewatcher_rescue` 工具回包没有加 coverage 字段（本批范围是面板与落盘；工具侧另批）。
