> **历史快照**：本文记录的是当时（见下方正文）的行数 / 测试数 / 读数，**不代表现状**；现状以 `README.md` 与代码为准。

# AUDIT-IMPL67 —— 美股（含 ETF / 波动率期货类）行情兜底：接上腾讯 `us*` 与新浪 `gb_*`（实现报告）

- 基线：`main` @ `3a5bbcd`（v0.101.0）。本轮 **741 → 751 用例**（新增 `src/host/usQuote.test.ts` 的 10 例），
  `npm test` 两轮（默认时区 + `TZ=UTC`）全绿，`npm run check` 全绿，构建 **73 项片段校验通过**。
- 上游实测报告（数据源探测、字段下标、robots 预检、新源候选）在 `docs/PROBE-US-QUOTES.md`；本文只记**实现**与**验证**。
- 用户口径：自选里 `106.FRO`（Frontline plc，NYSE）与 `107.VIXY`（恐慌指数期货短期合约 ETF）一直「无行情源」，
  要求「搜索新数据源以补足这类基金/期货类产品」。探测结论：**不需要新源**，缺的是映射。
- 纪律：未 `git commit` / `push`；未装 bundle、未动 profile、**未重启 `dsh web`**；`build.mjs` **零改动**；
  所有实验在 `/tmp` 隔离环境（`DSH_HOME=/tmp/usfix-*`、`/tmp/usfix-live*`）；未手工写 `~/.dsh`。

---

## 0. 结论

1. **既有两源都取得到，缺口是代码映射**：腾讯 `usFRO` / `usVIXY` 与新浪 `gb_fro` / `gb_vixy` 实测价格与涨跌幅**逐项一致**
   （52.49 / −0.10% 与 17.73 / +8.11%），成交额差 < 0.1%。此前 `tencentQuoteCode()` 不认 `105/106/107`、
   `sinaSymbol()` 是逐标静态表没有美股 ⇒ 东财一挂就必然「无行情源」。
2. **不能只加一行映射**：既有 `parseTencentQuoteText` 的下标是给 A股/港股写的，直接喂美股会
   **成交额 ×10000**、**时间戳丢失**、**ETF 市值写 0**。三处都在本轮修掉，并各自配了会红的反例。
3. **意外发现（本轮最该记住的一条）**：新浪对**不存在的美股代码**会回一行"全零空壳"——
   实测 `gb_zzzz` = `ZZZZ,1.0000,0.00,…`。若照收，界面会把「没有这只票」显示成「1.00 美元 / 0.00%」。
   已加占位行判据（`sina.ts:454`）并配断言。
4. **顺手修的真缺陷**：`selftest.ts` 的「回落落盘 LKG」用例**周末/节假日必红**（`snapshot()` 的非交易日门禁把 level 置 null，
   而用例吃真实日期）⇒ 改成 stub 时钟固定在交易日，**断言不放宽**，另加"周末必须无等级"的反例。
5. **合规口径**：报价链不接入 `robotsGate` 这件事，从"没人想起来接"升级为**显式豁免**（`docs/DECISIONS.md`），
   并配了双向会红的判据（接入面必须恰好是宏观链）。

---

## 1. 改动清单（六项，按 Lead 指定顺序）

### ① `src/host/tencent.ts:78-105` —— 新增 `tencentUsStockQuoteCode()`，接到 `tencentQuoteCode`

```ts
export function tencentUsStockQuoteCode(secid: string): string | null { … }   // :91
export function tencentQuoteCode(secid: string): string | null {              // :103
  return tencentCode(secid) ?? tencentIndexCode(secid) ?? tencentUsStockQuoteCode(secid)
}
```

- 只认 `105/106/107`，ticker 形状 `^[A-Z][A-Z0-9.]{0,11}$`（字母起头、允许 `BRK.B` 这类点号），**其余一律 null**。
- **`tencentCode`（`:34`）一行没动**：它还喂给五日分时（`mkline`）与日线（`fqkline`），
  而腾讯对美股日线只回 1 根（`tencent.ts:149-152` 记录）⇒ 并进去等于给日线路径凭空加一条注定失败的请求。
  断言 `tencentCode('106.FRO') === null` 把这条护栏钉住。

