# 独立验收报告（V3 批次 · 对抗验证）

> 验收人：`verify`。立场：**证明实现者说错了** —— 全部结论基于我自己跑的门禁、我自己构造的反例，以及 `git diff`/源码直读；不引用 `docs/AUDIT-IMPL6.md` 的数字。
> 对象：v0.38.2 工作区（51 文件 +237/−1506）。临时脚本 `/tmp/tw-v4/`（跑完删除）；写作用域仅本文件。

## 0. 结论：**通过**

- **A1（唯一改行为的项）是真修复**：`isMultiDayTrend` 是有效判据，**调用点真的用了它**；我用临时 DSH_HOME + 注入（零真实网络）重跑了端到端，当日 272 点确实落到 `local-stitch`，真两天确实走上游。
- **删除面没有删错**：被删断言对应的函数本身也被删（不是"删测试换通过"）；排序入口**结构上只剩一处**；原子写 6 处逐项语义一致；读入兼容仍在；`build.mjs` 零改动。
- **合规批次逐条落地**（豁免注释、两条模糊清单、color-mix、upDownColors、README 例外、卡片行 `role="note"`）。
- 发现 3 条 **P3 级**问题（一条陈旧注释指向已删文件、一处文案字数与描述不符、一条宽松判据边界），均**不影响行为与正确性**，不构成"有条件通过"的条件。

## 1. 门禁（我自己跑的）

`npm run check`，exit=0，日志 `/tmp/tw-v4/check.log`：

```
ℹ tests 263  ℹ pass 263  ℹ fail 0     # 第一轮（本机时区）
ℹ tests 263  ℹ pass 263  ℹ fail 0     # 第二轮（TZ=UTC）
ALL HOST CHECKS PASSED (live probes soft)
built lib/index.js + lib/client.js （v0.38.2，客户端片段校验通过：75 项）
```

交叉验证：`src/*/*.test.ts` 共 **33 个文件**，逐文件 `test()` 计数合计 **263**，与运行数吻合（无漏跑）。
`build.mjs`：`git diff --stat -- build.mjs` **输出为空**、`git status` 无记录 → 零改动，75 项片段一项未删。

## 2. A1：`isMultiDayTrend` 是真判据（核心）

**2.1 判据本身** —— `src/shared/trendStitch.ts:127-131`，`Set(points.map(p => p.label.slice(0,10))).size >= 2`。

反例实测（`/tmp/tw-v4/a1.test.ts`，全绿）：

| 构造 | 期望 | 实测 |
| --- | --- | --- |
| 同一天 272 点 | `false` | `false` ✅ |
| 两天各 1 点 | `true` | `true` ✅ |
| 空数组 / 单点 | `false`、不崩 | `false` ✅ |
| 跨月两天（09-30 / 10-01） | `true` | `true` ✅ |
| 异常 label（`''` / `'x'` / 日期串） | 不崩 | 返回 `true`（见 D3） |

**2.2 调用点真的用了它** —— `src/host/em.ts:18` import、`:1321` `if (multi !== null && isMultiDayTrend(multi.points)) return multi`；紧随其后（`:1323`）才是 `stitchFromArchive`。不是"只加了个函数"。

**2.3 端到端自跑**（临时 `DSH_HOME` + mock `globalThis.fetch`，**零真实请求**，被拦截请求数实测 `0`）：

```
[判据]    同日272点=false / 两天(各1点)=true / 空=false / 单点=false ✓
[e2e①]   {"source":"local-stitch","points":272,"days":["2026-10-09"],
           "coverage":{"have":["2026-10-09"],"missing":[],"limit":5}}
[e2e②]   {"points":2,"days":["2026-10-08","2026-10-09"]}        ← 走上游，未标 local-stitch
[e2e③]   旧判据(>1)= true   新判据(≥2天)= false
[e2e④]   被拦截的请求数： 0 []
```

- ① 注入"腾讯风格当日 272 点"（`fallbackSource`）⇒ 回包 `source='local-stitch'`、图上只有今天一天 —— **改前会短路的那条路径现在确实落到归档拼接** ✅
- ② 注入"真两天"⇒ 原样返回两天、不标 `local-stitch` ✅
- ③ 同一份数据上：旧判据 `points.length > 1` 会放行（短路），新判据不放行 —— **修复有效性的对照** ✅
- ④ 整组实测**未发出任何真实网络请求**（`fetchMultiDayTrend` 对港股 `sinaSymbol` 为空、直接返回 null；其余一律被 mock 拦下）✅

