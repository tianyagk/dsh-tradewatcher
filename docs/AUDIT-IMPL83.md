# AUDIT-IMPL83：第 7 个页签「复盘」的客户端（月历 + 当日笔记 + 钉到未来）

- **实施时刻**：2026-10-20 09:26 起（Asia/Shanghai）
- **起点**：`f68e28d`（v0.110.0；门禁基线 **890 用例 × 2 时区** + 构建 **73 项**）
- **分工**：宿主侧（`src/host/fupan.ts`、`src/host/routes.ts` 的两条 fupan 路由、第 8 行 manifest、`README` 数据文件表、
  `src/rowOwnership.test.ts` 的 `ROW_OF_FILE`/`ROW_KEYS`）由 `impl-fupan-host` 实施；
  **本报告只覆盖客户端**：`src/client/FupanPage.tsx`（新）、`src/client/fupanView.ts`（新）、
  `src/client/api.ts`、`src/client/index.tsx`、`src/client/styles.ts`、两个既有客户端断言文件的同步（见 §6）。
- **红线**：未动 `build.mjs`、未动 `src/host/**`、未新增依赖、未新增第三条 fupan 路由、未 commit / 未装 / 未动 profile、未重启 `dsh web`。
- **概念来源**：只借鉴第三方插件 `dsh-fupan`（MIT）的**功能概念**（月历 + 一天一条记录 + 钉到未来）；
  代码 / 样式 / 文案全部本仓库自写，没有一行拷自它。

---

## 0. 结论（一行）

「复盘」作为**第 7 个页签**接在「工具」之后（`row: 'fupan'`，沿用既有行门控），月历每天显示**条数 + 钉住标记 + 交易日/休市三态**
（宿主 `dates[].trading` 缺失时是「交易日未知」+ 原因，**不默认全交易日**；`count` 缺失写「条数未知」，**不写 0**），
当日笔记支持**新增 / 编辑 / 删除 / 钉到未来**（失败必给原因、超限丢弃必显示宿主 `dropped` 原因），
钉到目标日的条目**明确标注「钉自 YYYY-MM-DD」**，路由不可用时只显示**原因 + 重试**（绝不渲染「本月暂无笔记」）；
**门禁两轮全绿（920 用例 × 2 时区）+ 构建 73 项**（见 §6）。

---

## 1. 页签接入（①）

| 位置 | 文件:行号 | 内容 |
| --- | --- | --- |
| 第 7 个页签 | `src/client/index.tsx:473` | `{ key: 'fupan', label: '复盘', full: '复盘（月历 + 当日笔记）', row: 'fupan' }`，追加在 `row: 'tools'` 之后 |
| `PageKey` 扩项 | `src/client/index.tsx:231` | `… | 'tools' | 'fupan'` |
| 保活名单 | `src/client/index.tsx:240` | `const KEEP_ALIVE: readonly PageKey[] = ['calendar', 'tools', 'fupan']` |
| 保活容器渲染 | `src/client/index.tsx:456` | `if (key === 'fupan') return React.createElement(FupanPage)` |
| import | `src/client/index.tsx:17` | `import { FupanPage } from './FupanPage.tsx'` |

**为什么保活**（与日历同款，理由写进源码注释）：本页**零轮询** —— 只在「挂载 / 换月 / 写成功后重取」三个时机取数，
所以在 `display:none` 里挂着不会有任何后台请求；收益是**月份、选中的日期、正在写的草稿**在页签来回切换后都还在
（要求③"月份状态在页签切换后不得丢失"）。其余四页仍不保活（它们有高频取数，需要先接 `active` 门控）。

**门控**：沿用 `tabsGate.ts` 的既有规则（行停用 ⇒ 页签不渲染；`/rows` 不可达 ⇒ 失败放行）。
⚠ 一处**边界**必须说清：`row: 'fupan'` 是宿主契约（`impl-fupan-host` 明确要求），所以**当 fupan 行被停用时页签会跟着消失**
（这是 `docs/DESIGN-SUBPLUGINS.md` §3 的既定设计，不是空白页）。本题里"路由不可用 ⇒ 原因 + 重试"覆盖的是
**行启用而路由取不到**（客户端先落地 / 宿主报错 / 请求超时）这一类，见 §4 的实测。

---

## 2. 月历（②）

