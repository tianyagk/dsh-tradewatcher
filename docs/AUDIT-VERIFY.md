# 独立验收报告：批一（列头排序 + YTD）+ 批二（5×P0 / 7×P1）

> 验收人：`verify`（独立验收员，非实现者）。立场：找"声称做了但没做到"的地方。
> 输入：`docs/AUDIT-IMPL.md`、`docs/AUDIT-IMPL2.md`、`docs/AUDIT-FUNCTION.md`、`docs/AUDIT-UI.md` + 工作区未提交改动（v0.30.0）。
> 本报告只依据**我自己跑的**门禁、我自己写的反例断言、以及代码/工作区的直接阅读；不引用实现者的自述数字作为结论依据。
> 临时反例脚本在 `/tmp/tw-verify/`（跑完删除），未入库。

## 0. 结论

**有条件通过 —— 不建议按当前工作区状态直接提交；先修 §4-D1。**

- 批一、批二的**全部 12 条认领项**（5×P0 + 7×P1）以及批一的列头排序/YTD，经代码复核与独立反例断言，**均真实落地**，未发现"声称做了其实没做"的项。
- 但存在 **1 条 P1 级残留缺陷（§4-D1）**：`costUnknown` 判据里的 `turnover <= 0` 使"未录入成本 + 卖出过"的持仓重新落回"0 成本"路径，产出**凭空盈利**（浮盈 = 全额市值、摊薄盈亏 > 市值、已实现 = 0 成本收益）。这是"看着正常的错数"，触碰本项目红线，属本批修复范围（审计 P1-10）的**未覆盖分支**。
- 若按本仓库对"错数"的既有定级习惯（能让人误信数据的口径缺陷 = P0），D1 可上调为 P0；据此报告按 P1 呈报，处置权交 Lead。除 D1 外无 P0 级问题。

## 1. 门禁实测（我自己跑的）

`npm run check`，本机工作区 v0.30.0，`exit=0`（完整日志按约定清理，摘要如下）：

```
ℹ tests 146  ℹ pass 146  ℹ fail 0        # 第一轮（本机时区 Asia/Shanghai）
ℹ tests 146  ℹ pass 146  ℹ fail 0        # 第二轮（TZ=UTC）
ALL HOST CHECKS PASSED (live probes soft)   # 上游仍被本机网络重置，按既有约定 soft
built lib/index.js + lib/client.js （v0.30.0，客户端片段校验通过：75 项）
```

交叉验证（防"漏跑测试文件"）：`src/**/*.test.ts` 共 **20 个文件**，逐文件 `test()` 计数合计 **146**，与 `node --test` 报告的 146 完全吻合 —— 新增的 7 个测试文件（`breadthView` / `ytdView` / `calendar` / `ledger-skip` / `portfolio-cost` / `trade-rules` / `ytd`）都在其中，没有文件被 glob 漏掉。

## 2. 逐条核对表

### 2.1 批二 5 个 P0

| 声明 | 代码证据 | 我的实测/复核 |
| --- | --- | --- |
| P0-1 家数缺失 → `—` 而不是 0 | `client/breadthView.ts`（`breadthCells` 任一分量缺失 ⇒ 三格全 `null`；`upDownPair` 一侧缺失整格 `null`）；`MarketPage.tsx:162-166` 用 `countsOk/amountOk` 判 `—` | ✅ 独立反例 ①-1～①-6 全绿；**基线里 7 处 `?? 0` 求和/`String(down ?? 0)` 在差集中全部消失**（见 §5） |
| P0-2 日历 `asOf`/`stale` | `calendar.ts:412-440`（`syncStatus`：`syncedAt>0?…:null`、`stale` 含"从未成功"）、`615-617`（`syncAttemptAt` 无条件写、`syncedAt` 仅 `okCount>0` 时推进）；`routes.ts:200-208` GET/POST 共用；`tools.ts:681-687` | ✅ 独立反例 ⑤-1/⑤-2：零成功 `syncedAt===null` 且 `stale=true`；成功一次后全失败 `syncedAt` 不变、`missing` 4 条 |
| P0-3 云图配色跟随 `prefs.redUp` | `index.tsx:395` 传 `prefs.redUp` → `CloudMap.tsx:71,135` → `IndustryHeatmap.cellColor(pct, redUp)`；第三方档位加常驻徽标（`CloudMap.tsx:155`，文案在两种档位下方向正确） | ✅ 代码路径闭合。⚠️ 渲染未实测（见 §6） |
| P0-4 Markdown `**` 残留 | 去注释后扫描 | ✅ 我自写的扫描脚本（剥离块注释 + 行注释后匹配引号内文本）：**命中 0 处** |
| P0-5 焦点环 + `--tw-focus` | `styles.ts:47-50`：`:focus` 只改边框、`:focus-visible` 用**已定义**的 `--tw-ring` 画 3px 环、range 改 `outline`；`--tw-focus` 全仓仅剩注释 | ✅ `--tw-ring` 在浅色(`styles.ts:21`)与深色(`:36`)两套主题都有定义；`--tw-focus` 无遗留引用。⚠️ 环的可见性未实测 |

