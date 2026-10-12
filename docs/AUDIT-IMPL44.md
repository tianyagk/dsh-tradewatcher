# AUDIT-IMPL44 —— 国际指数兜底源红线修复：新浪 `int_*` 陈旧快照整族停用

- 触发：Lead 探测到"红线级错数"（`src/host/sina.ts` 把 `100.SPX → int_sp500`、`100.DJI → int_dji` 当兜底）
- 写入面：`src/host/sina.ts`、`src/host/tencent.ts`、`src/host/em.ts`、`src/host/selftest.ts` ＋ 新测试 `src/host/sinaIndex.test.ts`
- 纪律：不 commit、不装 bundle、不动 profile、不重启服务；**我的所有实验与脚本一律 `DSH_HOME=/tmp/impl44/*`**
- 门禁：`npm run check` **EXIT=0，494/494 × 2 时区 + selftest + build（v0.70.0）**（末尾三行见 §6）

---

## 1. 错值与正确值对照（全部本人实测，命令可复跑）

复现命令（GBK 需按 GBK 解码；curl 直接管道 iconv 在本机会静默丢字符，用 python 复算最稳）：

```bash
# 腾讯（正确值 + 自带行情时间戳）
python3 - <<'P'
import urllib.request
H={'User-Agent':'Mozilla/5.0','Referer':'https://gu.qq.com/'}
print(urllib.request.urlopen(urllib.request.Request('https://qt.gtimg.cn/q=us.INX,us.DJI,us.NDX,hkHSI', headers=H), timeout=15).read().decode('gbk','replace'))
P
# 新浪 int_*（陈旧快照，无时间戳）
python3 - <<'P'
import urllib.request
H={'User-Agent':'Mozilla/5.0','Referer':'https://finance.sina.com.cn/'}
for s in ['int_sp500','int_dji','int_nasdaq']:
    print(urllib.request.urlopen(urllib.request.Request('https://hq.sinajs.cn/list='+s, headers=H), timeout=15).read().decode('gbk','replace').strip())
P
# 腾讯"符号是否存在"：usSPX / us.SPX 必须都是 pv_none_match
curl -s 'https://qt.gtimg.cn/q=usSPX,us.SPX' -H 'Referer: https://gu.qq.com/'
```

| 标的（EM secid） | 旧兜底（新浪 `int_*`） | 新兜底（腾讯） | 偏差 |
|---|---|---|---|
| `100.SPX` 标普 500 | `int_sp500` = **6643.70** | `us.INX` = **7811.54**（`f[30]` = 2026-10-09 17:29:56） | 旧值低 **15.0%**（7811.54/6643.70 = 1.176 ⇒ 反向差 17.6%） |
| `100.DJI` 道指 | `int_dji` = **46247.29** | `us.DJI` = **51654.95**（2026-10-09 16:37:50） | 旧值低 **10.5%**（1.117） |
| `100.NDX` 纳指 100 | `int_nasdaq` = **22484.07** | `us.NDX` = **30883.15**（2026-10-09 17:15:59） | 旧值低 **27.2%**（1.374）⚠ 最大偏差 |
| `100.HSI` 恒生 | `int_hangseng` = 24271.20 | `hkHSI` = **24271.200**（2026/10/12 18:31:14） | 本次巧合一致，但同族同样**无时间戳** ⇒ 一并停用 |

**符号存在性实测**：`us.INX`/`us.DJI`/`us.NDX`/`hkHSI` 有值；**`usSPX` = `pv_none_match`、`us.SPX` = `pv_none_match`**（Lead 的提醒得到证实：标普 500 只能写 `us.INX`）；日经/富时/德国/韩国/斯托克 50 逐个试过 `us.NIKKEI`/`jp.NI225`/`uk.FTSE100`/`de.DAX`/`us.SX5E`/`us.KOSPI` 全是 `pv_none_match`。

