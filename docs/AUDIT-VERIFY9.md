# 独立验收报告（v0.46.0 筹码四条 · 对抗验证）

> 验收人：`verify`。立场：**证明实现者说错了** —— 全部结论来自我自己构造的反例与注入实验，不复用实现者的测试代码。
> **验证基线**：`git worktree add /tmp/tw-v10/repo ebc2da4`（v0.46.0）—— 工作区可能被并发写入，故全程在固定提交上验，用完 `remove`。worktree 内注入均已恢复（`git status` 只剩软链）。

## 0. 结论：**通过**（另有两处对任务假设的修正，见 §2、§5）

四条修正全部实测成立；其中我**修正了任务给的两个构造**，并指出**① 的反例在默认 TTL 下不成立**（判据证明力问题）。

## 1. 门禁与核对

- worktree 内 `npm run check`：`tests 369 / pass 369 / fail 0` × 两轮、`ALL HOST CHECKS PASSED (live probes soft)`、`客户端片段校验通过：75 项`、exit=0。
- 交叉验证：`find src -name '*.test.ts'` = **50 个文件**、递归 `test()` = **369** ✅ 吻合。
- `git diff --stat ebc2da4 -- build.mjs` **空** → 零改动 ✅。
- `git diff --stat 9829a9f ebc2da4 -- src/index.ts` **空** → **行映射与 v0.45.3 逐字一致**（`ROW_ROUTES`/`ROW_TOOLS` 未被碰）✅。

## 2. ① 切页签不刷新 —— 计数通过，但**任务给的反例不成立**

**我自己的假 fetch 计数**（`loadChips` 直接调用，手工模拟"切页签导致 effect 重跑"）：

```
[切页签×6] calls = 1          ← 初始 1 次 + 模拟 6 次重跑，仍只 1 次请求
[换 secid]  calls = 2
[同 secid 并发 3 次] calls = 1  ← inflight 合并
```

**关键辨析（这条比"通过"更有价值）**：任务要求"把 `useChips` 的依赖数组临时加回 `tab` ⇒ 计数必须变多"。我实测这个反例**在默认 TTL 下不成立**：

- `loadChips` 只吃 `secid`，且有 **60s TTL 缓存**（`chipsLoader.ts`：命中 `now() - hit.at < ttl` 就直接返回）⇒ 即使依赖数组含 `tab`、effect 每次切页签都重跑，**TTL 内也不会发请求**，计数仍是 1。
- 我实测了 TTL 的两个边界：`[TTL 内] calls = 1` / `[TTL 过期后] calls = 2`。

**所以"计数=1"这个断言证明的是 loader 的缓存/合并，而不是 useChips 的依赖数组。** 两条证据是**独立**的，必须分别取证：

| 要证明的命题 | 有效证据 | 我取的证 |
| --- | --- | --- |
| 切页签不重取（运行时） | loader 计数 | ✅ 上表（我在 loader 层独立复现） |
| effect 不因页签重跑（结构） | `useChips` 依赖数组字面量 | ✅ 我读源码：`useEffect(..., [secid, enabled, refreshKey])` —— **无 `tab`**；`loadChips(secid, …)` 入参只有 secid |
| 刷新信号不接页签 | `setChipsRefresh` 的调用点 | ✅ 只出现在 `onRetry`（`QuoteDrawer.tsx:570`），与 `tab`/`retry` 无关 |

**我做的注入**（删掉 loader 的 TTL 命中分支）⇒ ①-a/①-b **双失败** ✅ —— 这同时说明：**若只用"计数=1"作断言，它对依赖数组的改动完全不敏感**（无法发现"依赖数组里偷偷加回了 tab"）。

**图表侧仍会重取** ✅：`QuoteDrawer.tsx:145` 的图表 effect 依赖 `[secid, tab, fqt, retry]` —— **含 `tab`**，没有为"不刷新"把图表也冻住。另外我检查了抽屉里没有别处把 `refreshKey` 接到 `retry` 上（`setChipsRefresh` 只有 `onRetry` 一个调用点）。

## 3. ② 去配置项 + 偏离底线 —— 通过

**面板源码静态核对**（剥注释后扫 `ChipsPanel.tsx`）：`k=` **零命中**、`三角形` **零命中**、`select` **零命中**、`口径：` 零命中 ✅。

**偏离判定的六个输入**（我逐个构造调 `caliberDeviates`）：

