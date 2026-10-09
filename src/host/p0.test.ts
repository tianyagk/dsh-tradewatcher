/**
 * P0 批次（口径与状态外化）的宿主侧断言。
 *
 * 这组测试的价值在于**把"不说谎"变成可执行的约束**，而不是靠自觉：
 *   - 采样窗口：暂停时段必须给出原因与下次时刻（P0-4）；
 *   - 贡献度：因子贡献之和必须能复算出总分（P0-7）；
 *   - 出处契约：缺失必须区分"上游没有"与"这次失败"（P0-1）；
 *   - 未折算的跨市场持仓必须逐项列在 unpriced 里（P0-1）；
 *   - 备份校验：算不平的账必须被拒（P0-9）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LedgerEntry, PortGroup, PortItem, QuoteRow } from '../shared/model.ts'
import { inTradingWindow, factorContributions, samplingWindow, scoreRescue } from './rescue.ts'
import { assemblePortfolio } from './portfolio.ts'
import { quoteProvenance } from './em.ts'
import type { QuoteProvenance } from './em.ts'
import { BACKUP_SCHEMA_VERSION, filesChecksum, makeBundle, verifyBundle } from './backup.ts'

/** 北京时间 2026-09-28（周一） */
const BJ = (hhmm: string, day = '2026-09-28'): number => Date.parse(`${day}T${hhmm}:00+08:00`)

// ── P0-4 采样窗口 ─────────────────────────────────────────────────────────

test('P0-4 采样窗口：盘中是采样中，无下次时刻', () => {
  const w = samplingWindow(BJ('10:00'), { enabled: true, intervalSec: 30, samples: 42 })
  assert.equal(w.sampling, true)
  assert.equal(w.nextAt, null)
  assert.equal(w.nextLabel, null)
  assert.equal(w.intervalSec, 30)
  assert.equal(w.samples, 42)
})

test('P0-4 采样窗口：午休给出下一次时刻（同日 12:55）', () => {
  const w = samplingWindow(BJ('12:00'), { enabled: true, intervalSec: 30, samples: 10 })
  assert.equal(w.sampling, false)
  assert.equal(w.reason, 'noon-break')
  assert.equal(w.nextAt, BJ('12:55'))
  assert.equal(w.nextLabel, '09-28 12:55')
})

test('P0-4 采样窗口：收盘后下一次是次日 09:25（跨周末则推到周一）', () => {
  const afterClose = samplingWindow(BJ('15:30'), { enabled: true, intervalSec: 15, samples: 200 })
  assert.equal(afterClose.reason, 'closed')
  assert.equal(afterClose.nextLabel, '09-29 09:25')

  // 周五 15:30 → 下周一 09:25（周末整段跳过）
  const fri = samplingWindow(BJ('15:30', '2026-10-02'), { enabled: true, intervalSec: 15, samples: 200 })
  assert.equal(fri.nextLabel, '10-05 09:25', '周五收盘后应指向下周一')

  // 周六 → 周一
  const sat = samplingWindow(BJ('10:00', '2026-10-03'), { enabled: true, intervalSec: 15, samples: 0 })
  assert.equal(sat.reason, 'weekend')
  assert.equal(sat.nextLabel, '10-05 09:25')
})

test('P0-4 采样窗口：关闭监测时不承诺任何下次时刻', () => {
  const w = samplingWindow(BJ('10:00'), { enabled: false, intervalSec: 30, samples: 0 })
  assert.equal(w.sampling, false)
  assert.equal(w.reason, 'disabled')
  assert.equal(w.nextAt, null)
  assert.equal(w.nextLabel, null)
  // 关闭态与窗口态必须一致：关闭时不进入 inTradingWindow 分支
  assert.equal(inTradingWindow(BJ('10:00')), true)
})

test('P0-4 采样窗口：窗口边界与 inTradingWindow 同源（09:25/11:35/12:55/15:05）', () => {
  for (const [hhmm, expectSampling] of [
    ['09:24', false], ['09:25', true], ['11:35', true], ['11:36', false],
    ['12:54', false], ['12:55', true], ['15:05', true], ['15:06', false],
  ] as Array<[string, boolean]>) {
    const w = samplingWindow(BJ(hhmm), { enabled: true, intervalSec: 30, samples: 0 })
    assert.equal(w.sampling, expectSampling, `${hhmm} 采样状态`)
    assert.equal(w.sampling, inTradingWindow(BJ(hhmm)), `${hhmm} 必须与 inTradingWindow 同源`)
  }
})

