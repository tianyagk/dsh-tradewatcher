# REVIEW-1-REDUNDANCY —— 冗余与死代码审计

- **审计对象**：`dsh-tradewatcher` @ `6f4382e`（main，v0.74.0）。176 个 `src/**/*.ts(x)`，其中 107 个非测试代码文件、1013 个导出符号。
- **只读声明**：未改任何源码、未 commit、未装 bundle、未动 profile、**未重启 `dsh web`**。唯一写入面＝本文件。所有 npm/tsc 类检查都在隔离副本 `/tmp/r1-wt`（`git worktree add 6f4382e`，`node_modules` 为只读软链）里跑，工作区未执行任何构建。
- **风险刻度**：`风险 = 执行「建议动作」的风险`，1（无引用、删了即回归）→ 10（可能改变用户可见行为或用户数据）。
- 并行审计产物 `docs/REVIEW-3-DOCS.md`（未跟踪，本会话期间出现）**不计入本仓库内容**，本报告不引用它作为证据。

## 结论先行

| # | 结论 | 数量 |
|---|---|---|
| 1 | **真死导出**（全仓 grep 仅命中声明行本身） | **9 条** |
| 2 | 仅测试引用的导出（测试锚点，**保留**） | 50 条 |
| 3 | 仅本文件引用的导出（export 关键字冗余，非死代码，建议保留） | 223 条 |
| 4 | `src/` 里无人引用的文件 | **0 条**（仅测试、`selftest.ts`＝npm 脚本入口、`.child.ts`＝动态 spawn、`env.d.ts`＝环境声明） |
| 5 | 零消费方的文件 | **1 条**：`scripts/rescue-thresholds.json`（0 读取方，却随包发布） |
| 6 | 重复逻辑簇（同一算法/格式化/骨架被写 ≥2 份） | **9 簇** |
| 7 | 生产侧死数据：`model.ts` 死字段 **2 个**（454 个字段逐个三向统计）＋ 死 CSS 类 **4/217** | 6 条 |
| 8 | **过期注释/文档失配** | **15 条**（含 README 6 条、`src/` 注释 5 条、失效引用 3 条） |
| 9 | **30/176 个文件有内容被删空的文件头 `/** */`**（30/30 在创建提交处是**非空**文档块，git 可证） | 1 类 |
| 10 | `build.mjs` 锁着"已删功能/永不可能出现"的片段 | **0 条**（73/73 片段仍在客户端生产代码里解析得到）；另有 1 条弱锁 + 1 个冗余转义分支 |

**优先修 5 条（风险最高、最省事）**：① README 仍在描述 **v0.62.0 已删除的"自绘云图"**（`README.md:77-82` + `:422`）；② 30 个空文件头，其中 `marketTime.ts:24` 明写"理由见文件头"而文件头是空的；③ 护盘量能变色门槛 **1.63 硬编码 vs 标定值 1.57**（`RescuePanel.tsx:218`）；④ `FQ_NOTE` 死常量＋与 `FQ_LABEL` 重复；⑤ `removeLockFileSync` 死函数＋注释谎称"退出钩子在用"。

---

## 0. 方法与判据

1. **导出级**：自研扫描器（`/tmp/r1-scan/unused-exports.mjs`）逐文件抽 `export function|const|class|type|interface|enum` 与 `export {}`，对每个符号做**全仓词边界计数**（`src`＋`locale`＋`README`＋`docs`＋`build.mjs`＋`cordis.patch.yml`），分三类：`其他文件命中 0`（死）／`仅 *.test.ts 命中`（测试专用）／`仅本文件命中`（export 关键字冗余）。
   - ⚠ **中途修过一个自研工具的假阳性**：初版正则带 `(?<![\w$.])`，会把 `em.lastBarOfKline(...)` 这类**限定名引用**判成 0 引用（`lastBarOfKline` 曾被误列死代码，实际 `src/host/routes.ts:377` 在用）。修正后 `zero-ref` 从 10 条收敛到 **9 条**；下文 9 条均已按修正版复核。
2. **文件级**：真 import 图（静态 `import/export … from` ＋ `import()`）＋ 从两个真实入口（`src/index.ts`、`src/client/index.tsx`）做可达性；另做"路径/文件名是否被任何文件提及"的文本级孤儿扫描。
3. **字段级**：解析 `src/shared/model.ts` 的 52 个对象形状共 **454 个字段**，逐字段统计 `src/client`（排除测试）／`src/host`／`src/shared` 三处引用数；`client=0 且 host+shared≤2` 才进候选，再人工读生产/消费点确认。
4. **重复逻辑**：跨文件 8 行归一化窗口哈希（`/tmp/r1-scan/clones.mjs`）＋ 按已知语义模式（格式化、时区、缓存、分位、JSON 落盘骨架）定向 grep。
5. **判「冗余」的必要条件**：每条都给出**反证命令＋命中数**（见附录 A）。凡"看起来少用"但属公共 API、agent 工具、插件入口、manifest/locale/DSH 消费的一律**保留**，并在文中标注原因。
6. **类型门禁基线**：`/tmp/r1-wt` 里 `tsc --noEmit -p tsconfig.json` **退出码 0**（tsconfig 已开 `noUnusedLocals`/`noUnusedParameters`）⇒ 仓库内**不存在未使用的局部变量/参数**，第 1 类只可能是跨文件死导出。

