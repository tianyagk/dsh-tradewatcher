# AUDIT-BK-AGG：板块指数周/月/年 K（同源主机回退 + 日线聚合 + 原因去重）

**一行结论**：板块指数（东财 `90.BK*`）**没有可用的日线源**（腾讯不认板块码、东财 `push2*` 零请求、本地零缓存），
所以「周/月/年」原本就取不到；本轮把三件事做实：① 腾讯 K 线加**同源三台主机回退**（`web.ifzq.gtimg.cn`
被 WAF 挡成 501 时换兄弟机，实测同一时刻另两台 200）；② 周/月/年新增**由本地日线缓存聚合**的兜底
（不接新源、零新增请求，口径写进状态行）；③ 缺失原因**改成一条准确的话**并**只渲染一次**（原先把
结构性缺源说成「主机熔断冷却中」，且同一句渲染两遍）。

- 条件说明：`build.mjs` 未改（构建 73 项照旧）；`push2*` **零请求**（本轮所有东财主机调用都在 stub 里，
  真实网络只打了腾讯三台 + 一次本地 `/tradewatcher/health` 只读）；未 commit、未装、未重启 `dsh web`；
  `~/.dsh` **未手工写入**（只在实验里**读/复制**过 `klines/1.000001_101_0.json`）。
- 门禁：**1091 × 2 时区**（Asia/Shanghai 与 UTC 各 1091/1091 通过）+ `npm run selftest` + 构建 73 项。
  1091 = 1072（基线）+ 6（并行批未提交的 `klineHint.test.ts`）+ **13（本轮新增）**。

---

## 1. 步骤一：板块指数到底有没有日线（实测，不猜）

| 源 | `90.BK*` 日线 | 原生周/月/年 | 证据（本轮实测/代码事实） |
|---|---|---|---|
| 腾讯 `fqkline` / `kline` | **不可得** | 不可得 | `tencentSymbol('90.BK0475')` → `null`（`tencentIndexCode` 只映射 `100.*` 国际指数）⇒ 这条链路**一次都不请求**。改用腾讯自己的板块码 `pt01801731`（实测取自 `proxy.finance.qq.com/.../mktHs/rank` 的 `bd_code`）打 `kline/kline` 与 `fqkline` 的 `day`：`lmt=5` 与 `lmt=320` **都只回 1 根（2026-10-22）**，无历史 |
| 东财 `push2his` / `push2delay` / `push2` | 未测（政策禁） | 未测 | 三台 `robots.txt` 均 `Disallow: /` ⇒ 按纪律**零请求**（既有结论，见 `docs/PROBE-CHIPS-WINDOW.md`、`docs/PROBE-RESCUE-UI.md`）；本轮同样一条没发 |
| 本机 `~/.dsh/dsh-tradewatcher/klines/` | **无缓存** | 无 | 207 个文件里 `90.*` **0 个**、`2.*` **0 个**；指数只有 `1.000001_101_0.json`（809 根日线，无 102/103）、`0.399001_101_0.json`（只有日线）、`1.000688` 有 101/102/103 |

**结论**：
- 板块指数的**日线**在三条链路上都拿不到（腾讯不覆盖、东财按纪律不请求、本地零缓存）⇒ 原生周/月/年更不可能有。
- 但**指数类标的普遍"有日线、缺周/月/年"**（上表 `1.000001`/`0.399001` 就是）：日线在手却算不出周线 = **丢数据**。
- 另外查到一条与本症状直接相关的事实：`web.ifzq.gtimg.cn/appstock/app/fqkline/get` **会被 WAF 挡成 HTTP 501**
  （回包是 `waf.tencent.com/501page.html` 挑战页，对**任何**标的、任何周期都一样）：

| 时刻（本机，2026-10-22） | `web.ifzq.gtimg.cn` | `ifzq.gtimg.cn` | `proxy.finance.qq.com` |
|---|---|---|---|
| 14:26 | **501**（326 B WAF 页） | 200（2048 B） | 200（2051 B） |
| 14:41 | 200（176 ms） | 200（114 ms） | 200（117 ms） |
| 14:43 | 200（177 ms） | 200（113 ms） | 200（118 ms） |

也就是说那是一个**窗口**（现在已恢复），而旧实现把这一台写死在 K 线链路上 ⇒ 窗口期内**所有** A股/港股
K 线（含所有周期）都"没数据"，用户看到的就是「本地确实没有该周期的缓存数据；本轮没有向上游发请求
（主机熔断冷却中（未发出上游请求））」。同一时刻另两台是 200 —— 回退本可当场救回。

