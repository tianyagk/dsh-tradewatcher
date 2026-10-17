# REVIEW-7-HOST —— 宿主数据层对抗式评审（真缺陷 + 低效率）

**评审对象**：`/home/hu/workspace/Servers/dsh/Dev/dsh-tradewatcher`，`main` @ `8b06d5d`（v0.104.0）。
**范围**：`src/host/**`（`em / tencent / sina / routes / chips / klineUnits / usAggregate / rescue / globalFlow / marketExtras / breaker / breakerFetch / store / readGuard / lock / degrade / time / robotsGate`）。
**只读声明**：未改工作区任何源码、未 commit、未装 bundle、未动 profile、**未重启 `dsh web`**、**未在工作区跑 `npm run build`**。所有注入与探针都在 `/tmp` 副本里做（`/tmp/rv-host` `/tmp/rv-inj` `/tmp/rv-ctl`，`node_modules` 只读软链；`DSH_HOME=/tmp/rv-home-*` 隔离）。真实数据目录 `~/.dsh/dsh-tradewatcher` 只读。
本文件是本次唯一的写入面（`docs/REVIEW-7-HOST.md`）。

**评审姿态**：目标是**推翻"它是对的"**——优先找能产出「**看着正常的错数**」或「红线声明与实际不符」的地方；找不到就如实记「查过、无发现」（§7），不凑数、不编造。每条结论标注 **✅ 实测证实 / ◐ 推断（有代码与局部证据） / ○ 未确认**。

---

## 基线复现（我自己在干净副本里跑的，不是照抄仓库说法）

```
$ cd /tmp/rv-host && DSH_HOME=/tmp/rv-home-a TZ=Asia/Shanghai node --test --experimental-strip-types "src/**/*.test.ts"
ℹ tests 775 / pass 775 / fail 0
$ cd /tmp/rv-host && DSH_HOME=/tmp/rv-home-b TZ=UTC          node --test --experimental-strip-types "src/**/*.test.ts"
ℹ tests 775 / pass 775 / fail 0
$ cd /tmp/rv-host && node build.mjs
built lib/index.js + lib/client.js （v0.104.0，客户端片段校验通过：73 项）
```
⇒ **775 × 2 时区 + 构建 73 项全绿属实**。
⇒ **但这 775 条没有一条锁住下面 D1–D5 中任何一条**（见 §6 的注入矩阵：我把四条"建议修法"逐字注入实现，775 条**依旧全绿**）。

---

## 结论先行

| # | 结论 | 分类 | 严重度 | 证据强度 |
|---|---|---|---|---|
| **D1** | 量纲护栏的「同日」前提是**恒真式**，且 20–100 倍区间**无条件 ÷100** ⇒ 筹码换手率被整体缩小 100 倍 | 正确性（看着正常的错数） | **高** | ✅ |
| **D2** | 美股日线解析把「缺失/空串/`0`」的成交量写成 **0** ⇒ `aggregateUsDaily` 的「任一日缺失即 null」契约从源头失效 | 正确性（0 顶替） | **中高** | ✅ |
| **D3** | 宏观链路有**第二扇门**：`marketExtras.ts` 的宏观取数全部裸 `fetch`，而 robotsGate 的「接入面」断言只看 `import` 句子 ⇒ 断言恒绿 | 红线 / 断言强度 | **中** | ✅ |
| **D4** | `marketExtras.ts` 两处 **0 顶替**（空串 ⇒ 0）：两融读成「0 亿元」、美债 10Y 历史出现 0 | 正确性（0 顶替） | **中** | ✅ |
| **D5** | 文件锁把**活着的持有者**判「心跳断供」并回收 ⇒ 两个写者可能同时进临界区（丢更新） | 健壮性 / 一致性 | **中** | ✅（构造可复现） |
| **D6** | `suggest:${q}` 进的是**永不淘汰**的 `ttlCache` ⇒ 用户搜索词无限累积（进程内状态泄漏） | 健壮性 / 低效率 | **中** | ✅ |
| **D7** | `resampleYearly` 把缺失月量按 **0** 相加（A股年K） | 正确性（潜在） | 中低 | ✅ |
| **D8** | `chips` 的 `lastBar.vol ?? 0`：缺失被编码 0，类型又把 0 写死成合法值 | 正确性（尾部） | 低 | ✅ |
| **D9** | 美股周/月/年：每次刷新**全历史重聚合**；且「有拆股标记」使落盘条件**恒真**（180 KB / 120 s 写放大） | 低效率 / 写放大 | 低 | ✅ |
| **D10** | `quoteSlots` 的注释说「重新 set 会回到队尾」，`Map.set` 对已有键**不改变插入序** ⇒ 淘汰不是 LRU | 低效率（注释与实现不符） | 低 | ✅ |
| **D11** | `fetchSinaQuotes` 的 `if (!res.ok) throw` 是**死代码**（`withHostBreaker` 已对非 2xx 抛错并记账） | 低效率 / 可读性 | 低 | ✅ |
| **D12** | `chips.ts` 头注释写「桶数 32」，常量是 **96** | 文档纪律 | 低 | ✅ |

