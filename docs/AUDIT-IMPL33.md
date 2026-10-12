# AUDIT-IMPL33 —— 修筹码红绿倒置（方向反了）+ 盈亏边界必须是**现价**

- 基线：`main` @ `5ebee0a`（v0.56.0），`npm run check` = 408 × 2 全绿
- 本轮结果：**409 × 2 全绿**（+1 条断言；并更新 1 条旧断言的口径层级）
- `build.mjs` **零改动**（75 项片段校验通过）；未 commit / 未装 bundle / 未动 profile / 未重启
- 方法：**先复算事实**（用 lead 给的真值 19.98 / 19.072）→ 改 → 纯函数断言（锚语义）→ **浏览器实测颜色**
  （含"把 avgCost 放到窗口之外看翻转点跟谁走"的决定性实验）

---

## 1. 事实核对与两个错（不是一个）

lead 给的事实：`priceUsed = 19.980005`（现价，`priceSource=quote`）、`avgCost = 19.072`、`support 14.89`、`resistance 22.16`。

读源码后发现**两处**错，都在同一条链上：

| # | 位置（改前） | 错在哪 |
|---|---|---|
| ① | `ChipsPanel.tsx:188` `dirClass(r.center - price, redUp)` | **方向反了**：`center > price`（成本高于现价 = 套牢）得到正号 ⇒ `tw-up` ⇒ **红** |
| ② | `ChipsPanel.tsx:61` `const price = day.avgCost` | **边界用错了价**：套牢/获利的判据是"成本 vs **现价**"，这里却拿**平均成本**当边界 |

（②是 lead 的 task 描述里隐含要求"边界请保持不变 = 现价"，但代码里其实是 `avgCost` —— 本轮一并对齐。）

## 2. 方向对照表（`redUp` 两态，本插件默认 `redUp=true`）

`tw-up` = 红（`--tw-up:#e5484d`，浅色）、`tw-down` = 绿（`--tw-down:#0e8f5c`）。

| 桶中心 vs **现价** | 语义 | 传给 `dirClass` 的符号 | `redUp=true` | `redUp=false` |
|---|---|---|---|---|
| 中心 **高于**现价 | 成本高于现价 ⇒ **套牢** | `priceUsed − center < 0` ⇒ 负 | `tw-down`（**绿**） | `tw-up`（红） |
| 中心 **低于**现价 | 成本低于现价 ⇒ **获利** | 正 | `tw-up`（**红**） | `tw-down`（绿） |
| 中心 **等于**现价 | 不赚不亏 | `0` ⇒ `dirClass` 给 `tw-flat` | 中性灰 | 中性灰 |
| 现价不可得（`priceUsed === null`） | 口径缺失 | — | `tw-flat`（**不是**猜一个颜色） | 同 |

用 lead 的真值复算（`priceUsed = 19.98`）：

```
桶中心   14.9  ⇒ tw-up    红=获利   (低于现价)
桶中心     18  ⇒ tw-up    红=获利
桶中心  19.072 ⇒ tw-up    红=获利   ← 平均成本线上方一点点，仍是获利（因为现价 19.98 更高）
桶中心  19.98 ⇒ tw-flat  (恰好等于现价)
桶中心   20.5  ⇒ tw-down  绿=套牢
桶中心  22.16 ⇒ tw-down  绿=套牢
```

## 3. 改动点

```diff
// src/client/chipsView.ts（新增唯一着色入口，纯函数，可断言）
+ export function chipProfitDirOf(input: { center: number; priceUsed: number | null; redUp: boolean }): string {
+   const { center, priceUsed, redUp } = input
+   if (priceUsed === null || !Number.isFinite(priceUsed) || !Number.isFinite(center)) return 'tw-flat'
+   return dirClass(priceUsed - center, redUp)      // 方向：中心高于现价 ⇒ 负 ⇒ 套牢色
+ }
// src/client/ChipsPanel.tsx
- const price = day.avgCost
...
- className: `tw-chips-bar ${price === null ? 'tw-flat' : dirClass(r.center - price, props.redUp)}`
+ className: `tw-chips-bar ${chipProfitDirOf({ center: r.center, priceUsed: d.priceUsed, redUp: props.redUp })}`
```

- **仍走 `dirClass`**（`chipProfitDirOf` 内部只调用它）⇒ 涨跌色偏好 `redUp` 继续统一生效，**没有写死红绿**
- 轮廓线（`--tw-chip-profile` 中性灰）与三条语义线（橙/紫/蓝 token）**未触碰**
- 头部"盈利比例"没有颜色类（本来就中性），未改

