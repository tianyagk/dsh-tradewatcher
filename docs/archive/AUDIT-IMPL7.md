# 可配置行情卡片 + 五国国债 + 五档状态 badge（task-38）· 实现记录

对象：`dsh-tradewatcher` v0.39.0 工作区。前置：`docs/RESEARCH-BOND-STRIP.md`（数据可得性实测）、
`docs/DESIGN-STRIP-CONFIG.md`（交互与视觉规格）。三处 Lead 裁决已覆盖设计文档的对应描述（下面注明）。

## 第 1 段：五国国债 + 五档取数（宿主）

### 卡片
`shared/model.ts` 的 `TW_ROWS` 新增 **国债组（5 张）**：中国 `1.000012`（**价格指数**）、
美/日/德/英 `171.US10Y / JP10Y / DE10Y / GB10Y`（**收益率**）。新增 `stripKindOf(secid)`（`171.*` ⇒ `yield`）。
卡名行尾标类型字（`率` / `价`），收益率卡主值写 `4.23%`、副值写 `±bp`（**不套红绿** —— 收益率上行＝债券价格下跌），
`title`/`aria-label` 里写明"收益率（上行＝债券价格下跌）"。

### 五档口径（`host/tones.ts`，纯函数）
- `R30` = 近 30 个交易日涨跌幅；`MOM` = 近 5 日涨跌幅 − 近 20 日涨跌幅；
- `score = 0.6·z(R30) + 0.4·z(MOM)`，`z` 用**该标的自身**历史分布标准化（250 根优先，不足降级 120 → 60）；
- 档位 = `score` 在该标的自身 score 分布中的**分位**：`<10%` 过冷 ｜ `10–30%` 偏冷 ｜ `30–70%` 适中 ｜ `70–90%` 偏热 ｜ `>90%` 过热；
- **收益率类：取负作用在"变化量"上**（`R30`/`MOM` 乘 `−1`），不是作用在价格水平上 —— 见下方"踩到的坑"；
- 样本：`bars ≥ 31` 才可算；`5 ≤ bars < 31` ⇒ `样本不足`；score 样本 < 30 ⇒ `分档基准不足（m/30）`；
  `bars < 5` / 取不到 ⇒ `—` + 原因。**任何情况都不许用「适中」冒充缺失**（红线，已断言）。

**踩到并修掉的坑（值得记一条）**：第一版把"收益率先取负"实现成**把整条收盘序列取负** ——
`(−b)/(−a) = b/a`，那是**恒等变换**，"取负"完全没生效（实测同一段收益率序列的档位与价格型一模一样）。
断言（"价格型上行 ⇒ 热 / 收益率型上行 ⇒ 冷"）当场抓住；现在取负只作用于变化量 ✓。

### 取数与路由
- `host/tonesService.ts`：与 `host/ytd.ts` 同构的**按日 memo** + **失败冷却 10 分钟** + 4-worker 池，
  **复用 `em.fetchKline` 的磁盘缓存**（不新建缓存层），只取**已收盘**日线（当根未收盘剔除）。
- `GET /tradewatcher/tones?ids=` → `{asOf, stale, source, day, rows:[{secid, level, pct, r30, momentum, samples, bars, kind, window, insufficient, why}], missing[], requested, truncated, limit}`。
  （任务书举例写 `badges`，设计文档写 `tones`；按"其余照设计文档执行"取 `tones`，回包字段用设计的 `rows`。）
- `missing.why`：样本/基准不足 ⇒ `no-source`（重试无用）；取不到 ⇒ `transient`（等上游）。

### 五国实测（本机真实缓存 + 已知上游状态，**未探活**）
```
klines/1.000012_101_0.json：800 根，2023-06-19 → 2026-10-09（真实磁盘缓存）
rows：
  1.000012  kind=price  level=适中  r30=+0.42%  samples=250  bars=800  why=—
  171.US10Y kind=yield  level=null  r30=—  samples=0  bars=0  why=日线本次未取到（上游不可达或无该标的），稍后随轮询重试
  171.JP10Y / 171.DE10Y / 171.GB10Y：同上（level=null）
missing：[171.US10Y/JP10Y/DE10Y/GB10Y 状态 ⇒ transient]
```
四国收益率**没有**编造代理、**没有**写 0、**没有**给档位 ✓；东财恢复后应自动可用（同一路由 + memo）。