**最该先修的 3 条**（按「会让人做错决定 / 会永久错数」排序）：
1. **D1**（`src/host/routes.ts:402-407` + `src/host/klineUnits.ts:208-229`）——唯一一条会**每天重复**地把筹码数字整体改小 100 倍的路径，且改完还宣称号称「已归一为手」。
2. **D2**（`src/host/sina.ts:363`）——一行改成 `numField`，同时把美股整条 K 线链的 null 语义恢复；相邻两行的 `amount` 已经是正确写法。
3. **D3/D4**（`src/host/marketExtras.ts:205-211/227-229/382` + `src/host/usQuote.test.ts:248-265`）——0 顶替 + 门禁断言的判据要换（从 `import` 句子换成取数点）。

---

## 一、缺陷逐条

### D1【高·✅】量纲护栏：前提恒真 + 20–100 倍区间无条件 ÷100 ⇒ 筹码换手率整体缩小 100 倍

**位置**
- 调用点：`src/host/routes.ts:402-407`
- 被判定的函数：`src/host/klineUnits.ts:208-229`（`alignVolUnitWithQuote`；`band` 在 `:213`，`findIndex` 在 `:215`，判据与倍数在 `:217-219`）

**两个独立缺陷叠在一条链上**

① **「同日」这个前提永远不会失败（恒真式）。**
```ts
// routes.ts:388, 402-407
const lastFq1 = k?.days?.[k.days.length - 1] ?? null
const unitRef = quote !== null && lastFq1 !== null && typeof quote.vol === 'number' && quote.vol > 0
  ? { date: lastFq1.date, vol: quote.vol }      // ← 日期取自**日线自己**，量取自**报价**
  : null
const unitGuard = ... alignVolUnitWithQuote(bars, unitRef)
```
`alignVolUnitWithQuote` 的文档写着「参照日（**与日线最后一根同一天才有意义**）」，实现里靠 `bars.findIndex(b => b.date === ref.date)` 来兑现这条前提；而调用方把 `date` 填成 `lastFq1.date`（就是日线最后一根自己的日期）⇒ **这个 findIndex 必然命中最后一根**，检查退化成恒真式。报价的成交量到底属于哪一天，**代码从未检查**（`QuoteRow.time` 是有的，能用）。

② **比值落在 (20, 100) 时无条件 ÷100。**
```ts
// klineUnits.ts:213-225
const band = opts.band ?? 20
if (ratio <= band && ratio >= 1 / band) return {...no-op...}
const factor = ratio > 1 ? 1 / VOL_UNIT_FACTOR : VOL_UNIT_FACTOR   // 恒为 1/100 或 100
```
`findVolUnitBreak` 那边还要求「倍数落在 30–300 之外的一律不动」并同时要求单步与水平**同向**；这道读侧闸门却只要「不是 20–1/20」就乘除 100。

**复现（`/tmp/rv-host/work/probe-align.ts`）**
```
--- 场景 A：日线最后一根 = 今天，报价 = 今天的量（正常，ratio≈1）---
fixed= false reason= null

--- 场景 B：日线缓存是**昨天**的（回源失败 ⇒ stale），报价是**今天开盘 5 分钟**的量 ---
fixed= true
reason= 2026-08-29 的日线成交量 2000000 与同日报价 33333（手）相差 60.0× ⇒ 判定这段日线的量纲不是「手」⇒ 全段按 ×0.01 归一到「手」（只改 vol，价格与日期未动）
归一后最后一根 vol = 20000 （真值应为 2000000 ）

--- 场景 C：同一份数据，量纲护栏触发前后的筹码数字 ---
护栏触发前: {"avgCost":9.9511,"support":9.005,"resistance":10.9786,"profitRatio":100,"decay":"turnover","decayReason":null}
护栏触发后: {"avgCost":10.0675,"support":9.0083,"resistance":10.9809,"profitRatio":100,"decay":"turnover","decayReason":null}
```
注意 reason 文本**自己写着「相差 60.0×」，然后按 ×0.01 处理** —— 归一到手之后 `bars/quote` 变成 0.6，离「手」更远了（正确结论应是「判不了，不动」）。

**为什么这不是纸面问题**：`fetchKline` 在上游失败时会**返回旧 bar 并 `stale: true`**（`em.ts:2656` 只在 `bars.length === 0` 时返回 null），而东财限流是本仓库反复记录的现实。此时日线最后一根是**昨天**、报价是**今天开盘几分钟**的量 —— 二者本来就不该比。`quote.vol > 0` 只能挡住停牌/未开盘。

**影响**：筹码的 `t_i = vol×100×close ÷ floatMv` 小 100 倍 ⇒ 衰减几乎归零 ⇒ `avgCost / P5 / P95 / 窄区间判定` 全部变样；`decayReason` 仍是 `null`（口径行看不出任何异常），只有 `missing[]` 里多一条自相矛盾的「量纲」说明。

**建议修法（任一即可打断链条）**
1. `unitRef.date` 必须来自**报价自己的交易日**（`quote.time` → 该市场的日历日），与日线最后一根不一致 ⇒ `unitRef = null`（不做）。
2. `alignVolUnitWithQuote` 的判据改成「只有真的 ≈100 倍才动手」：`Math.abs(Math.log10(ratio / 100)) > 0.1` ⇒ 返回 no-op + 一句「判不了，未改动」，与 `findVolUnitBreak` 的 30–300 纪律对齐。

**优先级**：P0（唯一一条会**每日重复**地把可见数字整体改小 100 倍、且事后文本自相矛盾的路径）。

---

### D2【中高·✅】美股日线：缺失/空串/`0` 的成交量被写成 0 ⇒ 聚合契约从源头失效

**位置**：`src/host/sina.ts:363`（`vol: num(it.v) ?? 0`），紧邻 `:364-365` 的 `amount` 反例。

