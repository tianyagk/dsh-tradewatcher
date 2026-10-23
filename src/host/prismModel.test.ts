import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PrismStore } from './prismStore.ts'
import { PrismTradingStore } from './prismAccount.ts'
import { resolvePrismModel } from './prismLlm.ts'
import { runPrismAnalysis } from './prismPipeline.ts'
import { makePrismRoutes } from './prismRoutes.ts'

const fakeGet = (llm: unknown, provider = 'default-p', model = 'default-m') => (n: string): unknown =>
  n === 'llm' ? llm : n === 'agentDefaultModel' ? { currentSelection: () => ({ provider, model }) } : undefined

const callRoute = async (deps: Parameters<typeof makePrismRoutes>[0], path: string, method: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const route = makePrismRoutes(deps).find((r) => r.path === path)
  assert.notEqual(route, undefined)
  let text = ''
  let status = 0
  const res = {
    setHeader: () => undefined,
    end: (s: string) => { text = s },
    set statusCode(v: number) { status = v },
    get statusCode() { return status },
  } as unknown as ServerResponse
  const req = {
    method,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  } as unknown as IncomingMessage
  await route?.handler(req, res)
  return { status, body: JSON.parse(text) as Record<string, unknown> }
}

test('③ resolvePrismModel：页面配置优先于默认；空配置明确报错（不回退）', () => {
  const llm = { stream: () => (async function* () {})() }
  const picked = resolvePrismModel(fakeGet(llm), { provider: 'cfg-p', model: 'cfg-m' })
  assert.equal(picked.info.provider, 'cfg-p')
  assert.equal(picked.info.model, 'cfg-m')
  const empty = resolvePrismModel(fakeGet(llm), { provider: ' ', model: '' })
  assert.equal(empty.info.provider, null)
  assert.match(String(empty.info.error), /模型配置为空/)
})

test('③ 研判请求的 provider/model 等于页面所选（忽略配置 ⇒ 必败）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-model-'))
  try {
    const store = new PrismStore(dir)
    await store.init()
    const seen: Array<{ provider: string; model: string }> = []
    const llm = {
      stream: (o: { provider: string; model: string }) => {
        seen.push({ provider: o.provider, model: o.model })
        return (async function* () { yield { type: 'text-delta', text: 'x' } })()
      },
    }
    await runPrismAnalysis(store, 'manual', { positions: '', quotes: '', account: '', news: [], skeleton: '' }, {
      get: fakeGet(llm), model: { provider: 'cfg-p', model: 'cfg-m' }, now: () => 1,
    })
    assert.equal(seen.length, 5)
    assert.deepEqual(new Set(seen.map((s) => `${s.provider}/${s.model}`)), new Set(['cfg-p/cfg-m']))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('③ 未知 provider：保存时明确报错（不静默回退）；合法则落 prism-settings.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-model2-'))
  try {
    const store = new PrismStore(dir)
    const trading = new PrismTradingStore(dir)
    await store.init()
    await trading.init()
    const llm = {
      listProviders: () => [{ id: 'workbuddy', name: 'Workbuddy' }],
      listModels: async () => [{ id: 'cn:deepseek-v4.1-flash' }],
      stream: async function* () {},
    }
    const deps = { store, trading, data: {} as never, get: fakeGet(llm), quotes: async () => ({}) }
    const bad = await callRoute(deps, '/tradewatcher/prism', 'POST', { action: 'model', provider: 'nope', model: 'm' })
    assert.equal(bad.status, 400)
    assert.match(String(bad.body['error']), /未知 provider/)
    assert.equal(store.settings().model ?? null, null, '非法配置不得写入')
    const good = await callRoute(deps, '/tradewatcher/prism', 'POST', { action: 'model', provider: 'workbuddy', model: 'cn:deepseek-v4.1-flash' })
    assert.equal(good.status, 200)
    assert.deepEqual(store.settings().model, { provider: 'workbuddy', model: 'cn:deepseek-v4.1-flash' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('③ 自检使用页面配置的模型（不是默认）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-model3-'))
  try {
    const store = new PrismStore(dir)
    const trading = new PrismTradingStore(dir)
    await store.init()
    await trading.init()
    await store.saveModel('cfg-p', 'cfg-m')
    const seen: string[] = []
    const llm = { stream: function* (o: { provider: string; model: string }) { seen.push(`${o.provider}/${o.model}`); yield { type: 'text-delta', text: 'OK' } } }
    const deps = { store, trading, data: {} as never, get: fakeGet(llm), quotes: async () => ({}) }
    const r = await callRoute(deps, '/tradewatcher/prism/selftest', 'GET')
    assert.equal(r.body['model'], 'cfg-p / cfg-m')
    assert.deepEqual(seen, ['cfg-p/cfg-m'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
