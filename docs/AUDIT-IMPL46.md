> **历史快照**：本文记录的是当时（见下方正文）的行数 / 路由数 / 测试数 / 默认档等读数，**不代表现状**；现状以 `README.md` 与代码为准（对照口径见 `docs/REVIEW-6-ENGINEERING.md` §5.2）。

# AUDIT-IMPL46 —— 复核缺陷修复：0 顶替 / 行级原因 / 实测日红线加锁 / 免责与可见性 / 缓存与 provenance

- 触发：跨模型对抗复核 `docs/AUDIT-HY4-1.md`（`cn:hy4`，对象 = `main` @ `f4c1402`）。
- 基线：`f4c1402`（v0.72.0）树内修复，**未 commit / 未 push**（按纪律留给 Lead 收口）。
- 本轮本人写入面：`src/host/globalFlow.ts`、`src/host/globalFlow.test.ts`、`src/client/tools/globalFlowView.ts`、
  `src/client/tools/globalFlowView.test.ts`、`src/client/tools/cake.ts`、`src/client/toolRegistry.ts`、
  `src/client/toolRegistry.test.ts`、`src/client/toolText.ts`、`src/client/ToolsPage.tsx`、`src/client/toolsPage.test.ts`、
  `src/client/api.ts`（只改一个联合类型）、`docs/AUDIT-IMPL46.md`（本文件）。
  **未触碰** `build.mjs`（零改动）、`styles.ts`（**没有**为可见性去改全局样式）、`src/index.ts`、`src/host/routes.ts`、
  `src/host/sina.ts`、`cordis.patch.yml`、`package.json`、其它行的文件。
- 纪律：未装 bundle、未动 profile、**未重启** `dsh web`；每条修法都在**隔离** `DSH_HOME=/tmp/fixhy4/*` 里做过真网络复核；
  12 条反例注入跑完后逐文件 `sha256sum -c` 全绿（§8）。

---

## 0. 结论（先看这一段）

| 复核项 | 判定 → 本轮处置 | 位置 | 验证 |
| --- | --- | --- | --- |
| §2 全缺场景脚注 `0.00%` | **修好**：分母里没有有值市场时给「未取到」+ 原因；并顺带修掉"全缺时仍在曲线上登记一个什么都没测到的实测点" | `globalFlowView.ts:276`、`globalFlow.ts:793` | 注入 A / L |
| §2 锁它的断言 `^0` 恒真 | **换掉**：改成"整串里不许出现 `0.00%` + 必须含未取到与原因"，判据下沉为单点实现 `looksLikeZeroStandIn`（并自证非恒真） | `toolText.ts:49`、`globalFlow.test.ts` | 注入 A |
| §3 汇率失败时 A股 行没有行级原因 | **修好**：`rowReasonOf` 把"汇率缺 ⇒ 不折算、不进美元合计"写进该行说明（渲染层真的消费它） | `globalFlowView.ts:181` | 注入 C |
| §3 界面不显示 A股 人民币值 | **修好**：规模单元格改为 `1063.50 亿元 ≈ 158.87 亿美元`；缺汇率时 `1063.50 亿元（汇率未取到，未折算）` | `globalFlowView.ts:169` | 注入 B |
| §7 「实测日的洞不许用重建值补」无锁 | **加锁**：新断言 + "能补而没补"的对照组 | `globalFlow.test.ts` | 注入 D（复核时此注入曾全绿） |
| §8 缺「风险偏好代理 ≠ 真实跨境资金净流入」 | **补上**：边界声明第一条，且**工具文件自带** ⇒ 无数据时也在 | `cake.ts:38` | 注入 E |
| §8 免责在 compact/incognito 被 CSS 隐藏 | **修好**：边界声明、状态行、逐行缺口原因**不再复用 `tw-hint`**（改用等价内联样式）⇒ 任何视图档默认可见 | `ToolsPage.tsx:200/326/366/371` | 注入 G（+ 接线检查 3 个角色） |
| §8 附带：边界声明重复渲染 | **修好**：工具声明讲"模型是什么/不是什么"，宿主声明只讲"数字口径与数据源事实"⇒ 12 条**零重复**（原 13 条里 5 组近似重复） | `cake.ts`、`globalFlow.ts:737` | 注入 F |
| §6A 汇率/资金流失败进了 30 分钟缓存 | **修好**：失败抛到 `cached` 外面 ⇒ 不进缓存；加断言"恢复后必须重打" | `globalFlow.ts:603`、`:840` | 注入 H |
| §6B 回退态状态行误报 provenance | **修好**：`source` 增加 `'fallback'`；回退态说"上游全部失败 ⇒ 来自快照（某日），不是实时值"；无快照时**不许提快照** | `globalFlow.ts:702`、`:923`、`globalFlowView.ts:215` | 注入 I |
| §9.1 自校告警是死代码 | **修好**：偏差 > 5% 时推进该行 `missing`（有值也进）⇒ 界面可见 | `globalFlow.ts:637` | 注入 J |
| §9.6 `-0.00pp` | **修好**：`|值| < 0.005` 归零 | `globalFlowView.ts:52` | 注入 K |
| §7「相邻断言有没有同类恒真写法」 | **主动排查**：扫了 5 个测试文件的 700+ 条断言，**另有 1 处同类恒真**（0 顶替扫描被两端锚定 ⇒ 抓不到 `0.00 亿美元`）已修；另补 2 处"空集合真空通过"的长度前置断言（§7） | `globalFlow.test.ts`、`globalFlowView.test.ts` | §7 表 |
| 门禁 | `npm run check` **EXIT=0**：**523 × 2 时区**全绿 + selftest + build（末尾三行见 §9） | —— | §9 |

