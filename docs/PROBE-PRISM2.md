# PROBE-PRISM2 — 棱镜（agent 模拟盘）四项技术侦察

- 侦察对象：`dsh-tradewatcher` HEAD `6b00de3` / `v0.129.1`（2026-10-22 15:07）
- DSH 实现：`@deepseek-ai/dsh@0.2.1-alpha.1`（`/home/hu/.nvm/versions/node/v24.16.0/lib/node_modules/@deepseek-ai/dsh`）
- 性质：**只读侦察**。未改仓库源码、未安装、未 commit、未动 profile、未重启 `dsh web`。
- 标注约定：**【实测】**＝本次本机跑出来的；**【文档声明】**＝类型声明/README/官方文档写明但本次未跑；**【未确认】**＝没验证到。

## 0. 一行结论

| 项 | 结论 | 一句话 |
|---|---|---|
| **A 插件调模型** | **可行** | `ctx.llm.stream()`（无 agent）与 `ctx.agentLoop.createAgent()`+`agent.followup()`（全 agent+工具）两条路都在宿主服务表里；**定时器里能自主发起模型调用** |
| **B 新闻源** | **部分** | 金十 `flash-api` 无签名可取（需两个客户端标识 header）；财联社**必须签名**，`errno 10012`，页面无 SSR 兜底 ⇒ 不可直接取 |
| **C Material Design** | **部分** | elevation / state layer 纯 CSS 直接可做；ripple 需极少量 JS（非库），且要绕开「关键帧只许 transform/opacity」；typography 只能采纳 MD 低端子集 |
| **D 定时器** | **可行** | 现有 `setInterval`+`unref`+`NODE_TEST_CONTEXT` 可扩展；但「每交易日按自定义时点」更贴合的做法是宿主自带 `ctx.schedule`（cron+时区，投递时 `agent.followup()` 唤醒 agent） |

## 1. 方法与请求配额（B 的纪律）

按仓库自己的规矩办：`src/host/robotsGate.ts:1-12` 写明两条硬纪律——① 先取 `robots.txt`，`Disallow` 路径零请求；② 同一主机 ≤5 次/小时（`HOST_BUDGET_MAX = 5`，`src/host/robotsGate.ts:21`）。本次实测计数：

| 主机 | 次数 | 用途 |
|---|---|---|
| `www.jin10.com` | 1 | `robots.txt` |
| `flash-api.jin10.com` | 5（达上限） | `robots.txt` / 裸调 ×2 / 带头 ×1 / `max_time` ×1 |
| `api.jin10.com` | 1 | `robots.txt`（SSL 失败） |
| `www.cls.cn` | 4 | `robots.txt` / `nodeapi` / `v1` / `/telegraph` 页 |

`robotsGate.ts:8` 的口径也照抄：**robots 取不到（404/网络失败）⇒ 视为「无声明限制」，但必须记进结果，不假装读过规则。**

---

## 2. A — 插件能否调用模型 / 子智能体（决定性）

### 2.1 结论

**能。而且不只有一条路。插件可以在定时器回调里自主发起一次模型调用，不需要任何人类会话在跑。**

### 2.2 证据：宿主服务表里有什么（【实测】cordis_inspect_query host/Service/listService）

活宿主的 Service 目录里同时存在这些键：

`llm`、`agentLoop`、`agents`、`agentPresets`、`subagents`、`agentTeams`、`agentDefaultModel`、`subagentModelSelection`、`schedule`、`timer`、`sessionProjections`、`sessions`、`storage`、`tools`、`systemPrompt`。

这本身就是证据：该目录是**活宿主**的发现结果，所以这些服务在当前 profile 里**已挂载**。

### 2.3 路径一：`ctx.llm.stream()` —— 一次性模型调用，不需要 agent

| 事实 | 出处 |
|---|---|
| 服务 `llm`：「an adapter registry plus a **streaming model-call API**, interceptable via the `llm/stream` waterfall」 | inspect `Service` = `llm` |
| 方法 `stream(options: GenerateOptions): AsyncIterable<StreamChunk>` | 同上 |
| `GenerateOptions` 结构 | `dsh-llm/lib/types/types.d.ts:489` |
| `provider: string` / `model: string` / `messages: RequestMessage[]` | `types.d.ts:491,492,501` |
| `system?: string`，注释原文「System prompt text for **one-shot callers**」 | `types.d.ts:506`（注释 `:502-505`） |
| `tools?: ToolSchema[]` | `types.d.ts:507` |
| `purpose?: 'compaction' | 'session-title'`，注释原文「**Ordinary conversation requests leave it unset.**」 | `types.d.ts:530`（注释 `:527-529`） |
| `sessionId?:` 可选 | `types.d.ts`（`GenerateOptions` 内，非必填） |