| 规格 | 实现 | 文件:行号 |
| --- | --- | --- |
| 月历网格（周一起头、整周、裁掉全空的尾行） | `fupanGridOf` | `src/client/fupanView.ts:77` |
| 每天**条数** | `cellInfoOf(...).count`（缺失 ⇒ `null`，界面不画 0、读屏说「条数未知」） | `src/client/fupanView.ts:180` |
| 每天**是否钉住** | `hasPinned` ⇒ 格内「钉」标记（`title`/`aria-hidden`，读屏信息在 `aria-label` 里） | `FupanPage.tsx:404-406` |
| **交易日 / 休市 / 未知三态** | `tradingKindOf`：`trading===true` → 交易日；`false` → 休市（带 `closedReason`）；**缺字段 → unknown** | `src/client/fupanView.ts:108` |
| 三态呈现 | 交易日＝实线卡片；休市＝`data-kind=closed`（暗底 + 灰字 + 「休市」）；未知＝`data-kind=unknown`（**虚线** + 「?」） | `FupanPage.tsx:379`、`src/client/styles.ts:695-747`（玻璃浮层那段仍在它之后，见 `:748`） |
| 图例（不能只靠颜色） | 「● 交易日 / ○ 休市 / ◇ 交易日未知」常驻一行 | `FupanPage.tsx:305-309` |
| 原因常驻 | `tradingNoteTextOf`：已知 ⇒「按宿主交易日历标注（该月 N 天）」；未知 ⇒「未知 —— <原因>（因此不按交易日显示）」；`calendarWhy` **原样**接在后面 | `src/client/fupanView.ts:163`、`FupanPage.tsx:320-328` |
| 上一月 / 下一月 / 今天 | `shiftYm` + 「‹ / › / 今天」，换月把选中日挪进新月份（保持 roving tabindex 有落点） | `FupanPage.tsx:93-114`、`FupanPage.tsx:294-297` |
| 空态（**两句**：没有 + 怎么加） | `emptyMonthTextOf()`：「本月暂无笔记」+「点月历里任意日期…保存后那天的格子会显示条数。想把某天的结论留到别的日子看 ⇒ 选「钉到」」 | `src/client/fupanView.ts:315` |
| 条数未知（有回包但没 totals/notes） | `blank` 分支：「本月笔记条数：未取到（宿主回包没有 totals/notes，界面不写 0）」 | `FupanPage.tsx:359-361` |

**数据时刻 / 口径**：面板头显示 `数据时刻 HH:mm:ss`（`asOf` 缺失写「数据时刻未取到」），右侧显示 `totals`（`本月 N 条 · 钉住 M 条`）
与宿主 `source`；`missing[]` 与 `notesQuarantined` / `invalidEntries` 都有独立出口（`FupanPage.tsx:329-336`）。

---

## 3. 当日笔记（③）

| 规格 | 实现 | 文件:行号 |
| --- | --- | --- |
| 点某天 ⇒ 右侧列表 | 自己的（`date===day`）在上、钉进来的（`pinnedTo===day`）在下并分区（「钉到这一天的笔记」） | `src/client/fupanView.ts:214`、`FupanPage.tsx:455-463` |
| 新增 | 底部编辑器（textarea + 「钉到（可选）」+ 保存），走**唯一入口** `submit` | `FupanPage.tsx:464-495`、`:159-188` |
| 编辑 | 卡片内就地编辑（正文 + 钉到 + 字数 + 取消/保存） | `FupanPage.tsx:208-243` |
| 删除 | 「删除」→「确认删除 / 取消」两步（不弹 `window.confirm`，键盘可操作） | `FupanPage.tsx:259-284` |
| 钉到未来 / 取消钉住 | 编辑器里的「钉到」；已钉条目另有「取消钉住」（发 `pinnedTo:null`，**带上原文**，防宿主整体覆盖丢正文） | `FupanPage.tsx:276-281`、`src/client/fupanView.ts:465` |
| **失败必须给原因** | `writeFailTextOf(op, err)` → `新增/修改/删除/钉住失败（本次未写入，界面保留原内容）—— <宿主 message>（POST /tradewatcher/fupan/note）`，渲染在 `role="alert"` 里 | `src/client/fupanView.ts:365`、`FupanPage.tsx:185`、`:433` |
| **超限丢弃必须显示** | `writeWarningsOf(r)`（`dropped` / 写后读不到 / 隔离）逐条 `role="alert"` 显示；`droppedTextOf` 给「宿主丢弃了 N 条最旧笔记（超出上限）：<中文整句>」 | `src/client/fupanView.ts:378`、`438`、`FupanPage.tsx:440` |
| 上限口径 | 界面不硬编码任何数值：字数由 `charCountTextOf`（码点）显示，超限由宿主 `400` 拒绝并给原因；条数/体积超限由宿主丢最旧并回报 `dropped`；**页面不做本地截断** | `FupanPage.tsx:493-494`、`src/client/impl83.test.ts:466` |
| 写成功后同步 | 成功 ⇒ 重取 `GET month`（`dates[].count/hasPinned/totals` 的权威来源），重取失败时**保留**旧数据并改口说「写入已成功，但月历重取失败」 | `FupanPage.tsx:180-181`、`fupanView.ts:344` |