**没有做的事（明确）**：`tools` 行仍未在运行中的实例里装载（需要重启，见 `AUDIT-IMPL45.md` §8.1，本轮同样未重启）；
紧凑/隐身档仍会隐藏**各区口径行 / 表脚注 / 曲线图例 / 回放说明**（有意的边界：隐藏不等于误导；
只有"数据来源与回退态、逐行缺口原因、免责声明"这几类**必须默认可见**，见 §4.3）。

---

## 1. ① 全缺场景的 0 顶替（含那条恒真断言）

### 1.1 行为：旧 → 新

```ts
// 旧（v0.72.0，globalFlowView.ts 脚注）
`份额合计 = ${fmtSharePct(shownShares.reduce((sum, v) => sum + (v ?? 0), 0))}（分母只含这一天有值的 ${live.length} 个市场）`
// 全缺时 ⇒ 「份额合计 = 0.00%（分母只含这一天有值的 0 个市场）」

// 新（v0.73.0）
live.length === 0
  ? `${NOT_FETCHED}：这一天没有一个市场拿到规模 ⇒ 份额合计无从谈起（分母里没有有值市场）；缺口原因见下面每一行`
  : `份额合计 = ${fmtSharePct(shownShares.reduce((sum, v) => sum + (v ?? 0), 0))}（分母只含这一天有值的 ${live.length} 个市场）`
```

顺带修掉同一场景的第二个问题（复核没有点名，但同属"把没有测到的东西显示成一次观测"）：
全缺时**不再**把今天登记成实测日 —— 否则曲线上会出现一个 `origin=observed` 但每个值都是 `null` 的点，
曲线区会被它顶掉空态、图例还会写"实测日"。现在全缺 ⇒ 曲线 0 个点、走「未取到 + 原因」空态（注入 L 锁住）。

### 1.2 断言：旧（恒真）→ 新（能抓）

```ts
// 旧：脚注以「份额合计 = 」开头 ⇒ 行首锚定永远匹配不到 ⇒ **这条断言不可能失败**
assert.equal(/^0(\.0+)?/.test(model.market.footnotes[0] ?? ''), false, `脚注也不许出现 0：${model.market.footnotes[0]}`)

// 新（三件套，且判据是单点实现）
const footnotes = model.market.footnotes.join(' ／ ')
assert.equal(footnotes.includes('0.00%'), false, `全缺时脚注不许出现 0.00%（那是把"没有值"求和成 0）：${footnotes}`)
assert.equal(footnotes.includes(NOT_FETCHED), true, `全缺时脚注必须给「${NOT_FETCHED}」+ 原因：${footnotes}`)
assert.equal(footnotes.includes('没有一个市场拿到规模'), true, `脚注要说清为什么没有合计：${footnotes}`)
```

**判据下沉**（这是"同类恒真"不会再犯的一半原因）：`toolText.ts` 新增单点判据

