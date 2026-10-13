# PROBE-MARKET-SOURCES —— 8 项数据源只读探测（2026-10-13 21:59–22:10 实测）

**一行结论**：8 项里 **5 项实测可得**（涨停/跌停家数、两融余额、美元指数、美债 10Y 及其历史、当日成交额）、
**2 项只能自算**（全天成交额预测、日内涨跌家数序列）、**1 项依赖本地历史**（昨日成交额 / 较昨日变动，本实例
当前只有 1 天快照 ⇒ 今日为 `null`，明天起才有）。

> ⚠ **与既有记录相反的一条**：本轮实测 `push2.eastmoney.com`、`push2delay`、`push2his`、`push2ex`
> **全部可达**（此前记录的"push2* 本机 0 成功率"在本机当前网络下不成立 —— 可能是代理线路/时段差异）。
> 下面每条都标了"实测可得"，但接线时仍应按既有降级口径（备用源 + 缺失四态）设计。
> 全部命令都经代理 `-x http://127.0.0.1:7890`，UA/Referer 见各条（东财/新浪/同花顺都要求）。

---

## 1. 涨停 / 跌停家数 —— **实测可得**（专用池接口，一次给全）

**结论**：东财 `push2ex` 的**涨停池/跌停池**接口直接给家数，`tc` 就是总数，池内每条带 `zdp`（涨跌幅）与
`amount/ltsz`。**不要**用 clist 的 `f51/f52` 判涨跌停 —— 实测它们**不是涨跌停价**。

```bash
# 涨停池（tc = 涨停家数）
curl -sS -x http://127.0.0.1:7890 \
 "https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=3&sort=fbt%3Aasc&date=20261013" \
 -H "user-agent: Mozilla/5.0" -H "referer: https://quote.eastmoney.com/"
# 跌停池（tc = 跌停家数）
curl -sS -x http://127.0.0.1:7890 \
 "https://push2ex.eastmoney.com/getTopicDTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=2&sort=fund%3Aasc&date=20261013" \
 -H "user-agent: Mozilla/5.0" -H "referer: https://quote.eastmoney.com/"
```
```
{"rc":0,"rt":110,"lt":2,"full":0,"data":{"tc":67,"qdate":20261013,"pool":[{"c":"000668","n":"荣丰控股","p":20560,"zdp":10.00535
{"rc":0,"rt":111,"lt":2,"full":0,"data":{"tc":8,"qdate":20261013,"pool":[{"c":"603230","n":"内蒙新华","p":13170,"zdp":-9.97949
```

**为什么不能用 clist 的 `f51/f52`（反证）**：
```bash
curl -sS -x http://127.0.0.1:7890 "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=3&fltt=2&invt=2&fs=m:0+t:6&fields=f2,f3,f12,f14,f18,f51,f52" \
 -H "user-agent: Mozilla/5.0" -H "referer: https://quote.eastmoney.com/"
```
```
{"data":{"total":1642,"diff":{"0":{"f2":11.57,"f3":-1.36,"f12":"000001","f14":"平安银行","f18":11.73,"f51":0.0,"f52":10464000000
```
⇒ 平安银行 `f51=0.0`、`f52=1.0464e10`（≈104.6 亿，显然是别的字段）⇒ **f51/f52 不能当涨停价/跌停价**。
指数行情里这两个字段直接是 `"-"`（见第 6 条的 1c 片段）。

**自算口径（若要走 clist）不推荐**：`pz` 被上游**截到 100 行/页**（实测 `pz=6000` 仍只回 100 行），
全市场 ≈5500 只需 **55 页**请求；且幅度规则要自己判：主板 10%、创业板/科创板 20%、ST 5%、北交所 30%、
新股首日无涨跌幅限制 ⇒ 规则会漂。池接口把这件事交给上游，家数与名单同源。

**接线建议**：**直接可用**（新增一条 `push2ex` 池请求，涨/跌停家数 + 名单一起落盘）。降级口径：池接口失败 ⇒
该格 `null` + `missing{why:'transient'}`，**不要**退回"自算 clist"（口径不同、请求量大 55 倍）。

