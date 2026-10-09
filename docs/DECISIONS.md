# 决策与历史过程（自源码注释迁入）

## 决策：不冗余解释、不啰嗦（2026-10-09，v0.37.0）

**规则出处**：`docs/AUDIT-COPY2.md` 的用词表 + v0.34–v0.37 的执行经验；可执行清单写在 `README.md` 的「开发原则」一节。

**背景（都是实测踩过的）**：
- 同一个缺口被写了三遍（正文一行 + 面板 hint + 行 tooltip）⇒ 界面变吵、三处措辞还不一致；
- 复权口径、边界条件塞进正文 ⇒ 行被拉长，读者反而读不到重点；
- 结构性限制（"该市场无多日源""该标的不适用分时段网格"）被染成红色告警 ⇒ 红色失去"这是故障"的含义；
- 口径标签写成 `涨跌(距开盘)`/`涨跌(距首点)`/`涨跌(距当日开盘)` ⇒ 可见文本里堆解释，且用户明确要求可见标签一律 `涨跌幅`。

**决定**：见 README 那七条。两条最关键的执行面：
1. **可见一行 + 长解释进 `title`/`aria-label`**（读屏必须读得到）；
2. **口径标签用通用词，具体口径进 `title`/`aria`**（`涨跌幅` + "相对当日开盘价 / 相对序列首点 / 同日开盘"）。


> 从源码里搬出来的**过程叙述**（版本/批次/实测经过）。结论与红线仍在源码注释里；
> 这里保留原文以便追溯，写作用域为只读参考。


## src/client/CloudMap.tsx

```
/**
 * 大盘云图: embeds the third-party free A-share heat-map page.
 *
 * 三态降级（P0-10）：**加载中 / 已加载 / 超时**。
 * 此前只有一个 `loaded` 布尔，于是"白了就是白了"——分不清是没网、站点挂了，
 * 还是自己还在加载。现在：
 *   - 懒加载：进入本页才开始计时（面板本身只在被选中时挂载）；
 *   - 8s 超时：超时显示占位（域名 + 最后成功时间），而不是留一块空白 iframe；
 *   - 超时态给一次「重试」，重试会重建 iframe（换 key）并重新计时；
 *   - 最后成功时间记在 localStorage，跨会话可见（"上次是几点还能用的"）。
 *
 * 本仓库只做展示与降级说明，**不抓取**该站内容（见 README「明确不做」）。
 */
```


## src/client/IndustryHeatmap.tsx

```
/**
 * 自绘行业热力图（P2-5）。
 *
 * 为什么自绘：第三方 iframe（云图页）**标不了口径** —— 面积是按流通市值还是成交额、
 * 颜色是涨跌幅还是资金流、数据是几点的，全都在别人的页面里。自绘这一版把口径写在图上方：
 * 面积 = 成交额、色深 = 涨跌幅、数据时刻与来源随图一起给出。
 *
 * 与 iframe 并存（云图页可切换），默认自绘。
 *
 * 布局用 squarified treemap：把矩形按面积切成近似正方形的块（长条状的块既难看也难比较）。
 * 布局是**纯函数**（`squarify`），因此可以直接断言"面积成比例、不越界、不重叠"。
 */
```


## src/client/RescuePanel.tsx

```
/**
 * 【护盘信号】面板：国家队潜在护盘行为的概率性监测。
 *
 * 设计要点：
 *  - 常驻状态条（等级/评分/归因/采样节奏），信号 ≥ 疑似时面板自动展开
 *  - 六因子明细表把「实测值 / 阈值 / 来源」全部摆出来，便于自查，不做黑箱
 *  - 分时量能图：分钟成交额柱 + 同时点基准线（用标定的日内进度曲线算），超出 2× 的柱子高亮
 *  - 信号时间线 + 近 60 日历史回看（自采样器上线日起）
 */
```


## src/client/SortBar.tsx

```
/**
 * 排序段控（自选 / 持仓共用）。
 *
 * 交互约定：点未选中的键 → 切到该键的默认方向（降序）；点已选中的键 → 翻转方向。
 * 方向标记直接画在按钮上（↓/↑），不留"当前到底是升序还是降序"的悬念。
 * 「默认」是自定义顺序，方向对它没有意义，因此不显示箭头。
 *
 * 宽屏（≥1080px）改用列头排序（SortHeader.tsx）。两者的互斥**由调用方决定挂哪一个**
 * （`useWideLayout()`，见 client/useWide.ts）：宽屏不挂段控、窄屏不挂列头。
 *
 * 为什么不靠 CSS 隐藏：v0.30.0 曾把两个控件都渲染、用 `[data-wide-hide=1]` 藏掉其中一个，
 * 实测出现过两者同时可见（选择器链任一环失配就漏）。**"藏起来"不是互斥**。
 * 两者读写同一份 `watchSort`/`portSort`，列头里另有「↺ 默认顺序」，因此收起段控不丢操作。
 *
 * 注意：**不再保留 CSS 兜底**（v0.30.1 删掉了 `wideHidden`/`data-wide-hide`）——
 * 一个"从来没拦住过"的兜底只会让人以为有两层防线，而真正的防线是"不挂"。
 * 想恢复宽屏段控就改 `useWideLayout` 的消费处，别再加一层隐藏规则。
 */
```


## src/client/SortHeader.tsx

```
/**
 * 列头排序（宽屏表格视图）。
 *
 * 与 `SortBar.tsx` 的分工：分段开关在窄侧栏里更省地方（保留、继续用），
 * 宽屏列表铺成多列后，"点列头排序"比"先找排序键再点"更贴表格直觉 —— 两者读写**同一份**
 * `watchSort` / `portSort` 偏好，因此不存在"两个控件各说一套"的可能。
 *
 * 三条硬约定（与 sort.ts 一致）：
 *  1. 只有**有数值来源**的列才可点（`column.key === null` 的列只是标签）——
 *     排错比不排更糟，界面上看不出来的假排序会让人不再信任这个表；
 *  2. 当前列显示 ▲/▼，并在 `columnheader` 上给 `aria-sort`（读屏软件据此播报方向）；
 *  3. 键盘可用：真正的 `<button>`，Enter/Space 天然触发，不留"只能鼠标点"的列头。
 */
```


## src/client/alertRules.test.ts

```
 * 提醒策略（静默窗口）的断言。
 *
 * 最容易写错的一点：静默**只压制提醒**，不能把"它正在异动"这个事实也抹掉 ——
 * 否则用户会看到"明明在放量，徽标却是 0"，然后不再相信这个徽标。
 * 另一半风险是把"没判定"混进"正常"，见 judgeAlerts 的 calm/skipped 分家。
```


## src/client/alertRules.ts

```
 * 自选异动的**纯策略层**（P1-4）：静默窗口判定。
 *
 * 与 `alerts.ts` 分开的理由和 quoteState/useNow 一样：这一层是可断言的逻辑
 * （谁该提醒、谁被压制、哪些根本没判定），而那边要引 React。混在一起会让纯逻辑
 * 的测试必须装 React。
 *
 * 宿主给的是"这一条现在算不算异动"（事实），这里管的是"要不要提醒"（策略）。
 * **静默只压制提醒，不压制事实**：被压制的条目仍会出现在界面上（标注"静默中"）。
```


## src/client/alerts.ts

```
/**
 * 自选异动的客户端侧：取数 + 静默记录 + 轮询（P1-4）。
 *
 * 判定策略（谁该提醒、谁被压制）在 `alertRules.ts`（纯函数、可单测）。
 * 这里只做三件事：按行情刷新拉一次判定、维护 localStorage 里的静默记录、把结果交给界面。
 * 静默状态记在 localStorage：刷新页面后不该把刚看过的异动再"提醒"一遍。
 */
```


## src/client/breadthView.test.ts

```
 * 大盘宽度显示口径的断言（`node --test` 直跑，不打网络）。
 *
 * 这组断言的重点只有一个，但它必须被锁死：**缺失不许编码成 0**。
 * `up=null` 时若返回 0，界面就会显示"上涨 0"或"下跌 0"，而这两句话
 * 在 A 股语境里都是确定的错信息（"全市场没有一只上涨"/"没有一只下跌"）。
```


## src/client/breadthView.ts

