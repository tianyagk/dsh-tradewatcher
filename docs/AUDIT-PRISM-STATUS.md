# 棱镜审计修复状态（截至 v0.235.0）

三份审计共 86 条（P0 10 / P1 33 / P2 43）。本文件跟踪已修项与剩余项。

## 已修（按版本）

| 版本 | 来源 | 修复 |
| --- | --- | --- |
| v0.224.2 | UI P0 / PROMPT P0 | 侧栏持仓市值排除现金行；解析 `side` 缺失不再默认买；落盘 `singlePct` 按配置归一 |
| v0.225.0 | A2 / PROMPT P0 | 空组合复制拒绝；复制写 `avgCost`；总仓上限配置优先；快照补可卖数量 |
| v0.226.0 | A1 / D1 / PROMPT P0-4 | 卖出只冲减账面成本（成本不再为负）；`saveAll` 跨进程保护；回撤闸门入上下文；`normalizeCostBasis` |
| v0.226.1 | UI P0 | 刷新指纹排除 `asOf`（此前从未生效） |
| v0.227.0 | UI P1 | 回包剥离 `reports/decisionFlow`；请求代号防旧回包；新闻无谓写盘；回填完成态 |
| v0.228.0 | PROMPT P0-1 / ACCOUNT B1 / P0-2 | 行业上限配置优先；盘前不写净值点；缺价传 null |
| v0.229.0 | ACCOUNT F1 / UI P1-3 | 缺均价不做止损判定但留痕；账本错误不再静默 |
| v0.229.1 | ACCOUNT P1 | `saveRun` 写盘即归一 |
| v0.230.0 | UI P1 / PROMPT P2 | 删除重复顶层 `trading`；`times`/`lastFired` 严格校验；百分比/金额读回校验 |
| v0.231.0 | F4/B2/A3/A6/C1/B3 | `singlePct/totalPct` 限 0–100；0/NaN 价按成本；复制 realized 归零；复制取消旧挂单；rebase 不解锁；闸门样本不足状态 |
| v0.232.0 | A4/A5/F3 | 手工调仓成对记账；现金编辑写 ledger；新开仓行业归属 |
| v0.233.0 | D2/B2 | 同日净值点不倒退；取价失败不写点 |
| v0.234.0 | UI P2 | 新闻时间解析统一；缺 `important` 不丢条目 |
| v0.235.0 | A7/C4 | `realizedFromIdentity` 非法输入返回 null；老账本 `available` 回落 qty |

共 **38 条**（P0 10 全部关闭）。

## 未修（下一阶段）

| 编号 | 严重度 | 摘要 |
| --- | --- | --- |
| D3 | 部分修复 v0.237.0 | `saveAll` 锁内合并磁盘净值点，`saveEquity` 单独写入不再被覆盖；`appendPrismLedger` 仍为独立追加 |
| D4 | ✅ 已修 v0.236.0 | `runExclusive` 用 AsyncLocalStorage 识别重入（同上下文复用锁，并发请求仍排队） |
| C2 | 暂不采纳 | ETF 撮合允许非整手（仓内已有 5062 份的既有口径与测试）；改为整手会破坏现有成交口径 |
| C3 | ✅ 已修 v0.238.0 | 每笔成交都累计 `order.fee` |
| A8–A17 / B5–B12 / C5–C12 | P2 | 见原审计文档 |
| PROMPT 剩余 | P1/P2 | 四路提示词 78K 字符可压缩；两处分母仍有成本/现价混用 |
| UI 剩余 | P2 | 回包 `analyses[].text` 445KB 可通过预抽 three 再降 |

## 端到端验收

重启后运行：`node scripts/verify-prism.mjs --write`
（默认只读；`--write` 会执行 `backfillAvgCost` + `normalizeCostBasis`）

**2026-11-25 13:09 重启后实测：8 / 8 通过。**

| 检查 | 实测 |
| --- | --- |
| 回包体积 | **825 KiB**（原 1 616 KiB） |
| 部署特征（无顶层 trading + <1MB） | 通过 |
| `available ≤ qty` | 通过 |
| 全部持仓有 `avgCost` | 通过 |
| `cost` 已对齐 `avgCost` | 通过（招商轮船 **18.21**、儒意 **17.27**） |
| 闸门状态可读 | 通过 |
| 净值恒等式误差 | **0.00** |

迁移动作：`backfillAvgCost` → `normalizeCostBasis` → `rebase`（后者把 `realized` 按恒等式重算为 −248 117.67）。

## 验证基线

`npm run check`：**2042 / 2042 × 2 时区** + build（73 项）+ `tsc` 0。
