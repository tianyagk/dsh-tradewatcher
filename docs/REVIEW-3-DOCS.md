# REVIEW-3-DOCS —— 文档一致性审计（只读）

**审计对象**：`/home/hu/workspace/Servers/dsh/Dev/dsh-tradewatcher`，`main` @ `6f4382e`（v0.74.0）
**本文件是本次审计唯一的写入面**；未改任何源码、未 commit、未构建、未装 bundle、未动 profile、未重启 `dsh web`。
**取证口径**：所有代码行号来自本工作区 `grep -n` / `sed -n`；所有引用文字逐字照抄（不改标点、不转写）。

---

## 结论先行

三条最该先修的，都是"读者会照着它改错东西"级别：

1. **README 的「大盘云图」整节描述的是一个已在 v0.62.0 被删除的功能**，而且测试**主动断言它不许再出现**。README:77 写「两档，**默认自绘**」，README:79 详细描述了 `squarified treemap` 的面积/色深口径；但 `src/client/CloudMap.tsx:2` 写「**只保留第三方站点**（用户要求下线内建热力视图，v0.62.0）」，且 `src/client/cloudMap.test.ts:70-75` 断言全仓 `src/**` 无「自绘」残留、`treemap.ts` **必须已删除**。README:422 还在文件清单里列着这个已删文件。

2. **组件行数在所有"权威处"都还写着六行，实际是七行**：README:344「拆成**六行**」、README:346「v0.59.0 起为六行…（六项 id）」、`docs/DESIGN-SUBPLUGINS.md:3`「是**六行**」、`:56`「core + 5 = 6 行；**当前 manifest 只装 1 行**」、`:113`「六条 Loader 行」、`:162`「恢复六行」。第 7 行 `tools` 自 **v0.71.0** 起就在 `cordis.patch.yml` 里，`src/index.ts:29` 的 `RowId` 与 `src/index.test.ts:42-50` 的 `EXPECTED_ROWS` 都是七项。**更严重的是 CHANGELOG 的对应声明是假的**（见 §4.1 的 **C1**）。

3. **`cordis.patch.yml:38-56` 这个行号引用在所有引用它的地方都已失效**：实际 insert 块在 **`:53-75`**（文件共 75 行），被 README:346、DESIGN-SUBPLUGINS:3/42/46/127/162 六处引用，且 README 称它为「**行清单的唯一权威处**」—— 权威处指错了位置。

其余按严重度排在下面各节（【P0】= 会误导人改错东西，【P1】= 数字/事实过期，【P2】= 瑕疵）。**每条都按「项 → 文档原文 → 代码/事实证据 → 建议动作」四段式给出**，可执行建议都在「建议动作」里。

---

## 一、过期数字

### 1.1 【P0】组件行数：六行 → 七行

- **项**：组件行清单与行数
- **文档原文**（`README.md:344`）：
  > 本插件在一个 bundle 内拆成**六行**（core / calendar / cloudmap / market / watchlist / portfolio），**各自可独立开关**：
- **文档原文**（`README.md:346`）：
  > **行清单的唯一权威处是本包的 `cordis.patch.yml`**（`cordis.patch.yml:38-56`，v0.59.0 起为六行：`tradewatcher-core`/`-calendar`/`-watchlist`/`-portfolio`/`-market`/`-cloudmap`，全部启用、每行 `config: { row: … }`）；
- **代码证据**：
  - `cordis.patch.yml:53-75` 的 `- insert:` 块共 **7** 条 `- id:`（`tradewatcher-core` … `tradewatcher-tools`，`:73-75` 是 tools 行）。
  - `src/index.ts:29`：`export type RowId = 'core' | 'calendar' | 'watchlist' | 'portfolio' | 'market' | 'cloudmap' | 'tools'`
  - `src/index.test.ts:42`：`/** 七行的期望集合（id ↔ config.row 一一对应；顺序即 manifest 顺序） */`
  - `src/index.test.ts:223`：`test('task-6：七行 manifest —— id ↔ config.row 一一对应，且与代码的行集合一致（防漂移）', async () => {`
  - `CHANGELOG.md:148`（v0.71.0 标题）：`## v0.71.0 — 新增第 7 组件行「工具」工具箱骨架 + 修正国际指数兜底**错数**（红线）`
- **解释**（不在引号内）：README 的六项清单里也**没有 `tools`**，按它去关/开「工具」行会找不到该行。
- **建议动作**：改文档（README:344 改为七行并补齐 `tools`；README:346 改为七项 id 与正确行号）。

### 1.2 【P0】`cordis.patch.yml` 行号引用：`:38-56` → `:53-75`

- **项**：`path:NNN` 是否还指向它声称的内容
- **文档原文**（`README.md:346`，同上）：`cordis.patch.yml:38-56`
- **文档原文**（`docs/DESIGN-SUBPLUGINS.md:3`）：`cordis.patch.yml:38-56` 是**六行**
- **文档原文**（`docs/DESIGN-SUBPLUGINS.md:162`）：**v0.59.0 恢复六行**：`cordis.patch.yml:38-56`（六个 `tradewatcher-*` id，全部启用，每行 `config: { row: … }`）。
- **代码证据**：`wc -l cordis.patch.yml` → **75**。`cordis.patch.yml:53` 是 `- insert:`；`:54` 起是第一条 `- id:`；`:75` 是最后一条 `config: { row: tools }`。当前 `:38`、`:56` 都是**注释行**：
  - `:38` → `#     disabled: true`
  - `:56` → `      config: { row: core }` ← 这是**旧**（六行/单行时代）坐标下才成立的行
- **对比**：`CHANGELOG.md:152` 用的行号是**对的**：`cordis.patch.yml:73-75` 第 7 行（`name: 'dsh-tradewatcher/rows/tools'` + `config: { row: tools }`）
- **建议动作**：改文档（六处引用统一改成 `cordis.patch.yml:53-75`；或更稳的做法是只写「本包的 `cordis.patch.yml` 的 `- insert:` 块」不给行号）。

### 1.3 【P0】`build.mjs` 锁定片段数：75 项 → 73 项

- **项**：构建期 UI 片段校验条数
- **文档原文**（`docs/DESIGN-SUBPLUGINS.md:48`）：
  > | 构建 | `build.mjs:61-85`（host→`lib/index.js`、client→`lib/client.js`）、`:192-210`（构建期硬校验 75 项 UI 片段，只查 `lib/client.js`） | 两产物 |
- **文档原文**（`docs/DESIGN-SUBPLUGINS.md:121`）：
  > `build.mjs` 的 75 项片段校验**无需改**（client 产物仍是单文件）
- **文档原文**（`docs/DESIGN-SUBPLUGINS.md:141`）：
  > | `build.mjs` 75 项片段校验 | `build.mjs:192-210` 只读 `lib/client.js`；代码仍在一个 bundle ⇒ 不破 | `npm run build` 末尾打印"客户端片段校验通过：75 项" |
- **代码证据**：
  - `build.mjs:109` 起 `const REQUIRED_CLIENT_SNIPPETS = [`，到 `:190` 结束，逐项计数 = **73**。
  - `build.mjs:210`：``console.log(`built lib/index.js + lib/client.js （v${TW_VERSION}，客户端片段校验通过：${REQUIRED_CLIENT_SNIPPETS.length} 项）`)`` ← 运行时打印的是**数组长度**，当前为 73。
  - `CHANGELOG.md:595`（v0.62.0）记录了这次变化：`**解锁 2 条构建片段**（Lead 执行）：`build.mjs` 里锁定的 `行业热力（自绘）` 与 `面积＝成交额` … 其余 73 条未动（片段校验 = **73 项**）。`
- **解释**：v0.62.0 删自绘云图时**卸掉了 2 条**片段（75 → 73），DESIGN-SUBPLUGINS 没跟着改。注意 75 是**历史正确值**（`CHANGELOG.md:900/932/957/1001/1043/1900` 与 `docs/AUDIT-IMPL22/23/24.md` 里的 75 都对），所以只改 DESIGN-SUBPLUGINS 这三处活文档引用即可。
- **建议动作**：改文档（三处 75 → 73；`:48` 同时把 `:192-210` 修正为 `:192-208`）。

### 1.4 【P1】路由条数账：24 → 25

- **项**：路由数量与按行拆分账
- **文档原文**（`docs/DESIGN-SUBPLUGINS.md:4`）：
  > 静态验证（锚真实产物 `lib/index.js`）见 `docs/AUDIT-IMPL35.md`：`inits/starts` 各 1、跨行零重复、路由账 24 = core 16 + calendar 1 + watchlist 3 + portfolio 2 + market 2 + cloudmap 0、六行并集 == 单行全量。
- **文档原文**（`docs/DESIGN-SUBPLUGINS.md:162`，同账第二次出现）：`路由账 24 = core 16 + calendar 1 + watchlist 3 + portfolio 2 + market 2 + cloudmap 0`
- **代码证据**：
  - `/tradewatcher/*` 唯一路径共 **25** 条（`src/host/routes.ts` + `src/index.ts` 去重计数）。
  - 现行分行（`src/index.ts:32-65` `ROW_ROUTES`）：calendar 1（`/calendar`）、watchlist 3（`/watch` `/industries` `/anomaly`）、portfolio 2（`/portfolio` `/ledger`）、market **3**（`/breadth` `/rescue` `/board`）、cloudmap 0、**tools 1**（`/tools/global-flow`）⇒ core 15。
  - 差额来源有二：① v0.62.0 把 `/board` 从 core 移到 market（market 2 → 3）；② v0.72.0 给 tools 行加了 `/tools/global-flow`（0 → 1）。两者都写进了 `CHANGELOG.md:131`（`ROW_ROUTES.tools = ['/tradewatcher/tools/global-flow']`（原为空数组…））与 `docs/DESIGN-SUBPLUGINS.md:74`（`**market**（v0.62.0 从 core 收进…）`）。
- **建议动作**：改文档（`:4` 与 `:162` 的账本改成 `25 = core 15 + calendar 1 + watchlist 3 + portfolio 2 + market 3 + cloudmap 0 + tools 1`；或删掉固定账本，只说「并集 == 单行全量」，把数字留给 `src/index.test.ts` 的断言）。

### 1.5 【P0】页签数：五个 → 六个

- **项**：面板页签清单
- **文档原文**（`README.md:13`）：
  > 面板由五个页签组成：**自选 / 持仓 / 大盘（含护盘信号与底部位置分析）/ 云图 / 日历**。下面按模块说明。
- **代码证据**：`src/client/index.tsx:380-388` 的 `tabs` 数组共 **6** 项，第 6 项为：
  > `{ key: 'tools', label: '工具', full: '工具箱（工具目录与工具详情）', row: 'tools' },`
  且 `src/client/toolsPage.test.ts:75` 断言：`assert.equal(on.visible.length, 6, '七行全开时六个页签都在')`
- **解释**：README 全篇（含 §护盘/§日历各节）也没有「工具」页与工具箱的说明。
- **建议动作**：改文档（`README.md:13` 改为六个页签并加「工具」；补一节工具箱说明，或在 §功能 里给一行 + 指向 `docs/` 的详情）。

### 1.6 【P0】备用源兜底覆盖：`20/23` → `18/28`，且缺失清单变了

- **项**：东财不可达时的兜底覆盖率
- **文档原文**（`README.md:453`）：
  > - **国际指数/商品的备用源缺口**：东财不可达时的兜底覆盖为 **20/23**（腾讯 6 个 A股指数 + 新浪 14 个：7 国际指数、4 国内期货、3 外盘商品）。缺 **韩国KOSPI200 / 法国CAC40 / 欧洲斯托克50** —— 三家免费源（`hq.sinajs.cn`、`qt.gtimg.cn`、smartbox 搜索）都没有对应符号，只能等东财恢复；此时它们会带 `source: lkg` 与滞后标记，而不是显示假数据
