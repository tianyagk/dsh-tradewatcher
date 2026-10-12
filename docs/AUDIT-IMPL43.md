# AUDIT-IMPL43 —— 工具箱骨架：第 7 行 + 工具目录页 + 工具注册表（实现报告）

- 基线：`main` @ `f4dd719`（v0.70.0）。本报告是**实现**报告，不是审计报告（审计按惯例另开）。
- 本轮本人写入面（与任何别的成员不重叠）：
  `cordis.patch.yml`、`package.json`（只加 exports）、`locale/rows/tools/{en,zh}.json`（新）、`src/index.ts`、
  `src/client/index.tsx`、`src/client/ToolsPage.tsx`（新）、`src/client/toolRegistry.ts`（新）、
  `src/client/tools/cake.ts`（新）、`src/client/toolsNav.ts`（新）、`src/client/toolRegistry.test.ts`（新）、
  `src/client/toolsPage.test.ts`（新）、`src/index.test.ts`、`docs/AUDIT-IMPL43.md`（本文件）。
  **未触碰** `build.mjs`（零改动）、`src/host/**`（`em/selftest/sina/tencent` 当时有别人的在改内容）、`docs/DESIGN-SUBPLUGINS.md`、`README.md`、`CHANGELOG.md`。
- 纪律：未 `git commit` / `push`；未装 bundle、未动 profile、**未重启用户的 `dsh web`**；
  所有实验都在 `/tmp` 隔离环境（`/tmp/tw-iso-check` 隔离副本 + 测试内自建 `DSH_HOME=/tmp/tw-rows-*`）。

---

## 0. 结论（先看这一段）

1. **第 7 行已落地**：`tradewatcher-tools`（`dsh-tradewatcher/rows/tools`，`config: { row: tools }`），
   locale 标题 `dsh-tradewatcher-tools`（英文、纯 ASCII，匹配 `^dsh-tradewatcher(-[a-z]+)?$`），描述中文。
   与既有 6 行**同构**；core 行仍是**裸包名**（浏览器半区不变量未动，既有断言照旧看守）。
2. **页签**：`PageKey` 加 `'tools'`，标签「工具」，位置**在「日历」之后**；门控沿用 `gateTabs` ——
   `GET /tradewatcher/rows` 不含 `tools` ⇒ 该页签**不渲染**（不是灰显）。
3. **工具箱承载**：主面板内的一个页；左上角**返回按钮**回到**上一个非 tools 页签**
   （规则下沉到纯函数 `toolsNav.ts`：只有非 tools 页会被记住 + 返回目标必须当下仍可见，都没有 ⇒ 不渲染按钮）。
4. **目录页**：页标题 `工具目录` + 副标题（真实数量）+ 分类标签行（**本轮只有「全部」**）+ 搜索框
   （本地过滤，占位 `搜索工具、市场或指标`）+ **三列卡片网格**；卡片 = 标识 chip / 标题 / 一句话说明 / 页脚 `打开工具 →`。
   **不做星标**。
5. **蛋糕工具 = 注册表第一个条目，且一个工具一个文件**（`src/client/tools/cake.ts`）：
   新增工具 = **加一个文件 + 注册一行**。详情页渲染**真实结构骨架**（KPI 行 / 曲线区 / 饼图区 / 市场表 / 边界声明），
   无数据一律 `未取到` + 原因；**整份详情模型里零数字**（红线断言，见 §3 表末行）。
6. **归属判据（§2.2）**：`tools` 行的路由/工具都是**空数组**——工具箱本轮不独占任何接口，
   它只**消费** core/portfolio 已有的接口（被 ≥2 个行消费的接口一律留 core）；判据与"何时该往这个数组里加东西"写在 `src/index.ts:32-64` 的注释里。
7. **测试 478 → 491（每个时区）**，即 491 × 2 = 982 全绿；六条行为**各配一个文件级反例注入**，6/6 被抓（§4）。
   其中 ④ 第一次注入**没被抓到**（断言不敏感）⇒ 补了一条用例才抓住，过程留在 §4.1。

---

## 1. 改动点（`文件:行号`）

### 1.1 组件行（第 7 行）