## 1b. 判定口径（10%/20%/30%/ST 5%）—— 实测复核

本次**没有**逐票核验幅度规则（池接口已含名单，不需要自算），若将来确实要自算：`f2`（现价）与 `f18`（昨收）
比较，限幅按代码前缀取：主板 10%、`300/301/688` 20%、`8/4/9`（北交所）30%、ST 5%（ST 需另取名称判断）。
**未确认项**：北交所/新股的边界（我这次只验证了"clist 只给 100 行"，没有做全量自算比对）。
确认方法：取 `push2ex` 某日名单与自算结果对拍（`tc` vs 自算计数），差异即规则缺口。

## 2. 昨日成交额 —— **本地已有字段，但本实例当前为 null（依赖 ≥2 天历史）**

- 存储：`~/.dsh/dsh-tradewatcher/breadth.json` 的 `days[YYYY-MM-DD] = {up,down,even,amount,source,checks,at,final}`
  （实测本实例 `days` 只有 **1** 天：`2026-10-13`）。
- 对外字段：`src/host/routes.ts:565` 的 `prevAmount: { day, amount, final } | null`（`src/client/api.ts:251` 同形），
  口径 = **上一交易日收盘定稿那次记录**（`final: true`）。
```bash
python3 -c "import json;d=json.load(open('$HOME/.dsh/dsh-tradewatcher/breadth.json'));print(list(d['days'].keys()))"
# → ['2026-10-13']    ⇒ 仅 1 天 ⇒ prevAmount 今天为 null
python3 -c "import json;d=json.load(open('$HOME/.dsh/dsh-tradewatcher/breadth.json'));k=list(d['days'])[-1];print(json.dumps(d['days'][k],ensure_ascii=False)[:120])"
# → {"up":2820,"down":2296,"even":173,"amount":1675917804027.3208,"source":"em-index","at":1791898843231,"final":true}
```
**接线建议**：**已接线，无需新增**。缺口是"历史不足 ⇒ null"：面板/工具已有 `missing` 口径，建议文案明确
"本地尚未累积到上一交易日快照（需要连续两个交易日运行）"。

## 3. 较昨日变动（由 1、2 派生）—— **成立，但仅按"日"粒度**

- 较昨日成交额：`amount - prevAmount.amount`，两者都在同一份本地快照里 ✓（第 2 条字段确认）。
- 较昨日涨跌停家数：**当前不可派生** —— 快照里**没有**存涨跌停家数（只有 `up/down/even/amount`）。
  要派生就必须先把第 1 条接上并在每日定稿时落盘（`final: true` 那一刻）。
**接线建议**：**需新增落盘字段**（涨/跌停家数与 `up/down/even` 同存），否则"较昨日"只能算成交额一项。

## 4. 全天成交额预测 —— **外部没有现成口径 ⇒ 只能自算**

探过的候选：东财只给**当前累计成交额**（`f6`），没有全天预估字段：
```bash
curl -sS -x http://127.0.0.1:7890 "https://push2.eastmoney.com/api/qt/ulist.np/get?secids=1.000001,0.399001&fltt=2&invt=2&fields=f6,f124,f14" \
 -H "user-agent: Mozilla/5.0" -H "referer: https://quote.eastmoney.com/"
```
```
{"data":{"total":2,"diff":[{"f6":779302288022.5,"f14":"上证指数","f124":1791879120},{"f6":896615516004.82,"f14":"深证成指"}]}}
```
**自算依据（本仓库已有）**：`src/host/rescue-thresholds.ts` 的 `progressCurve`（新浪 5 分钟线 **126 个交易日**标定：
10:00 已占全天 29.6%、11:30 60.9%、14:30 86.0%）⇒ `全天 ≈ 当前累计 ÷ progressAt(elapsed)`。
采样密度：护盘采样器常态 **30s**、尾盘 15s（`rescue.ts:1017`）⇒ 日内至少 240+ 个点，足够做进度法；
但**收盘前的最后一跳误差最大**（早盘 progress 的标定误差会被放大：09:35 时 1% 的 progress 误差 ⇒ 预估偏差 ~3%）。
**接线建议**：**需新增路由与降级口径**（复用 `progressCurve`，输出必须带"标定来源 + 样本天数 + 预估区间"，
并且**只在交易日盘中**给；收盘后直接给实际值）。

