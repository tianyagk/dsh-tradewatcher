# AUDIT-IMPL84：当日分时吐出**昨天**的整场（同一时刻与五日链不同日期）

- **实施时刻**：2026-10-20 09:56 起（Asia/Shanghai，**盘中**，现象现场取证）
- **起点**：`4e433ba`（v0.111.0；门禁基线 **920 用例 × 2 时区** + 构建 **73 项**）
- **用户报告**：持仓页 / 自选页详情抽屉里 ——
  - **五日分时**：有当日实时数据（正确）
  - **当日分时**：显示的是**昨日**旧数据（错误），且界面**没有标明它是昨天**
- **红线**：未动 `build.mjs`、未新增依赖、未 commit / 未装 / 未动 profile、**未重启 `dsh web`**；
  实验全部跑在 `DSH_HOME=/tmp/ts-*` 隔离目录，**没有手工写 `~/.dsh`**（只读诊断，见 §1）。

---

## 0. 结论（三行）

1. **根因（主）**：**两条链的源集合不一致**。当日链 = `东财 trends2 → 腾讯分钟(web.ifzq.gtimg.cn)`，
   五日链 = `新浪 5 分钟(quotes.sina.cn) → 腾讯 5 分钟(proxy.finance.qq.com)`。
   真机现场：东财三主机**全部熔断**（`fetch failed`，连续失败 12/22/24 次）、腾讯分钟域名被 **WAF 拦回 501**，
   而新浪可用 ⇒ 五日链拿到当日 10-20 10:00，当日链**只剩昨日的 LKG**（10-19 17:38 写入）⇒ 同一时刻两个日期。
2. **根因（诚实性）**：拿到非当日序列时，回包只带 `sessionDay`（"是哪天"），**不带原因**；
   客户端脚注的优先级又把「上次成功数据（10-19 15:00）」放在前面，图头仍是「昨收 … · 09:30 ~ 15:00」
   ⇒ 读者读成"今天的图，只是刷新慢"。这类"看着正常的错数"是红线。
3. **根因（缓存/门控）**：内存缓存键 `trend:<secid>:<ndays>` **不含交易日**（跨日可命中）；
   "休市定稿"门控用 `inSession`（**09:25** 起算），09:15–09:25 集合竞价期间会把昨天的快照判成"已定稿"复用 5 分钟。

修法：**补源**（当日链加新浪 1 分钟，与五日链同源同序）+ **键带交易日** + **门控窗口 09:15–15:05** +
**诚实性兜底**（非当日 ⇒ `nonSession{day,reason,detail}`，界面第一句就写「非当日数据（YYYY-MM-DD）：原因」）。
门禁：**934 用例 × 2 时区全绿**（920 基线 + 新增 14）+ 构建 **73 项**（§6）。

---

## 1. 复现与取证

### 1.1 真机两条路由（同一标的、同一时刻）

```bash
curl -s -H 'Host: 127.0.0.1:3080' 'http://127.0.0.1:3080/tradewatcher/trend?secid=1.510300&ndays=1'
curl -s -H 'Host: 127.0.0.1:3080' 'http://127.0.0.1:3080/tradewatcher/trend?secid=1.510300&ndays=5'
```

原始读数（2026-10-20 **09:56–09:59**，三次连打的稳定结果）：

| 链 | 点数 | 首点 | 末点 | `labelDay` | `sessionDay` | `staleAt` | `source` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **当日** `ndays=1` | 242 | 09:30 | **15:00** | **2026-10-19** | **2026-10-19** | **2026-10-19 17:38:11** | —（旧包无此字段） |
| **五日** `ndays=5` | 198→200 | 2026-10-14 09:35 | **2026-10-20 10:00** | — | — | — | —（旧包无此字段） |

```
run 1: n=242 first=09:30 last=15:00 sessionDay=2026-10-19 staleAt=1792402691196 labelDay=2026-10-19 source=undefined missing=undefined
run 2: n=242 first=09:30 last=15:00 sessionDay=2026-10-19 staleAt=1792402691196 labelDay=2026-10-19 source=undefined missing=undefined
run 3: n=242 first=09:30 last=15:00 sessionDay=2026-10-19 staleAt=1792402691196 labelDay=2026-10-19 source=undefined missing=undefined
5日 distinct days: ["2026-10-14","2026-10-15","2026-10-16","2026-10-19","2026-10-20"]  last ts=2026-10-20 10:00:00
```

