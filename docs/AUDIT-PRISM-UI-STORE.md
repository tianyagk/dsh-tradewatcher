# 棱镜 · UI / 状态一致性 / 持久化审计（v0.224.1）

> **只读审计，不改代码。** 本轮只新增本文件，未触碰 `src/**`，未 commit，未重启。
>
> 基线确认：开审时 `v0.224.1`（`a3c9972`），`git status --porcelain` 为空（工作树干净），
> `npm run check` 退出码 0（typecheck + test + selftest + build 73 项全过），**任务给的 2003/2003 成立**。
>
> ⚠ **审计期间工作树被别人改脏了（不是本审计）**：`11:36` 起 `src/host/prismRoutes.ts`(+4 行)、
> `src/host/prismAccount.ts`(+2/-2) 被另一会话修改，`11:37` 新增未跟踪文件 `src/host/prismParseSide.test.ts`，
> `11:40` 新增 `docs/AUDIT-PRISM-PROMPT.md`。因此我在 `11:38` 跑出的 `tests 2006 / pass 2006 / fail 0`
> **不是 v0.224.1 的基线**，而是"2003 + 那个新测试文件的 3 条"。本文件所有结论与行号以 **`a3c9972`（v0.224.1）为准**；
> `prismRoutes.ts` 中 ≥ 570 的行号在**当前工作树**上需 +4（那段新增了 `singlePct` 回填）。
>
> 审计范围：`src/client/{PrismPage.tsx, prismDeskMid.ts, prismDeskSide.ts, prismRefresh.ts, prismStateGate.ts}`、
> `src/host/{prismStore.ts, prismNews.ts, prismCorrection.ts}`。
> **`prismDeskTop.ts` 在本版不存在**——顶栏 / 底部状态条的纯函数实际在 `prismDesk.ts`
> （`prismDeskTop.test.ts:15` 也是从 `./prismDesk.ts` 导入），本审计按 `prismDesk.ts` 覆盖。

---

## 一、结论

**1 条 P0、8 条 P1、15 条 P2，合计 24 条。**

| 级别 | 条数 | 说明 |
|---|---|---|
| **P0** | **1** | 每屏必错的数字（口径错位，非崩溃、非写库） |
| **P1** | **8** | 一条"修复失效"、一条"旧覆盖新"、一条"错误被吞"、三条"必错/必空"、两条"资源放大" |
| **P2** | **15** | 持久化边界、a11y、防御性 |
| 合计 | 24 | |

一句话：**这个页面最贵的两个机制——"30s 回包指纹闸"和"内容判断"——一个因为 `asOf` 恒变而在生产里从未生效（白白多付 56ms/拍），另一个因为宿主固定追加的现金行而在主屏上恒错（持仓市值=总资产、浮动盈亏=—）；持久化侧 v0.224.1 已补齐 settings 的两个漏字段，剩下的问题不是"漏读"，而是"写入不校验、读回严过滤"，即"保存成功 ≠ 重启后还在"。**

---

## 二、方法与口径

- 读代码为主；对**真实落盘数据**（`$DSH_HOME/dsh-tradewatcher/`）做了实测：
  用 `node --experimental-strip-types` 直接加载本仓 `src/host/prismData.ts` 与 `src/client/prismDesk*.ts` 的纯函数，
  把真实 `prism-runs.json` / `prism-orders.json` / `prism-account.json` / `prism-equity.json` 喂进去，
  重建 `GET /tradewatcher/prism` 的回包并逐字段量字节。所有"实测"数字都可复现。
- 分级口径（沿用仓库既有审计）：**P0** 崩溃 / 必然错数 / 请求风暴 / 无界增长；**P1** 真实操作序列下的错误数据、白屏、稳定可感知的资源浪费；**P2** 余量、防御性、可维护性。
- 行号对 `a3c9972`（v0.224.1）成立。
- 术语：**回包** = `GET /tradewatcher/prism` 的 200 响应体；**桌面** = `desk.*` 六区块。

---

## 三、P0（1 条）

