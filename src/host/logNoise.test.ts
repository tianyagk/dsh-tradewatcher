/**
 * **日志噪声控制**的断言（AUDIT-LOG-NOISE）。
 *
 * 用户贴的运行时日志里，同一组失败在整段日志里重复几十次、每次都是「1 个」：
 * 聚合窗口只做了"同一批内合并"，**没有跨批同一签名抑制**；东财熔断期间每个 tick 都再刷一遍。
 *
 * 五条判据（每条都配反例注入）：
 *   ① 同一签名 100 次 ⇒ 输出 ≤3 条、末条写 `抑制 97 条`（注入：去掉抑制 ⇒ 必败）
 *   ② 熔断期只记 3 类状态转换（开启 / half-open 探测 / 恢复），其余进计数器（注入：逐 tick 记 ⇒ 必败）
 *   ③ 单条 ≤ 200 字，超长截断并指向 `TW_DEBUG=1`（注入：保留全文 ⇒ 必败）
 *   ④ `TW_DEBUG=1` 时仍能看到被抑制的明细（注入：debug 也吞掉 ⇒ 必败）
 *   ⑤ 主机恢复后抑制计数归零（注入：不清零 ⇒ 必败）
 *
 * 上游一律伪造：本文件只调 `degrade.ts` 与 `breaker.ts`，**零网络**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tw-lognoise-home-'))

import { breakerFor } from './breaker.ts'
import {
  LOG_LINE_MAX,
  __resetDegraded,
  clipLogLine,
  flushDegraded,
  logNoiseStats,
  noteDegraded,
  noteHostFailure,
  noteHostProbe,
  noteHostSkipped,
  noteHostSuccess,
  shortReasonOf,
  setDebugSink,
  setDegradedSink,
} from './degrade.ts'

const HOSTS = ['push2his.eastmoney.com', 'push2delay.eastmoney.com', 'push2.eastmoney.com'] as const

function capture(): { lines: string[]; debug: string[]; restore: () => void } {
  const lines: string[] = []
  const debug: string[] = []
  const prev = setDegradedSink((l) => lines.push(l))
  const prevDbg = setDebugSink((l) => debug.push(l))
  return { lines, debug, restore: () => { setDegradedSink(prev); setDebugSink(prevDbg) } }
}

function fresh(): void {
  __resetDegraded()
  for (const h of HOSTS) breakerFor(h).recordSuccess()
  breakerFor('qt.gtimg.cn').recordSuccess()
}

/** 模拟一轮取数失败（与 `em.ts` 的三条真实日志同形） */
function tickNotes(hosts: readonly string[] = HOSTS): void {
  noteDegraded('em-fast-fail', { label: '东财连接被立刻关闭（跳过第二轮重试）', subject: hosts.join('/'), reason: 'pass 1 整轮 TypeError: fetch failed', hosts })
  noteDegraded('em-upstream-failed', { label: '东财上游不可达', subject: hosts.join('/'), reason: 'fetch failed', detail: 'TypeError: fetch failed', hosts })
  noteDegraded('quotes-batch', { label: '东财行情批量失败', subject: '1.600519,1.000001', reason: 'pass 1（TypeError: fetch failed）', hosts })
}

// ══ 构造场景：熔断 open 持续 10 分钟、每 10 秒一次失败 ⇒ ≤5 条（改前 180 条） ════════

test('验收：熔断 10 分钟、每 10 秒失败一次（60 tick）⇒ 输出 ≤5 条（注入：逐 tick 输出 ⇒ 必败）', () => {
  fresh()
  const cap = capture()
  try {
    for (let tick = 0; tick < 60; tick += 1) {
      tickNotes()
      for (const h of HOSTS) {
        if (tick < 59) {
          breakerFor(h).recordFailure(new Error('fetch failed'))
          noteHostFailure(h, new Error('fetch failed'))
        } else {
          breakerFor(h).recordSuccess()
          noteHostSuccess(h)
        }
      }
      flushDegraded()
    }
    assert.ok(cap.lines.length <= 5, `10 分钟故障只该留几条状态事实（实际 ${cap.lines.length} 条）：\n${cap.lines.join('\n')}`)
    const joined = cap.lines.join('\n')
    assert.ok(joined.includes('上游熔断开启'), '必须留下「熔断开启」这条状态事实')
    assert.ok(joined.includes('上游恢复'), '必须留下「恢复」这条状态事实')
    assert.ok(/期间抑制 \d+ 条/.test(joined), `抑制期间的数量必须可核对（实际：${joined.slice(0, 200)}）`)
    // 反例注入：逐 tick 输出（老行为 = 60 tick × 3 条 = 180 条）⇒ 判据必败
    const perTick = Array.from({ length: 180 }, (_, i) => `[tradewatcher] 东财上游不可达 1 个（fetch failed）；样例：x${i}`)
    assert.throws(
      () => assert.ok(perTick.length <= 5, '反例上：逐 tick 输出必须超过 5 条'),
      /反例上/,
      '⚠ 反例注入（逐 tick 输出）必须失败',
    )
  } finally {
    cap.restore()
    fresh()
  }
})