`1792402691196` = **2026-10-19 17:38:11**（不是"现在"，也不是"最后一分钟"）——它正是
`lastGoodTrend()` 给 LKG 打的 `staleAt`。⇒ 当日链走的是 **LKG 兜底**（`pickTrendFallback.from === 'lkg'`）。

> 现场是**间歇性**的：10:04 腾讯分钟偶发通过一次，当日链随之恢复（10:08 / 10:11 复读：1 日 = 10-20 10:05，
> `staleAt=10-20 10:04:19`，即"当日数据的 LKG"）——**故障窗口是 09:56–09:59 那段**，用户报的正是这类窗口。
> 间歇性不改变结论：§1.2/§1.4 的**结构性差异**解释了"为什么偏偏是当日链掉进昨天，而同日五日链没事"，
> §1.5 的隔离复现可随时重放同一现场（不依赖运气）。

### 1.2 上游直取（判定"上游就旧"还是"我们取错"）

```bash
# 东财 trends2（带 UA/referer；不带 UA 会被回空体，容易误判成"东财挂了"）
node -e "fetch('https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=1.510300&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0',{headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',referer:'https://quote.eastmoney.com/'}}).then(r=>r.json()).then(j=>console.log(j.data.trends.length, j.data.trends[0], j.data.trends.at(-1)))"
# 腾讯分钟（宿主 fetchTencentMinutes 用的正是这个域名）
curl -s -o /tmp/tx.html -w '%{http_code}\n' -H 'user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' -H 'referer: https://gu.qq.com/' 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=sh510300'
# 腾讯分钟的**另一个域名**（五日链/rescue 用的就是它）
curl -s -H 'user-agent: Mozilla/5.0' -H 'referer: https://gu.qq.com/' 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/minute/query?code=sh510300' | head -c 200
# 新浪 1 分钟 / 5 分钟
curl -s -H 'user-agent: Mozilla/5.0' 'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=sh510300&scale=1&ma=no&datalen=5'
```

实测（2026-10-20 10:0x）：

| 上游 | 结果 | 说明 |
| --- | --- | --- |
| 东财 `trends2`（裸进程） | **200**，30 行，首 `2026-10-20 09:30` | **上游有当日数据** ⇒ 不是"上游就旧" |
| 东财 三主机（**跑着的宿主**） | `fetch failed` ×12/22/24 次，熔断 **3/3** | 宿主进程的网络栈对该域名已坏（见 `/health`） |
| 腾讯 `web.ifzq.gtimg.cn` 分钟 | **HTTP 501 + WAF 挑战页**（3/3） | 当日链的备用源**结构性不可用** |
| 腾讯 `proxy.finance.qq.com` 分钟 | **200**，`date=20261020`，41 行 | 同一个 API、**另一个域名** —— 五日链用的就是这个域名族 |
| 新浪 `scale=1` / `scale=5` | **200**，当日 09:31→10:0x | **五日链一直可用** |

宿主 `/tradewatcher/health`（09:59）：

```json
{"breaker":{"open":true,"allOpen":true,"openHosts":3,"hosts":3,"minutesLeft":12,"lastError":"fetch failed"},
 "upstream":{"line":"上游健康 09:59:02：push2his.eastmoney.com 熔断剩 12 分钟（连续失败 12 次，fetch failed） ｜ push2.eastmoney.com …（22 次） ｜ push2delay.eastmoney.com …（24 次）"}}
```

⇒ **判定：不是"上游就旧"，是"我们取错"** —— 上游（东财/新浪/腾讯代理域）明明有当日数据，
只是**当日链没有去问能给出当日数据的那个源**。

### 1.3 缓存与门控（第 1 步第 3 项）

