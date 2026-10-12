# AUDIT-IMPL32 —— 删两处提示条（K线区间买卖图例 + 抽屉脚注）并把唯一口径搬进 tooltip

- 基线：`main` @ 上一轮之后（v0.54.0 + task-2 的布局/连续性改动），`npm run check` = 405 × 2 全绿
- 本轮结果：**408 × 2 全绿**（+3 条断言，新增 `src/client/noticeBars.test.ts`）；`build.mjs` **零改动**（75 项片段校验通过）；
  未 commit / 未装 bundle / 未动 profile / 未重启
- 方法：**逐条子信息**判"这话别处有没有"（下表）⇒ 删或搬 tooltip；断言锚真实源码/结构 + 反例注入；
  最后用无头 Chromium 截图目视核对（`/tmp/twharness/drawer-fixed.png`）

---

## 1. 子信息处置表（逐条判定，这是本轮的核心）

### ① 上窗 K 线内：区间买卖图例（`bsLegend`，`kline.tsx` 原 714-733 行）

| 子信息 | 别处是否已有 | 处置 |
|---|---|---|
| `区间内 B 5 笔 / S 1 笔` | 有：持仓页流水（`tradewatcher_ledger`）+ 读屏摘要 `aria-label` | 删（可见） |
| `净买入 60000 份/股` | 有：同上（派生量） | 删（可见） |
| `买入均价 2.933 / 卖出均价 2.946` | 有：持仓页流水的成交明细 | 删（可见） |
| `（区间外另有 N 笔）` | **没有别处**：它依赖**当前缩放窗口**（流水页不知道窗口）⇒ 必须仍可达 | **搬进悬停提示**（图表容器 `title`；读屏摘要 `aria-label` 里本来也有这一句） |
| `区间内无买卖点` | 无别处（但语义与摘要的"区间内没有买卖点"等价） | **搬进悬停提示**（同时它是 `build.mjs` **锁定**片段，见 §4） |

### ② 下窗抽屉脚注（`.tw-chartnote`，`QuoteDrawer.tsx` 原 407-441/600 行）

| 子信息 | 别处是否已有 | 处置 |
|---|---|---|
| `共 240 根` | 有：缩放滑杆行 `2026-01-01 ~ 2026-04-08 · 120/120 根` | 删 |
| `前复权` | 有：页签行的复权段控 + 口径行 `日K · klt 101 · 前复权 · 截至 …（当根已收盘）` | 删 |
| `（详情头为真实成交价）` | **没有别处**（口径说明：图上蜡烛是前复权、B/S 标记价来自流水=真实成交价） | **搬到 B/S 标记的 `title` 与 `aria-label`**（`kline.tsx` 的 `BS_PRICE_CALIBER`） |
| `2025-10-15 ~ 2026-10-12` | 有：同一个滑杆行 + 图上日期轴 | 删 |
| `MA5/10/30/60` | 有：上窗 MA 图例（`MA5 2.99 MA10 3.01 MA30 3.07 MA60 3.04`） | 删 |
| `滚轮或拖动滑块缩放日期区间` | 有：图表容器的 `title`（键盘/滚轮说明，原有文案，未改）+ 控件自证 | 删 |
| `本地缓存` | 是实现细节（命中 TTL，数据本身没变） | **删常驻**；字面量保留在源码里（`build.mjs` 锁定，见 §4） |
| `B 买入 5 笔 / S 卖出 1 笔（来自持仓流水）` | 有：持仓页流水 | 删（`legend` 变量整块删除） |
| **分时档那一行**（`昨收 3.10 · 09:30 ~ 15:00`） | **没有别处**（分时基线口径，P0-5 要求常驻可见） | **保留**（不在用户红框内；红框是日K那一条） |
| `显示上次成功数据（…）` / `非当日数据（…）` / `休市定稿缓存（未回源）` | 属于**降级/陈旧**告知（项目原则：降级必须说明"现在显示的是什么"） | **保留常驻** |

**处置的实现（`可见文案 = 别处没有的那几条`）**：