```ts
export function looksLikeZeroStandIn(text: string): boolean   // 0 / 0.00 / 0.00% / -0.00 / 0.00 亿美元 …
```

并**自证非恒真**（在两个测试文件里各有一组控制断言）：

```
looksLikeZeroStandIn('0.00%')      === true      判据必须抓到 0.00%
looksLikeZeroStandIn('0.00 亿美元') === true      判据必须抓到带单位的 0
looksLikeZeroStandIn('-0.00')      === true      判据必须抓到负零
looksLikeZeroStandIn('未取到')      === false     判据不许把「未取到」当成 0 顶替
looksLikeZeroStandIn('+0.01pp')    === false     判据不许把真的小变化当成 0
```

---

## 2. ② 行级原因 + A股 人民币值（渲染层只兑现了一半的那条）

### 2.1 规模单元格：原币必须在界面上

```ts
// 旧：只给折美元值 ⇒ 人民币 1063.50 亿元在界面上无处显示
fmtUsd(aumUsd)

// 新（fmtSizeCell）
美元市场：`8222.73 亿美元`
A股（有汇率）：`1063.50 亿元 ≈ 158.87 亿美元`
A股（缺汇率）：`1063.50 亿元（汇率未取到，未折算）`
没有值：`未取到`（原因在行下）
```

列头同步由「规模（美元）」改为「规模」（原值口径写在单元格里，避免"列名说美元、格子里是人民币"的错读）。

### 2.2 行级原因：渲染层必须消费 `missing`

```ts
// 旧：行下说明 = 该市场自己的 missing（汇率缺口不算该市场的 missing）⇒ 缺汇率时 rowNote = null
rowNotes.push(m.missing)

// 新（rowReasonOf）：优先该市场自己的缺口；否则人民币市场"有原币值但折算不出来"这条口径不一致
`A股 规模 1063.50 亿元（人民币）已取到，但本次汇率（新浪 fx_susdcny）未取到 ⇒ 不做美元折算、不进美元合计；其余市场照常（口径不一致，不许静默混算）`
```

同一处的旧断言被复核点名（`||` 让行级那一半永远不成立），一并换掉：

```ts
// 旧（`||` ⇒ 只要载荷 missing 有汇率条目就通过，行级缺口永远测不到）
assert.ok((cn?.missing ?? '').length > 0 || payload.missing.some((m) => m.what.includes('汇率')), '必须标注口径不一致')

// 新：载荷侧、单元格侧、行级原因侧各自钉死
assert.equal(payload.missing.some((m) => m.what.includes('汇率')), true, '载荷 missing 里必须标出口径不一致')
assert.equal(cnRow[2].includes('亿元'), true, `A股 行必须显示人民币原值：${cnRow[2]}`)
assert.equal(cnRow[2].includes('未折算'), true, `汇率缺时要说"未折算"：${cnRow[2]}`)
assert.notEqual(cnNote, null, '⚠ A股 行必须有行级原因（不许只在载荷 missing[] 里）')
assert.equal(cnNote?.includes('汇率'), true, ...)
assert.equal(cnNote?.includes('不进美元合计'), true, ...)
```

另外饼图说明从"缺规模"改成"没有美元规模"（缺的可能只是汇率），精确原因交给行下说明。

---

## 3. ③ 给「实测日的洞不许用重建值补」加锁

复核的注入④（把重建值填进实测日的洞）在 v0.72.0 上跑 14 条 host 断言**全绿** ⇒ 这条红线当时没有看守。
新断言（`globalFlow.test.ts`「红线：实测日缺的市场必须留成真洞」）：

```
① 对照组：**没有**快照的那一天，同一市场会被重建出来（证明"补洞"能力在实现里是存在的）
② 正题：有快照的那一天、该市场缺规模 ⇒ aumUsd / share 必须是 null、partial=true
③ 有值的市场用**实测值**（不是重建值）
④ 实测日那天的份额合计仍是 100%（分母只含有值市场）
⑤ 渲染层：那一天该行的份额格显示「未取到」
```

逆命题检查（复核的注入④ 现在必须失败，见 §8 注入 D）：

```
✖ 红线：实测日缺的市场必须留成真洞（不许拿重建值补）—— 含"能补而没补"的对照组
  AssertionError: ⚠ 实测日缺的市场必须是 null（真洞）—— 不许拿重建值补上
```

