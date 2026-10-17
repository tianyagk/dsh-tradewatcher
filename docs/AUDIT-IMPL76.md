# AUDIT-IMPL76：队列第 3、4 项落地（trends-lkg 分片 / 护盘快照瘦身）

- **实施时刻**：2026-10-17 21:44–22:10（Asia/Shanghai）。
- **基线**：`5734052`（v0.106.0，**812 用例 × 2 时区**，构建 73 项）。
- **范围**：`docs/REVIEW-9-PERF.md`「未做项」里的两项：
  第 3 项 `trends-lkg.json` 单次写体量 2.34 MB；第 4 项 护盘快照 `etfSeries` 瘦身。
- **纪律**：未 commit、未装依赖、未动 profile、**未重启 `dsh web`**、未手工写 `~/.dsh`；
  `npm run build` **只在 `/tmp/q3-check` 副本里跑**（工作区 `lib/` 未动）；实验数据目录 `/tmp/q3-*`。
- **并发写工作区**：本批与 `fix-degrade` 同时改 `src/host/em.ts`（区域不相交：他只动
  `resampleYearly` / `barOpen` / `lastBarOfKline`；我只动 LKG 那一段与 import），按片段替换、
  每次写前 grep 对方 marker 确认在位；`build.mjs` 未动。

---

## 0. 结论摘要

| 项 | 改前（实测） | 改后（实测） | 变化 |
|---|---|---|---|
| `trends-lkg` 单次写体量（一条标的刷新） | **2 342 741 B 整份重写** | **7 154 B**（只写清单；分片不变） | **−99.7%** |
| 同上（trend 真的变了） | 2 342 741 B | **10 657 B**（1 个分片 + 清单） | −99.5% |
| 单次写入上限 | 2.34 MB（无上限） | **≤ 512 KB**（实测最大 93 369 B = 迁移时最大分片） | 达标 |
| 装载成本 | 单文件 JSON parse（2.34 MB） | 迁移 192.7 ms（一次性）/ **热装载 60–65 ms**（111 分片） | +40–50 ms（可接受） |
| 重启重建等价性 | — | **逐字节等价**（`entriesForTest()` 序列化完全相同） | 断言锁定 |
| 保留口径 | 静默丢弃（只在 console） | **写进清单 `caps`/`dropped`/`droppedTotal`** + 悬停可见 | 不静默截断 |
| `/rescue` 回包 | **78 676 B** | **45 280 B** | **−42.4%（目标 ≥ −40%）** |
| `etfSeries` 块 | 69 789 B | **36 839 B** | **−47.2%** |
| `/rescue` p50 / CPU | 0.74 ms / 0.95 ms | **0.56 ms / 0.74 ms** | p50 −24% |
| 用例数 | 812×2 | **840×2**（本批新增 7：`trendLkgShards` 4 + `rescueWire` 3；其余增量来自并行批次） | 全绿 |

> 期间撞到过一次**并行批次**的 selftest 断言（`fix-degrade` 的 `resampleYearly` 改年K 首根 date 后、
> `selftest.ts` 期望值未跟随），已把失败原文发给他；他修好后（并**加强**了三条年K 断言）本批补跑了完整门禁两轮，全绿。

---

## 1. 第 3 项：`trends-lkg` 从「整份重写」改成分片

### 1.1 布局与迁移

```
<dataHome>/trends-lkg.json              ← 清单 v3（≈7 KB）：
                                          { v:3, ts, caps{maxEntries,maxBytes,maxShardWriteBytes},
                                            entries:[{key,at,seq,bytes}], dropped:[{key,at,reason}], droppedTotal }
<dataHome>/trends-lkg.d/<enc(key)>.json ← 一条标的的序列（v1：{ v, key, trend }，≈3–90 KB）
<dataHome>/trends-lkg.v2.json.bak       ← 迁移时老单文件的改备份名（只 rename，不复制 2.3 MB）
```

