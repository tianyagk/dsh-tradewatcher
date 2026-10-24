# 棱镜第二批（P-03/P-02/P-20/P-11 + CSS 对拍）施工审计

> 基线：`v0.154.0`，测试基线 1250。范围：P-03 评估口径、P-02 非重叠样本、P-20 回撤闸门、P-11 行业上限、评估卡 C / 回撤 B / 行业上限 A，以及 CSS 全量对拍。
> 只改 `src/**` 与报告；`build.mjs` 不动、无新依赖、不 commit、不重启；隔离 `DSH_HOME=/tmp/pb2-*`。

## 一行结论

四项全部落地，评估卡在净值卡之后、回撤闸门只拒新买单不自动卖、行业上限可编辑并进入裁剪链；CSS 对拍从 40 项不一致降到 **0**（68 项全对齐，2 处 12px 下限覆盖已注明）；全量 **1262**。

## 1. P-03 / P-02 评估口径

- `src/host/prismEval.ts`：`EVAL_MIN_SAMPLE=30`、`EMBARGO_DAYS=1`、`EVAL_FOOTNOTE='非重叠样本 · 不含 embargo 区间'`。
- `nonOverlappingWindowsOf` 起点间隔 = 持有期；`n` 是独立窗口数，不是事件数（100 个事件/持有 5 日 ⇒ 19 个窗口）。
- `evaluationOf` 输出：
  - `excess:{withFee,withoutFee,reason,n}`：含费 = 组合资本调整后收益 − 基准；不含费 = 加回区间内 fees 后再减基准；**同时给两个数**。
  - `drawdown:{value,reason,n}`：资本调整后序列自高点回撤。
  - `hitRate:{value,reason,n}`：独立窗口超额 >0 的比例。
  - 每个指标 `n`；`n<30` 一律 `null + 原因`，不写 0。
  - `embargoDays` / `footnote` / `curve` 回传。
- GET 用 `fills` 按日汇总费用；基准来自 P-01 的 `benchmarkClose`（1.000300）；缺基准/缺点写原因。

**UI（评估卡 C）**：右栏净值卡之后、版本信息之前；三行指标 + 每行 n + 迷你超额曲线；脚注固定；样本不足行 `—（样本不足 n=X < 30）`。

断言/注入：

- 100 个重叠事件/持有 5 日 ⇒ `n=19`，起点间隔 ≥5；`embargoDays` 回传。
- `n<30` ⇒ `excess.withFee=null`、`drawdown.value=null`，原因含 `样本不足 n=… < 30`；返回 0 无效。
- 超额同时有 `withFee` 与 `withoutFee`。
- 全文/测试扫描不得出现「预测能力」。

## 2. P-20 回撤闸门

- `drawdownGateOf` **只用 `equity − capital`**，不用被入金污染的 raw 权益；阈值单日 `≤−3%`、自高点 `≤−10%`（先按 2 位取整再比较，避免浮点边界）。
- 单日触发 ⇒ 目标总仓 ≤60%；累计触发 ⇒ 总仓 ≤40% 且现金 ≥25%；连续两轮触发 ⇒ `freezeRound=true`。
- `applyDrawdownGate`：只过滤买单、原样保留卖单、把被拒买单写入 `rejects`；**不新建委托、不自动卖**。
- run 计算上一轮 gate（按 `startedAt` 找之前 run），写入 `PrismRun.drawdown`。
- 决策卡新增「回撤闸门」行：`单日 −3% / 累计 −10% / 状态`，当前单日/自高点/目标总仓/样本 n；无数据写原因。

断言/注入：

- 资本调整后不触发、raw 跳升不误触发；累计 −10% 触发。
- 触发时买单被拒、卖单保留；`自动卖出` 无路径。
- 连续两次触发 ⇒ `freezeRound=true`，拒绝原因含「冻结」。

## 3. P-11 行业上限

- `limits.byIndustry` 接入 `clampDecision` 的行业维度；裁剪链仍是 **单票 → 行业 → 总仓 → 现金**，共用 `ClampContext` 分母，整手向下、夹掉不重分配、行业缺失不夹、卖单不裁。
- settings 增加 `industryLimits`；`POST {action:'industryLimits', industryLimits}` 校验 0–100 后持久化。
- `runPrismForSlot` 把 settings 行业上限合并进本轮 `limits.byIndustry`，下一轮裁剪生效。
- **UI A**：行业卡「上限」列可编辑 input（Enter/blur 保存）；`未穿透`、`现金` 固定行无 input。
- 评估/行业暴露/回撤仍是既有数据源，不新增。

断言/注入：

- 设置半导体 18% + 2000 股买单/总资产 100000 ⇒ 夹到 1800 股；缺行业 ⇒ 不夹。
- 固定行无 `tw-prism-limitinput`；注入固定行 input ⇒ 测试失败。
- 页面保存调用 `prismSetIndustryLimits`；下一轮 route 使用 settings 合并。

## 4. UI 与 CSS 对拍

- 评估卡 C 位于右栏净值卡后、版本前；回撤行在决策卡；行业上限 A 在行业卡表内。
- CSS 对拍：`src/client/prismDesignParity.ts` 扩到 **68 项**（颜色/形状/阴影/排版/间距/分段/表格/按钮/输入/堆叠条/图例/净值曲线/评估/行业上限/深色）。
- 对拍测试读取 **v3**（v2-final 同步核对），逐项 `design / impl / ok`；任一 false 即失败。
- 注入覆盖：卡片圆角 0、分段选中背景删除、表格字号 13、分隔条 0、阴影 none、深色阴影放大、图例 11px；均能触发失败。
- 改前 **40 项不一致 / 66 项**；改后 **0 项不一致 / 68 项**。文字表见 `docs/CSS-PARITY-PRISM.md`。
- 2 处无法按设计原值落地：净值坐标 11px、图例/评估 n 11.5px；仓库全局密集字号下限为 12px，已用 12px 并在对拍表注明原因。

## 5. 门禁

- 新增/替换后全量：**1262 / 1262**。
- 两轮 `npm run check`（`/tmp/pbfix3-check1`、`/tmp/pbfix3-check2`）均绿；构建 **73 项**（v0.154.0）。
- `build.mjs` 未动；无新依赖；未 commit、未重启。

## 6. 未做 / 边界

- P-03 未引入历史信号重放；评估基于已有净值点/费用/基准，n 不足按原因显示。
- P-20 不自动卖、不修改已有持仓；目标仓位只写提示，不据此自动生成卖单（R12）。
- P-11 只支持行业上限配置与裁剪；未做行业 ETF 成分穿透。
- 深色设计稿没有独立 token 段，深色行按既有 hybrid 深色值对拍。
- 未在活宿主重启后做浏览器截图验收；以测试、构建与 CSS 源码对拍为准。

## 7. 分段/决策依据的渲染级修复（2026-10-24）

- 分段：容器 `gap:4px`、`padding:2px`，每项最小宽按最长标签 + 左右 12px（当前 49px）；选中 `.18` / 700 / `#2f3aa0`，未选中透明，肉眼可分辨。
- 仓位上限依据：`basisBlocksOf` 强制恰为 3 块，页面渲染 3 个独立 `.tw-prism-basis-block`（`white-space:nowrap`），块内不再用 `\n` 拼成一段；第三块 `本次夹紧` 等宽数字。
- 渲染级断言：`segmentLayoutOf` 计算实际 x/width/gaps（注入 gap0 ⇒ 败）；`segmentPaintOf` 选中/未选中背景必须不同（同色 ⇒ 败）；`basisBlocksOf` 只接受 3 块（合成一段/2 块/4 块 ⇒ 败）。