```
 * 大盘宽度（涨跌家数）的显示口径（纯函数，无 react，可被 `node --test` 直接跑）。
 *
 * 为什么单独抽出来：`/quotes` 里的涨/跌/平家数（东财 f104/f105/f106）**只有东财源提供**，
 * 备用源（腾讯/新浪）没有这三个字段。此前页面直接 `(sh?.up ?? 0) + (sz?.up ?? 0)` 求和，后果有两个：
 *
 *  1. 只有沪市返回时「上涨 / 下跌」静默减半，`上涨占比` 跟着错 —— 看起来像"市场宽度收敛"；
 *  2. `up` 有值而 `down` 缺失时显示 `1234 / 0`，会被读作**"没有一只下跌"**。
 *
 * 约定（与 README「缺失不许用 0 代替」一致）：**任一分量缺失 ⇒ 整格 `—` + 原因**，
 * 绝不把缺失编码成 0；而真正的 0（当天真的没有一只上涨/下跌）仍然照常显示 0。
```


## src/client/chartCache.test.ts

```
/**
 * 图表客户端缓存的回归测试。
 *
 * 存在的理由：用户反馈"每次都拉取全量历史数据"。宿主侧已有落盘缓存与增量拉取，
 * 但客户端此前每开一次抽屉/每划过一次卡片就发一次 HTTP。这组断言把三件事锁住：
 *   1) 命中缓存 = 零请求（这是"优化拉取逻辑"的可验证定义）；
 *   2) 同键并发只发一个请求（悬浮卡与抽屉同时要同一份数据）；
 *   3) 失败不把图变空 —— 保留上次成功值并标 fallback，让界面如实说明。
 */
```


## src/client/chartCache.ts

```
/**
 * 图表面板的客户端缓存（分时 / 五日 / 日K / 周K / 月K / 年K）。
 *
 * 为什么需要：抽屉与顶栏悬浮卡会反复请求同一个 secid+tab —— 来回切周期、鼠标
 * 反复划过同一张卡、关掉再打开。宿主侧已经有两级缓存（内存 TTL + K 线落盘增量），
 * 但客户端此前每次交互都发一次 HTTP。本模块把**已解析的 payload**记在浏览器侧，
 * 命中即零请求。
 *
 * 三条约定：
 *  1) 同键并发合并 —— 悬浮卡与抽屉同时要同一份数据时只发一个请求；
 *  2) 绝不因为一次失败把图变空 —— 失败时保留上一份成功值（短 TTL，稍后重试），
 *     并把它标成 fallback，界面如实说明「显示上次成功数据」；
 *  3) 宿主若回 `cached: true`（休市定稿，宿主根本没回源），客户端给更长的 TTL，
 *     收盘后反复开关面板不会产生任何请求。
 *  4) 复权口径进缓存键 —— 前复权与不复权是两套价格序列，互相顶替会在图上
 *     造成无解释的跳空；分时/五日不含复权序列，仍共用同一个键。
 */
```


## src/client/chartNote.test.ts

```
 * 图表脚注用词的断言（`docs/AUDIT-COPY2.md` 的 E1 + 。
 *
 * 为什么值得单独立断言：这条脚注是"这份数据到底是不是今天的"的唯一出口。
 * 实测踩过：早上 09:38 的 K 线兜底只写「上次成功数据（本次刷新失败）」**没有日期**，
 * 用户把前一日的整场读成"今天横盘"。日期不能省。
```


## src/client/chartNote.ts

```
 * 图表脚注里的"这份数据是什么"说明（纯函数，零 import）。
 *
 * 用词统一（见 `docs/AUDIT-COPY2.md` 的全局用词表与 E1）：**降级复用一律写成
 * `· 上次成功数据（MM-DD HH:mm）`**，日期不可知时才退到 `· 上次成功数据`。
 *
 * 为什么日期不能省：K 线兜底那条以前只有 `· 显示上次成功数据（本次刷新失败）`，没有日期 ——
 * 实测早上 09:38 仍会把前一日的整场画出来，用户读成"今天横盘"（`chartCache.ts` 里记着这次事故）。
```


## src/client/index.tsx

```
/**
 * dsh-tradewatcher — browser half. Registers a global panel through the
 * Harness Slots service（`sidebar.panellist` 图标 + 同名 `main` 面板键）and
 * renders the full dashboard: three-strip TopBar with hover intraday charts,
 * inner tabs (自选 / 持仓 / 大盘 / 云图 / 日历), all data served by the host
 * half over same-origin /tradewatcher/* routes.
 *
 * 注意：面板只在「被选中」时挂载（shell 用 renderSlot('main', …, {entryKey}) 只渲染
 * 当前 key），所以挂载即等价于旧版的 visible —— 未选中时组件卸载，轮询自然停止。
 */
```


## src/client/marketTime.test.ts

```
 * 北京时间交易时段判定的断言。
 *
 * 与宿主侧 `host/time.test.ts` 同一个思路：**在任意宿主时区下都必须成立**。
 * 客户端的时区由浏览器决定（可能是 UTC、America/New_York，或容器里的 headless 环境），
 * 用 `new Date().getHours()` 会把"收盘后"判成"盘中"，于是「定稿」标记永远不出现。
 * `npm test` 会跑两遍（宿主 TZ 与 TZ=UTC），只有显式切 TZ 才锁得住这一点。
```


## src/client/marketTime.ts

```
/**
 * 北京时间交易时段判定（纯函数，可单测）。
 *
 * 与宿主 `host/time.ts` 的 `inSession` 同一口径（工作日 09:25–15:05），但这里是**展示层**
 * 需要的粗粒度状态：用来决定"这一屏数据是不是已经定稿"、以及页面上该写「定稿」还是「实时」。
 *
 * 为什么不用 `new Date().getHours()`：那读的是**宿主时区**。浏览器时区可能是 UTC 或任意
 * 时区（用户在国外、或容器里的 headless 浏览器），用本地小时会把收盘后判成盘中。
 * 因此一律按 Asia/Shanghai 取墙上时钟。
 */
```


## src/client/mini.ts

```
/**
 * Row-level mini intraday lines for watch/position lists. One trend fetch per
 * secid with bounded concurrency; results memoized module-wide (90s) so
 * remounting pages doesn't refetch, and a slow 150s refresh keeps them warm
 * while the page stays open.
 *
 * 稳定性：上游到东财的连接会随机被立刻关闭（瞬时失败率可达数十个百分点），
 * 因此失败**不会**抹掉已有缩略图 —— 保留上一份 good 数据继续显示，失败只短缓存
 * 15s 便于尽快重试；主机侧另有重试与 last-known-good 双保险。
 */
```


## src/client/portfolioMeta.test.ts

```
 * 「空值不占位」的断言（审计清单 M1 / M2 / M4）。
 *
 * 用户反馈的"提示多"里有一类是**恒假句**：今日买入为 0 时照样写
 * `今日买入 0 份当日不可卖，故可用少于持仓`；未录费用时照样写 `占累计成交额 … 的 0.000%`。
 * 值列已经是 `0.00`，这些派生说明行只会误导。这里锁住"什么时候必须有话、什么时候必须没有"。
```


## src/client/portfolioMeta.ts

```
/**
 * 持仓行内文案的**判定与取值**（纯函数，不 import react）。
 *
 * 三条都是审计清单 `docs/AUDIT-COPY.md` 的必修项（R3 不写废话 / R4 空值不占位）：
 *  - M1 可用数量：只有"今日买入确实不可卖"（`availableQty < qty`）时才有话说。
 *    此前 T+0/T+1 两个分支**每只持仓都写一行**，且今日无买入时
 *    `今日买入 0 份…故可用少于持仓` 是**假话**（恒假句，R3）。口径本身进 `title`。
 *  - M4 费用占比：`fees = 0`（未录费用）时整条不出 —— 值列已经有 `0.00`；
 *    `fees > 0` 时压成 `占成交额 X%`（"累计"与成交额列重复）。
 *  - M2 YTD 基准：只有 `baseKind === 'listing'`（年内上市，基准是**上市首日**，
 *    不标注就会被读成"年初至今"而高估）才常显；常态基准与原因进已有的行级 tooltip。
 */
```


## src/client/quoteState.test.ts

