# AUDIT-IMPL58 —— 工程四项收口（归属表同步断言 / 弱锁片段 / 导出面与文档纪律 / 归属文档权威性）

- **批次**：v0.94.0（自 `3b02bd1`（v0.93.0，门禁 678 × 2 时区）起）
- **来源**：`docs/REVIEW-6-ENGINEERING.md`（只读评估）的四项行动
- **结论一行**：四项全部落地 —— 归属表三处镜像由断言守住（**并顺手抓到 4 处既有漂移**）、18 条弱锁修强 17 条（留 1 条已论证无法唯一化）、22 条多余导出收敛 + 3 条死代码删除 + 4 条测试钩子改名、5 个历史审计文档加页眉 + DECISIONS 新增原子发版决策；**`npm run check` 两轮全绿（691 × 2 时区）**，`build.mjs` 只改了 needle 字符串（73 条不变、顺序不变）。
- **纪律**：未 commit、未装、未动 profile、未重启服务；`build.mjs` 的改动**仅限 ②授权的 17 条 needle**；实验/负例在 `/tmp/eng2-*`。

---

## ① 归属表建同步断言（REVIEW-6 §2.3 D5）

### 做了什么

| 改动 | 文件 | 说明 |
| --- | --- | --- |
| 真表导出（唯一事实源） | `src/index.ts:32`、`:67` | `ROW_ROUTES`/`ROW_TOOLS` 由 `const` 改 `export const`，并写明"三处镜像由测试守住" |
| **新断言：三处镜像 vs 真表** | `src/index.test.ts`（`归属表三处镜像必须与代码一致`） | 三个解析器把 ①测试副本 ②`docs/DESIGN-SUBPLUGINS.md` §2.1 表 ③`cordis.patch.yml` 行注释读成结构化数据，对每行 `deepEqual`（路由 + 工具 + 行集合） |
| **新断言：路由账目** | `src/index.test.ts`（`路由账目：声明数 = 真表并集；…`） | ①真表内不许有重复声明；②`FUNCTION_OWNED_PATHS` 必须等于真表并集；③文档账目行的总数/core/每行计数必须等于"扫 `routes.ts` 实测" |
| D1 补齐 | `docs/DESIGN-SUBPLUGINS.md` §2.1 `market` 行 | 补 `` `/market-extras` ``（并附调用方证据 `MarketPage.tsx:130`） |
| D2 补齐 | `docs/DESIGN-SUBPLUGINS.md` §2.1 | 新增**第 7 行** `tools`（路由 + 空工具数组 + 理由） |
| D3 更新 | `docs/DESIGN-SUBPLUGINS.md:4`、`:162` | 路由账 `24 = core 16 + … + market 2` ⇒ **`26 = core 15 + calendar 1 + watchlist 3 + portfolio 2 + market 4 + cloudmap 0 + tools 1`** |
| D4 更新 | `cordis.patch.yml:10` | market 行注释补 `market-extras`（`/tradewatcher/breadth\|rescue\|board\|market-extras`） |

### 断言**自己抓到的**既有漂移（实测，4 处）

新断言第一次运行就红了 4 条 —— 全部是真漂移，不是断言写错：

| # | 抓到的东西 | 处理 |
| --- | --- | --- |
| 1 | 文档 §2.1 的 `watchlist` 行只写了 `/watch`（缺 `/industries` `/anomaly`，§2.2 里早就判给 watchlist 了） | 补进 §2.1 |
| 2 | 文档 §2.1 的 `calendar` 行写成 `/tradewatcher/calendar*`（`*` 让解析器读不到路径） | 改成明确路径 + "（GET + POST 同路径）" |
| 3 | 文档 `market` 行的路由**顺序**与代码不同（`/board` 与 `/rescue` 对调） | 与代码对齐 |
| 4 | **`FUNCTION_OWNED_PATHS` 漏了 `/tradewatcher/tools/global-flow`**（第 7 行独占的路由没进"core 必须交出去"的清单）⇒ 此前没有任何断言检查 core 不去注册它 | 补进清单（现在并集必须相等） |

> 第 4 条是**真缺口**：它是"core 会不会偷偷注册了别人的路由"这类问题的唯一拦截点，漏一条就等于漏一类。

### 反例注入（A 组 6/6 被抓住，脚本 `/tmp/eng2-inject.py`，原始输出 `/tmp/eng2-inject-evidence.txt`）