---

## 4. ④ 免责声明：内容 + 默认可见 + 去重

### 4.1 内容（工具文件自带 ⇒ 无数据时也在）

```
这是风险偏好代理，不是真实跨境资金净流入：本模型是各市场宽基 ETF 规模权重的相对读数（相对强弱），
份额与轮动主要由价格和汇率驱动，不能读成「资金从某个市场流到了另一个市场」。
```

⚠ **口径取自需求原文**：该句即 `REQ-tools-component.md`（T-5 全球资金流）里"必须显示边界声明：
「这是风险偏好代理，不是真实跨境资金净流入」"要求的**逐字句子**（断言按逐字匹配，不按语义近似匹配）。

放在**第一条**（最重要的读法提示放最前），且在 `cake.ts`（工具文件）里 ⇒ 不依赖数据源是否可用。
断言：`lines[0].includes('跨境资金净流入')`、恰好一条免责、`new Set(lines).size === lines.length`。

### 4.2 去重（复核附带缺陷 C）

| | 旧（13 条，5 组近似重复） | 新（12 条，零重复） |
| --- | --- | --- |
| 工具文件（`cake.ts`） | 6 条：份额口径 / ETF 代理 / 币种 / 净流入 / 曲线 / 来源 | 7 条：**免责** + 上面那 6 条（措辞收紧，明确"模型是什么、不是什么"） |
| 宿主载荷（`FLOW_BOUNDARY`） | 7 条：与工具那 6 条大面积重叠 | 5 条：**只讲数字口径与数据源事实**（字段来源与自校、汇率来源与剔除规则、动量与轮动判定线、窗口与快照保留、SPY 独大导致的形状） |

### 4.3 可见性（compact / incognito）

事实（`styles.ts:90-98`）：`.tw-root[data-view=compact] .tw-hint{display:none}`（incognito 同款，另加 `.tw-chartnote/.tw-drawer-foot/.tw-pop-hint`）。
⇒ 凡是**诚实性核心**文本，都不能复用 `tw-hint`。本轮改了三处（**没有**改全局样式，避免影响别的页面）：

| 位置 | 旧 | 新 | 理由 |
| --- | --- | --- | --- |
| 状态行（`ToolsPage.tsx:200`） | `className: 'tw-hint'` | `data-role='tool-status'` + 内联样式 | 数据来源/回退态/快照态必须可见（复核 §6B 的误报正是靠它传达） |
| 逐行缺口原因（`:326`） | `className: 'tw-hint'` | `data-role='tool-row-note'` + 内联样式 | 红线"缺数据必须给原因"：藏掉原因只剩「未取到」。只有缺数据的行才有这行，正常情形零成本 |
| 边界声明每一条（`:371`） | `className: 'tw-hint'` | `data-role='tool-legal-line'` + 内联样式 | 用户验收要求「页签内可见，不需要展开」+ 复核 §8 的免责 |

接线检查（`toolsPage.test.ts`）对三个角色各自断言"**不许**出现 `className: 'tw-hint'`"，并给了 3 条对应注入（§8 注入 G + 该文件内的 2 条）。
**保持不变**：各区口径行、表脚注、曲线图例、回放说明仍用 `tw-hint`（紧凑档的既有设计；隐藏这些不会造成误读）。

---

## 5. ⑤ 失败不进缓存 / 回退态 provenance

### 5.1 失败不进缓存（复核 §6 附带缺陷 A）

```ts
// 旧：loader 内部 catch ⇒ 返回 {value: null} / [] 被当成"成功值"写进 30 分钟 TTL
const fxOut = await cached('fx:usdcny', TTL, async () => { try { … } catch { return { value: null } } })
const netFlowRaw = await cached('netflow:sh510300', TTL, async () => { try { return await … } catch { return [] } })

// 新：loader 里**抛**（含"上游给了值但明显错"与"空序列"），catch 搬到 cached 外面 ⇒ 失败不进缓存
try { fxOut = await cached('fx:usdcny', TTL, async () => { const q = await fetchSinaFxUsdCny(); if (!(q.rate > 0)) throw …; return { value: q.rate, … } }) }
catch (error) { fxOut = { value: null, at: Date.now(), note: `新浪 fx_susdcny 本次没有可用值（…）` } }
```

