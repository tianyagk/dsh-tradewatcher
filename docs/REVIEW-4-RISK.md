# REVIEW-4-RISK —— 全项目 review 的**缺陷与风险复核**（对抗式，只读）

- 基线：`main` @ `802a48f`（v0.89.0，门禁 659 × 2 时区）。**工作区当时是脏的**（另一名 teammate 在做
  v0.90.0「宏观历史回填」，见 §0.4），所以我的**权威结论一律对 HEAD 取证**：实验树 = `git archive HEAD`
  解到 `/tmp/rev-gate`。
- ⚠ **复核期间 HEAD 移动了**：21:47:07 落了 `c32bc59`（v0.90.0）。我**没有**把结论留在旧基线上——
  §9 在 v0.90.0 上**逐条复验**了关键项（结论全部仍然成立），并给出 v0.90.0 的门禁实测（661/661/0）。
  `robotsGate.ts` / `lock.ts` / `uiuxDiscipline.test.ts` / `lock.test.ts` / `rescueContradiction.test.ts`
  **在 v0.90.0 里未被改动**（`git diff --stat 802a48f c32bc59 -- <这些文件>` 为空）⇒ 引用它们的结论原样有效。
- 我的角色：**对抗式复核员**。任务不是复述，是**推翻**。每条给 **证实 / 证伪 / 证据不足 / 未复现**，
  附自己的命令与输出。
- 边界（严格遵守）：**只读** `src/**`；**不 commit / 不装 / 不动 profile / 不重启服务**；
  **未在工作区跑 `npm run build`**；一切实验在 `/tmp/rev-*`；读真机数据目录**只读**（脚本里只有 `readFileSync`）。
- 唯一写入面：本文件。

**一行结论**：**抖动未复现**（20 次门禁 + 24 次定点，零失败）；但**反向注入有 5/21 条没被抓住**，
其中 3 条落在 v0.89.0 新加的「robots 门禁 + 预算」上；**「gatedFetch 是宏观请求唯一入口」这句文档与注释
双双被代码证伪**（仍有 2 条裸 `fetch` 的宏观链路，含**实时主源**）；数据侧无 `days:{}` / `purged` 冲突，
但 `quotes-lkg.json` 有 46/130 行缺 `source`（契约外残留）。
**这四条在复核期间新落的 v0.90.0 上全部复验仍成立**（§9）。

---

## 0. 方法与现场（可复现）

### 0.1 隔离的 HEAD 实验树

```bash
cd /home/hu/workspace/Servers/dsh/Dev/dsh-tradewatcher
git archive HEAD | tar -x -C /tmp/rev-gate
ln -s "$PWD/node_modules" /tmp/rev-gate/node_modules
cd /tmp/rev-gate && node -e "console.log(require('./package.json').version)"   # → 0.89.0
find src -name '*.test.ts' | wc -l                                             # → 89 个测试文件
```
基线一次门禁：`ℹ tests 659 / pass 659 / fail 0 / duration_ms 24187`（24s/次）。

### 0.2 反例注入 harness（`/tmp/rev-inject.mjs`）

每个注入：`cp -a` 干净树 → 改坏**实现**（不是改测试）→ 跑指定测试文件 → 判 exit code。
**语义**：改坏实现后测试**必须变红**；仍绿 = 该断言抓不住这类回归。

### 0.3 真机数据目录只读抽样

`/tmp/rev-data2.mjs` 只做 `readFileSync` + `statSync`，不写任何文件。

### 0.4 ⚠ 现场是脏的（必须知道）

`git status` 在我复核期间变了两次，`src/host/globalFlow.ts` 是**正在被另一名 teammate 编辑**的文件：

```
21:45  M src/client/api.ts  M globalFlowView.ts  M globalFlow.ts  M 两个 test  ← 当时含一行
        `const inSession = true  // 注入：假装这里套了 A 股交易时段口径`（见 §1.4）