---

## A. 腾讯 K 线**同源主机回退**（Lead 追加的 A 段）

### A.1 实现

- `src/host/tencent.ts`：`TENCENT_KLINE_HOSTS` 固定顺序
  `web.ifzq.gtimg.cn` → `ifzq.gtimg.cn` → `proxy.finance.qq.com`（**同一路径、同一查询串**；`proxy` 的
  `/ifzqgtimg` 前缀单独编码在 `base` 里，不混进参数）；`fetchTencentAppstock()` 逐台尝试、
  逐台记账（`TencentKlineTry{host,ok,status,ms,error}`），任一台 200 即返回；三台都失败才抛
  `TencentKlineUnavailableError`（携带 `tries`）。
- **501/WAF 不当数据**：非 2xx 走 `withHostBreaker` 的 `res.ok === false` 分支 ⇒ 记「主机失败」+ 抛出；
  200 但正文非 JSON 也按主机失败记账（WAF 的 200 版挑战页）。回包里**永远不会**出现"0 根 K 线"这种假数据。
- 失败那台被兄弟机接住 ⇒ `noteHostFallback(host, servedBy)` ⇒ `/health` 的 `upstream.hosts[].servedBy`
  与摘要行写「降级（同源 X 接住）」，**不判死**（`degrade.ts` 新增 `servedBy/servedByAt` 两个字段）。
- `em.requestKlineFromTencent` 改用它；解析抽成**纯函数** `parseTencentKlineNode()`（三台共用同一份解析）。
- `tencent.ts::fetchTencentDaily`（位置/底部回算用的日线）也改用同一 helper。
- 三台都不可用时记一条 `klineHostDown`（逐台状态码），由 `klineMissingReason` 说「主机不可用」。

### A.2 实测（真实网络，仅腾讯三台）

- 回退链路耗时：三台依次 401–410 ms（含两次失败）；**成功时只打一台**：`1.600519`(周K) 232 ms、
  `1.000001`(周K) 103 ms、`116.00700`(日K) 141 ms，各 **1 条**请求（`web.ifzq` 命中即返回）。
- 解析等价：`ifzq` 与 `proxy` 的同一 `param` 回包 `qfqday` 数组**逐字相同**（整包长度 2048 vs 2051 的差在
  `qt`/`mx_price` 元数据的时间戳上，解析侧不取）。

### A.3 断言 + 反例注入（`src/host/klineHostFallback.test.ts`，4 条）

| 判据 | 读数 | 注入（必败） |
|---|---|---|
| ① 首台 501、第二台 200 ⇒ 取数成功 | `host=ifzq.gtimg.cn`、`tries=[web.ifzq 501 ✗, ifzq 200 ✓]`、健康簿 `servedBy=ifzq.gtimg.cn`、摘要行含「降级」 | 不回退（`legacyNoFallback → null`）⇒ 「必须落到第二台」失败 |
| ② 三台全失败 | `TencentKlineUnavailableError`（`tries` 三台逐条、含 `status=501` / `null`）、**每台** `fails +1`、`/kline` 理由 `why=transient` 且含「主机不可用」「都不可用」、**不含**「上游没有这份数据」「无此数据」「熔断冷却中」 | 把 501 写成「上游无此数据/重试无用」⇒ 否定断言失败 |
| ③ 回退不改变解析结果 | 纯函数解析逐字相同；端到端"由第二台服务" vs "由第三台服务" 的 `days` JSON **完全相同**；`qfqday` 是 O-C-H-L 顺序（`open=1286, close=1312.97, high=1317.76, low=1282`） | 换主机顺手改参数（去掉 `qfq`）⇒ 解析直接拿不到（证明"参数逐字一致"不是空话） |
| 前置 | 回退顺序与三台 `base` 前缀（`/appstock` ×2、`/ifzqgtimg/appstock`）逐项固定 | 顺序是契约：谁改了顺序这条就红 |

---

## B. 周/月/年 K 的**日线聚合兜底**（Lead 的 B 段）

### B.1 实现（不接新源、不发新请求）

- `src/host/klineAggregate.ts`（新）：把 `usAggregate.ts` 里的桶键/聚合**抽成唯一实现**，
  导出 `aggBucketOf` / `aggregateDaily` / `aggPeriodOfKlt` / `shouldAggregate` / `aggCaliberOf` / `AGG_NOTE`。
  `usAggregate.ts` 改为**别名**（`usBucketOf`/`aggregateUsDaily`/`US_AGG_NOTE` 指向同一份），
  只保留美股特有件（`usAggCaliber` 的未复权+拆股计数、`detectUsSplits`、`splitMarksOf`）。
