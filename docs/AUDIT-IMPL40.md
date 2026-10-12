# AUDIT-IMPL40 —— 修分时量能失效：腾讯逐分钟兜底（差分 + 推导标记）+ 缺数据必须给原因

- 基线：`main` @ `e365440`（v0.65.0），`npm run check` = 430 × 2 全绿
- 本轮结果：**435 × 2 全绿**（+5 条断言：`em.test.ts` +3、新建 `client/rescuePulse.test.ts` +2）
- `build.mjs` **零改动**（73 项片段校验通过）；未装 bundle / 未动 profile / 未 commit / 未重启

---

## 1. 先纠一处事实（任务卡与代码不一致）

任务卡写「分时逐分钟序列**没有兜底**（全仓 grep `minute/query` 零命中）」——**实际已经有了**：

| 事实 | 位置 |
|---|---|
| 腾讯逐分钟取数**早已存在** | `src/host/tencent.ts:266`（`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=…`），导出为 `fetchTencentMinutes` |
| 已被两处消费 | `src/host/em.ts` 的 `tencentTrend()`（分时兜底链 上游→腾讯→LKG）、`src/host/rescue.ts:856` 的 `fetchMinuteSeriesAny()` |

**真正的缺陷**是另外两处（＝用户看到的现象）：
1. `tencentTrend()` 把每个点的 `amount` **写成了 `null`** ⇒ 客户端 `PulseChart` 的判据是
   `points.filter(p => p.amount > 0)` 不足 5 ⇒ 只剩一句「分钟成交额未取到」；
2. `/trend` 只在 `trend === null` 时给 `missing` ⇒「有 193 个点、个个没有额」时 `missing` 仍是 `null`
   —— **违反项目红线（缺失必须给原因）**，且与 lead 实测一致（`points=0` 那次是当时腾讯源也没拿到，现在东财/腾讯都在动）。

## 2. 上游结构与字段映射（**自己 curl 验证过**）

```
$ curl -s 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=sh510300'
{"code":0,"msg":"","data":{"sh510300":{"data":{"data":["0930 4.384 76758 33650707.00","0931 4.382 219031 95963053.00",…],"date":"20261012"},"qt":…,"mx_price":…}}}
```

| 段 | 含义 | 口径 |
|---|---|---|
| 1 | `HHMM` | 北京时间 |
| 2 | 价格 | 该分钟末价 |
| 3 | 成交量 | **当日累计**，单位 **手** |
| 4 | 成交额 | **当日累计**，单位 **元** ← ⚠ 任务卡以为只有 3 段；实测**有第 4 段** |

**实测校验第 4 段确实是成交额**：`219031 手 × 100 × 4.382 = 95,979,384` vs 上游给的 `95,963,053`
（差 **0.017%**，差异来自"末价 vs 分钟 VWAP" ⇒ 第 4 段是上游自算的累计额，**不是** 我们用价格×手数推的）。

覆盖验证（同一次 curl，四个代表标的都有 `date` 与 ~190 行）：
`sh510300`（ETF）/ `sh000001`（指数）/ `sz000001`（深市个股）/ `sh600519`（沪市个股）✓

### 映射与"推导值"标注

`TrendPoint.amount` 的口径是**每分钟**成交额（东财 `trends2` 给的就是每分钟值），
而腾讯只给**累计**额 ⇒ 必须差分：

```
每分钟额[i] = 累计额[i] − 累计额[i−1]        （首点 = 累计额[0]，即开盘集合竞价那一笔）
每分钟量[i] = 累计量[i] − 累计量[i−1]        （vol 也一并改成每分钟，与东财口径一致）
```

- 每个带成交额的点**都挂** `amountDerived: true` + `amountNote`
  （原文：`腾讯逐分钟只给累计成交额 ⇒ 每分钟成交额由相邻累计值差分得到（推导值，非上游直给的分钟额）`）
  ⇒ **不把它当上游直给的分钟额**；
- 累计值**回退/缺失**（数据抖、结构变化）⇒ 该点 `amount: null` / `vol: null`：**如实缺失，不编、不用 0 顶替**；
- 映射逻辑抽成**纯函数** `minuteTrendPointsOf()`（`tencent.ts`），IO 留在 `em.ts` 的 `tencentTrend()`。

## 3. 改动点

| 文件 | 改动 |
|---|---|
| `src/host/tencent.ts` | 新增纯函数 `minuteTrendPointsOf(raw, tsLabel)`：差分出每分钟额/量、挂 `amountDerived`/`amountNote`、回退时如实 null |
| `src/host/em.ts` | `tencentTrend()` 改为调用上面的纯函数（原来 `amount: null`）；label 改用 `dayOf`+`hhmmOf`（**一律北京时间**，原来是"UTC 日期 + 宿主本地时间"混着拼）；新增纯函数 `trendAmountMissingReason(trend, opts)`：量能用不了时给三情形原因 |
| `src/host/routes.ts` | `/trend` 在 `trend !== null` 时也检查量能：不足 5 个带额的点 ⇒ 追加 `missing[]`（整条为 null 时仍用 `trendMissingReason`，两条不重复） |
| `src/client/RescuePanel.tsx` | ① 保存 `/trend` 的 `missing[0].note` 并传进 `PulseChart`；② 未取到时**常驻仍是那一句**「分钟成交额未取到」，**原因进 `title` + `aria-label`**（`tabIndex:0 role:note`）；③ 序列带 `amountDerived` ⇒ 常驻一个 4 字标记「**量能推算**」，说明进 `title`/`aria-label`（不新增常驻长句） |
| `src/client/rescuePulse.test.ts`（新） | 客户端接线断言 + 两条反例注入 |

