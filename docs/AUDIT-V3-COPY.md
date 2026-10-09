# 原则合规审计（v0.38.2）：界面文案 × 《开发原则》七条

只读审计，写作用域仅本文件。规则以 `README.md:346-356`（「开发」节七条）为唯一权威，逐字引用；行号按当前工作区 `e9d4cb5`（`git status` 干净）核对。审查对象：用户可见字符串 + 宿主回包 `note`/`why`/`caliber`（不含代码注释、不含 `selftest` 断言串）。

## 一、逐条规则合规表（含扫描方法与命中）

| 规则 | 合规 | 扫描方法 | 反例 |
| --- | --- | --- | --- |
| 1 常驻只留一行；长解释进 `title` **与** `aria-label` | 基本合规 | 列出所有 `tw-hint` 常驻块，逐块量正文长度、查是否同时有 title+aria | **M1**（长原因落可见正文且无 title）、**M2**（恒真行为句常驻）、**M5**（aria 挂无 role 元素＝读屏读不到） |
| 2 同一事实全局只留一处 | 可见层面合规 | 脚本取全部 ≥12 字中文字面量，归一化（去 `${}`/数字/标点）后按完全相同分组，再按 ≥10 字中文片段做跨文件频次统计 | 11 组命中里 8 组是 `title`+`aria` 成对或**未渲染**的宿主诊断串；真问题只有 **S4**（面板级 vs 行级同因）+ **S7**（同文两处实现） |
| 3 恒真/恒假不渲染；空值不占位 | 合规（1 例） | 搜 `会自动展开/即可/不受影响/默认` 等行为句；核对 `fmtPrice/fmtPct/fmtAmt` 空值出口与 `—` 用法 | **M2** 一处恒真句；未发现 0 顶替（`MarketPage.tsx:187-188` 用 `—`、`breadthView.ts` `upDownPair` 成对判定 ✓） |
| 4 用词表统一 | **不合规** | 脚本抽出 1500 条可见中文字面量，按黑名单（未返回/无数据/拿不到/没取到/取不到/同步于/观测时刻/统计于/判定于）匹配 | **S1**：状态词 15 处 + 时间词 5 处越表（清单见下） |
| 5 结构性限制不进红色告警 | 基本合规 | `grep` 全部 `var(--tw-up)` / `tw-err` / `#e5484d` 文案色站点，逐站判定"故障 vs 结构性/常态" | **M1**：红正文里含"备用源不含涨跌家数字段"（结构性）。正例 3 处见 K2 |
| 6 口径标签只写通用词 | 合规（2 例） | 逐个 `pps(...)`/`statCell(...)`/tip 行的 label，查括号与口径词 | **S2**（`可用（可卖）`）、**S3**（`不适用分时段网格`）。细节卡片=正例（K5） |
| 7 blur 登记 + 不写死红绿 | **不合规** | ①从 `styles.ts` 抽所有含 `var(--tw-mono)` 的选择器，与两条 `data-blur=1` 清单求差；②全仓搜 `#e5484d/#ff5f6d/#0e8f5c/#27a644/rgba(229,72,77` 与内联 redUp 三元 | **M3**（写死红 2 处）、**M4**（1 个数字面漏登记）、**S5**（10 处内联三元）、**S6**（2 处硬编码色板） |

**规则5 逐站判定**（`var(--tw-up)`/`tw-err` 文案色；绘制类不计入，下列为全部分组）：故障 14 处（`IndustryHeatmap.tsx:68`、`MarketPage.tsx:200,207,211`、`PortfolioPage.tsx:333`、`WatchlistPage.tsx:234,238,247,262`、`CloudMap.tsx` 超时/`index.tsx:373` 行情接口、`QuoteDrawer.tsx` 限流红条、`styles.ts:76,286,301` 表单与错误框）→ 红正确；**结构性 1 处**（M1 的正文）；非故障语义 6 处（`WatchlistPage.tsx:188,379` 异动、`PortfolioPage.tsx:985` 除权待办、`PortfolioPage.tsx:369` 流水未应用待办、`RescuePanel.tsx:201` 净流出、`styles.ts:260` 危险菜单）→ 见 K8。绘制类（`kline.tsx`/`charts.tsx`/`TopBar.tsx:74`）不属于"文案色"，只受规则7 约束。

## 二、必修

