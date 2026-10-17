> **历史快照**：本文记录的是当时（见下方正文）的用例数 / 读数 / 抓包，**不代表现状**；现状以 `README.md` 与代码为准。

# AUDIT-IMPL68 —— 美股「日线 K + 分时」接线（实现报告）

- 基线：`main` @ `9358b48`（v0.102.0，`npm run check` 751 用例/时区 × 2）。本轮 **751 → 759 用例**（新增 `src/host/usChart.test.ts` 的 8 例）。
- 上游实测报告见本文 §3（原始回包与命令）；上一批（出价）见 `docs/AUDIT-IMPL67.md` / `docs/PROBE-US-QUOTES.md`。
- 用户口径：`FRO` / `VIXY` **价格已出**（52.49 / 17.73）✓，但**分时图与 K 线图仍无**；界面如实说"东财不可达 + 该标的没有腾讯分钟线兜底"
  —— 那是我们**真的没接线**。本轮补上：美股日线 + 分时 + 五日。
- 纪律：未 commit；未装、未动 profile、**未重启 `dsh web`**；`build.mjs` **零改动**（见 §7 的锁定片段说明）；
  实验全部 `/tmp`（`DSH_HOME=/tmp/uschart/*`）；`robots.txt` 先取，`Disallow` 零请求。

---

## 0. 结论

1. **美股日线**：新浪 `US_MinKService.getDailyK` 实测给**全历史**（FRO 5649 根 / AAPL 10055 根），字段 `d/o/h/l/c/v/a`，
   末根与当日行情一致 ⇒ 已接为美股日线的**第一上游**（腾讯对美股只回 2 根"首尾"、东财长期不可达）。
2. **美股分时**：新浪 `US_MinKService.getMinK` 实测 `type=1` 给 **1023 根 / 3 个交易日**（当日 390 根 09:31→16:00 ET）、
   `type=5` 给 **14 个交易日** ⇒ 分时与**五日**都成了**真实多日源**（不再依赖本地归档逐日累积）。
   **腾讯对美股分钟只回 1 个点**（`["1604 52.49 3722974"]`）⇒ 不能当分钟源，已明确不用。
3. **复权：美股拿不到**。新浪美股日线是**未复权原始价**（实测 AAPL 2020-08-31 拆股日 499.23 → 129.04、FRO 2016-02-03 1.93 → 10.0）。
   ⇒ `fqSupported('105/106/107')` 改为 **false**，界面写「不复权（上游只给原始价：拆股/分红未调整）」而不是「该标的不适用」；
   **筹码分布**与**位置指标**对美股**明确不给结论**（不许按原始价照算）；YTD 文案单独说明"跨拆股会失真"。
4. **周期**：美股只提供 **分时 / 五日 / 日K**；**周/月/年禁用并给原因**（不是点了才报错），宿主侧 `klt≠101` 直接回 `no-source`。
5. **时区**：美股时间戳一律按**美东**解析（新增 `time.ts` 的 `usWallToEpoch` / `newYorkParts` / `inUsSession` / `isUsSettledOffline`），
   `TZ` 无关；`parseTencentUsStamp` 改为复用同一实现（不再两处抄）。
6. **顺手修的真缺陷**：`isSettledOffline` 判"定稿"用的是**北京**日历日 + A股 15:05 收盘 —— 美股盘中正好是北京深夜，
   会被判成"已定稿 ⇒ 整夜不回源"，日线永远停在昨天那根。已按市场分流（`isUsSettledOffline`，纽约 16:05）。

---

## 1. 改动清单（接线点 `文件:行号`）

### 1.1 上游原语（`src/host/sina.ts`）

