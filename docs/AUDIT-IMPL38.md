# AUDIT-IMPL38 —— 修丢数据：缓存被判"需要回源"时不再整段丢弃（用可用历史 + 如实标注）

- 基线：`main` @ `d6f4cb5`（v0.62.0），`npm run check` = 414 × 2 全绿
- 本轮结果：**421 × 2 全绿**（+7 条断言：`em.test.ts` +5、`chips.test.ts` +2）
- `build.mjs` **零改动**（73 项片段校验通过）；未装 bundle / 未动 profile / 未 commit / 未重启
- 契约字段（`missing` / `why` / `stale` / `asOf`）**名字与含义都没动**；只加了**一个可选字段** `staleReason`（见 §4）

---

## 1. 事实复现（含命令）

```
$ python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.dsh/dsh-tradewatcher/klines/1.560010_101_1.json'),encoding='utf-8'));print(d['v'],d['partial'],len(d['bars']),d['bars'][0]['date'],d['bars'][-1]['date'])"
3 True 801 2023-06-19 2026-10-12
```

- **缓存确实在盘上**：`v=3`、`partial=true`、**801 根**（2023-06-19 ~ 2026-10-12）、`updatedAt` 距今 41.6 分钟（**远超 60s TTL**）。
- 老实现的行为链：`loadKlineCache` 读到 `partial && 超 TTL` ⇒ `klineCacheUsable().usable === false` ⇒ `continue`（**整段丢弃**）⇒
  `entry.bars = []` ⇒ `needFull = true` ⇒ 回源 ⇒ 失败 ⇒ `if (!settled && stale && entry.bars.length === 0) return null`
  ⇒ `/kline` 回 **0 根** ⇒ `/chips` 的 `samples = 0` ⇒ 界面「样本不足（近 0 个交易日 < 10）」。
- 附带的那句 note 与事实不符：缓存**存在**，只是被判不可用。

**修后同一条命令链（真实缓存文件 + 把上游整段挡掉，`globalThis.fetch` 一律 reject）**：

```
$ cp ~/.dsh/dsh-tradewatcher/klines/1.560010_101_1.json /tmp/twreal/dsh-tradewatcher/klines/
$ DSH_HOME=/tmp/twreal node --experimental-strip-types -e "…fetchKline('1.560010',101,360,1) + chipSeriesOf…"
★ /kline 不再 0 根：days = 360  （真实缓存 801 根，丢了不可信的最后一根）
  stale = true   cached = false
  staleReason = 回源未取到新数据 ⇒ 改用本地缓存的 800 根已完成 bar；不可信的最后一根已丢弃
                （原因：未完成 bar 已超过 60s TTL ⇒ 回源重取；但文件里有 801 根，丢掉不可信的最后一根后
                 仍有 800 根 ≥ 10 ⇒ 降级采用（不回源成功也照用））
  末两根 = 2026-10-08@2.975 , 2026-10-09@2.982      ← 2026-10-12 那根盘中未完成 bar 已丢弃
  缓存状态 = {"exists":true,"fileBars":801,"usableBars":800,"refusedReason":"未完成 bar 已超过 60s TTL ⇒ 回源重取","degraded":true,"minBars":10}
★ /chips 样本数 = 360   （用户报的是 0）
  平均成本 = 3.0944  支撑/压力 = 2.9702 / 3.2231
```

## 2. 改动点

### `src/host/em.ts`

| 位置 | 改动 |
|---|---|
| `KLINE_MIN_USABLE_BARS = 10`（新增常量） | "够不够构成可用历史"的下限，注释写明与筹码的 `CHIPS_MIN_SAMPLES = 10` **同值**（两层阈值必须一致，否则互相甩锅） |
| `klineCacheAdoptionOf()`（新增**纯函数**） | 采纳判定：过闸门 ⇒ 原样用；被拒 ⇒ **丢掉最后一根**（未完成 bar / 旧 schema 下无法验证的那根），剩下 ≥ 10 根就**照用**并给出 `degradedReason`；丢完不足 10 根 ⇒ 不采用（如实报样本不足，**不硬凑**） |
| `KlineEntry` | 增 `fileBars` / `refusedReason` / `degradedReason` / `droppedLast` 四个记账字段（都是"这次实际用了什么"的事实） |
| `loadKlineCache()` | 由"被拒就 `continue`"改为**走上面的判定**：采用时 `entry.bars = dropLast ? bars.slice(0,-1) : bars`，并把 `partial` 跟着改成 `false`（丢掉未完成那根后，最后一根就是已完成的）；被拒且不可用时照旧打日志（含"文件里 N 根、可用 M 根 < 10"） |
| `klineCacheStatusOf()`（新增） | 读本次 `(secid, klt, fqt)` 的缓存状态（`exists/fileBars/usableBars/refusedReason/degraded/minBars`），供路由写原因文案 |
| `klineStaleNoteOf()`（新增**纯函数**） | 降级复用的那句说明：**只在"用了被拒缓存 且 回源没拿到新数据"时给**；定稿免回源、正常回源都不给（不制造噪音） |
| `fetchKline()` | 返回 `KlineData & { staleReason?: string }`；`staleReason` 只在上面的条件成立时出现。**返回 null 的唯一条件仍是"一根可用 bar 都没有"** |
| `klineMissingReason()` | 三情形拆开（见 §3 对照表）；`opts` 增 `cache?: KlineCacheStatus \| null`（注入而非内部读，保持纯可测） |