```diff
// src/client/QuoteDrawer.tsx
-  const buys = trades.filter(…).length; const sells = …; const legend = ` · B 买入 …（来自持仓流水）`
-  note = `共 ${k.days.length} 根${fqNoteOf(k)} · ${first.date} ~ ${last.date} · MA5/10/30/60 · 滚轮或拖动滑块缩放日期区间`
+  // K 线脚注整条删除（逐条已被别处承载）；分时那条保留；来源提示只留会影响判断的
+  const visibleCn = visibleProvenanceOf(cn)
+  if (visibleCn !== '') note = note === '' ? visibleCn.replace(/^ · /, '') : note + visibleCn
// src/client/chartNote.ts（新增纯函数）
+ export function visibleProvenanceOf(cn: string): string {
+   const t = cn.trim()
+   if (t === '' || t === '· 本地缓存') return ''   // 命中 TTL 缓存不占位
+   return cn                                        // 降级/非当日/定稿/带快照的本地缓存 → 照旧可见
+ }
// src/client/kline.tsx
+ const BS_PRICE_CALIBER = '标记价格是真实成交价（详情头为真实成交价；前复权只改图形，不改成交价）'
+ parts.push(BS_PRICE_CALIBER)                       // 进 detailText（标记明细）
+ const buyText = detailText('买入', …)
+ React.createElement('g', { key: `mb${i}`, 'aria-label': buyText }, React.createElement('title', null, buyText), …)
- const bsLegend = React.createElement('div', { className: 'tw-ma-legend', … }, …)   // 可见图例删除
+ const bsHint = [ '区间内 B … / S … 笔' | '区间内无买卖点', '净买入 …', '买入均价 …', '区间外另有 N 笔（缩小日期范围即可看到）' ].join('\n')
+ title: '键盘：←/→ 平移…' + (bsHint === '' ? '' : `\n${bsHint}`)      // 挂到图表容器的 title（悬停可见）
// src/client/chartCache.ts
- export function fqNoteOf(kline) { … ' · 前复权（详情头为真实成交价）' … }   // 唯一调用方（脚注）已删 ⇒ 一并删除，避免两处同义口径漂移
```

**没有任何新增常驻可见文案**：新增的字符串只有两处，都在 tooltip 里（容器 `title` / 标记 `title`+`aria-label`）。

---

## 2. 断言与反例证据（`src/client/noticeBars.test.ts`，新增 3 条）

判据写成一个返回**违规清单**的纯函数 `visibleNoticeViolations(src)`（去注释后再扫），
真源码必须为空；把提示条加回**常驻可见位置**时必须非空 —— 这就是反例注入的证明力来源。

1. **① 图例不再可见 + 锁定字面量原样保留**：断言不再有 `tw-ma-legend` 包裹 `区间内 B`/`区间内无买卖点` 的渲染；
   `bsHint` 存在且挂在容器 `title`；`aria-label: summary` 仍在；两句锁定字面量**一字不改**地保留。
   **反例注入**（把图例加回常驻可见位置）⇒ 判据非空 ⇒ `assert.throws` 证明失败。
2. **② 脚注瘦身 + 分时那条保留 + 来源提示语义**：`legend` 变量与 `MA5/10/30/60`/`滚轮或拖动滑块缩放日期区间`/`来自持仓流水`
   全部不在源码里；`昨收 …` 保留；`visibleProvenanceOf` 的 6 个真实取值逐项断言
   （`· 本地缓存` ⇒ `''`；降级/非当日/定稿/带快照的本地缓存 ⇒ 保留）。
   **反例注入**（脚注加回可见位置）⇒ 判据非空 ⇒ `assert.throws` 证明失败。
3. **③ 唯一口径可达**：`BS_PRICE_CALIBER` 是唯一来源（正文含`详情头为真实成交价`）且 `parts.push` 进标记明细；
   买入/卖出标记**同时**带 `aria-label` 与 `<title>`；抽屉可见文案里**不再**出现该句；`fqNoteOf` 不许再被调用。
   **反例注入**（口径回到可见脚注）⇒ 可行性断言失败（`assert.throws`）。

浏览器实测（真标记 + 真 CSS，`/tmp/twharness/drawer-592` 系列）：
- 可见文本里**没有** `区间内 B` / `净买入` / `买入均价` / `区间内无买卖点` / `区间外另有`（扫描 `.tw-drawer-body` 的叶子文本）
- `.tw-chartnote` 元素**不存在**（K 线档）
- `g[aria-label]` 与 `g > title` 都是：
  `2026-03-05 买入 1 笔 · 合计 100 份/股 · 均价 3.000 · 标记价格是真实成交价（详情头为真实成交价；前复权只改图形，不改成交价）`
- 图表容器 `title` = 键盘说明 + 换行 + `区间内 B 1 笔 / S 0 笔` + 换行 + `净买入 100 份/股`（悬停可达）
- 截图目视：MA 图例行下**直接**是缩放轴；筹码块下**直接**是抽屉底栏（两处提示条都不在了）

---