```
 * 行情卡片四态（P0-2）与金额遮罩（P0-8）的断言。
 *
 * 这两块的共同点是**界面会用它下结论**：色点告诉用户"这个价可不可信"，
 * 遮罩告诉用户"这个数能不能看"。因此断言必须钉死边界条件，而不是只测正常路径：
 *   - 未开盘（整批定稿）时**不得**判为绿色；
 *   - 超过刷新间隔 3 倍才算延迟（2.9 倍不算，3.1 倍才算）；
 *   - 无价一律"缺失"，不能被"定稿"吞掉（否则卡片会显示灰点却是空的）；
 *   - 遮罩必须覆盖每一个金额出口（漏一个出口=隐身不彻底）。
```


## src/client/quoteState.ts

```
 * 行情卡片四态判定（P0-2）。
 *
 * 目的：一眼分辨一张卡片是「实时 / 延迟 / 定稿复用 / 没有」。
 * 此前只有列表头的汇总徽标（滞后 N / 无行情源 N），具体是哪几张要看 tooltip 才知道，
 * 而"这张卡上的价到底是刚拿到的还是十分钟前的"恰恰是单个数字可信度的前提。
 *
 * 四态与判据（顺序敏感 —— 从上往下第一个命中者生效）：
 *   1. `missing`  红：没有可用价格（三源都没有）→ 卡片是 `—`，不是"还没刷新"
 *   2. `settled`  灰：休市定稿（`cached`）→ 数据已确定，没有回源的必要，**未开盘不得显示绿色**
 *   3. `delayed`  黄：兜底值（`source==='lkg'`）或观测时刻超过刷新间隔的 3 倍
 *   4. `live`     绿：以上都不成立
 *
 * 这里的判定与 `/quotes` 的 `asOf`/`stale`/`cached` **同源**（都用行内 `at`/`source`），
 * 不另起一套算法 —— 否则列表头汇总与逐卡颜色会互相矛盾。
```


## src/client/sort.ts

```
/**
 * 列表排序（自选 / 持仓）。纯函数，无 React 依赖，便于直接测。
 *
 * 两条容易踩的坑，都在这里一次性约定：
 *  1. **空值恒排最后**：无行情、无市值、无盈亏的条目不该因为"升序"跑到最前 ——
 *     让 `null` 混进数值比较是这类功能最常见的错误（`null` 参与减法会变成 0，
 *     出现在"涨幅最小"的位置）。因此无论升序降序，无效值一律沉底。
 *  2. **稳定且可预期**：同值条目保持原顺序（默认顺序 = 用户自己添加的顺序），
 *     排序不会在每次轮询后重新洗牌；非有限值（NaN/Infinity）按无效值处理。
 */
```


## src/client/styles.test.ts

```
 * 断点一致性的可执行断言。
 *
 * 背景：宽屏有两个"必须一起生效"的东西 —— 多列网格（`.tw-wlist`/`.tw-poslist` 的 `columns:520px`）
 * 与列头排序（`.tw-sorthead`）。它们各写一个 `@media (min-width:1080px)`，
 * 且在客户端由 `WIDE_MIN_PX` 决定**挂哪个排序控件**。
 * 三处只要有一处漂了，后果不是"稍微难看"，而是：
 *   - 列头显示了、多列没生效 → 名次错乱（按列读变成按行读）；
 *   - JS 判定为宽、CSS 判定为窄 → 排序入口消失或列头挤成一团。
 * 因此把"必须一致"从注释升级成断言 —— 注释拦不住改代码的人。
```


## src/client/styles.ts

```
/**
 * dsh-tradewatcher client styles — dark-saas (Linear-inspired) token system
 * from the dsh-design-skills pack, implemented symmetrically for light/dark:
 *   near-black canvas + surface-layered panels + hairline dividers (dark);
 *   near-white canvas + white cards + hairline dividers (light); one accent
 *   (#5e6ad2); semantic up/down colors only as 8–12% translucent chips;
 *   tabular/mono numerals for every figure; compact info-dense density.
 * Injected once as a <style> element; every class is scoped under `.tw-*`.
 */
```


## src/client/treemap.test.ts

```
 * treemap 布局的断言（P2-5）。
 *
 * 布局是"画出来才发现不对"的典型：面积不成比例时图看着仍然像样，但读者据此比较
 * 板块大小就会得出错误结论（成交额差 10 倍的板块看起来一样大）。
 * 因此这里断言的是**几何不变量**，而不是快照。
```


## src/client/treemap.ts

```
 * squarified treemap 布局（纯函数，P2-5）。
 *
 * 单独成模块的理由与 quoteState/alertRules 一样：这是可断言的几何逻辑
 * （面积成比例、不越界、不重叠、长宽比不退化），而组件那边要引 React。
 * 混在 .tsx 里会让纯逻辑的测试必须装 React。
 *
 * 为什么用 squarified 而不是"从大到小切条"：后者在"一个极大值 + 一堆小值"时
 * 会切出针一样的细条 —— 细条的面积既量不准也看不清，热力图就失去了比较意义。
```


## src/client/trendView.test.ts

```
/**
 * 分时图坐标域与均价/成交量可用性的断言（图表 bug 的回归锁）。
 *
 * 缺陷形态：国际指数/外盘商品的分时 `avg/vol/amount` 全被回成 0，
 * 0 作为"真实值"进入 y 轴域 ⇒ 4274~4303 的走势被压进 0~4303 的轴（看着是平线），
 * 成交量窗格的 `max` 又兜底成 1 ⇒ 印出 `成交量 1.00`。
 */
```


## src/client/trendView.ts

```
 * 分时/五日的坐标域与"这条序列到底有没有均价/成交量"的**纯函数**（不 import react）。
 *
 * 为什么单独放：这些判定既是图表 bug 的根因（缺失被编码成 0 → y 轴被压到 0~4303），
 * 又必须能被断言锁住 —— 塞在 React 组件里就只能靠肉眼。组件与测试共用同一份实现。
 *
 * 口径：
 *  - `avg`（当日均价/VWAP）**不可能 ≤ 0**：`null`/`0`/负数都不是有效值 ⇒ 不画、也不进坐标域。
 *    老版本宿主会把"没有均价"回成 0，所以这里不只看 `null`，也挡掉非正值（纵深防御）。
 *  - 成交量/成交额按**整条序列**判："有没有这个字段"，而不是逐点抹零（安静的分钟真的可能是 0）。
```


## src/client/useYtd.ts

```
 * 年初至今（YTD）取数（客户端侧）。
 *
 * 跟随**共享行情引擎的更新节拍**拉取（与自选异动的做法一致）：YTD 的分子是现价，
 * 行情没更新时重算没有意义。宿主的这个路由很便宜 —— 现价走行情 TTL 缓存，
 * 基准按 (secid, 交易日) memo 一天一次，因此"每次轮询拉一次"不会变成取数压力。
 *
 * 失败不清空上一次的结果（否则数字会在"有 / —"之间闪烁），只把错误单独标出来：
 * 数据有没有、这次成不成功，是两件事。
```


## src/client/wide.test.ts

```
 * 宽窄判定的断言。
 *
 * 这组断言锁的是一条**用户体验**约定：任何宽度下都必须**恰好一个**排序入口。
 * 此前靠 CSS 隐藏其中一个，实测出现过两个同时可见；现在由判定决定挂哪个，
 * 因此这里的边界值就是"会不会同时出现两个"的边界。
```


## src/client/wide.ts

```
 * 宽窄布局的判定（纯函数，无 React 依赖）。
 *
 * 为什么要有这个模块：v0.30.0 的列头排序与分段开关此前是**两个都渲染、靠一条 CSS 隐藏其中一个**
 * （`.tw-root [data-wide-hide=1]{display:none !important}`）。实测出现了两者同时可见的情况 ——
 * 只要那条选择器链的任何一环失配（祖先类名、媒体查询、内联样式优先级），用户就会看到两套排序控件
 * 各说一套。**"靠 CSS 藏起来"不是互斥，只是看起来互斥**。
 *
 * 现在改为：由这里判定当前该用哪个控件，**只挂那一个**。于是"两个控件同时出现"在结构上不可能，
 * CSS 里那条隐藏规则退化为兜底（保留，但不再是唯一防线）。
 *
 * 断点值必须与 `styles.ts` 的多列网格（`.tw-wlist`/`.tw-poslist` 的 `columns:520px` 生效阈值）
 * 和列头样式保持一致 —— 不一致会出现"列头没挂但段控被藏"这种最坏情况。
```


