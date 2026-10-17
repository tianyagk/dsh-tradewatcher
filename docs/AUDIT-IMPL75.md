# AUDIT-IMPL75：review-8 剩余 8 条 P1 + 锁定片段「无行情源 N」落成真实字符串

- **实施时刻**：2026-10-17 21:41–22:35（Asia/Shanghai）
- **基线**：`5734052`（v0.106.0）。评审依据：`docs/REVIEW-8-CLIENT-UX.md` §P1（8 条）。
- **本批范围**：P1-2 / P1-4 / P1-6 / P1-7 / P1-8 / P1-9 / P1-10 / P1-11 + 追加项（锁定片段改真实字符串）。
- **纪律**：`build.mjs` 未动；未新增依赖；不 commit、不装、不动 profile、不重启 `dsh web`；实验隔离 `DSH_HOME=/tmp/q2-*`；未手工写 `~/.dsh`。
- **工作区注意**：期间**另一批 host/客户端改动在并行发生**（`src/host/{chips,em,rescue,routes,trendLkg*}`、`src/shared/{model,trendRetention}`、`src/client/{chartNote,QuoteDrawer}`，AUDIT-IMPL74/76 批次，均非本批改动）。因此下面的用例数是 812（基线）+ 本批 13 + 并行批 15 = **840/轮**。

---

## 0. 结论（一行）

8 条 P1 逐条落地且都配了**可失败的反例注入**（悬浮图失败给真原因、搜索候选键盘可选 + combobox/listbox/option 语义、买卖方向不再用涨跌色、三句自相矛盾文案按事实重写、两处浏览器时区改北京时间、历史回看失败不再伪装成"无信号"、重要性/护盘等级改独立语义色并在隐身档灰化、缩略图口径改成「分时首笔/高/低」），追加项把锁定片段 `无行情源 N` 从**注释**搬到**真实渲染字符串**上（`NO_SOURCE_BADGE_HINT` → TopBar 徽标 `aria-label`），两轮 `npm run check` 全绿、构建仍是 73 项。

---

## 1. P1-2 悬浮图失败丢原因 → 显示宿主给的 `missing[]`

**问题**：`TopBar.tsx` 的悬浮卡对 `chartCache` 的 `kind:'unavailable'` 只写「暂无当日走势数据」，`.catch(() => setKind('error'))` 又把错误整个丢掉 ⇒ 用户无法区分"该市场本来没这个源"（等也没用）与"东财限流"（稍后重试）。而详情抽屉早就做了这个区分。

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `chartCache.ts:39-66` | 新增纯函数 `unavailableReasonOf(payload)` → `{ short, detail } \| null`；`short` = `「${m.what}未取到」`，`detail` = `m.note +（no-source ⇒ 上游没有这份数据、重试无用 ／ transient ⇒ 本次失败、稍后自动重试）`；`missing` 为空时给兜底短句 |
| `TopBar.tsx:46/53/72` | 悬浮卡新增 `reason` 状态；两份 payload（当日分时优先、近 5 日兜底）都走 `unavailableReasonOf` |
| `TopBar.tsx:150-166` | `error` 与 `none` 共用一块渲染：第一行仍是既有短句（「走势获取失败」/「暂无当日走势数据」），第二行是**原因短句**（`role="note"` + `tabIndex=0`），完整解释进 `title`/`aria-label` |
| `TopBar.tsx:83-88` | 请求异常也记原因（`上游本次不可达` + `e.message`），不再只置 `kind='error'` |

**断言与注入**：`src/client/impl75.test.ts` → `① …`

- 纯函数：no-source ⇒ detail 含原 `note` + 「重试无用」；transient ⇒ 含「稍后自动重试」；`missing` 为空给兜底；正常 payload / null ⇒ `null`（不给原因）。
- 接线：`unavailableReasonOf(p) ?? unavailableReasonOf(d)`、`role: 'note'`、`title: \`${reason.short}\n${reason.detail}\``、`kind === 'error' || kind === 'none'` 共用原因块；**不许**再有"catch 里只置 error 不记原因"。
- **注入**：把原因接线换成 `null`（= 旧行为）⇒ 断言必败；另用 `const legacy = () => null` 复现"丢掉 missing"并断言其必败。