```ts
// sina.ts:355-366
const amount = numField(it.a)
out.push({
  ...
  vol: num(it.v) ?? 0,
  // 早期 bar 上游给 "0" ⇒ 按"没有"处理（缺失不许编码成 0）
  amount: amount !== null && amount > 0 ? amount : null,   // ← 同一行诗里两种命运
})
```
`num('')` = `Number('')` = **0**（不是 null），`num('0')` = 0。所以「空串 / `0`」两条路都落到 `vol: 0`。而 `SinaBar.vol` 的类型被写死成 `number`（`sina.ts:322-331`），于是 `em.ts:2525` 的 `vol: b.vol` 永远是数字 ⇒ `aggregateUsDaily` 的 `volMissing` 分支**在真实链路上不可达**。

**复现（`/tmp/rv-host/work/probe-units.ts` P1/P2）**
```
=== P1 parseSinaUsDaily: v 缺失/空串 是否变成 0 ===
[ { date: '2026-10-14', vol: 0, amount: null },
  { date: '2026-10-15', vol: 0, amount: null },
  { date: '2026-10-16', vol: 12345, amount: 130000 } ]
聚合成周（若契约成立，vol 应为 null）: [ { date: '2026-10-14', vol: 12345, amount: null, sessions: 3 } ]

=== P2 aggregateUsDaily 直接吃 null vol（契约自身的表现）===
[ { vol: null } ]
```
⇒ 函数本身是对的（P2），**上游把 null 提前抹掉了**（P1）：一周 3 个交易日被报成「量能 12345，sessions 3」，其中两天按 0 计入。

**与文档直接冲突**：`usAggregate.ts:13` 写着「某一根日线的 `vol`/`amount` 缺失 ⇒ 该聚合根的对应字段记 **null**」。`amount` 那半条在真实缓存里**确实生效**（`106.FRO_102_0.json` 首根 `amount: null`），`vol` 这半条永远不生效。

**影响**：美股周/月/年 K 的量能静默偏小（偏多少取决于上游给多少空 `v`）。US 的筹码与位置计算在 v0.103 已拒绝（`fqSupported=false`），所以影响面限定在「量能显示 / 聚合根的 sessions 语义」——但它是**红线级规则**（缺数据不得 0 顶替）在最新模块里的唯一破口。

**建议修法**：`:363` 改 `vol: numField(it.v)`（`numField` 就在同文件 `:53`），并把 `SinaBar.vol` 放宽成 `number | null`。`DayBar.vol` 本来就可空，聚合与下游都不用改。

**为什么 775 条没抓住**：`grep parseSinaUsDaily src/host/*.test.ts` **零命中**——美股日线/分钟解析器**没有任何单测**；`usAggregate.test.ts:105` 只能**手工构造** `vol: null` 来验证契约（真实链路造不出来）。注入验证见 §6-I1。

**优先级**：P0（一行，且同文件已有正确的 `numField`）。

---

### D3【中·✅】红线断言的判据太弱：宏观链路有第二扇门，断言恒绿

**声明**（`robotsGate.ts:151-159`）：宏观链路「四条全走它……缺一条就等于门禁没覆盖」。
**断言**（`src/host/usQuote.test.ts:248-265`）：扫 `src/**`，要求 `from '.../robotsGate.ts'` 的文件集合**恰好**是 `['host/globalFlow.ts']`，并做了双向反例注入。

**问题**：这条断言证明的是「**谁 import 了 robotsGate**」，不是「宏观取数点都经过了门禁」。事实上 `src/host/marketExtras.ts` 里有 6 个宏观主机、**全部裸 `fetch`**：

**复现（`/tmp/rv-host/work/probe-extras.ts` C，按「取数点」而不是 import 句子统计）**
```
=== C：宏观链路的 robotsGate 接入面（按"实际取数点"而不是 import 句子统计）===
  host/globalFlow.ts:    出现宏观主机 hq.sinajs.cn,home.treasury.gov,data-api.ecb.europa.eu,push2delay.eastmoney.com | 调用 gatedFetch = true
  host/marketExtras.ts:  出现宏观主机 push2ex.eastmoney.com,hq.sinajs.cn,www.szse.cn,datacenter-web.eastmoney.com,push2delay.eastmoney.com,push2his.eastmoney.com | 调用 gatedFetch = false
  host/calendar.ts:      ... datacenter-web.eastmoney.com | gatedFetch = false
  host/em.ts:            ... push2delay/push2his（行情主机，属报价链，按红线**不该**接） | gatedFetch = false
```
逐点对照（`marketExtras.ts`）：
| 行 | 上游 | 与 globalFlow 的 gated 调用是否同一路径 |
|---|---|---|
| `:349` | `push2delay.eastmoney.com/api/qt/ulist.np/get?secids=171.US10Y` | **同一 path**（globalFlow `:1459` 走 `gatedFetch`，参数几乎相同） |
| `:376` | `push2his.eastmoney.com/api/qt/stock/kline/get?secid=171.US10Y` | 美债 10Y **历史**（宏观） |
| `:328` | `push2delay...secids=100.UDI` | 美元指数（globalFlow `:1459` 同一组 secid） |
| `:217` | `www.szse.cn/api/report/...` | 两融（宏观统计） |
| `:238` | `datacenter-web.eastmoney.com/api/data/v1/get?...RPTA_RZRQ_LSHJ` | 两融（宏观统计） |
| `:82`（`sinaRaw`）+ `:357` / `:315` | `hq.sinajs.cn/list=globalbd_us10yt` / `list=DINIW` | 与 globalFlow `:1343` 的 `gatedFetch` **同一主机、同一 symbol** |

