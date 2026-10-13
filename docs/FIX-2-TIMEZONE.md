# FIX-2-TIMEZONE —— 时区红线 2 条修复记录

来源：`docs/REVIEW-2-CORRECTNESS.md` §R4（宿主侧市场时钟）/ §R5（浏览器侧"数据时刻"族）。
门禁：`npm run check` **EXIT=0，550/550 × 2 时区（默认 + `TZ=UTC`）+ selftest + build（v0.75.0）**（末尾三行见 §5）。

**一行结论**：市场时间在**解析**与**展示**两侧都固定到 `Asia/Shanghai` —— 宿主侧新增 `parseMarketStamp`/`sh*Text` 单一出口（`rescue.ts`/`tencent.ts` 的 2 处无偏移 `Date.parse` 全部收口），客户端新增 `marketTime.ts` 的固定时区出口（5 处红线站点 + 同族 6 处），并**改掉了那条把缺陷当契约的测试**；新增 9 条断言**在 `TZ=UTC` 轮必须通过**，4 组反例注入在 `TZ=UTC` 下全部必败。

---

## 1. ④ 宿主：市场时钟字符串按宿主时区解析（2 处，偏 8 小时）

**新出口**（`src/host/time.ts`）
- `parseMarketStamp(text)`（`:89`）：`"YYYY-MM-DD HH:mm[:ss]"` / `"YYYYMMDDHHmm[ss]"` 一律按 **`+08:00`** 解析；已带 `Z`/`±hh:mm` 的原样认（不重复加 8 小时）；空串/垃圾 ⇒ `NaN`（不返回"现在"）。
- `shDateTimeText` / `shClockText` / `shStampText`（`:124/132/137`）：固定 `Asia/Shanghai` 的 `Intl` 格式化（宿主时区无关）。

| 处 | 修法（`文件:行号`） |
|---|---|
| 护盘分时（trends2 + fflow） | `rescue.ts:843` `parseMinuteStamp` → 委托 `parseMarketStamp`（旧：`Date.parse(\`${day}T${hhmm}:00\`)` 无偏移） |
| 腾讯分时兜底 | `tencent.ts:404` → `parseMarketStamp(\`${day} ${hhmm}\`)` |
| 工具回包里的"数据时刻"（同族的**格式化**侧） | `tools.ts:70/417/699/891/1379` 由无 `timeZone` 的 `toLocaleString('zh-CN')` 改为 `shDateTimeText` |
| 备份工具的用户可见时间 | `backup.ts:217/218` 同上 |
| 自检夹具的日键（同族隐患） | `selftest.ts:725` `new Date().toISOString().slice(0,10)` → `dayOf(Date.now())`，否则 `RescueMonitor` 的北京日键在北京 00:30 前后与夹具对不上（自检自己会假红/假绿） |

**症状对照（复核实测 → 修后）**：`TZ=UTC` 下腾讯分时的 `09:31` 点曾是北京 `17:31`、`inTradingWindow` 命中 `0/330`；现在是 `09:31`、整批命中。

---

## 2. ⑤ 客户端：「数据时刻」族按浏览器时区（5 处）

**新出口**（`src/client/marketTime.ts`）：`shDateTimeText`（`:82`）/ `shClockText`（`:89`）/ `shStampText`（`:94`）/ `shDayText`（`:99`）/ `shToday`（`:104`），全部 `timeZone: 'Asia/Shanghai'` 写死。

| # | 站点（红线点名的 5 处） | 修法（`文件:行号`） |
|---|---|---|
| ① | 侧栏标签「盯盘 · 数据 HH:mm:ss」 | `badgeView.ts:56` → `shClockText` |
| ② | 行情卡 `title`「数据时刻」 | `quoteState.ts:66` → `shClockText` |
| ③ | K 线脚注「上次成功数据（MM-DD HH:mm）」 | `chartNote.ts:41` → `shStampText`；`format.ts:92`（`fmtClock`）与 `:110`（`fmtStamp`）同步收口 |
| ④ | 日历"今天"高亮 /「即将发生」 | `CalendarPage.tsx:46/187` → `shToday()`（北京自然日；`iso/addDays/gridStart` 是**日级**日历算术，不经时刻换算，保持原样并有注释说明） |
| ⑤ | （同族）行情卡/页面级"数据时刻" | `MarketPage.tsx:21/445/456`、`PortfolioPage.tsx:338`、`WatchlistPage.tsx:202`、`QuoteDrawer.tsx:466/514`、`RescuePanel.tsx:438/468/476/479` |

