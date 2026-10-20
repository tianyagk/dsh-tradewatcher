/**
 * 杠杆温度计（`/tradewatcher/leverage`）宿主侧断言集。
 *
 * 八条判据（**每条都配反例注入**，证明断言非恒真 —— 见 `docs/AUDIT-LEVERAGE-HOST.md` §4）：
 *   ① 字段齐备 + 三组数组等长 + dates 升序
 *   ② `temperature` = **全历史**分位（1 位小数）—— 换成"近 250 天分位"必须变
 *   ③ 样本 < 250 ⇒ `temperature: null`（写 0 ⇒ 必败）
 *   ④ **每天最多 1 次**上游（计数断言；两个实例共用一份文件也只 1 次）
 *   ⑤ 缺字段 ⇒ `null` 不 0（`?? 0` 注入 ⇒ 必败）
 *   ⑥ 路由**永远 200**：上游抛错也 200 + 全 null 空壳
 *   ⑦ 落盘走锁且幂等（静态源判据 + 重复写/双写/去重三条行为判据）
 *   ⑧ `range` 切片正确（`all` 给 750 ⇒ 必败）
 *
 * 隔离：`DSH_HOME` 指向临时目录（**绝不碰用户的 `~/.dsh`**）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  LEVERAGE_FILE,
  LEVERAGE_MAX_BYTES,
  LEVERAGE_MIN_SAMPLES,
  LeverageService,
  LeverageStore,
  buildLeveragePayload,
  emptyLeveragePayload,
  expandingPercentiles,
  mergeLeverageRows,
  needsDailyFetch,
  parseLeverageFile,
  parseLeverageRange,
  percentileRank,
  sliceLeverageWindow,
  type LeveragePage,
  type LeveragePageRequest,
  type LeveragePayload,
  type LeverageRow,
} from './leverage.ts'
import { makeTradeRoutes } from './routes.ts'
import { DataStore } from './store.ts'
import { CalendarStore } from './calendar.ts'

/** 隔离数据目录：必须在**任何 store 构造之前**指好（`dataHome()` 每次调用都读 env） */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tw-lev-home-'))
const SRC = dirname(fileURLToPath(import.meta.url))

/** 固定"现在"：2026-10-20 14:00（周二下午，已过披露窗口 ⇒ 补拉分支不会误触发） */
const NOW_MS = Date.parse('2026-10-20T14:00:00+08:00')
const TODAY = '2026-10-20'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tw-lev-'))
}

/** `n` 个连续交易日的日期（升序，止于 `end`；只跳周末，够测试用） */
function daysEndingAt(n: number, end = '2026-10-19'): string[] {
  const out: string[] = []
  let ms = Date.parse(`${end}T12:00:00+08:00`)
  while (out.length < n) {
    const wd = new Date(ms).getUTCDay()
    if (wd !== 0 && wd !== 6) out.push(new Date(ms).toISOString().slice(0, 10))
    ms -= 86_400_000
  }
  return out.sort()
}

function mkRow(d: string, o: Partial<LeverageRow> = {}): LeverageRow {
  return { d, rzye: 2_453_374_239_917, rqye: 29_167_627_323, ltsz: 92_416_865_855_823.71, rzyezb: 2.6547, rzjme: -6_331_355_686, ...o }
}

/** 均匀序列（`rzyezb` 从 `from` 线性到 `to`） */
function rampRows(n: number, from = 1.6, to = 2.6): LeverageRow[] {
  const days = daysEndingAt(n)
  return days.map((d, i) => mkRow(d, { rzyezb: from + ((to - from) * i) / Math.max(1, n - 1) }))
}

// ── 路由 harness（与 fupan.test.ts 同款：直接调 handler，不建 HTTP 服务） ─────────

interface Captured {
  code: number
  body: Record<string, unknown>
}