| 注入 | 失败断言 |
| --- | --- |
| A1 真表加一条路由（`/tradewatcher/tones` 塞进 market） | `文档 §2.1 的路由与真表不一致：market`（三处镜像同时红） |
| A2 文档删 `market-extras`（D1 回归） | 同上（文档侧） |
| A3 文档删第 7 行 tools（D2 回归） | `文档 §2.1 表的行集合必须与真表一致（含第 7 行 tools）` |
| A4 patch 注释删 `market-extras`（D4 回归） | `patch 行注释的路由与真表不一致：market` |
| A5 文档路由账改回 24（D3 回归） | `文档路由总数 24 ≠ 注册表实测 26` |
| A6 测试副本与真表脱钩 | `测试副本的路由与真表不一致：market` |

---

## ② 弱锁片段改强锁（`build.mjs`，硬约束内）

### 硬约束遵守情况（实测）

| 约束 | 读数 |
| --- | --- |
| 片段总数仍 73 | ✅ `node /tmp/eng-frag3.cjs` ⇒ `片段总数：73`；构建日志 `客户端片段校验通过：73 项` |
| 顺序不变、不删片段、不改校验逻辑 | ✅ `git diff --stat build.mjs` ⇒ `17 insertions(+), 17 deletions(-)`（**每行只换 needle 字符串**） |
| 只动 ②授权范围 | ✅ 未动 `validate`/`escape*`/构建步骤/`package.json` |

### 改前/改后对照表（次数 = 在 `lib/client.js` 里的**实际**出现次数；新 needle 必须 = 1）

| 旧 needle | 改前次数 | 新 needle（唯一上下文子串） | 改后次数 |
| --- | --- | --- | --- |
| `板块` | 29 | `概念板块` | 1 |
| `隐身` | 16 | `视图：隐身（金额已模糊为 ¥••••、涨跌色转灰阶）` | 1 |
| `不适用` | 12 | `该标的是指数/期货，价格本身没有除权除息，复权不适用` | 1 |
| `前复权` | 9 | `该标的不支持前复权（指数/期货/板块）⇒ 不提供筹码分布` | 1 |
| `数字模糊` | 8 | `数字模糊（价格/涨跌/盈亏/成交额；hover 该行显形）` | 1 |
| `¥••••` | 7 | `+¥••••` | 1 |
| `日分位` | 7 | `60日分位` | 1 |
| `复盘` | 6 | `上游不可用：这张卡是当日峰值的复盘数据，非实时快照` | 1 |
| **`振幅`** | **6** | **（保留：无法唯一化 —— 见下）** | **6** |
| `自定义通道` | 5 | `自定义通道（通常为板块 ETF）：仅作量能与脉冲观察，不计入护盘评分与共振` | 1 |
| `护盘信号` | 5 | `护盘信号回看` | 1 |
| `不含 ` | 5 | `折算口径：不折算。总额只含 A股，港/美股逐项列在「不含 N 项」里（不按 1:1 加进去）。` | 1 |
| `本地缓存` | 5 | `本地缓存（最近一次成功` | 1 |
| `复权口径` | 5 | `（复权口径由宿主回包决定，不是界面请求值）` | 1 |
| `贡献` | 4 | `贡献/满分` | 1 |
| `面板不透明度` | 4 | `截图 / 录屏（面板不透明度与数字模糊）` | 1 |
| `无行情源` | 4 | `无行情源 N` | 1 |
| `不复权` | 4 | `不复权（该标的不适用）` | 1 |

**汇总**：`n≥4` 的弱锁 **18 → 1**；`n=1` 的强锁 **29 → 46**。

### ⚠ 一条无法唯一化（按约定**停手报你**，未硬改）

| 片段 | 现状 | 为什么改不了 | 可选处置（需你定） |
| --- | --- | --- | --- |
| `振幅` | 6 次，保留原样 | 它锁的是"缩略图 hover 的开/高/低/振幅"，而**自选页与持仓页各有一份逐字相同的 tooltip 代码**（`WatchlistPage.tsx:` 与 `PortfolioPage.tsx:` 的 `parts.push('振幅 —（上游未给昨收）')` 等）⇒ 任何取自该功能的源码字面量在产物里至少 2 份；把 needle 绑到某一页特有的邻居文本会绑到**压缩后的变量名**（跨构建不稳定，属于"改校验逻辑"的禁区） | ① 接受 2×（保持现状）；② 允许把两页的 tooltip 文案**有意分化**（例如持仓页写"振幅（相对昨收）"）后再锁；③ 这一条改成"两页都存在"的双针（需新增片段 ⇒ 违反"总数仍 73"） |

