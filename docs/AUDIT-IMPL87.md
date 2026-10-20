# AUDIT-IMPL87 — 复盘页联动持仓交易记录（**只读展示**，客户端侧）

> **本文件是当批（v0.114.0 开发期）的实测记录，不是设计稿**：所有读数来自本轮真实运行，
> 命令与输出摘要在文末。行号/用例数会随代码演进漂移，**以代码与 `npm run check` 读数为准**。
> 宿主侧（`GET /tradewatcher/fupan/trades`、路由注册、四处镜像）由 `impl-fp-trades-host` 交付，
> 本文件只覆盖 `src/client/**` + 本文档。

## 1. 结论（一行）

复盘页已接入「当日交易（只读）」：**月历标记只用形状**（`●` 笔记 / `▲n` 交易 / 并存 `● ▲3`）、
**当日汇总只有买卖笔数**、**当日盈亏只给数值**、**缺值一律 `未取到`（不写 0）**、
**超 500 笔如实披露**、**点某笔 → 持仓页「交易流水」+ 静态高亮（纯内存态）**、
**全页不接隐身档**；`npm run check` **两轮全绿**（`typecheck` + 用例 ×2 时区 + `selftest` + **构建 73 项**）。
`build.mjs` 未改、`src/host/**` 未改、零新依赖。

## 2. 交付清单（只碰客户端/文档）

| 文件 | 变更 | 说明 |
| --- | --- | --- |
| `src/client/fupanTrades.ts` | **新增**（约 205 行） | 纯逻辑：标记/图例、笔数归一（含 `readFailed`）、汇总行、当日盈亏、逐笔行文本、截断披露 |
| `src/client/tradeJump.ts` | **新增**（44 行） | 「复盘 → 持仓流水」的**内存态**跳转请求（请求 / 取走一次 / 订阅），不碰 URL/偏好/存储/网络 |
| `src/client/api.ts` | +75 行 | 线缆契约 `FupanTradeDto` / `FupanTradesPayload`；`api.fupanTrades(day)`；`FupanDateDto.trades?`（宿主哪天带上就整月画 `▲n`） |
| `src/client/FupanPage.tsx` | +约 110 行 | 月历标记 + 月历下方图例 + 当日交易块（汇总/盈亏/逐笔/截断/失败）+ 点某笔发跳转请求 + 按日惰性取数 |
| `src/client/fupanView.ts` | +6 行 | `FupanCellInfo.trades?` 并进读屏文本（`N 笔交易`）；未知/失败**不写** |
| `src/client/PortfolioPage.tsx` | +约 35 行 | 挂载时 `takeTradeFocus()` 取走高亮目标 → 直接开「交易流水」（`mode:'all'`）+ 命中行静态底色条 |
| `src/client/index.tsx` | +9 行 | 订阅跳转请求 → `goPage('portfolio')`（**唯一**切页入口，不新增路由） |
| `src/client/styles.ts` | +14/−1 行 | `.tw-fp-marks`（删掉旧的数字角标 `.tw-fp-count`）、`.tw-fp-trades*` / `.tw-fp-trade`、`.tw-wrow[data-focus=true]` |
| `src/client/impl87.test.ts` | **新增**（11 例） | 八条判据各配反例注入 + 2 条线缆/接线用例 |
| `docs/AUDIT-IMPL87.md` | **新增** | 本文件 |

**未动**：`build.mjs`、`src/host/**`、`src/index.ts`（行注册四处归宿主那一路）、profile、`~/.dsh`。

## 3. ① 月历格子：只用形状