## 4. 为什么边界必须是**现价**（不是平均成本）——举证三条

1. **判据本身**：套牢/获利问的是"**我这个成本**相对**现在的价**是赚还是亏"。现价是唯一的比较基准；
   `平均成本` 只是分布的一阶统计量（一条橙色虚线，回答"筹码平均堆在哪"），它不构成盈亏边界。
   等于用"平均成本当边界"就会得到"平均成本以下的筹码都获利"这种把**分布统计量当价格**的循环定义。
2. **内部一致性（本项目自己的口径）**：头部的 `盈利比例` 由**宿主**计算，公式是
   `Σ(桶价 < 现价 的权重)/Σ权重`（`src/host/chips.ts:385-390`：`const price = isLatest ? priceUsed : b.close`；
   字段注释 `src/host/chips.ts:118` 明确写"盈利比例实际用到的**现价**"）。柱色若用平均成本当边界，
   就会与**紧挨着它的那个数字**自相矛盾（同一屏两套边界）。
3. **外部举证（lead 提供）**：参考实现截图里的红绿分界落在 **≈22.1 ≈ 它的现价 22.07**，而不是它的
   **平均成本 18.57**。⇒ 边界是现价，与我们的实现一致。

> ⚠ **用户口头说的是"平均成本线以上/以下"** —— 从截图上看红绿分界恰好贴着那条橙色虚线，
> 所以被读成"平均成本线"。但按语义（也是参考实现的实际行为）边界是**现价**：当现价与平均成本很接近时，
> 两种说法在图上几乎重合，观感无法区分。本轮按语义实现，并把这条差异如实写在这里，由 lead 向用户解释。

### 4.1 一个**已知的口径不一致**（本轮未改，如实记录）

宿主的 `profitRatio` 对**历史展示日**用"当天收盘价"（`b.close`），对**最新展示日**用 `priceUsed`；
而 `ChipDayDto`（`src/client/api.ts:2-12`）里**没有逐日价格字段** ⇒ 客户端只能拿顶层 `d.priceUsed` 当边界。
于是：**拖滑杆看历史某天时**，柱色按"现价"分、而 `盈利比例` 按"那天的收盘价"算 —— 两者可能不一致。
修法（供 lead 决策，本轮不动）：在 `ChipDay` 里加一个逐日 `price`（宿主已有该变量），客户端按展示日取。
本轮用户遇到的是**默认的最新日**，此处两种口径一致（都用现价），不影响本次修复。

## 5. 其它着色点核查（逐个给结论）

`dirClass` 全仓调用点共 **36 处**（`grep -rn "dirClass(" src/`，排除定义与测试）。判据：
**传入量"正 = 涨/赚/流入"就正确**；只有"成本 vs 现价"这类**符号方向与盈亏相反**的量才需要反转。

| 位置 | 传入量 | 结论 |
|---|---|---|
| `ChipsPanel.tsx:187` | `chipProfitDirOf(...)`（内部 `priceUsed − center`） | **本轮修的就是它**（改前反了 + 边界错） |
| `TopBar.tsx:80,546` | `quote.chg`（涨跌幅） | 正确（正=涨=红） |
| `PortfolioPage.tsx:226,436-438,884-885,961,1074-1080,1085,1280` | 盈亏金额 / 当日盈亏 / `chg` / `ytd` / `netPnl` | 正确（正=赚） |
| `WatchlistPage.tsx:333,396,410,432` | `chg` / 行业 `pct` / `alpha` / `ytd` | 正确 |
| `QuoteDrawer.tsx:210,268` | `chg` / 板块 `pct` | 正确 |
| `QuoteDrawer.tsx:273-274` | `high − prev` / `low − prev`（今高/今低 vs 昨收） | 正确（高于昨收=涨） |
| `MarketPage.tsx:194-195,268,403,440,444,486` | 指数/个股 `chg`、`pct`、资金 `money`、占比 | 正确 |
| `MarketPage.tsx:292,294,433,435` | 常量 `dirClass(1,…)` / `dirClass(-1,…)`（涨/跌家数） | 正确（有意用常量强制方向） |

**专门搜"成本 vs 现价"型着色**：`grep -rn "dirClass([^)]*[Cc]ost[^)]*)"` ⇒ **空**（除筹码柱外没有第二处）。
**筹码模块内的其它颜色**：三条语义线用固定 token（`--tw-chip-avg/res/sup` = 橙/紫/蓝）、
轮廓用 `--tw-chip-profile`（中性灰）、"盈利比例"无颜色类 ⇒ **都不受本次方向修正影响**（符合 task 要求）。

