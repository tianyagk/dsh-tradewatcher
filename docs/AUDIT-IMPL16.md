# 筹码分布 + 详情不可用 icon 简化（task-59）· 实现记录

对象：`dsh-tradewatcher` v0.44.0 工作区。基线 344 条。
末次 `npm run check`：**359 条 × 2 时区全绿**、`ALL HOST CHECKS PASSED (live probes soft)`、
`built lib/index.js + lib/client.js（v0.44.0，客户端片段校验通过：75 项）` ⇒ **`build.mjs` 零改动**。
不装 bundle、不动 profile、不 commit、不重启；**未改 `src/index.ts` 的行映射**（筹码是 core 能力）。

## 0. 递推口径（用户最新拍定版，已按此实现）

```
chips_t = chips_{t-1} × max(0, 1 − t_t × k) + new_t
t_t     = 当日换手率 = 当日成交额 ÷ 流通市值（等价于 成交量 ÷ 流通股本；我们拿不到股数但拿得到流通市值）
          实际用 min(t_t, cap)，cap = 0.25（防异常值）
k       = 衰减系数，默认 1.5，范围 [0.5, 3.0]（越大越强调近期筹码；>1 时旧筹码衰减更快）
new_t   = 当日新增筹码权重（= 该日换手率），按形状铺到当日 [low, high]
形状    = 三角形（默认，峰在当日均价 (high+low+close)/3，向两端线性递减）｜均匀
首日    = chips_1 = new_1
```
`1 − t_t×k` **可能为负** ⇒ 用 `max(0, …)` 夹住（旧筹码全清），且**口径字符串里写明**"出现过夹取 + 实际最小生效因子"。
不变项：前复权（`fqt=1`）、45 根、32 桶、边界线性分摊、P5/P95 支撑压力、`N<10` 样本不足、指数/期货不提供模块。

## 1. 第 1 段：宿主计算层（`src/host/chips.ts`，纯函数）+ 路由

- `chipSeriesOf(bars, opts)` → 逐日分布 + `avgCost/support/resistance/profitRatio/samples/window/decay/decayReason/methodology`。
- 口径字符串（`methodology`）**与算法同源**，逐项写明：递推式、`t_t` 的定义与 `cap`、`k`、形状与均价定义、
  夹取情况与实际最小生效因子、窗口是 45 根还是"近 N 根"、桶数与分摊、P5/P95 与盈利比例的定义。
- 新增 **`GET /tradewatcher/chips?secid=&days=45`**（core 路由）：沿用既有读契约
  （`asOf/stale/source/missing[]`，`why` 用四态词表）；`floatMv`/现价来自**同一次行情缓存**，日线走 `fetchKline(…,1)`。
- 归一函数 `normalizeChipPrefs` + prefs（`chipsDecay` 默认 1.5、`chipsSpread` 默认 `triangle`）：
  **老 profile 缺键 ⇒ 默认**；非法值（负数/超范围/未知形状）⇒ 回落默认并**如实记录 notes**（不静默）；装载路径同样收敛。

### 手算对照（断言里逐位比对，程序输出与手写递推一致）
自造 3 根、`high=low=close`（区间退化成一点，三角形=单点，便于手算），`floatMv = 1e7`：
```
成交额 = vol×100×close = 100×100×10/20/30 ⇒ t_1=0.01, t_2=0.02, t_3=0.03
因子 = max(0, 1 − t×k) = 0.985 / 0.970 / 0.955（k=1.5）
chips_1 = [0.01, 0, 0, 0]                       （桶中心 12.5/17.5/22.5/27.5，10 元落第 1 桶）
chips_2 = chips_1×0.970 + [0, 0.02, 0, 0]
chips_3 = chips_2×0.955 + [0, 0, 0, 0.03]
逐位与 chipSeriesOf 的 `buckets` 相等（断言）；平均成本 = Σ(桶价×归一权重) 也逐位对齐
```
其余四组断言（全部通过）：极端换手 `t×k>1` ⇒ 因子夹到 0、无负权重、`methodology` 写明生效值；
两种形状**总权重相等**（守恒）且三角峰落在均价附近（±桶宽内）、均匀两端相等；
默认值/缺键/非法值回落并记录；`k` 1.0 → 2.0 时**近期筹码占比单调上升**。

