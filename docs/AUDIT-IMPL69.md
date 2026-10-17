> **历史快照**：本文记录的是当时（见下方正文）的用例数 / 读数 / 抓包，**不代表现状**；现状以 `README.md` 与代码为准。

# AUDIT-IMPL69 —— 美股周/月/年 K：由日线聚合 + 拆股断层标注（实现报告）

- 基线：`main` @ `9358b48`（v0.102.0 / 759 用例）。本轮新增 `src/host/usAggregate.test.ts`（6 例），
  并**反转**上一批（AUDIT-IMPL68）"美股周/月/年禁用"的断言。
- 用户裁决：**继续做美股周/月/年 K**（此前因"上游只有日线"而禁用）。
- 纪律：未 commit；未装、未动 profile、**未重启 `dsh web`**；`build.mjs` **零改动**（本轮不碰客户端锁定文案）；
  实验隔离 `DSH_HOME=/tmp/usw-*`；`robots.txt` 先取（本轮**没有新增主机**：仍用 `stock.finance.sina.com.cn`，
  上一批已预检 302/无 robots 文件）；`Disallow` 零请求。

---

## 0. 结论

1. **周/月/年 = 日线聚合**（不是新上游）：自然周（周一…周日）/ 自然月 / 自然年，按**美东交易日日期**分组；
   每根 `open`=首根、`high`=最高、`low`=最低、`close`=末根；`vol`/`amount`=**求和**，
   **任一日缺失 ⇒ 该根记 null**（不把 null 当 0）。口径句固定写全：`由日线聚合（非上游原生周线/月线/年线）` +
   `美股日线为未复权原始价：拆股/分红未调整`。
2. **拆股断层如实标注、绝不改价**：相邻日 `|close/prevClose−1| ≥ 25%` **且**比值落在常见拆合股比附近（相对误差 ≤8%）
   ⇒ 记"疑似拆股/合股"，图上在该根画竖虚线 + 「拆」角标（悬停给 `4:1 拆股 · 2020-08-31`），
   口径行写「检测到 N 处疑似拆股/合股（未复权，价差不可比）」。**不做任何隐形复权**。
   实网验证：AAPL 检出 5 处（1987/2000/2001 `2:1 拆股`、2007 `1:3 合股`、**2020-08-31 `4:1 拆股`**），
   FRO 检出 2016-02-03 `1:5 合股` —— 与公开事实一致。
3. **三档解禁**：上一批的四处拦截**全部反转**（`tabUnavailableReason` 判据、按钮 `disabled`/`aria-disabled`、
   禁用的 CSS、宿主 `klt≠101 ⇒ null`、`klineMissingReason` 里"本插件不提供"的分支）。
4. **复权仍不可得**（`fqSupported(美股)=false` 不变）⇒ 筹码仍不提供、位置仍拒绝计算。
   **聚合出周线 ≠ 复权可得** —— 测试里专门钉了这一对（注入：顺手置 `fqSupported=true` 或取消 `positionRefusal` ⇒ 必败）。
5. 顺手修了一条**测试自身的脆性缺陷**：`fix3Highmed.test.ts` 的 H1 白名单原本按**行号**（`em.ts:89`）登记，
   我在顶部加了一行 import 就让"白名单过期"把测试打红（红的是白名单，不是真的绕过熔断）。
   改成按**所在函数名**（`fetchFromHost`）判定 —— 判据强度不变，但不会因为插一行就误报。

---

## 1. 聚合口径（Lead 定的、逐条落地）

