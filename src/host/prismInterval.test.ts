/**
 * 决策周期 `intervalSec`（v0.206.x）：默认 600 / 持久化 / 路由校验 / 不影响按 times 触发。
 *
 * 覆盖三件事：
 *   ① `PrismSettings.intervalSec` 缺省 600，旧文件（无字段）与非法值都回落 600；
 *   ② `POST /tradewatcher/prism {action:'settings'}` 可只传 times、只传 intervalSec、或两者同传；
 *      非法 intervalSec ⇒ 400 + 一句原因；两者都不传 ⇒ 400；
 *   ③ 调度器 `dueSlots` 只读 `times`：换 intervalSec 不改任何触发时点。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DataStore } from './store.ts'
import { PrismStore } from './prismStore.ts'
import { PrismTradingStore } from './prismAccount.ts'
import { makePrismRoutes } from './prismRoutes.ts'
import { dueSlots } from './prismScheduler.ts'
import { parseMarketStamp } from './time.ts'
import type { PrismSettings } from '../shared/prism.ts'
import { PRISM_DEFAULT_TIMES } from '../shared/prism.ts'

const fakeData = (): DataStore => ({
  portData: () => ({ groups: [], items: [] }),
  watchData: () => ({ groups: [], items: [] }),
  ledgerEntries: () => [],
} as unknown as DataStore)

const routeOf = (store: PrismStore, trading: PrismTradingStore) =>
  makePrismRoutes({ store, trading, data: fakeData(), get: () => undefined })

interface Reply { code: number; body: Record<string, any> }

const post = async (store: PrismStore, trading: PrismTradingStore, body: unknown): Promise<Reply> => {
  const route = routeOf(store, trading).find((r) => r.path === '/tradewatcher/prism')
  let text = ''
  const res = {
    statusCode: 200,
    setHeader: () => undefined,
    end: (s: string) => { text = s },
  } as unknown as ServerResponse
  const req = {
    method: 'POST',
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)) },
  } as unknown as IncomingMessage
  await route?.handler(req, res)
  return { code: res.statusCode, body: JSON.parse(text) as Record<string, any> }
}

const fresh = async (dir: string): Promise<{ store: PrismStore; trading: PrismTradingStore }> => {
  const store = new PrismStore(dir)
  const trading = new PrismTradingStore(dir)
  await store.init()
  await trading.init()
  return { store, trading }
}

test('① 默认 600：新目录与旧文件（无 intervalSec）都回 600，非法落盘值也回 600', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-interval-default-'))
  try {
    let { store } = await fresh(dir)
    assert.equal(store.settings().intervalSec, 600, '未保存 ⇒ 600s')
    // 旧文件：v0.206.0 的 prism-settings.json 只有 times/lastFired
    await writeFile(join(dir, 'prism-settings.json'), JSON.stringify({ v: 1, times: ['09:35'], lastFired: {} }), 'utf8')
    ;({ store } = await fresh(dir))
    assert.equal(store.settings().intervalSec, 600, '旧文件缺字段 ⇒ 600s')
    // 手改坏值：不猜、不回显非法值
    await writeFile(join(dir, 'prism-settings.json'), JSON.stringify({ v: 1, times: ['09:35'], intervalSec: 700, lastFired: {} }), 'utf8')
    ;({ store } = await fresh(dir))
    assert.equal(store.settings().intervalSec, 600, '非法落盘值 ⇒ 600s')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('② 只传 intervalSec：200，时点保持原值；重启后仍是新周期', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-interval-only-'))
  try {
    let { store, trading } = await fresh(dir)
    const r = await post(store, trading, { action: 'settings', intervalSec: 1200 })
    assert.equal(r.code, 200)
    assert.equal(r.body['settings']['intervalSec'], 1200)
    assert.deepEqual(r.body['settings']['times'], [...PRISM_DEFAULT_TIMES], '只改周期不得动时点')
    ;({ store, trading } = await fresh(dir))
    assert.equal(store.settings().intervalSec, 1200, '重启后保留')
    assert.deepEqual(store.settings().times, [...PRISM_DEFAULT_TIMES])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('③ 两者同传：一次请求同时保存 times 与 intervalSec', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-interval-both-'))
  try {
    const { store, trading } = await fresh(dir)
    const r = await post(store, trading, { action: 'settings', times: ['09:35', '10:00', '14:40'], intervalSec: 300 })
    assert.equal(r.code, 200)
    assert.equal(r.body['settings']['intervalSec'], 300)
    assert.deepEqual(r.body['settings']['times'], ['09:35', '10:00', '14:40'])
    // 再只改 times：intervalSec 保持不变（两个字段互不覆盖）
    const r2 = await post(store, trading, { action: 'settings', times: ['09:40'] })
    assert.equal(r2.code, 200)
    assert.equal(r2.body['settings']['intervalSec'], 300, '只改 times 不得把周期重置成默认')
    assert.deepEqual(r2.body['settings']['times'], ['09:40'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('④ 非法 intervalSec / 空请求 ⇒ 400 + 原因（不得静默接受）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-interval-bad-'))
  try {
    const { store, trading } = await fresh(dir)
    for (const bad of [0, 700, 300.5, 601, '600', null]) {
      const r = await post(store, trading, { action: 'settings', intervalSec: bad })
      assert.equal(r.code, 400, `intervalSec=${JSON.stringify(bad)} 必须 400`)
      assert.match(String(r.body['error']), /intervalSec.*300 \/ 600 \/ 900 \/ 1200/, `必须给原因：${String(r.body['error'])}`)
    }
    const empty = await post(store, trading, { action: 'settings' })
    assert.equal(empty.code, 400)
    assert.match(String(empty.body['error']), /times.*intervalSec/)
    assert.equal(store.settings().intervalSec, 600, '被拒的请求不得写坏已存值')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('⑤ 调度器只认 times：intervalSec 取 300/600/1200 时触发时点完全相同', () => {
  const base = (intervalSec: number): PrismSettings => ({
    times: ['09:35', '11:20', '13:10', '14:40'], intervalSec, lastFired: {},
  })
  const now = parseMarketStamp('2026-10-22 09:36:00') as number
  const a = dueSlots(base(300), now)
  const b = dueSlots(base(600), now)
  const c = dueSlots(base(1200), now)
  assert.deepEqual(a.due, ['09:35'])
  assert.deepEqual(b.due, a.due, '600s 不得改变触发集合')
  assert.deepEqual(c.due, a.due, '1200s 不得改变触发集合')
  // 反例：真正改触发时点只能改 times
  const moved = dueSlots({ ...base(600), times: ['10:00'] }, now)
  assert.deepEqual(moved.due, [], 'times 改成 10:00 后 09:36 不再触发（证明它不是装饰字段）')
})
