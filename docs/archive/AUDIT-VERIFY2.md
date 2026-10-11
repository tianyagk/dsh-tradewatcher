# 独立验收报告（V2 批次 · 对抗验证）

> 验收人：`verify`（独立验收员）。立场：**证明实现者说错了** —— 全部结论基于我自己跑的门禁与我自己写的反例脚本，不引用 `docs/AUDIT-IMPL3.md` 的数字。
> 对象：`task-21`（V2 批次：2×P0 + 4×P1 + 文案统一 + 结构精简），工作区 v0.33.1，94 文件 +619/−2659。
> 临时脚本 `/tmp/tw-v3/`（跑完删除），写作用域仅本文件。

## 0. 结论：**有条件通过**（无 P0，建议修 D1 后提交）

- **两条 P0 的核心语义都真的修好了**：源 B 的生产口径（total 含停牌行）实测通过并如实报 `blank`；分页覆盖检查**独立生效**（少取一页 / 空页 / 少给行三种构造全部失败）；三格取值四组合全部符合预期。
- **精简没有删错**：`build.mjs` **零改动**、75 项片段一项未删；16 处"含约束词的被删行"逐条核实**全部仍被承载**（无约束句被误删）；M 档 6 项逐项确认未被碰；被删组件/函数在删前确实零引用。
- 但对抗过程中挖出 **1 条既有缺陷（D1，P1）** 与 **4 条低危发现（D2–D5）**，其中 D1 属"分页完整性检查失效 + 异常路径"，不产生错数（被覆盖检查与路由 catch 兜底），**不构成 P0**，故不写"不应提交"。

## 1. 门禁实测（我自己跑的）

`npm run check`，exit=0，日志 `/tmp/tw-v3/check.log`：

```
ℹ tests 225  ℹ pass 225  ℹ fail 0     # 第一轮（本机时区）
ℹ tests 225  ℹ pass 225  ℹ fail 0     # 第二轮（TZ=UTC）
ALL HOST CHECKS PASSED (live probes soft)
built lib/index.js + lib/client.js （v0.33.1，客户端片段校验通过：75 项）
```

交叉验证（防漏跑）：`src/*/*.test.ts` 共 **31 个文件**，逐文件 `test()` 计数合计 **225**，与运行数完全吻合。

## 2. P0-2 源 B：生产口径与"少取一页"（重点反例）

关键前提（我读代码确认的**真实取数通道**）：`em.fetchClistPctPage`（`em.ts:1796-1808`）把无涨跌幅行**保留为 `rows` 里的 `null` 占位**，不用 `CountPage.blank` 字段。因此反例必须用 `null` 占位构造（用 `blank` 字段构造会走出另一条分支，见 D2）。

| 构造 | 期望 | 实测输出 | 判定 |
| --- | --- | --- | --- |
| ① 3 页 ×（4 有效 + 2 无涨跌幅），total=12 | 通过 + `blank` 如实 | `{up:5,down:6,even:1,total:12,scanned:12,blank:2,pages:3}`，checks：`扫到的原始行数 14（上游总数 12）`／`另有 2 行无涨跌幅，未计入` | ✅ |
| ② `sanityOfCounts({up:5,down:5,even:5,total:12,scanned:12})` | 失败 | `{ok:false,reason:'三类之和（15）与有效行数（12）不一致，按失败处理'}` | ✅ |
| ③ **少取一页**（第 3 页抛错） | 失败 | `counts:null`，reason：`只扫到 8 行 < 总数 12 行，分页可能被截断，按失败处理` | ✅（覆盖检查独立生效） |
| ④ 少取一页（第 3 页返回空） | 失败 | `counts:null`（同上） | ✅ |
| ⑤ 每页只给 2 行（覆盖不足） | 失败 | `counts:null`，reason：`首页只有 2 行而总数 12 行（上游分页行为异常）` | ✅ |
| ⑥ 探索：上游 total 少报（报 10、实际 12） | —— | `{total:10, up+down+even:12}` **被发布**（sanity 未校验 `total == scanned+blank`）→ 见 D3 | ⚠️ 观察 |

**对"如果把等式放宽到 scanned，少取一页会不会被放过"的直接回答：不会。** 覆盖检查（`rawSeen < total`）与 `missingPages` 检查在**等式之外独立存在**；③④⑤ 三种"少取"构造全部失败，且失败原因都来自覆盖/首页检查而非等式。⑥ 的例外是"上游 total 本身少报"，属基准不可自证的固有限制（且 `total` 不进 `/breadth` 回包，见 D3）。

## 3. P0-1 三格取值：四组合

`pickBreadthCounts(cells, current)`（`client/breadthView.ts:95-106`）：