## src/client/ytdView.test.ts

```
 * 客户端 YTD 展示断言（纯函数，可被 node --test 直接跑）。
 *
 * 重点锁两条容易被忽略、又只能靠文案保证的约定：
 *  - 取不到显示 `—` 且说明原因（不许出现 0）；
 *  - tooltip 必须带上口径原文（`YTD_CALIBER`）与实际生效的复权口径 ——
 *    「这个 YTD 是前复权还是不复权」是这个数字可不可信的前提。
```


## src/client/ytdView.ts

```
 * 客户端侧 YTD 展示逻辑（纯函数，无 React 依赖，便于直接测）。
 *
 * 口径文案**只有一处**（`shared/model.ts` 的 `YTD_CALIBER`）：界面 tooltip 与 agent 工具
 * 引用的是同一句 —— 两处各写一套迟早会对不上。
 *
 * 两条硬约定：
 *  - 取不到就显示 `—` + 原因（**不用 0 顶替**：0 会被读成"没涨没跌"）；
 *  - 指数/期货按原始价格算，tooltip 必须说明"该标的不适用复权"（否则会被当成"前复权出问题了"）。
```


## src/host/anomaly.ts

```
/**
 * 自选异动识别（P1-4）。
 *
 * 回答一个问题：**这一条今天"不正常"吗** —— 放量，还是价格异动。
 *
 * 两条判据，全部基于可验证的数据：
 *  1. **量能倍数**：今日成交量 ÷ (20 日均量 × 日内进度)。分母的"日内进度"复用护盘模块
 *     标定的累计成交占比曲线（`progressAt`），因此这是**同时点**口径 —— 早盘 10:00
 *     拿全天均量直接比会得出"每天都缩量"的结论（进度才 40%）。
 *  2. **涨跌幅**：来自行情（不是从 K 线重算），绝对值 ≥ 5% 即价格异动。
 *
 * 单位一致性：量能倍数**只用 K 线序列算**（今日本身在日线里也有一根），不把行情的
 * `vol`（手）与日线的 `vol` 混用 —— 混单位会得出恒为真或恒为假的判定，而且看不出来。
 *
 * 样本不足（< MIN_SAMPLES 个交易日）**不给判定**：5 天以下的均量是噪音，
 * 报出来的"异动"只是新股/次新股的正常波动。
 */
```


## src/host/backup.ts

```
 * 多设备导出 / 导入（P0-9）。
 *
 * 不做账号体系与自建云同步（见 README「明确不做」），走**文件**：
 * 导出把 watch/positions/ledger/prefs 打成一份 JSON（带 `schemaVersion` 与校验和），
 * 导入前先预览冲突，覆盖前写 `.bak`。
 *
 * 最硬的一条：**账本重放不一致直接拒绝导入**。宁可不导入，也不能导入一份算不平的账 ——
 * 一旦写进去，之后所有的成本、盈亏、已实现都会建立在一个错的账本上，
 * 而且用户没有任何手段看出来"从哪一天开始不对"。
 *
 * 本文件的校验逻辑是纯函数（不碰 IO），因此可以直接单测。
```


## src/host/bottom.ts

```
 * 底部位置 / 日内形态 / 底部概率。
 *
 * 设计原则（避免伪精确）：
 *  1. **位置**（相对历史的便宜程度）与**量能**可从 500 根日线回算 → 可以给出
 *     **频率校准过的概率**：把当前状态与历史同类日（同分位区间 + 同量能档）类比，
 *     统计其后 1/3/5/10 日的表现。概率必须与**样本量 N** 和**无条件基线**一起展示，
 *     N 不足时明确标注，不给结论。
 *  2. **日内形态**（日内回升、下影线、破前低收回）没有可回算的历史分钟数据，
 *     因此它**不进入**那个概率，只作为实时修正分单独展示 —— 混进去就是伪精确。
 *  3. 概率是"历史上同类情形的频率"，不是预测；底部只能事后确认。
```


## src/host/breadth.ts

```
 * 涨跌家数每日快照与历史分位（P1-8）。
 *
 * 目的：回答"今天的涨跌家数在最近这段时间里算什么水平"。
 * 单看 `上涨 3120 / 下跌 1840` 没有参照物 —— 牛市里天天这样，熊市里这是反弹。
 *
 * 三条口径必须写死并在界面标注，否则分位会被当成"预测"：
 *  1. **指标 = 上涨家数占比** = up ÷ (up + down + even)，不是"涨跌比"，也不是涨跌家数之差；
 *  2. **基准 = 之前 N 个交易日**（不含今天）。把今天自己算进基准会让分位偏高/偏低的一端
 *     被自己拉动（自我参照）；
 *  3. **样本 < MIN_DAYS 不给分位**：5 天的分位是噪音，不是信息。
 *
 * 快照只在**收盘后**记录：盘中每次读到的涨跌家数都在变，记进去等于把"某一时刻的横截面"
 * 混进"每日定稿"，几天后分位就不可解释了。
```


## src/host/breadthCount.test.ts

```
 * 涨跌家数自统计链路的断言（源 B / 源 C）。
 *
 * 这里锁的是三条最要紧的东西：
 *  ① 本地计数的口径（>0 上涨 / =0 平盘 / <0 下跌），**等式基准是有效行数而不是上游 total**
 *    （A 股常态就有停牌/无涨跌幅的行，拿未扣除的 total 做等式会当日恒失败 —— 实测踩过）；
 *  ② 「按涨跌幅降序」那条**边界搜索**必须真的只碰少数几页，而且**顺序不变量**不成立时不许发布数字；
 *  ③ 明显不合理的统计（三者全 0 而 total>0、三类之和与有效行数不等、扫到的原始行数不足）一律按失败处理。
 *
 * ⚠ 断言必须跑在**生产取数口径**上（total 含无涨跌幅的行）：把 total 手工写成有效行数会让
 * 那类缺陷在测试里看不见。
 *
 * 红线：宁可返回失败（界面 `—` + 原因），也不给一个看起来正常但错的数字。
```


## src/host/breadthCount.ts

```
 * 涨跌家数的**自统计**链路（源 B / 源 C）。
 *
 * 背景：家数此前**只**来自指数行情对象的 `f104/f105/f106`（源 A）。指数一行情走腾讯/新浪兜底，
 * 这三个字段就没有了 ⇒ 大盘页三格 `—`（用户实测：爱盯盘有、我们没有）。所以需要一条**不依赖东财**
 * 且能**自己统计**的链路。三条源按成本从低到高命中即止：
 *
 *   源 A（最便宜，`em.ts` 的指数字段）→ 源 B（东财 clist 分页计数）→ 源 C（新浪按涨跌幅降序做边界搜索）
 *
 * 本模块只放**纯逻辑与可注入的算法**（不 import react、不直接碰网络）：计数、边界搜索、
 * **顺序不变量自检**、合理性检查。网络取数由 `em.ts` / `sina.ts` 提供，测试里注入构造的页数据。
 *
 * 红线：不变量不成立就**不发布这个数**（宁可 `—` + 原因，也不给一个看起来正常但错的数字）。
```


## src/host/breadthCount.ts

```
/**
 * 通用组件：对**任何"按涨跌幅降序返回分页"的源**做边界搜索（只碰边界页，不拉全量）。
 *
 * 只定位两个分界：①涨幅 >0 与 ≤0；②=0 与 <0。分界页内降序 ⇒ 三大类各自连续，
 * 于是"上涨家数 = 分界页之前的全部 + 分界页内 >0 的行数"，平盘/下跌同理。约 6–8 次请求。
 *
 * **顺序不变量自检**（任一条不成立 ⇒ 不发布这个数，返回失败 + 原因）：
 *  - 每页内部必须非递增（降序）；
 *  - 分界页 P：`min(P) ≤ 0 ≤ max(P)`；且 `min(P-1) > 0`（P=1 时免检）；
 *  - 分界页 Q（首个含负值的页）：`min(Q) < 0 ≤ max(Q)`；且 `min(Q-1) ≥ 0`；
 *  - 三类独立计数之和必须等于 `total`。
```


## src/host/breaker.ts

