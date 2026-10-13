# REVIEW-2-CORRECTNESS —— 正确性与断言强度审计

**审计对象**：`/home/hu/workspace/Servers/dsh/Dev/dsh-tradewatcher`，`main` @ `6f4382e`（v0.74.0）。
**只读声明**：未改工作区任何源码、未 commit、未装 bundle、未动 profile、**未重启 `dsh web`**、**未在工作区跑 `npm run build`**。本文件是本次审计唯一的写入面（`docs/REVIEW-2-CORRECTNESS.md`）。
**审计姿态**：目标是**推翻"它是对的"**——优先找能产出**"看着正常的错数"**或**"一切都是好的"假状态**的地方；找不到就如实记「查过、无发现」（附录 A），不凑数、不编造。

**取证环境**（全部在工作区之外）：
| 副本 | 用途 | 说明 |
|---|---|---|
| `/tmp/r2-inj` | **反向注入**（5 组，做完已逐字节还原并核验） | `tar` 复制 + `node_modules` 只读软链，`DSH_HOME=/tmp/r2-home-inj` |
| `/tmp/r2-audit` | 会计/数据层并行取证（探针脚本 `work/t*.ts`、`zz-audit-*.test.ts`） | `DSH_HOME=/tmp/r2-home-r2a` 等 |
| `/tmp/r2-tz` | 时区取证（`tz-probe3.ts` / `tz-final.ts` / `tz-probe4.ts`） | `DSH_HOME=/tmp/r2-home-tz` |
| `/tmp/r2-work` | 断言抽取器、行归属推导器、探针脚本 | 纯分析产物 |

**基线复现**（不是照抄仓库说法，而是自己在干净副本里跑的；副本按要求已丢弃，命令在任意干净副本上可逐字复现）：
```
$ cd <clean-copy> && DSH_HOME=/tmp/r2-home-inj TZ=Asia/Shanghai node --test --experimental-strip-types "src/**/*.test.ts"
ℹ tests 532 / pass 532 / fail 0
$ cd <clean-copy> && DSH_HOME=/tmp/r2-home-inj TZ=UTC          node --test --experimental-strip-types "src/**/*.test.ts"
ℹ tests 532 / pass 532 / fail 0
```
⇒ **532 × 2 时区全绿属实**。**但这 532 条一条都没锁住下面第一、二节任何一条**（见 §6 的反向注入与 §5 的假断言清单）——"全绿"与"正确"在这里是两件事。

---

## 结论先行

| # | 结论 | 数量 | 严重度 |
|---|---|---|---|
| 1 | **"读不到"被当成"没有"**：账本 / 日历事件 / 90 天快照——**下一次写入把用户数据整份覆盖**（我复现：账本 3 条 → 1 条） | 3 处同族 | **红线** |
| 2 | **上游失败写进"成功"缓存**：K 线失败包进 1 小时正缓存 ⇒ 一小时不回源，且 missing 理由说"重试无效" | 1（+2 同型） | **红线** |
| 3 | **缺价流水当 0 价**：做T 用 `price ?? 0` 编造毛/净盈亏，页面与工具照常显示"净 +1,200.00 · 胜率 100%" | 2 行代码 | **红线** |
| 4 | **市场时钟按宿主/浏览器时区解析**：UTC 宿主下护盘采样回填环整体偏 8 小时、腾讯分时兜底刻度变 17:30–23:00 | 2 处（宿主） | **红线** |
| 5 | **"数据时刻"族按浏览器时区**：侧栏徽标、行情卡 title、K 线脚注显示的"数据时刻"可以是任意时区的时间（**测试把缺陷当契约锁死**） | 5 处 | **红线** |
| 6 | **已清仓且成本未知 ⇒ 合计按 0 计**，而两处披露都被 `qty > 0` 门控 ⇒ 工具输出一个**自信的 0.00** | 3 处 gate | **红线** |
| 7 | **币种混算**：组合构成把 HKD/USD/CNY 按 1:1 相加（与仓库自己的 P1-11 口径直接冲突） | 1 | **红线**（暴露面有限） |
| 8 | **熔断器整体被绕过**：日历/新浪/腾讯/护盘原语全是不记账的裸 `fetch(`；K 线**首选**源腾讯挂起时每次 `/kline` 付满 9s | 14 个站点 | 高 |
| 9 | 同进程"可重入"判据把**并发兄弟**当嵌套 ⇒ 读-改-写丢更新（实测 `n=1` 期望 2） | 1 | 高 |
| 10 | 已跳过流水仍计入**当日盈亏**；日历降级状态只在内存 ⇒ 重启/空包后谎报"一切正常" | 2 | 高 |
| 11 | **假断言 4 类 6 条**：`\|\| true` 恒真 ×2、循环不变量 OR 恒真 ×2、自比较恒真 ×2（3096 条 assert 全量扫描） | 6 | 中 |
| 12 | **行归属测试不看调用方**（反向注入证明：往 core 加 market 行路由的消费者，532 条依旧全绿） | 1 | 中 |
| 13 | 行情槽 TTL(12s) < 护盘采样间隔(30s/15s) ⇒ 采样器缓存命中率 0%；休市"定稿"复用被判 stale + 假限流告警 | 2 | 中 |
| 14 | 「日线本次未取到」被报成「窗口内样本不足（0 根 < 2）」——把**本次失败**说成**结构性无源**，改变 agent 的下一步动作 | 2 处 | 中 |
| 15 | 其余中/低项（TTL 死代码、假 TTL 断言、无 stale 字段、Promise.all 丢整批、归档被短份覆盖、breadthCount 上界无校验…） | 见 §3/§4 | 中/低 |

**最该先修的 5 条**（按"会造成不可逆损害 / 会让人做错决定"排序）：
1. **R1 三处覆盖**（`store.ts:442-450`、`calendar.ts:349-352`、`globalFlow.ts:619-621`）——唯一会**永久丢用户数据**的一类，且用户看不到任何异常。
2. **R3 做T 的 `price ?? 0`**（`dayTrade.ts:93/106`）——最容易改（对照 `routes.ts:987` 已有的正确写法：先 `typeof e.price === 'number'` 再算），却直接把"编造的盈亏"端到用户面前。
3. **R4 宿主市场时钟解析**（`rescue.ts:837`、`tencent.ts:401`）——UTC 容器/云主机是默认部署形态，命中的是**护盘**这条招牌链路。
4. **R6 已清仓成本未知**（`tools.ts:233/305-307` + `model.ts:1136`）——三处 gate 任一处放宽即可，成本极低。
5. **R5 客户端"数据时刻"族** + 把 `badgeView.test.ts:69` 这条"用同一个 TZ 相关函数推导期望值"的断言改成**固定字面量**（否则改对了也会被测试挡住）。

---

## 一、红线：把缺失伪装成数值 / 看着正常的错数

### R1【红线】"读不到"被当成"没有" ⇒ 下一次写入覆盖用户唯一的数据

- **项**：`store.ts` 读盘失败 → 空账本；`calendar.ts` 读盘失败 → 空库；`globalFlow.ts` 读盘失败 → 空快照。三处都把 **EACCES/EIO/半截文件** 与 **ENOENT（首次）** 等同，而三者的写回都是**整份覆写**。
- **证据（我本人复现 ✅）**：`store.ts:442-450`
  ```ts
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, entries: [] }
    log('ledger read failed:', String(error))
    return { v: 1, entries: [] }          // ← 其它错误也当空账本
  }
  ```
  ```
  $ DSH_HOME=/tmp/r2-home-r1 node --experimental-strip-types /tmp/r2-work/r1-ledger-overwrite.ts
  ① 写入后磁盘账本条数 = 3
  [tradewatcher] ledger read failed: Error: EACCES: permission denied, open '.../ledger.json'
  ② 新实例读到的账本条数 = 0
  ③ 这次写入 = 成功（无异常抛出）
  ④ 写入后磁盘账本条数 = 1      ← 前两条（建组 + 100 股买入）永久消失
  ```
  注意：**JSON 解析失败/形状非法是隔离（quarantine）的，读失败不是**——同一个函数里两种错误两种命运（`store.ts:436-467` 的隔离分支只覆盖"读到了但内容坏"）。同类写法还有 `store.ts:398-410`（watch/positions/prefs）。