| # | 级别 | 问题 | 证据 | 影响 | 建议修法 |
|---|---|---|---|---|---|
| P0-1 | **P0** | **"持仓市值"这一格把现金也算进去了，等于把总资产当持仓市值显示；同一份 `rows` 又让"浮动盈亏"永远算不出来。** 宿主 `prismPositionViewOf` 在持仓列表末尾**固定追加一行** `{secid:'CASH', kind:'cash', marketValue: cash, pnl: null}`；客户端 `accountViewOf` 用 `sumOf(rows,'marketValue')` 无条件求和，于是 `mvSum = 股票市值 + 现金 = 总资产`。 | `src/host/prismData.ts:173-175`（追加现金行，`pnl: null`）；`src/client/prismDeskSide.ts:60-69`（`sumOf` 不区分 `kind`）、`:132`（`mvSum`）、`:146`（`label:'持仓市值'`，`title:'Σ 持仓市值（desk.positions.rows）'`）；`src/client/PrismPage.tsx:823-829` 把 `desk.positions.rows` 原样传进去 | **实测（本机真实数据）：持仓市值显示 `1,686,918.05`，真实股票市值 `1,250,621.76`，差额 `436,296.29` 恰好是现金——每一屏都多报 34.9%。** 用户据此判断仓位结构会系统性偏高；且 `浮动盈亏` 因现金行 `pnl:null` 恒为 `—`（见 P1-4），两个错一起出现，互相掩护。 | `accountViewOf` 增 `kind` 维度：`mvSum/pnlSum` 只汇总 `kind !== 'cash'` 的行；`title` 写明"不含现金"；总资产仍用 `overview.totalAssets`。**同时在 `prismDeskSide.test.ts` 的 fixture 里补一行 `kind:'cash', pnl:null`**——该文件 9 处 `accountViewOf` 调用共用 `REAL_ACCOUNT`，其 `rows` 只有一行股票（`marketValue:1_240_226, pnl:-217_746.32`）、**没有现金行**，而 `cash:342_027.68` 单独给（1,240,226 + 342,027.68 = 1,582,253.68 = `totalAssets`）。fixture 编码的是"rows 不含现金"的理想契约，**正好是宿主实际行为的反面**，这正是该 bug 一直没被测试抓住的原因。 |

---

## 四、P1（8 条）