### 2.2 批二 7 个 P1

| 声明 | 代码证据 | 我的实测/复核 |
| --- | --- | --- |
| P1-6 按列填充 + 断点 1080 | `styles.ts:121-125`（`columns:520px`）、`132-147`（列头显示与 `[data-wide-hide=1]` 收起在**同一个** `@media (min-width:1080px)` 块） | ✅ 反例 ⑦-2 断言同块同值；全仓无 1500px 残留 |
| P1-7 缺失原因可聚焦 | `MarketPage.tsx:171-178,247,363`、`WatchlistPage`、`PortfolioPage`、`CalendarPage` 的 `tabIndex=0 + role="note" + aria-label` | ✅ 关键缺失处有，正常态不加停靠点（抽样核对） |
| P1-8 状态词统一 | `quoteState.ts:30` `NO_SOURCE_LABEL`；`build.mjs:172` 片段同步为 `无行情源`；`ui.tsx:147` 已同步 | ✅ 全仓无 `暂无可用行情源` 残留（仅 `docs/` 历史记录里提到） |
| P1-9 未录入成本 | `portfolio.ts:117-118,149-155`；`portfolio-cost.test.ts` | ⚠️ **主场景已修，残留分支未覆盖 → §4-D1** |
| P1-10 卖出校验可用数量 | `store.ts:315-332`（`availableQtyAt`）、`810-818`（`!isT0Secid` 时驳回）；`shared/model.ts:818-824`（`isT0Secid`） | ✅ 反例 ⑥-1/⑥-2：同日买入可卖 0、次日 100；ETF/港股 T+0 |
| P1-11 no-source 归因 | `em.ts:339-365`（`emDown` 注入 + 措辞分支）、`emUnavailableNow` | ✅ 代码复核（`emDown=true` 时 `transient` 且明说"不是结构性缺失"）；未打真实上游 |
| P1-12 replay 不吞流水 | `store.ts:276-297` `replayPositionWithSkips`；`portfolio.ts:104,181-182`；界面与工具报数 | ✅ 代码复核 + 独立反例脚本未推翻 |

### 2.3 批一遗留（本轮重点）

| 声明 | 代码证据 | 我的实测/复核 |
| --- | --- | --- |
| 宽屏列头 / 窄屏段控**单向安全** | `WatchlistPage.tsx:172-181`（段控 + `wideHidden:true`）与 `:251`（列头）在**同一返回树**；`PortfolioPage.tsx:254-262` 与 `:335` 同理；`styles.ts:132-147` | ✅ 反例 ⑦-1/⑦-2 全绿。**"宽屏下两个排序入口同时消失"在当前代码下不可达**（论证见 §3），但存在一个**未实测的降级形态**（§4-D5） |
| `aria-sort` + 键盘 | `SortHeader.tsx:48,54,60-68`：`columnheader` + 三态 `aria-sort`、真 `<button>`（Enter/Space 由浏览器保证）、`↺ 默认顺序` 复位 | ✅ 结构齐备；内容合规性有一处已知缺口（§4-D4）。⚠️ 键盘行为未实测 |
| 无效值升序沉底 | `sort.ts:106-119`（`null/NaN/Infinity` 一律沉底，同值原索引） | ✅ 反例 ③-1～③-3：全 null 输入两方向都稳定；NaN/null/Infinity 混合升序沉底；`cost=null` 在升序下沉底 |
| YTD 口径 | `model.ts:197` + `client/ytdView.ts:11,22` + `host/tools.ts:13,507`（**同一常量**）；`host/ytd.ts:72-87`；`em.ts:1495` 序列升序取尾部 | ✅ 反例 ④-1～④-4；**前复权已实测传参 `fqt=1, klt=101`**（注入捕获） |