- **证据（并行取证 ◐，脚本 `/tmp/r2-audit/zz-audit-x.test.ts`、`zz-audit-x3.test.ts`）**：
  - `calendar.ts:349-352` `} catch { /* 首次：空库 */ }` ⇒ `[X3] 写回后盘上事件 = 新加的事件`（原有"用户手记：分红到账"消失，chmod 000 模拟 EACCES）。
  - `globalFlow.ts:619-621` `catch { purgedFromOldScope = []; return { v:2, scope, days: {} } }` + `:635-637` 重建整份 ⇒ `[X4c] 正常读到的 days = 2026-10-01,2026-10-02 / 落盘后盘上的 days = 2026-10-12`（90 天历史被写没）。
  - 对照：`lock.ts:440-454` 明确"拒绝在锁内改写它（避免把用户数据静默覆盖成空）"——**规矩在别处已经立了**。
- **严重度**：**红线**（不可逆数据丢失 + 静默成功）。
- **建议动作**：只有 `ENOENT` 当空；其它 `errno` **抛出**（或进 `quarantine`）并把原因写进 `syncStatus().missing` / `payload.missing`；"本次没成功读到盘"时**禁止** `persist()`/`commit()`。三处同一个判据、同一份实现。

### R2【红线】K 线把"上游失败"写进成功用的 TTL 缓存 ⇒ 一小时不回源，并把"没发请求"说成"重试无效"

- **项**：`em.ts:2288` `ttlCache<DayBar[] | null>(key, needFull ? 3600_000 : 120_000, () => requestKlineRaw(...))`——`requestKlineRaw` 在"所有主机 200+空 klines"或"全 5xx/超时"时 `return null`（`em.ts:2089`，**不抛**），而 `ttlCache` 只在 `loader()` **抛错**时不写缓存。只有 `UpstreamCoolingError` 被豁免（`em.ts:2291-2296`）。
- **证据（并行取证 ◐，`/tmp/r2-audit/zz-audit-kline.test.ts`）**：
  ```
  [A] first result = null
  [A] upstream calls: 1st= 7  2nd= 0        ← 第二次连一次上游请求都没发
  ```
  叠加效应（同文件读码）：120s 窗口过后 `klineMissingReason`（`em.ts:2235-2261`）判成 `no-source`「腾讯与东财当前都可达但没有返回 —— 重试无效」——**这句话建立在"最近一小时我们根本没发过请求"之上**，把 agent 引向"别重试了"。
- **严重度**：**红线**（陈旧源 + 误导性结论；失败被伪装成"上游没有数据"）。
- **建议动作**：失败不写缓存；`null` 若要缓存必须用独立短 TTL（≤10s）；`missing.why` 依据"本轮是否真的发过请求"而不是时间窗口。同型请一并检查 `globalFlow.ts:703-711`（"成功但空"的日线进 12h 正缓存，见 M8）。

### R3【红线】做T：缺价流水被当成 0 价 ⇒ 编造盈亏

- **项**：`src/host/dayTrade.ts:63` 只校验 `qty`；`:93`/`:106` 用 `e.price ?? 0` 参与 `grossPnl = (sellPrice - buyPrice) * qty`（`dayTrade.ts:141`）。而 `LedgerEntry.price` 本来就是**可选**的（`model.ts:585`），`DayTradeRound.buyPrice/sellPrice` 是 `number`，`DayTradeUnmatched.price` 却诚实地写成 `number | null`（`dayTrade.ts:37`）——**同文件里两种态度**。
- **证据（我本人复现 ✅）**：
  ```
  $ DSH_HOME=/tmp/r2-home-inj node --experimental-strip-types /tmp/r2-work/daytrade-probe.ts
  rounds= [{ "direction":"buy-first","qty":1000,"buyPrice":10,"sellPrice":0,
             "grossPnl":-10000,"feeShare":11,"netPnl":-10011 }]
  summary= {"count":1,"winRate":0,"netPnl":-10011,"avgNet":-10011,"days":1}
  ```
  （一条"买入 1000@10" + 一条"卖出 1000（无价）"的账本 ⇒ 工具/页面显示"净 −10,011.00、胜率 0%"。）
- **归属**：`routes.ts:959` `dayTrades: dayTradesOf(store.ledgerEntries())` → `GET /tradewatcher/portfolio` → `PortfolioPage.tsx`（"做T 1 次 · 净 +1,200.00 · 胜率 100%"）；`tools.ts:304/329` → `tradewatcher_portfolio` 工具回包。
- **对照（仓库已经知道正确写法）**：`routes.ts:987-989` 的 `/tradewatcher/trades` 先 `typeof e.price === 'number' && typeof e.qty === 'number'` 再算；`store.ts:292-295` 的 `replayPositionWithSkips` 遇到缺价流水会**记进 `skipped` 并给原因**。`dayTradesOf` 两者都没做。
- **严重度**：**红线**（0 顶替 → 用户可见的错数）。
- **建议动作**：`isTrade` 增加 `typeof e.price === 'number'`；缺价的配对进 `unmatched`（那里已有 `price: number | null` 的正确形状）；`summary` 里若仍有未计价配对，`netPnl` 必须为 `null` 或带明确标记。

### R4【红线】宿主侧：上游"市场时钟"字符串按**宿主机时区**解析 ⇒ UTC 宿主偏 8 小时

- **项**：`src/host/rescue.ts:837` `parseMinuteStamp` 与 `src/host/tencent.ts:401` 都用无偏移的 `Date.parse(`${day}T${hhmm}:00`)`——**"YYYY-MM-DD HH:mm" 是北京市场时钟，不是宿主本地时间**。
- **证据（并行取证 ◐，`TZ=UTC node --experimental-strip-types tz-probe3.ts`，stub 掉 `globalThis.fetch` 跑真模块）**：
  ```
  上游原始行（东财 trends2 首行）: 2026-10-12 09:31,4.500,...
  腾讯 fetchTencentMinutes: ts=1791797400000 iso=2026-10-12T09:30:00.000Z 按北京时间读=2026-10-12 17:30
  东财 fetchMinuteSeriesAny(330 点): ts=1791797460000 iso=2026-10-12T09:31:00.000Z 按北京时间读=2026-10-12 17:31
  sessionAxis（腾讯兜底 label）: clampedBefore=0 clampedAfter=12 daySlots=1
  inTradingWindow(每个回填点 ts) 命中 0/330
  ```
  同命令 `TZ=Asia/Shanghai`：label `09:30/15:00`、`clampedAfter=0`、`inTradingWindow 251/330`。