## 2. 第 2 段：客户端 UI（可折叠 + 日期滑杆 + 口径控件）

- `QuoteDrawer.tsx`：`chartBody()` **之后**加 `ChipsPanel`（`max-height:160px`、**默认展开**、可折叠）；
  内含横向分布条（**获利/套牢走 `dirClass`**，跟随 `prefs.redUp`，不写死红绿）、四个数字
  （平均成本/支撑/压力/盈利比例）、**日期滑杆在分布图上方**（`clampIndex` 收敛 0 / N−1 / 越界；空序列不渲染）。
- **五日档隐藏**并给一行原因；`fqSupported=false`（指数/期货/板块）⇒ 宿主不给模块 ⇒ 一行原因；样本不足同理。
- 口径控件（复用 K 线复权段控那种"常驻一行 + tooltip"形态，不新增长条）：口径行形如
  `换手率衰减 k=1.5 · 三角形分布 · 近 45 日`，右侧两个小选择框（k、形状）⇒ 写入 prefs 并重取；
  tooltip 补一句"k 越大越强调近期筹码（>1 时旧筹码衰减更快）"，并带完整 `methodology` 与合规文案。
- 合规：筹码容器与数字（`.tw-chips-nums/.tw-chips-date/.tw-chips-bar`）已登记进 `styles.ts` **两条** `data-blur=1` 清单，
  悬停显形列表加了 `.tw-chips`；长解释在 `title`/`aria-label`，常驻只留一行。

## 3. 第 3 段：详情不可用 ⇒ 右上角小圆形 icon

- 新 `NoteIcon.tsx`：**有重试动作时用原生 `<button>`**（天然可聚焦、回车/空格即点击，另显式补 keydown 便于断言）；
  没有重试动作时用可聚焦 `span` + `role="note"`；`title` 给完整详情、`aria-label` 是含原因的完整句子。
- `QuoteDrawer.tsx` 的**四个变体**（限流 / no-source / 图表取数失败 / unavailable）统一成同一形态：
  点击 = **同一个 `setRetry` 自增**；旧的「⚠ …」长条与「重试」按钮**不再渲染**（断言钉住）。
- 断言：`type:'button'` + `onKeyDown`(Enter/Space) + `role:'note'`+`tabIndex:0` + `aria-label` + ≥3 处 `NoteIcon` +
  旧文案消失 + 旧 `Btn onClick: setRetry` 消失 + ≥3 处 `onRetry: () => setRetry(x => x+1)`。

## 4. 测试与门禁
```
344 → 359（+11 筹码：手算递推/夹取/形状守恒/defaults/prefs 归一/k 语义/边界/degrade…；+4 UI：icon 契约、滑杆边界、区块三态、blur 登记）
npm run check：359 × 2 时区全绿；75 项片段校验通过；build.mjs 零改动
```

## 5. 未做项与原因
1. **港股的"换手率口径"仍未标定**（研究实测 `amount ÷ (vol×price) ≈ 9926`，单位未知）⇒ 按用户口径**回落固定半衰期 10 日**并在口径行与 `decayReason` 写明原因（本轮不猜单位）。
2. 历史逐日流通市值不可得 ⇒ 用**当前** `floatMv` 近似（口径字符串已写明，这是主口径的已知近似）。
3. 筹码分布未做成独立图表面板（本轮按任务只做抽屉内的可折叠区块）。

## 6. 需装机复核（无浏览器，未做视觉验证）
① 筹码区块在 240px 高抽屉里的观感（160px 上限、分布条 3px 间隔是否看得清）；② 折叠/展开与滑杆的键盘可达性；
③ 口径控件改 k/形状后是否立即重取并刷新口径行；④ 隐身档下筹码数字与分布条是否一起糊、悬停是否显形；
⑤ 右上角 icon 的位置（是否压住标题）与 Tab 焦点环。
