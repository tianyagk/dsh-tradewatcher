# PROBE-US-QUOTES —— 美股（含 ETF / 波动率期货类）行情取数实测与接线方案

- 基线：`main` @ `3a5bbcd`（v0.101.0；`npm test` 741 用例 × 2 时区全绿、构建 73 项片段校验通过；
  `npm run check` 另有 1 项 selftest 因**今天是周六**失败——属日期相关、与本任务无关，证据见 §8.1）。
- 本报告是**取数实测**报告（不是实现报告）：**未改动任何 `src/**`**，唯一写入面 = 本文件。
- 触发问题：自选里 `106.FRO`（Frontline plc，NYSE）与 `107.VIXY`（恐慌指数期货短期合约 ETF）一直显示「无行情源」，
  用户要求「搜索新数据源以补足这类基金/期货类产品」。
- 纪律：先取 `robots.txt` 再决定发不发请求；`Disallow` 路径**零请求**（东财 `push2*`、Twelve Data、EODHD `/api/` 因此**一条都没发**，见 §3.3/§5/§9.1）；
  Yahoo / Stooq **只记录、零请求**；实验全部在 `/tmp/us-probe`（`DSH_HOME=/tmp/us-probe/home`）；未 commit、未装、未动 profile、未重启 `dsh web`。

---

## 0. 结论（先看这一段）

1. **不需要新数据源。** `106.FRO` / `107.VIXY` 用**已有的腾讯 `us*`** 与**已有的新浪 `gb_*`** 都能取到完整行情
   （实测：腾讯 `usFRO` 52.49 / `usVIXY` 17.73；新浪 `gb_fro` 52.49 / `gb_vixy` 17.73，两源涨跌幅一致）。
2. **真正的缺口是「代码映射」，不是「数据源」。** 现有兜底链 `东财 → 腾讯 → 新浪` 里，**腾讯这一跳对美股返回 `null`**：
   `tencentQuoteCode()`（`src/host/tencent.ts:72-74`）= `tencentCode() ?? tencentIndexCode()`，两档都不认 `105/106/107`；
   `sinaSymbol()`（`src/host/sina.ts:86-88`）是**逐标静态表**（`sina.ts:71-81`），也只有国内期货/外盘商品，没有 `gb_*` 规则。
   ⇒ 美股在**两个兜底源上都不存在映射**，只要东财一挂，美股行就必然「无行情源」。
3. **量化的定位**：把自选 41 个标的逐个过 `tencentQuoteCode()` + `sinaSymbol()`，**两源都拿不到的恰好只有 2 个**，
   就是 `106.FRO` 与 `107.VIXY`（§2.2 脚本输出）。其余 39 只（A股/港股/美股国际指数/国内期货/外盘商品/美债收益率）都有兜底映射。
4. **但不能只改一行映射**：现有 `parseTencentQuoteText`（`tencent.ts:174-206`）的字段下标是**为 A股/港股写的**，
   直接喂美股回包会产出**三处错值**（实测，§4）：成交额放大 **10000 倍**、时间戳**丢失**、ETF 市值被写成 **0**。
   ⇒ 接线必须连同这三处量纲/时区/空值口径一起改，否则等于「用错值冒充行情」，比「无行情源」更坏。
5. **接完线的实测形态**（把拟定补丁在 `/tmp` 里模拟后喂真实回包，§6.3）：`FRO` → 52.49 / -0.10% / 成交额 196,988,621 美元 /
   总市值 11.685 B / 流通市值 7.515 B / 时间 2026-10-16 20:04:53Z（= 16:04:53 美东）——字段与新浪逐项一致。
6. **东财（EM）对这两个标的的覆盖：未确认**。原因两条，都不是「实测不可得」：
   (a) 东财三个行情主机的 `robots.txt` 都是 `User-agent: * / Disallow: /` ⇒ 按纪律我**零请求**；
   (b) 本机插件链路此刻对**所有**标的（含对照 `105.AAPL`）都报「东财行情主机本次不可用」⇒ 无法把「东财没有 FRO」与「东财整批挂了」分开。

---

## 1. 既有链路（读代码所得）

```
自选/持仓 /quotes
  └─ em.fetchQuotesDetailed(ids)                    src/host/em.ts:1001
       ├─ rawQuotes(list)                           src/host/em.ts:634   ← 东财 push2delay → push2（ulist.np/get）
       └─ fillFromFallbacks(list, rows)             src/host/em.ts:723   ← 东财没给价的行才走这里
            ├─ tencentQuoteRows(missing)            src/host/em.ts:700
            │    └─ 过滤条件 tencentQuoteCode(secid) src/host/tencent.ts:72  ← ★ 美股在这里被过滤掉（返回 null）
            │         └─ fetchTencentQuoteRows      src/host/tencent.ts:160 → qt.gtimg.cn/q=usXXXX
            │              └─ parseTencentQuoteText  src/host/tencent.ts:174  ← ★ 下标按 A股/港股
            └─ fetchSinaQuotes(still)               src/host/sina.ts:149
                 └─ sinaSymbolOf(secid)             src/host/sina.ts:67   ← ★ 静态表，无 gb_* 规则
```

