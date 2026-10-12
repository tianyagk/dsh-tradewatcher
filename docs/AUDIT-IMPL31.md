# AUDIT-IMPL31 —— 筹码模块下方死空白（两窗格铺满 body）+ 横向柱连续性（乙：柱 + 连接轮廓）

- 基线：`main` @ `55e7d37`（v0.54.0，含上一轮的宽度契约与 `CHART_CONTROLS_PX`），`npm run check` = 402 × 2 时区全绿
- 本轮结果：**405 × 2 时区全绿**（+3 条断言），`build.mjs` **零改动**，未 commit / 未装 bundle / 未动 profile / 未重启
- 方法：真组件标记 + 真 CSS + **真接口数据**（`127.0.0.1:3080/tradewatcher/chips`）在无头 Chromium 里量；
  两处都做了**浏览器级/代码级反例注入**；并**截图目视核对**（`Page.captureScreenshot`）
- 红线遵守：**没有**任何平滑/归一化（桶数仍固定 96、权重和守恒）；轮廓只加一条**没有任何 UI 文案**的折线

---

## ① 筹码模块下方大片空白 —— 空白属于 **body**，且筹码块被两处 `max-height` 钉死

### 1.1 高度账（Chromium 实测，抽屉 592px；真组件标记 + 真 CSS）

| 项 | 高度 | 来源（`文件:行号`） |
|---|---|---|
| 抽屉 head | 64.50 | `styles.ts:386` `.tw-drawer-head{padding:12px 14px 10px;flex:none}` |
| 页签行 | 43.00 | `styles.ts:188` `.tw-tabs{padding:7px 10px;...}` + `.tw-tab{min-height:30px}` |
| 抽屉 foot | 31.50 | `styles.ts:389` `.tw-drawer-foot{padding:7px 14px}` |
| **body clientHeight** | **453.00** | = 592 − 139；`styles.ts:388` `.tw-drawer-body{flex:1;overflow:auto;padding:10px 12px 8px}` |
| body 内容盒 | 435.00 | 453 − 18（上下内边距 10+8） |
| 口径行 `.tw-caliber` | 25.75 | `styles.ts:102` |
| **两窗格容器 `.tw-panes`** | **385.00** | 435 − 25.75 − 16.5 − 8（底栏与其外边距） |
| ├ 上窗 `.tw-chart-pane` | 239.00 | = `split.top`（`QuoteDrawer.tsx` 内联 `height`） |
| ├ 分割线 `.tw-split` | 9.00 | `styles.ts:443` |
| └ 筹码块 `.tw-chips` | 130.75 | = 两窗格剩余（`flex:1 1 auto`）+ 上距 6px |
| 底栏说明 `.tw-chartnote` | 16.50（+ 外距 8） | `styles.ts:369` |
| **空白** | **−0.25 px** | = 435 − (25.75 + 385 + 16.5 + 8)；−0.25 是 `clientHeight` 取整误差 ⇒ **空白 0** |

**空白归属（回答题面）**：空白的**归属是 `.tw-drawer-body` 自身的余量**，不是筹码块内部
—— 因为 body 里**只有筹码块可伸缩**，而它被 `styles.ts:469/472` 的
`.tw-chips-body{max-height:160px}` 与 `.tw-chips-chart{max-height:140px}` 钉死在 ~184px：

```
空白(旧) = bodyClientHeight − 18 − 25.75 − round(0.62×bodyClientHeight) − 9 − 184 − 16.5 − 14
         = 0.38 × bodyClientHeight − 267.25     （默认分区比例 0.62）
```

- 抽屉 ≤ ~842px 时这个值是负数 ⇒ 旧实现表现为**内容溢出、body 出现滚动条**（实测 bodyScrollHeight 534 > 453）
- 抽屉更高时才是**真的空白**：例如 ~1000px 抽屉（bodyClient ≈ 861）⇒ 约 **60px** 空白；
  若分区比例被拖到 0.25（用户很可能拖过），同一抽屉下空白 = `861 − 482.25` ≈ **379px**
  —— 与用户截图里"筹码块约 250px、下方约 340px 全空"同一量级（同一模型，见 1.4 的复算）。

