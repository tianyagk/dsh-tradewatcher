# AUDIT-IMPL81：护盘「覆盖广度」展示（阶段一）+ 跨日「信号收件箱」

- **实施时刻**：2026-10-19 20:05 起（Asia/Shanghai）
- **起点**：`e7e29f9`（v0.109.0；门禁基线 **868 用例 × 2 时区** + 构建 **73 项**）
- **分工**：宿主侧字段（`RescueCoverage` / `rescue-log` 落盘 / `prefs.rescueInboxRead` 白名单）由 `impl-cov-host` 实施；
  **本报告只覆盖客户端**（`src/client/**`），未改动任何 `src/host/**`、未动 `build.mjs`。
- **用户要求**：① 护盘面板给「覆盖广度」的**常驻短标记** `3 族 · 5/6`，完整口径与门槛**只进悬停**；
  ② 用现有护盘历史做**跨日信号收件箱**（30 天 / 只留未读 / 等级优先排序 / 5 分钟合并取最大 / 已读写 prefs / 空态给"最近一次信号在 X 天前"）。
- **纪律**：不新增依赖、不 commit、不装、不动 profile、不重启 `dsh web`；实验隔离 `DSH_HOME=/tmp/covui-*`；未手工写 `~/.dsh`。

---

## 0. 结论（一行）

面板主线与时间线每行都给出了 `3 族 · 5/6` 形态的短标记（算不出来是 `—` + 原因，**没有一处用 0 顶替**），三族归属 / `z ≥ 2` / 两个确认档读数 / 「阶段一未计入评分」全部在 `title`+`aria-label` 里；跨日收件箱按「30 天 · 只留未读 · 等级优先 · 5 分钟合并取最高分」落地，已读只写 `prefs.rescueInboxRead`，空态给「最近一次信号在 X 天前（日期）· 本期（30 天）N 天有信号 / M 条」；**门禁两轮全绿（890 用例 × 2 时区）+ 构建 73 项**。

---

## 1. 覆盖广度：短标记 + 悬停（任务一）

| 位置 | 文件:行号 | 内容 |
| --- | --- | --- |
| 短标记唯一实现（面板组件） | `src/client/RescuePanel.tsx:369-384` | `CoverageMark`：常驻子节点**只有** `badge.marker`；`title`/`aria-label` 放完整口径，`tabIndex:0`+`role:'note'`（键盘与读屏都能读到） |
| 短标记/口径唯一实现（纯函数） | `src/client/rescueCoverage.ts:74-87`（`coverageMarkerOf`）、`:140-199`（`coverageBadgeOf`）、`:90-121`（`coverageMissingOf`） | `marker = 「<nFamily> 族 · <confirm1N>/<nEtfWithData>」`（例 `3 族 · 5/6`）；某半段算不出来 ⇒ 那半段 `—`；两半都算不出来 ⇒ 整个 `—` |
| 本拍读数取值 | `src/client/rescueCoverage.ts:201-213`（`latestCoverageOf`）+ `RescuePanel.tsx:451` | 优先 `snapshot.coverage`；老宿主退回**最新一条**带 `coverage` 的事件（`today` 是倒序） |
| 主线落点 | `RescuePanel.tsx:696-699` | 紧随等级徽标之后（`3 族 · 5/6`） |
| 今日时间线每条 | `RescuePanel.tsx:1074` | 同一实现，每条事件一枚 |
| 历史回看每条 | `RescuePanel.tsx:1370`（`DayModal` 经 `coverageEnabled` 透传） | 同上 |
| 样式 | `src/client/styles.ts:502` | `.tw-rescue-cov{font-size:12px;…}`（字号在 12/12.5/13/13.5/14 阶梯内、无动画） |

**悬停里逐条都在**（实测输出见 §4）：三族归属（`families[]` 原样）、`触发通道（z ≥ 2）：N 条`、`有读数的通道：M 条`、
`确认档 1（方向一致性）：强一致/一致/不一致；同向通道 K 条`、`确认档 2（30 年国债 ETF 反向读数）：-0.42`、
族口径句、同刻度 z 公式、以及 **`覆盖广度当前未计入评分（阶段一）`**。
开关 `rescueCoverageEnabled=true` 时该句自动改口成 `覆盖广度附加分已开启（阶段二）` —— 那时继续说"未计入评分"就是假话。

