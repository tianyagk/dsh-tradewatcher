/**
 * 低层单主机取文本 helper（AUDIT-TESTS-1030 新建：该模块此前**零测试**）。
 *
 * 覆盖三件此前只能靠读代码相信的事：
 *   ① 熔断打开 ⇒ 抛 `BreakerOpenError`，消息固定 `breaker-open: <host>`，**并且一个请求都不发**；
 *   ② HTTP 非 2xx ⇒ 抛 `HTTP <status> from <host>`（不是被当成"熔断打开"）；
 *   ③ `charset: 'gbk'` 真的按 GBK 解（腾讯行情是 GBK；解错 ⇒ 中文全变 U+FFFD）。
 *
 * 全部用 `globalThis.fetch` 替身，**零真实网络**；每条都配反例注入。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BreakerOpenError, fetchTextHost } from './hostFetch.ts'
import { withHostBreaker } from './breakerFetch.ts'

type FetchArgs = { url: string; init?: RequestInit }

/** 装一个替身 fetch，返回计数器与还原函数 */
function stubFetch(handler: (args: FetchArgs) => Promise<unknown>): { calls: FetchArgs[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: FetchArgs[] = []
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return await handler({ url: String(url), init })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** 最小 Response 替身：只实现 hostFetch 与 withHostBreaker 真正读到的成员 */
const res = (status: number, body: string | Uint8Array): Response => {
  const ok = status >= 200 && status < 300
  return {
    ok,
    status,
    text: async () => (typeof body === 'string' ? body : new TextDecoder('utf-8').decode(body)),
    arrayBuffer: async () => {
      if (typeof body === 'string') return new TextEncoder().encode(body).buffer as ArrayBuffer
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
    },
  } as unknown as Response
}

/** 把某主机的熔断器打到打开（阈值 3 ⇒ 连续三次失败） */
async function tripBreaker(host: string): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await withHostBreaker(host, async () => {
      throw new Error('trip')
    }).catch(() => undefined)
  }
}

test('① 熔断打开 ⇒ 抛 BreakerOpenError（消息 breaker-open: host）且**不发请求**（发出去 ⇒ 败）', async () => {
  const host = 'audit-host-broken.test'
  await tripBreaker(host)
  const { calls, restore } = stubFetch(async () => res(200, 'should-not-be-called'))
  try {
    let caught: unknown = null
    try {
      await fetchTextHost(host, `https://${host}/x`)
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof BreakerOpenError, `必须是 BreakerOpenError（实得 ${String(caught)}）`)
    assert.equal((caught as BreakerOpenError).host, host)
    assert.equal((caught as Error).message, `breaker-open: ${host}`, '消息格式固定，调用方按它判"冷却中"')
    assert.equal((caught as Error).name, 'BreakerOpenError')
    assert.equal(calls.length, 0, '熔断打开时一个请求都不许发')
    // 反例注入：若把 UpstreamCoolingError 的映射去掉，错误会变成普通 Error（消息是"熔断冷却中…"）
    const wrongMessage = `${host} 熔断冷却中：本轮未发出上游请求（稍后自动重试）`
    assert.notEqual(wrongMessage, (caught as Error).message)
    assert.throws(() => assert.equal(wrongMessage, (caught as Error).message, '反例上：未映射冷却错误'), /反例上/, '⚠ 反例注入必须失败')
  } finally {
    restore()
  }
})

test('② HTTP 非 2xx ⇒ 抛 HTTP <status> from <host>（当成熔断打开/当成成功 ⇒ 败）', async () => {
  const host = 'audit-host-500.test'
  const { calls, restore } = stubFetch(async () => res(503, 'busy'))
  try {
    let caught: unknown = null
    try {
      await fetchTextHost(host, `https://${host}/x`)
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof Error)
    assert.equal((caught as Error).message, `HTTP 503 from ${host}`, '非 2xx 必须带状态码与主机')
    assert.equal(caught instanceof BreakerOpenError, false, '非 2xx 不是"熔断打开"（两者调用方处理不同）')
    assert.equal(calls.length, 1, '必须真的发过一次请求')
    // 反例注入：把状态码写死成 200 ⇒ 消息与真实状态不符
    assert.throws(() => assert.equal(`HTTP ${200} from ${host}`, (caught as Error).message, '反例上：状态码写死'), /反例上/, '⚠ 反例注入必须失败')
  } finally {
    restore()
  }
})

test('③ charset=gbk 真的按 GBK 解；缺省 utf-8（一律 utf-8 ⇒ 中文变 U+FFFD ⇒ 败）', async () => {
  const host = 'audit-host-gbk.test'
  // GBK 的「中」= D6 D0；按 UTF-8 解会得到替换字符
  const gbkBytes = new Uint8Array([0xd6, 0xd0])
  const { calls, restore } = stubFetch(async () => res(200, gbkBytes))
  try {
    const gbk = await fetchTextHost(host, `https://${host}/q`, { charset: 'gbk' })
    assert.equal(gbk, '中', 'charset=gbk 必须解出「中」')
    const utf8 = await fetchTextHost(host, `https://${host}/q`)
    assert.notEqual(utf8, '中', '缺省 utf-8 不得碰巧也解出「中」')
    assert.match(utf8, /\uFFFD/, '缺省 utf-8 解 GBK 字节必然出现替换字符（这正是必须显式传 gbk 的原因）')
    assert.equal(calls.length, 2)
    // 反例注入：两个分支都走 res.text()（= utf-8）⇒ gbk 分支会得到替换字符
    assert.throws(() => assert.equal(utf8, '中', '反例上：gbk 分支退化成 utf-8'), /反例上/, '⚠ 反例注入必须失败')
  } finally {
    restore()
  }
})

test('④ 请求头：ua 可覆盖、referer/origin/accept 只在给了才带（多带一个头 ⇒ 败）', async () => {
  const host = 'audit-host-headers.test'
  const { calls, restore } = stubFetch(async () => res(200, 'ok'))
  try {
    await fetchTextHost(host, `https://${host}/a`)
    const plain = (calls[0]!.init?.headers ?? {}) as Record<string, string>
    assert.equal(Object.keys(plain).length, 1, '只给默认 UA 时不得凭空多出头')
    assert.match(plain['user-agent'] ?? '', /Mozilla\/5\.0/, '必须有默认 UA')
    assert.equal(plain['referer'], undefined)

    await fetchTextHost(host, `https://${host}/b`, { referer: 'https://example.test/', origin: 'https://example.test', accept: 'application/json', ua: 'audit-ua' })
    const full = (calls[1]!.init?.headers ?? {}) as Record<string, string>
    assert.equal(full['user-agent'], 'audit-ua', '显式 ua 必须覆盖默认值')
    assert.equal(full['referer'], 'https://example.test/')
    assert.equal(full['origin'], 'https://example.test')
    assert.equal(full['accept'], 'application/json')
    // 反例注入：无条件塞 referer（空串也算有）⇒ 首条请求会多一个头
    assert.throws(() => assert.equal(Object.keys(plain).length, 2, '反例上：凭空多出头'), /反例上/, '⚠ 反例注入必须失败')
  } finally {
    restore()
  }
})
