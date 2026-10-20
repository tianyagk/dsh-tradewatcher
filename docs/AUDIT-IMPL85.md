# AUDIT-IMPL85 —— 移除护盘「跨日信号收件箱」

> 版本：v0.112.0 工作区（**未 bump 版本号**，见 §8）
> 主题：把 v0.110.0 交付的「跨日信号收件箱」整块移除（用户判定该功能无用），
> 保留同一批交付里的「覆盖广度」与面板既有功能。
> 门禁基线：**934 用例 × 2 时区 + 构建 73 项** → 本次为 **933 用例 × 2 时区 + 构建 73 项**。

## 0. 结论

收件箱的**五处实现**（界面区块 / 纯视图模块 / prefs 契约 / 宿主归一与写入分支 / 样式）全部删除，
源码与构建产物里不再出现它的任何特征串；同批的「覆盖广度」与「今日信号时间线」「`?day=` 历史回看」
等保留项**未被连带删除**，且各有守门判据与反例注入。`build.mjs` **未改动**。

## 1. 先查后动：`build.mjs` 锁定片段

```bash
$ grep -n "收件箱\|最近一次信号\|只列疑似\|未存盘" build.mjs
（无输出，exit 1）
$ grep -n "收件箱\|最近一次信号\|只列疑似\|未存盘\|rescueInbox" build.mjs
（无输出，exit 1）
```

**未命中** ⇒ 已确认 `build.mjs` 的 73 条锁定片段里没有任何一条引用收件箱文案，不需要动锁定表；
`git status` 亦确认 `build.mjs` 未被修改。

## 2. 移除清单（逐文件）

`git diff --numstat`（插入 / 删除，均为工作区改动，未提交）：

| 文件 | 插入 | 删除 | 移除内容 |
| --- | --- | --- | --- |
| `src/client/rescueInbox.ts` | 0 | 317 | **整文件删除**：`inboxViewOf` / `mergeInboxEvents` / `sortInboxEntries` / `inboxReadMapOf` / `markInboxRead` / `pruneInboxRead` / `lastSignalTextOf` / `retainInboxEvents` / `dayDiffOf` / `shiftDayOf` / `inboxEntryId` / `inboxEntryTitleOf` / `INBOX_CALIBER` / `INBOX_SHORT_HINT` / `INBOX_RETAIN_DAYS` / `INBOX_MERGE_MS` / `INBOX_MIN_LEVEL` |
| `src/client/RescuePanel.tsx` | 1 | 196 | ① 收件箱的 import 语句（9 个符号）+ `import type { InboxEntry, InboxEvent }`，并把随之失效的 `shToday` 从 `marketTime` 的 import 里去掉；② `InboxRow` 组件、`READ_PERSIST_FAIL_NOTE`；③ 状态 `inboxDays` / `inboxFail` / `inboxAsked` / `aliveRef` / `readPersistNote`（`aliveRef` 只服务于收件箱的按天取数，随之删除，含它的卸载 effect）；④ `inboxDayList` / `inboxDayKey` / 按天取数 effect / `inboxEvents` / `inboxRead` / `inbox` / `inboxPending`；⑤ `markRead`（写 `rescueInboxRead` 偏好）与 `retryInboxDays`；⑥ 渲染区块：标题「信号收件箱（未读 N · 近 30 天）」、列表上方「只列疑似护盘及以上…」常驻声明、「全部已读」按钮、「还有 N 天历史未回」、「已读状态本次未存盘」提示、「历史事件未取到 N 天 + 重试」、列表本体、取数中分支、空态「最近一次信号在 X 天前 · 本期统计」（`data-role: rescue-inbox-empty`） |
| `src/shared/model.ts` | 0 | 10 | `PortPrefs.rescueInboxRead?: Record<string, number>` 与其口径注释；`DEFAULT_PREFS.rescueInboxRead: {}` |
| `src/host/store.ts` | 0 | 30 | ① 装载归一 `rescueInboxRead: normalizeRescueInboxRead(loaded.rescueInboxRead)`；② `applyPrefsPatch` 的 `if (patch.rescueInboxRead !== undefined) …` 分支；③ `export const RESCUE_INBOX_READ_MAX` + `export function normalizeRescueInboxRead`（宽容归一 / 键数上界 2000） |
| `src/client/styles.ts` | 0 | 4 | `.tw-rescue-inbox` / `.tw-rescue-inbox-row` / `.tw-rescue-inbox-row:hover` 与它们的注释（只服务收件箱；`.tw-rescue-cov` 保留） |
| `src/client/impl81.test.ts` | 27 | 286 | **逐条甄别**后删除原 ③（不与等级 0/1 混箱）、④（等级优先排序）、⑤（5 分钟合并 + 得分取最大）、⑥（已读写 prefs、不写 rescue-log）、⑦（空态「最近一次信号在…」+ 本期统计）**五条用例**及其 9 个只服务收件箱的测试侧判据函数/夹具（`inboxLevelProblems` / `orderProblems` / `fnBlockOf` / `readWriteProblems` / `inboxPendingGuardProblems` / `emptyTextProblems` / `ev()` / `stripComments` / `READ_AT`）；保留 ①/①b/②（覆盖广度）与原 ⑧，⑧ 只把**被检查的类名与模块清单**收窄到 `.tw-rescue-cov` / `rescueCoverage.ts`（另补两条阶梯/animation 反例注入，见 §5） |
| `src/host/impl80.test.ts` | 2 | 106 | 删除原 ⑪（`rescueInboxRead` 白名单写/读 + 源码级分支断言）、⑫（非法值宽容丢弃 + 键数上界裁剪），连带删除只服务这两条的 `prefsHarness()`、`STORE_SRC`、`import type { IncomingMessage, ServerResponse }`；⑬ 去掉收件箱夹具行与对应断言，补一条 `prefs.theme` 判据（防止用例空跑） |