| 文件 | 位置 | 改动 |
| --- | --- | --- |
| `cordis.patch.yml` | `:1`、`:12-16`、`:39`、`:73-75` | 头部由"六行形态"改"七行形态"，行清单加 `tradewatcher-tools`；profile 层按 id 关闭示例补上工具箱；insert 块尾部加第 7 行（`name: 'dsh-tradewatcher/rows/tools'` + `config: { row: tools }`） |
| `locale/rows/tools/en.json` | `:1-6`（新） | `title: "dsh-tradewatcher-tools"`、`description` 英文 |
| `locale/rows/tools/zh.json` | `:1-6`（新） | 同上 title；`description: "工具箱：工具目录页 + 各工具的详情页"`（中文） |
| `package.json` | `:27-28` | `exports` 加 `./rows/tools` 与 `./rows/tools/locale/*`（缺了 locale 就解析不到 ⇒ 标题回退成包名） |
| `src/index.ts` | `:29` | `RowId` 加 `'tools'` |
| `src/index.ts` | `:53-64` | `ROW_ROUTES.tools = []` + **归属判据注释**（§2.2：单一消费方才归该行；本行本轮一条都拿不走；何时该往里加） |
| `src/index.ts` | `:73` | `ROW_TOOLS.tools = []`（本批不带 agent 工具） |
| `src/index.ts` | `:122` | `rowOf` 认 `'tools'`（认不出会静默回退 `all` ⇒ 该行关不掉还多注册一遍） |
| `src/index.ts` | `:280` | `row === 'all'`（老单行）时把 `tools` 一并标活跃 ⇒ 老 profile 也显示工具页签 |

### 1.2 客户端：页签 / 承载 / 返回按钮

| 文件 | 位置 | 改动 |
| --- | --- | --- |
| `src/client/index.tsx` | `:3`、`:15`、`:22` | import：`useRef`、`ToolsPage`、`toolsNav` 的两个纯函数 |
| `src/client/index.tsx` | `:189`、`:191-192` | `PageKey` 加 `'tools'`；`TOOLS_PAGE` 常量（返回判据的唯一"非 tools 页"参照） |
| `src/client/index.tsx` | `:196-208` | `lastNonTools` ref + `goPage()`：**页签切换的唯一入口**（换页同时记录返回目标） |
| `src/client/index.tsx` | `:369-373` | `page === 'tools'` 分支：渲染 `ToolsPage`，`onBack` 由 `backPage` 决定（null ⇒ 不渲染按钮） |
| `src/client/index.tsx` | `:387` | `tabs` 加 `{ key: 'tools', label: '工具', …, row: 'tools' }`，**紧跟「日历」之后** |
| `src/client/index.tsx` | `:405-411` | `backPage = backTarget(lastNonTools.current, visibleTabs.map(t => t.key), TOOLS_PAGE)`（**必须过 `visibleTabs`**） |
| `src/client/index.tsx` | `:413`、`:455` | 回落 effect 与页签按钮都改走 `goPage`（否则返回目标漏记） |
| `src/client/toolsNav.ts` | `:14`、`:19`（新） | `rememberPage` / `backTarget` 两个纯函数（泛型，不依赖 React/JSX） |

### 1.3 工具箱本体

| 文件 | 位置 | 改动 |
| --- | --- | --- |
| `src/client/toolRegistry.ts` | `:20-51` | `ToolSectionSpec` / `ToolEntry` 契约（一个工具一个文件的那种形状） |
| `src/client/toolRegistry.ts` | `:54-70` | 固定文案唯一来源：`工具目录` / 搜索占位 / `打开工具 →` / `← 返回` / `← 工具目录` / `未取到` / 占位原因 / **`CATEGORY_TABS`（只有「全部」）** |
| `src/client/toolRegistry.ts` | `:78`、`:81` | `TOOL_ENTRIES = [cakeTool]`（**注册顺序 = 卡片顺序**）+ `orderEntries`（排序规则的唯一实现） |
| `src/client/toolRegistry.ts` | `:113`、`:121`、`:156`、`:175` | `matchesQuery` / `catalogModel` / `toolById` / `detailModel` |
| `src/client/tools/cake.ts` | `:14-35`（新） | **蛋糕工具**：id `cake`、chip `蛋糕`、分类 `portfolio`、五个区的结构（KPI 格子标签、市场表列头）+ 边界声明 4 条 |
| `src/client/ToolsPage.tsx` | `:42-67`（新） | 页容器：页头（返回按钮 + 标题 + 副标题）+ 目录页 / 详情页切换 |
| `src/client/ToolsPage.tsx` | `:72-138` | 目录页：分类标签行（`role=tablist`）+ 搜索框（`placeholder: model.searchPlaceholder`）+ 三列网格（`:40` 的 `GRID3 = repeat(3, minmax(0, 1fr))`）+ 卡片四字段 |
| `src/client/ToolsPage.tsx` | `:142-227` | 详情页：KPI 行 / 曲线区 / 饼图区 / 市场表 / 边界声明，全部走 `detailModel` 的 `未取到` 占位 |

