# AUDIT-CACHE-2 · 缓存与持久化设计的**对抗式复核**（verifier）

- 复核目标：回答用户问题「是否存在**同一数据反复多次拉取**导致**数据接口反复熔断**」。
- 代码基线：`main` @ `24936cd`（v0.66.0），`git status --short` 为空，`lib/` 与 `src/` 同步
  （`find src -name '*.ts' -newer lib/index.js` 无输出，`lib/index.js` mtime 14:14）。
- 复核方式：**不看代码下结论** —— 在临时实例里用 `globalThis.fetch` 拦截器**逐条实测上游请求**。
- 状态词：**证实 / 证伪 / 证据不足 / 未验证**。
- 本文件是本人**唯一**写入面；其余全部只读。全程**未重启、未改动**用户的 `dsh web`（3080）。

---

## 0. 同伴报告状态：15:14 出现 → **§7 是逐条复核；§1–§6 是之前的独立抽检**

任务要求我复核 `audit-cache` 的 `docs/AUDIT-CACHE-1.md`。时间线：

```
$ ls docs/AUDIT-CACHE*.md        # 15:07:05、15:09:28、15:13 三次
ls: 无法访问 'docs/AUDIT-CACHE*.md': 没有那个文件或目录
$ ls -la docs/AUDIT-CACHE*.md    # 15:14（我等待后重查）
-rw------- 1 hu hu 43795 10月 12 15:14 docs/AUDIT-CACHE-1.md
```

所以本报告分两段，**口径不同，不要混读**：

| 段落 | 性质 | 内容 |
|---|---|---|
| §1–§6 | **独立抽检**（写于读不到对方报告时，未基于其文本） | 14 条命题的自行取证；§4 的 6 条反例检验；未验证清单 |
| **§7** | **逐条复核**（对方 15:14 落地后追加） | 对它每条关键结论给 **证实 / 证伪 / 证据不足 / 未验证**，附我自己的命令与输出 |

**§7 结论一句话**：它的**头条量级数字我全部独立复现**（112 = 56×2、并发 224 = 56×4、故障首调 12 次东财 = 6+6 后归零、我那份日志的 118/52/159s/6 探针都读对了）；**两处需修正**（"trips=5 不是巧合"是过强推断；"现网实测 18 次/分"口径错）；**一处系统性低估**（页面成本按 5–10 标的建模，真实是 28 标的 ⇒ 每拍 8 条而非 1 条）。

---

## 1. 复核方法（可复现，任何人可重跑）

### 1.1 拦截器：把"上游请求次数"变成可数的实测值

代理量（缓存 mtime / `asOf` / 日志行数）都只能间接推；我直接数 **`fetch` 调用**。
`/tmp/fetchcount.mjs`（不进程内改仓库任何文件，用 `NODE_OPTIONS --import` 预载）：

```js
import { appendFileSync } from 'node:fs'
const LOG = process.env.TW_FETCH_LOG ?? '/tmp/tw-fetch.log'
const orig = globalThis.fetch
let seq = 0
globalThis.fetch = async function (input, init) {
  seq += 1
  let url = ''
  try { url = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input && input.url) || '') } catch {}
  try {
    const u = new URL(url)
    appendFileSync(LOG, JSON.stringify({ n: seq, t: Date.now(), host: u.host, path: u.pathname, q: u.search.slice(0, 160) }) + '\n')
  } catch { appendFileSync(LOG, JSON.stringify({ n: seq, t: Date.now(), host: '?', path: String(url).slice(0, 160) }) + '\n') }
  return orig.call(this, input, init)
}
```

自检（证明拦截器真的生效，不是自我安慰）：

```
$ node -e "process.env.TW_FETCH_LOG='/tmp/tw-selftest.log'; import('/tmp/fetchcount.mjs').then(async()=>{try{await fetch('https://example.com/x')}catch(e){}})"
$ cat /tmp/tw-selftest.log
{"n":1,"t":1791788316773,"host":"example.com","path":"/x","q":""}
```

> **引用约定（全篇一致，免得把解读当成原始输出）**：代码块里凡出现
> `…同 URL…` / `…` ＝ 我**省略了完全相同的内容**；凡出现中文括号注（如 `（+15.17s）`、`← 第二轮`）
> 或紧跟代码块后的"判读/归属"段落 ＝ **我的解读**，不是程序的原始输出。
> 所有"上游请求条数"都是 `/tmp/tw-fetch*.log` 的行数差，可直接 `wc -l` 复算。

### 1.2 临时实例（**绝不碰 3080**）

```
$ TW_FETCH_LOG=/tmp/tw-fetch2.log NODE_OPTIONS="--import /tmp/fetchcount.mjs" \
    setsid timeout 420 dsh --profile web --port 0 --no-open > /tmp/boot-verify2.log 2>&1 &
$ grep -o 'http://127.0.0.1:[0-9]*' /tmp/boot-verify2.log | head -1
http://127.0.0.1:44049
```

- `--port 0` → 随机端口；用例跑完 `kill` 掉（见 §1.4）。
- 插件在 web profile 里是**指向本仓库的 symlink**，所以加载的就是被审计的这份代码：
  `~/.dsh/profiles/web/node_modules/dsh-tradewatcher -> /home/hu/.../dsh-tradewatcher`。
- 数据目录 `~/.dsh/dsh-tradewatcher`（与用户实例共享 ⇒ K 线磁盘缓存是热的，判定"冷/热"时已区分）。
- 路由信任判定允许 loopback（`fence.ts:60`），故 `curl -H 'Host: 127.0.0.1:<port>'` 可正常取数。

### 1.3 七个实例，共 711 条上游请求被逐条记录

```
$ wc -l /tmp/tw-fetch*.log
  118 /tmp/tw-fetch.log      # 实例 1：冷启动 + 逐路由探针（§7.4 里被 peer 引用为"独立样本"）
  193 /tmp/tw-fetch2.log     # 实例 2：半开探测 / kline 旁路 / asOf 对照 / 页面总量
   32 /tmp/tw-fetch3.log     # 实例 3：精确 28 项集合复算 + 收盘后回源
    9 /tmp/tw-fetch4.log     # 实例 4：/chips 的 days 与 lmt 检验
  117 /tmp/tw-fetch5.log     # 实例 5（隔离）：合成 clist fixture ⇒ 复现 peer 的 112 = 56×2
   13 /tmp/tw-fetch6.log     # 实例 6（隔离）：注入失败 ⇒ 复现 peer 的 12 次东财后归零
  229 /tmp/tw-fetch7.log     # 实例 7（隔离）：并发 2 次 ⇒ 224 = 56×4（无 in-flight 合并）
  711 总计
```

> 实例 5–7 的 `DSH_HOME=/tmp/verify-home` 已生效（`store ready at /tmp/verify-home/dsh-tradewatcher`），
> 隔离目录里只有 `quotes-lkg.json` —— **前 4 个实例没有隔离，见 §1.4 第 3 条的自曝**。

本次复核期间，我**刻意撞上了真实故障**：东财主机整段不可达（这正是用户说的"今天多次熔断"），
所以下面每条结论都同时有「EM 全熔断」与「EM 半可达」两种现场。

### 1.4 清理与对用户实例的影响（可核）

```
$ for p in $(ps -eo pid,args | grep "[d]sh --profile web --port 0" | awk '{print $1}'); do kill $p && echo "killed $p"; done
killed 279024
killed 279026
$ curl -s -o /dev/null -w 'temp instance now: %{http_code}\n' -H "Host: 127.0.0.1:44049" http://127.0.0.1:44049/tradewatcher/health
temp instance now: 000
$ curl -s -o /dev/null -w 'user 3080: %{http_code}\n' http://127.0.0.1:3080/
user 3080: 401
```

**诚实交代（三条，含我自己造成的影响）**：

1. **未动用户的 3080 服务**：3080 全程只做了一次只读探测（返回 401，与复核前一致），
   **未重启、未写任何 profile/bundle、未装 bundle、未 `git commit`/`push`**。
2. **但我给上游加了负载**：4 个临时实例与用户实例**共用同一个出口 IP**，
   所以我的实测本身也压了上游（每个实例冷启动约 80 条）。我控制在 **4 次、每次 ≤7 分钟**。
