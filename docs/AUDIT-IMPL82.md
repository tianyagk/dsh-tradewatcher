# AUDIT-IMPL82 — 第 8 行 `fupan`（复盘）**宿主侧**实现与断言

> **本文件是当批（v0.111.0 开发期）的实测记录，不是设计稿**：所有读数来自本轮真实运行，
> 命令与输出摘要都在文末。行号/用例数会随代码演进漂移，**以代码与 `npm run check` 读数为准**。

## 1. 结论（一行）

第 8 行 `fupan` 的宿主侧已落地：**行注册四处 + manifest 一致**、**存储走 `updateJsonLocked` 且读失败拒绝写回**、
**两条路由归 `fupan`（core 不兜底）**、**上限逐条留痕**、**交易日标注复用既有判定链**、**零新增上游请求**；
门禁 **`npm run check` 连续两轮全绿**：`typecheck` 通过、`920 用例 × 2 时区` 全过（920/920、0 fail）、
`selftest` 全过、`build` **73 项**片段校验通过。**`build.mjs` 未改**。

## 2. 交付清单（只碰宿主/文档，未碰 `src/client/**`）

| 文件 | 变更 | 说明 |
| --- | --- | --- |
| `src/host/fupan.ts` | **新增**（约 520 行） | 笔记存储（`FupanStore`）+ 纯函数（归一/增改删/上限裁剪）+ 整月视图的交易日标注 |
| `src/host/routes.ts` | +111 行 | `makeTradeRoutes(...)` 加第 8 个可选参数 `fupan`；新增两条路由 `fupan/month`、`fupan/note` |
| `src/index.ts` | +37 行 | `RowId` 加 `'fupan'`；`ROW_ROUTES.fupan`/`ROW_TOOLS.fupan`；`rowOf` 白名单；`CoreKernel.fupan`；两处 `makeTradeRoutes(...)` 传内核实例 |
| `cordis.patch.yml` | +16 行 | 第 8 行 `tradewatcher-fupan`（`config: { row: fupan }`）+ 行注释清单 + 头部"八行"口径 |
| `docs/DESIGN-SUBPLUGINS.md` | +17 行 | §2.1 表加 `fupan` 行、§2.2 调用方证据两行、路由账 26→28 |
| `src/index.test.ts` | +24/+2 例 | 八行镜像（`EXPECTED_ROWS`/`FUNCTION_OWNED_PATHS`/副本/applies 计数）+ 两个新用例（四面镜像注入、归属注入） |
| `src/rowOwnership.test.ts` | +2 行 | `ROW_OF_FILE` 加 `'FupanPage.tsx': 'fupan'`；`ROW_KEYS` 加 `'fupan'`（让归属推导真的核对新路由） |
| `src/host/fupan.test.ts` | **新增**（16 例） | 存储/路由/上限/交易日历/零上游，每条判据配反例注入 |
| `locale/rows/fupan/{en,zh}.json` | **新增** | 行标题 `dsh-tradewatcher-fupan`（英文）+ 中文描述 |
| `package.json` | +2 exports | `./rows/fupan`、`./rows/fupan/locale/*`（否则 `readPluginMeta` 解析不到标题） |
| `README.md` | +1 行 | 「### 数据文件」表补 `fupan.json`（`src/client/uiuxDiscipline.test.ts` ⑥ 的覆盖扫描要求） |

**未动**：`build.mjs`、`src/client/**`（第 7 个页签由 `impl-fupan-ui` 交付）、profile、`~/.dsh`。

## 3. ① 行注册：四处落点（+ manifest 行 = 五处证据）