- **为什么是红线**：①`em.ts:1320` 用这些 ts 生成分时 label ⇒ 腾讯兜底分时图的刻度变成 17:30–23:00，全部被夹到收盘右界；②`rescue.ts:1558-1564` 的 `bootstrapOne` 用 `p.ts > newest` 回填采样环 ⇒ 北京盘中整批"未来"点进入采样环，`hhmmOf(ref.ts)` / `sessionElapsed` / `inTradingWindow` 全部失准——正是 `rescue.ts:546-547` 自己写下的失效模式。宿主 `TZ=UTC`（Docker/云主机/CI 默认）在北京 2026-10-12（周一）09:31 就会命中。
- **严重度**：**红线**（数据被错误标记为"未来" → 派生结论失真，且外观正常）。
- **建议动作**：上游时钟字符串统一走 `host/time.ts` 的北京解析（`+08:00` 显式偏移，或复用现成的 `dayOf/hhmmOf` 反向函数）；给这两处补一条 **`TZ=UTC` 下也成立**的断言（现有 532 条一条都没覆盖，见 §5）。

### R5【红线】浏览器侧："数据时刻"族按浏览器时区（且测试把缺陷锁成契约）

- **项（每处都缺 `timeZone: 'Asia/Shanghai'`）**：
  | 位置 | 形态 | 显示面 |
  |---|---|---|
  | `src/client/badgeView.ts:54` | `toLocaleTimeString('zh-CN',{hour12:false})` | **侧栏标签**「盯盘 · 数据 HH:mm:ss」 |
  | `src/client/quoteState.ts:64` | 同上 | 行情卡「数据时刻」title |
  | `src/client/chartNote.ts:44` + `src/client/format.ts:86`、`:105` | `getHours()/getMonth()/getDate()` | K 线脚注「上次成功数据（10-08 06:55）」 |
  | `src/client/CalendarPage.tsx:44`（+`:46-47`、`:122`、`:185-187`、`:245`） | `iso(new Date())` 本地日 | 日历"今天"高亮 / 「即将发生」 |
- **证据（我本人复现 ✅，两 TZ 跑同一表达式）**：
  ```
  $ for T in UTC Asia/Shanghai; do TZ=$T node -e "const at=1791769372000;console.log('$T ->','盯盘 · 数据 '+new Date(at).toLocaleTimeString('zh-CN',{hour12:false}))"; done
  UTC -> 盯盘 · 数据 01:42:52
  Asia/Shanghai -> 盯盘 · 数据 09:42:52
  ```
  （同一 epoch＝北京 09:42:52；`America/New_York` 给 `21:42:52`、`Australia/Sydney` 给 `12:42:52` ◐。）
- **测试把缺陷当契约（关键）**：`src/client/badgeView.test.ts:69`
  ```ts
  const hhmmss = new Date(Date.parse('2026-10-12T09:42:52+08:00')).toLocaleTimeString('zh-CN', { hour12: false })
  assert.equal(text, `盯盘 · 数据 ${hhmmss}`, ...)      // 期望值由同一个 TZ 相关函数推导 ⇒ 任何时区都过
  assert.match(text, /^盯盘 · 数据 \d{2}:\d{2}:\d{2}$/)  // 形状断言，恒真
  ```
  `chartNote.test.ts:56` 同样是"用本地构造器造输入 + 只断言形状"。
- **严重度**：**红线**（用户可见的错数；且"已修好的同类"就在隔壁——`watchlistView.ts:12-16` 写死了 `timeZone`；README:205-207 / `docs/DECISIONS.md:382-383` 明文禁止）。
- **建议动作**：这 5 处加 `timeZone: 'Asia/Shanghai'`（或统一走 `marketTime.ts` 的已钉函数）；把 `badgeView.test.ts:69` 的期望值改成**固定字面量** `'盯盘 · 数据 09:42:52'`，否则修了也会被测试挡住。

### R6【红线】已清仓且成本未知 ⇒ 合计按 0 计，两处披露都被 `qty > 0` 门控

- **项**（三处 gate 叠加，任一处成立就不会漏）：
  1. `tools.ts:233` `view.positions.filter((p) => p.qty > 0 && p.costUnknown === true)`；
  2. `model.ts:1136` `realizedUnknownRows` 要求 `realizedUnknownQty > 0 && costUnknown !== true`；
  3. `tools.ts:305-307` `if (args.includeEmpty !== true) view.positions = view.positions.filter((p) => p.qty > 0)`。
- **证据（我本人读码确认三处 gate ✅；数值复现 ◐ `/tmp/r2-audit/work/t6*.ts` 真跑 `makeAgentTools` 的 `render`）**：
  ```
  A) adjust 100@0 → sell 100@12.5（成本从未录入）：`【持仓总览】… | 累计已实现: 0.00` + `暂无持仓。` —— 无任何标记
  B) 变体 + 另一个已清仓、realized=200 的持仓：`累计已实现: +200.00`（未知那只被静默当 0 并入）
  C) adjust 100@0 → sell 100@12.5 → adjust 0@9.5：工具仍打 `0.00`（面板会显示 badge，工具的前置过滤把它杀了）
  ```
  这同时**证伪**了 `model.ts:1044-1050` 的自述：「两个提示合起来恰好覆盖所有 `realized === null` 的行」。
- **严重度**：**红线**（"看着正常的错数"：`0.00` 会被读成"确实没赚没亏"）。
- **建议动作**：披露集合改用**未过滤**的 `view.positions` 计算；或"存在任何 `costUnknown`/`realizedUnknownQty>0` 的行时，`累计已实现` 一律 `null` + 原因"。三处 gate 收敛到 `shared/model.ts` 的一个函数。

### R7【红线】组合构成把 HKD/USD/CNY 按 1:1 相加

- **项**：`composition.ts:97-101` `totalMv = priced.reduce((n, it) => n + it.qty * price)`、`weightPctOf(mv, totalMv)`；喂给它的输入在 `portfolio.ts:355-369` **不做市场/币种过滤**（`price: p.price` 直接用）。
- **证据（我本人复现 ✅）**：
  ```
  $ DSH_HOME=/tmp/r2-home-inj node --experimental-strip-types /tmp/r2-work/r6-composition.ts
  totalMv = 69300   ← 100×11(CNY) + 200×320(HKD) + 10×420(USD) 直接相加
  markets = [{"key":"港股","weightPct":92.352…},{"key":"美股","weightPct":6.06…},{"key":"A股","weightPct":1.587…}]
  top1 weightPct = 92.352…  hhi = 0.8568
  ```
- **暴露面（诚实标注）**：`grep -rn "composition\|weightPct\|hhi" src/client`（非测试）→ **0 命中**，即客户端今天不渲染它；但它是 `GET /tradewatcher/portfolio` 与 `tradewatcher_portfolio` 工具回包里的**对外字段**（`portfolio.ts:354` 注释自称 P0-11）。
- **矛盾点**：`portfolio.ts:288-295` 写得很清楚——"按 1:1 加进去会让总额看起来完整、其实错了——错的口径比缺的口径更危险"。总额守住了，**组合构成没守住**。
- **严重度**：**红线**（币种混算；当前暴露面受限）。
- **建议动作**：`composition` 的输入与 `grand` 用**同一份**"能折算才计入"的集合（或对不可折算项只列 `null` 权重并说明分母）。

---

## 二、高

### H1【高】熔断器被整体绕过：日历 / 新浪 / 腾讯 / K 线首选源

- **项**：`grep -rn "await fetch(" src/host` → `em.ts:1397/1419/1962`、`sina.ts:145/219/460`、`tencent.ts:108/202/236/283/382`、`calendar.ts:111/256`、`rescue.ts:744/772`。这四个文件的 `breakerFor|hostsAllowed|fetchAny` 命中数：
  ```
  $ for f in src/host/sina.ts src/host/tencent.ts src/host/calendar.ts src/host/globalFlow.ts; do echo -n "$f: "; grep -c "breakerFor\|hostsAllowed" $f; done
  src/host/sina.ts: 0
  src/host/tencent.ts: 0
  src/host/calendar.ts: 0
  src/host/globalFlow.ts: 0
  ```
