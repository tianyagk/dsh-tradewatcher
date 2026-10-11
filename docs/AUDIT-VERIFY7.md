# 独立验收报告（P1+P2 组件化 · 对抗验证）

> 验收人：`verify`。立场：**证明实现者说错了** —— 结论基于我自己跑的门禁、我自己构造的假 ctx 装载实验、以及隔离副本注入；不引用 `docs/AUDIT-IMPL12.md` / `AUDIT-IMPL13.md` 的数字。
> 临时脚本与 worktree：`/tmp/tw-v8/`（已清理，worktree 已移除）。

## 0. 结论：**通过**（四块全部实测通过；附一条流程事实与两条观察）

**⚠️ 先说版本事实（影响结论适用范围）**：任务给我的基线是提交 `3417a55`（P1+P2）。但我开工后工作区**被并发写入**了未提交的 **P3 改动**（`M cordis.patch.yml`、`M src/index.ts`、`M src/index.test.ts`、新增 `docs/AUDIT-IMPL14.md`，mtime 21:18–21:20）。因此：

- 我在**当前工作区**与**基线 worktree（`git worktree add … 3417a55`，已移除）**上都跑了同一套反例，**两边都是 7/7 通过**；
- 两版的差异是**P3 自身的搬迁进度**（见 §6），不是缺陷。

**核心结论**：`apply` 幂等是真修复（且断言非恒真，实测注入后失败）；门控三处齐备；`tabsGate` 三条语义正确（"失败放行"不是"总是放行"）；`rowOf` 十例健壮；工具过滤语义正确；patch 六行与代码映射表一致、一致性断言非恒真。

## 1. 门禁（我自己跑的）

`npm run check` 在工作区为 `3417a55` 时（21:17 启动）：`tests 342 / pass 342 / fail 0` × 两轮时区、`ALL HOST CHECKS PASSED`、`75 项片段`、exit=0。

P3 并发写入后我重跑了测试段：`npm run test` → `tests 343 / pass 343 / fail 0` × 两轮（P3 给 `index.test.ts` 加了 1 条）。

**交叉验证（我自己的口径，含一次自我纠错）**：`find src -name '*.test.ts'` 共 **47 个文件**（我第一次用 `src/*/*.test.ts` 只得 46 —— 漏掉了根目录的 `src/index.test.ts`），递归统计 `test()` 合计 **343**，与当前实测 **343 完全吻合**。`build.mjs` 相对 HEAD **零改动**。

## 2. `apply` 幂等（本轮头号风险）—— 通过，且断言非恒真

**构造**：自造假 `PluginContext`（`provide`/`get`/`effect` 立即执行并收集、`webServer.register` 收集路由），同一进程内模拟三行：`apply(core)` + `apply(calendar)` + `apply(cloudmap)`，各自独立 ctx。`DSH_HOME` 隔离到 `/tmp` 临时目录；`RescueMonitor.prototype.start` 被替换为 no-op（**避免探活上游**，也避免定时器挂住进程；计数在 `start()` 调用前递增，不影响断言）。

```
[幂等] applies = 3   inits = 1   starts = 1
[路由] core = 13  calendar = 1  cloudmap = 0   合计 = 14   去重 = 14
[再 apply core] inits = 1   starts = 1          ← 第四次 apply（热重载形态）仍不重跑
```

→ `store.init()` / `rescue.start()` 各一次 ✅；跨行**无重复注册** ✅；`rescue-log.json` 因此只有一个写入者（`start` 只调一次）✅。

**非恒真注入**（在 worktree 副本里把 `if (!k.started)` 改成 `if (true)`）：

```
[幂等] applies = 3   inits = 1   starts = 1     ← 三行仍只一次 core（该步对守卫不敏感）
[再 apply core] inits = 2   starts = 2          ← 暴露：断言失败
✖ 幂等① … (AssertionError)
```