| 组合 | 期望 | 实测 | 判定 |
| --- | --- | --- | --- |
| ① `countsOk=true` + 有 current | 指数口径 | `{up:1000,down:800,even:50,from:'index'}` | ✅ |
| ② `countsOk=false` + 有 current | 自统计 | `{up:2000,down:1800,even:100,from:'self'}` | ✅ |
| ③ 两者皆无 | 三格全 `—` + 原因 | `{null,null,null,from:'none'}`；原因：`沪市上涨家数、…未取到（备用源不含涨跌家数字段…）` | ✅ |
| ④ 两者都有但数值不同 | 取哪个 / 会不会跳 | 采用 `index`（1000/800/50）；自统计（900/900/100）被忽略 | ✅ 取指数口径，**同一时刻不会在两份数之间来回跳** |

关于④的"数字跳变"：跳变只发生在**来源切换**（指数口径从可用↔不可用）时 —— 这是"口径不同导致的一次性跳"（指数口径与自统计口径本来就不是同一件事），实现用 `· 自统计 HH:mm:ss` + title/aria 全文把两者区分开（`MarketPage.tsx:231-241`），属可接受的设计选择；但它意味着**用户可能在一次刷新间看到数字变化而不知为何**，属已知代价。

## 4. P1 四项

| 项 | 实测输出 | 判定 |
| --- | --- | --- |
| P1-1 传 12 天 + `limit=5` | `have=['09-08'…'09-12']`（5 天）、`breaks=5`、`points=15`，且 `09-07` 不出现 | ✅ |
| P1-1 `limit=1` | `have=['2026-09-12']`、`points=3` | ✅ 不越界、不空 |
| P1-1 `limit=99`（> 实际 12 天） | `have.length=12`、`points=36` | ✅ |
| P1-2 `sessionDay` 到渲染点 | `em.ts:1051-1052` 在 `expired \|\| from==='lkg'` 时写入 `TrendData.sessionDay` → `/tradewatcher/trend` 回包直接透传 `trend`（`routes.ts:524`）→ `cacheNoteOf` 消费（`chartNote.ts:83-84`）→ `QuoteDrawer.tsx:323` | ✅ 真到渲染点，非只进 state |
| P1-3 YTD `stale/source` 到渲染点 | `ytdTooltip` 第 4 参 `prov` 在 `WatchlistPage.tsx:451/453`（`ytd.stale/ytd.source`）与 `PortfolioPage.tsx:1070/1073`（`props.ytdStale/ytdSource`，由 `:465-466` 传入）**都传了** | ✅ 真到渲染点 |
| P1-4 排序入口 | `pickSortEntry`：`wide+visible→header`；`wide+hidden / wide+量不到 / narrow→bar`；页面接线 `entry==='bar' ? SortBar : entry==='header' ? SortHeader`（`WatchlistPage.tsx:181/271`、`PortfolioPage.tsx:257/339`）→ **结构上恰好一个** | ✅ |

## 5. 精简：没有删错

**5.1 `build.mjs` 零改动** —— `git diff --stat -- build.mjs` 输出为空，`git status` 无记录；构建 75 项片段校验通过 ✅（片段表一项未删）。

**5.2 红线段落扫描（被删行含「不许/必须/红线/不变量/否则/宁可」）**：命中 **16 行**，逐条核实**全部仍被承载**（无约束丢失）：

| 被删行（节选） | 约束当前的承载位置 |
| --- | --- |
| `家数可能是**本插件自己统计**出来的…来源与统计时刻必须与上游给的能区分开` | `MarketPage.tsx:231-241` 的 `countsTitle` + `· 自统计 HH:mm:ss` |
| `'刷新失败时必须优先说明这点，不能只写"本地缓存"'`（旧断言消息） | 新断言 `chartNote.test.ts:18` `assert.equal(stale, fallback, '刷新失败与 LKG 兜底必须同一句话')` |
| `宿主回了 last-known-good（staleAt 有值）⇒ …必须把日期说清` | `chartNote.ts:80`（原句保留） |
| `年内上市必须写成"上市首日至今"…`（旧断言） | 文案改写为新形态后由 `ytdView.ts:34` + `ytdView.test.ts` 锁定（`本年内上市，基准为上市首日`） |
| breadthCount 的"顺序不变量自检/每页非递增/和必须等于 total"三行 | `breadthCount.ts:142-144`（保留）+ `:303` + `sanityOfCounts` 实现 |
| `无效字段不算数（不许当 0）` | `breadthCount.ts:56` `pctOf` 注释 + 实现 |
| `源 B 是全量扫页（扫过的行数必须 ≥ 总数）…` | `breadthCount.ts:71`（`fullScan` 注释）+ `:411` 覆盖检查 |
| `只有沪/深有"多日分钟"源…不许静默把当日当五日画` | `em.ts:1304`（原句保留） |
| `序列末端必须贴近 evalAt（maxLagMs）` / `为什么必须卡这两个边界` | `rescue.ts:589` 附近（原句保留） |
| `缺失不许编码成 0` | `shared/model.ts:118` + 三处断言 |