两处 `★` 就是断点：**腾讯的过滤在发请求之前**（所以连请求都不会发），**新浪的映射表里没有美股**。
注意 `em.ts:675-677` 的注释「仅覆盖沪/深/港股；美股、国际指数、商品无法映射」已经**过时**——
国际指数早在 `tencent.ts:59-64` 就有映射（本机 `quotes-lkg.json` 里 `100.NDX` / `100.SPX` 的 `source` 就是 `tencent`）。

另有一条**只在 K 线链**用的美股映射 `tencentSymbol()`（`src/host/em.ts:2116-2127`，`105/106/107 → usCODE`），
它**不参与行情链**——这正是「K 线能取、行情条不能取」的由来（也说明「美股映射」这件事在本仓库早已被验证过，只是没接到行情上）。

---

## 2. 定位证据

### 2.1 `secid` 前缀本身是对的（不是「代码写错」）

腾讯回包第 3 个字段（`f[2]`）带交易所后缀，实测：

| secid | 腾讯回包 `f[2]` | 交易所 | 东财前缀语义 |
|---|---|---|---|
| `106.FRO` | `FRO.N` | NYSE | 106 = 纽交所 ✅ |
| `107.VIXY` | `VIXY.AM` | AMEX/Cboe | 107 = 美交所 ✅ |
| `105.AAPL` | `AAPL.OQ` | NASDAQ | 105 = 纳斯达克 ✅ |

⇒ 用户填的 `106.FRO` / `107.VIXY` **前缀与交易所一致**，问题不在 secid。

### 2.2 自选 41 只里，只有这 2 只没有兜底映射（实测脚本）

```bash
cd /tmp/us-probe && DSH_HOME=/tmp/us-probe/home node --experimental-strip-types cov.mts
```

```text
自选共 41 个标的；两源映射都拿不到的：2
  ✗ 106.FRO	Frontline plc
  ✗ 107.VIXY	恐慌指数期货短期合约ETF
```

（脚本只 `import` 仓库的 `tencentQuoteCode` / `sinaSymbol` 与读 `/home/hu/.dsh/dsh-tradewatcher/watch.json`，不写任何东西。）

### 2.3 现场状态：此刻整条链只有兜底源在工作

读 `~/.dsh/dsh-tradewatcher/quotes-lkg.json`（插件自己落盘的 last-known-good，`ts` = 2026-10-17 18:23:45）：

```text
source 计数: {'tencent': 76, 'lkg': 46, 'sina': 8}   em: 0
前缀计数:    {'0':23,'1':73,'2':3,'100':6,'101':2,'112':1,'113':1,'114':3,'116':13,'122':1,'171':4}   ← 无 105/106/107
```

⇒ 本机**从未**留下过任何美股的行情行；也说明「东财整批不给价」时，所有只能靠东财的标的都会掉进 `lkg`。
这与用户「一直显示无行情源」的观感一致：**其他 39 只都有兜底，只有这 2 只没有。**

---

## 3. 三源实测对照（含完整命令与返回片段）

请求计数（本人发出，全部为**报价链**；用户裁定「报价链豁免 5 次/小时，但必须记数」）：
`qt.gtimg.cn` **6 次**、`hq.sinajs.cn` **1 次**；`push2*` **0 次**（robots `Disallow: /`）。
`robots.txt` 预检每主机各 1 次（`push2` / `push2delay` / `push2his` / `qt.gtimg.cn` / `hq.sinajs.cn` / `web.ifzq.gtimg.cn` /
`stock.finance.sina.com.cn` / `vip.stock.finance.sina.com.cn` / `searchapi.eastmoney.com` / `quote.eastmoney.com` + 6 个新品源）。

### 3.1 腾讯（`qt.gtimg.cn`）—— 实测可得

```bash
curl -sS --max-time 12 -A 'Mozilla/5.0 dsh-probe' -e 'https://gu.qq.com/' \
  'https://qt.gtimg.cn/q=usVIXY,usFRO,usAAPL,usSPY' | iconv -f gbk -t utf-8
```

