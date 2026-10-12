# AUDIT-IMPL34 —— 逐日盈亏边界价（`ChipDay.price`）：柱色与「盈利比例」同源

- 基线：`main` @ `d9bde74`（v0.57.0），`npm run check` = 409 × 2 全绿
- 本轮结果：**412 × 2 全绿**（+2 宿主断言、+1 客户端断言；并更新 1 条 v0.57.0 断言的接线锚点）
- `build.mjs` **零改动**（75 项片段校验通过）；未 commit / 未装 bundle / 未动 profile / 未重启
- 修的正是上一轮（AUDIT-IMPL33 §4.1）如实记录的那条口径不一致

---

## 1. 问题（一行说清）

宿主算 `profitRatio` 用的是**逐日**的价（`const price = isLatest ? priceUsed : b.close`，`src/host/chips.ts:398`），
而客户端给筹码柱上色统一用**顶层现价** `priceUsed` ⇒ **拖滑杆到历史展示日**时，同一屏出现两套边界：
柱色按"今天的价"分、`盈利比例` 按"那天的收盘价"算。

## 2. 改动点

### 宿主（`src/host/chips.ts`）

```diff
  export interface ChipDay {
    narrow: boolean
+   /** 该展示日的**盈亏边界价**（与 profitRatio 同源：最新日 = 顶层 priceUsed；历史日 = 当日收盘价；不可得 null） */
+   price: number | null
    profitRatio: number | null
  ...
    days.push({
      ...
      narrow,
+     // 与 profitRatio 同一个 `price`（上面那行）⇒ 两者永远同源，不许各算一套
+     price: price === null ? null : round(price, 4),
      profitRatio: profitRatio === null ? null : round(profitRatio * 100, 2),
```

- 取值就是**那一个已经存在的变量**（`chips.ts:398` 的 `const price`，同时喂给 `profitRatio`）⇒ 同源是**构造上**保证的，不是"两处各写一遍要记得对齐"。
- 口径（字段注释里写全）：**最新展示日** = 顶层 `priceUsed`（现价：优先 quote，宿主按需回落收盘价）；**历史展示日** = **当日收盘价** `bars[i].close`；不可得 ⇒ **`null`**（界面按"未取到"，不猜价）。
- 顶层 `priceUsed` / `priceSource` / `fq` / `priceScale` / `barAlignsWithDisplay` / `missing` / `why` **全部保留未改**。

### 客户端类型（`src/client/api.ts`）

```diff
    narrow: boolean
+   /** 该展示日的盈亏边界价（与 profitRatio 同源）。⚠ **可选**：老宿主不带 ⇒ 如实回退顶层并留痕 */
+   price?: number | null
    profitRatio: number | null
```

声明为**可选**（不是必填）就是"向后兼容"的落点：老宿主不发的字段不会被读成 `undefined` 崩溃，而是走回退分支。

### 客户端取价（`src/client/chipsView.ts` 新增纯函数）

```ts
export function chipsDayPriceOf(input: { dayPrice?: number | null; topPriceUsed: number | null }):
  { price: number | null; fallback: boolean; note: string | null }
```

- 有逐日 `price`（有限数）⇒ 原样用，`fallback: false`
- 缺失/为 null/非有限数 ⇒ **回退顶层 `priceUsed`**，`fallback: true`，`note` 写明**原因**
  （`该展示日未带 price（老宿主）…` 与 `该展示日 price 不可用（null）…` 分开，别让人以为是同一件事）
- 两者都不可得 ⇒ `price: null`（界面按"未取到"，不猜一个价）

### 客户端渲染（`src/client/ChipsPanel.tsx`）

```diff
+ const dayPrice = chipsDayPriceOf({ dayPrice: day.price, topPriceUsed: d.priceUsed })
+ const priceLabel = at === days.length - 1 ? '现价' : '当日收盘价'
- className: `tw-chips-bar ${chipProfitDirOf({ center: r.center, priceUsed: d.priceUsed, redUp: props.redUp })}`
+ className: `tw-chips-bar ${chipProfitDirOf({ center: r.center, priceUsed: dayPrice.price, redUp: props.redUp })}`
```

