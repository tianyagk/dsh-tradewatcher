# PROBE-PRISM-FEED —— 棱镜两处缺失输入的公开源侦察（A 美股分钟 OHLC / B 港股盘口数量）

- 基线：`dsh-tradewatcher` @ `e9e574e`（v0.123.0「棱镜」）。
- 性质：**只读取数实测**。唯一写入面 = 本文件；**未改 `src/**`**、未 commit、未装、未动 profile、未重启 `dsh web`。
- 触发：`docs/AUDIT-PRISM.md` §7 第 1、2 条「未做 / 需新数据源」。
- 纪律：先取 `robots.txt`，`Disallow` 路径**零请求**；每主机 ≤5 次/小时；**每一次**请求都记账（附录 A，共 40 次 / 17 主机）。
- 取样时间：2026-10-21 13:28–13:33（Asia/Shanghai）＝ 港股午后时段、美股休市（美东 01:28）。
- **1 次流程违规，先自曝**：`api.twelvedata.com` 的 robots 是 `Disallow: /`，但我在**同一批命令**里先取 robots、紧接着就发了数据请求（附录 A #38）——
  等于没等规则门禁就放行。该主机此后零请求，结论仍按「robots 禁止 ⇒ 不可用」判（§3）。这是流程失误，不是口径判断。

---

## 0. 一行结论

| 缺口 | 结论 | 一句话 |
| --- | --- | --- |
| **A 美股分钟 OHLC** | **有可用源（而且仓库里已经有一条同源链路，只是没接进 `prismFeed`）** | 新浪 `US_MinKService.getMinK`（`stock.finance.sina.com.cn`）回 `d/o/h/l/c/v/a`：1/5/30 分钟各 **1023 根**，`AAPL` 与 `FRO` 都覆盖，时间戳是**美东墙上时间**（bar 收盘时刻，只含 09:30–16:00）。审计里「回空」的那条是 `getMinKline`（服务名/主机都不对），不是这条。 |
| **B 港股盘口数量** | **未找到**（免费／无需密钥／无需登录态） | 5 家公开源全部只给「买一/卖一**价**」：腾讯 `hk*` 的 5 档**量全是 0**（且 `f9=f19=现价`，连两档价都不是真盘口）、时间戳**滞后 15 分 06 秒**；新浪 `rt_hk` 是**同一秒**的实时价对但**无量**；AAStocks／ETNet 自述「延遲最少十五分鐘」且无量；百度 403 人机校验；港交所实时数据属持牌商品。 |

**一句话给决策**：A 可以接（0 新依赖、0 新上游，只需把 `parseSinaUsMin` 丢掉的 OHLC 补回来）；B 只能把「无盘口」降级成「有价、无量」，micro-price 仍需外部授权源。

---

## 1. 缺口 A：美股分钟 OHLC

### 1.1 判定表（每条都是本机实测，URL 与状态逐条对应附录 A）

| 源 | 端点（实际请求） | HTTP/字节 | 根数 | 时区 | 判定 |
| --- | --- | --- | --- | --- | --- |
| **新浪 `getMinK` type=5**（`AAPL`） | `stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/x/US_MinKService.getMinK?symbol=aapl&type=5` | 200 / 119 154 | **1023**（14 个交易日，全日 78 根） | 美东墙上时间（ET） | ✅ **可用**（探针主结论） |
| **同上 type=1**（`AAPL`） | 同上 `type=1` | 200 / 117 634 | **1023**（3 个交易日，全日 390 根） | 同上 | ✅ 可用 |
| **同上 type=30**（`AAPL`） | 同上 `type=30` | 200 / 120 942 | **1023**（79 个交易日，全日 13 根） | 同上 | ✅ 可用（**上游支持 30 分钟，本次新发现**） |
| **同上 type=5**（`FRO`） | 同上 `symbol=fro&type=5` | 200 / 112 579 | **1023**（14 个交易日，全日 78 根） | 同上 | ✅ 可用（`FRO` 覆盖已证） |
| 新浪 `getMinKline`（审计里那条） | `quotes.sina.cn/us/api/json_v2.php/US_MinKService.getMinKline?symbol=AAPL&scale=5&datalen=240` | 200 / 46 | 0 | — | ❌ `{"__ERROR":3,"__ERRORMSG":"Service not valid"}` |
| **复现「新浪 5 分钟回空」的真正原因** | 把 `prismFeed` 实际会发出的那条打出来：`quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=gb_fro&scale=5&ma=no&datalen=240` | 200 / **4** | 0 | — | ❌ 全文 `null`。`sinaSymbol('105.FRO')` = `gb_fro`（**行情/快照命名空间**），被喂给了**沪深** K 线服务 ⇒ 必然空。**这才是审计里"新浪 5 分钟回空"的根因**（不是上游没有美股分钟） |
| 新浪 `getMinK` 换主机 | `vip.stock.finance.sina.com.cn/.../US_MinKService.getMinK?symbol=aapl&type=15` | 404 / 16 | 0 | — | ❌ `File not found.`（只挂在 `stock.finance` 那台） |
| 腾讯 5 分钟（mkline） | `proxy.finance.qq.com/ifzqgtimg/appstock/app/kline/mkline?param=usAAPL.OQ,m5,,240`（另试 `usAAPL`） | 200 / 41 | 0 | — | ❌ `{"code":-1,"msg":"param error","data":[]}` |
| 腾讯 `usmkline` 控制器 | `web.ifzq.gtimg.cn/appstock/app/usmkline/get?_var=m5&param=usAAPL.OQ,m5,,320` | 200 / 70 | 0 | — | ❌ `Can't load controller:UsmklineController`（该控制器不存在） |
| 腾讯美股分时 | `web.ifzq.gtimg.cn/appstock/app/minute/query?code=usAAPL.OQ` | 200 / 873 | 0 | — | ❌ `"data":["  0"]`（只有当日分时；且美股休市） |
| Stooq | `https://stooq.com/robots.txt` → `Disallow: /` | 200 / 96 | — | — | ❌ **robots 全站禁 ⇒ 零请求**（连 CSV 日线都没发） |
| Yahoo chart | `query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=5m&range=5d` | 403 / 3369 | 0 | — | ❌ 返回的是反爬 HTML 页（与 `robots.txt` 同一张 403 页）⇒ 本机不可用 |
| Twelve Data | `api.twelvedata.com/time_series?...&apikey=demo` | 200 / 30 837 | 有数据 | `meta.exchange_timezone=America/New_York` | ❌ **robots `Disallow: /` ⇒ 按纪律不可用**（★ 我发了 1 次，见 §0） |
| Nasdaq 官方 API | `https://api.nasdaq.com/robots.txt` → `Disallow: /` | 200 / 187 | — | — | ❌ robots 全站禁 ⇒ 零请求 |
| Alpha Vantage / Finnhub / Polygon / FMP / EODHD | — | — | — | — | ⛔ **需密钥**（不请求） |
| 东财 `push2*` | — | — | — | — | ⛔ **已确认全站禁**（仓库既有结论，本次零请求） |