### 2.4 README 同步核对（第 5 项要求）

`README.md` 已被 Lead 同步，且**文档与代码一致**：

- 工具 `tradewatcher_ytd`（README:180）↔ `tools.ts:454` ✅
- 路由 `/tradewatcher/ytd`（README:187 的路由清单里写作 `ytd?ids=`）↔ `routes.ts:371` ✅
- 列头排序 + 1080px 断点 + 互斥描述（README:38/120）↔ `SortHeader.tsx` + `styles.ts:121-147` ✅
- YTD 口径节（README:274-282）↔ `YTD_CALIBER` 字面一致 ✅
- 未发现"文档说有、代码没有"的条目。

## 3. "宽屏两个排序入口同时消失"的最坏情况：构造结果

我按要求把这条当作首要反例来构造，结论分两层：

**（a）在当前代码结构下不可达**，反例 ⑦-1/⑦-2 给出结构证据：

1. 两个页面里 `SortHeader` 与 `SortBar` 都**各自恰好出现一次**，且**均无条件包裹**（`? React.createElement(SortHeader` / `&& …SortHeader` 断言为不匹配）——"列头没渲染"只能发生在整个页面加载态，而那时段控同样没渲染。
2. 段控的隐藏规则 `.tw-root [data-wide-hide=1]{display:none !important}` 与列头的显示规则 `.tw-sorthead{display:flex…}` 位于**同一个** `@media (min-width:1080px)` 块内、同一个断点值；窄屏基线是 `.tw-sorthead{display:none}`。因此任何宽度下"收起段控"与"显示列头"必然同时发生或同时不发生。
3. 样式表整体失效时（媒体查询不生效），基线规则生效 ⇒ 回到"只有段控"的安全态。

**（b）真正可达的失败形态是另一个（我构造出来了）**：断点判定基于**视口宽度**，而面板的实际容器可能远窄于视口（例如宿主侧栏）。此时 `≥1080px` 命中 → 段控被收起、列头替换上来，但列头在 360px 宽的容器里会被 `flex-wrap:wrap` 折成多行，可用性明显下降。这不是"入口消失"，但属于**未实测的降级**（见 §6），装机时应在"窄容器 + 宽视口"这一组合下看一眼。

## 4. 缺陷

### D1（P1，必修）未录入成本 + 卖出 → 判据失效，产出凭空盈利

**现象**：`adjust(100, 0)`（用「调整」录数量、不填成本）之后**发生过一次卖出**，`costUnknown` 变回 `false`，盈亏重新按 `avgCost=0` 计算。

**复现**（我已实测，输出为原样粘贴）：

```
adjust(100,0) + sell(50,12.5)，现价 12.5 →
{"qty":50,"avgCost":0,"turnover":625,"realized":625,
 "costUnknown":false,"floatPnl":625,"dilutedPnl":1250,"mv":625}
```

- `floatPnl 625` = 剩余 50 股的全部市值 → 与"凭空一笔盈利"是同一个错误，只是被卖出掩盖了；
- `dilutedPnl 1250` = **市值的两倍**（净成本被卖出收入冲成负数再除以数量）；
- `realized 625` = 把"0 成本买入"当成事实算出来的已实现收益。

**操作路径**：新建持仓 → 行内「调整」只填数量、不填成本 → 卖出（部分或全部）。两条都是界面上的正常操作，不需要构造异常数据。

**根因**：`portfolio.ts:117` 的判据 `qty > 1e-9 && avgCost <= 0 && turnover <= 0` —— 用 `turnover <= 0` 表达"从未真的买卖过"，但**卖出也会产生 turnover**，于是这条守卫在卖出后自行解除。

**建议修法**（按代价从低到高）：