- **「盈利比例」的 tooltip 一并改口径**（本来写"现价"，历史日那样写是**错的**）：
  `Σ(桶价 < 当日收盘价 的权重)/Σ权重；当日收盘价 18.55（该展示日为历史日，用当日收盘价，…）`；
  最新日仍写"现价"并带 `来源 quote/close`。
- **回退留痕**追加进同一 tooltip（`⚠ …回退顶层现价…`）——tooltip 不是常驻可见文案（沿用 v0.56.0 的约定）。

## 3. 断言与证据

### 宿主侧（`src/host/chips.test.ts` 新增 2 条）

1. **逐日取值 + 同源复算**：3 天（收盘 10/20/30）+ 现价 25（**刻意不等于任何一天收盘**）⇒
   `days[0].price === 10`、`days[1].price === 20`、`days[2].price === 25`；
   对**每一天**用该日 `price` 复算 `Σ(桶中心 < price 的权重)`，必须等于该日 `profitRatio`（±0.01%）；
   现价缺失（`price: null`）⇒ 最新日 `price === null`，历史日不受影响。
2. **端到端跨模块**（宿主 DTO → 客户端取价 → 柱色）：10 天序列，逐日断言
   ① `chipsDayPriceOf` 有 `price` 时不回退、取到的就是该日的价；
   ② 价下方=获利（`tw-up`）、价上方=套牢（`tw-down`）；
   ③ 用该日 `price` 复算的分界 == 宿主 `profitRatio`；并要求逐日价**真的逐日不同**（否则这条证明不了什么）。

### 客户端侧（`src/client/chipsView.test.ts` 新增 1 条 + 更新 1 条）

- **⑤ 逐日边界价**：取价规则 4 例（有/缺失/null/null+null）；
  两天 fixture（价 18 / 20，桶中心 16…22）⇒ 翻转点 **18 → 20 随日移动**；
  **同源断言**：用 DTO 的 `price` 复算的分界 == 该日 `profitRatio`（第 1 天 20%、第 2 天 60%，两天不同）；
  结构断言：面板必须 `chipsDayPriceOf({ dayPrice: day.price, topPriceUsed: d.priceUsed })`，
  筹码柱一行必须用 `dayPrice.price` 且**不出现** `d.priceUsed`；回退留痕必须被 tooltip 消费。
- **反例注入**：本地假实现"统一用顶层 `priceUsed`" ⇒ 第 2 天恰好一致、**第 1 天不同** ⇒
  `assert.throws` 证明"第 1 天翻转点 = 18"这条断言**必然失败**。
- 更新 **④**（v0.57.0 那条"边界是现价"）的接线锚点：从 `priceUsed: d.priceUsed` 改成 `priceUsed: dayPrice.price`
  —— 断言**意图不变**（边界是一个**价**、不是平均成本），只是它现在按展示日取。

### 浏览器/真实回包证据

| 证据 | 结果 |
|---|---|
| **端到端复算（12 天，本地跑真 `chipSeriesOf`）** | 用逐日 `price` 复算 `profitRatio` ⇒ **0/12 不一致**；最新日 `price === priceUsed(30.5)`；历史日 `price === 当日收盘价`（容差 1e-3，差值仅来自 `round(price,4)` 的末位） |
| **端到端链路（宿主→客户端）** | 10/12 天逐日校验，取价不回退、翻转方向正确、分界与宿主一致 ⇒ **不匹配 0** |
| **向后兼容（拿真实线上回包试）** | 线上 `dsh web` 仍是已发布的 v0.57.0 宿主（**没有** `days[].price`）⇒ 客户端回退：`{price: 2.94, fallback: true, note: '该展示日未带 price（老宿主）⇒ 回退顶层现价 2.94：柱色与该日盈利比例可能不同源'}` |
| 顶层字段仍在（别的消费方不受影响） | `priceUsed 2.94 / priceSource quote / fq 1 / priceScale 0.9986`；`missing` 仍是数组、`why` 语义未动 |
| 交付方式 | 老宿主 + 新客户端 ⇒ 行为与 v0.57.0 **完全一致**（回退到顶层现价）+ 一条可追的 note；新宿主 + 新客户端 ⇒ 逐日同源 |