21:46  M docs/AUDIT-IMPL55.md  M ...（+ 新文件 docs/REVIEW-5-PRODUCT.md）
```
所以凡涉及工作树的数字都标了时刻；**对 HEAD 的结论不受影响**。

---

## 1. 抖动定位（悬案「v0.82.0 发布时一次 610/611」）—— **未复现**

### 1.1 跑了多少遍（矩阵）

| 组 | 次数 | 结果 |
|---|---|---|
| 默认时区 | **6** | 659/659/0 |
| `TZ=UTC` | **6** | 659/659/0 |
| `TZ=Pacific/Kiritimati`（UTC+14）、`Pacific/Midway`（UTC−11）、`America/New_York`、`Asia/Kolkata` | **4** | 659/659/0 |
| **CPU 满载**下的整门禁（3 个同等优先级燃烧进程，4 核机） | **4** | 659/659/0 |
| **合计整门禁** | **20 次** | **零失败** |
| 定点：`lock.test.ts` 单跑（无载 12 / nice 载 8 / 同等优先级载 4） | **24 次** | 零失败 |

```bash
$ for f in /tmp/rev-gate/jit-*.log; do grep -E "^ℹ (tests|pass|fail)" $f | tr '\n' ' '; echo; done
ℹ tests 659 ℹ pass 659 ℹ fail 0       ← 12 份日志全部这一行
$ grep -l "✖" /tmp/rev-gate/jit-*.log /tmp/rev-gate/tz-*.log 2>/dev/null || echo NONE
NONE
```
**判定：未复现**（20 次整门禁 + 24 次定点，含极端时区与 CPU 满载）。因此**失败用例名无法给出**——
一次都没红。下面对「可能的根因」做的是**候选定位 + 压力反证**，不是复现结论。

### 1.2 候选根因 A（我认为最像）：`lock.test.ts` 的**绝对毫秒上界**

```ts
// src/host/lock.test.ts:199
assert.ok(elapsed >= 200 && elapsed < 1_500, `超时必须在 timeoutMs 附近（实测 ${elapsed}ms），不能死等也不能立刻放弃`)
```
这条断言测的是「250ms 锁超时」的真实墙钟，上界写成**绝对 1500ms**。它依赖子进程 IPC
（`waitUntil(() => out.text.includes('held'))`）+ 定时器，是全仓**最容易被调度延迟打穿**的一条。
我在 `/tmp` 副本里给它插了一行 `console.log` 量分布：

```
无载（8 次）：      ELAPSED=265 303 383 333 324 293 353 310
nice 载（6 燃烧进程，4 核超订 8 次）： 361 374 361 451 324 409 303 359
同等优先级载（3 燃烧进程，4 次）：      399 374 461 335
```
**实测最大 461ms，离 1500ms 还有 3.3× 余量。**
**判定：证据不足**——机制上它是全仓最像的一次性抖动源（绝对时间上界 + IPC + 定时器），
但我**没能**在 4 核机上把它压到 1500ms；真机当时是否另有更重的负载（编译、浏览器、别的 gate）我无法复现。

### 1.3 候选根因 B：测试用了**跨运行共享的固定临时目录**

```ts
// src/host/rescueContradiction.test.ts:10
process.env.DSH_HOME = process.env.DSH_HOME ?? '/tmp/rescue3-contra-home'
```
这是全仓唯一一个**硬编码共享**的 `DSH_HOME`（其余测试用 `freshHome()`/mkdtemp 式唯一路径）。
共享目录意味着：**上一次运行的残留状态会影响下一次**，且**两个并发门禁会互踩**。
```
$ ls -la /tmp/rescue3-contra-home/
ls: 无法访问 '/tmp/rescue3-contra-home/': 没有那个文件或目录     # 当前不存在（每次用完没留）
```
**判定：证据不足**（潜在风险，未复现）。缓解事实：该文件只 `import` 纯函数
（`scoreRescue` / `RESCUE_CALIBRATION`，见 `grep -n "readFile|writeFile|dataHome" rescueContradiction.test.ts` → 无输出），
**不真的读写文件** ⇒ 目前只是"看着危险"。一旦该用例将来加文件断言，就会变成真抖动源。

### 1.4 一个**观察到但已消失**的红线（时间戳证据）

21:45 我在工作树里读到 `macroRaws()` 内有一行：
```ts
const inSession = true // 注入：假装这里套了 A 股交易时段口径
if (!inSession) return { us10y: null, dxy: null, notes: [] }
```
而门禁里有一条**源码扫描**断言：
```ts
// src/host/globalFlow.test.ts:1360
assert.equal(/inSession|inTradingSession|tradingDayState|isTradingDay/.test(block), false, '宏观取数不许套 A 股休市/交易时段口径')
```
我按同样形态做了注入 **I20** 并跑真测试：
```
$ node --test --experimental-strip-types src/host/globalFlow.test.ts
ℹ tests 31 / pass 30 / fail 1
✖ ⑤ 宏观两档：新浪双源真值 + 自采样给"较上日/5 日变化" + 缺数据给原因（不写 0）
```
⇒ **该断言是有效的**；也就是说，**21:45 那一刻的工作树若被提交，门禁会是红的**。
（21:46 复查时那行已被编辑者移除；21:46:38 的工作树快照跑门禁 = **661/661/0 绿**。）
**判定：证实**（机制已实测）；**对"当时是否真的红"**我不下断言（我没在那一刻跑门禁）。

### 1.5 修法建议（按性价比）

1. **把绝对时间上界换成相对判据**（`lock.test.ts:199`）：不要断言 `elapsed < 1_500`，改成断言
   「**明显早于持有者释放**」——如 `elapsed < holdMs - 500`（持有者 2500ms），或断言
   「抛的是 `LockTimeoutError` 且**未写入**」（后半句现在已有，且是真正重要的那半句）。
   绝对 ms 上界在 CI 上是**必然**的偶发红源。
2. **`rescueContradiction.test.ts:10` 换成唯一目录**（`mkdtempSync(join(tmpdir(),'tw-contra-'))`），
   消除跨运行/跨并发共享状态。
3. **把"抖动狩猎"变成可执行目标**：`npm run test` 后接一个 `N` 次循环 + 失败名落盘的脚本
   （我这次用的 `/tmp/rev-gate/jitter.sh` 即可），至少让下一次 610/611 能留下**用例名**。
   目前仓库**没有**任一机制记录"哪条用例红过"。
4. **`--test-reporter` 归位**：`--test-reporter=tap --test-reporter-destination=<file>` 在本机
   （node v24.16.0）**没有产出文件**（见 §1.6 复现）；要留证只能重定向 stdout。建议别依赖它。

### 1.6 复现命令

```bash
# 整门禁矩阵（约 20×24s）
bash /tmp/rev-gate/jitter.sh          # 6 默认 + 6 UTC
bash /tmp/rev-gate/tz.sh              # 4 个极端时区
# 定点压力（在 /tmp 副本里，已插 ELAPSED 打印）
cd /tmp/rev-load && node --test --experimental-strip-types src/host/lock.test.ts
```

---

## 2. 断言强度抽样：**21 条反向注入，16 抓住 / 5 逃逸**

方法见 §0.2。每条都是**改坏实现**（不是改测试），跑对应测试文件，看是否变红。

### 2.1 抓住的 16 条（抽样）

| # | 改坏了什么（实现） | 被哪条测试抓住 |
|---|---|---|
| I01 | 详情页字号 `12.5 → 13.2`（阶梯外） | `uiuxDiscipline.test.ts ①` |
| I02 | `TOOL_SPACE.sectionGap 22 → 22.5` | ② 间距刻度 |
| I03 | 卡片栅格 `minmax(148px,1fr) → 100px` | ③ 自适应卡片 |
| I04 | 浅色档玻璃令牌抄成深色档 | ④ 玻璃令牌 |
| I05 | 关闭态 `display:none → visibility:hidden` | ⑤ 动效纪律 |
| I06 | `@keyframes` 里动 `background` | ⑤ 动效纪律 |
| I07 | 根节点 `data-idle` 改名（断线） | ⑦ 接线 |
| I08 | 样式里贴竞品涨跌色 `#f22423` | ④ 红线 |
| I10 | 蛋糕温度 `mean → max` | `globalFlowView.test.ts`（2 条红） |
| I11 | robots「最长模式优先」`> → <` | `robotsGate.test.ts ②` |
| I12 | `gatedFetch` 拿掉 robots 判定 | `globalFlow.test.ts ⑤` |
| I13 | `HOST_BUDGET_MAX 5 → 500` | `robotsGate.test.ts ④` + `globalFlow.test.ts ⑤` |
| I18 | `withFileLock` 对 `macro-log.json` 直通（去掉锁） | `globalFlow.test.ts ⑤`（**见下注**） |
| I19 | robots 解析结果丢弃（`rules = []`） | `globalFlow.test.ts ⑤` |
| I20 | 宏观块里加 `inSession` 分支 | `globalFlow.test.ts ⑤`（§1.4） |
| I21 | 预算窗口失效（`used` 不按窗口过滤） | `robotsGate.test.ts ③` |

