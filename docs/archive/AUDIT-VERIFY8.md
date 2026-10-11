# 独立验收报告（P3+P4 组件化 · 对抗验证）

> 验收人：`verify`。立场：**证明实现者说错了** —— 结论基于我自己跑的门禁、我自己的假 ctx 装载实验、我自己做的 api→组件调用方映射、以及隔离 worktree 注入；不引用 `docs/AUDIT-IMPL14.md` / `AUDIT-IMPL15.md` 的数字。

## 0. 验证的版本（先声明）

- **我验的是提交 `05b72eb`（P4）**：全程在 `git worktree add /tmp/tw-v9/repo 05b72eb` 的固定检出里跑（已 `remove`），因此**不受并发写入影响**。worktree 内注入均已恢复（`git status` 干净）。
- 主工作区在我验收期间**确实被并发写入**（`ChipsPanel.tsx`/`NoteIcon.tsx`/`useChips.ts`/`chips.ts`/`chips.test.ts` + `M api.ts/routes.ts/CHANGELOG/package.json`）—— 那是筹码批次，**不在本报告范围内**。

## 1. 结论：**有条件通过**（1 条 P2 + 1 条 P4）

- **P2：三条路由的归属与实测调用方跨行冲突** —— 按设计文档自己的判据（§2.1"共享面一律留 core"）它们应留 core，实际归了 `market` 行。后果：**停用"大盘"行会连带弄坏云图页与自选页的功能**（诚实 404，不是错数，但违背"可单独开关"）。
- **P4：patch↔代码一致性断言的 id 正则是 `[a-z]+`**，改名成含大写/数字的新 id 会被正则截断而**逃过检测**（我已实测两种注入）。
- 其余**全部通过**：P3/P4 的两处归属纠正（`/trades`、`/industry` 归 core）与调用方一致；前缀可分性 7 例全对；幂等断言**确实敏感**（注入守卫恒真即失败）；gate 五行与"不回落"反例通过；文档 §2.1 工具/路由集逐行一致；门禁 344×2。

## 2. 门禁与交叉验证

worktree（`05b72eb`）内 `npm run check`：`tests 344 / pass 344 / fail 0` × 两轮、`ALL HOST CHECKS PASSED (live probes soft)`、`客户端片段校验通过：75 项`、exit=0。

**交叉验证**（按你的要求用 `find` 递归，不用会漏根目录的 glob）：

```
find src -name '*.test.ts' → 47 个文件
递归统计 test() → 344
```

与门禁 **344 完全吻合** ✅。`git diff --stat 05b72eb -- build.mjs` **输出为空** → 零改动 ✅。

## 3. 归属核对（本轮重点）：我自己建的 api→组件映射

方法：解析 `src/client/api.ts` 里每个 `/tradewatcher/<名>` 路由对应的 api 方法，再 grep 该方法在**非测试**客户端文件里的调用点，然后对照 `ROW_ROUTES` 的归属：

| 路由 | 归属 | 实测调用方（页面） | 判定 |
| --- | --- | --- | --- |
| `/trades` | **core** | `QuoteDrawer.tsx`（core 的详情抽屉） | ✅ **P4 纠正正确** |
| `/industry` | **core** | `QuoteDrawer.tsx`（详情抽屉的行业行） | ✅ **P3 纠正正确** |
| `/breadth` | market | `MarketPage.tsx`（大盘页） | ✅ 可独占 |
| `/rescue` `/rescueDay` | market | `RescuePanel.tsx` ← 只被 `MarketPage.tsx` 渲染 | ✅ 可独占 |
| `/board` | market | `MarketPage.tsx` **+ `IndustryHeatmap.tsx`** ← 而它只被 **`CloudMap.tsx`（云图页）** 渲染 | ⚠️ **跨行共用** |
| `/industries` | market | **仅 `WatchlistPage.tsx`（自选页）** | ⚠️ **跨行** |
| `/anomaly` | market | `alerts.ts` ← **被 `WatchlistPage.tsx` 引用** | ⚠️ **跨行** |
| `/watch` | watchlist | `WatchlistPage.tsx` | ✅ |
| `/portfolio` | portfolio | `PortfolioPage.tsx` + `BulkPaste.tsx`（同页） | ✅ |
| `/ledger` | portfolio | `PortfolioPage.tsx`（流水弹窗） | ✅ |
| `/quotes` `/trend` `/kline` `/detail` `/suggest` `/tones` `/ytd` `/badge` `/rows` `/prefs` `/backup` | core | `useQuotes` / `chartCache`+`MarketPage`+`RescuePanel`+`mini` / `QuoteDrawer`+`MarketPage` / `ui.tsx` / `TopBar` / `useYtd` / `index.tsx` 等 | ✅ 都在 core 的组件里 |