> 注：**线上进程仍是旧宿主**，我没有重启 `dsh web`（约束要求），所以无法用接口验证新字段 —— 因此改用
> 本地直接调用宿主纯函数 `chipSeriesOf` + 真实线上回包做**两条路**的验证（上表）。装机后可用
> `curl '127.0.0.1:3080/tradewatcher/chips?secid=…' | jq '.days[-1].price'` 复核（应等于顶层 `priceUsed`）。

## 4. 一个需要你（lead）知道的边界情况：`barAlignsWithDisplay === false`

宿主原本的规则（未改）：`priceUsed: barAligns ? priceUsed : (latest !== null ? null : priceUsed)`
—— 当"显示的最后一根 ≠ 最新一根日线"时把**顶层** `priceUsed` 置 null、`priceSource` 记 `close`。
本轮新增的 `days[last].price` **不跟着置 null**，理由：它的定义是"**该日 `profitRatio` 用的那个价**"（同源），
而 `profitRatio` 在那种情况下确实是用 `priceUsed` 算出来的 —— 若这里也置 null，柱色与那个数字又会分家（回到本轮要修的病）。
⇒ 结果：`barAligns === false` 时，顶层 `priceUsed` 为 null（老消费者行为不变）、`days[last].price` 有值、客户端用逐日价上色且与 `profitRatio` 同源。
tooltip 里同时给出 `来源 ${priceSource}`（那时是 `close`），所以不会把"定格收盘价"说成实时现价。
若你认为 `barAligns === false` 时连逐日价也该置 null，说一声——那是**产品口径**决定，改一行即可（但会让柱色变中性、与 `profitRatio` 数字脱钩）。

## 5. 测试条数变化

| | 条数（每时区） |
|---|---|
| 基线 `d9bde74` | 409 |
| 本轮之后 | **412**（+3：宿主 2 条（逐日价同源、端到端跨模块）+ 客户端 1 条（逐日取价/翻转/回退留痕）；另更新 1 条旧断言接线） |

`npm run check` 末尾三行：

```
ℹ tests 412
ℹ pass 412
ℹ fail 0
```

（两次各 412：默认时区 + `TZ=UTC`；随后 `ALL HOST CHECKS PASSED (live probes soft)` 与
`built lib/index.js + lib/client.js （v0.57.0，客户端片段校验通过：75 项）`。）
改动文件：`src/host/{chips.ts,chips.test.ts}`、`src/client/{api.ts,chipsView.ts,ChipsPanel.tsx,chipsView.test.ts}` + 本文件；
`build.mjs` / `package.json` / `cordis.patch.yml` **零改动**。

## 6. 未做项

1. **未动 `barAlignsWithDisplay === false` 的口径**（§4）：照原样保留顶层置 null，新增的逐日价不置 null；要不要统一由 lead 定。
2. **未改 `shared/model.ts`**：本轮的 DTO 形状改动集中在 `client/api.ts` 与宿主 `ChipDay`（`shared/model.ts` 里没有筹码 DTO 定义，grep 确认）。
3. **未在真页面复核**（GUI 需带鉴权的 URL；且线上宿主是旧版）：用本地纯函数 + 真实回包双路验证替代；装机后一行 `jq` 可复核（§3）。
4. **分时/其它图表不涉及**：这次口径只影响筹码柱色与筹码 tooltip。
