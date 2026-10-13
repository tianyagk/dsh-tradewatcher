/**
 * 第三批（高与中级）的断言：H1 熔断收口 / H2 锁可重入判据 / H3 跳过流水不计当日盈亏 /
 * M5 采样器复用窗口 / M6 定稿不算 stale / M8 空日线不进正缓存。
 * 逐条对应 docs/REVIEW-2-CORRECTNESS.md 的 H1/H2/H3/M5/M6/M8；H4 在 `calendar.test.ts`。
 *
 * 口径：全部走**真实实现**（真 `fetchTencentMinutes` / 真 `withFileLock`+`updateJsonLocked` /
 * 真 `derivePosition` / 真 `loadQuoteRowsShared` / 真 `summarizeQuoteProvenance`），上游一律 stub 计数，
 * `DSH_HOME` 隔离在 `/tmp` 下。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LedgerEntry, PortItem, QuoteRow } from '../shared/model.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'fix3-redline-'))
if (!ROOT.startsWith('/tmp')) throw new Error(`拒绝运行：实验目录必须在 /tmp 下（收到 ${ROOT}）`)
const HOME = join(ROOT, 'home')
mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

/** 钉住"现在"：北京 2026-10-12（周一）15:20（收盘后，用于 M6 的定稿判定） */
const REAL_NOW = Date.now
const AT_CLOSE = Date.parse('2026-10-12T15:06:00+08:00')
const NOW_AFTER = Date.parse('2026-10-12T15:20:00+08:00')

function stubFetch(handler: (url: string) => Response | Promise<Response>): { count: (needle?: string) => number; restore: () => void } {
  const real = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = String(typeof input === 'string' ? input : (input as { url?: string })?.url ?? '')
    urls.push(url)
    return await handler(url)
  }) as typeof fetch
  return {
    count: (needle?: string) => (needle === undefined ? urls.length : urls.filter((u) => u.includes(needle)).length),
    restore: () => {
      globalThis.fetch = real
    },
  }
}

const okJson = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response

// ─────────────────────────────── H1 ───────────────────────────────

test('H1 熔断收口：腾讯/日历/新浪那些主机必须**记账**（失败进 breaker），冷却期零请求', async () => {
  const { breakerFor } = await import('./breaker.ts')
  const { fetchTencentMinutes, fetchTencentSuggest } = await import('./tencent.ts')
  const TEN = 'web.ifzq.gtimg.cn'
  breakerFor(TEN).recordSuccess() // 清到干净态
  const b = breakerFor(TEN)
  const failsBefore = b.state.fails

  // ① 一次失败必须进账（旧实现：裸 fetch ⇒ fails 恒 0，降级横幅看不见）
  const s1 = stubFetch(() => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom' }) as unknown as Response)
  try {
    await assert.rejects(async () => {
      await fetchTencentMinutes('1.600519')
    }, /HTTP 500|kline|上游/)
  } finally {
    s1.restore()
  }
  assert.ok(b.state.fails > failsBefore, `失败必须记账（fails ${failsBefore} → ${b.state.fails}）`)

  // ② 连续失败到熔断 ⇒ 冷却期内**零请求**（旧实现每次都真打上游）
  for (let i = 0; i < 3; i += 1) breakerFor(TEN).recordFailure(new Error('inject'))
  assert.equal(breakerFor(TEN).allow(), false, '三次失败后必须进入冷却')
  const s2 = stubFetch(() => okJson({ data: {} }))
  try {
    await assert.rejects(async () => {
      await fetchTencentMinutes('1.600519')
    }, /冷却|半开|未发出上游请求/)
    assert.equal(s2.count(), 0, `冷却期内必须零上游请求（实际 ${s2.count()} 条）`)
  } finally {
    s2.restore()
    breakerFor(TEN).recordSuccess()
  }

  // ③ 另一台主机（smartbox）同样必须记账
  const SB = 'smartbox.gtimg.cn'
  breakerFor(SB).recordSuccess()
  const fails2 = breakerFor(SB).state.fails
  const s3 = stubFetch(() => ({ ok: false, status: 503, json: async () => ({}), text: async () => 'x' }) as unknown as Response)
  try {
    await assert.rejects(async () => {
      await fetchTencentSuggest('茅台')
    })
  } finally {
    s3.restore()
  }
  assert.ok(breakerFor(SB).state.fails > fails2, 'smartbox 也必须记账')
  breakerFor(SB).recordSuccess()
})

test('H1 回归防线：`src/host` 里不得再出现"不过熔断器"的裸 fetch（白名单只有低层 helper）', () => {
  const HERE = dirname(fileURLToPath(import.meta.url))
  /** 允许清单：低层 helper 自身（**它的所有调用方**都已过熔断器，见源码注释） */
  const ALLOW: Array<{ file: string; line: number; why: string }> = [
    { file: 'em.ts', line: 88, why: '`fetchFromHost` 是低层单主机 helper：调用方只有 `fetchAny`（已 allow/probe/记账）与 `fetchHostThroughBreaker`（同一套）' },
  ]
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.child.ts')) {
        const rel = relative(HERE, p)
        readFileSync(p, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (!/await fetch\(|\breturn fetch\(/.test(line)) return
            if (ALLOW.some((a) => a.file === rel && a.line === i + 1)) return
            offenders.push(`${rel}:${i + 1} ${line.trim().slice(0, 100)}`)
          })
      }
    }
  }
  walk(HERE)
  assert.deepEqual(offenders, [], `这些站点绕过了熔断记账（H1）：\n${offenders.join('\n')}`)
  assert.ok(ALLOW.length <= 2, '白名单不得超过两条（否则容易变成"到处豁免"）')
})