关键点：`purpose` **是可选字段**，且文档明确说普通对话请求不用设它 —— 所以「插件发起一次非 compaction/非 session-title 的模型调用」是这条 API 设计里被允许的用法，不是钻空子。

**没有 initiator 门禁**（【实测】）：

```
$ grep -c "initiator" dsh-llm/lib/index.js
0
```

对比：`requireInitiator()` 只出现在 agent 侧和工具执行侧 —— `dsh-agent/lib/index.js:380`（定义）、`dsh-agent-loop/lib/index.js:507`（`executeToolCalls` 里取发起者）、`:552`（`runGroup`）。也就是说「工具执行必须有一个发起 agent」是工具流水线的约束，**不是 `llm.stream` 的约束**。

### 2.4 路径二：`ctx.agentLoop.createAgent()` + `agent.followup()` —— 完整 agent（带工具）

| 事实 | 出处 |
|---|---|
| 服务 `agentLoop`：「**Concrete agent factory and driver service**」 | inspect `Service` = `agentLoop` |
| `createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>`，`ownerCtx` =「caller context that structurally owns the lifecycle」 | 同上 |
| `AgentHandle { agent: Agent; dispose(): Promise<void> }` | inspect `referencedTypes` |
| `CreateAgentOptions`：`sessionId`、`parentAgent?`、`meta?`（含 `agentPreset?`、`origin?: 'subagent'`、`delegationDepth?`）、`seed?`、`agentOptions?`、`signal?`、`setup?: AgentSetup` | inspect `referencedTypes` |
| `AgentOptions { provider?, model?, reasoningEffort?, maxTokens? }` | inspect `referencedTypes` |
| **`followup(message: UserMessage): void`** —— 注释原文「Queue an ordinary follow-up turn and **wake the driver**. The item becomes the sole ordinary message of its own turn.」 | `dsh-agent/lib/types/runtime-types.d.ts:192` |
| `inject(message: UserMessage): void` —— 注释原文「Queue model-facing context … **without waking the driver**」 | `runtime-types.d.ts:209` |
| `whenIdle(): Promise<void>`「Resolve after the current whole-agent activity reaches quiescence」 | `runtime-types.d.ts:164` |
| 插件实践文档：**「A timer that starts work calls `agent.followup()`, which wakes the agent; `agent.inject()` does not wake it」** | `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md`（Performance 段） |
| 该 agent 自己的工具调用没问题：`agent/created` 监听器里在 `agent.ctx` 上注册，`agent.whenIdle()` 勿在自己的 disposer 里 await | 同上（Stability 段） |

所以路子是：插件在某 context 下 `createAgent(myCtx, { sessionId, meta: { agentPreset }, agentOptions })` 拿到 `AgentHandle`，之后**每次时点到了就 `handle.agent.followup(userMessage)`** —— 这会真的开一个 turn、真的打模型、真的执行工具。

### 2.5 `inject` 方式（这次能不能用，取决于这一行）

inspect 给出的两种取法：

```js
// 硬依赖（服务缺失则插件不激活）
export const inject = ['webServer', 'webRuntime', 'llm', 'agentLoop']
// 用法：ctx.llm / ctx.agentLoop

// 可选（profile 没有该服务时插件照常活着）
const llm = ctx.get('llm')            // requiresUndefinedCheck: true
```

对 tradewatcher 的现状（【实测】仓库源码）：

```
src/index.ts:25  export const name = 'dsh-tradewatcher'
src/index.ts:28  export const inject = ['webServer', 'webRuntime']
```

即**当前只 inject 了两个服务**，要用 `llm`/`agentLoop`/`schedule` 必须加进这一行（或走 `ctx.get`）。而且仓库自己踩过坑并在注释里写死了：

> `src/index.ts:139-140` 「⚠ 真宿主的 `ctx` 是 Cordis 的 Proxy：**访问未 inject 的属性会直接抛**（`cannot get property "config" without inject`），所以 `?.` 救不了 —— 必须 try/catch。」

### 2.6 模型从哪来（当前 profile 有适配器）

- 默认模型选择服务：`agentDefaultModel.currentSelection(): ModelSelection`，`ModelSelection { provider: string; model: string; reasoningEffort?: ... }`（`dsh-agent/lib/types/model-selection.d.ts:16-22`）。
- 当前 profile 的 LLM 插件行（【实测】读 `~/.dsh/profiles/web/cordis.patch.yml`）：
  - `:13` `id: llm-pi-ai` → `@deepseek-ai/dsh-llm-pi-ai`
  - `:91` `id: llm-deepseek` → `@deepseek-ai/dsh-llm-deepseek-api-key`
- 兜底可读：`ctx.llm.listProviders()`（`@Remote`）确认哪条 provider 路由真的注册了适配器。

### 2.7 备选：走 HTTP？