| 位置 | 内容 |
|---|---|
| `sina.ts:385-421` | 新增 `SinaUsMinBar` + `parseSinaUsMin`（纯函数）：`d` 按**美东**换算成 epoch（`usWallToEpoch`），`v`=股、`a`=该根成交额（美元，**非累计**）；换算不出来/价格≤0 的行直接丢 |
| `sina.ts:423-429` | 新增 `fetchSinaUsMin(symbol, type)`（`type` = 1/5/15），走 `withHostBreaker('stock.finance.sina.com.cn')` |
| `sina.ts:431` / `SinaBar` | `fetchSinaUsDaily` 复用既有的（globalFlow 已在用），`SinaBar` 增加 `amount`：解析日线的 `a` 段，上游给 `"0"` 的历史 bar 归一为 **null**（不 0 顶替） |

### 1.2 宿主取数（`src/host/em.ts`）

| 位置 | 内容 |
|---|---|
| `em.ts:1760` | 新增 `isUsSecid()`（`105/106/107`）—— 三条链的上游都与 A股/港股不同，判据集中一处 |
| `em.ts:2311-2330` | 新增 `requestKlineFromSinaUs()`：TTL 10 分钟的整段历史缓存（FRO 504 KB / AAPL 941 KB，增量刷新不能每 2 分钟重下），映射成 `DayBar` 并**按上一根收盘算 pct** |
| `em.ts:2329-2345`（`requestKlineRaw` 开头） | 美股：**先新浪**；**跳过腾讯**（`isUsSecid(secid) ? null : requestKlineFromTencent(...)`），理由写在注释与 §3.3 |
| `em.ts:2414` | `fetchKline`：美股 `klt≠101` **直接 null**（周/月/年不提供；不做日线重采样冒充） |
| `em.ts:2420` | `fetchKline`：定稿判定按市场分流（`isUsSettledOffline` vs `isSettledOffline`） |
| `em.ts:2508-2514` | `barOpen` 的"今天"按市场取（`usDayOf` / `dayOf`），会话判定同理（`inUsSession` / `inSession`） |
| `em.ts:2529-2535` | 量纲说明：美股 `unitNote = '美股成交量单位为「股」（A股为「手」）'` |
| `em.ts:1599-1640` | 新增 `sinaUsTrend(secid, days)`：`days>1` 用 `type=5`（14 天）拼多日、否则 `type=1` 取当日；标签用上游**美东**墙上时间；`avg: null`（新浪不 VWAP）；`prePrice` 取"保留窗口之前最后一个交易日的最后一根"；回包带 `timeZone` + `caliber` |
| `em.ts:1480` | `fetchTrendSingleDay`：美股先走新浪分钟，失败再落回东财 `trends2`（不改变原有兜底） |
| `em.ts:1641` | `fetchMultiDayTrend`：美股走 `type=5` 的**真实多日源** |
| `em.ts:1773-1800` | `fqSupported`：美股 **false**（有除权概念，但上游只给未复权价）；`normalizeFq` 因此把美股任何请求都收敛成 `0` |
| `em.ts:2394-2420 / 2470-2510` | `trendMissingReason` / `klineMissingReason`：**按市场说上游**（美股：新浪；周/月/年：`no-source` + "本插件不提供"，不再甩锅腾讯） |

### 1.3 时间原语（`src/host/time.ts`）

`time.ts:217` `newYorkParts` · `:233` `usDayOf` · `:245` `usWallToEpoch`（反解 + 收敛校验）·
`:265` `inUsSession`（09:30–16:00 ET，周末 false）· `:272` `lastUsCloseBoundary`（16:05 ET，周末回溯）·
`:296` `isUsSettledOffline`。`tencent.ts` 的 `parseTencentUsStamp` 改为复用 `usWallToEpoch`（语义不变，断言未改）。

### 1.4 复权缺失的处置（红线）