| # | 级别 | 问题 | 证据 | 影响 | 建议修法 |
|---|---|---|---|---|---|
| P1-1 | P1 | **内容指纹闸在生产里从未生效：被哈希的是整个回包信封，而信封里的 `asOf` 每次都是 `Date.now()`。** `load()`/`refresh()` 把 `api.prismState()` 的**完整返回值**（`{ok, asOf, state, trading}`）交给 `push`，`stableTextOf` 遍历全部键 ⇒ 每拍指纹必然不同 ⇒ 必然 `setState`。 | `src/host/prismRoutes.ts:645` `send(res, 200, { ok: true, asOf: Date.now(), state: {...}, trading, modelCatalog, desk })`；`src/client/PrismPage.tsx:255` / `:280` `stateGateRef.current?.push(r)`（`r` 是信封）；`prismStateGate.ts:17-46` 对整包做稳定序列化 | **净效果比"没有闸"更差**：每 30s 不但照样全量重建 600–1000 个节点，还额外付一次整包字符串化。**实测：真实 1.51MB 回包单次 `stateSignature` ≈ 55.8ms**（本机 5 次均值），另分配约 1.5MB 字符串——落在交互窗口就是肉眼可见的掉帧。`clientPerfP2.test.ts:145-160` 的 fixture 里**没有 `asOf` 字段**，所以测试证明的是"内层对象能去重"，不是"生产能去重"。 | 只对 `r.state` + `r.desk` 建指纹（把 `asOf` 排除），或让宿主把易变信封字段单独放 `meta`；顺带把 `stateSignature` 换成对 `JSON.stringify` 结果的单路哈希（省掉键排序的递归）。**改完必须在 fixture 里加上 `asOf: Date.now()` 并断言"两拍内容相同 ⇒ 0 次 setState"。** |
| P1-2 | P1 | **静默刷新没有请求代号 / 没有 abort，"旧回包覆盖新状态"成立。** `load()`（写操作后触发）与 `refresh()`（30s 定时）走**同一条路由、同一个闸**，但闸只记"上一条推过的指纹"，不记"谁是新的"。 | `PrismPage.tsx:253-256`（load）、`:279-281`（refresh）、`:300`（`setInterval(() => gate.tick())`）；`prismStateGate.ts:63-72` 只比 `last` 签名，无代次 | 真实序列：t=0 定时拍发出 GET#1（1.66MB，慢）→ t=0.5 用户改持仓，POST 成功 → t=0.6 `load()` 发 GET#2 → t=1.0 GET#2 先回、落地新状态 → t=1.4 **GET#1 后回，签名不同 ⇒ 照样落地**，界面回退到改之前。窗口最长 30s；期间用户看到"刚删掉的持仓又出现了""刚改的股数变回去了"，而 `saving` 已复位、Modal 已关闭，**没有任何线索说明这是旧数据**。 | 复用仓里现成的 `src/client/requestGen.ts`：`load()`/`refresh()` 共用 `const gen = createRequestGen()`，每次取数 `const g = gen.next()`，落地前 `if (gen.stale(g)) return`（再叠 `AbortController` 更好）。闸只做"内容去重"，**排序交给代次**，两件事分开。 |
| P1-3 | P1 | **静默刷新把所有错误吞成 `undefined`，包括宿主 503 账本降级。** `refresh` 的 `.catch(() => undefined)`；而 503 的响应体里带着 `degraded:true` + `ledger` 详情，客户端一个字节都拿不到。 | `PrismPage.tsx:280` `.catch(() => undefined)`；`api.ts:328-330` `if (!res.ok \|\| payload.error !== undefined) throw new ApiError(...)`（**先抛，body 丢失**）；`prismRoutes.ts:580-600` 降级时 `send(res,503,{ok:false,degraded:true,error,ledger})` | 账本在页面开着的时候变坏（磁盘满、文件被改坏），30s 轮询每拍 503、每拍静默，**页面永久停在最后一次成功的数据上**且看起来一切正常。用户可能据此下单/改约束。这是本审计里"错误被吞"最贵的一条。 | ①`refresh` 至少 `catch((e) => setErr(...))` 而不要 `undefined`；②给 `requestWithTimeout` 加一个"非 2xx 也带回 body"的错误子类（`ApiError.body`），页面识别 `degraded` 后常驻一条横幅并停掉写按钮；③静默刷新失败计次，连续 N 次失败一律转为显性错误。 |
| P1-4 | P1 | **"浮动盈亏"恒为 `—`：现金行的 `pnl:null` 让"任一行缺失即不可算"的守卫退化成"永远不可算"。** `pnlSumOf` 的设计意图是"不部分求和"，但宿主保证**每一份** `rows` 都带一条 `pnl:null` 的现金行。 | `src/client/prismDesk.ts:143-151`（任一行非有限数 ⇒ 返回 null）；`prismDeskSide.ts:69,131,147`（同一个 `sumOf(rows,'pnl')`）；`PrismPage.tsx:485` `const floatSum = pnlSumOf(posRows)`（左栏"浮盈"合计）；`prismData.ts:174`（现金行 `pnl:null`） | **实测：`pnlSumOf(真实 rows) = null`。** 右栏"账户总览"的浮动盈亏格、左栏持仓卡底部的"浮盈"合计，两处恒为 `—`，而这恰是"人类只设边界"页面最该看的一个数。 | 与 P0-1 同一个修法：先按 `kind !== 'cash'` 过滤再求和。过滤后若仍缺价 ⇒ 才返回 null。加一条 fixture（含现金行 + 全有 pnl）断言合计等于各行之和。 |
| P1-5 | P1 | **添加 / 移除持仓的失败提示渲染在"资产上限"卡里，被 Modal 的遮罩盖住。** 全页只有一个 `saveErr` 渲染点，位于 `cap` 卡内部；`submitAdd` / `removePos` 都走 `run()` 写 `saveErr`，而 Modal 在失败时**不关闭**。 | `PrismPage.tsx:591`（唯一的 `saveErr` 渲染点，在 `cap` 卡片 JSX 内）；`:378-382` `run()` 的 `setSaveErr(...)`；`:391`（submitAdd 校验失败也写 `saveErr`）；`:1010-1016` Modal 不因 `saveErr` 关闭 | 添加持仓失败（代码不存在 / 股数非法 / 宿主返回 error）时：Modal 仍在、遮罩仍在，错误文字在**遮罩后面的左栏卡片底部**，用户看到的是"点了没反应"。移除失败同理。这是"保存失败提示"在真实路径上的完全失效。 | `run()` 增加 `modalErr` 状态，或让 `submitAdd` 自己维护错误并渲染在 Modal 内（`Field` 下方）；Modal 的 `onClose` 不应清错，但错误必须落在**当前焦点所在的可视层**。 |
| P1-6 | P1 | **`GET /prism` 不是只读的：每 30s 一拍都会触发一次金十抓取 + 一次 380KB 落盘；而且 backfill 的"完成"标志被下一行无条件覆盖。** `kickNews` 在 GET 处理器里被无条件调用，无在途守卫、无节流；`incrementalNews` 无论有没有新条目**都** `saveNews`（整份重写）。 | `prismRoutes.ts:360-365`（`kickNews`，`status.state==='ready' ? incrementalNews : backfillNews`，`void task.catch()`）；`:603`（每个 GET 都调）；`prismNews.ts:175`（无条件 `store.saveNews`）；`prismNews.ts:107` `if (pages >= PRISM_NEWS_PAGE_MAX) done = false`（**覆盖了循环内第 102 行刚设的 `done = true`**）；`prismStore.ts:299`（`updateJsonLocked` 整份重写） | ①每开一个棱镜页签，就是每 30s 一次上游请求（金十有 3s 页间隔纪律，但那是 backfill 内部，挡不住并发 kick）；②`prism-news.json` 380KB，**无新条目也每 30s 重写一次**（一个交易日 4h ≈ 480 次 ≈ 182MB 写放大）；③`done` 被覆盖 ⇒ 恰好第 10 页翻到 24h 边界的回填永远停在 `backfilling`，**下一拍再拉 10 页 × 3s**，形成每 30s 一轮的抓取循环——与文件头写的"失败留痕不重试"正好相反。 | ①`kickNews` 加进程级 `inFlight` 布尔 + 最小间隔（如 5 分钟）；②`incrementalNews` 在 `collected.length === 0` 时直接 return，不写盘；③`if (pages >= PRISM_NEWS_PAGE_MAX && !done) done = false`（保留循环内的完成判定）；④GET 处理器里把 `kickNews`/`recordEquity` 挪到 `res.end()` 之后或改成独立定时器。 |
| P1-7 | P1 | **回包实测 1.66MB（不是 900KB），且没有任何压缩 / 条件请求；其中 892KB（53.6%）是重复或零引用字段。** | 见 §七 实测表；`prismRoutes.ts:49-54` `send()` 只设 `content-type` + `cache-control: no-store`，**无 `etag` / 无 `last-modified` / 无 gzip**；`api.ts:305-314` 客户端 `cache:'no-store'` 也没带 `If-None-Match` | 每 30s × 每个开着的页签 ≈ 1.66MB 明文；`stateSignature` 再对它做一次全量序列化（P1-1）。口径上**比任务给的 900KB 高 1.8×**（我的重建不含 `exposure`/`evaluation`/`modelCatalog`，真实只会更大）。 | 见 §七：删 `reports`（-445KB）、删 `trading` 重复块（-261KB）、删 `desk.decisionFlow`（-111KB）、截 `summary`（-75KB）⇒ 降到约 772KB；再把 `analyses` 改成宿主预抽的 `three` ⇒ 约 325KB。另加 `ETag`（内容哈希）+ 304。 |
| P1-8 | P1 | **`threeOf` 在报告格式变化时静默降级，而且降级会把"别的段落"贴上"观察/推理"的标签。** 抽取只认行首、可选 `- * +` 列表符、`观察/推理/结论` 后必须紧跟冒号或行尾；抽不到就回落到 `依据→观察`、`判断→推理`。 | `prismDeskMid.ts:381`（标签正则 `^(?:[-*+]\s*)?(依据\|判断\|观察\|推理\|结论)\s*(?:[：:]\s*(.*))?$`）；`:444-461`（回退链）；`:459` 注释写"绝不用别的段落顶替"，但 `:455-456` 正是用 `依据`/`判断` 顶替 `观察`/`推理` | 报告格式一旦从「`- **观察**：…`」变成 `### 观察`（标题）、`\| 观察 \| … \|`（表格）、`1. 观察：`（有序列表）或 `**观察** …`（无冒号），抽取**全段落空**，界面把「依据」段当「观察」显示——**不是显示 `—`，是显示错内容**，且没有任何"抽取降级"标记。模型版本一换、提示词一调就可能发生，属于典型的"报告格式变化 ⇒ 静默降级"。 | ①正则放宽到标题 / 表格 / 有序列表；②**抽不到就返回 `FLOW_MISSING`，不要跨标签顶替**（跨标签顶替改成一个显式 `degraded:true` 标记，UI 在卡片角上写"抽取降级"）；③加一条"格式矩阵"测试：4 种格式 × 3 个标签。 |