### ② `src/host/tencent.ts:290-297` —— 成交额量纲按市场分流

```ts
const tri = (f[35] ?? '').split('/')          // A股：f[35] = "价/量/成交额(元)"；美股：f[35] = "USD"
const amountTri = num(tri[2])
const amountF37 = numField(f[37])
const amountFallback = amountF37 === null ? null : amountF37 * (isUs ? 1 : 1e4)
```

- 实测依据：A股 `sh510300` 的 `f[35] = "4.236/37995085/16092791436"` ⇒ 成交额直接是元；
  美股 `f[37]` 已是**美元**（`usFRO` 196,988,621 ↔ 新浪 `gb_fro` 197,036,261）。
- 断言：`amount === 196988621`，且 `notEqual(amount, 196988621 * 1e4)`；另加 A股对照（`16,092,791,436` 不变）
  与"合成 A股行 `f[37]` 仍 ×1e4"两条，防止"为了美股把 A股 也改了"。

### ③ `src/host/tencent.ts:302-303` —— 空串不许变 0

```ts
totalMv: numField(f[45]) !== null && (numField(f[45]) as number) > 0 ? … * 1e8 : null,
floatMv: numField(f[44]) !== null && (numField(f[44]) as number) > 0 ? … * 1e8 : null,
```

- 根因：`Number('') === 0` ⇒ 老实现在美股 ETF（`f44/f45` 为空串）上写 `totalMv: 0`。
  新增 `numField`（`tencent.ts:133`）把**空串**当"上游没有这个字段"。
- 断言：`107.VIXY` 的 `totalMv === null` 且 `notEqual(totalMv, 0)`；`105.SPY` 同理；
  同时 `106.FRO` 的 `totalMv === 11685475000`（有值不许被误伤）。

### ④ `src/host/tencent.ts:135-195` —— 美股时间戳按**美东**解析，且与宿主时区无关

```ts
export function parseTencentUsStamp(text: string | undefined): number | null { … }   // :181
```

- 做法：正则取墙上时间 → 先假设是 UTC → 用 `Intl.DateTimeFormat({ timeZone: 'America/New_York' })` 反解出
  "它在纽约的墙上时间" → 迭代纠正（DST 由 `Intl` 判定）→ 最后**校验反解收敛**（落不回目标墙上时间就给 null）。
  全程不出现 `Date.parse('YYYY-MM-DDTHH:mm:ss')` 这类**依赖宿主时区**的写法。
- ⚠ 明确**没有**给 `parseTencentStamp` 加 `-` 分支：那会把美东当东八区，差 12–13 小时。
  `parseTencentStamp('2026-10-16 16:00:01')` 仍返回 `null`（断言钉住）。
- 断言：`'2026-10-16 16:04:53' → 1792181093000`；判别性输入 `16:00:01 → Date.UTC(...,20,0,1)`，
  并 `notEqual` 到 08:00Z（当东八区）与 16:00Z（当 UTC）；DST 两端各一条（1 月 EST ⇒ 21:00Z、7 月 EDT ⇒ 16:00Z）。

### ⑤ `src/host/sina.ts` + `src/host/em.ts` —— 第二兜底 `gb_*`（规则，不是静态表）