| 落点 | 位置 | 内容 |
| --- | --- | --- |
| ① 真表（唯一事实源） | `src/index.ts` 的 `ROW_ROUTES.fupan` | `['/tradewatcher/fupan/month', '/tradewatcher/fupan/note']` |
| ② patch 行注释 | `cordis.patch.yml` 的 `#   tradewatcher-fupan → row: fupan …` | 同上两条（**分开写成两个反引号 token**：该解析器把 `` `/a|b` `` 的 `b` 补成 `/tradewatcher/b`，嵌套路径会被补错） |
| ③ 文档 §2.1 表 | `docs/DESIGN-SUBPLUGINS.md` | `` | `fupan` | `/tradewatcher/fupan/month` `/tradewatcher/fupan/note` | **无** | … | `` |
| ④ 测试副本 | `src/index.test.ts` 的 `ROW_ROUTES_FOR_TEST.fupan` / `ROW_TOOLS_FOR_TEST.fupan` | 同上 + `[]` |
| ⑤ manifest 行 | `cordis.patch.yml` | `- id: tradewatcher-fupan` / `name: 'dsh-tradewatcher/rows/fupan'` / `config: { row: fupan }` |

三个连带的"账目"必须同时改，否则既有断言会红（已全部改到绿）：

- `EXPECTED_ROWS` 加第 8 行（顺序锁死，core 仍必须第一）；
- `FUNCTION_OWNED_PATHS` = 真表并集（26→28 条）；
- 文档「路由账 **28** = core 15 + calendar 1 + watchlist 3 + portfolio 2 + market 4 + cloudmap 0 + tools 1 + fupan 2」；
- `apply` 次数 8 → **9**（core 两次 + 七个功能行各一次），两处 `__kernelStats.applies` 都对。

### ⚠ 客户端源不变量（这个坑本插件踩过，新行照样适用）

`dsh-client-modules` 只把**裸包名**当客户端加载源；功能行的 `name` **必须**是
`dsh-tradewatcher/rows/<row>`（子路径 ⇒ 不参与 client 注册、但能解析自己的 locale 标题）。
所以：**有且只有 core 一行用裸包名**。这条由三处在守：`checkManifest` 的"必须恰好一行用裸包名"、
`localeMetaViolations` 的标题命名不变量、以及本批新增的 `fupanMirrorProblems`（把功能行写成裸包名 ⇒ 红）。

## 4. ② 存储：`<DSH_HOME>/dsh-tradewatcher/fupan.json`

```json
{ "v": 1, "notes": [
  { "id": "f…", "date": "2026-10-20", "text": "…", "pinnedTo": "2026-10-27", "source": "manual", "at": 1760000000000 }
] }
```

| 口径 | 实现 | 为什么 |
| --- | --- | --- |
| 写入 | **`updateJsonLocked`**（进锁 → 读磁盘最新 → 改 → 原子写回） | 拿内存快照整份覆写会在并发/双进程下丢更新（`lock.ts` 文件头记的就是这个事故）。实测：两个 `FupanStore` 实例各写一条，**两条都在** |
| 读取 | `ReadGuard` + `isFirstBoot` | 只有 `ENOENT` 才是"本来就没有"；`EACCES/EIO/EISDIR` ⇒ `markUnreadable`，本次启动**拒绝写回** |
| 写失败 | 进锁**前**先 `assertWritable`（锁内再判一次，纵深防御） | 锁内第一步是读磁盘，读失败的裸 fs 错误对用户只是噪音；先在门口给"读不到 ⇒ 拒绝写回"的明确消息 |
| 坏 JSON | `quarantineFile` 改名隔离（**保留原字节**）后从空开始 | 与 `store.ts`/`calendar.ts` 同口径；用户还能人工抢救 |
| 单条正文 | ≤ **4000 字**；超限 **400 拒绝** | 截断=改用户内容 ⇒ 不做。错误消息里写明字数与上限 |
| 条数 | ≤ **2000 条**；超限按「最久未更新」（`at` 最小）丢弃 | 置顶（`pinnedTo` 非空）的**最后**才丢：那是用户对未来的承诺 |
| 文件体积 | ≤ **512 KB**（序列化后，与 `writeJsonAtomic` 同口径） | 与已有数据文件同量级；超限同上丢弃 |
| 丢弃留痕 | `dropped: { notes:[{id,date,at,reason}], count, reasons:[中文整句] }` | **不得静默**：界面要能逐条显示"丢了哪几条、为什么" |
| `at` 语义 | = **最后一次写入时刻**（更新会刷新） | schema 只给一个时间字段；不再加 `createdAt` 让两份时间互相漂移（"最旧" = 最久没动过） |

