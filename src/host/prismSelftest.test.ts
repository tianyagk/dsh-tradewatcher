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

test('⑨ 成功：ok=true，model 为 provider / model', async () => {
  const get = (n: string): unknown => {
    if (n === 'llm') return { stream: async function* () { yield { type: 'text-delta', text: 'OK' } } }
    if (n === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
    return undefined
  }
  const { status, body } = await callSelftest(get)
  assert.equal(status, 200)
  assert.equal(body['ok'], true)
  assert.equal(body['model'], 'p / m')
})
