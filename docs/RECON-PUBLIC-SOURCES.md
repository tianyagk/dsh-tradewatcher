# RECON-PUBLIC-SOURCES —— 国内外公开数据源可达性与字段实测（只读侦察）

- 侦察时间：2026-10-15 21:10–21:40（Asia/Shanghai）
- 目标：为数据层评估「可替代/可补充现有源（新浪 / 腾讯 / 东财）」的公开数据源
- **纪律**：① 访问前先取 `robots.txt`，`Disallow` 的路径**不发请求**（只记录）；② 同一主机 ≤5 次/小时（**有一处偏差，见 §6.3 如实披露**）；
  ③ 全部只读，未改 `src/**`、未 commit、未装、未动 profile、未重启服务、未在工作区跑 `npm run build`；临时文件全在 `/tmp/sources-recon-*`。
- 判定口径：**实测可得**＝拿到 200 且有可用体；**实测不可得**＝拿到明确拒绝/阻断（附状态码与片段）；
  **未确认**＝可达但参数/链路没打通，或按 robots 跳过（跳过者**不判可得性**）。工具：`/tmp/sources-recon/probe.py`（先 robots 再探针，逐条落 `probe-log.txt`）。
- **环境提示（影响可达性判定）**：本机经代理 `127.0.0.1:7890` 出网，部分域（Google 系、FRED、CoinGecko）在代理下握手失败或不通；
  探针脚本对 000/错误会**自动直连重试一次**并记录两种通道结果。

---

## ① 结论

**36 个主机 / 35 个候选全部过了一遍（含 Lead 点名的 5 组）：实测可得 23 条 ＝ 不需密钥 15 条 + 需密钥 8 条；另有实测不可得 4 条、按 robots 主动跳过 5 条、未确认 3 条。**
**最值得接入的是免密钥、官方、且我们现在确实缺的三类：汇率（Frankfurter / open.er-api / ECB eurofxref）、A股元数据与指数（深交所 API / 巨潮 / 中证指数）、宏观利率（美国财政部 Fiscal Data / ECB SDW / BIS）。**

| 判定 | 条数 | 明细 |
|---|---|---|
| **实测可得 · 不需密钥** | **15** | Treasury FiscalData、ECB SDW、BIS SDMX、OECD SDMX（结构可达）、美联储 H.15、Alpha Vantage（demo）、深交所 API、中国货币网中间价、中证指数、巨潮资讯、Frankfurter、open.er-api、ECB eurofxref XML、AkShare（GitHub 静态读）、基金业协会官网 |
| **实测可得 · 需密钥/账号** | **8** | FRED API、Finnhub、Tiingo、Polygon、FMP、exchangerate.host（政策已改）、OpenExchangeRates、Tushare（积分/token） |
| **实测不可得** | **4** | Yahoo chart（403）、国家统计局 data.stats.gov.cn（403）、CoinGecko（本机不通）、Nasdaq Data Link（robots 禁 API + 403） |
| **按 robots 主动跳过** | **5** | Stooq、Twelve Data、EODHD、中国人民银行、基金业协会 `gs.amac.org.cn` |
| **未确认** | **3** | FRED CSV（本机链路不稳）、上交所 query API（参数）、中债收益率曲线（参数） |

---

## ② 逐项清单（命令 / 片段 / 判定 / 密钥 / robots＋条款 / 可替代用途）

> 片段均截断 ≤200 字符；命令为可独立复现的 `curl`（探针脚本内部同款，`-A` 统一为 `Mozilla/5.0 (compatible; dsh-recon/1.0)`）。

### 2.1 国际宏观 / 利率

**① FRED 公开 CSV —— 未确认（本机链路不稳）· 不需密钥**
```bash
curl -sS -m 25 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10'
```
```
curl: (92) HTTP/2 stream 1 was not closed cleanly: INTERNAL_ERROR (err 2)   ← 代理下必失败
（--noproxy '*' 时：首次 http=200，随后同命令再次 92 ⇒ 结论：不稳，未取得片段）
```
- robots：`/robots.txt` 也返回 000（同链路问题）⇒ 未读取到规则。
- 用途：可作 **美债 10Y（DGS10）/ 美元指数（DTWEXBGS）/ 美元兑人民币（DEXCHUS）** 的免密钥来源，替代我们目前"只能靠新浪 `globalbd_us10yt`/`DINIW`"的现状。
- 确认方法：`curl --http1.1` 或换出口网络重试；`fredgraph.csv` 是公开下载端点、无需 key。

