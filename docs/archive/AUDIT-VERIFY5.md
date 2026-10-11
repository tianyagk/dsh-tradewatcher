# 独立验收报告（P0 批次 · 预设回归/截断/位置口径/组合构成 · 对抗验证）

> 验收人：`verify`。立场：**证明实现者说错了** —— 结论基于我自己跑的门禁、我自己构造的反例与副本注入实验，不引用 `docs/AUDIT-IMPL8.md` 的数字。
> 对象：v0.40.0 工作区。临时脚本/副本 `/tmp/tw-v6/`（跑完删除）；写作用域仅本文件。

## 0. 结论：**通过**（无 P0/P1；2 条 P3 观察）

- **L1 静默错答的回归真的修好了**：预设按组 key 解析，我自己数出 `cn 6 / intl 9 / bond 5 / commodity 8 / all 28`；并且我用**副本注入**证明了回归断言在真实旧 bug 形态下会失败（非恒真）。
- **位置指标与组合构成的数值口径逐项自洽**（反算/手算全部吻合），单位陷阱（分数 vs 百分比）在代码里确实被隔离。
- 口径模板（`methodology` / `TONE_BANDS.band` / `lagHuman`）**真的落在回包里**，`marketState`/`showing` 确实**未填值**。
- 两条 P3：① 预设断言中有一条是"同源比较"、在共用函数自身出错时恒真（我的注入实验证明）；② 四态词表的 `invalid-code` / `pending` 目前**没有任何产出点**（预留态）。

## 1. 门禁（我自己跑的）

```
ℹ tests 294  ℹ pass 294  ℹ fail 0     # 第一轮（本机时区）
ℹ tests 294  ℹ pass 294  ℹ fail 0     # 第二轮（TZ=UTC）
ALL HOST CHECKS PASSED (live probes soft)
built lib/index.js + lib/client.js （v0.40.0，客户端片段校验通过：75 项）
```

交叉验证：`src/*/*.test.ts` 共 **37 个文件**、`test()` 合计 **294**，与运行数吻合。`git diff --stat -- build.mjs` **输出为空** → 零改动，75 项片段未删。

## 2. L1 预设回归（本轮头号）

**数量我自己数的**（`node --experimental-strip-types` 直接读 `TW_ROWS`）：

```
cn 6        1.000001,0.399001,0.399006,1.000688,1.000300,1.000905
intl 9      100.KOSPI200,100.FCHI,100.FTSE,100.SX5E,100.SPX,100.NDX,100.GDAXI,100.N225,100.HSI
bond 5      1.000012,171.US10Y,171.JP10Y,171.DE10Y,171.GB10Y
commodity 8 114.lhm,114.jmm,114.mm,113.rbm,112.B00Y,101.HG00Y,101.SI00Y,122.XAU
all = 28
```

→ 与任务要求的 `commodity=8 / bond=5 / all=28` 一致 ✅。

**按 key 而非位置**：`resolveQuoteIds`（`tools.ts:100-111`）用 `twGroupSecids('cn'|'intl'|'commodity'|'bond')` + `twAllSecids()`；`twGroupSecids`（`shared/model.ts:102-105`）走 `TW_ROWS.find(r => r.key === key)`，找不到返回空数组（不猜）✅。全仓 `TW_ROWS[数字]` 写法**零命中**（只有注释里引述历史事故）✅。

### 非恒真验证（隔离副本注入，工作区未改）

把仓库副本到 `/tmp/tw-v6/repo`（软链 node_modules），做**两次**注入：

| 注入 | 内容 | 测试①（预设＝对应组） | 测试②（回归：8 只/不含国债） |
| --- | --- | --- | --- |
| 基线 | 未改动 | ✅ pass | ✅ pass |
| **A** | 把 `twGroupSecids` **本身**改成按位置 | ✅ **仍然通过**（见 P3-1） | ❌ fail（`commodity 应有 8 只（实际 5）`） |
| **B** | 只在**调用点**硬编码位置（精确模拟 v0.40.0 形态：`commodity → twGroupSecids('bond')`） | ❌ fail：`actual: ['1.000012','171.US10Y','171.JP10Y','171.DE10Y','171.GB10Y']` | ❌ fail：`commodity 应有 8 只商品（实际 5）` |

**结论**：真实旧 bug 形态（注入 B）下两条断言都会失败 → **回归防护有效** ✅。同时暴露出**断言强度的边界**（P3-1）：测试①左边是 `resolveQuoteIds(key)`、右边是 `twGroupSecids(key)`，而前者内部就调用后者 —— 当**共用函数本身**错时两边一起错、断言恒真（注入 A 已实测）。真正兜住的是测试②（有独立硬编码基准 8、显式 secid 清单、`TW_ROWS.reduce` 求和）。