> **I18 的诚实注脚**：它确实红了，但失败信息是
> `AssertionError: 兜底来源不许改变变化量口径（实得 0）  0 !== 7`——
> 即"加锁直通"把**读-改-写往返**搞坏了，而不是有一条断言在守"这把锁"。
> 仓库**没有**针对 `macro-log.json` 并发写的回归测试（changelog 自称"实测 fire-and-forget 写会互相覆盖、
> 历史曾被空 `days` 覆盖"这类 bug 无守护）。⇒ 只能算**偶然抓住**。

### 2.2 **逃逸的 5 条**（这才是本项的价值）

#### ✗ I14 —— 成功请求**不记账**（删掉 `opts.budget.spend(host)`）

```bash
# 注入：src/host/robotsGate.ts 里 `  opts.budget.spend(host)\n` → `  void 0\n`
$ node --test src/host/robotsGate.test.ts src/host/globalFlow.test.ts
→ 两个文件都 GREEN（ESCAPED）
```
**为什么抓不住**：唯一的预算测试是**单元级**的——它自己手写 `budget.spend(host)` 再断言 `used()`：
```
src/host/robotsGate.test.ts:49:    budget.spend(host)
src/host/robotsGate.test.ts:51:    assert.equal(budget.used(host), HOST_BUDGET_MAX)
```
另一条（`globalFlow.test.ts` ⑤）是**预置**一份 `req`（直接塞 5 个时间戳）再断言"第 6 次零请求"。
**没有任何测试检查"一次成功的 `gatedFetch` 会让 `req` 增加"** ⇒ 计数器可以静默停止计数，
`5 次/小时` 的纪律存在**完全失效且全绿**的路径。这是本项**最严重**的一条。

#### ✗ I15 —— robots 的 `$` 结尾锚点可被静默废掉

```bash
# 注入：`const anchored = pattern.endsWith('$')` → `const anchored = false`
→ robotsGate.test.ts + globalFlow.test.ts 都 GREEN（ESCAPED）
```
**为什么抓不住**（我直接对比了变异前后的真实返回）：
```
ORIGINAL:  "/private$" vs "/private" → true      ← 锚点的**判别性**行为
MUTATED:   "/private$" vs "/private" → false     ← 行为确实变了
两者都是:  "/api/*.csv$" vs "/api/v3/x.csv?rows=2" → false   ← 而测试只测这一条
```
测试挑的输入（`/api/*.csv$` vs 带查询串的路径）在**两种实现下都返回 false**，
所以它**靠巧合通过**，证明不了锚点在生效。
**后果**：像 `Disallow: /somepath$` 这样的规则一旦锚点失效就**不再拦 `/somepath`**，
插件会去请求 robots 明令禁止的路径——而这正是 v0.89.0 对用户承诺的纪律。

#### ✗ I16 —— **ECB 宏观链路可以摘掉门禁而无人发现**

