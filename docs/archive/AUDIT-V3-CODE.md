# 简洁审计第二轮：精简与残迹（v0.38.2 · HEAD `e9d4cb5` · 只读）

## 0. 现状测量（数字均为实测，命令写在表格里）

| 指标 | 命令 | 本轮 | 上轮 | 差 |
|---|---|---|---|---|
| client 实现行 | `find src/client -type f \( -name '*.ts' -o -name '*.tsx' \) ! -name '*.test.ts*' \| xargs wc -l \| tail -1` | 10,219 | 9,802 | +417 |
| host 实现行 | 同上，`src/host` | 12,619 | 12,918 | −299 |
| shared 实现行 | 同上，`src/shared` | 1,577 | 1,568 | +9 |
| 入口 | `wc -l src/index.ts` | 79 | 88 | −9 |
| **实现合计** | 四者相加 | **24,494** | 24,376 | **+118** |
| 测试文件 | `find src -name '*.test.ts' \| wc -l` | 34 | 29 | +5 |
| 测试用例 | `grep -rnE "^[[:space:]]*test\(" src --include=*.test.ts \| wc -l` | 264 | 211 | +53 |
| 断言 | `grep -rn "assert\." src --include=*.test.ts \| wc -l` | 1,234 | 1,001 | +233 |
| 测试行 | 三个目录 `wc -l` 相加（test 文件） | 4,270 | 3,624 | +646 |
| ≥8 行注释块 | `/tmp` 脚本遍历 `/\*\*…\*\*/` 计数 | **69 块 / 626 行**（历史型 47，最长 11 行） | 109 / 1,172（历史型 69，最长 21） | **−40 / −546** |
| 行注释 `//` | `grep -rnE "^[[:space:]]*//" $(find src -type f \( -name '*.ts' -o -name '*.tsx' \) ! -name '*.test.ts*') \| wc -l` | 791 行 | — | — |
| `docs/` | `wc -l docs/*.md` + `wc -l docs/archive/*.md` | 13 份 3,161 行 + archive 4 份 1,433 行 | 9 份 2,187 行 | +4 份 +974 |
| README / CHANGELOG | `wc -l README.md CHANGELOG.md` | 427 / 797 | 410 / 495 | +17 / +302 |
| 源码总变更 | `git diff --shortstat b815c6c..HEAD -- src` | 99 files, +2,269 / −1,505 | — | — |

**增减来自哪里**：`git diff --name-status b815c6c..HEAD -- src` 显示**新增 9 个文件**（`badgeView` 70 + `chartCursor` 275 + `chartNote` 92 + `sessionAxis` 185 四个模块 = 622 行实现，另 5 个测试文件 505 行），**删除 1 个**（`SortHeader.tsx`）；存量文件里 `charts.tsx` 433→248（上轮 S1 落地）、`SortBar` 63→46、`em.ts` 2110→2059、`rescue.ts` 1943→1916、`styles.ts` 473→464 在缩，而 `kline.tsx` 780→986（+206，时段网格 + 细节卡片/十字光标）、`MarketPage.tsx` 493→529 在涨。所以：**host/shared 与旧模块在缩，client 新增面集中在"图表交互"**。

**上轮 S1–S9 执行核查**：S1 ✓（三组件已删，仅余 `CandleBar` 类型）、S2 ✓（`fetchTencentQuotes` 已删）、S3 ✓（旧碎片已清）、S4 ✓（`shared/model.ts:924 LEDGER_VERB_LABEL`）、S5 ✓（`shared/model.ts:957 MISSING_TIER_LABEL`）、S7 部分 ✓（`model.ts:945 numOrNull` 已入 shared，仍有 3 处本地版）、S8 ✓（注释块 109→69，过程叙述迁 `docs/DECISIONS.md` 81 块）、S9 ✓（4 份已入 `docs/archive/`）；**S6 ✗、S10 ✗**（见 §4）。

## 一、可安全精简（收益＝行数估计）