## 3. L2 截断契约（`ledger`）

`tools.ts:376-385` 的返回：`{ entries, returned: entries.length, total: matched, truncated: matched > entries.length, limit, provenance }`。

实测（临时 DSH_HOME + 真实 `mutatePortfolio` 写 149 笔 + 建组/建仓）：

```
[账本] ledger.json 条数 = 151   store.ledgerEntries() = 151
```

→ `total` 的口径是**过滤后匹配条数**（未过滤时即文件条数）✅，与 `ledger.json` 实际条数一致。字段风格（`returned/total/truncated/limit`）与其它工具（quotes/ytd/tones 的 `requested/truncated/limit`）同一套命名习惯，没有发明第二套 ✅。

⚠️ 说明：`truncated=true` 的**端到端**我没有构造（需要超过工具默认 limit 的账本）；我只核对了它的判定表达式 `matched > entries.length` 与 `returned = entries.length ≤ limit` 的逻辑正确性，以及路由侧 limit 的夹取（`routes.ts:778`：1–1000，默认 200）。这一条建议装机后再看一眼实际回包。

## 4. 位置指标（`host/position.ts`）

**窗口**：`POSITION_WINDOW = { days: 365, label: '52周（最近 365 个自然日）', bars: 300 }`，结果里回的就是 `POSITION_WINDOW.label` ✅（单一常量、随结果返回）。

**三例反算**（我构造 300 根、窗口内 high=20 / low=10，现价分别 25 / 5 / 15）：

```
[新高] {"posPct":100,"fromHigh":25,"fromLow":150,"label":"极接近高点","why":"现价高于窗口最高价（区间位置按 100% 记）"}
[新低] {"posPct":0,"fromHigh":-75,"fromLow":-50,"label":"极接近低点","why":"现价低于窗口最低价（区间位置按 0% 记）"}
[中段] {"posPct":50,"fromHigh":-25,"fromLow":50,"label":"区间内","why":null}
```

- `posPct` 与 `fromHighPct=(price−hi)/hi×100`、`fromLowPct=(price−lo)/lo×100` **由同一组 hi/lo/price 推出**，我的独立手算全部吻合（`25/150`、`-75/-50`、`-25/50`）✅
- **越界是"夹取 + 如实说明"**（`why` 写明"按 100%/0% 记"），不是静默钳制 ✅

**边界三例**：样本不足（1 根）⇒ `posPct:null` + "窗口内样本不足（1 根 < 2）"；现价缺失 ⇒ null + "现价未取到"；`hi==lo` ⇒ null + "窗口内最高价=最低价，区间位置无意义" ✅ 都不当 0/50。

**复权两类分明**：股票/ETF `{fq:1, fqSupported:true}`；指数/期货 `{fq:0, fqSupported:false}` ✅（我的注入各一例；真实缓存/上游未探活）。

**窗口裁剪**：`windowBars` 按**最后一根的日期回推自然日**（不是"最后 N 根"），10 天窗口 → 11 根、365 天窗口 → 300 根 ✅。

## 5. 组合构成（`host/composition.ts`）

**手算复算**（3 行：mv 1000/600/400）：

```
[构成] {"weights":[50,30,20],"sum":100,"top1":50,"top3":100,"hhi":0.38,"handHhi":0.38,"totalMv":2000}
```

- 权重合计 **100**（±0.01 内）✅；`top1=50`、`top3=100` ✅；**HHI 我自己按 Σw² 复算 = 0.5²+0.3²+0.2² = 0.38**，与回包 `0.38` 一致 ✅
- 单只可计价 ⇒ `weightPct=100`、`hhi=1` ✅

**单位陷阱（被隔离）**：

```
[weightOf] 0.25  [weightPctOf] 25
```

`composition.ts` 显式写明"`weightPctOf` = `weightOf` × 100，同源不同单位，别混用"，组合内部只走 `weightPctOf` → 不存在 100× 错数 ✅。客户端排序/展示仍用分数（既有断言期望 0.25）——两处语义**没有互相污染** ✅。

**缺价行**：`weightPct:null`、不计入分母（可计价行合计仍 100）、`unpriced` 如实计数 ✅。

**行业拿不到**：`sector:null`，`sectors` 切片里**不出现**无标签行；整个结果串里 **不含"未知"**（断言 `!JSON.stringify(r).includes('未知')` 通过）✅。

