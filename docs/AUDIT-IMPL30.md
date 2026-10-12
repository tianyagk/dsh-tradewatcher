# AUDIT-IMPL30 —— 筹码条列宽度被压（布局病根）+ 日K 图丢失日期范围缩放轴（回归）

- 基线：`main` @ `e89abb2`（v0.53.0），工作区干净，`npm run check` = **400 条 × 2 时区全绿**
- 本轮结果：`npm run check` = **402 条 × 2 时区全绿**（+2 条，本轮新增；改动文件 5 个，`build.mjs` 零改动）
- 方法：**先用真组件渲染 + 真 CSS 在 Chromium 里量几何**，再改；两处都做了浏览器级反例注入
- 未提交（无 `git commit` / `git push`）、未装 bundle、未动 profile、未重启 `dsh web`

---

## ① 筹码横条被压到左侧 —— 病根是"条列宽度不确定"，不是"宽度算错"

### 1.1 结论先给

条宽写的 `86%`（`axis.widthOf(peak) = 85.60533%`）**一直是对的**，浏览器也照百分比渲染。
问题在**分母**：条宽是**条列（`.tw-chips-plot`）内容盒**的百分比，而本轮之前**没有任何一条 CSS 显式规定条列该有多宽**
—— 它靠"`flex` 默认值恰好是 `0 1 auto` + 没有内容"这两件事凑出来，属于**碰巧对**。

> 累计之前的真实观感来源还有一个**单位口径 bug 的历史包袱**（v0.53.0 已修）：`86%` 曾经写在
> 一个由内容决定宽度的容器里 ⇒ 百分比退化成极小的像素数。本轮把"宽度从哪来"**显式写死并锚上断言**，
> 让这类退化不可能再靠默认值蒙过去。

### 1.2 横向三段的宽度账（Chromium 量真组件标记 + 真 CSS）

量法：用**真 `ChipsPanel`** `renderToStaticMarkup` 出标记 + 真 `TW_CSS`，放进复刻抽屉宽度的容器里量。
数据是**真接口数据**（`curl 127.0.0.1:3080/tradewatcher/chips?secid=1.600519`，最后一展示日 2026-10-12，93 行）。

| 段 | 选择器 | 宽度来源（代码位置） | 实测（容器 692px） | 实测（容器 940px） |
|---|---|---|---|---|
| 容器（抽屉内容宽） | `.tw-chips-body` | 块级撑满；`.tw-drawer{width:min(720px,96vw)}` − padding | 692.00 | 912.00 |
| 左轴价格列 | `.tw-chips-axis` | **内容决定**（价格字符串宽）+ `min-width:34px`（`styles.ts:467-468`） | 45.67 | 45.67 |
| 间隙 | `.tw-chips-chart{gap:4px}`（`styles.ts:463`） | 固定 4px | 4.00 | 4.00 |
| **条列** | `.tw-chips-plot` | **修复前**：`flex:0 1 auto`（= flex 默认值，源码里没写）+ 内联 `flex:1`（`ChipsPanel.tsx:129`）；**修复后**：`flex:1 1 auto; min-width:0`（`styles.ts:476`） | **642.33** | **862.33** |
| 语义线标签列 | `.tw-chips-reflabel` | **绝对定位覆盖层**（`styles.ts:480`），`right:0`、宽 43.56px | 43.56 | 43.56 |

**编号回答题面的四问：**

1. **三段宽度各从哪来**：左轴 = 内容 + `min-width:34px`（内容决定，**修复前可被压缩**，因为默认 `flex-shrink:1`）；
   条列 = **`flex:1` 撑满剩余**（修复前只写在内联样式里，CSS 层没有契约）；右标签列 = **绝对定位**，不吃排版宽度。
   `styles.ts:470` 的 `.tw-chips-bars{...flex:1 1 auto;min-width:0}` 是**死规则**（无节点用该 class，已保留并在注释里标明）。
2. **有没有宽度塌陷的祖先**：**没有**。祖先链逐级实测（条列 → 上）：
   `.tw-chips-plot 642.33 → .tw-chips-chart 692 → .tw-chips-body 692 → .tw-chips 696 → 容器 720 → .tw-root 1280`，
   全部 `display:block|flex`、`min-width:0px` 或撑满，**不存在 `width:fit-content` / `display:inline` / 0 宽祖先**。
   （`ChipsPanel.tsx` 与 `QuoteDrawer.tsx` 里也没有 `fit-content`。）
   ⇒ 病根不在祖先，在**条列自己没有宽度契约**。