- **最贵的一条（并行取证 ◐，`zz-audit-tencent.test.ts`）**：K 线的**首选**是腾讯（`em.ts:2045` → `em.ts:1962` `fetchFromHost('web.ifzq.gtimg.cn', ...)`），它既不 `allow()` 也不 `recordFailure`：
  ```
  [G] 腾讯尝试次数 = 5 ；breakerFor("web.ifzq.gtimg.cn") = {"open":false,...,"fails":0,"trips":0}
  [H] 第一次 fetchKline 耗时 = 9003 ms；第二次 = 9000 ms；腾讯尝试 = 2
  对照：push2his = {"open":true,...,"trips":1}
  ```
  ⇒ 单台挂起时**每次 `/kline`（连带筹码/异动/持仓成本链路）付满 9s**，且 `breakerSummary()`（`routes.ts:1063-1068` 的降级横幅）看不见它。`em.ts:2016-2018` 自己写着"这类缺陷已经修过"——**只修了东财侧**。
- **严重度**：**高**（可用性 + 降级不可观测；非错数）。
- **建议动作**：把腾讯/新浪/日历主机纳入 per-host 熔断（复用 `fetchAny` 记账包装）；至少给 `web.ifzq.gtimg.cn`、`hq.sinajs.cn`、`DC_HOST` 建档。

### H2【高】同进程"可重入"判据把并发兄弟当嵌套 ⇒ 读-改-写丢更新

- **项**：`lock.ts:392-402` `const mine = held.get(lockPath); if (mine !== undefined) { mine.depth += 1; return await fn() }`——`held` 是模块级 Map，**无法区分"同一临界区的嵌套"与"同进程另一个并发任务"**；队列只在 `held` 为空时生效。受害面：`store.ts:498-500/547-553`、`rescue.ts:1082`，而 `updateJsonLocked` 正是仓库自称"唯一推荐的合并入口"。
- **证据（并行取证 ◐，`zz-audit-x2.test.ts`）**：
  ```
  [X5] A 仍持锁时 seq = A:enter B:enter / 最终 seq = A:enter B:enter A:exit B:exit
  [X6] final n = 1 (两次 +1 期望 2)
  ```
  （对照：两个调用者"同时"发起时是串行的 `A:enter A:exit B:enter B:exit`——只有"锁已被持有时才发起第二个"才破。）
- **严重度**：**高**（丢更新；R1 的孪生兄弟，但触发条件更窄）。
- **建议动作**：用 `AsyncLocalStorage` 按 async context 判重入。**不能**改成无条件排队——`store.ts:547` 的 `commit` 依赖可重入，会自锁超时。

### H3【高】已跳过流水仍计入"当日盈亏"

- **项**：`portfolio.ts:71-75` 用原始 `slice.dayTrades` 造 `dayPnl`，`:91-94` 直接累加；而 `:105` 的 `qty/realized` 来自**实际应用过**的流水集合。
- **证据（并行取证 ◐，`/tmp/r2-audit/work/t7.ts`）**：
  ```
  {"qty":0,"realized":0,"dayPnl":-50,"skippedLedger":1,…,"skippedNotes":["[s1] 卖出数量超过持仓（持有 0）"]}
  ```
  ⇒ 空仓却报"当日盈亏 −50"。可达路径：批量录入的**撤销**删掉了覆盖该卖出的买入，手工录的卖出留下且 `ts` 是今天（同一笔改成昨天 ⇒ dayPnl 0）。
- **严重度**：**高**（同一行里 `qty=0` 与 `dayPnl=-50` 自相矛盾）。
- **建议动作**：replay 时收集 `appliedIds`，`dayPnl` 只累加命中的流水。

### H4【高】日历降级只在内存 + "成功但空"记 `ok` ⇒ 重启后谎报"一切正常"

- **项**：`calendar.ts:321-324`（`lastSources`/`lastThrown` 只在内存）、`:346-348`（`init` 只恢复 `syncedAt`/`syncAttemptAt`）、`:427`（`stale = syncedAt<=0 || failed.length>0 || lastThrown!==null`）、`:606-609`（任一源 ok 就推进 `syncedAt`）；消费方 `tools.ts:729-733`（`asOf: status.syncedAt, stale: status.stale`）、`routes.ts:305`。且 `fetchReport`（`:118` `Array.isArray(rows) ? rows : []`）与 `fetchEconomicCalendar`（`:249-252`、`:274`）在"成功但空"时**不抛** ⇒ 记 `ok, count:0` 并推进数据时刻。
- **证据（并行取证 ◐，`zz-audit-cal.test.ts`）**：
  ```
  [I] 首次（宏观失败）stale= true missing= 1 sources= ["ipo:ok","earnings:ok","dividend:ok","macro:failed"]
  [I] 重启后 syncedAt= …494 stale= false missing= 0 sources= []
  ```
  叠加 `AUTO_SYNC_TTL = 6h`（`calendar.ts:11`）⇒ 部分失败后 6 小时内不会再试，而这期间 UI/agent 读到的是 `stale=false`、`missing=[]`。
- **严重度**：**高**（"一切都是好的"假状态）。
- **建议动作**：`lastSources`/`stale` 落盘；`syncedAt` 只在"所有被尝试的源都成功"时推进；`count===0 的 ok` 单列一档。

### H5【高】宿主机 agent 工具的「数据出处」行按宿主机时区

- **项**：`src/host/tools.ts:68`（同族 `:379`、`:661`、`:853`、`:1341`、`backup.ts:216-217`）：`new Date(p.asOf).toLocaleString('zh-CN', { hour12: false })` 无 `timeZone`。
- **证据（我本人复现 ✅，跑的就是那一行表达式）**：
  ```
  $ for T in UTC Asia/Shanghai; do TZ=$T node -e "console.log('$T ->','数据时刻 '+new Date(1791769372000).toLocaleString('zh-CN',{hour12:false}))"; done
  UTC -> 数据时刻 2026/10/12 01:42:52
  Asia/Shanghai -> 数据时刻 2026/10/12 09:42:52
  ```
  （◐ 用真 `makeAgentTools().output.render()` 复现同结论：`C1 【数据出处】数据时刻 2026/10/12 01:42:52 · 来源 em`。）
- **为什么算高**：这是本插件对 agent 的**招牌 provenance 契约行**，每个工具回包都带；宿主是 UTC 容器时，所有工具汇报的数据时刻错 8 小时（且看起来完全正常）。
- **建议动作**：统一走已钉时区的格式化函数；`docs/DECISIONS.md:382-383` 的禁令把宿主侧也写进去。

### H6【高】财经日历"今天"按浏览器日，与宿主 `calToday()` 不一致

- **项**：`CalendarPage.tsx:44` `const today = iso(new Date())`（同族 `:46-47` 初始年月、`:122` upcoming 过滤、`:185-187`「今天」按钮、`:245` is-today 高亮）；宿主一律北京日（`routes.ts:1088-1089`、`calendar.ts:93`）。
- **证据（并行取证 ◐）**：
  ```
  UTC            client today=2026-10-12 | 10-12 仍列在「即将发生」= true | is-today 落在 10-12 = true
  Asia/Shanghai  client today=2026-10-13 | false | false
  ```
  ⇒ 北京 00:00–08:00 这 8 小时里，高亮格与「即将发生」清单整体错一天（崩盘时刻：北京 2026-10-13 00:30 ＝ UTC 16:30）。