## 第 2 段：badge（客户端）

- 位置按 Lead 裁决：**卡片右上角**（`right:4px;top:4px`、32×14 胶囊、圆角 7px、只放档位词）；
- **外框尺寸逐像素不变**：唯一改到的既有样式是 `.tw-qcard[data-tone] .nm{padding-right:40px}` 与
  `.tw-qcard[data-tone] .tw-qdot{right:42px}`（**无 tone 时两条都不生效**，现有截图不变）；
- **五档独立色系**（靛蓝→青→石板灰→紫→品红，不含红/绿/琥珀）：浅色 5 值 + 深色 5 值，按设计的对比度实算表写入
  `styles.ts`；语义不靠颜色单独承载（**文字本身**就是档位词 + `data-tone` 供断言与读屏）；
- badge 自身 `pointer-events:none`；口径长句（分位 / 动量 / 有效样本 / 类型 / 更新日期）并入**卡片已有的** `title`/`aria-label`（原则 1/6）；
- badge 与配置窗数字（`.tw-tone` / `.tw-cfg-count`）已登记进 `styles.ts` **两条** `data-blur=1` 清单，
  且悬停容器列表加了 `.tw-cfg`（否则隐身档永远糊着、悬停也不显形）✓（静态核对：第 145/146、158/159、151 行）；
- badge 块里**没有** `#e5484d/#0e8f5c/#ff5f6d/#27a644` 字面量（`grep -c` = 0）；国债卡价格型走 `dirClass`，
  收益率型一律 `tw-flat`（不套涨跌色）。
- **首屏先出卡片、badge 后到**：五档在独立 `useEffect` 里取（`stripKey` 变化才重取），失败只吞掉 badge、不打断行情。

## 第 3 段：齿轮 + 可拖动配置窗

- 齿轮放 `.tw-topmeta` 按钮组**最左**（复用 `.tw-iconbtn`，`aria-haspopup=dialog` + `aria-expanded`），
  不动现有 ▣/◐/⟳ 的位置；`cfgOpen` 留在 `TopBar`（组件内 state，不落 prefs）；
- 窗口 `.tw-cfg{position:fixed;z-index:1180;…}`（高于 `.tw-menu` 1150 / `.tw-suggest` 1100，低于 `.tw-mask` 1200）；
  **打开时隐藏悬浮卡**（`.tw-pop` 是 9999，会盖住窗口）—— 在 TopBar 里用 `!cfgOpen` 直接门控；
- **真焦点陷阱**（Lead 裁决③）：`role="dialog" aria-modal="true" aria-labelledby`；打开即聚焦首个控件；
  `Tab/Shift+Tab` 在窗内**循环**（首尾相接，焦点被拖出窗外也拉回）；`Esc` 关闭并把焦点**还给齿轮**；
- **拖动**：只有头 `.tw-cfg-h` 是把手（`cursor:move;touch-action:none`），`onPointerDown` → `setPointerCapture`，
  `pointermove` 更新 `left/top` 并 clamp 到 `[8, vw−w−8]×[8, vh−h−8]`，`pointerup`/`lostpointercapture` 结束，`resize` 后重新 clamp；
- 内容：标题 + `×`、`全选/反选/恢复默认`、4 个组（A股指数 6 / 国际市场 9 / 大宗商品 8 / 国债 5）、组头 checkbox（含 indeterminate）、
  组内两列 checkbox（`minmax(140px,1fr)`、区高 220px 内滚动）、底部 `已选 N/M`（走 `.tw-cfg-count` = 数字面）；
  整组全隐藏 ⇒ **不渲染空组头**；**不做调序**（设计结论：顺序进两端共享的 `TW_ROWS`，两个真相源会打架）。

### 配置向后兼容（已断言）
- `prefs.stripCfg = { hidden: string[] }` —— **存隐藏集合**：老 profile 缺键 ⇒ `hidden=[]` ⇒ 全部可见，
  **将来新增的卡片默认可见**；`effectiveHidden` 过滤未知 secid（装载宽容）✓；