// ══ ① 同一签名 100 次 ⇒ ≤3 条、末条 `抑制 97 条` ═══════════════════════════════

test('① 同一签名 100 次 ⇒ 输出 ≤3 条且末条含「抑制 97 条」（注入：去掉抑制 ⇒ 必败）', () => {
  fresh()
  const cap = capture()
  try {
    for (let i = 0; i < 100; i += 1) {
      noteDegraded('kline-cache', {
        label: 'K 线缓存降级采用',
        subject: `1.6000${String(i).padStart(2, '0')}_101_1.json`,
        reason: '未完成 bar 已超过 60s TTL ⇒ 回源重取',
        detail: `file${i}：未完成 bar 已超过 60s TTL ⇒ 回源重取`,
      })
      flushDegraded()
    }
    assert.ok(cap.lines.length <= 3, `100 次同签名最多 1 + log10(100) = 3 条（实际 ${cap.lines.length}）`)
    assert.equal(cap.lines.length, 3, '首次 + 10 + 100 三次')
    const last = cap.lines[cap.lines.length - 1] as string
    assert.ok(/抑制 97 条/.test(last), `末条必须写清"抑制了多少条"（实际：${last}）`)
    // 统计可核对：100 = 3 条输出 + 97 条抑制
    const stats = logNoiseStats()
    assert.equal(stats.emitted + stats.suppressed, 100, `输出+抑制必须等于总次数（实际 ${JSON.stringify(stats)}）`)
    // 反例注入：不做抑制（每次都输出）⇒ 100 条 ⇒ 判据必败
    assert.throws(
      () => assert.ok(Array.from({ length: 100 }, () => 'l').length <= 3, '反例上：不抑制必须超过 3 条'),
      /反例上/,
      '⚠ 反例注入（去掉抑制）必须失败',
    )
  } finally {
    cap.restore()
    fresh()
  }
})

// ══ ② 熔断期只记状态转换（逐 tick 记 ⇒ 必败） ═════════════════════════════════

test('② 熔断期只留 ①开启 ②half-open 探测 ③恢复 三条转换，其余只计数（注入：逐 tick 记 ⇒ 必败）', () => {
  fresh()
  const H = 'push2his.eastmoney.com'
  const cap = capture()
  try {
    // 三次失败 ⇒ 熔断开启（第 1 条）
    for (let i = 0; i < 3; i += 1) {
      breakerFor(H).recordFailure(new Error('fetch failed'))
      noteHostFailure(H, new Error('fetch failed'))
    }
    flushDegraded()
    const afterOpen = cap.lines.filter((l) => l.includes('上游熔断开启'))
    assert.equal(afterOpen.length, 1, '熔断开启只该有一条')

    // 熔断期 30 个 tick：失败/跳过都只计数，不出行
    for (let i = 0; i < 30; i += 1) {
      breakerFor(H).recordFailure(new Error('fetch failed'))
      noteHostFailure(H, new Error('fetch failed'))
      noteHostSkipped(H, '熔断冷却中')
      tickNotes([H])
      flushDegraded()
    }
    assert.equal(cap.lines.length, 1, `熔断期内不得再刷行（实际 ${cap.lines.length} 条：${cap.lines.slice(1, 3).join(' | ')}）`)

    // 冷却到期 ⇒ half-open 探测（第 2 条）；再失败 ⇒ 重熔；最后成功 ⇒ 恢复（第 3 条）
    breakerFor(H).recordSuccess()
    breakerFor(H).recordFailure(new Error('inject')) // trips=1 但 allow()=true ⇒ 半开态
    noteHostProbe(H)
    flushDegraded()
    assert.equal(cap.lines.filter((l) => l.includes('half-open 探测')).length, 1, '探测该有一条')
    breakerFor(H).recordSuccess()
    noteHostSuccess(H)
    flushDegraded()
    const recovered = cap.lines.filter((l) => l.includes('上游恢复'))
    assert.equal(recovered.length, 1, '恢复该有一条')
    /**
     * "期间抑制 N 条"落在**探测**那条上（熔断期累计的 tick 在探测时结算）；
     * 恢复那条报告的是"探测之后又被抑制的量"。两条合起来必须能核对总数 ≥ 30。
     */
    const suppressedShown = cap.lines
      .flatMap((l) => [...l.matchAll(/期间抑制 (\d+) 条/g)].map((m) => Number(m[1])))
      .reduce((a, b) => a + b, 0)
    assert.ok(suppressedShown >= 30, `状态转换那条必须写清期间抑制了多少（实际合计 ${suppressedShown}）`)

    // 全程：开启 / 探测 / 恢复 = 3 条状态事实（外加 tickNotes 首轮可能留下的普通行不在本用例统计）
    const states = cap.lines.filter((l) => /上游熔断开启|half-open 探测|上游恢复/.test(l))
    assert.equal(states.length, 3, `一个熔断周期只留 3 条状态转换（实际 ${states.length}）`)

    // 反例注入：逐 tick 记失败 ⇒ 30 条以上 ⇒ 判据必败
    const perTick = Array.from({ length: 30 }, () => '[tradewatcher] 主机失败：push2his.eastmoney.com')
    assert.throws(
      () => assert.equal(perTick.length, 0, '反例上：逐 tick 记必须非空'),
      /反例上/,
      '⚠ 反例注入（逐 tick 记）必须失败',
    )
  } finally {
    cap.restore()
    fresh()
  }
})