---

## 五、P2（15 条）

| # | 级别 | 问题 | 证据 | 影响 | 建议修法 |
|---|---|---|---|---|---|
| P2-1 | P2 | `commitCapital` 用 `.then(() => ...)` 忽略 `r.ok`，`{ok:false}` 会被当成成功（清空输入 + 重新拉包）。当前路由用 400 抛错兜住，所以只是契约脆弱。 | `PrismPage.tsx:457-468`；`api.ts:593` 返回 `{ok, account}` 无 `error` | 路由一变返回 200+`{ok:false}`，改上限就"看起来成功但没生效"。 | 与 `run()` 统一：`if (!r.ok) setSaveErr(...)`。 |
| P2-2 | P2 | `load()` 失败只把**左栏**换成错误块，中栏 / 右栏继续渲染上一次的 `state`。 | `PrismPage.tsx:664`（`human = err !== null ? …`）；中/右栏在 `:975-978` 只看 `state === null` | 半页报错半页旧数，用户以为中右是新的。 | 错误态提升到根：`err !== null` 时中右栏加"数据已过期"蒙层。 |
| P2-3 | P2 | `isRun` 强制要求 `analyses` 是数组，导致 `loadRuns` 里"`reports` → `analyses`"的兼容分支**永远不可达**；反过来，只带 `reports` 的 run 会在重启时被整条丢掉。 | `prismStore.ts:341`（`Array.isArray(o['analyses'])`）；`:169-171`（`r.reports` 存在则原样用，否则由 `analyses` 映射——但 `analyses` 已被 filter 保证是数组） | 形状迁移做了一半：新写 `reports` 的调用方一旦不写 `analyses`，**历史 run 静默清零**（而 `PrismRun` 类型又强制要 `analyses`，所以这坑只在绕过类型时触发）。 | `isRun` 改成"`analyses` 或 `reports` 至少有一个是数组"；补一条"只带 reports 的文件能加载"的测试。 |
| P2-4 | P2 | `loadRuns` 的字段归一化（`day`/`at`/`reports`/`decision.rejects`/`parseError`）**只在启动时做**；`saveRun`/`replaceRun` 直接把运行期对象落盘。 | `prismStore.ts:165-175`（map 归一化）vs `:307-317`（save 不归一化） | 同一个 run 在"重启前"和"重启后"字段形状不同（例如重启后多出 `rejects: []`）。谁依赖"缺省即空"就会踩到。 | 抽一个 `normalizeRun(r)`，`loadRuns` 与 `saveRun` 都过一遍。 |
| P2-5 | P2 | **磁盘比内存多一个 `v` 字段**（写时 `{v:1, ...}`，读时丢弃）；且 `settings()` 走 `JSON.parse(JSON.stringify())`，`undefined` 值的键**在返回给客户端时被抹掉**（`gateBaseAt` / `lastAutoAt` 未设置时）。 | `prismStore.ts:195,204,218,230,238,247,258,271`（全部写 `v:1`）；`:178-180`（`settings()`）；`shared/prism.ts:25,45`（两字段 `?`） | 无害，但"未设置"与"字段不存在"在客户端不可区分；`v` 只写不读，等于版本号没有消费者。 | 要么读 `v` 做迁移分支，要么别写；对 `undefined` 用显式 `null` 表达"未设置"。 |
| P2-6 | P2 | **store 层写方法不校验，路由层校验**：`saveSchedule` 直接 `next.intervalSec = patch.intervalSec`；`saveCapital` 直接赋值；`saveIndustryLimits` 直接赋值；`saveConstraints` 直接合 patch。而 `loadSettings` 读回时**严格过滤**。 | `prismStore.ts:188-199, 216-222, 226-234, 236-242`（无校验）vs `:97-139`（读回校验） | **"保存成功 ≠ 重启后还在"**：绕过路由写入的越界值（`intervalSec:900`、`capital:0`、`industryLimits:{x:500}`、`maxDDPct:-5`）会在下次启动被静默换成默认，且没有任何日志。路由层现在挡得住，但这属于"只靠一层"。 | 把校验下沉到 store（或抽 `sanitizeSettings(patch)` 与 `loadSettings` 共用同一份规则），保证"写进去的 = 读回来的"。 |
| P2-7 | P2 | `times` 有两套正则：读回 `^\d{2}:\d{2}$`（放过 `99:99`），写入 `^([01]\d\|2[0-3]):[0-5]\d$`。 | `prismStore.ts:99` vs `:191` | 手改过的文件里 `99:99` 会被加载进内存并显示在状态条"决策周期"上，且永远无法通过 UI 再存一次（会被过滤）。 | 抽一个 `TIME_RE` 常量两处共用。 |
| P2-8 | P2 | **`PrismStore.quarantine()` 没有任何调用点**——文件头写的"坏文件先隔离（`.corrupt-*`）再重建"对 settings / news / runs **从未发生**。 | `prismStore.ts:319-329`（定义）；全仓 `grep quarantine` 只有 `src/index.ts:277` 调的是 `k.prismTrading.quarantine()`（**prismAccount**，不是 prismStore） | `loadJson` 读到坏 JSON 只 `markUnreadable` + 返回 null；下一次任何写操作都会**直接把原字节覆盖掉**，用户数据不可恢复。 | `init()` 里在三个 `load*` 之前调 `await this.quarantine()`；或在 `loadJson` 的 catch 里对 `SyntaxError` 直接 `quarantineFile`。 |
| P2-9 | P2 | `init()` 在第一个 `await` **之前**就把 `initialized = true`。 | `prismStore.ts:60-63` | `mkdir` 失败（权限/磁盘）后，同一进程内后续任何 `init()` 都直接返回 ⇒ 进程永久空库，且不会重试。 | 改成 `initPromise` 缓存（成功才置位），失败允许下次重试。 |
| P2-10 | P2 | **news 的时间解析有两套**：store 用 `Date.parse(t.replace(' ','T')+'+08:00')`，prismNews 用 `parseMarketStamp`。 | `prismStore.ts:147,294` vs `prismNews.ts:100,117` | 时间格式一变（如带 `+08:00` 后缀或 `T` 分隔），`Date.parse` 得到 `NaN` ⇒ 比较为 false ⇒ **内存里有的条目在下次启动被静默清空**。 | 统一走 `parseMarketStamp`，非法时间打一条 warn 而不是静默丢。 |
| P2-11 | P2 | `saveNews` 合并时**旧条目覆盖新条目**（`[...items, ...this.newsItems]` 之后 `Map.set` 后写胜），且写盘失败 `.catch(() => undefined)` 完全静默。 | `prismStore.ts:289-300`（`[...items, ...this.newsItems]`，`:295` `merged.set`，`:299` catch 空） | 上游更正同 id 的新闻正文，本地永远保留旧文本；写盘失败（磁盘满）无任何痕迹，与 settings 的 `markUnreadable` 不一致。 | 反过来 `[...this.newsItems, ...items]`（新条目胜）；catch 里 `markUnreadable`。 |
| P2-12 | P2 | 现金行参与"超单票上限"标红判定。 | `PrismPage.tsx:864` `const over = p.weight !== null && perStockSaved !== null && p.weight * 100 > perStockSaved`（`posRows` 含现金行） | 现金占比（本例现金/总资产 ≈ 25.9%）一旦超过单票上限（30% 时临界）会把"现金"标红成"超单票上限"，语义完全错。 | `over` 判定加 `p.kind !== 'cash'`。 |
| P2-13 | P2 | 行内编辑的键盘语义：整行是 `role="button"`，里面套 `<input>` 和菜单按钮；行的 `onKeyDown` 在**冒泡阶段**截获 Enter/Space 并 `preventDefault`。`⋯` 只有 `aria-haspopup`，没有 `aria-expanded`，也没有 Esc 关闭（只能点遮罩）。 | `PrismPage.tsx:603`（`role:'button', tabIndex:0`）、`:607-609`（`onKeyDown` 判 `Enter`/`' '` 后 `preventDefault`）、`:622`（`aria-haspopup` 无 `aria-expanded`） | 在股数输入框里按 Enter 会被行级处理器吞掉并触发"选中该股"；屏幕阅读器把整行读成一个按钮，输入框被当成按钮的一部分。 | 行容器改成 `role="row"`/`<li>`，把"选中"放到独立的按钮或 `onClick` 上；`onKeyDown` 里先判 `e.target === e.currentTarget`。菜单补 `aria-expanded` + Esc。 |
| P2-14 | P2 | 所有错误区（`tw-ad-err`、`tw-ad-rowerr`、`tw-ad-fielderr`）都没有 `aria-live`。 | `PrismPage.tsx:591,625-628,556` | 键盘 / 屏幕阅读器用户不会被告知"保存失败"，焦点也没被移到错误上。 | 错误容器加 `role="alert"`（或 `aria-live="assertive"`）。 |
| P2-15 | P2 | `prismCorrection`：**卖出订正只改 `cash` 与 `realized`，不改持仓 `netCost`/`cost`**（只有买入分支改）；多笔成交的委托只用 `group[0].price` 作为 `oldPrice`。 | `src/host/prismCorrection.ts:88-104`（`isBuy ? positions.map(...) : account.positions`）；`:61`（`oldPrice = group[0]?.price ?? …`）；注释 `:11` 写"持仓 netCost 同步扣减同一差额"但只对买入实现 | 卖出价订正后，剩余持仓的摊薄成本仍按**旧卖价**核算 ⇒ 下一次的浮盈/止损判定全部带偏；多笔分批成交时 `corrections[].oldPrice` 记的是首笔价，审计留痕不准确。 | 卖出分支同样按 `netCost -= delta` 调整（符号与买入相反，需按 `qty` 重算 `cost`）；`oldPrice` 改成按笔记录或记加权均价。 |