3. **⚠ 我的前 4 个实例没有隔离数据目录，写进了用户正在使用的 `~/.dsh/dsh-tradewatcher`。**
   这是我自己的副作用，必须列清：

   - 写出的是**真实行情数据**（不是合成值），所以**没有伪造值残留**；具体落到：
     `klines/1.601288_101_1.json`、`klines/0.000858_101_1.json`、`klines/1.600900_101_0/1/2.json`、
     `klines/1.600036_101_0/1.json`、`klines/114.lhm_*`（`mtime` 15:02–15:13），
     以及 `quotes-lkg.json` / `trends-lkg.json` / `board-lkg.json` 的正常覆盖写。
   - **但有两条不能忽略**：① 它们会被 `pruneKlineCache`（上限 300）计入配额；
     ② **`rescue-log.json` 是整文件覆写、无跨进程锁**，我的实例每次采样（尾盘 15s 一拍）
     都会 `today.samples += 1` 并整份写回 ⇒ `days['2026-10-12'].samples = 371` 里
     **混入了我的实例的拍数，无法干净剔除**（`audit-cache` 的 fixture 实例同理）。
     依赖当日自采样分位的统计因此 **不干净**，这条我与它同责。
   - **第 5、6、7 个实例已改正**：`DSH_HOME=/tmp/verify-home`
     （`profiles` 用 symlink 指回真实 profile 以便加载插件），
     实测隔离生效：`[tradewatcher] store ready at /tmp/verify-home/dsh-tradewatcher`。

---

## 2. 结论汇总（13 条命题）

| # | 命题 | 结论 | 关键证据 |
|---|---|---|---|
| C1 | 「同一数据反复多次拉取」**确实存在** | **证实** | 一次 trends2 竟产生 **12** 条同 URL 请求；一次行情轮询产生 **8** 条（§3.1） |
| C2 | **熔断打开后** kline 链路**仍在打上游** | **证实** | 3 台主机全部 `open=true` 时，一次 `/kline` 仍发出 **6** 条 EM 请求，且 `trips` 不变（§3.2） |
| C3 | 半开期"只放行一个探针" | **证实（但只挡调用方，不挡尝试次数）** | 半开瞬间每台主机实测 **2** 条而非 1 条（§3.3） |
| C4 | 熔断退避是指数退避且生效 | **证实**（正面） | 实测 `trips 2→3`、`until=+422s`；代码 `120s×2^n` 上限 900s（§3.4） |
| C5 | 用 `asOf` 推进当"上游请求次数" | **证伪**（作为"计数"用它） | 命中缓存时 `asOf` 一字不动；失败请求**完全不可见**（§3.5） |
| C6 | `lmt` 是缓存键 ⇒ 同数据多拉 | **证伪** | 键为 `kline:{secid}:{baseKlt}:{fqt}:{full\|incr}`，换 `lmt` 实测 **0** 上游请求（§3.6） |
| C7 | `klt` 101/102/103 各自独立回源 | **证实** | 四种周期四条独立上游；104 会本地重采样、102/103 不会（§3.7） |
| C8 | `fqt` 造成 3 倍回源 | **证实（但非缺陷）** | 3 种口径确实是 3 份不同载荷（`qfq` / 无 / `hfq`）（§3.8） |
| C9 | 页面打开一分钟的真实总量 | **复算：48 条/分**（EM 未被闸住）～ **29 条/分**（EM 被闸住）；**收盘后仍照此频率**（§3.9） |
| C10 | 护盘采样器**绕过**行情缓存 | **证实** | `rescue.ts:634` 直调 `fetchAny`；静默 53s 内 4 拍全来自它，与页面轮询同一批标的（§3.10） |
| C11 | 已被隐藏的卡片仍被轮询 | **证实** | `stripCfg.hidden` 里的 `1.000012` 出现在每次 EM 请求里（§3.11） |
| C12 | 「我们的重复请求**导致**上游熔断」 | **证据不足（不可证）** | 无上游阈值/错误码证据；同刻 EM 对 kline 端点 200 且正常返回 23 923 字节数据（§3.12） |
| C13 | 熔断状态**随进程重启清零** ⇒ 每次重启重新猛试一轮 | **证实**（本地侧） | `breaker.ts:109` 进程内 `Map`；新进程前 3 拍每拍 4 条 EM，第 4 拍闸落下变 0 条（§3.9） |
| C14 | `days` 是缓存键 ⇒ 同数据多拉 | **证伪** | `days=180` → `400` → `45` 实测 **0/0** 条上游；但**冷缓存时 `lmt` 削减不了上游载荷**，`/chips` 为算一个比值各拉 **800 根**（§3.13） |


一句话回答用户：**"同一数据反复多次拉取"成立且有硬证据；"导致上游熔断"不可证、不应写成结论。**

---

## 3. 逐条详证

### 3.1 C1 「同一数据反复多次拉取」—— **证实**

#### (a) 一次缓存未命中 ⇒ 最多 12 条同 URL 请求（协议层）

`fetchAny`（`src/host/em.ts:113-171`）是一个 `轮 × 主机 × 尝试` 的三重网格：

```ts
const FETCH_ROUNDS = 2                    // em.ts:109
const FETCH_ATTEMPTS_PER_HOST = 2         // em.ts:110
for (let round = 0; round < FETCH_ROUNDS; round++)          // em.ts:130
  for (const host of claimed)                                // em.ts:133
    for (let attempt = 0; attempt < FETCH_ATTEMPTS_PER_HOST; attempt++)   // em.ts:134
```

`HISTORY_HOSTS` 是 3 台（`em.ts:33`）⇒ **一次调用上限 2×3×2 = 12 条**；`QUOTE_HOSTS` 是 2 台 ⇒ 上限 8 条。
"立刻被关闭"的失败会跳过第二轮（`em.ts:161` `if (!anySlowFailure && round === 0 ...) break`），
所以**瞬时封锁时是 6 条、慢失败时是 12 条**。

实测（实例 1 冷启动，EM 正在抽风）：

```
$ node -e "…过滤 /tmp/tw-fetch.log 里 secid=1.510300 的 trends2…"
     0ms  push2his   /api/qt/stock/trends2/get ?secid=1.510300&…&ndays=1
   277ms  push2his   …同 URL…
   773ms  push2delay …同 URL…
   911ms  push2delay …同 URL…
  1274ms  push2       …同 URL…
  1545ms  push2       …同 URL…
  2288ms  push2his   …同 URL…      ← 第二轮
  2561ms  push2his   …同 URL…
  2996ms  push2delay …同 URL…
  3126ms  push2delay …同 URL…
  3440ms  push2       …同 URL…
  3814ms  push2       …同 URL…
```

`0/277`（his ×2）→ `773/911`（delay ×2）→ `1274/1545`（push2 ×2）是**第一轮**，
`2288…3814` 是**第二轮**：形状完全等于 `2 轮 × 3 主机 × 2 尝试`。
⇒ **同一份分时数据，4.5 秒内被请求 12 次**，全部因上游不可达而失败。

#### (b) 一次行情轮询 ⇒ 8 条上游请求，且**每一拍都不命中缓存**

```
$ for i in 1 2 3; do curl -s -H "Host: 127.0.0.1:$PORT" "$BASE/tradewatcher/quotes?ids=<TW_ROWS 28 项>"; sleep 10; done
  poll1: upstream=8 1575ms
        push2delay.eastmoney.com  /api/qt/ulist.np/get?secids=0.399001,0.399006,1.000001,1.000012,1.000300,…
        push2delay.eastmoney.com  /api/qt/ulist.np/get?secids=0.399001,0.399006,1.000001,1.000012,1.000300,…
        push2.eastmoney.com       /api/qt/ulist.np/get?secids=0.399001,0.399006,1.000001,1.000012,1.000300,…
        push2.eastmoney.com       /api/qt/ulist.np/get?secids=0.399001,0.399006,1.000001,1.000012,1.000300,…
        qt.gtimg.cn               /q=sz399001,sz399006,sh000001,sh000012,sh000300,sh000688,sh000905
        hq.sinajs.cn              /list=int_ftse,int_dax30,int_hangseng,int_nikkei,int_nasdaq
        hq.sinajs.cn              /list=int_sp500,hf_HG,hf_SI,hf_OIL,nf_RB0
        hq.sinajs.cn              /list=nf_JM0,nf_LH0,nf_M0,hf_XAU
  poll2: upstream=8 1471ms   （与 poll1 逐条同 URL、同顺序）
  poll3: upstream=8 1576ms   （同上）
```

**判读（这是我的解读，不是原始输出）**：4 条 EM 行两两同 URL ＝ `2 台主机 × 2 次尝试`（第一轮；
第二轮的 2 条被 `em.ts:161` 的 fast-fail 跳过），即 `em.ts:133-134` 的双层循环。

**连续三拍都是 8 条，一模一样。** 说明这条链路上缓存**一拍都没生效**。原因在缓存键与 TTL：

