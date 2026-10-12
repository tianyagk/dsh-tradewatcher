# AUDIT-IMPL37 —— 云图只留第三方站点（删自绘 + 段控）＋ `/board` 归属改到 market 行

- 基线：`main` @ `9dd132d`（v0.61.0），`npm run check` = 414 × 2 全绿
- 本轮结果：`npm run check` = **414 × 2 全绿**（条数持平见 §4：删 4 条 + 加 4 条）
- `build.mjs` **我零改动**（两条锁定片段由 lead 解锁，见 §1.1）；未装 bundle / 未动 profile / 未 commit / 未重启
- 方法：先**逐条列清单**（含 grep 证据）→ 改 → **锚真实源码/结构**的断言（非恒真，含反例注入）→
  真组件 + 真 CSS + 真事件/真计时器在无头 Chromium 里跑**三态**

---

## 1. 删除清单（含 grep 证据）

### 1.1 卡点（开工前先报 lead，已由 lead 解锁）

`build.mjs` 的片段表锁了 **75 条**，其中两条**只存在于要删的文件里**：

| 锁定片段 | 唯一来源 | 后果 |
|---|---|---|
| `行业热力（自绘）` | `src/client/IndustryHeatmap.tsx:60` | 删文件 ⇒ 片段校验失败 |
| `面积＝成交额` | `src/client/IndustryHeatmap.tsx:62`（口径段） | 同上 |

实测失败信息（临时实验，已 `git checkout` 完全恢复）：

```
构建校验失败：lib/client.js 缺少以下 UI 片段 —— 行业热力（自绘） / 面积＝成交额
```

**系统核对**（把 75 条逐条与该文件比对）：只有这 2 条在删除后无别处来源；另有 1 条 `板块` 也出现在该文件，
但 `shared/model.ts` / `RescuePanel.tsx` / `sort.test.ts` 仍持有 ⇒ 不受影响。
**处置**：lead 删掉那 2 条并留注释（片段表锁的是"自绘视图存在"，与下线目标直接冲突）⇒ **现为 73 条**（我已复核：
`REQUIRED_CLIENT_SNIPPETS` 计数 = 73、两条字样已不在表里）。本轮**未改 `build.mjs`**。

### 1.2 删除的文件

| 文件 | 为什么删 |
|---|---|
| `src/client/IndustryHeatmap.tsx` | 内建行业热力自绘视图（用户要求下线的那一套）：取数（`api.board('industry','amount',1)`）、派生（`squarify` 分块）、口径段、空态/降级文案全在其中 |
| `src/client/treemap.ts` | `squarify` 的唯一生产消费者是上面那个视图 ⇒ 删后成死码（lead 选 A：一并清理） |
| `src/client/treemap.test.ts` | 为死码维护的测试（−4 条） |

残留 import 复核（删后立即做）：`grep -rn "IndustryHeatmap\|treemap\|squarify" src/` ⇒ **只剩注释**，`tsc --noEmit` 通过。

### 1.3 改动的文件

| 文件 | 改动 |
|---|---|
| `src/client/CloudMap.tsx` | 删 `IndustryHeatmap` import、`source` 状态、整个内建分支（头部/口径段/空态降级文案）、上下两处 `自绘 / 第三方站点` 段控 + 那句 hint；删随之无用的 `useWidth`/`hostRef`/`width`。**保留**第三方分支、iframe、三态与 timeout 占位，**未新增任何文案** |
| `src/client/index.tsx` | 一行注释改口径：`redUp` 仍传给云图，但现在只用于"色义相反时的徽标" |
| `src/client/NoteIcon.tsx` | 与本次功能**无关**的一处用词（"比自绘 div+keydown 更可靠"）改为"比手写 div+keydown 更可靠" —— 为了让"`src/**` 无该字样"这条断言**不留例外** |
| `src/index.ts` | `ROW_ROUTES.market` 收进 `/tradewatcher/board`（`cloudmap` 仍是空数组）；注释块按新判据重写（含"v0.62.0 由 core 改归 market"的理由） |
| `src/index.test.ts` | 四处断言同步（market 独占清单、`core` 不再持有 `/board`、`OWNER_BY_CALLERS`、`FUNCTION_OWNED_PATHS`）+ 新增 2 条测试 |
| `docs/DESIGN-SUBPLUGINS.md` | §2.1 `market` 行路由与说明、§2.2 表格 `/board` 那行（2 个消费方 ⇒ 1 个）、§2.2 动机段（作废的半条改历史说明） |
| `docs/ROADMAP.md` | P2-5 那一行加一句"v0.62.0 已下线"（**1 行**）—— 否则路线图会继续宣称"云图页默认自绘"。`docs/DECISIONS.md` 与历史 `CHANGELOG` 条目是**历史记录**（含当时的代码摘录），按惯例不改 |