| # | 文件:行 | 现文案 | 触发 | 处置（依据） |
| --- | --- | --- | --- | --- |
| M1 | `MarketPage.tsx:198-204`（原因来自 `:144`、`breadthView.ts:63`、`host/routes.ts:352`） | 正文 `涨跌家数本次未取到：<countsReason>`，字数随原因可达 40–60 字，且**没有 title**；原因里含 `备用源不含涨跌家数字段` | 家数两条链都失败 | 正文压成 `涨跌家数未取到`（8 字），原因与结构性说明进 `title`/`aria`；红条保留（K1）[规则1][规则5] 成本 S |
| M2 | `RescuePanel.tsx:524` | `（信号达到「疑似护盘」时本面板会自动展开）` | 收起态＝**默认态**，level<2 时恒真 | 删（如需告知放 `title`）[规则3][规则1] −24 字常驻 |
| M3 | `styles.ts:97`、`:100` | `@keyframes tw-breathe{…50%{background:rgba(229,72,77,.10)}}`；`@media(prefers-reduced-motion){…background:rgba(229,72,77,.08)}` | 任一行异动 | 改 `color-mix(in srgb, var(--tw-up) 10%, transparent)`：同一条边现在**两种红**（竖条 `var(--tw-up)`、呼吸底硬编码浅色红）[规则7] 成本 S |
| M4 | `styles.ts:239-241`（`.tw-pos-title small`，渲染于 `PortfolioPage.tsx:973`） | 行内 `代码 · 涨跌幅` 走 `--tw-mono`，但两条 `data-blur=1` 清单（`styles.ts:129-147`）未收录 | 隐身档＋数字模糊 | 加进两条清单；并把 `.tw-cal-day`/`.tw-code` 写进"非行情数字，豁免"注释——否则每次审计都会命中这两条[规则7] 成本 S |
| M5 | `kline.tsx:52-57` | `title: l.hint` + `aria-label: \`${l.label} ${l.value} —— ${l.hint}\``，但该 `div` **没有 `role`** | 任何光标细节卡 | 加 `role="note"`：无 role 的 `aria-label` 不被朗读，规则1"读屏要读得到"当前未成立[规则1] 成本 S |

## 三、应修

| # | 文件:行 | 现文案 | 触发 | 处置（依据） |
| --- | --- | --- | --- | --- |
| S1 | 状态词：`RescuePanel.tsx:511`（未返回）、`ytdView.ts:27`、`quoteState.ts:23`、`host/portfolio.ts:351`、`host/tools.ts:572`；`QuoteDrawer.tsx:100,215`（暂无数据）、`:141`（拿不到）；`PortfolioPage.tsx:336`、`WatchlistPage.tsx:235,255`、`host/ytd.ts:140,141`、`host/anomaly.ts:135`、`host/tools.ts:1033`（取不到）；`host/em.ts:1709,1733`、`host/breadthCount.ts:415`（没取到）／时间词：`CalendarPage.tsx:193`（同步于）、`RescuePanel.tsx:418,473`（最近一次成功采样） | 例：`该周期暂无数据（停牌/新股/接口限流）`、`日线本次取不到…` | 缺数据时 | 状态词统一 `未取到`；时间前缀统一 `数据时刻`。**并请在词表补一行**："窄容器（侧栏徽标 `badgeView.ts:38`）允许用简称 `数据 <HH:mm:ss>`"——否则规则与实现在此永久冲突[规则4] 成本 M |
| S2 | `PortfolioPage.tsx:1076`、`:1064` | `可用（可卖）`、`累计已实现（已计入上栏）` | 恒常 | 前者括号是同义词 → 改 `可用`；后者是会计口径 → 移到 `title`（正文只留 `累计已实现`）[规则6] 成本 S |
| S3 | `QuoteDrawer.tsx:368` | ` · 该标的不适用分时段网格` | `sessionOf(secid)===null`（美股/国际指数/商品/期货） | 改 ` · 无固定交易时段`（双否定＋jargon）；口径长解释已在 `title`[规则4][规则6] 成本 S |
| S4 | `WatchlistPage.tsx:247` vs `:403,406`；`PortfolioPage.tsx:333,336` vs `:ytdView` 行级 tooltip | 面板级 `板块涨跌与 α 本次未取到 · <时刻> · <err>` 与行级同因 | 接口故障 | 行级 tooltip 只留 `未取到`（原因由面板级一处承担）[规则2] 成本 S |
| S5 | `kline.tsx:301,331,349,538,608,609,616,617,632,711`（10 处） | 内联 `redUp ? 'var(--tw-up)' : 'var(--tw-down)'` | 画图 | 抽 `upDownColors(redUp)`（或 `toneClass`）：现虽都带 redUp（合规字面），但第 11 处极易漏——v0.38.0 修的正是漏 redUp[规则7] 成本 S |
| S6 | `index.tsx:183-188`、`quoteState.ts:35-38` | `BADGE_TONE_COLOR` / `QUOTE_STATE_COLOR` 硬编码 `#ff5f6d`/`#27a644`（= **深色**主题值），浅色主题下与面板内的 `--tw-up`/`--tw-down` 不是一个色 | 侧栏徽标 / 四态色点 | 改为读 CSS 变量（`getComputedStyle` 或 token 类名），或集中一处并注明主题差异[规则7] 成本 S |
| S7 | `RescuePanel.tsx:299/348`、`PortfolioPage.tsx:349/352`、`:372/375`、`:1098` vs `WatchlistPage.tsx:593`、`PortfolioPage.tsx:1107` vs `WatchlistPage.tsx:603`、`host/breadthCount.ts:222/313`、`:233/250`、`:272/275` | 同一句在两个分支/两个文件各写一遍 | — | 抽常量/共享函数。**可见层面不违规**（不同分支互斥、同页只出一个），属实现层的"同一事实两处"[规则2] 成本 S |