### 1.4 测试

| 文件 | 位置 | 改动 |
| --- | --- | --- |
| `src/client/toolRegistry.test.ts` | `:39/58/77/89/107/113/127`（新，7 条） | ①卡片 / ②搜索 / ③分类标签 / ⑤排序 / 首个条目 / 骨架顺序 / **零数字红线** |
| `src/client/toolsPage.test.ts` | `:38/48/86/109/161`（新，5 条） | 页签位置与标签 / **⑥门控** / **④返回目标（纯函数语义 + 接线检查）** / 渲染接线 |
| `src/index.test.ts` | `:51`、`:195-221`、`:223`、`:315-331`、`:457`、`:479`、`:489` | 期望行集合加 `tools`；新增"第 7 行 tools"用例；行数 6→7 的既有断言同步（apply 次数 7→8、`ROW_ROUTES/ROW_TOOLS_FOR_TEST` 加 `tools: []`、locale 标题清单加 `tools`） |

---

## 2. 设计要点（为什么这么做）

1. **注册表与渲染分离**：页面只渲染 `catalogModel()` / `detailModel()` 的输出。断言的读数是"页面真正吃的那个模型"，
   而不是另写一份期望值——`toolsPage.test.ts:161` 另外用源码接线断言钉住"模型真的被渲染了"（`:88-135` 的 `renderWiringProblems`）。
2. **一个工具一个文件**：工具文件只 `import type` 注册表的类型（类型导入会被擦除）⇒ **没有运行时循环 import**；
   占位原因（"数据源下一批接入"）由注册表一侧补默认值（`toolRegistry.ts:24-28` 的注释说明了这个取舍）。
3. **排序规则只有一条**：注册顺序。`orderEntries` 是它的唯一实现（identity），测试用一个"名字排最前"的新条目来证明
   新增工具不会让既有卡片挪位。
4. **返回按钮的两条规则**下沉到 `toolsNav.ts`（纯函数、可断言）：
   只有非 tools 页会被记住；返回目标必须**当下仍可见**（行被停用 ⇒ 页签已不在条上，不能返回过去）；都没有 ⇒ `null`（不渲染按钮）。
   `index.tsx` 只负责"把当前可见页签喂进去"。
5. **主题**：页面一律用 `var(--tw-*)` 与既有 class（`.tw-panel` / `.tw-tab` / `.tw-hint` / `.tw-empty`），源码里**没有**硬编码深浅色值。
6. **时区**：本批不产生任何时间文本（没有数据源），故不涉及 `Asia/Shanghai` 格式化；下一批接数据时按 `marketTime.ts` 的规矩办
   （那一条已被 v0.70.0 的 TZ 缺陷教训钉住）。
7. **不额外取数**：`engineIds.pageExtraIds` 对未知页返回 `[]` ⇒ 工具箱页不会让行情引擎多请求任何标的（有意的，下一批接数据时再按页面加）。

---

## 3. 断言清单（每条都锚真实实现/真结构）