## 2. `/board` 归属复核（我自己 grep 的，不只看 lead 的结论）

| 时刻 | 调用方（实测 `file:line`） | 消费行数 | 判据结果 |
|---|---|---|---|
| 删除前 | `MarketPage.tsx:84`（market 行）＋ `IndustryHeatmap.tsx:30`（只被 `CloudMap.tsx:125` 渲染 = cloudmap 行） | 2 | core |
| **删除后** | **只有** `MarketPage.tsx:84` | 1 | **market** |

- 判据来自设计文档 §2.2：**被 ≥2 个行消费 ⇒ core；单一消费方 ⇒ 该行** ⇒ 结论与 lead 一致。
- **其它路由/工具是否也只被自绘消费**：`IndustryHeatmap.tsx` 的 API 面**只有** `api.board` 一处调用，
  不涉及任何 agent 工具、不涉及其它 host 路由 ⇒ **没有第二条要重定归属的路由/工具**。
- `src/index.ts` 实现：`market: ['/tradewatcher/breadth', '/tradewatcher/rescue', '/tradewatcher/board']`，
  `cloudmap: []` 不变（云图行**无 host 路由**，第三方 iframe 是纯客户端 ⇒ 关它也不影响 `/board`）。

## 3. 断言与反例证据

### 3.1 `src/client/cloudMap.test.ts`（新建，2 条）

- **① 彻底移除**：遍历 `src/**/*.{ts,tsx}`，除**本文件自身**外任何文件出现 `IndustryHeatmap` / `自绘` 即失败；
  另断言 `CloudMap.tsx` 无 `tw-seg` / `setSource` / `source === 'self'` 等段控痕迹；
  三个被删文件必须 `ENOENT`。
  - **扫描边界（写进报告，按要求）**：排除**本文件自身**（它必须写出那两个字样才能 grep，否则自己命中自己、断言恒假）；
    排除 `docs/**` 与 `CHANGELOG.md`（它们要能描述"这次删了什么"）；**不排除任何实现文件**
    —— `CloudMap.tsx`、`src/index.ts`、`src/index.test.ts`、`NoteIcon.tsx` 全在扫描范围内（这也是我改掉
    `NoteIcon.tsx` 里那处无关用词的原因）。`title`/`aria-label` 也在范围内（扫的是整份文件文本）。
  - **反例注入 3 条**：把内建视图标题加回渲染位置 ⇒ `segmentViolations` 非空（并 `assert.throws` 证明）；
    把段控加回 ⇒ 非空；**把字样放进另一个实现文件**（`src/index.ts`）⇒ 全仓扫描非空
    ⇒ 证明"扫描确实覆盖实现文件"而不是只看一个文件。
- **② 第三方保留**：三态类型与三态可见文案（`加载中…` / `已完成` / `加载超时`）逐条锚源码；
  timeout 占位必须给**域名**（`无法在 ${TIMEOUT_MS / 1000} 秒内加载 ${CLOUD_MAP_HOST}`）与**最后成功时间**
  （`最后成功加载：${lastOkText}`）；无记录时文案是 `尚无成功记录`（不是 0/空）；
  iframe 仍在、`src` 指向第三方源站、超时后 `display:none`；超时阈值仍 8000ms、源站常量仍是同一处；
  **面板头 hint 只能剩那一句**（`面积=流通市值 · 双击看K线`）⇒ 反证"没有新增常驻可见文案"。
