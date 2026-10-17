# AUDIT-IMPL73：性能三项落地（门禁 / 筹码载荷 / 分时写放大）

- **实施时刻**：2026-10-17 21:20–21:40（Asia/Shanghai）。
- **基线**：`cf3f864`（v0.105.0，**800 用例 × 2 时区**，构建 73 项）。工作区开始时只有 `docs/REVIEW-9-PERF.md` 未跟踪。
- **范围**：只做 `docs/REVIEW-9-PERF.md` 的三项收益最大项（P1 门禁 / P2 筹码 / P3 分时归档与 LKG），
  外加 P1 里"若时间允许"的 `repoHygiene ④` 分词化。
- **纪律**：未 commit、未装依赖、未动 profile、**未重启 `dsh web`**、未手工写 `~/.dsh`。
  `npm run build` **只在 `/tmp/perf-check` 副本里跑**（工作区 `lib/` 未变）；工作区只跑 typecheck / test / selftest。
  实验数据目录 `/tmp/perf-*`、`/tmp/rv-perf/*`。
- **唯一越权项**（已获 Lead 授权）：`package.json` 的 `scripts.test` 两个参数（`NODE_COMPILE_CACHE`、`--test-concurrency=8`），
  其它字段未动；`build.mjs` 未动。

---

## 0. 结论摘要

| 项 | 改前（实测） | 改后（实测） | 变化 | 状态 |
|---|---|---|---|---|
| 门禁 `npm test`（2 时区） | **58.35 s** / user 105.00 s / sys 13.90 s（800×2） | **32.64–33.68 s（6 次：33.15 / 33.68 / 32.64 / 33.23 / 32.76 / 32.71，均值 33.03）** / user ≈52.3 s / sys ≈9.1 s（**812×2**） | **−25.3 s（−43%）**，CPU −50% | 实测 |
| `repoHygiene ④` 单例 | 1 688 ms | **68 ms** | **−1.62 s / 时区** | 实测 |
| 子进程启动（`lock.child.ts`） | 167 ms | 71 ms | −58% | 实测 |
| `/chips` 回包（0.000636） | 131 234 B | **44 744 B** | −65.9% | 实测 |
| `/chips` 回包（1.603668，242 档满配） | 166 134 B | **84 268 B** | −49.3% | 实测 |
| `/chips` p50 / CPU（0.000636，N=100） | 3.58 ms / 4.95 ms | **2.47 ms / 3.40 ms** | p50 −31%，CPU −31% | 实测 |
| `chipSeriesOf(180 天窗/45 展示/242 档)` | 3.673 ms | **0.751 ms** | **−80%** | 实测 |
| `/trend` 12 次（时钟 +5s/次）写盘字节 | 176 768 B | **104 B** | −99.9% | 实测（`/proc/self/io`） |
| `/trend` p50 / CPU | 1.449 ms / 1.668 ms | **0.666 ms / 0.798 ms** | p50 −54% | 实测 |
| `trends-lkg.json` 更新 | **自 v0.91.0 起从未更新**（真 bug，见 §3.3） | 内容变化时写（≤1 次/5 s），内容未变不写 | 修复 | 实测 |

**门禁两轮全绿**：`npm run check` 在 `/tmp/perf-check` 副本上跑两轮，均 exit 0；构建 **73 项通过**（`check1 45.84 s`、`check2 42.34 s`，含 typecheck + 2×test + selftest + build）。

---

## 1. P1：门禁 58.35 s → 32.6–33.7 s

### 1.1 改动（一行，两个参数）

`package.json:41`：

```json
"test": "NODE_COMPILE_CACHE=node_modules/.cache/node-compile node --test --experimental-strip-types --test-concurrency=8 \"src/**/*.test.ts\" && TZ=UTC NODE_COMPILE_CACHE=node_modules/.cache/node-compile node --test --experimental-strip-types --test-concurrency=8 \"src/**/*.test.ts\""
```

- `NODE_COMPILE_CACHE=node_modules/.cache/node-compile`：编译缓存目录放在已被 `.gitignore` 忽略的 `node_modules/` 下
  ⇒ **不新增忽略规则、不产生工作区脏文件**。实测子进程启动 167 ms → **71 ms**、单时区用户态 CPU **53.4 s → 25.5 s**。