**误挂的三条**（证据链）：
- `/board`：`IndustryHeatmap.tsx:30` `.board('industry','amount',1)`，而 `CloudMap.tsx:5,125` 是**唯一**渲染 `IndustryHeatmap` 的地方 ⇒ 云图页依赖 `/board`；同时 `MarketPage.tsx:84` 也调 `.board(...)` ⇒ **market + cloudmap 两行共用**。
- `/industries`：`grep -rn '\.industries('` 只命中 `WatchlistPage.tsx:89` ⇒ 只有**自选页**在用（取分组内各标的的行业映射）。
- `/anomaly`：`alerts.ts:69` `.anomaly(ids)`，而 `alerts.ts` 只被 `WatchlistPage.tsx` 引用 ⇒ **自选页的告警扫描**依赖它。

**后果**：用户在 profile 里关掉"大盘"行 ⇒ ① 云图页热力图 404 ② 自选页行业列/告警扫描 404。这是**诚实失败**（不是错数），但与 §2.1 自己写的判据（"被 ≥2 个行/组件调用 ⇒ 留 core"）和 §3 的"不出现空壳"冲突。**建议**：把三者移回 core，或明确论证"云图页/自选页的这两处可降级"。

## 4. `/industry` vs `/industries` 前缀可分性 —— 通过

我自己构造两个路径跑前缀判定（核心/功能行两侧的实现分别是 `!owned.some(p => path.startsWith(p))` 与 `prefixes.some(...)`）：

```
/tradewatcher/industries            → market=true    /tradewatcher/industry            → market=false
/tradewatcher/industries?scope=all   → market=true    /tradewatcher/industry?secid=1.600519 → market=false
/tradewatcher/breadth → true   /tradewatcher/trades → false   /tradewatcher/tones → false
```

`?secid=…` **不参与**前缀判定（我看到 market 注册的路由 `kind` 全是 `exact`，query 由 handler 自己解析）✅。实跑装载也印证：**core 注册了 `/tradewatcher/industry`（14 条之一）与 `/tradewatcher/trades`，market 注册的 5 条里没有 industry**，两边**零重叠** ✅。

## 5. 幂等断言现在真的敏感 —— 通过（含非恒真注入）

断言已按上一轮的 V-2 补强：**core 行 apply 两次**（同一行重复装载）+ 五个功能行各一次 ⇒ `applies=7`、`inits=1`、`starts=1`、`routeRegs` 含 `/tradewatcher/rows`、`rescue.running === true`（源码注释里明确写了"验证员 V-2：那种断言不敏感"）。

**非恒真注入**（worktree 内把 `if (!k.started)` 改成 `if (true)`）：

```
✖ apply 幂等：同进程 apply 三次，一次性副作用只跑一次
ℹ tests 8  ℹ pass 7  ℹ fail 1
```

→ 断言**确实会失败** ✅（注入已恢复）。跨行路由零重复注册 ✅（见 §4 的重叠检查）。

## 6. 五行 gate + 回落反例 —— 通过

```
[不回落] 五个 tab 在当前页可用时 fallback 均为 null ✅        ← 关键反例：不是"总是回落"
[自选停用] visible=[market,portfolio,calendar,cloudmap] fallback=market
[持仓停用] visible=[market,watchlist,calendar,cloudmap] fallback=market
[全关]     visible=0  hideBar=true
[失败放行] rows=null ⇒ visible=5  fallback=null
```