### `src/host/routes.ts`

`/kline` 在 `fetchKline` 之后读 `em.klineCacheStatusOf(secid, klt===104?103:klt, em.normalizeFq(secid, fqt))`
（键与 `fetchKline` 内部**一致**：年K 走 103 的缓存、复权口径过 `normalizeFq`）并注入 `klineMissingReason`。

### `src/host/chips.ts`

**未改**。它本来就是"喂什么算什么"：`fetchKline` 拿回 360 根 ⇒ `samples = 360`。改动点不在筹码，在取数层
（这也符合"症状在筹码、病灶在取数"的定位）。

## 3. note 文案对照（同一场景：有缓存但不可用 + 上游挂）

| 情形 | 修前 | 修后 |
|---|---|---|
| ① 从未有缓存 | `本地没有该周期的缓存，东财行情主机当前不可达…` | `本地**确实**没有该周期的缓存数据；东财行情主机当前不可达（熔断/限流），腾讯这次也没取到 —— …` |
| ② **有缓存但被判不可用** | `本地没有该周期的缓存，…`（**与事实不符**） | `本地**有**该周期的缓存，**但被判不可用**（未完成 bar 已超过 60s TTL ⇒ 回源重取；文件里 801 根）；东财行情主机当前不可达…` |
| ③ 回源重试失败 | 与 ② 混成一句 | ②里那半句是**事实**、③这半句是**原因**，两句同时给且可分辨；归因仍是 `transient`（等恢复）；可达但无数据时是另一句（`…都可达但没有返回…`，`no-source`） |

⚠ 旧的概括句 `本地没有该周期的缓存` **在 ②③ 里已被删除**（有一条断言专门守它：note 不许同时出现"没有该周期的缓存"与"被判不可用"）。

## 4. 新增字段 `staleReason`（**加法**，不动契约）

- 位置：`fetchKline` 的返回对象（类型写在本模块的交叉类型里，**没有改 `src/shared/model.ts`**）。
- 出现条件：**降级采纳 + 回源失败**；定稿免回源、正常回源都不出现。
- 例：`回源未取到新数据 ⇒ 改用本地缓存的 800 根已完成 bar；不可信的最后一根已丢弃（原因：…）`
- **客户端目前不读它**（`chartNote.ts` 对 `stale` 只给「· 上次成功数据（MM-DD HH:mm）」）。
  要在界面上显示这条具体原因，需要**客户端一行改动**（把 `staleReason` 拼进 stale 那句）；
  客户端不在本任务写作范围内 ⇒ host 侧字段与文案已就绪，等派单。

## 5. 断言与反例证据（+7 条）

### `src/host/em.test.ts`（+5，纯函数层）

1. **降级采纳①**：v3 + `partial` + 超 TTL + 300 根 ⇒ `adopt=true`、`dropLast=true`、`usableBars=299`、
   `refusedReason` 含 `TTL`、`degradedReason` 含"降级采用"；
   **反例注入**：本地写一个"老实现=被拒就整段丢弃"的 `{adopt:false, usableBars:0}` ⇒
   `assert.throws` 证明"必须采用"这条断言在反例上**必然失败**。
2. **降级采纳②**：5 根（丢 1 剩 4 < 10）⇒ `adopt=false`（**不硬凑**，对应断言③的极端情形）；
   `partial` 在 TTL 内 ⇒ 原样采用、一根不丢；`partial=false` 的旧缓存（1 天前）⇒ 不受 TTL 影响。