| 口径 | 实现（单一来源） | 位置 |
| --- | --- | --- |
| 笔记 = 实心圆点 | `noteMarkOf(count)` → `●`（`count > 0` 才画；条数本身不再进格子） | `fupanTrades.ts:37` |
| 交易 = 实心三角 + 笔数 | `tradeMarkOf(n)` → `▲3`（`n > 0` 才画） | `fupanTrades.ts:48` |
| 并存并排 | `dayMarksTextOf` 用**一个空格**拼：`● ▲3` | `fupanTrades.ts:55` |
| 月历下方一行图例 | `● 笔记　▲ 交易笔数`（`FUPAN_TRADE_LEGEND`，页面 map 渲染） | `fupanTrades.ts:31` / `FupanPage.tsx:522` |
| 格子接线 | `const ci = { ...cellInfoOf(...), trades: tradeCountIn(date) }` → `dayMarksTextOf` | `FupanPage.tsx:472-473` |
| 渲染节点 | `<div class="tw-fp-marks" aria-hidden="true">`（读屏文本已含条数/笔数，不重复读） | `FupanPage.tsx:510` |

**不用颜色区分**：标记节点的 class 里一个颜色都不挂（`.tw-fp-marks` 只用 `var(--tw-text)`），
判据 `markNodeProblems` 直接扫那一行源码里的 `color|--tw-up|--tw-down|dirClass|data-tone`。

**一处附带改动（去歧义）**：交易日图例原来写作 `● 交易日 / ○ 休市 / ◇ 交易日未知`。
`●` 现在统一表示"笔记"，同一个形状两种含义必然误读 ⇒ 那三项**去掉形状、只留词**
（`FupanPage.tsx:402-404`）。信息没少：格子里仍有「休市」文字与虚线边框，颜色档位照旧。
这一条不在用户口径里，属于**必要的去重**，如要保留原形状请改回去（判据不依赖它）。

### 按月惰性取数（宿主 `month` 回包不带笔数）

宿主已确认：`fupan/month` **不带**每天的交易笔数（本批不做）。所以：

- 只有**打开过的那一天**才发 `GET /tradewatcher/fupan/trades?day=…`（`FupanPage.tsx:117`），
  结果按日缓存进内存（`tradesByDay`），同月来回点日期不重复取数（`FupanPage.tsx:115` 的早退）；
- 月历上的 `▲n` 因此只画**已知**的：没打开过的日子不画（`tradeCountIn` 返回 `null`），
  **不写 `▲0`**（`0` 会被读成"这天有记录但笔数为 0"）；
- 兼容前视：`FupanDateDto.trades?: number` 一旦宿主带上，`monthTradeCountOf` 就优先用它
  ⇒ 整月直接显示 `▲n`，界面不用改（`fupanTrades.ts:78`，判据见 `impl87.test.ts` 末例）。

## 4. ② 当日详情

| 口径 | 实现 | 位置 |
| --- | --- | --- |
| 逐笔只读列表（时间/名称/买卖/数量/价格/费用） | `tradeRowTextsOf` → 6 列；每行是原生 `<button>`（键盘可达） | `fupanTrades.ts:141` / `FupanPage.tsx:231-247` |
| 当日汇总行 | `买入 N 笔 · 卖出 M 笔`（**不写**净买入/净卖出/净额） | `fupanTrades.ts:95` |
| 当日盈亏 | `fmtSigned(v)` 直接给数值；**不加**来源标注/口径句 | `fupanTrades.ts:107` |
| 缺值 | 汇总缺字段 ⇒ `买入 未取到 · 卖出 未取到`；盈亏缺 ⇒ `未取到`（**不写 0**） | 同上 |
| 超 500 笔 | 前 500 + `另有 N 笔未显示`（宿主自己截断时也补算） | `fupanTrades.ts:175` / `:188` |
| 整份回包取不到 | 一句 `交易记录未取到`（完整原因进 `title`），**不渲染**「买入 0 笔」 | `FupanPage.tsx:573-576` |
| 只有汇总、没有 `trades[]` | `交易明细未取到`（不画成空列表） | `FupanPage.tsx:581-585` |

