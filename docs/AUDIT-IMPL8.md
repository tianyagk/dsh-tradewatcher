# P0 实现批次（task-42）· 四段

对象：`dsh-tradewatcher` v0.40.0 工作区。输入：`../arkvol-workbench/audit/EVALUATION.md` 的 P0 项。
基线 282 条 × 2 时区、75 项片段；末次 `npm run check`：**294 条 × 2 时区全绿**、75 项片段通过、`build.mjs` 零改动。

## 第 1 段：两处确定性缺陷（先修）

### ① `commodity` 预设返回国债指数（v0.40.0 自己造的**静默错答**）
- 根因：`tools.ts` 用**位置**取组（`TW_ROWS[2]`），插入「国债」组后顺序变成 `cn/intl/bond/commodity`
  ⇒ `commodity` 拿到国债组、`all` 漏掉全部商品（有价、有出处、看着完全正常）。
- 修法：新增 `twGroupSecids(key)` / `twAllSecids()`（`shared/model.ts`，**按 key 查**，找不到即空数组），工具侧改用它；
  预设表补 `bond`，`all` 用统一并集。
- **修前会失败的证据**（把位置索引临时改回去跑一次）：
```
✖ 预设按组 key 解析：每个预设的 secid 集合必须与 TW_ROWS 对应组逐字一致
  AssertionError: 预设 commodity 必须等于 TW_ROWS 的 commodity 组
    actual: [ '1.000012', '171.US10Y', '171.JP10Y', '171.DE10Y', '171.GB10Y' ]   ← 就是国债组
    expected: [ '114.lhm', '114.jmm', '114.mm', '113.rbm', '112.B00Y', '101.HG00Y', '101.SI00Y', '122.XAU' ]
✖ 回归：commodity 里不许出现国债、且必须含全部商品；all 必须覆盖四组
  AssertionError: commodity 应有 8 只商品（实际 5）
（恢复按 key 版后：tests 3 / pass 3 / fail 0）
```

### ② `ledger` 静默截断
- 默认 100 而真实账本 **149 条**，且回包**不报 truncated**。修法：默认提到 **500**；新增纯函数 `ledgerTotal()`
  （过滤条件与 `ledgerViews` 逐字一致），工具与路由都回 `returned / total / truncated / limit`；工具描述同步改。
- 真实账本实测（只读本机 `ledger.json`）：
```
修后： { "returned": 149, "total": 149, "truncated": false, "limit": 500 }
对照（修复前默认 100）： { "returned": 100, "total": 149, "truncated": true, "limit": 100 }   ← 修复前连 truncated 都没有
```
- 断言：`账本截断必须可读：返回数 / 总数 / truncated / limit 四个字段自洽`（120 条夹具 × limit 500 / 100 两种）。

## 第 2 段：输出口径模板

| 项 | 落地 |
| --- | --- |
| 缺失**四态**（P0-5） | `shared/model.ts` 新增 `MissingWhy = invalid-code / no-source / transient / pending` + `MISSING_STATE_LABEL`（代码不存在/上游无此数据/本次失败/后台更新中）+ `MISSING_STATE_ADVICE`（含"核对代码，重试无用"）。**没有硬造**：只有 `SECID_RE` 这类结构性判据才允许标 `invalid-code`，其余保持两态 —— 详见"未做项" |
| 样本窗 + 样本数（P0-7） | 五档：回包带 `samples / bars / window`，卡片口径写「有效样本 N（M 根日线）」；YTD / 家数 / 护盘：`methodology` 里写明窗口与样本口径 |
| 档位给**区间边界**（P0-9） | `tones` 新增 `TONE_BANDS`（`过冷：分位 <10%` …）并随行返回 `band`；护盘等级区间写进 `RESCUE_METHODOLOGY`；缺失分档给四态标签 |
| `methodology` 作数据字段（P0-10） | 四条链路都有常量 + 随回包返回：`TONES_METHODOLOGY`（`/tones`）、`YTD_METHODOLOGY`（路由与工具）、`BREADTH_METHODOLOGY`（`/breadth`）、`RESCUE_METHODOLOGY`（`/rescue`） |
| 三段说明（P0-8） | **位置工具**已按「怎么算 / 怎么读 / 不能用来干什么」写进工具描述；`RESCUE_METHODOLOGY` 末句写明"**不能用来断言国家队已入场**"；界面常驻仍只留一行（长文在 title/aria 与工具字段里） |

## 第 3 段：出处（做了一部分，如实标注）

- `DataProvenance` 新增三个可选字段：`lagHuman`（滞后时长人话）、`marketState`（开/闭市）、`showing`（降级时"现在显示的是什么"）；
- `lagHumanOf(asOf, now)` 纯函数已落地并断言：`刚刚 / N 分钟前 / N 小时前 / N 天前`，**拿不到时刻就给 null（不编）**
  —— 报告要的「11 天前的快照」现在能直出；`localProvenance` 已经填上 `lagHuman`。