3. **条宽是否写在"宽度由内容决定"的容器里**：**修复前是**（条列宽度取决于左轴有多宽、以及 flex 默认值）；
   **修复后不是**（`flex:1 1 auto; min-width:0` ⇒ 条列宽度 = 容器 − 左轴 − 间隙，与内容无关）。
4. **右标签列是否挤占条列**：**不挤占**。实测标签 `left=662.44 → right=706`，全部落在容器内（`chartRight=706`），
   与语义线间距 0.44px。它是覆盖层，不进 flex 排版 ⇒ **不需要**从条列宽度里再扣一次（扣了反而与浏览器对不上）。

### 1.3 浏览器级反例注入（决定性证据）

同一页面注入 `style` 覆盖，**条宽的 inline 百分比一模一样（89.0432%）**，只有 flex 变了：

| 注入 | 条列实测宽 | 峰值条实测宽 | inline 宽度 |
|---|---|---|---|
| 无（真实现） | **642.33px** | **571.94px** | `89.0432%` |
| `.tw-chips-plot{flex:none}`（回归写法） | **1px** | **1px** | `89.0432%`（没变） |
| 注入移除后 | 642.33px | 571.94px | `89.0432%` |

⇒ **同一个百分比在两个几何下渲染成 571.94px 与 1px**。这就是"算得对、但看着被压到左侧"的机制。
峰值条核对：`642.33 × 89.0432% = 571.95px`（实测 571.94px，差 0.01px 为取整）。

### 1.4 改动与断言

**改动（`src/client/styles.ts:463-481`）**

- 条列 `.tw-chips-plot`（`styles.ts:476`）：新增 `flex:1 1 auto; min-width:0; overflow-x:hidden`（唯一伸缩项）
- 左轴 `.tw-chips-axis`（`styles.ts:467-468`）：新增 `flex:none`（空间不足时不许被压缩）+ `max-width:60px; overflow-wrap:anywhere`
  （把"价格位数决定轴宽"也钉住，条列宽度不随 `5.47` / `1553.40` 抖动）
- 条列（`.tw-chips-bars`，无节点 `styles.ts:470`）把 `flex:1` 显式写成 `flex:1 1 auto; min-width:0`
- `src/client/chipsView.ts`：新增 `CHIPS_AXIS_MIN_PX`（:157）/ `CHIPS_CHART_GAP_PX` / `CHIPS_LABEL_RESERVE_PX`、
  `chipsColumnsOf()`（:189）、`chipBarPxOf()`（:199）（纯算术，可断言）

**断言（`src/client/chipsView.test.ts`，新增 1 条测试，锚真几何、非自指）**

1. 从 `styles.ts` 的 CSS 文本里**抽出**三个数（`min-width:34px`、`gap:4px`、`right:44px`），并断言它们逐项等于模块常量
2. 契约断言：条列必须含 `flex:1 1 auto` **且** `min-width:0`；左轴必须含 `flex:none`；
   并断言 `.tw-chips-plot{...}` 里**不许**出现 `flex:none`
3. 数值可用性（**两组数，都过**）：
   - 题面几何：容器 940 / 左轴 60 / 右标签 70 ⇒ 条列 810px、轴顶 86% 的条 **696.6px**
   - 本实现 CSS：容器 940 / 左轴 34 / 间隙 4 ⇒ 条列 **902px**、峰值条 **775.72px**
4. 反例注入：条列 `flex:none` ⇒ 条列 0px ⇒ 峰值条 0px
   ⇒ 用 `assert.throws` 证明"条宽 ≥700px"这条断言在反例上**必然失败**（否则它抓不住"被压到左侧"）

### 1.5 仍需浏览器才能定案的（DevTools 两个数）

本地 Chromium 用**真组件 + 真 CSS** 量到的是"抽屉 720px 上限 ⇒ 条列 642.33px"。
页面实际观感若仍不对，请给下面两个数（README 里的老办法：F12 → Elements）：

