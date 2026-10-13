/**
 * 市场补充数据（AUDIT-IMPL52）：涨停/跌停家数、两融双源交叉、24h 品种、全天成交额预测、较昨日变动、
 * push2* 可用性日志。逐条对应 docs/AUDIT-IMPL52.md 的断言与注入。
 *
 * 上游一律 stub 计数（不打真实上游），`DSH_HOME` 隔离在 `/tmp` 下。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'src-extras-'))
if (!ROOT.startsWith('/tmp')) throw new Error(`拒绝运行：实验目录必须在 /tmp 下（收到 ${ROOT}）`)
mkdirSync(ROOT, { recursive: true })
process.env.DSH_HOME = ROOT

const okJson = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer }) as unknown as Response

function stub(handler: (url: string) => Response | Promise<Response>): { urls: string[]; restore: () => void } {
  const real = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = String(typeof input === 'string' ? input : (input as { url?: string })?.url ?? '')
    urls.push(url)
    return await handler(url)
  }) as typeof fetch
  return { urls, restore: () => { globalThis.fetch = real } }
}

test('① 涨停/跌停家数：来自 push2ex 池的 tc，缺失 ⇒ null + 原因（不得 0 顶替）', async () => {
  const m = await import('./marketExtras.ts')
  const s = stub((url) => url.includes('getTopicZTPool')
    ? okJson({ data: { tc: 67, qdate: 20261013, pool: [{ c: '000668', n: '荣丰控股', zdp: 10.005 }] } })
    : okJson({ data: { tc: 8, qdate: 20261013, pool: [{ c: '603230', n: '内蒙新华', zdp: -9.979 }] } }))
  try {
    const r = await m.limitCounts('20261013')
    assert.equal(r.up.count, 67)
    assert.equal(r.down.count, 8)
    assert.equal(r.up.sample[0]?.name, '荣丰控股')
    assert.equal(r.missing.length, 0)
    assert.equal(r.up.source, 'push2ex 涨停池')
    assert.match(r.caliber, /tc/, '口径必须写明来自池的 tc')
  } finally {
    s.restore()
  }
  // 上游失败 ⇒ count 为 null + transient 原因（**不是 0**）
  const s2 = stub(() => ({ ok: false, status: 503, json: async () => ({}), text: async () => 'x' }) as unknown as Response)
  try {
    const bad = await m.limitCounts('20261013')
    assert.equal(bad.up.count, null, '取不到就是 null（0 会被读成"没有涨停"）')
    assert.equal(bad.down.count, null)
    assert.ok(bad.missing.some((x) => x.why === 'transient' && x.what.includes('涨停')))
  } finally {
    s2.restore()
  }
})

test('② 两融双源：不一致时两个读数都返回 + mismatch=true（不得静默取一个）', async () => {
  const m = await import('./marketExtras.ts')
  const s = stub((url) => {
    if (url.includes('szse.cn')) return okJson([{ data: [{ jrrzye: '12,280.22', jrrzmr: '566.66', jrrjye: '106.81' }] }])
    // 东财：RZYE（元）⇒ 亿元；用 1.98065e12 元 = 19806.5 亿元（与深交所 12280.22 亿相差 >2% ⇒ 判不一致）
    return okJson({ result: { data: [{ DIM_DATE: '2026-10-12 00:00:00', RZYE: 1.98065e12, RZMRE: 1.2e11, RQYE: 1.0e10 }] } })
  })
  try {
    const r = await m.marginCross('2026-10-12')
    assert.equal(r.szse?.marginBalance, 12280.22, '深交所万位分隔的字符串必须能被解析')
    assert.equal(r.em?.marginBalance, 19806.5)
    assert.equal(r.mismatch, true, '相对差 38% ⇒ 必须判不一致')
    assert.match(r.note, /不一致/)
    assert.match(r.note, /深交所/)
    assert.match(r.note, /东财/)
    assert.notEqual(r.diffPct, null)
  } finally {
    s.restore()
  }
  // 一致时 mismatch=false，且 note 说明口径差异（深市 vs 沪深汇总）
  const s2 = stub((url) => url.includes('szse.cn')
    ? okJson([{ data: [{ jrrzye: '12280.22' }] }])
    : okJson({ result: { data: [{ DIM_DATE: '2026-10-12 00:00:00', RZYE: 1.23e12 }] } }))
  try {
    const r = await m.marginCross('2026-10-12')
    assert.equal(r.mismatch, false)
    assert.match(r.note, /口径/)
  } finally {
    s2.restore()
  }
})

test('② 两融两源都失败 ⇒ 两个都是 null + 原因（不得 0、不得编数）', async () => {
  const m = await import('./marketExtras.ts')
  const s = stub(() => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom' }) as unknown as Response)
  try {
    const r = await m.marginCross('2026-10-12')
    assert.equal(r.szse, null)
    assert.equal(r.em, null)
    assert.equal(r.diffPct, null)
    assert.ok(r.missing.some((x) => x.what === '两融余额'))
  } finally {
    s.restore()
  }
})

test('③/④ 24h 品种：美元指数与美债 10Y 双源交叉（数值一致 / 超差则双读数都留）', async () => {
  const m = await import('./marketExtras.ts')
  const s = stub((url) => {
    if (url.includes('sinajs.cn') && url.includes('DINIW')) return okJson({}) as unknown as Response
    if (url.includes('100.UDI')) return okJson({ data: { diff: [{ f2: 102.3, f3: -0.27, f124: 1791899972 }] } })
    if (url.includes('171.US10Y')) return okJson({ data: { diff: [{ f2: 5.2253, f3: -0.4, f124: 1791899972 }] } })
    return okJson({})
  })
  // 新浪走 GBK arrayBuffer：单独 stub 成"原始文本"形态
  s.restore()
  const real = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = String(typeof input === 'string' ? input : (input as { url?: string })?.url ?? '')
    urls.push(url)
    if (url.includes('DINIW')) {
      const text = 'var hq_str_DINIW="21:59:38,102.2991,102.2991,102.5844,4272,102.5704,102.5905,102.1633,102.2991,美元指数,2026-10-13";'
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(text).buffer } as unknown as Response
    }
    if (url.includes('globalbd_us10yt')) {
      const text = 'var hq_str_globalbd_us10yt="美国10年期国债,5.232,5.240,5.222,5.236,5.173,0,-0.3422,-0.0179,0,0,1791899931,2026-10-13,09:58:51,2036-08-15";'
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(text).buffer } as unknown as Response
    }
    if (url.includes('100.UDI')) return okJson({ data: { diff: [{ f2: 102.3, f3: -0.27, f124: 1791899972 }] } })
    // ⚠ 顺序要紧：K 线 URL 里也含 `171.US10Y`（secid=171.US10Y），必须先判 kline
    if (url.includes('kline')) return okJson({ data: { klines: ['2026-10-13,5.2253'] } })
    if (url.includes('171.US10Y')) return okJson({ data: { diff: [{ f2: 5.2253, f3: -0.4, f124: 1791899972 }] } })
    return okJson({})
  }) as typeof fetch
  try {
    const fx = await m.usdIndexCross()
    assert.equal(fx.sina?.value, 102.2991, '新浪 DINIW 下标 1 = 最新价')
    assert.equal(fx.em?.value, 102.3)
    assert.equal(fx.mismatch, false, '差 0.001 ⇒ 不算不一致')
    assert.match(m.H24_CALIBER, /不做 A 股休市冻结/, '口径常量必须写明不套休市冻结')
    const bond = await m.us10yCross()
    assert.equal(bond.em?.value, 5.2253)
    assert.equal(bond.sina?.value, 5.232)
    assert.equal(bond.mismatch, false)
    const hist = await m.us10yHistory(5)
    assert.equal(hist.points[0]?.day, '2026-10-13')
  } finally {
    globalThis.fetch = real
  }
})

test('⑤ 全天成交额预测：带标定来源/样本/区间；盘中给预测、**收盘后只给实际值**', async () => {
  const m = await import('./marketExtras.ts')
  const intraday = Date.parse('2026-10-13T10:00:00+08:00') // 盘中
  const r = await m.amountForecast(500_000_000_000, intraday)
  assert.equal(r.phase, 'intraday')
  assert.notEqual(r.forecast, null)
  assert.ok((r.forecast ?? 0) > 500_000_000_000, '10:00 只走了约 29.6% ⇒ 全天预测必须大于当前累计')
  assert.notEqual(r.band, null)
  assert.match(r.caliber.curve, /标定/, '必须标注标定来源')
  assert.equal(r.caliber.samples, 126, '样本天数必须来自标定的 progressDays（126 个交易日），不是"曲线长度/49"')
  assert.match(r.caliber.generatedAt, /^\d{4}-\d{2}-\d{2}/, '必须给标定生成日')
  assert.match(r.caliber.note, /早盘|误差/, '必须写明误差口径')
  // 收盘后：不给预测，回落实际值
  const closed = await m.amountForecast(1_675_917_804_027, Date.parse('2026-10-13T15:30:00+08:00'))
  assert.equal(closed.phase, 'closed')
  assert.equal(closed.forecast, null, '收盘后不得再给"预测"（会被当成第二份数据）')
  assert.equal(closed.actual, 1_675_917_804_027, '收盘后给实际值')
  // 盘前 / 非交易日：不给值 + 原因
  const pre = await m.amountForecast(0, Date.parse('2026-10-13T09:00:00+08:00'))
  assert.equal(pre.forecast, null)
  assert.ok(pre.missing.some((x) => x.what.includes('全天成交额预测')))
  const holiday = await m.amountForecast(1, Date.parse('2026-10-06T10:00:00+08:00'))
  assert.equal(holiday.phase, 'non-trading')
  assert.equal(holiday.forecast, null)
})

test('⑤ 成交额本身取不到 ⇒ 预测与占比都不给（不得 0 顶替）', async () => {
  const m = await import('./marketExtras.ts')
  const r = await m.amountForecast(null, Date.parse('2026-10-13T10:00:00+08:00'))
  assert.equal(r.current, null)
  assert.equal(r.forecast, null)
  assert.equal(r.progress, null)
  assert.ok(r.missing.some((x) => x.why === 'transient'))
})

test('⑥ 较昨日变动：缺昨日记录 ⇒ delta=null + 原因（不得 0）；落盘后能算出差值', async () => {
  const m = await import('./marketExtras.ts')
  const day = '2026-10-13'
  const before = await m.dayOverDay(day, { amount: 1_675_917_804_027, limitUp: 67, limitDown: 8 })
  assert.equal(before.amount.delta, null)
  assert.equal(before.limitCounts.delta, null)
  assert.ok(before.missing.some((x) => x.note.includes('上一交易日')))
  // 落盘昨日（模拟"连续两天运行"）后再算
  await m.persistExtrasDay('2026-10-12', { limitUp: 50, limitDown: 3, amount: 1_500_000_000_000, final: true })
  m.resetExtrasCache()
  const after = await m.dayOverDay(day, { amount: 1_675_917_804_027, limitUp: 67, limitDown: 8 })
  assert.equal(after.amount.prevDay, '2026-10-12')
  assert.equal(after.amount.delta, 175_917_804_027)
  assert.equal(after.limitCounts.prev, 53, '昨日的涨跌停家数 = 50 + 3')
  assert.equal(after.limitCounts.delta, 22, '今日 75 − 昨日 53 = 22')
  assert.ok(after.amount.deltaPct !== null && after.amount.deltaPct > 0)
})

test('⑦ push2* 可用性日志：记时间戳/成功失败/耗时（诊断用）', async () => {
  const m = await import('./marketExtras.ts')
  m.resetPush2Availability()
  m.notePush2('push2ex.eastmoney.com', true, 120)
  m.notePush2('push2ex.eastmoney.com', false, 300, 'HTTP 503')
  m.notePush2('push2delay.eastmoney.com', true, 80)
  const log = m.push2Availability()
  assert.equal(log.probes, 3)
  assert.equal(log.ok, 2)
  assert.equal(log.hosts['push2ex.eastmoney.com']?.ok, 1)
  assert.equal(log.hosts['push2ex.eastmoney.com']?.fail, 1)
  assert.equal(log.hosts['push2delay.eastmoney.com']?.avgMs, 80)
  assert.equal(log.recent.at(-1)?.host, 'push2delay.eastmoney.com')
  assert.ok(typeof log.recent[0]?.ts === 'number', '必须有时间戳')
})