---

## 4. 实测（钉住 / 失败原因 / 丢弃 / 交易日三态 / 键盘）

没有 DOM 测试环境（`devDependencies` 里没有 jsdom/react），所以"实测"分两层：
**（a）纯逻辑层用宿主回包形状直接跑**（脚本 `/tmp/fupan_evidence.mts`，`node --experimental-strip-types`，下面是**原样输出**）；
**（b）产物层**：`npm run build` 后 `lib/client.js` 里能查到这些文案（见 §6 的构建输出与 §7 的产物核查）。

```
== ② 交易日 / 休市（宿主 dates[].trading / closedReason）==
10-19                             交易日 · 条数 1
10-17                             休市（周末） · 条数 0
10-05（回包没有这天）                     交易日未知 · 条数 null
整月判定                              {"kind":"known","unknownDays":0,"total":4,"reason":null}
丢 trading 后整月                     {"kind":"unknown","unknownDays":4,"total":4,"reason":"宿主回包有 4/4 天没给 trading 字段"}
丢 trading 后口径                     交易日与休市：未知 —— 宿主回包有 4/4 天没给 trading 字段（因此不按交易日显示）
calendarWhy 非 null                交易日与休市：按宿主交易日历标注（该月 4 天）；外部交易日历未覆盖 2026-10 ⇒ 按内置假日表 + 周末判定
读屏（10-17 休市）                      2026-10-17，周六，休市（周末），0 条笔记
读屏（10-27 有钉住）                     2026-10-27，周二，交易日，0 条笔记，含钉到该日的条目，已选中

== ④ 钉住标注 ==
在自己那天（10-21）                      {"text":"已钉到 2026-10-27","kind":"to"}
在目标日（10-27）                      {"text":"钉自 2026-10-21","kind":"from"}
在无关日（10-22）                      null
没钉的条目                             null
10-27 列表                          own=0 pinned=n_b

== ⑤ 超限丢弃 ==
dropped（宿主原句）                     宿主丢弃了 2 条最旧笔记（超出上限）：条数已达上限 2000 条 ⇒ 按「最久未更新」丢弃最旧的（置顶的最后才丢）
dropped（没丢）                       null
写成功后的披露                           ["宿主丢弃了 1 条最旧笔记（超出上限）：文件体积已达上限 524288 字节（512 KB）⇒ …"]

== ③ 失败原因 ==
新增失败                              新增失败（本次未写入，界面保留原内容）—— 笔记正文 4100 字 > 上限 4000 字：本接口不做静默截断（截断=改你的内容），请精简后重试（POST /tradewatcher/fupan/note）
删除失败(404)                         删除失败（本次未写入，界面保留原内容）—— 没有 id=n_x 的复盘笔记（删除前请先刷新整月视图）（POST /tradewatcher/fupan/note）
修改失败(409)                         修改失败（本次未写入，界面保留原内容）—— id=n_b 原是 2026-10-21 的笔记，与请求日期 2026-10-22 不符（按 (date, id) 定位失败）—— 想换日期请先删除再新建（POST /tradewatcher/fupan/note）

== ⑥ 路由不可用 / 读不到 ==
404 首取                            复盘月历未取到 —— HTTP 404（GET /tradewatcher/fupan/month；宿主未注册该路由时返回 404，通常是复盘行未启用）
提示                                这不是「本月暂无笔记」：月历没取到时，该月有没有笔记是「未知」的。点「重试」再取一次。
写后重取失败                            写入已成功，但月历重取失败（界面继续显示写入前的月历，数字可能少一条） —— 请求超时（15 秒未响应）（GET /tradewatcher/fupan/month；…）
读不到整句                             这一天的笔记未取到（不是「没有笔记」）—— EACCES: permission denied

—— 月历主体状态机（failed 永远压过 empty）——
首取中                               loading
404 且无数据                          failed
真的空月（total=0）                     empty
条数未知（无 totals/notes）              blank
有笔记                               grid
笔记读不到（照画网格）                       grid

== ⑦ 键盘（7 列）==
ArrowLeft                         2026-10-14（16）
ArrowRight                        2026-10-16（18）
ArrowUp                           2026-10-08（10）
ArrowDown                         2026-10-22（24）
Home                              2026-10-01（3）
End                               2026-10-31（33）
Tab                               null（交给浏览器）
a                                 null（交给浏览器）
```