### 1.2 附带的第二个缺陷（同一病根，实测抓到）

旧实现把行高按 `maxBottom = split.bottom`（意图高度 172）算，而绘图区实际只有 **86px**
（被 `max-height:140px` 钉住）⇒ 21 行占 168px，**末 12 行被 `overflow:hidden` 静默裁掉**，
`chartScrollHeight (55) ≠ chartClientHeight (86)` 的错配就是这么来的 —— 正是用户看到"可见柱只有 3–4 根"的一半原因。

### 1.3 修法（确定性铺满）

```diff
// src/client/styles.ts
-.tw-drawer-body{flex:1;overflow:auto;padding:10px 12px 8px}
+.tw-drawer-body{flex:1;overflow:auto;padding:10px 12px 8px;display:flex;flex-direction:column;min-height:0}
+.tw-panes{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}   /* 新增：两窗格共用空间 */
-.tw-chips{border-top:1px solid var(--tw-border);margin-top:6px;padding:4px 2px 2px}
+.tw-chips{...;flex:1 1 auto;min-height:0;display:flex;flex-direction:column}   /* 唯一伸缩项 */
+.tw-chips-collapsed{flex:none}                                                 /* 折叠态不占位 */
-.tw-chips-body{max-height:160px;...}
+.tw-chips-body{...;flex:1 1 auto;min-height:0}                                 /* 去掉 max-height */
-.tw-chips-chart{...;max-height:140px;overflow:hidden}
+.tw-chips-chart{...;overflow:hidden;flex:1 1 auto;min-height:0}                /* 去掉 max-height */
// src/client/QuoteDrawer.tsx
+const panesRef = useRef<HTMLDivElement|null>(null)      // 可用高度改量**两窗格容器**
+React.createElement('div', { ref: panesRef, className: 'tw-panes' }, 上窗, 分割线, ChipsPanel)
+const chipsBlockH = max(0, avail − split.top − SPLIT_HIT_PX − CHIPS_MARGIN_TOP_PX)
+<ChipsPanel maxBottom={chipsBlockH} …/>                 // 传**真实**筹码块高度（不再传 split.bottom）
// src/client/ChipsPanel.tsx
+const plotH = chipsPlotHeightOf({ blockPx: props.maxBottom, hasSlider, extraLines })
+const rowsLayout = chipsRowsLayoutOf(plotH, rows, CHIPS_ROW_GAP_PX)   // 行高由**真实**高度算 ⇒ 行必装得下
```

关键点：**可用高度必须量 `.tw-panes` 而不是 `.tw-drawer-body`** —— body 里还有口径行/底栏/外边距
（实测 65.25px）不归两窗格用，按 body 高度算分割比会让两窗格之和多出这 65px（旧实现正是如此）。
折叠态（`chipsOpen === false`）走上窗 `flex:1 1 auto` + 筹码块 `flex:none`，剩余高度归上窗，同样不留空白。

### 1.4 修后实测（真组件 + 真 CSS + 真数据）

| 抽屉高 | 两窗格 | 上窗 | 分割线 | 筹码块 | 空白 | body 溢出 | 绘图区 | 行高 |
|---|---|---|---|---|---|---|---|---|
| 384 | 177 | 57 | 9 | 104.75 | **−0.25** | 0 | 6.5 | 0.00（退化：窗口太矮） |
| 512 | 305 | 185 | 9 | 104.75 | **−0.25** | 0 | 6.5 | 0.00 |
| 592 | 385 | 239 | 9 | 130.75 | **−0.25** | 0 | 32.5 | 0.61 |
| 720 | 513 | 318 | 9 | 179.75 | **−0.25** | 0 | 81.5 | 2.94 |