- **代码证据**：
  - `src/host/selftest.ts:514-516`：
    ```
    ok(presets.length === 28, `预设标的数 ${presets.length}`)
    ok(covered.length >= 18, `可用兜底的预设数 ${covered.length}/28（要求 ≥18）`)
    ok(sinaCovered(presets) >= 8, `新浪专供（期货/外盘商品）${sinaCovered(presets)} 只（要求 ≥8）`)
    ```
  - `src/host/selftest.ts:509` 的注释写明这次变化：`**如实无兜底** ⇒ 可用兜底数从 22 降到 18、新浪专供从 15 降到 8。这是**有意的降级**（宁缺错值）。`
  - `src/host/em.ts:230`：`const RETIRED_INDEX_FALLBACK = new Set(['100.SPX', '100.DJI', '100.NDX', '100.HSI', '100.FTSE', '100.N225', '100.GDAXI'])`
  - `CHANGELOG.md:187`（v0.71.0 §三）：`日经／富时／德国（＋韩国／法国／斯托克 50）在腾讯**也没有映射** ⇒ **可用兜底 22 → 18、新浪专供 15 → 8**。`
- **解释**：三处过期同时存在 —— ① 分子/分母（`20/23` vs 实测 18/28，且 28 = 6 A股指数 + 9 国际市场 + 8 大宗商品 + 5 国债，v0.39.0 加了国债组）；② 缺失清单**漏了日经/富时/德国**（`int_*` 整族停用后才缺的）；③ 「新浪 14 个：7 国际指数」已不成立（国际指数不再走新浪）。
- **建议动作**：改文档（重写该条，或改为指向 `src/host/selftest.ts` 的断言而不写死数字）。

### 1.7 【P1】护盘历史回看：近 60 日 → 近 30 日

- **项**：护盘信号面板/工具展示的历史深度
- **文档原文**（`README.md:88`）：
  > 识别「符合国家队历史行为模式的宽基 ETF 护盘行为」。常驻状态条（等级/评分/归因）+ 六通道标的卡 + 因子明细表（含**贡献度**列）+ 分时量能图 + 今日信号时间线与近 60 日历史回看。信号达「疑似护盘」时面板自动展开。
- **代码证据**：
  - `src/host/rescue.ts:1892`：`history(limit = 30): RescueDaySummary[] {`（默认 **30**）
  - `src/host/routes.ts:1052`：`history: rescue.history(30),`
  - `src/host/routes.ts:1065`：`snapshot, history: rescue.history(30), calibrated: rescue.calibratedInfo,`
  - `src/host/tools.ts:1176`（`tradewatcher_rescue` 的工具描述，即模型读到的口径）：`'脉冲倍数）、今日信号时间线与近 30 日历史。注意：汇金/国新/诚通不披露日内成交，' +`
- **解释**：`60` 是**磁盘归档窗口**（`src/host/rescue.ts:89`：`const KEEP_DAYS = 60`），不是**展示窗口**。README:97 与 README:170 写「`rescue-log.json`（60 天滚动）」是**对的**，只有 README:88 的「近 60 日历史回看」把两者混了。注意 DSH 工具描述（模型实际读到的）也是 30 —— README 与工具描述互相矛盾。
- **建议动作**：改文档（`README.md:88` 改为「近 30 日历史回看」）。

### 1.8 【P1】`sort.ts` 断言组数：8 组 → 11 条

- **项**：`src/client/sort.ts` 的断言数量
- **文档原文**（`README.md:211`）：
  > 选择存进 `prefs.json`，同键再点一次切换升降序。两条硬约定（`src/client/sort.ts`，8 组断言锁死）：
- **代码证据**：`grep -cE '^\s*(test|it)\(' src/client/sort.test.ts` → **11**；用例名见 `src/client/sort.test.ts:33,43,52,58,70,87,104,117,124,132,141`。
- **未确认**：「8 组」是否指某种更粗的分组而非 `test()` 条数 —— 若作者原意是分组，需人工确认口径。确认方法：问作者「8 组」的定义，或看 v0.28.0 时的 `sort.test.ts` 是否为 8 条（`git log -S '8 组断言' -- README.md` 可定位引入版本）。
- **建议动作**：改文档（先按 11 条核对；确认是分组口径则补一句定义）。

### 1.9 【P1】README 文件清单列了已删除的 `src/client/treemap.ts`

- **项**：README「开发」节的源码树
- **文档原文**（`README.md:422`）：
  > `  client/treemap.ts   # squarified treemap（纯函数，面积/越界/重叠/长宽比均有断言）`
- **代码证据**：
  - `ls src/client/treemap.ts` → 不存在（`src/client/` 下无任何含 `treemap`/`squarified` 的文件）。
  - `src/client/cloudMap.test.ts:72-75`：
    ```
    // 被删的文件本身也不该再存在
    for (const f of ['IndustryHeatmap.tsx', 'treemap.ts', 'treemap.test.ts']) {
      assert.throws(() => readFileSync(join(here, f)), /ENOENT/, `${f} 必须已删除`)
    }
    ```
- **解释**：这是**测试主动禁止其存在**的文件，README 却把它列为现有模块。
- **建议动作**：改文档（删该行；并在 `client/*.tsx` 注释里补上工具箱/日历页，见下条）。

### 1.10 【P1】README 源码树漏了新页面

- **项**：`README.md:419` 的 `client/*.tsx` 说明
- **文档原文**（`README.md:419`）：
  > `  client/*.tsx        # TopBar/自选/持仓/大盘/云图 + SVG 分时图 + 悬浮卡`
- **代码证据**：`src/client/` 下现有页面组件 `WatchlistPage.tsx`、`PortfolioPage.tsx`、`MarketPage.tsx`、`CloudMap.tsx`、`CalendarPage.tsx`、`ToolsPage.tsx` —— 注释只提了 5 个中的 4 个，漏 `CalendarPage`，且完全没有 `ToolsPage`（及其配套 `toolRegistry.ts` / `toolCardView.ts` / `tools/cake.ts` / `toolsNav.ts`）。
- **建议动作**：改文档。

### 1.11 【P2】README 引用的本机读数已过期（`100.KOSPI200`）

- **项**：已知边界里的待复核数字
- **文档原文**（`README.md:452`，节选）：
  > - **待复核：`100.KOSPI200` 的数值水平**。本机 `quotes-lkg.json` 里东财返回的 `100.KOSPI200`（名为「韩国KOSPI200」）为 **1088.15**，
- **代码/文件证据**：本机 `/home/hu/.dsh/dsh-tradewatcher/quotes-lkg.json` 现值为
  `{"secid": "100.KOSPI200", "name": "韩国KOSPI200", "price": 1020.8, ... "pct": -2.27, "prev": 1044.52}`（price = **1020.8**，非 1088.15）。
- **解释**：该条**结论仍未解决**（1020.8 相对 KOSPI200 的常见点位水平仍然可疑），但**引用的具体读数已被后续刷新覆盖**。这是"把易变的本机快照写进 README"的结构性代价。
- **建议动作**：改文档（把 `1088.15` 改为「首次观测 1088.15（2026-10 快照）」并注明"读数会随后续刷新变化"，或改为不写死数值）。

### 1.12 【P2】`README.md:193` 路由索引漏 5 条

- **项**：HTTP 路由索引完整性
- **文档原文**（`README.md:193`，全文）：
  > `GET /tradewatcher/health|badge|quotes?ids=|trend?secid=|kline?secid=|detail?secid=|suggest?q=|board?scope=&sort=&pn=&pz=|anomaly?ids=|ytd?ids=|breadth`、`GET|POST /tradewatcher/watch|portfolio|prefs|calendar`、`GET /tradewatcher/ledger`、`GET /tradewatcher/trades?secid=`、`GET /tradewatcher/industry|industries`、`GET|POST /tradewatcher/backup`（导出/导入备份；POST body `{mode:'preview'|'apply', bundle}`）
- **代码证据**：实际 25 条路径。该行列了 20 条，**漏**：
  | 漏掉的路径 | 代码位置 | 备注 |
  | --- | --- | --- |
  | `/tradewatcher/rows` | `src/host/routes.ts:390` | **页签门控的唯一依据**，最不该漏 |
  | `/tradewatcher/chips` | `src/host/routes.ts:322` | 筹码分布 |
  | `/tradewatcher/tones` | `src/host/routes.ts:617` | 五档状态 badge |
  | `/tradewatcher/rescue` | `src/host/routes.ts:1033` | 护盘（README §护盘 有正文但索引里没有） |
  | `/tradewatcher/tools/global-flow` | `src/host/routes.ts:409` | 工具箱数据 |
  - 参数名核对通过：`board` 的 `scope`/`sort`/`pn`/`pz` 与 `src/host/routes.ts:905-910` 一致。
- **建议动作**：改文档（补齐 5 条；或改为「完整清单以 `src/host/routes.ts` 为准 + 常用几条」）。

### 1.13 【P1】数据文件表漏了 `global-flow.json`

- **项**：`README.md:157-172` 的数据文件表
- **文档原文**（`README.md:155`）：`### 数据文件（DSH_HOME 默认 `~/.dsh`）` —— 表体 16 行，从 `watch.json` 到 `*.json.bak`，**没有 `global-flow.json`**。
- **文件/代码证据**：
  - 本机实际目录 `ls ~/.dsh/dsh-tradewatcher/` → `board-lkg.json  calendar.json  **global-flow.json**  klines  ledger.json  positions.json  prefs.json  quotes-lkg.json  rescue-log.json  trends  trends-lkg.json  write.json…`
  - `src/host/globalFlow.ts:570`：`return join(dataHome(), 'global-flow.json')`
  - `src/host/globalFlow.ts:564`：`purged?: FlowSnapshotPurged[]`（v0.74.0 的留痕字段）
- **解释**：这是 v0.72.0 起的新数据文件，README 的"明文 JSON 双通道"承诺里少了它 —— 而 README:189 明确说「上述数据文件路径固定、格式如上，任何会话可用文件工具直接读取」。
- **建议动作**：改文档（补一行：`global-flow.json` —— 五市场资金流每日快照，含 `v`/`scope`/`days`/`purged[]`）。

---

## 二、相互矛盾

### 2.1 【P0】README「大盘云图」整节与代码相反（且测试禁止该功能存在）

- **项**：云图页的形态与默认档
- **文档原文**（`README.md:77`）：
  > 两档，**默认自绘**：
- **文档原文**（`README.md:79`）：
  > - **自绘**：行业热力，面积＝板块成交额、色深＝涨跌幅（±5% 封顶，避免单个涨停压平色阶），口径与数据时刻/来源写在图上方。布局用 squarified treemap（纯函数，面积成比例/不越界/不重叠/长宽比不退化均有断言）——从大到小切条会在"一个极大值 + 一堆小值"时切出针一样的细条，面积既量不准也看不清。无成交额的板块不参与面积分配并明确报出数量（避免"图铺满了、其实缺了 N 个板块"）
- **代码证据**：
  - `src/client/CloudMap.tsx:2-5`：
    ```
     * 大盘云图：**只保留第三方站点**（用户要求下线内建热力视图，v0.62.0）。
     *
     * 为什么不再有两视图段控：段控只剩一个选项就是纯噪音 —— 内建那一套已整块删除
     * （其渲染组件、取数、派生与口径段落一并下线），本组件只剩第三方 iframe 与其三态
    ```
  - `src/client/cloudMap.test.ts:45-53`：`for (const m of ['IndustryHeatmap', '自绘']) { if (cloudMapSrc.includes(m)) bad.push(...) }` —— 用**反例注入**证明判据有咬合力（`injectedRender` 必须让断言失败）。
  - `src/client/cloudMap.test.ts:70`：`test('① 内建热力视图与「段控」彻底移除（全仓 src/** 无残留字样；title/aria-label 也没有）', () => {`
  - `docs/DESIGN-SUBPLUGINS.md:64`：`**v0.62.0**：云图页内建热力视图下线后 `/board` 只剩 `MarketPage.tsx:84` 一个调用方`
  - `CHANGELOG.md:588`：`## v0.62.0 — 云图只留第三方站点（删自绘）+ `/board` 归属随之改到 market 行 + 修一个先于本轮的测试竞态`