// ── P0-7 因子贡献度 ───────────────────────────────────────────────────────

test('P0-7 贡献度：加权和乘时点系数 == 总分（任意快照可复算）', () => {
  const scored = scoreRescue({
    timeAdjMult: 1.8, coreSuperVsAvg: 0.6, peripheralSuperVsAvg: 0.4, pulseMult: 2.4,
    persistShare: 0.2, retraceRatio: 0.1, indexPct: -1.4,
    resonance: 3, coreResonance: 2, peripheralResonance: 1, resonanceLanes: ['沪深300ETF', '上证50ETF', '中证500ETF'],
    f2Anchors: [0.2, 0.5, 1], f2Source: 'empirical', flowAvailable: true,
    timeCoef: 1.1, isTail: true,
  })
  const contrib = factorContributions(scored.factors, scored.timeCoef)
  const sum = contrib.reduce((a, c) => a + c.contribution, 0)
  assert.ok(Math.abs(sum - scored.score) <= 0.5, `贡献度和 ${sum} 应等于总分 ${scored.score}（±0.5）`)
  assert.equal(contrib.length, scored.factors.length)
  // 每一条都得能对上：权 × 得分 × 系数
  for (const c of contrib) {
    assert.ok(Math.abs(c.contribution - c.weight * c.score * scored.timeCoef) < 1e-9, `${c.label} 贡献度可复算`)
  }
  // rawScore 是不含时点系数的原始分，两者关系必须是确定的
  assert.ok(Math.abs(scored.rawScore * scored.timeCoef - scored.score) <= 0.5)
})

// ── P0-1 行情出处契约 ─────────────────────────────────────────────────────

function provenanceOf(missing: string[], sources: Record<string, number>, rows: number, priced: number, staleCount = 0): QuoteProvenance {
  return {
    asOf: rows > 0 ? Date.now() : null,
    missing, stale: staleCount > 0, staleCount, priced, rows, sources,
    cached: false,
  }
}

test('P0-1 出处：缺备用源的标的判为 no-source，有备用源的判为 transient', () => {
  // 107.SPY 美股无腾讯/新浪映射（hasQuoteFallback=false）→ 重试无用
  // 1.600519 有腾讯兜底（true）→ 本次失败，稍后重试可能恢复
  const p = quoteProvenance(provenanceOf(['107.SPY', '1.600519'], { em: 1 }, 2, 1))
  const spy = p.missing.find((m) => m.what === '107.SPY')
  const kweichow = p.missing.find((m) => m.what === '1.600519')
  assert.equal(spy?.why, 'no-source')
  assert.equal(kweichow?.why, 'transient')
  assert.ok((spy?.note ?? '').includes('重试无用'))
  assert.equal(p.stale, false)
  assert.equal(p.source, 'em')
})

test('P1-7 出处：东财不可用时，"只有东财一条链路"的标的判 transient（等东财恢复），不是 no-source', () => {
  // 同一个标的（107.SPY：无腾讯/新浪映射），只看东财此刻可不可用：
  //   东财可达但它不给这个标的 → 结构性缺失（no-source，重试无用）
  //   东财不可用（熔断/整批失败）→ 等东财恢复就有（transient，稍后自动重试）
  const detail = provenanceOf(['107.SPY'], { em: 1 }, 1, 0)
  const up = quoteProvenance(detail, { emDown: false })
  assert.equal(up.missing[0].why, 'no-source')
  assert.ok(up.missing[0].note.includes('重试无用'))
  const down = quoteProvenance(detail, { emDown: true })
  assert.equal(down.missing[0].why, 'transient', '东财故障期不能判成"结构性缺失"')
  assert.ok(down.missing[0].note.includes('等东财恢复'), '原因里必须写清等待对象')
  assert.ok(!down.missing[0].note.includes('重试无用'), '不得再说"重试无用"（那是反向指引）')
})

test('P0-1 出处：多源混用标 mixed、无数据标 none、零行时 asOf 必须是 null', () => {
  const mixed = quoteProvenance(provenanceOf([], { em: 18, tencent: 4 }, 22, 22))
  assert.equal(mixed.source, 'mixed')
  assert.equal(mixed.sources?.tencent, 4)
  const empty = quoteProvenance(provenanceOf([], {}, 0, 0))
  assert.equal(empty.source, 'none')
  assert.equal(empty.asOf, null, '一行都没有时 asOf 不能是"刚刚"')
  // stale 与 cached 是两个字段，都要在
  assert.equal(typeof empty.stale, 'boolean')
  assert.equal(typeof empty.cached, 'boolean')
})