分区比例扫描（抽屉 592px，用户很可能把比例拖到 0.25）：

| 比例 | 上窗 | 筹码块 | 绘图区 | 行高 | 空白 |
|---|---|---|---|---|---|
| 0.25 | 160 | 209.75 | 111.5 | 4.36 | **0** |
| 0.35 | 160 | 209.75 | 111.5 | 4.36 | **0** |
| 0.50 | 193 | 176.75 | 78.5 | 2.80 | **0** |
| 0.62 | 239 | 130.75 | 32.5 | 0.61 | **0** |

⇒ 用户场景（低比例 + 高窗口）下筹码块现在拿到 **210–274px**（旧实现是钉死的 184px + 下方 379px 空白），
且**空白恒为 0**。截图目视核对：抽屉底部不再有空区，底栏说明紧接筹码块（`/tmp/twharness/drawer-592.png`）。

### 1.5 断言与反例证据

- 断言 1（读**真 CSS 文本**）：`.tw-chips` 必须含 `flex:1 1 auto` 且 `min-height:0`；`.tw-chips-body` / `.tw-chips-chart`
  **不许**出现 `max-height`；`.tw-panes` 必须 `flex:1 1 auto`；`.tw-drawer-body` 必须 `display:flex`；
  `.tw-chips-collapsed` 必须 `flex:none`；`.tw-chart-pane` 必须 `flex:none`
- 断言 2（结构）：抽屉必须存在 `panesRef` 且**可用高度量它**（正则要求 `panesRef.current … setAvail(el.clientHeight)`），
  **不许**再量 `containerRef` 算分割比；必须 `maxBottom: chipsBlockH`，**不许** `maxBottom: split.bottom`
- 断言 3（数值，纯函数 `drawerFillOf`）：抽屉 384/512/592/720/900/1080 ⇒ `blank === 0` 且
  `chips === panes − top − split − margin`
- **反例注入**：把筹码块钉在旧上限 184px ⇒ 计算出的空白在 900/1080px 抽屉下 **> 0**
  （实测 900px ⇒ 45.9px、1080px ⇒ 114.3px），`assert.throws` 证明"空白 == 0"这条断言在反例上**必然失败**

---

## ② 横向柱连续性差 —— 选**乙**（柱 + 连接轮廓），并把镜像 bug 一并修掉

### 2.1 先给数（真实数据，`1.560010` 展示日 2026-10-12，窗口内 21 行）

| 指标 | 实测 |
|---|---|
| 价格轴窗口 | **2.9538 – 3.2272**（覆盖 99.93% 质量，轴外 0.07%） |
| 窗口内行数 | **21** |
| 非零行数 / 占比 | **18 / 85.7%** |
| **最长连续空行段** | **2**（恰好为 0 的桶有 3 个） |
| 单桶峰值 | **44.98%**（轴顶 60% ⇒ 峰值条只占 74.96% 宽度） |
| 条宽 ≥2px 的行 / 占比 | **14 / 66.7%** |
| **最长连续"看不见"行段**（条宽 <2px） | **3** |
| 半质量行数（前 2 桶 = 50% 质量） | **2** |

对照另一真实标的 `600519`：窗口 1182.73–1553.40、**93 行**、非零 **81 / 87.1%**、最长连续空行段 **4**、
条宽 ≥2px 的 81 行（87.1%）。

**因此"空行"不是真的空桶**：数据里非零行占 85.7%。用户看到的"大量空行"是两件事叠加：
1. **末 12 行被裁掉**（§1.2：行高按 172px 算、绘图区只有 86px）⇒ 图与左轴刻度对不上；
2. **重尾分布**：一个桶 44.98%、另几个桶 0.002% ⇒ 后者条宽 0.03px，被 `min-width:1px` 兜成一根发丝 ⇒ 看着像空行。

### 2.2 方案对比（先对比再实现）