- ⚠ 一处被我**改正**的写法：最初我断言"全仓不许再引用 `tw-seg`"，但 `tw-seg` 是**通用**段控样式类，
  别处（日历/大盘/持仓/SortBar）仍在合法使用 ⇒ 改为"`CloudMap` 不许用它 + 该类必须仍被别处使用 + `styles.ts` 定义仍在"
  （否则就成了"为了删一个控件把公共样式拆了"）。

### 3.2 `src/index.test.ts`（+2 条，另同步 4 处旧断言）

- **`/board` 归属**：`boardOwnershipProblems(src)` **从 `src/index.ts` 源码文本里抽**各行的路由数组（不另抄一份），
  断言真实源码为空；反例 ①（从 market 撤掉 `/board` = 回 core 的形态）⇒ 非空 + `assert.throws`；
  反例 ②（塞回 `cloudmap: []`）⇒ 非空。
- **运行期门控**：只 apply `core` ⇒ `core.routes` **不含** `/tradewatcher/board`（⇒ 走 404）；
  apply `core + market` ⇒ 含；apply `core + cloudmap`（只开云图）⇒ **仍不含**（云图页不再消费它）；
  并断言 `ROW_ROUTES_FOR_TEST.cloudmap === []`（云图行没有 host 路由，第三方 iframe 与行开关无关）。
- 旧断言同步：market 独占清单加 `/board`；`core.routes.includes('/tradewatcher/board')` 从 `true` 改 `false`；
  `OWNER_BY_CALLERS['/tradewatcher/board']` 从 `core` 改 `market`（该循环会自动断言"目标行有、core 没有"）；
  `FUNCTION_OWNED_PATHS` 加 `/tradewatcher/board`（core 不许注册任何功能行独占路径）；
  "core 必须保住"清单里**移除** `/board`（两处都留着会自相矛盾），并加一条 `false` 断言。

### 3.3 浏览器实测（真组件 + 真 CSS + 真事件/真计时器）

用 `react-dom/client` 真渲染（不是静态标记）⇒ `onLoad`、计时器都是真的：

| 态 | 观察值 |
|---|---|
| **loading** | `data-state="loading"`、文案 `加载中…`、占位为 `null`、iframe `display:block`（587px）、按钮 = `重新加载` |
| **loaded** | `data-state="loaded"`、文案 `已完成`、iframe `display:block`（真网络加载 52etf.site 成功；`onLoad` 写入 `localStorage.tw.cloudmap.lastOk` = 当刻） |
| **timeout** | `data-state="timeout"`、文案 `加载超时`、占位 = `无法在 8 秒内加载 52etf.site \| …最后成功加载：10-11 14:30`（**域名 + 最后成功时间**）、iframe `display:none` 且高度 0、按钮 = `重试` |

三态共同读数：`.tw-seg` 数量 **0**、`.tw-drawer-body svg` 数量 **0**（自绘视图没了）、
DOM 里任何 `title`/文本都**不匹配** `行业热力|自绘`。截图 `cloud-loaded.png` 目视：头部只剩
`大盘云图 · A股热力图（52etf.site）` + `面积=流通市值 · 双击看K线` + 色义徽标 + `已完成` + 两个按钮，下面是第三方页面本身。

> **顺带发现（既有行为，本轮不动）**：`iframe` 的 `onLoad` **在错误页上也会触发** —— 把域名整段阻断后，
> 浏览器仍派发 `load`，组件于是标成"已完成"。这是**修之前就有的**"存活判定"弱点（本轮要求"三态不变"⇒ 未改），
> 但值得记一笔：状态徽标显示"已完成"不等于内容真的取到了。要做"真存活判定"得靠内容侧信号，另开任务。

## 4. 测试条数变化

| | 条数（每时区） |
|---|---|
| 基线 `9dd132d` | 414 |
| 删 `treemap.test.ts` | −4 |
| 新增 `cloudMap.test.ts`（2 条） | +2 |
| 新增 `index.test.ts`（2 条） | +2 |
| 本轮之后 | **414**（持平） |