| 检查项 | 改前 | 判定 |
| --- | --- | --- |
| 内存缓存键 | `` `trend:${secid}:${ndays}` ``（**无日期**） | ❌ 跨交易日可命中 |
| 内存 TTL | 上游 60s / 备用 30s / LKG 20s / 定稿 300s | TTL 本身没错，**错在键** |
| 落盘 LKG 键 | `${secid}|${ndays}`（`trendLkgStore`） | 设计即"跨日保留最后一次成功"（用于标注"非当日"），**保留** |
| 定稿门控 | `isSettledOffline(at, now)` → `inSession(now)` = **09:25–15:05** | ❌ 09:15–09:25（集合竞价）会把昨日快照判成"已定稿"并复用 300s |
| 真机 LKG | `1.510300|1` at **2026-10-19 17:38:11**（242 点全是 10-19）；`1.510300|5` at 2026-10-20 09:56:52 | 与 §1.1 的 `staleAt` 完全对上 |

### 1.4 来源选择（第 1 步第 4 项）

| 视图 | 改前的源（逐级） | 真机可达性（09:56） |
| --- | --- | --- |
| 当日 `ndays=1` | 东财 `trends2` → `tencentTrend()`（`web.ifzq.gtimg.cn`）→ **LKG** | 东财熔断 ❌ ｜ 腾讯 501 ❌ ⇒ **掉到 10-19 的 LKG** |
| 五日 `ndays=5` | `fetchMultiDayTrend` = 新浪 5min（`quotes.sina.cn`）→ 腾讯 5min（`proxy.finance.qq.com`）→ 本地归档拼接 | 新浪 ✅ ⇒ **当日 10-20** |

⇒ **两条链的可达性集合不同**，这正是"同一时刻两个日期"的成因。

### 1.5 隔离复现（可重复，不依赖现场运气）

```bash
DSH_HOME=<tmp> node --experimental-strip-types /tmp/probe-before.mts   # 预置 10-19 17:38 的 LKG
# 注入"东财熔断 + 备用分钟源不可达"（= 真机现场）
```

改前原始输出：

```
1日: n=3  first=2026-10-19 09:30 last=2026-10-19 09:32
     sessionDay=2026-10-19 staleAt=2026-10-19 17:38:11 source=— nonSession=—
5日: n=199 first=2026-10-14 09:35 last=2026-10-20 10:05
```

⇒ 与真机同形（1 日 = 10-19、5 日 = 10-20）。

### 1.6 界面读到的句子（改前）

客户端 `cacheNoteOf` 对该回包的实际输出（用真回包跑 `src/client/chartNote.ts`）：

```
" · 上次成功数据（10-19 15:00） · 本地兜底（trends-lkg.d/ 按标的拆分）：最多 400 条 / 4 MB，超出按最旧丢弃并在 trends-lkg.json 的 dropped 里留痕"
```

图头（`QuoteDrawer` 拼出来的那一行）是：

```
昨收 4.24 · 09:30 ~ 15:00
```

⇒ **没有任何一处写"这不是今天"**。五日档那行更直白地写「（末行为今日）」。这就是用户说的"没标明它是昨天"。

---

## 2. 修法（按根因，不是加 TTL）

### 2.1 补源：当日链与五日链**同源同序**（根因 ①）

| 文件:行号 | 改动 |
| --- | --- |
| `src/host/em.ts:1653` | 新增 `fetchSinaMinuteBars(sym, scale, datalen)`：新浪分钟线的**唯一**取数与解析（显式 `+08:00`） |
| `src/host/em.ts:1692` | 新增 `sinaMinuteTrend(secid)`：新浪 **1 分钟** → 当日分时（只保留最后一个交易日；`vol` 股→手；`avg` 恒 `null`，不拿价格凑；`caliber` 写全来源/单位/首根 09:31） |
| `src/host/em.ts:1749` | 新增 `minuteFallbackSources()`：**当日链的备用源表 = 新浪分钟 → 腾讯分钟** |
| `src/host/em.ts:1757` | 新增 `multiDayMinuteSources()`：五日链的源表（`sina-5min → tencent-5min`），供"两链同源同序"断言对齐 |
| `src/host/em.ts:1420-1446` | `trendWithFallbackRaw` 的备用段从"只问腾讯"改成**按源表逐个尝试并记下失败原因**（`failures[]`） |
| `src/host/em.ts:1845` | `fetchSina5Min` 改为复用 `fetchSinaMinuteBars`（同一 URL/同一时间解析 —— 旧实现用无偏移 `Date.parse`，`TZ=UTC` 宿主会整体偏 8 小时） |
| `src/host/em.ts:1928-1966` | `fetchMultiDayTrend` 逐源尝试并**记住是谁答的**（`source: 'sina-5min' / 'tencent-5min'`） |