- `--test-concurrency=8`：本机 4 核。**稳定性证据**：本批 5 次 `npm test`（每次 2 时区）+ 2 次 `npm run check`（每次 2 时区）
  = **14 个时区轮次全绿**（812×2 用例，0 fail）；改前同机同负载单时区 23.1 s，改后 16–18 s。
  Lead 的"只验证到 n=2 就先设 4"的顾虑：本批实际验证到 **n=14 轮**（含 `npm run check` 全链路），故保留 8；
  更慢的 CI 若出现抖动，回退 4 只损失约 2 s/时区（实测 23.1 → 21.0 s），断言不受影响。

> `npm run check` 从改前 `58.35 + typecheck + selftest + build` 降到 **42–46 s**。

### 1.2 `repoHygiene ④`：14.7 万次全文正则 → 一遍分词

`src/repoHygiene.test.ts:64` 新增 `TOKEN_INDEX`（对 121 个非测试源文件 = 1.75 MB 做**一遍** `/[A-Za-z_$][\w$]*/g` 计数），
`referenceCounts`（`src/repoHygiene.test.ts:90`）改为 O(1) 查表。

- 口径等价性**逐条实测**：1264 个导出名，新旧算法 `{own, external, inTests}` **0 差异**（`/tmp/rv-perf/verify_tokens.mjs`）。
- 唯一差异点是模板字符串 `` `ma${x}` ``（`$` 不属于标识符，但 `[\w$]` 会吞）⇒ 扫描前 `text.replaceAll('${', ' ${')`，
  只影响分词、不改原文；该差异正是验证脚本发现的唯一一处（`src/client/kline.tsx` 的 `` `ma${ser.period}` ``），已覆盖。
- 实测：**1 688 ms → 68 ms**（−96%），判据与反例注入原样保留。

### 1.3 断言强度

- 用例数 **800 → 812（+12）**，`npm test` 两时区各 812 pass / 0 fail；没有删除或跳过任何用例。
- 反例注入（原有）全部保留：`assertStrength`（弱断言扫描）通过、`repoHygiene ①②③⑤⑥` 通过、`lock/klineLock/rescuePersist` 跨进程用例通过。
- 新增用例见 §2.3 / §3.4。

---

## 2. P2：`/chips` 轴只发一份 + 非展示日不算统计量

### 2.1 改动

| 位置 | 改动 |
|---|---|
| `src/host/chips.ts:250` | `ChipSeries` 新增顶层 `centers: number[]`（**整段序列一份**）；`ChipDay.centers` 改为**可选**（只为老宿主回包在客户端能读） |
| `src/host/chips.ts:617` | 主返回只 `round` **一次**轴：`centers: centers.map((c) => round(c, 4))` |
| `src/host/chips.ts:584` | `__chipStatsDays += 1` 挪到 `if (i < win.length - display) continue` **之后**：非展示日只跑 `hist` 递推（`minFactor`/`peakSum`/`clamped` 口径仍全窗统计），不再算 `total/norm/avg/support/resistance/profitRatio` |
| `src/host/chips.ts:498` | 无分布（不支持复权/样本不足/区间为 0）⇒ `centers: []` + 既有 `why` 原因（不编档位） |
| `src/client/api.ts:10,31` | DTO：`ChipDayDto.centers` 可选、`ChipsPayload.centers?` 顶层新增 |
| `src/client/ChipsPanel.tsx:78` | 读 `day.centers ?? d.centers ?? []`；长度与 `buckets` 不一致（宿主与客户端版本混装）⇒ 如实显示"轴缺失，刷新页面"，不硬画 |
| `src/host/chips.test.ts` / `chips.adaptive.test.ts` | 3 处 `d.centers[i]` → 顶层 `r.centers[i]`；新增一条"逐日不许再带 centers"的断言 |

### 2.2 改前 / 改后（同机、同负载、真实缓存 + 桩上游）

```
# 回包字节（route 级，real cache）
0.000636   131 234 B →  44 744 B  （−65.9%）
1.603668   166 134 B →  84 268 B  （−49.3%）   ← REVIEW-9-PERF 的 "166 → 84 KB" 目标达成

# 路由延迟（N=100）
chips 0.000636  p50 3.58 → 2.47 ms   CPU 4.95 → 3.40 ms   bytes 131 234 → 44 744
chips 1.603668  p50 (改后) 2.04 ms   CPU 3.19 ms          bytes 84 268

# 纯计算（真实 805 根日线、242 档、40 次均值）
window=180 display=45   3.673 → 0.751 ms（−80%）
window=180 display=1    1.408 → 0.695 ms
window=360 display=45   4.708 → 2.338 ms
window=60  display=45   0.544 → 0.478 ms
```