---

## 1. 未使用的导出／函数／常量

### 1.1 真死（全仓 grep 仅命中声明行，命中的 `1` 就是声明本身）

| 项 | 证据（`path:line` ＋ 反证命令命中数） | 建议动作 | 风险 |
|---|---|---|---|
| `PasteDelimiter` 类型 | `src/client/bulkPaste.ts:14`；`grep -rn "\bPasteDelimiter\b" src locale README.md docs build.mjs cordis.patch.yml` → **1**（＝声明行），测试 0 | 删除 | 1（纯类型，零引用） |
| `invalidateChips()` | `src/client/chipsLoader.ts:29`；同上 grep → **1**；同文件的 `resetChipsCache()` 才是被测试用的那个 | 删除 | 1 |
| `ChipsViewState` 接口 | `src/client/chipsView.ts:5`；grep → **1** | 删除 | 1 |
| `resetMountCounts()` | `src/client/mounts.ts:26`；grep → **1**（`mountCounts` 走 `window.__twMounts` 是活的，见 `:33`） | 删除 | 1（若保留，请补一句"当前无调用方"） |
| `ChipsLineKind` 类型 | `src/client/theme.ts:40`；grep → **1**（同一联合类型另有两份活字面量，见 §3-5） | 删除或改为三处共用 | 2（删除后需确认无 `import type`） |
| `FQ_NOTE` 常量 | `src/host/composition.ts:133`；grep → **1**（`:131` 注释称"位置/组合里凡涉及跨期比较的地方都该带上"，实际无人用） | 删除（与 §3-4 的 `FQ_LABEL` 合并） | 1 |
| `flowInflightKeys()` | `src/host/globalFlow.ts:227`；grep → **1**（注释称"自检/断言用"，但 `p0/p1/p1b.test.ts` 均无引用） | 删除（或补一条真正使用它的断言） | 1 |
| `heldLocks()` | `src/host/lock.ts:151`；grep → **1**（注释称"自检/诊断用"，`selftest.ts` 无引用） | 删除 | 1 |
| `removeLockFileSync()` | `src/host/lock.ts:557`；grep → **1**；`src/host/lock.ts:556` 注释"仅供退出钩子与测试使用"**与代码不符**：退出钩子在 `:375-378` 直接 `unlinkSync(lock.lockPath)` | 删除函数＋改注释（或让钩子改调它） | 2 |

### 1.2 仅测试引用（**保留**：这是刻意的测试锚点，不是死代码）

- 共 **50 条**，例如 `src/host/chips.ts:151/160/189/220`（`bucketCenters`/`allocate`/`allocateSpread`/`percentilePrice`）、`src/host/globalFlow.ts:193/569/576`、`src/client/tools/globalFlowView.ts:43/64/74/99`、`src/index.ts:129/134`（`coreKernel`/`setKernel`，注释已写明"测试与自检读它"）。
- 证据：`grep -rn "\b<name>\b" src --include=*.test.ts` 命中，生产侧命中 0（§0.1 扫描器 `TEST-ONLY` 段）。
- 建议：**保留**。若想收紧公开面，可把它们移到 `*.test.ts` 同目录的 `deps` 注入或标注 `/** @internal */`；**风险 3**（动了会牵动 50 处测试断言，收益仅"少一个导出"）。

### 1.3 仅本文件引用（export 关键字冗余，非死代码）

- **223 条**（清单在 `/tmp/r1-scan/exports2.txt` 的 `FILE-LOCAL-ONLY` 段），典型：`src/client/api.ts:155` `ApiError`、`src/client/chartCursor.ts:25/112/227/237` 一组 `*Like` 结构类型、`src/host/tencent.ts:219/260/368` 三个 `Tencent*Row`、`src/shared/model.ts:868/944/1295…`。
- 建议：**保留**（多数是"为测试可读性/为契约可读性刻意导出"）；如要收窄，只在改到该文件时顺手去掉 `export`。**风险 2**（跨 60+ 文件，无功能收益）。

---

## 2. 无人引用的文件