- `全选` / `恢复默认` = `hidden: []`；`反选` = 把当前可见的全部隐藏 ✓。

## 断言与门禁

```
src/host/tones.test.ts     9 条：五档词表与边界（10/30/70/90）、满样本五档各一例、窗口降级（250→120→60）、
                                 样本不足与基准不足都返回 null + 原因、**收益率取负对照**、纯函数边界、
                                 空序列 ⇒ 无 badge、**按日 memo（第二次不再拉）**、取不到 ⇒ transient
src/client/stripTone.test.ts 6 条：五档 badge 视图、缺失/样本不足 ⇒ 无 badge 且不含"适中"、
                                 收益率类型写进口径、**老 profile 缺键 ⇒ 全可见**、整组隐藏不渲染空组头、
                                 组/卡开关与反选 + 已选计数
```
测试总数：**263 → 278**（+9 宿主 +6 客户端）；`npm run check` 全绿（278 × 2 时区、75 项片段、`build.mjs` **零改动**）；
`selftest` 的"预设标的数"断言随国债组从 23 更新为 **28**（6+9+8+5，与设计文档的分组数量一致），并注明四个 `171.*` 故意无兜底。

## 未做项与原因

1. **调序**：设计结论与 Lead 一致 —— 不做（两个真相源 + 与"窗口可拖动"手势冲突 + 固定格子更利于扫读）。
2. **窗口位置不落 prefs**：按设计（跨会话恢复一个飘在半空的窗口会出现在意外位置）。
3. **五国收益率的"可得性复核"**：本机东财三台行情主机整窗不可达（调研已实测），**没有探活**；
   四国卡按红线显示 `—` + 原因，待东财恢复后由同一路由自动可用。
4. **`tones` 路由的 agent 工具**：本批只做界面用的 HTTP 路由，未加 `tradewatcher_*` 工具（任务未要求）。

## 需装机复核（无浏览器，**未做视觉验证**）

1. **卡片尺寸逐像素不变**（1420px 面板下截图叠加比对）、badge 不压价格/涨跌行、延迟绿点左移观感；
2. badge 在**深/浅主题**与**极窄面板**（<520px）下的观感与对比度；**色盲可辨性**（档位词本身可辨）；
3. 配置窗：齿轮 → `Tab` 走完所有 checkbox 且焦点环可见、`Space` 生效、`Esc` 关闭且焦点回齿轮、拖到四角被 clamp、
   窗口打开时悬停卡片**不出现**悬浮卡；
4. 隐身档：`已选 N/M` 与 badge 的**数字**不可读、悬停配置窗时显形；
5. 五档档位在真实行情下的稳定性（每日一档、盘中不抖动）。

---

## 追加（task-40）：P0 修复 —— 配置无法落盘（宿主白名单漏 `stripCfg`）

**结论**：不通过的那条 P0 成立，已修；另有**一处验收命令本身的假象**需要说明（见 §3）。

### 1. 根因与修法

`src/host/store.ts` 的 `setPrefs` 是**逐字段白名单**（theme/costBasis/refreshSec/redUp/panelOpacity/blurDigits/trendArchive/fxMode/fxRates/viewMode/watchSort/portSort/rescue），
**没有 `stripCfg` 分支** ⇒ 客户端发来的 `{stripCfg:{hidden:[…]}}` 被静默丢弃；而客户端是**乐观更新 + `.catch(()=>undefined)`**
⇒ 当次会话看起来完全正常、刷新/重启后配置全丢，全程无提示。已修三处：

1. `setPrefs` 补分支（对齐既有"宽容归一"风格，不抛错）：
```ts
// 行情卡片配置：**存隐藏集合**。宽容过滤（非数组⇒空、混入非字符串丢掉、去重、上界 400）
if (patch.stripCfg !== undefined) this.prefs.stripCfg = normalizeStripCfg(patch.stripCfg)
```
2. 新增 `export function normalizeStripCfg(raw: unknown): { hidden: string[] }`：非数组 ⇒ 空；只留**非空字符串**；去重；上界 400。
3. **装载路径**两处 prefs 组装各加一行 `stripCfg: normalizeStripCfg(loaded.stripCfg)` —— 手改坏的 `prefs.json` 不让启动失败。

