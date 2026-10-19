# AUDIT-IMPL79：护盘面板三段常驻披露 → 「口径与边界」一行入口 + 悬停/读屏

- **实施时刻**：2026-10-19 09:50 起（Asia/Shanghai）
- **起点**：`cc5e9b0`（v0.108.0 之后的两条文档提交；863 用例 × 2 时区 + 构建 73 项）
- **用户要求**：删掉「底部位置 / 形态 / 触发后对照」表下方**三段常驻文字**。
- **处置原则（按 Lead 指示）**：**不直接删**——常驻区只留一行入口，三段**原样**搬进 `title` / `aria-label`。
  理由：这三段是我们自己的**红线披露**（口径、Wilson 区间含义、「不是胜率/概率」、形态不参与校准、「位置低 ≠ 见底」）。
- **纪律**：未动 `build.mjs`、未新增依赖、不 commit、不装、不动 profile、不重启 `dsh web`；实验隔离 `/tmp/hb-*`；未手工写 `~/.dsh`。

---

## 0. 结论（一行）

三段常驻文字已收进面板底部的**一行**「口径与边界（悬停查看）」：鼠标悬停读 `title`、键盘 `Tab` 到读 `aria-label`，**16 条事实逐条仍在**（含「历史同类情形的出现频率」「95% 区间是 Wilson 区间」「不是胜率、概率或预测」），`build.mjs` 两条锁定片段各自仍有来源。

---

## 1. 三段的新落点

| 段 | 原文来源 | 现在落在哪 |
| --- | --- | --- |
| ① 口径句（`近 60 日收盘分位 ≤ 25% … 前向收盘收益中位数 0.34%，期间最大回撤中位数 -2.45%`） | **宿主**生成：`host/rescue.ts:2543` 的 `bottom.view.model`（本批**未改宿主**） | 由 `rescueView.caliberHoverTextOf(model)` 原样拼进入口的 `title` / `aria-label`；面板不再渲染 `snapshot.bottom.model` 文本 |
| ② 口径说明（`口径说明：这里是「历史同类情形的出现频率」的对照片段，不是胜率、概率或预测；给出的 95% 区间是 Wilson 区间…`） | `RescuePanel.tsx` 内联字符串 | `rescueView.ts` 的 `RESCUE_CALIBER_DISCLOSURE`（**唯一来源**）→ 同一入口的 `title` / `aria-label` |
| ③ 形态边界（`日内形态（回升/下影线/收回前低）没有可回算的历史分钟数据，因此「不参与概率校准」…位置低 ≠ 见底…`） | 同上（与 ② 同一段常量） | 同上 |

**常驻区现在只有一行**：`口径与边界（悬停查看）`（14 字）。

| 文件:行号 | 改动 |
| --- | --- |
| `src/client/rescueView.ts:71-96` | 新增 `RESCUE_CALIBER_ENTRY`（入口文案）、`RESCUE_CALIBER_DISCLOSURE`（②③ 原文，`**` 已去掉——见 §4）、`caliberHoverTextOf(model)`（宿主口径句 + 两段，空 model 只给两段、不补编）、`caliberEntryOf(model)`（返回 `{label,title,ariaLabel}`，唯一实现） |
| `src/client/RescuePanel.tsx:382` | `const caliberEntry = caliberEntryOf(snapshot?.bottom?.model)`（计算在渲染前，文案只有一个来源） |
| `src/client/RescuePanel.tsx:880-890` | 原来的两个 `tw-hint` div（`model` + 披露）→ **一行入口**：`tabIndex: 0`、`role: 'note'`、`data-role: 'rescue-caliber'`、`title`/`aria-label` 指向同一段文字、`cursor: help` |

**视觉结果**：表下方从 3 段（约 5 行）压成 1 行；三段文字内容零删减（鼠标悬停/键盘聚焦即可读）。

### 与「历史频率」那一行的区别（不是漏搬）

`历史频率` 行里的 `期间最大回撤中位数 -2.45%` 是**数据单元格**（紧凑数字行），不属于被判读的三段文字，因此**保留常驻**；第一段是否搬干净，用 `口径为前向 …（1+目标）` 这个只属于 `model` 句的片段判定（见 §3 ①）。

---

## 2. 锁定片段落点（两条，均未动 `build.mjs`）

| 锁定字面量（`build.mjs:126` / `:146`） | 新落点 |
| --- | --- |
| `历史同类情形的出现频率` | `rescueView.ts` → `RESCUE_CALIBER_DISCLOSURE` → `caliberEntryOf()` → 面板入口的 `title` **与** `aria-label`（**唯一来源**：删掉它构建必挂，实测见 §3 ④） |
| `95% 区间` | 同一条常量（`…给出的 95% 区间是 Wilson 区间…`）**+** 常驻的「历史频率」行 CI 文本 `（95% 区间 12.3–18.9%）`（未动）。两处都有 ⇒ 该片段有双保险 |

---

## 3. 断言与反例注入（`src/client/impl79.test.ts`，5 条）