```bash
# 注入：把 fetchEcbEurUsd 里的 gatedFetch 换成裸 fetch（Treasury 仍留 gatedFetch）
$ node --test src/host/globalFlow.test.ts src/host/robotsGate.test.ts
src/host/globalFlow.test.ts: GREEN (未抓到)
src/host/robotsGate.test.ts: GREEN (未抓到)
```
**为什么抓不住**：⑥ 的源码扫描只要求 `gatedFetch(` **在宏观块里出现过**：
```ts
// src/host/globalFlow.test.ts:1444
assert.ok(macroBlock.includes('gatedFetch('), '宏观取数必须走 gatedFetch（robots 门禁 + 预算）')
```
Treasury 仍然走 `gatedFetch` ⇒ 字符串存在 ⇒ 断言恒真。而 ⑤ 的 robots 拒绝用例**只桩了
Treasury 那一条 URL**（`daily-treasury-rates.csv`），ECB 路径**没有被任何 robots 用例覆盖**。

#### ✗ I17 —— 新增一条**完全没过门禁**的宏观源，全绿

```bash
# 注入：在 macroRaws() 里加
#   void fetch('https://brand-new-macro.example.com/series.csv').catch(() => undefined)
$ node --test src/host/globalFlow.test.ts src/host/robotsGate.test.ts
→ 两个文件都 GREEN（ESCAPED）
```
同 ⑥ 的盲区：这条断言**数不到"多了一条源"**，只在 `gatedFetch` 字样**整体消失**时才红。

#### ✗ I09 —— README「数据文件表必须覆盖每个 `.json`」的覆盖范围是**硬编码的 8 个文件**

```ts
// src/client/uiuxDiscipline.test.ts:161
const hosts = ['store.ts','globalFlow.ts','marketExtras.ts','rescue.ts','breadth.ts','calendar.ts','fetchDedupe.ts','em.ts']
// :174  assert.equal(real.length >= 8, true, …)     ← 只校验"扫到 ≥8 个"，不校验"hosts 表是完整的"
```
```bash
# 注入：往 src/host/chips.ts 加一个 'brand-new-cache.json' 字面量
$ node --test src/client/uiuxDiscipline.test.ts
→ GREEN（ESCAPED）
```
**后果**：以后新增一个落盘文件、只要它写在**这 8 个文件之外**（或写法不是单引号小写字面量），
README 就会再次与真机不符，而这条号称"必须覆盖每个 `.json`"的断言**不会红**。

### 2.3 小结

- **抓住率 16/21（76%）**，覆盖 UI 纪律、KPI 纯函数、大多数门禁逻辑，质量在同类项目里属上游。
- **5 条逃逸有共同形状**：**"存在性/字符串包含"型断言**（`includes('gatedFetch(')`、硬编码 hosts 列表）
  与**单条输入的等价类断言**（`$` 锚点只测一个两端同为 false 的输入）。
  这类断言的失效模式**不是"恒真"**（作者显然想过恒真问题，都配了反例注入），
  而是**"覆盖不足但看起来像在守"**——外层的"注入 N/N 全抓"因此**高估了实际防护面**。
- 修法方向：把"存在性扫描"换成**"数一遍"**（例如断言宏观块里 `fetch(` 的**调用点数**等于
  `gatedFetch(` 的调用点数），把 `$` 锚点用**判别性输入**（`/private$` vs `/private`）来测，
  给 `gatedFetch` 补一条"成功 ⇒ `req` +1"的行为断言。

---

## 3. 文档与真机/代码不符（核对 `docs/AUDIT-IMPL5*.md`、`docs/DESIGN-*.md`）

| # | 文档声明（原文） | 代码/真机事实 | 判定 |
|---|---|---|---|
| **D1** | `docs/AUDIT-IMPL55.md:224`：「**门禁**（`src/host/robotsGate.ts`，宏观请求的**唯一入口** `gatedFetch`）」；`src/host/robotsGate.ts:152` 注释同样写「**宏观取数唯一入口**」 | HEAD 的宏观链路共 4 条取数，其中 **2 条不走门禁**：`globalFlow.ts:1294` `fetch('https://hq.sinajs.cn/list=globalbd_us10yt,DINIW')`（**US10Y/DXY 的实时主源**）、`globalFlow.ts:1394` `fetch('https://push2delay…secids=171.US10Y,100.UDI…')`（交叉核对） | **证伪** |
| **D2** | `README.md:211`：`write-log.json` =「写操作日志：**每次写入**的 `by`/反向操作/是否已撤销」 | 唯一调用点是 `src/host/tools.ts:831`（日历新增工具）；`writeLog.ts:11-16` 的 `UndoAction.kind` **只有** `'calendar.remove'`。工具自己的描述是对的（"**目前是日历事件的新增**"，`tools.ts:851`）。且真机目录里**没有** `write-log.json` | **证伪（措辞过宽）**；连带解释了该文件为何不存在 |
| **D3** | `docs/DESIGN-UIUX-ADOPT.md:118`：「新增断言"表必须覆盖宿主代码里的**每个** `*.json` 字面量"」 | 断言只扫**硬编码 8 个** host 文件（`uiuxDiscipline.test.ts:161`），且只匹配单引号小写字面量；I09 实测可被绕过（§2.2） | **证伪（断言能力被夸大）**；该批**真的**补了 README 3 行（`trading-calendar/global-flow/market-extras` 现已在表里）这一半是**证实** |
| **D4** | `docs/AUDIT-IMPL55.md:7`：`652 测试 × 两时区` / build 标 `(v0.87.0)`；`:58-59` 同 | 当前 HEAD 基线 **659 × 2**；该文档描述的是 v0.88.0 批次却挂 v0.87.0 标签 | **证实不符（陈旧数字/版本标签）**——低危，但会让"文档数字 ↔ 门禁数字"对不上 |
| **D5** | `docs/AUDIT-IMPL55.md` §②：「宿主层 `macroRaws()` **没有任何** `inSession`/`tradingDayState` 分支（断言直接扫源码块，注入 K8 必败）」 | HEAD 实测**成立**（该块无这些标识符）；我另做的 I20 注入也**确实红**（§1.4） | **证实** ✅ |
| **D6** | `docs/DESIGN-UIUX-ADOPT.md:108`：「字号阶梯本批只收敛**详情页**，其余界面仍混用 9–11.5px」 | 测试确实只扫 `ToolsPage.tsx` / `toolDetailTheme.ts` / `.#tw-tool-*` 三处（`uiuxDiscipline.test.ts:66-79`） | **证实**（自述边界准确）✅ |
| **D7** | `README.md` 数据文件表（18 行） | 真机目录 14 项；表里 4 个文件**真机不存在**：`trading-calendar.json`、`market-extras.json`、`macro-archive.json`、`write-log.json` | **证据不足**——这 4 个都是**惰性创建**（分别由 `calendar:check`、扩展行情取数、`npm run macro:archive`、日历新增触发），"表里有、机器上没有"本身不算错；但 `write-log.json` 叠加 D2 的措辞问题，读起来会误导 |

