# 棱镜 · AGENT DESK 第一批（顶部状态条 + 左栏）实施记录

> 基线 `v0.205.1`（1580/1580，73 片段）→ 本批 **1628/1628，73 片段**。
> 设计稿：`AGENT DESK`（1511×1102）。方案与五问拍板见 `docs/PRISM-DESIGN-DIFF.md` §12–§13。
> 范围：**只做顶部状态条 + 左栏**；中栏（个股详情/决策流）与右栏（账户总览/绩效）代码与样式未动。

## 1. 交付面

| 项 | 实现 |
|---|---|
| 顶部状态条 | `.tw-ad-top` 56px；logo（纯 SVG）+ `AGENT DESK` 14px + `AUTONOMOUS` 徽标 + 副标题 `自主交易代理 · 人类只设边界`；右侧 `自检` chip、`RUNNING #N`、北京时间 `HH:MM:SS`、`⏸`（`disabled` + `title="宿主未提供暂停接口"`）、`?`（3 行浮层：谁能设约束 / 谁执行 / 只读范围） |
| 资产上限卡 | `HUMAN` 徽标 + `约束 —`（版本无源）+ `账户总资产上限`/`Agent 可调动的最大资金` + 19px `¥1,800,000` + `CNY` + 滑杆 0–500 万（step 0.1 万）+ 五档刻度 + 六格 + 已用额度 + 进度条 + 说明行 + `约束未变更 / 应用约束 → 下发 Agent` |
| 持仓明细卡 | `HUMAN` 徽标 + 5+1 列（标的 / 持股数 / 成本价 / 权重 / 盈亏 / `⋯`）+ 行内编辑（编辑条保存/取消）+ `⋯` 菜单（编辑 / 移除）+ 卡底 `＋ 添加持仓` + `浮盈 Σpnl` |
| 左列权限条 | `.tw-ad-col-human`：卡片琥珀描边 + 2px 渐变竖条 + 单行权限条（20 字） |

## 2. 三条硬约束的落点

1. **默认值只做 placeholder**：`LIMIT_FALLBACK` 只进 `placeholder`，整格带 `title="默认值，未保存"` + `data-default="1"`；`constraintPayloadOf` 在草稿为空时发**宿主原值或 `null`**（绝不把 15/200000/85/8/5/15 写进存档）；`usageOf(limit, used)` 签名里没有 settings，从结构上拿不到默认值。
2. **`#N` 用真实 `runsCount`**：`runsBadgeOf()`，缺失/NaN ⇒ `#—`（不写 `#0`）。
3. **权重/盈亏/持仓市值来自回包**：`desk.positions.rows` 的 `pnl`、`marketValue`；权重 = `marketValue / desk.overview.totalAssets`（分母只认宿主总资产），页面无 `qty × price` 自算。

## 3. 与设计稿的已知偏离（都写在代码注释里）

| 处 | 设计稿 | 本批 | 原因 |
|---|---|---|---|
| 约束版本 | `约束 v1` | `约束 —` + title | `settings` 无版本字段，不编号（R1） |
| 六格值 | 白色实值 | 灰字 placeholder | 宿主六项全 `null`；硬约束 1 |
| 左栏宽度 | 344px | **392px** | 5+1 列在 344px 内只剩 ~2px 给「标的」；392px 与设计稿在 1700px 下的占比一致（≈23%），列宽按内容收窄到 `1fr 48 50 38 50 20` |
| 85% 刻度线 | 常显 | 仅当 `maxPosPct` 是**已保存值**时画 | 默认 85 不得参与任何呈现计算 |
| 数字字号 | 9.5–11.5px | 统一 12px | 仓内可读性下限 |

## 4. 门禁

- `npm run check` 第 1 轮：1628/1628（默认 TZ + `TZ=UTC` 两遍），host 自检全绿，build 73。
- `npm run check` 第 2 轮：同上 1628/1628、73。
- 测试总数：1580 → **1628**（改 6 条与设计稿冲突的旧断言 + 新增 `prismDeskTop.test.ts` 48 条；只增不减）。

## 5. 截图

`docs/shots/PRISM-AGENT-DESK-B1-1700-dark.png`（1700×1200，深色）与 `...-interactive.png`（`?` 浮层 + `⋯` 菜单展开态）。

**这是静态镜像，不是 CDP 实机**：用打好的 `lib` 同一份 `src/client` 代码在 esbuild 里单独打包成 IIFE，`fetch` 打桩喂**真实回包夹具**（`~/.dsh/dsh-tradewatcher` 的 account/orders/equity/runs/settings + 一次真实行情 = `prismDeskOf` 的产物：used 1,240,226 / limit 1,800,000 / runsCount 20 / Σpnl −217,716），Chromium headless 渲染截图。实机 DSH Web UI 需登录令牌，本轮未取。