```
[正常 A股+有 floatMv+前复权+样本够] null            ← 一个字都不显示 ✅
[港股]        港股 vol/amount 单位未标定 ⇒ 回落固定半衰期
[缺 floatMv]  拿不到流通市值 ⇒ 回落固定半衰期
[不复权]      该标的不支持前复权（指数/期货/板块）⇒ 不提供筹码分布
[样本不足]    只取到近 30 日（不足 180 日）——历史越长越准
[宿主 why]    指数没有前复权序列
```

**反例**（把偏离判定改成恒 `return null`）⇒ `② 口径底线` **失败**：`AssertionError: The input did not match the regular expression /港股/` ✅ 说明断言真能抓到"该显示却没显示"（注入已恢复）。

## 4. ③ 纵轴刻度 —— 通过

```
[空]   []                                  ← 空序列给 []
[n=11] [10, 12.5, 15, 17.5, 20]            ← 5 个、含两端、严格单调
[n=3]  [10, 15, 20]                        ← 3 个
[等值] [7]                                  ← 观察点：退化成单刻度
```

数量 3–5 ✅、含端点 ✅、严格单调 ✅、空 ⇒ `[]` ✅。
**对齐**：`ChipsPanel.tsx` 的注释与结构显示左轴刻度与横条在**同一个 flex 行内**（`ticks.slice().reverse().map(...)` 与横条同容器、同行高），不是各画一套 —— 静态证据 ✅（逐像素需装机核对）。

⚠️ **观察（非缺陷）**：`axisTicks` 在 `hi <= lo`（等值/降序）时返回**单元素** `[lo]`，不满足"3–5 个"。这是异常输入的兜底，正常筹码序列（高>低）不会走到。

## 5. ④ 窗口语义 —— 通过，但**任务给的构造会命中另一个正确分支**

**任务给的构造**："前 135 根一个价区 + 后 45 根另一个价区"。我严格按它跑：

```
[严格构造 window=45] days = 0   why = 窗口内价格没有变化（高=低）⇒ 分布无意义
```

原因：`window=45` 恰好只覆盖"后 45 根"这一段**同价区** ⇒ `high === low` ⇒ 实现**如实拒绝**（这是一个正确分支，不是 bug）。所以严格构造下"两个 window 在同一天的 buckets 不相等"**无法比较**（一侧为空）。

**我修正后的构造**（两段价区各带微幅波动，`10 + (i%5)*0.05` / `20 + (i%5)*0.05`）：

```
[展示数] 180 版 = 45   45 版 = 45
[末日在两窗口下 buckets 不同?] true      ← 同一天、不同累积窗口 ⇒ 分布确实不同
[权重守恒] buckets 合计 = 1.000000
[老调用] window=45 displayWindow=45（结构未破坏；字段名确认是 displayWindow）
```

**反例**（把累积窗口改成只看 `display`：`.slice(-window)` → `.slice(-display)`）⇒ `④` **失败**：
`AssertionError: 同一天、不同累积窗口 ⇒ buckets 必须不同（否则"全是获利盘"问题复发）` ✅（注入已恢复）

## 6. 未验证

1. 渲染层：刻度与横条的**逐像素**对齐、滑杆交互、切页签的视觉无闪（只做了结构/静态核对）。
2. `useChips` 的 React 运行时行为：我验证的是它的**依赖数组字面量**与 loader 计数，未在真实 React 渲染里切页签。
3. `N<180`（bars 数量不足）时的口径文案：我验的是 `window` 参数维度与 `samples < window` 分支；"用了近 N 根"的真实端到端文案未逐字取证。

## 7. 复现

```bash
git worktree add /tmp/tw-v10/repo ebc2da4 && ln -sfn "$PWD/node_modules" /tmp/tw-v10/repo/node_modules
cd /tmp/tw-v10/repo && npm run check
SRC_ROOT=/tmp/tw-v10/repo node --test --experimental-strip-types /tmp/tw-v10/chips.test.ts   # 五条
# 注入 A：chipsLoader.ts 删掉 `if (now() - hit.at < ttl) return hit.value as T` ⇒ ① 失败
# 注入 B：chipsView.ts 的 caliberDeviates 开头加 `return null` ⇒ ② 失败
# 注入 C：chips.ts 的 `.slice(-window)` → `.slice(-display)` ⇒ ④ 失败
git worktree remove --force /tmp/tw-v10/repo
```