宿主确实有 web server 与 Remote 网关（`webServer.register(route)`、`typertGateway.invoke/stream`、`dsh-api-session-controller` 等），但 `connection.authenticatedUrl(baseUrl)` 表明浏览器侧要带鉴权；本次**没有**验证出一条「本机 HTTP 一句话就能让 agent 跑一轮」的免鉴权接口。**不推荐**作为主路径：【未确认】，且绕过了插件自己的生命周期。

### 2.8 A 的明确判断

> **定时器里能否自主发起模型调用：能。**
>
> - **最小形态**：`ctx.llm.stream({ provider, model, messages })` —— 无需 agent、无需 session、无需 initiator。【文档声明 + 实测 grep 无门禁】
> - **棱镜需要的形态**：`ctx.agentLoop.createAgent(ctx, {...})` + `agent.followup(...)` —— 有会话日志、有工具、能被 `whenIdle()` 等待、`dispose()` 可回收。
> - **前置条件（缺一不可）**：① 把 `llm`/`agentLoop` 写进 `inject`（或 `ctx.get` + 判空）；② profile 里至少注册了一个 LLM 适配器（本 profile 有两条）；③ `schedule` 路线还需要一个合法 `SessionId`；④ 该 Agent 的组成要能看见 tradewatcher 的 tool（走 `meta.agentPreset`）。
> - **仍需注意**：插件里创建 agent 会**真的产生会话与 token 消耗**；`agent.followup()` 是「开新 turn」，不是「追加一行上下文」。

---

## 3. B — 新闻源（金十 + 财联社，24 小时内）

### 3.1 robots.txt（【实测】）

**金十 `www.jin10.com/robots.txt` → `HTTP 404`**

```
HTTP 404 size=784
<!DOCTYPE html> … <title>GO</title> … window.location.href='https://www.jin10.com/index.html';
```

404 ⇒ 站点未发布 robots 规则。按 `robotsGate.ts:8` 口径：**视为无声明限制，但记录「未读到规则」**，不假装读过。

**金十 `flash-api.jin10.com/robots.txt` → `HTTP 502`（0 字节）**；`api.jin10.com/robots.txt` → TLS 握手失败（`SSL_ERROR_SYSCALL`）。同上口径：无规则可读。

**财联社 `www.cls.cn/robots.txt` → `HTTP 200`，全文如下（517 字节）**

```
User-agent:*
Disallow: /hwwebscan_verify.html
Disallow: /Iy6GOsvTTa.txt
Disallow: /wb_82fb1c33119f7a95.txt
Disallow: .jpg$
Disallow: .jpeg$
Disallow: .gif$
Disallow: .png$
Disallow: .bmp$
Sitemap: https://www.cls.cn/map.xml
```

⇒ 财联社**只禁了 3 个具体文件与图片后缀**，API 路径没被禁。**零请求红线不触发。**

### 3.2 金十：可取（无签名）

**接口**：`GET https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=1&max_time=<YYYY-MM-DD HH:MM:SS>`

**头**（必须，见下）：

```
x-app-id: bVBF4FyRTn5NJF5n
x-version: 1.0.0
Referer: https://www.jin10.com/
```

| 观测 | 结果 |
|---|---|
| 裸调（无 `x-app-id`/`x-version`） | **`HTTP 502`，0 字节** —— 连测两次都一样 |
| 带头 | **`HTTP 200`，15949 字节**，JSON |
| 是否需要 `sign` / 加密参数 | **不需要**。无 cookie、无 token、无 sign 参与请求 |
| 是否需要用户密钥 | **不需要**。两个头是客户端标识常量，与账号无关 |

响应片段（前 200 字节量级）：

```json
{"status":200,"message":"OK","data":[{"channel":[3,4,5],"data":{"content":"【中方回应是否就中俄美会晤保持沟通】金十数据10月22日讯，…
```

**字段（【实测】离线解析已保存的 200 响应）**：

```
top keys:      status, message, data
item keys:     channel, data, extras, id, important, kinds, remark, tags, time, type, voice_status, voices
item.data keys: content, exclusive_to, pic, source, source_link, title
time 示例:      2026-10-22 15:17:21          （字符串，东八区墙上时间，可直接比大小/解析）
id 示例:        20261022151721377800
important:     0/1
channel:       [3,4,5]
```

- **时间过滤到 24 小时内：可以**。每条的 `time` 是 `YYYY-MM-DD HH:MM:SS`，客户端按字符串/时间戳过滤即可。
- **分页：可以，用 `max_time`**（【实测】传 `max_time=2026-10-22 15:00:00` 后返回的**最新**一条是 `14:57:53`，严格早于游标；该页 21 条）。
- **每页条数**：20-21 条。
- `title` 字段**不一定有**（该页 20 条里 0 条带 `title`）⇒ 标题要从 `content` 里的 `【…】` 提取。