---

## 六、disk vs 内存字段差异（系统性清单）

结论先说：**v0.224.1 之后，`PrismSettings` 的 16 个字段在 `loadSettings` 里全部有读回路径**（`maxCumDDPct` / `gateBaseAt` 是本版补的），"漏字段"这一类在 settings 上**已清零**。
剩下的差异不是"漏读"，而是三类：**① 只写不读的 `v`；② 读取端比写入端严（保存成功≠重启还在）；③ 归一化只发生在启动时**。

### 6.1 `prism-settings.json`（写：`updateJsonLocked(path, () => ({v:1, ...settingsValue}))`）

| 字段 | 磁盘 | 内存 `PrismSettings` / 读回规则 | 差异与后果 |
|---|---|---|---|
| `v` | **有**（每次写都加） | **无**（`loadSettings` 不读） | 只写不读，版本号没有消费者（P2-5） |
| `times` | `string[]` | `^\d{2}:\d{2}$` 过滤；空 ⇒ 默认 4 档 | 写入正则更严（`^([01]\d\|2[0-3]):[0-5]\d$`）；`99:99` 能读进内存但写不回去（P2-7） |
| `intervalSec` | `number` | 只认 `300/600/1200/1800/3600`，其余 ⇒ `600` | **写端不校验**（路由校验）；绕过路由写 `900` ⇒ 重启变 `600`（P2-6） |
| `lastAutoAt` | `number` | `>0` 有限数，否则 `undefined` | `0` / `NaN` 静默丢 |
| `capital` | `number` | `>0` 有限数，否则 `PRISM_DEFAULT_CAPITAL`(1.5M) | `0` / 负数 ⇒ 重启回 1.5M |
| `participationRate` | `number` | `(0,1]`，否则 `0.1` | 越界 ⇒ 重启回默认 |
| `industryLimits` | `Record<string,number>` | 值须为 `0–100` 有限数，越界键**逐个丢弃** | 路由已校验；store 无校验（P2-6） |
| `model` | `{provider,model}` | 两者都是 `string` 才保留，否则 `null` | 半残对象 ⇒ 重启变 `null` |
| `lastFired` | `Record<day,string[]>` | day 须 `YYYY-MM-DD`，slots 过滤成字符串 | **`markFired` 只保留当天**（`prismStore.ts:255-257`）：文件里若有多天历史，第一次 markFired 就压成 1 天 |
| `perStockPct` `stopLossPct` `perOrderYuan` `maxPosPct` `maxDDPct` `minCashPct`（6 个） | `number\|null` | `numOrNull`：任意有限数（**含负数、含 0**） | 无范围校验；`-5` 能存能读，语义上等价于"反向阈值" |
| `maxCumDDPct` | `number\|null` | `numOrNull` | **v0.224.1 新补**（此前每次重启丢） |
| `gateBaseAt` | `number` | `>0` 有限数，否则 `undefined` | **v0.224.1 新补**（此前每次重启丢 ⇒ 回撤闸门基线失效） |