## 四、明确保留（删过头＝新的信息错误）

| # | 文件:行 | 文案 | 理由 |
| --- | --- | --- | --- |
| K1 | `MarketPage.tsx:198-204`（红条本体） | `涨跌家数…` 红色告警 | 全局失败必须有一处可见：删掉后 20+ 行的家数同时变 `—`，用户无法判断是接口挂了还是本来没有。**只压缩正文（M1），不要删条** |
| K2 | `QuoteDrawer.tsx:147-152` | `⚠ 详情不可用 · 上游限流…`（红）vs `详情不可用 · 该标的无详情字段（重试无用）`（中性） | 规则5 的正例：故障才红、结构性走中性，两分支都在，勿合并 |
| K3 | `RescuePanel.tsx:522-525` 中 `RESCUE_LEVEL_DESC[level]` 本体 | `宽基 ETF 量能与资金流均在常态区间` 等 | 等级语义是数据本身；M2 只删括号行为句 |
| K4 | `badgeView.ts:34-38` | 悬停一行 + `BADGE_DETAIL_MAX=32` | 规则1 正例（v0.38.2 刚砍过）；正文里"影响什么+数据时刻"齐备 |
| K5 | `chartCursor.ts:96-104`（`PCT_HINTS`）+ `kline.tsx:52-57` | 可见只有 `涨跌幅` + 数字；口径（`相对当日开盘价/序列首点`）只在 hint | **规则6 正例**：不是"三处各写一遍"——可见=通用词+值，aria=可见文本+hint 的拼接 |
| K6 | `breadthView.ts:82`（`UPDOWN_MISSING_NOTE`） | `…这里不显示 0 —— 0 会被读成"没有一只下跌"` | "0 的语义"全局唯一一处（在 title/aria 内），删了会让 `—` 失去解释 |
| K7 | `shared/model.ts:950-960` | `MISSING_TIER_ADVICE{transient:'稍后自动重试'}` / `MISSING_TIER_LABEL{transient:'本次失败','no-source':'上游无此数据'}` | 上轮 E3 已落地、且与规则4 词表一致，**不要回退**成"上游暂时不可达，稍后自动重试" |
| K8 | 非故障语义的红色站点：`WatchlistPage.tsx:379`（异动）、`PortfolioPage.tsx:985`（除权待办）、`RescuePanel.tsx:201`（超大单净流出）、`styles.ts:260`（危险菜单） | 红＝市场信号/待办/危险 | 规则5 只规范"结构性 vs 故障"，这四类不在射程内。若要严格分离，应新增 `--tw-danger` / `--tw-warn` 变量，**不要**把它们改成中性——那会让"撤资"和"没事"长得一样 |

## 五、最近 5 版新增面速判

| 新增面 | 结论 |
| --- | --- |
| 时段网格口径行（`QuoteDrawer.tsx:368`，随 `sessionOf` 分档） | 合规（中性口径行，未染红）；仅用词 S3 |
| 细节卡片行标签 + `title`/`aria`（`kline.tsx:52-57`、`chartCursor.ts:212-222`） | **未过度**：可见只有 label+value，口径在 hint；仅 M5 的 `role` 缺口 |
| 侧栏徽标悬停（`badgeView.ts:41-69`） | 合规；仅 `数据` vs 词表 `数据时刻` 的窄容器例外（S1 末句） |
| 家数自统计说明与 `caliber`（`MarketPage.tsx:198-204`、`:237-238`） | `caliber` 只在 title/aria ✓（`:141` 已用词表词 `数据时刻`）；正文见 M1；缺失分档（`transient`/`no-source`）用词表 ✓ |
| 护盘收起态（`RescuePanel.tsx:522-525`） | M2 一处恒真句，其余为等级语义（保留） |
| 抽屉失败文案（`QuoteDrawer.tsx:135-152`） | 合规（K2）：单行 + `⚠`+重试、结构性走中性 |