| # | 元素选择器 | 要读的属性 | 正常值（本地量到的） |
|---|---|---|---|
| 1 | `.tw-chips-plot` | **Computed → width**（顺带看 `flex` 是否为 `1 1 0%`、`min-width` 是否为 `0px`） | 642.33px（抽屉 720px 时）；`flex: 1 1 0%` |
| 2 | 峰值那条 `.tw-chips-bar`（`width` inline 最大的那条） | **Computed → width** | 571.94px（= 条列 × 89.0432%） |

判读：若 **#1 < 600px**（抽屉宽度正常时）⇒ 条列仍被别的东西压住，请一并给 `.tw-chips-chart` 的 computed
`width` 与 `display`；若 **#2 / #1 ≈ inline 百分比**，则渲染层无缺陷，问题只可能在"观感预期"
（条宽是**相对条列**的百分比，不是相对整个面板）。

---

## ② 日K 图丢失日期范围缩放轴 —— 回归提交 `5d11d91`（v0.48.0）

### 2.1 回归提交与 diff 摘要（已确认，非"未确认"）

**提交：`5d11d91` "v0.48.0：切页签不塌图 + 筹码六页签一致 + 上下分区可拖拽分割线"**

`git log -S "tw-chart-pane"` / `git log -S "overflow: 'hidden'"` 都只命中它；`kline.tsx` 在该提交**零改动**
（`git show 5d11d91 --stat -- src/client/kline.tsx` 为空）⇒ 缩放轴**不是被删掉的，是被裁掉的**：

```diff
// src/client/QuoteDrawer.tsx（5d11d91 新增）
+  const kh = klineHeightsOf(split.top)
...
-      <div className="tw-chart-wrap">…chartBody()…</div>        // v0.47.0：无高度约束，缩放轴可见
+      React.createElement('div', { className: 'tw-chart-pane', style: { height: split.top, overflow: 'hidden' } },
+        React.createElement('div', { className: 'tw-chart-wrap' }, chartBody(), …))
// src/client/splitDrag.ts（同提交新增）
+ export const CHART_CHROME = 8 + 6 + 6 + 16                       // 只记 SVG **内部**开销
+ const plot = Math.max(24, Math.round((top - CHART_CHROME - 24)))  // ⇒ SVG 高度 ≈ 上窗高度（控件块 0 预留）
```

**机制**：`klineHeightsOf(top)` 只扣 SVG 内部开销（36）与 x 轴文字（24）⇒ SVG 高度 ≈ 上窗高度；
而 `.tw-kline` 里 SVG **之下**还有均线图例 + 买卖点图例 + **日期范围缩放轴**（实测共 **84.75px**）
⇒ 上窗装不下，`overflow:hidden` 把最底部的缩放轴**整块裁掉**（DOM 里在、屏幕上没有、控制台不报错）。
`kline.tsx` 在该提交零改动（`git show 5d11d91 --stat -- src/client/kline.tsx` 为空）⇒ 是**被裁**，不是被删。

**Chromium 复现（真 `KlineChart` 标记 + 真 CSS，修前）**：上窗 384px、内容 424.75px
⇒ **`trackVisiblePx = 0`**（轨道 16px 全在裁剪线以下）、`barVisible = 0`
⇒ 用户看到的就是"日期范围缩放轴不见了"。

### 2.2 恢复方式（保持动态高度逻辑不变）

**不是**把控件移出、**不是**改成 `overflow:visible`（那样会盖住下面的筹码区），而是**把控件块计入高度账**：

```diff
// src/client/splitDrag.ts
+ /** SVG 之下的控件块高度（含日期范围缩放轴）。Chromium 逐段实测 6/15/4/15/2/36.75 = 84.75 ⇒ 记账 85 */
+ export const CHART_CONTROLS_PX = 6 + 15 + 4 + 15 + 2 + 43
+ // 分项逐段同序，并在模块加载时校验 CONTROL_PARTS_PX === CHART_CONTROLS_PX（不等就 throw）
  export function klineHeightsOf(top: number) {
-   const plot = Math.max(24, Math.round(top - CHART_CHROME - 24))
+   const plot = Math.max(24, Math.round(top - CHART_CHROME - CHART_CONTROLS_PX - 24))
-   return { chartHeight: CHART_CHROME + 24 + mainH + volH + macdH, … }
+   return { chartHeight: CHART_CHROME + 24 + mainH + volH + macdH, … }   // 语义回正：= **SVG 的高度**
  }
+ export function chartGeomOf(top): ChartGeom  // 纵向几何账：content = svg + controls；clipped/overflow/overlap
```