1. 判据换成"没有任何**产生成本**的流水"：存在 `buy` 或带 `price > 0` 的 `adjust` ⇒ 成本已知；否则未录入。即 `costUnknown = qty > 0 && avgCost <= 0 && !hasPricedCostEntry`。（`hasPricedCostEntry` 从流水里算，比 `turnover` 精确：卖出不产生成本。）
2. 或让 `costUnknown` 成为**粘性标记**：一旦某持仓出现过"未录入成本的 adjust"，在后续出现有效 `buy`/带价 `adjust` 之前一直为真（含卖出后）。
3. 无论哪种，`realized` 也必须一并受保护（当前它同样按 0 成本算），并在工具/界面沿用既有的"不计入合计"文案。

**回归断言建议**：把 §3 ②-3 那条探索输出固化成断言（`costUnknown===true`、`floatPnl===null`、`dilutedPnl===null`）。

### D2（P2，文档一致性）`AUDIT-IMPL2.md` §8.8 与工作区不一致

自述称"`build.mjs` 片段表锁着旧词 `'暂无可用行情源'`、`ui.tsx:147` 保留原句、需 Lead 配合"；实际工作区里 `build.mjs:172` 已是 `'无行情源'`、`ui.tsx:147` 已是「无行情源」，构建 75 项校验通过。**代码是对的、自述过期**。该改动与 `build.mjs` 片段替换必须成对（否则构建挂），判定为 Lead 的整合操作；但自述未同步，建议在 `AUDIT-IMPL2.md` 补一行"已由 Lead 一并更新"，避免后续读者据此以为旧词仍在。

### D3（P3，观察）`tools.ts:655` 是本次唯一新增的裸 `catch`

全仓 `catch` 计数 199（基线 192），其中 `calendar.ts` 净减 4 个静默 `catch`（改为逐源记录，属改善）。逐条比对新增行后，**唯一新增的裸 `catch {}`** 在 `tools.ts:655`（`calendar.sync` 调用处）：它不吞信息 —— 失败原因由 `calendar.syncStatus().missing` 兜底并进入 `provenance.missing[]`。可接受，但形成一个隐式耦合（将来 `syncStatus` 若不覆盖某类错误，这里会静默）。建议保留现有注释即可，无需改动。

### D4（P2，可达性）`aria-sort` 的结构合规性缺口

`SortHeader.tsx:28,54` 输出 `role="row"` + `role="columnheader"`，但没有任何 `table`/`grid`/`rowgroup` 祖先 —— 部分读屏软件不会播报这半套表格语义下的 `aria-sort`。自述 §8 已登记为遗留风险，我确认**确实存在**。建议二选一：补齐 `role="table"` + `role="row"` 的完整结构，或退成 `role="group"` + `aria-label`（避免用半套表格语义误导）。这是 P1-1 列网格落地后的自然归宿。

### D5（P2，未实测）列头断点用视口宽度而非容器宽度 → 窄容器下的布局降级

见 §3(b)。不是功能性缺陷（入口仍在），但可能"宽屏列头被压扁"。装机时请按"宿主实际容器宽度"看一眼，若确实难看，正规修法是改用容器查询（`@container`）或由调用方按容器宽度决定 `wideHidden`。

### D6（P3，已知近似）`listing` 判定在"序列取满"时不标注

`host/ytd.ts:79`：`idx === 0 && bars.length < requestedBars` 才算上市首日。若某标的上市恰好超过 400 个交易日，会被标成 `year`（基准仍是序列第一根，只是不标 `listing`）。自述已登记，属可接受的近似。

## 5. 全仓扫描（与批二前基线 `HEAD` 精确对比）

- **`?? 0`**：当前 85 处 vs 基线 84 处。逐条差集：
  - **消失（原型缺陷被清除）**：`MarketPage` 的 `upSum/downSum/evenSum/amountSum` 四个 `?? 0` 求和、两处 `String(down ?? 0)`、`IndustryHeatmap` 的 `下跌 ${row.down ?? 0}` —— 共 7 处。
  - **新增 7 处，全部是计数/索引兜底**，无一处把缺失数值伪装成 0：`skippedLedger ?? 0`（4 处，可选用字段的条数统计）、`v.requested ?? 0`（工具输出里的计数）、`order.get(...) ?? 0`（YTD 行序保持的索引兜底）。
  - 结论：**未引入新的"0 顶替缺失"**。