3. **降级采纳③**：v2（旧 schema）300 根 ⇒ 也走"丢最后一根后用其余"（**同一类丢数据**，见 §6）；
   9 根 ⇒ 不采用。
4. **降级说明**：降级+回源失败 ⇒ 有说明且含"299 / 已完成 bar / 未完成"；
   回源成功 ⇒ `null`（行为不变）；定稿 ⇒ `null`；非降级的普通 stale ⇒ `null`。
5. **note 三情形**：①`cache:null` ⇒ 含"确实没有"、不含"被判不可用"；②`refusedReason` ⇒ 含"本地有…被判不可用"+**具体原因**`60s TTL`，
   且**不含**"本地没有该周期的缓存"、**不含**"确实没有"；③含"东财行情主机当前不可达"且 `why==='transient'`；
   可达但无数据 ⇒ `why==='no-source'` + "都可达但没有返回"。

### `src/host/chips.test.ts`（+2，真实链路端到端）

6. **端到端（用户症状）**：临时 `DSH_HOME` + 真写一份 v3 缓存（40 根、`partial=true`、`updatedAt` 超 10 分钟）+
   **`globalThis.fetch` 一律 reject**（不碰网络）⇒ 调真 `fetchKline` ⇒ 断言 **不再是 null**、
   `stale===true`、`days.length===39`、`staleReason` 含"未完成"与"已完成 bar"、`klineCacheStatusOf().degraded===true`；
   再把 bar 喂给真 `chipSeriesOf` ⇒ **`samples >= 10`**（用户报的"样本不足"消失）。
7. **端到端（极端：根数不足）**：5 根 ⇒ `fetchKline` **如实返回 null**（不硬凑）、
   但 `klineCacheStatusOf().exists === true` ⇒ `klineMissingReason` 的 note 说"有缓存但被判不可用"，
   且**不含**那句与事实不符的"本地没有该周期的缓存"。

### 另一条**真实数据**证据（不在测试里，避免依赖用户数据目录）

见 §1 的命令与输出：用**用户盘上那份 801 根真实缓存** + 挡掉上游 ⇒ `/kline` 360 根、`stale=true`、
末根是 2026-10-09（10-12 那根未完成 bar 被丢）、`/chips` **samples=360**（原 0）、平均成本 3.0944。

## 6. 一个刻意扩展（请 lead 确认）

被拒的原因有两类，我都走了"降级采用（丢最后一根）"：
- **`partial` 超 TTL**（用户遇到的，任务明说要做）；
- **旧 schema `v≠3`**（我**主动扩展**）：老规则是"v2 及以前可能冻着未完成 bar ⇒ 一律不采用"，
  但那条规则同样会造成"盘上有 900 根、界面报样本不足"。我保留红线（**不与可能冻住的最后一根混用**）的做法是
  **丢掉最后一根、用其余**，而不是整段放弃。
  若你认为 v2 应当继续"一律不采用"，把那半个分支改回 `adopt:false` 即可（`klineCacheAdoptionOf` 里一处三行）——
  但那样"丢数据"这一类缺陷在 v2 上仍然存在。

## 7. 测试条数变化

| | 条数（每时区） |
|---|---|
| 基线 `d6f4cb5` | 414 |
| `em.test.ts` +5 | |
| `chips.test.ts` +2 | |
| 本轮之后 | **421** |

```
ℹ tests 421
ℹ pass 421
ℹ fail 0
```

（两次各 421：默认时区 + `TZ=UTC`；随后 `ALL HOST CHECKS PASSED (live probes soft)` 与
`built lib/index.js + lib/client.js （v0.62.0，客户端片段校验通过：73 项）`。）
改动文件：`src/host/{em.ts,em.test.ts,chips.test.ts,routes.ts}` + 本文件；
`build.mjs` / `package.json` / `cordis.patch.yml` **零改动**；未改 `src/client/**`、未改 `src/shared/model.ts`。

## 8. 未做项

1. **客户端不显示 `staleReason`**（§4）：host 侧已就绪，需要客户端一行（`chartNote.ts` 的 stale 分支）。
2. **`/chips` 自己的 `why` 文案未动**：它的 `样本不足（近 0 个交易日 < 10）` 在修后不再出现；本轮没给它加"数据来自降级缓存"的说明
   —— 若要，`chipSeriesOf` 的入参里加一个 `staleReason` 透传即可（属于另一处改动）。