## 3. 连带改动：`CHART_CONTROLS_PX` 85 → 66（必须改，否则图会被裁）

删掉区间买卖图例后，SVG **之下**的控件块少了一块（15px 图例 + 4px 间距）⇒ 实测 **65.75px**。
`CHART_CONTROLS_PX` 是"给缩放轴留位置"的高度账（v0.54.0 的回归修复依赖它），若仍写 85 就会
**多留 19px**（下窗被压）；本轮改为 **66** 并同步了逐段分项与断言：

| 段 | 来源 | px |
|---|---|---|
| SVG → 均线图例 | `.tw-kline{gap:2px}` + 内联 `margin:'4px 0 0'` | 6 |
| 均线图例一块 | 实测 15px | 15 |
| 均线图例 → 缩放轴 | `.tw-kline{gap:2px}` | 2 |
| 缩放轴自己 | 外距 6 + 轨道 16 + 内间隙 5 + 文案行 16 | 43 |
| | **合计** | **66** |

- 生产代码里有**模块加载即校验**：`CONTROL_PARTS_PX !== CHART_CONTROLS_PX` 直接 `throw`
- 断言同步：`splitDrag.test.ts` 里逐段和必须 = 66；并断言 `kline.tsx` 里**不再**有那段买卖点图例的内联样式
- 浏览器复测：上窗 239→254（592px 抽屉），缩放轴轨道**仍 16/16px 全可见**，筹码块 130.75→140.25

---

## 4. `build.mjs` 锁定片段：**没有改字面量**（按规则停下来报告）

`build.mjs` 的片段表锁定了下列本轮涉及的字符串，**一个字都没改**：

| 锁定片段 | 本轮处置 |
|---|---|
| `区间内无买卖点` | **原样保留**：从可见图例改为**悬停提示**里的同一句（字面量未改） |
| `区间外另有` | **原样保留**：提示里 + 读屏摘要里各一处（字面量未改） |
| `本地缓存` | **原样保留**在 `chartNote.ts`（`cacheNoteOf` 的取值之一）；只是不再常驻显示（`visibleProvenanceOf` 过滤） |
| `休市定稿缓存` / `显示上次成功数据` | 原样保留且**仍然常驻可见** |
| `区间内买入` / `键盘：←/→ 平移` / `前复权` / `后复权` / `不复权` / `不适用` | 未触碰相关代码路径 |

> ⚠ 报告要点：**本轮没有出现"必须改锁定字面量"的情况**，因此没有停手；改为把锁定文案"从常驻可见搬到悬停可见"。
> 若 lead 希望连 tooltip 里也不出现这两句，那就要改 `build.mjs` 的片段表 —— 那是你的范围，我不动。

---

## 测试条数变化

| | 条数（每时区） |
|---|---|
| 基线（task-2 之后） | 405 |
| 本轮之后 | **408**（+3：`noticeBars.test.ts`） |

`npm run check` 末尾三行：

```
ℹ tests 408
ℹ pass 408
ℹ fail 0
```

（两次各 408：默认时区 + `TZ=UTC`；随后 `ALL HOST CHECKS PASSED (live probes soft)` 与
`built lib/index.js + lib/client.js （v0.55.0，客户端片段校验通过：75 项）`。）
改动文件：`src/client/{kline.tsx,QuoteDrawer.tsx,chartCache.ts,chartNote.ts,splitDrag.ts,noticeBars.test.ts,chartCache.test.ts,splitDrag.test.ts}` + 本文件；
`build.mjs` / `package.json` / `cordis.patch.yml` **零改动**。

## 未做项

1. **分时档脚注保留**（`昨收 … · 时段`）：它不在用户红框内，且"别处没有"（P0-5 要求口径常驻）。
   若也要收进 tooltip，说一声 —— 但那样分时基线就只能悬停才看得到。
2. **降级提示仍常驻**（`显示上次成功数据` / `非当日数据` / `休市定稿缓存`）：这是项目原则要求的"诚实标注"，
   本轮只把**命中 TTL 缓存**这一条（数据本身没变）从常驻里去掉。
3. **`fqNoteOf` 已删**（唯一调用方是脚注）⇒ 复权口径现在只有两处可见来源：口径行与复权段控按钮的 `title`。
   若后续还要"复权脚注"这一形态，需要重新引入（不要再与 `BS_PRICE_CALIBER` 各写一套同义文案）。
4. 未做真页面截图（GUI 需带鉴权的 URL）；用真组件标记 + 真 CSS 的无头 Chromium 截图替代，两张：
   改前（含两条提示条）与改后（都不在）。