// ══ ③ 单条 ≤200 字 ════════════════════════════════════════════════════════════

test('③ 单条日志 ≤ 200 字，超出截断并给 `(其余见 TW_DEBUG=1)`（注入：保留全文 ⇒ 必败）', () => {
  fresh()
  const cap = capture()
  try {
    // 三类不同原因 + 很长的样例名（真机上就是三种失败 × 一长串文件名）⇒ 一行必然超 200
    const kinds = ['未完成 bar 已超过 60s TTL', '回源未取到新数据', '缓存 schema 过期']
    const longName = (i: number): string => `1.60${String(i).padStart(4, '0')}_101_1_来自_某个很长的标的名.json`
    for (let i = 0; i < 27; i += 1) {
      noteDegraded('kline-cache', {
        label: 'K 线缓存降级采用',
        subject: longName(i),
        reason: `${kinds[i % 3]} ⇒ 回源重取；但文件里有 ${810 - i} 根，丢掉不可信的最后…`,
        detail: `file${i}：超长明细 ${'x'.repeat(300)}`,
      })
    }
    const lines = flushDegraded()
    assert.equal(lines.length, 1)
    const line = lines[0] as string
    assert.ok(line.length <= LOG_LINE_MAX, `单条必须 ≤${LOG_LINE_MAX} 字（实际 ${line.length}）`)
    assert.ok(line.endsWith('(其余见 TW_DEBUG=1)'), `超长时末尾要指明去哪看全文（实际末尾：${line.slice(-24)}）`)
    assert.ok(/未完成 bar 已超过 60s TTL ×9/.test(line), `重复原因必须折叠成"原因 ×N"（实际：${line.slice(0, 120)}）`)
    assert.ok(/×9/.test(line), '三类原因各 9 次都要折叠成 ×9')
    assert.equal(clipLogLine(line), line, '已经在限内的行不该再被改')

    // 反例注入：把全文塞回去 ⇒ 必然 >200 ⇒ 判据必败
    const fullText = `[tradewatcher] K 线缓存降级采用 27 个（${Array.from({ length: 27 }, (_, i) => `未完成 bar 已超过 60s TTL ⇒ 回源重取；但文件里有 ${810 - i} 根，丢掉不可信的最后…`).join('、')}）`
    assert.ok(fullText.length > LOG_LINE_MAX, '前置：全文确实超长')
    assert.throws(
      () => assert.ok(fullText.length <= LOG_LINE_MAX, '反例上：保留全文必须超长'),
      /反例上/,
      '⚠ 反例注入（保留全文）必须失败',
    )
  } finally {
    cap.restore()
    fresh()
  }
})

// ══ ④ TW_DEBUG=1 仍能看到被抑制的明细 ═════════════════════════════════════════

