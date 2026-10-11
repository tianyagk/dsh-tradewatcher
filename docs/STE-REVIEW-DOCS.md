# STE 审计：文档与代码注释（v0.50.0 · HEAD `728bc23` · 只读）

**结论**：`与代码不符` 命中 9 条（全部集中在 `docs/DESIGN-CHIPS.md` 与 `docs/DESIGN-SUBPLUGINS.md`）；`同概念多说法` 命中 2 组；`可删的重复/冗长` 命中 4 类（28 份一次性审计报告 3,288 行是最大项）；`虚化动词`（R3）无命中。
**范围**：`README.md`(456) + `docs/*.md`(37 份 5,699 行) + `src/**` 注释（CHANGELOG 不审；`docs/archive/` 13 份 2,693 行按历史处理）。
**扫描命令**（可复现；本机无 `rg`，用 `grep`/`awk`；本轮先用 node 脚本统计，脚本已在收尾时删除，下列命令等价）：
- 超长句/R13 段落：`awk 'BEGIN{RS="\n\n"} {n=gsub(/。/,"。"); if (n>6) print NR": "n" 句"}' README.md`（段落句数）；长句按「汉字 1 字、英文词/数字/标识符 1 字、标点不计」计
- R17 开放列举：`grep -rnE "等[，。；：）]|之类" README.md docs/DESIGN-*.md docs/ROADMAP.md`
- R11 情态词：`for w in 应该 应当 必须 不得 可以; do printf "%s " "$w"; grep -o "$w" README.md | wc -l; done`
- 一致性核对：`grep -rn "96 桶\|360 天" src/client/chipsView.ts`；`grep -n "BREADTH_WINDOW" src/host/breadth.ts`；`grep -n "refreshSec: 10" src/shared/model.ts`

## ① 与代码不符（会误导）— 9 条

| 位置 | Rn | 现文 | 建议 | 理由 |
|---|---|---|---|---|
| `docs/DESIGN-SUBPLUGINS.md:3` | R25 | 「目标：把 `dsh-tradewatcher` 从单行插件改成「core + 功能行」的多行 bundle」 | 抬头加一行：「状态：**未落地**。六行形态在本机装载失败（同一 package 多个活跃 Loader 源 + 本包带客户端半区 ⇒ `dsh-client-modules` composition error）；当前只装一行，见 `cordis.patch.yml:3-9`」 | 文档描述的是已回退方案，读者会照着实现（`src/index.test.ts:149` 锁定了单行） |
| `docs/DESIGN-SUBPLUGINS.md:48` | R25 | 「**总行数**：core + 5 = 6 行」 | 「目标形态 6 行；当前 manifest 只装 1 行（`cordis.patch.yml:15-17`）」 | 同上；「6 行」在当前状态下会误导 |
| `docs/DESIGN-SUBPLUGINS.md:105` | R25 | 「验收判据…插件列表出现 `tradewatcher-core` 与 `tradewatcher-calendar` 两行」 | 标注「未执行（装载失败，见 §回退记录）」 | 未验证的判据被写成可执行清单 |
| `cordis.patch.yml:9` | R22 | 「细节见 `docs/DESIGN-SUBPLUGINS.md` §6」 | 指向该文档新增的「回退记录」节 | §6 是风险清单，读者在那里找不到回退结论（指路断裂） |
| `docs/DESIGN-CHIPS.md:52` | R25 | 「## 4. 窗口与桶：**45 根 bar**，纯内存计算，**桶数建议 24–40**」 | 「窗口 **360 天**、**96 桶**（`src/client/chipsView.ts:123`、`:151`）」 | 与实现不符（v0.47.0 窗口 360d、v0.49.0 96 桶） |
| `docs/DESIGN-CHIPS.md:56` | R25 | 「桶数建议 24–40…少于 16 桶会糊成一片、多于 60 桶…」 | 删该段，或改写为 96 桶的实测结论 | 旧结论已被实现取代（96 > 60），留着会引来"回退"式改动 |
| `docs/DESIGN-CHIPS.md:82` | R25 | 「建议仅在 `日K/周K/月K/年K` 与分时下显示；`5d`…直接隐藏该区块」 | 「筹码与页签无关：**六个页签都显示**（`src/client/ChipsPanel.tsx:8`；`src/client/chipsView.test.ts:128` 记录了页签门控已删）」 | 与实现相反（task-64 删除门控） |
| `docs/DESIGN-CHIPS.md:40` | R25 | 「固定半衰期…`H`=5/10/20 交易日**可配**」 | 删「可配」二字（v0.46.0 已去配置项） | 与实现不符 |
| `docs/DESIGN-CHIPS.md:57,98,99` | R25 | 「**45 是自然数**…」「桶数 24–40 的观感结论未在真机渲染层验证」 | 改为 360 日窗口 / 96 桶；若未重测，标「未验证」 | 过期结论（含"未验证"字样却写在已落地功能上） |