**② FRED API —— 实测可得（需密钥）**
```bash
curl -sS -m 25 'https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=DEMO&file_type=json'
```
```
{"error_code":400,"error_message":"Bad Request.  The value for variable api_key is not a 32 character alpha-numeric string."}
```
- robots：`# Allows all robots to visit all files. User-agent: * Crawl-delay: 2 Disallow:`（全允许，带 2 秒爬取延迟）。
- 用途：同上，但要走 key（免费申请）；错误信息即"必须 32 位 key"的证据。

**③ 美国财政部 Fiscal Data —— 实测可得 · 免密钥**
```bash
curl -sS -m 25 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates?page%5Bsize%5D=2'
```
```
{"data":[{"record_date":"2001-01-31","security_type_desc":"Marketable","security_desc":"Treasury Notes","avg_i…
```
- robots：404（无 robots.txt）⇒ 无声明限制。
- 用途：**美债平均利率/国债发行**等官方口径，免密钥、JSON、稳定；可补充"利率"这一块。

**④ ECB SDW（Data API）—— 实测可得 · 免密钥**
```bash
curl -sS -m 25 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?format=csvdata&lastNObservations=2'
```
```
KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,OBS_CONF,OBS_PRE_BREAK,O…
```
- robots：`Disallow` 仅针对若干 `_content.*.html` 静态页，`/service/` 未被禁 ⇒ 本次探针合规。
- 用途：**欧元/美元汇率、欧央行利率与宏观**；SDMX-CSV 直接可解析，可作汇率与外币利率的第二来源。

**⑤ BIS SDMX —— 实测可得 · 免密钥（但慢）**
```bash
curl -sS -m 40 'https://stats.bis.org/api/v1/data/WS_LONG_CPI/M..?format=csv'
```
```
FREQ,REF_AREA,UNIT_MEASURE,UNIT_MULT,TIME_FORMAT,BREAKS,COVERAGE,DECIMALS,TITLE_TS,TIME_PERIOD,OBS_VALUE,OBS_C…
（HTTP 200，228,792 字节，耗时 **25.0 s**）
```
- robots：`/robots.txt` 返回的是 SPA 页面（无有效规则）⇒ 无声明限制。
- 用途：**长期 CPI、实际汇率、跨境信贷**等；慢 ⇒ 只能服务端定时预取，不能进交互路径。

**⑥ OECD SDMX —— 实测可得（结构可达，具体 dataflow 未确认）· 免密钥**
```bash
curl -sS -m 25 'https://sdmx.oecd.org/public/rest/dataflow/OECD.SDD.STES?format=jsondata'
```
```
<?xml version="1.0" encoding="utf-8"?> <!--NSI Web Service v10.11.8.0--> <message:Structure xmlns:message="http://www.sdm…
```
- robots：404 ⇒ 无限制。用途：OECD 宏观数据集（SDMX 2.1），需先解析 dataflow 再取数。

**⑦ 美联储 H.15 —— 实测可得（HTML）· 免密钥**
```bash
curl -sS -m 25 'https://www.federalreserve.gov/releases/h15/'
```
```
<!DOCTYPE html> <html lang="en" class="no-js"> <head> <meta charset="utf-8" /> <meta http-equiv="X-…
```
- robots：404 ⇒ 无限制。用途：**美国利率（国债收益率曲线）**官方发布页（HTML；其 CSV/JSON 变体未确认）。

### 2.2 行情 / 历史（国际）

**⑧ Yahoo Finance chart —— 实测不可得 · 不需密钥但被拒**
```bash
curl -sS -m 25 'https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?range=1d&interval=1d'
```
```
403|3369|0.514421|text/html   <!DOCTYPE html> <html lang="zh"> … <title>Yahoo</title>
```
- robots：`/robots.txt` 同样 403（拿不到规则）；Yahoo 服务条款禁止自动化抓取 ⇒ **不要接入**。
- 用途（原本设想）：`^TNX`、`DX-Y.NYB`、`^GSPC`、`EWJ`、`EWY` —— 全部走不通，改由 FRED/ECB/Alpha Vantage 覆盖。

