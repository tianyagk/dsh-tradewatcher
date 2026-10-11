# 筹码模块四条修正（task-61）· 实现记录

对象：`dsh-tradewatcher` v0.45.3 工作区。基线 363 条。
末次 `npm run check`：**369 条 × 2 时区全绿**、`ALL HOST CHECKS PASSED (live probes soft)`、
`built lib/index.js + lib/client.js（v0.45.3，客户端片段校验通过：75 项）` ⇒ **`build.mjs` 零改动**。
不装 bundle、不动 profile、不 commit、不重启；**未动 `src/index.ts` 的行映射**。

## ① 切 K 线页签不再触发刷新（硬证据：fetch 计数）

改动：新增 `src/client/chipsLoader.ts`（**入参只有 `secid`**：按 secid 缓存 60s + 同一 secid 并发合并）；
`useChips` 走它，依赖数组改为 `[secid, enabled, refreshKey]`（refreshKey 是**筹码自己的**刷新计数）；
抽屉里筹码开关**恒为 `true`**（五日档只是"不显示"，数据照留 ⇒ 切回来立即可见），图表重试计数不再参与。

```
断言（chipsView.test.ts）：
  假 fetch 计数：切 6 次页签（1m/5d/day/week/month/year）后 calls === 1 ✓
  换 secid ⇒ calls === 2（缓存按 secid 维度）✓
  同一 secid 并发 3 次 ⇒ calls === 1（请求合并）✓
结构断言：chipsLoader 源码里不出现页签/复权/图表重试；useChips 依赖数组 = [secid, enabled, refreshKey]；
  抽屉里没有 useChips(secid, tab…；图表数据路径（chartBody/api.trend）未被改动 ⇒ 图表该重取仍然重取 ✓
```

## ② 去掉前台配置项与提示文字（默认写死）

- 删除口径行 `换手率衰减 k=1.5 · 三角形分布 · 近 45 日` 与两个 `select`（面板源码里已无 `k=`、`三角形`、`select`、`tw-chips-ctl`）。
- 默认**写死**：三角形分布 + `k = 1.5`（宿主 `CHIPS_DECAY_DEFAULT`/`CHIPS_SPREAD_DEFAULT`）。
- **保留底线**：`caliberDeviates()`（纯函数）只在**偏离默认**时返回一行原因 —— 港股回落半衰期、缺 `floatMv`、
  `fqSupported=false`（指数/期货/板块）、样本不足（`samples < 累积窗口`）；正常 A股 ⇒ `null` ⇒ 一个字都不显示。
- 反向断言：正常 A股 + 有 `floatMv` ⇒ `caliberDeviates(...) === null`；港股 ⇒ 原因里含 `9926`；样本不足 ⇒ 含实际根数；
  面板（剥离注释后）不许出现 `k=`/`三角形`/`select`/`tw-chips-ctl`。

## ③ 左侧纵轴价格刻度

`axisTicks(centers)`（纯函数）取 3–5 个均匀刻度、**含端点**（最低/最高桶价），横条图左侧用
`.tw-chips-chart` + `.tw-chips-axis`（同一 flex 行 ⇒ **逐行对齐**，小号 `9.5px`、次要色、等宽字体，不加粗）。
```
断言：刻度数 3–5 ✓；ticks[0] === 最低桶价、末刻度 === 最高桶价（覆盖 [lo, hi]）✓；严格单调递增 ✓；空序列 ⇒ [] ✓；样式存在 ✓
```

## ④ 计算窗口 180d，展示窗口仍近 45d

- `CHIPS_WINDOW = 180`（**累积窗口**）、`CHIPS_DISPLAY = 45`（展示，上限 60）；
  `chipSeriesOf` 在**整个 window 上逐日递推**，但只为**最近 `display` 天**记录状态（`days.length = min(display, 可用根数)`）。
- 路由：`days` = 累积窗口（默认 180）、新增 `display`（默认 `min(45, days)`、上限 60）；
  回包同时给 `window`（累积）与 **`displayWindow`**（展示）⇒ **老调用 `days=45` 不坏**（累积 45、展示 45、结构只增不改）。
- 样本规则按**实际取到的根数**：`N < 10` ⇒ 样本不足；`10 ≤ N < 180` ⇒ 照算，且口径串如实写"用了近 N 根（不足累积窗口 180 根）"。

```
断言（chips.test.ts）：
  造 180 根（前 135 根 10 元区、后 45 根 20 元区）：window=180/display=45 与 window=45/display=45
  ⇒ 最新一天的 buckets **不相等**（证明窗口真的生效）✓；days.length === 45（滑杆范围）✓；
  最早展示日 ≠ "只有当天新增" ✓；每天权重和 === 1（守恒）✓；
  老调用回归：window=45 时 displayWindow === 45 且口径串含"用了近 45 根" ✓；
  只给 60 根时口径串含"用了近 60 根（不足累积窗口 180 根）" ✓（不假装够）
```

## 测试与门禁
```
363 → 369（+2 窗口/累积、+4 客户端：切页签计数与结构、面板零文案与偏离原因、纵轴刻度、缓存/合并）
npm run check：369 × 2 时区全绿；75 项片段校验通过；build.mjs 零改动
```

## 未做项
1. 旧口径行/控件删除后，`prefs.chipsDecay`/`chipsSpread` 仍留在数据模型里（宿主的归一逻辑照旧生效、默认值即写死值）；
   将来若要再做"可调"，重新接 UI 即可 —— 本轮按用户要求**只保留默认**。
2. 缓存 TTL 60s 是经验值：同一 secid 在 60s 内重开抽屉吃缓存（避免抖动）；需要强制新鲜时由面板的重试（`refreshKey`）触发。

## 需装机复核（无浏览器，未做视觉验证）
① 切 6 次页签：筹码不动、滑杆位置不丢、无闪烁与骨架屏（可用宿主日志/网络面板复核请求数 = 1）；
② 左轴刻度与横条是否**逐行对齐**、刻度字号是否与其它轴一致（9.5px 是否偏小）；
③ 正常 A股面板上除四个数字外再无口径文案；港股票显示一行回落原因；
④ 180d 累积后最早展示日的筹码分布是否还"全是获利盘"（本批只保证算法用了 180d 历史，观感要人眼确认）。