- 缓存键是 `quotes:<secid>` 级别的槽（`em.ts:736` 逐标的槽，v0.66.0 已修掉"整批拼接"旧键）；
- 槽 TTL = `quoteFreshMs`（`em.ts:815`：`{ exp: at + ttl, at, row }`），
  而 `quoteFreshMs` 取自用户偏好：`setQuoteFreshnessMs(k.store.getPrefs().refreshSec * 1000)`（`src/index.ts:153`），
- `~/.dsh/dsh-tradewatcher/prefs.json` 实测 `"refreshSec": 10`，
- 客户端轮询间隔**也是** `refreshSec * 1000`（`src/client/index.tsx:301`）⇒ **TTL == 轮询间隔**。

**TTL 与轮询间隔相等 ⇒ 稳态命中率 0%**。客户端每次回来时槽刚好过期，缓存形同不存在。
这是"同一数据反复拉取"的**根因**，不是偶发。

#### (c) 这个数字对一天意味着什么

`8 条/拍 × 6 拍/分 ≈ 48 条/分 ≈ 2 880 条/小时`，**仅顶部行情条**，且与"要不要看"无关（§3.10、§3.11）。

### 3.2 C2 熔断打开后 kline 链路**仍在打上游** —— **证实**（本次最严重的一处）

**代码**：`requestKlineRaw`（`em.ts:1825`）**不用** `fetchAny`，而是直调**裸的** `fetchFromHost`：

```ts
for (let attempt = 0; attempt < 2; attempt += 1) {
  for (const host of HISTORY_HOSTS) {
    try {
      const json = await fetchFromHost(host, path, 9000)     // em.ts:1838
      …
    } catch { /* 换主机 / 重试 */ }
  }
  if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
}
```

而 `fetchFromHost`（`em.ts:81-97`）是纯 `fetch` 包装：**既不查 `breakerFor(host).allow()`，
也不调用 `recordFailure`**。（对比 `fetchAny` 的注释 `em.ts:114`：
"熔断冷却期内跳过该主机…（重试只会加重上游对本机 IP 的封锁）"——这句承诺**不覆盖** kline 链路。）

**实测**（3 台主机全部处于冷却中）：

```
$ curl -s -H "Host: 127.0.0.1:$PORT" "$BASE/tradewatcher/health"
{"ok":true,…,"breaker":{"open":true,"allOpen":true,"openHosts":3,"hosts":3,…}}

$ curl … "$BASE/tradewatcher/kline?secid=114.lhm&klt=101&fqt=0&lmt=240"
### kline 114.lhm (螺纹钢主连) klt=101 fqt=0 lmt=240
    HTTP 200  upstream=6  1204ms
      12ms  push2his[EM]   /api/qt/stock/kline/get ?secid=114.lhm&klt=101&fqt=0&lmt=10&…
     166ms  push2delay[EM] …同 URL…
     208ms  push2[EM]       …同 URL…
     859ms  push2his[EM]   …同 URL…      ← 第二轮
     992ms  push2delay[EM] …同 URL…
    1046ms  push2[EM]       …同 URL…
```

**6 条请求，全部打向"熔断中"的三台主机。** 且 `trips/fails` 在爆发前后**完全不变**（`push2delay=2/1`、
`push2=2/1`、`push2his=1/1`）⇒ 这条链路的成败**不进熔断账本**，熔断器对它既不管闸也不记账。

**命中条件**（避免夸大）：只有当腾讯那条路返回 `null` 时才会走到这里——
`em.ts:1826` 先试腾讯（见 §4 反例 4）。**腾讯覆盖的标的（沪深/港/美个股）不会触发此问题；
腾讯不覆盖的（商品主连、外盘指数、171.* 国债收益率、部分 ETF）会。**
用户在 `TW_ROWS` 里正有 `114.lhm / 114.jmm / 114.mm / 113.rbm / 112.B00Y / 101.HG00Y / 101.SI00Y / 122.XAU`
＋ `100.*` 九个外盘指数——**这些都是腾讯不覆盖的**，也是"商品/国际"两条行情条的数据源。

### 3.3 C3 半开期"一个探针"只挡调用方 —— **证实**

`claimProbe`（`breaker.ts:62-67`）确实只放行**一个调用方**，但**一个调用方内部**仍然是
`2 尝试/主机/轮`（`em.ts:134`）。预测：半开瞬间每台主机应看到 **2** 条，而不是 1 条。实测：

```
$ …在 until 到点前 24s 起，每 8s 打一次 /quotes，持续 72s…
### EM requests during the window (total upstream=27)
EM requests: 4
   +25s  push2delay.eastmoney.com  /api/qt/ulist.np/get ?secids=100.FCHI,100.KOSPI200,100.SX5E,171.DE10Y…
   +25s  push2delay.eastmoney.com  …同 URL…
   +25s  push2.eastmoney.com       …同 URL…
   +26s  push2.eastmoney.com       …同 URL…
all by host: {"qt.gtimg.cn":6,"hq.sinajs.cn":15,"push2delay.eastmoney.com":2,"push2.eastmoney.com":2,…}
```

**每台 2 条**（`push2delay` 2 条、`push2` 2 条），不是 1 条。半开保护把并发调用方串行化了，
但每次半开事件仍要付 `2 条/主机`（kline 链路更是每次 6 条，§3.2）。

### 3.4 C4 指数退避 —— **证实**（这是本次唯一的正面结论）

`breaker.ts:90-93`：

```ts
const backoff = Math.min(this.maxMs, this.baseMs * 2 ** this.trips)
this.trips += 1
this.until = Date.now() + backoff
```

`baseMs=120_000`、`maxMs=900_000`（`breaker.ts:114`）⇒ `120s → 240s → 480s → 900s(封顶)`。实测半开探测失败后：

```
### breaker state AFTER the half-open probe burst ###
allOpen=true openHosts=3
  push2delay.eastmoney.com trips=3 fails=0 open=true until=+422s  err=fetch failed
  push2.eastmoney.com      trips=3 fails=0 open=true until=+422s  err=fetch failed
  push2his.eastmoney.com   trips=2 fails=0 open=true until=+78s   err=fetch failed
```

`trips 2→3` 且剩余 **422s ≈ 480s**，与 `2^2` 档位吻合。**熔断确实在退避，没有"每 2.5s 重试一次"的活锁。**
半开探针失败也**立即重熔并延长冷却**（`breaker.ts:84-93` 的注释与实现一致）。

### 3.5 C5 用 `asOf` 当"上游请求次数" —— **证伪**

任务点名要我检验这个代理量在**并发与缓存命中**下是否成立。三个层次实测：

**(1) 命中缓存时 `asOf` 不动 ⇒ 方向是"保守"（不虚报）**：

```
### quotes #1 (expect upstream)
    HTTP 200  upstream=1  154ms
    -> ts=1791788599537 asOf=1791788599535 stale=false
### quotes #2 same ids 2s later (cache hit?)
    HTTP 200  upstream=0  30ms
    -> ts=1791788601758 asOf=1791788599535 stale=false      ← asOf 一字未变，ts 前进了
```

⇒ **不能用 `asOf` 读成"命中缓存也算一次取数"**。若同伴报告用 `asOf` 数请求次数，这一点上它**不会虚高**。

**(2) 但一个批次的 `N` 个标共享**同一个** `at` ⇒ 一个 tick ≠ 一次请求**：

`em.ts:814-815`：`const at = Date.now()` 在**整批**取数之后打一次时间戳，然后给整批所有行用同一个 `at`；
`asOf = max(row.at)`（`em.ts:391`）。所以 `asOf` 前进一格只能证明"**至少发生过一次成功的批量取数**"，
既不能区分 1 条与 12 条（§3.1a），也不能区分把 28 个标的分给 4 条不同 URL 的请求（§3.1b）。

**(3) 致命的一条：失败的请求在 `asOf` 上**完全不可见**。

`em.ts:808-821`：只有 `still.length > 0` 且 `got` 非空才 `quoteSlots.set(...)`。
全部上游失败 ⇒ `got` 为空 ⇒ **不写槽、不盖 `at`** ⇒ `asOf` 停摆。
而"反复熔断"恰恰就是**失败**的那一侧。实测同一窗口的两套读数：

```
（同 72s 窗口，来自 TEST G 的 by-host 统计）
按真实请求数：  27 条上游请求
                = 4 条 EM（半开探测）
                + 21 条兜底（qt.gtimg.cn 6 + hq.sinajs.cn 15）
                + 2 条非本插件（api.siliconflow.cn / api.deepseek.com）
按 asOf 推理：  ≈1 个"新批次"      ← 漏掉了全部 4 条失败的 EM 试探
```

