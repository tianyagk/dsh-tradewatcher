# P2：抽出【云图】为可独立开关的行（task-53）· 实现记录

对象：`dsh-tradewatcher` v0.43.0 工作区（P1 已交付，见 `docs/AUDIT-IMPL12.md`）。基线 340 条。
末次 `npm run check`：**342 条 × 2 时区全绿**、`ALL HOST CHECKS PASSED (live probes soft)`、
`built lib/index.js + lib/client.js（v0.43.0，客户端片段校验通过：75 项）` ⇒ **`build.mjs` 零改动**。
不装 bundle、不动 profile、不 commit、不重启。

## 1. 云图的行边界（先查清再动手）

**实测结论：云图没有任何 host 路由，也没有 agent 工具。** 证据：
```
grep -rn "tradewatcher/" src/client/CloudMap.tsx   → 无输出
（该组件是纯前端 iframe，加载 52etf 的云图页；超时占位里给域名与最后成功时间）
```
因此 `ROW_ROUTES.cloudmap = []`、`ROW_TOOLS.cloudmap = []`（P1 已就位，本轮**确认**而无需搬迁）。
`src/index.ts` 里 core 的排除列表是**前缀表**（`/tradewatcher/board`、`/industries`、`/industry` 等属 **market** 行），
云图不在其中 ⇒ **core 对云图本来就没有"兜底注册"可删**（这也是本轮唯一诚实的答案，不是省略）。

「关闭 cloudmap ⇒ 路由 404」这条因此**平凡成立**（该行名下没有任何路由）；本轮真正的门控是**文件里的 tab**
与 `/tradewatcher/rows`。

## 2. 改动清单

| # | 改动 | 位置 |
| --- | --- | --- |
| 1 | 确认云图行不持有 host 路由/工具（证据见上），保留空前缀表 | `src/index.ts`（未改逻辑） |
| 2 | `tradewatcher-cloudmap` 从 `disabled: true` 改成**启用**（六行：core/calendar/cloudmap 启用，watchlist/portfolio/market 仍 disabled） | `cordis.patch.yml` |
| 3 | 云图 tab 的 `row: 'cloudmap'`（P1 已写占位 ⇒ **确认正确**，未改） | `src/client/index.tsx` |
| 4 | 三态回退：tab 由 gate 决定（行停用 ⇒ 不出现该 tab）；iframe 超时已有"域名 + 最后成功时间"的占位（历史问题"备用源下整图空白"在 P1 前已修） | 既有实现，本轮用断言钉住 |

## 3. 向后兼容语义（**明确选 (b)，并给证据**）

**选择：(b) 无 config ⇒ 只有 core 自己的部分**（功能行必须由 profile 显式装载）。

理由与证据：
- core 的排除列表是**静态前缀表**（`ROW_ROUTES`），**不**随行是否激活而变 ⇒ 未装载的行，那一段路由就是 404
  —— P1 的断言已经固化了这个事实：`core.routes.some(p => p.startsWith('/tradewatcher/calendar')) === false`。
- 若选 (a)（core 兜住一切），就无法同时满足 P2 的验收"关闭行 ⇒ 路由 404"（两者互斥：core 兜底意味着关不掉）。
- **向后兼容靠 patch 文件保证**：本文件把六行写全 ⇒ 装 bundle 的 profile 拿到的是完整功能；
  只有"把包当单行、不带 `config.row` 装载"的极端用法才会只见 core 的部分。
- 本轮新增一条 **patch 与代码一致性断言**（防漂移）：`cordis.patch.yml` 必须恰好六行、
  每行 `config.row` 与 id 对应、**已搬迁的三行启用、未搬迁的三行 disabled** —— 这条断言同时把上面的语义写死。

## 4. 验收实测

```
① 关闭 cloudmap（只 apply core）：
   · 云图无 host 路由 ⇒ 404 平凡成立（且断言 core 注册里没有任何含 cloud 的路径）
   · 无云图工具（前缀表为空）
   · gate：rows={core,calendar} ⇒ visible=['calendar']（云图 tab 不出现，日历不受影响）✓
② 开启 cloudmap（apply {row:'cloudmap'}）：
   · activeRows 含 'cloudmap' ⇒ gate 的 visible = ['cloud','calendar'] ✓
   · 该行本身注册 0 条路由（纯客户端 iframe）✓
③ 向后兼容：见 §3 —— 语义 (b)，P1 的既有断言 + 本轮 patch 断言共同固定
④ patch 防漂移：六行齐全、config.row 对应、启用/停用与搬迁进度一致 ✓
```
```
340 → 342（+2：cloudmap 门控、patch 一致性）
npm run check：342 × 2 时区全绿；75 项片段校验通过；build.mjs 零改动
```

## 5. 未做项与原因
1. **云图没有可搬迁的 host 面** —— 它是纯客户端 iframe（`CloudMap.tsx` 里没有任何 `/tradewatcher/` 调用）；
   若将来把云图改成自绘（走我们的 `/board` + `/industry*`），届时它才需要从 `market` 行划走前缀。
2. `watchlist/portfolio/market` 三行仍 `disabled: true`（P3–P4 搬迁后再打开）。
3. 真实多行装载验证仍待重启/装 bundle（本批证据是同进程 apply 的等价模拟）。

## 6. 需装机复核
① 重启后 `/tradewatcher/rows` 应返回 `['core','calendar','cloudmap']`（当前跑的还是旧进程，返回空、`/calendar` 仍 200）；
② 把 `tradewatcher-cloudmap` 置 disabled 后刷新：云图 tab 消失、其它 tab 不受影响；
③ 云图 iframe 超时占位仍给出域名与最后成功时间（不出现空白图）。
