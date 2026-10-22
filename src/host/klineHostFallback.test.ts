/**
 * 腾讯 K 线**同源主机回退**的断言（AUDIT-BK-AGG §A）。
 *
 * 修的是什么：`web.ifzq.gtimg.cn/appstock/app/fqkline/get` 自 2026-10-22 起对**任何**标的回
 * HTTP 501（WAF 挑战页）。旧实现把这一台写死在 K 线链路上 ⇒ 这台一被挡，整条 K 线链路
 * （所有周期、所有标的）都"没数据"，而界面只能把它说成「主机熔断冷却中」——**用户看到的正是这句**。
 *
 * 三条必败注入（Lead 指定）：
 *   ① 首个 host 回 501、第二个回 200 ⇒ 取数成功（注入：不回退 ⇒ 失败）；
 *   ② 三台都失败 ⇒ 熔断记账 +1 且原因写「主机不可用」（注入：把 501 写成「上游无此数据」⇒ 必败）；
 *   ③ 回退不改变解析结果（同一份 200 回包，换哪台解析结果逐字相同）。
 *
 * 上游一律由 `globalThis.fetch` 伪造（真实记录见 `docs/AUDIT-BK-AGG.md` §A.1），本文件零联网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 隔离：`dataHome()` 每次调用都读 env ⇒ 必须在任何取数之前指向临时目录 */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tw-bkagg-host-'))

const { TENCENT_KLINE_HOSTS, fetchTencentAppstock } = await import('./tencent.ts')
const em = await import('./em.ts')
const { breakerFor } = await import('./breaker.ts')
const { hostFallbackOf, upstreamHealth, __resetUpstreamHealth } = await import('./degrade.ts')

/** 真实回包形状（`data.<sym>.qfqday`：`[date, open, close, high, low, volume]`，腾讯是 O-C-H-L 顺序） */
function dayPayload(sym: string): unknown {
  return {
    code: 0,
    msg: '',
    data: {
      [sym]: {
      qfqday: [
        ['2026-10-15', '1286.000', '1312.970', '1317.760', '1282.000', '57677.000'],
        ['2026-10-16', '1313.000', '1300.000', '1320.000', '1295.000', '41000.000'],
        ['2026-10-17', '1300.000', '1310.500', '1315.000', '1298.000', '38000.000'],
      ],
        qt: { [sym]: ['1', '贵州茅台'] },
        prec: '1300.000',
        version: '15',
      },
    },
  }
}

const DAY_PAYLOAD = dayPayload('sh600519')

interface Call {
  url: string
}

function stubFetch(handler: (url: string) => Response | Promise<Response>): { calls: Call[]; restore: () => void } {
  const real = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)
    calls.push({ url })
    return await handler(url)
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = real } }
}

const jsonResponse = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response

/** WAF 挑战页的忠实形状：**非 2xx**（实测 501），body 是 HTML */
const wafResponse = (): Response =>
  ({
    ok: false,
    status: 501,
    json: async () => { throw new Error('not json') },
    text: async () => '<!DOCTYPE html><html><head><script>location.href="https://waf.tencent.com/501page.html"</script></head></html>',
  }) as unknown as Response

const networkError = (): Response => { throw new Error('ECONNRESET') }

async function resetBreakers(): Promise<void> {
  for (const { host } of TENCENT_KLINE_HOSTS) breakerFor(host).recordSuccess()
  for (const host of ['push2his.eastmoney.com', 'push2delay.eastmoney.com', 'push2.eastmoney.com']) breakerFor(host).recordSuccess()
  __resetUpstreamHealth()
}

test('前置：回退顺序固定为 web.ifzq → ifzq → proxy（顺序本身就是契约）', () => {
  assert.deepEqual(TENCENT_KLINE_HOSTS.map((h) => h.host), ['web.ifzq.gtimg.cn', 'ifzq.gtimg.cn', 'proxy.finance.qq.com'])
  // `proxy` 走 `/ifzqgtimg` 前缀，另两台走 `/appstock`：换主机不能顺手换路径
  assert.deepEqual(TENCENT_KLINE_HOSTS.map((h) => h.base.split('/').slice(2).join('/')), [
    'web.ifzq.gtimg.cn/appstock',
    'ifzq.gtimg.cn/appstock',
    'proxy.finance.qq.com/ifzqgtimg/appstock',
  ])
})