| # | 断言 | 位置 | 抓什么 |
| --- | --- | --- | --- |
| ① | 目录页模型有 **1 张卡片**且字段（chip/标题/说明/入口文案）非空 | `toolRegistry.test.ts:39` | 卡片缺字段、空串、文案没走唯一来源 |
| ② | 搜索**本地过滤**生效：命中 / 不命中 / 空态 / 大小写 / 多词 AND | `toolRegistry.test.ts:58` | 搜索框假接线、忽略 query、大小写敏感、AND 变 OR |
| ③ | 分类标签行**只有「全部」** | `toolRegistry.test.ts:77` | 提前加标签、把条目的 category 当标签渲染 |
| ⑤ | 注册表**新增条目**不改既有卡片顺序（顺序 = 注册顺序） | `toolRegistry.test.ts:89` | 有人偷偷改成按名称/分类排序 |
| ⑥ | 门控：`rows` 含 `tools` ⇒ 渲染；**不含 ⇒ 不渲染**；当前页被停用 ⇒ 回落 | `toolsPage.test.ts:48`（+ 宿主侧 `index.test.ts:195`） | 页签归属行写错、门控被绕过、白屏 |
| ④ | 返回按钮回到**上一个非 tools 页签**；无可用页 ⇒ 不渲染；接线四点齐全 | `toolsPage.test.ts:86`（纯函数）+ `:109`（接线） | 返回目标错/过期/指向工具页自己；页签点击漏记；`backTarget` 没接 `visibleTabs` |
| 补 | 页签位置/标签/归属：`['watch','portfolio','market','cloud','calendar','tools']` | `toolsPage.test.ts:38` | 工具箱没加、加错位置、归属行写错 |
| 补 | 渲染接线：三列网格、卡片四字段、五个区、空态跨列、无 `onBack` 不渲染按钮 | `toolsPage.test.ts:161` | 模型有了但页面没渲染 |
| 红线 | 无数据 = `未取到` + 原因；**整份详情模型无数字** | `toolRegistry.test.ts:127` | 用 0/编造值顶替缺失 |

> 说明：`toolsPage.test.ts:38/86/109/161` 与 `toolRegistry.test.ts:127` 都自带**源码级注入**（改字符串后重跑同一个判据），
> 因此"断言非恒真"这件事在该文件内部就有证据；§4 的文件级注入是**第二层**（真的把行为关掉，跑真测试）。

---

## 4. 反例注入证据（文件级：关掉行为 ⇒ 断言必须失败，随后恢复）

脚本：`/tmp/tools-inject.py`（不进仓库）。每条注入都是**真改工作区源码** → 跑对应测试文件 → 记录 exit code 与首条断言 → 立刻还原并校验 sha256。

| 注入 | 文件 | 结果 | 首条失败断言 |
| --- | --- | --- | --- |
| ① 卡片说明被写空 | `src/client/tools/cake.ts` | exit=1（pass 6 / fail 1） | `卡片字段 blurb 不许为空` |
| ② 搜索过滤被关掉（`catalogModel` 不再按 query 筛） | `src/client/toolRegistry.ts` | exit=1（6/1） | `搜"蛋糕"只该剩蛋糕工具` |
| ③ 分类标签行多出「持仓」 | `src/client/toolRegistry.ts` | exit=1（6/1） | `本批分类标签行只允许「全部」` |
| ④ 返回目标不再排除 tools | `src/client/toolsNav.ts` | exit=1（4/1） | `返回目标永远不许是 tools 页本身` |
| ⑤ 排序规则改成按名称排 | `src/client/toolRegistry.ts` | exit=1（6/1） | `orderEntries 不许重排` |
| ⑥ 工具页签归属行改成 `core` | `src/client/index.tsx` | exit=1（3/2） | `工具箱页签归属 tools 行（门控靠它）` |

汇总（原始输出见 `/tmp/tools-inject-evidence.txt`）：

```
=== 汇总（每条都必须 exit!=0）
  ✅ ① 卡片字段被写空（说明为空串） → exit=1
  ✅ ② 搜索过滤被关掉（catalogModel 不再按 query 筛） → exit=1
  ✅ ③ 分类标签行多出「持仓」一个 → exit=1
  ✅ ④ 返回目标不再排除 tools（返回按钮会把页签切回工具箱自己） → exit=1
  ✅ ⑤ 排序规则改成按名称排（新增条目会插到最前） → exit=1
  ✅ ⑥ 工具页签归属行改成 core（rows 不含 tools 也会渲染） → exit=1
[恢复后] src/client/toolRegistry.test.ts exit=0 ℹ pass 7 ℹ fail 0
[恢复后] src/client/toolsPage.test.ts exit=0 ℹ pass 5 ℹ fail 0
sha256 全部一致（工作区已恢复）
```