**⑨ Stooq CSV —— 按 robots 跳过 · 未判可得性**
```bash
curl -sS -m 25 'https://stooq.com/q/d/l/?s=%5Etnx&i=d'   # 未发出
```
```
robots.txt: User-agent: Bingbot Allow: /  User-agent: Googlebot Allow: /  User-agent: * Disallow: /
```
- 处置：`Disallow: /` ⇒ **零请求**。用途：原本可作免密钥历史 CSV，现不可用。

**⑩ Nasdaq Data Link —— 实测不可得（robots 禁 API + 403）**
```bash
curl -sS -m 25 'https://data.nasdaq.com/api/v3/datasets/FRED/DGS10.csv?rows=2'
```
```
403|886|1.758323|text/html  <html …><head><META NAME="ROBOTS" CONTENT="NOINDEX, NOFOLLOW">…
```
- robots：`disallow: /api/*.csv*`、`disallow: /api/*.json*` …（**通配符**禁 API 数据出口）。
- **偏差披露**：我的 robots 匹配器只做前缀比对、漏了通配符，因此这一条探针被发出（随后被 403 拦下，未取到任何数据）；此后未再请求。

**⑪ Alpha Vantage —— 实测可得（demo）· 生产需免费 key**
```bash
curl -sS -m 25 'https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=IBM&apikey=demo'
```
```
{ "Global Quote": { "01. symbol": "IBM", "02. open": "231.1300", "03. high": "233.…
```
- robots：404 ⇒ 无限制。用途：**国际股票/ETF/外汇/加密的 EOD 与实时**（免费层限量），可替代 Yahoo 类需求。

**⑫ Twelve Data —— 按 robots 跳过**
```
robots.txt: User-agent: * Disallow: /
```
**⑬ Finnhub —— 实测可得（需密钥）**
```bash
curl -sS -m 25 'https://finnhub.io/api/v1/quote?symbol=AAPL&token=demo'
```
```
401|28|application/json; charset=utf-8   {"error":"Invalid API key."}
```
- robots：只禁 `/terms-of-service`、`/faq`，`Allow: /` ⇒ API 路径允许。
**⑭ Tiingo —— 实测可得（需密钥）**
```bash
curl -sS -m 25 'https://api.tiingo.com/tiingo/daily/aapl/prices?token=demo'
```
```
403|27|application/json   {"detail":"Invalid token."}
```
- robots：禁 `/admin`，其余允许。
**⑮ EODHD —— 按 robots 跳过**
```
robots.txt 中含 Disallow: /api/   ⇒ 未发请求
```
**⑯ Polygon.io —— 实测可得（需密钥）**
```bash
curl -sS -m 25 'https://api.polygon.io/v2/aggs/ticker/AAPL/prev?apiKey=demo'
```
```
401|92   {"status":"ERROR","request_id":"ba8ab3f2de4d88a3e39a793bca8a44f0","error":"Unknown API Key"}
```
- robots：404 ⇒ 无限制。
**⑰ Financial Modeling Prep —— 实测可得（需密钥）**
```
401   {"Error Message": "Invalid API KEY. Feel free to create a Free API Key or visit https://site.financialmodel…
```
**⑱ CoinGecko —— 实测不可得（本机不通）**
```bash
curl -sS -m 25 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd'
```
```
000|0|1.288034||（代理与直连重试均为 000；robots.txt 同样 000）
```
- 判定：本机网络不可达 ⇒ **未取得**任何字段证据；加密行情可改用 Alpha Vantage（需 key）或交易所公开行情。

### 2.3 国内

