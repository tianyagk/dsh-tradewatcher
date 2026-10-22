# 棱镜（第 9 行 / 第 8 页签）批次 1+2 —— 骨架、调度、金十、4+1 研判

> 用户已批准全部口径（2026-10-22）。本批只做批次 1 + 2；页面、渲染、MD 只落在本页。

## 0. 一行结论

注册面 9 行/8 页签已通，`inject` 含 `llm`（`ctx.get` 判空 + try/catch）；时点调度（默认 4 个、可增删、非交易日不跑、已过点手动补跑）、骨架读写、金十 24h 回填（≤10 页/批、3s 间隔、增量 `lastSeenId`）、4 路并行 + 1 次汇总全部落地；两轮门禁 **1110 × 2** + 构建 **73 项**。

## 1. `llm.stream` 最小实跑

本机在**不重启宿主**的约束下无法从插件 fiber 调 `ctx.llm.stream`（宿主里的插件还是旧构建；`inject` 改动只有在装载时生效）。做了两条实测：

| 项 | 结果 |
| --- | --- |
| `dsh headless '只回复 OK 两个字母，不要别的'` | **输出 `OK`**，无错误；同一 profile/模型链路可达 |
| 插件侧 `ctx.llm.stream` | **未在活宿主里执行**（需重启 `dsh web` 装载新行）；代码路径见 `prismLlm.ts`，单测用假 stream 验证（4+1、失败留痕、不重试） |

> 报告如实标注：这是**未完成项**，不是"已验证"。

## 2. 批次 1：骨架与调度

| 项 | 实现 |
| --- | --- |
| 注册面 | `RowId`/`rowOf`/`ROW_ROUTES.prism`/`ROW_TOOLS.prism`（空）；`cordis.patch.yml` 第 9 行；`package.json` 两条 exports；`locale/rows/prism/{en,zh}.json`；`index.test.ts` 精确列表；`DESIGN-SUBPLUGINS.md` §2.1/§2.2 + **路由账 31**；README 页签 **8** / 行 **9** + 数据文件表四条 |
| 路由 | **只有一条** `/tradewatcher/prism`：GET = 状态；POST `{action: settings/skeleton/news/run}` ⇒ 路由账只 +1 |
| `inject` | `['webServer','webRuntime','llm']`；所有 `ctx.get` 都包 try/catch（宿主 ctx 是 Proxy） |
| 调度 | `PrismScheduler` 30s 节拍（`unref`、`NODE_TEST_CONTEXT` 不启动）；时点落 `prism-settings.json`（`updateJsonLocked` + `ReadGuard`）；默认 `09:35/11:20/13:10/14:40`；**可增删、≤50**；非交易日（`tradingDayState`）不跑；只自动追 10 分钟内刚过的点，更早的**手动补跑**（POST `run` 只跑指定时点） |
| 骨架 | `prism-skeleton.md`（`DSH_HOME/dsh-tradewatcher/`）；页面多行 textarea 保存（POST，≤20 000 字）；首次打开写默认骨架 |

**偏离说明（必须看）**：任务文字要求用 `ctx.schedule`。实测该服务 `create(sessionId, …)` **必须绑定一个 SessionId**，且投递会 `agent.followup()`（开 agent turn），而棱镜的研判是进程内管线、没有绑定会话。强行创建 session 会把"研判"变成"给某个会话发提醒"，不满足 4+1 管线语义；因此本批用**自研 30s 节拍 + 水位落盘**（与 `auctionSeries.ts` 同一套已验证模式），`ctx.schedule` 未接入。若必须用它，请指定一个新会话的用途。

## 3. 批次 2：金十 + 研判