## 5. 两融余额 / 融资净买 —— **实测可得（两条官方/半官方路径）**

**深交所官方 JSON（推荐，字段最全）**：
```bash
curl -sS -x http://127.0.0.1:7890 "http://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=1837_xxpl&&loading=first&txtDate=2026-10-12&random=0.3" \
 -H "user-agent: Mozilla/5.0" -H "referer: http://www.szse.cn/"
```
```
[{"metadata":{"name":"融资融券交易总量","subname":"2026-10-12","recordcount"...},"data":[{"jrrzmr":"566.66","jrrzye":"12,280.22","jrrjmc":"0.36","jrrjyl":"12.02","jrrjye":"106.81","jrrzrjye":"12,387.04"}]}]
```
（`jrrzmr` 融资买入额 / `jrrzye` 融资余额 / `jrrjye` 融券余额 / `jrrzrjye` 融资融券余额，单位亿元；`txtDate` 可回看历史）

**东财数据中心（沪深汇总 + 长历史，单位亿元）**：
```bash
curl -sS -x http://127.0.0.1:7890 "https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ&columns=ALL&pageSize=3&sortColumns=DIM_DATE&sortTypes=-1&source=WEB&client=WEB" \
 -H "user-agent: Mozilla/5.0" -H "referer: https://data.eastmoney.com/"
```
```
{"result":{"pages":1338,"data":[{"DIM_DATE":"2026-10-12 00:00:00","NEW":4287.9798,"ZDF":-0.678095,"LTSZ":95049325286976.95,"ZDF3D":-1.598
```
（`pages:1338`（pageSize=3）⇒ 该报表可翻 ~4000 行；**注意**：`RPT_RZRQ_LSHJ` 与 `RPTA_WEB_RZRQ_GGMX`+`TRADE_DATE`
两个名字实测报错 `报表配置不存在 / 排序列不存在` ⇒ 只有 `RPTA_RZRQ_LSHJ` 这个名字对）

**上交所**：`http://www.sse.com.cn/market/othersdata/margin/sum/` 返回 **HTML**（实测 HTTP 200，非机器可读）；
`query.sse.com.cn/commonQuery.do` 返回 JSON 外壳（`pageHelp`），但**正确 sqlId 未确认**。
**接线建议**：**直接可用**（深市官方 JSON + 东财沪深汇总交叉校验）；沪市官方若要走 HTML 解析 ⇒ **不建议**
（页面结构会变），优先用东财汇总兜沪市。降级：两融是**日频**数据，缺一天就 `missing{why:'no-source'}` +
显示上一可用日的日期，**不要**用 0 顶替。

## 6. 日内上涨/下跌家数序列 —— **实测不可得（只有当前值，没有分时序列）**

- 当前值（三个数）实测可得：`f104` 上涨家数 / `f105` 下跌家数 / `f106` 平盘：
```bash
curl -sS -x http://127.0.0.1:7890 "https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=1.000001&fltt=2&invt=2&fields=f2,f3,f51,f52,f104,f105,f106" \
 -H "user-agent: Mozilla/5.0" -H "referer: https://quote.eastmoney.com/"
```
```
{"rc":0,"lt":1,"data":{"total":1,"diff":[{"f2":3800.86,"f3":0.1,"f51":"-","f52":"-","f104":1167,"f105":1114,"f106":75}]}}
```
- **分时序列不可得**（三条反证）：
```bash
# (a) 指数分时 trends2：每行只有"时间,点位"，没有家数
curl -sS -x http://127.0.0.1:7890 "https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=1.000001&iscr=0&fields1=f1,f2,f3&fields2=f51,f53,f104,f105&ndays=1" \
 -H "user-agent: Mozilla/5.0" -H "referer: https://quote.eastmoney.com/"
```
```
{"data":{"code":"000001","market":1,"name":"上证指数","trends":["2026-10-13 09:30,3760.80", ... 241 行 ...]}}   # 行内无 f104/f105
```
```bash
# (b) 同花顺分时接口给的是个股（不是家数）
curl -sS -x http://127.0.0.1:7890 "https://d.10jqka.com.cn/v6/time/hs_000001/last.js" -H "user-agent: Mozilla/5.0" -H "referer: https://stockpage.10jqka.com.cn/"
# → {"hs_000001":{"name":"平安银行","pre":"11.73","tradeTime":["0930-1130","1300-1500"],...}}   # 无家数字段
```
**接线建议**：**需自采样**（护盘采样器每次 tick 顺手取 `f104/f105/f106` 落盘即可，30s 粒度足够画分时曲线）；
**不建议**为它单独加高频轮询（请求量翻倍而信息增量小）。