**核对通过（不报）**：`README.md:88,95,103-105,125,168,233` 的全部数字与 `src/shared/model.ts:680-685`（`refreshSec: 10`、`rescue.intervalSec: 30`/`tailIntervalSec: 15`）、`src/host/breadth.ts:11`（`BREADTH_WINDOW = 60`）一致 ⇒ 此项写「无」。

## ② 同概念多说法（R1）— 2 组命中，2 项无命中

| 位置 | Rn | 现文 | 建议 | 理由 |
|---|---|---|---|---|
| `src/client/chartCache.ts:173`、`src/client/useQuotes.ts:97`、`src/client/index.tsx:196` | R1 | 「**顶栏**悬浮卡」「**顶栏**显示"滞后"」「**顶栏**行情卡片」 | 统一写「**行情条**」（README 用 29 次；`TopBar.tsx` 的组件名可保留） | 同一 UI 部件两个名字（顶栏/行情条） |
| `src/host/calendar.ts:54,478,535`、`src/host/routes.ts:114` | R1 | 「**关注标的**的 6 位代码」 | 统一写「**自选与持仓标的**」（README:112 的写法） | 同一集合两个名字：代码叫"关注标的"，README 叫"自选 + 持仓标的" |
| `README.md`（「面板」231 处、「抽屉」104 处、「侧栏」58 处） | R1 | — | 写「无」：三个词各指一物（主面板 / 详情抽屉 / 左侧栏），已抽查 README 全部「面板」用例 | 未发现混用 |
| `README.md`+`docs/*.md`（「口径」723 处、「精度」0 处） | R1 | — | 写「无」 | 只用「口径」，不存在第二说法 |

## ③ 重复与冗长（可删）

| 位置 | Rn | 现文 | 建议 | 理由 |
|---|---|---|---|---|
| `docs/AUDIT-IMPL6..21.md`(16) + `docs/AUDIT-VERIFY2..10.md`(9) + `docs/AUDIT-V3-{CODE,COPY,EFFECT}.md`(3) = **28 份 3,288 行** | R21 | 每份是「改了什么 / 怎么验的」过程记录 | 整批移入 `docs/archive/`，`docs/` 只留 README/ROADMAP/DECISIONS/DESIGN-*/RESEARCH-*/PRODUCT-*；README「开发」留一行索引 | 结论已在 CHANGELOG；过程记录占 docs 总量 58% |
| `docs/DECISIONS.md`（1,354 行，90 条超长句） | R21 | 注释迁入的历史过程 | 抬头加「历史记录，不适用 STE 与 R1 规则」；不再往里面追加 | 与 CHANGELOG 同类，按项目规范原样保留更省事 |
| `README.md:378`（9 句）、`README.md:436`（11 句） | R13 | 一段超过 6 句 | 拆成列表（每句一行，`- ` 开头） | 一段一个主题、不超过 6 句 |
| `README.md:291` + `cordis.patch.yml:3-9` + `docs/DESIGN-SUBPLUGINS.md:138` | R21 | 三处都写「第三条链路/六行未启用」 | 只留 `cordis.patch.yml:3-9`（可定位的权威处），README 写一行并给该路径 | 同一事实三处重复 |
| 超长句（R7）356 条 / 9 文件（含 `AUDIT-*` 与 DECISIONS 则 648 条 / 45 文件） | R7 | 见下表 top 10 | 长句拆成「条件 + 动作」两句，或改成列表 | 描述句 ≤40 字、步骤句 ≤30 字 |

