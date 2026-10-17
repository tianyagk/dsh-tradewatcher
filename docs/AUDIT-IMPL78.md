# AUDIT-IMPL78：客户端剩余 P2（10 条）与 P3（7 条）

- **实施时刻**：2026-10-17 22:00–23:10（Asia/Shanghai）
- **基线**：`a84800b`（v0.107.0，840 用例 × 2 时区 + 构建 73 项）。评审依据：`docs/REVIEW-8-CLIENT-UX.md` §P2/§P3。
- **纪律**：**未动 `build.mjs`**、未新增依赖、不 commit、不装、不动 profile、不重启 `dsh web`；实验隔离 `DSH_HOME=/tmp/q3c-*`；未手工写 `~/.dsh`。
- **并行批**：期间 `src/host/**` 与 `src/shared/{model,trendRetention}.ts` 有另一批改动（rev-perf 的 LKG/瘦身），本批**未触碰**；两处需要宿主配合的项写进 §12。

---

## 0. 结论（一行）

P2 十条 + P3 七条全部处置：**真正会"停摆/串数据/白亮"的三条**（请求超时、旧代响应、面板可见性）做成了**可执行的行为断言**，其余按"单一函数 + 源码接线 + 反例注入"钉死；两处需要宿主/锁定片段配合的（截断上限的**唯一来源**、六页签全量保活）如实写进未做项。

---

## 1. P2-1 `api.ts` 无超时 ⇒ `inFlight` 永真、行情轮询彻底停摆

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `api.ts:221` | `export const REQUEST_TIMEOUT_MS = 15_000`（所有接口共用的上限） |
| `api.ts:237-256` | 新增 `requestSignal(timeoutMs, outer?)`：超时与外部取消合并成一个 `AbortSignal`，带 `timedOut()`/`aborted()`/`clear()`（`timeoutMs<=0` 视为不超时，仅供调试/测试） |
| `api.ts:258-282` | 新增 `requestWithTimeout(path, init, timeoutMs)`：`fetch` 带 signal；超时 ⇒ `ApiError('请求超时（N 秒未响应）', 0)`，网络失败 ⇒ 原来的「网络错误」；`finally` 里 `clear()` 定时器 |
| `api.ts:295` | 生产入口 `request()` = `requestWithTimeout()`（固定 15s） |
| `useQuotes.ts:118` | `finally` **无条件**复位 `inFlight.current = false`（注释写明为什么不能在 `alive` 里复位） |

**断言与注入**：`impl78.test.ts` → `P2-1 请求超时：…`（2 条）

- 行为：`requestSignal(20)` ⇒ 有界等待后 `timedOut()/aborted()` 为真；`clear()` 之后不再超时。
- **真跑一次**：把 `globalThis.fetch` 换成"永不 resolve、只监听 abort"的桩 ⇒ `requestWithTimeout(..., 20)` 必须以 `ApiError{status:0, /请求超时/}` 拒绝，且桩必须真的收到 abort；网络拒绝 ⇒ 必须以「网络错误」拒绝（两种原因不许混）。
- **注入**：`requestSignal(0)`（旧行为：无超时）⇒ 30ms 后 `timedOut()` 仍为 false ⇒ 断言必败。

---

## 2. P2-2 旧代响应写进新集合（竞态）

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `requestGen.ts`（新增 30 行） | 纯函数 `createRequestGen()`：`next()`/`current()`/`stale(gen)` |
| `useQuotes.ts:62/69/74/114/119` | 每次 `load()` 领代次 `my`；`then` 与 `catch` 都以 `alive && !stale(my)` 为写入门槛；`key/enabled` 变化的 effect 里 `gen.next()` 开新一代 ⇒ 在途旧请求落地时整体丢弃 |

**断言与注入**：`P2-2 请求代号：…`

- 纯函数：`next()=1` 当代不 stale；`next()=2` 后 `stale(1)=true`；接线（源码）三处都在。
- **注入**：`stale` 恒 `false`（旧行为，等于只靠 `alive`，而新 effect 已把 `alive` 置 true）⇒ 断言必败。

---

## 3. P2-3 `cycleViewMode` 绕过 `setPrefs`、静默吞错

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `index.tsx:296-305` | `setPrefs` 拆成 `applyPrefs(patch): Promise<boolean>`（乐观更新 + 失败回滚 + **报原因**）/ `setPrefs`（fire-and-forget 包装） |
| `index.tsx:326-345` | `cycleViewMode` 改走 `applyPrefs({ viewMode: next })`；`false`（失败）时**不再**报"已切换"（toast 单实例，否则会把失败原因盖掉） |

**断言与注入**：`P2-3 视图档位保存：…` —— 源码断言：`applyPrefs({ viewMode: next })` 在、`api.setPrefs` 与 `() => undefined` 不在、`if (!ok) return` 在。
**注入**：换回 `api.setPrefs({ viewMode: next })` ⇒ 判据命中。