| 位置 | 改动 |
|---|---|
| `sina.ts:88` | 新增 `sinaUsSymbolOf()`：`105/106/107` → `gb_<ticker 小写>`（**规则**；静态表 `SINA_SYMBOL` 仍是期货/商品的逐标登记） |
| `sina.ts:99` | `sinaSymbolOf()` 改为 `静态表 ?? sinaUsSymbolOf()` |
| `sina.ts:423` | 抽出 `gbRowOf(parts)`：`parseSinaGb`（既有，globalFlow 的规模原语在用）与 `parseSinaHq` 的 `gb_` 分支**共用同一份下标表** |
| `sina.ts:326-337` | `SinaGbQuote` 扩字段：`prev/open/high/low/vol/amount/tradeTime`（原 `name/price/pct/totalMv/shares/time` 语义不变，向后兼容） |
| `sina.ts:158-204` | `parseSinaHq` 新增 `gb_` 分支：`pct` 直接取新浪自带字段（**不用** ±25% 的"昨收可疑"闸门——那是给商品设的）；`vol/amount/totalMv/shares/time` 一并带回 |
| `em.ts:744-780` | 兜底链的新浪那一档：把 `vol/amount/time/totalMv` 从"一律 null"改为按 `SinaHqQuote` 填充（`floatMv` 仍 null——新浪没这个字段） |

- 成交时刻取新浪自己给的**美东**时间（下标 24 最新一笔 → 回退 25 常规收盘），
  并用 `EDT/EST` 换算；解析不出就 `null`，**不拿下发时刻（下标 3，北京时间的快照时刻）冒充成交时刻**。
- 断言：`sinaSymbol('106.FRO') === 'gb_fro'`；`parseSinaHq` 出 11 个字段且 `price × shares == totalMv`；
  与腾讯的价/涨跌幅**完全相等**、成交额差 < 0.5%；`parseSinaGb` 老字段（`time` 文本、`totalMv`）语义不变。

### ⑥ 文案与注释 —— 缺失原因如实、过时注释改掉

- `em.ts:409-433` 的三分支本来就覆盖了"有兜底但两源都没给价" ⇒ 美股接线后**自动**落到「东财**与备用源**本次都未给出可用价格」，
  无需改代码；新增断言 ⑧ 把这句话钉住（并断言**不再**出现"没有腾讯/新浪备用源映射"）。
- 实测该文案：`{"what":"105.ZZZZ","why":"transient","note":"东财与备用源本次都未给出可用价格（限流或超时）—— 稍后自动重试"}`。
- 过时注释已改：`em.ts:663-671`（"仅覆盖沪/深/港股；美股…无法映射"）、`em.ts:717-728`（兜底链说明）、
  `tencent.ts:1-30`（腾讯覆盖面）、`sina.ts:1-25`（`gb_*` 也算新浪的兜底之一）。
- `hasQuoteFallback`（`em.ts:1505`）注释同步；它的判定**自动**变成 `true`（因为两侧映射都在）。

### ⑦ 顺手修：`src/host/selftest.ts:360-400` —— 周末必红的用例

- 现象：`npm run check` 唯一红灯 `FAIL 本会话无数据 → 回落落盘 LKG（etfs 1，stale true）`（2026-10-17 周六实测）。
- 根因：`RescueMonitor.snapshot()` 的非交易日门禁（`rescue.ts:2333-2352`）在周末把 `level` 置 `null`，
  而用例断言的是"回落的上次成功快照 `level = 2`"，且**吃真实日期**。
- 修法（按 Lead 口径）：**stub 时钟固定到交易日** `2026-10-19（周一）10:00 北京`，`try/finally` 还原；
  **断言不放宽**；再补一条反例：同一份快照把时钟挪到周六 ⇒ `level` 必须为 `null` 且 `nonTrading.reason === 'weekend'`
  （证明周末门禁还在、上一条不是恒真）。因为 `weekdayOf` 固定按 `Asia/Shanghai` 算，该用例现在与**宿主时区、真实日期**都无关。

---

## 2. 三标的实网实测（修后的代码路径，`/tmp/usfix-live`）

请求计数：本轮 live 证据共 `qt.gtimg.cn` 3 次、`hq.sinajs.cn` 2 次、东财 `push2*` 失败若干（既有链路）；
`robots.txt` 预检每主机 1 次；**`Disallow: /` 的路径零请求**。

### 2.1 完整 `/quotes` 链路（东财 → 腾讯 → 新浪）