### 4.1 ④ 的第一次注入**没被抓到**（如实记录）

第一次跑时 ④ 的结果是 `exit=0`（`pass 5 / fail 0`）——原断言只覆盖"上一页是普通页"的路径，
`toolsNav.ts` 里那句 `last !== toolsKey` 守卫**从未被执行到**（`rememberPage` 正常不会产出 tools 作为"上一页"）。
⇒ 修断言（不是修实现）：补一条"调用方误传 `last = 'tools'`"的用例，要求返回目标**永远不是 tools 页本身**、并走回落。
补完后同一条注入 `exit=1`，失败在 `返回目标永远不许是 tools 页本身`。
这正是"反例注入"要抓的东西：**断言不敏感**（恒真）比实现错更难发现。

---

## 5. `npm run check`

### 5.1 本改动集的结果：**exit=0，全绿**

```
ℹ tests 491 / ℹ pass 491 / ℹ fail 0        （默认时区）
ℹ tests 491 / ℹ pass 491 / ℹ fail 0        （TZ=UTC）
ALL HOST CHECKS PASSED (live probes soft)
built lib/index.js + lib/client.js （v0.70.0，客户端片段校验通过：73 项）
```

末尾三行（`/tmp/tools-iso-check`，非空行）：

```
> dsh-tradewatcher@0.70.0 build
> node build.mjs
built lib/index.js + lib/client.js （v0.70.0，客户端片段校验通过：73 项）
```

- 基线**本人实测复核**：另建一个干净副本（`git checkout -- . && git clean -fd` = HEAD `f4dd719`）跑 `npm test`
  ⇒ **478 / 时区**（两遍都绿）。该副本首跑时 `TZ=UTC` 那一遍出现过 **1 条失败**，**未复现**（随后同一命令连跑两次全绿 ⇒ 判定为并行负载下的抖动，记在这里以免被当成"基线本来就红"）。
  本批 **491 / 时区**（+13：`toolRegistry.test.ts` 7 条、`toolsPage.test.ts` 5 条、`index.test.ts` 1 条）。
- `build.mjs` **零改动** ⇒ 构建片段校验仍是 73 项（没有新增锁定片段；本批的新 UI 文案不依赖片段表）。
- 产物层核对（`lib/client.js` 里真的出现这批新片段）：`工具目录` / `搜索工具、市场或指标` / `打开工具 →` / `未取到` /
  `数据源下一批接入（本轮只搭结构骨架）` / `持仓蛋糕` / `KPI 行` / `边界声明` / `← 返回` / `工具` —— 10/10 命中。
- **manifest 用真 YAML 解析器验过**（借 harness 自带的 `yaml` 包，只读）：
  `insert` 行数 = **7**，`tradewatcher-core→core | -calendar→calendar | -watchlist→watchlist | -portfolio→portfolio | -market→market | -cloudmap→cloudmap | -tools→tools`。
- **locale 走 Node 解析链验过**（隔离目录 `/tmp/tools-resolve` 里给包名做 symlink，模拟 profile 的 `node_modules` 形态）：
  `dsh-tradewatcher/rows/tools/locale/en.json` ⇒ `locale/rows/tools/en.json`，`meta.title = "dsh-tradewatcher-tools"`；
  `…/zh.json` ⇒ 中文描述；`dsh-tradewatcher/rows/tools` ⇒ `lib/index.js`（宿主入口）。
- ⚠ **工作区的 `lib/` 没动**（仍是 17:45 的 v0.70.0 产物）：本批**没有**在工作区执行 build（本轮的构建只发生在隔离副本里），
  所以**用户当前运行的实例不受本批影响**；要让它生效需要 Lead 统一安排"构建 + 重启 `dsh web`"（本批刻意不做）。

### 5.2 ⚠ 工作区（共享目录）当时的 `check` 不绿：**不是本批改动**