**可达性（诚实标注）**：`marginCross`（`:259`）经 `routes.ts:683` 的 `/tradewatcher/market-extras` **线上可达**；`usdIndexCross / us10yCross / us10yHistory` 目前**只被测试调用**（`grep` 全仓无路由/工具消费者），属「代码存在但线上不可达」。

**影响**：`robots.txt` 若 `Disallow /api/qt/ulist.np/`，globalFlow 按规矩停手、marketExtras 照发；5 次/小时预算也管不到它。这是**对外合规**问题，不是数值问题，但它让仓库反复宣称的「门禁已覆盖宏观链路」变成一句**看不到的假话**——正是本仓库最在意的那类缺陷。

**建议修法**
1. 把断言从「import 句子」升级成「**取数点**」：扫描宏观主机 `URL` 字面量，要求其调用形态是 `gatedFetch(`（或显式登记豁免清单并写明理由）。
2. `marketExtras` 里的宏观取数改走 `gatedFetch`（`HostBudget` 已有，成本极低）；或把「两融/涨停池」明确划出「宏观圈」并写进 `docs/DECISIONS.md`，同时把 `robotsGate` 文档里「四条全走它」改成与事实一致的措辞。

**优先级**：P1。

---

### D4【中·✅】`marketExtras.ts` 两处 0 顶替

**(a) `numOf` 把空串读成 0**（`marketExtras.ts:205-211`）
```ts
function numOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, ''))     // Number('') === 0 ⇒ 不是 null
    return Number.isFinite(n) ? n : null
  }
  return null
}
```
同一仓库里已经有正确写法：`sina.ts:53` 的 `numField`（「`Number('')` = 0 ⇒ "没有"会被写成 0」）。两融经 `yi()`（`:252`）除 1e8 后落到「**融资余额 0 亿元**」。

**(b) `:382` 显式 `?? 0`**
```ts
const points = klines.map((k) => {
  const [day, v] = k.split(',')
  return { day: day ?? '', value: numOf(v) ?? 0 }     // ← 缺值 ⇒ 0.000%
}).filter((p) => p.day !== '')
```
同一文件的失败分支（`:388-391`）写着「**不用 0 顶替**」——两条路径两种标准。

**复现（探针 6 A/B，stub 上游回包）**
```
=== A：美债 10Y 历史里"缺值"的行会变成 0 ===
{"points":[{"day":"2026-10-15","value":4.121},{"day":"2026-10-16","value":0},{"day":"2026-10-17","value":0}],"source":"东财 push2his（171.US10Y）","missing":[]}

=== B：两融字段是空串时会读成 0 亿元（不是 null）===
{"marginBalance":0,"marginBuy":0,"shortBalance":0,"day":"2026-10-16","source":"东财数据中心（RPTA_RZRQ_LSHJ）"}
```
**影响**：A 是「看着正常的错数」——收益率曲线上一个真实的 0.000% 坑；B 会让 `marginCross` 拿一个编造的 0 去和另一源比，通常表现为 `mismatch: true`（**部分自证**，但 EM 那一侧的读数本身已经是假的）。

**建议修法**：`numOf` 空串/纯空白 ⇒ `null`（对齐 `numField`）；`:382` 过滤掉不可用点并把条数写进 `missing[]`。

**优先级**：P1。

---

### D5【中·✅】文件锁把「活着的持有者」判陈旧并回收 ⇒ 两个写者可能同时进临界区

**位置**：`src/host/lock.ts:214-227`
```ts
export function staleReason(snap: LockSnapshot, staleMs: number): string | null {
  const pid = snap.holder?.pid ?? null
  if (snap.ageMs > staleMs) {                 // ← 只看 mtime 年龄
    return `锁文件年龄 …ms > staleMs …ms（心跳断供）；持有者 pid=…（**仍在运行**，但心跳已断供）`
  }
  if (snap.holder !== null && snap.pidAlive === false && snap.ageMs > DEAD_HOLDER_GRACE_MS) { … }
  return null
}
```
心跳间隔是 `max(200, staleMs/3)`（约 3.3 s），`staleMs` 默认 10 s。**只要持锁进程的事件循环被阻塞 >10 s，另一个进程就会 `rename` 走这把锁并创建自己的** —— 而原持有者仍在临界区里、仍会把自己的结果写回去。`releaseLock` 有 token 校验（不会误删别人的锁），但**写回本身没有 fencing**，丢更新照样发生。

**复现（`/tmp/rv-host/work/probe-lock.ts`）**
```
锁持有者 pid = 1425100 （= 本进程 1425100 ，pidAlive = true ）
staleReason = 锁文件年龄 60006ms > staleMs 10000ms（心跳断供）；持有者 pid=1425100（仍在运行，但心跳已断供）
⇒ 结论：pidAlive=true 仍被判可回收（判据只看 mtime 年龄）
```
（同脚本还跑了子进程持锁 + `Atomics.wait` 阻塞事件循环 2 s 的完整场景，锁文件被正常释放，未留垃圾。）

**影响**：这正是 `lock.ts` 存在的理由（文件头 §协议 与「`rescue-log.json` 两个实例互相覆盖」的事故记录）。触发条件是「>10 s 的事件循环停摆」，在 CPU 被打满 / 宿主做同步大 JSON / 调试断点 / 容器 swap 时会命中；两个 `dsh` 实例同时盯同一份 `rescue-log.json` 是本仓库明确支持过的场景。