// ── P0-1 持仓：未折算/无价逐项列出 ─────────────────────────────────────────

function quote(secid: string, price: number, prev: number): QuoteRow {
  return {
    secid, code: secid, name: secid, price, chg: price - prev, pct: ((price - prev) / prev) * 100,
    prev, open: price, high: price, low: price, vol: 0, amount: 0, up: null, down: null, even: null, time: null, at: Date.now(), source: 'em',
  }
}

test('P0-1 持仓：港股按原币种计入 unpriced（不按 1:1 偷偷加进总额）', () => {
  const groups: PortGroup[] = [{ id: 'g1', name: '主仓', order: 1 }]
  const items: PortItem[] = [
    { id: 'p1', groupId: 'g1', secid: '1.600519', name: '贵州茅台', createdAt: 1 },
    { id: 'p2', groupId: 'g1', secid: '116.00700', name: '腾讯控股', createdAt: 2 },
    { id: 'p3', groupId: 'g1', secid: '107.SPY', name: '标普500ETF', createdAt: 3 },
  ]
  const entries: LedgerEntry[] = [
    { id: 'e1', ts: 1000, actor: 'web', verb: 'buy', posId: 'p1', groupId: 'g1', secid: '1.600519', name: '贵州茅台', qty: 100, price: 100 },
    { id: 'e2', ts: 2000, actor: 'web', verb: 'buy', posId: 'p2', groupId: 'g1', secid: '116.00700', name: '腾讯控股', qty: 200, price: 300 },
    { id: 'e3', ts: 3000, actor: 'web', verb: 'buy', posId: 'p3', groupId: 'g1', secid: '107.SPY', name: '标普500ETF', qty: 10, price: 400 },
  ]
  const { view } = assemblePortfolio(groups, items, entries, {
    '1.600519': quote('1.600519', 120, 110),
    '116.00700': quote('116.00700', 320, 310),
    // 107.SPY 故意不给价：既非人民币、又没有行情 —— 两条原因都要能区分
  })

  assert.equal(view.fxMode, 'none')
  const unpriced = view.unpriced ?? []
  const hk = unpriced.find((u) => u.secid === '116.00700')
  const us = unpriced.find((u) => u.secid === '107.SPY')
  assert.equal(hk?.why, 'no-fx', '港股市值未折算：口径问题，重试无用')
  assert.ok((hk?.note ?? '').includes('港股'))
  assert.equal(us?.why, 'no-quote', '无行情：上游问题，重试可能恢复')
  // 总额只含 A股那一只：100×120 = 12000
  assert.equal(view.grand.totalMv, 12000, '总额必须排除未折算的港股市值')
  assert.equal(view.unpricedMv, 200 * 320, '未折算市值单独报出，供界面标注"不含港股市值"')
})

// ── P0-9 备份校验 ─────────────────────────────────────────────────────────

function validFiles(): Parameters<typeof makeBundle>[0] {
  return {
    watch: { v: 1, groups: [{ id: 'wg1', name: '关注', order: 1 }], items: [{ id: 'wi1', groupId: 'wg1', secid: '1.600519', name: '贵州茅台', createdAt: 1 }] },
    positions: {
      v: 1,
      groups: [{ id: 'pg1', name: '主仓', order: 1 }],
      items: [{ id: 'pp1', groupId: 'pg1', secid: '1.600519', name: '贵州茅台', createdAt: 1 }],
    },
    ledger: {
      v: 1,
      entries: [
        { id: 'e1', ts: 1000, actor: 'web', verb: 'buy', posId: 'pp1', groupId: 'pg1', secid: '1.600519', name: '贵州茅台', qty: 100, price: 10 },
        { id: 'e2', ts: 2000, actor: 'web', verb: 'sell', posId: 'pp1', groupId: 'pg1', secid: '1.600519', name: '贵州茅台', qty: 40, price: 12 },
      ],
    },
    prefs: { theme: 'dark', refreshSec: 10 },
  }
}

test('P0-9 备份校验：正常文件通过，且摘要数字与内容一致', () => {
  const bundle = makeBundle(validFiles(), 'dsh-tradewatcher/test', 1_700_000_000_000)
  const check = verifyBundle(JSON.parse(JSON.stringify(bundle)))
  assert.equal(check.ok, true, check.errors.join('；'))
  assert.deepEqual(check.errors, [])
  assert.equal(check.summary.ledgerEntries, 2)
  assert.equal(check.summary.portItems, 1)
  assert.equal(check.summary.watchItems, 1)
  assert.equal(check.summary.checksumMatch, true)
  assert.equal(check.summary.schemaVersion, BACKUP_SCHEMA_VERSION)
  assert.equal(check.summary.ledgerFrom, 1000)
  assert.equal(check.summary.ledgerTo, 2000)
})