**缺失处理（红线）**：`coverage` 整块缺失 ⇒ `—` +「宿主未提供覆盖广度（阶段一字段）」；单键缺失 ⇒ 点名该键；
`nEtfWithData = 0`（基线不足，合法数据态）⇒ 那半段显示 `—` 并说明"分母不成立"，**不写 `0/0`**。

---

## 2. 跨日「信号收件箱」（任务二）

| 规格 | 实现 | 文件:行号 |
| --- | --- | --- |
| 保留 30 天 | `INBOX_RETAIN_DAYS = 30`；候选天来自 `history(30)`，事件再按自然日窗口过滤 | `src/client/rescueInbox.ts:23`、`:190-198` |
| 只留等级 ≥ 2（见 §6 取舍） | `INBOX_MIN_LEVEL = 2`；等级 0（平静）与 1（资金异动）都不入箱 | `src/client/rescueInbox.ts:34`、`:110-119` |
| 只留未读 | `read[id] !== undefined` ⇒ 从列表剔除；**统计仍算它**（"我看过"≠"没发生"） | `src/client/rescueInbox.ts:289-290` |
| 等级优先 + 同级时间倒序 | `sortInboxEntries`：`b.level - a.level \|\| b.startTs - a.startTs` | `src/client/rescueInbox.ts:161-163` |
| 5 分钟合并 + 计数 | 先按（天, 等级）分组，再以**窗口起点**为锚扫 5 分钟窗（`INBOX_MERGE_MS`） | `src/client/rescueInbox.ts:110-159` |
| 合并后得分取**最大** | `if (ev.score > cur.score) cur.score = ev.score`（注释写明"不是最新值"） | `src/client/rescueInbox.ts:139` |
| 已读写 prefs | `api.setPrefs({ rescueInboxRead })`；乐观更新 + **回读校验**；宿主没接受 ⇒ 顶部如实写「已读状态本次未存盘（宿主未接受该偏好）」 | `RescuePanel.tsx:660-673`、`:403` |
| 空态 | `最近一次信号在 X 天前（日期） · 本期（30 天）：N 天有信号 / M 条（最高 …）`；日志不足 30 天时说「自采样起只有 N 天日志」。**历史还在路上时先给「收件箱取数中（还剩 N 天历史未回）」，不报空态**（否则会先说"30 天前以外"，是假否定） | `src/client/rescueInbox.ts:237-255`、`:301-315`；渲染 `RescuePanel.tsx:1126-1155`；取数中守卫 `RescuePanel.tsx:651-653`、`:1145-1148` |
| 数据来源（不新增路由） | 今天＝`snapshot.today`；历史＝现成的 `/tradewatcher/rescue?day=`（只取 `maxLevel ≥ 2` 的天、串行、按天缓存、失败可见 + 「重试」） | `RescuePanel.tsx:590-600`、`:602-624`、`:625-634` |
| 保留窗口裁剪已读键 | `pruneInboxRead` 按 **id 里的日期前缀** 裁（不是"当前列表里还在不在"，否则取数失败一轮会造出幽灵未读） | `src/client/rescueInbox.ts:225-235` |
| 不做 | 无推送（无 `Notification`）、无红点、无 animation/transition（不闪烁）、零新依赖 | 断言见 §3 ⑧ |

列表形态：`[等级徽标] MM-DD HH:mm [×N] … 68 分 [已读]`；悬停说明"窗口起止 + 合并了几条 + 得分取窗口内最高（不是最新）"。
收件箱标题/列表的 `title` 挂**口径全文**（`INBOX_CALIBER`），可见那行只放**短句**（`INBOX_SHORT_HINT`）。

---

## 3. 断言与反例注入（`src/client/impl81.test.ts`，9 条 × 2 时区）