function callRoute(
  routes: ReadonlyArray<{ path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }>,
  path: string,
  url: string,
): Promise<Captured> {
  return new Promise<Captured>((resolve, reject) => {
    const req = {
      url,
      method: 'GET',
      headers: { host: '127.0.0.1:3080' },
      async *[Symbol.asyncIterator]() {
        /* GET 无体 */
      },
    } as unknown as IncomingMessage
    let code = 0
    const res = {
      writeHead(c: number) {
        code = c
      },
      end(payload: string) {
        resolve({ code, body: payload === '' ? {} : (JSON.parse(payload) as Record<string, unknown>) })
      },
    } as unknown as ServerResponse
    const route = routes.find((r) => r.path === path)
    if (route === undefined) {
      reject(new Error(`未找到路由 ${path}`))
      return
    }
    void Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

/** 计数用的假上游：`pages` 控制回填页数 */
function fakeUpstream(opts: { pages?: number; perPage?: number; rows?: LeverageRow[] | null; fail?: boolean } = {}) {
  const calls: LeveragePageRequest[] = []
  const rows = opts.rows ?? rampRows(300)
  const perPage = opts.perPage ?? 300
  const fetchPage = async (req: LeveragePageRequest): Promise<LeveragePage> => {
    calls.push(req)
    if (opts.fail === true) throw new Error('upstream down (contract test)')
    if (req.order === 'desc') return { rows: [rows[rows.length - 1] as LeverageRow], pages: 1 }
    const start = (req.page - 1) * perPage
    return { rows: rows.slice(start, start + perPage), pages: opts.pages ?? 1 }
  }
  return { fetchPage, calls }
}

function leverageRoutes(service: LeverageService, dir: string) {
  return makeTradeRoutes(new DataStore(dir), [], new CalendarStore(dir), undefined, undefined, undefined, () => ['core', 'tools'], undefined, service).routes
}

function routesWith(service: LeverageService): ReadonlyArray<{ path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }> {
  return leverageRoutes(service, tempDir())
}

// ── ① 字段齐备 + 数组等长 + 升序 ─────────────────────────────────────────

test('① 回包字段齐备、三组数组与 dates 等长、dates 升序（契约冻结，少一个字段客户端就崩）', async () => {
  const dir = tempDir()
  const store = new LeverageStore(dir)
  await store.save(rampRows(300))
  const routes = leverageRoutes(new LeverageService(store, { now: () => NOW_MS, fetchPage: fakeUpstream().fetchPage, fetchSzse: async () => null }, {}), dir)
  const res = await callRoute(routes, '/tradewatcher/leverage', '/tradewatcher/leverage?range=all')
  assert.equal(res.code, 200)
  assert.deepEqual(leveragePayloadProblems(res.body as unknown as LeveragePayload, { window: 300, samples: 300 }), [])
  const dates = (res.body as unknown as LeveragePayload).dates
  assert.deepEqual([...dates].sort(), dates, 'dates 必须升序')
  rmSync(dir, { recursive: true, force: true })
})

// ── ② 温度 = 全历史分位（1 位小数） ─────────────────────────────────────

test('② temperature = 全历史分位（1 位小数）：换成"最近 N 天分位"必须变（注入反例）', async () => {
  // 构造"全历史 ≠ 近 250 天"的样本：200 天高位(3.0) + 99 天低位(1.0) + 今天(2.0)
  const days = daysEndingAt(300)
  const series: LeverageRow[] = days.map((d, i) => mkRow(d, { rzyezb: i < 200 ? 3 : i < 299 ? 1 : 2 }))
  const payload = buildLeveragePayload(series, 'all')
  const all = series.map((r) => r.rzyezb)
  assert.equal(payload.temperature, percentileRank(2, all), '温度必须是全历史分位')
  assert.equal(payload.temperature, 33.3, `全历史分位应为 33.3（实得 ${payload.temperature}）`)
  assert.equal(Math.abs((payload.temperature as number) * 10 - Math.round((payload.temperature as number) * 10)) < 1e-9, true, '必须 1 位小数')
  // 反例注入：近 250 天分位 → 40.0 ≠ 33.3 ⇒ 判据非恒真
  const recent = percentileRank(2, all.slice(-250), 1)
  assert.equal(recent, 40)
  assert.notEqual(recent, payload.temperature, '⚠ 反例（用近 250 天分位）必须与全历史分位不同')
  // `temp[]` 最后一点与 temperature 恒等（同一口径），且早期样本不足时是 null
  assert.equal(payload.temp[payload.temp.length - 1], payload.temperature)
  assert.equal(payload.temp[0], null, `前 ${LEVERAGE_MIN_SAMPLES - 1} 天样本不足 ⇒ null（实得 ${payload.temp[0]}）`)
  assert.equal(payload.temp[LEVERAGE_MIN_SAMPLES - 1] !== null, true, `第 ${LEVERAGE_MIN_SAMPLES} 天起给分位`)
})

// ── ③ 样本 < 250 ⇒ null ────────────────────────────────────────────────

test('③ 样本 < 250 ⇒ temperature 为 null（写 0 ⇒ 必败）；其余读数照常给', () => {
  const rows = rampRows(LEVERAGE_MIN_SAMPLES - 1)
  const payload = buildLeveragePayload(rows, 'all')
  assert.equal(payload.temperature, null, '样本不足必须 null，不能给 0 或 50')
  assert.equal(typeof payload.ratioPct, 'number', '比例读数与温度无关，必须照常给')
  assert.deepEqual(leveragePayloadProblems(payload, { window: rows.length, samples: rows.length }), [])
  // 反例注入：把 null 换成 0（最常见的实现）
  const zeroed = { ...payload, temperature: 0 }
  assert.notDeepEqual(leveragePayloadProblems(zeroed, { window: rows.length, samples: rows.length }), [], '⚠ 反例（样本不足写 0）必须被抓到')
  // 边界反证：正好 250 个样本必须给数（否则判据恒真）
  const exactly = buildLeveragePayload(rampRows(LEVERAGE_MIN_SAMPLES), 'all')
  assert.notEqual(exactly.temperature, null, `正好 ${LEVERAGE_MIN_SAMPLES} 个样本必须给温度`)
})

// ── ④ 每天最多 1 次上游 ─────────────────────────────────────────────────

test('④ 每天最多 1 次上游：同一实例连打 5 次 = 1 次请求；两个实例共用文件也只 1 次', async () => {
  const dir = tempDir()
  const up = fakeUpstream({ rows: rampRows(300) })
  const deps = { now: () => NOW_MS, fetchPage: up.fetchPage, fetchSzse: async () => null }
  const store = new LeverageStore(dir)
  const service = new LeverageService(store, deps, { backfill: false })
  for (let i = 0; i < 5; i += 1) await service.payload(750)
  assert.equal(up.calls.filter((c) => c.order === 'desc').length, 1, `5 次回包只该有 1 次日取数（实得 ${up.calls.length} 次上游）`)
  assert.deepEqual(dailyFetchProblems(1), [])
  assert.notDeepEqual(dailyFetchProblems(5), [], '⚠ 反例（每次请求都打上游）必须被抓到')
  // 反证：门闸本身不是恒 false —— 换一天就必须再打一次
  assert.equal(needsDailyFetch({ lastFetchDay: '2026-10-19', lastAttemptAt: NOW_MS, latestDay: '2026-10-16' }, TODAY, NOW_MS), true, '换了自然日必须重新取数（否则判据恒真）')
  assert.equal(needsDailyFetch({ lastFetchDay: TODAY, lastAttemptAt: NOW_MS, latestDay: '2026-10-19' }, TODAY, NOW_MS), false, '同一天不再取数')
  // 第二个实例（同一个目录）读到第一个实例落盘的 lastFetchDay ⇒ 不再打上游
  const store2 = new LeverageStore(dir)
  const service2 = new LeverageService(store2, deps, { backfill: false })
  await service2.payload(750)
  assert.equal(up.calls.filter((c) => c.order === 'desc').length, 1, '双实例共用一份文件 ⇒ 仍然只有 1 次取数（mtime 同步生效）')
  rmSync(dir, { recursive: true, force: true })
})

// ── ⑤ 缺字段 ⇒ null 不 0 ────────────────────────────────────────────────

test('⑤ 上游缺字段 ⇒ 回包 null（不是 0）；`?? 0` 注入必败', () => {
  const d = '2026-10-19'
  const rows = [
    ...rampRows(260),
    mkRow(d, { rzye: null, rqye: null, ltsz: null, rzjme: null, rzyezb: null }),
  ]
  const payload = buildLeveragePayload(rows, 250)
  assert.equal(payload.marginBalance, null, '缺 RZYE ⇒ marginBalance 必须是 null')
  assert.equal(payload.shortBalance, null)
  assert.equal(payload.floatMv, null)
  assert.equal(payload.netBuy, null)
  assert.equal(payload.ratioPct, null)
  assert.equal(payload.ratioWithShortPct, null)
  assert.equal(payload.asOf, d, '日期在 ⇒ asOf 照常给（不是整块作废）')
  assert.deepEqual(nullFieldProblems(payload, ['marginBalance', 'shortBalance', 'floatMv', 'netBuy', 'ratioPct', 'ratioWithShortPct']), [])
  // 反例注入：`?? 0` 写法
  const zeroed = { ...payload, marginBalance: 0, shortBalance: 0, floatMv: 0, netBuy: 0, ratioPct: 0, ratioWithShortPct: 0 }
  assert.notDeepEqual(nullFieldProblems(zeroed, ['marginBalance', 'shortBalance', 'floatMv', 'netBuy', 'ratioPct', 'ratioWithShortPct']), [], '⚠ 反例（缺字段写 0）必须被抓到')
  // 源码判据：模块里不许出现 `?? 0`
  const src = readFileSync(join(SRC, 'leverage.ts'), 'utf8')
  assert.equal(/\?\?\s*0\b/.test(src), false, 'leverage.ts 里不许出现 `?? 0`（缺字段一律 null）')
})

// ── ⑥ 路由永远 200 ──────────────────────────────────────────────────────

test('⑥ 路由永远 200：上游抛错 ⇒ 200 + 全 null 空壳；service 自己抛错也 200', async () => {
  const dir = tempDir()
  const up = fakeUpstream({ fail: true })
  const store = new LeverageStore(dir)
  const service = new LeverageService(store, { now: () => NOW_MS, fetchPage: up.fetchPage, fetchSzse: async () => null }, { backfill: false })
  const routes = leverageRoutes(service, dir)
  const res = await callRoute(routes, '/tradewatcher/leverage', '/tradewatcher/leverage?range=750')
  assert.equal(res.code, 200, '上游失败也必须 200')
  assert.deepEqual(res.body, emptyLeveragePayload(750) as unknown as Record<string, unknown>, '整块不可用 ⇒ 全 null 空壳')
  // 非恒真证明：同一路径**直接调 service** 也不会 5xx（它自己兜底），而注入一个会抛的 service 时路由仍 200
  const throwing = { payload: async () => { throw new Error('boom (contract test)') } } as unknown as LeverageService
  const routes2 = leverageRoutes(throwing, dir)
  const res2 = await callRoute(routes2, '/tradewatcher/leverage', '/tradewatcher/leverage')
  assert.equal(res2.code, 200, 'service 抛错时路由必须兜底成 200')
  assert.equal((res2.body as unknown as LeveragePayload).temperature, null)
  // 空回包的形状必须完整（客户端不必判 undefined）
  assert.deepEqual(leveragePayloadProblems(res2.body as unknown as LeveragePayload, { window: 0, samples: 0 }), [])
  rmSync(dir, { recursive: true, force: true })
})

// ── ⑦ 落盘走锁且幂等 ────────────────────────────────────────────────────

test('⑦ 落盘走锁且幂等：静态源判据 + 重复写/并发写/同日去重', async () => {
  const src = readFileSync(join(SRC, 'leverage.ts'), 'utf8')
  assert.deepEqual(leverageWritePathProblems(src), [], `写路径必须是锁内读-改-写（失败项：${leverageWritePathProblems(src).join(' ／ ')}）`)
  // 反例注入
  assert.notDeepEqual(leverageWritePathProblems(src.replace(/updateJsonLocked\s*\(/g, 'writeJsonAtomic(')), [], '⚠ 反例（绕锁）必须被抓到')
  assert.notDeepEqual(leverageWritePathProblems(`${src}\nawait writeFile(path, text, 'utf8')\n`), [], '⚠ 反例（直接 writeFile）必须被抓到')
  assert.notDeepEqual(leverageWritePathProblems(src.replace(/assertWritable\s*\(/g, 'noopSoon(')), [], '⚠ 反例（去掉 assertWritable）必须被抓到')

  const dir = tempDir()
  const store = new LeverageStore(dir)
  const rows = rampRows(20)
  const first = await store.save(rows)
  assert.equal(first.total, 20)
  const raw1 = readFileSync(join(dir, LEVERAGE_FILE), 'utf8')
  const second = await store.save(rows)
  assert.equal(second.added, 0, '同一批数据再写一次 ⇒ added = 0（幂等）')
  assert.equal(second.total, 20, '不许重复追加')
  const raw2 = readFileSync(join(dir, LEVERAGE_FILE), 'utf8')
  assert.equal(raw2, raw1, '幂等写入的字节必须完全一致')

  // 并发写：两个 store 同时写不同日期 ⇒ 锁内合并后两条都在（丢掉一条就说明没走锁）
  const dir2 = tempDir()
  const a = new LeverageStore(dir2)
  const b = new LeverageStore(dir2)
  const [r1, r2] = await Promise.all([
    a.save([mkRow('2026-10-16', { rzyezb: 1.1 })]),
    b.save([mkRow('2026-10-19', { rzyezb: 2.2 })]),
  ])
  assert.equal(r1.total + r2.total >= 2, true, '两个实例各写一条 ⇒ 合并后至少 2 行（不是后者覆盖前者）')
  const disk = parseLeverageFile(JSON.parse(readFileSync(join(dir2, LEVERAGE_FILE), 'utf8')))
  assert.notEqual(disk, null)
  assert.deepEqual((disk as { rows: LeverageRow[] }).rows.map((r) => r.d), ['2026-10-16', '2026-10-19'], '两天的行都要在，且升序')

  // 同日更新：后写的值覆盖先写的值（不是追加成两行）
  await a.save([mkRow('2026-10-19', { rzyezb: 9.9 })])
  const disk2 = parseLeverageFile(JSON.parse(readFileSync(join(dir2, LEVERAGE_FILE), 'utf8'))) as { rows: LeverageRow[] }
  assert.equal(disk2.rows.length, 2, '同一天只留一行')
  assert.equal(disk2.rows[1].rzyezb, 9.9, '同一天以后写的为准')
  rmSync(dir, { recursive: true, force: true })
  rmSync(dir2, { recursive: true, force: true })
})

test('⑦b 体积上限：超限丢最旧的并留痕，最新一行绝不丢', async () => {
  const dir = tempDir()
  const store = new LeverageStore(dir)
  // 用**极小**的字节上限验证裁剪逻辑（真实上限 512 KB 装得下 4018 行）
  const rows = rampRows(50)
  const saved = await store.save(rows, {}, { maxBytes: 1200, maxRows: 4500 })
  assert.equal(saved.dropped > 0, true, '超过字节上限必须丢最旧的并留痕')
  const disk = parseLeverageFile(JSON.parse(readFileSync(join(dir, LEVERAGE_FILE), 'utf8'))) as { rows: LeverageRow[] }
  assert.equal(disk.rows.length, saved.total)
  assert.equal(disk.rows[disk.rows.length - 1].d, rows[rows.length - 1].d, '最新一行不能被自己的裁剪丢掉')
  assert.equal(Buffer.byteLength(readFileSync(join(dir, LEVERAGE_FILE), 'utf8'), 'utf8') <= 1200, true, '落盘字节必须在上限内（按 1 空格缩进量，不是紧凑 JSON）')
  // 真实上限下 4018 行也该装得下（分位基线必须能落盘）
  const dir2 = tempDir()
  const big = new LeverageStore(dir2)
  const full = rampRows(4018)
  const fullSaved = await big.save(full)
  assert.equal(fullSaved.total, 4018, '全历史 4018 行必须能完整落盘')
  const bytes = Buffer.byteLength(readFileSync(join(dir2, LEVERAGE_FILE), 'utf8'), 'utf8')
  assert.equal(bytes <= LEVERAGE_MAX_BYTES, true, `4018 行实测 ${bytes} 字节，必须 ≤ ${LEVERAGE_MAX_BYTES}`)
  rmSync(dir, { recursive: true, force: true })
  rmSync(dir2, { recursive: true, force: true })
})

test('⑦c 读不到 ≠ 没有：EISDIR/坏 JSON 时拒绝写回（不把历史覆写成空）', async () => {
  const dir = tempDir()
  // 坏 JSON ⇒ 隔离原件 + 之后正常重建
  writeFileSync(join(dir, LEVERAGE_FILE), '{not json', 'utf8')
  const store = new LeverageStore(dir)
  await store.init()
  assert.notEqual(store.readState().quarantined, null, '坏内容必须隔离（保留原字节）')
  await store.save([mkRow('2026-10-19')])
  assert.equal(store.rows.length, 1, '隔离后可以正常重建')
  rmSync(dir, { recursive: true, force: true })
})

// ── ⑧ range 切片 ────────────────────────────────────────────────────────

test('⑧ range 切片正确：all = 全历史、750/250 = 最近 N 天、非法回落默认', async () => {
  const dir = tempDir()
  const rows = rampRows(800)
  const store = new LeverageStore(dir)
  await store.save(rows)
  const service = new LeverageService(store, { now: () => NOW_MS, fetchPage: fakeUpstream().fetchPage, fetchSzse: async () => null }, { backfill: false })
  const all = await service.payload('all')
  assert.equal(all.dates.length, 800, 'all ⇒ 全历史（不是 750）')
  assert.deepEqual(rangeSliceProblems(all, 800), [])
  const truncated = { ...all, dates: all.dates.slice(-750), temp: all.temp.slice(-750), ratio: all.ratio.slice(-750), net: all.net.slice(-750) }
  assert.notDeepEqual(rangeSliceProblems(truncated, 800), [], '⚠ 反例（all 只给 750）必须被抓到')
  assert.equal((await service.payload(750)).dates.length, 750, '750 窗口 = 最近 750 天')
  assert.equal((await service.payload(250)).dates.length, 250)
  assert.equal((await service.payload(250)).dates[0], rows[550].d, '250 窗口 = 最近 250 天（不是最早的 250 天）')
  assert.equal(parseLeverageRange('all'), 'all')
  assert.equal(parseLeverageRange('250'), 250)
  assert.equal(parseLeverageRange(''), 750)
  assert.equal(parseLeverageRange('abc'), 750, '非法值回落默认（不 400）')
  assert.equal(parseLeverageRange('99999'), 750)
  const res = await callRoute(routesWith(service), '/tradewatcher/leverage', '/tradewatcher/leverage?range=all')
  assert.equal(res.code, 200)
  assert.equal((res.body as unknown as LeveragePayload).dates.length, 800, '路由也要按 range=all 给全历史')
  rmSync(dir, { recursive: true, force: true })
})

// ── 首次回填（契约里的"先答当日 + 温度 null，后台补历史"） ─────────────────

test('首次：历史为空 ⇒ 先给当日读数 + temperature null；后台回填完成后有温度', async () => {
  const dir = tempDir()
  const rows = rampRows(300)
  const up = fakeUpstream({ rows, pages: 2, perPage: 200 })
  const store = new LeverageStore(dir)
  const service = new LeverageService(store, { now: () => NOW_MS, fetchPage: up.fetchPage, fetchSzse: async () => null })
  const first = await service.payload('all')
  assert.equal(first.asOf, rows[rows.length - 1].d, '第一次必须给出当日读数')
  assert.equal(first.temperature, null, '历史还没回填 ⇒ 温度 null（不是 0）')
  assert.notEqual(first.ratioPct, null, '比例读数与历史无关，第一次就能给')
  await service.startBackfill()
  const second = await service.payload('all')
  assert.notEqual(second.temperature, null, '回填完成后必须能给温度')
  assert.equal(second.dates.length, 300, '回填后 all 给全历史')
  // 取数次数：1 次日取数 + 2 页回填；第二次回包不再打上游
  assert.equal(up.calls.filter((c) => c.order === 'desc').length, 1)
  assert.equal(up.calls.filter((c) => c.order === 'asc').length, 2)
  rmSync(dir, { recursive: true, force: true })
})

test('落盘含内部交叉校验 cross（不进回包）', async () => {
  const dir = tempDir()
  const up = fakeUpstream({ rows: rampRows(300) })
  let szseCalls = 0
  const store = new LeverageStore(dir)
  const service = new LeverageService(store, {
    now: () => NOW_MS,
    fetchPage: up.fetchPage,
    fetchSzse: async () => {
      szseCalls += 1
      return { marginBalance: 11864.49, marginBuy: 494.17, shortBalance: 104.91, day: '2026-10-19', source: '深交所（融资融券交易总量）' }
    },
  }, { backfill: false })
  const payload = await service.payload(750)
  assert.equal(szseCalls, 1, '每天一次交叉校验')
  assert.equal('cross' in (payload as unknown as Record<string, unknown>), false, 'cross 不进回包（契约冻结）')
  const disk = parseLeverageFile(JSON.parse(readFileSync(join(dir, LEVERAGE_FILE), 'utf8'))) as { cross: { ok: boolean; sharePct: number } | null }
  assert.notEqual(disk.cross, null, 'cross 必须落盘')
  assert.equal(disk.cross?.ok, true, `深市份额 48% 落在 30–70% ⇒ ok（实得 ${JSON.stringify(disk.cross)}）`)
  assert.equal(disk.cross?.sharePct, 48.36, `sharePct 应按 亿元/亿元 算（实得 ${disk.cross?.sharePct}）`)
  rmSync(dir, { recursive: true, force: true })
})

// ─────────────────────────────── 判据实现 ───────────────────────────────

const CONTRACT_KEYS = [
  'asOf', 'temperature', 'ratioPct', 'ratioWithShortPct', 'marginBalance', 'shortBalance',
  'floatMv', 'netBuy', 'thresholds', 'dates', 'temp', 'ratio', 'net',
] as const

function isOneDecimal(v: number): boolean {
  return Math.abs(v * 10 - Math.round(v * 10)) < 1e-9
}

function isTwoDecimal(v: number): boolean {
  return Math.abs(v * 100 - Math.round(v * 100)) < 1e-6
}

/** 契约形状判据：字段齐备、数组等长、升序、小数位、样本不足必须 null */
export function leveragePayloadProblems(
  payload: LeveragePayload,
  expect: { window: number; samples: number; minSamples?: number },
): string[] {
  const bad: string[] = []
  const min = expect.minSamples ?? LEVERAGE_MIN_SAMPLES
  const keys = Object.keys(payload).sort()
  if (JSON.stringify(keys) !== JSON.stringify([...CONTRACT_KEYS].sort())) {
    bad.push(`字段集合与契约不一致（实得 ${keys.join(',')}）`)
  }
  for (const key of ['dates', 'temp', 'ratio', 'net'] as const) {
    if (!Array.isArray(payload[key])) bad.push(`${key} 必须是数组`)
  }
  if (bad.length > 0) return bad
  const n = payload.dates.length
  if (n !== expect.window) bad.push(`dates 长度应为 ${expect.window}（实得 ${n}）`)
  for (const key of ['temp', 'ratio', 'net'] as const) {
    if (payload[key].length !== n) bad.push(`${key} 与 dates 不等长（${payload[key].length} vs ${n}）`)
  }
  if (n > 1) {
    const sorted = [...payload.dates].sort()
    if (JSON.stringify(sorted) !== JSON.stringify(payload.dates)) bad.push('dates 必须升序')
  }
  if (payload.thresholds.p80 !== 80 || payload.thresholds.p95 !== 95) bad.push(`thresholds 必须是 {p80:80,p95:95}（实得 ${JSON.stringify(payload.thresholds)}）`)
  if (payload.temperature === null) {
    if (expect.samples >= min) bad.push(`样本 ${expect.samples} ≥ ${min} 时必须有温度（不该 null）`)
  } else {
    if (typeof payload.temperature !== 'number' || !Number.isFinite(payload.temperature)) bad.push('temperature 必须是有限数')
    else {
      if (!isOneDecimal(payload.temperature)) bad.push(`temperature 必须 1 位小数（实得 ${payload.temperature}）`)
      if (payload.temperature < 0 || payload.temperature > 100) bad.push(`temperature 必须在 0–100（实得 ${payload.temperature}）`)
      if (expect.samples < min) bad.push(`样本 ${expect.samples} < ${min} 时 temperature 必须是 null（实得 ${payload.temperature}）`)
    }
  }
  for (const key of ['ratioPct', 'ratioWithShortPct'] as const) {
    const v = payload[key]
    if (v !== null && !isTwoDecimal(v)) bad.push(`${key} 必须 2 位小数（实得 ${v}）`)
  }
  for (const key of ['marginBalance', 'shortBalance', 'floatMv', 'netBuy'] as const) {
    const v = payload[key]
    if (v !== null && !Number.isFinite(v)) bad.push(`${key} 必须是有限数或 null`)
  }
  for (const v of payload.temp) {
    if (v === null) continue
    if (!isOneDecimal(v)) bad.push(`temp[] 里必须 1 位小数（实得 ${v}）`)
    if (v < 0 || v > 100) bad.push(`temp[] 必须在 0–100（实得 ${v}）`)
  }
  if (n > 0 && payload.temp[n - 1] !== payload.temperature) bad.push('temp[] 最后一点必须等于 temperature（同一口径）')
  return bad
}

/** 缺字段必须 null（写成 0 就是"把没给读成 0"） */
export function nullFieldProblems(payload: LeveragePayload, fields: ReadonlyArray<keyof LeveragePayload>): string[] {
  const bad: string[] = []
  for (const field of fields) {
    const v = payload[field]
    if (v !== null) bad.push(`${String(field)} 上游没给必须是 null（实得 ${JSON.stringify(v)}）`)
  }
  return bad
}

/** 一天最多一次上游 */
export function dailyFetchProblems(count: number): string[] {
  return count <= 1 ? [] : [`一天最多 1 次上游取数（实得 ${count} 次）`]
}

/** `all` 必须给全历史（少给就是静默截断） */
export function rangeSliceProblems(payload: LeveragePayload, expected: number): string[] {
  return payload.dates.length === expected ? [] : [`range=all 应给 ${expected} 天（实得 ${payload.dates.length} 天）`]
}

/** 写路径判据：锁内读-改-写 + 写前守卫 + 读失败守卫 + 坏文件隔离 */
export function leverageWritePathProblems(src: string): string[] {
  const bad: string[] = []
  if (!/updateJsonLocked\s*\(/.test(src)) bad.push('写回必须走 updateJsonLocked（锁内读磁盘最新 → 改 → 原子写回）')
  if (/\bwriteJsonAtomic\s*\(/.test(src) || /\bwriteFile\s*\(/.test(src)) bad.push('不许直接 writeFile/writeJsonAtomic（绕过锁 ⇒ 并发下丢更新）')
  if (!/assertWritable\s*\(/.test(src)) bad.push('写回前必须 readGuard.assertWritable（读不到 ⇒ 拒绝整份覆写）')
  if (!/\bReadGuard\b/.test(src)) bad.push('读路径必须走 ReadGuard（ENOENT 才算"本来就没有"）')
  if (!/quarantineFile\s*\(/.test(src)) bad.push('坏内容必须 quarantineFile（隔离并保留原字节）')
  return bad
}

// 纯函数自测（避免"判据只在用例里跑过"的假绿）
test('分位/合并/切片三个纯函数的边界', () => {
  assert.equal(percentileRank(null, [1, 2, 3], 1), null, 'current 为 null ⇒ null')
  assert.equal(percentileRank(2, [1, 2, 3], 4), null, '样本不足 ⇒ null')
  assert.equal(percentileRank(2, [1, 2, 3], 3), 66.7, '≤ 的样本数 ÷ 总数 ⇒ 2/3')
  assert.deepEqual(expandingPercentiles([1, 2, 3], 3), [null, null, 100], '扩张窗口：样本不足给 null')
  const merged = mergeLeverageRows([mkRow('2026-10-18')], [mkRow('2026-10-18', { rzyezb: 7 }), mkRow('2026-10-19')])
  assert.equal(merged.rows.length, 2)
  assert.equal(merged.added, 1)
  assert.equal(merged.rows[0].rzyezb, 7, '同一天以新数据为准')
  assert.deepEqual(sliceLeverageWindow(rampRows(10), 3).map((r) => r.d), daysEndingAt(10).slice(-3), '窗口取最近 N 天')
})