合计：**7 个文件，+30 / −949 行**；另新增 2 个判据文件（§4）。

## 3. 保留清单（不要顺手删的东西 → 现在被谁守着）

| 保留项 | 守门判据 |
| --- | --- |
| **今日信号时间线** | `impl85.test.ts` ②：标题 `今日信号时间线（${snapshot.today.length}）`、`snapshot.today.map(`、`className: 'tw-rescue-timeline'`、每行带 `e.hhmm`、样式 `.tw-rescue-timeline{`；**数据链路**由 `host/impl85.test.ts` ② 证明（见 §5） |
| **`?day=` 历史回看** | `impl85.test.ts` ②：`api.rescueDay(day: string)`、`/tradewatcher/rescue?day=`、`const openHistory = (day: string)`、`历史回看（${data?.history.length ?? 0} 天…` |
| **覆盖广度徽标与悬停** | `impl85.test.ts` ③：`rescueCoverage.ts` 存在、`CoverageMark`、`tw-badge tw-rescue-cov`、`data-role: rescue-coverage-badge`、`tabIndex: 0`、`.tw-rescue-cov{`；另有原 `impl81.test.ts` ①/①b/②/⑧ 全套（含反例注入） |
| **等级 / 连续评分 / 近 20 日分位 / 当日峰 / 口径与边界悬停 / 5 分钟抽样 / 历史回看列表** | `impl85.test.ts` ④：`RESCUE_LEVEL_LABEL`、`continuousPercentile`、`当日峰 ${peakToday`、`data-role: rescue-caliber`、`今日 5 分钟抽样（${snapshot.intraday.length}）`、`tw-rescue-history`，每个锚点都配"删掉即失败"的注入 |
| **`impl80.test.ts` ①–⑩（覆盖广度阶段一/阶段二、四因子权重 0.717、零新增请求）** | 原样保留，未改名未放宽 |
| `.tw-rescue-cov` 样式与字号阶梯纪律 | `impl81.test.ts` ⑧（收窄清单，强度不变） |

## 4. 用例数变化

| 文件 | 前 | 后 | 说明 |
| --- | --- | --- | --- |
| `src/client/impl81.test.ts` | 9 | 4 | −5（原 ③④⑤⑥⑦）：只删收件箱用例；覆盖广度用例逐条保留 |
| `src/host/impl80.test.ts` | 13 | 11 | −2（原 ⑪⑫）；⑬ 保留并补 1 条断言 |
| `src/client/impl85.test.ts` | — | 4 | 新增（移除扫描 + 保留项守门） |
| `src/host/impl85.test.ts` | — | 2 | 新增（prefs 旧键宽容 + 今日时间线数据链路） |
| **合计（每时区）** | **934** | **933** | 934 − 7 + 6 = 933 |