**⚠ 24h 全量的真实成本（这条最容易被低估）**：

```
span(min): 34.5   items: 41   items/min: 1.19   -> 24h 估算 ~1712 条
=> 按 21 条/页 ≈ 81 次分页请求
```

也就是说**「每次研判都回溯 24 小时」在配额上不成立**（净请求数远超任何合理预算，也远超本仓库 5 次/小时的自我约束）。可行做法是**增量水位**：常态每 N 分钟拉 1 页，翻到 `lastSeenId` 为止；研判时读本地已落盘的那 24h。

### 3.3 财联社：不可直接取（需签名）

| 尝试 | 结果 |
|---|---|
| `GET https://www.cls.cn/nodeapi/telegraphList?app=CailianpressWeb&os=web&sv=8.4.6&rn=20` | **`HTTP 404`**（返回 9042 字节的 Next.js 404 页，不是 JSON） |
| `GET https://www.cls.cn/v1/roll/get_roll_list?app=CailianpressWeb&os=web&sv=8.4.6&rn=20&last_time=` | **`HTTP 200`，正文 `{"errno":"10012","msg":"签名错误"}`** |
| `GET https://www.cls.cn/telegraph`（HTML 兜底） | **`HTTP 200`，17889 字节**，但 `__NEXT_DATA__` 的 `props.pageProps` 只有 `{"initialState":{"chooseNav":"telegraph"}}`，**无任何新闻内容**；页面里搜不到任何 `2026-10-22 HH:MM` 时间戳 |

⇒ 财联社电报列表 **必须 `sign` 参数**（`errno 10012 签名错误`），且**没有**服务端渲染兜底。

**关于浏览器 cookie 的判断**：`sign` 不是 cookie 而是请求参数签名（由页面 JS 现算，通常是对排序后的 query 做哈希）。**带上浏览器 cookie 也不免签**；只有复用其前端 JS 的签名算法才行 —— 那属于绕过，**不尝试、不建议**。（若要合规接财联社，正路是官方开放平台/授权合作。）

### 3.4 B 的落地建议

- 金十：**可以做主源**。两个 header 常量 + `max_time` 水位增量。注意 `x-app-id` 的出处**未在本机追溯**（见 §6）。
- 财联社：**当前不可做机器可读源**。若产品必须有财联社口径，备选是「人工/浏览器侧手动投喂」，或找聚合源（【未确认】，本次未测任何第三方聚合）。

---

## 4. C — Material Design 能否无新依赖落地

### 4.1 现有 token 体系（【实测】）

**颜色 / 表面**（`src/client/styles.ts`，浅色 `:14-42`、深色 `.tw-root[data-theme=dark]` `:43-58`）：

- 背景/卡片层次：`--tw-bg` `--tw-bg2` `--tw-card` `--tw-card2` `--tw-hover`（`:15`、深色 `:44`）
- 边框分层：`--tw-border` `--tw-border-strong`
- 文字：`--tw-text` `--tw-dim` `--tw-muted`
- 语义色：`--tw-up/--tw-down/--tw-flat` + 三档重要性 `--tw-imp-1/2/3` + 护盘四档 `--tw-rescue-0..3`（**明确不复用涨跌色相**）
- 强调/焦点：`--tw-accent` `--tw-accent-hover` `--tw-accent-soft` `--tw-ring`（`:32`、深色 `:52`）
- 动效曲线：`--tw-ease: cubic-bezier(.16,1,.3,1)`（`styles.ts:39`）

**阴影（elevation 现状）—— 只有 2 档 + 3 处散落**：

```
src/client/styles.ts:35  --tw-shadow-sm: 0 1px 2px rgba(16,24,40,.05);
src/client/styles.ts:36  --tw-shadow-lg: 0 1px 2px rgba(16,24,40,.05), 0 14px 36px rgba(16,24,40,.13);
src/client/styles.ts:54  （深色）--tw-shadow-sm: 0 1px 0 rgba(255,255,255,.03)
src/client/styles.ts:55  （深色）--tw-shadow-lg: 0 1px 0 rgba(255,255,255,.03), 0 16px 44px rgba(0,0,0,.55)
```

另有 3 处**未走 token** 的字面阴影：`:583` `0 10px 34px rgba(0,0,0,.32)`、`:628` `0 8px 30px rgba(0,0,0,.28)`、`:650` `0 2px 10px rgba(0,0,0,.18)`。⇒ 层级语义已开始漂，是个既有债。

**间距**：**没有** `--tw-space-*` token（`grep -c "tw-space\|--tw-gap\|--tw-pad"` → `0`）。间距靠常量 `TOOL_SPACE`（`toolDetailTheme.ts:62-79`：`sectionGap:22 / cardPad:18 / cardHeadGap:12 / tilePadY:10 / tilePadX:12 / tileGap:10 / heroGap:16 / heroInnerGap:10`）+ 断言 `SPACE_GRID = 1`（`:533`，只要求整数 px）。