```
 * 上游熔断器（进程级、按主机组共享）。
 *
 * 背景：东财行情主机（push2/push2delay/push2his）会随机掐断连接，且在请求量偏大时
 * 会升级为**持续不可达**（实测一天内失败率从 25% 一路爬到 100%，同时东财数据中心与
 * 腾讯/新浪仍正常 —— 属于针对本机 IP 的限流/封锁）。此时"重试 12 次"只会加重封锁，
 * 因此这里做进程级熔断：
 *   - 连续 N 次**调用**失败 → 打开熔断，冷却期内**不再发起任何请求**（由调用方走兜底数据）
 *   - 冷却时间指数增长（2 分钟 → 4 → 8 → 上限 15 分钟）
 *   - 冷却结束后放"半开"试探：**同一时刻只放行一个探针**（claimProbe），
 *     成功即完全恢复，失败则继续加倍冷却
 *
 * 失败记账按**实际失败的主机**：调用方须把本次调用中从未成功过的每台主机各自记一次，
 * 不能笼统记到主机列表最后一项（那会误熔健康主机）。
```


## src/host/calendar.test.ts

```
 * 日历同步状态的断言（P0-2）。
 *
 * 存在的理由：`sync()` 里四个源此前各自 `catch {}` 吞错，然后**无条件**把 `syncedAt`
 * 写成"现在"。于是上游全挂时，事件还是旧的那一份，而界面/agent 读到的是
 * "刚刚同步过、没有降级" —— "没有新事件"被读成"确实没有新事件"。
 *
 * 这里用注入的失败源把那条路径钉死：全失败后 `syncedAt` 必须保持不变、`missing` 必须非空。
```


## src/host/calendar.ts

```
/**
 * 财经日历：本地事件库 + 自动同步。
 *
 * 手动事件（宏观、未上市公司 IPO 传闻、自定义提醒）由 UI / 会话工具维护；
 * 自动事件来自东方财富数据中心（新股申购/上市、持仓与自选标的的财报预约披露、
 * 分红除权除息），按稳定 autoKey 去重，可单独隐藏。
 *
 * 数据文件：<dataHome>/calendar.json
 */
```


## src/host/chart-source.test.ts

```
/**
 * 「拿不到就带原因」与 K 线缓存命名的断言（task-10 的 C / D 项）。
 *
 * 背景：国际指数/外盘商品的图表此前只回 `{trend:null}` / `{kline:null}`，
 * 客户端只能给一句「该周期暂无数据（停牌/新股/接口限流）」—— 把"该市场本来就没有分时源"
 * 与"东财这会儿被限流"混成一句，用户无从判断该不该等。这里锁住三件事：
 *   1) `why` 的判定与既有 `quoteProvenance` 同口径（no-source / transient）；
 *   2) 无兜底源的市场（国际指数/外盘商品/期货）在说明里点明"没有别的源"；
 *   3) K 线缓存的**老命名** `<secid>_<klt>.json` 只在 fqt=0 时兜底复用（指数/期货被归一为 0，命中的就是它）。
 */
```


## src/host/context.ts

```
/**
 * Structural faces of the host services dsh-tradewatcher consumes. This plugin
 * resolves outside the DSH monorepo's single cordis instance, so the upstream
 * `declare module '@deepseek-ai/cordis'` augmentations do not reliably reach
 * this Context — the members below mirror the actual runtime shapes (the same
 * approach dsh-better-sidebar and ecosystem plugins take). The real `ctx`
 * passed by the loader satisfies these structurally.
 */
```


## src/host/em.ts

```
/**
 * Eastmoney (东方财富) quote relay. All endpoints are the free public "延迟行情"
 * JSON feeds; browser CORS blocks them, so the host half fetches on behalf of
 * the GUI and normalizes everything to the shared model.
 *
 * Reliability layout (verified live against the deployed network):
 *  - push2delay.eastmoney.com  — primary quotes/boards host (very tolerant)
 *  - push2.eastmoney.com       — fallback quotes/boards
 *  - push2his.eastmoney.com    — history (intraday trends + daily klines),
 *                                with push2delay/push2 as fallbacks (all three
 *                                served trends2 during probing)
 *  - searchapi.eastmoney.com   — symbol search (suggest)
 */
```


## src/host/em.ts

```

/**
 * 把行情新鲜度升级为 agent 可读的**数据出处契约**（P0-1）。
 *
 * 关键在 `missing[].why` 的判定：同样是"一个价都没有"，成因完全不同——
 *   - 该标的**没有备用源映射**（腾讯/新浪都不认这个 secid）**且东财可达** → `no-source`：
 *     这是上游的结构性缺口，重试一万次也没有，agent 应该改口径而不是等；
 *   - 有备用源映射但三源这次都失败了 → `transient`：稍后重试可能拿到；
 *   - 没有备用源映射**但东财此刻不可用** → 也是 `transient`（P1-7 修正）：
 *     此前只看静态映射，于是"东财被限流 + 该标的只有东财一条链路"会被判成
 *     "拆结构性缺失、重试无效"，而事实是**等东财恢复就有** —— 方向错会让 agent 放弃等待。
 *
 * 此前工具层只回 `{ ts, items }`，两者都是"列表里少几行"，agent 无从分辨。
 *
 * @param opts.emDown 覆盖"东财此刻是否不可用"（默认读熔断器与最近一次批量失败）；测试可注入
 */
```


## src/host/em.ts

```

/**
 * 分时兜底顺序的**纯决策**（非休市定稿路径）：`上游 → 活的备用源（腾讯分钟线）→ 本地 LKG`。
 *
 * 修的是什么：此前两个分支都把**过期的 LKG** 排在活的腾讯分钟线前面 ——
 * 分支 A（上游返回 null）直接 `lastGoodTrend ?? data` 根本不试腾讯；分支 B（上游抛错）也是
 * LKG 命中就 return。于是"有昨日 LKG 的标的"（指数/ETF 常有）在东财不可达时**永远显示昨天**，
 * 而恰好没有 LKG 的标的反而拿到今天的实时分钟线（实测：09:38 时 1.510300 全是 10-08，1.600519 是 10-09）。
 *
 * 判据是**数据是不是今天的**（`sessionDay` 与该序列最后一个点所属交易日），而不是"有没有 LKG"：
 * LKG 只有在"上游与备用源都拿不到"时才用，并且把 `sessionDay` 交给调用方，让界面如实写明
 * 「显示上次成功数据（10-08 15:00）」，而不是让人以为这是今天的图。
 */
```


## src/host/em.ts

```
/**
 * 分钟源覆盖表（**按代码事实**整理，不猜 —— 每一项都能在下面各函数里找到出处）：
 *
 * | 市场 | 当日分时 | 五日（多日分钟） | 均价 / 成交量 / 成交额 |
 * | --- | --- | --- | --- |
 * | 沪(1)/深(0) 股票·ETF | 东财 trends2 → 腾讯分钟线兜底 → 本地 LKG | ✅ 新浪 5 分钟线 → 腾讯 5 分钟线 | 都有 |
 * | 港股(116) | 东财 trends2 → 腾讯分钟线兜底 → 本地 LKG | ❌（`sinaSymbol` 不映射港股） | 东财通常都有 |
 * | 美股(105/106/107) | 只有东财 trends2 → 本地 LKG | ❌ | 视东财回包 |
 * | 国际指数(100) / 外盘商品(101·112) | 只有东财 trends2 → 本地 LKG | ❌ | **实测只有价格**：trends2 回 0（已归一为 null） |
 * | 国内期货(113·114·115) / 板块(90) | 只有东财 trends2 → 本地 LKG | ❌ | 以实际回包为准 |
 *
 * 出处：当日分时 `fetchTrendSingleDay`（东财）+ `tencentTrend`（腾讯，仅 `tencentCode` 覆盖的沪/深/港股）；
 * 五日 `fetchMultiDayTrend`（`sinaSymbol` 只映射沪/深，腾讯 5 分钟线同样只在沪/深）。
 * 结论：**只有沪/深有"多日分钟"源**；其它市场的五日只能显示当日 —— 界面必须如实标注
 * （`trendDayCount` + 抽屉里的提示），不许静默把当日当五日画。
 *
 * 分时序列：ndays=1 用东财当日分时；ndays>1 优先 5 分钟 K 拼接（新浪/腾讯），
```


## src/host/fence.ts

