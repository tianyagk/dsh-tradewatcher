/**
 * P2-2（AUDIT-HOST-PERF）：`watchData()` / `portData()` 不再深拷贝；`/calendar` 一次请求
 * 只读一次自选、一次持仓（旧实现：`focusCodes` 调 3 次 ⇒ 3 + 3 次全量克隆）。
 *
 * 浅拷贝契约：groups 数组与 items 逐项都是新对象 ⇒ 调用方改返回值不影响内部状态。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DataStore } from './store.ts'
import { CalendarStore } from './calendar.ts'
import { RescueMonitor } from './rescue.ts'
import { focusSets, makeTradeRoutes } from './routes.ts'

// 与 routes.test.ts 同一隔离口径：不让任何路径读到用户真实缓存
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tw-perf-p2-home-'))

interface Captured {
  code: number
  body: Record<string, unknown>
}

/** 建一个带自选/持仓数据的 store（临时目录，用例结束即删） */
async function seed(dir: string): Promise<DataStore> {
  const store = new DataStore(dir)
  await store.init()
  await store.mutateWatch({ op: 'addGroup', name: '自选' })
  const wg = store.watchData().groups[0]!
  await store.mutateWatch({ op: 'addItem', groupId: wg.id, secid: '1.600519', symbolName: '贵州茅台' })
  await store.mutateWatch({ op: 'addItem', groupId: wg.id, secid: '0.300750', symbolName: '宁德时代' })
  await store.mutatePortfolio({ op: 'addGroup', name: '持仓' })
  const pg = store.portData().groups[0]!
  await store.mutatePortfolio({ op: 'addPos', groupId: pg.id, secid: '1.510300', symbolName: '沪深300ETF' })
  return store
}

test('P2-2 ① 浅拷贝：改返回值（字段/数组）不影响内部状态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-perf-p2-copy-'))
  try {
    const store = await seed(dir)
    const watch = store.watchData()
    const watchName = watch.items[0]!.name
    watch.items[0]!.name = '被调用方改过'
    watch.groups[0]!.name = '被调用方改过'
    watch.items.push({ id: 'x', groupId: 'g', secid: '1.000001', name: 'x', createdAt: 0 })
    watch.items.length = 0
    const after = store.watchData()
    assert.equal(after.items.length, 2, '往返回数组里 push/清空不得影响内部')
    assert.equal(after.items[0]!.name, watchName, '改返回条目的字段不得影响内部')
    assert.equal(after.groups[0]!.name, '自选', '改返回分组字段不得影响内部')

    const port = store.portData()
    const posName = port.items[0]!.name
    const groupOrder = port.groups[0]!.order
    port.items[0]!.name = '被调用方改过'
    port.items[0]!.secid = '1.999999'
    port.groups[0]!.order = 99
    port.groups.length = 0
    const portAfter = store.portData()
    assert.equal(portAfter.items.length, 1)
    assert.equal(portAfter.items[0]!.name, posName)
    assert.equal(portAfter.items[0]!.secid, '1.510300')
    assert.equal(portAfter.groups[0]!.order, groupOrder)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P2-2 ② focusSets：held 只含持仓、watched = 自选∪持仓、codes 顺序保持"先自选后持仓"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-perf-p2-focus-'))
  try {
    const store = await seed(dir)
    const focus = focusSets(store)
    assert.deepEqual([...focus.watched].sort(), ['300750', '510300', '600519'])
    assert.deepEqual([...focus.held], ['510300'])
    assert.deepEqual(focus.codes, ['600519', '300750', '510300'], '顺序与旧 focusCodes 一致（先自选后持仓）')
    // 只含 0/1 市场：港股/美股/期货代码不进集合
    await store.mutateWatch({ op: 'addItem', groupId: store.watchData().groups[0]!.id, secid: '116.00700', symbolName: '腾讯控股' })
    const focus2 = focusSets(store)
    assert.equal(focus2.watched.has('00700'), false)
    assert.deepEqual(focus2.codes, ['600519', '300750', '510300'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P2-2 ③ GET /calendar：watchData / portData 各只调 1 次（旧实现 watch 2 次 / port 3 次）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-perf-p2-cal-'))
  let rescue: RescueMonitor | null = null
  try {
    const store = await seed(dir)
    let watchCalls = 0
    let portCalls = 0
    const watch = store.watchData.bind(store)
    const port = store.portData.bind(store)
    store.watchData = () => { watchCalls += 1; return watch() }
    store.portData = () => { portCalls += 1; return port() }

    rescue = new RescueMonitor(dir, { enabled: false, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [] })
    const routes = makeTradeRoutes(store, [], new CalendarStore(dir), rescue).routes
    const route = routes.find((r) => r.path === '/tradewatcher/calendar')
    assert.ok(route !== undefined)

    const captured = await new Promise<Captured>((resolve) => {
      const req = { url: '/tradewatcher/calendar?sync=0&from=2026-01-01&to=2026-02-01', method: 'GET', headers: { host: '127.0.0.1:3080' } } as unknown as IncomingMessage
      const res = {
        setHeader: () => undefined,
        writeHead: () => undefined,
        end: (payload: string) => resolve({ code: 200, body: payload === '' ? {} : (JSON.parse(payload) as Record<string, unknown>) }),
        statusCode: 200,
      } as unknown as ServerResponse
      void route.handler(req, res)
    })
    assert.equal(captured.code, 200)
    assert.equal(watchCalls, 1, `一次 /calendar 只能读一次自选（实测 ${watchCalls} 次；旧实现 2 次）`)
    assert.equal(portCalls, 1, `一次 /calendar 只能读一次持仓（实测 ${portCalls} 次；旧实现 3 次）`)
    // 勾稽语义没变：持仓代码 held=true、仅自选 watched=true
    assert.equal(captured.body['symbolCount'], 3)
  } finally {
    rescue?.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