**字号：阶梯是机器判据，不是口头约定**

```
src/client/toolDetailTheme.ts:517  export const TYPE_SCALE = [12, 12.5, 13, 13.5, 14] as const
src/client/toolDetailTheme.ts:519  export const DISPLAY_SIZE_MIN = 15
src/client/toolDetailTheme.ts:522  typeScaleProblems()  // <15 必须在阶梯内；>=15 视为"展示级"放行
```

实测 `styles.ts` 分布：`12px ×119`、`12.5px ×3`、`13px ×7`、`14px ×1`、`15px ×4` —— **完全落在阶梯 + 展示级**。

**动效纪律（三条，全部有断言）**

| 纪律 | 判据 | 出处 |
|---|---|---|
| 只动 `transform`/`opacity` | `MOTION_RULES.animatable = ['transform','opacity']`；`animationPropertyProblems()` 拦其余 | `toolDetailTheme.ts:624-634`、`:644-649` |
| `transition` 不许动布局属性 | `TRANSITION_LAYOUT_PROPS = [width,height,top,left,right,bottom,inset,margin,padding,font-size,line-height,flex-basis,grid-template]` | `toolDetailTheme.ts:705-723` |
| 关闭态 `display:none` + 后台暂停 + reduced-motion | `motionCssProblems()` 断言 `.tw-glass[data-open=false]{display:none}` 与 `[data-idle=true]{animation-play-state:paused}` | `toolDetailTheme.ts:725-736` |

运行时的两条实现：`.tw-root[data-idle=true] *{animation-play-state:paused!important}`（`styles.ts:61`）；`@media (prefers-reduced-motion:reduce)` 共 4 处（`:132, :680, :755, :767`）。

**「不得闪烁」是既有红线，且已被测试固定**：

```
src/client/impl81.test.ts:184  assert.equal(/animation/.test(block), false, `${cls} 不许有 animation（不做闪烁）`)
src/client/impl87.test.ts:272  if (/animation|transition/.test(body)) bad.push('高亮不许带动效（不闪烁）')
```

现有 keyframes 共 5 个，全部只动 `transform`/`opacity`：`tw-breathe`（`:127`）、`twshimmer`（`:409-410`）、`twslide`（`:452-453`）、`tw-indet`（`:527-529`）、`tw-tool-in`（`:678`）。`transition:` 共 22 处，全部是 `color/background/border-color/filter/opacity/transform` 这类纯 paint 或合成属性。

### 4.2 逐项裁决

| MD 构件 | 现有覆盖 | 缺口 | 纯 CSS 可行？ | 与红线冲突？ |
|---|---|---|---|---|
| **elevation**（MD3 六档 0/1/3/6/8/12dp） | 2 档 token + 3 处散落字面阴影 | 缺 4 档（且要补深色档值） | ✅ 纯 CSS。`box-shadow` **不在** `transition` 黑名单（只拦布局属性），所以 elevation 过渡也合法 | ❌ 无冲突。但**必须补全深色档**（`:54-55` 与浅色档语义不同） |
| **state layer**（hover 8% / pressed 12% 叠加） | `--tw-hover` 已在用（`styles.ts:96, 216, 276` 等） | MD 用「同色 opacity 叠加」而非「换一个底色」；语义不等价 | ✅ 纯 CSS：`::after` + `opacity` + `background:currentColor`，`opacity` 在允许动画集内 | ⚠ **轻微**。现有惯例是 `transition: background .12s`（paint），改用 opacity 叠加更省 paint，但要保证 `impl87.test.ts:272` 的「高亮不许带动效」不被误伤 —— 即**高亮态仍须静态** |
| **ripple**（点击水波） | **零先例** | 需要 pointer 坐标 ⇒ 必须 JS 写入坐标（`--ripple-x/y` 或注入节点） | ⚠ **纯 CSS 不够**，但只需 ~10 行 JS，**不需要任何库** | ⚠ **两处真冲突**，见 §4.3 |
| **typography scale** | 阶梯 12/12.5/13/13.5/14 + 展示级 ≥15 | MD3 低端 `Label Small = 11px` **低于阶梯下界** | ✅ 纯 CSS | ⚠ **部分冲突**，见 §4.4 |

### 4.3 ripple 的两处真冲突（这是本次最具体的风险）

MD 的 ripple 有两种常见写法，**其中一种在本仓库会被测试直接判违规**：