> 复跑要点：`trendWithFallback` 有 45s 结果缓存，同 secid 复用会命中上一次结果 —— 我的 e2e② 首次就踩了这个（换成另一个 secid 后通过）。这不是实现缺陷，但**复验时两个用例必须用不同 secid**。

## 3. 没有删错东西

**3.1 `wide.test.ts` 被删的 3 条断言是否承载独有不变量**

被删断言 = 断点边界（1079/1080）、"判定不出宽度按窄处理"、媒体查询与断点同源。它们锁的函数 `isWideWidth` / `layoutModeOf` / `WIDE_MEDIA_QUERY`（`client/wide.ts`、`client/useWide.ts`）**在同一批次里被一并删除**（`git status`：`D src/client/wide.ts`、`D src/client/useWide.ts`）→ 断言失去被测对象，被删合理，**不是靠删测试换通过**。

**"排序入口恰有一个"现在由结构保证**：`SortHeader` 组件文件已不存在（全仓 `grep SortHeader` 无结果），`SortBar` 只在 `WatchlistPage.tsx:174` 与 `PortfolioPage.tsx:252` 各出现一次，且**无条件渲染**（直接位于 `createElement` 树中，无 `? :` 包裹，路径上也不需要按宽度切换）→ 宽窄都不存在"第二个入口"或"零个入口"。这比原先"靠 `pickSortEntry` + 运行时量测"更硬。

**3.2 `WIDE_MIN_PX` 迁移后的断言非恒真（注入证明）**

`src/client/styles.test.ts:9-15` 读 `TW_CSS` 文本比对。我复刻同一逻辑跑了两次（`/tmp/tw-v4/assertions.test.ts`）：

```
[断点]  WIDE_MIN_PX= 1080   CSS 里出现： [1080,1080]   不符合： []
[注入]  篡改后 bad = [900]
```

- 真实 CSS 里至少 2 处断点、且全部等于 `WIDE_MIN_PX`（非空 ✅）
- 把其中一处改成 `900` 后，同一条断言**能被检出失败** → **不是恒真** ✅

**3.3 `atomic.ts` 的 6 个调用点逐处语义核对**

模块在 `src/host/atomic.ts`（导出 `writeFileAtomic` / `writeJsonAtomic`），6 个调用点：`store.ts`、`writeLog.ts`、`calendar.ts`、`trendArchive.ts`、`breadth.ts`、`rescue.ts`。

| 语义 | 替换前（HEAD，各处手写） | 替换后（`atomic.ts`） | 一致 |
| --- | --- | --- | --- |
| 临时文件 | `const tmp = \`${target}.tmp\`` | 同 | ✅ |
| 目录 | `mkdir(dir, {recursive:true}).catch(()=>undefined)`（store.ts 例外，见下） | `mkdir(dirname(target), {recursive:true}).catch(()=>undefined)` | ✅ |
| 序列化 | `JSON.stringify(v, null, 1)` | `writeJsonAtomic` 默认 `indent=1` | ✅ |
| 编码 | `'utf8'` | `'utf8'` | ✅ |
| 覆盖 | `rename(tmp, target)` | 同 | ✅ |
| 权限 | 未设置（全仓 diff 无 `mode:`/`chmod`） | 未设置 | ✅ |
| 错误 | 不吞，抛给调用方处理 | 不吞，抛给调用方 | ✅ |

唯一差异：`store.ts` 原来的 `mkdir` **没有** `.catch()`，新实现有 —— 目录创建失败时原来立刻抛 `mkdir` 错误，现在由随后的 `writeFile` 抛出（**仍然抛错，不会静默丢数据**），属措辞级差异。

**3.4 `ACTOR_TOOL` 与读入兼容**

`src/host/store.ts:72` 仍是 `actor: raw.actor === 'tool' ? 'tool' : 'web'`（老账本里的 `'tool'` 照旧可读）；常量 `ACTOR_TOOL` 在 `src/shared/model.ts:855` 保留；写入侧用 `ACTOR_WEB`（`store.ts:786`）✅。

## 4. 合规批次是否真生效（文本核对）