**建议修法**：`pidAlive === true` 时**否决**回收（至少要求 `ageMs > N × staleMs` 且 `N ≥ 3`）；或引入 fencing token（锁内容里的 token 在写回前再校验一次，不匹配则拒写并如实报「锁已易主」）。

**优先级**：P1（不确定但代价是用户数据）。

---

### D6【中·✅】`suggest:${q}` 进了永不淘汰的 `ttlCache` ⇒ 用户搜索词无限累积

**位置**：`src/host/em.ts:53-68`（`ttlCache`：`cache.set(key, …)`，**全文件无任何淘汰**）+ `em.ts:3300`（`const key = \`suggest:${q}:${cap}\``，`q` 是**用户任意输入**）。

对照：同一份代码里其它进 `cache` 的键都是**有界**的（`detail:${secid}` / `kline:*` / `board:*` / `clist-pct:${p}:${z}`），而进程内其余 Map 都设了上限（`LKG_MAX=1500` `QUOTE_SLOT_MAX=1500` `TREND_LKG_MAX=400` `CLIST_PCT_FAIL_MAX=200` `klineAttempts>500 ⇒ 删最旧`）——**唯独 `cache` 没有**。

**复现（`/tmp/rv-host/work/probe-cache.ts`，stub `fetch`）**
```
不同查询 3000 条：上游被调用 3000 次；heapUsed 12MB → 26MB
再问 zzq0：新增上游调用 = 0（0 ⇒ 该槽仍在内存里，无淘汰）
再叠 3000 条：heapUsed → 40MB（Δ2 = 14MB，Δ总 = 28MB）
```
⇒ 每条唯一查询串**永久**留下约 4.7 KB（最多 100 行 suggest 的完整解析结果），10 s TTL 只影响「会不会重新请求」，不影响「会不会被释放」。

**影响**：常驻 `dsh web` 宿主的**慢速无界增长**（每键入一次搜索就多一条键），实测线性、无自愈。

**建议修法**：给 `cache` 加与其它 Map 同规格的上限（超限删最旧）；或把 suggest 结果放进独立的短 TTL 表并在 `set` 时先清过期项。

**优先级**：P2。

---

### D7【中低·✅】`resampleYearly` 把缺失月量按 0 相加（A股年K）

**位置**：`src/host/em.ts:2410`
```ts
cur.vol = (cur.vol ?? 0) + (b.vol ?? 0)     // null 被当 0
```
`aggregateUsDaily` 那半条线已经把这条规矩写进文档并加了断言（「任一日缺失 ⇒ null」`usAggregate.ts:13`、`usAggregate.test.ts:103-107`），A股这条腿仍是旧写法。

**复现（探针 1 P5）**
```
=== P5 resampleYearly：某月 vol 缺失会不会被当 0 求和 ===
[ { date: '2026-03-31', open: 10, close: 13, high: 14, low: 9, vol: 400, pct: 30 } ]
（若契约成立，年度 vol 应为 null；实际如上）      // 2 月 vol=null，年度 vol 仍给 400
```
**现状**：真实缓存里 `_102_`/`_103_` 全部 207 个文件**没有** null/0 的 vol（我扫过），所以目前是**潜在**缺陷；一旦某个上游对某月给 `0`/`—`，年K 会静默少算。

同一函数还有两个小口径问题（一并记录）：
- `cur.date = b.date` 让年K 的 `date` 变成**当年最后一个月的月末**（文档说「开盘取首月、收盘取末月」，没提 `date`），于是 `fetchKline` 的 `barOpen` 判定（`em.ts:2672-2676`）对年K **永远为 false**——一根正在走的年K 会被当成已收盘。
- 首根年K 的 `pct` 用 `bar.open` 当基数（`:2415`），即「年内涨幅」而非「同比」；没有披露。

**建议修法**：`vol`/`amount` 缺失 ⇒ 该年记 `null`；`barOpen` 对 `klt===104` 单独按年份比较。

**优先级**：P2。

---

### D8【低·✅】`chips` 的 `lastBar.vol ?? 0`

**位置**：`src/host/chips.ts:465`；类型 `chips.ts:272`（`lastBar: { …; vol: number; … }`）。
```ts
lastBar: win.length > 0 ? { date: …, close: …, vol: win[win.length-1].vol ?? 0, partial: false } : null,
```
`ChipBar.vol` 可空，缺失被编码成 0 且类型不允许「不知道」。真实缓存里存在 vol=0 的 bar（`116.00148_101.json` 3 根、`116.*` 多个港股各 3 根），若恰为最后一根，「最后一根成交量 0」会被当成事实。同文件其余字段一律用 `number | null` + 原因，这一处不一致。

**建议**：`vol: number | null`，并复用已有的 `lastBar` 说明槽。

---

### D9【低·✅】美股周/月/年：全历史重聚合 + 「有拆股标记」使落盘条件恒真

**位置**：`src/host/em.ts:2979`
```ts
if (before !== entry.bars.length || beforeLast !== afterLast || entry.splits.length > 0) void saveKlineCache(...)
```
`entry.splits` 是**历史属性**（`detectUsSplits` 对同一份日线永远返回同一批），所以只要该标的「历史上疑似拆过股」，**每次增量刷新都会重写一次缓存文件**（`saveKlineCache` → `updateJsonLocked`：锁文件 + 读 + merge + 原子写 + `pruneKlineCache()`）。