两种回包形状都认（简报口径 `summary:{buys,sells}` 与宿主最终口径 `summary:{buy:{count},sell:{count}}`），
`total`/`truncated.total` 都能算未显示笔数 —— 任一侧改口径都不会让界面说谎。

**为何失败时给一句话**：用户口径的"失败等同 0 笔"只约束**月历不画三角**；日面板若安静地显示
「买入 0 笔」+ 空列表，就是把"没读到"说成"没有"（本仓库红线：读不到 ≠ 没有）。因此这里只给
**一句短话**、不写任何 0。

## 5. ③ 点某笔 → 持仓页「交易流水」+ 静态高亮（纯内存态）

| 环节 | 实现 | 位置 |
| --- | --- | --- |
| 点某笔 | `requestTradeJump({ ledgerId, day })`（只写模块级变量 + 通知订阅者） | `tradeJump.ts:25` / `FupanPage.tsx:238` |
| 切页 | `index.tsx` 订阅 → `goPage('portfolio')`（既有唯一入口，不新增路由） | `index.tsx:266` |
| 开流水 | 持仓页挂载 effect 里 `takeTradeFocus()`（**读一次即清空**）→ `openLedger({ mode:'all' })`（`all` 走宿主上限 1000 条） | `PortfolioPage.tsx:208` / `:198` |
| 静态高亮 | 命中行 `data-focus=true` → 底色条 `var(--tw-accent-soft)` + `aria-current` | `PortfolioPage.tsx:1014-1019` / `styles.ts:351` |
| 定位 | 高亮行可能在长列表里靠后：`scrollIntoView({block:'nearest'})`（无动效） | `PortfolioPage.tsx:967-970` |

**不改 URL**（无 `history`/`location`/`pushState`）、**不改偏好**（无 `setPrefs`）、**不写存储**
（无 `localStorage`/`sessionStorage`/`cookie`）—— 判据 `jumpProblems` 直接扫模块源码，四条反例各注入一次。
**不闪烁**：高亮规则里没有 `animation`/`transition`（判据 `highlightProblems` 扫**全部**同名规则，
后写覆盖前面的也算）；生命周期 = 持仓页组件的生命周期（切页即卸载 ⇒ 高亮自然消失，回来不会再弹）。

## 6. ④ 明确不做（用户决定）

- **不接隐身档**：页面/纯逻辑/跳转模块都不读 `viewMode`/`incognito`/`moneyMask`，也不加「已隐藏」占位；
  数字全部走 `format.ts` 里**不受 `setMoneyMask` 影响**的出口（`fmtPrice` / `fmtSigned` / `fmtClock`）。
  ⇒ 隐身档下本页仍明文。判据 `incognitoProblems` + 反例（读开关 / 改用 `fmtMoneySigned`）各注入一次。
- **不做笔记↔交易的引用/挂载**（没有 `noteId` 字段、没有关联按钮）。
- **不写**「按记账时间」「来自持仓核算」这类标注（当日盈亏只有数值）。

## 7. 断言与反例注入（`src/client/impl87.test.ts`，11 例）