- **`catch`**：199 vs 192；新增的 `catch` 只有 `tools.ts:655` 一处是裸的（见 D3），其余都带处理或只是注释文字；`calendar.ts` 的 4 个静默吞错被逐源记录取代。
- **`**`**：去注释后字符串内命中 **0 处**。
- **`--tw-focus`**：仅存在于解释性注释中，无 `var()` 引用。

## 6. 未验证（诚实清单）

1. **所有渲染层行为**：本机 `node_modules` 无 `react` 运行时、无浏览器自动化 —— 列头点击/键盘触发/▲▼/`aria-sort` 播报、`:focus-visible` 焦点环的可见性、数字模糊、多列按列填充的名次、云图红涨绿跌的实际配色、四态色点视觉、YTD 列排版，**一行都没真正执行过**。本报告对它们的判定全部是**源码级 + 类型检查 + 构建片段校验**，不等价于渲染验收。
2. **真实上游的 YTD 端到端**：本机上游连接被重置（selftest 里可见 `upstream fast-fail`），我没有独立跑过 `GET /tradewatcher/ytd` 的真实回包；`fqt=1` 的传参与基准选取是用注入取数验证的。
3. **列头/段控在真实宿主容器宽度下的表现**（D5）。
4. **客户端卖出表单的拦截**：只验证了宿主侧 `availableQtyAt` + `isT0Secid` 的判定与调用点，表单层未实测。
5. **日历 5 分钟失败冷却的真实计时**（只做代码复核与既有断言阅读）。
6. **`npm run selftest` 的 live 探针**：全程 soft，上游不可达属本机环境事实，不构成"真机通过"。

## 7. 写作用域

- 批一声称的范围内文件（`src/client/**`、`src/host/ytd.ts`、`routes.ts`、`tools.ts`、`src/shared/**`）与批二扩展的 `src/host/**`：改动均落在其内。批二改了 `src/client/**` 的多个文件（P0 多在客户端），与"批二在批一 client 范围之上扩展 host"的约定一致，不算越界。
- `README.md` / `CHANGELOG.md` / `docs/ROADMAP.md` / `package.json`（0.29.0→0.30.0）/ `build.mjs`（片段表）**确有改动**，内容全部属 Lead 的整合职责（版本号、口径节、路线图、变更日志、构建片段），未发现实现者越界的证据。⚠️ 说明两点：
  1. 全部改动**未提交**，无 commit 作者信息可归因，以上是按内容与职责的推断；
  2. `src/client/ui.tsx:147` 的旧词→新词改动**必须**与 `build.mjs` 片段替换成对出现（否则构建挂），实际两者一致、构建通过 —— 因此判定为 Lead 的整合操作，但批二自述未同步（见 D2）。

## 8. 复现方式

```bash
# 门禁（本报告 §1 的原始日志）
npm run check > /tmp/check-verify.log 2>&1; echo $?

# 独立反例（22 条，需在仓库根跑）
# 注：按验收约定，临时脚本 /tmp/tw-verify/counterexamples.test.ts 已在跑完后删除；
# 如需复跑，按 §3 的输入重建即可（全部不打上游、K 线与日历取数入口均为注入）。
node --test --experimental-strip-types /tmp/tw-verify/counterexamples.test.ts

# D1 的最小复现（Node REPL 亦可）
node --experimental-strip-types -e "
import('./src/host/portfolio.ts').then(({derivePosition}) => {
  const pos={id:'p1',groupId:'g1',secid:'1.600519',name:'贵州茅台',createdAt:1}
  const q={secid:'1.600519',code:'600519',name:'贵州茅台',price:12.5,chg:0,pct:1,prev:12.5,open:null,high:null,low:null,vol:null,amount:null,up:null,down:null,even:null,time:null}
  const e=[{id:'e1',ts:1,actor:'web',verb:'adjust',posId:'p1',qty:100,price:0},
           {id:'e2',ts:2,actor:'web',verb:'sell',posId:'p1',qty:50,price:12.5}]
  const r=derivePosition(e,pos,q,Date.now()-86400000)
  console.log(r.costUnknown, r.floatPnl, r.dilutedPnl, r.realized)   // 期望 true/null/null/…；实际 false/625/1250/625
})"
```

---

## 9. 验收期间的工作区并发写入（说明，不是缺陷）