---

## 4. 上游纪律（`robotsGate` 覆盖 / 裸 `fetch` 增量 / `macro-log.json` 加锁）

### 4.1 结论：门禁**没有**覆盖每个宏观链路 —— **证伪**

```bash
$ git show HEAD:src/host/globalFlow.ts | grep -n "fetch(" | grep -v gatedFetch
1294:    fetch('https://hq.sinajs.cn/list=globalbd_us10yt,DINIW', {
1394:      fetch('https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=171.US10Y,100.UDI&fltt=2&invt=2&fields=f2,f12', {
$ git show HEAD:src/host/globalFlow.ts | grep -n "gatedFetch(url"
1396:    const got = await gatedFetch(url, { budget, timeoutMs: 15000 })    # 美国财政部
1369:async function fetchEcbEurUsd(…){ … gatedFetch(url, { budget, timeoutMs: 12000 })   # ECB
```
4 条宏观取数链路：**2 条过门禁（Treasury / ECB）、2 条不过（新浪实时主源 / 东财交叉核对）**。

**出错分支也查了**：两条裸 `fetch` **都**包在 `withHostBreaker(...)` 里（`hq.sinajs.cn/macro`、`push2delay…/macro`
独立熔断键），且各自 `if (!res.ok) throw`，**熔断记账是有的**；缺的是 **robots.txt 与「≤5 次/小时」预算**。
⇒ 两条链路的**请求频率完全不受预算约束**：
- 实时主源 `hq.sinajs.cn` 每次 `macroRaws()` 都会打（缓存只在 `macro-log` 自采样层，不在 HTTP 层）；
- 东财交叉核对每次也会打（失败只记 `transient` 说明）。

**实测旁证（真机 `macro-log.json`，只读）**：`req` 里只有 Treasury 与 ECB 两个主机：
```
req[home.treasury.gov] len=1 窗口内=1
req[data-api.ecb.europa.eu] len=1 窗口内=1
```
**新浪与东财主机完全不出现在 `req` 里**——即"预算账本"根本没有这两家的记录。这是 D1 的现场证据。

### 4.2 裸 `fetch` 增量 —— **证实（无新增）**