- **严重度**：**高**。
- **建议动作**：客户端"今天"改用宿主返回的 `calToday`（或本地按 `Asia/Shanghai` 计算）。

---

## 三、中

| # | 项 | 证据（path:line + 命令/输出） | 建议动作 |
|---|---|---|---|
| M1 | **假断言：`\|\| true` 恒真** ×2 | `chipsView.test.ts:96` `assert.equal(/\[secid, tab, fqt\|retry\]/.test(drawer) \|\| true, true)`；`splitDrag.test.ts:66` `assert.ok(drawer.includes("cursor") === false \|\| true)` | 删掉 `\|\| true`；若被禁的那条现在真会红，说明**当前源码违反了原判据**（`/\[secid, tab, fqt\|retry\]/` 在 `QuoteDrawer.tsx:163` `}, [secid, retry])` **是命中的**）——按意图二选一：修源码或改判据，别用 `\|\| true` 掩盖 |
| M2 | **假断言：循环不变量 OR** ⇒ 四次迭代恒真 | `chips.price.test.ts:75` `panel.includes(k) \|\| panel.includes('latestBarDate')`（第二项与循环变量 `k` 无关，且源码里恒存在）；`marketRefactor.test.ts:111` 同理（`title: reason` 是另一个组件的通用兜底） | 去掉与循环变量无关的 disjunct；用**反向注入**（§6 INJ-4/INJ-5）证明它非恒真后才留下 |
| M3 | **行归属测试不看调用方**（"按实测调用方"名不副实） | `index.test.ts:333-372` 的 `OWNER_BY_CALLERS` 是硬编码映射，`ROW_ROUTES_FOR_TEST`（`:315-330`）是表副本；反向注入 INJ-3 后 532 条**依旧全绿** | 把"调用方 → 行"做成可执行检查（本报告 §6 的行归属推导器 `/tmp/r2-work/owner-check.mjs` 可直接搬进测试） |
| M4 | 时区测试自证 | `badgeView.test.ts:69`、`chartNote.test.ts:56`（期望值由同一个 TZ 相关函数推导，双 TZ 必过） | 期望值写死字面量；补 `TZ=UTC` 的 CI 组合 |
| M5 | 行情槽 TTL(12s) < 护盘采样间隔(30s/尾盘 15s) ⇒ **采样器命中率 0%** | `em.ts:844-847`（`quoteFreshMs + margin`，margin ≤5s，默认 10s）vs `rescue.ts:1011`（`intervalSec:30, tailIntervalSec:15`）；◐ 实测 `quoteSlotTtlMs() = 12000 ms`、间隔 20s 后第二次请求数 = 1 | 给采样器独立的、与它的 tick 对齐的 TTL；或把共享槽 TTL 下限提到 ≥ max(采样间隔, 客户端间隔) |
| M6 | 休市"定稿"复用被判 `stale` + **假限流告警** | `em.ts:856-858`（`frozenOfflineSlot`）与 `:448-451`（`stale = now-at > 90s`）、`:512`（`cached`）互不相识；◐ `[C] 15:06 calls=1 stale=false cached=true → 15:20 calls=0 stale=true cached=false` | 冻结槽命中时直接给 `settled` 态；`stale` 判据排除"已越过最近收盘"的标的 |
| M7 | 新浪兜底行情**无上游时间戳却标 `at=now`**（与 `int_*` 被退役的理由逐条相同） | `em.ts:712-731` `{ time: null, source:'sina', at: Date.now() }`；`sina.ts:105-117` 只读 `parts[8]/parts[0..7]`，时间位没读；◐ `grep -n "time: null" em.ts` → `:728` | 解析 `nf_/hf_` 的时间字段落进 `row.time`；拿不到时间就必须带来源降级标记，不许当实时 |
| M8 | 「成功但空」的日线进 **12 小时正缓存**并标 `no-source` | `globalFlow.ts:703-711`（`cached('series:…', FLOW_SERIES_TTL_MS, …)`，而 `tencent.ts:200-203` 缺字段时 `return []`、sina 解析无数据时 `return []`，都不抛）；与文件头 `:39`「失败不进缓存」自相矛盾 | `if (points.length < 2) throw`；"上游无此源"与"本次空包"分两档 |
| M9 | global-flow **无 `stale` 字段、`asOf = 请求时刻`** | `grep -c stale src/host/globalFlow.ts` → **0**；`asOf: now`（`:1064` live、`:1213` snapshot）；`aumAsOf` 7 处赋值 0 处读取 | `asOf` 取最旧一项的数据时刻，并加 `stale`（与行情链路同口径） |
| M10 | global-flow **10 分钟载荷 TTL 是死代码**（有效只有 2 分钟）+ 仓库自己的断言只证了 60s | `globalFlow.ts:959`（`missing.length > 0 ? 2min : 10min`）而 `:134/797/834` 使 `missing` 恒 ≥1；`globalFlow.test.ts:703-711` 用 `NOW + 60_000` 且注释写"10 分钟档" | 残缺判据改用"有无取数失败"；断言步长 > 2 分钟 |
| M11 | `poolRun` 用 `Promise.all`：**一只标的失败丢整批行业名** | `em.ts:2548-2557`；◐ `[F] fetchIndustryOverview 结果 = null 抛错 = Error: UND_ERR_SOCKET …上游请求数 = 5`（`/industries`、`/industry` 本可对失败标的单列 null+原因） | worker 内 per-item try/catch（或 `allSettled`），路由按 per-symbol missing 返回 |
| M12 | 其余未钉 `timeZone` 的**面向市场**时刻 | `MarketPage.tsx:20-23`（`hhmmssOf` → `:143/:323/:325`）、`:447`、`:458`；`WatchlistPage.tsx:201`；`PortfolioPage.tsx:336`；`QuoteDrawer.tsx:465,513`；`RescuePanel.tsx:437,467,475,478` | 逐个补 `timeZone`（同类已修的先例：`watchlistView.ts:12-16`） |
| M13 | **用 UTC 日界当市场日** | `QuoteDrawer.tsx:391` `new Date(tr.ts).toISOString().slice(0,10)`（成交流水打点到 K 线）；`kline.tsx:928`（近 N 日 cutoff 与北京交易日比） | 用北京日（`dayOf`）分桶 |
| M14 | `feePerShare` 分子含**被跳过流水**的费用 | `portfolio.ts:262-266` 遍历原始流水、`:273` 除以 replay 后的 qty；◐ `feePerShare = 1（分子含被跳过那条的 90 元；真实 = 0.1）skippedLedger = 1` | 分子只统计 appliedIds |
| M15 | `verifyBundle` 的"账本重放一致"门禁**放行不可重放的账本** | `backup.ts:155`（`adjust` delta=0 ⇒ 对"负持仓"扫描不可见）+`:166-173`（`replayPosition` 自己吞错 ⇒ 那段 try/catch 是死代码）；◐ `verifyBundle.ok = true errors = []` 而 `replay → qty 0 skipped [{"verb":"sell","reason":"卖出数量超过持仓（持有 0）"}]` | 门禁复用 `replayPositionWithSkips` 的 `skipped`，非空即拒 |
| M16 | 「日线本次未取到」被报成「**窗口内样本不足（0 根 < 2）**」——`transient`（稍后重试）被说成 `no-source` 类结构问题 | `tools.ts:1146` 传 `[]` → `position.ts:85-92` 产出该 why；同族 `tools.ts:1011`（group_rank 位置档同形，且**不留 `missing[]`**）；◐ `{"posPct":null,"samples":0,"why":"窗口内样本不足（0 根 < 2），无法给区间位置"}` | 把"没取到"与"取到了但样本不够"分成两档，前者带 `missing[]` 原因 |
| M17 | depth=**0 已清仓且成本未知** 的行在被 `includeEmpty` 滤掉前就被 `qty>0` 门控掉（与 R6 同源，客户端同构） | `PortfolioPage.tsx:201`、`:207`、`:327`（面板侧三处 gate 与宿主同形） | 与 R6 同一处修 |