### 2. 回归断言（3 条，加在 `src/host/store.test.ts`）—— 且证明"修前会失败"

```
✔ P0 回归：stripCfg 必须真的落盘（写入 → new DataStore 重新装载 → 读回一致）   ← 跨实例，抓的就是这次的 bug
✔ P0 回归：非法输入被过滤去重（非数组 ⇒ 空；混入非字符串丢掉；重复项只留一个；上界 400）
✔ P0 回归：缺 stripCfg 的老 profile 读回默认（全可见；坏值也不让启动失败）
```

**修前证据**（把那一行分支**临时注释掉**跑一次，随后已恢复）：
```
✖ P0 回归：stripCfg 必须真的落盘（写入 → new DataStore 重新装载 → 读回一致）
  AssertionError [ERR_ASSERTION]: setPrefs 返回值应含新值
    actual: { hidden: [] },
    expected: { hidden: [ '1.000001', '171.US10Y' ] },
✖ P0 回归：非法输入被过滤去重 …（同样失败）
（恢复分支后：tests 4 / pass 4 / fail 0）
```
即：这条断言**确实**能抓到"白名单缺分支"这类静默丢失，而不是只测内存行为。

### 3. ⚠ 验收命令本身的一个假象（必须说明，否则会误导下一轮）

验证员给的命令是 `new DataStore(dir).getPrefs()`。`getPrefs()` 是**同步**的、且只在 `init()` 之后才返回磁盘内容
（未 init 的新实例返回的是 `{...DEFAULT_PREFS}`）⇒ **无论有没有这个 bug，那条命令都会打印 `{"hidden":[]}`**，
它证明不了修复。我按同一命令**补上 `await b.init()`** 后实测：

```
$ node --experimental-strip-types -e "… await s.init(); await s.setPrefs({stripCfg:{hidden:['1.000001']}}); const b=new DataStore('/tmp/st'); await b.init(); console.log('读回 =', JSON.stringify(b.getPrefs().stripCfg))"
读回 = {"hidden":["1.000001"]}
```
（`/tmp/st/prefs.json` 里也确实写进了 `"stripCfg": {"hidden": ["1.000001"]}` ✓。）
"修前确实读不回"的证据以 §2 的断言失败输出为准 —— 那是跨实例、且刻意在修前后各跑了一次的。

### 4. 客户端防线（只改这一处）

`client/index.tsx` 的 `setPrefs`：保存失败时**回滚本地乐观状态**并提示一次：
```ts
const before = prefs ?? DEFAULT_PREFS
setPrefsState((prev) => ({ ...(prev ?? DEFAULT_PREFS), ...patch }))
void api.setPrefs(patch).catch((err) => { setPrefsState(before); toast.show(`偏好保存失败（已回滚本次修改）：…`) })
```
理由与取舍：宁可回到一个**确定存在的旧配置**，也不要留一个"看起来生效其实没落盘"的状态；连续多次写入后同时失败可能回滚到偏旧值，这是有意的取舍（注释里写明）。

### 5. 顺带做完的两条 P3
- `tonesService.computeTones` 的行序改用**索引 Map**（去掉 `sort` 里的 `findIndex`，与 `ytd.ts` 同写法）；
- `missing[].what` 改为**纯 secid**（与行情契约一致），原因仍在 `note`。

### 6. 关于"横盘 ⇒ 适中"的口径更正（确认实现）

你指出那条描述不成立（分位法是"相对自身历史的位置"，横盘序列的档位本就该散开）。**实现不需要改**，
我补了一条断言把这一点固定下来：40 条不同种子的噪声序列里 **有过半数落「适中」且至少出现 3 个不同档位**（不是永远极端、也不集中于单一档）。
```
✔ 噪声序列的档位分布：能落「适中」且不集中于单一档（确认验收口径的更正）
```

### 测试与门禁
测试总数 **278 → 282**（+3 P0 回归 +1 分布确认）；`npm run check` 全绿（282 × 2 时区、75 项片段、`build.mjs` 零改动）。
