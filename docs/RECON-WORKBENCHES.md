# 六个 DSH 投研工作台/插件技术侦察

> 侦察对象：Hanai Investment DSH、dsh-skills-stock、dsh-quant、dsh-invest-bundle、dsh-invest-research、Capital Generation
> 侦察员：recon-week（只读）｜侦察时间：2026-10-20｜仓库 HEAD 基线：`f1127b1` (v0.119.0)
> 结论标记：**实测** = 读到代码；**文档声称** = 仅 README/市场页这么写；**未确认** = 没读到或读不到

## 0. 总览

| 项目 | 版本 | 许可证 | 体量（解包／文件数） | 形态 | 需要额外运行时 |
|---|---|---|---|---|---|
| [Hanai Investment DSH](#1-hanai-investment-dsh) | 0.1.0 | MIT | 34 MB / 266 | DSH bundle（host + web client + profile） | Node ≥ 22，**强绑定 DSH 0.2.1-rc.2** |
| [dsh-skills-stock](#2-dsh-skills-stock) | 1.3.1 | MIT | 5.0 MB / 412 | 纯 skill bundle + web 侧边栏 | **Python** + 182 个 .py 脚本；Tushare/问财密钥 |
| [dsh-quant](#3-dsh-quant) | 0.90.0 | MIT | 3.2 MB / 412 | 插件（**实测 59 工具**，非 46）+ CLI | **零依赖、零 Python、零密钥**，纯 Node ≥22 |
| [dsh-invest-bundle](#4-dsh-invest-bundle) | **0.2.0**（市场页仍写 0.1.1） | MIT | 2.0 MB / 82 | 23 skill + 10 工具 + 12 脚本 + workflow | **Python 3.10+**；`python-docx`/`matplotlib` 仅 PDF 用 |
| [dsh-invest-research](#5-dsh-invest-research) | 0.3.1 | MIT | 672 KB / 34 | 纯 skill bundle（2 skill） | **Python 3.10+**；akshare 可选 |
| [Capital Generation](#6-capital-generation) | 2.9.0 | MIT | 7.6 MB / 734 | Agent Preset + 数据源适配 + 面板 | Node ≥20.16；**5 把数据源密钥**；零 Python |

**六个全部找到，零未找到。** 全部 MIT，均可只读借鉴（MIT 允许复用，需保留版权声明；本文只记录要点与出处，不搬运代码）。

### 检索方式与命中（可复现）

| # | 检索手段 | 命中 |
|---|---|---|
| 1 | `npm view <name>`（registry.npmjs.org 直查） | `dsh-quant@0.90.0`、`dsh-skills-stock@1.3.1` 直接命中；`dsh-invest-bundle` / `dsh-invest-research` / `hanai-investment-dsh` 均 **E404** |
| 2 | `npm search` / `registry.npmjs.org/-/v1/search?text=` | `@v587d/capital-generation@2.9.0` 由 "capital generation dsh" 命中；`dsh-invest` 为同名不同项目（投资全生命周期工作台），非本清单项目 |
| 3 | `api.github.com/search/repositories?q=hanai+investment` | `hancao97/hanai-investment-dsh` ✓（GitHub 未发布 npm 包） |
| 4 | `api.github.com/search/repositories?q=dsh-invest-research` | 两个同名仓库：`lobster-liu/dsh-invest-research`（v0.3.1，**与任务描述一致**）与 `eclipti/dsh-invest-research`（v0.1.0，巴菲特打分工具，**不同项目**）。首次查询被 GitHub 限流（`API rate limit exceeded`），等待 15 s 后重试成功 |
| 5 | web_search → 社区插件市场页 `dsh-plugin.org` | `woshipixiu1234/dsh-invest-bundle`（市场页记录 v0.1.1 / MIT / Python 为主语言），据此转 `git clone`。市场页搜索路由 `/search?q=` 返回 404，改为直接读插件详情页 |
| 6 | `npm pack` + `tar -xzf` | 五个 npm 包解包到 `/tmp/week-*`，未安装、未写入任何 profile |

> 检索失败留痕：`npm view hanai` / `hanai-investment-dsh` / `investment-dsh` 均 E404；`dsh-plugin.org/sitemap.xml` 仅 3 条 `<loc>`（无插件索引）；`awesome-deepseek-harness` README 中 grep `invest|hanai|capital|quant` 无结果。

---

## 1. Hanai Investment DSH

- **包／仓库**：`hancao97/hanai-investment-dsh`（GitHub，npm 未发布）｜`git log -1` = `32c74c7` "fix: adapt Hanai to DSH 0.2.1-rc.2"（2026-10-18）
- **版本**：根 `package.json` 0.1.0；**LICENSE：MIT**
- **安装**：`npm install -g @deepseek-ai/dsh@0.2.1-rc.2` → `pnpm install --frozen-lockfile` → `pnpm run build` → `pnpm run profile:install -- --package .` → `pnpm run profile:verify` → `dsh --profile hanai-investment --port 3080`（README:214-219）。**不是 `dsh plugin add`，走独立 profile 安装器**
- **形态**：pnpm monorepo，6 个包。`host`(1261 行) / `domain`(3248) / `client-workbench`(4954) / `client-chat`(1737) / `contracts`(480) / `masters`(311)，合计 ≈ 12k 行 TS。

### 功能清单（实测）

| 功能 | 位置 |
|---|---|
| 六大指数：上证 / 深证成指 / 创业板指 / 沪深300 / 科创50 / 北证50 | `packages/domain/src/providers/eastmoney.ts:22-29` |
| 市场宽度：涨/跌/平/涨停/跌停/两市成交额 | `packages/contracts/src/index.ts:28-40` |
| 行业/概念热力图（可切换 `industry`/`concept`） | `packages/client-workbench/src/app.tsx:289`、`:366` |
| 7 位大师方法论建档（段永平/缠江龙/芒格/巴菲特/散户乙/东泰山/孙宇晨）+ 每人 asset 目录带 SKILL.md | `packages/masters/src/index.ts:14-80`、`packages/masters/assets/` |
| 研判报告状态链 | `contracts/src/index.ts:237-244` |
| 报告不可变封存 + sha256 | `domain/src/reports.ts:63-131` |
| 全局搜索（⌘/Ctrl+K）+ hash 深链接 | `client-workbench/src/app.tsx:124-131`、`:98-123` |
| 亮/暗主题（`data-theme` + 图表调色板双份） | `client-workbench/src/app.tsx:162`、`chart-options.ts:130-131` |
| 三源行情 + 缓存 + 元信息溯源 | `domain/src/providers/`（eastmoney/sina/tencent/gurufocus/cache） |
| 全市场变盘点回测（实测 5,704 只 / 981 万根 K） | `scripts/research/full-market-turning-point-study.py` |

### 最值得借鉴的机制

**① 报告状态机：不是「分析完就落盘」，而是带修复预算的闭环（实测）**
状态集是 `preparing | generating | verifying | repairing | ready | revising | failed`（`contracts/src/index.ts:237-244`，比任务描述的四态多三态）。`finalizeReport()` 先置 `verifying`，再尝试 `seal()`；若抛 `ReportValidationError`（报告缺失/太短/无一级标题），读 `repairAttempts`：**< 1 才允许一次自动修复**——回写 `repairing` 并用 `repairPrompt(error.message)` 重新驱动同一个 DSH session；否则判失败（`host/src/service.ts:748-782`）。校验门槛来自配置 `reportMinChars`（默认 800，`host/src/index.ts:33`）。
最漂亮的一行是失败处置：`reportStatus: current.latestReportVersion === null ? 'failed' : 'ready'`（`service.ts:790`）——**改版失败绝不能让已封存的旧版变得不可用**。

**② 封存 = 内容寻址 + 原子改名 + 幂等恢复（实测）**
`seal()` 不用「写文件覆盖」，而是：校验通过 → 写入 `<judgement>/reports/<0001>.staging/`（`report.md` + `manifest.json`）→ `renameSync` 到最终目录（`reports.ts:81-118`）。`manifest.json` 记 `sha256`、`sizeBytes`、`sealedAt`、`masterVersion`、`model`、`reasoningEffort`，`schemaVersion: 1`（`reports.ts:16-33`）。目标目录已存在时走 `readExistingSeal()`：**逐字段比对 manifest 与重算摘要，全部相符才复用，任一不符直接拒绝覆盖**（`reports.ts:156-187`）——这解决的是「rename 成功但随后 SQLite 事务没提交」的半写状态。目录权限 0700、文件 0600，且所有路径过 `assertInDataRoot()` 防穿越（`reports.ts:189-193`）。

**③ 每个数据块自带「出处五元组」，缓存是三态的（实测）**
`ProviderMeta = { providerId, sourceName, sourceTimestamp, fetchedAt, cacheState }`，`cacheState ∈ fresh | cached | stale | unavailable`（`contracts/src/index.ts:6-14`）。所有返回值都挂 `meta`，连 K 线、板块、财务都不例外。`ProviderCache`（43 行）做四件事：**单飞合并**（`pending` Map，同 key 并发只发一次请求）、TTL 命中、失败降级（保留上次成功值并把 `cacheState` 改 `stale`，退避 60 s）、容量上限 500 条 LRU（`domain/src/providers/cache.ts:5-38`）。
这与本仓库要求的「每个读数都带【数据出处】／缺失分上游无此数据与本次失败」直接同构，**是本清单里最可直接照搬的机制**。

**④ 降级不是整包换源，而是「部分补齐 + 合并元信息」（实测）**
主源东财返回后，只把**缺失的 secId** 交给腾讯补；补齐后按情况合并 meta：全部来自备源 → 直接用备源 meta；混合 → `sourceName` 写成「东方财富 / 腾讯行情（备源）」，且两侧都非 fresh 时才标 `stale`（`domain/src/providers/index.ts:236-250`）。`unavailableMeta()` 给「取不到」一个独立状态而不是抛错（`:252-253`）。

**⑤ 研究纪律：预注册 + 聚类区间 + Holm 校正 + 匹配对照（实测，且是自证否的）**
`scripts/research/chan-signal-stability.py:445` 的 `cluster_bootstrap()` 按**股票**分组重采样 2,000 次取 2.5/97.5 分位；`full-market-turning-point-study.py:1607` 有 `holm_adjust()`；入场统一 `entry = signal_index + 1`（`:1187`、`:1229`）杜绝未来函数；输入数据按年 `sha256` 固化（`aggregate-chan-walk-forward.py:77`）。README:109-141 记录了 **16 个假设 0 通过**，因此「产品没有新增任何已验证高胜率买点」——**这种「研究没通过就不上线」的写法本身就是可复用的范式**，尤其适合给「杠杆温度计」「护盘信号」提供量化辩护。

### 风险 / 注意

- **强绑定 DSH `0.2.1-rc.2`**：`package.json` 的 peerDependencies 逐个钉死 `0.2.1-rc.2`（15 个 `@deepseek-ai/*` 包），安装器还会校验 CLI 版本（README:207）。本仓库是 v0.119.0，**不可直接装**，只能读设计。
- 客户端靠 `ctx.slots.inject('shell.overlay', ...)` 挂载（`client-workbench/src/index.tsx:24`），依赖 `dsh-client-ui-slots` 的 `PropsRuntime`——沿用需对齐当前 slot API。
- 报告「状态链」实际七态，与二手描述的四态不符（**以代码为准**）。

---

## 2. dsh-skills-stock

- **包／仓库**：npm `dsh-skills-stock@1.3.1`｜`github.com/kkutysllb/dsh-skills-stock`｜作者 UncleC｜**MIT**
- **安装**：`dsh plugin --profile web add dsh-skills-stock`（或 `github:kkutysllb/dsh-skills-stock` / 本地路径，README:30-37）
- **形态**：**编译产物发布，无 src**（只有 `lib/index.js` 1187 行 + `lib/client.js` 1297 行 + `skills/`）

### 功能清单（实测）

| 功能 | 位置 |
|---|---|
| 41 个 runtime skill（`skills/manifest.json` 统计恰为 41） | `skills/manifest.json`；`lib/index.js:1121` 注册并打印 |
| 四库工作台：策略/因子/选股/报告 | `lib/client.js:47-48` `LIBRARY_TABS` / `WORKBENCH_TABS` |
| 18 个四库 Agent 工具 | `lib/index.js:836-985`（`libraryToolSet`）+ `reportToolDefs` |
| 多运行净值曲线叠加 | `lib/client.js:215-232` + `260-295` |
| 累计 IC 曲线叠加 | `lib/client.js:233-250`（`cumulativeIc`） |
| HTML 报告预览（沙箱 iframe） | `lib/client.js:824-829` |
| 每 Tab 独立指标列 | `lib/client.js:296-297` `metricKeysOf` |
| 数据源凭据配置页 | `lib/client.js:384` `DataSourcesSettingsView` |
| 182 个 Python 脚本随技能发布 | `skills/**/*.py` |

### 最值得借鉴的机制

**① 工具用工厂函数生成，而不是手写 18 份 schema（实测）**
`libraryToolSet(kind, store)`（`lib/index.js:836`）对 `strategies / factors / selections` 三库各产出 **5 个工具**：`<kind>_list`、`_create`、`_get_latest`、`_save_version`、`zh.record`（即 `strategy_record_backtest` / `factor_record_run` / `selection_record_run`，见 `:837`）。三类共用同一套实现，差异只在「记录标签」和「运行载荷字段」：
`runPayload` 分别声明 `["data_start","data_end","rules","metrics","equity?","trades?"]`（策略）、`[...,"ic_series?","layers?"]`（因子）、`["trade_date","universe","rules","metrics","report?","picks?"]`（选股）。再加上 `report_archive / report_list / report_get` 三个报告工具（`:988` 起）= **15 + 3 = 18**，与「18 个四库工具」吻合。
这种「一个工厂 × N 个 kind」的写法值得直接借：新增第五个库只需加一行 kind。

**② 曲线叠加是手写 SVG，零图表库依赖（实测，约 80 行）**
三步：`normalizeEquity()` 用**首值归一**（除以 `values[0]`，`:229-231`）让不同 run 可比；`cumulativeIc()` 对 `ic` 序列做累积和（`:243-249`，反正 IC 有正负，累计曲线能看出方向稳定性）；`CurveOverlay()` 把所有 series **拉平求共同 y 域**（`bounds`，`:251-259`），x 轴按各自长度归一（`x(index, length)`，`:269`），再用 `polyline` 画线，末尾画 baseline 虚线 + min/max 刻度 + 图例（`:271-294`）。
一个诚实的细节：图例里长度不一致时写 `"${len}/${maxLen}${unit}"`（`:290`）——**不对齐就直说**。代价是 x 轴是「第几个点」而非日期，跨 run 日期错位会失真（本仓库若复用应改成时间轴）。

**③ 密钥不落环境变量，落 `secrets.env` + 显式规避 DSH 的剥离策略（实测）**
`SECRET_KEYS = ["TUSHARE_TOKEN","IWENCAI_API_KEY"]`（`lib/index.js:371`），存在 `<数据根>/secrets.env`，写盘用临时文件 + `chmod 0600`(384) + rename（`:466-469`）。要点在于它把 DSH 的一个行为写进了系统提示：**DSH 会把名字含 TOKEN/KEY/SECRET/PASSWORD 的进程环境变量从 bash 子进程里剥掉**，所以调用脚本前必须在**同一条** bash 命令里 `set -a; source <数据根>/secrets.env; set +a` 再执行（`lib/index.js:8` 的超长 `KSTOCK_GUIDANCE`）。
→ 本仓库若要接需要 token 的数据源，这是现成的绕坑方案。

**④ 报告预览 = `sandbox=""` 的 srcDoc iframe（实测）**
`<iframe srcDoc={content} sandbox="" ...>`（`lib/client.js:824-829`）。空 `sandbox` 表示「最严格：不执行脚本、不同源、不给任何权限」。**这是渲染任意 HTML 报告的正确姿势**，比丢进主文档 `dangerouslySetInnerHTML` 安全得多。

**⑤ 把「纪律」写进系统提示而不是写进代码（实测）**
单行 8 KB 的 `KSTOCK_GUIDANCE`（`lib/index.js:8`）用自然语言把工具使用纪律钉死：策略/因子代码与选股口径**必须**经 `save_version` 入库；回测后**必须** `record` 归档且 `rules/config` 原样抄录（否则跨版本对比口径失效）；新版劣于旧版要如实呈现并在 `change_note` 写「证伪」；连通性验证一律走只读 `*_list`，**禁止用 `*_create` 制造探测资产**。
→ 这条「不许用写接口探活」对我们自己的工具设计有直接参考价值。

### 风险 / 注意

- 只有构建产物，**无源码**：可读性尚可（未压缩），但改动/审计只能基于打包文件。
- 41 个 skill 里 182 个 Python 脚本，依赖 pandas/numpy/tushare/akshare 等，`pip install` 是运行前提（README:150）。
- 数据依赖付费/需登录源（Tushare Token、问财 Key），非开箱可用。

---

## 3. dsh-quant

- **仓库／包**：npm `dsh-quant@0.90.0`（106 个版本，最新发布 2026-08-23）｜**无 repository 字段**（`repository: null`），只有包描述里的站点 `dsh-quant-site.pages.dev`
- **LICENSE：MIT**（"dsh-quant-indicators contributors"）｜**无 NOTICE、无 vendor 目录、无捆绑第三方源码**
- **安装**：`dsh plugin --profile web add dsh-quant`；另带 `bin: dsh-quant → cli/main.mjs`
- **运行时（重要）**：**零运行时依赖、零 Python、零密钥**。纯 ESM Node ≥22，`dependencies` 为 null，只有 peer（`@deepseek-ai/cordis ^4.0.0`、`dsh-tools`、`dsh-system-prompt`）。网络出口全是公开 REST（binance/okx/bybit/sina/tencent/yahoo/GitHub/npm）
- **体量**：解包 3.2 MB / 412 文件，但 `lib/` 只有 612 KB；`quant-history/`(860 K)、`log/`(480 K)、`quant-repo/`(116 K) 都随包发布——**约 2.3 MB 是散文和 PNG**

### 功能清单（实测，与宣称有三处硬冲突）

**工具数：注册了 59 个，不是 46 个。** 我方独立复核：`grep -c "ctx.tools.register(defineTool" lib/index.js` = **59**；而 `mcp/tools.json` 里 `toolCount: 46`、`generatedAt: 2026-08-17` 已过期，`package.json:4` 同样是 46。缺的 13 个正是较新的因子/执行类工具（`quant_layered_backtest`、`quant_ic_decay`、`quant_stress_test`、`quant_trading_cost`…）。`cli/main.mjs` 也还在打印「46 工具」。**README.md:13,74 写 59 是对的。**

| 域 | 个数 | 代表工具（`lib/index.js` 行号） |
|---|---|---|
| alpha | 16 | `sma:83` `ema:107` `rsi:132` `macd:158` `bollinger:186` `atr:217` `kdj:476` `factor_evaluate:1342` `ic_decay:1397` `factor_neutralize:2298` |
| data | 11 | `market_fetch:245` `data_guide:868` `data_quality:1066` `data_pit:1205` `channel_guide:1288` `resample:2064` |
| ml | 15 | `backtest:327` `backtest_grid:388` `backtest_portfolio:765` `portfolio_optimize:821` `layered_backtest:1481` `deflated_sharpe:1628` `walk_forward:2343` `linear_model:2821` |
| risk | 7 | `risk:1944` `stress_test:1983` `var_backtest:2029` `drawdown:2400` `bond:2687` `option:2737` `volatility:2790` |
| execution | 7 | `chart:1719` `fund:1896` `report:2123` `execute_sim:2463` `trading_cost:2608` `research_pipeline:2879` |
| community | 3 | `repo_stats:2156` `npm_stats:2205` `oss_pulse:2243` |

注册方式也很朴素：`apply(ctx)`（`lib/index.js:81`）里 **59 个展开的** `ctx.tools.register(defineTool({...}))` 块（`:82`→`:2878`），**没有任何循环或注册表**；59/59 全部声明 `isConcurrencySafe: () => true`（连联网工具也是）。

### 三处「宣称 vs 实测」硬冲突（这是本节最重要的产出）

**① 「三所行情自动容错」：A 股根本没有容错。**
`fetchWithFallback()`（`lib/dsh-execution/pipeline.js:13-28`）第一件事就是把 A 股两支短路掉：

```js
if (provider === 'sina' || provider === 'tencent') {
    return fetchKlines(symbol, interval, limit, signal, provider);   // 单次尝试，失败即抛
}
const chain = [...new Set([provider, 'binance', 'okx', 'bybit'])];
```

也就是说降级链只覆盖**加密货币**；而且整包只有 `research_pipeline` 一个调用点（`:40`），`quant_market_fetch` 从不走容错。更糟的是整条链共用**一个** `AbortSignal.timeout(20_000)`（`lib/index.js:2955`）：若 binance 吃满 20 s，okx/bybit 会拿着已中止的 signal 立刻失败——**"三个备份"在超时场景下等于零个**。
失败判据也只有「抛错」一种（网络异常、HTTP 非 2xx、返回非数组、K 线为空、解析失败，`market.js:183-196` 等），没有空结果重试、没有 schema 比对。
缓存、熔断、健康状态：`grep -rn "cache|memo|circuit|breaker" lib/` → **0 命中**。只有一张静态先验可靠度表（binance .95 / okx .93 / bybit .92），代码注释自己写着「纯启发式，非实测」（`lib/dsh-data/quality.js:84-101`）。

**② 「A 股 8 渠道知识库」：是一个硬编码数组 + 子串匹配，没有语料、没有向量、没有索引。**
`DATA_CHANNELS` 是 `lib/dsh-data/data-guide.js:10` 里的**字面量数组**，字段为 `url/cost/dataTypes/setup[]/tutorialUrls/bestFor/notes`。所谓检索（`searchChannels`，`:200-220`）是**大小写无关的 `String.includes`**，逐字段匹配 name → dataTypes（双向 `t.includes(q)||q.includes(t)`）→ bestFor/cost。
而且「8 渠道」也过期了：数组现在有 **15 条**（历史 8 个 akshare/baostock/tushare/wind/ifind/sse/szse/csindex + tencent/yahoo/capital-generation/dsh-us-stocks/data-mcp/chinabond/cfets）。`rag/README.md:4,10` 自己承认「是当前最小的内置 RAG 形态」，且那份文档说 13 条、README:192 说 15 条、代码是 15 条。
→ **它是一份结构化选型文档，被包装成了 "知识库"。** 对我们有参考价值的是「渠道元数据该记哪些字段」（成本/是否需要装环境/最适合什么/教程链接），而不是 RAG。

**③ ICIR 没有年化，年化口径还自相矛盾。**
`factor.js:94-100`：`icir = icMean / icStd`，`icStd` 用**总体标准差（÷n）**、窗口默认 20、**无 √252**。所以它的 ICIR 是「每个窗口」单位，跨窗口不可比，也不能跟 Wind/聚宽的 ICIR 对齐。
同时年化因子在同一个包里混用：`metrics.js:21`、`risk.js:65-66`、`backtest.js:168` 用 **√365**；`optimizer.js:165-167`、`volatility.js:11` 用 **√252**；`fund.js:20` 用 /365。同一个 `sharpe` 标签背后是两套日历。

### 最值得借鉴的机制（扣掉上面三条，剩下的是真货）

**① IC / RankIC / 分层 / IC 衰减，数学是干净的（实测）**
- IC = 教科书 Pearson，滚动配对 `factor[i]` vs `returns[i+1]`（`lib/dsh-alpha/factor.js:16-39`，`lagPair :64-73`）
- RankIC = 先 `averageRanks`（**并列取平均秩**）再 Pearson（`:41-62`）
- 分层：按因子升序、`bucketSize = ceil(n/q)`、每桶记**前向收益均值 + 样本数**，多空 = `Q_last − Q_first`（`:101-114`）；换手率用全局桶边界 + 相邻期分组变化算（`:115-136`）
- 独立的 IC 衰减工具：`IC(h) = corr(factor[i], Σ returns[i+1..i+h])`，`halfLife` = 首个 IC ≤ peak/2 的 h，`bestHorizon` = IC > peak/2 的最长 h，再由 halfLife 反推信号类型（`lib/dsh-alpha/decay.js:41,52-92`）

**② 回测是「每根 bar 一个 for 循环 + 待成交状态机」，不是向量化（实测）**
`lib/dsh-ml/backtest.js:45-104`：`pendingEntry / pendingExit` 两个挂单槽，让第 `i` 根 bar 产生的信号在 **第 `i+1` 根**成交（`:47-52`），现金按 `cash *= 1 - feeRate` 连乘、归一化到 1，只做多、全仓。5 套策略：均线交叉、网格、布林、RSI、组合再平衡。
→ 这个「挂单槽」写法是**杜绝未来函数的极简手段**，比事后审计信号时间戳可靠得多。**注意：没有印花税、没有最小变动单位/T+1/涨跌停/融券**（`grep 印花|stamp` 在 `lib/`、`mcp/`、README 全为 0 命中），所以它的 A 股回测真实度约等于 0。

**③ 图表数据用可辨识联合（discriminated union）序列化（实测）**
`chartBacktest()` 返回 `{kind:'series', title, series:[{name:'equity', values}]}`；`chartCandles()` 返回 `{kind:'candles', candles, overlays, markers}`（`lib/dsh-execution/chart.js:11-37`）。渲染端只认 `kind`，与具体图表库解耦。
→ 对本仓库「曲线叠加」直接有用：先定 `kind` 协议，再选渲染器。
**但这里有个真 bug**：`chart.js:24-31` 花力气构造了 `markers`，返回对象 `:32-36` 却**没把它放进去**——止损/目标价标记永远到不了 UI（死代码）。

**④ 风险与期权/债券是标准公式，可当参考实现（实测）**
- VaR/CVaR **只有历史法**（没有参数法/EWMA）：`tailIdx = max(0, floor((1-conf)*n)-1)`，`varCut = -sorted[tailIdx]`，`cvar = -(r <= -varCut 的均值)`；置信度默认 0.95，**没有窗口参数**——传进来的数组长度就是窗口（`lib/dsh-risk/risk.js:14,19-23`）
- Beta/Alpha/IR/TE：`beta = cov/var(bench)`、`alpha = mean(r) - beta*mean(b)`、`TE = √var(excess)*√365*100`、`IR = mean(excess)/TE*√365`；无基准时全返回 0（`risk.js:43-67`）
- Kupiec POF 回测：`LR = -2[(n-x)ln((1-p)/(1-x/n)) + x·ln(p/(x/n))]`，χ²₁ 用 erf 实现，`LR <= 3.841` 通过（`risk.js:89-111`）。**但退化分支写坏了**：`x===0 ? false : false`，两个极端样本永远判失败，且 `lrStat` 返回 `Infinity`（`:103-106`）
- 债券：定期贴现定价、YTM 120 步二分、Macaulay/修正久期、凸性、`DV01 = modDur*price/1e4`（`bond.js:12-22,24-36,66-73`）
- 期权：Black-Scholes 欧式无股息连续复利，IV 用 200 步二分（区间 1e-6..5），greeks 里 **vega/rho 除以 100**（`options.js:32-38,40-52,74-84`）。没有美式/二叉树/波动率曲面
- 压力测试：6 个硬编码情景（−5/−10/−20/−30/−15/−12%），损失 `=|shock|*|beta| + 0.3*corr*|shock|*100`（`stress.js:13-18,55-58`）——那个 `0.3` 没有解释
- 基金净值模拟：NAV 从 1.00 起，日管理费 `rate/365`，20% 业绩报酬对高水位（`fund.js:5-8,20,35-37`）

### 风险 / 注意

- **包内没有测试和构建产物**：`tests/`、`scripts/`、`verify.ts`、`tsconfig.json` 在 tarball 里都不存在，但 `package.json:56-63` 把 `npm test`/`npm run build` 指向它们 → **从发布包跑这两个命令必然失败**。`eval/`、`benchmark/` 只有 README、没有测试代码。测试数量三处互相打架（README:74 说 215、benchmark/README:15 说 162+4、docs/ENVIRONMENT.md:39 说 50）。
- `skill/` 只有 markdown（2 个 SKILL.md），**没有 `ctx.skills` 注册**，所以它不是可加载的 skill bundle，是文档。
- 全套无缓存，每次调用都直连上游；6 个联网工具声明并发安全但无任何限流（`quant_repo_stats` 打未认证 GitHub API，限额 60 次/小时）。
- `resample` 是固定分桶 `{week:7, month:30}`（`resample.js:4`），遇节假日必错。
- 分层回测的层统计仍有前视：`layerMeanReturnPct` 用同一根 bar 的 `returns[start]` 对 `factor[start]` 求均值（`layered.js:75`）。
- 公式是**重新实现**而非拷贝（A&S 的 erf、Acklam 正态反函数、Bailey–López de Prado 的 deflated Sharpe、alphalens 式语义已在 `factor.js:2` 署名），故 MIT 复用无阻碍；唯一外部代码是 demo HTML 里从 CDN 加载的 lightweight-charts 4.2.0（Apache-2.0，未随包分发、也无署名文件）。

---

## 4. dsh-invest-bundle

- **仓库**：`github.com/woshipixiu1234/dsh-invest-bundle`｜`git log -1` = `e1ca2e5`（2026-10-20）｜**MIT**
- **版本**：**仓库 HEAD 是 0.2.0**，而社区市场页登记的是 v0.1.1。任务描述里的「22 技能 + 6 工具 + 12 脚本」对应 **v0.1.x**；**0.2.0 已变成 23 技能 + 10 工具 + 四大师并行 workflow + PDF 渲染管线**（`package.json` description 实测）。下表按 HEAD 记录并标注增量。
- **安装**：`dsh plugin --profile web add github:woshipixiu1234/dsh-invest-bundle`（市场页）；或桌面端「插件 → 发现」搜索安装（README:23-25）
- **运行时**：Python 3.10+（脚本**只用标准库**）；仅 `invest_chart` / `invest_report_pdf` 需要 `python-docx`、`matplotlib`（README:46）

### 功能清单（实测）

| 工具 | 作用 | 位置 |
|---|---|---|
| `invest_search` | 多级降级检索 | `index.js:78` / `lib/search.js` |
| `invest_fetch` | 抓正文，失败升级 r.jina.ai | `index.js:124` / `lib/fetch-page.js` |
| `invest_audit` | 五维来源可信度打分 | `index.js:153` / `lib/audit.js` |
| `invest_verify` | 覆盖率式断言核验 | `index.js:219` / `lib/verify.js` |
| `invest_rigor` | 白名单 Python 数值严谨工具 | `index.js:280` / `lib/rigor.js` |
| `invest_channels` | 13 行通道体检表 | `index.js:318` / `lib/channels.js` |
| `invest_chart` / `invest_report_pdf` / `invest_pdf_check` / `invest_workflow` | **0.2.0 新增**：图表、PDF、交付校验、四大师 workflow | `index.js:347/389/453/497`、`workflows/four-masters.js` |
| 23 个改造自 ai-berkshire 的投研技能 | 方法论 SOP | `skills/`（24 项，去掉 `UPSTREAM-NOTICE.md`） |
| 12 个 Python 脚本 | 市值验算/交叉验证/三情景/Benford/十年 IRR/抽检 | `tools/*.py` ×12（另 `tools/report/` 下 3 个 PDF 专用） |

### 最值得借鉴的机制

**① 五维来源打分 = 可解释的规则表，不是黑盒（实测）**
`DIMS = ['authority','firsthand','verifiable','freshness','bias']`（`lib/audit.js:86`），每维 1–4 分，总 20 分。打分靠**域名分档 + 文本特征**，且每维都留 `reason`：authority 按 `.gov/.edu`→4、主流财经通讯社→3、公司 IR→3、聚合/自媒体/论坛→2（`:101-116`）；bias 用「煽动/夸张用语命中次数」倒扣（`:173-179`）。
判定线：`score >= 17` → `trust`（🟢），`>= 11` → `caution`（🟡），否则 `discard`（🔴）（`:191-198`）。**17/20=85%、11/20=55%**，且只让 🟢/🟡 进正文（`skills/invest/SKILL.md:44`）。

**② 断言核验 = 覆盖率加权 + 5% 冲突判据（实测，公式清晰可抄）**
`combined = numericCoverage × 0.7 + max(phraseCoverage, laxCoverage) × 0.3`（`lib/verify.js:134`）。
「本条来源支持这个断言」要同时满足：`combined >= 0.6` **且** 数字覆盖 `>= 0.5` **且** 短语覆盖 `>= 0.3`（`:137-138`）。
冲突检测：同一单位下两源相对偏差 `> 0.05` 即记冲突（`:100`），每个来源最多留 3 条冲突（`:164`）。
裁决：**≥2 个独立来源支持且无冲突 → `verified`**；1 个 → `weak`；有冲突 → `contradicted`（`:169-174`）。
它自己承认边界：「按覆盖率打分的**仍然是启发式，不等于事实核查**」（`:190`）——这种自陈局限的写法值得学。

**③ 数值严谨工具走白名单 + execFile 无 shell + 参数消毒（实测）**
`WHITELIST` 9 个脚本（`lib/rigor.js:7-15`），`star_history_chart.py` 故意不在白名单。执行 `execFile(python, [scriptPath, ...args])`（`:93`），不拼 shell；参数逐个校验：长度 > 4000 拒、含控制字符 `[\u0000-\u0008\u000b\u000c\u000e-\u001f]` 拒（`:88-89`）；环境强制 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`（`:35`）。错误分类：`/No module named/` → 提示补依赖，并特别说明「`financial_rigor.py` 只用标准库，不应出现该错误」（`:106`）。

**④ 准出闸门是「抽检 15% + 一条不过就打回」（实测）**
`tools/report_audit.py:246` 的 `sample_points(ratio=0.15)` 从报告里随机抽 15% 数据点（可传 seed 复现），逐个与信源比对；`fail_count == 0` 才准出，否则打印【打回】并要求修正后重审（`:383-390`）。容忍度 `_TOLERANCE` 控制单点通过/警告/不通过。
配套 `financial_rigor.py` 六个子命令：`verify-market-cap`（市值=股价×总股本）、`verify-valuation`、`cross-validate`、`benford`、`calc`（Decimal 28 位、ROUND_HALF_EVEN，`:33`）、`three-scenario`（`:396-427`）。Benford 明确写「样本 <50 不可靠」（`:245`）。

**⑤ 「8 条否决红线」是提示词纪律，不是代码闸门（实测，须澄清）**
红线清单在 `skills/investment-checklist/SKILL.md:208-219`：说不清怎么赚钱 / 连续 3 年 FCF 为负且无改善 / 管理层诚信污点 / 竞争优势被不可逆侵蚀 / 博傻 / 无法承受归零 / 理由只是「别人都在买」 / 无法用 200 字写清买入理由。
但它是 **SKILL.md 里的自然语言 checklist**，代码层没有任何 `if` 拦它。真正被代码强制的只有：`invest_audit` 的分数、`invest_verify` 的裁决、`report_audit.py` 的打回、`invest_rigor` 的白名单。→ **不要把「红线」当成已实现的风控闸门**。

### 风险 / 注意

- **版本漂移**：市场页 v0.1.1 vs 仓库 v0.2.0，工具数 6→10、技能 22→23。引用时务必写清版本。
- `skills/` 是 MIT 下**改造自 ai-berkshire** 的产物，`NOTICE.md`（6.9 KB）与 `tools/UPSTREAM-NOTICE.md` 保留了上游署名——**再分发必须保留**。
- 检索通道多数需 Key（Tavily/Exa）；无 Key 时降级到 DDG/Bing，`degraded=true` 必须在报告里显式标注（`SKILL.md:60`）。
- 通道体检 13 行里多行是 `needs-login`（论坛 Cookie 等），**不是开箱全绿**（`lib/channels.js:119-136`）。

---

## 5. dsh-invest-research

- **仓库**：`github.com/lobster-liu/dsh-invest-research`｜`git log -1` = `2080815` v0.3.1（2026-10-17）｜**MIT**（LICENSE 写 "dsh-stock-research contributors"）
- **同名干扰**：`eclipti/dsh-invest-research@0.1.0` 是**另一个项目**（A 股全链条 + 巴菲特价值打分 + 风险雷达），不在本清单描述范围内。本清单指的是 lobster-liu 版（6 角色/7 角色/双盲/三轮审计）。
- **安装**：`dsh plugin --profile <profile> add github:lobster-liu/dsh-invest-research`
- **形态**：**纯 skill bundle**，零运行依赖（`lib/index.js` 仅 31 行 + `lib/skill.js` 167 行），全部逻辑在 SKILL.md/roles 提示词 + 4 个 Python 脚本里。

### 功能清单（实测）

| 功能 | 位置 |
|---|---|
| `stock-research`：6 角色 A 股流水线 | `assets/skills/stock-research/SKILL.md`、`roles/{orchestrator,data,policy,valuation,risk,auditor}.md` |
| `fund-research`：7 角色基金穿透 + 10 章报告 | `assets/skills/fund-research/SKILL.md`、`roles/` ×7 |
| 双盲隔离（估值↔风控互不可见） | `stock-research/SKILL.md:29`、`roles/auditor.md` E 项 |
| 三轮审计（数据后/风控后/可选终审） | `stock-research/SKILL.md:28`、`:55-76` |
| 每数字带【来源｜日期｜口径｜类型】 | `stock-research/SKILL.md:26`；`fund-research/SKILL.md` description |
| 落盘前 PII 门禁（退出码即闸门） | `tools/sanitize_check.py`、`stock-research/SKILL.md:83-90` |
| 审计员 A–G 七类只读核对清单 | `roles/auditor.md` |
| 反方审查「定向补证一次」 | `fund-research/SKILL.md:85-88` |

### 最值得借鉴的机制

**① 双盲隔离靠「喂什么」实现，而不是靠模型自觉（实测）**
隔离的落地方式是**派发子代理时控制输入**：阶段三估值员只喂审计通过的数据；阶段四风控员只喂 `data.json + policy.md`，SKILL.md 里明写「**明确禁止读取 valuation.md**」（`stock-research/SKILL.md:70-72`）。审计员再回来验这条：E 项要求核对「风控员是否**未引用**估值员的目标价 / 估值员是否**未引用**风控员结论」（`roles/auditor.md` E）。
→ 关键洞察：多智能体「独立性」不是靠 prompt 说「请独立判断」，而是**在构造输入时物理隔断**，并在审计阶段把隔离性当成可检查项。

**② 审计员是纯只读闸门，输出只有两种（实测）**
`roles/auditor.md` 铁律：无权修改（只能退回）、不联网（只用手上材料）、**逐条核对不抽样**、输出只有 `PASS` 或 `FAIL + 问题清单`。清单 A–G：
A 来源完整性（每个数字有【来源｜日期】？来源是具体接口/机构还是「网络」）、
B 时效性（行情 ≤1 交易日 / 月度 ≤45 天 / 政策 ≤12 个月 / 逾期须标 `stale=true` 并披露）、
C 口径一致性（累计 vs 单月、同比 vs 环比、预售 vs 网签、区间 vs 时点）、
D 算术一致性（加权总分重算一遍）、
E 隔离性、F 脱敏、G **数据源正确性**。
G 是 2026-10-15 真实事故后加的**阻断级**项：每个数字必须能在本次 run 的 `data.json` 里找到，找不到即判「无来源」，直接 FAIL；且样本窗口要与引用的分位口径一致（说「800 日分位」而 data.json 是 1300 日 → 阻断）（`roles/auditor.md` G 项）。

**③ 脱敏门禁 = 退出码契约 + 「失败即拒绝 + 输出脱敏」（实测）**
`sanitize_check.py` 两道检查：A 复用外部 `audit-secrets.py`（28 条规则 + 高熵兜底，可用 `EQUITY_SECRET_SCANNER` 指向，缺失则显式记 `skipped` 而非静默通过）；B 本项目自己的行情 PII 规则（个人持仓、成本价、资金规模、账号）。
退出码即语义：`0` 通过可落盘 / `1` 有敏感内容禁止落盘 / `2` 用法错误（文件头 docstring）。三条设计原则写得很硬：**失败即拒绝**、**输出脱敏**（只显示前 4 + 后 2 + 长度，绝不把明文写进终端或报告）、**零误报可调**（`--strict` 下 MEDIUM 也拦）。
它还带了门禁自检 `test_gate.py`：**3 类断言 —— 真泄漏必拦 / 政策财报条款必放 / 混合陷阱必拦**（`SKILL.md:118-121`）。→ **给规则引擎写「必须拦 + 必须放」双向测试**，这条做法比规则本身更值得抄。

**④ 「单一数据源锁定」+ run 目录秒级命名（实测）**
每个 run 落到 `<工作区>/equity-runs/<标的>-<yyyyMMdd-HHmmss>/`（秒级避免并发撞号），一次运行只认本次 `data.json`，任何角色不得改读其他 run、`smoke*`、`_` 开头目录（`stock-research/SKILL.md:30`）；失败脚本**退出码 1 且禁止带空数据继续**（`:57`）。这条直接对应本仓库「缺失分上游无此数据 vs 本次失败」的诉求。

**⑤ 模型分档做成本优化（实测）**
数据员/政策员用「便宜快速」档；估值/风控/审计/协调用「强推理」档（`stock-research/SKILL.md:92-97`）。多智能体流水线最容易忽略的成本项，它显式列了表。

### 风险 / 注意

- **大量依赖 Windows**：`run_pipeline.ps1`、`install_akshare.ps1`、`%DSH_HOME%\dsh-runtimes\...\python.exe` 路径解析（`SKILL.md:17-22`、`:103-110`）。Linux/macOS 需自行替换。
- 明确记录**内置 `web_search` 在多数环境不可用**（`WEB_PROVIDER_CREDENTIAL_MISSING`），改走 `web_call` 的 `read.fetch`/`search.run`，并说 `search.run` 对 `site:pbc.gov.cn` 之类硬约束 0 结果、其「needs covered N/N」是**启发式假阳性**（`SKILL.md:99-104`）——这类「工具不可靠性台账」写法值得学。
- akshare 已移除银行监管指标接口（不良率/拨备覆盖率/资本充足率），相关字段只能落「数据缺口」（`SKILL.md:113-114`）。
- 是 skill bundle，**没有工具注册**：能力全部靠提示词 + 脚本，模型不听话就失效，无代码层强制。

---

## 6. Capital Generation

- **包**：npm `@v587d/capital-generation@2.9.0`｜作者 v587d｜**MIT**
- **安装**：`dsh plugin --profile web add @v587d/capital-generation`（或 `github:v587d/capital-generation`，README:46-50）。装完在**新会话的模式选择器**里多出「自动模式 / 行情专家 / 资讯专员」三项（README:29,190）
- **形态**：DSH bundle + **Agent Preset**（`preset/capital-generation/agent.patch.yml`）+ 5 条 host-plane 插件行（`cordis.patch.yml:27-71`：`capital-config` / `capital-charts` / `capital-watchlist` / `capital-runtime` / `capital-policy`）+ web 卡片
- **运行时**：**零 Python、零 CLI、零浏览器自动化**（`grep python lib/` = 0 命中；OCR 走 HTTP）。`package.json` **无 `engines` 字段**，但代码用 `process.getBuiltinModule`（5 个文件）与 `AbortSignal.timeout` → 实际需 Node ≥ 20.16/22.3
- **体量**：7.6 MB / 734 文件，其中 **4.6 MB 是 8 个社区技能仓的快照**

### 功能清单（实测）

| 表面 | 内容 | 位置 |
|---|---|---|
| 5 个 preset | 自动模式（根，order −3）、行情专家（−2）、资讯专员（−1）、分析师（5）、绘图专员（6）；`data_analyst`/Python **`disabled: true`** | `preset/capital-generation/agent.patch.yml:486-492`, `15-114`, `298-391`, `116-240`, `242-296`, `394-396` |
| 系统提示注入 | 根 persona 是一段 **约 110 行 YAML `prefix:` 字面块** | `agent.patch.yml:497-608`；注册见 `lib/index.js:93,149-154` |
| 工具（约 30 个） | 采集 4（`request_data`/`list_capabilities`/`describe_capability`/`dc_status`）、数据集 5、检索 14、图表 2、时间 2、自选 1 | `data-collector/tools.js:116-209`、`dataset-tools.js:329-375`、`web-retriever/tools.js:122-976`、`chart/tool.js:252`、`time/tools.js:190,410`、`watchlist/tools.js:46` |
| 内置技能 | **11 个**（`capital-{chart-protocol,data-profile,data-protocol,data-query,equity-research,event-impact,orchestration,portfolio-review,visualization-protocol,web-evidence,web-protocol}`） | `preset/capital-generation/skills/*/SKILL.md` |
| 社区技能 | **68 个**，8 个快照仓（1/6/28/1/11/12/8/1），**默认全关**、只给根 Agent | `selected-skills/catalog.js:5-28`、`agents/selected-skills-provider.js:99-146` |
| 图表 UI | `chart-ui/` 嵌套包，React + `lightweight-charts`，挂 `tool.call.toolview['render_chart']` | `chart-ui/client.src.cjs:7-11,29-49`；host 路由 `chart-ui/index.js:8,20-57` |
| 自选面板 | host 侧真功能：存储域 `capital_watchlist`、HTTP 路由带鉴权、30 项上限、置顶 + 持仓权重、7 个报价组、120 s 刷新预算；**挂在 `conversation.input.overlay`（输入框弹层，不是侧边栏）** | `watchlist/index.js:24,72-84,116-121,184-194,598-650,750-843,934-1074`；`watchlist/client.src.cjs:18` |
| 密钥 | 5 把：`FUYAO_API_KEY` / `FTSHARE_API_KEY` / `WIND_API_KEY` / `ANYSEARCH_API_KEY` / `PADDLE_OCR_TOKEN` | `lib/index.js:56-69`、`config/index.js:14-90` |

### 最值得借鉴的机制

**① 「可插拔数据源」是真的，但**不是**可替换（实测，这是本节最重要的澄清）**
它有真实的数据源抽象：`DataSource = { schema, execute(req,signal), validateOutput?, normalizeParams? }`，`SchemaDescriptor` 里 `capability` 是**模型可见的唯一键**，`data_key`/`source`/`source_label` 只给 host（`data-collector/hub.d.ts:17-36,49-62`）。
但注册处（`hub.js:162-178`，我方已复核）对 `capability` **和** `data_key` **都**做了唯一性硬拦：

```js
if (this.sources.has(capability)) throw new Error(`data source capability already registered: ${capability}`);
for (const other of this.sources.values())
  if (other.schema.data_key === source.schema.data_key) throw new Error(...);
```

运行时分发就是一次精确 `Map.get(capability)`（`hub.js:228`），**没有优先级列表、没有 fallback 链、没有 capability 矩阵、没有按源开关**。`grep fallback|priority lib/` 只命中「凭据先取 DSH 再取 env」这类无关语义。
→ 结论：**「插拔」= 你可以新增一个能力，但同一个能力只能有一个源**。README:78 说 FTShare 是「第二家上游口径」，那是**并行能力**，不是自动容错——没有任何代码会在 Fuyao 失败时改走 FTShare。
四个厂商（同花顺 Fuyao REST 61 能力 / FTShare REST 34 / Wind MCP 3+2 / AnySearch 2）**全部真实实现**，无桩；「Wind Alice」只是 Wind MCP（`mcp.wind.com.cn`）的品牌名。
风险很实在：**128 个能力里有 61 个（48%）挂在一把 Fuyao 密钥上**，丢 key 就等于丢 A 股行情+财务+基金+涨停池。

**② 能力的「目录 / 引用」二级间接，避免把 128 份 schema 塞进上下文（实测）**
`list_capabilities` 只输出文本行 `capability | summary | paginated`（`hub.js:11-28,259+`），要 schema 再逐个 `describe_capability`；`request_data` **只返回 `DatasetRef` 元数据**，真正的数据集是不可变的、落盘后按需 `query_dataset`/`inspect_dataset` 读。
配套的去重很讲究：参数归一化后算 SHA-256 `params_digest`（`hub.js:110-123`）→ 同一摘要的在飞请求合并（`:125-127`）→ 命中已有 manifest 就复用，复用窗口由**每个能力自己的** `cacheMaxAgeMs` 决定（`:195-218`）。
→ 这套「目录瘦、schema 按需、数据集引用化」是**大工具面插件控制上下文的正确姿势**，比一次把 59 个工具描述全塞进 system prompt 聪明。

**③ 注册是结构性的，凭据每次调用现取（实测）**
`collector-runtime.js:49-87` 用 5 个 `ctx.effect` 块注册，注释写得很直白：「注册是结构性的，凭据每次调用现取」。解析顺序统一为 **DSH 凭据服务 → `process.env[ref]`**（`fuyao-rest.js:1968-1977` 等），且 **绝不因缺 key 而跳过注册**；`dc_status` 只暴露「有没有」，从不返回值（`data-collector/tools.js:99`）。
→ 与 skills-stock 的 `secrets.env` 是两条不同路线：这里走宿主凭据服务，更干净，**推荐本仓库用这条**。

**④ 角色隔离靠 preset-id 白名单 + 名字拒绝，而不是靠提示词（实测）**
`authorizedSession(ctx, exec, 'request_data', DATA_COLLECTION_PRESET_IDS)`（`data-collector/tools.js:123`）——只有 `capital-data-collector` 这个 preset 能调 `request_data`；根 Agent 被 `root-tool-policy.js:41-49` 按名字 deny。图表/检索的额度也由 host 侧 policy 行（`lib/policy-entry.js:12-22`）控制。
→ 这比 invest-research 的「提示词约束」硬，但要注意：**手动打开的角色会话仍然拿得到它的工具**，所以这是「模式级」而非「人级」隔离。

**⑤ 图表交付走事件，不走回合尾巴（实测）**
`deliverables/presented` 自定义事件（`chart/events.js:5,9`）触发宿主呈现，图表 HTML 落在 `capital-analysis/charts`（`chart/tool.d.ts:22`）。图表规格限制了 `line|area|column|candlestick|bar`、≤6 条序列、≤50 个 marker（`chart/spec.d.ts:1,46-47`）——**明确的上限就是安全边界**。它把 198 KB 的 lightweight-charts **内联进单文件 HTML**（`lib/chart/html.js:1-36`，vendor 版本带 `VERSION.json` 的 sha256）。

### 风险 / 注意

- **`disabled: true` 的 preset 要当不存在**：`data_analyst` 自带注释「Python runner 与 coding tools（当前均未实现）」（`agent.patch.yml:394-410`）；Wind 的 `analytics_data` 服务端文档注明不可用（`wind-client.d.ts:9-11`，initialize 会挂起）。
- **无锁竞争**：自选写盘只在进程内加锁，没有跨进程锁（`watchlist/index.js:396-398`），两个 DSH 进程会抢同一行。
- **免密钥源是爬公开端点**，代码注释自己记了漂移史：巨潮要 POST（GET 返 405）、港股代码要补零、美股快照拒绝带后缀的 ticker（`sources.d.ts:53-55`、`tencent-public-core.d.ts:21-24`）。
- **许可**：自有代码 MIT，但 `THIRD_PARTY_NOTICES.md`（20 KB）声明了 **vendored Lightweight Charts 5.2.1（Apache-2.0，保留署名）**、8 个技能快照（7 MIT + **`claude-for-financial-services-cn` 是 Apache-2.0，需满足 §4(b) 通知义务**）、1 个 BSD-2 传递依赖（`@mixmark-io/domino`）。**若要再分发其技能快照，必须照抄 NOTICE。**
- **peer 钉死 rc 版本**：`dsh-skill` / `dsh-skill-filesystem` 都精确钉在 `0.2.1-rc.2`（`package.json:140-144`），与本仓库 v0.119.0 不同代。

---

## 7. 横向对比：对 dsh-tradewatcher 最有价值的可复用点

| 需求 | 现成实现 | 出处 |
|---|---|---|
| 每个读数带出处、缺失分两类 | `ProviderMeta` 五元组 + `cacheState` 四态 | Hanai `contracts/src/index.ts:6-14` |
| 多源降级且不丢元信息 | 部分补齐 + 合并 meta | Hanai `providers/index.ts:236-253` |
| 请求去重 / 退避 / 陈旧值 | `ProviderCache` 43 行 | Hanai `providers/cache.ts` |
| 报告状态链 + 一次性自动修复 | verifying→repairing（预算 1 次） | Hanai `host/src/service.ts:748-782` |
| 报告不可变 + 防半写 | staging + rename + manifest sha256 + 幂等比对 | Hanai `domain/src/reports.ts:81-187` |
| 失败不毁旧成果 | `latestReportVersion === null ? failed : ready` | Hanai `service.ts:790` |
| 归一化曲线叠加 | 首值归一 + 共同 y 域 + 手写 polyline | skills-stock `client.js:215-295` |
| 安全渲染 HTML 报告 | `iframe srcDoc sandbox=""` | skills-stock `client.js:824-829` |
| 密钥不进环境变量 | `secrets.env` + 0600 + 同命令 source | skills-stock `index.js:371,466` |
| 工具集参数化 | kind 工厂产出 5 工具 × N 库 | skills-stock `index.js:836-985` |
| 来源可信度可解释打分 | 五维 1–4 分，17/11 分档 | invest-bundle `lib/audit.js:86,191` |
| 断言核验公式 | 0.7/0.3 覆盖 + 5% 冲突 + 2 源门槛 | invest-bundle `lib/verify.js:134-174` |
| 子进程执行白名单 | execFile 无 shell + 参数消毒 | invest-bundle `lib/rigor.js:7-15,88-93` |
| 交付抽检闸门 | 随机 15% + 一条不过打回 | invest-bundle `tools/report_audit.py:246,383` |
| 多智能体独立性 | 构造输入时物理隔断 + 审计验隔离 | invest-research `stock-research/SKILL.md:70-72` |
| 落盘前 PII 门禁 | 退出码契约 + 双向测试（必拦/必放） | invest-research `tools/sanitize_check.py`、`test_gate.py` |
| 信号有效性自证 | 聚类 bootstrap + Holm + 匹配对照 + 预注册 | Hanai `scripts/research/` |
| 无未来函数的回测循环 | `pendingEntry/pendingExit` 挂单槽（i 信号 i+1 成交） | dsh-quant `lib/dsh-ml/backtest.js:45-104` |
| 图表数据协议 | `{kind:'series'\|'candles', ...}` 可辨识联合 | dsh-quant `lib/dsh-execution/chart.js:11-37` |
| 因子评价数学 | Pearson IC / 平均秩 Spearman / ceil 分桶 / IC 半衰期 | dsh-quant `factor.js:16-136`、`decay.js:41-92` |
| 大工具面控上下文 | 能力目录（文本行）→ 按需 describe → DatasetRef 引用化 | Capital `hub.js:11-28,183-231` |
| 凭据解析顺序 | DSH 凭据服务 → `process.env[ref]`，注册不因缺 key 跳过 | Capital `fuyao-rest.js:1968-1977` |
| 角色级工具隔离 | preset-id 白名单 + 名字 deny | Capital `data-collector/tools.js:123` |

### 三条「别照抄」的反面教材

| 宣称 | 实测 | 出处 |
|---|---|---|
| dsh-quant「三所行情自动容错」 | A 股**完全无**容错（sina/tencent 直接短路），加密币也只有一条路径且共用一个 20 s 超时预算 | `pipeline.js:13-28`；`lib/index.js:2955` |
| dsh-quant「A股 8 渠道知识库」 | 硬编码 15 条数组 + `String.includes`，无语料/无向量/无索引 | `data-guide.js:10,200-220` |
| Capital「可插拔数据源」 | 能力名 + `data_key` 双向唯一硬拦，精确 `Map.get`，无优先级/无 fallback/无开关 | `hub.js:162-178,228` |

---

## 8. 未确认 / 需注意

**已澄清（原为待确认项）：**
1. **dsh-quant 工具数 = 59**（我方复核 `grep -c "ctx.tools.register(defineTool" lib/index.js` = 59；`mcp/tools.json` 的 46 是 2026-08-17 的过期快照）。「46 工具」是包描述、`package.json` 与 CLI 里未更新的旧数字。
2. **Capital Generation 四个厂商数据源全部真实实现**（Fuyao 61 / FTShare 34 / Wind MCP 3+2 / AnySearch 2），无桩；「Wind Alice」是 Wind MCP 的品牌名。但**没有 fallback 链**（见 §6）。

**仍属未确认 / 判断性结论：**
3. **Hanai 能否在本仓库直接复用：不能。** peerDependencies 逐个钉死 DSH `0.2.1-rc.2`（15 个 `@deepseek-ai/*`），本仓库 v0.119.0 不同代，`slots`/`sessions` 等注入面已变。
4. **dsh-invest-bundle 的「8 条否决红线」不是代码闸门**——它在 SKILL.md 里是自然语言 checklist，代码层没有 `if` 拦截。真正被强制的只有 `invest_audit` 分数、`invest_verify` 裁决、`report_audit.py` 抽检打回、`invest_rigor` 白名单。
5. **dsh-invest-research 无代码级能力约束**：纯 skill bundle（`lib/index.js` 仅 31 行），模型不照 SKILL.md 执行就失效；其隔离/审计/脱敏全部依赖提示词 + 4 个 Python 脚本，其中门禁脚本（退出码）是唯一硬约束。
6. **dsh-quant 与 Capital 的量化结论未经独立复算**：本文只核对了它们的**代码路径与公式写法**，未用其输出与第三方数据对账；§3/§6 中标数值（如 128 能力、61 能力挂 Fuyao、59 工具）来自代码/注册表统计，非运行验证。
7. **各项目的「实测」由两份子代理深度核读 + 我方关键点抽样复核**：已亲自复核的点为 quant 的 59 工具/无印花税/A 股短路容错，Capital 的 `Map.get` 分发/双唯一性硬拦/无 fallback。其余细节为子代理读码结论，抽查未发现与代码矛盾之处。

**边界声明：** 所有项目均为第三方代码，本次**只读、零安装、零写入 profile、零重启**；`/tmp/week-*` 为一次性副本，未进入本仓库。本文记录机制与出处，不搬运代码。