唯一"当前 0 次命中"的是 `刷新失败时必须优先说明`（旧断言消息），其约束由上面那条新断言等价替代 ✅。**结论：没有约束句被误删**（也不构成 P0）。

**5.3 被删的 guard 代码行（非注释）** 共 5 条，全部是被替换的措辞或属已删的零引用函数：
- 2 条是 `sanityOfCounts` / 覆盖检查的**旧措辞**（新实现改为"有效行数"/`rawSeen` 版本）；
- `if (rows.length === 0) return null` 属已删的 `fetchTencentQuotes`；`if (hits.length === 0) return null` 属 S3 删掉的零引用碎片；`throw new Error('HTTP … from qt.gtimg.cn')` 同为 tencent 旧解析。

**5.4 零引用核实**：HEAD 版 `charts.tsx` 中 `PriceText`/`MultiDayTrend`/`CandleChart` 各出现 **1 次**（仅定义，无内部使用）；HEAD 版 `tencent.ts` 中 `fetchTencentQuotes` 出现 **1 次**（仅定义）→ 删前确实零引用 ✅。当前 `Sparkline`/`MiniTrend`/`CandleBar` 等按 M1 存活 ✅；`TencentQuote` 保留（当前 9 处引用）✅。

**5.5 M 档 6 项逐项确认未被碰**：
| M 档项 | 证据 |
| --- | --- |
| `breadthCount` 护栏与源 C 算法 | `sanityOfCounts`（含 `fullScan`/`sumEquals`）、`countFromSortedPctPages` 全文在（含"全正必须新取最后一页证明"等不变量） |
| `charts.tsx` 存活部分 | `Sparkline`/`MiniTrend`/`polylinePath` 仍在；仅三个零引用组件被删 |
| `ACTOR_TOOL` 与 `store.ts` 历史兼容 | `shared/model.ts:841` 常量在；`store.ts` 仍以 `raw.actor === 'tool' ? 'tool' : 'web'` 兼容旧数据 |
| `breadthView` 分量缺失规则 | `breadthCells` 的"任一分量缺失 ⇒ 三格全 null"未变 |
| `styles.ts` 单次替换语义 | `cssInjectAction` 三态（append/replace/skip）+ `existing.textContent = TW_CSS` 仍在 |
| `RescuePanel` 本地格式化 | 本地 `fmtX`/`fmtYi`/`fmtPct` 仍在（仅时间格式改引共享 `fmtStamp`） |

## 6. 文案统一扫描

| 检查 | 实测 | 判定 |
| --- | --- | --- |
| `涨跌家数不可用` / `无可用行情（现价缺失）` / `统计于` / `判定于` / `暂无可用行情源` | 各 **0** 处 | ✅ |
| `toLocaleString` 默认输出（形如 `2026/10/9`） | **0** 处（残留调用全部带 locale/options） | ✅ |
| `上次成功数据` | 各出现处都带 `（MM-DD HH:mm）` 或明确短形（日期不可知时），K 线日线档只到天 | ✅ |
| `观测时刻` | **14 处**：13 处为注释/内部命名，1 处**用户可见** → `quoteState.ts:80` | ⚠️ D5 |
| `缓存数据（上游暂不可用）` | **1 处，用户可见** → `QuoteDrawer.tsx:317` | ⚠️ D4 |
| `本次刷新失败` | 3 处，均为注释/断言（文案里已删） | ✅ |

## 7. 缺陷与发现

### D1（P1，既有缺陷、非本轮引入）分页完整性检查失效 + 异常路径

`countBreadthFromClist`（`breadthCount.ts:406-410`）：

```
const missingPages = pages.filter((p) => p === undefined).length
```

`pages` 由 `new Array(pageCount)` 创建（**稀疏数组**），未取到的页是**空槽**，而 `Array.prototype.filter` **跳过空槽** → `missingPages` 恒为 0 → 该分支不可达。

**复现（实测）**：

```bash
node --test --experimental-strip-types /tmp/tw-v3/adversarial2.test.ts   # ③-b 用例
```

- 构造：`pageSize=4`、`total=12`、page1 返回 8 行、**page2 抛错**、page3 返回 4 行 ⇒ `rawSeen = 12 ≥ total` ⇒ 覆盖检查放行 ⇒ 进入 `countFromClistPages` 遍历到空槽 ⇒ **`TypeError: page is not iterable`**（`breadthCount.ts:116`）。
- 另一形态（③）：覆盖不足时**结果正确失败**，但原因永远是"只扫到 X 行 < 总数 Y 行"，`firstError`（"第 N 页取数失败：…"）**永远不出现** —— 逐页诊断丢失。
- 机制断言：`new Array(3).filter((x) => x === undefined).length === 0`（已实测）。