### 负例证明（`/tmp/eng2-neg` 克隆，未动工作区）

| 场景 | 命令 | 结果 |
| --- | --- | --- |
| **新锁有效**：把 `概念板块` 改成 `概念XX` | `TW_SKIP_TYPECHECK=1 node build.mjs` | ❌ `构建校验失败：lib/client.js 缺少以下 UI 片段 —— 概念板块` |
| **旧锁是装饰**：同一份源码 + 该条 needle 退回 `板块` | 同上 | ✅ `built … 客户端片段校验通过：73 项`（删了 UI 也照样过） |

> 这两行就是"弱锁 ⇒ 强锁"的价值证明：同一处 UI 消失，旧 needle 放行、新 needle 拦住。

### 勘误（我上一批评估的计数错了）

`docs/REVIEW-6-ENGINEERING.md` §4.1 报"20 条弱锁"用的是**会把纯 ASCII needle 重复计一次**的计数函数
（全 ASCII 时 `split(t)` 与 `split(escape(t))` 是同一件事）⇒ `tw-wlist`/`tw-poslist`/`sidebar.panellist`/`slots.register`
实际是 1–2 次（本就是强锁），并漏算了 `日分位`（7×）、`贡献`（4×）。**修正后是 18 条**，已在 REVIEW-6 §4.1 加了勘误块。

---

## ③ 导出面归并 + 历史文档页眉

| 项 | 做了什么 | 位置 |
| --- | --- | --- |
| 22 条多余 `export` 收敛 | 去掉 `export`（保留文件内可见）：`TypeSpec`/`GlassSlots`/`keyframeBlock`/`FactTopic`/`StressVerdict`/`MarketExtras`/`Push2Probe`/`DayOverDay`/`LimitCounts`/`MarginCross`/`progressCurveSamples`/`TradingDayState`/`TradingCalendarInfo`/`CalendarValidation`/`validateTradingCalendar`/`tradingCalendarPath`/`TRADING_CALENDAR_FILE`/`FLOW_MACRO_KEEP_DAYS`/`FlowPreferenceParts`/`mergedMacroHistory`/`trimMacroDays`/`ROBOTS_TTL_MS` | 9 个文件（`tsc --noEmit` 通过 ⇒ 反证确实无外部引用） |
| 3 条死代码删除 | `LimitCountsWire`（`src/client/api.ts`）、`macroHistory`、`macroReadFailures`（`src/host/globalFlow.ts`） | 删前实测：外部引用 0 **且**同文件用量 0（v0.90.0 上复核过，不是 in-flight） |
| 4 条测试钩子改名 | `resetTradingCalendarCache`→`__resetTradingCalendarCache`；`resetPush2Availability`→`__resetPush2Availability`；`resetExtrasCache`→`__resetExtrasCache`；`push2Availability`→`__push2Availability`（旧名全仓零残留） | 与既有约定一致（`__resetRobotsCache`、`__kernelStats`） |
| 历史页眉 | 5 个文档首行加「> **历史快照**：…**不代表现状**；现状以 `README.md` 与代码为准」 | `AUDIT-IMPL35/45/46/47`、`AUDIT-HY4-1` |
| DECISIONS 头部清理 | 头部 4 行重复 H1/H2 ⇒ 一个 H1 + 一行说明（`13 insertions / 4 deletions`，正文未动） | `docs/DECISIONS.md` |
| 新增决策 | 「发版必须是**原子动作**」：升版本 → 跑门禁 → **确认产物含新版本号** → 再重启/发布；并写明 v0.90.0 前的实测中间态 | `docs/DECISIONS.md` |

### 新防线：`src/repoHygiene.test.ts`（6 条）