| # | 断言 | 反例注入（必败） |
| --- | --- | --- |
| ① | 短标记 == `3 族 · 5/6`、≤12 字、不含 `未计入/评分/口径/阈值/z ≥/，/；/族 =/宿主`；悬停含三族、`z ≥ 2`、两档读数、"阶段一未计入评分"；面板常驻子节点只有 `badge.marker` | (a) 把整段口径当常驻 ⇒ 判据非空；(b) 源码把可见子节点换成 `badge.title` ⇒ 判据非空 |
| ①b | 客户端读的 7 个键与宿主 `RescueCoverage` 契约**同名同序**；快照上 `coverage/coverageWhy/coverageEnabled` 仍在 | —（跨文件同步：改一处不改另一处 ⇒ 红） |
| ② | 整块缺失 ⇒ `—` + 原因；部分缺失 ⇒ 只影响那半段并点名键；`nEtfWithData=0` ⇒ `0 族 · —`；`coverageMarkerOf(null) === '—'` | 缺失时用 0 顶替（`0 族 · 0/6` 且无原因）⇒ 判据非空 |
| ③ | `INBOX_MIN_LEVEL === 2`；等级 0/1 既不在列表也不在统计里 | 把「资金异动」（等级 1）列进去 ⇒ 判据非空 |
| ④ | 排序 = 等级优先、同级时间倒序（含等级 3 的历史事件） | 纯时间倒序 ⇒ 判据非空 |
| ⑤ | 6 条事件合并为 3 条：`14:30–14:35 ×4 / 最高 72`（最新一条只有 61）、`14:36 ×1 / 66`、等级 3 单独一条；正好 5 分钟仍并入 | (a) 得分取最新 61 ⇒ 非空；(b) 不合并（6 条）⇒ 条数不对 |
| ⑥ | 已读后未读数减 1、`total` 不变；`inboxReadMapOf` 宽容（`{}`/坏值丢弃）；31 天前的键被裁；面板 `markRead` 只调 `api.setPrefs` 且写 `rescueInboxRead`；**代码里**（剥注释后）不出现 `rescue-log`；未存盘有一句如实说明 | 把 `setPrefs` 换成写 `rescue-log` 的 `mutateWatch` ⇒ 判据非空 |
| ⑦ | 全部已读 ⇒ 空态含「最近一次信号在 3 天前（2026-10-16）」+「本期（30 天）」+「最高 疑似护盘」；无信号时按日志天数改口；31 天前的信号不入箱；`dayDiffOf` 非法输入 ⇒ `null`；面板渲染 `inbox.emptyText`；**「取数中」分支存在且排在空态之前** | (a) 空态只写「无信号」⇒ 判据非空；(b) 去掉「取数中」守卫 ⇒ 判据非空 |
| ⑧ | 新增样式的字号全在阶梯内、无 `animation`/`transition`、间距整数 px；两个新模块只 import 相对路径/共享契约；面板无 `Notification` | —（正向纪律断言） |

---

## 4. 实测读数（纯函数 + 固定夹具，脚本 `/tmp/covui-evidence.mts`）

```
marker = "3 族 · 5/6"   len = 9   missing = null
部分缺失（confirm1N 缺）    → marker = "2 族 · —"（另半段照常）
整块缺失                    → marker = "—"      missing = "宿主未提供覆盖广度（阶段一字段）"
nEtfWithData = 0（基线不足）→ marker = "0 族 · —"（不写 0/0）
coverageMarkerOf(null)      → "—"

合并（L2 14:30/14:32/14:34/14:35 + L3 14:31 + L2 14:36）：
  2026-10-16 14:30-14:35 L2 ×4 score=72   ← 取窗口内最高（最新一条是 61）
  2026-10-16 14:36-14:36 L2 ×1 score=66
  2026-10-16 14:31-14:31 L3 ×1 score=90   ← 等级交错不切断同等级窗口
收件箱（排序后，未读）：L3 14:31 90 分 → L2 14:36 66 分 → L2 14:30 ×4 72 分
unread/total/signalDays = 3/3/1
全部已读：unread=0 total=3
  emptyText = 最近一次信号在 3 天前（2026-10-16） · 本期（30 天）：1 天有信号 / 3 条（最高 强护盘（历史））
无信号（自采样 8 天）：
  emptyText = 最近一次信号在 8 天前以外（自采样起只有 8 天日志） · 本期（30 天）：0 天有信号 / 0 条
pruneInboxRead({2026-09-01…, 2026-10-18…}, today=2026-10-19) = {"2026-10-18#2#2":2}
inboxReadMapOf({a:1,b:'x',c:NaN}) = {"a":1}
```