**同族顺带修掉的三类**（都在本次排查里被扫出来）：
- **文件名/导出用 UTC 日期**：`PortfolioPage.tsx:595`（备份文件名）、`RescuePanel.tsx:101`（CSV 名）、`QuoteDrawer.tsx:392`（交易明细的成交日）—— 北京 00:00–08:00 会写错一天；改用 `shToday()`/`shDayText(ts)`。
- **K 线窗口起点**：`kline.tsx:930` `new Date(Date.now()-days*86400e3).toISOString().slice(0,10)` → `shToday(...)`。
- 其余 `toISOString()` 是**非市场时间**（锁文件/隔离件命名、锁持有者日志）⇒ 保持不变（见 §3 排查表）。

---

## 3. 时区排查表（全仓逐个给结论）

扫描口径：`src/**/*.{ts,tsx}`（排除 `*.test.ts`）里的 `toLocale*`、`Intl.*`、本地 `getHours/getMinutes/getSeconds`、`toISOString()`、手拼时间。

| 类别 | 位置 | 结论 |
|---|---|---|
| 市场时刻解析（**曾偏 8 小时**） | `rescue.ts:843`、`tencent.ts:404` | ✅ 已修（`parseMarketStamp`） |
| 本地化渲染（**曾按浏览器时区**） | `badgeView.ts`、`quoteState.ts`、`chartNote.ts`、`format.ts`、`MarketPage.tsx`、`PortfolioPage.tsx`、`QuoteDrawer.tsx`、`RescuePanel.tsx`、`WatchlistPage.tsx`、`CalendarPage.tsx` | ✅ 已修（11 处，见 §2） |
| 已带 `timeZone` 的（本来就对） | `watchlistView.ts:16`、`host/dayTrade.ts:83/91` | ✅ 无需改（保留作为对照） |
| 已固定时区的格式化器 | `client/marketTime.ts:26/56`、`host/time.ts:11/109` | ✅ 唯一出口（`Intl` + `timeZone`） |
| 日级日历算术（不经时刻） | `CalendarPage.tsx:29-41/74/145`（`iso`/`addDays`/`gridStart`/`shiftMonth`）、`bulkPaste.ts:69`（解析用户输入的日期串） | ✅ 与浏览器时区无关（本地构造 ⇒ 本地读回，同一日历日） |
| `toISOString()` 当日界 | `shared/trendStitch.ts:37`（`msToDay`：只做 `YYYY-MM-DD` 往返）、`host/klineLock.child.ts:54`（测试夹具） | ✅ 允许（已进白名单并写明理由；任何**新**出现的会被 R5-⑤ 断言拦下） |
| `toISOString()` 当文件名/日志 | `host/lock.ts:122/234`、`host/store.ts:440`、`host/readGuard.ts:112`、`client/*.tsx` 导出名（已改） | ✅ 非市场时间（UTC 反而更稳）；导出名那三处已改为北京日 |
| 数字千分位 `toLocaleString('en-US')` | `client/tools/globalFlowView.ts:33` | ✅ 与时间无关（金额分组），扫描已排除 |
| 手拼 `HH:mm` 字符串 | `client/sessionAxis.ts:171`（分位数 → 刻度）、`client/marketTime.ts:35` | ✅ 输入已是"分钟数"或北京刻度，无需时区 |

---

## 4. 断言与反例注入

**新增断言**（`TZ=UTC` 轮必须通过；门禁脚本自带该轮）
- `src/host/marketClock.test.ts`（4 条）：R4-A 解析 4 种写法都等于 `+08:00` 字面量（含"带偏移不重复加"与空串/垃圾 ⇒ NaN）；R4-B 展示层（含北京日界 `00:30`）；R4-C 真 `fetchTencentMinutes`（stub 上游）⇒ 点的北京时刻 `09:31` 且 `inTradingWindow` 命中；R4-D 真 `fetchMinuteSeries`（stub trends2+fflow）⇒ 整批命中采样窗口。
- `src/client/marketTimeDisplay.test.ts`（5 条）：R5-①②③④ 用**固定字面量**断言 `09:42:52` / `10-12 09:42` / `10-09 09:05`；R5-⑤ 是**全仓静态防线**：不允许无 `timeZone` 的 `toLocale*`、不允许 `toISOString().slice(0,10)` 当日界、不允许本地 `getHours/getMinutes/getSeconds`（白名单两条，均写明理由）。

