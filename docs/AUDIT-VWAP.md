# AUDIT-VWAP：分时均价（VWAP）逐点回填

> v0.167.0｜**只改** `src/shared/trendVwap.ts`（新增）、`src/host/em.ts`（两处适配）、`src/shared/model.ts`（`avgApprox`）、`src/client/QuoteDrawer.tsx`（基准 + 口径行）。
> 未改 `build.mjs`（73 项）、无新依赖、**无新路由**、未 commit、未重启；`DSH_HOME=/tmp/vwap-*`。

## 一行结论
分时适配层现在**逐点累计**回填 `avg`：有成交额走 `Σamount ÷ Σvolume`（精确，`avgApprox=false`），
缺成交额走 `Σ(典型价×volume) ÷ Σvolume`（近似，`avgApprox=true`），`volume=0` 的点沿用前值；
做T 网格改用**最后一个非空 avg**（部分点有就可用，全无才给原因），口径行在近似时追加 `· 均价为近似（缺成交额）`。

## 实现要点
| 点 | 说明 |
|---|---|
| 逐点累计 | `backfillTrendAvg(points, { lotSize })`：先认上游给的 `avg`（东财 f58 / 新浪全球期货），没有才累计 |
| **单位坑（实测踩到）** | A股/ETF 分钟量是**手**、额是**元** ⇒ `lotSize: 100`；漏乘会让均价差 100×，被 `normalizeTrendSeries` 的"均价必须落在价格区间"判据直接丢成 null（第一版实测正是全 null） |
| 零量 | `vol=0/缺失` ⇒ `avg = 前值`（前值为空 ⇒ null），**不写 0** |
| 对齐 | `avg` 挂在**同一个点**上（`{...p, avg}`），最后一点的 avg 即当前均价 |
| 做T | `lastAvgOf(points)` = 最后一个非空 avg；全无 ⇒ `tWindowOf` 返回原因（整组不渲染） |
| 均价线 | 图上仍按点画（`null` 断线）；部分点有 ⇒ 线照画、做T 照用 |

## 五条断言（`src/shared/trendVwap.test.ts`，7 条）
① 3 根（vol 100/200/300，amount 1000/2200/3600）⇒ 末点 `avg = 6800/600 = 11.333`（单点算 = 12 ⇒ 注入必败）；
② 无 amount、典型价 10.33/11.33/12.33、vol 各 100 ⇒ `avg ≈ 11.33`、`avgApprox=true`（写死 close = 11 ⇒ 必败）；
③ `vol=0` 的点沿用前值；首点 `vol=0` ⇒ `null`（写 0 ⇒ 必败）；
④ 有 amount ⇒ `avgApprox=false`（误标近似 ⇒ 必败）；
⑤ 全无 avg ⇒ 做T 有原因；部分有 ⇒ 做T 正常（"任一点缺就禁用" ⇒ 必败）。
另加：`lotSize=100` 单测（546k 手 / 2.27 亿元 ⇒ 均价落在 4.15 量级，漏乘 100 ⇒ 415.5 ⇒ 必败）。

## 真实读数（2026-10-26 14:0x，真实网络，东财本次回 trends2）
| secid | 源 | 点数 | 末点价 | **末点 avg** | avgApprox |
|---|---|---:|---:|---:|---|
| `1.600519` 贵州茅台 | sina-minute（新浪 1 分钟，带成交额） | 187 | 1341.01 | **1335.639** | **false（精确）** |
| `0.000636` 风华高科 | sina-minute | 187 | 37.35 | **38.295** | false（精确） |
| `1.510300` 沪深300ETF | sina-minute | 187 | 4.16 | **4.147** | false（精确） |

> 实测确认：新浪 CN 分钟**是带 amount 的**（`226803266 元 / 545889 手`）⇒ 走精确口径；
> 近似分支留给真正缺成交额的源（如部分外盘/归档），并由 `avgApprox` 标记 + 口径行说明。

**门禁**：**1339 × 2 时区**全绿（1332 基线 + 7 条）+ 构建 **73 项**。
