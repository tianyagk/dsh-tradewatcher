# 棱镜页重设计（hybrid + 左栏分段 + 62:38 可拖拽）

## 0. 一行结论

只改 `src/client/**`：hybrid 配色（现有底 token + MD 强调/tonal）、左栏分段（持仓/挂单/成交）、62:38 可拖拽分隔条（40–75、键盘 ±2、<900px 上下堆叠）、MD dataviz 8 系列色图表（细网格/点/数据标签/右上图例）、elevation 0/1/3 与 state layer/ripple 全部落地；数据/引擎未动。

## 1. 十项断言

| # | 判据 | 证据/注入 |
| --- | --- | --- |
| ① | 两栏可拖拽且夹 40–75 | `prismRedesign.test` ①：`clampSplit(20)=40`、`clampSplit(90)=75`、拖拽越界夹紧；页面 `role="separator"` + `aria-valuenow` + 左右键；注入固定 20%/50% ⇒ 败 |
| ② | <900px 上下堆叠且顺序资产→交易→研判 | CSS `@media(max-width:899px)` + `display:flex;flex-direction:column`；移动端 order 1/2/3/4/5；注入仍 grid ⇒ 败 |
| ③ | 块间 8 的倍数、行内 1px/12px/24–26 | `spacingProblems`/`tableRhythmProblems`；注入 `gap:12px` ⇒ 败 |
| ④ | 分段在左栏顶部且三项正确 | 页面左栏 `tw-prism-seg` 在 cards 之前，右栏无第二个；注入右栏加段 ⇒ 败 |
| ⑤ | MD dataviz 8 系列色+细网格/点/右上图例 | `PRISM_SERIES` 8 个；`stroke={PRISM_SERIES[0]}`、`tw-prism-gridline`/`tw-prism-dot`、`.tw-prism-legend{position:absolute;top:8px;right:8px}`；注入单色 ⇒ 败 |
| ⑥ | 表格涨跌仍红涨绿跌 | `.tw-prism-table .up{color:var(--tw-up)}`/`.down`；页面 `pnl>=0?'up':'down'`；注入系列色 ⇒ 败 |
| ⑦ | ripple 仅按钮/分段 | 仅 `RippleButton`（按钮/分段）用 `tw-prism-ripple`；注入 `<tr className="tw-prism-ripple">` ⇒ 败 |
| ⑧ | elevation 0/1/3 都用 | `.tw-prism` e0、`.tw-prism-card` e1、`.tw-prism-seg` e3；注入删 e3 ⇒ 败 |
| ⑨ | 深色用更浅表面色、不放大阴影 | dark 块定义 surface-1/2/3（#16181b/#1b1d21/#23252a），elevation 仍 0 1px；注入 0 8px ⇒ 败 |
| ⑩ | 功能十项不回退 | 四格/摊薄成本/仓位占比/模型/自检文案/时点增删补跑/四份报告/挂单/成交/净值/`—`原因/无声明性文案逐项存在 |

## 2. 关键实现

- `src/client/prismLayout.ts`：`clampSplit`、`splitPctFromDrag`、间距/行高/elevation/深色/系列色判据。
- `src/client/prismView.ts`：`PRISM_SERIES`（8 色）、`equityChartOf`（网格/点/标签共用坐标）。
- `src/client/PrismPage.tsx`：左栏分段 + 四格 + 表 + 图；右栏研判/时点/模型；separator 拖拽与键盘。
- `src/client/styles.ts`：替换棱镜 CSS 为 hybrid 版；移动端 order；深色表面 token。
- `src/client/prismRedesign.test.ts`：10 条断言 + 反例注入。

## 3. 视觉修正 + 设计稿对拍（2026-10-22 20:5x）

用户重启后反馈与设计稿差异；按截图修正并加 `prismDesignParity`（纯函数，输入设计稿 CSS 与实现 CSS）逐项对拍：

| 项 | 设计稿/指定 | 实现 |
| --- | --- | --- |
| 页面底色 | `#f5f6f8` | `#f5f6f8` |
| 卡片圆角 | `10px` | `10px` |
| 卡片阴影 token | `0 1px 2px rgba(16,24,40,.05)` | 同 |
| 卡片实阴影（本轮指定） | `0 1px 2px rgba(0,0,0,.06),0 1px 3px rgba(0,0,0,.04)` | 同 |
| 卡片内边距 | `12px` | `12px` |
| 分段圆角 / 内边距 | `8px` / `2px` | `8px` / `2px` |
| 分段选中背景 | `rgba(94,106,210,.14)` | 同 |
| 表格行高 / tabular | `26px` / `tabular-nums` | 同 |
| 分隔条宽度 | `6px` | `6px` |

- 分段：外层 2px padding + 4px 项间 gap，高 32px；选中项 tonal 填充 + 600 字重。
- 四格：26–30px 半粗数值（28px），标题 12px 次要色，数值上间距 4px；卡片 2×2 避免挤压。
- 表格：`font-variant-numeric: tabular-nums`，表头 12px 次要色、行高 26。
- 右栏：研判汇总 5 条列表（每条 line-clamp 2；剥掉 ```json 决策块）、决策小表（单票/总仓位/orders/cancel）、四份可折叠报告（左色条）、时点/模型独立卡片；页面不渲染 `{"limits"` 原始 JSON。
- 分隔条：6px 竖条 + 2px 线 + hover 强调色 + `col-resize`。
- 图表色改用设计稿 `--viz-*` 8 色（深色换更浅的 viz 色），净值/占比/报告左条共用。

对拍注入：卡片圆角 0 / 删选中背景 / 分隔条 0 / 去 tabular / 页面出现 `{"limits"` ⇒ 各自必败。

## 4. 门禁

- 基线 1146 → 1156 → **1163**（新增 7：对拍 6 + 汇总 JSON 剥离 1）。
- `DSH_HOME=/tmp/prismb39-check{BI,BJ} npm run check`：两轮 **1163 × 2 全绿**（BI 19,180/19,351ms；BJ 19,022/19,427ms）；构建 **73 项**（v0.134.0，`build.mjs` 未动）。
- 只改 `src/client/**`；不 commit、不重启；数据/引擎未动。

## 5. 未做

- 活宿主重启后的真实视觉走查（需用户刷新/重启装载）；当前只做构建与静态断言。
- 模型候选列表仍由宿主 `listModels` 提供；取不到时保持自由输入。