3. **`em.ts` 里 `klineCacheUsable()` 的语义未改**（仍回答"要不要回源"），只是它的**调用方**不再把"要回源"当成"弃用整段"。
   这样 `task-77` 的三闸断言（版本/partial TTL）保持原样。
4. 未做真页面复核（GUI 需带鉴权 URL；且线上进程仍是旧版）。等发布后可用
   `curl '127.0.0.1:3080/tradewatcher/kline?secid=1.560010&klt=101&lmt=360' | jq '.kline.staleReason, (.kline.days|length)'` 复核。

---

# 追加（task-13）：客户端显示 `staleReason` —— 替换「上次成功数据」，不新增第二处文案

- 基线：`main` @ `46501b2`（v0.63.0），`npm run check` = 421 × 2 全绿
- 本轮结果：**423 × 2 全绿**（+2 条断言，`src/client/chartNote.test.ts`）
- ⚠ 时段说明：收尾这次 `npm run check` 时 HEAD 已前进到 `88e5bd3`（v0.63.1，另一批的"插件命名"改动，与本轮无关）；
  当时工作区**只剩我这 3 个文件**（`chartNote.ts` / `chartNote.test.ts` / 本文件）⇒ 我的 diff 是隔离的，检查全绿。
- `build.mjs` 零改动（73 项）；未 commit / 未装 bundle / 未动 profile / 未重启；**未改 `src/shared/model.ts`**（见 §T2）

## T1. 改动点

| 文件 | 改动 |
|---|---|
| `src/client/chartNote.ts` | ① `NoteKlineLike` 增 `staleReason?: string`；② 新增 `staleReasonOf(payload)`（只有 K 线档取这个字段，空串/空白不算）；③ 新增 `staleVisibleOf(reason)`（取宿主那句的**首段** = 第一个全角括号之前）；④ `lastSuccessNote()`：有 `staleReason` ⇒ ` · <首段>`，没有 ⇒ **原样不动**（含日期/短形两条老路径） |
| `src/client/chartCache.ts` | **未改** —— payload 本来就是 `{ kind:'kline', tab, kline }`（`chartCache.ts:82`）直接把宿主回包塞进去，`staleReason` 天然透传（`api.kline()` 也是 `return request(...)` 原样返回） |

**为什么可见句取"首段"而不是整句**：宿主那句完整长 **128 字**（内含二级细节：TTL 数值、文件根数、采纳下限），
常驻脚注一行放不下、也违背"减少常驻提示"。括号里的细节**没有丢**：完整原文仍在 payload
（`kline.staleReason`）里，agent/接口照样读得到。若你要整句显示，把 `staleVisibleOf` 改成 `return reason` 即可（一行）。

## T2. 类型没有动 `shared/model.ts`

`KlineData`（`src/shared/model.ts`）仍未声明 `staleReason` —— 本轮只把可选字段声明在
`chartNote.ts` 的 `NoteKlineLike`（客户端消费侧的视图类型）上。理由：`NoteKlineLike` 只要求自身字段，
宿主回包多一个字段在运行时可见、在 TS 里因结构兼容而可读 ⇒ **不必为此改契约文件**。
（若你希望把它提升为正式契约字段，那是 `shared/model.ts` 一行 —— 但会牵动 8 个消费者，建议单开。）

## T3. 断言与反例（`src/client/chartNote.test.ts` +2）

1. **有 `staleReason` ⇒ 用它**：断言 `lastSuccessNote()` 等于 ` · ` + `staleVisibleOf(真实原因)`；
   **不再含**「上次成功数据」；含"回源未取到新数据 / 已完成 bar / 最后一根"三个要点；
   **常驻一行**（派生句 ≤ 80 字）；payload 里的**完整原文保持原样**（长解释不丢）；
   **不出现**「降级缓存」这类客户端新增解释词。无 `staleReason` ⇒ 与以前逐字一致（` · 上次成功数据（10-09）` / ` · 上次成功数据`）。
   分时档不取该字段（本轮不动分时）。
2. **反例注入**：本地写一个"忽略 `staleReason`、永远给通用句"的假实现 ⇒ 它与真实现**不同** ⇒
   `assert.throws` 证明"必须用具体原因"这条断言在反例上**必然失败**；并补一条兜底断言，确认真实现读的**就是** payload 里那个字段
   （`staleReason: '甲（乙）'` ⇒ ` · 甲`，即按第一个全角括号截断）。
3. 一处**故意放宽**的断言（避免锁死宿主措辞）：只断言"提到了最后一根的处理"（`/最后一根/`），不锁
   `不可信的最后一根已丢弃` 这句原文 —— 那句话属于宿主，措辞微调不该让客户端测试变红。