> **取舍（写明）**：备用段把新浪放在腾讯之前，是为了与五日链**同源同序**。
> 代价是：东财不可达时当日分时的**均价线（VWAP）会缺失**（新浪不给均价，`caliber` 明确写"无均价线…不用价格凑"）。
> 这个代价只在"东财不可达"时才付；而那时的旧行为是**画昨天的整场** —— 日期正确优先于均价线。

### 2.2 诚实性兜底：非当日 ⇒ 带日期 + 原因（根因 ②）

| 文件:行号 | 改动 |
| --- | --- |
| `src/shared/model.ts:268` | 新增 `TrendNonSession { day, reason, detail? }` |
| `src/shared/model.ts:307/312/321` | `TrendData` 新增 `asOf`（数据观测时刻）/ `stale`（LKG 兜底）/ `nonSession`；`source` 从 `'local-stitch'` 扩成 `TrendSource`（东财/新浪/腾讯/拼接，逐条可归因） |
| `src/host/em.ts:1463-1490` | `annotate()`：`sessionDay !== 今天` ⇒ 同时给 `sessionDay` + `nonSession{day, reason, detail}`；LKG ⇒ `stale: true` + `asOf = 快照写入时刻`；**当日数据不标**（避免噪声） |
| `src/host/em.ts` `sinaMinuteTrend`/`tencentTrend`/`fetchTrendSingleDay`/`fetchMultiDayTrend` | 每个源在自己的产出上标 `source`（不再让归因靠猜） |
| `src/client/chartNote.ts:125` | `nonSessionNote(day)` 改成**全年份**：`· 非当日数据（2026-10-19）`（跨年/长期归档时 `10-19` 认不出年份） |
| `src/client/chartNote.ts:135` | 新增 `nonSessionOf(payload)`：只看宿主给的字段（`nonSession` 优先，老宿主退回 `sessionDay`），**客户端不自己算"今天"** |
| `src/client/chartNote.ts:160-166` | `cacheNoteOf` 把"非当日"提到**最前**并附原因（此前排在 `staleAt` 之后，还带一长串兜底库保留口径） |
| `src/client/QuoteDrawer.tsx:437-441` | 图头：非当日 ⇒ 时段带上数据日期（`10-19 09:30 ~ 15:00`）、多日档改口成「末行为 2026-10-19」（不再无条件写「末行为今日」） |

### 2.3 缓存键带交易日（根因 ③-a）

| 文件:行号 | 改动 |
| --- | --- |
| `src/host/em.ts:1382` | 新增 `trendCacheKey(secid, ndays, now)` = `` `trend:${secid}:${ndays}:${dayOf(now)}` `` |
| `src/host/em.ts:1398-1440` | 内存缓存/定稿复用/在飞合并**全部改用该键** ⇒ 跨交易日自然 miss（100% 回源或走"非当日"兜底且带标注） |

### 2.4 门控窗口 09:15–15:05（根因 ③-b）

| 文件:行号 | 改动 |
| --- | --- |
| `src/host/time.ts:159/183` | 新增 `inMarketWindow(ts)`：工作日 **09:15–15:05**（含集合竞价与收盘瞬时；午休照旧算在窗口内） |
| `src/host/time.ts:335` | `isSettledOffline` 的"休市"判据从 `inSession`（09:25 起）换成 `inMarketWindow`（09:15 起）⇒ **交易窗口内永不判定稿**；非交易时段行为不变 |

> 这条同时修好了 `quotes`/`kline` 的同类门控（它们共用 `isSettledOffline`）：09:15–09:25 不再把昨天的快照冻结成"定稿"。

---

## 3. 改前 / 改后 对照（同一 secid、同一"现在"）

隔离现场：`DSH_HOME=/tmp/ts-*`，预置 `2026-10-19 17:38:11` 的 LKG，`now = 2026-10-20 10:00`。