**S1 布局回退残迹：`data-span` 死分支（−6 行）**
位置 `src/client/RescuePanel.tsx:374`＋`span` prop 类型（`:261` 起）｜现状 `...(props.span === undefined ? {} : { 'data-span': props.span })`，但唯一调用点 `MarketPage.tsx:301` **不传 span**，且 `grep -rn "data-span" src` 只此一处、`styles.ts` 里已无 `[data-span]` 选择器（v0.33.1 回退删净）⇒ 该分支永不可达｜建议 删 prop 与展开分支｜判据 全仓 `data-span` 命中 1 处；`tw-board/tw-metric/tw-idxcard/tw-distbar/boardLayout` 在 `src/` **零命中**（回退清理是干净的，别去动 CSS）｜验证 装机打开大盘页护盘面板（布局与现状一致）。

**S2 列头排序删除后的整块死模块：`useWide.ts`（−63 行激进 / −33 行保守）**
位置 `src/client/wide.ts`(19)、`src/client/useWide.ts`(33)、`src/client/wide.test.ts`(30)｜现状 `grep -rn "useWideLayout\|isWideWidth\|layoutModeOf\|WIDE_MEDIA_QUERY" src` 的全部命中只有：三个文件自身、`styles.test.ts:26` 的**断言文案**、`styles.ts:114` 的注释。即 `useWideLayout` 零生产调用，`wide.ts` 的三个导出仅测试使用 ⇒ 删除 v0.36.0 列头排序后，这整套"宽窄判定"已无消费者｜建议 **保守**：删 `useWide.ts` + `wide.test.ts` 中 hook 相关断言，`wide.ts` 只留 `WIDE_MIN_PX`（供 `styles.test.ts` 读 CSS 断点）；**激进**：三文件全删，`styles.test.ts` 的断点断言改为"CSS 内部所有 `min-width` 必须相同"｜判据 生产引用计数 0（已逐符号核）；**注意** `styles.test.ts:26` 那句"互斥应由 useWideLayout() 决定"会变成指向不存在函数的文案，删 hook 时必须同步改｜验证 双时区测试（`npm test` 等价命令，不跑 `check`）。

**S3 `SortBar` 迁移后留下的空注释壳与过时断言文案（−4 行）**
位置 `src/client/SortBar.tsx:1-2`（`/**` 后紧跟 `*/`，S8 迁移走正文只剩壳）、`styles.test.ts:18-27` 的断言文案｜现状 空块注释 2 行；`data-wide-hide` 互斥断言**规则形状**仍有效（防重引入隐藏式互斥），但文案前提（两个排序控件二选一）已不存在｜建议 删空注释；断言保留、文案改为"CSS 不得用 `display:none` 承担互斥（排序入口现只有段控一处）"｜判据 空注释无正文；断言对象 `data-wide-hide` 在 `src/` 零命中｜验证 `node --test src/client/styles.test.ts`。

**S4 零引用导出 5 个（−34 行）**
位置 `ACTOR_TOOL`(`model.ts:855`)、`SortColumn`(`sort.ts:55`)、`fmtDate`(`format.ts:120`)、`CandleBar`(`charts.tsx:235`)、`shortLabel`(`format.ts:97`)｜现状 前四个由脚本 `node /tmp/dsh-v3-exports.mjs` 判定"生产+测试均 0"；**`shortLabel` 是脚本盲区**（被 `portfolio.ts:22` 注释提及而未被判零），人工 `grep -rn shortLabel src` 确认只有定义 + 那句注释 ⇒ 同为死码｜建议 删 `SortColumn`/`fmtDate`/`CandleBar`/`shortLabel`（含 `portfolio.ts:22` 那句指向它的注释）；`ACTOR_TOOL` 按 M7 处置（见 §2）｜判据 逐符号 grep 命中仅定义处；`CandleMarker`/`SparkMarker` 等仍被 `kline.tsx`/`QuoteDrawer.tsx` 引用，**不在删除范围**｜验证 双时区测试 + `npx tsc --noEmit`。