---

## 4. P2-4 `const visible = true` ⇒ 藏起来仍每 10s 取数

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `idle.ts:30-33` | 纯函数 `panelVisibleOf({documentHidden, intersecting})`：文档隐藏 **或** 本轮与视口不相交 ⇒ 不可见；`intersecting===null`（观察器不可用/还没回调）⇒ **失败放行** |
| `usePageIdle.ts:28-50` | `usePanelVisible(ref)`：订阅 `visibilitychange` + 对面板根节点挂 `IntersectionObserver` |
| `index.tsx:248-249` | `rootRef` + `const visible = usePanelVisible(rootRef)`（删掉 `const visible = true`） |
| `index.tsx:476`、`:399`、`:390` | `ref: rootRef` 挂到 `.tw-root`；`useQuoteEngine(..., visible)`、`usePageIdle(visible)` 接真实可见性 |
| `WatchlistPage.tsx:29-31/…` | 新增 `active` prop：`useMiniTrends`/`useWatchAlerts`/`useYtd` 全部接它（面板藏起来时不再空跑） |
| `index.tsx:408` | `WatchlistPage` 传 `active: visible` |

**断言与注入**：`P2-4 可见性：…` —— 纯函数四种组合；源码断言"没有 `const visible = true`"、引擎/闲置/自选页三处都接上。
**注入**：旧行为 `() => true`（恒可见）⇒ 断言必败。

---

## 5. P2-5 浮层无 `role=dialog`/焦点管理；双层 Esc 全关

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `overlay.ts`（新增 35 行） | 纯函数 `createOverlayStack()`：`push/remove/top/depth/isTop`（重复 id 不叠自己） |
| `ui.tsx:12`、`:21-51` | 模块级 `overlayStack` + `useEscapeLayer(onEscape, active)`：**只有栈顶**处理 Esc；回调放 ref、注册只一次；`active=false`（收起的下拉）**不占栈位** |
| `ui.tsx:56-140` | `Modal`：`role="dialog"` + `aria-modal` + `aria-label`；打开时聚焦第一个可聚焦元素、关闭归还焦点；**焦点陷阱**（Tab 在窗内循环，最上层 `stopPropagation`）；Esc 走层级栈 |
| `ui.tsx:460` | `MoreMenu` 改用 `useEscapeLayer(..., open)`（只在展开时占栈位） |
| `ui.tsx:476` | 菜单容器 `role="menu"` |
| `QuoteDrawer.tsx:206`、`:624` | `useEscapeLayer(onClose)`；抽屉容器 `role="dialog"` + `aria-modal` + `aria-label` |

**断言与注入**：`P2-5 层级栈：…` —— 栈语义（下层不响应、上层关掉后下层成为栈顶、重复 push 不叠）+ 源码接线（`useEscapeLayer` 只有一处 `window.addEventListener('keydown')`；Modal/抽屉都有 dialog 语义；不再有裸 Esc 监听）。
**注入**：`isTop` 恒 `true`（旧行为：每层都关）⇒ 断言必败。

---

## 6. P2-6 点击型 span/div 不可键盘

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `CalendarPage.tsx:158-196` | 事件胶囊：`role="button"` + `tabIndex=0` + `aria-label` + Enter/Space 打开当天详情（`open()` 复用，鼠标路径不变） |
| `CalendarPage.tsx:305-320` | `+N` 更多：同上 |
| `WatchlistPage.tsx:238-258` | 「异动 N」徽标：`role="button"` + `tabIndex` + `aria-expanded` + Enter/Space 切换队列 |
| `RescuePanel.tsx:914-931` | 历史回看行（div）：`role="button"` + `tabIndex` + `aria-label` + Enter/Space 打开 |

**断言与注入**：`P2-6 点击型 span/div 键盘可达（…）` —— 每处都要有 `role=button` + `tabIndex=0` + Enter/Space 的 `onKeyDown`；注入：删掉 `role: 'button'` 或换回 `e.key` 之外的事件 ⇒ 判据非空。

---

## 7. P2-7 六页签整页卸载 ⇒ 切页丢状态并重发请求

**改动**（按 Lead 建议：先只保活 `tools` + `calendar`）

| 文件:行号 | 改动 |
| --- | --- |
| `index.tsx:236` | `const KEEP_ALIVE: readonly PageKey[] = ['calendar', 'tools']`（只放"无轮询、纯本地状态"的页） |
| `index.tsx:432` | `pageEl()`：保活页返回 `null`（不重复渲染） |
| `index.tsx:443-448` | `keepAliveEl(key)`：日历/工具页组件 |
| `index.tsx:560-576` | 保活容器：始终挂载、`display:none` 切显隐（关闭即 display:none，非动画）；**只挂当前行被启用的页**（行被停用时不因保活又取数） |