1. **`width`/`height` 从小到大**（很多 MD 实现这么写）⇒ **违规**。`keyframesProblems()`（`toolDetailTheme.ts:679-694`）会遍历 `@keyframes` 体内每个属性，`width`/`height` 不在 `animatable` 白名单 ⇒ 报「动画只允许 transform / opacity」。
   **解法**：ripple 元素固定尺寸（如 100×100 的圆），只做 `transform: scale(0 → 1)` + `opacity`。✅ 完全合规。
2. **后台暂停会「冻住」半透明水波**。`.tw-root[data-idle=true] *{animation-play-state:paused!important}`（`styles.ts:61`）会暂停**所有** animation。用户切后台时正在扩散的 ripple 会停在中间态的半透明圆上，切回来才继续 —— 视觉上像残留污渍。
   **解法**：`data-idle` 切真时直接移除 ripple 节点（JS 侧），别指望 CSS。

另外：`prefers-reduced-motion` 分支（`:680, :755, :767`）里已有「动画全关」的写法，**ripple 必须在那条分支里也关掉**，否则违反 reduced-motion 纪律。

### 4.4 typography 能采纳多少（MD3 数值为【文档声明】）

MD3 官方 15 档里与本仓库阶梯的交集（MD 数值取自公开文档，见 §7 引用）：

| MD3 档 | px | 本仓库 | 裁决 |
|---|---|---|---|
| Display L/M/S | 57 / 45 / 36 | ≥15 ⇒ 算「展示级」放行 | 侧栏面板里**无实用价值**，不要 |
| Headline L/M/S | 32 / 28 / 24 | 同上 | 同上 |
| Title Large | 22 | 展示级放行 | 可作详情页 Hero，限量 |
| **Title Medium / Body Large** | **16** | 展示级放行 | 可用，但**会打破**当前 `font:13px/1.5`（`styles.ts:41`）的密集基调 |
| Title Small / Body Medium / Label Large | 14 | ✅ 在阶梯内 | **直接用**（当前仅 1 处用到 14） |
| Body Small / Label Medium | 12 | ✅ 在阶梯内（主力，119 处） | **直接用** |
| **Label Small** | **11** | ❌ `< DISPLAY_SIZE_MIN(15)` 且不在 `TYPE_SCALE` | **不可用**，`typeScaleProblems()` 会报违规 |

⇒ 结论：**MD3 的 typography scale 只能采纳「低端子集」**（12 / 14），想保留「MD 味道」就靠**字重 + 字距**（MD3 每档都带 weight/letter-spacing）而不是字号 —— 而字重/字距本仓库完全没约束，是**零冲突的改造面**。

### 4.5 C 的结论

> **部分可行，纯 CSS + 极少量 JS，零新依赖。**
> - **elevation**：补 4 档 token（浅/深各一套）+ 把 3 处字面阴影收回 token ⇒ 纯 CSS，**与红线无冲突**（唯一注意：深色档必须单独给值）。
> - **state layer**：`::after` + `opacity` 纯 CSS，合规；但要守住「高亮态不带动效」这条既有断言。
> - **ripple**：需 ≤10 行 JS 取坐标；**关键帧只能 scale/opacity**（动 width/height 会被测试拦），且 `data-idle`/reduced-motion 两处必须主动移除节点。
> - **typography**：只能采纳 12/14 两档 + MD 的字重/字距；`Label Small 11px` **明确不可用**，16px 以上属展示级需限量。
> - **不建议**为 MD 引入任何 UI 库：现有 token/断言体系是自洽的，引入库会同时踩「零新依赖」（`impl81.test.ts:174` 的用例名里就写着「零新依赖」）和「不得闪烁」两条。

---

## 5. D — 定时器能力

### 5.1 现有实现（【实测】`src/host/auctionSeries.ts`）

```ts
304  export const AUCTION_INTERVAL_MS = 10_000
356  private timer: ReturnType<typeof setInterval> | null = null
373  start(): void {
374    if (this.running) return
376    if (process.env.NODE_TEST_CONTEXT !== undefined) return   // 测试进程不启动真实定时器
377    this.running = true
378    this.timer = setInterval(() => {
379      void this.tick().catch(() => undefined)
380    }, this.opts.intervalMs ?? AUCTION_INTERVAL_MS)
381    this.timer.unref?.()                                     // 不阻止进程退出
383  }
385  stop(): void { this.running = false; clearInterval(...) }
```

设计要点（值得复用到棱镜）：

- **测试守卫**：`NODE_TEST_CONTEXT` 存在时不启真实定时器，单测直接驱动 `auctionTick()`。
- **`unref()`**：定时器不吊住事件循环。
- **幂等 tick**：`tick()` 自己判窗口（`inAuctionWindow`，`:39-47`），窗口外什么都不做 —— **节拍恒定、动作由条件决定**，这是能扛住休眠/时钟跳变的关键写法。
- **交易日判定不猜节假日**：用**行情源时间** `f30` 的日期与本地今天比对（`:4-5` 注释、`auctionStamp()` `:27-38`）。
- **时区显式**：`parseMarketStamp`「**显式按北京墙上时间**解析（宿主 TZ=UTC 时也不漂）」（`:25-26` 注释）。