## T4. 两种情形各一句实际文案（**用真实缓存 + 挡掉上游**跑出来的）

（**v0.64.1：lead 决定把那处词改成「未完成的最后一根已丢弃」**，下面两段为改词后的实测文案。）

```
宿主整句（128 字，留在 payload `kline.staleReason` 里）：
  回源未取到新数据 ⇒ 改用本地缓存的 800 根已完成 bar；未完成的最后一根已丢弃（原因：未完成 bar 已超过 60s TTL ⇒ 回源重取；但文件里有 801 根，丢掉不可信的最后一根后仍有 800 根 ≥ 10 ⇒ 降级采用（不回源成功也照用））

① 有 staleReason ⇒ 客户端**实际渲染**（46 字，一行 = 宿主那句的第一段）：
  · 回源未取到新数据 ⇒ 改用本地缓存的 800 根已完成 bar；未完成的最后一根已丢弃
  （`visibleProvenanceOf` 判定为"要显示"⇒ 不会被过滤掉）

② 没有 staleReason（同一份数据）⇒ 与改动前逐字一致：
  · 上次成功数据（10-09）
```

**为什么改这处词**：可见句是被**截断的首段**，而"不可信"在首段里太含糊、"未完成"才点明是**盘中未完成 bar**
（用户报的正是这种缓存）。改完"未完成"在可见句里出现，且既有断言（e2e 查 `staleReason` 含"未完成"+"已完成 bar"）仍然满足。

**保留未改的一处**：`klineCacheAdoptionOf` 的 `degradedReason` 里那句"丢掉**不可信**的最后一根后仍有 M 根"（在括号内的二级细节里）
**故意保留**"不可信" —— 它同时覆盖 `v≠3` 那条路径（那根 bar 未必"未完成"，只是无法确认），用中性词更准。
若你要两处统一成"未完成"，改 `em.ts:1531` 一处词即可。

## T5. 测试条数变化（含追加）

| | 条数（每时区） |
|---|---|
| task-11 之后（v0.63.0） | 421 |
| `chartNote.test.ts` +2 | |
| **本轮之后** | **423** |

```
ℹ tests 423
ℹ pass 423
ℹ fail 0
```

（两次各 423；随后 `ALL HOST CHECKS PASSED (live probes soft)` 与
`built lib/index.js + lib/client.js （v0.63.1，客户端片段校验通过：73 项）`。）
本轮改动文件：`src/client/chartNote.ts`、`src/client/chartNote.test.ts` + 本文件。

## T6. 改词（v0.64.1）

`src/host/em.ts` 的 `klineStaleNoteOf()` 里一处词：`不可信的最后一根已丢弃` → **`未完成的最后一根已丢弃`**（lead 决定）。
改后实测（真缓存 + 挡掉上游）：

| 层 | 文案 | 字数 |
|---|---|---|
| 宿主整句（`kline.staleReason`） | `回源未取到新数据 ⇒ 改用本地缓存的 800 根已完成 bar；未完成的最后一根已丢弃（原因：未完成 bar 已超过 60s TTL ⇒ 回源重取；但文件里有 801 根，丢掉不可信的最后一根后仍有 800 根 ≥ 10 ⇒ 降级采用（不回源成功也照用））` | 128 |
| 客户端可见（第一段） | `· 回源未取到新数据 ⇒ 改用本地缓存的 800 根已完成 bar；未完成的最后一根已丢弃` | 46 |

既有断言全部仍然成立（`chips.test.ts` 的 e2e 查 `staleReason` 含"未完成"+"已完成 bar"；客户端测试只查 `/最后一根/`，不锁宿主措辞）。

## T7. 未做项（与 task 要求一致）

1. **筹码侧透传本轮不做**（`chipSeriesOf` / `ChipsPanel` 的降级说明）：按任务要求"等另开"；`/chips` 现在修好后不再出现"样本不足"，
   但它**不说**"数据来自降级缓存"—— 要说得在 `chipSeriesOf` 入参加一个透传字段。
2. **不做第二处文案**：`title`/`aria-label` 也没新增（这一句本身就是可见脚注；长解释留在 payload，未上界面）。
3. 未做真页面复核：线上进程仍是旧版；发布后可用
   `curl '…/tradewatcher/kline?secid=1.560010&klt=101&lmt=360' | jq '.kline.staleReason'` 看宿主那句，
   页面上应显示它的首段。