---

## 2. P1-4 搜索候选键盘不可选 + 缺 combobox 语义

**问题**：候选行只有 `onMouseDown`（键盘 Enter/Space 触发的是 **click**）⇒ 键盘永远选不中；输入框/容器/行都没有 `combobox`/`listbox`/`option` 语义。

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `suggestView.ts:224-245` | 新增纯函数 `nextActiveOf(current,total,delta)`（‑1 进入 / 边界环绕）与 `edgeActiveOf(total,'home'\|'end')` |
| `ui.tsx:170-232` | `active` 状态（键盘高亮）+ `React.useId()` 生成稳定 id；↑/↓/Home/End 移动、Enter 选高亮项（**没有高亮时保持原行为：回车取排序后第一条**）、Esc 关闭并清高亮；扁平候选列表与渲染顺序一致 |
| `ui.tsx:246-258` | 输入框：`role="combobox"`、`aria-autocomplete="list"`、`aria-expanded`、`aria-controls`（指向 listbox）、`aria-activedescendant`（指向当前 option） |
| `ui.tsx:264-278` | 容器：`role="listbox"` + `id` + `aria-label="搜索候选"`；分组头 `role="presentation"`（不是 option） |
| `ui.tsx:305-330` | 候选行：`role="option"` + `id` + `aria-selected` + `data-active` + **`onClick` 选中**（键盘 Enter 走 click）+ `onMouseDown` 仅 `preventDefault`（不抢输入框焦点）+ `onMouseEnter` 同步高亮 |
| `ui.tsx:335-341` | 「显示更多」补 `onClick`（键盘也能按） |
| `styles.ts:380` | `.tw-suggest button[data-active=true]` 键盘高亮（背景色 + 左侧 2px 条；无动画/无闪烁） |

**断言与注入**：`② …`（2 条）

- 纯函数：`nextActiveOf(-1,5,1)=0`、`(-1,5,-1)=4`、`(4,5,1)=0`、`(0,5,-1)=4`、`(2,0,1)=-1`；`edgeActiveOf` Home/End。
- 接线：逐项检查 12 条（combobox / listbox / option / aria-activedescendant / aria-selected / click 选中 / mousedown 只防失焦 / 上下键接纯函数 / 显示更多 click）。
- **注入**：删掉 `onClick: () => pick(h)`（退回只有 onMouseDown）⇒ 判据非空；另注入 `const legacy = () => -1`（键盘不可移动）⇒ 必败。

---

## 3. P1-6 买卖用涨跌色、随 `redUp` 翻转

**问题**：`PortfolioPage.tsx` 的操作记录里 `buy → tw-chip-up / sell → tw-chip-down`，这两个 class 由 `prefs.redUp` 决定红绿 ⇒ 切成"绿涨红跌"后**买入变绿、卖出变红**；隐身档又把 up/down 一起灰化 ⇒ 买卖同色。

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `PortfolioPage.tsx:922-930` | 删掉 `chip(verb)` 三元，改 `const VERB_CHIP = 'tw-chip-flat'`（中性）= 方向与涨跌彻底解耦 |
| `PortfolioPage.tsx:964` | 操作行 chip 用中性色 + 文字「买/卖」，并保留 `data-verb={r.verb}`（方向仍可从 DOM/读屏读到）；金额的盈亏仍用 `dirClass(...redUp)`（颜色只留在这里） |

**断言与注入**：`③ …`

- LedgerModal 体内：`VERB_CHIP='tw-chip-flat'`、**不出现** `tw-chip-up/down`、不出现 `verb === 'buy' ?` 取色；`data-verb` 与 `verbLabel` 仍在。
- 全客户端扫描：不许出现 `verb === 'buy' … tw-chip-(up|down)` 的映射（覆盖未来其它入口）。
- **注入**：把旧三元放回 ⇒ 判据非空、断言必败。