**S5 原子写抽公共模块（上轮 S6，−35~45 行）**
位置 `grep -rn "\.tmp" src/host` → `store.ts:453`、`writeLog.ts:73`、`calendar.ts:358`、`trendArchive.ts:183`、`breadth.ts:128`、`rescue.ts:1018`｜现状 六处同形（`mkdir → writeFile(tmp) → rename`，缩进一律 `JSON.stringify(x, null, 1)`）；`writeLog.persist()` 与 `calendar.persist()` 除一行 `slice(-KEEP)` 外**逐字相同**｜建议 抽 `src/host/persist.ts`：`atomicWriteJson(dir, path, value)` + 一个串行链小类（`writeChain = run.catch(...)` 三处重复）｜判据 六处结构一致、差异只有"截断保留条数"与错误吞并策略（做成参数/保留在调用方）｜验证 `routes.test.ts`＋`ledger-skip.test.ts`＋`calendar.test.ts`＋`store.test.ts`，再手工改一次自选确认 `watch.json` 无 `.tmp` 残留。

**S6 数值判定剩余 3 处本地实现（−12 行）**
位置 `em.ts:176`（本地 `num`，65 次调用）、`bottom.ts:37`（类型守卫版）、`rescue.ts:654`（`const num = numOrNull` 纯别名）＋`breadthView.ts:31`｜现状 shared 已有 `numOrNull`(`model.ts:945`)/`isFiniteNumber`(`:996`)，上轮 S7 只做了一半｜建议 三处统一引 shared（`bottom.ts` 的 `v is number` 守卫保留其类型收窄写法）；**红线**：`sina.ts:17`、`tencent.ts:31` 的**字符串解析版不得合并**（CHANGELOG v0.34 记有实测："合并会把整片行情判成 null"）｜判据 逐处比对实现体语义｜验证 全量双时区测试 + `node src/host/selftest.ts`（`em.ts` 是行情解析热点）。

**S7 `PortfolioPage` 的动词表别名层（−3 行）**
位置 `PortfolioPage.tsx:30-33`｜现状 `const VERB_LABEL = LEDGER_VERB_LABEL` + `verbLabel()` 包装，而 shared 已有同表｜建议 直接用 `LEDGER_VERB_LABEL[verb] ?? verb`（或从 shared 直接导出 `verbLabel`）｜判据 两份逐字同源（上轮 S4 已合并）｜验证 流水弹窗动词列 + `tradewatcher_ledger` 输出。

**S8 `HH:mm` 取法三处本地 slice（−3 行，一致性收益）**
位置 `RescuePanel.tsx:399`、`:607`、`:634`（`new Date(x).toTimeString().slice(0, 5)`）｜现状 客户端已有 `format.ts:83 fmtClock`（`HH:mm:ss`），这三处各自 slice 成 `HH:mm`；`tw-right`（`styles.ts:186`）是全局唯一未被任何 src 引用的 CSS 类，可同行清理｜建议 在 `format.ts` 加 `fmtHhmm()` 供三处复用；删 `tw-right`｜判据 `grep -rn "toTimeString().slice" src/client` 命中 3 处；`grep -rn "tw-right" src` 命中定义处｜验证 装机打开护盘面板（时间列显示不变）。

## 二、不可精简（会出事）—— 重新确认

**上轮 M1–M11 逐条状态**（防下一轮误删，全部仍有效）：M1 `charts.tsx` 存活部分（`Sparkline`/`MiniTrend`/`polylinePath` + 类型）**仍禁删**；M2 `breadthCount` 护栏与源 C → 见下方 M1；M3 `breadthView` "任一分量缺失 ⇒ 整格 `—`"（`breadthView.ts:8-11` 注释为据）**不变**；M4 `styles.ts` 单文件 + `cssInjectAction` → 见 M3；M5 逐标的缓存槽 + 三处 LKG **不变**；M6 `quoteState` 四态 / M7 `MISSING_TIER_ADVICE`+`ACTOR_TOOL` / M8 `model.ts` 契约 → 见 M5；M9 客户端≠工具文案 → 见 M6；M10 `RescuePanel` 本地格式化 → 见 M8；M11 `kline.tsx` 不拆 → 见 M4。以下是本轮证据更新与新增条目：