**断言与注入**：`P2-7 保活：…` —— `KEEP_ALIVE` 内容、`data-keepalive` 标记、display 切换、被停用行不挂载；注入：把 `calendar` 从保活列表去掉 ⇒ 判据命中。

---

## 8. P2-8 K 线 `mousemove` 无 rAF（推断）

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `rafThrottle.ts`（新增 40 行） | `createRafCoalescer(apply, raf?, caf?)`：同帧多次 `push` 只落最后一次；`cancel()` 丢弃未落地更新；`pending()` 便于断言 |
| `kline.tsx:255-257`、`:457-459`（分时） | `onMouseMove/onMouseLeave` 走 `cursorRaf.current?.push(...)`；卸载时 `cancel()` |
| `kline.tsx:527-529`、`:722-724`（K 线） | 同上 |

**断言与注入**：`P2-8 rAF 合并：…` —— **假调度器**（注入 `raf/caf`，手动 flush）避免依赖真实帧：同帧 3 次 → 落 1 次（最新值）；`cancel()` 后不落地；源码断言"不许再直接 `setCursor`"、两图各 2 处 push。
**注入**：不合并（每次 push 立即 apply）⇒ 断言必败。

---

## 9. P2-9 `transition:width` 动 layout（并扩到 transition 扫描）

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `styles.ts:479` | `.tw-rescue-bar i{width:100%;transform-origin:left center;transition:transform .25s}`（原来 `transition:width`） |
| `RescuePanel.tsx:113`、`:124` | 条长改 `transform: scaleX(pct/100)`（视觉等价，不再触发布局） |
| `toolDetailTheme.ts:695-720` | 新增 `TRANSITION_LAYOUT_PROPS` + `transitionProblems(css)`：`transition` 里出现布局属性即判违规（纯 paint 属性放行） |
| `uiuxDiscipline.test.ts:⑤b` | 新增断言：`transitionProblems(TW_CSS) = []`、CSS 里不再有 `transition:width`、条长用 `transform`；注入 `transition:width` ⇒ 必败 |

---

## 10. P2-10 「已截断 160」把宿主常量抄进文案

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `shared/quoteLimit.ts`（新增） | `export const MAX_QUOTE_IDS = 160`（**单一来源**；文件头写明宿主/锁片段的边界） |
| `TopBar.tsx:547` | title 用 `MAX_QUOTE_IDS`（文案不再各自写数字） |
| `TopBar.tsx:552` | 徽标文案仍是字面量 `已截断 160`：锁定片段 `已截断 160` 要求的（本批不许动 `build.mjs`），由**漂移断言**盯住 |

**断言与注入**：`P2-10 截断上限：…` —— 宿主 `routes.ts` 的 `MAX_QUOTE_IDS` 必须等于共享常量（漂移即红）；徽标字面量必须等于 `已截断 ${MAX_QUOTE_IDS}`；注入：常量改 200 ⇒ 两条漂移断言都红。
**⚠ 未完成的真·单一来源**：需要 (a) 宿主 `routes.ts` 改成 `import { MAX_QUOTE_IDS } from '../shared/quoteLimit.ts'` 并删掉自己的字面量；(b) 锁定片段 `已截断 160` → `已截断 `（改 `build.mjs`）。两者都在本批权限之外，见 §12。

---

## 11. P3 七条