```text
106.FRO  source=tencent  price=52.49  pct=-0.10  vol=3,722,974  amount=196,988,621
         totalMv=11,685,475,000  floatMv=7,515,370,000  time=2026-10-16T20:04:53Z（4:04:53 PM ET）
107.VIXY source=tencent  price=17.73  pct=+8.11   vol=15,329,796 amount=270,828,663
         totalMv=null  floatMv=null  time=2026-10-16T20:00:01Z（4:00:01 PM ET）   ← ETF 市值如实 null
105.AAPL source=tencent  price=343.46 pct=+0.43   vol=59,946,368 amount=20,621,913,459
         totalMv=5,012,517,063,000  floatMv=5,009,401,495,000  time=2026-10-16T20:00:02Z
missing = []            sources = {"tencent":3}
```

### 2.2 腾讯与新浪**同刻一致**（各自单源 live 取数）

| 标的 | 腾讯价 / 涨跌 | 新浪价 / 涨跌 | 成交额差 | 市值 |
|---|---|---|---|---|
| `106.FRO` | 52.49 / −0.10% | 52.49 / −0.10% | 0.024% | 腾讯 11,685,475,000 / 新浪 11,685,475,706 |
| `107.VIXY` | 17.73 / +8.11% | 17.73 / +8.11% | 0.075% | 腾讯 **null** / 新浪 240,529,647 |
| `105.AAPL` | 343.46 / +0.43% | 343.46 / +0.43% | 0.037% | 腾讯 5.0125e12 / 新浪 5.0125e12 |

- 两源**时间戳语义不同**（已如实记录）：腾讯 `f[30]` = 美东 16:00/16:04（收盘后首笔），
  新浪下标 24 = 美东 19:57/19:59（盘后最新）。故断言只比价/涨跌幅/成交额量级，**不比时间戳**。
- `hasQuoteFallback`：`106.FRO / 107.VIXY / 105.AAPL` 全部 `true`（此前 `false`）。

---

## 3. 断言 / 反例注入（`src/host/usQuote.test.ts`，10 例）

| # | 断言 | 反例（照错的做法实现就红） |
|---|---|---|
| ① | `tencentQuoteCode('106.FRO') === 'usFRO'` / `107.VIXY` / `105.AAPL` / 小写亦通 | miss 五态全 null；`tencentCode('106.FRO') === null`（K 线链护栏） |
| ② | 价/昨收/涨跌/高低/量/额/市值逐项对上原回包 | `amount` 若 ×1e4 ⇒ `notEqual` 两条必红 |
| ③ | 美股 ETF `totalMv/floatMv === null` | `notEqual(totalMv, 0)` ⇒ 空串写 0 必红 |
| ③b | A股 `f[35]` 三连的成交额原样（16,092,791,436）；合成 A股 `f[37]` 仍 ×1e4 | `notEqual(12345*1e4, 12345)` ⇒ 把 A股也改掉必红 |
| ④ | 美东→UTC：`16:04:53 → 1792181093000`；DST 两端各一条 | `notEqual` 到 08:00Z（东八区口径）与 16:00Z（UTC 口径） |
| ⑤ | 未知 ticker 不回行（腾讯）；**新浪占位行必须丢弃** | 真实抓包 `gb_zzzz`（price 1.0000、其余全 0）⇒ `deepEqual({}, …)`；停牌股（有昨收）不得误杀 |
| ⑥ | `sinaSymbol` 规则命中 + 11 字段 + `price×shares==totalMv` + 与腾讯价/涨跌**完全相等** | `sinaSymbol('999.FRO') === null`、`100.SPX === null`（国际指数仍不走 int_*） |
| ⑦ | 端到端：腾讯不回行 ⇒ 新浪补齐，`vol/amount/time/totalMv` 不再是 null | 缺任一项即红；`missing === []` |
| ⑧ | 有兜底但两源都没价 ⇒ 文案点明「东财与备用源」+ `transient` | `includes('没有腾讯/新浪备用源映射') === false` |
| ⑨ | `robotsGate` 接入面**恰好** `['host/globalFlow.ts']` | 往报价链加 import ⇒ 判据变长必红；删掉宏观链 ⇒ 变空必红 |

