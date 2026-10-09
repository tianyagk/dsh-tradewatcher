# 图表细节卡（跟随光标 / 十字光标）+ 键盘可达（task-28）· 实现记录

对象：`dsh-tradewatcher` v0.36.1 工作区。目标：光标在**分时/五日**与**日/周/月/年 K** 上移动时，
弹出跟随光标的半透明细节卡（券商 App 口径），键盘也能逐点读。

## 1. 模块与接线点

| 位置 | 角色 |
| --- | --- |
| `src/client/chartCursor.ts`（新，**不 import react**） | `nearestIndex` / `tipPlacement` / `timeCell` / `trendReadout` / `klineReadout` |
| `src/client/kline.tsx` · `TrendChart` | 光标 state、`onMouseMove`/`onMouseLeave`、竖虚线 + 圆点、卡片 DOM、键盘 |
| `src/client/kline.tsx` · `KlineChart` | 同上（K 线档圆点画在**收盘**处） |
| `src/client/QuoteDrawer.tsx` | 两点位补 `amount` 透传（卡片要显示成交额） |
| `src/client/styles.ts` | `.tw-cursorwrap` / `.tw-chart-tip*`；`.tw-chart-tip-v` 登记进 **两条** `data-blur=1` 清单 |

**只更新不重建**：光标只进 `useState`，图表的数据 memo（路径、MA/MACD、轴）**不依赖光标** ⇒ 鼠标移动不会重算整图。

**键盘**（与既有平移共存，规则写死并进 `title`）：
未显示卡片时 `←/→` = 平移（原行为，含 Shift 加速）；`Enter`/`Space` = 在窗口右端显示卡片；
**显示卡片后** `←/→` = 移动光标（窗口随之滚动，光标不会跑出可视区）；`Esc` = 隐藏。
`title` 保留片段表锁定的短语 `键盘：←/→ 平移`（仅在其后追加说明，**build.mjs 未改**）。

## 2. 卡片行清单

**分时 / 五日**（`trendReadout`）：时间 · 价格 · 涨跌幅 · MACD · DIF · DEA · 均价 · 成交量 · 成交额。
**日/周/月/年 K**（`klineReadout`）：时间 · 收盘 · 涨跌幅 · 开盘 · 最高 · 最低 · MA5/10/30/60 · DIF · DEA · MACD · 成交量 · 成交额。

| 行 | 缺失时的表现 |
| --- | --- |
| 涨跌幅（分时） | 无昨收（基准不可用）⇒ `—`（**不是 0.00%**） |
| 涨跌幅（K 线） | 第一根没有前收盘 ⇒ `—` |
| 均价 | 不可用（`null`/`0`/越界非价格量）⇒ `—` |
| MA5/10/30/60 | 序列未成熟 ⇒ `—` |
| 成交量 / 成交额 | 该源没给 ⇒ `—`（体积用 `fmtBig`，金额用 `fmtAmt`；金额受隐身档遮罩） |
| 时间（五日档） | **必须带日期** `MM-DD HH:mm`（单日档 `HH:mm`） |

**同源红线**：MA 与 MACD **不由卡片计算** —— 调用方把图上那份 `mas`/`macd` 传进来（同一个 memo 的结果），
避免"图上 MA5=37.5、卡片写 38.1"。

**口径不重复**：复权/不复权那行仍只在图上；卡片不写。**「至今涨幅」不做**（见 §5）。

## 3. 实现取舍

- `nearestIndex(px, xs, padX, innerW)`：`xs` 是**当前轴的归一化坐标**（0~1），因此三种轴一套实现 ——
  时段网格档传 `ax.xs`、压缩轴档传 `eff/span`、K 线档传"可见窗口内每根柱的中心" `(k+0.5)/count`。
  约定：空数组或图宽无效 ⇒ `null`（调用方不画卡片）；单点 ⇒ `0`；**越界像素夹到两端**（永不返回 -1 / length）。
  逐点线性扫描（点数最多几百）而不是二分：轴上 `xs` 在时段网格档**不是严格单调**也可以工作（午休折线处会重复），
  这是选线性扫描而非二分的关键理由。
- `tipPlacement`：默认光标右侧 12px；`cursorX + gap + tipW > plotW` ⇒ 翻到左侧（`flipped` 回传，便于调整内边距）；
  纵向以光标为中心，越界收进图内；**图比卡片还小时夹到 0**（宁可压住图，也不把卡片丢到图外）。
  卡片尺寸用常量 `TIP_W = 152` 与 `tipHeightOf(lines) = 14 + 16×行数`（与 CSS 的 `line-height:16px` 对齐）。
- 卡片定位用**数据点**的坐标（`xAt(i)` / `yOf(value)`）而不是鼠标原始坐标：卡片跟着点走，不会在两点之间抖动。

## 4. 断言实测（`src/client/chartCursor.test.ts`，9 条全绿）

```
✔ nearestIndex：两端 / 中点 / 越界 / 空 / 单点都有确定行为
✔ nearestIndex：两种轴（时段网格 xs 与压缩轴 eff/span）都能用（含"右侧留白区吸到最后一个点"）
✔ tipPlacement：默认右侧、靠右翻左、上下收进图内（四角）
✔ tipPlacement：图比卡片还小 ⇒ 夹到 0
✔ timeCell：五日档必须带日期（否则 09:35 会被读成今天）
✔ trendReadout：缺失一律 —（无昨收 / 无均价 / 无成交额都不许写 0）
✔ trendReadout：五日档时间列带日期；MACD 行取自传入的同一份系列
✔ klineReadout：MA/MACD 与传入序列同源（图上与卡片不许各算一套）
✔ klineReadout：首根无前收盘 ⇒ 涨跌幅 —；MA/量额缺失 ⇒ —
```

测试总数 **243 → 252**（+9）。`npm run check`：252 × 2 时区全绿、75 项片段校验通过、
`built lib/index.js + lib/client.js （v0.36.1）`。

## 5. 没做的项及原因

- **「至今涨幅」（YTD）不进卡片**：参考图里有，但当前图表数据里没有 YTD（它走 `/tradewatcher/ytd` 的独立链路与日 memo），
  要 join 进逐点数据得改数据装配与缓存口径 —— 属独立任务，本批不做。
- **不做鼠标拖拽平移 / 框选**：本轮只做"跟随光标的细节卡"，平移仍是滚轮 + 键盘。
- **触屏**：`touchstart` 未接（未在需求内，且无实机可验）。

## 6. 需装机复核（无浏览器，**未做视觉验证**）

1. 鼠标跟随是否顺畅、卡片是否遮挡关键数据；
2. **右侧翻边**：光标贴近右边界时卡片翻到左侧、贴上下边界时收进图内；
3. **五日档时间列**是否显示 `MM-DD HH:mm`（而不是只有时刻）；
4. 键盘：`Enter` 显示卡片、`←/→` 移动光标且窗口跟随滚动、`Esc` 隐藏；`Shift+←/→` 的步长；
5. **隐身档**：`.tw-chart-tip-v` 是否被一起模糊、悬停是否显形；卡片内金额是否显示遮罩；
6. 卡片是 `pointer-events:none` —— 确认它不会挡住滚轮缩放与 B/S 标记的悬停。