| 编号 | 改动（文件:行号） | 断言/注入 |
| --- | --- | --- |
| **P3-1** `--tw-warn` 从未定义 + 两种琥珀 | `styles.ts:27-30` 定义 `--tw-warn`（浅色 `#b45309`、深色 `#f0b429`、隐身档灰 `#8a8f98`）；11 处硬编码琥珀（`RescuePanel`/`TopBar`/`PortfolioPage`/`WatchlistPage`/`ui`/`CalendarPage`/`CloudMap`）改 `var(--tw-warn)`；`var(--tw-warn, #d97706)` 的 fallback 删掉 | `P3-1 警示琥珀：…`：三档都有定义、无 fallback、除 `theme.ts`（主题容器外字面量色板）与 `kline.tsx`（图表序列色板）外不再出现 `#e0a94a/#e8a33d`；注入：删深色档定义 ⇒ 必败 |
| **P3-2** 死字段 / 同字面三元 | `badgeView.ts:70-77` 删 `indexName`/`dayPnl`（从未被读取；回包字段仍在、结构类型忽略）；`PortfolioPage.tsx:1155` `diluted ? '累计已实现' : '累计已实现'` → `'累计已实现'`；相关测试入参同步 | `P3-2 …`：接口块里两个字段都没了、源码里同字面三元没了；注入：把 `dayPnl` 加回 ⇒ 判据命中 |
| **P3-3** `?? 0.02` 编造「+2%/日」 | `rescueView.ts:57-70` 新增 `calibrationHeaderOf({targetPct, horizon})`：缺失 ⇒ 「触发后对照（目标涨幅/持有期未取到）」；`RescuePanel.tsx:815` 改用它 | `P3-3 …`：缺失/正常两种文案 + 源码无 `?? 0.02`；注入：复现旧写法（会印出 +2%）⇒ 与新文案不同 |
| **P3-4** 做T `slice(0,50)` 静默截断 | `PortfolioPage.tsx:36` `DAY_TRADE_ROW_LIMIT = 50`；`:1354` 按常量切片；`:1366-1371` 超出时披露「另有 N 次未显示（本表上限 50 行）」（长解释进 title） | `P3-4 …`：常量、切片、披露句都在、无 `slice(0, 50)`；注入：退回写死 50 ⇒ 判据命中 |
| **P3-5** `?? 0` + 硬编码 9 档配色 | `breadthView.ts:132-145` 新增 `distToneOf(label)`（按**档名**判 up/flat/down）；`MarketPage.tsx:610-630` 缺档显示 `—` + `role=note` 原因（不再 `?? 0`）、色向用 `distToneOf`、条形带 `data-tone` | `P3-5 …`：纯函数五档 + 重排档名仍正确；注入：旧下标判据在重排后必然错、`?? 0` 回归 ⇒ 判据命中 |
| **P3-6** 工具目录 tablist 缺 tab 语义 | `ToolsPage.tsx:262-280` 分类按钮加 `role="tab"` + `aria-selected` + roving `tabIndex` | `P3-6 …`：role/aria-selected 在；注入：删 `role: 'tab'` ⇒ 判据命中 |

---

## 12. 门禁与验证

| 命令 | 结果 |
| --- | --- |
| `tsc --noEmit -p tsconfig.json` | exit 0 |
| `node --test "src/client/*.test.ts"` | **344 pass / 0 fail**（基线 327 + 本批 17） |
| `node --test "src/**/*.test.ts"`（本地时区） | **863 pass / 0 fail** |
| `node --test --test-concurrency=8 "src/**/*.test.ts"` ×3 | 863 pass ×3（并发下无 flake） |
| `npm run check` 第 1 轮（typecheck + 2 时区 + selftest + build） | **通过**：两轮时区各 `ℹ tests 863 / pass 863 / fail 0`；`ALL HOST CHECKS PASSED (live probes soft)`；`built lib/index.js + lib/client.js（v0.107.0，客户端片段校验通过：73 项）`；`PIPE_STATUS=0` |
| `npm run check` 第 2 轮（同一份代码复跑） | **通过**（同上四条，`PIPE_STATUS=0`） |

- **同哈希证据**：两轮前后对 `src/client/**` + `src/shared/quoteLimit.ts` + `build.mjs` 的 sha256 汇总一致 ——
  **`ef7b9185544c6c76fa5ce0a58a577076da10f82050ac334c2e0512977169cd9a`**（两轮跑的是同一份代码）。
  期间并行批仍在改 `src/host/**`，那部分不在本批哈希内（两轮的 host 用例数也含他们的新增）。

- **本批新增用例 17 条**：`src/client/impl78.test.ts`（16 条）+ `uiuxDiscipline.test.ts` 的 ⑤b（1 条）；另 `badgeView.test.ts` / `marketTimeDisplay.test.ts` 因删死字段同步了入参。
- **构建片段**：`build.mjs` 未动，仍「客户端片段校验通过：73 项」。

---

## 13. 未做项

| 项 | 原因 |
| --- | --- |
| **P2-10 的真·单一来源** | 需要宿主 `routes.ts` 改 import 共享常量 + 锁定片段 `已截断 160` → `已截断 `（改 `build.mjs`）。本批权限之外；现有**漂移断言**保证两边不同步就红 |
| **P2-7 六页签全量保活（market/watch/portfolio/cloud）** | 这四页有高频取数，必须先接 `active` 门控（本轮只给自选页接了）。按 Lead 建议先只保活 `calendar`+`tools` 验证收益 |
| **review §P2-4（流水/详情请求无序号的串数据）** | 不在本批 10 条清单内；`PortfolioPage` 的 ledger 与 `MarketPage` 的 detail 仍可能 A→B 后到覆盖。建议下批按 `requestGen` 同一范式处理 |
| **review §P2-7 的"焦点归还到触发元素"在 `QuoteDrawer`** | Modal 已做（打开聚焦 + 关闭归还 + Tab 陷阱）；抽屉只接了 Esc 层级与 dialog 语义 —— 它的触发入口是卡片/行，归还目标需要上游传 ref，留待下批 |
| **`shared/model.ts:454` 的「高（红）」注释** | 该文件正被并行批改动，避免写冲突未触碰（`host/tools.ts` 已于 IMPL-75 同步） |