**后果**：不产生错数（异常被 `/tradewatcher/breadth` 的 `try/catch` 接住 → `fail(res,error)`；覆盖检查是第一道有效防线）。但"分页不完整"这条独立检查实际上从未生效，且极端组合下会让整条 `/breadth` 失败（连带分位/快照一起消失）。

**修法**：`const missingPages = pages.some((p) => p === undefined)`（`some` 不跳过空槽），或把 `new Array(pageCount)` 改为 `Array.from({ length: pageCount }, () => undefined)`；建议同时把 `firstError` 并入失败原因。

**归因**：HEAD 版 `breadthCount.ts:388-391` 已有同样写法 → **不是本轮引入**，本轮也未触碰该文件（未在 M 档被碰判定之内）。

### D2（P3）`CountPage.blank` 契约不一致

`countBreadthFromClist` 用 `rawRows()` 消费 `page.blank`（覆盖检查正确），但 `pages[pn-1] = got.rows` 把 `blank` 丢弃 → `counts.blank` 只统计 `rows` 里的 `null`。当前唯一取数方（`em.fetchClistPctPage`）用 `null` 占位，**行为正确**；若将来接入"已丢弃无涨跌幅行"的取数方，`blank` 会少报（覆盖检查仍正确）。建议把 `blank` 一并传进页数组。

### D3（P3）`sanityOfCounts` 不校验 `total == scanned + blank`

实测⑥：上游 total 少报（报 10 / 实际 12）时发布 `{total:10, up+down+even:12}` 自相矛盾的数据。当前 `total` **不进** `/tradewatcher/breadth` 的 `current` 回包（只取 up/down/even/amount/source/checks），故不达界面；建议补一条一致性检查以免将来 `total` 出口时踩。

### D4（P3，文案未统一）K 线抽屉仍有旧形态降级文案

`QuoteDrawer.tsx:317` 仍拼 `· 缓存数据（上游暂不可用）`（用户可见），而同一函数 `:323` 又拼 `cacheNoteOf(payload)` → 同一条脚注可能同时出现**两个降级口径**（如 `… · 缓存数据（上游暂不可用） · 上次成功数据（10-08 15:00）`）。这与自述"删掉 …与 `· 缓存数据（上游暂不可用）`"不符。建议删掉 `:317` 那一段，统一交给 `cacheNoteOf`。

### D5（P3，文案未统一）tooltip 里仍有"观测时刻"

`quoteState.ts:80`：`\`${base}\n观测时刻在刷新间隔内，视为实时\``（用户可见 tooltip，`base` 行已用"数据时刻"）。与自述"`观测时刻` 说法已消除"不符。建议改为「数据时刻在刷新间隔内，视为实时」。

## 8. 未验证

1. **渲染层**：P1-4 的"人为清空 `<style>` 后仍恰好一个入口"只验证了 `pickSortEntry` 逻辑与页面接线结构（`entry` 单一决定），真实 DOM 量测（`useSortEntry` 的 `getComputedStyle` 分支、resize 监听）**未在浏览器跑过**；三格/占比的实际观感、D4/D5 文案的最终排版同样未目视。
2. **上游真实行为**：按要求不探活；源 B 的 `blank` 通道、`total` 少报等上游异常均为注入构造。
3. `npm run check` 的 live 探针全程 soft（本机上游不可达）。
4. **未审查面**：本轮还有大量文案压缩与注释迁移（`docs/DECISIONS.md` 81 块），我只按任务给定的关键词与用词表抽查，未逐块比对语义等价。

## 9. 复现

```bash
npm run check                                                  # §1
node --test --experimental-strip-types /tmp/tw-v3/adversarial2.test.ts   # §2/§3/§4（临时脚本，跑完删除）

# D1 最小复现（Node REPL，实测输出）
node -e "const pages = new Array(3); pages[0]=[1,2]; pages[2]=[3,4]; console.log(pages.filter(p=>p===undefined).length, JSON.stringify(Array.from(pages)))"
# → 0 [[1,2],null,[3,4]]     ← filter 跳过空槽，missingPages 恒为 0

# D1 异常路径（真实模块，实测输出）
node --experimental-strip-types -e "import('./src/host/breadthCount.ts').then(async (m)=>{await m.countBreadthFromClist(async (pn)=>{if(pn===2)throw new Error('boom');return pn===1?{rows:[5,4,3,2,1,0,-1,-2],total:12}:{rows:[-3,-4,-5,-6],total:12}},{pageSize:4})}).catch(e=>console.log(e.constructor.name, e.message))"
# → TypeError page is not iterable
```