| 方案 | 代价 | 结论 |
|---|---|---|
| **甲 自适应桶数** | 桶数不再固定 96，口径要写"当前 N 桶"；且**修不了重尾** —— 合并相邻桶不会让 0.002% 的桶变可见，3 个恰好为 0 的桶合并后仍是 0 | **不采用**（用户拍板不做） |
| **乙 柱 + 连接轮廓**（本轮实现） | 多一条视觉元素；需与三条语义线区分颜色；**不改变任何数据** | **采用**（用户拍板） |
| 丙 跨桶平滑 | 改变数据，必须标注"已平滑" | 不用（红线） |

### 2.3 乙的实现要点（`文件:行号`）

- `chipsView.ts:239` `chipsRowsOf()` —— 行序**价格降序**（顶行 = 最高价，与左轴刻度、三条语义线同向）
- `chipsView.ts` `chipsProfileOf({ widths, rowH, gap, plotH })` —— 顶点 = 各桶柱端：
  `x = widthOf(bucket)`（**与柱宽同一个函数**）、`y = i*(rowH+gap) + rowH/2`（**与柱高同一份 rowH/gap**）；
  **每个桶都出一个顶点，空桶的 `widthOf(0) === 0` ⇒ 折线照实经过 0，不跨过空桶拉直**
- `ChipsPanel.tsx:197-210` —— SVG（`className: 'tw-chips-profile'`，`viewBox="0 0 100 <plotH>"` +
  `preserveAspectRatio:none` + `vectorEffect:non-scaling-stroke`），**无 title / 无 aria-label / 只有 `aria-hidden`**
- `styles.ts` —— `.tw-chips-profile{position:absolute;inset:0;...pointer-events:none}`、
  `.tw-chips-profile-line{fill:none;stroke:var(--tw-chip-profile);stroke-width:1;opacity:.72}`；
  新增 token `--tw-chip-profile:#9aa3b4`（浅）/`#8f98a8`（深）
- 颜色区分：轮廓用**中性灰**，既不是三条语义线的 橙/紫/蓝（`--tw-chip-avg/res/sup`），也不是涨跌红绿（`--tw-up/down`）
- 成本：96 点折线在 render 时构建（无 rAF、无 mousemove 重绘）⇒ **不是每帧重建**

### 2.4 顺带修掉的真 bug：整幅分布**上下镜像**

实测（修前）：顶行（y=0）标题是 **2.95 元**，而左轴顶部刻度是 **3.23**；底行是 3.23 元、左轴底部是 2.95
—— 柱按价格**升序**渲染，而左轴刻度（`bucketCenterTicks(...).reverse()`）与三条语义线
（按 `(hi−price)/(hi−lo)` 定位）都是"价高在上" ⇒ 柱与刻度、与平均成本/支撑/压力线**互相矛盾**。
修后实测：左轴顶部 3.23 ↔ 第一行 3.23 元；底部 2.95 ↔ 最后一行 2.95 元（两个标的都核对过）。

### 2.5 乙**不改变**这些数（关键区别）

| | 数据指标 | 视觉 |
|---|---|---|
| 甲/丙 | 会改变（合并/平滑） | — |
| **乙（本轮）** | **一行不改**：窗口区间、行数 21、非零 18、占比 85.7%、最长空行段 2、权重和 1.000000 全部不变 | **变好**：折线把 21 个柱端连起来，`1px` 发丝与 3 个空桶处也有线经过 ⇒ "最长连续**无任何视觉标记**的行段" 由 3（只数柱）变成 **0**（线经过每一行） |

⇒ 报告里必须写清：**乙 是视觉改善，不是数据变密**。用户看到的"连续"来自一条插值折线，桶值本身仍是原值
（空桶仍是 0，线在这些位置**落到 x=0**，没有被拉直）。

### 2.6 断言与反例证据