```text
v_usVIXY="200~短期期货波动ETF-ProShares~VIXY.AM~17.73~16.40~16.12~15329796~0~0~17.80~10000~0~0~…~18.00~600~0~0~0~0~0~0~0~0~~2026-10-16 16:00:01~1.33~8.11~18.48~16.00~USD~15329796~270828663~…"
v_usFRO ="200~Frontline Plc~FRO.N~52.49~52.54~53.63~3722974~0~0~52.17~100~…~~2026-10-16 16:04:53~-0.05~-0.10~54.19~52.38~USD~3722974~196988621~1.67~7.87~~30.88~~3.44~75.15370~116.85475~Frontline Plc~…~222622889~143177186~…"
v_usAAPL="200~苹果~AAPL.OQ~343.46~342.00~346.09~59946368~…~2026-10-16 16:00:02~1.46~0.43~347.82~340.46~USD~59946368~20621913459~…~50094.01495~50125.17063~…"
v_usSPY ="200~标普500指数ETF-SPDR~SPY.AM~763.25~771.79~773.24~64384579~…~2026-10-16 16:00:01~-8.54~-1.11~773.25~760.64~USD~64384579~49282866763~…~1066482000~"
```

**判定：实测可得**，且字段齐全（现价/昨收/开高低/量/成交额/流通市值/总市值/股本/行情时间）。
（上面四个 `v_` 行是我按字段位置截断后的**片段**，`…` 处为省略；原始整行已存 `/tmp/tx_us.txt`，字段数与索引见 §3.4。）

### 3.2 新浪（`hq.sinajs.cn`，必须带 Referer）—— 实测可得

```bash
curl -sS --max-time 12 -A 'Mozilla/5.0 dsh-probe' -e 'https://finance.sina.com.cn/' \
  'https://hq.sinajs.cn/list=gb_vixy,gb_fro,gb_spy' | iconv -f gbk -t utf-8
```

```text
var hq_str_gb_vixy="短期期货恐慌指数ETF,17.7300,8.11,2026-10-17 09:46:40,1.3300,16.1200,18.4800,16.0000,39.7000,15.8750,15329796,2228482,240529647,…,13566252,…,,…,270624597.0000,…"
var hq_str_gb_fro ="Frontline,52.4900,-0.10,2026-10-17 09:43:52,-0.0500,53.6300,54.1900,52.3800,59.7500,17.8900,3722974,4808716,11685475706,4.07,12.900000,…,222622894,…,,…,197036261.0000,…"
var hq_str_gb_spy ="SPDR标普500 ETF,763.2500,-1.11,2026-10-17 09:45:04,-8.5400,773.2400,773.2500,760.6400,781.6200,627.3770,64384579,36478437,807771987537,…,1058332116,…,,…,49310858494.0000,…"
```

**判定：实测可得**。`parseSinaGb`（`sina.ts:310-328`）现成能解析出 `name/price/pct/time/totalMv/shares`，
本案交叉校验通过：`price × shares == totalMv`（FRO：52.49 × 222,622,894 = 11,685,475,706 ✔；VIXY：17.73 × 13,566,252 = 240,529,648 vs 240,529,647 ✔）。

### 3.3 东财（`push2*`）—— **未确认**（robots 禁止 + 本机东财当时不可用）

预检：

```bash
curl -sS https://push2delay.eastmoney.com/robots.txt   # → User-agent: *  /  Disallow: /
curl -sS https://push2.eastmoney.com/robots.txt        # → User-agent: *  /  Disallow: /
curl -sS https://push2his.eastmoney.com/robots.txt     # → User-agent: *  /  Disallow: /
```

按纪律 ⇒ **一条请求都没发**。理论上会用的命令（**未执行**，留给需要时复核）：

```bash
# 未执行（robots Disallow: /）
curl -sS 'https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=106.FRO,107.VIXY,105.AAPL&fltt=2&invt=2&fields=f2,f3,f4,f5,f6,f12,f13,f14,f18,f124'
```

侧面观测（**走插件自身链路**，不是我直连东财）：`/tradewatcher/quotes` 工具当前回包：

```text
缺失 3（上游无此数据 0 / 本次失败 3）
  · 105.AAPL（本次失败）：东财行情主机本次不可用（熔断中或整批失败），而该标的没有腾讯/新浪备用源映射（等东财恢复就会有）
  · 106.FRO （本次失败）：… 同上
  · 107.VIXY（本次失败）：… 同上
```

对照 `105.AAPL` 也拿不到 ⇒ **无法区分**「东财没有美股」与「东财本轮全挂」。故记为**未确认**（不是「不可得」）。

> 合规备注（不在本任务范围、仅记录）：`robotsGate` 只被 `globalFlow.ts:54` 使用，**行情链完全没过门禁**；
> 而三个东财行情主机的 `robots.txt` 都是全站 `Disallow: /`。这是既有行为（用户的产品决定），不是本轮引入的。

### 3.4 字段完整度矩阵（实测值）

