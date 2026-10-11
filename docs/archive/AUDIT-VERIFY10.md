# 独立验收报告（v0.48.0 三批 · 对抗验证）

> 验收人：`verify`。立场：**证明实现者说错了** —— 全部结论来自我自己构造的反例与注入实验，不复用实现者的测试代码。
> **验证基线**：`git worktree add /tmp/tw-v11/repo 5d11d91`（v0.48.0）。全程在固定提交上验，用完 `remove`；worktree 内注入均已恢复（`git status` 干净）。

## 0. 结论：**通过**（附 1 条"判据证明力不足" + 1 条我自己犯的同类错 + 2 条未验证）

四条修正实测成立；**头号发现是判据强度问题**（见 §1），已在专节列出。

## 1. 【判据证明力不足（假断言）】—— "固定开销恒为 60px" 证明不了"重绘"

这是本轮最值得记的一条。任务要我判断 `chartHeight − (mainH+volH+macdH) === 60` 这个判据能否区分"重绘"与"等比缩放"。**实测结论：不能。**

```
[真实现]   560 固定开销 = 60      320 固定开销 = 60
[假实现·绘图区恒定（210/54/64，不随高度变）]  560 固定开销 = 60      320 固定开销 = 60
[同一断言] 真实现 560/320 = true true    假实现 560/320 = true true
```

我构造的"假实现"（`chartHeight = 36+24+210+54+64`，绘图区写死、**根本不随高度变**）**同样满足"固定开销 = 60"** ⇒ 这条判据**无法区分**"按高度重绘"与"绘图区恒定"。

**有区分力的替代判据**（我实测三条都有效）：

| 判据 | 真实现 | 假实现 | 能否区分 |
| --- | --- | --- | --- |
| `mainH(560) ≠ mainH(320)` | **184 vs 88** | 210 vs 210（相等） | ✅ 能 |
| 刻度条数随高度变 | `h=100→3, h=200→4, h=300→5` | 若写死则不变 | ✅ 能 |
| `chartHeight` 固定 364 时 `chrome=36≠60` | chrome=60 | 364−328=36 | ✅ 能（对 364 敏感） |

**建议**：把断言从"固定开销 = 60"改成"**绘图区高度随可用高度单调变化** + 刻度条数随高度变"，否则"某次重构把绘图区写死"这类缺陷会静默通过。

**我自己也犯了同类错（现场复现）**：我第一版 ①-b 只断言了**我自造的假对象**、没有断言**真实实现**的 `chrome === 60` —— 结果第一次注入"chartHeight 固定 364"时**我的测试全过（逃过）**。补上 `assert.equal(chrome(真实 kh), 60)` 后重做注入，才如期失败。这条值得作为"断言必须锚在真实实现上"的反面教材。

（**顺延自上一批**：`AUDIT-VERIFY9.md §2` 已记 —— "筹码请求数=1"也证明不了"`useChips` 依赖数组里没有 tab"，因为 loader 的 60s TTL 会吸收 effect 重跑。两例同源：**断言看着过了，但它证明的不是要证的那个命题**。）

## 2. ① 分割线的夹取与动态重绘 —— 实现通过

**我自己按源码公式算的几何**：

```
[avail=320] top=198 bottom=122 clamped=false | mainH=88  volH=24  macdH=28  chartHeight=200
[avail=560] top=347 bottom=213 clamped=false | mainH=184 volH=47  macdH=56  chartHeight=347
```

上窗 ≥160、下窗 ≥120、两区之和 = 可用高度 ✅。

**`mainH/volH/macdH` 确实来自 `klineHeightsOf(split.top)`** ✅：`QuoteDrawer.tsx:122 const kh = klineHeightsOf(split.top)` → `:195 const chartHeight = kh.chartHeight`（骨架与图表都用同一个 `kh`，没有别处硬编码）。

**反例（任务点名：chartHeight 改回 364）** ⇒ 我补强后的断言**失败** ✅：

```
✖ ①-b … AssertionError（chrome 变 36 ≠ 60）
ℹ tests 7  pass 6  fail 1
```

（注入已恢复。）

## 3. ② 切页签时筹码 DOM 不变 —— 结构证据通过，注入验证**部分未完成（如实说明）**

- **我独立 grep**：`ChipsPanel.tsx` / `useChips.ts` / `chipsLoader.ts` 里 `isFiveDay` 与 `tab` **零命中** ✅
- 那行"只在分时/日K 及以上显示"的文案**不在源码**（只在测试的断言字符串里，正当）✅
- `QuoteDrawer.tsx:317` 的"只在分时（当日）图上标 B/S"是**另一件事**（流水 B/S 标记），与筹码无关 ✅

**注入验证的诚实结论**：我尝试注入"加回 `isFiveDay`"，但**只注入了注释形态**（真代码需要给 `ChipsPanel` 加 props 字段，超出"最小注入"范围）⇒ 实现者的 `chipsView.test.ts` **仍然全过**。所以：
- ✅ 已证：**源码里不存在**页签判断（我自己的 grep）
- ⚠️ **未证**：真代码级加回页签判断时，实现者的断言是否会失败（它可能只查"文案不在"）。