实测（断言）：上游失败一轮后**恢复**、把"现在"推进到残缺载荷 TTL（2 分钟）之外 ⇒ 汇率与资金流都必须**重打**；
失败进缓存时它们会停在原次数（注入 H 的读数：`汇率失败不许进 30 分钟缓存（实际仍停在 1 次）`）。
顺带修掉一处时间基准：载荷 TTL 此前用真实 `Date.now()` 判断，注入 `now` 的调用方永远命中缓存 ⇒ 现在一律用传进来的 `now`。

### 5.2 回退态 provenance（复核 §6 附带缺陷 B）

| 情形 | 旧 | 新 |
| --- | --- | --- |
| 上游全失败 + 有快照 | `source='snapshot'` ⇒ 状态行谎称"只读本地快照（**不发上游请求**）"（本次实际发了 14 次且全失败）；专为回退写的那句是**不可达死分支** | `source='fallback'` ⇒ `⚠ 本次上游全部失败 ⇒ 下表与曲线来自最近一次本地快照（某日），不是实时值` |
| 上游全失败 + 无快照 | 仍引用"来自最近一次本地快照"（此时根本没有快照） | `source='live'` ⇒ `⚠ 上游本次全部失败，且本地还没有任何快照 ⇒ 这一屏没有数据（逐行原因见下方说明）`；载荷 `missing[0]` 同款，且**逐行失败原因照旧保留** |

`GlobalFlowPayloadDto.source` 随之扩为 `'live' | 'snapshot' | 'fallback'`（客户端 `api.ts` 同步；
`source='snapshot'` 只由"路由显式要求"产生）。

---

## 6. 附带修的两条（复核 §9.1 / §9.6）

1. **自校告警曾是死代码**：`MarketRaw.aumNote`（"总市值 vs 最新价×股本 差 X%"）只在"该行根本没有值"时被当成兜底串用掉。
   现在**有值但偏差 > 5%** 也会推进该行 `missing`（`why: 'no-source'`）⇒ 界面上该行能看到"口径存疑"。
   断言用 `aumDrift: { spy: 0.5 }`（与复核 probe8 同款场景）：`差 50` / `存疑` 必须出现在 `missing` 与该行说明里（注入 J）。
2. **`-0.00pp`**：`|值| < 0.005` 归零（"小于半个显示位"），保留 `0.00pp` 作为真实的"没变化"；断言 + 注入 K。

---

## 7. 主动排查：相邻断言里的同类恒真写法

**方法**：对 5 个测试文件（`globalFlow.test.ts` 149 条 / `globalFlowView.test.ts` 74 条 / `toolRegistry.test.ts` 70 条 /
`toolsPage.test.ts` 30 条 / `index.test.ts` 115 条，**合计 438 条 `assert.*`**）逐条扫，
按四类可疑形态标注并人工复核：① 行首锚定正则；② 断言里带 `||`；③ `.every/.some` 与 `true/false` 比较（空集合会真空通过）；④ 自身比较。

**结论**：

| 类别 | 命中 | 判定与处置 |
| --- | --- | --- |
| 行首锚定正则（复核发现的那条） | `globalFlow.test.ts:577`（旧） | **恒真，已换成三件套**（§1.2） |
| 行首锚定正则（**本轮新发现**） | `globalFlow.test.ts:320`、`globalFlowView.test.ts:142`（旧）：`/^[+-]?0(\.0+)?\s*%?$/` | **半恒真**：两端锚定 ⇒ 抓不到 `0.00 亿美元`、`0.00 亿元` 这种"带单位的 0 顶替"。⇒ 换成单点判据 `looksLikeZeroStandIn`（`toolText.ts:49`）+ 自证非恒真 |
| 断言内 `||` | `globalFlow.test.ts:464`（旧，复核点名） | **弱化为恒真**（行级那一半永远不成立）⇒ 已拆成三条独立断言（§2.2） |
| 循环真空通过 | `globalFlow.test.ts` 两处 `for (const row of model.market.rows)`、`globalFlowView.test.ts` 的 KPI 循环 | 前置补 `assert.equal(rows.length, 5)` / `assert.equal(cells.length, 4)`：集合为空时不再"静默通过" |
| `.some(...) === false` 类 | `globalFlowView.test.ts` 饼图 0 值检查 | **可能真空**（slices 为空时恒真）⇒ 前置补 `assert.ok(slices.length > 0)` |
| 其余（`^从 .+ 转向 .+`、`.some(...) === true`、`index.test.ts` 的既有形态） | 16 处候选 | 复核后**判为非恒真**（正向 `assert.match`/要求"至少一个命中"/互斥集合断言），保留 |