| 项 | 规则 | 位置 |
|---|---|---|
| 周期边界 | 自然周（周一起）/ 自然月 / 自然年，**按交易日所属的美东日历日**分组（纯 `Date.UTC` 日历算术，与宿主 `TZ` 无关） | `usAggregate.ts:41` `usBucketOf` |
| 聚合根 `date` | 该周/月/年的**首个交易日**（稳定键 ⇒ 与磁盘缓存"按日期合并"兼容；否则同一根会随周内推进重复堆积） | `usAggregate.ts:67` |
| OHLC | `open`=首根 open、`high`=区间最高、`low`=区间最低、`close`=末根 close | 同上 |
| 量额 | `vol`/`amount` = **求和**；**任一日缺失该字段 ⇒ 该根 null**（不是 0、不是平均） | 同上 |
| `pct` | 相对**上一根聚合收盘**（首根 null） | 同上 |
| 覆盖事实 | 每个聚合根带 `from`/`to`/`sessions`（"这周只有 3 个交易日"可读） | 同上 |
| 口径句 | `由日线聚合（非上游原生周线/月线/年线）（周K）· 美股日线为未复权原始价：拆股/分红未调整 · 检测到 N 处…` | `usAggregate.ts:180` `usAggCaliber` |

宿主接入：`em.ts:2457` `usDailyBars`（日线，TTL 10 分钟）→ `em.ts:2479` `requestKlineFromSinaUs`
（`klt=101` 原样、`102/103/104` 聚合）；`em.ts:2637` 把 `aggregated` 与 `splits` 挂到回包。

**为什么聚合根的 `date` 用"首个交易日"而不是"最后一个交易日"**：`mergeBars` 按 `date` 合并缓存
（`em.ts` 的 `mergeBars`），若标签随周内推进从周三变成周四，缓存里会出现**两根同周的 bar**。
用周一（或该周第一个交易日）作键是稳定的；月/年同理（该月/该年第一个交易日）。

**年K 的路径与 A股 不同**：A股 年K 是"月K 本地重采样"（`resampleYearly`，`baseKlt` 由 104 收敛成 103）；
美股保留 `klt=104` 直接由**日线**聚合（少一层转手，且能带 `amount`）。

---

## 2. 拆股/合股检测与标注（这条需求的真正风险）

| 项 | 规则 |
|---|---|
| 触发 | 相邻交易日 `|close/prevClose − 1| ≥ 25%`（`US_SPLIT_MIN_MOVE`） |
| 确认 | 比值 `close/prevClose` 落在常见拆合股比附近：`1/20,1/10,1/5,1/4,1/3,1/2,2,3,4,5,10,20`，**相对误差 ≤ 8%**（`US_SPLIT_TOLERANCE`） |
| 结论词 | 只能是**疑似**：拆股当天还叠加正常涨跌，比值不会精确等于 4.0（实测 AAPL `129.04/499.23 = 0.2585`） |
| 展示① | 图上：该根画竖虚线 + 顶部「拆」角标，悬停 `4:1 拆股 · 2020-08-31（未复权原始价：这是拆股/合股造成的价格断层，不是涨跌）` —— `kline.tsx:590` |
| 展示② | 口径行：`检测到 N 处疑似拆股/合股（未复权，价差不可比）` + `已标注 N 处` —— `QuoteDrawer.tsx:538-545` |
| 落盘 | 标记随 K 线缓存一起存（`KlineEntry.splits`），否则"休市定稿免回源"那一轮拿不到日线，标记会一会儿有一会儿没有 |
| **红线** | **不改价**：`aggregateUsDaily` 只做归并，断层的原始价（`129.04`）原样保留 —— 测试里 `assert.equal(last.close, 129.04)` 且 `notEqual(last.close, 499.23/4)` |

**误报/漏报边界**（写在这里，避免读者以为它是判决）：普通暴跌/暴涨（例如 -30% 至 0.7）**不会**被标
（比值不匹配任何常见拆合股比）；而"恰好 -50% 的真实暴跌"会被标成"疑似 1:2 拆股"—— 这正是"疑似"二字的原因。
本轮**不做**交易日志/公告核对（没有该上游）。

---

## 3. 解禁 / 反转清单（上一批 → 本批）