**关键读数**：钉到目标日的标注是 `钉自 2026-10-21`（**来源日**，不是目标日 —— 这正是"别被读成那天写的"的落点）；
失败原因点名**动作 + 未写入 + 宿主原句 + 路由**；丢弃提示带**条数与宿主中文整句**；
交易日缺失时整月与单格**同时**降级为「未知」并给原因。

---

## 5. 断言与反例注入（`src/client/impl83.test.ts`，12 例）

| # | 判据 | 反例注入（必须让判据失败） |
| --- | --- | --- |
| ① | 第 7 个页签存在、标签「复盘」、在「工具」之后、`row==='fupan'`；八行全开 ⇒ 7 页签；`fupan` 行停用 ⇒ 按既有门控隐藏；`/rows` 不可达 ⇒ 失败放行 | 删掉页签；把复盘插到「工具」前；把 `row` 写成 `core` —— 三种注入都断言 `tabProblems` 非空 |
| ①-b | `index.tsx` 真的 import + 保活容器渲染 `FupanPage`；`KEEP_ALIVE` 含 `'fupan'` | 把 `'fupan'` 从保留名单删掉 |
| ② | 交易日/休市/未知三态；缺 `trading` ⇒ unknown；`count` 缺 ⇒ `null`；`calendarWhy` 原样 | `defaultTrading`（缺字段当交易日）、`liar`（缺字段也报 known）⇒ 判据非空 |
| ②-b | 网格 35 格 / 首格 `2026-09-28` / 31 天；`shiftYm` 跨年；`weekdayLabelOf` | 周日起头会让首格变 `2026-09-27`（断言固定值，注入即偏） |
| ③ | 写失败路径必须 `setWriteErr(writeFailTextOf(input.op, e))`；页面含 `role="alert"`；四种动作文案各自点名动作 + 未写入 | 删掉失败分支；插 `.catch(() => {})`（**锚在写调用上**：`load()` 里有同形状 `.then(`，第一版注入打错目标，已修正并写进注释） |
| ③-b | 请求体形状与宿主契约一致（`delete` 不带 `text`；`pin` 带原文） | 形状断言是 `deepEqual`，改一个字段即红 |
| ④ | 目标日必须 `钉自 <原日期>`；自己那天 `已钉到 <目标日>`；没钉的没有标注 | `() => null`（去掉标注）、只写「钉住」不写原日期 |
| ⑤ | 丢弃提示含条数与宿主原因；`count=0`/`null` ⇒ 不占版面；写成功也把丢弃带进披露 | `() => null`（静默丢） |
| ⑥ | 月历主体状态机：失败 ⇒ `failed`（**永远压过 empty**）、`total=0` 才 `empty`、`total=null` ⇒ `blank`、读不到 ⇒ 仍画网格 | `masquerade`（失败也返回 `empty` = 拿空列表冒充）；另断言失败分支/重试按钮在源码里真的存在 |
| ⑥-b | `totals` / `notes` / `dates[].count` 三级回退，都没有 ⇒ `null`（**不写 0**）；`notesUnreadable` 字符串/对象两形；隔离与 `invalidEntries` 有出口；`dayListStateOf` 四级 | 断言固定值 + `monthNoteTotalOf({dates:[{date}]})===null` |
| ⑦ | `role=grid/row/columnheader/gridcell` + `aria-selected` + `aria-label`（`cellAriaOf`）+ roving tabindex + 方向键 `moveCellFocus` + 回车/空格 + onClick | 把 `role`/`tabIndex`/`onKeyDown` 全删（只留 `onClick`）⇒ 判据非空 |
| ⑦-b | 字数按码点算；页面**不本地截断**（无 `slice(0, 4000)`）；上限说明常驻 | 断言里直接扫源码里不该出现的截断写法 |

12 例里 **9 例带反例注入**（共 21 处 `⚠ 反例` 断言），其中 **6 处**用 `assert.throws(…, /反例上/)` 形式
（与 `impl78/79` 同一手法：不仅要求"注入后判据非空"，还要求"注入后那条 `deepEqual` 真的会抛"），
保证判据不是恒真的。剩下 3 例（`③-请求体形状`、`⑥-未取到不写 0`、`⑦-b 字数/不截断`）是 `deepEqual` 型固定值断言与源码扫描。

---

## 6. 门禁