**⑲ 上交所 query API —— 未确认（可达但参数未打通）· 免密钥**
```bash
curl -sS -m 25 -H 'Referer: https://www.sse.com.cn/' \
 'https://query.sse.com.cn/commonQuery.do?sqlId=COMMON_SSE_ZQPZ_GPLB_MCJS_SSHGPLB_L&pageHelp.pageSize=5&pageHelp.pageNo=1&pageHelp.beginPage=1&pageHelp.cacheSize=1&pageHelp.endPage=1'
```
```
200|503|application/json;charset=UTF-8   {"actionErrors":[],"actionMessages":[],"fieldErrors":{},"isPagination":"false","jsonCallBack":null,"locale":"e…
```
- 试过 3 个 `sqlId`/参数组合，均返回**空 result**（`isPagination:false`）⇒「接口活着、参数不对」。
- robots：`query.sse.com.cn/robots.txt` 404 ⇒ 无声明限制（`www.sse.com.cn` 未单独探针）。
- 确认方法：人工在 `www.sse.com.cn` 页面开 devtools，抄一个真实 XHR 的 `sqlId` 与分页参数，再复跑一次。
- 用途：**上交所官方行情/ETF 列表/融资融券**（若能打通），可作东财的官方兜底。

**⑳ 深交所 报表 API —— 实测可得 · 免密钥**
```bash
curl -sS -m 25 -H 'Referer: https://www.szse.cn/' \
 'https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=1110&TABKEY=tab1&PAGENO=1'
```
```
[{"metadata":{"catalogid":"1110","name":"A股列表","excel":"xlsx","pagetype":"tabs","subname":"2026-10-15 ","tabke…
（HTTP 200，21,476 字节）
```
- robots：200 但内容为空 ⇒ 无规则限制。用途：**深市 A 股列表/市场总貌**（含日期），可作"新股/停牌/上市状态"的官方元数据补充。

**㉑ 中国货币网 人民币中间价 —— 实测可得 · 免密钥**
```bash
curl -sS -m 25 -H 'Referer: https://www.chinamoney.com.cn/' \
 'https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/fx/ccpr.json'
```
```
{"head":{"version":"2.0","provider":"CWAP","req_code":"","rep_code":"200","rep_message":"","ts":1792027540607,…
（HTTP 200，10,990 字节）
```
- robots：404 JSON ⇒ 无声明限制。用途：**人民币汇率中间价（官方）**，直接替代/校准我们现在的汇率口径（`prefs.fxRates` 靠手填）。

**㉒ 中债（chinabond）—— 未确认（可达、参数未打通）· 免密钥**
```bash
curl -sS -m 25 -H 'Referer: https://yield.chinabond.com.cn/' -H 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8' \
 --data 'xyzSelect=txy&workTime=2026-10-15&dxbj=0&qxll=0%2C1%2C3%2C5%2C7%2C10%2C30&yqqxN=N&yqqxK=K&locale=zh_CN' \
 'https://yield.chinabond.com.cn/cbweb-mn/yc/searchYc'
```
```
200|2|application/json;charset=UTF-8   []
（GET 同一路径 → 405 Method Not Allowed ⇒ 需 POST，方法已对、参数未对）
```
- robots：`yield.chinabond.com.cn/robots.txt` 404；`www.chinabond.com.cn` 首页 200 HTML（413 KB）。
- 确认方法：从 `yield.chinabond.com.cn` 页面抓真实请求体（含曲线上报编码），或改用其"中债收益率曲线"下载页。
- 用途：**国债收益率曲线**（我们目前只有新浪 `globalbd_us10yt` 这一条美债口径）。

**㉓ 中证指数 —— 实测可得 · 免密钥**
```bash
curl -sS -m 25 -H 'Referer: https://www.csindex.com.cn/' \
 'https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=000300&startDate=20261001&endDate=20261015'
```
```
{"code":"200","msg":"Success","data":[{"tradeDate":"20261001","indexCode":"000300","indexNameCnAll":"沪深300指数",…
（无日期参数时返回 {"code":"400","msg":"Parameter Errors"} ⇒ **必须带 indexCode+startDate+endDate**）
```
- robots：返回 SPA 页面（无有效规则）。用途：**沪深300/中证系列指数行情与历史**（官方），可作指数点位与成分的第二来源。

**㉔ 国家统计局 data.stats.gov.cn —— 实测不可得（403）**
```bash
curl -sS -m 25 'https://data.stats.gov.cn/easyquery.htm?m=QueryData&dbcode=hgnd&rowcode=zb&colcode=sj&wds=%5B%5D&dfwds=%5B%5D&k1=1'
```
```
403|288|text/html; charset=utf-8   <!DOCTYPE html> <html> <head><title>403 Forbidden</title></head> <body bgcolor="white"> <center><h1>403…
```
- robots：404（返回 JSON 404）。判定：反爬拒绝 ⇒ **不接入**（宏观数据改用 Treasury/ECB/BIS/OECD）。