**真实证据**（只读真实数据目录）：
```
$ ls -l ~/.dsh/dsh-tradewatcher/klines/106.FRO_{101,102,103,104}_0.json
-rw-rw-r-- 1 hu hu 167290 10月 17 20:01 106.FRO_101_0.json
-rw-rw-r-- 1 hu hu 180413 10月 17 20:31 106.FRO_102_0.json
-rw-rw-r-- 1 hu hu  61749 10月 17 20:31 106.FRO_103_0.json
-rw-rw-r-- 1 hu hu   5782 10月 17 20:31 106.FRO_104_0.json
$ node -e '…读 106.FRO_102_0.json… "splits":1 条'
```
FRO 有 1 处疑似合股 ⇒ 打开美股周K 时约每 120 s（`ttlCache` incr 窗口）重写 **180 KB**，约 **5.4 MB/小时**纯写放大。

**热路径成本（`/tmp/rv-host/work/probe-perf.ts`）**
```
aggregateUsDaily(week) 10055 根 × 200 次: 1866.0ms ⇒ 单次 9.33ms, 输出 2012 根
aggregateUsDaily(month) 10055 根 …       ⇒ 单次 6.42ms
aggregateUsDaily(year)  10055 根 …       ⇒ 单次 5.59ms
mergeBars(800 根 × 2000 次)              ⇒ 单次 0.193ms
周K 800 根落盘体积 ≈ 430 KB
```
即：每次刷新都从**全历史日线**重算一遍（9.3 ms + 2012 个临时对象），只为了末尾新增的那一根。

**建议修法**：保存条件改成「拆股列表真的变了」（比 `day`+`label` 拼接串）；聚合改为「整段只在首次算，之后只算最后 2 个桶并替换」。

**优先级**：P3。

---

### D10【低·✅】`quoteSlots` 的淘汰不是 LRU（注释与实现不符）

**位置**：`src/host/em.ts:1134-1140`
```ts
quoteSlots.set(secid.toUpperCase(), { exp: at + ttl, at, row })
// Map 保持插入序：超限时从最旧的开始丢（**正被使用的槽会被重新 set 而回到队尾**）
while (quoteSlots.size > QUOTE_SLOT_MAX) quoteSlots.delete(quoteSlots.keys().next().value)
```
`Map.prototype.set` 对**已存在的键**只更新值、**不改变插入序**（ECMAScript 规范：`Map.prototype.set` 保留原条目）。所以「回到队尾」是错的：冷标的只被插入一次，反而排在后面；热标的从上架起就固定在前面 —— 1500 槽的超限场景下会先淘汰**最早上架的热标的**，下一轮再重新拉取（自愈但有抖动）。量级很小（要 1500 个不同 secid 才会触发），但注释会误导后续维护者。

**建议**：先 `delete(key)` 再 `set(key)`，或直接改成按 `at` 排序淘汰。

---

### D11【低·✅】`fetchSinaQuotes` 的 `if (!res.ok) throw` 是死代码

**位置**：`src/host/sina.ts:230-236`（同型还有 `src/host/marketExtras.ts:92`、`src/host/rescue.ts:1214`）
```ts
const res = await withHostBreaker('hq.sinajs.cn', () => fetch(...))
if (!res.ok) throw new Error(`HTTP ${res.status} from hq.sinajs.cn`)
```
`withHostBreaker`（`breakerFetch.ts:54-59`）在 `res.ok === false` 时**已经**记账并抛错 ⇒ 下一行永远到不了。好处是「5xx 确实进账」（实测需求已满足），代价是读者会以为这里有一条独立防线。

---

### D12【低·✅】`chips.ts` 头注释「桶数 32」与常量 96 不符

`chips.ts:14`「⑤ 桶数 32，收盘价落边界时按位置线性分摊」 vs `chips.ts:18` `export const CHIPS_BUCKETS = 96`。仓库对文档纪律有硬要求（`docs/FIX-4-REDUNDANCY-DOCS.md`），这属于该纪律的漏网。

---

## 二、低效率清单（按投入产出排序）

| # | 项 | 位置 | 量化 | 可做 |
|---|---|---|---|---|
| E1 | 拆股标记使落盘恒真（D9） | `em.ts:2979` | 180 KB / 120 s ≈ 5.4 MB/h（FRO 实测） | 比「标记是否变化」 |
| E2 | 美股周/月/年全历史重聚合 | `em.ts:2541-2547` | 9.3 ms + 2012 对象 / 次 | 只算尾部窗口 |
| E3 | `usDailyBars` 每次调用重建 1 万根 bar（含逐根 pct） | `em.ts:2522-2526` | 10 055 次 map/次调用 | 缓存成品 `DayBar[]` |
| E4 | `suggest:${q}` 无界缓存（D6） | `em.ts:53-68,3300` | 4.7 KB / 唯一查询，永不释放 | 加上限 |
| E5 | `klineMem` 无上限 | `em.ts:2009,2260` | 每标的最多 1200 根 bar 常驻 | 加 `KLINE_MEM_MAX` |
| E6 | `fetchProgressCurve` 每日重算，串行 6 次上游（各 15 s 超时） | `rescue.ts:1233-1279` | 最坏 90 s 后台（非阻塞，`rescue.ts:1738` 是 `void`） | 持久化曲线已存在，可隔周复用 |
| E7 | `f2Anchors` 每 tick 重建 pooled 数组 + `selfSampleDays()` 调两次 | `rescue.ts:2248-2263` | 6×120 条，量级小 | 缓存到样本变化时 |
| E8 | `fetchSinaQuotes` 每批固定 `sleep 60ms` | `sina.ts:252` | 5 批 ≈ 300 ms | 失败批次才退避 |