装载阶段**不裁剪**（只在写入时裁剪并留痕）：装载时丢东西等于"没有写入也丢数据"，那是另一类事故。

## 5. ③ 路由

### `GET /tradewatcher/fupan/month?ym=YYYY-MM`

回包：`{ ym, asOf, source: 'local:fupan.json+calendar:trading-calendar.json', stale:false, notes[], dates[], totals{}, calendar{}, calendarWhy, notesUnreadable, notesQuarantined, invalidEntries, missing[] }`

- `dates[]` 覆盖该月**每一天**（28–31 条）：`{ date, count, hasPinned, trading, closedReason }`。
  - `count` = **写在这天**的笔记条数；`hasPinned` = **有笔记钉到这天**（未来日期也有角标，与 `count` 无关）。
  - `trading`/`closedReason` 来自 **`tradingDayState`**（周末 → 外部覆盖文件 → 内置假日表，一处实现）。
- `calendarWhy`：`null` = 该月真的按外部文件判定；否则是**非空中文原因**，分三档：
  文件不存在 / 文件不合法 / 未覆盖该月；另有第四档披露既有判定链的一个真实怪癖：
  `monthCoveredByFile()` 要求文件"覆盖**当前**月"才生效 ⇒ 文件声明了未来某月时，该月这次仍按内置表判定，
  这句话会如实写进 `calendarWhy`（不假装按文件判的）。
- `totals`：`notes`（该月**可见**笔记数 = 写在本月 + 钉到本月）、`pinned`、`writtenHere` / `pinnedIn`（两个分项，
  `writtenHere` 恒等于 `sum(dates[].count)`，所以两套数不会互相打架）、`days`、`daysWithNotes`、`daysWithPinned`、`tradingDays`。
- 「读不到 ≠ 没有」：读失败 ⇒ `notes: []` 但 `notesUnreadable` 非空 **且** `missing[]` 有一条说明。

### `POST /tradewatcher/fupan/note`

body：`{ op: 'upsert'|'delete', id?, date?, text?, pinnedTo?: 'YYYY-MM-DD'|null }`

| 情况 | 结果 |
| --- | --- |
| `upsert` + `id` 未命中 | 用调用方给的 id **新建**（客户端可自带 id 做幂等重试；不给则由 store 生成 `f…`） |
| `upsert` + `id` 命中 | 更新；`at` 刷新；`pinnedTo` 未传 ⇒ 保留原值；传 `null` ⇒ 清除置顶 |
| `id` 命中但 `date` 不符 | **409**（"按 (date, id) 定位失败"——想换日期请先删再建，不让一条笔记静默换日） |
| `delete` 命中 | 200，`removed: 1`，回包里 `notes` = 该日剩余笔记 |
| `delete` 未命中 | **404**（不静默成功） |
| 正文 > 4000 字 / 空正文 / 日期格式错 / `op` 不认识 | **400**，逐字段给原因 |
| 非 POST | **405** |

回包：`{ ok, asOf, source:'local:fupan.json', op, id, removed, date, ym, notes[], dropped{}, month:{ym,dates,calendar,calendarWhy}, notesUnreadable, notesQuarantined, missing[] }`
（`month.dates` 只是省一次往返，与 GET 走同一个 `fupanMonthView`，不会互相矛盾。）

## 6. ④ 可选导入：**本批未接线**（明确原因，不是半成品）

- **逻辑骨架已就位**：`FupanNote.source` 已区分 `'manual' | 'import'`（归一/存储/回包都带这个字段），
  未来导入的笔记直接落 `source: 'import'`，界面可据此标注来源。
- **HTTP 路由 `POST /tradewatcher/fupan/import` 本批故意不注册**，原因是一条**硬约束**冲突：
  `src/rowOwnership.test.ts` 按**真实调用点**推导路由归属 —— 声明在 `ROW_ROUTES.fupan` 里的每条路由
  必须有且只有一个消费行。本批客户端只做「月历 + 当日笔记 + 钉到未来日期」（`impl-fupan-ui` 明确回复
  不做 Markdown 导入 UI），没有消费点 ⇒ 若注册并声明，归属断言会红（"未找到调用方"）；
  若不声明，则 `core` 会兜底注册它（`core` 注册所有未被声明的路径）⇒ 复盘行关不掉，违背"行未激活 ⇒ 路由天然 404"。
