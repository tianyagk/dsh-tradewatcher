# V3 批次实现记录（task-34）· 四段

对象：`dsh-tradewatcher` v0.38.2 工作区。输入：`docs/AUDIT-V3-EFFECT.md`（有效性）/ `AUDIT-V3-CODE.md`（简洁）/
`AUDIT-V3-COPY.md`（原则合规）。**每段做完跑一次 `npm run check`**，基线 264 条 × 2 时区、75 项片段。

## 第 1 段：有效性

### A1 港股/美股的归档"写了从不读"（本轮最重要）
- **根因**：`fetchTrend` 的多日分支用 `multi.points.length > 1` 判"上游给了多日"，而备用源（腾讯）对港股/美股
  给的是**当日** 1 分钟线（几百点）⇒ 永远短路，本地归档永不参与 ⇒ 回包连 `coverage` 都没有。
- **改法**：新增纯函数 `isMultiDayTrend(points)`（不同日期数 ≥2 才算多日），`em.ts` 改用它：
```ts
if (multi !== null && isMultiDayTrend(multi.points)) return multi
// 否则落到 stitchFromArchive（source: 'local-stitch' + coverage）
```
- **实测回包**（本机真实归档 `~/.dsh/dsh-tradewatcher/trends/116.00700`，复制到临时 DSH_HOME，
  注入"腾讯风格"的**当日** 272 点上游，**未探活**）：
```json
{ "source": "local-stitch",
  "days": ["2026-10-09"], "points": 272,
  "coverage": { "have": ["2026-10-09"], "missing": [], "limit": 5 } }
```
  改前同一条路径返回的是**当日数据且无 `source`/`coverage`**（审计实测）。归档只累积了 1 天，所以 `have` 就是 1 天 —— 如实标出，不编造。

### A3 `missing` 一次列 11 个日期
- 新增 `missingBrief(missing, max = 3)`（`shared/trendStitch.ts`）：`缺 09-25、09-28、09-29，另有 8 天`；
  常显口径条改用它（完整列表仍留在回包与 `title` 里）。断言：11 个日期 ⇒ 文案 ≤40 字且只列前 3 个。

### A4 备用源下"按金额/主力资金"点了没效果
- `MarketPage` 新增 `boardMoneyOk = boardMeta === null || boardMeta.source === 'em'`；不可用时三个按钮
  （成交额 / 主力资金 / 金额·占比）**置灰 + title 说明**："当前数据来自备用源（不含…字段），该排序暂不可用；东财恢复后自动可用"。

### B1 云图无成交额时画空白图
- `IndustryHeatmap` 的空态改为按原因分档：全部板块都缺成交额 ⇒ `当前源无成交额字段，云图不可用（等东财恢复后自动可用）`；
  否则 ⇒ `本次未取到板块成交额，云图暂不可用（稍后刷新重试）`；来源进 `title`。

## 第 2 段：简洁

| 项 | 结果 |
| --- | --- |
| 删 `wide.ts`/`useWide.ts`/`wide.test.ts` | 三个文件已删；`WIDE_MIN_PX` 移到 `styles.ts` 导出（CSS 断点唯一数字来源）；`styles.test.ts` 的互斥断言文案改为"CSS 不得用 display:none 承担互斥（排序入口只有段控一处）" |
| `data-span` 死分支 | `RescuePanel` 的 `...(props.span === undefined ? {} : {'data-span': …})` 与 `span?: number` 已删 |
| 零引用导出 | `SortColumn` / `fmtDate` / `CandleBar` / `shortLabel` 已删（含 `portfolio.ts` 指向 shortLabel 的注释）；`ACTOR_TOOL` **保留**并把 `tools.ts` 的 `actor === 'tool'` 渲染分支改为引用它（一处定义）；`store.ts` 的 `actor==='tool'` **读入兼容未动** |
| S5 原子写抽公共 | 新增 `src/host/atomic.ts`（`writeFileAtomic` / `writeJsonAtomic`）；6 处调用点（`breadth` / `calendar` / `rescue` / `store` / `trendArchive` / `writeLog`）全部改用它 |
| 数值判定统一 | `breadthView.ts` 的本地 `num` 并入 `shared/model.ts` 的 `numOrNull`（语义完全一致）。**未合并**：`em.ts` 的 `num`（**字符串解析**：`String(v).trim()` + `'-'` ⇒ null）—— 合并会把东财以字符串给的字段整片判成 `null`；`bottom.ts` 的 `v is number` 守卫按审计保留；`sina.ts`/`tencent.ts` 的字符串解析版按红线不动 |

## 第 3 段：原则合规

- **M1** 家数红条：正文压成 `涨跌家数未取到`（8 字），长原因 + "备用源不含该字段"进 `title`/`aria-label`；**红条本体保留（K1）**。
- **M2** 删恒真句 `（信号达到「疑似护盘」时本面板会自动展开）`（收起态就是默认态）。
- **M3** `styles.ts` 两处硬编码浅红 → `color-mix(in srgb, var(--tw-up) 10%/8%, transparent)`（同一条边不再两种红）。
- **M4** `.tw-pos-title small` 加进**两条** `data-blur=1` 清单；`.tw-cal-day` / `.tw-code` 各加"非行情数字，豁免"注释。
- **M5** 细节卡片行加 `role="note"`（无 role 的 `aria-label` 读屏不读）。
- **S1** 用词表越表 **20 处**全部收敛（`未返回`/`暂无数据`/`拿不到`/`取不到`/`没取到` → `未取到`；`同步于`/`最近一次成功采样` → `数据时刻`）；
  **README 词表补一行例外**："窄容器（侧栏徽标）允许简写 `数据 HH:mm:ss`"（否则规则与实现在侧栏永久冲突）。