- 口径（写进代码与断言）：周＝周一起、月＝1 号起、年＝1 月 1 日起（按交易日归桶，桶内**首日**做 key）；
  `O/H/L/C` ＝ 首/最高/最低/末；`vol`/`amount` ＝ 求和，但**任一日缺失 ⇒ 该桶 null**（不 0 相加）；
  `pct` ＝ 相对上一根聚合收盘（年K 即"同比"）。
- `em.fetchKline`：周/月/年**原生一条都没拿到**时，读**本地日线缓存**（同 `fqt` 口径）聚合，回包带
  `aggregated{period, note}` 与 `stale:true`、`asOf` 取**日线**的落盘时刻；原生数据永远优先
  （`shouldAggregate` 要求 `nativeBars === 0`、日线 ≥ `KLINE_MIN_USABLE_BARS`）。**不落盘**聚合结果
  （不污染原生缓存文件），也**不发任何请求**。
- 口径句只进**已有的状态行**（`QuoteDrawer.caliberLine` 的 `aggNote`，原为美股专用），不新增浮层：
  `由日线聚合（非上游原生周线/月线/年线）（月K）· 日线取自本地缓存 809 根（截至 10-22 14:41）`

### B.2 实测读数（复制本机真实 `1.000001_101_0.json`，809 根日线；上游全部离线）

| 档 | 请求数 | 根数 | 末根 | O / H / L / C | vol | pct |
|---|---|---|---|---|---|---|
| 月K | 9（全为 stub 的腾讯+东财尝试，聚合本身 0） | 20 | 2026-10-08 → 10-22（11 个交易日） | 3838.98 / 3864.12 / 3649.86 / 3658.04 | 4 987 267 026 | −4.79（3842.19 → 3658.04） |
| 年K | 0 | 4 | 2026-01-05 → 10-22（192 个交易日） | 3986.97 / 4258.86 / 3649.86 / 3658.04 | 116 974 158 775 | −7.83（3968.84 → 3658.04，同比） |

指数日线没有成交额 ⇒ 聚合后 `amount = null`（**不是 0**），与"不许 0 顶替"一致。

**板块指数本身（没有日线缓存）**：仍是"未取到"，但原因变成一条准确的话（实测字符串）：

```
本地确实没有该周期的缓存数据；板块指数没有可用的日线源：腾讯 K 线不覆盖板块码（90.BK*），
东财是唯一链路而它这次也没给出数据（本机长期连不通）；本地也没有它的日线缓存，聚合不出周/月/年
—— 稍后自动重试
```

（`why=transient`：动作按"东财这条唯一链路此刻可不可用"给；**不再**出现「熔断冷却中」。）

### B.3 断言 + 反例注入（`src/host/klineAgg.test.ts` 6 条 + `src/client/klineUnavailable.test.ts` 3 条）

| 判据 | 读数 | 注入（必败） |
|---|---|---|
| ① 板块指数周/月/年**有数据** | 临时 `DSH_HOME` 写一份 `90.BK0475_101_0.json`（12 个交易日，v3 真实 schema）+ 上游全 stub ⇒ `klt=102/103/104` 三档都出数据、`aggregated.period` 分别为 week/month/year、口径含「由日线聚合」、`stale=true`；**零** `fqkline` 请求；周K 末根 `date=2026-10-19 / open=1085 / close=1125` | 旧路径（只有原生）⇒ 同条件 `null` ⇒ 「周/月/年有数据」必败 |
| ①b 没有日线 ⇒ 保持未取到 + 原因准确 | `90.BK9999`（无缓存）⇒ `kline=null`；理由含「板块指数没有可用的日线源」「腾讯 K 线不覆盖板块码」「聚合不出周/月/年」，**不含**「熔断冷却」，且**不**说「重试无用」 | 旧文案「（主机熔断冷却中（未发出上游请求））」⇒ 否定断言必败 |
| ② 聚合 OHLC 正确 | 5 个交易日跨周：两桶 `[2026-10-15 (2 日), 2026-10-19 (3 日)]`，O/H/L/C 分别 `100/108/96/101`、`101/113/97/99`，量 `30/120`，`pct` 相对上一根聚合收盘 | 首末取反（末根当开盘、首根当收盘）⇒ O/C 断言必败 |
| ③ 桶内任一 vol/amount 缺失 ⇒ 该桶 null | 量缺 1 日 ⇒ `vol=null`；额缺 1 日 ⇒ `amount=null`；`sessions` 仍为 4；干净桶照常 `15 / 1500` | `?? 0` 相加 ⇒ 会写出"成交量 0"的假桶 ⇒ 与 null 比对必败 |
| ④ 口径句一处可见 | `aggCaliberOf` 含「由日线聚合（非上游原生…）」「本地缓存 800 根」「截至 10-22 15:05」，单行无 `\n`；客户端 `k.aggregated.note` 只出现 **1** 次、`${aggNote}` 只拼 **1** 处、客户端**不**自己写「由日线聚合」 | 删掉来源标注 ⇒ 「必须写明」必败；客户端再写一处（第二条文案/浮层）⇒ 计数必败 |
| ⑤ 聚合闸门 | 原生 >0 ⇒ 不聚合；日线 <10 根 ⇒ 不聚合；`klt=101` ⇒ 不聚合 | —（三向真值表，见测试） |