| # | 断言 | 反例注入（必败） |
| --- | --- | --- |
| ① | 常驻文本 = `RESCUE_CALIBER_ENTRY`、长度 ≤ 16、**不含** `Wilson 区间`/`不参与概率校准`/`位置低 ≠ 见底`/`历史同类情形的出现频率`/`口径为前向`/`(1+目标)` | 把披露拼回常驻文本（= 用户抱怨的状态）⇒ 断言抛错 |
| ② | 悬停/读屏 == 同一份文字；**16 条事实**逐条命中（口径句 6 条 + 红线 10 条，含「不是胜率、概率或预测」「95% 区间是 Wilson 区间」「区间跨过基线…不具备可辨识性」「不参与概率校准」「位置低 ≠ 见底」）；且含宿主 `model` 原文 | (a) 只留宿主口径句、删掉两段红线 ⇒ 缺 10 条事实；(b) 只删「Wilson 区间」半句 ⇒ 缺该条 |
| ③ | `model` 为空/空白/`null`/`undefined` ⇒ 只给静态两段，且**不出现**「期间最大回撤中位数」（不补编假口径） | —（正向多态断言） |
| ④ | `rescueView.ts` 里两条锁定字面量都在；`build.mjs` 确实锁着它们 | 从常量里删掉 ⇒ 断言抛错（真实构建必败，见下） |
| ⑤ | 面板源码不再含三段特征串、不再把 `snapshot.bottom.model` 当文本渲染；入口有 `caliberEntryOf(...)`、`tabIndex: 0`、`role: 'note'`、`title`/`aria-label` 指向 `caliberEntry` | 去掉 `tabIndex`/`aria-label`（= 不可聚焦、读不出）⇒ 断言抛错 |

**真实构建注入（`/tmp/hb-build` 副本，`rsync` 出、依赖软链；本仓库未受影响）**

```
注入1：把悬停文案里的两条锁定字面量都删掉
  → 构建校验失败：lib/client.js 缺少以下 UI 片段 —— 历史同类情形的出现频率   (exit 1)
     （95% 区间 仍由常驻 CI 文本 `（95% 区间 …）` 兜住）
注入2：再把常驻 CI 文本里的 `95% 区间` 也删掉
  → 构建校验失败：lib/client.js 缺少以下 UI 片段 —— 历史同类情形的出现频率 / 95% 区间  (exit 1)
```

---

## 4. 一处措辞调整（不是删事实）

`**不是**胜率、概率或预测` → **`不是胜率、概率或预测`**（去掉 Markdown 粗体星号）。

- 原因：仓库已有断言「用户可见字符串里不许出现 Markdown `**`」（`host/markdownScan.test.ts` 扫 `.ts` 源码；粗体在 `title` 里会原样显示成星号，读屏也会读出）。
- 该文案挪进 `.ts` 文件后触发了上述扫描；去掉星号后语义完全不变（`rescueVisual.test.ts` 的否定式判据仍命中）。
- **同一测试的必要同步**：`rescueVisual.test.ts` ② 原来只扫 `RescuePanel.tsx` 找「不是胜率/概率」的诚实边界；文案搬到 `rescueView.ts` 后，判据改成**同时扫这两个文件**（文案在哪判据扫到哪），禁止买卖结论/带数字胜率的扫描也一并覆盖两个文件。

---

## 5. 门禁

| 命令 | 结果 |
| --- | --- |
| `tsc --noEmit -p tsconfig.json` | exit 0 |
| `node --test "src/client/*.test.ts"` | **349 pass / 0 fail**（基线 344 + 本批 5） |
| `node --test "src/**/*.test.ts"` | **868 pass / 0 fail**（基线 863 + 5） |
| `node build.mjs` | 片段校验通过：**73 项**（v0.108.0） |
| `npm run check` 第 1 轮 | 见 §6 |
| `npm run check` 第 2 轮 | 见 §6 |

---

## 6. 两轮完整门禁（同一份代码）

| 轮次 | 读数 |
| --- | --- |
| 第 1 轮 | 时区 A：`ℹ tests 868 / pass 868 / fail 0`；时区 B（`TZ=UTC`）：同；`ALL HOST CHECKS PASSED (live probes soft)`；`built lib/index.js + lib/client.js（v0.108.0，客户端片段校验通过：73 项）`；`PIPE_STATUS=0` |
| 第 2 轮 | 同上四条，`PIPE_STATUS=0` |

- **同哈希证据**：两轮前后对 `src/client/**` + `build.mjs` 的 sha256 汇总一致 ——
  **`392db086a1f8984fb1a579f982ffb86d16925d94c499521a223135d630449e3a`**（两轮跑的是同一份代码）。
- **用例数**：基线 863 → 现在 **868**（本批新增 `src/client/impl79.test.ts` 5 条）。
- **未改** `build.mjs`（两条锁定片段原样，见 §2）；未新增依赖。

---

## 7. 未做项

| 项 | 原因 |
| --- | --- |
| 宿主 `model` 句的措辞/精简 | `model` 由 `host/rescue.ts:2543` 生成，本批不动宿主（Lead 明确）；如需缩短口径句，属宿主批次 |
| 悬停入口的「点击展开」（触屏） | 本批按用户要求做**悬停 + 键盘聚焦**（`title` + `aria-label`）；触屏上点击标题不展开，若要触屏可读需另加 `aria-expanded` 折叠区（会重新占版面，需用户确认） |
| `docs/REVIEW-8-CLIENT-UX.md` 的评审条目状态更新 | 评审文档不归本批维护 |