| 位置 | 内容 |
|---|---|
| `position.ts:55` / `:63` | 新增 `US_NO_FQ_WHY` + `positionRefusal(secid)`：美股 ⇒ 返回固定理由（**工具层不许各写一份**） |
| `tools.ts:1047` / `:1185` | 分组排序「位置」列与 `tradewatcher_position` 工具：命中 `positionRefusal` ⇒ 值 `null` + `why`（`no-source`），**不计算** |
| `tools.ts` methodology | 补一句"美股不提供：上游只给未复权价" |
| `chips.ts:470` | 筹码不提供的原因改成同时覆盖两种情形（指数/期货**不需要**；美股**上游没给**） |
| `client/ytdView.ts:36` | 年初至今的口径文案：美股单独说明"跨拆股会失真"（与"指数/期货不适用"分开） |

### 1.5 前端（`src/client/*`）

| 位置 | 内容 |
|---|---|
| `chartCache.ts:41` | 新增 `tabUnavailableReason(secid, tab)`：美股 ⇒ 周/月/年返回原因（含"上游只有日线"），其余 `null` |
| `QuoteDrawer.tsx:625-645` | 周期按钮：不可用档 `disabled` + `aria-disabled` + `title` 写原因（**点了不会有任何事**）；`useEffect` 把记忆里的不可用档归位到"日K" |
| `QuoteDrawer.tsx:520-535` | 口径行：分时用宿主回的 `caliber`（来源/时区/单位/昨收口径）；K 线复权口径按市场说真话 |
| `QuoteDrawer.tsx:566` | 复权段控的 title：美股 ⇒ "上游只提供未复权价（拆股/分红未调整）"，不再说"指数/期货不适用" |
| `styles.ts:206` | `.tw-tab[aria-disabled=true]{opacity:.45;cursor:not-allowed;…}`（**JS 里不写 cursor**，`splitDrag.test.ts` 有红线） |
| `chipsView.ts` / `ChipsPanel.tsx` | 筹码不提供的兜底文案：把美股的原因一起写清（**保留 build.mjs 锁定的那句原样**，见 §7） |

### 1.6 共享类型（`src/shared/model.ts`）

`TrendData` 增加 `timeZone?: 'Asia/Shanghai' | 'America/New_York'` 与 `caliber?: string` —— 美股分时的"来源/时区/单位/昨收口径"
必须随数据一起回，否则界面只能说"这是分时"，等于隐藏口径。

---

## 2. 数据流（改后）

```
/kline?secid=106.FRO&klt=101
  fetchKline(106.FRO,101,·,fqt→0)
    └─ 美股：klt≠101 ⇒ null（+ no-source 原因）        em.ts:2414
    └─ refreshKline → requestKlineRaw
         ├─ ① 新浪 US_MinKService.getDailyK（全历史，TTL 10min）   em.ts:2311  ★ 新
         ├─ ② 东财 push2his（既有，长期不可达）
         └─ ③ 本地磁盘缓存（既有）
      腾讯 fqkline **跳过**（对美股只回 2 根"首尾"）              em.ts:2340

/trend?secid=106.FRO&ndays=1|5
  fetchTrend
    ├─ ndays=1 → fetchTrendSingleDay → 新浪 getMinK?type=1（当日 390 根，美东标签）  em.ts:1480 ★ 新
    │            失败 → 东财 trends2（既有）
    └─ ndays=5 → fetchMultiDayTrend → 新浪 getMinK?type=5（14 个交易日）             em.ts:1641 ★ 新
```

---

## 3. 上游实测（2026-10-17，本机）

`robots.txt` 预检：`stock.finance.sina.com.cn` → **302（无 robots 文件**，视为无声明限制）；`web.ifzq.gtimg.cn` → 非 robots 文本
（`{"code":11,…}`）；`qt.gtimg.cn` → `bad request`。东财三条 `push2*` 仍是 `Disallow: /`（**零请求**，沿用 v0.102.0 的豁免口径）。

### 3.1 新浪美股**日线**（`getDailyK`）—— 实测可得

```bash
curl -sS --max-time 20 -A 'Mozilla/5.0 dsh-probe' -e 'https://finance.sina.com.cn/' \
  'https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/x/US_MinKService.getDailyK?symbol=fro'
```