| 项 | 证据 | 建议动作 | 风险 |
|---|---|---|---|
| `src/` 源码孤儿 | **0 条**。静态 import 图＋入口可达性：客户端入口可达 63 文件、宿主入口 41 文件；未被任一入口覆盖的非测试文件只有 `src/host/selftest.ts`（`package.json:42` `"selftest": "node src/host/selftest.ts"` ⇒ 被引用）。`*.test.ts` 由 `package.json:40` 的 glob `src/**/*.test.ts` 收集；`lock.child.ts`/`klineLock.child.ts`/`rescuePersist.child.ts` 注释写明由 `node --experimental-strip-types <path>` 拉起（动态，文本级不可见）；`src/client/env.d.ts` 是环境声明 | **保留全部** | 1 |
| `scripts/rescue-thresholds.json`（219 行） | **0 读取方**：`grep -rn "rescue-thresholds.json" src build.mjs` → 0；`scripts/calibrate-rescue.mjs:244` 只 `writeFileSync`，该文件 `readFileSync` 命中为空；`src` 侧 import 的是 `./rescue-thresholds.ts`（`src/host/rescue.ts:10`、`anomaly.ts:5`、`selftest.ts:29`）；两份数据**逐值相同**（`f1={1.19,1.57,1.92}`、`pooled.p90=1.5729996757096938` 等）。而 `package.json` 的 `files` **含 `scripts`** ⇒ 会随 npm 包发布 | 删除（或从 `files` 移除）；若要留作标定留痕，请在同一目录写一行 README 说明"仅留痕、无消费方" | 3（删掉不影响运行；风险在"它是唯一的人工可读标定快照"这层价值判断） |
| `docs/` 零引用报告 | **21 份**：`docs/AUDIT-IMPL{22,24,26,27,28,29,30,31,34,37,38,39,40}.md` ＋ `docs/archive/AUDIT-IMPL{16..21}.md` ＋ `docs/archive/AUDIT-VERIFY{4,5}.md`（文件名在**其他任何文件里出现 0 次**） | **保留** —— `CHANGELOG.md:725` 是仓库成文惯例：「它们是**时间点记录**，按本项目惯例保留原样」；`package.json` 的 `files` 不含 `docs`（不发包）。建议只加一行索引（`docs/INDEX.md` 或在 README 开发节列清单） | 2（删＝违反自身惯例并丢证据链） |
| `docs/DESIGN-DASHBOARD.md` | 文件头自述「**未落地**（v0.33.1 已回退）…不要照着它改代码」，但正文 `:105` 仍在讲"新增 `src/client/boardLayout.ts`"（该文件全仓不存在） | 移入 `docs/archive/`（与 41 份历史记录同处），或删 `:105` 的可执行断言段 | 2 |
| CHANGELOG 里指向已删文件的引用 | `docs/AUDIT-VERIFY{3,6,7,8}.md`、`docs/AUDIT-{V3-EFFECT,V3-CODE,V3-COPY,IMPL6,IMPL9,COPY,FUNCTION,UI}.md`、`docs/COMPETITOR-NOTES.md` 均已在 `docs/archive/` 下，但 CHANGELOG 写的是 `docs/xxx.md`（15 处）；`src/client/IndustryHeatmap.tsx`／`treemap.ts` 亦已删除 | **保留**（CHANGELOG 是历史快照，改它反而造假） | 1 |

---

## 3. 重复逻辑（同一算法/格式化/骨架 ≥2 份）