→ 断言**确实会因守卫缺失而失败** ✅（注入已恢复、副本已移除）。
**顺带发现**：我那一步"三行装载"其实只有一次 `core`，对守卫**不敏感**；真正敏感的是"重复 apply core"。若实现者的断言也只跑"三个不同行各一次"，那它同样不敏感 —— 建议断言里**显式重复 apply 同一行**（我已在我的脚本里这么做）。

## 3. 门控三处（calendar）—— 通过

| 检查 | 只 apply `core` | apply `core+calendar` |
| --- | --- | --- |
| 注册表里的日历路由 | `[]`（core 只注册 13 条，排除所有行独占前缀） | `['/tradewatcher/calendar']` ✅ |
| agent 工具 | `makeAgentTools(..., {only:['calendar','calendar_add']})` ⇒ 恰好 `['tradewatcher_calendar','tradewatcher_calendar_add']` | 全量 12 个里含这两个 ✅ |
| gate tab | `gateTabs(tabs, Set(['core']), 'calendar')` ⇒ `visible=[market, cloudmap]`、`fallback='market'` | 含 calendar ✅ |

真实 404 我**没有**发 HTTP 请求（未起宿主）：注册表里不存在 ⇒ 路由匹配不到 ⇒ 404 是框架语义，我按"注册表 + 前缀匹配"判定 ✅（如要真 404 证据需起宿主，列入未验证）。

**云图"平凡成立"的独立确认**（任务要求自己 grep）：

```
[云图] ROW_ROUTES.cloudmap 为空 = true   ROW_TOOLS.cloudmap 为空 = true
[CloudMap.tsx] 含 host 面调用（fetch/api/register）= false
```

→ `src/client/CloudMap.tsx` 里**没有任何** host 侧调用（无 `fetch(`/`api.`/`register(`），`ROW_ROUTES.cloudmap` 与 `ROW_TOOLS.cloudmap` 都是 `[]` ✅ **"这一行没有 host 面"是事实，不是拿平凡成立掩盖缺失**：该行的真实作用是客户端 tab 开关，不承担路由/工具（这与 §5 的 gate 断言一致）。

## 4. `tabsGate` 三条语义 —— 通过（且"失败放行"≠"总是放行"）

```
[失败放行]      rows=null            → visible=[market,calendar,cloudmap]  hideBar=false  fallback=null
[全关]          rows=Set()           → visible=0                          hideBar=true   fallback=null
[可达/停用日历] rows=Set(core,cloudmap) → visible=[market,cloudmap]         fallback='market'
```

- 端点不可达（`rows === null`）⇒ 全部放行 ✅
- 全关 ⇒ `hideBar=true`（调用方据此不渲染 tab 条）✅
- 当前页被停用 ⇒ `fallback` 指向首个可用 tab ✅
- **关键反例**：可达但 calendar 行被停用时，`visible` 只有 2 个 —— **不是"总是放行"** ✅

## 5. `rowOf` 健壮性 / 工具过滤 —— 通过

`rowOf` 十例实测：`undefined`/`{}`/`{row:'CALENDAR'}`/`{row:'  '}`/`{row:123}`/`{row:null}`/`{row:'unknown-row'}` ⇒ 全部退回 **core**（不静默变成"无行"导致什么都不注册）✅；`{row:'calendar'}` 与 ctx.config 回退 `{row:'market'}` 正常 ✅。

工具过滤（不经 ctx，直接对 `makeAgentTools` 的 filter 取证）：全量 **12** 个；`only:['calendar','calendar_add']` ⇒ 恰好 2 个；`exclude:['calendar','calendar_add']` ⇒ **10** 个，且 **core 工具一个不少**（`tradewatcher_portfolio`/`quotes`/`undo` 均在）✅。

## 6. patch 六行 vs 代码映射表 + 一致性断言 —— 通过（并注意进度随版本变）

