# P3：抽出【大盘】为可独立开关的行（task-55）· 实现记录

对象：`dsh-tradewatcher` v0.43.0 工作区（P1/P2 已交付，见 `docs/AUDIT-IMPL12.md` / `AUDIT-IMPL13.md`）。基线 342 条。
末次 `npm run check`：**343 条 × 2 时区全绿**、`ALL HOST CHECKS PASSED (live probes soft)`、
`built lib/index.js + lib/client.js（v0.43.0，客户端片段校验通过：75 项）` ⇒ **`build.mjs` 零改动**。
不装 bundle、不动 profile、不 commit、不重启。

## 1. 先查证：大盘页到底用了哪些 host 路由（准确清单）

```
src/client/MarketPage.tsx:104   api.breadth                 → /tradewatcher/breadth（大盘页自己的数据）
src/client/MarketPage.tsx:132   注释：备用源下 f104/f105/f106 缺失时用 /tradewatcher/breadth 的兜底
src/client/QuoteDrawer.tsx:78   api.industry(secid)         → /tradewatcher/industry ← **详情抽屉（core）在用**
（board / industries / rescue / anomaly 在客户端没有直接调用点：它们是给 agent 工具与用户 API 的）
```

**market 行独占（准确前缀清单）**：`/tradewatcher/breadth`、`/tradewatcher/board`、`/tradewatcher/industries`、
`/tradewatcher/rescue`、`/tradewatcher/anomaly`。

**共享面判断（按"跨行共享一律留 core"）**：
| 路由 | 判断 | 理由 |
| --- | --- | --- |
| `/tradewatcher/industry`（单 secid 行业查询） | **留 core** | 详情抽屉（core 的组件）在用它；停用大盘不该把抽屉的行业行弄没。它不是 `/tradewatcher/industries` 的前缀（后者更长），前缀匹配天然分得开 |
| `/tradewatcher/breadth` | **归 market** | 已 grep 查证：顶部行情条（`TopBar.tsx`）**不**调用它，只有大盘页用 ⇒ 不构成跨行共享 |
| 其余 core 路由（quotes/trend/kline/detail/suggest/prefs/backup/health/undo/…） | core | 与行无关 |

**工具归属**：`rescue` → market（护盘面板在大盘页）；`group_rank` 的数据来源是**自选分组** ⇒ 归 `watchlist` 行，
**本轮未动**（P1 的表里就是它，P4 复核）；`quotes/search/position/ytd/undo` 留 core。

## 2. 改动清单

| # | 改动 | 位置 |
| --- | --- | --- |
| 1 | `ROW_ROUTES.market` 定为上表五个前缀（**移除** `/tradewatcher/industry`，留 core），并写明理由 | `src/index.ts` |
| 2 | `cordis.patch.yml`：**六行全部启用**（见 §3 的说明） | `cordis.patch.yml` |
| 3 | 更新 patch↔代码一致性断言（不再是"三行启用三行 disabled"） | `src/index.test.ts` |
| 4 | 大盘 tab 的 `row: 'market'`（P1 占位已正确，**确认**） | `src/client/index.tsx`（未改） |

### ⚠ 一个必须报告的连带修正：watchlist/portfolio 两行也一并启用

P2 结束时 patch 里 `watchlist/portfolio/market` 是 `disabled: true`。P3 一打开 market 就暴露出：
**这两行的路由前缀在 P1 就已进 `ROW_ROUTES`**（core 已经把它们排除）⇒ 若继续 disabled，
客户端 gate 会把「自选」「持仓」两个 tab 一起隐藏，而它们那两段路由 core 也不再提供 ⇒ **真把功能弄坏**。
因此本批把六行全部启用（这些行自己提供自己那段，core 不再兜 → 可用性与今天一致，tab 也不再消失）。
P4 的定位相应变成"复核 + 补测试"，而不是"打开开关"。

## 3. 验收实测（同进程 apply 的等价模拟；真实 HTTP 404 需重启后验）

```
① 关闭 market（只 apply core）：
   · core 注册表里**没有** breadth/board/rescue/anomaly/industries（各断言）⇒ 路由未注册 = 404
   · core 工具列表里**没有** tradewatcher_rescue（market 行提供）
   · gate：rows 不含 market ⇒ visible 里没有「大盘」tab
   · 不受影响：core 仍注册 /tradewatcher/industry（详情抽屉用）、/quotes、/kline、/rows…（断言）
② 开启 market（apply {row:'market'}）：
   · 五个独占前缀逐个在该行注册表里出现 ✓（market.routes 断言）
   · market.tools 含 tradewatcher_rescue ✓；core.tools 不含它 ✓
   · group_rank 不在 core 也不在 market（属 watchlist 行，P3 不动）✓
③ 向后兼容：语义仍是 (b)（无 config ⇒ 只有 core 的部分）；patch 把六行写全保证装 bundle 的 profile 完整
④ patch↔一致性断言**非恒真**（改错会失败的证据，临时把 market 改回 disabled）：
   ✖ P2：cordis.patch.yml 与代码的行集合一致（防漂移）
     AssertionError: tradewatcher-market 的 enabled/disabled 与搬迁进度不符
   （恢复后 7/7 通过）
```
```
342 → 343（+1：P3 边界与共享面断言）
npm run check：343 × 2 时区全绿；75 项片段校验通过；build.mjs 零改动
```

## 4. 未做项与原因
1. **真实 HTTP 404 未贴回包**：跑着的宿主还是旧进程（`/tradewatcher/rows` 返回空），重启前拿不到"新代码的 404"；
   本批用**路由注册表断言**证明"未注册 ⇒ 404"（插件自身的路由语义），重启后需复核（见下）。
2. `/tradewatcher/breadth` 的**回包**同样要重启后才能贴（现在跑的是旧构建，路由仍在）。
3. `group_rank` 归属自选、P3 不动 ✓；`/watch`、`/ledger`、`/trades`、`/portfolio` 四段路由现在由 watchlist/portfolio 行提供（不再是 core）—— 属于 P1 表既定归属，本批只是把它们**真正打开**。

## 5. 需装机复核
① 重启后 `/tradewatcher/rows` 应返回六行；② 逐个前缀验 HTTP：`/tradewatcher/breadth`、`/board`、`/industries`、`/rescue`、`/anomaly` 均 200，`/tradewatcher/industry?secid=…` 仍 200（core）；
③ 把 `tradewatcher-market` 置 `disabled: true` 重启：上述五个前缀应 404、大盘 tab 消失，而 `/tradewatcher/industry`、行情条与行情详情抽屉照常；
④ 确认「自选」「持仓」tab 没有因为这次改动消失（六行全启用的直接目的）。