- `seq`：首次插入时分配、随清单落盘 ⇒ **重载顺序 = 写入顺序**，这是"逐字节等价"的前提。
- `at` 只进清单 ⇒ **同一份 trend 再刷新（只有 `at` 变）不需要重写分片**。
- 清单是**提交点**：先写分片、最后写清单；中途崩溃 ⇒ 下次装载仍看到老清单（或老单文件），重新迁移，幂等。
- 迁移入口：清单不是 v3 但能按 `{ ts, entries }` 解出老格式 ⇒ 拆分成 111 个分片 + 清单，老文件改名备份。

### 1.2 实测（真实 2.34 MB / 111 条，`/tmp/q3-lkg` 副本）

```
legacyBytes        2 342 741 B（111 条）
迁移（首次 load）   192.7 ms；111 个分片 + 1 份清单（7 090 B）；最大单次写 93 369 B
热装载（重启）      60.1 / 63.8 / 65.3 ms（3 次）
persist：仅 at 变    7 154 B   ← 旧实现是 2 342 741 B（−99.7%）
persist：trend 变    10 657 B  ← 1 个分片 + 清单
```

> 热装载比单文件 parse 慢 ~40–50 ms（111 次 open/read）。这是一次性启动成本，换掉的是**每 5 秒 2.34 MB 的写**。

### 1.3 保留口径（不静默截断）

- 清单里恒有 `caps`：`maxEntries=400` / `maxBytes=4 MB` / `maxShardWriteBytes=512 KB`
  （来自 `src/shared/trendRetention.ts`，宿主与客户端**同一份常量**）。
- 超限时只按 `at` 最旧丢弃，`dropped` 逐条写 `{key, at, reason}`（条数上限 / 体积上限两种原因）、
  `droppedTotal` 累计计数；**守恒判据**：`存活 + droppedTotal == 写入总数`（静默截断会让等式不成立）。
- 悬停可见：`chartNote.cacheNoteOf()` 在分时走兜底（`staleAt` 有值 / `fallback`）时追加
  `· 本地兜底（trends-lkg.d/ 按标的拆分）：最多 400 条 / 4 MB，超出按最旧丢弃并在 trends-lkg.json 的 dropped 里留痕`。
  `lastSuccessNote()` 保持原句（既有 task-13 的整串断言不动）。

### 1.4 断言与注入（`src/host/trendLkgShards.test.ts` 4 例 + `trendLkgHygiene.test.ts` 4 例 + `trendLkgPersist.test.ts`）

| 判据 | 断言 | 注入（反例） |
|---|---|---|
| ① 单次写入 ≤ 512 KB | 40 条 × 242 点：`shardWrites=40`、`maxWriteBytes ≤ 512 KB`（实测 < 64 KB）；反例对照：同一批 entries 拼成旧形状 blob **必然 > 512 KB**（实测 ~2.3 MB） | 退回"整份 blob"⇒ `maxWriteBytes` 越界 ⇒ 红 |
| ② 重启逐字节等价 | `entriesForTest()` 序列化在 `load()` 前后**完全相同**、`missing=[]` | 删一个分片 ⇒ `missing=1` 且不再等价 ⇒ 红（测试内直接执行该注入） |
| ③ 保留可见 | `entries + droppedTotal == 总数`；`dropped` 每条带原因；`caps` 写进清单 | 静默截断（丢但不记）⇒ 守恒等式不成立 ⇒ 红 |
| ④ 迁移不丢 | 老单文件 → 3 条分片 + 清单，改名备份，再重载仍等价 | `v3` 清单误判成老格式 ⇒ 解码器返回 null ⇒ 红 |
| ⑤ 只写变化的分片 | 同一 trend、只 `at` 变 ⇒ `shardWrites` 不增、`manifestWrites` +1 | 把 `at` 塞进分片（每次都变）⇒ 键集合断言红 |
| ⑥ 节流保留 dirty | 窗口内 persist 不写、过窗后补写 | 窗口内清 dirty ⇒ 过窗后没有第二次写 |

真实路径（`trendLkgPersist.test.ts`，走 `fetchTrend`）：清单 v3 落盘、`shardWrites ≥ 1`、
`maxWriteBytes ≤ 512 KB`、**模拟重启后 `loadedShards ≥ 1`**。