// ─────────────────────────────── H2 ───────────────────────────────

test('H2 锁判据按 async 上下文：持锁期间发起的**兄弟**调用必须排队（n=2，不是 1）', async () => {
  const { withFileLock, updateJsonLocked } = await import('./lock.ts')
  const target = join(ROOT, 'h2-counter.json')
  // ⚠ 读与写之间**必须**拉开：否则两个写者会"碰巧"顺序完成（注入就不咬了）。
  // 这里的 40ms 模拟真实场景（读盘 → 计算/IO → 写回）。
  const bump = async (): Promise<void> => {
    await updateJsonLocked(
      target,
      async (disk) => {
        const n = Number((disk as { n?: number } | null)?.n ?? 0)
        // 读与写之间拉开 200ms：两个写者"都先读、后写"时，没有锁就必然丢一次
        await new Promise((r) => setTimeout(r, 200))
        return { n: n + 1 }
      },
      { note: 'h2' },
    )
  }
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  // A：先拿到锁、慢慢做；B：**在 A 持锁之后**从另一条 async 链发起（复核实测的 X6 形态）
  // A 立刻开始读盘（不先睡）；B 在 A 已经读到旧值之后才发起
  const a = withFileLock(target, async () => {
    await bump()
  })
  await sleep(25)
  const b = bump()
  await Promise.all([a, b])
  const n = Number((JSON.parse(readFileSync(target, 'utf8')) as { n?: number }).n ?? 0)
  assert.equal(n, 2, `两次 +1 必须都留下（旧判据把兄弟当嵌套 ⇒ n=1）；实际 ${n}`)
})

// ─────────────────────────────── H3 ───────────────────────────────

test('H3 被跳过的流水不得计入当日盈亏（空仓不能报 dayPnl=-50）', async () => {
  const { derivePosition } = await import('./portfolio.ts')
  const pos: PortItem = { id: 'p1', groupId: 'g1', secid: '1.600519', name: '贵州茅台', createdAt: 1 }
  const dayStart = Date.parse('2026-10-12T00:00:00+08:00')
  const today = Date.parse('2026-10-12T10:00:00+08:00')
  // 一笔**无持仓**的卖出（批量撤销删掉了覆盖它的买入 ⇒ replay 会跳过它）
  const entries: LedgerEntry[] = [{ id: 's1', ts: today, actor: 'web', verb: 'sell', posId: 'p1', qty: 100, price: 12 }]
  const quote: QuoteRow = {
    secid: '1.600519', code: '600519', name: '贵州茅台', price: 12.5, chg: 0.5, pct: 4.2, prev: 12,
    open: null, high: null, low: null, vol: null, amount: null, up: null, down: null, even: null, time: null, source: 'em', at: today,
  }
  const row = derivePosition(entries, pos, quote, dayStart)
  assert.equal(row.qty, 0, '前置：这笔卖出被跳过 ⇒ 持仓为 0')
  assert.equal(row.skippedLedger, 1, '前置：确实进了 skipped')
  assert.equal(row.dayPnl, 0, `被跳过的流水不得计入当日盈亏（旧实现 (12−12.5)×100 = −50；实际 ${String(row.dayPnl)}）`)
  // 对照：**能被应用**的当日买卖照常计入（不许把正常路径一并废掉）
  const live: LedgerEntry[] = [
    { id: 'b1', ts: today, actor: 'web', verb: 'buy', posId: 'p1', qty: 100, price: 12 },
    { id: 's2', ts: today + 3600_000, actor: 'web', verb: 'sell', posId: 'p1', qty: 100, price: 12.5 },
  ]
  const ok = derivePosition(live, pos, quote, dayStart)
  assert.equal(ok.skippedLedger, 0)
  assert.equal(ok.dayPnl, 50, '正常路径：买 12 → 卖 12.5 ⇒ 当日盈亏 +50（口径未变）')
})

// ─────────────────────────────── M5 ───────────────────────────────