- 起点基线（本批开工前实测）：`npm run check` 全绿 —— **890 用例 × 2 时区**、构建 **73 项**（`/tmp/impl83-baseline.log`）。
- 本批之后：**同一份代码连跑两轮** `npm run check`（跑前/跑后对 8 个改动文件做 `git hash-object`，两串哈希逐字节相同 ⇒ 两轮真的是同一份代码）：

| 项 | 第一轮 | 第二轮 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | 通过 |
| `npm run test`（默认时区） | `ℹ tests 920 / ℹ pass 920 / ℹ fail 0`（17.31 s） | `ℹ tests 920 / ℹ pass 920 / ℹ fail 0`（19.26 s） |
| `npm run test`（`TZ=UTC`） | `ℹ tests 920 / ℹ pass 920 / ℹ fail 0`（23.66 s） | `ℹ tests 920 / ℹ pass 920 / ℹ fail 0`（18.29 s） |
| `npm run selftest` | 通过 | 通过 |
| `npm run build` | `built lib/index.js + lib/client.js （v0.110.0，客户端片段校验通过：73 项）` | 同左 |
| `EXIT` | `0` | `0` |

**产物核查**（`lib/client.js`，esbuild 会把非 ASCII 转义成 `\uXXXX`，所以按转义形态比对）：
`复盘（月历 + 当日笔记）`、`钉自 `、`已钉到 `、`本月暂无笔记`、`交易日未知`、`宿主丢弃了 `、`复盘月历未取到`、
`失败（本次未写入，界面保留原内容）`、`写入已成功，但月历重取失败`、`条数未知`、`钉到这一天的笔记`、`取消钉住`、
`上限由宿主把关`、`fupan/month`、`fupan/note`、`tw-fp-grid` —— **全部命中**（页面真的进了产物，不是只躺在源码里）。

用例数 890 → 920 的构成：**本报告 12 例**（`impl83.test.ts`）+ 宿主侧 18 例（`impl-fupan-host` 的 `fupan.test.ts` 与 `index.test.ts` 追加）。
**两个既有客户端断言文件按"产品变了"同步**（都在 `src/client/**`，属本批范围，不是放宽）：

| 文件 | 改动 | 理由 |
| --- | --- | --- |
| `src/client/toolsPage.test.ts` | 页签数 6→7、键集合追加 `'fupan'`、`on.visible.length` 6→7、`off.visible.length` 5→6、失败放行 6→7 | 产品确实多了第 7 个页签（判据强度不变：仍是"精确键集合 + 顺序"） |
| `src/client/impl78.test.ts` | `KEEP_ALIVE` 字面量断言 `['calendar','tools']` → `['calendar','tools','fupan']`，反例注入同步换锚点 | 保活名单确实扩了一项（反例仍证明"少一个就红"） |

构建锁定片段（`build.mjs` 的 73 项）**一项未动、一项未删**：本批只在 `lib/client.js` 里**新增**文案，
既有锁定串（`'当日记录'`、`'复盘'` 相关既有串等）保持原样。

---

## 7. 未做项 / 已知边界

1. **没有真实浏览器渲染验证**（本机不重启 `dsh web`、`node_modules` 里没有 react/react-dom）：
   本报告的"实测"是纯逻辑层（§4）+ 产物层（构建产物含新文案），**不是**截图级证据。
   首次装机后建议人工过一遍：月历三态颜色、窄屏（≤760px）堆叠、`Alt+M` 隐身档下的灰化。
2. **fupan 行被停用时页签会消失**（`docs/DESIGN-SUBPLUGINS.md` §3 的既有设计，宿主契约要求 `row:'fupan'`）。
   "路由不可用 ⇒ 原因 + 重试"覆盖的是行启用而路由取不到的情形。
3. **未做「从 Markdown 导入」UI**：本批宿主要求不注册 `POST /tradewatcher/fupan/import`（会破坏行归属推导），
   客户端的 `source:'import'` 只用于**显示**导入来源徽标。要做导入需先与宿主约定第三条路由的消费点。
4. **没有做日内的"自动保存草稿"**：草稿只活在页面内存里（保活保证切页不丢），刷新页面会丢 —— 如需持久化要新增 prefs 或本地存储。
5. **不提供批量操作**（整月导出 / 删除某天全部）：未在需求内，避免无谓的写接口。
6. **`dropped` 的两种形态都接受**（对象 / 数字 / 字符串数组），因为宿主契约里 `dropped.notes` 是逐条对象数组而 `reasons` 是中文整句；
   界面只显示"条数 + 原因"，不逐条列 id（避免把内部 id 摊给用户）。