### 6.2 `prism-runs.json`（写：`{v:1, runs: runsValue}`）

| 字段 | 磁盘 | 内存 / 读回规则 | 差异与后果 |
|---|---|---|---|
| `v` | **有** | 无 | 只写不读 |
| `runs[]` 条数 | 全量 | `filter(isRun).slice(-20)`（`PRISM_RUNS_KEEP`） | 第 21 条往前**静默丢弃**；形状不符的**整条丢**（无日志） |
| `slot` / `startedAt` / `analyses` | — | `isRun` **强制**这三项 | 只带 `reports` 的 run 会被整条过滤掉（P2-3） |
| `day` | 可缺 | 缺 ⇒ `dayOf(startedAt)` | **只在启动补**；`saveRun` 不补（P2-4） |
| `at` | 可缺 | 缺 ⇒ `beijingIsoOf(startedAt)` | 同上 |
| `reports` | 可缺 | 缺 ⇒ 由 `analyses` 映射（`{role:a.label,text,error}`） | **该分支不可达**：`isRun` 已保证 `analyses` 是数组，所以"缺 reports"时永远走映射——但"缺 analyses"的 run 早在 filter 就被扔了（P2-3） |
| `decision.rejects` | 可缺 | 缺 ⇒ `[]` | 只在启动补 |
| `decision.parseError` | 可缺 | 缺 ⇒ `null` | 只在启动补 |
| 其余字段（`placement` `codeVersion` `mandateHash` `drawdown` …） | 任意 | `...r` 原样保留 | 无差异（新增字段不会丢） |