---

## C. 「同一句原因渲染两遍」的修复

`QuoteDrawer` 的 unavailable 分支原本同时渲染：

1. 带底色的 `tw-hint` 块：`${m.what}不可用（…）：${m.note}`；
2. 一行纯文本：`payload.missing[0]?.note`。

现在原因只有**一处来源**（新纯函数 `chartCache.unavailableBlockOf(missing)` → `{headline, reason, whyLabel}`），
纯文本那行已删除；同一句 `note` 在整块里出现 **1** 次（`aria-label` 复用同一句，不是第二行文字）。

- 断言：`countOf(block.reason, note) === 1`、整块"可见两行"、源码扫描 `}, block.reason)` 1 次
  / `missing[0]?.note` 0 次 / `m.note` 0 次。
- 注入：恢复第二处（`[block.reason, missing[0].note]`）⇒ 计数变 2 ⇒ 必败。

---

## D. 门禁与纪律

- `node --test "src/**/*.test.ts"`：**Asia/Shanghai 1091/1091**、**TZ=UTC 1091/1091**（两轮全绿）。
- `node build.mjs`：`built lib/index.js + lib/client.js（v0.128.0，客户端片段校验通过：73 项）`。
- `node src/host/selftest.ts`：`ALL HOST CHECKS PASSED (live probes soft)`。
  ⚠ 如实说明：selftest 是既有 gate，它会**真实取数并落盘**到 `~/.dsh`（本轮跑它时刷新了
  `klines/1.000001_101_0.json`、`klines/1.600519_102_1.json` 等缓存文件）；除此之外我没有手工写过 `~/.dsh`。
- 本轮真实网络请求：腾讯三台主机（探针 + 上述实测算子，约 20 条）+ 一次本地只读
  `GET /tradewatcher/health`（看运行中宿主的上游健康，零上游）；**东财 `push2*` 一条没发**
  （实测脚本与断言里凡是碰东财的地方都用了 `globalThis.fetch` stub）。

## E. 未做项（如实列出）

| 项 | 为什么没做 |
|---|---|
| 板块指数的**原生**周/月/年 | 三条链路都不可得（§1）。要做只能接新源或改 `push2*` 纪律，均超出本轮授权 |
| 分时链（`fetchTencentMinutes`）的同源回退 | 同一台主机、同一种 501 风险，但它是**分时**不是 K 线；`impl80`/`rescuePiggyback` 等多处断言依赖分时的**请求条数**，本轮不扩面 |
| `rescue.ts::fetchAvgAmount20` 里的 `fqkline`（20 日均额） | 该文件正被并行批改动（工作区里已有未提交修改 + `.bak`）；它本身"东财优先、腾讯兜底"，留待下一轮按同一 helper 收口 |
| 年K 的 103→104 重采样与聚合的关系 | 有月K 原生数据时仍走既有 `resampleYearly`（未改口径）；只有月K 也没有时才由日线聚合年K。两套口径的**一致性**没有逐根对比断言 |
| 美股从"本地日线缓存"聚合 | 美股已有新浪日线 → 聚合的既有路径；这条缓存兜底对本轮目标（板块/指数）没有增量，未启用 |
| 聚合结果的落盘 | 有意不落盘：避免把派生数据混进原生缓存文件（`mergeBars` 会把两种口径混在一起）。代价是每次重算（≤1200 根，纯内存） |