| 项 | 证据 | 建议动作 | 风险 |
|---|---|---|---|
| ① 懒加载 JSON 落盘骨架 ×4 | `src/host/breadth.ts:103-122`、`src/host/calendar.ts:333-352`、`src/host/rescue.ts:1016-1035`、`src/host/writeLog.ts:55-68`：四份"`loaded` 单例 + `mkdir` + `readFile` + `JSON.parse` + `catch` 当空库"逐行同构（8 行窗口哈希跨文件命中 4 处）。**仓库里已有现成写法**：`src/host/store.ts:398` 的 `readNormalized(file, normalize, fallback)` | 把这 4 个 store 的 `init()` 收敛到 `store.ts` 的同一 helper（或抽 `host/atomic.ts` 下一个 `loadJsonLazy`） | 4（4 个模块的损坏隔离语义各有细微差异：`breadth.ts` 逐条校验、`calendar.ts` 字段级兜底 —— 合并时须逐个保留，不可一刀切） |
| ② Tab 焦点陷阱 ×2（逐行同构） | `src/client/BulkPaste.tsx:45-63` 与 `src/client/StripConfig.tsx:93-110`，仅选择器不同（`'textarea,select,button,input'` vs `'input,button'`） | 抽 `client/splitDrag.ts` 风格的小工具 `trapTab(ev, el, selector)` | 2 |
| ③ 北京时间格式化 ×3 实现 | 权威：`src/host/time.ts:9-33`（`formatter()`+`shanghaiParts`）；副本：`src/client/marketTime.ts:25-38`（`shanghaiClock`）与 `src/client/tools/globalFlowView.ts:82-90`（`fmtBeijing`）——三处各自重写 `Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'})` + `formatToParts` + `hour==='24'?'00'` | 抽到 `src/shared/`（两端都能 import）后三处共用 | 3（纯函数，可加断言后替换） |
| ④ 时序格式化"裸 `toLocaleTimeString`" ×10 | 无 `timeZone`（＝浏览器/宿主本地时区，**不是北京**）：`RescuePanel.tsx:437/467/475/478`、`badgeView.ts:54`、`quoteState.ts:64`、`PortfolioPage.tsx:336`、`WatchlistPage.tsx:201`、`MarketPage.tsx:447/458`；带 `timeZone` 的只有 5 处。而 `host/time.ts:1-4` 声明"所有时间标签一律走本模块"，`watchlistView.ts:13` 也写明"以前那行常驻文案是宿主本地时区，顺手修掉" ⇒ 只修了一处 | 统一走 ③ 抽出的 `hhmmOf`；若某个位置确实要本地时钟，必须写注释说明理由 | 5（**行为变化**：在非 UTC+8 的浏览器上这 10 处的显示时刻会变） |
| ⑤ 复权标签表 ×2，其一为死代码 | `src/shared/model.ts:294` `FQ_LABEL={0:'不复权',1:'前复权',2:'后复权'}`（活，`QuoteDrawer.tsx:516/563/579`、`ytdView.ts:37` 在用）vs `src/host/composition.ts:133-137` `FQ_NOTE`（同三值，0 引用，见 §1.1） | 删 `FQ_NOTE`，宿主需要时 import `FQ_LABEL` | 1 |
| ⑥ 筹码线型联合类型 ×3 | `src/client/theme.ts:40`（死）＋ `src/client/chipsView.ts:112`（活，`kind: 'avg'\|'resistance'\|'support'`）＋ `src/client/ChipsPanel.tsx:105`（活，函数入参联合） | 以 `chipsView.ts` 为源导出类型，另两处引用它；删 `theme.ts:40` | 2 |
| ⑦ `percentileOf` 同名**不同义** ×2 | `src/host/breadth.ts:67-89`：`≤` 计（"和今天一样也算不比今天更极端"，:86 `filter(v => v <= current)`）；`src/host/tones.ts:111-117`：`<` 计（`if (x < current) below += 1`，注释"小于它的比例"）。同名同签名→不同并列处理 | 至少改名区分（如 `rankPctInclusive` / `rankPctExclusive`），或统一口径后合并 | 4（改语义会动分位/档位边界，必须先补断言） |
| ⑧ 金额"亿/万"缩写 ×2（同文件） | `src/client/format.ts:51-58` `fmtAmt`（受隐身遮罩、`toFixed(2)`）vs `:74-80` `fmtBig`（不遮罩、`toFixed(1)`+`Math.round`）——两者 1e8/1e4 分支逐字相同 | 保留（遮罩/精度差异是有意的），但建议 `fmtBig` 内部复用 `fmtAmt` 的缩写函数 | 2 |
| ⑨ 涨跌箭头逻辑 ×2（同文件） | `src/client/format.ts:18-21` `pctArrow()`（唯一消费者 `WatchlistPage.tsx:401`）vs `fmtPct()` 在 `:25-29` 内联同一套 `n>0?'▲':n<0?'▼':''` | `fmtPct` 内联改为调 `pctArrow` | 1 |

---

## 4. 冗余状态与字段

| 项 | 证据 | 建议动作 | 风险 |
|---|---|---|---|
| `DataProvenance.marketState` | `src/shared/model.ts:1213`（`marketState?: 'open'\|'closed'\|'unknown'`）：454 个字段三向统计中，`src/client` 0 命中、`src/host` 0 命中（唯一命中是 `model.ts` 自身）；`grep -rn "marketState" src README.md locale` → **1**（仅声明） | 删除该可选键（或补生产者＋渲染，二选一） | 2（可选键，删除不影响老数据/A 端；若将来要 expose，重新加即可） |
| `DataProvenance.showing` | `src/shared/model.ts:1220`（`:1219` 注释自述"只有真降级时才给"）：grep → **1**（仅声明） | 同上 | 2 |
| 死 CSS 类 ×4 | `styles.ts` 的 `TW_CSS` 共 217 个 `.tw-*` 类名，生产客户端零引用 4 个：`styles.ts:205` `.tw-right`、`:351` `.tw-stat-sep`、`:484` `.tw-chips-decay`、`:497-498` `.tw-chips-bars`（**其自带注释就写着"旧名 .tw-chips-bars，已无节点使用"**，现节点用 `.tw-chips-plot` `:504`）。反证：`grep -rn "tw-right\|tw-stat-sep\|tw-chips-decay\|tw-chips-bars" src --include=*.ts --include=*.tsx` 除 `styles.ts` 外 0 命中，测试也不锁它们 | 删 4 条规则；`.tw-chips-bars` 若仍需那段说明，把注释搬到 `.tw-chips-plot` | 2（纯样式，无 JS 引用） |
| `PREF` 键：**无冗余** | `DEFAULT_PREFS`（`model.ts:690-709`）17 个键逐个统计读写点，全部有生产消费方（`theme/refreshSec/redUp/costBasis/watchSort/portSort/rescue/viewMode/panelOpacity/blurDigits/fxMode/fxRates/trendArchive/stripCfg/chipsDecay/chipsSpread/splitRatio`；`chipsSpread` 经 `routes.ts:365` 进入 `chipSeriesOf` 计算，非响应字段） | 保留 | 1 |
| `locale`：**无冗余** | 14 个文件的 `meta.title/description` 全部由 DSH `readPluginMeta(specifier, base)` 消费（`cordis.patch.yml:45-46` 记录解析路径），`package.json` `exports` 为 6 个功能行各留 `./rows/<row>/locale/*` | 保留 | 1 |
| `cordis.patch.yml`：**无无效配置** | 7 行（`:53` insert，行在 `:54/57/60/63/66/69/73`）的 `id`＋`name`＋`config.row` 与代码一一对齐：`ROW_ROUTES`/`ROW_TOOLS` 键集合（`src/index.ts:32-75` 各含同样 6 个功能行）、`package.json` `exports` 含全部 6 个 `/rows/<row>` 子路径、`src/index.test.ts:43-51` 的 `EXPECTED_ROWS` 同为 7 项 | 保留 | 1 |
| `__kernelStats` | `src/index.ts:81`：`inits/starts/applies/rows/routeRegs` 五个字段全被 `src/index.test.ts` 断言消费（幂等证据） | 保留（测试钩子） | 1 |