> **额外注意**：磁盘上 `reports[].text` 与 `analyses[].text` 是**逐字重复**的两份（实测 445,548 B vs 446,908 B，差的是 `role/label/key` 三个键名）。这既是持久化冗余，也是回包 1.66MB 的主因（§七）。

### 6.3 `prism-news.json`（写：`{v:1, status, items}`）

| 字段 | 磁盘 | 内存 / 读回规则 | 差异与后果 |
|---|---|---|---|
| `v` | **有** | 无 | 只写不读 |
| `status.state` | `string` | 必须是 `string`，否则**整块 status 丢弃**、退回 `DEFAULT_STATUS` | `items` 仍然加载 ⇒ "status 说 0 条、实际有 1011 条"的不自洽（`:149`） |
| `status.pages` / `fetchedAt` | 任意 | 类型不符 ⇒ `0` / `null` | 静默 |
| `status.reason` | 任意 | 非 `string` ⇒ `null` | 静默 |
| `status.items` | 数字 | **每次重算** = `newsItems.length` | 写回时覆盖（磁盘值无意义） |
| `items[]` | 数组 | `isNewsItem`：`id/time/text` 须 `string`、`important` 须 `boolean`；再按 24h 过滤 | 缺 `important` ⇒ 整条丢；时间解析失败 ⇒ `NaN >= cutoff` 为 false ⇒ 静默丢（P2-10） |
| `items` 顺序 | `saveNews` 按时间倒序 | `loadNews` 保持文件顺序 | 无差异（文件本就是倒序） |
| 合并语义 | — | `saveNews` 用 `[...items, ...this.newsItems]`，**旧值后写胜** | 上游更正同 id 正文 ⇒ 本地保留旧文（P2-11） |