```bash
$ git show 802a48f -- '*.ts' | grep -E "^\+.*(await )?fetch\("
+    fetch(`https://${host}/robots.txt`, … )            # robotsGate.ts:97  （robots 自身，天然不可门禁，已包 withHostBreaker）
+    fetch(url, … )                                     # robotsGate.ts:176 （gatedFetch 本体）
$ git show 802a48f -- '*.ts' | grep -E "^-.*(await )?fetch\("      # 删除的：无
```
⇒ v0.89.0 **没有**在门禁之外新增任何裸 `fetch`。§4.1 的两条是 **v0.88.0 遗留**，本批给它们加门禁时漏掉了。

全仓裸 `fetch(` 现共 **24 处**（含 `robotsGate.ts` 自己的 2 处与 `breakerFetch.ts` 注释里的 2 处示例）：
```
$ grep -rn "\bfetch(" src/host/*.ts | grep -v "\.test\.ts" | grep -v gatedFetch | cut -d: -f1 | sort | uniq -c | sort -rn
      5 src/host/tencent.ts        4 src/host/marketExtras.ts   3 src/host/sina.ts
      2 src/host/robotsGate.ts     2 src/host/rescue.ts         2 src/host/globalFlow.ts
      2 src/host/em.ts             2 src/host/calendar.ts       2 src/host/breakerFetch.ts
```
扣掉 `robotsGate.ts`（robots.txt 本身 + gatedFetch 本体，天然如此）与 `breakerFetch.ts`（JSDoc 示例，非可执行）
⇒ **实际"裸"的 20 处**，分布在腾讯/新浪/东财/日历/护盘/扩展行情。
而 `breakerFetch.ts` 的文件头注释仍写「**四个文件里的 14 处裸 `fetch(`**（新浪/腾讯/日历/护盘原语）」。
逐个复算该注释点名的 4 个文件：`sina 3 + tencent 5 + calendar 2 + rescue 2 = 12`（注释写 14），
另有它没提的 `marketExtras 4 + em 2 + globalFlow 2 = 8` ⇒ **实际"裸"的 20 处、跨 7 个文件**。
**判定：证伪（注释里的计数与范围都过时，且现状比注释更广）**——低危，
但会让"还有多少没接熔断器"的判断偏乐观。

### 4.3 `macro-log.json` 的写是否都在文件锁内 —— **证实（唯一写者已加锁）**，但守护不足

```bash
$ git show HEAD:src/host/globalFlow.ts | grep -n "writeMacroSample\|updateJsonLocked"
1259:export async function writeMacroSample(day: string, sample: …)   ← 唯一写者
1267:    await updateJsonLocked(
$ grep -rn "macro-log" scripts/*.mts        # 后台归档脚本不写 macro-log
（无输出）
```
- `updateJsonLocked`（`src/host/lock.ts:470`）= `withFileLock`（真跨进程锁）+ `readJsonForUpdate` + `writeJsonAtomic`，
  语义正确（锁内读-改-写）。
- 外加 `macroGuard` 读守卫：本进程读不到文件时**拒绝写回**（`globalFlow.ts:1260`），防止用空文件覆盖历史。
  **判定：证实**（这一条是本批做得最扎实的修复）。
- ⚠ 但**守护不足**（见 §2.2 I18）：没有针对"并发写不互相覆盖"的回归测试；
  唯一的红是"往返坏了"的副作用。建议补一条**两个 writer 并发 → 两条都保住**的断言。
- 另一处细节（非缺陷，供决策）：`gatedFetch` 是**先 `spend` 后 fetch**（`robotsGate.ts:174-176`），
  所以**失败的请求也吃预算**。方向保守（宁可少发），但意味着"上游全挂时 5 次预算会被失败请求耗尽"，
  与注释里"超限 ⇒ 等窗口重置"一致。若希望"只有成功才计数"，需改成成功后 `spend`。

---

## 5. 数据完整性（真机 `~/.dsh/dsh-tradewatcher/*.json`，**只读**抽样）

方法：`/tmp/rev-data2.mjs`（只有 `readFileSync`/`statSync`）。**第一版脚本误报了两条，已按真实 schema 修正**，
过程保留在 §5.3——这正是"看着对"最容易骗人的地方。

### 5.1 lead 点名的三类，逐条给结论

| 检查 | 结果 | 判定 |
|---|---|---|
| **`days: {}` 空壳** | `global-flow.json` days=3（10-13/14/15）、`macro-log.json` days=1（10-15）、`breadth.json` days=1、`rescue-log.json` days=23 —— **没有任何文件是空 days** | **证伪**（不存在该类记录） |
| **`purged` 与 `days` 冲突** | `global-flow.json`：`purged=[{day:2026-10-12,scope:null},{day:2026-10-13,scope:"v2:cn,hk,us"}]`，`days=[10-13,10-14,10-15]`，文件 `scope="v3:pref:cn,hk,us,jp,kr"`。10-13 **两边都出现**，但 `purged` 条目带 `scope` 字段 = 作废的是**旧口径**那一条，`days` 里的是**新口径重采**。代码侧同源：口径变更时 `globalFlow.ts:800-807` 把旧 days 整批搬进 `purged` 并清空 days | **证伪**（不是冲突，`scope` 已消歧；我的首版脚本忽略了 `scope`，属**我的误报**） |
| **`req` 计数异常** | `req[home.treasury.gov]=[t]`、`req[data-api.ecb.europa.eu]=[t]`：各 1 条，窗口内 1，**无未来时间戳、无非数值、无空数组、无越限（>5）** | **证实（无异常）**；但见 §4.1——**账本里缺新浪/东财两家**，这不是"计数异常"而是"覆盖不全" |

### 5.2 抽样中**真实**发现的（含严重度）

| 严重度 | 文件 | 发现 | 证据 |
|---|---|---|---|
| **中** | `quotes-lkg.json` | **46/130 行没有 `source` 字段**（35%）。其中 3 行属已退役 `int_*` 集合（会被主动作废），**另 43 行是普通标的**：`116.02155`、`2.H30184`、`1.204001`、`1.000015`、`1.510310`、`0.159919` …（有价、有 `at`，只是没出处） | `node -e …` 分类统计 |
| **中** | `trends-lkg.json` | **5.19MB / 111 条**，7 个键点数 >400（最大 943），21 个键 >3 天未更新；文件**无大小上限**，且每次取数后**整份重写**（5s 节流）⇒ 常驻写放大 | `statSync` + 逐键统计 |
| 低 | `board-lkg.json` | 16 条里 **9 条 >24h 未刷新**（兜底榜只增不减，上限 40、10s 节流） | 同上 |
| 低 | `calendar.json` | 同步于 **6.9h 前** > 自称 6h TTL ⇒ 下次打开会重同步（自愈，非缺陷） | 同上 |
| 低 | `klines/` | **197/300** 文件、覆盖 93 个 secid（接近裁剪上限，正常） | `readdirSync` |

**关于 `quotes-lkg.json` 缺 `source` 的准确定性**（我查到了机制，避免误报成"契约违规"）：
- 文件里的**存储行**可以没有 `source`；但 `fillLastGood`（`em.ts:479-500`）在**服务时**会给兜底行
  盖 `source:'lkg'`：`rows.set(secid, { ...good, secid, source: 'lkg' })`。
- 缺 `source` 的成因是 `em.ts:282` 加载时**原样收下**旧行（只补 `at`），随后 `persistLastGood`
  又整份写回 ⇒ **历史 schema 残留被永久保留**，永远不会被清理。
- **影响**：界面/接口契约**不**被违反（服务时补 source）；但从**文件**做出处审计时，
  `sources` 计数会**只覆盖 84/130 行**，35% 的行在账外。**判定：证实（数据卫生问题，非用户可见缺陷）**。
- 修法：`loadLastGood` 里给缺 `source` 的行补 `source:'legacy'`（或直接丢弃），一行改动即可让文件回到契约内。

### 5.3 首版脚本的两条**误报**（保留，作为"看着像缺陷"的样本）

1. `[ERR] ledger.json · 186 条流水缺 kind` → 实际字段是 **`verb`**，且取值全在
   `store.ts:60-63` 的合法集内：`{gcreate:2, add:25, buy:97, gmove:3, sell:46, remove:13}`。
   我第一版**自己编了一个 verb 白名单**（因为 `grep "interface LedgerEntry"` 取空了），于是把合法值报成非法。
2. `[ERR] global-flow.json · purged 与 days 冲突` → 见 §5.1 第 2 行，忽略了 `purged[].scope`。

⇒ 两条都是**我的**误报。教训写在这里：数据校验器**必须先读真实 schema**，否则"发现"全是自己的假设。

---

## 6. 最严重的 3 条（按"能被利用/会静默失效"排序）

1. **预算可以静默失效而全绿**（§2.2 I14）。删掉 `gatedFetch` 里的 `opts.budget.spend(host)`，
   两个相关测试文件**全绿**：`robotsGate.test.ts` 手写 `spend` 测单元、`globalFlow.test.ts` 预置 `req` 测上限，
   **没有一条断言"成功的请求会让计数 +1"**。⇒ v0.89.0 对用户的承诺「每主机 ≤5 次/小时」存在
   **完全失效且无告警**的回归路径。影响面：宏观取数纪律（这正是本批的卖点）。
2. **「宏观请求唯一入口」不成立**（§3 D1 + §4.1）。HEAD 有 2 条裸 `fetch` 的宏观链路不过门禁，
   其中 `hq.sinajs.cn/list=globalbd_us10yt,DINIW` 是 **US10Y/DXY 的实时主源**；
   真机 `macro-log.json.req` 里**只有 Treasury 与 ECB**，新浪/东财两家根本没进预算账本。
   ⇒ robots 合规与限流只覆盖了 4 条链路里的 2 条。文档与代码注释**双双**断言"唯一入口"，会误导后续维护者。
3. **`$` 结尾锚点可被静默废掉**（§2.2 I15）。`robotsPatternMatch` 的锚点开关改成 `false` 后测试仍绿
   （因为唯一相关用例挑的输入在两种实现下都返回 `false`）。⇒ 形如 `Disallow: /x$` 的规则会
   **不再拦截 `/x`**，插件可能去请求 robots 明令禁止的路径，且**没有任何断言会红**。

> 附带第 4 条（不属于"最严重"但值得排期）：`trends-lkg.json` 5.19MB 无上限、每 5s 整份重写（§5.2）。

---

## 7. 未验证 / 不可测（明确列出，不用推测填空）

| 项 | 为什么 |
|---|---|
| **610/611 的确切失败用例名** | 20 次整门禁 + 24 次定点**零失败**，一次都没红 ⇒ 无法给出用例名。要定位只能在**下一次抖动时**留下 reporter 输出（§1.5 建议 3） |
| v0.82.0 发布时刻的真实机器负载 | 已过去 2 天；当时是否有编译/浏览器/并发门禁，无从观测 |
| `--test-reporter-destination` 为何不产出文件 | 本机 node v24.16.0 实测：加了 `--test-reporter=tap --test-reporter-destination=/tmp/x.tap` 后文件不存在、输出仍到 stdout。**未深究**（改用重定向绕过） |
| I09/I14/I15/I16/I17 在生产期的**实际**触发概率 | 我只证明"改坏不会被抓"（断言强度），没有也**无法**量化"多久会有人这么改" |
| 真机 `macro-log.json` 之外的历史文件（`macro-archive.json` 等 4 个） | 真机不存在（惰性创建），无法校验内容 |
| 新浪/东财两条宏观链路的**实际**调用频次 | 需要长时间采样；`req` 不记它们，日志只在宿主 console。**未测** |

---

## 8. 复现命令（全部只读 + `/tmp`）
```bash
# 0) 隔离的 HEAD 树（别在工作区 build）
git archive HEAD | tar -x -C /tmp/rev-gate && ln -s "$PWD/node_modules" /tmp/rev-gate/node_modules

# 1) 抖动矩阵
bash /tmp/rev-gate/jitter.sh        # 6 默认 + 6 UTC
bash /tmp/rev-gate/tz.sh            # 4 个极端时区
#   定点 + 打点观察（副本里插了 ELAPSED 打印）
cd /tmp/rev-load && node --test --experimental-strip-types src/host/lock.test.ts

# 2) 反向注入（21 条，16 抓住 / 5 逃逸）
node /tmp/rev-inject.mjs            # I01–I17
node /tmp/rev-inject2.mjs           # I16 修正 + I18/I19/I21
node /tmp/rev-i16.mjs               # I16（ECB 摘门禁）单独跑

# 3)+5) 数据只读抽样
node /tmp/rev-data2.mjs

# 4) 上游纪律
git show HEAD:src/host/globalFlow.ts | grep -n "fetch(" | grep -v gatedFetch
git show 802a48f -- '*.ts' | grep -E "^[+-].*(await )?fetch\("
```

---

## 9. 在 v0.90.0（`c32bc59`）上的**复验** —— 关键结论全部仍然成立

复核进行到一半（21:47:07）HEAD 从 `802a48f` 移到 `c32bc59`（v0.90.0）。我把实验树换到新 HEAD 重跑：

```bash
$ rm -rf /tmp/rev-gate90 && mkdir -p /tmp/rev-gate90 && git archive HEAD | tar -x -C /tmp/rev-gate90
$ ln -s "$PWD/node_modules" /tmp/rev-gate90/node_modules
$ cd /tmp/rev-gate90 && node -e "console.log(require('./package.json').version)"   # → 0.90.0
$ node --test --experimental-strip-types "src/**/*.test.ts" | grep -E "^ℹ (tests|pass|fail)"
ℹ tests 661 / pass 661 / fail 0            ← v0.90.0 基线：661（比 v0.89.0 的 659 多 2 条）
```

**逐条复验（`node /tmp/rev-inject90.mjs`）**：

```
I14 ESCAPED  成功请求不记账（删 budget.spend）        ← §2.2 / §6 第 1 条
I15 ESCAPED  robots $ 锚点失效                      ← §2.2 / §6 第 3 条
I16 ESCAPED  ECB 链路摘掉门禁（裸 fetch）            ← §2.2
I17 ESCAPED  新增一条完全不过门禁的宏观源             ← §2.2
```

**为什么能原样沿用**（`git diff --stat 802a48f c32bc59 -- <file>` 全为空）：
`src/host/robotsGate.ts`、`src/host/lock.ts`、`src/client/uiuxDiscipline.test.ts`、`src/host/lock.test.ts`、
`src/host/rescueContradiction.test.ts` **v0.90.0 未改动** ⇒ I14/I15/I18/I19/I21/I09/I05 等原样有效。
v0.90.0 只动了 `globalFlow.ts` / `globalFlow.test.ts` / `globalFlowView.*` / `api.ts` + 文档；
两条断言在 v0.90.0 里**行号都没变**（`globalFlow.test.ts:1360` 与 `:1444`）。

**D1（§3 / §4.1）在 v0.90.0 依然成立**（这是要点）：
```
$ grep -n "fetch('https://hq.sinajs.cn/list=globalbd" src/host/globalFlow.ts
1345:    fetch('https://hq.sinajs.cn/list=globalbd_us10yt,DINIW', {      ← 仍是裸 fetch
$ grep -n "async function crossCheckEastMoney" src/host/globalFlow.ts
1454:async function crossCheckEastMoney(…                                   ← 仍是裸 fetch
$ grep -n "gatedFetch(url" src/host/globalFlow.ts
1396 / 1428                                                            ← 只有 Treasury 与 ECB 过门禁
```
v0.90.0 的 commit message 说"修两个真 bug"，修的是**温度「较上日」索引写反**与
**断言遍历不存在的 `kpi.cells`（判据为空）**——**都不是**门禁覆盖问题。

### 9.1 一条强佐证：v0.90.0 自己踩了同一类坑

v0.90.0 的 commit message 里有一句**主动披露**：

> 「断言第一版遍历了并不存在的 `kpi.cells` ⇒ **判据是空的**（K23 一度没被抓到），改为按标签遍历后立即变红。」

这与我 §2.3 的诊断**是同一失效模式**（"看起来在守、实际判据为空/覆盖不足"），
而且是**本批作者自己发现的第三个实例**。⇒ §2.3 的结论不是我一家之言：
**"注入 N/N 全抓"这类自评会系统性高估防护面**，因为注入脚本与被注入的断言往往出自同一人对系统的同一理解。

### 9.2 对 Lead 的行动建议（按顺序）

1. **先补 §6 第 1 条的行为断言**（一行）：`gatedFetch` 成功后断言 `budget.used(host)` 递增。
   这是唯一一条"改坏了也全绿、且直击本批卖点"的洞。
2. **把 §2.2 的 5 条逃逸做成回归注入**（它们现在就是可执行的注入脚本）。
3. **给两条裸 `fetch` 的宏观链路补 `gatedFetch`**（或明确写进文档"新浪/东财实时链路过熔断但**不过 robots/预算**"，
   把 §3 D1 的措辞改对）。
4. **v0.89.0 → v0.90.0 的文档数字同步**（659/661、版本标签），避免"文档数字 ↔ 门禁数字"继续漂移。