| 字段 | 腾讯 `us*` | 新浪 `gb_*` | 交叉校验 |
|---|---|---|---|
| 现价 | `f[3]` ✔ | 下标 1 ✔ | FRO 52.49 = 52.4900；VIXY 17.73 = 17.7300 |
| 涨跌幅 | `f[32]` ✔ | 下标 2 ✔ | FRO -0.10 = -0.10；VIXY 8.11 = 8.11 |
| 涨跌额 | `f[31]` | 下标 4 | -0.05 / 1.33 两源一致 |
| 昨收 | `f[4]` | 下标 1−下标 4 派生 | 52.54 / 16.40 两源一致 |
| 开/高/低 | `f[5]`/`f[33]`/`f[34]` | 下标 5/6/7 | 53.63/54.19/52.38 两源一致 |
| 成交量 | `f[6]`（股） | 下标 10（股） | 3,722,974 = 3,722,974 |
| 成交额 | `f[37]`（**美元，不是万元**） | 下标 30（美元） | 196,988,621 vs 197,036,261（差 0.02%，报价时刻不同） |
| 总市值 | `f[45]`（**亿元**；ETF 为空串） | 下标 12（美元） | FRO 116.85475 亿 = 11,685,475,000 vs 新浪 11,685,475,706 ✔；VIXY 腾讯空 → 只能靠新浪 240,529,647 |
| 流通市值 | `f[44]`（亿元；ETF 空） | — | FRO 75.15370 亿 = 7,515,370,000 |
| 股本/份额 | `f[71]`（ETF 也有；FRO 为空） | 下标 19 | VIXY 13,566,000 vs 13,566,252（差 0.002%） |
| 行情时间 | `f[30]` = **美东墙上时间** `2026-10-16 16:00:01` | 下标 3 = 北京观测时刻；下标 23/24 = 美东时间 | — |
| 是否延迟 | 上游**不给**延迟标志 | 同上 | ⇒ 只能说「最近成交（收盘）快照」，**不能**说「实时」 |

覆盖广度抽样（`qt.gtimg.cn/q=usUVXY,usUNG,usSLV,usTLT,usSQQQ`，1 次请求）——**基金/期货类**都在：

```text
usUVXY  len=73  1.5倍做多VIX短期期货ETF-ProShar  18.50  prev 16.46  +12.39%
usUNG   len=73  美国即月天然气ETF                 10.66  prev 11.09  -3.88%
usSLV   len=73  白银ETF-iShares                   51.51  prev 51.92  -0.79%
usTLT   len=73  20年期以上美国国债ETF-iShares      80.05  prev 79.97  +0.10%
usSQQQ  len=73  3倍做空纳斯达克100ETF-ProShares    38.90  prev 36.14  +7.64%
```

负例（映射命中但上游没这个品种）：

```text
curl 'https://qt.gtimg.cn/q=usZZZZNOTREAL,sh510300'  →  回包里只有一行 v_sh510300（共 1 个 v_ 前缀）
```

⇒ 未知美股代码**整行缺失**（不是 0、不是空价格），`parseTencentQuoteText` 返回 `{}` ⇒ 天然满足「未取到 + 原因」，不会有冒充风险。

---

## 4. 为什么「只加一行映射」还不行：现有 parser 对美股的三处错值（实测）

把真实回包喂进**现有**`parseTencentQuoteText`（`/tmp/us-probe/probe.mts`，只 import 不改仓库）：

```text
107.VIXY: {"price":17.73,"prev":16.4,"pct":8.11,"high":18.48,"low":16,"vol":15329796,
           "amount":2708286630000,"totalMv":0,"floatMv":0,"shares":13566000,"ts":null}
106.FRO : {"price":52.49,"prev":52.54,"pct":-0.1,"high":54.19,"low":52.38,"vol":3722974,
           "amount":1969886210000,"totalMv":11685475000,"floatMv":7515370000,"shares":null,"ts":null}
```

| # | 现象 | 根因（`src/host/tencent.ts`） | 反例/对照 |
|---|---|---|---|
| 1 | 成交额 **×10000**（3.72 M → 1.97 万亿） | `:195` `amount: num(tri[2]) ?? num(f[37]) * 1e4`。A股的 `f[35]` 是 `"4.236/37995085/16092791436"`（`tri[2]` = 元，实测 `sh510300`），**美股的 `f[35]` 是 `"USD"`** ⇒ 落到 `f[37]×1e4` 分支，而美股 `f[37]` 本身就是**美元** | 新浪同刻成交额 197,036,261 ✔ |
| 2 | 行情时间 **丢失**（`ts: null`） | `parseTencentStamp`（`:95-105`）只认 `"2026/10/16 16:00:01"`（带 `/`）与 14 位纯数字；美股是 `"2026-10-16 16:00:01"` ⇒ 拼出乱码 ISO ⇒ `null` | 「100.NDX / 100.SPX 的 `time` 在 `quotes-lkg.json` 里就是 `null`，`source=tencent`」——**同一个坑早已存在于国际指数** |
| 3 | ETF 市值被写成 **0**（VIXY `totalMv:0`） | `num('')` = `Number('')` = `0`（有限数）⇒ `:198-199` 把「上游没这个字段」写成 0 | FRO/AAPL 有值且与新浪逐位吻合（见 §3.4），说明**下标本身对**，只是空串没转 null |