**真实 store 端到端**（临时 DSH_HOME → `mutatePortfolio` 建组/建仓/买入 → `assemblePortfolio` → `compositionOf`）：`totalMv=1500`，茅台 `66.67%`、宁德 `33.33%`，`hhi=0.5556` —— 与我的手算 `(0.6667² + 0.3333²) = 0.5556` 一致 ✅。

## 6. 口径模板是否真落地

| 项 | 证据 | 判定 |
| --- | --- | --- |
| 四态词表定义 | `model.ts:1037` `MissingWhy = 'invalid-code' \| 'no-source' \| 'transient' \| 'pending'`；`:1041` 短标签；`:1049` 动作建议（`invalid-code` ⇒ **"核对代码，重试无用"**） | ✅ 定义齐 |
| **无效代码不许渲染成"稍后重试"** | 无效代码走**错误路径**：`resolveQuoteIds` 抛 `未解析到合法证券代码`（`tools-presets.test.ts` 的 reject 断言）→ 不进 `missing[]`、不会被渲染成"稍后重试" ✅ | ✅ |
| `TONE_BANDS` 随行返回 | `tonesService.ts:144` `band: r.level === null ? null : TONE_BANDS[r.level]`（`tones.ts:120` 定义） | ✅ |
| `methodology` 在**四个**回包 | tones（`routes.ts:406/412`，来自 `computeTones`）、ytd（`:452/458`）、breadth（`:332` `BREADTH_METHODOLOGY`）、rescue（`:816` `RESCUE_METHODOLOGY`） | ✅ 四处都在（不是只在测试里） |
| `lagHuman` 拿不到时刻 ⇒ `null` | `model.ts:1167-1169`：`asOf === null \|\| !isFinite → null`；未编"刚刚"（"刚刚"只在真有新鲜时刻时给） | ✅ |
| `marketState` / `showing` **确实没填值** | 全仓只出现在 `model.ts:1153/1158` 的**类型定义**，无任何赋值点 | ✅ 与自报一致（未接线） |

**四态只在可判别点落地**：`MISSING_TIER_ADVICE` 的调用点集中在 ytd/calendar/breadthCount（都是 `transient` 档），`MISSING_TIER_LABEL` 在 `tools.ts:79`、`CalendarPage.tsx:212` 渲染 ✅。

## 7. 发现（P3，均不阻塞）

- **P3-1（断言强度）**：预设断言①是"实现入口 vs 同源函数"的比较，当**共用函数本身**错时恒真（注入 A 实测：改 `twGroupSecids` 为按位置后它仍 pass）。**建议**给①补一个独立基准，例如 `assert.equal(twGroupSecids('commodity').length, 8)` 或与显式 secid 清单比对，让"底层函数写错"也能被抓到。
- **P3-2（预留态无入口）**：`invalid-code` 与 `pending` 目前**没有任何产出点**（全仓 grep 零命中），属"类型/词表先备、场景未接线"。与实现者自报一致，不是缺陷；但建议在文档里明说这两个态的启用条件，避免后来者以为它们已在跑。

## 8. 未验证

1. **渲染层**：位置/组合/模板在界面上的呈现（badge、`—`、口径行）未跑（本机无 react 运行时）。
2. **`truncated=true` 的端到端**：只做了判定表达式与路由 limit 夹取的代码核对（见 §3 说明）。
3. **上游真实数据**：按要求不探活；`fqSupported` 两类是注入构造，未读真实缓存。
4. **`tradewatcher_position` / 组合工具的实际输出**：我验证的是 `position.ts`/`composition.ts` 纯函数与 store 端到端，工具 render 的排版未逐字核对。

## 9. 复现

```bash
npm run check                                                      # §1
node --test --experimental-strip-types /tmp/tw-v6/position.test.ts  # §4 / §5（10 条）
node --test --experimental-strip-types /tmp/tw-v6/ledger.test.ts    # §3

# §2 非恒真验证（隔离副本，不动工作区）
mkdir -p /tmp/tw-v6/repo && cp -r src tsconfig.json package.json /tmp/tw-v6/repo/ && ln -sfn "$PWD/node_modules" /tmp/tw-v6/repo/node_modules
cd /tmp/tw-v6/repo && node --test --experimental-strip-types src/host/tools-presets.test.ts   # 基线 3/3
# 把 tools.ts 的 commodity 改成 twGroupSecids('bond') 后再跑 → 2 条失败（正文已贴输出）
```