```text
/*<script>location.href='//sina.com';</script>*/
x([{"d":"2001-08-06","o":"15.05","h":"15.05","l":"14.90","c":"14.95","v":"55100","a":"0"}, … ,
   {"d":"2026-10-16","o":"53.63","h":"54.19","l":"52.38","c":"52.49","v":"3722968","a":"197036000"}]);
```

- **根数上限：没有**（一次给全历史）：`fro` **5649 根**（2001-08-06 → 2026-10-16）、`aapl` **10055 根**（1984-09-07 起）。
- 字段：`d/o/h/l/c/v/a`；`v` = **股**；`a` = **美元**成交额（末根 197,036,000 ↔ `gb_fro` 下标 30 的 197,036,261 同源）；早期 bar 的 `a` 给 `"0"` ⇒ 归一为 null。
- **复权：不复权**（见 §3.4）。

### 3.2 新浪美股**分钟**（`getMinK`）—— 实测可得

```bash
curl -sS '…/US_MinKService.getMinK?symbol=fro&type=1'   # 1 分钟
curl -sS '…/US_MinKService.getMinK?symbol=fro&type=5'   # 5 分钟
curl -sS '…/US_MinKService.getMinK?symbol=fro&type=15'  # 15 分钟
```

| type | 根数 | 覆盖交易日 | 每日根数 | 区间 |
|---|---|---|---|---|
| 1 | **1023** | **3** | 390（09:31→16:00 ET） | 2026-10-14 11:56 → 2026-10-16 16:00 |
| 5 | **1023** | **14** | 78（09:35→16:00） | 2026-09-29 15:20 → 2026-10-16 16:00 |
| 15 | **1023** | **40** | 26（09:45→16:00） | 2026-08-21 14:00 → 2026-10-16 16:00 |

- **三种都恰好 1023 根**（上游硬上限）；时间戳是**美东**墙上时间，只含常规盘（无盘前/盘后）。
- 每根：`d/o/h/l/c/v/a`；`a` 是**逐根**成交额（实测 15:20 那根 `v=23743, a=1161990` ⇒ 1161990/23743 ≈ 48.94 = 当时价 ⇒ 非累计）。
- `vixy` 同样覆盖（1023 根 / 3 天，末日 390 根）。
- 未知代码：`x(null)` / 空 ⇒ 解析为 `[]`（不造假序列）。

### 3.3 腾讯（对照）—— 实测**不可得**（记录，不改）

```bash
curl 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=usFRO'
# → {"data":{"usFRO":{"data":{"data":["1604 52.49 3722974"],"date":""}}}}      ← 只有 1 个点
curl 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=usFRO,day,,,10,qfq'
# → day: [["2011-06-02",…],["2026-10-16",…]]                                ← 只有 2 根（首日 + 今天）
```

⇒ 腾讯美股**分钟不可用**、**日线不是序列**。本轮明确：美股分钟只走新浪，美股日线**跳过腾讯**（那 2 根喂进缓存会画出"15 年凭空消失"的图）。

### 3.4 复权判定（决定 §1.4 的红线处置）

同一接口取 AAPL 日线，看 2020-08-31 的 4:1 拆股：

```text
2020-08-28 close= 499.23
2020-08-31 close= 129.04     ← 未调整（499.23 / 4 ≈ 124.8）
```

FRO 同样：`2016-02-03` 从 `1.93` 跳到 `10.0`（1:5 反向拆股，未调整）。

⇒ **新浪美股日线 = 原始价（未复权）**，本插件没有第二个美股历史源 ⇒ 前复权**不可得**。
因此：`fqSupported(美股)=false`、`normalizeFq` 恒 0、**筹码/位置不给结论**、YTD 文案单独说明失真风险。

---

## 4. 不支持的周期如何处置