> 另外：`pct/high/low/price/prev/vol` 这几项在美股回包上**是对的**（本次实测 73 个字段、时间戳恒在 `f[30]`，单发与批量、连取两次都一致）。
> 我一度怀疑「同一标的字段布局会漂移」，复测（`/tmp/us-probe` 里 `usVIXY` 单发 vs 批量逐字节比较）**结果完全一致** ⇒ 该怀疑被**证伪**，不作为风险上报。
> 但**时间戳位置按 `f[30]` 写死仍建议加一条断言**（§7），因为它是靠实测锚定的，不是接口契约。

---

## 5. 新数据源候选（只取 `robots.txt`，未取行情；结论：不需要）

第 1 步已证明**既有源可得**，所以这一步只做「记档 + 合规预检」，**没有对任何候选源发过行情请求**：

| 候选 | robots 实测 | 需密钥 | 判定 | 备注 |
|---|---|---|---|---|
| Alpha Vantage | `https://www.alphavantage.co/robots.txt` → 404（无声明限制） | 是（`apikey`） | **未确认**（未请求） | 免费档 5 次/分、25 次/日量级；引入=新密钥+新主机 |
| Twelve Data | `https://api.twelvedata.com/robots.txt` → `Disallow: /` | 是 | **不发请求**（按纪律） | — |
| Finnhub | `https://finnhub.io/robots.txt` → `Allow: /`（仅禁 `/terms-of-service`、`/faq`） | 是（`token`） | **未确认**（未请求） | 有美股/ETF 基本面；需注册 |
| Tiingo | `https://api.tiingo.com/robots.txt` → 301（无 robots） | 是 | **未确认**（未请求） | — |
| Polygon | `https://api.polygon.io/robots.txt` → 404（无声明限制） | 是 | **未确认**（未请求） | 覆盖 ETF/指数 |
| EODHD | `https://eodhd.com/robots.txt` → `Disallow: /api/` | 是 | **不发请求**（按纪律） | EOD 为主，非实时 |
| Stooq | **未请求**（任务要求只记录） | 否 | 只记录 | 历史上以 robots 限制/条款不明被排除 |
| Yahoo Finance | **未请求**（已知 403 + 服务条款禁止自动化） | 否 | 只记录（不可用） | 与 `robotsGate.ts` 文件头记录一致 |

**结论：不引入新源。** 理由不是「偷懒」，而是：(a) 现有两家免费源已给出**完整且互相校验一致**的字段；
(b) 新源全部需要密钥/注册，违反「不新增依赖、不装、不动 profile」的边界；
(c) 多一个源就多一套量纲/时区/口径要守（§4 已经证明「多源」最容易出错的地方就是量纲）。

---

## 6. 接线方案（`文件:行号`；最小、不新增上游主机）

> 原则：**只扩既有链路的映射与量纲**。不新增主机 ⇒ 不算「新增数据源」。

### 6.1 必改（腾讯一档，四处）

**① `src/host/tencent.ts:72-74` —— 给行情映射加第三档（不要动 `tencentCode`）**

```ts
/**
 * 美股（EM 105=纳斯达克 / 106=纽交所 / 107=美交所）→ 腾讯 `usCODE`。
 * ⚠ **只进 `tencentQuoteCode`**：`tencentCode` 还被五日分时（mkline）与日线（fqkline）复用，
 * 而腾讯对美股只回 1 根日线（既有注释 `tencent.ts:150` 记录的实测 `param=usEWY,day,,,10,qfq`；本轮未复测）
 * ⇒ 并进去等于给日线路径凭空加一条注定失败的请求。
 * 实测（2026-10-17）：`usFRO` / `usVIXY` / `usAAPL` / `usSPY` / `usUVXY` 均回完整行情；
 * 未知代码（`usZZZZNOTREAL`）**整行缺失**（不是 0）⇒ 缺失仍走「未取到 + 原因」。
 */
function tencentUsStockQuoteCode(secid: string): string | null {
  const dot = secid.indexOf('.')
  if (dot <= 0) return null
  const mkt = secid.slice(0, dot)
  const code = secid.slice(dot + 1).trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9.]{0,11}$/.test(code)) return null
  return mkt === '105' || mkt === '106' || mkt === '107' ? `us${code}` : null
}

export function tencentQuoteCode(secid: string): string | null {
  return tencentCode(secid) ?? tencentIndexCode(secid) ?? tencentUsStockQuoteCode(secid)
}
```