- **解释**：README:82「之所以默认自绘：只有自绘才标得了口径」也随之失效 —— 现在**唯一**的档位是第三方 iframe，而它明确"口径由站点决定"。这是本次审计中**唯一一处文档描述的功能已被测试判为非法残留**的条目。
- **建议动作**：改文档（重写 README §大盘云图：删「两档/默认自绘」与自绘整段，改为单一第三方 iframe + 三态降级；并删 README:422 的 `treemap.ts` 行）。

### 2.2 【P0】DESIGN-SUBPLUGINS §2 与 §2.1 自相矛盾（路由归属两套说法）

- **项**：每个功能行独占哪些路由
- **文档原文**（`docs/DESIGN-SUBPLUGINS.md:55`，§2「行怎么切（选定方案）」）：
  > **功能行（可关）**：`watchlist`（`/watch` `/ledger` `/trades`、`watchlist`/`group_rank` 工具、自选 tab）｜`portfolio`（`/portfolio`、`portfolio`/`ledger` 工具、持仓 tab）｜`market`（`/breadth` `/board` `/rescue` `/anomaly` `/industries` `/industry`、`rescue` 工具、大盘 tab + 护盘面板）｜`cloudmap`（**无 host 路由**，纯客户端 iframe，云图 tab）｜`calendar`（`/calendar`、`calendar`/`calendar_add` 工具，日历 tab）。
- **文档原文**（`docs/DESIGN-SUBPLUGINS.md` §2.1 表，`:65-66`）：
  > | `watchlist` | `/watch` | `watchlist` `group_rank` | `group_rank` 的数据来源是自选分组 ⇒ 归此行；`/trades` 因被抽屉共用而移回 core |
  > | `portfolio` | `/portfolio` `/ledger` | `portfolio` `ledger` | `/ledger` 只有持仓页的流水弹窗用；`dayTrades` 随 `portfolio` 工具 |
- **代码证据**（`src/index.ts:32-65` `ROW_ROUTES`）：
  | 行 | 现行独占路由 | §2（`:55`）说法 | §2.1（`:61-66`）说法 | 代码 |
  | --- | --- | --- | --- | --- |
  | watchlist | `/watch` `/industries` `/anomaly` | `/watch` `/ledger` `/trades` ✗ | `/watch` ✗（不全） | ✅ |
  | portfolio | `/portfolio` `/ledger` | `/portfolio` ✗（缺 ledger） | `/portfolio` `/ledger` ✅ | ✅ |
  | market | `/breadth` `/rescue` `/board` | `/breadth` `/board` `/rescue` `/anomaly` `/industries` `/industry` ✗ | `/breadth` `/board` `/rescue` ✅ | ✅ |
  | core | 其余 15 条 | — | 「除下表之外的全部（…health/undo/rows/tones…）」 | ✅ |
- **解释**：§2 是「**选定方案**」标题下的正文，读者最可能停在那里；它对 4 条路由的归属与代码相反（`/ledger`、`/trades`、`/industries`、`/anomaly`、`/industry`）。§2.1 标题写明是「P1–P4 落地后复核」，是**较新且正确**的那一份。另有小瑕：`:61` 把 `undo` 列进 core 的**路由**清单，但全仓没有 `/tradewatcher/undo` 路由（`undo` 只是 agent 工具，见 `src/host/tools.ts:811`），实测 25 条路径中不含它。
- **建议动作**：改文档（把 §2 `:55` 整段替换为指向 §2.1 表格的一行，删掉重复的路由清单；`:61` 从路由清单里摘掉 `undo`）。

### 2.3 【P0】CHANGELOG v0.71.0 声明"README 与 DESIGN-SUBPLUGINS 已一并更新" —— 实际没有

- **项**：CHANGELOG 条目与产物是否对得上（"声明了却没做"）
- **文档原文**（`CHANGELOG.md:191`，v0.71.0 §六「未做」）：
  > - 版本号 / README / `docs/DESIGN-SUBPLUGINS.md` §2.1 表格：本轮已在本次发布中一并更新。
- **代码/事实证据**：
  - `README.md:344` 仍写「拆成**六行**」，且六项清单**不含 `tools`**。
  - `README.md:346` 仍写「v0.59.0 起为六行」并给失效行号。
  - `docs/DESIGN-SUBPLUGINS.md:56` 仍写「**总行数（目标形态）**：core + 5 = 6 行；**当前 manifest 只装 1 行**（`cordis.patch.yml:15-17`）」——**"当前 manifest 只装 1 行"从 v0.59.0 起就不成立了**。
  - `docs/DESIGN-SUBPLUGINS.md:3` / `:5` / `:113` / `:162` 仍写六行。
  - §2.1 表格（`:59-66`）**确实**已含 `tools` 行之外的六行、且路由归属正确 —— 所以「§2.1 表格已更新」这一半大概是真的，但「README … 已一并更新」这一半不成立。
- **解释**：v0.71.0 加第 7 行时，只有 `cordis.patch.yml`、`locale/`、`package.json`、`src/index.ts`、`src/client/index.tsx`、新页面文件与 CHANGELOG 被改；README 与 DESIGN-SUBPLUGINS 未改。见 §4.1 的 **C1**（另有 C2–C7 六条同类问题）。
- **建议动作**：改文档（修正 CHANGELOG 该条为"未做"，或**现在**把 README/DESIGN-SUBPLUGINS 改对并把该条改成"已于 v0.75.0 补正"）。

### 2.4 【P1】ROADMAP 的量价共振阈值与代码/README 相反

- **项**：自选异动的量价共振判据
- **文档原文**（`docs/ROADMAP.md:182`，P1-4 的 **✅ 已完成**条目）：
  > …阈值 2.5x；价格异动 ±5%；量价共振（≤3% 且 ≥2x）单独判。…
- **文档原文**（`README.md:329`）：
  > - **判据**：量能倍数（**同时点口径**：今日量 ÷ (20 日均量 × 日内进度)，阈值 2.5x，复用护盘标定的进度曲线）、价格异动（|涨跌幅| ≥ 5%）、量价共振（|涨跌幅| ≥ 3% 且量能 ≥ 2x —— 单条都不越线、组合越线）
- **代码证据**：
  - `src/host/anomaly.ts:14-15`：`export const PRICE_PCT_COMBO = 3` / `export const VOLUME_MULT_COMBO = 2`
  - `src/host/anomaly.ts:86`：`const comboHit = mult !== null && pct !== null && Math.abs(pct) >= PRICE_PCT_COMBO && mult >= VOLUME_MULT_COMBO`
- **解释**：ROADMAP 的 `≤3%` 与代码的 `>= 3%` **方向相反**。README 正确。ROADMAP 该条带 ✅ 标记，读者会当成已落地的现行口径。
- **建议动作**：改文档（`docs/ROADMAP.md:182` 的 `≤3%` 改为 `≥3%`；注意该节标题写明 P1 条目"保留原始条目文本"的部分在 `:22` 的 P0 节，P1-4 的 ✅ 段不属于"原始文本"保护范围）。

### 2.5 【P1】"4 个时区下断言一致"在两份文档里重复，且代码里找不到对应物

- **项**：时区断言的覆盖范围
- **文档原文**（`README.md:205`）：
  > 全插件的时间标签**只有一套口径：`Asia/Shanghai`**（`src/host/time.ts`）。`hhmmOf` / `dayOf` / `weekdayOf` / `calToday` / `shanghaiDayStart` 全部来自同一实现，并在 **4 个时区**（Asia/Shanghai、UTC、America/New_York、Australia/Sydney）下断言一致；`npm test` 会把这套断言跑两遍（宿主 TZ 与 `TZ=UTC`），因为只有显式切 TZ 才锁得住时区回归。
- **文档原文**（`CHANGELOG.md:2343`，v0.17.0 条目）：同一句话**逐字重复**（含「**4 个时区**（Asia/Shanghai、UTC、America/New_York、Australia/Sydney）下断言一致」，见该行原文）。
- **代码证据**：
  - `grep -rn "Sydney\|悉尼"` 全仓（`--include=*.ts,*.tsx,*.md,*.json,*.mjs,*.yml`，排除 `node_modules`）**只命中这两处文档**：`README.md:205`、`CHANGELOG.md:2343`。
  - `git log --oneline -S "Australia/Sydney" -- src/` → **空**（该字符串从未进过 `src/`）。
  - `America/New_York` 在 `src/` 里只有一处，且是**注释**：`src/host/time.ts:71`：`* 例如北京时间周一 10:00 在 TZ=America/New_York 下是周日 22:00，`
  - `src/host/time.test.ts` 无任何按 TZ 参数化的结构；`package.json` 的 `test` 脚本只跑 **2** 个 TZ：`"test": "node --test --experimental-strip-types \"src/**/*.test.ts\" && TZ=UTC node --test --experimental-strip-types \"src/**/*.test.ts\""`
  - `src/host/time.test.ts:2` 的注释反而说明断言**不依赖**宿主 TZ：`* —— 否则在任何一台 UTC+8 机器上都是绿的。`
- **解释**：`hhmmOf`/`dayOf`/`weekdayOf`/`calToday`/`shanghaiDayStart` 五个导出**确实存在**（`src/host/time.ts:54/59/64/74/81`），"只有一套口径"**成立**；**不成立的是"在 4 个时区下断言一致"** —— 断言事实上是**时区无关**设计 + 跑两遍 TZ，覆盖 2 个时区。DISPLAY 列出的 4 个时区没有任何测试或代码证据。
- **建议动作**：改文档（两份都改成实际情况：「断言不依赖宿主 TZ，`npm test` 在宿主 TZ 与 `TZ=UTC` 各跑一遍」）；若确实想要 4 时区覆盖 ⇒ 改代码（在 `time.test.ts` 里加 4 个 TZ 的参数化，去掉这句就得改成"已验证"）。

### 2.6 【P1】`cordis.patch.yml:72` 与 `src/index.test.ts:50` 的注释和代码相反

- **项**：`tools` 行有没有独占路由
- **原文**（`cordis.patch.yml:72`）：
  > `    # 工具箱：工具目录页 + 工具详情页（客户端半区）；host 侧本轮无独占路由/工具`
- **原文**（`src/index.test.ts:50`）：
  > `  // 第 7 行（v0.71）：工具箱（工具目录 + 工具详情），客户端半区；host 侧无独占路由/工具`
- **代码证据**：
  - `src/index.ts:64`：`  tools: ['/tradewatcher/tools/global-flow'],`
  - `src/index.test.ts:321`：`  // 第 7 行（工具箱）：独占五市场蛋糕的数据路由（单一消费方 ⇒ 该行）`
  - `src/host/routes.ts:409`：`      path: '/tradewatcher/tools/global-flow',`
  - `CHANGELOG.md:131`（v0.72.0）：`ROW_ROUTES.tools = ['/tradewatcher/tools/global-flow']`（原为空数组；注释里预告过「有独占路由就写进来」）。