同类先例：`src/host/lock.ts:277-282`（`setInterval` + `typeof timer.unref === 'function'` 守卫）、`src/host/degrade.ts:296`（`timer.unref?.()`）。

### 5.2 能不能扩展成「每交易日按用户自定义时点触发 N 次」

**进程内节拍方案（自研，可行）**

1. **一个固定节拍，不要 N 个 `setTimeout`**。每个用户时点各起一个定时器，在跨日/休眠/时钟回拨下会漂、会丢、会重复。改成 `ctx.timer.interval(tick, 60_000)`，每次唤醒只做一件事：**判断「自上次触发以来跨过了哪些时点」**。
2. **用宿主自带的 `ctx.timer` 而不是裸 `setInterval`**（【实测】inspect `Service` = `timer`）：`interval(callback, delay): () => void` / `timeout` / `throttle` / `debounce`，且「Disposable timer helpers **mixed into Cordis contexts**」——`cordis-plugin-timer/lib/types/index.d.ts:3-7` 把它混入 `Context`（`interval`/`timeout`/`throttle`/`debounce`/`setTimeout`/`setInterval`，各返回 disposer），随 fiber 自动清理。比自管 `clearInterval` 安全。
3. **水位要落盘**：`lastFiredAt` + `firedKeys: ["2026-10-22T09:40"]`，写走仓库既有 `updateJsonLocked`（`auctionSeries.ts` 头注释已写明这套落盘纪律）。
4. **交易日判定沿用仓库口径**：行情源时间戳（`auctionSeries.ts` 的做法）或 `src/host/calendarCheck.ts`。
5. **时区**：全部按 `Asia/Shanghai` 显式解析（`parseMarketStamp`），**禁止** `new Date().getHours()` —— 宿主 TZ 可能是 UTC（`auctionSeries.ts:25-26` 明说）。

**宿主休眠 / 跨日 / 时区的真实限制**

| 限制 | 说明 |
|---|---|
| **宿主休眠** | `setInterval`/`ctx.interval` 只在 Node 进程活着时走。机器睡眠期间**不触发**；唤醒后只会在下一个节拍到点时才补判，且 `Date.now()` 已大幅跳变 ⇒ 必须靠「跨过哪些时点」的判据补齐或跳过（默认**只补最近一次**，避免一次性刷 N 轮烧 token） |
| **进程退出** | `unref()` 的定时器不阻止退出 ⇒ 关了 `dsh web` 就没有调度。**这是自研方案的硬边界** |
| **跨日** | 节拍方案靠「日期 + 时点」双键天然安全；N 个 `setTimeout` 方案会在午夜附近丢 |
| **时区** | 宿主 TZ ≠ Asia/Shanghai 时，一切按墙上时间算的逻辑必须显式带时区 |
| **频率上限** | 自研节拍没有上限，**必须自己限流**（每次研判都是真 token） |

**更贴合的支持路径：宿主 `ctx.schedule`（推荐）**

【实测】inspect `Service` = `schedule`：

- `create(sessionId: SessionId, request: ScheduleCreateRequest, signal?): Promise<ScheduleRecord>`
- `ScheduleCreateRequest`：`{ prompt, title, after_seconds?, at?, every_seconds?, daily?: {time, time_zone}, weekly?: {time, time_zone, weekdays[]}, cron?: {expression, time_zone} }`
- 错误码：`invalid_prompt` / `invalid_rule` / `invalid_time_zone` / `not_future` / `time_out_of_range` / **`frequency_too_high`** / `subagent_session` / `internal_error`
- 服务描述：「**reads, deletion, and timing edits never activate a Session**」，且「`sessionPersistence` is a load-order requirement … a delivery commits only when `ctx.sessions.flush()` reports that a `session/flush` listener participated」

**最关键的一条**（【实测】）：投递时会真的唤醒 agent ——

```
dsh-schedule/lib/index.js:1596   resolved.agent.followup(message);
```

⇒ `cron: { expression: "*/30 9-15 * * 1-5", time_zone: "Asia/Shanghai" }` 这种配置**本来就是「每交易日按自定义时点跑一批 agent turn」**，且是宿主持久化的（重启后记录还在），比自研内存节拍强。

限制：
1. **必须绑定一个 `SessionId`**（`ScheduleListRequest { sessionId }`）——不能凭空调度。
2. `frequency_too_high` ⇒ 时点密度有上限（具体阈值**未确认**）。
3. 「错过的时点是否补投」**文档未声明**（对比：`task_board_schedule` 的工具文档说「Missed occurrences during Host downtime are skipped, never queued」，但那是另一套）；⇒ **【未确认】**。
4. cron 是 5 段式，Vixie 语义（day-of-month 与 day-of-week 同时限定时取 OR）——「每交易日」建议用 `* * 1-5` 而不是靠日期运算。