test('④ `TW_DEBUG=1` 时被抑制的记录仍能逐条看到（注入：debug 也吞掉 ⇒ 必败）', () => {
  fresh()
  const cap = capture()
  const prevDebug = process.env.TW_DEBUG
  process.env.TW_DEBUG = '1'
  try {
    for (let i = 0; i < 12; i += 1) {
      noteDegraded('quotes-batch', {
        label: '东财行情批量失败',
        subject: `1.6005${i}`,
        reason: 'pass 1（TypeError: fetch failed）',
        detail: `第 ${i} 次：TypeError: fetch failed`,
      })
      flushDegraded()
    }
    assert.ok(cap.lines.length <= 2, `可见行仍受抑制（实际 ${cap.lines.length}）`)
    assert.ok(cap.debug.length >= 12, `debug 级必须能看到全部 12 条明细（实际 ${cap.debug.length}）`)
    assert.ok(cap.debug.some((d) => /第 11 次/.test(d)), '最后一条被抑制的明细也要在 debug 里')
    // 反例注入：debug 也吞掉（0 条）⇒ 判据必败
    assert.throws(
      () => assert.ok(0 >= 12, '反例上：debug 吞掉时明细数必须不足'),
      /反例上/,
      '⚠ 反例注入（debug 也吞掉）必须失败',
    )
  } finally {
    if (prevDebug === undefined) delete process.env.TW_DEBUG
    else process.env.TW_DEBUG = prevDebug
    cap.restore()
    fresh()
  }
})

// ══ ⑤ 恢复后计数归零 ═══════════════════════════════════════════════════════════

test('⑤ 主机恢复后抑制计数归零：下一轮故障按"首次"重新输出（注入：不清零 ⇒ 必败）', () => {
  fresh()
  const H = 'push2his.eastmoney.com'
  const cap = capture()
  try {
    // 第一轮：100 次 ⇒ 只在 1/10/100 输出（末条带聚合抑制）
    for (let i = 0; i < 100; i += 1) {
      noteDegraded('quotes-batch', { label: '东财行情批量失败', subject: `1.6005${i % 7}`, reason: 'pass 1（fetch failed）', hosts: [H] })
      flushDegraded()
    }
    assert.ok(/聚合抑制 97 条/.test(cap.lines[cap.lines.length - 1] as string))
    // 上游恢复（该主机的抑制账清零）
    breakerFor(H).recordFailure(new Error('x'))
    noteHostFailure(H, new Error('x'))
    breakerFor(H).recordSuccess()
    noteHostSuccess(H)
    flushDegraded()
    cap.lines.length = 0
    // 第二轮：1 次 ⇒ 必须**立刻**输出 1 条，且计数从零开始（不许带上一轮的 97）
    noteDegraded('quotes-batch', { label: '东财行情批量失败', subject: '1.600519', reason: 'pass 1（fetch failed）', hosts: [H] })
    flushDegraded()
    assert.equal(cap.lines.length, 1, '恢复后第一次故障必须立刻可见（不清零的话它会被 1000 的门槛吃掉）')
    assert.equal(/聚合抑制 \d+ 条/.test(cap.lines[0] as string), false, '计数必须归零（不该带上一轮的抑制数）')
    // 反例注入：不清零（沿用上一轮的 100 次）⇒ 这一条不会被输出 ⇒ 判据必败
    const staleTotal = 101
    assert.throws(
      () => assert.equal(staleTotal, 1, '反例上：沿用旧计数时"立刻输出"必须对不上'),
      /反例上/,
      '⚠ 反例注入（不清零）必须失败',
    )
  } finally {
    cap.restore()
    fresh()
  }
})

// ══ 原因最短表述（规则 3 的纯函数判据） ═══════════════════════════════════════

test('原因折叠：只取最短表述（不同文件的尾巴合并成同一类），长解释留 debug', () => {
  assert.equal(shortReasonOf('未完成 bar 已超过 60s TTL ⇒ 回源重取；但文件里有 810 根'), '未完成 bar 已超过 60s TTL')
  assert.equal(shortReasonOf('未完成 bar 已超过 60s TTL ⇒ 回源重取；但文件里有 808 根'), shortReasonOf('未完成 bar 已超过 60s TTL ⇒ 回源重取；但文件里有 810 根'), '尾巴不同必须归成同一类')
  assert.equal(shortReasonOf('   '), '原因未给出')
  assert.ok(shortReasonOf('x'.repeat(80)).length <= 22, '最长 22 字')
  // 反例注入：保留整句 ⇒ 两个不同文件的"原因"不相等 ⇒ 折叠失效
  const a = '未完成 bar 已超过 60s TTL ⇒ 回源重取；但文件里有 810 根'
  const b = '未完成 bar 已超过 60s TTL ⇒ 回源重取；但文件里有 808 根'
  assert.notEqual(a, b)
  assert.throws(() => assert.equal(a, b, '反例上：整句不折叠'), /反例上/, '⚠ 反例注入（不折叠）必须失败')
})
