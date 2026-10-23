# AUDIT-LOG-NOISE：降级日志的跨批抑制与熔断期降噪

**一行结论**：日志聚合原来只做"**同一批内**合并"（400ms 窗口），窗口一过同一件事又原样刷一遍；现在补上
**跨批同一签名抑制**（首次 + 累计每翻 10 倍各一条）、**熔断期只记三次状态转换**、**原因最短表述折叠**、
**单条 ≤ 200 字硬上限**，并把抑制条数写进状态转换那条里 —— 构造场景（熔断 10 分钟、每 10 秒一次失败）
**180 条 → 5 条**，K 线降级长行 **316 字 → 184 字**（原因折叠成 `×27`）。

- 纪律：`build.mjs` 未改（构建 73 项）；不 commit／不装／不重启；无新依赖；实验 `DSH_HOME=/tmp/lognoise-*`。
- 门禁：**1219 × 2 时区**（Asia/Shanghai 1219/1219、TZ=UTC 1219/1219）+ 构建 73 项。
  本轮新增 7 条（`src/host/logNoise.test.ts`）。

---

## 1. 现象（用户日志）

同一组失败在整段日志里重复几十次、每次都是「1 个」：

```
[tradewatcher] 东财连接被立刻关闭（跳过第二轮重试） 1 个（pass 1 整轮 TypeError: fetch failed）；样例：…
[tradewatcher] 东财上游不可达 1 个（fetch failed）；样例：…
[tradewatcher] 东财行情批量失败 1 个（pass 1（TypeError: fetch failed））；样例：…
…（每 10 秒一轮，重复几十轮）
```

以及一行超长的 K 线降级：

```
[tradewatcher] K 线缓存降级采用 N 个（未完成 bar 已超过 60s TTL ⇒ 回源重取；但文件里有 810 根，丢掉不可信的最后…、
未完成 bar 已超过 60s TTL ⇒ 回源重取；但文件里有 809 根，… 等 27 类原因）；样例：…
```

**根因**：`flushDegraded()` 每 400ms 把桶清空并逐桶输出，**桶外没有任何状态** ⇒ 下一个窗口同样的
`kind` 又从"第一次"开始算；熔断 open 期间每个 tick 仍走同一条 `noteDegraded` 路径。

## 2. 五项逐条

| # | 要求 | 实现（`src/host/degrade.ts`） |
|---|---|---|
| 1 | **跨批同一签名抑制**：按 (level, 模板, host 集合) 归并；状态未变时只在首次与"累计每翻 10 倍"各输出 1 条 | `admitSignature(sig, reasonKey, hosts)` + `sigs` 注册表（`total/emitted/suppressed/emitAt/reasonKey`）。签名 = `deg|<kind>`（level 恒为 warn；host 集合记在 `sigHosts` 里用于恢复清零）。数字上界：N 次事件最多输出 `1 + floor(log10 N)` 条。**原因签名变了立刻再出一条**（状态变了不能静默） |
| 2 | **熔断期降噪**：open 状态下不再逐 tick 记录，只记 ①熔断开启 ②half-open 探测 ③恢复 | `noteHostFailure/noteHostSkipped` 里按"状态转换"判定：仅 `!prevOpen → open` 时出「熔断开启」；`noteHostProbe()`（由 `breakerFetch.withHostBreaker` 在 `inHalfOpen` 放行探针时调用）出「half-open 探测」；`noteHostSuccess` 在曾熔断时出「恢复」。其余 tick 只 `noise.suppressed += 1`。另外 `noteDegraded` 新增可选 `hosts`：**涉及的主机全部 open** ⇒ 该 tick 不产出日志（`em.ts` 的三条批量失败日志已传入 `hosts`） |
| 3 | **原因串去重**：折叠成 `原因A ×52、原因B ×4`，只保留最短表述，长解释进 `TW_DEBUG=1` | `shortReasonOf()`（在 `；;/⇒（(：，,` 第一处截断，限 22 字）+ `reasonTally()` 按最短表述聚合计数。逐文件的长尾巴（"文件里有 810 根 / 808 根…"）因此归成同一类；完整 `detail` 只在 `TW_DEBUG=1` 打 |
| 4 | **总行长上限 ≤ 200 字**，超出 `…` 截断并在末尾给 `(其余见 TW_DEBUG=1)` | `LOG_LINE_MAX = 200` + `clipLogLine()`（`…(其余见 TW_DEBUG=1)` 尾巴也算在 200 内），`flushDegraded` 每条都过它 |
| 5 | **计数可核对**：抑制期间的次数量化在状态转换那条里 | 两种抑制分开写，语义不同：<br>· `期间抑制 N 条` = 熔断 open 期**没进桶**的 tick（每台主机各计，转换时结算）<br>· `聚合抑制 N 条` = 进了桶但被签名规则折叠掉的条数<br>另导出 `logNoiseStats() → {emitted, suppressed}`（断言与排障都读它） |