**被改的测试（把缺陷当契约的那条，点名）**
| 测试 | 旧（缺陷当契约） | 新（固定字面量） |
|---|---|---|
| `src/client/badgeView.test.ts:69` | `const hhmmss = new Date(Date.parse('2026-10-12T09:42:52+08:00')).toLocaleTimeString('zh-CN', {hour12:false})`，再断言 `text === \`盯盘 · 数据 ${hhmmss}\`` ⇒ **任何时区都过**（UTC 浏览器下它接受 `01:42:52`） | `assert.equal(text, '盯盘 · 数据 09:42:52')` |
| `src/client/chartNote.test.ts:56` | `stamp(new Date(2026, 9, 9, 9, 5).getTime()) === '10-09 09:05'`（**本地**构造 + 本地渲染 ⇒ 同样恒真） | `stamp(Date.parse('2026-10-09T09:05:00+08:00')) === '10-09 09:05'`（另加北京 `00:05` 的跨日边） |

**反例注入（`TZ=UTC` 下必败；贴证据后已恢复，md5 校验）**
```
R4-A parseMarketStamp 退回无偏移 Date.parse → ✖ R4-A / ✖ R4-C（"旧实现…在 TZ=UTC 下这里会是 17:31"）/ ✖ R4-D
R5-A shClockText 退回浏览器本地时区        → ✖ R5-①（实际 数据 01:42:52）/ ✖ R5-②（数据时刻 01:42:52）/ ✖ R5-③ / ✖ R5-⑤
R5-B chartNote.stamp 退回本地 getHours     → ✖ R5-④ / ✖ chartNote.test 的 stamp 断言 / ✖ R5-⑤（本地取值）
R5-C 新加一处无 timeZone 的 toLocaleTimeString → ✖ R5-⑤（新红线会被防线拦下）
日志：/tmp/fix2/inject/R4-A.log、R5-A.log、R5-B.log、R5-C.log
```

**跨时区实跑**：`TZ=UTC` 29/29 通过；`TZ=America/New_York` 9/9 通过（新断言在这些时区下都给出与北京一致的结果）。

---

## 5. 门禁（`npm run check`）

```
EXIT=0
ℹ tests 550   ℹ suites 0   ℹ pass 550   ℹ fail 0     （默认时区）
ℹ tests 550   ℹ suites 0   ℹ pass 550   ℹ fail 0     （TZ=UTC）
ALL HOST CHECKS PASSED (live probes soft)
```
**末尾三行**：
```
> node build.mjs

built lib/index.js + lib/client.js （v0.75.0，客户端片段校验通过：73 项）
```
（541 基线 + 本轮 9 条 = 550：`marketClock` 4 + `marketTimeDisplay` 5。）

**一次 flake 记录（诚实）**：本轮某次 `npm run check` 里 `src/index.test.ts:491`「rescue.start() 只跑一次」曾 `11 !== 1` 失败一次；单独跑该文件 17/17 通过、整轮再跑两次 550/550 通过 ⇒ 判为**负载相关的计时器 flake**（该用例靠计时器计数），与本次改动无关；本文件与 `marketClock.test.ts` 都不启动计时器。若之后再出现，建议给那条断言加"等一次事件循环再计数"的稳定性处理（属别的写入面，未动）。

---

## 6. 未做项（不许读成"已修"）

| 项 | 说明 |
|---|---|
| 网页里"用户自己时区"的偏好 | 本批按仓库既有规矩（README:205-207 / docs/DECISIONS.md:382-383）**一律北京**，没有加"跟随浏览器时区"的开关；若将来要支持，需要 `marketTime.ts` 变成可配置（当前写死是刻意的） |
| `host/lock.ts` 等 UTC 命名 | 锁文件/隔离件的时间戳保持 UTC（非市场时间，UTC 反而更稳），未改 |
| 非时间类 `toLocaleString` | `globalFlowView.ts:33` 的金额千分位保持 `en-US`（与时间无关），扫描里已排除并注明 |
| 界面文案里的"时区标注" | 现在显示的是北京时间，但文案没有写"（北京时间）"——复核未要求，且仓库既有文案都默认北京口径；若要显式标注属文案批 |
| `host/time.ts` 的 `Intl` 依赖 | 固定时区依赖 `Intl` 的 IANA 数据（Node 自带 full-icu ✓）；若在极端裁剪的 ICU 环境跑，`parseMarketStamp` 的字符串拼接路径仍成立，但 `sh*Text` 需回退方案（未做，当前仓库不涉及） |