**M1 家数护栏与源 C 整块（`breadthCount.ts`，仍是最易误删项）**：`sanityOfCounts`(`breadthCount.ts:68-101`)＋`countFromSortedPctPages`(`:147-333`)＋6 条用例。**最新状态**：上轮要求的三处收口**已完成**——`breadthCount.ts:483-486` 已写明"⚠ C 档当前未接线"、`README`「涨跌家数」已有"第三条链路算法与用例已实现但未启用"；`routes.ts:311` 仍只传 `clistPage`（确认未接线）。**因此它现在是"有据可查的通用件"，不是误导性死码**；处置仍为二选一（接线/删除），且接线时注释里留了一步**算法内改动**（"把 `down` 改成边界页独立计数"）。**注意**：该注释有一处缺字病句"并按 把 `down` 改成…"，属可修瑕疵（1 行），但**别顺手重写整段**。

**M2 `BADGE_DETAIL_MAX`(`badgeView.ts:35`) 与 `sessionMinutes`(`sessionAxis.ts:59`) 不是死导出**：生产不引用、测试引用——它们是**断言判据**（"悬停提示 ≤32 字，超了会被宿主截断成 …""港股时段总长 330 分钟"）。删掉它们，断言就失去锚点，护栏静默消失。

**M3 `styles.ts` 仍不可拆、`cssInjectAction` 仍不可退化成只 append**：热重载时旧 `<style>` 仍在文档里（`styles.test.ts:30-37` 就是为它写的）；CSS 现 464 行 / 134 个类，**未使用类只有 1 个**（`tw-right`，`styles.ts:186`，可与 `.tw-muted`/`.tw-dim` 同行清理）——回退后清理到位，别再按"行数大"去拆。

**M4 `kline.tsx`（986 行）仍不可拆、且新增的 `sessionAxis`/`chartCursor`/`trendView` 三者**没有**重复实现**：`kline.tsx:11-12` 已 import `sessionAxis`/`nearestIndex`/`tipPlacement`/`trendReadout`/`klineReadout`；`compressedAxis`(`:68`) 是"无时段表市场"的**有意回退路径**（美股/国际/期货不硬编码时段），与 `sessionAxis` 并存是设计，不是重复。**均价/基准确证也没有第二份实现**：`trendView.ts` 的 `isUsableAvg`/`isUsableBaseline` 被 `mini.ts:5`、`TopBar.tsx:14`、`RescuePanel.tsx:19` 共享引用（v0.35.1/v0.36.1 两次修复的产物，已收敛到一处）。

**M5 `quoteState` 四态命名、`MISSING_TIER_ADVICE`/`MISSING_TIER_LABEL` 两档、`model.ts` 的宿主/客户端契约地位**：同上轮，无变化（本轮新代码也在用：`badgeView.ts` 区分 `dayPnlPct === null`（无持仓行情）与真 `0`，正是同一约定的延续）。

**M6 客户端文案 ≠ 工具文案**：`ytdView.ts:34` 与 `tools.ts:499` 的"基准 {日期} 收盘 {价}"仍各自表述、共享 `YTD_CALIBER`/`FQ_LABEL`；强行统一只会让一侧变差。

**M7 `ACTOR_TOOL`(`model.ts:855`) 与 `store.ts:71` 的 `actor === 'tool'` 读入兼容**：读入那行**必须留**（历史文件里的 `actor:'tool'` 不能被改写）；常量与 `tools.ts:349` 的渲染分支仍无写入者，二选一（接线 / 连常量一起删并把兼容注释改成"仅兼容历史值"）。

**M8 `RescuePanel` 的本地 `fmtPct`/`fmtYi`/`fmtX` 不与 `format.ts` 合并**：语义不等价（`▲1.23%` vs `+1.23%`；`fmtYi` 固定"亿"且不在 `moneyMasked` 遮罩出口内）。

**M9 `shortLabel` 删除时不要"顺手统一"到 host 的 `MARKET_LABEL`**（`portfolio.ts:23`）：二者**语义不等价**——`shortLabel` 按 secid 数字前缀给 `'沪深'/'市场'`，`MARKET_LABEL` 按 `Market` 枚举给 `'A股'/'未知市场'`。`shortLabel` 可删（S4），`MARKET_LABEL` 留。

## 三、建议但风险较高（需单独一轮）