- **未接线**：`marketState` 与 `showing` 目前只有类型与调用点，尚未在行情/护盘回包里填值（见"未做项"）。

## 第 4 段：位置类指标 + 组合构成

### 位置指标（`host/position.ts`，纯函数 + agent 工具 `tradewatcher_position`）
- 口径：`(现价 − 窗口最低) ÷ (窗口最高 − 窗口最低) × 100`；窗口写死成单一常量 `POSITION_WINDOW`（52 周 / 365 自然日，拉 300 根）
  并**随结果返回**（`window` 字段）；文本标签：极接近低点（≤10）/接近低点（≤30）/区间内/接近高点（<90）/极接近高点；
- **必须前复权**：工具按 `em.fqSupported(secid)` 决定 `fqt`（指数/期货按原始价格并如实标 `fqSupported=false`），`fq` 随结果返回；
- 样本数（窗口内交易日根数）、窗口起止日期、越界说明（现价高于窗口高点时位置夹 100% 但距高点%仍是真实值）都在回包里。

**两个真实标的实测**（本机 `klines/` 缓存，只读，未探活）：
```
1.000012（国债指数，指数无复权 ⇒ fq=0）：price 231.1 · high 231.1 · low 224.25 · posPct 100 · fromHigh 0% · fromLow +3.05%
                                        label 极接近高点 · samples 243 · window 52周（最近 365 个自然日）· 2025-10-09 → 2026-10-09
1.600519（贵州茅台，**前复权 fq=1**）：      price 1263 · high 1539.98 · low 1151.01 · posPct 28.79 · fromHigh −17.99% · fromLow +9.73%
                                        label 接近低点 · samples 243 · 同一窗口
```

### 组合构成（`host/composition.ts` + `PortfolioView.composition`）
- `weightOf`（**分数**，0.25＝25%）上移到 `shared/model.ts`，客户端 `client/sort.ts` 与宿主 `host/composition.ts` 都改为消费同一份；
  组合构成另用 `weightPctOf`（百分比）并注明两者单位不同（混用会出 100× 错数）；
- 构成含：逐条权重、**市场分布**（复用 `shared` 的确定性 `marketOf` 映射，翻成中文标签）、
  **行业/主题分布**（只取**本地已有数据**＝分组名；没有标签就是 `null`，界面 `—`，绝不按代码猜）、
  集中度（top1 / top3 / HHI）；缺价的行**不进分母**并计入 `unpriced`。

**真实持仓实测**（本机 `positions.json` + `ledger.json` + `quotes-lkg.json`，走真实 `assemblePortfolio`）：
```
可计价 9 条 / 不可计价 0 条
权重合计 = 100.0000（验收：100% ± 0.01 ✓）
市场分布：A股 100%（9 条）
行业分布（来自本地分组名）：主要持仓 96.12% · 长期持有 3.88%
集中度：top1 23.37% · top3 59.45% · HHI 0.1641
（断言另覆盖"行业拿不到 ⇒ null（界面 —）而不是'未知'"）
```

## 测试与门禁

```
282 → 294（+3 预设/回归、+1 账本截断、+8 位置/组合/滞后人话）
npm run check：294 × 2 时区全绿；ALL HOST CHECKS PASSED (live probes soft)；
built lib/index.js + lib/client.js（v0.40.0，客户端片段校验通过：75 项）   ← build.mjs 零改动
```

## 未做项与原因（如实）

1. **四态的完整应用面**：只落地了词表 + 结构性判据（`invalid-code` 的适用边界写在注释与报告里）。
   其余调用点（行情"查不到这只"、护盘冷启动、日历同步）**现有证据区分不了**"代码不存在/上游没有/后台更新中"，
   按任务要求"区分不了的不要硬造"，保持原两态；要真正四态化需要上游给出可判别的错误码（记入下一轮候选）。
2. **`marketState` / `showing` 尚未在回包里填值**：类型与 `lagHumanOf` 已就位（`localProvenance` 已填 `lagHuman`），
   行情/护盘回包的填值需要逐个源确认"快照时刻"来源，本轮时间不够，**没有半成品上线**（字段可选，缺了不影响）。
3. **YTD/家数/护盘的"样本数"**：这三条链路给的是**窗口**（写在 `methodology` 里），
   其中护盘的家数分位样本数在 `breadth.ts` 内部已有，但未提到回包（下一轮一起做）。
4. 评测报告里位置页"至今涨幅"（YTD join）沿用上一轮结论：不做（图表数据里没有 YTD，属独立任务）。

## 需装机复核（无浏览器，未做视觉验证）
① 账本工具在真实 149 条下的返回（应完整、`truncated=false`）；② 预设 `commodity/bond/all` 在界面与工具里的实际标的集合；
③ 位置指标卡片/工具输出的可读性（两个真实标的）；④ 组合构成在持仓页的呈现（权重合计 100%、行业 `—` 的显示）；
⑤ `methodology` 长文在 title/aria 里的可读性与读屏表现。