```
/**
 * Browser-trust fence for the /tradewatcher/* routes, behaviorally identical
 * to the /api gateway's fence (and to dsh-better-sidebar's own trust-fence):
 * Host-header loopback or a configured trusted authority passes; cross-site
 * browser markers refuse. This is a DNS-rebinding / cross-site defense, not
 * authentication. (Same helper the ecosystem starter plugin ships.)
 */
```


## src/host/http.ts

```
/**
 * 路由错误语义。
 *
 * 此前所有路由异常一律回 `400 {error}`：上游（东财/腾讯/新浪）被限流或连接被掐断时
 * 也是 400 —— 客户端与排障都把它读成「我的请求写错了」，而真实原因是**服务端暂时不可用**，
 * 应当稍后重试而不是改参数。这里把三类混在一起的失败拆开：
 *
 *   400 请求本身有问题（secid/scope/sort 非法、JSON 解析失败）
 *   413 请求体过大
 *   503 上游不可用（熔断中、连接被关闭、超时、上游 5xx、上游返回非 JSON）
 *   500 其它未归类错误（本插件的 bug）
 *
 * 路由内已知的客户端错误用 HttpError 显式声明状态码；其余按消息模式归类，
 * 避免为历史抛错点逐个改造而漏掉分支。
 */
```


## src/host/ledger-skip.test.ts

```
 * 账本重放"跳过条目"必须可读（P1-5）的断言。
 *
 * 缺陷形态：`replayPosition` 对未能应用的流水 `catch {}` 静默保留前值 ——
 * 账本里能看到 5 笔、持仓快照却少一块，而没有任何标记说明"有 N 条流水没被应用"。
 * 这是账务口径的静默降级：用户对不上账时无从下手。
```


## src/host/p0.test.ts

```
 * P0 批次（口径与状态外化）的宿主侧断言。
 *
 * 这组测试的价值在于**把"不说谎"变成可执行的约束**，而不是靠自觉：
 *   - 采样窗口：暂停时段必须给出原因与下次时刻（P0-4）；
 *   - 贡献度：因子贡献之和必须能复算出总分（P0-7）；
 *   - 出处契约：缺失必须区分"上游没有"与"这次失败"（P0-1）；
 *   - 未折算的跨市场持仓必须逐项列在 unpriced 里（P0-1）；
 *   - 备份校验：算不平的账必须被拒（P0-9）。
```


## src/host/p1b.test.ts

```
 * / 的断言。
 *
 * 这两块的共同风险是**把"没判定"当成"正常"**、以及**把没参照物的数当结论**：
 *   - 异动：样本不足 / 非交易时段必须与"判定过且无异常"分开；
 *   - 静默：30 分钟内不重复提醒，但"它正在异动"这个事实不能被抹掉；
 *   - 分位：样本 < 5 不给分位（要用 null，不是 0）。
```


## src/host/portfolio-cost.test.ts

```
/**
 * 「成本未录入」的断言（P1-10）。
 *
 * 缺陷形态：新建持仓后用「调整」录了数量、没填成本 → `avgCost = 0` →
 * 浮动盈亏 = (现价 − 0) × 数量 = **整个市值**（凭空多出一整笔盈利），并一起污染分组与总额。
 * 约定：区分"未录入"与"真的是 0 成本"（判据 `avgCost<=0 && qty>0 && turnover===0`），
 * 未录入时**市值照算**、盈亏与盈亏率给 `null`（界面显示 `—`），并在工具/界面里说清"未计入合计"。
 */
```


## src/host/portfolio.ts

```
   * 成本"未录入"≠"成本为 0"（P1-10 / D1 修正）。
   *
   * 新建持仓后用「调整」录了数量却没给成本时 `avgCost` 是 0，若照旧计算，
   * 浮动盈亏 = (现价 − 0) × 数量 = 整个市值 —— 凭空多出一整笔盈利，且会污染分组与总额。
   *
   * 判据是**不存在产生成本的流水**（买入，或带 price>0 的调整）—— 见 `hasPricedCostEntry`：
   *   - 不能用 `turnover<=0` 表达"从未真的买卖过"：**卖出同样产生成交额**。
   *     `adjust(100,0)` 之后卖一次，守卫就自行解除，持仓重新落回 0 成本路径
   *     （实测：浮盈 = 剩余 50 股的全额市值、摊薄盈亏 = 市值的两倍、已实现 = "0 成本买入"的收益）；
   *   - 也不能只看 `avgCost<=0`：手工改过的流水里可能出现 price=0 的买入。
   *
   * 覆盖范围含"已全部卖出"的持仓：qty 归零不满足"有持仓"，但那些股是在成本未知时卖出的
   * （`realizedUnknownQty > 0`）—— 成本同样从未录入，因此 `costUnknown` 在那里也成立。
   * 该情形下**市值照算**（与成本无关），但盈亏 / 盈亏率 / 已实现一律给 null（界面显示 —）。
```


## src/host/rescue-thresholds.ts

```
/**
 * 【护盘信号】默认阈值与基准 —— 由 scripts/calibrate-rescue.mjs 生成，请勿手改。
 * 标定日 2026-09-24；方法：F1: Tencent daily kline (vol×100×close ≈ amount), 20-day rolling ratio percentiles; progress: Sina 5-min cumulative volume share
 *   F1 量能倍数：2886 个样本（6 只宽基 ETF × 约 481 个交易日的 20 日滚动量比）
 *   日内进度曲线：126 个交易日（新浪 5 分钟线）
 *   F2 超大单强度：免费源已无日频资金流历史 → 经验锚点，由 host 采样器自建样本满 20 交易日后重算
 */
```


## src/host/rescue.ts

```
/**
 * 【护盘信号】国家队护盘行为的概率性识别。
 *
 * 口径与诚实边界（重要）：
 *  - 汇金/国新/诚通不披露日内成交，本模块识别的是「符合国家队历史行为模式的
 *    宽基 ETF 放量 + 超大单净流入」，输出**概率性信号**，不等于证明买入方身份。
 *  - 超大单为东财按单笔金额的分类口径（非席位数据）；ETF 成交额含做市双边报价与
 *    套利盘，天量 ≠ 净买入，因此始终用「超大单净额」与「量价背离」交叉验证。
 *
 * 阈值来源（全部在 UI 标注，不藏黑箱）：
 *  - F1 量能倍数：历史分位数标定（scripts/calibrate-rescue.mjs，2886 个样本）
 *  - 日内进度曲线：126 个交易日的新浪 5 分钟线标定
 *  - F2 超大单强度：免费源已无日频资金流历史 → 经验锚点，host 采样器自建样本满
 *    20 个交易日后改用自建分位数（thresholdSource = 'self'）
 *
 * 数据文件：<dataHome>/rescue-log.json（60 天滚动）
 * 采样节奏：常态 30s，尾盘（默认 14:30 后）15s，仅交易时段活跃，每次采样 1 个批量请求。
 */
```


## src/host/rescue.ts

```
/**
 * 脉冲参考点选择（纯函数，便于断言）。
 *
 * 规则：只有在 `[evalAt - windowMs - 容差, evalAt - windowMs + 容差]` **窗口内**的序列点
 * 才能当作"5 分钟前"的参考；且序列末端必须贴近 evalAt（`evalTs - last <= maxLagMs`）。
 *
 * 为什么必须卡这两个边界（v0.21.0 修的 bug）：分钟序列此前**每天只在冷启动回填写一次**，
 * 而参考点选择以"序列末端"为锚点（`evalAt = min(evalTs, last)`）—— 序列过期后，
 * 分子变成"序列末端→现在"的累计成交额（可达几十分钟），分母仍是"5 分钟"的预期，
 * 于是脉冲被系统性放大。实测（假时钟 10:30 盘中、同一份真实行情）：
 * 过期序列 → 5.01x，采样环口径 → 1.12x（因子分 60 vs 22）。
 * 卡住窗口后，过期序列提供不了窗口内的点 → 自然退回采样环口径，**算错变成不可能**。
```


## src/host/routes.test.ts