| 场景 | 链 | 改前 | 改后 |
| --- | --- | --- | --- |
| 东财熔断 + 腾讯不可达（**真机现场**） | 当日 | **2026-10-19** 09:30（LKG，`staleAt=10-19 17:38:11`，无 `nonSession`/`source`） | **2026-10-20 10:07**，`source=sina-minute`，`stale=—`，`nonSession=—`（脚注空） |
| 同上 | 五日 | 2026-10-20 10:10 | 2026-10-20 10:10（不变） |
| **三源全灭**（东财+腾讯+新浪） | 当日 | 2026-10-19（`sessionDay` 有、`nonSession` 无、脚注只说"上次成功数据"） | 2026-10-19（如实标）：<br>`nonSession={"day":"2026-10-19","reason":"当日分时未取到，显示本地兜底快照","detail":"当日分时未取到（东财 trends2：fetch failed；新浪分钟：fetch failed；腾讯分钟：fetch failed）⇒ 显示 10-19 17:38 取到的本地兜底快照"}`，`stale=true`、`asOf=10-19 17:38:11`<br>脚注：`" · 非当日数据（2026-10-19）：当日分时未取到，显示本地兜底快照"` |

改后端到端原始输出（`/tmp/probe-after.mts`）：

```
== A/B：东财熔断 + 腾讯被拦（新浪可用）==
1日: n=37 first=2026-10-20 09:31 last=2026-10-20 10:07 sessionDay=— stale=— asOf=2026-10-20 10:00:00 source=sina-minute
     caliber: 来源：新浪 1 分钟线（当日分时的备用源） · 时区：北京 · 不复权（分时序列无除权概念） · 成交量单位：手（上游给股数，已 ÷100） · 首根为 09:31（上游不给 09:30 那根） · 无均价线（新浪不提供均价；不用价格凑） · 昨收＝2026-10-19 最后一根分钟收盘（非交易所官方收盘）
5日: n=200 first=2026-10-14 09:35 last=2026-10-20 10:10 sessionDay=— source=sina-5min
```

改后**图头**文案（`QuoteDrawer`，非当日时；旧文案在括号里）：

| 档 | 改后 | 改前（会被读成今天） |
| --- | --- | --- |
| 单日 | `昨收 4.24 · 10-19 09:30 ~ 15:00` + 脚注 `非当日数据（2026-10-19）：当日分时未取到，显示本地兜底快照` | `昨收 4.24 · 09:30 ~ 15:00` + `上次成功数据（10-19 15:00）· 本地兜底（…保留口径…）` |
| 多日 | `共 5 个交易日 · 10-14 ~ 10-19（末行为 2026-10-19）` | `共 5 个交易日 · 10-14 ~ 10-19（末行为今日）` |

---

## 4. 断言 + 反例注入（必败读数）

新增两个断言文件（每条都配"注入后必红"的反例）：

**`src/host/trendNonSession.test.ts`（10 条）**

| # | 断言 | 反例注入 ⇒ 读数 |
| --- | --- | --- |
| ① | 交易时段内，当日分时最后一点 == 当日；跨日必须回源（`calls` +1）；`trendCacheKey` 跨日不同 | 键去掉交易日 ⇒ 旧键命中 10-19 ⇒ `AssertionError … actual '2026-10-19' expected '2026-10-20'` **FAIL** |
| ② | 同一时刻 1 日与 5 日**同日**；备用链逐源尝试（第一源挂也要试第二源）；两链提供者顺序相同（`新浪 → 腾讯`） | 备用链只剩腾讯（修复前形状）⇒ 1 日 = 10-19 ⇒ "两条链同日" **FAIL** |
| ③ | 非当日必须带 `day` + `reason` + `detail` + `stale` + `asOf`；脚注首句 = `非当日数据（2026-10-19）：<原因>` | 摘掉 `nonSession`/`sessionDay`（修复前回包形状）⇒ "非当日必须常驻" **FAIL** |
| ④ | 09:15/09:16/09:20/09:25/10:00/11:30/12:30/14:59/15:00/15:04 **一律不判定稿**；15:06 起才可免回源；09:20 端到端必须回源（`upstreamCalls=1`） | 旧口径（`inSession` 09:25 起）⇒ 09:20 `settled=true` ⇒ "交易窗口内不得判定稿" **FAIL** |
| ⑤ | 昨天的快照不得当今天的定稿（20:00 也回源）；同一天的定稿仍复用（`cached=true`、0 回源）；跨日 `isSettledOffline=false` | 键与门控都不看日期 ⇒ 跨日命中昨天 ⇒ "跨日不复用" **FAIL** |