---

## 4. P1-7 MarketPage 三句"本插件未集成/没做"与同屏数据矛盾

**问题**：v0.81.2 起涨停家数、两融双源、盘中预测都已经是真的，但失败回落的文案还写着「本插件未集成两融数据源」「本插件没有日内成交额采样」「本轮不做」⇒ 同一屏自相矛盾，且会被读成"永远不会有"（而不是"本次没取到"）。

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `MarketPage.tsx:228-231` | 四句原因常量重写：涨停/跌停、预测全天、两融统一成「**本次附加行情未取到**（说清是哪个源/上游）+ **稍后自动重试** + **不是 0** + 口径」；日内家数单独标成「**功能边界**（重试也不会变）」 |
| `MarketPage.tsx:377-381` | 两融小节副标题 `本插件未集成两融数据源` → **`深交所官方 + 东财，双源交叉`**（title 里补"不一致时两个读数都显示，不取其一"） |
| `host/tools.ts:787` | agent 工具描述里的 `importance：3=高（红）2=中（橙）1=低` → 去掉颜色词（颜色已改为独立语义色阶，写死颜色名会变谎话） |

**断言与注入**：`④ …`

- 三句"本次失败"必须含「本次」+「自动重试/稍后」+「不是 0/而不是 0」；`INTRADAY_REASON` 必须含「功能边界」；页面里**不许**再出现 `未集成`/`本轮不做`/`故不给`/`没有日内成交额采样`/`没有涨停/跌停字段`；副标题必须含「双源交叉」。
- 全客户端：`本插件未集成` 命中数 = 0。
- **注入**：把两融那句旧文案放回 ⇒ 判据非空、断言必败。

---

## 5. P1-8 RescuePanel 两处 `toTimeString()`（R5 时区红线回归）

**问题**：`new Date(x).toTimeString().slice(0,5)` 按**浏览器时区**渲染（UTC 浏览器里 `14:32` 会显示 `06:32`），与页面其它"数据时刻"不同源。

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `RescuePanel.tsx:801` | 「上次结果」的时刻 → `shClockText(snapshot.bottom.computedAt).slice(0, 5)`（固定 Asia/Shanghai） |
| `RescuePanel.tsx:828` | 前低时点 → `shClockText(l.pattern.lowAtTs).slice(0, 5)`（并补 `title: '前低时点（北京时间）'`） |

**断言与注入**：`⑤ …`（2 条）

- 全客户端（剥注释）扫描：`toTimeString(` / `getHours(` / `getMinutes(` 命中数 = 0；`toLocaleTimeString` 必须同行带 `timeZone: 'Asia/Shanghai'`（既有两处白名单）。
- 纯函数：`shClockText(Date.parse('2026-10-17T06:32:00Z')) === '14:32:00'`，`.slice(0,5) === '14:32'`（`TZ=UTC` 那一轮同样成立）。
- 接线：两处都必须出现 `shClockText(...).slice(0, 5)`。
- **注入**：把 `new Date(x).toTimeString().slice(0,5)` 塞回源码 ⇒ 扫描命中数 1、断言必败。

---

## 6. P1-9 历史回看失败伪造「当日无信号」