## 7. 美元指数 DINIW —— **实测可得（两条独立路径，数值一致）**

```bash
# 路径 A：新浪（GBK，需 Referer）
curl -sS -x http://127.0.0.1:7890 "https://hq.sinajs.cn/list=DINIW" -H "user-agent: Mozilla/5.0" -H "referer: https://finance.sina.com.cn/"
```
```
var hq_str_DINIW="21:59:38,102.2991,102.2991,102.5844,4272,102.5704,102.5905,102.1633,102.2991,美元指数,2026-10-13";
```
```bash
# 路径 B：东财（push2delay，fltt=2 直接给浮点）
curl -sS -x http://127.0.0.1:7890 "https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=100.UDI&fltt=2&invt=2&fields=f2,f3,f4,f12,f14,f124" \
 -H "user-agent: Mozilla/5.0" -H "referer: https://quote.eastmoney.com/"
```
```
{"data":{"total":1,"diff":[{"f2":102.3,"f3":-0.27,"f4":-0.28,"f12":"UDI","f14":"美元指数","f124":1791899972}]}}
```
⇒ A `102.2991` / B `102.3`（同一时刻，差 0.001 = 上游截断）✓ 交叉核对通过。
**接线建议**：**直接可用**（A 作主源、B 作交叉校验或反之）；建议同时显示 `at`（A 的 `2026-10-13 21:59:38`），
因为美元指数 24 小时交易，**没有"收盘定稿"** —— 不能套用 A 股休市冻结口径。

## 8. 美国 10 年期国债收益率 —— **实测可得（两条路径 + 2.4 年日线历史）**

```bash
# 路径 A：东财 171.US10Y（现价 + 时间戳）
curl -sS -x http://127.0.0.1:7890 "https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=171.US10Y&fltt=2&invt=2&fields=f2,f3,f4,f12,f14,f124" \
 -H "user-agent: Mozilla/5.0" -H "referer: https://quote.eastmoney.com/"
```
```
{"data":{"total":1,"diff":[{"f2":5.2253,"f3":-0.4,"f4":-0.021,"f12":"US10Y","f14":"美国10年期国债收益率","f124":17...
```
```bash
# 路径 B：新浪全球债券 globalbd_us10yt
curl -sS -x http://127.0.0.1:7890 "https://hq.sinajs.cn/list=globalbd_us10yt,gb_us10yt,US10YT" -H "user-agent: Mozilla/5.0" -H "referer: https://finance.sina.com.cn/"
```
```
var hq_str_globalbd_us10yt="美国10年期国债,5.232,5.240,5.222,5.236,5.173,0,-0.3422,-0.0179,0,0,1791899931,2026-10-13,09:58:51,2036-08-15,4.625,1/2,95.445,美国";
var hq_str_gb_us10yt="";
```
⇒ A `5.2253` / B `5.232`（同一时刻，差 0.007 ≈ 0.13%）✓ 同一量纲（%），可直接交叉校验。
（注意：`gb_us10yt` 与 `US10YT` 两种写法都**空**，只有 `globalbd_us10yt` 有效。）