### 5.3 D 的结论

> **可行，且有两条路，建议分层：**
> - **「研判时点」用 `ctx.schedule`**（cron + `time_zone: Asia/Shanghai`）—— 持久、跨重启、投递即 `agent.followup()` 唤醒 agent，正好等于「每交易日按自定义时点起一轮研判」。
> - **「成交撮合 / 触价检查」用自研节拍**（`ctx.timer.interval` + 固定节拍 + 水位落盘 + `unref`）：这类检查**不需要模型**，纯价格比对，秒级节拍即可；照 `auctionSeries.ts` 的「恒定节拍 + 幂等 tick + `NODE_TEST_CONTEXT` 守卫」写，最稳。
> - **硬边界**：进程不在就没有自研节拍（`unref` 不吊住进程）；休眠期间不触发，唤醒后要按「跨过哪些时点」补齐/跳过。

---

## 6. 未确认项（明确列出，不要当成已验证）

1. **金十 `x-app-id: bVBF4FyRTn5NJF5n` 的出处**：实测该值 + `x-version: 1.0.0` 能拿到 200，且请求里**不含任何 cookie/token/账号信息**；但本机**没有**去它的前端 bundle 里追溯这两个常量的定义位置。⇒ 是「客户端标识常量而非用户密钥」这一判断属**【未确认】**。若该值轮换，接口会退回 502。
2. **金十 24h 全量页数**：按 `1.19 条/分` 外推 ≈1712 条 / ≈81 页，是**估算**，未实跑分页到底。
3. **`ctx.llm.stream()` 的端到端实跑**：本机只做了类型/门禁的证据核对（`grep -c initiator` → 0、`purpose` 可选），**没有**真的发一次调用（避免消耗配额与产生会话）。⇒ 属**【文档声明】**级别。
4. **`agentLoop.createAgent()` 在插件 fiber 下的实跑**：同上，未执行。特别是 `meta.agentPreset` 能否让新 agent 看见 tradewatcher 的 tool、`dispose()` 后 session 如何处置，均**未确认**。
5. **`ctx.schedule` 对「错过的时点」是否补投**：服务文档未声明，未实测。
6. **`frequency_too_high` 的具体阈值**：未确认。
7. **财联社是否还有别的免签公开接口**：只测了 `nodeapi/telegraphList`（404）与 `v1/roll/get_roll_list`（10012 签名错误）。⇒ 不排除存在其他路径，但**签名机制**是确定的墙，且我**没有尝试**任何破解。
8. **第三方新闻聚合源**：完全未测。
9. **MD3 规范数值**（57/45/36/32/28/24/22/16/14/12/11、elevation 0/1/3/6/8/12dp、state layer 8%/12%）：来自公开文档检索（见 §7），**未逐条核对** m3.material.io 原文。
10. **`data-idle` 与 ripple 的交互**：§4.3 的「切后台会冻住半透明水波」是从 `styles.ts:61` 的 `animation-play-state:paused!important` **推出来的**，未在浏览器里实际复现。

## 7. 引用

- 本仓库：`src/index.ts`、`src/client/styles.ts`、`src/client/toolDetailTheme.ts`、`src/client/uiuxDiscipline.test.ts`、`src/client/impl81.test.ts`、`src/client/impl87.test.ts`、`src/host/auctionSeries.ts`、`src/host/robotsGate.ts`、`src/host/lock.ts`、`src/host/degrade.ts`
- DSH 实现：`dsh-llm/lib/types/types.d.ts`、`dsh-agent/lib/types/runtime-types.d.ts`、`dsh-agent/lib/types/model-selection.d.ts`、`dsh-agent-loop/lib/index.js`、`dsh-schedule/lib/index.js`、`cordis-plugin-timer/lib/types/index.d.ts`、`dsh-agent-preset/skills/cordis-plugin-development/references/practices.md`
- 运行时发现：`cordis_inspect_query`（host）`Service.listService` for `llm` / `agentLoop` / `schedule` / 全目录
- 本机 profile：`~/.dsh/profiles/web/cordis.patch.yml:13,91`
- MD3 参考（外部）：[Material 3 type scale tokens](https://m3.material.io/styles/typography/type-scale-tokens)、[Material 3 typography cheatsheet](https://medium.com/@vosarat1995/material-3-you-typography-cheatsheet-ffc58c540181)、[Material elevation levels](https://designfornative.com/basics-of-elevation-on-android)、[mdc-elevation theme](https://github.com/material-components/material-components-web/blob/master/packages/mdc-elevation/_elevation-theme.scss)