> 结论：**没有发现 O(n²) 或热路径上的无谓序列化**；`mergeBars`（0.19 ms）、`sortLedger`、`quantile` 都在合理量级。低效率集中在「美股聚合/落盘」与「无界缓存」两处，且两处都有真实数据或实测数值支撑。

---

## 三、红线复核

| 红线 | 结论 | 证据 |
|---|---|---|
| 缺数据不得 0 顶替 | **不完全成立**：3 处真缺口（D2 美股 `vol`、D4 两融/美债、D7 年K）+ 1 处小的（D8） | 探针 1/5/6；`106.FRO_102_0.json` 的 `amount:null` 证明正确写法确实存在于同一行诗 |
| 不得编数 | **基本成立**：`gb_*` 占位行判据（`sina.ts:532-533`）、`int_*` 整族停用、`RETIRED_INDEX_FALLBACK` 作废留痕、`sina` 兜底「不拿别处数字凑」都做到了 | 代码 + `quotes-lkg.json` 里 `purged: 0`、`source` 三类齐备 |
| 降级与边界声明必须可见 | **成立但有回退**：`missing[]`/`stale`/`staleReason`/`unitNote`/`asOf` 链路完整；**但 D1 的 `unitNote` 会给出一个自相矛盾的结论**（写着「相差 60×」却按 100× 归一），且 `decayReason` 仍为 `null`——「可见」≠「说对了」 | 探针 4 |
| `robotsGate` 只覆盖宏观/归档（**不扩到报价链**） | **成立** | `usQuote.test.ts:262` 断言 `['host/globalFlow.ts']`；我按取数点重扫，报价链（`em.ts`/`tencent.ts`/`sina.ts` 的行情口）无 `robotsGate` 引用 |
| `robotsGate` **完整覆盖**宏观/归档 | **不成立**（D3） | 探针 6C：`marketExtras.ts` 6 个宏观主机全部裸 `fetch` |
| 「读不到 ≠ 没有」 | **成立**（R1 已修到位） | `readGuard.ts` 全量 + `store.ts:414-446,462-499,506-510`；`ledger/calendar/globalFlow` 三处都有 `assertWritable` 拦写 |

---

## 四、断言强度：注入矩阵（改坏/改对实现 ⇒ 775 条是否红）

方法：在 `/tmp/rv-inj`（`git archive HEAD` 副本）里**逐字注入我建议的修法**，跑全量门禁；对照组注入一个**明显错误**。

| 注入 | 内容 | 期望 | 实测 |
|---|---|---|---|
| **I1** | `sina.ts:363` `vol: num(it.v) ?? 0` → `vol: numField(it.v)`（D2 的修法） | 若有用例锁住 ⇒ 红 | **全绿 ⇒ 无用例覆盖** |
| **I2** | `klineUnits.ts:218` 后加「`|log10(ratio/100)| > 0.1` ⇒ no-op」（D1 的修法） | 若有 ⇒ 红 | **全绿 ⇒ 无覆盖** |
| **I3** | `lock.ts:215` 加 `if (snap.pidAlive === true) return null`（D5 的修法） | 若有 ⇒ 红 | **全绿 ⇒ 无覆盖** |
| **I4** | `em.ts:2410` 改成 null 传播（D7 的修法） | 若有 ⇒ 红 | **全绿 ⇒ 无覆盖** |
| **CTL**（对照） | `usAggregate.ts:48` 周键 `((wd+6)%7)` → `((wd+7)%7)`（把周首算成周日） | 必须红 | **红**：`actual '2026-12-27' ≠ expected '2026-12-28'`（`usAggregate.test.ts:41`） |

```
$ cd /tmp/rv-inj && DSH_HOME=/tmp/rv-home-inj TZ=Asia/Shanghai node --test --experimental-strip-types "src/**/*.test.ts"
ℹ tests 775 / pass 775 / fail 0          # I1+I2+I3+I4 同时注入，仍全绿
$ cd /tmp/rv-ctl && … node --test … src/host/usAggregate.test.ts
not ok … actual: '2026-12-27', expected: '2026-12-28'   # 对照组能红
```
⇒ **对照组证明门禁有牙**；I1–I4 全绿证明上述四条**都在测试盲区**里。
⇒ 补充：`grep -rn parseSinaUsDaily src/host/*.test.ts` **零命中**——美股日线/分钟解析器完全没有单测（它是美股全链路唯一的历史源）。

---

## 五、查过、无发现（如实记录）

