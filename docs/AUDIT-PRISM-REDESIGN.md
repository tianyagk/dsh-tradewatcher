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

## 3. 门禁

- 基线 1146 → **1156**（新增 10）。
- `DSH_HOME=/tmp/prismb38-check{BA,BB} npm run check`：两轮 **1156 × 2 全绿**（BA 19,811/19,875ms；BB 19,859/19,608ms）；构建 **73 项**（v0.133.0，`build.mjs` 未动）。
- 只改 `src/client/**`；不 commit、不重启；数据/引擎未动。

## 4. 未做

- 活宿主重启后的真实视觉走查（需用户刷新/重启装载）；当前只做构建与静态断言。
- 模型候选列表仍由宿主 `listModels` 提供；取不到时保持自由输入。