实测：`npm run check` 两轮，每轮 `ℹ tests 933 / ℹ pass 933 / ℹ fail 0`（默认时区 + `TZ=UTC` 各一遍），
`built lib/index.js + lib/client.js（v0.112.0，客户端片段校验通过：73 项）`，两轮 `exit=0`。
**构建 73 项未变**（没有动 `build.mjs`，也没有删掉任何被锁定的片段）。

## 5. 断言 / 注入读数

### 5.1 ① 源码与产物零残留（运行时源码 + 构建产物）

扫描集合 = `src/**/*.ts` `src/**/*.tsx`（**排除 `*.test.ts`**，理由见下）+ `lib/index.js` + `lib/client.js`，
特征串 = `收件箱` / `最近一次信号在` / `只列疑似护盘及以上` / `rescueInboxRead` / `rescueInbox` / `INBOX_` /
`tw-rescue-inbox` / `rescue-inbox-empty`。实测命中 **0**（源码 134 个文件；两个产物文件均存在并被扫到）。

> 为什么排除测试文件：`src/host/impl85.test.ts` 必须能拼出旧键名才能模拟"删不掉的老 `prefs.json` /
> 老客户端 patch"；`impl81.test.ts` / `impl85.test.ts` 的标题与注释也要说明"这里删了什么"。
> 这是**唯一**允许出现这些字面量的地方（3 个 `*.test.ts`），运行时源码与产物里一个字都不留
> —— 旧键名在用例里由局部常量 `LEGACY_KEY` 承载。这条排除**不是放宽**：注入 D 证明塞回运行时源码
> 必被抓到，注入 E 证明产物里的残留同样必被抓到。

真实源码注入（每次跑完都从备份还原，还原后 4/4 绿）：

| 注入 | 做法 | 读数 |
| --- | --- | --- |
| **INJ-A** | 往 `RescuePanel.tsx` 追加一行 `// 注入：信号收件箱`，并把时间线标题改成 `'信号收件箱（注入）'` | `✖ ①`（pass 3 / **fail 1**） |
| **INJ-D** | 往 `store.ts` 追加 `export const RESCUE_INBOX_READ_MAX` + `export function normalizeRescueInboxRead` | `✖ ①`（pass 3 / **fail 1**） |
| **INJ-E** | 只往 `lib/client.js`（**产物**）追加 `// 信号收件箱（注入产物）`，源码不动 | `✖ ①`（pass 3 / **fail 1**），报文 `lib/client.js 出现「收件箱」` |
| 还原 | 覆盖回备份 | `pass 4 / fail 0` |

产物半边的边界规则（写死在用例里）：`lib/` 被 `.gitignore` 忽略、且 `npm run check` 的 `build` 排在
`test` 之后 ⇒ **产物存在就必须干净**；一个产物都没有时才只扫源码（实测：把 `lib/` 移走后
`pass 4 / fail 0`，这是"没有字节可残留"，不是给旧产物开后门）。交付前 `npm run build` 后
`grep -c "收件箱\|rescueInbox\|INBOX_" lib/index.js lib/client.js` ⇒ `0 / 0`。

### 5.2 ② 今日时间线仍在且能取到数据

- 结构：`impl85.test.ts` ② 五个锚点全中；注入（删掉标题 + 容器类名 + 渲染循环 / 改掉样式类）⇒ `✖ ②`（pass 3 / **fail 1**）。
- **数据**：`host/impl85.test.ts` ② 用 `Date.now` 钉在 **2026-10-19（周一）10:00 北京**、往
  `rescue-log.json` 的 `days['2026-10-19']` 种 2 条事件 + 1 个抽样点，`RescueMonitor.init()` 后
  `snapshot()` 读到 `today.length === 2`、`hhmm === ['09:55','09:45']`（新事件在前）、`today[0].level === 2`、
  `intraday.length === 1`。逐条读数是**真数据流**，不是断言常量。
- 注入：同一判据喂给一份**空日志**的 monitor ⇒ `today.length === 0`，且 `assert.throws`（"取到 2 条"必须失败）。

### 5.3 ③ 覆盖广度徽标仍在

`impl85.test.ts` ③ 五个锚点全中；注入（删掉 `data-role: rescue-coverage-badge` 与 `CoverageMark`）⇒
`✖ ③`（pass 3 / **fail 1**）。`rescueCoverage.ts` 文件未被任何改动触及（`git status` 里没有它）。