判据"非恒真"的证据方式也统一了：**判据本身必须能抓到一个构造的违规样本**（上面两组控制断言），
这比"再写一条看起来严谨的正则"更能防止复发。

---

## 8. 反例注入（12 条，全部被抓；贴证据后已恢复）

脚本 `/tmp/fixhy4/inject.py`（不进仓库）：真改工作区源码 → 跑对应测试文件 → 记录 exit code 与首条失败断言 → 立刻还原并校验 sha256。
**注入期间只跑测试、不构建**（宿主热重载不会把半成品推给运行中的实例）。

| 注入 | 关掉什么 | 结果 | 首条失败断言（节选） |
| --- | --- | --- | --- |
| A | ① 脚注退回"把没有值求和成 0.00%" | exit=1 | `全缺时脚注不许出现 0.00%（那是把"没有值"求和成 0）：份额合计 = 0.00%…` |
| L | ① 全缺时仍登记"实测日"（曲线出现空点） | exit=1 | `全缺时曲线不该有点` |
| B | ② 规模单元格不再显示人民币原值 | exit=1 | `A股 要显示人民币原值：1588.70 亿美元` |
| C | ② 行级原因不再消费汇率缺口 | exit=1 | `缺汇率时 A股 行必须有行级原因` |
| D | ③ 实测日的洞用重建值补（复核的注入④） | exit=1 | `⚠ 实测日缺的市场必须是 null（真洞）—— 不许拿重建值补上` |
| E | ④ 去掉免责那一条 | exit=1 | `必须恰好一条免责（风险偏好代理 ≠ 真实跨境资金净流入），实际 0 条` |
| F | ④ 边界声明重复渲染 | exit=1 | `有数据：边界声明不许有重复条目（工具声明 + 数据源声明要各讲各的）` |
| G | ④ 边界声明复用 `tw-hint` | exit=1 | `渲染接线检查未通过：边界声明的每一条不许复用 tw-hint…` |
| H | ⑤ 汇率失败重新进 30 分钟缓存 | exit=1 | `汇率失败不许进 30 分钟缓存（实际仍停在 1 次）` |
| I | ⑤ 回退态谎称"只读快照" | exit=1 | `上游全失败 + 有快照 ⇒ source 必须是 fallback` |
| J | §9.1 自校告警重新变成死代码 | exit=1 | `口径存疑必须进 missing（否则界面看不到）：[]` |
| K | §9.6 去掉负零归零 | exit=1 | `小于半个显示位的负值不许显示成 -0.00pp（负零看起来像错值）` |

汇总（原始日志 `/tmp/fixhy4/inject/*.log`）：**12/12 exit=1**，随后
`sha256sum -c /tmp/fixhy4/sha.before2` ⇒ 6 个源文件**全部**一致（工作区已恢复）。
另有测试内自带注入：`toolsPage.test.ts` 9 条（含"边界声明/状态行/逐行原因复用 tw-hint"三条）、
`toolRegistry.test.ts` 的"无 loader 走 PENDING_WHY"与"数据只来自 ToolData"两条、`globalFlow.test.ts` 的判据自证控制断言。

> 如实记录一次**没抓住**：第一轮注入 L（全缺时登记实测日）**exit=0** —— 说明"去掉那个 `if`"没有任何断言看守。
> ⇒ 不是改实现，而是**补断言**（曲线 0 点 / 无实测日 / 界面走空态），补完后同一条注入 exit=1。
> 这就是本批的主题：**断言不敏感（恒真/真空）比实现错更难发现**。

---

## 9. 门禁与真网络复核

### 9.1 `npm run check`

```
EXIT=0
ℹ tests 523 / pass 523 / fail 0      （默认时区）
ℹ tests 523 / pass 523 / fail 0      （TZ=UTC）
ALL HOST CHECKS PASSED (live probes soft)
```

末尾三行（`/tmp/fixhy4/check.log`，非空行）：