| # | 上一批（AUDIT-IMPL68） | 本批（AUDIT-IMPL69） | 位置 |
|---|---|---|---|
| 1 | `tabUnavailableReason(secid, tab)` 对美股周/月/年返回原因 | **函数删除**（判据不存在了） | `client/chartCache.ts` |
| 2 | 周期按钮 `disabled` + `aria-disabled` + title 原因 | 回到普通按钮（可点、可切） | `client/QuoteDrawer.tsx:625-635` |
| 3 | `.tw-tab[aria-disabled=true]` 禁用态样式 | **删除** | `client/styles.ts` |
| 4 | 切到禁用档时自动归位到日K 的 `useEffect` | **删除**（不再有禁用档） | `client/QuoteDrawer.tsx` |
| 5 | 宿主 `fetchKline`：美股 `klt≠101` 直接 `null` | 允许 102/103/104（由日线聚合） | `em.ts:2414` 起 |
| 6 | `klineMissingReason`：美股非日K 返回 `no-source`「本插件不提供」 | **删除该分支**（三档都提供） | `em.ts:klineMissingReason` |
| 7 | 断言：`blocked === ['week','month','year']`、`fetchKline(102)===null`、源码含 `disabled: off`/`aria-disabled` | **反转**为：三档都出数、`aggregated.note` 含「由日线聚合」「未复权」、源码**不含**上述三个字符串 | `host/usChart.test.ts` ③ |

**保持不动**（本轮明确不许顺手放开）：

| 项 | 现状 | 判据 |
|---|---|---|
| 复权 | `fqSupported(美股)=false`，`normalizeFq(…,1) → 0` | `usChart.test.ts` ④ + ③ 里新增 `k.fqSupported === false` |
| 筹码 | 不提供（`fqSupported=false` 直接拦） | 同上 |
| 位置 | `positionRefusal(美股) !== null`，工具返回 `why` 不计算 | `usChart.test.ts` ④ |

---

## 4. 断言 / 反例注入

### 4.1 `src/host/usAggregate.test.ts`（6 例，纯函数）

| # | 断言 | 必败注入 |
|---|---|---|
| ① | 周K 跨周边界成 2 根；`open/close/high/low` 取首/末/极值；`vol/amount` **求和** | high 取末根（105 而非 108）⇒ 红；low 取末根（103 而非 99）⇒ 红；量额取平均（1500/15000）⇒ 红 |
| ①b | 月K/年K 跨月跨年各成一根；**任一日 amount 缺失 ⇒ 该根 null** | 把 null 当 0 相加 ⇒ `notEqual(amount, 0)` 红 |
| ② | 口径句含「由日线聚合」「未复权」；无拆股时写"未检测到"、有则写"检测到 N 处" | 删掉任一短语 ⇒ 红（常量与文案两处都钉） |
| ③ | 4:1 拆股（499.23→129.04）被检出且 `label === '4:1 拆股'`；**普通 -30% 暴跌不许被标**；聚合后 `close` 仍是 129.04 | 不标记 ⇒ 红；偷偷改价（`499.23/4`）⇒ `notEqual` 红；把阈值当成唯一判据 ⇒ 暴跌被误标 ⇒ 红 |
| ④ | 拆股日映射到**所属聚合根**（`date`），旧缓存无 `from/to` 时退化为同日匹配 | 标记丢失 ⇒ 红 |
| ⑤ | 分组键：周三/周四 → 同周一；周日属上一周；跨月/跨年各归各；坏输入原样返回 | 用北京日历日分组 ⇒ 红（本文件只用日历算术，`TZ` 双跑同结果） |

### 4.2 `src/host/usChart.test.ts`（反转后 8 例）

- ③ 三档全出数 + `aggregated.period` 正确 + 口径含两句话 + `fqt=0`/`fqSupported=false`；周K 根数=2（夹具两周）；
  `klineMissingReason(…,102)` **不含**「不提供美股的周K」；客户端源码不含 `tabUnavailableReason`/`disabled: off`/`aria-disabled`；
  `kline.tsx` 含 `splitBars`、抽屉把它传给图。
- ④ 末尾新增：取到周K 之后 `fqSupported` 仍为 `false`、`positionRefusal` 仍非空 —— **注入：改成 true / null ⇒ 必败**。
- ① 日K 5 根、`unitNote` 含「股」；② 分时 388 点、美东标签；⑤ 美东时区换算；⑦ 端到端新浪兜底 —— 全部保持上一批的断言（不回归）。

### 4.3 时区