### 5.4 ④ 旧 `rescueInboxRead` 键不得让读取或写回失败（宽容忽略）

`host/impl85.test.ts` ④ 三种情形，全部实测：

| 情形 | 结果 |
| --- | --- |
| 老 `prefs.json` 里旧键 = 已读时间戳表（v0.110–v0.112 的真实形状） | `init()` 不抛错；`theme: 'dark'`、`rescue.rescueCoverageEnabled: true`、`stripCfg: {hidden: []}` 均照常；`setPrefs({theme:'light'})` 成功且新实例读回落盘值 |
| 老 `prefs.json` 里旧键 = 坏形状字符串 `'broken'` | `init()` 不抛错；`prefs` 结构完好；**老客户端**发来 `{theme:'dark', 旧键:{…}}` 的 patch ⇒ 不 reject，且 `theme` 生效（旧键被忽略，不连坐整包） |
| 反例注入：`setPrefs({ theme: 'bogus' })` | 必须 `rejects(/theme 必须是/)` —— 证明上面两条的"不抛错"有来源，不是判据失效 |

已知残留（**有意不处理**）：宿主的装载归一用 `{...DEFAULT_PREFS, ...loaded}`，所以老 `prefs.json` 里那个
死键会**原样留在明文文件里**（客户端既不再读也不再写它）。要清掉它必须在运行时源码里点名这个键，
那与"源码零残留"直接冲突；而做通用的未知键裁剪会碰前向兼容（新客户端的偏好会被老宿主删掉）。
按任务口径"宽容忽略即可"，选择保留死数据、不实现裁剪。

### 5.5 既有纪律未被放宽

- `impl81.test.ts` ⑧ 的阶梯 / 字号 / 无 `animation` / 无 `transition` / 1px 刻度判据**强度不变**，
  另外补了两条注入（`font-size:11px`、`animation:blink` 必须被抓到），原先覆盖 `INBOX_CALIBER` /
  `INBOX_SHORT_HINT` 的"悬停挂全文、可见只短句"那一段随该功能一起删除。
- `impl80.test.ts` ①–⑩（四因子权重合计 0.717、阶段一附加分恒 0、零新增请求、逐因子权重不变）**一字未改**。
- 零新增依赖：`package.json` / `package-lock.json` 未改；新判据只用 `node:test` / `node:assert` / `node:fs`。
- 没有用空数组 / `0` 顶替缺失：本改动以**删除**为主，未新增任何"缺失即 0"的显示路径。

## 6. 文档

- `README.md` / `docs/DESIGN-*.md`：**没有**收件箱的现状段落
  （`grep -rn "收件箱\|rescueInbox\|收件\|inbox" README.md docs/DESIGN-*.md locale/` ⇒ 无命中），
  因此无需改动。唯一提到收件箱的文档是**历史审计**与 CHANGELOG。
- `docs/AUDIT-IMPL80.md` / `docs/AUDIT-IMPL81.md` / `CHANGELOG.md`：按约束**不改写**（历史记录）。
  它们描述的收件箱已不存在，指路本文件。

## 7. 复现

```bash
cd /home/hu/workspace/Servers/dsh/Dev/dsh-tradewatcher
npm run build                    # 产物与源码对齐（产物扫描要求"存在即干净"）
npm run check                    # 两轮：默认时区 + TZ=UTC，各 933 用例；build 73 项
grep -rn "收件箱\|最近一次信号在\|只列疑似护盘及以上\|rescueInbox" src/ lib/ | grep -v "\.test\.ts"
```

## 8. 未做项 / 归 Lead 处理

1. **版本号与 CHANGELOG 未动**（本任务未要求发版；`package.json` 仍是 `0.112.0`，构建输出也照旧打
   `v0.112.0`）。按仓里惯例这次改动可能对应 v0.113.0，但 bump 会带动 `package-lock.json` 与 CHANGELOG
   的机械改动，属于发布动作 ⇒ 留给 Lead。
2. **历史审计文档**（AUDIT-IMPL80 / AUDIT-IMPL81）与 CHANGELOG 仍描述收件箱 —— 按约束不改写。
3. 老 `prefs.json` 里的死键不做清理（理由见 §5.4）。
4. 未 commit、未安装、未动 profile、未重启 `dsh web`；所有实验用临时目录（`mkdtemp` 到 `/tmp`），
   未写入 `~/.dsh`。