**超长句 top 10（按超出量）**：`README.md:3`(+80)、`docs/ROADMAP.md:215`(+77)、`README.md:55`(+72)、`README.md:25`(+71)、`README.md:90`(+59)、`README.md:112`(+58)、`docs/ROADMAP.md:167`(+54)、`docs/RESEARCH-5DAY-TREND.md:10`(+52)、`README.md:29`(+51)、`docs/ROADMAP.md:196`(+51)。分布：README 152 条、ROADMAP 79、DESIGN-CHIPS 24、DESIGN-SUBPLUGINS 24、RESEARCH-5DAY-TREND 21、DESIGN-STRIP-CONFIG 18、RESEARCH-BOND-STRIP 18、DESIGN-DASHBOARD 10、PRODUCT-ARKVOL-TRIAGE 10。
**超长段（R13 >6 句）25 条**，样例：`README.md:378`(9)、`README.md:436`(11)、`docs/DESIGN-CHIPS.md:78`(9)、`docs/DESIGN-DASHBOARD.md:109`(8)、`docs/DESIGN-STRIP-CONFIG.md:16`(10)、`docs/PRODUCT-ARKVOL-TRIAGE.md:86`(12)。

## ④ 其它 STE 规则

| 位置 | Rn | 现文 | 建议 | 理由 |
|---|---|---|---|---|
| `README.md:59,112,113,264`；`docs/DESIGN-SUBPLUGINS.md:11,124,125,138`；`docs/ROADMAP.md:67,83,196,226,227,231` | R17 | 共 **14 处**以「等/之类」结束列举（正文 10 + 表格 4） | 列全，或写出完整清单的位置（例：README:59 改为「完整字段见 `src/host/em.ts` 的详情映射」） | 不得用「等」结束列举 |
| `README.md:112` | R15 | 一段内并列 12+ 项技术词 + 参数 | 拆成两段/列表：① 新股申购与上市日历；② 自选与持仓标的的财报、分红除权；③ 国际/国内宏观事件（清单见 `src/host/calendar.ts`） | 三项以上并列写列表 |
| `README.md:30` | R16 | 「⚠ **归档是从本版起累积**的：装好当天最多只有 1 天…过去的日子没有归档过，**追不回来**——这不是 bug」 | 「**不得**期待历史归档：本模块上线前的分时不归档，过去的日子追不回来。装好当天最多只有 1 天。」 | 警告第一句没写「必须/不得」，后果被埋在句中 |
| `README.md:97` | R16 | 「⚠ 免费源无 ETF 资金流历史，**历史回看只能从本模块上线日起算**」 | 「**不得**把历史回看当成完整历史：免费源无 ETF 资金流数据，回看只能从模块上线日起算。」 | 同 R16：先写命令，再写后果 |
| `README.md`、`docs/DESIGN-*.md`、`docs/ROADMAP.md` | R11 | 情态词统计：必须 64、不得 10、可以 4、应该 0、应当 0 | 写「无」 | 只用了三个合规情态词（「需要」32 处为动词用法，不是情态词） |
| `README.md`、`docs/*.md`、`src/**` 注释 | R3 | 未命中「对…进行…」「做…的处理」 | 写「无」 | 扫描器 `/tmp/ste-scan.mjs` 的虚化动词组零命中 |
| `src/**` 注释 | R5 | 未逐条扫描名词串 | 标「未验证」：本轮只抽查，未做全量名词串计数 | 时间/工具限制 |

## 统计

| 类别 | 命中 | 文件数 | 备注 |
|---|---|---|---|
| ① 与代码不符 | 9 条（另 1 项核对通过） | 3（DESIGN-CHIPS、DESIGN-SUBPLUGINS、cordis.patch.yml） | 全部集中在两个设计文档 + manifest 注释 |
| ② R1 同概念多说法 | 2 组 | 5 个源文件 | 「顶栏/行情条」「关注标的/自选与持仓标的」 |
| ③ 超长句 R7 | 356（正文口径）/ 648（含历史） | 9 / 45 | README 152 条最多 |
| ③ 超长段 R13 | 25 | 8 | 最多 12 句 |
| ③ 重复事实 | 1 组（三处同述「未启用」） | 3 | — |
| ③ 可归档报告 | 28 份 3,288 行 | — | docs 总量 5,699 行的 58% |
| ④ R17 开放列举 | 14（grep 口径）/ 11（脚本正文口径） | 3 | README 4、DESIGN-SUBPLUGINS 4、ROADMAP 6 |
| ④ R16 警告格式 | 2 | 1 | `README.md:30`、`:97` |
| ④ R11 情态词 | 0 | 0 | 只出现必须/不得/可以；应该、应当各 0 |
| ④ R3 虚化动词 | 0 | 0 | 无 |
| ④ R5 名词串 | 未验证 | — | 未做全量扫描 |

**未做**：本轮只审不改；`src/**` 注释仅按超长句/R17 规则扫描（未逐条判 R1/R5）。统计用的 node 脚本放在 `/tmp` 并已删除；正文给出的 `grep`/`awk` 命令可复现同一口径。