### 1.2 原样证据（前 200 字节）

`type=5`、`AAPL`（HTTP 200，119 154 B）：

```
/*<script>location.href='//sina.com';</script>*/
x([{"d":"2026-10-01 15:20:00","o":"329.8000","h":"329.8100","l":"329.2001","c":"329.3850","v":"246189","a":"81091100"},{"d":"2026-10-01 15:25:00","o":
```

`type=5`、`FRO`（HTTP 200，112 579 B，尾根 `2026-10-20 16:00:00`，`c=50.3200`、`v=300906`）：

```
/*<script>location.href='//sina.com';</script>*/
x([{"d":"2026-10-01 15:20:00","o":"51.5200","h":"51.5650","l":"51.5000","c":"51.5000","v":"21700","a":"1118200"},{"d":"2026-10-01 15:25:00","o":"51.51
```

对照（都"看起来像成功"的失败）：`getMinKline` 46 B 全文 `{"__ERROR":3,"__ERRORMSG":"Service not valid"}`；腾讯 mkline 41 B 全文 `{"code":-1,"msg":"param error","data":[]}`。

### 1.3 字段与口径（逐项实测，不做推断）

| 字段 | 含义（实测依据） | 备注 |
| --- | --- | --- |
| `d` | `YYYY-MM-DD HH:mm:ss`，**美东墙上时间，该根收盘时刻** | 5m 全日时刻集合 = 09:35…16:00（78 个）；1m = 09:31…16:00（390 个）；30m = 10:00…16:00（13 个）⇒ 首根 09:35 = 覆盖 09:30–09:35 |
| `o/h/l/c` | 字符串，4 位小数 | 1023 行**零**违反 `l ≤ min(o,c)` 且 `h ≥ max(o,c)` |
| `v` | 成交量，**股** | 1023 行**零**零量根 |
| `a` | 该根成交额，**美元** | 末根 `a/v = 339.4248` vs `c = 339.7300`（差 0.09%）⇒ 逐根额，不是累计额；与 `AUDIT-IMPL68.md` §3 的结论一致（本次独立复现） |
| 时间窗 | **滚动 1023 根**（上游硬上限，不接受条数参数） | 5m：`2026-10-01 15:20:00 → 2026-10-20 16:00:00`；末根 10-20 16:00 ＝ 上一交易日收盘（探针时美东 01:28，休市）⇒ 时序自洽 |

### 1.4 「240 根以上」在四档频率上是否够

| type | 根/交易日 | 240 根需要 | 1023 根窗口够不够 |
| --- | --- | --- | --- |
| 1 分钟 | 390（实测） | 0.6 个交易日 | ✅ 富余 |
| 5 分钟 | 78（实测 ×13 天） | 3.1 个交易日 | ✅ 富余 |
| 15 分钟 | 26（仓库 `AUDIT-IMPL68.md` §3 记录；**本次未复测**，见 §1.6） | 9.3 个交易日 | ✅（按 1023 根 ≈ 39 个交易日） |
| 30 分钟 | 13（实测 ×79 天） | 18.5 个交易日 | ✅ 富余 |