**K 线侧实测**：`web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=us.INX,day,,,10,qfq` 返回 `data['us.INX'].day`（**没有 `qfqday`**）⇒ 指数没有除权除息，`day` 与 `qfqday` 是同一份序列；`mkline`（5 分钟线）对 `us.INX` 返回 `{"code":-1,"msg":"param error"}` ⇒ 五日分时那条链**不能**接国际指数（会白打一次请求），因此单列一张表。

**现网落盘错值（只读核对用户的 `~/.dsh/dsh-tradewatcher/quotes-lkg.json`）**：`100.SPX = 6643.7 / source=sina`、`100.NDX = 22484.07 / source=sina`、`100.FTSE/GDAXI/N225/HSI` 同样 `source=sina` ⇒ 与 Lead 的判断一致，错值确实已落盘。

---

## 2. 改动点（文件:行号）

| # | 改动 | 位置 |
|---|---|---|
| ① | **国际指数整族移出新浪映射表**（`SINA_SYMBOL` 里不再有 `100.*`），并写明实测证据 | `sina.ts:27-40`（表头注释）、`sina.ts:52-62`（表） |
| ② | **解析层也堵死**：`parseSinaHq` 删除 `int_*` 分支 ⇒ 即便有人手工塞 `int_*` payload 也解析不出行情 | `sina.ts:92-116` |
| ③ | 新增 `tencentIndexCode()`（`100.SPX→us.INX`、`100.DJI→us.DJI`、`100.NDX→us.NDX`、`100.HSI→hkHSI`）与 `tencentQuoteCode()`（沪深港 ＋ 国际指数） | `tencent.ts:15-53` |
| ④ | 快照批量行情、日线走 `tencentQuoteCode` | `tencent.ts:104`、`tencent.ts:168` |
| ⑤ | **index 过滤必须用 `tencentQuoteCode`**：`tencentQuoteRows` 原先用只认沪深港的 `tencentCode` 过滤，会在请求前把国际指数丢掉（实测改了映射仍然取不到值 —— 见 §4 的"第一次真数据验证失败"） | `em.ts:666-668` |
| ⑥ | `hasQuoteFallback` 用 `tencentQuoteCode`（国际指数现在**有**兜底；日经/富时/德国如实没有） | `em.ts:1371` |
| ⑦ | K 线：`tencentSymbol` 接国际指数；`requestKlineFromTencent` 对 `100.*` 允许取不带复权前缀的 `${period}` 键（指数无除权除息，不算混口径） | `em.ts:1947`、`em.ts:1969-1972` |
| ⑧ | **落盘错值的处置**：`RETIRED_INDEX_FALLBACK`（7 个标的）＋ `retiredIndexRowReason()`；`loadLastGood()` 载入时按内容特征作废并留痕；`persistLastGood()` 写 `v:2` ＋ `purged[]` | `em.ts:224-260`、`em.ts:266-300`、`em.ts:308-330` |
| ⑨ | 自检断言改写（新浪专供 15→8、可用兜底 22→18、新增腾讯代码与"int_* 被忽略"断言） | `selftest.ts:505-535` |

---

## 3. 落盘错值的处置（"不许静默沿用"的落地）

**规则（内容特征判定，而非版本号一刀切）**：`100.SPX / 100.DJI / 100.NDX / 100.HSI / 100.FTSE / 100.N225 / 100.GDAXI`
这七个（即历史上唯一被 `int_*` 兜底过的标的），last-known-good 里**只信 `source = em | tencent`**；
其它来源（`sina`、无来源）一律**作废**，并记进进程内 `lastGoodPurged()` 与文件的 `purged[]`：

```jsonc
// ~/.dsh/dsh-tradewatcher/quotes-lkg.json（新 schema）
{ "v": 2, "ts": 1784567857384, "rows": [ ... ],
  "purged": [ { "secid": "100.SPX", "price": 6643.7, "at": 1791808317469,
                "reason": "新浪 int_* 陈旧快照（无时间戳；实测偏差 10–27%）已整体停用 ⇒ 来源 sina 的行作废" }, ... ] }
```