**历史序列长度**（东财日 K，`push2his`）：
```bash
curl -sS -x http://127.0.0.1:7890 "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=171.US10Y&klt=101&fqt=0&beg=0&end=20500101&fields1=f1,f2,f3&fields2=f51,f53&lmt=3" \
 -H "user-agent: Mozilla/5.0" -H "referer: https://quote.eastmoney.com/"
```
```
{"data":{"code":"US10Y","market":171,"name":"美国10年期国债收益率","klines":["2023-05-08,3.5186","2023-05-09,3.5262",...
```
⇒ 历史自 **2023-05-08** 起、末根 **2026-10-13 5.2253**（≈**2.4 年 / ~860 个交易日**）。
新浪历史路径**不可得**：`stock.finance.sina.com.cn/.../US_MinKService.getDailyK?symbol=us10yt` 实测返回
`x(null)`（该接口不认美债符号）。
**接线建议**：**直接可用**（现价双源 + 日线历史走东财 `push2his`）；注意 171.* 是**美债**，交易时段在
北京深夜 ⇒ 不能套 A 股 `inSession`/休市冻结口径（`em.ts` 的 `frozenOfflineSlot` 已显式排除非 `[01].` 市场 ✓）。

---

## 汇总表

| # | 项 | 判定 | 主路径 | 接线建议 |
|---|---|---|---|---|
| 1 | 涨停/跌停家数 | **实测可得** | `push2ex` 涨停池/跌停池（`tc`） | 直接可用（**别用 clist f51/f52**，实测不是涨跌停价） |
| 2 | 昨日成交额 | **本地可得但当前 null** | `breadth.json` → `prevAmount`（`routes.ts:565`） | 已接线；只差"连续两天"的历史 |
| 3 | 较昨日变动 | **部分成立** | 成交额可派生；涨跌停家数**未落盘** | 需新增落盘字段 |
| 4 | 全天成交额预测 | **外部不可得 ⇒ 自算** | 无现成接口；仓库已有 126 日 progressCurve | 需新增路由与降级口径（带标定来源/样本/区间） |
| 5 | 两融余额/融资净买 | **实测可得** | 深交所官方 JSON + 东财 `RPTA_RZRQ_LSHJ` | 直接可用（沪市官方只有 HTML ⇒ 不建议解析） |
| 6 | 日内涨跌家数序列 | **实测不可得** | 只有当前 `f104/f105/f106`；分时接口不含家数 | 需自采样（复用护盘 tick），不建议单独高频轮询 |
| 7 | 美元指数 DINIW | **实测可得（双源一致）** | 新浪 `DINIW` + 东财 `100.UDI` | 直接可用（24h 品种，不要套休市冻结） |
| 8 | 美债 10Y | **实测可得（双源 + 2.4 年历史）** | 东财 `171.US10Y`（+`push2his` 日K）；新浪 `globalbd_us10yt` | 直接可用（新浪历史不可得） |

**最值得接线的三项**：① **涨停/跌停家数**（`push2ex` 一次请求给家数+名单，补上市场情绪最直接的缺口）；
② **美债 10Y**（现价双源 + 2.4 年日线，mac 宏观面板/全球资金流都用得上，且与美元指数同为 24h 品种可共用口径）；
③ **两融余额**（深交所官方 JSON + 东财汇总双源，日频、字段全、可回看历史）。

## 未确认项（含确认方法）

| 项 | 确认方法 |
|---|---|
| 上交所两融的 JSON 接口 | `query.sse.com.cn/commonQuery.do` 只回了外壳；需在 SSE 页面上抓一个真实 XHR（sqlId + 参数），或在浏览器 DevTools 里看 `margin/sum` 的请求 |
| clist 自算涨跌停的口径完整性（ST 5%/北交所 30%/新股首日） | 取某日 `push2ex` 名单与自算结果对拍（`tc` vs 计数），差集即规则缺口 |
| 第 1 条 `push2ex` 的稳定性（是否随东财风控变化） | 连续多日各时段重跑同一条 curl，记录成功率；失败时是否有备用池接口 |
| `push2*` 可达性的长期稳定性 | 本轮全部可达，与既有"0 成功率"记录相反 ⇒ 建议后续每次探测都记时间戳与结果，形成可用性日志 |
| 全天成交额预测的误差分布 | 用历史日线重放：对每个交易日取 elapsed 时刻的累计额与 progressCurve 预估，与实际全天额比，给出 P50/P90 相对误差（未做） |