> 为什么降幅比预估的 −2.0 ms 更大：旧实现**每个展示日**都 `centers.map(c => round(c, 4))`
> （44 × 242 = 10 646 次 `Math.round(x*1e4)/1e4`），这才是"每展示日 52 µs"的大头；轴提到顶层后这部分直接消失。

### 2.3 断言与反例注入

新文件 `src/host/chipsPayload.test.ts`（5 例）：

| 用例 | 判据 |
|---|---|
| ① 轴只发一份 | `"centers":` 在回包 JSON 里**恰好 1 次**；逐日 `'centers' in day === false`；顶层轴 == `bucketCenters(low, high, 档数)`（4 位小数逐项相等）；单调递增。**注入**：把轴逐日拷回去 ⇒ `assertSingleAxis` 必败（同一条判据） |
| ② 体积 | 轴本身 ≤ 4 KB；回包 < `CHIPS_PAYLOAD_MAX_BYTES`；逐日重复的形状至少多 60 KB 且 ≥1.5× |
| ③ 跨市场 | A股/港股（`isHk`）/指数（`fqSupported:false`）都拿到**同一份轴**；无分布 ⇒ `centers: []` + `why` 含"前复权" |
| ④ 统计天数 | `window=180/display=45` ⇒ `__chipStatsDaysOf() === 45`（旧写法 180） |
| ⑤ 线性成本 | `display=1/12/45` ⇒ 统计天数分别恰好 1/12/45 |

**注入实测**（`/tmp/perf-inject` 副本，见 §4）：

```
A) 逐日重复 centers      ⇒ ① ② ③ 全红（3 fail）
B) 统计量算回非展示日    ⇒ ④ ⑤ 全红（2 fail，④ 实测计数 180）
```

### 2.4 兼容性 / 风险

- **老宿主 + 新客户端**：`day.centers ?? payload.centers` ⇒ 仍可渲染。
- **新宿主 + 旧客户端**（浏览器未刷新）：旧客户端读 `day.centers` 会得到 `undefined` ⇒ 需要刷新一次页面（插件热重载场景可接受）。
- **混合版本**（宿主/客户端不同步）：新客户端显示"轴缺失 ⇒ 刷新页面"，不画假轴、不编数字。

---

## 3. P3：`/trend` 写放大

### 3.1 归档（`trends/<secid>/<day>.json`）

| 位置 | 改动 |
|---|---|
| `src/host/trendArchive.ts:241` | 逐 (secid, 日期) 记录**上次本进程写成功的内容指纹**（指纹 = `entry.points`，**不含 `updatedAt`**）；指纹相同 **且文件仍存在**（1 次 `stat`）⇒ 跳过：不 mkdir、不 readdir、不写盘 |
| `src/host/trendArchive.ts:256` | 目录清单**每轮只读一次**（`readDayNames`），体积检查与滚动清理共用 |
| `src/host/trendArchive.ts:276` | 只有"确实多出来"的日期文件才 `prune`（不再每轮无条件 readdir）；`prune` 复用已读到的 names |
| `src/shared/fingerprint.ts` | `payloadFingerprint` 下沉到 shared（`em.ts` 与 `trendArchive.ts` 共用，避免 `em ⇄ trendArchive` 循环 import）；`em.ts` re-export 保持既有 import 路径 |
| `src/host/trendArchive.ts:178` | 测试钩子 `__trendArchiveStatsOf / __resetTrendArchiveStats`（calls / dirreadCalls / pruneCalls / writes / skippedSame / bytesWritten） |

**改前 / 改后**（`/proc/self/io` 的 `wchar`，12 次 `/trend`，时钟每次 +5 s）：

```
改前：writtenBytes 176 768  ⇒ 14 731 B/次（每次调用都整份重写当天归档）
改后：writtenBytes     104  ⇒      9 B/次（首次写一次，之后内容未变 ⇒ 零写）
路由：/trend p50 1.449 → 0.666 ms，CPU 1.668 → 0.798 ms（N=100）
目录读：写的那一轮 1 次 readdir；零写入那轮 0 次
```

### 3.2 `trends-lkg.json`：指纹排除 `ts` + **修掉两个顺序 bug**

| 位置 | 改动 |
|---|---|
| `src/host/em.ts:1348` | `trimTrendPayload` 新增 `stableText`（只有 `entries`，**不含 `ts`**），`text` 仍含 `ts`（这份文件"什么时候写的"要能对账） |
| `src/host/em.ts:1452` | `persistTrendLkg` 用 `trendLkgPersistStep`（`em.ts:1415`）做**状态迁移**：判定用改动前的 `dirty`/`lastWrite`；写成功才推进 `lastWrite`、记指纹 |
| `src/host/em.ts:1415` | 纯函数：**节流跳过 ⇒ 保留 dirty**（下一轮重试）；**内容未变 ⇒ 清 dirty**；**写成功 ⇒ 清 dirty + 推进 lastWrite + 记指纹** |