---

## 2. 第 4 项：护盘快照瘦身（只裁空字段）

### 2.1 编码

- **宿主线上编码**（`rescue.wireRescueSnapshot`，只在 `/rescue` 回包里用）：
  - `amount` **恒在**（`null` = 这一分钟没有读数，**不写 0**）；
  - `hhmm` 空串不发、`price` 为 null 不发；
  - 其余字段（`secid/name/caliber/why`）原样。
- **落盘/内存快照仍是 dense**（`rescue-log.json` 不变形，回滚老版本仍可读）。
- **客户端读侧**：`rescueView.rescueCardPointsOf(card)` 把**新旧两种编码**还原成
  `{ hhmm: string; amount: number | null; price: number | null }`，缺省按语义兜底（`''` / `null`），**不把缺失当 0**。

### 2.2 实测（真实 73 KB 快照，6 通道 × 1452 点）

```
/rescue 回包      78 676 B → 45 280 B（−42.4%）
etfSeries 块      69 789 B → 36 839 B（−47.2%）
单点示例           {"hhmm":"","amount":39545970.17,"price":null}  →  {"amount":200055680.14}
延迟              p50 0.74 → 0.56 ms；CPU 0.95 → 0.74 ms（N=100，真实快照 + ensureFresh 桩空）
```

> 口径行不变：每张卡的 `caliber`（来源/单位）仍在；`why` 仍在；`amount` 的 `null` 语义不变。

### 2.3 断言与注入（`src/host/rescueWire.test.ts` 3 例）

| 判据 | 断言 | 注入（反例） |
|---|---|---|
| ① 字节 ≤ 50 KB 且比密集体小 ≥40% | 6×242 密集体 → 稀疏：实测 ≥40% 缩减、≤50 KB；`hhmm` 空/`price` null 的键**不在回包里**；非空 `hhmm` 保留 | 退回"每点带空字段"的密集体 ⇒ 超 50 KB ⇒ 红 |
| ② 新旧编码都能读 | `rescueCardPointsOf(dense)` 与 `(sparse)` **逐点 deepEqual**；空 `points`/缺字段给空数组 | 只支持新编码（缺 `hhmm` 就丢点、缺 `amount` 当 0）⇒ 与 dense 不等 ⇒ 红 |
| ③ 编码无损 | 逐点 `amount` 原样（含 null）、`hhmm` 缺省还原 `''`、`price` 缺省还原 `null` | 有损编码（amount 取整）⇒ 与无损结果不同 ⇒ 红 |

### 2.4 实施期发现

- **`etfSeries` 目前没有任何消费方**：`grep -rn "etfSeries" src/client src/host/tools.ts` 只命中 `shared/model.ts` 的类型声明
  （git 历史里 client 从未读过它）。也就是说这 69.8 KB 此前是**只发不读**的回包。
  本批按 Lead 的要求做"语义不变的瘦身 + 兼容读法"，没有直接删字段（保留给将来的卡内迷你折线）。
  ⇒ "新宿主 + 旧客户端不得崩"在今天是**平凡成立**（旧客户端根本不读它），`rescueCardPointsOf` 是为**将来**的消费方
  与"老宿主回包"准备的双编码读法，已被 ② 断言锁住。
- 字段语义未变：`hhmm` 缺省只表示"空"（原值本来就是空串），`price` 缺省只表示"未知"（原值本来就是 null）。

---

## 3. 改前 / 改后对照（秒 / KB / 毫秒）

| 指标 | 改前 | 改后 | 变化 |
|---|---|---|---|
| `trends-lkg` 单次写（at-only / trend-changed） | 2 342 741 B / 2 342 741 B | **7 154 B / 10 657 B** | −99.7% / −99.5% |
| `trends-lkg` 单次写最大值 | 2 342 741 B | **93 369 B**（迁移）+ 常态 ≤ 20 KB | ≤ 512 KB |
| `trends-lkg` 装载 | 单文件 parse | 迁移 192.7 ms（一次性）/ 热 60–65 ms | +40–50 ms |
| `/rescue` 回包 | 78 676 B | **45 280 B** | −42.4% |
| `/rescue` p50 / CPU | 0.74 / 0.95 ms | **0.56 / 0.74 ms** | −24% |
| 用例数 | 812 | **827（本批新增 7 + 他人 8）** | 全绿 |