test('M5 采样器复用窗口：槽在 20s 前取过 ⇒ 传 minReuseMs 后零请求（旧实现每次都刚好过期）', async () => {
  const em = await import('./em.ts')
  const SECID = '1.600519'
  const pin = (at: number): void => {
    Date.now = () => at
  }
  Date.now = REAL_NOW
  const t0 = Date.parse('2026-10-12T10:30:00+08:00')
  // 第一次：真取一次（把槽填上）
  pin(t0)
  const s1 = stubFetch(() => okJson({ data: { diff: [{ f12: '600519', f13: '1', f14: '贵州茅台', f2: '1278.25', f18: '1263' }] } }))
  try {
    await em.loadQuoteRowsShared([SECID], {})
    assert.ok(s1.count('/api/qt/ulist.np') > 0, '前置：第一次必须真打上游')
    // 13s 后：槽 TTL（12s）已过、但仍在采样窗口（22s）内
    pin(t0 + 13_000)
    const beforeSampler = s1.count()
    const rows = await em.loadQuoteRowsShared([SECID], { minReuseMs: 22_000 })
    assert.equal(
      s1.count(),
      beforeSampler,
      `采样间隔窗口内必须复用同一条槽（槽 TTL 只有 12s ⇒ 旧实现每拍都打上游；实际 ${s1.count() - beforeSampler} 条）`,
    )
    assert.equal(rows.get(SECID)?.price, 1278.25, '复用要给出真实的值（不是空 Map）')
    // 同一时刻、**默认口径**（不带 minReuseMs）⇒ 槽已过期 ⇒ 必须重新取数（证明默认路径没被放宽）
    const beforeDefault = s1.count()
    await em.loadQuoteRowsShared([SECID], {})
    assert.ok(s1.count() > beforeDefault, `默认口径仍按 12s TTL 过期重取（实测 ${s1.count() - beforeDefault} 条）`)
  } finally {
    s1.restore()
    Date.now = REAL_NOW
  }
})

// ─────────────────────────────── M6 ───────────────────────────────

test('M6 休市定稿不算 stale：15:06 取到的 A 股行在 15:20 仍应是"已收盘/定稿"而非"延迟"', async () => {
  const em = await import('./em.ts')
  const row: QuoteRow = {
    secid: '1.600519', code: '600519', name: '贵州茅台', price: 1278.25, chg: 15.25, pct: 1.21, prev: 1263,
    open: null, high: null, low: null, vol: null, amount: null, up: null, down: null, even: null, time: null,
    source: 'em', at: AT_CLOSE,
  }
  const p = em.summarizeQuoteProvenance({ '1.600519': row }, NOW_AFTER)
  assert.equal(p.stale, false, `收盘定稿的行不算 stale（旧实现 now−at > 90s ⇒ stale=true + 假限流告警）`)
  assert.equal(p.cached, true, '休市定稿 ⇒ 必须是 cached（界面显示"已收盘"）')
  // 对照：**盘中**同样"20 分钟没取到"必须仍是 stale（别把定稿的口子开在盘中）
  const duringSession = Date.parse('2026-10-12T10:30:00+08:00')
  const p2 = em.summarizeQuoteProvenance({ '1.600519': { ...row, at: duringSession - 20 * 60_000 } }, duringSession)
  assert.equal(p2.stale, true, '盘中 20 分钟没取到 ⇒ 必须算 stale')
})

// ─────────────────────────────── M8 ───────────────────────────────

test('M8 globalFlow：日线"成功但空"不得进 12 小时正缓存（第二次调用必须重新回源 + 理由如实）', async () => {
  const gf = await import('./globalFlow.ts')
  // 空包（200 + 空 day 数组）⇒ 必须当失败：**不进正缓存** ⇒ 第二次必须重新回源
  let dayLineCalls = 0
  const s = stubFetch((url) => {
    if (url.includes('fqkline') || url.includes('getDailyK')) {
      dayLineCalls += 1
      return okJson({ code: 0, data: { usSPY: { day: [] } } })
    }
    return okJson({ data: {} })
  })
  try {
    await gf.marketRaws()
    assert.ok(dayLineCalls > 0, `前置：本次确实请求过日线源（实际 ${dayLineCalls}）`)
    const afterFirst = dayLineCalls
    await gf.marketRaws()
    assert.ok(
      dayLineCalls > afterFirst,
      `"成功但空"的日线不得被 12 小时正缓存锁住（第二次必须重新回源；实际新增 ${dayLineCalls - afterFirst} 条）`,
    )
    // 空/过短必须在写入正缓存前就抛错（否则又会走"记成成功"的老路）
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'globalFlow.ts'), 'utf8')
    assert.match(src, /if \(series\.length < 2\) throw new Error/, '空/过短必须在写入正缓存前抛错（M8）')
  } finally {
    s.restore()
  }
})