并行工作期间，工作区里 `src/host/em.ts`、`src/host/selftest.ts`、`src/host/sina.ts`、`src/host/tencent.ts` 有**别人的未提交改动**
（本人未触碰这四个文件）。在工作区直接跑 `npm run check` 会红在：

```
✖ src/host/markdownScan.test.ts:57  用户可见字符串里不许出现 Markdown **
  host/selftest.ts:516  '国际指数**不得**再落到新浪（int_* 族整体停用：陈旧快照 + 无时间戳）'
  host/selftest.ts:527  ok(parsed.int_nikkei === undefined, 'int_* 行必须被**忽略' …)
```

⇒ 该失败**只出现在别人的文件里**（我只读证据、没有改它）。为了给本改动集一份干净的绿灯证据，
本人在 `/tmp/tw-iso-check` 建了隔离副本：**本批全部改动 + 那四个 host 文件回退到 HEAD 基线**，在那里跑完整 `npm run check` = **exit=0**（§5.1）。
两个结论因此可以同时成立：**本改动集全绿**；**工作区当时的红是并行改动造成的，需要在那边收口**。

**同一天在工作区的收尾复核**（本批改动 + 别人的在改文件同时在树里）：

- `node_modules/.bin/tsc --noEmit -p tsconfig.json` ⇒ **无输出**（工作区当前类型检查干净）；
- 本批相关的三个测试文件（`toolRegistry.test.ts` + `toolsPage.test.ts` + `index.test.ts`）⇒ `tests 29 / pass 29 / fail 0`；
- 隔离副本保留在 `/tmp/tw-iso-check`（122M，供 Lead 复核；用完可直接 `rm -rf`），注入脚本与原始输出在
  `/tmp/tools-inject.py`、`/tmp/tools-inject-evidence.txt`、`/tmp/tools-iso-check.log`。

---

## 6. 未做项（明确交代）

1. **数据源没接**（本批就是骨架）：KPI 行 / 曲线区 / 饼图区 / 市场表全部只渲染结构与 `未取到` 占位；
   蛋糕工具的真实取数（持仓分层、市值、占比、当日涨跌、净值曲线）留给下一批。
2. **浏览器半区没有实机验证**：约束是"不装 bundle、不动 profile、不重启用户的 `dsh web`"，因此**没有**放一个临时实例去肉眼确认
   "工具页签真的出现在浏览器里"。替代证据是四层：manifest 行（`cordis.patch.yml:73-75`）+ locale（`locale/rows/tools/*`）+
   宿主行注册与 `/rows` 活跃行（`src/index.test.ts:195-221`）+ 客户端门控与产物片段（`toolsPage.test.ts:48`、`lib/client.js` 10/10 命中）。
   ⇒ 需要"实机确认"时必须由 Lead 安排一次隔离实例（本批不做）。
3. **没有 DOM 测试环境**（devDependencies 里没有 jsdom / testing-library）⇒ 渲染层用"读源码接线断言"代替真实渲染断言
   （`toolsPage.test.ts:88-135`、`:161`）。代价：**样式/像素级问题抓不到**（本批也不改样式表，故影响小）。
4. **分类标签行只有「全部」**（按用户要求）：条目自己的 `category` 字段已经落库并通过 `catalogModel` 的分类过滤生效，
   但**标签行与切换 UI** 下一批再加（加的时候只需改 `CATEGORY_TABS`，断言 ③ 会随之更新）。
5. **未改发布/文档面**：版本号、`CHANGELOG.md`、`README.md`、`docs/DESIGN-SUBPLUGINS.md` 的 §2.1/§2.2 表格（该表还没有 `tools` 行）
   都没动 —— 避免与别人同一文件冲突，也避免抢发布动作。发布时建议：版本号由 Lead 统一升，§2.1 表格补一行
   「`tools`｜**无**独占路由/工具（本轮）｜工具箱：工具目录 + 工具详情；只贡献 `activeRows`」。
6. **`package.json` 只加了 exports**（`./rows/tools`、`./rows/tools/locale/*`）——`files` 里已有 `locale`，无需再改。
7. 工具详情页**没有**"星标/收藏"（用户明确不做）；也没有二级导航（目录 ↔ 详情用页内返回即可）。