**问题**：`openHistory` 的 `.catch(() => setDayDetail({ events: [], intraday: [] }))` ⇒ 失败时弹窗断言"当日无信号事件""当日无抽样点"——两句都是**未经验证的否定**。

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `RescuePanel.tsx:372` | 新增 `dayErr` 状态（失败原因） |
| `RescuePanel.tsx:447-458` | `openHistory`：开始时清 `dayErr`；失败 ⇒ `setDayErr(e.message)`，**保持 `dayDetail === null`（= 未取到）**，不再写空数组 |
| `RescuePanel.tsx:936` | 弹窗调用点传 `err: dayErr` + `onRetry: () => openHistory(openDay)` |
| `RescuePanel.tsx:1072-1090` | `DayModal` 用纯函数 `dayHistoryStateOf({err, detail})` 分三态：`error` ⇒ 只渲染「历史回看本次未取到 —— 原因」+「重试」（`role="note"`，键盘/读屏可读），**不渲染任何"无信号/无抽样"的句子**；`loading` ⇒ 骨架；`ready` ⇒ 正常（此时空数组才是真的"当日没有"） |
| `rescueView.ts:57-68` | 新增纯函数 `dayHistoryStateOf`（唯一实现） |

**断言与注入**：`⑥ …`

- 纯函数：`{err:'东财 503', detail:null} → 'error'`；`{err:null,detail:null} → 'loading'`；`{err:null,detail:{events:[],intraday:[]}} → 'ready'`。
- 接线：`openHistory` 里不许出现 `setDayDetail({ events: [], intraday: [] })`、必须有 `setDayErr(e.message)`；弹窗必须 `state === 'error'` 分支 + 「历史回看本次未取到」+「重试」。
- **注入**：把 `.catch(() => setDayDetail({ events: [], intraday: [] }))` 旧写法放回 ⇒ 判据非空、断言必败。

---

## 7. P1-10 重要性/护盘等级复用 `--tw-up`，隐身档刺眼

**问题**：日历重要性 `3: var(--tw-up)`（跟随 `redUp` 变绿，隐身档变灰），护盘等级 `3: '#f2555a'`（硬编码，隐身档仍鲜红）——同一屏一档跟偏好走、一档不走，隐身视图最刺眼的一处颜色泄漏。选项文案「高（红）」在绿涨模式下是谎话。

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `styles.ts:26-27`（浅）/ `46-47`（深） | 新增 **7 个语义 token**：`--tw-imp-1/2/3`（重要性三档，靛蓝/暗琥珀/焦橙）、`--tw-rescue-0..3`（护盘等级，中性灰→蓝→琥珀→焦橙）——**都不使用涨跌色相** |
| `styles.ts:113-118` | 隐身档 `[data-view=incognito]` 把 7 个 token 一并压成中性灰 `#8a8f98`（与 `--tw-up/down` 同一条规则） |
| `CalendarPage.tsx:29-37` | `IMP_COLOR` 改引 `var(--tw-imp-3/2/1)` |
| `CalendarPage.tsx:512-515` | 重要度选项去掉「（红）/（橙）/（蓝）」（颜色已不是固定色相） |
| `RescuePanel.tsx:36-46` | `LEVEL_COLOR` 改引 `var(--tw-rescue-0..3)`（含"触发"徽标、因子圆点、等级点与光晕） |
| `rescueView.ts:44-57` | `abnormalColorOf`（总分环）改引 `var(--tw-imp-3/2)` / `var(--tw-fg-dim)`，不再硬编码 `#e0872a/#d8a13a`（隐身档同样灰化） |
| `README.md:145` | 行情/日历说明同步：重要性三档是独立语义色阶、不随红涨绿跌翻转、隐身档灰化 |

**断言与注入**：`⑦ …`（2 条）

- 7 个 token 在**浅色/深色**两档都有值；`[data-view=incognito]` 段里全部被压成 `#8a8f98`。
- `IMP_COLOR` / `LEVEL_COLOR` / `abnormalColorOf` 只引用 `var(--tw-imp-*)` / `var(--tw-rescue-*)`：不出现 `--tw-up/down`、不出现 6 位硬编码色值；日历选项不再写死颜色名；异常程度三档颜色互不相同。
- **注入**：① 删掉隐身档的一条灰化 ⇒ 判据非空；② 删掉深色档一个 token ⇒ 判据非空；③ 把 `IMP_COLOR[3]` 改回 `var(--tw-up)` ⇒ 判据非空。

---