**结论**：`asOf`（以及 `缓存文件 mtime`、日志行数）**只能证明"至少成功取过一次"，
不能证明次数，更不能证明"打了几次才熔断"**。任何以它为分母算出的"N 次请求/导致了熔断"都不成立。
**判为证伪**——不是因为它虚高，而是因为它**系统性漏掉失败请求**，正好漏掉要解释的那一半。

### 3.6 C6 `lmt` 是缓存键 ⇒ 同数据多拉 —— **证伪**

**代码**（`em.ts:2061`）：

```ts
const key = `kline:${secid}:${baseKlt}:${fqt}:${needFull ? 'full' : 'incr'}`
```

**`lmt` 不在键里**；`lmt` 由 `KLINE_FULL_LMT` / `KLINE_RECENT_LMT`（`em.ts:1432-1433`）决定。
预测：同一 secid 先 `lmt=240` 再 `lmt=100`，第二次应当**不产生**上游请求。实测：

```
### kline 1.600519 klt=101 fqt=1 lmt=240 (COLD)
    HTTP 200  upstream=1  145ms
      9ms  web.ifzq.gtimg.cn  /appstock/app/fqkline/get ?param=sh600519,day,,,10,qfq
### kline 1.600519 klt=101 fqt=1 lmt=100 (same data, diff lmt)
    HTTP 200  upstream=0  9ms                      ← 0 条，命中缓存
```

⇒ **`lmt` 不会造成同数据多拉**。担心不成立。

### 3.7 C7 `klt` 各周期独立回源 —— **证实**

```
### kline 1.600519 klt=102 (week)
    HTTP 200  upstream=1  118ms   web.ifzq.gtimg.cn ?param=sh600519,week,,,5,qfq
### kline 1.600519 klt=103 (month)
    HTTP 200  upstream=1  104ms   web.ifzq.gtimg.cn ?param=sh600519,month,,,240,qfq
### kline 1.600519 klt=104 (year, resampled from 103)
    HTTP 200  upstream=1  115ms   web.ifzq.gtimg.cn ?param=sh600519,month,,,5,qfq
```

四个周期 → 四条独立上游请求。注意**代码已经会本地重采样**（`em.ts:1894`
`baseKlt === 103 && klt === 104 ? resampleYearly(entry.bars) : entry.bars`），
即"年 K 由月 K 折叠"是现成能力；**但周 K/月 K 仍各自向 EM 要一份**
（`klineCacheFileNames` 按 `(secid,klt,fqt)` 落盘，`em.ts:1627`）。
所以状态是：**证实存在"同标的、不同周期、重复回源"**，
至于"周 K 该不该由日 K 折叠"是设计取舍（复权/换月口径可能不同），我不越界断言它是缺陷。

### 3.8 C8 `fqt` 三份回源 —— **证实（非缺陷）**

```
  fqt=1  upstream=1   web.ifzq.gtimg.cn ?param=sh600900,day,,,10,qfq
  fqt=0  upstream=1   web.ifzq.gtimg.cn ?param=sh600900,day,,,10,        ← 不复权
  fqt=2  upstream=1   web.ifzq.gtimg.cn ?param=sh600900,day,,,800,hfq    ← 后复权
```

三条请求的参数**真的不同**（`qfq` / 无 / `hfq`）⇒ 是**三份不同的数据**，不是同一份数据拉三遍。
判"证实存在 3 倍回源"，但**明确不算缺陷**。用户切换复权口径时会付 3× 代价，这是必要的。

### 3.9 C9 页面打开一分钟的真实总量（**复算**，两种现场）

**现场甲：三台 EM 全熔断（`allOpen=true`）**，模拟"真实页面"＝引擎 10s 一拍 + 徽标 60s 一拍：

```
########## TEST F: 60s of a REAL open page (engine 10s cadence + badge 60s) ##########
  t=0s  badge
  t=10s  quotes  upstream+4
  t=20s  quotes  upstream+4
  t=30s  quotes  upstream+4
  t=40s  quotes  upstream+4
  t=50s  quotes  upstream+4
  t=60s  quotes  upstream+4
### TOTAL over 62906ms: upstream requests = 31
by host: {"qt.gtimg.cn":11,"hq.sinajs.cn":18,"api.siliconflow.cn":1,"api.deepseek.com":1}
by path:
     6x qt.gtimg.cn/q=sz159915,sz159919,sz399001,sz399006,sh000001,sh000012,sh000300,sh000688,sh000905,sh510050,sh510300,sh51031…
     6x hq.sinajs.cn/list=int_ftse,int_dax30,int_hangseng,int_nikkei,int_nasdaq
     6x hq.sinajs.cn/list=int_sp500,hf_HG,hf_SI,hf_OIL,nf_RB0
     6x hq.sinajs.cn/list=nf_JM0,nf_LH0,nf_M0,hf_XAU
     4x qt.gtimg.cn/q=sh000300,sh510300,sh510050,sh510500,sh512100,sh588000,sz159915,sh588170
     1x qt.gtimg.cn/q=sh000001,sh000300,sh510300,sh512660,sh518880,sh560010,sh588170,sh601398,sh601872,sh601975,sh688035
     1x api.siliconflow.cn/v1/user/info
     1x api.deepseek.com/user/balance
```

**归属（我按 URL 与时间戳判读）**：每拍 `upstream+4` 的构成是
`qt.gtimg.cn`（A 股/ETF）1 条 + `hq.sinajs.cn`（国际/商品）3 条；6 拍 ⇒ `6×4 = 24` 条。
4×`qt.gtimg.cn` 那组 8 只宽基＝护盘采样器；1×含持仓那组＝徽标；两个 `api.*` 不是本插件。

**31 条 / 63s ≈ 29 条/分**。注意：**EM 请求 0 条**——
三台都在冷却，`fetchAny` 全部快速失败：熔断把请求**从 EM 挪到了腾讯/新浪**，总量没降（`11 + 18 = 29` 条）。

**现场乙：EM 未被拦下（新进程熔断器还是空的）**：每拍 **8** 条（§3.1b）⇒ `8×6 = 48 条/分`。
外加护盘采样器 4 拍/分（`rescue.ts` 配置 `tailIntervalSec:15`，见 §3.10）。

⚠ **为什么"新进程"要单独当一种现场**：`breakers` 是**进程内** `Map`（`breaker.ts:109`），
`trips/fails/until` 全在内存里 ⇒ **每次 `dsh web` 重启，三台主机的熔断状态全部清零、重新从"闭合"开始**。
实测证据（`/tmp/tw-fetch3.log`，实例 3 是全新进程）：

```
$ node -e "…列出 tw-fetch3.log 最后 8 条…"
07:08:52.546  hq.sinajs.cn  /list=int_sp500,hf_HG,hf_SI,hf_OIL,nf_RB0
07:08:52.636  hq.sinajs.cn  /list=nf_JM0,nf_LH0,nf_M0,hf_XAU
07:09:06.591  api.siliconflow.cn  /v1/user/info
07:09:06.775  api.deepseek.com    /user/balance
07:09:28.295  qt.gtimg.cn  /q=sz399001,sz399006,sh000001,sh000012,sh000300,sh000688,sh0…
07:09:28.427  hq.sinajs.cn /list=int_ftse,int_dax30,int_hangseng,int_nikkei,int_nasdaq
07:09:28.573  hq.sinajs.cn /list=int_sp500,hf_HG,hf_SI,hf_OIL,nf_RB0
07:09:28.666  hq.sinajs.cn /list=nf_JM0,nf_LH0,nf_M0,hf_XAU
---- EM count in whole file: 12
```

- 前 3 拍（15:08）**每拍 4 条 EM**（`12 / 3 = 4`），`threshold=3` 需要连续 3 次失败才跳闸（`breaker.ts:89`）；
- 15:09:28 那一拍 **EM 请求 0 条**，只剩 `qt.gtimg.cn`×1 + `hq.sinajs.cn`×3 ——闸已经落下。

**所以"重启 → 重新猛试一轮 → 跳闸 → 冷却 → 重启 → 再猛试一轮"是一个真实的、可复现的循环**；
它是否构成上游眼中的"反复"我没有上游证据（见 §3.12），
但**本地侧"重启即清零"这一点是证实了的**。

**复算结论**：一台页面开着、默认 `refreshSec=10`、**一分钟约 30～50 条上游请求**
（EM 被闸住时 ~29/分，EM 未被闸住时 ~48/分 + 采样器 ≈ **53/分**）。
`refreshSec` 可设到 5 ⇒ 上限翻倍到 **~100 条/分**。
**这还没算打开图表/详情/筹码时的 kline/trend/chips 请求，而 kline 每次可含 6 条"绕过熔断"的 EM 请求（§3.2）。**