**控件块 85px 的逐段实测（Chromium，真标记 + 真 CSS；`.tw-kline` 各子项的 box 距离）**

| 段 | 实测 | 来源 |
|---|---|---|
| SVG → 均线图例 | 6.00 | `.tw-kline{gap:2px}` + 图例 `margin:'4px 0 0'` |
| 均线图例一块 | 15.00 | 内联 `fontSize:10` |
| 均线图例 → 买卖点图例 | 4.00 | `.tw-kline{gap:2px}` + `margin:'2px 0 0'` |
| 买卖点图例一块 | 15.00 | 有 B/S 文案时实测 15px（无流水时不渲染，仍**恒预留**） |
| 买卖点图例 → 缩放轴 | 2.00 | `.tw-kline{gap:2px}` |
| 缩放轴自己 | 36.75 | `.tw-zoom{margin-top:6px}` + 轨道 16 + 内间隙 5 + 文案行 15.75 |
| **合计** | **84.75** | 记账 **85**（向上取整） |

- 动态高度逻辑**完全保留**：`mainH/volH/macdH` 仍按比例随上窗高度重算（384→153/39/47，700→309/80/94），
  只是分母里多减了 85px 的控件块 ⇒ **不改变 v0.52/v0.53 的任何行为**（缓冲/缓存/页签/复权/筹码都不碰）
- `QuoteDrawer.tsx` **零改动**（`chartHeight = kh.chartHeight` 本就取自 `kh`，自动跟着变）
- `build.mjs` **零改动**（未触碰任何被锁的片段字面量）

### 2.3 修后 Chromium 复测（真标记 + 真 CSS）

| 抽屉可用高 | 上窗 | 含 B/S 标记：内容高 | 轨道可见高 | 手柄 | 快捷区间按钮 |
|---|---|---|---|---|---|
| 1000px | 620 | 595.75（余 24.25） | **16/16px** | 2 | 近1月/近3月/近6月/近1年/全部 |
| 800px | 496 | 471.75（余 24.25） | **16/16px** | 2 | 同上 |
| 620px | 384 | 359.75（余 24.25） | **16/16px** | 2 | 同上 |
| 560px | 347 | 321.75（余 25.25） | **16/16px** | 2 | 同上 |

（无 B/S 标记时余量更大：−43.25px。）⇒ 缩放轴手柄、轨道、5 个按钮**全部在裁剪线以内**。

**代价（如实记账）**：为给控件块腾位置，`mainH` 比修复前小约 **24px**（上窗 384px 时 158→153，
SVG 343→299）。这是"看得见缩放轴"与"绘图区更大"之间的取舍；若要两全，只能调大 `SPLIT_DEFAULT`
（会改分区默认观感）或缩小控件块（会改视觉设计）—— 两者都超出本轮范围，未做。

### 2.4 断言与反例证据

**接线证据（`src/client/kline.tsx`）**

| 证据 | 位置 |
|---|---|
| 控件渲染进图表 | `kline.tsx:826` `React.createElement(RangeSlider, { total: bars.length, range: [s, e], bars, onChange: setRange })` |
| 控件定义 | `kline.tsx:870` `function RangeSlider(...)` |
| 轨道 | `kline.tsx:966-967` `className: 'tw-zoom-track'`（`role:'slider'`、`tabIndex:0`、`aria-valuetext`） |
| 两个手柄 | `kline.tsx:944` `className: 'tw-zoom-h'`（`role:'slider'`、`onPointerDown`、`onKeyDown: keyOf`） |
| 快捷区间 | `kline.tsx:987` `['近1月',30],['近3月',90],['近6月',182],['近1年',365],['全部',null]` |
| 样式 | `styles.ts:347-351`（`.tw-zoom` / `-track` / `-sel` / `-h`）、`styles.ts:368`（`.tw-zoom-bar`） |
| 高度账常量 | `splitDrag.ts:45` `CHART_CONTROLS_PX = (2+4)+15+(2+2)+15+(2+6)+(16+5+16)`；`splitDrag.ts:26` `CHART_CHROME`；几何账 `splitDrag.ts:173` `chartGeomOf()` |