| # | 判据 | 反例注入（必须非空） | 读数 |
| --- | --- | --- | --- |
| ① | `●`/`▲n` 形状正确、并存并排 `● ▲3`；标记节点无颜色 | 用颜色区分（只上色不出形状）/ 给标记节点挂 `color:var(--tw-up)` | `markProblems`、`markNodeProblems` 均非空 |
| ② | `readFailed` ⇒ 笔数 `null` ⇒ 不画三角；0 笔不画 | 失败也画 `▲0`（`▲${n ?? 0}`） | `failDrawsZero` 得 `▲0`，真实实现得 `''` |
| ③ | 汇总只有「买入 3 笔 · 卖出 2 笔」；缺字段 `未取到` | 追加「· 净买入 1 笔」 | `summaryProblems` 非空（含净额/形状不符） |
| ④ | 盈亏只给数值 `+1234.50` | 追加「（来自持仓核算）」 | `pnlProblems` 非空 |
| ⑤ | 缺值 ⇒ `未取到`（`null`/`undefined`/`NaN`）；真 0 ⇒ `0.00` | 缺值写 `0` | `pnlProblems` 非空 |
| ⑥ | 520 笔 ⇒ 前 500 + 「另有 20 笔未显示」；宿主截断补 300 | 静默截断（`more` 恒 0） | `truncationProblems` 非空 |
| ⑦ | 请求→通知→取走一次即清空；跳转模块不碰 URL/存储/偏好/网络；高亮静态 | `pushState` / `location.hash` / `localStorage` / `api.setPrefs` 各注入一次；高亮加 `animation` | `jumpProblems`、`highlightProblems` 均非空 |
| ⑧ | 三份源码里 0 处遮蔽开关、0 处被遮蔽的金额出口 | 加 `prefs.viewMode === 'incognito'` / 改用 `fmtMoneySigned` | `incognitoProblems` 非空 |
| 线缆 | `api.fupanTrades` 函数体只 1 条路由字面量；消费方**恰好** `FupanPage.tsx` | 在 `TopBar.tsx` 里也调用 | 消费方集合 ≠ `['FupanPage.tsx']` |
| 接线 | 按日惰性取数 + 月历优先用宿主笔数 + 失败给一句话 | 去掉缓存早退（每次都取） | 源码判据变为 false |

## 8. 门禁读数（本批实测）

```
npm run check   （DSH_HOME=/tmp/fptui-*）
  typecheck ................. 通过
  用例 ×2 时区 .............. 954 / 954 全过（0 fail）—— 基线 933 + 本批两路新增 21
                              （客户端 11 例在 src/client/impl87.test.ts；其余为宿主那一路）
  selftest .................. 通过（ALL HOST CHECKS PASSED，live probes soft）
  build ..................... built lib/index.js + lib/client.js（v0.113.0，片段校验 73 项）
  退出码 .................... 0
```

产物核查（`lib/client.js`，非 ASCII 被 esbuild 转义成 `\uXXXX`，按转义后形态查）：
`钉到这一天的笔记`（1）、`另有 `（10）、`笔未显示`（1）、`交易明细未取到`（1）、`未取到`（114）、
`fupan/trades`（1）、`tw-wrow[data-focus=true]`（1）、`tw-fp-marks`（2）全部命中。

## 9. 未做项 / 交接

1. **行注册四处镜像**（`src/index.ts` 的 `ROW_ROUTES.fupan`、`src/index.test.ts` 的测试副本、
   `docs/DESIGN-SUBPLUGINS.md` §2.1、`cordis.patch.yml` 行注释）由宿主那一路负责 —— 本批我只加客户端
   消费者，`src/rowOwnership.test.ts` 的"消费行恰好 = 声明行"判据已由 `impl87.test.ts` 的线缆用例
   同口径重复验证（消费方恰好 `FupanPage.tsx`）。
2. **整月一键预取**（一次拿整月每天的笔数）没做：宿主本批不带笔数，页数是惰性取；等宿主 `dates[].trades`
   落地即自动生效，客户端不用改。
3. **自动滚动**只做"把高亮行滚进视野"（`block:'nearest'`），不做平滑动画（动效纪律 + 不闪烁）。
4. **高亮定位的边界**：持仓流水的 `/tradewatcher/ledger` 没有"按 id / 按日"的筛选参数，只有 `limit`
   （宿主夹 1..1000）。所以跳转时按上限要 1000 条：命中就高亮；若那一笔比最近 1000 条还旧，
   弹窗照开但**不会高亮**（不伪造一个"接近的那行"）。要彻底解决需要宿主给 ledger 加筛选参数，属下一批。
5. `▲0` 这类"失败也画三角"的实现**没做也不许做**（用户决定），反例注入持续守着。