验收过程中工作区仍有其他成员在写：`docs/ROADMAP.md` 于 21:18:11 被更新（新增"审计轮次记录"表并预留本报告条目）。另外 `src/host/time.ts` / `time.test.ts` / `fence.ts` 的 mtime 落在当前时间之后（文件系统时间戳异常），但它们的**内容与 HEAD 一致**（`git status` 未列为修改）。

我的门禁结论对应的输入是：`src/**` 与 `build.mjs` / `package.json` 的最后修改时间均不晚于 21:16:50，而两次 `npm run check` 都在其后运行 —— 因此 §1 的数字与当前代码状态一致。若在我出报告后又有人改动 `src/**`，需重跑门禁。

---

**一句话给 Lead**：批一/批二的声明全部对得上代码与实测，5 个 P0 与列头/YTD 都真的做了；卡点只有一条 —— `costUnknown` 的 `turnover<=0` 守卫在"未录入成本 + 卖出"后失效，会产出凭空盈利（D1），修掉即可提交。

---

# §7 D1/D1b 复验（task-8，定向）

> 验收人：`verify`。D1 经 task-6（整仓判据）与 task-7（逐笔判定 `realizedUnknownQty`）两轮修复后的**定向复验**。
> 立场：不采信实现者给的数字；三条链路全部走**真实 store 写入路径**（`DataStore.mutatePortfolio` + `assemblePortfolio`，与 `routes.ts` 同款），不用纯函数直接拼数据。
> 临时脚本 `/tmp/tw-verify2/d1-recheck.test.ts`（已按约定删除）。

## 7.1 结论：**关闭**（D1 与 D1b 都已真正关闭，未误伤正常路径）

三条链路全部符合期望，`realized` 不再混入 `(卖价 − 0) × 数量`，且"能算对的必须算对"。**建议照常提交**；§7.4 的 N1 是可见性上的不完整（不阻塞提交）。

## 7.2 三条链路实测输出（原样粘贴，真实写入路径）

```
[链路1] adjust(100,0) → sell(50,12.5) → 补成本 adjust(50,9.5)（ts 晚于卖出）
{"realized":null,"realizedUnknownQty":50,"costUnknown":false,"floatPnl":150,"dilutedPnl":150,
 "mv":625,"avgCost":9.5,"groupRealized":0,"grandRealized":0}

[链路2] 同账本，补成本 ts 早于卖出（写入顺序：adjust → **sell** → adjust(ts 更早)，故意乱序）
{"realized":150,"realizedUnknownQty":0,"costUnknown":false,"floatPnl":0,"avgCost":9.5,
 "groupRealized":150,"grandRealized":150}

[链路3] 纯正常路径 buy(100,10) → 次日 sell(50,12)，现价 12.5
{"realized":100,"realizedUnknownQty":0,"costUnknown":false,"floatPnl":125,"qty":50,"avgCost":10,
 "groupRealized":100,"grandRealized":100}

[附加] 一只 D1b（realized=null/unknown=50）+ 一只正常（realized=100）
{"rows":[{"secid":"1.600519","realized":null,"unknown":50},{"secid":"0.300750","realized":100,"unknown":0}],
 "groupRealized":100,"grandRealized":100}
```

逐条判定：

| 期望（task-8 定义） | 实测 | 判定 |
| --- | --- | --- |
| 链路1 `realized === null` | `null` | ✅ |
| 链路1 `realizedUnknownQty === 50` | `50` | ✅ |
| 链路1 `costUnknown === false`（守卫解除，没退化成粘性 null） | `false` | ✅ |
| 链路1 `floatPnl` 有值，**绝不得是 625** | `150`（= (12.5−9.5)×50） | ✅ 625 已消失 |
| 链路2 补成本 ts 早于卖出 ⇒ `realized === 150` | `150` | ✅ |
| 链路3 `realized === 100`、`floatPnl === 125` | `100` / `125` | ✅ 正常路径未被误伤 |
| 合计不把 `realized: null` 变成假的"多算" | 那只被排除，合计 `100` | ✅（数值上"跳过"与"加 0"等价；可见性见 N1） |

补充核查（"是否还有别的路径能把 `(卖价−0)×数量` 混进 `realized`"）：`realized` 在宿主侧的**唯一累加点**是 `store.ts:248`（`applyTrade` 的 sell 分支），被 `avgCost > 0` 守卫；`dayPnlOf`（`portfolio.ts:82-94`）只用 qty/price/fee，不碰 `realized`；`slicePosition` 的 0 初始化只作当日切片起点。**未发现旁路**。