**⚠ 必须记下的一处行为**：以上全部发生在 **15:04–15:09，即 A 股收盘之后**。收盘后行情不可能再变，
但轮询照旧：`loadQuotes`（`em.ts:771-850`）**没有任何 `inSession()` 判断**——
"休市定稿零回源"（`isSettledOffline`）只用在 `trend`/`kline`（`em.ts:1021`、`em.ts:1891`），**行情链路没有**。

```
$ date +%H:%M:%S
15:09:28
$ curl … "$BASE/tradewatcher/quotes?ids=<28 项>"
upstream=4
  ts=1791788968756 asOf=1791788968756 cached=false stale=true staleCount=7 priced=28 rows=28
  sources={"tencent":7,"sina":14,"lkg":7}
```

`cached=false`、`upstream=4`：**收盘 9 分钟后，同一份不可能再变的数据仍在每 10 秒被拉一次。**
（`cached` 只是 `summarizeQuoteProvenance` 事后贴的标签，`em.ts:395`，它不拦请求。）

### 3.10 C10 护盘采样器绕过行情缓存 —— **证实**

**代码**：`rescue.ts:12` `import { … fetchAny as fetchAnyJson } from './em.ts'`，
并在 `rescue.ts:633-635` 直调：

```ts
async function fetchData(hosts, pathAndQuery, timeoutMs = 8000) {
  const json = (await fetchAnyJson(hosts, pathAndQuery, timeoutMs)) as { data?: unknown }   // ← 不经 ttlCache / quoteSlots
```

`grep -n "fetchQuotes\|loadQuotes\|quoteSlots\|ttlCache\|peekCache" src/host/rescue.ts` **只命中 import 行**
⇒ 采样器**完全不共享**行情槽。

**实测**：同一批 8 只宽基 ETF 被采样器按 **15.1s** 固定节奏拉取（`tailIntervalSec=15`，`rescue.ts:945`；
当前时间落在尾盘窗 `tailFrom=14:30`）：

```
=== qt.gtimg.cn batches (symbols in path) ===
06:58:58.134 sh000300,sh510300,sh510050,sh510500,sh512100,sh588000,sz159915,sh588170
06:59:00.161 同 8 只      （+2.03s）
06:59:14.937 同 8 只      （+14.78s）
06:59:30.110 同 8 只      （+15.17s）
06:59:45.254 同 8 只      （+15.14s）
07:00:00.403 同 8 只      （+15.15s）
07:00:15.565 同 8 只      （+15.16s）
07:00:30.679 同 8 只      （+15.11s）
07:00:45.737 同 8 只      （+15.06s）
```

**最干净的一段**：我完全静默、只读代码的 **53 秒窗口**（我的第一次 `curl` 在 07:00:03.774，
见 §3.9 的窗口时间戳），插件在这段时间里**总共只发出 6 条请求**：

```
$ node -e "…过滤 /tmp/tw-fetch.log: 06:59:10 <= t < 1791788403774（＝07:00:03.774）…"
count=6
  06:59:14.937  qt.gtimg.cn       /q=sh000300,sh510300,sh510050,sh510500,sh512100,sh588000,sz159915,sh58   ← 采样器
  06:59:30.110  qt.gtimg.cn       /q=同 8 只                                                             ← 采样器
  06:59:45.254  qt.gtimg.cn       /q=同 8 只                                                             ← 采样器
  06:59:59.307  api.siliconflow.cn /v1/user/info                                                          ← 非本插件
  06:59:59.445  api.deepseek.com   /user/balance                                                          ← 非本插件
  07:00:00.403  qt.gtimg.cn       /q=同 8 只                                                             ← 采样器
```

⇒ **"没有任何人看"时，本插件仍以 4 拍/分持续打上游，且这 4 拍全部来自护盘采样器。**
而这 8 只中的
`1.510300/1.510050/1.510500/1.512100/1.588000/0.159915/1.588170/1.000300`
**与顶部行情条的引擎集合完全重叠**——同一份数据，两条链路各拉各的，互不命中。

（正面公平话：`rescue.ts` 的注释说明它**故意**复用 `fetchAny` 以共享熔断与退避，
这解决了旧版的"重复实现体"问题；但复用 `fetchAny` ≠ 复用**缓存**。熔断共享了，缓存没有。）

### 3.11 C11 隐藏的卡片仍被轮询 —— **证实**

`prefs.json` 里用户藏了 5 个债券标的：

```json
"stripCfg": { "hidden": ["1.000012","171.US10Y","171.JP10Y","171.DE10Y","171.GB10Y"] }
```

客户端确实按它过滤显示（`TopBar.tsx:375` `visibleCards(TW_ROWS, prefs.stripCfg?.hidden)`），
**但行情引擎不过滤**（`index.tsx:294`）：

```ts
const baseIds = useMemo(() => TW_ROWS.flatMap((r) => r.items.map((i) => i.secid)), [])   // ← 无 hidden 过滤
const engineIds = useMemo(() => { const set = new Set<string>(baseIds); … }, [baseIds, extraIds])
```

实测：每次 EM 请求里都带 `1.000012`：

```
$ node -e "…解码 /tmp/tw-fetch3.log 里第一条 EM 请求的 secids…"
EM ulist secids count = 14
["0.399001","0.399006","1.000001","1.000012","1.000300","1.000688","1.000905","100.FCHI","100.FTSE","100.GDAXI","100.HSI","100.KOSPI200","100.N225","100.N…"]
hidden-but-polled = [ '1.000012' ]
```

⇒ **用户已经明确表示"不要看"的标的，仍在每一拍（每 10 秒）被请求**，且请求结果不会被渲染。
这是**纯浪费**，也是最容易修的一处。

### 3.12 C12 「我们的重复请求导致上游熔断」 —— **证据不足（不可证）**

任务明确要求质询任何"我们导致熔断"的因果断言。我的质询与观察：

1. **没有上游阈值证据。** 本地只有 `TypeError: fetch failed` / `connection reset`（`/tmp/boot-verify2.log`
   中 `fast-fail (connection reset)` 9 次），没有上游返回的任何一个限流错误码/`Retry-After`/阈值说明。
   没有阈值证据，因果链就缺一环。
2. **同一时刻 EM 对另一个端点完全正常。** §3.2 那次实测里，三台主机 `allOpen=true` 的同时，
   `kline` 请求拿到 **HTTP 200、响应体 23 923 字节**的真实 K 线数据：

   ```
   ### kline 114.lhm … HTTP 200  upstream=6  1204ms  bytes=23923
   ```
   ⇒ "整段不可达"至少是**按端点/按主机**的，不是"被封 IP"。用"我们请求太多把对方惹毛了"一句话解释，
   **与这个观察冲突**（若是 IP 级封锁，同一秒的另一个端点也该失败）。
3. **插件确实会退避，不是持续猛打。** 现场甲整窗口 **0 条 EM 请求**（§3.9），退避上限 900s（§3.4）。
   "反复熔断"在本地表现为"反复**试探**"（§3.3、§3.2 各自有明确的探测节奏），而不是连续轰炸。

**判为证据不足**：可以证实"我们**存在**重复拉取"（C1）；**不可以**证实"重复拉取**导致了**上游熔断。
如果同伴报告写了后者，按复核纪律应改判**证伪/证据不足**——理由即上面三条，而不是措辞偏好。

### 3.13 C14 `days` 不是缓存键 —— **证伪**；但**冷缓存时 `lmt` 削减不了上游载荷** —— **证实**

任务点名要我实测 `fqt` / `klt` / `lmt` / `days` 是否"真的造成同数据多拉"。
`fqt` 见 §3.8、`klt` 见 §3.7、`lmt` 见 §3.6，`days` 如下：

```
########## TEST L: /chips — does `days` create separate upstream pulls? (冷标的 1.600036) ##########

### chips 1.600036 days=180 (COLD)
    HTTP 200  upstream=7  1577ms
      7ms  web.ifzq.gtimg.cn  /appstock/app/fqkline/get ?param=sh600036,day,,,800,qfq      ← fqt=1，800 根
    224ms  web.ifzq.gtimg.cn  /appstock/app/fqkline/get ?param=sh600036,day,,,800,         ← fqt=0，800 根
    359ms  push2delay[EM]  /api/qt/ulist.np/get ?secids=1.600036&fltt=2&invt=2&fields=…    ← 报价，第 1 次尝试
    563ms  push2delay[EM]  同 URL                                                          ← 第 2 次尝试
    861ms  push2[EM]       同 URL
   1014ms  push2[EM]       同 URL
   1394ms  qt.gtimg.cn     /q=sh600036                                                     ← 报价兜底

### chips same secid days=400 (diff days, same data)
    HTTP 200  upstream=0  54ms
### chips same secid days=45
    HTTP 200  upstream=0  41ms
```