**② `src/host/tencent.ts:195` —— 成交额量纲按市场分流**

```ts
// 美股 f[37] 已是**美元**（实测 usFRO 196,988,621 = 新浪 gb_fro 下标 30 同量级）；
// A股/港股 f[35] 形如 "4.236/37995085/16092791436"，tri[2] 直接是元；港股才需要 ×1e4 的旧分支。
amount: num(tri[2]) ?? (num(f[37]) !== null ? (num(f[37]) as number) * (/^us/i.test(code) ? 1 : 1e4) : null),
```

**③ `src/host/tencent.ts:196-199` —— 空串不许变 0（`num('')` 会返回 0）**

```ts
totalMv: num(f[45]) !== null && (num(f[45]) as number) > 0 ? (num(f[45]) as number) * 1e8 : null,
floatMv: num(f[44]) !== null && (num(f[44]) as number) > 0 ? (num(f[44]) as number) * 1e8 : null,
```

（美股 ETF 的 `f[44]/f[45]` 实测为空串：`usVIXY`、`usSPY`、`usEWJ` 皆是；`usFRO`/`usAAPL` 有值且与新浪市值吻合。
若想给 ETF 补市值，**新浪 `gb_*` 下标 12 是唯一免费来源**——但这属于 §6.2 的第二阶段。）

**④ `src/host/tencent.ts:95-105` + `:202` —— 美股时间戳按**美东**解析，且必须 TZ 无关**

```ts
/** 美股行情时间：`"2026-10-16 16:00:01"` = **美东墙上时间**（实测 16:00/16:42 即 ET 收盘），不能按本机时区解析 */
export function parseTencentUsStamp(text: string | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec((text ?? '').trim())
  if (m === null) return null
  const [y, mo, d, hh, mi, ss] = m.slice(1).map(Number)
  const wallAsUtc = Date.UTC(y, mo - 1, d, hh, mi, ss)      // 目标墙上时间
  const nyc = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const wallOf = (ms: number) => {
    const p = Object.fromEntries(nyc.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second))
  }
  let ms = wallAsUtc
  for (let i = 0; i < 3; i++) {           // 两轮足以收敛（含 DST 切换日），三轮留余量
    const drift = wallOf(ms) - wallAsUtc
    if (drift === 0) break
    ms -= drift
  }
  return ms
}
```

调用点：`ts: /^us/i.test(code) ? parseTencentUsStamp(f[30]) : parseTencentStamp(f[30]),`

> ⚠ **陷阱**：直接把 `parseTencentStamp` 扩成认 `-` 格式会**把 ET 当本机时区**（东八区机器上差 12–13 小时，
> 界面的「数据时刻」会显示成凌晨 4 点、并可能被判成未来时间）。**不要**那样改。

### 6.2 可选（第二阶段，新浪做第二档）

- `src/host/sina.ts:71-88`：`SINA_SYMBOL` 是**逐标静态表**，美股必须加**规则**（`105/106/107 → gb_CODE`），不能用表。
- `src/host/sina.ts:115-148` `parseSinaHq`：只认 `nf_` / `hf_`，要加 `gb_` 分支（现成逻辑在 `parseSinaGb`，`sina.ts:310-328`）。
- `SinaHqQuote`（`sina.ts:95-104`）只有 `name/price/prev/open/high/low/pct`，没有 `amount/totalMv` ⇒
  要么扩接口（下游拼装在 `em.ts:744-770`，该分支现在把 `vol/amount/time` **一律写 null**，扩接口时一并填），
  要么只当「价格兜底」。
- 价值：腾讯单主机挂掉时美股仍有价；并补齐 ETF 的总市值（腾讯 `f[44]/f[45]` 对 ETF 为空）。
- 成本：约 25 行 + 3 条断言，另需 `fetchSinaQuotes` 的分批（`CHUNK=5`）在美股上复测。

### 6.3 接线后的实测形态（拟定补丁在 `/tmp` 模拟，喂真实回包，`quoteFromTencent` 用的是仓库真函数）

```text
106.FRO  {"name":"Frontline Plc","price":52.49,"chg":-0.05,"pct":-0.1,"prev":52.54,"open":53.63,
          "high":54.19,"low":52.38,"vol":3722974,"amount":196988621,"source":"tencent",
          "totalMv":11685475000,"floatMv":7515370000,"time":1792181093000}
          ts → 2026-10-16T20:04:53Z（美东 16:04:53）
107.VIXY {"name":"短期期货波动ETF-ProShares","price":17.73,"chg":1.33,"pct":8.11,"prev":16.4,"open":16.12,
          "high":18.48,"low":16,"vol":15329796,"amount":270828663,"source":"tencent",
          "totalMv":null,"floatMv":null,"time":1792180801000}      ← ETF 市值如实 null（不是 0）
105.AAPL {"price":343.46,"pct":0.43,"amount":20621913459,"totalMv":5012517063000,"floatMv":5009401495000,...}
负例      usZZZZNOTREAL → parseTencentQuoteText 返回 {} ⇒ 该行继续走新浪/或如实 missing，不会出现 0
```