要点：
- **只作废能归因到坏来源的行**：`100.FCHI`/`100.KOSPI200`/`100.SX5E`（无 `source`，东财时代的观测）**不动** —— 用 `source` 特征而不是"凡是 100.* 全清"，避免误伤。
- **作废即落盘**（不沿用、也不等下一个人继承）：`lkgDirty=true; lkgLastWrite=0; persistLastGood()`，`console.warn` 打出被作废的 secid 与价格。
- 作废后这些标的走正常流程重新取数（`us.INX`/`us.DJI`/`us.NDX`/`hkHSI`），取不到就如实 `missing` + 原因。

**现网文件的实际状态（只读核对，2026-10-12 20:37 之后）**：`v = 2`、`rows = 123`、`purged` 里 6 条（FTSE/GDAXI/HSI/N225/NDX/SPX），`100.SPX`、`100.NDX` 已不在 rows 里；
`100.FCHI/KOSPI200/SX5E`（无 source）保留 ✓ —— 与新规则的预期逐条一致。

> **诚实披露（重要）**：这条处置**不是**我的实验脚本写的 —— 我的所有脚本都隔离在 `/tmp/impl44/*`。
> 现网文件的写入者只能是进程 `dsh web`（PID 330607，16:47 启动）：它加载的 `lib/index.js` 在 ~20:36 被
> **从工作区重新构建过**（`npm run check` 含 build），而宿主会热重载插件 ⇒ 我的新代码在那之后生效，
> 于是服务自己的下一次取数就按新规则作废了旧值。这正是本轮想要的结果（错值不再被使用），
> 但**工作流风险**要记一笔：**从脏工作区构建 = 把 WIP 推到正在用的服务上**，构建前应确认工作区状态。
> 我这边没有对 `~/.dsh` 做任何直接写入。

---

## 4. 真数据端到端（改前 → 改后）

脚本 `/tmp/impl44/live.mts`（`DSH_HOME=/tmp/impl44/live-home`，真网络、EM 今天不可达 ⇒ 只有备用源在答）：

| 标的 | 改前（实测） | 改后（实测） |
|---|---|---|
| `100.SPX` | `6643.7`（source=sina，错值） | **`7811.54` source=tencent** ✓ |
| `100.DJI` | 缺（或 `46247.29`） | **`51654.95` source=tencent** ✓ |
| `100.NDX` | `22484.07`（source=sina，错值） | **`30883.15` source=tencent** ✓ |
| `100.HSI` | `24271.2`（source=sina） | **`24271.2` source=tencent** ✓ |
| `100.N225` | `44946.64`（source=sina，无法判新鲜度） | **`（无）` + missing（如实）** ✓ |
| `1.600519` | 1288（tencent） | 1288（tencent）不变 ✓ |

**改后落地输出**（`missing = ["100.N225"]`，`sources={"tencent":5}`）—— 正是"宁缺错值"的目标形态。

> 中途踩到的坑（已修，见 §2 ⑤）：只改 `tencentIndexCode` 映射时，端到端仍是**全部无值** ——
> 因为 `em.ts` 的 `tencentQuoteRows` 用 `tencentCode` 过滤，国际指数在发请求之前就被丢掉了。
> 这条只有真数据端到端能发现（单元级映射断言全绿）。

---

## 5. 断言与反例注入

新文件 `src/host/sinaIndex.test.ts`（3 条，`DSH_HOME` 隔离在 `/tmp`）：