**㉕ 中国人民银行 —— 按 robots 跳过**
```
robots.txt: User-agent: Baiduspider Allow: /  User-agent: * Disallow: /   ⇒ 零请求
```
**㉖ 巨潮资讯（cninfo）—— 实测可得 · 免密钥**
```bash
curl -sS -m 25 'http://www.cninfo.com.cn/new/data/szse_stock.json'
```
```
{"stockList":[{"code":"000001","pinyin":"payh","category":"A股","orgId":"gssz0000001","zwjc":"平安银行"},…
（HTTP 200，592,677 字节）
```
- robots：404 ⇒ 无声明限制。用途：**A股代码/拼音/orgId/简称清单**（公告检索的前置索引），可替代我们目前从自选里推导代码的做法。
  （公告查询接口 `new/hisAnnouncement/query` 为 POST，本次未测 ⇒ 见 §5。）

**㉗ AkShare（开源聚合）—— 实测可得（静态阅读）**
```bash
curl -sS -m 25 'https://raw.githubusercontent.com/akfamily/akshare/main/README.md'
```
```
**资源分享**：对于想了解更多财经数据与量化投研的小伙伴… （HTTP 200，12,649 字节）
README 中出现：github.com(26) akshare.akfamily.xyz(11) www.szse.cn www.sse.com.cn www.shfe.com.cn www.sgx.com …
```
- robots：`raw.githubusercontent.com/robots.txt` 404（GitHub 侧的 robots 在 github.com）。用途：**上游发现地图**（它把 sse/szse/shfe/sgx 等官方源与各类网页源封装成统一接口名，文档站有"接口名→上游"对照）。
- **注意**：AkShare 是聚合器而非数据源，**接入前仍要按每个上游自己的条款/robots 逐项确认**（与本报告同一套纪律）；不可整体当作"一个源"。

**㉘ Tushare —— 实测可得（需 token/积分）**
```bash
curl -sS -m 25 -H 'Content-Type: application/json' --data '{"api_name":"daily","token":"","params":{},"fields":""}' 'https://api.tushare.pro/'
```
```
{"request_id":"","code":40101,"data":null,"msg":"您上传Token！","detail":""}
（原文如此；语义即"未提供/无效 token"）
```
- robots：GET `/robots.txt` 被当作 API 调用返回 JSON（无 robots 规则）。用途：A股日线/财务，需账号与积分。

**㉙ 基金业协会 —— `gs.amac.org.cn` 按 robots 跳过；`www.amac.org.cn` 实测可得（HTML）**
```
robots.txt(gs.amac.org.cn): # robots.txt example file  User-agent: *  Disallow: /amac-infodisc/    ⇒ 零请求
www.amac.org.cn/ → 200|378428|text/html（官网可达；未发现 JSON API 证据）
```
- 用途：**公募基金名录/管理人信息**（若要，需人工确认官方数据下载页；`gs.amac.org.cn` 的公开查询接口已被 robots 明确禁止）。

### 2.4 汇率

**㉚ exchangerate.host —— 实测可得（政策已改为需 key）**
```
200  {"success": false, "error": {"code": 101, "type": "missing_access_key", "info": "You have not supplied…
```
**㉛ OpenExchangeRates —— 实测可得（需密钥）**
```
401  {"error": true,"status": 401,"message": "invalid_app_id","description": "Invalid App ID provided. …
```
- robots：`User-agent: * Disallow:`（空＝全允许）。
**㉜ Frankfurter（ECB 派生）—— 实测可得 · 免密钥 ⭐**
```bash
curl -sS -m 25 'https://api.frankfurter.app/latest?from=USD&to=CNY'
```
```
{"amount":1.0,"base":"USD","date":"2026-10-14","rates":{"CNY":6.6927}}
```
- robots：404 JSON ⇒ 无限制。特点：极简、无 key、日频（T-1）。
**㉝ open.er-api.com（exchangerate-api 免费层）—— 实测可得 · 免密钥**
```
{"result":"success","provider":"https://www.exchangerate-api.com","documentation":"https://www.exchangerate-ap…
（HTTP 200，2,970 字节）
```
**㉞ ECB eurofxref-daily.xml —— 实测可得 · 免密钥**
```bash
curl -sS -m 25 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'
```
```
<?xml version="1.0" encoding="UTF-8"?> <gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xm…
```
- robots：仅禁部分 `_content.*.html` ⇒ 该 XML 允许。用途：欧元基准汇率（含 CNY），日频。