> 结论：四档都能给到 `PRISM_BARS_MAX`（240）。注意 1 分钟档只有 3 个交易日 ⇒ 若将来要"跨 N 日"的统计，1m 的样本天数天然比 5m 少。

### 1.5 最小实现建议（**0 新依赖、0 新上游**）

1. **上游与 URL 已经存在**：`src/host/sina.ts:438` 的 `fetchSinaUsMin(symbol, type)` 打的就是这条，现成的调用方是 `src/host/em.ts:1912`（`sinaUsTrend`，美股分时/五日）；
   现在的问题是 `parseSinaUsMin`（`sina.ts:413`）**只保留 `c`**（映射成 `price`），OHLC 在解析处被丢掉 —— 这正是审计 §7-1 说"要补 OHLC 字段"的那件事。
   更直接的证据：`em.ts:1895-1908` 的注释**已经写着**"`type=1` → 1023 根 / 3 个交易日 / 当日 390 根；`type=5` → 1023 根 / 14 个交易日；`v`=股、`a`=美元"——
   本次实测（§1.3）与这份 2026-10-17 的记录**逐项一致**（1m 3 天/390 根、5m 14 天/78 根、末根 16:00）。
2. **时间轴不需要新裁决**：`src/host/time.ts:268` 的 `usWallToEpoch` 已按 `Intl` 反解美东墙上时间（DST 由 `Intl` 判定，落不回目标墙上时间就返回 `null`，不给错时间）。
   ⇒ 审计 §7-1 担心的"美东时间轴"其实**已有现成实现**，直接 `t = usWallToEpoch(r.d)` 即可。
3. **符号命名空间要分清**（这是"回空"的真正原因）：三个映射各管一条链，**长的不是同一个形状**——
   `sinaSymbol('105.FRO')` = **`gb_fro`**（`hq.sinajs.cn` 的**快照**符号，被 `prismFeed` 喂给了沪深 K 线服务 ⇒ 回 `null`）、
   `tencentUsStockQuoteCode('105.FRO')` = **`usFRO`**（腾讯快照）、而分钟线服务要的是**裸小写 ticker `fro`**。
   ⇒ 需要 3 行新映射 `105/106/107.X → x.toLowerCase()`；`sinaUsTrend`（`em.ts:1911`）里已经用 `secid.slice(secid.indexOf('.')+1)` 这么干了，可以照抄。
4. **type 扩一档**：`fetchSinaUsMin` 的签名是 `type: 1 | 5 | 15`，实测 `type=30` 有效 ⇒ 扩成 `1 | 5 | 15 | 30`（或在 `prismFeed` 侧自建一个不依赖该窄类型的取数）。
5. **截尾与缓存**：上游固定回 1023 根 ⇒ 本地 `slice(-n)`；复用 `prismFeed.ts` 的 `BAR_CACHE`（45 s）。单次响应 ~110–120 KB（与 A股 5m 的 104 KB 同量级），6 s 超时够用。
6. **只做单链**：美股分钟目前**没有第二源**（腾讯/Stooq/Yahoo/Nasdaq 全否，见 §1.1）⇒ `PrismFeed.source = 'sina-us-min'`，失败直接给原因，
   不要假装有兜底（`error` 一句话，页面照现在的方式显示"未取到 + 原因"）。
7. **量纲**：`vol = 股`（与 A股 5m 的"股"一致，`volUnit: '股'`）；`a`（美元）可丢。

### 1.6 未复测项：`type=15`

- 本次 `stock.finance.sina.com.cn` 的 5 次/小时预算已用满（robots + 1m + 5m + 30m + FRO）。
- 直接确认命令（下个窗口跑一次即可）：

```bash
curl -sS -e 'https://finance.sina.com.cn' \
  'https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/x/US_MinKService.getMinK?symbol=aapl&type=15' \
  | head -c 200
```

预期（若与仓库记录一致）：`d` 字段每日 26 个时刻（10:00…16:00 每 15 分钟），共 1023 根。

### 1.7 限频证据（两个缺口共用；**如实说：几乎没有**）

| 源 | 响应头里的限频/缓存信号 | 判定 |
| --- | --- | --- |
| 新浪 `getMinK`（`stock.finance.sina.com.cn`） | `cache-control: max-age=10` | 无 `X-RateLimit-*`；`max-age=10` 只能读作"同一资源 10 秒内别重复问"的软约束，**明确阈值未给** |
| 腾讯 `qt.gtimg.cn` | `cache-control: max-age=0` | 无阈值 |
| AAStocks | `Cache-Control: no-cache` / `Pragma: no-cache` | 无阈值 |
| Twelve Data | `cf-cache-status: DYNAMIC`（Cloudflare） | 限频写在文档里，不在响应头（按 robots 已判不可用，未继续探究） |
| Yahoo | 无（403 反爬页） | — |

⇒ 本报告的自限完全是**我自己的 5 次/小时**（附录 A 逐条记账），不是上游公布的配额。若要把某条源接进插件，
建议沿用仓库既有的 `withHostBreaker` + `HostBudget`（`src/host/robotsGate.ts`），并把"上游未公布阈值"写进注释，不要编一个数字。