| 项 | 实测 | 判定 |
| --- | --- | --- |
| `role="note"` 在**卡片行**上 | `WatchlistPage.tsx:406/420/435/456/463`（行内）与 `PortfolioPage.tsx:1007/1057`（行内）；另有面板级 `PortfolioPage:335/348/360/371`、`WatchlistPage:249/275` | ✅ |
| `.tw-pos-title small` 在**两条** `data-blur=1` 清单 | `styles.ts:144`（基线清单，起于 `:137`）与 `:155`（hover 清单，起于 `:147`）都在 | ✅ |
| `.tw-cal-day` / `.tw-code` 豁免注释 | `styles.ts:326`（`.tw-code`）、`:351` 与 `:353`（`.tw-cal-day`） | ✅ |
| M3 两处硬编码浅红**已无** + `color-mix` 写法 | `styles.ts:105` `color-mix(in srgb, var(--tw-up) 10%, transparent)`、`:108` `…8%, transparent`；写法为 `color-mix(in srgb, <color> <pct>, transparent)`，正确 | ✅ |
| `upDownColors` 被 `kline.tsx` 使用、内联 redUp 三元为 0 | 定义 `chartCursor.ts:283`；使用 `kline.tsx:247`、`:509`；`kline.tsx` 内**无颜色值三元**（`:721` 是 `tw-up`/`tw-down` **类名**三元，不是内联色值） | ✅ |
| README「窄容器例外」行 | `README.md:356`（允许简写成 `数据 HH:mm:ss`，写明规则与实现必须一致） | ✅ |

## 5. 文案层

```
[missingBrief] "缺 09-25、09-28、09-29，另有 8 天"   长度 = 26
[边界] {"zero":"","one":"缺 09-25","three":"缺 a、b、c","four":"缺 a、b、c，另有 1 天"}
[红条] 正文 = "涨跌家数未取到" = 7 字
```

- `missingBrief` 在 11 天输入下 **26 字 ≤ 40**、含「另有 8 天」、后段不进常显；0/1/3/4 天边界正确 ✅
- 家数红条正文 = 「涨跌家数未取到」（**实测 7 字**），长原因在 `title`（`MarketPage.tsx:206`）与 `aria-label`（`:207`）✅
  - 任务描述为"8 字"，实测 7 字：属**描述与实测的 1 字出入**，语义（短正文 + 长原因进 title/aria）成立，记录在案（D2）。

## 6. 发现（P3，均不阻塞）

- **D1（P3，陈旧注释）**：`src/client/styles.ts:122` 仍写「⚠ 断点必须与 **client/wide.ts** 的 `WIDE_MIN_PX` 一致」——`client/wide.ts` 本批次已删除，`WIDE_MIN_PX` 现在就在 `styles.ts` 自身（`:9`）。注释指向不存在的文件，会误导后来者。同一段的后半句（"v0.36.0 起列头排序已删除"）是新的，属"改了一半"。
  **建议**：把该行改为「本文件的 `WIDE_MIN_PX` 是唯一数字来源，CSS 里每个 `@media (min-width:…)` 必须等于它（由 `styles.test.ts` 直接读 CSS 文本比对）」。
- **D2（P3，描述出入）**：家数红条正文实测 **7 字**（`涨跌家数未取到`），任务书写 8 字。行为符合意图，仅需在文档/说明里对齐字数口径。
- **D3（P3，宽松边界）**：`isMultiDayTrend` 只做 `label.slice(0,10)` 的去重计数 —— 若上游给的 label 不是 `YYYY-MM-DD HH:mm`（例如空串、纯时间），会把它们当成不同日期而判成"多日"。上游 label 由 `parseTrendRow` 统一构造，当前不可达；若想更硬，可加一条 `label` 形状校验（不匹配则不计入天数）。我没有把它当缺陷，因为**判据的方向是安全的**（宁可真多日走拼接，也不把当日当多日）。

## 7. 未验证

1. **渲染层**：`role="note"` 的实际可聚焦/朗读者体验、`color-mix` 在深浅主题下的观感、两条模糊清单的实际模糊效果，**均未在浏览器执行**（本机无 react 运行时）。
2. **原子写的抗中断性**：我只做了"替换前后逐处逐项语义比对"（`git diff` 直读），**没有**构造"写入中途杀进程"的实测；rename 的原子性依赖文件系统语义，这一层未验。
3. **上游真实行为**：按要求不探活；`e2e①②` 的两组输入均为注入。
4. `npm run check` 的 live 探针全程 soft（本机上游不可达）。

## 8. 复现

```bash
npm run check                                                            # §1
node --test --experimental-strip-types /tmp/tw-v4/a1.test.ts              # §2（临时脚本，跑完删除）
node --test --experimental-strip-types /tmp/tw-v4/assertions.test.ts      # §3.2 / §5
git diff --stat -- build.mjs                                             # §1（应为空）
```