另：`selftest.ts` 的 LKG 用例新增"周末 ⇒ `level === null`"反例；`p0.test.ts` 两条把"无兜底"的例子从
`107.SPY`（美股，现已**有**兜底）换成 `113.rb2610`（月度合约，`hasQuoteFallback === false`），语义不变。

---

## 4. 验证

```text
npm test          → tests 751 / pass 751 / fail 0      （默认时区）
                  → tests 751 / pass 751 / fail 0      （TZ=UTC）
npm run selftest  → ALL HOST CHECKS PASSED (live probes soft)
npm run build     → built lib/index.js + lib/client.js（v0.101.0，客户端片段校验通过：73 项）
npm run check     → EXIT=0  ×4 轮（探测期为基线 1 轮，实现后 D/E 两轮为最终树上的干净复跑）
```

### 4.1 时区双跑（Lead 指定断言：同一回包在两种宿主时区下输出相同）

```bash
TZ=UTC            node --experimental-strip-types tz.mts > out.utc.json
TZ=Asia/Shanghai  node --experimental-strip-types tz.mts > out.sh.json
diff out.utc.json out.sh.json | wc -l     # → 0
```

`out.*.json` 是**同一批真实回包**（`usFRO`/`usVIXY`/`usAAPL` + `gb_fro`）的完整解析结果（73 行），
两种时区**逐字节相同**——包括三个美股时间戳：
`2026-10-16 16:04:53 → 1792181093000`、`2026-01-15 16:00:00 → 1768510800000`（EST）、
`2026-07-01 12:00:00 → 1782921600000`（EDT）。

- `build.mjs` **零改动**；`git status` 只含本轮改动的源码/测试/文档（未 commit）。
- 与基线对比：741 → **751**（+10 新用例），`p0.test.ts` 与 `selftest.ts` 的两处旧断言按新事实更新（不是放宽）。

---

## 5. 未做 / 未确认 / 风险

| 项 | 状态 | 说明 |
|---|---|---|
| 东财对 `106.FRO` / `107.VIXY` 自身的覆盖 | **仍未确认** | 三条 `push2*` 主机 `robots.txt` 为 `Disallow: /`（按纪律零请求）；本机东财此刻整批不可用。**不影响本轮结论**：现在有腾讯/新浪两档兜底，不依赖东财 |
| 美股**盘中**（非收盘）时段 | **未测** | 当前美股休市，实测到的是收盘/盘后快照；盘中量纲（`f[6]` 是否仍为股）与 `vol` 语义未验证 |
| 美股 K 线 / 五日分时 | 未做（有意） | 腾讯美股日线只回 1 根；本轮只开行情一条链。K 线仍靠东财/新浪日线接口 |
| 新浪 `gb_*` 对**任意**美股代码的覆盖 | 部分验证 | 只实测 FRO/VIXY/SPY/AAPL/EWJ/UVXY/UNG/SLV/TLT/SQQQ；未知代码已加占位行拦截 |
| 版本号 / CHANGELOG / 发版 | 未做 | 按 `docs/DECISIONS.md` 的"发版是原子动作"，由 Lead 统一执行（本轮未 commit、未重启宿主） |
| 客户端提示文案（`src/client/ui.tsx:239`） | 未改 | 它描述的是"腾讯/新浪都没有映射"的品种；美股已有映射，文案仍成立 |

**风险/注意**：
1. `numField` 的语义是"空串 = 没有" —— 目前只用在**成交额/市值/股本**这些"空 = 不知道"的字段上，
   价格/涨跌幅仍走 `num`（0 价另按"无有效价"处理）。若以后把 `numField` 用到价格上，要重新想清楚。
2. 新浪 `gb_*` 的**成交时刻**与腾讯 `f[30]` 不是同一口径（盘后 vs 收盘后首笔），
   跨源比较时间戳会得出"差 4 小时"的假结论 —— 已在断言里明确不比时间戳。
3. 兜底链的顺序仍是**腾讯优先**：腾讯行情主机（`qt.gtimg.cn`）整体挂掉时美股才轮到新浪；两条都挂才吃 LKG。