---

## 5. 过期注释与文档失配

### 5.1 `README.md`（面向用户，优先级最高）

| 项 | 证据（`path:line` ＋ 反证） | 建议动作 | 风险 |
|---|---|---|---|
| ① 描述**已删除**的"自绘云图" | `README.md:77`「两档，**默认自绘**」、`:79` squarified treemap、`:82`「之所以默认自绘」；`git ls-files \| grep -c "IndustryHeatmap\|treemap"` → **0**；删除记录 `CHANGELOG.md:588-591`（v0.62.0 删自绘）；测试把这两文件名列入反例 `src/client/cloudMap.test.ts` 的 `REMOVED_TOKENS` | 删 `:77-82` 自绘整段，只留第三方站点 | 7（README 在教用户用一个不存在的功能） |
| ② 文件树里有已删文件 | `README.md:422` `client/treemap.ts # squarified treemap`；`ls src/client \| grep treemap` → 0 | 删该行 | 4 |
| ③ 页签数量 | `README.md:13`「面板由**五个**页签组成」；代码 `src/client/index.tsx:189` `PageKey = 'watch'\|'portfolio'\|'market'\|'cloud'\|'calendar'\|'tools'`（6 个，`:192` `TOOLS_PAGE='tools'`） | 改"六个（含工具）" | 6（用户找不到工具页） |
| ④ 行情条行数/成分 | `README.md:17`「（**三行**…）」＋`:18-20` 只列 A股/国际/大宗商品；`src/shared/model.ts:16/28/44/55` 是 4 组（cn/intl/**bond 国债**/commodity） | 补"国债"行、行数改四 | 6（漏一整组 UI） |
| ⑤ 预设组清单自相矛盾 | `README.md:182` 写 `cn/intl/commodity/all`（漏 bond）vs `README.md:366` 写 `cn/intl/commodity/bond/all`（含 bond）；代码 `model.ts:44` 有 `bond` 组 | 统一为含 `bond`（以代码为源） | 5 |
| ⑥ 旧标定数字 | `README.md:93`「P75/P90/P95 = **1.20/1.63/1.98x**」；实际 `src/host/rescue-thresholds.ts:21-23` `f1={mid:1.19,high:1.57,extreme:1.92}`、`:146-148` `pooled.p75/p90/p95 = 1.1913/1.5730/1.9208`；反证 `grep -rn --exclude=REVIEW-*.md "1\.63\|1\.98" README.md src docs/*.md` → 全仓只有 2 处：`README.md:93` 与 `src/client/RescuePanel.tsx:218`（§5.3 的客户端魔数） | 改成 1.19/1.57/1.92 | 5（把门槛读高，会误判"是否到高门槛"） |
| ⑦ agent 工具描述漏 bond | `src/host/tools.ts:460`（`tradewatcher_quotes` 的 description）「支持预设组：cn…/ intl…/ commodity…/ all」 | 补 `bond` 与 README:366 一致 | 4（模型不知道有 bond 预设） |

### 5.2 `src/` 内注释（与代码不符）