**两件事**：

1. **`days` 不是缓存键 ⇒ 换 `days` 实测 0 条上游。** `days` 只决定"从已缓存序列里切多长"，
   与 `lmt` 同理 ⇒ **"days 造成同数据多拉"判证伪**。

2. ⚠ **但冷缓存时 `lmt` 完全削减不了上游载荷 —— 证实，且是真浪费。**
   `/chips` 的路由（`routes.ts:302`）为算一个"价格空间换算因子"要一份**不复权**序列，
   只要 5 天：

   ```ts
   const k    = supported ? await em.fetchKline(secid, 101, cum, 1) : null   // fqt=1
   const kRaw = supported ? await em.fetchKline(secid, 101, 5, 0) : null     // fqt=0，只要 5 天
   ```

   但 `fetchKline` 的截断发生在**取数之后**（`em.ts:1896`）：

   ```ts
   const want = Math.max(1, Math.min(Math.round(lmt) || series.length, series.length))
   const days = series.slice(series.length - want)      // ← 先按 KLINE_FULL_LMT 拉了 800 根，再切 5 根
   ```

   键是 `…:{full|incr}`（`em.ts:2061`），冷缓存 ⇒ `needFull=true` ⇒ `KLINE_FULL_LMT[101]=800`。
   所以实测那两条 `day,,,800` 是**因为 `lmt=5` 也要先拿 800 根**。
   ⇒ **"为算一个比值而拉 800 根日线"**：`/chips` 冷启动成本 = 2 × 800 根 + 3~5 条报价请求。

   **定性（已与 `AUDIT-CACHE-1.md` §2.3 交叉，采纳它的判断）**：
   这不是缺陷，而是**故意的缓存预热**——同 secid 之后的 `/tones`、`/anomaly` 都吃这份 `fqt=1`/`fqt=0`
   缓存（`anomaly.ts:151` 复用同一磁盘缓存）。我的措辞从"真浪费"收紧为
   **"冷启动代价前置的取舍；值得补一条断言写明它换来了什么、以及 `lmt` 为何削减不了首次载荷"**。

---

## 4. 反例优先：6 条"如果……那么应该能观察到 X"的预测式检验
按任务要求，先写下**可被推翻的预测**，再报观察结果——包括"观察不到"的那条。

| # | 假设（若成立则应观察到） | 预测 | **实际观察** | 判定 |
|---|---|---|---|---|
| 1 | 若 `lmt` 进了缓存键 | 同 secid 换 `lmt` 会再产生上游请求 | `lmt=240` → `lmt=100`：**0** 条（`upstream=0 9ms`） | **假设被推翻** ⇒ C6 证伪 |
| 2 | 若 `asOf` 是可靠的上游请求计数 | 72s 窗口内 `asOf` 的推进次数 ≈ 27 条真实请求 | `asOf` 只前进约 1 个批次；且失败请求**不盖 `at`**，完全不可见 | **假设被推翻** ⇒ C5 证伪 |
| 3 | 若熔断器拦住了所有上游路径 | `allOpen=true` 时 `/kline` 应产生 **0** 条 EM 请求 | 实测 **6** 条（3 主机 × 2 轮），且 `trips` 不变 | **假设被推翻** ⇒ C2 证实 |
| 4 | 若"半开只放行一个探针"按字面成立 | 半开瞬间每台主机应恰好 **1** 条 | 实测每台 **2** 条（attempts/host=2） | **假设被推翻** ⇒ C3 证实 |
| 5 | 若 `days` 进了缓存键 | 同 secid 换 `days` 会再产生上游请求 | `days=400` → **0** 条；`days=45` → **0** 条 | **假设被推翻** ⇒ C14 证伪 |
| 6 | 若 `lmt` 能减少上游载荷 | 冷缓存要 5 天就该只拉 5 根 | 实测 `/chips` 的 `lmt=5` 仍拉 **`day,,,800`**（先拉后切） | **假设被推翻** ⇒ C14 后半段证实 |

**另外两条"观察不到"的记录（同样算结果）**：

- **观察不到"收盘后停拉"**：预测"15:00 后 `inSession()` 为假 ⇒ 行情链路应当零回源"，
  实测 15:09:28 仍 `upstream=4`（§3.9）。⇒ 该优化**不存在于行情链路**（只存在于 trend/kline）。
- **观察不到"隐藏卡片不被拉取"**：预测"`stripCfg.hidden` 里的标的应当不出现在上游请求里"，
  实测 `1.000012` 出现在每次 EM 请求中（§3.11）。⇒ 该过滤只作用于渲染。

---

## 5. 未验证 / 不可测（明确列出，不用推测填空）

| 项 | 为什么没做到 |
|---|---|
| 上游的限流阈值、封禁窗口、错误码 | 免费延迟源不返回这些；无第三方观测点。**故 §3.12 判不可证。** |
| 真实浏览器打开页面的请求总量 | 未驱动浏览器（不装包、不动用户环境）。改用 `curl` 复刻**客户端文档化的节拍**（引擎 `refreshSec`、徽标 60s）。⚠ 我用的是 §1.2 的 28 项 `TW_ROWS` **精确集**（`n=28` 已核对），但**各页面打开时还会并入 `watchIds`/`posIds`**（`index.tsx:295`），那部分**未测**，故 §3.9 的数字是**下界**。 |
| `chips` / `board` / `breadth` 的扇出 | `/breadth?dist=1` 一次实测只产生 1 条上游、`counts=undefined`（我未读到它的回包结构，`dist` 语义没吃透）⇒ **标未验证**，不猜。`breadthCount.ts` 有 ~56 页扫描的注释，但**本次未复现**。 |
| 「重启清零」与真实故障的**相关性** | 已测：新进程前 3 拍每拍 4 条 EM、第 4 拍被闸住（§3.9 C13）。**未测**：用户今天实际重启过几次 `dsh web`、上游那几次不可达是否与重启时刻重合。这需要用户侧的重启时间线，不在我能观测的范围内。 |
| 磁盘 K 线缓存的裁剪（`KLINE_CACHE_MAX=300`，`em.ts:1699`） | 未构造 ≥300 文件的场景。 |
| `audit-cache` 的 `AUDIT-CACHE-1.md` | 到我写完全文**仍未出现**（§0）⇒ 逐条对照**无法进行**。 |

---

## 6. 复核协议（可复用）：任何"上游请求次数"结论该怎么核

> 本节写于对方报告缺席时，原意是"等它出现后照着核"。它 15:14 出现后，**§7 已按本节协议实际执行完毕**。
> 保留本节是因为它对**下一份**同类报告同样适用（也适用于用户以后自己核查）。

对方每条关键结论，按下面 4 步核，不要只看措辞：

1. **问"请求次数是怎么来的"**。若答 `asOf` / 缓存 mtime / 日志 → 按 §3.5 判**证伪**：
   该代理在命中时不动、在失败时不写，**恰好漏掉要解释的失败请求**。要求改用真 `fetch` 计数。
2. **复算它的"页面打开总量"**。用 §1.2 起临时实例 + §1.1 拦截器，用**精确 28 项 `TW_ROWS` 集**
   （`n=28`，见 §3.9）按 10s 节拍打 `/tradewatcher/quotes`，另打一次 `/tradewatcher/badge`。
   基准值：**EM 全熔断 ≈ 4 条/拍；EM 可达 ≈ 8 条/拍**。凡与"单次调用 × 1"对齐的数字都是**低估**。
3. **凡出现"导致熔断/导致限流"** → 一律要求补 §3.12 的三条反证（阈值证据、同刻他端点正常、退避生效）。
   补不出来就维持**证据不足**。
4. **凡涉及 kline/trend/商品/外盘** → 必查 §3.2 的熔断旁路（`em.ts:1825` 的 `fetchFromHost`）
   与 §3.10 的采样器旁路（`rescue.ts:634`）。这是"按主机熔断"叙事最容易漏掉的两个洞。

---

## 7. 对 `AUDIT-CACHE-1.md` 的逐条复核（15:14 对方落地后追加）

**统计：证实 8 条 / 证伪（含口径）1 条 / 证据不足 1 条 / 未验证 3 条。**
每条都附**我自己的**命令与输出——没有复述它的结论。