```
 * 路由层测试（node:test，零新增依赖，不依赖网络可用性）。
 *
 * 存在的理由：host 自检（selftest.ts）一直**直调模块函数**，于是 249 条断言全绿的同时，
 * 路由层的大小写规范化把 4 个商品主连整批丢掉也没人发现 —— `/tradewatcher/quotes` 是
 * 界面唯一的数据入口，它必须有断言。这里的断言分两类：
 *
 *   1. **结构不变量**（与上游是否可用无关）：`items + missing` 必须覆盖全部请求项、
 *      返回键必须等于请求时的写法（不得被改写成大写）、截断必须如实回报；
 *   2. **错误语义**：400 / 413 / 415 / 503 与 `retry-after`、信任围栏 403。
 *
 * 每个测试文件由 node 的测试运行器单独起进程，因此这里对熔断器的改动不会影响其它文件。
```


## src/host/routes.ts

```
/**
 * /tradewatcher/* HTTP routes (same-origin with the web GUI).
 * GET  — quote relay (quotes / trend / kline / detail / suggest / board)
 * GET  — watch / portfolio / ledger / prefs snapshots
 * POST — watch + portfolio mutations (validated by the store) and prefs
 * Every route is behind the browser-trust fence; POST bodies are capped.
 *
 * 错误语义见 http.ts：400 请求有问题 / 413 体过大 / 503 上游不可用 / 500 本插件 bug。
 * 此前一律 400，把"上游被限流"报成"你的请求写错了"。
 */
```


## src/host/sina.ts

```
/**
 * 新浪备用源：ETF 排行（东财行情 CDN 被限流时使用）。
 *
 * 接口：Market_Center.getHQNodeData（node=etf_hq_fund，沪深 ETF 全量）
 *   参数 page/num/sort/asc；sort=amount（成交额）或 changepercent（涨跌幅）
 *   响应为 GBK 编码的 JSON 数组，字段：symbol/code/name/trade/changepercent/amount/volume/turnoverratio
 */
```


## src/host/singleflight.ts

```
/**
 * 合并并发调用（single-flight）。
 *
 * 场景：护盘采样 tick 有**三条**触发路径 —— 定时循环、前端 `?force=1` 手动刷新、
 * 路由的 `ensureFresh()` 自动补采。此前它们各自直接 `await this.tick()`：
 * 定时器与手动刷新撞在一起时，会有两份全量采样同时在跑 —— 每份都会打一遍上游
 * （通道数 × 行情 + 分钟线），`today.samples` 重复计数，两份快照互相覆盖
 * （先完成的被后完成的盖掉，可能出现「样本数回退」）。
 *
 * 语义：**一次只跑一份**，期间的新调用合并到同一份上（等待同一个 Promise），
 * 而不是排队再跑一遍 —— 采样是幂等的轮询，重复执行没有额外信息量。
 * 失败不会把实例锁死：结算即释放下一个名额。
 */
```


## src/host/store.ts

```
/**
 * dsh-tradewatcher data store: append-only trade/audit ledger + group/item
 * descriptors, persisted as JSON under ~/.dsh/dsh-tradewatcher/ (DSH_HOME
 * aware). All mutations validate first, append a ledger entry, and write
 * through atomically. Position quantities/costs are NEVER stored — they are
 * derived from the ledger by replay, so the JSON files are the durable record
 * for in-session analysis and the UI can rebuild any state from scratch.
 */
```


## src/host/tencent.ts

```
/**
 * 腾讯行情备用源。
 *
 * 用途：东财行情主机（push2 系列与 push2his）对本机 IP 限流/封锁时，至少保住
 * **量能、脉冲与价格**这三项可观测指标；「超大单净流入」只有东财提供，无替代，
 * 因此备用源下该字段为 null，并在快照里标注数据来源，评分相应降级。
 *
 * 接口（免费、无需鉴权）：
 *  - 批量快照：https://qt.gtimg.cn/q=sh510300,sz159915  （GBK 文本，按 ~ 分隔）
 *  - 当日分钟：https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=sh510300
 *    （每行 `HHmm 价 累计量(手) 累计额(元)` —— 第 4 字段是**累计成交额**，
 *      实测末行 1530 = 全天成交额，与批量快照的成交额一致）
 */
```


## src/host/time.test.ts

```
 * 时区回归测试（P0）。
 *
 * 这组断言的价值全在"**在任意宿主时区下都成立**"：护盘模块的采样时段、
 * 阶段语义、时点系数全部基于墙上时钟，若用宿主本地时间，Docker/云主机/CI
 * 的默认 TZ=UTC 会把真实盘中判成"盘前"→ 采样一次都不触发。
 *
 * `npm test` 会把这套测试跑两遍（宿主 TZ 与 TZ=UTC），只有显式切 TZ 才锁得住
 * —— 否则在任何一台 UTC+8 机器上都是绿的。
```


## src/host/time.ts

```
 * 统一时区工具（**唯一口径：Asia/Shanghai**）。
 *
 * 为什么必须钉死：本插件判断"是否在交易时段""当前处于哪个阶段""今天是哪一天"
 * 全都基于墙上时钟。此前 rescue.ts / calendar.ts 用宿主本地时间
 * （`new Date(ts).getHours()` 等），而 portfolio.ts 用 `Intl.DateTimeFormat('Asia/Shanghai')`
 * —— 同一插件内两套口径并存。
 *
 * 实测后果（TZ=UTC，Docker / 云主机 / CI 的默认值）：
 *   北京时间 10:00（真实盘中）→ inTradingWindow=false、phase='pre'
 *   → **护盘采样一次都不触发**；反而在北京时间 17:25–19:35 / 20:55–23:05 采样，
 *     且时点系数、阶段语义、脉冲锚点全部错位（晚间盘面按"早盘"给 0.4 折）。
 *
 * 因此所有时间标签一律走本模块，且回归断言必须在 TZ=UTC 与 TZ=Asia/Shanghai
 * 两个环境下都成立（见 src/host/time.test.ts 与 npm test 的双 TZ 跑法）。
```


## src/host/tools.ts

```
/**
 * Agent-facing read-only tools + system-prompt guidance. Registered on the
 * host `tools` registry (when the service is present) with plain object
 * literals (structural face — no runtime dependency on @deepseek-ai/dsh-tools).
 *
 * Everything the sidebar panel writes lives in the same JSON files, so a
 * session can analyse holdings, reconstruct the ledger and optimise: the
 * tools read the live files + live quotes; the plain JSON is additionally
 * documented in README for file-tool based analysis.
 */
```


## src/host/trade-rules.test.ts

```
/**
 * 卖出可用数量判定（P1-8）的断言。
 *
 * 缺陷形态：此前只校验**总持仓**，于是可以录出一笔"A股当天买入、当天卖出"的成交 ——
 * 券商端不存在这笔交易，而当日盈亏与已实现盈亏会按它算出来（数字看着正常、其实错了）。
 *
 * 两类断言：
 *  1. 纯函数 `availableQtyAt`（可卖 = 该时点前已持有 − 同日该时点前买入）；
 *  2. 端到端：宿主 `mutatePortfolio` 真的会驳回（并且 T+0 品种不受限）。
 */
```


## src/host/trend-fallback.test.ts

```
 * 分时兜底顺序的断言（P0）：`上游 → 活的备用源（腾讯分钟线）→ 本地 LKG`。
 *
 * 缺陷形态（装机实测）：早上 09:38，1.510300 / 1.000001 还显示 **10-08 的整场**（昨天），
 * 而 1.600519 是 10-09 的实时分钟线 —— 差别只在"有没有昨日 LKG"：有 LKG 的标的被
 * 过期的 LKG 挡住，根本不试活的备用源。判据必须是**数据是不是今天的**，不是"有没有 LKG"。
 *
 * 三条断言（都可构造）：
 *  ① 上游抛错 + 有昨日 LKG + 备用源可用 ⇒ 必须返回**备用源的当日数据**，且没有 staleAt；
 *  ② 上游抛错 + 有昨日 LKG + 备用源也失败 ⇒ 回 LKG，且**带 sessionDay**（等于 LKG 那天）；
 *  ③ 休市定稿 ⇒ 仍复用本地（不许被这次改动破坏），且**不去打上游/备用源**。
```


## src/host/trendArchive.test.ts

```
 * 每日分时归档的断言：幂等覆盖 / 滚动清理 / 体积保护 / 坏文件 / 缺目录。
 *
 * 这是**新的持久化**，长期运行 + 逐日累积，因此必须锁住三件事：
 *  1) 同一天重复取到不会追加成两份（覆盖写）；
 *  2) 只留最近 N 个交易日，且**只删自己目录里的日期文件**；
 *  3) 坏文件 / 缺目录不崩、不静默（坏文件带原因进 `unreadable`；缺目录就是"还没归档"）。
```