```
> dsh-tradewatcher@0.72.0 build
> node build.mjs
built lib/index.js + lib/client.js （v0.72.0，客户端片段校验通过：73 项）
```

- 基线 **515/时区** ⇒ 本批 **523/时区**（+8：host 5、client 视图 2、注册表 1）。
- 两条 `WARN(soft)` 是既有的（上游抽屉端点当时不可用；`100.FTSE/GDAXI/N225` 自 v0.71.0 起如实没有兜底源），与本批无关。
- `build.mjs` 零改动 ⇒ 片段校验仍是 73 项。版本号**未动**（留给发布收口）。

### 9.2 真网络复核（隔离 `DSH_HOME=/tmp/fixhy4-live-*`，2026-10-12 22:27）

```
上游请求 = 14 | source = live
状态行 = 数据时刻 2026-10-12 22:27（北京时间）｜上游现取（宿主三层 TTL：现价类 30 分钟 / 日线 12 小时 / 载荷 10 分钟）｜曲线 180 个序列日（实测 1 / 重建 179）
KPI = 规模榜首:美股 89.20%（五日 +0.20pp） | 五市场合计规模:9209.49 亿美元（汇率 6.6941（新浪 fx_susdcny（在岸人民币））） | 近五日轮动:从 新兴市场 转向 美股（5 日份额 -0.11pp → +0.20pp） | 数据时刻:2026-10-12（实测）
行: 美股    | SPY    | 8214.70 亿美元               | 89.20% | +0.01pp | …
行: A股     | 510300 | 1063.50 亿元 ≈ 158.87 亿美元 | 1.73%  | -0.01pp | …
脚注 = 份额合计 = 100.00%（分母只含这一天有值的 5 个市场） ／ 动量列 = 20 / 60 / 120 日收益率（…）
边界声明 12 条（去重后 12 条）；免责命中 = 1 条；首条含免责 = true
```

（A股 单元格与 12 条零重复的边界声明就是本轮 ② 与 ④ 的现场读数。）

---

## 10. 未做项 / 诚实披露

| 项 | 说明 |
| --- | --- |
| 重启装载 `tools` 行 | 与 `AUDIT-IMPL45.md` §8.1 一致：运行中的实例只装载了 6 行，新页签/新路由要**重启**才可见（本轮同样**未重启**，按约束） |
| 紧凑/隐身档下的其余说明文字 | **有意的边界**：各区口径行 / 表脚注 / 曲线图例 / 回放说明仍复用 `tw-hint`（紧凑档隐藏它们是仓库既有设计，隐藏不会造成误读）。只有"数据来源与回退态、逐行缺口原因、免责声明"被要求默认可见（§4.3） |
| 隐身档的金额模糊 | 本工具显示的是**公开市场数据**（ETF 规模），不走 `fmtAmt`/`fmtRaw` 的隐身遮罩 —— 那是给"用户自己的持仓金额"用的；此处保持可见 |
| 浏览器像素级验证 | 仍无浏览器/jsdom（复核方用的是 `react-dom/server`）。可见性结论的链条是：**源码层**（不再带 `tw-hint`）+ **接线断言**（3 个角色的 `data-role`）+ **注入**（把 `tw-hint` 加回去必红）+ **CSS 事实**（`styles.ts:90-98` 隐藏 `tw-hint`），没有做渲染后的计算样式比对 |
| 复核对拍 | 本文件只记录**我这一侧**的处置；`docs/AUDIT-HY4-1.md` 是复核方的唯一写入面，我没有改动它（两份文档合起来才是完整闭环） |
| 版本号 / CHANGELOG | 未动（留给发布收口；建议与"重启装载 tools 行"一起排） |
| ⚠ **需求文件与用户口径不一致（提请注意）** | `REQ-tools-component.md` 的 T-5 写的是"5 个市场（**A股、港股、美国、日本、韩国**）"，而本轮任务书明确"用户已定（不得改）：五市场 = **美股、欧股、日股、A股、新兴市场**"。我按**任务书**实现（这也是复核方核对的基线），并把差异记在这里：如果要以需求文件为准，五市场的**成分**需要改（数据源要换成 港股/韩国 的宽基，取值路径与断言都要跟着改，属于口径变更而非缺陷修复）——**请 Lead 决定**。本文件与 `AUDIT-IMPL45.md` 里的所有读数都基于任务书的五市场。 |