### 6.4 `prism-skeleton.md`

纯文本，无字段差异。唯一的差异在**读失败路径**：非 `ENOENT` 的读错误 ⇒ `guard.markUnreadable` 且**不写默认骨架**（`:67-77`），下次 `saveSkeleton` 会用新内容覆盖不可读的文件——与 6.1/6.2 同一类"读不到就覆盖"的风险，但至少不会静默写默认值。

---

## 七、Top 5 可裁剪字段（实测）

口径：用本机真实落盘数据重建 `GET /tradewatcher/prism` 回包（`state` + `trading` + `desk`，`evaluation`/`exposure`/`modelCatalog` 置空，故真实值只会更大）。
**实测总计 1,664,584 B ≈ 1.63 MiB**（任务给的 ~900KB 偏乐观 1.8×）。回包无 gzip、无 ETag、`cache-control: no-store`。

| # | 字段 | 实测字节 | 占比 | 用途（谁在读） | 结论 |
|---|---|---|---|---|---|
| 1 | `state.runs[].reports[].text` | **445,548** | 26.8% | **客户端零引用**：`grep -rn reports src/client` 无命中；只有宿主 `loadRuns` 的兼容分支会看它 | **直接删**（或与 `analyses` 二选一） |
| 2 | `state.runs[].analyses[].text` | **446,908** | 26.8% | 决策流 ANALYZE 卡三要素的抽取源（`prismDeskMid.ts:538` `threeOf(a.text, r.summary)`） | 改由宿主预抽 `three`（约 3×200 字/run）⇒ 再省约 400KB |
| 3 | `trading.{account,orders,fills,equity,decision,prices,exposure,evaluation}` | **260,578** | 15.7% | 与 `state.*` **同一对象的第二次序列化**；页面只读 `state.*`（`PrismPage.tsx:340-343`、`:830`） | 删 `trading`，或让 `state` 引用它而不是复制 |
| 4 | `desk.decisionFlow` | **111,421** | 6.7% | **零引用**：`PrismPage.tsx:63` 只有接口声明，全客户端无读取；页面自己用 `flowEntriesOf` 从 `runs/orders` 重算 | **直接删**（宿主侧 `prismData.ts:468` 也就不必算） |
| 5 | `state.runs[].summary` | **74,846** | 4.5% | 仅作 `threeOf` 的**末位兜底**（`prismDeskMid.ts:459` `firstSentenceOf(summary)`） | 截到 200 字（只取第一句） |

- **合计可删 892,393 B（53.6%）** ⇒ 1.66MB → **约 772KB**。
- 再做第 2 条的"宿主预抽 `three`" ⇒ **约 325KB**（-80%）。
- 第 6 名（顺带）：`state.skeleton` **5,925 B**，客户端同样零读取（`grep '\.skeleton' src/client` 只命中一个测试文件）。`state.news` 只有 status（117 B），不含条目，不是问题。

---

## 八、建议修复顺序

1. **P0-1 + P1-4 一起改**（同一处 `rows` 过滤，一次改动消掉一个错数 + 两个恒 `—`），并补含现金行的 fixture。
2. **P1-2 → P1-1**：先上代次（消除旧覆盖新，风险最高），再修指纹口径（`asOf` 排除）。两者都改完，30s 刷新的网络/渲染才算真的收住。
3. **P1-3**：错误必须能被看见——这是"静默"类问题的总闸。
4. **P1-7（裁剪）+ P1-6（GET 去副作用）**：回包从 1.66MB 降到 ~772KB，同时把每 30s 的抓取/写盘停掉。
5. **P1-5 / P1-8 / P2-13 / P2-14**：交互与可访问性。
6. 其余 P2 按"持久化（P2-3/6/8/9/10/11）→ 展示（P2-1/2/12）→ 订正（P2-15）"分批。

## 九、本轮未做的事

- 未跑浏览器端真实交互（无 dev server 重启授权），DOM 层结论基于代码与既有测试断言。
- 未测 gzip/代理层压缩；1.66MB 是 `send()` 直出的明文长度。
- `prismDesk.ts` 只按顶栏/状态条相关函数抽查（`usageOf`/`weightOf`/`pnlPctOf`/`pnlSumOf`），未做全量审计。
- 未审 `prismAccount.ts`（85KB）与 `prismRoutes.ts` 的交易路径，只在需要证明调用链时引用其行号。