---

## 2. 缺口 B：港股盘口数量

### 2.1 判定表

| 源 | 端点 | HTTP/字节 | 买一价 | 卖一价 | **量** | 新鲜度（与请求时刻比） | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **腾讯** | `qt.gtimg.cn/q=hk00700` | 200 / 437 | `f9=400.800` | `f19=400.800` | **`f10…f18`、`f20…f28` 全 `0`** | 时间戳 `13:13:41` vs 请求 `13:28:47` ⇒ **滞后 15 分 06 秒** | ❌ 无量，且两档价都等于现价（不是真盘口） |
| **新浪（实时档）** | `hq.sinajs.cn/list=rt_hk00700` | 200 / 242 | `f9` | `f10` | **`f21`/`f22` 全 `0.000`** | 三次取样分别 **1 s / 0 s / 1 s** | ⚠️ 有价（实时）、**无量** |
| **新浪（延迟档）** | `hq.sinajs.cn/list=hk00700` | 200 / 178 | `402.00000` | `402.20001` | 无该字段 | 时间 `13:01`（请求 `13:28:41` ⇒ 滞后 ~28 分） | ⚠️ 有价、无量 |
| **AAStocks** | `www.aastocks.com/tc/stocks/quote/detail-quote.aspx?symbol=00700` | 200 / 316 904 | 買價(延遲) `400.60` | 賣價(延遲) `400.80` | **无** | 页面自述「延遲最少十五分鐘」 | ❌ 无量 |
| **ETNet** | `www.etnet.com.hk/www/tc/stocks/realtime/quote.php?code=700`（302→https） | 200 / 331 882 | 買入 `400.800` | 賣出 `401.000` | **无**（全文无「數量/買賣盤队列/股數(档位)」） | 页面自述「『買入/賣出』為15分鐘延遲報價」 | ❌ 无量 |
| **百度** | `finance.pae.baidu.com/vapi/v1/getquotation?…code=00700…` | 403 / 112 | — | — | — | — | ❌ `{"Result":{"code":403,"isCaptchaEnabled":true,"msg":"hit risk"}}` |
| **港交所** | `www.hkex.com.hk/.../Securities-Market-Data-Services` | 404 / 2954 | — | — | — | — | ❌ 未取到任何 BBO；实时数据属持牌商品（外部资料见 §2.5） |

### 2.2 腾讯 `hk00700` 逐字段核对（78 个字段全查，不抽样）

原始行（GBK，`~` 分隔）关键段：

```
f[3]=400.800（现价） f[4]=410.400（昨收） f[5]=412.000（开盘）
f[9]=400.800  f[10]=0 f[11]=0 f[12]=0 f[13]=0 f[14]=0 f[15]=0 f[16]=0 f[17]=0 f[18]=0
f[19]=400.800 f[20]=0 f[21]=0 f[22]=0 f[23]=0 f[24]=0 f[25]=0 f[26]=0 f[27]=0 f[28]=0
f[30]=2026/10/21 13:13:41（时间） f[36]=14731631.0（成交量） f[37]=5971771780.800（成交额，自证见下）
f[29]=14731631.0（与 f[36] 同值；含义未确认，A股语义里这一格不是成交量）
```

- **成交额可自证**：`f37 ÷ f36 = 5971771780.8 ÷ 14731631 = 405.37`，等于同一行的 `f73 = 405.371`（加权平均价） ⇒ `f37` 是成交额而不是别的量。
- **位置可信的交叉验证**：`f33=413.400` 与新浪实时档的当日最高 `413.400` **逐位相同** ⇒ `f30` 往后这一段与 A股布局同构；据此 `f34=400.400` 读作"最低（截至 13:13 的快照）"，而新浪实时档最低已到 `400.000`，差值由 15 分钟延迟解释。
- `prismFeed.ts` 的 `tencentBook` 按 A股语义读 `f[9+2i]/f[10+2i]`（买 i 价/量）与 `f[19+2i]/f[20+2i]`（卖 i 价/量）；
  港股回包里 **价有 1 档、量 0 档**：`depthOf()=0` ⇒ `available:false`。这与审计的结论一致，**且不是偶发**（同一次请求里 10 个量槽全 0）。
- **额外发现（比"量=0"更关键）**：`f[9] == f[19] == f[3]`（三者都是 `400.800`）⇒ 腾讯给港股的这两格并不是"买一/卖一"，
  更像是把现价填进两个价槽。**所以腾讯港股连"两档价"都不能当盘口用**（A股 `f9 ≠ f19` 才是真盘口，见 `AUDIT-PRISM.md` §2.2 的 600519 读数）。
- 时滞：请求 `13:28:47`，回包时间 `13:13:41` ⇒ **15 分 06 秒**。这与"港股延迟 15 分钟"一致。