## src/host/trendArchive.ts

```
 * 每日分时的本地归档 —— 多日拼接的数据来源。
 *
 * 为什么要单独建目录：`trends-lkg.json` 是"每标的只留最新一次"的兜底快照（键 `secid|ndays`），
 * **没有按日归档**，所以用户提的"拿缓存的每日分时拼接出五日"在它身上拿不到历史。
 * 本归档从**本版起累积**：今天只有 1 天，之后逐日变多 —— 界面与回包都如实说明，不假装。
 *
 * 路径：`<dataHome>/trends/<secid>/<YYYY-MM-DD>.json`
 *  - **原子写**（tmp + rename），与 store 的持久化约定一致；
 *  - **幂等覆盖**：同一天重复取到就覆盖（后到的更完整），不会追加成两份；
 *  - **滚动清理**：只保留最近 `TREND_ARCHIVE_KEEP_DAYS` 个交易日，写入时清理，
 *    且**只删自己目录里形如 `YYYY-MM-DD.json` 的文件**；
 *  - **体积保护**：单文件 / 该标的总量超过上限时**不写**并如实报告（长期运行的插件不能悄悄写满磁盘）；
 *  - 坏文件 / 缺目录：**不崩、不静默** —— 坏文件进 `unreadable` 并带原因，缺目录就是"还没有归档"。
```


## src/host/writeLog.ts

```
 * 写操作日志与节流（P0-11）。
 *
 * 存在理由：agent 能写数据（日历等）之后，"写错了怎么退"必须有答案。
 * 三条约束，全部落在这一层（工具实现只负责声明反向操作）：
 *
 *  1) **可撤销**：每次写入记一条 `WriteRecord`，含 `by`（会话 id）与反向操作描述；
 *     撤销是一条新的写入（`undone` 由日志记录），**不删除历史** —— 撤回本身也要留痕。
 *  2) **节流**：同一秒内超过 3 次写入直接报错，不静默丢弃。丢一个写入而不说
 *     比报错更坏：调用方会以为写成功了。
 *  3) **范围最小**：只允许撤销本插件自己写过的东西（日志里登记过的 target）。
 *
 * 落盘 `<dataHome>/write-log.json`，保留最近 KEEP 条。
```


## src/host/ytd.test.ts

```
/**
 * 年初至今（YTD）断言。
 *
 * 全部**不打上游**：K 线取数入口（`fetchKline`）是注入的，`now` 也是注入的 ——
 * 这样"按日 memo""失败冷却""并发有界"这几条都能被确定性地断言，
 * 而不是靠观察真实网络行为（那种断言在 CI 上会时红时绿）。
 */
```


## src/host/ytd.ts

```
 * 年初至今（YTD）。
 *
 * 口径**写死在 `shared/model.ts` 的 `YTD_CALIBER`**（界面 tooltip 与 agent 工具引用同一句）：
 *
 *   YTD = (现价 − 本年内第一个交易日收盘价) ÷ 该收盘价 × 100%，序列用**前复权**。
 *
 * 三条实现约定（都是"宁可显示 — 也不给一个看着正常的错数"）：
 *
 *  1. **基准必须已收盘**：年内第一个交易日的**收盘价**才是基准。若该日就是今天
 *     （一年里只有这一天会撞上：1 月第一个交易日）则本轮不给数 —— 不拿未收盘价当基准，
 *     也不拿上一年收盘顶替（那属于另一条口径，混进来就说不清了）。
 *  2. **本年内上市要标出来**：序列里没有更早的交易日时，基准是**上市首日**而不是年初，
 *     按"年初至今"读会高估，因此 `baseKind='listing'`，界面单独给 tooltip。
 *  3. **指数/期货不适用复权**：`fqSupported=false` 时按原始价格（点位/合约价）计算，
 *     并在 tooltip 说明 —— 与 K 线详情图的复权开关同一套判定（`em.fqSupported`）。
 *
 * 取数复用 `em.fetchKline`（磁盘缓存 + 增量 + 单飞），因此**不会每个轮询周期重算**：
 * 基准按 (secid, 交易日) memo 一天一次，失败结果带冷却（默认 10 分钟）以免重试轰炸上游。
 * 批量并发有界（≤4），与 `anomaly.ts` 的写法保持一致。
```


## src/index.ts

```
/**
 * dsh-tradewatcher — host half.
 *
 * One dual-face bundle row (`tradewatcher` / `dsh-tradewatcher`):
 *  - node half (this file): quote relay + tradewatcher file store +
 *    /tradewatcher/* routes + read-only agent tools + prompt guidance;
 *  - browser half (src/client): registers the 「盯盘」 global panel through the
 *    Harness Slots service (`sidebar.panellist` + `main`) and talks to this half
 *    over same-origin fetch.
 */
```


## src/shared/model.ts

```
/**
 * 分时序列的缺失值归一（图表 bug 的根因修复）：**缺失不许编码成 0**。
 *
 * 症状：国际指数/外盘商品的分时被画成一条"平线"，y 轴 0.000/2000/4000、成交量显示 `1.00`。
 * 成因：东财 `trends2` 对这类标的一律回 `avg=0, vol=0, amount=0`，而 0 被当成真实值参与
 * y 轴域计算（把 4274~4303 的走势压进 0~4303 的轴），成交量窗格又把 `max` 兜底成 1。
 *
 * 归一规则（两类字段判定方式不同，别混）：
 *  - `avg`（当日均价/VWAP）**逐点**判：真实 VWAP 不可能 ≤ 0，所以 `!(v > 0)` 就是"没有" ⇒ `null`；
 *  - `vol` / `amount` **按整条序列**判：只要序列里存在一个 > 0 的值，就说明该源确实提供这个字段，
 *    其余点照原样保留（安静的分钟真的可能是 0）；整条都没有 ⇒ 该源不提供 ⇒ 全部 `null`。
 *    逐点抹零会把"这一分钟真的没成交"误报成"没有数据"，同样是造假。
 *
 * 幂等：对已经归一过的序列再跑一次结果不变（客户端可防御性地再跑）。
```


## src/shared/stats.test.ts

```
 * 比例区间（Wilson）的断言。
 *
 * 这块的价值全在**边界行为**：小样本、极端比例、零样本。
 * 朴素正态近似在 n=5、p=1 时会给上界 >100%（一个不可能的概率），
 * 这正是必须钉死的点 —— 概率面板上出现 >100% 的区间，整块结论就没人信了。
```


## src/shared/stats.ts

```
 * 比例的区间估计（Wilson score interval）。
 *
 * 为什么必须给区间：`20 个样本的 80%` 与 `500 个样本的 80%` 是完全不同的两件事 ——
 * 前者的 95% 区间大约 58%–92%（跨过基线毫无意义），后者约 76%–83%。
 * 只报一个点估计，读者会不由自主地把它当成"准确率"，而它可能只是小样本的噪音。
 *
 * 用 Wilson 而不是朴素正态近似（p̂ ± z√(p̂(1−p̂)/n)）：后者在 p̂ 接近 0/1 或 n 较小时
 * 会给出越界区间（如概率 100%、n=5 时上界 >100%），而 Wilson 恒在 [0,1] 内。
 *
 * 纯函数，无依赖 —— 宿主与客户端共用同一份实现（避免两边算出不同的区间）。
```


## src/shared/trendStitch.ts

```
 * 多日分时的**本地拼接**（不 import react，纯函数）。
 *
 * 背景：`五日` 此前只走新浪/腾讯 5 分钟 K 线，而这两家**只覆盖沪/深** ——
 * 港股、国际指数、外盘商品、期货都没有多日分钟源。于是本插件改为把**每日成功取到的分时按日归档**，
 * 需要多日时本地拼接（从本版起累积，一天一天变多）。
 *
 * 三条不许（写在类型与实现里，不靠注释口头保证）：
 *  1) 不许假装立刻给出五日 —— 归档里没有的日子就**如实列进 `missing`**，不补；
 *  2) 不许用日K冒充分时 —— 输入只有分时点 `TrendPoint`，本模块不接触 K 线；
 *  3) 不许凭空补齐 —— 拼接结果只含实际归档到的点，覆盖报告与点是同一批数据算出来的。
```