## 4. ③ 骨架只在首帧 —— 通过

- `chartFrameOf` 三态实测：`{hasPayload:false} → {state:'first', skeleton:true}`、`{payloadTab≠tab} → {state:'stale', overlay:true, skeleton:false}`、同 tab → `fresh` ✅
- **切页签不再清空 payload** ✅：`QuoteDrawer.tsx:157-162` 的 else 分支只有 `setLoading(true)`，**没有 `setPayload(null)`**（上一版那行 `setPayload(prev => prev?.tab === tab ? prev : null)` 已去掉）✅
- **叠加层**：`.tw-chart-loading{position:absolute;inset:0;pointer-events:none;…}` ✅（不挡 hover）；`chart-wrap`（`:608`）与 `chartBody()`（`:609`）在**同一个 wrap 内** ✅
- **注入 B**（把 stale 的 `skeleton` 改回 `true`，等价"改回清空"）⇒ ③ **失败** ✅（已恢复）

## 5. ④ `prefs.splitRatio` 往返 —— 通过（隔离 DSH_HOME）

| 输入 | 结果 |
| --- | --- |
| `undefined`（缺键） | `0.62`、**note = null**（没有偏离就不留痕）✅ |
| `0.7` | `0.7` ✅ |
| `NaN` / `-1` / `0.9` / `0.1` / `'0.5'` / `null` | 一律 `0.62` + **note 有原因** ✅ |

**真实读写往返**（临时 `DSH_HOME`）：`setPrefs({splitRatio:0.7})` → `prefs.json` 落盘 `0.7` → **重新装载仍是 0.7** ✅（白名单放行有效）；`setPrefs({splitRatio:5})` → 落盘回落 `0.62` ✅；手改 `prefs.json` 塞 `NaN` → 装载后 `0.62` ✅（装载路径也归一）。
⚠️ 过程中我自己踩了一次坑：`getPrefs()` 是**同步读内存**的，必须先用任一 async 方法触发 `init()` 才拿得到磁盘值 —— 这是我第一版测出"0.7 变 0.62"的假故障原因（实现没问题）。

## 6. ⑤ 键盘与 aria 是"真接线" —— 通过（静态 + 行为两层）

**同一节点**（`QuoteDrawer.tsx:623-633`，都在分割线节点上）：`role:'separator'`、`aria-orientation:'horizontal'`、`aria-valuenow: Math.round(shownRatio*100)`、`aria-valuemin:25`、`aria-valuemax:75`、`tabIndex:0`、`onDoubleClick → commitRatio(SPLIT_DEFAULT)`、`onKeyDown`：`ArrowUp/ArrowDown → commitRatio(splitKeyStep(shownRatio, key))`、`Enter → commitRatio(SPLIT_DEFAULT)` ✅ 而 `commitRatio` 调 `props.onSplitRatio?.(next)` ⇒ **真的写回 prefs**（不是只改本地 state）✅

**行为**：`splitKeyStep(0.62,'↑')=0.64`、`(0.62,'↓')=0.6`；**两端夹住**：`(0.75,'↑')=0.75`、`(0.25,'↓')=0.25`、`(0.74,'↑')=0.75` ✅。拖拽预览同样夹住（`splitDragRatio(0.62,100,10000,500)=0.75`、`(…)→0.25`、可用高度 0 ⇒ 不变）✅

## 7. 门禁与核对

`npm run check`（worktree）：`tests 378 / pass 378 / fail 0` × 两轮、`ALL HOST CHECKS PASSED`、`75 项片段`、exit=0 ✅
交叉验证：`find src -name '*.test.ts'` = **51 个文件**、递归 `test()` = **378** ✅ 吻合
`git diff --stat 5d11d91 -- build.mjs` **空** → 零改动 ✅；`git diff --stat 9829a9f 5d11d91 -- src/index.ts` **空** → 行映射与 v0.45.3 一致 ✅

## 8. 未验证（明确声明）

1. **⑥ 不重挂载**：`__twMounts()` 需要在**浏览器控制台**读（`mounts.ts` 把 `mountCounts` 挂到 `window`）—— 本环境无浏览器运行时，**我没有取到任何挂载计数**。结构证据只有"抽屉的挂载 effect 依赖 `[]`、key 绑 secid"这一条，**不足以替代运行证据**，故按任务要求明说未验证。
2. **② 的真代码级注入**（见 §3）。
3. 渲染层：拖动的手感、分割线命中区域、骨架与旧图共存的视觉效果。

## 9. 复现

```bash
git worktree add /tmp/tw-v11/repo 5d11d91 && ln -sfn "$PWD/node_modules" /tmp/tw-v11/repo/node_modules
cd /tmp/tw-v11/repo && npm run check
SRC_ROOT=/tmp/tw-v11/repo node --test --experimental-strip-types /tmp/tw-v11/split.test.ts   # 七条
# 注入 A：splitDrag.ts 的 chartHeight 改成固定 364 ⇒ ①-b 失败
# 注入 B：chartFrame.ts 的 stale 分支 skeleton 改 true ⇒ ③ 失败
git worktree remove --force /tmp/tw-v11/repo
```