**自己解析 `cordis.patch.yml`**（行级扫描，先剥注释；我第一次的正则因回溯把顺序读错，已修）：六行齐全且 `id` 与 `config.row` 一一对应 ✅：

```
core / calendar / cloudmap / market / watchlist / portfolio
```

**基线（3417a55）与当前工作区的差异**（这也是"工作区被改"的实证）：

| 项 | 基线 `3417a55` | 当前工作区（P3，未提交） |
| --- | --- | --- |
| patch 行启用状态 | core/calendar/cloudmap 启用，**watchlist/portfolio/market disabled** | **六行全部启用** |
| `ROW_ROUTES.market` | 6 条（含 `/tradewatcher/industry`） | 5 条（**industry 留 core**，因详情抽屉在用） |
| `index.test.ts` 的 `shouldDisable` | 三个未搬迁行 | **空数组** |
| core 路由数（我的脚本实测） | 12 | 13 |
| 测试数 | 342 | 343 |

**一致性断言非恒真** ✅：在基线副本里把 `tradewatcher-market` 改名 ⇒ 该断言**失败**：

```
✖ P2：cordis.patch.yml 与代码的行集合一致（防漂移） (AssertionError)
```

（另做了一次反向注入：给 watchlist 加 `disabled: true` —— 这在**基线**下**仍然通过**，因为基线的期望正是"未搬迁行必须 disabled"。这正好说明该断言的期望值是**硬编码的搬迁进度**：搬迁一批就要手改一次，P3 已把 `shouldDisable` 改成 `[]`。）

## 7. 发现（观察，均不阻塞）

- **V-1（流程）验收期间工作区被并发写入**：我在 21:17 拿到的是 `3417a55`，21:18–21:20 出现 P3 未提交改动。我的结论对**两个版本**都验证过（都通过），但如需"对 `3417a55` 的纯净结论"，请以我 §6 表格中的基线列为准。
- **V-2（测试强度）**：幂等断言若只跑"不同行各 apply 一次"，则对 `started` 守卫**不敏感**（注入实测）。建议显式重复 apply 同一行。
- **V-3（维护成本）**：patch↔代码一致性断言把"搬迁进度"（哪些行该 disabled）硬编码，每次搬迁都要改期望；P3 已演示。可接受，但值得在注释里写明"搬迁时同步改这里"。
- **V-4**：`/tradewatcher/industry` 归 core（P3 决定）有明确理由（详情抽屉在用），且前缀匹配上 `/industries` 更长、天然分得开 —— 我 grep 核对了字符串前缀关系，**不冲突** ✅。

## 8. 未验证

1. **真实多行装载**（Loader 实际把六行装进 profile、每行独立 fiber、apply 真被调用 N 次）——按要求不装 bundle、不动 profile，等用户重启后由 Lead 复核。
2. **真实 HTTP 404**：只验证了"路由不在注册表"，未起宿主发请求。
3. **`docs/DESIGN-SUBPLUGINS.md` 的逐条机制核对**（任务第 8 块）：我读了它的口径注释与实现要点（门控/失败放行/单实例/patch 语义）方向一致，但**没有**做逐条 mapping 表；如需请单独派一轮。
4. 渲染层（tab 条实际隐藏、回落跳转）未跑。

## 9. 复现

```bash
npm run check                                                              # §1
node --test --experimental-strip-types /tmp/tw-v8/subplugins.test.ts       # §2–§5（7 条；SRC_ROOT 可指向任意副本）

# §2/§6 非恒真注入（隔离 worktree，不影响主工作区）
git worktree add /tmp/tw-v8/base 3417a55 && ln -sfn "$PWD/node_modules" /tmp/tw-v8/base/node_modules
# 在副本里把 src/index.ts 的 `if (!k.started)` 改成 `if (true)` → 幂等断言失败
# 在副本里把 cordis.patch.yml 的 tradewatcher-market 改名 → patch 一致性断言失败
git worktree remove --force /tmp/tw-v8/base
```