| 项 | 证据 | 建议动作 | 风险 |
|---|---|---|---|
| ① 行号引用失效（自指） | `src/index.ts:12`「口径见 `rowOf`（本文件 **:104-111**）」；`rowOf` 实际在 `:119-126` | 改为"见本文件 `rowOf`"（避免再写死行号） | 1 |
| ② 行号引用失效（跨文件） | `src/index.ts:35` 称 `/tradewatcher/trades` 的调用方是 `QuoteDrawer.tsx:79`；实际 `:79` 是 `redUp: boolean`，调用方在 `QuoteDrawer.tsx:161`（`api.trades(secid)`） | 同上，去掉行号或改指 `:161` | 1 |
| ③ 同上 | `src/index.ts:47` 称 `/tradewatcher/industries` 只有 `WatchlistPage.tsx:89` 用；实际 `:89` 是 `const n = ++indSeq.current`，调用在 `:91`（`.industries(secs)`） | 同 ② | 1 |
| ④ 同上 | `src/index.ts:43/45` 两处称 `/tradewatcher/board` 只有 `MarketPage.tsx:84` 用；实际 `.board(...)` 在 `:82`、`:84` 是 `.then` 里的 `setBoardMeta`（同一次调用的相邻两行，尚可用） | 改指 `:82`（或只写文件名） | 1 |
| ⑤ 注释指向**空文件头** | `src/client/marketTime.ts:24`「取北京时间墙上时钟（用 Intl 而不是本地 getX，**理由见文件头**）」，而 `:1-2` 是空的 `/** */` —— 理由已不存在 | 要么补回文件头，要么把理由写在该行或删掉这句 | 2 |
| ⑥ 死函数 + 说谎注释 | `src/host/lock.ts:556`「**仅供退出钩子与测试使用**」；钩子在 `:375-378` 用的是 `unlinkSync(lock.lockPath)`，测试 0 引用（同 §1.1） | 删函数或改注释 | 2 |
| ⑦ 说明指向死常量 | `src/host/composition.ts:131`「位置/组合里凡涉及跨期比较的地方都该带上」→ 紧邻的 `FQ_NOTE`（`:133`）零引用 | 与 §1.1 一并删除 | 1 |

### 5.3 空文件头：**30/176 个文件的文件头内容被删空**（系统性）

| 项 | 证据 | 建议动作 | 风险 |
|---|---|---|---|
| 30 个 `/** */` 空文件头 | 判据脚本：第 1 行 `/**`、第 2 行 `*/` → 命中 **30** 个文件（`src/client/{RescuePanel.tsx,SortBar.tsx,alerts.ts,chartCache.ts,index.tsx,marketTime.ts,mini.ts,portfolioMeta.ts,sort.ts,styles.ts}`、`src/host/{anomaly,calendar,context,em,fence,http,rescue-thresholds,rescue,routes,sina,singleflight,store,tencent,tools}.ts`、另有 3 个 `*.test.ts`）。**git 反证**：对每个文件取 `git log --diff-filter=A` 的创建提交再取该提交的前两行，**30/30 在创建时是一个"非空"文档块**（0 个是创建即空、0 个查无历史）。例：`src/host/sina.ts` 创建于 `11d75ff` 时是「新浪备用源：ETF 排行…响应为 GBK 编码的 JSON 数组…」，`src/host/context.ts`/`routes.ts` 创建于 `7bc5a5e` 时是完整英文说明，`src/client/marketTime.ts` 创建于 `a0a9d50` 时有「北京时间交易时段判定（纯函数，可单测）」 | 两种都可：① 删掉空块（30 行净减）；② 更推荐——**找回内容**：`git show <创建提交>:<file> \| sed -n '1,Np'` 即可复原，或至少给有"见文件头"指路的那几个（`marketTime.ts`、`sina.ts`、`tencent.ts`）补回 | 3（删空块零风险；补内容需人工核对是否仍成立） |
| 连带：跨文件"见文件头"指路失效 | `src/host/sina.ts:53`（"见**文件头**的实测证据"）与 `:93`（"实测是陈旧快照（见**文件头**）"）都指自己的空文件头（证据实际在 `:25-41` 的块注释里）；`src/host/tencent.ts:30/139` 与 `src/host/em.ts:1372` 同理指向 `sina.ts 文件头` | 把指针改成实际块的行号/小节名 | 2 |

### 5.4 文档引用失效（过程记录类，低优先）