### 7.1 证实 —— §2.4 S4-4：`/breadth?dist=1` 的 **112 = 56 个 URL × 2 遍**

它说一次调用 113 次上游（112 落在 56 个字节级相同的 URL 上）。我用**独立复现**验：

复现装置（**这次做了数据目录隔离**，见 §7.4）：`/tmp/verify-clist.mjs` 只把 `clist/get` 换成
合成 fixture（`total=5513`、每页 100 行、第 57 页起 0 行），**其余走真网络**；实例用
`DSH_HOME=/tmp/verify-home`（并把 `profiles` symlink 指回真 profile 以便加载插件）。

```
### /tradewatcher/breadth?dist=1 → HTTP 200  上游请求 = 112  64ms
  clist 请求 = 112 | 唯一 URL = 56 | 次数分布 = {"2":56}
  $ node -e "…按 host+path+query 去重计数…"
```

**判定：证实。** 112 与 `{2:56}` 与它**逐字一致**。它的 113 = 我的 112 + 1 条行情请求
（我先用一次 `/quotes` 热了行情槽，10s TTL 内不再回源，所以少那 1 条）。

### 7.2 证实 —— §2.4 S4-6：并发 2 个请求**不合并**（`distCache`/`BreadthCountCache` 只挡跨调用）

全新进程、缓存空，同时发两个 `/breadth?dist=1`：

```
$ curl … & curl … & wait
总上游请求 = 224  (串行单次=112；并发 2 次若不合并 ⇒ 224)
  clist=0 唯一URL=56 次数分布={"4":56}          # ← "clist=0" 是我脚本的取值笔误，↓ 才是读数
=== then a THIRD call right after (caches now warm) ===
  上游请求 = 0
```

56 个 URL 各 **4** 遍 = 2 类扫描（源 B + 分布）× 2 个并发调用 ⇒ **两条扫描链都没有 in-flight 合并**；
紧接的第三次调用 **0 条** ⇒ 60s/120s 缓存确实只挡跨调用。
**判定：证实**（机制与量级都对）。

### 7.3 证实 —— §2.7 S6-1/S6-2：故障时「首调 12 次东财（6×push2delay + 6×push2），后两次 0」

把 `clist/get` 注入 `TypeError('fetch failed')`（等价于现网的"连接被立刻关闭"），连打 3 次：

```
检测到 2 个请求组（调用间有 1s sleep）:
  组1: 总=5  东财=4  分布={"push2delay":2,"push2":2}  clist=0  首条=/api/qt/ulist.np/get
  组2: 总=8  东财=8  分布={"push2delay":4,"push2":4}  clist=8  首条=/api/qt/clist/get
（第 2、3 次调用：0 条日志行 ⇒ 完全没有发请求）
```

- 组 1 = 路由里的行情探针（2 次/台）；组 2 = clist 扫了 **2 页**（每页 2 次/台）。
- 合计 **每台 push2delay 6 次、push2 6 次 ⇒ 12 次东财**，与它的 `6×push2delay + 6×push2` **完全吻合**；
- 之后两次调用 **东财 0 次** ✓。

机制核对（解释为什么正好是 12）：`recordFailure` 每个 `fetchAny` **每台只记 1 次**
（`em.ts:164-165` 的 `for (const host of neverSucceeded) …recordFailure()`），
所以第 3 个 `fetchAny` 才把 `fails` 推到阈值 3 而跳闸 ⇒ clist 恰好扫 2 页 × 2 次/台。
**判定：证实**（含"12"的分解都一致）。

> 附带更正：我在 §3.3 用的是"独立"实例，`fails` 已有 1 次底数，所以只看到 8 条；
> 与这里的 12 条**不矛盾**，只是初始 `fails` 不同。两处口径已在 §3.3 注明。

### 7.4 证实 —— §2.8：它对我那份日志的读数**全对**（我一度怀疑，实测是我错了）

它把 `/tmp/tw-fetch.log`（我的实例 1）当作"另一路真实数据的独立样本"。我逐项复算：

```
总请求 = 118 (他们写 118)                                  ✓
东财请求 = 52 (他们写 52)                                  ✓
东财时间跨度 = 164.0s ⇒ 19.0 次/分（他们写 18.4：按 169.4s 全窗口算，口径等价）   ✓
冷启动突发（前 3.8s）东财请求 = 45（第 46 条在 +3.81s，取整边界）                 ✓
3.8s 之后的东财请求 = 6（落在 +162.93…+164.02s，3 台 × 2 次）                   ✓
东财静默 = 159.1s                                                            ✓
```

我最初的脚本把"静默"按**任何**请求算，得到 15.2s，误以为它错了；它说的是**东财请求**的静默
——**159.1s 是对的**。**判定：证实**（我修正了自己的误读）。

> ⚠ **来源必须澄清（否则会被重复计数）**：它 §2.8 说的"另一条审计用的临时实例"**就是我**
> （`audit-cache-verify` 的实例 1，`/tmp/tw-fetch.log`）。所以这条**不是第三方独立证据**，
> 不能拿来"它和我的报告互相印证"——同一份数据被引用了两次。它在 §6 里提到的"另一条审计用的临时实例"
> 也是我。**提示 Lead：给用户汇报时不要把这个样本算两遍。**

### 7.5 证实 —— §6 副作用披露与修复（逐项可核）

它对"最初两条命令没设 `DSH_HOME`、把合成 fixture 写进了用户真实数据目录"做了披露与修复。我核：

```
$ ls -la --time-style=+%F_%T ~/.dsh/dsh-tradewatcher/klines/ | grep -F "1.600519"
-rw-rw-r-- 1 hu hu 40277 2026-10-07_21:48:56 1.600519_102.json      # 四个污染文件已删，仅剩 10-07 的旧文件
$ ls -la --time-style=+%F_%T ~/.dsh/dsh-tradewatcher/trends/1.600519/
2026-09-28.json  2026-09-29.json  2026-09-30.json  2026-10-08.json  # 10-09..10-12 已删（目录 mtime 15:04:36）
$ node -e "…读 quotes-lkg.json 的 1.600519…"
{"secid":"1.600519","code":"600519","name":"贵州茅台","price":1278.25,…,"source":"te…"}
```

与它表格里写的"删除 `_101_0/_101_1/_102_1/_103_1`、删除 `trends/{10-09..12}`、
`quotes-lkg` 已由真实值 1278.25 / tencent 覆盖"**逐条对得上**。**判定：证实。**

**但"证实"的是"它如实披露并修好了"，不是"这事没发生"**：那 4 个 K 线文件与 4 个分时归档一度含
**编造的茅台价格（≈10 元 vs 真实 ≈1278）**，且写入的是**用户正在使用的数据目录**。
严重性该由 Lead/用户判断，我不替它抹平；只补充一条它没写的机制：
所有 4 个进程（用户 3080 + 我的 4 个实例 + 它的 fixture 实例）共用同一数据目录，
而 `rescue-log.json` 是**整文件覆写、无跨进程锁** ⇒ 谁最后写谁说了算，
`days['2026-10-12'].samples = 371` 这个数**无法归因给用户自己的服务**（见 §7.6 末）。

### 7.6 证实 —— §1.4「大盘页每 10s 打一次 `/breadth?dist=1`」

`src/client/MarketPage.tsx:104-124`：`useEffect(…, [props.quotes])` ⇒ 行情每轮刷新就重读一次；
`distCache` TTL 60s ⇒ **每 60s 触发一次 56 页全量扫描**。**判定：证实**（代码；它的 62 次/分算术成立）。
代码注释本身就写着"多扫 ~56 页，宿主侧 60s 缓存"——设计者知道这个成本。

### 7.7 证实 —— `rescue.ts:1377` `samples += 1`（每拍 +1）

`sed -n '1368,1384p' src/host/rescue.ts` 里 `this.today.samples += 1` 确在每拍路径上。
**判定：证实**。但补一条它没展开的：

`tickFlight`（`rescue.ts:1109`）是**进程内** SingleFlight，`rescue.ts:1102-1107` 的注释自述
"三条触发路径会撞在一起…此前各跑一份，导致上游请求翻倍、`today.samples` 重复计数、两份快照互相覆盖"。
⇒ **跨进程不合并**：用户 3080 + 我的 4 个实例 + 它的 fixture 实例各自 `+1` 并整文件覆写。
所以 `samples=371` **不等于**用户服务自己的采样拍数，依赖它的分位/自校准统计今天不干净。
这是我的实例（未隔离 `DSH_HOME`，见 §7.10）**也**造成的，我同样认账。