- **解释**：两处注释都是 v0.71.0 写的（当时 `tools: []`），v0.72.0 加了路由但没回来改注释。`cordis.patch.yml` 的**文件头**（`:17-23`）写对了（「`/tradewatcher/tools/global-flow`（五市场蛋糕的数据；**只被工具箱页消费** ⇒ 按 §2.2 判据归本行，v0.72.0 起它确实独占了一条路由）」），所以是**同一文件内注释自相矛盾**。
- **建议动作**：改代码注释（两处删掉「无独占路由」⇒「独占 `/tradewatcher/tools/global-flow`（v0.72.0 起）」）。

### 2.7 【P2】`docs/DESIGN-SUBPLUGINS.md:3` 的行名分配也说错了

- **项**：哪些行用子路径包名
- **文档原文**（`docs/DESIGN-SUBPLUGINS.md:3`，节选）：
  > **core 行用裸包名 `dsh-tradewatcher`**（保住浏览器半区，见 §归因纠正）、**另五行用 `dsh-tradewatcher/rows/<row>`**（标题可区分）
- **代码证据**：`cordis.patch.yml:51` 写「其余**六行**用 `dsh-tradewatcher/rows/<row>`」；实测 `grep -c "rows/" cordis.patch.yml` 的 name 行 = **6**（calendar/watchlist/portfolio/market/cloudmap/tools）。`src/index.test.ts:388` 断言：`if (bare.length !== 1) fail.push(\`必须恰好一行用裸包名 ${BARE_PKG}（实测 ${bare.length} 行）⇒ 否则浏览器半区不注册\`)`
- **建议动作**：改文档（「另五行」→「另六行」）。

---

## 三、失效指引（README 的命令 / 路径 / 步骤）

**只验证命令与路径是否存在，未执行任何安装、构建或重启。** 逐条：

| # | README 指引 | 行 | 存在性核对 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | `cd dsh-tradewatcher && npm install && npm run build` | `README.md:133` | `package.json` 有 `build: node build.mjs`；`devDependencies` 含 esbuild/typescript | ✅ 可用 |
| 2 | `# 或 npm run check（含类型检查/测试/自检）` | `README.md:133` | `"check": "npm run typecheck && npm run test && npm run selftest && npm run build"` | ✅ 可用 |
| 3 | `bash scripts/install.sh` | `README.md:136` | `scripts/install.sh` 存在（2716B，可执行） | ✅ 可用 |
| 4 | `默认 ~/.dsh/profiles/web，可用 DSH_PROFILE_DIR 覆盖` | `README.md:135` | `scripts/install.sh:17`：`PROFILE_DIR="${1:-${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}}"` | ✅ 可用 |
| 5 | `bash scripts/uninstall.sh` | `README.md:142` | `scripts/uninstall.sh` 存在（1319B，可执行） | ✅ 可用 |
| 6 | `npm test` 会把这套断言跑两遍 | `README.md:205` | `package.json` 的 `test` 脚本确实跑两遍（宿主 TZ + `TZ=UTC`） | ✅ 可用（但与 §2.5 的"4 个时区"表述矛盾） |
| 7 | `数据都在 ~/.dsh/dsh-tradewatcher/*.json` | `README.md:151` | 目录存在，14 个 `.json` + `klines/` + `trends/` | ✅ 可用 |
| 8 | `~/.dsh/profiles/<profile>/cordis.patch.yml` 按 id 覆盖 | `README.md:349` | 与 `cordis.patch.yml:35-38` 的说明一致；脚本不触碰该文件 | ✅ 可用（未实测覆盖生效，见「未确认」） |
| 9 | `地址见 src/client/CloudMap.tsx 的 CLOUD_MAP_URL` | `README.md:80` | `src/client/CloudMap.tsx:16`：`const CLOUD_MAP_URL = 'https://52etf.site/'` | ✅ 可用 |
| 10 | `逐轮审计与验收报告…见 docs/archive/` | `README.md:381-383` | **`docs/archive/` 只有旧的**（`AUDIT-IMPL.md`/`IMPL2–21`/`VERIFY*`/`V2-*`/`V3-*` 等）；**现行的 29 份在 `docs/`**（`AUDIT-CACHE-1/2`、`AUDIT-HY4-1`、`AUDIT-IMPL22–47`） | ❌ **失效指引** |
| 11 | `来由：docs/archive/AUDIT-COPY2.md` | `README.md:401` | 文件存在 | ✅ 可用 |
| 12 | `未落地的设计稿（如 DESIGN-DASHBOARD.md）顶部会写明"未落地"` | `README.md:383` | `docs/DESIGN-DASHBOARD.md:3`：`> **未落地**（v0.33.1 已回退）：…`；`docs/DESIGN-STRIP-CONFIG.md:1`：`# 行情卡片配置窗 + 五档状态 badge（设计规格 · **未落地**）` | ✅ 可用（两处都标了） |

**第 10 条详解（唯一失效项）**：

- **文档原文**（`README.md:381-383`）：
  > 逐轮审计与验收报告（含历史版本的过程记录）见 `docs/archive/`（`AUDIT-*`、`COMPETITOR-NOTES.md`、
  > 各批实现自述 `AUDIT-IMPL*.md`），**口径以本 README 的「口径规范」为准**；
  > 未落地的设计稿（如 `DESIGN-DASHBOARD.md`）顶部会写明"未落地"，不要照它改代码。
- **事实证据**：
  - `docs/archive/` 共 **41** 个文件，其中 `AUDIT-IMPL*.md` 只到 **`AUDIT-IMPL21.md`**（另有不带号的 `AUDIT-IMPL.md`）。
  - `docs/`（非 archive）里有 **29 份** `AUDIT-*.md` = `AUDIT-IMPL22.md` … `AUDIT-IMPL47.md`（26 份）+ `AUDIT-CACHE-1.md` + `AUDIT-CACHE-2.md` + `AUDIT-HY4-1.md`（3 份）。
  - `README.md:347` 自己就把一份现行报告指向了 `docs/`：`行归属与设计见 `docs/DESIGN-SUBPLUGINS.md`，落地与验证记录见 `docs/AUDIT-IMPL35.md``。
- **建议动作**：改文档（把「见 `docs/archive/`」改成「见 `docs/AUDIT-*.md`（现行）与 `docs/archive/`（v0.50.0 前的历史）」；顺带说明两层的关系）。

---

## 四、`CHANGELOG.md` 的可验证性（v0.67.0 起）

方法：对每条**断言了代码事实**的条目，去找代码/测试里的对应物；纯散文与"实测读数"类条目（依赖当时真网络/本机状态）不计入通过与否。**逐字引文均取自文件**。

### 4.1 找不到对应物 / 与事实不符的条目