| 用例 | 判据 |
| --- | --- |
| ① 22 条不许再被 `export` 回来 | 逐条正则检查"不是导出了" + 反例自证 |
| ② 3 条死代码不许复活 | 逐条检查标识符在文件里**完全不出现** |
| ③ 4 条钩子必须 `__` 前缀且旧名零残留 | 声明形态 + 全仓旧名扫描 |
| ④ **不许新增"零引用导出"** | 全仓扫描（自身文件/其它文件/测试三处引用都算），基线 49 条历史欠账**只许减不许增** + 反例自证 |
| ⑤ 历史页眉 | 5 个文档必须以此开头且含"不代表现状" |
| ⑥ DECISIONS 头部唯一 H1 + 原子发版决策 | 前 8 个非空行只允许"文档 H1 / `# 决策：…`"两种 H1（**不按行号**：按行号的写法会被"插一行 H1"绕过，反例实测踩到） |

### 反例注入（B 组 7/7 被抓住）

| 注入 | 失败断言 |
| --- | --- |
| B1 `TypeSpec` 又 export 回来 | `…的 TypeSpec 不该再被 export（本批已确认外部零引用）` |
| B2 `LimitCountsWire` 复活 | `src/client/api.ts 里不该再有 LimitCountsWire…` |
| B3 `macroHistory` 复活 | 同上（`src/host/globalFlow.ts`） |
| B4 钩子改回旧名 | `全仓不该再有旧名 resetTradingCalendarCache 的引用` |
| B5 删掉审计页眉 | `docs/AUDIT-IMPL35.md 必须以「历史快照」页眉开头` |
| B6 去掉原子发版决策 | `DECISIONS 必须记录"发版是原子动作"这条决策` |
| B7 DECISIONS 头部插重复 H1 | `头部出现多余的 H1（只允许"# 决策：…"条目标题）` |

---

## ④ 归属文档的权威性声明

`docs/DESIGN-SUBPLUGINS.md` §2.1 表头新增（原文）：

> **权威性**：本表是 `src/index.ts` 的 `ROW_ROUTES`/`ROW_TOOLS` 的**镜像**，冲突以代码为准；判据见 §2.2。
> 三处镜像（本表 / `cordis.patch.yml` 的行注释 / `src/index.test.ts` 的期望副本）由 `src/index.test.ts` 的
> 「归属表三处镜像必须与代码一致」用例逐项 `deepEqual` 守住 —— **改代码就必须同步这三处，否则测试红**。

`src/index.ts` 的真表上也写了对应的一句（指向测试），形成双向指引。

---

## 门禁与读数

```
npm run check   → exit 0
ℹ tests 691 / pass 691 / fail 0        （默认时区）
ℹ tests 691 / pass 691 / fail 0        （TZ=UTC）
built lib/index.js + lib/client.js （v0.93.0，客户端片段校验通过：73 项）
```

- 基线 678 → 691：**+13**，其中本批 **+8**（`src/index.test.ts` +2：三处镜像 / 路由账目；`src/repoHygiene.test.ts` +6），
  同期另一路的 `src/host/rescueSameSlot.test.ts` **+5**（工作区里同时存在，读数包含它 —— 见"未做项"）。
- `git diff --stat build.mjs`：`17 insertions(+), 17 deletions(-)`（只换 needle）。
- 反例注入：**A 组 6/6 + B 组 7/7 全部被抓住**（脚本 `/tmp/eng2-inject.py`，输出 `/tmp/eng2-inject-evidence.txt`），
  注入后逐条还原、`sha256` 与注入前一致、恢复后两组测试复跑 exit=0；②的负例在 `/tmp/eng2-neg` 克隆里跑（不动工作区）。

## 未做项

1. **`振幅` 那条弱锁未修强**（18 → 17）—— 按约定停手报你，三条可选处置见 §② 末表。
2. **导出面基线里仍有 49 条历史欠账**（v0.78.0 之前的零引用导出，如 `TrendCaliber`、`Z_95`、`QuoteEngine`…）：
   本批只**冻结增量**（④ 用例保证只减不增），清掉这 49 条会影响 20+ 个文件，建议单独一批。
3. **③ 的"零引用"判据是文本级**（`\bName\b` 计数，不解析 AST）：极端写法（动态字符串、`export *`）可能漏判；
   已用于"新增即红"的窄判据（只对**新增**生效），风险可接受。
4. **门禁读数包含同期另一路的在途文件**（`src/host/rescueSameSlot.test.ts`、`docs/AUDIT-IMPL59.md` 等未提交改动）；
   若需要"纯本批"读数，请在另一路落定后重跑（读数差 = 那 5 条用例）。
5. **未做浏览器实机确认**：本批全是结构/文档/常量级改动，无 UI 行为变化（`build.mjs` 只换断言字符串）。