## 7.3 门禁实测（我自己跑的，非引用）

```
npm run check → exit=0
ℹ tests 154  ℹ pass 154  ℹ fail 0        # 第一轮（Asia/Shanghai）
ℹ tests 154  ℹ pass 154  ℹ fail 0        # 第二轮（TZ=UTC）
ALL HOST CHECKS PASSED (live probes soft)
built lib/index.js + lib/client.js （v0.30.0，客户端片段校验通过：75 项）
```

交叉验证（防漏跑）：`src/*/*.test.ts` 共 **20 个文件**，逐文件 `test()` 计数合计 **154**，与运行数完全吻合（126 → 146 → 154 的增量与两轮修复新增断言一致）。`portfolio-cost.test.ts` 里 D1/D1b 的断言（含"ts 早于卖出算对 150"）确实存在且与我的独立结果一致。

## 7.4 新发现（均不阻塞提交）

- **N1（P2，可见性缺口）**：客户端**面板级**缺 D1b 的"合计缺一块"提示。行内（`PortfolioPage.tsx:1057-1058`）与展开详情条（`:853-854`）都有 `realizedUnknownNote`，工具侧 head 行也有（`tools.ts:217-221`）；但 `:322` 的 `stat('累计已实现', grand.realized)` 旁边没有任何说明（对比：成本未录入有面板级提示行 `:352-361`，未计价持仓有「不含 N 项」徽标 `:312-319`）。后果：用户读"累计已实现 100"时不知道还有一只的已实现是 `—`。**建议**照 `costUnknownRows` 的样式补一行可聚焦的面板级提示。
- **N2（P3，类型注释不诚实）**：`tools.ts:191` 的 render 类型断言仍写 `realized: number`（实际 `number | null`）。运行时无害（`fmtMoney(null)` → `—`；output schema 的 `positions.items` 是宽松 `{}`，不做字段校验），但与 `model.ts:592` 的 `number | null` 不一致。建议对齐为 `number | null`。
- **N3（P3，产品待决策，按 task-8 约定不算实现缺陷）**：`realizedUnknownNote` 写"补录的成本流水时点若早于这笔卖出，重放即可算对"，但界面「调整」与买卖表单**都没有时点字段**（`PortfolioPage.tsx:785-790` 的 body 只有 `qty/price/fee/note`），用户无法指定历史时点；实际可达路径只有"先补成本、再录卖出"的操作顺序。要么给表单加"流水日期"，要么把文案改成用户真的能执行的说法。
- **N4（P3，写法不统一）**：`portfolio.ts:300` 的 fx 折算分支用 `toCny(…).value ?? 0`（把 `realized: null` 折成 0 参与求和），而同函数 A股分支 `:307` 用 `add()`（跳过 null）。两者**数值等价**（加 0 不改变和），当前结果正确；建议统一成 `add()`，以免将来改语义时踩。
- **N5（P3）**：`selftest.ts:213` 的不变量断言 `(row.floatPnl + row.realized) - (row.dilutedPnl ?? 0)` 在 `realized` 为 `null` 时会被 JS 静默当成 0（断言照样通过）；当前跑的是正常路径，所以有效，但建议显式断言 `realized !== null` 后再比。

其余（`realized` 类型放宽的下游消费）**已核**：`model.ts:592`（持仓行 `number|null`）与 `:666`（组/总览合计 `number`）划分正确；`fmtMoney`（`tools.ts:34-36`）与 `fmtMoneySigned`（`client/format.ts:68-72`）对 `null` 都输出 `—`，**没有**被 `?? 0` 吞掉；备份导入导出只处理原始流水（`backup.ts:24,132-138`），不消费派生 `realized`。

## 7.5 未验证

1. **渲染层**：N1 补齐后的面板级提示、行内 `realizedUnknownNote` 的实际观感，仍未在浏览器里跑过（本机无 react 运行时）。
2. 门禁的 live 探针仍 soft（本机上游被重置），与上一轮同。
3. 真实用户操作顺序下的端到端（界面点选 → 宿主写入 → 重放），我只覆盖到**宿主写入边界**（`mutatePortfolio`），表单层未点选过。