- 要接上下次需要**三处同批**：客户端加 `api.fupanImport` + 一个按钮调用点；`ROW_ROUTES.fupan` 加
  `'/tradewatcher/fupan/import'`；四处镜像 + 文档路由账 +1。宿主侧只剩"把 handler 写进 `routes.ts`"这一步。
- 安全口径（下次实现必须遵守，已写进任务卡）：**只读**用户指定文件；读失败必须给原因（不得当"没有复盘"）；
  路径必须在**显式配置**的允许目录内（默认**不允许**任何目录），非法路径 ⇒ 拒绝并给原因。

## 7. ⑤ 断言 + 反例注入（真实读数）

| # | 判据 | 位置 | 真实读数 | 反例注入 ⇒ 必败 |
| --- | --- | --- | --- | --- |
| 1 | 行注册**四处 + manifest** 一致 | `index.test.ts`：「第 8 行 fupan：四处镜像一致…」 | `fupanMirrorProblems(真实) === []`；真表 = 那两条；`ROW_TOOLS.fupan = []` | 5 种：只改测试副本 / 只改文档 / 只改 patch / 改 manifest 的 `config.row` / 功能行写成裸包名 ⇒ 各自非空且原因命中 |
| 2 | 路由归属 = `fupan`（core 不兜底、别的行不抢） | `index.test.ts`：「两条路由归属 = fupan…」 | `fupanOwnershipProblems(src) === []`；运行时 core 注册表里 `/tradewatcher/fupan` 前缀**0 条**，fupan 行**恰好 2 条** | ① 从 fupan 行删掉（= 归 core）② 塞进 market 行 ⇒ 均非空 |
| 3a | 写入走**文件锁** | `fupan.test.ts`：双实例丢更新 + 锁被占 + 静态判据 | 两实例各写一条 ⇒ 磁盘两条都在；锁被"活进程"占住 ⇒ 150ms 有界失败且**文件一字节未变**；`fupanWritePathProblems(fupan.ts) === []` | 直接 `writeFile` / 把 `updateJsonLocked` 换成 `writeJsonAtomic` / 去掉 `assertWritable` ⇒ 均非空 |
| 3b | **读失败 ≠ 空** | `fupan.test.ts`：EISDIR 注入 | `readState().unreadable` 含 `EISDIR`；`write()` 拒绝；路由 200 + `notesUnreadable` + `missing[0].note` 含"读不到" | 把 `unreadable` 当 `null`（= 假装"就是没有"）⇒ 断言失败 |
| 4 | 上限生效且 `dropped` 留痕 | `fupan.test.ts`：纯函数两档 + 落盘一例 | 2005 条 ⇒ 丢 5 条（`notes-limit`，id 恰为最旧 5 条）；60×4000 中文字 ⇒ 丢到 ≤512 KB（`file-size-limit`）；置顶的老笔记**没**被先丢；落盘后仍 ≤512 KB 且刚写的还在 | 把 `dropped` 换成 `[]`（静默丢）⇒ 断言失败 |
| 5a | 交易日标注来自**交易日历** | `fupan.test.ts`：`2026-10-01` | 宿主：`trading=false`/`closedReason='国庆节'`；`2026-10-09`=`true` | "只信周末"重算 ⇒ 10-01 变 `true` ⇒ 与真实不一致 |
| 5b | 外部文件**优先** | `fupan.test.ts`：当前月挑一个"内置表认为是交易日"的工作日写进外部日历 | `trading=false`/`closedReason='外部日历（手工维护）'`；`calendar.covered=inForce=true`；`calendarWhy=null` | 只看内置表 ⇒ 该日变 `true`（前置断言 `holidayOf(closure)===null` 保证非空跑） |
| 5c | 覆盖不足必给 `calendarWhy` | `fupan.test.ts`：`calendarWhyProblems` | 未覆盖月份 ⇒ 非空、点名该月、含"内置" | `null` / `''` / `0` / `'   '` ⇒ 四种注入均非空 |
| 6 | **零新增上游请求** | `fupan.test.ts`：运行时 fetch 计数 + 静态源检查 | 两个接口各跑一遍（含一次真实写入）⇒ `fetch` 调用 **0 次**；`fupanUpstreamProblems(fupan.ts, monthHandler, noteHandler) === []` | 加一句 `await fetch('https://push2.eastmoney.com/x')` ⇒ 非空；改成 `await em.fetchQuotes(...)`（换条路发请求）⇒ 也非空 |

