import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PrismStore } from './prismStore.ts'
import { PrismTradingStore } from './prismAccount.ts'
import { makePrismRoutes } from './prismRoutes.ts'

const callSelftest = async (get: (n: string) => unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-self-'))
  try {
    const store = new PrismStore(dir)
    const trading = new PrismTradingStore(dir)
    await store.init()
    await trading.init()
    const route = makePrismRoutes({ store, trading, data: {} as never, get }).find((r) => r.path === '/tradewatcher/prism/selftest')
    assert.notEqual(route, undefined)
    let status = 0
    let text = ''
    const res = {
      setHeader: () => undefined,
      end: (s: string) => { text = s },
      set statusCode(v: number) { status = v },
      get statusCode() { return status },
    } as unknown as ServerResponse
    await route?.handler({ method: 'GET' } as IncomingMessage, res)
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('⑨ 失败也 200，error 带异常原文（抛错 ⇒ 仍 200）', async () => {
  const get = (n: string): unknown => {
    if (n === 'llm') return { stream: () => { throw new Error('boom-原文') } }
    if (n === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
    return undefined
  }
  const { status, body } = await callSelftest(get)
  assert.equal(status, 200)
  assert.equal(body['ok'], false)
  assert.match(String(body['error']), /boom-原文/)
  assert.equal(typeof body['elapsedMs'], 'number')
})

test('⑨ 成功：多个 delta 拼接、text 非空、chunks 摘要；messages 必须是 ContentBlock[]', async () => {
  let seen: unknown = null
  const get = (n: string): unknown => {
    if (n === 'llm') return {
      stream: async function* (options: unknown) {
        seen = options
        yield { type: 'text-delta', text: 'O' }
        yield { type: 'text-delta', text: 'K' }
      },
    }
    if (n === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
    return undefined
  }
  const { status, body } = await callSelftest(get)
  assert.equal(status, 200)
  assert.equal(body['ok'], true)
  assert.equal(body['text'], 'OK')
  assert.equal(body['model'], 'p / m')
  assert.equal((body['chunks'] as unknown[]).length, 2)
  const messages = (seen as { messages: Array<{ content: unknown }> }).messages
  assert.deepEqual(messages[0]?.content, [{ type: 'text', text: '只回复 OK' }], 'content 必须是 ContentBlock[]（字符串会让适配器空流）')
})

test('⑨ 空流：ok=false、error 含「空文本」、chunks=[]', async () => {
  const get = (n: string): unknown => {
    if (n === 'llm') return { stream: async function* () {} }
    if (n === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
    return undefined
  }
  const { status, body } = await callSelftest(get)
  assert.equal(status, 200)
  assert.equal(body['ok'], false)
  assert.match(String(body['error']), /空文本/)
  assert.deepEqual(body['chunks'], [])
})

test('⑨ finish 错误 chunk：error 带上游原文，chunks 摘要含 type/keys', async () => {
  const get = (n: string): unknown => {
    if (n === 'llm') return { stream: async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM', message: 'provider boom' } } } } }
    if (n === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
    return undefined
  }
  const { status, body } = await callSelftest(get)
  assert.equal(status, 200)
  assert.equal(body['ok'], false)
  assert.match(String(body['error']), /provider boom/)
  const chunks = body['chunks'] as Array<{ type: string; keys: string[] }>
  assert.equal(chunks[0]?.type, 'finish')
  assert.deepEqual(chunks[0]?.keys.sort(), ['reason', 'type'])
})