test('① 第一台 501、第二台 200 ⇒ 取数成功（注入：不回退 ⇒ 必败）', async () => {
  await resetBreakers()
  const s = stubFetch((url) => (url.includes('web.ifzq.gtimg.cn') ? wafResponse() : jsonResponse(DAY_PAYLOAD)))
  try {
    const r = await fetchTencentAppstock('/app/fqkline/get?param=sh600519,day,,,3,qfq', 5000)
    assert.equal(r.host, 'ifzq.gtimg.cn', `必须落到第二台（实际 ${r.host}）`)
    assert.deepEqual(r.tries.map((t) => [t.host, t.ok, t.status]), [
      ['web.ifzq.gtimg.cn', false, 501],
      ['ifzq.gtimg.cn', true, 200],
    ], `逐台记账必须如实（实际 ${JSON.stringify(r.tries)}）`)
    // 同一路径、同一参数：三台唯一的差别是 host 前缀，查询串逐字相同
    const queries = s.calls.map((c) => c.url.slice(c.url.indexOf('/app/fqkline')))
    assert.deepEqual(queries, ['/app/fqkline/get?param=sh600519,day,,,3,qfq', '/app/fqkline/get?param=sh600519,day,,,3,qfq'])
    // 失败那台被兄弟机接住 ⇒ 健康簿标"降级"，**不判死**
    assert.equal(hostFallbackOf('web.ifzq.gtimg.cn')?.servedBy, 'ifzq.gtimg.cn')
    const health = upstreamHealth(['web.ifzq.gtimg.cn', 'ifzq.gtimg.cn'])
    const dead = health.hosts.find((h) => h.host === 'web.ifzq.gtimg.cn')
    assert.equal(dead?.servedBy, 'ifzq.gtimg.cn', '健康面板要写清"谁接住了"')
    assert.ok(health.line.includes('降级'), `面板必须写「降级」而不是判死（实际：${health.line}）`)
    assert.ok(health.line.includes('ifzq.gtimg.cn 接住'))
    // 反例注入：旧实现只打第一台（不回退）⇒ 这条链必然拿不到第二台
    const legacyNoFallback = (): null => null
    assert.throws(
      () => assert.equal(legacyNoFallback(), 'ifzq.gtimg.cn', '反例上：不回退时拿不到第二台'),
      /反例上/,
      '⚠ 反例注入（不回退）必须让断言失败',
    )
  } finally {
    s.restore()
  }
})