- **时区**：`time.ts` 的三个格式化器全部钉死 `Asia/Shanghai`/`America/New_York`；`weekdayOf`/`newYorkParts` 用 `Date.UTC` + `getUTCDay` 规避宿主时区；`parseMarketStamp` 对无偏移模板强制 `+08:00`；`usWallToEpoch` 迭代收敛并在 DST 空洞返回 `null`（`time.ts:245-262`）。全仓 `grep` 未发现无偏移 `Date.parse` 模板、`getHours/getDay/getMonth/getFullYear/toLocaleDateString` 的裸用（仅 `dayTrade.ts:83,91` 显式带 `timeZone`）。**TZ=UTC 与 TZ=Asia/Shanghai 各 775 条全绿**是一致的证据。
- **熔断作用域**：`breakerFor(host)` 按主机隔离；`withHostBreaker` 的 `allow → claimProbe → 记账 → finally releaseProbe` 闭环完整，非 2xx 也进账（`breakerFetch.ts:54-59`）；`recordFailure` 对半开探针失败**立即重熔**（`breaker.ts:84-94`）——这条正是最容易漏的，实现是对的。
- **锁的读-改-写范围**：`updateJsonLocked`（`lock.ts:470`）与 `bumpJsonCounter` 的协议说明与实现一致；`saveKlineCache`/`saveKlineCacheRepair` 都在锁内「读磁盘最新 → 按日期合并 → 原子写」；`saveKlineCacheRepair` **故意不改 `updatedAt`**（`em.ts:2265-2272`）——这一处是这类系统里最常见的「修复伪造新鲜度」，作者注意到了。
- **缓存键完整性**：`detail:${secid}` / `kline:${secid}:${klt}:${fqt}:{full|incr}` / `kline-us:${ticker}` / `clist-pct:${p}:${z}` / `board:${scope}:${sort}:${pn}:${pz}` / `trend-md:${sinaSym}:${txSym}:${datalen}` / `fx:${symbol}` / `aum:*:${key}` / `netflow:sh510300` —— 均包含全部影响结果的参数；`kline-us` 不含 `fqt` 但因 `fqt!==0 ⇒ []` 而不可污染。
- **反向注入式的「看着正常」陷阱**：`gb_*` 占位行（价格 1.0000 + 全 0）有专门判据；`int_*` 整族停用；`LKG` 装载时补 `source`/`at` 并把 `purged` 落盘；`RETIRED_INDEX_FALLBACK` 宁可作废也不当「最后成功值」。
- **`degrade.ts`**：`noteHostSkipped` 与 `noteHostFailure` 分开记（不会把「熔断期跳过」堆成「连续失败」）；`upstreamHealth` 只读内存、零新增请求；降级日志聚合（400 ms 桶）确实把「几十行刷屏」压成一行。
- **`readGuard.ts`**：`isFirstBoot` 只认 ENOENT；`assertWritable` 在**唯一落盘点** `persist()` 里（`store.ts:506-510`）；`unreadableMissing` 明确不用 `MISSING_TIER_ADVICE.transient` 顶替（因为权限问题不会自愈）——措辞与事实一致。

---

## 六、未确认 / 本轮没做

| # | 项 | 状态 | 卡在哪 |
|---|---|---|---|
| U1 | `vol` 单位在「东财 / 腾讯 / 新浪」三源之间是否一致（A股手 vs 美股股） | ○ | `QuoteRow.vol` 的契约写的是「as reported」，跨源只保证同一标的同类；需要真实三源同时刻回包才能定论（未打上游） |
| U2 | `parseSinaUsDaily` 的 `?? 0` 在**真实**回包里是否触发 | ○ | 未取真实美股早期 bar 的 `v` 原文；只证明了代码路径（P1 用构造载荷） |
| U3 | `detectUsSplits` 的 8% 容差对真实小盘股的误报率 | ◐ | 已证明构造上必然把「真跌 50% / 真涨 100%」标成 `2:1 拆股 / 1:2 合股`（探针 1 P4）；真实误报率需样本回测，未做 |
| U4 | `alignVolUnitWithQuote` 在**真实**盘中触发过几次 | ◐ | 需要盘中连续采样 `/tradewatcher/chips` 的 `unitNote` 并与日线日期比对；本轮未在盘中，未打线上端点 |
| U5 | `klineMem` 的常驻内存上限 | ◐ | 代码无上限可确定；真实占用取决于用户浏览过的标的数，未量化 |
| U6 | `marketExtras` 的 `usdIndexCross/us10yCross/us10yHistory` 是否有计划接入 | ○ | 目前只有测试消费者；「线上不可达」是我的静态判断（`grep` 全仓） |
| U7 | `quoteSlots` 超限淘汰的真实影响 | ◐ | 需 >1500 个不同 secid 才会触发，线上远达不到 |
| U8 | typecheck | — | 只在 `/tmp` 跑 `node --test` 与 `node build.mjs`，**未跑** `tsc --noEmit`（D2 的修法会要求放宽 `SinaBar.vol` 类型，届时 typecheck 必红，属预期） |

---

## 附：本轮全部探针（都在 `/tmp` 副本里，可逐字复现）

```
/tmp/rv-host/work/probe-units.ts    # 量纲 / 0 顶替 / 聚合边界 / 拆股误报（P1–P9）
/tmp/rv-host/work/probe-align.ts    # D1：同日前提恒真 + 20–100× 过度校正 + 筹码数字对比
/tmp/rv-host/work/probe-cache.ts    # D6：suggest 缓存无界增长（3000+3000 条，heap 12→26→40 MB）
/tmp/rv-host/work/probe-perf.ts     # E2/E3：全历史聚合 9.33 ms/次、mergeBars 0.19 ms、落盘 430 KB
/tmp/rv-host/work/probe-lock.ts     # D5：活着的持有者被判「心跳断供」可回收
/tmp/rv-host/work/probe-extras.ts   # D3/D4：宏观取数点绕过门禁 + 两处 0 顶替
/tmp/rv-inj                          # 注入 I1–I4（全绿 ⇒ 四条均在盲区）
/tmp/rv-ctl                          # 对照注入 CTL（能红 ⇒ 门禁有牙）
```