### 2.5 基金（补充面）

| 源 | 判定 | 说明 |
|---|---|---|
| 天天基金（现有：`fundgz.1234567.com.cn` / `fund.eastmoney.com`） | 已在用 | 本轮不重复探测 |
| `www.amac.org.cn`（基金业协会官网） | 实测可得（HTML） | 可达但无 JSON API 证据；公募名录类数据需人工找官方下载页 |
| `gs.amac.org.cn`（公开查询接口） | 按 robots 跳过 | `Disallow: /amac-infodisc/` |
| 场外公募估值（我们已在用的 `fundgz`） | 无更优免密钥替代 | 本轮未发现可替代 `fundgz` 的免密钥官方源 |

---

## ③ 汇总表（能否替代/补充我们现有源）

| 候选 | 判定 | 密钥 | 可替代/补充我们现在的 | 备注 |
|---|---|---|---|---|
| 美国财政部 Fiscal Data | 可得 | 免 | **补充**：利率/国债（现在只有新浪美债 10Y） | JSON，官方 |
| ECB SDW | 可得 | 免 | **补充**：EUR/USD、欧央行利率 | SDMX-CSV |
| BIS SDMX | 可得 | 免 | 补充：长期 CPI/实际汇率 | 25 s，只可后台预取 |
| OECD SDMX | 可得（结构） | 免 | 补充：宏观 | 需先解 dataflow |
| 美联储 H.15 | 可得（HTML） | 免 | 补充：美债曲线 | 非 API |
| FRED CSV | **未确认** | 免 | 可替代：美债 10Y/美元指数/美元兑人民币 | 本机链路不稳 |
| FRED API | 可得 | **需 key** | 同上 | 免费申请 |
| Alpha Vantage | 可得（demo） | **需 key**（免费层） | **可替代 Yahoo**：国际股票/ETF/外汇 EOD | 限量 |
| Finnhub / Tiingo / Polygon / FMP | 可得 | **需 key** | 可替代：国际行情（实时性最强的是 Polygon） | 商业条款各异 |
| Yahoo chart | **不可得** | — | — | 403 + ToS 禁自动化 |
| Stooq / Twelve Data / EODHD | 按 robots 跳过 | — | — | `Disallow: /`（EODHD 禁 `/api/`） |
| Nasdaq Data Link | 不可得 | 需 key | — | robots 禁 `/api/*.json|csv` |
| CoinGecko | 不可得（本机） | 免（免费层） | 加密行情 | 网络不通 |
| 深交所报表 API | **可得** | 免 | **补充/兜底**：A股列表、市场总貌、上市状态 | 官方 JSON |
| 巨潮 `szse_stock.json` | **可得** | 免 | **补充**：代码/拼音/orgId 清单 | 592 KB |
| 中证指数 API | **可得** | 免 | **补充/替代**：指数点位与历史 | 需三参数 |
| 上交所 query API | 未确认 | 免 | 潜在：沪市行情/ETF/两融 | 参数待抄 |
| 中债收益率曲线 | 未确认 | 免 | 潜在：国债收益率曲线 | POST 参数待抄 |
| 中国货币网中间价 | **可得** | 免 | **替代**：人民币中间价（我们目前手填汇率） | 官方 JSON |
| 国家统计局 | 不可得 | — | — | 403 反爬 |
| 中国人民银行 | 按 robots 跳过 | — | — | `Disallow: /` |
| AkShare | 可得（文档） | — | **上游地图**（不是源） | 逐个上游仍需合规确认 |
| Tushare | 可得 | **需 token/积分** | 补充：A股财务/日线 | 商业条款 |
| 基金业协会 | 跳过/官网可达 | — | 基金名录（潜在） | 公开接口被 robots 禁 |
| Frankfurter | **可得** | 免 | **替代**：USD/CNY 日频 | 极简 |
| open.er-api | **可得** | 免 | 替代：多币种日频 | 免费层 |
| ECB eurofxref | **可得** | 免 | 替代：欧元基准（含 CNY） | XML |
| exchangerate.host | 可得 | **需 key** | — | 政策已变更 |
| OpenExchangeRates | 可得 | **需 key** | — | — |