---

## 四、低（含"查过、无发现"归类）

| # | 项 | 证据 | 建议 |
|---|---|---|---|
| L1 | **自比较恒真** ×2 | `chartCursor.test.ts:232` `assert.deepEqual(klineReadout({bars,i:1,macd:null}), klineReadout({bars,i:1,macd:null}))`；`quoteState.test.ts:80` `assert.equal(fmtPrice(1500.25), fmtPrice(1500.25))`（纯函数 ⇒ 恒真；真正内容由紧随其后的 `notEqual(fmtPrice(1500.25),'¥••••')` 承担） | 删或改成"与遮罩开/关各有固定字面量"的双向断言 |
| L2 | trendArchive 串行化清理判据**恒 false** | `trendArchive.ts:87-93`（先 `writeChains.set(key, next.catch(…))` 再比较 `writeChains.get(key) === next`）；`node -e "const m=new Map();const next=Promise.resolve(1);m.set('k',next.catch(()=>undefined));console.log(m.get('k')===next)"` → `false` | 用 `const tracked = next.catch(…)` 比较 |
| L3 | 同日分时归档可被"点数更少"的一份覆盖 | `trendArchive.ts:183-186` 无条件 `writeFileAtomic`；`:158` 的 serialize 只在进程内；◐ `[X8] 第一次 = 5 点；用更少点再归档后 = 2 点` | 同日做"点数只增不减"的并集合并；跨进程加 `<day>.json.lock` |
| L4 | lock 退出钩子按路径删锁、**不校验 token** | `lock.ts:375-378`（`process.once('exit', …unlinkSync(lock.lockPath)…)`）vs `releaseLock` 的 token 校验 `:341-361` | 钩子内做同样的 token 校验（未确认是否真的误删他人锁，见 §7） |
| L5 | `/detail` 与 `/quotes` 对同一 secid 打**两遍字节相同**的 URL | `em.ts:1001`（`ttlCache('detail:'+secid, 10_000, …)`）vs `:874-941` 的逐标的槽；◐ `[D] quotes 请求数 = 1；然后 detail 又打了 = 1（URL 逐字节相同）` | detail 并进同一槽 |
| L6 | `resampleYearly` 把缺失月成交量当 0 累加 | `em.ts:1924` `cur.vol = (cur.vol ?? 0) + (b.vol ?? 0)`（年 K 的成交量会"看起来正常地"偏小） | 整段无 vol 时给 `null`，别给求和 |
| L7 | 部分卖出后 `feePerShare` = 全部买入费用 ÷ 剩余数量 | `portfolio.ts:273`；◐ 买 200@10（费 20）→ 卖 150 ⇒ 0.40 股均（真实 0.10）。客户端在 `PortfolioPage.tsx:1129` 标注了分母，自描述 | 改口径或保持（已标注） |
| L8 | `调整` 后 `dilutedPnl ≠ floatPnl + realized`，与 `model.ts:761` 的自述冲突 | ◐ 买 100@10 → 卖 50@12 → 调整 50@10 ⇒ dilutedPnl 150 vs floatPnl+realized 250；根因 `store.ts:257` 重设 `netCost` 却保留 `realized` | 二者取一并在文档里写清 |
| L9 | `unpricedMv` 在 `fxMode=fixed` 也输出且是**跨币种求和** | `model.ts:839` 自称"元 / 只在 fxMode=none 时给出"；◐ 实测 `unpricedMv= 4200`(USD)、`68200`(HKD+USD) | 按币种分组或标注 |
| L10 | LKG 兜底的 `prev` 参与 `dayPnl`，且行内不带 `source/at` | `em.ts:482-494`、`:512`；`portfolio.ts:83-96`；◐ 3 天前的行算出"当日盈亏 2000"（只有面板级 provenance 提到降级） | 行级透出 `source/at` |
| L11 | 表单里 `Number(fee) \|\| 0` | `PortfolioPage.tsx:771`（用于"预计投入/回收"预览；`''` → 0 是正常的，非数字输入也静默变 0） | 非数字给校验提示 |
| L12 | 空 `catch` 全量复核 | 自研扫描器 `/tmp/r2-work/catch-scan.mjs`（先剥注释再匹配）：105 个非测试文件、**180 个 catch**，其中**真·空块 40 个**。逐条读上下文后：`em.ts` 的 10 个是"首次没有缓存文件"、`rescue.ts` 8 个是采样失败记账（`noteSampleFailure`）、`index.ts:152/200/253` 是 Proxy/已 dispose，均**良性且原因如实上报**；需要盯的是 **R1/R2 那三处"空库"语义**与 `trendArchive.ts:136` `catch { return 0 }`（目录读不到就按 0 体积裁剪） | 除 R1 外无需动作 |
| L13 | breadthCount **源 B（现网唯一在跑）**"三类之和 == 总数"的等式**空转**（默认 baseline 取 `scanned`），且 `scanned > total` **无上界校验**；发布时仍标 `BREADTH_COUNT_CALIBER`「全量统计」 | `breadthCount.ts:102`（默认 baseline=`scanned`）⇒ `:104` 的等式恒真；`sumEquals` 的选择在 `:91-95` 有**书面理由**（"源 B 扫的就是全市场有效行"），下界已被 `:431`（缺页即失败）与 `:442`（`rawSeen < total` 即失败）守住；◐ 独立复现：两页 20 行 / `total=19` ⇒ `{"up":11,"down":9,"even":0,"total":19,"scanned":20}` + `reason null`，`sanityOfCounts` 默认 `{"ok":true}` | 一行修：`scanned + blank <= total`（有 `total` 时直接要求 `sum === total`）。暴露面有限：客户端只发布 `up/down/even`（`routes.ts:527-534`），`checks` 声明未渲染 |
| L14 | `trendCaliber.dayNumberOf` 对 `MM-DD` 取 **UTC 年** | `src/shared/trendCaliber.ts:53-55` `new Date(now).getUTCFullYear()` ⇒ 北京时间 1/1 00:00–08:00 会把当天快照解析到上一年，输出「数据滞后 365 天」；`lastDay` 为 null 时 `naturalDays:0`（`:75-76`，"未知"给 0）。**当前不可达**：唯一生产调用点 `QuoteDrawer.tsx:487-490` 传的 label 三个生产者都给全日期（`em.ts:1042`、`em.ts:1320`、`time.ts:59`）——属"将来接 MM-DD 源"的埋伏 | 按 `dayOf` 口径取北京年 |
| L15 | `distributionBinsOf` 的 `total` 是**含 blank** 的输入长度 | `src/client/breadthView.ts:148`：`distributionBinsOf([null,null,1,-1])` ⇒ `total=4` 而计入档位的只有 2（`counts=[0,0,0,0,1,0,0,0,0]`） | 当前消费者只用 `labels/counts/blank`（无 `count/total` 消费点），潜在陷阱 |

---

## 五、假断言与断言强度：系统扫描结果

**扫描口径**：自研抽取器 `/tmp/r2-work/extract-asserts.mjs`（括号配平 + 字符串/正则/注释感知，含跨行），对 `src/**/*.{ts,tsx}` 抽出 **`assert.*` 调用 3096 条**（仓库自称 >500，实测口径见下），再按 6 类可疑形状分类（`/tmp/r2-work/classify.mjs`）：