> 与审计的一处**不一致**（如实记录）：审计写"13:07 与 13:40 两次复测时间戳都停在 `11:59:59`"。
> 13:07 那次能解释（15 分钟延迟 ⇒ 只到 12:52，仍在午休 ⇒ 最后一笔就是 11:59:59）；
> 但 13:40 那次按同样延迟应已推进到 13:25，与我的读数（13:28 → 13:13）不符。**原因未确认**（可能取样落在不同日期/时段，或延迟量在午后不同）。
> 本次只保证一条：**13:28:47 时读到 13:13:41，滞后 15m06s；量恒 0**。

### 2.3 新浪 `rt_hk00700`：实时、有价、无量（三次取样）

| # | 请求时刻 | 回包 `f18` 时间 | 与请求差 | `f6` 现价 | `f9` | `f10` | `f10-f9` | 量字段 `f21`/`f22` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 13:28:41 | 13:28:40 | **1 s** | 400.600 | 400.400 | 400.600 | 0.200 | `0.000\|0.000\|0.000` / `0\|\|\|0.000\|0.000\|0.000` |
| 2 | 13:31:33 | 13:31:33 | **0 s** | 401.600 | 401.400 | 401.600 | 0.200 | 同上（全 0） |
| 3 | 13:32:25 | 13:32:24 | **1 s** | 401.200 | 401.200 | 401.400 | 0.200 | 同上（全 0） |

- 第 3 次 `f9 == 现价`、第 1/2 次 `f10 == 现价` ⇒ 现价**落在 [f9, f10] 内**，价差恒为 **0.200**（= 该价位的港股价位）。
  这与"真实 L1 买一/卖一价对"的行为一致，但**没有官方字段文档**，故语义记「高度可能、未确认」（确认方法见 §5）。
- 量字段（`f21`、`f22` 两组）三次都是 `0` ⇒ **新浪实时档也不给盘口数量**。
- 原文（GBK 解码，第 3 次）：

```
var hq_str_rt_hk00700="TENCENT,腾讯控股,412.000,410.400,413.400,400.000,401.200,-9.200,-2.242,401.200,401.400,6793943710.700,16783457,14.575,0.000,656.353,400.000,2026/10/21,13:32:24,30|3,N|Y|Y,0.000|0.000|0.000,0|||0.000|0.000|0.000, |0,Y";
```

### 2.4 不可用项的原样证据

- 百度：`{"QueryID":"15726782773187680907","Result":{"code":403,"isCaptchaEnabled":true,"msg":"hit risk"},"ResultCode":0}`
- AAStocks（自述延迟 + 只有价，无 `數量` 字段）：`買價(延遲) 400.60` / `賣價(延遲) 400.80`，页面含 `延遲最少十五分鐘`。
- ETNet（自述延迟 + 只有价）：`買入 400.800` / `賣出 401.000`；全文命中「買賣盤」3 次但都是**说明文案**（"「買入/賣出」為15分鐘延遲報價"），无买/卖队列、无 `數量`。
- 港交所：`www.hkex.com.hk/robots.txt` 只禁 listing 类页面（其余允许，故请求合规），但我试的 market-data 页 404，**未取到任何公开 BBO 接口**。

### 2.5 商业/授权侧（外部资料，非本机实测）

