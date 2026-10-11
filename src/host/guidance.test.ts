/**
 * 不变量：**注入段里列出的工具集合 === 实际注册的工具集合**（双向包含）。
 *
 * 锚法：从**真实实现**取两侧 ——
 *   左侧 = `registerTools()` 实际注册到宿主工具表里的名字（用假的 tools 收集器录下来）；
 *   右侧 = `prompt.section({ text })` 拿到的注入段正文里出现的 `tradewatcher_*` 名字。
 * 两端都不写死清单 ⇒ 任一侧增删都会让断言失败（写死清单对写死清单会恒真，这里刻意避免）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeAgentTools } from './tools.ts'
import { DataStore } from './store.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = process.env.DSH_HOME ?? mkdtempSync(join(tmpdir(), 'tw-guide-'))

test('注入段列出的工具集合 === 实际注册的工具集合（双向）', async () => {
  const store = new DataStore()
  await store.init()
  const registered: string[] = []
  let guidance = ''
  const tools = {
    register(def: { name: string }) {
      registered.push(def.name)
      return () => undefined
    },
  }
  const prompt = {
    section(def: { name: string; order: number; text: () => string }) {
      guidance = def.text()
      return () => undefined
    },
  }
  const kernel = makeAgentTools(store, undefined, undefined, undefined, {})
  kernel.registerTools(tools as never, prompt as never)
  assert.ok(registered.length >= 12, `实际注册的工具应 ≥12（实际 ${registered.length}）`)
  // 从注入段正文里抓工具名（真实正文，不是拼接出来的清单）
  const mentioned = [...new Set(guidance.match(/tradewatcher_[a-z_]+/g) ?? [])].sort()
  const actual = [...new Set(registered)].sort()
  const missingInGuide = actual.filter((n) => !mentioned.includes(n))
  const extraInGuide = mentioned.filter((n) => !actual.includes(n))
  assert.deepEqual(missingInGuide, [], `注入段漏列：${missingInGuide.join(', ')}`)
  assert.deepEqual(extraInGuide, [], `注入段多列（未注册）：${extraInGuide.join(', ')}`)
  assert.deepEqual(mentioned, actual, '两侧集合必须完全一致（双向包含）')
  // 反例防线：注入段必须真的写了这些名字（否则上面的集合可能因"一个都没写"而假通过）
  assert.ok(mentioned.length >= 12, `注入段至少提到 12 个工具（实际 ${mentioned.length}）`)
})