- 顶点与柱**同源**：3 个 fixture（真实 21 行 / 稀疏 21 行 / 均匀 96 桶）× 4 个高度，
  逐项断言 `顶点数 === 行数`、`第 i 个顶点的 x === widthOf(第 i 桶)`（**逐个**比）、
  `相邻顶点 y 间距 === rowH + gap`、`行占用 ≤ 绘图区`（装不下时必须 `fits:false` 而不是静默截断）
- **空桶经过 0**：真实数据的 3 个零权重桶 ⇒ `zeroAt === [3, 8, 9]`，且这些顶点的 `x === 0`
- 颜色：`--tw-chip-profile` 的值**不等于**三条语义线的值；规则串里**不含** `--tw-up/down/flat` 与三条线 token
- **用户可见文案**（本轮追加的硬约束）：把 `ChipsPanel.tsx` 去掉注释后，**不许**出现"轮廓/引导/连接线/折线/视觉"；
  轮廓 svg 的 400 字符窗口内**不许**有 `title:`/`'aria-label':`，必须 `'aria-hidden': true`
- **反例注入 ①**：轮廓改成"跳过空桶直接连" ⇒ 顶点数 = 非零行数 18 ≠ 行数 21 ⇒ `assert.throws` 证明失败
- **反例注入 ②**：行序改回升序 ⇒ `asc[0].center !== 左轴顶部刻度` ⇒ 镜像断言失败
- 浏览器实测（真数据）：轮廓顶点 **21**（560010）/ **93**（600519），`title === null`、`ariaLabel === null`，
  可见文案里不含任何轮廓相关字样

---

## 测试条数变化

| | 条数（每时区） |
|---|---|
| 基线 `55e7d37` | 402 |
| 本轮之后 | **405**（+3：① 铺满账、② 轮廓同源/空桶/无文案、② 行序镜像） |

`npm run check` 末尾三行：

```
ℹ tests 405
ℹ pass 405
ℹ fail 0
```

（两次各 405：默认时区 + `TZ=UTC`；随后 `ALL HOST CHECKS PASSED (live probes soft)` 与
`built lib/index.js + lib/client.js （v0.54.0，客户端片段校验通过：75 项）`。）
改动文件：`src/client/{chipsView.ts,ChipsPanel.tsx,styles.ts,QuoteDrawer.tsx,chipsView.test.ts,chipAxis.test.ts}` + 本文件；
`build.mjs` / `package.json` / `cordis.patch.yml` **零改动**（`build.mjs` 锁定的 75 项片段全部保留）。

## 未做项

1. **未调 `SPLIT_DEFAULT`**：抽屉矮（≤ ~500px）时两窗格都不够用（上窗 ~57px、绘图区 ~6px 属退化）。
   取舍工具已经存在（拖分割线 / ↑↓ 键，比例 0.25–0.75），本轮不改默认值。
2. **93 行在矮抽屉下 `fits:false`**：`600519` 的 93 行需要绘图区 ≥93px（抽屉 ≥ ~700px、比例 ≤0.5）。
   装不下时按 1px 画并**如实报** `fits:false`，但界面**没有**新增提示文案（本轮硬约束禁止新增常驻文案）。
3. **轮廓与三条语义线的叠序**：轮廓画在最上层（柱之后），1px/72% 透明度；与右端语义线标签可能交叉 1px，
   视觉可接受，但只在无头 Chromium 里目视核对过，未在真实主题（深色）下逐一看。
4. **未做桶数自适应（甲）与平滑（丙）**：按用户拍板。

## 需要浏览器数值才能定案时

1. `.tw-panes` → **Computed height**（应 = `两窗格可用高度`；同时看 `.tw-chips` 的 computed `flex` 是否为 `1 1 auto`）
2. `.tw-chips-body` → **Computed height**（应 > 160px 且随抽屉高度变化；若仍恒 160 ⇒ 旧 CSS 还在生效）
3. （② 若要核）`.tw-chips-profile-line` → **getAttribute('points')** 的顶点数应等于 `.tw-chips-bar` 的元素个数