**发现的真 bug（v0.91.0 起，本批修掉）**：`persistTrendLkg` 在判定之前做了两件事 ——
① `trendLkgDirty = false` 后才把该值传给 `trendWriteDecision`；② `trendLkgLastWrite = now` 后才让判定算 `now - lastWrite < 5000`。
两个都会让判定永远返回"跳过"，且**不报错、不写日志** ⇒ 这份兜底文件自 v0.91.0 起**没有更新过**
（本机 `~/.dsh/dsh-tradewatcher/trends-lkg.json` 停在 10-16 10:03，`mtime` 与 v0.91.0 发版时间一致）。
实测：新 home 里跑 4 次成功取数，**文件从未生成**；修后第一次取数即落盘。

### 3.3 改前 / 改后（LKG）

```
改前（repo-pin, cf3f864）：一次成功取数后 trends-lkg.json 不存在（永不落盘）
改后（工作区）：同一次取数后文件存在，entries[0].key = '1.600519|1'；内容未变时不再重写
```

### 3.4 断言与反例注入

| 文件 | 用例 | 判据 |
|---|---|---|
| `src/host/trendArchiveCost.test.ts`（4 例） | ① 内容未变 ⇒ 零写入 + 零 readdir | `writes`/`dirreadCalls` 不增；**文件 mtime 不变**（证明真的没重写）；`skippedSame=5` |
| | ② 内容变了 ⇒ 恰好写一次 | `writes+1`、`dirreadCalls+1`；5 日档目录读仍只有 1 次 |
| | ③ 滚动清理按需 | 未超配额 ⇒ `pruneCalls=0`；第 4 个文件 ⇒ 1 次；零写入那轮不再清理 |
| | ④ 反例注入 | 指纹含 `updatedAt` ⇒ 每次都变（同一条判据必败的形状） |
| `src/host/trendLkgHygiene.test.ts`（+2 例） | ③ 指纹文本不含 `ts` | `stableText` 跨 `Date.now` 逐字节稳定；注入回 `text` ⇒ 第二轮仍要写（修前行为） |
| | ④ 状态迁移 | 节流跳过**保留 dirty**；内容未变清 dirty；**先推进 lastWrite ⇒ 必败**（v0.91.0 的形状） |
| `src/host/trendLkgPersist.test.ts`（1 例） | 端到端落盘 | 一次成功取数（注入上游）⇒ `trends-lkg.json` 必须存在且 `entries[0].key='1.600519|1'`（**纯函数测不到调用方顺序，这条才锁得住**） |

**注入实测**（`/tmp/perf-inject`，见 §4）：

```
C) 归档指纹改用带 updatedAt 的载荷 ⇒ trendArchiveCost ① ③ 红（2 fail）
D) 复现 v0.91.0 顺序 bug（dirty:false + lastWrite:now）⇒ trendLkgPersist 红（1 fail）
```

---

## 4. 注入证据（副本 `/tmp/perf-inject`，每次注入后从 pristine 恢复）

| 注入 | 结果 |
|---|---|
| A 逐日重复 `centers` | `chipsPayload` ① ② ③ **红** |
| B 统计量算回非展示日（`continue` 移到 stats 之后） | `chipsPayload` ④ ⑤ **红**（④ 计数 = 180） |
| C 归档指纹含 `updatedAt` | `trendArchiveCost` ① ③ **红** |
| D v0.91.0 顺序 bug（`dirty:false` + `lastWrite:now`） | `trendLkgPersist` **红** |

> 注入副本用 `rsync` 复制工作区（排除 `node_modules`/`lib`/`.git`），`node_modules` 用符号链接；注入→跑用例→恢复，
> 工作区源码不受影响。命令见 §7。

---

## 5. 门禁与构建验证