| 档位 | 美股 | 处置 |
|---|---|---|
| 分时 | ✅ 新浪 `type=1`（当日 390 根） | 正常渲染，口径行写"来源/美东/单位/昨收口径" |
| 五日 | ✅ 新浪 `type=5`（14 天 ⇒ 取最近 5 天） | 真多日源，**不**标 `local-stitch` |
| 日K | ✅ 新浪 `getDailyK` | 正常渲染（默认不复权） |
| 周K / 月K / 年K | ❌ 没有上游 | **按钮 `disabled` + title 原因**；宿主 `klt≠101` 直接 `no-source`（"本插件不提供…不用日线重采样冒充"） |

反例：若无这条判据，用户点了会收到一条报错（"该周期未取到"）而不是"禁用 + 原因"——`usChart.test.ts` ③ 用
`deepEqual(blocked, ['week','month','year'])` 钉住，判据被删立刻红。

---

## 5. 诚实性（红线自检）

| 要求 | 落地 |
|---|---|
| 分时/K 线**标口径与来源** | `TrendData.caliber`（来源=新浪美股分钟 N 分钟 / 时区=美东 / 复权=不适用（分时）/ 成交量单位=股 / 昨收口径）；K 线口径行写 klt + 复权 + 截至 + 当根是否收盘，`unitNote` 标注"股而非手" |
| **延迟** | 上游不给延迟标志 ⇒ 口径行只说"截至 <数据时刻>"，不写"实时" |
| **复权口径** | 美股恒"不复权（上游只给原始价：拆股/分红未调整）"；请求前复权也会被收敛为 0（断言） |
| 不可得 ⇒ **未取到 + 原因** | `trendMissingReason` / `klineMissingReason` 按市场给上游名（新浪/东财），周/月/年为 `no-source`；空回包 ⇒ `null`，绝不 `points: []` |
| **不得 0 顶替** | 日线早期 bar 的 `a="0"` ⇒ `amount: null`；`avg` 新浪不给 VWAP ⇒ `null`；未取到市值仍是 null（上批） |
| **不得用别的周期冒充** | 不做日线→周/月重采样（这是"周K 档位禁用"的直接原因） |
| **筹码/位置** | 美股：`positionRefusal` 直接拦、筹码 `fqSupported=false` 直接不提供；文案区分"不需要"与"上游没给" |

---

## 6. 断言 / 反例注入（`src/host/usChart.test.ts`，8 例）

| # | 断言 | 反例（照错的做法实现就红） |
|---|---|---|
| ① | 美股日K 出 7 根（= 夹具条数）、末根 52.49/2026-10-16、`fqt=0`、`fqSupported=false`、`unitNote` 含"股" | ① 删接线 ⇒ `k === null`；② 采信腾讯那 2 根 ⇒ `days.length === 2`（`notEqual` 抓） |
| ①b | 空回包 ⇒ `fetchKline === null`；`klineMissingReason` 说清是**新浪**；上游故障 ⇒ `transient` | 文案若照旧说"腾讯与东财" ⇒ `includes('新浪')` 红 |
| ② | 分时 3 根、首根标签 `2026-10-16 09:31`（美东）、`t` = `usWallToEpoch(...)`、`timeZone`/`caliber` 齐全、`prePrice=52.54` | ② 上游"可达但空" ⇒ 必须 `null`（注入"返回 `points: []`"⇒ 红）；原因里不许出现"该标的没有分时" |
| ②b | 五日 = 3 个不同交易日，`source` 不是 `local-stitch` | 若退回本地拼接 ⇒ `source === 'local-stitch'`、天数不足 ⇒ 红 |
| ③ | `tabUnavailableReason` 对美股只禁 `week/month/year`；A股/港股全 `null`；抽屉源码包含 `disabled: off`/`aria-disabled`；宿主 `klt=102 ⇒ null + no-source` | 判据删掉（全 null）⇒ `deepEqual` 红；只在前端拦、宿主放行 ⇒ `fetchKline(102)` 非 null ⇒ 红 |
| ④ | `fqSupported(美股)=false`、`normalizeFq(…,1)=0`、`positionRefusal` 非空；A股/指数为 `null`；筹码文案含"美股" | **照算**：`positionOfBars` 在拆股窗口上确实能算出百分比（断言证明"能算"），拦住它的只有 `positionRefusal`（改成 null 就变成照算） |
| ⑤ | 美东→UTC：`16:00:01 → 1792180801000`；`notEqual` 到 08:00Z（东八区）与 16:00Z（UTC）；DST 两端 | 按任一错误时区解释 ⇒ 红 |
| ⑤b | `isUsSettledOffline` 按纽约 16:05 判，盘中永不定稿 | 若沿用北京时间 15:05 ⇒ 美股盘中（北京深夜）被判"定稿"⇒ 日线整夜不回源 |