| 类 | 命中 | 结论 |
|---|---|---|
| 两端锚定正则 + 字面量主体 | 0 | 未见恒真 |
| 正则过宽（`/^$/`、`/.*/` 等） | 0 | 分类器把 `assert.throws(fn, /反例上/)` 这类**嵌套断言**误收进桶后才 28 条，逐条看均为真断言 | 
| `assert(x === x)` / 两个参数同一表达式 | **2** | `chartCursor.test.ts:232`、`quoteState.test.ts:80`（恒真，见 L1） |
| `assert.ok(true/1/'…')` | 0 | — |
| `.every()` 空集合真空通过 | 0 | 14 处逐条读上下文：全部有**前置 `length > 0` 断言**或 `.reduce(…,0)===1` 之类的守恒断言陪跑（`index.test.ts:155`、`globalFlow.test.ts:1032`、`chips.test.ts:81`、`calendar.test.ts:56`、`trendArchive.test.ts:101`…）⇒ **无真空通过** |
| **`\|\|` 里含与循环变量无关的恒真 disjunct** | **2** | `chips.price.test.ts:75`、`marketRefactor.test.ts:111`（见 M2） |
| **字面 `\|\| true` 恒真** | **2** | `chipsView.test.ts:96`、`splitDrag.test.ts:66`（见 M1） |
| 历史形态复检（`^0` 锚定 / `/^[+-]?0(\.0+)?\s*%?$/`） | 0 | 全仓 grep `\^0` 仅 4 处：`toolText.ts:41`（注释记录教训）、`toolCardView.ts:59`（**现役校验**：`^\s*0(\.0+)?(px\|em\|rem\|%\|vw\|vh)?$` 判"圆角为 0"——独立验证过它对 `0.5px`/`-0px` 的行为符合意图）、`globalFlow.test.ts:597/1053`（注释记录教训）⇒ **该形态已清理干净** |

**另外两条"强度不足"（不是恒真，但断言不到它自称的东西）**：
- `index.test.ts:333-372`：名字叫「归属按**实测调用方所在行**」，实际断言的是**硬编码映射 vs 硬编码表副本**；INJ-3 证明加一个 core 侧消费者后 532 条全绿（M3）。
- `chips.price.test.ts:74` `api.includes(k)` / `panel.includes(k)`：**源码子串**断言。`priceUsed` 在 `ChipsPanel.tsx:6` 是**注释**里的字样——也就是说"面板能读出该字段"这条可以由注释满足（INJ-4 把四处字段全部改名后该测试仍 5/5 全绿）。

---

## 六、反向注入记录（≥3 条，全部在 `/tmp/r2-inj` 副本内，做完还原并核验）

**还原核验**：
```
$ diff -rq /tmp/r2-verify/src /tmp/r2-inj/src && echo "INJ COPY == PRISTINE (all injections reverted)"
INJ COPY == PRISTINE (all injections reverted)
```

| # | 注入（改坏什么） | 命令 | 观察 | 判定 |
|---|---|---|---|---|
| **INJ-1** | `shared/model.ts:204-207` 把"均价不可信 ⇒ `null`"改成 `: 0`（重演"缺失编码成 0"） | `DSH_HOME=/tmp/r2-home-inj TZ=Asia/Shanghai node --test --experimental-strip-types src/client/trendView.test.ts` | `fail 1` — `A：实机回包归一后不得再有 avg=0…`：`AssertionError: 均价必须是 null，不能再是 0` | ✅ **断言真实** |
| **INJ-2** | `host/calendar.ts:609` 去掉 `if (okCount > 0)` 守卫，失败路径也推进 `syncedAt`（重演"失败改写数据时刻"） | `… node --test src/host/calendar.test.ts` | `fail 2` — `allFailed ⇒ asOf 必须停留在上次成功时刻`；`从未成功过 → asOf 只能是 null`（`+actual 1791818866236 / -expected null`） | ✅ **断言真实** |
| **INJ-3** | 在 **core 行**组件 `client/TopBar.tsx` 追加 `api.board('industry','pct',1)` 消费者（模拟"新加一个 core 调用方"），**不动任何表** | `… node --test --experimental-strip-types "src/**/*.test.ts"` | `tests 532 / pass 532 / fail 0` — **全绿** | ❌ **归属断言抓不到调用方**（M3） |
| **INJ-4** | `client/ChipsPanel.tsx` 里 `priceUsed\|priceSource\|priceScale\|fqt` 全部改名 `ZZZ_FIELD`（面板再也读不出这四个字段），保留 `latestBarDate` | `… node --test src/host/chips.price.test.ts` | `pass 5 / fail 0` — 含 ⑤「面板口径：四字段可读」**全绿** | ❌ **`\|\| panel.includes('latestBarDate')` 恒真**（M2） |
| **INJ-5** | `client/MarketPage.tsx:269` 把 `missRow('上涨家数 / 下跌家数', INTRADAY_REASON)` 改成通用文案（该原因不再挂到任何 title/aria），保留通用兜底 | `… node --test src/client/marketRefactor.test.ts` | `pass 7 / fail 0` — 含「四处原因必须都在」**全绿** | ❌ **循环不变量 OR 恒真**（M2） |

（另有 2 条"代码级即恒真、无需注入"的：`chipsView.test.ts:96` / `splitDrag.test.ts:66` 的 `|| true`——表达式对任意 `X` 都等于 `true`，且前者被禁的形态**当前源码里是命中的**：`QuoteDrawer.tsx:163` `}, [secid, retry])`。）

---

## 七、未确认（附确认方法，不写结论）

| # | 事项 | 确认方法 |
|---|---|---|
| U1 | 东财行情**没有** `price > 0` 守卫（`em.ts:509` `price: num(it.f2)`；腾讯 `tencent.ts:343` 与 `em.ts:636` 有） | 对停牌/未开盘标的记录 `f2`：若上游真给 `0.00`，该行**不会**进 `unpriced`，而是产出 `mv=0` + `floatPnl=−cost`（−100%）+ `dayPnl=−qty×prev` |
| U2 | `store` 层端到端并发丢更新（X7 未复现：两次并发 `addItem` 都落盘） | 在副本里给 `reloadWatch` 加 50ms 延迟重跑 X7 |
| U3 | lock 退出钩子**误删他人锁** | 子进程 A 持锁 → SIGSTOP 越过 `staleMs` → 父进程回收并持锁 → SIGCONT A → A 临界区内 `process.exit(0)` → 看父进程锁文件是否消失 |
| U4 | `.reclaimed-<ISO>` 回收留档无人清理 | `ls <dataHome>/**/*.reclaimed-*` 长期累积 |
| U5 | 新浪 `nf_/hf_` 到底能有多旧（只证了"没解析时间戳 + 标 `at=now`"这个结构） | 盘中 `curl 'https://hq.sinajs.cn/list=nf_RB0,hf_XAU'` 对比 payload 时间字段与当前时刻 |
| U6 | `BulkPaste` 中途失败：前面几行已写入，而「撤销」按钮需要 `written !== null`（`BulkPaste.tsx:87` vs `:90-92`） | 造一个中途失败的批次，看是否只能靠手工删流水 |
| U7 | 归档分组的持仓被排除在 `grand` 之外（`portfolio.ts:334`）却又出现在 `unpriced/positions` | 归档一个分组后看三处口径是否自洽（意图不明） |
| U8 | `marketTime.ts:37` `getUTCDay()` 兜底（Intl 取不到 weekday token 时才命中，实测不可达） | mock `Intl.DateTimeFormat.prototype.formatToParts` 返回空数组 |
| U9 | `chipsView.test.ts:96` 被 `\|\| true` 掩盖的判据**原意**是什么 | `git log -p` 追该行引入的提交；若原意是"抽屉不许依赖图表 retry"，则 `QuoteDrawer.tsx:163` 是**真违反**（Header 信息确实依赖 `retry`，但那可能是合理的——需作者裁决） |
| U10 | breadthCount **C 档**（`down` 用 `total-up-even` 反推、`up` 假定前页满页、空 0 段/整数倍误判失败）"接线即生效" | `breadthCount.ts:520-523` 原文已写「C 档当前未接线…接线前请先给 `deps.sortedPctPage` 传实现，并把 down 改成边界页独立计数」；`routes.ts:520` 只传 `clistPage`、`:569-571` 无 `sortedPctPage` 即跳过 ⇒ **非现网缺陷**；确认法：给 `sortedPctPage` 传实现后重跑 C 档用例 |
| U11 | `missingBrief(missing, 0)` 会输出 `"缺 ，另有 1 天"`（生产只传默认 `max=3`） | 直接调 `missingBrief(rows, 0)` 看文案 |
| U12 | `tones` 的 `window=min(w, n)` 与 `TONE_WINDOWS` 档位读法不一致（客户端不渲染该字段） | 造 `n < w` 的序列，读 `window` 与文档档位定义 |