> 注：`最高 强护盘（历史）` 是统计句里的短名（共享文案 `RESCUE_LEVEL_LABEL[3]` 带"已删除，不再出现"注释，放进统计槽读起来别扭）。

---

## 5. 门禁读数

| 轮次 | 命令 | 结果 |
| --- | --- | --- |
| 基线 | 起点 `e7e29f9` 干净树 | 868 用例 × 2 时区（任务给定基线；本机首次基线跑被写入中的新文件打断，故只作参照） |
| A–G | `DSH_HOME=/tmp/covui-gate{A..G} npm run check` | 每轮均为 **890 pass / 0 fail** ×2 时区；`ALL HOST CHECKS PASSED`；`built lib/index.js + lib/client.js（v0.109.0，客户端片段校验通过：73 项）` |
| **H / I（最终代码）** | `DSH_HOME=/tmp/covui-gate{H,I} npm run check` | **890 pass / 0 fail** ×2 时区；`ALL HOST CHECKS PASSED`；构建 **73 项**；两轮跑前后的**源码** md5 逐文件一致（`RescuePanel.tsx / rescueCoverage.ts / rescueInbox.ts / styles.ts / impl81.test.ts / host 三件 / build.mjs`）；文档在本报告定稿时补了行号（只动 docs，不影响构建） |

`890 = 868 基线 + 22`（本批客户端 9 条 + 宿主侧 `impl80` 的 13 条，均为每时区计一次）。
**两轮全绿的读数为 H / I**（A–G 是同一实现演进过程中的中间绿：A 在收件箱提示位置微调前、B–F 在"取数中守卫"与统计短名之前、G 在悬停口径全文（`INBOX_CALIBER`）接线之前）。

---

## 6. 口径取舍与未做项（**必须读**）

1. **收件箱门槛取「等级 ≥ 2（疑似护盘）」，而不是字面的「等级 ≥ 1」。**
   仓库里等级 1 就是「资金异动」，而需求同时要求"不要列资金异动（实测基率 100%）"且断言"把资金异动列入 ⇒ 必败"。
   两者冲突时按**产品语义**取值：基率 100% 的档位列出来等于每拍一条噪音。已在收件箱标题下常驻写明
   「只列疑似护盘及以上（资金异动基率 100%，不入箱）」，并把该取舍的断言写进用例（等级 0 与 1 都不出现）。
   *（已同步 Lead。）*
2. **合并窗口锚在"窗口起点"（固定 5 分钟窗），不是"距上一条 ≤5 分钟"的滚动链。**
   滚动链会把 14:30→14:34→14:38→… 一路续成整段（一天的信号合成一条）。边界取闭区间：正好 5:00 仍并入。
3. **历史事件的取数成本**：客户端不能改宿主，跨日事件只能走现成的 `?day=`（回包含一份快照）。
   因此只对 `maxLevel ≥ 2` 的天取（其余天不可能有入箱事件），串行 + 按天缓存 + 失败可见。
   若 30 天内信号日很多（极端情形上限 30 天），首屏会多出最多 30 次本地请求 —— 这是**现状能力的上限**，不是新增上游请求。
4. **阶段二开关没有做客户端 UI**：`RescueConfig.rescueCoverageEnabled` 只在悬停里**回显**状态（false ⇒ 阶段一那句话；true ⇒ 改口成"已开启附加分"）。
   开关的写入路径归宿主/配置侧，本批未加勾选框（加了会顺带改评分，不属于本任务）。
5. **未做**：推送 / 红点 / 闪烁 / 新依赖（按要求全部不做）；未改 `build.mjs`；未改 `src/host/**`；未新增路由。
6. **依赖宿主侧已落地的字段**（本批客户端依赖，已在本分支同一树上验证）：
   `RescueCoverage`（7 键）、`RescueSignalEvent.coverage/coverageWhy`、`RescueSnapshot.coverage/coverageWhy/coverageEnabled`、
   `PortPrefs.rescueInboxRead` 及其白名单归一。若其中任一项回退，客户端显示 `—` + 原因（不会崩、不会补 0），
   用例 ①b 会先报"契约不同步"。
