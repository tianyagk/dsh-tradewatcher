# 棱镜 selftest「模型返回空文本」诊断与修复

## 0. 一行结论

根因是 **消息 content 传了字符串**：`GenerateOptions.messages` 的真实契约要求 `ContentBlock[]`；pi-ai 适配器对字符串调 `message.content.some(...)` 抛 TypeError，运行时把适配器异常转成 `finish(kind=error)` chunk，而旧消费代码只取 `text-delta`、丢掉 `finish` ⇒ 0 个 chunk / 0ms / 空文本。已改为发 `[{type:'text',text}]`，并把 `finish` 错误原文与 chunk 摘要带回 selftest。

## 1. 真实契约（`dsh-llm/lib/types/types.d.ts`）

| 字段 | 结论 |
| --- | --- |
| `GenerateOptions` 必填 | 只有 `provider`、`model`、`messages`；`system`/`maxTokens`/`reasoningEffort`/`sessionId`/`purpose` 全可选 |
| `messages` | `RequestMessage[]` = `Message \| RequestUserInput`；**`content: readonly ContentBlock[]`**，不是字符串 |
| `StreamChunk` 判别 | `type`：`text-delta` 取 `.text`；`finish` 的 `.reason.kind` 为 `stop`/`tool-calls`/`max-tokens`/`error`/`aborted`，后两者带 `.failure{code,message}` |
| 流 | `stream(options): AsyncIterable<StreamChunk>`，无需单独打开 |

## 2. 三种原因逐条排除

| 可能原因 | 结论 | 证据 |
| --- | --- | --- |
| ① 消费方式错（没取文本字段） | **部分成立，已修** | 旧代码只拼接 `text-delta`，完全忽略 `finish(error)`；适配器错误因此被伪装成「空文本」。现在记录 `finish.reason.failure` 原文 + 前 3 个 chunk 的 `type`/键名 |
| ② 缺必填 option（如 maxTokens/system） | **不成立** | 必填只有三项；`maxTokens` 可选。另发现旧代码传了 `maxTokens:50`，对 reasoning 模型可能把预算全给 reasoning；selftest 已去掉该上限（提示仍 ≤50 token） |
| ③ workbuddy provider 参数不同 | **不成立（参数不是根因）** | 与 `dsh headless` 同 provider/model（`workbuddy / cn:deepseek-v4.1-flash`）；headless 能回 `OK`。差异是 headless 走 agent loop：`content` 是 block 数组，并带 `reasoningEffort/sessionId/purpose`；这些除 content 形状外都不是必填。修复后 selftest 只依赖 provider/model/messages |

**根因**：`messages[].content` 必须是 `readonly ContentBlock[]`。旧代码传 `'只回复 OK'`，适配器 `assertSupportedHistory` 对字符串调 `.some` 抛 TypeError → `finish(error)` → 旧消费代码丢弃 → 空文本、0ms。

## 3. 修复

- `prismLlm.streamText`：发送前把字符串消息转成 `[{type:'text', text}]`；保留 `maxTokens` 能力但 selftest 不设上限。
- 消费 `finish`：`kind=error/aborted` ⇒ `error = 模型流结束于 error [CODE]：<上游 message>`；同时统计 `reasoning-delta` 个数。
- selftest 返回：`{ok,error,model,elapsedMs,text,chunks}`；`chunks` = 前 3 个 chunk 的 `{type,keys}`；失败仍 **200**，`error` 原文。

## 4. 断言

| # | 场景 | 结果 |
| --- | --- | --- |
| ① | 正常流（两个 `text-delta` "O"+"K"） | `ok:true`、`text:"OK"`、`chunks` 2 条；并断言 `messages[0].content` 为 `[{type:'text',text:'只回复 OK'}]` |
| ② | 空流 | `ok:false`、`error` 含「空文本」、`chunks:[]` |
| ③ | 抛错 | HTTP **200**、`error` 带 `boom-原文` |
| ④ | `finish(error)` chunk | `ok:false`、`error` 含上游 `provider boom`、`chunks[0]={type:'finish',keys:['reason','type']}` |

用例：`src/host/prismSelftest.test.ts`（4 条）、`prismPipeline.test.ts`（假流 content 数组）。

## 5. 门禁

- 基线 1132 → **1134**（selftest 新增空流 + finish 错误两条）。
- 两轮 `DSH_HOME=/tmp/prismb35-check{AO,AP} npm run check`：**1134 × 2 全绿**（AO 19,816/19,246ms；AP 19,004/19,154ms）；构建 **73 项**（v0.131.0，`build.mjs` 未动）。

## 6. 未做

- 活宿主内复验 selftest 需重启（用户执行）；本机只做 handler 假流 + `dsh headless` 对照。
- `chunks` 只保留前 3 个，不携带内容（避免把模型输出写进诊断）。
