# STE 文档修正：9 条与代码不符 + 术语统一 + 28 份报告归档（task-73）· 实现记录

对象：`dsh-tradewatcher` 工作区。末次 `npm run check`：**387 条 × 2 时区全绿**、`ALL HOST CHECKS PASSED (live probes soft)`、`build.mjs` 零改动。
不装 bundle、不动 profile、不 commit、不重启；被 `git mv` 的文件**内容未改**。

## A. 9 条与代码不符（全部改完，逐条给出依据）

| # | 位置 | 改为什么 | 依据 |
| --- | --- | --- | --- |
| 1 | `DESIGN-CHIPS.md:52` | 窗口 **360 天（累积）/ 展示 45 天**、**96 桶** | `src/client/chipsView.ts:123/151` |
| 2 | `DESIGN-CHIPS.md:82` | **六个页签都显示筹码**（页签门控已删） | `ChipsPanel.tsx:8`、`chipsView.test.ts:128` |
| 3 | `DESIGN-CHIPS.md:40` | 半衰期 `H = 10`，**写死、不再可配** | v0.46.0 去配置项 |
| 4 | `DESIGN-SUBPLUGINS.md:3` | 抬头改为「**状态：未落地（方案记录）**」+ 失败原因 + 方案/现状分开写 | `cordis.patch.yml:3-9`、`src/index.test.ts:149` |
| 5 | `DESIGN-SUBPLUGINS.md:48` | 「总行数**（目标形态）** 6 行；**当前 manifest 只装 1 行**」 | 同上 |
| 6 | `DESIGN-SUBPLUGINS.md:105` | 验收判据标注「**未执行**（装载失败，见回退记录）」 | 同上 |
| 7 | `cordis.patch.yml:9` | 「见 §6」→「见 `DESIGN-SUBPLUGINS.md` 的**回退记录**一节」 | 新增该节 |
| 8 | `DESIGN-CHIPS.md:56,57,98,99` | 计算量改为 96 桶 × 360 天 ≈ 10.4 万次/标的（实测 ~19ms）；「24–40 观感未验证」改为「96 桶 + 裁剪后观感未在真机复核（已实现 48 行 / 2px）」；桶数边界 16–160 | 实测 + 实现值 |
| 9 | `DESIGN-CHIPS.md` 新增 | 显示范围按筹码质量 99% 覆盖 + 稀疏行（< 峰值 20%）裁剪（v0.49.1） | `chipsView.ts` 的 `CHEPS_COVERAGE`/`MASS_THRESHOLD` 口径 |

**同一事实三处重复** ⇒ 只留 `cordis.patch.yml:3-9`（唯一权威）；`DESIGN-SUBPLUGINS.md` 新增「回退记录」节并声明"本文件与 README 只保留指向"；`README.md:291` 那条改为一行（去掉重复的"未启用"论证）。

## B. 术语统一（R1）
- **顶栏 → 行情条**：`src/client/chartCache.ts`、`src/client/useQuotes.ts`、`src/client/index.tsx`（各 1 处，全部命中）。
- **关注标的 → 自选 + 持仓标的**：`src/host/calendar.ts`（3 处）、`src/host/routes.ts`（1 处）。
- **补（lead 定案）**：`src/host/calendar.test.ts:81` 的测试用例名也已统一为「自选 + 持仓标的」（测试名会进 CI 输出，术语要一致；不改行为）；`docs/DECISIONS.md` **不动**（历史记录，顶部已有抬头）。

## C. 归档（`git mv`，内容不改）
```
docs/archive/  ← 28 份一次性报告（git status 显示 28 条 R 重命名，历史保留）
  AUDIT-IMPL6..21.md(16) + AUDIT-VERIFY2..10.md(9) + AUDIT-V3-{CODE,COPY,EFFECT}.md(3)
docs/*.md 由 41 份 → 13 份
```
- `docs/DECISIONS.md` 顶部已加：「历史记录，不适用 STE 规范。」
- 说明：README 里指向这些报告的链接**已同步指向 `docs/archive/`**（ROADMAP 的归档表原本就写的是 `archive/…` ✓）。

## D. 长句与列举（低优先，**未做完，按范围纪律停手**）
- **R16 警告格式**：`README.md:30` 首句改为「⚠ **不得**期待历史归档…」✓。
  `README.md:97` **判定为审计误报**：回读该行是全句 `- **数据**：rescue-log.json（60 天滚动）保存每日信号事件、5 分钟抽样、20 日均额基准、自建样本与出分日志…` —— 它是**数据字段说明段**，既无 `⚠` 标记、也不含「会被覆盖/丢失」这类后果，**不是警告句** ⇒ 机械套 R16 属于把类型套错（lead 已同意不改，并记入误报）。
- **R17 开放列举**：按"能删就删"去掉 `等）`/`之类` 共 **6 处**（README 2、ROADMAP 4）；其余点名行是**真正的开放列举**（如"三档 `完整/紧凑/隐身`"、"P1-1（列表真列网格）、P1-11（硬编码色…）…"），改写成完整列举会**新增内容**（超出"只改文案"的范围），**停手回报**。
- **两处最长段**（`README.md:378` 9 句、`:436` 11 句）：**未拆（lead 同意停手）**。理由：拆段要重排信息顺序，属于结构性改写，超出"只改文案"范围。
- 其余未点名项（审计里 356 条超长句、25 条超长段）**一律未动**（避免扩大范围）。

## 测试与门禁
```
387 条 × 2 时区全绿（本批只改文档 + 5 个源文件的注释/字符串，未改逻辑）
npm run check：387 × 2 时区全绿；75 项片段校验通过；build.mjs 零改动
```

## 需装机复核
无（本批是文档与文案）。唯一需人工确认的：`docs/archive/` 的 28 个链接在 GitHub/编辑器里可点开。