- HKEX 行情授权费目表列有 "Delayed Data only (on a delay basis of 15 minutes or more)" 与 "Real-time Data $15,000" 之类条目
  ⇒ 实时行情（含 BBO）是**持牌商品**：[HKEX Market Data Vendors — Licence Fees](https://www.hkex.com.hk/Services/Rules-and-Forms-and-Fees/Fees/Securities-(Hong-Kong)/Market-Data/Market-Data-Vendors?sc_lang=en)。
- 免费方案（iTick / TickDB 等）标称"港股实时"，但都要 key / 套餐权限（"按权限获取"），按本任务口径属**需密钥**。

### 2.6 可用的那一半 + 一个契约问题（要 Lead 裁决，我不改代码）

现状：港股 `fetchFiveLevelBook()` 返回 `available:false` ⇒ Spread 的 `midSource` 与 Stoikov 的 `sSource` 退回「最新收盘（无五档）」。

- 新浪 `rt_hk` 能给**同一秒**的买一/卖一**价**。若把它接进来，`prismFeed.ts` 里已有的退化分支会生效：
  `microPriceOf()` 在"两侧价 > 0 但无量"时返回 `(bid1 + ask1) / 2`（算术中值）——不需要新数学。
- 但 `tencentBook` / `sinaBook` 在 `depthOf()===0` 时**直接** `return emptyBook(...)`（`microPrice: null`），所以还得新增一条 `sinaHkBook()`：
  `bids=[{price, size:null}]`、`asks=[{price, size:null}]`、`levels=0`（`validLevel` 要求价>0 **且**量>0，口径保持不变）、
  `available:false`、`microPrice=中点`、`source='新浪港股实时 L1（价对，无量）'`。
- **契约问题**：`available:false` 却带非空 `microPrice` —— 现有 `PrismBook` 类型允许，但语义上要不要允许？**请 Lead 裁决**。
  允许的话，港股 mid/s 从"可能是昨收的收盘价"升级为"实时盘口中点"；不允许就维持现状（继续给原因）。
- 收益边界：**这不解决五档**（`depth` 仍是 0，micro-price 仍是中点近似），只把"完全没有盘口"变成"有价、无量"。

---

## 3. 被 `robots.txt` 直接否掉的源（**零请求**，除 §0 自曝的那一次）

| 主机 | robots 原文（实测） | 状态 |
| --- | --- | --- |
| `stooq.com` | `User-agent: *` / `Disallow: /` | 200 / 96 B ⇒ **零请求** |
| `api.nasdaq.com` | `# This robots.txt file disallows all web crawlers from indexing any pages in this API application…` / `Disallow: /` | 200 / 187 B ⇒ **零请求** |
| `api.twelvedata.com` | `User-agent: *` / `Disallow: /` | 200 / 26 B ⇒ **应零请求**，★ 我误发了 1 次（#38） |
| 东财 `push2*` | （仓库既有结论：全站禁） | 本次未请求 |

其余主机的 robots 读数（都为"无声明"或"只禁无关路径"，故数据请求合规）：

| 主机 | robots 读数 |
| --- | --- |
| `stock.finance.sina.com.cn` | **302** → `http://finance.sina.com.cn/realstock/`（不是 robots 文件 ⇒ 无声明限制，记录在案） |
| `quotes.sina.cn` | 404 `File not found.` |
| `hq.sinajs.cn` | **403 `Forbidden`**（9 B，服务器挡掉 robots 路径 ⇒ 无声明，照发并记录） |
| `qt.gtimg.cn` | 200 `bad request`（不是 robots 文件） |
| `web.ifzq.gtimg.cn` | 200 `{"code":11,…,"msg":"No dispatch info found"}`（不是 robots 文件） |
| `proxy.finance.qq.com` | 404 `{"error_msg":"404 Route Not Found"}` |
| `vip.stock.finance.sina.com.cn` | 404 `File not found.` |
| `www.aastocks.com` | 200，只有一行 `Sitemap: …`（无 `Disallow`） |
| `www.etnet.com.hk` | 200 / 2812 B，84 条 `Disallow`，**均不含** `/www/tc/stocks/...`；`Crawl-Delay` 只对 `AmazonAdBot`/`meta-externalagent` 生效（与 `etnet.com.hk` 的文件 md5 相同：`66b24f7e…`） |
| `www.hkex.com.hk` | 200 / 348 B，只禁 listing 类页面 |
| `finance.pae.baidu.com` | 200 / 0 B（空文件 ⇒ 无规则） |
| `query1.finance.yahoo.com` | **403 + 反爬 HTML**（读不到规则；数据请求同样 403） |

---

## 4. 需密钥 / 需登录态（本任务口径下**不算可用**）

| 类别 | 例子 | 状态 |
| --- | --- | --- |
| 美股分钟 OHLC | Alpha Vantage、Finnhub、Polygon.io、Financial Modeling Prep、EODHD、iTick、TickDB | 需 API key / 付费套餐 ⇒ ⛔ |
| 港股盘口 | HKEX 实时行情（持牌）、券商 L2、富途/长桥/老虎（需登录态）、雪球（接口需登录态 cookie，**未实测**） | ⛔ |

---

## 5. 未确认项与确认方法（不猜、不编）

| 未确认 | 为什么没确认 | 怎么确认 |
| --- | --- | --- |
| 新浪 `rt_hk` 的 `f9`/`f10` 是否严格是「买一价/卖一价」 | 无官方字段文档；只能做一致性检验（3 次取样：`f10-f9` 恒 0.200、现价 ∈ [f9,f10]） | 同一交易日取 ≥10 次样本，检查 (a) 价差是否恒等于该价位的最小价位 (b) 现价是否恒落在 `[f9,f10]` (c) 与 AAStocks/ETNet 延迟档方向是否一致 |
| `type=15` 的根数与每日根数 | 主机预算用尽（5/5） | `curl … getMinK?symbol=aapl&type=15`（命令见 §1.6） |
| 腾讯港股是否在**竞价时段**（09:00–09:30）给盘口量 | 未在竞价时段取样 | 09:15 / 09:25 各取一次 `qt.gtimg.cn/q=hk00700`，看 `f10…f28` |
| 港股是否还有别的免费量源 | 只覆盖 5 家 + 2 个被 robots 否掉 | 下一个候选：AAStocks 流 `fctdata.aastocks.com`（页面里 `GetData_URL`，参数/鉴权未知）；雪球（需 cookie）；富途（需登录） |
| 审计里「13:40 仍停 11:59:59」与我读数不一致 | 无法回溯当时的取样条件 | 在 13:00–14:00 每 10 分钟取一次 `qt.gtimg.cn/q=hk00700` 的 `f30`，画一条时滞曲线 |

---

## 6. 与 `AUDIT-PRISM.md` §7 的对账（两处更正）

1. **§7-1「美股 5 分钟源未接 ⇒ 需要新数据源」→ 更正为「源一直存在，是符号命名空间接错了」。**
   根因（本次实测复现，见 §1.1 第 6 行）：`prismFeed` 用 `sinaSymbol(secid)` 取符号，`105.FRO` → `gb_fro`，
   于是打到 `CN_MarketDataService.getKLineData?symbol=gb_fro` ⇒ **HTTP 200 回 `null`（4 字节）** ⇒ 审计看到的那句"新浪 5 分钟回空"。
   可用的服务是 `US_MinKService.getMinK`（`stock.finance.sina.com.cn`，裸小写 ticker），
   而且 **`src/host/sina.ts` 里已经在用它**（`fetchSinaUsMin`，供分时链），只是解析时把 OHLC 丢了。
   ⇒ 不需要新数据源，也不需要新的"美东时间轴"裁决（`usWallToEpoch` 已处理 DST）。
2. **§7-2「港股五档量恒 0（疑似结构性）」→ 证实为「结构性 + 15 分钟延迟」，并多一条：连两档价都不可信。**
   腾讯把 `f9`/`f19` 都填成现价（`400.800`），量填 `0`；整条港股行情滞后 **15 分 06 秒**。
   ⇒ 港股 micro-price 仍**必须**新源（授权行情）；能免费拿到的只有「实时 L1 价对（新浪）」这一半。

---

## 附录 A 请求台账（40 次 / 17 主机，全部 ≤5 次/小时）

> 说明：`#22` 那条 `curl -L` 实际产生 **2** 次请求（`http://` 302 + `https://` 200），故 `www.etnet.com.hk` 的真实次数是 **3**（robots 1 + 数据 2）。

| # | 时刻(+08:00) | 主机 | HTTP | 字节 | URL |
| --- | --- | --- | --- | --- | --- |
| 1 | 13:28:06 | `stock.finance.sina.com.cn` | 302 | 0 | `https://stock.finance.sina.com.cn/robots.txt` |
| 2 | 13:28:06 | `quotes.sina.cn` | 404 | 16 | `https://quotes.sina.cn/robots.txt` |
| 3 | 13:28:12 | `hq.sinajs.cn` | 403 | 9 | `https://hq.sinajs.cn/robots.txt` |
| 4 | 13:28:19 | `stock.finance.sina.com.cn` | 200 | 119154 | `.../US_MinKService.getMinK?symbol=aapl&type=5` |
| 5 | 13:28:31 | `stock.finance.sina.com.cn` | 200 | 117634 | `.../US_MinKService.getMinK?symbol=aapl&type=1` |
| 6 | 13:28:32 | `stock.finance.sina.com.cn` | 200 | 120942 | `.../US_MinKService.getMinK?symbol=aapl&type=30` |
| 7 | 13:28:32 | `stock.finance.sina.com.cn` | 200 | 112579 | `.../US_MinKService.getMinK?symbol=fro&type=5` |
| 8 | 13:28:41 | `quotes.sina.cn` | 200 | 46 | `.../US_MinKService.getMinKline?symbol=AAPL&scale=5&datalen=240` |
| 9 | 13:28:41 | `hq.sinajs.cn` | 200 | 242 | `https://hq.sinajs.cn/list=rt_hk00700` |
| 10 | 13:28:41 | `hq.sinajs.cn` | 200 | 178 | `https://hq.sinajs.cn/list=hk00700` |
| 11 | 13:28:47 | `qt.gtimg.cn` | 200 | 12 | `https://qt.gtimg.cn/robots.txt` |
| 12 | 13:28:47 | `qt.gtimg.cn` | 200 | 437 | `https://qt.gtimg.cn/q=hk00700` |
| 13 | 13:28:58 | `web.ifzq.gtimg.cn` | 200 | 52 | `https://web.ifzq.gtimg.cn/robots.txt` |
| 14 | 13:28:58 | `proxy.finance.qq.com` | 404 | 36 | `https://proxy.finance.qq.com/robots.txt` |
| 15 | 13:29:00 | `stooq.com` | 200 | 96 | `https://stooq.com/robots.txt` |
| 16 | 13:29:00 | `query1.finance.yahoo.com` | 403 | 3369 | `https://query1.finance.yahoo.com/robots.txt` |
| 17 | 13:29:01 | `aastocks.com` | 301 | 147 | `https://aastocks.com/robots.txt` |
| 18 | 13:29:02 | `etnet.com.hk` | 200 | 2812 | `https://etnet.com.hk/robots.txt` |
| 19 | 13:29:03 | `www.hkex.com.hk` | 200 | 348 | `https://www.hkex.com.hk/robots.txt` |
| 20 | 13:29:08 | `www.aastocks.com` | 200 | 50 | `https://www.aastocks.com/robots.txt` |
| 21 | 13:29:22 | `www.aastocks.com` | 200 | 316904 | `…/tc/stocks/quote/detail-quote.aspx?symbol=00700` |
| 22 | 13:29:22 | `www.etnet.com.hk` | 302→200 | 0→331882 | `…/www/tc/stocks/realtime/quote.php?code=700`（`-L`，计 2 次） |
| 23 | 13:30:17 | `proxy.finance.qq.com` | 200 | 41 | `…/app/kline/mkline?param=usAAPL.OQ,m5,,240` |
| 24 | 13:30:17 | `proxy.finance.qq.com` | 200 | 41 | `…/app/kline/mkline?param=usAAPL,m5,,240` |
| 25 | 13:30:21 | `web.ifzq.gtimg.cn` | 200 | 70 | `…/appstock/app/usmkline/get?_var=m5&param=usAAPL.OQ,m5,,320` |
| 26 | 13:30:21 | `web.ifzq.gtimg.cn` | 200 | 873 | `…/appstock/app/minute/query?code=usAAPL.OQ` |
| 27 | 13:30:29 | `query1.finance.yahoo.com` | 403 | 3369 | `…/v8/finance/chart/AAPL?interval=5m&range=5d` |
| 28 | 13:30:30 | `finance.pae.baidu.com` | 200 | 0 | `https://finance.pae.baidu.com/robots.txt` |
| 29 | 13:30:35 | `finance.pae.baidu.com` | 403 | 112 | `…/vapi/v1/getquotation?…code=00700…` |
| 30 | 13:30:48 | `www.hkex.com.hk` | 404 | 2954 | `…/Market-Data-Services/Real-Time-Data-Services/Securities-Market-Data-Services?sc_lang=en` |
| 31 | 13:31:33 | `hq.sinajs.cn` | 200 | 242 | `https://hq.sinajs.cn/list=rt_hk00700` |
| 32 | 13:31:55 | `vip.stock.finance.sina.com.cn` | 404 | 16 | `https://vip.stock.finance.sina.com.cn/robots.txt` |
| 33 | 13:31:55 | `vip.stock.finance.sina.com.cn` | 404 | 16 | `…/US_MinKService.getMinK?symbol=aapl&type=15` |
| 34 | 13:32:25 | `hq.sinajs.cn` | 200 | 242 | `https://hq.sinajs.cn/list=rt_hk00700` |
| 35 | 13:32:39 | `quotes.sina.cn` | 200 | 46 | `…/US_MinKService.getMinK?symbol=aapl&type=15` |
| 36 | 13:32:42 | `api.nasdaq.com` | 200 | 187 | `https://api.nasdaq.com/robots.txt` |
| 37 | 13:32:50 | `api.twelvedata.com` | 200 | 26 | `https://api.twelvedata.com/robots.txt` |
| 38 | 13:32:52 | `api.twelvedata.com` | 200 | 30837 | `…/time_series?symbol=AAPL&interval=5min&outputsize=240&apikey=demo` ★ 违规 |
| 39 | 13:33:05 | `www.etnet.com.hk` | 200 | 2812 | `https://www.etnet.com.hk/robots.txt` |
| 40 | 13:44:10 | `quotes.sina.cn` | 200 | **4** | `…/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=gb_fro&scale=5&ma=no&datalen=240`（复现「回空」，全文 `null`） |

**每主机次数（上限 5/小时）**：`stock.finance.sina.com.cn` 5；`hq.sinajs.cn` 5；`quotes.sina.cn` 4；`web.ifzq.gtimg.cn` 3；
`proxy.finance.qq.com` 3；`www.etnet.com.hk` 3（含 `-L` 的跳转）；`qt.gtimg.cn` 2；`query1.finance.yahoo.com` 2；`www.hkex.com.hk` 2；
`www.aastocks.com` 2；`finance.pae.baidu.com` 2；`vip.stock.finance.sina.com.cn` 2；`api.twelvedata.com` 2；`stooq.com` 1；
`aastocks.com` 1；`etnet.com.hk` 1；`api.nasdaq.com` 1。

---

## 附录 B 复现命令（可直接粘）

```bash
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

# A1 —— 美股 5 分钟 OHLC（判定为可用的那条）
curl -sS -A "$UA" -e 'https://finance.sina.com.cn' \
  'https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/x/US_MinKService.getMinK?symbol=aapl&type=5' | head -c 200

# A2 —— 对照：审计里"回空"的那条（服务名不对）
curl -sS -A "$UA" -e 'https://finance.sina.com.cn' \
  'https://quotes.sina.cn/us/api/json_v2.php/US_MinKService.getMinKline?symbol=AAPL&scale=5&datalen=240'

# A3 —— 腾讯美股 5 分钟（两次都 param error）
curl -sS -A "$UA" -e 'https://gu.qq.com/' \
  'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/kline/mkline?param=usAAPL.OQ,m5,,240'

# B1 —— 腾讯港股（量恒 0；看 f30 时间戳与请求时刻的差）
curl -sS -A "$UA" -e 'https://gu.qq.com/' 'https://qt.gtimg.cn/q=hk00700' | iconv -f gbk -t utf-8 | tr '~' '\n' | nl -v0 -ba

# B2 —— 新浪港股实时（f9/f10 价对；无量）
curl -sS -A "$UA" -e 'https://finance.sina.com.cn' 'https://hq.sinajs.cn/list=rt_hk00700' | iconv -f gbk -t utf-8
```