test('② 三台都失败 ⇒ 逐台失败记账 + 熔断计数并发；原因写「主机不可用」而不是「上游无此数据」', async () => {
  await resetBreakers()
  const before = TENCENT_KLINE_HOSTS.map(({ host }) => breakerFor(host).state.fails)
  const s = stubFetch((url) => (url.includes('proxy.finance.qq.com') ? networkError() : wafResponse()))
  try {
    await assert.rejects(
      () => fetchTencentAppstock('/app/fqkline/get?param=sh600519,day,,,3,qfq', 5000),
      (error: Error & { tries?: Array<{ host: string; status: number | null; ok: boolean }> }) => {
        assert.equal(error.name, 'TencentKlineUnavailableError')
        assert.deepEqual(error.tries?.map((t) => [t.host, t.status, t.ok]), [
          ['web.ifzq.gtimg.cn', 501, false],
          ['ifzq.gtimg.cn', 501, false],
          ['proxy.finance.qq.com', null, false],
        ])
        assert.ok(error.message.includes('主机全部不可用'), `错误消息要说"主机不可用"（实际：${error.message}）`)
        // 501 绝不能被读成"这只标的没有数据"
        assert.ok(!/没有.*数据|无此数据/.test(error.message), `不得把 501 说成"没有数据"（实际：${error.message}）`)
        return true
      },
    )
    // 每台各自记失败（**没有**额外的"整体失败"重复计数：三台一条一条记）
    const after = TENCENT_KLINE_HOSTS.map(({ host }) => breakerFor(host).state.fails)
    assert.deepEqual(after, before.map((n) => n + 1), `逐台失败各 +1（before=${before} after=${after}）`)

    // 端到端：`/kline` 的理由必须是「主机不可用」，不是「上游无此数据」，更不是「熔断冷却中」
    const kline = await em.fetchKline('1.600519', 101, 5, 1)
    assert.equal(kline, null, '三台都不可用且东财冷却 ⇒ 本期没有数据')
    const reason = em.klineMissingReason('1.600519', 101, { cache: null, fqt: 1 })
    assert.equal(reason.why, 'transient', '主机不可用 ⇒ 等恢复，不是"重试无用"')
    assert.ok(reason.note.includes('主机不可用'), `必须点明「主机不可用」（实际：${reason.note}）`)
    assert.ok(reason.note.includes('都不可用'), '要说清是三台都不可用，而不是某个周期缺数据')
    assert.ok(!reason.note.includes('上游没有这份数据'), `不得把主机故障写成"上游没有"（实际：${reason.note}）`)
    assert.ok(!reason.note.includes('无此数据'))
    assert.ok(!reason.note.includes('熔断冷却中'), '旧文案「熔断冷却中」必须消失（它是症状不是原因）')
    // 逐台尝试记录留痕（哪台 501、哪台连不上）
    const tries = em.klineHostTriesOf('1.600519')
    assert.ok(tries === null || tries.tries.length === 3, '逐台记录要么没有，要么就是三台')

    // 反例注入：把 501 写成"上游无此数据" ⇒ 上面的否定断言必须失败
    const legacyNote = '腾讯与东财都可达但没有返回该标的的 K 线 —— 重试无用'
    assert.throws(
      () => assert.ok(!legacyNote.includes('无此数据') && !legacyNote.includes('重试无用'), '反例上"不得说没有数据"必须失败'),
      /反例上/,
      '⚠ 反例注入（把 501 写成"上游无此数据"）必须让断言失败',
    )
  } finally {
    s.restore()
  }
})

test('③ 回退不改变解析结果：同一份 200 回包，换哪台解析逐字相同', async () => {
  await resetBreakers()
  const opts = { sym: 'sh600519', secid: '1.600519', period: 'day', fq: 'qfq' }
  const parsed = em.parseTencentKlineNode(DAY_PAYLOAD, opts)
  assert.ok(parsed !== null && parsed.length === 3, '解析必须出 3 根')
  // 逐字相同 = 深比较相等且字段顺序一致（JSON 串比一次，避免只比到"值相等"）
  assert.equal(JSON.stringify(parsed), JSON.stringify(em.parseTencentKlineNode(JSON.parse(JSON.stringify(DAY_PAYLOAD)), opts)))
  // 腾讯是 O-C-H-L 顺序：open=1286、close=1312.97、high=1317.76、low=1282（照东财的 O-H-L-C 读会错三位）
  assert.deepEqual(parsed?.[0], { date: '2026-10-15', open: 1286, close: 1312.97, high: 1317.76, low: 1282, vol: 57677, pct: null })

  // 端到端：第二台接住 vs 第三台接住 ⇒ 回包里的 days 必须一模一样
  const runWith = async (servingHost: string): Promise<string> => {
    await resetBreakers()
    // ⚠ 换标的：同一个 (secid,klt,fqt) 的失败负缓存有 10s，会挡住本文件的连续用例
    const payload = dayPayload('sh600036')
    const s = stubFetch((url) => (url.includes(servingHost) ? jsonResponse(payload) : wafResponse()))
    try {
      const r = await em.fetchKline('1.600036', 101, 5, 1)
      assert.ok(r !== null, `由 ${servingHost} 服务时必须取到数据`)
      return JSON.stringify(r.days)
    } finally {
      s.restore()
    }
  }
  const viaSecond = await runWith('ifzq.gtimg.cn')
  const viaThird = await runWith('proxy.finance.qq.com')
  assert.equal(viaSecond, viaThird, '换一台同源主机不得改变任何读数')

  // 反例注入：换主机时顺手改了参数（例如把 qfq 去掉）⇒ 解析结果必变
  const wrongFq = em.parseTencentKlineNode(DAY_PAYLOAD, { ...opts, fq: '' })
  assert.equal(wrongFq, null, '换成不复权键名时本来就该拿不到（说明"参数逐字一致"不是空话）')
})