`npm run check` 末尾三行：

```
ℹ tests 414
ℹ pass 414
ℹ fail 0
```

（两次各 414：默认时区 + `TZ=UTC`；随后 `ALL HOST CHECKS PASSED (live probes soft)` 与
`built lib/index.js + lib/client.js （v0.61.0，客户端片段校验通过：73 项）` —— **73 项**即 lead 解锁后的新基线。）

## 5. 顺带修掉一个**先于本轮就存在**的测试竞态（不修则验收不可能全绿）

**现象**：`src/index.test.ts` 的 `task-6：六行装载（manifest 驱动）` 断言 `__kernelStats.starts === 1` 时拿到 `0`。

**归因（先证明与本轮改动无关）**：用 `git worktree add /tmp/twbase HEAD` 取出**基线 `9dd132d`（不含我任何改动）**，
同一套测试跑三遍 ⇒ **3/3 全红**（`tests 414 / pass 413 / fail 1`，失败项就是 task-6）。
另外：该测试**单独跑这个文件**时，基线与改动后都失败 ⇒ 失败与我的改动无关，是**既有的时序假设**。

**根因**：`applyCore` 里的 `store.init()` 是**真异步**（在临时 `DSH_HOME` 上做文件 IO），
而测试用"**固定睡 50ms 就当 init 落定**"（`const tick = () => sleep(50)`）⇒ 机器负载一高就假失败。
实验（仍在 throwaway worktree 里）：把 tick 从 50ms 放大到 600ms ⇒ 基线 **414/414 绿、连跑 2 次全绿**。

**修法（只动测试，最小改动）**：在 task-6 里引入**有界**条件等待器
`waitFor(cond, ms = 5000)`，把"等 init 落定"那一处从 `await tick()` 改成 `await waitFor(() => __kernelStats.starts === 1)`；
其余各处（"再注册一轮也不许重跑"等）保持原样 —— 那些是"不许再涨"，睡一小会儿即可，涨了就是 bug。

**反例注入（证明等待器不会把失败等成通过）**：在 throwaway worktree 里注入"采样器根本不启动"
（注释掉 `__kernelStats.starts += 1` 与 `k.rescue.start()`）⇒ 断言**仍然失败**（该文件 7 条红，含 task-6 的 `只跑一次`），
即 5 秒上限到点后照样红，不会因为"等一等"变成绿。

**修后**：`npm run check` = **414 × 2 全绿**，且**连跑 3 次**全绿；`built … （客户端片段校验通过：73 项）`。

## 6. 未做项

1. **`build.mjs` 我没动**（两条片段的解锁由 lead 完成）；`git diff -- build.mjs` 只有 lead 那一处改动。
2. **`iframe onLoad` 假阳性**（§3.3 末）未修：本轮明确要求第三方三态行为不变。
3. **`docs/DESIGN-SUBPLUGINS.md:55`** 那段"功能行（可关）"总览仍写着 `market` 含 `/anomaly` `/industries`
   —— 这是 task-60 之后**就已存在**的陈述（§2.1/§2.2 才是落地后的权威表）；本轮只负责 `/board`，
   没顺手改它以免把两件事混在一个提交里。**建议单开一次小清理**（§2 的总览与 §2.1/§2.2 对齐）。
4. 版本号 `package.json` 未动（发布由 lead 做）；未做真页面截图（GUI 需带鉴权 URL），
   用真组件真渲染 + 真 CSS 的无头 Chromium 替代（§3.3，三类态读数齐全）。
5. **`task-6` 的等待窗口我按"等条件"改了**（§5）：这是**既有**测试的时序假设问题，不是本任务的功能改动；
   若 lead 更愿意把这类测试基建改动单独成一个提交，可以把 `src/index.test.ts` 里那个 `waitFor` 单独摘出来 —— 但那样
   本轮就无法给出"全绿"的验收（基线当前是 3/3 红）。