| 项 | 证据 | 建议动作 | 风险 |
|---|---|---|---|
| ① 行清单权威处指错 | `README.md:346` 与 `docs/DESIGN-SUBPLUGINS.md:3/42/162` 直接写「`cordis.patch.yml:38-56`」；另 `docs/DESIGN-SUBPLUGINS.md:4/119` 称「六行」。反证：实际 manifest 是 **7 行**（`grep -n "row:" cordis.patch.yml` → 7 处，`:56/59/62/65/68/71/75`；`- insert:` 在 `:53`，文件共 75 行）；第 7 行 `tradewatcher-tools` 由 v0.71.0 加入（`CHANGELOG.md:148`）；`src/index.test.ts:43-51` 的 `EXPECTED_ROWS` 也是 7 项 | 六行→七行、`38-56`→`53-75`。⚠ 本条与并行文档审计（`docs/REVIEW-3-DOCS.md`）重叠，请 Lead 去重后只派一次 | 6（README 自称"唯一权威处"却指错位置） |
| ② 96 桶证据引错行 | `docs/DESIGN-CHIPS.md:52` 引「见 `src/client/chipsView.ts:123`、`:151`」；`:123` 实为 `chipsLinesOf` 的注释尾（"不拿默认值硬画一条线出来"），96 桶事实在 `:142`（"**96 桶**在可用高度里每行 ≥1px"） | 改引 `:142` | 3 |
| ③ STE-REVIEW-UI 引用越界/指向已删文件 | `docs/STE-REVIEW-UI.md:55/56/57` 三处引 `src/client/CloudMap.tsx:151`，而该文件**共 142 行**；`:19` 引 `src/client/IndustryHeatmap.tsx:85`（文件已于 v0.62.0 删除） | 该报告抬头加「已执行完毕（v0.51.0）；行号基于当时 HEAD，勿再逐条执行」 | 4（照它执行会退回 v0.51.0 之前的状态） |

---

## 6. `build.mjs` 锁定片段（只看，不改）

| 项 | 证据 | 建议动作 | 风险 |
|---|---|---|---|
| 锁着"永不可能再出现/已删功能"的片段 | **0 条**。73 条 `REQUIRED_CLIENT_SNIPPETS`（`build.mjs:109-190`）逐条回查：73/73 都能在非测试的 `src/client/**` 里找到（或经 `src/shared` 常量进入产物，见下条）；v0.62.0 删自绘云图时对应两条（`'行业热力（自绘）'`/`'面积＝成交额'`）**已在 `build.mjs:163-164` 的注释里声明解锁并移除** | 保留现状 | 1 |
| 弱锁 1 条：`'后复权'` | 该串在非测试 `src/client/**` 里**只出现在注释**（2 处），实际靠 `src/shared/model.ts:294` 的 `FQ_LABEL` 被打进产物；客户端复权段控的标签走 `QuoteDrawer.tsx:566-579` 的 `FQ_LABEL[m]` ⇒ 该片段**不能**证明"复权段控存在"（片段表 `:184-186` 的意图是"默认口径 + 三段可选"） | 增补一条客户端字面量（如已有的 `'复权口径'` aria-label）作真锚点；`'后复权'` 可留可删 | 2（改了要跑一次构建验证，见"未确认"第 4 条） |
| 冗余分支：`escapeUpper()` | `build.mjs:97-99` 定义、`:201` 参与 `missing` 判定；`escapeEsbuild()`（`:101-107`）已覆盖真实转义形式。**产物反证**：`grep -c '\\xB7' lib/client.js` → **88**，`grep -c '\\u00B7' lib/client.js` → **0**；`\\xA5` → 8，`\\u00A5` → 0（esbuild 0.24.2）。对码位 >0xFF 的字符，两函数的输出**逐字相同**（都是 `\uXXXX`）⇒ 在当前 bundler 下 `escapeUpper` 永不产生额外命中 | 删除 `escapeUpper` 及其一处 `includes` 判断（保留 `escapeEsbuild`），并在注释里写明"esbuild ≤0xFF 用 `\xHH`，已实测" | 3（改的是构建门禁；必须实跑一次构建验证 73 条仍通过） |

---

## 7. 未确认（各给出确认方法）

1. **30 个空文件头"是被误删还是刻意留位"** —— 已证明"创建时有内容、现在为空"，但未证明是谁删的、是否有意。确认：`git log -p --follow -- src/host/context.ts | head -80` 找到删掉内容的那次提交，读它的 commit message 是否提到"精简文件头"。
2. **`scripts/rescue-thresholds.json` 是否有仓库外消费方**（例如用户自己的脚本或文档链接）——本机只能证明仓内 0 读取方。确认：`grep -rn "rescue-thresholds" ~/.dsh ~/.local 2>/dev/null | head`，以及 `npm view dsh-tradewatcher dist.tarball` 后 `tar tzf <tarball> | grep rescue-thresholds` 看发包历史上是否曾把 json 当数据源。
3. **`RescuePanel.tsx:218` 的 1.63 是"过期魔数"还是"独立的展示阈值"** —— 值来源链已查清：`1.63` 与 `f1.high` 同在 `73aea50`（v0.11.0）引入，`e463e72`（v0.12.0「按实盘误报逐条修正评分逻辑」）把标定改成 `1.57`，客户端未跟改（`git log -S"1.63" -- src/client/RescuePanel.tsx` 只命中 `73aea50`），README:93 也没跟改 ⇒ **倾向"过期魔数"**，但无注释可判其意图。确认：问作者或查 `docs/DECISIONS.md` 里 v0.12.0 那段是否声明"展示分档不变"。同类还有 `RescuePanel.tsx:160` 的 `2.5/1.5`（未比对到任何配置值，**未确认**）。
4. **`build.mjs` 改动后的 73 条片段是否仍全部通过** —— 本报告按约束**没有在工作区跑构建**。确认：在隔离副本里跑 `cd /tmp/r1-wt && TW_SKIP_TYPECHECK=1 node build.mjs`（注意：`lib/` 是软链目标外的本地目录，不会推到宿主；**不要在工作区跑**）。
5. **223 条"仅本文件引用"的导出里是否有应当收窄的公共面** —— 只做了计数，未逐条判"是否该 internal"。确认：对 `src/shared/model.ts`、`src/client/api.ts` 两个"契约文件"人工过一次；其余按"改到时顺手"处理即可。
6. **`percentileOf` 两处口径差异是否曾被有意设计** —— `breadth.ts:86` 用 `≤`、`tones.ts:113` 用 `<`，两者注释都自洽（"≤：和今天一样也是不比今天更极端" vs "<：小于它的比例"）。确认：`git log -S"v <= current" -- src/host/breadth.ts` 与 `docs/DECISIONS.md` 里分位定义的段落是否分别声明过并列处理规则。