### 6.4 副作用核查（接线会连带改变的行为）

| 位置 | 影响 | 判断 |
|---|---|---|
| `src/host/em.ts:1495-1499` `hasQuoteFallback` | 美股从 `false` → `true` | 正确；搜索结果与工具输出的「仅东财源」标注会自动跟着变准 |
| `src/host/em.ts:409-433` `quoteProvenance.missing` | 美股缺失从「**没有**腾讯/新浪备用源映射（等东财恢复）」→「东财**与备用源**本次都未给出可用价格」 | 正确，且**仍给原因**（`transient`），满足「缺失必须给原因」 |
| `src/client/ui.tsx:239` 加入自选时的提示文案 | 当前对「腾讯/新浪都没有映射」的标的警告 | 文案仍成立（针对真正没有映射的品种），无需改 |
| `quotes-lkg.json` 首次出现 `105/106/107` 行 | 此前从未有过 | 预期 |
| `em.ts:675-677` 文档注释「美股…无法映射」 | 接线后**过时** | 顺手改一行注释 |
| `stale` 语义（`em.ts:483`） | 用 `row.at`（取数时刻）算，不是 `row.time` | 美股盘中/盘后都不误判；但界面「数据时刻」= 取数时刻，真实成交时刻在 `row.time`（既有行为，非本轮引入） |

---

## 7. 断言 / 反例注入清单（给实现者，可直接落 `.test.ts`）

本报告**没有写 `src/**`**，所以这些是**待落的断言**；其中 1–6 条我已经用 `/tmp` 脚本对**真实回包**验证过预期值（§3/§4/§6.3）。

1. **映射两态**：`tencentQuoteCode('106.FRO') === 'usFRO'`、`('107.VIXY') === 'usVIXY'`、`('105.AAPL') === 'usAAPL'`；
   `('999.FRO') === null`、`('105.') === null`、`('100.SPX') === 'us.INX'`（回归）。
2. **护栏**：`tencentCode('106.FRO') === null`（证明没把美股灌进 K 线/分时那条映射，见 `tencent.ts:55-57`）。
3. **成交额量纲**：喂 `usFRO` 原样 fixture ⇒ `amount === 196988621`（**不是** 1969886210000）；
   同一 fixture 里带一行 `sh510300` ⇒ `amount === 16092791436`（A股不变）。
4. **空串不顶替**：`usVIXY` fixture ⇒ `totalMv === null && floatMv === null`（**不是 0**）；`usFRO` ⇒ `totalMv === 11685475000`。
5. **时间戳写死 UTC（TZ 无关）**：`f[30] = "2026-10-16 16:04:53"` ⇒ `ts === 1792181093000`。
   ⚠ 断言**必须写 epoch 数字**，不许断言本地时间字符串——`npm test` 会跑 `TZ=UTC` 那轮（基线 741×2）。
6. **负例注入**：`usZZZZNOTREAL` ⇒ `parseTencentQuoteText` 返回 `{}`；上游缺行时**不得**产出 0 价格、不得用别的品种顶替。
7. **缺失原因可见**：接线后若腾讯也没取到，`quoteProvenance().missing[].why === 'transient'` 且 `note` 命中「东财与备用源本次都未给出可用价格」。
8. **选做**：`hasQuoteFallback('106.FRO') === true`；跨源一致性（腾讯 vs 新浪同标的涨跌幅差 < 0.5%）。

---

## 8. 验证（在未改动的树上跑，作为「接线前的基线」）

```bash
cd /home/hu/workspace/Servers/dsh/Dev/dsh-tradewatcher && npm run check   # EXIT=1（唯一失败项见下）
npm run build                                                             # EXIT=0
```

实测结果（**未改动的树**：`git status --porcelain` 只有本文件 `?? docs/PROBE-US-QUOTES.md`）：

| 步骤 | 结果 |
|---|---|
| `typecheck`（`tsc --noEmit`） | ✅ 通过 |
| `test` 第 1 轮（本机 `Asia/Shanghai`） | ✅ `tests 741 / pass 741 / fail 0` |
| `test` 第 2 轮（`TZ=UTC`） | ✅ `tests 741 / pass 741 / fail 0` |
| `selftest` | ❌ **1 项失败**（`selftest.ts:379`，**周末日期相关**，见 §8.1） |
| `build`（`node build.mjs`） | ✅ `built lib/index.js + lib/client.js（v0.101.0，客户端片段校验通过：73 项）` |

