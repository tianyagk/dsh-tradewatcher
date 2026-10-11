# P4：自选/持仓行复核 + 幂等断言补强 + 五行 gate 断言 + 文档收口（task-56）· 实现记录

对象：`dsh-tradewatcher` v0.43.0 工作区（P1–P3 已交付/提交）。基线 343 条。
末次 `npm run check`：**344 条 × 2 时区全绿**、`ALL HOST CHECKS PASSED (live probes soft)`、
`built lib/index.js + lib/client.js（v0.43.0，客户端片段校验通过：75 项）` ⇒ **`build.mjs` 零改动**。
不装 bundle、不动 profile、不 commit、不重启。

## 1. 复核：两个页面的路由归属（grep file:line）

```
src/client/WatchlistPage.tsx:144   api.mutateWatch(...)      → /tradewatcher/watch（POST）
src/client/PortfolioPage.tsx        api.portfolio()/mutatePortfolio(...) → /tradewatcher/portfolio（GET/POST）
                                    api.ledger(...)          → /tradewatcher/ledger
src/client/QuoteDrawer.tsx:79       api.trades(secid)        → /tradewatcher/trades ← **core 的抽屉在用**
src/client/QuoteDrawer.tsx:78       api.industry(secid)      → /tradewatcher/industry ← **core 的抽屉在用**
src/client/BulkPaste.tsx:77/81/103  api.portfolio()/mutatePortfolio(...) → /tradewatcher/portfolio（入口在持仓页）
```

**修正后的独占清单**：
| 行 | 独占路由 | 独占工具 |
| --- | --- | --- |
| `watchlist` | `/tradewatcher/watch` | `watchlist`、`group_rank`（数据来源＝自选分组） |
| `portfolio` | `/tradewatcher/portfolio`、`/tradewatcher/ledger` | `portfolio`、`ledger` |
| **core（共享面）** | **`/tradewatcher/trades`**（详情抽屉）、**`/tradewatcher/industry`**（详情抽屉的行业行） | `quotes`、`search`、`position`、`ytd`、`undo` |

**判断理由**：`/trades` 与 `/industry` 被 **core 自己的组件**（详情抽屉）调用 ⇒ 跨行共享一律留 core
（否则停用自选/大盘会把抽屉弄坏）；`/ledger` 只有持仓页的流水弹窗用 ⇒ 归 portfolio（P1 曾误挂 watchlist，本批纠正）；
`undo` 是通用写入撤销、不属于任何 tab ⇒ 判不准 ⇒ 留 core（与任务"判断不了就留 core"一致）。

## 2. 幂等断言补强（验证员 V-2）

**问题**：原断言只 apply"不同行各一次" ⇒ 即使没有 `started` 守卫也不会重复 `init/start`，**不敏感**。
**改法**：改成 **core 行 apply 两次 + 五个功能行各一次**（共 7 次），再断言 `inits=1 / starts=1`。
```
✔ 幂等（补强后）：apply 共七次 ⇒ store.init() 只跑一次、rescue.start() 只跑一次（采样器唯一）
反例证据（副本里把 `if (!k.started)` 临时改成 `if (true)`）：
  ✖ apply 幂等：同进程 apply 三次，一次性副作用只跑一次
    AssertionError: store.init() 只跑一次        ← 现在真的抓得住
（恢复后 8/8 通过）
```

## 3. 五行 gate 断言（P4 新增）

对 **calendar / cloudmap / market / watchlist / portfolio** 逐个：只 apply core（该行未激活）时断言
① 该行独占路由**不在 core 注册表**（未注册 = 404）；② 该行独占工具**不在 core 工具表**；③ `gateTabs` 结果里**没有该行 tab**。
另断言**回落**：当前页＝自选被停用 ⇒ 回落 `portfolio`；当前页＝持仓被停用 ⇒ 回落 `watch`（默认页恰恰是它们，这条很容易被忽略）。

## 4. 文档收口

- `docs/DESIGN-SUBPLUGINS.md` §2.1 新增**最终归属表**（六行的独占路由/工具 + 共享面留 core 的判断依据）。
- `README.md` 新增「子组件与开关」一节（一句话）：**六行可独立开关；停用某行 = 该行路由 404 + 工具消失 + tab 消失（不灰显、不留空壳）**。
- patch↔一致性断言保留"硬编码当前进度"的设计，注释里写明**搬迁一行就要同步改这一处**（验证员 V-3 的关切）。

## 5. 测试与门禁
```
343 → 344（+1 五行 gate；幂等断言补强、patch 断言按六行全启用更新）
npm run check：344 × 2 时区全绿；75 项片段校验通过；build.mjs 零改动
```

## 6. 未做项与原因
1. **真实 HTTP 404/回包仍未贴**：跑着的宿主是旧进程（`/tradewatcher/rows` 返回空）⇒ 仍需重启后按 P2/P3 的"需装机复核"清单逐项验。
2. `watchlist`/`portfolio` 两行的 tab 与路由已可用（P3 六行全启用），但"停用后逐项验码"同样要重启后做。
3. 工具归属里 `undo` 判不准 ⇒ 留 core（已在文档写明）；若将来把日历撤销独立出来，再跟着改归属表与 patch 断言。