---

## 附录 A：反证命令清单（每条结论都可用这些复核）

> 本会话自研的扫描器脚本放在 `/tmp/r1-scan/`（`unused-exports.mjs`、`imports.mjs`、`reach.mjs`、`orphans.mjs`、`clones.mjs`、`fields.mjs`、`model-fields.mjs`、`snippets.mjs`，另 `exports2.txt` 是修正版全量输出）。它们是临时产物、不在仓库里，可能被清理；因此下面凡能用**不依赖脚本的等价 grep** 复现的条目都给了 grep（§1／§2 的 JSON 与文档两条／§4 两条／§5 两条／§6 两条）。

```bash
cd /home/hu/workspace/Servers/dsh/Dev/dsh-tradewatcher
# ⚠ 本报告自己在 docs/ 下，会被 grep 命中 ⇒ 下面凡扫 docs 的都排除 REVIEW-*.md（复核时务必带上）
EX='--exclude=REVIEW-*.md'

# §1 真死导出：每条应命中 1 行（＝声明行本身）
for s in PasteDelimiter invalidateChips ChipsViewState resetMountCounts \
         ChipsLineKind FQ_NOTE flowInflightKeys heldLocks removeLockFileSync; do
  printf "%-18s %s\n" "$s" "$(grep -rn $EX "\b$s\b" src locale README.md docs build.mjs cordis.patch.yml | wc -l)"
done

# §2 src 孤儿（除测试/selftest/child.d.ts 外应无输出）
node /tmp/r1-scan/reach.mjs | sed -n '/NOT reachable/,/^$/p'

# §2 零读取方的标定 JSON
grep -rn "rescue-thresholds.json" src build.mjs package.json   # → 0 命中
grep -n "writeFileSync\|readFileSync" scripts/calibrate-rescue.mjs

# §3 重复骨架（跨文件同构窗口，W=8）
node /tmp/r1-scan/clones.mjs 8

# §4 死 CSS 类 / 死字段
grep -rn "tw-right\|tw-stat-sep\|tw-chips-decay\|tw-chips-bars" src --include=*.ts --include=*.tsx
grep -rn "marketState\|showing" src README.md locale            # → 各 1 命中（仅声明）
node /tmp/r1-scan/model-fields.mjs

# §5 空文件头（等价 grep：找第 2 行就是 */ 的文件，逐个人工确认）
grep -rn -A1 "^/\*\*$" src --include=*.ts --include=*.tsx | grep "^\S*-[0-9]*- \*/" | head -40
# git 反证：创建提交处的文件头是有内容的
git show 11d75ff:src/host/sina.ts | sed -n '1,8p'

# §5 旧标定数字（排除本报告后应只命中 README:93 与 RescuePanel.tsx:218 的魔数）
grep -rn $EX "1\.63\|1\.98" README.md src docs/*.md

# §6 片段/转义反证
node /tmp/r1-scan/snippets.mjs
grep -c '\\xB7' lib/client.js ; grep -c '\\u00B7' lib/client.js   # 88 vs 0

# 类型门禁基线（隔离副本，勿在工作区跑）
cd /tmp/r1-wt && node_modules/.bin/tsc --noEmit -p tsconfig.json && echo "tsc clean"
```

## 附录 B：明说没做的事

- 未运行 `npm run build` / `npm run test` / `npm run selftest`（工作区）；只在 `/tmp/r1-wt` 跑了 `tsc --noEmit`。
- 未改任何源码、未 `git add`/`commit`、未动 `~/.dsh` 与 profile、未重启 `dsh web`。
- 未对 223 条"仅本文件引用"导出逐条判 public/internal（见 §7.5）。
- `docs/REVIEW-3-DOCS.md`（并行审计产物，未跟踪）未被当作仓库内容；§5.4① 与其重叠，已在行内标注。