## 3. 改前/改后（构造场景实测）

**场景 A：熔断 open 持续 10 分钟、每 10 秒一次失败（60 tick × 3 条真实日志形状 + 每 tick 3 台主机记账）**

| | 输出条数 |
|---|---|
| 改前（`HEAD` 版 `degrade.ts`） | **180 条**（60 tick × 3 组，每轮 `1 个`） |
| 改后 | **5 条** |

改后的 5 条（节选）：

```
[tradewatcher] 东财连接被立刻关闭（跳过第二轮重试） 1 个（pass 1 整轮 TypeError: …）；样例：push2his.eastmoney.com/…
[tradewatcher] 东财上游不可达 1 个（fetch failed）；样例：…
[tradewatcher] 东财行情批量失败 1 个（pass 1）；样例：1.600519,1.000001,0.399001；明细见 debug 级（TW_DEBUG=1）
[tradewatcher] 上游熔断开启 3 个（连续失败 1 次后熔断 ×3）；样例：push2his.eastmoney.com、push2delay.eastmoney.com、push2.eastmoney.com
[tradewatcher] 上游恢复 3 个（探测成功 ×3）；样例：…；期间抑制 681 条；明细见 debug 级（TW_DEBUG=1）
```

**场景 B：K 线降级 27 个文件（原因尾巴逐文件不同）**

| | 行数 | 首行字数 | 原因写法 |
|---|---|---|---|
| 改前 | 1 | **316** | 27 条近乎重复的整句（`… 等 27 类原因`） |
| 改后 | 1 | **184** | `未完成 bar 已超过 60s TTL ×27`（长解释进 debug） |

## 4. 断言 + 反例注入（`src/host/logNoise.test.ts`，7 条）

| 判据 | 读数 | 注入（必败） |
|---|---|---|
| **验收**：10 分钟故障 ⇒ ≤5 条 | 60 tick 模拟 ⇒ **5 条**，含「上游熔断开启」「上游恢复」与 `期间抑制 N 条` | 逐 tick 输出（180 条）⇒ ≤5 必败 |
| ① 同签名 100 次 ⇒ ≤3 条、末条 `抑制 97 条` | 输出 3 条（1/10/100），末条含 `聚合抑制 97 条`；`logNoiseStats()` 的 `emitted + suppressed === 100` | 不抑制（100 条）⇒ 必败 |
| ② 熔断期只留 3 类状态转换 | 3 次失败 ⇒「开启」1 条；熔断期 30 tick（失败/跳过/批量日志）**0 条**；探测 1 条；恢复 1 条；状态事实合计 **3** 条，`期间抑制 ≥ 30` | 逐 tick 记（≥30 条）⇒ 必败 |
| ③ 单条 ≤ 200 字 | 三类原因 × 长样例名 ⇒ 1 行 **≤200**，末尾 `(其余见 TW_DEBUG=1)`，原因折叠成 `×9` | 保留全文（>200）⇒ 必败 |
| ④ `TW_DEBUG=1` 仍看得到被抑制的明细 | 12 次 ⇒ 可见 ≤2 条、debug **12 条**（含最后一次） | debug 也吞掉（0 条）⇒ 必败 |
| ⑤ 恢复后计数归零 | 第一轮 100 次（末条 `聚合抑制 97 条`）→ 主机恢复 → 第二轮第 1 次**立刻输出 1 条**且不带旧计数 | 不清零（沿用 100 次 ⇒ 门槛 1000 吃掉这条）⇒ 必败 |
| 原因折叠（纯函数） | 尾巴不同（810 根 / 808 根）⇒ 同一个最短表述；空串 ⇒ `原因未给出`；限 22 字 | 保留整句（两串不相等）⇒ 必败 |

## 5. 影响面与未做项

- **影响面**：`flushDegraded` 的输出格式（原因用最短表述、多了 `期间抑制/聚合抑制`、限长 200）；
  `noteDegraded` 多了可选 `hosts`（不传 = 行为不变）；`noteHostFailure/Skipped/Success` 现在可能在
  **状态转换**时产出日志（此前完全不产出）。既有断言（`degrade.test.ts` ⑥/⑥b/⑧）全部通过。
- **未做项**：
  | 项 | 原因 |
  |---|---|
  | 把 `logNoiseStats()` 挂进 `/tradewatcher/health` | 本轮只做日志降噪；面板没要求，且 `/health` 契约冻结（加字段要走一轮契约变更） |
  | 抑制账**落盘**（重启后仍记得"已经报过"） | 进程重启等于一次干净启动，此刻把状态说一遍是对的；落盘会让"重启后首次故障"被历史抑制吃掉 |
  | `/trend`、`/kline` 其它 `noteDegraded` 站点逐个补 `hosts` | 只有**主机级**失败需要熔断期降噪（em 三条已补）；其余是标的高级降级（如 K 线缓存），与主机 open 无关 |
  | `console.warn` → 结构化日志 | 不在本轮范围（无新依赖） |