**`src/client/nonSessionUi.test.ts`（2 条）+ `src/client/chartNote.test.ts`（+2 条）**

| # | 断言 | 反例注入 ⇒ 读数 |
| --- | --- | --- |
| UI ② | 图头必须读 `nonSession`；单日段非当日时用 `slice(5)`（带日期）；多日档不许无条件「末行为今日」 | 恢复旧写法（恒 `slice(11)` + 「末行为今日」）⇒ 判据非空 + **FAIL** |
| 脚注 ① | 非当日 + 原因**排在**「上次成功数据」之前；兜底库保留口径不得挤掉它；老宿主只有 `sessionDay` 也要写日期 | 优先级退回 `staleAt` ⇒ `actual ' · 上次成功数据（…）'` ⇒ **FAIL** |

门禁读数：

```
ℹ tests 934  ℹ pass 934  ℹ fail 0        # 本地时区
ℹ tests 934  ℹ pass 934  ℹ fail 0        # TZ=UTC
ALL HOST CHECKS PASSED (live probes soft)
built lib/index.js + lib/client.js （v0.111.0，客户端片段校验通过：73 项）
```

- 基线 **920**（`4e433ba`）→ 现在 **934**：`+10`（`trendNonSession.test.ts`）+ `+2`（`nonSessionUi.test.ts`）+ `+2`（`chartNote.test.ts` 新增）。
- 既有断言**没有放宽**：唯一被改的既有断言是 `chartNote.test.ts` 里 `非当日数据（10-01）` → `非当日数据（2026-10-01）`
  ——**收紧**（全年份），不是放宽。
- 缺失仍如实缺失：非当日/无源一律给 `reason`/`detail`，**没有**用 0 或空数组顶替（`avg` 缺失就是 `null`）。

---

## 5. 判据边界（这份改动**不**声称的事）

- `/tradewatcher/trend` **不**宣称"上游一定可达"：三源全灭时仍然回昨日 LKG —— 但**必须**带
  `nonSession{day,reason,detail}`，界面第一句就是「非当日数据（YYYY-MM-DD）：原因」。
- **不**宣称"当日分时一定有均价线"：新浪备用源不给均价，`caliber` 明写缺失原因（不用价格凑 VWAP）。
- **不**宣称"两条链永远同源"：东财仍是当日链的第一优先（只有它有 VWAP + 每分钟成交额）；
  保证的是**备用段同源同序**（新浪 → 腾讯），以及"任一源可用 ⇒ 两条链同日"。
- `nonSession` 只说"这份数据属于哪天 + 为什么没取到今天的"，**不是**买卖信号，也不评价数据好坏。

---

## 6. 未做项 / 后续

1. **腾讯分钟换域名**：`fetchTencentMinutes` 用 `web.ifzq.gtimg.cn`（本机 WAF 501），而同一 API 在
   `proxy.finance.qq.com/ifzqgtimg/appstock/app/minute/query` 实测 **200 且是当日**（五日链/rescue 用的就是该域名族）。
   换过去会让腾讯分钟也恢复 —— 但它同时被 `rescue.ts`（护盘采样）使用，属**另一条链的行为变更**，本批不动。
2. **`mini.ts` 的 90s 缩略图缓存**键仍是 `secid`（无日期）：跨日在 90s 窗口内理论上可复用昨日形状。
   缩略图没有文字承载面（改动价值低、风险在别处），本批不动。
3. **`parseTrendRow` 的 `t` 没有显式 `+08:00`**（东财标签是北京墙上时间）：`TZ=UTC` 宿主上该字段偏 8 小时；
   界面/判定全部走 `label`（日期取 label 前 10 位），故未影响本问题，单独登记。
4. 跑着的 `dsh web` 仍是旧构建（未重启，遵守约束）：**真机验证需要重新构建客户端并重启**后按 §1.1 复测
   （预期：`ndays=1` 的 `source` 变为 `sina-minute`/`eastmoney-trends2`，`last` 为当日；三源全灭时脚注首句为「非当日数据（YYYY-MM-DD）：原因」）。
5. 版本号未改（v0.111.0）：发版是原子动作（见 `docs/DECISIONS.md`），由发版流程统一 bump。