---

## 附录 A：查过、**无发现**的类别（附命令，避免"没查"与"查了干净"混为一谈）

| 类别 | 命令 / 判据 | 结论 |
|---|---|---|
| `int_*` 族是否真的全停用 | `grep -rn "tradewatcher_intl" src lib locale` → 0；`sina.ts:53` 的 `SINA_SYMBOL` **不含 `100.*`**；`parseSinaHq`（`sina.ts:96-120`）只有 `nf_`/`hf_` 分支；`em.ts:224-240` 还会作废 LKG 里的旧值；`selftest.ts:530` 断言 `parsed.int_nikkei === undefined` | ✅ **已全停用**（注释与代码一致，不是"注释说停了"） |
| 东财 `push2*` 是否仍被依赖 | `em.ts:34` `QUOTE_HOSTS = ['push2delay.eastmoney.com','push2.eastmoney.com']`、`:35` `HISTORY_HOSTS = ['push2his…','push2delay…','push2…']`；`globalFlow.ts:33` 明确绕开 | ✅ **仍是行情/历史主链路**（非死代码；有腾讯/新浪兜底） |
| 半开探针可绕过 / retry-after 永久卡死 | `em.ts:117-125`、`:2020-2039` 两条路径都 `allow()` → `claimProbe()` → `finally releaseProbe()`；`breaker.ts:90` 退避上界 900s | ✅ 无发现 |
| 行情槽"TTL 等于调用间隔⇒零命中"（历史缺陷） | `em.ts:838-847`：TTL = 客户端间隔 + 20% 余量（夹 1–5s），注释记录了原缺陷 | ✅ **已修**（但护盘采样器仍是 0% 命中，见 M5） |
| 失败进"正面缓存"（行情/趋势/K 线以外的路径） | `em.ts:47-63` `ttlCache` 只在 `loader()` 成功时写槽；抛出即不缓存 | ✅ 无发现（**K 线例外见 R2**） |
| 未 await / 未处理 rejection | 20 处 `void …`、`em.ts:317/780/1100/1851/2306`、`rescue.ts:1117/1476`、`trendArchive.ts:86-93` 逐个读：内部均有 try/catch 或 `.catch()`；全套测试运行无 `UnhandledPromiseRejection` | ✅ 无发现 |
| `bottom.ts`（护盘底部通道）的 `?? 0` | `bottom.ts:321` 的 `price ?? … : 0` 被下游 `computePosition` 的 `!(price > 0) ⇒ empty` 与 `positionScore` 的 `num(percentile60)` 双重拦住 | ✅ 不是红线（**不做**虚假上报） |
| `breadthCount.ts:265` 的 `total ?? 0` | `expectedP` 只在 `if (total !== null && …)` 分支内使用（同一行下一行即守卫） | ✅ 死安全 |
| `globalFlow` 的"合计只含有值市场" | `:1030/1225` 求和 + `:1059/1226` `totalNote`，客户端 `globalFlowView.ts:283-285` 把它挂在 delta 上 | ✅ 有标注（不是静默少算） |
| 组合/持仓的 `?? 0` 主路径 | `portfolio.ts:295-306/389-400` 全部由 `fxMv.value === null ⇒ continue` 与 `qty>0` 前置守卫包住；`dayPnl` 有 `!== null` 判断 | ✅ 无发现（**构成除外见 R7**） |
| 门控：core 是否消费功能行的路由 | 自研推导器 `/tmp/r2-work/owner-check.mjs`（按真实 `api.*` 调用点 + import 图定行） | ✅ 无"core 依赖功能行"的破口；唯一偏差是 **`/tradewatcher/backup` 只被 portfolio 行消费却归 core**（不破坏功能，属 §2.2 判据的字面偏差，低） |
| 统计/口径类纯函数 | ◐ 逐条手算复核：`stats.ts`（wilson 夹 `k`、`n ≤ 0` 全 `null`）、`tones.ts`（`percentileOf([])=null`、`meanSd([x])=null`、`zOf(sd=0)=null`、r30 `42.85714285714286`、momentum `-19.736842105263165`）、`trendStitch.ts`（裁剪只列工作日、breaks 去重、空输入不抛）、`breadthView.ts`（9 档边界、缺失成对、空输入 9 个 0）、`portfolioMeta.ts`（`feeShareNote` 未二次 ×100，与 `portfolio.ts:123` 一致） | ✅ 无发现 |
| 账本聚合的过滤一致性 | `ledgerTotal` / `ledgerViews` 过滤条件逐字一致；`sortLedger` 单一口径且稳定，所有重放调用点传 sorted；`ytd` 缺失一律 `null` + `—` + 原因（无前复权依据时不宣称口径） | ✅ 无发现 |
| 空集合算术 | scope 内 `Math.min/max(...arr)` 全有 length 守卫（`backup.ts:144-145`、`model.ts:200-201`），`reduce` 全带初值，无 `.at(-1)` 裸用 | ✅ 无发现 |

## 附录 B：本次审计产出的可复用件

| 件 | 路径 | 用途 |
|---|---|---|
| 断言抽取器 / 分类器 | `/tmp/r2-work/extract-asserts.mjs`、`classify.mjs` | 3096 条 `assert.*` 全量分类，可在 CI 里当"假断言看门狗" |
| 行归属推导器 | `/tmp/r2-work/owner-check.mjs` | 用**真实调用点 + import 图**推导 `route → 消费行`，并与 `src/index.ts` 的 `ROW_ROUTES` 对账（补 M3 的空缺） |
| `catch` 扫描器 | `/tmp/r2-work/catch-scan.mjs` | 剥注释后统计空/极短 catch，避免被注释里的 `catch {}` 字样误伤 |
| 三个复现脚本 | `/tmp/r2-work/r1-ledger-overwrite.ts`、`daytrade-probe.ts`、`r6-composition.ts` | R1/R3/R7 的最小复现 |

> 说明：`/tmp/r2-inj`（注入副本）已按要求**丢弃**；`/tmp/r2-audit`、`/tmp/r2-tz` 保留的是**只读分析副本**与探针脚本（`zz-audit-*.test.ts`、`work/t*.ts`、`tz-*.ts`），均为报告内引用的取证材料，与工作区无交集；工作区 `git status` 仅新增本文件。