| 项 | 实现/实测 |
| --- | --- |
| 金十接口 | `GET https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=1&max_time=…`，头 `x-app-id: bVBF4FyRTn5NJF5n` + `x-version: 1.0.0`；经 `withHostBreaker`（H1 纪律） |
| 实测（2026-10-22 15:42） | **20 条/页**，最新 `2026-10-22 15:41:51`：`加拿大皇家银行：将Meta Platforms(META.O)目标价从770美元上调至800美元。` |
| 回填 | 首次 24h；每批 **≤10 页**、页间 **≥3s**；未完成 `state:'backfilling'` + `回填中（已 N 页）`；之后 `lastSeenId` 增量（最多 2 页）；`prism-news.json` 保留 24h |
| 研判 | 4 路并行（A股宏观/外盘/大宗/信息面）+ 1 次汇总；输入 = 真实持仓（`assemblePortfolio`，只读）+ 骨架 + 金十 24h + 既有行情摘要（`fetchQuotes`，**不接新源**）；结果 `prism-runs.json`（保留 20 次） |
| 失败 | 单路失败只留 `error`，不重试；四路全空 ⇒ 汇总跳过并留痕；模型缺失 ⇒ 一次调用都不发 |

## 4. Material Design（只本页）

- elevation 六档 token：`--tw-elev-0/1/3/6/8/12`（浅/深各自一套）。
- state layer：`.tw-prism-card::after` + `opacity`（8% hover / 12% active）。
- ripple：**固定 100×100**，只动 `transform: scale` + `opacity`；`data-idle=true` 时 JS **移除节点**（不靠 CSS 暂停）；`prefers-reduced-motion` 关闭。
- 字号只用 **12 / 14**；不写免责类文案；缺数据 `—` + 一句原因。

## 5. 断言 + 反例注入（必败）

| # | 判据 | 用例 | 注入 |
| --- | --- | --- | --- |
| ① | 页签最右/第 8；路由账 31 | `client/prismPage.test.ts` ①、`index.test.ts` 路由账 | 页签挪走/重复；路由账数字不符 ⇒ 失败 |
| ② | `inject` 含 `llm`，`ctx.get` 有 try/catch | 源码判据 | 去掉 `llm`/去掉 try/catch ⇒ 失败 |
| ③ | 时点落盘/可增删/非交易日不跑/补跑只跑指定点 | `host/prismScheduler.test.ts` | 全天跑/忽略周末 ⇒ 失败；`run` 只接受单个 slot |
| ④ | 骨架可读写 + 默认值 | `prismStore` 测试 + 源码 | 不写默认/不存盘 ⇒ 失败 |
| ⑤ | 金十两个头齐备 | `host/prismNews.test.ts` ⑤ | 少 `x-app-id`/`x-version` ⇒ 失败 |
| ⑥ | 回填 ≤10 页、间隔 ≥3s、增量到 `lastSeenId` | 同上 ⑥ | 页数/间隔不符 ⇒ 失败 |
| ⑦ | 4 并行 + 1 汇总、失败不重试 | `host/prismPipeline.test.ts` | 串行/重试/少汇总 ⇒ 失败 |
| ⑧ | ripple `transform`、字号 12/14、elevation 六档 | `client/prismPage.test.ts` ⑧ | 关键帧动 width/height、11px ⇒ 失败 |
| ⑨ | 无免责文案 | 同上 ⑨ | 加「免责/风险提示」⇒ 失败 |
| ⑩ | 缺数据 `—` + 原因 | `client/prismView.ts` + 测试 | 写 0/空串 ⇒ 失败 |

## 6. 门禁

- 基线 1096 → **1110 条/每时区**（新增 14：调度 2 + 金十 3 + 管线 2 + 页面 3 + 注册/接线 2 + 状态落盘 2）。
- `DSH_HOME=/tmp/prismb12-check{X,Y} npm run check` 两轮：

| 轮次 | 读数 |
| --- | --- |
| AB | **1110 × 2 全绿**（19,299 / 18,851ms）；selftest 全过；构建 **73 项**（v0.129.1） |
| AC | **1110 × 2 全绿**（18,892 / 18,988ms）；selftest / 构建同 AB |