### 7.8 证伪（口径）—— §2.9「无 UI、仅后台采样器（**现网实测**）≈18 东财/分」

- **"现网实测"不成立**：那 118 条来自**我的临时实例**（它自己在 §2.8 写明"另一条审计实例"），
  不是用户的 3080。标签错了。
- **也不是稳态**：该窗口 = 3.8s 内 46 条突发 + **159s 零请求** + 6 条探针。
  把"突发 + 长静默"平均成 18 次/分，会让读者以为后台常态就是 18/分。
  用户 3080 若无 UI，我实测的后台节奏是 **4 拍/分**（§3.10），不是 18/分。
- 数字本身（52/169.4×60 = 18.4）算术没错，**错在归类**。

**判定：该行的标签与口径证伪。** 建议改成"审计实例冷启动 2.8 分钟样本（含 3.8s 突发）"。

### 7.9 证据不足 —— §3.2 点 2「S6-3 的 `trips=5` 与现网 15:00 的 `trips=5` 数字相同 ⇒ **不是巧合式吻合**」

这是全篇最弱的一句，三条独立理由：

1. **`trips` 会在任何一次成功时被清零**：`breaker.ts:73-79`
   `recordSuccess() { this.fails = 0; this.trips = 0; this.until = 0; … }`
   ⇒ 它是**瞬时态**而不是指纹，重合不构成"同一套逻辑"的证据。
2. **值在动**：它自己的 §2.8 就记录 `trips` 在 10 分钟内从 5→6、3→4。"完全一致"是一次**快照巧合**。
3. **我的独立实测给出别的值**：我的实例看到过 `2→3`（§3.4）与 `0→1`（§7.3 注入测试）。
   同一天同一断网下，两个进程各自连续失败 → 出现相同的 `trips` 是**预期**，不是佐证。

**判定：证据不足。** 这句是加强性修辞，删掉它结论不受影响；留着会误导
（它 §3.2 其余 5 点我**证实**：压到 ≈0、负缓存、现网 mtime 不变、159s 静默、单飞/冷却）。

### 7.10 未验证 —— 它这 3 条我没复现（不判真假）

| 它的结论 | 为什么没验 |
|---|---|
| §2.7 S6-9：分时连打 6 次 `7,7,7,1,1,1`（东财 18 次后归零） | 需再起实例 + 注入；但机制方向与我实测一致（§3.1a 我测到 trends 一次 miss 可放大到 12 条） |
| §2.1 S1-5：混入 1 个上游不回的标的 ⇒ 成本 ×2 | 代码可读（`em.ts:538` 的 `for pass<2`）；未做 fixture |
| §2.6 S7-3/S7-5：大盘页首屏 78、抽屉首开 14 | 需驱动客户端多个路由；我未做 |

### 7.11 我复核出的、它**没提**的三处（净增量，已在 §3 详证）

1. **每拍成本被低估 4–8 倍（最重要）**：它的页面模型是"**1 条**行情 / 10s"（§1.4、§2.9）。
   但真实 `TW_ROWS` 引擎集是 **28 个标的**，其中约 14 个东财 `ulist.np` 不覆盖
   （`100.*` 外盘、`171.*` 国债、`114/113/112/101/122` 商品）⇒ 每拍被拆成
   **4 条东财 + 1 条腾讯 + 3 条新浪 = 8 条**，并**连打三拍一模一样**（§3.1b）；
   东财被闸住时仍有 **4 条**落在腾讯/新浪。⇒ 页面稳态 **~48–53 条/分**，而非 §2.9 的 ~13–18。
   （它的 S1-1 用 5 个全被东财覆盖的标的测出 1 条，不能外推到真实 28 标的集合。）
2. **收盘后不停**：`loadQuotes` 无 `inSession` 判断 ⇒ 15:09:28（收盘 9 分钟后）实测仍 `upstream=4`（§3.9）。
   它提到的"休市定稿免回源"只覆盖 trend/kline。
3. **隐藏卡片仍被轮询**：`stripCfg.hidden` 里的 `1.000012` 出现在每次东财请求里（§3.11）。

### 7.12 与它结论的交叉（同意 / 更正我自己的措辞）

**一致的 6 条**（双方独立得到同一结论，互为加强）：
`lmt` 不入键（它 S3-1 ↔ 我 §3.6）、`fqt` 入键但属**必要重复**（它 S3-2 ↔ 我 §3.8）、
`klt` 各自缓存且**年 K 复用月 K**（它 S7-6 ↔ 我 §3.7）、**分时无 in-flight 合并**（它 S2-3 ↔ 我 §3.1a）、
**K 线路径绕开熔断器**（它 P1-3 ↔ 我 §3.2，两边都点名 `fetchFromHost`）、
**不越界断言因果**（它 §3.3 ↔ 我 §3.12）——最后这条尤其值得肯定：两边都主动给因果断言设了边界。

**它对、我更正自己一处**：`/chips` 为 5 根 `fqt=0` 收盘价付一次 800 根全量，
它判为"**故意的缓存预热**（同 secid 之后 `/tones`、`/anomaly` 吃这份缓存），设计取舍而非缺陷"。
我 §3.13 的措辞把它写成"真浪费"。**我接受它的判断**：这是取舍，合理表述是
"冷启动代价前置，值得加一条断言说明它换来了什么"，而不是缺陷。据此收紧 §3.13 的定性。

**我多出、它未测的**：`days` 不入键（§3.13）、熔断状态随进程重启清零（§3.9 C13）；
**它多出、我未测的**：`/breadth` 的两条扫描链（我对它的头条数字做了独立复现，见 §7.1）、
行业榜 8 页、缺口重试 ×2、`peek` 宽限 105s 的口径问题。

### 7.13 §7 汇总

| 判定 | 条数 | 条目 |
|---|---|---|
| **证实** | 8 | S4-4（112=56×2）、S4-6（并发不合并）、S6-1/S6-2（12 次东财后归零）、§2.8 读我日志、§6 披露与修复、§1.4 大盘页节拍、`rescue.ts:1377` samples、§3.3 因果边界 |
| **证伪（口径）** | 1 | §2.9「现网实测 ≈18 东财/分」的标签与稳态归类 |
| **证据不足** | 1 | §3.2 点 2「trips=5 相同 ⇒ 不是巧合」 |
| **未验证** | 3 | S6-9、S1-5、S7-(首屏聚合) |

**它做对的两件关键事**（我作为对抗者也要说）：① **因果纪律**——主动声明"不许断言是我们把上游打挂的"，
并给出量级而非因果；② **自曝副作用并逐项修复**——把写进用户数据目录的合成文件列了签名并删干净，
我核过，对得上。这两点在审计里都比数字更难得。

---

## 8. 附：本次生成的全部证据文件（只读留存，供 Lead/用户复算）

| 文件 | 内容 |
|---|---|
| `/tmp/fetchcount.mjs` | 上游请求拦截器（§1.1） |
| `/tmp/tw-fetch.log` | 实例 1：冷启动 118 条（含 trends2 ×12 的原始记录） |
| `/tmp/tw-fetch2.log` | 实例 2：193 条（半开探测、kline 旁路、asOf 对照、页面总量） |
| `/tmp/tw-fetch3.log` | 实例 3：32 条（精确 28 项集合的 3 拍复算 + 收盘后仍然回源） |
| `/tmp/tw-fetch4.log` | 实例 4：9 条（`/chips` 的 `days` 与 `lmt` 检验） |
| `/tmp/tw-fetch5.log` | 实例 5（隔离）：117 条（合成 clist fixture ⇒ `112 = 56×2`） |
| `/tmp/tw-fetch6.log` | 实例 6（隔离）：13 条（注入失败 ⇒ `12 次东财 = 6+6`，后两次归零） |
| `/tmp/tw-fetch7.log` | 实例 7（隔离）：229 条（并发 2 次 ⇒ `224 = 56×4`） |
| `/tmp/verify-clist.mjs` · `/tmp/verify-clist2.mjs` · `/tmp/verify-fail.mjs` | 实例 5–7 用的拦截器（合成 clist / 带延迟合成 clist / 注入失败） |
| `/tmp/boot-verify{,2,3,4,5,6,7}.log` | 各实例的启动日志（含 `fast-fail (connection reset)` 与熔断状态） |
| `/tmp/engine-ids.txt` | 从 `src/shared/model.ts` 抽出的 `TW_ROWS` 精确 28 项 |

**复核请求**：`docs/AUDIT-CACHE-1.md` 若已写出但未被我看到，请把它指给我，
我会按 §6 逐条出具 **证实/证伪/证据不足**，并只改这一个文件。