---

## ④ 最值得接入的 3 条（含落地建议）

1. **汇率三件套：Frankfurter + ECB eurofxref + 中国货币网中间价（全部免密钥、官方/半官方）**
   - 现状：我们的 `prefs.fxRates` 是**手工汇率**，跨币种持仓折算依赖它。
   - 建议：宿主侧每日一次预取三源（Frankfurter 作主、ECB 作校验、货币网中间价作"官方人民币口径"），落入 `prefs.fxRates` 的**来源与时刻**字段（沿用我们既有的 `asOf/stale/source` 契约），失败不清空旧值。
   - 成本：3 次请求/日；风险：曾出现 `missing_access_key` 类政策变更 ⇒ 需按 §5 的"多源降级"顺序实现。
2. **A股元数据与指数：深交所报表 API + 巨潮股票清单 + 中证指数（免密钥、官方）**
   - 现状：代码/名称/上市状态来自东财与自选推导；指数点位只有东财/新浪。
   - 建议：把这三个源作为**元数据与指数的第二来源**，只在主源（东财）不可用或需要"官方口径"时启用；巨潮清单可直接作为搜索/代码校验的本地索引。
   - 成本：每日 1–2 次；风险：参数化较强（中证必须带日期），需写死参数模板并加断言。
3. **宏观利率：美国财政部 Fiscal Data + ECB SDW（+ BIS 作慢速归档）（免密钥、JSON/CSV）**
   - 现状：利率口径仅新浪美债 10Y/美元指数；财经日历只有东财事件。
   - 建议：服务端每日预取，作为面板"宏观/利率"块的**官方口径兜底**；BIS 因 25 s 延迟只能进离线归档，不进交互路径。
   - 成本：2–3 次请求/日；风险：SDMX 维度多、解析要写测试（可离线 fixture）。

> 三条都不需要密钥、都不与现有源冲突（可作主源的校验/兜底），且都落在我们**目前最薄的三处**：汇率、元数据/指数、宏观利率。

---

## ⑤ 未确认项与确认方法

| # | 未确认项 | 为什么未确认 | 合规确认方法 |
|---|---|---|---|
| 1 | FRED `fredgraph.csv` 的字段与频率 | 本机链路 92/000（代理与直连各成功过一次但未取到体） | `curl --http1.1` 或换网络重试；或在允许的环境用浏览器打开该 CSV |
| 2 | 上交所 `commonQuery.do` 的可用 `sqlId` 与分页参数 | 3 组参数均返回空 result | 人工在 `www.sse.com.cn` 开 devtools 抄一条真实 XHR（含 `Referer`/参数） |
| 3 | 中债 `searchYc` 的请求体编码 | POST 返回 `[]`（方法对、参数不对）；GET 405 | 同上，人工抄请求体；或改用其收益率曲线下载页 |
| 4 | 巨潮公告查询（`new/hisAnnouncement/query`） | 该接口是 POST + 表单，本轮未测（只测了 `szse_stock.json`） | 按官方页面的 XHR 复现（人工抄参数） |
| 5 | Yahoo `^TNX`/`DX-Y.NYB` 等符号的替代覆盖 | Yahoo 403；Alpha Vantage/Finnhub 等需 key，未验证符号覆盖率 | 申请一个免费 key 后各取 1 个符号验证（每主机 ≤5 次/时） |
| 6 | CoinGecko 字段 | 本机不通（000） | 换网络重试；或用交易所公开行情 |
| 7 | OECD 具体 dataflow/维度 | 只验证了 `/dataflow` 结构可达 | 先取 dataflow 列表（`format=jsondata`）再按 key 取数 |
| 8 | AkShare 各接口对应的上游与条款 | 只见 README；逐接口映射在其文档站 | 读 `akshare.akfamily.xyz` 文档（静态），再按本报告纪律对每个上游逐一 robots 检查 |