回落目标按 `tabs` 顺序取"首个可用"（`market` 排第一），与实现一致 ✅。实现自带的 `P4：五行（calendar/cloudmap/market/watchlist/portfolio）关闭时三处都不在` 断言也已通过 ✅。

## 7. patch↔一致性断言 —— 对全小写改名有效，但有一处盲区

- **注入③（真实形态，改名成全小写 `tradewatcher-portfoli`）** ⇒ 断言**失败** ✅：
  `✖ P2：cordis.patch.yml 与代码的行集合一致（防漂移） AssertionError: 六行齐全且顺序固定`
- **注入②（改名成 `tradewatcher-portfolioX`）** ⇒ **全部断言仍然通过** ⚠️

原因：断言用 `/- id: (tradewatcher-[a-z]+)/g` 抓 id，`X` 不在 `[a-z]` 里 ⇒ 被截断成 `tradewatcher-portfolio`，漂移逃过检测。同理**任何含数字/大写的改名或新增行**（如 `tradewatcher-market2`）都不会被发现。**建议**正则放宽到 `[a-z0-9-]+` 并加一条"抓到的 id 数量 == patch 里 `- id:` 行数"的守恒断言。

## 8. 回归（P1 结论仍成立）—— 通过

`rowOf`：缺省/`{}`/`CALENDAR`/空白/数字/`null`/未知值 ⇒ 全部退回 **core** ✅。工具过滤：全量 **12**、`only=['calendar','calendar_add']` ⇒ 恰好 **2**、`exclude=[...]` ⇒ **10** 且 core 工具一个不少（`quotes`/`portfolio`/`position`/`ytd`/`undo` 均在）✅。

## 9. 文档与实现一致 —— 工具/路由集一致，归属判据有冲突

- **§2.1 归属表 vs 代码，我自己解析两边逐行比对**：五行工具集**完全一致**（`calendar`→2、`market`→`rescue`、`watchlist`→2、`portfolio`→2、`cloudmap`→0）；路由条数与内容一致（`calendar`→`/calendar`、`watchlist`→`/watch`、`portfolio`→`/portfolio`+`/ledger`、`market`→5 条）✅
- **README 那句与实现一致** ✅：`停用某一行 = 该行的**路由 404** + **工具从列表消失** + **侧栏 tab 消失**（不灰显、不留空壳）` —— 与 §3/§4/§6 的实测行为吻合（路由不注册、工具按 `only` 过滤、tab 不渲染）
- ⚠️ **冲突点**：§2.1 的判据"共享面一律留 core（被 ≥2 个行/组件调用）"与 `/board`、`/industries`、`/anomaly` 的实际归属不符（见 §3）。

## 10. 未验证

1. **真实多行装载**（Loader 把六行装进 profile）—— 按要求不装 bundle、不动 profile，等用户重启后由你复核。
2. **真实 HTTP 404**：只验了"路由不在注册表"（未起宿主发请求）。
3. **`/industries` 在自选页的降级表现**（关掉市场行后自选页具体显示什么）—— 只确认了路由不可达。
4. **主工作区筹码批次**（`ChipsPanel`/`chips.ts` 等）不在本次范围。

## 11. 复现

```bash
git worktree add /tmp/tw-v9/repo 05b72eb && ln -sfn "$PWD/node_modules" /tmp/tw-v9/repo/node_modules
cd /tmp/tw-v9/repo && npm run check
SRC_ROOT=/tmp/tw-v9/repo node --test --experimental-strip-types /tmp/tw-v9/rows.test.ts   # 归属/前缀/gate/回归 6 条
# 注入①：src/index.ts 的 `if (!k.started)` → `if (true)` ⇒ 幂等断言失败
# 注入③：cordis.patch.yml 的 tradewatcher-portfolio → tradewatcher-portfoli ⇒ 一致性断言失败
git worktree remove --force /tmp/tw-v9/repo
```