## 8. P1-11 缩略图「开/高/低」其实是分时抽样点的首笔/极值

**问题**：`mini.ts` 用 `/trend` 分时点的 `first` / `max` / `min` 当"今开/最高/最低"显示。分时首点通常晚于 09:30、分钟点还可能被抽样压缩 ⇒ 与券商 App 的开高低**可能不同**（字段名对、语义差一档）。

**改动**（选"改口径说明"，不改取数路径 —— 不新增请求）

| 文件:行号 | 改动 |
| --- | --- |
| `mini.ts:13-23` | `MiniData` 字段改名：`open/high/low` → **`sampleFirst/sampleHigh/sampleLow`**，注释写清"不是交易所口径的开高低，官方值在 `/detail`" |
| `mini.ts:51-53` | 赋值处同步（口径不变，只把语义写进字段名） |
| `WatchlistPage.tsx:624-655` | hover 文案：`开/高/低/振幅` → **`分时首笔/分时高/分时低/分时振幅`**，并追加一行「（以上为分时抽样点，不是交易所口径的开/高/低；官方开高低见详情抽屉）」 |
| `PortfolioPage.tsx:1188-1210` | 同上（持仓页同一口径） |
| `README.md:25` | 文档同步 |

**断言与注入**：`⑧ …`

- `MiniData` 必须有 `sampleFirst/sampleHigh/sampleLow`、**不许**再有 `open?/high?/low?`（防止被重新误读）。
- 两个页面的 `miniHover` 都必须出现「分时首笔/分时高/分时低/分时振幅」+「不是交易所口径的开/高/低」；**不许**再出现裸 `` `开 ${ ``/`` `高 ${ ``/`` `低 ${ ``。
- **注入**：把标签改回 `` `开 ${ `` ⇒ 判据非空、断言必败。

---

## 9. 追加项：锁定片段 `无行情源 N` 落成**真实渲染字符串**

**背景**：`build.mjs` 的 73 项里有一条 `无行情源 N`，它此前的唯一来源是 `quoteState.ts` 里一句**注释**（esbuild 非压缩构建保留注释）——IMPL-71 曾因改写注释丢了 `N` 而导致构建校验失败。

**改动**

| 文件:行号 | 改动 |
| --- | --- |
| `quoteState.ts:34-43` | 新增导出常量 **`NO_SOURCE_BADGE_HINT = '无行情源 N：三源（东财/腾讯/新浪）都没有该标的的可用价格；重试可能恢复，也可能只是东财没恢复'`**（带注释说明它是锁片段的真实来源） |
| `TopBar.tsx:536-540` | 「无行情源 N」徽标新增 **`aria-label`**：`` `${NO_SOURCE_BADGE_HINT}（本批 ${n} 只）` `` —— 常量真的被渲染，锁片段因此进 bundle |

**锁片段新落点（给 Lead 同步锁定片段用）**

```
quoteState.ts → NO_SOURCE_BADGE_HINT = '无行情源 N：三源（东财/腾讯/新浪）都没有该标的的可用价格；重试可能恢复，也可能只是东财没恢复'
  → 经 TopBar.tsx 的「无行情源 N」徽标 aria-label 渲染进 lib/client.js
```

- 建议的锁片段保持不变（`无行情源 N`），或改成更具体的一段：`无行情源 N：三源（东财/腾讯/新浪）都没有该标的的可用价格`。**两种都能过**（前者是后者的前缀），`build.mjs` 本轮**未动**。
- **证据**：非压缩构建里，字符串字面量会被 esbuild 转义成 `\u65E0\u884C\u60C5\u6E90 N`，而注释保持原样 UTF‑8 ⇒ `grep -o '\u65E0\u884C\u60C5\u6E90 N' lib/client.js` **有命中**（= 锁片段来自**字符串**，不再只靠注释）。
- **断言与注入**：`⑨ …` —— `strip(read('quoteState.ts'))`（**剥掉注释后**）仍包含 `无行情源 N`；常量以它开头；TopBar 的 `aria-label` 真的用了它。注入：把常量里的 `N` 去掉 ⇒ 剥注释后的源码不再命中、断言必败。

---

## 10. 门禁与验证

| 命令 | 结果 |
| --- | --- |
| `tsc --noEmit -p tsconfig.json` | exit 0 |
| `node --test "src/client/*.test.ts"` | **327 pass / 0 fail**（基线 314 + 本批 13） |
| `node --test "src/**/*.test.ts"`（本地时区） | **840 pass / 0 fail**（812 + 本批 13 + 并行批 15） |
| `npm run check` 第 1 轮（typecheck + 2 时区 + selftest + build） | **通过**：两轮时区各 `ℹ tests 840 / pass 840 / fail 0`；`ALL HOST CHECKS PASSED (live probes soft)`；`built lib/index.js + lib/client.js（v0.106.0，客户端片段校验通过：73 项）`；`PIPE_STATUS=0` |
| `npm run check` 第 2 轮（同哈希复跑） | **通过**（同上，`PIPE_STATUS=0`；哈希前后一致见下） |

- **本批新增用例 13 条**：`src/client/impl75.test.ts`（新文件，13 条）。
- **构建片段 73 项**：`build.mjs` 未改；`无行情源 N` 的来源已从注释换成真实字符串（见 §9）。
- **同哈希复跑证据**：两轮都做了"开始前 / 结束后"的 sha256 汇总（`src/client/**` + `src/host/tools.ts` + `build.mjs`），
  两轮各自前后一致、且两轮之间也一致 —— **`19b0da7fe39b71626b86836e48690fb0c6bbd8b08cd47147ea028f82cc3df7b5`** ⇒ 两轮跑的是同一份代码。
  （期间并行批仍在改 host 侧文件；那部分不在本批哈希里，也不影响本批结论。）

---

## 11. 硬约束对照

| 约束 | 本批 |
| --- | --- |
| 不新增依赖 | ✅ `package.json` 未动 |
| 字号只用既有阶梯 | ✅ 新增代码只用到既有的 12 / 13 级 |
| 动效只动 transform/opacity | ✅ 新增的键盘高亮只用背景色与 inset 阴影（无动画）；未新增 keyframes/transition |
| 不得新增强制提示或闪烁 | ✅ 新增文字只出现在失败态与 `title`/`aria-label`；搜索原因仍是既有那行 |
| 缺数据一律「未取到 + 原因」，不得 0 顶替 | ✅ 悬浮图/历史回看都改成"原因 + 重试"；涨停/两融/预测三句都写明"不是 0" |
| `build.mjs` 不动；锁定片段不改 | ✅ 只把片段来源换成真实字符串，未改片段表 |
| 不 commit / 不装 / 不动 profile / 不重启 `dsh web` | ✅ 均未做 |

---

## 12. 未做项

- **P1-9 的"同类（较轻）"**：`QuoteDrawer.tsx` 的 `.catch(() => setTrades([]))`（B/S 标记失败显示成"没有买卖点"）与 `setErr('该周期未取到（停牌/新股/接口限流）')`（猜原因）——本批只按要求修 `RescuePanel` 的历史回看；该文件正被并行批（AUDIT-IMPL76）改动，留待下一批按同一范式处理。
- review-8 其余 P2（P2-1/2/4/5/6/7/8/9/10/11/12）与 P3（P3-1..7）未做。
- `src/shared/model.ts:454` 的注释仍写着「重要性：3=高（红）2=中（橙）1=低（灰蓝）」——该文件正被并行批改动，为避免写冲突**未触碰**；`host/tools.ts:787` 已同步（去掉颜色词）。建议下一批一起改 `shared/model.ts` 那句注释。
- 搜索计数文案（review U5-②：`已显示全部 N 条（上游本次上限 M 条，可能有更多）` 同句自相矛盾）未改：本批只做 Lead 列出的键盘/ARIA 部分。