另：`selftest.ts` 的复权适用面按新事实更新（美股改为"不可得"，并加 `normalizeFq(美股,1)===0` 的断言）。

---

## 7. 验证

```text
npm test       → 759 / 759 pass（默认时区）× 759 / 759 pass（TZ=UTC）     751 → 759
npm run selftest → ALL HOST CHECKS PASSED (live probes soft)
npm run build  → built lib/index.js + lib/client.js（客户端片段校验通过：73 项）
npm run check  → EXIT=0 × 2 轮（实现后两轮干净复跑）
```

### 7.1 ⚠ 命中 `build.mjs` 的锁定片段（已按"不动 build.mjs"处理，请 Lead 判）

`build.mjs:184` 锁定了客户端 UI 字面量 **`该标的不支持前复权（指数/期货/板块）⇒ 不提供筹码分布`**；
我一开始把它改写成了对美股更准确的一句话，构建立刻报"缺少以下 UI 片段"（73 项校验失败）。

按"`build.mjs` 不要动、命中锁定片段就停手报我"的纪律，**我没有改 build.mjs**，而是把这个字面量**原样保留为前缀**，
把美股的原因作为括号补在后面：`该标的不支持前复权（指数/期货/板块）⇒ 不提供筹码分布（美股另有原因：上游只给未复权原始价，拆股/分红未调整）`
（`build.mjs` 用的是 `includes()`，追加不影响校验，73 项通过）。

**请裁决**：① 维持现状（锁定句里"指数/期货/板块"对美股不够准确，但括号已补充）；② 由你更新 `build.mjs` 的锁定片段为新文案。
我不动那一行。

---

## 8. 未做 / 未确认 / 风险

| 项 | 状态 | 说明 |
|---|---|---|
| 美股**周/月/年 K** | 未做（有意） | 上游只有日线；不做重采样冒充（用户要的正是"日线 K + 分时"）。若以后要，需要新上游或显式"本地聚合"口径 |
| 美股**盘前/盘后**分时 | 未做 | 新浪 `getMinK` 只给常规盘 09:30–16:00 ET；盘前盘后没有源 |
| 美股 `avg`（分时均价线） | 未做 | 新浪分钟不给 VWAP；按"不得编造"给了 `avg: null`（图上没有均价线，口径行也不声称有） |
| 昨收的"官方口径" | 部分 | 分时昨收取"前一交易日最后一根分钟收盘"，与交易所官方收盘可能差 1 分（实测 FRO 10-15：52.53 vs 52.54）——已写进 `caliber` |
| 美股**半日市**（感恩节次日等） | 未处理 | `inUsSession` 按 09:30–16:00 固定；半日市（13:00 收）会被多判 3 小时"盘中"⇒ 只是多回源几次，不会造错数 |
| 东财对美股日线 | 未确认 | 仍作为第二上游保留（robots 原因零请求）；本机东财长期不可达，无从验证 |
| `dsh web` 里的界面 | **需重启才生效** | 我未重启宿主；`lib/` 已构建为含本轮改动的产物，走你的发布流程 |
| 版本号 / CHANGELOG / commit | 未做 | 按 `docs/DECISIONS.md`「发版是原子动作」归 Lead |