test('P0-9 备份校验：账本重放出现负持仓 → 拒绝（宁可不导入）', () => {
  const files = validFiles()
  files.ledger.entries = [
    { id: 'e1', ts: 1000, actor: 'web', verb: 'buy', posId: 'pp1', groupId: 'pg1', secid: '1.600519', name: '贵州茅台', qty: 10, price: 10 },
    // 卖 50 > 持有 10：这份账自相矛盾
    { id: 'e2', ts: 2000, actor: 'web', verb: 'sell', posId: 'pp1', groupId: 'pg1', secid: '1.600519', name: '贵州茅台', qty: 50, price: 12 },
  ]
  const check = verifyBundle(makeBundle(files, 'x'))
  assert.equal(check.ok, false)
  assert.ok(check.errors.some((e) => e.includes('负持仓')), check.errors.join('；'))
  assert.equal(check.files, null)
})

test('P0-9 备份校验：流水引用不存在的持仓 → 拒绝', () => {
  const files = validFiles()
  files.ledger.entries.push({ id: 'e3', ts: 3000, actor: 'web', verb: 'buy', posId: 'pp99', groupId: 'pg1', secid: '1.000001', name: '幽灵持仓', qty: 1, price: 1 })
  const check = verifyBundle(makeBundle(files, 'x'))
  assert.equal(check.ok, false)
  assert.ok(check.errors.some((e) => e.includes('不存在的持仓/分组 id')), check.errors.join('；'))
})

test('P0-9 备份校验：checksum 不匹配 / 缺失 → 拒绝（改动过或写了一半）', () => {
  const files = validFiles()
  const bundle = makeBundle(files, 'x')
  const tampered = { ...bundle, checksum: 'deadbeefdeadbeef' }
  const c1 = verifyBundle(tampered)
  assert.equal(c1.ok, false)
  assert.equal(c1.summary.checksumMatch, false)
  assert.ok(c1.errors.some((e) => e.includes('checksum 不匹配')))

  const noSum = { ...bundle } as Record<string, unknown>
  delete noSum.checksum
  const c2 = verifyBundle(noSum)
  assert.equal(c2.ok, false)
  assert.ok(c2.errors.some((e) => e.includes('缺少 checksum')))
})

test('P0-9 备份校验：内容被改过（checksum 未同步）也必须被拒', () => {
  const files = validFiles()
  const bundle = makeBundle(files, 'x')
  const edited = JSON.parse(JSON.stringify(bundle))
  edited.files.ledger.entries[0].qty = 999
  const check = verifyBundle(edited)
  assert.equal(check.ok, false)
  assert.equal(check.summary.checksumMatch, false)
  // 校验和只覆盖 files：app/exportedAt 变了不该影响指纹
  assert.equal(filesChecksum(files), bundle.checksum)
  assert.equal(makeBundle(files, '别的版本', 1).checksum, bundle.checksum)
})

test('P0-9 备份校验：schemaVersion 高于本版本 → 拒绝并说明原因', () => {
  const files = validFiles()
  const bundle = { ...makeBundle(files, 'x'), schemaVersion: BACKUP_SCHEMA_VERSION + 1 }
  const check = verifyBundle(bundle)
  assert.equal(check.ok, false)
  assert.ok(check.errors.some((e) => e.includes('高于本插件支持')))
})

test('P0-9 备份校验：非 JSON 对象 / 缺 files / 账本缺 entries 都要给出具体理由', () => {
  assert.equal(verifyBundle(null).ok, false)
  assert.match(verifyBundle('not a bundle').errors[0] ?? '', /JSON 对象/)
  assert.equal(verifyBundle({ schemaVersion: 1 }).ok, false)
  assert.match(verifyBundle({ schemaVersion: 1 }).errors[0] ?? '', /files/)
  const noEntries = verifyBundle({ schemaVersion: 1, files: { watch: { v: 1, groups: [], items: [] }, positions: { v: 1, groups: [], items: [] }, ledger: {} } })
  assert.equal(noEntries.ok, false)
  assert.ok(noEntries.errors.some((e) => e.includes('entries')))
})