分组键与拆股判定全部走**日历算术 + 美东日期字符串**（`usBucketOf` / Sina 的 `d`），不经过 `Date` 的本地时区；
`npm test` 的两轮（默认时区 + `TZ=UTC`）输出一致。

---

## 5. 实网复核（`/tmp/usw/live`，DSH_HOME 隔离）

```text
106.FRO 日K: 末 {"date":"2026-10-16","close":52.49,"pct":-0.1,"amount":197036000}
106.FRO 周K: 4 根，末 {"date":"2026-10-12","open":58.28,"high":59.75,"low":52.23,"close":52.49,
                      "vol":26074341,"amount":1460446000,"from":"2026-10-12","to":"2026-10-16","sessions":5}
        口径: 由日线聚合（非上游原生周线/月线/年线）（周K）· 美股日线为未复权原始价：拆股/分红未调整 · 检测到 1 处疑似拆股/合股
106.FRO 月K: 末 {"date":"2026-10-01","close":52.49,"sessions":12}
106.FRO 年K: 末 {"date":"2026-01-02","close":52.49,"pct":140.56,"sessions":199}
105.AAPL 周K: 4 根；拆股标记 5 处：
  [1987-06-16 2:1 拆股, 2000-09-29 2:1 拆股, 2001-01-02 2:1 拆股, 2007-03-19 1:3 合股, 2020-08-31 4:1 拆股]
```

**缓存往返**（`persist.mts`）：第一次抓周K → `splits=5`；第二次（命中磁盘缓存、`cached=true`、**零回源**）→
`splits=5` 且日期完全一致 ⇒ 标记确实落盘、定稿路径不会丢。

---

## 6. 验证

```text
npm test        → tests 775 / pass 775 / fail 0   （默认时区）
                → tests 775 / pass 775 / fail 0   （TZ=UTC）
npm run selftest → ALL HOST CHECKS PASSED (live probes soft)
npm run build    → built lib/index.js + lib/client.js（客户端片段校验通过：73 项）
npm run check    → EXIT=0 × 2 轮（A/B），两轮读数完全一致
```

- 基线 759 → **775**（我 +6：`usAggregate.test.ts`；并行的 `fix-degrade` 另 +10：`degrade.test.ts`）。
- 本报告的数字取自**工作树**（`main` @ `5ee0532` = v0.103.0 + 未提交改动）；
  同一棵树上还有 `fix-degrade` 的改动（`degrade.ts`/`degrade.test.ts`/`breakerFetch.ts`/`rescue.ts`/`routes.ts` 等），
  他确认**没有**改 `model.ts` / `usAggregate.ts` / `client/**` / `build.mjs`，并保留了我在 `loadKlineCache` 加的 `splits` 三处。
  我这轮**没有**改 `build.mjs`（本轮客户端文案没有命中锁定片段）。
- 两轮之间我没有再写 `src/**`（写文档不算）；两轮的 `tests/pass/fail` 与构建输出逐字段相同。

---

## 7. 未做 / 未确认 / 风险

| 项 | 状态 | 说明 |
|---|---|---|
| 拆股"判决" | 只做**疑似** | 没有公告/交易日志上游；比值容差 8% 是经验值（AAPL 实测误差 3.4%、FRO 3.6%） |
| 拆股对**指标**的影响 | 不处理 | MA/MACD 跨拆股仍会跳变（这是未复权数据的必然结果）；图上已标注，口径行已说明"价差不可比" |
| 周/月/年的**成交量口径** | 股 | 与日K一致（美股为股、A股为手），口径行已有"成交量单位：股" |
| 聚合档的 `barOpen` | 按周期判断 | 聚合根 `date` 是周期首个交易日 ⇒ 用"所属周期是否等于今天所在周期"判断当根未收盘（否则周K 在周三会显示"当根已收盘"） |
| 半日市/停牌周 | 不特殊处理 | `sessions` 字段如实给出覆盖了几个交易日，不做补齐 |
| 与新上游的关系 | 无新增主机 | 全部复用 `stock.finance.sina.com.cn` |
| 版本号 / CHANGELOG / commit | 未做 | 按 `docs/DECISIONS.md`「发版是原子动作」归 Lead |