| # | 版本 | CHANGELOG 原文（逐字） | 位置 | 核查结果 | 建议 |
| --- | --- | --- | --- | --- | --- |
| **C1** | v0.71.0 | `- 版本号 / README / \`docs/DESIGN-SUBPLUGINS.md\` §2.1 表格：本轮已在本次发布中一并更新。` | `CHANGELOG.md:191` | **与事实不符**：README 与 DESIGN-SUBPLUGINS 至今仍写六行（见 §1.1、§2.3）。§2.1 表格确已含正确路由归属（`:59-66`），故该句**一半真一半假** | 改文档（要么改成"未做"，要么现在补做后改写） |
| **C2** | v0.73.0 | `` `REQ-tools-component.md` T-5 写「5 个市场（A股、港股、美国、日本、韩国）」，与任务书「用户已定：美股、欧股、日股、A股、新兴市场」**不一致**。`` | `CHANGELOG.md:104` | **被引用文件不存在**：全仓 `find . -name "REQ-*"`（排除 `node_modules`）→ 无任何命中；该文件名在仓内被引用 **4 处**：`CHANGELOG.md:79`、`CHANGELOG.md:104`、`src/client/toolRegistry.test.ts:216`、`docs/AUDIT-IMPL46.md:168` 与 `:338`、`docs/AUDIT-IMPL47.md:3` | 补文件（把需求文档入库，或把引用改为可定位的出处）；否则"逐字匹配需求原文"的断言（`src/client/toolRegistry.test.ts:216`）无法被复核 |
| **C3** | v0.73.0 | `- **逐字**写入需求原文那句「这是风险偏好代理，不是真实跨境资金净流入」（\`REQ-tools-component.md\` T-5；断言按逐字匹配）…` | `CHANGELOG.md:79` | 同 C2：`REQ-tools-component.md` 不存在 ⇒「需求原文」无法核对。**断言本身存在**（`src/client/toolRegistry.test.ts:216` 有注释「需求原文（REQ-tools-component.md T-5）要求的那句话要**逐字**在页面上」），但"逐字"的基准不可查 | 同 C2 |
| **C4** | v0.67.0 | `` `em.ts:21` 引入 \`writeFileAtomic\`，四处落盘点改 tmp + rename：\`276\`（\`quotes-lkg.json\`）、\`734\`（\`board-lkg.json\`）、\`1054\`（\`trends-lkg.json\`）、\`1782\`（\`klines/<secid>_<klt>_<fqt>.json\`）。`` | `CHANGELOG.md:349` | **部分（内容全对，行号已漂移）**：`:21` 正确；四个落盘点在 HEAD 为 **`:322`**（`writeFileAtomic(join(dataHome(), 'quotes-lkg.json')…`）、**`:783`**（`board-lkg.json`）、**`:1103`**（`trends-lkg.json`）、**`:1835`**（`klines` 已升级为 `updateJsonLocked`）。漂移由 v0.68.0 的 import 与 klines 加锁改动造成 | 可接受（CHANGELOG 行号是当时值）；**不要再从 CHANGELOG 抄行号**，建议给"锚函数名/文件名字符串"而非行号 |
| **C5** | v0.68.0 | ``报告 `docs/AUDIT-IMPL42.md`（520 行：协议 / API 契约 / 覆盖清单 / 合并语义 / 改动点行号 / 证据 / 复现命令）。`` | `CHANGELOG.md:298` | **行数不符**：`wc -l docs/AUDIT-IMPL42.md` = **552**。所列举的章节（协议/契约/覆盖清单/合并语义/行号/证据/复现命令）确实都在，只有行数对不上 | 改文档（改成 552，或删掉行数）；"520 行"可能是指正文不含附录 —— 但文件里没有这样的自我声明 |
| **C6** | v0.70.0 | （代码注释里的版本号，非 CHANGELOG 正文）` * 行业/板块取数失败时给**受影响控件**的悬停原因（v0.69.1）。` | `src/client/watchlistView.ts:6` | **版本号在版本史里不存在**：`v0.69.1` 出现在 **5 处代码/注释**（`src/client/watchlistView.ts:6`、`src/client/watchlistHints.test.ts:2`、`src/client/WatchlistPage.tsx:239`、`:253`、`:378`）与 **1 处文档**（`docs/AUDIT-IMPL39.md:135`：`# 追加（v0.69.1）：自选页红框两行常驻提示已删 —— 降级事实降到悬停层`）。但 `grep -c "v0.69.1" CHANGELOG.md` = **0**，`git log --grep="0.69.1"` 无命中；该改动实际随 **v0.70.0**（commit `f4dd719`）发布 | 改代码注释（`v0.69.1` → `v0.70.0`）；否则按版本号回溯会找不到条目。**这是"代码注释 vs CHANGELOG"的单向不一致，属 §1/§2 之外的第三类** |
| **C7** | v0.67.0 | `**时刻敏感排查**：把时钟整体平移到"盘中/盘后/周六"跑全仓 **61 个测试文件** ⇒ 除已修这条外**无其它命中**（静态 grep 结论一致）。` | `CHANGELOG.md:355` | **计数差 1**：`git ls-tree -r 2e84e03 --name-only \| grep -c '\.test\.ts$'` = **60**（v0.67.0 的提交），HEAD = 71。同一说法在 `docs/AUDIT-IMPL41.md:202` 也有（`跑**全仓 61 个测试文件**，比对失败集合：`）。**未确认**差值 1 的来源（可能把非 `.test.ts` 的 helper 也数进去）。确认方法：复现 `docs/AUDIT-IMPL41.md` §时刻敏感排查 的原始命令 | 可接受（不影响结论）；若要精确，把"61 个测试文件"改为"全仓测试文件（当时 60 个 `.test.ts`）" |

### 4.2 逐版核对结果（抽查，非全量）

| 版本 | 位置 | 抽查的断言 | 对应物 | 结论 |
| --- | --- | --- | --- | --- |
| v0.74.0 | `CHANGELOG.md:14` | 口径标识 `v2:cn,hk,us,jp,kr` | `src/host/globalFlow.ts:77`：`export const FLOW_SCOPE = 'v2:cn,hk,us,jp,kr'` | ✅ |
| v0.74.0 | `:37` | 快照升 `v=2` + `scope` + 留痕 `purged[]` | `src/host/globalFlow.ts:564`（`purged?`）、`:583-595`（两级校验与 `keepPurged`） | ✅ |
| v0.74.0 | `:41` | `CATALOG_TITLE` 一并移除 | 全仓仅在 `src/client/toolRegistry.test.ts:81` 出现（断言其**不存在**）：`assert.equal('CATALOG_TITLE' in ToolText, false, 'toolText 不许再导出 CATALOG_TITLE')` | ✅ |
| v0.74.0 | `:42` | `toolCardView.ts` 新模块（`CARD_TAG='button'`、`CARD_PROPS={type:'button',tabIndex:0}`、`CARD_STYLE` = `var(--tw-shadow-lg)` + `borderRadius:12`） | `src/client/toolCardView.ts:15/24/32/35/36` 全部逐字命中 | ✅ |
| v0.74.0 | `:42` | 页脚 `打开工具 →` 已删、`ToolCard.action` 字段一并删除 | `grep -n "action" src/client/toolCardView.ts` → 无命中 | ✅ |
| v0.74.0 | `:44` | 工具名/chip 逐字锁定 `全球资金流蛋糕模型` / `宏观 \| 全球轮动` | `src/client/toolRegistry.test.ts:62-66`（4 条逐字断言） | ✅ |
| v0.74.0 | `:48` | `532 / 532 × 2 时区`、`build（73 项）` | 实测 `532` 条 `test(`（71 个测试文件）；`build.mjs` 片段 **73** | ✅ |
| v0.73.0 | `CHANGELOG.md:58` | 判据下沉为 `toolText.looksLikeZeroStandIn()` | `src/client/toolText.ts:52`：`export function looksLikeZeroStandIn(text: string): boolean {` | ✅ |
| v0.72.0 | `:131` | `ROW_ROUTES.tools = ['/tradewatcher/tools/global-flow']`（原为空数组） | `src/index.ts:64` 逐字一致 | ✅ |
| v0.72.0 | `:125` | `515 条测试 × 2 时区全绿（494 → 515，+21）` | 与 v0.71.0 的 494、v0.73.0 的 523 构成单调链 | ✅ |
| v0.71.0 | `:152` | `cordis.patch.yml:73-75` 第 7 行；真 YAML 解析器验过 `insert = 7 行` | `cordis.patch.yml:73-75` 逐字命中；插入块 7 条 `- id:` | ✅（**本文件里唯一行号正确的一条**） |
| v0.71.0 | `:187` | 可用兜底 22 → 18、新浪专供 15 → 8 | `src/host/selftest.ts:509/515/516` | ✅ |
| v0.71.0 | `CHANGELOG.md:167` | `494 / 494 × 2 时区 + selftest + build（73 项片段）` | 与 v0.70.0 的 478 单调 | ✅ |
| v0.70.0 | `:212` | `478 条测试 × 2 时区全绿（476 → 478）`；新增 `src/client/watchlistHints.test.ts`（2 条断言） | 该文件实测 **2** 条 `test(` | ✅ |
| v0.70.0 | `:226` | `` `build.mjs` 零改动（73 项）`` | `build.mjs` 实测 73 | ✅ |
| v0.69.0 | `:240` | `476 / 476 × 2 时区`；`klines/` 并发端到端：新增 `src/host/klineLock.test.ts`（2 条） | 该文件实测 **2** 条；`src/host/klineLock.child.ts`、`src/host/klineLock.test.ts` 均存在 | ✅ |
| v0.68.0 | `:285` | `474 / 474 × 2 时区`；报告 `docs/AUDIT-IMPL42.md` | 文件存在；`src/host/rescuePersist.test.ts`、`src/host/rescuePersist.child.ts`、`src/host/lock.child.ts` 存在（与"真子进程"说法一致） | ✅ |
| v0.67.0 | `:346` | `473 / 473 × 2 时区`；新增 `src/host/fetchDedupe.test.ts`（20 条） | 该文件实测 **20** 条 | ✅ |

**测试条数链条自洽**：v0.67.0 **473** → v0.68.0 **474** → v0.69.0 **476** → v0.70.0 **478** → v0.71.0 **494** → v0.72.0 **515** → v0.73.0 **523** → v0.74.0 **532**（≡ 实测 532）。**无矛盾**。

### 4.2b v0.67.0–v0.70.0 的定点核对（46 条断言逐条找对应物）

对这四个版本做了**逐条**核对（断言了代码事实的条目，共 46 条）。**结论：不存在"应该存在却不存在"的代码** —— 全部命中；未命中只出现在行号漂移与计数上（即 C4–C7）。以下列**关键命中**，用来证明这几个版本的 `### 修法要点` / `### 改动` 不是事后追述：

| 版本 | CHANGELOG 断言的机制 | 对应物（`path:line`） | ✅ |
| --- | --- | --- | --- |
| v0.67.0 | P0-1 分时 in-flight 合并（并发 8 ⇒ 1） | `src/host/em.ts:1136` `const trendInflight = new Map<string, Promise<TrendData \| null>>()`；断言 `src/host/fetchDedupe.test.ts:195` | ✅ |
| v0.67.0 | P0-2 clist 分页短 TTL（112 ⇒ 56） | `src/host/em.ts:2344` `const CLIST_PCT_TTL_MS = 20_000`；断言 `src/host/fetchDedupe.test.ts:246-247`（`unique = 56` 且 `clistRequests === unique`） | ✅ |
| v0.67.0 | P1-1 源 B 负缓存 | `src/host/breadthCount.ts:27` `BREADTH_COUNT_FAIL_TTL_MS = 30_000`；`src/host/em.ts:2345` `CLIST_PCT_FAIL_TTL_MS = 15_000` | ✅ |
| v0.67.0 | P1-2 分布有限并发 6 + "没扫全 ⇒ counts: null" | `src/host/routes.ts:46-47` `const DIST_CONCURRENCY = 6`；`:570-574` 未扫全不给部分分布 | ✅ |
| v0.67.0 | P1-3 日K 收口到熔断器 | `src/host/em.ts:2019-2034` `fetchHostThroughBreaker`（`!breaker.allow()` / `claimProbe()` / `recordFailure(error)`） | ✅ |
| v0.67.0 | 槽 TTL 必须 > 轮询间隔（命中率 0% 的根因） | `src/host/em.ts:816` `let quoteFreshMs = 10_000`；`:844` `quoteSlotTtlMs()` = 间隔 + 20% ⇒ 12000；断言 `src/host/fetchDedupe.test.ts:396` `assert.ok(ttl > em.quoteFreshnessMs(), …)` | ✅ |
| v0.67.0 | 收盘后回源只对沪深、外盘/商品仍轮询 | `src/host/em.ts` `frozenOfflineSlot()`；断言 `src/host/fetchDedupe.test.ts:427`（A 股定稿复用）与 `:449`（外盘/商品不受 A 股时段冻结） | ✅ |
| v0.67.0 | 采样器复用同一份行情缓存 | `src/host/rescue.ts:717` / `:900-906`（与顶部行情条共用逐标的槽）；断言 `src/host/fetchDedupe.test.ts:520, :541` | ✅ |
| v0.67.0 | 修既有测试缺陷：钉北京时间 10:30 | `src/host/chips.test.ts:327-330` `const FAKE_NOW = Date.parse('2026-10-12T10:30:00+08:00')`；`:363` `assert.ok(series.latest.samples >= 10, …)` | ✅ |
| v0.68.0 | store 四文件加锁（锁内刷新→改→写回） | `src/host/store.ts:499` `withFileLocks(files.map((f) => join(this.dir, f)), fn, {…})`；`:748-751` / `:914-921` / `:1109-1116` / `:1125-1128` 各自落点；`:610` 注释「导入是**显式覆盖**语义」 | ✅ |
| v0.68.0 | `rescue-log.json` 计数合并语义 | `src/host/rescue.ts:1082-1088` `updateJsonLocked(… mergeRescueLog(disk, this.file, this.samplesBase) …)`；断言 `src/host/rescuePersist.test.ts:45-56`（初值 7 + 两进程各 +1 = 9） | ✅ |
| v0.68.0 | `klines/` 加锁 + 读-合并-写；prune 目录级互斥 | `src/host/em.ts:1835-1851` `updateJsonLocked(klineFile(…), (disk) => ({ … bars: mergeBars(…) }))`；`:1874` `withFileLock(join(dir, '.klines'), …)` + `src/host/lock.ts:132` 追加 `.lock` | ✅ |
| v0.68.0 | `writeFileAtomic` 临时名写死 `<target>.tmp` | `src/host/atomic.ts:15-19` `const tmp = \`${target}.tmp\`` | ✅ |
| v0.68.0 | 双进程各 `samples += 3` ⇒ 6；两个真进程各写 6+6 ⇒ 12/12 | `src/host/lock.test.ts:110`、`:336` | ✅ |
| v0.68.0 | 覆盖证明：外部持锁 ⇒ store 写入各自等待 ≥300ms | `src/host/lock.test.ts:361` | ✅ |
| v0.68.0 | `1.000012` 不在请求集合（23 张） | `src/client/engineIds.test.ts:35/:38/:40`（`quoteEngineIds(TW_ROWS, USER_HIDDEN).length, 23`） | ✅ |
| v0.69.0 | `klineLock.child.ts` 硬断言 `DSH_HOME` 前缀 `/tmp` | `src/host/klineLock.child.ts:19-20`（`!dir.startsWith('/tmp')` ⇒ 拒绝运行） | ✅ |
| v0.69.0 | 并集 701 根（400 + 401 − 重叠 101） | `src/host/klineLock.test.ts:62` `assert.equal(dates.length, 701, '并集必须是 400 + 401 − 重叠 101 = 701 根…')` | ✅ |
| v0.69.0 | 配额 300 + 320 文件 + `.keepme`/`keepme.txt` 哨兵 | `src/host/klineLock.test.ts:73/:80/:81`；`src/host/em.ts:1862` `const KLINE_CACHE_MAX = 300` | ✅ |
| v0.69.0 | 清理数之和 22 = 322 − 300 | `src/host/klineLock.test.ts:102` `assert.equal(deleted, 22, …)` | ✅ |
| v0.70.0 | 删两个常驻块 + 行级两格带完整原因 | `src/client/WatchlistPage.tsx` 已无 `indState.status === 'error'`；`:379/:382/:390/:396-398` 四处接线；`src/client/watchlistView.ts:11` `indReasonOf` | ✅ |
| v0.70.0 | 一律北京时间（`timeZone: 'Asia/Shanghai'`） | `src/client/watchlistView.ts:16`；断言 `src/client/watchlistHints.test.ts:65` | ✅ |
| v0.70.0 | 两处反例注入（加回面板行 / 去掉 `title` ⇒ 4→3） | `src/client/watchlistHints.test.ts:51-55`、`:77-82`、`:71` `assert.equal(hits.length, 4, …)` | ✅ |

**统计**：v0.67.0–v0.70.0 共核 **46** 条 → **40 条 fully verified**、**5 条 partial**（行号/计数漂移：C4、C6、C7、C5、以及 v0.68.0 的历史计数 474 无法在本树复算）、**0 条 not-found**。

**推论**：CHANGELOG 的**机制描述**在这四个版本里是可信的（每条修法都能指到具体常量/函数/断言）；不可信的只有**行号与计数**。这与 §4.1 的结论一致：**该文件的价值在"为什么这么改"，不在"改在哪一行"。**

### 4.3 CHANGELOG 的结构观察（非缺陷，但影响可验证性）

- v0.67.0 起每版都有「### 验证」段，给出 `npm run check` 的**测试条数 + build 片段数 + 反例注入计数**。这套格式让 CHANGELOG **可核**——本次 v0.67.0–v0.74.0 共 **68** 条断言里 65 条一次就对上，是本次审计里最可信的文档。
- 但每版也大量引用 **`path:NNN` 行号**（如 `:349` 的 em.ts 四处、v0.71.0 的 `src/index.ts:29,53-64,73,122,280`），这些只在**当版**成立。建议：以后引用给"函数名 / 常量名"为主，行号只作辅助。
- **版本号纪律有一处破口**：`v0.69.1` 被 5 处代码注释 + 1 份报告当作版本号用，但 CHANGELOG 与 git 都没有这个版本（实际是 v0.70.0）。见 C6。
- `CHANGELOG.md` 没有「未发布 / Unreleased」段；v0.74.0 就是 HEAD。工作区 `git status --porcelain` 为空 ⇒ 文档与 `package.json` 版本一致。✅


---

## 五、历史报告定位（`docs/AUDIT-*.md`）

### 5.1 版本 / 提交标注（`docs/` 下 29 份，逐份）

| 文件 | 版本/基线标注（逐字节选） | 位置 | 判定 |
| --- | --- | --- | --- |
| `AUDIT-CACHE-1.md` | ``基线：`main` @ `24936cd`（v0.66.0），工作区干净`` | 首段 | ✅ MARKED |
| `AUDIT-CACHE-2.md` | ``基线：`main` @ `24936cd`（v0.66.0），`git status --short` 为空`` | 首段 | ✅ MARKED |
| `AUDIT-HY4-1.md` | ``**复核对象**：`main` @ `f4c1402`（v0.72.0，基线 `e692f7c`）`` | 首段 | ✅ MARKED（SHA + 版本） |
| `AUDIT-IMPL22.md` | `对象：\`dsh-tradewatcher\` v0.50.0 工作区` + `基线 386 条` | 首段 | ⚠️ 有版本，**无 commit** |
| `AUDIT-IMPL23.md` | `对象：\`dsh-tradewatcher\` 工作区。末次 \`npm run check\`：**387 条 × 2 时区全绿**…` | 首段 | ⚠️ 无版本、**无 commit**（只有测试条数） |
| `AUDIT-IMPL24.md` | `对象：\`dsh-tradewatcher\` v0.50.0 工作区（清单来源 \`docs/STE-REVIEW-UI.md\`，42 条…）` | 首段 | ⚠️ 有版本，**无 commit** |
| `AUDIT-IMPL25.md` | `对象：\`dsh-tradewatcher\` 工作区（v0.50.0）` | 首段 | ⚠️ 有版本，**无 commit** |
| `AUDIT-IMPL26.md` | `对象：\`dsh-tradewatcher\` 工作区。依据 \`docs/DIAG-PROF…\`` | 首段 | ⚠️ 无版本、**无 commit** |
| `AUDIT-IMPL27.md` | `对象：\`dsh-tradewatcher\` 工作…` | 首段 | ❌ **UNMARKED**（无版本、无 commit、无基线条数） |
| `AUDIT-IMPL28.md` | `对象：\`dsh-tradewatcher\` 工作区。` | 首段 | ❌ **UNMARKED** |
| `AUDIT-IMPL29.md` | `对象：\`dsh-tradewatcher\` 工作区（v0.52.0）` | 首段 | ⚠️ 版本，无 commit |
| `AUDIT-IMPL30.md` | ``基线：`main` @ `e89abb2`（v0.53.0），工作区干净，`npm run check` = **400 条 × 2`` | 首段 | ✅ MARKED |
| `AUDIT-IMPL31.md` | ``基线：`main` @ `55e7d37`（v0.54.0…）`` | 首段 | ✅ MARKED |
| `AUDIT-IMPL32.md` | ``基线：`main` @ 上一轮之后（v0.54.0 + task-2 的布局/连续性改动）`` | 首段 | ⚠️ **无 commit**（"上一轮之后"不可定位） |
| `AUDIT-IMPL33.md` | ``基线：`main` @ `5ebee0a`（v0.56.0），`npm run check` = 408 × 2 全绿`` | 首段 | ✅ MARKED |
| `AUDIT-IMPL34.md` | ``基线：`main` @ `d9bde74`（v0.57.0）…`` | 首段 | ✅ MARKED |
| `AUDIT-IMPL35.md` | ``基线：`main` @ `13c1b73`（v0.58.0），`npm run check` = 412 × 2 时区全绿`` | 首段 | ✅ MARKED |
| `AUDIT-IMPL36.md` | ``基线：`main` @ `aaf5ff2`（v0.59.1，六行已装载）`` | 首段 | ✅ MARKED |
| `AUDIT-IMPL37.md` | ``基线：`main` @ `9dd132d`（v0.61.0）…`` | 首段 | ✅ MARKED |
| `AUDIT-IMPL38.md` | ``基线：`main` @ `d6f4cb5`（v0.62.0）…`` | 首段 | ✅ MARKED |
| `AUDIT-IMPL39.md` | ``基线：`main` @ `507c802`（v0.64.1）…`` | 首段 | ✅ MARKED |
| `AUDIT-IMPL40.md` | ``基线：`main` @ `e365440`（v0.65.0）…`` | 首段 | ✅ MARKED |
| `AUDIT-IMPL41.md` | ``基线：`main` @ `24936cd`（v0.66.0）`` | 首段 | ✅ MARKED |
| `AUDIT-IMPL42.md` | ``基线：`main` @ `24936cd`（v0.66.0）`` | 首段 | ✅ MARKED |
| `AUDIT-IMPL43.md` | ``基线：`main` @ `f4dd719`（v0.70.0）`` | 首段 | ✅ MARKED |
| `AUDIT-IMPL44.md` | （无基线行；末段有 ``build（v0.70.0）``） | — | ⚠️ 有版本，**无 commit** |
| `AUDIT-IMPL45.md` | ``基线：`main` @ `e692f7c`（v0.71.0，`npm run check` 494/时区全绿）`` | 首段 | ✅ MARKED |
| `AUDIT-IMPL46.md` | ``基线：`f4c1402`（v0.72.0）树内修复，**未 commit / 未 push**`` | 首段 | ✅ MARKED（且如实声明未提交） |
| `AUDIT-IMPL47.md` | `- 基线文档：\`AUDIT-IMPL45.md\`（v1 实现）、\`AUDIT-IMPL46.md\`（HY4 复核缺陷修复）。本文只记 v2 口径变更。` | 首段 | ⚠️ **只给"基线文档"，不给自己的版本/commit** |

**汇总**（29 份）：**18 份**同时标了版本 + commit（MARKED：`CACHE-1`、`CACHE-2`、`HY4-1`、`IMPL30/31/33/34/35/36/37/38/39/40/41/42/43/45/46`）；**2 份完全 UNMARKED**（`AUDIT-IMPL27.md`、`AUDIT-IMPL28.md` —— 无版本、无 commit、无基线条数）；**9 份**有版本但无 commit，或只有测试条数/无法定位（`IMPL22/23/24/25/26/29/32/44/47`）。

- **建议动作**：给 2 份 UNMARKED 补抬头（按 `AUDIT-IMPL30.md` 的格式：「基线：`main` @ `<sha>`（vX.Y.Z），`npm run check` = N × 2 时区全绿」）；给 `AUDIT-IMPL32.md` 的「上一轮之后」换成实际 SHA；给 `AUDIT-IMPL47.md` 补自己的版本/commit。**不改历史结论。**

### 5.2 取代 / 重复

**显式声明取代或纠正的**（逐字）：

| 报告 | 位置 | 原文 | 被取代/纠正对象 |
| --- | --- | --- | --- |
| `AUDIT-HY4-1.md` | 首段 | `# AUDIT-HY4-1 —— 对抗式复核：v0.72.0「全球资金流蛋糕模型」数据层与详情页` | 推翻 `AUDIT-IMPL45.md` 的部分结论（`CHANGELOG.md:59` 写「推翻 v0.72.0 的部分结论」） |
| `AUDIT-IMPL46.md` | 首段 | `- 触发：跨…`（标题：`AUDIT-IMPL46 —— 复核缺陷修复：0 顶替 / 行级原因 / 实测日红线加锁 / 免责与可见性 / 缓存与 provenance`） | 修 `AUDIT-HY4-1.md` 的发现 |
| `AUDIT-IMPL47.md` | 首段 | `- 触发：用户改口径 —— 五市场由「美股/欧股/日股/A股/新兴市场」（v1）改为「**A股、港股、美国、日本、韩国**」（与 \`REQ-tools-component.md\` 的 T-5 一致）。` | 口径取代 `AUDIT-IMPL45.md` 的五市场 |
| `AUDIT-IMPL41.md` | 首段 | `本报告是**唯一…`（节选） | 收口 `AUDIT-CACHE-1.md` / `AUDIT-CACHE-2.md` 的取数层发现 |
| `AUDIT-IMPL42.md` | 首段 | `本报告是**唯一…`（节选） | 持久化那一半 |
| `AUDIT-IMPL35.md` | 标题 | `# AUDIT-IMPL35 —— 重做组件分离：恢复六行 manifest（含**纠正**上一轮的历史归因）` | 纠正 v0.50.0 的错误归因（见 5.3） |

**同主题冗余簇**（读者不知该信哪一份）：

| 簇 | 成员 | 最新应保留者 |
| --- | --- | --- |
| 工具箱①五市场蛋糕（4 份连更） | `AUDIT-IMPL43`（骨架）→ `AUDIT-IMPL45`（真数据 v1 口径）→ `AUDIT-HY4-1`（复核）→ `AUDIT-IMPL46`（修复）→ `AUDIT-IMPL47`（v2 口径） | **`AUDIT-IMPL47.md`**（v2 口径的现行实现）；43/45/46 应标注"历史口径 v1，已被 IMPL47 取代" |
| 筹码分布（8 份） | `AUDIT-IMPL25/26/27/28/30/31/33/34` + `DESIGN-CHIPS` | 结论已进 `CHANGELOG.md` v0.47–v0.58 与 `DESIGN-CHIPS.md`；报告本身是一次性过程记录 ⇒ **可整体移入 `docs/archive/`** |
| 取数层缓存（4 份） | `AUDIT-CACHE-1` / `AUDIT-CACHE-2` / `AUDIT-IMPL41` / `AUDIT-IMPL42` | `AUDIT-IMPL41` + `AUDIT-IMPL42`（实现收口）；CACHE-1/2 是审计输入，保留但应标"已由 IMPL41/42 全修" |
| 组件行（4 份） | `AUDIT-IMPL35` / `IMPL36` / `IMPL37` / `IMPL43` | **`AUDIT-IMPL43.md`**（第 7 行）+ `IMPL37`（`/board` 归属）；35/36 的**行数**部分已过期（见 5.3） |

### 5.3 已成为误导的报告

| # | 报告 | 逐字原文 | 位置 | 现行事实 | 严重度 |
| --- | --- | --- | --- | --- | --- |
| **M1** | `docs/AUDIT-IMPL35.md` | 标题：`# AUDIT-IMPL35 —— 重做组件分离：恢复六行 manifest（含**纠正**上一轮的历史归因）` | `:1` | 现行是**七行**（`src/index.ts:29`；`src/index.test.ts:42`）。该报告被 **README:347、`cordis.patch.yml:28/43`、`docs/DESIGN-SUBPLUGINS.md:4/119/124/162`、`CHANGELOG.md:712/719/721`** 共 **10** 处非 AUDIT 文档引用（另有 2 份 `docs/AUDIT-*.md` 互相引用），其中 `cordis.patch.yml:43` 把它当作**回滚步骤的唯一出处**（「回退成单行（用户端若再次异常）：见 docs/AUDIT-IMPL35.md 的「回滚」一节（一条命令）」），DESIGN-SUBPLUGINS:4/162 把它当作**路由账本的出处**（账本已错，见 §1.4） | **高**（load-bearing 且数字错） |
| **M2** | `docs/AUDIT-IMPL36.md` | 标题：`# AUDIT-IMPL36 —— 六行标题可区分（子路径名 + 逐行 locale 元数据）` | `:1` | 现行七行、六条子路径（`cordis.patch.yml:51` 已写「其余六行」）。被 `src/index.test.ts:386` 引用 | 中 |
| **M3** | `docs/AUDIT-IMPL37.md` | 标题：`# AUDIT-IMPL37 —— 云图只留第三方站点（删自绘 + 段控）＋ \`/board\` 归属改到 market 行` | `:1` | 报告**本身正确**（与代码一致）；**误导在 README 没跟着改** —— README:77/79 仍写"默认自绘"，与这份报告直接冲突 | 高（冲突方是 README） |
| **M4** | `docs/AUDIT-IMPL45.md` | 标题：`# AUDIT-IMPL45 —— 工具箱工具①「五市场蛋糕」：宿主取数 + 每日快照 + 详情页接真数据（实现报告）` | `:1` | 五市场成分已由 `AUDIT-IMPL47.md` 改为 v2（`src/host/globalFlow.ts:77` `FLOW_SCOPE = 'v2:cn,hk,us,jp,kr'`）。报告里的 v1 读数（美股 89.17% 等）**不是当前口径** | 中（已在 `AUDIT-IMPL47.md:7` 声明，但 `AUDIT-IMPL45.md` 自身无抬头提示） |
| **M5** | `docs/AUDIT-IMPL44.md` | `- 门禁：\`npm run check\` **EXIT=0，494/494 × 2 时区 + selftest + build（v0.70.0）**` | 首段末 | 结论仍有效（`src/host/em.ts:230` 的 `RETIRED_INDEX_FALLBACK` 与 `src/host/selftest.ts:518-519` 断言都在），**但无 commit 标注**，被 `src/host/sina.ts:27`、`src/host/sinaIndex.test.ts:4` 引用 ⇒ 改 `int_*` 时无法定位"当时的基线" | 低（补 commit） |

**关于旧归因**（v0.50.0「同包多行 = composition error」）：现已**清理干净**，不再是误导 —— 三处都带了纠正说明：

- `cordis.patch.yml:26-34`：`# ⚠ **历史归因纠正（这一条要读，前一轮的结论是错的）** … **该归因不成立**`
- `docs/DESIGN-SUBPLUGINS.md:6`：`> ⚠ **归因纠正（重要）**：本文件此前写着"六行装载失败：同一 package 多个活跃 Loader 源 + 带客户端半区 ⇒ \`dsh-client-modules\` 判为 composition error"——**这个归因是错的**（2026-10 纠正）。`
- `CHANGELOG.md:731`（v0.59.0）：`我曾判定"同包多活跃 Loader 源 = composition error ⇒ 六行方案不可行"。**这个结论是错的**，依据是源码注释里的一句话，而非实测。`
- 我另行核对了该纠正的**外部依据**，全部成立：`…/@deepseek-ai/dsh-client-modules/lib/index.js:121-123`（模块注释 *"distinct active Loader **sources** for that package are a composition error"*）、`:791-792`（`sourceKey(loaderName, baseUrl) { return \`${baseUrl}\0${loaderName}\`; }`）、`:876`（throw 位置）、`:82-88`（`exactPackageSpecifier`）、`:746-747`（`return void 0`）。✅ **这一段是本次审计里证据最扎实的文档。**

### 5.4 仍被引用的报告（不能直接归档，否则断链）

`grep AUDIT-` 命中如下（`path:line → 被引报告`）：

**被 `src/**` 引用（改代码前必须先改引用）：**
`src/index.test.ts:386 → AUDIT-IMPL36.md`｜`src/host/sina.ts:27 → AUDIT-IMPL44.md`｜`src/host/sina.ts:205 → AUDIT-IMPL45.md`｜`src/host/sinaIndex.test.ts:4 → AUDIT-IMPL44.md`｜`src/host/rescue.ts:137, :954 → AUDIT-IMPL42.md`｜`src/host/rescuePersist.test.ts:7`、`src/host/rescuePersist.child.ts:5`、`src/host/lock.ts:10`、`src/host/lock.test.ts:2`、`src/host/lock.child.ts:2 → AUDIT-IMPL42.md`｜`src/host/klineLock.test.ts:11 → AUDIT-IMPL41.md`｜`src/host/globalFlow.ts:6 → AUDIT-IMPL45.md`、`:7, :96 → AUDIT-IMPL47.md`｜`src/host/globalFlow.test.ts:4, :16 → AUDIT-IMPL45.md`、`:115 → AUDIT-IMPL47.md`｜`src/host/em.ts:1873 → AUDIT-IMPL42.md`｜`src/client/toolText.ts:15`、`src/client/ToolsPage.tsx:8`、`src/client/toolRegistry.test.ts:4 → AUDIT-IMPL43.md`｜`src/client/QuoteDrawer.tsx:409`、`src/client/noticeBars.test.ts:8 → AUDIT-IMPL32.md`｜`src/client/engineIds.ts:10 → AUDIT-CACHE-2.md`

**被文档引用：**
`README.md:347 → AUDIT-IMPL35.md`｜`README.md:401 → AUDIT-COPY2.md`（在 `docs/archive/`）｜`docs/DESIGN-SUBPLUGINS.md:4, :119, :124, :162 → AUDIT-IMPL35.md`｜`cordis.patch.yml:43 → AUDIT-IMPL35.md`｜`docs/ROADMAP.md:226 → AUDIT-FUNCTION.md`、`:227 → AUDIT-UI.md`、`:228 → AUDIT-IMPL2.md`、`:229/:233 → AUDIT-VERIFY.md`（都在 `docs/archive/`）｜`docs/DECISIONS.md:38, :325 → AUDIT-COPY2.md`、`:434 → AUDIT-COPY.md`｜`docs/DESIGN-DASHBOARD.md:6 → AUDIT-UI.md`

- **建议动作**：`docs/` 下 29 份**不要整批归档** —— 有 **9 份被 `src/**` 引用**（共 **25** 处引用点：`CACHE-2`、`IMPL32/36/41/42/43/44/45/47`），另有大量报告被 `docs/*.md` 互相引用（`AUDIT-IMPL35.md` 被引 22 次、`AUDIT-IMPL45.md` 18 次）。可归档的是"零代码引用"的那批（如筹码簇 `IMPL25/26/27/28/30/31/33/34`、`IMPL23/24/29`）。归档前先看 5.4 的清单。

---

## 六、权威性混乱

同一事实有多个"权威出处"的位置（**应保留哪一处**已给出）：

| 主题 | 出处们 | 现状 | **应保留** | 建议 |
| --- | --- | --- | --- | --- |
| **组件行清单（数量 / id / name / 开关）** | ① `cordis.patch.yml:53-75` ② `README.md:344-357` ③ `docs/DESIGN-SUBPLUGINS.md:3-9, 52-66, 113, 162` ④ `CHANGELOG.md`（v0.59.0/v0.60.0/v0.71.0 各写一遍） ⑤ `src/index.ts:29-79`（`RowId`/`ROW_ROUTES`/`ROW_TOOLS`） | **四份文档 + 一份代码各写一遍，且四份文档都错（六行）**。README:346 自称「唯一权威处是本包的 `cordis.patch.yml`」，DESIGN-SUBPLUGINS:3 自称「状态：已落地…是六行」，CHANGELOG:727 自称「恢复组件分离：六行 manifest」 | **`cordis.patch.yml` 的 `- insert:` 块**（README 已经这么宣布了，是对的——**只需让其余文档真的让位**） | README 保留：3 行摘要 + 指向 `cordis.patch.yml` 的路径（**不给行号**）+ 指向 `docs/DESIGN-SUBPLUGINS.md` 的**判据**（§2.2）；DESIGN-SUBPLUGINS 删掉 §2 的重复行清单（§2.1 表保留为"归属判据的历史说明"）；CHANGELOG 的历史条目**不改**（它记录的是当版事实），但 v0.71.0 那条假声明要修 |
| **路由归属判据** | ① `docs/DESIGN-SUBPLUGINS.md` §2.2「被 ≥2 个行消费 ⇒ core；单一消费方 ⇒ 该行」 ② `src/index.ts:32-65` 的注释（逐条给调用方 `file:line`） ③ `src/index.test.ts:319-366` 的 `OWNER_BY_CALLERS` 断言 ④ `cordis.patch.yml:17-23` 的注释 | 内容一致 ✅，但**四处都在讲**，改一处必漏三处 | **`src/index.ts` 的 `ROW_ROUTES` 注释**（判据 + 调用方清单在同一处，`src/index.test.ts` 会 lock 行为） | DESIGN-SUBPLUGINS §2.2 保留判据**一句话** + 指向 `src/index.ts`；`cordis.patch.yml` 注释只留"行名→用途"，删掉路由清单（现已与 `src/index.ts` 不同步：它把 tools 写成"无独占路由"，见 §2.6） |
| **`ROW_ROUTES` / `ROW_TOOLS` 的两份拷贝** | ① `src/index.ts:32-79`（生产） ② `src/index.test.ts:319-334` 的 `ROW_ROUTES_FOR_TEST`/`ROW_TOOLS_FOR_TEST` | 代码注释已如实说明「与 src/index.ts 的 ROW_ROUTES/ROW_TOOLS 同步的测试副本（搬迁一行就要同步改这里 + patch 断言）」——**这是知情的重复**，不是疏漏 | 保持现状 | 无需动作（已标注）；若要更稳可改成从 `src/index.ts` 导入 |
| **口径规范（缺失/新鲜度/四态/成本）** | ① `README.md` §口径规范（`:199-340`） ② `CHANGELOG.md` 各版 ③ `docs/DECISIONS.md`（1698 行） ④ `docs/ROADMAP.md` ⑤ `docs/STE-REVIEW-*.md` | README:201 已声明「以下为**当前生效**的规则。每条改动的来龙去脉与实测依据见 `CHANGELOG.md`」；`DECISIONS.md:1` 有抬头 `# 历史记录，不适用 STE 规范。` | **`README.md` §口径规范**（已在 README 里声明，方向正确） | 保持；`DECISIONS.md` 的"历史记录"抬头**已经加了**（STE-REVIEW-DOCS.md:41 的建议已落实 ✅） |
| **`build.mjs` 片段清单** | ① `build.mjs:109-190`（真源） ② `docs/DESIGN-SUBPLUGINS.md:48/121/141`（写死 75） ③ `README.md:432`（**只指向清单，不写数字** ✅） | README 的做法正确 | **`build.mjs` 的 `REQUIRED_CLIENT_SNIPPETS`** | 改 DESIGN-SUBPLUGINS 三处引用（或删掉数字、只写"由 `build.mjs` 自报数量"） |
| **agent 工具索引** | ① `src/host/tools.ts` 的 `defs`（真源） ② `README.md:361-377` 的表格 ③ `src/host/toolIndex.test.ts`（断言锁死） | **有断言强制同步**，12 vs 12 一致 ✅ | `src/host/tools.ts` + `toolIndex.test.ts` | 无需动作 —— **这是本仓"文档与代码同步"做得最好的一处，可作为其它表的模板** |

**总评**：仓库已经确立了「README 的『口径规范』为准 + `cordis.patch.yml` 为行清单唯一权威处」的**正确原则**（README:201、README:346），问题**不在原则，在执行** —— 三处"宣布了权威却自己不复述"的地方（六行、75 项、失效行号）恰恰都是**复制粘贴了本该让位的内容**。

---

## 七、方法、覆盖与未确认

### 7.1 本轮实际核对的量

| 维度 | 数量 |
| --- | --- |
| 读取的文档 | `README.md`(470)、`CHANGELOG.md`(14–366 + 588–735 + 2343)、`docs/DESIGN-SUBPLUGINS.md`(184，全文)、`docs/DESIGN-CHIPS.md`(100，全文)、`docs/ROADMAP.md`(部分)、`docs/STE-REVIEW-DOCS.md`(77，全文)、`docs/DESIGN-DASHBOARD.md`/`DESIGN-STRIP-CONFIG.md`(抬头)、29 份 `docs/AUDIT-*.md` 的抬头 + 引用关系 |
| 交叉核对的代码/测试文件 | `src/index.ts`、`src/index.test.ts`、`src/host/routes.ts`、`src/host/tools.ts`、`src/host/rescue.ts`、`src/host/rescue-thresholds.ts`、`src/host/em.ts`、`src/host/anomaly.ts`、`src/host/calendar.ts`、`src/host/selftest.ts`、`src/host/globalFlow.ts`、`src/host/trendArchive.ts`、`src/host/writeLog.ts`、`src/host/time.ts`、`src/client/index.tsx`、`src/client/CloudMap.tsx`、`src/client/cloudMap.test.ts`、`src/client/chartCache.ts`、`src/client/toolCardView.ts`、`src/client/sort.test.ts`、`build.mjs`、`package.json`、`cordis.patch.yml` |
| 独立复算的数字 | 测试条数 **532**（71 文件）｜锁定片段 **73** 项｜组件行 **7**｜`/tradewatcher/*` 路径 **25** 条｜agent 工具 **12** 个｜校准值 `f1 = 1.19/1.57/1.92`｜预设标的 **28**、兜底 **≥18**、新浪专供 **≥8** |
| CHANGELOG 核对 | v0.67.0–v0.74.0 共 **68** 条断言（v0.67.0–v0.70.0 逐条 46 条：40 ✅ / 5 ⚠️部分 / 0 not-found；v0.71.0–v0.74.0 抽查 22 条 + 与事实不符 1 条 + dangling 引用 2 条 + 行数/版本号/计数不符 3 条，见 C1–C7） |
| 外部依据核对 | `@deepseek-ai/dsh-client-modules/lib/index.js` 的 `:82-88, :121-123, :170-180, :746-747, :791-792, :833-840, :858-869, :871-876`（**全部成立**） |

### 7.2 未确认（不编造；每条给确认方法）

1. **README:442「本机账本为 103 条流水 × 10 只持仓 = 1030 次遍历，`/portfolio` 响应 0.28s」**
   —— 这是"实测本机"读数，本机账本会变，且当时状态无法复现。**确认方法**：`python3 -c "import json;print(len(json.load(open('/home/hu/.dsh/dsh-tradewatcher/ledger.json'))['entries']))"` 数当前流水条数；再用 `curl -w '%{time_total}' 127.0.0.1:3080/tradewatcher/portfolio` 量当前响应。**未做**：`/portfolio` 会打上游，本轮不制造取数压力。

2. **README:232「实测一拍 12 次上游：东财 8 + 腾讯 1 + 新浪 3」**
   —— 需要包 `globalThis.fetch` 计数才能核。**确认方法**：按 `CHANGELOG.md:365-368` 记的「测量口径（可复算）」跑 `/tmp/impl41/run.sh`（脚本未在仓内，需重建）。**未确认**：本轮不跑计数脚本。

3. **`100.KOSPI200` 是否真的是错数（README:452 的待复核）**
   —— 我只证实了「README 写的 1088.15 ≠ 当前文件里的 1020.8」。**这个数是否正确仍未确认**（KOSPI200 的合理区间我没有独立信源）。**确认方法**：东财可达时用 `tradewatcher_quotes 100.KOSPI200` 与公开源对照（README 已给出这一步）。

4. **「8 组断言」（README:211）的定义**
   —— 实测 `sort.test.ts` 有 11 个 `test()`。"8 组"可能是另一种分组口径。**确认方法**：`git log -S '8 组断言' -- README.md` 找引入版本，再看当时的 `sort.test.ts`。

5. **`docs/DESIGN-STRIP-CONFIG.md` 引用的外部路径 `../arkvol-workbench/audit/EVALUATION.md`（在 `docs/PRODUCT-ARKVOL-TRIAGE.md:3`）**
   —— 该路径在本仓之外，未核。**确认方法**：`ls ../arkvol-workbench/audit/EVALUATION.md`（属另一个工作区，本轮不越界）。

6. **profile 层 `- id: tradewatcher-calendar` + `disabled: true` 是否真的能关掉那一行**
   —— `cordis.patch.yml:35-41`、`README.md:349-354`、`DESIGN-SUBPLUGINS.md:5` 都说"待装机验证"。**本轮按约束不重启、不动 profile，因此未实测**（`docs/DESIGN-SUBPLUGINS.md:183` 自己也把它列为"未在本机实测"）。**确认方法**：在 profile 层加一行 `disabled: true`、重启 `dsh web`、`curl /tradewatcher/rows` 看 `rows[]` 是否少了 `calendar`。

7. **`docs/DESIGN-CHIPS.md` 的大量 `path:NNN`**
   —— 抽查 11 处，**几乎全部漂移**（例：`src/client/chipsView.ts:123` 现为 ` * 不拿默认值硬画一条线出来。`；`src/client/ChipsPanel.tsx:8` 现为 ` *  - 容器与数字登记进 ...`；`src/client/QuoteDrawer.tsx:145` 现为 `useEffect(() => {`）。**但该文件 `:3` 已显式声明**「**本文件所有 `src/client/**` 行号可能在实现时漂移**，凡引用都同时给函数/类名与选择器」⇒ 属**已披露漂移**，不计为缺陷，只建议改行号为函数名（例如 `src/host/em.ts:208` 的 `QUOTE_FIELDS` 实际在 `:217`）。

8. **`src/client/index.tsx:343-349` 这个被引用 5 次的 tabs 位置**
   —— 实测 tabs 在 **`:380-388`**，`:343` 是 `prefs: prefs ?? DEFAULT_PREFS,`。**已确认失效**，见 §8.1。

### 7.3 本轮未改任何文件

`git status --porcelain` 在本审计开始时为空；结束时的唯一变更应为本文件 `docs/REVIEW-3-DOCS.md`。未执行 `npm run build`、未重启 `dsh web`、未装 bundle、未动 profile。外部只读了 `@deepseek-ai/dsh-client-modules` 的产物源码（只读）与本机 `~/.dsh/dsh-tradewatcher/quotes-lkg.json`（只读）。

---

## 八、附录：`path:line` 引用失效清单

### 8.1 `docs/DESIGN-SUBPLUGINS.md`（未披露漂移 ⇒ 需修）

§1.3 表格（`:42` 已声明"下表是 v0.44.0 迁移前的现场，行号亦为当时值"，**但 §5.1（`:128-132`）与 §6（`:139-145`）的行号出现在**活的风险/改动清单**里，读者会当现行值用**）：

| 引用 | 声称内容 | 实际该处内容 | 实际应指向 |
| --- | --- | --- | --- |
| `src/index.ts:17`（`:49, :128, :139`） | `apply(ctx, config)` | `import { CalendarStore } from './host/calendar.ts'` | **`:268`**（`export function apply(ctx: PluginContext, config?: unknown): void {`） |
| `src/index.ts:31`（`:128, :139`） | `store.init()` | `/** 行 → 该行独占的路由前缀…` | **`:161`** |
| `src/index.ts:41`（`:128, :139`） | `rescue.start()` | `//   /tradewatcher/breadth     涨跌家数…` | **`:171`** |
| `src/host/routes.ts:167`（`:49, :129`） | 22 条路由的注册处 | `}` | **`:263`**（`export function makeTradeRoutes(`）；条数已变 25 |
| `src/host/routes.ts:211`（`:49`） | `health` | ` */` | **`:312`** |
| `src/host/routes.ts:845`（`:49`） | `calendar` | `const map = secids.length > 0 ? await em.fetchIndustryOverview(secids) : {}` | **`:1081`** |
| `src/host/tools.ts:169`（`:49`） | `portfolio` 工具 | `if (filter.exclude !== undefined) …` | **`:180`**（`name: \`${PREFIX}portfolio\`,`） |
| `src/host/tools.ts:622`（`:49`） | `calendar` 工具 | `}` | **`:633`** |
| `src/host/tools.ts:1365`（`:130, :144`） | guidance 整段 | `portfolio: '持仓总览与盈亏，由流水核算、费用已计入',` | **`:1393`**（`function guidanceText(): string {`） |
| `src/client/index.tsx:89`（`:50`） | `inject=['slots']` | `/** Plugin identity for the client module table…` | **`:93`** |
| `src/client/index.tsx:114`（`:50, :132, :184`） | `main` 键槽注册 | `)` | **`:118`** |
| `src/client/index.tsx:185`（`:50`） | `PageKey` | `}` | **`:189`**（`type PageKey = 'watch' \| 'portfolio' \| …`） |
| `src/client/index.tsx:343-349`（`:50, :100, :132, :145`，共 **5** 处） | tabs 数组 | `prefs: prefs ?? DEFAULT_PREFS,` … | **`:380-388`** |
| `src/client/styles.ts:151`（`:142`） | 第二条 `data-blur` 清单 | `filter:blur(3.2px);transition:filter .12s}` | **`:152`**（`:138` 的第一条清单是**对的** ✅） |
| `src/shared/model.ts:672-688`（`:143`） | `DEFAULT_PREFS` | `:688` = `}`；`DEFAULT_PREFS` 实际起点 | **`:690`**（`export const DEFAULT_PREFS: PortPrefs = {`） |
| `package.json:10-16` / `:17-24`（`:47`） | exports / dsh 段 | — | 该表已声明是 v0.44.0 快照 ⇒ 不计缺陷 |
| `build.mjs:61-85` / `:192-210`（`:48, :141`） | 两产物 / 片段校验 | `:192` 起是 `const clientBundle = readFileSync('lib/client.js', 'utf8')` ✅；`build.mjs` 共 210 行 | **范围大致仍成立**（`:192-208` 更准） |

### 8.2 已核对的失效数量

- 明确失效的 `src/**` 行号引用：**13 个位置**（上表除 `package.json` 与 `build.mjs` 两行）。
- 集中在 **2 份文档**：`docs/DESIGN-SUBPLUGINS.md`（§1.3/§5.1/§6）与 `docs/DESIGN-CHIPS.md`（已披露，不计）。
- **`README.md` 内部几乎没有行号引用**（只用文件路径 + 函数名，如 `src/host/em.ts` 的 `QUOTE_FIELDS`、`src/client/sort.ts`），这是 README 相对设计文档**更耐久**的一个真实优点，建议在设计文档里照抄这个做法。

---

**审计人**：文档一致性审计员（只读轮）
**基线**：`main` @ `6f4382e`（v0.74.0）
**产物**：本文件（本次唯一写入）