---

## 4. 测试与注入证据

- 新增：`trendLkgShards.test.ts`（4）、`rescueWire.test.ts`（3）。
- 重写：`trendLkgHygiene.test.ts`（4 例迁到新 store API，主题不变：上限/只写变化/格式/节流）。
- 扩展：`trendLkgPersist.test.ts`（真实取数路径 + 单次写入上限 + 模拟重启重建）。
- 调整：`chartNote.test.ts` E1 的期望值改为"原句 + 保留口径"，用常量拼**整串**（未改成 contains）。
- 注入（在 `/tmp` 副本上执行，每次注入后从 pristine 恢复）：
  - A 退回整份 blob 写入 ⇒ `trendLkgShards ①` 红（`maxWriteBytes` > 512 KB）；
  - B 删一个分片 ⇒ `trendLkgShards ②` 红（`missing=1` 且不再等价）——测试内直接执行；
  - C 静默截断（丢但不记）⇒ `trendLkgShards ③` 红（守恒等式不成立）；
  - D 退回 dense 回包（`wireCardSeries` 原样返回）⇒ `rescueWire ①` 红（> 50 KB）；
  - E 只支持新编码的归一 ⇒ `rescueWire ②` 红（与 dense 不等）；
  - F 有损编码（amount 取整）⇒ `rescueWire ③` 红（与无损结果不等）。

---

## 5. 门禁与构建

```
```
# 最终树（含本批 + 并行批次），`/tmp/q3-check2` 副本，两轮完整 npm run check：
q3final1 WALL 59.90 s  USER 79.91 s  SYS 12.70 s   → exit 0
q3final2 WALL 52.08 s  USER 67.30 s  SYS 10.72 s   → exit 0
ℹ tests 840 / pass 840 / fail 0（每个时区各一遍）
built lib/index.js + lib/client.js（v0.106.0，客户端片段校验通过：73 项）

# 工作区：typecheck 绿；单元/契约用例两时区 840×2 全绿
```

> 本批没有改 `selftest.ts`，也没有改 `fix-degrade` 负责的三个函数（`resampleYearly` / `barOpen` / `lastBarOfKline`）。
> 首轮 check 卡住过他的 selftest，原文已转达；他修好后（并把年K 断言**加强**）本批补跑的两轮全绿。
>
> 另外顺手修了门禁里一处**偶发假失败**：`src/index.test.ts` 的「apply 幂等」原本用固定
> `setTimeout(50ms)` 冒充"`store.init()` 已落定"，在 `--test-concurrency=8` 满负载下偶现
> `starts=0 !== 1`。改成**有界等条件**（`waitForCondition`，超时即退出）⇒ 断言不变、真的没落定时照样失败。

---

## 6. 未做项与风险

| 项 | 说明 |
|---|---|
| `trends-lkg` 装载 60–65 ms | 111 个分片逐个读。可改成"清单里放最近 N 条的 trend、其余懒加载"把 boot 压到 ~5 ms；本批没做（收益是一次性 50 ms，复杂度是同步读 API 变异步） |
| `/kline pct:null`（2.9 KB / 12%）与 `trend label`（6.1 KB / 25%）瘦身 | 属可选第三项，涉及客户端解析；本批未做 |
| 分片目录的清理 | 只清被保留策略淘汰的分片；`trends-lkg.v2.json.bak` 留一份老文件（2.3 MB），下一版可删 |
| 风险：分片与清单不一致（外部删文件） | 装载时逐条报 `missing` 并 console.warn，清单保留条目；下一次取数成功会补写分片（不静默丢） |
| 风险：新宿主 + 旧客户端 | 今天没有客户端读 `etfSeries`；将来接入时用 `rescueCardPointsOf()`（已被 ② 锁住双编码） |
