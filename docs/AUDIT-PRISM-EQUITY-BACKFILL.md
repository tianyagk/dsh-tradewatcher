# 棱镜净值点回填：2026-10-22 capital

> 数据订正，不是代码改动。时间：2026-10-24 11:13:12 +08:00（备份文件时间戳）；备份：`/tmp/prism-equity-backfill-20261024-111312.json`。
> 只改 `$DSH_HOME/dsh-tradewatcher/prism-equity.json` 的 `2026-10-22` 点；`2026-10-23` 点未动。

## 依据（反推）

原 `2026-10-22` 点：

```json
{
 "day":"2026-10-22",
 "equity":1281801.66,
 "cash":1.12,
 "positionsValue":1281800.54,
 "realized":0,
 "unrealized":-218198.34,
 "at":1792675231029
}
```

`unrealized = equity − capitalLimit` ⇒

`capitalLimit = 1281801.66 − (−218198.34) = 1500000.00`

所以该点是当时 150 万本金口径，回填 `capital = 1500000`。当时没有 1.000300 基准数据，`benchmarkClose` 保持 `null`，**不编造**。

## 改动前后

| 字段 | 改前 | 改后 |
|---|---:|---:|
| day | `2026-10-22` | `2026-10-22` |
| equity | 1,281,801.66 | 1,281,801.66 |
| cash | 1.12 | 1.12 |
| positionsValue | 1,281,800.54 | 1,281,800.54 |
| realized | 0 | 0 |
| unrealized | −218,198.34 | −218,198.34 |
| **capital** | **缺失** | **1,500,000** |
| **benchmarkClose** | **缺失** | **null** |
| at | 1792675231029 | 1792675231029 |

`2026-10-23` 点保持：`equity 1,805,855 · capital 2,000,000 · benchmarkClose 4,105.33`。

## 回填后的读数

- 评估 `n`：**1**（两点，按现有 1 日持有窗口重算；独立窗口不是事件数）。
- 超额：**—（基准 1.000300 收盘缺失）**，`withFee` / `withoutFee` 均为 `null`；没有用 0 或当日基准倒推。
- 回撤闸门：**可用**（`reason:null`，n=2），当前读数：
  - 单日 **−11.02%**
  - 自高点累计 **−11.02%**
  - 状态：**已拒新买单**；目标总仓 ≤40%、现金 ≥25%
- 评估的回撤/命中率仍因 `n=1 < 30` 显示样本不足，不回填 0。

## 断言

`src/host/prismEval.test.ts` 新增 `回填 10-22 capital...`：

- `equity[0].capital === 1500000`；注入写成 2000000 ⇒ 必败。
- `equity[0].benchmarkClose === null`；注入编造数值 ⇒ 必败。
- `drawdownGateOf(points)` 返回 `reason:null` 且 `dailyPct/cumulativePct` 为数字。
- `evaluation.excess.withFee === null`，原因含「基准 1.000300」；给出数字/0 ⇒ 必败。
- `points[1]` 与 10-23 原始对象 deepEqual；改到 10-23 ⇒ 必败。

## 说明

- 已写 live `prism-equity.json` 并先备份；未重启宿主，宿主内存中的旧点会在下次启动重新读盘后更新。
- 10-22 的 `benchmarkClose` 保持 null；后续若补基准，需作为新数据订正并另留痕，不能从当日或当前值倒推。