---

## ⑥ 纪律执行记录

### 6.1 robots.txt 一览（本小时实取）

| 主机 | robots 结论 | 我们的处置 |
|---|---|---|
| api.stlouisfed.org | 全允许 + `Crawl-delay: 2` | 探针 1 次（按延迟自律） |
| data.nasdaq.com | 通配符禁 `/api/*.json|csv|xml` | **探针误发 1 次（被 403 拦下）**，此后停止 |
| api.twelvedata.com | `Disallow: /` | **零请求** |
| stooq.com | `Disallow: /`（仅 Bing/Google 允许） | **零请求** |
| www.pbc.gov.cn | `Disallow: /`（仅 Baiduspider 允许） | **零请求** |
| gs.amac.org.cn | `Disallow: /amac-infodisc/` | **零请求** |
| eodhd.com | 含 `Disallow: /api/` | **零请求** |
| www.ecb.europa.eu | 仅禁部分 `_content.*.html` | XML 汇率允许 |
| data-api.ecb.europa.eu | 仅禁部分静态内容 | `/service/` 允许 |
| finnhub.io / api.tiingo.com | 允许（仅禁各自 help/admin） | 允许 |
| openexchangerates.org | `Disallow:`（空＝全允许） | 允许 |
| api.fiscaldata.treasury.gov / sdmx.oecd.org / api.polygon.io / api.frankfurter.app / www.federalreserve.gov / www.cninfo.com.cn / www.chinabond.com.cn / query.sse.com.cn / raw.githubusercontent.com / www.amac.org.cn | 404（无 robots.txt） | 无声明限制 |
| www.szse.cn | 200 空体 | 无限制 |
| www.chinamoney.com.cn | 404 JSON | 无限制 |
| www.csindex.com.cn | 返回 SPA 页面（无有效规则） | 无限制 |
| query1.finance.yahoo.com | **403（拿不到规则）** | 未再请求 |
| fred.stlouisfed.org / api.coingecko.com / financialmodelingprep.com / stats.bis.org / sdmx.oecd.org | 000/403/SPA 等异常 | 按"能取到才判"处理，异常已如实标注 |

### 6.2 每主机请求次数（含 robots.txt）

```
 8  query.sse.com.cn          4  api.coingecko.com     4  www.csindex.com.cn    4  yield.chinabond.com.cn
 3  fred.stlouisfed.org       2  （其余 30 台主机各 1–2 次）
总请求 85 次，覆盖 36 个主机 ⇒ 平均 2.4 次/主机
```

### 6.3 偏差披露（如实）

1. **`query.sse.com.cn` 本小时 8 次，超过自律上限 5 次**。原因：我把候选分 4 组分别跑，**每个脚本进程都重新取了一次 robots.txt**；
   其中**数据探针 4 次**（≤5）、robots 4 次。处置：已停止对该主机的全部请求；后续如需再测，合并到单进程脚本里复用 robots 结果。
2. **`data.nasdaq.com` 发出 1 次探针**，而该站 robots 用**通配符**禁 API（我的匹配器只做前缀比对）。
   处置：已停止请求；探针本身被 403 拦下、**未取到任何数据**。
3. 除上述两条，其余主机均 ≤5 次；`Disallow` 主机**零请求**（见 §6.1）。

---

## 附录：复现入口

```bash
# 侦察工具（先 robots，后探针；000 时自动直连重试一次；逐条落 JSONL）
python3 /tmp/sources-recon/probe.py            # 模块（被下列分组脚本 import）
python3 /tmp/sources-recon/g1_macro.py         # 宏观/利率
python3 /tmp/sources-recon/g2_quotes.py        # 国际行情
python3 /tmp/sources-recon/g3_cn.py            # 国内官方
python3 /tmp/sources-recon/g4_fx_fund.py       # 汇率/基金/Tushare/中证
python3 /tmp/sources-recon/g5_more.py          # 汇率备选/美联储/中债/AkShare
python3 /tmp/sources-recon/g6_final.py         # SSE 参数/中债 POST/协会
# 全量原始记录（每条含 URL、状态、大小、耗时、前 200 字符、robots 判定）
/tmp/sources-recon/probe-log.txt
```