| 断言 | 内容 |
|---|---|
| ① | `TW_ALL_SECIDS` 里所有 `100.*` 的 `sinaSymbol()` 必须为 `null`；`parseSinaHq` 对 `int_*` 行必须**不产出**行情（`nf_*` 不受影响） |
| ② | `tencentIndexCode('100.SPX') === 'us.INX'`（并注明 `usSPX` 不存在）、`100.DJI→us.DJI`、`100.NDX→us.NDX`、`100.HSI→hkHSI`；大小写无关；腾讯没覆盖的六个如实 `null`；`tencentCode('100.SPX') === null`（mkline 链不得拿到指数） |
| ③ | 构造"事故现场"`quotes-lkg.json` ⇒ `fetchQuotesDetailed` 后：`100.SPX/100.N225` **不得**被端出来并如实进 `missing`；`100.FCHI`（无 source）与 `1.600519` 的兜底**不受影响**；`lastGoodPurged()` 有记录；落盘文件 `v=2`、无 `100.SPX` 行、`purged[]` 有留痕 |

**反例注入（关掉修法 ⇒ 断言必须失败；贴证据后已恢复，md5 校验通过）**：

```
A 恢复 `int_*` 兜底（sina.ts 映射表加回 100.SPX/100.N225）：
  ✖ ① … AssertionError: 100.SPX 不得再有新浪兜底（int_* 是陈旧快照 + 无时间戳）
  → /tmp/impl44/inject/A-int-fallback.log
B 停掉"落盘错值作废"（retiredIndexRowReason 恒 null）：
  ✖ ③ … AssertionError: 作废后的 100.SPX 不得再被当作"最后成功值"端出来
  → /tmp/impl44/inject/B-lkg-purge.log
```

另：本轮改动的**文案残留**已自查 —— 我改的 4 个源文件 + 1 个测试文件里，
字符串字面量中**没有** `**`、`##`、反引号包整句（`markdownScan.test.ts` 规则全绿；它只看非测试文件，我把测试文件一并查了）。

---

## 6. 门禁（`npm run check`）

```
EXIT=0
ℹ tests 494   ℹ suites 0   ℹ pass 494   ℹ fail 0    （TZ=Asia/Shanghai）
ℹ tests 494   ℹ suites 0   ℹ pass 494   ℹ fail 0    （TZ=UTC）
ALL HOST CHECKS PASSED (live probes soft)
```
**末尾三行**：
```
> node build.mjs

built lib/index.js + lib/client.js （v0.70.0，客户端片段校验通过：73 项）
```

（中途 `markdownScan.test.ts:57` 曾报我写在 selftest 断言标签里的 `**不得**`/`**忽略**` —— 已去掉符号，
**没有**放宽扫描规则；复跑全绿。）

---

## 7. 未做项（不许读成"已修"）

| 项 | 说明 |
|---|---|
| 日经 / 富时 / 德国 DAX 的兜底 | 新浪 `int_*` 停用后**没有**可信替代：腾讯逐个试过全 `pv_none_match`。这三个（含韩国 KOSPI200、法国 CAC40、斯托克 50）在 EM 不可达时如实显示"无行情源 + 原因"。**可用兜底的预设数从 22 降到 18、新浪专供从 15 降到 8** —— 这是有意的降级（宁缺错值），自检阈值已同步并注明原因 |
| 腾讯美股指数的行情时间戳 | `us.INX` 的 `f[30] = "2026-10-09 17:29:56"` 的时区归属（UTC 还是 ET）我没有证据 ⇒ **不解析**（`ts: null`）。行内 `at`（本机观测时刻）照常给出，新鲜度判定不受影响；要接的话需要先确证时区，否则会把 ET 交易时间当本地时间读错 |
| `100.DJI` 的预设 | `TW_ALL_SECIDS` 里本来就没有 `100.DJI`（映射已就绪；若之后加入自选，会走 `us.DJI`） |
| 五日分时的国际指数源 | `mkline` 对 `us.INX` 返回 `param error`（实测）⇒ 五日视图对国际指数仍无备用源（与改前一致，未退化） |
| 其它 `int_*` 消费者 | 全仓 grep 确认：`int_*` 只剩注释里作为**反面证据**出现，无任何代码引用（`sinaSymbol`/`parseSinaHq`/断言三处都已改） |