**未改护盘评分**：分时量能只走展示路径；`rescue.ts` 的取数（`fetchMinuteSeriesAny`，累计口径）与评分逻辑**一行未动**。

## 4. 断言与证据（+5，含反例）

| # | 断言 | 反例注入 |
|---|---|---|
| ① | `minuteTrendPointsOf`：首点=累计本身、第 2 点=相邻累计之差（额与量都验）、每个额点都带 `amountDerived`、**逐分钟额之和 == 末点累计额**（守恒）、累计回退 ⇒ null、全无额 ⇒ `allDerived=false` | 用"照搬累计值/给 null"的 `broken`（＝关掉兜底的样子）⇒ 断言必然失败（`assert.throws`） |
| ② | `trendAmountMissingReason`：够用 ⇒ `null`；`<5` ⇒ 非空；**三情形文案互不相同**（`Set(notes).size === 3`） | 把返回写成老行为 `null` ⇒ `assert.throws` 证明"必须给原因"失败 |
| ③ | 三情形逐条：①`emDown` ⇒ `transient` + 含"东财…不可达"与"腾讯" + 含"几个点里有几个可用"；②可达 ⇒ `no-source` + 含"字段/结构" + 含"不用 0 顶替"；③凌晨 ⇒ 含"非采样时段" + "不是故障" | ——（②那条已含反例） |
| ④ | 客户端：`missing[0].note` 被消费、原因进 `title`+`aria-label`、宿主没给时写「原因未给出」；`amountDerived` ⇒ 出现「量能推算」+ 说明进 title/aria、优先用宿主 `amountNote` | 去掉 `title: reason` ⇒ 判据非空；把 `.amountDerived === true` 改成 `false`（＝把推导值当上游直给）⇒ 判据非空 |

**真实数据端到端（本轮实测，注入"东财不可达"强制走兜底）**：

```
★ points = 193  带成交额 = 192  标推导 = 193
  首点 {label:2026-10-12 09:30, price:4.384, vol:76758,   amount:33650707,  amountDerived:true}
  第2点 {label:2026-10-12 09:31, price:4.382, vol:142273,  amount:62312346,  amountDerived:true}
        ↑ 142273 = 219031−76758 ；62312346 = 95963053−33650707（差分正确）
  末点 {label:2026-10-12 14:11, price:4.359, vol:2444,     amount:1065034.24}
```

## 5. 量级一致性（任务要求：把数字写进报告，对不上就报差异，不许调参凑）

| 量 | 由腾讯逐分钟推导 | 日线（同日） | 结论 |
|---|---|---|---|
| 成交量 | 逐分钟**合计 4,673,155 手** | 腾讯日线 `vol = 4,673,155`；东财日线 `vol = 4,673,155` | **逐位相等**（三个数字完全一致）✓ |
| 成交额 | 逐分钟合计 **20.4876 亿元**（截至 14:11） | 日线接口**没有 amount 字段**可比 | 与"量×价"交叉核：`4,673,155 手 × 100 股 × 4.384 元 ≈ 20.49 亿元` ⇒ 与推导合计一致（差 0.01%）✓ |

⇒ **没有对不上的地方，也没有任何调参**；量能合计与日线量逐位相等这一点，也反证了"差分 + 每秒不漏点"的实现是对的。

## 6. 测试条数变化

| | 条数（每时区） |
|---|---|
| 基线 `e365440` | 430 |
| `em.test.ts` +3 | |
| 新建 `client/rescuePulse.test.ts` +2 | |
| **本轮之后** | **435** |

```
ℹ tests 435
ℹ pass 435
ℹ fail 0
```

（两次各 435；随后 `ALL HOST CHECKS PASSED (live probes soft)` 与
`built lib/index.js + lib/client.js （v0.65.0，客户端片段校验通过：73 项）`。）
改动文件：`src/host/{tencent.ts,em.ts,routes.ts,em.test.ts}`、`src/client/{RescuePanel.tsx,rescuePulse.test.ts}` + 本文件；
`build.mjs` / `package.json` / `cordis.patch.yml` **零改动**；`src/shared/model.ts` **未改**（见 §7 第 1 条）。

## 7. 未做项

1. **`amountDerived` 目前是运行期附加字段**（`TrendPoint` 在 `shared/model.ts` 里没有这个键，本任务写作范围不含该文件）。
   要把它升为正式契约：`TrendPoint` 加 `amountDerived?: boolean`、`TrendData.source` 的联合类型加 `'tencent-minute'`
   —— 两行改动，但与客户端 8 个消费者同批更稳，建议单开。客户端现在用**断言中的运行时读取**（`(p as { amountDerived?: boolean })`）消费它。
2. **`vol` 语义变更需知会下游**：腾讯兜底路径的 `vol` 由"累计手数"改为"每分钟手数"（与东财一致）。
   我 grep 过：`TrendPoint.vol` 的消费者是图表与 `trendView`（都按每分钟读），**没有别处按累计读**；`rescue.ts` 用的是它自己的
   `fetchMinuteSeriesAny`（累计口径，未动）✓ 两者不混。
3. **只覆盖沪/深**（`tencentCode` 的映射范围）⇒ 港股/美股仍只有东财源；这类标的分时量能取不到时，
   §4 的 ①② 原因会如实说明（不是静默空图）。
4. **未做真页面复核**：线上宿主仍是旧构建；发布后可用
   `curl '127.0.0.1:3080/tradewatcher/trend?secid=1.510300' | jq '.trend.points[1].amountDerived, .missing'` 复核。