**断言（`src/client/splitDrag.test.ts`，新增 1 条测试）**

1. 上表每一行都进断言（控件在 DOM 里 + `role:'slider'` + `onPointerDown` + `onKeyDown` + 快捷按钮字面量）
2. **高度账逐段从真源码抽数**：`.tw-zoom-track{height}`、`.tw-zoom{gap}`、`.tw-zoom{margin-top}`、
   `.tw-zoom-h{height}`、`.tw-kline{gap}` 用正则从 CSS 文本抽；两块图例的 `margin:'4px 0 0'` / `'2px 0 0'`
   直接在同文件断言 `kline.tsx` 源码字面量；再断言逐段和（6+15+4+15+2+43）= `CHART_CONTROLS_PX` = **85**
   （生产文件里还有一条**模块加载即执行**的自检：分项和 ≠ 常量就 `throw`）
3. **不裁断言**：`chartGeomOf(splitHeights(avail, SPLIT_DEFAULT).top).clipped === false`，
   `avail ∈ {1000, 900, 800, 700, 620, 560, 500}`，且 `content ≤ top`、`zoomBar ≥ 37`
4. 极小上窗（120px）必须**如实**报 `clipped: true`（不假装装得下）
5. 反例注入：`brokenKlineHeightsOf(top) = { ...真实现, chartHeight: +85 }`（= 回归提交的几何）
   ⇒ 用 `assert.throws` 证明"余量 ≥0"这条断言在反例上**必然失败**

---

## 测试条数变化

| | 条数（每时区） |
|---|---|
| 基线 `e89abb2` | **400** |
| 本轮之后 | **402**（+2：`chipsView.test.ts` 的"宽度契约"、`splitDrag.test.ts` 的"日期范围缩放轴"） |

`npm run check` 末尾三行：

```
ℹ tests 402
ℹ pass 402
ℹ fail 0
```

（两次运行各 402：默认时区 + `TZ=UTC`。之后 `selftest` = `ALL HOST CHECKS PASSED`，
`build` = `built lib/index.js + lib/client.js （v0.53.0，客户端片段校验通过：75 项）`。）

改动文件（5 个，全部在 task-1 的写作用域内；`build.mjs` / `package.json` / `cordis.patch.yml` 零改动）：

```
src/client/chipsView.test.ts |  80 +++++++++-
src/client/chipsView.ts      |  55 ++++++++
src/client/splitDrag.test.ts | 124 ++++++++++++++++-----
src/client/splitDrag.ts      |  97 ++++++++++++----
src/client/styles.ts         |  14 ++-
```

---

## 未做项 / 未定案项（如实列出）

1. **未在真实页面（真抽屉 + 真行情）里截图复核**：GUI 需要 `dsh web` 打印的带鉴权 URL（`curl /` 返回 401），
   且重启/接管 `dsh web` 不在本任务范围 ⇒ 改用"真组件标记 + 真 CSS + 真接口数据"的本地 Chromium 量测。
   `output=①.5` 给了两个 DevTools 数值用于人工定案。
2. **未调 `SPLIT_DEFAULT`**：修复后绘图区（`mainH`）比之前小约 24px。若用户觉得图变矮，可再讨论
   "默认分区比例调大"或"压缩控件块高度"（都会改观感设计，需单独决策）。
3. **`charts.tsx` / 顶栏悬浮卡里的 `KlineChart` 调用点未逐一复测**：那些调用点不传 `mainH/volH/macdH`
   （走组件默认 230/54/64），历史行为不变；本轮的 `CHART_CONTROLS_PX` 只影响"由上窗高度算几何"的抽屉路径。
4. **① 的"观感"最终判据**：本地几何显示条列 642.33px、峰值条 571.94px（= 89.04% × 条列），
   与 inline 百分比完全一致。若页面仍觉"压左"，按 ①.5 的两个数定案。
5. **未确认 `min-width:0` 之外是否还有"内容顶宽"风险**：条列内部全是绝对定位元素 + 左对齐的条，
   本轮已加 `overflow-x:hidden` 兜底；未做更长文本/更宽价格的极端截图。
6. **`selftest` 的 soft 警告**：运行环境对 `push2delay.eastmoney.com` 是 connection reset
   （本机网络环境，非本轮改动）；`ALL HOST CHECKS PASSED (live probes soft)` 照旧通过。