判据本身也配了"非恒真"证明：每个注入都是**真的改到了输入**（`assert.notEqual(mutated, base)` 先过），
再要求判据非空且原因命中预期正则 —— 避免"注入没生效 ⇒ 断言空跑"的假绿。

## 8. 门禁读数（本轮）

`npm run check` = `typecheck` + 测试两轮（本地时区 / `TZ=UTC`）+ `selftest` + `build`。**落地编辑完成后连续跑了 2 轮，两轮同读数**：

| 环节 | 读数（两轮相同） |
| --- | --- |
| `tsc --noEmit` | **通过**（0 error） |
| 用例（本地时区） | **920 / 920 通过 / 0 失败** |
| 用例（`TZ=UTC`） | **920 / 920 通过 / 0 失败** |
| `npm run selftest` | `ALL HOST CHECKS PASSED (live probes soft)` |
| `npm run build` | `built lib/index.js + lib/client.js （v0.110.0，客户端片段校验通过：73 项）` |

- **基线 890** ⇒ 现在 **920**（+30：宿主 `fupan.test.ts` 16 例 + `index.test.ts` 2 例 + 客户端 12 例）。
- 过程记录（诚实留痕）：第一次跑全量时 `markdownScan` 抓到 **2 处** Markdown `**` 泄漏 ——
  `src/host/fupan.ts` 的 `**当前月**`（宿主侧，本批已改成「当前月」）与 `src/client/fupanView.ts` 的 `**未知**`
  （客户端侧，已通知 `impl-fupan-ui` 并已由其修好）。修完两处后两轮全绿 —— 也就是说这条守卫在本批是**真起作用**的，
  不是走过场。

## 9. 概念参考声明

功能概念（"月历 + 当日复盘 + 钉到未来"）参考第三方插件 `dsh-fupan`（MIT）。
**未拷贝其任何代码、样式或文案**：本批宿主代码全部为本仓库既有风格的独立实现
（存储/锁/守卫/口径披露都沿用 `store.ts`/`calendar.ts`/`lock.ts`/`readGuard.ts`/`tradingCalendar.ts` 的既有机制），
客户端（另一路交付）的样式命名与结构同样独立。未新增任何依赖。

## 10. 未做项与已知限制（诚实清单）

1. **导入路由未接线**（见 §6）：逻辑骨架 + 安全口径已定，等客户端有消费点再一次性加（三处同批）。
2. **`at` 只有一个时间**：更新会刷新它 ⇒ "最旧" = 最久未更新，不是"最早创建"。若要按创建序丢，需要加字段（会让两份时间漂移，本批不做）。
3. **外部日历的"仅当月生效"怪癖（既有链路遗留，未改）**：`monthCoveredByFile()` 要求文件覆盖**当前**月才生效，
   所以未来月份的休市安排要等它成为当月才被采信。宿主不擅自改这条链（会同时改掉护盘采样的判定），
   而是把这件事写进 `calendarWhy` 让用户看得见。
4. **单条超长是拒绝而非截断**：界面需要提示用户精简（400 的 message 已写清字数与上限）。
5. **未 commit、未发版、未重启 `dsh web`、未安装**：按任务约束，本轮只落源码与断言。
   `dsh web` 的真实装载（第 8 行 `fiberPhase=active`、`/tradewatcher/rows` 含 `fupan`、关行后 404）**待装机验证**。
6. 客户端页签（第 7 个「复盘」）由 `impl-fupan-ui` 交付；两侧契约（路由字面量、回包字段、`dates` 恒给 `trading`）已对齐并互相确认。