```
# 最终树（含全部改动）的 npm run check，两轮，均在 /tmp 副本里跑（工作区 lib/ 未动）
$ cd /tmp/perf-check2 && npm run check
finalcheck1 WALL 49.03 s  USER 76.60 s  SYS 12.17 s   → exit 0（与注入实验并发，偏高）
finalcheck2 WALL 42.26 s  USER 61.65 s  SYS 9.82 s    → exit 0
built lib/index.js + lib/client.js（v0.105.0，客户端片段校验通过：73 项）
（同一批改动早前在 /tmp/perf-check 也跑过两轮：45.84 s / 42.34 s，同样 exit 0 + 73 项）

$ npm test                                   # 工作区，6 次
gate1 33.15 s USER 53.41 SYS 9.32 MAXRSS 160484 KB   ℹ tests 812 / pass 812 / fail 0（×2 时区）
gate2 33.68 s USER 52.25 SYS 9.10 MAXRSS 138004 KB
gate3 32.64 s USER 51.42 SYS 9.20 MAXRSS 138096 KB
gate4 33.23 s USER 51.44 SYS 9.00 MAXRSS 137336 KB
gate5 32.76 s USER 52.77 SYS 8.98 MAXRSS 139568 KB
gate6 32.71 s USER 51.64 SYS 8.98（最终树 + typecheck 通过后的收口轮）
```

- 用例数：**800 → 812**（`chipsPayload` 5 + `trendArchiveCost` 4 + `trendLkgHygiene` 2 + `trendLkgPersist` 1）。
- 两时区均 0 fail；`assertStrength` / `repoHygiene` / 跨进程锁用例全绿。
- 工作区 `lib/` 未被改动（构建只在 `/tmp/perf-check` 内发生）。

---

## 6. 未做项与理由

| 项 | 为什么没做 |
|---|---|
| 退避可注入（`em.ts:166` / `em.ts:2617`，估 5–8 s/时区） | 需要改**生产取数层的计时语义**（把重试退避常数变成可注入），风险中；而 33 s 已达成 ≤35 s 目标，收益不足以抵风险。留作下一批（配方已写在 REVIEW-9-PERF §1.4） |
| `lock.test.ts` L10 四文件并行 / L5 缩窗口（估 3–5 s/时区） | 同上：需要重排用例的时序假设，需单独回归一批；本批已达标 |
| 护盘快照丢空字段（−33 KB/次） | 属 P2 清单之外的第二梯队（LEAD 只点了三项），且要改 `etfSeries` 的消费端；配方在 REVIEW-9-PERF §4 |
| `trends-lkg` 整份重写的**体量**（2.34 MB/次） | 本批只修了"该不该写"（闸）与两个顺序 bug；**减少单次写体量**需要改存储格式（按 secid 分片 / NDJSON 追加），超出本批范围。当前行为：内容变化时 ≤1 次/5 s |
| `/kline` 的 `pct:null`、`/trend` 的 `label` 瘦身 | 二级可选裁剪（12% / 25%），涉及客户端解析，不在三项内 |

---

## 7. 复现命令

```bash
# 门禁（改前基线在 cf3f864 / 800 用例）
/usr/bin/time -f 'WALL %e USER %U SYS %S' npm test

# 单文件 / 单用例
node --test --experimental-strip-types src/host/chipsPayload.test.ts
node --test --experimental-strip-types src/host/trendArchiveCost.test.ts
node --test --experimental-strip-types src/host/trendLkgPersist.test.ts
node --test --experimental-strip-types src/repoHygiene.test.ts

# 注入副本
rsync -a --exclude node_modules --exclude lib --exclude .git /path/to/repo/ /tmp/perf-inject/
ln -s /path/to/repo/node_modules /tmp/perf-inject/node_modules
#   注入后：node --test --experimental-strip-types <被注入的用例>
```

---

## 8. 风险登记

| 风险 | 缓解 |
|---|---|
| `--test-concurrency=8` 在更慢的 CI 上抖动 | 已在本机验证 14 个时区轮次全绿；回退到 4 只损失 ~2 s/时区（实测 23.1 → 21.0 s），断言无关 |
| `NODE_COMPILE_CACHE` 依赖 Node 版本（实测 v24.16.0） | 缓存目录在 `node_modules/.cache/`（已忽略）；无效时自动退化，只是不变快 |
| 新宿主 + 旧客户端读不到逐日 `centers` | 客户端已写 `day.centers ?? payload.centers`；插件热重载后刷新一次即可；混合版本有"轴缺失"提示，不画假图 |
| 归档"内容未变就跳过"依赖"文件仍在" | 跳过前做 1 次 `stat`；被外部删掉会补写；跨重启内存表为空 ⇒ 首次必写 |
| `trends-lkg` 修复后开始真正写盘（此前从没写过） | 单次 2.34 MB、≤1 次/5 s 且内容未变不写；后续可做分片/追加（见 §6） |
| `payloadFingerprint` 下沉到 `shared/` | `em.ts` 保留 re-export，既有 import 不变；无循环依赖（`em → trendArchive → shared/fingerprint`） |