**R1 三处 LKG 抽象为 `LkgStore<T>`（上轮 R1，−120 行）**：`em.ts` 的 `quotes`/`board`/`trend` 三套 load/persist/note 同形，TTL(45s/10s/5s)、上限(1500/40/400)、键大小写策略不同；抽象必须把差异参数化并保留"键统一大写"。**风险**：搬错会双份缓存（上游请求翻倍）。
**R2 `PortfolioPage.tsx`（1,195 行）拆 7 个 Modal（−约 600 行搬运）**：props 明确，但要排在 `DESIGN-DASHBOARD` 相关改动之后。
**R3 自选/持仓两页行提示统一**：先抽纯函数再谈合并。
**R4 `em.ts`（2,059 行）拆 `em-lkg.ts`/`em-board.ts`**：先做 R1 再谈。

## 四、上轮未做两项的复议

**S6（原子写抽出）：仍值得做** —— 六处仍在、`writeLog`/`calendar` 两处逐字相同、收益 −35~45 行、风险低（纯搬运、有 4 个测试文件覆盖）。**建议本轮做**。
**S10（测试文件归并）：降级为"可选低收益"** —— 文件数从 29 涨到 34，但新增的 4 个模块各自独立成对（`badgeView`/`chartCursor`/`chartNote`/`sessionAxis` 各有测试），符合"一模块一测试"；真正的历史包袱只剩 `p0.test.ts`(286)/`p1.test.ts`(75)/`p1b.test.ts`(255)——按审计批次命名、共 616 行、跨 4 个模块。**建议**：只把这三个并成 `regressions.test.ts`（或把用例按模块拆入 `portfolio.test.ts`/`em-fallback.test.ts`），文件数 34→32、收益 −30 行样板；**若不做，请明确关闭该项**，不要第三次挂着（上轮至今未动）。

## 五、`docs/` 处置（13 份 3,161 行 + archive 4 份 1,433 行）

- **留**：`README.md`、`CHANGELOG.md`、`docs/DECISIONS.md`（1,326 行，被 `README.md:359` 引用；建议按"决策/按文件的历史过程"分两段并给目录——它内含已删文件 `SortHeader.tsx` 的分节，属正常历史）、`docs/ROADMAP.md`、`docs/COMPETITOR-NOTES.md`。
- **必须加抬头**：`docs/DESIGN-DASHBOARD.md`(147) —— 它描述的是 v0.33.0 的 12 栏 `.tw-board` 方案，而 **v0.33.1 已按用户要求回退**（`src/` 里 `tw-board`/`boardLayout` 零命中）。该文件现在**没有任何"未落地"标注**，是下轮最容易照着改回去的坑。建议在标题下加一行：**"状态：未落地（v0.33.1 布局回退，源码已无 `.tw-board`）—— 仅供口径参考，勿据此重构"**。
- **归档**（移入 `docs/archive/`，共 1,359 行）：`AUDIT-V2-CODE.md`(92)、`AUDIT-V2-FUNCTION.md`(96)、`AUDIT-FUNCTION.md`(140)、`AUDIT-UI.md`(138)、`AUDIT-COPY2.md`(89)、`AUDIT-IMPL3.md`(325)、`AUDIT-IMPL4.md`(80)、`AUDIT-IMPL5.md`(222)、`AUDIT-VERIFY2.md`(177)。判据：文件头写着"报告对象版本/任务号"的一次性产物，结论已进 CHANGELOG。
- **索引**：`README`「开发」补一行"历史审计与逐轮实现记录见 `docs/archive/`（按版本号命名）"；本轮三份 `AUDIT-V3-*` 交付后同样归档，只把结论摘要写进 CHANGELOG。

## 六、验证通则

改完统一跑：`npx tsc --noEmit -p tsconfig.json` ＋ `node --test --experimental-strip-types "src/**/*.test.ts"`（本机时区）与 `TZ=UTC` 各一遍（= `npm test`，**不跑 `npm run check`**，它会写 `lib/`）＋ `node src/host/selftest.ts`；界面改动另需装机点开大盘页/自选/持仓/抽屉各一次。本轮全部结论为静态阅读 + 上述统计脚本（脚本在 `/tmp`，已在收尾时删除）。**本机 `rg` 不可用**（`command -v rg` 无输出），表中所有计数由 `grep`/`wc`/`node` 脚本等价实现。