即：**741 基线两轮全绿 + 构建 73 项通过**，唯一红灯是 `selftest` 里一条**与今天日期绑定**的用例，且与本次探测无关（本报告未改任何 `src/**`）。

### 8.1 那 1 项 selftest 失败：今天周六（不是回归，也不是本任务引入）

```text
FAIL 本会话无数据 → 回落落盘 LKG（etfs 1，stale true）
1 FAILURES          （其余 295 项 PASS + 13 项 PASS(soft) + 2 项 WARN(soft)）
```

复现（只读 import 仓库函数，`/tmp/us-probe/sat.mts`）：

```text
今天（实测时刻 2026-10-17 周六） → {"trading":false,"reason":"weekend","label":null}
2026-10-16（周五）              → {"trading":true,"reason":null,"label":null}
2026-10-19（周一）              → {"trading":true,"reason":null,"label":null}

复现 selftest.ts:379 的三段断言：
  etfs.length === 1  → true  (got 1)
  stale === true     → true  (got true)
  level === 2        → false (got null)          ← 唯一失败项
  summary            → 休市（非交易日）：周末休市 —— 今天不是交易日，不采样、不出等级、不写当日分
  nonTrading         → {"reason":"weekend","label":null}
```

根因：`RescueMonitor.snapshot()` 的**非交易日门禁**（`src/host/rescue.ts:2333-2352`）在周末把 `level` 置 `null`，
而该用例（`src/host/selftest.ts:370-387`）用的是写死 `level: 2` 的 LKG fixture、没有 stub 时钟。
`weekdayOf` 固定按 `Asia/Shanghai` 算（`src/host/time.ts:74-78`），所以改 `TZ` 也挪不动结论——
**工作日的同一份代码会绿**。⇒ 记为「环境/日期相关失败」，**不是**接线风险；但它意味着
**接线后若在这个时段跑 `npm run check`，红灯会一直是它**，别误判成自己改坏了。

把时钟 stub 掉、**同一份 fixture** 跑三天的判决（`/tmp/us-probe/sat2.mts`）：

```text
2026-10-19（周一）        etfs=1 stale=true level=2        ⇒ 断言 level===2 通过 ✅
2026-10-16（周五）        etfs=1 stale=true level=2        ⇒ 断言 level===2 通过 ✅
2026-10-17（周六·今天）    etfs=1 stale=true level=null     ⇒ 断言 level===2 失败 ❌
```

---

## 9. 未做 / 未确认（诚实清单）

| 项 | 状态 | 原因 |
|---|---|---|
| 东财对 `106.FRO` / `107.VIXY` 的覆盖 | **未确认** | 三个 `push2*` 主机 `robots.txt` 全是 `Disallow: /` ⇒ 零请求；且本机东财此刻整批不可用（对照 `105.AAPL` 同样取不到） |
| `105.BABA`（NYSE 对照） | **未测** | 第 1 步已足够定性（映射缺失才是断点），再发请求无新增信息 |
| 新浪 `gb_*` 对**全部**美股代码的覆盖 | **未确认** | 只测了 `gb_fro/gb_vixy/gb_spy`（3 个全中）；未知代码缺行行为**未测** |
| 候选新源的实际行情可用性 | **未确认** | 第 1 步成功 ⇒ 按任务口径不进入第 2 步实测；只做了 robots 预检（§5） |
| 美股盘中（非收盘）时段的字段行为 | **未测** | 当前为美股休市时段，实测到的是**收盘快照**；分时/盘中量纲（如 `f[6]` 是否仍为股）未验证 |
| 实现接线代码 | **未做** | 本任务写入面只有 `docs/PROBE-US-QUOTES.md`；§6 给出可直接照抄的补丁 |
| 新浪作为第二兜底 | **未做**（建议第二阶段） | 见 §6.2，成本/收益已评估 |
| 就 K 线链的美股能力 | 未测 | `tencentSymbol`（`em.ts:2116`）早已映射，但腾讯美股日线只回 1 根（`tencent.ts:150` 注释记录）⇒ 美股 K 线仍只能靠东财/新浪日线接口 |

### 9.1 风险与合规发现（上报给 Lead，不由本任务处理）

1. **东财行情链没过 robots 门禁**：`robotsGate` 只接在 `globalFlow.ts:54`；`em.ts` 的 `QUOTE_HOSTS` 直连 `push2delay/push2`，
   而这两台的 `robots.txt` 是全站 `Disallow: /`。这是既有产品决定，但值得在下一轮合规评审里明确「报价链豁免」是否包含 robots。
2. **`em.ts:675-677` 注释过时**（说美股/国际指数无法用腾讯兜底，实际国际指数早已兜底）。
3. **`num('')→0` 是全局隐患**：只要哪个上游用空串表示「没有」，就会变成 0。本轮只在 §6.1③ 就地收紧，未做全局重构。
