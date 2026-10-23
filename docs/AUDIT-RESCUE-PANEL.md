# 护盘信号「备用源」摘要面板删除

## 0. 一行结论

已删除 `RescuePanel` 里 `tw-rescue-summary` 的 17 行归因摘要节点（`snapshot.summary`）及其 CSS；标题行、等级/评分/分位/因子/采样/操作按钮和六张通道卡保持原位，无空盒、无占位、无额外间距。

## 1. 删除范围

- DOM：`snapshot !== null ? React.createElement('div', { className: 'tw-rescue-summary', ... }, snapshot.summary) : null` 整块删除。
- CSS：`.tw-rescue-summary{...border/background/padding...}` 删除。
- 面板标签/文案：`RescuePanel` 内剩余的数据源说明统一为「备用数据源」，不再出现面板字样「备用源」。
- 未动：`护盘信号` 标题、等级胶囊、覆盖广度、评分环/当日峰/分位、`因子 n/4`、`采样中/暂停 + 数据时刻 + 腾讯源`、`立即采样 / 收起 / 设置 / 导出`、`tw-rescue-cards` 六张通道卡、`共振` 区。

## 2. 锁定片段核实

- 在 `build.mjs` 的 `REQUIRED_CLIENT_SNIPPETS` 中检索本面板字面量：
  - `已剔除`：**0 条**
  - `超大素材`：**0 条**
  - `阈值来源`：**0 条**
  - `评分 26/100`：**0 条**
  - `备用源`（完整子串）：仅命中 **2 条不相关**的既有文案：`腾讯备用源兜底`（第 119 行）、`板块涨跌来自腾讯备用源`（第 127 行）；均不属于被删面板，删除后构建仍通过。
- `build.mjs` 未修改；构建 **73 项**通过（v0.138.0）。

## 3. 断言/注入

新增 `src/client/rescuePanelRemoval.test.ts`（4 条）：

① 页面源码不含 `备用源` / `评分 26/100` / `已剔除「超大单强度」因子` / `阈值来源 自建分位` / `阈值来源`；也不含 `tw-rescue-summary` 与 `snapshot.summary`。逐条注入 ⇒ 必败。
② 无空容器：CSS 无 `.tw-rescue-summary`，页面无对应 `createElement`；只留空 div ⇒ 必败。
③ 标题与通道仍在：`护盘信号`、`立即采样`、`收起`、`设置`、`导出`、`tw-rescue-cards`、`tw-rescue-card`、`共振`；连带删除标题 ⇒ 必败。
④ 不多留空隙：`.tw-rescue` 仍 `gap:6px`、无 `min-height`；注入 `min-height:80px` ⇒ 必败。

## 4. 门禁

- 本任务新增 **4** 条；当前全量 **1193**（仓库同时存在其它未提交测试文件，基线不再是 1181）。
- `DSH_HOME=/tmp/rescuepanel-check1 npm run check`：全绿（1193 / 1193）。
- `DSH_HOME=/tmp/rescuepanel-check2 npm run check`：全绿（1193 / 1194）。
- 构建 **73 项**（v0.138.0；`build.mjs` 未动）。
- 只改 `src/client/**`（`RescuePanel.tsx`、`styles.ts`、新增测试）；不 commit、不重启。