## 6. 断言与反例证据（`chipsView.test.ts` 新增 1 条；`noteIcon.test.ts` 更新 1 条旧断言）

**新增（④）**：

1. **方向对照表**：`chipProfitDirOf({center:20, priceUsed:19, redUp:true}) === 'tw-down'`（套牢=绿）、
   `({center:18,…}) === 'tw-up'`（获利=红）；`redUp=false` ⇒ 两者互换；并断言 `--tw-up` 是红、`--tw-down` 是绿
   （把"绿/红"钉在真实 token 值上，不是文字）。
2. **边界断言（专门防误用平均成本）**：二分求出"最近一次翻转"所在的桶中心
   ⇒ 现价 19 时翻转点 = **19.000**（容差 1e-3）；把现价换成 22.5 ⇒ 翻转点 **22.5**（跟着现价走）；
   并断言着色入口的**签名与实现里都没有 `avgCost`**（`chipProfitDirOf({…})` 不含 avgCost、实现不引用它），
   以及面板把 `d.priceUsed` 传了进去、筹码柱那一行 className 里不出现 `avgCost`。
3. **不许写死红绿**：断言面板里没有 `tw-chips-bar tw-up|tw-down` 的字面量。
4. **反例注入**：本地写一个"方向改回 `center − priceUsed`"的假实现 ⇒ `brokenDir(20,19,true) === 'tw-up'`
   （正是用户看到的错色）⇒ 与真实现不同 ⇒ `assert.throws` 证明"高于现价=套牢/绿"这条断言**必然失败**。

**更新（旧断言的口径层级）**：`noteIcon.test.ts` 原来断言 `panel.includes('dirClass(')`。
着色多了一层语义入口后该字符串不再出现在面板里，但**意图（跟随 redUp、不写死红绿）不变** ⇒ 改成断言整条链：
面板走 `chipProfitDirOf` + 面板无写死红绿 + `chipsView.ts` 里 `return dirClass(priceUsed - center, redUp)`。

**浏览器实测（真组件标记 + 真 CSS，无头 Chromium）** —— 决定性实验：把 `avgCost` 放到**窗口之外**（20.50，
高于所有桶），现价放**窗口内**（18.60）：

| 观测 | 结果 |
|---|---|
| 现价以上的柱（14 根） | class 全部 `tw-down`、颜色全部 `rgb(14,143,92)`（**绿=套牢**） |
| 现价以下的柱（7 根） | class 全部 `tw-up`、颜色全部 `rgb(229,72,77)`（**红=获利**） |
| 翻转点 | 发生在 **18.67 → 18.59** 之间 ⇒ 正是**现价 18.60**，**不是** avgCost 20.50 |
| 若误用 avgCost 当边界会怎样 | 所有桶都在 20.50 之下 ⇒ 全红（无绿）；实测有 14 根绿 ⇒ 排除 |
| 与 lead 真值的一致性 | 用 `priceUsed=19.98 / avgCost=19.072` 复算：19.072 那个桶是 `tw-up`（红/获利），20.5 与 22.16 才是 `tw-down`（绿/套牢） |

## 7. 测试条数变化

| | 条数（每时区） |
|---|---|
| 基线 `5ebee0a` | 408 |
| 本轮之后 | **409**（+1：`chipsView.test.ts` 的 ④ 盈亏着色；另更新了 1 条旧断言的层级） |

`npm run check` 末尾三行：

```
ℹ tests 409
ℹ pass 409
ℹ fail 0
```

（两次各 409：默认时区 + `TZ=UTC`；随后 `ALL HOST CHECKS PASSED (live probes soft)` 与
`built lib/index.js + lib/client.js （v0.56.0，客户端片段校验通过：75 项）`。）
改动文件：`src/client/{ChipsPanel.tsx,chipsView.ts,chipsView.test.ts,noteIcon.test.ts}` + 本文件；
`build.mjs` / `package.json` / `cordis.patch.yml` **零改动**。

## 8. 未做项

1. **历史展示日的边界口径不一致**（§4.1）：`ChipDayDto` 无逐日价格 ⇒ 客户端只能统一用顶层 `priceUsed`。
   本轮不动（用户遇到的是最新日，两种口径一致）。修法已在 §4.1 写明。
2. **未改参考实现的其它呈现习惯**（如是否把获利/套牢做成"柱宽=权重、颜色=盈亏"以外的编码）—— 超出本轮。
3. **未在真页面截图**（GUI 需带鉴权的 URL）；用真组件标记 + 真 CSS 的无头 Chromium 量色（§6）替代，
   并把 avgCost 刻意挪出窗口以排除"边界是平均成本"的可能。