- **S2/S3** `可用（可卖）` → `可用`（两处）；`累计已实现（已计入上栏）` → `累计已实现`；`该标的不适用分时段网格` → `无固定交易时段`。
- **S5** 新增 `upDownColors(redUp)`（`chartCursor.ts`），`kline.tsx` 的 13 处内联 `redUp ? 'var(--tw-up)' : …` 全部改用它（现在 0 处内联）。
- **S6** 两处硬编码色板（`BADGE_TONE_COLOR` / `QUOTE_STATE_COLOR`）集中到新文件 `client/theme.ts` 并注明"深色主题值、与面板内 CSS 变量不是同一个色"；`index.tsx`/`quoteState.ts`（含对外 re-export）改引常量。
- **S4** 面板级 vs 行级同因：自选页行级 `板块当日涨幅未取到` 长原因改为 `（原因见上方「板块涨跌与 α」一行）`，原因由面板级一处承担。
  （注：任务书写"行级优先"，而 `AUDIT-V3-COPY` 写的是"原因由面板级一处承担、行级只留通用词" —— 我按**审计**执行：页级故障只有**一个**原因，逐行重复才是冗余。）

## 第 4 段：文档

- `docs/DESIGN-DASHBOARD.md` 顶部加 **未落地** 抬头（v0.33.1 已回退、源码无 `.tw-board`、当前是 12 栏网格）。
- **9 份一次性报告归档**进 `docs/archive/`：`AUDIT-UI` / `AUDIT-FUNCTION` / `AUDIT-COPY2` / `AUDIT-V2-CODE` /
  `AUDIT-V2-FUNCTION` / `COMPETITOR-NOTES` / `AUDIT-IMPL3` / `AUDIT-IMPL4` / `AUDIT-IMPL5`；
  README「开发」节的索引句改为目录级说明；`ROADMAP.md`/`DECISIONS.md`/`README.md` 里指向这些文件的链接同步改到 `archive/`。
  **留在 `docs/`**：`AUDIT-V3-*`（本轮）`AUDIT-VERIFY2.md`（现行验收）`DECISIONS.md`/`ROADMAP.md`/`DESIGN-DASHBOARD.md`。
- **S10 明确关闭**：`DECISIONS.md` 记"测试文件按批次命名保留，不做归并"（本轮起不再挂）。
- 另记一条**待议**：非故障语义的 6 处红色应新增 `--tw-danger`/`--tw-warn` 严格分离，本批不改（K8，理由写进 DECISIONS）。

## 保留档核对（K1–K8 逐条未动）

K1 家数红条本体 ✓（只压正文）；K2 抽屉故障红/结构性中性两分支 ✓；K3 护盘等级语义 ✓（只删括号行为句）；
K4 `badgeView` 一行 + 32 字上限 ✓；K5 细节卡可见文案 ✓（可见只有通用词+数字，口径在 hint）；
K6 `UPDOWN_MISSING_NOTE` ✓；K7 `MISSING_TIER_ADVICE/LABEL` ✓；K8 六处非故障红 ✓（本批不改，已记 DECISIONS）。

## 测试条数变化与门禁

```
基线           264（× 2 时区）
第 1 段后      266（+2：isMultiDayTrend、missingBrief 的断言）
第 2 段后      263（−3：wide.test.ts 三条随宽窄判定一起删除）
第 3 段后      263（口径/文案断言的期望值同步更新，数量不变）
第 4 段后      263
```
每段 `npm run check` 全绿；末次末尾三行：
```
> node build.mjs

built lib/index.js + lib/client.js （v0.38.2，客户端片段校验通过：75 项）
```

## 零引用核对（`grep` 实测，全 0）

```
useWideLayout 0 · isWideWidth 0 · layoutModeOf 0 · WIDE_MEDIA_QUERY 0 · data-span 0
SortColumn 0 · CandleBar 0 · fmtDate( 0 · shortLabel( 0
src/client/wide*.ts / useWide.ts：不存在
atomic 助手调用点：6 处（breadth/calendar/rescue/store/trendArchive/writeLog）
```

## 未做项与原因

1. **`em.ts` 的 `num` 不并入 `numOrNull`**（审计建议"三处统一"）：它是**字符串解析**版
   （`String(v).trim()`、`'-'` ⇒ null），与 `numOrNull` 语义不同；合并会让东财以字符串返回的字段整片变 `null`
   （CHANGELOG v0.34 有同类实测记录）。已在两处注释里写明为何不合并。
2. **A2（归档覆盖率低：54 个标的只有 7 个到 5 天）** 不在本批：修它要动"自动刷新路径也归档自选标的"，
   属数据写入策略变更，会显著增加磁盘与请求量 —— 需要产品决策，本轮只做 A1（让归档**真的被读**）。
3. **S7（同句两处实现）** 不在任务清单内（任务只列到 S6），未做；审计也判定"可见层面不违规"。
4. **K8 的 `--tw-danger` 分离**：本批不改（任务明确），只在 DECISIONS 记一条待议。

## 需装机复核（无浏览器，**未做视觉验证**）

1. 港股/美股五日档是否真的从归档拼出多天（本机归档只有 1 天 ⇒ 复验需要连续几天打开同一标的）；
2. 备用源下"成交额/主力资金"按钮的置灰观感与悬停原因；
3. 云图在备用源下的"不可用"文案（而不是空白图）；
4. 家数红条压缩后的观感（正文 8 字 + 悬停/读屏里的长原因）；
5. 细节卡片新增 `role="note"` 后读屏是否朗读口径句；
6. 两处色板集中到 `theme.ts` 后，侧栏徽标/四态色点在深色与浅色主题下的表现（值未变，位置变了）。
